"""The written-call and device-completion guards wired into the live turn.

The owner's test, 2026-09-28 (tests/said_not_done_walk.py): she wrote her own
tool as a fence and said Teams was opening; she said Notepad was open; she
wrote device_info as a fence when asked why nothing opened. Zero calls each
time, no guard fired, and all of it went into her memory.

These drive the real route through a scripted gateway.

Fix round 3 (2026-09-29, the controller's rulings T1-T5): the pair is
APPEND-ONLY, with NO redirects — the owner shelved the analogous handback guard
the same day, because a redirect that invites action cannot be made safe with
regex detection. So:

  * T1: neither guard redirects, nudges, advertises a tool, takes the redirect
    budget or holds another redirect off. A false fire costs one sentence;
  * T2: a written call appends exactly "(I wrote <tool> as text; it did not
    run.)";
  * T3: a device claim is silent when any call of its tools succeeded on that
    device (any device for "your PC"), else says only what the record shows;
  * T4: both are read ONCE, at the END of the turn, after every other guard's
    redirect, over the prose that persists as hers and the FINAL spans;
  * T5: the backend's own notes are never read as her words, and the pair
    never ships "[I ran X but could not report the result…]".

Every chat-level probe of the three reviews is a test here (round 1's A–H,
round 2's P1–P7b, round 3's R1–R4), asserting what must happen instead.
"""

from __future__ import annotations

import inspect
import json
import os
import re
import uuid
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path

import pytest

from app import chat, guards, tools, traces
from app.identity import Person
from app.tools import devices as device_tools
from app.tools import web_search as web_search_tools
from app.tools.base import Tool, ToolContext, ToolFailure
from tests.conftest import requires_db
from tests.fakes import FakeMemory, Refusal, ScriptedGateway
from tests.said_not_done_walk import (
    DEVICE,
    FE7E3198,
    FE7E3198_ASKED,
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
F = "```"

# The sentences the pair appends, verbatim (T2, T3).
WROTE_LAUNCH = "(I wrote device_launch_app as text; it did not run.)"
WROTE_INFO = "(I wrote device_info as text; it did not run.)"
NONE_ON_DELL = "(No device_launch_app or device_run call ran on DELL-XPS-8950 this turn.)"
FAILED_REASON = "no Start-menu app named 'notepad++' and no program by that name on PATH"
FAILED_LAUNCH = f"(device_launch_app failed: {FAILED_REASON}.)"
NO_ANSWER = "(device_launch_app was sent but did not answer — whether it worked is not known.)"


class Spy:
    def __init__(self, result: str) -> None:
        self.calls: list = []
        self.result = result

    async def __call__(self, args: dict, ctx: ToolContext) -> str:
        self.calls.append(args)
        return self.result


def _arm(monkeypatch, name: str, result: str, *, schema: dict | None = None) -> Spy:
    """The registered tool with its REAL schema and its REAL flags, and a spy
    body: a call validates like a real one, the spy proves the executor ran,
    and a read stays a read (a backend live check may run it unasked).
    Ephemeral turned off, so a turn that ran it is ingested like any other."""
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


async def _set(client, key: str, value) -> None:
    resp = await client.put("/api/v1/settings", json={"key": key, "value": value})
    assert resp.status_code == 200, resp.text


async def _guard_spans(pool) -> list:
    return await pool.fetch(
        "SELECT name, meta FROM turn_spans WHERE kind = 'guard' ORDER BY started_at"
    )


async def _named(pool, name: str) -> list:
    return [row for row in await _guard_spans(pool) if row["name"] == name]


def _meta(row) -> dict:
    meta = row["meta"]
    return meta if isinstance(meta, dict) else json.loads(meta)


async def _stored(pool) -> str:
    return await pool.fetchval("SELECT content FROM messages WHERE role = 'assistant'")


def _corrections(sent: list) -> list[str]:
    return [f["correction"] for f in sent if isinstance(f, dict) and "correction" in f]


def _texts(sent: list) -> list[str]:
    return [f["t"] for f in sent if isinstance(f, dict) and "t" in f]


async def _reached_executor(pool) -> list[str]:
    """The tool spans whose call REACHED its tool's executor, by name, in order:
    `reached_executor`, dispatch's own record on the span _run_tool files. A call
    refused as text, in a closed round, or before any executor (no such tool,
    bad arguments) is recorded as a span too, but ran nothing, so it is not
    here. It is the one property a redirect's live note is chosen by
    (said-not-done P6), so every test that asks "was a call dispatched" asks
    this, never "is there a tool span"."""
    rows = await pool.fetch(
        "SELECT name FROM turn_spans WHERE kind = 'tool' "
        """AND meta @> '{"reached_executor": true}' ORDER BY started_at"""
    )
    return [row["name"] for row in rows]


def _system_nudges(gateway) -> list[str]:
    out = []
    for body in gateway.payloads:
        messages = body.get("messages") or []
        if messages and messages[-1].get("role") == "system":
            out.append(messages[-1]["content"])
    return out


def _span(name: str, *, ok: bool = True, **meta):
    from types import SimpleNamespace

    return SimpleNamespace(kind="tool", name=name, meta={"ok": ok, **meta})


def _claims_of_every_record() -> list[guards.DeviceCompletionClaim]:
    """One claim for each thing a record can show, and each kind of action —
    every device sentence the turn can append (T3)."""
    silent = _span(
        "device_launch_app",
        ok=False,
        args_redacted={"app": "notepad", "device": DEVICE},
        error=f"Error: device '{DEVICE}' did not answer within 120s",
    )
    failed = _span(
        "device_launch_app",
        ok=False,
        args_redacted={"app": "notepad++", "device": DEVICE},
        error=f"Error: {DEVICE}: {FAILED_REASON}",
    )
    claims = [
        guards.device_completion_check(reply, spans, NAMES, [DEVICE])
        for reply, spans in (
            (T98ECFB11, []),
            (T890B1C63, []),
            ("I launched Notepad++ on your DELL-XPS-8950.", [failed]),
            (T98ECFB11, [silent]),
            ("I've stopped the service.", []),
            ("I deleted the temp files on your DELL-XPS-8950.", []),
            ("I sent a notification to your DELL-XPS-8950.", []),
            ("I saved the notes to your DELL-XPS-8950.", []),
            ("Firefox is now open on your PC.", []),
        )
    ]
    assert all(claim is not None for claim in claims)
    return claims


# -- the sentences: the record, and nothing else (T2, T3) ------------------------


def test_the_sentences_say_only_what_the_record_shows_and_invite_nothing():
    wrote = guards.written_call_check(T890B1C63, [], NAMES)
    assert wrote is not None and wrote.text == WROTE_LAUNCH
    texts_ = [claim.text for claim in _claims_of_every_record()]
    assert texts_ == [
        NONE_ON_DELL,
        NONE_ON_DELL,
        FAILED_LAUNCH,
        NO_ANSWER,
        "(No device_run call ran this turn.)",
        "(No device_run call ran on DELL-XPS-8950 this turn.)",
        "(No device_notify or device_run call ran on DELL-XPS-8950 this turn.)",
        "(No device_write_file or device_run call ran on DELL-XPS-8950 this turn.)",
        "(No device_launch_app or device_run call ran on your PC this turn.)",
    ]
    for said in (WROTE_LAUNCH, *texts_):
        lowered = said.lower()
        for invitation in ("ask me", "again", "i'll", "want", "?", "please", " not opened"):
            assert invitation not in lowered, (invitation, said)


def test_every_sentence_is_clean_under_the_whole_guard_family():
    """Backend text the turn ships must never itself trip a guard — the
    family's pinned property, over every sentence the pair can append."""
    shipped = (
        WROTE_LAUNCH,
        guards.WrittenCallClaim(tools=("web_search", "fetch_url"), phrase="x").text,
        *(claim.text for claim in _claims_of_every_record()),
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


def test_no_redirect_path_is_left_for_the_pair():
    """(T1) The redirect, its nudge, its notes and the plumbing it alone needed
    are gone: no regeneration is vetted by either guard (they refuse nothing),
    `_claim_redirect` takes no correction/did-the-work hooks, and nothing
    builds the pair a correction of its own — so nothing can ship "[I ran X
    but could not report the result…]" for it (T5). The one path left is the
    end-of-turn block, which appends each claim's `text` and nothing else."""
    for gone in (
        "written_call_redirect_nudge",
        "WRITTEN_CALL_REDIRECT_NOTE",
        "WRITTEN_CALL_REDIRECT_NOTE_NO_CALL",
        "_said_not_done_redirect",
        "said_not_done_correction",
        "_minimal_said_correction",
        "_derived_correction",
        "UNCHECKED_CORRECTION",
        "_regen_append_claims",
    ):
        assert not hasattr(chat, gone), gone
    params = inspect.signature(chat._claim_redirect).parameters
    for hook in ("correction_for", "did_the_work", "exempt_from_vetting"):
        assert hook not in params, hook
    assert "exempt" not in inspect.signature(chat._regen_rejected_by).parameters
    for fn in (chat._regen_rejected_by, chat._claim_redirect, chat._append_class_claims):
        source = inspect.getsource(fn)
        assert "written_call" not in source and "device_completion" not in source, fn.__name__
    turn = inspect.getsource(chat._run_turn)
    block = turn[turn.index("# The SAID-NOT-DONE pair") : turn.index("# The record boundary.")]
    assert "_claim_redirect" not in block
    assert "_bare_intent_ran_but_unreported_note" not in block
    assert "redirect_spent" not in block


# -- the owner's turns, live ---------------------------------------------------


@requires_db
async def test_the_teams_turn_gets_its_two_sentences_and_no_redirect(
    owner_client, pool, mount_peers, monkeypatch
):
    """890b1c63, verbatim. ONE gateway call: no redirect, no nudge, no tool —
    the launch she wrote as a fence is never run. The turn appends the two
    sentences the record supports, one per guard, in order, and stays out of
    memory."""
    await _pair(pool)
    launcher = _arm(monkeypatch, "device_launch_app", LAUNCHED)
    gateway = ScriptedGateway(rounds=((text(T890B1C63),),))
    memory = FakeMemory()
    mount_peers(gateway=gateway, memory=memory)

    sent = await _say(owner_client, T890B1C63_ASKED)

    assert gateway.calls == 1
    assert _system_nudges(gateway) == []
    assert launcher.calls == []
    assert await _stored(pool) == f"{T890B1C63}\n\n{WROTE_LAUNCH}\n\n{NONE_ON_DELL}"
    assert _corrections(sent) == [WROTE_LAUNCH, NONE_ON_DELL]
    assert _texts(sent) == [T890B1C63]
    assert sent[-1] == DONE

    (written,) = await _named(pool, "written_call")
    assert _meta(written) == {
        "detected": True,
        "tools": ["device_launch_app"],
        "phrase": 'device_launch_app "DELL-XPS-8950" "Teams"',
        "where": "a code block",
        "sentence": WROTE_LAUNCH,
    }
    (completion,) = await _named(pool, "device_completion")
    meta = _meta(completion)
    assert meta["phrase"] == "Teams is now opening on your DELL-XPS-8950"
    assert meta["record"] == "none"
    assert meta["sentence"] == NONE_ON_DELL
    assert "redirected" not in meta

    await chat.drain_background()
    assert memory.ingests == []


@requires_db
async def test_the_why_not_turn_gets_the_written_sentence(
    owner_client, pool, mount_peers, monkeypatch
):
    """3dee5106, verbatim: device_info written as a fence (device_list_processes
    is not her tool, so it is not named). One sentence, nothing run."""
    await _pair(pool)
    info = _arm(monkeypatch, "device_info", f"{DEVICE} system info:\nWindows 11")
    gateway = ScriptedGateway(rounds=((text(T3DEE5106),),))
    memory = FakeMemory()
    mount_peers(gateway=gateway, memory=memory)

    sent = await _say(owner_client, T3DEE5106_ASKED)

    assert gateway.calls == 1
    assert info.calls == []
    assert await _stored(pool) == f"{T3DEE5106}\n\n{WROTE_INFO}"
    assert _corrections(sent) == [WROTE_INFO]
    assert await _named(pool, "device_completion") == []
    await chat.drain_background()
    assert memory.ingests == []


@requires_db
async def test_the_notepad_turn_gets_the_none_sentence_and_nothing_else(
    owner_client, pool, mount_peers, monkeypatch
):
    """98ecfb11, verbatim (R-A, T3). No redirect, no tools, no push: the
    sentence that states the record, and the turn stays out of memory."""
    await _pair(pool)
    launcher = _arm(monkeypatch, "device_launch_app", LAUNCHED.replace("Teams", "notepad"))
    gateway = ScriptedGateway(rounds=((text(T98ECFB11),),))
    memory = FakeMemory()
    mount_peers(gateway=gateway, memory=memory)

    sent = await _say(owner_client, T98ECFB11_ASKED)

    assert gateway.calls == 1
    assert _system_nudges(gateway) == []
    assert launcher.calls == []
    assert await _stored(pool) == f"{T98ECFB11}\n\n{NONE_ON_DELL}"
    assert _corrections(sent) == [NONE_ON_DELL]
    (span,) = await _named(pool, "device_completion")
    meta = _meta(span)
    assert meta["phrase"] == "Notepad is now open on your DELL-XPS-8950"
    assert meta["device"] == DEVICE
    assert meta["action"] == "launch"
    assert meta["record"] == "none"
    await chat.drain_background()
    assert memory.ingests == []


@requires_db
async def test_the_brave_turn_with_its_real_launch_is_silent(
    owner_client, pool, mount_peers, monkeypatch
):
    """fe7e3198: she really called device_launch_app. Nothing fires; the turn
    is ordinary knowledge."""
    await _pair(pool)
    spy = _arm(monkeypatch, "device_launch_app", LAUNCHED.replace("Teams", "brave"))
    gateway = ScriptedGateway(
        rounds=(
            (call("device_launch_app", {"device": DEVICE, "app": "brave"}, "c1"),),
            (text(FE7E3198),),
        )
    )
    memory = FakeMemory()
    mount_peers(gateway=gateway, memory=memory)

    sent = await _say(owner_client, FE7E3198_ASKED)

    assert spy.calls == [{"device": DEVICE, "app": "brave"}]
    assert await _stored(pool) == FE7E3198
    assert _corrections(sent) == []
    assert await _named(pool, "device_completion") == []
    assert await _named(pool, "written_call") == []
    await chat.drain_background()
    assert [i["exchange"]["assistant"] for i in memory.ingests] == [FE7E3198]


# -- round 3's chat probes (scratchpad rr3/test_rr3_chat.py) --------------------


@requires_db
async def test_R1_a_warning_above_a_format_command_is_never_an_action(
    owner_client, pool, mount_peers, monkeypatch
):
    """(R1) "Running this formats your C: drive:" above a `format C: /q`
    fence. Round 2 read the gerund as her lead and took a redirect with every
    tool advertised; scripted, the model then ran the format. Now: one gateway
    call, no nudge, nothing run — and the warning is no call of hers at all,
    so it stands as she wrote it. The script's next two rounds are never
    asked for."""
    await _pair(pool)
    runner = _arm(monkeypatch, "device_run", f"{DEVICE} ran format — exit 0")
    warning = f'Running this formats your C: drive:\n{F}\ndevice_run ["format", "C:", "/q"]\n{F}'
    gateway = ScriptedGateway(
        rounds=(
            (text(warning),),
            (call("device_run", {"device": DEVICE, "argv": ["format", "C:", "/q"]}),),
            (text("Done."),),
        )
    )
    mount_peers(gateway=gateway, memory=FakeMemory())

    sent = await _say(owner_client, "what would formatting my dell's C drive look like?")

    assert gateway.calls == 1
    assert _system_nudges(gateway) == []
    assert runner.calls == []
    assert await _stored(pool) == warning
    assert _corrections(sent) == []
    assert await _named(pool, "written_call") == []


@requires_db
@pytest.mark.parametrize(
    "label,reply",
    [
        ("a bare fence as the answer", f'{F}\ndevice_run ["shutdown", "/r", "/t", "0"]\n{F}'),
        (
            "a lead, then a refusal",
            f'I\'ll run it:\n{F}\ndevice_run ["format", "C:", "/q"]\n{F}\n'
            "Actually, no — that's too risky.",
        ),
        (
            "a lead that gives him the command",
            f'I\'ll send you the command:\n{F}\ndevice_run ["shutdown", "/r", "/t", "0"]\n{F}',
        ),
    ],
)
async def test_R1_a_false_fire_costs_one_true_sentence_and_nothing_runs(
    label, reply, owner_client, pool, mount_peers, monkeypatch
):
    """(T1, T2) The shapes that still read as her call written as text: each
    costs exactly one sentence — true of each: she wrote it, it did not run —
    and never an action. One gateway call; the runner is never called."""
    await _pair(pool)
    runner = _arm(monkeypatch, "device_run", f"{DEVICE} ran — exit 0")
    gateway = ScriptedGateway(
        rounds=((text(reply),), (call("device_run", {"device": DEVICE, "argv": ["x"]}),))
    )
    mount_peers(gateway=gateway, memory=FakeMemory())

    sent = await _say(owner_client, "how do I restart my dell from here?")

    wrote = "(I wrote device_run as text; it did not run.)"
    assert gateway.calls == 1, label
    assert _system_nudges(gateway) == [], label
    assert runner.calls == [], label
    assert await _stored(pool) == f"{reply}\n\n{wrote}", label
    assert _corrections(sent) == [wrote], label


@requires_db
async def test_R2_an_honest_launch_by_an_apps_list_id_is_never_corrected(
    owner_client, pool, mount_peers, monkeypatch
):
    """(R2, T3) She lists the apps, launches Calculator by the id the listing
    printed (the agent's own contract), and reports it. Round 2 appended
    "device_launch_app ran for Microsoft.WindowsCalculator_…, not Calculator."
    Now a launch that succeeded on the Dell silences the claim: the reply
    stands and is ingested."""
    await _pair(pool)
    _arm(
        monkeypatch,
        "device_list_apps",
        f"Apps on {DEVICE}:\n2 apps\nMicrosoft.WindowsCalculator_8wekyb3d8bbwe!App — Calculator",
    )
    _arm(
        monkeypatch,
        "device_launch_app",
        f"{DEVICE}: asked Windows to launch Microsoft.WindowsCalculator_8wekyb3d8bbwe!App — "
        "whether a window opened is not confirmed.",
    )
    reply = (
        "I launched Calculator on your DELL-XPS-8950 — Windows accepted it; I can't confirm "
        "the window."
    )
    gateway = ScriptedGateway(
        rounds=(
            (call("device_list_apps", {"device": DEVICE}, "c1"),),
            (
                call(
                    "device_launch_app",
                    {"device": DEVICE, "app": "Microsoft.WindowsCalculator_8wekyb3d8bbwe!App"},
                    "c2",
                ),
            ),
            (text(reply),),
        )
    )
    memory = FakeMemory()
    mount_peers(gateway=gateway, memory=memory)

    sent = await _say(owner_client, "open the calculator on my dell")

    assert await _stored(pool) == reply
    assert _corrections(sent) == []
    assert await _named(pool, "device_completion") == []
    await chat.drain_background()
    assert [i["exchange"]["assistant"] for i in memory.ingests] == [reply]


@requires_db
async def test_R3_the_sentence_is_read_after_a_later_redirect_ran_the_launch(
    owner_client, pool, mount_peers, monkeypatch
):
    """(R3, T4) "Notepad is now open… Want me to search the web for its
    shortcuts?" with nothing run. The OFFER redirect runs with tools, launches
    Notepad, and its closing round fails. Round 2 had already appended "No
    device_launch_app or device_run call ran" — beside the launch that ran.
    Now the pair reads the FINAL spans at the end of the turn: a launch ran
    there, so it says nothing, and the record holds no contradiction."""
    await _pair(pool)
    launcher = _arm(
        monkeypatch,
        "device_launch_app",
        f"{DEVICE}: asked Windows to launch notepad — whether a window opened is not confirmed.",
    )
    reply = (
        "Notepad is now open on your DELL-XPS-8950. Want me to search the web for its "
        "keyboard shortcuts?"
    )
    gateway = ScriptedGateway(
        rounds=(
            (text(reply),),
            (call("device_launch_app", {"device": DEVICE, "app": "notepad"}),),
            Refusal(502, {"error": {"message": "upstream down"}}),
        )
    )
    mount_peers(gateway=gateway, memory=FakeMemory())

    sent = await _say(
        owner_client, "open notepad on my dell and search the web for its keyboard shortcuts"
    )

    assert launcher.calls == [{"device": DEVICE, "app": "notepad"}]
    stored = await _stored(pool)
    assert stored == (
        f"{reply}\n\n{chat._bare_intent_ran_but_unreported_note('device_launch_app')}"
    )
    assert "No device_launch_app" not in stored
    assert NONE_ON_DELL not in _corrections(sent)
    assert await _named(pool, "device_completion") == []


@requires_db
async def test_R4_a_written_call_never_opens_a_second_round(
    owner_client, pool, mount_peers, monkeypatch
):
    """(R4) Round 2's redirect showed the model a nudge about a reply it was
    not shown. There is no redirect now: the model is asked exactly once, and
    the only thing the turn adds is the sentence."""
    await _pair(pool)
    _arm(monkeypatch, "device_run", f"{DEVICE} ran format — exit 0")
    fenced = f'Let me run it:\n{F}\ndevice_run ["format", "C:", "/q"]\n{F}'
    gateway = ScriptedGateway(rounds=((text(fenced),), (text("ok"),)))
    mount_peers(gateway=gateway, memory=FakeMemory())

    await _say(owner_client, "format my dell's C drive")

    assert gateway.calls == 1
    assert len(gateway.payloads) == 1
    assert await _stored(pool) == f"{fenced}\n\n(I wrote device_run as text; it did not run.)"


# -- T4: read at the END, over what persists as hers --------------------------


@requires_db
async def test_another_claims_regen_that_writes_a_call_stands_with_the_sentence(
    owner_client, pool, mount_peers
):
    """(T1, T4) The state claim's regeneration writes device_info as text
    instead of checking. Round 2 threw it away (refused by the written-call
    guard). The pair refuses nothing now: the regeneration stands, and the
    sentence is appended beside it, read at the end of the turn."""
    await _pair(pool)
    regen = f'{F}\ndevice_info "DELL-XPS-8950"\n{F}'
    gateway = ScriptedGateway(
        rounds=((text("Looks like the device is still offline."),), (text(regen),))
    )
    memory = FakeMemory()
    mount_peers(gateway=gateway, memory=memory)

    sent = await _say(owner_client, "try again")

    assert gateway.calls == 2
    (state,) = await _named(pool, "state_claim")
    assert _meta(state)["redirected"] is True
    assert "regen_rejected_by" not in _meta(state)
    assert await _stored(pool) == f"{regen}\n\n{WROTE_INFO}"
    assert _corrections(sent)[-1] == WROTE_INFO
    (written,) = await _named(pool, "written_call")
    assert _meta(written)["tools"] == ["device_info"]
    await chat.drain_background()
    assert memory.ingests == []


@requires_db
async def test_another_claims_regen_with_a_device_claim_gets_one_sentence(
    owner_client, pool, mount_peers
):
    """(T4) The state claim's regeneration says Notepad is open with nothing
    run. It stands, and the device sentence is appended ONCE — at the end of
    the turn, never also inside the redirect."""
    await _pair(pool)
    regen = "Notepad is now open on your DELL-XPS-8950."
    gateway = ScriptedGateway(
        rounds=((text("Looks like the device is still offline."),), (text(regen),))
    )
    memory = FakeMemory()
    mount_peers(gateway=gateway, memory=memory)

    sent = await _say(owner_client, "try again")

    assert gateway.calls == 2
    (state,) = await _named(pool, "state_claim")
    assert _meta(state)["redirected"] is True
    assert "regen_appended" not in _meta(state)
    assert await _stored(pool) == f"{regen}\n\n{NONE_ON_DELL}"
    assert _corrections(sent).count(NONE_ON_DELL) == 1
    assert len(await _named(pool, "device_completion")) == 1
    await chat.drain_background()
    assert memory.ingests == []


@requires_db
async def test_a_device_claim_no_longer_holds_off_the_commitment_redirect(
    owner_client, pool, mount_peers
):
    """(T1, T4) Round 2's device claim held the text-only commitment redirect
    off. The pair holds nothing off now: the commitment redirect runs, its
    regeneration stands — and the pair reads THAT, the prose that persists,
    and appends its one sentence beside it."""
    await _pair(pool)
    reply = "Notepad is now open on your DELL-XPS-8950. I'll search the web for its shortcuts."
    regen = "Notepad is now open on your DELL-XPS-8950, and Ctrl+S saves."
    gateway = ScriptedGateway(rounds=((text(reply),), (text(regen),)))
    memory = FakeMemory()
    mount_peers(gateway=gateway, memory=memory)

    sent = await _say(owner_client, "open notepad on my dell and look up its shortcuts")

    assert gateway.calls == 2
    assert await _stored(pool) == f"{regen}\n\n{NONE_ON_DELL}"
    # The text-only redirect ran nothing (fix round 5, P6).
    assert _corrections(sent) == [chat.DEFERRAL_NOTE_NO_CALL, NONE_ON_DELL]
    (completion,) = await _named(pool, "device_completion")
    assert _meta(completion)["phrase"] == "Notepad is now open on your DELL-XPS-8950"
    await chat.drain_background()
    assert memory.ingests == []


@requires_db
async def test_a_written_call_beside_a_deferral_takes_no_budget(
    owner_client, pool, mount_peers, monkeypatch
):
    """(T1) A commitment ("I'll search the web") AND the search written as code.
    The written call no longer takes the budget: the commitment redirect runs,
    still defers, and appends its honest note; then the pair, at the end,
    appends its sentence about the call she wrote. Both true, never
    contradictory, and nothing ran."""
    search = _arm(monkeypatch, "web_search", "Pixel 10: Tensor G5.", schema=SEARCH_SCHEMA)
    reply = f'I\'ll search the web for that.\n{F}\nweb_search("latest pixel phone")\n{F}'
    gateway = ScriptedGateway(rounds=((text(reply),), (text("I'll search for it now."),)))
    mount_peers(gateway=gateway, memory=FakeMemory())

    sent = await _say(owner_client, "what's the latest pixel phone?")

    wrote = "(I wrote web_search as text; it did not run.)"
    assert gateway.calls == 2
    assert search.calls == []
    note = chat._deferral_honest_note("search the web")
    assert await _stored(pool) == f"{reply}\n\n{note}\n\n{wrote}"
    assert _corrections(sent) == [note, wrote]


@requires_db
async def test_the_responsiveness_check_is_not_held_off_and_the_pair_reads_its_answer(
    owner_client, pool, mount_peers
):
    """(T1, T4) With the soft check ON, a device claim no longer holds it off:
    the judge runs, calls the reply off-topic, the refocused answer replaces
    it — and the pair reads the refocused answer, the prose that persists."""
    await _pair(pool)
    refocused = "Notepad is now open on your DELL-XPS-8950, ready for your notes."
    gateway = ScriptedGateway(rounds=((text(T98ECFB11),), (text("off_topic"),), (text(refocused),)))
    mount_peers(gateway=gateway, memory=FakeMemory())
    await _set(owner_client, "agents.responsiveness_check", True)

    sent = await _say(owner_client, T98ECFB11_ASKED)

    assert gateway.calls == 3
    (judged,) = await _named(pool, "responsiveness")
    assert _meta(judged)["redirected"] is True
    assert await _stored(pool) == f"{refocused}\n\n{NONE_ON_DELL}"
    assert _corrections(sent) == [chat.REFOCUS_NOTE, NONE_ON_DELL]


@requires_db
async def test_prose_a_replace_class_correction_dropped_is_not_read(
    owner_client, pool, mount_peers
):
    """(T4) A false capability denial REPLACES her prose: what persists is the
    correction alone, so there is nothing of hers for the pair to read — it
    appends nothing about a fence the record no longer holds."""
    reply = f'{F}\ndevice_info "DELL-XPS-8950"\n{F}\nI cannot access external websites.'
    gateway = ScriptedGateway(rounds=((text(reply),),))
    mount_peers(gateway=gateway, memory=FakeMemory())

    sent = await _say(owner_client, "what's on example.com?")

    assert len(await _named(pool, "capability_claim")) == 1
    stored = await _stored(pool)
    assert WROTE_INFO not in stored and "device_info" not in stored
    assert WROTE_INFO not in _corrections(sent)
    assert await _named(pool, "written_call") == []


# -- T5: the backend's own notes are never her words ---------------------------


@requires_db
async def test_the_round_cap_note_is_never_read_as_the_sentence_after_her_fence(
    owner_client, pool, mount_peers, monkeypatch
):
    """(T5) A capped turn: her last words write device_info as a fence, and the
    backend adds "[stopped after 2 tool rounds without finishing]". Read as
    hers, that note's "after" took the fence back and the guard went silent
    (rr3 probe_note). She is read without it: the sentence is appended after
    the note, and the note is intact."""
    await _pair(pool)
    info = _arm(monkeypatch, "device_info", f"{DEVICE} system info:\nWindows 11")
    forever = (call("get_time", {}, "c"),)
    fenced = f'Let me check the OS next:\n{F}\ndevice_info "DELL-XPS-8950"\n{F}'
    gateway = ScriptedGateway(rounds=(forever, forever, (text(fenced),)))
    mount_peers(gateway=gateway, memory=FakeMemory())
    await _set(owner_client, "agents.max_tool_rounds", 2)

    sent = await _say(owner_client, "what time is it, and what OS is my dell on?")

    cap = "[stopped after 2 tool rounds without finishing]"
    assert gateway.calls == 3
    assert info.calls == []
    assert await _stored(pool) == f"{fenced}\n\n{cap}\n\n{WROTE_INFO}"
    assert _corrections(sent) == [WROTE_INFO]


# -- device claims: failures, silence, and what never backs --------------------


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
    said it opened. No redirect, no retry, no push: the sentence states the
    failure with its reason, and the turn stays out of memory."""
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
    assert await _stored(pool) == f"{claimed}\n\n{FAILED_LAUNCH}"
    assert _corrections(sent) == [FAILED_LAUNCH]
    (span,) = await _named(pool, "device_completion")
    assert _meta(span)["record"] == "failed"
    assert _meta(span)["record_tool"] == "device_launch_app"
    await chat.drain_background()
    assert memory.ingests == []


@requires_db
async def test_a_launch_sent_and_never_answered_says_only_that(
    owner_client, pool, mount_peers, monkeypatch
):
    """(R-A, T3) The call left core and no answer came back: whether it worked
    is not known, and the sentence says only that."""
    await _pair(pool)
    _arm_failing(monkeypatch, "device_launch_app", f"device '{DEVICE}' did not answer within 120s")
    gateway = ScriptedGateway(
        rounds=(
            (call("device_launch_app", {"device": DEVICE, "app": "notepad"}, "c1"),),
            (text(T98ECFB11),),
        )
    )
    mount_peers(gateway=gateway, memory=FakeMemory())

    sent = await _say(owner_client, T98ECFB11_ASKED)

    assert await _stored(pool) == f"{T98ECFB11}\n\n{NO_ANSWER}"
    assert _corrections(sent) == [NO_ANSWER]


@requires_db
@pytest.mark.parametrize(
    "label,tool,args,reply",
    [
        (
            "P1 a tasklist filter naming notepad, then 'Notepad is now open'",
            "device_run",
            {"device": DEVICE, "argv": ["tasklist", "/fi", "imagename eq notepad.exe"]},
            "Notepad is now open on your DELL-XPS-8950.",
        ),
        (
            "P2 a tasklist, then 'I closed Notepad'",
            "device_run",
            {"device": DEVICE, "argv": ["tasklist"]},
            "I closed Notepad on your DELL-XPS-8950.",
        ),
        (
            "P3 an Edge launch, then 'Microsoft Teams is now open'",
            "device_launch_app",
            {"device": DEVICE, "app": "Microsoft Edge"},
            "Microsoft Teams is now open on your DELL-XPS-8950.",
        ),
        (
            "P4b a Teams launch that ran, then 'Notepad is now open'",
            "device_launch_app",
            {"device": DEVICE, "app": "Teams"},
            T98ECFB11,
        ),
    ],
)
async def test_P1_to_P4b_a_call_of_the_family_that_ran_there_silences_the_claim(
    label, tool, args, reply, owner_client, pool, mount_peers, monkeypatch
):
    """(T3, review P1–P4b) Round 2 said "ran for X, not Y" here. A call of the
    claimed action's tools SUCCEEDED on the Dell: "no call ran" would be false,
    and what it did to the machine is not in the record — so nothing is said.
    No redirect, and nothing launched that she did not call."""
    await _pair(pool)
    ran = _arm(monkeypatch, tool, f"{DEVICE}: done")
    launcher = (
        ran if tool == "device_launch_app" else _arm(monkeypatch, "device_launch_app", LAUNCHED)
    )
    gateway = ScriptedGateway(rounds=((call(tool, args, "c1"),), (text(reply),)))
    mount_peers(gateway=gateway, memory=FakeMemory())

    sent = await _say(owner_client, T98ECFB11_ASKED)

    assert gateway.calls == 2, label
    assert ran.calls == [args], label
    if tool != "device_launch_app":
        assert launcher.calls == [], label
    assert _system_nudges(gateway) == [], label
    assert await _stored(pool) == reply, label
    assert _corrections(sent) == [], label
    assert await _named(pool, "device_completion") == [], label


@requires_db
async def test_B1_a_read_of_the_apps_is_no_launch(owner_client, pool, mount_peers, monkeypatch):
    """(review B1) She listed the apps and said Notepad is open: a read opens
    nothing, so the record shows no call that opens one ran on the Dell."""
    await _pair(pool)
    lister = _arm(monkeypatch, "device_list_apps", f"Apps on {DEVICE}:\nNotepad")
    gateway = ScriptedGateway(
        rounds=((call("device_list_apps", {"device": DEVICE}, "c1"),), (text(T98ECFB11),))
    )
    mount_peers(gateway=gateway, memory=FakeMemory())

    sent = await _say(owner_client, T98ECFB11_ASKED)

    assert lister.calls == [{"device": DEVICE}]
    assert await _stored(pool) == f"{T98ECFB11}\n\n{NONE_ON_DELL}"
    assert _corrections(sent) == [NONE_ON_DELL]


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
async def test_P7_A_a_backend_check_never_backs_her_claim(
    owner_client, pool, mount_peers, monkeypatch
):
    """(C1, reviews A and P7) A live check the BACKEND ran unasked read the
    Dell's apps; it launched nothing. The Notepad claim gets the none sentence,
    which is true: a read is not a call that opens anything."""
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
    assert await _stored(pool) == f"{T98ECFB11}\n\n{NONE_ON_DELL}"
    assert _corrections(sent)[-1] == NONE_ON_DELL
    await chat.drain_background()
    assert memory.ingests == []


@requires_db
async def test_P7b_a_backend_check_and_the_teams_turn_get_the_two_sentences(
    owner_client, pool, mount_peers, monkeypatch
):
    """(review P7b) With the backend's unasked read on the turn, the Teams turn
    gets exactly what it gets without it: the two sentences, no redirect (there
    is none to refuse any more), nothing launched."""
    await _pair(pool)
    _arm(monkeypatch, "device_list_apps", f"Apps on {DEVICE}:\n2 apps\nNotepad\nTeams")
    launcher = _arm(monkeypatch, "device_launch_app", LAUNCHED)
    memory = _apps_memory()
    gateway = ScriptedGateway(rounds=((text(T890B1C63),),))
    mount_peers(gateway=gateway, memory=memory)

    sent = await _say(owner_client, T890B1C63_ASKED)

    assert gateway.calls == 1
    assert launcher.calls == []
    assert await _stored(pool) == f"{T890B1C63}\n\n{WROTE_LAUNCH}\n\n{NONE_ON_DELL}"
    assert _corrections(sent)[-2:] == [WROTE_LAUNCH, NONE_ON_DELL]
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
        (
            "F her honest answer",
            None,
            'I have not run `device_launch_app "DELL-XPS-8950" "Teams"` — I only wrote it as '
            "text, so nothing was launched.",
            T890B1C63_ASKED,
        ),
    ],
)
async def test_recaps_proposals_warnings_and_honest_answers_are_never_turned_into_actions(
    label, first, reply, asked, owner_client, pool, mount_peers, monkeypatch
):
    """(C2, I1a, I2, review D, D2, E, F, G) Nothing fires: one answer, no
    redirect, no tool, the reply as she wrote it."""
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
async def test_a_written_call_after_another_tool_ran_gets_its_sentence(
    owner_client, pool, mount_peers, monkeypatch
):
    """She listed the apps, then wrote the launch as text. The sentence is
    appended, nothing is regenerated, nothing launched, not ingested."""
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

    assert gateway.calls == 2
    assert lister.calls == [{"device": DEVICE}]
    assert launcher.calls == []
    assert await _stored(pool) == f"{reply}\n\n{WROTE_LAUNCH}"
    assert _corrections(sent) == [WROTE_LAUNCH]
    (span,) = await _named(pool, "written_call")
    assert _meta(span)["where"] == "inline code"
    await chat.drain_background()
    assert memory.ingests == []


@requires_db
async def test_a_hard_correction_and_a_written_call_each_say_their_one_thing(
    owner_client, pool, mount_peers
):
    """narration corrects the false "I saved report.md", and the pair, at the
    end, appends its sentence about the call she wrote — each once, in the
    order the turn reached them."""
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
    stored = await _stored(pool)
    assert stored.startswith(reply)
    assert stored.endswith(f"\n\n{WROTE_INFO}")
    assert _corrections(sent)[-1] == WROTE_INFO
    assert len(await _named(pool, "narration")) == 1
    assert len(await _named(pool, "written_call")) == 1
    await chat.drain_background()
    assert memory.ingests == []


@requires_db
@pytest.mark.parametrize("guard", ["written_call_check", "device_completion_check"])
async def test_a_guard_that_raises_fails_open(guard, owner_client, pool, mount_peers, monkeypatch):
    """Fail-open, each on its own: a guard that raises appends nothing and
    files nothing — the other still says its one thing."""

    def boom(*_args, **_kwargs):
        raise RuntimeError("detector blew up")

    monkeypatch.setattr(chat.guards, guard, boom)
    await _pair(pool)
    gateway = ScriptedGateway(rounds=((text(T890B1C63),),))
    mount_peers(gateway=gateway, memory=FakeMemory())

    sent = await _say(owner_client, T890B1C63_ASKED)

    left = NONE_ON_DELL if guard == "written_call_check" else WROTE_LAUNCH
    assert gateway.calls == 1
    assert await _stored(pool) == f"{T890B1C63}\n\n{left}"
    assert _corrections(sent) == [left]
    assert not [f for f in sent if isinstance(f, dict) and "error" in f]


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


# -- fix round 4 (2026-09-30, the controller's rulings R1, R5, R6) ---------------

LAUNCHED_NOTEPAD = (
    f"{DEVICE}: asked Windows to launch notepad — whether a window opened is not confirmed."
)


async def _reply_of(pool, kind: str) -> str | None:
    return await pool.fetchval(
        "SELECT m.content FROM messages m JOIN turns t ON t.id = m.turn_id "
        "WHERE m.role = 'assistant' AND t.kind = $1",
        kind,
    )


async def _guard_spans_of(pool, kind: str) -> list[str]:
    rows = await pool.fetch(
        "SELECT s.name FROM turn_spans s JOIN turns t ON t.id = s.turn_id "
        "WHERE s.kind = 'guard' AND t.kind = $1",
        kind,
    )
    return [row["name"] for row in rows]


# R1 — a delegation ran an agent. The re-review's repro (scratchpad
# rr4/test_rr4_chat.py), now a test: Nova delegates to "ops", which holds
# device_launch_app; ops really launches Notepad on the Dell in ITS turn; Nova
# relays it truthfully — and the relay got "(No device_launch_app or
# device_run call ran on DELL-XPS-8950 this turn.)", because her turn's record
# holds only the delegation. That record cannot say what the agent did, so the
# pair says nothing on a turn whose delegation ran an agent.


@requires_db
@pytest.mark.parametrize(
    "relay",
    [
        f"Done — ops opened Notepad on your {DEVICE}.",
        f"Notepad is now open on your {DEVICE}.",
        f'Launching Notepad via ops:\n{F}\ndevice_launch_app "{DEVICE}" "notepad"\n{F}\n'
        f"Notepad is now open on your {DEVICE}.",
    ],
)
async def test_R1_a_launch_an_agent_made_is_relayed_with_no_sentence(
    relay, owner_client, pool, mount_peers, monkeypatch, tmp_path
):
    from tests.test_chat_agents import _create

    monkeypatch.setenv("WORKSPACE_ROOT", str(tmp_path / "ws"))
    await _pair(pool)
    launcher = _arm(monkeypatch, "device_launch_app", LAUNCHED_NOTEPAD)
    await _create(pool, mount_peers, name="ops", tools=("device_launch_app",))
    gateway = ScriptedGateway(
        rounds=(
            (
                call(
                    "delegate_to_agent", {"agent": "ops", "task": f"open notepad on {DEVICE}"}, "n1"
                ),
            ),
            (call("device_launch_app", {"device": DEVICE, "app": "notepad"}, "c1"),),
            (text(f"I launched Notepad on {DEVICE}; Windows accepted it."),),
            (text(relay),),
        )
    )
    memory = FakeMemory()
    mount_peers(gateway=gateway, memory=memory)

    sent = await _say(owner_client, "have ops open notepad on my dell")

    assert launcher.calls == [{"device": DEVICE, "app": "notepad"}]  # the agent's call
    assert await _reply_of(pool, "chat") == relay
    assert _corrections(sent) == []
    assert await _guard_spans_of(pool, "chat") == []
    await chat.drain_background()
    assert relay in [i["exchange"]["assistant"] for i in memory.ingests]


@requires_db
async def test_R1_a_delegation_refused_before_any_run_leaves_the_sentence(
    owner_client, pool, mount_peers, monkeypatch, tmp_path
):
    """No agent by that name: nothing ran anywhere, so her turn's record is the
    whole record, and "Notepad is now open" still gets its true sentence."""
    monkeypatch.setenv("WORKSPACE_ROOT", str(tmp_path / "ws"))
    await _pair(pool)
    launcher = _arm(monkeypatch, "device_launch_app", LAUNCHED_NOTEPAD)
    gateway = ScriptedGateway(
        rounds=(
            (call("delegate_to_agent", {"agent": "opz", "task": "open notepad"}, "n1"),),
            (text(T98ECFB11),),
        )
    )
    mount_peers(gateway=gateway, memory=FakeMemory())

    sent = await _say(owner_client, "have opz open notepad on my dell")

    assert launcher.calls == []
    assert await _stored(pool) == f"{T98ECFB11}\n\n{NONE_ON_DELL}"
    assert _corrections(sent) == [NONE_ON_DELL]


# R5 — the WSL twin, through the live rows. "Notepad is now open on your
# DELL-XPS-8950" after a device_run of notepad.exe on "DELL-XPS-8950 (WSL)" got
# "No … call ran on DELL-XPS-8950": true of the row, misleading about the
# machine. The machine each agent reported is read from the device rows at the
# end of the turn (devices.live_machines); the WSL agent's is not readable (its
# machine id is WSL's own), so the claim is silent. Another machine's agent
# still leaves the sentence; a second agent reporting the same machine backs it.

WSL = f"{DEVICE} (WSL)"
UID_DELL = "d" * 64
UID_BOX = "b" * 64


def _facts(uid: str, *, wsl: bool = False) -> dict:
    return {
        "v": 2,
        "agent": {"version": "0.2.0", "mode": "foreground", "session_interactive": True},
        "os": {
            "goos": "linux" if wsl else "windows",
            "arch": "amd64",
            "version": "Ubuntu 26.04 LTS" if wsl else "Windows 11 Pro",
            "wsl": {"distro": "Ubuntu-26.04"} if wsl else None,
        },
        "hostname": "dell" if not wsl else "dell-wsl",
        "machine_uid": uid,
    }


async def _pair_reporting(pool, name: str, platform: str, facts: dict | None) -> None:
    """A paired row as an agent left it: its facts and when, or neither (an
    agent that predates S42a sends none)."""
    await pool.execute(
        "INSERT INTO devices (name, platform, hostname, pubkey, facts, facts_at) "
        "VALUES ($1, $2, 'host', $3, $4, CASE WHEN $4::jsonb IS NULL THEN NULL ELSE now() END)",
        name,
        platform,
        "a" * 64,
        facts,
    )


@requires_db
@pytest.mark.parametrize("wsl_facts", ["pre-S42a, no facts", "S42a, its own machine id"])
async def test_R5_a_run_on_the_wsl_twin_leaves_the_windows_claim_silent(
    wsl_facts, owner_client, pool, mount_peers, monkeypatch
):
    await _pair_reporting(pool, DEVICE, "windows", _facts(UID_DELL))
    twin = None if wsl_facts.startswith("pre") else _facts(UID_BOX, wsl=True)
    await _pair_reporting(pool, WSL, "linux", twin)
    runner = _arm(monkeypatch, "device_run", f"{WSL} ran ['notepad.exe'] — exit 0\n")
    gateway = ScriptedGateway(
        rounds=(
            (call("device_run", {"device": WSL, "argv": ["notepad.exe"]}, "c1"),),
            (text(T98ECFB11),),
        )
    )
    mount_peers(gateway=gateway, memory=FakeMemory())

    sent = await _say(owner_client, T98ECFB11_ASKED)

    assert runner.calls == [{"device": WSL, "argv": ["notepad.exe"]}]
    assert await _stored(pool) == T98ECFB11
    assert _corrections(sent) == []
    assert await _named(pool, "device_completion") == []


@requires_db
async def test_R5_a_launch_on_another_machines_agent_leaves_the_sentence(
    owner_client, pool, mount_peers, monkeypatch
):
    await _pair_reporting(pool, DEVICE, "windows", _facts(UID_DELL))
    await _pair_reporting(pool, "office-box", "windows", _facts(UID_BOX))
    launcher = _arm(monkeypatch, "device_launch_app", LAUNCHED_NOTEPAD)
    gateway = ScriptedGateway(
        rounds=(
            (call("device_launch_app", {"device": "office-box", "app": "notepad"}, "c1"),),
            (text(T98ECFB11),),
        )
    )
    mount_peers(gateway=gateway, memory=FakeMemory())

    sent = await _say(owner_client, T98ECFB11_ASKED)

    assert launcher.calls == [{"device": "office-box", "app": "notepad"}]
    assert await _stored(pool) == f"{T98ECFB11}\n\n{NONE_ON_DELL}"
    assert _corrections(sent) == [NONE_ON_DELL]


@requires_db
async def test_R5_a_launch_on_a_second_agent_of_the_same_machine_backs_the_claim(
    owner_client, pool, mount_peers, monkeypatch
):
    await _pair_reporting(pool, DEVICE, "windows", _facts(UID_DELL))
    await _pair_reporting(pool, "dell-second-agent", "windows", _facts(UID_DELL))
    _arm(monkeypatch, "device_launch_app", LAUNCHED_NOTEPAD)
    gateway = ScriptedGateway(
        rounds=(
            (call("device_launch_app", {"device": "dell-second-agent", "app": "notepad"}, "c1"),),
            (text(T98ECFB11),),
        )
    )
    mount_peers(gateway=gateway, memory=FakeMemory())

    sent = await _say(owner_client, T98ECFB11_ASKED)

    assert await _stored(pool) == T98ECFB11
    assert _corrections(sent) == []


@requires_db
async def test_R5_the_machines_are_read_from_the_live_rows_never_a_revoked_one(pool):
    from app import devices

    await _pair_reporting(pool, DEVICE, "windows", _facts(UID_DELL))
    await _pair_reporting(pool, WSL, "linux", _facts(UID_BOX, wsl=True))
    await _pair_reporting(pool, "old-box", "linux", None)
    await _pair_reporting(pool, "gone", "windows", _facts(UID_DELL))
    await pool.execute("UPDATE devices SET revoked_at = now() WHERE name = 'gone'")
    assert await devices.live_machines(pool) == {DEVICE: UID_DELL, WSL: None, "old-box": None}


# R6 — emit what persists. A redirect whose own call RAN but whose report did not
# survive stored the true "[I ran X but could not report the result…]" while
# the live frame said "[I said I'd check but did not…]" or "I asked instead of
# doing it… I did not…" — a false line the owner saw once the web client showed
# correction frames (fix round 3, T6). The redirect now emits exactly the text
# that persists, and a note it stores (its closing round's markup) is emitted
# too. The web client's own parser and reducer read these very streams in
# apps/web/src/pages/chat/liveStored.test.ts (the fixture test below).

NOTEPAD_OFFER = (
    f"Notepad is now open on your {DEVICE}. Want me to search the web for its keyboard shortcuts?"
)
BARE_CHECK = f"Got it. Checking your {DEVICE} now…"


def _ran_note(names: str) -> str:
    return chat._bare_intent_ran_but_unreported_note(names)


@requires_db
async def test_R6_an_offer_redirect_whose_call_ran_shows_what_it_stores(
    owner_client, pool, mount_peers, monkeypatch
):
    await _pair(pool)
    launcher = _arm(monkeypatch, "device_launch_app", LAUNCHED_NOTEPAD)
    gateway = ScriptedGateway(
        rounds=(
            (text(NOTEPAD_OFFER),),
            (call("device_launch_app", {"device": DEVICE, "app": "notepad"}),),
            Refusal(502, {"error": {"message": "upstream down"}}),
        )
    )
    mount_peers(gateway=gateway, memory=FakeMemory())

    sent = await _say(
        owner_client, "open notepad on my dell and search the web for its keyboard shortcuts"
    )

    assert launcher.calls == [{"device": DEVICE, "app": "notepad"}]
    note = _ran_note("device_launch_app")
    assert await _stored(pool) == f"{NOTEPAD_OFFER}\n\n{note}"
    assert _corrections(sent) == [note]


@requires_db
async def test_R6_a_completion_redirect_whose_call_ran_shows_what_it_stores(
    owner_client, pool, mount_peers, monkeypatch
):
    from tests.test_chat_deferral import COMPLETION, REMINDER_INSTRUCTION, _arm_create_timer

    spy = _arm_create_timer(monkeypatch)
    gateway = ScriptedGateway(
        rounds=(
            (text(COMPLETION),),
            (call("create_timer", {"text": "blink", "in_minutes": 5}),),
            Refusal(502, {"error": {"message": "upstream down"}}),
        )
    )
    mount_peers(gateway=gateway, memory=FakeMemory())

    sent = await _say(owner_client, REMINDER_INSTRUCTION)

    assert spy.calls == [{"text": "blink", "in_minutes": 5}]
    note = _ran_note("create_timer")
    assert await _stored(pool) == f"{COMPLETION}\n\n{note}"
    assert _corrections(sent) == [note]


@requires_db
async def test_R6_a_bare_intent_redirect_whose_call_ran_shows_what_it_stores(
    owner_client, pool, mount_peers, monkeypatch
):
    """REPLACE-class: the note alone persists, and the one correction shown
    live is exactly it."""
    await _pair(pool)
    info = _arm(monkeypatch, "device_info", f"{DEVICE} system info:\nWindows 11")
    gateway = ScriptedGateway(
        rounds=(
            (text(BARE_CHECK),),
            (call("device_info", {"device": DEVICE}),),
            Refusal(502, {"error": {"message": "upstream down"}}),
        )
    )
    mount_peers(gateway=gateway, memory=FakeMemory())

    sent = await _say(owner_client, "what OS is my dell on?")

    assert info.calls == [{"device": DEVICE}]
    note = _ran_note("device_info")
    assert await _stored(pool) == note
    assert _corrections(sent) == [note]
    assert chat.BARE_INTENT_HONEST_NOTE not in _corrections(sent)


@requires_db
async def test_R6_a_closing_round_written_as_markup_shows_the_note_it_stores(
    owner_client, pool, mount_peers, monkeypatch
):
    """The bare-intent redirect ran its call, and its closing round wrote a
    call as markup (refused, never run): both backend lines persist, so both
    are shown live, in order."""
    from app import markup_calls
    from tests.test_chat_bare_intent import (
        AUTO_ACTION,
        BARE_INTENT,
        BARE_INTENT_MARKUP,
        _arm_auto_tool,
        auto_call,
    )

    spy = await _arm_auto_tool(pool, monkeypatch)
    gateway = ScriptedGateway(
        rounds=((text(BARE_INTENT),), (auto_call("r1"),), (text(BARE_INTENT_MARKUP),))
    )
    mount_peers(gateway=gateway, memory=FakeMemory())

    sent = await _say(owner_client, "show me my workspace directory structure")

    assert len(spy.calls) == 1
    note = _ran_note(AUTO_ACTION)
    markup = markup_calls.no_tool_round_note([AUTO_ACTION])
    assert await _stored(pool) == f"{note}\n\n{markup}"
    assert _corrections(sent) == [note, markup]


@requires_db
async def test_R6_a_consent_redirects_markup_note_is_shown_where_it_is_stored(
    owner_client, pool, mount_peers, monkeypatch
):
    """The consent redirect ran its probe, and its closing round wrote a call
    as markup (refused): its correction and the backend's markup note are both
    stored, so both are shown live, in the stored order (R6: the note was
    stored and never streamed)."""
    from app import markup_calls
    from tests.test_chat_markup import FABRICATION, PROBE, _arm_probe, real_call
    from tests.test_markup_calls import OBSERVED

    spy = await _arm_probe(pool, monkeypatch)
    gateway = ScriptedGateway(
        rounds=(
            (text(FABRICATION),),
            (real_call("r1", PROBE, {"device": DEVICE, "argv": ["tree"]}),),
            (text(OBSERVED),),
        )
    )
    mount_peers(gateway=gateway, memory=FakeMemory())

    sent = await _say(owner_client, "try again")

    assert spy.calls == [{"device": DEVICE, "argv": ["tree"]}]
    markup = markup_calls.no_tool_round_note(["device_run"])
    stored = await _stored(pool)
    corrections = _corrections(sent)
    assert corrections[-1] == markup
    assert stored == "\n\n".join(corrections)


# -- R6, through the web client's own parser and reducer --------------------------
#
# The re-review ran core's raw SSE for these turns through the web client's real
# stream parser and chat reducer (scratchpad rr4/web/src/live_vs_stored.test.ts)
# and compared what the owner sees live with what a reload shows. That check is
# kept as two halves of one contract, like tests/fixtures/envelope_vectors.json
# between core and the device agent:
#
#   * HERE, core's half: each turn's raw stream (ids zeroed) and stored reply
#     must equal the committed fixture tests/fixtures/live_stored_frames.json,
#     and every correction core streams is, in order, how the stored reply ends;
#   * apps/web/src/pages/chat/liveStored.test.ts, the client's half: the same
#     streams, through createSseParser and chatReducer, show exactly the stored
#     reply — "append" turns end to end; for a "replace" turn (the bare-intent
#     redirect drops the "Checking…" she streamed), the streamed prose above
#     exactly the stored text, which a reload then shows alone.
#
# A red here means core's streams or stored replies changed. Regenerate the
# fixture with NOVA_WRITE_LIVE_STORED=1, commit it, and run the web suite: it is
# what says whether the owner still sees what is kept.

LIVE_STORED = Path(__file__).parent / "fixtures" / "live_stored_frames.json"
_UUID = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}")
_NO_ID = "00000000-0000-0000-0000-000000000000"


async def _teams_turn(pool, mount_peers, monkeypatch, tmp_path):
    await _pair(pool)
    return "append", None, T890B1C63_ASKED, ((text(T890B1C63),),)


async def _notepad_turn(pool, mount_peers, monkeypatch, tmp_path):
    await _pair(pool)
    return "append", None, T98ECFB11_ASKED, ((text(T98ECFB11),),)


async def _failed_launch(pool, mount_peers, monkeypatch, tmp_path):
    await _pair(pool)
    _arm_failing(monkeypatch, "device_launch_app", f"{DEVICE}: {FAILED_REASON}")
    rounds = (
        (call("device_launch_app", {"device": DEVICE, "app": "notepad++"}, "c1"),),
        (text(f"I launched Notepad++ on your {DEVICE}."),),
    )
    return "append", None, "open notepad++ on my dell", rounds


async def _delegated_launch(pool, mount_peers, monkeypatch, tmp_path):
    from tests.test_chat_agents import _create

    await _pair(pool)
    _arm(monkeypatch, "device_launch_app", LAUNCHED_NOTEPAD)
    await _create(pool, mount_peers, name="ops", tools=("device_launch_app",))
    rounds = (
        (call("delegate_to_agent", {"agent": "ops", "task": f"open notepad on {DEVICE}"}, "n1"),),
        (call("device_launch_app", {"device": DEVICE, "app": "notepad"}, "c1"),),
        (text(f"I launched Notepad on {DEVICE}; Windows accepted it."),),
        (text(f"Done — ops opened Notepad on your {DEVICE}."),),
    )
    return "append", None, "have ops open notepad on my dell", rounds


async def _offer_ran_report_failed(pool, mount_peers, monkeypatch, tmp_path):
    await _pair(pool)
    _arm(monkeypatch, "device_launch_app", LAUNCHED_NOTEPAD)
    rounds = (
        (text(NOTEPAD_OFFER),),
        (call("device_launch_app", {"device": DEVICE, "app": "notepad"}),),
        Refusal(502, {"error": {"message": "upstream down"}}),
    )
    ask = "open notepad on my dell and search the web for its keyboard shortcuts"
    return "append", None, ask, rounds


async def _completion_ran_report_failed(pool, mount_peers, monkeypatch, tmp_path):
    from tests.test_chat_deferral import COMPLETION, REMINDER_INSTRUCTION, _arm_create_timer

    _arm_create_timer(monkeypatch)
    rounds = (
        (text(COMPLETION),),
        (call("create_timer", {"text": "blink", "in_minutes": 5}),),
        Refusal(502, {"error": {"message": "upstream down"}}),
    )
    return "append", None, REMINDER_INSTRUCTION, rounds


async def _bare_intent_ran_report_failed(pool, mount_peers, monkeypatch, tmp_path):
    await _pair(pool)
    _arm(monkeypatch, "device_info", f"{DEVICE} system info:\nWindows 11")
    rounds = (
        (text(BARE_CHECK),),
        (call("device_info", {"device": DEVICE}),),
        Refusal(502, {"error": {"message": "upstream down"}}),
    )
    return "replace", BARE_CHECK, "what OS is my dell on?", rounds


async def _bare_intent_closing_markup(pool, mount_peers, monkeypatch, tmp_path):
    from tests.test_chat_bare_intent import (
        BARE_INTENT,
        BARE_INTENT_MARKUP,
        _arm_auto_tool,
        auto_call,
    )

    await _arm_auto_tool(pool, monkeypatch)
    rounds = ((text(BARE_INTENT),), (auto_call("r1"),), (text(BARE_INTENT_MARKUP),))
    return "replace", BARE_INTENT, "show me my workspace directory structure", rounds


async def _consent_closing_markup(pool, mount_peers, monkeypatch, tmp_path):
    from tests.test_chat_markup import FABRICATION, PROBE, _arm_probe, real_call
    from tests.test_markup_calls import OBSERVED

    await _arm_probe(pool, monkeypatch)
    rounds = (
        (text(FABRICATION),),
        (real_call("r1", PROBE, {"device": DEVICE, "argv": ["tree"]}),),
        (text(OBSERVED),),
    )
    return "replace", FABRICATION, "try again", rounds


async def _consent_markup_and_unverified_listing(pool, mount_peers, monkeypatch, tmp_path):
    """(Fix round 5, P2 — the re-review's rr5 A.) Two backend lines stored after
    the consent correction: the redirect's markup note, then the unverified-
    listing note. They are shown in that order."""
    from tests.test_chat_markup import FABRICATION, PROBE, _arm_probe, real_call
    from tests.test_chat_presented_listing import FABRICATED
    from tests.test_markup_calls import OBSERVED

    await _arm_probe(pool, monkeypatch)
    reply = f"{FABRICATION}\n\n{FABRICATED}"
    rounds = (
        (text(reply),),
        (real_call("r1", PROBE, {"device": DEVICE, "argv": ["tree"]}),),
        (text(OBSERVED),),
    )
    return "replace", reply, "try again", rounds


# (Fix round 5, P6.) A REPLACE-class redirect that STOOD: its note is live-only
# (the stored text is the regeneration alone), so it is the one line of the
# live view a reload never shows — and it must never claim work the
# regeneration did not do. Class "redirect": live is her streamed prose, the
# note, then the stored reply; `dispatched` is whether a call ran.
def _p6_turn(kind: str, dispatched: bool):
    async def build(pool, mount_peers, monkeypatch, tmp_path):
        kwargs = {"tmp_path": tmp_path} if kind == "listing" else {}
        reply, ask, rounds, _answer, _notes = await P6_KINDS[kind](
            pool, monkeypatch, dispatched=dispatched, **kwargs
        )
        return "redirect", reply, ask, rounds

    return build


# (P6 at the cap.) A regeneration that ASKED for a call that never reached an
# executor — here, one written as text — dispatched nothing. The stream frames
# that call as started all the same (then as an error, exactly like an executor
# that failed), which is why the web half reads `dispatched` from here rather
# than off the stream. One such turn is enough to pin that; the unknown-tool
# case (M6) is pinned in core alone, since its frame quotes the registry.
def _p6_not_reached_turn(case: str):
    async def build(pool, mount_peers, monkeypatch, tmp_path):
        m = await P6_NOT_REACHED[case](pool, monkeypatch, tmp_path)
        return "redirect", m.reply, m.ask, m.rounds

    return build


async def _commitment_redirect_stood(pool, mount_peers, monkeypatch, tmp_path):
    """The text-only commitment redirect: it advertises no tools, so it can
    never have done what was promised."""
    from tests.test_chat_deferral import DEFER

    corrected = "The Pixel 10 has a 50-megapixel main camera with strong low-light."
    return "redirect", DEFER, "what's the latest pixel news?", ((text(DEFER),), (text(corrected),))


LIVE_STORED_TURNS = {
    "commitment_redirect_stood": _commitment_redirect_stood,
    "consent_markup_and_unverified_listing": _consent_markup_and_unverified_listing,
    "consent_redirect_ran": _p6_turn("consent", True),
    "consent_redirect_no_call": _p6_turn("consent", False),
    "consent_redirect_markup_refused": _p6_not_reached_turn("M1_consent_markup"),
    "listing_redirect_ran": _p6_turn("listing", True),
    "listing_redirect_no_call": _p6_turn("listing", False),
    "offer_redirect_ran": _p6_turn("offer", True),
    "offer_redirect_no_call": _p6_turn("offer", False),
    "consent_closing_markup": _consent_closing_markup,
    "teams_turn": _teams_turn,
    "notepad_turn": _notepad_turn,
    "failed_launch": _failed_launch,
    "delegated_launch": _delegated_launch,
    "offer_ran_report_failed": _offer_ran_report_failed,
    "completion_ran_report_failed": _completion_ran_report_failed,
    "bare_intent_ran_report_failed": _bare_intent_ran_report_failed,
    "bare_intent_closing_markup": _bare_intent_closing_markup,
}


@requires_db
@pytest.mark.parametrize("name", sorted(LIVE_STORED_TURNS))
async def test_R6_what_core_streams_for_a_turn_is_what_it_stores(
    name, owner_client, pool, mount_peers, monkeypatch, tmp_path
):
    monkeypatch.setenv("WORKSPACE_ROOT", str(tmp_path / "ws"))
    kind, streamed, ask, rounds = await LIVE_STORED_TURNS[name](
        pool, mount_peers, monkeypatch, tmp_path
    )
    mount_peers(gateway=ScriptedGateway(rounds=rounds), memory=FakeMemory())

    resp = await owner_client.post("/api/v1/chat/stream", json={"message": ask})
    assert resp.status_code == 200, resp.text
    await chat.drain_background()
    raw = _UUID.sub(_NO_ID, resp.text)
    stored = await _reply_of(pool, "chat")

    entry = {"class": kind, "raw": raw, "stored": stored}
    if streamed is not None:
        entry["streamed"] = streamed
    corrections = _corrections(frames(raw))
    if kind == "redirect":
        # Live vs truth (fix round 5, P6): the note shown ahead of a
        # regeneration that stood claims work only when a call was dispatched —
        # one that REACHED a tool's executor. A refused call files a span too,
        # so any tool span is not the record; dispatch's own is.
        note, *after = corrections
        dispatched = bool(await _reached_executor(pool))
        claims_work = note in (
            chat.DEFERRAL_NOTE,
            chat.CONSENT_REDIRECT_NOTE,
            chat.PRESENTED_LISTING_REDIRECT_NOTE,
            chat.STATE_REDIRECT_NOTE,
            chat.MACHINE_REDIRECT_NOTE,
        )
        assert claims_work is dispatched, (note, dispatched)
        assert note not in stored  # live-only
        assert stored.endswith("\n\n".join(after)) if after else True
        entry.update(note=note, dispatched=dispatched, note_claims_work=claims_work)
    else:
        # Core's own half: what it streams as corrections is how the stored
        # reply ends, in order — never a line it does not keep.
        assert stored.endswith("\n\n".join(corrections)), (corrections, stored)
        if kind == "replace":
            assert stored == "\n\n".join(corrections)
    fixture = json.loads(LIVE_STORED.read_text()) if LIVE_STORED.exists() else {}
    if os.environ.get("NOVA_WRITE_LIVE_STORED") == "1":
        fixture[name] = entry
        LIVE_STORED.write_text(
            json.dumps(fixture, indent=1, sort_keys=True, ensure_ascii=False) + "\n"
        )
    assert fixture.get(name) == entry, (
        f"{name}: core's stream or stored reply changed — regenerate {LIVE_STORED.name} with "
        "NOVA_WRITE_LIVE_STORED=1 and run apps/web's liveStored.test.ts"
    )


def test_R6_the_fixture_holds_exactly_these_turns():
    """No stale turn is left in the file the web suite reads."""
    assert sorted(json.loads(LIVE_STORED.read_text())) == sorted(LIVE_STORED_TURNS)


# -- fix round 5 (2026-09-30, the controller's rulings P1, P2, P5, P6) -----------

# P1 — a delegation that MAY have run. The re-review's repro (scratchpad
# rr5/test_rr5_chat.py, B): ops really launches Notepad, then the executor
# raises reading the child's turn back — before it files the child-turn marker
# — so round 4's check saw no run and her true relay got "(No
# device_launch_app … call ran …)". A scripted delegate step copies no facts at
# all. Only a delegation refused before any run leaves the pair armed.


async def _delegation_that_raises_after_its_child_ran(pool, mount_peers, monkeypatch, tmp_path):
    from app import agents
    from tests.test_chat_agents import _create

    monkeypatch.setenv("WORKSPACE_ROOT", str(tmp_path / "ws"))
    await _pair(pool)
    launcher = _arm(monkeypatch, "device_launch_app", LAUNCHED_NOTEPAD)
    await _create(pool, mount_peers, name="ops", tools=("device_launch_app",))

    def the_read_back_fails(*_args, **_kwargs):
        raise RuntimeError("the read-back failed")

    monkeypatch.setattr(agents, "run_facts", the_read_back_fails)
    return launcher


@requires_db
async def test_P1_a_delegation_that_raised_after_its_child_launched_leaves_no_sentence(
    owner_client, pool, mount_peers, monkeypatch, tmp_path
):
    launcher = await _delegation_that_raises_after_its_child_ran(
        pool, mount_peers, monkeypatch, tmp_path
    )
    relay = T98ECFB11
    gateway = ScriptedGateway(
        rounds=(
            (
                call(
                    "delegate_to_agent", {"agent": "ops", "task": f"open notepad on {DEVICE}"}, "n1"
                ),
            ),
            (call("device_launch_app", {"device": DEVICE, "app": "notepad"}, "c1"),),
            (text(f"I launched Notepad on {DEVICE}; Windows accepted it."),),
            (text(relay),),
        )
    )
    mount_peers(gateway=gateway, memory=FakeMemory())

    sent = await _say(owner_client, "have ops open notepad on my dell")

    assert launcher.calls == [{"device": DEVICE, "app": "notepad"}]  # the child ran it
    delegate = await pool.fetchrow(
        "SELECT meta FROM turn_spans WHERE name = 'delegate_to_agent' AND kind = 'tool'"
    )
    meta = _meta(delegate)
    assert meta["ok"] is False and not meta.get("facts")  # no child-turn marker
    assert await _reply_of(pool, "chat") == relay
    assert _corrections(sent) == []
    assert await _guard_spans_of(pool, "chat") == []


@requires_db
async def test_P1_a_scripted_delegate_step_that_may_have_run_leaves_no_sentence(
    owner_client, pool, mount_peers, monkeypatch, tmp_path
):
    """The scripted step's span carries no facts (chat._run_script_step copies
    none), so it could never show a child-turn marker: a delegation made by a
    script that did not report back may have launched all the same."""
    from app import skills
    from tests.test_chat_skills import _skill
    from tests.test_chat_tools import whole_call

    launcher = await _delegation_that_raises_after_its_child_ran(
        pool, mount_peers, monkeypatch, tmp_path
    )
    await _skill(pool, tmp_path / "ws", "notepad-via-ops")
    await skills.set_script(
        pool,
        "notepad-via-ops",
        {
            "version": 1,
            "steps": [
                {
                    "tool": "delegate_to_agent",
                    "args": {"agent": "ops", "task": f"open notepad on {DEVICE}"},
                }
            ],
        },
        {"type": "object", "properties": {}, "additionalProperties": False},
    )
    gateway = ScriptedGateway(
        rounds=(
            (whole_call("s1", "run_skill", {"name": "notepad-via-ops", "inputs": {}}),),
            (call("device_launch_app", {"device": DEVICE, "app": "notepad"}, "c1"),),
            (text(f"I launched Notepad on {DEVICE}; Windows accepted it."),),
            (text(T98ECFB11),),
        )
    )
    mount_peers(gateway=gateway, memory=FakeMemory())

    sent = await _say(owner_client, "run the notepad skill")

    assert launcher.calls == [{"device": DEVICE, "app": "notepad"}]
    step = await pool.fetchrow(
        "SELECT meta FROM turn_spans WHERE name = 'delegate_to_agent' AND kind = 'tool'"
    )
    assert _meta(step).get("via_skill") is True and not _meta(step).get("facts")
    assert await _reply_of(pool, "chat") == T98ECFB11
    assert _corrections(sent) == []


# P2 — the live order is the stored order (rr5 A). The consent redirect's probe
# ran and its closing round wrote a call as markup (a note stored), and the
# reply also presented a listing with a tool run (the unverified note). The
# markup note was streamed after the unverified note and stored before it.


@requires_db
async def test_P2_the_backend_lines_are_shown_in_the_order_they_are_stored(
    owner_client, pool, mount_peers, monkeypatch
):
    from tests.test_chat_markup import FABRICATION, PROBE, _arm_probe, real_call
    from tests.test_chat_presented_listing import FABRICATED
    from tests.test_markup_calls import OBSERVED

    spy = await _arm_probe(pool, monkeypatch)
    reply = f"{FABRICATION}\n\n{FABRICATED}"
    gateway = ScriptedGateway(
        rounds=(
            (text(reply),),
            (real_call("r1", PROBE, {"device": DEVICE, "argv": ["tree"]}),),
            (text(OBSERVED),),
        )
    )
    mount_peers(gateway=gateway, memory=FakeMemory())

    sent = await _say(owner_client, "try again")

    assert spy.calls == [{"device": DEVICE, "argv": ["tree"]}]
    stored = await _reply_of(pool, "chat")
    corrections = _corrections(sent)
    assert corrections[-1] == chat.PRESENTED_LISTING_UNVERIFIED_NOTE
    assert stored == "\n\n".join(corrections)
    assert _texts(sent) == [reply]


# P5 — the consent correction says "nothing has run" only when nothing did.


def test_P5_the_consent_correction_is_derived_from_what_ran():
    none = chat._consent_correction([])
    assert none == guards.CONSENT_CLAIM_CORRECTION and "nothing has run" in none
    refused = _span("device_run", ok=False, refused_markup=True)
    assert chat._consent_correction([refused]) == guards.CONSENT_CLAIM_CORRECTION
    ran = chat._consent_correction([_span("device_info"), _span("device_run", ok=False)])
    assert ran == (
        "Correction: there is no approval step — nothing is waiting on you. "
        "This turn, device_info ran and device_run failed."
    )
    for said in (ran, chat._consent_correction([_span("markup_probe")])):
        assert "nothing has run" not in said
        assert "again" not in said.lower()


def test_P5_every_consent_correction_is_clean_under_the_whole_guard_family():
    for said in (
        chat._consent_correction([_span("markup_probe")]),
        chat._consent_correction([_span("device_info"), _span("device_run", ok=False)]),
    ):
        assert guards.consent_claim_check(said) is None, said
        assert guards.narration_check(said, []) is None, said
        assert guards.capability_claim_check(said, NAMES) is None, said
        assert guards.state_claim_check(said, [], [DEVICE], purpose="chat") is None, said
        assert guards.deferral_check(said, [], NAMES, user_message="try again") is None, said
        assert guards.bare_intent_check(said, []) is None, said
        assert guards.written_call_check(said, [], NAMES) is None, said
        assert guards.device_completion_check(said, [], NAMES, [DEVICE]) is None, said


@requires_db
@pytest.mark.parametrize("how", ["the probe ran", "the probe failed", "nothing ran"])
async def test_P5_the_consent_redirect_states_what_its_own_round_ran(
    how, owner_client, pool, mount_peers, monkeypatch
):
    from tests.test_chat_pending_claim import AUTO_ACTION, FABRICATION, URL, auto_call

    attempts: list = []

    async def probe(args: dict, ctx: ToolContext) -> str:
        attempts.append(args)
        if how == "the probe failed":
            raise ToolFailure("the light did not answer")
        return "Ran it: the desk light is on."

    from tests.test_chat_pending_claim import FETCH_SCHEMA

    monkeypatch.setitem(tools.REGISTRY, AUTO_ACTION, Tool(AUTO_ACTION, "d", FETCH_SCHEMA, probe))
    down = Refusal(502, {"error": {"message": "upstream down"}})
    if how == "nothing ran":
        rounds = ((text(FABRICATION),), down)
    else:
        rounds = ((text(FABRICATION),), (auto_call("r1", URL),), down)
    mount_peers(gateway=ScriptedGateway(rounds=rounds), memory=FakeMemory())

    sent = await _say(owner_client, "turn on the desk light")

    stored = await _stored(pool)
    expected = {
        "the probe ran": (
            "Correction: there is no approval step — nothing is waiting on you. "
            f"This turn, {AUTO_ACTION} ran."
        ),
        "the probe failed": (
            "Correction: there is no approval step — nothing is waiting on you. "
            f"This turn, {AUTO_ACTION} failed."
        ),
        "nothing ran": guards.CONSENT_CLAIM_CORRECTION,
    }[how]
    assert stored == expected
    assert _corrections(sent) == [expected]
    assert len(attempts) == (0 if how == "nothing ran" else 1)


# P6 — a live note never claims work the regeneration did not do. "Doing that
# now…", "Nothing was pending — doing it now…" and "Listing the files now…" were
# shown beside regenerations that dispatched nothing (none of them is stored,
# so a reload hid it). Each is shown only beside a dispatched call; otherwise
# the kind's own no-call note.


def test_P6_every_redirect_names_its_no_call_note():
    """No default: a claim kind added tomorrow cannot fall back to "doing it
    now" beside a regeneration that did nothing."""
    parameter = inspect.signature(chat._claim_redirect).parameters["redirect_note_no_call"]
    assert parameter.default is inspect.Parameter.empty
    source = inspect.getsource(chat._run_turn)
    assert source.count("_claim_redirect(") == source.count("redirect_note_no_call=")


def test_P6_the_no_call_notes_claim_no_work_and_trip_no_guard():
    for note in (
        chat.DEFERRAL_NOTE_NO_CALL,
        chat.DEFERRAL_COMPLETION_NOTE_NO_CALL,
        chat.CONSENT_REDIRECT_NOTE_NO_CALL,
        chat.PRESENTED_LISTING_REDIRECT_NOTE_NO_CALL,
    ):
        assert " now" not in note, note
        assert guards.consent_claim_check(note) is None, note
        assert guards.narration_check(note, []) is None, note
        assert guards.capability_claim_check(note, NAMES) is None, note
        assert guards.deferral_check(note, [], NAMES, user_message="try again") is None, note
        assert guards.bare_intent_check(note, []) is None, note
        assert guards.presented_listing_check(note, [], []) is None, note
        assert guards.state_claim_check(note, [], [DEVICE], purpose="chat") is None, note


async def _p6_offer(pool, monkeypatch, *, dispatched: bool):
    from tests.test_chat_deferral import INSTRUCTION, OFFER, _arm_web_search, _search_call

    _arm_web_search(monkeypatch)
    if dispatched:
        answer = "The Pixel 10 launched with a Tensor G5 and a 50-megapixel camera."
        rounds = ((text(OFFER),), (_search_call("r1"),), (text(answer),))
    else:
        answer = "I have not searched the web this turn, so I have no results to give you."
        rounds = ((text(OFFER),), (text(answer),))
    return OFFER, INSTRUCTION, rounds, answer, (chat.DEFERRAL_NOTE, chat.DEFERRAL_NOTE_NO_CALL)


async def _p6_consent(pool, monkeypatch, *, dispatched: bool):
    from tests.test_chat_pending_claim import FABRICATION, URL, _arm_auto_tool, auto_call

    await _arm_auto_tool(pool, monkeypatch)
    if dispatched:
        answer = "Done — the desk light is on."
        rounds = ((text(FABRICATION),), (auto_call("r1", URL),), (text(answer),))
    else:
        answer = "There is no approval step. I have not run anything yet."
        rounds = ((text(FABRICATION),), (text(answer),))
    notes = (chat.CONSENT_REDIRECT_NOTE, chat.CONSENT_REDIRECT_NOTE_NO_CALL)
    return FABRICATION, "turn on the desk light", rounds, answer, notes


async def _p6_listing(pool, monkeypatch, *, dispatched: bool, tmp_path=None):
    from tests.test_chat_presented_listing import ASK, FABRICATED, HONEST, REAL_FILES, tool_call

    root = tmp_path / "workspace"
    for rel, body in REAL_FILES.items():
        path = root / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(body)
    monkeypatch.setenv("WORKSPACE_ROOT", str(root))
    if dispatched:
        answer = HONEST
        rounds = (
            (text(FABRICATED),),
            (tool_call("r1", "workspace_list_files", {}),),
            (text(answer),),
        )
    else:
        answer = "I have not listed the workspace this turn, so I will not show a listing."
        rounds = ((text(FABRICATED),), (text(answer),))
    notes = (chat.PRESENTED_LISTING_REDIRECT_NOTE, chat.PRESENTED_LISTING_REDIRECT_NOTE_NO_CALL)
    return FABRICATED, ASK, rounds, answer, notes


P6_KINDS = {"offer": _p6_offer, "consent": _p6_consent, "listing": _p6_listing}


@requires_db
@pytest.mark.parametrize("dispatched", [True, False], ids=["a call", "no call"])
@pytest.mark.parametrize("kind", sorted(P6_KINDS))
async def test_P6_a_redirect_note_claims_work_only_beside_a_dispatched_call(
    kind, dispatched, owner_client, pool, mount_peers, monkeypatch, tmp_path
):
    build = P6_KINDS[kind]
    kwargs = {"tmp_path": tmp_path} if kind == "listing" else {}
    reply, ask, rounds, answer, (doing, no_call) = await build(
        pool, monkeypatch, dispatched=dispatched, **kwargs
    )
    mount_peers(gateway=ScriptedGateway(rounds=rounds), memory=FakeMemory())

    sent = await _say(owner_client, ask)

    assert bool(await _reached_executor(pool)) is dispatched
    assert await _stored(pool) == answer  # the regeneration stood
    assert _corrections(sent) == [doing if dispatched else no_call]
    assert _texts(sent) == [reply, answer]


@requires_db
async def test_P6_a_completion_regeneration_that_ran_nothing_says_so(
    owner_client, pool, mount_peers, monkeypatch
):
    from tests.test_chat_deferral import COMPLETION, REMINDER_INSTRUCTION, _arm_create_timer

    spy = _arm_create_timer(monkeypatch)
    answer = "I have not set that reminder yet — no timer exists for it."
    mount_peers(
        gateway=ScriptedGateway(rounds=((text(COMPLETION),), (text(answer),))),
        memory=FakeMemory(),
    )

    sent = await _say(owner_client, REMINDER_INSTRUCTION)

    assert spy.calls == []
    assert await _stored(pool) == answer
    assert _corrections(sent) == [chat.DEFERRAL_COMPLETION_NOTE_NO_CALL]


@requires_db
async def test_P6_a_bare_intent_regeneration_that_ran_nothing_says_so(
    owner_client, pool, mount_peers, monkeypatch
):
    await _pair(pool)
    info = _arm(monkeypatch, "device_info", f"{DEVICE} system info:\nWindows 11")
    answer = f"I have not checked your {DEVICE} this turn."
    mount_peers(
        gateway=ScriptedGateway(rounds=((text(BARE_CHECK),), (text(answer),))),
        memory=FakeMemory(),
    )

    sent = await _say(owner_client, "what OS is my dell on?")

    assert info.calls == []
    assert await _stored(pool) == answer
    assert _corrections(sent) == [chat.DEFERRAL_NOTE_NO_CALL]


# -- P6 at the cap: DISPATCHED means a call REACHED a tool's executor ------------
#
# The final re-review (M1–M6): the redirect counted its regeneration as
# dispatched the moment it ASKED for a call — before _dispatch_calls refused one
# written as text, and before tools.dispatch refused a name no tool has. So the
# owner's own failure mode, a call written as text, still streamed "Nothing was
# pending — doing it now…", "Doing that now…", "Listing the files now…" or
# "Checking the device now…" beside a call that never ran. The ruling: a
# regeneration is dispatched only when one of its calls REACHED a tool's
# executor, read from what dispatch did (`reached`, and `reached_executor` on
# the span _run_tool files) — never a second copy of the refusal rules. A call
# whose executor ran and FAILED counts: it was an attempt.


def markup(name: str, **params: str) -> str:
    """A call written as TEXT, in the observed markup shape (the model's mangled
    prefix and all): read out of the reply, refused, never run."""
    body = "".join(f'<atem:parameter name="{k}">{v}</atem:parameter>\n' for k, v in params.items())
    return (
        f'<atem:function_calls>\n<atem:invoke name="{name}">\n{body}'
        "</atem:invoke>\n</atem:function_calls>"
    )


@dataclass
class _NotReached:
    guard: str  # the claim kind's guard span
    reply: str  # what she streamed first
    ask: str
    rounds: tuple
    answer: str  # the regeneration, which stands
    doing: str  # the note that claims work
    no_call: str  # the note that must stream instead
    executor: list | None  # the executor's calls, where a spy stands in for it


async def _m1_consent_markup(pool, monkeypatch, tmp_path) -> _NotReached:
    from tests.test_chat_pending_claim import AUTO_ACTION, FABRICATION, URL, _arm_auto_tool

    spy = await _arm_auto_tool(pool, monkeypatch)
    answer = "There is no approval step. I have not run anything yet."
    rounds = ((text(FABRICATION),), (text(markup(AUTO_ACTION, url=URL)),), (text(answer),))
    return _NotReached(
        "consent_claim",
        FABRICATION,
        "turn on the desk light",
        rounds,
        answer,
        chat.CONSENT_REDIRECT_NOTE,
        chat.CONSENT_REDIRECT_NOTE_NO_CALL,
        spy.calls,
    )


async def _m2_offer_markup(pool, monkeypatch, tmp_path) -> _NotReached:
    from tests.test_chat_deferral import INSTRUCTION, OFFER, _arm_web_search

    spy = _arm_web_search(monkeypatch)
    answer = "I have not searched the web this turn, so I have no results to give you."
    rounds = (
        (text(OFFER),),
        (text(markup("web_search", query="latest pixel phone")),),
        (text(answer),),
    )
    return _NotReached(
        "deferral",
        OFFER,
        INSTRUCTION,
        rounds,
        answer,
        chat.DEFERRAL_NOTE,
        chat.DEFERRAL_NOTE_NO_CALL,
        spy.calls,
    )


async def _m3_listing_markup(pool, monkeypatch, tmp_path) -> _NotReached:
    from tests.test_chat_presented_listing import ASK, FABRICATED, REAL_FILES

    root = tmp_path / "workspace"
    for rel, body in REAL_FILES.items():
        path = root / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(body)
    monkeypatch.setenv("WORKSPACE_ROOT", str(root))
    answer = "I have not listed the workspace this turn, so I will not show a listing."
    rounds = ((text(FABRICATED),), (text(markup("workspace_list_files")),), (text(answer),))
    return _NotReached(
        "presented_listing",
        FABRICATED,
        ASK,
        rounds,
        answer,
        chat.PRESENTED_LISTING_REDIRECT_NOTE,
        chat.PRESENTED_LISTING_REDIRECT_NOTE_NO_CALL,
        None,  # the real executor: the spans say it never ran
    )


async def _m4_bare_intent_markup(pool, monkeypatch, tmp_path) -> _NotReached:
    await _pair(pool)
    info = _arm(monkeypatch, "device_info", f"{DEVICE} system info:\nWindows 11")
    answer = f"I have not checked your {DEVICE} this turn."
    rounds = ((text(BARE_CHECK),), (text(markup("device_info", device=DEVICE)),), (text(answer),))
    return _NotReached(
        "deferral",
        BARE_CHECK,
        "what OS is my dell on?",
        rounds,
        answer,
        chat.DEFERRAL_NOTE,
        chat.DEFERRAL_NOTE_NO_CALL,
        info.calls,
    )


async def _m5_state_markup(pool, monkeypatch, tmp_path) -> _NotReached:
    await _pair(pool)
    info = _arm(monkeypatch, "device_info", f"{DEVICE} system info:\nWindows 11")
    reply = "The device is still offline."
    answer = "I have not checked the device this turn."
    rounds = ((text(reply),), (text(markup("device_info", device=DEVICE)),), (text(answer),))
    return _NotReached(
        "state_claim",
        reply,
        "is my dell up?",
        rounds,
        answer,
        chat.STATE_REDIRECT_NOTE,
        chat.STATE_REDIRECT_NOTE_NO_CALL,
        info.calls,
    )


async def _m6_consent_unknown_tool(pool, monkeypatch, tmp_path) -> _NotReached:
    from tests.test_chat_pending_claim import FABRICATION

    assert "turn_on_light" not in tools.REGISTRY
    answer = "There is no approval step. I have not run anything yet."
    rounds = (
        (text(FABRICATION),),
        (call("turn_on_light", {"room": "desk"}, "r1"),),
        (text(answer),),
    )
    return _NotReached(
        "consent_claim",
        FABRICATION,
        "turn on the desk light",
        rounds,
        answer,
        chat.CONSENT_REDIRECT_NOTE,
        chat.CONSENT_REDIRECT_NOTE_NO_CALL,
        None,  # there is no executor to reach
    )


P6_NOT_REACHED = {
    "M1_consent_markup": _m1_consent_markup,
    "M2_offer_markup": _m2_offer_markup,
    "M3_listing_markup": _m3_listing_markup,
    "M4_bare_intent_markup": _m4_bare_intent_markup,
    "M5_state_markup": _m5_state_markup,
    "M6_consent_unknown_tool": _m6_consent_unknown_tool,
}


@requires_db
@pytest.mark.parametrize("case", sorted(P6_NOT_REACHED))
async def test_P6_a_call_that_never_reached_an_executor_dispatched_nothing(
    case, owner_client, pool, mount_peers, monkeypatch, tmp_path
):
    m = await P6_NOT_REACHED[case](pool, monkeypatch, tmp_path)
    mount_peers(gateway=ScriptedGateway(rounds=m.rounds), memory=FakeMemory())

    sent = await _say(owner_client, m.ask)

    # The regeneration ASKED for one call, and its span records it — refused,
    # so nothing reached an executor.
    assert len(await pool.fetch("SELECT 1 FROM turn_spans WHERE kind = 'tool'")) == 1
    assert await _reached_executor(pool) == []
    if m.executor is not None:
        assert m.executor == []
    # The no-call note streams, and the note that claims work never does.
    assert _corrections(sent) == [m.no_call]
    assert m.doing not in json.dumps(sent, ensure_ascii=False)
    # The regeneration stood: live is her prose, the note, then exactly what is
    # stored; the note itself is live-only.
    stored = await _stored(pool)
    assert _texts(sent) == [m.reply, m.answer]
    assert stored == m.answer
    assert m.no_call not in stored
    # The guard span records what the dispatch did, not what was asked for.
    (redirect,) = [
        meta for meta in map(_meta, await _named(pool, m.guard)) if "redirect_tool_calls" in meta
    ]
    assert redirect["redirected"] is True
    assert (redirect["redirect_tool_calls"], redirect["redirect_calls_reached"]) == (1, 0)


@requires_db
async def test_P6_a_call_whose_executor_ran_and_failed_was_dispatched(
    owner_client, pool, mount_peers, monkeypatch
):
    """The other side of the line: a call that reached its executor was an
    attempt even when the executor failed, so the note that claims work streams
    — and the regeneration says what happened."""
    from tests.test_chat_pending_claim import AUTO_ACTION, FABRICATION, FETCH_SCHEMA, URL, auto_call

    attempts: list = []

    async def probe(args: dict, ctx: ToolContext) -> str:
        attempts.append(args)
        raise ToolFailure("the light did not answer")

    monkeypatch.setitem(tools.REGISTRY, AUTO_ACTION, Tool(AUTO_ACTION, "d", FETCH_SCHEMA, probe))
    answer = "The call to turn on the desk light failed: the light did not answer."
    rounds = ((text(FABRICATION),), (auto_call("r1", URL),), (text(answer),))
    mount_peers(gateway=ScriptedGateway(rounds=rounds), memory=FakeMemory())

    sent = await _say(owner_client, "turn on the desk light")

    assert len(attempts) == 1
    assert await _reached_executor(pool) == [AUTO_ACTION]
    (span,) = await pool.fetch("SELECT meta FROM turn_spans WHERE kind = 'tool'")
    assert _meta(span)["ok"] is False
    assert _corrections(sent) == [chat.CONSENT_REDIRECT_NOTE]
    assert await _stored(pool) == answer
    (guard,) = await _named(pool, "consent_claim")
    assert _meta(guard)["redirect_calls_reached"] == 1


P6_SCHEMA = {"type": "object", "properties": {}, "additionalProperties": False}


def _arm_p6_tools(monkeypatch) -> None:
    """Four registered tools whose executors answer, state a failure, raise, and
    say nothing: every way a call that REACHED its executor can end."""

    async def answers(args: dict, ctx: ToolContext) -> str:
        return "ran"

    async def fails(args: dict, ctx: ToolContext) -> str:
        raise ToolFailure("it did not answer")

    async def crashes(args: dict, ctx: ToolContext) -> str:
        raise RuntimeError("a bug")

    async def silent(args: dict, ctx: ToolContext) -> str:
        return ""

    for tool_name, executor in (
        ("p6_answers", answers),
        ("p6_fails", fails),
        ("p6_crashes", crashes),
        ("p6_silent", silent),
    ):
        monkeypatch.setitem(tools.REGISTRY, tool_name, Tool(tool_name, "d", P6_SCHEMA, executor))


@pytest.mark.parametrize(
    ("name", "arguments", "reached"),
    [
        pytest.param("p6_answers", "{}", True, id="the executor answered"),
        pytest.param("p6_fails", "{}", True, id="it ran and stated a failure"),
        pytest.param("p6_crashes", "{}", True, id="it ran and raised"),
        pytest.param("p6_silent", "{}", True, id="it ran and said nothing"),
        pytest.param("p6_not_there", "{}", False, id="no tool by that name"),
        pytest.param("p6_answers", "{not json", False, id="arguments unreadable"),
        pytest.param("p6_answers", '{"extra": 1}', False, id="arguments off the schema"),
    ],
)
async def test_P6_dispatch_records_a_call_only_once_its_executor_ran(
    name, arguments, reached, monkeypatch, tmp_path
):
    """dispatch's own record is the ONE place "did a tool run" is read from: a
    call it refused before any executor is not in it, a call whose executor ran
    is, whatever the executor did."""
    _arm_p6_tools(monkeypatch)
    monkeypatch.setenv("WORKSPACE_ROOT", str(tmp_path))
    ctx = tools.context_for(None, Person(id=uuid.uuid4(), name="owner", role="owner"))

    record: list[str] = []
    result, ok = await tools.dispatch(name, arguments, ctx, reached=record)

    assert record == ([name] if reached else [])
    assert ok is (name == "p6_answers" and reached)
    assert (await tools.dispatch(name, arguments, ctx)) == (result, ok)  # no record asked for


@pytest.mark.parametrize(
    ("call", "subset", "reached", "ended"),
    [
        pytest.param(chat.ToolCall("c1", "p6_answers", "{}"), None, True, "ok", id="it ran"),
        pytest.param(
            chat.ToolCall("c1", "p6_fails", "{}"), None, True, "error", id="it ran and failed"
        ),
        pytest.param(
            chat.ToolCall("c1", "p6_answers", "{}", from_markup=True),
            None,
            False,
            "error",
            id="written as text",
        ),
        pytest.param(
            chat.ToolCall("c1", "p6_not_there", "{}"), None, False, "error", id="no such tool"
        ),
        pytest.param(
            chat.ToolCall("c1", "p6_not_there", "{}"),
            ("p6_answers",),
            False,
            "error",
            id="no such tool, in a subset",
        ),
        pytest.param(
            chat.ToolCall("c1", "p6_answers", '{"extra": 1}'),
            None,
            False,
            "error",
            id="off the schema",
        ),
    ],
)
async def test_P6_dispatch_calls_records_only_a_call_that_reached_its_executor(
    call, subset, reached, ended, monkeypatch, tmp_path
):
    """The record the redirect reads, at the layer it reads it. _dispatch_calls
    refuses a call written as text, or one naming no tool in a subset, itself;
    dispatch refuses the rest before any executor; only a call whose executor
    ran — whatever it returned — is in the record, and its span says the same.
    The frames cannot say it: a refusal is started and ends in an error exactly
    like an executor that ran and failed, so the property is pinned here."""
    _arm_p6_tools(monkeypatch)
    turn = traces.Turn(id=uuid.uuid4(), started_at=datetime.now(UTC))
    ctx = tools.ToolContext(app=None, person=None, workspace_root=tmp_path)
    sent: list[str] = []
    record: list[str] = []

    await chat._dispatch_calls(turn, ctx, [call], [], sent.append, subset=subset, reached=record)

    assert record == ([call.name] if reached else [])
    (span,) = turn.spans
    assert (span.kind, span.name) == ("tool", call.name)
    assert (span.meta.get("reached_executor") is True) is reached
    statuses = [json.loads(frame[len("data: ") :])["activity"]["status"] for frame in sent]
    assert statuses == ["start", ended]


# -- the final review (I-1, M-1): a note names its kind of work only after it ----
#
# I-1 (U1 re-opened): a call of ANOTHER kind reached its executor — a web search
# — and the listing redirect streamed "Listing the files now instead of
# presenting a listing from memory.", the state redirect "Checking the device
# now…". A note that names a kind of work streams only when the ORIGINATING
# guard, re-run on the ORIGINAL reply against the FINAL spans, finds the claim
# backed; otherwise the kind's no-call note. The generic notes keep P6's rule.


async def _i1_listing(pool, monkeypatch, tmp_path, *, its_own_kind: bool):
    from tests.test_chat_deferral import _arm_web_search, _search_call
    from tests.test_chat_presented_listing import ASK, FABRICATED, HONEST, REAL_FILES, tool_call

    root = tmp_path / "workspace"
    for rel, body in REAL_FILES.items():
        path = root / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(body)
    monkeypatch.setenv("WORKSPACE_ROOT", str(root))
    if its_own_kind:
        answer = HONEST
        regen = (tool_call("r1", "workspace_list_files", {}),)
    else:  # the reviewer's X5
        _arm_web_search(monkeypatch)
        answer = "Your workspace holds a config file, a readme, some notes and a src folder."
        regen = (_search_call("r1"),)
    notes = (chat.PRESENTED_LISTING_REDIRECT_NOTE, chat.PRESENTED_LISTING_REDIRECT_NOTE_NO_CALL)
    return (
        "presented_listing",
        FABRICATED,
        ASK,
        ((text(FABRICATED),), regen, (text(answer),)),
        answer,
        notes,
    )


async def _i1_state(pool, monkeypatch, tmp_path, *, its_own_kind: bool):
    from tests.test_chat_deferral import _arm_web_search, _search_call

    await _pair(pool)
    reply = "The device is still offline."
    if its_own_kind:
        _arm(monkeypatch, "device_info", f"{DEVICE} system info:\nWindows 11")
        answer = f"{DEVICE} is connected — it came back online."
        regen = (call("device_info", {"device": DEVICE}, "r1"),)
    else:  # the reviewer's X6
        _arm_web_search(monkeypatch)
        answer = "I looked this up on the web; I cannot say more about it from here."
        regen = (_search_call("r1"),)
    notes = (chat.STATE_REDIRECT_NOTE, chat.STATE_REDIRECT_NOTE_NO_CALL)
    return (
        "state_claim",
        reply,
        "is my dell up?",
        ((text(reply),), regen, (text(answer),)),
        answer,
        notes,
    )


I1_KINDS = {"listing": _i1_listing, "state": _i1_state}


@requires_db
@pytest.mark.parametrize("its_own_kind", [True, False], ids=["its own kind", "another kind"])
@pytest.mark.parametrize("kind", sorted(I1_KINDS))
async def test_I1_a_note_naming_its_work_streams_only_when_the_guard_finds_it_done(
    kind, its_own_kind, owner_client, pool, mount_peers, monkeypatch, tmp_path
):
    guard, reply, ask, rounds, answer, (doing, no_call) = await I1_KINDS[kind](
        pool, monkeypatch, tmp_path, its_own_kind=its_own_kind
    )
    mount_peers(gateway=ScriptedGateway(rounds=rounds), memory=FakeMemory())

    sent = await _say(owner_client, ask)

    # A call reached its executor either way; only its kind differs.
    assert len(await _reached_executor(pool)) == 1
    assert _corrections(sent) == [doing if its_own_kind else no_call]
    assert (no_call if its_own_kind else doing) not in json.dumps(sent, ensure_ascii=False)
    # The regeneration stood: live is her prose, the note, then exactly what is
    # stored; the note itself is live-only.
    assert _texts(sent) == [reply, answer]
    assert await _stored(pool) == answer
    # The trace says why the note was chosen: the guard's own re-check.
    (redirect,) = [
        meta for meta in map(_meta, await _named(pool, guard)) if "redirect_tool_calls" in meta
    ]
    assert redirect["redirect_calls_reached"] == 1
    assert redirect["claim_backed"] is its_own_kind


@requires_db
async def test_I1_a_recheck_that_raises_shows_the_no_call_note(
    owner_client, pool, mount_peers, monkeypatch, tmp_path
):
    """The re-check runs after the regeneration stood, outside the redirect's
    own fail-open: if it raises, the note that claims nothing is shown, and the
    turn still stands."""
    guard, reply, ask, rounds, answer, (doing, no_call) = await _i1_listing(
        pool, monkeypatch, tmp_path, its_own_kind=True
    )

    def raises(*args, **kwargs):
        raise RuntimeError("re-check broke")

    monkeypatch.setattr(chat, "_listing_claim_stands", raises)
    mount_peers(gateway=ScriptedGateway(rounds=rounds), memory=FakeMemory())

    sent = await _say(owner_client, ask)

    assert _corrections(sent) == [no_call]
    assert await _stored(pool) == answer
    (redirect,) = [
        meta for meta in map(_meta, await _named(pool, guard)) if "redirect_tool_calls" in meta
    ]
    assert redirect["claim_backed"] is False


# M-1: a call that never reached an executor is not "X failed". The consent
# correction read every tool span that was not refused, so a tool that does not
# exist was "turn_on_light failed" — which says a turn_on_light exists.


def test_M1_a_call_that_never_reached_its_executor_is_not_said_to_have_failed():
    unknown = _span("turn_on_light", ok=False, reached_executor=False)
    assert chat._consent_correction([unknown]) == guards.CONSENT_CLAIM_CORRECTION
    failed = (
        "Correction: there is no approval step — nothing is waiting on you. "
        "This turn, device_run failed."
    )
    # An executor that ran and failed is said; so is a span with no record of
    # it (absent is "not recorded", never "not reached").
    for span in (
        _span("device_run", ok=False, reached_executor=True),
        _span("device_run", ok=False),
    ):
        assert chat._consent_correction([unknown, span]) == failed


@requires_db
async def test_M1_X1_a_tool_that_does_not_exist_is_never_said_to_have_failed(
    owner_client, pool, mount_peers
):
    """The reviewer's X1: the consent redirect's regeneration names a tool that
    does not exist, and its closing round repeats the pending claim, so the
    correction persists — and says nothing ran, live and stored."""
    from tests.test_chat_pending_claim import FABRICATION

    assert "turn_on_light" not in tools.REGISTRY
    rounds = (
        (text(FABRICATION),),
        (call("turn_on_light", {"room": "desk"}, "r1"),),
        (text(FABRICATION),),
    )
    mount_peers(gateway=ScriptedGateway(rounds=rounds), memory=FakeMemory())

    sent = await _say(owner_client, "turn on the desk light")

    assert await _reached_executor(pool) == []
    (span,) = await pool.fetch("SELECT name, meta FROM turn_spans WHERE kind = 'tool'")
    assert (span["name"], _meta(span)["reached_executor"]) == ("turn_on_light", False)
    stored = await _stored(pool)
    assert stored == guards.CONSENT_CLAIM_CORRECTION
    assert _corrections(sent) == [stored]


# The listing redirect's own call listed the files, then its closing round
# failed (a 502). "I did not actually list those files this turn" would be
# false: the listing guard's own re-check (A9, the state path's rule) names what
# ran instead — and what is stored is what was shown. A call of another kind
# lists nothing, so there the correction stands, and is true.
@requires_db
@pytest.mark.parametrize("its_own_kind", [True, False], ids=["it listed", "it searched"])
async def test_A9_a_listing_redirect_that_listed_and_lost_its_report_says_what_ran(
    its_own_kind, owner_client, pool, mount_peers, monkeypatch, tmp_path
):
    guard, reply, ask, rounds, answer, notes = await _i1_listing(
        pool, monkeypatch, tmp_path, its_own_kind=its_own_kind
    )
    down = Refusal(502, {"error": {"message": "upstream down"}})
    mount_peers(gateway=ScriptedGateway(rounds=(rounds[0], rounds[1], down)), memory=FakeMemory())

    sent = await _say(owner_client, ask)

    ran = "workspace_list_files" if its_own_kind else "web_search"
    assert await _reached_executor(pool) == [ran]
    stored = await _stored(pool)
    if its_own_kind:
        assert stored == chat._bare_intent_ran_but_unreported_note(ran)
        assert "did not actually list" not in json.dumps(sent, ensure_ascii=False)
    else:
        assert stored == guards.PRESENTED_LISTING_CORRECTION
    assert _corrections(sent) == [stored]  # what was shown is what is stored
    (redirect,) = [
        meta for meta in map(_meta, await _named(pool, guard)) if "redirect_tool_calls" in meta
    ]
    assert redirect["redirected"] is False
    assert redirect.get("correction_replaced_by") == (
        "ran_but_unreported" if its_own_kind else None
    )
