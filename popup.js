/**
 * Better Shorts - Popup Control Script
 */

document.addEventListener('DOMContentLoaded', () => {
  const toggle = document.getElementById('stabilize-toggle');
  const pauseToggle = document.getElementById('pause-toggle');

  // 1. Load stored settings
  chrome.storage.local.get(['enabled', 'autoPause'], (result) => {
    // Default stabilization to enabled (true) if not set
    const isEnabled = result.enabled !== false;
    toggle.checked = isEnabled;

    // Default autoPause to disabled (false) if not set
    const isAutoPause = result.autoPause === true;
    pauseToggle.checked = isAutoPause;
  });

  // 2. Listen for setting changes
  toggle.addEventListener('change', (e) => {
    const isEnabled = e.target.checked;
    chrome.storage.local.set({ enabled: isEnabled });
  });

  pauseToggle.addEventListener('change', (e) => {
    const isAutoPause = e.target.checked;
    chrome.storage.local.set({ autoPause: isAutoPause });
  });
});
