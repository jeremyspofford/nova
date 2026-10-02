"""A page, as text she can read (S38).

The engine's snapshot is a YAML accessibility tree: one node per line, two
spaces of indent per level — `- role "name" [attr] [ref=e4]: inline text`,
`- text: …`, `- /url: …`. It is rendered here into the lines a person reads:
a heading as `#`s, a paragraph as its words, a list item as `- …`, a table row
as `| a | b |`, and every element she can act on as `[e4] link "Page two"
(page2.html)`, carrying the engine's own ref. Decoration is dropped.

She can act on a role in INTERACTIVE, on an option the engine gave a ref,
and on any node the page itself made clickable — the engine's
[cursor=pointer], written on the outermost such node only: a cookie banner's
div, a calendar's day, a card, an inbox row. Such a node keeps its ref AND
what it holds: its words as one token when words are all it holds (`[e2]
generic "Accept all cookies"`), else its ref in front of its content (`[e10]
generic:`, then the card's heading and paragraphs as lines of their own).

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
# A table row whose cells hold a heading or another row is a layout, not a
# row of data: it reads as the lines inside it, never squeezed into one cell
# (Hacker News nests its whole front page in one outer cell).
_LAYOUT = frozenset({"heading", "row"})
# casefold lengthens some characters ("ß" -> "ss", "İ" -> "i" and a combining
# dot) and shortens none, folding each character on its own (checked over
# every code point, 2026-10-02): a folded offset is mapped back to the line by
# folding it a block at a time.
_FOLD_BLOCK = 4_096
_ROLE_CHARS = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_"


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
    blocks: bool = False  # something below it is a heading, a row or a BLOCKS role
    layout: bool = False  # something below it is a heading or a row


@dataclass
class _Flow:
    prefix: str = ""
    parts: list[str] = field(default_factory=list)
    marks: int = 0  # how many parts were elements, not words
    flat: bool = False  # inside a table cell: one string, so a block adds no "- " of its own


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
                offset = _unfolded(line.text, folded, folded.find(words[0]))
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


def _unfolded(text: str, folded: str, offset: int) -> int:
    """The index in `text` of the character that position `offset` of its
    casefolded copy `folded` came from. Where folding changed no length, each
    character folded to one, and the offset is the same; otherwise the
    folded length is counted a block at a time, then a character at a time
    inside the block that holds the offset — linear, and in C but for one
    block. The search found the word in `folded`; this is where it sits in
    the line she reads."""
    if offset <= 0 or len(folded) == len(text):
        return max(offset, 0)
    at = seen = 0
    while at < len(text):
        size = len(text[at : at + _FOLD_BLOCK].casefold())
        if seen + size > offset:
            break
        seen += size
        at += _FOLD_BLOCK
    while at < len(text):
        size = len(text[at].casefold())
        if seen + size > offset:
            break
        seen += size
        at += 1
    return min(at, len(text))


# ── the tree ────────────────────────────────────────────────────────────────


def _tree(snapshot: str) -> list[_Node]:
    # Split on "\n" alone, as the engine joins its lines: splitlines() also
    # splits on U+2028, U+2029 and U+0085. The engine collapses U+2028 and
    # U+2029 inside a page's text, so splitting there is defensive, never
    # measured -- but U+0085 (NEL) survives raw inside an accessible name,
    # and splitting on it there would read the name's own tail as a new
    # node, with a ref it never had (`Hello<U+0085>  - button "Sign in"
    # [ref=e99]`, measured).
    roots: list[_Node] = []
    stack: list[tuple[int, _Node]] = []
    for raw in snapshot.split("\n"):
        parsed = _parse_line(raw)
        if parsed is None:
            continue
        indent, node = parsed
        while stack and stack[-1][0] >= indent:
            _close_node(stack)
        if stack:
            stack[-1][1].children.append(node)
        else:
            roots.append(node)
        stack.append((indent, node))
    while stack:
        _close_node(stack)
    return roots


def _close_node(stack: list[tuple[int, _Node]]) -> None:
    """Pop the innermost open node and tell its parent — the node beneath it
    on the stack — whether it holds a heading, a row or a block: one step
    per node, so the whole tree knows what each node holds in one pass."""
    node = stack.pop()[1]
    if not stack:
        return
    parent = stack[-1][1]
    if node.layout or node.role in _LAYOUT:
        parent.layout = parent.blocks = True
    elif node.blocks or node.role in BLOCKS:
        parent.blocks = True


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
        node, _ = _parse_key(key, len(key))
        trailer = body[after:]
    else:
        # A key the engine left unquoted holds no ": " — it quotes one that
        # does — so the first ": " (or a last ":") ends it.
        end = body.find(": ")
        if end == -1:
            end = len(body) - 1 if body.endswith(":") else len(body)
        node, consumed = _parse_key(body, end)
        trailer = body[consumed:]
    if trailer.startswith(":"):
        node.text = _scalar(trailer[1:]) or None
    return indent, node


def _single_quoted(body: str) -> tuple[str, int]:
    """The YAML-single-quoted key at the start of `body` (its opening `'` is
    body[0]), unescaped (`''` -> `'`), and the index right after its closing
    `'`. Read with str.find, one step per quote: a 4 MB key that never closes
    is one search, where a step per character took a Python loop round each
    of its four million characters."""
    out: list[str] = []
    start = at = 1
    while True:
        at = body.find("'", at)
        if at == -1:
            out.append(body[start:])
            return "".join(out), len(body)
        if body.startswith("'", at + 1):
            out.append(body[start : at + 1])  # the text so far, and one '
            at += 2
            start = at
            continue
        out.append(body[start:at])
        return "".join(out), at + 1


def _parse_key(key: str, limit: int) -> tuple[_Node, int]:
    """`role ["name"] [attr]...` from the start of `key` (already YAML-
    unescaped, if it came from a single-quoted key), which ends at `limit`.
    Returns the node and how far into `key` it read — the caller reads what
    follows as a trailing `: value`."""
    # The role: the engine's ARIA role names are ASCII letters, digits, "-"
    # and "_". Read in C, not a Python step per character — a 4 MB key with
    # no end to its role took 0.2 s that way (measured 2026-10-02).
    end = limit - len(key[:limit].lstrip(_ROLE_CHARS))
    if end == 0:
        return _Node(role="text", text=_scalar(key)), len(key)
    node = _Node(role=key[:end])
    at = end
    while at < limit and key[at] == " ":
        at += 1
    if at < limit and key[at] == '"':
        name, remainder = _quoted(key[at:])
        node.name = name
        at = len(key) - len(remainder)
        while at < len(key) and key[at] == " ":
            at += 1
    elif at < limit and key[at] == "/":
        # A name that starts and ends with "/" is written raw (createKey: an
        # aria template reads it as a regex): `link /docs/ [ref=e6]`. No
        # attribute holds a "/", so the key's last one closes the name.
        close = key.rfind("/", at, limit)
        node.name = key[at : close + 1]
        at = close + 1
        while at < limit and key[at] == " ":
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


def _mark(flow: _Flow, text: str) -> None:
    """An element, into the flow — counted, so a clickable node can tell the
    words it holds from the elements it holds."""
    flow.parts.append(text)
    flow.marks += 1


def _walk(node: _Node, out: list[Line], flow: _Flow, *, in_block: bool) -> None:
    role = node.role
    if role == "text":
        if node.text:
            flow.parts.append(node.text)
        return
    if role.startswith("/"):
        return  # a property (/url, /placeholder) — read by the element that owns it
    if role == "heading":
        _heading(node, out, flow)
        return
    if role in INTERACTIVE or role == "option":
        _mark(flow, _element(node))
        nested = _actionable_lines(node)
        if nested:
            _flush(out, flow)
            out.extend(Line(text) for text in nested)
        return
    clickable = _clickable(node)
    if role == "img":
        if clickable:
            _mark(flow, _element(node))
        elif node.name:
            _mark(flow, f"[image: {node.name}]")
        # What an image holds is decoration — but never a ref she can act on.
        nested = _actionable_lines(node)
        if nested:
            _flush(out, flow)
            out.extend(Line(text) for text in nested)
        return
    if role == "row" and not node.layout:
        _row(node, out, flow, clickable)
        return
    if role in BLOCKS:
        _flush(out, flow)
        inner = _Flow(prefix="" if flow.flat else BLOCKS[role], flat=flow.flat)
        _content(node, out, inner, clickable, in_block=True)
        _flush(out, inner)
        return
    # A container (generic, list, table, group, navigation, form, a layout
    # row, …) adds nothing of its own. At the top level its inline content is
    # one line; in a block it flows on with the block's words. A clickable
    # one flows like any element when it holds no heading, row or block; one
    # that does (a card) is its ref, then the lines it holds.
    inline = in_block or (clickable and not node.blocks)
    if not inline:
        _flush(out, flow)
    _content(node, out, flow, clickable, in_block=inline)
    if not inline:
        _flush(out, flow)


def _content(node: _Node, out: list[Line], flow: _Flow, clickable: bool, *, in_block: bool) -> None:
    """What `node` holds — its inline text, then its children — into `flow`
    and `out`, behind its ref when the page made it clickable."""
    opened = _open(node, out, flow) if clickable else None
    if node.text:
        flow.parts.append(node.text)
    for child in node.children:
        _walk(child, out, flow, in_block=in_block)
    if opened is not None:
        _close(node, out, flow, opened)


def _open(node: _Node, out: list[Line], flow: _Flow) -> tuple[int, int, int]:
    """A clickable node's ref, ahead of what it holds: `[e10] generic:`.
    Returns where it went, and the counts _close compares against."""
    _mark(flow, _element(node, text=False) + ":")
    return len(flow.parts) - 1, flow.marks, len(out)


def _close(node: _Node, out: list[Line], flow: _Flow, opened: tuple[int, int, int]) -> None:
    """When all a clickable node held was words — no line written since its
    ref, no element among them — its ref and its words become one token, the
    words standing in for the name it lacks: `[e2] generic "Accept all
    cookies"`. Anything else stays as written: its ref, then its content.
    A part is merged into a token at most once, so this stays linear."""
    at, marks, lines = opened
    if len(out) != lines or flow.marks != marks:
        return
    words = " ".join(part for part in flow.parts[at + 1 :] if part).strip()
    del flow.parts[at:]
    flow.parts.append(_label(node, words))


def _label(node: _Node, words: str) -> str:
    """A clickable node that holds only `words`, as one token."""
    if not node.name:
        return _element(node, name=words, text=False)
    head = _element(node, text=False)
    return head if not words or words == node.name else f"{head}: {words}"


def _heading(node: _Node, out: list[Line], flow: _Flow) -> None:
    _flush(out, flow)
    level = node.attrs.get("level", "")
    depth = int(level) if level in ("1", "2", "3", "4", "5", "6") else 1
    words = node.name or node.text or " ".join(_inline_words(node))
    if words:
        out.append(Line("#" * depth + " " + words, heading=True))
    if _clickable(node):
        out.append(Line(_marker(node)))  # an accordion's header: the heading is what she clicks
    out.extend(Line(text) for text in _actionable_lines(node))


def _row(node: _Node, out: list[Line], flow: _Flow, clickable: bool) -> None:
    _flush(out, flow)
    # Every child is a cell: a row built of divs holds generics, not cells,
    # and dropping them dropped their words and their refs with them.
    cells = [_cell(child) for child in node.children if not child.role.startswith("/")]
    if not cells:
        if clickable:
            out.append(Line(_marker(node)))
        return
    line = "| " + " | ".join(cells) + " |"
    if clickable:
        # The row is what she clicks (an inbox, a file list): its ref, then
        # the cells it shows — never its name, which is those cells again.
        line = f"{_element(node, name='', text=False)}: {line}"
    out.append(Line(line))


def _cell(node: _Node) -> str:
    """A cell as one string: its words, and every element in it with its ref,
    however deep a wrapper holds them ("100 points by X | N comments" sits in
    spans and generics). A cell holding nothing else reads as its name; a
    row's child that is not a cell at all is read as whatever it is."""
    is_cell = node.role in CELLS
    clickable = _clickable(node)
    if is_cell and not node.children and not clickable:
        return (node.name or node.text or "").replace("|", "/")
    lines: list[Line] = []
    flow = _Flow(flat=True)
    if is_cell:
        _content(node, lines, flow, clickable, in_block=True)
    else:
        _walk(node, lines, flow, in_block=True)
    _flush(lines, flow)
    text = " ".join(line.text for line in lines) or (node.name if is_cell else "") or ""
    return text.replace("|", "/")


def _inline_words(node: _Node) -> list[str]:
    words: list[str] = []
    for child in node.children:
        if child.role == "text" and child.text:
            words.append(child.text)
        elif child.name:
            words.append(child.name)
    return words


def _clickable(node: _Node) -> bool:
    """A node the PAGE marked clickable (the engine's own [cursor=pointer]
    signal) and that carries a ref — rendered as actionable even off the
    maintained INTERACTIVE list: a cookie-banner div, a clickable image."""
    return node.attrs.get("cursor") == "pointer" and "ref" in node.attrs


def _acts(node: _Node) -> bool:
    """An element she can act on: a role in INTERACTIVE; an option the engine
    gave a ref (refs are "interactable", whatever the page's cursor — a
    native <select>'s options have none, and its own line names them); or a
    node the page made clickable."""
    if node.role == "option":
        return "ref" in node.attrs
    return node.role in INTERACTIVE or _clickable(node)


def _marker(node: _Node) -> str:
    """One token for an element she can act on inside another (a listbox's
    option, a heading's link, a tree's nested item): `_element`, or for a
    clickable node with no name, its own words standing in for one."""
    if node.role in INTERACTIVE or node.role == "option" or node.name:
        return _element(node)
    return _label(node, " ".join(word for word in (node.text, *_inline_words(node)) if word))


def _actionable_lines(node: _Node) -> list[str]:
    """Every element she can act on inside `node`'s subtree (not `node`
    itself), each with its own ref, in document order however deep it sits:
    a heading's or a listbox's nested link, an open listbox's options, a
    tree's nested treeitems. One pass, with a stack of its own."""
    found: list[str] = []
    stack = node.children[::-1]
    while stack:
        child = stack.pop()
        if _acts(child):
            found.append(_marker(child))
        stack.extend(reversed(child.children))
    return found


def _element(node: _Node, *, name: str | None = None, text: bool = True) -> str:
    """`[ref] role "name" (state; options; target)`, then `: inline text`
    when it says more than the name. `name` stands in for the node's own (a
    clickable node's words); `text=False` leaves the inline text to a caller
    that reads it as content."""
    ref = node.attrs.get("ref")
    name = node.name if name is None else name
    label = f'{node.role} "{name}"' if name else node.role
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
    rendered = f"{head} ({'; '.join(extras)})" if extras else head
    if text and node.text and node.text != node.name:
        rendered += f": {node.text}"
    return rendered


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
