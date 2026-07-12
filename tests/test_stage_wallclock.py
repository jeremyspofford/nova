"""Wall-clock kill for pipeline stages (autonomous safety rails, step 3).

The reaper only notices a task whose heartbeats stop; a stage that keeps
heartbeating while grinding through slow LLM/tool rounds used to burn tokens
unbounded. executor._await_stage_with_wallclock cancels the stage coroutine
past pipeline.stage_timeout_seconds and raises StageWallClockTimeout into the
existing stage-failure machinery.

Orchestrator's `app.*` is imported in isolation (see tests/_service_app.py).
No DB, no LLM — config reads are monkeypatched at the runtime_config seam.
"""
from __future__ import annotations

import asyncio
from types import SimpleNamespace

import pytest
from _service_app import service_app


@pytest.fixture
def executor_env():
    with service_app("orchestrator") as import_module:
        yield SimpleNamespace(
            executor=import_module("app.pipeline.executor"),
            runtime_config=import_module("app.runtime_config"),
            settings=import_module("app.config").settings,
        )


def _db_value(monkeypatch, env, value):
    """Make platform_config return `value` for the timeout key."""
    async def fake_get_db_config(key, default=None, ttl=30):
        assert key == "pipeline.stage_timeout_seconds"
        return value

    monkeypatch.setattr(env.runtime_config, "get_db_config", fake_get_db_config)


class TestBudgetResolution:
    async def test_db_value_wins(self, executor_env, monkeypatch):
        _db_value(monkeypatch, executor_env, "120")
        assert await executor_env.executor._stage_wallclock_seconds() == 120.0

    async def test_missing_falls_back_to_settings(self, executor_env, monkeypatch):
        _db_value(monkeypatch, executor_env, None)
        expected = float(executor_env.settings.pipeline_stage_timeout_seconds)
        assert await executor_env.executor._stage_wallclock_seconds() == expected

    async def test_zero_disables(self, executor_env, monkeypatch):
        _db_value(monkeypatch, executor_env, "0")
        assert await executor_env.executor._stage_wallclock_seconds() is None

    async def test_garbage_falls_back_to_settings(self, executor_env, monkeypatch):
        _db_value(monkeypatch, executor_env, "not-a-number")
        expected = float(executor_env.settings.pipeline_stage_timeout_seconds)
        assert await executor_env.executor._stage_wallclock_seconds() == expected


class TestWallClockKill:
    async def test_fast_stage_passes_through(self, executor_env, monkeypatch):
        _db_value(monkeypatch, executor_env, "5")

        async def stage():
            return {"ok": True}

        result = await executor_env.executor._await_stage_with_wallclock(stage(), "task")
        assert result == {"ok": True}

    async def test_slow_stage_is_cancelled(self, executor_env, monkeypatch):
        _db_value(monkeypatch, executor_env, "0.05")
        cancelled = asyncio.Event()

        async def stage():
            try:
                await asyncio.sleep(30)
            except asyncio.CancelledError:
                cancelled.set()
                raise
            return {"ok": True}

        with pytest.raises(executor_env.executor.StageWallClockTimeout) as exc_info:
            await executor_env.executor._await_stage_with_wallclock(stage(), "task")

        # The kill is real — the coroutine received the cancellation, and the
        # error names the stage, the budget, and where to raise it.
        assert cancelled.is_set()
        msg = str(exc_info.value)
        assert "'task'" in msg
        assert "pipeline.stage_timeout_seconds" in msg

    async def test_disabled_budget_never_kills(self, executor_env, monkeypatch):
        _db_value(monkeypatch, executor_env, "0")

        async def stage():
            await asyncio.sleep(0.05)
            return {"ok": True}

        result = await executor_env.executor._await_stage_with_wallclock(stage(), "task")
        assert result == {"ok": True}

    async def test_timeout_is_retryable_in_error_context_terms(self, executor_env, monkeypatch):
        # _run_agent marks error_context.retryable = not isinstance(exc,
        # (ValueError, TypeError, KeyError)) — a wall-clock kill must stay
        # retryable so the reaper/retry machinery can re-run the task.
        _db_value(monkeypatch, executor_env, "0.05")

        async def stage():
            await asyncio.sleep(30)

        with pytest.raises(executor_env.executor.StageWallClockTimeout) as exc_info:
            await executor_env.executor._await_stage_with_wallclock(stage(), "guardrail")
        assert not isinstance(exc_info.value, (ValueError, TypeError, KeyError))
        assert isinstance(exc_info.value, RuntimeError)
