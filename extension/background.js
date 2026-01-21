// Background script for Picking Console Size Calculator
// Makes direct HTTP requests to Rodeo and FC Research to fetch data

const DEBUG = true;

function log(...args) {
  if (DEBUG) {
    const timestamp = new Date().toISOString().substr(11, 12);
    console.log(`[Background ${timestamp}]`, ...args);
  }
}

function logError(...args) {
  const timestamp = new Date().toISOString().substr(11, 12);
  console.error(`[Background ${timestamp}] ERROR:`, ...args);
}

log('='.repeat(50));
log('Picking Console Size Calculator - Background Script Starting');
log('Using direct HTTP requests (no tab navigation needed)');
log('='.repeat(50));

// Cache for FN SKU weights to avoid redundant requests
const weightCache = new Map();
const CACHE_DURATION = 30 * 60 * 1000; // 30 minutes

// Listen for messages from content scripts
browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
  log(`Received message: ${message.type}`);

  switch (message.type) {
    case 'contentScriptReady':
      log(`Content script ready: ${message.page} (warehouse: ${message.warehouseId})`);
      updateBadge(true);
      sendResponse({ status: 'ok' });
      return false;

    case 'fetchBatchData':
      log(`=== FETCH BATCH DATA: ${message.batchId} ===`);
      handleFetchBatchData(message.batchId, message.warehouseId)
        .then(result => {
          log('fetchBatchData result:', JSON.stringify(result, null, 2));
          sendResponse(result);
        })
        .catch(error => {
          logError('fetchBatchData error:', error);
          sendResponse({ error: error.message });
        });
      return true; // Keep channel open for async response

    case 'clearCache':
      log('Clearing cache...');
      weightCache.clear();
      log('Cache cleared. New size:', weightCache.size);
      sendResponse({ success: true });
      return false;

    case 'getStatus':
      sendResponse({
        cacheSize: weightCache.size,
        ready: true
      });
      return false;

    default:
      log('Unknown message type:', message.type);
      return false;
  }
});

// Main workflow: fetch all data for a batch
async function handleFetchBatchData(batchId, warehouseId) {
  log('='.repeat(50));
  log(`STARTING BATCH DATA FETCH`);
  log(`Batch ID: ${batchId}`);
  log(`Warehouse ID: ${warehouseId}`);
  log('='.repeat(50));

  try {
    // Step 1: Get FN SKUs from Rodeo via direct HTTP request
    log('--- STEP 1: Fetching FN SKUs from Rodeo ---');
    const rodeoResult = await fetchFNSKUsFromRodeo(batchId, warehouseId);
    log('Rodeo result:', JSON.stringify(rodeoResult, null, 2));

    if (rodeoResult.error) {
      logError('Rodeo fetch failed:', rodeoResult.error);
      return { error: `Rodeo error: ${rodeoResult.error}` };
    }

    const fnskus = rodeoResult.fnskus || [];
    log(`Found ${fnskus.length} FN SKUs:`, fnskus.slice(0, 10), fnskus.length > 10 ? '...' : '');

    if (fnskus.length === 0) {
      logError('No FN SKUs found for batch:', batchId);
      return { error: 'No FN SKUs found for this batch in Rodeo' };
    }

    // Step 2: Get weights for each unique FN SKU via direct HTTP requests
    log('--- STEP 2: Fetching weights from FC Research ---');
    const uniqueFNSKUs = [...new Set(fnskus)];
    log(`Unique FN SKUs to fetch: ${uniqueFNSKUs.length}`);

    // Fetch weights in parallel (with some concurrency limit)
    const CONCURRENCY = 5;
    const weightResults = [];

    for (let i = 0; i < uniqueFNSKUs.length; i += CONCURRENCY) {
      const batch = uniqueFNSKUs.slice(i, i + CONCURRENCY);
      const batchResults = await Promise.all(
        batch.map(fnsku => fetchWeightFromFCResearch(fnsku, warehouseId))
      );
      weightResults.push(...batchResults);
      log(`Fetched weights ${i + 1}-${Math.min(i + CONCURRENCY, uniqueFNSKUs.length)} of ${uniqueFNSKUs.length}`);
    }

    // Build a map of FNSKU -> weight
    log('--- STEP 3: Building weight map ---');
    const weightMap = new Map();
    uniqueFNSKUs.forEach((fnsku, index) => {
      const result = weightResults[index];
      if (result && result.weight !== null && result.weight !== undefined) {
        weightMap.set(fnsku, result.weight);
        log(`  ${fnsku} -> ${result.weight} lbs`);
      } else {
        log(`  ${fnsku} -> NO WEIGHT FOUND`);
      }
    });

    // Step 4: Calculate statistics
    log('--- STEP 4: Calculating statistics ---');
    const weights = fnskus
      .map(fnsku => weightMap.get(fnsku))
      .filter(w => w !== null && w !== undefined);

    log(`Weights collected: ${weights.length} of ${fnskus.length} items`);

    if (weights.length === 0) {
      logError('Could not retrieve weights for any items');
      return { error: 'Could not retrieve weights for any items from FC Research' };
    }

    const totalWeight = weights.reduce((sum, w) => sum + w, 0);
    const averageWeight = totalWeight / weights.length;
    const minWeight = Math.min(...weights);
    const maxWeight = Math.max(...weights);

    const result = {
      batchId,
      totalItems: fnskus.length,
      itemsWithWeight: weights.length,
      averageWeight: Math.round(averageWeight * 100) / 100,
      totalWeight: Math.round(totalWeight * 100) / 100,
      minWeight: Math.round(minWeight * 100) / 100,
      maxWeight: Math.round(maxWeight * 100) / 100,
      uniqueSKUs: uniqueFNSKUs.length
    };

    log('='.repeat(50));
    log('BATCH DATA FETCH COMPLETE');
    log('Final result:', JSON.stringify(result, null, 2));
    log('='.repeat(50));

    return result;
  } catch (error) {
    logError('Exception during batch data fetch:', error);
    logError('Stack:', error.stack);
    return { error: error.message };
  }
}

// Fetch FN SKUs from Rodeo via direct HTTP request
async function fetchFNSKUsFromRodeo(batchId, warehouseId) {
  const url = `https://rodeo-iad.amazon.com/${warehouseId}/Search?_enabledColumns=on&enabledColumns=LPN&searchKey=${batchId}`;

  log(`Fetching Rodeo URL: ${url}`);

  try {
    const response = await fetch(url, {
      method: 'GET',
      credentials: 'include', // Include cookies for authentication
      headers: {
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5'
      }
    });

    log(`Rodeo response status: ${response.status}`);

    if (!response.ok) {
      throw new Error(`Rodeo request failed: ${response.status} ${response.statusText}`);
    }

    const html = await response.text();
    log(`Rodeo response length: ${html.length} chars`);

    // Parse HTML to extract FN SKUs
    const fnskus = parseRodeoFNSKUs(html);
    log(`Parsed ${fnskus.length} FN SKUs from Rodeo response`);

    return { fnskus };
  } catch (error) {
    logError('Rodeo fetch error:', error);
    return { error: error.message, fnskus: [] };
  }
}

// Parse Rodeo HTML to extract FN SKUs
function parseRodeoFNSKUs(html) {
  const fnskus = [];

  log('Parsing Rodeo HTML for FN SKUs...');

  // Method 1: Look for FN SKU links (they link to fcresearch)
  // Pattern: <a href="...fcresearch...">X004UIFIPL</a>
  const linkPattern = /<a[^>]*href="[^"]*fcresearch[^"]*"[^>]*>([A-Z0-9]{10,})<\/a>/gi;
  let match;
  while ((match = linkPattern.exec(html)) !== null) {
    fnskus.push(match[1]);
  }
  log(`Method 1 (fcresearch links): found ${fnskus.length} FN SKUs`);

  // Method 2: If no results, try table cell pattern
  if (fnskus.length === 0) {
    // Look for FN SKU pattern in table cells: <td>X004UIFIPL</td> or <td><a>X004UIFIPL</a></td>
    const cellPattern = /<td[^>]*>(?:<a[^>]*>)?([XB][A-Z0-9]{9,})(?:<\/a>)?<\/td>/gi;
    while ((match = cellPattern.exec(html)) !== null) {
      fnskus.push(match[1]);
    }
    log(`Method 2 (table cells): found ${fnskus.length} FN SKUs`);
  }

  // Method 3: Broader regex search
  if (fnskus.length === 0) {
    const broadPattern = /\b([XB][A-Z0-9]{9,})\b/g;
    const seen = new Set();
    while ((match = broadPattern.exec(html)) !== null) {
      if (!seen.has(match[1])) {
        seen.add(match[1]);
        fnskus.push(match[1]);
      }
    }
    log(`Method 3 (broad regex): found ${fnskus.length} FN SKUs`);
  }

  // Log sample of HTML for debugging if no FN SKUs found
  if (fnskus.length === 0) {
    log('No FN SKUs found. HTML sample (first 2000 chars):');
    log(html.substring(0, 2000));
  }

  return fnskus;
}

// Fetch weight from FC Research via direct HTTP request
async function fetchWeightFromFCResearch(fnsku, warehouseId) {
  // Check cache first
  const cacheKey = `${warehouseId}:${fnsku}`;
  const cached = weightCache.get(cacheKey);
  if (cached && (Date.now() - cached.timestamp < CACHE_DURATION)) {
    log(`Cache HIT for ${fnsku}: ${cached.weight} lbs`);
    return { fnsku, weight: cached.weight, fromCache: true };
  }

  const url = `https://fcresearch-na.aka.amazon.com/${warehouseId}/results?s=${fnsku}`;

  log(`Fetching FC Research URL: ${url}`);

  try {
    const response = await fetch(url, {
      method: 'GET',
      credentials: 'include', // Include cookies for authentication
      headers: {
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5'
      }
    });

    log(`FC Research response status for ${fnsku}: ${response.status}`);

    if (!response.ok) {
      throw new Error(`FC Research request failed: ${response.status}`);
    }

    const html = await response.text();
    log(`FC Research response length for ${fnsku}: ${html.length} chars`);

    // Parse HTML to extract weight
    const weight = parseFCResearchWeight(html, fnsku);

    // Cache the result
    if (weight !== null) {
      weightCache.set(cacheKey, { weight, timestamp: Date.now() });
      log(`Cached weight for ${fnsku}: ${weight} lbs`);
    }

    return { fnsku, weight };
  } catch (error) {
    logError(`FC Research fetch error for ${fnsku}:`, error);
    return { fnsku, weight: null, error: error.message };
  }
}

// Parse FC Research HTML to extract weight in pounds
function parseFCResearchWeight(html, fnsku) {
  log(`Parsing FC Research HTML for weight (${fnsku})...`);

  // Method 1: Look for Weight row in table
  // Pattern: <td>Weight</td><td>0.79 pounds</td>
  const weightRowPattern = /<t[dh][^>]*>\s*Weight\s*<\/t[dh]>\s*<td[^>]*>\s*([\d.]+)\s*(?:pounds?|lbs?)/i;
  let match = html.match(weightRowPattern);
  if (match) {
    const weight = parseFloat(match[1]);
    log(`Method 1 (table row): found weight ${weight} lbs`);
    return weight;
  }

  // Method 2: Look for weight with any separator
  const weightPattern = /Weight[:\s<>\/tdh]*?([\d.]+)\s*(?:pounds?|lbs?)/i;
  match = html.match(weightPattern);
  if (match) {
    const weight = parseFloat(match[1]);
    log(`Method 2 (generic): found weight ${weight} lbs`);
    return weight;
  }

  // Method 3: Look in structured data or JSON
  const jsonPattern = /"weight"[:\s]*([\d.]+)/i;
  match = html.match(jsonPattern);
  if (match) {
    const weight = parseFloat(match[1]);
    log(`Method 3 (JSON): found weight ${weight} lbs`);
    return weight;
  }

  log(`No weight found for ${fnsku}`);

  // Log sample for debugging
  if (html.includes('Weight')) {
    const idx = html.indexOf('Weight');
    log(`HTML around 'Weight' keyword: ...${html.substring(Math.max(0, idx - 50), idx + 150)}...`);
  }

  return null;
}

// Update extension badge
function updateBadge(connected) {
  if (connected) {
    browser.browserAction.setBadgeText({ text: '✓' });
    browser.browserAction.setBadgeBackgroundColor({ color: '#4CAF50' });
  } else {
    browser.browserAction.setBadgeText({ text: '' });
  }
}

log('Background script initialization complete');
log('Ready to process requests via direct HTTP calls');
