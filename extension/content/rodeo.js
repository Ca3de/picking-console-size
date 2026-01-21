// Rodeo Content Script
// Helps extract FN SKU data from Rodeo pages

(function() {
  'use strict';

  console.log('[Rodeo] Content script loaded');

  // Extract warehouse ID from URL
  function extractWarehouseId() {
    const match = window.location.pathname.match(/\/([A-Z0-9]+)\//);
    return match ? match[1] : 'IND8';
  }

  const warehouseId = extractWarehouseId();

  // Notify background script
  browser.runtime.sendMessage({
    type: 'contentScriptReady',
    page: 'rodeo',
    warehouseId: warehouseId
  });

  // Listen for requests from background script
  browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
    console.log('[Rodeo] Received message:', message.type);

    switch (message.type) {
      case 'extractFNSKUs':
        const fnskus = extractFNSKUsFromPage();
        sendResponse({ fnskus });
        return false;

      case 'ping':
        sendResponse({ pong: true, page: 'rodeo' });
        return false;
    }
  });

  // Extract FN SKUs from the current page's table
  function extractFNSKUsFromPage() {
    const fnskus = [];

    // Find the results table
    const tables = document.querySelectorAll('table');

    for (const table of tables) {
      // Look for header row to find FN SKU column
      const headerRow = table.querySelector('tr');
      if (!headerRow) continue;

      const headers = headerRow.querySelectorAll('th, td');
      let fnskuIndex = -1;

      headers.forEach((header, index) => {
        const text = header.textContent.toLowerCase().trim();
        if (text.includes('fn sku') || text.includes('fnsku') || text === 'fn_sku') {
          fnskuIndex = index;
        }
      });

      // If no explicit FN SKU column, it's typically the second column in Rodeo
      if (fnskuIndex === -1) {
        fnskuIndex = 1; // FN SKU is typically in column 2 (index 1)
      }

      // Extract FN SKUs from data rows
      const rows = table.querySelectorAll('tr');
      rows.forEach((row, rowIndex) => {
        if (rowIndex === 0) return; // Skip header

        const cells = row.querySelectorAll('td');
        if (cells.length > fnskuIndex) {
          const cell = cells[fnskuIndex];
          const link = cell.querySelector('a');
          const text = (link ? link.textContent : cell.textContent).trim();

          // FN SKU pattern validation
          if (text && text.match(/^[A-Z0-9]{10,}$/)) {
            fnskus.push(text);
          }
        }
      });
    }

    // Deduplicate
    return [...new Set(fnskus)];
  }

  // Auto-extract and log on page load (for debugging)
  if (window.location.search.includes('searchKey=')) {
    setTimeout(() => {
      const fnskus = extractFNSKUsFromPage();
      console.log('[Rodeo] Found FN SKUs on page:', fnskus);
    }, 1000);
  }

})();
