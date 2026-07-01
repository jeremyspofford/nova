"""Unit tests for OLLAMA_BASE_URL resolution."""
from __future__ import annotations

from app.config import _resolve_ollama_url


class TestResolveOllamaUrl:
    """Verify back-compat behavior of OLLAMA_BASE_URL aliases."""

    def test_literal_url_passes_through(self):
        url = "http://192.168.0.50:11434"
        assert _resolve_ollama_url(url) == url

    def test_auto_resolves_to_host(self):
        """'auto' aliases a host-run Ollama (Nova bundles none)."""
        assert _resolve_ollama_url("auto") == "http://host.docker.internal:11434"

    def test_host_resolves_to_host(self):
        """'host' aliases a host-run Ollama (Nova bundles none)."""
        assert _resolve_ollama_url("host") == "http://host.docker.internal:11434"

    def test_empty_resolves_to_host(self):
        """An empty value falls back to the host Ollama default."""
        assert _resolve_ollama_url("") == "http://host.docker.internal:11434"

    def test_external_lan_url_passes_through(self):
        """A user-provided LAN URL must pass through unchanged."""
        url = "http://192.168.12.10:11434"
        assert _resolve_ollama_url(url) == url

    def test_https_url_passes_through(self):
        """An HTTPS cloud URL must pass through unchanged."""
        url = "https://ollama.example.com"
        assert _resolve_ollama_url(url) == url

    def test_no_subprocess_calls_during_resolution(self, monkeypatch):
        """Resolution must NOT shell out — that was the old probe logic."""
        import subprocess
        called = {"count": 0}
        original_run = subprocess.run

        def fake_run(*args, **kwargs):
            called["count"] += 1
            return original_run(*args, **kwargs)

        monkeypatch.setattr(subprocess, "run", fake_run)
        _resolve_ollama_url("auto")
        _resolve_ollama_url("host")
        _resolve_ollama_url("http://ollama:11434")
        assert called["count"] == 0, "URL resolution must not call subprocess"

    def test_subprocess_no_longer_imported_by_module(self):
        """Catch a partial revert: app.config must not re-import subprocess."""
        import importlib

        import app.config as cfg_mod
        importlib.reload(cfg_mod)
        assert "subprocess" not in dir(cfg_mod), (
            "subprocess must not be a module attribute of app.config — "
            "this catches an accidental revert of the resolver simplification"
        )
