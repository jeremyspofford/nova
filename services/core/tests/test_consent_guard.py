"""The pending-approval guard, tested in isolation: pure (text, bool) -> verdict.

consent_claim_check is a pure function — no database, no gateway — so this is
the fast corpus that pins its precision. The expensive failure is a
wrongly-corrected HONEST reply (a false positive makes the guard itself the
liar), so the must-NOT-fire cases below are as load-bearing as the fabrications.

Every case from the S3 walk-fix brief's calibration section is here, plus the
has_pending_consent toggle proving the SAME sentence flips verdict on that one
boolean.
"""
from __future__ import annotations

import pytest

from app import guards

# The owner's EXACT captured case: after a DENY, the model parroted the prior
# turn's pending line with no card actually pending anywhere.
OWNER_CASE = (
    "That fetch is awaiting your approval — I can't complete it without you "
    "OK'ing it."
)

# -- MUST FIRE (has_pending_consent=False) ---------------------------------

MUST_FIRE = [
    ("owner_exact_case", OWNER_CASE),
    ("its_pending_your_approval", "It's pending your approval."),
    ("bare_pending_approval", "The task is now pending approval."),
    ("waiting_for_you_to_approve", "I'm waiting for you to approve it."),
    ("waiting_on_your_ok", "I'm waiting on your OK."),
    ("waiting_on_your_approval", "I'm waiting on your approval."),
    ("queued_it_for_your_approval", "I've queued it for your approval."),
    ("bare_queued_for_approval", "The fetch is queued for approval."),
    (
        "needs_your_approval_before_i_can_proceed",
        "It needs your approval before I can proceed.",
    ),
]


@pytest.mark.parametrize("label,reply", MUST_FIRE, ids=[c[0] for c in MUST_FIRE])
def test_must_fire_when_no_consent_is_pending(label, reply):
    correction = guards.consent_claim_check(reply, has_pending_consent=False)
    assert correction is not None, f"{label!r} should have fired but did not"
    assert correction.text == guards.CONSENT_CLAIM_CORRECTION
    # A pending-approval correction names no file/url claim — it is the whole
    # reply's stance that is contradicted, not a specific target.
    assert correction.claims == ()


@pytest.mark.parametrize("label,reply", MUST_FIRE, ids=[c[0] for c in MUST_FIRE])
def test_the_same_sentence_does_not_fire_when_a_card_really_is_pending(label, reply):
    """The toggle: has_pending_consent=True makes every must-fire sentence TRUE,
    so the guard must stay silent on the identical text."""
    assert guards.consent_claim_check(reply, has_pending_consent=True) is None


# -- MUST NOT FIRE (has_pending_consent=False) -----------------------------
#
# A question/offer asserts nothing; a future/hypothetical describes what WOULD
# happen, not what is; a general capability statement is about a class of
# actions, not a pending one. Correcting any of these makes the guard the liar.

MUST_NOT_FIRE = [
    ("question_would_you_like", "Would you like me to fetch it?"),
    ("question_should_i", "Should I look it up?"),
    ("offer_want_me_to", "Want me to pull that page?"),
    ("future_that_would_need_approval", "That would need your approval."),
    ("future_id_have_to_request", "I'd have to request approval first."),
    ("hypothetical_if_you_want", "If you want, I can request approval."),
    (
        "general_capability_statement",
        "Fetching external URLs requires your approval in general.",
    ),
]


@pytest.mark.parametrize("label,reply", MUST_NOT_FIRE, ids=[c[0] for c in MUST_NOT_FIRE])
def test_must_not_fire_on_honest_non_pending_replies(label, reply):
    assert (
        guards.consent_claim_check(reply, has_pending_consent=False) is None
    ), f"{label!r} was wrongly corrected — a false positive makes the guard the liar"


# -- edges the corpus does not name but precision demands ------------------


def test_an_empty_or_blank_reply_never_fires():
    assert guards.consent_claim_check("", has_pending_consent=False) is None
    assert guards.consent_claim_check("   \n ", has_pending_consent=False) is None


def test_a_plain_honest_reply_never_fires():
    reply = "Here's the summary of the page you asked about."
    assert guards.consent_claim_check(reply, has_pending_consent=False) is None


def test_a_negated_pending_state_does_not_fire():
    """'Nothing is pending your approval' is an honest report that nothing waits
    — the negation before the state phrase must keep it clean."""
    assert (
        guards.consent_claim_check(
            "Nothing is pending your approval right now.", has_pending_consent=False
        )
        is None
    )
