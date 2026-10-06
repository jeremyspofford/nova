"""S47 — a machine card through the real route, with a real mint: the code
reaches the card frame and the pairing_codes table (as its hash), and nothing
else — not the model's next round, not a span, not a message, not a log
line, not a reload.

S42b (Task 19): the card now carries the hub build's command for each OS,
filled with that code, so it needs a build (the `dist` fixture, F4) — and the
commands, which hold the code, reach the card frame only. A re-pair card made
from the chat binds a real code to the paired machine's own row."""

from __future__ import annotations

import asyncio
import json
import logging
import re
from datetime import UTC, datetime

import pytest

from app import chat, devices, platform_walks
from tests.conftest import requires_db
from tests.fakes import FakeMemory, ScriptedGateway
from tests.test_agent_dist import dist  # noqa: F401 — the fake build fixture
from tests.test_chat_card import frames, set_chat_model, text, whole_call
from tests.test_devices_ws import _enroll

pytestmark = requires_db

CODE_SHAPE = re.compile(r"^[2-9A-HJKMNP-Z]{4}-[2-9A-HJKMNP-Z]{4}$")
ORIGIN = "https://nova.fake-tailnet.ts.net"


def _tailnet(tmp_path, monkeypatch) -> None:
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


async def _everywhere_else(pool, sent: list, gateway: ScriptedGateway) -> list[str]:
    """Every place the code must NOT be: the other frames, what the model was
    sent, every span, every message, and the stored hashes themselves."""
    return [
        json.dumps([f for f in sent if not (isinstance(f, dict) and "card" in f)]),
        json.dumps(gateway.payloads),
        *[row["m"] for row in await pool.fetch("SELECT meta::text AS m FROM turn_spans")],
        *[row["c"] for row in await pool.fetch("SELECT content AS c FROM messages")],
        *[row["h"] for row in await pool.fetch("SELECT code_hash AS h FROM pairing_codes")],
    ]


@pytest.mark.usefixtures("dist")
async def test_a_real_code_reaches_the_card_and_its_hash_and_nothing_else(
    owner_client, pool, mount_peers, tmp_path, monkeypatch, caplog
):
    # Review fix round 1: a logger.debug of the frame anywhere on the card
    # path would leak every code and keep the rest of this test green — the
    # containment check below is the only thing that would catch it.
    caplog.set_level(logging.DEBUG)
    _tailnet(tmp_path, monkeypatch)
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
    assert cards[0]["url"] == f"{ORIGIN}/add#{code}"
    # S42b: each OS's command carries the very code minted, on the card.
    assert set(cards[0]["commands"]) == {"linux", "macos", "windows"}
    for command in cards[0]["commands"].values():
        assert f"--hub {ORIGIN} --code {code}" in command
    # The database holds its hash, never the code.
    assert (
        await pool.fetchval(
            "SELECT count(*) FROM pairing_codes WHERE code_hash = $1", devices.hash_code(code)
        )
        == 1
    )
    bare = code.replace("-", "")
    for blob in await _everywhere_else(pool, sent, gateway):
        assert code not in blob and bare not in blob

    # Nor the log: drain whatever background work the turn fired (the pool
    # fixture's own teardown does this too, but that runs after the test has
    # already asserted, which is too late) before reading the captured log.
    await asyncio.wait_for(chat.drain_background(), timeout=15)
    assert code not in caplog.text and bare not in caplog.text

    # The reload redraws the card without the code (Review Focus 4). S42b:
    # unchanged for a card that names no machine and no OS — a fact's None
    # machine, for_os and walk are left out, and the commands (which carry
    # the code) are never in a fact at all.
    conversation = (await owner_client.get("/api/v1/conversations/active")).json()["id"]
    rows = (await owner_client.get(f"/api/v1/conversations/{conversation}/messages")).json()[
        "messages"
    ]
    nova = [row for row in rows if row["role"] == "assistant"][-1]
    assert nova["cards"] == [
        {
            "kind": "setup_qr",
            "setup": "add_machine",
            "address": ORIGIN,
            "url": f"{ORIGIN}/add",
            "code_shown": True,
            "expires_at": cards[0]["expires_at"],
        }
    ]
    assert code not in json.dumps(rows) and bare not in json.dumps(rows)


@pytest.mark.usefixtures("dist")
async def test_a_repair_card_from_the_chat_binds_a_real_code_to_that_machine(
    owner_client, pool, mount_peers, tmp_path, monkeypatch, caplog
):
    """Re-pair from the chat (S42b decision 4): she mints the re-pair code
    through her own tool — nothing asks the owner to approve anything — and
    the real code is bound to the paired machine's row, on the card only."""
    caplog.set_level(logging.DEBUG)
    _tailnet(tmp_path, monkeypatch)
    device_id, _ = await _enroll(pool, name="OFFICE-PC", platform="windows")
    gateway = ScriptedGateway(
        rounds=(
            (
                whole_call(
                    "call_1", "show_setup_qr", {"setup": "add_machine", "machine": "OFFICE-PC"}
                ),
            ),
            (text("The card is in the chat: run its Windows line on the office PC."),),
        )
    )
    mount_peers(gateway=gateway, memory=FakeMemory())
    await set_chat_model(owner_client)
    resp = await owner_client.post("/api/v1/chat/stream", json={"message": "re-pair my office PC"})
    assert resp.status_code == 200, resp.text
    sent = frames(resp.text)

    [card] = [f["card"] for f in sent if isinstance(f, dict) and "card" in f]
    code = card["code"]
    assert CODE_SHAPE.match(code)
    assert card["machine"] == "OFFICE-PC" and card["for_os"] == "windows"
    assert f"--hub {ORIGIN} --code {code}" in card["commands"]["windows"]
    # The real code is bound to that machine's own row (its hash, single use).
    bound = await pool.fetchrow(
        "SELECT device_id, used_at FROM pairing_codes WHERE code_hash = $1",
        devices.hash_code(code),
    )
    assert bound is not None and bound["device_id"] == device_id and bound["used_at"] is None

    bare = code.replace("-", "")
    for blob in await _everywhere_else(pool, sent, gateway):
        assert code not in blob and bare not in blob
    await asyncio.wait_for(chat.drain_background(), timeout=15)
    assert code not in caplog.text and bare not in caplog.text

    # The reload names the machine, its OS and that OS's walk — no code, no
    # command.
    conversation = (await owner_client.get("/api/v1/conversations/active")).json()["id"]
    rows = (await owner_client.get(f"/api/v1/conversations/{conversation}/messages")).json()[
        "messages"
    ]
    nova = [row for row in rows if row["role"] == "assistant"][-1]
    assert nova["cards"] == [
        {
            "kind": "setup_qr",
            "setup": "add_machine",
            "address": ORIGIN,
            "url": f"{ORIGIN}/add",
            "code_shown": True,
            "expires_at": card["expires_at"],
            "machine": "OFFICE-PC",
            "for_os": "windows",
            "walk": platform_walks.status("windows"),
        }
    ]
    assert code not in json.dumps(rows) and bare not in json.dumps(rows)
