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


def _failed_at_the_door(name: str, *, reached: bool = False):
    """A memory tool call that went through memory_tools._call_memory and
    failed there: the door records that it tried (C15)."""
    fact = {memory_tools.MEMORY_CALL_FACT: "/recall", "reached": reached}
    return _span("tool", name, ok=False, args_redacted={}, facts=[fact])


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
    # A memory_search that went through the door and failed (S40b final fix
    # wave, C15: the span carries the door's reached fact, as a real one does).
    ("walk_memory_search_failed", WALK, [LLM, RECALL, _failed_at_the_door("memory_search")]),
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
    answered recall.

    Pin moved in the S40b final fix wave (C15): for the tools that go through
    the one door (memory_search, memory_save), a failure is that evidence only
    when the call REACHED the door — the span carries the door's structured
    fact, for a transport failure and for memory's own refusal alike. The
    backfill's failure cannot be placed, and still counts."""
    for name in ("memory_search", "memory_save"):
        for reached in (False, True):
            spans = [LLM, RECALL, _failed_at_the_door(name, reached=reached)]
            assert guards.memory_claim_check(WALK, spans, purpose="chat") is None, name
    spans = [LLM, RECALL, _tool("memory_backfill", ok=False)]
    assert guards.memory_claim_check(WALK, spans, purpose="chat") is None


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


# -- S40b T4 review, fix round 2: a mention of her earlier reply is not a label ------
#
# Fix round 1 cut a memory claim on ANY mention of her earlier reply before it
# in its clause. Each sentence below FIRED at f81d0a1b and was SILENT at
# c9538364 with the recall answered (the reviewer's probes, verbatim first): a
# reassertion that cites the earlier reply, an update that states the outage
# anew, a report she reaffirms, and a new claim after a retraction. The history
# cut now reads a LABEL (guards._history_framed; see test_served_guard.py's
# fix round 2 for the rule).
MEMORY_REASSERTED_OVER_HISTORY = [
    (
        "as_mentioned_in_my_previous_response",
        "As mentioned in my previous response, the memory service is currently unreachable.",
    ),
    ("as_in_my_last_reply", "As in my last reply, the memory service is unreachable."),
    (
        "update_on_my_last_answer",
        "Update on my last answer: the memory service is now unreachable.",
    ),
    (
        "previous_answer_still_holds",
        "My previous answer still holds — the memory service is unreachable.",
    ),
    # The served probes' forms, over the memory claim.
    (
        "as_i_said_in_my_last_reply",
        "As I said in my last reply, the memory service is unreachable.",
    ),
    (
        "correction_to_my_last_reply",
        "Correction to my last reply: the memory service is unreachable.",
    ),
    (
        "last_reply_said_and_still_true",
        "My last reply said the memory service is unreachable, and that is still true.",
    ),
    (
        "named_then_wrong_then_a_new_claim",
        "My last reply named the gateway, which is wrong — the memory service is unreachable.",
    ),
    ("unchanged_from_my_last_reply", "Unchanged from my last reply: the memory service is down."),
    (
        "reaffirmed_in_the_next_sentence",
        "My last reply said I can't reach the memory service. That is still the case.",
    ),
    ("repeating_my_last_reply", "Repeating my last reply: the memory service is unreachable."),
]

# Her earlier reply, labelled as such. Each carries the same claim without its
# label, which fires, so the pin cannot pass on a claim the guard never read.
MEMORY_LABELLED_AS_HISTORY = [
    (
        "plain_report_of_her_last_reply",
        "My last reply said the memory service is unreachable.",
        "The memory service is unreachable.",
    ),
    (
        "from_my_previous_answer_heading",
        "From my previous answer: the memory service is unreachable.",
        "The memory service is unreachable.",
    ),
    (
        "according_to_my_last_reply",
        "According to my last reply, I can't reach the memory service.",
        "I can't reach the memory service.",
    ),
    (
        "in_my_last_reply_i_wrote_that",
        "In my last reply I wrote that the memory service is unreachable; this turn's recall "
        "answered.",
        "I wrote that the memory service is unreachable; this turn's recall answered.",
    ),
    (
        "retracted_then_a_still_about_something_else",
        "My last reply said the memory service is unreachable; that was stale. It is still the "
        "case that recall answered.",
        "The memory service is unreachable.",
    ),
    (
        "label_which_is_outdated",
        "From my previous answer, which is outdated: the memory service is unreachable.",
        "The memory service is unreachable.",
    ),
    (
        "report_with_an_outdated_aside",
        "My last reply said, and this is outdated, that the memory service is unreachable.",
        "The memory service is unreachable.",
    ),
    (
        "based_on_my_previous_response",
        "Based on my previous response, the memory service is unreachable.",
        "The memory service is unreachable.",
    ),
]


@pytest.mark.parametrize(
    "label,reply",
    MEMORY_REASSERTED_OVER_HISTORY,
    ids=[c[0] for c in MEMORY_REASSERTED_OVER_HISTORY],
)
@pytest.mark.parametrize("purpose", ["chat", "eval"])
def test_a_memory_claim_that_only_cites_her_earlier_reply_still_fires(purpose, label, reply):
    spans = [LLM, _recall(hits=5)]
    claim = guards.memory_claim_check(reply, spans, purpose=purpose)
    assert claim is not None, label
    assert claim.text == CORRECTION


@pytest.mark.parametrize(
    "label,reply,bare",
    MEMORY_LABELLED_AS_HISTORY,
    ids=[c[0] for c in MEMORY_LABELLED_AS_HISTORY],
)
@pytest.mark.parametrize("purpose", ["chat", "eval"])
def test_a_memory_claim_labelled_as_her_history_is_not_corrected(purpose, label, reply, bare):
    spans = [LLM, _recall(hits=5)]
    assert guards.memory_claim_check(reply, spans, purpose=purpose) is None, label
    assert guards.memory_claim_check(bare, spans, purpose=purpose) is not None, label


# -- S40b T4 review, fix round 3: a doubt is not a reaffirmation, a heading is not a lead
#
# Each sentence below FIRED at fa23ec1f and was SILENT at c9538364 with the
# recall answered (the reviewer's probes verbatim first). See
# test_state_guard.py's fix round 3 for the rule (guards._vouched,
# guards._NOT_A_LABEL_LEAD).
MEMORY_LABELLED_THEN_DOUBTED_OR_HEADED = [
    (
        "not_sure_that_is_still_true",
        "From my last reply: the memory service is unreachable. I'm not sure that is still true.",
        "The memory service is unreachable.",
    ),
    (
        "correction_heading_cant_confirm",
        "Correction: my previous answer said the memory service is currently unreachable. I "
        "can't confirm that now.",
        "The memory service is currently unreachable.",
    ),
    (
        "correction_heading_that_was_stale",
        "Correction: my previous answer said the memory service is currently unreachable "
        "(ConnectError). That was stale: memory answered this turn.",
        "The memory service is currently unreachable (ConnectError).",
    ),
    (
        "update_heading_from_history",
        "Update: my previous answer said the memory service is currently unreachable. That "
        "line was from history.",
        "The memory service is currently unreachable.",
    ),
    # The same doubt, spelled the other ways she writes it.
    (
        "dont_know_if_still_true",
        "From my last reply: the memory service is unreachable. I don't know if that is still "
        "true.",
        "The memory service is unreachable.",
    ),
    (
        "whether_still_the_case_i_cant_say",
        "My last reply said the memory service is unreachable. Whether that is still the case, "
        "I can't say.",
        "The memory service is unreachable.",
    ),
    (
        "cant_tell_you_whether_still_accurate",
        "My last reply said the memory service is unreachable; I can't tell you whether that is "
        "still accurate.",
        "The memory service is unreachable.",
    ),
    # The same heading, spelled the other ways she writes it.
    (
        "correction_dash_heading",
        "Correction — my previous answer said the memory service is unreachable; memory "
        "answered this turn.",
        "The memory service is unreachable; memory answered this turn.",
    ),
    (
        "correction_hyphen_heading",
        "Correction - my previous answer said the memory service is unreachable; memory "
        "answered this turn.",
        "The memory service is unreachable; memory answered this turn.",
    ),
    (
        "correction_comma_heading",
        "Correction, my previous answer said the memory service is unreachable; memory "
        "answered this turn.",
        "The memory service is unreachable; memory answered this turn.",
    ),
    (
        "bold_correction_heading",
        "**Correction:** my previous answer said the memory service is unreachable; memory "
        "answered this turn.",
        "The memory service is unreachable; memory answered this turn.",
    ),
    (
        "updated_heading",
        "Updated: my last reply said the memory service is unreachable; this turn's recall "
        "answered.",
        "The memory service is unreachable; this turn's recall answered.",
    ),
    (
        "as_a_correction_colon_heading",
        "As a correction: my previous answer said the memory service is unreachable; memory "
        "answered this turn.",
        "The memory service is unreachable; memory answered this turn.",
    ),
    (
        "as_a_correction_comma_heading",
        "As a correction, my previous answer said the memory service is unreachable; memory "
        "answered this turn.",
        "The memory service is unreachable; memory answered this turn.",
    ),
    (
        "as_an_update_heading",
        "As an update: my last reply said the memory service is unreachable; this turn's "
        "recall answered.",
        "The memory service is unreachable; this turn's recall answered.",
    ),
    (
        "fix_heading",
        "Fix: my last reply said the memory service is unreachable; this turn's recall answered.",
        "The memory service is unreachable; this turn's recall answered.",
    ),
    (
        "correction_heading_over_an_attribution",
        "Correction: from my previous answer, the memory service is unreachable; this turn's "
        "recall answered.",
        "The memory service is unreachable; this turn's recall answered.",
    ),
]

# What must keep firing: a doubt that is no doubt, and a lead that joins its
# label by a space.
MEMORY_STILL_REASSERTED = [
    (
        "no_doubt_still_true",
        "My last reply said the memory service is unreachable. No doubt that is still true.",
    ),
    (
        "sure_still_true",
        "My last reply said the memory service is unreachable. I'm sure that is still true.",
    ),
    (
        "not_sure_why_still_the_case",
        "My last reply said the memory service is unreachable. I'm not sure why that is still "
        "the case.",
    ),
    (
        "correcting_my_last_replys_memory_line",
        "Correcting my last reply's memory line: the memory service is unreachable.",
    ),
    (
        "update_from_my_last_reply",
        "Update from my last reply: the memory service is unreachable.",
    ),
    (
        "correction_heading_then_it_still_is",
        "Correction: my previous answer said the memory service is unreachable, and it still is.",
    ),
]


@pytest.mark.parametrize(
    "label,reply,bare",
    MEMORY_LABELLED_THEN_DOUBTED_OR_HEADED,
    ids=[c[0] for c in MEMORY_LABELLED_THEN_DOUBTED_OR_HEADED],
)
@pytest.mark.parametrize("purpose", ["chat", "eval"])
def test_a_doubted_or_headed_memory_history_label_is_not_corrected(purpose, label, reply, bare):
    spans = [LLM, _recall(hits=5)]
    assert guards.memory_claim_check(reply, spans, purpose=purpose) is None, label
    assert guards.memory_claim_check(bare, spans, purpose=purpose) is not None, label


@pytest.mark.parametrize(
    "label,reply", MEMORY_STILL_REASSERTED, ids=[c[0] for c in MEMORY_STILL_REASSERTED]
)
@pytest.mark.parametrize("purpose", ["chat", "eval"])
def test_a_vouched_reaffirmation_or_a_joined_lead_still_fires_on_the_memory_claim(
    purpose, label, reply
):
    claim = guards.memory_claim_check(reply, [LLM, _recall(hits=5)], purpose=purpose)
    assert claim is not None, label
    assert claim.text == CORRECTION


@pytest.mark.parametrize("regen", [c[1] for c in MEMORY_LABELLED_THEN_DOUBTED_OR_HEADED[:2]])
def test_a_regeneration_that_doubts_or_heads_her_memory_history_passes(regen):
    """The reviewer's regeneration probe: _regen_rejected_by refused the
    honest "Correction:" answer as memory_claim."""
    from app import agents, chat

    turn = SimpleNamespace(spans=[LLM, _recall(hits=5)], kind="chat")
    rejected = chat._regen_rejected_by(
        regen,
        turn,
        None,
        [],
        "Is your memory service working?",
        agents.nova_persona(),
        agent_names=[],
    )
    assert rejected is None


# ================================================================================
# S40b final fix wave (fix-wave-brief.md; reproductions in final-review.md)
# ================================================================================


def _memory_fires(reply: str, spans=None) -> bool:
    return guards.memory_claim_check(reply, spans or ANSWERED, purpose="chat") is not None


# -- A4: a line attributed to his notes is not her claim ---------------------------
MEMORY_ATTRIBUTED_TO_HIS_NOTES = [
    (
        "older_note_says_out_of_date",
        "Yes. Your older note says the memory service is unreachable, but that's out of date.",
    ),
    (
        "notes_say_but_it_answered",
        "Your notes say the memory service is unreachable, but it answered this turn.",
    ),
    ("according_to_your_notes", "According to your notes, the memory service is down."),
    ("per_your_journal", "Per your journal, the memory service is offline."),
]


@pytest.mark.parametrize(
    "label,reply",
    MEMORY_ATTRIBUTED_TO_HIS_NOTES,
    ids=[c[0] for c in MEMORY_ATTRIBUTED_TO_HIS_NOTES],
)
def test_a_memory_line_attributed_to_his_notes_is_not_corrected(label, reply):
    assert guards.memory_claim_check(reply, ANSWERED, purpose="chat") is None, label


def test_a_reaffirmed_memory_claim_beside_a_note_still_fires():
    assert _memory_fires(
        "The notes say the memory service is unreachable — and that is still true."
    )


# -- A8: a denial frame is not her assertion ---------------------------------------
@pytest.mark.parametrize(
    "reply",
    [
        "It's not that the memory service is down; recall just found nothing.",
        "Nothing says the memory service is down.",
        "It isn't the case that the memory service is down.",
        "There is no evidence that the memory service is unreachable.",
    ],
)
def test_a_denied_memory_claim_is_not_corrected(reply):
    assert guards.memory_claim_check(reply, ANSWERED, purpose="chat") is None, reply


def test_an_affirmed_frame_still_fires_on_the_memory_claim():
    assert _memory_fires("It is the case that the memory service is down.")


# -- A12: an attribution or a retraction AFTER the claim closes it -----------------
MEMORY_CLOSED_AFTER = [
    ("from_my_last_answer", "The memory service is currently unreachable (from my last answer)."),
    (
        "walk_line_this_was_wrong",
        "- The **memory service** (`memory`) is currently unreachable (`ConnectError`) — this "
        "was wrong; it answered this turn.",
    ),
    (
        "correction_to_my_last_answer_that_was_wrong",
        "Correction to my last answer: the memory service is currently unreachable — that was "
        "wrong.",
    ),
    (
        "stale_from_my_last_answer",
        "- The memory service is currently unreachable (stale — from my last answer)",
    ),
    ("outdated", "The memory service is currently unreachable (outdated)."),
    ("incorrect", "The memory service is currently unreachable (incorrect)."),
]


@pytest.mark.parametrize(
    "label,reply", MEMORY_CLOSED_AFTER, ids=[c[0] for c in MEMORY_CLOSED_AFTER]
)
@pytest.mark.parametrize("purpose", ["chat", "eval"])
def test_a_memory_claim_closed_after_it_is_not_corrected(purpose, label, reply):
    spans = [_span("llm_call", "hub:qwen3:8b", purpose=purpose, served_by="hub:qwen3:8b"), RECALL]
    assert guards.memory_claim_check(reply, spans, purpose=purpose) is None, label


def test_a_memory_claim_not_closed_after_it_still_fires():
    for reply in (
        "The memory service is currently unreachable (unchanged from my last answer).",
        "The memory service is currently unreachable. The Dell reading was wrong.",
        WALK,
    ):
        assert _memory_fires(reply), reply


# -- B1 / B2 (T4 breaker OPEN-1, OPEN-2) --------------------------------------------
@pytest.mark.parametrize(
    "reply",
    [
        "From my previous answer (if it still holds): the memory service is unreachable.",
        "From my previous answer (whether that still holds I can't say): the memory service "
        "is unreachable.",
    ],
)
def test_a_doubt_that_names_its_subject_keeps_the_memory_history_label(reply):
    assert guards.memory_claim_check(reply, ANSWERED, purpose="chat") is None, reply


@pytest.mark.parametrize(
    "head",
    [
        "No change:",
        "No changes:",
        "Nothing has changed —",
        "Nothing new —",
        "No update:",
        "No updates:",
    ],
)
@pytest.mark.parametrize(
    "body",
    [
        "{head} my previous answer said the memory service is unreachable.",
        "{head} from my previous answer, the memory service is unreachable.",
        "{head} the memory service is unreachable (from my previous answer).",
    ],
)
def test_a_negated_sameness_head_reaffirms_the_memory_claim(head, body):
    assert _memory_fires(body.format(head=head)), (head, body)


# -- C11: a struck span is visibly retracted ---------------------------------------
def test_a_struck_memory_claim_is_not_corrected():
    reply = "~~The memory service is currently unreachable~~ — it answered this turn."
    assert guards.memory_claim_check(reply, ANSWERED, purpose="chat") is None
    assert _memory_fires(reply.replace("~~", ""))


# -- C16: a general statement is a hedge -------------------------------------------
@pytest.mark.parametrize(
    "reply",
    [
        "Whenever the memory service is unreachable, I keep the note here.",
        "Any time the memory service is down, recall is skipped.",
        "Every time the memory service is offline, notes wait in a queue.",
        "Each time the memory service is unavailable, the turn goes on without recall.",
        "In the event the memory service is unreachable, nothing is lost.",
    ],
)
def test_a_general_statement_about_memory_is_not_corrected(reply):
    assert guards.memory_claim_check(reply, ANSWERED, purpose="chat") is None, reply


# -- A5: a fronted scope, or a limit after the anchor, limits the outage -----------
@pytest.mark.parametrize(
    "reply",
    [
        "From outside the tailnet, the memory service is unreachable.",
        "Off the tailnet, the memory service is unreachable.",
        "From your phone, the memory service is unreachable.",
        "The memory service is unreachable, as far as your phone is concerned.",
    ],
)
def test_a_scoped_memory_outage_is_not_corrected(reply):
    assert guards.memory_claim_check(reply, ANSWERED, purpose="chat") is None, reply


@pytest.mark.parametrize(
    "reply",
    [
        "For now, the memory service is unreachable.",
        "The memory service is unreachable, so notes were not searched.",
    ],
)
def test_an_unscoped_memory_outage_still_fires(reply):
    assert _memory_fires(reply), reply


# -- A5, narrowed: a scope has to NAME A REACH (fix-wave follow-up) ----------------
#
# The memory half of the overshoot pinned in test_state_guard.py: A5's first
# cut read any "<place-preposition> <determiner> <=40 chars>," as a scope, so
# every fronted discourse marker silenced the outage claim. Each of these fired
# at 9927da34 and went silent with A5 in.
FRONTED_MARKERS = [
    "To your question,",
    "On that note,",
    "For your information,",
    "From the look of it,",
    "On the whole,",
    "For this reason,",
    "To some extent,",
    "To my knowledge,",
    "On your behalf,",
    "For that matter,",
    "To this day,",
    "From my side,",
    "For a start,",
    "On a related note,",
]


@pytest.mark.parametrize("lead", FRONTED_MARKERS)
def test_a_fronted_discourse_marker_does_not_limit_the_memory_outage(lead):
    assert _memory_fires(f"{lead} the memory service is down."), lead


@pytest.mark.parametrize(
    "reply",
    [
        "The memory service is down, for your information.",
        "The memory service is down, from the look of it.",
    ],
)
def test_a_trailing_discourse_marker_does_not_limit_the_memory_outage(reply):
    assert _memory_fires(reply), reply


# -- A7: the memory noun must be the outage's SUBJECT -------------------------------
#
# Her honest description of a degraded recall — the very state the correction's
# own "What did not work" suffix reports — was corrected as "not unreachable
# now" (final-review #7).
DEGRADED_SPANS = [LLM, _recall(hits=3, retrievers_missing=DEGRADED)]
MEMORY_NOUN_NOT_THE_SUBJECT = [
    (
        "search_in_the_memory_service",
        "Semantic search in the memory service is unavailable right now, so notes were "
        "matched by keyword.",
    ),
    ("part_of", "Part of the memory service is unavailable: semantic search timed out."),
    (
        "reachable_though_search_in",
        "The memory service is reachable, though semantic search in the memory service is "
        "unavailable right now.",
    ),
    ("search_on", "Search on the memory service is unavailable right now."),
    ("index_of", "The vector index of the memory service is offline, so recall used keywords."),
    ("some_of", "Some of the memory service is down right now."),
    ("search_on_down", "Semantic search on the memory service is down."),
    (
        "recall_from_then_search_in",
        "Recall from the memory service is degraded: semantic search in the memory service is "
        "unavailable.",
    ),
]
# The memory noun as the object of "to"/"with" is still a claim that she
# cannot reach it — the reviewer's caveat.
MEMORY_ACCESS_STILL_FIRES = [
    ("access_to", "Access to the memory service is unavailable right now."),
    ("connection_to", "My connection to the memory service is down."),
    ("link_to", "The link to the memory service is offline."),
]


@pytest.mark.parametrize(
    "label,reply", MEMORY_NOUN_NOT_THE_SUBJECT, ids=[c[0] for c in MEMORY_NOUN_NOT_THE_SUBJECT]
)
def test_a_memory_noun_that_is_not_the_subject_is_not_corrected(label, reply):
    assert guards.memory_claim_check(reply, DEGRADED_SPANS, purpose="chat") is None, label


@pytest.mark.parametrize(
    "label,reply", MEMORY_ACCESS_STILL_FIRES, ids=[c[0] for c in MEMORY_ACCESS_STILL_FIRES]
)
def test_an_access_to_memory_outage_still_fires(label, reply):
    assert _memory_fires(reply, DEGRADED_SPANS), label


def test_the_walk_sentence_still_fires_beside_the_degraded_ones():
    assert _memory_fires(WALK, DEGRADED_SPANS)


# -- C5: a limiting parenthetical ends nothing; "down" takes the bracket anchor ----
@pytest.mark.parametrize(
    "reply",
    [
        "The memory service is unreachable (by design) from outside the tailnet.",
        "The memory service is unreachable (by design).",
        "The memory service is offline (for maintenance tonight).",
        "The memory service is down (on weekends).",
    ],
)
def test_a_limiting_parenthetical_is_not_a_present_outage(reply):
    assert guards.memory_claim_check(reply, ANSWERED, purpose="chat") is None, reply


@pytest.mark.parametrize(
    "reply",
    [
        "The memory service is down (`ConnectError`).",
        "- The **memory service** (`memory`) is currently down (`ConnectError`), but this is "
        "unrelated to the model-running machine (`hub`).",
        WALK,
    ],
)
def test_a_reason_in_brackets_still_anchors_the_outage(reply):
    assert _memory_fires(reply), reply


# -- C15: a call refused before it reached memory says nothing about memory --------
#
# A schema-refused call never runs its executor, and a live-source or identity
# refusal stops before the door's request: none reached memory, so none is
# evidence it is down — and her own malformed call could otherwise void the
# recall's answer. Read from the door's structured fact, never from the
# refusal's words.
@pytest.mark.parametrize("name", ["memory_search", "memory_save"])
def test_a_memory_call_refused_before_the_door_leaves_the_recall_standing(name):
    spans = [LLM, RECALL, _tool(name, ok=False)]
    claim = guards.memory_claim_check(WALK, spans, purpose="chat")
    assert claim is not None and claim.text == CORRECTION


async def test_the_door_records_every_call_that_reached_it(memory_link):
    """Unconfigured and unreachable are a request that never arrived; a
    refusal and an answer arrived. Each records exactly one fact."""
    from tests import fakes

    for memory, reached in (
        (None, False),
        (fakes.FakeMemory(recall_status=500), True),
        (fakes.FakeMemory(), True),
    ):
        ctx = memory_link(memory)
        ctx = type(ctx)(**{**ctx.__dict__, "facts_sink": []})
        await tools.dispatch("memory_search", {"query": "coffee"}, ctx)
        assert ctx.facts_sink == [{memory_tools.MEMORY_CALL_FACT: "/recall", "reached": reached}]


async def test_a_call_refused_before_the_door_records_nothing(memory_link):
    from tests import fakes

    ctx = memory_link(fakes.FakeMemory())
    ctx = type(ctx)(**{**ctx.__dict__, "facts_sink": []})
    # The schema refuses it: the executor never runs.
    _, ok = await tools.dispatch("memory_search", {}, ctx)
    assert ok is False and ctx.facts_sink == []
    # A live source that names no tool is refused inside the door, before the
    # request is sent.
    with pytest.raises(tools.ToolFailure):
        await memory_tools._call_memory(
            ctx, "/save", {"title": "a", "content": "b", "live_source": {"tool": "nope"}}
        )
    assert ctx.facts_sink == []
