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

from app import consents, guards, tools
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
    monkeypatch.setitem(tools.REGISTRY, "fetch_url", Tool("fetch_url", "d", FETCH_SCHEMA, spy))
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
    made no tool call and nothing is pending. The guard contradicts it in the
    persisted reply and on its own frame, and records a guard span."""
    gateway = ScriptedGateway(
        rounds=(
            (
                text(
                    "That fetch is awaiting your approval — I can't complete it "
                    "without you OK'ing it."
                ),
            ),
        )
    )
    mount_peers(gateway=gateway, memory=FakeMemory())

    sent = await _say(owner_client, "what's new on bigblueview.com")

    assert _corrections(sent) == [guards.CONSENT_CLAIM_CORRECTION]
    stored = await pool.fetchval("SELECT content FROM messages WHERE role = 'assistant'")
    assert stored.endswith(guards.CONSENT_CLAIM_CORRECTION)
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
