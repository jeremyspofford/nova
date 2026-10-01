"""A page as text she can read (S38): the pinned engine's snapshots rendered,
cut into parts, searched, outlined — and kept linear on hostile input."""

from __future__ import annotations

import time

from app.browser import page, reader
from tests.browser_engine import answer_text

INDEX_LINES = [
    "# Capture index",
    'First paragraph of the index page, with [f3e4] link "Page two" (page2.html) in it.',
    "- Alpha item",
    "- Beta item",
    "| Name | Size |",
    "| qwen3 | 4.9 GB |",
    'Search words [f3e17] textbox "Search words" Pick one [f3e18] combobox "Pick one"'
    ' (options: Option A [selected], Option B) [f3e19] button "Send"',
    '[f3e21] link "Download the report" (report.txt)',
    '[f3e22] button "Show alert"',
]


def _snapshot(step: str) -> str:
    return page.parse(answer_text(step)).snapshot


def test_the_index_capture_renders_as_a_person_reads_it():
    read = reader.read(_snapshot("snapshot-index"))
    assert [line.text for line in read.lines] == INDEX_LINES
    assert [line.heading for line in read.lines] == [True] + [False] * 8
    assert read.parts == ("\n".join(INDEX_LINES),)


def test_the_outline_counts_what_she_can_act_on():
    outline = reader.outline(reader.read(_snapshot("snapshot-index")))
    assert outline == reader.Outline(
        headings=("Capture index",), more_headings=0, links=2, buttons=2, fields=2
    )


def test_the_long_capture_is_two_parts_and_the_needle_is_in_part_two():
    read = reader.read(_snapshot("snapshot-long"))
    assert (len(read.lines), read.chars) == (401, 44_163)
    assert read.starts == (0, 219)
    assert [len(part) for part in read.parts] == [23_995, 20_166]
    assert all(len(part) <= reader.DEFAULT_PART_CHARS for part in read.parts)
    matches, total = reader.search(read, "zebra-quartz")
    assert total == 1
    assert matches == [
        reader.Match(
            part=2,
            heading="# A long page",
            text="The needle sentence is here: zebra-quartz lives in paragraph three hundred.",
        )
    ]


def test_a_search_is_every_word_case_blind_and_bounded():
    read = reader.read(_snapshot("snapshot-long"))
    # 399, not 400: paragraph 300 is the needle sentence, which has no "item".
    matches, total = reader.search(read, "PARAGRAPH item")
    assert total == 399 and len(matches) == reader.MAX_MATCHES
    assert reader.search(read, "   ") == ([], 0)
    assert reader.search(read, "zebra-quartz absent-word") == ([], 0)


def test_smaller_parts_cut_on_line_boundaries():
    read = reader.read(_snapshot("snapshot-long"), 2_000)
    assert len(read.parts) == 23
    assert read.starts[:4] == (0, 19, 37, 55)
    assert all(len(part) <= 2_000 for part in read.parts)
    assert "\n".join(read.parts) == "\n".join(line.text for line in read.lines)


def test_a_line_longer_than_a_part_is_cut_inside():
    read = reader.read("- paragraph [ref=e1]: " + "a" * 5_000, 2_000)
    assert [len(part) for part in read.parts] == [2_000, 2_000, 1_000]
    assert read.starts == (0, 0, 0)
    matches, _ = reader.search(read, "aaa")
    assert matches[0].part == 1


def test_an_empty_page_is_one_empty_part():
    read = reader.read("")
    assert read.parts == ("",) and read.starts == (0,) and read.lines == ()


def test_controls_carry_their_state_and_their_target():
    snapshot = "\n".join(
        [
            '- checkbox "Remember me" [checked] [ref=e2]',
            '- link "Docs" [ref=e3]:',
            "  - /url: https://example.com/docs",
            '- textbox "Email" [ref=e4]:',
            "  - /placeholder: you@example.com",
            '- button "Disabled" [disabled] [ref=e5]',
            '- img "A chart of prices"',
            '- heading "Deep" [level=3] [ref=e6]',
        ]
    )
    # Each top-level node is a line of its own; inside a block they flow.
    assert [line.text for line in reader.read(snapshot).lines] == [
        '[e2] checkbox "Remember me" (checked)',
        '[e3] link "Docs" (https://example.com/docs)',
        '[e4] textbox "Email" (placeholder: you@example.com)',
        '[e5] button "Disabled" (disabled)',
        "[image: A chart of prices]",
        "### Deep",
    ]


def test_quoted_names_and_text_are_unquoted_once():
    snapshot = '- paragraph [ref=e1]:\n  - text: "Note: a colon"\n  - link "Say \\"hi\\"" [ref=e2]'
    assert [line.text for line in reader.read(snapshot).lines] == [
        'Note: a colon [e2] link "Say "hi""'
    ]


def test_a_hostile_snapshot_is_read_in_bounded_time():
    hostile = {
        "5,000 levels deep": "\n".join("  " * i + f"- generic [ref=e{i}]:" for i in range(5_000))
        + "\n"
        + "  " * 5_000
        + "- text: bottom",
        "200,000 attributes": '- button "b" ' + "[x=1] " * 200_000 + ": t",
        "1,000,000 escaped quotes": '- link "' + '\\"' * 1_000_000 + '" [ref=e1]',
        "an unclosed 2 MB name": '- link "' + "a" * 2_000_000,
        "500,000 open brackets": "- button " + "[" * 500_000,
    }
    for label, snapshot in hostile.items():
        start = time.perf_counter()
        read = reader.read(snapshot)
        reader.outline(read)
        reader.search(read, "bottom b")
        took = time.perf_counter() - start
        assert took < 2.0, f"{label}: {took:.2f} s"
    deep = reader.read(hostile["5,000 levels deep"])
    assert deep.lines[-1].text == "bottom"


def test_a_four_mebibyte_snapshot_reads_in_time():
    snapshot = "\n".join([_snapshot("snapshot-long")] * 80)
    assert len(snapshot.encode()) > 4 * 1024 * 1024
    start = time.perf_counter()
    read = reader.read(snapshot)
    reader.outline(read)
    reader.search(read, "zebra-quartz")
    took = time.perf_counter() - start
    # Measured 0.38 s on the N150 for 5 MB; the budget leaves CI's slower
    # runners five times the room.
    assert took < 2.0, f"{took:.2f} s"


# ── fix round 1: faithful to the engine's own renderer, not just the brief ──


def test_single_quoted_yaml_keys_keep_their_refs_and_targets():
    # The engine single-quotes the WHOLE key when it holds ": ", " #", "{",
    # "}" or a backtick (yamlEscapeKeyIfNeeded, measured against Playwright's
    # own renderer 2026-10-01): a heading "Step 1: Install", a link "Note:
    # the docs", a link "fix(core): a bug #90", a button "Sort by: Newest",
    # a link "Issue #42" — the five names that trigger it — plus two more
    # here for escaped braces and a doubled quote ("Don''t" -> "Don't").
    snapshot = """- generic [active] [ref=e1]:
  - 'heading "Step 1: Install" [level=2] [ref=e2]'
  - paragraph [ref=e3]:
    - text: Read the
    - 'link "Note: the docs" [ref=e4] [cursor=pointer]':
      - /url: /docs
    - text: first.
  - 'link "fix(core): a bug #90" [ref=e5] [cursor=pointer]':
    - /url: /pull/90
  - 'button "Sort by: Newest" [ref=e6]'
  - 'link "Issue #42" [ref=e7] [cursor=pointer]':
    - /url: /issues/42
  - 'link "Use {braces}" [ref=e8] [cursor=pointer]':
    - /url: /b
  - 'link "Don''t: stop" [ref=e9] [cursor=pointer]':
    - /url: /x"""
    read = reader.read(snapshot)
    assert [line.text for line in read.lines] == [
        "## Step 1: Install",
        'Read the [e4] link "Note: the docs" (/docs) first.',
        '[e5] link "fix(core): a bug #90" (/pull/90) [e6] button "Sort by: Newest"'
        ' [e7] link "Issue #42" (/issues/42) [e8] link "Use {braces}" (/b)'
        ' [e9] link "Don\'t: stop" (/x)',
    ]
    assert reader.outline(read) == reader.Outline(
        headings=("Step 1: Install",), more_headings=0, links=5, buttons=1, fields=0
    )


def test_a_link_inside_a_heading_keeps_its_ref_and_target():
    # The search-result / blog-index shape: the heading's own accessible name
    # already carries the words, but its nested link was dropped entirely.
    snapshot = """- generic [ref=e1]:
  - heading "Result title" [level=2] [ref=e2]:
    - link "Result title" [ref=e3] [cursor=pointer]:
      - /url: https://example.com/a
  - paragraph [ref=e4]:
    - text: A snippet of the result."""
    read = reader.read(snapshot)
    assert [line.text for line in read.lines] == [
        "## Result title",
        '[e3] link "Result title" (https://example.com/a)',
        "A snippet of the result.",
    ]
    assert [line.heading for line in read.lines] == [True, False, False]
    assert reader.outline(read).links == 1


def test_a_cells_links_in_a_wrapper_keep_their_refs_and_targets():
    # Hacker-News-style: "100 points by X | N comments", the links sitting
    # inside a generic wrapper rather than as the cell's direct children —
    # rendered as an empty cell before this fix.
    snapshot = """- table [ref=e1]:
  - row [ref=e2]:
    - cell [ref=e3]:
      - generic [ref=e4]:
        - text: 100 points by
        - link "someone" [ref=e5] [cursor=pointer]:
          - /url: user?id=someone
        - text: "|"
        - link "50 comments" [ref=e6] [cursor=pointer]:
          - /url: item?id=1"""
    read = reader.read(snapshot)
    assert [line.text for line in read.lines] == [
        '| 100 points by [e5] link "someone" (user?id=someone)'
        ' / [e6] link "50 comments" (item?id=1) |'
    ]
    assert reader.outline(read).links == 2


def test_a_cells_own_name_does_not_hide_its_links_either():
    # The same shape, but the cell ALSO carries a redundant accessible name
    # (the usual case) — the name alone used to win, losing both refs.
    snapshot = """- table [ref=e1]:
  - row [ref=e2]:
    - cell "100 points by someone | 50 comments" [ref=e3]:
      - generic [ref=e4]:
        - text: 100 points by
        - link "someone" [ref=e5] [cursor=pointer]:
          - /url: user?id=someone
        - text: "|"
        - link "50 comments" [ref=e6] [cursor=pointer]:
          - /url: item?id=1"""
    read = reader.read(snapshot)
    assert [line.text for line in read.lines] == [
        '| 100 points by [e5] link "someone" (user?id=someone)'
        ' / [e6] link "50 comments" (item?id=1) |'
    ]


def test_an_open_listboxs_options_are_each_individually_actionable():
    snapshot = """- listbox "Country" [ref=e1]:
  - option "France" [ref=e2] [cursor=pointer]
  - option "Spain" [selected] [ref=e3] [cursor=pointer]"""
    read = reader.read(snapshot)
    assert [line.text for line in read.lines] == [
        '[e1] listbox "Country" (options: France, Spain [selected])',
        '[e2] option "France"',
        '[e3] option "Spain" (selected)',
    ]


def test_a_trees_nested_treeitems_are_not_dropped():
    snapshot = """- tree "Files" [ref=e1]:
  - treeitem "src" [expanded] [ref=e2]:
    - group [ref=e3]:
      - treeitem "main.py" [ref=e4]
      - treeitem "util.py" [ref=e5]"""
    read = reader.read(snapshot)
    assert [line.text for line in read.lines] == [
        '[e2] treeitem "src" (expanded)',
        '[e4] treeitem "main.py"',
        '[e5] treeitem "util.py"',
    ]


def test_a_clickable_non_interactive_node_keeps_its_ref():
    # [cursor=pointer] is the page's own signal, not a maintained role list:
    # a cookie-banner div with no ARIA role, and a clickable image.
    snapshot = """- generic [ref=e1]:
  - generic [ref=e2] [cursor=pointer]:
    - text: Accept all cookies
  - img "Open the gallery" [ref=e3] [cursor=pointer]"""
    read = reader.read(snapshot)
    assert [line.text for line in read.lines] == [
        '[e2] generic "Accept all cookies" [e3] img "Open the gallery"'
    ]


def test_an_ordinary_combobox_still_flows_inline_with_its_neighbours():
    # The common case (no ref on its options) must NOT start breaking a
    # field out of its sentence just because item 2 now looks at children.
    snapshot = "\n".join(
        [
            "- generic [ref=e0]:",
            "  - text: Pick one",
            '  - combobox "Pick one" [ref=e1]:',
            '    - option "Option A" [selected]',
            '    - option "Option B"',
            "  - text: done",
        ]
    )
    read = reader.read(snapshot)
    assert [line.text for line in read.lines] == [
        'Pick one [e1] combobox "Pick one" (options: Option A [selected], Option B) done'
    ]


def test_a_cut_never_splits_a_ref_token():
    # Refs are prefixes of one another ("[e1" is itself a valid-looking
    # fragment of "[e17]"), so a hard cut at exactly part_chars can turn one
    # ref into a different, wrong, one. Measured on the un-fixed cutter: the
    # boundary landed between "[e" and "17]".
    text = "a" * 1998 + "[e17]" + "a" * 1997
    read = reader.read("- paragraph [ref=e1]: " + text, 2_000)
    assert [len(part) for part in read.parts] == [1998, 2000, 2]
    assert read.parts[0] == "a" * 1998
    assert "[e17]" not in read.parts[0]
    assert "[e17]" in read.parts[1]


def test_a_four_megabyte_one_line_page_is_cut_in_linear_time():
    # text = "- text: " + "word " * n renders as ONE line; cutting it by
    # re-slicing the shrinking remainder measured 536 ms ASCII / 3,721 ms
    # with one astral char at MIN_PART_CHARS for ~4,000,007 bytes, and grew
    # 22x from 1 MB to 4 MB (quadratic). Cutting by index is linear: this
    # 4 MB page now reads in milliseconds.
    for label, snapshot in [
        ("ascii", "- text: " + "word " * 800_000),
        ("astral", "- text: " + "word " * 799_999 + "\U0001f600"),
    ]:
        start = time.perf_counter()
        read = reader.read(snapshot, reader.MIN_PART_CHARS)
        took = time.perf_counter() - start
        assert len(read.lines) == 1
        assert "".join(read.parts) == read.lines[0].text
        assert all(len(part) <= reader.MIN_PART_CHARS for part in read.parts)
        assert took < 1.0, f"{label}: {took:.2f} s"


def test_search_locates_a_hit_in_a_later_piece_of_a_cut_line():
    # A one-line page cut into several parts: the old code always named the
    # first one, whatever part the word actually lived in.
    doc = "- text: " + "filler words here " * 6_000 + "zebra-quartz at the very end"
    read = reader.read(doc)
    assert len(read.parts) > 1
    matches, total = reader.search(read, "zebra-quartz")
    assert total == 1
    real_part = next(i + 1 for i, p in enumerate(read.parts) if "zebra-quartz" in p)
    assert real_part > 1  # the needle is NOT in the first piece -- the bug's premise
    assert matches[0].part == real_part
    assert "zebra-quartz" in matches[0].text


def test_search_centres_the_snippet_on_the_hit_not_the_lines_start():
    para = (
        "- paragraph: "
        + "Opening sentence of a long paragraph. " * 60
        + ("The cure was found in 1921.")
    )
    read = reader.read(para, 2_000)
    assert len(read.parts) > 1
    matches, _ = reader.search(read, "cure 1921")
    real_part = next(i + 1 for i, p in enumerate(read.parts) if "1921" in p)
    assert matches[0].part == real_part
    assert "1921" in matches[0].text


def test_read_clamps_a_degenerate_part_chars():
    # read(s, 0) cut zero characters per piece and never returned.
    short = "- text: hello"
    assert reader.read(short, 0) == reader.read(short, reader.MIN_PART_CHARS)
    assert reader.read(short, -5) == reader.read(short, reader.MIN_PART_CHARS)
    assert reader.read(short, 10**9) == reader.read(short, reader.MAX_PART_CHARS)
