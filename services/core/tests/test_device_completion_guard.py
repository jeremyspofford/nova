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
"""

from __future__ import annotations

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
    assert claim.failed is None


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
        ("The file is saved on your DELL-XPS-8950.", "The file is saved on your DELL-XPS-8950"),
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
            "Notepad is open on your TRAVEL-MACBOOK, and Teams is now open on your DELL-XPS-8950.",
            "Teams is now open on your DELL-XPS-8950",
        ),
    ],
)
def test_the_reviews_missed_shapes_are_claims(label, reply, phrase):
    claim = check(reply, devices=(DEVICE, "TRAVEL-MACBOOK"))
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
    assert set(guards.DEVICE_ACTION_TOOLS) == set(guards.ACTION_NOT_DONE)
    assert set(guards.DEVICE_ACTION_TOOLS) == set(guards.ACTION_DONE_WORD)
    # device_run performs every kind: a shell command can do any of them.
    assert all("device_run" in tools_ for tools_ in guards.DEVICE_ACTION_TOOLS.values())


def _launch(app: str = "notepad", device: str = DEVICE, **meta) -> SimpleNamespace:
    return _span("device_launch_app", args_redacted={"app": app, "device": device}, **meta)


def test_a_launch_of_the_named_app_on_the_named_device_backs_it():
    assert check(T98ECFB11, [_launch("notepad")]) is None
    ran = _span(
        "device_run", args_redacted={"argv": ["cmd", "/c", "start", "notepad"], "device": DEVICE}
    )
    assert check(T98ECFB11, [ran]) is None


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
            _span("device_info", args_redacted={"device": "TRAVEL-MACBOOK"}),
        ),
        ("a launch on another device", _launch("notepad", "TRAVEL-MACBOOK")),
        ("a launch of another app", _launch("teams")),
        (
            "a shell read (review B2)",
            _span("device_run", args_redacted={"argv": ["tasklist"], "device": DEVICE}),
        ),
        ("an unasked launch", _launch("notepad", unasked=True)),
    ],
)
def test_nothing_but_the_action_itself_backs_an_action_claim(label, span):
    """The review's C1: every one of these backed "I opened Notepad on your
    DELL…" before. None performed that action, on that device, at her call."""
    for claim in ("I opened Notepad on your DELL-XPS-8950.", T98ECFB11):
        assert check(claim, [span], devices=(DEVICE, "TRAVEL-MACBOOK")) is not None, label


def test_a_device_word_that_names_none_in_particular_takes_any_device():
    """ "your PC" names no device, so a launch on any of hers backs it."""
    assert check("Notepad is now open on your PC.", [_launch("notepad", "office-pc")]) is None


def test_a_word_of_a_paired_name_takes_that_device():
    """ "your Dell" is DELL-XPS-8950 (or its WSL twin), not the MacBook."""
    devices = (DEVICE, f"{DEVICE} (WSL)", "TRAVEL-MACBOOK")
    assert check("Notepad is now open on your Dell.", [_launch()], devices=devices) is None
    mac = _launch("notepad", "TRAVEL-MACBOOK")
    assert check("Notepad is now open on your Dell.", [mac], devices=devices) is not None


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
    assert claim.failed == guards.DeviceFailure(
        tool="device_launch_app",
        device=DEVICE,
        # the device's own "DELL-XPS-8950: " prefix is dropped: the failure names it
        reason="no Start-menu app named 'notepad++' and no program by that name on PATH",
    )


def test_a_refusal_that_found_the_device_offline_is_a_failure_not_a_backing():
    offline = _launch(
        ok=False,
        facts=[{"device": DEVICE, "connected": False}],
        error="Error: device 'DELL-XPS-8950' is not connected — its tile is stale; check it is "
        "powered on and online",
    )
    claim = check(T98ECFB11, [offline])
    assert claim is not None and claim.failed is not None
    assert "not connected" in claim.failed.reason


def test_a_refused_markup_launch_is_neither_backing_nor_failure():
    refused = _launch(ok=False, refused_markup_as_text=True)
    claim = check(T98ECFB11, [refused])
    assert claim is not None and claim.failed is None


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
    assert claim is not None and claim.failed is not None
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
        (
            "recap",
            "Here is what we did: I opened Notepad on your DELL-XPS-8950, then I sent a "
            "notification.",
        ),
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
    assert check(reply, devices=(DEVICE, "TRAVEL-MACBOOK")) is None, label


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
