"""Configuration management."""

import logging
from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    """App settings from environment."""

    database_url: str = "postgresql://nova:nova-dev-password@postgres:5432/nova"

    # LLM providers
    openrouter_api_key: str = ""
    openrouter_base_url: str = "https://openrouter.ai/api/v1"
    ollama_base_url: str = "http://host.docker.internal:11434"
    default_model: str = "openrouter:anthropic/claude-haiku-4.5"
    # Model used when OpenRouter is not configured and an agent asks for an openrouter: model
    local_fallback_model: str = "llama3.2"

    # Agent loop
    max_tool_rounds: int = 6

    # Web search (bundled SearXNG primary; keyless DDG fallback lives in code)
    searxng_url: str = "http://searxng:8080"

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
