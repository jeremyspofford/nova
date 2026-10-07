"""S47 — her setup tools, called directly. The machine setups' pairing code is
the whole risk: it may reach the card and NOTHING else, and a setup that
cannot be shown sends nothing at all.

S42b (Task 19): a machine card carries one command per OS for the hub's own
agent build, so it needs that build — read BEFORE any code is minted, so no
code is ever made for a card that cannot carry a command — and it can
re-pair a paired machine (`machine`, a code bound to that row) or open on one
OS (`for_os`), saying where that OS has been walked."""

from __future__ import annotations

import json
import re
import uuid
from datetime import UTC, datetime

import pytest

from app import agent_card, agent_dist, devices, platform_walks, tools
from app.identity import Person
from app.main import app as core_app
from app.tools import setup
from app.tools.base import ToolFailure
from tests.conftest import requires_db
from tests.test_agent_dist import VERSION, dist  # noqa: F401 — the fake build fixture
from tests.test_devices_ws import _enroll

CODE = "ABCD2345"
EXPIRES = "2026-09-25T14:10:00+00:00"
ORIGIN = "https://nova.fake-tailnet.ts.net"


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
    """The pairing seam, faked: each call is recorded as (person, keywords) —
    S42b's seam is called (person, device_id=...), device_id set for a
    re-pair card."""
    calls: list = []

    async def fake(person, **kw) -> dict:
        calls.append((person, kw))
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
@pytest.mark.usefixtures("dist")
async def test_a_machine_setup_puts_the_code_on_the_card_and_nowhere_else(
    status, minted, setup_name
):
    status()
    cards: list = []
    sink: list = []
    said = await _call("show_setup_qr", {"setup": setup_name}, cards=cards, sink=sink)
    assert len(minted) == 1 and minted[0][1] == {"device_id": None}
    # S42b (Task 19, F4 — a moved pin): the card gains the hub build's command
    # for each OS, filled with the code; where each OS was walked; each OS's
    # note; the build's version; and which machine and OS it is for (none
    # here). Six keys -> twelve.
    assert cards == [
        {
            "kind": "setup_qr",
            "setup": setup_name,
            "address": ORIGIN,
            "url": f"{ORIGIN}/add#ABCD-2345",
            "code": "ABCD-2345",
            "expires_at": EXPIRES,
            "machine": None,
            "for_os": None,
            "commands": agent_card.commands(agent_dist.current(), origin=ORIGIN, code="ABCD-2345"),
            "walks": platform_walks.statuses(),
            "notes": agent_card.notes(),
            "version": VERSION,
        }
    ]
    # The code is on the card and nowhere she or the trace can read.
    for shape in (CODE, "ABCD-2345"):
        assert shape not in said
        assert shape not in json.dumps(sink)
    # Pinned whole (it was two keys): the span's fact carries no code and no
    # command — the commands are filled with the code.
    assert sink == [
        {
            "setup": setup_name,
            "address": ORIGIN,
            "url": f"{ORIGIN}/add",
            "expires_at": EXPIRES,
            "code_shown": True,
            "machine": None,
            "for_os": None,
            "walk": None,
        }
    ]
    assert "You do not have the code" in said
    if setup_name == "add_model_server":
        assert "models role (S44), which is not built" in said


@pytest.mark.parametrize("ttl_s", [devices.PAIRING_CODE_TTL_SECONDS, 15 * 60])
@pytest.mark.usefixtures("dist")
async def test_her_result_states_the_expiry_relatively_never_as_a_clock_time(
    status, minted, monkeypatch, ttl_s
):
    """Final review: the card shows the expiry in the browser's local time, so a
    clock time in her result (UTC) would disagree with it. She says how long
    the code lasts — read from the real TTL, never a copy of it."""
    status()
    monkeypatch.setattr(devices, "PAIRING_CODE_TTL_SECONDS", ttl_s)
    said = await _call("show_setup_qr", {"setup": "add_machine"}, cards=[])
    assert f"a one-time code that expires in {ttl_s // 60} minutes." in said
    assert "UTC" not in said
    assert re.search(r"\b\d{1,2}:\d{2}\b", said) is None, said


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


@pytest.mark.usefixtures("dist")
async def test_a_failed_mint_sends_no_card(status, caplog):
    """Review Focus 3: the address was fine, the database was not.

    Review fix round 1: only the exception TYPE reaches her (ToolFailure's
    message); the cause itself must still reach the log, or an operator
    debugging a run of failed pairings has nothing to go on.

    S42b: the build is read before the mint, so this card has its build and
    fails at the mint itself."""
    status()

    async def broken(person, **kw) -> dict:
        raise ConnectionError("database is down")

    token = setup.PAIRING.set(broken)
    try:
        cards: list = []
        with caplog.at_level("ERROR", logger="core"):
            with pytest.raises(ToolFailure, match="the pairing code could not be made"):
                await _call("show_setup_qr", {"setup": "add_machine"}, cards=cards)
        assert cards == []
        # The cause is logged in full — safe because mint_pairing_code never
        # hands Postgres anything but the code's hash, a uuid and an int.
        assert "database is down" in caplog.text
    finally:
        setup.PAIRING.reset(token)


async def test_an_unknown_setup_is_refused_by_name(status, minted):
    status()
    with pytest.raises(ToolFailure, match="setup must be one of"):
        await _call("show_setup_qr", {"setup": "fax_machine"}, cards=[])


# -- S42b (Task 19): the card's command per OS, re-pair, the walk -------------


@pytest.mark.usefixtures("dist")
async def test_a_machine_card_carries_a_command_per_os_with_the_code(status, minted):
    status()
    cards: list = []
    said = await _call("show_setup_qr", {"setup": "add_machine"}, cards=cards)
    card = cards[0]
    assert set(card["commands"]) == {"linux", "macos", "windows"}
    for text in card["commands"].values():
        assert "--code ABCD-2345" in text and ORIGIN in text
    assert "(Linux today)" not in said
    assert "checks its sha256" in said and "You do not have the code" in said
    # With no OS named, she reads every OS's walk.
    for walk in platform_walks.statuses().values():
        assert walk in said


@requires_db
@pytest.mark.usefixtures("dist")
async def test_a_repair_card_carries_the_code_on_the_card_only(status, minted, pool):
    status()
    device_id, _ = await _enroll(pool, name="OFFICE-PC", platform="windows")
    cards: list = []
    sink: list = []
    said = await _call(
        "show_setup_qr", {"setup": "add_machine", "machine": "OFFICE-PC"}, cards=cards, sink=sink
    )
    assert minted[0][1] == {"device_id": device_id}
    assert cards[0]["machine"] == "OFFICE-PC" and cards[0]["for_os"] == "windows"
    assert "re-pairs OFFICE-PC" in said
    assert platform_walks.status("windows") in said
    assert "ABCD-2345" not in said, "the code reaches the card only"
    assert "ABCD-2345" not in repr(sink), "the code never reaches the span"
    assert sink[0]["machine"] == "OFFICE-PC" and sink[0]["walk"] == platform_walks.status("windows")


@pytest.mark.usefixtures("dist")
async def test_a_card_for_a_mac_says_it_is_not_walked(status, minted):
    status()
    cards: list = []
    said = await _call("show_setup_qr", {"setup": "add_machine", "for_os": "macos"}, cards=cards)
    assert "not walked on a Mac" in said
    assert cards[0]["for_os"] == "macos"


@pytest.mark.usefixtures("dist")
async def test_for_os_wsl_says_the_windows_command_covers_wsl(status, minted):
    status()
    cards: list = []
    said = await _call("show_setup_qr", {"setup": "add_machine", "for_os": "wsl"}, cards=cards)
    assert cards[0]["for_os"] == "wsl" and "the Windows command covers WSL" in said


@requires_db
@pytest.mark.usefixtures("dist")
async def test_a_repair_card_for_an_unknown_machine_names_the_paired_ones(status, minted, pool):
    status()
    await _enroll(pool, name="TRAVEL-MACBOOK", platform="darwin")
    cards: list = []
    with pytest.raises(ToolFailure, match="the paired machines are: TRAVEL-MACBOOK") as refused:
        await _call("show_setup_qr", {"setup": "add_machine", "machine": "nope"}, cards=cards)
    # Her next step is her own tool's, never a step handed to the owner.
    assert "omit machine" in str(refused.value)
    assert cards == [] and minted == []


@requires_db
@pytest.mark.usefixtures("dist")
async def test_a_repair_card_with_no_machine_paired_says_so(status, minted, pool):
    status()
    with pytest.raises(ToolFailure, match="no machine is paired yet"):
        await _call("show_setup_qr", {"setup": "add_machine", "machine": "OFFICE-PC"}, cards=[])
    assert minted == []


async def test_no_agent_build_means_no_pairing_card(status, minted, tmp_path, monkeypatch):
    """Build read before mint (F4): with no build to install, nothing is sent
    and NO code is minted — a mint before the read would leave one behind."""
    status()
    monkeypatch.setenv("NOVA_AGENT_DIST_DIR", str(tmp_path / "empty"))
    cards: list = []
    with pytest.raises(ToolFailure, match="no agent build"):
        await _call("show_setup_qr", {"setup": "add_machine"}, cards=cards)
    assert cards == [] and minted == []


async def test_a_build_no_command_can_carry_mints_no_code(status, minted, monkeypatch):
    """The commands before the code (F4): whatever refuses a command refuses
    it before any code exists — here a build whose sum a command cannot carry
    as it stands (agent_dist never serves one; agent_card's guard is the line
    that refuses it)."""
    status()
    files = {
        agent_dist.file_key(goos, arch): {
            "name": agent_dist.file_name(goos, arch),
            "sha256": "a" * 64,
            "size": 1,
        }
        for goos, arch in agent_dist.TARGETS
    }
    files["windows-arm64"]["sha256"] = "'; Remove-Item -Recurse ~; '"

    async def read() -> agent_dist.Build:
        return agent_dist.Build(version="aaaaaaaaaaaa", built_at="", go="", files=files)

    monkeypatch.setattr(agent_dist, "read", read)
    cards: list = []
    with pytest.raises(ValueError, match="not one a command can carry"):
        await _call("show_setup_qr", {"setup": "add_machine"}, cards=cards)
    assert cards == [] and minted == []


@requires_db
async def test_no_agent_build_leaves_no_code_in_the_database(status, pool, tmp_path, monkeypatch):
    """The same ordering through the REAL mint: no pairing_codes row is
    written for a card that could not carry a command."""
    status()
    monkeypatch.setenv("NOVA_AGENT_DIST_DIR", str(tmp_path / "empty"))
    owner = await pool.fetchval(
        "INSERT INTO people (name, role) VALUES ('owner-t19', 'owner') RETURNING id"
    )
    ctx = tools.context_for(
        core_app, Person(id=owner, name="owner-t19", role="owner"), card=[].append
    )
    with pytest.raises(ToolFailure, match="no agent build"):
        await tools.REGISTRY["show_setup_qr"].executor({"setup": "add_machine"}, ctx)
    assert await pool.fetchval("SELECT count(*) FROM pairing_codes") == 0


@pytest.mark.usefixtures("dist")
async def test_a_repair_the_registry_refuses_is_said_in_its_words(status):
    """A machine revoked (or found to carry the engine's name) between the
    lookup and the mint: the registry's stated refusal, as given — never
    "the code could not be made (DeviceRefused)"."""
    status()

    async def refused(person, **kw) -> dict:
        raise devices.DeviceRefused(
            "OFFICE-PC was revoked — a revoked machine cannot be re-paired; pair it again "
            "with a new code",
            status_code=409,
        )

    token = setup.PAIRING.set(refused)
    try:
        cards: list = []
        with pytest.raises(ToolFailure, match="cannot show a pairing card: OFFICE-PC was revoked"):
            await _call("show_setup_qr", {"setup": "add_machine"}, cards=cards)
        assert cards == []
    finally:
        setup.PAIRING.reset(token)


@pytest.mark.parametrize("setup_name", ["install_pwa", "get_app"])
@pytest.mark.parametrize("extra", [{"machine": "OFFICE-PC"}, {"for_os": "macos"}])
async def test_machine_and_for_os_are_only_for_a_machine_setup(status, minted, setup_name, extra):
    status()
    cards: list = []
    with pytest.raises(ToolFailure, match="go with a machine setup"):
        await _call("show_setup_qr", {"setup": setup_name, **extra}, cards=cards)
    assert cards == [] and minted == []


@pytest.mark.usefixtures("dist")
async def test_an_os_the_card_has_no_command_for_is_refused(status, minted):
    status()
    cards: list = []
    with pytest.raises(ToolFailure, match="for_os must be one of linux, macos, windows, wsl"):
        await _call("show_setup_qr", {"setup": "add_machine", "for_os": "freebsd"}, cards=cards)
    assert cards == [] and minted == []
