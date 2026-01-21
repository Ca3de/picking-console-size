// Rodeo Content Script
// Extracts FN SKU data from Rodeo pages
// Works with background script to fetch data for picking console

(function() {
  'use strict';

  const DEBUG = true;

  function log(...args) {
    if (DEBUG) {
      const timestamp = new Date().toISOString().substr(11, 12);
      console.log(`[Rodeo ${timestamp}]`, ...args);
    }
  }

  function logError(...args) {
    const timestamp = new Date().toISOString().substr(11, 12);
    console.error(`[Rodeo ${timestamp}] ERROR:`, ...args);
  }

  log('='.repeat(50));
  log('Rodeo Content Script Starting');
  log('URL:', window.location.href);
  log('='.repeat(50));

  // Extract warehouse ID from URL
  function extractWarehouseId() {
    const match = window.location.pathname.match(/\/([A-Z0-9]+)\//);
    const warehouseId = match ? match[1] : 'IND8';
    log('Extracted warehouse ID:', warehouseId);
    return warehouseId;
  }

  const warehouseId = extractWarehouseId();

  // Notify background script that we're ready
  log('Sending contentScriptReady message to background...');
  browser.runtime.sendMessage({
    type: 'contentScriptReady',
    page: 'rodeo',
    warehouseId: warehouseId
  }).then(response => {
    log('contentScriptReady response:', response);
  }).catch(err => {
    logError('contentScriptReady failed:', err);
  });

  // Listen for requests from background script
  browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
    log('Received message:', message.type);
    log('Message content:', JSON.stringify(message, null, 2));

    switch (message.type) {
      case 'navigateAndExtract':
        log('='.repeat(40));
        log('NAVIGATE AND EXTRACT REQUEST');
        log('URL:', message.url);
        log('Batch ID:', message.batchId);
        log('='.repeat(40));

        handleNavigateAndExtract(message)
          .then(result => {
            log('Sending result back:', JSON.stringify(result, null, 2));
            sendResponse(result);
          })
          .catch(error => {
            logError('navigateAndExtract failed:', error);
            sendResponse({ error: error.message, fnskus: [] });
          });
        return true; // Keep channel open for async response

      case 'extractFNSKUs':
        log('Extract FN SKUs request (current page)');
        const fnskus = extractFNSKUsFromPage();
        log('Extracted FN SKUs:', fnskus);
        sendResponse({ fnskus });
        return false;

      case 'ping':
        log('Ping received, responding with pong');
        sendResponse({ pong: true, page: 'rodeo', warehouseId: warehouseId });
        return false;

      default:
        log('Unknown message type:', message.type);
        return false;
    }
  });

  // Handle navigate and extract request
  async function handleNavigateAndExtract(message) {
    const targetUrl = message.url;
    const currentUrl = window.location.href;

    log('Current URL:', currentUrl);
    log('Target URL:', targetUrl);

    // Check if we need to navigate
    if (currentUrl !== targetUrl) {
      log('Navigation required, loading new URL...');

      // Navigate to the target URL
      window.location.href = targetUrl;

      // Wait for page to load and extract
      return new Promise((resolve) => {
        // Set up a listener for when the page reloads
        // We'll store the pending request and handle it on next load
        sessionStorage.setItem('pcs_pending_extract', JSON.stringify({
          batchId: message.batchId,
          warehouseId: message.warehouseId,
          timestamp: Date.now()
        }));

        log('Stored pending extract request, page will reload...');

        // Since we're navigating, we need to wait
        // This promise will never resolve because page will reload
        // The next page load will handle extraction
        setTimeout(() => {
          resolve({ error: 'Navigation in progress, please retry', fnskus: [] });
        }, 100);
      });
    } else {
      log('Already on correct URL, extracting directly...');
      // Already on the correct page, extract immediately
      await waitForTableLoad();
      const fnskus = extractFNSKUsFromPage();
      return { fnskus, batchId: message.batchId };
    }
  }

  // Wait for the table to load
  async function waitForTableLoad(timeout = 5000) {
    log('Waiting for table to load...');
    const startTime = Date.now();

    return new Promise((resolve) => {
      const checkTable = () => {
        const table = document.querySelector('table');
        const rows = table ? table.querySelectorAll('tr') : [];

        if (rows.length > 1) {
          log(`Table loaded with ${rows.length} rows`);
          resolve(true);
          return;
        }

        if (Date.now() - startTime > timeout) {
          log('Table load timeout');
          resolve(false);
          return;
        }

        setTimeout(checkTable, 200);
      };

      checkTable();
    });
  }

  // Extract FN SKUs from the current page's table
  function extractFNSKUsFromPage() {
    log('Extracting FN SKUs from page...');
    const fnskus = [];

    // Find the results table
    const tables = document.querySelectorAll('table');
    log(`Found ${tables.length} tables`);

    for (const table of tables) {
      // Look for header row to find FN SKU column
      const headerRow = table.querySelector('tr');
      if (!headerRow) {
        log('Table has no header row, skipping');
        continue;
      }

      const headers = headerRow.querySelectorAll('th, td');
      let fnskuIndex = -1;

      log('Checking headers:');
      headers.forEach((header, index) => {
        const text = header.textContent.trim().toLowerCase();
        log(`  Header ${index}: "${text}"`);
        if (text.includes('fn sku') || text.includes('fnsku') || text === 'fn_sku' || text.includes('fn s')) {
          fnskuIndex = index;
          log(`  -> Found FN SKU column at index ${index}`);
        }
      });

      // If no explicit FN SKU column found, try column index 1 (second column)
      if (fnskuIndex === -1) {
        log('No explicit FN SKU header found, trying column 1');
        fnskuIndex = 1;
      }

      // Extract FN SKUs from data rows
      const rows = table.querySelectorAll('tr');
      log(`Processing ${rows.length} rows`);

      rows.forEach((row, rowIndex) => {
        if (rowIndex === 0) return; // Skip header

        const cells = row.querySelectorAll('td');
        if (cells.length > fnskuIndex) {
          const cell = cells[fnskuIndex];
          const link = cell.querySelector('a');
          const text = (link ? link.textContent : cell.textContent).trim();

          // FN SKU pattern validation - starts with X or B, alphanumeric, 10+ chars
          if (text && text.match(/^[XB][A-Z0-9]{9,}$/)) {
            log(`  Row ${rowIndex}: Found FN SKU: ${text}`);
            fnskus.push(text);
          } else if (text && text.match(/^[A-Z0-9]{10,}$/)) {
            // Broader pattern as backup
            log(`  Row ${rowIndex}: Found possible FN SKU: ${text}`);
            fnskus.push(text);
          } else {
            log(`  Row ${rowIndex}: Cell content "${text}" doesn't match FN SKU pattern`);
          }
        }
      });

      // If we found FN SKUs, stop checking other tables
      if (fnskus.length > 0) {
        break;
      }
    }

    // If still no FN SKUs found, try regex extraction on visible text
    if (fnskus.length === 0) {
      log('No FN SKUs found in tables, trying regex extraction...');
      const pageText = document.body.innerText;
      const matches = pageText.match(/\b[XB][A-Z0-9]{9,}\b/g);
      if (matches) {
        log(`Found ${matches.length} potential FN SKUs via regex:`, matches);
        fnskus.push(...matches);
      }
    }

    // Deduplicate
    const uniqueFnskus = [...new Set(fnskus)];
    log(`Final FN SKU list (${uniqueFnskus.length} unique):`, uniqueFnskus);

    return uniqueFnskus;
  }

  // Check for pending extract request on page load
  function checkPendingExtract() {
    const pendingData = sessionStorage.getItem('pcs_pending_extract');
    if (pendingData) {
      log('Found pending extract request:', pendingData);

      try {
        const pending = JSON.parse(pendingData);
        const age = Date.now() - pending.timestamp;

        if (age < 30000) { // Request is less than 30 seconds old
          log('Processing pending extract request...');
          sessionStorage.removeItem('pcs_pending_extract');

          // Wait for table and extract
          waitForTableLoad().then(() => {
            const fnskus = extractFNSKUsFromPage();
            log('Extracted FN SKUs for pending request:', fnskus);

            // Send result back to background
            browser.runtime.sendMessage({
              type: 'rodeoDataReady',
              data: {
                fnskus: fnskus,
                batchId: pending.batchId,
                warehouseId: pending.warehouseId
              }
            }).then(response => {
              log('Sent rodeoDataReady, response:', response);
            }).catch(err => {
              logError('Failed to send rodeoDataReady:', err);
            });
          });
        } else {
          log('Pending request too old, ignoring');
          sessionStorage.removeItem('pcs_pending_extract');
        }
      } catch (err) {
        logError('Error processing pending extract:', err);
        sessionStorage.removeItem('pcs_pending_extract');
      }
    }
  }

  // Auto-extract on page load for debugging
  function autoExtractOnLoad() {
    if (window.location.search.includes('searchKey=')) {
      log('Search page detected, auto-extracting...');
      waitForTableLoad().then(() => {
        const fnskus = extractFNSKUsFromPage();
        log('Auto-extracted FN SKUs:', fnskus);
      });
    }
  }

  // Initialize
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      log('DOM loaded');
      checkPendingExtract();
      autoExtractOnLoad();
    });
  } else {
    log('DOM already loaded');
    checkPendingExtract();
    autoExtractOnLoad();
  }

  log('Rodeo content script setup complete');

})();
