"""The written-call and device-completion guards wired into the live turn.

The owner's test, 2026-09-28 (tests/said_not_done_walk.py): she wrote her own
tool as a fence and said Teams was opening; she said Notepad was open; she
wrote device_info as a fence when asked why nothing opened. Zero calls each
time, no guard fired, and all of it went into her memory.

These drive the real route through a scripted gateway. Each claim takes the
turn's ONE redirect through `_claim_redirect` (tools advertised, so the MODEL
makes the call — nothing here turns her text into one), the regeneration is
vetted by the full guard set, a detection that is not corrected keeps the
turn out of memory, and the budget is shared with every other claim.
"""

from __future__ import annotations

import json

import pytest

from app import chat, guards, tools
from app.tools import devices as device_tools
from app.tools import web_search as web_search_tools
from app.tools.base import Tool, ToolContext
from tests.conftest import requires_db
from tests.fakes import FakeMemory, ScriptedGateway
from tests.said_not_done_walk import (
    DEVICE,
    T3DEE5106,
    T3DEE5106_ASKED,
    T98ECFB11,
    T98ECFB11_ASKED,
    T890B1C63,
    T890B1C63_ASKED,
)

DONE = "[DONE]"
SCHEMAS = {tool.name: tool.parameters for tool in device_tools.TOOLS}
SEARCH_SCHEMA = next(t.parameters for t in web_search_tools.TOOLS if t.name == "web_search")
LAUNCHED = f"{DEVICE}: asked Windows to launch Teams — whether a window opened is not confirmed."


class Spy:
    def __init__(self, result: str) -> None:
        self.calls: list = []
        self.result = result

    async def __call__(self, args: dict, ctx: ToolContext) -> str:
        self.calls.append(args)
        return self.result


def _arm(monkeypatch, name: str, result: str, *, schema: dict | None = None) -> Spy:
    """The registered tool with its REAL schema and a spy body: the redirect's
    call validates like a real one and the spy proves the executor ran.
    Not ephemeral, so a turn that ran it is ingested like any other."""
    spy = Spy(result)
    monkeypatch.setitem(
        tools.REGISTRY, name, Tool(name, "d", schema or SCHEMAS[name], spy, ephemeral=False)
    )
    return spy


def frames(body: str) -> list:
    out = []
    for block in body.strip().split("\n\n"):
        assert block.startswith("data: "), block
        payload = block[len("data: ") :]
        out.append(payload if payload == DONE else json.loads(payload))
    return out


def text(piece: str) -> dict:
    return {"choices": [{"delta": {"content": piece}}]}


def call(name: str, arguments: dict, call_id: str = "r1") -> dict:
    return {
        "choices": [
            {
                "delta": {
                    "tool_calls": [
                        {
                            "index": 0,
                            "id": call_id,
                            "type": "function",
                            "function": {"name": name, "arguments": json.dumps(arguments)},
                        }
                    ]
                }
            }
        ]
    }


async def _pair(pool, name: str = DEVICE) -> None:
    await pool.execute(
        "INSERT INTO devices (name, platform, hostname, pubkey) VALUES ($1, 'windows', 'dell', $2)",
        name,
        "a" * 64,
    )


async def _say(client, message: str) -> list:
    resp = await client.post("/api/v1/chat/stream", json={"message": message})
    assert resp.status_code == 200, resp.text
    return frames(resp.text)


async def _guard_spans(pool) -> list:
    return await pool.fetch(
        "SELECT name, meta FROM turn_spans WHERE kind = 'guard' ORDER BY started_at"
    )


async def _named(pool, name: str) -> list:
    return [row for row in await _guard_spans(pool) if row["name"] == name]


async def _stored(pool) -> str:
    return await pool.fetchval("SELECT content FROM messages WHERE role = 'assistant'")


def _corrections(sent: list) -> list[str]:
    return [f["correction"] for f in sent if isinstance(f, dict) and "correction" in f]


def _texts(sent: list) -> list[str]:
    return [f["t"] for f in sent if isinstance(f, dict) and "t" in f]


# -- the texts the turn ships: true, and clean under every guard ---------------


def test_the_nudges_say_the_facts_and_refuse_to_lie():
    nudge = chat.written_call_redirect_nudge(names=("device_launch_app",), ran_a_tool=False)
    assert nudge == (
        "You wrote a call to device_launch_app as text — text never runs a tool. If you "
        "meant to do it, make the call now; otherwise say plainly that you have not done it."
    )
    phrase = "Notepad is now open on your DELL-XPS-8950"
    nudge = chat.device_completion_redirect_nudge(phrase=phrase, ran_a_tool=False)
    assert nudge == (
        "You said “Notepad is now open on your DELL-XPS-8950”, but no device tool ran this "
        "turn. Do it now with the tool, or say plainly that you have not done it."
    )
    # Built only when nothing has run — _claim_redirect's own precondition.
    with pytest.raises(ValueError):
        chat.written_call_redirect_nudge(names=("device_info",), ran_a_tool=True)
    with pytest.raises(ValueError):
        chat.device_completion_redirect_nudge(phrase=phrase, ran_a_tool=True)


def test_several_written_tools_are_named_together():
    nudge = chat.written_call_redirect_nudge(names=("device_info", "device_run"), ran_a_tool=False)
    assert nudge.startswith("You wrote calls to device_info and device_run as text")


def test_every_note_and_nudge_is_clean_under_the_whole_guard_family():
    """Backend text the turn ships or sends must never itself trip a guard —
    the family's pinned property, extended to the two new claims."""
    names = tools.tool_names()
    phrase = "Notepad is now open on your DELL-XPS-8950"
    shipped = (
        chat.written_call_redirect_nudge(names=("device_launch_app",), ran_a_tool=False),
        chat.written_call_redirect_nudge(names=("device_info", "device_run"), ran_a_tool=False),
        chat.device_completion_redirect_nudge(phrase=phrase, ran_a_tool=False),
        chat.device_completion_redirect_nudge(phrase="I opened Teams", ran_a_tool=False),
        chat._written_call_honest_note(("device_launch_app",)),
        chat._written_call_honest_note(("web_search", "fetch_url")),
        chat._device_completion_honest_note(phrase),
        chat._device_completion_honest_note("I've stopped the service"),
        chat.WRITTEN_CALL_REDIRECT_NOTE,
        chat.WRITTEN_CALL_REDIRECT_NOTE_NO_CALL,
        chat.DEVICE_COMPLETION_REDIRECT_NOTE,
        chat.DEVICE_COMPLETION_REDIRECT_NOTE_NO_CALL,
    )
    for said in shipped:
        assert guards.written_call_check(said, [], names) is None, said
        assert guards.device_completion_check(said, [], names, [DEVICE]) is None, said
        for instruction in ("", T98ECFB11_ASKED, "check the web for the latest pixel phone"):
            assert guards.deferral_check(said, [], names, user_message=instruction) is None, said
        assert guards.bare_intent_check(said, []) is None, said
        assert guards.narration_check(said, []) is None, said
        assert guards.consent_claim_check(said) is None, said
        assert guards.capability_claim_check(said, names) is None, said
        assert guards.state_claim_check(said, [], [DEVICE], purpose="chat") is None, said
        assert guards.presented_listing_check(said, [], []) is None, said


def test_the_notes_say_only_what_is_mechanically_true():
    note = chat._written_call_honest_note(("device_info",))
    assert "device_info did not run this turn" in note
    note = chat._written_call_honest_note(("device_info", "device_run"))
    assert "none of them ran this turn" in note
    note = chat._device_completion_honest_note("Notepad is now open on your DELL-XPS-8950")
    assert "no device tool ran this turn" in note
    # It does NOT say Notepad is closed: nothing checked that either.
    assert "not open" not in note and "closed" not in note


# -- the written-call guard, live ---------------------------------------------


@requires_db
async def test_a_written_call_redirects_once_with_tools_and_she_makes_the_call(
    owner_client, pool, mount_peers, monkeypatch
):
    """The Teams turn, verbatim. The written call takes the turn's one
    redirect; the regeneration CALLS device_launch_app (the spy proves the body
    ran), and its report replaces the prose. The completion line in the
    discarded prose files nothing: the regeneration that replaced it was
    vetted by that very guard."""
    await _pair(pool)
    spy = _arm(monkeypatch, "device_launch_app", LAUNCHED)
    done = (
        "I asked your DELL-XPS-8950 to launch Teams. Windows accepted the request, but "
        "I can't confirm a window opened."
    )
    gateway = ScriptedGateway(
        rounds=(
            (text(T890B1C63),),
            (call("device_launch_app", {"device": DEVICE, "app": "Teams"}),),
            (text(done),),
        )
    )
    memory = FakeMemory()
    mount_peers(gateway=gateway, memory=memory)

    sent = await _say(owner_client, T890B1C63_ASKED)

    assert gateway.calls == 3  # the reply, ONE redirect round with tools, its closing round
    assert spy.calls == [{"device": DEVICE, "app": "Teams"}]
    assert await _stored(pool) == done
    assert _corrections(sent) == [chat.WRITTEN_CALL_REDIRECT_NOTE]
    assert _texts(sent) == [T890B1C63, done]
    assert sent[-1] == DONE

    spans = await _named(pool, "written_call")
    assert len(spans) == 1
    meta = spans[0]["meta"]
    assert meta["detected"] is True
    assert meta["tools"] == ["device_launch_app"]
    assert meta["redirected"] is True
    assert await _named(pool, "device_completion") == []
    assert await _named(pool, "deferral") == []

    # She did the work: ordinary knowledge again.
    await chat.drain_background()
    assert [i["exchange"]["assistant"] for i in memory.ingests] == [done]


@requires_db
async def test_a_regen_that_writes_the_call_again_is_refused_and_the_note_is_appended(
    owner_client, pool, mount_peers, monkeypatch
):
    """The why-not turn, verbatim. Bounded to ONE redirect: the regeneration
    writes device_info as a fence again, the written-call guard refuses it by
    name, the honest note is APPENDED (the reply's manual steps may be real
    content), and the turn stays out of memory. No third gateway call."""
    await _pair(pool)
    info = _arm(monkeypatch, "device_info", f"{DEVICE} system info:\nWindows 11")
    gateway = ScriptedGateway(
        rounds=((text(T3DEE5106),), (text('```bash\ndevice_info "DELL-XPS-8950"\n```'),))
    )
    memory = FakeMemory()
    mount_peers(gateway=gateway, memory=memory)

    sent = await _say(owner_client, T3DEE5106_ASKED)

    assert gateway.calls == 2
    # Prose never dispatches: she wrote device_info twice and it never ran.
    assert info.calls == []
    note = chat._written_call_honest_note(("device_info",))
    assert await _stored(pool) == f"{T3DEE5106}\n\n{note}"
    assert _corrections(sent) == [note]
    assert _texts(sent) == [T3DEE5106]

    spans = await _named(pool, "written_call")
    assert len(spans) == 1
    meta = spans[0]["meta"]
    assert meta["tools"] == ["device_info"]
    assert meta["redirected"] is False
    assert meta["regen_rejected_by"] == "written_call"

    await chat.drain_background()
    assert memory.ingests == []


@requires_db
async def test_both_claims_in_one_reply_share_one_redirect_and_both_notes_stand(
    owner_client, pool, mount_peers, monkeypatch
):
    """The Teams turn again, and this time the one redirect fails. The written
    call had the budget; the completion claim still files its ONE span, says
    why it did not redirect, and its note follows the first. Two gateway
    calls, never three."""
    await _pair(pool)
    launcher = _arm(monkeypatch, "device_launch_app", LAUNCHED)
    again = '```bash\ndevice_launch_app "DELL-XPS-8950" "Teams"\n```'
    gateway = ScriptedGateway(rounds=((text(T890B1C63),), (text(again),)))
    memory = FakeMemory()
    mount_peers(gateway=gateway, memory=memory)

    sent = await _say(owner_client, T890B1C63_ASKED)

    assert gateway.calls == 2
    assert launcher.calls == []  # the fenced call, written twice, never ran
    written = chat._written_call_honest_note(("device_launch_app",))
    completion = chat._device_completion_honest_note("Teams is now opening on your DELL-XPS-8950")
    assert await _stored(pool) == f"{T890B1C63}\n\n{written}\n\n{completion}"
    assert _corrections(sent) == [written, completion]

    (written_span,) = await _named(pool, "written_call")
    assert written_span["meta"]["redirected"] is False
    assert written_span["meta"]["regen_rejected_by"] == "written_call"
    (completion_span,) = await _named(pool, "device_completion")
    assert completion_span["meta"]["detected"] is True
    assert completion_span["meta"]["phrase"] == "Teams is now opening on your DELL-XPS-8950"
    assert completion_span["meta"]["redirected"] is False
    assert completion_span["meta"]["not_redirected_because"] == "redirect_spent"

    await chat.drain_background()
    assert memory.ingests == []


@requires_db
async def test_a_written_call_after_another_tool_ran_is_noted_never_redirected(
    owner_client, pool, mount_peers, monkeypatch
):
    """The redirect's double-execution precondition is unchanged: a tool
    already ran, so nothing is regenerated — the span says why, the note is
    appended, the turn stays out of memory."""
    await _pair(pool)
    lister = _arm(monkeypatch, "device_list_apps", f"Apps on {DEVICE}:\nTeams\nNotepad")
    launcher = _arm(monkeypatch, "device_launch_app", LAUNCHED)
    reply = 'Teams is installed. ```device_launch_app "DELL-XPS-8950" "Teams"```'
    gateway = ScriptedGateway(
        rounds=((call("device_list_apps", {"device": DEVICE}, "c1"),), (text(reply),))
    )
    memory = FakeMemory()
    mount_peers(gateway=gateway, memory=memory)

    sent = await _say(owner_client, T890B1C63_ASKED)

    assert gateway.calls == 2  # the call round and the reply; NO redirect round
    assert lister.calls == [{"device": DEVICE}]
    assert launcher.calls == []
    note = chat._written_call_honest_note(("device_launch_app",))
    assert await _stored(pool) == f"{reply}\n\n{note}"
    assert _corrections(sent) == [note]
    (span,) = await _named(pool, "written_call")
    assert span["meta"]["redirected"] is False
    assert span["meta"]["not_redirected_because"] == "tools_already_ran"

    await chat.drain_background()
    assert memory.ingests == []


@requires_db
async def test_a_written_call_goes_before_a_deferral_and_spends_the_budget(
    owner_client, pool, mount_peers, monkeypatch
):
    """A commitment ("I'll search the web") AND the search written as text:
    the written call is the claim that can be fixed WITH tools, so it has the
    budget first. The regeneration searches, stands, and the text-only
    commitment redirect never runs — three gateway calls, one redirect."""
    spy = _arm(monkeypatch, "web_search", "Pixel 10: Tensor G5.", schema=SEARCH_SCHEMA)
    reply = 'I\'ll search the web for that.\n```\nweb_search("latest pixel phone")\n```'
    done = "The Pixel 10 launched with a Tensor G5."
    gateway = ScriptedGateway(
        rounds=(
            (text(reply),),
            (call("web_search", {"query": "latest pixel phone"}),),
            (text(done),),
        )
    )
    mount_peers(gateway=gateway, memory=FakeMemory())

    sent = await _say(owner_client, "what's the latest pixel phone?")

    assert gateway.calls == 3
    assert spy.calls == [{"query": "latest pixel phone"}]
    assert await _stored(pool) == done
    assert _corrections(sent) == [chat.WRITTEN_CALL_REDIRECT_NOTE]
    assert len(await _named(pool, "written_call")) == 1
    assert await _named(pool, "deferral") == []


@requires_db
async def test_the_responsiveness_check_never_runs_after_one_of_these(
    owner_client, pool, mount_peers, monkeypatch
):
    """One redirect per turn, TOTAL: with the soft check ON, a completion
    claim's redirect is the only extra gateway call — no judge, no span."""
    await _pair(pool)
    spy = _arm(monkeypatch, "device_launch_app", LAUNCHED.replace("Teams", "notepad"))
    done = "I asked your DELL-XPS-8950 to launch Notepad; I can't confirm a window opened."
    gateway = ScriptedGateway(
        rounds=(
            (text(T98ECFB11),),
            (call("device_launch_app", {"device": DEVICE, "app": "notepad"}),),
            (text(done),),
        )
    )
    mount_peers(gateway=gateway, memory=FakeMemory())
    resp = await owner_client.put(
        "/api/v1/settings", json={"key": "agents.responsiveness_check", "value": True}
    )
    assert resp.status_code == 200, resp.text

    await _say(owner_client, T98ECFB11_ASKED)

    assert gateway.calls == 3  # a judge call would be a fourth: the script's loud 500
    assert spy.calls == [{"device": DEVICE, "app": "notepad"}]
    assert await _named(pool, "responsiveness") == []


@requires_db
async def test_a_written_call_guard_that_raises_fails_open(
    owner_client, pool, mount_peers, monkeypatch
):
    def boom(*_args, **_kwargs):
        raise RuntimeError("detector blew up")

    monkeypatch.setattr(chat.guards, "written_call_check", boom)
    await _pair(pool)
    reply = '```\ndevice_info "DELL-XPS-8950"\n```'
    gateway = ScriptedGateway(rounds=((text(reply),),))
    mount_peers(gateway=gateway, memory=FakeMemory())

    sent = await _say(owner_client, "is my dell ok?")

    assert gateway.calls == 1
    assert await _stored(pool) == reply
    assert await _named(pool, "written_call") == []
    assert not [f for f in sent if isinstance(f, dict) and "error" in f]


@requires_db
async def test_a_hard_correction_keeps_the_redirect_off_and_the_turn_out_of_memory(
    owner_client, pool, mount_peers
):
    """narration already corrected the reply (an APPEND-class hard guard), so
    — like the timer completion shape — no regeneration runs over it. The
    written call still files its one span, says why, and appends its note."""
    await _pair(pool)
    reply = 'I saved report.md for you.\n```\ndevice_info "DELL-XPS-8950"\n```'
    gateway = ScriptedGateway(rounds=((text(reply),),))
    memory = FakeMemory()
    mount_peers(gateway=gateway, memory=memory)

    sent = await _say(owner_client, "save a report and check my dell")

    assert gateway.calls == 1
    note = chat._written_call_honest_note(("device_info",))
    stored = await _stored(pool)
    assert stored.startswith(reply)
    assert stored.endswith(note)
    assert _corrections(sent)[-1] == note
    (span,) = await _named(pool, "written_call")
    assert span["meta"]["redirected"] is False
    assert span["meta"]["not_redirected_because"] == "mechanical_guard_fired"
    await chat.drain_background()
    assert memory.ingests == []


# -- the device-completion guard, live ----------------------------------------


@requires_db
async def test_the_notepad_claim_redirects_and_the_launch_really_runs(
    owner_client, pool, mount_peers, monkeypatch
):
    await _pair(pool)
    spy = _arm(monkeypatch, "device_launch_app", LAUNCHED.replace("Teams", "notepad"))
    done = "I asked your DELL-XPS-8950 to launch Notepad; I can't confirm a window opened."
    gateway = ScriptedGateway(
        rounds=(
            (text(T98ECFB11),),
            (call("device_launch_app", {"device": DEVICE, "app": "notepad"}),),
            (text(done),),
        )
    )
    memory = FakeMemory()
    mount_peers(gateway=gateway, memory=memory)

    sent = await _say(owner_client, T98ECFB11_ASKED)

    assert gateway.calls == 3
    assert spy.calls == [{"device": DEVICE, "app": "notepad"}]
    assert await _stored(pool) == done
    assert _corrections(sent) == [chat.DEVICE_COMPLETION_REDIRECT_NOTE]
    (span,) = await _named(pool, "device_completion")
    meta = span["meta"]
    assert meta["detected"] is True
    assert meta["phrase"] == "Notepad is now open on your DELL-XPS-8950"
    assert meta["device"] == DEVICE
    assert meta["redirected"] is True
    await chat.drain_background()
    assert [i["exchange"]["assistant"] for i in memory.ingests] == [done]


@requires_db
async def test_a_regen_that_says_plainly_it_did_not_stands_without_claiming_a_call(
    owner_client, pool, mount_peers, monkeypatch
):
    """C14's rule for this claim too: a regeneration that dispatched nothing
    and said so plainly stands, and the live note does not claim a call."""
    await _pair(pool)
    _arm(monkeypatch, "device_launch_app", LAUNCHED)
    plain = "I haven't opened Notepad on your DELL-XPS-8950 — nothing ran this turn."
    gateway = ScriptedGateway(rounds=((text(T98ECFB11),), (text(plain),)))
    mount_peers(gateway=gateway, memory=FakeMemory())

    sent = await _say(owner_client, T98ECFB11_ASKED)

    assert gateway.calls == 2
    assert await _stored(pool) == plain
    assert _corrections(sent) == [chat.DEVICE_COMPLETION_REDIRECT_NOTE_NO_CALL]
    (span,) = await _named(pool, "device_completion")
    assert span["meta"]["redirected"] is True


@requires_db
async def test_a_completion_regen_that_claims_it_again_is_refused(
    owner_client, pool, mount_peers, monkeypatch
):
    await _pair(pool)
    _arm(monkeypatch, "device_launch_app", LAUNCHED)
    gateway = ScriptedGateway(
        rounds=((text(T98ECFB11),), (text("Notepad is open on your DELL-XPS-8950 now."),))
    )
    memory = FakeMemory()
    mount_peers(gateway=gateway, memory=memory)

    sent = await _say(owner_client, T98ECFB11_ASKED)

    assert gateway.calls == 2
    note = chat._device_completion_honest_note("Notepad is now open on your DELL-XPS-8950")
    assert await _stored(pool) == f"{T98ECFB11}\n\n{note}"
    assert _corrections(sent) == [note]
    (span,) = await _named(pool, "device_completion")
    assert span["meta"]["redirected"] is False
    assert span["meta"]["regen_rejected_by"] == "device_completion"
    await chat.drain_background()
    assert memory.ingests == []


@requires_db
async def test_a_real_launch_backs_the_claim_and_nothing_fires(
    owner_client, pool, mount_peers, monkeypatch
):
    await _pair(pool)
    spy = _arm(monkeypatch, "device_launch_app", LAUNCHED.replace("Teams", "notepad"))
    reply = "I asked Windows to open Notepad on your DELL-XPS-8950."
    gateway = ScriptedGateway(
        rounds=(
            (call("device_launch_app", {"device": DEVICE, "app": "notepad"}, "c1"),),
            (text(reply),),
        )
    )
    mount_peers(gateway=gateway, memory=FakeMemory())

    await _say(owner_client, T98ECFB11_ASKED)

    assert gateway.calls == 2
    assert spy.calls == [{"device": DEVICE, "app": "notepad"}]
    assert await _stored(pool) == reply
    assert await _named(pool, "device_completion") == []
    assert await _named(pool, "written_call") == []


# -- the rest of the family is vetted by them too ------------------------------


@requires_db
async def test_another_claims_regen_that_writes_a_call_is_refused_by_name(
    owner_client, pool, mount_peers
):
    """The full-set vetting reaches every redirect: the state claim's
    regeneration writes device_info as text instead of checking, and the
    written-call guard refuses it — the state correction persists."""
    await _pair(pool)
    gateway = ScriptedGateway(
        rounds=(
            (text("Looks like the device is still offline."),),
            (text('```\ndevice_info "DELL-XPS-8950"\n```'),),
        )
    )
    mount_peers(gateway=gateway, memory=FakeMemory())

    await _say(owner_client, "try again")

    assert gateway.calls == 2
    (span,) = await _named(pool, "state_claim")
    assert span["meta"]["redirected"] is False
    assert span["meta"]["regen_rejected_by"] == "written_call"
    assert await _stored(pool) == guards.STATE_CLAIM_CORRECTION
