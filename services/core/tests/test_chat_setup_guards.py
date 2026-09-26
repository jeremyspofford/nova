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
from tests.test_chat_card import frames, set_chat_model, text, whole_call

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
        # I1 (review fix round 1): rule 2 (LAN) now requires the clause to
        # present the URL as Nova's own — "open Nova at" qualifies, "go to"
        # alone no longer does.
        "On your tablet, open Nova at http://192.168.0.245:3000.",
        "put you on my tablet",
    )
    stored = await pool.fetchval("SELECT content FROM messages WHERE role = 'assistant'")
    assert "192.168.0.245" not in stored
    assert stored.startswith(f"On your tablet, open Nova at {ORIGIN}.")
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


# -- I6 (review fix round 1): chat.py's address reads are fail-open ---------


def test_rewrite_class_claims_is_fail_open_when_address_raises(monkeypatch):
    def boom(*_a, **_k):
        raise RuntimeError("status file exploded")

    monkeypatch.setattr(chat.network, "address", boom)
    found = chat._rewrite_class_claims("Your pairing code is ABCD-2345.", "add my laptop")
    assert [name for name, _ in found] == ["code_claim"]


def test_regen_rejected_by_is_fail_open_when_address_raises(monkeypatch):
    def boom(*_a, **_k):
        raise RuntimeError("status file exploded")

    monkeypatch.setattr(chat.network, "address", boom)
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


# -- D (review fix round 2): a relay of the tool's own refusal --------------


def _no_address_env(tmp_path, monkeypatch) -> None:
    monkeypatch.setenv("NOVA_STATUS_FILE", str(tmp_path / "absent-tailscale.json"))


async def _failed_show_setup_qr_turn(owner_client, mount_peers, reply: str) -> list:
    gateway = ScriptedGateway(
        rounds=(
            (whole_call("call_1", "show_setup_qr", {"setup": "install_pwa"}),),
            (text(reply),),
        )
    )
    mount_peers(gateway=gateway, memory=FakeMemory())
    await set_chat_model(owner_client)
    resp = await owner_client.post("/api/v1/chat/stream", json={"message": "show me a QR code"})
    assert resp.status_code == 200, resp.text
    return frames(resp.text)


async def test_a_relayed_refusal_beside_a_failed_call_is_not_corrected(
    owner_client, pool, mount_peers, tmp_path, monkeypatch
):
    _no_address_env(tmp_path, monkeypatch)
    reply = (
        "I can't show a setup QR code: Nova has no address another device can reach - "
        "the tailnet sidecar is NeedsLogin, not Running."
    )
    sent = await _failed_show_setup_qr_turn(owner_client, mount_peers, reply)
    corrections = [f["correction"] for f in sent if isinstance(f, dict) and "correction" in f]
    assert corrections == [], corrections
    stored = await pool.fetchval("SELECT content FROM messages WHERE role = 'assistant'")
    assert stored == reply
    span_count = await pool.fetchval(
        "SELECT count(*) FROM turn_spans WHERE kind = 'guard' AND name = 'capability_claim'"
    )
    assert span_count == 0


async def test_a_leading_qualifier_relayed_refusal_is_not_corrected(
    owner_client, pool, mount_peers, tmp_path, monkeypatch
):
    _no_address_env(tmp_path, monkeypatch)
    reply = (
        "Right now I can't show you a setup QR code: Nova has no address another device can reach."
    )
    sent = await _failed_show_setup_qr_turn(owner_client, mount_peers, reply)
    corrections = [f["correction"] for f in sent if isinstance(f, dict) and "correction" in f]
    assert corrections == [], corrections
    stored = await pool.fetchval("SELECT content FROM messages WHERE role = 'assistant'")
    assert stored == reply
    span_count = await pool.fetchval(
        "SELECT count(*) FROM turn_spans WHERE kind = 'guard' AND name = 'capability_claim'"
    )
    assert span_count == 0


async def test_the_same_relay_is_corrected_when_the_tool_was_not_called(
    owner_client, pool, mount_peers, tmp_path, monkeypatch
):
    # The control: nothing ran this turn, so nothing failed — the guard is
    # UNCHANGED, and this exact reply is still the false capability denial
    # it always was.
    _no_address_env(tmp_path, monkeypatch)
    reply = (
        "I can't show a setup QR code: Nova has no address another device can reach - "
        "the tailnet sidecar is NeedsLogin, not Running."
    )
    sent = await _turn(owner_client, mount_peers, reply, "show me a QR code")
    corrections = [f["correction"] for f in sent if isinstance(f, dict) and "correction" in f]
    assert corrections != []
    span_count = await pool.fetchval(
        "SELECT count(*) FROM turn_spans WHERE kind = 'guard' AND name = 'capability_claim'"
    )
    assert span_count == 1


# -- D clarified (review fix round 3): a refused markup call is not attempted


FETCH_URL_MARKUP = (
    "<atem:function_calls>\n"
    '<atem:invoke name="fetch_url">\n'
    '<atem:parameter name="url">https://example.com</atem:parameter>\n'
    "</atem:invoke>\n"
    "</atem:function_calls>"
)


async def test_a_refused_markup_call_is_not_a_failed_call(owner_client, pool, mount_peers):
    """ "Called this turn and did not succeed" means ATTEMPTED as
    guards._attempted defines it (ruling D clarified, round 3): a call
    written as markup and refused (chat._refuse_call, never dispatched) is
    not a call she made this turn, so it must not silence a capability
    correction beside it — exactly like a tool never called at all."""
    gateway = ScriptedGateway(
        rounds=(
            (text(FETCH_URL_MARKUP),),
            (text("I cannot access external websites."),),
        )
    )
    mount_peers(gateway=gateway, memory=FakeMemory())
    await set_chat_model(owner_client)
    resp = await owner_client.post(
        "/api/v1/chat/stream", json={"message": "what does example.com say?"}
    )
    assert resp.status_code == 200, resp.text
    sent = frames(resp.text)
    corrections = [f["correction"] for f in sent if isinstance(f, dict) and "correction" in f]
    assert corrections != [], "the refused markup call wrongly silenced the correction"
    span_count = await pool.fetchval(
        "SELECT count(*) FROM turn_spans WHERE kind = 'guard' AND name = 'capability_claim'"
    )
    assert span_count == 1
    tool_meta = await pool.fetchval(
        "SELECT meta FROM turn_spans WHERE kind = 'tool' AND name = 'fetch_url'"
    )
    assert tool_meta["refused_markup_as_text"] is True
    assert tool_meta["ok"] is False


# Round 4's two DB-free pins — the `_failed_tool_names` "unasked" pin and the
# owner-typed /add pin — moved to tests/test_setup_guards.py in review fix
# round 5, so they run without a database (this module's pytestmark skips
# every test in it when TEST_DATABASE_URL is unset).
