"""S47 — her setup tools, called directly. The machine setups' pairing code is
the whole risk: it may reach the card and NOTHING else, and a setup that
cannot be shown sends nothing at all."""

from __future__ import annotations

import json
import uuid
from datetime import UTC, datetime

import pytest

from app import tools
from app.identity import Person
from app.main import app as core_app
from app.tools import setup
from app.tools.base import ToolFailure

CODE = "ABCD2345"
EXPIRES = "2026-09-25T14:10:00+00:00"


def _owner() -> Person:
    return Person(id=uuid.uuid4(), name="jeremy", role="owner")


@pytest.fixture
def status(tmp_path, monkeypatch):
    path = tmp_path / "tailscale.json"
    monkeypatch.setenv("NOVA_STATUS_FILE", str(path))

    def write(**over) -> None:
        now = datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")
        path.write_text(
            json.dumps(
                {
                    "version": 1,
                    "backend_state": "Running",
                    "dns_name": "nova.fake-tailnet.ts.net",
                    "serve_ok": True,
                    "https_cert": True,
                    "written_at": now,
                    **over,
                }
            )
        )

    return write


@pytest.fixture
def minted():
    calls: list = []

    async def fake(person) -> dict:
        calls.append(person)
        return {"code": CODE, "expires_at": EXPIRES}

    token = setup.PAIRING.set(fake)
    yield calls
    setup.PAIRING.reset(token)


async def _call(name, args, *, cards=None, sink=None):
    ctx = tools.context_for(
        core_app, _owner(), facts_sink=sink, card=None if cards is None else cards.append
    )
    return await tools.REGISTRY[name].executor(args, ctx)


async def test_nova_address_states_the_address_and_what_a_device_needs(status):
    status()
    sink: list = []
    said = await _call("nova_address", {}, sink=sink)
    assert "https://nova.fake-tailnet.ts.net" in said
    assert "Tailscale" in said and "/install" in said
    assert "There is no native Nova app yet." in said
    assert sink[0]["nova_address"] == "https://nova.fake-tailnet.ts.net"
    assert sink[0]["checked_now"] is True


async def test_nova_address_without_one_says_why(monkeypatch, tmp_path):
    monkeypatch.setenv("NOVA_STATUS_FILE", str(tmp_path / "absent.json"))
    sink: list = []
    said = await _call("nova_address", {}, sink=sink)
    assert said.startswith("Nova has no address another device can reach:")
    assert sink[0]["nova_address"] is None


@pytest.mark.parametrize(("setup_name", "page"), [("install_pwa", "/install"), ("get_app", "/app")])
async def test_a_phone_setup_sends_one_card_and_mints_nothing(status, minted, setup_name, page):
    status()
    cards: list = []
    sink: list = []
    said = await _call("show_setup_qr", {"setup": setup_name}, cards=cards, sink=sink)
    assert cards == [
        {
            "kind": "setup_qr",
            "setup": setup_name,
            "address": "https://nova.fake-tailnet.ts.net",
            "url": f"https://nova.fake-tailnet.ts.net{page}",
        }
    ]
    assert minted == []
    assert said.startswith("Sent a QR card to the chat.")
    assert sink == [
        {
            "setup": setup_name,
            "address": "https://nova.fake-tailnet.ts.net",
            "url": f"https://nova.fake-tailnet.ts.net{page}",
            "expires_at": None,
            "code_shown": False,
        }
    ]


@pytest.mark.parametrize("setup_name", ["add_machine", "add_model_server"])
async def test_a_machine_setup_puts_the_code_on_the_card_and_nowhere_else(
    status, minted, setup_name
):
    status()
    cards: list = []
    sink: list = []
    said = await _call("show_setup_qr", {"setup": setup_name}, cards=cards, sink=sink)
    assert len(minted) == 1
    assert cards == [
        {
            "kind": "setup_qr",
            "setup": setup_name,
            "address": "https://nova.fake-tailnet.ts.net",
            "url": "https://nova.fake-tailnet.ts.net/add#ABCD-2345",
            "code": "ABCD-2345",
            "expires_at": EXPIRES,
        }
    ]
    # The code is on the card and nowhere she or the trace can read.
    for shape in (CODE, "ABCD-2345"):
        assert shape not in said
        assert shape not in json.dumps(sink)
    assert sink[0]["url"] == "https://nova.fake-tailnet.ts.net/add"
    assert sink[0]["code_shown"] is True
    assert "You do not have the code" in said
    if setup_name == "add_model_server":
        assert "models role (S44), which is not built" in said


async def test_no_address_is_a_stated_cannot_and_nothing_is_minted_or_sent(
    monkeypatch, tmp_path, minted
):
    monkeypatch.setenv("NOVA_STATUS_FILE", str(tmp_path / "absent.json"))
    cards: list = []
    with pytest.raises(ToolFailure, match="cannot show a setup QR: Nova has no address"):
        await _call("show_setup_qr", {"setup": "add_machine"}, cards=cards)
    assert cards == [] and minted == []


async def test_no_chat_is_a_stated_cannot_and_nothing_is_minted(status, minted):
    status()
    with pytest.raises(ToolFailure, match="this turn has no chat to show it in"):
        await _call("show_setup_qr", {"setup": "add_machine"}, cards=None)
    assert minted == []


async def test_a_failed_mint_sends_no_card(status):
    """Review Focus 3: the address was fine, the database was not."""
    status()

    async def broken(person) -> dict:
        raise ConnectionError("database is down")

    token = setup.PAIRING.set(broken)
    try:
        cards: list = []
        with pytest.raises(ToolFailure, match="the pairing code could not be made"):
            await _call("show_setup_qr", {"setup": "add_machine"}, cards=cards)
        assert cards == []
    finally:
        setup.PAIRING.reset(token)


async def test_an_unknown_setup_is_refused_by_name(status, minted):
    status()
    with pytest.raises(ToolFailure, match="setup must be one of"):
        await _call("show_setup_qr", {"setup": "fax_machine"}, cards=[])
