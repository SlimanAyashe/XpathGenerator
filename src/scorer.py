"""XPath robustness scorer.

Scores an XPath expression 0–100 based on how resilient it is to DOM changes.
Pure algorithmic — no AI needed.
"""

import re


def score_xpath(xpath: str) -> tuple[int, list[str]]:
    """Return (score, reasons) for the given XPath expression.

    Starts at 70 (baseline) and applies bonuses/penalties.
    """
    score = 70
    reasons: list[str] = []

    # --- Penalties ---

    # Positional indexes like [1], [2], [last()]
    index_matches = re.findall(r"\[\d+\]", xpath)
    if index_matches:
        penalty = min(len(index_matches) * 10, 30)
        score -= penalty
        reasons.append(f"-{penalty}: uses {len(index_matches)} positional index(es) — fragile if list order changes")

    # Deep absolute paths (more than 3 levels of direct child `/` without `//`)
    direct_steps = xpath.split("//")
    for segment in direct_steps:
        depth = segment.count("/")
        if depth > 3:
            penalty = min((depth - 3) * 5, 20)
            score -= penalty
            reasons.append(f"-{penalty}: deep hierarchy ({depth} levels) — breaks if DOM restructures")
            break

    # Wildcard * without attribute filter
    if re.search(r"//\*(?!\[)", xpath):
        score -= 10
        reasons.append("-10: bare wildcard //* without filter — too broad")

    # --- Bonuses ---

    # Uses @id
    if "@id" in xpath:
        score += 10
        reasons.append("+10: targets @id — most stable selector")

    # Uses data-* attributes
    if re.search(r"@data-[\w-]+", xpath):
        score += 8
        reasons.append("+8: uses data-* attribute — designed for programmatic access")

    # Uses @role or aria-*
    if "@role" in xpath or "aria-" in xpath:
        score += 8
        reasons.append("+8: uses ARIA/role — semantic and accessibility-oriented")

    # Uses contains(@class, ...)
    if "contains(@class" in xpath:
        score += 5
        reasons.append("+5: partial class match — tolerates class list changes")

    # Uses text() or contains(text(), ...) or contains(., ...)
    if "text()" in xpath or "contains(." in xpath:
        score += 5
        reasons.append("+5: uses text content matching — resilient to structural changes")

    # Short and simple (few path steps)
    step_count = xpath.count("/")
    if step_count <= 4:
        score += 5
        reasons.append("+5: concise expression — fewer points of failure")

    # Clamp to 0-100
    score = max(0, min(100, score))
    return score, reasons
