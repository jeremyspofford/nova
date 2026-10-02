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


# ── fix round 2: every snapshot below is the engine's own shape ─────────────
# (renderAriaTreeAsJSON's conversion, then renderAriaSnapshotAsYaml, from the
# engine's Playwright 1.64.0-alpha): a sole text child is written as the node's
# inline text, every visible node that takes pointer events carries a ref, and
# [cursor=pointer] marks only the OUTERMOST node the page made clickable.


def _lines(snapshot: str) -> list[str]:
    return [line.text for line in reader.read(snapshot).lines]


def test_an_open_listboxs_options_keep_their_refs_without_a_pointer_cursor():
    # The engine gives every visible option a ref; it writes [cursor=pointer]
    # only when the page's own cursor is a pointer, and an open custom listbox
    # usually leaves it at the default arrow.
    snapshot = """- listbox "Country" [ref=e1]:
  - option "France" [ref=e2]
  - option "Spain" [selected] [ref=e3]"""
    assert _lines(snapshot) == [
        '[e1] listbox "Country" (options: France, Spain [selected])',
        '[e2] option "France"',
        '[e3] option "Spain" (selected)',
    ]


def test_a_clickable_nodes_inline_words_are_its_label():
    # The cookie banner of test_a_clickable_non_interactive_node_keeps_its_ref,
    # as the engine writes it: its one text child inline. It reads the same.
    snapshot = """- generic [ref=e1]:
  - generic [ref=e2] [cursor=pointer]: Accept all cookies
  - img "Open the gallery" [ref=e3] [cursor=pointer]"""
    assert _lines(snapshot) == ['[e2] generic "Accept all cookies" [e3] img "Open the gallery"']


def test_a_clickable_cell_keeps_its_ref():
    snapshot = """- grid "October 2026" [ref=e1]:
  - row [ref=e2]:
    - gridcell "14" [ref=e3] [cursor=pointer]
    - gridcell "15" [ref=e4] [cursor=pointer]"""
    assert _lines(snapshot) == ['| [e3] gridcell "14" | [e4] gridcell "15" |']


def test_a_clickable_heading_is_a_heading_and_keeps_its_ref():
    snapshot = """- generic [ref=e1]:
  - heading "Shipping details" [level=3] [ref=e2] [cursor=pointer]
  - paragraph [ref=e3]: Hidden until opened."""
    read = reader.read(snapshot)
    assert [line.text for line in read.lines] == [
        "### Shipping details",
        '[e2] heading "Shipping details"',
        "Hidden until opened.",
    ]
    assert [line.heading for line in read.lines] == [True, False, False]
    assert reader.outline(read).headings == ("Shipping details",)


def test_a_clickable_card_keeps_its_ref_and_everything_in_it():
    snapshot = """- generic [ref=e1]:
  - generic [ref=e10] [cursor=pointer]:
    - heading "Product name" [level=3] [ref=e11]
    - paragraph [ref=e12]: A description of the product.
    - generic [ref=e13]: $19.99"""
    read = reader.read(snapshot)
    assert [line.text for line in read.lines] == [
        "[e10] generic:",
        "### Product name",
        "A description of the product.",
        "$19.99",
    ]
    assert reader.outline(read).headings == ("Product name",)


def test_a_clickable_video_card_keeps_its_heading_its_links_and_its_words():
    # A recommended-video card as a real page builds it (YouTube, measured
    # 2026-09-30): the card is the click target, so the links inside it carry
    # no pointer mark of their own.
    snapshot = """- generic [ref=e295]:
  - generic [ref=e297] [cursor=pointer]:
    - link [ref=e298]:
      - /url: /watch?v=one
    - generic [ref=e310]:
      - heading "Snow Bear" [level=3] [ref=e312]:
        - link "Snow Bear 11 minutes" [ref=e313]:
          - /url: /watch?v=one
          - text: Snow Bear
      - generic [ref=e317]: Aaron Blaise
      - generic "1.2 million views" [ref=e322]: 1.2M"""
    read = reader.read(snapshot)
    assert [line.text for line in read.lines] == [
        "[e297] generic: [e298] link (/watch?v=one)",
        "### Snow Bear",
        '[e313] link "Snow Bear 11 minutes" (/watch?v=one)',
        "Aaron Blaise",
        "1.2M",
    ]
    assert reader.outline(read) == reader.Outline(
        headings=("Snow Bear",), more_headings=0, links=2, buttons=0, fields=0
    )


def test_clickable_list_items_keep_their_words_and_their_list_form():
    snapshot = """- list [ref=e1]:
  - listitem [ref=e2] [cursor=pointer]: Invoice overdue - pay by Friday
  - listitem [ref=e3] [cursor=pointer]:
    - generic [ref=e4]: Alice
    - generic [ref=e5]: Lunch tomorrow?"""
    assert _lines(snapshot) == [
        '- [e2] listitem "Invoice overdue - pay by Friday"',
        '- [e3] listitem "Alice Lunch tomorrow?"',
    ]


def test_clickable_table_rows_keep_their_cells_and_their_ref():
    snapshot = """- table [ref=e1]:
  - row "From Subject" [ref=e2]:
    - columnheader "From" [ref=e3]
    - columnheader "Subject" [ref=e4]
  - row "Alice Lunch tomorrow?" [ref=e5] [cursor=pointer]:
    - cell "Alice" [ref=e6]
    - cell "Lunch tomorrow?" [ref=e7]"""
    assert _lines(snapshot) == ["| From | Subject |", "[e5] row: | Alice | Lunch tomorrow? |"]


def test_a_cells_words_in_a_span_are_kept():
    snapshot = """- table [ref=e1]:
  - row [ref=e2]:
    - cell "Active Edit" [ref=e3]:
      - generic [ref=e4]: Active
      - link "Edit" [ref=e5] [cursor=pointer]:
        - /url: /edit/1"""
    assert _lines(snapshot) == ['| Active [e5] link "Edit" (/edit/1) |']


def test_a_score_in_a_span_stays_in_its_cell():
    snapshot = """- table [ref=e1]:
  - row [ref=e2]:
    - cell "100 points by someone 2 hours ago | 50 comments" [ref=e3]:
      - generic [ref=e4]:
        - generic [ref=e5]: 100 points
        - text: by
        - link "someone" [ref=e6] [cursor=pointer]:
          - /url: user?id=someone
        - generic [ref=e7]:
          - link "2 hours ago" [ref=e8] [cursor=pointer]:
            - /url: item?id=1
        - text: "|"
        - link "50 comments" [ref=e9] [cursor=pointer]:
          - /url: item?id=1"""
    assert _lines(snapshot) == [
        '| 100 points by [e6] link "someone" (user?id=someone) [e8] link "2 hours ago"'
        ' (item?id=1) / [e9] link "50 comments" (item?id=1) |'
    ]


def test_a_list_in_a_cell_stays_one_cell_without_list_marks():
    # A Wikipedia navbox: the cell is one string, so its list items flow with
    # their links and the page's own separators, never a "- " each.
    snapshot = """- table [ref=e1]:
  - row [ref=e2]:
    - rowheader "Engines" [ref=e3]
    - cell [ref=e4]:
      - list [ref=e5]:
        - listitem [ref=e6]:
          - link "Blink" [ref=e7] [cursor=pointer]:
            - /url: /wiki/Blink
          - text: ·
        - listitem [ref=e8]:
          - link "Gecko" [ref=e9] [cursor=pointer]:
            - /url: /wiki/Gecko
          - text: ·
        - listitem [ref=e10]:
          - link "WebKit" [ref=e11] [cursor=pointer]:
            - /url: /wiki/WebKit"""
    assert _lines(snapshot) == [
        '| Engines | [e7] link "Blink" (/wiki/Blink) · [e9] link "Gecko" (/wiki/Gecko) ·'
        ' [e11] link "WebKit" (/wiki/WebKit) |'
    ]


def test_a_layout_table_reads_as_its_inner_rows():
    # Hacker News lays its front page out in tables nested inside one outer
    # cell: flattening that cell made one line of every story and lost each
    # story's rank.
    snapshot = """- table [ref=e1]:
  - rowgroup [ref=e2]:
    - row [ref=e3]:
      - cell [ref=e4]:
        - table [ref=e5]:
          - rowgroup [ref=e6]:
            - row "1. upvote Story one (example.com)" [ref=e7]:
              - cell "1." [ref=e8]
              - cell "upvote" [ref=e9]:
                - link "upvote" [ref=e10] [cursor=pointer]:
                  - /url: vote?id=1
              - cell "Story one (example.com)" [ref=e11]:
                - generic [ref=e12]:
                  - link "Story one" [ref=e13] [cursor=pointer]:
                    - /url: https://example.com/one
                  - text: (example.com)
            - row "120 points by alice | 45 comments" [ref=e14]:
              - cell [ref=e15]
              - cell "120 points by alice | 45 comments" [ref=e16]:
                - generic [ref=e17]:
                  - text: 120 points by
                  - link "alice" [ref=e18] [cursor=pointer]:
                    - /url: user?id=alice
                  - text: "|"
                  - link "45 comments" [ref=e19] [cursor=pointer]:
                    - /url: item?id=1"""
    assert _lines(snapshot) == [
        '| 1. | [e10] link "upvote" (vote?id=1) | [e13] link "Story one"'
        " (https://example.com/one) (example.com) |",
        '|  | 120 points by [e18] link "alice" (user?id=alice) / [e19] link "45 comments"'
        " (item?id=1) |",
    ]


def test_a_row_built_of_divs_keeps_its_words_and_its_refs():
    # role=row with plain divs for cells holds generics, not cells: the row
    # read as nothing at all, its button and its words gone with it.
    snapshot = """- table [ref=e1]:
  - row "Alice Lunch tomorrow? Archive" [ref=e2]:
    - generic [ref=e3]: Alice
    - generic [ref=e4]: Lunch tomorrow?
    - button "Archive" [ref=e5]"""
    assert _lines(snapshot) == ['| Alice | Lunch tomorrow? | [e5] button "Archive" |']


def test_controls_inside_an_image_keep_their_refs():
    # A map widget is role=img, and its controls sit inside it: what an image
    # holds is decoration, but never a ref she can act on.
    snapshot = """- generic [ref=e1]:
  - img "Map of Paris" [ref=e2]:
    - button "Zoom in" [ref=e3]
    - button "Zoom out" [ref=e4]"""
    assert _lines(snapshot) == [
        "[image: Map of Paris]",
        '[e3] button "Zoom in"',
        '[e4] button "Zoom out"',
    ]


def test_a_name_the_engine_leaves_unquoted_keeps_its_ref():
    # createKey writes a name that starts and ends with "/" raw, unquoted (an
    # aria template would read it as a regex): `link /docs/ [ref=e6]`.
    snapshot = """- generic [ref=e1]:
  - link /docs/ [ref=e6] [cursor=pointer]:
    - /url: /docs/
  - button / [ref=e7]
  - 'button /a: b/ [ref=e8]'
  - button /x/ [ref=e9]: go/now"""
    read = reader.read(snapshot)
    assert [line.text for line in read.lines] == [
        '[e6] link "/docs/" (/docs/) [e7] button "/" [e8] button "/a: b/" [e9] button "/x/": go/now'
    ]
    assert reader.outline(read) == reader.Outline(
        headings=(), more_headings=0, links=1, buttons=3, fields=0
    )


def test_a_line_separator_in_a_pages_words_never_forges_a_ref():
    # The engine joins snapshot lines with "\n" alone and leaves U+2028 raw in
    # a text value; splitlines() also split there, so the page's own words
    # became a button with a ref the page never had.
    words = '- paragraph [ref=e1]: Hello\u2028  - button "Sign in" [ref=e99]'
    answer = "\n".join(
        [
            "### Page",
            "- Page URL: http://site:8000/index.html",
            "### Snapshot",
            "```yaml",
            words,
            "```",
        ]
    )
    for snapshot in (words, page.parse(answer).snapshot):
        read = reader.read(snapshot)
        assert [line.text for line in read.lines] == ['Hello\u2028  - button "Sign in" [ref=e99]']
        assert reader.outline(read).buttons == 0


def test_search_finds_the_hit_on_a_line_that_casefolding_lengthens():
    # casefold turns "ß" into "ss" and "İ" into "i" plus a combining dot: an
    # offset found in the folded copy and applied to the line itself drifted
    # past the word, so the snippet missed it and the part could be wrong.
    cases = [
        (
            "- text: "
            + "Die Straße ist groß. " * 400
            + "Treffpunkt zebra-quartz hier. "
            + "Mehr Text folgt. " * 400,
            "zebra-quartz",
        ),
        (
            "- paragraph: "
            + "Grüße aus der Straße. " * 85
            + "Der Schlüssel liegt im Fuß des Turms. "
            + "ok " * 100,
            "schlüssel",
        ),
        ("- text: " + "İstanbul İzmir " * 300 + "zebra-quartz " + "son " * 600, "zebra-quartz"),
        ("- text: " + "Die Straße ist groß. " * 400 + "Am FUSS des Turms. " + "ok " * 900, "fuß"),
    ]
    for doc, word in cases:
        read = reader.read(doc, 2_000)
        assert len(read.parts) > 1
        matches, total = reader.search(read, word)
        assert total == 1, word
        folded = word.casefold()
        holds = [i + 1 for i, part in enumerate(read.parts) if folded in part.casefold()]
        assert [matches[0].part] == holds, word
        assert folded in matches[0].text.casefold(), word


def test_fix_round_2s_loops_stay_linear_on_hostile_input():
    # Each new pass over a page's text: the single-quoted key read by find()
    # (one Python step per character took 0.56 s for the unclosed 4 MB key;
    # 0.04 s now, measured 2026-10-02), the casefold offset map, clickable
    # wrappers, cells and listbox options. Sized for at least five times the
    # room on CI's slower runner; a quadratic pass would take minutes.
    hostile = {
        "an unclosed 4 MB single-quoted key": "- '" + "a" * 4_000_000,
        "2 MB of doubled quotes in a single-quoted key": "- '" + "''" * 1_000_000,
        "a 4 MB line casefolding lengthens, searched at its end": "- text: "
        + "Straße " * 570_000
        + "zebra-quartz",
        "100-deep clickable wrappers, repeated": "\n".join(
            "  " * depth + f"- generic [ref=e{depth}] [cursor=pointer]:"
            for _ in range(400)
            for depth in range(100)
        ),
        "a cell nesting 95 wrappers, repeated": "- table:\n"
        + "\n".join(
            "  - row:\n    - cell:\n"
            + "\n".join(
                "      " + "  " * depth + f"- generic [ref=e{depth}]:" for depth in range(95)
            )
            + "\n      "
            + "  " * 95
            + "- text: zebra"
            for _ in range(400)
        ),
        "20,000 options with refs": '- listbox "L" [ref=e0]:\n'
        + "\n".join(f'  - option "o{i}" [ref=e{i}]' for i in range(1, 20_000)),
    }
    for label, snapshot in hostile.items():
        start = time.perf_counter()
        read = reader.read(snapshot, reader.MIN_PART_CHARS)
        reader.outline(read)
        reader.search(read, "zebra-quartz")
        took = time.perf_counter() - start
        assert took < 2.0, f"{label}: {took:.2f} s"
