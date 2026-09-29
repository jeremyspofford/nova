"""The written-call and device-completion guards wired into the live turn.

The owner's test, 2026-09-28 (tests/said_not_done_walk.py): she wrote her own
tool as a fence and said Teams was opening; she said Notepad was open; she
wrote device_info as a fence when asked why nothing opened. Zero calls each
time, no guard fired, and all of it went into her memory.

These drive the real route through a scripted gateway.

Fix round 2 (2026-09-29, the scoped re-review of 83ae4c99), under one
principle: a false positive must cost ONE SENTENCE, never an action the owner
did not ask for.

  * The DEVICE claim is APPEND-class (R-A): no redirect, no tools, no push. The
    turn appends the one correction its record supports — none of the calls
    that would do it ran on that device; one ran for another target; one
    failed, with its reason; one was sent and never answered — and stays out
    of memory. A regeneration it fires on is corrected beside its prose.
  * The WRITTEN call keeps ONE redirect with tools advertised (R-B), through
    `_claim_redirect` — the MODEL makes the call, nothing here turns her text
    into one. Its nudge states facts only, and its regeneration is vetted by
    every guard but its own: a reply she keeps stands.
  * A reply with both ships ONE correction, derived from the final spans.

Every chat-level probe of both reviews is a test here (round 1's A–H, round
2's P1–P7b), asserting what must happen instead.
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


def _span(name: str, *, ok: bool = True, **meta):
    from types import SimpleNamespace

    return SimpleNamespace(kind="tool", name=name, meta={"ok": ok, **meta})


# The one correction the Teams turn ships when its redirect does not stand:
# the written call and the device claim, in one parenthesis (I1, R-A, R-B).
TEAMS_JOINT = (
    "(I wrote device_launch_app as text; it did not run. No device_launch_app or device_run "
    "call ran on DELL-XPS-8950 this turn — Teams was not opened.)"
)
TEAMS_REASON = f"{DEVICE}: no Start-menu app named 'Teams' and no program by that name on PATH"


def _claims_of_every_record() -> list[guards.DeviceCompletionClaim]:
    """One claim for each thing a record can show (R-A), and each kind of
    action — the texts the turn can ship for a device claim."""
    teams_ok = _span("device_launch_app", args_redacted={"app": "Teams", "device": DEVICE})
    tasklist = _span("device_run", args_redacted={"argv": ["tasklist"], "device": DEVICE})
    silent = _span(
        "device_launch_app",
        ok=False,
        args_redacted={"app": "notepad", "device": DEVICE},
        error=f"Error: device '{DEVICE}' did not answer within 120s",
    )
    return [
        NOTEPAD,
        TEAMS,
        _failed_claim(),
        _claim(T98ECFB11, [teams_ok]),
        _claim(T98ECFB11, [tasklist]),
        _claim(T98ECFB11, [silent]),
        _claim("I've stopped the service."),
        _claim("I deleted the temp files on your DELL-XPS-8950."),
        _claim("I sent a notification to your DELL-XPS-8950."),
        _claim("I saved the notes to your DELL-XPS-8950."),
    ]


# -- the texts the turn ships: true, and clean under every guard ---------------


def test_the_written_call_nudge_states_the_facts_and_nothing_else():
    """(R-B) No imperative and no invitation: what her reply contains, where,
    that text never runs a tool, and that none of those calls ran. The model
    decides from the facts."""
    nudge = chat.written_call_redirect_nudge(
        names=("device_launch_app",), where="a code block", ran_a_tool=False
    )
    assert nudge == (
        "Your reply contains a call to device_launch_app written as text in a code block. "
        "Text never runs a tool, and no device_launch_app call ran this turn."
    )
    several = chat.written_call_redirect_nudge(
        names=("device_info", "device_run"), where="inline code", ran_a_tool=False
    )
    assert several == (
        "Your reply contains calls to device_info and device_run written as text in inline "
        "code. Text never runs a tool, and no device_info or device_run call ran this turn."
    )
    for said in (nudge, several):
        lowered = said.lower()
        for invitation in ("make the call", "do it", "keep your reply", "if you meant", "please"):
            assert invitation not in lowered, (invitation, said)
    with pytest.raises(ValueError):
        chat.written_call_redirect_nudge(names=("device_info",), ran_a_tool=True)


def test_the_corrections_say_only_what_the_record_shows_and_invite_nothing():
    """(R-A, R-B) Each correction is the record, set off from her prose — and
    none offers to do anything: "Ask me again and I'll make the call" is gone."""
    assert chat._written_call_honest_note(("device_launch_app",)) == (
        "(I wrote device_launch_app as text; it did not run.)"
    )
    assert chat._written_call_honest_note(("device_info", "device_run")) == (
        "(I wrote device_info and device_run as text; they did not run.)"
    )
    assert NOTEPAD.text == (
        "(No device_launch_app or device_run call ran on DELL-XPS-8950 this turn — Notepad was "
        "not opened.)"
    )
    joint = chat.said_not_done_correction(
        T890B1C63,
        [],
        NAMES,
        [DEVICE],
        wrote=guards.written_call_check(T890B1C63, [], NAMES),
        claimed=TEAMS,
    )
    assert joint == TEAMS_JOINT
    assert _failed_claim().text == f"(device_launch_app failed: {FAILED_REASON}.)"
    for said in (joint, *(claim.text for claim in _claims_of_every_record())):
        assert "Ask me" not in said and "I'll" not in said and "again" not in said, said


def test_a_correction_is_never_empty():
    """(minor) The derived correction falls back to the minimal one the record
    supports, and that one to a fixed true sentence — never to ""."""

    def boom():
        raise RuntimeError("could not derive")

    assert chat._derived_correction(boom, lambda: NOTEPAD.text, "device_completion") == (
        NOTEPAD.text
    )
    assert chat._derived_correction(boom, boom, "written_call") == chat.UNCHECKED_CORRECTION
    assert chat._derived_correction(lambda: "", "", "written_call") == chat.UNCHECKED_CORRECTION
    # While nothing has run since the claims were read, what they found holds.
    assert chat._minimal_said_correction(None, NOTEPAD, [], 0) == NOTEPAD.text
    wrote = guards.written_call_check(T890B1C63, [], NAMES)
    assert chat._minimal_said_correction(wrote, TEAMS, [], 0) == TEAMS_JOINT
    # Once something ran, only what ran — never "it did not run".
    launched = _span("device_launch_app", args_redacted={"app": "Teams", "device": DEVICE})
    assert chat._minimal_said_correction(wrote, TEAMS, [launched], 0) == (
        chat._bare_intent_ran_but_unreported_note("device_launch_app")
    )
    failed = _span(
        "device_launch_app",
        ok=False,
        args_redacted={"app": "Teams", "device": DEVICE},
        error=f"Error: {TEAMS_REASON}",
    )
    assert chat._minimal_said_correction(wrote, TEAMS, [failed], 0) == (
        "(device_launch_app failed: no Start-menu app named 'Teams' and no program by that name "
        "on PATH.)"
    )


def test_every_note_nudge_and_correction_is_clean_under_the_whole_guard_family():
    """Backend text the turn ships or sends must never itself trip a guard —
    the family's pinned property, over every text the pair can produce."""
    wrote = guards.written_call_check(T890B1C63, [], NAMES)
    shipped = (
        chat.written_call_redirect_nudge(names=("device_launch_app",), ran_a_tool=False),
        chat.written_call_redirect_nudge(
            names=("device_info", "device_run"), where="inline code", ran_a_tool=False
        ),
        chat._written_call_honest_note(("device_launch_app",)),
        chat._written_call_honest_note(("web_search", "fetch_url")),
        *(claim.text for claim in _claims_of_every_record()),
        chat.said_not_done_correction(T890B1C63, [], NAMES, [DEVICE], wrote=wrote, claimed=TEAMS),
        chat._minimal_said_correction(wrote, TEAMS, [], 0),
        chat._bare_intent_ran_but_unreported_note("device_launch_app"),
        chat.WRITTEN_CALL_REDIRECT_NOTE,
        chat.WRITTEN_CALL_REDIRECT_NOTE_NO_CALL,
        chat.UNCHECKED_CORRECTION,
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
    redirect; its nudge states the facts, the regeneration CALLS
    device_launch_app (the spy proves the body ran), and its report replaces
    the prose. The completion line in the discarded prose files nothing: the
    regeneration that replaced it was read by that very guard."""
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
    assert _system_nudges(gateway) == [
        chat.written_call_redirect_nudge(names=("device_launch_app",), ran_a_tool=False)
    ]
    assert await _stored(pool) == done
    assert _corrections(sent) == [chat.WRITTEN_CALL_REDIRECT_NOTE]
    assert _texts(sent) == [T890B1C63, done]
    assert sent[-1] == DONE

    spans = await _named(pool, "written_call")
    assert len(spans) == 1
    meta = spans[0]["meta"]
    assert meta["detected"] is True
    assert meta["tools"] == ["device_launch_app"]
    assert meta["where"] == "a code block"
    assert meta["redirected"] is True
    assert await _named(pool, "device_completion") == []
    assert await _named(pool, "deferral") == []

    # She did the work: ordinary knowledge again.
    await chat.drain_background()
    assert [i["exchange"]["assistant"] for i in memory.ingests] == [done]


@requires_db
async def test_P6_a_reply_she_keeps_stands(owner_client, pool, mount_peers, monkeypatch):
    """(R-B, the new Important P6) The why-not turn, verbatim: the nudge states
    the facts, and the regeneration writes device_info as a fence again. The
    written-call guard does not re-vet its own regeneration, so the reply she
    kept STANDS — no correction appended, and the live note says the written
    call did not run, which is true. While it still writes a call that never
    ran it stays out of memory. Prose never dispatches: device_info never ran."""
    await _pair(pool)
    info = _arm(monkeypatch, "device_info", f"{DEVICE} system info:\nWindows 11")
    kept = '```bash\ndevice_info "DELL-XPS-8950"\n```'
    gateway = ScriptedGateway(rounds=((text(T3DEE5106),), (text(kept),)))
    memory = FakeMemory()
    mount_peers(gateway=gateway, memory=memory)

    sent = await _say(owner_client, T3DEE5106_ASKED)

    assert gateway.calls == 2
    assert info.calls == []
    assert await _stored(pool) == kept
    assert _corrections(sent) == [chat.WRITTEN_CALL_REDIRECT_NOTE_NO_CALL]
    assert _texts(sent) == [T3DEE5106, kept]
    (span,) = await _named(pool, "written_call")
    meta = span["meta"]
    assert meta["redirected"] is True
    assert "regen_rejected_by" not in meta
    assert meta["kept_written_call"] == ["device_info"]
    await chat.drain_background()
    assert memory.ingests == []


@requires_db
async def test_P6_the_warning_is_never_a_call(owner_client, pool, mount_peers, monkeypatch):
    """(C2, P6's own script) "Let me warn you:" is not a lead: one answer, no
    redirect, no tool, the reply stored as she wrote it."""
    await _pair(pool)
    runner = _arm(monkeypatch, "device_run", f"{DEVICE} ran format — exit 0")
    warning = 'Let me warn you: `device_run ["format", "C:", "/q"]` wipes the whole disk.'
    gateway = ScriptedGateway(rounds=((text(warning),), (text(warning),)))
    mount_peers(gateway=gateway, memory=FakeMemory())

    sent = await _say(owner_client, "is it safe to format my dell's C drive?")

    assert gateway.calls == 1
    assert runner.calls == []
    assert await _stored(pool) == warning
    assert _corrections(sent) == []
    assert await _named(pool, "written_call") == []


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
    gateway = ScriptedGateway(
        rounds=((text(T890B1C63),), Refusal(502, {"error": {"message": "upstream down"}}))
    )
    memory = FakeMemory()
    mount_peers(gateway=gateway, memory=memory)

    sent = await _say(owner_client, T890B1C63_ASKED)

    assert gateway.calls == 2
    assert launcher.calls == []
    assert await _stored(pool) == f"{T890B1C63}\n\n{TEAMS_JOINT}"
    assert _corrections(sent) == [TEAMS_JOINT]
    assert not [f for f in sent if isinstance(f, dict) and "error" in f]

    (written_span,) = await _named(pool, "written_call")
    assert written_span["meta"]["redirected"] is False
    (completion_span,) = await _named(pool, "device_completion")
    meta = completion_span["meta"]
    assert meta["detected"] is True
    assert meta["phrase"] == "Teams is now opening on your DELL-XPS-8950"
    assert meta["record"] == "none"
    assert meta["redirected"] is False
    assert meta["not_redirected_because"] == "append_class"
    assert meta["correction"] == "joined"

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
    reply = 'Teams is installed. I\'ll launch it: `device_launch_app "DELL-XPS-8950" "Teams"`'
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
@pytest.mark.parametrize("which", ["device claim", "written call"])
async def test_the_responsiveness_check_never_runs_after_one_of_these(
    which, owner_client, pool, mount_peers, monkeypatch
):
    """One redirect per turn, TOTAL, and an APPEND-class correction holds the
    soft check off: with it ON, the device claim costs no extra gateway call
    at all, and the written call's redirect is the only one — no judge, no
    span."""
    await _pair(pool)
    spy = _arm(monkeypatch, "device_launch_app", LAUNCHED)
    done = "I asked your DELL-XPS-8950 to launch Teams; I can't confirm a window opened."
    if which == "device claim":
        rounds: tuple = ((text(T98ECFB11),),)
    else:
        rounds = (
            (text(T890B1C63),),
            (call("device_launch_app", {"device": DEVICE, "app": "Teams"}),),
            (text(done),),
        )
    gateway = ScriptedGateway(rounds=rounds)
    mount_peers(gateway=gateway, memory=FakeMemory())
    resp = await owner_client.put(
        "/api/v1/settings", json={"key": "agents.responsiveness_check", "value": True}
    )
    assert resp.status_code == 200, resp.text

    await _say(owner_client, T98ECFB11_ASKED)

    assert gateway.calls == len(rounds)  # a judge call would be one more: the script's loud 500
    assert spy.calls == ([] if which == "device claim" else [{"device": DEVICE, "app": "Teams"}])
    assert await _named(pool, "responsiveness") == []


@requires_db
async def test_a_device_claim_holds_off_the_text_only_commitment_redirect(
    owner_client, pool, mount_peers
):
    """(R-A) The device claim takes nothing from the redirect budget, but —
    like the other APPEND-class claims (A11) — it holds off the commitment
    redirect, which re-runs no guard and could bring the claim straight back.
    One answer, its correction, no regeneration."""
    await _pair(pool)
    reply = "Notepad is now open on your DELL-XPS-8950. I'll search the web for its shortcuts."
    gateway = ScriptedGateway(rounds=((text(reply),),))
    mount_peers(gateway=gateway, memory=FakeMemory())

    await _say(owner_client, "open notepad on my dell and look up its shortcuts")

    assert gateway.calls == 1
    assert await _stored(pool) == f"{reply}\n\n{_claim(reply).text}"


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


@requires_db
async def test_H_a_gateway_failure_in_the_redirect_fails_open(
    owner_client, pool, mount_peers, monkeypatch
):
    """(review H) The written-call redirect's gateway refuses: the turn still
    ships, with the correction appended, no error frame, and nothing
    ingested."""
    await _pair(pool)
    _arm(monkeypatch, "device_info", f"{DEVICE} system info:\nWindows 11")
    gateway = ScriptedGateway(
        rounds=((text(T3DEE5106),), Refusal(502, {"error": {"message": "upstream down"}}))
    )
    memory = FakeMemory()
    mount_peers(gateway=gateway, memory=memory)

    sent = await _say(owner_client, T3DEE5106_ASKED)

    note = chat._written_call_honest_note(("device_info",))
    assert await _stored(pool) == f"{T3DEE5106}\n\n{note}"
    assert not [f for f in sent if isinstance(f, dict) and "error" in f]
    await chat.drain_background()
    assert memory.ingests == []


@requires_db
@pytest.mark.parametrize("which", ["device claim", "both claims"])
async def test_a_correction_that_cannot_be_derived_falls_back_to_the_record(
    which, owner_client, pool, mount_peers, monkeypatch
):
    """(minor) When the derived correction raises, the turn ships the minimal
    one the record supports — never an empty one."""

    def boom(*_args, **_kwargs):
        raise RuntimeError("could not derive")

    monkeypatch.setattr(chat, "said_not_done_correction", boom)
    await _pair(pool)
    _arm(monkeypatch, "device_launch_app", LAUNCHED)
    if which == "device claim":
        reply, rounds, want = T98ECFB11, ((text(T98ECFB11),),), NOTEPAD.text
    else:
        reply, want = T890B1C63, TEAMS_JOINT
        rounds = ((text(T890B1C63),), Refusal(502, {"error": {"message": "upstream down"}}))
    gateway = ScriptedGateway(rounds=rounds)
    mount_peers(gateway=gateway, memory=FakeMemory())

    sent = await _say(owner_client, T98ECFB11_ASKED)

    assert await _stored(pool) == f"{reply}\n\n{want}"
    assert _corrections(sent) == [want]


# -- the device-completion guard, live: APPEND-class (R-A) --------------------


@requires_db
async def test_the_notepad_claim_is_corrected_once_and_never_redirected(
    owner_client, pool, mount_peers, monkeypatch
):
    """(R-A) The Notepad turn, verbatim. No redirect, no tools, no push: ONE
    gateway call, no nudge sent, nothing launched — the correction that states
    the record is appended, and the turn stays out of memory."""
    await _pair(pool)
    launcher = _arm(monkeypatch, "device_launch_app", LAUNCHED.replace("Teams", "notepad"))
    gateway = ScriptedGateway(rounds=((text(T98ECFB11),),))
    memory = FakeMemory()
    mount_peers(gateway=gateway, memory=memory)

    sent = await _say(owner_client, T98ECFB11_ASKED)

    assert gateway.calls == 1
    assert _system_nudges(gateway) == []
    assert launcher.calls == []
    assert await _stored(pool) == f"{T98ECFB11}\n\n{NOTEPAD.text}"
    assert _corrections(sent) == [NOTEPAD.text]
    (span,) = await _named(pool, "device_completion")
    meta = span["meta"]
    assert meta["detected"] is True
    assert meta["phrase"] == "Notepad is now open on your DELL-XPS-8950"
    assert meta["device"] == DEVICE
    assert meta["action"] == "launch"
    assert meta["record"] == "none"
    assert meta["redirected"] is False
    assert meta["not_redirected_because"] == "append_class"
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


# -- the reviews' chat-level probes, each asserting what must happen ----------


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
@pytest.mark.parametrize(
    "label,tool,args,reply,correction",
    [
        (
            "P1 a tasklist filter naming notepad, then 'Notepad is now open'",
            "device_run",
            {"device": DEVICE, "argv": ["tasklist", "/fi", "imagename eq notepad.exe"]},
            "Notepad is now open on your DELL-XPS-8950.",
            "(device_run ran for `tasklist /fi imagename eq notepad.exe`, not Notepad.)",
        ),
        (
            "P2 a tasklist, then 'I closed Notepad'",
            "device_run",
            {"device": DEVICE, "argv": ["tasklist"]},
            "I closed Notepad on your DELL-XPS-8950.",
            "(device_run ran for `tasklist`, not Notepad.)",
        ),
        (
            "P3 an Edge launch, then 'Microsoft Teams is now open'",
            "device_launch_app",
            {"device": DEVICE, "app": "Microsoft Edge"},
            "Microsoft Teams is now open on your DELL-XPS-8950.",
            "(device_launch_app ran for Microsoft Edge, not Microsoft Teams.)",
        ),
        (
            "P4 a shell read that ran, then 'Notepad is now open'",
            "device_run",
            {"device": DEVICE, "argv": ["tasklist"]},
            T98ECFB11,
            "(device_run ran for `tasklist`, not Notepad.)",
        ),
        (
            "P4b a Teams launch that ran, then 'Notepad is now open'",
            "device_launch_app",
            {"device": DEVICE, "app": "Teams"},
            T98ECFB11,
            "(device_launch_app ran for Teams, not Notepad.)",
        ),
        (
            "B1 a read of the apps, then 'Notepad is now open'",
            "device_list_apps",
            {"device": DEVICE},
            T98ECFB11,
            NOTEPAD.text,
        ),
    ],
)
async def test_P1_to_P4b_what_she_ran_never_backs_another_action(
    label, tool, args, reply, correction, owner_client, pool, mount_peers, monkeypatch
):
    """(C1, R-A, review P1–P4b and B1) She calls one thing and claims another.
    A read, a shell read naming the app, a launch of another app: none backs
    the claim. There is no redirect — nothing is launched, no "doing it now"
    is said — and the ONE correction says what the record shows, never that
    nothing ran when something did."""
    await _pair(pool)
    ran = _arm(monkeypatch, tool, f"{DEVICE}: done")
    launcher = (
        ran if tool == "device_launch_app" else _arm(monkeypatch, "device_launch_app", LAUNCHED)
    )
    gateway = ScriptedGateway(rounds=((call(tool, args, "c1"),), (text(reply),)))
    memory = FakeMemory()
    mount_peers(gateway=gateway, memory=memory)

    sent = await _say(owner_client, T98ECFB11_ASKED)

    assert gateway.calls == 2, label  # her call and her reply; no redirect
    assert ran.calls == [args], label
    if tool != "device_launch_app":
        assert launcher.calls == [], label
    assert _system_nudges(gateway) == [], label
    assert await _stored(pool) == f"{reply}\n\n{correction}", label
    assert _corrections(sent) == [correction], label
    if tool in guards.DEVICE_ACTION_TOOLS["launch"]:
        # A call that could have opened it ran: never "no … call ran" (P4, P4b).
        assert not correction.startswith("(No "), label
    await chat.drain_background()
    assert memory.ingests == [], label


@requires_db
async def test_P3_a_redirect_that_launches_another_app_is_corrected_beside_it(
    owner_client, pool, mount_peers, monkeypatch
):
    """(C1, P3's own script) The Teams turn: the written call's redirect
    launches Microsoft Edge, then says "Microsoft Teams is now open". The
    regeneration stands — it is a report of a call she really made — and the
    device claim in it is corrected beside it, from the record. Not ingested."""
    await _pair(pool)
    _arm(
        monkeypatch,
        "device_launch_app",
        f"{DEVICE}: asked Windows to launch Microsoft Edge — whether a window opened is not "
        "confirmed.",
    )
    regen = "Microsoft Teams is now open on your DELL-XPS-8950."
    gateway = ScriptedGateway(
        rounds=(
            (text(T890B1C63),),
            (call("device_launch_app", {"device": DEVICE, "app": "Microsoft Edge"}),),
            (text(regen),),
        )
    )
    memory = FakeMemory()
    mount_peers(gateway=gateway, memory=memory)

    sent = await _say(owner_client, T890B1C63_ASKED)

    correction = "(device_launch_app ran for Microsoft Edge, not Microsoft Teams.)"
    assert await _stored(pool) == f"{regen}\n\n{correction}"
    assert _corrections(sent) == [chat.WRITTEN_CALL_REDIRECT_NOTE, correction]
    (written_span,) = await _named(pool, "written_call")
    assert written_span["meta"]["redirected"] is True
    assert written_span["meta"]["regen_appended"] == ["device_completion"]
    (completion_span,) = await _named(pool, "device_completion")
    assert completion_span["meta"]["record"] == "other"
    assert completion_span["meta"]["not_redirected_because"] == "append_class"
    await chat.drain_background()
    assert memory.ingests == []


@requires_db
@pytest.mark.parametrize(
    "label,answer,asked,tool",
    [
        (
            "P5 a how-it-works answer",
            "Notifications are sent to your DELL-XPS-8950 when a timer fires.",
            "how do timer notifications reach my dell?",
            "device_notify",
        ),
        (
            "P5b a how-to answer",
            "As soon as Teams has launched on your PC, click Join in the calendar invite.",
            "how do I join a teams meeting on my dell?",
            "device_launch_app",
        ),
    ],
)
async def test_P5_an_explanation_is_never_a_claim_or_an_action(
    label, answer, asked, tool, owner_client, pool, mount_peers, monkeypatch
):
    """(C2, review P5 and P5b) Before, "Notifications are sent to your Dell
    when a timer fires" fired, and the "do it now" nudge drove a real
    notification. Now it is how it works: no span, no redirect, no tool, the
    answer as she wrote it."""
    await _pair(pool)
    spy = _arm(monkeypatch, tool, f"{DEVICE}: done")
    gateway = ScriptedGateway(rounds=((text(answer),),))
    mount_peers(gateway=gateway, memory=FakeMemory())

    sent = await _say(owner_client, asked)

    assert gateway.calls == 1, label
    assert spy.calls == [], label
    assert await _stored(pool) == answer, label
    assert _corrections(sent) == [], label
    assert await _named(pool, "device_completion") == [], label


@requires_db
async def test_P7_A_a_backend_check_never_backs_her_claim(
    owner_client, pool, mount_peers, monkeypatch
):
    """(C1, reviews A and P7) A live check the BACKEND ran unasked read the
    Dell's apps; it launched nothing. The Notepad claim fires, and — APPEND
    class — is corrected once, without a redirect: the record shows no call
    that opens anything ran on the Dell, which is true (a read is not one)."""
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
    assert await _stored(pool) == f"{T98ECFB11}\n\n{NOTEPAD.text}"
    assert _corrections(sent)[-1] == NOTEPAD.text
    (span,) = await _named(pool, "device_completion")
    assert span["meta"]["not_redirected_because"] == "append_class"
    await chat.drain_background()
    assert memory.ingests == []


@requires_db
async def test_P7b_a_backend_check_and_the_teams_turn_ship_one_correction(
    owner_client, pool, mount_peers, monkeypatch
):
    """(reviews P7b) The backend's unasked read counts as a tool that ran, so
    the written call's redirect is refused (a CARRY: excluding unasked spans
    from ran_a_tool changes _claim_redirect for every claim kind). The turn
    ships ONE correction for the written call and the claim beside it."""
    await _pair(pool)
    _arm(monkeypatch, "device_list_apps", f"Apps on {DEVICE}:\n2 apps\nNotepad\nTeams")
    launcher = _arm(monkeypatch, "device_launch_app", LAUNCHED)
    memory = _apps_memory()
    gateway = ScriptedGateway(rounds=((text(T890B1C63),),))
    mount_peers(gateway=gateway, memory=memory)

    sent = await _say(owner_client, T890B1C63_ASKED)

    assert gateway.calls == 1
    assert launcher.calls == []
    assert await _stored(pool) == f"{T890B1C63}\n\n{TEAMS_JOINT}"
    assert _corrections(sent)[-1] == TEAMS_JOINT
    (written_span,) = await _named(pool, "written_call")
    assert written_span["meta"]["not_redirected_because"] == "tools_already_ran"
    (completion_span,) = await _named(pool, "device_completion")
    assert completion_span["meta"]["correction"] == "joined"
    await chat.drain_background()
    assert memory.ingests == []


@requires_db
async def test_B3_a_written_call_redirect_that_reads_instead_is_corrected_beside_it(
    owner_client, pool, mount_peers, monkeypatch
):
    """(C1, review B3) The Teams turn: the redirect calls device_info instead
    of the launch, then says Teams is open. The note never says "making that
    call"; the regeneration stands, and its claim is corrected beside it —
    a read is not a launch."""
    await _pair(pool)
    info = _arm(monkeypatch, "device_info", f"{DEVICE} system info:\nWindows 11 Pro")
    launcher = _arm(monkeypatch, "device_launch_app", LAUNCHED)
    regen = "Teams is now open on your DELL-XPS-8950."
    gateway = ScriptedGateway(
        rounds=(
            (text(T890B1C63),),
            (call("device_info", {"device": DEVICE}),),
            (text(regen),),
        )
    )
    memory = FakeMemory()
    mount_peers(gateway=gateway, memory=memory)

    sent = await _say(owner_client, T890B1C63_ASKED)

    assert info.calls == [{"device": DEVICE}]
    assert launcher.calls == []
    correction = _claim(regen).text
    assert await _stored(pool) == f"{regen}\n\n{correction}"
    assert _corrections(sent) == [chat.WRITTEN_CALL_REDIRECT_NOTE_NO_CALL, correction]
    await chat.drain_background()
    assert memory.ingests == []


@requires_db
async def test_B4_a_redirect_that_reads_then_writes_the_launch_again_stands_unremembered(
    owner_client, pool, mount_peers, monkeypatch
):
    """(R-B, review B4) The redirect reads the Dell, then writes the launch as
    text again. Its own guard does not refuse it — she kept her way of saying
    it — so it stands, with no correction; the note says the written call did
    not run, which is true; and it stays out of memory. Nothing launched."""
    await _pair(pool)
    _arm(monkeypatch, "device_info", f"{DEVICE} system info:\nWindows 11 Pro")
    launcher = _arm(monkeypatch, "device_launch_app", LAUNCHED)
    regen = 'Launching now:\n```\ndevice_launch_app "DELL-XPS-8950" "Teams"\n```'
    gateway = ScriptedGateway(
        rounds=(
            (text(T890B1C63),),
            (call("device_info", {"device": DEVICE}),),
            (text(regen),),
        )
    )
    memory = FakeMemory()
    mount_peers(gateway=gateway, memory=memory)

    sent = await _say(owner_client, T890B1C63_ASKED)

    assert launcher.calls == []
    assert await _stored(pool) == regen
    assert _corrections(sent) == [chat.WRITTEN_CALL_REDIRECT_NOTE_NO_CALL]
    (span,) = await _named(pool, "written_call")
    assert span["meta"]["kept_written_call"] == ["device_launch_app"]
    await chat.drain_background()
    assert memory.ingests == []


@requires_db
async def test_B5_a_failed_launch_in_the_redirect_is_stated_with_its_reason(
    owner_client, pool, mount_peers, monkeypatch
):
    """(I1, review B5) The Teams turn: the redirect really calls
    device_launch_app and it FAILS; its closing round claims Teams is open.
    The note says the call was made (it was), and the claim is corrected
    beside the regeneration with the failure and its reason — one correction,
    never "nothing ran"."""
    await _pair(pool)
    attempts = _arm_failing(monkeypatch, "device_launch_app", TEAMS_REASON)
    regen = "Teams is now open on your DELL-XPS-8950."
    gateway = ScriptedGateway(
        rounds=(
            (text(T890B1C63),),
            (call("device_launch_app", {"device": DEVICE, "app": "Teams"}),),
            (text(regen),),
        )
    )
    memory = FakeMemory()
    mount_peers(gateway=gateway, memory=memory)

    sent = await _say(owner_client, T890B1C63_ASKED)

    assert attempts == [{"device": DEVICE, "app": "Teams"}]
    one = (
        "(device_launch_app failed: no Start-menu app named 'Teams' and no program by that name "
        "on PATH.)"
    )
    assert await _stored(pool) == f"{regen}\n\n{one}"
    assert _corrections(sent) == [chat.WRITTEN_CALL_REDIRECT_NOTE, one]
    (completion_span,) = await _named(pool, "device_completion")
    assert completion_span["meta"]["record"] == "failed"
    await chat.drain_background()
    assert memory.ingests == []


@requires_db
@pytest.mark.parametrize(
    "claimed",
    [
        "I launched Notepad++ on your DELL-XPS-8950.",
        "Notepad++ is open on your DELL-XPS-8950 now.",
    ],
)
async def test_C_a_failed_launch_is_stated_with_its_reason_and_never_retried(
    claimed, owner_client, pool, mount_peers, monkeypatch
):
    """(I1, reviews C and C2) She called device_launch_app, it FAILED, and she
    said it opened. No redirect, so no retry and no push: the correction
    states the failure with its reason, and the turn stays out of memory."""
    await _pair(pool)
    attempts = _arm_failing(monkeypatch, "device_launch_app", f"{DEVICE}: {FAILED_REASON}")
    gateway = ScriptedGateway(
        rounds=(
            (call("device_launch_app", {"device": DEVICE, "app": "notepad++"}, "c1"),),
            (text(claimed),),
        )
    )
    memory = FakeMemory()
    mount_peers(gateway=gateway, memory=memory)

    sent = await _say(owner_client, "open notepad++ on my dell")

    assert gateway.calls == 2
    assert attempts == [{"device": DEVICE, "app": "notepad++"}]  # never retried
    assert _system_nudges(gateway) == []
    correction = _failed_claim().text
    assert await _stored(pool) == f"{claimed}\n\n{correction}"
    assert _corrections(sent) == [correction]
    (span,) = await _named(pool, "device_completion")
    assert span["meta"]["record"] == "failed"
    assert span["meta"]["record_tool"] == "device_launch_app"
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
    """(I2, review F) Told the facts, she says plainly she has not made the
    call — and names the call she wrote. It stands, with the note that says
    the written call did not run, and nothing ran."""
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
    assert "kept_written_call" not in span["meta"]


@requires_db
async def test_a_redirect_that_only_read_never_says_it_made_the_call(
    owner_client, pool, mount_peers, monkeypatch
):
    """(C1) The written call's redirect lists the apps and answers honestly
    that Teams is installed but not opened. It stands — but the live note says
    the written call did not run, not "making that call now": a read is not
    the call she wrote."""
    await _pair(pool)
    _arm(monkeypatch, "device_list_apps", f"Apps on {DEVICE}:\nTeams")
    honest = "Teams is installed on your DELL-XPS-8950, but I have not opened it."
    gateway = ScriptedGateway(
        rounds=(
            (text(T890B1C63),),
            (call("device_list_apps", {"device": DEVICE}),),
            (text(honest),),
        )
    )
    mount_peers(gateway=gateway, memory=FakeMemory())

    sent = await _say(owner_client, T890B1C63_ASKED)

    assert await _stored(pool) == honest
    assert _corrections(sent) == [chat.WRITTEN_CALL_REDIRECT_NOTE_NO_CALL]


# -- the rest of the family is vetted by them too ------------------------------


@requires_db
async def test_another_claims_regen_that_writes_a_call_is_refused_by_name(
    owner_client, pool, mount_peers
):
    """The full-set vetting reaches every OTHER redirect: the state claim's
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


@requires_db
async def test_another_claims_regen_with_a_device_claim_is_corrected_beside_it(
    owner_client, pool, mount_peers
):
    """(R-A) The device-completion guard is APPEND-class over every
    regeneration too: the state claim's regeneration says Notepad is open
    with nothing run — it stands, corrected beside it, and the turn stays out
    of memory. It is no longer thrown away over the side line."""
    await _pair(pool)
    regen = "Notepad is now open on your DELL-XPS-8950."
    gateway = ScriptedGateway(
        rounds=((text("Looks like the device is still offline."),), (text(regen),))
    )
    memory = FakeMemory()
    mount_peers(gateway=gateway, memory=memory)

    await _say(owner_client, "try again")

    assert gateway.calls == 2
    (span,) = await _named(pool, "state_claim")
    assert span["meta"]["redirected"] is True
    assert span["meta"]["regen_appended"] == ["device_completion"]
    assert await _stored(pool) == f"{regen}\n\n{NOTEPAD.text}"
    await chat.drain_background()
    assert memory.ingests == []
