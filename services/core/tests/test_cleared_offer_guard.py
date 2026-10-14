# ruff: noqa: E501 — the evidence turn is her real reply text, verbatim.
"""The cleared-offer guard, detection (guard follow-ups T1, 2026-10-13).

Turn f816e1c2 (2026-10-12, dell:qwen3.8:27b): he said "now set up the dell so
it can be woken over the network"; after fourteen tool calls her reply ended
"Do you want me to disable Fast Startup now? That one I can actually do." The
deferral guard's offer shape stood down — the instruction maps to no action
class, and tools had run. The owner's rule (memory nova-does-not-hand-back-
steps): asked to do it, she does it.

The shape is read off HER words only, never his message (no-phrase-matchers):
she asks permission for something she says, beside the question, that she can
do. There is no approval step in Nova (ruling 2026-09-03), so the question
waits on nothing. Measured before building: over all 818 stored replies this
shape hits exactly one, f816e1c2.

Every silent case is PAIRED with a firing twin, so the pair fails while
detection is missing and holds precision once it lands.
"""

from __future__ import annotations

import pytest

from app import guards

TURN_F816E1C2_TAIL = (
    "**What I'd actually change to make network-waking work reliably**\n"
    '1. **Disable Fast Startup** — `powercfg /h off` or the Fast Startup kill-switch. This is the one with the highest confidence of actually fixing the "won\'t wake" behavior on Windows + Tailscale. The admin path is installed on this machine, so I can do it.\n'
    '2. **Verify UEFI "Wake on LAN" is Enabled** — this has to be confirmed in the POST/UEFI menu, I can\'t drive that from here.\n'
    "3. **Keep the physical link up** — Ethernet is currently **not** negotiating.\n"
    "\n"
    "Do you want me to disable Fast Startup now? That one I can actually do. Or if you have the machine physically, the UEFI check is the more important verification — the OS layer is a secondary thing."
)


def check(reply: str):
    return guards.cleared_offer_check(reply)


def fires(reply: str, action_contains: str) -> None:
    claim = check(reply)
    assert claim is not None, f"should fire: {reply!r}"
    assert action_contains.lower() in claim.action.lower(), (claim, reply)
    assert claim.phrase, claim


def silent(reply: str) -> None:
    assert check(reply) is None, reply


def test_the_evidence_turn_fires():
    fires(TURN_F816E1C2_TAIL, "disable Fast Startup")


def test_an_offer_with_no_can_do_beside_it_is_silent():
    # The same question without her own "I can do that": a genuine question
    # this guard does not judge (the deferral offer shape owns instructed ones).
    fires(
        "Do you want me to disable Fast Startup now? That one I can actually do.",
        "disable Fast Startup",
    )
    silent("Do you want me to disable Fast Startup now? It will need a reboot to take effect.")


def test_the_can_do_must_sit_beside_the_question():
    fires(
        "Should I enable Wake on Magic Packet? I can do it right away.",
        "enable Wake on Magic Packet",
    )
    silent(
        "I can do that kind of change through the admin path. Ethernet is disconnected. "
        "The BIOS is on version 1.2. Should I enable Wake on Magic Packet?"
    )


def test_an_offer_of_extra_work_is_silent():
    # a942fbe7's shape: he asked her to CHECK, she offers something more.
    fires(
        "Want me to switch the Ethernet link on a test? I can do that.", "switch the Ethernet link"
    )
    silent("Want me to also switch the Ethernet link on a test? I can do that too.")
    silent("Do you want me to check the UEFI value as well? I can do that.")


def test_a_scope_choice_is_hers_to_ask():
    fires("Do you want me to disable Fast Startup? I can do that.", "disable Fast Startup")
    silent(
        "Do you want me to disable Fast Startup or turn off hibernation entirely? I can do either."
    )
    silent("Which adapter should I arm for wake? I can do that one now.")


def test_a_negated_can_do_is_no_clearance():
    fires("Should I flip the registry key? That one I can actually do.", "flip the registry key")
    silent(
        "Should I flip the registry key? I can't do that without the admin path, which isn't installed."
    )


def test_a_relayed_or_quoted_offer_is_not_hers():
    fires("Shall I restart the agent? I can do that.", "restart the agent")
    silent(
        'Earlier you said: "do you want me to restart the agent? I can do that" — that was me, and I did restart it.'
    )


def test_his_action_offered_back_is_not_her_offer():
    silent("Do you want to disable Fast Startup yourself? I can do that too if you'd rather.")


def test_the_claim_names_the_offered_action_not_the_whole_reply():
    claim = check(TURN_F816E1C2_TAIL)
    assert claim is not None
    assert "UEFI" not in claim.action
    assert len(claim.phrase) <= 120


def test_it_never_reads_his_message():
    # The check takes her reply alone; no user text can arm or disarm it.
    import inspect

    params = list(inspect.signature(guards.cleared_offer_check).parameters)
    assert params == ["reply_text"], params


# --- verification-2-7 T10: a crashed detector reaches the caller -------------
# chat.py's handler (try/logger.exception, ships the reply) is the ONE place a
# crash is handled; a guard that swallows its own exception and answers None is
# indistinguishable from a clean pass.


class _DetectorBoom(RuntimeError):
    pass


def test_v27_t10_a_crashing_detector_raises_to_the_caller(monkeypatch):
    """C1: the detector's own exception, unchanged — never None."""
    boom = _DetectorBoom("detector fell over")

    def broken(text: str):
        raise boom

    monkeypatch.setattr(guards, "_cleared_offer", broken)
    with pytest.raises(_DetectorBoom) as raised:
        guards.cleared_offer_check(TURN_F816E1C2_TAIL)
    assert raised.value is boom


def test_v27_t10_a_crash_on_an_honest_reply_raises_too(monkeypatch):
    """C1: a crash is not a pass even on a reply that would be silent."""

    def broken(text: str):
        raise ValueError("bad pattern state")

    monkeypatch.setattr(guards, "_cleared_offer", broken)
    with pytest.raises(ValueError, match="bad pattern state"):
        guards.cleared_offer_check("Done: Fast Startup is off.")


@pytest.mark.parametrize("reply", [None, ""])
def test_v27_t10_no_reply_is_no_claim_not_an_error(reply):
    """C3: a missing reply is not a crash."""
    assert guards.cleared_offer_check(reply) is None
