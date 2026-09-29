"""The written-call and device-completion guards wired into the live turn.

The owner's test, 2026-09-28 (tests/said_not_done_walk.py): she wrote her own
tool as a fence and said Teams was opening; she said Notepad was open; she
wrote device_info as a fence when asked why nothing opened. Zero calls each
time, no guard fired, and all of it went into her memory.

These drive the real route through a scripted gateway. The pair takes the
turn's ONE redirect through `_claim_redirect` (tools advertised, so the MODEL
makes the call — nothing here turns her text into one), the regeneration is
vetted by the full guard set, the turn ships ONE correction derived from its
final spans, a detection that is not corrected keeps the turn out of memory,
and the budget is shared with every other claim.

Fix round 1 (2026-09-29): every chat-level probe of the adversarial review of
bc89e231 is a test here, asserting what must happen instead — a read, a shell
read, a backend check or another device never launders a claim (C1); a
proposal, a recap or a warning is never redirected into an action (C2); a
failure is stated with its reason, never as "nothing ran" (I1); and the
nudge's own honest answer passes (I2).
"""

from __future__ import annotations

import json

import pytest

from app import chat, guards, tools
from app.tools import devices as device_tools
from app.tools import web_search as web_search_tools
from app.tools.base import Tool, ToolContext, ToolFailure
from tests.conftest import requires_db
from tests.fakes import FakeMemory, Refusal, ScriptedGateway
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
NAMES = tools.tool_names()


class Spy:
    def __init__(self, result: str) -> None:
        self.calls: list = []
        self.result = result

    async def __call__(self, args: dict, ctx: ToolContext) -> str:
        self.calls.append(args)
        return self.result


def _arm(monkeypatch, name: str, result: str, *, schema: dict | None = None) -> Spy:
    """The registered tool with its REAL schema and its REAL flags, and a spy
    body: the redirect's call validates like a real one, the spy proves the
    executor ran, and a read stays a read (a backend live check may run it
    unasked). Ephemeral turned off, so a turn that ran it is ingested like
    any other."""
    spy = Spy(result)
    real = tools.REGISTRY.get(name)
    monkeypatch.setitem(
        tools.REGISTRY,
        name,
        Tool(
            name,
            "d",
            schema or SCHEMAS[name],
            spy,
            ephemeral=False,
            reads_only=real.reads_only if real is not None else False,
        ),
    )
    return spy


def _arm_failing(monkeypatch, name: str, reason: str) -> list:
    """The tool with its real schema, failing the way a device reports it: a
    ToolFailure, which dispatch turns into an `Error:` result and ok=False."""
    attempts: list = []

    async def failing(args: dict, ctx: ToolContext) -> str:
        attempts.append(args)
        raise ToolFailure(reason)

    monkeypatch.setitem(tools.REGISTRY, name, Tool(name, "d", SCHEMAS[name], failing))
    return attempts


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


def _system_nudges(gateway) -> list[str]:
    out = []
    for body in gateway.payloads:
        messages = body.get("messages") or []
        if messages and messages[-1].get("role") == "system":
            out.append(messages[-1]["content"])
    return out


def _claim(reply: str, spans=()) -> guards.DeviceCompletionClaim:
    claim = guards.device_completion_check(reply, list(spans), NAMES, [DEVICE])
    assert claim is not None, reply
    return claim


NOTEPAD = _claim(T98ECFB11)
TEAMS = _claim(T890B1C63)
FAILED_REASON = "no Start-menu app named 'notepad++' and no program by that name on PATH"


def _failed_claim() -> guards.DeviceCompletionClaim:
    from types import SimpleNamespace

    span = SimpleNamespace(
        kind="tool",
        name="device_launch_app",
        meta={
            "ok": False,
            "args_redacted": {"app": "notepad++", "device": DEVICE},
            "error": f"Error: {DEVICE}: {FAILED_REASON}",
        },
    )
    return _claim("I launched Notepad++ on your DELL-XPS-8950.", [span])


# -- the texts the turn ships: true, and clean under every guard ---------------


def test_the_written_call_nudge_offers_a_clean_way_out():
    """(C2) It never pushes an action she may not have meant: make the call if
    she meant to run it now, keep her reply if she was explaining, proposing
    or asking."""
    nudge = chat.written_call_redirect_nudge(names=("device_launch_app",), ran_a_tool=False)
    assert nudge == (
        "You wrote a call to device_launch_app as text — text never runs a tool. If you "
        "meant to run it now, make the call; if you were explaining, proposing or asking, "
        "keep your reply as it is."
    )
    several = chat.written_call_redirect_nudge(
        names=("device_info", "device_run"), ran_a_tool=False
    )
    assert several.startswith("You wrote calls to device_info and device_run as text")
    assert "make the calls;" in several
    with pytest.raises(ValueError):
        chat.written_call_redirect_nudge(names=("device_info",), ran_a_tool=True)


def test_the_completion_nudge_names_the_tools_that_would_have_done_it():
    """(C1) "no device tool ran" is false when a READ ran; what is true is that
    none of the tools that perform the action did."""
    assert chat.device_completion_redirect_nudge(NOTEPAD, ran_a_tool=False) == (
        "You said “Notepad is now open on your DELL-XPS-8950”, but no device_launch_app or "
        "device_run call ran on DELL-XPS-8950 this turn. Do it now with the tool, or say "
        "plainly that you have not done it."
    )
    with pytest.raises(ValueError):
        chat.device_completion_redirect_nudge(NOTEPAD, ran_a_tool=True)


def test_a_failure_nudge_states_the_failure_and_pushes_no_retry():
    """(I1) the call that would have done it FAILED: say so, with its reason —
    never "nothing ran", never "do it now"."""
    nudge = chat.device_completion_redirect_nudge(_failed_claim(), ran_a_tool=False)
    assert nudge == (
        "You said “I launched Notepad++ on your DELL-XPS-8950”, but device_launch_app failed on "
        f"DELL-XPS-8950: {FAILED_REASON} — it did not open. Say so plainly; do not claim it "
        "opened."
    )
    assert "no device" not in nudge and "Do it now" not in nudge


def test_the_corrections_say_only_what_the_record_shows():
    assert chat._device_completion_honest_note(NOTEPAD) == (
        "Correction: I said “Notepad is now open on your DELL-XPS-8950”, but no "
        "device_launch_app or device_run call ran on DELL-XPS-8950 this turn — I did not do "
        "that, and I have not checked whether it is so. Ask me again and I'll do it."
    )
    assert chat._device_failure_correction(_failed_claim()) == (
        "Correction: I said “I launched Notepad++ on your DELL-XPS-8950”, but "
        f"device_launch_app failed on DELL-XPS-8950: {FAILED_REASON} — it did not open."
    )
    assert chat._written_and_claimed_correction(("device_launch_app",), TEAMS) == (
        "Correction: I wrote device_launch_app as text instead of calling it — text never "
        "runs a tool, so no device_launch_app or device_run call ran on DELL-XPS-8950 this "
        "turn and I did not do what I said (“Teams is now opening on your DELL-XPS-8950”). "
        "Ask me again and I'll make the call."
    )
    note = chat._written_call_honest_note(("device_info", "device_run"))
    assert "none of them ran this turn" in note
    # None says the app is closed: nothing checked that either.
    for said in (chat._device_completion_honest_note(NOTEPAD), note):
        assert "not open" not in said and "closed" not in said


def test_every_note_and_nudge_is_clean_under_the_whole_guard_family():
    """Backend text the turn ships or sends must never itself trip a guard —
    the family's pinned property, extended to the two new claims."""
    shipped = (
        chat.written_call_redirect_nudge(names=("device_launch_app",), ran_a_tool=False),
        chat.written_call_redirect_nudge(names=("device_info", "device_run"), ran_a_tool=False),
        chat.device_completion_redirect_nudge(NOTEPAD, ran_a_tool=False),
        chat.device_completion_redirect_nudge(TEAMS, ran_a_tool=False),
        chat.device_completion_redirect_nudge(_failed_claim(), ran_a_tool=False),
        chat.device_completion_redirect_nudge(_claim("I opened Teams."), ran_a_tool=False),
        chat._written_call_honest_note(("device_launch_app",)),
        chat._written_call_honest_note(("web_search", "fetch_url")),
        chat._device_completion_honest_note(NOTEPAD),
        chat._device_completion_honest_note(_claim("I've stopped the service.")),
        chat._device_failure_correction(_failed_claim()),
        chat._written_and_claimed_correction(("device_launch_app",), TEAMS),
        chat._bare_intent_ran_but_unreported_note("device_launch_app"),
        chat.WRITTEN_CALL_REDIRECT_NOTE,
        chat.WRITTEN_CALL_REDIRECT_NOTE_NO_CALL,
        chat.DEVICE_COMPLETION_REDIRECT_NOTE,
        chat.DEVICE_COMPLETION_REDIRECT_NOTE_NO_CALL,
    )
    for said in shipped:
        assert guards.written_call_check(said, [], NAMES) is None, said
        assert guards.device_completion_check(said, [], NAMES, [DEVICE]) is None, said
        for instruction in ("", T98ECFB11_ASKED, "check the web for the latest pixel phone"):
            assert guards.deferral_check(said, [], NAMES, user_message=instruction) is None, said
        assert guards.bare_intent_check(said, []) is None, said
        assert guards.narration_check(said, []) is None, said
        assert guards.consent_claim_check(said) is None, said
        assert guards.capability_claim_check(said, NAMES) is None, said
        assert guards.state_claim_check(said, [], [DEVICE], purpose="chat") is None, said
        assert guards.presented_listing_check(said, [], []) is None, said


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
    name, the correction is APPENDED (the reply's manual steps may be real
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
async def test_both_claims_in_one_reply_share_one_redirect_and_one_correction(
    owner_client, pool, mount_peers, monkeypatch
):
    """The Teams turn again, and this time the one redirect fails. (I1) The
    turn ships exactly ONE correction, covering the written call AND the
    "Teams is now opening" beside it; the completion claim files its own span
    and says its correction was joined. Two gateway calls, never three."""
    await _pair(pool)
    launcher = _arm(monkeypatch, "device_launch_app", LAUNCHED)
    again = '```bash\ndevice_launch_app "DELL-XPS-8950" "Teams"\n```'
    gateway = ScriptedGateway(rounds=((text(T890B1C63),), (text(again),)))
    memory = FakeMemory()
    mount_peers(gateway=gateway, memory=memory)

    sent = await _say(owner_client, T890B1C63_ASKED)

    assert gateway.calls == 2
    assert launcher.calls == []  # the fenced call, written twice, never ran
    one = chat._written_and_claimed_correction(("device_launch_app",), TEAMS)
    assert await _stored(pool) == f"{T890B1C63}\n\n{one}"
    assert _corrections(sent) == [one]

    (written_span,) = await _named(pool, "written_call")
    assert written_span["meta"]["redirected"] is False
    assert written_span["meta"]["regen_rejected_by"] == "written_call"
    (completion_span,) = await _named(pool, "device_completion")
    assert completion_span["meta"]["detected"] is True
    assert completion_span["meta"]["phrase"] == "Teams is now opening on your DELL-XPS-8950"
    assert completion_span["meta"]["redirected"] is False
    assert completion_span["meta"]["not_redirected_because"] == "redirect_spent"
    assert completion_span["meta"]["correction"] == "joined"

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
    reply = 'Teams is installed. Launching it: `device_launch_app "DELL-XPS-8950" "Teams"`'
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
    """A commitment ("I'll search the web") AND the search written as code:
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
    reply = (
        "I saved report.md for you. Let me check the Dell too:\n"
        '```\ndevice_info "DELL-XPS-8950"\n```'
    )
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
    assert meta["action"] == "launch"
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
    note = chat._device_completion_honest_note(NOTEPAD)
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


# -- the review's chat-level probes, each now asserting what must happen -------


def _apps_memory() -> FakeMemory:
    """A recalled note whose live source is device_list_apps on the Dell: the
    backend runs that read UNASKED before she answers (live_facts)."""
    return FakeMemory(
        results=(
            {
                "title": "Apps on the Dell",
                "snippet": "Notepad and Teams are installed on DELL-XPS-8950",
                "kind": "topic",
                "created": "2026-09-28",
                "live_source": {"tool": "device_list_apps", "args": {"device": DEVICE}},
            },
        )
    )


@requires_db
async def test_A_a_backend_check_never_backs_her_claim(
    owner_client, pool, mount_peers, monkeypatch
):
    """(C1, review A) A live check the BACKEND ran unasked read the Dell's
    apps; it launched nothing. The Notepad claim fires. A tool ran this turn,
    so no redirect (a second dispatch is worse than the lie): the correction is
    appended and the turn stays out of memory."""
    await _pair(pool)
    lister = _arm(monkeypatch, "device_list_apps", f"Apps on {DEVICE}:\n2 apps\nNotepad\nTeams")
    launcher = _arm(monkeypatch, "device_launch_app", LAUNCHED)
    memory = _apps_memory()
    gateway = ScriptedGateway(rounds=((text(T98ECFB11),),))
    mount_peers(gateway=gateway, memory=memory)

    sent = await _say(owner_client, T98ECFB11_ASKED)

    assert gateway.calls == 1
    assert lister.calls == [{"device": DEVICE}]  # the backend's unasked read
    assert launcher.calls == []
    note = chat._device_completion_honest_note(NOTEPAD)
    assert await _stored(pool) == f"{T98ECFB11}\n\n{note}"
    assert _corrections(sent)[-1] == note
    (span,) = await _named(pool, "device_completion")
    assert span["meta"]["not_redirected_because"] == "tools_already_ran"
    await chat.drain_background()
    assert memory.ingests == []


@requires_db
@pytest.mark.parametrize(
    "label,read,args",
    [
        ("B1 a read of the apps", "device_list_apps", {"device": DEVICE}),
        ("B2 a shell read", "device_run", {"device": DEVICE, "argv": ["tasklist"]}),
    ],
)
async def test_B_a_redirect_that_only_reads_cannot_launder_the_claim(
    label, read, args, owner_client, pool, mount_peers, monkeypatch
):
    """(C1, review B1 and B2) The redirect reads the Dell — its apps, or a
    `tasklist` through device_run — then claims Notepad is open. Neither
    launched Notepad: the regeneration is refused, the live note never says
    "doing it now", and the ONE correction persists, not ingested."""
    await _pair(pool)
    reader = _arm(monkeypatch, read, f"{DEVICE}: read ok")
    launcher = _arm(monkeypatch, "device_launch_app", LAUNCHED)
    gateway = ScriptedGateway(
        rounds=(
            (text(T98ECFB11),),
            (call(read, args),),
            (text("Notepad is now open on your DELL-XPS-8950."),),
        )
    )
    memory = FakeMemory()
    mount_peers(gateway=gateway, memory=memory)

    sent = await _say(owner_client, T98ECFB11_ASKED)

    assert gateway.calls == 3, label
    assert reader.calls == [args], label
    assert launcher.calls == [], label
    note = chat._device_completion_honest_note(NOTEPAD)
    assert await _stored(pool) == f"{T98ECFB11}\n\n{note}", label
    assert _corrections(sent) == [note], label
    (span,) = await _named(pool, "device_completion")
    assert span["meta"]["regen_rejected_by"] == "device_completion", label
    await chat.drain_background()
    assert memory.ingests == [], label


@requires_db
async def test_B3_a_written_call_redirect_that_reads_instead_is_one_correction(
    owner_client, pool, mount_peers, monkeypatch
):
    """(C1, I1, review B3) The Teams turn: the redirect calls device_info
    instead of the launch, then says Teams is open. Refused; the note never
    said "making that call"; ONE correction covers the written call and the
    claim."""
    await _pair(pool)
    info = _arm(monkeypatch, "device_info", f"{DEVICE} system info:\nWindows 11 Pro")
    launcher = _arm(monkeypatch, "device_launch_app", LAUNCHED)
    gateway = ScriptedGateway(
        rounds=(
            (text(T890B1C63),),
            (call("device_info", {"device": DEVICE}),),
            (text("Teams is now open on your DELL-XPS-8950."),),
        )
    )
    mount_peers(gateway=gateway, memory=FakeMemory())

    sent = await _say(owner_client, T890B1C63_ASKED)

    assert info.calls == [{"device": DEVICE}]
    assert launcher.calls == []
    one = chat._written_and_claimed_correction(("device_launch_app",), TEAMS)
    assert await _stored(pool) == f"{T890B1C63}\n\n{one}"
    assert _corrections(sent) == [one]
    (written_span,) = await _named(pool, "written_call")
    assert written_span["meta"]["regen_rejected_by"] == "device_completion"


@requires_db
async def test_B4_a_read_then_a_written_launch_leaves_the_true_correction(
    owner_client, pool, mount_peers, monkeypatch
):
    """(C1, review B4) The Notepad turn: the redirect reads the Dell, then
    writes the launch as text. Before, the read "backed" the claim and the
    correction became "I ran device_info but could not report…". Now the read
    backs nothing, and what persists is what is true: nothing that could open
    Notepad ran."""
    await _pair(pool)
    _arm(monkeypatch, "device_info", f"{DEVICE} system info:\nWindows 11 Pro")
    launcher = _arm(monkeypatch, "device_launch_app", LAUNCHED)
    gateway = ScriptedGateway(
        rounds=(
            (text(T98ECFB11),),
            (call("device_info", {"device": DEVICE}),),
            (text('Launching now:\n```\ndevice_launch_app "DELL-XPS-8950" "Notepad"\n```'),),
        )
    )
    mount_peers(gateway=gateway, memory=FakeMemory())

    sent = await _say(owner_client, T98ECFB11_ASKED)

    assert launcher.calls == []
    note = chat._device_completion_honest_note(NOTEPAD)
    assert await _stored(pool) == f"{T98ECFB11}\n\n{note}"
    assert _corrections(sent) == [note]
    (span,) = await _named(pool, "device_completion")
    assert span["meta"]["regen_rejected_by"] == "written_call"


@requires_db
async def test_B5_a_failed_launch_in_the_redirect_is_one_correction_with_its_reason(
    owner_client, pool, mount_peers, monkeypatch
):
    """(I1, review B5) The Teams turn: the redirect really calls
    device_launch_app and it FAILS; its closing round claims Teams is open.
    Before, two corrections contradicted each other ("I ran a tool…" and "no
    device tool ran"). Now ONE states the failure and its reason."""
    await _pair(pool)
    attempts = _arm_failing(
        monkeypatch,
        "device_launch_app",
        f"{DEVICE}: no Start-menu app named 'Teams' and no program by that name on PATH",
    )
    gateway = ScriptedGateway(
        rounds=(
            (text(T890B1C63),),
            (call("device_launch_app", {"device": DEVICE, "app": "Teams"}),),
            (text("Teams is now open on your DELL-XPS-8950."),),
        )
    )
    memory = FakeMemory()
    mount_peers(gateway=gateway, memory=memory)

    sent = await _say(owner_client, T890B1C63_ASKED)

    assert attempts == [{"device": DEVICE, "app": "Teams"}]
    one = (
        "Correction: I said “Teams is now opening on your DELL-XPS-8950”, but device_launch_app "
        "failed on DELL-XPS-8950: no Start-menu app named 'Teams' and no program by that name "
        "on PATH — it did not open."
    )
    assert await _stored(pool) == f"{T890B1C63}\n\n{one}"
    assert _corrections(sent) == [one]
    (completion_span,) = await _named(pool, "device_completion")
    assert completion_span["meta"]["correction"] == "joined"
    await chat.drain_background()
    assert memory.ingests == []


@requires_db
async def test_C_a_failed_launch_is_stated_with_its_reason_never_as_nothing_ran(
    owner_client, pool, mount_peers, monkeypatch
):
    """(I1, review C) She called device_launch_app, it FAILED, and she said she
    launched it. The nudge states the failure with its reason and pushes no
    retry; the regeneration that claims it again is refused; the correction
    states the failure."""
    await _pair(pool)
    attempts = _arm_failing(monkeypatch, "device_launch_app", f"{DEVICE}: {FAILED_REASON}")
    claimed = "I launched Notepad++ on your DELL-XPS-8950."
    gateway = ScriptedGateway(
        rounds=(
            (call("device_launch_app", {"device": DEVICE, "app": "notepad++"}, "c1"),),
            (text(claimed),),
            (text("Notepad is open on your DELL-XPS-8950 now."),),
        )
    )
    memory = FakeMemory()
    mount_peers(gateway=gateway, memory=memory)

    sent = await _say(owner_client, "open notepad++ on my dell")

    assert gateway.calls == 3
    assert attempts == [{"device": DEVICE, "app": "notepad++"}]  # never retried by the redirect
    nudge = _system_nudges(gateway)[-1]
    assert nudge == chat.device_completion_redirect_nudge(_failed_claim(), ran_a_tool=False)
    assert "no device" not in nudge and "Do it now" not in nudge
    correction = chat._device_failure_correction(_failed_claim())
    assert await _stored(pool) == f"{claimed}\n\n{correction}"
    assert _corrections(sent) == [correction]
    (span,) = await _named(pool, "device_completion")
    assert span["meta"]["failed"] == "device_launch_app"
    await chat.drain_background()
    assert memory.ingests == []


@requires_db
async def test_C2_a_plusplus_app_claimed_again_after_its_failure_is_refused(
    owner_client, pool, mount_peers, monkeypatch
):
    """(I3, review C2) "Notepad++ is open … now" after the launch failed: the
    "++" ends the subject and "now" after the device marks the change. The
    regeneration is refused, not stored, not ingested."""
    await _pair(pool)
    _arm_failing(monkeypatch, "device_launch_app", f"{DEVICE}: {FAILED_REASON}")
    regen = "Notepad++ is open on your DELL-XPS-8950 now."
    gateway = ScriptedGateway(
        rounds=(
            (call("device_launch_app", {"device": DEVICE, "app": "notepad++"}, "c1"),),
            (text("I launched Notepad++ on your DELL-XPS-8950."),),
            (text(regen),),
        )
    )
    memory = FakeMemory()
    mount_peers(gateway=gateway, memory=memory)

    await _say(owner_client, "open notepad++ on my dell")

    assert await _stored(pool) != regen
    (span,) = await _named(pool, "device_completion")
    assert span["meta"]["regen_rejected_by"] == "device_completion"
    await chat.drain_background()
    assert memory.ingests == []


@requires_db
@pytest.mark.parametrize(
    "label,first,reply,asked",
    [
        (
            "D a recap",
            None,
            "Today I opened Notepad on your DELL-XPS-8950 and sent you a test notification.",
            "what did you do on my dell today?",
        ),
        (
            "D2 a recap beside a clock read",
            "get_time",
            "Today I opened Notepad on your DELL-XPS-8950 at 15:56.",
            "what did you do on my dell today, and what time is it?",
        ),
        (
            "E a proposal",
            None,
            'To clear your temp folder I would run this:\n```\ndevice_run ["cmd", "/c", '
            '"del", "/q", "/s", "C:\\\\Users\\\\Public\\\\Temp\\\\*"]\n```\nWant me to go ahead?',
            "how would I clear the temp folder on my dell?",
        ),
        (
            "G a warning",
            "get_time",
            'Do not run `device_run ["format", "C:", "/q"]` on your Dell — it would wipe the disk.',
            "what time is it, and is it safe to format my dell's C drive?",
        ),
    ],
)
async def test_recaps_proposals_and_warnings_are_never_turned_into_actions(
    label, first, reply, asked, owner_client, pool, mount_peers, monkeypatch
):
    """(C2, I1a, review D, D2, E, G) Before, each of these took a "do it now"
    redirect: the recap re-launched Notepad, the proposal ran a recursive
    delete, the warning was "corrected" as a call to make. Now nothing fires:
    one answer, no redirect, no tool, the reply as she wrote it."""
    await _pair(pool)
    launcher = _arm(monkeypatch, "device_launch_app", LAUNCHED)
    runner = _arm(monkeypatch, "device_run", f"{DEVICE} ran ['cmd'] — exit 0")
    rounds = [(text(reply),)]
    if first is not None:
        rounds.insert(0, (call(first, {}, "c1"),))
    gateway = ScriptedGateway(rounds=tuple(rounds))
    mount_peers(gateway=gateway, memory=FakeMemory())

    sent = await _say(owner_client, asked)

    assert gateway.calls == len(rounds), label
    assert launcher.calls == [] and runner.calls == [], label
    assert await _stored(pool) == reply, label
    assert _corrections(sent) == [], label
    assert await _named(pool, "written_call") == [], label
    assert await _named(pool, "device_completion") == [], label


@requires_db
async def test_F_the_nudges_own_honest_answer_stands(owner_client, pool, mount_peers, monkeypatch):
    """(I2, review F) Asked to make the call or say plainly she has not, she
    says plainly she has not — and names the call she wrote. Before, the re-vet
    refused that very answer as another written call. Now it stands, with the
    note that says it answered again, and nothing ran."""
    await _pair(pool)
    launcher = _arm(monkeypatch, "device_launch_app", LAUNCHED)
    plain = (
        'I have not run `device_launch_app "DELL-XPS-8950" "Teams"` — I only wrote it as text, '
        "so nothing was launched."
    )
    gateway = ScriptedGateway(rounds=((text(T890B1C63),), (text(plain),)))
    mount_peers(gateway=gateway, memory=FakeMemory())

    sent = await _say(owner_client, T890B1C63_ASKED)

    assert launcher.calls == []
    assert await _stored(pool) == plain
    assert _corrections(sent) == [chat.WRITTEN_CALL_REDIRECT_NOTE_NO_CALL]
    (span,) = await _named(pool, "written_call")
    assert span["meta"]["redirected"] is True
    assert "regen_rejected_by" not in span["meta"]


@requires_db
async def test_a_redirect_that_only_read_never_says_it_did_the_work(
    owner_client, pool, mount_peers, monkeypatch
):
    """(C1) The redirect lists the apps and answers honestly that Notepad is
    installed but not opened. It stands — but the live note says it answered
    again, not "doing that now": a read is not the action."""
    await _pair(pool)
    _arm(monkeypatch, "device_list_apps", f"Apps on {DEVICE}:\nNotepad")
    honest = "Notepad is installed on your DELL-XPS-8950, but I have not opened it."
    gateway = ScriptedGateway(
        rounds=(
            (text(T98ECFB11),),
            (call("device_list_apps", {"device": DEVICE}),),
            (text(honest),),
        )
    )
    mount_peers(gateway=gateway, memory=FakeMemory())

    sent = await _say(owner_client, T98ECFB11_ASKED)

    assert await _stored(pool) == honest
    assert _corrections(sent) == [chat.DEVICE_COMPLETION_REDIRECT_NOTE_NO_CALL]


@requires_db
async def test_H_a_gateway_failure_in_the_redirect_fails_open(
    owner_client, pool, mount_peers, monkeypatch
):
    """(review H) The redirect's gateway refuses: the turn still ships, with the
    correction appended, no error frame, and nothing ingested."""
    await _pair(pool)
    _arm(monkeypatch, "device_launch_app", LAUNCHED)
    gateway = ScriptedGateway(
        rounds=((text(T98ECFB11),), Refusal(502, {"error": {"message": "upstream down"}}))
    )
    memory = FakeMemory()
    mount_peers(gateway=gateway, memory=memory)

    sent = await _say(owner_client, T98ECFB11_ASKED)

    note = chat._device_completion_honest_note(NOTEPAD)
    assert await _stored(pool) == f"{T98ECFB11}\n\n{note}"
    assert not [f for f in sent if isinstance(f, dict) and "error" in f]
    await chat.drain_background()
    assert memory.ingests == []


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
