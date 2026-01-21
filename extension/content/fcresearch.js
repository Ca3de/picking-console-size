// FC Research Content Script
// Extracts weight data from FC Research pages
// Works with background script to fetch data for picking console

(function() {
  'use strict';

  const DEBUG = true;

  function log(...args) {
    if (DEBUG) {
      const timestamp = new Date().toISOString().substr(11, 12);
      console.log(`[FCResearch ${timestamp}]`, ...args);
    }
  }

  function logError(...args) {
    const timestamp = new Date().toISOString().substr(11, 12);
    console.error(`[FCResearch ${timestamp}] ERROR:`, ...args);
  }

  log('='.repeat(50));
  log('FC Research Content Script Starting');
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
    page: 'fcresearch',
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
        log('FN SKU:', message.fnsku);
        log('='.repeat(40));

        handleNavigateAndExtract(message)
          .then(result => {
            log('Sending result back:', JSON.stringify(result, null, 2));
            sendResponse(result);
          })
          .catch(error => {
            logError('navigateAndExtract failed:', error);
            sendResponse({ fnsku: message.fnsku, weight: null, error: error.message });
          });
        return true; // Keep channel open for async response

      case 'extractWeight':
        log('Extract weight request (current page)');
        const weight = extractWeightFromPage();
        log('Extracted weight:', weight);
        sendResponse({ weight });
        return false;

      case 'extractItemDetails':
        log('Extract item details request');
        const details = extractItemDetails();
        log('Extracted details:', details);
        sendResponse(details);
        return false;

      case 'ping':
        log('Ping received, responding with pong');
        sendResponse({ pong: true, page: 'fcresearch', warehouseId: warehouseId });
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

      // Store the pending request
      sessionStorage.setItem('pcs_pending_weight', JSON.stringify({
        fnsku: message.fnsku,
        warehouseId: message.warehouseId,
        timestamp: Date.now()
      }));

      // Navigate to the target URL
      window.location.href = targetUrl;

      log('Stored pending weight request, page will reload...');

      // Return error since we need to wait for reload
      return new Promise((resolve) => {
        setTimeout(() => {
          resolve({ fnsku: message.fnsku, weight: null, error: 'Navigation in progress, please retry' });
        }, 100);
      });
    } else {
      log('Already on correct URL, extracting directly...');
      // Already on the correct page, extract immediately
      await waitForContentLoad();
      const weight = extractWeightFromPage();
      return { fnsku: message.fnsku, weight };
    }
  }

  // Wait for content to load
  async function waitForContentLoad(timeout = 5000) {
    log('Waiting for content to load...');
    const startTime = Date.now();

    return new Promise((resolve) => {
      const checkContent = () => {
        // Look for any table with content
        const tables = document.querySelectorAll('table');
        let hasContent = false;

        for (const table of tables) {
          const rows = table.querySelectorAll('tr');
          if (rows.length > 0) {
            hasContent = true;
            break;
          }
        }

        // Also check for specific weight text
        const pageText = document.body.innerText;
        if (pageText.includes('Weight') || pageText.includes('pounds')) {
          hasContent = true;
        }

        if (hasContent) {
          log('Content loaded');
          resolve(true);
          return;
        }

        if (Date.now() - startTime > timeout) {
          log('Content load timeout');
          resolve(false);
          return;
        }

        setTimeout(checkContent, 200);
      };

      checkContent();
    });
  }

  // Extract weight from the current page
  function extractWeightFromPage() {
    log('Extracting weight from page...');

    // Look for weight in the details table
    const rows = document.querySelectorAll('tr');
    log(`Found ${rows.length} table rows`);

    for (const row of rows) {
      const cells = row.querySelectorAll('td, th');

      for (let i = 0; i < cells.length - 1; i++) {
        const cellText = cells[i].textContent.trim().toLowerCase();

        if (cellText === 'weight') {
          const valueCell = cells[i + 1];
          const weightText = valueCell.textContent.trim();
          log(`Found weight cell: "${weightText}"`);

          // Parse weight - format is typically "0.79 pounds"
          const match = weightText.match(/([\d.]+)\s*(?:pounds?|lbs?)/i);
          if (match) {
            const weight = parseFloat(match[1]);
            log(`Parsed weight: ${weight} lbs`);
            return weight;
          }

          // Try just parsing a number
          const numMatch = weightText.match(/([\d.]+)/);
          if (numMatch) {
            const weight = parseFloat(numMatch[1]);
            log(`Parsed weight (number only): ${weight}`);
            return weight;
          }

          log('Could not parse weight from text:', weightText);
        }
      }
    }

    // Fallback: try regex on full page text
    log('Trying fallback regex extraction...');
    const pageText = document.body.innerText;

    // Look for "Weight" followed by a number and "pounds"
    const weightMatch = pageText.match(/Weight[:\s]+([\d.]+)\s*(?:pounds?|lbs?)/i);
    if (weightMatch) {
      const weight = parseFloat(weightMatch[1]);
      log(`Fallback: Found weight ${weight} lbs`);
      return weight;
    }

    log('No weight found on page');
    return null;
  }

  // Extract all item details from the page
  function extractItemDetails() {
    log('Extracting all item details...');

    const details = {
      asin: null,
      fnsku: null,
      title: null,
      weight: null,
      dimensions: null,
      binding: null,
      listPrice: null
    };

    const rows = document.querySelectorAll('tr');

    for (const row of rows) {
      const cells = row.querySelectorAll('td, th');

      if (cells.length < 2) continue;

      const label = cells[0].textContent.trim().toLowerCase();
      const value = cells[1].textContent.trim();

      log(`  Row: "${label}" = "${value.substring(0, 50)}..."`);

      switch (label) {
        case 'asin':
          details.asin = value;
          break;
        case 'fnsku':
          details.fnsku = value;
          break;
        case 'title':
          details.title = value;
          break;
        case 'weight':
          const weightMatch = value.match(/([\d.]+)\s*(?:pounds?|lbs?)/i);
          details.weight = weightMatch ? parseFloat(weightMatch[1]) : null;
          break;
        case 'dimensions':
          details.dimensions = value;
          break;
        case 'binding':
          details.binding = value;
          break;
        case 'list price':
          const priceMatch = value.match(/[\d.]+/);
          details.listPrice = priceMatch ? parseFloat(priceMatch[0]) : null;
          break;
      }
    }

    log('Extracted details:', JSON.stringify(details, null, 2));
    return details;
  }

  // Check for pending weight request on page load
  function checkPendingWeight() {
    const pendingData = sessionStorage.getItem('pcs_pending_weight');
    if (pendingData) {
      log('Found pending weight request:', pendingData);

      try {
        const pending = JSON.parse(pendingData);
        const age = Date.now() - pending.timestamp;

        if (age < 30000) { // Request is less than 30 seconds old
          log('Processing pending weight request...');
          sessionStorage.removeItem('pcs_pending_weight');

          // Wait for content and extract
          waitForContentLoad().then(() => {
            const weight = extractWeightFromPage();
            log('Extracted weight for pending request:', weight);

            // Send result back to background
            browser.runtime.sendMessage({
              type: 'fcresearchDataReady',
              data: {
                fnsku: pending.fnsku,
                weight: weight,
                warehouseId: pending.warehouseId
              }
            }).then(response => {
              log('Sent fcresearchDataReady, response:', response);
            }).catch(err => {
              logError('Failed to send fcresearchDataReady:', err);
            });
          });
        } else {
          log('Pending request too old, ignoring');
          sessionStorage.removeItem('pcs_pending_weight');
        }
      } catch (err) {
        logError('Error processing pending weight:', err);
        sessionStorage.removeItem('pcs_pending_weight');
      }
    }
  }

  // Auto-extract on page load for debugging
  function autoExtractOnLoad() {
    if (window.location.search.includes('s=')) {
      log('Search page detected, auto-extracting...');
      waitForContentLoad().then(() => {
        const weight = extractWeightFromPage();
        log('Auto-extracted weight:', weight, 'lbs');

        const details = extractItemDetails();
        log('Auto-extracted details:', details);
      });
    }
  }

  // Initialize
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      log('DOM loaded');
      checkPendingWeight();
      autoExtractOnLoad();
    });
  } else {
    log('DOM already loaded');
    checkPendingWeight();
    autoExtractOnLoad();
  }

  log('FC Research content script setup complete');

})();
