// FC Research Content Script
// Helps extract weight data from FC Research pages

(function() {
  'use strict';

  console.log('[FCResearch] Content script loaded');

  // Extract warehouse ID from URL
  function extractWarehouseId() {
    const match = window.location.pathname.match(/\/([A-Z0-9]+)\//);
    return match ? match[1] : 'IND8';
  }

  const warehouseId = extractWarehouseId();

  // Notify background script
  browser.runtime.sendMessage({
    type: 'contentScriptReady',
    page: 'fcresearch',
    warehouseId: warehouseId
  });

  // Listen for requests from background script
  browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
    console.log('[FCResearch] Received message:', message.type);

    switch (message.type) {
      case 'extractWeight':
        const weight = extractWeightFromPage();
        sendResponse({ weight });
        return false;

      case 'extractItemDetails':
        const details = extractItemDetails();
        sendResponse(details);
        return false;

      case 'ping':
        sendResponse({ pong: true, page: 'fcresearch' });
        return false;
    }
  });

  // Extract weight from the current page
  function extractWeightFromPage() {
    // Look for weight in the details table
    const rows = document.querySelectorAll('tr');

    for (const row of rows) {
      const cells = row.querySelectorAll('td, th');

      for (let i = 0; i < cells.length - 1; i++) {
        const cellText = cells[i].textContent.trim().toLowerCase();

        if (cellText === 'weight') {
          const valueCell = cells[i + 1];
          const weightText = valueCell.textContent.trim();

          // Parse weight - format is typically "0.79 pounds"
          const match = weightText.match(/([\d.]+)\s*(?:pounds?|lbs?)/i);
          if (match) {
            return parseFloat(match[1]);
          }

          // Try just parsing a number
          const numMatch = weightText.match(/([\d.]+)/);
          if (numMatch) {
            return parseFloat(numMatch[1]);
          }
        }
      }
    }

    return null;
  }

  // Extract all item details from the page
  function extractItemDetails() {
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

    return details;
  }

  // Auto-extract and log on page load (for debugging)
  if (window.location.search.includes('s=')) {
    setTimeout(() => {
      const weight = extractWeightFromPage();
      console.log('[FCResearch] Weight on page:', weight, 'lbs');
    }, 500);
  }

})();
