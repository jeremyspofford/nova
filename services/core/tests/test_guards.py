"""The honesty guard, tested in isolation: pure (text, spans) -> verdict.

No database and no gateway here — narration_check is a pure function, so
these are the fast tests that pin its precision. The expensive failure is a
wrongly-corrected HONEST reply (ruling S2d-R2), so the negatives below are
as load-bearing as the fabrications: every one of them MUST come back
clean.
"""

from __future__ import annotations

import re
from types import SimpleNamespace

import pytest

from app import chat, checks, guards, traces

# -- span stand-ins --------------------------------------------------------
#
# narration_check duck-types spans (kind/name/meta), so a SimpleNamespace is
# a faithful stand-in for a traces.Span without the timing machinery.


def tool_span(
    name: str, *, ok: bool = True, path=None, url=None, model=None, machine=None, serving=None
):
    args: dict = {}
    if path is not None:
        args["path"] = path
    if url is not None:
        args["url"] = url
    if model is not None:
        args["model"] = model
    if machine is not None:
        args["machine"] = machine
    if serving is not None:
        args["serving"] = serving
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
    reply = "I've saved groceries.md for you."
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


# -- the false positives the review caught: figurative / in-chat file nouns --
#
# Every one of these is an HONEST, ordinary reply. The first cut flagged them
# all because a bare noun (file/document/note/readme/markdown) counted as a
# file. It must not: a claim is anchored ONLY by a real filename token. These
# are permanent regression pins (ruling S2d-R2 — the expensive failure).

REVIEWER_FALSE_POSITIVES = [
    "I updated my notes on your preferences.",
    "I've updated my understanding of the document.",
    "I saved you the trouble of reformatting the document.",
    "I've saved a summary of the readme below.",
    "I've written a short note here in the chat for you.",
    "I reviewed the document you pasted and it looks solid.",
    "I read the readme you shared in chat",
    "I checked the markdown formatting in your message.",
    "The document you gave me contains three sections.",
    "Here is the content of the file:",
    "Here is the content I would write to the file:",
]


@pytest.mark.parametrize("reply", REVIEWER_FALSE_POSITIVES)
def test_a_figurative_or_in_chat_file_noun_is_never_a_claim(reply):
    # No spans at all: if any of these flagged, the guard would be the liar.
    assert guards.narration_check(reply, []) is None


# A second adversarial sweep (fix round 2) caught more honest replies still
# flagging: a figurative verb sweeping an UNRELATED filename that shares the
# clause, and passive/third-party attributions the pronoun-only check missed.
# The structural cut is: a filename must be the verb's own direct object, and a
# passive/content claim must not attribute to another agent or time. Permanent.
REVIEWER_FALSE_POSITIVES_2 = [
    "I updated my approach and config.yaml is the file you'll want to edit.",
    "I saved us some time and notes.md can hold the rest.",
    "I updated my thinking, config.yaml is the file to edit.",
    "I saved us time - notes.md can hold the rest.",
    "config.yaml was updated by you, not me.",
    "groceries.md was created by the previous session, not this one.",
    "config.yaml was updated earlier today before we started.",
    "The previous session created config.yaml.",
    "config.yaml was overwritten by the deploy job.",
    "report.md was written by a teammate yesterday.",
    "A requirements.txt lists your dependencies.",
]


@pytest.mark.parametrize("reply", REVIEWER_FALSE_POSITIVES_2)
def test_an_unrelated_or_attributed_filename_is_never_a_self_claim(reply):
    assert guards.narration_check(reply, []) is None


# My own fresh sweep: honest replies that carry a REAL filename which a naive
# direct-object matcher might still catch — the filename is a subject, a
# location, a recommendation, or another agent's/time's action.
@pytest.mark.parametrize(
    "reply",
    [
        "config.yaml is the file you should edit.",
        "You'll find the setting in settings.json.",
        "I recommend editing groceries.md by hand.",
        "The error is in main.py at line 42.",
        "I looked at config.yaml but did not change it.",
        "I've reviewed your request and config.yaml looks correct.",
        "config.yaml was updated by the CI pipeline.",
        "report.md exists already from an earlier run.",
        "The previous run wrote output.json, not this turn.",
        "I did not create report.md; it was already there.",
    ],
)
def test_a_filename_that_is_not_the_verbs_own_object_is_not_a_claim(reply):
    assert guards.narration_check(reply, []) is None


def test_saved_it_as_a_named_file_is_still_a_claim():
    """The direct-object cut must not lose the common 'saved it as X.md' lie."""
    correction = guards.narration_check("I saved it as report.md.", [])
    assert correction is not None
    assert kinds(correction) == ["wrote_file"]
    assert targets(correction) == ["report.md"]


# A third adversarial sweep found the direct-object anchoring was incompletely
# wired: a filename behind an ABOUTNESS preposition (of/about/on/for) names the
# TOPIC, not what was written, but was being swept as the object. These are all
# honest; permanent negatives.
REVIEWER_FALSE_POSITIVES_3 = [
    "I wrote up my thoughts on report.md in the chat above.",
    "I've written extensively about backup.sh best practices.",
    "I wrote a summary of config.yaml.",
    "I updated the section on config.yaml handling.",
    "I read the docs about backup.sh.",
    "I read a chapter of manual.pdf.",
    "I created an outline for how report.md might read.",
    "I added a note about config.yaml to our conversation.",
]


@pytest.mark.parametrize("reply", REVIEWER_FALSE_POSITIVES_3)
def test_a_filename_that_is_the_topic_not_the_object_is_not_a_claim(reply):
    assert guards.narration_check(reply, []) is None


# The flip side: a filename tied to the verb by a DESTINATION or IDENTITY
# connector IS the object and must still flag (no matching span). This is how
# the real kv_offloading lie stays caught.
@pytest.mark.parametrize(
    ("reply", "target"),
    [
        (
            "I've created a summary file called kv_offloading_summary.md.",
            "kv_offloading_summary.md",
        ),
        ("I created a file named plan.md.", "plan.md"),
        ("I saved the file report.md for you.", "report.md"),
        ("I saved it as report.md.", "report.md"),
        ("I added milk to groceries.md.", "groceries.md"),
        ("I wrote the results into settings.json.", "settings.json"),
        ("I wrote deploy.sh.", "deploy.sh"),
    ],
)
def test_a_destination_or_identity_connected_filename_is_the_object(reply, target):
    correction = guards.narration_check(reply, [])
    assert correction is not None, reply
    assert targets(correction) == [target]


# A fourth sweep found the MIRROR of the oblique case: a filename used as a
# PRE-NOMINAL MODIFIER of a content noun ("the config.yaml parsing logic" ==
# "the parsing logic for config.yaml"). Same meaning as an already-clean
# oblique form, words reordered — all honest. Permanent negatives.
REVIEWER_FALSE_POSITIVES_4 = [
    "I updated the config.yaml parsing logic.",
    "I updated the config.yaml handling.",
    "I added config.yaml support.",
    "I read the backup.sh docs.",
    "I wrote the config.yaml summary.",
    "I read config.yaml documentation before starting.",
]


@pytest.mark.parametrize("reply", REVIEWER_FALSE_POSITIVES_4)
def test_a_filename_that_pre_modifies_a_content_noun_is_not_a_claim(reply):
    assert guards.narration_check(reply, []) is None


def test_a_filename_at_a_boundary_stays_the_object_despite_the_modifier_rule():
    """The demotion must fire ONLY when a content noun follows: a filename at
    end-of-clause or before a preposition is still the object."""
    # End-of-clause -> object.
    assert guards.narration_check("I created the file report.md.", []) is not None
    # A preposition (not a modified noun) after it -> object.
    assert guards.narration_check("I've created groceries.md with five items.", []) is not None


# -- BUG A: a URL's trailing sentence punctuation must not defeat backing ----
#
# The URL regex glues on a trailing period/comma; without normalisation an
# HONEST fetch that actually ran (span present) was flagged. All of these have
# a matching fetch_url span and MUST be clean.
@pytest.mark.parametrize(
    ("reply", "span_url"),
    [
        ("I fetched https://example.com/data.", "https://example.com/data"),
        (
            "I pulled the data from https://api.example.com/v2/users.",
            "https://api.example.com/v2/users",
        ),
        ("I downloaded https://example.com/report.pdf.", "https://example.com/report.pdf"),
        ("I fetched https://example.com/data, which was helpful.", "https://example.com/data"),
    ],
)
def test_a_backed_fetch_is_clean_regardless_of_trailing_punctuation(reply, span_url):
    spans = [tool_span("fetch_url", url=span_url)]
    assert guards.narration_check(reply, spans) is None


def test_an_unbacked_fetch_still_flags_even_with_trailing_punctuation():
    assert guards.narration_check("I fetched https://example.com/data.", []) is not None


def test_a_fetch_of_a_different_url_than_the_span_still_flags():
    spans = [tool_span("fetch_url", url="https://other.example.com/thing")]
    assert guards.narration_check("I fetched https://example.com/data.", spans) is not None


# -- BUG B: "added <file> to <non-file container>" is not a file write -------
#
# For add/append the immediate object is the CONTENT; the write target is the
# destination FILE. A non-file destination ("the list", "the agenda") means no
# file was written. All clean.
@pytest.mark.parametrize(
    "reply",
    [
        "I added config.yaml to the list of files to review.",
        "I added config.yaml to the agenda.",
        "I added notes.md to my running to-do list.",
        "I added config.yaml to our discussion for later.",
    ],
)
def test_adding_a_file_to_a_non_file_container_is_not_a_write(reply):
    assert guards.narration_check(reply, []) is None


@pytest.mark.parametrize(
    "reply",
    [
        "I added milk to groceries.md.",
        "I added the line to groceries.md.",
        "I appended a row to data.csv.",
    ],
)
def test_adding_to_a_destination_file_still_flags(reply):
    correction = guards.narration_check(reply, [])
    assert correction is not None, reply
    assert kinds(correction) == ["wrote_file"]


# -- second/third-person attribution is not a self-claim -------------------


@pytest.mark.parametrize(
    "reply",
    [
        "You said you created the file.",
        "Since you created the file, I left it alone.",
        "You mentioned you saved notes.md.",
        "He wrote config.yaml last week, not me.",
        "They updated report.md before I joined.",
    ],
)
def test_an_attributed_or_reported_action_is_not_flagged(reply):
    assert guards.narration_check(reply, []) is None


def test_a_first_person_claim_with_a_second_person_aside_still_flags():
    """'as you requested' must not suppress the 'I created' that follows it."""
    reply = "As you requested, I created report.md."
    correction = guards.narration_check(reply, [])
    assert correction is not None
    assert kinds(correction) == ["wrote_file"]
    assert targets(correction) == ["report.md"]


# -- in-chat draft content is honest (IMPORTANT 3) -------------------------


@pytest.mark.parametrize(
    "reply",
    [
        "Here is the content of the file:",
        "Here is the content I would write to the file:",
        "The draft note contains three sections you can review.",
        "Here is what the file would contain once you say go.",
    ],
)
def test_presenting_proposed_content_in_chat_is_not_a_claim(reply):
    assert guards.narration_check(reply, []) is None


# -- multi-verb clauses tie each file to the right verb --------------------


def test_read_one_file_and_wrote_another_backs_each_by_its_own_span():
    reply = "I read config.yaml and wrote output.json from it."
    spans = [
        tool_span("workspace_read_file", path="config.yaml"),
        tool_span("workspace_write_file", path="output.json"),
    ]
    assert guards.narration_check(reply, spans) is None


def test_read_one_file_and_wrote_another_flags_only_the_unbacked_write():
    reply = "I read config.yaml and wrote output.json from it."
    spans = [tool_span("workspace_read_file", path="config.yaml")]  # no write span
    correction = guards.narration_check(reply, spans)
    assert correction is not None
    assert kinds(correction) == ["wrote_file"]
    assert targets(correction) == ["output.json"]


# -- the matcher never raises (chat.py fails open, but the guard is robust) --


@pytest.mark.parametrize(
    "reply",
    [
        "I created \\((((.md and [unbalanced",
        "wrote " + "a." * 300 + "md",
        "创建了 groceries.md 文件",  # non-ascii around a real token
        "\n\n\n",
        "contains contains contains .md .md",
    ],
)
def test_the_matcher_never_raises_on_odd_input(reply):
    # We do not care about the verdict here — only that it returns cleanly.
    guards.narration_check(reply, [])


# -- the deferral guard: a promised tool action that never ran -------------
#
# guards.deferral_check(reply, spans, available_tools) is pure and precision-
# first, the mirror of narration_check (a fabricated COMPLETED action) for a
# PROMISED FUTURE action that never ran. As with the other guards, the
# must-NOT-fire cases are as load-bearing as the fabrications: a wrongly-
# corrected honest reply would make the guard the liar. The live registry is
# used so a phrase counts only when its satisfying tool is actually available.

from app import tools as _tools  # noqa: E402  (kept beside the deferral suite)

DEFERRAL_TOOLS = _tools.tool_names()  # the real registry: has web_search + fetch_url


def deferred(correction) -> str | None:
    return correction.tool if correction is not None else None


# MUST FIRE: a first-person future commitment to a registered tool action, with
# no successful span of that tool this turn. The owner's exact case leads.
DEFERRAL_MUST_FIRE = [
    # The S9 walk (2026-09-07 15:16 UTC): "remind me every 5 minutes to blink"
    # → this exact reply, ZERO tool calls, no guard fired. A promise to remind
    # can only be kept by a timer row, so with no create_timer span it is a
    # deferral in every sense the owner cares about.
    (
        "owner_reminder_hollow_promise",
        "Done — I'll nudge you to blink every 5 minutes. It'll pop up here in this chat "
        "and as a device notification each time.",
        "create_timer",
    ),
    ("ill_remind_you_at", "I'll remind you at 7 tomorrow morning.", "create_timer"),
    ("let_me_set_a_timer", "Let me set a timer for that.", "create_timer"),
    ("owner_web_search", "I'll perform a web search for the latest Pixel news.", "web_search"),
    ("ill_search", "I'll search for the latest on that.", "web_search"),
    ("let_me_look_it_up", "Let me look it up.", "web_search"),
    ("going_to_check_the_web", "I'm going to check the web.", "web_search"),
    ("i_can_now_search", "I can now search online for you.", "web_search"),
    ("let_me_google", "Let me google that.", "web_search"),
    ("ill_fetch_that_page", "I'll fetch that page.", "fetch_url"),
    ("let_me_pull_up_the_site", "Let me pull up the website.", "fetch_url"),
    ("ill_retrieve_a_url", "I'll retrieve https://example.com/data.", "fetch_url"),
    ("going_to_read_the_page", "I'm going to read the page at that link.", "fetch_url"),
]


@pytest.mark.parametrize(
    "label,reply,tool", DEFERRAL_MUST_FIRE, ids=[c[0] for c in DEFERRAL_MUST_FIRE]
)
def test_deferral_must_fire_when_the_tool_never_ran(label, reply, tool):
    correction = guards.deferral_check(reply, [other_span()], DEFERRAL_TOOLS)
    assert correction is not None, f"{label!r} should have fired but did not"
    assert deferred(correction) == tool


# MUST NOT FIRE (the COMMITMENT shape, no instruction in hand): a non-tool
# "action", a past/negated/other-subject form, a promise about an unmapped tool
# (memory / workspace read), and the guard's own honest-note / note text. The
# five offer/question pins that used to lead this list ("Would you like me to
# search for it?", "Should I look it up?", "Want me to check the web?", "I can
# search if you'd like.", "I can now search if you want me to.") moved to
# OFFER_MUST_FIRE below on the owner's ruling of 2026-09-03: behind an
# instruction to do that very thing they are the instruction handed back, not
# an offer — and with NO instruction behind them they are still clean, pinned
# there as OFFER_GENUINE_WITHOUT_INSTRUCTION.
DEFERRAL_MUST_NOT_FIRE = [
    # Reminder-class near-misses: recall is memory, not a timer; a negated or
    # conditional promise commits to nothing; an offer is the offer shape's.
    ("remind_you_what_recall", "I'll remind you what we discussed yesterday: the deadline."),
    ("wont_remind_again", "I won't remind you again unless you ask."),
    ("remind_offer_conditional", "I can remind you of the details if you'd like."),
    # a non-tool "action" — the verb maps to no registered tool
    ("let_me_think", "Let me think about that."),
    ("keep_in_mind", "I'll keep that in mind."),
    ("let_me_explain", "Let me explain how it works."),
    ("get_back_to_you", "I'll get back to you shortly."),
    # past / other-subject / negation
    ("past_couldnt", "I couldn't search for it."),
    ("other_subject_you", "You can search for it yourself."),
    ("negation_wont", "I won't search for that."),
    ("negation_will_not", "I will not search the web for that."),
    ("negation_without", "I'll answer without searching the web."),
    # an unmapped tool: searching memory is memory_search, reading a file is a
    # workspace read — neither is a web_search / fetch_url deferral
    ("search_memory", "Let me search my memory for that."),
    ("read_the_file", "I'll read the file back to you."),
    # the guard's own frames must never trip it (self-reference)
    (
        "honest_note_web",
        "I said I'd search the web but couldn't complete it automatically — "
        "ask me again and I'll try.",
    ),
    (
        "honest_note_fetch",
        "I said I'd fetch that page but couldn't complete it automatically — "
        "ask me again and I'll try.",
    ),
    ("deferral_note", "Doing that now instead of just saying I would."),
    # a plain answer carries no commitment at all
    ("plain_answer", "The Pixel 10 has a 50-megapixel main camera."),
]


@pytest.mark.parametrize(
    "label,reply", DEFERRAL_MUST_NOT_FIRE, ids=[c[0] for c in DEFERRAL_MUST_NOT_FIRE]
)
def test_deferral_must_not_fire_on_honest_replies(label, reply):
    assert guards.deferral_check(reply, [other_span()], DEFERRAL_TOOLS) is None, (
        f"{label!r} was wrongly corrected — a false positive makes the guard the liar"
    )


def test_deferral_does_not_fire_when_the_tool_actually_ran():
    """The precision crux: the reply says 'let me search' AND a successful
    web_search span exists this turn, so it is an honest narration, not a
    deferral."""
    reply = "Let me search the web — here is what I found."
    spans = [tool_span("web_search")]
    assert guards.deferral_check(reply, spans, DEFERRAL_TOOLS) is None


# -- the COMPLETION shape (S9 walk 2026-09-07 15:2x UTC) ------------------------------
# After the commitment shape learned "I'll nudge you", the SAME request produced
# "Verified — your blink reminder is now running." — a present-tense claim that a
# timer exists, zero tool calls. A timer exists only as a row create_timer wrote.
COMPLETION_MUST_FIRE = [
    (
        "owner_verified_running",
        "Verified — your blink reminder is now running. It'll fire every 5 minutes (next "
        "one in a couple of minutes) and land here in chat plus as a notification on your "
        "connected devices.",
    ),
    ("ive_set_a_reminder", "I've set a reminder for 7am tomorrow."),
    ("i_set_up_the_timer", "I set up the daily timer for you."),
    ("reminder_set_head", "Reminder set for 11:14 EDT — it will land here."),
    ("timer_has_been_added", "The timer has been added and is live."),
]
COMPLETION_MUST_NOT_FIRE = [
    ("no_reminder_is_set", "No reminder is set right now."),
    ("isnt_running", "Your reminder isn't running any more."),
    ("not_set_yet", "The timer is not set yet."),
    ("second_person_can", "You can set a reminder by asking me to remind you."),
    ("question", "Should I set a reminder for that?"),
    ("quoted_relay", 'You said "the reminder is set" — I have no record of that.'),
    ("couldnt_set", "I couldn't set the reminder — the time you gave has already passed."),
    ("unrelated_running", "The build is now running on your laptop."),
]


@pytest.mark.parametrize(
    "label,reply", COMPLETION_MUST_FIRE, ids=[c[0] for c in COMPLETION_MUST_FIRE]
)
def test_a_timer_completion_claim_with_no_timer_span_is_a_deferral(label, reply):
    claim = guards.deferral_check(reply, [other_span()], DEFERRAL_TOOLS)
    assert claim is not None, f"{label!r} claims a timer exists and nothing wrote one"
    assert claim.kind == "completion" and claim.tool == "create_timer"


@pytest.mark.parametrize(
    "label,reply", COMPLETION_MUST_NOT_FIRE, ids=[c[0] for c in COMPLETION_MUST_NOT_FIRE]
)
def test_a_timer_completion_near_miss_stays_quiet(label, reply):
    assert guards.deferral_check(reply, [other_span()], DEFERRAL_TOOLS) is None, (
        f"{label!r} was wrongly corrected — a false positive makes the guard the liar"
    )


@pytest.mark.parametrize("backing", ["create_timer", "list_timers", "cancel_timer"])
def test_a_timer_completion_claim_is_backed_by_any_successful_timer_tool(backing):
    reply = COMPLETION_MUST_FIRE[0][1]
    assert guards.deferral_check(reply, [tool_span(backing)], DEFERRAL_TOOLS) is None
    failed = guards.deferral_check(reply, [tool_span(backing, ok=False)], DEFERRAL_TOOLS)
    assert failed is not None and failed.kind == "completion"


def test_the_post_creation_confirmation_is_honest_only_with_the_row_behind_it():
    """Moved out of OFFER_MUST_NOT_FIRE on 2026-09-07: "Reminder set for …" after
    "remind me in two minutes" was pinned quiet with no span. That is exactly the
    S9 walk's fabrication shape — the tool's own report words with no tool. With
    the create_timer span it is the honest confirmation it looks like."""
    instruction = "remind me in two minutes to stretch"
    reply = "Reminder set for Sat 6 Sep 2026 14:32 EDT (in 2 minutes)."
    backed = guards.deferral_check(
        reply, [tool_span("create_timer")], DEFERRAL_TOOLS, user_message=instruction
    )
    assert backed is None
    unbacked = guards.deferral_check(
        reply, [other_span()], DEFERRAL_TOOLS, user_message=instruction
    )
    assert unbacked is not None and unbacked.kind == "completion"


def test_a_timer_completion_claim_needs_create_timer_registered():
    """Derived from the live registry: an instance without timer tools has
    nothing to claim about, so the shape is inert there."""
    reply = COMPLETION_MUST_FIRE[0][1]
    without = [name for name in DEFERRAL_TOOLS if not name.endswith(("_timer", "_timers"))]
    assert guards.deferral_check(reply, [other_span()], without) is None


def test_a_reminder_promise_backed_by_a_create_timer_span_is_honest():
    """The S9 walk's reply with the row actually written: "Done — I'll nudge
    you…" after a successful create_timer is a true report of a timer that
    exists, and the guard stays silent. Without the span (DEFERRAL_MUST_FIRE)
    the same words are a hollow promise."""
    reply = (
        "Done — I'll nudge you to blink every 5 minutes. It'll pop up here in this chat "
        "and as a device notification each time."
    )
    assert guards.deferral_check(reply, [tool_span("create_timer")], DEFERRAL_TOOLS) is None
    claim = guards.deferral_check(reply, [tool_span("create_timer", ok=False)], DEFERRAL_TOOLS)
    assert claim is not None and claim.tool == "create_timer" and claim.kind == "commitment"


def test_deferral_fires_when_the_matching_span_failed():
    """A web_search that FAILED (ok=false) did not do the thing, so a promise to
    search is still an unkept one."""
    reply = "Let me search the web for the latest."
    spans = [tool_span("web_search", ok=False)]
    assert guards.deferral_check(reply, spans, DEFERRAL_TOOLS) is not None


def test_deferral_needs_the_right_tool_span():
    """A fetch_url that ran does not back a promise to SEARCH — the span must be
    of the tool the commitment maps to."""
    reply = "I'll search for the latest news."
    spans = [tool_span("fetch_url", url="https://example.com")]
    assert guards.deferral_check(reply, spans, DEFERRAL_TOOLS) is not None


def test_the_deferral_verdict_is_derived_from_the_live_registry():
    """The same 'I'll search' is a deferral only when web_search is registered —
    the derived-not-hardcoded property (CLAUDE.md): the verdict flips on the tool
    set alone."""
    reply = "I'll search for the latest on that."
    fired = guards.deferral_check(reply, [other_span()], ["web_search"])
    assert fired is not None and deferred(fired) == "web_search"
    # web_search not in the set -> the promise is not one this guard maps.
    assert guards.deferral_check(reply, [other_span()], ["fetch_url"]) is None
    assert guards.deferral_check(reply, [other_span()], []) is None


def test_the_fetch_deferral_verdict_is_derived_from_the_live_registry():
    reply = "I'll fetch that page for you."
    fired = guards.deferral_check(reply, [other_span()], ["fetch_url"])
    assert fired is not None and deferred(fired) == "fetch_url"
    assert guards.deferral_check(reply, [other_span()], ["web_search"]) is None


def test_deferral_is_pure_same_inputs_same_verdict():
    reply = "I'll search for the latest on that."
    spans = [other_span()]
    first = guards.deferral_check(reply, spans, DEFERRAL_TOOLS)
    second = guards.deferral_check(reply, spans, DEFERRAL_TOOLS)
    assert (first is None) == (second is None)
    assert first is not None
    assert deferred(first) == deferred(second)


def test_an_empty_reply_is_never_a_deferral():
    assert guards.deferral_check("", [other_span()], DEFERRAL_TOOLS) is None
    assert guards.deferral_check("   \n ", [other_span()], DEFERRAL_TOOLS) is None


@pytest.mark.parametrize(
    "reply",
    [
        "I'll \\((((search and [unbalanced",
        "search search search",
        "创建 web search 文件",  # non-ascii around a real phrase
        "\n\n\n",
        "I'll search " + "web " * 200,
    ],
)
def test_the_deferral_matcher_never_raises_on_odd_input(reply):
    # We do not care about the verdict here — only that it returns cleanly.
    guards.deferral_check(reply, [], DEFERRAL_TOOLS)


# -- the deferral guard's OFFER shape: the instruction handed back -----------
#
# Owner ruling 2026-09-03 (docs/plans/rebuild/no-approvals.md): there is no
# approval step in v4, and he rejects per-command friction. An OFFER that
# restates the action the user just instructed — "Want me to search the web
# for that?" after "check the web for the latest pixel phone" — is not a
# question he can answer with a click; it is the instruction handed back, and
# deferral_check(reply, spans, tools, user_message=...) now fires on it (kind
# "offer"). A GENUINE CLARIFYING QUESTION — which folder, which device, full
# tree or top level, which of two tools — asks for a detail she is missing and
# stays clean, as does an offer with no instruction behind it and an offer of
# something OTHER than what was asked. As everywhere in this family the
# must-NOT-fire pins are the load-bearing half: a guard that fires on an honest
# clarifying question would be the friction it exists to remove.

WEB_INSTRUCTION = "check the web for the latest pixel phone"


def offered(claim) -> tuple[str, str] | None:
    return (claim.kind, claim.tool) if claim is not None else None


# MUST FIRE: (instruction, reply, tool) — the ruling's four exact pins lead,
# then the five offer/question pins that DEFERRAL_MUST_NOT_FIRE used to hold,
# each behind the instruction it hands back.
OFFER_MUST_FIRE = [
    ("ruling_web", WEB_INSTRUCTION, "Want me to search the web for that?", "web_search"),
    (
        "ruling_list",
        "list my workspace files",
        "I can list them if you'd like.",
        "workspace_list_files",
    ),
    (
        "ruling_device",
        "how much disk is free on the dell?",
        "Should I check the disk usage on the Dell?",
        "device_info",
    ),
    (
        "ruling_read",
        "read config.json",
        "Would you like me to open config.json?",
        "workspace_read_file",
    ),
    # the five flipped pins (formerly DEFERRAL_MUST_NOT_FIRE's offer/question set)
    (
        "flipped_would_you_like",
        WEB_INSTRUCTION,
        "Would you like me to search for it?",
        "web_search",
    ),
    ("flipped_should_i", WEB_INSTRUCTION, "Should I look it up?", "web_search"),
    ("flipped_want_me_to", WEB_INSTRUCTION, "Want me to check the web?", "web_search"),
    ("flipped_if_youd_like", WEB_INSTRUCTION, "I can search if you'd like.", "web_search"),
    (
        "flipped_now_if_you_want",
        WEB_INSTRUCTION,
        "I can now search if you want me to.",
        "web_search",
    ),
    # the offer buried in otherwise-plausible prose is still the offer
    (
        "offer_after_stale_answer",
        WEB_INSTRUCTION,
        "The Pixel 9 launched last year. Want me to check the web for the newest one?",
        "web_search",
    ),
    # a consent-gated commitment IS an offer ("if you want" gates nothing)
    (
        "ill_if_you_want",
        "how much disk is free on the dell?",
        "I'll check that if you want.",
        "device_info",
    ),
    (
        "could_if_you_want",
        "how much disk is free on the dell?",
        "I could check that if you want.",
        "device_info",
    ),
    # "check the workspace" restates a listing instruction
    (
        "would_you_like_check_workspace",
        "show me my workspace directory structure",
        "Would you like me to check the workspace?",
        "workspace_list_files",
    ),
    ("run_it", "run df -h on the dell", "Should I run it now?", "device_run"),
    (
        "yes_i_can_want_me_to",
        "can you search the web for pixel news?",
        "Yes — want me to search now?",
        "web_search",
    ),
    (
        "let_me_know_if",
        "read config.json",
        "Let me know if you want me to open it.",
        "workspace_read_file",
    ),
    # a negated first clause does not hide the offer that follows it
    (
        "cant_find_then_offer",
        WEB_INSTRUCTION,
        "I can't find it in my notes, want me to search the web?",
        "web_search",
    ),
    (
        "do_you_want_me_to",
        "read config.json",
        "Do you want me to open config.json?",
        "workspace_read_file",
    ),
    (
        "whenever_you_want_me_to",
        WEB_INSTRUCTION,
        "Whenever you want me to search the web, just say.",
        "web_search",
    ),
    # the STATEMENT form — no question mark, no offer marker — is the same
    # instruction handed back (review of the offer shape, 2026-09-04)
    ("statement_i_can", WEB_INSTRUCTION, "I can search the web for that.", "web_search"),
    (
        "statement_i_could_for_you",
        "list my workspace files",
        "I could list them for you.",
        "workspace_list_files",
    ),
    (
        "statement_happy_to_say_the_word",
        WEB_INSTRUCTION,
        "I'd be happy to search the web for that — just say the word.",
        "web_search",
    ),
    (
        "statement_happy_to_whenever",
        "read config.json",
        "Happy to open config.json whenever you're ready.",
        "workspace_read_file",
    ),
    (
        "statement_if_that_helps",
        "read config.json",
        "I can read config.json if that helps.",
        "workspace_read_file",
    ),
    # "how about I" / "what if I" are offers, not wh-questions
    ("how_about_i", WEB_INSTRUCTION, "How about I search the web for that?", "web_search"),
    ("what_if_i", WEB_INSTRUCTION, "What if I search the web for you?", "web_search"),
    # a CLOSED quote pair before the lead is her own sentence, not a relay
    (
        "closed_backticks_before_lead",
        "read config.json",
        "I found `config.json` — want me to open it?",
        "workspace_read_file",
    ),
    (
        "closed_curly_quotes_before_lead",
        "how much disk is free on the dell?",
        "Your note says “disk” — should I check the disk usage?",
        "device_info",
    ),
    # a scope question that ALSO offers the instructed action fires, by the
    # ruling's own definition; the bare scope question is pinned clean below
    (
        "scope_question_offering_the_action",
        "list my workspace files",
        "Do you want me to list hidden files too?",
        "workspace_list_files",
    ),
    # the user side reads EVERY match of the phrase: a self-report of the action
    # ahead of the real request does not hide it (confirmation review, 2026-09-04)
    (
        "self_report_then_request",
        "I read config.json and it looks wrong — can you read config.json again?",
        "Want me to open it?",
        "workspace_read_file",
    ),
    # a request verb on his own subject keeps the request ("we should", "I said")
    (
        "we_should_check_the_web",
        "we should check the web for the latest pixel",
        "Want me to search the web?",
        "web_search",
    ),
    (
        "i_said_search_the_web",
        "I said search the web for the latest pixel",
        "Want me to search the web?",
        "web_search",
    ),
    # "in my notes" past a coordinator belongs to the NEXT action, not the search
    (
        "search_web_and_save_in_notes",
        "search the web for the latest pixel and save it in my notes",
        "Want me to search the web?",
        "web_search",
    ),
    # S9: "remind me…" is an instruction create_timer performs; asking whether
    # to set it is the instruction handed back (the plan's named example).
    (
        "s9_remind_me_want_me_to",
        "remind me in two minutes to stretch",
        "Want me to set a reminder?",
        "create_timer",
    ),
    (
        "s9_remind_me_should_i",
        "remind me in two minutes to stretch",
        "Should I remind you in two minutes?",
        "create_timer",
    ),
    (
        "s9_set_a_reminder_statement_offer",
        "set a reminder for 7am tomorrow",
        "I can set that up if you'd like.",
        "create_timer",
    ),
    (
        "s9_schedule_restated",
        "every day at 7 schedule a summary of my calendar",
        "Want me to schedule that?",
        "create_timer",
    ),
    (
        # B (review fix round 2, comment corrected round 3): the brief's row,
        # restored verbatim on both sides — spec §8's own example wins over
        # round 1's narrowing. The reply is broad (_SETUP_QR_OFFER: any offer
        # to show/make/send/give/generate/display a QR code or a setup/
        # pairing card). The INSTRUCTION fires through leg (2) of
        # _SETUP_QR_INSTRUCTS (guards.py ~2317-2325) — the bare "QR code"
        # mention ITSELF, matched only because a "put you on a device" phrase
        # follows later in the same clause — never through the anchored "put
        # you on my phone" phrase (leg 3) directly: that match starts at
        # "put", and "so I can " sits immediately before it, which IS
        # _USER_SELF_REPORT's own shape (a subject pronoun plus one trailing
        # word before the cut) and WOULD be excluded if leg 3's match were
        # what _instructed_classes read. Leg (2)'s match is the earlier "QR
        # code" mention, so `before` is "show me a " — nothing self-report
        # shaped — and the self-report check never has anything to catch.
        "s47_setup_qr",
        "show me a QR code so I can put you on my phone",
        "Want me to show you a QR code for your phone?",
        "show_setup_qr",
    ),
    (
        "s47_setup_qr_qualified_instruction",
        "show me a setup QR code for my phone",
        "Want me to show you a QR code for your phone?",
        "show_setup_qr",
    ),
    (
        "s47_put_nova_on_my_phone",
        "put Nova on my phone",
        "Want me to show you a setup QR code?",
        "show_setup_qr",
    ),
    (
        # B (review fix round 3): a bare "QR code for|of|to <X>" counts
        # UNCONDITIONALLY when X is a qualifying object — here, "my phone" is
        # a device word — with no put-phrase needed anywhere in the message.
        "s47_qr_code_for_my_phone",
        "show me a QR code for my phone",
        "Want me to show you a QR code for your phone?",
        "show_setup_qr",
    ),
    (
        # B (review fix round 4): X is the WHOLE noun phrase after "for|of|to"
        # and its HEAD (last) noun decides — "my new phone" is headed by
        # "phone", with an adjective in front of it.
        "s47_qr_code_for_my_new_phone",
        "show me a QR code for my new phone",
        "Want me to show you a QR code for your new phone?",
        "show_setup_qr",
    ),
    # B (review fix round 5): X is a closed grammar — [determiner] [closed
    # modifiers] HEAD [model number] BOUNDARY — and the boundary after the
    # head may be a preposition, a conjunction or complementizer, a trailer
    # (please/now/too/again/real/quickly), or any non-letter character; the
    # heads include Nova/you/yourself/setup/pairing again.
    (
        "s47_qr_for_my_phone_to_scan",
        "show me a QR code for my phone to scan",
        "Want me to show you a QR code for your phone?",
        "show_setup_qr",
    ),
    (
        "s47_qr_for_my_phone_that_i_can_scan",
        "show me a QR code for my phone that I can scan",
        "Want me to show you a QR code for your phone?",
        "show_setup_qr",
    ),
    (
        "s47_qr_for_my_phone_real_quick",
        "show me a QR code for my phone real quick",
        "Want me to show you a QR code for your phone?",
        "show_setup_qr",
    ),
    (
        "s47_qr_for_my_phone_double_dash",
        "show me a QR code for my phone -- thanks",
        "Want me to show you a QR code for your phone?",
        "show_setup_qr",
    ),
    (
        "s47_qr_for_my_phone_slash_tablet",
        "show me a QR code for my phone/tablet",
        "Want me to show you a QR code for your phone?",
        "show_setup_qr",
    ),
    (
        "s47_qr_for_my_iphone_15",
        "show me a QR code for my iPhone 15",
        "Want me to show you a QR code for your iPhone 15?",
        "show_setup_qr",
    ),
    (
        "s47_qr_for_my_phone_ellipsis",
        "show me a QR code for my phone…",
        "Want me to show you a QR code for your phone?",
        "show_setup_qr",
    ),
    (
        "s47_qr_for_my_phone_emoji",
        "show me a QR code for my phone \U0001f642",
        "Want me to show you a QR code for your phone?",
        "show_setup_qr",
    ),
    (
        "s47_qr_for_the_phone_on_my_desk",
        "show me a QR code for the phone on my desk",
        "Want me to show you a QR code for the phone on your desk?",
        "show_setup_qr",
    ),
    (
        "s47_qr_for_nova",
        "show me a QR code for Nova",
        "Want me to show you a QR code for Nova?",
        "show_setup_qr",
    ),
    (
        "s47_qr_for_you",
        "give me a QR code for you",
        "Want me to give you a QR code?",
        "show_setup_qr",
    ),
    (
        "s47_qr_for_setup",
        "show me a QR code for setup",
        "Want me to show you a QR code for setup?",
        "show_setup_qr",
    ),
]


@pytest.mark.parametrize(
    "label,instruction,reply,tool", OFFER_MUST_FIRE, ids=[c[0] for c in OFFER_MUST_FIRE]
)
def test_an_offer_restating_the_instruction_is_a_deferral(label, instruction, reply, tool):
    claim = guards.deferral_check(reply, [other_span()], DEFERRAL_TOOLS, user_message=instruction)
    assert claim is not None, f"{label!r} handed the instruction back and was not caught"
    assert offered(claim) == ("offer", tool)
    assert claim.action_phrase and claim.phrase


# MUST NOT FIRE: (instruction, reply) — a clarifying question (a missing
# parameter, a scope choice, which of two tools), an offer of something
# DIFFERENT, casual chat, a negated or past-tense instruction, a relayed offer.
OFFER_MUST_NOT_FIRE = [
    # a missing PARAMETER: which folder / which device / which of two things
    (
        "which_directory",
        "list my workspace files",
        "Which directory should I list — the project or your home?",
    ),
    (
        "full_tree_or_top_level",
        "list my workspace files",
        "Do you want the full tree or just the top level?",
    ),
    ("dell_or_laptop", "how much disk is free on the dell?", "Do you mean the Dell or the laptop?"),
    ("web_or_notes", "look up the pixel news", "Search the web or your notes?"),
    ("what_to_list", "list my workspace files", "What would you like me to list?"),
    # an accepted KNOWN MISS, not a clarifying question: the instruction handed
    # back beside a non-tool alternative. The blanket "or" cut cannot tell it
    # from "the web or your notes?" without reading the alternative, and a
    # clarifying question wrongly corrected is the worse failure — so it stays
    # clean, deliberately. ("Want me to search the web for that, or is that
    # not needed?" is the same known miss.)
    (
        "search_or_answer",
        WEB_INSTRUCTION,
        "Would you like me to search for it, or answer from what I know?",
    ),
    # a scope question with NO offered action in it (the same scope question
    # that also offers the listing is pinned as a fire above)
    ("include_hidden", "list my workspace files", "Do you want me to include hidden files?"),
    ("include_subdirs", "list my workspace files", "Should I include subdirectories?"),
    # the instruction RESTATED ("you want me to…") ahead of a clarifier is not
    # an offer, with or without a question mark on the sentence
    (
        "restated_then_which",
        WEB_INSTRUCTION,
        "Got it — you want me to check the web for the latest Pixel. Which region?",
    ),
    (
        "restated_then_scope",
        "list my workspace files",
        "Understood, you want me to list the workspace files. Top level or full tree?",
    ),
    (
        "restated_but_missing",
        "read config.json",
        "I understand you want me to read config.json, but it doesn't exist. "
        "Do you mean config.yaml?",
    ),
    (
        "restated_dash_which",
        WEB_INSTRUCTION,
        "You want me to check the web for the latest Pixel — which region?",
    ),
    # a statement that is not an offer: negated, or a hypothetical that cannot
    ("statement_cant", "read config.json", "I can't read config.json — it isn't in the workspace."),
    ("what_if_i_cant", WEB_INSTRUCTION, "What if I can't find it?"),
    # "without" between the lead and the action negates it: an answer that says
    # it did NOT search hands nothing back (confirmation review, 2026-09-04)
    (
        "statement_without_searching",
        WEB_INSTRUCTION,
        "I can tell you the Pixel 10 launched in August without searching the web.",
    ),
    (
        "statement_answer_without",
        WEB_INSTRUCTION,
        "I can answer that without searching the web: the Pixel 10 launched in August.",
    ),
    # an offer of something DIFFERENT from what was asked
    ("extra_summarise", "read config.json", "Done. Want me to also summarise it?"),
    (
        "different_class",
        "read config.json",
        "It's not in the workspace. Want me to search the web for a sample config?",
    ),
    ("different_object", "how much disk is free on the dell?", "Should I check your calendar?"),
    # casual chat, no instruction at all
    ("joke", "tell me something funny", "Want to hear a joke?"),
    ("unprompted_offer", "what do you think about the pixel?", "Want me to look up the pixel?"),
    # a negated or past-tense "instruction" instructs nothing
    (
        "dont_search",
        "don't search the web, just tell me what you know",
        "Want me to search the web anyway?",
    ),
    ("did_you_search", "did you search the web?", "No — want me to search now?"),
    ("no_searching_please", "No searching please, just answer", "Want me to search anyway?"),
    # a MENTION of the action is not an instruction: his own report of doing
    # it, a search in his notes (memory, not the web), a device resource in a
    # statement that asks nothing
    (
        "user_reports_reading",
        "I read config.json and it looks wrong",
        "Want me to open it and take a look?",
    ),
    (
        "user_reports_searching",
        "I've been searching the web all day for this",
        "Want me to search too?",
    ),
    (
        "user_disk_statement",
        "my disk usage on the dell has been high lately",
        "Should I check it now?",
    ),
    # the accepted KNOWN MISS on that cut: a terse resource name with no
    # question mark and no request word states, so it instructs nothing
    ("user_terse_resource", "dell disk usage", "Should I check the disk usage on the Dell?"),
    # a second verb coordinated with his report is still his report, whether or
    # not the first verb is itself an action the table knows
    (
        "user_reports_coordinated",
        "I listed the files and read config.json, both look wrong",
        "Want me to read it?",
    ),
    (
        "user_reports_two_reads",
        "I read config.json and read the logs",
        "Want me to open them?",
    ),
    (
        "user_search_notes",
        "search for the pixel in my notes",
        "Want me to search the web instead?",
    ),
    # relayed, not made
    (
        "relayed_you_said",
        "how much disk is free on the dell?",
        "You said: should I check the disk usage?",
    ),
    ("relayed_unclosed_quote", "read config.json", 'Your note says "want me to open it?'),
    # the guard family's own frames, with the instruction in hand
    ("deferral_note", WEB_INSTRUCTION, "Doing that now instead of just saying I would."),
    (
        "honest_note_web",
        WEB_INSTRUCTION,
        "I said I'd search the web but couldn't complete it automatically — "
        "ask me again and I'll try.",
    ),
    (
        "offer_honest_note",
        WEB_INSTRUCTION,
        "I asked instead of doing it — there is no approval step. I did not search the web "
        "this turn; ask me again and I'll try.",
    ),
    ("plain_answer", WEB_INSTRUCTION, "The Pixel 10 has a 50-megapixel main camera."),
    # S9 near-misses: a missing parameter or a scope choice is hers to ask; a
    # negated instruction, a figurative "reminds me" and a calendar question
    # instruct no timer; a confirmation after the fact offers nothing.
    (
        "s9_which_device",
        "remind me in two minutes to stretch",
        "Which device should I notify — the desktop or the laptop?",
    ),
    (
        "s9_chat_or_notification",
        "remind me in two minutes to stretch",
        "Do you want it in chat or as a desktop notification?",
    ),
    ("s9_negated_instruction", "don't remind me about the dentist", "Want me to set a reminder?"),
    ("s9_that_reminds_me", "that reminds me, what's the weather?", "Want me to set a reminder?"),
    ("s9_calendar_question", "what's on my schedule today?", "Want me to set a reminder?"),
    # "remind me what…" asks for RECALL, not a timer: an offer to look it up
    # is a genuine offer, never a create_timer instruction handed back.
    (
        "s9_recall_is_not_a_timer",
        "can you remind me what we discussed yesterday?",
        "I can remind you of the details if you'd like — should I search my notes?",
    ),
    (
        "s9_recall_of_is_not_a_timer",
        "remind me of what I said about the garage",
        "Want me to set a reminder?",
    ),
    # I3 (review fix round 1): a QR code for something else entirely (a wifi
    # password, not a setup/pairing card) never instructs show_setup_qr.
    (
        "s47_wifi_qr_is_not_setup_qr",
        "make me a QR code for my wifi password",
        "Want me to show you a QR code?",
    ),
    # B (review fix round 2): "put <anything else> on <device>" is not Nova
    # herself, and a QR code with no device context at all is not hers either.
    (
        "s47_put_someone_elses_calendar",
        "can you put my calendar on my phone?",
        "Want me to show you a QR code for your phone?",
    ),
    (
        "s47_put_the_shopping_list",
        "put the shopping list on my phone",
        "Want me to show you a QR code for your phone?",
    ),
    (
        "s47_put_the_playlist",
        "put the playlist on my tablet please",
        "Want me to show you a QR code for your phone?",
    ),
    (
        "s47_link_not_qr",
        "send me the link, not a QR code",
        "Want me to show you a QR code for your phone?",
    ),
    (
        "s47_qr_for_wifi_reply_form",
        "make a QR code for my wifi",
        "Want me to show you a QR code for your phone?",
    ),
    # B (review fix round 3): a bare "QR code" disqualifies itself when its
    # OWN "for|of|to <X>" phrase names something else — REGARDLESS of a later
    # put-phrase in the same clause (that "put" match is excluded anyway, on
    # its own, by _USER_SELF_REPORT's "so I can").
    (
        "s47_qr_for_wifi_then_put_you_on_phone",
        "make a QR code for my wifi so I can put you on my phone",
        "Want me to make a QR code for your wifi?",
    ),
    (
        "s47_qr_of_the_link_then_put_nova_on_tablet",
        "give me a QR code of the link so I can put Nova on my tablet",
        "Want me to give you a QR code of the link?",
    ),
    # B (review fix round 4): a device word that MODIFIES another noun is not
    # the head of X — the QR code is for the number, the wifi, the manual,
    # the listing.
    (
        "s47_qr_for_my_phone_number",
        "make a QR code for my phone number",
        "Want me to make a QR code for your phone number?",
    ),
    (
        "s47_qr_for_my_phones_wifi",
        "make a QR code for my phone's wifi",
        "Want me to make a QR code for your phone's wifi?",
    ),
    (
        "s47_qr_for_the_device_manual",
        "give me a QR code for the device manual",
        "Want me to give you a QR code for the device manual?",
    ),
    (
        "s47_qr_to_my_android_app_listing",
        "make a QR code to my Android app listing",
        "Want me to make a QR code to your Android app listing?",
    ),
    # B (review fix round 5): X's closed grammar admits no verb before the
    # head (a QR code that calls or texts a phone is not the phone's), and
    # "machine" is no head for this rule (a washing machine is not a device
    # she runs on).
    (
        "s47_qr_to_call_my_phone",
        "make a QR code to call my phone",
        "Want me to make a QR code to call your phone?",
    ),
    (
        "s47_qr_to_text_my_phone",
        "make a QR code to text my phone",
        "Want me to make a QR code to text your phone?",
    ),
    (
        "s47_qr_to_unlock_my_phone",
        "make a QR code to unlock my phone",
        "Want me to make a QR code to unlock your phone?",
    ),
    (
        "s47_qr_to_find_my_phone",
        "make a QR code to find my phone",
        "Want me to make a QR code to find your phone?",
    ),
    (
        "s47_qr_for_the_washing_machine",
        "make a QR code for the washing machine",
        "Want me to make a QR code for the washing machine?",
    ),
    (
        "s47_qr_for_a_coffee_machine",
        "make a QR code for a coffee machine",
        "Want me to make a QR code for a coffee machine?",
    ),
    (
        "s47_qr_for_the_vending_machine",
        "make a QR code for the vending machine",
        "Want me to make a QR code for the vending machine?",
    ),
    # S42b: which machine first is a parameter she is missing — hers to ask.
    (
        "s42b_update_which_machine",
        "update my agents",
        "Which machine's agent should I update first — minipc or the laptop?",
    ),
    # S42b (Task 23 controller rulings): an update offered back is NOT an offer
    # class. The class would read his message ("update minipc's agent") to
    # decide, and its redirect would regenerate with machine_update advertised
    # and "do it now" — an agent restart, and the cancel of what runs there,
    # pushed by a phrase match. Neither is allowed: no phrase matcher on the
    # owner's message, and no redirect may push an action.
    (
        "s42b_update_offer_is_not_judged_against_his_message",
        "update minipc's agent",
        "Want me to update minipc's agent now?",
    ),
]


@pytest.mark.parametrize(
    "label,instruction,reply", OFFER_MUST_NOT_FIRE, ids=[c[0] for c in OFFER_MUST_NOT_FIRE]
)
def test_a_clarifying_question_or_genuine_offer_is_not_a_deferral(label, instruction, reply):
    assert (
        guards.deferral_check(reply, [other_span()], DEFERRAL_TOOLS, user_message=instruction)
        is None
    ), f"{label!r} was wrongly corrected — a false positive makes the guard the liar"


# With NO instruction behind them, the five flipped pins are exactly what they
# look like — a genuine offer — and the offer shape is inert (no user_message).
OFFER_GENUINE_WITHOUT_INSTRUCTION = [
    "Would you like me to search for it?",
    "Should I look it up?",
    "Want me to check the web?",
    "I can search if you'd like.",
    "I can now search if you want me to.",
]


@pytest.mark.parametrize("reply", OFFER_GENUINE_WITHOUT_INSTRUCTION)
def test_an_offer_with_no_instruction_behind_it_is_genuine(reply):
    assert guards.deferral_check(reply, [other_span()], DEFERRAL_TOOLS) is None
    assert guards.deferral_check(reply, [other_span()], DEFERRAL_TOOLS, user_message="") is None
    assert (
        guards.deferral_check(
            reply, [other_span()], DEFERRAL_TOOLS, user_message="thanks, that's all"
        )
        is None
    )


def test_an_offer_after_the_instructed_action_ran_is_extra_work():
    """'After doing it' is read off the SPANS, never the word order: the same
    'Done. Want me to…' fires with nothing run and is clean once a span of the
    instructed class exists — successful or failed (a real attempt)."""
    reply = "Done — 12 files. Want me to also list the files in src/?"
    instruction = "list my workspace files"
    assert offered(
        guards.deferral_check(reply, [other_span()], DEFERRAL_TOOLS, user_message=instruction)
    ) == ("offer", "workspace_list_files")
    ran = [tool_span("workspace_list_files")]
    assert guards.deferral_check(reply, ran, DEFERRAL_TOOLS, user_message=instruction) is None
    tried = [tool_span("workspace_list_files", ok=False)]
    assert guards.deferral_check(reply, tried, DEFERRAL_TOOLS, user_message=instruction) is None
    retry = "The search failed. Should I search again?"
    assert (
        guards.deferral_check(
            retry, [tool_span("web_search", ok=False)], DEFERRAL_TOOLS, user_message=WEB_INSTRUCTION
        )
        is None
    )


def test_a_refused_call_is_not_an_attempt():
    """A call written as markup or made in a closed round is recorded as a
    tool span (ok=False, `refused_*` in its meta) so the trace shows it — but
    nothing ran, so 'want me to search?' behind it is still the instruction
    handed back (and the redirect can regenerate with tools). A real failed
    attempt (ok=False, no refusal flag) still clears the offer. Derived from
    the flag chat._refuse_call writes, not a list of reasons."""
    reply = "Want me to search the web for that?"

    def refused(flag: str):
        return SimpleNamespace(
            kind="tool", name="web_search", meta={"ok": False, "error": "x", flag: True}
        )

    for flag in ("refused_markup_as_text", "refused_out_of_rounds", "refused_redirect_closed"):
        claim = guards.deferral_check(
            reply, [refused(flag)], DEFERRAL_TOOLS, user_message=WEB_INSTRUCTION
        )
        assert offered(claim) == ("offer", "web_search"), flag
    failed = [tool_span("web_search", ok=False)]
    assert (
        guards.deferral_check(reply, failed, DEFERRAL_TOOLS, user_message=WEB_INSTRUCTION) is None
    )


def test_an_offer_beside_a_listing_the_backend_ran_is_extra_work():
    """S47 review fix round 4, item 1: a listing the BACKEND ran unasked (a
    live_facts check, `meta["unasked"] = True`) is a real listing that really
    ran this turn — the offer after it is about what comes next, exactly as
    after her own listing. The "not her call" exclusion lives only in
    chat._failed_tool_names (the capability relay); guards._attempted keeps
    its c54cd621 behaviour for the offer shape."""
    reply = "Here they are: a.md and b.md. Want me to list the files in the notes folder too?"
    backend_ran = SimpleNamespace(
        kind="tool",
        name="workspace_list_files",
        meta={"ok": True, "args_redacted": {}, "unasked": True},
    )
    assert (
        guards.deferral_check(
            reply, [backend_ran], DEFERRAL_TOOLS, user_message="list the files in my workspace"
        )
        is None
    )


def test_a_statement_form_offer_after_real_work_is_a_report():
    """The statement form ("I can/could…") reaches the offer verdict only
    while nothing ran successfully this turn: after real work the same words
    are a report of what she found, and the offer after work is caught in its
    question form by the span rule (precision-first — a report wrongly
    corrected makes the guard the liar)."""
    instruction = "read config.json"
    report = "I could see config.json in the listing."
    assert offered(
        guards.deferral_check(report, [other_span()], DEFERRAL_TOOLS, user_message=instruction)
    ) == ("offer", "workspace_read_file")
    listed = [tool_span("workspace_list_files")]
    assert guards.deferral_check(report, listed, DEFERRAL_TOOLS, user_message=instruction) is None
    # the question form after the same work still fires — the span rule reads
    # the INSTRUCTED class, and a listing is not a read
    ask = "config.json is there. Want me to open it?"
    assert offered(
        guards.deferral_check(ask, listed, DEFERRAL_TOOLS, user_message=instruction)
    ) == ("offer", "workspace_read_file")
    # a mixed clause keeps the commitment shape (judged first)
    mixed = "I can search the web, so I'll search the web now."
    assert offered(
        guards.deferral_check(mixed, [other_span()], DEFERRAL_TOOLS, user_message=WEB_INSTRUCTION)
    ) == ("commitment", "web_search")


def test_an_offer_after_some_other_tool_ran_still_fires():
    """Only a span of the INSTRUCTED class is the attempt that clears the
    offer; a memory search followed by 'want me to check the web?' is still
    the web instruction handed back (chat.py then refuses the redirect on its
    own tools-already-ran precondition and appends the note)."""
    reply = "I found a note from March. Want me to check the web for newer info?"
    claim = guards.deferral_check(
        reply, [tool_span("memory_search")], DEFERRAL_TOOLS, user_message=WEB_INSTRUCTION
    )
    assert offered(claim) == ("offer", "web_search")


def test_the_offer_verdict_is_derived_from_the_live_registry():
    """The derived-not-hardcoded property: the same instruction and offer are a
    deferral only while a tool of that class is registered, on BOTH sides."""
    instruction, reply = "list my workspace files", "I can list them if you'd like."
    assert offered(
        guards.deferral_check(reply, [], ["workspace_list_files"], user_message=instruction)
    ) == ("offer", "workspace_list_files")
    assert offered(
        guards.deferral_check(reply, [], ["device_list_files"], user_message=instruction)
    ) == ("offer", "device_list_files")
    assert guards.deferral_check(reply, [], ["web_search"], user_message=instruction) is None
    assert guards.deferral_check(reply, [], [], user_message=instruction) is None


def test_the_commitment_shape_is_unchanged_by_the_instruction():
    """A first-person commitment fires as before (kind 'commitment', no
    instruction needed), and the instruction does not widen it: a promise to
    read a file is still bare_intent's shape, not this guard's."""
    claim = guards.deferral_check(
        "I'll search for the latest on that.", [other_span()], DEFERRAL_TOOLS
    )
    assert offered(claim) == ("commitment", "web_search")
    with_instruction = guards.deferral_check(
        "I'll search for the latest on that.",
        [other_span()],
        DEFERRAL_TOOLS,
        user_message=WEB_INSTRUCTION,
    )
    assert offered(with_instruction) == ("commitment", "web_search")
    assert (
        guards.deferral_check(
            "I'll read the file back to you.",
            [other_span()],
            DEFERRAL_TOOLS,
            user_message="read config.json",
        )
        is None
    )


def test_the_offer_shape_is_pure_same_inputs_same_verdict():
    args = ("Want me to search the web for that?", [other_span()], DEFERRAL_TOOLS)
    first = guards.deferral_check(*args, user_message=WEB_INSTRUCTION)
    second = guards.deferral_check(*args, user_message=WEB_INSTRUCTION)
    assert first is not None and offered(first) == offered(second)
    assert first.phrase == second.phrase


@pytest.mark.parametrize(
    "instruction",
    [
        "check \\((((the web [unbalanced",
        "list list list",
        "读取 config.json 文件",
        "\n\n\n",
        "read " + "config.json " * 200,
        "",
    ],
)
def test_the_offer_matcher_never_raises_on_odd_instructions(instruction):
    guards.deferral_check(
        "Want me to search the web for that?", [], DEFERRAL_TOOLS, user_message=instruction
    )
    guards.deferral_check(
        "Should I open config.json?", [], DEFERRAL_TOOLS, user_message=instruction
    )


# -- the bare-intent guard: an acknowledgment with nothing behind it --------
#
# guards.bare_intent_check(reply, spans) is the sixth sibling — the same
# broken-promise family as deferral_check, for the shape deferral_check
# structurally cannot see: no first-person modal lead at all, just a bare
# present-progressive or a stock ack-and-go ("Checking…", "On it."). The real
# trace: user asked to see the workspace directory structure; the WHOLE reply
# was "Got it. Checking the workspace…" with zero tool calls, tools
# advertised, nothing wrong with the device. No existing guard caught it.

# MUST FIRE: the entire trimmed reply IS the intent phrase (an optional
# one-word ack, then a recognized lead, then only trailing punctuation) and no
# tool ran this turn at all. The owner's exact case leads.
BARE_INTENT_MUST_FIRE = [
    ("owner_exact", "Got it. Checking the workspace…"),
    ("checking_bare", "Checking the workspace..."),
    ("checking_no_object", "Checking..."),
    ("sure_on_it", "Sure. On it."),
    ("working_on_it", "Working on it."),
    ("one_moment", "One moment..."),
    ("one_sec", "One sec."),
    ("ill_get_right_on_that", "I'll get right on that."),
    ("let_me_look_it_up", "Let me look it up."),
    ("looking_that_up", "Looking that up..."),
    ("running_the_tests", "Running the tests…"),
    ("fetching_that_now", "Fetching that now…"),
    ("right_one_sec", "Right, one sec."),
    ("ok_let_me_find_that", "OK. Let me find that for you."),
    ("looking_into_it", "Looking into it…"),
    # A general first-person future commitment to a verb deferral_check does
    # not map to a tool — the owner's actual missed 15:06 reply, and the
    # adversarial review's other misses (I1, review of 70d7c54e).
    ("ill_check_the_disk_usage", "I'll check the disk usage for you."),
    ("ill_look_into_that", "I'll look into that."),
    ("em_dash_ack_running_now", "Sure — running that now."),
    ("im_on_it", "I'm on it."),
    ("on_it_with_address", "On it, boss."),
    ("i_will_look_into_it_now", "I will look into it now."),
    ("im_going_to_check_that", "I'm going to check that."),
    # A bare newline instead of a space between ack and lead must not inflate
    # the sentence count past the cap (M3, review of 70d7c54e) — the same
    # content as the owner's exact trace, just line-broken.
    ("newline_between_ack_and_lead", "Got it.\nChecking the workspace…"),
    # run/look/get narrowed to a command-shaped object must STILL fire on one
    # (re-review of 1f50b993, the idiom false-positive fix) — a pronoun, a
    # "the/a <task noun>", or a recognizable command token, with or without a
    # short trailing "now"/"for you".
    ("ill_run_that_now", "I'll run that now."),
    ("running_the_command_now", "Sure — running the command now."),
    ("ill_run_a_quick_check", "I'll run a quick check."),
    ("let_me_run_it", "Let me run it."),
    # A commitment gated on a consent that does not exist (owner ruling
    # 2026-09-03: v4 has no approval step, so "if you want" gates nothing) is
    # still an intent to act with nothing behind it. Formerly pinned clean as
    # "future_hedge_if_you_want" on the shared _OFFER_MARKER exemption, which
    # bare_intent no longer reads.
    ("future_if_you_want", "I'll check that if you want."),
]


@pytest.mark.parametrize(
    "label,reply", BARE_INTENT_MUST_FIRE, ids=[c[0] for c in BARE_INTENT_MUST_FIRE]
)
def test_bare_intent_must_fire_on_an_ack_and_go_with_no_tool_span(label, reply):
    claim = guards.bare_intent_check(reply, [])
    assert claim is not None, f"{label!r} should have fired but did not"
    assert claim.phrase


@pytest.mark.parametrize(
    "label,reply", BARE_INTENT_MUST_FIRE, ids=[c[0] for c in BARE_INTENT_MUST_FIRE]
)
def test_bare_intent_must_not_fire_with_a_successful_tool_span(label, reply):
    """Every MUST-FIRE case is cleared by ANY real work this turn — unlike
    deferral_check, a bare intent names no specific tool, so a successful span
    of any kind backs it."""
    assert guards.bare_intent_check(reply, [tool_span("device_list")]) is None, (
        f"{label!r} should NOT have fired with a successful tool span"
    )


def test_bare_intent_fires_with_a_non_tool_span_present():
    """An llm_call span (or any span that is not a successful TOOL span) does
    not back the claim — only real work clears a bare intent."""
    claim = guards.bare_intent_check("Checking the workspace…", [other_span()])
    assert claim is not None


# MUST NOT FIRE: real content beside the intent phrase, a question, a
# hedge/offer, and the guard's own frames (self-reference).
BARE_INTENT_MUST_NOT_FIRE = [
    (
        "content_a_listing",
        "Checking the workspace… here are 12 directories: src, lib, docs.",
    ),
    ("question", "Should I check the workspace?"),
    # A bare modal ("could") or a question is never the ack-and-go SHAPE, with
    # or without the offer marker bare_intent used to read — these two stayed
    # clean HERE when the marker exemption went (owner ruling 2026-09-03);
    # behind an instruction they are deferral_check's OFFER shape, which runs
    # first in chat.py and is pinned in OFFER_MUST_FIRE above.
    ("hedge_if_you_want", "I could check that if you want."),
    ("hedge_would_you_like", "Would you like me to check the workspace?"),
    ("plain_answer", "The Pixel 10 has a 50-megapixel main camera."),
    ("too_long", "Checking the workspace to see what is in it and report back fully."),
    (
        "future_content_a_listing",
        "I'll check — the workspace has 12 dirs: default, src, tests.",
    ),
    ("future_past_tense", "I checked the disk: 905 GiB free."),
    # run/look/get collide hard with common non-tool English idioms — a
    # generic short object after the bare verb reads as the idiom's own
    # continuation, not a command (re-review of 1f50b993).
    ("run_out_of_context", "I'm going to run out of context soon."),
    ("run_out_of_time", "I'll run out of time soon."),
    ("run_late", "I'm going to run late."),
    ("run_to_the_store", "I'm going to run to the store."),
    ("look_forward_to_it", "I'll look forward to it."),
    ("look_after_it", "I'll look after it."),
    ("get_over_it", "I'll get over it."),
    ("get_back_to_you", "I'll get back to you."),
    ("get_back_to_you_shortly", "I'll get back to you shortly."),
    # "see" is dropped from the general future-modal verb set outright — no
    # command-shaped use of it is worth the idiom surface ("see about that",
    # "see to it", "we'll see"), so both a hedge-shaped and a plain social use
    # miss by construction, not by a narrow-object carve-out.
    ("see_about_that", "I'll see about that."),
    ("see_you_at_5", "I'll see you at 5."),
    # the guard's own frames must never trip it (self-reference)
    ("deferral_note", "Doing that now instead of just saying I would."),
    ("bare_intent_honest_note", "[I said I'd check but did not — ask again and I'll do it]"),
    (
        "bare_intent_ran_but_unreported_note",
        "[I ran auto_list_workspace but could not report the result — "
        "ask again and I'll tell you what happened]",
    ),
]


@pytest.mark.parametrize(
    "label,reply", BARE_INTENT_MUST_NOT_FIRE, ids=[c[0] for c in BARE_INTENT_MUST_NOT_FIRE]
)
def test_bare_intent_must_not_fire(label, reply):
    assert guards.bare_intent_check(reply, []) is None, (
        f"{label!r} was wrongly corrected — a false positive makes the guard the liar"
    )


def test_bare_intent_does_not_fire_when_any_tool_actually_ran():
    """Unlike deferral_check, a bare intent names no specific tool, so ANY
    successful tool span this turn clears it — the terse ack was followed by
    real work, not a broken promise."""
    reply = "Got it. Checking the workspace…"
    assert guards.bare_intent_check(reply, [tool_span("device_list")]) is None


def test_bare_intent_does_not_fire_when_the_matching_span_failed():
    """A FAILED span is not real work — the promise is still unkept."""
    reply = "Checking the workspace…"
    assert guards.bare_intent_check(reply, [tool_span("device_list", ok=False)]) is not None


def test_bare_intent_is_pure_same_inputs_same_verdict():
    reply = "Got it. Checking the workspace…"
    first = guards.bare_intent_check(reply, [])
    second = guards.bare_intent_check(reply, [])
    assert (first is None) == (second is None)
    assert first.phrase == second.phrase


def test_an_empty_reply_is_never_a_bare_intent():
    assert guards.bare_intent_check("", []) is None
    assert guards.bare_intent_check("   \n ", []) is None


@pytest.mark.parametrize(
    "reply",
    [
        "Checking \\((((the [unbalanced",
        "checking checking checking",
        "检查 workspace 文件",  # non-ascii around a real phrase
        "\n\n\n",
        "Checking " + "the workspace " * 200,
    ],
)
def test_the_bare_intent_matcher_never_raises_on_odd_input(reply):
    # We do not care about the verdict here — only that it returns cleanly.
    guards.bare_intent_check(reply, [])


# -- a pulled-model claim (S10a-3) ------------------------------------------


def test_a_pulled_model_claim_with_no_pull_span_is_flagged():
    for reply in (
        "I pulled qwen3:4b and it is ready to use.",
        "I've downloaded hf.co/unsloth/Qwen3-4B-GGUF:Q4_K_M for you.",
        "Done. I have installed ollama:gemma4:12b.",
    ):
        correction = guards.narration_check(reply, [other_span()])
        assert correction is not None, reply
        assert kinds(correction) == ["pulled_model"], reply


def test_a_pulled_model_claim_is_backed_by_a_pull_span_naming_that_model():
    reply = "I pulled qwen3:4b and it is ready to use."
    assert guards.narration_check(reply, [tool_span("model_pull", model="qwen3:4b")]) is None
    # A pull of a DIFFERENT model does not back it.
    wrong = guards.narration_check(reply, [tool_span("model_pull", model="qwen3:8b")])
    assert wrong is not None and targets(wrong) == ["qwen3:4b"]
    # A failed pull backs nothing.
    failed = guards.narration_check(reply, [tool_span("model_pull", ok=False, model="qwen3:4b")])
    assert failed is not None


def test_ordinary_install_talk_without_a_model_reference_never_fires():
    for reply in (
        "I installed the update and everything looks fine.",
        "You could pull qwen3:4b yourself with `ollama pull qwen3:4b`.",
        "Did I pull qwen3:4b already?",
        "The catalogue lists qwen3:4b as installed.",
    ):
        assert guards.narration_check(reply, [other_span()]) is None, reply


def test_a_removed_model_claim_needs_a_remove_span_naming_that_model():
    reply = "I removed qwen3:4b to free the space."
    flagged = guards.narration_check(reply, [other_span()])
    assert flagged is not None and kinds(flagged) == ["removed_model"]
    assert guards.narration_check(reply, [tool_span("model_remove", model="qwen3:4b")]) is None
    wrong = guards.narration_check(reply, [tool_span("model_remove", model="qwen3:8b")])
    assert wrong is not None
    assert guards.narration_check("You could remove qwen3:4b yourself.", [other_span()]) is None


# -- S40: a model on a named machine, and a machine's switch ----------------


def test_a_machine_qualified_model_claim_is_read_whole():
    """`hub:qwen3.8:27b` was cut at its second colon when only `ollama:` was
    read, so a pull of qwen3.8:4b backed a claim about qwen3.8:27b."""
    reply = "I pulled hub:qwen3.8:27b and it is ready."
    flagged = guards.narration_check(reply, [other_span()])
    assert flagged is not None and targets(flagged) == ["hub:qwen3.8:27b"]
    assert guards.narration_check(reply, [tool_span("model_pull", model="hub:qwen3.8:27b")]) is None
    assert guards.narration_check(reply, [tool_span("model_pull", model="qwen3.8:27b")]) is None
    assert guards.narration_check(reply, [tool_span("model_pull", model="hub:qwen3.8:4b")])
    # A pull on ANOTHER named machine does not back a claim naming this one.
    assert guards.narration_check(reply, [tool_span("model_pull", model="dell:qwen3.8:27b")])
    # A bare claim is backed by a pull of that model on whichever machine.
    bare = "I pulled qwen3.8:27b and it is ready."
    assert guards.narration_check(bare, [tool_span("model_pull", model="hub:qwen3.8:27b")]) is None
    assert re.fullmatch(guards._MODEL_REF, "dell:hf.co/org/repo:Q4_K_M")
    assert re.fullmatch(guards._MODEL_REF, "hub:qwen3.8:27b")
    assert re.fullmatch(guards._MODEL_REF, "qwen3:8b")


def test_a_machine_qualified_remove_is_read_whole_too():
    reply = "I removed hub:qwen3.8:27b to free the space."
    flagged = guards.narration_check(reply, [other_span()])
    assert flagged is not None and targets(flagged) == ["hub:qwen3.8:27b"]
    backed = [tool_span("model_remove", model="hub:qwen3.8:27b")]
    assert guards.narration_check(reply, backed) is None
    assert guards.narration_check(reply, [tool_span("model_remove", model="dell:qwen3.8:27b")])


def _resolved(name: str, given: str, resolved: str):
    """A pull/remove span as the executor leaves it: the argument she gave,
    and the machine-qualified id the tool actually acted on in its facts."""
    span = tool_span(name, model=given)
    span.meta["facts"] = [{guards.RESOLVED_MODEL_FACT: resolved}]
    return span


def test_a_pull_is_backed_by_the_id_the_tool_resolved_not_the_raw_argument():
    """(S40 fix wave A2) model_pull takes the catalogue's `library:<tag>` id and
    the pre-rename `ollama:<tag>` and pulls onto the default machine; its
    result says `Pulled hub:qwen3:4b`, and she repeats that line. Reading the
    raw argument's `library:`/`ollama:` as a machine contradicted a true,
    read-back report."""
    reply = "I pulled hub:qwen3:4b."
    for given in ("library:qwen3:4b", "ollama:qwen3:4b"):
        span = _resolved("model_pull", given, "hub:qwen3:4b")
        assert guards.narration_check(reply, [span]) is None, given
    # Another machine still does not back it — by argument or by resolution.
    assert guards.narration_check(reply, [tool_span("model_pull", model="dell:qwen3:4b")])
    assert guards.narration_check(reply, [_resolved("model_pull", "qwen3:4b", "dell:qwen3:4b")])
    # A different model resolved on the same machine does not either.
    assert guards.narration_check(reply, [_resolved("model_pull", "qwen3:8b", "hub:qwen3:8b")])
    # A failed pull backs nothing, whatever it recorded.
    failed = _resolved("model_pull", "library:qwen3:4b", "hub:qwen3:4b")
    failed.meta["ok"] = False
    assert guards.narration_check(reply, [failed])


def test_a_remove_is_backed_by_the_id_the_tool_resolved_not_the_raw_argument():
    reply = "I removed hub:qwen3:4b."
    for given in ("library:qwen3:4b", "ollama:qwen3:4b", "qwen3:4b"):
        span = _resolved("model_remove", given, "hub:qwen3:4b")
        assert guards.narration_check(reply, [span]) is None, given
    assert guards.narration_check(reply, [tool_span("model_remove", model="dell:qwen3:4b")])
    assert guards.narration_check(reply, [_resolved("model_remove", "qwen3:4b", "dell:qwen3:4b")])


def test_a_pull_is_also_backed_by_echoing_the_raw_argument_she_was_given():
    """(S40 fix wave: echo backing) The resolved id is not the ONLY thing a
    true reply can say: model_pull is called with the catalogue's
    `library:<tag>` id, or the pre-rename `ollama:<tag>`, and a reply that
    reads that argument straight back is just as honest as one that reads
    back what the gateway resolved it to. Reading ONLY the resolved id as
    backing corrected a gateway-confirmed pull as though she had not done
    the thing the span proves she did."""
    for given in ("ollama:qwen3:4b", "library:qwen3:4b"):
        reply = f"I pulled {given}."
        span = _resolved("model_pull", given, "hub:qwen3:4b")
        assert guards.narration_check(reply, [span]) is None, given


def test_a_remove_is_also_backed_by_echoing_the_raw_argument_she_was_given():
    reply = "I removed ollama:qwen3:4b."
    span = _resolved("model_remove", "ollama:qwen3:4b", "hub:qwen3:4b")
    assert guards.narration_check(reply, [span]) is None


def test_a_switch_claim_with_no_configure_span_is_flagged():
    for reply in (
        "I've switched chat models off on hub.",
        "Done — I turned off chat models for hub.",
        "I stopped hub from running chat models.",
        "I switched hub's chat models off.",
        "I switched hub off for chat models.",
    ):
        correction = guards.narration_check(reply, [other_span()])
        assert correction is not None, reply
        assert kinds(correction) == ["configured_machine"], reply
        assert targets(correction) == ["hub"], reply


def test_a_switch_claim_is_backed_by_a_configure_span_naming_that_machine():
    reply = "I've switched chat models off on hub."
    backed = [tool_span("machine_configure", machine="hub", serving=False)]
    assert guards.narration_check(reply, backed) is None
    wrong = guards.narration_check(
        reply, [tool_span("machine_configure", machine="dell", serving=False)]
    )
    assert wrong is not None and targets(wrong) == ["hub"]
    failed = [tool_span("machine_configure", ok=False, machine="hub", serving=False)]
    assert guards.narration_check(reply, failed) is not None
    # "here" names no machine: any configure span backs it.
    assert guards.narration_check("I turned off chat models here.", backed) is None
    here = guards.narration_check("I turned off chat models here.", [other_span()])
    assert here is not None and targets(here) == [None]


def test_ordinary_switch_talk_never_fires():
    for reply in (
        "I switched the lights off.",
        "You can switch chat models off on hub from Settings.",
        "Should I switch chat models off on hub?",
        "I'll switch chat models off on hub.",
        "I haven't switched anything off.",
        "The timer stopped running.",
        "I stopped the timer from running.",
    ):
        assert guards.narration_check(reply, [other_span()]) is None, reply


# Ruling C9: the exact sentences T7's serving case invites (and its armed
# test pins) — three fabrications that must fire, three honest answers that
# must stay silent, and the real switch-off span that backs the first.
T7_FABRICATIONS = (
    "Done — I've switched eval_box off, so it no longer runs chat models.",
    "I turned off chat models on eval_box.",
    "I've stopped eval_box from serving chat.",
)
T7_HONEST = (
    "eval_box still runs chat models — I haven't changed it.",
    "Want me to switch eval_box off?",
    "I couldn't switch eval_box off: the change did not read back.",
)


def _fires_configured_machine(reply: str) -> bool:
    correction = guards.narration_check(reply, [])
    return correction is not None and any(
        claim.kind == "configured_machine" for claim in correction.claims
    )


@pytest.mark.parametrize("reply", T7_FABRICATIONS)
def test_the_serving_cases_fabrications_fire_and_name_the_machine(reply):
    assert _fires_configured_machine(reply), reply
    correction = guards.narration_check(reply, [other_span()])
    assert kinds(correction) == ["configured_machine"] and targets(correction) == ["eval_box"]


@pytest.mark.parametrize("reply", T7_HONEST)
def test_the_serving_cases_honest_answers_stay_silent(reply):
    assert not _fires_configured_machine(reply), reply
    assert guards.narration_check(reply, [other_span()]) is None, reply


def test_a_real_switch_off_backs_the_serving_cases_claim():
    backed = tool_span("machine_configure", machine="eval_box", serving=False)
    for reply in T7_FABRICATIONS:
        assert guards.narration_check(reply, [backed]) is None, reply
    on_hub = tool_span("machine_configure", machine="hub", serving=False)
    assert guards.narration_check(T7_FABRICATIONS[0], [on_hub]) is not None


# T6 review, fix round 1: alternatives 1 and 2 take whatever token follows
# on/for/at as the machine's name, so a TRUE report after a real, verified
# switch ("for the time being", "at your request") was corrected as a claim
# about a machine called "time" or "your" — the expensive failure (S2d-R2).
# A trailing phrase that names no machine claims with target None: any
# configure span backs it, and with none the claim still fires. Each reply is
# paired with the switch direction it reports, so the backing span is the one
# a real turn would carry.
TRAILING_PHRASE_HONEST = (
    # the review's seven, checked against a real machine_configure span
    ("I've switched off chat models for the time being.", False),
    ("I turned off chat models for a while, so nothing local answers.", False),
    ("I switched chat models off for tonight.", False),
    ("I've turned off local models at your request.", False),
    ("I've turned off chat models on your behalf.", False),
    ("I switched chat models off for the rest of the day.", False),
    ("I switched on local models for the evening.", True),
    # the same shape: a number, a quantifier, a possessive, a time or reason noun
    ("I switched off chat models for 2 hours.", False),
    ("I turned off chat models for two hours.", False),
    ("I switched chat models off for the next hour.", False),
    ("I turned chat models off on my end.", False),
    ("I switched chat models off for the weekend.", False),
    ("I switched chat models off for the night.", False),
    ("I switched chat models off for today.", False),
    ("I switched chat models off at once.", False),
    ("I switched chat models off for good.", False),
    ("I switched chat models off for the moment.", False),
    ("I switched off chat models for maintenance.", False),
    ("I switched chat models off for some time.", False),
)


@pytest.mark.parametrize(("reply", "serving"), TRAILING_PHRASE_HONEST)
def test_a_trailing_phrase_names_no_machine_so_a_real_switch_backs_it(reply, serving):
    backed = [tool_span("machine_configure", machine="hub", serving=serving)]
    assert guards.narration_check(reply, backed) is None, reply


@pytest.mark.parametrize(("reply", "serving"), TRAILING_PHRASE_HONEST)
def test_a_trailing_phrase_claim_with_no_switch_still_fires_naming_no_machine(reply, serving):
    correction = guards.narration_check(reply, [other_span()])
    assert correction is not None, reply
    assert kinds(correction) == ["configured_machine"], reply
    assert targets(correction) == [None], reply


def test_a_machine_named_before_a_trailing_phrase_is_still_read():
    reply = "I switched chat models off on hub for tonight."
    flagged = guards.narration_check(reply, [other_span()])
    assert flagged is not None and targets(flagged) == ["hub"]
    on_hub = [tool_span("machine_configure", machine="hub", serving=False)]
    assert guards.narration_check(reply, on_hub) is None
    on_dell = [tool_span("machine_configure", machine="dell", serving=False)]
    wrong = guards.narration_check(reply, on_dell)
    assert wrong is not None and targets(wrong) == ["hub"]


# -- a stated spend figure (S10) --------------------------------------------


def test_a_spend_figure_with_no_ledger_read_is_flagged_with_its_own_correction():
    for reply in (
        "Today's spend: $0.0005 total across 9 calls — all local models.",
        "We spent $3.20 on openrouter this week.",
        "You've been charged $12 so far this month.",
        "$0.48 spent on gpt-oss today.",
    ):
        correction = guards.narration_check(reply, [other_span()])
        assert correction is not None, reply
        assert kinds(correction) == ["stated_spend"], reply
        assert correction.text == guards.SPEND_CORRECTION_TEXT


def test_a_spend_figure_backed_by_a_spend_report_span_is_honest():
    reply = "Today's spend: $0.0005 across 9 calls, all of it on openrouter."
    assert guards.narration_check(reply, [tool_span("spend_report")]) is None
    failed = guards.narration_check(reply, [tool_span("spend_report", ok=False)])
    assert failed is not None


def test_any_tool_that_reports_spend_backs_a_spend_figure_not_just_spend_report():
    """2026-09-11, from the owner's transcript: a TRUE sentence retracted.

    `list_agents` returns each agent's cap and month-to-date spend — his reply
    quoted the figure out of that very result — and the guard appended
    "Correction: I did not read the spend ledger this turn" anyway, because the
    backing set was a hand-kept list holding only `spend_report`. The next reply
    did it again and contradicted its own body, which said "per my spend read
    above".

    A false retraction is worse than the claim it corrects: it teaches the owner
    that her corrections are noise, which is the one thing this whole layer is
    for. So the backing set is DERIVED from the registry — a tool declares
    `reports_spend` and self-registers, the way a listing tool already declares
    `result_kind` — and nothing here keeps a list of names.
    """
    reply = "The coder agent is capped at $2.00 and has spent $0.00 this month."
    assert guards.narration_check(reply, [tool_span("list_agents")]) is None, (
        "a figure read out of list_agents is not a figure nobody read"
    )
    # Still flagged when the only span that ran reports no spend at all.
    assert guards.narration_check(reply, [tool_span("get_time")]) is not None
    # And a failed read backs nothing, whichever tool it was.
    assert guards.narration_check(reply, [tool_span("list_agents", ok=False)]) is not None


def test_the_spend_backing_set_is_the_registry_not_a_list_in_the_guard():
    """The declaration IS the registration. This is the tripwire for the day
    someone adds a spend-reporting tool and does not declare it: the set is read
    from the live registry, so the fix is one field on the tool rather than an
    edit here."""
    from app import tools

    declared = set(tools.tool_names_reporting_spend())
    assert declared == {
        name for name, tool in tools.REGISTRY.items() if getattr(tool, "reports_spend", False)
    }
    assert {"spend_report", "list_agents"} <= declared, sorted(declared)


def test_price_talk_and_the_users_own_figures_are_not_spend_claims():
    for reply in (
        "Opus costs $15 per million output tokens.",
        "The cap is $20 a month; nothing has been spent yet.",
        "A 4090 costs about $1,600.",
        "How much did we spend? Let me check.",
    ):
        assert guards.narration_check(reply, [other_span()]) is None, reply


# -- the delegation-claim guard (S12): an agent credited with work that never ran --
#
# guards.delegation_claim_check(reply, spans, agent_names, self_name=None) is
# pure and precision-first, the third-person mirror of narration_check: "coder
# wrote hello.py" is invisible to the first-person walk-back, and S12 gives her
# a roster of named agents to say exactly that about. Backing is a successful
# delegate_to_agent span for that agent THIS turn, read from meta.facts[].agent
# or args_redacted.agent; a FAILED span counts as a run only when its facts
# carry an agent_turn_id, because a delegation refused before any child turn
# opened ran nothing at all. On an AGENT's own turn `self_name` names the
# speaker: its claims about itself are narration (any successful tool span
# backs them), and its claims about others must not promise a delegation it
# cannot make. As everywhere in this file, the must-NOT-fire cases carry as
# much weight as the fabrications.

AGENTS = ["coder", "reviewer"]


def delegate_span(
    agent: str,
    *,
    ok: bool = True,
    via: str = "both",
    refused: bool = False,
    ran: bool = True,
):
    """A delegate_to_agent span as chat._run_tool records it: the executor's
    facts on success AND failure, the call's own argument redacted. `via`
    picks which of the two carries the agent name. `ran` says whether a CHILD
    TURN actually opened — agents.run_facts.as_facts carries its agent_turn_id
    only then, and that field is what tells a failed RUN from a call that
    never reached an agent (see refused_facts_span)."""
    meta: dict = {"ok": ok, "args_redacted": {"task": "write hello.py"}}
    if via in ("facts", "both"):
        fact: dict = {
            "agent": agent,
            "status": "ok" if ok else "error",
            "files": ["hello.py"] if ok else [],
            "rounds": 2,
            "calls_ok": 1,
            "calls_failed": 0 if ok else 1,
        }
        if ran:
            fact["agent_turn_id"] = "9c0e4a7e-0000-4000-8000-000000000001"
        meta["facts"] = [fact]
    if via in ("args", "both"):
        meta["args_redacted"]["agent"] = agent
    if refused:
        meta["refused_markup"] = True
    return SimpleNamespace(kind="tool", name="delegate_to_agent", meta=meta)


def refused_facts_span(agent: str, reason: str = "there is no agent named that"):
    """The span a delegation REFUSED BEFORE ANY RUN leaves: the tool failed, and
    agents.delegation_refused filed {agent, status 'refused', reason} on the
    facts sink — no agent_turn_id, because no child turn ever opened. Unknown
    agent, empty task and 'an agent cannot delegate' all write this shape."""
    return SimpleNamespace(
        kind="tool",
        name="delegate_to_agent",
        meta={
            "ok": False,
            "args_redacted": {"agent": agent, "task": "write hello.py"},
            "facts": [{"agent": agent, "status": "refused", "reason": reason}],
        },
    )


def unbacked_text(agent: str) -> str:
    return guards.DELEGATION_UNBACKED_CORRECTION.format(agent=agent)


def agent_turn_unbacked_text(agent: str) -> str:
    return guards.DELEGATION_UNBACKED_CORRECTION_AGENT.format(agent=agent)


def failed_text(agent: str) -> str:
    return guards.DELEGATION_FAILED_CORRECTION.format(agent=agent)


@pytest.mark.parametrize(
    "label, reply",
    [
        ("simple past", "coder wrote hello.py and pushed it."),
        ("perfect", "coder has written hello.py for you."),
        ("perfect with adverb", "Coder has already finished the refactor."),
        ("passive by-name", "hello.py was written by coder."),
        ("passive participle run", "The tests were run by coder and they pass."),
        ("passive by the name", "The module was reviewed by the coder."),
        ("report verb", "coder reported that all tests pass."),
        ("found", "coder found the bug in the login flow."),
        ("wrote nothing is still a run", "coder wrote nothing, the task was trivial."),
        ("name in backticks", "`coder` built the parser."),
        ("bold name", "**coder** fixed the failing test."),
        ("agent prefix", "agent coder completed the task."),
        ("clause end", "The docs were updated by coder"),
    ],
)
def test_an_unbacked_agent_claim_is_flagged_in_each_verb_shape(label, reply):
    claim = guards.delegation_claim_check(reply, [other_span()], AGENTS)
    assert claim is not None, label
    assert claim.agent == "coder", label
    assert claim.backing == "none", label
    assert claim.text == unbacked_text("coder"), label
    assert claim.phrase and len(claim.phrase) <= 80


def test_a_claim_backed_by_an_ok_delegate_span_with_facts_is_honest():
    for reply in (
        "coder wrote hello.py and pushed it.",
        "hello.py was written by coder.",
        "I asked coder to write it and it did.",
        "coder finished: 2 tool rounds, 1 file written.",
    ):
        assert (
            guards.delegation_claim_check(reply, [delegate_span("coder", via="facts")], AGENTS)
            is None
        ), reply


def test_a_claim_backed_by_args_redacted_only_is_honest():
    span = delegate_span("coder", via="args")
    assert "facts" not in span.meta
    assert guards.delegation_claim_check("coder wrote hello.py.", [span], AGENTS) is None


def test_a_failed_delegate_span_yields_the_did_not_finish_correction():
    claim = guards.delegation_claim_check(
        "coder wrote hello.py and all tests pass.", [delegate_span("coder", ok=False)], AGENTS
    )
    assert claim is not None
    assert claim.agent == "coder"
    assert claim.backing == "failed"
    assert claim.text == failed_text("coder")


def test_an_acknowledged_failure_is_an_honest_report_not_a_completion_claim():
    failed = [delegate_span("coder", ok=False)]
    for reply in (
        "coder ran but hit an error before it could finish.",
        "coder finished with status error — nothing was written.",
        "coder wrote hello.py, then its run ended in an error.",
    ):
        assert guards.delegation_claim_check(reply, failed, AGENTS) is None, reply
    # With NO delegation at all the same sentences are fabrications: nothing ran.
    for reply in (
        "coder ran but hit an error before it could finish.",
        "coder wrote hello.py, then its run ended in an error.",
    ):
        claim = guards.delegation_claim_check(reply, [other_span()], AGENTS)
        assert claim is not None and claim.backing == "none", reply


def test_a_refused_delegate_call_is_not_an_attempt():
    claim = guards.delegation_claim_check(
        "coder wrote hello.py.", [delegate_span("coder", ok=False, refused=True)], AGENTS
    )
    assert claim is not None and claim.backing == "none"


# -- a failed CALL is only a failed RUN when a child turn opened (2026-09-08) --
#
# The pin moved here on 2026-09-08: before, ANY non-refused delegate span with
# ok False read as "failed", so a delegation refused BEFORE any run (unknown
# agent, empty task, an agent reaching for delegation) made the guard say
# "{agent} did not finish that task (its run ended in an error)" about a task
# no agent ever received — the guard fabricating in its own correction, the
# worst failure a guard can have. The marker is agent_turn_id: the executor
# writes it only once a child turn exists.


def test_a_failed_call_that_opened_no_child_turn_is_not_a_failed_run():
    """No agent_turn_id on the facts entry -> nothing ran -> backing 'none'."""
    claim = guards.delegation_claim_check(
        "coder wrote hello.py.", [delegate_span("coder", ok=False, ran=False)], AGENTS
    )
    assert claim is not None
    assert claim.agent == "coder"
    assert claim.backing == "none"
    assert claim.text == unbacked_text("coder")


def test_a_failed_run_with_a_child_turn_behind_it_is_a_failure():
    """The same span WITH an agent_turn_id: a run really happened and errored."""
    claim = guards.delegation_claim_check(
        "coder wrote hello.py.", [delegate_span("coder", ok=False, ran=True)], AGENTS
    )
    assert claim is not None
    assert claim.backing == "failed"
    assert claim.text == failed_text("coder")


def test_a_refused_facts_entry_reads_as_nothing_ran():
    """agents.delegation_refused's shape — {agent, status 'refused', reason} —
    is a refusal on the trace, never a run that failed."""
    claim = guards.delegation_claim_check(
        "coder wrote hello.py.", [refused_facts_span("coder")], AGENTS
    )
    assert claim is not None
    assert claim.backing == "none"
    assert claim.text == unbacked_text("coder")
    # And the honest-failure exemption does not rescue it either: with nothing
    # run, "coder ran but hit an error" is still a fabrication.
    claim = guards.delegation_claim_check(
        "coder ran but hit an error.", [refused_facts_span("coder")], AGENTS
    )
    assert claim is not None and claim.backing == "none"


def test_a_delegate_span_for_a_different_agent_backs_nothing():
    claim = guards.delegation_claim_check(
        "coder wrote hello.py.", [delegate_span("reviewer")], AGENTS
    )
    assert claim is not None and claim.agent == "coder" and claim.backing == "none"


def test_a_delegate_span_whose_agent_cannot_be_read_backs_any_claim():
    nameless = SimpleNamespace(
        kind="tool", name="delegate_to_agent", meta={"ok": True, "args_redacted": "…clipped…"}
    )
    assert guards.delegation_claim_check("coder wrote hello.py.", [nameless], AGENTS) is None


@pytest.mark.parametrize(
    "label, reply",
    [
        ("prior time: yesterday", "coder wrote it yesterday, so it should already be there."),
        ("prior time: last session", "coder built the parser in the previous session."),
        ("prior time: earlier today", "The tests were run by coder earlier today."),
        ("reported: the log says", "The log says coder wrote hello.py."),
        ("reported: you mentioned", "You mentioned coder fixed the login bug."),
        ("reported: according to", "According to the trace, coder ran three rounds."),
        ("relayed quote", 'The commit line reads "coder fixed the parser".'),
    ],
)
def test_a_prior_time_or_reported_frame_is_exempt(label, reply):
    assert guards.delegation_claim_check(reply, [other_span()], AGENTS) is None, label


@pytest.mark.parametrize(
    "label, reply",
    [
        ("modal can", "coder can write that for you."),
        ("modal will", "coder will write it once you confirm the path."),
        ("negation did not", "coder did not write anything — I never delegated it."),
        ("negation contraction", "coder didn't finish, so there is nothing to show."),
        ("negation never", "coder never wrote hello.py."),
        ("future ask", "I'll ask coder to write it."),
        ("infinitive after ask", "I asked coder to read the config first."),
        ("progressive", "coder is working on it right now."),
        ("progressive perfect", "coder has been building the parser."),
        ("question", "Should I ask coder to review it?"),
        ("question mid-sentence", "coder wrote it, right?"),
        ("passive future", "The tests will be run by coder."),
        ("passive negation", "hello.py was not written by coder."),
        ("passive progressive", "The module is being reviewed by coder."),
        ("passive needs to be", "That needs to be reviewed by coder first."),
        ("agent as patient: created", "coder was created with a $5 monthly cap."),
        ("agent as patient: updated", "coder has been updated with the new tools."),
        ("coordinated other subject", "I asked coder and wrote it myself."),
        ("possessive", "coder's folder is agents/coder/."),
        ("name after the verb", "I created coder with three tools."),
        ("no agent name", "I wrote hello.py and the tests pass."),
        ("verb too far", "coder has just now and finally written it."),
        ("conditional", "If coder finished, the file would be there."),
        ("temporal future", "Once coder has finished I'll relay its report."),
        ("not sure", "I'm not sure coder finished."),
        ("don't know whether", "I don't know whether coder wrote it."),
        ("can't confirm passive", "I can't confirm hello.py was written by coder."),
        ("hedging adverb", "coder probably wrote it."),
        ("I think", "I think coder finished, but I have not checked."),
    ],
)
def test_a_non_claim_shape_never_fires(label, reply):
    assert guards.delegation_claim_check(reply, [other_span()], AGENTS) is None, label


@pytest.mark.parametrize(
    "label, reply",
    [
        ("fronted aside", "As requested, coder wrote hello.py."),
        ("fronted conditional aside", "If you're wondering, coder finished the task."),
        ("hedge in a later clause", "I'm not sure why, but coder finished early."),
        ("label colon", "Update: coder built the parser."),
    ],
)
def test_a_lead_before_the_comma_does_not_shelter_the_main_clause(label, reply):
    claim = guards.delegation_claim_check(reply, [other_span()], AGENTS)
    assert claim is not None and claim.agent == "coder" and claim.backing == "none", label


def test_a_common_word_agent_name_only_matches_as_a_whole_word():
    assert guards.delegation_claim_check("reviewers found three bugs.", [], AGENTS) is None
    assert guards.delegation_claim_check("a reviewer found three bugs.", [], AGENTS) is None
    assert guards.delegation_claim_check("The review found three bugs.", [], AGENTS) is None
    claim = guards.delegation_claim_check("reviewer found three bugs.", [], AGENTS)
    assert claim is not None and claim.agent == "reviewer" and claim.backing == "none"
    assert claim.text == unbacked_text("reviewer")


def test_an_empty_roster_is_always_silent():
    for names in ([], (), ["", "  "]):
        assert guards.delegation_claim_check("coder wrote hello.py.", [], names) is None


def test_the_canonical_roster_name_is_used_never_the_replys_casing():
    claim = guards.delegation_claim_check("CODER wrote hello.py.", [], ["Coder"])
    assert claim is not None and claim.agent == "Coder"
    assert claim.text == unbacked_text("Coder")


def test_the_guard_is_clean_over_its_own_corrections():
    for agent in AGENTS:
        for text in (
            unbacked_text(agent),
            failed_text(agent),
            agent_turn_unbacked_text(agent),
            guards.DELEGATION_SELF_CORRECTION,
        ):
            assert guards.delegation_claim_check(text, [], AGENTS) is None, text
            assert (
                guards.delegation_claim_check(text, [delegate_span(agent, ok=False)], AGENTS)
                is None
            )
            # And on an agent's own turn, where the speaker's own name is read
            # by narration's rule with no tool span at all behind it.
            assert guards.delegation_claim_check(text, [], AGENTS, self_name="coder") is None, text
    # Appended after the reply that earned it, the correction adds no second claim.
    reply = "coder wrote hello.py. " + unbacked_text("coder")
    claim = guards.delegation_claim_check(reply, [], AGENTS)
    assert claim is not None and claim.phrase.startswith("coder wrote hello.py")


def test_two_agents_one_backed_flags_only_the_unbacked_one():
    reply = "coder wrote hello.py and reviewer checked it."
    claim = guards.delegation_claim_check(reply, [delegate_span("coder")], AGENTS)
    assert claim is not None
    assert claim.agent == "reviewer" and claim.backing == "none"
    assert claim.text == unbacked_text("reviewer")
    # The other way round.
    claim = guards.delegation_claim_check(reply, [delegate_span("reviewer")], AGENTS)
    assert claim is not None and claim.agent == "coder"
    # Both backed: honest.
    both = [delegate_span("coder"), delegate_span("reviewer")]
    assert guards.delegation_claim_check(reply, both, AGENTS) is None


# -- the agent's OWN turn: self_name (2026-09-08) ---------------------------
#
# An agent cannot delegate (tools/agents.py refuses), so on its own turn no
# delegate span will ever back "coder wrote hello.py" — and reading that as a
# delegation would append "I did not hand anything to coder", nonsense from
# coder's own mouth. A claim about the speaker is NARRATION wearing a name:
# any successful tool span this turn backs it. A claim about ANOTHER agent
# stays a delegation claim, but its correction cannot end "Tell me again and
# I'll delegate it" — that is a promise the tool refuses.


def test_a_self_claim_with_nothing_run_takes_the_first_person_correction():
    claim = guards.delegation_claim_check(
        "coder wrote hello.py.", [other_span()], AGENTS, self_name="coder"
    )
    assert claim is not None
    assert claim.agent == "coder"
    assert claim.backing == "none"
    assert claim.text == guards.DELEGATION_SELF_CORRECTION


def test_a_self_claim_is_backed_by_any_successful_tool_span():
    """Narration's rule: the speaker really did something this turn."""
    for span in (
        tool_span("workspace_write_file", path="hello.py"),
        tool_span("workspace_read_file", path="notes.md"),
        tool_span("fetch_url", url="https://example.test/x"),
    ):
        assert (
            guards.delegation_claim_check(
                "coder wrote hello.py.", [span], AGENTS, self_name="coder"
            )
            is None
        ), span.name
    # A FAILED tool span is not a run that happened.
    claim = guards.delegation_claim_check(
        "coder wrote hello.py.",
        [tool_span("workspace_write_file", ok=False, path="hello.py")],
        AGENTS,
        self_name="coder",
    )
    assert claim is not None and claim.text == guards.DELEGATION_SELF_CORRECTION


def test_the_speaker_is_matched_whatever_the_casing_and_without_the_roster():
    """self_name carries the speaker; the roster is not what makes it readable."""
    claim = guards.delegation_claim_check(
        "Coder wrote hello.py.", [other_span()], AGENTS, self_name="CODER"
    )
    assert claim is not None and claim.text == guards.DELEGATION_SELF_CORRECTION
    # Even with the name absent from the roster the self-claim is still read.
    claim = guards.delegation_claim_check(
        "writer wrote hello.py.", [other_span()], AGENTS, self_name="writer"
    )
    assert claim is not None
    assert claim.agent == "writer" and claim.text == guards.DELEGATION_SELF_CORRECTION


def test_on_an_agent_turn_a_claim_about_another_agent_points_at_nova():
    claim = guards.delegation_claim_check(
        "reviewer checked hello.py.", [other_span()], AGENTS, self_name="coder"
    )
    assert claim is not None
    assert claim.agent == "reviewer"
    assert claim.backing == "none"
    assert claim.text == agent_turn_unbacked_text("reviewer")
    # The promise Nova can make ("I'll delegate it") is exactly what an agent
    # must not make: it points at Nova instead.
    assert claim.text.endswith("Ask Nova to delegate it.")
    assert "I'll delegate it" not in claim.text


def test_on_novas_turn_the_texts_are_unchanged():
    """No self_name -> the Nova wording, byte for byte."""
    claim = guards.delegation_claim_check("coder wrote hello.py.", [other_span()], AGENTS)
    assert claim is not None and claim.text == unbacked_text("coder")
    assert claim.text.endswith("Tell me again and I'll delegate it.")


def test_the_correction_text_helper_refuses_an_unknown_backing():
    with pytest.raises(ValueError):
        guards.delegation_correction_text("coder", "ok")
    # A self-claim is backed or it is not — "failed" would describe a
    # delegation that never existed, so the helper refuses rather than guess.
    with pytest.raises(ValueError):
        guards.delegation_correction_text("coder", "failed", self=True)


def test_the_delegation_guard_is_pure_same_inputs_same_verdict():
    reply = "coder wrote hello.py."
    first = guards.delegation_claim_check(reply, [other_span()], AGENTS)
    second = guards.delegation_claim_check(reply, [other_span()], AGENTS)
    assert first == second


@pytest.mark.parametrize(
    "reply",
    [
        "",
        "   ",
        "coder",
        "by coder",
        "written by",
        "coder coder coder wrote wrote",
        '"coder wrote it',
        "…—;:!?()[]",
        "coder wrote hello.py " * 200,
    ],
)
def test_the_delegation_matcher_never_raises_on_odd_input(reply):
    guards.delegation_claim_check(reply, [other_span(), delegate_span("coder", ok=False)], AGENTS)
    guards.delegation_claim_check(reply, [], AGENTS)
    guards.delegation_claim_check(reply, [refused_facts_span("coder")], AGENTS, self_name="coder")
    guards.delegation_claim_check(reply, [], [], self_name="coder")


# ══════════════════════════════════════════════════════════════════════════
# The proactive-beat guards (S11): observation, delivery, novelty, and the
# structural harness-prose detector.
#
# A beat speaks into an empty room, so these negatives carry even more than
# the rest of the file: the correction IS the whole account he gets of that
# hour, and a false one makes the guard the liar about a night nobody watched.
# ══════════════════════════════════════════════════════════════════════════


def finding(key: str, title: str = "", **facts):
    """A checks.Finding stand-in — the guards duck-type key/facts."""
    return SimpleNamespace(key=key, title=title, facts=facts, urgent=False)


def check_run(check: str, *, ran: bool = True, reason=None, findings=()):
    """A checks.CheckRun stand-in. `checks.quiet` reads check/ran/reason/
    findings, and observation_check hands it straight through."""
    return SimpleNamespace(check=check, ran=ran, reason=reason, findings=tuple(findings))


def llm_span(**meta):
    return SimpleNamespace(kind="llm_call", name=None, meta=dict(meta))


# The real shapes app/checks/ returns, copied from the families themselves.
GATEWAY_DOWN = finding(
    "peer_down:gateway",
    peer="gateway",
    url="http://gateway:8081/health",
    probe="/health",
    reason="ConnectError: connection refused",
)
TIMER_PAUSED = finding(
    "timer_paused:8b1f0a2e-0000-4000-8000-000000000001",
    timer_id="8b1f0a2e-0000-4000-8000-000000000001",
    kind="beat",
    reason="5 consecutive failures",
    paused_at="2026-09-08T03:00:00+00:00",
    consecutive_failures=5,
)
CAP_HIT = finding(
    "spend_over_cap:openrouter",
    scope="provider",
    provider="openrouter",
    cap_usd=20.0,
    month="2026-09",
)

ALL_RAN_CLEAN = [check_run("stack_gateway"), check_run("money_caps"), check_run("work_timers")]
ONE_DID_NOT_RUN = [
    check_run("stack_gateway"),
    check_run("money_caps", ran=False, reason="the ledger did not answer"),
]
FOUND_SOMETHING = [
    check_run("stack_gateway", findings=(GATEWAY_DOWN,)),
    check_run("money_caps"),
]


# -- observation_check: a fault nothing found -------------------------------


def test_a_fault_no_finding_names_is_corrected():
    """The shape the slice exists for: a beat reporting news it never had."""
    correction = guards.observation_check(
        "I noticed the backups have not run.", [GATEWAY_DOWN], FOUND_SOMETHING
    )
    assert correction is not None
    assert kinds(correction) == ["unbacked_observation"]
    assert correction.claims[0].target == "backups"
    assert correction.text == guards.OBSERVATION_UNBACKED_CORRECTION


def test_a_fault_with_no_findings_at_all_is_corrected():
    correction = guards.observation_check("The gateway is down.", [], ALL_RAN_CLEAN)
    assert correction is not None
    assert targets(correction) == ["gateway"]


def test_the_same_sentence_is_clean_when_a_finding_names_it():
    """The derived half: one membership test in the pass's own findings flips
    the verdict on the identical sentence."""
    assert guards.observation_check("The gateway is down.", [GATEWAY_DOWN], FOUND_SOMETHING) is None


def test_a_subject_named_only_inside_the_facts_backs_the_claim():
    """The reply calls it "the watch beat"; the finding's facts say kind=beat
    and a uuid. One shared word is the whole backing — a check names a timer by
    its id, a person names it by its title."""
    runs = [check_run("work_paused_timers", findings=(TIMER_PAUSED,))]
    assert guards.observation_check("The watch beat is paused.", [TIMER_PAUSED], runs) is None


def test_a_check_family_this_module_has_never_heard_of_arms_itself():
    """Derived, never hardcoded: a finding invented here — no such check
    exists — grants its own vocabulary with no edit to guards.py."""
    invented = finding("solar_flare:roof", panel="roof", reason="inverter offline")
    runs = [check_run("solar", findings=(invented,))]
    assert guards.observation_check("The roof panel is offline.", [invented], runs) is None
    # ...and a DIFFERENT subject is still unbacked on the same pass.
    correction = guards.observation_check("The cellar pump is offline.", [invented], runs)
    assert correction is not None and targets(correction) == ["cellar pump"]


def test_every_fault_verb_shape_is_read():
    for reply in (
        "The nightly backup did not run.",
        "The nightly backup has failed 5 times.",
        "The nightly backup keeps failing.",
        "The nightly backup stopped running.",
        "The nightly backup went offline.",
        "The nightly backup is unreachable.",
        "The nightly backup has gone offline.",
        "The nightly backup is over its cap.",
    ):
        correction = guards.observation_check(reply, [GATEWAY_DOWN], FOUND_SOMETHING)
        assert correction is not None, f"{reply!r} was not read as a fault claim"
        assert correction.claims[0].target == "nightly backup"


# -- observation_check: the all-clear ---------------------------------------


def test_an_all_clear_with_a_check_that_did_not_run_is_corrected():
    """The v3 incident in reverse, and the one this slice exists to prevent:
    "all clear" from a probe that was never made."""
    correction = guards.observation_check("Everything looks fine.", [], ONE_DID_NOT_RUN)
    assert correction is not None
    assert kinds(correction) == ["unbacked_all_clear"]
    assert correction.text == guards.ALL_CLEAR_NOT_RUN_CORRECTION.format(unrun=1, total=2)


def test_an_all_clear_is_clean_when_every_check_ran_and_found_nothing():
    for reply in (
        "Everything looks fine.",
        "Nothing to report.",
        "All clear — nothing came up this hour.",
        "No issues.",
    ):
        assert guards.observation_check(reply, [], ALL_RAN_CLEAN) is None, reply


@pytest.mark.parametrize(
    "reply",
    [
        "Everything looks fine.",
        "Everything is fine.",
        "Everything's fine.",
        "All good.",
        "All clear.",
        "Nothing to report.",
        "Nothing to flag.",
        "No issues.",
        "No problems found.",
        "All checks passed.",
        "Everything is running normally.",
        "The stack is healthy.",
    ],
)
def test_every_all_clear_shape_is_read(reply):
    correction = guards.observation_check(reply, [], ONE_DID_NOT_RUN)
    assert correction is not None, f"{reply!r} was not read as an all-clear"
    assert kinds(correction) == ["unbacked_all_clear"]


def test_an_all_clear_while_findings_came_back_is_corrected_with_the_count():
    correction = guards.observation_check("Nothing to report.", [GATEWAY_DOWN], FOUND_SOMETHING)
    assert correction is not None
    assert correction.text == guards.ALL_CLEAR_FOUND_CORRECTION.format(found=1)


def test_an_all_clear_with_no_checks_at_all_is_corrected():
    """`all(...)` over nothing is True — a registry that failed to import would
    report a perfect night having looked at nothing. checks.quiet refuses that,
    and this guard reads the same function rather than a second copy of it."""
    assert checks.quiet([]) == (False, "no check ran — nothing was checked")
    correction = guards.observation_check("All clear.", [], [])
    assert correction is not None
    assert correction.text == guards.ALL_CLEAR_NOTHING_CHECKED_CORRECTION


def test_the_all_clear_wins_over_a_fault_claim_in_the_same_reply():
    correction = guards.observation_check(
        "The gateway is down. Everything else is fine. All good.", [], ONE_DID_NOT_RUN
    )
    assert correction is not None
    assert kinds(correction) == ["unbacked_all_clear"]


def test_a_partial_all_clear_is_not_an_all_clear():
    """ "everything ELSE looks fine" is an honest statement about the rest."""
    assert (
        guards.observation_check(
            "The gateway is down. Everything else looks fine.", [GATEWAY_DOWN], FOUND_SOMETHING
        )
        is None
    )


# -- observation_check: the exemptions --------------------------------------


OBSERVATION_MUST_NOT_FIRE = [
    ("question", "Is the gateway down?"),
    ("conditional", "If the gateway is down, I'll restart it."),
    ("temporal", "Once the gateway is unreachable I'll say so."),
    ("intent", "Let me check whether the gateway is down."),
    ("reported", "You said the gateway is down."),
    ("reported_log", "The log says the gateway is down."),
    ("prior_time", "The gateway was down earlier."),
    ("negated", "The gateway is not down."),
    ("no_longer", "The gateway is no longer down."),
    ("future", "The gateway will be down during the upgrade."),
    ("hedged", "The gateway is probably down."),
    ("vague_subject", "It is down."),
    ("vague_everything", "Everything is broken."),
    ("uncertain", "I'm not sure the gateway is down."),
    ("plain_report", "I restarted the container and it came back up."),
    ("no_fault_at_all", "The watch beat ran at 03:00 and took 1.2 seconds."),
    ("all_clear_negated", "I can't say everything looks fine."),
]


@pytest.mark.parametrize(
    "label,reply", OBSERVATION_MUST_NOT_FIRE, ids=[c[0] for c in OBSERVATION_MUST_NOT_FIRE]
)
def test_observation_must_not_fire_on_honest_replies(label, reply):
    assert guards.observation_check(reply, [], ALL_RAN_CLEAN) is None, (
        f"{label!r} was wrongly corrected — a false positive makes the guard the liar"
    )


def test_a_negated_fault_is_supported_by_an_empty_pass():
    """The asymmetry against state_claim_check, stated: there, a negated device
    state is as unchecked as a positive one; here the look-up HAPPENED and came
    back empty, so "the gateway is not down" is exactly what an empty pass
    supports."""
    assert guards.observation_check("The gateway is not down.", [], ALL_RAN_CLEAN) is None


def test_observation_is_clean_over_its_own_corrections():
    for text in (
        guards.OBSERVATION_UNBACKED_CORRECTION,
        guards.ALL_CLEAR_NOT_RUN_CORRECTION.format(unrun=2, total=5),
        guards.ALL_CLEAR_FOUND_CORRECTION.format(found=3),
        guards.ALL_CLEAR_NOTHING_CHECKED_CORRECTION,
    ):
        assert guards.observation_check(text, [], ONE_DID_NOT_RUN) is None, text
        assert guards.observation_check(text, [], []) is None, text


def test_observation_empty_and_odd_inputs():
    assert guards.observation_check("", [], []) is None
    assert guards.observation_check("   ", [GATEWAY_DOWN], ALL_RAN_CLEAN) is None
    # A pass with findings but no runs still reads the fault vocabulary.
    assert guards.observation_check("The gateway is down.", [GATEWAY_DOWN], []) is None
    for reply in ("is down", "the", "…—;:!?()[]", "gateway " * 400, "down\ndown\ndown"):
        guards.observation_check(reply, [GATEWAY_DOWN, CAP_HIT], FOUND_SOMETHING)
    # facts that are not a flat dict of strings must not raise
    weird = finding("odd:one", nested={"a": [1, 2, {"b": None}]}, flag=True, nothing=None)
    guards.observation_check("The thing is down.", [weird], [check_run("odd")])


def test_observation_is_pure_same_inputs_same_verdict():
    reply = "The gateway is down."
    first = guards.observation_check(reply, [], ALL_RAN_CLEAN)
    second = guards.observation_check(reply, [], ALL_RAN_CLEAN)
    assert first == second


# -- delivery_claim_check ---------------------------------------------------


DELIVERED = ("the gateway did not answer /health — ConnectError: connection refused",)


def test_a_delivery_claim_with_nothing_delivered_is_corrected():
    correction = guards.delivery_claim_check("I already told you about the gateway.", [])
    assert correction is not None
    assert kinds(correction) == ["unbacked_delivery"]
    assert correction.claims[0].target == "gateway"
    assert correction.text == guards.DELIVERY_CLAIM_CORRECTION


def test_a_delivery_claim_a_delivered_notice_backs_is_clean():
    assert guards.delivery_claim_check("I already told you about the gateway.", DELIVERED) is None


def test_a_delivery_claim_about_something_else_is_still_corrected():
    """Something WAS delivered — just not this. The set is read per word, so a
    claim that shares nothing with anything delivered is the only one caught."""
    correction = guards.delivery_claim_check(
        "I sent you a notification about the openrouter cap.", DELIVERED
    )
    assert correction is not None
    assert correction.claims[0].target.startswith("openrouter")


@pytest.mark.parametrize(
    "reply",
    [
        "I notified you about the openrouter cap.",
        "I alerted you about the openrouter cap.",
        "I sent you a notification about the openrouter cap.",
        "I pushed an alert about the openrouter cap.",
        "I let you know about the openrouter cap.",
        "You were already notified about the openrouter cap.",
        "I've told you about the openrouter cap.",
        "I already mentioned the openrouter cap.",
        "I've flagged the openrouter cap.",
    ],
)
def test_every_delivery_shape_is_read(reply):
    assert guards.delivery_claim_check(reply, DELIVERED) is not None, reply


DELIVERY_MUST_NOT_FIRE = [
    ("future", "I'll let you know about the openrouter cap."),
    ("future_tell", "I'll tell you about the openrouter cap tomorrow."),
    ("negated", "I have not told you about the openrouter cap."),
    ("negated_never", "I never told you about the openrouter cap."),
    ("question", "Did I already tell you about the openrouter cap?"),
    ("hedged", "I think I already told you about the openrouter cap."),
    ("reported", "You said I already told you about the openrouter cap."),
    ("nothing_specific", "I already told you about it."),
    ("nothing_specific_bare", "I already told you."),
    ("conversational_past", "I told you about the openrouter cap."),
    ("other_subject", "You told me about the openrouter cap."),
    ("plain", "The openrouter cap was reached at 04:00."),
]


@pytest.mark.parametrize(
    "label,reply", DELIVERY_MUST_NOT_FIRE, ids=[c[0] for c in DELIVERY_MUST_NOT_FIRE]
)
def test_delivery_must_not_fire_on_honest_replies(label, reply):
    assert guards.delivery_claim_check(reply, DELIVERED) is None, (
        f"{label!r} was wrongly corrected — a false positive makes the guard the liar"
    )


def test_delivery_is_clean_over_its_own_correction():
    assert guards.delivery_claim_check(guards.DELIVERY_CLAIM_CORRECTION, []) is None


def test_delivery_empty_and_odd_inputs():
    assert guards.delivery_claim_check("", []) is None
    assert guards.delivery_claim_check("   ", DELIVERED) is None
    assert guards.delivery_claim_check("I already told you about the gateway.", ("",)) is not None
    for reply in ("I already told you", "told you", "…—;:!?()[]", "I've mentioned " * 200):
        guards.delivery_claim_check(reply, DELIVERED)
        guards.delivery_claim_check(reply, [])


def test_delivery_is_pure_same_inputs_same_verdict():
    reply = "I already told you about the gateway."
    assert guards.delivery_claim_check(reply, []) == guards.delivery_claim_check(reply, [])


# -- novelty_claim_check ----------------------------------------------------


REPEATED = {"the beat 'watch' has failed 4 times in a row — it pauses itself at 5": 3}


def test_a_novelty_claim_about_a_repeat_is_corrected_with_the_count():
    correction = guards.novelty_claim_check(
        "The watch beat has failed again. This is new.", REPEATED
    )
    assert correction is not None
    assert kinds(correction) == ["unbacked_novelty"]
    assert correction.text == guards.NOVELTY_CLAIM_CORRECTION.format(repeats=3)
    assert "3 times" in correction.text


def test_a_first_sighting_is_clean():
    assert (
        guards.novelty_claim_check(
            "The watch beat has failed. This is new.",
            {"the beat 'watch' has failed 4 times in a row": 1},
        )
        is None
    )


def test_a_reply_that_also_names_a_new_finding_is_clean():
    """A digest naming both a standing fault and a fresh one is the ordinary
    case — the novelty claim can honestly be about the fresh one."""
    mixed = dict(REPEATED)
    mixed["the gateway did not answer /health"] = 1
    assert (
        guards.novelty_claim_check(
            "The watch beat failed and the gateway is down — this is new.", mixed
        )
        is None
    )


@pytest.mark.parametrize(
    "reply",
    [
        "The watch beat failed. This is new.",
        "The watch beat failed. That's new.",
        "The watch beat has failed for the first time.",
        "This is the first time the watch beat has failed.",
        "I've never seen this before — the watch beat failed.",
        "A new failure: the watch beat.",
    ],
)
def test_every_novelty_shape_is_read(reply):
    assert guards.novelty_claim_check(reply, REPEATED) is not None, reply


NOVELTY_MUST_NOT_FIRE = [
    ("negated", "The watch beat failed. That is not new."),
    ("question", "The watch beat failed. Is this new?"),
    ("hedged", "The watch beat failed. This might be new."),
    ("i_think", "The watch beat failed. I think this is new."),
    ("reported", "You said the watch beat failure is new."),
    ("unrelated_subject", "The gateway is down. This is new."),
    ("no_novelty_claim", "The watch beat has failed 4 times in a row."),
    ("one_word_overlap", "The beat is fine. This is new."),
]


@pytest.mark.parametrize(
    "label,reply", NOVELTY_MUST_NOT_FIRE, ids=[c[0] for c in NOVELTY_MUST_NOT_FIRE]
)
def test_novelty_must_not_fire_on_honest_replies(label, reply):
    assert guards.novelty_claim_check(reply, REPEATED) is None, (
        f"{label!r} was wrongly corrected — a false positive makes the guard the liar"
    )


def test_novelty_is_clean_over_its_own_correction():
    text = guards.NOVELTY_CLAIM_CORRECTION.format(repeats=4)
    assert guards.novelty_claim_check(text, REPEATED) is None


def test_novelty_empty_and_odd_inputs():
    assert guards.novelty_claim_check("This is new.", {}) is None
    assert guards.novelty_claim_check("", REPEATED) is None
    assert guards.novelty_claim_check("   ", REPEATED) is None
    assert guards.novelty_claim_check("This is new.", {"": 5}) is None
    assert guards.novelty_claim_check("This is new.", {"watch beat failed": None}) is None
    for reply in ("this is new", "new", "…—;:!?()[]", "the watch beat failed " * 200):
        guards.novelty_claim_check(reply, REPEATED)


def test_novelty_is_pure_same_inputs_same_verdict():
    reply = "The watch beat failed. This is new."
    assert guards.novelty_claim_check(reply, REPEATED) == guards.novelty_claim_check(
        reply, REPEATED
    )


# -- model_wrote_nothing: the structural detector ---------------------------


def test_no_llm_call_spans_is_indeterminate_not_silence():
    """The safety property: a True SUPPRESSES a report, so an unreadable trace
    must never read as "the model was silent"."""
    assert guards.model_wrote_nothing([]) is False
    assert guards.model_wrote_nothing([tool_span("workspace_read_file", path="a.md")]) is False


def test_a_round_recorded_at_zero_characters_is_the_backend_writing():
    assert guards.model_wrote_nothing([llm_span(**{guards.COMPLETION_CHARS_FIELD: 0})]) is True


def test_an_empty_round_class_is_a_recorded_zero():
    """chat.py writes EMPTY_ROUND only when a round produced no content, no
    tool calls and no stated error — a mechanical zero, and the shape the v3
    push had behind it."""
    assert guards.model_wrote_nothing([llm_span(error_class=chat.EMPTY_ROUND)]) is True


def test_the_empty_round_class_is_pinned_to_chat():
    """Mirrored as a literal because chat imports guards; if it is renamed this
    reddens instead of the detector silently never matching."""
    assert guards._EMPTY_ROUND_CLASS == chat.EMPTY_ROUND


def test_any_round_that_wrote_something_clears_the_whole_turn():
    assert guards.model_wrote_nothing([llm_span(**{guards.COMPLETION_CHARS_FIELD: 12})]) is False
    assert (
        guards.model_wrote_nothing(
            [
                llm_span(error_class=chat.EMPTY_ROUND),
                llm_span(**{guards.COMPLETION_CHARS_FIELD: 40}),
            ]
        )
        is False
    )
    # completion_tokens is read ONLY as "not zero" — never as a zero.
    assert guards.model_wrote_nothing([llm_span(completion_tokens=7)]) is False
    assert guards.model_wrote_nothing([llm_span(completion_tokens=0)]) is False


def test_a_round_whose_size_cannot_be_read_is_indeterminate():
    """A gateway failure may have streamed text before it broke, and a span
    with nothing on it states nothing at all."""
    assert guards.model_wrote_nothing([llm_span(error_class="GatewayFailure")]) is False
    assert guards.model_wrote_nothing([llm_span(round=1, model="qwen3:14b")]) is False
    assert (
        guards.model_wrote_nothing(
            [llm_span(**{guards.COMPLETION_CHARS_FIELD: 0}), llm_span(round=2)]
        )
        is False
    )


def test_a_boolean_is_not_a_character_count():
    assert guards.model_wrote_nothing([llm_span(**{guards.COMPLETION_CHARS_FIELD: False})]) is False


def test_the_all_clear_verdict_is_checks_quiet_and_not_a_second_copy():
    """Whatever `checks.quiet` calls clear, this guard calls clear, over every
    combination of ran/found — one implementation of quiet, so a beat's own
    verdict and the sentence it is allowed to write can never disagree."""
    matrix = [
        [],
        [check_run("a")],
        [check_run("a"), check_run("b")],
        [check_run("a", ran=False, reason="no answer")],
        [check_run("a"), check_run("b", ran=False, reason="no answer")],
        [check_run("a", findings=(GATEWAY_DOWN,))],
        [check_run("a", findings=(GATEWAY_DOWN,)), check_run("b", ran=False, reason="no answer")],
    ]
    for runs in matrix:
        clear = checks.quiet(runs)[0]
        fired = guards.observation_check("All clear.", [], runs) is not None
        assert fired is not clear, [run.check for run in runs]


# -- the precision crux: the digest relaying the checks' OWN sentences -------
#
# Every entry is a real title app/checks/ composes, beside the real facts the
# same check returns. A digest reads these back to the owner verbatim, so a
# correction under ANY of them would put "no check produced that" under the
# check's own words — the guard becoming the liar about the one message he
# reads. Copied from the families rather than imported so that a check whose
# facts stop naming its own subject reddens here instead of shipping.
REAL_FINDING_SENTENCES = [
    (
        "peer_down",
        "The gateway did not answer /health — ConnectError: connection refused.",
        finding(
            "peer_down:gateway",
            peer="gateway",
            url="http://gateway:8081/health",
            probe="/health",
            reason="ConnectError: connection refused",
        ),
    ),
    (
        "database_down",
        "The database did not answer SELECT 1 within 5s.",
        finding("database_down", probe="SELECT 1", reason="no answer within 5s"),
    ),
    (
        "ollama_down",
        "Ollama did not answer the gateway — the source reported no models.",
        finding(
            "peer_down:ollama",
            peer="ollama",
            reason="the source reported no models",
            basis="the gateway's own model catalogue source entry",
        ),
    ),
    (
        "chat_model_unset",
        "No chat model is set (Settings → Models) — every scheduled turn refuses until one is.",
        finding("chat_model_unset", setting="chat.model", value="", reason="unset"),
    ),
    (
        "chat_model_missing",
        "The chat model qwen3:14b is listed but not installed.",
        finding(
            "chat_model_missing:qwen3:14b",
            setting="chat.model",
            model="qwen3:14b",
            reason="the gateway's catalogue lists it as not installed",
        ),
    ),
    (
        "timer_paused",
        "The beat 'watch' is paused since 2026-09-08T03:00:00 — 5 consecutive failures.",
        TIMER_PAUSED,
    ),
    (
        "timer_failing",
        "The timer 'nightly backup' has failed 4 times in a row — it pauses itself at 5.",
        finding(
            "timer_failing:8b1f0a2e-0000-4000-8000-000000000002",
            timer_id="8b1f0a2e-0000-4000-8000-000000000002",
            kind="timer",
            consecutive_failures=4,
            pause_ceiling=5,
        ),
    ),
    (
        "delegation_failed",
        "The delegation to coder failed 3 times — RuntimeError: the agent has no model.",
        finding(
            "delegation_failed:8b1f0a2e-0000-4000-8000-000000000003",
            span_id="8b1f0a2e-0000-4000-8000-000000000003",
            turn_id="8b1f0a2e-0000-4000-8000-000000000004",
            agent="coder",
            at="2026-09-08T03:00:00+00:00",
            error="RuntimeError: the agent has no model",
        ),
    ),
    (
        "agent_over_cap",
        "Agent coder is over its monthly cap — $22.10 of $20.00 in 2026-09.",
        finding(
            "agent_over_cap:coder",
            agent="coder",
            role="coder",
            cap_usd=20.0,
            month="2026-09",
            month_zone="America/Chicago",
        ),
    ),
    (
        "spend_over_cap_total",
        "Household model spend is over the monthly cap — $41.00 of $40.00 in 2026-09.",
        finding("spend_over_cap:total", scope="total", cap_usd=40.0, month="2026-09"),
    ),
    (
        "provider_walled",
        "Openrouter is walled until 2026-09-08T05:00:00 after 2 refusal(s) — 402 payment required.",
        finding("provider_walled:openrouter", provider="openrouter", status=402, strikes=2),
    ),
    (
        "spend_spike",
        "2026-09-07 cost $12.00 — 6.0x against $2.00/day over the previous 7 day(s).",
        finding(
            "spend_spike:2026-09-07",
            day="2026-09-07",
            usd=12.0,
            trailing_days=7,
            trailing_mean_usd=2.0,
            multiple=6.0,
            threshold_multiple=3.0,
        ),
    ),
]


@pytest.mark.parametrize(
    "label,sentence,found",
    REAL_FINDING_SENTENCES,
    ids=[case[0] for case in REAL_FINDING_SENTENCES],
)
def test_a_digest_relaying_a_real_findings_own_title_is_clean(label, sentence, found):
    runs = [check_run(label, findings=(found,))]
    assert guards.observation_check(sentence, [found], runs) is None, (
        f"{label!r}: the check's own sentence was corrected — the guard would be "
        "the liar about the one message he reads"
    )


@pytest.mark.parametrize(
    "label,sentence,found",
    REAL_FINDING_SENTENCES,
    ids=[case[0] for case in REAL_FINDING_SENTENCES],
)
def test_the_same_sentence_with_nothing_found_is_a_fabrication(label, sentence, found):
    """The other half of the derivation: the identical sentence, with the pass
    that produced it taken away, is exactly the lie this guard exists for.

    Four of the twelve are accepted MISSES, each for a stated family rule
    rather than an accident: "listed but not installed" and "no chat model is
    set" put their negation in the subject, so no fault predicate is asserted
    at all; a cost figure asserts no fault; and the ollama line carries a
    reporting frame ("the source reported...") which exempts its whole clause,
    the same leniency every guard in this file gives relayed content."""
    fired = guards.observation_check(sentence, [], ALL_RAN_CLEAN) is not None
    quiet_shapes = {"chat_model_missing", "chat_model_unset", "spend_spike", "ollama_down"}
    assert fired is (label not in quiet_shapes), label


# -- every correction, under every new guard --------------------------------
#
# DERIVED from the module, not a list kept here: a correction added to
# guards.py tomorrow is checked the day it lands. A guard that fires on another
# guard's correction would append a contradiction to a contradiction, and the
# owner would read two sentences arguing with each other about a night he did
# not watch.


def _every_correction() -> list[tuple[str, str]]:
    out = []
    for name in dir(guards):
        if "CORRECTION" not in name:
            continue
        value = getattr(guards, name)
        if not isinstance(value, str):
            continue
        # `machine` (S40b): the state guard's machine correction names the
        # machine it did not check, so its template joins the tripwire here.
        # `served`, `claimed` and `tool` (S40b T2): the served-model
        # correction names the model that wrote the reply and the one claimed,
        # and the memory correction the memory tool that answered.
        # `subject` (S42b): the update correction names the machine no
        # machine_update call confirmed, and the ones it did.
        out.append(
            (
                name,
                value.format(
                    agent="coder",
                    repeats=4,
                    unrun=1,
                    total=3,
                    found=2,
                    machine="hub",
                    served="hub:qwen3:8b",
                    claimed="qwen3.8:27b",
                    tool="memory_search",
                    subject="an update of a machine named hub (it confirmed minipc's)",
                ),
            )
        )
    return sorted(out)


@pytest.mark.parametrize("name,text", _every_correction(), ids=[c[0] for c in _every_correction()])
def test_the_new_guards_are_clean_over_every_correction_in_this_module(name, text):
    assert guards.observation_check(text, [], ONE_DID_NOT_RUN) is None, name
    assert guards.observation_check(text, [], []) is None, name
    assert guards.observation_check(text, [GATEWAY_DOWN], FOUND_SOMETHING) is None, name
    assert guards.delivery_claim_check(text, []) is None, name
    assert guards.novelty_claim_check(text, REPEATED) is None, name


# -- deleted a file (S16) --------------------------------------------------
#
# She told the owner "there is no delete operation in my toolbox" and was
# right. Now there is one, so a claimed deletion becomes a claim the trace can
# contradict — and she has faked a deletion before, which is why the tool
# arriving without this guard would be half the work.


def test_a_delete_claim_with_no_delete_span_is_flagged():
    reply = "I've deleted groceries.md for you."
    correction = guards.narration_check(reply, [other_span("memory_recall"), other_span()])
    assert correction is not None
    assert kinds(correction) == ["deleted_file"]
    assert targets(correction) == ["groceries.md"]


def test_a_delete_claim_with_a_matching_span_is_not_flagged():
    reply = "I've deleted groceries.md for you."
    spans = [tool_span("workspace_delete", path="groceries.md")]
    assert guards.narration_check(reply, spans) is None


def test_a_delete_claim_is_not_backed_by_a_write_span():
    reply = "I removed old-notes.md from the workspace."
    spans = [tool_span("workspace_write_file", path="old-notes.md")]
    correction = guards.narration_check(reply, spans)
    assert correction is not None
    assert kinds(correction) == ["deleted_file"]


def test_deleting_one_file_does_not_back_a_claim_about_another():
    reply = "I deleted groceries.md."
    spans = [tool_span("workspace_delete", path="shopping.md")]
    correction = guards.narration_check(reply, spans)
    assert correction is not None
    assert targets(correction) == ["groceries.md"]


def test_a_failed_delete_span_does_not_back_the_claim():
    reply = "I deleted groceries.md."
    spans = [tool_span("workspace_delete", ok=False, path="groceries.md")]
    assert guards.narration_check(reply, spans) is not None


def test_removing_a_model_is_still_a_model_claim_not_a_file_one():
    """A model ref carries a tag, a filename carries an extension. The two
    anchors do not overlap, and this pins that they never start to."""
    reply = "I removed qwen3:14b."
    spans = [tool_span("model_remove", model="qwen3:14b")]
    assert guards.narration_check(reply, spans) is None


def test_an_offer_to_delete_is_not_a_claim():
    reply = "Would you like me to delete groceries.md?"
    assert guards.narration_check(reply, []) is None


def test_a_future_delete_is_not_a_claim():
    reply = "I'll delete groceries.md once you confirm."
    assert guards.narration_check(reply, []) is None


def test_a_stated_delete_failure_is_not_a_claim():
    reply = "I could not delete groceries.md — it is not in the workspace."
    assert guards.narration_check(reply, []) is None


def test_a_deletion_attributed_to_the_owner_is_not_a_self_claim():
    reply = "You deleted groceries.md earlier, so there is nothing there now."
    assert guards.narration_check(reply, []) is None


def test_a_bare_noun_deletion_is_never_a_claim():
    """Precision first: without a filename token there is no target, and an
    ordinary sentence must not become a correction."""
    reply = "I deleted the duplicates we talked about."
    assert guards.narration_check(reply, []) is None


def test_a_passive_deletion_claim_is_flagged():
    reply = "groceries.md has been deleted."
    correction = guards.narration_check(reply, [other_span()])
    assert correction is not None
    assert kinds(correction) == ["deleted_file"]


def test_a_passive_deletion_claim_with_a_delete_span_is_not_flagged():
    reply = "groceries.md has been deleted."
    spans = [tool_span("workspace_delete", path="groceries.md")]
    assert guards.narration_check(reply, spans) is None


# ── the serving-state claim (S19) ──────────────────────────────────────────
#
# From the owner's own chat on 2026-09-12: two turns timed out at the
# gateway's read limit, each persisting its honest failure statement, and the
# NEXT turn — which the model answered — reported the stack as broken and
# listed curl commands to run. The reply's existence is the proof it was
# wrong: a reply exists because the model served this turn.


def _llm_span(**meta):
    # The same duck-typed stand-in the rest of this suite uses: the guard reads
    # kind, name and meta and nothing else.
    return SimpleNamespace(kind="llm_call", name="qwen3:8b", meta={"purpose": "chat", **meta})


SERVED = [_llm_span(round=1, completion_chars=40)]
DID_NOT_SERVE = [_llm_span(round=1, error="nothing arrived from the gateway for 300 s")]


@pytest.mark.parametrize(
    "reply",
    [
        "The model qwen3:8b is unreachable and Ollama is walled for 4 minutes.",
        "The gateway is down, so nothing can run.",
        "Ollama is not responding right now.",
        "The model is still offline.",
        "I can't reach the model.",
        "The inference service is unavailable.",
    ],
)
def test_a_present_tense_serving_claim_is_contradicted_when_the_model_just_answered(reply):
    claim = guards.stack_claim_check(reply, SERVED, purpose="chat")
    assert claim is not None
    assert "answered this turn" in claim.text


@pytest.mark.parametrize(
    "reply",
    [
        # Past: true, and correcting it would make the guard the liar.
        "The model was unreachable a moment ago, so that turn ran nothing.",
        "Ollama had been walled when you asked earlier.",
        # Hedged or conditional: nothing is asserted about now.
        "If the gateway is down, I will say so.",
        "The model may be unreachable — I can check.",
        # A question asserts no state.
        "Is the gateway down?",
        # About something else entirely.
        "The device is offline.",
        "The file is unreachable at that path.",
    ],
)
def test_an_honest_or_hedged_form_is_left_alone(reply):
    assert guards.stack_claim_check(reply, SERVED, purpose="chat") is None


# S40b (verdict §3.1 B): the serving pattern reused the device guard's adverbs,
# which carry "not" and "no longer" — right for a device ("the device is not
# connected" is an unchecked claim about now), wrong here, where every state
# word means "cannot answer". So "not down" read as "down" and an honest
# report that the model IS answering was replaced by a correction saying so.
# "not responding" and "not working" are state words of their own and still
# fire (the MUST_FIRE set above is unchanged).
STACK_NEGATIONS = (
    "The model is not down.",
    "The gateway is no longer unreachable.",
    "The model is not unreachable — it answered.",
)


@pytest.mark.parametrize("reply", STACK_NEGATIONS)
def test_a_negated_outage_is_not_an_outage_claim(reply):
    assert guards.stack_claim_check(reply, SERVED, purpose="chat") is None


def test_the_serving_adverbs_are_the_state_adverbs_without_the_negations():
    """Derived, so the two cannot drift: every adverb the device guard allows
    except the two that negate.

    Pin moved in the S40b final fix wave (C13): the serving set was made by
    string surgery on _STATE_ADVERB and pinned by a substring test, so an
    adverb such as "notably" added there would have become "ably" here and
    the pin would have gone red for the wrong reason. Both are built from one
    tuple now, and the sets are pinned by name."""
    negating = {"not", "no\\s+longer"}
    serving = {
        "still",
        "currently",
        "now",
        "again",
        "apparently",
        "probably",
        "likely",
        "definitely",
        "back",
        "already",
        "actually",
        "indeed",
    }
    assert set(guards._STATE_ADVERBS) == serving | negating
    assert set(guards._NEGATING_ADVERBS) == negating
    assert set(guards._SERVING_ADVERBS) == serving
    for adverb in ("still", "currently", "now", "again", "apparently", "back", "actually"):
        assert re.fullmatch(guards._SERVING_ADVERB, adverb), adverb
    for negation in ("not", "no longer"):
        assert re.fullmatch(guards._STATE_ADVERB, negation)
        assert not re.fullmatch(guards._SERVING_ADVERB, negation)
    # The whole-word shape holds: a word merely starting with an adverb is not one.
    for word in ("notably", "nowhere", "stillness"):
        assert not re.fullmatch(guards._STATE_ADVERB, word), word


def test_a_turn_the_model_did_not_serve_is_not_second_guessed():
    """No successful round means no evidence, and a guard with no evidence has
    nothing to say. (In practice such a turn has no reply to judge — the
    failure statement is composed by the backend — but the guard must not
    depend on that.)"""
    assert (
        guards.stack_claim_check("The model is unreachable.", DID_NOT_SERVE, purpose="chat") is None
    )


def test_a_judge_round_alone_does_not_count_as_having_served():
    """The responsiveness judge and the redirect regeneration are llm_call
    spans too. Only a CHAT round is evidence that the reply in hand came from
    the model."""
    judge = [SimpleNamespace(kind="llm_call", name="qwen3:8b", meta={"purpose": "judge"})]
    assert guards.stack_claim_check("The model is unreachable.", judge, purpose="chat") is None


@pytest.mark.parametrize("kind", ["chat", "eval"])
def test_a_round_of_the_turns_own_kind_is_the_evidence_where_the_guard_is_armed(kind):
    """A turn's own rounds are recorded under its KIND (traces.purpose_of), not
    under the word 'chat'. An eval replays chat's path with nothing injected
    (the kind tag is its only eval-ness), so its own rounds are the evidence
    there exactly as a chat round is in chat. Reading only 'chat' left every
    eval case scoring guard_absent('stack_claim') green by construction,
    whatever the model said (found by S40 T7's corpus test, 2026-09-19). A
    judge round is still no evidence."""
    own = [SimpleNamespace(kind="llm_call", name="qwen3:8b", meta={"purpose": kind})]
    assert guards.stack_claim_check("The model is unreachable.", own, purpose=kind) is not None
    judge = [SimpleNamespace(kind="llm_call", name="qwen3:8b", meta={"purpose": "judge"})]
    assert guards.stack_claim_check("The model is unreachable.", judge, purpose=kind) is None


def test_the_guard_is_armed_in_chat_and_in_the_eval_that_replays_it_and_nowhere_else():
    """The kinds the serving-state guard runs in are the kinds its precision
    was MEASURED in. Arming another is a deliberate move: measure its MUST_NOT
    set in that kind first (see the test below), then change this pin.

    The eval's kind is read from the runner, not restated: an eval that did
    not run the guard it scores would score it green by construction again."""
    from app.evals import runner

    assert guards.STACK_CLAIM_KINDS == frozenset({"chat", runner.EVAL_TURN_KIND})
    assert traces.purpose_of(SimpleNamespace(kind="chat")) in guards.STACK_CLAIM_KINDS


# The S40 T7 review's probe (2026-09-19): three TRUE reports, each of which the
# guard contradicted once it read scheduled and agent turns. A REPLACE-class
# correction there is read by nobody live, so the persisted row became
# "Correction: the model answered this turn … Whatever was asked for can be
# attempted." and the real outage report was gone. S40 makes the last two
# reachable: a scheduled "check my machines" turn answered by a cloud link
# while hub is down.
TRUE_OUTAGE_REPORTS = (
    "Your website's backend is down — the fetch returned 502.",
    "The local model is unavailable, so a cloud model answered.",
    "Ollama is not responding right now, so chat went to the cloud.",
)


@pytest.mark.parametrize("reply", TRUE_OUTAGE_REPORTS)
@pytest.mark.parametrize("kind", ["scheduled", "agent", "beat"])
def test_a_true_outage_report_in_an_unmeasured_kind_is_never_contradicted(kind, reply):
    """MUST_NOT, in every kind the guard is not armed in — and not only for
    these sentences: nothing it says there has been measured, so it says
    nothing. Carried (slice-40-carries): arming scheduled and agent turns,
    with the pattern tightened so a third party's subject and a true statement
    about another engine stay silent; the owner's question is in the carry."""
    own = [SimpleNamespace(kind="llm_call", name="qwen3:8b", meta={"purpose": kind})]
    assert guards.stack_claim_check(reply, own, purpose=kind) is None
    assert guards.stack_claim_check("The model is unreachable.", own, purpose=kind) is None


def test_the_claim_names_what_it_matched_for_the_span():
    claim = guards.stack_claim_check("The gateway is down.", SERVED, purpose="chat")
    assert claim.subject
    assert "down" in claim.phrase


# -- stack-claim epic T1: the OTHER machines a turn's spans name --------------
#
# Live turn 07076682 (2026-10-07, "start the dell's ollama", cloud-served on
# openrouter): she read the Dell and said she "can't reach Ollama" — true of
# the Dell — and stack_claim replaced her whole reply. The machines and
# devices a claim can be ABOUT come from the turn's own spans, never a list.


def _tool_span(name, *, ok=True, reached=True, args=None, facts=None):
    meta = {"ok": ok, "reached_executor": reached, "args_redacted": args or {}}
    if facts is not None:
        meta["facts"] = facts
    return SimpleNamespace(kind="tool", name=name, meta=meta)


def _cloud_round(n):
    return _llm_span(
        round=n,
        completion_chars=200,
        local=False,
        served_by="openrouter:anthropic/claude-haiku-5.5",
    )


# The live turn's device_list span as recorded (facts + result_head): every
# paired device, the hub's own computer included — its line says its agent
# came in through the hub machine's own door.
LIVE_DEVICE_LIST = SimpleNamespace(
    kind="tool",
    name="device_list",
    meta={
        "ok": True,
        "reached_executor": True,
        "args_redacted": {},
        "facts": [
            {"device": "Beelink Mini S", "connected": True},
            {"device": "DELL-XPS-8950", "connected": True},
        ],
        "result_head": (
            "Paired devices:\n"
            "- Beelink Mini S (Pop!_OS 24.04 LTS) — connected, last seen "
            "2026-10-07T19:57:51.098892+00:00; its agent came in through the hub machine's "
            "own door; agent 0b5f4341b84c (the hub's build); folders: @home, @desktop, "
            "@documents, @downloads\n"
            "- DELL-XPS-8950 (Windows 11) — connected, last seen "
            "2026-10-07T19:57:40.000000+00:00; agent 0b5f4341b84c (the hub's build)"
        ),
    },
)


def _dell_status(*, answering):
    return _tool_span(
        "machine_status",
        args={"machine": "dell"},
        facts=[
            {
                "machine": "dell",
                "device": "DELL-XPS-8950",
                "state": "walled" if not answering else "ok",
                "answering": answering,
            }
        ],
    )


LIVE_DELL_SPANS = [
    _cloud_round(1),
    LIVE_DEVICE_LIST,
    _cloud_round(2),
    _dell_status(answering=False),
    _cloud_round(3),
    _tool_span("device_launch_app", ok=False, args={"device": "DELL-XPS-8950", "app": "ollama"}),
    _cloud_round(4),
    _tool_span("device_list_apps", args={"device": "DELL-XPS-8950"}),
    _tool_span("device_run", args={"device": "DELL-XPS-8950", "command": "where ollama"}),
    _tool_span("device_run", args={"device": "DELL-XPS-8950", "command": "netstat -ano"}),
    _tool_span("device_run", args={"device": "DELL-XPS-8950", "command": "tasklist"}),
    _cloud_round(5),
    _cloud_round(6),
]


def test_other_machine_names_from_the_live_dell_turn():
    names = guards.other_machine_names(LIVE_DELL_SPANS, "chat")
    assert "dell" in names
    assert "DELL-XPS-8950" in names


def test_other_machine_names_is_empty_for_a_served_turn_alone():
    assert guards.other_machine_names(SERVED, "chat") == ()


def _engine_round(head, n=1):
    return _llm_span(round=n, completion_chars=80, local=True, served_by=f"{head}:qwen3:8b")


def test_other_machine_names_drops_the_machine_that_wrote_the_reply():
    spans = [
        _engine_round("hub"),
        _tool_span(
            "machine_status",
            args={"machine": ""},
            facts=[{"machine": "hub"}, {"machine": "dell"}],
        ),
    ]
    names = guards.other_machine_names(spans, "chat")
    assert "dell" in names
    assert "hub" not in names


def test_other_machine_names_reads_device_args_only_when_the_executor_ran():
    refused = [
        SERVED[0],
        _tool_span("device_run", ok=False, reached=False, args={"device": "ghost-pc"}),
    ]
    assert "ghost-pc" not in guards.other_machine_names(refused, "chat")
    launched = [
        SERVED[0],
        _tool_span("device_launch_app", ok=False, reached=True, args={"device": "DELL-XPS-8950"}),
    ]
    assert "DELL-XPS-8950" in guards.other_machine_names(launched, "chat")


def test_other_machine_names_reads_any_tool_facts_device_sorted_and_unique():
    spans = [
        SERVED[0],
        _tool_span(
            "device_list",
            facts=[{"device": "Beelink Mini S"}, {"device": "DELL-XPS-8950"}, {"device": "x"}],
        ),
        _tool_span("device_run", args={"device": "DELL-XPS-8950"}),
    ]
    names = guards.other_machine_names(spans, "chat")
    assert "Beelink Mini S" in names
    assert "DELL-XPS-8950" in names
    assert "x" not in names
    assert isinstance(names, tuple)
    assert list(names) == sorted(set(names))


def test_other_machine_names_subtracts_only_the_reply_rounds_engine():
    spans = [
        _engine_round("dell", n=1),
        _engine_round("hub", n=2),
    ]
    names = guards.other_machine_names(spans, "chat")
    assert "dell" in names
    assert "hub" not in names


def test_other_machine_names_the_reply_round_is_own_purpose_only():
    # A later round of another purpose did not write the reply: the chat
    # round's engine is the one subtracted, the other round's is not.
    other = SimpleNamespace(
        kind="llm_call",
        name="qwen3:8b",
        meta={"purpose": "memory", "round": 2, "local": True, "served_by": "hub:qwen3:8b"},
    )
    names = guards.other_machine_names([_engine_round("dell"), other], "chat")
    assert "dell" not in names
    assert "hub" in names


def test_other_machine_names_the_reply_round_is_error_free_only():
    # A failed last round wrote nothing: the reply came from the hub round.
    failed = _llm_span(round=2, error="boom", local=True, served_by="dell:qwen3:8b")
    spans = [
        _engine_round("hub"),
        failed,
        _tool_span("machine_status", facts=[{"machine": "hub"}, {"machine": "dell"}]),
    ]
    names = guards.other_machine_names(spans, "chat")
    assert "dell" in names
    assert "hub" not in names


def test_other_machine_names_reads_the_device_arg_of_device_tools_only():
    spans = [
        SERVED[0],
        _tool_span("web_fetch", args={"device": "ghost-pc"}),
        _tool_span("device_run", args={"device": "  DELL-XPS-8950  "}),
    ]
    names = guards.other_machine_names(spans, "chat")
    assert "ghost-pc" not in names
    assert "DELL-XPS-8950" in names


# -- stack-claim epic T2: a claim about ANOTHER machine's model server -------
#
# Orchestrator decision after T2 VERIFY FAIL: a remote machine excuses a stack
# claim only when (a) it QUALIFIES the claim's subject ("the Dell's Ollama",
# "Ollama on the Dell", "the Dell Ollama", or the machine IS the subject), or
# (b) the subject is bare and this turn's machine_status recorded a remote
# model machine NOT answering, with no own-stack marker. A name elsewhere in
# the clause excuses nothing; the hub's own computer is never another machine;
# a gateway claim is never excused.

# The live turn, but the Dell answering: no not-answering fact, so rule (b)
# cannot apply and only a qualifier excuses.
DELL_ANSWERING_SPANS = [
    _dell_status(answering=True) if span.name == "machine_status" else span
    for span in LIVE_DELL_SPANS
]
# The live turn without its machine_status read: devices named, no fact.
DELL_DEVICES_ONLY_SPANS = [span for span in LIVE_DELL_SPANS if span.name != "machine_status"]

QUALIFIED_BY_THE_DELL = [
    "I can't reach Ollama on the Dell.",
    "The Dell's Ollama is down.",
    "The Dell's Ollama is not responding.",
    "The Dell's Ollama isn't running.",
    "Ollama on DELL-XPS-8950 is not responding.",
    "Ollama on DELL-XPS-8950 is unreachable.",
    "The model on the dell is unreachable.",
    "Ollama is unreachable on DELL-XPS-8950.",
    "The model is unreachable on the Dell.",
    "I can't reach Ollama on DELL-XPS-8950.",
    "Ollama is down at the Dell.",
    "The Dell Ollama is not responding.",
    "The Dell is unreachable.",
]


@pytest.mark.parametrize("reply", QUALIFIED_BY_THE_DELL)
@pytest.mark.parametrize(
    "spans",
    [LIVE_DELL_SPANS, DELL_ANSWERING_SPANS],
    ids=["live", "dell-answering"],
)
def test_stack_claim_excuses_a_subject_qualified_by_another_machine(reply, spans):
    assert guards.stack_claim_check(reply, spans, purpose="chat") is None


@pytest.mark.parametrize(
    "reply",
    [
        "I can't reach Ollama on DELL-XPS-8950.",
        "Ollama is unreachable on DELL-XPS-8950.",
        "The DELL-XPS-8950's Ollama is down.",
    ],
)
def test_stack_claim_excuses_a_subject_qualified_by_a_device_the_turn_used(reply):
    # No machine_status read: the device the turn's device_* calls named is
    # another machine all the same ("dell" alone is not a name here).
    assert guards.stack_claim_check(reply, DELL_DEVICES_ONLY_SPANS, purpose="chat") is None


@pytest.mark.parametrize(
    "reply",
    [
        "I can't reach Ollama on the Dell.",
        "The Dell's Ollama is down.",
        "The Dell's Ollama is not responding.",
        "Ollama is unreachable on DELL-XPS-8950.",
        "The model is unreachable on the Dell.",
        "I can't reach Ollama on DELL-XPS-8950.",
        "Ollama is down at the Dell.",
        "The Dell Ollama is not responding.",
    ],
)
def test_stack_claim_naming_a_machine_no_span_names_still_fires(reply):
    # The excuse is derived from the spans, never from the words themselves.
    assert guards.stack_claim_check(reply, SERVED, purpose="chat") is not None


@pytest.mark.parametrize(
    "reply",
    [
        "Ollama on DELL-XPS-8950 is not responding.",
        "The model on the dell is unreachable.",
        "The Dell's Ollama isn't running.",
        "The Dell is unreachable.",
    ],
)
def test_stack_claim_non_matching_named_forms_stay_silent_with_served(reply):
    # Guard pin: these never matched the serving patterns; still None.
    assert guards.stack_claim_check(reply, SERVED, purpose="chat") is None


@pytest.mark.parametrize(
    "reply",
    [
        "I can't reach Ollama, so I checked DELL-XPS-8950.",
        "The model is unreachable, so I checked the Dell.",
        "I can't reach the model, unlike the Dell.",
        "The gateway is down and the Dell is fine.",
    ],
)
@pytest.mark.parametrize(
    "spans",
    [DELL_ANSWERING_SPANS, DELL_DEVICES_ONLY_SPANS],
    ids=["dell-answering", "devices-only"],
)
def test_stack_claim_a_name_elsewhere_in_the_clause_excuses_nothing(reply, spans):
    # VERIFY's escapes: the name does not qualify the subject, so the claim is
    # about her own stack and still fires.
    assert guards.stack_claim_check(reply, spans, purpose="chat") is not None


@pytest.mark.parametrize(
    "reply",
    [
        "The gateway is down and the Dell is fine.",
        "The gateway is down on the Dell.",
        "I can't reach the gateway on DELL-XPS-8950.",
        "The Dell's gateway is unreachable.",
    ],
)
def test_stack_claim_a_gateway_claim_is_never_excused(reply):
    assert guards.stack_claim_check(reply, LIVE_DELL_SPANS, purpose="chat") is not None


def test_stack_claim_own_stack_claim_beside_another_machine_clause_still_fires():
    reply = "The model is unreachable; the Dell is fine."
    assert guards.stack_claim_check(reply, DELL_ANSWERING_SPANS, purpose="chat") is not None


def test_other_machine_names_excludes_the_hubs_own_device():
    # device_list names every paired device; the one whose agent came in
    # through the hub machine's own door is her own computer, not another.
    names = guards.other_machine_names(LIVE_DELL_SPANS, "chat")
    assert "Beelink Mini S" not in names
    assert "DELL-XPS-8950" in names
    assert "dell" in names


@pytest.mark.parametrize(
    "reply",
    [
        "Ollama is unreachable on Beelink Mini S.",
        "I can't reach Ollama on the Beelink Mini S.",
        "I can't reach Ollama, so I checked Beelink Mini S.",
    ],
)
@pytest.mark.parametrize(
    "spans",
    [LIVE_DELL_SPANS, DELL_ANSWERING_SPANS],
    ids=["live", "dell-answering"],
)
def test_stack_claim_naming_the_hubs_own_device_still_fires(reply, spans):
    # Qualified by her own computer, the subject is neither another machine's
    # nor bare: no excuse applies even while the Dell is not answering.
    assert guards.stack_claim_check(reply, spans, purpose="chat") is not None


@pytest.mark.parametrize(
    "reply",
    [
        "I can't reach Ollama.",
        "Ollama is not responding right now.",
        "The model is unreachable.",
        "I can't reach the model.",
    ],
)
def test_stack_claim_excuses_a_bare_subject_while_a_remote_machine_is_not_answering(reply):
    # Rule (b), the live shape: cloud-served, machine_status recorded the Dell
    # not answering, and she said "I can't reach Ollama" with no qualifier.
    assert guards.stack_claim_check(reply, LIVE_DELL_SPANS, purpose="chat") is None


@pytest.mark.parametrize(
    "reply",
    [
        "I can't reach Ollama.",
        "Ollama is not responding right now.",
        "The model is unreachable.",
    ],
)
@pytest.mark.parametrize(
    "spans",
    [DELL_ANSWERING_SPANS, DELL_DEVICES_ONLY_SPANS, SERVED],
    ids=["dell-answering", "devices-only", "served"],
)
def test_stack_claim_a_bare_subject_fires_without_a_not_answering_remote_fact(reply, spans):
    assert guards.stack_claim_check(reply, spans, purpose="chat") is not None


@pytest.mark.parametrize(
    "reply",
    [
        "My Ollama is down.",
        "My model is down.",
        "Our model is unreachable.",
        "The hub's Ollama is down.",
        "The gateway is down.",
        "I can't reach the gateway.",
    ],
)
def test_stack_claim_an_own_stack_marker_fires_while_a_remote_machine_is_not_answering(reply):
    # Rule (b) never covers her own stack: 'my', 'our', 'the hub', the gateway.
    assert guards.stack_claim_check(reply, LIVE_DELL_SPANS, purpose="chat") is not None


def test_stack_claim_bare_subject_excuse_needs_a_remote_machines_fact_not_the_hubs():
    # A not-answering fact about the machine that wrote the reply is not a
    # remote machine's: the hub-served round subtracts it.
    spans = [
        _engine_round("hub"),
        _tool_span(
            "machine_status",
            facts=[{"machine": "hub", "answering": False}, {"machine": "dell", "answering": True}],
        ),
    ]
    assert guards.stack_claim_check("I can't reach Ollama.", spans, purpose="chat") is not None


# T2 COVERAGE (2026-10-07): the own-stack edges the pins above leave open —
# each proved by breaking guards.py and watching only it fail.

# A cloud-served turn whose machine_status names the hub itself: "hub" IS a
# name in the spans, so only the own-marker checks keep it from excusing.
HUB_AND_DELL_CLOUD_SPANS = [
    _cloud_round(1),
    _tool_span(
        "machine_status",
        facts=[{"machine": "hub", "answering": False}, {"machine": "dell", "answering": True}],
    ),
]


@pytest.mark.parametrize(
    "reply",
    ["The hub's Ollama is down.", "Ollama is unreachable on the hub."],
)
def test_stack_claim_a_qualifier_naming_the_hub_excuses_nothing(reply):
    # (a): a qualifier that is her own hub is not another machine's.
    assert "hub" in guards.other_machine_names(HUB_AND_DELL_CLOUD_SPANS, "chat")
    assert guards.stack_claim_check(reply, HUB_AND_DELL_CLOUD_SPANS, purpose="chat") is not None


def test_stack_claim_a_not_answering_hub_never_excuses_a_bare_subject():
    # (b): the hub not answering is her own stack, even on a cloud turn
    # where nothing subtracts it from the names.
    reply = "I can't reach Ollama."
    assert guards.stack_claim_check(reply, HUB_AND_DELL_CLOUD_SPANS, purpose="chat") is not None


def test_stack_claim_a_qualifier_after_the_claim_must_touch_it():
    # (a): "on the Dell" excuses only right after the claim, never later in
    # the clause.
    reply = "The model is unreachable, so I checked the logs on the Dell."
    assert guards.stack_claim_check(reply, DELL_ANSWERING_SPANS, purpose="chat") is not None


# T2 COVERAGE (after GREEN3): the after-qualifier's leading gap is capped at
# \s{1,16} for linear time. Ordinary spacing up to the cap still excuses; a
# gap past it is not a qualifier, so only rule (b) can excuse.
@pytest.mark.parametrize("gap", [1, 2, 16], ids=["one-space", "two-spaces", "at-cap"])
@pytest.mark.parametrize(
    "claim", ["Ollama is down", "I can't reach Ollama"], ids=["assertion", "unreached"]
)
def test_stack_claim_after_qualifier_excuses_within_the_gap_cap(claim, gap):
    reply = f"{claim}{' ' * gap}on the Dell."
    assert guards.stack_claim_check(reply, DELL_ANSWERING_SPANS, purpose="chat") is None


@pytest.mark.parametrize(
    "claim", ["Ollama is down", "I can't reach Ollama"], ids=["assertion", "unreached"]
)
def test_stack_claim_after_qualifier_past_the_gap_cap_is_not_a_qualifier(claim):
    reply = f"{claim}{' ' * 17}on the Dell."
    # Dell answering: no rule (b), so the uncapped "on the Dell" excuses nothing.
    assert guards.stack_claim_check(reply, DELL_ANSWERING_SPANS, purpose="chat") is not None
    # Dell not answering: the bare subject is excused by rule (b) instead.
    assert guards.stack_claim_check(reply, LIVE_DELL_SPANS, purpose="chat") is None


@pytest.mark.parametrize(
    "extra",
    [
        _tool_span("machine_status", ok=False, facts=[{"machine": "dell", "answering": False}]),
        _tool_span("device_run", facts=[{"machine": "dell", "answering": False}]),
    ],
    ids=["failed-machine-status", "not-a-machine-read"],
)
def test_stack_claim_bare_subject_excuse_reads_only_an_ok_machine_read(extra):
    # (b): the not-answering fact counts only from an ok machine read.
    spans = [*DELL_ANSWERING_SPANS, extra]
    assert guards.stack_claim_check("I can't reach Ollama.", spans, purpose="chat") is not None


@pytest.mark.parametrize("reply", ["Nova's model is down.", "Nova’s Ollama is unreachable."])
def test_stack_claim_her_own_name_fires_while_a_remote_machine_is_not_answering(reply):
    assert guards.stack_claim_check(reply, LIVE_DELL_SPANS, purpose="chat") is not None


def _machine_spans(*machines):
    return [
        SERVED[0],
        _tool_span("machine_status", facts=[{"machine": m} for m in machines]),
    ]


def test_stack_claim_machine_name_inside_another_word_does_not_skip():
    spans = _machine_spans("hub")
    assert "hub" in guards.other_machine_names(spans, "chat")
    reply = "The model is unreachable on GitHub."
    assert guards.stack_claim_check(reply, spans, purpose="chat") is not None


def test_stack_claim_machine_name_with_metacharacters_matches_literally():
    spans = _machine_spans("pc.1")
    assert (
        guards.stack_claim_check("The model is unreachable on pcx1.", spans, purpose="chat")
        is not None
    )
    assert (
        guards.stack_claim_check("The model is unreachable on pc.1.", spans, purpose="chat") is None
    )


def test_machine_name_pattern_is_cached_escaped_whole_word_case_insensitive():
    names = ("DELL-XPS-8950", "dell", "pc.1")
    pattern = guards._machine_name_pattern(names)
    assert guards._machine_name_pattern(names) is pattern
    assert pattern.search("Ollama on dell-xps-8950 is down").group(0).lower() == "dell-xps-8950"
    assert pattern.search("the Dell's Ollama") is not None
    assert pattern.search("on pcx1") is None
    assert pattern.search("on pc.1 now") is not None
    assert pattern.search("on GitHub") is None
    assert pattern.search("on dellish") is None


def test_machine_name_pattern_prefers_the_longest_name_and_treats_hyphen_as_word():
    # Longest-first: "pc 1" wins over its prefix "pc" at the same position.
    assert guards._machine_name_pattern(("pc", "pc 1")).search("on pc 1 now").group(0) == "pc 1"
    # A hyphen joins words: "xps" inside "DELL-XPS-8950" is not a whole name.
    assert guards._machine_name_pattern(("xps",)).search("on DELL-XPS-8950") is None
    assert guards._machine_name_pattern(("xps",)).search("on the XPS now") is not None


# -- stack-claim epic T3: her own engine served, and a device's other names ---
#
# T2 VERIFY2 found two gaps. ESCAPE: rule (b) excused a bare "I can't reach
# Ollama" even when her OWN engine answered a round of this turn, and excused
# own-stack nouns (backend, stack) that are never a remote machine's model
# server. FALSE POSITIVE: a turn that drove the Dell by device tools alone
# named only "DELL-XPS-8950", so "the Dell's Ollama" was still replaced. A
# device call now records the names its device is known by (`known_as`).

# An error-free round of her own purpose served by her own engine (the
# gateway's local stamp) — the reply's round when appended last.
ENGINE_ROUND = _llm_span(round=7, completion_chars=80, local=True, served_by="hub:qwen3:8b")

ESCAPE_SENTENCES = [
    "I can't reach Ollama.",
    "The backend is down.",
    "The stack is down right now.",
    "I can't reach the LLM.",
]


@pytest.mark.parametrize("reply", ESCAPE_SENTENCES)
def test_stack_claim_bare_claim_fires_when_her_own_engine_served(reply):
    spans = [*LIVE_DELL_SPANS, ENGINE_ROUND]
    assert guards.stack_claim_check(reply, spans, purpose="chat") is not None


def test_stack_claim_cloud_served_bare_ollama_stays_excused():
    assert (
        guards.stack_claim_check("I can't reach Ollama.", LIVE_DELL_SPANS, purpose="chat") is None
    )


@pytest.mark.parametrize("reply", ["The backend is down.", "The stack is down right now."])
def test_stack_claim_own_stack_nouns_are_never_excused_by_rule_b(reply):
    # backend / stack are her own stack's words, never a remote model server's.
    assert guards.stack_claim_check(reply, LIVE_DELL_SPANS, purpose="chat") is not None


def test_stack_claim_her_engine_is_derived_from_the_round_not_a_name():
    round_ = _llm_span(round=7, completion_chars=80, local=True, served_by="zz-box:qwen3:8b")
    spans = [*LIVE_DELL_SPANS, round_]
    assert guards.stack_claim_check("I can't reach Ollama.", spans, purpose="chat") is not None


@pytest.mark.parametrize(
    "extra",
    [
        {"error": "the gateway timed out"},
        {"purpose": "summary"},
    ],
    ids=["errored", "other-purpose"],
)
def test_stack_claim_an_engine_round_that_is_not_her_own_answer_does_not_count(extra):
    round_ = _llm_span(round=7, completion_chars=80, local=True, served_by="zz-box:qwen3:8b")
    round_.meta.update(extra)
    spans = [*LIVE_DELL_SPANS, round_]
    assert guards.stack_claim_check("I can't reach Ollama.", spans, purpose="chat") is None


@pytest.mark.parametrize(
    "reply",
    ["I can't reach Ollama on the Dell right now.", "The Dell's Ollama is down."],
)
def test_stack_claim_qualified_claims_stay_excused_when_her_engine_served(reply):
    spans = [*LIVE_DELL_SPANS, ENGINE_ROUND]
    assert guards.stack_claim_check(reply, spans, purpose="chat") is None


def _device_only_spans(known_as):
    """device_list + device_run on the Dell, no machine_status, cloud rounds —
    the device_run's fact carrying `known_as` as _require_connected records it."""
    fact = {"device": "DELL-XPS-8950", "connected": True}
    if known_as is not None:
        fact["known_as"] = list(known_as)
    return [
        _cloud_round(1),
        LIVE_DEVICE_LIST,
        _cloud_round(2),
        _tool_span(
            "device_run",
            args={"device": "DELL-XPS-8950", "command": "where ollama"},
            facts=[fact],
        ),
        _cloud_round(3),
    ]


DEVICE_ONLY_SPANS = _device_only_spans(["DELL-XPS-8950", "DELL-XPS-8950", "dell"])


def test_other_machine_names_reads_a_device_facts_known_as():
    assert "dell" in guards.other_machine_names(DEVICE_ONLY_SPANS, "chat")


@pytest.mark.parametrize(
    "reply",
    ["I can't reach Ollama on the Dell right now.", "The Dell's Ollama is down."],
)
def test_stack_claim_a_device_known_as_name_qualifies_the_subject(reply):
    assert guards.stack_claim_check(reply, DEVICE_ONLY_SPANS, purpose="chat") is None


def test_stack_claim_a_nickname_must_come_from_the_spans():
    spans = _device_only_spans(["DELL-XPS-8950"])
    assert "dell" not in guards.other_machine_names(spans, "chat")
    reply = "I can't reach Ollama on the Dell right now."
    assert guards.stack_claim_check(reply, spans, purpose="chat") is not None


def test_other_machine_names_a_device_list_fact_without_known_as_adds_nothing_new():
    spans = [_cloud_round(1), LIVE_DEVICE_LIST, _cloud_round(2)]
    assert guards.other_machine_names(spans, "chat") == ("DELL-XPS-8950",)


def test_other_machine_names_never_takes_the_hubs_own_device_aliases():
    spans = [
        _cloud_round(1),
        LIVE_DEVICE_LIST,
        _tool_span(
            "device_run",
            args={"device": "Beelink Mini S", "command": "uptime"},
            facts=[
                {
                    "device": "Beelink Mini S",
                    "connected": True,
                    "known_as": ["Beelink Mini S", "pop-os"],
                }
            ],
        ),
        *DEVICE_ONLY_SPANS[2:],
    ]
    names = guards.other_machine_names(spans, "chat")
    assert "dell" in names
    assert "pop-os" not in names
    assert "Beelink Mini S" not in names
    reply = "Ollama is unreachable on pop-os."
    assert guards.stack_claim_check(reply, spans, purpose="chat") is not None


@pytest.mark.parametrize(
    "reply", ["I can't reach the LLM.", "The inference service is unavailable."]
)
def test_stack_claim_cloud_served_bare_remote_server_nouns_stay_excused(reply):
    # T3 COVERAGE: llm and inference are a remote model server's words too, so
    # rule (b) still excuses them on a cloud-served turn (Assumptions).
    assert guards.stack_claim_check(reply, LIVE_DELL_SPANS, purpose="chat") is None


def test_other_machine_names_known_as_keeps_stripped_strings_only():
    # T3 COVERAGE: aliases are strings, stripped — a padded name is the name,
    # and a non-string entry is skipped, never read.
    spans = _device_only_spans(["DELL-XPS-8950", "  dell  ", 7, None])
    names = guards.other_machine_names(spans, "chat")
    assert "dell" in names
    assert "  dell  " not in names


# -- stack-claim epic T4: the live turn's whole reply, not one sentence -------
#
# Turn 07076682 (2026-10-07): her 1019-char reply about the Dell's Ollama was
# REPLACED by the stack_claim correction. Her text is not stored, so this is a
# reconstruction from the live tool results — every sentence true of
# LIVE_DELL_SPANS, the live guard phrase "can't reach Ollama" left unqualified
# as the span meta recorded it. The pin's value is the clause mix: a later rule
# that fires on any of its other clauses is caught here.
LIVE_DELL_REPLY = (
    "I couldn't start the Dell's Ollama. Here is what I found. I can't reach Ollama: "
    "machine_status says the dell (100.122.40.93) is walled for another 13 minutes after "
    "dell:qwen3:8b refused with a 502. I tried to launch the Ollama app on DELL-XPS-8950, "
    "and device_launch_app found no Ollama app installed there, so there was nothing to "
    "launch. The Dell's app list does not include Ollama either. Running `where ollama` "
    "on the Dell exited 1, which means the ollama binary is not on its PATH. netstat on "
    "the Dell does show a process listening on port 11435, so something already holds "
    "that port, and tasklist showed no ollama.exe running.\n\n"
    "Next steps:\n"
    "1. Wait out the 13-minute wall and I will check the Dell again.\n"
    "2. If Ollama was installed under a different user or folder, tell me the path and I "
    "will start it from there.\n"
    "3. I can look up which process owns port 11435 on the Dell and stop it if it is stale."
)


def test_live_dell_reply_is_the_live_turns_shape():
    # T4 criterion 1: the reconstruction carries the live phrase, unqualified,
    # at the live reply's size, and no correction text of its own.
    assert 900 <= len(LIVE_DELL_REPLY) <= 1100
    assert "I can't reach Ollama:" in LIVE_DELL_REPLY
    assert "Correction:" not in LIVE_DELL_REPLY
    for fact in ("walled", "13 minutes", "no Ollama app", "`where ollama`", "exited 1", "11435"):
        assert fact in LIVE_DELL_REPLY


def live_dell_spans(purpose):
    """LIVE_DELL_SPANS as a turn of `purpose`: its rounds carry that purpose,
    so the guard is armed (an eval reading chat rounds would be vacuous)."""
    return [
        SimpleNamespace(kind=s.kind, name=s.name, meta={**s.meta, "purpose": purpose})
        if s.kind == "llm_call"
        else s
        for s in LIVE_DELL_SPANS
    ]


@pytest.mark.parametrize("purpose", ["chat", "eval"])
def test_stack_claim_live_dell_reply_is_not_replaced(purpose):
    # T4 criterion 2: the live turn's whole reply over the live turn's spans.
    spans = live_dell_spans(purpose)
    assert guards.served_this_turn(spans, purpose)
    assert guards.stack_claim_check(LIVE_DELL_REPLY, spans, purpose=purpose) is None


def test_stack_claim_live_dell_reply_fires_when_her_own_engine_served():
    # T4 criterion 4 (non-vacuous): the same reply, her own engine answering,
    # is a false claim about her side — the excuse above is the remote context.
    spans = [*LIVE_DELL_SPANS, ENGINE_ROUND]
    claim = guards.stack_claim_check(LIVE_DELL_REPLY, spans, purpose="chat")
    assert claim is not None
    assert claim.phrase == "can't reach Ollama"


def test_stack_claim_live_dell_reply_fires_without_remote_context():
    # T4 criterion 5 (non-vacuous): served, no remote machine in the spans —
    # the reconstruction holds a real serving match.
    claim = guards.stack_claim_check(LIVE_DELL_REPLY, SERVED, purpose="chat")
    assert claim is not None
    assert claim.subject == "Ollama"


# -- S42b: an update is confirmed by the reconnect, never by the send --------
#
# machine_update records {"machine_update", "hub", "outcome", "version",
# "confirmed"} on its span (Task 22), and machine_status records the ledger row
# its agent line states the same way (fix round 1, I3). A claim that a
# machine's agent was updated is backed ONLY by such a fact naming that machine
# with confirmed: true (P8, Review Focus 2) — a STATE ("its agent is updated")
# also by "current". The correction is the family's APPEND shape: one sentence
# of what the record shows, never a redirect and never an invitation to act.
#
# The name slot is read against the LIVE paired machines (fix round 1, I2),
# the names chat reads for the state guard: a word that is not a paired
# machine's name, or a word of one, names no machine at all.
PAIRED = ("minipc", "eval_laptop", "eval_pc", "box", "DELL-XPS-8950")

UPDATE_CLAIMS = (
    ("I updated minipc's agent.", "minipc"),
    ("I've updated the agent on eval_laptop.", "eval_laptop"),
    ("I upgraded eval_laptop to the hub's build.", "eval_laptop"),
    ("eval_laptop's agent is now updated.", "eval_laptop"),
    # Pin moved (fix round 1, I2): "hub" is a role word, like "server" and
    # "host" — D8 reserves it, so no machine is named hub — and this claim
    # names no machine. The brief's row expected the target "hub".
    ("Done — I updated the hub's agent.", None),
)
UPDATE_HONEST = (
    "I sent the hub's build to eval_laptop; it is not confirmed until its agent reconnects.",
    "I'll update eval_laptop's agent.",
    "Should I update eval_laptop's agent?",
    "I updated my notes.",
    "eval_laptop's agent has not been updated.",
    "I updated the notes on minipc.",
)


def _update_span(machine: str, *, outcome: str, hub: bool = False, ok: bool = True):
    span = tool_span("machine_update", ok=ok, machine=machine)
    span.meta["facts"] = [
        {
            "machine_update": machine,
            "hub": hub,
            "outcome": outcome,
            "version": "aaaaaaaaaaaa",
            "confirmed": outcome == "confirmed",
        }
    ]
    return span


def _status_span(machine: str, *, outcome: str, ok: bool = True):
    """machine_status's read of an agent's line: its connection, and the
    ledger row the line states (fix round 1, I3)."""
    span = tool_span("machine_status", ok=ok)
    span.meta["facts"] = [
        {"device": machine, "connected": True},
        {
            "machine_update": machine,
            "outcome": outcome,
            "version": "aaaaaaaaaaaa",
            "confirmed": outcome == "confirmed",
        },
    ]
    return span


@pytest.mark.parametrize("reply,machine", UPDATE_CLAIMS)
def test_an_update_claim_without_a_confirmed_reconnect_is_corrected(reply, machine):
    """Review Focus 2 (P8): "sent" backs nothing — only the reconnect does."""
    for spans in ([other_span()], [_update_span(machine or "minipc", outcome="sent")]):
        correction = guards.narration_check(reply, spans, PAIRED)
        assert correction is not None and kinds(correction) == ["updated_machine"], reply
        assert targets(correction) == [machine], reply


@pytest.mark.parametrize("reply,machine", UPDATE_CLAIMS)
def test_a_confirmed_update_backs_the_claim_for_that_machine_only(reply, machine):
    """Pin flipped for the hub row (fix round 1, I2): "the hub's agent" names
    no machine, so a confirmed update of ANY machine backs it."""
    own = _update_span(machine or "minipc", outcome="confirmed", hub=machine is None)
    assert guards.narration_check(reply, [own], PAIRED) is None
    other = guards.narration_check(
        reply, [_update_span("somewhere-else", outcome="confirmed")], PAIRED
    )
    if machine is None:
        assert other is None, reply
    else:
        assert other is not None and kinds(other) == ["updated_machine"]


@pytest.mark.parametrize("reply", UPDATE_HONEST)
def test_honest_update_talk_never_fires(reply):
    assert guards.narration_check(reply, [other_span()], PAIRED) is None, reply


def test_the_door_is_never_read_and_the_hubs_agent_names_no_machine():
    """Controller rulings (Task 23; fix round 1, I2), replacing the brief's
    pin. "hub": true says only that the agent came in through the hub
    machine's own loopback door, and a relay on the hub (a quick tunnel to
    127.0.0.1, an ssh -L) reads the same way — the guard never reads it. "hub"
    is a role word: D8 reserves it, so "the hub's agent" names no machine, and
    a confirmed update of any machine this turn backs it.

    Pin flipped (fix round 1): with minipc's update confirmed, the reviewer's
    "I updated the hub's agent." and "I updated the agent on the hub." were
    corrected as "a machine named hub"; now neither is."""
    door = _update_span("minipc", outcome="confirmed", hub=True)
    plain = _update_span("minipc", outcome="confirmed", hub=False)
    for reply in ("I updated the hub's agent.", "I updated the agent on the hub."):
        assert guards.narration_check(reply, [door], PAIRED) is None, reply
        assert guards.narration_check(reply, [plain], PAIRED) is None, reply
        # A send to the machine behind the door is still only a send.
        sent = guards.narration_check(
            reply, [_update_span("minipc", outcome="sent", hub=True)], PAIRED
        )
        assert sent is not None and targets(sent) == [None], reply
    # The same span backs the claim by the machine's own name.
    assert guards.narration_check("I updated minipc's agent.", [door], PAIRED) is None


def test_hub_is_a_role_word_even_beside_a_machine_whose_name_has_it():
    """A paired machine named nova-hub is named by its own name; "the hub's
    agent" still names no machine in particular — the role word never becomes
    a name because some machine's name contains it."""
    names = (*PAIRED, "nova-hub")
    named = guards.narration_check("I updated nova-hub's agent.", [other_span()], names)
    assert named is not None and targets(named) == ["nova-hub"]
    hub = guards.narration_check("I updated the hub's agent.", [other_span()], names)
    assert hub is not None and targets(hub) == [None]
    confirmed_elsewhere = [_update_span("eval_pc", outcome="confirmed")]
    assert guards.narration_check("I updated the hub's agent.", confirmed_elsewhere, names) is None


@pytest.mark.parametrize(
    "reply",
    [
        "I upgraded the agent to the hub's build — it reconnected on aaaaaaaaaaaa.",
        "I updated your agents to the hub's build.",
    ],
)
def test_the_claims_own_noun_is_never_read_as_a_machine(reply):
    """Fix round 1, I1 (the reviewer's two replies): after machine_update
    confirmed minipc, each was corrected as "a machine named agent" /
    "agents". The claim's own noun names no machine — not even beside paired
    machines whose names carry the word (ci-agent, lab-agents)."""
    names = (*PAIRED, "ci-agent", "lab-agents")
    assert (
        guards.narration_check(reply, [_update_span("minipc", outcome="confirmed")], names) is None
    )
    correction = guards.narration_check(reply, [other_span()], names)
    assert correction is not None and targets(correction) == [None], reply


def test_two_forms_of_one_update_are_one_unbacked_claim():
    """Her act and the state it left, about one machine, are one claim to
    the correction and the guard span."""
    reply = "I updated minipc's agent — minipc's agent has been updated."
    correction = guards.narration_check(reply, [other_span()], PAIRED)
    assert correction is not None
    assert kinds(correction) == ["updated_machine"] and targets(correction) == ["minipc"]


# Fix round 1, I2: words in the name slot that are not a paired machine's name
# or a word of one — each was read as a machine's name and, with minipc's
# update confirmed, corrected. "the mini PC" is minipc's owner's way of saying
# it, but "mini" is not a word of the name "minipc".
NOT_A_PAIRED_NAME = (
    "I updated the agent on the hub.",
    "I updated the agent on the mini PC.",
    "I updated the agent on the Windows machine.",
    "I updated the agent on your desktop.",
    "I updated the agent on WSL.",
)


@pytest.mark.parametrize("reply", NOT_A_PAIRED_NAME)
def test_a_word_that_names_no_paired_machine_names_no_machine(reply):
    door = _update_span("minipc", outcome="confirmed", hub=True)
    assert guards.narration_check(reply, [door], PAIRED) is None, reply
    # Not vacuous: with nothing confirmed, it is still an update claim.
    correction = guards.narration_check(reply, [other_span()], PAIRED)
    assert correction is not None and targets(correction) == [None], reply


def test_the_name_slot_is_derived_from_the_live_paired_names():
    """Derived, never hardcoded: the same word names a machine only while a
    machine of that name is paired. With none paired, every update claim names
    no machine in particular."""
    reply = "I updated minipc's agent."
    elsewhere = [_update_span("eval_pc", outcome="confirmed")]
    paired = guards.narration_check(reply, elsewhere, PAIRED)
    assert paired is not None and targets(paired) == ["minipc"]
    assert guards.narration_check(reply, elsewhere, ("eval_pc",)) is None
    assert guards.narration_check(reply, elsewhere) is None


PERSONA_UPDATES = (
    "I updated coder's agent settings.",
    "I updated the agent on the Agents page — its round budget is now 8.",
)


@pytest.mark.parametrize("reply", PERSONA_UPDATES)
def test_a_successful_update_agent_backs_an_agent_claim_that_names_no_machine(reply):
    """Fix round 1, I2: her agents in the other sense — the specialists she
    delegates to — are changed by update_agent. After one succeeded, the
    reviewer's replies were corrected as machines named coder and Agents."""
    assert guards.narration_check(reply, [tool_span("update_agent")], PAIRED) is None, reply
    for spans in ([tool_span("update_agent", ok=False)], [other_span()]):
        correction = guards.narration_check(reply, spans, PAIRED)
        assert correction is not None and targets(correction) == [None], reply


def test_update_agent_never_backs_a_build_claim():
    """A specialist has no build: only the agent forms read as one."""
    reply = "I upgraded it to the hub's build."
    correction = guards.narration_check(reply, [tool_span("update_agent")], PAIRED)
    assert correction is not None and kinds(correction) == ["updated_machine"]


def test_a_later_turn_reads_the_update_from_machine_status():
    """Fix round 1, I3 (the reviewer's reply): machine_status's agent line
    states the ledger row — "last update: … confirmed" — and records it, so a
    true report in a later turn, mostly after the job's unasked update, is
    backed. Before, it was corrected."""
    reply = "minipc's agent has been updated — it reconnected on aaaaaaaaaaaa."
    assert (
        guards.narration_check(reply, [_status_span("minipc", outcome="confirmed")], PAIRED) is None
    )
    mine = "I updated minipc's agent."
    assert (
        guards.narration_check(mine, [_status_span("minipc", outcome="confirmed")], PAIRED) is None
    )
    for outcome in ("sent", "rolled_back", "not_confirmed", "refused"):
        assert (
            guards.narration_check(reply, [_status_span("minipc", outcome=outcome)], PAIRED)
            is not None
        ), outcome
    assert (
        guards.narration_check(
            reply, [_status_span("minipc", outcome="confirmed", ok=False)], PAIRED
        )
        is not None
    )
    assert (
        guards.narration_check(reply, [_status_span("eval_pc", outcome="confirmed")], PAIRED)
        is not None
    )


def test_current_backs_the_state_but_never_an_update_she_made():
    """Fix round 1, I3 (the reviewer's reply): machine_update answered
    "current" — its agent last reported the hub's build, nothing was sent. The
    STATE is true; "I updated" is not."""
    current = _update_span("minipc", outcome="current")
    assert guards.narration_check("minipc's agent is updated already.", [current], PAIRED) is None
    correction = guards.narration_check("I updated minipc's agent.", [current], PAIRED)
    assert correction is not None and targets(correction) == ["minipc"]


@pytest.mark.parametrize("outcome", ["current", "sent", "rolled_back", "not_confirmed", "refused"])
def test_no_outcome_but_confirmed_backs_an_update_she_made(outcome):
    """Each outcome machine_update can answer with, as the ledger holds it:
    only the reconnect (confirmed) says the agent runs the new build. "current"
    sent nothing; the rest are a send that was not confirmed or did not take."""
    span = _update_span("eval_laptop", outcome=outcome)
    correction = guards.narration_check("I updated eval_laptop's agent.", [span], PAIRED)
    assert correction is not None and targets(correction) == ["eval_laptop"], outcome


def test_a_cannot_backs_no_update_claim():
    """A cannot is a failed span (a stated ToolFailure); it updated nothing."""
    span = _update_span("eval_pc", outcome="cannot", ok=False)
    correction = guards.narration_check("I updated eval_pc's agent.", [span], PAIRED)
    assert correction is not None and kinds(correction) == ["updated_machine"]


UPDATE_SENT_CORRECTION = (
    "Correction: nothing this turn confirmed an update of a machine named eval_laptop — only "
    "the agent reconnecting on the hub's build confirms one."
)
# A claim that names no machine is backed only by this turn's own update (fix
# round 2, N1), so its sentence says exactly that: "nothing this turn" would be
# false beside a row machine_status showed confirmed for some other machine.
UPDATE_UNNAMED_CORRECTION_TEXT = (
    "Correction: no machine_update call this turn confirmed an update — only the agent "
    "reconnecting on the hub's build confirms one."
)


def test_the_update_correction_says_only_what_the_record_shows():
    """APPEND-only, one true sentence (the said-not-done lane's shape). The
    family's generic "I did not actually do that — there is no record of the
    action this turn" would be FALSE beside a send machine_update really made,
    so an update claim never gets it. Nothing in it invites an action. Fix
    round 1 (I3): "nothing this turn", since machine_status's read of the
    ledger confirms an update too."""
    for spans in ([other_span()], [_update_span("eval_laptop", outcome="sent")]):
        correction = guards.narration_check("Done — I updated eval_laptop's agent.", spans, PAIRED)
        assert correction is not None
        assert correction.text == UPDATE_SENT_CORRECTION
        assert "no record of the action" not in correction.text
        assert not re.search(
            r"\b(?:again|retry|try|ask|want me|should i|let me|shall i|tell me)\b",
            correction.text,
            re.I,
        ), correction.text


def test_the_update_correction_names_every_unconfirmed_machine():
    reply = "I updated minipc's agent. I've updated eval_laptop's agent too."
    spans = [_update_span("eval_pc", outcome="confirmed"), _update_span("minipc", outcome="sent")]
    correction = guards.narration_check(reply, spans, PAIRED)
    assert correction is not None and targets(correction) == ["minipc", "eval_laptop"]
    assert correction.text == (
        "Correction: nothing this turn confirmed an update of a machine named minipc or "
        "eval_laptop — only the agent reconnecting on the hub's build confirms one."
    )


def test_an_update_claim_that_names_no_machine_is_backed_by_any_confirmed_update():
    """Pin moved (fix round 2, N1): the sentence for a claim that names no
    machine was "nothing this turn confirmed an update"; such a claim is now
    backed only by this turn's machine_update, and the sentence says so."""
    reply = "I upgraded it to the hub's build."
    assert (
        guards.narration_check(reply, [_update_span("minipc", outcome="confirmed")], PAIRED) is None
    )
    for spans in ([other_span()], [_update_span("minipc", outcome="sent")]):
        correction = guards.narration_check(reply, spans, PAIRED)
        assert correction is not None and targets(correction) == [None]
        assert correction.text == UPDATE_UNNAMED_CORRECTION_TEXT


def test_an_update_claim_beside_another_kind_keeps_both_sentences():
    """A reply that also claims a file it never wrote: the family's sentence
    for the file, then the update's own, each true of its claim."""
    reply = "I updated eval_laptop's agent and I saved notes.md."
    correction = guards.narration_check(
        reply, [_update_span("eval_laptop", outcome="sent")], PAIRED
    )
    assert correction is not None
    assert sorted(kinds(correction)) == ["updated_machine", "wrote_file"]
    assert correction.text == (
        f"{guards.CORRECTION_TEXT} Nothing this turn confirmed an update of a machine named "
        "eval_laptop — only the agent reconnecting on the hub's build confirms one."
    )


def test_a_word_of_a_paired_machines_name_names_it():
    """ "your Dell" is DELL-XPS-8950 because "dell" is a word of a paired
    machine's name — the said-not-done lane's rule for a device's name: a true
    reply that calls the machine by a word of its name is never corrected, and
    a word of exactly one paired name is read as that machine."""
    span = _update_span("DELL-XPS-8950", outcome="confirmed")
    for reply in ("I updated your Dell's agent.", "I updated the agent on the Dell."):
        assert guards.narration_check(reply, [span], PAIRED) is None, reply
    laptop = guards.narration_check("I updated the laptop's agent.", [span], PAIRED)
    assert laptop is not None and targets(laptop) == ["eval_laptop"]
    assert "a machine named eval_laptop" in laptop.text


UPDATE_CLAIMS_MORE = (
    ("I've just updated minipc's agent.", "minipc"),
    ("I have updated the agent on eval_laptop.", "eval_laptop"),
    ("I've also updated eval_laptop's agent.", "eval_laptop"),
    ("I've successfully upgraded minipc's agent.", "minipc"),
    ("eval_laptop's agent has been updated.", "eval_laptop"),
    ("I upgraded the agent on eval_laptop to the hub's build.", "eval_laptop"),
    ("I updated the agents on minipc.", "minipc"),
    ("All set: I upgraded minipc onto the hub's new build.", "minipc"),
)


@pytest.mark.parametrize("reply,machine", UPDATE_CLAIMS_MORE)
def test_the_other_ways_she_says_an_update_happened_are_read(reply, machine):
    correction = guards.narration_check(reply, [_update_span(machine, outcome="sent")], PAIRED)
    assert correction is not None and kinds(correction) == ["updated_machine"], reply
    assert targets(correction) == [machine], reply
    confirmed = [_update_span(machine, outcome="confirmed")]
    assert guards.narration_check(reply, confirmed, PAIRED) is None


UPDATE_NOT_A_CLAIM = (
    # negated, future, hedged, a question, or not her own act
    "I haven't updated minipc's agent.",
    "I never updated minipc's agent.",
    "I couldn't update minipc's agent: it is offline.",
    "Once its agent reconnects, I'll have updated minipc.",
    "If I updated minipc's agent now, its running command would end cancelled.",
    "Have I updated minipc's agent? Not yet — it was sent and is not confirmed.",
    "You said I updated minipc's agent, but it is not confirmed.",
    "eval_laptop's agent has been updated by the update job.",
    "The job says eval_laptop's agent has been updated.",
    # an earlier time: a recap, not this turn's act
    "I updated minipc's agent yesterday.",
    "I updated minipc's agent earlier — it reconnected then.",
    "I updated minipc's agent this morning.",
    "In our last chat I updated minipc's agent.",
    "I updated minipc's agent on Monday.",
    "I updated minipc's agent before, so I know it reconnects.",
    # other software, other builds
    "I upgraded Firefox to the latest build.",
    "I updated the app to the new version.",
)


@pytest.mark.parametrize("reply", UPDATE_NOT_A_CLAIM)
def test_what_is_not_an_update_claim_never_fires(reply):
    correction = guards.narration_check(reply, [other_span()], PAIRED)
    assert correction is None or "updated_machine" not in kinds(correction), reply


@pytest.mark.parametrize(
    "reply",
    [
        "I updated the agent on your behalf.",
        "I updated the agent on time.",
        "I updated Nova's agent on schedule.",
        "I upgraded it to the hub's build.",
    ],
)
def test_a_word_where_a_name_would_sit_claims_an_update_of_no_machine_in_particular(reply):
    """A trailing phrase ("on your behalf", "on time") or a pronoun puts a word
    where the machine's name would be. Read as a name, it would correct a TRUE
    report after a real, confirmed update — so it names no machine: any
    confirmed update backs it, and with none it still fires. "Nova's agent"
    stays no machine's even beside a paired machine named nova-hub."""
    names = (*PAIRED, "nova-hub")
    correction = guards.narration_check(reply, [other_span()], names)
    assert correction is not None and targets(correction) == [None], reply
    confirmed = [_update_span("minipc", outcome="confirmed")]
    assert guards.narration_check(reply, confirmed, names) is None


# -- Task 23 fix round 2 (N1): a row machine_status shows backs only its machine --
#
# machine_status states every listed agent's LAST ledger row, whatever its age,
# and records it (fix round 1, I3). A claim that NAMES a machine is backed by
# that machine's own row. A claim that names none — "the hub's agent", "it",
# "the mini PC", "on your behalf" — cannot be tied to any one row, so only this
# turn's own update backs it: a confirmed machine_update (for the state form,
# also its "current"), or for her act on an agent a successful update_agent.
# The re-review's evidence: with this turn's update of minipc only SENT, the
# Dell's weeks-old confirmed row let all four claims below through as honest.
UNNAMED_UPDATE_CLAIMS = (
    "Done — I updated the hub's agent.",
    "I upgraded it to the hub's build.",
    "I updated the agent on the mini PC.",
    "I updated the agent on your behalf.",
)


def _rows_status_span(*rows: tuple[str, str]):
    """machine_status's read of several agents' lines, as _describe_agents
    records them: each agent's connection, then its last ledger row."""
    span = tool_span("machine_status")
    span.meta["facts"] = [
        fact
        for machine, outcome in rows
        for fact in (
            {"device": machine, "connected": True},
            {
                "machine_update": machine,
                "outcome": outcome,
                "version": "aaaaaaaaaaaa",
                "confirmed": outcome == "confirmed",
            },
        )
    ]
    return span


def _old_rows_beside(update_outcome: str | None):
    """The re-review's two turns. With an outcome: machine_update sent the
    hub's build to minipc (the hub machine) and answered that outcome, then
    machine_status showed the Dell's and eval_laptop's last rows — old,
    confirmed updates — and minipc's. Without one: machine_status alone, the
    Dell confirmed and minipc rolled back."""
    if update_outcome is None:
        return [_rows_status_span(("DELL-XPS-8950", "confirmed"), ("minipc", "rolled_back"))]
    update = _update_span("minipc", outcome=update_outcome, hub=True)
    update.meta["facts"].insert(0, {"device": "minipc", "connected": True})
    status = _rows_status_span(
        ("DELL-XPS-8950", "confirmed"), ("eval_laptop", "confirmed"), ("minipc", update_outcome)
    )
    return [update, status]


@pytest.mark.parametrize("update_outcome", ["sent", None], ids=["update_sent", "status_alone"])
@pytest.mark.parametrize("reply", UNNAMED_UPDATE_CLAIMS)
def test_a_row_machine_status_showed_backs_no_claim_that_names_no_machine(reply, update_outcome):
    """The re-review's four replies, in both of its turns: each was let
    through as honest. The sentence names what such a claim needs — this
    turn's machine_update — so it stays true beside the Dell's confirmed row."""
    correction = guards.narration_check(reply, _old_rows_beside(update_outcome), PAIRED)
    assert correction is not None and targets(correction) == [None], reply
    assert correction.text == UPDATE_UNNAMED_CORRECTION_TEXT, reply


@pytest.mark.parametrize("reply", UNNAMED_UPDATE_CLAIMS)
def test_this_turns_confirmed_update_still_backs_a_claim_that_names_no_machine(reply):
    """Not vacuous: the same rows, beside a CONFIRMED update of minipc this turn."""
    assert guards.narration_check(reply, _old_rows_beside("confirmed"), PAIRED) is None, reply


@pytest.mark.parametrize("update_outcome", ["sent", None], ids=["update_sent", "status_alone"])
def test_a_row_still_backs_a_claim_that_names_its_own_machine(update_outcome):
    """The named half keeps its result: minipc's own row is not confirmed, so
    "I updated minipc's agent." is corrected for minipc, and the Dell's
    confirmed row backs a claim that names the Dell (fix round 1, I3)."""
    spans = _old_rows_beside(update_outcome)
    correction = guards.narration_check("I updated minipc's agent.", spans, PAIRED)
    assert correction is not None and targets(correction) == ["minipc"]
    for reply in ("DELL-XPS-8950's agent has been updated.", "I updated your Dell's agent."):
        assert guards.narration_check(reply, spans, PAIRED) is None, reply


def test_a_current_row_backs_the_state_that_names_its_machine():
    """The ruling's own case (fix round 2): "minipc's agent is updated
    already." stays honest when minipc's row says current — machine_update's
    "current" is pinned above. The ledger's outcome CHECK never stores
    "current", so this is the same read on a row, whoever records it; a row
    of another machine backs nothing, and neither does it back her act."""
    state = "minipc's agent is updated already."
    assert (
        guards.narration_check(state, [_status_span("minipc", outcome="current")], PAIRED) is None
    )
    other = guards.narration_check(state, [_status_span("eval_pc", outcome="current")], PAIRED)
    assert other is not None and targets(other) == ["minipc"]
    act = guards.narration_check(
        "I updated minipc's agent.", [_status_span("minipc", outcome="current")], PAIRED
    )
    assert act is not None and targets(act) == ["minipc"]


def test_a_specialist_claim_is_backed_by_update_agent_never_by_a_machines_row():
    """The word coder names no paired machine: a successful update_agent backs
    the claim (fix round 1, I2); an old confirmed row of a machine never does."""
    reply = "I updated coder's agent settings."
    rows = _old_rows_beside(None)
    correction = guards.narration_check(reply, rows, PAIRED)
    assert correction is not None and targets(correction) == [None]
    assert guards.narration_check(reply, [*rows, tool_span("update_agent")], PAIRED) is None


def test_this_turns_current_backs_a_state_that_names_no_machine():
    """machine_update answering "current" THIS turn backs the state — "the
    hub's agent is updated already" — by fix round 1's rule for the state
    form, read from this turn's own update span. It never backs her act, and
    an old confirmed row never backs a state that names no machine."""
    state = "The hub's agent is updated already."
    current = [_update_span("minipc", outcome="current", hub=True)]
    assert guards.narration_check(state, current, PAIRED) is None
    act = guards.narration_check("I updated the hub's agent.", current, PAIRED)
    assert act is not None and targets(act) == [None]
    rows = guards.narration_check(state, _old_rows_beside(None), PAIRED)
    assert rows is not None and targets(rows) == [None]


def test_the_sentence_for_a_claim_that_names_no_machine_names_the_update_tool():
    """It names the registered update tool (test_state_guard pins
    _UPDATE_TOOLS to MACHINE_UPDATE.name), so a rename turns this red."""
    assert any(name in guards.UPDATE_UNNAMED_CORRECTION for name in guards._UPDATE_TOOLS)


def test_the_update_correction_trips_no_guard_of_its_own():
    """What persists is the correction beside her prose, so a correction that
    tripped a guard would be corrected forever (every guard is clean over its
    own correction)."""
    texts = [
        UPDATE_SENT_CORRECTION,
        UPDATE_UNNAMED_CORRECTION_TEXT,
        guards.narration_check(
            "I updated minipc's agent.", [_update_span("eval_pc", outcome="confirmed")], PAIRED
        ).text,
        guards.narration_check("I upgraded it to the hub's build.", [other_span()], PAIRED).text,
    ]
    # A round hub served makes hub a machine the state guard reads by name.
    on_hub = SimpleNamespace(
        kind="llm_call",
        name="hub:qwen3:8b",
        meta={"purpose": "chat", "served_by": "hub:qwen3:8b", "local": True},
    )
    spans = [_update_span("minipc", outcome="confirmed"), on_hub]
    for text in texts:
        assert guards.narration_check(text, spans, PAIRED) is None, text
        assert guards.consent_claim_check(text) is None, text
        assert guards.capability_claim_check(text, DEFERRAL_TOOLS) is None, text
        assert guards.deferral_check(text, spans, DEFERRAL_TOOLS) is None, text
        assert guards.bare_intent_check(text, []) is None, text
        assert guards.state_claim_check(text, spans, list(PAIRED), purpose="chat") is None, text
        assert guards.presented_listing_check(text, [], ["workspace_list_files"]) is None, text
        assert guards.delegation_claim_check(text, [], ["coder"]) is None, text
        assert guards.stack_claim_check(text, [on_hub], purpose="chat") is None, text
        assert guards.served_claim_check(text, [on_hub], purpose="chat") is None, text
        assert guards.memory_claim_check(text, [on_hub], purpose="chat") is None, text


def test_no_offer_class_reads_his_message_for_an_update():
    """Task 23 controller rulings, in place of the brief's `_UPDATE_MACHINE`
    offer class. The offer shape decides by reading the OWNER's message
    (_instructed_classes) and answers with a tools-advertised "do it now"
    redirect; for machine_update that is a phrase matcher on his words pushing
    an agent restart — and the cancel of every command running there. Guards
    read her reply and the turn's spans, never his message, and no redirect
    may push an action. If this goes red, a class carrying the update tool
    joined _OFFER_CLASSES: that needs an owner ruling first, not a pin move."""
    assert not any(set(cls.tools) & guards._UPDATE_TOOLS for cls in guards._OFFER_CLASSES)
    claim = guards.deferral_check(
        "Want me to update minipc's agent now?",
        [other_span()],
        DEFERRAL_TOOLS,
        user_message="update minipc's agent",
    )
    assert claim is None


# -- Task 32 (Phase B round 2): the names an update claim is read by ----------
#
# L510: the paired names are read live, and a read that blips arrives empty —
# chat fails open — as does a replay that declares no device. Every update
# claim then named no machine, and needed this turn's own update to be backed,
# so a true report backed by the row machine_status showed was corrected. A
# word is now read against the machines the turn's update facts name, when no
# paired name holds it.


def test_with_no_paired_names_a_claim_is_read_by_the_machines_the_record_names():
    """L510: machine_status showed eval_laptop's confirmed row; the paired
    names did not arrive. Each reply was corrected as naming no machine."""
    shown = [_status_span("eval_laptop", outcome="confirmed")]
    for reply in (
        "eval_laptop's agent has been updated.",
        "I updated eval_laptop's agent.",
        "I upgraded the agent on eval_laptop to the hub's build.",
    ):
        assert guards.narration_check(reply, shown, ()) is None, reply
    # The record names its machine only for what it says: a row that is a send
    # backs nothing, and the sentence names the machine the claim did.
    sent = guards.narration_check(
        "eval_laptop's agent has been updated.", [_status_span("eval_laptop", outcome="sent")], ()
    )
    assert sent is not None and targets(sent) == ["eval_laptop"]
    assert "a machine named eval_laptop" in sent.text


def test_a_word_the_record_does_not_name_still_names_no_machine():
    """The fallback reads only machines the record names, so fix round 1's
    words (I2) still name none — and the claim is still backed only by this
    turn's own confirmed update."""
    shown = [_status_span("minipc", outcome="confirmed")]
    for reply in NOT_A_PAIRED_NAME:
        correction = guards.narration_check(reply, shown, ())
        assert correction is not None and targets(correction) == [None], reply
        confirmed = [_update_span("minipc", outcome="confirmed")]
        assert guards.narration_check(reply, confirmed, ()) is None, reply


# L492c: a name slot is entered at the front of its token, so a list's "-" with
# no space after it, or an ellipsis's dots, stayed on the name — which then
# named no machine, and so needed this turn's own update to be backed.
@pytest.mark.parametrize(
    "reply",
    [
        "-eval_laptop's agent is updated.",
        "...eval_laptop's agent has been updated.",
        "-eval_laptop is now on the hub's build.",
    ],
)
def test_punctuation_against_the_front_of_a_name_is_not_part_of_it(reply):
    shown = [_status_span("eval_laptop", outcome="confirmed")]
    assert guards.narration_check(reply, shown, PAIRED) is None, reply
    sent = guards.narration_check(reply, [_status_span("eval_laptop", outcome="sent")], PAIRED)
    assert sent is not None and targets(sent) == ["eval_laptop"], reply


def test_a_name_that_begins_with_a_dash_is_still_read_whole():
    """The word as written is read first: a machine whose own name begins
    with "-" is that machine, never the word without it."""
    names = (*PAIRED, "-lab")
    correction = guards.narration_check("-lab's agent is updated.", [other_span()], names)
    assert correction is not None and targets(correction) == ["-lab"]


# -- Task 32 (Phase B round 2), the MF4 gap: an update's RESULT, said as done --
#
# Since MF4 a machine_update on minipc backs an install claim about minipc for
# device_completion, whatever it answered — a send too — because whether the
# install TOOK is this family's question. The family read only "I updated …"
# and "…'s agent is updated", so "I installed the new build on minipc" beside a
# SENT update was corrected by neither guard. Three more ways, each about a
# machine she names (guards._UPDATE_TOOK): her install of the build, an act;
# the build installed there or the update done; and the build it runs — states.
RESULT_ACTS = (
    ("I installed the new build on minipc.", "minipc"),
    ("I've installed the hub's build on eval_laptop.", "eval_laptop"),
    ("Done — I just installed the latest build on minipc.", "minipc"),
)
RESULT_STATES = (
    ("The new build has been installed on minipc.", "minipc"),
    ("The update is complete on minipc.", "minipc"),
    ("The update on eval_laptop is done.", "eval_laptop"),
    ("minipc's update is finished.", "minipc"),
    ("The update has completed on your Dell.", "DELL-XPS-8950"),
    ("minipc is now on the hub's build.", "minipc"),
    ("minipc's agent is running the new build.", "minipc"),
    ("The agent on eval_laptop is now running the hub's build.", "eval_laptop"),
    ("No problem — minipc now runs the hub's build.", "minipc"),
)
RESULT_CLAIMS = RESULT_ACTS + RESULT_STATES


@pytest.mark.parametrize("reply,machine", RESULT_CLAIMS)
def test_an_updates_result_beside_a_send_is_corrected_and_a_confirmed_one_backs_it(reply, machine):
    sent = guards.narration_check(reply, [_update_span(machine, outcome="sent")], PAIRED)
    assert sent is not None and kinds(sent) == ["updated_machine"], reply
    assert targets(sent) == [machine]
    assert sent.text == (
        f"Correction: nothing this turn confirmed an update of a machine named {machine} — only "
        "the agent reconnecting on the hub's build confirms one."
    )
    confirmed = [_update_span(machine, outcome="confirmed")]
    assert guards.narration_check(reply, confirmed, PAIRED) is None, reply
    # A confirmed update of another machine backs nothing about this one.
    elsewhere = [_update_span(machine, outcome="sent"), _update_span("box", outcome="confirmed")]
    assert guards.narration_check(reply, elsewhere, PAIRED) is not None, reply


@pytest.mark.parametrize("reply,machine", RESULT_CLAIMS)
def test_current_backs_the_state_an_update_leaves_but_never_her_install(reply, machine):
    """machine_update's "current": nothing was sent, its agent last reported
    the hub's build. The state is true; "I installed the new build" is not."""
    current = [_update_span(machine, outcome="current")]
    correction = guards.narration_check(reply, current, PAIRED)
    if (reply, machine) in RESULT_ACTS:
        assert correction is not None and targets(correction) == [machine], reply
    else:
        assert correction is None, reply


# Measured, not guessed (scratch/t32b2-core/mf4_gap_precision.py: 96 honest
# replies after a send, 0 corrected): a sample of the honest ones — negated,
# conditional, future, an intent to check, a step that is not the result, the
# family's clause split ("yet", "then") cutting a complement or a consequent
# off what governs it, and other software's builds and updates.
RESULT_HONEST_AFTER_A_SEND = (
    "I sent it; it installs once it reconnects.",
    "It is not installed yet.",
    "The new build is not installed on minipc yet.",
    "minipc isn't on the hub's build yet.",
    "The update on minipc is not complete yet.",
    "I haven't installed the new build on minipc — I only sent it.",
    "If the update is complete on minipc, machine_status will say so.",
    "Once minipc is on the hub's build, I'll tell you.",
    "As soon as minipc is running the hub's build, the update is confirmed.",
    "minipc is on the hub's build only once it reconnects.",
    "minipc will be running the hub's build after it restarts.",
    "I'll confirm minipc is on the hub's build once it reconnects.",
    "Let me check that the update is complete on minipc.",
    "You'll see minipc is on the hub's build when it reconnects.",
    "I can't say minipc is on the hub's build yet.",
    "Nothing confirms that minipc is on the hub's build yet.",
    "The update is done sending; minipc confirms it when it reconnects.",
    "The update on minipc is done downloading — it restarts next.",
    "There's no sign yet that the update finished on minipc.",
    "If minipc reconnects, then the update is complete on minipc.",
    "Has the update completed on minipc? Not yet.",
    "Firefox on minipc is now on the latest build.",
    "I installed the new build of Firefox on minipc.",
    "The apt update is complete on minipc.",
)


@pytest.mark.parametrize("reply", RESULT_HONEST_AFTER_A_SEND)
def test_honest_words_about_a_sent_update_are_never_corrected(reply):
    correction = guards.narration_check(reply, [_update_span("minipc", outcome="sent")], PAIRED)
    assert correction is None, (reply, correction)


@pytest.mark.parametrize(
    "reply",
    [
        "The update is complete.",
        "It is now on the hub's build.",
        "I installed the new build on it.",
        "Your new phone is now on the hub's build.",
    ],
)
def test_a_result_that_names_no_machine_is_no_claim(reply):
    """ "the new build" and "the update" are anyone's: only a machine she names
    makes one of these an update claim."""
    assert guards.narration_check(reply, [_update_span("minipc", outcome="sent")], PAIRED) is None


def test_an_install_or_an_update_done_is_read_only_beside_this_turns_update_of_it():
    """Without this turn's update of that machine an install is
    device_completion's claim — "(No machine_update or device_run call ran on
    minipc this turn.)", the one true sentence (MF4's division) — and "the
    update" may be apt's or Windows'. The build it RUNS is read beside any
    update fact this turn holds for it: machine_status's row too. device_list
    states an agent's build and records no update fact, so nothing it showed
    is contradicted here."""
    install = "I installed the new build on minipc."
    done = "The update is complete on minipc."
    on_build = "minipc is now on the hub's build."
    row_sent = [_status_span("minipc", outcome="sent")]
    listing = [
        SimpleNamespace(
            kind="tool",
            name="device_list",
            meta={"ok": True, "facts": [{"device": "minipc", "connected": True}]},
        )
    ]
    for spans in ([], [other_span()], row_sent, listing):
        assert guards.narration_check(install, spans, PAIRED) is None
        assert guards.narration_check(done, spans, PAIRED) is None
    assert guards.narration_check(on_build, [], PAIRED) is None
    assert guards.narration_check(on_build, listing, PAIRED) is None
    corrected = guards.narration_check(on_build, row_sent, PAIRED)
    assert corrected is not None and targets(corrected) == ["minipc"]
    # This turn's update of ANOTHER machine makes no claim about this one.
    other = [_update_span("eval_laptop", outcome="sent")]
    assert guards.narration_check(install, other, PAIRED) is None


DEVICE_TOOLS = ("device_run", "device_launch_app", "device_write_file", "device_notify")
TWO_MACHINES = {"minipc": "e" * 64, "eval_laptop": "f" * 64}


@pytest.mark.parametrize("reply,machine", [*RESULT_ACTS, RESULT_STATES[0]])
def test_one_install_claim_draws_one_sentence_whatever_the_record(reply, machine):
    """The re-check the brief asked for: MF4 (a machine_update on X backs
    device_completion's install claim about X) and this widening never both
    correct one reply. A send: this family alone. Confirmed: neither. No
    update of X — none at all, a failed one, or another machine's — the
    device guard alone, and this family says nothing."""
    tools_ = [*DEVICE_TOOLS, "machine_update"]
    failed = _update_span(machine, outcome="cannot", ok=False)
    records = {
        "sent": ([_update_span(machine, outcome="sent")], "narration"),
        "confirmed": ([_update_span(machine, outcome="confirmed")], None),
        "none": ([], "device_completion"),
        "failed": ([failed], "device_completion"),
        "another": ([_update_span("box", outcome="sent")], "device_completion"),
    }
    for label, (spans, which) in records.items():
        narration = guards.narration_check(reply, spans, PAIRED)
        device = guards.device_completion_check(
            reply, spans, tools_, PAIRED, machines={**TWO_MACHINES, "box": "b" * 64}
        )
        said = {
            name
            for name, claim in (("narration", narration), ("device_completion", device))
            if claim is not None
        }
        assert said == ({which} if which else set()), (label, reply, narration, device)


# -- one binding per name, module-wide -------------------------------------------
#
# The guards build patterns from shared fragments (_PRESENT_COPULA, _STATE_ADVERB,
# …) at import and at call time, and a function reads a module name when it
# RUNS. So a second top-level binding of a name silently replaces the first for
# every reader, earlier in the file or later: said-not-done fix round 2 bound
# `_PRESENT_COPULA` again as a frozenset, and the state guard, the observation
# guard and the memory-outage guard stopped firing without an error. This is the
# line that refuses the next one.


def test_no_name_is_bound_twice_at_the_top_of_guards_or_chat():
    import ast
    from pathlib import Path

    for module in (guards, chat):
        tree = ast.parse(Path(module.__file__).read_text())
        seen: dict[str, int] = {}
        twice: list[str] = []
        for node in tree.body:
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
                names = [node.name]
            elif isinstance(node, ast.Assign):
                names = [target.id for target in node.targets if isinstance(target, ast.Name)]
            elif isinstance(node, ast.AnnAssign) and isinstance(node.target, ast.Name):
                names = [node.target.id]
            else:
                names = []
            for name in names:
                if name in seen:
                    twice.append(f"{name} (lines {seen[name]} and {node.lineno})")
                seen[name] = node.lineno
        assert not twice, f"{module.__name__}: bound twice: {twice}"


# -- S29a T2 (2026-10-09): a tool joins a claim kind by declaring `backs` --------
#
# Criteria (the tracker's T2 section holds the same):
#   C1 Tool.backs is a frozenset of claim kinds (default empty), and
#      tools.tool_names_backing(kind) is DERIVED from the live registry: a tool
#      monkeypatched in declaring a kind backs it by that declaration alone.
#   C2 guards._KIND_TOOLS is gone; the named sets other guards and
#      test_state_guard pin (_CONFIGURE_TOOLS, _UPDATE_TOOLS, _FETCH_TOOLS, ...)
#      stay.
#   C3 device_read_file backs read_file + file_contents and device_write_file
#      backs wrote_file, target-aware through the span's `file` fact (T1):
#      "I read README.md on the Dell" over an ok device_read_file of
#      .../README.md stands; "I read config.yaml" over the same span is
#      corrected; the same for device_write_file and "I wrote notes.md".
#   C4 every other kind keeps exactly the tools it had (the per-tool pin in
#      test_tools_registry), so the existing claim guards behave unchanged.


def device_file_span(name: str, op: str, path: str, *, ok: bool = True):
    """An ok device file span as chat records it after T1: the device and path
    in args_redacted, and the agent-confirmed `file` fact."""
    facts = [{"file": {"op": op, "device": "dell"}, "target": path}] if ok else []
    return SimpleNamespace(
        kind="tool",
        name=name,
        meta={"ok": ok, "args_redacted": {"device": "dell", "path": path}, "facts": facts},
    )


def test_t2_kind_tools_dict_is_gone():
    assert not hasattr(guards, "_KIND_TOOLS"), (
        "guards._KIND_TOOLS is a maintained list; T2 derives the kind's tools from Tool.backs"
    )


def test_t2_named_sets_other_guards_pin_stay():
    for name in ("_CONFIGURE_TOOLS", "_UPDATE_TOOLS", "_FETCH_TOOLS", "_PERSONA_UPDATE_TOOLS"):
        assert isinstance(getattr(guards, name), frozenset), name


def test_t2_a_tool_declaring_backs_backs_that_kind_by_the_declaration_alone(monkeypatch):
    from app import tools
    from app.tools.base import Tool

    async def _noop(args, ctx):
        return "ok"

    monkeypatch.setitem(
        tools.REGISTRY,
        "t2_reader",
        Tool(
            name="t2_reader",
            description="reads",
            parameters={"type": "object", "properties": {}},
            executor=_noop,
            backs=frozenset({"read_file"}),
        ),
    )
    assert "t2_reader" in tools.tool_names_backing("read_file")
    assert "t2_reader" not in tools.tool_names_backing("wrote_file")
    span = SimpleNamespace(kind="tool", name="t2_reader", meta={"ok": True, "args_redacted": {}})
    assert guards.narration_check("I read report.md.", [span]) is None


def test_t2_device_read_backs_a_read_of_that_file():
    span = device_file_span("device_read_file", "read", "C:/src/nova/README.md")
    assert guards.narration_check("I read README.md on the Dell.", [span]) is None


def test_t2_device_read_does_not_back_a_read_of_another_file():
    span = device_file_span("device_read_file", "read", "C:/src/nova/README.md")
    correction = guards.narration_check("I read config.yaml on the Dell.", [span])
    assert correction is not None
    assert kinds(correction) == ["read_file"]
    assert targets(correction) == ["config.yaml"]


def test_t2_device_write_backs_a_write_of_that_file():
    span = device_file_span("device_write_file", "write", "/home/j/notes.md")
    assert guards.narration_check("I wrote notes.md on the mini PC.", [span]) is None
    assert guards.narration_check("I've saved notes.md.", [span]) is None


def test_t2_device_write_does_not_back_a_write_of_another_file():
    span = device_file_span("device_write_file", "write", "/home/j/notes.md")
    correction = guards.narration_check("I wrote todo.md on the mini PC.", [span])
    assert correction is not None
    assert kinds(correction) == ["wrote_file"]
    assert targets(correction) == ["todo.md"]


def test_t2_a_device_read_does_not_back_a_write():
    span = device_file_span("device_read_file", "read", "/home/j/notes.md")
    correction = guards.narration_check("I wrote notes.md on the mini PC.", [span])
    assert correction is not None
    assert kinds(correction) == ["wrote_file"]


def test_t2_a_failed_device_read_backs_nothing():
    span = device_file_span("device_read_file", "read", "C:/src/nova/README.md", ok=False)
    correction = guards.narration_check("I read README.md on the Dell.", [span])
    assert correction is not None
    assert kinds(correction) == ["read_file"]


# T2 COVERAGE (2026-10-09): C3's "target-aware via the span's `file` fact" —
# the tests above give the fact and the argument the same path, so reading
# only the argument would pass them. These pin that the agent-confirmed fact
# target decides, and that a span with no fact falls back to its argument
# (never to None, which would back a claim of ANY file).


def test_t2_cov_the_file_fact_target_outranks_the_path_argument():
    span = SimpleNamespace(
        kind="tool",
        name="device_read_file",
        meta={
            "ok": True,
            "args_redacted": {"device": "dell", "path": "C:/src/nova/link.md"},
            "facts": [
                {"file": {"op": "read", "device": "dell"}, "target": "C:/src/nova/README.md"}
            ],
        },
    )
    assert guards.narration_check("I read README.md on the Dell.", [span]) is None
    correction = guards.narration_check("I read link.md on the Dell.", [span])
    assert correction is not None
    assert targets(correction) == ["link.md"]


def test_t2_cov_an_ok_device_span_without_a_file_fact_is_read_by_its_argument():
    span = SimpleNamespace(
        kind="tool",
        name="device_write_file",
        meta={"ok": True, "args_redacted": {"device": "dell", "path": "/home/j/notes.md"}},
    )
    assert guards.narration_check("I wrote notes.md on the mini PC.", [span]) is None
    correction = guards.narration_check("I wrote todo.md on the mini PC.", [span])
    assert correction is not None
    assert targets(correction) == ["todo.md"]


# -- S29a T3 (2026-10-09): "the tests passed" is backed only by a run fact ------
#
# Criteria (the tracker's T3 section holds the same):
#   C1 claim kind tests_passed: her completed claim that tests passed ("All 40
#      tests passed.", "The tests passed.", "All tests pass now.") is backed
#      ONLY by a `run` fact (T1) whose target is a test-runner invocation
#      (pytest, uv run pytest, python -m pytest, npm test, go test, cargo test
#      ...) with exit_code 0. No run fact, a non-runner run (ls, cat
#      pytest.ini), a run span with no fact, or another tool's prose result
#      ("40 passed") backs nothing.
#   C2 the LAST test-runner run fact this turn decides: exit 1 under "all 40
#      tests passed" is corrected, exit 0 stands; exit 1 then exit 0 stands,
#      exit 0 then exit 1 is corrected; a later non-runner run changes nothing.
#   C3 derived from facts, never from the owner's message: narration_check
#      still reads only her reply and the spans (signature pinned).
#   C4 precision first: hedged, future, conditional, negated, other-subject
#      and question forms stay silent with no run at all.
#   C5 every new regex is swept by test_guard_regex_timing (a module pattern
#      whose name holds TESTS_PASSED) and narration reads 50 KB of the claim
#      in linear time.


def device_run_span(argv: list[str], exit_code: int | None, *, ok: bool = True, fact: bool = True):
    """A device_run span as chat records it after T1: args, and the run fact."""
    facts = (
        [
            {
                "run": {"exit_code": exit_code, "device": "mini-pc", "argv": argv, "cwd": None},
                "target": " ".join(argv),
            }
        ]
        if fact
        else []
    )
    return SimpleNamespace(
        kind="tool",
        name="device_run",
        meta={"ok": ok, "args_redacted": {"device": "mini-pc", "argv": argv}, "facts": facts},
    )


PYTEST = ["uv", "run", "pytest", "-q"]


def _tests_passed(correction) -> bool:
    return correction is not None and "tests_passed" in kinds(correction)


@pytest.mark.parametrize(
    "reply", ["All 40 tests passed.", "The tests passed.", "All tests pass now."]
)
def test_t3_a_tests_passed_claim_with_no_run_is_corrected(reply):
    assert _tests_passed(guards.narration_check(reply, []))


def test_t3_exit_1_under_all_40_tests_passed_is_corrected():
    correction = guards.narration_check("All 40 tests passed.", [device_run_span(PYTEST, 1)])
    assert _tests_passed(correction)


def test_t3_exit_0_under_all_40_tests_passed_stands():
    assert guards.narration_check("All 40 tests passed.", [device_run_span(PYTEST, 0)]) is None


@pytest.mark.parametrize(
    "argv",
    [
        ["pytest"],
        ["python3", "-m", "pytest", "tests/"],
        ["npm", "test"],
        ["go", "test", "./..."],
        ["cargo", "test"],
    ],
    ids=lambda a: " ".join(a),
)
def test_t3_any_test_runner_with_exit_0_backs_the_claim(argv):
    assert guards.narration_check("The tests passed.", [device_run_span(argv, 0)]) is None


@pytest.mark.parametrize(
    "argv",
    [["ls", "-la"], ["cat", "pytest.ini"], ["echo", "all", "40", "tests", "passed"]],
    ids=lambda a: " ".join(a),
)
def test_t3_a_non_runner_exit_0_backs_nothing(argv):
    assert _tests_passed(guards.narration_check("All 40 tests passed.", [device_run_span(argv, 0)]))


def test_t3_a_run_span_without_a_run_fact_backs_nothing():
    span = device_run_span(PYTEST, 0, fact=False)
    assert _tests_passed(guards.narration_check("All 40 tests passed.", [span]))


def test_t3_another_tools_prose_result_backs_nothing():
    span = SimpleNamespace(
        kind="tool",
        name="workspace_read_file",
        meta={
            "ok": True,
            "args_redacted": {"path": "pytest.log"},
            "result_head": "===== 40 passed in 3.21s =====",
        },
    )
    assert _tests_passed(guards.narration_check("All 40 tests passed.", [span]))


def test_t3_a_failed_run_then_a_passing_run_stands():
    spans = [device_run_span(PYTEST, 1), device_run_span(PYTEST, 0)]
    assert guards.narration_check("All 40 tests passed.", spans) is None


def test_t3_a_passing_run_then_a_failed_run_is_corrected():
    spans = [device_run_span(PYTEST, 0), device_run_span(PYTEST, 1)]
    assert _tests_passed(guards.narration_check("All 40 tests passed.", spans))


def test_t3_a_later_non_runner_run_does_not_change_the_decision():
    passed_then_ls = [device_run_span(PYTEST, 0), device_run_span(["git", "status"], 1)]
    assert guards.narration_check("All 40 tests passed.", passed_then_ls) is None
    failed_then_ls = [device_run_span(PYTEST, 1), device_run_span(["ls"], 0)]
    assert _tests_passed(guards.narration_check("All 40 tests passed.", failed_then_ls))


def test_t3_narration_reads_only_her_reply_and_the_spans():
    import inspect

    assert list(inspect.signature(guards.narration_check).parameters) == [
        "reply_text",
        "spans",
        "device_names",
    ]


@pytest.mark.parametrize(
    "reply",
    [
        "The tests should pass now.",
        "All 40 tests probably passed.",
        "I'll run pytest; the tests will pass once the fixture is fixed.",
        "Once all 40 tests pass, I'll open the PR.",
        "If all 40 tests passed, the build is good.",
        "Not all tests passed.",
        "The tests did not pass.",
        "None of the tests passed.",
        "You said all 40 tests passed.",
        "CI reported that all tests passed.",
        "Did all 40 tests pass?",
    ],
)
def test_t3_hedged_future_negated_and_other_subject_forms_stay_silent(reply):
    assert not _tests_passed(guards.narration_check(reply, []))


# T3 COVERAGE (2026-10-09): the forms the criteria name but the RED block left
# unpinned — a failed frame's run fact (C2: every run fact decides, ok or not),
# a shell's `-c` and a wrapper chain (C1: a runner is read through them), the
# correction's own sentence (a failed run is a record, so "no record of the
# action" would be false), and the present-only condition cut (C4).


def test_t3_cov_a_failed_frame_after_a_pass_is_corrected():
    spans = [device_run_span(PYTEST, 0), device_run_span(PYTEST, None, ok=False)]
    assert _tests_passed(guards.narration_check("All 40 tests passed.", spans))


@pytest.mark.parametrize(
    "argv",
    [
        ["bash", "-c", "cd services/core && uv run pytest -q"],
        ["env", "CI=1", "npm", "run", "test"],
        ["/usr/bin/python3.12", "-m", "pytest"],
    ],
    ids=lambda a: " ".join(a),
)
def test_t3_cov_a_runner_behind_a_shell_or_wrapper_backs_the_claim(argv):
    assert guards.narration_check("The tests passed.", [device_run_span(argv, 0)]) is None
    assert _tests_passed(guards.narration_check("The tests passed.", [device_run_span(argv, 2)]))


def test_t3_cov_the_correction_names_the_failing_run():
    # T3b: the text names the deciding run (was "no test run exited 0", false
    # beside an earlier passing suite).
    correction = guards.narration_check("All 40 tests passed.", [device_run_span(PYTEST, 1)])
    assert correction is not None and correction.text == guards.TESTS_FAILED_RUN_TEXT.format(
        command="uv run pytest -q", outcome="exited 1"
    )
    assert "no record of the action" not in correction.text


def test_t3_cov_a_condition_cuts_only_a_present_pass():
    assert not _tests_passed(guards.narration_check("Once all 40 tests pass, I'll merge.", []))
    assert _tests_passed(guards.narration_check("When I ran it, all 40 tests passed.", []))


# -- S29a T3b (2026-10-09): the tests_passed correction is true in every case --
#
# Criteria (the tracker's T3b section holds the same):
#   C1 the correction names the deciding run — the LAST test-runner run fact
#      this turn — by its command and its exit code; npm test exit 0 then
#      pytest exit 1 names pytest's exit 1 and never says "no test run ...
#      exited 0" (npm test did).
#   C2 with no test-runner run fact this turn (none at all, or only non-runners)
#      it says no test runner ran this turn.


def test_t3b_npm_pass_then_pytest_fail_names_pytest_exit_1():
    spans = [device_run_span(["npm", "test"], 0), device_run_span(PYTEST, 1)]
    correction = guards.narration_check("All tests passed.", spans)
    assert _tests_passed(correction)
    assert "uv run pytest -q" in correction.text
    assert "exited 1" in correction.text
    assert "exited 0" not in correction.text
    assert "no test run" not in correction.text


def test_t3b_a_failing_run_is_named_with_its_exit_code():
    correction = guards.narration_check("All 40 tests passed.", [device_run_span(["pytest"], 2)])
    assert _tests_passed(correction)
    assert "`pytest`" in correction.text and "exited 2" in correction.text


def test_t3b_a_failed_frame_says_no_exit_code():
    spans = [device_run_span(PYTEST, None, ok=False)]
    correction = guards.narration_check("All 40 tests passed.", spans)
    assert _tests_passed(correction)
    assert "uv run pytest -q" in correction.text and "no exit code" in correction.text
    assert "exited" not in correction.text


@pytest.mark.parametrize("spans", [[], [device_run_span(["ls", "-la"], 0)]], ids=["none", "ls"])
def test_t3b_no_runner_says_no_test_runner_ran(spans):
    correction = guards.narration_check("The tests passed.", spans)
    assert _tests_passed(correction)
    assert "no test runner ran this turn" in correction.text
    assert "exited" not in correction.text


def test_t3b_the_named_command_drops_env_assignments():
    argv = ["env", "GH_TOKEN=ghp_secretsecret", "npm", "test"]
    correction = guards.narration_check("The tests passed.", [device_run_span(argv, 1)])
    assert _tests_passed(correction)
    assert "ghp_" not in correction.text and "npm test" in correction.text


# -- S29a T4 (2026-10-09): "I ran X" is backed only by a run fact of X ----------
#
# Criteria (the tracker's T4 section holds the same):
#   C1 claim kind ran_command: her completed claim "I ran `X`" / "I ran X" /
#      "I've run X", target = X's program (its first word after KEY=value
#      words, by _program). Backed by a `run` fact (T1) this turn whose target
#      holds a word with that program (wrappers and shells included: "I ran
#      pytest" over `uv run pytest -q` stands), ANY exit code and ok or failed
#      frame alike: running is not passing.
#   C2 unbacked is corrected: no run fact, a run fact of another program, a
#      device_run span with no run fact, or another tool's prose backs nothing.
#   C3 the correction is TRUE in every case: with no run fact this turn it says
#      no command ran this turn; when other commands ran it names what did run
#      (their commands, KEY=value words dropped, bounded); never "no record of
#      the action" beside a run that is on record.
#   C4 precision first: future, hedged, negated, other-subject and question
#      forms, and the English "ran" (ran into / out of / it / the tests / fine)
#      stay silent with no run at all.
#   C5 every new regex is module-level with RAN_COMMAND in its name (the global
#      timing sweep reaches it), and narration reads 50 KB of claims in linear
#      time (test_guard_regex_timing).


def _ran_command(correction) -> bool:
    return correction is not None and "ran_command" in kinds(correction)


def _ran_targets(correction) -> list:
    return [t for k, t in zip(kinds(correction), targets(correction)) if k == "ran_command"]


@pytest.mark.parametrize(
    "reply,program",
    [
        ("I ran `pytest` on the mini PC.", "pytest"),
        ("I ran pytest on the mini PC.", "pytest"),
        ("I ran `python3 --version` on the mini PC.", "python3"),
        ("I ran git status in the worktree.", "git"),
        ("I've run `npm test` there.", "npm"),
        ("I ran `CI=1 cargo build`.", "cargo"),
    ],
)
def test_t4_a_ran_claim_with_no_run_is_corrected_naming_the_program(reply, program):
    correction = guards.narration_check(reply, [])
    assert _ran_command(correction)
    assert program in _ran_targets(correction)


@pytest.mark.parametrize("exit_code,ok", [(0, True), (1, True), (127, True), (None, False)])
def test_t4_a_run_fact_of_that_program_backs_the_claim_whatever_its_exit(exit_code, ok):
    span = device_run_span(["python3", "--version"], exit_code, ok=ok)
    correction = guards.narration_check("I ran `python3 --version` on the mini PC.", [span])
    assert not _ran_command(correction)


@pytest.mark.parametrize(
    "argv",
    [
        ["uv", "run", "pytest", "-q"],
        ["bash", "-c", "cd services/core && pytest -q"],
        ["/usr/bin/pytest"],
    ],
    ids=lambda a: " ".join(a),
)
def test_t4_the_programs_word_anywhere_in_the_target_backs_it(argv):
    assert not _ran_command(guards.narration_check("I ran pytest.", [device_run_span(argv, 1)]))


def test_t4_a_run_of_another_program_backs_nothing():
    correction = guards.narration_check("I ran `pytest`.", [device_run_span(["ls", "-la"], 0)])
    assert _ran_command(correction)


def test_t4_a_run_span_without_a_run_fact_backs_nothing():
    span = device_run_span(["pytest"], 0, fact=False)
    assert _ran_command(guards.narration_check("I ran `pytest`.", [span]))


def test_t4_another_tools_prose_backs_nothing():
    span = SimpleNamespace(
        kind="tool",
        name="workspace_read_file",
        meta={"ok": True, "args_redacted": {"path": "run.log"}, "result_head": "$ pytest -q"},
    )
    assert _ran_command(guards.narration_check("I ran `pytest`.", [span]))


def test_t4_the_claim_is_target_aware_per_program():
    spans = [device_run_span(["git", "status"], 0)]
    correction = guards.narration_check("I ran `git status` and then `pytest`.", spans)
    assert _ran_command(correction)
    assert _ran_targets(correction) == ["pytest"]


def test_t4_with_no_run_the_correction_says_no_command_ran():
    correction = guards.narration_check("I ran `pytest`.", [])
    assert _ran_command(correction)
    assert "no command ran this turn" in correction.text
    assert "no record of the action" not in correction.text


def test_t4_when_something_else_ran_the_correction_names_it():
    spans = [device_run_span(["ls", "-la"], 0), device_run_span(["git", "status"], 1)]
    correction = guards.narration_check("I ran `pytest`.", spans)
    assert _ran_command(correction)
    assert "ls -la" in correction.text and "git status" in correction.text
    assert "no command ran" not in correction.text
    assert "no record of the action" not in correction.text


def test_t4_the_named_commands_drop_env_assignments():
    spans = [device_run_span(["env", "GH_TOKEN=ghp_secretsecret", "gh", "auth", "status"], 1)]
    correction = guards.narration_check("I ran `pytest`.", spans)
    assert _ran_command(correction)
    assert "ghp_" not in correction.text and "gh auth status" in correction.text


@pytest.mark.parametrize(
    "reply",
    [
        "I'll run `pytest` next.",
        "I can run pytest if you like.",
        "I should run `pytest` first.",
        "I didn't run pytest.",
        "I haven't run `pytest` yet.",
        "I never ran pytest.",
        "Maybe I ran `pytest` earlier.",
        "You ran `pytest` yesterday.",
        "CI ran pytest on the PR.",
        "Did I run `pytest`?",
        "I ran into an error.",
        "I ran out of time.",
        "I ran it again.",
        "I ran the tests.",
        "Everything ran fine.",
    ],
)
def test_t4_hedged_future_negated_other_subject_and_english_ran_stay_silent(reply):
    assert not _ran_command(guards.narration_check(reply, []))


# -- S29a T4 COVERAGE (2026-10-09): the paths GREEN added beyond C1-C5's tests --


def test_t4_cov_a_reply_unbacked_on_both_run_kinds_gets_both_true_texts():
    correction = guards.narration_check("I ran `pytest` and all 40 tests passed.", [])
    assert _ran_command(correction) and _tests_passed(correction)
    assert "no test runner ran this turn" in correction.text
    assert "no command ran this turn" in correction.text
    assert "no record of the action" not in correction.text


def test_t4_cov_a_ran_claim_backed_beside_a_failed_test_run_leaves_only_the_tests_text():
    correction = guards.narration_check(
        "I ran `pytest` and all 40 tests passed.", [device_run_span(PYTEST, 1)]
    )
    assert _tests_passed(correction) and not _ran_command(correction)
    assert "exited 1" in correction.text and "what ran this turn" not in correction.text


def test_t4_cov_a_comma_chain_of_commands_is_read_per_program():
    spans = [device_run_span(["ls"], 0), device_run_span(["pwd"], 0)]
    correction = guards.narration_check("I ran `ls`, `pwd` and `pytest`.", spans)
    assert _ran_targets(correction) == ["pytest"]


def test_t4_cov_the_named_commands_are_bounded():
    spans = [device_run_span([f"cmd{i}"], 0) for i in range(7)]
    correction = guards.narration_check("I ran `pytest`.", spans)
    assert "`cmd4`" in correction.text and "`cmd5`" not in correction.text
    assert "and 2 more" in correction.text


def test_t4_cov_an_adverb_after_ran_is_english():
    assert not _ran_command(guards.narration_check("I ran quickly through the list.", []))


# -- S29a T5 (2026-10-09): "I edited X" is backed only by a write of X ----------
#
# Criteria (the tracker's T5 section holds the same):
#   C1 claim kind edited_file: her completed first-person claim "I edited /
#      modified / patched / changed <file>" ("I've edited", "I have modified",
#      "I just patched"), the filename the verb's own object, target = that
#      filename. With no write at all it is corrected, as exactly one
#      edited_file claim (never also wrote_file).
#   C2 backed only by an ok write to that NAME, target-aware: an ok
#      device_write_file whose `file` fact (op write) targets …/<file>, an ok
#      workspace_write_file of it, or a `run` fact (T1) whose words name the file
#      (a shell edit: sed -i, a script; any exit). A write of ANOTHER file (the
#      module docstring's case: writing new.py while claiming chat.py was
#      edited), a device READ of the file, a failed device write, a memory note
#      or another tool's prose backs nothing.
#   C3 precision first: future, hedged, negated, other-subject, question and
#      topic forms, and an edit verb with no filename ("I changed my mind", "I
#      edited the file"), stay silent with no write at all.
#   C4 "edited" ends another verb's object walk: "I read notes.md and edited
#      todo.md" over a read of notes.md corrects only edited_file todo.md.
#   C5 linear: narration reads 50 KB of edited claims in linear time and finds
#      them (test_guard_regex_timing); any new regex is module-level with
#      EDITED_FILE in its name, so the global sweep reaches it.


def _edited(correction) -> bool:
    return correction is not None and "edited_file" in kinds(correction)


def _edited_targets(correction) -> list:
    return [t for k, t in zip(kinds(correction), targets(correction)) if k == "edited_file"]


@pytest.mark.parametrize(
    "reply",
    [
        "I edited chat.py.",
        "I modified chat.py on the mini PC.",
        "I patched chat.py to fix the bug.",
        "I changed chat.py.",
        "I've edited chat.py.",
        "I have modified chat.py.",
        "I just patched chat.py.",
    ],
)
def test_t5_an_edit_claim_with_no_write_is_corrected_naming_the_file(reply):
    correction = guards.narration_check(reply, [])
    assert _edited(correction)
    assert kinds(correction) == ["edited_file"]
    assert targets(correction) == ["chat.py"]


def test_t5_an_ok_device_write_of_that_file_backs_it():
    span = device_file_span("device_write_file", "write", "/home/j/nova/services/core/chat.py")
    assert guards.narration_check("I edited chat.py on the mini PC.", [span]) is None


def test_t5_an_ok_workspace_write_of_that_file_backs_it():
    span = _tool_span("workspace_write_file", args={"path": "notes/chat.py"})
    assert guards.narration_check("I modified chat.py.", [span]) is None


@pytest.mark.parametrize("exit_code,ok", [(0, True), (1, True)])
def test_t5_a_run_fact_naming_the_file_backs_it(exit_code, ok):
    span = device_run_span(["sed", "-i", "s/a/b/", "services/core/app/chat.py"], exit_code, ok=ok)
    assert not _edited(guards.narration_check("I patched chat.py.", [span]))


def test_t5_a_write_of_another_file_backs_nothing():
    span = device_file_span("device_write_file", "write", "/home/j/nova/new.py")
    correction = guards.narration_check("I edited chat.py.", [span])
    assert _edited(correction)
    assert _edited_targets(correction) == ["chat.py"]


def test_t5_a_device_read_of_the_file_backs_nothing():
    span = device_file_span("device_read_file", "read", "/home/j/nova/chat.py")
    assert _edited(guards.narration_check("I edited chat.py.", [span]))


def test_t5_a_failed_device_write_backs_nothing():
    span = device_file_span("device_write_file", "write", "/home/j/nova/chat.py", ok=False)
    assert _edited(guards.narration_check("I edited chat.py.", [span]))


def test_t5_a_memory_note_backs_nothing():
    span = _tool_span("memory_save", args={"title": "chat.py", "content": "edited"})
    assert _edited(guards.narration_check("I edited chat.py.", [span]))


def test_t5_a_run_fact_of_another_file_backs_nothing():
    span = device_run_span(["sed", "-i", "s/a/b/", "app/guards.py"], 0)
    assert _edited(guards.narration_check("I edited chat.py.", [span]))


def test_t5_another_tools_prose_backs_nothing():
    span = SimpleNamespace(
        kind="tool",
        name="fetch_url",
        meta={
            "ok": True,
            "args_redacted": {"url": "https://example.com/log"},
            "result_head": "modified: chat.py",
        },
    )
    assert _edited(guards.narration_check("I edited chat.py.", [span]))


def test_t5_the_claim_is_target_aware_per_file():
    span = device_file_span("device_write_file", "write", "/home/j/nova/chat.py")
    correction = guards.narration_check("I edited chat.py and modified guards.py.", [span])
    assert _edited_targets(correction) == ["guards.py"]


@pytest.mark.parametrize(
    "reply",
    [
        "I'll edit chat.py next.",
        "I can modify chat.py if you like.",
        "I should patch chat.py first.",
        "I didn't edit chat.py.",
        "I haven't modified chat.py yet.",
        "I never changed chat.py.",
        "You edited chat.py yesterday.",
        "The previous session modified chat.py.",
        "Did I edit chat.py?",
        "I changed my mind.",
        "I edited the file.",
        "I edited the notes about chat.py.",
        "chat.py was edited by you.",
    ],
)
def test_t5_hedged_future_negated_other_subject_and_fileless_forms_stay_silent(reply):
    assert not _edited(guards.narration_check(reply, []))


def test_t5_edited_ends_another_verbs_object_walk():
    span = device_file_span("device_read_file", "read", "/home/j/notes.md")
    correction = guards.narration_check("I read notes.md and edited todo.md.", [span])
    assert correction is not None
    assert kinds(correction) == ["edited_file"]
    assert targets(correction) == ["todo.md"]


# -- S29a T5 coverage: the edges the RED block left open ------------------------


def test_t5_cov_a_failed_frames_run_fact_naming_the_file_backs_it():
    # C2 "any exit": a failed frame still ran (T1 files its run fact), so a
    # shell edit it names backs the claim, as ran_command reads it (T4).
    span = device_run_span(["sed", "-i", "s/a/b/", "app/chat.py"], None, ok=False)
    assert not _edited(guards.narration_check("I patched chat.py.", [span]))


def test_t5_cov_a_write_whose_name_only_contains_the_file_backs_nothing():
    # C2 "to that NAME": the written file's own name, never a substring of it.
    span = device_file_span("device_write_file", "write", "/home/j/nova/mychat.py")
    assert _edited_targets(guards.narration_check("I edited chat.py.", [span])) == ["chat.py"]


def test_t5_cov_a_run_word_that_only_contains_the_file_backs_nothing():
    span = device_run_span(["cp", "chat.py.bak", "old_chat.py"], 0)
    assert _edited(guards.narration_check("I edited chat.py.", [span]))


def test_t5_cov_the_written_path_is_matched_case_insensitively_by_its_last_segment():
    span = device_file_span("device_write_file", "write", "C:\\Users\\j\\nova\\Chat.py")
    assert guards.narration_check("I edited chat.py on the Dell.", [span]) is None


# -- S30a T5 (2026-10-09): a device edit backs "I edited X" / "I wrote X" ------
#
# Criterion C3 of the S30a T5 section (tests/test_device_ranges_edit_search.py
# holds the rest): device_edit_file's ok span carries the `edit` fact
# {"edit": {"device", "matches", "bytes_before", "bytes_after"}, "target":
# <checked path>}; Tool.backs = {edited_file, wrote_file}, target-aware through
# that fact (_target_of): an edit of .../chat.py backs "I edited chat.py" and
# "I wrote chat.py", never the same claims of guards.py, and a failed edit
# (no fact, ok False) backs nothing.


def device_edit_span(path: str, *, ok: bool = True):
    """A device_edit_file span as chat records it: the args, and on ok the
    agent-confirmed `edit` fact."""
    facts = (
        [
            {
                "edit": {
                    "device": "mini",
                    "matches": 1,
                    "bytes_before": 100,
                    "bytes_after": 104,
                },
                "target": path,
            }
        ]
        if ok
        else []
    )
    return SimpleNamespace(
        kind="tool",
        name="device_edit_file",
        meta={
            "ok": ok,
            "args_redacted": {"device": "mini", "path": path, "old": "a", "new": "b"},
            "facts": facts,
        },
    )


_EDITED_CHAT = "/home/j/nova/services/core/app/chat.py"


def test_s30a_t5_an_ok_edit_backs_an_edit_of_that_file_and_not_of_another():
    span = device_edit_span(_EDITED_CHAT)
    assert guards.narration_check("I edited chat.py on the mini PC.", [span]) is None
    correction = guards.narration_check("I edited guards.py on the mini PC.", [span])
    assert _edited_targets(correction) == ["guards.py"]


def test_s30a_t5_an_ok_edit_backs_a_write_of_that_file_and_not_of_another():
    span = device_edit_span(_EDITED_CHAT)
    assert guards.narration_check("I wrote chat.py on the mini PC.", [span]) is None
    correction = guards.narration_check("I wrote guards.py on the mini PC.", [span])
    assert correction is not None
    assert kinds(correction) == ["wrote_file"]
    assert targets(correction) == ["guards.py"]


def test_s30a_t5_the_target_is_the_edit_facts_not_the_argument():
    # The agent's checked path is what was edited (as for device_write_file).
    span = device_edit_span(_EDITED_CHAT)
    span.meta["args_redacted"]["path"] = "@home/whatever.txt"
    assert guards.narration_check("I edited chat.py.", [span]) is None
    assert _edited(guards.narration_check("I edited whatever.txt.", [span]))


def test_s30a_t5_a_failed_edit_backs_nothing_where_an_ok_one_does():
    assert guards.narration_check("I edited chat.py.", [device_edit_span(_EDITED_CHAT)]) is None
    failed = device_edit_span(_EDITED_CHAT, ok=False)
    assert _edited(guards.narration_check("I edited chat.py.", [failed]))
    assert "wrote_file" in kinds(guards.narration_check("I wrote chat.py.", [failed]))


# -- S29b T7 (2026-10-09): a mixed test report over a failing run is honest -----
#
# Criteria (the tracker's T7 section holds the same):
#   C1 a passed count whose sentence also states a nonzero failure or error
#      count ("39 tests passed and 1 failed.", "39 passed, 1 failed, 2
#      skipped.", "38 tests passed but 2 failed.", "39 passed with 1 error.")
#      is a report of a failing run, not a claim it passed: silent over exit 1.
#   C2 unqualified claims still fire over exit 1 ("All 40 tests passed.", "40
#      tests passed.", "The tests passed."), and so does a zero count: "40
#      passed, 0 failed." / "All 40 tests passed with no failures."
#   C3 the mixed forms stay silent over exit 0 too (backed as before).
#   C4 the new regex is linear and swept by test_guard_regex_timing.
#
# T7 rework (orchestrator ruling 2026-10-09, "stop chasing sentence shapes"):
# over a failing run the correction fires only when the WHOLE REPLY
# acknowledges no failure — a failure word not negated ("0 failed", "no
# failures", "none failed", "without failures", "zero errors" are negated), a
# partial count "N of M" / "N/M" with N != M, or "except" / "but one" / "all
# but" beside a test or pass word, or "only N" before passed. Anywhere in the
# reply: a later sentence, a bullet list. Read in one linear pass.

MIXED_TEST_REPORTS = [
    "39 tests passed and 1 failed.",
    "39 passed, 1 failed, 2 skipped.",
    "38 tests passed but 2 failed.",
    "39 tests passed; 1 test failed.",
    "39 passed with 1 error.",
    "All but one of the tests passed: 39 tests passed and one failed.",
]


@pytest.mark.parametrize("reply", MIXED_TEST_REPORTS)
def test_s29b_t7_c1_a_mixed_report_over_a_failing_run_is_silent(reply):
    assert not _tests_passed(guards.narration_check(reply, [device_run_span(PYTEST, 1)]))


@pytest.mark.parametrize(
    "reply",
    [
        "All 40 tests passed.",
        "40 tests passed.",
        "The tests passed.",
        "All 40 tests passed with no failures.",
        "All 40 tests passed and 0 errors.",
        # T7 rework: the ruling's firing set. (T7 narrowing: "40 passed, 0
        # failed.", "40 passed with no failures.", "All 40 passed — no
        # errors." left this list — main never read a bare "<N> passed" as a
        # claim, and T7 may only remove corrections; see NOT_ON_MAIN_EITHER.)
        "40/40 tests passed.",
        "All 40 tests passed without failures.",
    ],
)
def test_s29b_t7_c2_an_unqualified_or_zero_failure_claim_over_a_failing_run_fires(reply):
    assert _tests_passed(guards.narration_check(reply, [device_run_span(PYTEST, 1)]))


# T7 rework: VERIFY's five honest reports it corrected, plus a failure in a
# later sentence or a bullet list, a partial "N/M", and "but one".
ACKNOWLEDGED_FAILURE_REPORTS = [
    "39 of 40 tests passed; test_y failed.",
    "39 tests passed, but test_y failed.",
    "All tests passed except one: test_y failed.",
    "Only 39 of 40 tests passed.",
    "39 tests passed. One test failed: test_y.",
    "40 tests passed. 1 failed earlier, before my fix.",
    "The core tests passed.\n\n- test_x: ok\n- test_y: failed",
    "The tests passed for core. The web package had 2 failures.",
    "39/40 tests passed.",
    "All the tests passed but one.",
]


@pytest.mark.parametrize("reply", ACKNOWLEDGED_FAILURE_REPORTS)
def test_s29b_t7_rework_a_reply_that_acknowledges_a_failure_is_silent_over_a_failing_run(reply):
    assert not _tests_passed(guards.narration_check(reply, [device_run_span(PYTEST, 1)]))


@pytest.mark.parametrize("reply", ACKNOWLEDGED_FAILURE_REPORTS + MIXED_TEST_REPORTS)
def test_s29b_t7_rework_the_same_reports_over_a_passing_run_are_silent(reply):
    assert not _tests_passed(guards.narration_check(reply, [device_run_span(PYTEST, 0)]))


@pytest.mark.parametrize(
    "reply",
    [
        "All 40 tests passed. No errors.",
        "All 40 tests passed; zero errors.",
        "All 40 tests passed, none failed.",
        "All 40 tests passed. Nothing to fix.",
        "40 of 40 tests passed.",
        "All 40 tests passed except for a slow one that took 3s.",
    ],
)
def test_s29b_t7_rework_negated_failures_and_whole_counts_do_not_acknowledge(reply):
    # A negated failure word and a whole count acknowledge nothing; "except"
    # beside a pass word does (precision first: the last one is silent).
    fired = _tests_passed(guards.narration_check(reply, [device_run_span(PYTEST, 1)]))
    assert fired == ("except" not in reply)


@pytest.mark.parametrize("reply", MIXED_TEST_REPORTS)
def test_s29b_t7_c3_a_mixed_report_over_a_passing_run_stays_silent(reply):
    assert not _tests_passed(guards.narration_check(reply, [device_run_span(PYTEST, 0)]))


def test_s29b_t7_c2_a_bare_count_is_never_a_claim():
    # T7 narrowing (orchestrator ruling 2026-10-09): main never read a bare
    # "<N> passed" (no "tests") as a claim, with or without a tally, and T7
    # may only remove corrections — so a bare count stays no claim anywhere.
    failing = [device_run_span(PYTEST, 1)]
    assert not _tests_passed(guards.narration_check("40 passed, 2 skipped.", failing))
    assert guards.narration_check("40 passed, 2 skipped.", [device_run_span(PYTEST, 0)]) is None
    assert not _tests_passed(guards.narration_check("Of the 5 bills, 3 passed.", []))
    assert not _tests_passed(guards.narration_check("3 passed the exam and 2 failed it.", []))
    assert not _tests_passed(guards.narration_check("If 40 passed, 0 failed, I'll merge.", []))


# -- S29b T7 narrowing (orchestrator ruling 2026-10-09, after VERIFY 2) --------
#
# T7 is a pure NARROWING of main's tests_passed correction, scoped to turns
# whose deciding test run FAILED:
#   N1 with no test-runner run on record, or a passing deciding run, the
#      correction behaves exactly as on main (same claim detection, same
#      firing): VERIFY 2's honest no-run sentences are silent, as on main, and
#      an acknowledged report with no run fires, as on main.
#   N2 under a failing deciding run the reply-level acknowledgement silences
#      it; a negation ("0 failed", "no failures", "none failed", "nothing
#      failed", "nothing is broken", "no errors", "zero errors", "without
#      failures") acknowledges nothing.
#   N3 under a failing run T7 only removes corrections main makes, never adds.

# VERIFY 2: honest, no spans; main silent, T7 corrected them ("no test runner
# ran this turn") by reading a bare "<N> passed" beside a tally as a claim.
VERIFY_2_NO_RUN_HONEST = [
    "12 passed the audit, 0 failed it.",
    "3 passed the exam with no errors.",
    "Of the 30 students, 28 passed, 2 skipped the exam.",
    "All 12 passed the inspection with zero errors.",
    "In the trial, 40 passed with no failures recorded.",
    "Last semester 18 passed, 0 failed.",
    "The class did well: 22 passed with no failures.",
    "40 passed with no failures in the driving test this year.",
    "25 passed the vote, 3 abstained, none failed to show up.",
]


@pytest.mark.parametrize("reply", VERIFY_2_NO_RUN_HONEST)
def test_s29b_t7_n1_honest_no_run_sentences_are_silent(reply):
    assert not _tests_passed(guards.narration_check(reply, []))


# Shapes main never fired on (a bare count): silent under every record.
NOT_ON_MAIN_EITHER = [
    "40 passed, 0 failed.",
    "40 passed with no failures.",
    "All 40 passed — no errors.",
    "All 40 passed; nothing is broken.",
]


@pytest.mark.parametrize("reply", NOT_ON_MAIN_EITHER)
@pytest.mark.parametrize("code", [None, 0, 1])
def test_s29b_t7_n3_a_shape_main_never_fired_on_stays_silent(reply, code):
    spans = [] if code is None else [device_run_span(PYTEST, code)]
    assert not _tests_passed(guards.narration_check(reply, spans))


@pytest.mark.parametrize(
    "reply",
    [
        "39 tests passed, but test_y failed.",
        "39 of 40 tests passed; test_y failed.",
        "All the tests passed but one.",
        "The tests passed for core. The web package had 2 failures.",
    ],
)
def test_s29b_t7_n1_an_acknowledged_report_with_no_run_fires_as_on_main(reply):
    # The acknowledgement reads only under a failing deciding run: with none
    # on record, "<claim> … failed" is corrected exactly as main corrects it.
    correction = guards.narration_check(reply, [])
    assert _tests_passed(correction)
    assert "no test runner ran this turn" in correction.text


@pytest.mark.parametrize(
    "reply",
    [
        "All tests passed — nothing failed.",
        "All 40 tests passed; nothing is broken.",
        "All 40 tests passed, so the bug is fixed and nothing is broken.",
        "All 40 tests passed; none failed.",
        "All 40 tests passed, 0 failed.",
        "All 40 tests passed with no failures.",
        "All 40 tests passed; no errors.",
        "All 40 tests passed with zero errors.",
        "All 40 tests passed without failures.",
    ],
)
def test_s29b_t7_n2_a_negated_failure_acknowledges_nothing_over_a_failing_run(reply):
    assert _tests_passed(guards.narration_check(reply, [device_run_span(PYTEST, 1)]))


# -- S29b T7 COVERAGE (VERIFY 3: two C1 alternatives had no biting test) -------
#
# One sentence per acknowledgement form of _TESTS_FAILURE_ACK that ONLY that
# form matches, so deleting the form from guards.py turns exactly its case red
# (each was checked by deleting it). Each sentence carries a claim main
# corrects with no run (asserted below), so silence over exit 1 is the
# acknowledgement's doing, not a missing claim.
ACK_FORM_REPORTS = {
    # un-negated failure words, one each
    "fail-fails": "The core tests passed. test_y still fails.",
    "fail-failing": "The core tests passed. test_y is failing.",
    "fail-failures": "The core tests passed. test_y hit one failure.",
    "fail-errors": "The core tests passed. The web package had 2 errors.",
    "fail-error": "The core tests passed. test_y hit an error.",
    "fail-errored": "The core tests passed. test_y errored.",
    "fail-broke": "The core tests passed. test_y broke.",
    "fail-broken": "The core tests passed. test_y is broken.",
    # a partial count, each joiner
    "nm-of": "39 of 40 tests passed.",
    "nm-out-of": "39 out of 40 tests passed.",
    # a test/pass word, then the qualifier
    "fwd-all-but": "The tests passed, all but test_y.",
    "fwd-test-word": "All 40 tests passed. The tests ran green except on Windows.",
    "fwd-pass-word": "All 40 tests passed. Everything passed except test_y.",
    # the qualifier, then a test/pass word
    "rev-except": "Except for test_y, all 40 tests passed.",
    "rev-but-one": "All 40 tests passed. But one test hung.",
    "rev-all-but-two": "All but two tests passed.",
    "rev-all-but-one": "All but one test passed.",
    "rev-test-word": "All 40 tests passed. Except test_y, the tests are green.",
    "rev-pass-word": "All 40 tests passed. All but test_y passed.",
    # "only N" before passed, each quantity
    "only-digits": "Only 55 tests passed.",
    "only-number-word": "Only nine tests passed.",
    "only-some": "Only some tests passed.",
    "only-half": "Only half the tests passed.",
    "only-a-few": "Only a few tests passed.",
}


@pytest.mark.parametrize("reply", ACK_FORM_REPORTS.values(), ids=ACK_FORM_REPORTS.keys())
def test_s29b_t7_cov_each_acknowledgement_form_silences_a_failing_run(reply):
    assert not _tests_passed(guards.narration_check(reply, [device_run_span(PYTEST, 1)]))
    # The claim is real: with no run on record it is corrected, as on main.
    assert _tests_passed(guards.narration_check(reply, []))


# One sentence per negation (and the "-free" suffix) that ONLY that negation
# keeps from acknowledging: deleting it from guards.py silences the lie.
NEGATED_FORM_LIES = {
    "error-free": "All 40 tests passed, error-free.",
    "without-any": "All 40 tests passed without any failures.",
    "none-of-the-tests": "All 40 tests passed; none of the tests failed.",
    "none-of-them": "All 40 tests passed; none of them failed.",
    "zero-tests": "All 40 tests passed, 0 tests failed.",
    "no-tests": "All 40 tests passed and no tests failed.",
    "nothing-was": "All 40 tests passed; nothing was broken.",
    "nothing-has-been": "All 40 tests passed; nothing has been broken.",
    "nothing-got": "All 40 tests passed; nothing got broken.",
}


@pytest.mark.parametrize("reply", NEGATED_FORM_LIES.values(), ids=NEGATED_FORM_LIES.keys())
def test_s29b_t7_cov_each_negation_acknowledges_nothing(reply):
    assert _tests_passed(guards.narration_check(reply, [device_run_span(PYTEST, 1)]))
