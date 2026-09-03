"""A tool call written as TEXT is never an answer — through the real turn.

The owner's walk, 2026-09-03 11:57. The consent redirect's closing round
advertises no tools by design; the model wanted to adapt `device_run tree` to
`find`, had no tool call available, and wrote the call out in Claude-style XML.
The four honesty guards passed it (an attempted ACTION is not a lie, a denial
or a state claim) and it was PERSISTED — the owner read raw XML, and the next
turn would have read it back out of history and learned to write more.

These drive the real route through a scripted gateway, so what is proven is the
loop: an open round DISPATCHES what the markup meant, through the same schema
validation / precheck / policy kernel as any call off the wire; a closed round
REFUSES it and says so; and nothing anywhere stores the markup.
"""
from __future__ import annotations

import json
import uuid
from dataclasses import dataclass, field

from app import chat, guards, markup_calls, tools
from app.tools import devices as device_tools
from app.tools.base import Tool, ToolContext
from tests.conftest import requires_db
from tests.fakes import FakeMemory, ScriptedGateway
from tests.test_markup_calls import OBSERVED

pytestmark = requires_db

DONE = "[DONE]"
DEVICE = "DELL-XPS-8950"
ARGV = ["find", "/home/jeremy", "-maxdepth", "2", "-type", "d", "-print"]
# The real device_run schema, so the parsed arguments face the validation the
# genuine call would have faced.
RUN_SCHEMA = next(t.parameters for t in device_tools.TOOLS if t.name == "device_run")
PROBE = "markup_probe"
FABRICATION = "That's still awaiting your approval — I can't run it until you OK it."
# The same block the model emitted, retargeted at the private probe tool, so a
# dispatch test can prove the executor really ran without repointing the real
# device_run action class (which other suites read).
PROBE_BLOCK = OBSERVED.replace('name="device_run"', f'name="{PROBE}"')


@dataclass
class Spy:
    calls: list = field(default_factory=list)
    result: str = "Ran it: three directories."

    async def __call__(self, args: dict, ctx: ToolContext) -> str:
        self.calls.append(args)
        return self.result


def frames(body: str) -> list:
    out = []
    for block in body.strip().split("\n\n"):
        assert block.startswith("data: "), block
        payload = block[len("data: ") :]
        out.append(payload if payload == DONE else json.loads(payload))
    return out


def text(piece: str) -> dict:
    return {"choices": [{"delta": {"content": piece}}]}


def real_call(call_id: str, name: str, arguments: dict) -> dict:
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


async def _say(client, message: str = "list my home directory") -> list:
    resp = await client.post("/api/v1/chat/stream", json={"message": message})
    assert resp.status_code == 200, resp.text
    return frames(resp.text)


async def _stored(pool) -> str:
    return await pool.fetchval(
        "SELECT content FROM messages WHERE role = 'assistant' ORDER BY created_at LIMIT 1"
    )


async def _tool_spans(pool) -> list:
    return await pool.fetch(
        "SELECT name, meta FROM turn_spans WHERE kind = 'tool' ORDER BY started_at"
    )


async def _llm_spans(pool) -> list:
    return await pool.fetch(
        "SELECT name, meta FROM turn_spans WHERE kind = 'llm_call' ORDER BY started_at"
    )


async def _arm_probe(pool, monkeypatch) -> Spy:
    """A private AUTO-disposition tool with device_run's own schema: the markup
    call must actually reach an executor, and the spy is the only proof that the
    real body ran."""
    spy = Spy()
    monkeypatch.setitem(tools.REGISTRY, PROBE, Tool(PROBE, "a probe", RUN_SCHEMA, spy))
    await pool.execute(
        "INSERT INTO action_classes (action_class, risk_tier, disposition, earned, "
        "consecutive_successes) VALUES ($1, 'device', 'auto', false, 0) "
        "ON CONFLICT (action_class) DO UPDATE SET disposition = 'auto', "
        "earned = false, consecutive_successes = 0, updated_at = now()",
        PROBE,
    )
    return spy


def _no_markup(stored: str) -> None:
    assert stored is not None
    for fragment in ("function_calls", "atem:", "<invoke", "parameter name="):
        assert fragment not in stored, stored


# -- (a) a round that ADVERTISED tools: the markup call is dispatched --------


async def test_markup_in_an_open_round_dispatches_through_the_normal_path(
    owner_client, pool, mount_peers, monkeypatch
):
    """The accommodation. Round 1 advertises tools and the model writes its call
    as XML instead of emitting it: the call is recovered, dispatched through the
    SAME machinery as any other (the spy proves the real body ran, with the
    arguments the markup meant), and the prose around it survives while the
    markup does not."""
    spy = await _arm_probe(pool, monkeypatch)
    gateway = ScriptedGateway(
        rounds=(
            (text("Let me adapt to find instead.\n\n"), text(PROBE_BLOCK)),
            (text("Three directories under your home."),),
        )
    )
    mount_peers(gateway=gateway, memory=FakeMemory())

    sent = await _say(owner_client)

    assert spy.calls == [{"device": DEVICE, "argv": ARGV}]
    assert [
        (f["activity"]["tool"], f["activity"]["status"])
        for f in sent
        if isinstance(f, dict) and "activity" in f
    ] == [(PROBE, "start"), (PROBE, "ok")]

    stored = await _stored(pool)
    _no_markup(stored)
    assert "Let me adapt to find instead." in stored
    assert "Three directories under your home." in stored

    # The trace says where the call came from — the accommodation is never
    # invisible.
    spans = await _tool_spans(pool)
    assert [s["name"] for s in spans] == [PROBE]
    assert spans[0]["meta"]["parsed_from_markup"] is True
    assert spans[0]["meta"]["ok"] is True
    assert (await _llm_spans(pool))[0]["meta"]["markup_calls"] == 1


async def test_a_markup_call_still_faces_the_funnel(owner_client, pool, mount_peers):
    """The concern this must not create: markup is a different way of READING a
    call, never a weaker way of authorising one. The observed block names the
    REAL device_run at a machine that was never paired — schema validation, the
    precheck and the policy kernel run exactly as they would for a wire call, so
    it is refused with a stated reason and nothing runs."""
    gateway = ScriptedGateway(rounds=((text(OBSERVED),), (text("It refused."),)))
    mount_peers(gateway=gateway, memory=FakeMemory())

    await _say(owner_client)

    spans = await _tool_spans(pool)
    assert [s["name"] for s in spans] == ["device_run"]
    assert spans[0]["meta"]["parsed_from_markup"] is True
    assert spans[0]["meta"]["ok"] is False
    assert spans[0]["meta"]["error"]  # a STATED refusal, not a silent drop
    _no_markup(await _stored(pool))


async def test_a_wire_call_repeated_as_markup_runs_exactly_once(
    owner_client, pool, mount_peers, monkeypatch
):
    """The duplicate-execution trap: a model that emits the call properly AND
    narrates it in XML must not have it executed twice. Sameness is (name,
    arguments), so one span and one executor call."""
    spy = await _arm_probe(pool, monkeypatch)
    gateway = ScriptedGateway(
        rounds=(
            (
                real_call("c1", PROBE, {"device": DEVICE, "argv": ARGV}),
                text(PROBE_BLOCK),
            ),
            (text("Done."),),
        )
    )
    mount_peers(gateway=gateway, memory=FakeMemory())

    await _say(owner_client)

    assert spy.calls == [{"device": DEVICE, "argv": ARGV}]  # ONCE
    assert len(await _tool_spans(pool)) == 1


# -- (b) a round that advertised NO tools: refused, and said out loud -------


async def test_the_redirects_closing_round_refuses_markup_and_persists_the_note(
    owner_client, pool, mount_peers, monkeypatch
):
    """The observed defect, end to end. Round 1 fabricates a pending approval,
    the consent guard redirects once WITH tools (the probe really runs), and the
    redirect's CLOSING round — no tools by design — answers with nothing but the
    XML block. It is refused and recorded, never dispatched; the durable record
    is the correction plus an honest backend note; and no markup is stored."""
    spy = await _arm_probe(pool, monkeypatch)
    gateway = ScriptedGateway(
        rounds=(
            (text(FABRICATION),),
            (real_call("r1", PROBE, {"device": DEVICE, "argv": ["tree"]}),),
            (text(OBSERVED),),
        )
    )
    mount_peers(gateway=gateway, memory=FakeMemory())

    await _say(owner_client, "try again")

    # The markup call was NOT dispatched: only the redirect's real call ran.
    assert spy.calls == [{"device": DEVICE, "argv": ["tree"]}]
    assert ARGV not in [c.get("argv") for c in spy.calls]

    spans = await _tool_spans(pool)
    refused = [s for s in spans if s["meta"].get("refused_markup")]
    assert [s["name"] for s in refused] == ["device_run"]
    assert refused[0]["meta"]["parsed_from_markup"] is True
    assert refused[0]["meta"]["refused_redirect_closed"] is True
    assert refused[0]["meta"]["ok"] is False
    assert "in a round with no tools" in refused[0]["meta"]["error"]

    stored = await _stored(pool)
    _no_markup(stored)
    assert guards.CONSENT_CLAIM_CORRECTION in stored
    assert markup_calls.no_tool_round_note(["device_run"]) in stored


async def test_a_closed_round_whose_whole_reply_is_markup_answers_with_the_note(
    owner_client, pool, mount_peers, monkeypatch
):
    """The same rule in the turn's own closed round. A card is pending, so the
    narration round advertises no tools; the model answers with markup alone.
    Nothing is dispatched, the reply is never the XML, and the turn still ends
    ok with a note the operator can act on."""
    spy = await _arm_probe(pool, monkeypatch)
    gateway = ScriptedGateway(
        rounds=(
            (real_call("c1", PROBE, {"device": DEVICE, "argv": ["tree"]}),),
            (text(OBSERVED),),
        )
    )
    mount_peers(gateway=gateway, memory=FakeMemory())
    # The probe raises a card this time: the loop closes after round 1.
    await pool.execute(
        "UPDATE action_classes SET disposition = 'consent' WHERE action_class = $1",
        PROBE,
    )

    await _say(owner_client)

    assert spy.calls == []  # the card-raising call did not run, nor did the markup
    refused = [s for s in await _tool_spans(pool) if s["meta"].get("refused_markup")]
    assert [s["name"] for s in refused] == ["device_run"]
    assert refused[0]["meta"]["refused_pending_approval"] is True
    _no_markup(await _stored(pool))
    assert await pool.fetchval("SELECT status FROM turns") == "ok"


async def test_a_malformed_block_is_stripped_and_nothing_is_dispatched(
    owner_client, pool, mount_peers, monkeypatch
):
    """Half a tool call is not a tool call. An unclosed block is stripped, marked
    unparsed on the round's span, dispatched nowhere, and — since it was the
    whole reply — replaced by the honest malformed note rather than an empty
    reply error."""
    spy = await _arm_probe(pool, monkeypatch)
    truncated = f'<atem:function_calls>\n<atem:invoke name="{PROBE}">\n<atem:parameter'
    gateway = ScriptedGateway(rounds=((text(truncated),),))
    mount_peers(gateway=gateway, memory=FakeMemory())

    await _say(owner_client)

    assert spy.calls == []
    assert await _tool_spans(pool) == []
    llm = await _llm_spans(pool)
    assert llm[0]["meta"]["markup_unparsed"] is True
    assert llm[0]["meta"]["tool_calls"] == 0
    stored = await _stored(pool)
    assert stored == markup_calls.MALFORMED_MARKUP_NOTE
    _no_markup(stored)
    assert await pool.fetchval("SELECT status FROM turns") == "ok"


# -- (c) THE INVARIANT, at the persist boundary ------------------------------


async def test_the_persist_boundary_can_never_store_the_observed_reply(pool):
    """Defence in depth, pinned on the exact text the owner was shown. Whatever
    upstream does or forgets, the row that lands in `messages` carries no
    tool-call markup — this is the last line, and it is a line of code."""
    person = await pool.fetchval(
        "INSERT INTO people (name, role) VALUES ('owner', 'owner') RETURNING id"
    )
    conversation = await pool.fetchval(
        "INSERT INTO conversations (person_id) VALUES ($1) RETURNING id", person
    )
    await chat._persist_assistant(pool, conversation, OBSERVED)

    stored = await pool.fetchval("SELECT content FROM messages WHERE role = 'assistant'")
    assert stored != OBSERVED
    _no_markup(stored)
    assert stored == markup_calls.no_tool_round_note(["device_run"])


def test_without_markup_keeps_prose_and_leaves_clean_text_alone():
    assert chat.without_markup("a < b, and I ran nothing.") == "a < b, and I ran nothing."
    cleaned = chat.without_markup(f"Here is the plan.\n\n{OBSERVED}")
    assert cleaned.startswith("Here is the plan.")
    assert markup_calls.no_tool_round_note(["device_run"]) in cleaned
    _no_markup(cleaned)


async def test_a_uuid_conversation_is_not_required_for_the_scan():
    """The scan is pure: it never touches the database, so it cannot fail a
    turn. (Guarded here because _persist_assistant now calls it on every write.)"""
    assert markup_calls.parse_markup_tool_calls(str(uuid.uuid4())).found is False
