"""
ChatGPT Subscription Provider — uses ChatGPT Plus/Pro subscription quota.

Two auth paths (tried in order):
  1. CHATGPT_ACCESS_TOKEN env var  ← preferred, works in Docker
     Extract from: ~/.codex/auth.json → tokens.access_token  (JWT)
  2. ~/.codex/auth.json auto-read  ← discovered automatically on host

LiteLLM's native `chatgpt/` provider handles the ChatGPT API endpoint
and token refresh. This is cleaner than subprocess and supports streaming.

NOTE: LiteLLM rejects max_tokens / metadata fields on the chatgpt/ provider —
these are stripped before the call.

How to set up:
  Option A (env var): Extract token from auth.json and set:
    export CHATGPT_ACCESS_TOKEN=$(jq -r '.tokens.access_token' ~/.codex/auth.json)

  Option B (auto-discovery): Set CHATGPT_TOKEN_DIR=~/.codex in .env
    LiteLLM reads auth.json from that directory automatically.

  Option C (codex login): Run `codex login` once — Nova auto-reads the result.
"""
from __future__ import annotations

import json
import logging
import os
from pathlib import Path
from typing import AsyncIterator

import litellm
from app.providers.base import ModelProvider
from nova_contracts import (
    CompleteRequest,
    CompleteResponse,
    EmbedRequest,
    EmbedResponse,
    ModelCapability,
    StreamChunk,
    ToolCall,
)

log = logging.getLogger(__name__)

# Map Nova model IDs → LiteLLM chatgpt/ model strings
_MODEL_MAP = {
    "chatgpt/gpt-4o": "chatgpt/gpt-4o",
    "chatgpt/gpt-4o-mini": "chatgpt/gpt-4o-mini",
    "chatgpt/o3": "chatgpt/o3",
    "chatgpt/o4-mini": "chatgpt/o4-mini",
    # Codex-specific models
    "chatgpt/gpt-5.2-codex": "chatgpt/gpt-5.2-codex",
    "chatgpt/gpt-5.3-codex": "chatgpt/gpt-5.3-codex",
    # Allow bare shorthand
    "gpt-4o": "chatgpt/gpt-4o",
    "gpt-4o-mini": "chatgpt/gpt-4o-mini",
}
_DEFAULT_CHATGPT_MODEL = "chatgpt/gpt-4o"


def discover_chatgpt_token() -> str | None:
    """
    Discover the ChatGPT Plus/Pro JWT access token from env or codex auth file.
    Returns the JWT access_token, or None if not found.
    """
    # 1. Explicit env var
    token = os.environ.get("CHATGPT_ACCESS_TOKEN", "").strip()
    if token:
        log.info("ChatGPT subscription: using token from CHATGPT_ACCESS_TOKEN")
        return token

    # 2. CHATGPT_TOKEN_DIR — LiteLLM convention; we read the same file
    token_dir = os.environ.get("CHATGPT_TOKEN_DIR", "")
    auth_file = os.environ.get("CHATGPT_AUTH_FILE", "auth.json")
    if token_dir:
        path = Path(token_dir) / auth_file
        token = _read_codex_token(path)
        if token:
            return token

    # 3. Default codex location: ~/.codex/auth.json
    default_path = Path.home() / ".codex" / "auth.json"
    token = _read_codex_token(default_path)
    if token:
        return token

    return None


def _read_codex_token(path: Path) -> str | None:
    """Read the JWT access_token from a codex-format auth.json file."""
    if not path.exists():
        return None
    try:
        data = json.loads(path.read_text())
        token = data.get("tokens", {}).get("access_token", "")
        if token:
            log.info("ChatGPT subscription: using token from %s", path)
            return token
    except Exception as e:
        log.warning("Failed to read codex auth file %s: %s", path, e)
    return None


class ChatGPTSubscriptionProvider(ModelProvider):
    """
    Uses ChatGPT Plus/Pro subscription via LiteLLM's native chatgpt/ provider.
    Requires a JWT access_token from `codex login` or direct auth.json extraction.
    """

    def __init__(self, access_token: str | None = None, default_model: str = "chatgpt/gpt-4o"):
        self._access_token = access_token or discover_chatgpt_token()
        self._default_model = _MODEL_MAP.get(default_model, _DEFAULT_CHATGPT_MODEL)

        if self._access_token:
            # Tell LiteLLM where to find the token dir if using file-based auth
            token_dir = os.environ.get("CHATGPT_TOKEN_DIR", str(Path.home() / ".codex"))
            os.environ.setdefault("CHATGPT_TOKEN_DIR", token_dir)
            log.info("ChatGPT subscription provider initialized")
        else:
            log.warning(
                "ChatGPTSubscriptionProvider: no access token found. "
                "Run `codex login` or set CHATGPT_ACCESS_TOKEN."
            )

    def refresh_token(self) -> None:
        """Re-discover the access token (FU-009 — CHATGPT_ACCESS_TOKEN in the
        environment, or the codex auth file, may have changed at runtime)."""
        self._access_token = discover_chatgpt_token()

    @property
    def name(self) -> str:
        return "chatgpt-subscription"

    @property
    def capabilities(self) -> set[ModelCapability]:
        return {
            ModelCapability.chat,
            ModelCapability.streaming,
            ModelCapability.vision,
        }

    @property
    def is_available(self) -> bool:
        return bool(self._access_token)

    async def complete(self, request: CompleteRequest) -> CompleteResponse:
        self._assert_available()

        model = _MODEL_MAP.get(request.model, self._default_model)
        messages = [{"role": m.role, "content": m.content} for m in request.messages]

        # LiteLLM chatgpt/ provider rejects these fields — strip them
        kwargs = {
            "model": model,
            "messages": messages,
            "temperature": request.temperature,
            "stream": False,
            # Pass token via custom_llm_provider header — LiteLLM reads it
            "api_key": self._access_token,
        }

        response = await litellm.acompletion(**kwargs)
        choice = response.choices[0]
        usage = response.usage

        tool_calls: list[ToolCall] = []
        if hasattr(choice.message, "tool_calls") and choice.message.tool_calls:
            for tc in choice.message.tool_calls:
                tool_calls.append(ToolCall(
                    id=tc.id,
                    name=tc.function.name,
                    arguments=json.loads(tc.function.arguments or "{}"),
                ))

        return CompleteResponse(
            content=choice.message.content or "",
            model=response.model or model,
            tool_calls=tool_calls,
            input_tokens=usage.prompt_tokens if usage else 0,
            output_tokens=usage.completion_tokens if usage else 0,
            cost_usd=None,  # subscription billing — no per-token cost to track
            finish_reason=choice.finish_reason or "stop",
        )

    async def stream(self, request: CompleteRequest) -> AsyncIterator[StreamChunk]:
        self._assert_available()

        model = _MODEL_MAP.get(request.model, self._default_model)
        messages = [{"role": m.role, "content": m.content} for m in request.messages]

        response = await litellm.acompletion(
            model=model,
            messages=messages,
            temperature=request.temperature,
            stream=True,
            stream_options={"include_usage": True},
            api_key=self._access_token,
        )

        async for chunk in response:
            choice = chunk.choices[0] if chunk.choices else None
            content = ""
            finish_reason = None
            if choice:
                content = choice.delta.content or ""
                finish_reason = choice.finish_reason

            # Extract usage from final chunk (sent by LiteLLM when include_usage=True)
            input_tokens = None
            output_tokens = None
            cost = None
            usage = getattr(chunk, "usage", None)
            if usage:
                input_tokens = getattr(usage, "prompt_tokens", None)
                output_tokens = getattr(usage, "completion_tokens", None)

            yield StreamChunk(
                delta=content,
                finish_reason=finish_reason,
                input_tokens=input_tokens,
                output_tokens=output_tokens,
                cost_usd=cost,
            )

    async def embed(self, request: EmbedRequest) -> EmbedResponse:
        raise NotImplementedError(
            "ChatGPT subscription does not expose embeddings via this provider. "
            "Use nomic-embed-text (Ollama), text-embedding-004 (Gemini), "
            "or text-embedding-3-small (OpenAI API key)."
        )
