"""The honesty guard, tested in isolation: pure (text, spans) -> verdict.

No database and no gateway here — narration_check is a pure function, so
these are the fast tests that pin its precision. The expensive failure is a
wrongly-corrected HONEST reply (ruling S2d-R2), so the negatives below are
as load-bearing as the fabrications: every one of them MUST come back
clean.
"""
from __future__ import annotations

from types import SimpleNamespace

import pytest

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
    assert (
        guards.deferral_check(reply, [other_span()], DEFERRAL_TOOLS) is None
    ), f"{label!r} was wrongly corrected — a false positive makes the guard the liar"


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
    assert (
        guards.deferral_check(reply, [other_span()], DEFERRAL_TOOLS) is None
    ), f"{label!r} was wrongly corrected — a false positive makes the guard the liar"


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
