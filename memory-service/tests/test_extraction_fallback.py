"""Unit test: a pinned-but-unavailable EXTRACTION_MODEL must not silently
break memory distillation — _llm_extract retries with auto routing."""
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

sys.path.insert(0, str(Path(__file__).parent.parent))
from app import extraction  # noqa: E402
from app.config import settings  # noqa: E402


class FakeClient:
    def __init__(self, fail_models: set[str]):
        self.fail_models = fail_models
        self.calls: list[str] = []

    async def post(self, url, json):
        model = json["model"]
        self.calls.append(model)
        if model in self.fail_models:
            raise RuntimeError(f"503 model {model} unavailable")
        return SimpleNamespace(
            raise_for_status=lambda: None,
            json=lambda: {"content": "LLM OUTPUT"},
        )


@pytest.fixture
def parsed(monkeypatch):
    sentinel = [{"text": "user likes teal", "kind": "preference", "importance": 0.8}]
    monkeypatch.setattr(extraction, "_parse_items", lambda raw: sentinel)
    return sentinel


@pytest.mark.asyncio
async def test_pinned_model_failure_falls_back_to_auto(monkeypatch, parsed):
    monkeypatch.setattr(settings, "extraction_model", "qwen2.5:1.5b")
    fake = FakeClient(fail_models={"qwen2.5:1.5b"})
    monkeypatch.setattr(extraction, "_client", lambda: fake)

    items = await extraction._llm_extract("User: my favorite color is teal")
    assert items == parsed
    assert fake.calls == ["qwen2.5:1.5b", "auto"]


@pytest.mark.asyncio
async def test_auto_pin_makes_one_attempt(monkeypatch, parsed):
    monkeypatch.setattr(settings, "extraction_model", "auto")
    fake = FakeClient(fail_models=set())
    monkeypatch.setattr(extraction, "_client", lambda: fake)

    items = await extraction._llm_extract("User: hello")
    assert items == parsed
    assert fake.calls == ["auto"]


@pytest.mark.asyncio
async def test_total_failure_returns_none(monkeypatch, parsed):
    monkeypatch.setattr(settings, "extraction_model", "qwen2.5:1.5b")
    fake = FakeClient(fail_models={"qwen2.5:1.5b", "auto"})
    monkeypatch.setattr(extraction, "_client", lambda: fake)

    assert await extraction._llm_extract("User: hello") is None
    assert fake.calls == ["qwen2.5:1.5b", "auto"]
