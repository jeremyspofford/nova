"""Configuration management."""

import logging
from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    """App settings from environment."""

    database_url: str = "postgresql://nova:nova-dev-password@postgres:5432/nova"

    # Auth: empty = open (localhost-only dev). Set NOVA_AUTH_TOKEN before
    # exposing beyond localhost (tailscale serve, tunnels) — every /api/*
    # request must then carry Authorization: Bearer <token>.
    nova_auth_token: str = ""
    # With a token set, requests from THIS machine stay tokenless (the token
    # exists for remote devices). Set false if a host-side public tunnel
    # points at :8080 — the tunnel's requests look local.
    nova_trust_localhost: bool = True

    # LLM providers
    openrouter_api_key: str = ""
    openrouter_base_url: str = "https://openrouter.ai/api/v1"
    # Default cloud model: cheaper than haiku-4.5 ($0.93/$2.92 vs $1/$5 per M),
    # 1M ctx, tools + parallel tool calls verified on OpenRouter (2026-07-14).
    default_model: str = "openrouter:z-ai/glm-5.2"
    # NOTE: ollama URL + local fallback model are runtime settings now
    # (Settings -> Inference), not env.

    # Bundled-inference control sidecar (the only holder of the docker
    # socket; fixed-verb start/stop/status API, compose network only)
    inference_control_url: str = "http://inference-control:9911"
    # The bundled ollama compose service, definitionally — status probes hit
    # this even when inference.ollama_url points at a host-run instance.
    bundled_ollama_url: str = "http://ollama:11434"

    # Agent loop
    max_tool_rounds: int = 6

    # NOTE: behavioral knobs (context budgets, compaction, automations) live
    # in the DB-backed settings store (settings_store.py) — UI-configured,
    # never env. Env here is infra bootstrap + secrets only.

    # Web search (bundled SearXNG primary; keyless DDG fallback lives in code)
    searxng_url: str = "http://searxng:8080"

    # Voice (optional `voice` compose profile; plan: docs/plans/voice.md)
    kokoro_url: str = "http://kokoro:8880"

    # Memory
    okf_memory_dir: str = "./data/memory"
    memory_context_max_chars: int = 4000
    memory_context_top_k: int = 5

    log_level: str = "INFO"

    class Config:
        env_file = ".env"
        case_sensitive = False

    def get_log_level(self):
        try:
            return getattr(logging, self.log_level.upper())
        except AttributeError:
            return logging.INFO

    def has_openrouter(self) -> bool:
        """True when a real (non-placeholder) OpenRouter key is configured."""
        key = self.openrouter_api_key
        return bool(key) and not key.startswith("sk-or-v1-your")


settings = Settings()
