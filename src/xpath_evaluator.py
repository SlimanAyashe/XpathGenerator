"""XPath evaluator — the 'tool' the AI agent calls.

Given a local HTML file and an XPath expression, evaluates the expression and
returns structured results: match count, outer-HTML snippets, and text content
of the first few hits.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, asdict
from lxml import html, etree


MAX_SNIPPET_LEN = 300
MAX_RESULTS = 5


@dataclass
class XPathResult:
    exit_code: int          # 0 = found, 1 = no matches, 2 = error
    match_count: int
    snippets: list[dict]    # [{outer_html, text_content}, ...]
    error: str | None = None

    def to_json(self) -> str:
        return json.dumps(asdict(self), ensure_ascii=False, indent=2)


def _snippet(el: etree._Element) -> dict:
    """Extract a compact snippet from an element."""
    outer = etree.tostring(el, encoding="unicode", method="html")
    if len(outer) > MAX_SNIPPET_LEN:
        outer = outer[:MAX_SNIPPET_LEN] + "..."
    text = el.text_content().strip()
    if len(text) > 200:
        text = text[:200] + "..."
    return {"outer_html": outer, "text_content": text}


def evaluate_xpath(html_path: str, xpath_expr: str) -> XPathResult:
    """Run *xpath_expr* against the HTML file at *html_path*.

    Returns an XPathResult with exit_code 0 (found), 1 (no matches), or
    2 (invalid XPath / IO error).
    """
    try:
        with open(html_path, "r", encoding="utf-8") as f:
            content = f.read()
    except OSError as exc:
        return XPathResult(exit_code=2, match_count=0, snippets=[], error=str(exc))

    try:
        tree = html.fromstring(content)
    except Exception as exc:
        return XPathResult(exit_code=2, match_count=0, snippets=[], error=f"Parse error: {exc}")

    try:
        results = tree.xpath(xpath_expr)
    except etree.XPathError as exc:
        return XPathResult(exit_code=2, match_count=0, snippets=[], error=f"Invalid XPath: {exc}")

    if not results and results != 0:
        return XPathResult(exit_code=1, match_count=0, snippets=[])

    # Handle scalar results (count(), string(), boolean())
    if isinstance(results, (bool, float, int, str)):
        return XPathResult(
            exit_code=0,
            match_count=int(results) if isinstance(results, float) else 1,
            snippets=[{"outer_html": "", "text_content": str(results)}],
        )

    if not results:
        return XPathResult(exit_code=1, match_count=0, snippets=[])

    # Handle non-element results (e.g. text() or @attr queries)
    if not isinstance(results[0], etree._Element):
        text_results = [{"outer_html": "", "text_content": str(r)} for r in results[:MAX_RESULTS]]
        return XPathResult(exit_code=0, match_count=len(results), snippets=text_results)

    snippets = [_snippet(el) for el in results[:MAX_RESULTS]]
    return XPathResult(exit_code=0, match_count=len(results), snippets=snippets)


def evaluate_xpath_from_string(html_content: str, xpath_expr: str) -> XPathResult:
    """Same as evaluate_xpath but operates on an HTML string directly."""
    try:
        tree = html.fromstring(html_content)
    except Exception as exc:
        return XPathResult(exit_code=2, match_count=0, snippets=[], error=f"Parse error: {exc}")

    try:
        results = tree.xpath(xpath_expr)
    except etree.XPathError as exc:
        return XPathResult(exit_code=2, match_count=0, snippets=[], error=f"Invalid XPath: {exc}")

    # Handle scalar results (count(), string(), boolean())
    if isinstance(results, (bool, float, int, str)):
        return XPathResult(
            exit_code=0,
            match_count=int(results) if isinstance(results, float) else 1,
            snippets=[{"outer_html": "", "text_content": str(results)}],
        )

    if not results:
        return XPathResult(exit_code=1, match_count=0, snippets=[])

    if not isinstance(results[0], etree._Element):
        text_results = [{"outer_html": "", "text_content": str(r)} for r in results[:MAX_RESULTS]]
        return XPathResult(exit_code=0, match_count=len(results), snippets=text_results)

    snippets = [_snippet(el) for el in results[:MAX_RESULTS]]
    return XPathResult(exit_code=0, match_count=len(results), snippets=snippets)
