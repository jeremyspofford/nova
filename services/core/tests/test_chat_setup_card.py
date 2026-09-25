"""S47 — a machine card through the real route, with a real mint: the code
reaches the card frame and the pairing_codes table (as its hash), and nothing
else — not the model's next round, not a span, not a message, not a reload."""

from __future__ import annotations

import json
import re
from datetime import UTC, datetime

from app import devices
from tests.conftest import requires_db
from tests.fakes import FakeMemory, ScriptedGateway
from tests.test_chat_card import frames, set_chat_model, text, whole_call

pytestmark = requires_db

CODE_SHAPE = re.compile(r"^[2-9A-HJKMNP-Z]{4}-[2-9A-HJKMNP-Z]{4}$")


async def test_a_real_code_reaches_the_card_and_its_hash_and_nothing_else(
    owner_client, pool, mount_peers, tmp_path, monkeypatch
):
    status = tmp_path / "tailscale.json"
    status.write_text(
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
    monkeypatch.setenv("NOVA_STATUS_FILE", str(status))
    gateway = ScriptedGateway(
        rounds=(
            (whole_call("call_1", "show_setup_qr", {"setup": "add_machine"}),),
            (text("Scan the card with your phone, or open its link on the laptop."),),
        )
    )
    mount_peers(gateway=gateway, memory=FakeMemory())
    await set_chat_model(owner_client)
    resp = await owner_client.post("/api/v1/chat/stream", json={"message": "add my laptop"})
    assert resp.status_code == 200, resp.text
    sent = frames(resp.text)

    cards = [f["card"] for f in sent if isinstance(f, dict) and "card" in f]
    assert len(cards) == 1
    code = cards[0]["code"]
    assert CODE_SHAPE.match(code)
    assert cards[0]["url"] == f"https://nova.fake-tailnet.ts.net/add#{code}"
    # The database holds its hash, never the code.
    assert (
        await pool.fetchval(
            "SELECT count(*) FROM pairing_codes WHERE code_hash = $1", devices.hash_code(code)
        )
        == 1
    )
    bare = code.replace("-", "")
    everywhere_else = [
        json.dumps([f for f in sent if not (isinstance(f, dict) and "card" in f)]),
        json.dumps(gateway.payloads),
        *[row["m"] for row in await pool.fetch("SELECT meta::text AS m FROM turn_spans")],
        *[row["c"] for row in await pool.fetch("SELECT content AS c FROM messages")],
        *[row["h"] for row in await pool.fetch("SELECT code_hash AS h FROM pairing_codes")],
    ]
    for blob in everywhere_else:
        assert code not in blob and bare not in blob

    # The reload redraws the card without the code (Review Focus 4).
    conversation = (await owner_client.get("/api/v1/conversations/active")).json()["id"]
    rows = (await owner_client.get(f"/api/v1/conversations/{conversation}/messages")).json()[
        "messages"
    ]
    nova = [row for row in rows if row["role"] == "assistant"][-1]
    assert nova["cards"] == [
        {
            "kind": "setup_qr",
            "setup": "add_machine",
            "address": "https://nova.fake-tailnet.ts.net",
            "url": "https://nova.fake-tailnet.ts.net/add",
            "code_shown": True,
            "expires_at": cards[0]["expires_at"],
        }
    ]
    assert code not in json.dumps(rows) and bare not in json.dumps(rows)
