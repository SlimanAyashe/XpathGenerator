"""HTML fetcher and DOM cleaner.

Fetches a web page and strips non-semantic elements (scripts, styles, SVGs,
hidden elements, comments) to produce a minimal but structurally faithful DOM
suitable for AI-driven XPath generation.
"""

import re
import requests
from lxml import etree, html


STRIP_TAGS = {"script", "style", "svg", "noscript", "iframe", "link", "meta"}

HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/131.0.0.0 Safari/537.36"
    ),
    "Accept-Language": "en-US,en;q=0.9,he;q=0.8",
}


def fetch_html(url: str, timeout: int = 30) -> str:
    """Download the raw HTML from *url*."""
    resp = requests.get(url, headers=HEADERS, timeout=timeout)
    resp.raise_for_status()
    return resp.text


def clean_dom(raw_html: str) -> str:
    """Return a cleaned, serialised HTML string.

    Removes scripts, styles, SVGs, comments, and hidden elements while
    preserving the semantic structure that XPath queries rely on.
    """
    tree = html.fromstring(raw_html)

    # Remove unwanted tags entirely
    for tag in STRIP_TAGS:
        for el in tree.xpath(f"//{tag}"):
            el.getparent().remove(el)

    # Remove HTML comments
    for comment in tree.xpath("//comment()"):
        parent = comment.getparent()
        if parent is not None:
            parent.remove(comment)

    # Remove hidden elements (display:none or hidden attribute)
    for el in tree.xpath("//*[@hidden]"):
        el.getparent().remove(el)
    for el in tree.xpath("//*[contains(@style, 'display:none') or contains(@style, 'display: none')]"):
        el.getparent().remove(el)

    # Strip inline styles and event handlers to reduce noise
    for el in tree.xpath("//*[@style]"):
        del el.attrib["style"]
    for attr in ("onclick", "onload", "onerror", "onmouseover"):
        for el in tree.xpath(f"//*[@{attr}]"):
            del el.attrib[attr]

    cleaned = html.tostring(tree, encoding="unicode", pretty_print=True)
    # Collapse excessive blank lines
    cleaned = re.sub(r"\n{3,}", "\n\n", cleaned)
    return cleaned


def fetch_and_clean(url: str) -> str:
    """Fetch a URL and return cleaned HTML."""
    raw = fetch_html(url)
    return clean_dom(raw)


def save_html(html_content: str, path: str) -> None:
    """Write HTML string to a local file."""
    with open(path, "w", encoding="utf-8") as f:
        f.write(html_content)
