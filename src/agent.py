"""Agentic XPath generator using Gemini with tool-calling.

Implements a ReAct loop: the AI iteratively probes a local HTML file via the
evaluate_xpath tool until it discovers robust, verified XPaths for each
target field (Title, Author, Date, Subtitle, Link).
"""

from __future__ import annotations

import json
import os
from dataclasses import dataclass, field
from typing import Callable

from google import genai
from google.genai import types

from .xpath_evaluator import evaluate_xpath, XPathResult
from .scorer import score_xpath


# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

MODEL = "gemini-3.1-pro-preview"

TARGET_FIELDS = ["Title", "Author", "Date", "Subtitle", "Link"]

SYSTEM_PROMPT = """\
You are an expert QA automation engineer specialising in web scraping.
Your job is to find robust, unique XPath expressions for article elements on a news website.

## Rules
- You CANNOT read the HTML file directly. You can ONLY inspect it via the `evaluate_xpath` tool.
- Work iteratively: start with broad queries, examine the snippets returned, then narrow down.
- XPaths MUST rely on semantic attributes (class names, ARIA roles, data-* attributes, tag semantics) — NOT brittle positional indexes like div[1]/div[2]/span[3].
- Each final XPath must match a CONSISTENT number of article elements (one per article on the page). If the page has N articles, your XPath should return N results (one per article).
- For the "Link" field, the XPath should target an <a> element (or its href attribute) that links to the full article.
- Before finalising an XPath, run it ONE MORE TIME with the tool to verify the match count is correct and consistent.

## XPath Best Practices (Cheat Sheet)
- Use `contains(@class, 'xxx')` for partial class matching
- Use `@role`, `@aria-label`, `@data-*` for semantic targeting
- Use `//tag` descendant axis over absolute paths
- Use `text()` or `contains(., 'text')` for text matching
- Avoid positional indexes unless absolutely necessary
- Keep expressions concise — fewer path steps = more resilient

## Your Task
You are given the path to a saved HTML file. Find one XPath for each of these article fields:
{fields}

For EACH field:
1. Explore broadly (e.g., search for relevant class names, tags, or ARIA attributes)
2. Narrow down to the specific element
3. Verify the XPath returns a reasonable number of matches (should match the number of articles on the page)
4. Report the final XPath, an example of the extracted text, and the match count

When you are done with ALL fields, output your final results as a JSON array with this exact structure:
```json
[
  {{
    "field": "Title",
    "xpath": "//div[contains(@class, 'title')]",
    "example_text": "Example article title",
    "match_count": 10
  }},
  ...
]
```
Output ONLY the JSON array as your very last message, with no extra text around it.
"""

# ---------------------------------------------------------------------------
# Tool declaration for Gemini
# ---------------------------------------------------------------------------

XPATH_TOOL_DECL = types.FunctionDeclaration(
    name="evaluate_xpath",
    description=(
        "Evaluate an XPath expression against a local HTML file. "
        "Returns: exit_code (0=found, 1=no matches, 2=error), match_count, "
        "and outer-HTML snippets + text content of the first few matches."
    ),
    parameters={
        "type": "object",
        "properties": {
            "html_path": {
                "type": "string",
                "description": "Path to the local HTML file to query.",
            },
            "xpath_expr": {
                "type": "string",
                "description": "The XPath expression to evaluate.",
            },
        },
        "required": ["html_path", "xpath_expr"],
    },
)

TOOLS = types.Tool(function_declarations=[XPATH_TOOL_DECL])


# ---------------------------------------------------------------------------
# Result data class
# ---------------------------------------------------------------------------

@dataclass
class FieldResult:
    field: str
    xpath: str
    example_text: str
    match_count: int
    robustness_score: int = 0
    score_reasons: list[str] = field(default_factory=list)


# ---------------------------------------------------------------------------
# Agent
# ---------------------------------------------------------------------------

@dataclass
class AgentLog:
    role: str       # "agent" | "tool_call" | "tool_result"
    content: str


class XPathAgent:
    """Autonomous agent that discovers XPaths via Gemini + tool-calling."""

    def __init__(self, api_key: str | None = None, model: str = MODEL):
        key = api_key or os.environ.get("GOOGLE_API_KEY", "")
        if not key:
            raise ValueError("Provide a Gemini API key or set GOOGLE_API_KEY")
        self.client = genai.Client(api_key=key)
        self.model = model
        self.logs: list[AgentLog] = []
        self._on_log: Callable[[AgentLog], None] | None = None

    def on_log(self, callback: Callable[[AgentLog], None]) -> None:
        """Register a callback that fires on every log entry."""
        self._on_log = callback

    def _log(self, role: str, content: str) -> None:
        entry = AgentLog(role=role, content=content)
        self.logs.append(entry)
        if self._on_log:
            self._on_log(entry)

    def _dispatch_tool(self, name: str, args: dict) -> dict:
        """Execute a tool call and return the result dict."""
        if name == "evaluate_xpath":
            result: XPathResult = evaluate_xpath(
                html_path=args["html_path"],
                xpath_expr=args["xpath_expr"],
            )
            return json.loads(result.to_json())
        return {"error": f"Unknown tool: {name}"}

    def run(self, html_path: str, max_turns: int = 40) -> list[FieldResult]:
        """Run the agentic loop and return discovered XPaths."""
        self.logs.clear()

        fields_str = ", ".join(TARGET_FIELDS)
        system = SYSTEM_PROMPT.format(fields=fields_str)

        user_msg = (
            f"The HTML file is saved at: {html_path}\n"
            f"Find robust XPaths for these article fields: {fields_str}.\n"
            "Start by exploring the page structure with broad queries."
        )

        contents: list[types.Content] = [
            types.Content(role="user", parts=[types.Part(text=user_msg)]),
        ]

        config = types.GenerateContentConfig(
            tools=[TOOLS],
            system_instruction=system,
            temperature=0.2,
        )

        self._log("agent", f"Starting XPath discovery for: {fields_str}")

        for turn in range(max_turns):
            response = self.client.models.generate_content(
                model=self.model,
                contents=contents,
                config=config,
            )

            candidate = response.candidates[0]
            contents.append(candidate.content)

            # Log any text the model produced
            if response.text:
                self._log("agent", response.text)

            # If no function calls, the model is done
            if not response.function_calls:
                break

            # Process function calls
            fn_response_parts = []
            for fc in response.function_calls:
                self._log("tool_call", f"{fc.name}({json.dumps(fc.args, ensure_ascii=False)})")

                result = self._dispatch_tool(fc.name, fc.args)
                result_str = json.dumps(result, ensure_ascii=False)

                # Truncate very long results to keep context manageable
                if len(result_str) > 4000:
                    result_str = result_str[:4000] + '..."}'

                self._log("tool_result", result_str)

                fn_response_parts.append(
                    types.Part.from_function_response(
                        name=fc.name,
                        response={"result": result},
                    )
                )

            contents.append(
                types.Content(role="user", parts=fn_response_parts)
            )

        # Parse the final JSON from the last model text
        return self._parse_results(response.text or "")

    def _parse_results(self, text: str) -> list[FieldResult]:
        """Extract the JSON array from the model's final message."""
        # Find JSON array in the text
        start = text.find("[")
        end = text.rfind("]")
        if start == -1 or end == -1:
            self._log("agent", "WARNING: Could not parse final JSON from model output.")
            return []

        try:
            raw = json.loads(text[start : end + 1])
        except json.JSONDecodeError:
            self._log("agent", "WARNING: JSON parse error in model output.")
            return []

        results = []
        for item in raw:
            xpath = item.get("xpath", "")
            sc, reasons = score_xpath(xpath)
            results.append(
                FieldResult(
                    field=item.get("field", "?"),
                    xpath=xpath,
                    example_text=item.get("example_text", ""),
                    match_count=item.get("match_count", 0),
                    robustness_score=sc,
                    score_reasons=reasons,
                )
            )
        return results
