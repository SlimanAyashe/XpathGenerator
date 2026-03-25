/**
 * Background service worker.
 * Handles Gemini API calls for both natural-language and element-picker modes.
 */

// Open side panel when user clicks the extension icon (or uses Alt+Shift+X)
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});

const GEMINI_MODEL = 'gemini-3.1-pro-preview';
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

// ---------------------------------------------------------------------------
// Message dispatcher
// ---------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'GENERATE_XPATHS') {
    handleGenerate(msg).then(sendResponse).catch(err => sendResponse({ error: err.message }));
    return true; // keep channel open for async response
  }
  if (msg.type === 'REFINE_ELEMENT_XPATHS') {
    handleRefineElement(msg).then(sendResponse).catch(err => sendResponse({ error: err.message }));
    return true;
  }
});

// ---------------------------------------------------------------------------
// Natural-language → XPath generation
// ---------------------------------------------------------------------------

async function handleGenerate({ goal, apiKey }) {
  const tab = await getActiveTab();
  const html = await getDOMFromTab(tab.id);
  const xpaths = await callGemini(buildNLPrompt(goal, html), apiKey);
  return { xpaths };
}

function buildNLPrompt(goal, html) {
  return `You are an expert web scraping engineer. \
Given the HTML of a page and a natural language description of what to extract, \
generate 3-5 robust XPath expressions sorted from most to least robust.

## Rules
- Prefer semantic attributes: contains(@class,'x'), @role, @data-*, @aria-label, @href
- AVOID positional indexes like [1] or [last()] unless no other option exists
- Each XPath should match the same element once per article/listing item on the page
- Test your logic mentally: would this XPath survive a minor HTML restructure?

## HTML (may be truncated to 100 000 chars):
${html.substring(0, 100000)}

## Natural language goal: "${goal}"

Respond with ONLY a valid JSON array — no markdown fences, no prose:
[
  {"xpath": "//...", "explanation": "one-line reason", "confidence": "high|medium|low"},
  ...
]`;
}

// ---------------------------------------------------------------------------
// Element-picker XPath refinement via Gemini
// ---------------------------------------------------------------------------

async function handleRefineElement({ elementInfo, outerHTML, apiKey }) {
  const xpaths = await callGemini(buildElementPrompt(elementInfo, outerHTML), apiKey);
  return { xpaths };
}

function buildElementPrompt(elementInfo, outerHTML) {
  return `You are an expert web scraping engineer. \
A user clicked on the following HTML element and wants robust XPath expressions to find it \
(and similar sibling elements) on the page.

## Clicked element outer HTML:
${outerHTML.substring(0, 3000)}

## Element metadata:
${JSON.stringify(elementInfo, null, 2)}

Generate 3-5 XPath expressions ranked from most to least robust. \
Prefer expressions that would match all similar items in a list (e.g., all article titles), \
not just this one specific element.

Respond with ONLY a valid JSON array — no markdown fences, no prose:
[
  {"xpath": "//...", "explanation": "one-line reason", "confidence": "high|medium|low"},
  ...
]`;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) throw new Error('No active tab found');
  return tab;
}

async function getDOMFromTab(tabId) {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => {
      const clone = document.documentElement.cloneNode(true);
      // Strip non-semantic noise
      ['script', 'style', 'svg', 'noscript', 'iframe', 'link', 'meta'].forEach(tag =>
        clone.querySelectorAll(tag).forEach(el => el.remove())
      );
      // Strip hidden elements
      clone.querySelectorAll('[hidden]').forEach(el => el.remove());
      // Strip inline styles and event attributes to reduce token count
      clone.querySelectorAll('[style]').forEach(el => el.removeAttribute('style'));
      ['onclick','onload','onerror','onmouseover'].forEach(ev =>
        clone.querySelectorAll(`[${ev}]`).forEach(el => el.removeAttribute(ev))
      );
      return clone.outerHTML;
    }
  });
  return results[0].result;
}

async function callGemini(prompt, apiKey) {
  const resp = await fetch(`${GEMINI_URL}?key=${apiKey}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.2, maxOutputTokens: 8192 }
    })
  });

  if (!resp.ok) {
    const body = await resp.json().catch(() => ({}));
    throw new Error(body.error?.message || `Gemini API error ${resp.status}`);
  }

  const data = await resp.json();
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text ?? '';

  return extractJsonArray(text);
}

/**
 * Robustly extract a JSON array from Gemini's response text.
 *
 * Handles:
 *  - Markdown code fences (```json ... ```)
 *  - Greedy bracket matching (finds outermost [ ... ])
 *  - Partial / truncated responses (salvages complete objects)
 */
function extractJsonArray(text) {
  // Strip markdown code fences
  const cleaned = text.replace(/```(?:json)?\s*/gi, '').replace(/```/g, '').trim();

  // Find outermost array: first '[' to last ']'
  // NOTE: must NOT use a lazy regex here — XPath expressions contain ']'
  // which would cause a lazy match to terminate inside the XPath string.
  const start = cleaned.indexOf('[');
  const end = cleaned.lastIndexOf(']');

  if (start === -1 || end === -1 || end <= start) {
    throw new Error('Gemini did not return a JSON array.\n\nRaw response:\n' + text.substring(0, 500));
  }

  const jsonStr = cleaned.slice(start, end + 1);

  try {
    return JSON.parse(jsonStr);
  } catch {
    // Response may have been truncated mid-stream — salvage any complete objects
    const salvaged = salvageObjects(jsonStr);
    if (salvaged.length > 0) return salvaged;
    throw new Error('Could not parse Gemini response as JSON. Raw:\n' + jsonStr.substring(0, 400));
  }
}

/**
 * Last-resort parser: extract any valid {xpath, explanation, confidence}
 * objects from a malformed JSON string.
 */
function salvageObjects(jsonStr) {
  const results = [];
  // Walk through and find each top-level { ... } block
  let depth = 0, start = -1;
  for (let i = 0; i < jsonStr.length; i++) {
    const ch = jsonStr[i];
    // Skip characters inside strings
    if (ch === '"') {
      i++;
      while (i < jsonStr.length && jsonStr[i] !== '"') {
        if (jsonStr[i] === '\\') i++; // skip escaped char
        i++;
      }
      continue;
    }
    if (ch === '{') { if (depth === 0) start = i; depth++; }
    if (ch === '}') {
      depth--;
      if (depth === 0 && start !== -1) {
        try {
          const obj = JSON.parse(jsonStr.slice(start, i + 1));
          if (obj.xpath) results.push(obj);
        } catch { /* skip malformed object */ }
        start = -1;
      }
    }
  }
  return results;
}
