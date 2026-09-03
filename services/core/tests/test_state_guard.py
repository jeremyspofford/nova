"""The live-state guard, tested in isolation: pure (text, spans, names) -> verdict.

state_claim_check is a pure function — no database, no gateway — so this is the
fast corpus that pins its precision. The expensive failure is a wrongly-
corrected HONEST reply (a false positive makes the guard itself the liar), so
the must-NOT-fire cases below are as load-bearing as the fabrications.

The owner's captured case is first: 2026-09-02 23:51, "try again" produced ZERO
tool calls and a reply asserting the paired machine was "still offline" —
parroted out of an earlier (then-true) reply while the device was online. Every
toggle the guard derives from is proven here too: the SAME sentence flips
verdict on a successful device span, and on whether anything is paired at all.
"""
from __future__ import annotations

import pytest

from app import chat, guards

# The owner's paired machine, and his EXACT captured reply.
DEVICE = "DELL-XPS-8950"
NAMES = [DEVICE]
OWNER_CASE = (
    "Looks like the device is still offline. Could you confirm it's on and "
    "connected so I can try again?"
)


class Span:
    """The minimal span shape every guard reads: kind, name, meta.ok."""

    def __init__(self, name: str, *, kind: str = "tool", ok: bool = True) -> None:
        self.kind = kind
        self.name = name
        self.meta = {"ok": ok}


# -- MUST FIRE (no device span this turn) ----------------------------------

MUST_FIRE = [
    ("owner_exact_case", OWNER_CASE),
    ("bare_offline", "The device is offline."),
    ("named_device_offline", f"{DEVICE} is offline."),
    ("named_with_determiner", f"The {DEVICE} is not responding."),
    ("your_machine_unreachable", "Your machine is currently unreachable."),
    ("contraction_copula", "The device's offline right now."),
    ("present_perfect", "The device has gone offline."),
    ("still_disconnected", "That computer is still disconnected."),
    ("last_seen_as_current", "The device was last seen three hours ago."),
    # A POSITIVE state is just as unchecked as a negative one.
    ("claims_it_is_online", "The device is online and connected."),
    ("seems_to_be_down", "Your laptop seems to be down."),
]


@pytest.mark.parametrize("label,reply", MUST_FIRE, ids=[c[0] for c in MUST_FIRE])
def test_must_fire_when_no_device_was_checked(label, reply):
    claim = guards.state_claim_check(reply, [], NAMES)
    assert claim is not None, f"{label!r} should have fired but did not"
    assert claim.text == guards.STATE_CLAIM_CORRECTION
    assert claim.device and claim.phrase


@pytest.mark.parametrize("label,reply", MUST_FIRE, ids=[c[0] for c in MUST_FIRE])
def test_the_same_sentence_is_clean_when_a_device_tool_actually_ran(label, reply):
    """The toggle: a successful device_* span this turn BACKS whatever the reply
    says about the device, so the guard must stay silent on the identical text."""
    assert guards.state_claim_check(reply, [Span("device_list")], NAMES) is None


@pytest.mark.parametrize("label,reply", MUST_FIRE, ids=[c[0] for c in MUST_FIRE])
def test_the_same_sentence_is_clean_when_nothing_is_paired(label, reply):
    """The other toggle, DERIVED not hardcoded: with no paired devices there is
    no machine to be wrong about, so the guard never fires."""
    assert guards.state_claim_check(reply, [], []) is None


# -- MUST NOT FIRE (no device span this turn) ------------------------------
#
# Past reports, conditionals, intent-to-check, questions and reported speech
# assert nothing about the device's state RIGHT NOW. Correcting any of these
# makes the guard the liar.

MUST_NOT_FIRE = [
    ("past_pronoun", "It was offline earlier."),
    ("past_named_subject", "The device was offline earlier."),
    ("past_perfect", "The machine had been offline when I last looked."),
    ("conditional_if", "If the device is offline, I can wake it."),
    ("conditional_once", "Once the device is online, I'll retry."),
    ("intent_check_whether", "Let me check whether the device is online."),
    ("intent_ill_check_if", "I'll check if the machine is connected."),
    ("hedged_might", "The device might be offline."),
    ("hedged_may_be", "Your computer may be unreachable."),
    ("question_is_it", "Is the device online?"),
    ("question_confirm", "Could you confirm the device is connected?"),
    ("reported_speech", "You said the device is offline."),
    ("prior_time_marker", "The device is offline as of an hour ago."),
    ("no_device_subject", "The connection is offline."),
    ("bare_pronoun_subject", "It's offline."),
    ("ordinary_reply", "Here's the summary of your calendar for tomorrow."),
    (
        "general_capability",
        "I can check whether a paired computer is online whenever you ask.",
    ),
]


@pytest.mark.parametrize("label,reply", MUST_NOT_FIRE, ids=[c[0] for c in MUST_NOT_FIRE])
def test_must_not_fire_on_replies_that_assert_no_current_state(label, reply):
    assert (
        guards.state_claim_check(reply, [], NAMES) is None
    ), f"{label!r} was wrongly corrected — a false positive makes the guard the liar"


# -- edges the corpus does not name but precision demands ------------------


def test_an_empty_or_blank_reply_never_fires():
    assert guards.state_claim_check("", [], NAMES) is None
    assert guards.state_claim_check("   \n ", [], NAMES) is None


def test_a_FAILED_device_span_does_not_back_the_claim():
    """Backing is a SUCCESSFUL span. A device call that errored proves nothing
    about the machine's state, so the claim is still unchecked."""
    claim = guards.state_claim_check(OWNER_CASE, [Span("device_list", ok=False)], NAMES)
    assert claim is not None


def test_a_non_device_span_does_not_back_the_claim():
    """A web fetch is not a device check."""
    assert guards.state_claim_check(OWNER_CASE, [Span("fetch_url")], NAMES) is not None


def test_backing_is_derived_from_the_device_prefix_not_a_list():
    """Every device tool is named device_* (app/tools/devices.py), which is why
    backing is a prefix test: a device tool shipped tomorrow backs the claim the
    day it lands. If this ever goes red, a device tool was named off-pattern —
    that is the alarm, not a nuisance."""
    from app.tools import devices as device_tools

    names = [tool.name for tool in device_tools.TOOLS]
    assert names, "the device tool module shipped no tools"
    assert all(name.startswith("device_") for name in names), names
    for name in names:
        assert guards.state_claim_check(OWNER_CASE, [Span(name)], NAMES) is None


def test_a_name_with_regex_metacharacters_is_matched_literally():
    """Device names are operator text; one containing '.' or '+' must not become
    a wildcard that swallows unrelated sentences."""
    names = ["jeremy's box (v2.0)"]
    assert guards.state_claim_check("jeremy's box (v2.0) is offline.", [], names)
    assert guards.state_claim_check("jeremyXsXboxXXvZZ0Y is offline.", [], names) is None


def test_the_correction_and_the_note_trip_no_guard_of_their_own():
    """The correction is what PERSISTS, so a text that tripped a guard would be
    corrected forever. Same bar for the live note the redirect ships."""
    text = guards.STATE_CLAIM_CORRECTION
    assert guards.state_claim_check(text, [], NAMES) is None
    assert guards.narration_check(text, []) is None
    assert guards.consent_claim_check(text, has_pending_consent=False) is None
    assert guards.capability_claim_check(text, ["fetch_url", "device_list"]) is None
    assert guards.deferral_check(text, [], ["fetch_url", "web_search"]) is None

    note = chat.STATE_REDIRECT_NOTE
    assert guards.state_claim_check(note, [], NAMES) is None
    assert guards.narration_check(note, []) is None
    assert guards.consent_claim_check(note, has_pending_consent=False) is None
    assert guards.deferral_check(note, [], ["fetch_url", "web_search"]) is None


def test_the_redirect_nudge_refuses_to_state_a_fact_that_is_not_true():
    """The nudge asserts 'nothing has run this turn', so it is BUILT from that
    fact rather than written as a constant that could drift out of step with it.
    Told otherwise, it refuses — a lie to the model is what produces a second
    dispatch."""
    nudge = chat.state_redirect_nudge(device=DEVICE, ran_a_tool=False)
    assert DEVICE in nudge
    assert "device tool" in nudge
    with pytest.raises(ValueError):
        chat.state_redirect_nudge(device=DEVICE, ran_a_tool=True)
