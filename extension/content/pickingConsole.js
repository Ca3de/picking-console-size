// Picking Console Content Script
// Adds weight information to the batch grid
// Uses Picking Console JSON API + background script for Rodeo/FC Research data

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
  let batchDataFromAPI = [];

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

  // Initialize when DOM is ready
  function init() {
    if (isInitialized) {
      log('Already initialized, skipping');
      return;
    }

    log('Initializing...');

    // Set up global click handler (event delegation)
    setupClickHandler();

    // Create floating panel
    createFloatingPanel();

    // Observe for dynamic content changes
    observeContent();

    // Initial fetch from API
    setTimeout(fetchBatchesFromAPI, 1000);

    isInitialized = true;
    log('Initialization complete');
  }

  // Set up event delegation for fetch button clicks
  let clickHandlerAttached = false;
  function setupClickHandler() {
    if (clickHandlerAttached) return;
    clickHandlerAttached = true;

    log('Setting up global click handler...');

    document.addEventListener('click', (e) => {
      const btn = e.target.closest('.pcs-fetch-btn');
      if (btn) {
        e.preventDefault();
        e.stopPropagation();
        const batchId = btn.dataset.batchId;
        log(`Fetch button clicked for batch: ${batchId}`);
        fetchBatchWeight(batchId);
      }
    });

    log('Global click handler attached');
  }

  // Fetch batches from Picking Console API
  async function fetchBatchesFromAPI() {
    log('Fetching batches from API...');
    updateStatus('Fetching batches from API...');

    try {
      // Try different status endpoints
      const statuses = ['Ready', 'InProgress', 'All'];
      let allBatches = [];

      for (const status of statuses) {
        const url = `https://picking-console.na.picking.aft.a2z.com/api/fcs/${CONFIG.warehouseId}/batch-info/${status}`;
        log(`Fetching: ${url}`);

        try {
          const response = await fetch(url, {
            method: 'GET',
            credentials: 'include',
            headers: {
              'Accept': 'application/json'
            }
          });

          if (response.ok) {
            const data = await response.json();
            log(`API response for ${status}:`, data);

            if (data.pickBatchInformationList && Array.isArray(data.pickBatchInformationList)) {
              allBatches = allBatches.concat(data.pickBatchInformationList);
              log(`Found ${data.pickBatchInformationList.length} batches in ${status}`);
            }
          } else {
            log(`API request failed for ${status}: ${response.status}`);
          }
        } catch (err) {
          log(`API request error for ${status}:`, err.message);
        }
      }

      // Deduplicate by batchId
      const uniqueBatches = [];
      const seenIds = new Set();
      for (const batch of allBatches) {
        if (batch.batchId && !seenIds.has(batch.batchId)) {
          seenIds.add(batch.batchId);
          uniqueBatches.push(batch);
        }
      }

      batchDataFromAPI = uniqueBatches;
      log(`Total unique batches from API: ${batchDataFromAPI.length}`);

      // Update UI
      updateBatchList(batchDataFromAPI.map(b => b.batchId));
      document.getElementById('pcs-batches-count').textContent = batchDataFromAPI.length;
      updateStatus(`Found ${batchDataFromAPI.length} batches from API`);

      return batchDataFromAPI;
    } catch (error) {
      logError('API fetch error:', error);
      updateStatus(`API error: ${error.message}. Falling back to page scan.`);
      // Fallback to scanning the page
      return scanForBatches();
    }
  }

  // Create floating panel
  function createFloatingPanel() {
    log('Creating floating panel...');

    const panel = document.createElement('div');
    panel.id = 'pcs-panel';
    panel.innerHTML = `
      <div class="pcs-header">
        <span class="pcs-title">Size Calculator</span>
        <button class="pcs-minimize" title="Minimize">-</button>
      </div>
      <div class="pcs-content">
        <div class="pcs-status">Initializing...</div>
        <div class="pcs-stats">
          <div class="pcs-stat">
            <span class="pcs-stat-label">Warehouse:</span>
            <span class="pcs-stat-value">${CONFIG.warehouseId}</span>
          </div>
          <div class="pcs-stat">
            <span class="pcs-stat-label">Batches Found:</span>
            <span class="pcs-stat-value" id="pcs-batches-count">0</span>
          </div>
        </div>
        <div class="pcs-actions">
          <button id="pcs-refresh" class="pcs-btn pcs-btn-primary">Refresh Batches</button>
          <button id="pcs-fetch-all" class="pcs-btn">Fetch All Weights</button>
          <button id="pcs-clear-cache" class="pcs-btn">Clear Cache</button>
        </div>
        <div class="pcs-batch-list" id="pcs-batch-list">
          <div class="pcs-batch-list-header">Batches (click Fetch for weight):</div>
          <div class="pcs-batch-list-items" id="pcs-batch-items"></div>
        </div>
      </div>
    `;

    document.body.appendChild(panel);

    // Event listeners
    panel.querySelector('.pcs-minimize').addEventListener('click', () => {
      panel.classList.toggle('pcs-minimized');
    });

    panel.querySelector('#pcs-refresh').addEventListener('click', () => {
      log('Refresh button clicked');
      fetchBatchesFromAPI();
    });

    panel.querySelector('#pcs-fetch-all').addEventListener('click', () => {
      log('Fetch All button clicked');
      fetchAllBatchWeights();
    });

    panel.querySelector('#pcs-clear-cache').addEventListener('click', () => {
      log('Clear Cache button clicked');
      clearCache();
    });

    makeDraggable(panel);
    log('Panel created');
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

  // Observe for dynamic content changes
  function observeContent() {
    log('Setting up content observer...');

    const observer = new MutationObserver((mutations) => {
      // Debounce re-scanning
      clearTimeout(observeContent.timeout);
      observeContent.timeout = setTimeout(() => {
        // Only re-fetch if we don't have data yet
        if (batchDataFromAPI.length === 0) {
          log('Content changed, re-fetching...');
          fetchBatchesFromAPI();
        }
      }, 2000);
    });

    observer.observe(document.body, {
      childList: true,
      subtree: true
    });

    log('Content observer active');
  }

  // Fallback: Scan the page for batch IDs
  function scanForBatches() {
    log('Scanning page for batch IDs (fallback)...');

    const batchIds = new Set();

    // Method 1: Look for links containing batch IDs (8+ digit numbers)
    document.querySelectorAll('a').forEach(link => {
      const href = link.href || '';
      const text = link.textContent.trim();

      // Check if text is a batch ID (8+ digits)
      if (/^\d{8,}$/.test(text)) {
        batchIds.add(text);
      }

      // Check href for batch ID
      const hrefMatch = href.match(/[?&]?(?:batch|id)=?(\d{8,})/i);
      if (hrefMatch) {
        batchIds.add(hrefMatch[1]);
      }
    });

    // Method 2: Look for batch IDs in table cells or grid cells
    document.querySelectorAll('td, [role="cell"], [role="gridcell"], [class*="cell"]').forEach(cell => {
      const text = cell.textContent.trim();
      if (/^\d{8,}$/.test(text)) {
        batchIds.add(text);
      }
    });

    // Method 3: Look for batch IDs near "Batch" labels
    const pageText = document.body.innerText;
    const batchPattern = /\b(\d{8,})\b/g;
    let match;
    while ((match = batchPattern.exec(pageText)) !== null) {
      const num = match[1];
      if (num.length >= 8 && num.length <= 12) {
        batchIds.add(num);
      }
    }

    const batchArray = Array.from(batchIds);
    log(`Found ${batchArray.length} batch IDs via page scan:`, batchArray);

    // Update UI
    updateBatchList(batchArray);
    document.getElementById('pcs-batches-count').textContent = batchArray.length;

    return batchArray;
  }

  // Update the batch list in the panel
  function updateBatchList(batchIds) {
    const container = document.getElementById('pcs-batch-items');
    if (!container) return;

    container.innerHTML = '';

    batchIds.forEach(batchId => {
      const item = document.createElement('div');
      item.className = 'pcs-batch-item';
      item.dataset.batchId = batchId;

      // Find API data for this batch
      const apiData = batchDataFromAPI.find(b => b.batchId === batchId);
      const result = batchResults.get(batchId);

      if (result) {
        if (result.error) {
          item.innerHTML = `
            <span class="pcs-batch-id">${batchId}</span>
            <span class="pcs-batch-error" title="${result.error}">Error</span>
          `;
        } else {
          item.innerHTML = `
            <span class="pcs-batch-id">${batchId}</span>
            <span class="pcs-batch-weight">${result.averageWeight} lbs avg</span>
            <span class="pcs-batch-details">(${result.totalItems} items, ${result.totalWeight} lbs total)</span>
          `;
        }
      } else if (processingBatches.has(batchId)) {
        item.innerHTML = `
          <span class="pcs-batch-id">${batchId}</span>
          <span class="pcs-loading">Loading...</span>
        `;
      } else {
        const extraInfo = apiData ? `${apiData.totalUnits || '?'} units` : '';
        item.innerHTML = `
          <span class="pcs-batch-id">${batchId}</span>
          ${extraInfo ? `<span class="pcs-batch-details">${extraInfo}</span>` : ''}
          <button class="pcs-fetch-btn" data-batch-id="${batchId}">Fetch Weight</button>
        `;
      }

      container.appendChild(item);
    });
  }

  // Fetch weight for a single batch
  async function fetchBatchWeight(batchId) {
    log(`Fetching weight for batch: ${batchId}`);

    if (processingBatches.has(batchId)) {
      log(`Batch ${batchId} already processing`);
      return;
    }

    processingBatches.add(batchId);
    updateStatus(`Fetching batch ${batchId}...`);
    updateBatchList(batchDataFromAPI.length > 0 ? batchDataFromAPI.map(b => b.batchId) : scanForBatches());

    try {
      const result = await browser.runtime.sendMessage({
        type: 'fetchBatchData',
        batchId: batchId,
        warehouseId: CONFIG.warehouseId
      });

      log('Result:', JSON.stringify(result, null, 2));
      batchResults.set(batchId, result);

      if (result.error) {
        updateStatus(`Error: ${result.error}`);
      } else {
        updateStatus(`Batch ${batchId}: ${result.averageWeight} lbs avg (${result.totalItems} items)`);
      }
    } catch (error) {
      logError('Fetch error:', error);
      batchResults.set(batchId, { error: error.message });
      updateStatus(`Error: ${error.message}`);
    } finally {
      processingBatches.delete(batchId);
      updateBatchList(batchDataFromAPI.length > 0 ? batchDataFromAPI.map(b => b.batchId) : scanForBatches());
    }
  }

  // Fetch all batch weights
  async function fetchAllBatchWeights() {
    const batchIds = batchDataFromAPI.length > 0 ? batchDataFromAPI.map(b => b.batchId) : scanForBatches();
    const unfetched = batchIds.filter(id => !batchResults.has(id) && !processingBatches.has(id));

    if (unfetched.length === 0) {
      updateStatus('No new batches to fetch');
      return;
    }

    updateStatus(`Fetching ${unfetched.length} batches...`);

    for (let i = 0; i < unfetched.length; i++) {
      updateStatus(`Fetching ${i + 1}/${unfetched.length}: ${unfetched[i]}`);
      await fetchBatchWeight(unfetched[i]);
    }

    updateStatus('All batches fetched');
  }

  // Clear cache
  async function clearCache() {
    log('Clearing cache...');
    await browser.runtime.sendMessage({ type: 'clearCache' });
    batchResults.clear();
    updateBatchList(batchDataFromAPI.length > 0 ? batchDataFromAPI.map(b => b.batchId) : scanForBatches());
    updateStatus('Cache cleared');
  }

  // Update status display
  function updateStatus(message) {
    log('Status:', message);
    const statusEl = document.querySelector('.pcs-status');
    if (statusEl) {
      statusEl.textContent = message;
    }
  }

  // Initialize
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  log('Content script setup complete');

})();
