"""Tests for fake_llm fixture in replay mode."""

from __future__ import annotations

import json
from pathlib import Path

import pytest


@pytest.fixture
def llm_fixture_dir(tmp_path: Path) -> Path:
    """Override the default fixture dir for these tests."""
    return tmp_path / "llm"


def _write_fixture(path: Path, hash_key: str, response: str) -> None:
    path.mkdir(parents=True, exist_ok=True)
    (path / f"{hash_key}.json").write_text(
        json.dumps(
            {
                "raw_prompt": "anything",
                "response": response,
            }
        )
    )


@pytest.mark.asyncio
async def test_fake_llm_returns_recorded_response(
    monkeypatch, llm_fixture_dir, fake_llm_factory
):
    monkeypatch.setenv("LLM_FIXTURE_DIR", str(llm_fixture_dir))
    fake_llm = fake_llm_factory()
    from ._llm_prompt_norm import hash_prompt

    prompt = "Decompose: hello world"
    _write_fixture(llm_fixture_dir, hash_prompt(prompt), "FAKE_RESPONSE")

    result = await fake_llm(prompt=prompt, model="auto")
    assert result == "FAKE_RESPONSE"


@pytest.mark.asyncio
async def test_fake_llm_raises_on_missing_fixture(
    monkeypatch, llm_fixture_dir, fake_llm_factory
):
    monkeypatch.setenv("LLM_FIXTURE_DIR", str(llm_fixture_dir))
    monkeypatch.delenv("RECORD_LLM_FIXTURES", raising=False)
    fake_llm = fake_llm_factory()
    with pytest.raises(FileNotFoundError) as exc:
        await fake_llm(prompt="never recorded", model="auto")
    assert "never recorded" in str(exc.value) or "fixture" in str(exc.value).lower()


@pytest.mark.asyncio
async def test_fake_llm_normalizes_timestamp_in_prompt(
    monkeypatch, llm_fixture_dir, fake_llm_factory
):
    """Two prompts that differ only by timestamp hit the same fixture."""
    from ._llm_prompt_norm import hash_prompt

    monkeypatch.setenv("LLM_FIXTURE_DIR", str(llm_fixture_dir))
    fake_llm = fake_llm_factory()
    a = "Now is 2026-05-05T17:30:21Z. Decompose: x"
    b = "Now is 2026-05-06T10:00:00Z. Decompose: x"
    _write_fixture(llm_fixture_dir, hash_prompt(a), "OK")

    res_a = await fake_llm(prompt=a, model="auto")
    res_b = await fake_llm(prompt=b, model="auto")
    assert res_a == res_b == "OK"
