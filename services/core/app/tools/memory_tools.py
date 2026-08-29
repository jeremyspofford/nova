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
    if not hits:
        # Said plainly: an empty result is a fact about the notes, and the
        # model needs to be able to tell it apart from a failed lookup.
        return f"No saved notes matched {query!r}."

    lines = [f"{len(hits)} note(s) matched {query!r}:"]
    for hit in hits:
        title = hit.get("title") or hit.get("path") or "(untitled)"
        kind = hit.get("kind") or "note"
        snippet = _clip(str(hit.get("snippet") or ""))
        lines.append(f"- {title} ({kind}): {snippet}" if snippet else f"- {title} ({kind})")
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
