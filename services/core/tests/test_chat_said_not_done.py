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

import pytest

from app import chat, guards, tools
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
    assert _corrections(sent) == [chat.DEFERRAL_NOTE, NONE_ON_DELL]
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
