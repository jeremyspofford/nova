"""What the browser engine said, read once (S38).

The engine (Microsoft's Playwright MCP server, pinned in deploy/browser/
Dockerfile) answers every tool call with one markdown text in `### `-headed
sections: Page, Snapshot, Events, Modal state, Result, Error, and the
Playwright code it ran. This module reads that text into a value, and nothing
else. Every shape here is the pinned engine's own, captured 2026-09-30 in
tests/fixtures/browser_engine/v0.0.82/.

Pure: no network, no filesystem, no clock. Linear: str methods only, never a
regular expression, because a page chose the snapshot's text and the names of
the files it downloads.
"""

from __future__ import annotations

from dataclasses import dataclass

# Where the engine writes the files it reports (`--output-dir`, deploy/
# docker-compose.yml). A path outside it is never taken from an answer.
ENGINE_OUTPUT = "/output/"

# The engine writes each section at most once, in this order (coreBundle.js
# _build / renderTabMarkdown). A page's own words can hold a "### "-looking
# line (a dialog message, a typed value); it is never mistaken for a real
# header unless it is this name, strictly later than the last one accepted.
SECTION_ORDER = (
    "Error",
    "Result",
    "Ran Playwright code",
    "Open tabs",
    "Page",
    "Modal state",
    "Snapshot",
    "Events",
)
# ...and nothing after Modal state. While a modal is open the engine's
# captureSnapshot races it and returns no snapshot and no events, so Modal
# state is the last section it writes (captures 13 and 14 end there). Every
# line after its header is the modal bullets' own: a dialog's message is
# interpolated raw, so it can hold a "### " line, or even the bullet's ending.
_LAST_SECTION = SECTION_ORDER.index("Modal state")

# How the engine ends every modal bullet: `]: can be handled by ` and the one
# tool that clears it — browser_handle_dialog for a dialog,
# browser_file_upload for a file chooser (renderModalStates).
_HANDLED_BY = "]: can be handled by "


@dataclass(frozen=True)
class Dialog:
    """A modal the page opened: a dialog, or a file chooser. Until it is
    answered the engine refuses every other tool ("does not handle the modal
    state", measured). One whose bullet never reached the engine's ending (a
    cut-off answer) is still reported, with what could be read of its message."""

    # "alert" | "confirm" | "prompt" | "beforeunload" | "File chooser" | the engine's own word
    kind: str
    message: str  # "" when the engine gave none


@dataclass(frozen=True)
class EngineAnswer:
    url: str | None = None
    title: str | None = None
    status: int | None = None  # the HTTP status, only when the engine reported one
    status_text: str = ""
    snapshot: str | None = None  # the YAML inside ### Snapshot's fence
    dialogs: tuple[Dialog, ...] = ()
    downloads: tuple[tuple[str, str], ...] = ()  # (file name, engine path), each FINISHED
    files: tuple[str, ...] = ()  # engine paths ### Result names (a screenshot)
    error: str | None = None  # ### Error, without "Error: " and the call log
    acted_on: str | None = None  # what the engine's own code says it acted on


def parse(text: str) -> EngineAnswer:
    """Read one engine answer. Unknown sections are ignored; a missing one is
    simply absent from the value — never guessed."""
    sections = _sections(text or "")
    url = title = None
    status: int | None = None
    status_text = ""
    for line in sections.get("Page", ()):
        key, value = _bullet(line)
        if key == "Page URL":
            url = value or None
        elif key == "Page Title":
            title = value or None
        elif key == "HTTP status":
            code, _, words = value.partition(" ")
            if code.isdigit():
                status, status_text = int(code), words.strip()
    return EngineAnswer(
        url=url,
        title=title,
        status=status,
        status_text=status_text,
        snapshot=_fenced(sections.get("Snapshot", ())),
        dialogs=tuple(
            _dialog(bullet, ended)
            for bullet, ended in _dialog_bullets(sections.get("Modal state", []))
        ),
        downloads=tuple(d for d in (_download(line) for line in sections.get("Events", ())) if d),
        files=tuple(f for f in (_result_file(line) for line in sections.get("Result", ())) if f),
        error=_error(sections.get("Error")),
        acted_on=_acted_on("\n".join(sections.get("Ran Playwright code", ()))),
    )


def _sections(text: str) -> dict[str, list[str]]:
    """Split the engine's answer on its own `### ` headers — each accepted
    at most once, only strictly later in SECTION_ORDER than the last one
    accepted, and none after Modal state. A `### ` line that fails that (a
    repeat, one out of order, anything after a modal) is a page's own words,
    never a real header: content of whichever section is currently open,
    exactly like any other line.

    Lines are split on "\\n" alone, as the engine joins them. splitlines()
    also splits on U+2028, U+2029, U+0085 and the like, which a page's title
    keeps raw (document.title collapses ASCII whitespace only): a title could
    forge a whole modal state."""
    sections: dict[str, list[str]] = {}
    current: list[str] | None = None
    seen = -1
    for line in text.split("\n"):
        if line.startswith("### ") and seen < _LAST_SECTION:
            name = line[4:].strip()
            at = SECTION_ORDER.index(name) if name in SECTION_ORDER else -1
            if at > seen:
                seen = at
                current = sections.setdefault(name, [])
                continue
        if current is not None:
            current.append(line)
    return sections


def _bullet(line: str) -> tuple[str, str]:
    if not line.startswith("- "):
        return "", ""
    key, sep, value = line[2:].partition(": ")
    return (key.strip(), value.strip()) if sep else ("", "")


def _fenced(lines: list[str] | tuple[str, ...]) -> str | None:
    body: list[str] = []
    inside = False
    for line in lines:
        if line.startswith("```"):
            if inside:
                return "\n".join(body)
            inside = True
            continue
        if inside:
            body.append(line)
    return "\n".join(body) if inside else None


def _unquote(value: str) -> str:
    """The dialog message between its outer quotes, exactly as the engine
    wrote it. Never JSON-decoded: renderModalStates interpolates the page's
    own `dialog.message()` raw, with no escaping, so a backslash in it (a
    Windows path) is two literal characters, not an escape sequence."""
    value = value.strip()
    if len(value) >= 2 and value[0] == '"' and value[-1] == '"':
        return value[1:-1]
    return value


def _dialog_bullets(lines: list[str]) -> list[tuple[str, bool]]:
    """Modal-state lines regrouped into one bullet per modal, each without
    the engine's ending, and whether it reached one. The message a page chose
    can hold a newline, so a bullet is never just one physical line: it runs
    until a line ending in `]: can be handled by <tool>`, and every line
    before that — a "### " one, a "- [" one — is the message's own. A bullet
    that never reaches an ending is still a modal the page has open, and one
    that blocks every other tool: it is kept, never dropped."""
    bullets: list[tuple[str, bool]] = []
    current: list[str] = []
    for line in lines:
        if not current and not line.startswith("- ["):
            continue  # outside any bullet: never the engine's
        current.append(line)
        end = _ending(line)
        if end != -1:
            current[-1] = line[:end]
            bullets.append(("\n".join(current), True))
            current = []
    if current:
        bullets.append(("\n".join(current), False))
    return bullets


def _ending(line: str) -> int:
    """Where the engine's ending starts in `line` — its last `]: can be
    handled by `, followed by a tool's name and nothing else — or -1."""
    at = line.rfind(_HANDLED_BY)
    if at == -1 or not line[at + len(_HANDLED_BY) :].isidentifier():
        return -1
    return at


def _dialog(bullet: str, ended: bool) -> Dialog:
    # - ["alert" dialog with message "Hello from the page"]: can be handled by browser_handle_dialog
    # - [File chooser]: can be handled by browser_file_upload
    # (the bullet arrives without its ending)
    inner = bullet[3:]
    kind = inner
    if inner.startswith('"'):
        close = inner.find('"', 1)
        kind = inner[1:close] if close > 0 else inner[1:]
    marker = " with message "
    at = inner.find(marker)
    message = ""
    if at != -1:
        said = inner[at + len(marker) :]
        if ended:
            message = _unquote(said)
        else:  # what could be read of it, after its opening quote
            message = said[1:] if said.startswith('"') else said
    return Dialog(kind=kind.strip(), message=message)


def _download(line: str) -> tuple[str, str] | None:
    # - Downloaded file report.txt to "/output/report.txt"
    lead = "- Downloaded file "
    if not line.startswith(lead):
        return None
    name, sep, path = line[len(lead) :].rpartition(' to "')
    if not sep or not path.endswith('"'):
        return None
    path = path[:-1]
    return (name, path) if path.startswith(ENGINE_OUTPUT) else None


def _result_file(line: str) -> str | None:
    # - [Screenshot of viewport](/output/page-2026-09-30T20-25-33-996Z.png)
    if not line.startswith("- [") or not line.endswith(")"):
        return None
    at = line.rfind("](")
    if at == -1:
        return None
    path = line[at + 2 : -1]
    return path if path.startswith(ENGINE_OUTPUT) else None


def _error(lines: list[str] | None) -> str | None:
    if lines is None:
        return None
    text = "\n".join(lines).strip()
    text = text.split("\nCall log:", 1)[0].strip()
    if text.startswith("Error: "):
        text = text[len("Error: ") :]
    if text.startswith("browserBackend.callTool: "):
        text = text[len("browserBackend.callTool: ") :]
    return text or "the engine reported an error and gave no reason"


def _js_string(code: str, start: int) -> tuple[str, int] | None:
    """The single-quoted JS string starting at `start` (its opening quote), and
    the index after it. Backslash escapes are honoured."""
    if start >= len(code) or code[start] != "'":
        return None
    out: list[str] = []
    i = start + 1
    while i < len(code):
        ch = code[i]
        if ch == "\\" and i + 1 < len(code):
            out.append(code[i + 1])
            i += 2
            continue
        if ch == "'":
            return "".join(out), i + 1
        out.append(ch)
        i += 1
    return None


def _acted_on(code: str) -> str | None:
    """What the engine's own code says it acted on — `link "Page two"` — from
    the FIRST locator in the code it ran. Only the locator is read: the
    argument of .fill() is what she typed, and it never leaves this function."""
    role_at = code.find("getByRole(")
    label_at = code.find("getByLabel(")
    text_at = code.find("getByText(")
    found = [
        (at, kind)
        for at, kind in ((role_at, "role"), (label_at, "label"), (text_at, "text"))
        if at != -1
    ]
    if not found:
        return None
    at, kind = min(found)
    if kind == "role":
        role = _js_string(code, at + len("getByRole("))
        if role is None:
            return None
        name_at = code.find("name: ", role[1])
        name = _js_string(code, name_at + len("name: ")) if name_at != -1 else None
        if name is not None and code.find(")", role[1]) > name_at:
            return f'{role[0]} "{name[0]}"'
        return role[0]
    quoted = _js_string(code, at + len("getByLabel(" if kind == "label" else "getByText("))
    return f'{kind} "{quoted[0]}"' if quoted else None
