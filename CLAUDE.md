# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Running the App

```bash
# Install dependencies
pip install -r requirements.txt

# Run the Streamlit UI
streamlit run app.py
```

Set `GOOGLE_API_KEY` in the environment (or `.env`) before running. The UI also accepts the key via a sidebar input.

## Architecture

This project has two independent components that share the same XPath evaluation logic:

### 1. Python Backend (`src/` + `app.py`)

A Streamlit web app that implements a **ReAct tool-calling agent** for autonomous XPath discovery:

- **`app.py`** — Streamlit UI. Orchestrates the pipeline: fetch → clean → run agent → display results.
- **`src/fetcher.py`** — Downloads a URL and strips non-semantic noise (scripts, styles, SVGs, hidden elements) via `lxml`, producing a smaller, cleaner HTML for the agent to work with. Saved to `test-data/page.html`.
- **`src/agent.py`** — `XPathAgent` class. Drives a Gemini model (`gemini-3.1-pro-preview`) in a multi-turn loop. The agent is forbidden from reading the HTML directly; it can only call the `evaluate_xpath` tool. Continues until the model stops calling tools (max 40 turns), then parses the final JSON array from the last model message.
- **`src/xpath_evaluator.py`** — The tool the agent calls. Takes `(html_path, xpath_expr)` and returns `XPathResult` with exit code (0=found, 1=no matches, 2=error), match count, and outer-HTML snippets of the first 5 hits. Also exposes `evaluate_xpath_from_string` for in-memory HTML.
- **`src/scorer.py`** — `score_xpath(xpath)` scores an XPath 0–100 algorithmically. Starts at 70; adds bonuses for `@id`, `data-*`, ARIA attributes, `contains(@class,...)`, text matching, and conciseness; penalises positional indexes and deep absolute paths.

**Target fields**: Title, Author, Date, Subtitle, Link (defined as `TARGET_FIELDS` in `agent.py`).

**Context management**: Tool results are truncated to 4 000 chars before being appended to the conversation to keep token usage manageable.

### 2. Chrome Extension (`extension/`)

A companion browser extension (Manifest V3) that lets users generate XPaths in-browser:

- Opens as a **side panel** (`panel.html` / `panel.js`) triggered by `Alt+Shift+X` or the toolbar icon.
- `content.js` — injected into every page; handles element highlighting and click-to-pick mode.
- `background.js` — service worker; relays messages between the panel and content script.
- Calls the Gemini API directly from the browser (key stored in extension storage).

The extension and the Python backend are independent — they do not communicate with each other.

### Custom Skill

`.claude/skills/xpath-testing.md` defines an `/xpath-testing` skill for interactively testing XPath expressions against files in `test-data/` using the CLI tool at `.claude/skills/xpath-testing/xpath-query.ts` (requires `bun`). The agent system prompt in `src/agent.py` was derived from this skill's workflow and cheat sheet.
