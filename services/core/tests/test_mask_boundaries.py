"""mask-bearer T2: the one credential mask at every place core saves turn text.

Found in the S37c live walk (turn 3b7781fa): he pasted an event-sender key and
asked for `curl ... -H "Authorization: Bearer <key>"` through device_run; the
key was then stored in plain text in span meta, the kept tool result, her
reply, and memory's journal. This walks ONE real turn end to end — queued,
drained, a device_run + device_job_start + memory_save, a device that echoes
the header, a reply that repeats it — and reads every place it can land.

Every boundary is `credential_mask.mask` / `mask_tree`, one call each:
  turn_spans.meta + tool_results (traces.close_turn), the assistant row
  (chat._persist_assistant), the user row (chat._open_turn), the delegate brief
  (agents.delegate), the memory ingest payload (chat._ingest), the memory door
  (memory_tools._call_memory), device_jobs argv (insert) / reason (_text,
  _parse), queued_messages.body at claim (queued.mark_claimed).

What it MUST NOT touch stays byte-identical: turn_actions.undo (a revert
restores exact bytes), device_audit.summary (device-signed chain),
events.payload (sender input), a queued body not yet claimed (the input of a
turn still to run), event_senders' stored token. And the running turn still
sees the real key — the mask is at persist only.
"""

from __future__ import annotations

import asyncio
import dataclasses
import gc
import json
import uuid

from app import agents, chat, device_jobs, events, queued, tools, traces
from app.main import app
from tests.conftest import requires_db
from tests.fakes import FakeMemory, ScriptedGateway
from tests.test_chat_agents import _calls, _create, _owner
from tests.test_chat_tools import text
from tests.test_devices_ws import _clean_hub  # noqa: F401
from tests.test_outside_worktree_flag import _connect_host
from tests.test_tools_agents import _ctx as _agent_ctx
from tests.test_tools_agents import root  # noqa: F401

pytestmark = requires_db

KEY = "Zk3x9QpL7vR2mN8wT4yB6cD1fG5hJ0sAeU"  # the pasted event-sender key
COOKIE = "sid0f9e8d7c6b5a4c3d2"  # a credential only the device's output carries
URL = "https://events.example/api/v1/events"
HEADER = f"Authorization: Bearer {KEY}"
LAPTOP = "laptop"
SECRETS = (KEY, COOKIE)


def _fragments() -> list[str]:
    """The secrets and enough of each that a partial leak is caught too."""
    out: list[str] = []
    for secret in SECRETS:
        out += [secret, secret[:12], secret[-12:]]
    return out


def _leaks(where: str, stored: object) -> list[str]:
    dumped = stored if isinstance(stored, str) else json.dumps(stored, default=str)
    return [f"{where} holds {f!r}" for f in _fragments() if f in dumped]


def _assert_clean(where: str, stored: object) -> None:
    leaks = _leaks(where, stored)
    assert not leaks, f"{leaks}: {str(stored)[:600]}"


def _masked_header() -> str:
    return f"Authorization: Bearer <masked:{len(KEY)} chars>"


def _device_answer(device):
    """The laptop: shell.exec echoes the request header and the server's
    cookie; job.start refuses, quoting the command it was given."""

    def answer(envelope: dict) -> dict:
        if envelope["capability"] == "job.start":
            argv = " ".join(envelope["args"]["argv"])
            return {"ok": False, "error": f"could not start: {argv}"}
        return {
            "ok": True,
            # The header as sent, the server's cookie, and the key echoed
            # BARE in the body (only the argv mask's sink can scrub that).
            "output": (
                f"> {HEADER}\n< HTTP/1.1 200 OK\n< Set-Cookie: session={COOKIE}\n"
                f'{{"received": "{KEY}"}}\n'
            ),
            "exit_code": 0,
        }

    return answer


async def _serve(device, conn, answer, audit: list[str]):
    """Answer every command frame; file one audit entry per command whose
    summary quotes the argv (what a real agent's audit line does)."""
    while True:
        frame = await conn.next_sent()
        if not isinstance(frame, dict) or frame.get("type") != "command":
            continue
        envelope = frame["envelope"]
        fields = dict(answer(envelope))
        conn.feed(device.result(envelope, **fields))
        summary = " ".join(envelope["args"].get("argv") or [])
        audit.append(summary)
        conn.feed(
            {
                "type": "audit",
                "entries": [
                    device._audit_entry(
                        envelope,
                        ok=bool(fields.get("ok")),
                        exit_code=fields.get("exit_code"),
                        summary=summary,
                    )
                ],
            }
        )


async def _room(pool, owner) -> uuid.UUID:
    """A room hung off a hallway row written before this fix (its content
    carries the header raw), so the ingest's thread title would carry it."""
    hallway = await pool.fetchval(
        "INSERT INTO conversations (person_id) VALUES ($1) RETURNING id", owner.id
    )
    parent = await pool.fetchval(
        "INSERT INTO messages (conversation_id, role, content) VALUES ($1, 'user', $2) "
        "RETURNING id",
        hallway,
        f"{HEADER} is the events key",
    )
    return await pool.fetchval(
        "INSERT INTO conversations (person_id, parent_message_id) VALUES ($1, $2) RETURNING id",
        owner.id,
        parent,
    )


async def test_one_turn_with_a_bearer_leaves_no_key_byte_in_any_boundary(pool, mount_peers):
    owner = await _owner(pool)
    device, conn, _task = await _connect_host(pool, name=LAPTOP, hostname="laptop-host")
    audit: list[str] = []
    server = asyncio.create_task(_serve(device, conn, _device_answer(device), audit))

    message = f'please run curl -s -i -H "{HEADER}" {URL} on the laptop'
    room = await _room(pool, owner)
    queued_id = await queued.enqueue_for_test(pool, room, owner.id, message)
    # A message nobody has claimed yet: someone else's, still waiting.
    other = await pool.fetchval(
        "INSERT INTO people (name, role) VALUES ('guest', 'adult') RETURNING id"
    )
    other_conversation = await pool.fetchval(
        "INSERT INTO conversations (person_id) VALUES ($1) RETURNING id", other
    )
    waiting_id = await queued.enqueue_for_test(pool, other_conversation, other, message)

    gateway = ScriptedGateway(
        rounds=(
            (
                _calls(
                    (
                        "c1",
                        "device_run",
                        {"device": LAPTOP, "argv": ["curl", "-s", "-i", "-H", HEADER, URL]},
                    ),
                    (
                        "c2",
                        "device_job_start",
                        {"device": LAPTOP, "argv": ["sh", "-c", f'curl -H "{HEADER}" {URL}']},
                    ),
                    (
                        "c3",
                        "memory_save",
                        {"title": "events api", "content": f"Send -H '{HEADER}' to {URL}."},
                    ),
                ),
            ),
            (text(f'The events API answered 200 to -H "{HEADER}".'),),
        )
    )
    memory = FakeMemory()
    mount_peers(gateway=gateway, memory=memory)
    try:
        before = set(chat._BACKGROUND)
        await chat.drain_queue(app, pool, room)
        await asyncio.wait_for(chat.drain_background(), timeout=20)
        await chat.settle_detached(before)
        await asyncio.wait_for(memory.ingested.wait(), timeout=5)
        for _ in range(100):
            if await pool.fetchval("SELECT count(*) FROM device_audit") >= 2:
                break
            await asyncio.sleep(0.02)
    finally:
        server.cancel()

    found: list[str] = []

    def clean(where: str, stored: object) -> None:
        found.extend(_leaks(where, stored))

    def check(where: str, ok: bool) -> None:
        if not ok:
            found.append(f"{where}: marker not kept")

    turn_id = await pool.fetchval("SELECT turn_id FROM queued_messages WHERE id = $1", queued_id)
    assert turn_id is not None
    assert await pool.fetchval("SELECT status FROM turns WHERE id = $1", turn_id) == "ok"

    # -- the running turn saw the real key (the mask is at persist only) -----
    sent = json.dumps(gateway.payloads)
    assert HEADER in sent  # the user message, as he typed it
    assert COOKIE in sent  # the device's output, as it came back

    # -- turn_spans.meta (args_redacted, facts, result_head, error) ----------
    spans = await pool.fetch(
        "SELECT name, meta::text AS m FROM turn_spans WHERE turn_id = $1", turn_id
    )
    clean("turn_spans.meta", "\n".join(r["m"] for r in spans))
    run = next(json.loads(r["m"]) for r in spans if r["name"] == "device_run")
    check("args_redacted", run["args_redacted"]["argv"][4] == _masked_header())

    # -- tool_results (+ chars = the stored length) ---------------------------
    kept = await pool.fetch(
        "SELECT tool, content, chars FROM tool_results WHERE turn_id = $1 ORDER BY ref", turn_id
    )
    assert {r["tool"] for r in kept} >= {"device_run"}
    for row in kept:
        clean(f"tool_results[{row['tool']}]", row["content"])
        check(f"tool_results[{row['tool']}].chars", row["chars"] == len(row["content"]))
    run_result = next(r["content"] for r in kept if r["tool"] == "device_run")
    check("tool_results", f"Set-Cookie: <masked:{len('session=' + COOKIE)} chars>" in run_result)

    # -- the assistant row and the user row ------------------------------------
    reply = await pool.fetchval(
        "SELECT content FROM messages WHERE turn_id = $1 AND role = 'assistant'", turn_id
    )
    clean("the assistant row", reply)
    check("the assistant row", _masked_header() in reply)
    user_row = await pool.fetchval(
        "SELECT content FROM messages WHERE conversation_id = $1 AND role = 'user'", room
    )
    clean("the user row", user_row)
    check("the user row", _masked_header() in user_row)

    # -- the memory ingest payload (exchange + thread) and the memory door ----
    (ingest,) = memory.ingests
    assert ingest.get("thread"), ingest
    clean("the memory ingest payload", ingest)
    check("the ingest exchange", _masked_header() in ingest["exchange"]["user"])
    (save,) = memory.saves
    clean("the memory_save payload", save)
    check("the memory_save payload", _masked_header() in save["content"])

    # -- device_jobs argv / reason ---------------------------------------------
    (job,) = await pool.fetch("SELECT id, argv, reason, state FROM device_jobs")
    assert job["state"] == "failed_to_start"
    clean("device_jobs.argv", list(job["argv"]))
    clean("device_jobs.reason", job["reason"])
    check("device_jobs.argv", _masked_header() in job["argv"][2])
    # The agent's own terminal frame for the job: its reason is masked too.
    device_id, epoch = await pool.fetchrow(
        "SELECT id, audit_epoch FROM devices WHERE name = $1", LAPTOP
    )
    stored = await device_jobs.apply_frame(
        pool,
        device_id,
        {
            "job_id": job["id"],
            "state": "lost",
            "exit_code": None,
            "log_bytes": 0,
            "reason": f"the agent restarted mid `curl -H '{HEADER}'`",
        },
        epoch=epoch,
    )
    assert stored == device_jobs.STORED
    clean(
        "device_jobs.reason (frame)",
        await pool.fetchval("SELECT reason FROM device_jobs WHERE id = $1", job["id"]),
    )

    # -- queued_messages.body after claim; a waiting one untouched -------------
    clean(
        "queued_messages.body after claim",
        await pool.fetchval("SELECT body FROM queued_messages WHERE id = $1", queued_id),
    )
    assert (
        await pool.fetchval("SELECT body FROM queued_messages WHERE id = $1", waiting_id) == message
    )

    # -- device_audit.summary is the device's signed record: untouched ---------
    summaries = [r["summary"] for r in await pool.fetch("SELECT summary FROM device_audit")]
    assert summaries and any(KEY in s for s in summaries), summaries

    assert found == [], "\n".join(found)


async def test_the_delegate_brief_row_holds_no_key_byte(pool, mount_peers, root):  # noqa: F811
    owner = await _owner(pool)
    coder = await _create(pool, mount_peers)
    gateway = ScriptedGateway(rounds=((text("I checked the events API."),),))
    mount_peers(gateway=gateway, memory=FakeMemory())

    result, ok = await tools.dispatch(
        "delegate_to_agent",
        {"agent": "coder", "task": f'check the events API with -H "{HEADER}"'},
        _agent_ctx(owner),
    )
    assert ok, result
    # The agent's turn ran with the real key; its log keeps the masked brief.
    assert HEADER in json.dumps(gateway.payloads)
    brief = await pool.fetchval(
        "SELECT content FROM messages WHERE conversation_id = $1 AND role = 'user'",
        coder.log_conversation_id,
    )
    _assert_clean("the delegate brief row", brief)
    assert _masked_header() in brief


async def test_close_turn_masks_spans_and_results_and_keeps_undo_exact(pool):
    """turn_actions.undo is a revert's exact bytes (a file may legitimately
    hold a token): never masked. The live results list is never rewritten."""
    owner = await _owner(pool)
    conversation = await pool.fetchval(
        "INSERT INTO conversations (person_id) VALUES ($1) RETURNING id", owner.id
    )
    turn = await traces.open_turn(pool, conversation_id=conversation, person_id=owner.id)
    with turn.span("tool", "device_read_file") as span:
        span.meta["result_head"] = f"{HEADER}\n"
    kept = traces.keep_result(turn, "c1", "device_read_file", f"curl -H '{HEADER}'\n")
    undo = {"path": "/home/j/.netrc", "before": f"{HEADER}\n"}
    turn.actions.append(traces.Action(tool="device_write_file", ok=True, undo=undo))
    await traces.close_turn(pool, turn, "ok")

    meta = await pool.fetchval("SELECT meta::text FROM turn_spans WHERE turn_id = $1", turn.id)
    _assert_clean("span meta", meta)
    row = await pool.fetchrow("SELECT content, chars FROM tool_results WHERE turn_id = $1", turn.id)
    _assert_clean("tool_results", row["content"])
    assert row["content"] == f"curl -H '{_masked_header()}'\n"
    assert row["chars"] == len(row["content"])
    # In memory the turn's own result is what she was sent, whole.
    assert kept.content == f"curl -H '{HEADER}'\n"
    stored_undo = await pool.fetchval("SELECT undo FROM turn_actions WHERE turn_id = $1", turn.id)
    stored_undo = json.loads(stored_undo) if isinstance(stored_undo, str) else stored_undo
    assert stored_undo == undo


async def test_what_is_stored_on_purpose_keeps_its_bytes(pool):
    """events.payload is a sender's input, not turn text; event_senders keeps
    the token it minted; a queued body not yet claimed is a turn still to run."""
    owner = await _owner(pool)
    _sender, token = await events.add_sender(pool, "ci_bot", added_by="nova", reveal_once=True)
    assert await events.take_token_once(pool, "ci_bot") == token
    payload = json.dumps({"curl": f"-H '{HEADER}'"})
    event_id = await events.accept(pool, "ci_bot", payload, "application/json")
    assert await pool.fetchval("SELECT payload FROM events WHERE id = $1", event_id) == payload
    conversation = await pool.fetchval(
        "INSERT INTO conversations (person_id) VALUES ($1) RETURNING id", owner.id
    )
    waiting = await queued.enqueue_for_test(pool, conversation, owner.id, HEADER)
    assert await pool.fetchval("SELECT body FROM queued_messages WHERE id = $1", waiting) == HEADER


def test_every_boundary_calls_the_one_mask():
    """One function, not a second regex somewhere: each boundary module
    calls credential_mask, directly or through the turn's set (T3:
    traces.secrets_of / Turn.secrets, which is credential_mask.Secrets)."""
    import inspect

    from app.tools import memory_tools

    for module in (traces, chat, agents, device_jobs, queued, memory_tools):
        source = inspect.getsource(module)
        assert "credential_mask" in source or "secrets_of(" in source, module.__name__


# -- T3: a value masked once this turn is masked bare everywhere it lands ------


def _bare_answer(device):
    """The laptop for T3: the curl echoes the header and sets a cookie; a
    later `cat` prints the key and the cookie BARE (its own argv names
    neither, so no per-call sink knows them); job.start refuses quoting
    its argv."""

    def answer(envelope: dict) -> dict:
        argv = envelope["args"]["argv"]
        if envelope["capability"] == "job.start":
            return {"ok": False, "error": f"could not start: {' '.join(argv)}"}
        if argv[0] == "cat":
            return {"ok": True, "output": f"key: {KEY}\nsession: {COOKIE}\n", "exit_code": 0}
        return {
            "ok": True,
            "output": f"> {HEADER}\n< HTTP/1.1 200 OK\n< Set-Cookie: session={COOKIE}\n",
            "exit_code": 0,
        }

    return answer


async def test_a_value_masked_this_turn_is_masked_bare_at_every_boundary(pool, mount_peers):
    owner = await _owner(pool)
    device, conn, _task = await _connect_host(pool, name=LAPTOP, hostname="laptop-host")
    audit: list[str] = []
    server = asyncio.create_task(_serve(device, conn, _bare_answer(device), audit))

    # Only the user message carries API_KEY; only the curl's argv ARGV_TOKEN.
    api_key = "a1b2c3d4e5f6g7h8k9"
    argv_token = "t0k3nOnlyInTheArgv42"
    message = (
        f'please run curl -i -H "{HEADER}" -H "Cookie: lang=en" -H "X-Api-Key: {api_key}" '
        f"{URL} on the laptop"
    )
    conversation = await pool.fetchval(
        "INSERT INTO conversations (person_id) VALUES ($1) RETURNING id", owner.id
    )
    queued_id = await queued.enqueue_for_test(pool, conversation, owner.id, message)
    reply = (
        f"Done. The key {KEY} works, your session is {COOKIE}, and I set lang=en. "
        f"{api_key} and {argv_token} went too."
    )
    gateway = ScriptedGateway(
        rounds=(
            (
                _calls(
                    (
                        "c1",
                        "device_run",
                        {
                            "device": LAPTOP,
                            "argv": [
                                "curl",
                                "-H",
                                HEADER,
                                "-H",
                                f"X-Auth-Token: {argv_token}",
                                URL,
                            ],
                        },
                    ),
                ),
            ),
            (
                _calls(
                    ("c2", "device_run", {"device": LAPTOP, "argv": ["cat", "/tmp/events"]}),
                    (
                        "c3",
                        "device_job_start",
                        {"device": LAPTOP, "argv": ["sh", "-c", f"echo {KEY} {COOKIE}"]},
                    ),
                    ("c4", "memory_save", {"title": "events", "content": f"key {KEY}"}),
                ),
            ),
            (text(reply),),
        )
    )
    memory = FakeMemory()
    mount_peers(gateway=gateway, memory=memory)
    try:
        before = set(chat._BACKGROUND)
        await chat.drain_queue(app, pool, conversation)
        await asyncio.wait_for(chat.drain_background(), timeout=20)
        await chat.settle_detached(before)
        await asyncio.wait_for(memory.ingested.wait(), timeout=5)
    finally:
        server.cancel()

    turn_id = await pool.fetchval("SELECT turn_id FROM queued_messages WHERE id = $1", queued_id)
    assert await pool.fetchval("SELECT status FROM turns WHERE id = $1", turn_id) == "ok"
    # The running turn read the cat's bare echo as it came back.
    assert f"key: {KEY}" in json.dumps(gateway.payloads)

    found: list[str] = []
    spans = await pool.fetch("SELECT meta::text AS m FROM turn_spans WHERE turn_id = $1", turn_id)
    found += _leaks("turn_spans.meta", "\n".join(r["m"] for r in spans))
    kept = await pool.fetch(
        "SELECT tool, content, chars FROM tool_results WHERE turn_id = $1 ORDER BY ref", turn_id
    )
    for row in kept:
        found += _leaks(f"tool_results[{row['tool']}]", row["content"])
        assert row["chars"] == len(row["content"])
    stored = await pool.fetchval(
        "SELECT content FROM messages WHERE turn_id = $1 AND role = 'assistant'", turn_id
    )
    found += _leaks("the assistant row", stored)
    (ingest,) = memory.ingests
    found += _leaks("the memory ingest payload", ingest)
    (save,) = memory.saves
    found += _leaks("the memory_save payload", save)
    (job,) = await pool.fetch("SELECT argv, reason FROM device_jobs")
    found += _leaks("device_jobs.argv", list(job["argv"]))
    assert found == [], "\n".join(found)

    # Masked in place, and the short cookie value (under the floor) untouched.
    assert stored == (
        f"Done. The key <masked:{len(KEY)} chars> works, your session is "
        f"<masked:{len(COOKIE)} chars>, and I set lang=en. "
        f"<masked:{len(api_key)} chars> and <masked:{len(argv_token)} chars> went too."
    )
    user_row = await pool.fetchval(
        "SELECT content FROM messages WHERE conversation_id = $1 AND role = 'user'", conversation
    )
    assert "Cookie: <masked:7 chars>" in user_row


async def test_a_value_from_another_turn_is_not_used_and_goes_with_its_turn(pool):
    owner = await _owner(pool)
    conversation = await pool.fetchval(
        "INSERT INTO conversations (person_id) VALUES ($1) RETURNING id", owner.id
    )
    first = await traces.open_turn(pool, conversation_id=conversation, person_id=owner.id)
    traces.keep_result(first, "c1", "device_run", f"> {HEADER}\n")
    await chat._persist_assistant(pool, conversation, f"first: {KEY}", first.id)
    second = await traces.open_turn(pool, conversation_id=conversation, person_id=owner.id)
    traces.keep_result(second, "c1", "device_run", f"key: {KEY}\n")
    await chat._persist_assistant(pool, conversation, f"second: {KEY}", second.id)
    await traces.close_turn(pool, first, "ok")
    await traces.close_turn(pool, second, "ok")

    async def reply(turn_id):
        return await pool.fetchval(
            "SELECT content FROM messages WHERE turn_id = $1 AND role = 'assistant'", turn_id
        )

    assert await reply(first.id) == f"first: <masked:{len(KEY)} chars>"
    # The second turn's own masks never found the key: its rows keep it.
    assert await reply(second.id) == f"second: {KEY}"
    assert (
        await pool.fetchval("SELECT content FROM tool_results WHERE turn_id = $1", second.id)
        == f"key: {KEY}\n"
    )

    # Cleared with the turn: once the Turn object is gone, its id finds nothing.
    first_id = first.id
    assert traces.secrets_of(first_id).mask(KEY) == f"<masked:{len(KEY)} chars>"
    del first
    gc.collect()
    assert traces.secrets_of(first_id).mask(KEY) == KEY


async def test_the_delegate_brief_masks_bare_what_the_calling_turn_masked(
    pool,
    mount_peers,
    root,  # noqa: F811
):
    owner = await _owner(pool)
    coder = await _create(pool, mount_peers)
    mount_peers(gateway=ScriptedGateway(rounds=((text("checked"),),)), memory=FakeMemory())
    caller = await traces.open_turn(pool, person_id=owner.id)
    traces.keep_result(caller, "c1", "device_run", f"> {HEADER}\n")
    ctx = dataclasses.replace(_agent_ctx(owner), turn_id=caller.id)

    result, ok = await tools.dispatch(
        "delegate_to_agent", {"agent": "coder", "task": f"check the events API with {KEY}"}, ctx
    )
    assert ok, result
    brief = await pool.fetchval(
        "SELECT content FROM messages WHERE conversation_id = $1 AND role = 'user'",
        coder.log_conversation_id,
    )
    assert KEY not in brief
    assert f"Task: check the events API with <masked:{len(KEY)} chars>" in brief
