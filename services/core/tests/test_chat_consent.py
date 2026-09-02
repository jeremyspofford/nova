"""The {"consent": ...} SSE frame, and the full deny/approve loop through a
real chat turn.

T1 built the kernel and the funnel gate (policy.authorize, consents.py); this
proves the seam T2 owns: a card the funnel raises this turn rides the stream
as its own frame (chat.py's consent_sink wiring), a denied card lets nothing
run, and an APPROVED card is not executed by the decision itself — only a
re-attempt through the funnel, in a later turn, actually runs the action and
burns the consent (ruling S3-R4). No fake success anywhere: the spy executor
proves exactly when the real tool body did or did not run.

The consent-MECHANISM tests drive a PRIVATE consent-tier class (CONSENT_ACTION,
armed by _arm_consent_tool), NOT fetch_url: migration 008 made fetch_url 'auto'
by owner directive (web reads need no approval), so it no longer raises a card.
Decoupling the mechanism from fetch_url's real disposition keeps the
card->deny->approve->burn loop fully proven while the auto-fetch tests below
prove the new no-card path (a fetch_url turn runs directly and, being ephemeral,
is still not ingested — round 5). This mirrors test_policy_e2e.py's e2e_walk_fetch.
"""
from __future__ import annotations

import json
import uuid
from dataclasses import dataclass, field

import pytest

from app import chat, consents, guards, tools
from app.main import app
from app.tools import web, web_search
from app.tools.base import Tool, ToolContext
from tests import fakes
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


def search_call(call_id: str, query: str) -> dict:
    return call_delta(
        0, call_id=call_id, name="web_search", arguments=json.dumps({"query": query})
    )


# The private consent-tier class the mechanism tests raise a card with (fetch_url
# is auto now — see the module docstring).
CONSENT_ACTION = "consent_probe"


def probe_call(call_id: str, url: str) -> dict:
    return call_delta(
        0, call_id=call_id, name=CONSENT_ACTION, arguments=json.dumps({"url": url})
    )


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


async def _arm_consent_tool(pool, monkeypatch) -> Spy:
    """Register a PRIVATE consent-tier tool + its action_classes row, so the
    card->deny->approve->burn mechanism stays proven even though no SEEDED tool
    is consent-tier anymore (migration 008). Mirrors test_policy_e2e.py's
    e2e_walk_fetch. action_classes is not per-test truncated, so ON CONFLICT
    re-asserts 'consent' with a zeroed streak each run — a prior test's burn
    cannot leak an earned/auto disposition into this one."""
    spy = Spy()
    monkeypatch.setitem(
        tools.REGISTRY, CONSENT_ACTION, Tool(CONSENT_ACTION, "d", FETCH_SCHEMA, spy)
    )
    await pool.execute(
        "INSERT INTO action_classes (action_class, risk_tier, disposition, earned, "
        "consecutive_successes) VALUES ($1, 'outward', 'consent', false, 0) "
        "ON CONFLICT (action_class) DO UPDATE SET disposition = 'consent', "
        "earned = false, consecutive_successes = 0, updated_at = now()",
        CONSENT_ACTION,
    )
    return spy


# -- the frame, on raise -----------------------------------------------


async def test_a_raised_card_streams_as_its_own_frame_and_persists(
    owner_client, pool, mount_peers, monkeypatch
):
    spy = await _arm_consent_tool(pool, monkeypatch)
    gateway = ScriptedGateway(
        rounds=(
            (probe_call("c1", URL),),
            (text("Awaiting your approval."),),
        )
    )
    mount_peers(gateway=gateway, memory=FakeMemory())

    sent = await _say(owner_client, "check the pricing page")

    cards = consent_frames(sent)
    assert len(cards) == 1
    card = cards[0]
    assert card["action_class"] == CONSENT_ACTION
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
    spy = await _arm_consent_tool(pool, monkeypatch)
    gateway = ScriptedGateway(
        rounds=(
            (probe_call("c1", URL),),
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
            (probe_call("c2", URL),),
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
    spy = await _arm_consent_tool(pool, monkeypatch)
    gateway = ScriptedGateway(
        rounds=(
            (probe_call("c1", URL),),
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
            (probe_call("c2", URL),),
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
    assert activities == [(CONSENT_ACTION, "start"), (CONSENT_ACTION, "ok")]

    row = await consents.get(pool, uuid.UUID(card["consent_id"]))
    assert row["used_at"] is not None  # burned

    # Single-use: a THIRD identical attempt awaits a fresh approval again.
    gateway3 = ScriptedGateway(
        rounds=(
            (probe_call("c3", URL),),
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
    await _arm_consent_tool(pool, monkeypatch)
    gateway = ScriptedGateway(
        rounds=(
            (probe_call("c1", URL),),
            (text("Awaiting your approval."),),
        )
    )
    mount_peers(gateway=gateway, memory=FakeMemory())

    sent = await _say(owner_client, "check the pricing page")

    # The live activity frame for the card-raising call is 'awaiting'.
    assert _activities(sent) == [(CONSENT_ACTION, "start"), (CONSENT_ACTION, "awaiting")]

    # The tool span says pending, not error.
    row = await pool.fetchrow(
        "SELECT meta FROM turn_spans WHERE kind = 'tool' AND name = $1", CONSENT_ACTION
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
    record, or the next turn's history would replay it.

    Post-redirect-wave this is also the FAIL-OPEN path, ASSERTED rather than
    relied on: the one-round script leaves the redirect no round to regenerate
    from (the script answers 500), so the redirect is attempted — two gateway
    calls — and its failure degrades to exactly this pre-wave behaviour, with
    the stated reason on the span. Without those assertions the test would pass
    identically if the redirect had silently stopped running at all."""
    fabrication = (
        "That fetch is awaiting your approval — I can't complete it "
        "without you OK'ing it."
    )
    gateway = ScriptedGateway(rounds=((text(fabrication),),))
    mount_peers(gateway=gateway, memory=FakeMemory())

    sent = await _say(owner_client, "what's new on bigblueview.com")

    # The reply, then the ONE redirect the guard is entitled to (refused by the
    # exhausted script) — never a third call, and never zero.
    assert gateway.calls == 2
    assert _corrections(sent) == [guards.CONSENT_CLAIM_CORRECTION]
    stored = await pool.fetchval("SELECT content FROM messages WHERE role = 'assistant'")
    # REPLACE, not append: correction only, none of the fabricated prose. (The
    # correction itself says "nothing is awaiting your approval", so the
    # tell is the model's OWN wording — "That fetch is awaiting", "OK'ing it".)
    assert stored == guards.CONSENT_CLAIM_CORRECTION
    assert "That fetch is awaiting" not in stored
    assert "OK'ing it" not in stored
    guard = await pool.fetchrow("SELECT name, meta FROM turn_spans WHERE kind = 'guard'")
    assert guard["name"] == "consent_claim"
    assert guard["meta"]["has_pending_consent"] is False
    # The redirect really was attempted and really did fail open: the span says
    # so out loud, rather than the test inferring it from the correction alone.
    assert guard["meta"]["ran_a_tool"] is False
    assert guard["meta"]["redirected"] is False
    assert guard["meta"]["error"]
    # No card was invented — the whole point.
    assert await consents.pending_all(pool) == []


async def test_an_awaiting_reply_is_not_corrected_when_a_card_is_pending_in_the_conversation(
    owner_client, pool, mount_peers, monkeypatch
):
    """The toggle via the DB path: a card raised in an EARLIER turn is still
    pending in this conversation, so restating the pending state this turn is
    TRUE and must not be corrected — even though this turn raised no card."""
    await _arm_consent_tool(pool, monkeypatch)
    gateway = ScriptedGateway(
        rounds=(
            (probe_call("c1", URL),),
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
    turn_id = first[0]["meta"]["turn_id"]
    status = await pool.fetchval("SELECT status FROM turns WHERE id <> $1", turn_id)
    assert status == "ok"


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
    await _arm_consent_tool(pool, monkeypatch)
    gateway = ScriptedGateway(
        rounds=((probe_call("c1", URL),), (text("I've raised an approval card for that."),))
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


async def test_a_no_card_auto_fetch_runs_directly_and_is_not_ingested(
    owner_client, pool, mount_peers, monkeypatch
):
    """The owner-directed auto path, end to end (migration 008 + round 5).

    fetch_url is 'auto' now, so a "what's the latest?" turn calls it and it runs
    DIRECTLY: no approval card raised (consent_frames empty), ok=True (the live
    tile goes start->ok), content returned — the whole no-card auto fetch path.
    AND because fetch_url is EPHEMERAL, that successful fetch turn is STILL not
    ingested: recall must never serve a cached page as 'the latest' (the owner's
    walk — byte-identical content, same stale timestamp), so the next such turn
    re-fetches instead of regurgitating a snapshot. The ingest skip is DERIVED
    from the tool's ephemeral flag, not its name or its (now auto) disposition."""
    spy = _spy_fetch(monkeypatch)  # ephemeral fetch_url; returns "Fetched it."
    gateway = ScriptedGateway(
        rounds=((fetch_call("c1", URL),), (text("Here are the latest updates."),))
    )
    memory = FakeMemory()
    mount_peers(gateway=gateway, memory=memory)

    sent = await _say(owner_client, "what's the latest?")

    assert consent_frames(sent) == []  # auto: no approval card was ever raised
    assert spy.calls == [{"url": URL}]  # it ran directly, exactly once
    # The live tile resolves cleanly (start -> ok), not 'awaiting' and not error.
    assert _activities(sent) == [("fetch_url", "start"), ("fetch_url", "ok")]
    assert await pool.fetchval("SELECT status FROM turns") == "ok"

    await chat.drain_background()
    # Ephemeral read: not ingested, so a later "what's the latest?" re-fetches
    # rather than recalling this snapshot.
    assert memory.ingests == []


def test_the_real_web_search_tool_is_ephemeral():
    """The ingest skip below derives from this flag, not the tool's name. If a
    refactor drops it, a stale search result gets served as 'the latest'."""
    assert any(t.name == "web_search" and t.ephemeral for t in web_search.TOOLS)


async def test_a_web_search_turn_runs_directly_and_is_not_ingested(
    owner_client, pool, mount_peers, monkeypatch
):
    """web_search end to end (migration 009): the model asks for it, the auto
    disposition lets it run DIRECTLY (no card — consent_frames empty), the real
    executor reaches a mocked SearXNG and the live tile resolves start->ok. AND
    because web_search is EPHEMERAL, that successful turn is STILL not ingested —
    a later 'what's the latest?' re-searches rather than recalling this snapshot
    and narrating it as current. Mirrors the auto-fetch test above."""
    monkeypatch.setenv("SEARXNG_URL", fakes.SEARXNG_URL)
    searx = fakes.FakeSearx(
        results=(
            {"title": "OpenAI news", "url": "https://example.com/a", "content": "latest"},
        )
    )
    gateway = ScriptedGateway(
        rounds=((search_call("c1", "latest on openai"),), (text("Here's the latest."),))
    )
    memory = FakeMemory()
    mount_peers(gateway=gateway, memory=memory)
    # mount_peers set app.state.peer_transports fresh; add the searxng origin the
    # real web_search executor will reach for. Its teardown resets the whole map.
    app.state.peer_transports[fakes.SEARXNG_URL] = fakes.StreamingASGITransport(searx.app)

    sent = await _say(owner_client, "what's the latest on openai?")

    assert consent_frames(sent) == []  # auto: no approval card was ever raised
    assert searx.queries == ["latest on openai"]  # the real tool ran, once
    assert _activities(sent) == [("web_search", "start"), ("web_search", "ok")]
    assert await pool.fetchval("SELECT status FROM turns") == "ok"

    await chat.drain_background()
    assert memory.ingests == []  # ephemeral read: not ingested


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

    # The reply, then the ONE refused redirect: this composition is the
    # FAIL-OPEN outcome, and saying so here stops the test passing by the
    # redirect having quietly stopped running.
    assert gateway.calls == 2
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
    guards_seen = await pool.fetch(
        "SELECT name, meta FROM turn_spans WHERE kind = 'guard'"
    )
    assert sorted(g["name"] for g in guards_seen) == ["consent_claim", "narration"]
    consent_span = next(g for g in guards_seen if g["name"] == "consent_claim")
    assert consent_span["meta"]["redirected"] is False
    assert consent_span["meta"]["error"]  # tried, failed open — not skipped
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
    """The exact live-walk trace: the model CALLS a consent-tier tool (the funnel
    raises a real card and returns 'Awaiting your approval'), then answers with a
    false capability denial. The consent guard stays silent (a card really IS
    pending), the capability guard fires (fetch_url is registered), and the
    durable record is the honest correction — never the disavowal. The card here
    comes from the private consent class (fetch_url is auto now), while the false
    denial is still about fetch_url — the guard names it because it is registered,
    independent of which tool raised the card."""
    spy = await _arm_consent_tool(pool, monkeypatch)
    gateway = ScriptedGateway(
        rounds=(
            (probe_call("c1", URL),),
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


# -- a raised card ends the tool loop ---------------------------------------
#
# The owner's walk (2026-09-01): after a card was raised mid-turn the local
# model kept calling OTHER tools round after round until the 6-round cap
# ("[stopped after 6 tool rounds without finishing]"); his approve landed while
# the turn was still streaming, so the web's auto-continue never fired and he
# had to click "Go ahead" by hand. Mechanically: once a round raises a card the
# tool loop is CLOSED for the rest of the turn — the model gets exactly ONE
# more gateway round, made WITHOUT tools advertised, to say so in text, and the
# turn ends. A tool call it emits anyway in that round is never dispatched: it
# gets the stated pending-approval result and the turn still ends.


def _tools_advertised(payload: dict) -> bool:
    return bool(payload.get("tools"))


async def _governance_raised(pool) -> int:
    from app import governance

    return sum(
        1
        for e in await governance.recent_events(pool, limit=200)
        if e["kind"] == governance.CONSENT_RAISED
    )


async def test_a_raised_card_closes_the_tool_loop_for_the_rest_of_the_turn(
    owner_client, pool, mount_peers, monkeypatch
):
    probe = await _arm_consent_tool(pool, monkeypatch)
    fetch = _spy_fetch(monkeypatch)
    # Round 1 raises the card. Round 2 (the narration round) narrates AND
    # tries a second, auto tool — which must never run. A third round would
    # be a loud 500 from the script, so `calls == 2` is also "no wandering".
    gateway = ScriptedGateway(
        rounds=(
            (probe_call("c1", URL),),
            (text("Awaiting your approval."), fetch_call("c2", "https://example.com/other")),
        )
    )
    mount_peers(gateway=gateway, memory=FakeMemory())

    sent = await _say(owner_client, "check the pricing page and the other one")

    assert probe.calls == []  # the gated call never ran
    assert fetch.calls == []  # the second tool was NEVER dispatched
    assert gateway.calls == 2  # exactly one more round after the card, then done
    assert _tools_advertised(gateway.payloads[0])  # the card round had tools
    assert not _tools_advertised(gateway.payloads[1])  # the narration round had none
    # The card was raised exactly once — on the wire, in the table, in the ledger.
    assert len(consent_frames(sent)) == 1
    assert len(await consents.pending_all(pool)) == 1
    assert await _governance_raised(pool) == 1
    # The refused second call is visible: an error activity and a tool span
    # carrying the stated reason — never a silent drop.
    assert _activities(sent) == [
        (CONSENT_ACTION, "start"),
        (CONSENT_ACTION, "awaiting"),
        ("fetch_url", "start"),
        ("fetch_url", "error"),
    ]
    span = await pool.fetchrow(
        "SELECT meta FROM turn_spans WHERE kind = 'tool' AND name = 'fetch_url'"
    )
    assert span["meta"]["ok"] is False
    assert "an approval is pending" in span["meta"]["error"]
    # The turn ended promptly and healthy: no cap note, status ok, the
    # model's own narration is what persisted.
    assert await pool.fetchval("SELECT status FROM turns") == "ok"
    stored = await pool.fetchval("SELECT content FROM messages WHERE role = 'assistant'")
    assert "[stopped after" not in stored
    assert stored == "Awaiting your approval."
    assert _corrections(sent) == []


async def test_a_narration_round_that_only_calls_tools_still_ends_the_turn_ok(
    owner_client, pool, mount_peers, monkeypatch
):
    """The small-model case: told to narrate, it emits nothing but another
    tool call. The call is refused, and the turn still ends OK with a stated
    note rather than as an empty-reply error — the card is pending and the
    owner's approve must land on a FINISHED turn."""
    await _arm_consent_tool(pool, monkeypatch)
    fetch = _spy_fetch(monkeypatch)
    gateway = ScriptedGateway(
        rounds=(
            (probe_call("c1", URL),),
            (fetch_call("c2", "https://example.com/other"),),
        )
    )
    mount_peers(gateway=gateway, memory=FakeMemory())

    sent = await _say(owner_client, "check the pricing page")

    assert fetch.calls == []
    assert gateway.calls == 2
    assert len(consent_frames(sent)) == 1
    assert await pool.fetchval("SELECT status FROM turns") == "ok"
    stored = await pool.fetchval("SELECT content FROM messages WHERE role = 'assistant'")
    assert "[stopped after" not in stored
    assert stored == chat.PENDING_APPROVAL_NOTE
    assert _corrections(sent) == []  # a card IS pending, so the note is true


async def test_a_turn_with_no_card_still_gets_its_full_rounds(
    owner_client, pool, mount_peers, monkeypatch
):
    """No regression: without a card the loop runs every round it needs, each
    with tools advertised."""
    fetch = _spy_fetch(monkeypatch)
    gateway = ScriptedGateway(
        rounds=(
            (fetch_call("c1", URL),),
            (fetch_call("c2", "https://example.com/other"),),
            (text("Both pages read."),),
        )
    )
    mount_peers(gateway=gateway, memory=FakeMemory())

    sent = await _say(owner_client, "read both pages")

    assert fetch.calls == [{"url": URL}, {"url": "https://example.com/other"}]
    assert gateway.calls == 3
    assert all(_tools_advertised(p) for p in gateway.payloads)
    assert consent_frames(sent) == []
    assert await pool.fetchval("SELECT status FROM turns") == "ok"
    assert await pool.fetchval("SELECT content FROM messages WHERE role = 'assistant'") == (
        "Both pages read."
    )


# -- the consent guard's ONE redirect ---------------------------------------
#
# The owner's walk, 2026-09-02 22:22: he said "try again" (re-run a device
# command); the local model answered with a whole-stance "still awaiting your
# approval" and no tool call; the guard fired correctly (nothing was pending)
# — and NOTHING WAS RETRIED. The lie was contradicted and the work still did
# not happen. So a fired consent guard now spends the turn's single redirect
# budget on ONE regeneration WITH TOOLS: it either does the thing or says
# plainly that it cannot, and only when that fails does the correction persist.

AUTO_ACTION = "auto_probe"
FABRICATION = "That's still awaiting your approval — I can't run it until you OK it."


def auto_call(call_id: str, url: str) -> dict:
    return call_delta(
        0, call_id=call_id, name=AUTO_ACTION, arguments=json.dumps({"url": url})
    )


async def _arm_auto_tool(pool, monkeypatch) -> Spy:
    """A private AUTO-disposition tool: the redirect's call must actually RUN,
    raising no card (the owner can set any class to auto — the very reason the
    correction no longer promises one). Non-ephemeral, so a redirected turn is
    ordinary knowledge and the ingest assertion means something."""
    spy = Spy(result="Ran it: the desk light is on.")
    monkeypatch.setitem(
        tools.REGISTRY, AUTO_ACTION, Tool(AUTO_ACTION, "d", FETCH_SCHEMA, spy)
    )
    await pool.execute(
        "INSERT INTO action_classes (action_class, risk_tier, disposition, earned, "
        "consecutive_successes) VALUES ($1, 'outward', 'auto', false, 0) "
        "ON CONFLICT (action_class) DO UPDATE SET disposition = 'auto', "
        "earned = false, consecutive_successes = 0, updated_at = now()",
        AUTO_ACTION,
    )
    return spy


async def _guard_spans(pool) -> list:
    return await pool.fetch(
        "SELECT name, meta FROM turn_spans WHERE kind = 'guard' ORDER BY started_at"
    )


async def test_a_fabricated_pending_claim_is_redirected_and_the_tool_actually_runs(
    owner_client, pool, mount_peers, monkeypatch
):
    """The headline fix. Round 1 fabricates a pending approval and calls nothing.
    The guard fires (nothing pending) and, instead of only contradicting it, the
    turn regenerates ONCE with tools advertised: the redirect calls the tool, it
    is dispatched through the SAME machinery as any other round (the spy proves
    the real body ran), and the reply that reports the result REPLACES the
    durable text. No correction persists — the work happened."""
    spy = await _arm_auto_tool(pool, monkeypatch)
    done = "Done — the desk light is on."
    gateway = ScriptedGateway(
        rounds=(
            (text(FABRICATION),),
            (auto_call("r1", URL),),
            (text(done),),
        )
    )
    memory = FakeMemory()
    mount_peers(gateway=gateway, memory=memory)

    sent = await _say(owner_client, "try again")

    # The fabrication, ONE redirect round (with tools), then the closing round.
    assert gateway.calls == 3
    assert spy.calls == [{"url": URL}]  # the tool really ran
    assert _activities(sent) == [(AUTO_ACTION, "start"), (AUTO_ACTION, "ok")]

    # The regenerated reply is the durable record — not the lie, not a correction.
    stored = await pool.fetchval("SELECT content FROM messages WHERE role = 'assistant'")
    assert stored == done
    assert guards.CONSENT_CLAIM_CORRECTION not in stored
    assert "awaiting your approval" not in stored

    # Exactly one consent_claim span, recording that the redirect was taken.
    spans = await _guard_spans(pool)
    assert [s["name"] for s in spans] == ["consent_claim"]
    assert spans[0]["meta"]["has_pending_consent"] is False
    assert spans[0]["meta"]["redirected"] is True

    # Live: the note, then the regenerated reply — never the correction.
    assert _corrections(sent) == [chat.CONSENT_REDIRECT_NOTE]
    assert [f["t"] for f in sent if isinstance(f, dict) and "t" in f] == [FABRICATION, done]

    # No card was invented anywhere, and a turn that DID the work is knowledge
    # again — not the "awaiting approval" plumbing an uncorrected turn would be.
    assert await consents.pending_all(pool) == []
    assert await pool.fetchval("SELECT status FROM turns") == "ok"
    await chat.drain_background()
    assert len(memory.ingests) == 1


async def test_a_redirect_that_still_fabricates_persists_the_correction_and_stops(
    owner_client, pool, mount_peers
):
    """Bounded to ONE. If the regeneration repeats the same lie, the correction
    persists exactly as before and there is no second redirect — two gateway
    calls, never three (a third would be a loud 500 from the script)."""
    gateway = ScriptedGateway(
        rounds=(
            (text(FABRICATION),),
            (text("It is still pending your approval, sorry."),),
        )
    )
    memory = FakeMemory()
    mount_peers(gateway=gateway, memory=memory)

    sent = await _say(owner_client, "try again")

    assert gateway.calls == 2  # the reply, one redirect, and stop
    stored = await pool.fetchval("SELECT content FROM messages WHERE role = 'assistant'")
    assert stored == guards.CONSENT_CLAIM_CORRECTION
    assert "still pending your approval" not in stored
    assert _corrections(sent) == [guards.CONSENT_CLAIM_CORRECTION]

    spans = await _guard_spans(pool)
    assert [s["name"] for s in spans] == ["consent_claim"]  # exactly one, still
    assert spans[0]["meta"]["redirected"] is False
    assert await pool.fetchval("SELECT status FROM turns") == "ok"
    await chat.drain_background()
    assert memory.ingests == []  # an uncorrected consent turn stays plumbing


async def test_a_gateway_failure_in_the_redirect_ships_the_correction(
    owner_client, pool, mount_peers
):
    """FAIL-OPEN: the redirect's gateway round dies (the script has no round 2,
    so it answers 500). The turn ships the correction exactly as it did before
    the redirect existed — never an error frame, never a lost turn."""
    gateway = ScriptedGateway(rounds=((text(FABRICATION),),))
    mount_peers(gateway=gateway, memory=FakeMemory())

    sent = await _say(owner_client, "try again")

    assert gateway.calls == 2  # the reply, then the redirect that failed
    assert _corrections(sent) == [guards.CONSENT_CLAIM_CORRECTION]
    assert not [f for f in sent if isinstance(f, dict) and "error" in f]
    stored = await pool.fetchval("SELECT content FROM messages WHERE role = 'assistant'")
    assert stored == guards.CONSENT_CLAIM_CORRECTION
    spans = await _guard_spans(pool)
    assert [s["name"] for s in spans] == ["consent_claim"]
    assert spans[0]["meta"]["redirected"] is False
    assert spans[0]["meta"]["error"]  # the stated reason, on record
    assert await pool.fetchval("SELECT status FROM turns") == "ok"


async def test_no_redirect_when_a_card_really_is_pending(
    owner_client, pool, mount_peers, monkeypatch
):
    """The toggle still governs everything: with a card actually pending in the
    conversation, the same 'awaiting your approval' sentence is TRUE, so the
    guard does not fire, no redirect runs (no extra gateway call — a third would
    be a loud 500), no span is filed, and the reply stands untouched."""
    await _arm_consent_tool(pool, monkeypatch)
    gateway = ScriptedGateway(
        rounds=((probe_call("c1", URL),), (text("Awaiting your approval."),))
    )
    mount_peers(gateway=gateway, memory=FakeMemory())
    first = await _say(owner_client, "check the pricing page")
    conv_id = first[0]["meta"]["conversation_id"]
    assert consent_frames(first)

    gateway2 = ScriptedGateway(rounds=((text("That's still awaiting your approval."),),))
    mount_peers(gateway=gateway2, memory=FakeMemory())
    resp = await owner_client.post(
        "/api/v1/chat/stream",
        json={"message": "any update?", "conversation_id": conv_id},
    )
    sent2 = frames(resp.text)

    assert gateway2.calls == 1  # no redirect: the guard never fired
    assert _corrections(sent2) == []
    assert [s["name"] for s in await _guard_spans(pool)] == []
    stored = await pool.fetch(
        "SELECT content FROM messages WHERE role = 'assistant' ORDER BY created_at, id"
    )
    assert stored[-1]["content"] == "That's still awaiting your approval."


async def test_the_consent_redirect_spends_the_shared_budget_so_deferral_cannot(
    owner_client, pool, mount_peers
):
    """ONE redirect per turn, first claim wins. A reply that BOTH fabricates a
    pending approval AND defers a promised search would qualify for two — the
    consent guard takes the budget, so the deferral redirect never runs: two
    gateway calls total and no deferral span anywhere."""
    both = "That's awaiting your approval. I'll search the web for it once you OK it."
    checked = "I checked directly: the desk light is already on."
    gateway = ScriptedGateway(rounds=((text(both),), (text(checked),)))
    mount_peers(gateway=gateway, memory=FakeMemory())

    sent = await _say(owner_client, "try again")

    assert gateway.calls == 2  # ONE redirect, not two
    names = [s["name"] for s in await _guard_spans(pool)]
    assert names == ["consent_claim"]  # deferral never redirected
    stored = await pool.fetchval("SELECT content FROM messages WHERE role = 'assistant'")
    assert stored == checked
    assert _corrections(sent) == [chat.CONSENT_REDIRECT_NOTE]
    assert await pool.fetchval("SELECT status FROM turns") == "ok"


# -- approval choreography is PLUMBING, not conversation ---------------------
#
# The other half of the same walk. Every approve the web resumes posts a real
# user message ("You're approved: <summary>. Please go ahead now.") and a
# card-pending turn persists "[waiting for your approval before continuing]".
# A few approvals in, the history window handed to a small local model is mostly
# approval choreography — and it pattern-completes "awaiting approval" out of it
# instead of calling the tool. Those rows are how the SYSTEM resumes a turn, not
# something the household said: they stay in the transcript the operator reads
# (messages.kind = 'plumbing', migration 014) and are simply never fed back as
# history. Mechanical: the query filters them AND history_window drops them.


def _kinds(rows) -> list[tuple[str, str, str]]:
    return [(r["role"], r["content"], r["kind"]) for r in rows]


async def _messages(pool) -> list:
    return await pool.fetch(
        "SELECT role, content, kind FROM messages ORDER BY created_at, id"
    )


def _history_sent(gateway: ScriptedGateway) -> list[str]:
    """Every user/assistant message the FIRST round of a turn carried."""
    return [
        m["content"]
        for m in gateway.payloads[0]["messages"]
        if m["role"] in ("user", "assistant")
    ]


def test_history_window_drops_plumbing_rows():
    """The pure half, independent of any query: a plumbing row never enters a
    window, so the property holds even if a caller forgets the WHERE. A row with
    no `kind` at all (an eval fixture, a hand-built dict) counts as chat, exactly
    as the column default does."""
    window = chat.history_window(
        [
            {"role": "user", "content": "newest", "kind": "chat"},
            {"role": "user", "content": "You're approved: do it.", "kind": "plumbing"},
            {"role": "assistant", "content": chat.PENDING_APPROVAL_NOTE, "kind": "plumbing"},
            {"role": "user", "content": "oldest"},
        ]
    )
    assert [m["content"] for m in window] == ["oldest", "newest"]


async def test_a_continuation_is_plumbing_and_leaves_later_history_clean(
    owner_client, pool, mount_peers, monkeypatch
):
    """The web's approve→continue path, end to end. The continuation names the
    consent it resumes, so its row is persisted as plumbing — and the CONTINUING
    turn still receives it as its own message (that is not history, so "go ahead
    now" still works). A later turn simply never sees it, while the ordinary
    messages around it are all still there."""
    await _arm_consent_tool(pool, monkeypatch)
    gateway = ScriptedGateway(
        rounds=((probe_call("c1", URL),), (text("Awaiting your approval."),))
    )
    mount_peers(gateway=gateway, memory=FakeMemory())
    first = await _say(owner_client, "check the pricing page")
    card = consent_frames(first)[0]
    conv_id = first[0]["meta"]["conversation_id"]

    await consents.decide(
        pool,
        consent_id=uuid.UUID(card["consent_id"]),
        approve=True,
        decided_by=await _owner_id(pool),
    )

    # The continuation the web sends, carrying the consent it resumes.
    continuation = f"You're approved: {card['summary']}. Please go ahead now."
    gateway2 = ScriptedGateway(rounds=((text("Done — I read the page."),),))
    mount_peers(gateway=gateway2, memory=FakeMemory())
    resp = await owner_client.post(
        "/api/v1/chat/stream",
        json={
            "message": continuation,
            "conversation_id": conv_id,
            "continuation_of": card["consent_id"],
        },
    )
    assert resp.status_code == 200

    # Persisted as plumbing — and STILL delivered to the turn it resumes.
    rows = await _messages(pool)
    assert (("user", continuation, "plumbing")) in _kinds(rows)
    assert _history_sent(gateway2)[-1] == continuation

    # A LATER turn never reads the choreography back, but keeps the real ones.
    gateway3 = ScriptedGateway(rounds=((text("Yes."),),))
    mount_peers(gateway=gateway3, memory=FakeMemory())
    resp = await owner_client.post(
        "/api/v1/chat/stream",
        json={"message": "anything else?", "conversation_id": conv_id},
    )
    assert resp.status_code == 200
    seen = _history_sent(gateway3)
    assert continuation not in seen
    assert "check the pricing page" in seen  # an ordinary message is kept
    assert "Done — I read the page." in seen


async def test_a_pending_approval_note_reply_is_plumbing_and_omitted_from_history(
    owner_client, pool, mount_peers, monkeypatch
):
    """The assistant half: a reply that is ONLY the pending-approval note says
    the turn ended with a card up, nothing more. It persists (the operator sees
    it) as plumbing, so the next turn does not read "[waiting for your approval
    before continuing]" back and learn to narrate a pending state."""
    await _arm_consent_tool(pool, monkeypatch)
    _spy_fetch(monkeypatch)
    gateway = ScriptedGateway(
        rounds=((probe_call("c1", URL),), (fetch_call("c2", "https://example.com/other"),))
    )
    mount_peers(gateway=gateway, memory=FakeMemory())
    first = await _say(owner_client, "check the pricing page")
    conv_id = first[0]["meta"]["conversation_id"]

    rows = await _messages(pool)
    assert (("assistant", chat.PENDING_APPROVAL_NOTE, "plumbing")) in _kinds(rows)
    # The user's own message beside it is ordinary conversation.
    assert (("user", "check the pricing page", "chat")) in _kinds(rows)

    gateway2 = ScriptedGateway(rounds=((text("Sure."),),))
    mount_peers(gateway=gateway2, memory=FakeMemory())
    resp = await owner_client.post(
        "/api/v1/chat/stream",
        json={"message": "never mind", "conversation_id": conv_id},
    )
    assert resp.status_code == 200
    seen = _history_sent(gateway2)
    assert chat.PENDING_APPROVAL_NOTE not in seen
    assert "check the pricing page" in seen


async def test_a_continuation_of_no_real_consent_is_an_ordinary_message(
    owner_client, pool, mount_peers
):
    """VERIFIED, never trusted, and fail-OPEN in the direction that keeps a real
    message visible: continuation_of naming no consent is ignored — the row is
    ordinary 'chat', the turn runs normally, and there is no 4xx (the flag only
    ever removes a row from future history, so a bad one must not cost a turn)."""
    gateway = ScriptedGateway(rounds=((text("Sure."),),))
    mount_peers(gateway=gateway, memory=FakeMemory())

    resp = await owner_client.post(
        "/api/v1/chat/stream",
        json={"message": "go ahead now", "continuation_of": str(uuid.uuid4())},
    )
    assert resp.status_code == 200
    conv_id = frames(resp.text)[0]["meta"]["conversation_id"]

    rows = await _messages(pool)
    assert (("user", "go ahead now", "chat")) in _kinds(rows)

    # And it is REAL conversation: the next turn reads it back.
    gateway2 = ScriptedGateway(rounds=((text("Ok."),),))
    mount_peers(gateway=gateway2, memory=FakeMemory())
    resp = await owner_client.post(
        "/api/v1/chat/stream",
        json={"message": "and?", "conversation_id": conv_id},
    )
    assert resp.status_code == 200
    assert "go ahead now" in _history_sent(gateway2)


# -- the redirect's own output is VETTED, and gated on side effects ----------
#
# Adversarial review of the redirect wave (2026-09-02), reproduced by execution.
# The redirect does not just re-word: its output REPLACES the durable record and
# is INGESTED, and it can CALL TOOLS. Both of those need a mechanical bound:
#
#   * C1 — the regenerated reply was judged by consent_claim_check ALONE, so a
#     regen that fabricated a COMPLETED action ("I've saved it to report.md")
#     persisted unvetted AND was ingested into per-person memory. Trading a
#     pending-state lie for a completed-action one is a worse trade, because the
#     second one crosses conversations through recall.
#   * I2 — nothing gated the redirect on what the turn had already DONE, so a
#     turn that really ran the tool in round 1 and then falsely narrated
#     "awaiting approval" ran it a SECOND time; and the dispatch could happen
#     past the round cap.


NARRATION_LIE = (
    "Done — KV offloading moves the attention cache to CPU RAM. "
    "I've saved this to kv_offloading.md."
)


async def test_a_regenerated_reply_that_fabricates_a_completed_action_is_refused(
    owner_client, pool, mount_peers
):
    """C1, the reviewer's exact repro. Round 1 fabricates a pending approval; the
    redirect answers with a completed-action claim no span backs. The regen is
    REJECTED by the narration guard, so the correction persists exactly as it did
    before the redirect existed, the span names the guard that refused, and the
    turn stays plumbing — the fabrication never reaches memory."""
    gateway = ScriptedGateway(rounds=((text(FABRICATION),), (text(NARRATION_LIE),)))
    memory = FakeMemory()
    mount_peers(gateway=gateway, memory=memory)

    sent = await _say(owner_client, "try again")

    assert gateway.calls == 2  # the reply, one redirect, and stop
    stored = await pool.fetchval("SELECT content FROM messages WHERE role = 'assistant'")
    assert stored == guards.CONSENT_CLAIM_CORRECTION
    assert "kv_offloading.md" not in stored  # the regen's lie does not persist
    assert _corrections(sent) == [guards.CONSENT_CLAIM_CORRECTION]

    spans = await _guard_spans(pool)
    assert [s["name"] for s in spans] == ["consent_claim"]
    assert spans[0]["meta"]["redirected"] is False
    assert spans[0]["meta"]["regen_rejected_by"] == "narration"

    await chat.drain_background()
    assert memory.ingests == []  # a refused regen leaves the turn plumbing


async def test_a_rejected_regen_still_persists_the_original_capability_correction(
    owner_client, pool, mount_peers
):
    """C1's second half: a rejected regen must not silently drop the OTHER
    corrections the original reply earned. A reply that both fabricates a pending
    state and denies a capability it holds fires two guards; when the redirect is
    refused, the record is exactly what the pre-redirect code composed — both
    corrections, adjacent, no fabrication between them."""
    reply = "That's awaiting your approval. I cannot access external websites."
    gateway = ScriptedGateway(rounds=((text(reply),), (text(NARRATION_LIE),)))
    memory = FakeMemory()
    mount_peers(gateway=gateway, memory=memory)

    sent = await _say(owner_client, "what's the latest from bigblueview.com?")

    corrections = _corrections(sent)
    assert corrections[0] == guards.CONSENT_CLAIM_CORRECTION
    assert "fetch_url" in corrections[1]  # the capability correction, still there
    stored = await pool.fetchval("SELECT content FROM messages WHERE role = 'assistant'")
    assert stored == f"{guards.CONSENT_CLAIM_CORRECTION}\n\n{corrections[1]}"
    assert "I cannot access external websites" not in stored
    assert "kv_offloading.md" not in stored

    names = [s["name"] for s in await _guard_spans(pool)]
    assert names == ["consent_claim", "capability_claim"]
    await chat.drain_background()
    assert memory.ingests == []


async def test_no_redirect_when_the_turn_already_ran_the_tool(
    owner_client, pool, mount_peers, monkeypatch
):
    """I2, reproduced: round 1 REALLY runs the tool, round 2 falsely narrates
    'awaiting your approval' about it. Redirecting would dispatch the same call a
    SECOND time — a duplicated side effect is worse than the lie. Derived from
    the turn's spans (a successful tool span), never from the prose: the spy is
    called exactly once, no third gateway round happens, and the span states
    why."""
    spy = await _arm_auto_tool(pool, monkeypatch)
    gateway = ScriptedGateway(
        rounds=(
            (auto_call("r1", URL),),
            (text("That's awaiting your approval — I can't run it yet."),),
        )
    )
    memory = FakeMemory()
    mount_peers(gateway=gateway, memory=memory)

    sent = await _say(owner_client, "turn on the desk light")

    assert spy.calls == [{"url": URL}]  # ONCE — never twice
    assert gateway.calls == 2  # no redirect round at all
    stored = await pool.fetchval("SELECT content FROM messages WHERE role = 'assistant'")
    assert stored == guards.CONSENT_CLAIM_CORRECTION
    assert _corrections(sent) == [guards.CONSENT_CLAIM_CORRECTION]

    spans = await _guard_spans(pool)
    assert [s["name"] for s in spans] == ["consent_claim"]
    assert spans[0]["meta"]["redirected"] is False
    assert spans[0]["meta"]["ran_a_tool"] is True
    assert spans[0]["meta"]["not_redirected_because"] == "tools_already_ran"


async def test_no_redirect_dispatch_when_the_turn_ran_out_of_rounds(
    owner_client, pool, mount_peers, monkeypatch
):
    """I2's other half: a turn that hit its round cap must not get one more tool
    dispatch through the redirect's side door. The cap round narrates the
    fabrication and asks for a tool; nothing is dispatched, and the redirect
    refuses to start."""
    spy = await _arm_auto_tool(pool, monkeypatch)
    resp = await owner_client.put(
        "/api/v1/settings", json={"key": "agents.max_tool_rounds", "value": 1}
    )
    assert resp.status_code == 200, resp.text
    gateway = ScriptedGateway(
        rounds=((text("That's awaiting your approval."), auto_call("r1", URL)),)
    )
    mount_peers(gateway=gateway, memory=FakeMemory())

    sent = await _say(owner_client, "turn on the desk light")

    assert spy.calls == []  # nothing dispatched, in the round OR the redirect
    assert gateway.calls == 1
    assert _corrections(sent) == [guards.CONSENT_CLAIM_CORRECTION]
    spans = await _guard_spans(pool)
    assert spans[0]["meta"]["redirected"] is False
    assert spans[0]["meta"]["not_redirected_because"] == "out_of_rounds"


def test_the_redirect_nudge_refuses_to_state_a_fact_that_is_not_true():
    """The nudge asserts 'nothing is pending and nothing has run', so it is BUILT
    from those two facts rather than written as a constant that could drift out
    of step with them. Told otherwise, it refuses — a lie to the model is what
    produces the double execution above."""
    nudge = chat.consent_redirect_nudge(has_pending_consent=False, ran_a_tool=False)
    assert "No approval is pending and nothing has run this turn" in nudge
    for pending, ran in ((True, False), (False, True), (True, True)):
        with pytest.raises(ValueError):
            chat.consent_redirect_nudge(has_pending_consent=pending, ran_a_tool=ran)


# -- continuation_of is SCOPED, and a plumbing turn stays out of memory ------
#
# Same review, the other two findings. Citing a consent id marks a message
# plumbing, which removes it from every later history window — so the id is a
# request to make something unreadable, and existence is nowhere near enough
# authority for it: every authenticated caller can list ids (GET
# /api/v1/consents), so a bare existence check let anyone cite a DENIED card, or
# another conversation's, or another person's, to hide any message they liked
# (I3). And an approved continuation that resolved cleanly still ingested "You're
# approved: … Please go ahead now." into per-person memory, where recall carries
# it into other conversations — the poisoning the kind column exists to stop,
# arriving through the ingest door instead (I4).


async def _plant_consent(pool, *, person_id, conversation_id, status: str) -> str:
    """A consent row in a chosen state, for the scoping cases. Written directly
    because the point is what the LOOKUP refuses, not how the row was made."""
    return str(
        await pool.fetchval(
            "INSERT INTO consents (action_class, args_hash, requestor_person, "
            "requestor_agent, conversation_id, args, summary, status, expires_at) "
            "VALUES ($1, 'h', $2, 'chat', $3, '{}'::jsonb, 'do the thing', $4, "
            "now() + interval '1 hour') RETURNING id",
            CONSENT_ACTION,
            person_id,
            conversation_id,
            status,
        )
    )


async def _kind_of(pool, content: str) -> str:
    return await pool.fetchval("SELECT kind FROM messages WHERE content = $1", content)


async def test_a_denied_cards_id_cannot_mark_a_message_plumbing(
    owner_client, pool, mount_peers
):
    """I3: a card the operator DENIED is not a card anyone is resuming. Citing it
    leaves the message ordinary chat — visible to later turns, exactly as if the
    field had not been sent."""
    gateway = ScriptedGateway(rounds=((text("Sure."),),))
    mount_peers(gateway=gateway, memory=FakeMemory())
    first = await _say(owner_client, "hello")
    conv_id = uuid.UUID(first[0]["meta"]["conversation_id"])
    denied = await _plant_consent(
        pool, person_id=await _owner_id(pool), conversation_id=conv_id, status="denied"
    )

    gateway2 = ScriptedGateway(rounds=((text("Ok."),),))
    mount_peers(gateway=gateway2, memory=FakeMemory())
    resp = await owner_client.post(
        "/api/v1/chat/stream",
        json={
            "message": "hide this one",
            "conversation_id": str(conv_id),
            "continuation_of": denied,
        },
    )
    assert resp.status_code == 200
    assert await _kind_of(pool, "hide this one") == "chat"

    gateway3 = ScriptedGateway(rounds=((text("Yes."),),))
    mount_peers(gateway=gateway3, memory=FakeMemory())
    resp = await owner_client.post(
        "/api/v1/chat/stream",
        json={"message": "and now?", "conversation_id": str(conv_id)},
    )
    assert resp.status_code == 200
    assert "hide this one" in _history_sent(gateway3)  # never hidden


async def test_another_persons_or_conversations_card_cannot_mark_a_message_plumbing(
    owner_client, pool, mount_peers
):
    """I3: an APPROVED card is still only resumable by the person who requested
    it, in the conversation it was raised in. Both mismatches leave the message
    ordinary chat."""
    gateway = ScriptedGateway(rounds=((text("Sure."),),))
    mount_peers(gateway=gateway, memory=FakeMemory())
    first = await _say(owner_client, "hello")
    conv_id = uuid.UUID(first[0]["meta"]["conversation_id"])
    owner_id = await _owner_id(pool)

    stranger = await pool.fetchval(
        "INSERT INTO people (name, role, password_hash) VALUES ('sam', 'adult', 'x') "
        "RETURNING id"
    )
    other_conversation = await pool.fetchval(
        "INSERT INTO conversations (person_id) VALUES ($1) RETURNING id", owner_id
    )
    theirs = await _plant_consent(
        pool, person_id=stranger, conversation_id=conv_id, status="approved"
    )
    elsewhere = await _plant_consent(
        pool, person_id=owner_id, conversation_id=other_conversation, status="approved"
    )

    for label, consent_id in (("theirs", theirs), ("elsewhere", elsewhere)):
        gw = ScriptedGateway(rounds=((text("Ok."),),))
        mount_peers(gateway=gw, memory=FakeMemory())
        resp = await owner_client.post(
            "/api/v1/chat/stream",
            json={
                "message": f"borrowed {label}",
                "conversation_id": str(conv_id),
                "continuation_of": consent_id,
            },
        )
        assert resp.status_code == 200
        assert await _kind_of(pool, f"borrowed {label}") == "chat", label


async def test_a_malformed_continuation_of_is_absent_not_a_refusal(
    owner_client, pool, mount_peers
):
    """M7: continuation_of is an optional HINT that can only remove a message
    from future history. A malformed one must cost nothing — no 422 from the
    model layer, no lost turn: it is simply treated as absent."""
    gateway = ScriptedGateway(rounds=((text("Sure."),),))
    mount_peers(gateway=gateway, memory=FakeMemory())

    resp = await owner_client.post(
        "/api/v1/chat/stream",
        json={"message": "go ahead now", "continuation_of": "not-a-uuid"},
    )
    assert resp.status_code == 200  # never a 4xx over a hint
    assert await _kind_of(pool, "go ahead now") == "chat"
    assert await pool.fetchval("SELECT status FROM turns") == "ok"


async def test_an_approved_continuation_turn_is_never_ingested(
    owner_client, pool, mount_peers, monkeypatch
):
    """I4: the happy path — the operator approved, the continuation runs the
    action cleanly, no new card. The turn still must not reach memory: ingesting
    it puts "You're approved: … Please go ahead now." into per-person recall,
    which crosses conversations and teaches exactly the approval-choreography
    pattern the kind column exists to keep out."""
    await _arm_consent_tool(pool, monkeypatch)
    gateway = ScriptedGateway(
        rounds=((probe_call("c1", URL),), (text("Awaiting your approval."),))
    )
    mount_peers(gateway=gateway, memory=FakeMemory())
    first = await _say(owner_client, "check the pricing page")
    card = consent_frames(first)[0]
    conv_id = first[0]["meta"]["conversation_id"]
    await consents.decide(
        pool,
        consent_id=uuid.UUID(card["consent_id"]),
        approve=True,
        decided_by=await _owner_id(pool),
    )

    continuation = f"You're approved: {card['summary']}. Please go ahead now."
    # The re-attempt burns the consent and RUNS: an ordinary, successful turn in
    # every respect except that its user message is plumbing.
    gateway2 = ScriptedGateway(
        rounds=((probe_call("c2", URL),), (text("Done — I read the pricing page."),))
    )
    memory = FakeMemory()
    mount_peers(gateway=gateway2, memory=memory)
    resp = await owner_client.post(
        "/api/v1/chat/stream",
        json={
            "message": continuation,
            "conversation_id": conv_id,
            "continuation_of": card["consent_id"],
        },
    )
    assert resp.status_code == 200
    assert consent_frames(frames(resp.text)) == []  # no new card: it just ran
    assert await _kind_of(pool, continuation) == "plumbing"

    await chat.drain_background()
    assert memory.ingests == []
    for ingest in memory.ingests:  # belt and braces if the skip ever loosens
        assert "You're approved" not in json.dumps(ingest)
