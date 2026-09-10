"""The two memory tools — thin, authenticated calls to the memory service.

Neither tool takes an owner: the person is whoever the turn is being run
for, taken from the context. A tool that could name its own scope would be
a tool that could read someone else's notes by asking nicely.
"""
from __future__ import annotations

import httpx

from app import peers
from app.tools.base import Tool, ToolContext, ToolFailure

MEMORY_TIMEOUT = httpx.Timeout(10.0)
DEFAULT_K = 5
MAX_K = 20
SNIPPET_CHARS = 300


def _person_id(ctx: ToolContext) -> str:
    person = ctx.person
    if person is None or getattr(person, "id", None) is None:
        raise ToolFailure("this turn has no identity, so memory cannot be scoped to anyone")
    return str(person.id)


async def _call_memory(ctx: ToolContext, path: str, payload: dict) -> object:
    try:
        async with peers.client(ctx.app, peers.MEMORY, MEMORY_TIMEOUT) as client:
            response = await client.post(path, json=payload)
            if response.status_code != 200:
                detail = response.text[:200]
                raise ToolFailure(
                    f"the memory service refused {path} ({response.status_code}): {detail}"
                )
            return response.json()
    except ToolFailure:
        raise
    except (httpx.HTTPError, peers.PeerUnconfigured, ValueError) as exc:
        raise ToolFailure(f"could not reach memory — {peers.reason(exc)}") from exc


def _statement(body: object) -> str | None:
    """Memory's own sentence about the recall, when it sent one.

    /recall says which nothing it found and whether it searched with
    everything it has; those are memory's facts and memory's words, and this
    tool repeats them rather than composing a claim of its own. None for a
    memory service too old to send one — see `search`.
    """
    if isinstance(body, dict):
        said = body.get("statement")
        if isinstance(said, str) and said.strip():
            return said.strip()
    return None


def _reduced(body: object) -> bool:
    """True when memory says this search was not the search it has.

    Memory searches twice — by word and by meaning — and the meaning half
    needs an embedding model that may not be installed. Read off memory's own
    report; this service never decides what the report means.

    TWO SHAPES OF LIMITATION, not one (2026-09-10). A retriever that did not
    run at all reports `ran: false` with a reason. A retriever that ran over
    part of the corpus reports `ran: true` with a `coverage` line — "12 of 47
    notes in this scope are embedded" — and this used to read that as a whole
    search, so memory's statement was withheld and the tool's list of hits
    read as the complete answer. A search over a quarter of the notes is not
    a complete answer, and the person asking has to be told which one it was.
    """
    reports = body.get("retrievers") if isinstance(body, dict) else None
    if not isinstance(reports, list):
        return False
    for report in reports:
        if not isinstance(report, dict):
            continue
        if report.get("ran") is False and report.get("reason"):
            return True
        if report.get("ran") is True and report.get("coverage"):
            return True
    return False


def _hits(body: object) -> list[dict]:
    """/recall answers with a bare list; a dict wrapper is tolerated so a
    later shape change downgrades to zero hits rather than a crash."""
    if isinstance(body, list):
        return [hit for hit in body if isinstance(hit, dict)]
    if isinstance(body, dict):
        for key in ("results", "hits"):
            value = body.get(key)
            if isinstance(value, list):
                return [hit for hit in value if isinstance(hit, dict)]
    return []


def _clip(text: str) -> str:
    text = " ".join(text.split())
    return text if len(text) <= SNIPPET_CHARS else text[:SNIPPET_CHARS] + "…"


async def search(args: dict, ctx: ToolContext) -> str:
    query = args["query"]
    k = args.get("k", DEFAULT_K)
    body = await _call_memory(
        ctx, "/recall", {"query": query, "person_id": _person_id(ctx), "k": k}
    )
    hits = _hits(body)
    said = _statement(body)
    if not hits:
        # Memory's own sentence, whenever it sent one: it says WHICH nothing
        # this is — the notes hold no answer to that, or the search that
        # looked was the reduced one because the embedding model is not
        # installed. "No saved notes matched" is a claim about the notes, and
        # a search that could not run with everything it has established
        # nothing about them; making that claim here is the lie this feature
        # exists to prevent, on the one path she reaches for deliberately.
        # The fallback is for a memory service too old to send a statement:
        # it claims nothing beyond the empty result it was given.
        return said or f"No saved notes matched {query!r}."

    lines = [f"{len(hits)} note(s) matched {query!r}:"]
    for hit in hits:
        title = hit.get("title") or hit.get("path") or "(untitled)"
        kind = hit.get("kind") or "note"
        snippet = _clip(str(hit.get("snippet") or ""))
        lines.append(f"- {title} ({kind}): {snippet}" if snippet else f"- {title} ({kind})")
    if said and _reduced(body):
        # Hits found, but by half the search. Said on the found path too,
        # because "here are three notes" reads as "and there were only
        # three" — and a note phrased differently could have been missed.
        lines.append(said)
    return "\n".join(lines)


async def save(args: dict, ctx: ToolContext) -> str:
    title = args["title"]
    body = await _call_memory(
        ctx,
        "/save",
        {"person_id": _person_id(ctx), "title": title, "content": args["content"]},
    )
    # The endpoint verifies the file exists before answering; this checks
    # that it actually said so, rather than treating any 200 as a save.
    if not isinstance(body, dict) or body.get("saved") is not True or not body.get("path"):
        raise ToolFailure(f"memory answered without confirming the save: {body!r}"[:300])
    return f"Saved {title!r} to memory at {body['path']}."


TOOLS: tuple[Tool, ...] = (
    Tool(
        name="memory_search",
        description=(
            "Search this person's saved notes and past conversations. "
            "Use it before saying you do not know something about them."
        ),
        parameters={
            "type": "object",
            "properties": {
                "query": {"type": "string", "description": "What to look for."},
                "k": {
                    "type": "integer",
                    "minimum": 1,
                    "maximum": MAX_K,
                    "description": f"How many notes to return (default {DEFAULT_K}).",
                },
            },
            "required": ["query"],
            "additionalProperties": False,
        },
        executor=search,
    ),
    Tool(
        name="memory_save",
        description=(
            "Save a note to this person's long-term memory so it can be recalled "
            "in later conversations."
        ),
        parameters={
            "type": "object",
            "properties": {
                "title": {"type": "string", "description": "A short title for the note."},
                "content": {"type": "string", "description": "The note itself, in markdown."},
            },
            "required": ["title", "content"],
            "additionalProperties": False,
        },
        executor=save,
    ),
)
