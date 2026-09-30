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
tool she wrote, and — since fix round 3 — the turn appends ONE sentence, "(I
wrote <tool> as text; it did not run.)", and does nothing else: no redirect,
no nudge, no invitation (T1, T2).

The rule (guards.written_call_check): the exact name of a tool advertised THIS
turn, then argument syntax — `(` straight after the name, or after optional
spaces a `[`/`{`, or after a space a quote or a `--flag`; the bracket forms
must open onto a value, so a signature `(device, argv)` is not a call — in
CODE (a fence or inline code), framed as her action now, and no span of that
tool (successful or attempted) this turn. Silent on an explanation, a report of
a call that ran, a question, relayed or quoted text, an example, and a table.

Fix round 2 (2026-09-29, the scoped re-review of 83ae4c99): "her action now" is
an intent and a verb of DOING ("I'll confirm…", "let me launch…"); "let me
know / warn you / walk you through", "I'll wait / skip / avoid" are not leads,
and a gerund opening a sentence is not one either ("Calling `…` returns…")
except as a fragment above a fence (890b1c63's "Launching Microsoft Teams via
the Windows desktop environment."). A hedge ("would", any subject), a
condition ("once you confirm", "if"), waiting for his go-ahead, or a recap
anywhere in the sentence rules the call out, and a fence is judged with the
sentence after it ("Shall I go ahead?").

Fix round 3 (2026-09-29): a false fire now costs that one TRUE sentence, never
an action — the re-review drove "Running this formats your C: drive:" above a
`format C: /q` fence into a redirect with 43 tools. The gerund fragment above a
fence is her narration only when it is not a heading, a generic object ("an
app", "a file") or a "this"/"that"/"it" it says something about.
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
    # (fix round 3, T2) the ONE sentence the turn appends, exactly
    assert claim.text == "(I wrote device_launch_app as text; it did not run.)"


def test_the_why_not_turn_wrote_device_info_and_a_tool_she_does_not_have():
    """device_list_processes is not a registered tool: it is not HER call, so
    only device_info is named."""
    claim = check(T3DEE5106)
    assert claim is not None
    assert claim.tools == ("device_info",)
    assert claim.text == "(I wrote device_info as text; it did not run.)"


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
        'Now calling `device_info(device: "DELL-XPS-8950")`.',
        'I\'ll run it:\n```\ndevice_run(["ls", "-la"])\n```',
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
        # fix round 2: a verb of doing after the intent, and what still leads
        'I\'ll go ahead and run `device_run ["notepad"]` on your Dell.',
        'Let me first check the OS:\n```\ndevice_info "DELL-XPS-8950"\n```',
        # "if" after a verb of finding out is "whether" (3dee5106's own intro)
        'I\'ll confirm if **DELL-XPS-8950** is online:\n```bash\ndevice_info "DELL-XPS-8950"\n```',
        'Let me verify it (even if it is hidden):\n```\ndevice_run ["tasklist"]\n```',
        # a gerund FRAGMENT above a fence narrates her action (890b1c63's shape)
        'Launching **Notepad** on your Dell.\n\n```bash\ndevice_run ["notepad"]\n```',
        # a question LATER in the paragraph after the fence does not take it back
        '```\ndevice_info "DELL-XPS-8950"\n```\nChecking now. Want anything else?',
    ],
)
def test_a_written_call_framed_as_her_action_now_fires(reply):
    claim = check(reply)
    assert claim is not None, reply
    assert claim.tools[0] in ("device_info", "device_run", "device_list_files")


# -- fix round 2 (C2): the second review's shapes, none her action now ----------
#
# The re-reviewer's 23 fresh shapes (scratchpad rr2/probe_c2_wc.py), each silent
# for the cause it names: waiting for his go-ahead, a warning, an explanation.


@pytest.mark.parametrize(
    "label,reply",
    [
        (
            "let-me-know",
            'Let me know if this looks right:\n```\ndevice_run ["cmd", "/c", "rmdir", "/s", '
            '"/q", "C:\\\\Temp"]\n```',
        ),
        (
            "wait-for-go-ahead",
            'I\'ll wait for your go-ahead before running `device_run ["cmd", "/c", "del", "/q", '
            '"C:\\\\Temp\\\\*"]`.',
        ),
        (
            "once-you-confirm",
            'Once you confirm, I\'ll run `device_run ["shutdown", "/r", "/t", "0"]`.',
        ),
        ("confirm-after", 'I\'ll run `device_run ["shutdown", "/r", "/t", "0"]` once you confirm.'),
        ("say-the-word", 'Say the word and I\'ll run `device_run ["shutdown", "/r", "/t", "0"]`.'),
        (
            "as-soon-as",
            'I\'ll run `device_run ["shutdown", "/r", "/t", "0"]` as soon as you give the '
            "go-ahead.",
        ),
        (
            "shall-i-after-the-fence",
            'To clear the temp folder, I\'ll run this:\n```\ndevice_run ["cmd", "/c", "del", "/q", '
            '"/s", "C:\\\\Temp\\\\*"]\n```\nShall I go ahead?',
        ),
        (
            "hold-off",
            'I\'m going to hold off on `device_run ["format", "C:", "/q"]` until you confirm.',
        ),
        ("would-wipe", 'Running `device_run ["format", "C:", "/q"]` would wipe your disk.'),
        (
            "let-me-warn",
            'Let me warn you: `device_run ["format", "C:", "/q"]` wipes the whole disk.',
        ),
        (
            "caution-then-never",
            'Now, a word of caution:\n```\ndevice_run ["format", "C:", "/q"]\n```\nNever run this.',
        ),
        (
            "stop-you",
            'Let me stop you right there — `device_run ["format", "C:", "/q"]` would erase '
            "your disk.",
        ),
        ("skip", 'I\'ll skip `device_run ["format", "C:", "/q"]` — it is too risky.'),
        ("refrain", 'I\'ll refrain from calling `device_run ["format", "C:", "/q"]`.'),
        ("avoid", 'I\'ll avoid `device_run ["format", "C:", "/q"]` here.'),
        ("calling-returns", 'Calling `device_info "DELL-XPS-8950"` returns the OS and hardware.'),
        (
            "break-down",
            'Let me break down the command: `device_run ["cmd", "/c", "del", "/s", "/q", '
            '"C:\\\\Temp\\\\*"]` deletes every file in Temp.',
        ),
        (
            "walk-through",
            'Let me walk you through it:\n```\ndevice_run ["cmd", "/c", "rmdir", "/s", "/q", '
            '"C:\\\\Temp"]\n```\nThis removes the folder.',
        ),
        (
            "clarify",
            'Let me clarify what this does:\n```\ndevice_run ["cmd", "/c", "rmdir", "/s", "/q", '
            '"C:\\\\Temp"]\n```',
        ),
        (
            "should-have-run",
            'Now, the call that should have run is `device_launch_app "DELL-XPS-8950" "Teams"`.',
        ),
        (
            "another-way",
            'Let me put it another way: `device_run ["shutdown", "/r"]` restarts the machine.',
        ),
        (
            "opening-needs",
            'Opening `device_launch_app "DELL-XPS-8950" "Notepad"` needs the agent online.',
        ),
        (
            "paste-for-reference",
            "Here is the exact call, for your reference. I'll paste it:\n```\n"
            'device_launch_app "DELL-XPS-8950" "Teams"\n```',
        ),
    ],
)
def test_the_second_reviews_shapes_are_never_calls(label, reply):
    assert check(reply) is None, label


@pytest.mark.parametrize(
    "reply",
    [
        # round 1 read these as leads; a gerund opening a sentence is not one
        'Running `device_info(device="DELL-XPS-8950")` now.',
        'Launching it: `device_run(argv=["ls"])`',
        'Checking `device_info "DELL-XPS-8950"` is how you read the OS.',
        # a gerund above a fence with a verb of its own is the subject of it
        'Calling it returns the OS:\n```\ndevice_info "DELL-XPS-8950"\n```',
        'Running this wipes the disk:\n```\ndevice_run ["format", "C:"]\n```',
    ],
)
def test_a_gerund_is_not_her_lead(reply):
    assert check(reply) is None, reply


@pytest.mark.parametrize(
    "after",
    [
        "Shall I run it?",
        "Never run this on a live machine.",
        "Do not run this yet.",
        "This would erase the drive.",
        "If you want, I can run it for you.",
        "Let me know when you're ready.",
    ],
)
def test_a_fence_is_judged_with_the_sentence_after_it(after):
    """(C2) The first sentence after a fence can take it back: the same intro
    fires with nothing after it, and is silent with each of these."""
    fence = 'I\'ll run it:\n```\ndevice_run ["format", "C:"]\n```'
    assert check(fence) is not None
    assert check(f"{fence}\n{after}") is None, after
    assert check(f"{fence}\n\n---\n\n{after}") is None, after


def test_the_teams_turns_fence_is_hers_by_its_gerund_fragment_and_its_follow():
    """890b1c63: the fence's intro is the gerund fragment "Launching Microsoft
    Teams via the Windows desktop environment." and the sentence after it is
    "Teams is now opening…" — not a question. Its question comes two
    sentences later and takes nothing back."""
    claim = check(T890B1C63)
    assert claim is not None and claim.fenced == (True,)
    assert claim.where == "a code block"


def test_where_says_fence_inline_or_both():
    fenced = check('```\ndevice_info "DELL-XPS-8950"\n```')
    inline = check("I'll check now: `device_info('DELL-XPS-8950')`")
    both = check("I'll check now: `device_info('DELL-XPS-8950')`\n```\ndevice_run [\"ls\"]\n```")
    assert fenced is not None and fenced.where == "a code block"
    assert inline is not None and inline.where == "inline code"
    assert both is not None and both.tools == ("device_info", "device_run")
    assert both.where == "code"


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
        # "NOTE" anywhere in the name: the redirects' no-call notes
        # (`*_NOTE_NO_CALL`, fix round 5, P6) are shipped text too.
        if "NOTE" in name and isinstance(value := getattr(chat, name), str)
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


# -- fix round 3: one sentence, and what the re-review drove into a redirect ----


def test_the_sentence_is_the_record_and_invites_nothing():
    """(T2) Exactly "(I wrote <tool> as text; it did not run.)" — the calls
    she wrote, and that they did not run — and never an offer, an
    instruction or a question."""
    one = guards.WrittenCallClaim(tools=("device_launch_app",), phrase="x")
    two = guards.WrittenCallClaim(tools=("device_info", "device_run"), phrase="x")
    three = guards.WrittenCallClaim(tools=("device_info", "device_run", "web_search"), phrase="x")
    assert one.text == "(I wrote device_launch_app as text; it did not run.)"
    assert two.text == "(I wrote device_info and device_run as text; they did not run.)"
    assert three.text == (
        "(I wrote device_info, device_run and web_search as text; they did not run.)"
    )
    for said in (one.text, two.text, three.text):
        lowered = said.lower()
        for invitation in ("ask me", "again", "i'll", "want", "?", "please", "make the call"):
            assert invitation not in lowered, (invitation, said)


R = 'device_run ["shutdown", "/r", "/t", "0"]'
FMT = 'device_run ["format", "C:", "/q"]'
F = "```"


@pytest.mark.parametrize(
    "label,reply",
    [
        # how-to headings and labels above an example fence (rr3 probe_wc)
        ("heading", f'### Running a command\n{F}\ndevice_run ["ls", "-la"]\n{F}'),
        (
            "an app",
            f'Launching an app on a paired device:\n{F}\ndevice_launch_app(device="DELL-XPS-8950", '
            f'app="notepad")\n{F}\nReplace notepad with any app from the list.',
        ),
        ("a file", f'1. Opening a file\n{F}\ndevice_run ["notepad", "C:\\\\notes.txt"]\n{F}'),
        (
            "a notification",
            f'Sending a desktop notification:\n{F}\ndevice_notify(device="DELL-XPS-8950", '
            f'message="hi")\n{F}',
        ),
        (
            "heading two",
            f'## Starting an app remotely\n{F}\ndevice_launch_app(device="DELL-XPS-8950", '
            f'app="Teams")\n{F}',
        ),
        # warnings whose verb no closed list holds (R1: the format command)
        ("formats", f"Running this formats your C: drive:\n{F}\n{FMT}\n{F}"),
        ("destroys", f"Running this destroys everything on C:.\n{F}\n{FMT}\n{F}"),
        ("reformats", f"Running this reformats the drive.\n{F}\n{FMT}\n{F}"),
        ("bricks", f"Calling this bricks the agent.\n{F}\n{R}\n{F}"),
        (
            "nukes",
            f'Running this nukes the temp folder.\n{F}\ndevice_run ["cmd", "/c", "rmdir", "/s", '
            f'"/q", "C:\\\\Temp"]\n{F}',
        ),
        ("it wipes", f"Running it formats your drive.\n{F}\n{FMT}\n{F}"),
    ],
)
def test_a_heading_a_generic_object_or_a_warning_is_no_lead(label, reply):
    """(fix round 3) The gerund fragment above a fence is her narration only
    when it is not a heading, a generic object, or a "this"/"that"/"it" the
    fragment then says something about — whatever the verb."""
    assert check(reply) is None, label


@pytest.mark.parametrize(
    "label,reply,tool",
    [
        (
            "bold label",
            f'**Checking the OS:**\n{F}\ndevice_info "DELL-XPS-8950"\n{F}',
            "device_info",
        ),
        ("send you", f"I'll send you the command:\n{F}\n{R}\n{F}", "device_run"),
        ("write out", f"Let me write out the command for you:\n{F}\n{R}\n{F}", "device_run"),
        ("write down", f"Let me write that down:\n{F}\n{R}\n{F}", "device_run"),
        ("copy", f"I'll copy the command here:\n{F}\n{R}\n{F}", "device_run"),
        ("read back", f"Let me read it back to you:\n{F}\n{R}\n{F}", "device_run"),
        (
            "list the steps",
            f"Let me list the steps:\n{F}\n{FMT}\n{F}\nThat is what the tool call looks like.",
            "device_run",
        ),
        ("syntax", f"Let me get the syntax right:\n{F}\n{R}\n{F}", "device_run"),
        ("proposed", f"Let me check the command I proposed:\n{F}\n{R}\n{F}", "device_run"),
        ("later", f"I'll use this command later:\n{F}\n{R}\n{F}", "device_run"),
        ("tomorrow", f"Let's test it tomorrow:\n{F}\n{R}\n{F}", "device_run"),
        ("next time", f"I'll save this for next time:\n{F}\n{R}\n{F}", "device_run"),
        ("double-check", f"Let me double-check the syntax with you:\n{F}\n{R}\n{F}", "device_run"),
        ("inline paste", f"I'll send you `{R}` to paste into chat.", "device_run"),
        ("bare fence", f"{F}\n{R}\n{F}", "device_run"),
        ("bare fence + note", f"{F}\n{R}\n{F}\nThat restarts it immediately.", "device_run"),
        (
            "too risky",
            f"I'll run it:\n{F}\n{FMT}\n{F}\nActually, no — that's too risky.",
            "device_run",
        ),
        ("kidding", f"I'll run it:\n{F}\n{FMT}\n{F}\nJust kidding — I won't.", "device_run"),
        ("wait", f"I'll run it:\n{F}\n{FMT}\n{F}\nWait — that wipes the disk.", "device_run"),
    ],
)
def test_what_still_reads_as_her_call_costs_one_true_sentence(label, reply, tool):
    """(fix round 3, T1/T2) The re-review's other shapes still read as her
    call written as text — and each once took a redirect with every tool
    advertised. Now each costs exactly this sentence, which is TRUE of every
    one of them: she wrote the call as text, and it did not run."""
    claim = check(reply)
    assert claim is not None, label
    assert claim.tools == (tool,), label
    assert claim.text == f"(I wrote {tool} as text; it did not run.)", label


# -- fix round 4 (2026-09-30, the controller's ruling R1): a delegation ran -------
#
# The re-review's repro (scratchpad rr4/probe_fresh.py): Nova delegates to an
# agent that holds device_launch_app, the agent launches Notepad in ITS OWN
# turn, and Nova's relay shows the call it had the agent make. The parent turn's
# record holds only the delegate_to_agent span — the call ran in the child's —
# so "(I wrote device_launch_app as text; it did not run.)" was false. When a
# delegation RAN an agent this turn, this turn's record cannot say what was
# done, and the guard is silent for the turn. The child's spans are not read.

DEVICE = "DELL-XPS-8950"
F = "```"
DELEGATED = _span(
    "delegate_to_agent",
    args_redacted={"agent": "ops", "task": f"open notepad on {DEVICE}"},
    facts=[
        {
            "agent": "ops",
            "agent_turn_id": "t2",
            "status": "ok",
            "files": [],
            "rounds": 2,
            "calls_ok": 1,
            "calls_failed": 0,
        }
    ],
    result_head=f"ops finished — status ok … I launched Notepad on {DEVICE}.",
)
# Its child turn ran, then the run ended in an error: what it did before that is
# in the child's record just the same.
DELEGATED_THEN_FAILED = _span(
    "delegate_to_agent",
    ok=False,
    args_redacted={"agent": "ops", "task": f"open notepad on {DEVICE}"},
    error="Error: ops did not finish — its run ended in an error",
    facts=[{"agent": "ops", "agent_turn_id": "t2", "status": "error"}],
)
LAUNCH_FENCE = f'{F}\ndevice_launch_app "{DEVICE}" "notepad"\n{F}'
RELAYS = [
    f"Launching Notepad via ops:\n{LAUNCH_FENCE}",
    f"Running it through ops:\n{LAUNCH_FENCE}",
    f"I'll have ops run it:\n{LAUNCH_FENCE}",
    f"ops ran this:\n{LAUNCH_FENCE}",
    f"Here is what ops ran:\n{LAUNCH_FENCE}",
    T890B1C63,
]


@pytest.mark.parametrize("reply", RELAYS)
def test_R1_a_delegation_that_ran_an_agent_silences_the_turn(reply):
    assert check(reply, [DELEGATED]) is None
    assert check(reply, [DELEGATED_THEN_FAILED]) is None


def test_R1_the_relays_fire_without_the_delegation():
    """Not vacuous: the relays that read as her call still do when no agent
    ran — the delegation is what silences them."""
    for reply in (RELAYS[0], RELAYS[1], T890B1C63):
        claim = check(reply)
        assert claim is not None, reply
        assert claim.text == "(I wrote device_launch_app as text; it did not run.)"


@pytest.mark.parametrize(
    "label,span",
    [
        (
            "refused before any run (no agent by that name)",
            _span(
                "delegate_to_agent",
                ok=False,
                args_redacted={"agent": "opz", "task": "open notepad"},
                error="Error: no agent named 'opz'",
                facts=[{"agent": "opz", "status": "refused"}],
            ),
        ),
        (
            "written as markup and refused",
            _span(
                "delegate_to_agent",
                ok=False,
                refused_markup=True,
                args_redacted={"agent": "ops", "task": "open notepad"},
            ),
        ),
        ("another agent tool that ran", _span("create_agent", args_redacted={"name": "ops"})),
    ],
)
def test_R1_a_delegation_that_ran_no_agent_leaves_the_record_readable(label, span):
    """A delegation refused before any child turn ran (an unknown agent, a call
    written as markup) ran nothing anywhere: the turn's record is the whole
    record, and the sentence it supports is still true."""
    claim = check(f"Launching Notepad via ops:\n{LAUNCH_FENCE}", [span])
    assert claim is not None, label
    assert claim.text == "(I wrote device_launch_app as text; it did not run.)", label


# -- fix round 5 (2026-09-30, P1): a delegation that MAY have run ----------------
#
# The child-turn marker is filed only after the executor reads the child's turn
# back, so a delegation that raised after its child ran carries none, and a
# scripted delegate step copies no facts. Either may have made the call she
# shows (scratchpad rr5/probe_fresh.py, R1c).


@pytest.mark.parametrize(
    "label,span",
    [
        (
            "raised after its child ran",
            _span(
                "delegate_to_agent",
                ok=False,
                args_redacted={"agent": "ops", "task": "open notepad"},
                error="Error: delegate_to_agent failed unexpectedly — X: y",
            ),
        ),
        (
            "a scripted delegate step",
            _span(
                "delegate_to_agent",
                ok=False,
                via_skill=True,
                step=0,
                args_redacted={"agent": "ops", "task": "open notepad"},
                error="Error: agent ops did not finish — its turn closed with status error",
            ),
        ),
    ],
)
def test_P1_a_delegation_that_may_have_run_silences_the_turn(label, span):
    for reply in RELAYS:
        assert check(reply, [span]) is None, (label, reply)
