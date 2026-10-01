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
