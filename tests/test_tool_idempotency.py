"""Idempotency ledger for side-effecting agent tools (migration 103).

Exercises the REAL app.tool_idempotency.run_idempotent (and the real
execute_tool dispatch gate) against the REAL running Postgres — no mocks. The
ledger is what makes Nova's crash-recovery paths (reaper re-enqueue, checkpoint
stage resume) safe to replay a stage that already fired an irreversible tool
call: on replay the tool returns its cached result instead of acting twice.

Orchestrator's `app.*` is imported in isolation (see tests/_service_app.py) so
this coexists with cortex-app tests in the same pytest session.

Run:
    cd tests && uv run --with-requirements requirements.txt pytest test_tool_idempotency.py -v

Requires Postgres up (it is, after ./start). No LLM needed.
"""
from __future__ import annotations

import os
import uuid
from types import SimpleNamespace

import asyncpg
import pytest
import pytest_asyncio
from _service_app import service_app

PG_DSN = os.getenv(
    "NOVA_PG_DSN",
    f"postgresql://nova:{os.getenv('POSTGRES_PASSWORD', 'nova_dev_password')}@localhost:5432/nova",
)

# Synthetic tool name so behavioral tests never fire a real side effect and
# cleanup is a single prefix delete. run_idempotent is tool-name agnostic — the
# IDEMPOTENT_TOOLS gate lives in the dispatch layer, not here — so this
# exercises the identical code path a real wrapped tool would take.
TEST_TOOL = "nova-test-idem-tool"


@pytest_asyncio.fixture
async def orch():
    """Orchestrator app.* loaded in isolation, with app.db pointed at localhost.

    run_idempotent() calls app.db.get_pool(); in-container that resolves to the
    `postgres` host, unreachable from the host test process. We install a
    localhost-DSN pool into the module global (mirroring init_pool) so the real
    code runs against the real table, then restore on teardown.
    """
    with service_app("orchestrator") as import_module:
        app_db = import_module("app.db")
        idem = import_module("app.tool_idempotency")
        tools = import_module("app.tools")

        pool = await asyncpg.create_pool(PG_DSN, min_size=1, max_size=2)
        saved_pool = app_db._pool
        app_db._pool = pool
        async with pool.acquire() as conn:
            await conn.execute("DELETE FROM tool_execution_log WHERE tool_name LIKE 'nova-test-%'")

        ns = SimpleNamespace(
            db=app_db,
            idem=idem,
            tools=tools,
            run_idempotent=idem.run_idempotent,
            IDEMPOTENT_TOOLS=idem.IDEMPOTENT_TOOLS,
            key=idem._key,
            canonical_args=idem._canonical_args,
            pool=pool,
        )
        try:
            yield ns
        finally:
            async with pool.acquire() as conn:
                await conn.execute("DELETE FROM tool_execution_log WHERE tool_name LIKE 'nova-test-%'")
            app_db._pool = saved_pool
            await pool.close()


def _counting_fn(counter: list[int], result: str):
    """Return a zero-arg async callable that records each invocation."""
    async def _fn() -> str:
        counter[0] += 1
        return result
    return _fn


# ── Core contract: run once, replay returns cached result ────────────────────

@pytest.mark.asyncio
async def test_runs_once_then_replays_cached(orch):
    task_id = str(uuid.uuid4())
    args = {"branch": "fix/x", "title": "nova-test PR"}
    calls = [0]
    fn = _counting_fn(calls, "PR #42 created")

    first = await orch.run_idempotent(task_id, TEST_TOOL, args, fn)
    second = await orch.run_idempotent(task_id, TEST_TOOL, args, fn)

    assert first == "PR #42 created"
    assert second == "PR #42 created", "replay must return the cached result"
    assert calls[0] == 1, "the side effect must fire exactly once across a replay"

    async with orch.pool.acquire() as conn:
        row = await conn.fetchrow(
            "SELECT status, result FROM tool_execution_log WHERE idempotency_key = $1",
            orch.key(task_id, TEST_TOOL, args),
        )
    assert row["status"] == "done"
    assert row["result"] == "PR #42 created"


# ── Different args in the same task are distinct actions ─────────────────────

@pytest.mark.asyncio
async def test_different_args_execute_separately(orch):
    task_id = str(uuid.uuid4())
    calls = [0]

    async def fn() -> str:
        calls[0] += 1
        return f"result-{calls[0]}"

    r1 = await orch.run_idempotent(task_id, TEST_TOOL, {"branch": "a"}, fn)
    r2 = await orch.run_idempotent(task_id, TEST_TOOL, {"branch": "b"}, fn)

    assert calls[0] == 2, "distinct args → distinct keys → both fire"
    assert r1 != r2


# ── Same args, different task → distinct actions (key is task-scoped) ─────────

@pytest.mark.asyncio
async def test_scope_is_per_task(orch):
    args = {"text": "morning briefing"}
    calls = [0]

    async def fn() -> str:
        calls[0] += 1
        return "sent"

    await orch.run_idempotent(str(uuid.uuid4()), TEST_TOOL, args, fn)
    await orch.run_idempotent(str(uuid.uuid4()), TEST_TOOL, args, fn)

    assert calls[0] == 2, "same args under a different task_id must fire again"


# ── Failure rolls the claim back so a legit retry isn't blocked ──────────────

@pytest.mark.asyncio
async def test_failure_rolls_back_claim(orch):
    task_id = str(uuid.uuid4())
    args = {"branch": "flaky"}
    calls = [0]

    async def flaky() -> str:
        calls[0] += 1
        if calls[0] == 1:
            raise RuntimeError("transient boom")
        return "succeeded on retry"

    with pytest.raises(RuntimeError, match="transient boom"):
        await orch.run_idempotent(task_id, TEST_TOOL, args, flaky)

    async with orch.pool.acquire() as conn:
        row = await conn.fetchrow(
            "SELECT status FROM tool_execution_log WHERE idempotency_key = $1",
            orch.key(task_id, TEST_TOOL, args),
        )
    assert row is None, "a failed call must roll back its claim"

    result = await orch.run_idempotent(task_id, TEST_TOOL, args, flaky)
    assert result == "succeeded on retry"
    assert calls[0] == 2


# ── An unfinished prior attempt (crash between claim and commit) is not
#    silently repeated — the conservative branch for irreversible actions. ────

@pytest.mark.asyncio
async def test_in_progress_replay_is_conservative(orch):
    task_id = str(uuid.uuid4())
    args = {"branch": "orphaned"}
    key = orch.key(task_id, TEST_TOOL, args)

    async with orch.pool.acquire() as conn:
        await conn.execute(
            "INSERT INTO tool_execution_log (idempotency_key, task_id, tool_name) "
            "VALUES ($1, $2::uuid, $3)",
            key, task_id, TEST_TOOL,
        )

    calls = [0]

    async def fn() -> str:
        calls[0] += 1
        return "should not run"

    result = await orch.run_idempotent(task_id, TEST_TOOL, args, fn)

    assert calls[0] == 0, "an unconfirmed prior attempt must NOT be repeated"
    assert "not repeated" in result.lower()


# ── Ledger DB unreachable → fail OPEN (run the tool, don't block the agent) ──

@pytest.mark.asyncio
async def test_fails_open_when_ledger_unavailable(orch):
    dead = await asyncpg.create_pool(PG_DSN, min_size=1, max_size=1)
    await dead.close()
    saved = orch.db._pool
    orch.db._pool = dead
    try:
        calls = [0]

        async def fn() -> str:
            calls[0] += 1
            return "ran anyway"

        result = await orch.run_idempotent(str(uuid.uuid4()), TEST_TOOL, {"x": 1}, fn)
        assert result == "ran anyway"
        assert calls[0] == 1, "infra failure must not block the tool (fail open)"
    finally:
        orch.db._pool = saved


# ── Guard the wrapped set: right tools in, read-only tools out ───────────────

@pytest.mark.asyncio
async def test_idempotent_tool_set_membership(orch):
    for expected in (
        "github_create_pr", "github_push_branch", "github_create_branch",
        "git_commit", "send_push", "create_recommendation",
    ):
        assert expected in orch.IDEMPOTENT_TOOLS, f"{expected} should be idempotency-guarded"

    for excluded in ("run_shell", "write_file", "git_status", "search_memory", "read_file"):
        assert excluded not in orch.IDEMPOTENT_TOOLS, f"{excluded} must not be idempotency-guarded"


# ── Dispatch wiring: the gate in app/tools/__init__.execute_tool ─────────────

@pytest.mark.asyncio
async def test_dispatch_routes_wrapped_tool_through_ledger(orch, monkeypatch):
    calls = [0]

    async def fake_executor(name: str, arguments: dict) -> str:
        calls[0] += 1
        return "side-effect done"

    monkeypatch.setattr(orch.idem, "IDEMPOTENT_TOOLS", frozenset({TEST_TOOL}))
    monkeypatch.setitem(orch.tools._DISPATCH, TEST_TOOL, fake_executor)

    task_id = str(uuid.uuid4())
    ctx = {"task_id": task_id}
    args = {"branch": "wire"}

    r1 = await orch.tools.execute_tool(TEST_TOOL, args, context=ctx)
    r2 = await orch.tools.execute_tool(TEST_TOOL, args, context=ctx)

    assert r1 == "side-effect done"
    assert r2 == "side-effect done", "replay through dispatch returns cached result"
    assert calls[0] == 1, "dispatch must route wrapped tools through the ledger"


@pytest.mark.asyncio
async def test_dispatch_bypasses_ledger_without_task_scope(orch, monkeypatch):
    calls = [0]

    async def fake_executor(name: str, arguments: dict) -> str:
        calls[0] += 1
        return "ran"

    monkeypatch.setattr(orch.idem, "IDEMPOTENT_TOOLS", frozenset({TEST_TOOL}))
    monkeypatch.setitem(orch.tools._DISPATCH, TEST_TOOL, fake_executor)

    args = {"branch": "no-scope"}
    await orch.tools.execute_tool(TEST_TOOL, args, context=None)
    await orch.tools.execute_tool(TEST_TOOL, args, context={})

    assert calls[0] == 2, "an unscoped call must not be deduped by the ledger"


# ── Key canonicalization: arg order must not change the key ──────────────────

@pytest.mark.asyncio
async def test_key_is_stable_across_arg_order(orch):
    task_id = str(uuid.uuid4())
    a = {"branch": "x", "title": "t"}
    b = {"title": "t", "branch": "x"}
    assert orch.key(task_id, "github_create_pr", a) == orch.key(task_id, "github_create_pr", b)
    assert orch.canonical_args(a) == orch.canonical_args(b)
    assert orch.key(task_id, "github_create_pr", a) != orch.key(task_id, "github_create_pr", {"branch": "y"})
