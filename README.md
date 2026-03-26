# AI XPath Generator

An AI-powered XPath discovery tool built in two independent parts: a **Chrome extension** for interactive in-browser use, and a **Python agent** for fully autonomous discovery via a Streamlit UI. Both use Google Gemini to generate robust, semantic XPaths for any website.

---

## What It Does

Given any news article page, this tool automatically finds reliable XPath expressions for:

- **Title** — the article headline
- **Author** — the byline
- **Date** — the publication date
- **Subtitle** — the article subheading
- **Link** — the URL to the full article

XPaths are generated using AI, then **verified against the real DOM** — so you always see actual match counts, never AI estimates.

---

## Components

### Chrome Extension

An interactive side panel that works directly in the browser.

**Two modes:**

**Natural Language** — describe what you want, get ranked XPaths with live highlights.
1. Type `"article author"` and click Generate
2. The extension grabs the live DOM, strips noise, and sends it to Gemini
3. Gemini writes XPaths; the extension runs each through `document.evaluate()` for real match counts
4. Results appear highlighted on the page — hover any card to switch the highlight

**Click-to-Pick** — click any element on the page for instant results.
1. Click the crosshair button and click any element on the page
2. An algorithmic generator (no API call) produces up to 5 candidates **instantly**, prioritising `@id` → `data-*` → ARIA roles → class names → text content
3. A Gemini call runs in the background and silently refines the results ~1 second later

**Additional features:**
- Inline XPath editing with live re-highlight (400ms debounce)
- Match count shown on every card
- Query history (last 10, searchable, stored locally)
- One-click JSON export
- Keyboard shortcut: `Alt+Shift+X`

---

### Python Agent (Streamlit UI)

A fully autonomous ReAct agent that discovers XPaths without any human interaction.

```
URL → fetch & clean HTML → AI agent loop → verified JSON output
```

The agent uses a **ReAct (Reason + Act) loop**: it cannot read the HTML directly — it can only call an `evaluate_xpath` tool, observe the results, and decide what to query next. This mirrors how an expert would approach the problem: form a hypothesis, test it, refine.

**Example agent behaviour:**
```
Agent:  evaluate_xpath("//*[contains(@class, 'author')]")
Tool:   Found 23 elements. Snippets: <span class="author-name">...
Agent:  Too broad. Narrowing to article context.
Agent:  evaluate_xpath("//article//span[contains(@class,'author-name')]")
Tool:   Found 8 elements. <span class="author-name">John Smith</span>...
Agent:  Consistent with article count. Verifying.
Agent:  evaluate_xpath("//span[@class='author-name']")
Tool:   Found 8 elements. ✓ Confirmed.
```

Each XPath is then scored 0–100 by an algorithmic robustness scorer that rewards semantic attributes (`@id`, `data-*`, ARIA roles) and penalises positional indexes and deep absolute paths.

---

## Repository Structure

```
├── extension/              # Chrome Extension (Manifest V3)
│   ├── manifest.json
│   ├── panel.html / panel.js   # Side panel UI
│   ├── content.js              # DOM interaction, picker mode, highlighting
│   ├── background.js           # Service worker, message relay
│   └── content.css
│
├── src/                    # Python backend
│   ├── agent.py            # XPathAgent — Gemini ReAct loop
│   ├── fetcher.py          # URL fetcher + DOM cleaner (lxml)
│   ├── xpath_evaluator.py  # XPath tool used by the agent
│   └── scorer.py           # Algorithmic robustness scorer (0–100)
│
├── app.py                  # Streamlit UI
├── requirements.txt
└── test-data/              # Saved HTML files for agent to query
```

---

## Getting Started

### Chrome Extension

1. Open Chrome and go to `chrome://extensions`
2. Enable **Developer mode** (top right)
3. Click **Load unpacked** and select the `extension/` folder
4. Open any website and press `Alt+Shift+X` (or click the toolbar icon)
5. Enter your Gemini API key in the settings panel (gear icon)

> Your API key is stored in `chrome.storage.local` and only sent directly to Google's Gemini API over HTTPS.

---

### Python Agent (Streamlit UI)

**Requirements:** Python 3.10+

```bash
# Install dependencies
pip install -r requirements.txt

# Set your Gemini API key
export GOOGLE_API_KEY=your_key_here   # or add to a .env file

# Run the app
streamlit run app.py
```

Enter a URL in the sidebar, click **Run Agent**, and watch the agent work through the page in real time. Results appear as expandable cards with XPath, match count, example text, and robustness score.

---

## How XPath Robustness Is Scored

Every XPath produced by the Python agent is scored algorithmically (0–100):

| Signal | Effect | Reason |
|---|---|---|
| Uses `@id` | +10 | Most stable identifier |
| Uses `data-*` attribute | +8 | Designed for programmatic access, survives redesigns |
| Uses `@role` / `aria-*` | +8 | Tied to semantic intent, not visual design |
| Uses `contains(@class,...)` | +5 | Partial match tolerates class list additions |
| Concise path (≤ 4 steps) | +5 | Fewer points of failure |
| Positional index `[1]`, `[2]` | −10 each | Breaks when sibling order changes |
| Deep absolute path (> 3 direct steps) | −5 to −20 | Breaks when wrapper divs are added |
| Bare `//*` with no filter | −10 | Too broad |

Baseline starts at 70. Score is clamped to 0–100.

---

## Tech Stack

| Component | Technology |
|---|---|
| AI model | Google Gemini (`gemini-3.1-pro-preview`) |
| Extension | Chrome Manifest V3, vanilla JS |
| Python agent | `google-genai` SDK, ReAct tool-calling loop |
| HTML parsing | `lxml` |
| XPath evaluation | `lxml` (Python) / `document.evaluate()` (browser) |
| UI | Streamlit |

---

## Design Decisions

**The AI writes; the code verifies.** Gemini generates XPath candidates, but every candidate is run through the real XPath engine before being shown. If an XPath matches 0 elements, that's immediately visible.

**The extension needs no backend.** The Gemini API is called directly from the browser (Gemini supports CORS), so the extension works with zero infrastructure — no server, no proxy.

**The agent cannot read the HTML.** The system prompt forbids direct file access. The agent can only call `evaluate_xpath()`, which forces it to reason iteratively from evidence rather than pattern-matching the raw source.

**Context is managed deliberately.** The DOM cleaner strips scripts, styles, SVGs, and hidden elements before anything touches the AI. Tool results are truncated to 4,000 characters. The agent sees at most 5 element snippets per query.

---

## API Key

Both components require a Google Gemini API key.

- Get one at [Google AI Studio](https://aistudio.google.com)
- For the extension: enter it in the settings panel — stored locally in `chrome.storage.local`
- For the Python backend: set `GOOGLE_API_KEY` in your environment or a `.env` file

---

## License

MIT
