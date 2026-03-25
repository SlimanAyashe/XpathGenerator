/**
 * Content script — runs in every page context.
 *
 * Handles:
 *   HIGHLIGHT          – apply XPath highlight on page
 *   CLEAR_HIGHLIGHTS   – remove all highlights
 *   ENTER_PICKER_MODE  – show badge, start hover/click capture
 *   EXIT_PICKER_MODE   – clean up picker mode
 *   HIGHLIGHT_CHAIN_INDEX – highlight the Nth ancestor from last picker selection
 *   PING               – readiness check
 */

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let pickerActive     = false;
let hoveredEl        = null;
let highlightedEls   = [];
let overlayEls       = []; // position:absolute overlay divs for replaced elements (img/video)
let pickerChainEls   = []; // DOM element refs for each ancestor (index 0 = clicked)
let pickerBadge      = null;

// Tags that are "replaced elements" — background-color is invisible on them
// and outline can be clipped by parent overflow:hidden.
// We inject a positioned overlay div instead.
const REPLACED_TAGS = new Set(['IMG', 'VIDEO', 'CANVAS', 'IFRAME', 'EMBED', 'OBJECT']);

// ---------------------------------------------------------------------------
// Message handler
// ---------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  switch (msg.type) {
    case 'PING':
      sendResponse({ ok: true });
      break;

    case 'HIGHLIGHT':
      clearHighlights();
      sendResponse({ matchCount: applyHighlight(msg.xpath) });
      break;

    case 'CLEAR_HIGHLIGHTS':
      clearHighlights();
      sendResponse({ ok: true });
      break;

    case 'ENTER_PICKER_MODE':
      enterPickerMode();
      sendResponse({ ok: true });
      break;

    case 'EXIT_PICKER_MODE':
      exitPickerMode();
      sendResponse({ ok: true });
      break;

    case 'HIGHLIGHT_CHAIN_INDEX': {
      clearHighlights();
      const el = pickerChainEls[msg.index];
      if (el) {
        if (REPLACED_TAGS.has(el.tagName)) {
          const ov = createOverlay(el);
          if (ov) overlayEls.push(ov);
        } else {
          el.classList.add('xpg-highlight');
          highlightedEls = [el];
        }
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
      sendResponse({ ok: true });
      break;
    }
  }
  return true;
});

// ---------------------------------------------------------------------------
// Highlight
// ---------------------------------------------------------------------------

function clearHighlights() {
  highlightedEls.forEach(el => el.classList.remove('xpg-highlight'));
  highlightedEls = [];
  overlayEls.forEach(el => el.remove());
  overlayEls = [];
}

function applyHighlight(xpath) {
  clearHighlights();
  try {
    const snap = document.evaluate(
      xpath, document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null
    );
    for (let i = 0; i < snap.snapshotLength; i++) {
      const node = snap.snapshotItem(i);
      if (node.nodeType !== Node.ELEMENT_NODE) continue;

      if (REPLACED_TAGS.has(node.tagName)) {
        // Replaced elements (img, video…): inject an absolutely-positioned
        // overlay div so parent overflow:hidden can't clip our highlight.
        const overlay = createOverlay(node);
        if (overlay) overlayEls.push(overlay);
      } else {
        node.classList.add('xpg-highlight');
        highlightedEls.push(node);
      }

      if (i === 0) node.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  } catch { /* invalid xpath */ }
  return highlightedEls.length + overlayEls.length;
}

/**
 * Inject a highlight overlay div positioned over a replaced element.
 * Uses position:absolute with document-relative coords so it is unaffected
 * by parent overflow:hidden and stays correct when the page scrolls.
 */
function createOverlay(el) {
  const rect = el.getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0) return null;

  const scrollX = window.scrollX || window.pageXOffset;
  const scrollY = window.scrollY || window.pageYOffset;

  const div = document.createElement('div');
  div.className = 'xpg-img-overlay';
  div.style.cssText = [
    'position:absolute',
    `top:${rect.top + scrollY}px`,
    `left:${rect.left + scrollX}px`,
    `width:${rect.width}px`,
    `height:${rect.height}px`,
    'box-sizing:border-box',
    'border:3px solid #6366f1',
    'background:rgba(99,102,241,0.18)',
    'border-radius:3px',
    'pointer-events:none',
    'z-index:2147483646',
  ].join(';');

  document.body.appendChild(div);
  return div;
}

// ---------------------------------------------------------------------------
// Picker mode
// ---------------------------------------------------------------------------

function enterPickerMode() {
  if (pickerActive) return;
  pickerActive = true;
  showPickerBadge('Click any element — Esc to cancel');
  document.addEventListener('mouseover', onHover,   true);
  document.addEventListener('click',     onClick,   true);
  document.addEventListener('keydown',   onKeydown, true);
}

function exitPickerMode() {
  if (!pickerActive) return;
  pickerActive = false;
  document.removeEventListener('mouseover', onHover,   true);
  document.removeEventListener('click',     onClick,   true);
  document.removeEventListener('keydown',   onKeydown, true);
  if (hoveredEl) { hoveredEl.classList.remove('xpg-hover'); hoveredEl = null; }
  removePickerBadge();
  clearHighlights();
}

function onKeydown(e) {
  if (e.key === 'Escape') exitPickerMode();
}

function onHover(e) {
  const el = e.target;
  if (isBadge(el)) return;
  if (el === hoveredEl) return;
  if (hoveredEl) hoveredEl.classList.remove('xpg-hover');
  hoveredEl = el;
  hoveredEl.classList.add('xpg-hover');
}

function onClick(e) {
  if (isBadge(e.target)) return;
  e.preventDefault();
  e.stopPropagation();

  // Stop hover tracking
  document.removeEventListener('mouseover', onHover, true);
  document.removeEventListener('click',     onClick, true);
  if (hoveredEl) { hoveredEl.classList.remove('xpg-hover'); hoveredEl = null; }

  const target = e.target;

  // Build ancestor chain (index 0 = clicked element)
  pickerChainEls = buildChainElements(target);

  // Highlight the clicked element
  clearHighlights();
  pickerChainEls[0].classList.add('xpg-highlight');
  highlightedEls = [pickerChainEls[0]];

  // Build serialisable chain data (no DOM refs — safe to post)
  const chain = pickerChainEls.map(el => ({
    label:              elementLabel(el),
    outerHTML:          el.outerHTML.substring(0, 2000),
    elementInfo:        collectElementInfo(el),
    algorithmicXPaths:  generateAlgorithmicXPaths(el),
  }));

  updatePickerBadge('Element captured — see side panel');

  // Notify side panel
  chrome.runtime.sendMessage({ type: 'ELEMENT_SELECTED', chain }, () => {
    if (chrome.runtime.lastError) {
      // Panel not open — user can reopen it; picker badge stays as reminder
    }
  });
}

// ---------------------------------------------------------------------------
// Ancestor chain helpers
// ---------------------------------------------------------------------------

function buildChainElements(el) {
  const chain = [];
  let current = el;
  while (current && current.tagName && current !== document.documentElement && chain.length < 8) {
    chain.push(current);
    current = current.parentElement;
  }
  return chain;
}

function elementLabel(el) {
  const tag = el.tagName.toLowerCase();
  if (el.id)                return `${tag}#${el.id}`;
  const cls = [...el.classList]
    .filter(c => c.length > 2 && !/^(d-|p-|m-|col-|row|flex|text-|bg-)/.test(c))
    .slice(0, 2)
    .join('.');
  return cls ? `${tag}.${cls}` : tag;
}

function collectElementInfo(el) {
  const attrs = {};
  for (const a of el.attributes) attrs[a.name] = a.value;
  return {
    tag:          el.tagName.toLowerCase(),
    id:           el.id || null,
    classes:      [...el.classList],
    attributes:   attrs,
    textContent:  el.textContent.trim().substring(0, 100),
    parentTag:    el.parentElement?.tagName?.toLowerCase() || null,
    parentClasses:[...(el.parentElement?.classList || [])],
  };
}

// ---------------------------------------------------------------------------
// Algorithmic XPath generator
// ---------------------------------------------------------------------------

const UTILITY_RE = /^(d-|p-|m-|col-|row|flex|text-|bg-|is-|has-|js-)./;

function generateAlgorithmicXPaths(el) {
  const results = [];
  const tag = el.tagName.toLowerCase();

  // 1. ID
  if (el.id && /^[a-zA-Z]/.test(el.id)) {
    results.push({
      xpath:       `//${tag}[@id='${el.id}']`,
      explanation: 'Unique element ID — most stable selector',
      confidence:  'high',
    });
  }

  // 2. data-* attributes
  for (const a of el.attributes) {
    if (a.name.startsWith('data-') && a.value && a.value.length < 80) {
      results.push({
        xpath:       `//${tag}[@${a.name}='${CSS.escape ? a.value : a.value.replace(/'/g, "\\'")}']`,
        explanation: `data-* attribute — designed for programmatic access`,
        confidence:  'high',
      });
      break;
    }
  }

  // 3. ARIA
  const role = el.getAttribute('role');
  if (role) {
    results.push({
      xpath:       `//${tag}[@role='${role}']`,
      explanation: 'ARIA role — semantic and accessibility-oriented',
      confidence:  'medium',
    });
  }

  // 4. Class names
  const goodClasses = [...el.classList].filter(c => c.length > 3 && !UTILITY_RE.test(c));
  if (goodClasses.length >= 1) {
    results.push({
      xpath:       `//${tag}[contains(@class,'${goodClasses[0]}')]`,
      explanation: `CSS class '${goodClasses[0]}'`,
      confidence:  'medium',
    });
  }
  if (goodClasses.length >= 2) {
    results.push({
      xpath:       `//${tag}[contains(@class,'${goodClasses[0]}') and contains(@class,'${goodClasses[1]}')]`,
      explanation: `Two-class combination for extra specificity`,
      confidence:  'medium',
    });
  }

  // 5. Parent + tag
  const parent = el.parentElement;
  if (parent) {
    const pc = [...parent.classList].find(c => c.length > 3 && !UTILITY_RE.test(c));
    if (pc) {
      results.push({
        xpath:       `//*[contains(@class,'${pc}')]/${tag}`,
        explanation: `${tag} inside parent with class '${pc}'`,
        confidence:  'medium',
      });
    }
  }

  // 6. Short text content
  const text = el.textContent.trim();
  if (text && text.length > 2 && text.length < 40 && !text.includes('\n')) {
    results.push({
      xpath:       `//${tag}[normalize-space(text())='${text.replace(/'/g, "&apos;")}']`,
      explanation: 'Exact text content match',
      confidence:  'low',
    });
  }

  return results.slice(0, 5);
}

// ---------------------------------------------------------------------------
// Picker badge (minimal floating indicator)
// ---------------------------------------------------------------------------

function showPickerBadge(text) {
  removePickerBadge();
  pickerBadge = document.createElement('div');
  pickerBadge.id = 'xpg-picker-badge';
  pickerBadge.innerHTML = `
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor"
         stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <path d="M3 3l7.07 16.97 2.51-7.39 7.39-2.51L3 3z"/><path d="M13 13l6 6"/>
    </svg>
    <span class="xpg-badge-text">${text}</span>
    <button class="xpg-badge-close" title="Cancel">✕</button>`;
  pickerBadge.querySelector('.xpg-badge-close').addEventListener('click', exitPickerMode);
  document.body.appendChild(pickerBadge);
}

function updatePickerBadge(text) {
  if (pickerBadge) {
    pickerBadge.querySelector('.xpg-badge-text').textContent = text;
  }
}

function removePickerBadge() {
  if (pickerBadge) { pickerBadge.remove(); pickerBadge = null; }
}

function isBadge(el) {
  return pickerBadge && pickerBadge.contains(el);
}
