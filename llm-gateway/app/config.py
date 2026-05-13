from pydantic import field_validator
from pydantic_settings import BaseSettings

_OLLAMA_HOST_URL = "http://host.docker.internal:11434"


class Settings(BaseSettings):
    agent_core_url: str = "http://agent-core:8000"
    admin_secret: str = "nova-dev-secret"
    ollama_base_url: str = _OLLAMA_HOST_URL
    ollama_completion_model: str = "llama3.2"
    ollama_embed_model: str = "nomic-embed-text"
    routing_strategy: str = "local-first"  # local-first | local-only | cloud-first | cloud-only
    log_level: str = "INFO"
    port: int = 8001

    @field_validator("ollama_base_url")
    @classmethod
    def resolve_ollama_url(cls, v: str) -> str:
        """Treat 'auto' and 'host' as aliases for host.docker.internal."""
        if v in ("auto", "host"):
            return _OLLAMA_HOST_URL
        return v

    class Config:
        env_file = ".env"


settings = Settings()
