"""deploy/README.md's section on how a turn stops, pinned to the code it
describes (no-ceiling T8; was the tool-round-limit section, tool-rounds-setting
T4 / turn-cap T4-T5).

The owner removed the tool-round limit (2026-10-08: "I'd prefer to not have a
limit at all"): no count of rounds stops a turn, the circling stop is the only
round-based stop, and a round that comes back thinking only is re-asked, then
passed to the next link. The README is where an operator who sees a stop note
learns what it means. Each fact it states is one the code owns, so each is
checked against the code here rather than trusted:

- no count: chat.py writes no "without finishing" note, the setting and its
  Settings field are gone, and the section names neither;
- the circling stop: its two notes, quoted with N where core writes the rounds
  used, from chat.CIRCLING_NOTE_WORDS; its two numbers from
  chat.SAME_CALL_LIMIT and chat.STALE_ROUNDS_LIMIT, read on every check, and
  no other number beside them;
- what a stopped reply shows: chat.TOOL_RESULTS_HEADER, quoted;
- a thinking-only round: chat.THINKING_ONLY_REASON and the trace step's name
  and actions, as chat.py files them;
- what bounds a runaway, and that a scheduled firing has no wall-clock cut
  (scheduler.firing_timeout_s), with the read timeout from chat.GATEWAY_TIMEOUT.

The loops themselves are pinned elsewhere (test_turn_progress.py,
test_capped_turn_answers.py, test_thinking_only_round.py, test_scheduler.py).
No database: these read files and module attributes only.
"""

from __future__ import annotations

import re
from pathlib import Path

from app import chat, scheduler, settings_store

REPO = Path(__file__).resolve().parents[3]
README = REPO / "deploy" / "README.md"
SETTINGS_PAGES = REPO / "apps" / "web" / "src" / "pages" / "settings"

HEADING = "## When a turn stops"
OLD_HEADING = "## The tool-round limit"
OLD_KEY = "agents.max_tool_rounds"

# The owner's stop, as chat.py routes it: a path, not a number, so its digit is
# not one the number pin judges.
STOP_ROUTE = f"{chat.router.prefix}/turns/{{id}}/stop"

NOTE_HEAD = "[stopped after "
# The capped note that no longer exists: neither core nor the README says it.
OLD_NOTE_TAIL = " tool rounds without finishing]"


def _section() -> str:
    """The section's text: the lines after its heading, up to the next `## `
    heading or the end of the file. The README must have exactly one."""
    lines = README.read_text(encoding="utf-8").splitlines()
    starts = [i for i, line in enumerate(lines) if line.rstrip() == HEADING]
    assert len(starts) == 1, f"deploy/README.md has {len(starts)} `{HEADING}` sections, not one"
    body = lines[starts[0] + 1 :]
    end = next((i for i, line in enumerate(body) if line.startswith("## ")), len(body))
    return "\n".join(body[:end])


def _says(text: str, phrase: str) -> bool:
    """Whether the text says the phrase, word for word and case for case, with
    any whitespace between its words (a hand-wrapped line may break inside it)
    and nothing word-like glued to either end."""
    words = r"\s+".join(re.escape(word) for word in phrase.split())
    return re.search(rf"(?<!\w){words}(?!\w)", text) is not None


def _ordinal(n: int) -> str:
    suffix = "th" if 10 <= n % 100 <= 20 else {1: "st", 2: "nd", 3: "rd"}.get(n % 10, "th")
    return f"{n}{suffix}"


def _pinned_numbers() -> tuple[str, ...]:
    """Every phrase with a number the section may state, each built from the
    code NOW: the circling stop's two limits and the gateway read timeout."""
    return (
        f"for the {_ordinal(chat.SAME_CALL_LIMIT)} time",
        f"{chat.STALE_ROUNDS_LIMIT} rounds in a row",
        f"{int(chat.GATEWAY_TIMEOUT.read)} seconds",
    )


def _numbers_problem(section: str) -> str | None:
    """What the section gets wrong about a number, or None: each pinned phrase
    must be said, and no digit may stand anywhere else (a number nothing pins
    stays put the day the code moves it)."""
    rest = section.replace(STOP_ROUTE, " ")
    for phrase in _pinned_numbers():
        if not _says(section, phrase):
            return f"the section must say `{phrase}`"
        rest = re.sub(r"\s+".join(re.escape(w) for w in phrase.split()), " ", rest)
    unpinned = re.findall(r"\d+", rest)
    if unpinned:
        return f"the section states numbers nothing pins: {unpinned}"
    return None


def test_no_count_of_rounds_is_described_or_written():
    """Replaces the old limit pins (where it is set, its range, its default,
    the backstop, what reaching it does, the capped note): the limit is gone,
    so the section names none of it and chat.py writes no capped note."""
    readme = README.read_text(encoding="utf-8")
    assert OLD_HEADING not in readme, f"deploy/README.md still has `{OLD_HEADING}`"
    assert OLD_KEY not in settings_store.DEFS_BY_KEY
    assert not (SETTINGS_PAGES / "ToolRoundsSection.tsx").exists()
    assert OLD_NOTE_TAIL.strip(" ]") not in Path(chat.__file__).read_text(encoding="utf-8")

    section = _section()
    assert _says(section, "No count of tool rounds stops a turn.")
    for gone in (OLD_KEY, "Tool-round limit", "Tool rounds", "without finishing", "backstop"):
        assert gone not in section, f"the section still says `{gone}`"


def test_the_section_says_how_a_circling_turn_is_stopped_and_quotes_its_notes():
    source = Path(chat.__file__).read_text(encoding="utf-8")
    assert (
        'f"[stopped after {stop_rounds} tool rounds: {CIRCLING_NOTE_WORDS[stop_reason]}]"' in source
    ), "chat.py no longer writes the circling note this section quotes"
    section = _section()
    for why in chat.CIRCLING_NOTE_WORDS.values():
        note = f"{NOTE_HEAD}N tool rounds: {why}]"
        assert _says(section, note), f"the section does not quote `{note}`"
    for fact in ("the same call", "nothing new", "no tools offered", "round_stop"):
        assert _says(section, fact), f"the section does not say `{fact}`"


def test_the_section_states_the_circling_numbers_the_code_has():
    problem = _numbers_problem(_section())
    assert problem is None, problem


def test_the_numbers_it_must_state_move_with_the_code(monkeypatch):
    """Move a limit and the same check, on the README as it stands, fails
    naming the phrase it now looks for. A number typed here would keep
    passing the README's old one."""
    section = _section()
    assert _numbers_problem(section) is None

    monkeypatch.setattr(chat, "SAME_CALL_LIMIT", 4)
    problem = _numbers_problem(section)
    assert problem is not None and "`for the 4th time`" in problem, problem
    monkeypatch.undo()

    monkeypatch.setattr(chat, "STALE_ROUNDS_LIMIT", 5)
    problem = _numbers_problem(section)
    assert problem is not None and "`5 rounds in a row`" in problem, problem


def test_the_section_states_no_number_the_code_does_not_pin():
    section = _section()
    assert _numbers_problem(section) is None
    problem = _numbers_problem(f"{section}\nup to 50 rounds")
    assert problem is not None and "['50']" in problem, problem


# What a stopped reply shows when her last answer is no answer (turn-cap T2):
# chat.tool_results_statement, read off the turn's tool spans, under its header.
STOPPED_REPLY = ("no words of its own", "asks for a tool", "what the tools returned")


def test_the_section_says_what_a_stopped_reply_shows_when_she_does_not_answer():
    assert callable(chat.tool_results_statement)
    section = _section()
    for fact in (*STOPPED_REPLY, chat.TOOL_RESULTS_HEADER):
        assert _says(section, fact), f"the section does not say `{fact}`"


def test_the_section_says_a_thinking_only_round_is_reasked_then_passed_over():
    source = Path(chat.__file__).read_text(encoding="utf-8")
    for filed in ('turn.span("round_retry")', '"reask"', '"pass_over"'):
        assert filed in source, f"chat.py files no `{filed}`"
    section = _section()
    for fact in (
        "re-asked once",
        "next link",
        "round_retry",
        "reask",
        "pass_over",
        f"Stopped: {chat.THINKING_ONLY_REASON}:",
    ):
        assert _says(section, fact), f"the section does not say `{fact}`"


def test_the_section_says_what_bounds_a_runaway_and_that_firings_are_uncut():
    assert any(
        getattr(r, "path", None) == f"{chat.router.prefix}/turns/{{turn_id}}/stop"
        for r in chat.router.routes
    )
    assert scheduler.firing_timeout_s("scheduled") is None
    section = _section()
    for fact in (
        "What bounds a runaway",
        STOP_ROUTE,
        "monthly spending caps on cloud providers",
        "A local model costs nothing",
        "no wall-clock cut",
    ):
        assert _says(section, fact), f"the section does not say `{fact}`"
