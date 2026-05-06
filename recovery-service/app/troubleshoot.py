"""AI troubleshooting — calls an external LLM directly, bypassing llm-gateway."""

import json
import logging
import os
import urllib.error
import urllib.request

from pydantic import BaseModel

from .docker_client import get_container_logs, list_service_status

logger = logging.getLogger("nova.recovery.troubleshoot")

SYSTEM_PROMPT = """\
You are Nova's AI troubleshooter, embedded in the Recovery Service. Nova is a self-directed \
autonomous AI platform running as a Docker Compose stack.

Services:
- postgres (5432): pgvector-enabled PostgreSQL 16 — stores all data
- redis (6379): task queue (BRPOP), rate limiting, session memory
- orchestrator (8000): agent lifecycle, task queue, pipeline execution, DB migrations
- llm-gateway (8001): multi-provider model routing via LiteLLM
- memory-service (8002): embedding + hybrid semantic/keyword retrieval via pgvector
- chat-api (8080): WebSocket streaming bridge
- dashboard (3000/5173): React admin UI
- recovery (8888): backup/restore, service management (this service — always alive)

Common issues:
- Orchestrator crash-looping: usually a failed migration in orchestrator/app/migrations/*.sql
- LLM gateway unhealthy: missing or invalid API keys in Settings → AI & Models → Provider Status
- Memory service down: pgvector extension not installed, or postgres not ready
- All services down: postgres or redis failed to start

You have access to live diagnostics including service status and recent logs from failing services.
Be specific and actionable. Suggest concrete recovery steps like:
- "Restart the orchestrator service"
- "Restore from the latest checkpoint backup"
- "Set ANTHROPIC_API_KEY in Settings → AI & Models → Provider Status"

Keep responses concise and focused on the immediate problem."""


class ChatMessage(BaseModel):
    role: str
    content: str


class TroubleshootRequest(BaseModel):
    message: str
    history: list[ChatMessage] = []


def _read_env_key(key: str) -> str:
    """Read a single key from the .env file."""
    env_file = os.getenv("NOVA_ENV_FILE", "/project/.env")
    try:
        with open(env_file) as f:
            for line in f:
                line = line.strip()
                if line.startswith(f"{key}="):
                    value = line.split("=", 1)[1].strip()
                    if len(value) >= 2 and value[0] == value[-1] and value[0] in ('"', "'"):
                        value = value[1:-1]
                    return value
    except FileNotFoundError:
        pass
    return ""


def _check_ollama(base_url: str) -> bool:
    """Quick check if Ollama is reachable."""
    try:
        urllib.request.urlopen(f"{base_url}/api/tags", timeout=3)
        return True
    except Exception:
        return False


def _find_provider() -> tuple[str, str, str, str] | None:
    """Find the best available LLM provider.
    Returns (provider, key, model, base_url) or None.
    Priority: local Ollama (free) → Anthropic → OpenAI → Groq.
    """
    # Try local Ollama first (free, no API cost)
    ollama_url = _read_env_key("OLLAMA_BASE_URL") or "http://ollama:11434"
    ollama_model = _read_env_key("DEFAULT_OLLAMA_MODEL") or "llama3.2"
    if _check_ollama(ollama_url):
        return "ollama", "", ollama_model, ollama_url

    # Cloud providers: most capable first
    providers = [
        ("ANTHROPIC_API_KEY", "anthropic", "claude-sonnet-4-20250514", ""),
        ("OPENAI_API_KEY", "openai", "gpt-4o", "https://api.openai.com/v1"),
        ("GROQ_API_KEY", "groq", "llama-3.3-70b-versatile", "https://api.groq.com/openai/v1"),
    ]
    for env_var, provider, model, base_url in providers:
        key = _read_env_key(env_var)
        if key:
            return provider, key, model, base_url
    return None


def _build_diagnostics_context() -> str:
    """Gather live diagnostics to include in the system prompt."""
    services = list_service_status()
    lines = ["## Current Service Status"]
    for svc in services:
        status_str = f"{svc['status']} ({svc['health']})"
        lines.append(f"- {svc['service']}: {status_str}")

    # Get logs from unhealthy services
    unhealthy = [
        s for s in services
        if s["status"] != "running" or s["health"] not in ("healthy", "none")
    ]
    if unhealthy:
        lines.append("\n## Recent Logs from Failing Services")
        for svc in unhealthy:
            logs = get_container_logs(svc["service"], tail=30)
            lines.append(f"\n### {svc['service']}")
            lines.append(f"```\n{logs[:3000]}\n```")

    return "\n".join(lines)


def _call_anthropic(api_key: str, model: str, system: str, messages: list[dict]) -> str:
    """Call Anthropic API directly via urllib."""
    payload = {
        "model": model,
        "max_tokens": 1024,
        "system": system,
        "messages": messages,
    }
    req = urllib.request.Request(
        "https://api.anthropic.com/v1/messages",
        data=json.dumps(payload).encode(),
        headers={
            "Content-Type": "application/json",
            "x-api-key": api_key,
            "anthropic-version": "2023-06-01",
        },
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        data = json.loads(resp.read())
    return data["content"][0]["text"]


def _call_openai_compatible(api_key: str, model: str, system: str, messages: list[dict], base_url: str) -> str:
    """Call OpenAI-compatible API directly via urllib."""
    full_messages = [{"role": "system", "content": system}] + messages
    payload = {
        "model": model,
        "max_tokens": 1024,
        "messages": full_messages,
    }
    headers = {"Content-Type": "application/json"}
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"
    req = urllib.request.Request(
        f"{base_url}/chat/completions",
        data=json.dumps(payload).encode(),
        headers=headers,
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        data = json.loads(resp.read())
    return data["choices"][0]["message"]["content"]


async def troubleshoot_chat(req: TroubleshootRequest) -> dict:
    """Process a troubleshooting chat message by calling an external LLM."""
    provider_info = _find_provider()
    if not provider_info:
        return {
            "response": "No LLM provider available. Either start Ollama, or add ANTHROPIC_API_KEY, OPENAI_API_KEY, or GROQ_API_KEY in Settings → AI & Models → Provider Status to enable AI troubleshooting.",
            "provider": None,
        }

    provider, api_key, model, base_url = provider_info
    diagnostics = _build_diagnostics_context()
    system = f"{SYSTEM_PROMPT}\n\n{diagnostics}"

    messages = [{"role": m.role, "content": m.content} for m in req.history]
    messages.append({"role": "user", "content": req.message})

    try:
        if provider == "anthropic":
            response = _call_anthropic(api_key, model, system, messages)
        elif provider in ("openai", "groq", "ollama"):
            llm_base = f"{base_url}/v1" if provider == "ollama" else base_url
            response = _call_openai_compatible(api_key, model, system, messages, llm_base)
        else:
            response = "Unsupported provider"
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", errors="replace")[:500]
        logger.warning("LLM API error (%s): %s %s", provider, e.code, body)
        response = f"LLM API error ({provider}): {e.code}. Check that your API key is valid."
    except Exception as e:
        logger.warning("Troubleshoot LLM call failed: %s", e)
        response = f"Failed to reach {provider} API: {e}"

    return {"response": response, "provider": provider}
