"""The honesty guard, tested in isolation: pure (text, spans) -> verdict.

No database and no gateway here — narration_check is a pure function, so
these are the fast tests that pin its precision. The expensive failure is a
wrongly-corrected HONEST reply (ruling S2d-R2), so the negatives below are
as load-bearing as the fabrications: every one of them MUST come back
clean.
"""
from __future__ import annotations

from types import SimpleNamespace

from app import guards

# -- span stand-ins --------------------------------------------------------
#
# narration_check duck-types spans (kind/name/meta), so a SimpleNamespace is
# a faithful stand-in for a traces.Span without the timing machinery.


def tool_span(name: str, *, ok: bool = True, path=None, url=None):
    args: dict = {}
    if path is not None:
        args["path"] = path
    if url is not None:
        args["url"] = url
    return SimpleNamespace(kind="tool", name=name, meta={"ok": ok, "args_redacted": args})


def other_span(kind: str = "llm_call"):
    return SimpleNamespace(kind=kind, name=None, meta={"round": 1})


def kinds(correction) -> list[str]:
    return [claim.kind for claim in correction.claims]


def targets(correction) -> list:
    return [claim.target for claim in correction.claims]


# -- the fabrications the guard exists to catch ----------------------------


def test_the_real_kv_offloading_lie_is_flagged():
    """The captured live lie: a file-write claim with zero write spans."""
    reply = "I've created a summary file called kv_offloading_summary.md for you."
    correction = guards.narration_check(reply, [other_span("memory_recall"), other_span()])
    assert correction is not None
    assert kinds(correction) == ["wrote_file"]
    assert targets(correction) == ["kv_offloading_summary.md"]
    assert correction.text == guards.CORRECTION_TEXT


def test_e2e_fabrication_a_updated_successfully_with_no_span_is_flagged():
    reply = "The file groceries.md has been updated successfully."
    correction = guards.narration_check(reply, [other_span()])
    assert correction is not None
    assert kinds(correction) == ["wrote_file"]


def test_e2e_fabrication_b_presented_file_contents_with_no_span_is_flagged():
    reply = (
        "The file receipts/2019-invoice.md contains the following content: "
        "Amount: $412.50, Date: 2019-03-04, Customer: Acme Co."
    )
    correction = guards.narration_check(reply, [other_span()])
    assert correction is not None
    assert kinds(correction) == ["file_contents"]


def test_e2e_fabrication_c_wrong_file_named_is_flagged_by_target():
    """Scenario 9's lie: it claimed the named list but wrote a NEW file.

    A write span exists, so an action-kind-only check would wave it through;
    target-aware backing catches that the file it CLAIMED was never written.
    """
    reply = "Done — I've added dragon fruit vinegar to groceries.md."
    spans = [tool_span("workspace_write_file", path="dragon_fruit.md")]
    correction = guards.narration_check(reply, spans)
    assert correction is not None
    assert kinds(correction) == ["wrote_file"]
    assert targets(correction) == ["groceries.md"]


def test_a_fetched_url_claim_with_no_fetch_span_is_flagged():
    reply = "I fetched https://example.com/pricing and here is what it said."
    correction = guards.narration_check(reply, [other_span()])
    assert correction is not None
    assert kinds(correction) == ["fetched_url"]


def test_a_read_claim_needs_a_read_span_even_when_a_write_ran():
    """'read it back' is its own action; a write span does not stand in."""
    reply = "I read groceries.md back to be sure."
    spans = [tool_span("workspace_write_file", path="groceries.md")]
    correction = guards.narration_check(reply, spans)
    assert correction is not None
    assert kinds(correction) == ["read_file"]


# -- the negatives: honest replies the guard MUST leave alone --------------


def test_a_write_claim_with_a_matching_span_is_not_flagged():
    reply = "I've created groceries.md with your five items."
    spans = [tool_span("workspace_write_file", path="groceries.md")]
    assert guards.narration_check(reply, spans) is None


def test_a_write_span_in_a_subdirectory_still_backs_the_named_file():
    reply = "Saved groceries.md for you."
    spans = [tool_span("workspace_write_file", path="lists/groceries.md")]
    assert guards.narration_check(reply, spans) is None


def test_a_write_claim_with_no_named_file_is_backed_by_any_write_span():
    reply = "I've saved the file you asked for."
    spans = [tool_span("workspace_write_file", path="whatever.md")]
    assert guards.narration_check(reply, spans) is None


def test_a_content_claim_is_backed_by_the_write_that_produced_it():
    """Describing what you just wrote is honest: the write grounds the content."""
    reply = "The file now contains your five items."
    spans = [tool_span("workspace_write_file", path="groceries.md")]
    assert guards.narration_check(reply, spans) is None


def test_a_fetch_claim_with_a_fetch_span_is_not_flagged():
    reply = "I fetched https://example.com/pricing and it lists three tiers."
    spans = [tool_span("fetch_url", url="https://example.com/pricing")]
    assert guards.narration_check(reply, spans) is None


def test_a_memory_note_claim_is_backed_by_a_memory_save_span():
    reply = "I've saved a note about your coffee order."
    spans = [tool_span("memory_save")]
    assert guards.narration_check(reply, spans) is None


def test_a_stated_failure_is_not_a_claim():
    reply = "I could not create the file — the path is outside my workspace."
    assert guards.narration_check(reply, [other_span()]) is None


def test_a_passive_negation_is_not_a_claim():
    reply = "The file has not been created yet."
    assert guards.narration_check(reply, [other_span()]) is None


def test_an_offer_phrased_as_a_question_is_not_a_claim():
    reply = "Would you like me to create it? I can write groceries.md next."
    assert guards.narration_check(reply, [other_span()]) is None


def test_a_future_intent_is_not_a_claim():
    reply = "I'll write it next, once you confirm the items."
    assert guards.narration_check(reply, [other_span()]) is None


def test_a_reply_with_no_action_claim_is_not_flagged():
    reply = "The capital of France is Paris, and it is roughly 2.1 million people."
    assert guards.narration_check(reply, [other_span()]) is None


def test_a_write_verb_with_no_file_object_is_not_a_file_claim():
    """'I added two numbers' is not a file write — no noun, no filename."""
    reply = "I added the two numbers and the total is 42."
    assert guards.narration_check(reply, []) is None


# -- boundary phrasing -----------------------------------------------------


def test_a_modal_before_the_verb_suppresses_but_after_it_does_not():
    """'will' after the claimed action does not un-claim it (the kv shape)."""
    reply = "I've created kv_offloading_summary.md, which will help you later."
    correction = guards.narration_check(reply, [other_span()])
    assert correction is not None
    assert kinds(correction) == ["wrote_file"]


def test_read_it_back_is_a_claim_but_can_read_is_not():
    completed = "I read groceries.md back to confirm."
    hedged = "I can read groceries.md back if you want."
    assert guards.narration_check(completed, []) is not None
    assert guards.narration_check(hedged, []) is None


def test_a_negation_in_a_later_clause_does_not_cancel_an_earlier_claim():
    reply = "I've created report.md, but I have not read it back yet."
    correction = guards.narration_check(reply, [])
    assert correction is not None
    # Only the create is a claim; the read is negated, so it is not flagged.
    assert kinds(correction) == ["wrote_file"]
    assert targets(correction) == ["report.md"]


# -- multi-claim -----------------------------------------------------------


def test_two_named_files_one_span_flags_only_the_unbacked_one():
    reply = "I saved groceries.md and notes.md for you."
    spans = [tool_span("workspace_write_file", path="groceries.md")]
    correction = guards.narration_check(reply, spans)
    assert correction is not None
    assert kinds(correction) == ["wrote_file"]
    assert targets(correction) == ["notes.md"]


# -- properties ------------------------------------------------------------


def test_the_guard_is_pure_same_inputs_same_verdict():
    reply = "I've created kv_offloading_summary.md."
    spans = [other_span()]
    first = guards.narration_check(reply, spans)
    second = guards.narration_check(reply, spans)
    assert (first is None) == (second is None)
    assert first is not None
    assert kinds(first) == kinds(second)
    assert targets(first) == targets(second)


def test_only_successful_spans_back_a_claim():
    """A write that FAILED (ok=false) does not back a success claim."""
    reply = "I've created groceries.md."
    spans = [tool_span("workspace_write_file", ok=False, path="groceries.md")]
    assert guards.narration_check(reply, spans) is not None


def test_an_empty_reply_is_never_a_claim():
    assert guards.narration_check("", [other_span()]) is None
    assert guards.narration_check("   \n ", [other_span()]) is None
