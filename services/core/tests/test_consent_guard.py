"""The pending-approval guard, tested in isolation: pure text -> verdict.

consent_claim_check is a pure function — no database, no gateway, and (since
the owner's ruling of 2026-09-03 removed every approval mechanism) no state
either: there is no approval step, so any claim of one is false. This is the
fast corpus that pins its precision. The expensive failure is a
wrongly-corrected HONEST reply (a false positive makes the guard itself the
liar), so the must-NOT-fire cases below are as load-bearing as the
fabrications.

Every case from the S3 walk-fix brief's calibration section is here, plus the
general-statement case that used to be exempt: "X requires your approval in
general" is now exactly as false as "X is awaiting your approval".
"""
from __future__ import annotations

import pytest

from app import guards

# The owner's EXACT captured case: the model parroted a prior turn's pending
# line with nothing pending anywhere.
OWNER_CASE = (
    "That fetch is awaiting your approval — I can't complete it without you "
    "OK'ing it."
)

# -- MUST FIRE ---------------------------------------------------------------

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
    ("requires_the_operators_approval", "This requires the operator's approval."),
]


@pytest.mark.parametrize("label,reply", MUST_FIRE, ids=[c[0] for c in MUST_FIRE])
def test_must_fire(label, reply):
    correction = guards.consent_claim_check(reply)
    assert correction is not None, f"{label!r} should have fired but did not"
    assert correction.text == guards.CONSENT_CLAIM_CORRECTION
    # A pending-approval correction names no file/url claim — it is the whole
    # reply's stance that is contradicted, not a specific target.
    assert correction.claims == ()


def test_a_general_requires_your_approval_statement_fires():
    """There is no approval step, so a statement that a CLASS of actions
    requires the operator's approval is as false as a claim that one is
    pending — the "in general" qualifier that used to exempt it is gone, and
    the subject no longer has to be a demonstrative for the shape to count."""
    for reply in (
        "Fetching external URLs requires your approval in general.",
        "That requires your approval in general.",
        "Running commands on the device needs your OK.",
    ):
        correction = guards.consent_claim_check(reply)
        assert correction is not None, reply
        assert correction.text == guards.CONSENT_CLAIM_CORRECTION


# -- MUST NOT FIRE -------------------------------------------------------------
#
# A question/offer asserts nothing; a future/hypothetical describes what WOULD
# happen, not what is; a negated report says nothing is pending. Correcting any
# of these makes the guard the liar.

MUST_NOT_FIRE = [
    ("question_would_you_like", "Would you like me to fetch it?"),
    ("question_should_i", "Should I look it up?"),
    ("offer_want_me_to", "Want me to pull that page?"),
    ("future_that_would_need_approval", "That would need your approval."),
    ("future_it_will_require", "It will require your approval if the policy changes."),
    ("future_id_have_to_request", "I'd have to request approval first."),
    ("hypothetical_if_you_want", "If you want, I can request approval."),
    # Someone ELSE's approval step is not a claim about this system.
    ("other_system_reviewer", "The pull request needs approval from a maintainer."),
    # RELAYED content read from the world. A third-party subject ("the pull
    # request", "your expense report", "the invoice", "form") is not one of HER
    # actions, so the subject restriction alone keeps it clean — the earlier
    # form fired on ANY subject and so REPLACED these honest reports, the worst
    # failure a REPLACE-class guard can have.
    (
        "relayed_github_pr",
        "The pull request needs your approval on GitHub before CI merges it.",
    ),
    (
        "relayed_expense_report",
        "Your expense report requires your sign-off in Workday.",
    ),
    ("relayed_invoice", "The invoice needs your OK before accounting pays it."),
    (
        "relayed_school_form",
        "Your kid's school trip form needs your approval by Friday.",
    ),
    # A REPORTING FRAME relays the statement even when its subject IS a
    # demonstrative/gerund the subject restriction would otherwise catch — only
    # _reported_frame keeps these clean, so they prove the exemption is
    # load-bearing.
    (
        "reporting_frame_contractor_colon",
        "Your contractor emailed: the quote needs your approval by Friday.",
    ),
    (
        "reporting_frame_readme_states",
        "The README states that releases require your approval.",
    ),
    (
        "reporting_frame_demonstrative_in_quote",
        "The docs say: 'This requires your approval.'",
    ),
    (
        "reporting_frame_gerund_according_to",
        "According to the runbook, deploying to production requires your approval.",
    ),
]


@pytest.mark.parametrize("label,reply", MUST_NOT_FIRE, ids=[c[0] for c in MUST_NOT_FIRE])
def test_must_not_fire_on_honest_non_pending_replies(label, reply):
    assert (
        guards.consent_claim_check(reply) is None
    ), f"{label!r} was wrongly corrected — a false positive makes the guard the liar"


def test_a_negated_approval_sentence_stays_silent():
    """A negation before the phrase turns it into an honest report that nothing
    waits — every shape of it stays clean, including the one the correction
    itself uses and the plain "I don't need your approval"."""
    for reply in (
        "Nothing is pending your approval right now.",
        "I don't need your approval for that — doing it now.",
        "No approval is needed; it is not awaiting your OK.",
        "This does not require your approval.",
    ):
        assert guards.consent_claim_check(reply) is None, reply


# -- edges the corpus does not name but precision demands ------------------


def test_an_empty_or_blank_reply_never_fires():
    assert guards.consent_claim_check("") is None
    assert guards.consent_claim_check("   \n ") is None


def test_a_plain_honest_reply_never_fires():
    reply = "Here's the summary of the page you asked about."
    assert guards.consent_claim_check(reply) is None


def test_the_guard_reads_no_state():
    """The signature IS the property: the check takes the text and nothing
    else, so there is no boolean anyone could pass to make a pending claim
    'true'. Kept as an explicit pin because the old two-argument form is the
    exact shape a rebuilt approval system would reach for first."""
    import inspect

    params = list(inspect.signature(guards.consent_claim_check).parameters)
    assert params == ["reply_text"]
    with pytest.raises(TypeError):
        guards.consent_claim_check(OWNER_CASE, True)  # type: ignore[call-arg]


def test_the_correction_names_no_mechanism_and_trips_no_guard_of_its_own():
    """MECHANISM-NEUTRAL: the correction must not describe a card, a decision
    or any approval path — there is none. And, like every other correction
    text here, it must survive its own family of guards: it is what PERSISTS,
    so a text that tripped one would be corrected forever."""
    from app import chat

    text = guards.CONSENT_CLAIM_CORRECTION
    assert "card" not in text.lower()
    assert "approve or deny" not in text.lower()
    assert "your approval" not in text.lower()
    assert "there is no approval step" in text.lower()
    assert guards.consent_claim_check(text) is None
    assert guards.narration_check(text, []) is None
    assert guards.capability_claim_check(text, ["fetch_url", "web_search"]) is None
    assert guards.deferral_check(text, [], ["fetch_url", "web_search"]) is None
    assert guards.presented_listing_check(text, [], ["workspace_list_files"]) is None
    assert guards.bare_intent_check(text, []) is None

    # The live note the redirect ships in front of a regenerated reply, and the
    # nudge it sends the model, are held to exactly the same bar.
    for note in (chat.CONSENT_REDIRECT_NOTE, chat.consent_redirect_nudge(ran_a_tool=False)):
        assert guards.consent_claim_check(note) is None
        assert guards.narration_check(note, []) is None
        assert guards.deferral_check(note, [], ["fetch_url", "web_search"]) is None
        assert guards.presented_listing_check(note, [], ["workspace_list_files"]) is None
