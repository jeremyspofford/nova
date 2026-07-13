"""Ollama LLM client."""

import json
import logging
from typing import AsyncIterator
import httpx

log = logging.getLogger(__name__)


class OllamaClient:
    """Ollama API client for streaming chat."""

    def __init__(self, base_url: str):
        self.base_url = base_url.rstrip("/")

    async def stream(self, messages: list, model: str, tools: list | None = None) -> AsyncIterator[dict]:
        """Stream chat completion from Ollama."""
        payload = {
            "model": model,
            "messages": messages,
            "stream": True,
        }

        try:
            async with httpx.AsyncClient(timeout=180.0) as client:
                async with client.stream("POST", f"{self.base_url}/api/chat", json=payload) as response:
                    if response.status_code != 200:
                        error_text = await response.aread()
                        log.error(f"Ollama API error: {response.status_code} {error_text}")
                        yield {"error": f"Ollama API error: {response.status_code}"}
                        return

                    async for line in response.aiter_lines():
                        if not line.strip():
                            continue

                        try:
                            chunk = json.loads(line)
                            if "message" in chunk and "content" in chunk["message"]:
                                content = chunk["message"]["content"]
                                if content:
                                    yield {"type": "text", "text": content}

                            if chunk.get("done"):
                                yield {"type": "done"}
                                break
                        except json.JSONDecodeError:
                            log.warning(f"Failed to parse Ollama chunk: {line}")
        except httpx.ConnectError as e:
            log.error(f"Failed to connect to Ollama at {self.base_url}: {e}")
            yield {"error": f"Failed to connect to Ollama: {e}"}
