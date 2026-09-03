"""A tool call written as TEXT is never an answer — through the real turn.

The owner's walk, 2026-09-03 11:57. The consent redirect's closing round
advertises no tools by design; the model wanted to adapt `device_run tree` to
`find`, had no tool call available, and wrote the call out in Claude-style XML.
The four honesty guards passed it (an attempted ACTION is not a lie, a denial
or a state claim) and it was PERSISTED — the owner read raw XML, and the next
turn would have read it back out of history and learned to write more.

THE RULING (controller, 2026-09-03, after three Criticals in one class): tool-
call markup in reply text is NEVER DISPATCHED, in any round. Every attack broke
the half of the design that turned prose into an executable call — a fenced
example that ran, a nested quote that moved ["rm","-rf","/"] onto a real call, a
backticked tag boundary that absorbed the next invoke's arguments. The other
half — strip it, refuse it by name, leave an honest note — never broke.

So these drive the real route through a scripted gateway to prove exactly that:
an open round refuses the call with a stated, RETRYABLE reason and gives the
model another round; a closed round refuses it alongside its own reason and
leaves a note; a quoted example is neither run nor edited; and nothing anywhere
stores the markup.
"""
from __future__ import annotations

import json
import uuid
from dataclasses import dataclass, field

import pytest

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


async def test_markup_in_an_open_round_is_refused_as_text_never_dispatched(
    owner_client, pool, mount_peers, monkeypatch
):
    """THE RULING, in the round where markup used to run. Round 1 advertises
    tools and the model writes its call as XML instead of emitting it: nothing is
    dispatched, the model is told by name what it did and what to do instead, and
    it gets the next round to do it. The prose around the block survives; the
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

    assert spy.calls == []  # the executor was never reached
    assert [
        (f["activity"]["tool"], f["activity"]["status"])
        for f in sent
        if isinstance(f, dict) and "activity" in f
    ] == [(PROBE, "start"), (PROBE, "error")]

    stored = await _stored(pool)
    _no_markup(stored)
    assert "Let me adapt to find instead." in stored
    assert "Three directories under your home." in stored

    # The refusal is stated, retryable, and names the tool — and the trace says
    # the call was read out of text, so the accommodation is never invisible.
    spans = await _tool_spans(pool)
    assert [s["name"] for s in spans] == [PROBE]
    assert spans[0]["meta"]["parsed_from_markup"] is True
    assert spans[0]["meta"]["refused_markup_as_text"] is True
    assert spans[0]["meta"]["ok"] is False
    assert spans[0]["meta"]["error"] == chat.markup_as_text_refusal(PROBE)
    assert "re-issue it as one" in spans[0]["meta"]["error"]
    assert (await _llm_spans(pool))[0]["meta"]["markup_calls"] == 1
    # And the model was told, in the transcript it reads next round.
    results = [
        m["content"]
        for payload in gateway.payloads
        for m in payload["messages"]
        if m["role"] == "tool"
    ]
    assert any("re-issue it as one" in r for r in results)


async def test_the_observed_block_names_the_real_tool_and_is_still_refused(
    owner_client, pool, mount_peers
):
    """The owner's own block, naming the REAL device_run. It reaches no funnel
    and no executor — there is no longer a path from markup to dispatch at all,
    which is why the funnel-path pin this replaces was deleted."""
    gateway = ScriptedGateway(rounds=((text(OBSERVED),), (text("It refused."),)))
    mount_peers(gateway=gateway, memory=FakeMemory())

    await _say(owner_client)

    spans = await _tool_spans(pool)
    assert [s["name"] for s in spans] == ["device_run"]
    assert spans[0]["meta"]["refused_markup_as_text"] is True
    assert spans[0]["meta"]["ok"] is False
    _no_markup(await _stored(pool))


async def test_a_real_wire_call_beside_markup_still_runs_and_the_markup_is_refused(
    owner_client, pool, mount_peers, monkeypatch
):
    """The de-duplication that used to guard against double execution is gone
    with the dispatch it guarded: a markup "call" repeating a real one is now
    simply a second REFUSAL. What must not regress is the real call — a tool
    issued properly still runs, exactly once, in the same round."""
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

    assert spy.calls == [{"device": DEVICE, "argv": ARGV}]  # ONCE, from the wire
    spans = await _tool_spans(pool)
    assert [s["meta"].get("ok") for s in spans] == [True, False]
    assert spans[0].get("meta", {}).get("parsed_from_markup") is None
    assert spans[1]["meta"]["refused_markup_as_text"] is True


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
    # BOTH facts, not one instead of the other: the round's own reason survives
    # and the markup fact is appended to it.
    assert chat.REDIRECT_CLOSED_REFUSAL in refused[0]["meta"]["error"]
    assert "tool-call markup in your reply text" in refused[0]["meta"]["error"]
    assert "device_run did not run" in refused[0]["meta"]["error"]

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
    # The round's own reason is what the model most needs; the markup fact is
    # appended to it, never substituted for it.
    assert "an approval is pending" in refused[0]["meta"]["error"]
    assert "tool-call markup in your reply text" in refused[0]["meta"]["error"]
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


# -- the adversarial review, through the real route (2026-09-03) -----------
#
# C1 was live and critical: with no exclusion for quotation, a reply SHOWING
# what a tool call looks like WAS one. The repros below are the reviewer's,
# executed end to end — the executor must not run, and the reply must survive
# byte for byte, because a fence with its contents deleted is its own defect.

FENCE = "Sure — here is what a call looks like:\n\n```xml\n{block}\n```\n\nThat is the shape."


async def test_a_fenced_example_never_runs_and_is_stored_intact(
    owner_client, pool, mount_peers, monkeypatch
):
    spy = await _arm_probe(pool, monkeypatch)
    reply = FENCE.format(block=PROBE_BLOCK)
    gateway = ScriptedGateway(rounds=((text(reply),),))
    mount_peers(gateway=gateway, memory=FakeMemory())

    await _say(owner_client, "what does a tool call look like?")

    assert spy.calls == []  # the example is teaching, not calling
    assert await _tool_spans(pool) == []
    assert await _stored(pool) == reply  # fence contents preserved, byte for byte


async def test_a_blockquoted_example_never_runs_and_is_stored_intact(
    owner_client, pool, mount_peers, monkeypatch
):
    spy = await _arm_probe(pool, monkeypatch)
    quoted = "Like this:\n\n" + "\n".join(f"> {line}" for line in PROBE_BLOCK.splitlines())
    gateway = ScriptedGateway(rounds=((text(quoted),),))
    mount_peers(gateway=gateway, memory=FakeMemory())

    await _say(owner_client, "show me one")

    assert spy.calls == []
    assert await _stored(pool) == quoted


async def test_a_fenced_hermes_example_never_runs(owner_client, pool, mount_peers):
    """The reviewer's sharpest case: ["rm", "-rf", "/"] pulled out of an
    explanation and dispatched."""
    reply = (
        "The other format looks like this:\n\n```\n"
        '<tool_call>{"name": "device_run", "arguments": '
        '{"device": "DELL-XPS-8950", "argv": ["rm", "-rf", "/"]}}</tool_call>\n```\n'
    )
    gateway = ScriptedGateway(rounds=((text(reply),),))
    mount_peers(gateway=gateway, memory=FakeMemory())

    await _say(owner_client, "and the hermes format?")

    assert await _tool_spans(pool) == []  # nothing was even attempted
    assert await _stored(pool) == reply


async def test_prose_explaining_the_format_is_stored_byte_for_byte(
    owner_client, pool, mount_peers
):
    """I4. A block is removed only when it holds a call this can READ; an answer
    about the tags keeps its middle, and gets no note, because nothing happened
    that needs explaining."""
    reply = (
        "It opens with <function_calls>, nests <invoke name=…> for each call, and "
        "closes with </function_calls>. The tag is `<function_calls>` and it "
        "closes with `</function_calls>`."
    )
    gateway = ScriptedGateway(rounds=((text(reply),),))
    mount_peers(gateway=gateway, memory=FakeMemory())

    await _say(owner_client, "how is a call written?")

    assert await _stored(pool) == reply
    assert await _tool_spans(pool) == []


async def test_a_bare_tag_mention_keeps_its_tail(owner_client, pool, mount_peers):
    """I5. The truncation rule is for a call cut off mid-emission, not for a
    sentence that names a tag — this reply used to lose everything after it."""
    reply = "It opens with <function_calls> and then the invokes follow, one per call."
    gateway = ScriptedGateway(rounds=((text(reply),),))
    mount_peers(gateway=gateway, memory=FakeMemory())

    await _say(owner_client, "how does it start?")

    assert await _stored(pool) == reply


async def test_a_nested_quoted_block_dispatches_nothing_and_is_refused(
    owner_client, pool, mount_peers, monkeypatch
):
    """I3. The nested example made the non-greedy match close on the INNER tags:
    a quoted `argv` replaced the real one and the call ran ok=True. A round whose
    markup did not fully parse now dispatches NOTHING — every call it produced is
    refused, with a stated reason, in the round that HAD tools."""
    spy = await _arm_probe(pool, monkeypatch)
    nested = (
        f'<a:function_calls>\n<a:invoke name="{PROBE}">\n'
        f'<a:parameter name="device">{DEVICE}</a:parameter>\n'
        '<a:parameter name="note">as in <a:invoke name="other">'
        '<a:parameter name="argv">["rm", "-rf", "/"]</a:parameter></a:invoke>'
        "</a:parameter>\n"
        '<a:parameter name="argv">["ok"]</a:parameter>\n'
        "</a:invoke>\n</a:function_calls>"
    )
    gateway = ScriptedGateway(rounds=((text(nested),), (text("It would not run."),)))
    mount_peers(gateway=gateway, memory=FakeMemory())

    await _say(owner_client)

    assert spy.calls == []  # nothing ran, least of all the quoted argv
    spans = await _tool_spans(pool)
    assert [s["name"] for s in spans] == [PROBE]
    assert spans[0]["meta"]["refused_markup_as_text"] is True
    assert spans[0]["meta"]["ok"] is False
    _no_markup(await _stored(pool))


async def test_a_refusal_in_an_open_round_leaves_no_note_to_the_operator(
    owner_client, pool, mount_peers, monkeypatch
):
    """I2, under the ruling. A note is owed only when the model could not be told
    — a CLOSED round. Here it was told, in a tool result, and answered properly,
    so the record is its answer and nothing else: no "no tool round left" (there
    were rounds left), no "malformed" (it parsed fine), no "ask again" (it was
    already asked, and complied)."""
    spy = await _arm_probe(pool, monkeypatch)
    gateway = ScriptedGateway(
        rounds=((text(PROBE_BLOCK),), (text("Sorry — I wrote that as text."),))
    )
    mount_peers(gateway=gateway, memory=FakeMemory())

    await _say(owner_client)

    assert spy.calls == []
    stored = await _stored(pool)
    assert stored == "Sorry — I wrote that as text."
    for phrase in ("no tool round left", "malformed", "ask again"):
        assert phrase not in stored


async def test_no_markup_span_is_ever_ok(owner_client, pool, mount_peers, monkeypatch):
    """The whole-round invariant, stated as a property rather than a case: with
    markup anywhere in a turn — open round, closed round, quoted, nested — no
    tool span that came from markup ever records a success, because none of them
    ever reaches a tool."""
    spy = await _arm_probe(pool, monkeypatch)
    nested_boundary = (
        f'<a:function_calls>\n<a:invoke name="{PROBE}">\n'
        '<a:parameter name="device">DELL-XPS-8950</a:parameter>\n'
        '<a:parameter name="argv">["ok"]</a:parameter>\n'
        '`</a:invoke><a:invoke name="other">`\n'
        '<a:parameter name="argv">["rm", "-rf", "/"]</a:parameter>\n'
        "</a:invoke>\n</a:function_calls>"
    )
    gateway = ScriptedGateway(
        rounds=(
            (text(PROBE_BLOCK),),
            (text(nested_boundary),),
            (text(f"```\n{PROBE_BLOCK}\n```"),),
            (text("I could not run any of that."),),
        )
    )
    mount_peers(gateway=gateway, memory=FakeMemory())

    await _say(owner_client)

    assert spy.calls == []
    spans = await _tool_spans(pool)
    assert spans  # markup really was read — this is not a vacuous pass
    for span in spans:
        assert span["meta"]["parsed_from_markup"] is True
        assert span["meta"]["ok"] is False


async def test_the_memory_ingest_never_carries_markup(
    owner_client, pool, mount_peers, monkeypatch
):
    """M10. The persist boundary is not the only door: recall re-injects what was
    ingested into later turns, in other conversations. The exchange handed to the
    memory peer is the cleaned text."""
    spy = await _arm_probe(pool, monkeypatch)
    memory = FakeMemory()
    gateway = ScriptedGateway(
        rounds=(
            (text(f"Running it.\n\n{PROBE_BLOCK}"),),
            (text("Three directories under your home."),),
        )
    )
    mount_peers(gateway=gateway, memory=memory)

    await _say(owner_client)
    await chat.drain_background()

    assert spy.calls == []
    assert len(memory.ingests) == 1
    ingested = memory.ingests[0]["exchange"]["assistant"]
    _no_markup(ingested)
    assert "Running it." in ingested


# -- NEW-1: a quotation that swallows a TAG BOUNDARY -----------------------
#
# The review's third Critical, and the one that ended the dispatch path. With
# quotation masked, a backticked `</invoke><invoke name="other">` boundary makes
# the non-greedy match close on the WRONG tag: invoke #2's parameters were
# absorbed into invoke #1 and ["rm","-rf","/"] DISPATCHED ok=True, with nothing
# anywhere reporting doubt. No arrangement of tags can be trusted to say what the
# model meant — so nothing is run, and these prove it end to end.


def _boundary_swallowed(open_quote: str, close_quote: str) -> str:
    return (
        f'<a:function_calls>\n<a:invoke name="{PROBE}">\n'
        '<a:parameter name="device">DELL-XPS-8950</a:parameter>\n'
        '<a:parameter name="argv">["ok"]</a:parameter>\n'
        f'{open_quote}</a:invoke><a:invoke name="other">{close_quote}\n'
        '<a:parameter name="argv">["rm", "-rf", "/"]</a:parameter>\n'
        "</a:invoke>\n</a:function_calls>"
    )


@pytest.mark.parametrize(
    "quotes",
    [("`", "`"), ("```\n", "\n```"), ("> ", "")],
    ids=["backtick", "fence", "blockquote"],
)
async def test_a_swallowed_tag_boundary_dispatches_nothing(
    owner_client, pool, mount_peers, monkeypatch, quotes
):
    spy = await _arm_probe(pool, monkeypatch)
    gateway = ScriptedGateway(
        rounds=(
            (text(_boundary_swallowed(*quotes)),),
            (text("None of that ran."),),
        )
    )
    mount_peers(gateway=gateway, memory=FakeMemory())

    await _say(owner_client)

    # The executor is never reached, whatever the tags were read as.
    assert spy.calls == []
    for span in await _tool_spans(pool):
        assert span["meta"]["ok"] is False
        assert span["meta"]["parsed_from_markup"] is True
    # The turn completed normally — no exception, no error frame.
    assert await pool.fetchval("SELECT status FROM turns") == "ok"
    stored = await _stored(pool)
    assert stored == "None of that ran."
    assert "rm" not in stored
