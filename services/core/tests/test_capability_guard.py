"""The capability-claim guard, tested in isolation: pure (text, tools) -> verdict.

capability_claim_check is a pure function — no database, no gateway — so this is
the fast corpus that pins its precision. The expensive failure is a
wrongly-corrected HONEST reply (a false positive makes the guard itself the
liar), so the must-NOT-fire cases below are as load-bearing as the fabrications.

Every case from the S3 walk-fix (T7) brief's calibration section is here, plus
the registry TOGGLE proving the SAME sentence flips verdict on whether the
satisfying tool is actually available — the derived-not-hardcoded property.
"""
from __future__ import annotations

import pytest

from app import guards, tools

# The live registry — the real tool set the running loop exposes. Using it
# (rather than a hand-written list) is the point: the guard reads the tools the
# system actually has, so these tests break the day fetch_url/workspace_* leave
# the registry, which is the intended alarm.
ALL_TOOLS = tools.tool_names()


def tgt(correction) -> list:
    return [claim.target for claim in correction.claims]


# -- MUST FIRE (the satisfying tool is registered) -------------------------
#
# The exact owner reply plus every calibration case from the brief. Each denies
# a GENERAL ability whose tool is in the live registry, so each is a false
# denial the guard must contradict.

MUST_FIRE = [
    (
        "owner_exact_reply",
        "I cannot access external websites or real-time data, including bigblueview.com.",
        "fetch_url",
    ),
    ("cant_browse_the_web", "I can't browse the web.", "fetch_url"),
    ("unable_to_access_the_internet", "I'm unable to access the internet.", "fetch_url"),
    (
        "capabilities_dont_include_web_browsing",
        "My capabilities don't include web browsing.",
        "fetch_url",
    ),
    ("no_ability_to_fetch_urls", "I don't have the ability to fetch URLs.", "fetch_url"),
    ("cant_read_files", "I can't read files.", "workspace_read_file"),
    ("not_able_to_save_files", "I'm not able to save files.", "workspace_write_file"),
    # S10a-3: her model tools.
    ("cant_download_models", "I can't download models.", "model_pull"),
    ("unable_to_install_a_model", "I'm unable to install a new model.", "model_pull"),
    ("cant_search_for_models", "I can't search for models.", "model_catalog_search"),
    ("cant_list_installed_models", "I cannot list the installed models.", "model_catalog_search"),
]


@pytest.mark.parametrize("label,reply,tool", MUST_FIRE, ids=[c[0] for c in MUST_FIRE])
def test_must_fire_when_the_tool_is_registered(label, reply, tool):
    correction = guards.capability_claim_check(reply, ALL_TOOLS)
    assert correction is not None, f"{label!r} should have fired but did not"
    assert tgt(correction) == [tool]
    # The correction NAMES the real tool, derived from the passed registry.
    assert tool in correction.text, correction.text
    assert correction.text.startswith("Correction: I can do that")


# -- MUST NOT FIRE (has the tools; still honest) ---------------------------
#
# A capability with no registered tool is HONEST (there is genuinely no such
# tool). A specific failed attempt is an honest result about ONE try, not a
# denial of the ability. A hedge/question asserts no inability. Correcting any
# of these makes the guard the liar.

MUST_NOT_FIRE = [
    # No registered tool -> the denial is HONEST (proven by passing the REAL
    # registry, which has no email/phone/bank tool).
    ("no_tool_send_emails", "I can't send emails."),
    ("no_tool_phone_calls", "I can't make phone calls."),
    ("no_tool_bank_account", "I don't have access to your bank account."),
    # A SPECIFIC failed attempt, not an ability denial (the precision crux).
    ("specific_404", "I couldn't fetch that page — it returned a 404."),
    ("specific_missing_file", "I can't find a file named report.md."),
    ("specific_url_didnt_load", "That URL didn't load."),
    # A hedge / conditional / question describes what MIGHT or WOULD be, not what
    # is; a question asserts nothing at all.
    ("hedge_guarantee", "I can't guarantee that's accurate."),
    ("hedge_might_not_reach", "I might not be able to reach that site."),
    ("question_would_you_like", "Would you like me to try?"),
    # An honest plain reply carries no denial.
    ("plain_reply", "The capital of France is Paris."),
]


@pytest.mark.parametrize("label,reply", MUST_NOT_FIRE, ids=[c[0] for c in MUST_NOT_FIRE])
def test_must_not_fire_on_honest_replies(label, reply):
    assert (
        guards.capability_claim_check(reply, ALL_TOOLS) is None
    ), f"{label!r} was wrongly corrected — a false positive makes the guard the liar"


def test_the_correction_text_itself_never_fires():
    """Self-reference: running the guard on its own honest correction must be
    clean — the correction is worded to carry no inability lead."""
    correction = guards.capability_claim_check("I can't browse the web.", ALL_TOOLS)
    assert correction is not None
    assert guards.capability_claim_check(correction.text, ALL_TOOLS) is None


# -- the registry TOGGLE: derived-not-hardcoded ----------------------------


def test_the_same_denial_fires_only_when_the_tool_is_registered():
    """'I can't browse the web' is a FALSE denial when fetch_url is available and
    an HONEST one when it is not — the verdict flips on the live tool set alone,
    which is the whole derived-not-hardcoded point (CLAUDE.md)."""
    reply = "I can't browse the web."
    fired = guards.capability_claim_check(reply, ["fetch_url"])
    assert fired is not None
    assert tgt(fired) == ["fetch_url"]
    # fetch_url removed from the registry -> the denial is honest -> silent.
    without_fetch = [t for t in ALL_TOOLS if t != "fetch_url"]
    assert guards.capability_claim_check(reply, without_fetch) is None
    # And with no tools at all.
    assert guards.capability_claim_check(reply, []) is None


# -- edges precision demands -----------------------------------------------


def test_an_empty_or_blank_reply_never_fires():
    assert guards.capability_claim_check("", ALL_TOOLS) is None
    assert guards.capability_claim_check("   \n ", ALL_TOOLS) is None


def test_a_past_tense_or_other_subject_denial_is_not_a_capability_claim():
    # Past tense is a report of one attempt, not a denial of the ability.
    assert guards.capability_claim_check("I couldn't browse the web.", ALL_TOOLS) is None
    # Another subject — not the model disowning its OWN capability.
    assert guards.capability_claim_check("You can't browse the web from here.", ALL_TOOLS) is None
    assert guards.capability_claim_check("It cannot access websites.", ALL_TOOLS) is None


def test_the_trailing_denial_form_fires():
    """'<capability> is not something I can do' — the capability comes first."""
    correction = guards.capability_claim_check(
        "Web browsing is not something I can do.", ALL_TOOLS
    )
    assert correction is not None
    assert tgt(correction) == ["fetch_url"]


def test_the_guard_is_pure_same_inputs_same_verdict():
    reply = "I can't browse the web."
    first = guards.capability_claim_check(reply, ALL_TOOLS)
    second = guards.capability_claim_check(reply, ALL_TOOLS)
    assert (first is None) == (second is None)
    assert first is not None
    assert tgt(first) == tgt(second)
    assert first.text == second.text


@pytest.mark.parametrize(
    "reply",
    [
        "I can't \\((((.md and [unbalanced",
        "cannot cannot cannot",
        "创建 web browsing 文件",  # non-ascii around a real phrase
        "\n\n\n",
        "I can't " + "web browsing " * 200,
    ],
)
def test_the_matcher_never_raises_on_odd_input(reply):
    # We do not care about the verdict here — only that it returns cleanly.
    guards.capability_claim_check(reply, ALL_TOOLS)
