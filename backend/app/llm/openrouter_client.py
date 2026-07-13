"""OpenRouter LLM client."""

import json
import logging
from typing import AsyncIterator
import httpx

log = logging.getLogger(__name__)


class OpenRouterClient:
    """OpenRouter API client for streaming chat."""

    def __init__(self, api_key: str):
        self.api_key = api_key
        self.base_url = "https://openrouter.io/api/v1"

    async def stream(self, messages: list, model: str, tools: list | None = None) -> AsyncIterator[dict]:
        """Stream chat completion from OpenRouter."""
        headers = {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json",
        }

        payload = {
            "model": model,
            "messages": messages,
            "stream": True,
        }

        if tools:
            payload["tools"] = tools

        async with httpx.AsyncClient(timeout=60.0) as client:
            async with client.stream("POST", f"{self.base_url}/chat/completions", json=payload, headers=headers) as response:
                if response.status_code != 200:
                    error_text = await response.aread()
                    log.error(f"OpenRouter API error: {response.status_code} {error_text}")
                    yield {"error": f"OpenRouter API error: {response.status_code}"}
                    return

                async for line in response.aiter_lines():
                    if not line.strip() or line.startswith(":"):
                        continue

                    if line.startswith("data: "):
                        data = line[6:]

                        if data == "[DONE]":
                            yield {"type": "done"}
                            break

                        try:
                            chunk = json.loads(data)
                            if chunk.get("choices"):
                                delta = chunk["choices"][0].get("delta", {})
                                if "content" in delta and delta["content"]:
                                    yield {"type": "text", "text": delta["content"]}
                                if "tool_calls" in delta:
                                    for tool_call in delta["tool_calls"]:
                                        yield {"type": "tool_call", "tool_call": tool_call}
                        except json.JSONDecodeError:
                            log.warning(f"Failed to parse OpenRouter chunk: {data}")
