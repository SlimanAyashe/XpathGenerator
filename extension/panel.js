/**
 * Side panel script — all UI features.
 *
 * Features:
 *  1. Natural language → XPath generation (Gemini)
 *  2. Side panel stays open (no popup-close problem)
 *  3. Copy button per card
 *  4. Persistent results (chrome.storage.session)
 *  5. Element tree breadcrumb (picker mode)
 *  6. Hover-to-preview highlight
 *  7. Inline XPath editor (contenteditable, live re-highlight)
 *  8. Query history (chrome.storage.local, last 10)
 *  9. Export all as JSON
 * 10. Keyboard shortcut (Alt+Shift+X via manifest)
 */

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let apiKey       = '';
let currentXPaths = [];  // [{xpath, explanation, confidence}]
let activeXPath   = null; // the "committed" (clicked) highlight
let pickerMode    = false;
let pickerChain   = [];   // [{label, outerHTML, elementInfo, algorithmicXPaths}]
let pickerChainIndex = 0;

// ---------------------------------------------------------------------------
// DOM refs
// ---------------------------------------------------------------------------

const settingsToggle   = document.getElementById('settings-toggle');
const settingsSection  = document.getElementById('settings-section');
const apiKeyInput      = document.getElementById('api-key-input');
const saveKeyBtn       = document.getElementById('save-key-btn');
const goalInput        = document.getElementById('goal-input');
const generateBtn      = document.getElementById('generate-btn');
const statusBar        = document.getElementById('status-bar');
const pickerBanner     = document.getElementById('picker-banner');
const cancelPickerBtn  = document.getElementById('cancel-picker-btn');
const breadcrumbSection= document.getElementById('breadcrumb-section');
const breadcrumbEl     = document.getElementById('breadcrumb');
const resultsSection   = document.getElementById('results-section');
const resultsList      = document.getElementById('results-list');
const resultsLabel     = document.getElementById('results-label');
const exportBtn        = document.getElementById('export-btn');
const clearBtn         = document.getElementById('clear-btn');
const pickerBtn        = document.getElementById('picker-btn');
const historyToggle    = document.getElementById('history-toggle');
const historyList      = document.getElementById('history-list');
const historyCount     = document.getElementById('history-count');
const toastContainer   = document.getElementById('toast-container');

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

async function init() {
  const stored = await chrome.storage.local.get('apiKey');
  if (stored.apiKey) {
    apiKey = stored.apiKey;
    apiKeyInput.value = apiKey;
  } else {
    settingsSection.classList.remove('hidden');
  }

  await loadPersistedResults();
  await refreshHistory();
}

init();

// ---------------------------------------------------------------------------
// Runtime messages (from content script)
// ---------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'ELEMENT_SELECTED') {
    handleElementSelected(msg.chain);
  }
});

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

settingsToggle.addEventListener('click', () => {
  settingsSection.classList.toggle('hidden');
});

saveKeyBtn.addEventListener('click', () => {
  apiKey = apiKeyInput.value.trim();
  if (!apiKey) return;
  chrome.storage.local.set({ apiKey });
  settingsSection.classList.add('hidden');
  showToast('API key saved', 'success');
});

apiKeyInput.addEventListener('keydown', e => { if (e.key === 'Enter') saveKeyBtn.click(); });

// ---------------------------------------------------------------------------
// Natural-language generation
// ---------------------------------------------------------------------------

generateBtn.addEventListener('click', runGenerate);
goalInput.addEventListener('keydown', e => { if (e.key === 'Enter') runGenerate(); });

async function runGenerate() {
  const goal = goalInput.value.trim();
  if (!goal) { goalInput.focus(); return; }
  if (!apiKey) {
    showStatus('Add your API key first (gear icon).', 'error');
    settingsSection.classList.remove('hidden');
    return;
  }

  exitPickerModeUI();
  setLoading(true);
  clearResults();
  showStatus('Fetching page DOM and calling Gemini…');

  try {
    const resp = await chrome.runtime.sendMessage({ type: 'GENERATE_XPATHS', goal, apiKey });
    if (resp?.error) throw new Error(resp.error);
    await renderResults(resp.xpaths, `"${goal}"`);
    await saveToHistory(goal, resp.xpaths);
    await refreshHistory();
    await persistResults(resp.xpaths, goal);
    clearStatus();
  } catch (err) {
    showStatus(err.message, 'error');
  } finally {
    setLoading(false);
  }
}

// ---------------------------------------------------------------------------
// Render results
// ---------------------------------------------------------------------------

async function renderResults(xpaths, label) {
  currentXPaths = xpaths || [];
  activeXPath   = null;

  if (!currentXPaths.length) {
    showStatus('No XPaths returned. Try rephrasing.', 'error');
    return;
  }

  resultsLabel.textContent = `${currentXPaths.length} XPath${currentXPaths.length !== 1 ? 's' : ''} for ${label}`;
  resultsList.innerHTML = '';
  resultsSection.classList.remove('hidden');

  for (let i = 0; i < currentXPaths.length; i++) {
    const item = currentXPaths[i];
    const card = createCard(item, i === 0);
    resultsList.appendChild(card);
    // Auto-highlight first card
    if (i === 0) await commitHighlight(item.xpath, card);
  }
}

function createCard(item, isFirst = false) {
  const card = document.createElement('div');
  card.className = 'xpath-card' + (isFirst ? ' active' : '');

  const conf = (item.confidence || 'medium').toLowerCase();

  // ── Editable XPath text ──
  const xpathEdit = document.createElement('code');
  xpathEdit.className = 'xpath-edit';
  xpathEdit.contentEditable = 'true';
  xpathEdit.spellcheck = false;
  xpathEdit.textContent = item.xpath;

  // Prevent newlines on Enter
  xpathEdit.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); xpathEdit.blur(); }
  });
  // Strip formatting on paste
  xpathEdit.addEventListener('paste', e => {
    e.preventDefault();
    const text = e.clipboardData.getData('text/plain').trim();
    document.execCommand('insertText', false, text);
  });
  // Live re-highlight on edit
  xpathEdit.addEventListener('input', debounce(async () => {
    const xpath = xpathEdit.textContent.trim();
    if (!xpath) return;
    item.xpath = xpath; // update in place
    const resp = await sendToContent({ type: 'HIGHLIGHT', xpath });
    if (resp && matchCountEl) {
      matchCountEl.textContent = fmtMatches(resp.matchCount);
    }
  }, 400));

  // ── Copy button ──
  const copyBtn = document.createElement('button');
  copyBtn.className = 'btn-copy';
  copyBtn.title = 'Copy XPath';
  copyBtn.innerHTML = iconCopy();
  copyBtn.addEventListener('click', async (e) => {
    e.stopPropagation();
    await navigator.clipboard.writeText(xpathEdit.textContent.trim());
    copyBtn.innerHTML = iconCheck();
    copyBtn.classList.add('copied');
    setTimeout(() => {
      copyBtn.innerHTML = iconCopy();
      copyBtn.classList.remove('copied');
    }, 1500);
  });

  const cardTop = document.createElement('div');
  cardTop.className = 'card-top';
  cardTop.appendChild(xpathEdit);
  cardTop.appendChild(copyBtn);

  // ── Footer ──
  const matchCountEl = document.createElement('span');
  matchCountEl.className = 'match-count';
  matchCountEl.textContent = '…';

  const cardFooter = document.createElement('div');
  cardFooter.className = 'card-footer';
  cardFooter.innerHTML = `<span class="badge badge-${conf}">${conf}</span>`;
  cardFooter.appendChild(matchCountEl);
  if (item.explanation) {
    const exp = document.createElement('span');
    exp.className = 'explanation';
    exp.textContent = item.explanation;
    cardFooter.appendChild(exp);
  }

  card.appendChild(cardTop);
  card.appendChild(cardFooter);

  // Populate match count async (don't block render)
  sendToContent({ type: 'HIGHLIGHT', xpath: item.xpath }).then(resp => {
    if (resp) matchCountEl.textContent = fmtMatches(resp.matchCount);
  });

  // ── Hover-to-preview ──
  card.addEventListener('mouseenter', async () => {
    await sendToContent({ type: 'HIGHLIGHT', xpath: xpathEdit.textContent.trim() });
  });
  card.addEventListener('mouseleave', async () => {
    if (activeXPath) {
      await sendToContent({ type: 'HIGHLIGHT', xpath: activeXPath });
    } else {
      await sendToContent({ type: 'CLEAR_HIGHLIGHTS' });
    }
  });

  // ── Click to commit highlight ──
  card.addEventListener('click', async (e) => {
    if (e.target === xpathEdit || e.target === copyBtn) return;
    await commitHighlight(xpathEdit.textContent.trim(), card);
    const resp = await sendToContent({ type: 'HIGHLIGHT', xpath: xpathEdit.textContent.trim() });
    if (resp) matchCountEl.textContent = fmtMatches(resp.matchCount);
  });

  return card;
}

async function commitHighlight(xpath, card) {
  document.querySelectorAll('.xpath-card').forEach(c => c.classList.remove('active'));
  card.classList.add('active');
  activeXPath = xpath;
}

// ---------------------------------------------------------------------------
// Export all
// ---------------------------------------------------------------------------

exportBtn.addEventListener('click', async () => {
  if (!currentXPaths.length) return;
  const data = currentXPaths.map(x => ({
    xpath: x.xpath, confidence: x.confidence, explanation: x.explanation
  }));
  await navigator.clipboard.writeText(JSON.stringify(data, null, 2));
  showToast('Copied to clipboard as JSON', 'success');
});

// ---------------------------------------------------------------------------
// Clear highlights
// ---------------------------------------------------------------------------

clearBtn.addEventListener('click', async () => {
  await sendToContent({ type: 'CLEAR_HIGHLIGHTS' });
  document.querySelectorAll('.xpath-card').forEach(c => c.classList.remove('active'));
  activeXPath = null;
});

// ---------------------------------------------------------------------------
// Picker mode
// ---------------------------------------------------------------------------

pickerBtn.addEventListener('click', async () => {
  if (!apiKey) {
    showStatus('Add your API key first (gear icon).', 'error');
    settingsSection.classList.remove('hidden');
    return;
  }
  const ok = await sendToContent({ type: 'PING' });
  if (!ok) {
    showStatus("Can't access this page. Try a regular website.", 'error');
    return;
  }
  enterPickerModeUI();
  await sendToContent({ type: 'ENTER_PICKER_MODE' });
});

cancelPickerBtn.addEventListener('click', async () => {
  exitPickerModeUI();
  pickerChain = []; // user cancelled — discard any pending chain
  pickerChainIndex = 0;
  await sendToContent({ type: 'EXIT_PICKER_MODE' });
});

// Esc key cancels picker mode
document.addEventListener('keydown', async (e) => {
  if (e.key === 'Escape' && pickerMode) {
    exitPickerModeUI();
    pickerChain = [];
    pickerChainIndex = 0;
    await sendToContent({ type: 'EXIT_PICKER_MODE' });
  }
});

function enterPickerModeUI() {
  pickerMode = true;
  pickerBtn.classList.add('active');
  pickerBanner.classList.remove('hidden');
  breadcrumbSection.classList.add('hidden');
  clearResults();
  clearStatus();
}

function exitPickerModeUI() {
  pickerMode = false;
  pickerBtn.classList.remove('active');
  pickerBanner.classList.add('hidden');
  // NOTE: do NOT clear pickerChain here — handleElementSelected sets it
  // just before calling this, and showPickerChainResults still needs it.
  pickerChainIndex = 0;
}

// ---------------------------------------------------------------------------
// Handle element selected (from content script)
// ---------------------------------------------------------------------------

async function handleElementSelected(chain) {
  pickerChain      = chain;
  pickerChainIndex = 0;
  exitPickerModeUI(); // hides banner, cleans up picker UI state

  await showPickerChainResults(0);
}

async function showPickerChainResults(index) {
  pickerChainIndex = index;
  const item = pickerChain[index];

  // Highlight the chosen ancestor
  await sendToContent({ type: 'HIGHLIGHT_CHAIN_INDEX', index });

  // Render breadcrumb
  renderBreadcrumb(index);

  // Show algorithmic results immediately
  await renderResults(item.algorithmicXPaths, `'${item.label}' (local)`);
  showStatus('Local XPaths shown — refining with Gemini…');

  // Refine with Gemini in background
  chrome.runtime.sendMessage(
    { type: 'REFINE_ELEMENT_XPATHS', elementInfo: item.elementInfo, outerHTML: item.outerHTML, apiKey },
    async (resp) => {
      if (resp?.xpaths?.length) {
        await renderResults(resp.xpaths, `'${item.label}'`);
        await persistResults(resp.xpaths, item.label);
        clearStatus();
      } else if (resp?.error) {
        showStatus('Gemini error: ' + resp.error, 'error');
      }
    }
  );
}

function renderBreadcrumb(activeIndex) {
  breadcrumbSection.classList.remove('hidden');
  breadcrumbEl.innerHTML = '';

  pickerChain.forEach((item, i) => {
    if (i > 0) {
      const sep = document.createElement('span');
      sep.className = 'crumb-sep';
      sep.textContent = '›';
      breadcrumbEl.appendChild(sep);
    }
    const crumb = document.createElement('button');
    crumb.className = 'crumb' + (i === activeIndex ? ' active' : '');
    crumb.textContent = item.label;
    crumb.title = item.label;
    crumb.addEventListener('click', () => showPickerChainResults(i));
    breadcrumbEl.appendChild(crumb);
  });
}

// ---------------------------------------------------------------------------
// Persistent results
// ---------------------------------------------------------------------------

async function persistResults(xpaths, goal) {
  await chrome.storage.session.set({ lastResults: { xpaths, goal } });
}

async function loadPersistedResults() {
  const { lastResults } = await chrome.storage.session.get('lastResults');
  if (lastResults?.xpaths?.length) {
    await renderResults(lastResults.xpaths, `"${lastResults.goal}"`);
  }
}

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------

async function saveToHistory(goal, xpaths) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const { history: hist = [] } = await chrome.storage.local.get('history');
  hist.unshift({
    goal,
    xpaths,
    hostname: tab?.url ? safeHostname(tab.url) : '',
    ts: Date.now(),
  });
  await chrome.storage.local.set({ history: hist.slice(0, 10) });
}

async function refreshHistory() {
  const { history: hist = [] } = await chrome.storage.local.get('history');

  if (!hist.length) {
    historyCount.classList.add('hidden');
    historyList.innerHTML = '<p style="font-size:11px;color:var(--text-muted);padding:4px 0">No history yet.</p>';
    return;
  }

  historyCount.textContent = hist.length;
  historyCount.classList.remove('hidden');

  historyList.innerHTML = '';
  hist.forEach(entry => {
    const item = document.createElement('div');
    item.className = 'history-item';
    item.innerHTML = `
      <div class="history-goal">${escapeHTML(entry.goal)}</div>
      <div class="history-meta">
        <span>${escapeHTML(entry.hostname)}</span>
        <span>${relativeTime(entry.ts)}</span>
        <span>${entry.xpaths?.length || 0} xpath${entry.xpaths?.length !== 1 ? 's' : ''}</span>
      </div>`;
    item.addEventListener('click', async () => {
      goalInput.value = entry.goal;
      await renderResults(entry.xpaths, `"${entry.goal}"`);
      await persistResults(entry.xpaths, entry.goal);
      clearStatus();
      breadcrumbSection.classList.add('hidden');
    });
    historyList.appendChild(item);
  });
}

historyToggle.addEventListener('click', () => {
  const arrow = historyToggle.querySelector('.toggle-arrow');
  const isOpen = !historyList.classList.contains('hidden');
  historyList.classList.toggle('hidden', isOpen);
  arrow.classList.toggle('open', !isOpen);
});

// ---------------------------------------------------------------------------
// Content script messenger
// ---------------------------------------------------------------------------

async function sendToContent(msg) {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) return null;
    return await chrome.tabs.sendMessage(tab.id, msg);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// UI helpers
// ---------------------------------------------------------------------------

function setLoading(on) {
  generateBtn.disabled = on;
  generateBtn.innerHTML = on
    ? `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor"
          stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"
          style="animation:spin 0.8s linear infinite">
         <path d="M21 12a9 9 0 1 1-6.219-8.56"/>
       </svg> Working…`
    : `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor"
          stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
         <line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/>
       </svg> Generate`;
}

function showStatus(msg, type = '') {
  statusBar.textContent = msg;
  statusBar.className = type;
  statusBar.classList.remove('hidden');
}

function clearStatus() {
  statusBar.classList.add('hidden');
}

function clearResults() {
  resultsSection.classList.add('hidden');
  resultsList.innerHTML = '';
  currentXPaths = [];
  activeXPath   = null;
}

function showToast(msg, type = '') {
  const t = document.createElement('div');
  t.className = `toast ${type}`;
  t.textContent = msg;
  toastContainer.appendChild(t);
  requestAnimationFrame(() => t.classList.add('visible'));
  setTimeout(() => {
    t.classList.remove('visible');
    setTimeout(() => t.remove(), 300);
  }, 2200);
}

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------

function debounce(fn, ms) {
  let timer;
  return (...args) => { clearTimeout(timer); timer = setTimeout(() => fn(...args), ms); };
}

function fmtMatches(n) {
  return `${n} match${n !== 1 ? 'es' : ''}`;
}

function relativeTime(ts) {
  const d = Date.now() - ts;
  const m = Math.floor(d / 60000);
  if (m < 1)  return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(d / 3600000);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(d / 86400000)}d ago`;
}

function safeHostname(url) {
  try { return new URL(url).hostname; } catch { return ''; }
}

function escapeHTML(str) {
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function iconCopy() {
  return `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor"
    stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <rect x="9" y="9" width="13" height="13" rx="2"/>
    <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
  </svg>`;
}

function iconCheck() {
  return `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor"
    stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
    <polyline points="20 6 9 17 4 12"/>
  </svg>`;
}
