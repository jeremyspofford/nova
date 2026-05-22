"""Tests use real-shape fixture data captured from a live /providers response
on 2026-05-22 — each provider has a single `model` field, not a `models` list."""
from audit_tool_use.models import filter_available_models


def test_filters_only_available_providers():
    payload = {
        "providers": [
            {"name": "ollama-host", "model": "qwen2.5-coder:7b", "available": True, "local": True},
            {"name": "openai", "model": "gpt-4o-mini", "available": True, "local": False},
            {"name": "broken", "model": "x", "available": False, "local": False},
        ]
    }
    models = filter_available_models(payload)
    ids = {m["model_id"] for m in models}
    assert "qwen2.5-coder:7b" in ids
    assert "gpt-4o-mini" in ids
    assert "x" not in ids


def test_provider_id_uses_name_field():
    payload = {"providers": [{"name": "ollama-host", "model": "llama3.2", "available": True}]}
    models = filter_available_models(payload)
    assert models[0]["provider_id"] == "ollama-host"


def test_local_flag_propagated():
    payload = {"providers": [
        {"name": "ollama-host", "model": "llama3.2", "available": True, "local": True},
        {"name": "openai", "model": "gpt-4o", "available": True, "local": False},
    ]}
    models = filter_available_models(payload)
    assert models[0]["local"] is True
    assert models[1]["local"] is False


def test_returns_empty_when_no_providers():
    assert filter_available_models({"providers": []}) == []


def test_skips_provider_without_model_field():
    """If a provider somehow has no `model` field, skip it rather than crash."""
    payload = {"providers": [{"name": "weird", "available": True}]}
    assert filter_available_models(payload) == []
