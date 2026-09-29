"""The written-call guard: her reply writes one of HER tools as a call, in text.

The owner's test, 2026-09-28 (tests/said_not_done_walk.py). Asked to open
Teams on his Dell she made ZERO tool calls and wrote

    ```bash
    device_launch_app "DELL-XPS-8950" "Teams"
    ```

then said "Teams is now opening". A minute later, asked why nothing opened,
she wrote fences of `device_info "DELL-XPS-8950"` and more, again with no
call. markup_calls reads a fence as teaching BY DESIGN and that ruling stands
(prose never dispatches). This guard never runs anything either: it names the
tool she wrote, and the turn's one redirect asks HER to make the call.

The rule (guards.written_call_check): the exact name of a tool advertised THIS
turn, then argument syntax — `(` straight after the name, or after optional
spaces a `[`/`{`, or after a space a quote or a `--flag`; the bracket forms
must open onto a value, so a signature `(device, argv)` is not a call — in a
fence, inline code or prose, and no span of that tool (successful or
attempted) this turn. Silent on an explanation, a report of a call that ran,
a question, relayed or quoted text, an example, and a table.
"""

from __future__ import annotations

from types import SimpleNamespace

import pytest

from app import guards, tools
from tests.said_not_done_walk import (
    FE7E3198,
    T3DEE5106,
    T98ECFB11,
    T890B1C63,
)
from tests.test_guards import _every_correction

NAMES = tools.tool_names()


def _span(name: str, *, ok: bool = True, **meta) -> SimpleNamespace:
    return SimpleNamespace(kind="tool", name=name, meta={"ok": ok, **meta})


def check(reply: str, spans=(), names=NAMES):
    return guards.written_call_check(reply, list(spans), names)


# -- the owner's real turns ---------------------------------------------------


def test_the_teams_turn_wrote_device_launch_app_as_a_fence():
    claim = check(T890B1C63)
    assert claim is not None
    assert claim.tools == ("device_launch_app",)
    assert 'device_launch_app "DELL-XPS-8950"' in claim.phrase


def test_the_why_not_turn_wrote_device_info_and_a_tool_she_does_not_have():
    """device_list_processes is not a registered tool: it is not HER call, so
    only device_info is named."""
    claim = check(T3DEE5106)
    assert claim is not None
    assert claim.tools == ("device_info",)


def test_the_notepad_turn_wrote_no_call():
    assert check(T98ECFB11) is None


def test_the_brave_turn_wrote_no_call():
    launched = _span("device_launch_app", result_head="Launched brave on DELL-XPS-8950.")
    assert check(FE7E3198, [launched]) is None
    assert check(FE7E3198) is None


# -- what counts: CODE, framed as her action now (fix round 1, C2) -----------


@pytest.mark.parametrize(
    "reply",
    [
        'Let me check:\n```\ndevice_info("DELL-XPS-8950")\n```',
        "I'll check now: `device_info('DELL-XPS-8950')`",
        'Running `device_info(device="DELL-XPS-8950")` now.',
        'Now calling `device_info(device: "DELL-XPS-8950")`.',
        'I\'ll run it:\n```\ndevice_run(["ls", "-la"])\n```',
        'Launching it: `device_run(argv=["ls"])`',
        'I\'m running `device_run ["ls", "-la"]` on your Dell.',
        'Let me run:\n```\ndevice_run {"device": "DELL-XPS-8950", "argv": ["ls"]}\n```',
        "No problem — I'll run `device_info 'DELL-XPS-8950'`.",
        "Let me list them: `device_list_files --device DELL-XPS-8950 --path /home`",
        'Now: `functions.device_run({"device": "DELL-XPS-8950", "argv": ["ls"]})`',
        '1. Let me check the OS first:\n```\ndevice_info "DELL-XPS-8950"\n```',
        'I haven\'t opened it yet. Let me launch it now:\n```\ndevice_run ["notepad"]\n```',
        # A fence with nothing before it IS the answer.
        '```\ndevice_info "DELL-XPS-8950"\n```',
        '```python\nresult = device_run(["ls"])\n```',
    ],
)
def test_a_written_call_framed_as_her_action_now_fires(reply):
    claim = check(reply)
    assert claim is not None, reply
    assert claim.tools[0] in ("device_info", "device_run", "device_list_files")


def test_the_longest_name_is_the_one_written():
    claim = check('Let me list it: `device_list_files("DELL-XPS-8950", "/home")`')
    assert claim is not None and claim.tools == ("device_list_files",)


def test_every_distinct_unbacked_tool_is_named_once_in_order():
    reply = '```\ndevice_info "A"\ndevice_run ["ls"]\ndevice_info "B"\n```'
    claim = check(reply)
    assert claim is not None and claim.tools == ("device_info", "device_run")


# -- a call in PROSE is a word, never a call (C2, I1a) --------------------------


@pytest.mark.parametrize(
    "reply",
    [
        'device_info("DELL-XPS-8950")',
        'I am calling device_info("DELL-XPS-8950") to check.',
        'Let me run device_run ["ls"] for you.',
        "device_list_files --device DELL-XPS-8950 --path /home",
        # the English-word tool names (review I1a): notices, web_search
        'You have two notices "Backup failed" and "Disk low", both from last week.',
        "Your open notices “Backup failed” and “Disk low” are from last week.",
        "The notices 'Backup failed' and 'Disk low' are still open.",
        "There are 3 notices [1] Backup failed [2] Disk low [3] Timer late.",
        'My web_search "latest pixel" from yesterday found the Pixel 10.',
        'Yesterday I ran device_run ["notepad"] on your Dell.',
        'I haven\'t called device_launch_app "DELL-XPS-8950" "Teams" yet.',
    ],
)
def test_a_call_in_prose_never_fires(reply):
    assert check(reply) is None, reply


# -- an explanation, a signature, a mention: no argument, no call --------------


@pytest.mark.parametrize(
    "reply",
    [
        "device_run runs a program on a paired device.",
        "I can use device_run to run a program, or device_info to read the OS.",
        "The tool is `device_run`.",
        'The tool is "device_run" and it takes an argv list.',
        "device_run (the shell tool) needs the program first.",
        "device_run(device, argv) runs a program; argv is a list of strings.",
        "device_run(device: str, argv: list[str]) -> str",
        "Call get_time() whenever you need the clock.",
        "device_run's output is the program's stdout.",
        "See [device_run](https://example.com/tools#device_run) for details.",
        'The call looked like <invoke name="device_run"> in the transcript.',
        '{"name": "device_run", "arguments": {"argv": ["ls"]}}',
        "device_run [device] [argv] — the usage line.",
        'mydevice_run("ls") is not one of my tools.',
        'device_run_all("ls") is not one of my tools.',
        "Use device_run: it runs a command.",
    ],
)
def test_no_argument_syntax_is_no_call(reply):
    assert check(reply) is None, reply


# -- code that is NOT her action now: the review's shapes (C2, I1, I2) ---------


@pytest.mark.parametrize(
    "label,reply",
    [
        ("explain-like", 'device_run takes an argv list, like `device_run ["ls", "-la"]`.'),
        ("explain-colon", 'device_run takes an argv list: `device_run ["ls", "-la"]`.'),
        (
            "tool-what-does",
            'device_launch_app starts an app by name — `device_launch_app "DELL-XPS-8950" '
            '"Notepad"` would open Notepad.',
        ),
        (
            "would-run",
            'To clear the temp folder I would run `device_run ["cmd", "/c", "del", "/q", '
            '"C:\\\\Temp\\\\*"]`.',
        ),
        ("could-run", 'I could run `device_run ["shutdown", "/r", "/t", "0"]` to restart it.'),
        (
            "offer-fence",
            'I can run this for you:\n```\ndevice_run ["cmd", "/c", "rmdir", "/s", "/q", '
            '"C:\\\\Temp"]\n```\nWant me to go ahead?',
        ),
        ("offer-inline", 'Want me to run `device_run ["shutdown", "/r"]` now?'),
        (
            "if-you-want",
            'If you want, I can call `device_write_file("notes.txt", "hello")` on your Dell.',
        ),
        (
            "you-can-open-by",
            'You can open Notepad by asking me to call `device_launch_app "DELL-XPS-8950" '
            '"Notepad"`.',
        ),
        (
            "bullet-list",
            'My device tools:\n- `device_info "<device>"` — hardware and OS\n- `device_run '
            '["argv"]` — run a program\n- `device_launch_app "<device>" "<app>"` — open an app',
        ),
        (
            "numbered",
            'Here is what each does:\n1. `device_run ["ls"]` lists a directory\n2. '
            '`device_read_file("C:/x.txt")` reads a file',
        ),
        ("table", '| tool | example |\n|---|---|\n| device_run | `device_run ["ls"]` |'),
        ("past-earlier", 'Earlier today I ran `device_run ["notepad"]` and it exited 0.'),
        ("recap", 'Here is what I ran at 15:56: `device_run ["notepad"]` — exit 0.'),
        ("the-command-was", 'The command I used last time was `device_run ["notepad"]`.'),
        ("dont-run", 'Do not run `device_run ["format", "C:"]` — it would wipe the disk.'),
        ("never-call", 'I will never call `device_run ["rm", "-rf", "/"]`.'),
        ("i-didnt", 'I did not run `device_run ["notepad"]` this turn.'),
        (
            "the-nudge's-own-honest-answer",
            'I have not run `device_launch_app "DELL-XPS-8950" "Teams"` — I only wrote it as '
            "text, so nothing was launched.",
        ),
        (
            "proposal-fence",
            'To clear your temp folder I would run this:\n```\ndevice_run ["cmd", "/c", '
            '"del", "/q", "/s", "C:\\\\Users\\\\Public\\\\Temp\\\\*"]\n```\n'
            "Want me to go ahead?",
        ),
        ("show-you", 'Let me show you what the call looks like: `device_info "DELL-XPS-8950"`'),
        ("warning-to-owner", 'Do not run `device_run ["format", "C:", "/q"]` on your Dell.'),
    ],
)
def test_code_that_is_not_her_action_now_is_silent(label, reply):
    assert check(reply) is None, label


# -- a report of a call that ran ----------------------------------------------


def test_a_report_of_a_call_that_ran_is_backed():
    reply = 'I ran `device_run(["ls", "/tmp"])` and it listed three files.'
    assert check(reply, [_span("device_run")]) is None


def test_an_attempted_call_backs_it_too():
    """Successful OR attempted: a call that failed was still made."""
    reply = 'I ran `device_run(["ls", "/tmp"])` but it failed: the device is offline.'
    assert check(reply, [_span("device_run", ok=False)]) is None


def test_backing_is_per_tool():
    """A span of ANOTHER tool backs nothing here: she wrote device_info."""
    reply = '```\ndevice_info "DELL-XPS-8950"\n```'
    claim = check(reply, [_span("device_run")])
    assert claim is not None and claim.tools == ("device_info",)


def test_a_refused_markup_call_is_not_an_attempt():
    """guards._attempted's one definition: a call written as markup and
    refused never ran, so it backs nothing."""
    refused = _span("device_info", ok=False, refused_markup_as_text=True)
    claim = check('```\ndevice_info "DELL-XPS-8950"\n```', [refused])
    assert claim is not None and claim.tools == ("device_info",)


# -- a question, relayed or quoted text, an example, a table ------------------


@pytest.mark.parametrize(
    "reply",
    [
        'Should I run `device_info("DELL-XPS-8950")`?',
        'What does device_run(["ls"]) print on Windows?',
        'You said device_run(["ls"]) failed earlier.',
        'He mentioned that device_info("DELL-XPS-8950") timed out.',
        'The error read "device_run(["ls"]) timed out" in the log.',
        '> device_run(["ls", "-la"])',
        '  > device_info "DELL-XPS-8950"',
        'For example, `device_run(["ls", "-la"])` lists a folder.',
        'e.g. device_info("DELL-XPS-8950") returns the OS and disk.',
        'The syntax is device_run(["program", "arg"]).',
        'Example:\n```\ndevice_run(["ls", "-la"])\n```',
        'Usage:\n\n```bash\ndevice_info "<device>"\n```',
        '| Tool | Example |\n|---|---|\n| device_run | `device_run(["ls"])` |',
    ],
)
def test_questions_relays_quotes_examples_and_tables_are_silent(reply):
    assert check(reply) is None, reply


# -- derived from the turn's advertised names, never a list --------------------


def test_a_tool_not_advertised_this_turn_is_not_hers():
    """An agent shown a subset without device_launch_app: the fence names a
    tool it does not have, so it is not HER call."""
    subset = [name for name in NAMES if name != "device_launch_app"]
    assert check(T890B1C63, names=subset) is None


def test_a_tool_registered_tomorrow_is_read_the_day_it_is_advertised():
    """device_list_processes does not exist today. Advertise it and the SAME
    reply names it too, with no change to the guard."""
    claim = check(T3DEE5106, names=[*NAMES, "device_list_processes"])
    assert claim is not None
    assert claim.tools == ("device_info", "device_list_processes")


def test_nothing_to_read_is_silent():
    assert check("") is None
    assert check("   \n ") is None
    assert check(T890B1C63, names=[]) is None


# -- clean over the rest of the family's words ---------------------------------
#
# DERIVED from the modules, like test_guards' own pin: every correction in
# guards.py and every note chat.py ships. A guard that fired on another guard's
# correction would append a contradiction to a contradiction.


def _every_note() -> list[tuple[str, str]]:
    from app import chat

    return sorted(
        (name, value)
        for name in dir(chat)
        if name.endswith("NOTE") and isinstance(value := getattr(chat, name), str)
    )


@pytest.mark.parametrize(
    "name,text",
    [*_every_correction(), *_every_note()],
    ids=[c[0] for c in [*_every_correction(), *_every_note()]],
)
def test_clean_over_every_correction_and_note(name, text):
    assert check(text) is None, name


# -- cost: guards run in core's event loop -------------------------------------
#
# Timed where every guard's cost is pinned: test_guard_regex_timing.py sweeps
# each of this guard's patterns and reads 50 KB of its worst shapes in 100 ms.
