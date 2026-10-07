"""deploy/README.md's section on the tool-round limit, pinned to the code it
describes (tool-rounds-setting epic, T4).

The owner kept seeing "[stopped after 6 tool rounds without finishing]" and
chose a Settings field for the limit over a new default. The README is where
an operator who sees that note learns where the limit is set, what reaching it
does, its range and its default. Each of those is a fact the code owns, so each
is checked against the code here rather than trusted:

- the names: the ones the app draws (the Behaviour tab, the "Tool rounds"
  section, its "Tool-round limit" field) and the key the field stores, read
  from the checkout as text, the way test_native_app.py reads nativeApp.ts;
- the note: the one chat.py writes, quoted with N where core writes the limit;
- what reaching it does: the two facts chat.py's loop makes true, said in the
  section (tools run from at most N-1 calls; she then answers with no tools
  offered). Here only as words: test_chat_tools.py pins the loop itself
  (test_the_round_cap_stops_and_says_so,
  test_the_cap_gets_one_toolless_narration_round_that_answers);
- the numbers: agents.MIN_ROUNDS..agents.MAX_ROUNDS and the def's default,
  read from the code on every check (as T1's hook reads the bounds at write
  time), never typed here, and no other number beside them. The day the code
  moves one, this file turns red until the README says the new number.

No database: these read files and module attributes only.
"""

from __future__ import annotations

import dataclasses
import re
from pathlib import Path

from app import agents, chat, settings_store

REPO = Path(__file__).resolve().parents[3]
README = REPO / "deploy" / "README.md"
SETTINGS_PAGES = REPO / "apps" / "web" / "src" / "pages" / "settings"

HEADING = "## The tool-round limit"
KEY = "agents.max_tool_rounds"

# The note a capped reply ends with, as the README quotes it: N where core
# writes the limit, so the doc carries no number there that nothing pins.
NOTE_HEAD, NOTE_TAIL = "[stopped after ", " tool rounds without finishing]"
NOTE = f"{NOTE_HEAD}N{NOTE_TAIL}"

# Each name the section gives, and the text that draws or stores it in the
# app: a rename there turns this file red until the README follows.
NAMES = (
    ("Settings → Behaviour", SETTINGS_PAGES / "tabs.ts", "label: 'Behaviour'"),
    ("Tool rounds", SETTINGS_PAGES / "ToolRoundsSection.tsx", 'title="Tool rounds"'),
    ("Tool-round limit", SETTINGS_PAGES / "ToolRoundsSection.tsx", 'label="Tool-round limit"'),
    (KEY, SETTINGS_PAGES / "ToolRoundsSection.tsx", f"TOOL_ROUNDS_KEY = '{KEY}'"),
)

# Every range and every default the section states, whatever their numbers,
# each number taken whole: `between 1 and 500` is the pair (1, 500), never
# `between 1 and 50` with a digit more. Case and line breaks do not matter
# (the README is wrapped by hand); the numbers do.
RANGES = re.compile(r"(?<!\w)between\s+(\d+)\s+and\s+(\d+)(?!\w)", re.IGNORECASE)
DEFAULTS = re.compile(r"(?<!\w)default\s+is\s+(\d+)(?!\w)", re.IGNORECASE)

# Arithmetic on the limit ("tools run from at most N-1 calls") moves with N by
# construction and copies no number from the code: the one place a digit may
# stand in the section outside the range and default phrases.
ON_N = re.compile(r"(?<!\w)N\s*[-+]\s*\d+(?!\w)")

# What reaching the limit does, in the words the section says it with: the
# last allowed call's tools do not run, so tools run from at most N-1 calls,
# and she then answers with no tools offered (the note that follows has its
# own id). test_chat_tools.py pins the loop that makes both true.
REACHING = ("N-1", "no tools")


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


def _numbers_problem(section: str) -> str | None:
    """What the section gets wrong about the limit's range or default, or None.

    What it must say is built from the code NOW, on every call: the range from
    agents.MIN_ROUNDS and agents.MAX_ROUNDS, the default from the
    `agents.max_tool_rounds` def. It must say each, and no other: a second,
    stale number beside the right one is a number nothing pins."""
    low, high = agents.MIN_ROUNDS, agents.MAX_ROUNDS
    default = settings_store.DEFS_BY_KEY[KEY].default
    for wanted, said in (
        (f"between {low} and {high}", [f"between {a} and {b}" for a, b in RANGES.findall(section)]),
        (f"default is {default}", [f"default is {d}" for d in DEFAULTS.findall(section)]),
    ):
        if not said or any(phrase != wanted for phrase in said):
            found = ", ".join(f"`{phrase}`" for phrase in said) or "none"
            return f"the section must say `{wanted}` and no other; it says {found}"
    return None


def _unpinned_numbers(section: str) -> list[str]:
    """Each number the section states outside its range and default phrases
    (which _numbers_problem holds to the code) and outside arithmetic on N:
    a number nothing pins, so it would stay put the day the code moved."""
    rest = ON_N.sub(" ", DEFAULTS.sub(" ", RANGES.sub(" ", section)))
    return re.findall(r"\d+", rest)


# The app-side and chat.py checks below hold without the README section, so
# each shares its id with an assert on the section rather than standing alone.


def test_the_section_says_where_the_limit_is_set_in_the_names_the_app_draws():
    for _name, source, drawn in NAMES:
        assert drawn in source.read_text(encoding="utf-8"), f"{source.name} has no {drawn}"
    assert KEY in settings_store.DEFS_BY_KEY

    section = _section()
    for name, _source, _drawn in NAMES:
        assert _says(section, name), f"the section does not say `{name}`"


def test_the_section_quotes_the_note_core_ends_a_capped_reply_with():
    """The note in the owner's request, so a reader who sees it is led here.
    chat.py must still write it, with the limit in an f-string field, or the
    README would quote a note core no longer writes."""
    field = r"\{[^{}]+\}"
    written = re.compile('f"' + re.escape(NOTE_HEAD) + field + re.escape(NOTE_TAIL) + '"')
    source = Path(chat.__file__).read_text(encoding="utf-8")
    assert written.search(source), f"chat.py writes no f-string `{NOTE}` with N a field"

    section = _section()
    assert _says(section, NOTE), f"the section does not quote `{NOTE}`"
    numbered = r"\s+".join(re.escape(word) for word in NOTE_HEAD.split()) + r"\s+\d"
    assert re.search(numbered, section) is None, "the section quotes the note with a number, not N"


def test_the_section_says_what_reaching_the_limit_does():
    """Not only the note's words: what happened before it landed. A section
    cut down to where the limit is set and its numbers passes every other id
    here, and leaves a reader who sees the note no wiser about what it cost."""
    section = _section()
    for fact in REACHING:
        assert _says(section, fact), f"the section does not say `{fact}`"


def test_the_section_states_the_range_and_the_default_the_code_has():
    problem = _numbers_problem(_section())
    assert problem is None, problem


def test_a_section_saying_another_number_instead_fails_the_pin():
    """The criterion's three, built from the code's numbers: with the code at
    1..50 and 6 they are `between 1 and 500`, `between 0 and 50` and
    `default is 60`, each written where the section says the right one."""
    section = _section()
    problem = _numbers_problem(section)
    assert problem is None, problem

    low, high = agents.MIN_ROUNDS, agents.MAX_ROUNDS
    default = settings_store.DEFS_BY_KEY[KEY].default
    for said, right, wrong in (
        (RANGES, f"between {low} and {high}", f"between {low} and {high}0"),
        (RANGES, f"between {low} and {high}", f"between {low - 1} and {high}"),
        (DEFAULTS, f"default is {default}", f"default is {default}0"),
    ):
        problem = _numbers_problem(said.sub(lambda _match: wrong, section))
        assert problem is not None, f"a section saying `{wrong}` instead passed the pin"
        assert f"`{right}`" in problem and f"`{wrong}`" in problem, problem


def test_the_section_states_no_number_the_code_does_not_pin():
    """The pin holds every number the section states, not only the phrases it
    looks for. Said again in other words beside them (`up to 50`, `6 by
    default`), a number stays put the day the code moves it, and the README
    then says both. Arithmetic on N ("N-1") is the one digit allowed."""
    section = _section()
    problem = _numbers_problem(section)
    assert problem is None, problem
    unpinned = _unpinned_numbers(section)
    assert unpinned == [], f"the section states numbers nothing pins: {unpinned}"

    high = agents.MAX_ROUNDS
    default = settings_store.DEFS_BY_KEY[KEY].default
    for stale, number in ((f"up to {high}", high), (f"{default} by default", default)):
        found = _unpinned_numbers(f"{section}\n{stale}")
        assert found == [str(number)], f"a section also saying `{stale}` gave {found}"


def test_the_range_it_must_state_moves_with_agents_bounds(monkeypatch):
    """Move agents' pair and the same check, on the README as it stands, fails
    naming the pair it now looks for. A range typed here, or copied once, would
    keep passing the README's old numbers."""
    section = _section()
    problem = _numbers_problem(section)
    assert problem is None, problem

    monkeypatch.setattr(agents, "MIN_ROUNDS", 3)
    monkeypatch.setattr(agents, "MAX_ROUNDS", 60)

    problem = _numbers_problem(section)
    assert problem is not None, "the README's range still passed with agents' bounds at 3..60"
    assert "`between 3 and 60`" in problem, problem


def test_the_default_it_must_state_moves_with_the_defs_default(monkeypatch):
    """Move the def's default and the same check, on the README as it stands,
    fails naming the default it now looks for."""
    section = _section()
    problem = _numbers_problem(section)
    assert problem is None, problem

    moved = dataclasses.replace(settings_store.DEFS_BY_KEY[KEY], default=7)
    monkeypatch.setitem(settings_store.DEFS_BY_KEY, KEY, moved)

    problem = _numbers_problem(section)
    assert problem is not None, "the README's default still passed with the def's default at 7"
    assert "`default is 7`" in problem, problem
