"""Unit tests: model-role overrides — persistence, fallthrough, consumers."""
import pytest
from app import model_roles, selector
from app.config import settings


@pytest.fixture
def runtime(tmp_path, monkeypatch):
    monkeypatch.setattr(settings, "runtime_dir", str(tmp_path))
    model_roles._memo = None
    yield tmp_path
    model_roles._memo = None


def test_no_file_falls_through_to_env(runtime):
    assert model_roles.overrides() == {}
    assert model_roles.completion_model() == settings.local_completion_model
    assert model_roles.embedding_model() == settings.local_embed_model
    assert model_roles.extraction_model() == ""
    eff = model_roles.effective()
    assert all(v["source"] == "env" for v in eff.values())


def test_save_overrides_and_clear(runtime):
    model_roles.save({"completion": "big:32b", "extraction": "tiny:1b"})
    assert model_roles.completion_model() == "big:32b"
    assert model_roles.extraction_model() == "tiny:1b"
    assert model_roles.effective()["completion"]["source"] == "override"
    # Unset roles stay env-sourced.
    assert model_roles.effective()["embedding"]["source"] == "env"

    # Empty string clears back to env.
    model_roles.save({"completion": ""})
    assert model_roles.completion_model() == settings.local_completion_model
    assert model_roles.extraction_model() == "tiny:1b", "other overrides untouched"


def test_unknown_role_rejected(runtime):
    with pytest.raises(ValueError, match="unknown role"):
        model_roles.save({"chairperson": "big:32b"})


def test_selector_uses_completion_override(runtime, monkeypatch):
    model_roles.save({"completion": "override-model:7b"})
    cands = selector.local_candidates()
    assert cands, "default endpoint should produce a candidate"
    assert cands[0][0] == "openai/override-model:7b"


def test_persists_across_memo_reset(runtime):
    model_roles.save({"embedding": "embedder:1b"})
    model_roles._memo = None  # simulate a fresh process
    assert model_roles.embedding_model() == "embedder:1b"
