"""read_result — a tool result of this turn, read back in full (S38b).

When a round nears the served window, the oldest results are replaced in what
is SENT by a summary under a marker written by code (context_summary.marker):
"the full text is kept; read it with read_result("r3", part=… or query=…)".
This is that tool. The text is the turn's own kept result (traces, T1) — read
from the live map chat._run_turn keeps for the running turn, by the turn id
the context carries — served in parts or by search exactly as browser_read
serves a page: reader.read_text builds the Page through the reader's own
paging, and the search is the reader's.

Outside a chat turn there is nothing of this turn to read, and it says so;
it never guesses from the database or from another turn.
"""

from __future__ import annotations

import asyncio

from app import traces
from app.browser import reader
from app.tools.base import Tool, ToolContext, ToolFailure


def _read_and_search(text: str, query: str):
    """read_text and, with a query, search — in ONE to_thread call, as
    browser_read does: a kept result can be megabytes."""
    page = reader.read_text(text, reader.DEFAULT_PART_CHARS)
    return (page, reader.search(page, query)) if query else (page, None)


def _kept(ctx: ToolContext, ref: str) -> traces.ToolResult:
    results = traces.results_of(ctx.turn_id) if ctx.turn_id is not None else None
    if results is None:
        raise ToolFailure(
            "read_result reads this turn's own tool results, so it works only inside a chat "
            "turn — this call is not in one"
        )
    for kept in results:
        if kept.ref == ref:
            return kept
    if not results:
        raise ToolFailure(f"there is no result {ref!r} — this turn has no tool results yet")
    named = ", ".join(f"{kept.ref} ({kept.tool})" for kept in results)
    raise ToolFailure(f"there is no result {ref!r} in this turn; its results are {named}")


async def read_result(args: dict, ctx: ToolContext) -> str:
    ref = (args.get("ref") or "").strip()
    kept = _kept(ctx, ref)
    query = (args.get("query") or "").strip()
    page, searched = await asyncio.to_thread(_read_and_search, kept.content, query)
    count = len(page.parts)
    head = f"Result {kept.ref} ({kept.tool}, {kept.chars:,} chars)"
    if query:
        matches, total = searched
        if not matches:
            parts = f"{count} part{'s' if count != 1 else ''}"
            return f"{head}\nNo line holds every word of {query!r} ({parts})."
        held = "1 line holds" if total == 1 else f"{total:,} lines hold"
        lines = [f"{head} · {held} every word of {query!r}:"]
        for match in matches:
            under = f" under {match.heading!r}" if match.heading else ""
            lines.append(f"- part {match.part}{under}: {match.text}")
        if total > len(matches):
            lines.append(f"…and {total - len(matches)} more; use more words, or read a part.")
        return "\n".join(lines)
    wanted = int(args.get("part") or 1)
    if wanted > count:
        raise ToolFailure(
            f"{kept.ref} has {count} part{'s' if count != 1 else ''}; there is no part {wanted}"
        )
    body = page.parts[wanted - 1] or "(The result has no text.)"
    return f"{head} · part {wanted} of {count}:\n\n{body}"


TOOLS = (
    Tool(
        name="read_result",
        description=(
            "Read back, in full, a tool result from this turn that was replaced by a summary "
            "(its marker names the ref, like r3). A long result comes in parts of "
            f"{reader.DEFAULT_PART_CHARS:,} characters — read part 1, then 2 — or search it "
            "with query to get only the lines holding every word, with their part numbers."
        ),
        parameters={
            "type": "object",
            "properties": {
                "ref": {
                    "type": "string",
                    "description": "The result's ref from its summary marker, like r3.",
                },
                "part": {"type": "integer", "minimum": 1, "description": "Which part; 1 first."},
                "query": {"type": "string", "description": "Words every returned line must hold."},
            },
            "required": ["ref"],
            "additionalProperties": False,
        },
        executor=read_result,
        # Reading a result this turn already holds changes nothing.
        reads_only=True,
    ),
)
