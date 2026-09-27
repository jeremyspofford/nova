"""S47 follow-up (docs/plans/rebuild/s47/auto-card.md §2-§3): core sends the
setup card itself when the owner's message plainly asks for one of the four
setups, through the real stream route and the fixtures
test_chat_setup_card.py uses.

What these pin:

  * the card goes out BEFORE her first round, on a `show_setup_qr` tool span
    marked `requested_by_owner`, with an activity frame, and round 1's payload
    carries the one factual line saying what was sent;
  * her own call for the same setup does not dispatch again — no second card,
    no second code — and is answered with the first result, on a span marked
    `already_sent`; a call for a DIFFERENT setup runs as it always did;
  * a machine request mints one real code, and that code reaches the card and
    nothing else: not another frame, not the model, not a span, not a message,
    not the log, not a reload;
  * nothing happens for a message that asks for no setup, for a turn with no
    chat to show a card in (the scheduler's shape), or because of what memory
    or an earlier turn said;
  * a mint that fails is stated in the line and on an ok=False span, and no
    card is sent — and her own call for it still runs, because nothing was
    sent for it to repeat.
"""

from __future__ import annotations

import asyncio
import json
import logging
from datetime import UTC, datetime
from pathlib import Path

import pytest

from app import chat, conversations, devices, skills, traces
from app.identity import Person
from app.main import app
from app.tools import setup as setup_tools
from tests.conftest import requires_db
from tests.fakes import FakeMemory, ScriptedGateway
from tests.test_chat_agents import _create
from tests.test_chat_card import frames, set_chat_model, text, whole_call
from tests.test_chat_setup_card import CODE_SHAPE

pytestmark = requires_db

ORIGIN = "https://nova.fake-tailnet.ts.net"
PHONE = "How do I put you on my phone?"
LAPTOP = "Add my laptop so you can control it."
MODEL = "qwen3:8b"


@pytest.fixture
def tailnet(tmp_path, monkeypatch):
    """A status file that states an address another device can reach."""
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


async def _stream(owner_client, mount_peers, message: str, *rounds, memory=None):
    gateway = ScriptedGateway(rounds=rounds)
    mount_peers(gateway=gateway, memory=memory or FakeMemory())
    await set_chat_model(owner_client)
    resp = await owner_client.post("/api/v1/chat/stream", json={"message": message})
    assert resp.status_code == 200, resp.text
    return frames(resp.text), gateway


def _cards(sent: list) -> list[dict]:
    return [f["card"] for f in sent if isinstance(f, dict) and "card" in f]


def _activity(sent: list, tool: str = "show_setup_qr") -> list[str]:
    return [
        f["activity"]["status"]
        for f in sent
        if isinstance(f, dict) and "activity" in f and f["activity"]["tool"] == tool
    ]


async def _setup_spans(pool) -> list[dict]:
    rows = await pool.fetch(
        "SELECT meta FROM turn_spans WHERE kind = 'tool' AND name = 'show_setup_qr' "
        "ORDER BY started_at, id"
    )
    return [row["meta"] for row in rows]


def _system_text(payload: dict) -> str:
    return "\n".join(m["content"] for m in payload["messages"] if m["role"] == "system")


def _asked_for_a_setup(payload: dict) -> bool:
    """Whether any setup's factual line reached this payload, read off the
    line's own words rather than a copy of them."""
    system = _system_text(payload)
    return any(
        chat.requested_card_line(setup, "", ok=ok).split(":", 1)[0] in system
        for setup in setup_tools.SETUPS
        for ok in (True, False)
    )


async def _reloaded_cards(owner_client) -> list[dict]:
    conversation = (await owner_client.get("/api/v1/conversations/active")).json()["id"]
    rows = (await owner_client.get(f"/api/v1/conversations/{conversation}/messages")).json()[
        "messages"
    ]
    return [row for row in rows if row["role"] == "assistant"][-1]["cards"]


# -- the card goes out before she is asked anything ---------------------------


async def test_a_plain_request_sends_the_card_before_her_first_round(
    owner_client, pool, mount_peers, tailnet
):
    sent, gateway = await _stream(
        owner_client, mount_peers, PHONE, (text("Scan it with your phone's camera."),)
    )

    assert _cards(sent) == [
        {"kind": "setup_qr", "setup": "install_pwa", "address": ORIGIN, "url": f"{ORIGIN}/install"}
    ]
    first_card = next(i for i, f in enumerate(sent) if isinstance(f, dict) and "card" in f)
    first_delta = next(i for i, f in enumerate(sent) if isinstance(f, dict) and "t" in f)
    assert first_card < first_delta
    assert _activity(sent) == ["start", "ok"]

    (span,) = await _setup_spans(pool)
    assert span["requested_by_owner"] is True
    assert span["ok"] is True
    assert span["args_redacted"] == {"setup": "install_pwa"}
    assert span["result"].startswith("Sent a QR card to the chat.")
    assert span["result_head"] == span["result"][: chat.SPAN_RESULT_HEAD_CHARS]
    assert span["facts"] == [
        {
            "setup": "install_pwa",
            "address": ORIGIN,
            "url": f"{ORIGIN}/install",
            "expires_at": None,
            "code_shown": False,
        }
    ]
    assert "already_sent" not in span and "error" not in span

    # Round 1 is told what was sent, in the tool's own words.
    line = chat.requested_card_line("install_pwa", span["result"], ok=True)
    assert line in _system_text(gateway.payloads[0])
    assert span["result"] in line
    # The reply is persisted as she wrote it, and a reload redraws the card.
    assert await _reloaded_cards(owner_client) == [
        {
            "kind": "setup_qr",
            "setup": "install_pwa",
            "address": ORIGIN,
            "url": f"{ORIGIN}/install",
            "code_shown": False,
        }
    ]


# -- she cannot send it twice ---------------------------------------------------


async def test_her_own_call_for_the_card_core_sent_is_answered_not_run(
    owner_client, pool, mount_peers, tailnet
):
    sent, gateway = await _stream(
        owner_client,
        mount_peers,
        PHONE,
        (whole_call("call_1", "show_setup_qr", {"setup": "install_pwa"}),),
        (text("It is in the chat."),),
    )

    assert len(_cards(sent)) == 1
    assert _activity(sent) == ["start", "ok", "start", "ok"]
    first, again = await _setup_spans(pool)
    assert first["requested_by_owner"] is True
    answered = f"{first['result']} {chat.ALREADY_SENT_MARK}"
    assert again == {
        "args_redacted": {"setup": "install_pwa"},
        "ok": True,
        "result_head": answered[: chat.SPAN_RESULT_HEAD_CHARS],
        "already_sent": True,
    }
    # Her next round reads the first result, marked, as her call's result.
    tool_results = [m for m in gateway.payloads[1]["messages"] if m["role"] == "tool"]
    assert tool_results == [{"role": "tool", "tool_call_id": "call_1", "content": answered}]
    # One card on the reload too: the answered call carries no facts.
    assert len(await _reloaded_cards(owner_client)) == 1


async def test_a_call_for_a_different_setup_runs(owner_client, pool, mount_peers, tailnet):
    sent, _ = await _stream(
        owner_client,
        mount_peers,
        PHONE,
        (whole_call("call_1", "show_setup_qr", {"setup": "get_app"}),),
        (text("Both are in the chat."),),
    )

    assert [card["setup"] for card in _cards(sent)] == ["install_pwa", "get_app"]
    first, second = await _setup_spans(pool)
    assert first["requested_by_owner"] is True
    assert "requested_by_owner" not in second and "already_sent" not in second
    assert second["ok"] is True
    assert second["facts"][0]["setup"] == "get_app"


# -- a machine: one real code, and it reaches the card only ----------------------


async def test_a_machine_request_mints_one_real_code_that_reaches_only_the_card(
    owner_client, pool, mount_peers, tailnet, caplog
):
    # A logger.debug of the frame anywhere on this path would leak the code
    # and keep every other assertion green (test_chat_setup_card's lesson).
    caplog.set_level(logging.DEBUG)
    sent, gateway = await _stream(
        owner_client,
        mount_peers,
        LAPTOP,
        (whole_call("call_1", "show_setup_qr", {"setup": "add_machine"}),),
        (text("Scan the card, or open its link on the laptop."),),
    )

    (card,) = _cards(sent)
    code = card["code"]
    assert CODE_SHAPE.match(code)
    assert card["url"] == f"{ORIGIN}/add#{code}"
    # ONE mint — core's. Her call was answered with the first result.
    assert await pool.fetchval("SELECT count(*) FROM pairing_codes") == 1
    assert (
        await pool.fetchval(
            "SELECT count(*) FROM pairing_codes WHERE code_hash = $1", devices.hash_code(code)
        )
        == 1
    )
    first, again = await _setup_spans(pool)
    assert first["requested_by_owner"] is True
    assert first["facts"][0]["code_shown"] is True
    assert again["already_sent"] is True

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
    await asyncio.wait_for(chat.drain_background(), timeout=15)
    assert code not in caplog.text and bare not in caplog.text

    # The reload redraws the card as shown once, with no code.
    reloaded = await _reloaded_cards(owner_client)
    assert reloaded == [
        {
            "kind": "setup_qr",
            "setup": "add_machine",
            "address": ORIGIN,
            "url": f"{ORIGIN}/add",
            "code_shown": True,
            "expires_at": card["expires_at"],
        }
    ]
    assert code not in json.dumps(reloaded) and bare not in json.dumps(reloaded)


# -- nothing is sent when nothing was asked, or nothing could show it -----------


async def test_an_ordinary_message_sends_nothing(owner_client, pool, mount_peers, tailnet):
    sent, gateway = await _stream(
        owner_client, mount_peers, "What's the weather?", (text("Sunny."),)
    )

    assert _cards(sent) == []
    assert _activity(sent) == []
    assert await _setup_spans(pool) == []
    assert not _asked_for_a_setup(gateway.payloads[0])


async def test_memory_and_an_earlier_turn_never_ask_for_it(
    owner_client, pool, mount_peers, tailnet
):
    """A match reads the owner's MESSAGE only: a recalled note that asked, and
    the turn before this one that asked, are not this message asking."""
    memory = FakeMemory(
        results=({"title": "phone setup", "snippet": PHONE, "created": "2026-09-15"},)
    )
    gateway = ScriptedGateway(
        rounds=((text("Scan it with your phone's camera."),), (text("Glad it worked."),))
    )
    mount_peers(gateway=gateway, memory=memory)
    await set_chat_model(owner_client)
    first = await owner_client.post("/api/v1/chat/stream", json={"message": PHONE})
    assert first.status_code == 200, first.text
    second = await owner_client.post("/api/v1/chat/stream", json={"message": "thanks, that worked"})
    assert second.status_code == 200, second.text

    assert _cards(frames(second.text)) == []
    # One card, the first turn's; the second turn filed no setup span at all.
    assert len(await _setup_spans(pool)) == 1
    later = gateway.payloads[1]
    assert PHONE in json.dumps(later["messages"])  # the history and the note both said it
    assert not _asked_for_a_setup(later)


async def _owner(pool) -> Person:
    pid = await pool.fetchval(
        "INSERT INTO people (name, role) VALUES ('jeremy', 'owner') RETURNING id"
    )
    return Person(id=pid, name="jeremy", role="owner")


async def test_a_turn_with_no_card_channel_sends_nothing(pool, mount_peers, tailnet):
    """The scheduler's call, argument for argument (scheduler._fire_scheduled):
    no card channel. Her own call would state that there is no chat to show a
    card in; core does not even try."""
    owner = await _owner(pool)
    conversation = await conversations.active_conversation(pool, owner)
    gateway = ScriptedGateway(rounds=((text("Here is how."),),))
    mount_peers(gateway=gateway, memory=FakeMemory())
    turn = await traces.open_turn(
        pool, conversation_id=conversation["id"], model=MODEL, person_id=owner.id
    )
    sent: list = []
    before = set(chat._BACKGROUND)
    await chat._run_turn(
        app, pool, turn, owner, conversation["id"], PHONE, [], MODEL, 3, sent.append, ingest=False
    )
    await chat.settle_detached(before)

    assert await pool.fetchval("SELECT status FROM turns WHERE id = $1", turn.id) == "ok"
    assert await _setup_spans(pool) == []
    assert not any(frame and '"card"' in frame for frame in sent)
    assert not _asked_for_a_setup(gateway.payloads[0])


# -- a mint that fails is stated, and nothing is sent ----------------------------


async def _mint_fails(monkeypatch) -> None:
    async def broken(pool, *, created_by):
        raise ConnectionError("database is down")

    monkeypatch.setattr(devices, "mint_pairing_code", broken)


STATED = "cannot show a pairing card: the pairing code could not be made (ConnectionError)"


async def test_a_failed_mint_is_stated_and_sends_no_card(
    owner_client, pool, mount_peers, tailnet, monkeypatch
):
    await _mint_fails(monkeypatch)
    sent, gateway = await _stream(
        owner_client, mount_peers, LAPTOP, (text("I could not make the pairing card."),)
    )

    assert _cards(sent) == []
    assert _activity(sent) == ["start", "error"]
    (span,) = await _setup_spans(pool)
    assert span["requested_by_owner"] is True
    assert span["ok"] is False
    assert span["error"] == f"Error: {STATED}"
    assert "facts" not in span
    line = chat.requested_card_line("add_machine", span["result"], ok=False)
    assert STATED in line
    assert line in _system_text(gateway.payloads[0])


async def test_after_a_failed_send_her_own_call_still_runs(
    owner_client, pool, mount_peers, tailnet, monkeypatch
):
    """Only a card that WENT OUT is answered with its first result: when core
    could not send it, nothing was sent for her call to repeat, so it runs."""
    await _mint_fails(monkeypatch)
    sent, _ = await _stream(
        owner_client,
        mount_peers,
        LAPTOP,
        (whole_call("call_1", "show_setup_qr", {"setup": "add_machine"}),),
        (text("I could not make the pairing card."),),
    )

    assert _cards(sent) == []
    first, hers = await _setup_spans(pool)
    assert first["requested_by_owner"] is True and first["ok"] is False
    assert "already_sent" not in hers and "requested_by_owner" not in hers
    assert hers["ok"] is False and hers["error"] == f"Error: {STATED}"


# -- any turn with a chat to show it in: an agent addressed by @ too -------------


@pytest.fixture
def root(monkeypatch, tmp_path) -> Path:
    root = tmp_path / "ws"
    monkeypatch.setenv("WORKSPACE_ROOT", str(root))
    return root


@pytest.mark.parametrize(
    ("message", "setup"),
    [(PHONE, "install_pwa"), ("Where do I download your iPhone app?", "get_app")],
)
async def test_an_agent_turn_in_the_chat_gets_the_card_too(
    owner_client, pool, mount_peers, tailnet, root, message, setup
):
    """Controller ruling for this follow-up: any turn with a card channel. An
    @mention runs as the agent on the stream route, so it has one; the check
    is the backend acting on HIS words, not the agent reaching for a tool, so
    it is not narrowed to the agent's subset (the live checks' rule). The
    phone and app cards mint nothing, so an agent's turn sends them."""
    await _create(pool, mount_peers)
    sent, _ = await _stream(
        owner_client, mount_peers, f"@coder {message}", (text("It is in the chat."),)
    )

    assert [card["setup"] for card in _cards(sent)] == [setup]
    (span,) = await _setup_spans(pool)
    assert span["requested_by_owner"] is True and span["ok"] is True


# -- a scripted skill's step cannot send it twice either (review fix round 1) --


@pytest.mark.parametrize(
    ("message", "setup", "codes"), [(PHONE, "install_pwa", 0), (LAPTOP, "add_machine", 1)]
)
async def test_a_scripted_step_for_the_card_core_sent_is_answered_not_run(
    owner_client, pool, mount_peers, tailnet, root, message, setup, codes
):
    """A scripted skill's steps dispatch through chat._run_script_step, not the
    funnel — so the same synchronous check has to live there too, or a step
    asking for the card core already sent would send a second one and, for a
    machine, mint a second code."""
    await skills.create(
        pool,
        name="setupcard",
        title="the setup card",
        summary="asked as: 'the setup card please'",
        created_via="page",
        body="1. show the card\n",
        root=root,
    )
    await skills.set_status(pool, "setupcard", skills.ACTIVE)
    await skills.set_script(
        pool,
        "setupcard",
        {"version": 1, "steps": [{"tool": "show_setup_qr", "args": {"setup": setup}}]},
        {"type": "object", "properties": {}, "additionalProperties": False},
    )
    sent, _ = await _stream(
        owner_client,
        mount_peers,
        message,
        (whole_call("call_1", "run_skill", {"name": "setupcard", "inputs": {}}),),
        (text("It is in the chat."),),
    )

    assert [card["setup"] for card in _cards(sent)] == [setup]
    assert await pool.fetchval("SELECT count(*) FROM pairing_codes") == codes
    first, step = await _setup_spans(pool)
    assert first["requested_by_owner"] is True
    assert step["via_skill"] is True and step["step"] == 1  # steps count from 1
    assert step["already_sent"] is True and step["ok"] is True
    assert step["result_head"] == f"{first['result']} {chat.ALREADY_SENT_MARK}"[:500]
    assert "facts" not in step


# Review fix round 1: the stated cause, word for word.
AGENT_CANNOT_PAIR = (
    "cannot show a pairing card on an agent's turn: a pairing code is made for a person; "
    "ask Nova directly"
)


async def test_an_agent_turns_machine_card_states_why_and_mints_nothing(
    owner_client, pool, mount_peers, tailnet, root, caplog
):
    """Review fix round 1: on an @agent turn ctx.person is the AGENT — a value
    with no people row — so a pairing code cannot be made for it. The tool
    says so before any mint: no card, no code, no traceback, and one failed
    span whose stated reason is the real one (it used to be the mint's
    ForeignKeyViolationError, with a traceback in the log)."""
    caplog.set_level(logging.DEBUG)
    await _create(pool, mount_peers)
    sent, gateway = await _stream(
        owner_client, mount_peers, f"@coder {LAPTOP}", (text("I cannot pair it from here."),)
    )

    assert _cards(sent) == []
    assert _activity(sent) == ["start", "error"]
    (span,) = await _setup_spans(pool)
    assert span["requested_by_owner"] is True and span["ok"] is False
    assert span["error"] == f"Error: {AGENT_CANNOT_PAIR}"
    assert await pool.fetchval("SELECT count(*) FROM pairing_codes") == 0
    # Her turn is told the real cause, so her reply can say it.
    assert AGENT_CANNOT_PAIR in _system_text(gateway.payloads[0])
    await asyncio.wait_for(chat.drain_background(), timeout=15)
    assert "minting a pairing code failed" not in caplog.text
    assert "ForeignKeyViolation" not in caplog.text
