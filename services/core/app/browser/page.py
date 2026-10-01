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

import json
from dataclasses import dataclass

# Where the engine writes the files it reports (`--output-dir`, deploy/
# docker-compose.yml). A path outside it is never taken from an answer.
ENGINE_OUTPUT = "/output/"


@dataclass(frozen=True)
class Dialog:
    """A modal the page opened. Until it is answered the engine refuses every
    other tool ("does not handle the modal state", measured)."""

    kind: str  # "alert" | "confirm" | "prompt" | "beforeunload" | the engine's own word
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
        dialogs=tuple(d for d in (_dialog(line) for line in sections.get("Modal state", ())) if d),
        downloads=tuple(d for d in (_download(line) for line in sections.get("Events", ())) if d),
        files=tuple(f for f in (_result_file(line) for line in sections.get("Result", ())) if f),
        error=_error(sections.get("Error")),
        acted_on=_acted_on("\n".join(sections.get("Ran Playwright code", ()))),
    )


def _sections(text: str) -> dict[str, list[str]]:
    sections: dict[str, list[str]] = {}
    current: list[str] | None = None
    for line in text.splitlines():
        if line.startswith("### "):
            current = sections.setdefault(line[4:].strip(), [])
        elif current is not None:
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
    value = value.strip()
    if len(value) >= 2 and value[0] == '"' and value[-1] == '"':
        try:
            loaded = json.loads(value)
        except ValueError:
            return value[1:-1]
        return loaded if isinstance(loaded, str) else value[1:-1]
    return value


def _dialog(line: str) -> Dialog | None:
    # - ["alert" dialog with message "Hello from the page"]: can be handled by browser_handle_dialog
    if not line.startswith("- ["):
        return None
    end = line.rfind("]:")
    inner = line[3:end] if end > 3 else line[3:]
    kind = inner
    if inner.startswith('"'):
        close = inner.find('"', 1)
        if close > 0:
            kind = inner[1:close]
    marker = " with message "
    at = inner.find(marker)
    message = _unquote(inner[at + len(marker) :]) if at != -1 else ""
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
