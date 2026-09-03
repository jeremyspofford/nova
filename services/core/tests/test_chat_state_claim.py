"""The live-state guard wired into the real turn, and its ONE redirect.

The owner's walk, 2026-09-02 23:51: he said "try again"; the turn made ZERO tool
calls; the reply asserted his paired machine was "still offline" — parroted out
of an earlier (then-true) reply. The device was online. No guard covered that
shape, so the falsehood shipped AND was ingested into memory, where recall would
serve it back as knowledge (which is how the parrot got its line in the first
place).

These drive the real route through a scripted gateway: the claim fires only when
nothing checked the device, the redirect actually CHECKS it, a regeneration that
still claims unchecked is refused and keeps the correction, an unredirected turn
stays out of memory, and the single redirect budget is shared with the consent
guard (one redirect, both corrections when it fails).
"""
from __future__ import annotations

import json

from app import chat, guards, tools
from app.tools.base import Tool, ToolContext
from tests.conftest import requires_db
from tests.fakes import FakeMemory, ScriptedGateway

pytestmark = requires_db

DONE = "[DONE]"
DEVICE = "DELL-XPS-8950"
# The owner's EXACT captured reply.
OWNER_CASE = (
    "Looks like the device is still offline. Could you confirm it's on and "
    "connected so I can try again?"
)


def frames(body: str) -> list:
    out = []
    for block in body.strip().split("\n\n"):
        assert block.startswith("data: "), block
        payload = block[len("data: ") :]
        out.append(payload if payload == DONE else json.loads(payload))
    return out


def text(piece: str) -> dict:
    return {"choices": [{"delta": {"content": piece}}]}


def tool_call(call_id: str, name: str, args: dict) -> dict:
    return {
        "choices": [
            {
                "delta": {
                    "tool_calls": [
                        {
                            "index": 0,
                            "id": call_id,
                            "type": "function",
                            "function": {"name": name, "arguments": json.dumps(args)},
                        }
                    ]
                }
            }
        ]
    }


async def _say(client, message: str = "try again") -> list:
    resp = await client.post("/api/v1/chat/stream", json={"message": message})
    assert resp.status_code == 200, resp.text
    return frames(resp.text)


def _corrections(sent: list) -> list[str]:
    return [f["correction"] for f in sent if isinstance(f, dict) and "correction" in f]


def _texts(sent: list) -> list[str]:
    return [f["t"] for f in sent if isinstance(f, dict) and "t" in f]


async def _guard_spans(pool) -> list:
    return await pool.fetch(
        "SELECT name, meta FROM turn_spans WHERE kind = 'guard' ORDER BY started_at"
    )


async def _stored(pool) -> str:
    return await pool.fetchval("SELECT content FROM messages WHERE role = 'assistant'")


async def _pair(pool, name: str = DEVICE) -> None:
    """A paired machine, straight into the registry — the guard's names come
    from devices.list_devices, so this is the only fact it needs."""
    await pool.execute(
        "INSERT INTO devices (name, platform, hostname, pubkey) "
        "VALUES ($1, 'linux', 'dell', $2)",
        name,
        "a" * 64,
    )


class DeviceSpy:
    """A private, NON-ephemeral device tool. Non-ephemeral on purpose: the real
    device_list is ephemeral (a point-in-time read that must never be ingested —
    caching "offline" is exactly how the parrot got its line), which would mask
    the ingest assertion the redirect test is making. Named device_* because
    that prefix IS how the guard derives backing."""

    def __init__(self, result: str) -> None:
        self.calls: list[dict] = []
        self.result = result

    async def __call__(self, args: dict, ctx: ToolContext) -> str:
        self.calls.append(args)
        return self.result


async def _arm_device_probe(pool, monkeypatch) -> DeviceSpy:
    spy = DeviceSpy(f"{DEVICE} is connected, last seen just now.")
    monkeypatch.setitem(
        tools.REGISTRY,
        "device_probe",
        Tool(
            "device_probe",
            "Check a paired device's live state.",
            {"type": "object", "properties": {}, "required": [], "additionalProperties": False},
            spy,
        ),
    )
    await pool.execute(
        "INSERT INTO action_classes (action_class, risk_tier, disposition, earned, "
        "consecutive_successes) VALUES ($1, 'device', 'auto', false, 0) "
        "ON CONFLICT (action_class) DO UPDATE SET disposition = 'auto', "
        "earned = false, consecutive_successes = 0, updated_at = now()",
        "device_probe",
    )
    return spy


async def _arm_consent_device_tool(pool, monkeypatch) -> DeviceSpy:
    """A private CONSENT-disposition device tool: calling it raises a card,
    which closes the tool loop for the rest of the turn (review I2)."""
    spy = DeviceSpy("never reached")
    monkeypatch.setitem(
        tools.REGISTRY,
        "device_gate",
        Tool(
            "device_gate",
            "A device action that needs approval.",
            {"type": "object", "properties": {}, "required": [], "additionalProperties": False},
            spy,
        ),
    )
    await pool.execute(
        "INSERT INTO action_classes (action_class, risk_tier, disposition, earned, "
        "consecutive_successes) VALUES ($1, 'device', 'consent', false, 0) "
        "ON CONFLICT (action_class) DO UPDATE SET disposition = 'consent', "
        "earned = false, consecutive_successes = 0, updated_at = now()",
        "device_gate",
    )
    return spy


# -- the headline: the claim fires, and the redirect actually checks --------


async def test_the_owner_case_fires_and_the_redirect_checks_the_device(
    owner_client, pool, mount_peers, monkeypatch
):
    """Round 1 is the owner's exact reply with ZERO tool calls. The guard fires
    (a paired device, no device span) and the turn spends its one redirect on a
    regeneration WITH tools: it calls a device tool, the call is dispatched
    through the same machinery as any other round (the spy proves the real body
    ran), and the reply reporting the true state REPLACES the durable text."""
    spy = await _arm_device_probe(pool, monkeypatch)
    await _pair(pool)
    answer = f"{DEVICE} is connected — it came back online."
    gateway = ScriptedGateway(
        rounds=(
            (text(OWNER_CASE),),
            (tool_call("r1", "device_probe", {}),),
            (text(answer),),
        )
    )
    memory = FakeMemory()
    mount_peers(gateway=gateway, memory=memory)

    sent = await _say(owner_client)

    assert gateway.calls == 3  # the claim, one redirect, its closing round
    assert spy.calls == [{}]  # the device was really checked

    assert await _stored(pool) == answer
    assert guards.STATE_CLAIM_CORRECTION not in await _stored(pool)
    assert _corrections(sent) == [chat.STATE_REDIRECT_NOTE]
    assert _texts(sent) == [OWNER_CASE, answer]

    spans = await _guard_spans(pool)
    assert [s["name"] for s in spans] == ["state_claim"]
    assert spans[0]["meta"]["redirected"] is True
    assert spans[0]["meta"]["device"] == "the device"
    assert spans[0]["meta"]["paired_devices"] == 1
    assert await pool.fetchval("SELECT status FROM turns") == "ok"

    # A turn that DID the check is ordinary knowledge again.
    await chat.drain_background()
    assert len(memory.ingests) == 1


async def test_a_regen_that_still_claims_unchecked_keeps_the_correction(
    owner_client, pool, mount_peers
):
    """Bounded to ONE. The regeneration repeats an unchecked state claim, so the
    FULL mechanical vetting of the redirect's output refuses it by name, the
    correction persists ALONE (replace-class — the parrot must not reach the next
    turn's history), and the turn stays out of memory."""
    await _pair(pool)
    gateway = ScriptedGateway(
        rounds=((text(OWNER_CASE),), (text("The device is still offline, sorry."),))
    )
    memory = FakeMemory()
    mount_peers(gateway=gateway, memory=memory)

    sent = await _say(owner_client)

    assert gateway.calls == 2  # the claim, one redirect, and stop
    stored = await _stored(pool)
    assert stored == guards.STATE_CLAIM_CORRECTION
    assert "still offline" not in stored
    assert _corrections(sent) == [guards.STATE_CLAIM_CORRECTION]

    spans = await _guard_spans(pool)
    assert [s["name"] for s in spans] == ["state_claim"]
    assert spans[0]["meta"]["redirected"] is False
    assert spans[0]["meta"]["regen_rejected_by"] == "state_claim"
    assert await pool.fetchval("SELECT status FROM turns") == "ok"

    await chat.drain_background()
    assert memory.ingests == []  # a fired state guard makes the turn plumbing


async def test_a_gateway_failure_in_the_redirect_ships_the_correction(
    owner_client, pool, mount_peers
):
    """FAIL-OPEN: the redirect's round dies (the script has no round 2, so it
    answers 500). The correction ships — never an error frame, never a lost
    turn."""
    await _pair(pool)
    gateway = ScriptedGateway(rounds=((text(OWNER_CASE),),))
    mount_peers(gateway=gateway, memory=FakeMemory())

    sent = await _say(owner_client)

    assert _corrections(sent) == [guards.STATE_CLAIM_CORRECTION]
    assert not [f for f in sent if isinstance(f, dict) and "error" in f]
    assert await _stored(pool) == guards.STATE_CLAIM_CORRECTION
    spans = await _guard_spans(pool)
    assert spans[0]["meta"]["redirected"] is False
    assert spans[0]["meta"]["error"]
    assert await pool.fetchval("SELECT status FROM turns") == "ok"


# -- the two toggles, through the real route -------------------------------


async def test_the_same_sentence_is_clean_when_a_device_tool_really_ran(
    owner_client, pool, mount_peers
):
    """The toggle, end to end: round 1 calls the REAL device_list (auto, reads
    Nova's own records), so round 2's identical sentence is backed by a span.
    No guard fires, no redirect runs (a third gateway call would be a loud 500),
    and the reply stands untouched."""
    await _pair(pool)
    gateway = ScriptedGateway(
        rounds=((tool_call("d1", "device_list", {}),), (text(OWNER_CASE),))
    )
    mount_peers(gateway=gateway, memory=FakeMemory())

    sent = await _say(owner_client)

    assert gateway.calls == 2
    assert [s["name"] for s in await _guard_spans(pool)] == []
    assert _corrections(sent) == []
    assert await _stored(pool) == OWNER_CASE


async def test_nothing_paired_means_the_guard_never_fires(
    owner_client, pool, mount_peers
):
    """DERIVED, not hardcoded: with no device in the registry there is no machine
    to be wrong about, so the identical sentence stands and the turn is ordinary
    knowledge."""
    gateway = ScriptedGateway(rounds=((text(OWNER_CASE),),))
    memory = FakeMemory()
    mount_peers(gateway=gateway, memory=memory)

    sent = await _say(owner_client)

    assert gateway.calls == 1  # no redirect at all
    assert [s["name"] for s in await _guard_spans(pool)] == []
    assert _corrections(sent) == []
    assert await _stored(pool) == OWNER_CASE
    await chat.drain_background()
    assert len(memory.ingests) == 1


async def test_a_revoked_device_does_not_arm_the_guard(
    owner_client, pool, mount_peers
):
    """A revoked machine is not paired. Its name must not keep arming a check
    forever — the registry read excludes it, so the guard is silent again."""
    await _pair(pool)
    await pool.execute("UPDATE devices SET revoked_at = now()")
    gateway = ScriptedGateway(rounds=((text(OWNER_CASE),),))
    mount_peers(gateway=gateway, memory=FakeMemory())

    await _say(owner_client)

    assert gateway.calls == 1
    assert [s["name"] for s in await _guard_spans(pool)] == []
    assert await _stored(pool) == OWNER_CASE


# -- precision, through the real route -------------------------------------


async def test_hedged_and_past_phrasings_are_never_redirected(
    owner_client, pool, mount_peers
):
    """Precision first: a past report, a conditional and an intent-to-check all
    ship untouched. One gateway call each — a redirect would be a loud 500."""
    honest = [
        "The device was offline earlier, so that may be why it failed.",
        "If the device is offline I can wake it when you're ready.",
        "Let me check whether the device is online before I retry.",
    ]
    for reply in honest:
        await pool.execute("TRUNCATE turn_spans, turns, messages, conversations CASCADE")
        await pool.execute("TRUNCATE devices CASCADE")
        await _pair(pool)
        gateway = ScriptedGateway(rounds=((text(reply),),))
        mount_peers(gateway=gateway, memory=FakeMemory())

        sent = await _say(owner_client)

        assert gateway.calls == 1, reply
        assert [s["name"] for s in await _guard_spans(pool)] == [], reply
        assert _corrections(sent) == [], reply
        assert await _stored(pool) == reply


# -- the SHARED redirect budget --------------------------------------------


async def test_both_claims_get_one_redirect_and_both_corrections_on_failure(
    owner_client, pool, mount_peers
):
    """ONE redirect per turn, first claim wins. A reply that BOTH fabricates a
    pending approval AND asserts an unchecked device state qualifies for two —
    the consent guard takes the budget, its regeneration fails to clear the bar,
    and the state guard then only CORRECTS. Two gateway calls, two guard spans,
    both corrections in the durable record, and the turn stays out of memory."""
    await _pair(pool)
    both = "That's awaiting your approval. The device is still offline anyway."
    gateway = ScriptedGateway(
        rounds=((text(both),), (text("It is still pending your approval."),))
    )
    memory = FakeMemory()
    mount_peers(gateway=gateway, memory=memory)

    sent = await _say(owner_client)

    assert gateway.calls == 2  # ONE redirect, not two
    spans = await _guard_spans(pool)
    assert [s["name"] for s in spans] == ["consent_claim", "state_claim"]
    assert spans[0]["meta"]["redirected"] is False
    assert spans[1]["meta"]["redirected"] is False
    assert spans[1]["meta"]["not_redirected_because"] == "redirect_spent"

    stored = await _stored(pool)
    assert stored == (
        f"{guards.CONSENT_CLAIM_CORRECTION}\n\n{guards.STATE_CLAIM_CORRECTION}"
    )
    assert _corrections(sent) == [
        guards.CONSENT_CLAIM_CORRECTION,
        guards.STATE_CLAIM_CORRECTION,
    ]
    await chat.drain_background()
    assert memory.ingests == []


async def test_a_successful_consent_redirect_skips_the_state_guard_entirely(
    owner_client, pool, mount_peers, monkeypatch
):
    """When the consent redirect STANDS, the durable text is the regeneration —
    which `_regen_rejected_by` already vetted with the state check against the
    now-live spans. Judging the discarded prose would file a span about text
    nobody reads, so it does not happen: one guard span, and the regenerated
    reply persists."""
    spy = await _arm_device_probe(pool, monkeypatch)
    await _pair(pool)
    both = "That's awaiting your approval. The device is still offline anyway."
    answer = f"{DEVICE} is connected — I checked."
    gateway = ScriptedGateway(
        rounds=(
            (text(both),),
            (tool_call("r1", "device_probe", {}),),
            (text(answer),),
        )
    )
    mount_peers(gateway=gateway, memory=FakeMemory())

    sent = await _say(owner_client)

    assert gateway.calls == 3
    assert spy.calls == [{}]
    assert [s["name"] for s in await _guard_spans(pool)] == ["consent_claim"]
    assert await _stored(pool) == answer
    assert _corrections(sent) == [chat.CONSENT_REDIRECT_NOTE]


# -- review C1: an offline device refuses every tool, and that IS a check ------


async def test_a_refused_not_connected_call_backs_an_offline_report(
    owner_client, pool, mount_peers
):
    """The guard's worst failure mode, closed. The device is paired and NOT in
    the hub, so device_run refuses at the precheck ("not connected — its tile is
    stale"): ok=False, but connectivity WAS determined. The model then honestly
    reports the machine is offline. No guard may fire, no redirect may run, and
    the true reply must persist verbatim — correcting it would make the guard
    the liar in exactly the scenario it exists for."""
    await _pair(pool)
    honest = f"I ran the check and it came back not connected — {DEVICE} is offline."
    gateway = ScriptedGateway(
        rounds=(
            (tool_call("d1", "device_run", {"device": DEVICE, "argv": ["ls"]}),),
            (text(honest),),
        )
    )
    mount_peers(gateway=gateway, memory=FakeMemory())

    sent = await _say(owner_client)

    assert gateway.calls == 2  # no redirect: a third call would be a loud 500
    # The refusal really happened, and it carried the structured fact.
    span = await pool.fetchrow(
        "SELECT name, meta FROM turn_spans WHERE kind = 'tool' ORDER BY started_at"
    )
    assert span["name"] == "device_run"
    assert span["meta"]["ok"] is False
    assert span["meta"]["facts"] == [{"device": DEVICE, "connected": False}]

    assert [s["name"] for s in await _guard_spans(pool)] == []
    assert _corrections(sent) == []
    assert await _stored(pool) == honest


async def test_a_no_such_device_refusal_still_leaves_the_claim_unchecked(
    owner_client, pool, mount_peers
):
    """The other half: an unknown name refuses BEFORE connectivity is looked at,
    so it settles nothing and backs nothing — the guard still fires."""
    await _pair(pool)
    gateway = ScriptedGateway(
        rounds=(
            (tool_call("d1", "device_run", {"device": "nope", "argv": ["ls"]}),),
            (text(OWNER_CASE),),
            (text("The device is still offline."),),
        )
    )
    mount_peers(gateway=gateway, memory=FakeMemory())

    await _say(owner_client)

    span = await pool.fetchrow(
        "SELECT meta FROM turn_spans WHERE kind = 'tool' ORDER BY started_at"
    )
    assert "facts" not in span["meta"]
    spans = await _guard_spans(pool)
    assert [s["name"] for s in spans] == ["state_claim"]
    assert spans[0]["meta"]["redirected"] is False


# -- review I2: no redirect, and no dispatch, once a card is up ----------------


async def test_no_redirect_once_a_card_is_pending(
    owner_client, pool, mount_peers, monkeypatch
):
    """A consent-tier call raises a card, which CLOSES the tool loop; the closed
    narration round then asserts an unchecked device state. The state guard
    fires — and must NOT redirect, because a redirect could dispatch work the
    operator is still deciding about. The correction ships, the span says why,
    and the spy proves nothing ever ran."""
    spy = await _arm_consent_device_tool(pool, monkeypatch)
    await _pair(pool)
    gateway = ScriptedGateway(
        rounds=(
            (tool_call("c1", "device_gate", {}),),
            (text(OWNER_CASE),),
        )
    )
    mount_peers(gateway=gateway, memory=FakeMemory())

    sent = await _say(owner_client)

    assert gateway.calls == 2  # no redirect round at all
    assert spy.calls == []  # nothing dispatched, in the round OR a redirect
    spans = await _guard_spans(pool)
    assert [s["name"] for s in spans] == ["state_claim"]
    assert spans[0]["meta"]["redirected"] is False
    assert spans[0]["meta"]["not_redirected_because"] == "card_raised"
    assert guards.STATE_CLAIM_CORRECTION in _corrections(sent)


# -- review M5: a tool call in the redirect's CLOSING round is refused ---------


async def test_a_tool_call_in_the_redirects_closing_round_is_refused(
    owner_client, pool, mount_peers, monkeypatch
):
    """The redirect gets ONE attempt at the action. Its closing round advertises
    no tools; a call it makes anyway used to be dropped silently. It is now
    refused through the shared _refuse_call and recorded as a span, so the trace
    shows the call and why it did not run — and the spy proves it ran once, not
    twice."""
    spy = await _arm_device_probe(pool, monkeypatch)
    await _pair(pool)
    gateway = ScriptedGateway(
        rounds=(
            (text(OWNER_CASE),),
            (tool_call("r1", "device_probe", {}),),
            (tool_call("r2", "device_probe", {}),),  # the closing round asks again
        )
    )
    mount_peers(gateway=gateway, memory=FakeMemory())

    await _say(owner_client)

    assert spy.calls == [{}]  # dispatched exactly ONCE
    refused = [
        row
        for row in await pool.fetch(
            "SELECT name, meta FROM turn_spans WHERE kind = 'tool' ORDER BY started_at"
        )
        if row["meta"].get("refused_redirect_closed") is True
    ]
    assert len(refused) == 1
    assert refused[0]["meta"]["ok"] is False
    assert refused[0]["meta"]["error"] == chat.REDIRECT_CLOSED_REFUSAL
    spans = await _guard_spans(pool)
    assert spans[0]["meta"]["refused_calls"] == 1
