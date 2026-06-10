"""Unit tests for local inference URL resolution in Settings."""
from __future__ import annotations

import pytest
from app.config import _BACKEND_DEFAULT_URLS, _OLLAMA_HOST_URL, Settings


@pytest.fixture(autouse=True)
def _clean_env(monkeypatch):
    """Isolate Settings from the developer's environment."""
    for var in ("NOVA_INFERENCE_BACKEND", "LOCAL_INFERENCE_URL"):
        monkeypatch.delenv(var, raising=False)


def make_settings(**overrides) -> Settings:
    return Settings(_env_file=None, **overrides)


class TestLocalInferenceUrlResolution:
    """Back-compat aliases and backend-default resolution for LOCAL_INFERENCE_URL."""

    def test_literal_url_passes_through(self):
        url = "http://192.168.0.50:11434"
        assert make_settings(local_inference_url=url).local_inference_url == url

    def test_auto_resolves_to_host_ollama(self):
        """'auto' is a back-compat alias for the host-Ollama URL."""
        s = make_settings(local_inference_url="auto")
        assert s.local_inference_url == _OLLAMA_HOST_URL

    def test_host_resolves_to_host_ollama(self):
        """'host' is a back-compat alias for the host-Ollama URL."""
        s = make_settings(local_inference_url="host")
        assert s.local_inference_url == _OLLAMA_HOST_URL

    def test_https_url_passes_through(self):
        url = "https://ollama.example.com"
        assert make_settings(local_inference_url=url).local_inference_url == url

    def test_default_backend_keeps_host_ollama_url(self):
        s = make_settings()
        assert s.nova_inference_backend == "ollama-host"
        assert s.local_inference_url == _OLLAMA_HOST_URL

    def test_non_ollama_backend_gets_its_default_url(self):
        """URL left at default + non-Ollama backend → that backend's default URL."""
        s = make_settings(nova_inference_backend="vllm")
        assert s.local_inference_url == _BACKEND_DEFAULT_URLS["vllm"]

    def test_explicit_url_beats_backend_default(self):
        url = "http://10.0.0.5:8000"
        s = make_settings(nova_inference_backend="vllm", local_inference_url=url)
        assert s.local_inference_url == url

    def test_auto_with_non_ollama_backend_resolves_to_backend_default(self):
        """'auto' defers to the backend: the alias resolves to the host-Ollama
        URL, which still counts as 'left at default', so the backend's own
        default URL wins."""
        s = make_settings(nova_inference_backend="llamacpp", local_inference_url="auto")
        assert s.local_inference_url == _BACKEND_DEFAULT_URLS["llamacpp"]


def test_subprocess_not_imported_by_module():
    """Catch a revert to the old probe logic: URL resolution must stay pure
    config — app.config must not import subprocess."""
    import app.config as cfg_mod

    assert "subprocess" not in dir(cfg_mod)
