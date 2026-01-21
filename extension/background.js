// Background script for Picking Console Size Calculator
// Coordinates fetching data from Rodeo and FC Research tabs
// REQUIRES all 3 tabs to be open: Picking Console, Rodeo, FC Research

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
log('='.repeat(50));

// Cache for FN SKU weights to avoid redundant requests
const weightCache = new Map();
const CACHE_DURATION = 30 * 60 * 1000; // 30 minutes

// Track connected tabs
const connectedTabs = {
  pickingConsole: null,
  rodeo: null,
  fcresearch: null
};

// Track tab URLs for debugging
const tabUrls = {
  pickingConsole: null,
  rodeo: null,
  fcresearch: null
};

// Listen for messages from content scripts
browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const senderInfo = sender.tab ? `Tab ${sender.tab.id} (${sender.tab.url?.substring(0, 50)}...)` : 'Unknown';
  log(`Received message: ${message.type} from ${senderInfo}`);
  log('Message payload:', JSON.stringify(message, null, 2));

  switch (message.type) {
    case 'contentScriptReady':
      handleContentScriptReady(message, sender);
      broadcastConnectionStatus();
      return false;

    case 'fetchBatchData':
      log(`=== FETCH BATCH DATA REQUEST: ${message.batchId} ===`);
      handleFetchBatchData(message.batchId, message.warehouseId)
        .then(result => {
          log('fetchBatchData result:', JSON.stringify(result, null, 2));
          sendResponse(result);
        })
        .catch(error => {
          logError('fetchBatchData error:', error);
          sendResponse({ error: error.message });
        });
      return true;

    case 'rodeoDataReady':
      log('Rodeo data received:', JSON.stringify(message.data, null, 2));
      sendResponse({ received: true });
      return false;

    case 'fcresearchDataReady':
      log('FC Research data received:', JSON.stringify(message.data, null, 2));
      sendResponse({ received: true });
      return false;

    case 'clearCache':
      log('Clearing cache...');
      weightCache.clear();
      log('Cache cleared. New size:', weightCache.size);
      sendResponse({ success: true });
      return false;

    case 'getStatus':
      const status = {
        cacheSize: weightCache.size,
        connectedTabs: {
          pickingConsole: connectedTabs.pickingConsole !== null,
          rodeo: connectedTabs.rodeo !== null,
          fcresearch: connectedTabs.fcresearch !== null
        },
        tabIds: { ...connectedTabs },
        tabUrls: { ...tabUrls },
        allConnected: areAllTabsConnected()
      };
      log('Status request - returning:', JSON.stringify(status, null, 2));
      sendResponse(status);
      return false;

    case 'checkConnections':
      const connectionStatus = {
        allConnected: areAllTabsConnected(),
        missing: getMissingTabs(),
        tabs: { ...connectedTabs }
      };
      log('Connection check:', JSON.stringify(connectionStatus, null, 2));
      sendResponse(connectionStatus);
      return false;

    default:
      log('Unknown message type:', message.type);
      return false;
  }
});

// Check if all required tabs are connected
function areAllTabsConnected() {
  const result = connectedTabs.pickingConsole !== null &&
                 connectedTabs.rodeo !== null &&
                 connectedTabs.fcresearch !== null;
  log(`areAllTabsConnected: ${result} (PC: ${connectedTabs.pickingConsole}, Rodeo: ${connectedTabs.rodeo}, FCR: ${connectedTabs.fcresearch})`);
  return result;
}

// Get list of missing tabs
function getMissingTabs() {
  const missing = [];
  if (connectedTabs.pickingConsole === null) missing.push('Picking Console');
  if (connectedTabs.rodeo === null) missing.push('Rodeo');
  if (connectedTabs.fcresearch === null) missing.push('FC Research');
  return missing;
}

// Handle content script registration
function handleContentScriptReady(message, sender) {
  const tabId = sender.tab.id;
  const url = sender.tab.url;

  log(`Content script ready from tab ${tabId}`);
  log(`URL: ${url}`);
  log(`Page type reported: ${message.page}`);
  log(`Warehouse ID: ${message.warehouseId}`);

  if (url.includes('picking-console')) {
    connectedTabs.pickingConsole = tabId;
    tabUrls.pickingConsole = url;
    log('✓ Picking Console tab registered:', tabId);
  } else if (url.includes('rodeo')) {
    connectedTabs.rodeo = tabId;
    tabUrls.rodeo = url;
    log('✓ Rodeo tab registered:', tabId);
  } else if (url.includes('fcresearch')) {
    connectedTabs.fcresearch = tabId;
    tabUrls.fcresearch = url;
    log('✓ FC Research tab registered:', tabId);
  } else {
    log('⚠ Unknown page type for URL:', url);
  }

  log('Current connected tabs:', JSON.stringify(connectedTabs, null, 2));
  log('All tabs connected:', areAllTabsConnected());

  updateBadge();
}

// Broadcast connection status to all connected tabs
function broadcastConnectionStatus() {
  const status = {
    type: 'connectionStatusUpdate',
    allConnected: areAllTabsConnected(),
    missing: getMissingTabs(),
    tabs: {
      pickingConsole: connectedTabs.pickingConsole !== null,
      rodeo: connectedTabs.rodeo !== null,
      fcresearch: connectedTabs.fcresearch !== null
    }
  };

  log('Broadcasting connection status:', JSON.stringify(status, null, 2));

  // Notify picking console
  if (connectedTabs.pickingConsole) {
    browser.tabs.sendMessage(connectedTabs.pickingConsole, status).catch(err => {
      log('Failed to send to picking console:', err.message);
    });
  }
}

// Main workflow: fetch all data for a batch
async function handleFetchBatchData(batchId, warehouseId) {
  log('='.repeat(50));
  log(`STARTING BATCH DATA FETCH`);
  log(`Batch ID: ${batchId}`);
  log(`Warehouse ID: ${warehouseId}`);
  log('='.repeat(50));

  // Check if all tabs are connected
  if (!areAllTabsConnected()) {
    const missing = getMissingTabs();
    const errorMsg = `Missing required tabs: ${missing.join(', ')}. Please open all three tabs.`;
    logError(errorMsg);
    return {
      error: errorMsg,
      missingTabs: missing,
      instruction: 'Please open these tabs and refresh them: ' + missing.join(', ')
    };
  }

  log('✓ All tabs connected, proceeding with data fetch');

  try {
    // Step 1: Get FN SKUs from Rodeo tab
    log('--- STEP 1: Fetching FN SKUs from Rodeo ---');
    const rodeoResult = await fetchFNSKUsViaRodeoTab(batchId, warehouseId);
    log('Rodeo result:', JSON.stringify(rodeoResult, null, 2));

    if (rodeoResult.error) {
      logError('Rodeo fetch failed:', rodeoResult.error);
      return { error: `Rodeo error: ${rodeoResult.error}` };
    }

    const fnskus = rodeoResult.fnskus || [];
    log(`Found ${fnskus.length} FN SKUs:`, fnskus);

    if (fnskus.length === 0) {
      logError('No FN SKUs found for batch:', batchId);
      return { error: 'No FN SKUs found for this batch in Rodeo' };
    }

    // Step 2: Get weights for each unique FN SKU via FC Research tab
    log('--- STEP 2: Fetching weights from FC Research ---');
    const uniqueFNSKUs = [...new Set(fnskus)];
    log(`Unique FN SKUs to fetch: ${uniqueFNSKUs.length}`);

    const weightResults = [];
    for (const fnsku of uniqueFNSKUs) {
      log(`Fetching weight for FN SKU: ${fnsku}`);
      const result = await fetchWeightViaFCResearchTab(fnsku, warehouseId);
      log(`Weight result for ${fnsku}:`, JSON.stringify(result, null, 2));
      weightResults.push(result);
    }

    // Build a map of FNSKU -> weight
    log('--- STEP 3: Building weight map ---');
    const weightMap = new Map();
    uniqueFNSKUs.forEach((fnsku, index) => {
      const result = weightResults[index];
      if (result.weight !== null && result.weight !== undefined) {
        weightMap.set(fnsku, result.weight);
        log(`Mapped ${fnsku} -> ${result.weight} lbs`);
      } else {
        log(`No weight found for ${fnsku}`);
      }
    });

    // Step 4: Calculate statistics
    log('--- STEP 4: Calculating statistics ---');
    const weights = fnskus
      .map(fnsku => weightMap.get(fnsku))
      .filter(w => w !== null && w !== undefined);

    log(`Weights array (${weights.length} items):`, weights);

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
      uniqueSKUs: uniqueFNSKUs.length,
      fnskuList: uniqueFNSKUs,
      weightMap: Object.fromEntries(weightMap)
    };

    log('='.repeat(50));
    log('BATCH DATA FETCH COMPLETE');
    log('Final result:', JSON.stringify(result, null, 2));
    log('='.repeat(50));

    return result;
  } catch (error) {
    logError('Exception during batch data fetch:', error);
    logError('Stack:', error.stack);
    return { error: error.message, stack: error.stack };
  }
}

// Fetch FN SKUs by sending message to Rodeo tab
async function fetchFNSKUsViaRodeoTab(batchId, warehouseId) {
  log(`Sending fetchFNSKUs request to Rodeo tab ${connectedTabs.rodeo}`);
  log(`Batch ID: ${batchId}, Warehouse: ${warehouseId}`);

  try {
    // First, tell Rodeo tab to navigate to the search URL
    const searchUrl = `https://rodeo-iad.amazon.com/${warehouseId}/Search?_enabledColumns=on&enabledColumns=LPN&searchKey=${batchId}`;
    log(`Rodeo search URL: ${searchUrl}`);

    const response = await browser.tabs.sendMessage(connectedTabs.rodeo, {
      type: 'navigateAndExtract',
      url: searchUrl,
      batchId: batchId,
      warehouseId: warehouseId
    });

    log('Rodeo tab response:', JSON.stringify(response, null, 2));
    return response;
  } catch (error) {
    logError('Error communicating with Rodeo tab:', error);
    return { error: error.message, fnskus: [] };
  }
}

// Fetch weight by sending message to FC Research tab
async function fetchWeightViaFCResearchTab(fnsku, warehouseId) {
  // Check cache first
  const cacheKey = `${warehouseId}:${fnsku}`;
  const cached = weightCache.get(cacheKey);
  if (cached && (Date.now() - cached.timestamp < CACHE_DURATION)) {
    log(`✓ Cache HIT for ${fnsku}: ${cached.weight} lbs`);
    return { fnsku, weight: cached.weight, fromCache: true };
  }
  log(`Cache MISS for ${fnsku}`);

  log(`Sending fetchWeight request to FC Research tab ${connectedTabs.fcresearch}`);
  log(`FN SKU: ${fnsku}, Warehouse: ${warehouseId}`);

  try {
    const searchUrl = `https://fcresearch-na.aka.amazon.com/${warehouseId}/results?s=${fnsku}`;
    log(`FC Research URL: ${searchUrl}`);

    const response = await browser.tabs.sendMessage(connectedTabs.fcresearch, {
      type: 'navigateAndExtract',
      url: searchUrl,
      fnsku: fnsku,
      warehouseId: warehouseId
    });

    log('FC Research tab response:', JSON.stringify(response, null, 2));

    // Cache the result
    if (response.weight !== null && response.weight !== undefined) {
      weightCache.set(cacheKey, { weight: response.weight, timestamp: Date.now() });
      log(`Cached weight for ${fnsku}: ${response.weight} lbs`);
    }

    return response;
  } catch (error) {
    logError('Error communicating with FC Research tab:', error);
    return { fnsku, weight: null, error: error.message };
  }
}

// Update extension badge based on status
function updateBadge() {
  const allConnected = areAllTabsConnected();
  const connectedCount = [
    connectedTabs.pickingConsole,
    connectedTabs.rodeo,
    connectedTabs.fcresearch
  ].filter(t => t !== null).length;

  log(`Updating badge: ${connectedCount}/3 tabs connected`);

  if (allConnected) {
    browser.browserAction.setBadgeText({ text: '✓' });
    browser.browserAction.setBadgeBackgroundColor({ color: '#4CAF50' });
    log('Badge: Green checkmark (all connected)');
  } else if (connectedCount > 0) {
    browser.browserAction.setBadgeText({ text: String(connectedCount) });
    browser.browserAction.setBadgeBackgroundColor({ color: '#FF9800' });
    log(`Badge: Orange ${connectedCount} (partial connection)`);
  } else {
    browser.browserAction.setBadgeText({ text: '!' });
    browser.browserAction.setBadgeBackgroundColor({ color: '#f44336' });
    log('Badge: Red ! (no connections)');
  }
}

// Clean up disconnected tabs
browser.tabs.onRemoved.addListener((tabId) => {
  log(`Tab removed: ${tabId}`);
  let changed = false;

  if (connectedTabs.pickingConsole === tabId) {
    log('Picking Console tab closed');
    connectedTabs.pickingConsole = null;
    tabUrls.pickingConsole = null;
    changed = true;
  }
  if (connectedTabs.rodeo === tabId) {
    log('Rodeo tab closed');
    connectedTabs.rodeo = null;
    tabUrls.rodeo = null;
    changed = true;
  }
  if (connectedTabs.fcresearch === tabId) {
    log('FC Research tab closed');
    connectedTabs.fcresearch = null;
    tabUrls.fcresearch = null;
    changed = true;
  }

  if (changed) {
    updateBadge();
    broadcastConnectionStatus();
  }
});

// Monitor tab URL changes
browser.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === 'complete') {
    log(`Tab ${tabId} finished loading: ${tab.url?.substring(0, 60)}...`);
  }

  if (changeInfo.url) {
    log(`Tab ${tabId} URL changed to: ${changeInfo.url.substring(0, 60)}...`);
    let changed = false;

    // If tab navigates away from our domains, remove from tracking
    if (connectedTabs.pickingConsole === tabId && !changeInfo.url.includes('picking-console')) {
      log('Picking Console tab navigated away');
      connectedTabs.pickingConsole = null;
      tabUrls.pickingConsole = null;
      changed = true;
    }
    if (connectedTabs.rodeo === tabId && !changeInfo.url.includes('rodeo')) {
      log('Rodeo tab navigated away');
      connectedTabs.rodeo = null;
      tabUrls.rodeo = null;
      changed = true;
    }
    if (connectedTabs.fcresearch === tabId && !changeInfo.url.includes('fcresearch')) {
      log('FC Research tab navigated away');
      connectedTabs.fcresearch = null;
      tabUrls.fcresearch = null;
      changed = true;
    }

    if (changed) {
      updateBadge();
      broadcastConnectionStatus();
    }
  }
});

log('Background script initialization complete');
log('Waiting for content scripts to connect...');
log('Required tabs: Picking Console, Rodeo, FC Research');
