"""Unit tests for memory-service/app/engram/decomposition.py.

decompose(raw_text, source_type) is a pure LLM-calling function — it takes text,
calls the LLM gateway via get_http_client(), parses the JSON response, and returns
a DecompositionResult. It does NOT write to the database. All DB persistence is in
ingestion.py which calls decompose() as a step.

The standard monkeypatch target is `app.http_client._client` — we replace the shared
singleton with a minimal response-returning stub. Alternatively, for resolve_model
tests we patch `app.engram.decomposition.get_http_client`.
"""

from __future__ import annotations

import json

import pytest
from app.engram import decomposition
from app.engram.decomposition import (
    DecompositionResult,
    _sanitize_decomposition,
    clear_model_cache,
    resolve_model,
)

# ── helpers ──────────────────────────────────────────────────────────────────

_WELL_FORMED_FRAGMENT = {
    "engrams": [
        {
            "type": "fact",
            "content": "Jeremy works at Aria Labs building autonomous AI platforms.",
            "importance": 0.7,
            "entities_referenced": ["Jeremy", "Aria Labs"],
            "temporal": {},
            "temporal_validity": "permanent",
        }
    ],
    "relationships": [],
    "contradictions": [],
}

_ENTITIES_ACTIONS_OUTCOMES = {
    "engrams": [
        {
            "type": "fact",
            "content": "The deployment succeeded.",
            "importance": 0.5,
            "entities_referenced": ["deployment"],
            "temporal": {},
            "temporal_validity": "dated",
        }
    ],
    "relationships": [],
    "contradictions": [],
}


def _make_fake_http_client(
    response_json: dict | None = None, *, status_code: int = 200
):
    """Return a mock httpx.AsyncClient whose post() returns a canned JSON response."""

    class _FakeResponse:
        def __init__(self):
            self.status_code = status_code
            self._data = response_json or {}

        def raise_for_status(self):
            if self.status_code >= 400:
                import httpx

                raise httpx.HTTPStatusError(
                    "error",
                    request=None,
                    response=None,  # type: ignore[arg-type]
                )

        def json(self):
            return self._data

    class _FakeClient:
        async def post(self, *args, **kwargs):
            return _FakeResponse()

        async def get(self, *args, **kwargs):
            return _FakeResponse()

        async def aclose(self):
            pass

    return _FakeClient()


def _gateway_llm_response(content: str) -> dict:
    """Wrap a raw string into the shape the LLM gateway /complete endpoint returns."""
    return {"content": content}


# ── Happy paths ───────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_decompose_returns_fragments_for_well_formed_llm_json(monkeypatch):
    """Given a structured LLM response, decompose returns the expected fragment shape."""
    clear_model_cache()
    fake_client = _make_fake_http_client(
        _gateway_llm_response(json.dumps(_WELL_FORMED_FRAGMENT))
    )
    monkeypatch.setattr(decomposition, "get_http_client", lambda: fake_client)

    result = await decomposition.decompose("Jeremy works at Aria Labs.")

    assert isinstance(result, DecompositionResult)
    assert len(result.engrams) == 1
    assert "Aria Labs" in result.engrams[0].content


@pytest.mark.asyncio
async def test_decompose_extracts_entities_actions_outcomes(monkeypatch):
    """The fragment dict has meaningful content and entities_referenced when LLM returns them."""
    clear_model_cache()
    fake_client = _make_fake_http_client(
        _gateway_llm_response(json.dumps(_ENTITIES_ACTIONS_OUTCOMES))
    )
    monkeypatch.setattr(decomposition, "get_http_client", lambda: fake_client)

    result = await decomposition.decompose("The deployment succeeded.")

    assert len(result.engrams) >= 1
    engram = result.engrams[0]
    assert engram.content  # non-empty
    assert isinstance(engram.entities_referenced, list)


@pytest.mark.asyncio
async def test_decompose_handles_chat_input(monkeypatch):
    """A multi-turn chat string is decomposed into engrams."""
    clear_model_cache()
    multi_turn_response = {
        "engrams": [
            {
                "type": "fact",
                "content": "User prefers Python over Go.",
                "importance": 0.7,
                "entities_referenced": ["Python", "Go"],
                "temporal": {},
                "temporal_validity": "permanent",
            },
            {
                "type": "preference",
                "content": "User prefers async patterns for backend code.",
                "importance": 0.6,
                "entities_referenced": [],
                "temporal": {},
                "temporal_validity": "unknown",
            },
        ],
        "relationships": [],
        "contradictions": [],
    }
    fake_client = _make_fake_http_client(
        _gateway_llm_response(json.dumps(multi_turn_response))
    )
    monkeypatch.setattr(decomposition, "get_http_client", lambda: fake_client)

    chat_text = "User: I prefer Python over Go.\nAssistant: Good choice for async work."
    result = await decomposition.decompose(chat_text, source_type="chat")

    assert isinstance(result, DecompositionResult)
    assert len(result.engrams) >= 1


# ── Error paths ───────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_decompose_invalid_json_returns_fallback(monkeypatch):
    """LLM returns non-JSON text → function logs, returns empty result, doesn't raise."""
    clear_model_cache()
    fake_client = _make_fake_http_client(
        _gateway_llm_response("Sorry, I cannot help with that right now.")
    )
    monkeypatch.setattr(decomposition, "get_http_client", lambda: fake_client)

    result = await decomposition.decompose("Some input text.")

    assert isinstance(result, DecompositionResult)
    assert result.engrams == []
    assert result.relationships == []
    assert result.contradictions == []


@pytest.mark.asyncio
async def test_decompose_truncates_oversized_llm_output(monkeypatch):
    """LLM exceeds expected size → function handles it; doesn't crash."""
    clear_model_cache()
    # 100 KB of non-JSON garbage — the JSON parser will fail gracefully
    huge_garbage = "x" * 100_000
    fake_client = _make_fake_http_client(_gateway_llm_response(huge_garbage))
    monkeypatch.setattr(decomposition, "get_http_client", lambda: fake_client)

    result = await decomposition.decompose("Some input.")

    assert isinstance(result, DecompositionResult)
    # Falls back to empty on parse failure — does not raise
    assert result.engrams == []


@pytest.mark.asyncio
async def test_decompose_empty_input_returns_empty(monkeypatch):
    """Empty string input → returns empty DecompositionResult, no LLM call."""
    clear_model_cache()
    calls = {"n": 0}

    class _CountingClient:
        async def post(self, *args, **kwargs):
            calls["n"] += 1
            raise AssertionError("Should not have called LLM for empty input")

        async def get(self, *args, **kwargs):
            return None

        async def aclose(self):
            pass

    monkeypatch.setattr(decomposition, "get_http_client", lambda: _CountingClient())

    result = await decomposition.decompose("")

    assert isinstance(result, DecompositionResult)
    assert result.engrams == []
    assert calls["n"] == 0


@pytest.mark.asyncio
async def test_decompose_whitespace_only_returns_empty(monkeypatch):
    """Whitespace-only input is treated as empty — no LLM call."""
    clear_model_cache()
    calls = {"n": 0}

    class _CountingClient:
        async def post(self, *args, **kwargs):
            calls["n"] += 1
            raise AssertionError("Should not have called LLM for whitespace input")

        async def get(self, *args, **kwargs):
            return None

        async def aclose(self):
            pass

    monkeypatch.setattr(decomposition, "get_http_client", lambda: _CountingClient())

    result = await decomposition.decompose("   \n\t  ")

    assert isinstance(result, DecompositionResult)
    assert result.engrams == []
    assert calls["n"] == 0


@pytest.mark.asyncio
async def test_decompose_input_with_embedded_json_does_not_confuse_parser(monkeypatch):
    """User content like 'I said {\"key\": \"value\"}' is treated as text, not JSON to parse."""
    clear_model_cache()
    # The LLM receives the full text as-is; the reply is what gets parsed.
    # We capture every POST body that has a "messages" array so we can skip
    # the model-probe call (which sends a bare {"model":..., "messages":[hi]} test).
    decompose_payloads = []

    _EMPTY_RESULT = '{"engrams":[],"relationships":[],"contradictions":[]}'

    class _SpyClient:
        async def post(self, url, *, json=None, **kwargs):  # noqa: A002
            payload = json or {}
            # Only capture calls that look like a decompose call (has a system message)
            messages = payload.get("messages", [])
            if any(m.get("role") == "system" for m in messages):
                decompose_payloads.append(payload)

            class _R:
                status_code = 200

                def raise_for_status(self):
                    pass

                def json(self):
                    return _gateway_llm_response(_EMPTY_RESULT)

            return _R()

        async def get(self, *a, **kw):
            return None

        async def aclose(self):
            pass

    monkeypatch.setattr(decomposition, "get_http_client", lambda: _SpyClient())

    input_text = 'I said {"key": "value"} in my last message'
    result = await decomposition.decompose(input_text)

    # At least one decompose call was made
    assert decompose_payloads, "Expected at least one decompose POST call"
    sent_messages = decompose_payloads[0]["messages"]
    user_message = next(m for m in sent_messages if m["role"] == "user")
    # The raw input_text should be embedded verbatim in the user message
    assert input_text in user_message["content"]

    # And the function returned cleanly
    assert isinstance(result, DecompositionResult)


# ── Model resolution ──────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_resolve_model_auto_probes_gateway(monkeypatch):
    """resolve_model('auto') hits the gateway and returns the resolved model."""
    clear_model_cache()

    class _FakeRedis:
        async def get(self, key):
            return None  # no dashboard config

        async def aclose(self):
            pass

    import redis.asyncio as aioredis

    monkeypatch.setattr(aioredis, "from_url", lambda *a, **kw: _FakeRedis())

    class _FakeClient:
        async def get(self, url, *, timeout=None):
            class _R:
                status_code = 200

                def json(self):
                    return {"model": "qwen2.5:7b"}

            return _R()

        async def post(self, *a, **kw):
            raise AssertionError(
                "Should not probe models via POST once /resolve succeeds"
            )

        async def aclose(self):
            pass

    monkeypatch.setattr(decomposition, "get_http_client", lambda: _FakeClient())

    result = await resolve_model("auto")

    assert result == "qwen2.5:7b"


@pytest.mark.asyncio
async def test_resolve_model_explicit_pass_through():
    """resolve_model('claude-haiku-4-5-20251001') returns the model name unchanged."""
    clear_model_cache()
    result = await resolve_model("claude-haiku-4-5-20251001")
    assert result == "claude-haiku-4-5-20251001"


@pytest.mark.asyncio
async def test_resolve_model_gateway_unreachable_falls_back(monkeypatch):
    """If gateway is unreachable, resolve_model falls back to a default model."""
    import httpx

    clear_model_cache()

    class _FakeRedis:
        async def get(self, key):
            return None

        async def aclose(self):
            pass

    import redis.asyncio as aioredis

    monkeypatch.setattr(aioredis, "from_url", lambda *a, **kw: _FakeRedis())

    class _UnreachableClient:
        async def get(self, url, *, timeout=None):
            raise httpx.ConnectError("refused")

        async def post(self, url, *, json=None, timeout=None):
            raise httpx.ConnectError("refused")

        async def aclose(self):
            pass

    monkeypatch.setattr(decomposition, "get_http_client", lambda: _UnreachableClient())

    # Should not raise — falls back to a hardcoded default
    result = await resolve_model("auto")

    # The fallback is defined in decomposition.py as "llama3.1:8b"
    assert isinstance(result, str)
    assert result  # non-empty — some fallback was chosen


# ── Source/provenance wiring ──────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_decompose_attaches_source_type_to_result(monkeypatch):
    """decompose() returns engrams whose type reflects LLM output, not dropped.

    Note: decompose() is a pure LLM-calling function. source_id/tenant_id are
    added by ingestion.py when it stores the result. This test verifies the
    DecompositionResult contains well-typed engrams.
    """
    clear_model_cache()
    response = {
        "engrams": [
            {
                "type": "entity",
                "content": "Aria Labs",
                "importance": 0.8,
                "entities_referenced": [],
                "temporal": {},
                "temporal_validity": "permanent",
            }
        ],
        "relationships": [],
        "contradictions": [],
    }
    fake_client = _make_fake_http_client(_gateway_llm_response(json.dumps(response)))
    monkeypatch.setattr(decomposition, "get_http_client", lambda: fake_client)

    result = await decomposition.decompose(
        "Aria Labs is the company.", source_type="chat"
    )

    assert len(result.engrams) == 1
    assert result.engrams[0].type.value == "entity"


@pytest.mark.asyncio
async def test_decompose_assigns_correct_source_prompt_for_intel(monkeypatch):
    """source_type='intel' causes the intel system prompt to be selected.

    We verify by checking which system prompt was sent to the LLM.
    """
    clear_model_cache()
    received = {}

    class _SpyClient:
        async def post(self, url, *, json=None, **kwargs):
            received["messages"] = json.get("messages", [])

            class _R:
                status_code = 200

                def raise_for_status(self):
                    pass

                def json(self):
                    return _gateway_llm_response(
                        '{"engrams":[],"relationships":[],"contradictions":[]}'
                    )

            return _R()

        async def get(self, *a, **kw):
            return None

        async def aclose(self):
            pass

    monkeypatch.setattr(decomposition, "get_http_client", lambda: _SpyClient())

    await decomposition.decompose("OpenAI released GPT-5.", source_type="intel")

    assert received.get("messages"), "Expected messages in LLM call"
    system_msg = next(m for m in received["messages"] if m["role"] == "system")
    # Intel prompt emphasises third-party attribution, not user-stated facts
    assert "THIRD-PARTY" in system_msg["content"]


# ── Boundary ──────────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_decompose_respects_token_budget_for_input(monkeypatch):
    """Input is forwarded as text to the LLM call; no truncation silently drops content.

    decompose() does not chunk — it forwards the full text to the LLM within the
    DECOMPOSITION_USER_TEMPLATE. We verify the text appears in the outbound payload.
    """
    clear_model_cache()
    received = {}

    class _SpyClient:
        async def post(self, url, *, json=None, **kwargs):
            received["payload"] = json

            class _R:
                status_code = 200

                def raise_for_status(self):
                    pass

                def json(self):
                    return _gateway_llm_response(
                        '{"engrams":[],"relationships":[],"contradictions":[]}'
                    )

            return _R()

        async def get(self, *a, **kw):
            return None

        async def aclose(self):
            pass

    monkeypatch.setattr(decomposition, "get_http_client", lambda: _SpyClient())

    long_input = (
        "Nova is an autonomous AI platform. " * 50
    )  # ~1750 chars, well within limit
    await decomposition.decompose(long_input)

    user_msg = next(m for m in received["payload"]["messages"] if m["role"] == "user")
    assert long_input in user_msg["content"]
    # Verify max_tokens is set (governs output budget)
    assert received["payload"].get("max_tokens", 0) > 0


@pytest.mark.asyncio
async def test_decompose_propagates_source_type_to_system_prompt(monkeypatch):
    """source_type='knowledge' selects the intel system prompt path (same as 'intel')."""
    clear_model_cache()
    received = {}

    class _SpyClient:
        async def post(self, url, *, json=None, **kwargs):
            received["messages"] = json.get("messages", [])

            class _R:
                status_code = 200

                def raise_for_status(self):
                    pass

                def json(self):
                    return _gateway_llm_response(
                        '{"engrams":[],"relationships":[],"contradictions":[]}'
                    )

            return _R()

        async def get(self, *a, **kw):
            return None

        async def aclose(self):
            pass

    monkeypatch.setattr(decomposition, "get_http_client", lambda: _SpyClient())

    await decomposition.decompose(
        "Some crawled knowledge content.", source_type="knowledge"
    )

    system_msg = next(m for m in received["messages"] if m["role"] == "system")
    # knowledge type uses the intel prompt (THIRD-PARTY attribution)
    assert "THIRD-PARTY" in system_msg["content"]


@pytest.mark.asyncio
async def test_decompose_dedups_identical_fragments(monkeypatch):
    """If LLM returns two identical engrams, DecompositionResult contains both
    (dedup is ingestion.py's responsibility, not decompose()'s).

    This test documents the actual contract: decompose() faithfully returns what
    the LLM said. Callers are responsible for dedup.
    """
    clear_model_cache()
    duplicate_response = {
        "engrams": [
            {
                "type": "fact",
                "content": "Jeremy works at Aria Labs.",
                "importance": 0.7,
                "entities_referenced": ["Jeremy"],
                "temporal": {},
                "temporal_validity": "permanent",
            },
            {
                "type": "fact",
                "content": "Jeremy works at Aria Labs.",  # identical
                "importance": 0.7,
                "entities_referenced": ["Jeremy"],
                "temporal": {},
                "temporal_validity": "permanent",
            },
        ],
        "relationships": [],
        "contradictions": [],
    }
    fake_client = _make_fake_http_client(
        _gateway_llm_response(json.dumps(duplicate_response))
    )
    monkeypatch.setattr(decomposition, "get_http_client", lambda: fake_client)

    result = await decomposition.decompose("Jeremy works at Aria Labs.")

    # decompose() returns what the LLM returned — 2 engrams even if identical
    # Dedup is handled upstream by ingestion.py._store_or_update_engram
    assert len(result.engrams) == 2
    assert result.engrams[0].content == result.engrams[1].content


# ── _sanitize_decomposition unit tests ───────────────────────────────────────


def test_sanitize_coerces_unknown_relation_to_related_to():
    """_sanitize_decomposition replaces unknown relation types with 'related_to'."""
    parsed = {
        "engrams": [],
        "relationships": [
            {"from_index": 0, "to_index": 1, "relation": "inspired_by", "strength": 0.5}
        ],
        "contradictions": [],
    }
    _sanitize_decomposition(parsed)
    assert parsed["relationships"][0]["relation"] == "related_to"


def test_sanitize_renames_source_target_fields():
    """_sanitize_decomposition renames 'source'/'target' to 'from_index'/'to_index'."""
    parsed = {
        "engrams": [],
        "relationships": [
            {"source": 0, "target": 1, "relation": "related_to", "strength": 0.5}
        ],
        "contradictions": [],
    }
    _sanitize_decomposition(parsed)
    rel = parsed["relationships"][0]
    assert "from_index" in rel
    assert "to_index" in rel
    assert "source" not in rel
    assert "target" not in rel
