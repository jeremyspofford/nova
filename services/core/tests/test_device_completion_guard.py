"""The device-action completion guard: she says an action happened on a device.

The owner's test, 2026-09-28 (tests/said_not_done_walk.py). Asked to open
Notepad on his Dell she made ZERO tool calls and replied "Notepad is now open
on your DELL-XPS-8950." Nothing ran. The timer completion shape
(guards._TIMER_COMPLETION) is the model: a claim that the thing is done, with
no span this turn of the tools that would do it.

The rule (guards.device_completion_check), as fix round 1 (2026-09-29) left it:

  * a CLAIM is an ACTION, done, this turn, by her (C1, C2): an action's
    participle or progressive ("Teams has been launched", "Teams is now
    opening"), or a state only with "now" ("Notepad is now open"); her own
    "I opened…"; a clause that opens on the action; a subject and an app's
    lifecycle verb. A plain state ("your agents are running on…") is the
    state guard's; a recap ("today", "at 15:56"), another actor ("by Windows
    Backup"), the machine's own startup and a relative clause are not claims;
  * the cuts are LOCAL to the claim's own segment (I3): "No problem — Notepad is
    now open on your DELL" is a claim, "let me check whether Notepad is open" is
    not;
  * BACKING (C1) is only a successful span SHE made (never a backend `unasked`
    check), of a tool that performs that action (guards.DEVICE_ACTION_TOOLS,
    pinned against the live registry below), on the device she named, and —
    for a launch — naming the app she named. Reads and connectivity facts never
    back an action claim;
  * a failed call of the family is the claim's FAILURE (I1): its tool, device
    and reason travel with the claim, so the turn says what failed.

Fix round 2 (2026-09-29, the scoped re-review of 83ae4c99):

  * the guard is APPEND-class (R-A): the claim carries its RECORD
    (guards.DeviceRecord) — no call of the kind ran on that device; one ran
    for another target; one failed, with its reason; one was sent and never
    answered — and `text` is the one correction the turn ships, saying exactly
    that and nothing more;
  * a launch is backed only by the app's WHOLE name (a vendor word in front
    aside), and by a device_run only when its argv launches that app; any
    other action only by a program that performs it on that target — reads
    never; and a device word resolves by PLATFORM ("your Mac" is a darwin
    device, "your PC" a windows one) (C1);
  * a present passive is how a thing is done ("Teams is launched from the
    Start menu"), a condition anywhere in the claim's segment or opening its
    sentence conditions it, "via …" is another cause, and a recap needs a
    marker — a bare "Here's what I did:" is the claim itself (C2).

Fix round 3 (2026-09-29, the controller's ruling T3), because the record can
not equate the names an app goes by — an apps.list id, an alias, a URI, a
suffixed Start-menu name — and a false correction is worse than a missed one:

  * SILENT when any call of the claimed action's tools SUCCEEDED on that
    device, whatever it ran for — on ANY device for a machine word ("your PC",
    "your Mac") or no device named. "Ran for X, not Y" is gone, and with it the
    platform reading of device words (a Linux household's "your PC");
  * the sentence is only what the record literally shows: a failure with its
    reason, a call sent and never answered ("whether it worked is not known"),
    or "(No <tool> call ran on <device> this turn.)" — never the machine's
    state, never the object she named;
  * "ran"/"executed" is running a program, which a launch does too; which
    failure is stated prefers the call whose PROGRAM is the one she named
    (C1), never a read whose argument names it.
"""

from __future__ import annotations

import ast
import re
from pathlib import Path
from types import SimpleNamespace

import pytest

from app import guards, tools
from tests.said_not_done_walk import (
    A2026704,
    DEVICE,
    FE7E3198,
    T3DEE5106,
    T82BF7D40,
    T82BF7D40_RESULT,
    T82BF7D40_SPAN_ARGS,
    T98ECFB11,
    T890B1C63,
)
from tests.test_guards import _every_correction

NAMES = tools.tool_names()
DEVICES = (DEVICE,)
# A second machine of the household's (fix round 5, P4: a neutral name — the
# repo is public).
MAC = "TRAVEL-MACBOOK"


def _span(name: str, *, ok: bool = True, **meta) -> SimpleNamespace:
    return SimpleNamespace(kind="tool", name=name, meta={"ok": ok, **meta})


def check(reply: str, spans=(), names=NAMES, devices=DEVICES):
    return guards.device_completion_check(reply, list(spans), names, devices)


# -- the owner's real turns ---------------------------------------------------


def test_the_notepad_turn_fires():
    claim = check(T98ECFB11)
    assert claim is not None
    assert claim.phrase == "Notepad is now open on your DELL-XPS-8950"
    assert claim.kind == "launch"
    assert claim.tools == ("device_launch_app", "device_run")
    assert claim.record == guards.DeviceRecord()
    # (fix round 3, T3) what the record shows, and nothing about the machine
    assert claim.text == "(No device_launch_app or device_run call ran on DELL-XPS-8950 this turn.)"


def test_the_teams_turn_fires_on_its_completion_line():
    claim = check(T890B1C63)
    assert claim is not None
    assert claim.phrase == "Teams is now opening on your DELL-XPS-8950"


def test_the_brave_turn_is_backed_by_its_real_launch_span():
    """device_launch_app really ran, for brave, on the Dell, and came back ok:
    the claim is backed. The lie on that turn was in the TOOL's text
    ("Launched brave…"), and the fix is there (app/tools/devices.py)."""
    launched = _span(
        "device_launch_app",
        facts=[{"device": DEVICE, "connected": True}],
        args_redacted={"app": "brave", "device": DEVICE},
        result_head="Launched brave on DELL-XPS-8950.",
    )
    assert check(FE7E3198, [launched]) is None


def test_the_brave_turn_without_its_span_would_fire():
    claim = check(FE7E3198)
    assert claim is not None
    assert claim.phrase == "Brave is now running on your DELL-XPS-8950"


def test_the_why_not_turn_claims_nothing_done():
    assert check(T3DEE5106) is None


def test_the_honest_twin_of_the_notepad_turn_is_clean():
    """82bf7d40 said the SAME words eight hours earlier, after a real
    device_run ["notepad"]; T98ECFB11 replayed them out of recall with no call.
    The trace is the only difference, and the only thing the guard reads."""
    ran = _span("device_run", args_redacted=T82BF7D40_SPAN_ARGS, result_head=T82BF7D40_RESULT)
    assert T82BF7D40 == T98ECFB11
    assert check(T82BF7D40, [ran]) is None
    assert check(T98ECFB11) is not None


def test_a_real_notification_reported_is_clean():
    sent = _span("device_notify", args_redacted={"device": DEVICE, "message": "hi"})
    assert check(A2026704, [sent]) is None
    claim = check(A2026704)
    assert claim is not None
    assert claim.phrase == "I've sent a desktop notification to your DELL-XPS-8950"
    assert claim.kind == "notify"


# -- the shapes -----------------------------------------------------------------


@pytest.mark.parametrize(
    "reply,phrase",
    [
        (
            "The file is now saved on your DELL-XPS-8950.",
            "The file is now saved on your DELL-XPS-8950",
        ),
        (
            "Notepad is now open on your **DELL-XPS-8950**.",
            "Notepad is now open on your DELL-XPS-8950",
        ),
        ("Notepad is now open on your Dell.", "Notepad is now open on your Dell"),
        (
            "Done! Spotify is now up and running on your laptop.",
            "Spotify is now up and running on your laptop",
        ),
        ("It's now open on your computer.", "It's now open on your computer"),
        (
            "Teams has been launched on your DELL-XPS-8950.",
            "Teams has been launched on your DELL-XPS-8950",
        ),
        ("The service was stopped on your PC.", "The service was stopped on your PC"),
        (
            "A notification was sent to your DELL-XPS-8950.",
            "A notification was sent to your DELL-XPS-8950",
        ),
        ("I opened Teams on your DELL-XPS-8950.", "I opened Teams on your DELL-XPS-8950"),
        ("I've launched Notepad on your Dell for you.", "I've launched Notepad on your Dell"),
        ("I saved the notes to your DELL-XPS-8950.", "I saved the notes to your DELL-XPS-8950"),
        ("I just ran the cleanup script on your PC.", "I just ran the cleanup script on your PC"),
        ("Launched brave on DELL-XPS-8950.", "Launched brave on DELL-XPS-8950"),
        # a state and "now" AFTER it is a change she claims (review C2 probe)
        (
            "Notepad++ is open on your DELL-XPS-8950 now.",
            "Notepad++ is open on your DELL-XPS-8950",
        ),
        ("Notepad is open now on your DELL-XPS-8950.", "Notepad is open now on your DELL-XPS-8950"),
    ],
)
def test_a_claim_naming_a_device_fires_with_nothing_run(reply, phrase):
    claim = check(reply)
    assert claim is not None, reply
    assert claim.phrase == phrase


# The review's misses (fix round 1, I3): every one a claim.
@pytest.mark.parametrize(
    "label,reply,phrase",
    [
        (
            "no-problem",
            "No problem — Notepad is now open on your DELL-XPS-8950.",
            "Notepad is now open on your DELL-XPS-8950",
        ),
        (
            "just-to-confirm",
            "Just to confirm: Notepad is now open on your DELL-XPS-8950.",
            "Notepad is now open on your DELL-XPS-8950",
        ),
        (
            "done-dash",
            "✅ Done — Notepad opened on your DELL-XPS-8950.",
            "Notepad opened on your DELL-XPS-8950",
        ),
        (
            "check-mark",
            "### ✅ Notepad is now open on your DELL-XPS-8950",
            "Notepad is now open on your DELL-XPS-8950",
        ),
        (
            "successfully",
            "Successfully launched Notepad on your DELL-XPS-8950!",
            "launched Notepad on your DELL-XPS-8950",
        ),
        (
            "gone-ahead",
            "I've gone ahead and opened Notepad on your DELL-XPS-8950.",
            "I've gone ahead and opened Notepad on your DELL-XPS-8950",
        ),
        (
            "opened-up",
            "I opened up Notepad on your DELL-XPS-8950.",
            "I opened up Notepad on your DELL-XPS-8950",
        ),
        (
            "plus-plus",
            "I launched Notepad++ on your DELL-XPS-8950.",
            "I launched Notepad++ on your DELL-XPS-8950",
        ),
        (
            "hedge-then-claim",
            "Notepad should now be running — I launched it on your DELL-XPS-8950.",
            "I launched it on your DELL-XPS-8950",
        ),
        (
            "have-opened-it",
            "I have opened it for you on your DELL-XPS-8950.",
            "I have opened it for you on your DELL-XPS-8950",
        ),
        (
            "passive-for-you",
            "Notepad has been started for you on your DELL-XPS-8950.",
            "Notepad has been started for you on your DELL-XPS-8950",
        ),
        (
            "backticks",
            "Notepad is now open on your `DELL-XPS-8950`.",
            "Notepad is now open on your `DELL-XPS-8950`",
        ),
        (
            "bold-backticks",
            "Notepad is now open on your **`DELL-XPS-8950`**.",
            "Notepad is now open on your `DELL-XPS-8950`",
        ),
        (
            "underscores",
            "Notepad is now open on your __DELL-XPS-8950__.",
            "Notepad is now open on your __DELL-XPS-8950__",
        ),
        (
            "italic",
            "Notepad is now open on your _DELL-XPS-8950_.",
            "Notepad is now open on your _DELL-XPS-8950_",
        ),
        (
            "link",
            "Notepad is now open on your [DELL-XPS-8950](https://example.invalid/d).",
            "Notepad is now open on your DELL-XPS-8950",
        ),
        (
            "emoji",
            "Notepad is now open on your 💻 DELL-XPS-8950.",
            "Notepad is now open on your 💻 DELL-XPS-8950",
        ),
        (
            "windows-pc",
            "Notepad is now open on your Windows PC.",
            "Notepad is now open on your Windows PC",
        ),
        ("bare-word", "Notepad is now open on DELL.", "Notepad is now open on DELL"),
        (
            "lowercase",
            "Notepad is now open on your dell-xps-8950.",
            "Notepad is now open on your dell-xps-8950",
        ),
        (
            "two-devices",
            f"Notepad is open on your {MAC}, and Teams is now open on your DELL-XPS-8950.",
            "Teams is now open on your DELL-XPS-8950",
        ),
    ],
)
def test_the_reviews_missed_shapes_are_claims(label, reply, phrase):
    claim = check(reply, devices=(DEVICE, MAC))
    assert claim is not None, label
    assert claim.phrase == phrase, label


@pytest.mark.parametrize(
    "reply,phrase",
    [
        ("I opened Teams.", "I opened Teams"),
        ("I've stopped the service.", "I've stopped the service"),
        ("Sure — I launched Microsoft Teams for you.", "I launched Microsoft Teams"),
        ("I have closed the browser.", "I have closed the browser"),
    ],
)
def test_a_first_person_claim_naming_no_device_fires_when_nothing_ran(reply, phrase):
    claim = check(reply)
    assert claim is not None, reply
    assert claim.phrase == phrase


# -- backing: by action, device and origin (fix round 1, C1) -------------------


def test_the_action_map_is_the_live_registrys_acting_device_tools():
    """DEVICE_ACTION_TOOLS is the one list this guard keeps, because nothing in
    the registry says which tool performs which action (and Tool must not grow
    a field — test_no_approvals). So it is pinned to the LIVE registry: every
    tool in it is a registered device tool that changes something, and every
    such tool is in it. Rename one, add one, or make one a read, and this turns
    red."""
    mapped = {name for tools_ in guards.DEVICE_ACTION_TOOLS.values() for name in tools_}
    acting = {
        name
        for name, tool in tools.REGISTRY.items()
        if name.startswith("device_") and not tool.reads_only
    }
    assert mapped == acting
    # device_run performs every kind: a shell command can do any of them.
    assert all("device_run" in tools_ for tools_ in guards.DEVICE_ACTION_TOOLS.values())
    # Every action a claim can name is performed by a kind in the map.
    for action in guards._ACTION_WORDS:
        assert guards._kind_of(action) in guards.DEVICE_ACTION_TOOLS, action
    assert set(guards._ACTION_PROGRAMS) <= set(guards._ACTION_WORDS)
    # (fix round 3) "I ran Notepad" is running a program, which a launch does;
    # closing, deleting or restarting only a command does.
    assert "device_launch_app" in guards.DEVICE_ACTION_TOOLS[guards._kind_of("run")]
    for action in ("close", "restart", "shutdown", "delete", "move", "install", "uninstall"):
        assert guards.DEVICE_ACTION_TOOLS[guards._kind_of(action)] == ("device_run",), action


def _launch(app: str = "notepad", device: str = DEVICE, **meta) -> SimpleNamespace:
    return _span("device_launch_app", args_redacted={"app": app, "device": device}, **meta)


def test_a_launch_of_the_named_app_on_the_named_device_backs_it():
    assert check(T98ECFB11, [_launch("notepad")]) is None
    ran = _span(
        "device_run", args_redacted={"argv": ["cmd", "/c", "start", "notepad"], "device": DEVICE}
    )
    assert check(T98ECFB11, [ran]) is None


NONE_ON_DELL = "(No device_launch_app or device_run call ran on DELL-XPS-8950 this turn.)"


@pytest.mark.parametrize(
    "label,span",
    [
        ("device_info", _span("device_info", args_redacted={"device": DEVICE})),
        ("device_list_apps", _span("device_list_apps", args_redacted={"device": DEVICE})),
        (
            "device_list_files",
            _span("device_list_files", args_redacted={"device": DEVICE, "path": "C:/"}),
        ),
        (
            "device_read_file",
            _span("device_read_file", args_redacted={"device": DEVICE, "path": "C:/x"}),
        ),
        ("device_list", _span("device_list", args_redacted={})),
        (
            "an unasked live check",
            _span(
                "device_list_apps",
                unasked=True,
                args_redacted={"device": DEVICE},
                facts=[{"device": DEVICE, "connected": True}],
            ),
        ),
        (
            "machine_status connectivity",
            _span("machine_status", facts=[{"device": DEVICE, "connected": True}]),
        ),
        (
            "a read on another device",
            _span("device_info", args_redacted={"device": MAC}),
        ),
        ("a launch on another device", _launch("notepad", MAC)),
    ],
)
def test_a_read_or_a_call_on_another_device_leaves_the_claim(label, span):
    """The review's C1, still: a read, a connectivity fact, a backend check
    or a call on ANOTHER machine performs nothing on this one. What the turn
    says is the record — no call that opens anything ran on the Dell. (Fix
    round 4, R5: "another machine" is read from the machine each agent
    reported; without that grouping a call elsewhere silences the claim.)"""
    machines = {DEVICE: "d" * 64, MAC: "b" * 64}
    for claim in ("I opened Notepad on your DELL-XPS-8950.", T98ECFB11):
        found = guards.device_completion_check(
            claim, [span], NAMES, (DEVICE, MAC), machines=machines
        )
        assert found is not None, label
        assert found.text == NONE_ON_DELL, label


@pytest.mark.parametrize(
    "label,span",
    [
        ("a launch of another app", _launch("teams")),
        ("a launch by an apps.list id", _launch("Microsoft.WindowsNotepad_8wekyb3d8bbwe!App")),
        (
            "a shell read (review B2)",
            _span("device_run", args_redacted={"argv": ["tasklist"], "device": DEVICE}),
        ),
        ("a launch the backend ran unasked", _launch("notepad", unasked=True)),
        ("a launch whose record names no device", _span("device_launch_app", args_redacted={})),
    ],
)
def test_any_call_that_succeeded_there_silences_the_claim_whatever_it_ran_for(label, span):
    """(fix round 3, T3) "Ran for X, not Y" is gone. The record cannot equate
    an app's id, alias, URI or suffixed Start-menu name with the name she used,
    and a false correction is worse than a missed one: when a call of the
    tools that open an app SUCCEEDED on that device, the turn says nothing —
    and "No … call ran" would be false."""
    for claim in ("I opened Notepad on your DELL-XPS-8950.", T98ECFB11):
        assert check(claim, [span], devices=(DEVICE, MAC)) is None, label


@pytest.mark.parametrize("word", ["PC", "computer", "Mac", "MacBook", "laptop", "Windows PC"])
def test_a_word_for_a_machine_names_any_device(word):
    """(fix round 3, T3) "your PC", "your computer", "your Mac" name ANY of
    her devices — never by platform: a Linux household's "your PC" is its
    Linux box. So a launch on any device silences the claim, and with nothing
    run the sentence says her words, true of every device."""
    reply = f"Firefox is now open on your {word}."
    linux_only = {"box": "linux"}
    assert check(reply, [_launch("firefox", "box")], devices=linux_only) is None
    two = {DEVICE: "windows", "office-mac": "darwin"}
    assert check(reply, [_launch("firefox", "office-mac")], devices=two) is None
    assert check(reply, [_launch("firefox", DEVICE)], devices=two) is None
    claim = check(reply, [], devices=two)
    assert claim is not None
    assert claim.device == f"your {word}"
    assert claim.text == (
        f"(No device_launch_app or device_run call ran on your {word} this turn.)"
    )


def _read_as_production_reads(rows: dict) -> dict:
    """name -> machine, read from each agent's FACTS the way production reads
    the live rows (device_facts.machine): an agent inside WSL never yields a
    machine, so no test can hand it one (fix round 5, P3)."""
    from app import device_facts

    return {name: device_facts.machine(facts) for name, facts in rows.items()}


def _facts(uid: str, *, goos: str = "windows", wsl: bool = False) -> dict:
    return {
        "os": {"goos": "linux" if wsl else goos, "wsl": {"distro": "Ubuntu"} if wsl else None},
        "machine_uid": uid,
    }


# The Dell's rows as they are: its Windows agent, its WSL agent (whose machine
# id is WSL's own), and the Mac.
DELLS_ROWS = {
    DEVICE: _facts("d" * 64),
    f"{DEVICE} (WSL)": _facts("e" * 64, wsl=True),
    MAC: _facts("b" * 64, goos="darwin"),
}


def test_a_word_of_a_paired_name_takes_that_device():
    """ "your Dell" is DELL-XPS-8950 (or its WSL twin), not the MacBook — a
    machine of its own by what each agent reported (fix round 4, R5), read
    from production-shaped rows (fix round 5, P3)."""
    reply = "Notepad is now open on your Dell."
    assert check(reply, [_launch()], devices=tuple(DELLS_ROWS)) is None
    # The Dell and the Mac alone: each a machine of its own, readable, so a
    # launch on the Mac is not one on the Dell.
    rows = {DEVICE: DELLS_ROWS[DEVICE], MAC: DELLS_ROWS[MAC]}
    machines = _read_as_production_reads(rows)
    mac = _launch("notepad", MAC)
    found = guards.device_completion_check(reply, [mac], NAMES, tuple(rows), machines=machines)
    assert found is not None
    assert found.text == NONE_ON_DELL


def test_with_the_dells_real_rows_a_launch_on_the_mac_leaves_your_dell_silent():
    """(Fix round 5, P3) The missing test. With the Dell's real rows "your Dell"
    names both of the Dell's agents, and the WSL agent's machine cannot be read
    — its machine id is WSL's own — so whether the Mac's launch was on the
    machine she meant cannot be told from what the agents reported. R5: then
    the claim is silent."""
    machines = _read_as_production_reads(DELLS_ROWS)
    assert machines[f"{DEVICE} (WSL)"] is None  # never an id, whatever it reported
    found = guards.device_completion_check(
        "Notepad is now open on your Dell.",
        [_launch("notepad", MAC)],
        NAMES,
        tuple(DELLS_ROWS),
        machines=machines,
    )
    assert found is None


def test_a_failed_launch_is_the_claims_failure_with_its_reason():
    """(I1) a call of the family that FAILED this turn is what the turn says,
    never "nothing ran"."""
    failed = _launch(
        "notepad++",
        ok=False,
        error="Error: DELL-XPS-8950: no Start-menu app named 'notepad++' and no program by "
        "that name on PATH",
    )
    claim = check("I launched Notepad++ on your DELL-XPS-8950.", [failed])
    assert claim is not None
    assert claim.record == guards.DeviceRecord(
        "failed",
        tool="device_launch_app",
        # the device's own "DELL-XPS-8950: " prefix is dropped
        reason="no Start-menu app named 'notepad++' and no program by that name on PATH",
    )
    assert claim.text == (
        "(device_launch_app failed: no Start-menu app named 'notepad++' and no program by that "
        "name on PATH.)"
    )


def test_a_refusal_that_found_the_device_offline_is_a_failure_not_a_backing():
    offline = _launch(
        ok=False,
        facts=[{"device": DEVICE, "connected": False}],
        error="Error: device 'DELL-XPS-8950' is not connected — its tile is stale; check it is "
        "powered on and online",
    )
    claim = check(T98ECFB11, [offline])
    assert claim is not None and claim.record.case == "failed"
    assert "not connected" in claim.record.reason


def test_a_refused_markup_launch_is_neither_backing_nor_failure():
    refused = _launch(ok=False, refused_markup_as_text=True)
    claim = check(T98ECFB11, [refused])
    assert claim is not None and claim.record == guards.DeviceRecord()


def test_another_family_backs_nothing_when_a_device_is_named():
    """A web search ran; nothing ran on the Dell."""
    assert check(T98ECFB11, [_span("web_search")]) is not None


def test_a_first_person_claim_naming_no_device_may_be_about_another_tool():
    """ "I opened Wikipedia" after a fetch is her report of the fetch. With no
    device named the guard cannot tell a page from an app — but a device READ
    never backs it (C1)."""
    assert check("I opened Wikipedia and read the summary.", [_span("fetch_url")]) is None
    assert check("I opened Teams.", [_span("web_search")]) is None
    assert check("I opened Teams.", [_span("device_list_apps")]) is not None


def test_it_is_a_claim_only_when_a_launch_was_attempted():
    """(I3) "I launched it." names nothing on its own; after a launch that
    FAILED this turn it is the claim, and carries the failure."""
    assert check("I launched it.") is None
    failed = _launch(ok=False, error="Error: DELL-XPS-8950: no Start-menu app named 'x'")
    claim = check("I launched it.", [failed])
    assert claim is not None and claim.record.case == "failed"
    assert check("I launched it.", [_launch()]) is None


# Turn 212b9f8b (2026-09-28 15:52), verbatim: machine_status ran and relayed
# the agents' connectivity. A plain STATE, not a claim that anything was done
# (C1) — silent with the read and without it.
AGENTS_RELAYED = "Your agents are currently running on the **DELL-XPS-8950** machine, specifically:"


def test_a_plain_state_is_not_a_completion_claim():
    read = _span("machine_status", facts=[{"device": DEVICE, "connected": True}])
    assert check(AGENTS_RELAYED, [read]) is None
    assert check(AGENTS_RELAYED) is None
    assert check("Brave is running on your PC.") is None
    assert check("Done! Spotify is up and running on your laptop.") is None


def test_a_device_span_outside_the_advertised_subset_still_backs():
    """A call outside an agent's subset still RUNS (scope, not permission), so
    it is still a fact about the turn."""
    subset = [n for n in NAMES if n != "device_launch_app"]
    assert check(T98ECFB11, [_launch()], names=subset) is None


# -- never a claim ----------------------------------------------------------------


@pytest.mark.parametrize(
    "reply",
    [
        # negation
        "Notepad is not open on your DELL-XPS-8950.",
        "Notepad isn't running on your PC.",
        "I couldn't open Teams on your Dell.",
        "I did not open Teams on your DELL-XPS-8950.",
        "I haven't opened Teams yet.",
        "Nothing is open on your Dell.",
        "No file was saved on your DELL-XPS-8950.",
        "I launched nothing on your DELL-XPS-8950.",
        "Launched nothing on your DELL-XPS-8950.",
        "I opened no apps on your PC.",
        # questions
        "Is Notepad open on your DELL-XPS-8950?",
        "Did I open Teams on your Dell?",
        # relayed or quoted
        "You said Brave is now running on your PC.",
        "He mentioned that Notepad is now open on your Dell.",
        '"Notepad is now open on your DELL-XPS-8950" is what the tool returns.',
        "> Notepad is now open on your DELL-XPS-8950.",
        # second and third person
        "You can open Notepad on your DELL-XPS-8950.",
        "You opened Teams on your Dell.",
        "Once you've opened Teams on your PC, sign in.",
        "They have opened a ticket on your PC.",
        "He has saved the file to your Dell.",
        # hedges, conditionals and intent — in the claim's own segment
        "If Notepad is now open on your Dell, save your work first.",
        "Once Teams is now running on your PC, sign in.",
        "When the file is saved on your DELL-XPS-8950, I can read it.",
        "Since Brave is now running on your PC, it may be slow.",
        "Notepad should be open on your Dell now.",
        "Maybe Notepad is already open on your Dell.",
        "Let me check whether Notepad is now open on your DELL-XPS-8950.",
        "I'll verify that Teams is now running on your PC.",
        "Make sure Brave is now running on your PC.",
        # futures and offers
        "I'll open Notepad on your DELL-XPS-8950.",
        "Notepad will be open on your Dell in a moment.",
        "I can open Teams on your DELL-XPS-8950 if you like.",
        # a plain state (C1)
        "Windows 11 Pro is running with WSL2 enabled.",
        "Your DELL-XPS-8950 is running Windows 11.",
        "DELL-XPS-8950 is currently connected and reachable.",
        "Notepad was open on your DELL-XPS-8950 when I checked.",
        "Teams was already running on your DELL-XPS-8950 before you asked.",
        "Teams is installed on your DELL-XPS-8950.",
        # a device word that is not a device
        "The store is now open on your street.",
        "The PR is now open on GitHub.",
        # an object that is not an app, with no device named
        "I opened the page and read it.",
        "I started a timer for five minutes.",
        "I saved the notes.",
        # the device named belongs to another part of the sentence
        "The file is saved, and I'll send it to your Dell later.",
        "Notepad is open in the other window, which you can move to your laptop.",
        # a model serving on a machine is the stack guards' business
        "qwen3:8b is now running on your DELL-XPS-8950.",
        "Ollama is now running on your Dell.",
        "The model is now running on your DELL-XPS-8950.",
        # instructions, not claims
        "Open Brave → Click the profile icon → Ensure the Work profile is selected.",
        "Try these steps manually on your DELL-XPS-8950: press Win + R.",
        "You can open Notepad by pressing Win + R on your DELL-XPS-8950.",
        # explanation of a tool
        "device_launch_app: Launched apps open on your DELL-XPS-8950 through the Start menu.",
        "When called, device_launch_app reports that the app was launched on your DELL-XPS-8950.",
        "Apps started on your PC stay running after I disconnect.",
    ],
)
def test_never_a_claim(reply):
    assert check(reply) is None, reply


# The review's recaps, other actors, startup lists and relative clauses (C2, M1).
@pytest.mark.parametrize(
    "label,reply",
    [
        ("today", "Today I opened Notepad on your DELL-XPS-8950 and sent a notification."),
        ("this-morning", "This morning I opened Notepad on your DELL-XPS-8950."),
        ("at-time", "At 15:56 I opened Notepad on your DELL-XPS-8950."),
        ("at-time-after", "I opened Notepad on your DELL-XPS-8950 at 15:56."),
        ("in-last-chat", "In our last chat I opened Notepad on your DELL-XPS-8950."),
        ("on-monday", "On Monday I launched Teams on your DELL-XPS-8950."),
        ("at-your-request", "At your request on the 28th, I launched Teams on your DELL-XPS-8950."),
        ("yesterday", "I opened Teams on your DELL-XPS-8950 yesterday."),
        ("earlier", "Notepad was opened on your Dell earlier."),
        (
            "recap-list",
            "Here's what I did today:\n- I opened Notepad on your DELL-XPS-8950\n"
            "- I sent a notification to your DELL-XPS-8950",
        ),
        ("by-windows", "The file was saved on your DELL-XPS-8950 by Windows Backup."),
        ("by-timer", "A notification was sent to your DELL-XPS-8950 by the backup timer."),
        ("reboot", "Your DELL-XPS-8950 was rebooted by Windows Update last night."),
        ("headed-list", "- Launched on your DELL-XPS-8950 at login: OneDrive, Teams."),
        ("startup", "Teams was started on your DELL-XPS-8950 automatically."),
        ("relative", "The Brave that is running on your PC is version 1.70."),
        ("relative-past", "The Notepad that was opened on your DELL-XPS-8950 is still there."),
    ],
)
def test_recaps_other_actors_startup_and_relative_clauses_are_silent(label, reply):
    assert check(reply, devices=(DEVICE, MAC)) is None, label


def test_a_long_object_still_reaches_its_device():
    claim = check("I saved the weekly status report as report-final.txt to your DELL-XPS-8950.")
    assert claim is not None
    assert claim.phrase.endswith("to your DELL-XPS-8950")


# -- derived, never hardcoded ---------------------------------------------------


def test_no_device_tool_advertised_means_no_family_to_back_or_fail():
    """An agent given no device tools cannot have been expected to run one."""
    subset = [n for n in NAMES if not n.startswith("device_")]
    assert check(T98ECFB11, names=subset) is None


def test_a_device_named_by_its_paired_name_is_derived_from_the_registry():
    """ "your Dell" is a device BECAUSE a device named DELL-XPS-8950 is paired;
    with a different registry it is just a word, and the claim names no
    device of hers."""
    assert check("Notepad is now open on your Dell.", devices=("office-pc",)) is None
    assert check("Notepad is now open on your office-pc.", devices=("office-pc",)) is not None


def test_nothing_to_read_is_silent():
    assert check("") is None
    assert check("  \n") is None


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


# -- fix round 2 (C1), as fix round 3 (T3) reads it -----------------------------
#
# The second re-reviewer's backing probes (scratchpad rr2/probe_c1.py): claims
# that round 1's backing laundered — a different app sharing a word, a device
# word on "the wrong platform", a device_run READ. Round 2 corrected each with
# "ran for X, not Y". Round 3 (T3) rules that a correction is only what the
# record literally shows: a call of the claimed action's tools that SUCCEEDED
# on that device silences the claim whatever it ran for, and a machine word
# names any device. What is left is the claim with no such call there.

TWO = {DEVICE: "windows", MAC: "darwin"}


def _run(argv, device: str = DEVICE, **meta) -> SimpleNamespace:
    return _span("device_run", args_redacted={"argv": argv, "device": device}, **meta)


@pytest.mark.parametrize(
    "label,reply,span",
    [
        ("launch notepad++, claim Notepad", T98ECFB11, _launch("notepad++")),
        (
            "launch Microsoft Edge, claim Microsoft Teams",
            "Microsoft Teams is now open on your DELL-XPS-8950.",
            _launch("Microsoft Edge"),
        ),
        (
            "launch wordpad, claim Word",
            "Word is now open on your DELL-XPS-8950.",
            _launch("wordpad"),
        ),
        (
            "launch Visual Studio Code, claim Visual Studio",
            "Visual Studio is now open on your DELL-XPS-8950.",
            _launch("Visual Studio Code"),
        ),
        (
            "launch Microsoft Teams, claim Microsoft Word",
            "I opened Microsoft Word on your DELL-XPS-8950.",
            _launch("Microsoft Teams"),
        ),
        (
            "claim your Mac, launch on the Dell",
            "TextEdit is now open on your Mac.",
            _launch("textedit"),
        ),
        (
            "claim your MacBook, launch on the Dell",
            "Safari is now open on your MacBook.",
            _launch("safari"),
        ),
        (
            "claim your Windows PC, launch on the Mac",
            "Notepad is now open on your Windows PC.",
            _launch("notepad", MAC),
        ),
        (
            "a tasklist filter naming notepad",
            T98ECFB11,
            _run(["tasklist", "/fi", "imagename eq notepad.exe"]),
        ),
        ("taskkill naming notepad", T98ECFB11, _run(["taskkill", "/im", "notepad.exe"])),
        ("where notepad", T98ECFB11, _run(["where", "notepad"])),
        ("tasklist, claim closed", "I closed Notepad on your DELL-XPS-8950.", _run(["tasklist"])),
        ("tasklist, claim killed", "I killed Teams on your DELL-XPS-8950.", _run(["tasklist"])),
        (
            "dir, claim deleted",
            "I deleted the temp files on your DELL-XPS-8950.",
            _run(["cmd", "/c", "dir", "C:\\Temp"]),
        ),
        (
            "hostname, claim sent",
            "I sent a notification to your DELL-XPS-8950.",
            _run(["hostname"]),
        ),
        (
            "type, claim saved",
            "I saved notes.txt on your DELL-XPS-8950.",
            _run(["cmd", "/c", "type", "notes.txt"]),
        ),
        (
            "tasklist, claim restarted",
            "Teams has been restarted on your DELL-XPS-8950.",
            _run(["tasklist"]),
        ),
    ],
)
def test_the_second_reviews_backing_probes_are_silent_when_a_call_ran_there(label, reply, span):
    """(T3) A call of the claimed action's tools succeeded there — for another
    app, as a read, on "the wrong platform" — so the record cannot say none
    ran, and the guard does not guess that it ran for something else."""
    assert check(reply, [span], devices=TWO) is None, label


def test_a_notification_is_no_command():
    """(T3) Restarting a service is a command's work: a notification that ran
    is no call of those tools, so the record shows none ran on the Dell."""
    notified = _span("device_notify", args_redacted={"device": DEVICE, "message": "hi"})
    claim = check("I restarted the spooler service on your DELL-XPS-8950.", [notified], devices=TWO)
    assert claim is not None
    assert claim.text == "(No device_run call ran on DELL-XPS-8950 this turn.)"


# -- what the matcher still decides: WHICH failure is stated (C1, T3) ----------
#
# Round 2's whole-name and argv matching no longer backs anything: any call of
# the family that SUCCEEDED silences the claim. It survives for one job — when
# several calls FAILED, the sentence states the one that performed THIS action
# on THIS target (`guards._performs`), and it must say so consistently.


def _performs(span, action: str, target: str) -> bool:
    return guards._performs(span, action, target, {})


@pytest.mark.parametrize(
    "claimed,app",
    [
        ("Notepad", "notepad"),
        ("Notepad", "Notepad.exe"),
        ("Notepad++", "notepad++"),
        ("Notepad++", "C:\\Program Files\\Notepad++\\notepad++.exe"),
        ("Microsoft Teams", "Teams"),  # one vendor word in front
        ("Teams", "Microsoft Teams"),
        ("Google Chrome", "chrome"),
        ("Brave", "Brave Browser"),  # a trailing word that names no app
        ("Visual Studio Code", "visual studio code"),
        ("the Notepad app", "notepad"),
    ],
)
def test_a_launch_of_the_app_by_its_whole_name_performs_it(claimed, app):
    assert _performs(_launch(app), "launch", claimed), (claimed, app)
    # …and silence never depended on it
    assert check(f"{claimed} is now open on your DELL-XPS-8950.", [_launch(app)]) is None


@pytest.mark.parametrize(
    "argv,claimed",
    [
        (["notepad"], "Notepad"),
        (["notepad.exe"], "Notepad"),
        (["C:\\Program Files\\Notepad++\\notepad++.exe"], "Notepad++"),
        (["cmd", "/c", "start", "", "notepad"], "Notepad"),
        (["cmd", "/c", "start notepad"], "Notepad"),
        (["cmd /c start notepad"], "Notepad"),
        (["powershell", "-NoProfile", "-Command", "Start-Process notepad"], "Notepad"),
        (["pwsh", "-c", "Start-Process -FilePath 'notepad.exe'"], "Notepad"),
        (["open", "-a", "Safari"], "Safari"),
        (["gtk-launch", "gedit"], "gedit"),
        (["explorer.exe", "C:\\Users"], "File Explorer"),
        (["sudo", "gtk-launch", "gedit"], "gedit"),
    ],
)
def test_a_launch_shaped_command_performs_its_launch(argv, claimed):
    """(C1) device_run launched the app when its argv LAUNCHES it: the program
    itself, or the target of start, Start-Process, open -a, gtk-launch or
    explorer."""
    assert _performs(_run(argv), "launch", claimed), argv


@pytest.mark.parametrize(
    "argv",
    [
        ["tasklist"],
        ["cmd", "/c", "start", "", "teams"],
        ["open", "/Users/owner/notes.txt"],
        ["explorer.exe", "shell:AppsFolder\\MSTeams_8wekyb3d8bbwe!MSTeams"],
        ["notepad++"],
        ["powershell", "-c", "Get-Process notepad"],
    ],
)
def test_a_command_that_launched_something_else_did_not_launch_it_and_still_silences(argv):
    """(C1, T3) Not a launch of Notepad — but a device_run SUCCEEDED on the
    Dell, so "no call ran" would be false and "it ran for X" is a guess."""
    assert not _performs(_run(argv), "launch", "Notepad"), argv
    assert check(T98ECFB11, [_run(argv)]) is None, argv


@pytest.mark.parametrize(
    "reply,argv",
    [
        ("I closed Notepad on your DELL-XPS-8950.", ["taskkill", "/im", "notepad.exe"]),
        ("I closed Notepad on your DELL-XPS-8950.", ["taskkill", "/f", "/im", "Notepad.exe"]),
        (
            "I stopped Teams on your DELL-XPS-8950.",
            ["powershell", "-c", "Stop-Process -Name teams"],
        ),
        ("I killed gedit on your DELL-XPS-8950.", ["pkill", "gedit"]),
        (
            "I deleted the temp files on your DELL-XPS-8950.",
            ["cmd", "/c", "del", "/q", "C:\\Temp\\*"],
        ),
        ("I removed the old logs on your DELL-XPS-8950.", ["rm", "-rf", "/var/tmp/old/logs"]),
        (
            "I restarted the spooler service on your DELL-XPS-8950.",
            ["powershell", "-c", "Restart-Service spooler"],
        ),
        (
            "I restarted the nova-agent service on your DELL-XPS-8950.",
            ["systemctl", "restart", "nova-agent"],
        ),
        (
            "I stopped the nova-agent service on your DELL-XPS-8950.",
            ["sudo", "systemctl", "stop", "nova-agent"],
        ),
        ("I installed Git on your DELL-XPS-8950.", ["winget", "install", "Git.Git"]),
        ("I moved report.txt on your DELL-XPS-8950.", ["mv", "report.txt", "/tmp/"]),
        (
            "I just ran the cleanup script on your DELL-XPS-8950.",
            ["powershell", "-File", "C:\\s\\cleanup.ps1"],
        ),
        ("I ran tasklist on your DELL-XPS-8950.", ["tasklist"]),
        ("I restarted DELL-XPS-8950.", ["shutdown", "/r", "/t", "0"]),
    ],
)
def test_a_command_that_performs_the_action_on_its_target(reply, argv):
    """(C1) A program that performs it (taskkill, Stop-Process, del,
    Restart-Service, systemctl stop…) on the target the claim names."""
    claim = check(reply, [_run(argv, ok=False, error="Error: exit 1")])
    assert claim is not None, reply
    assert _performs(_run(argv), claim.action, claim.target), reply
    assert check(reply, [_run(argv)]) is None, reply


@pytest.mark.parametrize(
    "reply,argv",
    [
        ("I closed Notepad on your DELL-XPS-8950.", ["kill", "4120"]),  # a PID names nothing
        ("I closed Notepad on your DELL-XPS-8950.", ["taskkill", "/im", "teams.exe"]),
        (
            "I stopped the nova-agent service on your DELL-XPS-8950.",
            ["systemctl", "status", "nova-agent"],
        ),
        ("I installed Git on your DELL-XPS-8950.", ["winget", "list", "Git.Git"]),
        ("I restarted the spooler service on your DELL-XPS-8950.", ["shutdown", "/r"]),
        ("I deleted the temp files on your DELL-XPS-8950.", ["cmd", "/c", "dir", "C:\\Temp"]),
    ],
)
def test_a_command_that_does_not_perform_the_action_still_silences(reply, argv):
    """(T3) It did not do what she said — but a command SUCCEEDED on the Dell,
    and the record cannot say what that command did to the machine."""
    claim = check(reply, [_run(argv, ok=False, error="Error: exit 1")])
    assert claim is not None, reply
    assert not _performs(_run(argv), claim.action, claim.target), reply
    assert check(reply, [_run(argv)]) is None, reply


def test_a_write_of_another_file_still_silences():
    wrote = _span(
        "device_write_file", args_redacted={"device": DEVICE, "path": "C:\\Users\\owner\\notes.txt"}
    )
    assert check("I saved notes.txt to your DELL-XPS-8950.", [wrote]) is None
    assert check("I saved the notes to your DELL-XPS-8950.", [wrote]) is None
    # (T3) round 2 said "ran for C:\Users\j\notes.txt, not report.md" here
    assert check("I saved report.md to your DELL-XPS-8950.", [wrote]) is None


@pytest.mark.parametrize(
    "reply,program",
    [
        ("I ran the cleanup script on your DELL-XPS-8950.", ["bash", "/home/owner/cleanup.sh"]),
        ("I executed backup.ps1 on your DELL-XPS-8950.", ["powershell", "-File", "backup.ps1"]),
        ("I ran deploy.ps1 on your DELL-XPS-8950.", ["pwsh", "-c", "C:\\s\\deploy.ps1"]),
        ("I ran the backup on your DELL-XPS-8950.", ["python3", "backup.py"]),
        ("I ran Notepad on your DELL-XPS-8950.", ["notepad"]),
        ("I ran tasklist on your DELL-XPS-8950.", ["tasklist"]),
    ],
)
def test_ran_is_backed_by_the_program_that_ran_never_by_a_read_of_it(reply, program):
    """(fix round 3, C1) "I ran X" names the PROGRAM that ran — or the script
    an interpreter ran — never a read whose argument names it: `cat
    cleanup.sh` ran cat. Any device_run that succeeded on the device silences
    the claim anyway (T3), so this chooses only which failure is stated —
    consistently with the program rule."""
    read = {
        "I ran the cleanup script on your DELL-XPS-8950.": ["cat", "/home/owner/cleanup.sh"],
        "I executed backup.ps1 on your DELL-XPS-8950.": ["cmd", "/c", "type", "backup.ps1"],
        "I ran deploy.ps1 on your DELL-XPS-8950.": ["powershell", "-c", "Get-Content deploy.ps1"],
        "I ran the backup on your DELL-XPS-8950.": ["echo", "backup"],
        "I ran Notepad on your DELL-XPS-8950.": ["where", "notepad"],
        "I ran tasklist on your DELL-XPS-8950.": ["findstr", "tasklist", "log.txt"],
    }[reply]
    claim = check(reply, [_run(program, ok=False, error="Error: exit 1")])
    assert claim is not None and claim.action == "run", reply
    assert _performs(_run(program), "run", claim.target), reply
    assert not _performs(_run(read), "run", claim.target), reply
    # Both failed: the program's failure is the one stated, never the read's.
    both = [
        _run(read, ok=False, error=f"Error: {DEVICE}: the read failed"),
        _run(program, ok=False, error=f"Error: {DEVICE}: the program failed"),
    ]
    stated = check(reply, both)
    assert stated is not None and stated.text == "(device_run failed: the program failed.)"
    # And either one succeeding silences the claim (T3).
    assert check(reply, [_run(read)]) is None
    assert check(reply, [_run(program)]) is None


def test_i_ran_notepad_after_a_launch_is_silent():
    """(fix round 3, the re-review's probe_ran) "I ran Notepad" after a real
    device_launch_app: running an app is launching it, so a launch is a call
    of the family and the claim is silent — round 2 said "No device_run call
    ran … — Notepad was not run" beside the launch that ran it."""
    launched = _launch("notepad")
    for reply in (
        "I ran Notepad on your DELL-XPS-8950.",
        "I've started Notepad on your DELL-XPS-8950.",
        "Notepad is now running on your DELL-XPS-8950.",
    ):
        assert check(reply, [launched]) is None, reply
    claim = check("I ran Notepad on your DELL-XPS-8950.")
    assert claim is not None
    assert claim.text == NONE_ON_DELL


# -- the sentence is the record, and nothing more (R-A, T3) ---------------------


def test_a_launch_that_was_sent_and_never_answered_is_not_known_either_way():
    """(R-A, T3) A timeout or a dropped socket means the call was SENT and
    never answered: whether it worked is not known, and the sentence says only
    that — never "it did not open", and never what she named
    (guards._NO_ANSWER, pinned to app/devices_ws.py's own words in
    tests/test_devices_ws.py). The DEVICE's own "timed out" is an answer, and
    is stated as one (fix round 4, R3 — its tests are below)."""
    for reason in (
        f"Error: device '{DEVICE}' did not answer within 120s",
        "Error: the device disconnected before it answered",
        "Error: device connection closed: revoked",
    ):
        claim = check(T98ECFB11, [_launch("notepad", ok=False, error=reason)])
        assert claim is not None and claim.record.case == "no_answer", reason
        assert claim.text == (
            "(device_launch_app was sent but did not answer — whether it worked is not known.)"
        ), reason


def test_the_sentence_never_says_nothing_ran_when_something_did():
    """(I1, P4/P4b, T3) A call of the family that succeeded there silences the
    claim; one that failed is stated with its reason; "No … call ran" is said
    only when literally true — here, where the only launch ran on the Mac."""
    for span in (_run(["tasklist"]), _launch("teams")):
        assert check(T98ECFB11, [span]) is None
    failed = check(T98ECFB11, [_launch("notepad", ok=False, error="Error: x")])
    assert failed is not None and failed.text == "(device_launch_app failed: x.)"
    claim = guards.device_completion_check(
        T98ECFB11, [_launch("notepad", MAC)], NAMES, TWO, machines={DEVICE: "d" * 64, MAC: "b" * 64}
    )
    assert claim is not None and claim.text == NONE_ON_DELL


def test_a_failed_call_for_another_target_is_still_stated():
    """(T3) The failure sentence names no target, so it is true whichever app
    the failed call was for — never "ran for X", never "not opened"."""
    failed = _launch("Microsoft.WindowsNotepad_8wekyb3d8bbwe!App", ok=False, error="Error: nope")
    claim = check(T98ECFB11, [failed])
    assert claim is not None and claim.text == "(device_launch_app failed: nope.)"


def test_the_none_sentence_names_no_object():
    """(T3) The record shows her calls, not the machine: "the temp files were
    not deleted" is gone, and with it every garbled object ("Notepad will was
    not opened", "- Notepad was not opened")."""
    claim = check("I deleted the temp files on your DELL-XPS-8950.")
    assert claim is not None
    assert claim.text == "(No device_run call ran on DELL-XPS-8950 this turn.)"


# -- fix round 2 (C2): the second review's shapes, none a claim of hers now ----
#
# The re-reviewer's fresh shapes (scratchpad rr2/probe_c2_dc.py): how-it-works
# passives, conditions, other causes without "by", recaps without the markers
# round 1 knew, the owner's own action, a question, an aborted action, a plan.


@pytest.mark.parametrize(
    "reply",
    [
        "Notifications are sent to your DELL-XPS-8950 when a timer fires.",
        "Every time a timer fires, a notification is sent to your DELL-XPS-8950.",
        "Screenshots are saved to your PC's Pictures folder by default.",
        "Files you create are saved to your DELL-XPS-8950 in the Documents folder.",
        "Teams is launched from the Start menu on your PC.",
        "Normally, Notepad is opened on your DELL-XPS-8950 with Win + R.",
        "Typically the app is launched on your DELL-XPS-8950 through the Start menu.",
        "device_notify: a notification is sent to your DELL-XPS-8950 and shown in the corner.",
        "With device_write_file, the text is written to your DELL-XPS-8950 as a new file.",
        "As soon as Teams has launched on your PC, click Join.",
        "The moment Notepad has opened on your DELL-XPS-8950, paste the text.",
        "Once it's done, Teams has launched on your PC and you can join.",
        "OneDrive started on your DELL-XPS-8950 when you logged in.",
        "Teams was restarted on your DELL-XPS-8950 after the update.",
        "The file was saved to your DELL-XPS-8950 via OneDrive sync.",
        "Your backup script ran on your DELL-XPS-8950 overnight.",
        "Windows Update installed on your DELL-XPS-8950 overnight and restarted it.",
        "Notepad was closed on your DELL-XPS-8950 when you shut down.",
        "The last app I opened on your DELL-XPS-8950 was Notepad.",
        "Recap: I opened Notepad on your DELL-XPS-8950 and sent you a notification.",
        "To summarize our session, I opened Notepad on your DELL-XPS-8950.",
        "As I mentioned, I opened Notepad on your DELL-XPS-8950.",
        "Last night I restarted the print spooler on your DELL-XPS-8950.",
        "When you asked before, I launched Teams on your DELL-XPS-8950.",
        "Got it — you launched Teams on your DELL-XPS-8950 yourself.",
        "Thanks, so Teams was started on your DELL-XPS-8950 by hand.",
        "Notepad is now open on your DELL-XPS-8950 — can you see it?",
        "I almost opened Notepad on your DELL-XPS-8950, but stopped.",
        "I tried to open Notepad on your DELL-XPS-8950.",
        "Plan:\n1. Launch Teams on your DELL-XPS-8950\n2. Join the meeting",
        "Next steps:\n- Launched Teams on your DELL-XPS-8950? Then click Join.",
        # the same causes, one more of each
        "The file is saved on your DELL-XPS-8950.",
        "If you like, Notepad is opened on your DELL-XPS-8950 by double-clicking it.",
    ],
)
def test_the_second_reviews_shapes_are_never_claims(reply):
    assert check(reply, devices=TWO) is None, reply


@pytest.mark.parametrize(
    "reply,phrase",
    [
        (
            "Done! Here's what I did:\n- Launched Notepad on your DELL-XPS-8950\n- Sent you a note",
            "Launched Notepad on your DELL-XPS-8950",
        ),
        (
            "Here is what we did: I opened Notepad on your DELL-XPS-8950, then I sent a "
            "notification.",
            "I opened Notepad on your DELL-XPS-8950",
        ),
        (
            "Here's what I've done so far:\n- I opened Notepad on your DELL-XPS-8950",
            "I opened Notepad on your DELL-XPS-8950",
        ),
    ],
)
def test_a_bare_heres_what_i_did_is_the_claim_itself(reply, phrase):
    """(C2, narrowed) A recap needs a past marker — "today", "earlier", "at
    15:56", "as I mentioned", "recap" — in its own sentence or its list's
    intro. "Here's what I did:" alone, with nothing run, is the claim."""
    claim = check(reply)
    assert claim is not None, reply
    assert claim.phrase == phrase


@pytest.mark.parametrize(
    "reply",
    [
        "The file is now saved on your DELL-XPS-8950.",
        "Notepad is just opened on your DELL-XPS-8950.",
        "The notification is successfully sent to your DELL-XPS-8950.",
    ],
)
def test_a_present_passive_marked_as_the_change_is_a_claim(reply):
    assert check(reply) is not None, reply


# -- fix round 3: the third re-review's probes (scratchpad rr3/) ---------------
#
# Every probe that showed a WRONG sentence now asserts silence or the literal
# sentence (T3). probe_app/probe_dc: an honest report after a real call was
# "corrected" with "ran for X, not Y" — the same app by its apps.list id, its
# program name, a URI, a Start-menu name with a suffix, a pipeline, a PID. A
# Linux household's "your PC" got "No … call ran". probe_modal/probe_target:
# the object garbled into the sentence ("Notepad will was not opened").

WIN = {DEVICE: "windows"}


@pytest.mark.parametrize(
    "reply,span,devices",
    [
        # the same app, launched by the id apps.list prints
        ("I launched Teams on your DELL-XPS-8950.", _launch("MSTeams_8wekyb3d8bbwe!MSTeams"), WIN),
        (
            "I launched Notepad on your DELL-XPS-8950.",
            _launch("Microsoft.WindowsNotepad_8wekyb3d8bbwe!App"),
            WIN,
        ),
        (
            "I launched Calculator on your DELL-XPS-8950.",
            _launch("Microsoft.WindowsCalculator_8wekyb3d8bbwe!App"),
            WIN,
        ),
        (
            "I launched 1Password on your DELL-XPS-8950.",
            _launch("Agilebits.1Password_amwd9z03whsfe!Agilebits.OnePassword"),
            WIN,
        ),
        (
            "I launched Access on your DELL-XPS-8950.",
            _launch("Microsoft.Office.MSACCESS.EXE.15"),
            WIN,
        ),
        (
            "I launched Visual Studio Code on your DELL-XPS-8950.",
            _launch("Microsoft.VisualStudioCode"),
            WIN,
        ),
        ("I launched Microsoft Edge on your DELL-XPS-8950.", _launch("MSEdge"), WIN),
        (
            "I launched Teams on your DELL-XPS-8950.",
            _run(["explorer.exe", "shell:AppsFolder\\MSTeams_8wekyb3d8bbwe!MSTeams"]),
            WIN,
        ),
        (
            "I launched gedit on your Linux box.",
            _launch("org.gnome.gedit", "box"),
            {"box": "linux"},
        ),
        ("I launched Chrome on your Linux box.", _launch("google-chrome", "box"), {"box": "linux"}),
        # …by its program name on PATH
        ("I launched Microsoft Edge on your DELL-XPS-8950.", _launch("msedge"), WIN),
        ("I launched Calculator on your DELL-XPS-8950.", _launch("calc"), WIN),
        ("I launched Paint on your DELL-XPS-8950.", _launch("mspaint"), WIN),
        ("I launched Teams on your DELL-XPS-8950.", _launch("ms-teams"), WIN),
        ("I launched Word on your DELL-XPS-8950.", _launch("winword"), WIN),
        ("I launched Calculator on your DELL-XPS-8950.", _run(["calc"]), WIN),
        ("I launched Edge on your DELL-XPS-8950.", _run(["cmd", "/c", "start", "msedge"]), WIN),
        ("I launched Command Prompt on your DELL-XPS-8950.", _launch("cmd"), WIN),
        # …by a Start-menu name with a suffix, or a URI
        ("I launched Outlook on your DELL-XPS-8950.", _launch("Outlook (new)"), WIN),
        (
            "Teams is now open on your DELL-XPS-8950.",
            _launch("Microsoft Teams (work or school)"),
            WIN,
        ),
        ("I launched Teams on your DELL-XPS-8950.", _run(["cmd", "/c", "start", "ms-teams:"]), WIN),
        (
            "I launched VS Code on your Mac.",
            _run(["open", "-a", "Visual Studio Code"], "mac"),
            {"mac": "darwin"},
        ),
        # an action done by a pipeline, a PID, a redirect into a file
        (
            "I closed Notepad on your DELL-XPS-8950.",
            _run(["powershell", "-c", "Get-Process notepad | Stop-Process"]),
            WIN,
        ),
        ("I closed Notepad on your DELL-XPS-8950.", _run(["taskkill", "/pid", "4120"]), WIN),
        (
            "I closed Notepad on your DELL-XPS-8950.",
            _run(["powershell", "-c", "Stop-Process -Id 4120"]),
            WIN,
        ),
        (
            "I saved notes.txt to your DELL-XPS-8950.",
            _run(["cmd", "/c", "echo hi > C:\\notes.txt"]),
            WIN,
        ),
        (
            "I saved notes.txt to your DELL-XPS-8950.",
            _run(["bash", "-c", "echo hi > ~/notes.txt"]),
            WIN,
        ),
        # "your PC" is any device: the WSL twin, and a Linux-only household
        (
            "Notepad is now open on your PC.",
            _run(["notepad.exe"], f"{DEVICE} (WSL)"),
            {DEVICE: "windows", f"{DEVICE} (WSL)": "linux"},
        ),
        ("Firefox is now open on your PC.", _launch("firefox", "box"), {"box": "linux"}),
        # an observation beside the read that made it
        (
            "The KB5031354 update was installed on your DELL-XPS-8950.",
            _run(["powershell", "-c", "Get-HotFix"]),
            WIN,
        ),
        (
            "Notepad was closed on your DELL-XPS-8950 — tasklist shows no notepad.exe.",
            _run(["tasklist"]),
            WIN,
        ),
    ],
)
def test_the_third_reviews_honest_reports_are_silent(reply, span, devices):
    assert check(reply, [span], devices=devices) is None, reply


@pytest.mark.parametrize(
    "reply",
    [
        # a future, not a report (T3 probe_modal; round 2 said "Notepad will was
        # not opened")
        "Notepad will have opened on your DELL-XPS-8950.",
        "By the time you're back, Notepad will have opened on your DELL-XPS-8950.",
        "Notepad will have opened on your DELL-XPS-8950 by then.",
        # a hypothetical list (round 2 said "— - Notepad was not opened")
        "If it works:\n- Notepad is now open on your DELL-XPS-8950\n- You can type",
    ],
)
def test_the_third_reviews_futures_and_hypotheticals_are_silent(reply):
    assert check(reply, devices=WIN) is None, reply


@pytest.mark.parametrize(
    "reply,text",
    [
        # the objects round 2 garbled into its sentence: now there is none
        ("Done:\n- Notepad is now open on your DELL-XPS-8950", NONE_ON_DELL),
        ("1. Notepad is now open on your DELL-XPS-8950", NONE_ON_DELL),
        ("* Notepad is now open on your DELL-XPS-8950", NONE_ON_DELL),
        ("✅ Notepad is now open on your DELL-XPS-8950.", NONE_ON_DELL),
        ("Status: Notepad is now open on your DELL-XPS-8950.", NONE_ON_DELL),
        ("Great news: Notepad is now open on your DELL-XPS-8950.", NONE_ON_DELL),
        ("OK! Notepad is now open on your DELL-XPS-8950.", NONE_ON_DELL),
        ("Alright — Notepad is now open on your DELL-XPS-8950.", NONE_ON_DELL),
        ("Both Notepad and Teams are now open on your DELL-XPS-8950.", NONE_ON_DELL),
        ("Notepad and Teams are now open on your DELL-XPS-8950.", NONE_ON_DELL),
        ("The Notepad window is now open on your DELL-XPS-8950.", NONE_ON_DELL),
        ("A new Notepad window has been opened on your DELL-XPS-8950.", NONE_ON_DELL),
        (
            "Your notes have been saved to your DELL-XPS-8950.",
            "(No device_write_file or device_run call ran on DELL-XPS-8950 this turn.)",
        ),
        (
            "Everything has been deleted on your DELL-XPS-8950.",
            "(No device_run call ran on DELL-XPS-8950 this turn.)",
        ),
        ("All 3 apps have been launched on your DELL-XPS-8950.", NONE_ON_DELL),
        ("Teams must have launched on your DELL-XPS-8950 — the icon is in the tray.", NONE_ON_DELL),
        ("Notepad has definitely opened on your DELL-XPS-8950.", NONE_ON_DELL),
        ("Expected result:\n- Notepad is now open on your DELL-XPS-8950", NONE_ON_DELL),
    ],
)
def test_the_third_reviews_garbled_sentences_are_the_literal_one(reply, text):
    claim = check(reply, devices=WIN)
    assert claim is not None, reply
    assert claim.text == text, reply


def test_a_read_that_performs_no_action_is_stated_as_none_ran():
    """(probe_dc) Listing the files deletes nothing: device_list_files is no
    command, so the record shows no device_run on the Dell — and the sentence
    says only that, never "the old logs were not deleted"."""
    listed = _span("device_list_files", args_redacted={"device": DEVICE, "path": "C:\\logs"})
    claim = check("I deleted the old logs on your DELL-XPS-8950.", [listed], devices=WIN)
    assert claim is not None
    assert claim.text == "(No device_run call ran on DELL-XPS-8950 this turn.)"


# -- fix round 4 (2026-09-30, the controller's rulings R1-R5) --------------------

# R1 — a delegation ran an agent. The re-review's repro (scratchpad
# rr4/probe_deleg.py): Nova delegates to "ops", which holds device_launch_app;
# ops launches Notepad on the Dell in its OWN turn, and Nova's relay got "(No
# device_launch_app or device_run call ran on DELL-XPS-8950 this turn.)". The
# parent's record holds only the delegate_to_agent span, so it cannot say what
# was done: when a delegation RAN an agent this turn, the guard is silent for
# the turn. The child's spans are not read.
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
# Its child turn ran and then ended in an error: whatever it did before that is
# in the child's record, not this one, just the same.
DELEGATED_THEN_FAILED = _span(
    "delegate_to_agent",
    ok=False,
    args_redacted={"agent": "ops", "task": f"open notepad on {DEVICE}"},
    error="Error: ops did not finish — its run ended in an error",
    facts=[{"agent": "ops", "agent_turn_id": "t2", "status": "error"}],
)
RELAYED = [
    f"Notepad is now open on your {DEVICE}.",
    f"Done — ops opened Notepad on your {DEVICE}.",
    f"Your ops agent launched Notepad on your {DEVICE}.",
    f"The ops agent has launched Notepad on your {DEVICE}.",
    f"I had ops open Notepad on your {DEVICE}, and it's up now.",
    f"I asked ops to do it, and Notepad is now open on your {DEVICE}.",
    f"Notepad has been opened on your {DEVICE} by the ops agent.",
    f"Via the ops agent, Notepad is now open on your {DEVICE}.",
    "Notepad is now open on your PC.",
    "I launched Notepad.",
    f"Notepad is now open on your {DEVICE} (ops did it).",
]


@pytest.mark.parametrize("reply", RELAYED)
def test_R1_a_delegation_that_ran_an_agent_silences_the_turn(reply):
    assert check(reply, [DELEGATED]) is None, reply
    assert check(reply, [DELEGATED_THEN_FAILED]) is None, reply
    # …whatever else the turn holds beside it
    assert check(reply, [DELEGATED, _launch("notepad", ok=False, error="Error: x")]) is None


def test_R1_the_relays_the_delegation_silences_fire_without_it():
    """Not vacuous: without the delegation these are her claims with nothing
    run, and each gets its sentence."""
    fired = [reply for reply in RELAYED if check(reply) is not None]
    assert len(fired) >= 7, fired
    assert check(RELAYED[0]).text == NONE_ON_DELL


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
    """A delegation refused before any child turn ran reached no agent: the
    turn's record is the whole record, and its sentence is still true."""
    claim = check(T98ECFB11, [span])
    assert claim is not None, label
    assert claim.text == NONE_ON_DELL, label


# R2 — a failure reason is quoted as a fact, never as advice. The re-review
# (rr4/probe_reasons.py) found "… — remove the malformed character and try
# again." and four lines of partial output inside the sentence. The sentence
# quotes the reason's FIRST line, cut at its first " — " (what follows is advice
# to her), clipped to 120 characters, and never says again/retry/try/ask.

_REPO = Path(__file__).resolve().parents[3]
_INVITES = re.compile(
    r"\b(?:again|retry|retries|retrying|try|tries|trying|ask|asks|asking)\b", re.I
)
_SAMPLE = DEVICE


def _rendered(node: ast.expr) -> str | None:
    """A refusal's words as the source writes them: a literal, or an f-string
    with every placeholder filled by one sample value."""
    if isinstance(node, ast.Constant) and isinstance(node.value, str):
        return node.value
    if isinstance(node, ast.JoinedStr):
        out = []
        for part in node.values:
            if isinstance(part, ast.Constant):
                out.append(str(part.value))
            else:
                out.append(repr(_SAMPLE) if part.conversion == ord("r") else _SAMPLE)
        return "".join(out)
    return None


def _python_refusals(relative: str) -> list[str]:
    """Every ToolFailure / DeviceRefused a core module raises with words of
    its own, read from its source (never a copy kept here)."""
    tree = ast.parse((_REPO / relative).read_text())
    found = []
    for node in ast.walk(tree):
        if not isinstance(node, ast.Call) or not node.args:
            continue
        func = node.func
        name = func.attr if isinstance(func, ast.Attribute) else getattr(func, "id", None)
        if name in ("ToolFailure", "DeviceRefused"):
            text = _rendered(node.args[0])
            if text is not None:
                found.append(text)
    return found


_GO_FORMAT = re.compile(r'\b(?:fail|refuse)\(\s*"((?:[^"\\]|\\.)*)"')
_GO_VERB = re.compile(r"%[-+# 0]*\d*(?:\.\d+)?[vqsd%]")


def _go_refusals(pattern: str) -> list[str]:
    """Every fail(...) / refuse(...) the device agent answers with, read from
    its Go source: the format string with its verbs filled."""
    found = []
    for path in sorted(_REPO.glob(pattern)):
        if path.name.endswith("_test.go"):
            continue
        for m in _GO_FORMAT.finditer(path.read_text()):
            # Go's escapes (\n, \") decoded; its UTF-8 (an em dash) kept as is.
            text = m.group(1).encode("latin-1", "backslashreplace").decode("unicode_escape")
            text = _GO_VERB.sub(
                lambda v: {"%": "%", "q": '"notepad"', "d": "1"}.get(v.group(0)[-1], "exit 1"),
                text,
            )
            found.append(text)
    return found


def _known_refusals() -> list[tuple[str, str]]:
    """(where, the error as core records it) for every refusal a device call
    can come back with: core's own words ("Error: <reason>"), the hub's, and
    the agent's, which core prefixes with the device's name (`_require_ok`)."""
    core = [
        *_python_refusals("services/core/app/tools/devices.py"),
        *_python_refusals("services/core/app/devices_ws.py"),
        *_python_refusals("services/core/app/devices.py"),
    ]
    agent = [
        *_go_refusals("apps/novad/internal/caps/*.go"),
        *_go_refusals("apps/novad/internal/wire/envelope.go"),
    ]
    return [("core", f"Error: {text}") for text in core] + [
        ("agent", f"Error: {DEVICE}: {text}") for text in agent
    ]


def test_R2_the_known_refusals_are_read_from_their_sources():
    """The scan must find what it is about, or it proves nothing — and read
    each as it is written (the agent's em dash intact, not mangled bytes)."""
    known = [error for _, error in _known_refusals()]
    assert len(known) >= 40, len(known)
    assert f"Error: {DEVICE}: cancelled before it finished — novad stopped serving it" in "\n".join(
        known
    )
    for expected in (
        "an unpaired UTF-16 surrogate",
        "is not connected — its tile is stale",
        "did not answer within",
        "the device disconnected before it answered",
        "timed out; partial output:",
        "cancelled before it finished",
        "no Start-menu app named",
        "signature did not verify",
    ):
        assert any(expected in error for error in known), expected


@pytest.mark.parametrize("tool", ["device_launch_app", "device_run"])
def test_R2_no_known_refusal_is_quoted_as_advice(tool):
    """Every refusal a device call can come back with, as the sentence quotes
    it: one line, no " — " advice, at most 120 characters of reason, and none
    of again / retry / try / ask."""
    for where, error in _known_refusals():
        span = _span(
            tool,
            ok=False,
            error=error,
            args_redacted={"device": DEVICE, "app": "notepad", "argv": ["notepad"]},
        )
        claim = check(T98ECFB11, [span])
        assert claim is not None, error
        said = claim.text
        assert "\n" not in said, (where, said)
        assert _INVITES.search(said) is None, (where, said)
        if claim.record.case == "failed" and claim.record.reason is not None:
            assert " — " not in claim.record.reason, (where, said)
            assert len(claim.record.reason) <= 120, (where, said)


@pytest.mark.parametrize(
    "error,text",
    [
        (
            "Error: an argument contains an unpaired UTF-16 surrogate, which cannot be signed "
            "for the device — remove the malformed character and try again",
            "(device_launch_app failed: an argument contains an unpaired UTF-16 surrogate, "
            "which cannot be signed for the device.)",
        ),
        (
            f"Error: device '{DEVICE}' is not connected — its tile is stale; check it is powered "
            "on and online",
            f"(device_launch_app failed: device '{DEVICE}' is not connected.)",
        ),
        (
            f"Error: {DEVICE}: cancelled before it finished — novad stopped serving it (the "
            "connection to Nova dropped, or novad is stopping); partial output:\nC:\\> start "
            "notepad\nsome output line one\nline two",
            "(device_launch_app failed: cancelled before it finished.)",
        ),
        (
            f'Error: {DEVICE}: could not run "notepad": exec: not found\nline two\nline three',
            '(device_launch_app failed: could not run "notepad": exec: not found.)',
        ),
        # the backstop: an invitation the cuts above leave is cut with its clause
        (
            f"Error: {DEVICE}: the launcher is busy, please try again later",
            "(device_launch_app failed: the launcher is busy.)",
        ),
        (
            f"Error: {DEVICE}: the launcher is busy; retry in a minute",
            "(device_launch_app failed: the launcher is busy.)",
        ),
        (f"Error: {DEVICE}: try again later", "(device_launch_app failed.)"),
        (f"Error: {DEVICE}: Ask the owner to re-pair it", "(device_launch_app failed.)"),
        # a word that only contains one is no invitation
        (
            f"Error: {DEVICE}: the registry entry for the task is missing",
            "(device_launch_app failed: the registry entry for the task is missing.)",
        ),
    ],
)
def test_R2_the_reason_is_its_first_line_before_any_advice(error, text):
    claim = check(T98ECFB11, [_launch("notepad", ok=False, error=error)])
    assert claim is not None and claim.record.case == "failed", error
    assert claim.text == text


def test_R2_a_long_reason_is_clipped_to_120_characters_at_a_word():
    words = " ".join(f"word{i}" for i in range(80))
    claim = check(T98ECFB11, [_launch("notepad", ok=False, error=f"Error: {DEVICE}: {words}")])
    assert claim is not None
    reason = claim.record.reason
    assert len(reason) <= 120 and reason.endswith("…"), reason
    assert words.startswith(reason[:-1].rstrip()), reason
    assert claim.text == f"(device_launch_app failed: {reason})"


# R3 — the device ANSWERED that the command timed out (novad's shell.go:
# "timed out; partial output:"). Round 3 read every "timed out" as the hub's
# no-answer, and said "was sent but did not answer". Now: the device's own
# answer that it timed out is stated as that; a call that got no answer at all
# keeps "whether it worked is not known". Both are read off the words the hub
# and the agent really use — pinned against the running code in
# tests/test_devices_ws.py.


def test_R3_a_command_the_device_answered_had_timed_out_is_stated_as_that():
    error = f"Error: {DEVICE}: timed out; partial output:\nC:\\> start notepad"
    for tool in ("device_run", "device_launch_app"):
        span = _span(
            tool,
            ok=False,
            error=error,
            args_redacted={"device": DEVICE, "argv": ["cmd", "/c", "start", "notepad"]},
        )
        claim = check(T98ECFB11, [span])
        assert claim is not None, tool
        assert claim.record.case == "timed_out", tool
        assert claim.text == f"({tool} timed out on {DEVICE}.)", tool


@pytest.mark.parametrize(
    "error",
    [
        f"Error: device '{DEVICE}' did not answer within 120s",
        "Error: the device disconnected before it answered",
        "Error: device connection closed: revoked",
    ],
)
def test_R3_a_call_that_got_no_answer_at_all_is_not_known_either_way(error):
    claim = check(T98ECFB11, [_launch("notepad", ok=False, error=error)])
    assert claim is not None and claim.record.case == "no_answer", error
    assert claim.text == (
        "(device_launch_app was sent but did not answer — whether it worked is not known.)"
    )


def test_R3_the_hubs_words_inside_the_devices_own_answer_are_its_answer():
    """The device answered: whatever words its answer holds, it is a failure
    it stated — never read as a call that got no answer."""
    error = f'Error: {DEVICE}: could not run "curl": connection closed by peer'
    claim = check(T98ECFB11, [_launch("notepad", ok=False, error=error)])
    assert claim is not None and claim.record.case == "failed"
    assert claim.text == (
        '(device_launch_app failed: could not run "curl": connection closed by peer.)'
    )


def test_R3_an_unknown_outcome_is_stated_before_a_failure():
    """Two calls: one failed, one the device answered had timed out. Whether
    the claim is true is not known, so the timeout is what the turn says."""
    failed = _launch("notepad", ok=False, error=f"Error: {DEVICE}: no Start-menu app named x")
    timed = _run(
        ["cmd", "/c", "start", "notepad"],
        ok=False,
        error=f"Error: {DEVICE}: timed out; partial output:\n",
    )
    claim = check(T98ECFB11, [failed, timed])
    assert claim is not None and claim.text == f"(device_run timed out on {DEVICE}.)"


# R5 — the WSL twin. "Notepad is now open on your DELL-XPS-8950" after a
# device_run of notepad.exe on "DELL-XPS-8950 (WSL)" got "No … call ran on
# DELL-XPS-8950": true of the row, misleading about the machine. A claim is
# backed by a call of its family on that device OR on any agent of the SAME
# machine — grouped by what each agent reported (facts.machine_uid, as
# machine_status groups them), passed as `machines` and derived from the live
# rows by the caller. An agent inside WSL reports WSL's own machine id (app/
# checks/devices.py), so the Windows machine it runs on cannot be read from its
# facts; neither can an agent that reported none. Where the grouping cannot be
# read and a call ran on another device, the guard is silent for that claim.

WSL = f"{DEVICE} (WSL)"
UID_DELL = "d" * 64
UID_BOX = "b" * 64


def _twins(**extra) -> dict:
    return {DEVICE: UID_DELL, **extra}


def test_R5_a_call_on_an_agent_of_the_same_machine_backs_the_claim():
    machines = _twins(**{"dell-second-agent": UID_DELL})
    names = tuple(machines)
    for span in (
        _launch("notepad", "dell-second-agent"),
        _run(["notepad.exe"], "dell-second-agent"),
    ):
        assert (
            guards.device_completion_check(T98ECFB11, [span], NAMES, names, machines=machines)
            is None
        )


def test_R5_the_wsl_twins_call_is_on_a_machine_that_cannot_be_read_so_the_claim_is_silent():
    """The re-review's repro, as the Dell's rows are: the WSL agent reports no
    machine the Windows one shares — pre-S42a it sends no facts, and since
    S42a its machine id is WSL's own — so it is read as None."""
    machines = _twins(**{WSL: None})
    names = tuple(machines)
    for span in (
        _run(["notepad.exe"], WSL),
        _run(["notepad.exe"], WSL, ok=False, error=f"Error: {WSL}: exit 1"),
        _launch("notepad", WSL),
    ):
        for reply in (T98ECFB11, f"I opened Notepad on your {DEVICE}."):
            found = guards.device_completion_check(reply, [span], NAMES, names, machines=machines)
            assert found is None, (reply, span.meta)


def test_R5_a_claim_about_the_wsl_twin_after_a_call_on_windows_is_silent_too():
    machines = _twins(**{WSL: None})
    reply = f"Notepad is now open on your {WSL}."
    found = guards.device_completion_check(
        reply, [_launch("notepad")], NAMES, tuple(machines), machines=machines
    )
    assert found is None


def test_R5_a_call_on_another_machine_leaves_the_claim():
    machines = _twins(box=UID_BOX)
    for span in (_launch("notepad", "box"), _run(["notepad.exe"], "box")):
        claim = guards.device_completion_check(
            T98ECFB11, [span], NAMES, tuple(machines), machines=machines
        )
        assert claim is not None and claim.text == NONE_ON_DELL


def test_R5_without_the_grouping_a_call_elsewhere_silences_the_claim():
    """No `machines` (a caller that read none, or a registry read that failed):
    no grouping can be read, so a call on any other device may be on the same
    machine."""
    for span in (_launch("notepad", "office-mac"), _run(["notepad.exe"], WSL)):
        assert check(T98ECFB11, [span], devices=(DEVICE, "office-mac", WSL)) is None


@pytest.mark.parametrize("machines", [None, {}, {DEVICE: UID_DELL}, {DEVICE: None, WSL: None}])
def test_R5_nothing_run_anywhere_is_stated_whatever_the_grouping(machines):
    names = (DEVICE, WSL)
    for spans in ([], [_span("device_info", args_redacted={"device": WSL})]):
        claim = guards.device_completion_check(T98ECFB11, spans, NAMES, names, machines=machines)
        assert claim is not None and claim.text == NONE_ON_DELL, machines


def test_R5_a_failure_on_an_agent_of_the_same_machine_is_stated():
    machines = _twins(**{"dell-second-agent": UID_DELL})
    failed = _launch(
        "notepad", "dell-second-agent", ok=False, error="Error: dell-second-agent: nope"
    )
    claim = guards.device_completion_check(
        T98ECFB11, [failed], NAMES, tuple(machines), machines=machines
    )
    assert claim is not None and claim.text == "(device_launch_app failed: nope.)"


def test_R5_the_machine_an_agent_runs_on_is_read_from_its_own_facts():
    """device_facts.machine: the agent's machine_uid — never inside WSL, whose
    machine id is WSL's own, and never when it reported none."""
    from app import device_facts

    native = {"os": {"goos": "windows", "wsl": None}, "machine_uid": UID_DELL}
    inside = {"os": {"goos": "linux", "wsl": {"distro": "Ubuntu"}}, "machine_uid": UID_BOX}
    assert device_facts.machine(native) == UID_DELL
    assert device_facts.machine(inside) is None
    assert device_facts.machine({"os": {"goos": "linux", "wsl": None}}) is None
    assert device_facts.machine({"machine_uid": ""}) is None
    assert device_facts.machine(None) is None


# -- fix round 5 (2026-09-30, the controller's rulings P1-P4) ---------------------

# P1 — a delegation that MAY have run. The child-turn marker is filed only after
# the executor reads the child's turn back (agents.delegate), so a delegation
# that raised after its child ran carries none, and a scripted delegate step
# (chat._run_script_step) copies no facts at all. Only a call refused before
# any run is known to have run nothing: a `refused_*` span, or one whose facts
# carry status "refused". The re-review's shapes (scratchpad rr5/probe_fresh.py,
# R1a and R1b):
RAISED_AFTER_ITS_CHILD_RAN = _span(
    "delegate_to_agent",
    ok=False,
    args_redacted={"agent": "ops", "task": "open notepad"},
    error="Error: delegate_to_agent failed unexpectedly — ConnectionDoesNotExistError: "
    "connection was closed in the middle of operation",
)
A_SCRIPTED_DELEGATE_STEP = _span(
    "delegate_to_agent",
    ok=False,
    via_skill=True,
    step=0,
    args_redacted={"agent": "ops", "task": "open notepad"},
    error="Error: agent ops did not finish — its turn closed with status error · ops: 2 rounds",
)


@pytest.mark.parametrize(
    "label,span",
    [
        ("raised after its child ran", RAISED_AFTER_ITS_CHILD_RAN),
        ("a scripted delegate step", A_SCRIPTED_DELEGATE_STEP),
    ],
)
def test_P1_a_delegation_that_may_have_run_silences_the_turn(label, span):
    rows = {DEVICE: "d" * 64, f"{DEVICE} (WSL)": None, MAC: "b" * 64}
    for reply in RELAYED:
        found = guards.device_completion_check(reply, [span], NAMES, tuple(rows), machines=rows)
        assert found is None, (label, reply)


def test_P1_only_a_delegation_refused_before_any_run_leaves_the_sentence():
    refused = _span(
        "delegate_to_agent",
        ok=False,
        args_redacted={"agent": "opz", "task": "open notepad"},
        error="Error: no agent named 'opz'",
        facts=[{"agent": "opz", "status": "refused", "reason": "no agent named 'opz'"}],
    )
    claim = check(T98ECFB11, [refused])
    assert claim is not None and claim.text == NONE_ON_DELL
