"""The bare-intent deferral, wired into the live turn.

Real trace, 2026-09-03 14:43 UTC (local model muse-glimmer): the user asked
"show me my workspace directory structure"; the ENTIRE reply was "Got it.
Checking the workspace…" with ZERO tool calls (tools advertised, device
online). guards.deferral_check's commitment leads ("I'll", "let
me", "I'm going to") require a first-person MODAL, and a bare
present-progressive ack-and-go names no such lead — the promise shipped
uncorrected and the turn ended.

guards.bare_intent_check catches the shape deferral_check cannot see; this
module proves the WIRING — it shares the deferral guard's span name
("deferral", distinguished by meta.kind="bare_intent"), it gets the SAME
tools-advertised redirect shape as the consent/state claim guards (through
`_claim_redirect`, so a tool call in the redirect actually dispatches), and
it shares the turn's single redirect budget with every other claim guard.
"""
from __future__ import annotations

import json

from app import chat, markup_calls, tools
from app.tools import web
from app.tools.base import Tool, ToolContext
from tests.conftest import requires_db
from tests.fakes import FakeMemory, ScriptedGateway
from tests.test_markup_calls import OBSERVED

pytestmark = requires_db

DONE = "[DONE]"
FETCH_SCHEMA = next(t.parameters for t in web.TOOLS if t.name == "fetch_url")
AUTO_ACTION = "auto_list_workspace"
URL = "https://workspace.local/list"
# The observed real-world XML block (tests/test_markup_calls.py), retargeted
# at our own AUTO tool — parsing does not care whose schema it names, and this
# is never dispatched anyway (a markup call is refused in every round).
BARE_INTENT_MARKUP = OBSERVED.replace('name="device_run"', f'name="{AUTO_ACTION}"')


class Spy:
    def __init__(self, result: str = "Ran it.") -> None:
        self.calls: list = []
        self.result = result

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


def text(piece: str) -> dict:
    return {"choices": [{"delta": {"content": piece}}]}


def call_delta(index: int, *, call_id, name, arguments) -> dict:
    return {
        "choices": [
            {
                "delta": {
                    "tool_calls": [
                        {
                            "index": index,
                            "id": call_id,
                            "type": "function",
                            "function": {"name": name, "arguments": json.dumps(arguments)},
                        }
                    ]
                }
            }
        ]
    }


def auto_call(call_id: str) -> dict:
    return call_delta(0, call_id=call_id, name=AUTO_ACTION, arguments={"url": URL})


async def _arm_auto_tool(pool, monkeypatch) -> Spy:
    """A private tool, registered and nothing else: in v4 that is all it takes
    for the redirect's call to RUN. Mirrors test_chat_pending_claim.py's
    _arm_auto_tool."""
    spy = Spy(result="default, src, tests, docs")
    monkeypatch.setitem(tools.REGISTRY, AUTO_ACTION, Tool(AUTO_ACTION, "d", FETCH_SCHEMA, spy))
    return spy


async def _say(client, message: str = "show me my workspace directory structure") -> list:
    resp = await client.post("/api/v1/chat/stream", json={"message": message})
    assert resp.status_code == 200, resp.text
    return frames(resp.text)


async def _deferral_spans(pool) -> list:
    rows = await pool.fetch(
        "SELECT name, meta FROM turn_spans WHERE kind = 'guard' ORDER BY started_at"
    )
    return [row for row in rows if row["name"] == "deferral"]


async def _stored_reply(pool) -> str:
    return await pool.fetchval("SELECT content FROM messages WHERE role = 'assistant'")


def _corrections(sent: list) -> list[str]:
    return [f["correction"] for f in sent if isinstance(f, dict) and "correction" in f]


def _activities(sent: list) -> list[tuple[str, str]]:
    return [
        (f["activity"]["tool"], f["activity"]["status"])
        for f in sent
        if isinstance(f, dict) and "activity" in f
    ]


BARE_INTENT = "Got it. Checking the workspace…"


async def test_a_bare_intent_reply_redirects_with_tools_and_the_tool_actually_runs(
    owner_client, pool, mount_peers, monkeypatch
):
    """The headline fix. Round 1 is ONLY an acknowledgment and calls nothing.
    bare_intent_check fires (no commitment-phrase lead, no tool span at all),
    and — unlike the commitment form's text-only redirect — this one
    advertises TOOLS: the redirect calls the tool, it is dispatched through
    the SAME machinery as any other round (the spy proves the real body ran),
    and the reply that reports the result REPLACES the durable text."""
    spy = await _arm_auto_tool(pool, monkeypatch)
    done = "Here's your workspace: default, src, tests, docs."
    gateway = ScriptedGateway(
        rounds=(
            (text(BARE_INTENT),),
            (auto_call("r1"),),
            (text(done),),
        )
    )
    memory = FakeMemory()
    mount_peers(gateway=gateway, memory=memory)

    sent = await _say(owner_client)

    # The bare intent, ONE redirect round (with tools), then the closing round.
    assert gateway.calls == 3
    assert spy.calls == [{"url": URL}]  # the tool really ran
    assert _activities(sent) == [(AUTO_ACTION, "start"), (AUTO_ACTION, "ok")]

    stored = await _stored_reply(pool)
    assert stored == done
    assert BARE_INTENT not in stored

    spans = await _deferral_spans(pool)
    assert len(spans) == 1
    meta = spans[0]["meta"]
    assert meta["kind"] == "bare_intent"
    assert meta["detected"] is True
    assert meta["redirected"] is True

    assert _corrections(sent) == [chat.DEFERRAL_NOTE]
    assert [f["t"] for f in sent if isinstance(f, dict) and "t" in f] == [BARE_INTENT, done]
    assert await pool.fetchval("SELECT status FROM turns") == "ok"

    # A turn that DID the work is ordinary knowledge again.
    await chat.drain_background()
    assert len(memory.ingests) == 1
    assert memory.ingests[0]["exchange"]["assistant"] == done


async def test_a_bare_intent_regen_that_still_defers_persists_the_honest_note(
    owner_client, pool, mount_peers
):
    """Bounded to ONE. If the regeneration is ITSELF another bare ack-and-go
    with no tool call, `_regen_rejected_by`'s bare_intent check catches it —
    the honest backend note persists (REPLACING the broken promise, not
    appended to it) and the turn is plumbing: not ingested."""
    gateway = ScriptedGateway(rounds=((text(BARE_INTENT),), (text("Sure. On it."),)))
    memory = FakeMemory()
    mount_peers(gateway=gateway, memory=memory)

    sent = await _say(owner_client)

    # The bare intent, then the one redirect round — no calls, so no closing
    # round either; never a third gateway call.
    assert gateway.calls == 2
    assert await pool.fetchval("SELECT status FROM turns") == "ok"

    stored = await _stored_reply(pool)
    assert stored == chat.BARE_INTENT_HONEST_NOTE
    assert _corrections(sent) == [chat.BARE_INTENT_HONEST_NOTE]
    # The still-deferring regeneration is never streamed as the reply.
    assert [f["t"] for f in sent if isinstance(f, dict) and "t" in f] == [BARE_INTENT]

    spans = await _deferral_spans(pool)
    assert len(spans) == 1
    meta = spans[0]["meta"]
    assert meta["kind"] == "bare_intent"
    assert meta["redirected"] is False
    assert meta["regen_rejected_by"] == "bare_intent"

    # Choreography about a broken promise is not knowledge.
    await chat.drain_background()
    assert memory.ingests == []


async def test_a_redirect_gateway_error_degrades_to_the_honest_note(
    owner_client, pool, mount_peers
):
    """FAIL-OPEN: the redirect round dies (the script has no second round, so
    it answers 500). The honest note ships, never an error frame or a lost
    turn, and there is no retry."""
    gateway = ScriptedGateway(rounds=((text(BARE_INTENT),),))
    mount_peers(gateway=gateway, memory=FakeMemory())

    sent = await _say(owner_client)

    assert gateway.calls == 2  # the bare intent, then the failed redirect
    assert not [f for f in sent if isinstance(f, dict) and "error" in f]
    stored = await _stored_reply(pool)
    assert stored == chat.BARE_INTENT_HONEST_NOTE

    spans = await _deferral_spans(pool)
    assert len(spans) == 1
    assert spans[0]["meta"]["redirected"] is False
    assert spans[0]["meta"]["error"]
    assert await pool.fetchval("SELECT status FROM turns") == "ok"


async def test_the_redirect_budget_is_shared_with_consent_claim(owner_client, pool, mount_peers):
    """ONE redirect per turn, total. A reply whose stance both fabricates a
    pending approval AND trails off into a bare ack-and-go would, on its own
    text, qualify a SECOND claim for the budget — the consent guard fires
    first and takes it, so the bare-intent path never runs: exactly one
    redirect, no 'deferral'-named span with kind bare_intent anywhere."""
    both = "That's still awaiting your approval — I can't run it until you OK it. Checking now…"
    checked = "I checked directly: nothing is actually pending."
    gateway = ScriptedGateway(rounds=((text(both),), (text(checked),)))
    mount_peers(gateway=gateway, memory=FakeMemory())

    sent = await _say(owner_client)

    assert gateway.calls == 2  # ONE redirect, not two
    spans = await pool.fetch(
        "SELECT name, meta FROM turn_spans WHERE kind = 'guard' ORDER BY started_at"
    )
    names = [s["name"] for s in spans]
    assert names == ["consent_claim"]  # bare-intent never got the budget
    assert not any(s["name"] == "deferral" for s in spans)
    stored = await _stored_reply(pool)
    assert stored == checked
    assert _corrections(sent) == [chat.CONSENT_REDIRECT_NOTE]
    assert await pool.fetchval("SELECT status FROM turns") == "ok"


async def test_a_bare_intent_reply_whose_tool_actually_ran_does_not_fire(
    owner_client, pool, mount_peers, monkeypatch
):
    """The precision crux at the wiring level: the reply says 'Checking the
    workspace…' AND a tool span really ran this turn, so it is an honest,
    terse report — no detector fire, no redirect. Only the reply and the
    answering round reach the gateway."""
    spy = await _arm_auto_tool(pool, monkeypatch)
    gateway = ScriptedGateway(
        rounds=(
            (text("Checking the workspace. "), auto_call("c1")),
            (text("Found: default, src, tests, docs."),),
        )
    )
    mount_peers(gateway=gateway, memory=FakeMemory())

    await _say(owner_client)

    assert gateway.calls == 2
    assert spy.calls == [{"url": URL}]
    assert await _deferral_spans(pool) == []
    stored = await _stored_reply(pool)
    assert stored == "Checking the workspace. Found: default, src, tests, docs."
    assert await pool.fetchval("SELECT status FROM turns") == "ok"


async def test_a_detector_error_fails_open_and_ships_the_reply(
    owner_client, pool, mount_peers, monkeypatch
):
    """The detector itself is fail-OPEN: if bare_intent_check raises, the
    reply ships unchanged — one gateway call, no redirect, no span."""

    def boom(*_args, **_kwargs):
        raise RuntimeError("detector blew up")

    monkeypatch.setattr(chat.guards, "bare_intent_check", boom)
    gateway = ScriptedGateway(rounds=((text(BARE_INTENT),),))
    mount_peers(gateway=gateway, memory=FakeMemory())

    sent = await _say(owner_client)

    assert gateway.calls == 1  # no redirect was attempted
    assert await _stored_reply(pool) == BARE_INTENT
    assert await pool.fetchval("SELECT status FROM turns") == "ok"
    assert await _deferral_spans(pool) == []
    assert not [f for f in sent if isinstance(f, dict) and "error" in f]


async def test_the_bare_intent_redirects_closing_markup_never_reports_a_ran_tool_as_nothing(
    owner_client, pool, mount_peers, monkeypatch
):
    """The reviewer's exact repro (adversarial review of 70d7c54e, I2). Round 1
    is a bare ack-and-go and calls nothing. The redirect's FIRST round (tools
    advertised) actually dispatches the tool — the spy proves it ran — but the
    CLOSING round (no tools by design) answers with nothing but markup, which
    is refused and never dispatched. The durable text must name what ran; it
    must NEVER say "did not" — that would report a call that RAN as if
    nothing did (the same rule the markup-notes fix established for consent/
    state — see tests/test_chat_markup.py)."""
    spy = await _arm_auto_tool(pool, monkeypatch)
    gateway = ScriptedGateway(
        rounds=(
            (text(BARE_INTENT),),
            (auto_call("r1"),),
            (text(BARE_INTENT_MARKUP),),
        )
    )
    mount_peers(gateway=gateway, memory=FakeMemory())

    await _say(owner_client)

    # The markup call was never dispatched — only the redirect's real call ran.
    assert spy.calls == [{"url": URL}]

    stored = await _stored_reply(pool)
    assert "did not" not in stored
    assert chat.BARE_INTENT_HONEST_NOTE not in stored
    assert AUTO_ACTION in stored
    assert "I ran" in stored
    # The markup note is not dropped either — it reaches the durable text even
    # though this block runs after the turn's one shared backend-note append.
    assert markup_calls.no_tool_round_note([AUTO_ACTION]) in stored

    spans = await _deferral_spans(pool)
    assert len(spans) == 1
    assert spans[0]["meta"]["kind"] == "bare_intent"
    assert spans[0]["meta"]["redirected"] is False
    assert await pool.fetchval("SELECT status FROM turns") == "ok"


async def test_an_overlapping_commitment_phrase_stays_with_deferral_only(
    owner_client, pool, mount_peers
):
    """'Let me look it up.' independently matches BOTH deferral_check (a
    first-person modal lead mapped to the registered web_search tool) and
    bare_intent_check (the same phrase is also a bare 'let me look' lead with
    no tool span). Mutual exclusion is the caller's job: deferral_check runs
    first and, since it fires, bare_intent_check is never even evaluated — so
    there is exactly ONE 'deferral' guard span (the commitment kind, no
    meta.kind at all), one redirect, never two."""
    corrected = "The Pixel 10 has a 50-megapixel main camera with strong low-light."
    gateway = ScriptedGateway(
        rounds=((text("Let me look it up."),), (text(corrected),))
    )
    mount_peers(gateway=gateway, memory=FakeMemory())

    sent = await _say(owner_client, "what's the latest with the pixel?")

    assert gateway.calls == 2  # the reply, then ONE redirect — never a second
    spans = await _deferral_spans(pool)
    assert len(spans) == 1
    assert "kind" not in spans[0]["meta"]  # the commitment form, not bare_intent
    assert spans[0]["meta"]["action"] == "web_search"
    assert spans[0]["meta"]["redirected"] is True
    assert await _stored_reply(pool) == corrected
    assert _corrections(sent) == [chat.DEFERRAL_NOTE]
    assert await pool.fetchval("SELECT status FROM turns") == "ok"
