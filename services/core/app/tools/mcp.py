"""Her MCP tools (S37a): connect a server, remove one, look up its tools, run one.

Four fixed tools rather than one per server tool: one 87-tool server would
drown a small local model on every turn (spec §3), and the registry stays
static, so its pins keep their meaning — S18's choice for scripted skills.
The line in her prompt naming each connected server and its tools is
servers.roster_line; a server's own descriptions reach her only as an
mcp_tools result, third-party text like a fetched page.

Every call that reaches the network files a fact on its span through
ctx.facts_sink — never prose, so the guards and Activity read structure
instead of a sentence (plan decision P8). The shape differs by what the
call actually did (ruling F15 corrects this module's first draft, which
claimed one shape for all of it):

  * a connect, or a refresh — mcp_tools's own staleness check, AND
    mcp_call's refresh-on-a-miss when the tool it was asked for is not in
    the cached list (ruling T7-A/M1: the second of these used to file
    nothing at all) — that reached the server, whether or not it then
    succeeded: 5 keys — `mcp_server`, `tool` (always None here), `origin`,
    `protocol`, `reachable`.
  * a tool call (mcp_call), ok or not: 7 keys — the same five plus
    `is_error` and `bytes` (None and 0 on a ClientError, since nothing
    came back to measure).
  * mcp_connect's own refusal before any row exists — a name or address the
    store refused outright, or the probe's own failure: 3 keys —
    `mcp_server`, `tool` (None), `reachable`.

Task 12's guards read `mcp_server` off these, and the span's own
`reached_executor` flag — never `reachable`, which is for Activity and the
roster's own failing() derivation, not a guard.

THE 64 KIB CAP (ruling T7-A) applies to every word a server's own text puts
in front of her, not only a successful result: `_capped` is the one place
that enforces the byte bound, and every return and every ToolFailure built
even partly from server text — a call's result (body + notes, success or
`isError`), a ClientError's reason, a refresh failure folded into
`refresh_note` — is composed THROUGH it, never around it. `result.notes` is
also bounded in COUNT before it is ever joined into a string
(`_notes_text`), so a response built of many small non-object content
blocks cannot inflate a multi-megabyte string just to cut it down
afterward; a server-supplied TOOL NAME is clipped (`_clip_name`) everywhere
one is listed, so a single absurd name cannot crowd out the rest of a
listing or a refusal's own "re-issue the call" instruction.

`app.mcp.servers` is imported INSIDE the executors: it imports notices, then
the checks, then agents, then this package — a cycle at import time that
test_the_tools_package_imports_on_its_own would catch.
"""

from __future__ import annotations

import json
from collections.abc import Callable
from datetime import UTC, datetime
from typing import Any

from app import db
from app.mcp import client
from app.tools import schema
from app.tools.base import Tool, ToolContext, ToolFailure

RESULT_CAP_BYTES = 64 * 1024
TOOLS_RESULT_CAP_CHARS = 24_000
DESCRIPTION_CHARS = 300
SCHEMA_CHARS = 2_000
NAMES_IN_A_REFUSAL = 40
# A server-supplied TOOL NAME, wherever one is listed (ruling T7-A): clipped
# before it ever joins a comma-separated list or a refusal, so one absurd
# name cannot crowd out the rest of a listing or the "re-issue the call"
# instruction a blunt end-of-string cap would otherwise cut off.
NAME_CHARS = 120
# How many of a call's own NOTES are composed into text before the rest are
# collapsed to a count (ruling T7-A): bounded in COUNT first, so a response
# built of many small non-object content blocks never has to build a
# multi-megabyte string just to cut it down with `_capped` afterward.
MAX_NOTES_LISTED = 20


def _store():
    from app.mcp import servers

    return servers


def _actor(ctx: ToolContext) -> str:
    name = getattr(getattr(ctx, "person", None), "name", None)
    if not isinstance(name, str) or not name.strip():
        raise ToolFailure("this turn has no identity, so the change could not be attributed")
    return name


def _fact(ctx: ToolContext, **fact: Any) -> None:
    if ctx.facts_sink is not None:
        ctx.facts_sink.append(fact)


def _progress(ctx: ToolContext, label: str) -> Callable[[str], None] | None:
    report = ctx.progress
    if report is None:
        return None
    return lambda line: report(f"{label}: {line}")


def _schema_text(input_schema: Any) -> str:
    text = json.dumps(input_schema, separators=(",", ":"), ensure_ascii=False)
    return text if len(text) <= SCHEMA_CHARS else text[:SCHEMA_CHARS] + "…"


def _capped(text: str) -> str:
    """The one place the 64 KiB cap is enforced (ruling T7-A). Every string
    built even partly from server text passes through this before it ever
    becomes a return value or a ToolFailure's reason — never only the
    "normal" result path, or a composed string can slip past uncapped."""
    raw = text.encode("utf-8")
    if len(raw) <= RESULT_CAP_BYTES:
        return text
    kept = raw[:RESULT_CAP_BYTES].decode("utf-8", errors="ignore")
    return (
        f"{kept}\n[cut at 64 KiB: {len(raw) - RESULT_CAP_BYTES} more bytes were not shown — "
        "ask the tool for less, for example fewer lines or one page]"
    )


def _clip_name(name: Any) -> str:
    """A server-supplied tool NAME, clipped to `NAME_CHARS` (ruling T7-A) —
    applied at every place one is listed, before it joins any other text."""
    text = str(name)
    return text if len(text) <= NAME_CHARS else text[:NAME_CHARS] + "…"


def _notes_text(notes: tuple[str, ...]) -> str:
    """The call's own notes, bounded in COUNT before they are ever composed
    into one string (ruling T7-A) — at most `MAX_NOTES_LISTED`, then a
    stated count of the rest, so a response built of many small notes never
    has to build the whole of them just to cut the result down afterward."""
    shown = notes[:MAX_NOTES_LISTED]
    text = "".join(f"\n({note})" for note in shown)
    rest = len(notes) - len(shown)
    if rest > 0:
        text += f"\n({rest} more note{'s' if rest != 1 else ''})"
    return text


async def _server(pool, name: str):
    """The named row, or a stated refusal in the store's OWN words (ruling
    F13: one source, `servers.no_such_server` — never a second copy of the
    same sentence composed here)."""
    store = _store()
    found = await store.get(pool, name)
    if found is None:
        raise ToolFailure(await store.no_such_server(pool, name))
    return found


def _who(added_by: str) -> str:
    return "the owner" if added_by == _store().BY_OWNER else "Nova"


async def mcp_connect(args: dict, ctx: ToolContext) -> str:
    store = _store()
    pool = await db.get_pool()
    try:
        done = await store.connect(
            pool,
            name=args["name"],
            url=args["url"],
            token=args.get("token"),
            headers=args.get("headers"),
            added_by=store.BY_NOVA,
            actor=_actor(ctx),
        )
    except store.ServerError as exc:
        _fact(ctx, mcp_server=str(args.get("name")), tool=None, reachable=exc.reachable)
        raise ToolFailure(exc.reason) from exc
    server = done.server
    _fact(
        ctx,
        mcp_server=server.name,
        tool=None,
        origin=server.origin,
        protocol=server.protocol,
        reachable=True,
    )
    lines = [
        f"Connected {server.name} at {server.origin} — {server.title or 'untitled'}, "
        f"protocol {server.protocol}."
    ]
    if done.previous is not None:
        lines.append(
            f"It replaced the {server.name} that {_who(done.previous.added_by)} had added, "
            f"at {done.previous.origin}."
        )
    names = [_clip_name(t.get("name")) for t in server.tools]
    if len(names) <= store.ROSTER_NAMES_UP_TO:
        lines.append("Its tools: " + (", ".join(names) if names else "none listed") + ".")
    else:
        lines.append(
            f"It lists {len(names)} tools; look one up with "
            f"mcp_tools(server={server.name!r}, query=…)."
        )
    if done.rejected:
        dropped = "; ".join(f"{_clip_name(name)}: {why}" for name, why in done.rejected[:5])
        lines.append(
            f"{len(done.rejected)} of its tools were left out because their definitions break "
            f"the protocol ({dropped})."
        )
    if done.notice:
        lines.append(done.notice)
    return "\n".join(lines)


async def mcp_disconnect(args: dict, ctx: ToolContext) -> str:
    store = _store()
    pool = await db.get_pool()
    try:
        done = await store.disconnect(pool, name=args["name"], by=store.BY_NOVA, actor=_actor(ctx))
    except store.ServerError as exc:
        raise ToolFailure(exc.reason) from exc
    lines = [
        f"Removed {done.server.name} ({done.server.origin}), which {_who(done.server.added_by)} "
        "had added. Its token is deleted."
    ]
    if done.notice:
        lines.append(done.notice)
    return "\n".join(lines)


async def mcp_tools(args: dict, ctx: ToolContext) -> str:
    store = _store()
    pool = await db.get_pool()
    server = await _server(pool, args["server"])
    note = ""
    if server.tools_stale(datetime.now(UTC)):
        try:
            server = await store.refresh_tools(pool, server, actor=_actor(ctx))
            _fact(
                ctx,
                mcp_server=server.name,
                tool=None,
                origin=server.origin,
                protocol=server.protocol,
                reachable=True,
            )
        except client.ClientError as exc:
            # refresh_tools raised before writing anything (ruling T5-E): the
            # row still holds what `server` already does, so THIS snapshot —
            # never a name string — is what record_call scrubs and matches
            # against (Task 5 carry).
            await store.record_call(pool, server, ok=False, reason=exc.reason)
            _fact(
                ctx,
                mcp_server=server.name,
                tool=None,
                origin=server.origin,
                protocol=server.protocol,
                reachable=exc.reachable,
            )
            when = (
                server.tools_fetched_at.isoformat(timespec="minutes")
                if server.tools_fetched_at
                else "never"
            )
            note = (
                f"\n(Could not read the list again — {_capped(exc.reason)}. "
                f"This is the list read at {when}.)"
            )
        except store.ServerError as exc:
            # The row changed or was removed under this read (Task 5 carry,
            # ruling T5-E) — nothing was recorded, so nothing is stamped here.
            raise ToolFailure(exc.reason) from exc
    query = str(args.get("query") or "").strip()
    words = query.lower().split()
    chosen = [
        t
        for t in server.tools
        if all(w in f"{t.get('name', '')} {t.get('description', '')}".lower() for w in words)
    ]
    head = f"{server.name} ({server.title or 'untitled'}) lists {len(server.tools)} tools"
    head += f"; {len(chosen)} match {query!r}:" if words else ":"
    lines = [head]
    used = len(head)
    for index, tool in enumerate(chosen):
        entry = (
            f"- {_clip_name(tool.get('name'))}: "
            f"{str(tool.get('description') or '')[:DESCRIPTION_CHARS]}\n"
            f"  inputs: {_schema_text(tool.get('inputSchema'))}"
        )
        if used + len(entry) > TOOLS_RESULT_CAP_CHARS:
            lines.append(f"[{len(chosen) - index} more did not fit — narrow with query]")
            break
        lines.append(entry)
        used += len(entry)
    if words and not chosen:
        lines.append("(none match — try other words, or no query to see them all)")
    return "\n".join(lines) + note


async def mcp_call(args: dict, ctx: ToolContext) -> str:
    store = _store()
    pool = await db.get_pool()
    server = await _server(pool, args["server"])
    name = args["tool"]
    arguments = args.get("arguments") or {}
    tool = next((t for t in server.tools if t.get("name") == name), None)
    refresh_note = ""
    if tool is None:
        # The same shape as mcp_tools's own staleness-triggered refresh
        # (ruling M1): a miss files the 5-key refresh fact and, on a
        # ClientError, stamps the row failing — a miss against an
        # unreachable server used to file nothing and leave `failing` False.
        try:
            server = await store.refresh_tools(pool, server, actor=_actor(ctx))
            _fact(
                ctx,
                mcp_server=server.name,
                tool=None,
                origin=server.origin,
                protocol=server.protocol,
                reachable=True,
            )
        except client.ClientError as exc:
            await store.record_call(pool, server, ok=False, reason=exc.reason)
            _fact(
                ctx,
                mcp_server=server.name,
                tool=None,
                origin=server.origin,
                protocol=server.protocol,
                reachable=exc.reachable,
            )
            refresh_note = f" (its list could not be read again: {_capped(exc.reason)})"
        except store.ServerError as exc:
            # The row changed or was removed under this read (Task 5 carry,
            # ruling T5-E) — nothing was recorded, so nothing is stamped here.
            refresh_note = f" (its list could not be read again: {_capped(exc.reason)})"
        tool = next((t for t in server.tools if t.get("name") == name), None)
    if tool is None:
        names = (
            ", ".join(_clip_name(t.get("name")) for t in server.tools[:NAMES_IN_A_REFUSAL])
            or "none"
        )
        raise ToolFailure(
            f"{server.name} has no tool named {name!r} — it has: {names}{refresh_note} — "
            "re-issue the call"
        )
    problem = schema.validate_foreign(tool.get("inputSchema") or {}, arguments)
    if problem is not None:
        raise ToolFailure(
            f"{problem} — {server.name} · {name} takes: {_schema_text(tool.get('inputSchema'))} — "
            "re-issue the call"
        )
    label = f"{server.name} · {name}"
    try:
        result = await client.call(server.endpoint, name, arguments, progress=_progress(ctx, label))
    except client.ClientError as exc:
        # `server` here is the snapshot THIS call used (Task 5 carry): its own
        # credentials are what record_call scrubs with and its own endpoint is
        # what the UPDATE's WHERE clause must still match.
        await store.record_call(pool, server, ok=False, reason=exc.reason)
        _fact(
            ctx,
            mcp_server=server.name,
            tool=name,
            origin=server.origin,
            protocol=server.protocol,
            reachable=exc.reachable,
            is_error=None,
            bytes=0,
        )
        # The cap applies here too (ruling T7-A): a JSON-RPC error IS server
        # text (ClientError.reason), and nothing downstream of this raise —
        # dispatch, the chat loop — bounds it.
        raise ToolFailure(_capped(exc.reason)) from exc
    # T7-E: the server ANSWERED — isError is the tool's own answer, never a
    # failing server (Server.failing's docstring, servers.py) — so the row
    # is stamped ok here regardless of result.is_error, for the guards and
    # the roster to read server health honestly.
    await store.record_call(pool, server, ok=True)
    _fact(
        ctx,
        mcp_server=server.name,
        tool=name,
        origin=server.origin,
        protocol=server.protocol,
        reachable=True,
        is_error=result.is_error,
        bytes=result.bytes,
    )
    # The client already scrubbed every decoded server string, and replaced
    # every lone surrogate, at its own decode boundary (ruling T5-A, T7-C) —
    # `result.text` and `result.notes` are clean and encodable by
    # construction, so nothing here scrubs or re-encodes a second time.
    # The 64 KiB cap (ruling T7-A) is applied to body + notes COMPOSED
    # together, once, so neither the success return nor the isError failure
    # can slip past it by capping only one half.
    text = result.text if result.text else "(the server returned no text)"
    body = _capped(f"{text}{_notes_text(result.notes)}")
    if result.is_error:
        # A server's isError is a failed call, in its own words.
        raise ToolFailure(f"{label} reported an error: {body}")
    return f"{label}:\n{body}"


def _obj(properties: dict, required: list[str]) -> dict:
    return {
        "type": "object",
        "properties": properties,
        "required": required,
        "additionalProperties": False,
    }


TOOLS: tuple[Tool, ...] = (
    Tool(
        name="mcp_connect",
        description=(
            "Connect Nova to an MCP server over HTTP, so its tools can be run with mcp_call. "
            "Give it a short name (2-32 lowercase letters, digits, - or _), the server's MCP "
            "endpoint URL, and the token or extra headers it needs. The server is asked what it "
            "offers before anything is saved; one that does not answer is not saved, and the "
            "reason is given. A name already in use is replaced."
        ),
        parameters=_obj(
            {
                "name": {"type": "string"},
                "url": {"type": "string", "description": "the MCP endpoint, e.g. https://host/mcp"},
                "token": {
                    "type": "string",
                    "description": (
                        "sent as Authorization: Bearer <token>; stored, never shown again"
                    ),
                },
                "headers": {"type": "object", "description": "extra HTTP headers, name to value"},
            },
            ["name", "url"],
        ),
        executor=mcp_connect,
        # The URL is a connection address, and its own PATH can be the secret
        # (ha-mcp authenticates by one, with no token or header beside it to
        # catch by) — so only its origin may ever reach the trace (S37a,
        # ruling X2-REVISED). `token` and `headers`' values are masked by key
        # regardless (chat._redact); this is for the one argument that isn't.
        traced_as_origin=("url",),
    ),
    Tool(
        name="mcp_disconnect",
        description=(
            "Remove a connected MCP server by its name. Its token is deleted and its tools can "
            "no longer be run."
        ),
        parameters=_obj({"name": {"type": "string"}}, ["name"]),
        executor=mcp_disconnect,
    ),
    Tool(
        name="mcp_tools",
        description=(
            "Look up a connected MCP server's tools and the inputs each one takes (its JSON "
            "Schema). With a query, only the tools whose name or description contains every "
            "word of it. Read a tool's inputs here before the first mcp_call to it."
        ),
        parameters=_obj(
            {
                "server": {"type": "string"},
                "query": {"type": "string", "description": "words to match, e.g. 'workflow runs'"},
            },
            ["server"],
        ),
        executor=mcp_tools,
        # A live reading of what a server offers now; it may refresh the STORED
        # copy of that list — a record of what the server says, never a change
        # to anything outside Nova — and is never run unasked (plan P10, P25).
        ephemeral=True,
        reads_only=True,
    ),
    Tool(
        name="mcp_call",
        description=(
            "Run one tool on a connected MCP server: the server's name, the tool's name, and "
            "the tool's own inputs as its schema in mcp_tools says. The answer is the server's "
            "own words; a tool that reports an error comes back as a failed call with the "
            "server's reason."
        ),
        parameters=_obj(
            {
                "server": {"type": "string"},
                "tool": {"type": "string"},
                "arguments": {"type": "object", "description": "the tool's inputs"},
            },
            ["server", "tool"],
        ),
        executor=mcp_call,
        # What a third party answers is a point-in-time reading ("CI is red")
        # that goes stale, so a turn that ran one is not ingested into
        # long-term memory — the device_notify declaration: ephemeral, and
        # NOT reads_only, because a call may also change something (plan P26).
        ephemeral=True,
    ),
)
