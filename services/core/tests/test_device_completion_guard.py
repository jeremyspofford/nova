"""The device-action completion guard: she says an action happened on a device.

The owner's test, 2026-09-28 (tests/said_not_done_walk.py). Asked to open
Notepad on his Dell she made ZERO tool calls and replied "Notepad is now open
on your DELL-XPS-8950." Nothing ran. The timer completion shape
(guards._TIMER_COMPLETION) is the model: a present- or past-tense claim that
the thing is done, with no span this turn of the tools that would do it.

The rule (guards.device_completion_check):

  * the FAMILY is every device tool the turn advertised, derived from the
    registry's naming (device_*), never a list kept here; with none
    advertised the guard is silent;
  * a claim that NAMES a device ("…on your DELL-XPS-8950", "…on your PC"), within
    a few words and no clause break of the claim, is backed only by a
    successful span of that family this turn — or by an OK span that read the
    device ({device, connected}, as the state guard counts machine_status);
  * a first-person claim that names no device ("I opened Teams", "I've
    stopped the service") cannot say which family it needed, so ANY
    successful span this turn backs it (bare_intent's rule) — "I opened
    Wikipedia" after a fetch is a report, not this lie;
  * negations (before the claim or inside it), questions, relayed or quoted
    text, second and third person, hedges and conditionals, intent ("let me
    check whether…"), futures, a prior-time marker and a model serving on a
    machine are never claims.
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


def test_the_teams_turn_fires_on_its_completion_line():
    claim = check(T890B1C63)
    assert claim is not None
    assert claim.phrase == "Teams is now opening on your DELL-XPS-8950"


def test_the_brave_turn_is_backed_by_its_real_launch_span():
    """device_launch_app really ran and came back ok: the claim is backed. The
    lie on that turn was in the TOOL's text ("Launched brave…"), and the fix is
    there (app/tools/devices.py)."""
    launched = _span(
        "device_launch_app",
        facts=[{"device": DEVICE, "connected": True}],
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
    assert check(A2026704, [_span("device_notify")]) is None
    claim = check(A2026704)
    assert claim is not None
    assert claim.phrase == "I've sent a desktop notification to your DELL-XPS-8950"


# -- the shapes -----------------------------------------------------------------


@pytest.mark.parametrize(
    "reply,phrase",
    [
        ("Brave is running on your PC.", "Brave is running on your PC"),
        ("The file is saved on your DELL-XPS-8950.", "The file is saved on your DELL-XPS-8950"),
        (
            "Notepad is now open on your **DELL-XPS-8950**.",
            "Notepad is now open on your DELL-XPS-8950",
        ),
        ("Notepad is now open on your Dell.", "Notepad is now open on your Dell"),
        (
            "Done! Spotify is up and running on your laptop.",
            "Spotify is up and running on your laptop",
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
    ],
)
def test_a_claim_naming_a_device_fires_with_nothing_run(reply, phrase):
    claim = check(reply)
    assert claim is not None, reply
    assert claim.phrase == phrase


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


# -- backing ------------------------------------------------------------------


@pytest.mark.parametrize(
    "tool", ["device_launch_app", "device_run", "device_list_apps", "device_info"]
)
def test_any_successful_device_span_backs_a_device_claim(tool):
    """Any successful span of the family: a launch did it, a run did it or read
    it, a read may have seen it — precision-first, like list_timers backing
    "your reminder is running"."""
    assert check(T98ECFB11, [_span(tool)]) is None


def test_a_failed_device_span_backs_nothing():
    """The family's SUCCESSFUL span: a launch that came back with an error did
    not open anything."""
    claim = check(T98ECFB11, [_span("device_launch_app", ok=False)])
    assert claim is not None


def test_another_family_backs_nothing_when_a_device_is_named():
    """A web search ran; nothing ran on the Dell."""
    assert check(T98ECFB11, [_span("web_search")]) is not None


def test_any_span_backs_a_first_person_claim_that_names_no_device():
    """ "I opened Wikipedia" after a fetch is her report of the fetch. With no
    device named the guard cannot say which family it needed."""
    assert check("I opened Wikipedia and read the summary.", [_span("fetch_url")]) is None
    assert check("I opened Teams.", [_span("web_search")]) is None


# Turn 212b9f8b (2026-09-28 15:52), verbatim: machine_status ran and its agent
# listing recorded each agent's connectivity. The corpus scan's one false fire
# before this backing existed.
AGENTS_RELAYED = "Your agents are currently running on the **DELL-XPS-8950** machine, specifically:"


def test_an_ok_span_that_read_the_device_backs_it_like_the_state_guard():
    """machine_status is not a device_* tool, but its agent listing READ each
    agent and recorded {"device", "connected"} — the same fact
    _checked_a_device counts (S42a). Only an OK span: a failed read read
    nothing."""
    read = _span(
        "machine_status",
        facts=[
            {"device": DEVICE, "connected": True},
            {"device": f"{DEVICE} (WSL)", "connected": True},
        ],
    )
    assert check(AGENTS_RELAYED, [read]) is None
    assert check(AGENTS_RELAYED) is not None
    failed = _span("machine_status", ok=False, facts=[{"device": DEVICE, "connected": True}])
    assert check(AGENTS_RELAYED, [failed]) is not None


def test_a_refusal_that_found_the_device_offline_backs_no_action():
    """The state guard counts an offline refusal as a check of CONNECTIVITY;
    it launched nothing, so it backs no claim that something was launched."""
    offline = _span("device_launch_app", ok=False, facts=[{"device": DEVICE, "connected": False}])
    assert check(T98ECFB11, [offline]) is not None


def test_a_device_span_outside_the_advertised_subset_still_backs():
    """A call outside an agent's subset still RUNS (scope, not permission), so
    it is still a fact about the turn."""
    subset = [n for n in NAMES if n != "device_launch_app"]
    assert check(T98ECFB11, [_span("device_launch_app")], names=subset) is None


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
        # questions
        "Is Notepad open on your DELL-XPS-8950?",
        "Did I open Teams on your Dell?",
        # relayed or quoted
        "You said Brave is running on your PC.",
        "He mentioned that Notepad is open on your Dell.",
        '"Notepad is now open on your DELL-XPS-8950" is what the tool returns.',
        "> Notepad is now open on your DELL-XPS-8950.",
        # second person
        "You can open Notepad on your DELL-XPS-8950.",
        "You opened Teams on your Dell.",
        "Once you've opened Teams on your PC, sign in.",
        # hedges and conditionals
        "If Notepad is open on your Dell, save your work first.",
        "Once Teams is running on your PC, sign in.",
        "When the file is saved on your DELL-XPS-8950, I can read it.",
        "Since Brave is running on your PC, it may be slow.",
        "Notepad should be open on your Dell now.",
        "Maybe Notepad is already open on your Dell.",
        # intent
        "Let me check whether Notepad is open on your DELL-XPS-8950.",
        "I'll verify that Teams is running on your PC.",
        "Make sure Brave is running on your PC.",
        # futures and offers
        "I'll open Notepad on your DELL-XPS-8950.",
        "Notepad will be open on your Dell in a moment.",
        "I can open Teams on your DELL-XPS-8950 if you like.",
        # prior time
        "Notepad was open on your Dell earlier.",
        "I opened Teams on your DELL-XPS-8950 yesterday.",
        # instructions, not claims
        "Open Brave → Click the profile icon → Ensure the Work profile is selected.",
        "Try these steps manually on your DELL-XPS-8950: press Win + R.",
        # a state that is not an action on a device
        "Windows 11 Pro is running with WSL2 enabled.",
        "Your DELL-XPS-8950 is running Windows 11.",
        "DELL-XPS-8950 is currently connected and reachable.",
        # a device word that is not a device
        "The store is now open on your street.",
        "The PR is now open on GitHub.",
        # an object that is not an app, with no device named
        "I opened the page and read it.",
        "I started a timer for five minutes.",
        "I saved the notes.",
        # a negation after the verb
        "I launched nothing on your DELL-XPS-8950.",
        "Launched nothing on your DELL-XPS-8950.",
        "I opened no apps on your PC.",
        # someone else did it
        "They have opened a ticket on your PC.",
        "He has saved the file to your Dell.",
        # the device named belongs to another part of the sentence
        "The file is saved, and I'll send it to your Dell later.",
        "Notepad is open in the other window, which you can move to your laptop.",
        # a model serving on a machine is the stack guards' business, and can
        # be true with no device tool: the Dell serves models here
        "qwen3:8b is running on your DELL-XPS-8950.",
        "Ollama is running on your Dell.",
        "The model is now running on your DELL-XPS-8950.",
    ],
)
def test_never_a_claim(reply):
    assert check(reply) is None, reply


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
