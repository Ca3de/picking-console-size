// Picking Console Content Script
// Adds weight information to the batch table
// REQUIRES all 3 tabs to be open: Picking Console, Rodeo, FC Research

(function() {
  'use strict';

  const DEBUG = true;

  function log(...args) {
    if (DEBUG) {
      const timestamp = new Date().toISOString().substr(11, 12);
      console.log(`[PickingConsole ${timestamp}]`, ...args);
    }
  }

  function logError(...args) {
    const timestamp = new Date().toISOString().substr(11, 12);
    console.error(`[PickingConsole ${timestamp}] ERROR:`, ...args);
  }

  log('='.repeat(50));
  log('Picking Console Size Calculator - Content Script Starting');
  log('URL:', window.location.href);
  log('='.repeat(50));

  // Configuration
  const CONFIG = {
    warehouseId: extractWarehouseId(),
    pollInterval: 2000
  };

  log('Configuration:', JSON.stringify(CONFIG, null, 2));

  // State
  let isInitialized = false;
  let processingBatches = new Set();
  let batchResults = new Map();
  let connectionStatus = {
    allConnected: false,
    missing: ['Rodeo', 'FC Research'],
    tabs: { pickingConsole: true, rodeo: false, fcresearch: false }
  };

  // Extract warehouse ID from URL (e.g., IND8 from /fc/IND8/)
  function extractWarehouseId() {
    const match = window.location.pathname.match(/\/fc\/([A-Z0-9]+)/);
    const warehouseId = match ? match[1] : 'IND8';
    log('Extracted warehouse ID:', warehouseId);
    return warehouseId;
  }

  // Notify background script that we're ready
  log('Sending contentScriptReady message to background...');
  browser.runtime.sendMessage({
    type: 'contentScriptReady',
    page: 'pickingConsole',
    warehouseId: CONFIG.warehouseId
  }).then(response => {
    log('contentScriptReady response:', response);
  }).catch(err => {
    logError('contentScriptReady failed:', err);
  });

  // Listen for connection status updates from background
  browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
    log('Received message from background:', message.type);
    log('Message content:', JSON.stringify(message, null, 2));

    if (message.type === 'connectionStatusUpdate') {
      connectionStatus = {
        allConnected: message.allConnected,
        missing: message.missing,
        tabs: message.tabs
      };
      log('Connection status updated:', JSON.stringify(connectionStatus, null, 2));
      updateConnectionDisplay();
      sendResponse({ received: true });
    }
    return false;
  });

  // Check connection status periodically
  async function checkConnectionStatus() {
    log('Checking connection status...');
    try {
      const status = await browser.runtime.sendMessage({ type: 'checkConnections' });
      log('Connection status response:', JSON.stringify(status, null, 2));
      connectionStatus = status;
      updateConnectionDisplay();
    } catch (err) {
      logError('Failed to check connections:', err);
    }
  }

  // Update the connection display in the panel
  function updateConnectionDisplay() {
    const statusEl = document.querySelector('.pcs-connection-status');
    if (!statusEl) return;

    log('Updating connection display. All connected:', connectionStatus.allConnected);

    if (connectionStatus.allConnected) {
      statusEl.innerHTML = `
        <span class="pcs-connected">✓ All tabs connected</span>
      `;
      statusEl.className = 'pcs-connection-status pcs-status-ok';

      // Enable fetch buttons
      document.querySelectorAll('.pcs-fetch-btn, #pcs-fetch-all').forEach(btn => {
        btn.disabled = false;
        btn.title = 'Fetch weight';
      });
    } else {
      statusEl.innerHTML = `
        <span class="pcs-disconnected">⚠ Missing: ${connectionStatus.missing.join(', ')}</span>
        <div class="pcs-tab-links">
          ${!connectionStatus.tabs.rodeo ? '<a href="https://rodeo-iad.amazon.com/' + CONFIG.warehouseId + '/" target="_blank">Open Rodeo</a>' : ''}
          ${!connectionStatus.tabs.fcresearch ? '<a href="https://fcresearch-na.aka.amazon.com/' + CONFIG.warehouseId + '/" target="_blank">Open FC Research</a>' : ''}
        </div>
      `;
      statusEl.className = 'pcs-connection-status pcs-status-warning';

      // Disable fetch buttons
      document.querySelectorAll('.pcs-fetch-btn, #pcs-fetch-all').forEach(btn => {
        btn.disabled = true;
        btn.title = 'Open all required tabs first';
      });
    }
  }

  // Initialize when DOM is ready
  function init() {
    if (isInitialized) {
      log('Already initialized, skipping');
      return;
    }

    log('Initializing...');

    // Create floating panel
    createFloatingPanel();

    // Observe table for changes
    observeTable();

    // Initial enhancement
    enhanceTable();

    // Check connection status
    checkConnectionStatus();

    // Periodically check connection status
    setInterval(checkConnectionStatus, 5000);

    isInitialized = true;
    log('✓ Initialization complete');
  }

  // Create floating panel with controls
  function createFloatingPanel() {
    log('Creating floating panel...');

    const panel = document.createElement('div');
    panel.id = 'pcs-panel';
    panel.innerHTML = `
      <div class="pcs-header">
        <span class="pcs-title">📦 Size Calculator</span>
        <button class="pcs-minimize" title="Minimize">−</button>
      </div>
      <div class="pcs-content">
        <div class="pcs-connection-status pcs-status-warning">
          <span class="pcs-disconnected">Checking connections...</span>
        </div>
        <div class="pcs-status">Ready</div>
        <div class="pcs-stats">
          <div class="pcs-stat">
            <span class="pcs-stat-label">Warehouse:</span>
            <span class="pcs-stat-value">${CONFIG.warehouseId}</span>
          </div>
          <div class="pcs-stat">
            <span class="pcs-stat-label">Batches Found:</span>
            <span class="pcs-stat-value" id="pcs-batches-count">0</span>
          </div>
          <div class="pcs-stat">
            <span class="pcs-stat-label">Cache Size:</span>
            <span class="pcs-stat-value" id="pcs-cache-count">0</span>
          </div>
        </div>
        <div class="pcs-actions">
          <button id="pcs-fetch-all" class="pcs-btn pcs-btn-primary" disabled>Fetch All Weights</button>
          <button id="pcs-clear-cache" class="pcs-btn">Clear Cache</button>
          <button id="pcs-check-conn" class="pcs-btn">Check Connections</button>
        </div>
        <div class="pcs-debug">
          <details>
            <summary>Debug Info</summary>
            <pre id="pcs-debug-log"></pre>
          </details>
        </div>
      </div>
    `;

    document.body.appendChild(panel);
    log('Panel added to DOM');

    // Event listeners
    panel.querySelector('.pcs-minimize').addEventListener('click', () => {
      panel.classList.toggle('pcs-minimized');
      log('Panel minimized:', panel.classList.contains('pcs-minimized'));
    });

    panel.querySelector('#pcs-fetch-all').addEventListener('click', () => {
      log('Fetch All button clicked');
      fetchAllBatchWeights();
    });

    panel.querySelector('#pcs-clear-cache').addEventListener('click', () => {
      log('Clear Cache button clicked');
      clearCache();
    });

    panel.querySelector('#pcs-check-conn').addEventListener('click', () => {
      log('Check Connections button clicked');
      checkConnectionStatus();
    });

    // Make draggable
    makeDraggable(panel);
    log('Panel setup complete');
  }

  // Add debug log to panel
  function addDebugLog(message) {
    const debugEl = document.getElementById('pcs-debug-log');
    if (debugEl) {
      const timestamp = new Date().toISOString().substr(11, 8);
      debugEl.textContent += `[${timestamp}] ${message}\n`;
      // Keep only last 50 lines
      const lines = debugEl.textContent.split('\n');
      if (lines.length > 50) {
        debugEl.textContent = lines.slice(-50).join('\n');
      }
    }
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
    log('Setting up table observer...');

    const observer = new MutationObserver((mutations) => {
      let shouldUpdate = false;
      for (const mutation of mutations) {
        if (mutation.addedNodes.length > 0 || mutation.type === 'childList') {
          shouldUpdate = true;
          break;
        }
      }
      if (shouldUpdate) {
        log('Table mutation detected, re-enhancing...');
        setTimeout(enhanceTable, 100);
      }
    });

    observer.observe(document.body, {
      childList: true,
      subtree: true
    });

    log('Table observer active');
  }

  // Enhance the batch table with weight column
  function enhanceTable() {
    log('Enhancing table...');

    // Find the batch table - look for table with Batch ID column
    const tables = document.querySelectorAll('table');
    log(`Found ${tables.length} tables on page`);

    let batchCount = 0;

    for (const table of tables) {
      const headerRow = table.querySelector('thead tr, tr:first-child');
      if (!headerRow) {
        log('Table has no header row, skipping');
        continue;
      }

      const headers = headerRow.querySelectorAll('th, td');
      let batchIdIndex = -1;

      // Find Batch ID column
      headers.forEach((header, index) => {
        const text = header.textContent.toLowerCase();
        if (text.includes('batch') || text.includes('bat...')) {
          batchIdIndex = index;
          log(`Found batch column at index ${index}: "${header.textContent}"`);
        }
      });

      if (batchIdIndex === -1) {
        log('No batch column found in table, skipping');
        continue;
      }

      // Check if we already added our column
      if (headerRow.querySelector('.pcs-weight-header')) {
        log('Weight column already exists');
        continue;
      }

      log('Adding weight column to table...');

      // Add weight header
      const weightHeader = document.createElement('th');
      weightHeader.className = 'pcs-weight-header';
      weightHeader.innerHTML = '<span title="Average item weight in pounds">Avg Wt (lbs)</span>';
      headerRow.appendChild(weightHeader);

      // Add weight cells to each data row
      const rows = table.querySelectorAll('tbody tr, tr:not(:first-child)');
      log(`Processing ${rows.length} data rows`);

      rows.forEach((row, rowIndex) => {
        if (row.querySelector('.pcs-weight-cell')) return;

        const cells = row.querySelectorAll('td');
        if (cells.length <= batchIdIndex) return;

        const batchCell = cells[batchIdIndex];
        const batchId = extractBatchId(batchCell);

        if (!batchId) {
          log(`Row ${rowIndex}: No batch ID found`);
          return;
        }

        batchCount++;
        log(`Row ${rowIndex}: Batch ID = ${batchId}`);

        const weightCell = document.createElement('td');
        weightCell.className = 'pcs-weight-cell';
        weightCell.dataset.batchId = batchId;

        // Check if we have cached results
        if (batchResults.has(batchId)) {
          const result = batchResults.get(batchId);
          updateWeightCell(weightCell, result);
        } else {
          weightCell.innerHTML = `
            <button class="pcs-fetch-btn" data-batch-id="${batchId}" title="Fetch weight" ${!connectionStatus.allConnected ? 'disabled' : ''}>
              ⚖️
            </button>
          `;
        }

        row.appendChild(weightCell);
      });

      // Update batch count
      document.getElementById('pcs-batches-count').textContent = batchCount;
      log(`Total batches found: ${batchCount}`);

      // Add click handlers for fetch buttons
      table.querySelectorAll('.pcs-fetch-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          const batchId = btn.dataset.batchId;
          log(`Fetch button clicked for batch: ${batchId}`);
          fetchBatchWeight(batchId);
        });
      });
    }

    log('Table enhancement complete');
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
    log('='.repeat(40));
    log(`FETCH BATCH WEIGHT: ${batchId}`);
    log('='.repeat(40));

    if (!connectionStatus.allConnected) {
      const errorMsg = `Cannot fetch: Missing tabs - ${connectionStatus.missing.join(', ')}`;
      logError(errorMsg);
      addDebugLog(errorMsg);
      updateStatus(errorMsg);
      return;
    }

    if (processingBatches.has(batchId)) {
      log(`Batch ${batchId} is already being processed`);
      return;
    }

    processingBatches.add(batchId);
    log(`Added ${batchId} to processing set. Current: ${[...processingBatches].join(', ')}`);

    // Update UI to show loading
    const cell = document.querySelector(`.pcs-weight-cell[data-batch-id="${batchId}"]`);
    if (cell) {
      cell.innerHTML = '<span class="pcs-loading">⏳</span>';
    }

    updateStatus(`Fetching batch ${batchId}...`);
    addDebugLog(`Fetching batch ${batchId}`);

    try {
      log('Sending fetchBatchData message to background...');
      const result = await browser.runtime.sendMessage({
        type: 'fetchBatchData',
        batchId: batchId,
        warehouseId: CONFIG.warehouseId
      });

      log('Received result from background:', JSON.stringify(result, null, 2));
      addDebugLog(`Result: ${result.error || `${result.averageWeight} lbs avg`}`);

      batchResults.set(batchId, result);

      if (cell) {
        updateWeightCell(cell, result);
      }

      if (result.error) {
        updateStatus(`Error: ${result.error}`);
        logError('Fetch failed:', result.error);
      } else {
        updateStatus(`Batch ${batchId}: ${result.averageWeight} lbs avg`);
        log(`✓ Batch ${batchId} complete: ${result.averageWeight} lbs avg`);
      }
    } catch (error) {
      logError('Exception during fetch:', error);
      addDebugLog(`Error: ${error.message}`);

      if (cell) {
        cell.innerHTML = `<span class="pcs-error" title="${error.message}">❌</span>`;
      }

      updateStatus(`Error: ${error.message}`);
    } finally {
      processingBatches.delete(batchId);
      log(`Removed ${batchId} from processing set`);
    }
  }

  // Update weight cell with result
  function updateWeightCell(cell, result) {
    log('Updating weight cell with result:', JSON.stringify(result, null, 2));

    if (result.error) {
      cell.innerHTML = `<span class="pcs-error" title="${result.error}">❌</span>`;
      return;
    }

    const avgWeight = result.averageWeight;
    const totalWeight = result.totalWeight;
    const tooltip = `Total: ${totalWeight} lbs
Items: ${result.totalItems}
With Weight: ${result.itemsWithWeight}
Min: ${result.minWeight} lbs
Max: ${result.maxWeight} lbs
Unique SKUs: ${result.uniqueSKUs}`;

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
      <span class="pcs-weight-total">(${totalWeight.toFixed(1)} total)</span>
    `;
  }

  // Fetch weights for all visible batches
  async function fetchAllBatchWeights() {
    log('='.repeat(40));
    log('FETCH ALL BATCH WEIGHTS');
    log('='.repeat(40));

    if (!connectionStatus.allConnected) {
      const errorMsg = `Cannot fetch: Missing tabs - ${connectionStatus.missing.join(', ')}`;
      logError(errorMsg);
      updateStatus(errorMsg);
      return;
    }

    const cells = document.querySelectorAll('.pcs-weight-cell');
    const batchIds = [];

    cells.forEach(cell => {
      const batchId = cell.dataset.batchId;
      if (batchId && !batchResults.has(batchId) && !processingBatches.has(batchId)) {
        batchIds.push(batchId);
      }
    });

    log(`Found ${batchIds.length} batches to fetch:`, batchIds);

    if (batchIds.length === 0) {
      updateStatus('No new batches to fetch');
      return;
    }

    updateStatus(`Fetching ${batchIds.length} batches...`);
    addDebugLog(`Starting fetch of ${batchIds.length} batches`);

    // Fetch sequentially to avoid overwhelming the tabs
    for (let i = 0; i < batchIds.length; i++) {
      const batchId = batchIds[i];
      log(`Fetching batch ${i + 1}/${batchIds.length}: ${batchId}`);
      updateStatus(`Fetching ${i + 1}/${batchIds.length}: ${batchId}`);
      await fetchBatchWeight(batchId);

      // Small delay between batches
      if (i < batchIds.length - 1) {
        await new Promise(resolve => setTimeout(resolve, 500));
      }
    }

    updateStatus('All batches fetched');
    addDebugLog('All batches fetched');
    log('✓ All batches fetched');
  }

  // Clear the weight cache
  async function clearCache() {
    log('Clearing cache...');

    try {
      await browser.runtime.sendMessage({ type: 'clearCache' });
      batchResults.clear();
      log('Cache cleared');

      // Reset all weight cells
      document.querySelectorAll('.pcs-weight-cell').forEach(cell => {
        const batchId = cell.dataset.batchId;
        if (batchId) {
          cell.innerHTML = `
            <button class="pcs-fetch-btn" data-batch-id="${batchId}" title="Fetch weight" ${!connectionStatus.allConnected ? 'disabled' : ''}>
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
      addDebugLog('Cache cleared');
    } catch (error) {
      logError('Error clearing cache:', error);
      updateStatus(`Error: ${error.message}`);
    }
  }

  // Update status display
  function updateStatus(message) {
    log('Status:', message);
    const statusEl = document.querySelector('.pcs-status');
    if (statusEl) {
      statusEl.textContent = message;
    }
  }

  // Initialize when ready
  if (document.readyState === 'loading') {
    log('Document still loading, waiting for DOMContentLoaded...');
    document.addEventListener('DOMContentLoaded', init);
  } else {
    log('Document ready, initializing immediately');
    init();
  }

  // Re-enhance on navigation (SPA support)
  let lastUrl = location.href;
  new MutationObserver(() => {
    if (location.href !== lastUrl) {
      log(`URL changed: ${lastUrl} -> ${location.href}`);
      lastUrl = location.href;
      setTimeout(enhanceTable, 500);
    }
  }).observe(document, { subtree: true, childList: true });

  log('Content script setup complete');

})();
