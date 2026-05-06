"""Tests for fake_llm record mode."""

from __future__ import annotations

import json

import pytest


@pytest.mark.asyncio
async def test_record_mode_writes_fixture_file(monkeypatch, tmp_path, fake_llm_factory):
    """In record mode, the first call writes a fixture file and returns the real response."""
    fixture_dir = tmp_path / "llm"
    monkeypatch.setenv("LLM_FIXTURE_DIR", str(fixture_dir))
    monkeypatch.setenv("RECORD_LLM_FIXTURES", "1")

    # Stub out the real LLM gateway call inside the recorder
    from . import conftest as cdb

    async def _stub_real_call(*, prompt: str, model: str, **kw) -> str:
        return f"REAL[{prompt[:5]}]"

    monkeypatch.setattr(cdb, "_real_llm_call", _stub_real_call)

    fake_llm = fake_llm_factory()
    response = await fake_llm(prompt="Decompose: hello", model="auto")

    assert response == "REAL[Decom]"
    files = list(fixture_dir.glob("*.json"))
    assert len(files) == 1
    payload = json.loads(files[0].read_text())
    assert payload["response"] == "REAL[Decom]"
    assert payload["raw_prompt"] == "Decompose: hello"


@pytest.mark.asyncio
async def test_record_mode_replays_after_recording(
    monkeypatch, tmp_path, fake_llm_factory
):
    """A second call (still in record mode) hits the existing fixture instead of re-recording."""
    fixture_dir = tmp_path / "llm"
    monkeypatch.setenv("LLM_FIXTURE_DIR", str(fixture_dir))
    monkeypatch.setenv("RECORD_LLM_FIXTURES", "1")

    from . import conftest as cdb

    call_count = {"n": 0}

    async def _stub_real_call(*, prompt: str, model: str, **kw) -> str:
        call_count["n"] += 1
        return "REAL"

    monkeypatch.setattr(cdb, "_real_llm_call", _stub_real_call)

    fake_llm = fake_llm_factory()
    await fake_llm(prompt="x", model="auto")
    await fake_llm(prompt="x", model="auto")
    assert call_count["n"] == 1, "second call should replay, not re-record"
