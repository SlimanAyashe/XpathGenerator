"""Streamlit UI for the Autonomous XPath Scraper Agent.

Run with:  streamlit run app.py
"""

import os
import time
import streamlit as st

from src.fetcher import fetch_and_clean, save_html
from src.agent import XPathAgent, AgentLog, TARGET_FIELDS
from src.xpath_evaluator import evaluate_xpath_from_string
from src.scorer import score_xpath

# ---------------------------------------------------------------------------
# Page config
# ---------------------------------------------------------------------------

st.set_page_config(
    page_title="AI XPath Agent",
    page_icon="🔍",
    layout="wide",
)

st.title("Autonomous XPath Scraper Agent")
st.caption("Powered by Gemini 3.1 Pro — ReAct tool-calling architecture")

# ---------------------------------------------------------------------------
# Sidebar — API key + config
# ---------------------------------------------------------------------------

with st.sidebar:
    st.header("Configuration")
    api_key = st.text_input(
        "Gemini API Key",
        type="password",
        value=os.environ.get("GOOGLE_API_KEY", ""),
        help="Get one at https://aistudio.google.com/apikey",
    )
    st.divider()
    st.header("Agent Thought Process")
    log_container = st.container(height=500)

# ---------------------------------------------------------------------------
# Main — URL input
# ---------------------------------------------------------------------------

url = st.text_input(
    "Enter a news article listing URL",
    placeholder="https://www.ynet.co.il/economy/category/429",
)

col1, col2 = st.columns([1, 4])
with col1:
    run_btn = st.button("Run Agent", type="primary", use_container_width=True)

# ---------------------------------------------------------------------------
# Run the agent
# ---------------------------------------------------------------------------

if run_btn:
    if not api_key:
        st.error("Please provide a Gemini API key in the sidebar.")
        st.stop()
    if not url:
        st.error("Please enter a URL.")
        st.stop()

    # --- Step 1: Fetch & clean ---
    with st.status("Fetching and cleaning HTML...", expanded=True) as status:
        try:
            cleaned_html = fetch_and_clean(url)
            html_path = os.path.join("test-data", "page.html")
            save_html(cleaned_html, html_path)
            html_size_kb = len(cleaned_html) / 1024
            status.update(label=f"HTML fetched and cleaned ({html_size_kb:.0f} KB)", state="complete")
        except Exception as e:
            status.update(label=f"Fetch failed: {e}", state="error")
            st.stop()

    # --- Step 2: Run the agent ---
    with st.status("Agent is discovering XPaths...", expanded=True) as status:
        agent = XPathAgent(api_key=api_key)

        # Stream logs to the sidebar
        def on_log(entry: AgentLog):
            icon = {"agent": "🤖", "tool_call": "🔧", "tool_result": "📋"}.get(entry.role, "")
            with log_container:
                if entry.role == "tool_call":
                    st.code(entry.content, language="bash")
                elif entry.role == "tool_result":
                    # Truncate long results in the UI
                    display = entry.content[:500] + "..." if len(entry.content) > 500 else entry.content
                    st.text(display)
                else:
                    st.markdown(f"{icon} {entry.content[:300]}")

        agent.on_log(on_log)

        try:
            results = agent.run(html_path)
            status.update(
                label=f"Done — found {len(results)} XPaths in {len(agent.logs)} steps",
                state="complete",
            )
        except Exception as e:
            status.update(label=f"Agent error: {e}", state="error")
            st.stop()

    # --- Step 3: Display results ---
    if not results:
        st.warning("The agent could not find XPaths. Check the logs in the sidebar.")
        st.stop()

    st.subheader("Discovered XPaths")

    for r in results:
        with st.expander(f"**{r.field}** — Score: {r.robustness_score}/100  |  Matches: {r.match_count}", expanded=True):
            st.code(r.xpath, language="xpath")

            col_a, col_b = st.columns(2)
            with col_a:
                st.metric("Robustness Score", f"{r.robustness_score}/100")
                if r.score_reasons:
                    for reason in r.score_reasons:
                        st.caption(reason)
            with col_b:
                st.markdown("**Example extracted text:**")
                st.info(r.example_text or "_(empty)_")

    # --- Step 4: Live verification table ---
    st.subheader("Live Verification")
    st.caption("Re-running each XPath against the fetched HTML to prove they work:")

    verify_data = []
    for r in results:
        vr = evaluate_xpath_from_string(cleaned_html, r.xpath)
        sample = vr.snippets[0]["text_content"] if vr.snippets else "—"
        verify_data.append({
            "Field": r.field,
            "XPath": r.xpath,
            "Matches": vr.match_count,
            "Status": "✅" if vr.exit_code == 0 else "❌",
            "Sample Text": sample[:100],
            "Score": f"{r.robustness_score}/100",
        })

    st.table(verify_data)
