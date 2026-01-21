// Popup Script for Picking Console Size Calculator

document.addEventListener('DOMContentLoaded', async () => {
  // Get status from background script
  try {
    const status = await browser.runtime.sendMessage({ type: 'getStatus' });

    // Update connection indicators
    document.getElementById('status-picking').classList.toggle('connected', status.connectedTabs.pickingConsole);
    document.getElementById('status-rodeo').classList.toggle('connected', status.connectedTabs.rodeo);
    document.getElementById('status-fcresearch').classList.toggle('connected', status.connectedTabs.fcresearch);

    // Update cache count
    document.getElementById('cache-count').textContent = status.cacheSize;
  } catch (error) {
    console.error('Error getting status:', error);
  }

  // Clear cache button
  document.getElementById('btn-clear-cache').addEventListener('click', async () => {
    try {
      await browser.runtime.sendMessage({ type: 'clearCache' });
      document.getElementById('cache-count').textContent = '0';

      // Show feedback
      const btn = document.getElementById('btn-clear-cache');
      btn.textContent = 'Cleared!';
      setTimeout(() => {
        btn.textContent = 'Clear Cache';
      }, 1500);
    } catch (error) {
      console.error('Error clearing cache:', error);
    }
  });
});
