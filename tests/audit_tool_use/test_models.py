import pytest
from audit_tool_use.models import filter_available_models


def test_filters_only_available_providers():
    payload = {
        "providers": [
            {"id": "ollama", "available": True, "models": ["llama3.2", "mistral"]},
            {"id": "openai", "available": False, "models": ["gpt-4o"]},
            {"id": "anthropic", "available": True, "models": ["claude-sonnet-4-6"]},
        ]
    }
    models = filter_available_models(payload)
    ids = {m["model_id"] for m in models}
    assert "llama3.2" in ids
    assert "claude-sonnet-4-6" in ids
    assert "gpt-4o" not in ids


def test_returns_empty_when_no_providers():
    assert filter_available_models({"providers": []}) == []
