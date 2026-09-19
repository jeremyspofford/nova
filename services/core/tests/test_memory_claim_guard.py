"""S40b's memory-outage guard, tested in isolation: pure (text, spans, purpose)
-> verdict.

The S40 live walk (2026-09-19): in turns b851aa91 and b02a5694 she reported
"The memory service (`memory`) is currently unreachable (`ConnectError`)" —
an outage from some earlier moment, stated as now — in turns whose own recall
had just been answered by that service (hits: 5). The fact the claim is checked against is
the turn's own memory_recall span: an int `hits` with no `error` means memory
answered, zero hits included. A recall that failed, a memory tool that failed
this turn, or no recall at all leaves an outage report alone.

Precision is the product: the corpus is the verdict's §4 "memory_claim" set,
verbatim (s40b/design-verdict.md). The correction is APPEND-class.
"""

from __future__ import annotations

from types import SimpleNamespace

import pytest

from app import guards, tools
from app.tools import memory_tools
from tests.s40_walk import B02A5694, B851AA91


def _span(kind: str, name: str | None, **meta):
    return SimpleNamespace(kind=kind, name=name, meta=dict(meta))


def _recall(**meta):
    """The turn's memory_recall span as chat._recall writes it."""
    return _span("memory_recall", None, k=5, **meta)


def _tool(name: str, *, ok: bool):
    return _span("tool", name, ok=ok, args_redacted={})


LLM = _span("llm_call", "hub:qwen3:8b", purpose="chat", served_by="hub:qwen3:8b")
RECALL = _recall(hits=5)
ANSWERED = [LLM, RECALL]

# The walk's sentence, verbatim from b02a5694 (and b851aa91).
WALK = (
    "- The **memory service** (`memory`) is currently unreachable (`ConnectError`), but this "
    "is unrelated to the model-running machine (`hub`)."
)
CORRECTION = (
    "Correction: the memory service answered this turn — this turn's recall was read from "
    "it — so it is not unreachable now."
)
MEMORY_MISSING_LEAD = " What did not work this turn: "
# b851aa91's recall carried memory's own sentence about a reduced search.
DEGRADED = (
    "the semantic search did not run — the embedding service at http://ollama:11434 did not "
    "answer within 1.5923s (ReadTimeout)."
)

# (label, reply, spans)
MUST_FIRE = [
    ("walk_sentence", WALK, ANSWERED),
    ("cant_reach", "I can't reach the memory service right now.", ANSWERED),
    ("your_service_down", "Your memory service is down.", ANSWERED),
    ("my_store_offline", "My memory store is offline.", ANSWERED),
    # Zero notes is an answer: memory searched and found nothing.
    ("walk_sentence_zero_hits", WALK, [LLM, _recall(hits=0)]),
    ("b02a5694_full", B02A5694, ANSWERED),
    ("b851aa91_full", B851AA91, [LLM, _recall(hits=5, retrievers_missing=DEGRADED)]),
]

MUST_NOT = [
    ("walk_recall_failed", WALK, [LLM, _recall(error="ConnectError: memory:8002")]),
    ("walk_memory_search_failed", WALK, [LLM, RECALL, _tool("memory_search", ok=False)]),
    ("walk_no_recall_span", WALK, [LLM]),
    (
        "long_term_memory_operations",
        "It might affect long-term memory operations but not model execution.",
        ANSWERED,
    ),
    (
        "semantic_recall_reduced",
        "Semantic recall was reduced this turn — the embedder did not answer within 1.6 s — "
        "so notes were matched by keyword.",
        ANSWERED,
    ),
    (
        "past_outage",
        "The memory service was unreachable on 2026-09-18 at 16:48.",
        ANSWERED,
    ),
    ("gpu_memory", "GPU memory is full.", ANSWERED),
    ("not_down", "The memory service is not down.", ANSWERED),
    (
        "dropped_off_earlier",
        "The memory service dropped off the network earlier this week (ConnectError).",
        ANSWERED,
    ),
    (
        "stack_check_notice",
        "Urgent (stack_memory): memory did not answer /health/live — ConnectError…",
        ANSWERED,
    ),
    ("its_embedder", "The memory service's embedder is unreachable.", ANSWERED),
    ("if_down", "If the memory service is down, I'll keep your note here.", ANSWERED),
    ("question", "Is the memory service down?", ANSWERED),
    ("you_said", "You said the memory service is down.", ANSWERED),
    ("degraded", "The memory service is degraded: semantic search timed out.", ANSWERED),
    ("down_for_maintenance", "The memory store is down for maintenance tonight.", ANSWERED),
    # T2 review, round 1: memory_backfill's ok says distillation RAN, not that
    # memory answered — distil.backfill states a failed /export as a limit and
    # collects failed saves, and still returns ran=True. In the one turn memory
    # really is down (the recall failed), this reply is true.
    (
        "backfill_ran_while_the_recall_failed",
        "The memory service is unreachable, so none of the facts were saved.",
        [LLM, _recall(error="ConnectError"), _tool("memory_backfill", ok=True)],
    ),
]

ACCEPTED_MISSES = [
    # No service noun: "memory" alone is also her recall, GPU memory, RAM.
    ("memory_is_unreachable", "Memory is unreachable."),
    # A contracted negation is not one of the listed states.
    ("isnt_responding", "The memory service isn't responding."),
    # T2 review, round 1: "can't reach" is her claim only in the first person
    # or with no subject. A third-party subject is usually a true statement of
    # the architecture ("your phone can't reach the memory service"), so a
    # service named as the one that cannot reach it is a miss by the same rule.
    ("core_cant_reach", "Core can't reach the memory service."),
]


@pytest.mark.parametrize("label,reply,spans", MUST_FIRE, ids=[c[0] for c in MUST_FIRE])
def test_memory_must_fire(label, reply, spans):
    claim = guards.memory_claim_check(reply, spans, purpose="chat")
    assert claim is not None, label
    assert claim.subject
    assert claim.phrase


def test_the_walk_correction_is_the_verdicts_text():
    claim = guards.memory_claim_check(WALK, ANSWERED, purpose="chat")
    assert claim.text == CORRECTION
    assert claim.retrievers_missing is None
    assert claim.subject == "The memory service"
    assert claim.phrase == "The memory service (memory) is currently unreachable"


def test_a_reduced_search_is_named_in_the_correction():
    """The recall answered, but not every search ran: the correction says what
    did not work, in memory's own sentence, so the true half of her report is
    kept."""
    spans = [LLM, _recall(hits=5, retrievers_missing=DEGRADED)]
    claim = guards.memory_claim_check(B851AA91, spans, purpose="chat")
    assert claim.retrievers_missing == DEGRADED
    assert claim.text == f"{CORRECTION}{MEMORY_MISSING_LEAD}{DEGRADED}"


@pytest.mark.parametrize("label,reply,spans", MUST_NOT, ids=[c[0] for c in MUST_NOT])
def test_memory_must_not_fire(label, reply, spans):
    assert guards.memory_claim_check(reply, spans, purpose="chat") is None


# -- T2 precision beyond the verdict's corpus ------------------------------------
#
# Honest sentences the verbatim pattern CORRECTED, found probing past the
# corpus while building T2: an outage word that does not end the claim is
# limited to a place, a schedule, a subject or a property ("unreachable from
# outside the tailnet" is TRUE — the stack binds 127.0.0.1 — and a recall from
# core does not contradict it). Every outage word now ends the claim, as the
# verdict's "down" already had to. The §4 MUST_FIRE set is unchanged.

HONEST_BEYOND_THE_CORPUS = [
    ("from_outside", "The memory service is unreachable from outside the tailnet."),
    ("from_your_phone", "The memory service is unreachable from your phone."),
    ("offline_for_maintenance", "The memory service is offline for maintenance tonight."),
    ("offline_on_weekends", "The memory service is offline on weekends."),
    ("unavailable_to_agents", "The memory service is unavailable to agents without shared notes."),
    (
        "not_reachable_from_the_internet",
        "The memory service is not reachable from the internet, by design.",
    ),
    ("offline_when_restarting", "The memory service is offline when the stack restarts."),
    ("over_the_tunnel", "The memory service is unavailable over the public tunnel."),
    (
        "disconnected_from_the_internet",
        "The memory service is disconnected from the internet but serves locally.",
    ),
    ("in_the_offline_build", "The memory service is unavailable in the offline build."),
    ("offline_capable", "Your memory service is offline-capable."),
    (
        "unresponsive_to_health_checks",
        "The memory service is unresponsive to health checks from the gateway.",
    ),
]

STILL_FIRE_BEYOND_THE_CORPUS = [
    ("right_now", "The memory service is unreachable right now."),
    ("so_connector", "The memory service is offline, so I can't save notes."),
    ("bracketed_reason", "The memory service is unavailable (timeout)."),
    ("and_connector", "The memory service is unreachable and recall failed."),
    ("at_the_moment", "The memory service is unresponsive at the moment."),
    ("because_connector", "The memory service is offline because the container stopped."),
    ("dash_reason", "The memory service is disconnected — ConnectError."),
]


@pytest.mark.parametrize(
    "label,reply", HONEST_BEYOND_THE_CORPUS, ids=[c[0] for c in HONEST_BEYOND_THE_CORPUS]
)
def test_honest_sentences_beyond_the_corpus_are_not_corrected(label, reply):
    assert guards.memory_claim_check(reply, ANSWERED, purpose="chat") is None


# -- T2 review, round 1: "can't reach" said of someone else, or limited ----------
#
# Probed at 4c62f5c9 with the recall answered: each FIRED. The can't-reach form
# never read WHO cannot reach memory, and had no anchor on what follows it, so
# the same true architecture statement Deviation 4 pins as honest in the
# "unreachable from outside the tailnet" form was corrected in this one. The
# claim is hers only in the first person or with no subject ("Can't reach the
# memory service."), and it ends the way _MEMORY_DOWN's outage words end.

UNREACHED_BY_SOMEONE_ELSE = [
    ("you_from_outside", "You can't reach the memory service from outside the tailnet."),
    (
        "phone_directly",
        "Your phone can't reach the memory service directly; it goes through core.",
    ),
    ("web_app_directly", "The web app cannot contact the memory service directly — core does."),
    ("without_the_tailnet_you", "Without the tailnet, you can't reach the memory service."),
    # First person, limited to a route, not an outage.
    ("i_directly", "I can't reach the memory service directly — core calls it for me."),
    ("we_from_your_phone", "We can't reach the memory service from your phone."),
]

# (label, reply, the phrase the guard span records: from "I"/"we", or from
# the verb when there is no subject — never a list mark)
UNREACHED_STILL_FIRE = [
    ("no_subject", "Can't reach the memory service right now.", "Can't reach the memory service"),
    (
        "we_bracketed_reason",
        "We cannot reach the memory service (ConnectError).",
        "We cannot reach the memory service",
    ),
    (
        "im_unable",
        "I'm unable to reach the memory service.",
        "I'm unable to reach the memory service",
    ),
    (
        "i_still_so",
        "I still can't reach the memory service, so the note stays here.",
        "I still can't reach the memory service",
    ),
    (
        "bullet_no_subject",
        "- Unable to connect to the memory service.",
        "Unable to connect to the memory service",
    ),
    (
        "curly_apostrophe",
        "I can’t reach the memory service right now.",
        "I can’t reach the memory service",
    ),
    (
        "after_an_opener",
        "Sorry, I can't reach the memory service.",
        "I can't reach the memory service",
    ),
]


@pytest.mark.parametrize(
    "label,reply", UNREACHED_BY_SOMEONE_ELSE, ids=[c[0] for c in UNREACHED_BY_SOMEONE_ELSE]
)
def test_cant_reach_said_of_someone_else_or_a_route_is_not_corrected(label, reply):
    assert guards.memory_claim_check(reply, ANSWERED, purpose="chat") is None


@pytest.mark.parametrize(
    "label,reply,phrase", UNREACHED_STILL_FIRE, ids=[c[0] for c in UNREACHED_STILL_FIRE]
)
def test_cant_reach_in_her_own_voice_still_fires(label, reply, phrase):
    claim = guards.memory_claim_check(reply, ANSWERED, purpose="chat")
    assert claim is not None, label
    assert claim.subject == "the memory service"
    assert claim.phrase == phrase


@pytest.mark.parametrize(
    "label,reply",
    STILL_FIRE_BEYOND_THE_CORPUS,
    ids=[c[0] for c in STILL_FIRE_BEYOND_THE_CORPUS],
)
def test_an_outage_word_that_ends_the_claim_still_fires(label, reply):
    assert guards.memory_claim_check(reply, ANSWERED, purpose="chat") is not None


@pytest.mark.parametrize("label,reply", ACCEPTED_MISSES, ids=[c[0] for c in ACCEPTED_MISSES])
def test_memory_accepted_misses_stay_missed(label, reply):
    assert guards.memory_claim_check(reply, ANSWERED, purpose="chat") is None


@pytest.mark.parametrize("unarmed", ["scheduled", "agent", "beat", None])
@pytest.mark.parametrize("label,reply,spans", MUST_FIRE, ids=[c[0] for c in MUST_FIRE])
def test_memory_must_fire_is_silent_where_the_guard_is_not_armed(unarmed, label, reply, spans):
    assert guards.memory_claim_check(reply, spans, purpose=unarmed) is None


@pytest.mark.parametrize("label,reply,spans", MUST_FIRE, ids=[c[0] for c in MUST_FIRE])
def test_memory_must_fire_in_the_eval_that_replays_chat(label, reply, spans):
    assert guards.memory_claim_check(reply, spans, purpose="eval") is not None


# -- what counts as memory having answered ------------------------------------


@pytest.mark.parametrize(
    "recall",
    [
        _recall(error="ConnectError"),
        _recall(),  # no hits recorded: the span was cut short
        _recall(hits="5"),
        _recall(hits=True),
        # An agent's recall of two scopes, both failed.
        _recall(
            hits=0,
            scopes={"own": 0, "shared": 0},
            errors={"own": "ConnectError", "shared": "ConnectError"},
        ),
        # Errors this span cannot match to its scopes.
        _recall(hits=0, errors={"own": "ConnectError"}),
    ],
)
def test_a_recall_that_did_not_answer_backs_no_correction(recall):
    assert guards.memory_claim_check(WALK, [LLM, recall], purpose="chat") is None


def test_one_scope_answering_is_memory_answering():
    recall = _recall(hits=2, scopes={"own": 2, "shared": 0}, errors={"shared": "ReadTimeout"})
    assert guards.memory_claim_check(WALK, [LLM, recall], purpose="chat") is not None


def test_a_memory_tool_that_succeeded_is_memory_answering():
    """No answered recall, but her own memory_search came back: memory answered.
    The correction then names that call, not a recall that did not happen."""
    spans = [LLM, _recall(error="ReadTimeout"), _tool("memory_search", ok=True)]
    claim = guards.memory_claim_check(WALK, spans, purpose="chat")
    assert claim is not None
    assert claim.text == (
        "Correction: the memory service answered this turn — this turn's memory_search call "
        "was answered by it — so it is not unreachable now."
    )
    assert claim.retrievers_missing is None


def test_any_memory_tool_that_failed_leaves_the_report_alone():
    """A failure this turn is evidence the report may be true — even beside an
    answered recall."""
    for name in ("memory_search", "memory_save", "memory_backfill"):
        spans = [LLM, RECALL, _tool(name, ok=False)]
        assert guards.memory_claim_check(WALK, spans, purpose="chat") is None, name


def test_a_non_memory_tool_neither_answers_nor_fails_for_memory():
    spans = [LLM, RECALL, _tool("fetch_url", ok=False)]
    assert guards.memory_claim_check(WALK, spans, purpose="chat") is not None
    assert (
        guards.memory_claim_check(WALK, [LLM, _tool("fetch_url", ok=True)], purpose="chat") is None
    )


def test_the_memory_tool_prefix_is_the_registrys():
    """Derived, never retyped: every tool memory_tools defines carries the
    prefix the guard reads, and nothing else in the registry does — a memory
    tool added or renamed turns this red rather than going unseen."""
    prefix = guards._MEMORY_TOOL_PREFIX
    defined = {tool.name for tool in memory_tools.TOOLS}
    assert defined and all(name.startswith(prefix) for name in defined)
    assert {name for name in tools.REGISTRY if name.startswith(prefix)} == defined


def test_a_backfill_that_ran_is_not_memory_answering():
    """T2 review, round 1. memory_backfill's ok means distillation RAN: a
    failed /export is a stated limit and failed saves are collected, and it
    still returns ran=True. So its ok is no evidence memory answered, and the
    correction it produced ("this turn's memory_backfill call was answered by
    it") was a false statement from the guard, in the very turn memory was
    down. A failed backfill still silences the guard (a failure is evidence
    the report may be true)."""
    reply = "The memory service is unreachable, so none of the facts were saved."
    alone = [LLM, _tool("memory_backfill", ok=True)]
    assert guards.memory_claim_check(reply, alone, purpose="chat") is None
    beside_an_answer = [LLM, RECALL, _tool("memory_backfill", ok=True)]
    claim = guards.memory_claim_check(reply, beside_an_answer, purpose="chat")
    assert claim is not None and claim.text == CORRECTION
    saved = [LLM, _recall(error="ConnectError"), _tool("memory_save", ok=True)]
    claim = guards.memory_claim_check(reply, saved, purpose="chat")
    assert claim is not None and "this turn's memory_save call was answered by it" in claim.text


def test_the_answering_memory_tools_are_every_memory_tool_but_the_backfill():
    """Derived from the registry, not retyped: the tools whose ok counts as
    memory answering, and the ones whose ok does not, together are exactly
    memory_tools.TOOLS. A memory tool added or renamed turns this red, so
    which side it belongs on is decided, never defaulted."""
    answering = guards._MEMORY_ANSWER_TOOLS
    ran_only = guards._MEMORY_RAN_NOT_ANSWERED
    defined = {tool.name for tool in memory_tools.TOOLS}
    assert answering and not answering & ran_only
    assert answering | ran_only == defined
    assert ran_only == {"memory_backfill"}


# Valid arguments for every answering tool: a tool added to the answering set
# without an entry here turns the pin below red.
_ANSWER_ARGS = {
    "memory_search": {"query": "coffee"},
    "memory_save": {"title": "A", "content": "b"},
}


@pytest.fixture
def memory_link(monkeypatch, tmp_path):
    """A ToolContext whose memory link is unconfigured, or a local fake (the
    test_tools_peers fixture's shape: no database, dispatch consults none)."""
    import uuid

    from app.identity import Person
    from app.main import app
    from tests import fakes

    person = Person(id=uuid.uuid4(), name="jeremy", role="owner")

    def _mount(memory=None):
        if memory is not None:
            monkeypatch.setenv("MEMORY_URL", fakes.MEMORY_URL)
            monkeypatch.setenv("CORE_MEMORY_TOKEN", fakes.MEMORY_TOKEN)
            app.state.peer_transports = {fakes.MEMORY_URL: fakes.StreamingASGITransport(memory.app)}
        else:
            monkeypatch.delenv("MEMORY_URL", raising=False)
            monkeypatch.delenv("CORE_MEMORY_TOKEN", raising=False)
            app.state.peer_transports = {}
        return tools.ToolContext(app=app, person=person, workspace_root=tmp_path)

    yield _mount
    app.state.peer_transports = {}


@pytest.mark.parametrize("name", sorted(_ANSWER_ARGS))
async def test_an_answering_tool_is_ok_only_when_memory_answered(name, memory_link):
    """What makes a tool's ok evidence: it cannot be ok unless memory answered
    with a 200 (_call_memory raises on anything else). Unconfigured, refused
    and answered are each dispatched through the real registry."""
    from tests import fakes

    assert name in guards._MEMORY_ANSWER_TOOLS
    assert set(_ANSWER_ARGS) == guards._MEMORY_ANSWER_TOOLS
    _, ok = await tools.dispatch(name, _ANSWER_ARGS[name], memory_link(None))
    assert ok is False
    refusing = fakes.FakeMemory(recall_status=500, save_status=500)
    _, ok = await tools.dispatch(name, _ANSWER_ARGS[name], memory_link(refusing))
    assert ok is False
    _, ok = await tools.dispatch(name, _ANSWER_ARGS[name], memory_link(fakes.FakeMemory()))
    assert ok is True


def test_an_empty_or_blank_reply_never_fires():
    for reply in ("", "   ", "\n"):
        assert guards.memory_claim_check(reply, ANSWERED, purpose="chat") is None


def test_fenced_and_quoted_copies_are_someone_elses_text():
    for reply in (f"```\n{WALK}\n```", f"> {WALK}"):
        assert guards.memory_claim_check(reply, ANSWERED, purpose="chat") is None


# -- the texts ----------------------------------------------------------------


@pytest.mark.parametrize(
    "text",
    [
        CORRECTION,
        f"{CORRECTION} What did not work this turn: {DEGRADED}",
        "Correction: the memory service answered this turn — this turn's memory_search call "
        "was answered by it — so it is not unreachable now.",
    ],
)
def test_the_corrections_trip_no_guard_of_their_own(text):
    """APPENDED to what persists, so a text that tripped a guard would be
    corrected forever."""
    for purpose in ("chat", "eval"):
        assert guards.memory_claim_check(text, ANSWERED, purpose=purpose) is None
        assert guards.served_claim_check(text, ANSWERED, purpose=purpose) is None
        assert guards.stack_claim_check(text, ANSWERED, purpose=purpose) is None
        assert guards.state_claim_check(text, ANSWERED, ["DELL-XPS-8950"], purpose=purpose) is None
    assert guards.narration_check(text, []) is None
    assert guards.consent_claim_check(text) is None
    assert guards.capability_claim_check(text, ["memory_search", "memory_save"]) is None
    assert guards.deferral_check(text, [], ["fetch_url", "web_search"]) is None
    assert guards.presented_listing_check(text, [], ["workspace_list_files"]) is None
    assert guards.bare_intent_check(text, []) is None
    assert guards.delivery_claim_check(text, []) is None
    if MEMORY_MISSING_LEAD not in text:
        # The beat's observation guard reads a checks pass's report, and
        # memory's own sentence about a search that did not run IS a report
        # of a failure — true, and from this turn's span, but not a check's
        # finding. It never meets it: the memory guard is armed in chat and
        # eval only, and observation_check runs over beats only (app/beats).
        assert guards.observation_check(text, [], []) is None


# -- S40b T4 review, fix round 1: what she says ABOUT the claim, before it ---------
#
# The v15 case seeds the walk's false memory line as her own history, and the
# answer it hopes for corrects it. Each sentence below FIRED at f81d0a1b with
# the recall answered (the reviewer's probes, verbatim), appending "the memory
# service answered this turn" to a reply that already said so, and keeping it
# out of memory. The cut reads the prefix of each claim's match in its clause;
# it is the served and memory guards' own, so the shared _STATE_HEDGE is not
# re-measured.

# A doubted or denied belief before the claim (finding 1).
MEMORY_DOUBTED = [
    ("dont_think_down", "I don't think the memory service is down."),
    ("not_true_that", "It is not true that the memory service is unreachable."),
    ("doubt", "I doubt the memory service is unreachable."),
    ("not_certain", "I'm not certain the memory service is unreachable."),
]

# Her retraction of her own earlier reply (finding 2).
MEMORY_RETRACTED = [
    (
        "last_reply_said_stale",
        "My last reply said the memory service is unreachable, which was stale.",
    ),
    (
        "in_my_last_reply_i_said",
        "In my last reply I said the memory service is unreachable; that was wrong.",
    ),
    ("i_told_you_wrong", "I told you the memory service is unreachable, which was wrong."),
    (
        "note_previous_answer_it_isnt",
        "Note: my previous answer said the memory store is offline — it isn't.",
    ),
    # The same retraction, with a bare "I said" retracted in what follows.
    ("i_said_then_retracted", "I said the memory service is unreachable. That was wrong."),
]

# Already quiet at f81d0a1b: someone's reply reported, and a prior time. Kept
# quiet.
MEMORY_REPORTED_CONTROLS = [
    ("the_previous_reply_said", "The previous reply said the memory service is unreachable."),
    ("last_time_i_said", "Last time I said the memory service is unreachable."),
]

# What must keep firing: a reassertion of an earlier reply ("As I said", "Like
# I said", "As I told you", a bare "I said"), a stated belief, a doubt that is
# no doubt, "not sure WHY" (which presupposes the outage), a message FROM the
# service, and her own plain claim.
MEMORY_STILL_ASSERTED = [
    ("as_i_said", "As I said, the memory service is unreachable."),
    ("like_i_said", "Like I said, the memory service is unreachable."),
    ("as_i_told_you", "As I told you, the memory service is unreachable."),
    ("bare_i_said", "I said the memory service is unreachable."),
    ("bare_i_told_you", "I told you the memory service is unreachable."),
    (
        "as_i_said_despite_a_retraction_after",
        "As I said, the memory service is unreachable. Your note said otherwise, and that was "
        "wrong.",
    ),
    ("i_think", "I think the memory service is down."),
    ("no_doubt", "No doubt the memory service is unreachable."),
    ("without_a_doubt", "Without a doubt, the memory service is down."),
    ("not_sure_why", "I'm not sure why the memory service is unreachable."),
    (
        "last_response_from_the_service",
        "The last response from the memory service timed out, and the memory service is "
        "unreachable now.",
    ),
    ("cant_reach", "I can't reach the memory service right now."),
]


@pytest.mark.parametrize(
    "label,reply",
    MEMORY_DOUBTED + MEMORY_RETRACTED + MEMORY_REPORTED_CONTROLS,
    ids=[c[0] for c in MEMORY_DOUBTED + MEMORY_RETRACTED + MEMORY_REPORTED_CONTROLS],
)
@pytest.mark.parametrize("hits", [0, 5])
@pytest.mark.parametrize("purpose", ["chat", "eval"])
def test_a_doubted_or_retracted_memory_claim_is_not_corrected(purpose, hits, label, reply):
    spans = [LLM, _recall(hits=hits)]
    assert guards.memory_claim_check(reply, spans, purpose=purpose) is None, label


@pytest.mark.parametrize(
    "label,reply", MEMORY_STILL_ASSERTED, ids=[c[0] for c in MEMORY_STILL_ASSERTED]
)
def test_a_reasserted_or_believed_memory_claim_still_fires(label, reply):
    claim = guards.memory_claim_check(reply, ANSWERED, purpose="chat")
    assert claim is not None, label
    assert claim.text == CORRECTION


# The cost of reading a retraction in the next sentence, pinned so it is a
# choice: a retraction there about something else reads as hers.
RETRACTION_ACCEPTED_MISSES = [
    (
        "retraction_about_the_note",
        "I said the memory service is unreachable. Your note said otherwise, and that was wrong.",
    ),
]


@pytest.mark.parametrize(
    "label,reply", RETRACTION_ACCEPTED_MISSES, ids=[c[0] for c in RETRACTION_ACCEPTED_MISSES]
)
def test_the_retraction_accepted_misses_stay_missed(label, reply):
    assert guards.memory_claim_check(reply, ANSWERED, purpose="chat") is None, label
