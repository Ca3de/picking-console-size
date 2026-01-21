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
    pollInterval: 2000,
    autoFetchInterval: 15 * 60 * 1000 // 15 minutes in milliseconds
  };

  log('Configuration:', JSON.stringify(CONFIG, null, 2));

  // State
  let isInitialized = false;
  let processingBatches = new Set();
  let batchResults = new Map();
  let batchDataFromAPI = [];
  let autoFetchIntervalId = null;
  let countdownIntervalId = null;
  let nextAutoFetchTime = null;
  let currentFilters = {
    state: 'Ready',
    pickProcess: null
  };

  // Extract warehouse ID from URL (e.g., IND8 from /fc/IND8/)
  function extractWarehouseId() {
    const match = window.location.pathname.match(/\/fc\/([A-Z0-9]+)/);
    const warehouseId = match ? match[1] : 'IND8';
    log('Extracted warehouse ID:', warehouseId);
    return warehouseId;
  }

  // Detect current batch state from page (Ready, Active, etc.)
  function detectCurrentState() {
    // Method 1: Look for dropdown/select with state value
    const stateDropdown = document.querySelector('select, [role="listbox"], [class*="dropdown"]');
    if (stateDropdown) {
      const selectedOption = stateDropdown.querySelector('[aria-selected="true"], option:checked, [class*="selected"]');
      if (selectedOption) {
        const text = selectedOption.textContent.trim();
        if (['Ready', 'Active', 'InProgress', 'Completed', 'All'].some(s => text.includes(s))) {
          return text;
        }
      }
    }

    // Method 2: Look for state in the page heading or info text
    const pageText = document.body.innerText;
    const stateMatch = pageText.match(/Found \d+ batches in (\w+) state/i);
    if (stateMatch) {
      return stateMatch[1];
    }

    // Method 3: Check URL for state parameter
    const urlParams = new URLSearchParams(window.location.search);
    const stateFromUrl = urlParams.get('state') || urlParams.get('batchState');
    if (stateFromUrl) {
      return stateFromUrl;
    }

    // Default to Ready
    return 'Ready';
  }

  // Detect current Pick Process filter from filter chips
  function detectPickProcessFilter() {
    // Look for filter chips/tokens that indicate pick process
    const filterChips = document.querySelectorAll('[class*="token"], [class*="chip"], [class*="filter"], [class*="tag"]');

    for (const chip of filterChips) {
      const text = chip.textContent.trim();

      // Check for FracsLTLPicking or MultiSlamPicking
      if (text.includes('FracsLTLPicking') || text.includes('FLTL') || text.includes('LTL')) {
        return 'FracsLTLPicking';
      }
      if (text.includes('MultiSlamPicking') || text.includes('Multi') || text.includes('MSP')) {
        return 'MultiSlamPicking';
      }

      // Generic pick process detection
      if (text.includes('Pick Process:')) {
        const processMatch = text.match(/Pick Process:\s*(\w+)/);
        if (processMatch) {
          return processMatch[1];
        }
      }
    }

    // Check URL for tableFilters parameter
    const urlParams = new URLSearchParams(window.location.search);
    const tableFilters = urlParams.get('tableFilters');
    if (tableFilters) {
      try {
        const filters = JSON.parse(decodeURIComponent(tableFilters));
        if (filters.tokens) {
          for (const token of filters.tokens) {
            if (token.propertyKey === 'pickProcess' && token.value) {
              return token.value;
            }
          }
        }
      } catch (e) {
        log('Error parsing tableFilters:', e);
      }
    }

    return null; // No specific filter
  }

  // Get visible batch IDs from the table on screen
  function getVisibleBatchIds() {
    const batchIds = [];

    // Find all table rows with batch IDs
    const rows = document.querySelectorAll('tr, [role="row"]');
    for (const row of rows) {
      // Look for batch ID link in the row (8+ digit number)
      const links = row.querySelectorAll('a');
      for (const link of links) {
        const text = link.textContent.trim();
        if (/^\d{8,}$/.test(text)) {
          batchIds.push(text);
          break; // Only one batch ID per row
        }
      }
    }

    return batchIds;
  }

  // Inject weight display into table rows
  function injectWeightsIntoTable() {
    log('Injecting weights into table...');

    // First, find the Units column index from header (not "Total Units")
    let unitsColumnIndex = -1;
    const headerRow = document.querySelector('thead tr, [role="row"]:first-child');
    if (headerRow) {
      const headerCells = headerRow.querySelectorAll('th, td, [role="columnheader"], [role="cell"]');
      headerCells.forEach((cell, index) => {
        const text = cell.textContent.trim().toLowerCase();
        // Match "Units" but NOT "Total Units"
        if ((text === 'units' || text.includes('units')) && !text.includes('total')) {
          unitsColumnIndex = index;
          log(`Found Units column at index: ${unitsColumnIndex}`);
        }
      });
    }

    // Find all table rows
    const rows = document.querySelectorAll('tr, [role="row"]');

    for (const row of rows) {
      // Skip header row
      if (row.querySelector('th, [role="columnheader"]')) continue;

      // Find batch ID in this row
      let batchId = null;
      const links = row.querySelectorAll('a');
      for (const link of links) {
        const text = link.textContent.trim();
        if (/^\d{8,}$/.test(text)) {
          batchId = text;
          break;
        }
      }

      if (!batchId) continue;

      // Check if we already injected weight for this row
      if (row.querySelector('.pcs-inline-weight')) {
        // Update existing weight display
        const existingWeight = row.querySelector('.pcs-inline-weight');
        const result = batchResults.get(batchId);
        if (result && !result.error) {
          existingWeight.textContent = `${result.averageWeight} lbs`;
          existingWeight.title = `Total: ${result.totalWeight} lbs (${result.totalItems} items)`;
          existingWeight.classList.remove('pcs-loading');
        } else if (processingBatches.has(batchId)) {
          existingWeight.textContent = '...';
          existingWeight.classList.add('pcs-loading');
        }
        continue;
      }

      // Find the Units cell
      const cells = row.querySelectorAll('td, [role="cell"], [role="gridcell"]');
      let unitsCell = null;

      // Method 1: Use column index from header if found
      if (unitsColumnIndex >= 0 && cells.length > unitsColumnIndex) {
        unitsCell = cells[unitsColumnIndex];
      }

      // Method 2: Find cell with badge containing large number (Units > 20, Priority is usually 1-10)
      if (!unitsCell) {
        for (const cell of cells) {
          const badge = cell.querySelector('[class*="badge"], [class*="pill"]');
          if (badge) {
            const text = badge.textContent.trim();
            const num = parseInt(text, 10);
            // Units are typically > 20, Priority is typically 1-10
            if (!isNaN(num) && num > 20) {
              unitsCell = cell;
              break;
            }
          }
        }
      }

      // Method 3: Look for the last cell with a numeric badge (Units comes after Priority)
      if (!unitsCell) {
        let lastBadgeCell = null;
        for (const cell of cells) {
          const badge = cell.querySelector('[class*="badge"], [class*="pill"]');
          if (badge && /^\d+$/.test(badge.textContent.trim())) {
            lastBadgeCell = cell;
          }
        }
        unitsCell = lastBadgeCell;
      }

      if (unitsCell) {
        // Create weight badge
        const weightBadge = document.createElement('span');
        weightBadge.className = 'pcs-inline-weight';

        const result = batchResults.get(batchId);
        if (result && !result.error) {
          weightBadge.textContent = `${result.averageWeight} lbs`;
          weightBadge.title = `Total: ${result.totalWeight} lbs (${result.totalItems} items)`;
        } else if (processingBatches.has(batchId)) {
          weightBadge.textContent = '...';
          weightBadge.classList.add('pcs-loading');
        } else {
          weightBadge.textContent = '—';
          weightBadge.title = 'Weight not fetched yet';
        }

        // Inject after the units cell content
        unitsCell.appendChild(weightBadge);
      }
    }
  }

  // Update filters display in panel
  function updateFiltersDisplay() {
    currentFilters.state = detectCurrentState();
    currentFilters.pickProcess = detectPickProcessFilter();

    log('Current filters:', currentFilters);

    // Update panel display
    const stateEl = document.getElementById('pcs-current-state');
    const processEl = document.getElementById('pcs-current-process');

    if (stateEl) {
      stateEl.textContent = currentFilters.state || 'All';
    }
    if (processEl) {
      processEl.textContent = currentFilters.pickProcess || 'All';
    }
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

    // Initial fetch from API, auto-fetch all weights, and start timer
    setTimeout(async () => {
      updateStatus('Loading batches...');
      await fetchBatchesFromAPI();
      updateStatus('Auto-fetching all weights...');
      await fetchAllBatchWeights();
      startAutoFetchTimer();
      updateStatus(`Ready - ${batchDataFromAPI.length} batches loaded`);
    }, 1000);

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

    // First, detect current filters
    updateFiltersDisplay();

    try {
      // Only fetch the current state (not all states)
      const stateToFetch = currentFilters.state || 'Ready';
      const url = `https://picking-console.na.picking.aft.a2z.com/api/fcs/${CONFIG.warehouseId}/batch-info/${stateToFetch}`;
      log(`Fetching: ${url}`);

      let allBatches = [];

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
          log(`API response for ${stateToFetch}:`, data);

          if (data.pickBatchInformationList && Array.isArray(data.pickBatchInformationList)) {
            allBatches = data.pickBatchInformationList;
            log(`Found ${allBatches.length} batches in ${stateToFetch}`);
          }
        } else {
          log(`API request failed for ${stateToFetch}: ${response.status}`);
        }
      } catch (err) {
        log(`API request error for ${stateToFetch}:`, err.message);
      }

      // Filter by Pick Process if a filter is active
      if (currentFilters.pickProcess) {
        const filteredBatches = allBatches.filter(batch => {
          // Check if batch has pickProcess field matching the filter
          return batch.pickProcess === currentFilters.pickProcess ||
                 batch.pickProcessType === currentFilters.pickProcess;
        });
        log(`Filtered to ${filteredBatches.length} batches with pickProcess=${currentFilters.pickProcess}`);
        allBatches = filteredBatches;
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
      log(`Total unique batches: ${batchDataFromAPI.length}`);

      // Update UI
      const batchIds = batchDataFromAPI.map(b => b.batchId);
      updateBatchList(batchIds);
      document.getElementById('pcs-batches-count').textContent = batchDataFromAPI.length;
      updateStatus(`Found ${batchDataFromAPI.length} ${currentFilters.pickProcess || ''} batches in ${stateToFetch}`);

      // Also inject weights into table
      injectWeightsIntoTable();

      return batchDataFromAPI;
    } catch (error) {
      logError('API fetch error:', error);
      updateStatus(`API error: ${error.message}. Falling back to page scan.`);
      // Fallback to scanning visible batches on page
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
        <button class="pcs-minimize" title="Minimize">−</button>
      </div>
      <div class="pcs-content">
        <div class="pcs-status">Initializing...</div>
        <div class="pcs-stats">
          <div class="pcs-stat">
            <div class="pcs-stat-label">Warehouse</div>
            <div class="pcs-stat-value">${CONFIG.warehouseId}</div>
          </div>
          <div class="pcs-stat">
            <div class="pcs-stat-label">Batches</div>
            <div class="pcs-stat-value" id="pcs-batches-count">0</div>
          </div>
          <div class="pcs-stat">
            <div class="pcs-stat-label">State</div>
            <div class="pcs-stat-value" id="pcs-current-state">—</div>
          </div>
          <div class="pcs-stat">
            <div class="pcs-stat-label">Process</div>
            <div class="pcs-stat-value" id="pcs-current-process">—</div>
          </div>
        </div>
        <div class="pcs-auto-fetch">
          <div class="pcs-countdown">
            <span class="pcs-countdown-label">Next refresh:</span>
            <span class="pcs-countdown-value" id="pcs-countdown">--:--</span>
          </div>
        </div>
        <div class="pcs-actions">
          <button id="pcs-fetch-now" class="pcs-btn pcs-btn-primary" title="Fetch all weights now">Refresh</button>
          <button id="pcs-clear-cache" class="pcs-btn" title="Clear cached weights">Clear</button>
        </div>
      </div>
    `;

    document.body.appendChild(panel);

    // Event listeners
    panel.querySelector('.pcs-minimize').addEventListener('click', () => {
      panel.classList.toggle('pcs-minimized');
    });

    panel.querySelector('#pcs-fetch-now').addEventListener('click', () => {
      log('Refresh button clicked');
      fetchAllAndResetTimer();
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
      // Debounce actions
      clearTimeout(observeContent.timeout);
      observeContent.timeout = setTimeout(async () => {
        // Check if filters changed
        const newState = detectCurrentState();
        const newProcess = detectPickProcessFilter();

        if (newState !== currentFilters.state || newProcess !== currentFilters.pickProcess) {
          log(`Filters changed: ${currentFilters.state}/${currentFilters.pickProcess} -> ${newState}/${newProcess}`);
          currentFilters.state = newState;
          currentFilters.pickProcess = newProcess;

          // Clear all cached weights - they're for different batches now
          batchResults.clear();
          log('Cleared weight cache due to filter change');

          // Remove existing inline weight badges from table
          document.querySelectorAll('.pcs-inline-weight').forEach(el => el.remove());
          log('Removed inline weight badges');

          // Refresh batch list and auto-fetch weights
          await fetchBatchesFromAPI();
          await fetchAllBatchWeights();

          updateStatus(`Fetched weights for ${currentFilters.pickProcess || 'all'} batches in ${newState}`);
        } else {
          // Just re-inject weights into table (table may have re-rendered)
          injectWeightsIntoTable();
        }
      }, 500);
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
      // Update inline weights in table
      injectWeightsIntoTable();
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

  // Fetch all weights and reset the auto-fetch timer
  async function fetchAllAndResetTimer() {
    log('Fetching all weights and resetting timer...');

    // Clear existing results to fetch fresh data
    batchResults.clear();

    // Refresh batch list first
    await fetchBatchesFromAPI();

    // Fetch all weights
    await fetchAllBatchWeights();

    // Reset the auto-fetch timer
    startAutoFetchTimer();

    log('Fetch complete, timer reset');
  }

  // Start the auto-fetch timer
  function startAutoFetchTimer() {
    // Clear existing timers
    if (autoFetchIntervalId) {
      clearInterval(autoFetchIntervalId);
    }
    if (countdownIntervalId) {
      clearInterval(countdownIntervalId);
    }

    // Set next auto-fetch time
    nextAutoFetchTime = Date.now() + CONFIG.autoFetchInterval;
    log(`Auto-fetch scheduled for: ${new Date(nextAutoFetchTime).toLocaleTimeString()}`);

    // Start countdown update
    countdownIntervalId = setInterval(updateCountdown, 1000);
    updateCountdown(); // Update immediately

    // Set auto-fetch interval
    autoFetchIntervalId = setInterval(async () => {
      log('Auto-fetch triggered');
      updateStatus('Auto-fetching all batches...');

      // Clear old results and fetch fresh
      batchResults.clear();
      await fetchBatchesFromAPI();
      await fetchAllBatchWeights();

      // Reset timer for next cycle
      nextAutoFetchTime = Date.now() + CONFIG.autoFetchInterval;
      log(`Next auto-fetch at: ${new Date(nextAutoFetchTime).toLocaleTimeString()}`);
    }, CONFIG.autoFetchInterval);
  }

  // Update the countdown display
  function updateCountdown() {
    const countdownEl = document.getElementById('pcs-countdown');
    if (!countdownEl || !nextAutoFetchTime) return;

    const remaining = Math.max(0, nextAutoFetchTime - Date.now());
    const minutes = Math.floor(remaining / 60000);
    const seconds = Math.floor((remaining % 60000) / 1000);

    countdownEl.textContent = `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
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
