"""Unit tests for the llm-gateway fallback fixes (2026-07-10 curation audit).

Covers three audit bugs, no services required:
1. Cloud chain members substitute llm.cloud_fallback_model / their own default
   for local-style model names instead of forwarding them raw (total-outage bug).
5. LiteLLMProvider raises on a 200-with-empty-content provider response
   (Cerebras model-not-found path) instead of returning "".
6. 429 retry hints are parsed and honored (one bounded retry per member).

Run:
    cd tests && uv run --with-requirements requirements.txt pytest test_gateway_fallback.py -v
"""
from __future__ import annotations

import asyncio

import pytest
from _service_app import service_app


@pytest.fixture
def gw():
    """Import llm-gateway modules in isolation; yields an import function."""
    with service_app("llm-gateway") as import_module:
        yield import_module


# ── is_cloud_model_name ───────────────────────────────────────────────────────

def test_cloud_model_name_detection(gw):
    utils = gw("app.providers.utils")
    for name in (
        "groq/llama-3.3-70b-versatile", "gemini/gemini-2.5-flash",
        "nvidia_nim/meta/llama-3.3-70b-instruct", "chatgpt/gpt-4o",
        "cerebras/llama3.1-8b", "openrouter/meta-llama/llama-3.1-8b-instruct:free",
        "claude-sonnet-4-6", "gpt-4o", "gemini-2.5-flash",
    ):
        assert utils.is_cloud_model_name(name), name
    for name in (
        "llama3.2", "qwen2.5:7b", "openbmb/minicpm5:latest",
        "phi4", "nomic-embed-text", "", None,
    ):
        assert not utils.is_cloud_model_name(name), name


# ── retry hint parsing ────────────────────────────────────────────────────────

def test_retry_hint_parsing(gw):
    hints = gw("app.providers.retry_hints")
    # google.api_core proto text
    e = RuntimeError("429 Resource has been exhausted. retry_delay {\n  seconds: 6\n}")
    assert hints.rate_limit_retry_delay(e) == 6.0
    # Gemini REST via litellm
    e = RuntimeError('RateLimitError: {"error": {"code": 429, "details": [{"retryDelay": "7s"}]}}')
    assert hints.rate_limit_retry_delay(e) == 7.0
    # OpenAI style
    e = RuntimeError("Rate limit reached. Please try again in 6.2s.")
    assert hints.rate_limit_retry_delay(e) == 6.2
    # attribute wins
    e = RuntimeError("whatever")
    e.retry_after = 3
    assert hints.rate_limit_retry_delay(e) == 3.0
    # not a rate limit error → None
    assert hints.rate_limit_retry_delay(RuntimeError("connection refused")) is None
    # rate limited but no usable hint → None
    assert hints.rate_limit_retry_delay(RuntimeError("429 too many requests")) is None


# ── FallbackProvider substitution + failover ──────────────────────────────────

def _make_fakes(gw):
    """Build fake provider classes bound to the gateway's ModelProvider ABC."""
    base = gw("app.providers.base")
    contracts = gw("nova_contracts")

    class FakeProvider(base.ModelProvider):
        def __init__(self, name, *, local=False, default_model=None, label=None,
                     fail_with=None, fail_times=0):
            self._name = name
            self._is_local = local
            if default_model:
                self._default_model = default_model
            if label:
                self._label = label
            self._fail_with = fail_with
            self._fail_times = fail_times
            self.calls: list[str | None] = []

        @property
        def name(self):
            return self._name

        @property
        def is_local(self):
            return self._is_local

        @property
        def capabilities(self):
            return {contracts.ModelCapability.chat}

        async def complete(self, request):
            self.calls.append(request.model)
            if self._fail_with is not None and (
                self._fail_times == 0 or len(self.calls) <= self._fail_times
            ):
                raise self._fail_with
            return contracts.CompleteResponse(
                content="ok", model=request.model or "?",
                input_tokens=1, output_tokens=1, finish_reason="stop",
            )

        async def stream(self, request):
            raise NotImplementedError

        async def embed(self, request):
            raise NotImplementedError

    def req(model):
        return contracts.CompleteRequest(
            model=model, messages=[{"role": "user", "content": "hi"}],
        )

    return FakeProvider, req


def test_local_name_substituted_for_cloud_member(gw, monkeypatch):
    """A local model name never reaches a cloud member raw (audit bug 1)."""
    fb = gw("app.providers.fallback_provider")
    FakeProvider, req = _make_fakes(gw)

    async def configured():
        return "groq/llama-3.3-70b-versatile"
    monkeypatch.setattr(fb, "_configured_cloud_fallback_model", configured)

    local = FakeProvider("local", local=True, fail_with=RuntimeError("model not pulled"))
    groq = FakeProvider("litellm-groq", label="groq",
                        default_model="groq/llama-3.1-8b-instant")
    chain = fb.FallbackProvider(providers=[local, groq])

    resp = asyncio.run(chain.complete(req("openbmb/minicpm5:latest")))
    assert resp.content == "ok"
    # local leg got the raw name; the groq leg got the configured fallback
    assert local.calls == ["openbmb/minicpm5:latest"]
    assert groq.calls == ["groq/llama-3.3-70b-versatile"]


def test_member_uses_own_default_when_configured_is_foreign(gw, monkeypatch):
    """A member that can't serve llm.cloud_fallback_model uses its own default."""
    fb = gw("app.providers.fallback_provider")
    FakeProvider, req = _make_fakes(gw)

    async def configured():
        return "groq/llama-3.3-70b-versatile"
    monkeypatch.setattr(fb, "_configured_cloud_fallback_model", configured)

    gemini = FakeProvider("gemini", default_model="gemini/gemini-2.5-flash")
    chain = fb.FallbackProvider(providers=[gemini])

    asyncio.run(chain.complete(req("llama3.2")))
    assert gemini.calls == ["gemini/gemini-2.5-flash"]


def test_cloud_name_passes_through_unchanged(gw, monkeypatch):
    fb = gw("app.providers.fallback_provider")
    FakeProvider, req = _make_fakes(gw)

    async def configured():
        return "groq/llama-3.3-70b-versatile"
    monkeypatch.setattr(fb, "_configured_cloud_fallback_model", configured)

    gemini = FakeProvider("gemini", default_model="gemini/gemini-2.5-flash")
    chain = fb.FallbackProvider(providers=[gemini])

    asyncio.run(chain.complete(req("gemini/gemini-2.5-pro")))
    assert gemini.calls == ["gemini/gemini-2.5-pro"]


def test_rate_limit_hint_retries_same_member(gw, monkeypatch):
    """A short 429 hint sleeps and retries the same member once (audit bug 6)."""
    fb = gw("app.providers.fallback_provider")
    FakeProvider, req = _make_fakes(gw)

    slept: list[float] = []

    async def fake_sleep(s):
        slept.append(s)
    monkeypatch.setattr(fb.asyncio, "sleep", fake_sleep)

    limited = FakeProvider(
        "gemini", default_model="gemini/gemini-2.5-flash",
        fail_with=RuntimeError("429 rate limit: please try again in 6s"),
        fail_times=1,  # first call fails, retry succeeds
    )
    chain = fb.FallbackProvider(providers=[limited])

    resp = asyncio.run(chain.complete(req("gemini/gemini-2.5-flash")))
    assert resp.content == "ok"
    assert slept == [6.0]
    assert len(limited.calls) == 2


def test_long_quota_hint_fails_over_immediately(gw, monkeypatch):
    """A daily-quota hint (way past the cap) must not block the chain."""
    fb = gw("app.providers.fallback_provider")
    FakeProvider, req = _make_fakes(gw)

    async def fake_sleep(s):  # any sleep here would be a bug
        raise AssertionError(f"slept {s}s on a quota hint")
    monkeypatch.setattr(fb.asyncio, "sleep", fake_sleep)

    exhausted = FakeProvider(
        "gemini", fail_with=RuntimeError("429 quota exceeded, retry after 40000s"))
    backup = FakeProvider("litellm-groq", label="groq",
                          default_model="groq/llama-3.1-8b-instant")
    chain = fb.FallbackProvider(providers=[exhausted, backup])

    resp = asyncio.run(chain.complete(req("gemini/gemini-2.5-flash")))
    assert resp.content == "ok"
    assert len(exhausted.calls) == 1
    assert backup.calls == ["gemini/gemini-2.5-flash"]


# ── LiteLLM empty-content guard (audit bug 5) ────────────────────────────────

def test_litellm_empty_response_raises(gw, monkeypatch):
    litellm_mod = gw("app.providers.litellm_provider")
    contracts = gw("nova_contracts")

    class _Msg:
        content = None
        tool_calls = None

    class _Choice:
        message = _Msg()
        finish_reason = "stop"

    class _Resp:
        choices = [_Choice()]
        usage = None
        model = "cerebras/llama3.1-8b"

    async def fake_acompletion(**kwargs):
        return _Resp()
    monkeypatch.setattr(litellm_mod.litellm, "acompletion", fake_acompletion)

    provider = litellm_mod.LiteLLMProvider(label="cerebras")
    request = contracts.CompleteRequest(
        model="cerebras/llama3.1-8b",
        messages=[{"role": "user", "content": "hi"}],
    )
    with pytest.raises(RuntimeError, match="empty response"):
        asyncio.run(provider.complete(request))
