// Background script for Picking Console Size Calculator
// Coordinates fetching data from Rodeo and FC Research

// Cache for FN SKU weights to avoid redundant requests
const weightCache = new Map();
const CACHE_DURATION = 30 * 60 * 1000; // 30 minutes

// Track connected tabs
const connectedTabs = {
  pickingConsole: null,
  rodeo: null,
  fcresearch: null
};

// Listen for messages from content scripts
browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
  console.log('[Background] Received message:', message.type);

  switch (message.type) {
    case 'contentScriptReady':
      handleContentScriptReady(message, sender);
      return false;

    case 'fetchBatchData':
      // Main workflow: get weights for a batch
      handleFetchBatchData(message.batchId, message.warehouseId)
        .then(result => sendResponse(result))
        .catch(error => sendResponse({ error: error.message }));
      return true; // Keep channel open for async response

    case 'fetchFNSKUsFromRodeo':
      fetchFNSKUsFromRodeo(message.batchId, message.warehouseId)
        .then(result => sendResponse(result))
        .catch(error => sendResponse({ error: error.message }));
      return true;

    case 'fetchWeightFromFCResearch':
      fetchWeightFromFCResearch(message.fnsku, message.warehouseId)
        .then(result => sendResponse(result))
        .catch(error => sendResponse({ error: error.message }));
      return true;

    case 'clearCache':
      weightCache.clear();
      sendResponse({ success: true });
      return false;

    case 'getStatus':
      sendResponse({
        cacheSize: weightCache.size,
        connectedTabs: {
          pickingConsole: connectedTabs.pickingConsole !== null,
          rodeo: connectedTabs.rodeo !== null,
          fcresearch: connectedTabs.fcresearch !== null
        }
      });
      return false;
  }
});

// Handle content script registration
function handleContentScriptReady(message, sender) {
  const tabId = sender.tab.id;
  const url = sender.tab.url;

  if (url.includes('picking-console')) {
    connectedTabs.pickingConsole = tabId;
    console.log('[Background] Picking Console connected:', tabId);
  } else if (url.includes('rodeo')) {
    connectedTabs.rodeo = tabId;
    console.log('[Background] Rodeo connected:', tabId);
  } else if (url.includes('fcresearch')) {
    connectedTabs.fcresearch = tabId;
    console.log('[Background] FC Research connected:', tabId);
  }

  updateBadge();
}

// Main workflow: fetch all data for a batch
async function handleFetchBatchData(batchId, warehouseId) {
  console.log(`[Background] Fetching data for batch ${batchId} at ${warehouseId}`);

  try {
    // Step 1: Get FN SKUs from Rodeo
    const rodeoResult = await fetchFNSKUsFromRodeo(batchId, warehouseId);
    if (rodeoResult.error) {
      return { error: rodeoResult.error };
    }

    const fnskus = rodeoResult.fnskus;
    console.log(`[Background] Found ${fnskus.length} FN SKUs`);

    if (fnskus.length === 0) {
      return { error: 'No FN SKUs found for this batch' };
    }

    // Step 2: Get weights for each unique FN SKU
    const uniqueFNSKUs = [...new Set(fnskus)];
    const weightResults = await Promise.all(
      uniqueFNSKUs.map(fnsku => fetchWeightFromFCResearch(fnsku, warehouseId))
    );

    // Build a map of FNSKU -> weight
    const weightMap = new Map();
    uniqueFNSKUs.forEach((fnsku, index) => {
      const result = weightResults[index];
      if (result.weight !== null && result.weight !== undefined) {
        weightMap.set(fnsku, result.weight);
      }
    });

    // Step 3: Calculate statistics
    const weights = fnskus
      .map(fnsku => weightMap.get(fnsku))
      .filter(w => w !== null && w !== undefined);

    if (weights.length === 0) {
      return { error: 'Could not retrieve weights for any items' };
    }

    const totalWeight = weights.reduce((sum, w) => sum + w, 0);
    const averageWeight = totalWeight / weights.length;
    const minWeight = Math.min(...weights);
    const maxWeight = Math.max(...weights);

    return {
      batchId,
      totalItems: fnskus.length,
      itemsWithWeight: weights.length,
      averageWeight: Math.round(averageWeight * 100) / 100,
      totalWeight: Math.round(totalWeight * 100) / 100,
      minWeight: Math.round(minWeight * 100) / 100,
      maxWeight: Math.round(maxWeight * 100) / 100,
      uniqueSKUs: uniqueFNSKUs.length
    };
  } catch (error) {
    console.error('[Background] Error fetching batch data:', error);
    return { error: error.message };
  }
}

// Fetch FN SKUs from Rodeo for a given batch ID
async function fetchFNSKUsFromRodeo(batchId, warehouseId) {
  const url = `https://rodeo-iad.amazon.com/${warehouseId}/Search?_enabledColumns=on&enabledColumns=LPN&searchKey=${batchId}`;

  console.log(`[Background] Fetching Rodeo: ${url}`);

  try {
    const response = await fetch(url, {
      credentials: 'include',
      headers: {
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
      }
    });

    if (!response.ok) {
      throw new Error(`Rodeo request failed: ${response.status}`);
    }

    const html = await response.text();

    // Parse HTML to extract FN SKUs
    const fnskus = parseRodeoFNSKUs(html);

    return { fnskus };
  } catch (error) {
    console.error('[Background] Rodeo fetch error:', error);
    return { error: error.message, fnskus: [] };
  }
}

// Parse Rodeo HTML to extract FN SKUs
function parseRodeoFNSKUs(html) {
  const fnskus = [];

  // Create a DOM parser
  const parser = new DOMParser();
  const doc = parser.parseFromString(html, 'text/html');

  // Look for the results table - FN SKU is typically in the second column
  const rows = doc.querySelectorAll('table tr');

  rows.forEach((row, index) => {
    // Skip header row
    if (index === 0) return;

    const cells = row.querySelectorAll('td');
    // FN SKU is typically in the second column (index 1)
    if (cells.length > 1) {
      const fnsku = cells[1].textContent.trim();
      if (fnsku && fnsku.match(/^[A-Z0-9]+$/)) {
        fnskus.push(fnsku);
      }
    }
  });

  // Also try regex extraction as backup
  if (fnskus.length === 0) {
    // FN SKU pattern: typically starts with X or B followed by alphanumeric
    const matches = html.match(/\b[XB][A-Z0-9]{9,}\b/g);
    if (matches) {
      fnskus.push(...matches);
    }
  }

  return fnskus;
}

// Fetch weight from FC Research for a given FN SKU
async function fetchWeightFromFCResearch(fnsku, warehouseId) {
  // Check cache first
  const cacheKey = `${warehouseId}:${fnsku}`;
  const cached = weightCache.get(cacheKey);
  if (cached && (Date.now() - cached.timestamp < CACHE_DURATION)) {
    console.log(`[Background] Cache hit for ${fnsku}: ${cached.weight} lbs`);
    return { fnsku, weight: cached.weight };
  }

  const url = `https://fcresearch-na.aka.amazon.com/${warehouseId}/results?s=${fnsku}`;

  console.log(`[Background] Fetching FC Research: ${url}`);

  try {
    const response = await fetch(url, {
      credentials: 'include',
      headers: {
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
      }
    });

    if (!response.ok) {
      throw new Error(`FC Research request failed: ${response.status}`);
    }

    const html = await response.text();

    // Parse HTML to extract weight
    const weight = parseFCResearchWeight(html);

    // Cache the result
    if (weight !== null) {
      weightCache.set(cacheKey, { weight, timestamp: Date.now() });
    }

    return { fnsku, weight };
  } catch (error) {
    console.error('[Background] FC Research fetch error:', error);
    return { fnsku, weight: null, error: error.message };
  }
}

// Parse FC Research HTML to extract weight in pounds
function parseFCResearchWeight(html) {
  // Create a DOM parser
  const parser = new DOMParser();
  const doc = parser.parseFromString(html, 'text/html');

  // Look for weight in the table - it's in a row with "Weight" label
  const rows = doc.querySelectorAll('tr');

  for (const row of rows) {
    const cells = row.querySelectorAll('td, th');
    for (let i = 0; i < cells.length - 1; i++) {
      const cellText = cells[i].textContent.trim().toLowerCase();
      if (cellText === 'weight') {
        const weightText = cells[i + 1].textContent.trim();
        // Parse weight value - format is typically "0.79 pounds"
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

  // Fallback: try regex on full HTML
  const weightMatch = html.match(/Weight<\/td>\s*<td[^>]*>([\d.]+)\s*(?:pounds?|lbs?)/i);
  if (weightMatch) {
    return parseFloat(weightMatch[1]);
  }

  return null;
}

// Update extension badge based on status
function updateBadge() {
  const connected = connectedTabs.pickingConsole !== null;

  if (connected) {
    browser.browserAction.setBadgeText({ text: '✓' });
    browser.browserAction.setBadgeBackgroundColor({ color: '#4CAF50' });
  } else {
    browser.browserAction.setBadgeText({ text: '' });
  }
}

// Clean up disconnected tabs
browser.tabs.onRemoved.addListener((tabId) => {
  if (connectedTabs.pickingConsole === tabId) {
    connectedTabs.pickingConsole = null;
  }
  if (connectedTabs.rodeo === tabId) {
    connectedTabs.rodeo = null;
  }
  if (connectedTabs.fcresearch === tabId) {
    connectedTabs.fcresearch = null;
  }
  updateBadge();
});

// Monitor tab URL changes
browser.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.url) {
    // If tab navigates away from our domains, remove from tracking
    if (connectedTabs.pickingConsole === tabId && !changeInfo.url.includes('picking-console')) {
      connectedTabs.pickingConsole = null;
    }
    if (connectedTabs.rodeo === tabId && !changeInfo.url.includes('rodeo')) {
      connectedTabs.rodeo = null;
    }
    if (connectedTabs.fcresearch === tabId && !changeInfo.url.includes('fcresearch')) {
      connectedTabs.fcresearch = null;
    }
    updateBadge();
  }
});

console.log('[Background] Picking Console Size Calculator loaded');
