"""HTTP client for llm-gateway. Used by the agent loop for LLM calls."""
import json
import logging
from typing import AsyncIterator

import httpx

from .config import settings

logger = logging.getLogger(__name__)


async def complete(
    messages: list[dict],
    model: str = "auto",
    max_tokens: int = 2000,
    temperature: float = 0.7,
) -> str | None:
    """Single completion. Returns content string, or None on failure."""
    try:
        async with httpx.AsyncClient(timeout=120.0) as client:
            r = await client.post(
                f"{settings.llm_gateway_url}/complete",
                json={
                    "messages": messages,
                    "model": model,
                    "max_tokens": max_tokens,
                    "temperature": temperature,
                },
            )
            r.raise_for_status()
            return r.json()["content"]
    except Exception as exc:
        logger.warning("llm_client.complete failed: %s", exc)
        return None


async def stream(
    messages: list[dict],
    model: str = "auto",
    max_tokens: int = 2000,
    temperature: float = 0.7,
) -> "AsyncIterator[str] | None":
    """Streaming completion. Returns None on connection failure; yields text chunks otherwise.

    Usage::

        it = await llm_client.stream(messages)
        if it is None:
            # gateway unreachable
        else:
            async for chunk in it:
                ...
    """
    try:
        client = httpx.AsyncClient(timeout=120.0)
        response = await client.send(
            client.build_request(
                "POST",
                f"{settings.llm_gateway_url}/stream",
                json={
                    "messages": messages,
                    "model": model,
                    "max_tokens": max_tokens,
                    "temperature": temperature,
                },
            ),
            stream=True,
        )
        response.raise_for_status()
    except Exception as exc:
        logger.warning("llm_client.stream failed: %s", exc)
        return None

    return _stream_lines(response, client)


async def _stream_lines(
    response: httpx.Response, client: httpx.AsyncClient
) -> AsyncIterator[str]:
    """Iterate SSE lines from an already-open streaming response."""
    try:
        async for line in response.aiter_lines():
            if line.startswith("data: "):
                data = json.loads(line[6:])
                if data.get("chunk"):
                    yield data["chunk"]
                if data.get("done"):
                    return
    except Exception as exc:
        logger.warning("llm_client.stream error during iteration: %s", exc)
    finally:
        await response.aclose()
        await client.aclose()


async def embed(text: str, model: str = "auto") -> list[float] | None:
    """Embed a text string. Returns None on failure."""
    try:
        async with httpx.AsyncClient(timeout=30.0) as client:
            r = await client.post(
                f"{settings.llm_gateway_url}/embed",
                json={"input": text, "model": model},
            )
            r.raise_for_status()
            return r.json()["embedding"]
    except Exception as exc:
        logger.warning("llm_client.embed failed: %s", exc)
        return None
