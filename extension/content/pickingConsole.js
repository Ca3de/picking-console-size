// Picking Console Content Script
// Adds weight information to the batch table

(function() {
  'use strict';

  console.log('[PickingConsole] Content script loaded');

  // Configuration
  const CONFIG = {
    warehouseId: extractWarehouseId(),
    pollInterval: 2000, // Check for table updates
    autoFetch: false // Set to true to auto-fetch on load
  };

  // State
  let isInitialized = false;
  let processingBatches = new Set();
  let batchResults = new Map();

  // Extract warehouse ID from URL (e.g., IND8 from /fc/IND8/)
  function extractWarehouseId() {
    const match = window.location.pathname.match(/\/fc\/([A-Z0-9]+)/);
    return match ? match[1] : 'IND8';
  }

  // Notify background script that we're ready
  browser.runtime.sendMessage({
    type: 'contentScriptReady',
    page: 'pickingConsole',
    warehouseId: CONFIG.warehouseId
  });

  // Initialize when DOM is ready
  function init() {
    if (isInitialized) return;

    console.log('[PickingConsole] Initializing...');

    // Create floating panel
    createFloatingPanel();

    // Observe table for changes
    observeTable();

    // Initial enhancement
    enhanceTable();

    isInitialized = true;
    console.log('[PickingConsole] Initialized for warehouse:', CONFIG.warehouseId);
  }

  // Create floating panel with controls
  function createFloatingPanel() {
    const panel = document.createElement('div');
    panel.id = 'pcs-panel';
    panel.innerHTML = `
      <div class="pcs-header">
        <span class="pcs-title">📦 Size Calculator</span>
        <button class="pcs-minimize" title="Minimize">−</button>
      </div>
      <div class="pcs-content">
        <div class="pcs-status">Ready</div>
        <div class="pcs-stats">
          <div class="pcs-stat">
            <span class="pcs-stat-label">Batches Loaded:</span>
            <span class="pcs-stat-value" id="pcs-batches-count">0</span>
          </div>
          <div class="pcs-stat">
            <span class="pcs-stat-label">Cache Size:</span>
            <span class="pcs-stat-value" id="pcs-cache-count">0</span>
          </div>
        </div>
        <div class="pcs-actions">
          <button id="pcs-fetch-all" class="pcs-btn pcs-btn-primary">Fetch All Weights</button>
          <button id="pcs-clear-cache" class="pcs-btn">Clear Cache</button>
        </div>
      </div>
    `;

    document.body.appendChild(panel);

    // Event listeners
    panel.querySelector('.pcs-minimize').addEventListener('click', () => {
      panel.classList.toggle('pcs-minimized');
    });

    panel.querySelector('#pcs-fetch-all').addEventListener('click', fetchAllBatchWeights);
    panel.querySelector('#pcs-clear-cache').addEventListener('click', clearCache);

    // Make draggable
    makeDraggable(panel);
  }

  // Make panel draggable
  function makeDraggable(element) {
    const header = element.querySelector('.pcs-header');
    let isDragging = false;
    let startX, startY, startLeft, startTop;

    header.addEventListener('mousedown', (e) => {
      if (e.target.tagName === 'BUTTON') return;
      isDragging = true;
      startX = e.clientX;
      startY = e.clientY;
      startLeft = element.offsetLeft;
      startTop = element.offsetTop;
      e.preventDefault();
    });

    document.addEventListener('mousemove', (e) => {
      if (!isDragging) return;
      element.style.left = (startLeft + e.clientX - startX) + 'px';
      element.style.top = (startTop + e.clientY - startY) + 'px';
      element.style.right = 'auto';
    });

    document.addEventListener('mouseup', () => {
      isDragging = false;
    });
  }

  // Observe table for dynamic updates
  function observeTable() {
    const observer = new MutationObserver((mutations) => {
      let shouldUpdate = false;
      for (const mutation of mutations) {
        if (mutation.addedNodes.length > 0 || mutation.type === 'childList') {
          shouldUpdate = true;
          break;
        }
      }
      if (shouldUpdate) {
        setTimeout(enhanceTable, 100);
      }
    });

    // Observe the main content area
    const targetNode = document.body;
    observer.observe(targetNode, {
      childList: true,
      subtree: true
    });
  }

  // Enhance the batch table with weight column
  function enhanceTable() {
    // Find the batch table - look for table with Batch ID column
    const tables = document.querySelectorAll('table');

    for (const table of tables) {
      const headerRow = table.querySelector('thead tr, tr:first-child');
      if (!headerRow) continue;

      const headers = headerRow.querySelectorAll('th, td');
      let batchIdIndex = -1;

      // Find Batch ID column
      headers.forEach((header, index) => {
        const text = header.textContent.toLowerCase();
        if (text.includes('batch') || text.includes('bat...')) {
          batchIdIndex = index;
        }
      });

      if (batchIdIndex === -1) continue;

      // Check if we already added our column
      if (headerRow.querySelector('.pcs-weight-header')) continue;

      // Add weight header
      const weightHeader = document.createElement('th');
      weightHeader.className = 'pcs-weight-header';
      weightHeader.innerHTML = '<span title="Average item weight in pounds">Avg Wt (lbs)</span>';
      headerRow.appendChild(weightHeader);

      // Add weight cells to each data row
      const rows = table.querySelectorAll('tbody tr, tr:not(:first-child)');
      let batchCount = 0;

      rows.forEach(row => {
        if (row.querySelector('.pcs-weight-cell')) return;

        const cells = row.querySelectorAll('td');
        if (cells.length <= batchIdIndex) return;

        const batchCell = cells[batchIdIndex];
        const batchId = extractBatchId(batchCell);

        if (!batchId) return;

        batchCount++;

        const weightCell = document.createElement('td');
        weightCell.className = 'pcs-weight-cell';
        weightCell.dataset.batchId = batchId;

        // Check if we have cached results
        if (batchResults.has(batchId)) {
          const result = batchResults.get(batchId);
          updateWeightCell(weightCell, result);
        } else {
          weightCell.innerHTML = `
            <button class="pcs-fetch-btn" data-batch-id="${batchId}" title="Fetch weight">
              ⚖️
            </button>
          `;
        }

        row.appendChild(weightCell);
      });

      // Update batch count
      document.getElementById('pcs-batches-count').textContent = batchCount;

      // Add click handlers for fetch buttons
      table.querySelectorAll('.pcs-fetch-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          fetchBatchWeight(btn.dataset.batchId);
        });
      });
    }
  }

  // Extract batch ID from cell
  function extractBatchId(cell) {
    // Try to find a link first
    const link = cell.querySelector('a');
    if (link) {
      const text = link.textContent.trim();
      const match = text.match(/(\d{8,})/);
      if (match) return match[1];
    }

    // Try plain text
    const text = cell.textContent.trim();
    const match = text.match(/(\d{8,})/);
    return match ? match[1] : null;
  }

  // Fetch weight for a single batch
  async function fetchBatchWeight(batchId) {
    if (processingBatches.has(batchId)) {
      console.log('[PickingConsole] Already processing batch:', batchId);
      return;
    }

    console.log('[PickingConsole] Fetching weight for batch:', batchId);
    processingBatches.add(batchId);

    // Update UI to show loading
    const cell = document.querySelector(`.pcs-weight-cell[data-batch-id="${batchId}"]`);
    if (cell) {
      cell.innerHTML = '<span class="pcs-loading">⏳</span>';
    }

    updateStatus(`Fetching batch ${batchId}...`);

    try {
      const result = await browser.runtime.sendMessage({
        type: 'fetchBatchData',
        batchId: batchId,
        warehouseId: CONFIG.warehouseId
      });

      console.log('[PickingConsole] Result for batch', batchId, ':', result);

      batchResults.set(batchId, result);

      if (cell) {
        updateWeightCell(cell, result);
      }

      updateStatus(result.error ? `Error: ${result.error}` : 'Ready');
    } catch (error) {
      console.error('[PickingConsole] Error fetching batch:', error);

      if (cell) {
        cell.innerHTML = '<span class="pcs-error" title="' + error.message + '">❌</span>';
      }

      updateStatus(`Error: ${error.message}`);
    } finally {
      processingBatches.delete(batchId);
    }
  }

  // Update weight cell with result
  function updateWeightCell(cell, result) {
    if (result.error) {
      cell.innerHTML = `<span class="pcs-error" title="${result.error}">❌</span>`;
      return;
    }

    const avgWeight = result.averageWeight;
    const totalWeight = result.totalWeight;
    const tooltip = `Total: ${totalWeight} lbs\nItems: ${result.totalItems}\nMin: ${result.minWeight} lbs\nMax: ${result.maxWeight} lbs\nUnique SKUs: ${result.uniqueSKUs}`;

    // Color code based on weight
    let colorClass = 'pcs-weight-normal';
    if (avgWeight < 0.5) {
      colorClass = 'pcs-weight-light';
    } else if (avgWeight > 2) {
      colorClass = 'pcs-weight-heavy';
    }

    cell.innerHTML = `
      <span class="pcs-weight-value ${colorClass}" title="${tooltip}">
        ${avgWeight.toFixed(2)}
      </span>
      <span class="pcs-weight-total">(${totalWeight.toFixed(1)})</span>
    `;
  }

  // Fetch weights for all visible batches
  async function fetchAllBatchWeights() {
    const cells = document.querySelectorAll('.pcs-weight-cell');
    const batchIds = [];

    cells.forEach(cell => {
      const batchId = cell.dataset.batchId;
      if (batchId && !batchResults.has(batchId) && !processingBatches.has(batchId)) {
        batchIds.push(batchId);
      }
    });

    if (batchIds.length === 0) {
      updateStatus('No new batches to fetch');
      return;
    }

    updateStatus(`Fetching ${batchIds.length} batches...`);

    // Fetch in parallel with some concurrency limit
    const concurrency = 3;
    for (let i = 0; i < batchIds.length; i += concurrency) {
      const batch = batchIds.slice(i, i + concurrency);
      await Promise.all(batch.map(id => fetchBatchWeight(id)));
      updateStatus(`Progress: ${Math.min(i + concurrency, batchIds.length)}/${batchIds.length}`);
    }

    updateStatus('All batches fetched');
  }

  // Clear the weight cache
  async function clearCache() {
    try {
      await browser.runtime.sendMessage({ type: 'clearCache' });
      batchResults.clear();

      // Reset all weight cells
      document.querySelectorAll('.pcs-weight-cell').forEach(cell => {
        const batchId = cell.dataset.batchId;
        if (batchId) {
          cell.innerHTML = `
            <button class="pcs-fetch-btn" data-batch-id="${batchId}" title="Fetch weight">
              ⚖️
            </button>
          `;
          cell.querySelector('.pcs-fetch-btn').addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            fetchBatchWeight(batchId);
          });
        }
      });

      updateStatus('Cache cleared');
      document.getElementById('pcs-cache-count').textContent = '0';
    } catch (error) {
      console.error('[PickingConsole] Error clearing cache:', error);
      updateStatus(`Error: ${error.message}`);
    }
  }

  // Update status display
  function updateStatus(message) {
    const statusEl = document.querySelector('.pcs-status');
    if (statusEl) {
      statusEl.textContent = message;
    }
  }

  // Initialize when ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  // Re-enhance on navigation (SPA support)
  let lastUrl = location.href;
  new MutationObserver(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      setTimeout(enhanceTable, 500);
    }
  }).observe(document, { subtree: true, childList: true });

})();
