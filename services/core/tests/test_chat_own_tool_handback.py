"""The own-tool handback guard wired into the live turn (epic own-tool-handback, T2).

A reply that tells the owner to run one of HER registered tools ("Run
`device_edit_file` ...", "run `machine_update` again") hands him work he can
never do on any machine. guards.own_tool_handback_check (T1) detects it from
the live registry alone; this file drives the REAL chat round loop through a
scripted gateway to pin what the turn then does:

  * a guard span "own_tool_handback" and ONE redirect round that advertises
    tools — even when other tools already ran ok this turn (c9ba8d70:
    start_change ran first), unlike the consent/state/offer redirects;
  * a redirect call identical (name + canonical args) to one that already
    reached an executor this turn is NOT dispatched again: the earlier result
    comes back with a stated "already ran this turn" line (a fact, not a gate);
  * nothing is blocked or refused: a different call runs;
  * a redirect that hands back again ends the turn with the honest note
    APPENDED (no second redirect);
  * a redirect that stands REPLACES the handback in the durable record.
"""

from __future__ import annotations

import json

from app import chat, tools
from app.tools.base import Tool, ToolContext, ToolFailure
from tests.conftest import requires_db
from tests.fakes import FakeMemory, ScriptedGateway

pytestmark = requires_db

DONE = "[DONE]"


def frames(body: str) -> list:
    out = []
    for block in body.strip().split("\n\n"):
        assert block.startswith("data: "), block
        payload = block[len("data: ") :]
        out.append(payload if payload == DONE else json.loads(payload))
    return out


def text(piece: str) -> dict:
    return {"choices": [{"delta": {"content": piece}}]}


def call_delta(index: int, *, call_id, name, arguments) -> dict:
    return {
        "choices": [
            {
                "delta": {
                    "tool_calls": [
                        {
                            "index": index,
                            "id": call_id,
                            "type": "function",
                            "function": {"name": name, "arguments": json.dumps(arguments)},
                        }
                    ]
                }
            }
        ]
    }


class Spy:
    """An executor that records every call that REACHED it. `fail` raises the
    executor's own stated refusal (an `Error:` result, span ok=False)."""

    def __init__(self, result: str, *, fail: str | None = None) -> None:
        self.calls: list = []
        self.result = result
        self.fail = fail

    async def __call__(self, args: dict, ctx: ToolContext) -> str:
        self.calls.append(args)
        if self.fail is not None:
            raise ToolFailure(self.fail)
        return self.result


def _arm(monkeypatch, name: str, props: dict, spy: Spy) -> Spy:
    schema = {"type": "object", "properties": props}
    monkeypatch.setitem(tools.REGISTRY, name, Tool(name, "d", schema, spy))
    return spy


STR = {"type": "string"}
OLD_WT = "/home/jeremy/workspace/nova/.worktrees/nova-3e8ab0/README.md"
NEW_WT = "/home/jeremy/workspace/nova/.worktrees/nova-3ff482/README.md"
EDIT_FAILED = {"device": "mini-pc", "path": OLD_WT, "old": "# Nova", "new": "# Nova edit test 2"}
EDIT_RIGHT = {"device": "mini-pc", "path": NEW_WT, "old": "# Nova\n", "new": "# Nova edit test 2\n"}
MACHINE = {"machine": "mini pc"}

C9_HANDBACK = (
    "I started the change, but the edit was refused: it found 2 matches. "
    "Run `device_edit_file` on the new worktree's README.md to finish it."
)
C9_ANSWER = "The first line of README.md in the new worktree now reads # Nova edit test 2."
AFF_HANDBACK = (
    "The mini PC is already on the hub's build. "
    "If it still looks stale, run `machine_update` again."
)
AFF_ANSWER = "The mini PC is already on the hub's build, so there was nothing to update."
ALREADY = "already ran this turn"


class _PathSpy(Spy):
    """device_edit_file: the old-worktree path is refused ("found 2 matches"),
    any other path is edited."""

    async def __call__(self, args: dict, ctx: ToolContext) -> str:
        self.calls.append(args)
        if args.get("path") == OLD_WT:
            raise ToolFailure("found 2 matches for old; give more context")
        return self.result


def _c9_tools(monkeypatch) -> tuple[Spy, Spy, Spy]:
    """start_change (ok), device_edit_file (refuses the OLD worktree path,
    edits any other) and device_read_file — real-shaped schemas, spy bodies."""
    start = _arm(
        monkeypatch,
        "start_change",
        {"title": STR},
        Spy("Started change nova-3ff482 at /home/jeremy/workspace/nova/.worktrees/nova-3ff482"),
    )
    edit = _arm(
        monkeypatch,
        "device_edit_file",
        {"device": STR, "path": STR, "old": STR, "new": STR},
        _PathSpy("Edited README.md (1 replacement)."),
    )
    read = _arm(
        monkeypatch,
        "device_read_file",
        {"device": STR, "path": STR},
        Spy("# Nova\n\nNova is ..."),
    )
    return start, edit, read


def _c9_round_one() -> tuple:
    """start_change ok, then the edit aimed at the OLD worktree (refused by its
    own executor: _PathSpy fails exactly that path)."""
    return (
        call_delta(0, call_id="s1", name="start_change", arguments={"title": "edit test 2"}),
        call_delta(1, call_id="e1", name="device_edit_file", arguments=EDIT_FAILED),
    )


async def _say(client, message: str) -> list:
    resp = await client.post("/api/v1/chat/stream", json={"message": message})
    assert resp.status_code == 200, resp.text
    return frames(resp.text)


async def _handback_spans(pool) -> list:
    rows = await pool.fetch(
        "SELECT name, meta FROM turn_spans WHERE kind = 'guard' ORDER BY started_at"
    )
    return [
        {
            "name": r["name"],
            "meta": json.loads(r["meta"]) if isinstance(r["meta"], str) else r["meta"],
        }
        for r in rows
        if r["name"] == "own_tool_handback"
    ]


async def _stored_reply(pool) -> str:
    return await pool.fetchval("SELECT content FROM messages WHERE role = 'assistant'")


def _tool_messages(payload: dict) -> list[str]:
    return [m.get("content") or "" for m in payload["messages"] if m.get("role") == "tool"]


def _deltas(sent: list) -> list[str]:
    return [f["t"] for f in sent if isinstance(f, dict) and "t" in f]


def _corrections(sent: list) -> list[str]:
    return [f["correction"] for f in sent if isinstance(f, dict) and "correction" in f]


C9_MESSAGE = (
    'start a change called "edit test 2", then in that worktree change the first line '
    "of README.md to # Nova edit test 2"
)


async def test_c9ba8d70_a_handback_after_tools_ran_redirects_with_tools_and_the_call_runs(
    owner_client, pool, mount_peers, monkeypatch
):
    """C1 + C3: start_change ran OK and the edit failed, then the reply hands him
    `device_edit_file`. The guard fires DESPITE a successful tool already on the
    turn (the after-tools mode — consent/state/offer still refuse), the redirect
    advertises tools, her corrected edit (a DIFFERENT call from the failed one)
    is dispatched — nothing blocks it — and so is a read she adds."""
    start, edit, read = _c9_tools(monkeypatch)
    gateway = ScriptedGateway(
        rounds=(
            _c9_round_one(),
            (text(C9_HANDBACK),),
            (
                call_delta(
                    0,
                    call_id="r1",
                    name="device_read_file",
                    arguments={"device": "mini-pc", "path": NEW_WT},
                ),
                call_delta(1, call_id="r2", name="device_edit_file", arguments=EDIT_RIGHT),
            ),
            (text(C9_ANSWER),),
        )
    )
    mount_peers(gateway=gateway, memory=FakeMemory())

    sent = await _say(owner_client, C9_MESSAGE)

    spans = await _handback_spans(pool)
    assert len(spans) == 1, "a handback of her own tool must draw an own_tool_handback span"
    meta = spans[0]["meta"]
    assert meta["detected"] is True
    assert meta["tool"] == "device_edit_file"
    assert meta["ran_a_tool"] is True
    assert meta.get("not_redirected_because") is None
    assert meta["redirected"] is True

    # call round, handback round, ONE redirect round with tools, closing round.
    assert gateway.calls == 4
    assert gateway.payloads[2].get("tools"), "the redirect round must advertise tools"
    assert start.calls == [{"title": "edit test 2"}]  # never re-run
    assert edit.calls == [EDIT_FAILED, EDIT_RIGHT]  # the different call ran
    assert read.calls == [{"device": "mini-pc", "path": NEW_WT}]
    assert await pool.fetchval("SELECT status FROM turns") == "ok"
    assert sent[-1] == DONE


async def test_c9ba8d70_the_redirect_answer_replaces_the_handback_in_the_record(
    owner_client, pool, mount_peers, monkeypatch
):
    """C4: a redirect that stands REPLACES the handback — the stored reply is her
    real answer, and the handback text (which streamed live first) is not what
    the next turn reads. One live note sits between the two."""
    _c9_tools(monkeypatch)
    gateway = ScriptedGateway(
        rounds=(
            _c9_round_one(),
            (text(C9_HANDBACK),),
            (call_delta(0, call_id="r1", name="device_edit_file", arguments=EDIT_RIGHT),),
            (text(C9_ANSWER),),
        )
    )
    mount_peers(gateway=gateway, memory=FakeMemory())

    sent = await _say(owner_client, C9_MESSAGE)

    stored = await _stored_reply(pool)
    assert stored == C9_ANSWER
    assert "device_edit_file" not in stored
    deltas = _deltas(sent)
    assert deltas[0] == C9_HANDBACK
    assert deltas[-1] == C9_ANSWER
    assert len(_corrections(sent)) == 1


async def test_aff5605d_an_identical_call_in_the_redirect_is_replayed_not_re_sent(
    owner_client, pool, mount_peers, monkeypatch
):
    """C2: machine_update ran OK ("already on the hub's build"), the reply says
    "run `machine_update` again", and the redirect asks for the SAME call (same
    name, same args). It is not dispatched a second time — the executor ran
    exactly once — and the model is handed the earlier result with a stated
    "already ran this turn" line, a fact like an Error: cannot-run, never a
    refusal on his behalf."""
    earlier = "mini pc is already on the hub's build (3f2a9c1); nothing to update."
    update = _arm(monkeypatch, "machine_update", {"machine": STR}, Spy(earlier))
    gateway = ScriptedGateway(
        rounds=(
            (call_delta(0, call_id="m1", name="machine_update", arguments=MACHINE),),
            (text(AFF_HANDBACK),),
            (call_delta(0, call_id="m2", name="machine_update", arguments=MACHINE),),
            (text(AFF_ANSWER),),
        )
    )
    mount_peers(gateway=gateway, memory=FakeMemory())

    await _say(owner_client, "update the mini pc")

    spans = await _handback_spans(pool)
    assert len(spans) == 1
    assert spans[0]["meta"]["tool"] == "machine_update"
    assert gateway.calls == 4
    assert update.calls == [MACHINE], "an identical call must never be dispatched twice"

    # The closing round was told the earlier result, stated as already-ran.
    replayed = [m for m in _tool_messages(gateway.payloads[3]) if ALREADY in m]
    assert len(replayed) == 1
    assert earlier in replayed[0]
    assert not replayed[0].startswith("Error:"), "a replay is a fact, not a refusal"
    assert await _stored_reply(pool) == AFF_ANSWER


async def test_args_key_order_does_not_make_an_identical_call_new(
    owner_client, pool, mount_peers, monkeypatch
):
    """C2, canonical args: the same arguments in another key order are the same
    call — compared as canonical JSON, never as the raw string the model wrote."""
    edit = _arm(
        monkeypatch,
        "device_edit_file",
        {"device": STR, "path": STR, "old": STR, "new": STR},
        Spy("Edited README.md (1 replacement)."),
    )
    reordered = dict(reversed(list(EDIT_RIGHT.items())))
    gateway = ScriptedGateway(
        rounds=(
            (call_delta(0, call_id="e1", name="device_edit_file", arguments=EDIT_RIGHT),),
            (text("Edited. Run `device_edit_file` again if the line needs another change."),),
            (call_delta(0, call_id="e2", name="device_edit_file", arguments=reordered),),
            (text(C9_ANSWER),),
        )
    )
    mount_peers(gateway=gateway, memory=FakeMemory())

    await _say(owner_client, "change the first line of README.md")

    assert len(await _handback_spans(pool)) == 1
    assert gateway.calls == 4
    assert edit.calls == [EDIT_RIGHT]
    assert any(ALREADY in m for m in _tool_messages(gateway.payloads[3]))


async def test_a_handback_with_nothing_run_yet_redirects_and_the_tool_runs(
    owner_client, pool, mount_peers, monkeypatch
):
    """C1/C3 baseline (1dfb9652's shape): no tool ran, the reply says "Run
    `device_info` on the Beelink to verify"; the redirect runs it herself."""
    info = _arm(monkeypatch, "device_info", {"device": STR}, Spy("Beelink: build 3f2a9c1, up 2h"))
    answer = "The Beelink is on build 3f2a9c1 and has been up for 2 hours."
    gateway = ScriptedGateway(
        rounds=(
            (text("Run `device_info` on the Beelink to verify the build."),),
            (call_delta(0, call_id="i1", name="device_info", arguments={"device": "beelink"}),),
            (text(answer),),
        )
    )
    mount_peers(gateway=gateway, memory=FakeMemory())

    await _say(owner_client, "is the beelink on the latest build?")

    spans = await _handback_spans(pool)
    assert len(spans) == 1
    assert spans[0]["meta"]["redirected"] is True
    assert gateway.calls == 3
    assert info.calls == [{"device": "beelink"}]
    assert await _stored_reply(pool) == answer


async def test_a_redirect_that_hands_back_again_appends_the_note_and_ends(
    owner_client, pool, mount_peers, monkeypatch
):
    """C4, bounded: the redirect comes back as ANOTHER handback. The regen is
    refused by this guard by name (it is in _regen_rejected_by), no second
    redirect runs, and the honest note naming the tool is APPENDED to the
    original reply — the prose around the handback may be honest."""
    _c9_tools(monkeypatch)
    again = "You should run `device_edit_file` yourself on the new worktree's README.md."
    gateway = ScriptedGateway(rounds=(_c9_round_one(), (text(C9_HANDBACK),), (text(again),)))
    mount_peers(gateway=gateway, memory=FakeMemory())

    sent = await _say(owner_client, C9_MESSAGE)

    assert gateway.calls == 3  # call round, handback, ONE redirect — never a fourth
    spans = await _handback_spans(pool)
    assert len(spans) == 1
    meta = spans[0]["meta"]
    assert meta["redirected"] is False
    assert meta["regen_rejected_by"] == "own_tool_handback"

    note_for = getattr(chat, "own_tool_handback_note", None)
    assert note_for is not None, "chat.own_tool_handback_note(tool) states the honest note"
    note = note_for("device_edit_file")
    assert "device_edit_file" in note
    assert await _stored_reply(pool) == f"{C9_HANDBACK}\n\n{note}"
    assert _corrections(sent) == [note]
    assert again not in await _stored_reply(pool)
    assert await pool.fetchval("SELECT status FROM turns") == "ok"


async def test_an_honest_report_is_left_alone_and_its_handback_twin_is_not(
    owner_client, pool, mount_peers, monkeypatch
):
    """Precision at the wiring level, PAIRED so the test bites: turn 1 only
    REPORTS what machine_update said — no span, no redirect round, the reply
    persists as written. Turn 2 hands him `nova_about` — exactly one span,
    and its redirect runs the tool herself."""
    earlier = "mini pc is already on the hub's build (3f2a9c1); nothing to update."
    update = _arm(monkeypatch, "machine_update", {"machine": STR}, Spy(earlier))
    about = _arm(monkeypatch, "nova_about", {}, Spy("hub build 3f2a9c1"))
    honest = "The mini PC is already on the hub's build, so `machine_update` had nothing to do."
    handback = "Run `nova_about` to compare the hub's build with the mini PC's."
    answer = "The hub and the mini PC are both on build 3f2a9c1."
    gateway = ScriptedGateway(
        rounds=(
            (call_delta(0, call_id="m1", name="machine_update", arguments=MACHINE),),
            (text(honest),),
            (text(handback),),
            (call_delta(0, call_id="n1", name="nova_about", arguments={}),),
            (text(answer),),
        )
    )
    mount_peers(gateway=gateway, memory=FakeMemory())

    await _say(owner_client, "update the mini pc")
    assert await _handback_spans(pool) == []
    assert gateway.calls == 2
    assert update.calls == [MACHINE]
    assert await _stored_reply(pool) == honest

    await _say(owner_client, "is the hub on the same build?")
    assert len(await _handback_spans(pool)) == 1
    assert gateway.calls == 5
    assert about.calls == [{}]
    replies = await pool.fetch(
        "SELECT content FROM messages WHERE role = 'assistant' ORDER BY created_at"
    )
    assert [r["content"] for r in replies] == [honest, answer]


async def test_the_redirect_runs_a_tool_the_handback_did_not_name(
    owner_client, pool, mount_peers, monkeypatch
):
    """C3: the guard never refuses a tool. A redirect whose only call is to a
    tool the handback did NOT name still runs it (she picks her own action; the
    nudge names no target)."""
    _arm(monkeypatch, "machine_update", {"machine": STR}, Spy("already on the hub's build"))
    about = _arm(monkeypatch, "nova_about", {}, Spy("hub build 3f2a9c1"))
    gateway = ScriptedGateway(
        rounds=(
            (call_delta(0, call_id="m1", name="machine_update", arguments=MACHINE),),
            (text(AFF_HANDBACK),),
            (call_delta(0, call_id="n1", name="nova_about", arguments={}),),
            (text("The mini PC and the hub are both on build 3f2a9c1."),),
        )
    )
    mount_peers(gateway=gateway, memory=FakeMemory())

    await _say(owner_client, "update the mini pc")

    assert len(await _handback_spans(pool)) == 1
    assert gateway.calls == 4
    assert about.calls == [{}]


# -- coverage (T2 COVERAGE) ----------------------------------------------------


async def test_the_nudge_lists_every_call_with_its_outcome_and_names_no_target(
    owner_client, pool, mount_peers, monkeypatch
):
    """The redirect's system nudge is DERIVED from the spans: each call this
    turn with its outcome (start_change ok, the edit failed), and it names no
    device or path the guard inferred — she picks those herself."""
    _c9_tools(monkeypatch)
    gateway = ScriptedGateway(
        rounds=(
            _c9_round_one(),
            (text(C9_HANDBACK),),
            (call_delta(0, call_id="r1", name="device_edit_file", arguments=EDIT_RIGHT),),
            (text(C9_ANSWER),),
        )
    )
    mount_peers(gateway=gateway, memory=FakeMemory())

    await _say(owner_client, C9_MESSAGE)

    nudge = gateway.payloads[2]["messages"][-1]
    assert nudge["role"] == "system"
    body = nudge["content"]
    assert "- start_change: ok" in body
    assert "- device_edit_file: failed" in body
    assert "`device_edit_file`" in body
    assert "mini-pc" not in body and "nova-3ff482" not in body


async def test_an_identical_call_whose_executor_ran_and_failed_is_replayed(
    owner_client, pool, mount_peers, monkeypatch
):
    """C2 / A2: "reached an executor" includes one that ran and FAILED — the
    double run the shelved guard caused was a half-run command sent again.
    The failed edit, asked for again verbatim, is not re-sent."""
    _start, edit, _read = _c9_tools(monkeypatch)
    gateway = ScriptedGateway(
        rounds=(
            _c9_round_one(),
            (text(C9_HANDBACK),),
            (call_delta(0, call_id="r1", name="device_edit_file", arguments=EDIT_FAILED),),
            (text("The edit was refused: the old text matched twice."),),
        )
    )
    mount_peers(gateway=gateway, memory=FakeMemory())

    await _say(owner_client, C9_MESSAGE)

    assert edit.calls == [EDIT_FAILED]
    replayed = [m for m in _tool_messages(gateway.payloads[3]) if ALREADY in m]
    assert len(replayed) == 1
    assert "found 2 matches" in replayed[0]


async def test_an_identical_call_refused_before_its_executor_is_sent_again(
    owner_client, pool, mount_peers, monkeypatch
):
    """C2 / A2, the other side: a call dispatch refused BEFORE any executor
    (arguments off the schema) never ran, so the same call in the redirect is
    dispatched normally — no "already ran" line about a call that did not."""
    update = _arm(monkeypatch, "machine_update", {"machine": STR}, Spy("updated"))
    bad = {"machine": 5}
    gateway = ScriptedGateway(
        rounds=(
            (call_delta(0, call_id="m1", name="machine_update", arguments=bad),),
            (text(AFF_HANDBACK),),
            (call_delta(0, call_id="m2", name="machine_update", arguments=bad),),
            (text("machine_update refused the machine argument."),),
        )
    )
    mount_peers(gateway=gateway, memory=FakeMemory())

    await _say(owner_client, "update the mini pc")

    assert len(await _handback_spans(pool)) == 1
    assert update.calls == []
    results = _tool_messages(gateway.payloads[3])
    assert results and not any(ALREADY in m for m in results)
    assert results[-1].startswith("Error:")


async def test_a_handback_with_no_redirect_left_appends_the_note_and_files_why(
    owner_client, pool, mount_peers, monkeypatch
):
    """Not redirected -> APPEND: the circling stop ended the turn (out of
    rounds), its narration round hands him `machine_update`; no redirect round
    runs, the span says why, and the note naming the tool is appended."""
    update = _arm(monkeypatch, "machine_update", {"machine": STR}, Spy("already on the build"))
    same = (call_delta(0, call_id="m", name="machine_update", arguments=MACHINE),)
    gateway = ScriptedGateway(rounds=(same, same, same, (text(AFF_HANDBACK),)))
    mount_peers(gateway=gateway, memory=FakeMemory())

    sent = await _say(owner_client, "update the mini pc")

    assert gateway.calls == 4  # three call rounds, the narration round, no redirect
    assert len(update.calls) == 3
    spans = await _handback_spans(pool)
    assert len(spans) == 1
    assert spans[0]["meta"]["redirected"] is False
    assert spans[0]["meta"]["not_redirected_because"] == "out_of_rounds"
    note = chat.own_tool_handback_note("machine_update")
    stored = await _stored_reply(pool)
    assert stored.startswith(AFF_HANDBACK)
    assert stored.endswith(note)
    assert note in _corrections(sent)


async def test_a_handback_after_the_budget_is_spent_appends_the_note_and_files_why(
    owner_client, pool, mount_peers, monkeypatch
):
    """ONE redirect per turn, shared: the offer shape of the deferral guard
    claimed the budget first (it is noted, not redirected — another tool ran),
    so the handback in the same reply draws no second regeneration — its span
    says redirect_spent and its own note is appended after the offer's."""
    aux = _arm(monkeypatch, "aux_lookup", {"query": STR}, Spy("a note from March"))
    _arm(monkeypatch, "web_search", {"query": STR}, Spy("Pixel 10"))
    reply = (
        "I found a note from March. Want me to check the web for newer info? "
        "Run `aux_lookup` again for older notes."
    )
    gateway = ScriptedGateway(
        rounds=(
            (call_delta(0, call_id="a1", name="aux_lookup", arguments={"query": "pixel"}),),
            (text(reply),),
        )
    )
    mount_peers(gateway=gateway, memory=FakeMemory())

    sent = await _say(owner_client, "check the web for the latest pixel phone")

    assert gateway.calls == 2  # no redirect round for either guard
    assert aux.calls == [{"query": "pixel"}]
    spans = await _handback_spans(pool)
    assert len(spans) == 1
    assert spans[0]["meta"]["redirected"] is False
    assert spans[0]["meta"]["not_redirected_because"] == "redirect_spent"
    note = chat.own_tool_handback_note("aux_lookup")
    stored = await _stored_reply(pool)
    assert stored.startswith(reply)
    assert stored.endswith(f"\n\n{note}")
    assert _corrections(sent)[-1] == note
