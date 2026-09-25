"""S47 — the rewrite guards on the real route: the stored reply keeps her words,
loses the invented token, and carries the correction; the span records the
fact and never a code."""

from __future__ import annotations

import json
from datetime import UTC, datetime
from types import SimpleNamespace

from app import agents, chat, guards
from tests.conftest import requires_db
from tests.fakes import FakeMemory, ScriptedGateway
from tests.test_chat_card import frames, set_chat_model, text

pytestmark = requires_db

ORIGIN = "https://nova.fake-tailnet.ts.net"


def _status(tmp_path, monkeypatch) -> None:
    path = tmp_path / "tailscale.json"
    path.write_text(
        json.dumps(
            {
                "version": 1,
                "backend_state": "Running",
                "dns_name": "nova.fake-tailnet.ts.net",
                "serve_ok": True,
                "https_cert": True,
                "written_at": datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%SZ"),
            }
        )
    )
    monkeypatch.setenv("NOVA_STATUS_FILE", str(path))


async def _turn(owner_client, mount_peers, reply: str, message: str) -> list:
    mount_peers(gateway=ScriptedGateway(rounds=((text(reply),),)), memory=FakeMemory())
    await set_chat_model(owner_client)
    resp = await owner_client.post("/api/v1/chat/stream", json={"message": message})
    assert resp.status_code == 200, resp.text
    return frames(resp.text)


async def test_an_invented_code_is_rewritten_in_the_record(
    owner_client, pool, mount_peers, tmp_path, monkeypatch
):
    _status(tmp_path, monkeypatch)
    sent = await _turn(
        owner_client, mount_peers, "Your pairing code is ABCD-2345.", "add my laptop"
    )
    assert guards.CODE_CLAIM_CORRECTION in [
        f.get("correction") for f in sent if isinstance(f, dict)
    ]
    stored = await pool.fetchval("SELECT content FROM messages WHERE role = 'assistant'")
    assert "ABCD-2345" not in stored
    assert (
        stored
        == f"Your pairing code is {guards.CODE_ON_THE_CARD}.\n\n{guards.CODE_CLAIM_CORRECTION}"
    )
    # jsonb arrives as Python objects (db.py's codec), so meta is a dict.
    meta = await pool.fetchval(
        "SELECT meta FROM turn_spans WHERE kind = 'guard' AND name = 'code_claim'"
    )
    assert meta == {"count": 1}


async def test_a_wrong_address_is_rewritten_to_the_real_one(
    owner_client, pool, mount_peers, tmp_path, monkeypatch
):
    _status(tmp_path, monkeypatch)
    await _turn(
        owner_client,
        mount_peers,
        "On your tablet, go to http://192.168.0.245:3000.",
        "put you on my tablet",
    )
    stored = await pool.fetchval("SELECT content FROM messages WHERE role = 'assistant'")
    assert "192.168.0.245" not in stored
    assert stored.startswith(f"On your tablet, go to {ORIGIN}.")
    meta = await pool.fetchval(
        "SELECT meta FROM turn_spans WHERE kind = 'guard' AND name = 'address_claim'"
    )
    assert meta == {"rules": ["lan"], "wrong": ["http://192.168.0.245:3000"], "truth": ORIGIN}


def test_a_regeneration_with_an_invented_code_is_refused_by_name():
    turn = SimpleNamespace(spans=[], kind="chat")
    rejected = chat._regen_rejected_by(
        "Done: your pairing code is K7PQ-9XYZ.",
        turn,
        None,
        [],
        "add my laptop",
        agents.nova_persona(),
        agent_names=[],
    )
    assert rejected == "code_claim"
