"""Her browser (S38): five tools that drive the engine through app/browser.

browser_open opens a page and outlines it; browser_read reads it in parts or
searches it; browser_act clicks, types, selects, presses, and answers a
dialog; browser_back goes back; browser_screenshot saves a picture of the page
into her workspace. Each says what the engine REPORTED — the page it is on, a
dialog the page opened, a file it downloaded — and files a `browser` fact per
page it saw, so the guards and Activity read facts, never prose.

An address is never shown or recorded with its user info, query or fragment:
a reset or sign-in link carries its token there (ruling G6). `app.addresses`
(ruling G16) holds the one parse this and `chat._address_without_secrets`
both need, and its `scrub` reduces an address found inside free text the SAME
way — the engine's own error (a navigation failure names the address it
tried), a dialog's message, and the accessible name the engine's own code
says it acted on are all a PAGE's words, never ours, and every one of them
passes through it before it reaches a result or a fact.

While a dialog is open the engine refuses every other call and echoes the
SAME modal state on that refusal — `_dialog_block` is the one check, run on
every answer before its `error` is shown raw, that gives HER the dialog
instead of the engine's own tool names (fix round 1, I2). A ref she sends
`browser_act` is reduced to the engine's own shape first, or refused before
anything is sent — the pinned engine runs anything else as a Playwright
selector, not a refusal (I3). A download the engine reported is brought into
the workspace, and its fact filed, before any of these checks — so a call
that then fails still says so (I4); every file copy runs OUTSIDE
`engine.session()`'s lock (G10).
"""

from __future__ import annotations

import asyncio
from datetime import UTC, datetime
from urllib.parse import urlsplit

from app import addresses
from app.browser import engine, files, reader
from app.browser.page import Dialog, EngineAnswer, clip
from app.tools.base import Tool, ToolContext, ToolFailure

ACTIONS = ("click", "type", "select", "press", "accept", "dismiss")
_NEEDS_REF = frozenset({"click", "type", "select"})
_NEEDS_VALUE = {
    "type": "the text to type",
    "select": "the option to choose, as the page names it",
    "press": "a key name such as Enter, Tab or ArrowDown",
}
_ANSWER_A_DIALOG = 'answer it with browser_act(action="accept") or browser_act(action="dismiss")'
# A dialog's own message, as the engine passes it through: whole, up to the
# 4 MiB an answer may carry. Clipped (fix round 1, m8) before it ever enters
# a result — her own working text, never a second copy of the page.
_DIALOG_MESSAGE_MAX_CHARS = 2_000


def address(url: str | None) -> str | None:
    """An address as a fact holds it: scheme, host and path — no user,
    query or fragment. A call to `app.addresses.shown` (ruling G16, fix
    round 1 m7) — the one parse an address needs, shared with
    `chat._address_without_secrets`'s trace-masked rendering of the same
    value."""
    return addresses.shown(url)


def _shown(url: str | None) -> str:
    """An address as she reads it: the fact's form, with a mark where a
    query or fragment was left out, clipped (S38 final review, I1) — a page
    can redirect to a path as long as it likes."""
    if not url:
        return "the page"
    kept = address(url) or url
    hidden = "?" in url or "#" in url
    return clip(f"{kept}?…" if hidden else kept)


def _said(text: str) -> str:
    """Words a page or the engine chose — a title, a status text, the name
    of what it acted on, its own error — as they reach a result, a fact or
    a span: scrubbed of any address's secrets FIRST, then clipped (S38
    final review, I1). A 200,000-character title came back whole before
    this, in the result and in the span's facts."""
    return clip(addresses.scrub(text))


def _dialog_message(dialog: Dialog) -> str:
    """A dialog's message, clipped (fix round 1 m8) then scrubbed (m1) — a
    page chooses this text and the engine passes it through whole, and
    clipping first means a scrub, linear or not, is never asked to read all
    4 MiB a page could put here."""
    text = dialog.message
    if len(text) > _DIALOG_MESSAGE_MAX_CHARS:
        cut = _DIALOG_MESSAGE_MAX_CHARS
        text = f"{text[:cut]}… [cut off at {cut:,} characters]"
    return addresses.scrub(text)


def _how_to_answer(dialog: Dialog) -> str:
    """How `browser_act` answers `dialog` (fix round 1 m4): a file chooser
    has no accept — attempting it is refused by the engine itself, which
    `_dialog_block` already turns into this same sentence — so only dismiss
    is ever offered for one."""
    if "file" in dialog.kind.lower():
        return 'dismiss it with browser_act(action="dismiss")'
    return _ANSWER_A_DIALOG


def _a(word: str) -> str:
    return f"an {word}" if word[:1].lower() in "aeiou" else f"a {word}"


def _dialog_lines(answer: EngineAnswer) -> list[str]:
    """A dialog that opened as part of an otherwise SUCCESSFUL answer —
    never the blocking case, which `_dialog_block` raises before this is
    ever reached."""
    lines = []
    for dialog in answer.dialogs:
        said = f': "{_dialog_message(dialog)}"' if dialog.message else ""
        lines.append(f"The page opened {_a(dialog.kind)} dialog{said} — {_how_to_answer(dialog)}.")
    return lines


def _blocked_by_dialog_message(dialog: Dialog) -> str:
    said = f' ("{_dialog_message(dialog)}")' if dialog.message else ""
    return f"{_a(dialog.kind)} dialog is open on the page{said} — {_how_to_answer(dialog)} first"


def _dialog_block(answer: EngineAnswer, notes: list[str]) -> None:
    """Raise HER words for an open dialog — never the engine's own ('Tool
    "browser_navigate" does not handle the modal state.', which names a
    tool she does not have) — when `answer` is a REFUSAL the dialog caused
    (fix round 1, I2). The engine refuses every other call while a dialog
    is open and echoes the SAME modal state on that refusal, so every one
    of her five tools checks this, on every answer, before `error` is ever
    shown raw. Not fired on a successful answer that merely reports a new
    dialog opening (`_dialog_lines` handles that one)."""
    if not (answer.error and answer.dialogs):
        return
    raise _fail(_blocked_by_dialog_message(answer.dialogs[0]), notes)


def _fail(message: str, notes: list[str]) -> ToolFailure:
    """A stated refusal that still carries whatever this call already
    determined (fix round 1, I4): a download the engine reported is
    brought into the workspace, and removed from the engine's own volume,
    before any of the checks below ever run — so a call that THEN fails
    for an unrelated reason still says so. The engine reports a finished
    download once; dropping `notes` here would mean she is never told."""
    return ToolFailure("\n".join([message, *notes]))


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
                "title": _said(answer.title) if answer.title else None,
                "status": answer.status,
            },
        )


def _where(answer: EngineAnswer, fallback: str | None = None) -> str:
    title = f' — "{_said(answer.title)}"' if answer.title else ""
    return f"{_shown(answer.url or fallback)}{title}"


def _size(count: int) -> str:
    if count < 1024:
        return f"{count} bytes"
    if count < 1024 * 1024:
        return f"{count / 1024:.0f} KB"
    return f"{count / (1024 * 1024):.1f} MB"


def _read_and_outline(snapshot: str, part_chars: int = reader.DEFAULT_PART_CHARS):
    """`reader.read` and `reader.outline`, together in the ONE `to_thread`
    call `browser_open` makes (fix round 1, m6): calling `outline` back on
    the event loop after the `await` cost 262 ms on a 4 MiB, 128k-node page
    (measured), on top of `read`'s own cost."""
    read = reader.read(snapshot, part_chars)
    return read, reader.outline(read)


def _read_and_search(snapshot: str, part_chars: int, query: str):
    """`reader.read` and, when there is a query, `reader.search` too — in
    the ONE `to_thread` call `browser_read` makes (fix round 1, m6): calling
    `search` back on the event loop after the `await` cost 73 ms on a 4 MiB
    page (measured), on top of `read`'s own cost."""
    read = reader.read(snapshot, part_chars)
    return (read, reader.search(read, query)) if query else (read, None)


def _canonical_ref(ref: str) -> str | None:
    """`ref` reduced to the engine's own ref shape, `(f<digits>)?e<digits>`
    — stripping ONE pair of surrounding brackets first, the form
    `browser_read` itself prints (`[e12]`) — or None when it is not one
    (fix round 1, I3). The pinned engine treats anything else as a
    Playwright SELECTOR and acts on whatever it matches: `ref="button"` or
    `"#pay"` would act on the first match of that CSS selector, and the
    bracketed form `browser_read` prints would run as an attribute selector
    instead of naming the element it refers to. Str methods only, one pass."""
    if ref.startswith("[") and ref.endswith("]"):
        ref = ref[1:-1]
    i, n = 0, len(ref)
    if i < n and ref[i] == "f":
        j = i + 1
        while j < n and ref[j].isdigit():
            j += 1
        if j == i + 1:  # "f" with no digits after it
            return None
        i = j
    if i >= n or ref[i] != "e":
        return None
    i += 1
    start = i
    while i < n and ref[i].isdigit():
        i += 1
    if i == start or i != n:  # no digits, or something trails them
        return None
    return ref


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
    `exc.reason`'s prose, and filed as a fact of its own (whatever a tool
    could determine about the engine settles something, win or lose).
    `exc.reason` itself is shown exactly as the client determined it, with
    no claim of this module's own added on top (fix round 1, m3 — the
    first version said "is not answering at {origin} — {reason}" even when
    `reason` already named that SAME origin, doubling it, and even when the
    client's own words said something narrower than "not answering" —
    nothing was SENT, say, rather than sent and unanswered)."""
    try:
        return await engine.call(tool, arguments)
    except engine.EngineError as exc:
        if exc.reachable is not None:
            _fact(ctx, {"browser": "engine", "reachable": exc.reachable})
        raise ToolFailure(_said(exc.reason)) from exc


# ── browser_open ────────────────────────────────────────────────────────────


async def browser_open(args: dict, ctx: ToolContext) -> str:
    url = args["url"].strip()
    try:
        scheme = urlsplit(url).scheme.lower()
    except ValueError as exc:
        # fix round 1, m11: urlsplit raises on some malformed strings (an
        # unterminated IPv6 host) — a stated refusal, never a crash dispatch
        # has to catch and log as a bug she did not cause.
        #
        # fix round 2, A: `url` itself is never echoed here — `_shown` (str
        # methods, never raising even on a value `urlsplit` itself could
        # not read) is what reached the model, the result and the span
        # before this fix; `{url!r}` reached all three unmasked.
        # `str(exc)` is kept: checked directly (urlsplit's ValueError on
        # every malformed shape this module can construct says only
        # "Invalid IPv6 URL", never a word of the value itself).
        raise ToolFailure(f"{_shown(url)} does not parse as a web address: {exc}") from exc
    if scheme not in ("http", "https"):
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
    _dialog_block(opened, notes)
    if opened.error:
        raise _fail(f"{_shown(url)} did not open: {_said(opened.error)}", notes)
    if opened.status is not None and opened.status >= 400:
        _page_fact(ctx, opened)
        status = f"{opened.status} {_said(opened.status_text)}".rstrip()
        raise _fail(
            f"{_shown(opened.url or url)} answered {status} — the browser now shows the "
            "site's error page; browser_read can read it",
            notes,
        )
    if opened.dialogs:
        _page_fact(ctx, opened)
        return "\n".join([f"Opened {_where(opened, url)}.", *_dialog_lines(opened), *notes])
    assert snap is not None  # the condition above is exactly when it was fetched
    _dialog_block(snap, notes)
    if snap.error:
        _page_fact(ctx, opened)
        raise _fail(
            f"{_shown(opened.url or url)} opened, and could not be read: {_said(snap.error)}",
            notes,
        )
    if snap.snapshot is None:
        # fix round 1, m10: no "### Snapshot" at all is not the same fact as
        # an empty one (a genuinely blank page) — say so, never guess.
        _page_fact(ctx, opened)
        raise _fail("the engine returned no snapshot of the page", notes)
    # fix round 1, m9: back the shown address with the SAME answer it comes
    # from — a client-side redirect between navigate and snapshot means
    # `snap`'s own URL/title, not `opened`'s, is what she is about to read.
    source = snap if snap.url else opened
    _page_fact(ctx, source)
    read, outline = await asyncio.to_thread(_read_and_outline, snap.snapshot)
    lines = [f"Opened {_where(source, url)}."]
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
    _dialog_block(snap, notes)
    if snap.error:
        raise _fail(f"the page could not be read: {_said(snap.error)}", notes)
    if snap.snapshot is None:
        raise _fail("the engine returned no snapshot of the page", notes)  # fix round 1, m10
    _page_fact(ctx, snap)
    query = (args.get("query") or "").strip()
    read, searched = await asyncio.to_thread(_read_and_search, snap.snapshot, part_chars, query)
    count = len(read.parts)
    head = f"{_where(snap)}"
    if query:
        matches, total = searched
        if not matches:
            parts = f"{count} part{'s' if count != 1 else ''}"
            return "\n".join([head, *notes, f"No line holds every word of {query!r} ({parts})."])
        held = "1 line holds" if total == 1 else f"{total:,} lines hold"
        # fix round 1, m12: the tool's own lines (the header, any notes) come
        # before every search snippet, so a page cannot forge one by its
        # position alone.
        lines = [f"{head} · {held} every word of {query!r}:", *notes]
        for match in matches:
            under = f" under {match.heading!r}" if match.heading else ""
            lines.append(f"- part {match.part}{under}: {match.text}")
        if total > len(matches):
            lines.append(f"…and {total - len(matches)} more; use more words, or read a part.")
        return "\n".join(lines)
    wanted = int(args.get("part") or 1)
    if wanted > count:
        raise _fail(
            f"the page has {count} part{'s' if count != 1 else ''}; there is no part {wanted}",
            notes,
        )
    body = read.parts[wanted - 1] or "(The page has no text.)"
    # fix round 1, m12: her own lines before the page's, with a marker line
    # naming exactly where the page's own text starts — a page cannot print
    # a line further up that reads as if it were one of these.
    lines = [head, *notes, f"Page text (part {wanted} of {count}):", "", body]
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
    # fix round 1, m1: `acted_on` is the PAGE's own accessible name for
    # whatever the engine's code targeted — a link named with its own
    # token-bearing URL is a page's words, exactly like a dialog message.
    target = _said(answer.acted_on) if answer.acted_on else (f"[{ref}]" if ref else "the page")
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
    # Not stripped (fix round 1, I3): " e12" or "e12 " must be refused, not
    # silently cleaned up into a ref that would then be sent as one.
    ref = args.get("ref") or ""
    value = args.get("value")
    if action in _NEEDS_REF:
        if not ref:
            raise ToolFailure(
                f"{action} needs the ref of an element, like e12, from browser_read — "
                "re-issue the call"
            )
        canonical = _canonical_ref(ref)
        if canonical is None:
            # fix round 1, I3: refused before anything is sent — the pinned
            # engine would otherwise run this as a Playwright selector.
            raise ToolFailure(
                f"{ref!r} is not shaped like a ref — a ref looks like e12 or f1e3, exactly as "
                "browser_read lists elements — re-issue the call with one of those"
            )
        ref = canonical
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
    _dialog_block(answer, notes)
    if answer.error:
        if "not found in the current page snapshot" in answer.error:
            raise _fail(
                f"{ref or 'that element'} is no longer on the page — refs change when the page "
                "does; read the page again (browser_read) and use a new ref",
                notes,
            )
        raise _fail(f"the engine refused: {_said(answer.error)}", notes)
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
    _dialog_block(answer, notes)
    if answer.error:
        raise _fail(f"could not go back: {_said(answer.error)}", notes)
    _page_fact(ctx, answer)
    if not answer.url:
        return "\n".join(["Went back; the engine reported no page.", *notes])
    return "\n".join([f"Back on {_where(answer)}.", *_dialog_lines(answer), *notes])


# ── browser_screenshot ──────────────────────────────────────────────────────


async def browser_screenshot(args: dict, ctx: ToolContext) -> str:
    async with engine.session():
        answer = await _call("browser_take_screenshot", {"type": "png", "scale": "css"}, ctx)
    notes = await _bring_downloads(ctx, answer)  # G10 + the Task 2 carry: outside the lock
    _dialog_block(answer, notes)
    if answer.error:
        raise _fail(f"no screenshot was taken: {_said(answer.error)}", notes)
    if not answer.files:
        raise _fail("the engine took no screenshot file it could name", notes)
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
        raise _fail(
            f"a screenshot was taken and did not reach the workspace: {exc}", notes
        ) from exc
    _fact(ctx, {"browser": "screenshot", "path": brought.path, "bytes": brought.bytes})
    line = (
        f"Saved a screenshot of the page to {brought.path} ({_size(brought.bytes)}). The image "
        "is in the workspace; it is not read into this conversation."
    )
    if brought.left_in_engine:  # Task 3 carry
        line += f" The engine's copy could not be removed: {brought.left_in_engine}."
    return "\n".join([line, *notes])


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
