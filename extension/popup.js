/**
 * Popup script — handles all UI logic.
 */

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let apiKey = '';
let activeTabId = null;
let currentHighlightedCard = null;

// ---------------------------------------------------------------------------
// DOM references
// ---------------------------------------------------------------------------

const settingsToggle   = document.getElementById('settings-toggle');
const settingsPanel    = document.getElementById('settings-panel');
const apiKeyInput      = document.getElementById('api-key-input');
const saveKeyBtn       = document.getElementById('save-key-btn');
const goalInput        = document.getElementById('goal-input');
const generateBtn      = document.getElementById('generate-btn');
const statusBar        = document.getElementById('status-bar');
const resultsContainer = document.getElementById('results-container');
const resultsList      = document.getElementById('results-list');
const resultsLabel     = document.getElementById('results-label');
const clearBtn         = document.getElementById('clear-btn');
const pickerBtn        = document.getElementById('picker-btn');

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

async function init() {
  // Load saved API key
  const stored = await chrome.storage.local.get('apiKey');
  if (stored.apiKey) {
    apiKey = stored.apiKey;
    apiKeyInput.value = apiKey;
  }

  // Get active tab
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  activeTabId = tab?.id ?? null;

  // Show API key settings if not set
  if (!apiKey) {
    settingsPanel.classList.remove('hidden');
  }
}

init();

// ---------------------------------------------------------------------------
// Settings toggle
// ---------------------------------------------------------------------------

settingsToggle.addEventListener('click', () => {
  settingsPanel.classList.toggle('hidden');
});

saveKeyBtn.addEventListener('click', () => {
  apiKey = apiKeyInput.value.trim();
  chrome.storage.local.set({ apiKey });
  settingsPanel.classList.add('hidden');
  showStatus('API key saved.', 'success');
  setTimeout(clearStatus, 2000);
});

apiKeyInput.addEventListener('keydown', e => {
  if (e.key === 'Enter') saveKeyBtn.click();
});

// ---------------------------------------------------------------------------
// Generate XPaths (natural language mode)
// ---------------------------------------------------------------------------

generateBtn.addEventListener('click', runGenerate);
goalInput.addEventListener('keydown', e => { if (e.key === 'Enter') runGenerate(); });

async function runGenerate() {
  const goal = goalInput.value.trim();
  if (!goal) { goalInput.focus(); return; }
  if (!apiKey) {
    showStatus('Please save your API key first (click the gear icon).', 'error');
    settingsPanel.classList.remove('hidden');
    return;
  }

  setLoading(true);
  clearResults();
  showStatus('Fetching page DOM and calling Gemini...');

  try {
    const resp = await chrome.runtime.sendMessage({ type: 'GENERATE_XPATHS', goal, apiKey });

    if (resp.error) {
      showStatus('Error: ' + resp.error, 'error');
      return;
    }

    renderResults(resp.xpaths, goal);
    showStatus(`Found ${resp.xpaths.length} XPath${resp.xpaths.length !== 1 ? 's' : ''}`, 'success');
  } catch (err) {
    showStatus('Failed: ' + (err.message || err), 'error');
  } finally {
    setLoading(false);
  }
}

// ---------------------------------------------------------------------------
// Render results
// ---------------------------------------------------------------------------

async function renderResults(xpaths, label) {
  resultsList.innerHTML = '';
  currentHighlightedCard = null;

  if (!xpaths || !xpaths.length) {
    showStatus('No XPaths returned. Try rephrasing your goal.', 'error');
    resultsContainer.classList.add('hidden');
    return;
  }

  resultsLabel.textContent = `${xpaths.length} XPath${xpaths.length !== 1 ? 's' : ''} for "${label}"`;
  resultsContainer.classList.remove('hidden');

  for (const item of xpaths) {
    // Get live match count from content script
    let matchCount = '?';
    try {
      const r = await chrome.tabs.sendMessage(activeTabId, { type: 'HIGHLIGHT', xpath: item.xpath });
      matchCount = r?.matchCount ?? '?';
    } catch { /* content script not ready */ }

    const card = document.createElement('div');
    card.className = 'xpath-card' + (currentHighlightedCard === null ? ' active' : '');
    const conf = item.confidence || 'medium';

    card.innerHTML = `
      <div class="xpath-text">${escapeHTML(item.xpath)}</div>
      <div class="xpath-meta">
        <span class="badge badge-${conf}">${conf}</span>
        <span class="match-count">${matchCount} match${matchCount !== 1 ? 'es' : ''}</span>
      </div>
      <div class="explanation">${escapeHTML(item.explanation || '')}</div>`;

    card.addEventListener('click', () => {
      highlightXPath(item.xpath, card, matchCount);
    });

    resultsList.appendChild(card);

    // Auto-highlight the first card
    if (currentHighlightedCard === null) {
      currentHighlightedCard = card;
    }
  }
}

async function highlightXPath(xpath, card, prevCount) {
  // Update active card style
  document.querySelectorAll('.xpath-card').forEach(c => c.classList.remove('active'));
  card.classList.add('active');
  currentHighlightedCard = card;

  try {
    const resp = await chrome.tabs.sendMessage(activeTabId, { type: 'HIGHLIGHT', xpath });
    const count = resp?.matchCount ?? prevCount;
    card.querySelector('.match-count').textContent = `${count} match${count !== 1 ? 'es' : ''}`;
  } catch { /* content script not available */ }
}

// ---------------------------------------------------------------------------
// Clear highlights
// ---------------------------------------------------------------------------

clearBtn.addEventListener('click', async () => {
  try {
    await chrome.tabs.sendMessage(activeTabId, { type: 'CLEAR_HIGHLIGHTS' });
  } catch { /* ignore */ }
  document.querySelectorAll('.xpath-card').forEach(c => c.classList.remove('active'));
  currentHighlightedCard = null;
});

// ---------------------------------------------------------------------------
// Picker mode
// ---------------------------------------------------------------------------

pickerBtn.addEventListener('click', async () => {
  if (!apiKey) {
    showStatus('Please save your API key first.', 'error');
    settingsPanel.classList.remove('hidden');
    return;
  }

  try {
    // Ping to check content script is ready
    await chrome.tabs.sendMessage(activeTabId, { type: 'PING' });
  } catch {
    showStatus('Cannot access this page. Try a regular website.', 'error');
    return;
  }

  await chrome.tabs.sendMessage(activeTabId, { type: 'ENTER_PICKER_MODE', apiKey });
  // Close popup so user can interact with the page
  // The floating panel in content.js takes over from here
  window.close();
});

// ---------------------------------------------------------------------------
// UI helpers
// ---------------------------------------------------------------------------

function setLoading(loading) {
  generateBtn.disabled = loading;
  generateBtn.innerHTML = loading
    ? `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="animation:spin 0.8s linear infinite"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg> Working...`
    : `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="5" y1="12" x2="19" y2="12"></line><polyline points="12 5 19 12 12 19"></polyline></svg> Generate`;
}

function showStatus(msg, type = '') {
  statusBar.textContent = msg;
  statusBar.className = type;
  statusBar.classList.remove('hidden');
}

function clearStatus() {
  statusBar.classList.add('hidden');
  statusBar.textContent = '';
  statusBar.className = '';
}

function clearResults() {
  resultsContainer.classList.add('hidden');
  resultsList.innerHTML = '';
  currentHighlightedCard = null;
}

function escapeHTML(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Inject spinner keyframe via style tag (CSP-safe, no inline styles in HTML)
const style = document.createElement('style');
style.textContent = '@keyframes spin { to { transform: rotate(360deg); } }';
document.head.appendChild(style);
