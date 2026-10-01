"""A page, as text she can read (S38).

The engine's snapshot is a YAML accessibility tree: one node per line, two
spaces of indent per level — `- role "name" [attr] [ref=e4]: inline text`,
`- text: …`, `- /url: …`. It is rendered here into the lines a person reads:
a heading as `#`s, a paragraph as its words, a list item as `- …`, a table row
as `| a | b |`, and every element she can act on as `[e4] link "Page two"
(page2.html)`, carrying the engine's own ref. Decoration is dropped.

Then cut into parts no longer than she asked for, on line boundaries (only a
single line longer than a part is cut inside), or searched: the lines holding
every word of a query, each with its part number and the heading above it.

Pure and linear: one pass per line, str methods only, never a regular
expression — the text is a page's, and a 4 MiB snapshot is read on core's
event loop.
"""

from __future__ import annotations

import bisect
import json
from dataclasses import dataclass, field

DEFAULT_PART_CHARS = 24_000
MIN_PART_CHARS = 2_000
MAX_PART_CHARS = 200_000
MAX_MATCHES = 40
MAX_MATCH_CHARS = 300
MAX_OUTLINE_HEADINGS = 30
# A page chooses how deep its tree goes, and the walk below is recursive: a
# node deeper than this is read as a sibling at this depth, so no page can
# exhaust the interpreter's stack (a 5,000-deep snapshot raised RecursionError
# before this, measured 2026-10-01).
MAX_DEPTH = 100

# Roles she can act on: rendered with the engine's ref, never flowed as text.
INTERACTIVE = frozenset(
    {
        "link", "button", "textbox", "searchbox", "combobox", "listbox", "checkbox",
        "radio", "switch", "slider", "spinbutton", "tab", "menuitem",
        "menuitemcheckbox", "menuitemradio", "treeitem",
    }
)  # fmt: skip
FIELDS = frozenset(
    {
        "textbox",
        "searchbox",
        "combobox",
        "listbox",
        "checkbox",
        "radio",
        "switch",
        "slider",
        "spinbutton",
    }
)
# Roles that are a line of their own, with what goes in front of it.
BLOCKS = {
    "paragraph": "",
    "listitem": "- ",
    "blockquote": "> ",
    "alert": "! ",
    "status": "",
    "caption": "",
    "term": "",
    "definition": "  ",
    "code": "",
    "note": "",
    "figure": "",
}
CELLS = frozenset({"cell", "columnheader", "rowheader", "gridcell"})
FLAGS = ("checked", "selected", "disabled", "expanded", "pressed")


@dataclass(frozen=True)
class Line:
    text: str
    heading: bool = False


@dataclass(frozen=True)
class Page:
    lines: tuple[Line, ...]
    parts: tuple[str, ...]
    starts: tuple[int, ...]  # the index in `lines` each part begins at

    @property
    def chars(self) -> int:
        return sum(len(line.text) + 1 for line in self.lines)


@dataclass(frozen=True)
class Outline:
    headings: tuple[str, ...]
    more_headings: int
    links: int
    buttons: int
    fields: int


@dataclass(frozen=True)
class Match:
    part: int
    heading: str | None
    text: str


@dataclass
class _Node:
    role: str
    name: str | None = None
    attrs: dict[str, str] = field(default_factory=dict)
    text: str | None = None
    children: list[_Node] = field(default_factory=list)


@dataclass
class _Flow:
    prefix: str = ""
    parts: list[str] = field(default_factory=list)


def read(snapshot: str, part_chars: int = DEFAULT_PART_CHARS) -> Page:
    # Clamped here, not trusted from a caller's schema: `read(s, 0)` cut
    # zero characters per piece and never returned (measured 2026-10-01).
    part_chars = max(MIN_PART_CHARS, min(part_chars, MAX_PART_CHARS))
    lines = tuple(render(snapshot))
    parts, starts = _paginate(lines, part_chars)
    return Page(lines=lines, parts=tuple(parts), starts=tuple(starts))


def render(snapshot: str) -> list[Line]:
    out: list[Line] = []
    for node in _tree(snapshot or ""):
        flow = _Flow()
        _walk(node, out, flow, in_block=False)
        _flush(out, flow)
    return out


def outline(page: Page) -> Outline:
    headings = [line.text.lstrip("#").strip() for line in page.lines if line.heading]
    links = buttons = fields = 0
    for line in page.lines:
        links += line.text.count("] link ")
        buttons += line.text.count("] button ")
        fields += sum(line.text.count(f"] {role}") for role in FIELDS)
    return Outline(
        headings=tuple(headings[:MAX_OUTLINE_HEADINGS]),
        more_headings=max(0, len(headings) - MAX_OUTLINE_HEADINGS),
        links=links,
        buttons=buttons,
        fields=fields,
    )


def search(page: Page, query: str) -> tuple[list[Match], int]:
    """Every line holding every word of `query` (case-insensitive), at most
    MAX_MATCHES of them, and how many there were in all. The part named, and
    the snippet shown, are centred on where the FIRST query word actually
    sits — a line cut into several parts can hold the word past the first
    one, and the snippet would otherwise be some other, wordless, stretch."""
    words = [word.casefold() for word in query.split() if word]
    if not words:
        return [], 0
    found: list[Match] = []
    total = 0
    heading: str | None = None
    for index, line in enumerate(page.lines):
        if line.heading:
            heading = line.text
        folded = line.text.casefold()
        if all(word in folded for word in words):
            total += 1
            if len(found) < MAX_MATCHES:
                offset = folded.find(words[0])
                part = _part_of(page, index, offset)
                text = _snippet(line.text, offset)
                found.append(Match(part=part, heading=None if line.heading else heading, text=text))
    return found, total


def _part_of(page: Page, index: int, offset: int = 0) -> int:
    """The 1-based part holding character `offset` of line `index`. A line
    cut into several consecutive parts (all sharing one `starts` entry)
    walks forward through them, each piece's length against `offset`, since
    a word can live past the first one."""
    at = bisect.bisect_left(page.starts, index)
    if at >= len(page.starts) or page.starts[at] != index:
        return at
    while (
        at + 1 < len(page.starts) and page.starts[at + 1] == index and offset >= len(page.parts[at])
    ):
        offset -= len(page.parts[at])
        at += 1
    return at + 1


def _snippet(text: str, offset: int) -> str:
    """`text`, trimmed to MAX_MATCH_CHARS and centred on `offset` — where the
    query was actually found, never just the line's own start."""
    if len(text) <= MAX_MATCH_CHARS or offset < 0:
        return text
    half = MAX_MATCH_CHARS // 2
    start = max(0, min(offset - half, len(text) - MAX_MATCH_CHARS))
    end = start + MAX_MATCH_CHARS
    prefix = "… " if start > 0 else ""
    suffix = " …" if end < len(text) else ""
    return prefix + text[start:end] + suffix


# ── the tree ────────────────────────────────────────────────────────────────


def _tree(snapshot: str) -> list[_Node]:
    roots: list[_Node] = []
    stack: list[tuple[int, _Node]] = []
    for raw in snapshot.splitlines():
        parsed = _parse_line(raw)
        if parsed is None:
            continue
        indent, node = parsed
        while stack and stack[-1][0] >= indent:
            stack.pop()
        if stack:
            stack[-1][1].children.append(node)
        else:
            roots.append(node)
        stack.append((indent, node))
    return roots


def _parse_line(raw: str) -> tuple[int, _Node] | None:
    stripped = raw.lstrip(" ")
    if not stripped.startswith("- "):
        return None
    indent = min((len(raw) - len(stripped)) // 2, MAX_DEPTH)
    body = stripped[2:]
    if body.startswith("text:"):
        return indent, _Node(role="text", text=_scalar(body[5:]))
    if body.startswith("/"):
        key, _, value = body.partition(":")
        return indent, _Node(role=key, text=_scalar(value))
    if body.startswith("'"):
        # The engine single-quotes the WHOLE key when it holds ": ", " #",
        # "{", "}" or a backtick (yamlEscapeKeyIfNeeded): a heading "Step 1:
        # Install", a link "fix(core): a bug #90". `''` is one literal `'`.
        key, after = _single_quoted(body)
        node, _ = _parse_key(key)
        trailer = body[after:]
    else:
        node, consumed = _parse_key(body)
        trailer = body[consumed:]
    if trailer.startswith(":"):
        node.text = _scalar(trailer[1:]) or None
    return indent, node


def _single_quoted(body: str) -> tuple[str, int]:
    """The YAML-single-quoted key at the start of `body` (its opening `'` is
    body[0]), unescaped (`''` -> `'`), and the index right after its closing
    `'`. One slice per escaped-quote pair, never per character: linear even
    across many of them."""
    out: list[str] = []
    start = i = 1
    while i < len(body):
        if body[i] != "'":
            i += 1
            continue
        if i + 1 < len(body) and body[i + 1] == "'":
            out.append(body[start : i + 1])  # text so far, plus one '
            i += 2
            start = i
            continue
        out.append(body[start:i])
        return "".join(out), i + 1
    out.append(body[start:])
    return "".join(out), len(body)


def _parse_key(key: str) -> tuple[_Node, int]:
    """`role ["name"] [attr]...` from the start of `key` (already YAML-
    unescaped, if it came from a single-quoted key). Returns the node and
    how far into `key` it read — the caller reads what follows as a
    trailing `: value`."""
    end = 0
    while end < len(key) and (key[end].isalnum() or key[end] in "-_"):
        end += 1
    if end == 0:
        return _Node(role="text", text=_scalar(key)), len(key)
    node = _Node(role=key[:end])
    at = end
    while at < len(key) and key[at] == " ":
        at += 1
    if at < len(key) and key[at] == '"':
        name, remainder = _quoted(key[at:])
        node.name = name
        at = len(key) - len(remainder)
        while at < len(key) and key[at] == " ":
            at += 1
    # By index, never by re-slicing `key`: a slice per attribute copies the
    # rest of the line each time, and 200,000 attributes took 9 s that way
    # (measured 2026-10-01). One pass, one slice at the end.
    while at < len(key) and key[at] == "[":
        close = key.find("]", at)
        if close == -1:
            break
        attr_key, sep, value = key[at + 1 : close].partition("=")
        node.attrs[attr_key] = value if sep else ""
        at = close + 1
        while at < len(key) and key[at] == " ":
            at += 1
    return node, at


def _quoted(text: str) -> tuple[str, str]:
    """The double-quoted name at the start of `text`, and what follows it."""
    i = 1
    while i < len(text):
        if text[i] == "\\":
            i += 2
            continue
        if text[i] == '"':
            raw = text[: i + 1]
            try:
                name = json.loads(raw)
            except ValueError:
                name = raw[1:-1]
            return (name if isinstance(name, str) else raw[1:-1]), text[i + 1 :]
        i += 1
    return text[1:], ""


def _scalar(value: str) -> str:
    value = value.strip()
    if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
        if value[0] == '"':
            try:
                loaded = json.loads(value)
            except ValueError:
                return value[1:-1]
            return loaded if isinstance(loaded, str) else value[1:-1]
        return value[1:-1].replace("''", "'")
    return value


# ── the walk ────────────────────────────────────────────────────────────────


def _flush(out: list[Line], flow: _Flow) -> None:
    text = " ".join(part for part in flow.parts if part).strip()
    if text:
        out.append(Line(flow.prefix + text))
        if flow.prefix:
            flow.prefix = " " * len(flow.prefix)
    flow.parts.clear()


def _walk(node: _Node, out: list[Line], flow: _Flow, *, in_block: bool) -> None:
    role = node.role
    if role == "text":
        if node.text:
            flow.parts.append(node.text)
        return
    if role.startswith("/"):
        return  # a property (/url, /placeholder) — read by the element that owns it
    if role == "heading":
        _flush(out, flow)
        level = node.attrs.get("level", "")
        depth = int(level) if level.isdigit() and 1 <= int(level) <= 6 else 1
        words = node.name or node.text or " ".join(_inline_words(node))
        if words:
            out.append(Line("#" * depth + " " + words, heading=True))
        for text in _actionable_lines(node):
            out.append(Line(text))
        return
    if role in INTERACTIVE or _clickable(node):
        flow.parts.append(_marker(node))
        nested = _actionable_lines(node)
        if nested:
            _flush(out, flow)
            for text in nested:
                out.append(Line(text))
        return
    if role == "img":
        if node.name:
            flow.parts.append(f"[image: {node.name}]")
        return
    if role == "row":
        _flush(out, flow)
        cells = [_cell(child) for child in node.children if child.role in CELLS]
        if cells:
            out.append(Line("| " + " | ".join(cells) + " |"))
        return
    if role in BLOCKS:
        _flush(out, flow)
        inner = _Flow(prefix=BLOCKS[role])
        if node.text:
            inner.parts.append(node.text)
        for child in node.children:
            _walk(child, out, inner, in_block=True)
        _flush(out, inner)
        return
    # A container (generic, list, table, group, navigation, form, …): it adds
    # nothing of its own. At the top level its inline content is one line; in
    # a block it flows on with the block's words.
    if not in_block:
        _flush(out, flow)
    if node.text:
        flow.parts.append(node.text)
    for child in node.children:
        _walk(child, out, flow, in_block=in_block)
    if not in_block:
        _flush(out, flow)


def _inline_words(node: _Node) -> list[str]:
    words: list[str] = []
    for child in node.children:
        if child.role == "text" and child.text:
            words.append(child.text)
        elif child.name:
            words.append(child.name)
    return words


def _cell(node: _Node) -> str:
    words = _cell_words(node) or [node.name or node.text or ""]
    return " ".join(word for word in words if word).replace("|", "/")


def _cell_words(node: _Node) -> list[str]:
    """Every word of a cell's content, found however deep a wrapper nests
    it: plain text, and anything she can act on, with its ref (a cell whose
    links sit inside a generic wrapper, the common "100 points by X | N
    comments" shape, otherwise rendered empty)."""
    words: list[str] = []
    for child in node.children:
        if child.role in INTERACTIVE or _clickable(child):
            words.append(_marker(child))
        elif child.role == "text" and child.text:
            words.append(child.text)
        elif not child.role.startswith("/"):
            words.extend(_cell_words(child))
    return words


def _clickable(node: _Node) -> bool:
    """A node the PAGE marked clickable (the engine's own [cursor=pointer]
    signal) and that carries a ref — rendered as actionable even off the
    maintained INTERACTIVE list: a cookie-banner div, a clickable image."""
    return node.attrs.get("cursor") == "pointer" and "ref" in node.attrs


def _marker(node: _Node) -> str:
    """`_element(node)`, or — for a clickable node with no name of its own
    (a plain clickable wrapper div) — its ref and role with its flowed
    words standing in for a name."""
    if node.role in INTERACTIVE or node.name:
        return _element(node)
    ref = node.attrs.get("ref")
    label = " ".join(_inline_words(node))
    return f'[{ref}] {node.role} "{label}"' if label else f"[{ref}] {node.role}"


def _actionable_lines(node: _Node) -> list[str]:
    """Every interactive-or-clickable element inside `node`'s subtree (not
    `node` itself), each with its own ref, found however deep it sits: a
    heading's or a listbox's nested link, an open listbox's options, a
    tree's nested treeitems. Depth is already capped at parse time."""
    found: list[str] = []
    for child in node.children:
        if child.role in INTERACTIVE or _clickable(child):
            found.append(_marker(child))
        found.extend(_actionable_lines(child))
    return found


def _element(node: _Node) -> str:
    ref = node.attrs.get("ref")
    label = f'{node.role} "{node.name}"' if node.name else node.role
    head = f"[{ref}] {label}" if ref else label
    extras: list[str] = []
    for flag in FLAGS:
        if flag in node.attrs:
            value = node.attrs[flag]
            extras.append(flag if value in ("", "true") else f"{flag}={value}")
    if node.role in ("combobox", "listbox"):
        options = [
            (child.name or child.text or "") + (" [selected]" if "selected" in child.attrs else "")
            for child in node.children
            if child.role == "option"
        ]
        if options:
            extras.append("options: " + ", ".join(options))
    for child in node.children:
        if child.role == "/url" and child.text:
            extras.append(child.text)
        elif child.role == "/placeholder" and child.text:
            extras.append(f"placeholder: {child.text}")
    text = f"{head} ({'; '.join(extras)})" if extras else head
    if node.text and node.text != node.name:
        text += f": {node.text}"
    return text


# ── parts ───────────────────────────────────────────────────────────────────


def _paginate(lines: tuple[Line, ...], part_chars: int) -> tuple[list[str], list[int]]:
    parts: list[str] = []
    starts: list[int] = []
    current: list[str] = []
    size = 0
    for index, line in enumerate(lines):
        full = line.text
        at = 0
        while len(full) - at > part_chars:
            if current:
                parts.append("\n".join(current))
                current, size = [], 0
            starts.append(index)
            cut = _cut_point(full, at, at + part_chars)
            parts.append(full[at:cut])
            at = cut
        text = full[at:] if at else full
        if not text:
            continue
        added = len(text) + (1 if current else 0)
        if current and size + added > part_chars:
            parts.append("\n".join(current))
            current, size, added = [], 0, len(text)
        if not current:
            starts.append(index)
        current.append(text)
        size += added
    if current:
        parts.append("\n".join(current))
    if not parts:
        return [""], [0]
    return parts, starts


def _cut_point(text: str, at: int, limit: int) -> int:
    """Where to end a piece of `text` starting at `at`, no later than
    `limit`: at the last space in the window if there is one, moved earlier
    still if that would land inside an unclosed `[...]` token — a ref is
    never split, so "[e17]" cut after "[e1" can never read as the valid,
    but wrong, "[e1]" (refs are prefixes of one another). Falls back to the
    hard limit only when neither leaves room to make progress, so a run of
    nothing but "[" (never a real ref) still reads in linear time."""
    space = text.rfind(" ", at + 1, limit)
    cut = space + 1 if space != -1 else limit
    open_bracket = text.rfind("[", at, cut)
    if open_bracket != -1 and text.find("]", open_bracket, cut) == -1:
        cut = open_bracket
    return cut if cut > at else limit
