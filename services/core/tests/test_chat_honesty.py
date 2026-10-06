"""The honesty guard wired into the live turn.

test_guards.py pins the matcher in isolation; these prove the wiring: a
fabricated claim is corrected in the PERSISTED text and streamed as its own
frame with a kind='guard' span in the atomic close, and an honest turn is
byte-identical to what shipped before the guard existed.
"""
from __future__ import annotations

import json

import pytest

from app import chat, guards, machines
from tests.conftest import requires_db
from tests.fakes import FakeMemory, ScriptedGateway

pytestmark = requires_db

DONE = "[DONE]"


def frames(body: str) -> list:
    out = []
    for block in body.strip().split("\n\n"):
        assert block.startswith("data: "), block
        payload = block[len("data: ") :]
        out.append(payload if payload == DONE else json.loads(payload))
    return out


def text(piece: str) -> dict:
    return {"choices": [{"delta": {"content": piece}}]}


def _call_delta(index: int, *, call_id=None, name=None, arguments=None) -> dict:
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


def streamed_call(index: int, call_id: str, name: str, arguments: dict) -> tuple[dict, ...]:
    blob = json.dumps(arguments)
    head, tail = blob[: len(blob) // 2], blob[len(blob) // 2 :]
    return (
        _call_delta(index, call_id=call_id, name=name, arguments=""),
        _call_delta(index, arguments=head),
        _call_delta(index, arguments=tail),
    )


@pytest.fixture
def workspace(monkeypatch, tmp_path):
    root = tmp_path / "workspace"
    monkeypatch.setenv("WORKSPACE_ROOT", str(root))
    return root


async def _say(client, message: str = "summarize kv offloading to a file") -> list:
    resp = await client.post("/api/v1/chat/stream", json={"message": message})
    assert resp.status_code == 200, resp.text
    return frames(resp.text)


async def _spans(pool, kind: str | None = None) -> list:
    rows = await pool.fetch(
        "SELECT kind, name, meta FROM turn_spans ORDER BY started_at, kind"
    )
    return [row for row in rows if kind is None or row["kind"] == kind]


async def test_a_fabricated_write_is_corrected_in_the_record_and_leaves_a_guard_span(
    owner_client, pool, mount_peers, workspace
):
    """The captured live lie, reproduced: the model claims a file write with
    no tool call at all. The reply the operator keeps must carry the
    contradiction, and the guard firing must be visible in the ledger."""
    gateway = ScriptedGateway(
        rounds=((text("I've created a summary file called kv_offloading_summary.md."),),)
    )
    memory = FakeMemory()
    mount_peers(gateway=gateway, memory=memory)

    sent = await _say(owner_client)

    # The turn still succeeds and still says what it said — plus the truth.
    assert await pool.fetchval("SELECT status FROM turns") == "ok"
    stored = await pool.fetchval("SELECT content FROM messages WHERE role = 'assistant'")
    assert stored.startswith("I've created a summary file called kv_offloading_summary.md.")
    assert stored.endswith(guards.CORRECTION_TEXT)

    # The correction reached the stream on its own frame, before [DONE].
    corrections = [f["correction"] for f in sent if isinstance(f, dict) and "correction" in f]
    assert corrections == [guards.CORRECTION_TEXT]
    assert sent[-1] == DONE

    # The guard firing is in the ledger, in the same atomic close, naming the
    # claim it caught and that nothing backed it.
    guard = await _spans(pool, "guard")
    assert len(guard) == 1
    assert guard[0]["name"] == "narration"
    meta = guard[0]["meta"]
    assert meta["backing_span"] is False
    assert meta["claims"] == [{"kind": "wrote_file", "target": "kv_offloading_summary.md"}]

    # No write ever ran — the whole point.
    assert await _spans(pool, "tool") == []

    # What memory remembers is the corrected reply, not the lie.
    await chat.drain_background()
    assert memory.ingests[0]["exchange"]["assistant"].endswith(guards.CORRECTION_TEXT)


async def test_an_honest_write_turn_is_untouched_and_leaves_no_guard_span(
    owner_client, pool, mount_peers, workspace
):
    """A turn that really wrote the file it names ships its success claim
    unchanged: no correction frame, no guard span, the reply byte-identical
    to what it would have been without the guard."""
    reply = "I've created groceries.md with your five items."
    gateway = ScriptedGateway(
        rounds=(
            (
                *streamed_call(
                    0,
                    "call_1",
                    "workspace_write_file",
                    {"path": "groceries.md", "content": "- milk\n- eggs\n- bread\n- tea\n- rice\n"},
                ),
            ),
            (text(reply),),
        )
    )
    mount_peers(gateway=gateway, memory=FakeMemory())

    sent = await _say(owner_client, "make me a five-item grocery list")

    assert not [f for f in sent if isinstance(f, dict) and "correction" in f]
    assert await _spans(pool, "guard") == []
    stored = await pool.fetchval("SELECT content FROM messages WHERE role = 'assistant'")
    assert stored == reply

    # The write really happened, and its span is what backed the claim.
    tool_spans = await _spans(pool, "tool")
    assert [s["name"] for s in tool_spans] == ["workspace_write_file"]
    assert tool_spans[0]["meta"]["ok"] is True
    assert (workspace / "groceries.md").read_text(encoding="utf-8").count("\n") == 5


async def test_a_guard_that_raises_ships_the_reply_uncorrected(
    owner_client, pool, mount_peers, workspace, monkeypatch
):
    """Fail OPEN (IMPORTANT 4): a matcher bug must never turn an honest turn
    into an error or lose its text — the reply ships unchanged, logged."""

    def boom(reply_text, spans, device_names=()):
        raise RuntimeError("matcher bug")

    monkeypatch.setattr(guards, "narration_check", boom)
    reply = "I've created a summary file called kv_offloading_summary.md."
    gateway = ScriptedGateway(rounds=((text(reply),),))
    mount_peers(gateway=gateway, memory=FakeMemory())

    sent = await _say(owner_client)

    assert not [f for f in sent if isinstance(f, dict) and "correction" in f]
    assert not [f for f in sent if isinstance(f, dict) and "error" in f]
    assert await _spans(pool, "guard") == []
    assert await pool.fetchval("SELECT content FROM messages WHERE role='assistant'") == reply
    assert await pool.fetchval("SELECT status FROM turns") == "ok"


# -- S42b (Task 23 fix round 1, I4): an unconfirmed update stays out of memory --
#
# "I updated eval_laptop's agent" beside its correction, ingested, is how
# recall would hand a later turn an update that never took as a fact — the
# said-not-done lane keeps its device-completion turns out of memory for the
# same reason. An honest turn (the update confirmed) is ordinary knowledge.


class _UpdatePlant(machines.GatewayPlant):
    """machine_update's plant answering one outcome: nothing is sent anywhere.
    Every other reader is the real plant's — the paired names the guards read
    come through the plant too (S42b Task 24), from the live registry here."""

    def __init__(self, outcome: str) -> None:
        self.outcome = outcome

    async def update_agent(self, app, name, *, requested_by, facts_sink=None, progress=None):
        return {
            "machine": name,
            "outcome": self.outcome,
            "version": "aaaaaaaaaaaa",
            "from_version": "0a0a0a0a0a0a",
            "reason": None,
            "attempt_id": None,
            "at": None,
            "needs_card": False,
            "in_flight": 0,
            "hub": False,
        }


@pytest.mark.parametrize(("outcome", "ingested"), [("sent", False), ("confirmed", True)])
async def test_an_unconfirmed_update_claim_keeps_the_turn_out_of_memory(
    owner_client, pool, mount_peers, monkeypatch, outcome, ingested
):
    from app import machines

    monkeypatch.setattr(machines, "plant", lambda: _UpdatePlant(outcome))
    reply = "Done — I updated eval_laptop's agent."
    gateway = ScriptedGateway(
        rounds=(
            (*streamed_call(0, "call_1", "machine_update", {"machine": "eval_laptop"}),),
            (text(reply),),
        )
    )
    memory = FakeMemory()
    mount_peers(gateway=gateway, memory=memory)

    sent = await _say(owner_client, "update the agent on eval_laptop now")

    (tool,) = await _spans(pool, "tool")
    assert tool["name"] == "machine_update" and tool["meta"]["ok"] is True
    corrections = [f["correction"] for f in sent if isinstance(f, dict) and "correction" in f]
    stored = await pool.fetchval("SELECT content FROM messages WHERE role = 'assistant'")
    await chat.drain_background()
    if ingested:
        assert corrections == [] and stored == reply
        assert [ingest["exchange"]["assistant"] for ingest in memory.ingests] == [reply]
    else:
        # Nothing is paired in this database. Pin moved (Task 32, L510): the
        # claim's word is read against the machine this turn's update facts
        # name when no paired name holds it, so it names eval_laptop — before,
        # it named no machine, and the sentence said only that no machine_update
        # call confirmed an update (true too, and less exact).
        expected = (
            "Correction: nothing this turn confirmed an update of a machine named eval_laptop — "
            "only the agent reconnecting on the hub's build confirms one."
        )
        assert corrections == [expected]
        assert stored == f"{reply}\n\n{expected}"
        guard = await _spans(pool, "guard")
        assert [g["name"] for g in guard] == ["narration"]
        assert guard[0]["meta"]["claims"] == [{"kind": "updated_machine", "target": "eval_laptop"}]
        assert memory.ingests == []


async def test_a_redirect_that_replaced_the_update_claim_leaves_the_turn_knowledge(
    owner_client, pool, mount_peers
):
    """The memory rule reads the prose that PERSISTS. Here the update claim
    sat beside a fabricated pending approval; the consent redirect stood, so
    its regeneration — vetted by narration too — replaced that prose, and the
    turn is ordinary knowledge again."""
    fabrication = (
        "I updated eval_laptop's agent. That's still awaiting your approval — I can't run it "
        "until you OK it."
    )
    regen = "There is no approval step; nothing is pending."
    gateway = ScriptedGateway(rounds=((text(fabrication),), (text(regen),)))
    memory = FakeMemory()
    mount_peers(gateway=gateway, memory=memory)

    await _say(owner_client, "update the agent on eval_laptop now")

    stored = await pool.fetchval("SELECT content FROM messages WHERE role = 'assistant'")
    assert stored == regen
    guard = {g["name"]: g["meta"] for g in await _spans(pool, "guard")}
    assert guard["narration"]["claims"] == [{"kind": "updated_machine", "target": None}]
    assert guard["consent_claim"]["redirected"] is True
    await chat.drain_background()
    assert [ingest["exchange"]["assistant"] for ingest in memory.ingests] == [regen]


async def _pair(pool, *names: str) -> None:
    """Paired machines, straight into the registry: the update claim's names
    come from the same live read the state guard's do (chat._paired_device_names)."""
    for i, name in enumerate(names):
        await pool.execute(
            "INSERT INTO devices (name, platform, hostname, pubkey) VALUES ($1, 'linux', $1, $2)",
            name,
            f"{i:x}" * 64,
        )


async def test_the_update_claim_names_a_machine_from_the_live_registry(
    owner_client, pool, mount_peers, monkeypatch
):
    """Fix round 1 (I2): chat hands narration the paired names it reads for the
    state guard, so with eval_laptop paired the claim names it — the guard
    span records the machine, and the correction says it."""
    from app import machines

    await _pair(pool, "eval_laptop")
    monkeypatch.setattr(machines, "plant", lambda: _UpdatePlant("sent"))
    reply = "Done — I updated eval_laptop's agent."
    gateway = ScriptedGateway(
        rounds=(
            (*streamed_call(0, "call_1", "machine_update", {"machine": "eval_laptop"}),),
            (text(reply),),
        )
    )
    mount_peers(gateway=gateway, memory=FakeMemory())

    sent = await _say(owner_client, "update the agent on eval_laptop now")

    (guard,) = await _spans(pool, "guard")
    assert guard["meta"]["claims"] == [{"kind": "updated_machine", "target": "eval_laptop"}]
    corrections = [f["correction"] for f in sent if isinstance(f, dict) and "correction" in f]
    assert corrections == [
        "Correction: nothing this turn confirmed an update of a machine named eval_laptop — "
        "only the agent reconnecting on the hub's build confirms one."
    ]


async def test_an_honest_send_of_the_build_after_a_real_update_draws_no_sentence(
    owner_client, pool, mount_peers, monkeypatch
):
    """Task 32 Phase B round 3 (CORE's concern 1): "I sent the hub's build to
    minipc", after a real machine_update on minipc, is the wording an update
    asks for — sent, not confirmed until it reconnects. "sent" read as a
    notification appended "(No device_notify or device_run call ran on minipc
    this turn.)" to it. A send of the build is an install, which the update
    backs: no guard fires, nothing is appended, and the turn is knowledge."""
    from app import machines

    await _pair(pool, "minipc")
    monkeypatch.setattr(machines, "plant", lambda: _UpdatePlant("sent"))
    reply = "I sent the hub's build to minipc. It isn't confirmed until its agent reconnects on it."
    gateway = ScriptedGateway(
        rounds=(
            (*streamed_call(0, "call_1", "machine_update", {"machine": "minipc"}),),
            (text(reply),),
        )
    )
    memory = FakeMemory()
    mount_peers(gateway=gateway, memory=memory)

    sent = await _say(owner_client, "update the agent on minipc now")

    (tool,) = await _spans(pool, "tool")
    assert tool["name"] == "machine_update" and tool["meta"]["ok"] is True
    assert not [f for f in sent if isinstance(f, dict) and "correction" in f]
    assert await _spans(pool, "guard") == []
    assert await pool.fetchval("SELECT content FROM messages WHERE role = 'assistant'") == reply
    await chat.drain_background()
    assert [ingest["exchange"]["assistant"] for ingest in memory.ingests] == [reply]


async def test_the_same_send_with_no_update_draws_exactly_one_sentence(
    owner_client, pool, mount_peers
):
    """…and with no call at all, the same claim draws exactly one correction —
    device_completion's, naming what did not run — and stays out of memory."""
    await _pair(pool, "minipc")
    reply = "I sent the hub's build to minipc."
    memory = FakeMemory()
    mount_peers(gateway=ScriptedGateway(rounds=((text(reply),),)), memory=memory)

    sent = await _say(owner_client, "update the agent on minipc now")

    expected = "(No machine_update or device_run call ran on minipc this turn.)"
    assert [f["correction"] for f in sent if isinstance(f, dict) and "correction" in f] == [
        expected
    ]
    (guard,) = await _spans(pool, "guard")
    assert guard["name"] == "device_completion"
    assert (guard["meta"]["kind"], guard["meta"]["device"]) == ("install", "minipc")
    stored = await pool.fetchval("SELECT content FROM messages WHERE role = 'assistant'")
    assert stored == f"{reply}\n\n{expected}"
    await chat.drain_background()
    assert memory.ingests == []


async def test_a_regeneration_that_names_an_unconfirmed_machine_is_refused(
    owner_client, pool, mount_peers, monkeypatch
):
    """The redirect's vetting reads the same live names (fix round 1, I2): the
    regeneration confirmed minipc's update and then claimed eval_laptop's, so
    narration refuses it and the consent correction stands."""
    from app import machines

    await _pair(pool, "eval_laptop", "minipc")
    monkeypatch.setattr(machines, "plant", lambda: _UpdatePlant("confirmed"))
    gateway = ScriptedGateway(
        rounds=(
            (text("That's still awaiting your approval — I can't run it until you OK it."),),
            (*streamed_call(0, "r1", "machine_update", {"machine": "minipc"}),),
            (text("Done — I updated eval_laptop's agent."),),
        )
    )
    mount_peers(gateway=gateway, memory=FakeMemory())

    await _say(owner_client, "update the agent on eval_laptop now")

    guard = {g["name"]: g["meta"] for g in await _spans(pool, "guard")}
    assert guard["consent_claim"]["redirected"] is False
    assert guard["consent_claim"]["regen_rejected_by"] == "narration"
