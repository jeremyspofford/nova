"""Her browser (S38): five tools that drive the engine through app/browser.

browser_open opens a page and outlines it; browser_read reads it in parts or
searches it; browser_act clicks, types, selects, presses, and answers a
dialog; browser_back goes back; browser_screenshot saves a picture of the page
into her workspace. Each says what the engine REPORTED — the page it is on, a
dialog the page opened, a file it downloaded — and files a `browser` fact per
page it saw, so the guards and Activity read facts, never prose.

An address is never shown or recorded with its user info, query or fragment:
a reset or sign-in link carries its token there (ruling G6). The same scrub
also runs over the engine's own free-text error (a navigation failure names
the address it tried) and a dialog's own message, since a page chooses both.
What she types is never echoed back. The engine's own code section, which
holds both, never leaves app/browser/page.py.

A call the transport itself could not make (the engine unreachable, a broken
exchange) raises `engine.EngineError`, whose structured `reachable` this
module reads directly — never parsed out of its prose (ruling G31) — both to
compose the one sentence every tool gives when the engine is not answering,
and to file what was determined about reachability as a fact of its own.

Every file copy a tool brings in from the engine's own volume runs OUTSIDE
`engine.session()`'s lock (ruling G10): a slow or large copy must not hold
every other browser call hostage, and a download can finish between two
calls, so each tool checks every answer it receives for one (a Task 2 carry).
"""

from __future__ import annotations

import asyncio
from datetime import UTC, datetime
from urllib.parse import urlsplit

from app.browser import engine, files, reader
from app.browser.page import EngineAnswer
from app.tools.base import Tool, ToolContext, ToolFailure

ACTIONS = ("click", "type", "select", "press", "accept", "dismiss")
_NEEDS_REF = frozenset({"click", "type", "select"})
_NEEDS_VALUE = {
    "type": "the text to type",
    "select": "the option to choose, as the page names it",
    "press": "a key name such as Enter, Tab or ArrowDown",
}
_ANSWER_A_DIALOG = 'answer it with browser_act(action="accept") or browser_act(action="dismiss")'
_URL_SCHEMES = ("https://", "http://")
# Characters that end a URL found inside free text — the engine's own prose
# (a navigation error) or a page's (a dialog message) might quote or bracket
# one. Not exhaustive of every character a URL may never legally contain;
# just the ones a sentence around it would plausibly use to set it off.
_URL_STOP_CHARS = "\"'()[]<>"


def address(url: str | None) -> str | None:
    """An address as a fact holds it: scheme, host and path — no user info,
    query or fragment."""
    if not url:
        return None
    try:
        parts = urlsplit(url)
    except ValueError:
        return url.split("?", 1)[0].split("#", 1)[0]
    if not parts.scheme or not parts.netloc:
        return url.split("?", 1)[0].split("#", 1)[0]
    return f"{parts.scheme}://{parts.netloc.rpartition('@')[2]}{parts.path}"


def _shown(url: str | None) -> str:
    """An address as she reads it: the fact's form, with a mark where a query
    or fragment was left out."""
    if not url:
        return "the page"
    kept = address(url) or url
    hidden = "?" in url or "#" in url
    return f"{kept}?…" if hidden else kept


def _scrub(text: str) -> str:
    """`text`, with every http(s) URL inside it reduced to its address (ruling
    G6): no query, fragment or user info. The engine's own prose can carry
    the page a call was trying to reach (a navigation error names it), and a
    page's own dialog message can carry whatever it wants — a reset or
    sign-in link carries its token in the query either way.

    One pass, str methods only: each URL is found by its scheme and runs to
    the next character that cannot be part of one (whitespace, or a quote or
    bracket a sentence would use to set it off). `i` only ever moves forward,
    so the total work across every loop is bounded by `len(text)` once, the
    same as a single scan — not by how many URLs it finds."""
    if "://" not in text:
        return text
    out: list[str] = []
    i = 0
    n = len(text)
    while True:
        at = -1
        for scheme in _URL_SCHEMES:
            found = text.find(scheme, i)
            if found != -1 and (at == -1 or found < at):
                at = found
        if at == -1:
            out.append(text[i:])
            return "".join(out)
        out.append(text[i:at])
        end = at
        while end < n and not text[end].isspace() and text[end] not in _URL_STOP_CHARS:
            end += 1
        out.append(address(text[at:end]) or text[at:end])
        i = end


def _fact(ctx: ToolContext, fact: dict) -> None:
    if ctx.facts_sink is not None:
        ctx.facts_sink.append(fact)


def _page_fact(ctx: ToolContext, answer: EngineAnswer) -> None:
    if answer.url:
        _fact(
            ctx,
            {
                "browser": "page",
                "url": address(answer.url),
                "title": answer.title,
                "status": answer.status,
            },
        )


def _where(answer: EngineAnswer, fallback: str | None = None) -> str:
    title = f' — "{answer.title}"' if answer.title else ""
    return f"{_shown(answer.url or fallback)}{title}"


def _size(count: int) -> str:
    if count < 1024:
        return f"{count} bytes"
    if count < 1024 * 1024:
        return f"{count / 1024:.0f} KB"
    return f"{count / (1024 * 1024):.1f} MB"


def _a(word: str) -> str:
    return f"an {word}" if word[:1].lower() in "aeiou" else f"a {word}"


def _dialog_lines(answer: EngineAnswer) -> list[str]:
    lines = []
    for dialog in answer.dialogs:
        said = f': "{_scrub(dialog.message)}"' if dialog.message else ""
        lines.append(f"The page opened {_a(dialog.kind)} dialog{said} — {_ANSWER_A_DIALOG}.")
    return lines


async def _bring_downloads(ctx: ToolContext, answer: EngineAnswer) -> list[str]:
    """Each finished download brought into this turn's workspace, as lines to
    tell her — a failure is a line too, never dropped. Called on EVERY
    engine answer a tool receives (a Task 2 carry): a download that finishes
    after the call that triggered it is reported on the NEXT one, and the
    copy itself runs here, after `engine.session()` has already been left
    (ruling G10) — never while it is held."""
    lines = []
    for name, engine_path in answer.downloads:
        try:
            brought = await asyncio.to_thread(
                files.bring_in,
                engine_path,
                output_dir=files.output_dir_from_env(),
                workspace_root=ctx.workspace_root,
                folder="downloads",
                name=name,
            )
        except files.HandoffError as exc:
            lines.append(f"A download did not reach the workspace: {exc}.")
            continue
        _fact(ctx, {"browser": "download", "path": brought.path, "bytes": brought.bytes})
        line = f"Downloaded {brought.path} ({_size(brought.bytes)})"
        if brought.left_in_engine:
            # Task 3 carry: her copy is safe in the workspace either way —
            # this says the engine's own is still there too, never a failure.
            line += f"; the engine's copy could not be removed: {brought.left_in_engine}"
        lines.append(f"{line}.")
    return lines


async def _call(tool: str, arguments: dict, ctx: ToolContext) -> EngineAnswer:
    """One call inside the caller's `engine.session()`. A call the engine
    itself answered — even with its own refusal — returns normally; only a
    call the transport could not make raises, as a stated ToolFailure.

    `exc.reachable` (ruling G31) is read directly, never parsed out of
    `exc.reason`'s prose: it is filed as a fact of its own (whatever a tool
    could determine about the engine settles something, win or lose), and it
    alone decides whether she is told the engine is not answering at all —
    the one sentence every one of her five tools gives for that, verbatim —
    or given the engine's own, more specific words."""
    try:
        return await engine.call(tool, arguments)
    except engine.EngineError as exc:
        if exc.reachable is not None:
            _fact(ctx, {"browser": "engine", "reachable": exc.reachable})
        if exc.reachable:
            raise ToolFailure(_scrub(exc.reason)) from exc
        origin = engine.endpoint().origin
        raise ToolFailure(
            f"the browser engine is not answering at {origin} — {_scrub(exc.reason)}"
        ) from exc


# ── browser_open ────────────────────────────────────────────────────────────


async def browser_open(args: dict, ctx: ToolContext) -> str:
    url = args["url"].strip()
    if urlsplit(url).scheme.lower() not in ("http", "https"):
        raise ToolFailure(f"the browser opens http and https addresses only, not {_shown(url)}")
    snap: EngineAnswer | None = None
    async with engine.session():
        opened = await _call("browser_navigate", {"url": url}, ctx)
        # The snapshot is only worth asking for when there will be a page to
        # read: not on an engine-level error, not under a dialog the engine
        # would refuse anyway, and not on a 4xx/5xx the status check below
        # turns into a stated failure before any text is shown.
        if (
            not opened.error
            and not opened.dialogs
            and not (opened.status is not None and opened.status >= 400)
        ):
            snap = await _call("browser_snapshot", {}, ctx)
    # G10: every file copy below runs OUTSIDE the lock just released — on
    # BOTH answers this call received (the Task 2 carry), whichever of them
    # turns out to matter to what is returned next.
    notes = await _bring_downloads(ctx, opened)
    if snap is not None:
        notes += await _bring_downloads(ctx, snap)
    if opened.error:
        raise ToolFailure(f"{_shown(url)} did not open: {_scrub(opened.error)}")
    _page_fact(ctx, opened)
    if opened.status is not None and opened.status >= 400:
        status = f"{opened.status} {opened.status_text}".rstrip()
        raise ToolFailure(
            f"{_shown(opened.url or url)} answered {status} — the browser now shows the "
            "site's error page; browser_read can read it"
        )
    if opened.dialogs:
        return "\n".join([f"Opened {_where(opened, url)}.", *_dialog_lines(opened), *notes])
    assert snap is not None  # the condition above is exactly when it was fetched
    if snap.error:
        raise ToolFailure(
            f"{_shown(opened.url or url)} opened, and could not be read: {_scrub(snap.error)}"
        )
    read = await asyncio.to_thread(reader.read, snap.snapshot or "")
    outline = reader.outline(read)
    lines = [f"Opened {_where(snap if snap.url else opened, url)}."]
    if outline.headings:
        more = f" (and {outline.more_headings} more)" if outline.more_headings else ""
        lines.append("Headings: " + "; ".join(outline.headings) + more + ".")
    parts = len(read.parts)
    lines.append(
        f"It has {outline.links} links, {outline.buttons} buttons and {outline.fields} fields; "
        f"{read.chars:,} characters of text in {parts} part{'s' if parts != 1 else ''} of "
        f"{reader.DEFAULT_PART_CHARS:,}."
    )
    lines.append('Read it with browser_read(part=1), or search it with browser_read(query="…").')
    lines.extend(notes)
    return "\n".join(lines)


# ── browser_read ────────────────────────────────────────────────────────────


async def browser_read(args: dict, ctx: ToolContext) -> str:
    part_chars = int(args.get("max_chars") or reader.DEFAULT_PART_CHARS)
    async with engine.session():
        snap = await _call("browser_snapshot", {}, ctx)
    notes = await _bring_downloads(ctx, snap)  # G10 + the Task 2 carry: outside the lock
    if snap.dialogs:
        dialog = snap.dialogs[0]
        said = f' ("{_scrub(dialog.message)}")' if dialog.message else ""
        raise ToolFailure(
            f"{_a(dialog.kind)} dialog is open on the page{said} — {_ANSWER_A_DIALOG} first"
        )
    if snap.error:
        raise ToolFailure(f"the page could not be read: {_scrub(snap.error)}")
    _page_fact(ctx, snap)
    read = await asyncio.to_thread(reader.read, snap.snapshot or "", part_chars)
    count = len(read.parts)
    head = f"{_where(snap)}"
    query = (args.get("query") or "").strip()
    if query:
        matches, total = reader.search(read, query)
        if not matches:
            parts = f"{count} part{'s' if count != 1 else ''}"
            return "\n".join([head, f"No line holds every word of {query!r} ({parts}).", *notes])
        held = "1 line holds" if total == 1 else f"{total:,} lines hold"
        lines = [f"{head} · {held} every word of {query!r}:"]
        for match in matches:
            under = f" under {match.heading!r}" if match.heading else ""
            lines.append(f"- part {match.part}{under}: {match.text}")
        if total > len(matches):
            lines.append(f"…and {total - len(matches)} more; use more words, or read a part.")
        lines.extend(notes)
        return "\n".join(lines)
    wanted = int(args.get("part") or 1)
    if wanted > count:
        raise ToolFailure(
            f"the page has {count} part{'s' if count != 1 else ''}; there is no part {wanted}"
        )
    body = read.parts[wanted - 1] or "(The page has no text.)"
    lines = [f"{head} · part {wanted} of {count}", "", body]
    lines.extend(notes)
    return "\n".join(lines)


# ── browser_act ─────────────────────────────────────────────────────────────


def _engine_call(action: str, ref: str, value: str | None, submit: bool) -> tuple[str, dict]:
    if action == "click":
        return "browser_click", {"target": ref}
    if action == "type":
        arguments = {"target": ref, "text": value}
        if submit:
            arguments["submit"] = True
        return "browser_type", arguments
    if action == "select":
        return "browser_select_option", {"target": ref, "values": [value]}
    if action == "press":
        return "browser_press_key", {"key": value}
    if action == "accept":
        return "browser_handle_dialog", {"accept": True, **({"promptText": value} if value else {})}
    return "browser_handle_dialog", {"accept": False}


def _did(action: str, answer: EngineAnswer, ref: str, value: str | None) -> str:
    target = answer.acted_on or (f"[{ref}]" if ref else "the page")
    if action == "click":
        return f"Clicked {target}"
    if action == "type":
        return f"Typed {len(value or '')} characters into {target}"
    if action == "select":
        return f'Selected "{value}" in {target}'
    if action == "press":
        return f"Pressed {value}"
    if action == "accept":
        return "Accepted the dialog"
    return "Dismissed the dialog"


async def browser_act(args: dict, ctx: ToolContext) -> str:
    action = (args.get("action") or "").strip().lower()
    if action not in ACTIONS:
        raise ToolFailure(f"action must be one of {', '.join(ACTIONS)} — re-issue the call")
    ref = (args.get("ref") or "").strip()
    value = args.get("value")
    if action in _NEEDS_REF and not ref:
        raise ToolFailure(
            f"{action} needs the ref of an element, like e12, from browser_read — re-issue the call"
        )
    if action in _NEEDS_VALUE and not (isinstance(value, str) and value):
        raise ToolFailure(f"{action} needs a value: {_NEEDS_VALUE[action]} — re-issue the call")
    tool, arguments = _engine_call(action, ref, value, bool(args.get("submit")))
    async with engine.session():
        answer = await _call(tool, arguments, ctx)
        if (
            answer.error
            and action == "dismiss"
            and any("file" in d.kind.lower() for d in answer.dialogs)
        ):
            # A file chooser is not a dialog to the engine; an upload with no
            # files cancels it (the engine's documented cancel; unmeasured).
            answer = await _call("browser_file_upload", {}, ctx)
    notes = await _bring_downloads(ctx, answer)  # G10: outside the lock just released
    if answer.error:
        if "not found in the current page snapshot" in answer.error:
            raise ToolFailure(
                f"{ref or 'that element'} is no longer on the page — refs change when the page "
                "does; read the page again (browser_read) and use a new ref"
            )
        raise ToolFailure(f"the engine refused: {_scrub(answer.error)}")
    _page_fact(ctx, answer)
    lines = [f"{_did(action, answer, ref, value)}."]
    if answer.url:
        lines.append(f"The page is now {_where(answer)}.")
    lines.extend(_dialog_lines(answer))
    lines.extend(notes)
    if len(lines) == 1:
        lines.append("The engine reported no new page, dialog or download.")
    return "\n".join(lines)


# ── browser_back ────────────────────────────────────────────────────────────


async def browser_back(args: dict, ctx: ToolContext) -> str:
    async with engine.session():
        answer = await _call("browser_navigate_back", {}, ctx)
    notes = await _bring_downloads(ctx, answer)  # G10 + the Task 2 carry: outside the lock
    if answer.error:
        raise ToolFailure(f"could not go back: {_scrub(answer.error)}")
    _page_fact(ctx, answer)
    if not answer.url:
        return "\n".join(["Went back; the engine reported no page.", *notes])
    return "\n".join([f"Back on {_where(answer)}.", *_dialog_lines(answer), *notes])


# ── browser_screenshot ──────────────────────────────────────────────────────


async def browser_screenshot(args: dict, ctx: ToolContext) -> str:
    async with engine.session():
        answer = await _call("browser_take_screenshot", {"type": "png", "scale": "css"}, ctx)
    notes = await _bring_downloads(ctx, answer)  # G10 + the Task 2 carry: outside the lock
    if answer.error:
        raise ToolFailure(f"no screenshot was taken: {_scrub(answer.error)}")
    if not answer.files:
        raise ToolFailure("the engine took no screenshot file it could name")
    stamp = datetime.now(UTC).strftime("%Y%m%dT%H%M%SZ")
    try:
        brought = await asyncio.to_thread(
            files.bring_in,
            answer.files[0],
            output_dir=files.output_dir_from_env(),
            workspace_root=ctx.workspace_root,
            folder="screenshots",
            name=f"{stamp}.png",
        )
    except files.HandoffError as exc:
        raise ToolFailure(f"a screenshot was taken and did not reach the workspace: {exc}") from exc
    _fact(ctx, {"browser": "screenshot", "path": brought.path, "bytes": brought.bytes})
    line = (
        f"Saved a screenshot of the page to {brought.path} ({_size(brought.bytes)}). The image "
        "is in the workspace; it is not read into this conversation."
    )
    if brought.left_in_engine:  # Task 3 carry
        line += f" The engine's copy could not be removed: {brought.left_in_engine}."
    lines = [line, *notes]
    return "\n".join(lines)


# ── the registry's entries ──────────────────────────────────────────────────

TOOLS: tuple[Tool, ...] = (
    Tool(
        name="browser_open",
        description=(
            "Open a web page in your own browser (http or https) and get its title and an "
            "outline: headings, how many links, buttons and fields, and how many parts its "
            "text fills. Your browser keeps its logins between sessions. Read the page with "
            "browser_read."
        ),
        parameters={
            "type": "object",
            "properties": {
                "url": {"type": "string", "description": "The full http/https address to open."}
            },
            "required": ["url"],
            "additionalProperties": False,
        },
        executor=browser_open,
        reads_only=True,
        # A page is a live read that goes stale, like fetch_url's: a turn that
        # read one is not ingested into memory.
        ephemeral=True,
    ),
    Tool(
        name="browser_read",
        description=(
            "Read the page your browser is on: its text, with every link, button and field "
            "marked by a ref like [e12] that browser_act takes. A long page comes in parts — "
            "read part 1, then 2 — or search it with query to get only the lines holding "
            "every word, with their part numbers."
        ),
        parameters={
            "type": "object",
            "properties": {
                "query": {"type": "string", "description": "Words every returned line must hold."},
                "part": {
                    "type": "integer",
                    "minimum": 1,
                    "description": "Which part to read; 1 first.",
                },
                "max_chars": {
                    "type": "integer",
                    "minimum": reader.MIN_PART_CHARS,
                    "maximum": reader.MAX_PART_CHARS,
                    "description": "How long a part may be (default 24000 characters).",
                },
            },
            "additionalProperties": False,
        },
        executor=browser_read,
        reads_only=True,
        ephemeral=True,
    ),
    Tool(
        name="browser_act",
        description=(
            "Act on the page your browser is on, using a ref from browser_read: click, type "
            "(with submit to press Enter after), select an option, or press a key; or answer "
            "a dialog the page opened with accept or dismiss. Says what the page did: a new "
            "page, a dialog, a download (saved in your downloads folder)."
        ),
        parameters={
            "type": "object",
            "properties": {
                "action": {"type": "string", "enum": list(ACTIONS)},
                "ref": {"type": "string", "description": "The element's ref, like e12."},
                "value": {
                    "type": "string",
                    "description": (
                        "What to type, the option to select, the key to press, or a "
                        "prompt's answer."
                    ),
                },
                "submit": {"type": "boolean", "description": "For type: press Enter after."},
            },
            "required": ["action"],
            "additionalProperties": False,
        },
        executor=browser_act,
    ),
    Tool(
        name="browser_back",
        description="Go back to the previous page in your browser.",
        parameters={"type": "object", "properties": {}, "additionalProperties": False},
        executor=browser_back,
        reads_only=True,
        ephemeral=True,
    ),
    Tool(
        name="browser_screenshot",
        description=(
            "Save a picture of the page your browser is on into your screenshots folder. The "
            "image is saved, not shown to you."
        ),
        parameters={"type": "object", "properties": {}, "additionalProperties": False},
        executor=browser_screenshot,
    ),
)
