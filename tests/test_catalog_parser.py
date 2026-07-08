"""Unit test for the ollama.com library parser (TD-14) — network-free.

Pins the HTML->entries extraction against a captured-shape fixture so a
markup drift on ollama.com is caught here instead of silently degrading the
live recommendation source to the curated fallback.
"""
import importlib.util
import os

_PATH = os.path.join(
    os.path.dirname(__file__), "..", "recovery-service", "app", "inference", "catalog.py"
)
_spec = importlib.util.spec_from_file_location("nova_catalog", _PATH)
catalog = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(catalog)


FIXTURE = """
<ul>
  <li><a href="/library/llama3.1">
    <h2 x-test-model-title>Llama 3.1</h2>
    <p>Llama 3.1 is a new state-of-the-art model from Meta.</p>
    <span x-test-size>8b</span><span x-test-size>70b</span><span x-test-size>405b</span>
    <span x-test-capability>tools</span>
    <span x-test-pull-count>116.9M</span>
  </a></li>
  <li><a href="/library/qwen2.5-coder">
    <h2 x-test-model-title>Qwen 2.5 Coder</h2>
    <p>Code-specific Qwen models for generation and reasoning.</p>
    <span x-test-size>7b</span><span x-test-size>32b</span>
    <span x-test-pull-count>24.6M</span>
  </a></li>
  <li><a href="/library/nomic-embed-text">
    <p>A high-performing open embedding model.</p>
    <span x-test-capability>embedding</span>
    <span x-test-pull-count>77.5M</span>
  </a></li>
</ul>
"""


def test_parse_extracts_all_fields():
    entries = catalog.parse_library(FIXTURE)
    assert len(entries) == 3
    by_name = {e["name"]: e for e in entries}

    llama = by_name["llama3.1"]
    assert llama["param_sizes"] == ["8B", "70B", "405B"]
    assert llama["pulls"] == "116.9M"
    assert llama["category"] == "general"
    assert llama["description"].startswith("Llama 3.1")
    assert llama["url"] == "https://ollama.com/library/llama3.1"
    assert llama["backends"] == ["ollama"]


def test_category_inference():
    by_name = {e["name"]: e for e in catalog.parse_library(FIXTURE)}
    assert by_name["qwen2.5-coder"]["category"] == "code"
    assert by_name["nomic-embed-text"]["category"] == "embedding"


def test_limit_respected():
    assert len(catalog.parse_library(FIXTURE, limit=1)) == 1


def test_empty_or_garbage_returns_empty():
    assert catalog.parse_library("<html><body>nothing here</body></html>") == []
    assert catalog.parse_library("") == []
