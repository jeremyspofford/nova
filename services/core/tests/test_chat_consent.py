"""The {"consent": ...} SSE frame, and the full deny/approve loop through a
real chat turn.

T1 built the kernel and the funnel gate (policy.authorize, consents.py); this
proves the seam T2 owns: a card the funnel raises this turn rides the stream
as its own frame (chat.py's consent_sink wiring), a denied card lets nothing
run, and an APPROVED card is not executed by the decision itself — only a
re-attempt through the funnel, in a later turn, actually runs the action and
burns the consent (ruling S3-R4). No fake success anywhere: the spy executor
proves exactly when the real tool body did or did not run.
"""
from __future__ import annotations

import json
import uuid
from dataclasses import dataclass, field

from app import chat, consents, guards, tools
from app.tools import web
from app.tools.base import Tool, ToolContext
from tests.conftest import requires_db
from tests.fakes import FakeMemory, ScriptedGateway

pytestmark = requires_db

DONE = "[DONE]"
FETCH_SCHEMA = next(t.parameters for t in web.TOOLS if t.name == "fetch_url")
URL = "https://example.com/pricing"


@dataclass
class Spy:
    calls: list = field(default_factory=list)
    result: str = "Fetched it."

    async def __call__(self, args: dict, ctx: ToolContext) -> str:
        self.calls.append(args)
        return self.result


def frames(body: str) -> list:
    out = []
    for block in body.strip().split("\n\n"):
        assert block.startswith("data: "), block
        payload = block[len("data: ") :]
        out.append(payload if payload == DONE else json.loads(payload))
    return out


def call_delta(index: int, *, call_id=None, name=None, arguments=None) -> dict:
    function: dict = {}
    if name is not None:
        function["name"] = name
    if arguments is not None:
        function["arguments"] = arguments
    fragment: dict = {"index": index, "function": function}
    if call_id is not None:
        fragment["id"] = call_id
        fragment["type"] = "function"
    return {"choices": [{"delta": {"tool_calls": [fragment]}}]}


def text(piece: str) -> dict:
    return {"choices": [{"delta": {"content": piece}}]}


def fetch_call(call_id: str, url: str) -> dict:
    return call_delta(0, call_id=call_id, name="fetch_url", arguments=json.dumps({"url": url}))


async def _say(client, message: str) -> list:
    resp = await client.post("/api/v1/chat/stream", json={"message": message})
    assert resp.status_code == 200, resp.text
    return frames(resp.text)


def consent_frames(sent: list) -> list[dict]:
    return [f["consent"] for f in sent if isinstance(f, dict) and "consent" in f]


async def _owner_id(pool) -> uuid.UUID:
    return await pool.fetchval("SELECT id FROM people WHERE role = 'owner'")


def _spy_fetch(monkeypatch) -> Spy:
    spy = Spy()
    # ephemeral=True mirrors the REAL fetch_url (web.py): a live, point-in-time
    # read whose result the turn loop must not ingest, or recall serves it stale.
    monkeypatch.setitem(
        tools.REGISTRY, "fetch_url", Tool("fetch_url", "d", FETCH_SCHEMA, spy, ephemeral=True)
    )
    return spy


# -- the frame, on raise -----------------------------------------------


async def test_a_raised_card_streams_as_its_own_frame_and_persists(
    owner_client, pool, mount_peers, monkeypatch
):
    spy = _spy_fetch(monkeypatch)
    gateway = ScriptedGateway(
        rounds=(
            (fetch_call("c1", URL),),
            (text("Awaiting your approval."),),
        )
    )
    mount_peers(gateway=gateway, memory=FakeMemory())

    sent = await _say(owner_client, "check the pricing page")

    cards = consent_frames(sent)
    assert len(cards) == 1
    card = cards[0]
    assert card["action_class"] == "fetch_url"
    assert card["args"] == {"url": URL}
    assert card["status"] == "pending"
    assert spy.calls == []  # never executed on raise

    conv_id = await pool.fetchval("SELECT id FROM conversations LIMIT 1")
    pending = await consents.pending_for_conversation(pool, conv_id)
    assert len(pending) == 1
    assert pending[0]["consent_id"] == card["consent_id"]

    # The model's own stated refusal made it into the reply, not a fake
    # success — and the turn is otherwise perfectly healthy.
    assert await pool.fetchval("SELECT status FROM turns") == "ok"


# -- deny: nothing runs, and a fresh attempt re-raises -------------------


async def test_deny_runs_nothing_and_a_fresh_attempt_re_raises(
    owner_client, pool, mount_peers, monkeypatch
):
    spy = _spy_fetch(monkeypatch)
    gateway = ScriptedGateway(
        rounds=(
            (fetch_call("c1", URL),),
            (text("Awaiting your approval."),),
        )
    )
    mount_peers(gateway=gateway, memory=FakeMemory())
    sent = await _say(owner_client, "check the pricing page")
    card = consent_frames(sent)[0]

    await consents.decide(
        pool,
        consent_id=uuid.UUID(card["consent_id"]),
        approve=False,
        decided_by=await _owner_id(pool),
    )

    # A second attempt with the SAME args: denied cards never burn, so the
    # funnel raises a brand-new pending card rather than running anything.
    gateway2 = ScriptedGateway(
        rounds=(
            (fetch_call("c2", URL),),
            (text("Still awaiting."),),
        )
    )
    mount_peers(gateway=gateway2, memory=FakeMemory())
    sent2 = await _say(owner_client, "check it again")

    assert spy.calls == []  # nothing ever ran
    cards2 = consent_frames(sent2)
    assert len(cards2) == 1
    assert cards2[0]["consent_id"] != card["consent_id"]  # a fresh card, not the denied one
    assert cards2[0]["status"] == "pending"


# -- approve: the DECISION runs nothing; the RE-ATTEMPT runs and burns ---


async def test_approve_then_reattempt_runs_it_and_burns_the_consent(
    owner_client, pool, mount_peers, monkeypatch
):
    spy = _spy_fetch(monkeypatch)
    gateway = ScriptedGateway(
        rounds=(
            (fetch_call("c1", URL),),
            (text("Awaiting your approval."),),
        )
    )
    mount_peers(gateway=gateway, memory=FakeMemory())
    sent = await _say(owner_client, "check the pricing page")
    card = consent_frames(sent)[0]
    assert spy.calls == []

    await consents.decide(
        pool,
        consent_id=uuid.UUID(card["consent_id"]),
        approve=True,
        decided_by=await _owner_id(pool),
    )
    # Approving alone changed nothing at the kernel — still unspent.
    row = await consents.get(pool, uuid.UUID(card["consent_id"]))
    assert row["used_at"] is None
    assert spy.calls == []

    # The re-attempt: a normal continuation turn re-issues the SAME call.
    gateway2 = ScriptedGateway(
        rounds=(
            (fetch_call("c2", URL),),
            (text("Here's what the page said."),),
        )
    )
    mount_peers(gateway=gateway2, memory=FakeMemory())
    sent2 = await _say(owner_client, "go ahead now")

    assert spy.calls == [{"url": URL}]  # it actually ran, exactly once
    assert consent_frames(sent2) == []  # no new card — this one is spoken for
    activities = [
        (f["activity"]["tool"], f["activity"]["status"])
        for f in sent2
        if isinstance(f, dict) and "activity" in f
    ]
    assert activities == [("fetch_url", "start"), ("fetch_url", "ok")]

    row = await consents.get(pool, uuid.UUID(card["consent_id"]))
    assert row["used_at"] is not None  # burned

    # Single-use: a THIRD identical attempt awaits a fresh approval again.
    gateway3 = ScriptedGateway(
        rounds=(
            (fetch_call("c3", URL),),
            (text("Awaiting your approval, again."),),
        )
    )
    mount_peers(gateway=gateway3, memory=FakeMemory())
    sent3 = await _say(owner_client, "and once more")
    assert spy.calls == [{"url": URL}]  # still just the one run
    assert len(consent_frames(sent3)) == 1


def _activities(sent: list) -> list[tuple[str, str]]:
    return [
        (f["activity"]["tool"], f["activity"]["status"])
        for f in sent
        if isinstance(f, dict) and "activity" in f
    ]


def _corrections(sent: list) -> list[str]:
    return [f["correction"] for f in sent if isinstance(f, dict) and "correction" in f]


# -- Fix A: a card-raising call is "awaiting", never an error -------------


async def test_a_raised_card_is_awaiting_not_an_error_in_span_and_activity(
    owner_client, pool, mount_peers, monkeypatch
):
    """A REQUIRE_CONSENT tool result is NOT a failure. The tool span records
    consent_pending and leaves `error` UNSET (so Activity renders it amber, not
    red), and the live activity frame's status is 'awaiting'. And because a card
    really is pending this turn, the model's honest 'Awaiting your approval'
    reply is NOT corrected by the pending-approval guard (the toggle)."""
    _spy_fetch(monkeypatch)
    gateway = ScriptedGateway(
        rounds=(
            (fetch_call("c1", URL),),
            (text("Awaiting your approval."),),
        )
    )
    mount_peers(gateway=gateway, memory=FakeMemory())

    sent = await _say(owner_client, "check the pricing page")

    # The live activity frame for the card-raising call is 'awaiting'.
    assert _activities(sent) == [("fetch_url", "start"), ("fetch_url", "awaiting")]

    # The tool span says pending, not error.
    row = await pool.fetchrow(
        "SELECT meta FROM turn_spans WHERE kind = 'tool' AND name = 'fetch_url'"
    )
    meta = row["meta"]
    assert meta["ok"] is False
    assert meta["consent_pending"] is True
    assert "error" not in meta

    # A card really is pending this turn, so the honest awaiting reply stands.
    assert _corrections(sent) == []
    assert await pool.fetchval("SELECT status FROM turns") == "ok"


# -- Fix B: a pending-approval claim needs a real pending consent ---------


async def test_a_parroted_pending_claim_with_no_real_card_is_corrected(
    owner_client, pool, mount_peers
):
    """The walk's core defect: the model claims a fetch is awaiting approval but
    made no tool call and nothing is pending. The guard contradicts it on its
    own frame, records a guard span — and the PERSISTED reply is the correction
    ALONE (the anti-poison fix): the fabricated prose must not survive into the
    record, or the next turn's history would replay it."""
    fabrication = (
        "That fetch is awaiting your approval — I can't complete it "
        "without you OK'ing it."
    )
    gateway = ScriptedGateway(rounds=((text(fabrication),),))
    mount_peers(gateway=gateway, memory=FakeMemory())

    sent = await _say(owner_client, "what's new on bigblueview.com")

    assert _corrections(sent) == [guards.CONSENT_CLAIM_CORRECTION]
    stored = await pool.fetchval("SELECT content FROM messages WHERE role = 'assistant'")
    # REPLACE, not append: correction only, none of the fabricated prose. (The
    # correction itself says "nothing is actually awaiting your approval", so the
    # tell is the model's OWN wording — "That fetch is awaiting", "OK'ing it".)
    assert stored == guards.CONSENT_CLAIM_CORRECTION
    assert "That fetch is awaiting" not in stored
    assert "OK'ing it" not in stored
    guard = await pool.fetchrow("SELECT name, meta FROM turn_spans WHERE kind = 'guard'")
    assert guard["name"] == "consent_claim"
    assert guard["meta"]["has_pending_consent"] is False
    # No card was invented — the whole point.
    assert await consents.pending_all(pool) == []


async def test_an_awaiting_reply_is_not_corrected_when_a_card_is_pending_in_the_conversation(
    owner_client, pool, mount_peers, monkeypatch
):
    """The toggle via the DB path: a card raised in an EARLIER turn is still
    pending in this conversation, so restating the pending state this turn is
    TRUE and must not be corrected — even though this turn raised no card."""
    _spy_fetch(monkeypatch)
    gateway = ScriptedGateway(
        rounds=(
            (fetch_call("c1", URL),),
            (text("Awaiting your approval."),),
        )
    )
    mount_peers(gateway=gateway, memory=FakeMemory())
    first = await _say(owner_client, "check the pricing page")
    conv_id = first[0]["meta"]["conversation_id"]
    assert consent_frames(first)  # a card really is pending now

    # Same conversation, no new tool call — just a reply restating the state.
    gateway2 = ScriptedGateway(rounds=((text("It's still pending your approval."),),))
    mount_peers(gateway=gateway2, memory=FakeMemory())
    resp = await owner_client.post(
        "/api/v1/chat/stream",
        json={"message": "any update?", "conversation_id": conv_id},
    )
    sent2 = frames(resp.text)

    assert _corrections(sent2) == []
    assert await pool.fetchval("SELECT status FROM turns WHERE id <> $1", first[0]["meta"]["turn_id"]) == "ok"


# -- the anti-poison fix: a contradicted stance does not persist the lie ----


async def test_a_consent_flow_turn_is_not_ingested_into_memory(
    owner_client, pool, mount_peers
):
    """The context-poisoning fix, the MEMORY half — and the deeper root cause the
    owner's second walk exposed. A consent-flow turn is interaction PLUMBING, not
    knowledge: ingesting an 'awaiting approval' reply makes /recall re-inject that
    noise into LATER turns — even in other conversations, since memory is
    per-person — training the small model to narrate 'awaiting approval' (or hedge
    and defer) instead of calling the tool. So a turn the consent guard fired on
    ingests NOTHING. The transcript still keeps the correction for the operator
    (asserted in test_a_parroted_pending_claim_with_no_real_card_is_corrected);
    only durable memory must stay clean, because memory is what crosses
    conversations."""
    fabrication = "That fetch is awaiting your approval."
    gateway = ScriptedGateway(rounds=((text(fabrication),),))
    memory = FakeMemory()
    mount_peers(gateway=gateway, memory=memory)

    await _say(owner_client, "what's new on bigblueview.com")

    await chat.drain_background()
    assert memory.ingests == []  # plumbing is not knowledge — nothing to recall later


async def test_a_turn_that_raises_a_real_card_is_not_ingested(
    owner_client, pool, mount_peers, monkeypatch
):
    """Even a LEGITIMATE awaiting turn — a real card actually raised — is
    plumbing, not knowledge, and must not be ingested: recall would prime
    'awaiting approval' in later turns exactly as a fabrication would. The signal
    is mechanical (the turn's consent_sink is non-empty), not the prose."""
    _spy_fetch(monkeypatch)
    gateway = ScriptedGateway(
        rounds=((fetch_call("c1", URL),), (text("I've raised an approval card for that."),))
    )
    memory = FakeMemory()
    mount_peers(gateway=gateway, memory=memory)

    sent = await _say(owner_client, "check the pricing page")

    assert consent_frames(sent)  # a real card was raised this turn
    await chat.drain_background()
    assert memory.ingests == []


async def test_an_ordinary_turn_is_still_ingested(owner_client, pool, mount_peers):
    """The skip is SCOPED to consent-flow turns: an ordinary reply — no card
    raised, no guard correction — is ingested exactly as before, so the memory
    hygiene fix does not silently stop Nova from remembering real exchanges."""
    gateway = ScriptedGateway(
        rounds=((text("KV offloading moves the attention cache to CPU RAM to free VRAM."),),)
    )
    memory = FakeMemory()
    mount_peers(gateway=gateway, memory=memory)

    await _say(owner_client, "what is kv offloading?")

    await chat.drain_background()
    assert len(memory.ingests) == 1


def test_the_real_fetch_url_tool_is_ephemeral():
    """Pin the flag the ingest skip derives from: a web fetch is a live read.
    If a refactor drops it, the stale-page regurgitation bug returns silently."""
    assert any(t.name == "fetch_url" and t.ephemeral for t in web.TOOLS)


async def test_a_successful_web_fetch_turn_is_not_ingested_because_it_is_ephemeral(
    owner_client, pool, mount_peers, monkeypatch
):
    """A web fetch is a live, point-in-time read whose result goes stale. The
    turn that actually RUNS fetch_url (the approved re-attempt — ok=True, no new
    card, so neither the consent nor capability plumbing skips apply) must still
    NOT be ingested, because fetch_url is ephemeral. Otherwise recall serves the
    cached page as 'the latest' and the model regurgitates it instead of
    fetching again — the owner's walk: byte-identical content, same stale
    timestamp, no fresh card. The skip is DERIVED from the tool's ephemeral flag,
    not its name."""
    spy = _spy_fetch(monkeypatch)  # ephemeral fetch_url; returns "Fetched it."
    gateway = ScriptedGateway(
        rounds=((fetch_call("c1", URL),), (text("Awaiting your approval."),))
    )
    memory = FakeMemory()
    mount_peers(gateway=gateway, memory=memory)
    sent = await _say(owner_client, "what's the latest?")
    card = consent_frames(sent)[0]

    await consents.decide(
        pool, consent_id=uuid.UUID(card["consent_id"]), approve=True, decided_by=await _owner_id(pool)
    )

    # The approved re-attempt runs the fetch (ok=True) with no new card.
    gateway2 = ScriptedGateway(
        rounds=((fetch_call("c2", URL),), (text("Here are the latest updates."),))
    )
    mount_peers(gateway=gateway2, memory=memory)
    sent2 = await _say(owner_client, "go ahead now")

    assert spy.calls == [{"url": URL}]  # it actually fetched
    assert consent_frames(sent2) == []  # no new card — ran under the approval
    await chat.drain_background()
    # Neither turn ingested: the first raised a card (plumbing), the second ran
    # an ephemeral fetch. So a later "what's the latest?" re-fetches, never
    # recalls a stale snapshot.
    assert memory.ingests == []


async def test_a_fired_narration_guard_keeps_appending_to_preserve_real_content(
    owner_client, pool, mount_peers
):
    """The documented scope decision: REPLACE (persist correction-only) is
    scoped to consent_claim_check — where the whole reply is predicated on a
    non-existent pending state. narration keeps APPEND, because a fabricated
    completed-action claim routinely sits BESIDE real content the operator asked
    for (here a real summary), and there is no clean mechanical way to separate
    'the whole reply is the lie' from 'one false claim beside real content'.
    Correction-only would throw the substance away, a worse failure than the
    claim persisting; so the substance survives and the claim is contradicted."""
    reply = (
        "KV offloading moves the attention cache to CPU RAM to free VRAM. "
        "I've saved this to kv_offloading.md."
    )
    gateway = ScriptedGateway(rounds=((text(reply),),))
    mount_peers(gateway=gateway, memory=FakeMemory())

    sent = await _say(owner_client, "summarize kv offloading and save it")

    assert _corrections(sent) == [guards.CORRECTION_TEXT]
    stored = await pool.fetchval("SELECT content FROM messages WHERE role = 'assistant'")
    # Append, not replace: the real summary is preserved, the correction added.
    assert stored.startswith("KV offloading moves the attention cache")
    assert stored.endswith(guards.CORRECTION_TEXT)
    guards_seen = await pool.fetch("SELECT name FROM turn_spans WHERE kind = 'guard'")
    assert [g["name"] for g in guards_seen] == ["narration"]


async def test_both_guards_firing_compose_coherently_without_the_lie(
    owner_client, pool, mount_peers
):
    """A doubly-fabricated reply: a completed-action claim with no span AND a
    pending-approval claim with no card. Both guards fire. The persisted record
    must be coherent — the two corrections adjacent, each once, with NEITHER
    fabrication between them (never two correction blocks stacked around the
    lie). Because the consent guard fired, the whole record is corrections-only:
    the fabricated prose does not survive to poison the next turn."""
    reply = "I've created report.md. That fetch is awaiting your approval."
    gateway = ScriptedGateway(rounds=((text(reply),),))
    memory = FakeMemory()
    mount_peers(gateway=gateway, memory=memory)

    sent = await _say(owner_client, "make a report and check the page")

    # Both corrections streamed, in order (narration, then consent), each once.
    assert _corrections(sent) == [
        guards.CORRECTION_TEXT,
        guards.CONSENT_CLAIM_CORRECTION,
    ]
    stored = await pool.fetchval("SELECT content FROM messages WHERE role = 'assistant'")
    assert stored == f"{guards.CORRECTION_TEXT}\n\n{guards.CONSENT_CLAIM_CORRECTION}"
    # Neither fabrication survives into the record (the consent correction does
    # legitimately contain "awaiting", so the tell is the model's own wording).
    assert "report.md" not in stored
    assert "That fetch is awaiting" not in stored

    # Both guard firings are on record. The transcript keeps the coherent
    # correction (asserted above, for the operator); but this is a consent-flow
    # turn, so durable MEMORY ingests nothing — neither fabrication nor
    # correction crosses into later turns' recall.
    guards_seen = await pool.fetch("SELECT name FROM turn_spans WHERE kind = 'guard'")
    assert sorted(g["name"] for g in guards_seen) == ["consent_claim", "narration"]
    await chat.drain_background()
    assert memory.ingests == []


# -- T7: a false CAPABILITY denial is contradicted ------------------------
#
# The owner's live walk: the model disowned a tool (fetch_url) it holds. These
# prove the wiring — the capability guard runs on the raw reply with the live
# registry, streams a {correction} frame, records a "capability_claim" guard
# span, REPLACES the disavowal in the durable record, and skips ingest.

CAP_DENIAL = (
    "I cannot access external websites or real-time data, including bigblueview.com."
)


async def test_a_false_capability_denial_is_corrected_and_replaces_the_lie(
    owner_client, pool, mount_peers
):
    """The T7 defect (no-card branch): the model denies a capability it holds
    (fetch_url is registered) without even calling the tool. The guard
    contradicts it on its own frame, records a 'capability_claim' guard span
    naming the real tool, and the PERSISTED reply is the correction ALONE — the
    self-limiting denial must not survive into history to train the model to keep
    disowning the tool."""
    gateway = ScriptedGateway(rounds=((text(CAP_DENIAL),),))
    memory = FakeMemory()
    mount_peers(gateway=gateway, memory=memory)

    sent = await _say(owner_client, "what's the latest from bigblueview.com?")

    corrections = _corrections(sent)
    assert len(corrections) == 1
    assert corrections[0].startswith("Correction: I can do that")
    assert "fetch_url" in corrections[0]

    stored = await pool.fetchval("SELECT content FROM messages WHERE role = 'assistant'")
    assert stored == corrections[0]  # REPLACE: none of the false denial survives
    assert "I cannot access external websites" not in stored

    guard = await pool.fetchrow("SELECT name, meta FROM turn_spans WHERE kind = 'guard'")
    assert guard["name"] == "capability_claim"
    assert guard["meta"]["capabilities"][0]["tool"] == "fetch_url"

    await chat.drain_background()
    assert memory.ingests == []  # a guard-corrected turn is plumbing, not knowledge
    assert await pool.fetchval("SELECT status FROM turns") == "ok"


async def test_the_owner_scenario_card_raised_then_capability_denied(
    owner_client, pool, mount_peers, monkeypatch
):
    """The exact live-walk trace: the model CALLS fetch_url (the funnel raises a
    real card and returns 'Awaiting your approval'), then answers with a false
    capability denial. The consent guard stays silent (a card really IS pending),
    the capability guard fires (fetch_url is registered), and the durable record
    is the honest correction — never the disavowal."""
    spy = _spy_fetch(monkeypatch)
    gateway = ScriptedGateway(
        rounds=(
            (fetch_call("c1", URL),),
            (text("I cannot access external websites, so I can't get that."),),
        )
    )
    memory = FakeMemory()
    mount_peers(gateway=gateway, memory=memory)

    sent = await _say(owner_client, "what's the latest from bigblueview.com?")

    assert consent_frames(sent)  # a real card was raised
    assert spy.calls == []  # never executed on raise
    corrections = _corrections(sent)
    assert len(corrections) == 1
    assert "fetch_url" in corrections[0]  # the capability guard fired

    stored = await pool.fetchval("SELECT content FROM messages WHERE role = 'assistant'")
    assert "I cannot access external websites" not in stored
    assert stored == corrections[0]

    guard_names = [
        g["name"] for g in await pool.fetch("SELECT name FROM turn_spans WHERE kind = 'guard'")
    ]
    assert guard_names == ["capability_claim"]  # consent guard silent — card is pending

    await chat.drain_background()
    assert memory.ingests == []


async def test_an_honest_specific_result_reply_is_not_capability_corrected_and_still_ingests(
    owner_client, pool, mount_peers
):
    """Precision at the seam: a reply about ONE specific failed attempt ('I
    couldn't fetch that page — it returned a 404') is an honest result, not a
    denial of the ability, so the capability guard stays silent — and because no
    guard fired, the turn is ordinary knowledge and is still ingested (it is not
    wrongly marked plumbing)."""
    reply = "I couldn't fetch that page — it returned a 404, so there's nothing to show."
    gateway = ScriptedGateway(rounds=((text(reply),),))
    memory = FakeMemory()
    mount_peers(gateway=gateway, memory=memory)

    sent = await _say(owner_client, "what's the latest from bigblueview.com?")

    assert _corrections(sent) == []  # honest specific result, left alone
    guard_names = [
        g["name"] for g in await pool.fetch("SELECT name FROM turn_spans WHERE kind = 'guard'")
    ]
    assert guard_names == []
    stored = await pool.fetchval("SELECT content FROM messages WHERE role = 'assistant'")
    assert stored == reply  # untouched — no guard fired
    await chat.drain_background()
    assert len(memory.ingests) == 1  # ordinary turn, not plumbing
