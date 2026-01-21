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
  // Try multiple URL patterns for Rodeo
  const urls = [
    `https://rodeo-iad.amazon.com/${warehouseId}/Search?_enabledColumns=on&enabledColumns=LPN&searchKey=${batchId}`,
    `https://rodeo-iad.amazon.com/${warehouseId}/Search?searchKey=${batchId}`,
    `https://rodeo-dub.amazon.com/${warehouseId}/Search?searchKey=${batchId}`,
    `https://rodeo.amazon.com/${warehouseId}/Search?searchKey=${batchId}`
  ];

  for (const url of urls) {
    log(`Trying Rodeo URL: ${url}`);

    try {
      const response = await fetch(url, {
        method: 'GET',
        credentials: 'include',
        headers: {
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.5'
        }
      });

      log(`Rodeo response status: ${response.status}`);

      if (!response.ok) {
        log(`Request failed, trying next URL...`);
        continue;
      }

      const html = await response.text();
      log(`Rodeo response length: ${html.length} chars`);

      // Check if we got a valid response (not a redirect or error page)
      if (html.includes('Sign in') || html.includes('Login') || html.length < 500) {
        log('Got login page or error, trying next URL...');
        continue;
      }

      // Parse HTML to extract FN SKUs
      const fnskus = parseRodeoFNSKUs(html);
      log(`Parsed ${fnskus.length} FN SKUs from Rodeo response`);

      if (fnskus.length > 0) {
        return { fnskus };
      }
    } catch (error) {
      logError(`Rodeo fetch error for ${url}:`, error);
    }
  }

  return { error: 'Could not fetch data from Rodeo', fnskus: [] };
}

// Parse Rodeo HTML to extract FN SKUs
function parseRodeoFNSKUs(html) {
  const fnskus = [];
  const seen = new Set();

  log('Parsing Rodeo HTML for FN SKUs...');

  // Method 1: Look for FN SKU links (they link to fcresearch)
  // Pattern: <a href="...fcresearch...*">X004UIFIPL</a>
  const linkPattern = /<a[^>]*href="[^"]*fcresearch[^"]*"[^>]*>([A-Z0-9]{10,})<\/a>/gi;
  let match;
  while ((match = linkPattern.exec(html)) !== null) {
    if (!seen.has(match[1])) {
      seen.add(match[1]);
      fnskus.push(match[1]);
    }
  }
  log(`Method 1 (fcresearch links): found ${fnskus.length} FN SKUs`);

  // Method 2: Look for FN SKU in any links
  if (fnskus.length === 0) {
    const anyLinkPattern = /<a[^>]*>([XB][A-Z0-9]{9,})<\/a>/gi;
    while ((match = anyLinkPattern.exec(html)) !== null) {
      if (!seen.has(match[1])) {
        seen.add(match[1]);
        fnskus.push(match[1]);
      }
    }
    log(`Method 2 (any links): found ${fnskus.length} FN SKUs`);
  }

  // Method 3: Look for FN SKU pattern in table cells
  if (fnskus.length === 0) {
    const cellPattern = /<td[^>]*>(?:<[^>]*>)*([XB][A-Z0-9]{9,})(?:<[^>]*>)*<\/td>/gi;
    while ((match = cellPattern.exec(html)) !== null) {
      if (!seen.has(match[1])) {
        seen.add(match[1]);
        fnskus.push(match[1]);
      }
    }
    log(`Method 3 (table cells): found ${fnskus.length} FN SKUs`);
  }

  // Method 4: Broader regex search for FN SKU pattern
  if (fnskus.length === 0) {
    const broadPattern = /\b([XB][A-Z0-9]{9,})\b/g;
    while ((match = broadPattern.exec(html)) !== null) {
      if (!seen.has(match[1])) {
        seen.add(match[1]);
        fnskus.push(match[1]);
      }
    }
    log(`Method 4 (broad regex): found ${fnskus.length} FN SKUs`);
  }

  // Log sample of HTML for debugging if no FN SKUs found
  if (fnskus.length === 0) {
    log('No FN SKUs found. HTML sample (first 3000 chars):');
    log(html.substring(0, 3000));
    log('---');
    log('HTML sample (around "FN" or "SKU" if present):');
    const fnIndex = html.toLowerCase().indexOf('fn');
    if (fnIndex > -1) {
      log(html.substring(Math.max(0, fnIndex - 100), fnIndex + 500));
    }
  }

  return fnskus;
}

// Fetch weight from FC Research via direct HTTP POST to /results/product endpoint
async function fetchWeightFromFCResearch(fnsku, warehouseId) {
  // Check cache first
  const cacheKey = `${warehouseId}:${fnsku}`;
  const cached = weightCache.get(cacheKey);
  if (cached && (Date.now() - cached.timestamp < CACHE_DURATION)) {
    log(`Cache HIT for ${fnsku}: ${cached.weight} lbs`);
    return { fnsku, weight: cached.weight, fromCache: true };
  }

  // Use the direct /results/product POST endpoint (much cleaner than parsing full page)
  const productEndpoints = [
    `https://fcresearch-na.aka.amazon.com/${warehouseId}/results/product`,
    `https://fcresearch.aka.amazon.com/${warehouseId}/results/product`
  ];

  for (const url of productEndpoints) {
    log(`Trying FC Research product endpoint: ${url}`);

    try {
      const response = await fetch(url, {
        method: 'POST',
        credentials: 'include',
        headers: {
          'Accept': 'text/html, */*; q=0.01',
          'Accept-Language': 'en-US,en;q=0.5',
          'Content-Type': 'application/x-www-form-urlencoded',
          'X-Requested-With': 'XMLHttpRequest'
        },
        body: `s=${fnsku}`
      });

      log(`FC Research response status for ${fnsku}: ${response.status}`);

      if (!response.ok) {
        log(`Request failed, trying next endpoint...`);
        continue;
      }

      const html = await response.text();
      log(`FC Research response length for ${fnsku}: ${html.length} chars`);

      // Check if we got a valid response
      if (html.includes('Sign in') || html.includes('Login') || html.length < 100) {
        log('Got login page or error, trying next endpoint...');
        continue;
      }

      // Parse HTML to extract weight from the product table
      const weight = parseFCResearchWeight(html, fnsku);

      if (weight !== null) {
        // Cache the result
        weightCache.set(cacheKey, { weight, timestamp: Date.now() });
        log(`Cached weight for ${fnsku}: ${weight} lbs`);
        return { fnsku, weight };
      }
    } catch (error) {
      logError(`FC Research fetch error for ${fnsku}:`, error);
    }
  }

  return { fnsku, weight: null, error: 'Could not fetch weight' };
}

// Parse FC Research HTML to extract weight in pounds
// The /results/product endpoint returns clean HTML like:
// <tr><th>Weight</th><td>2.36 pounds</td></tr>
function parseFCResearchWeight(html, fnsku) {
  log(`Parsing FC Research HTML for weight (${fnsku})...`);

  // Primary pattern: Weight row in product table (from /results/product endpoint)
  // Format: <tr><th>Weight</th><td>2.36 pounds</td></tr>
  const primaryPattern = /<th>Weight<\/th>\s*<td>(\d+\.?\d*)\s*pounds?<\/td>/i;
  const primaryMatch = html.match(primaryPattern);
  if (primaryMatch) {
    const weight = parseFloat(primaryMatch[1]);
    if (!isNaN(weight) && weight > 0 && weight < 1000) {
      log(`Primary pattern: found weight ${weight} lbs`);
      return weight;
    }
  }

  // Fallback patterns for other response formats
  const fallbackPatterns = [
    /<t[dh][^>]*>\s*Weight\s*<\/t[dh]>\s*<td[^>]*>\s*([\d.]+)\s*(?:pounds?|lbs?|lb)/i,
    /<t[dh][^>]*>Weight<\/t[dh]>\s*<td[^>]*>([\d.]+)/i,
    /Weight[:\s]*<[^>]*>([\d.]+)\s*(?:pounds?|lbs?|lb)/i,
    /Weight[:\s]*([\d.]+)\s*(?:pounds?|lbs?|lb)/i,
    /"weight"[:\s]*([\d.]+)/i
  ];

  for (let i = 0; i < fallbackPatterns.length; i++) {
    const match = html.match(fallbackPatterns[i]);
    if (match) {
      const weight = parseFloat(match[1]);
      if (!isNaN(weight) && weight > 0 && weight < 1000) {
        log(`Fallback pattern ${i + 1}: found weight ${weight} lbs`);
        return weight;
      }
    }
  }

  // Last resort: Look for pounds anywhere near numbers
  const poundsPattern = /(\d+\.?\d*)\s*(?:pounds?|lbs?|lb)\b/gi;
  let match;
  while ((match = poundsPattern.exec(html)) !== null) {
    const weight = parseFloat(match[1]);
    if (!isNaN(weight) && weight > 0 && weight < 100) {
      log(`Pounds pattern: found weight ${weight} lbs`);
      return weight;
    }
  }

  log(`No weight found for ${fnsku}`);

  // Log sample for debugging
  if (html.toLowerCase().includes('weight')) {
    const idx = html.toLowerCase().indexOf('weight');
    log(`HTML around 'weight' keyword:`);
    log(html.substring(Math.max(0, idx - 50), idx + 200));
  }

  return null;
}

// Update extension badge
function updateBadge(connected) {
  if (connected) {
    browser.browserAction.setBadgeText({ text: 'OK' });
    browser.browserAction.setBadgeBackgroundColor({ color: '#4CAF50' });
  } else {
    browser.browserAction.setBadgeText({ text: '' });
  }
}

log('Background script initialization complete');
log('Ready to process requests via direct HTTP calls');
