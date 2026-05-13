from pydantic import AliasChoices, Field, field_validator
from pydantic_settings import BaseSettings

_OLLAMA_HOST_URL = "http://host.docker.internal:11434"

_BACKEND_DEFAULT_URLS = {
    "ollama-host": _OLLAMA_HOST_URL,
    "ollama": "http://nova-ollama:11434",
    "llamacpp": "http://nova-llamacpp:8080",
    "vllm": "http://nova-vllm:8000",
    "sglang": "http://nova-sglang:30000",
}

VALID_BACKENDS = frozenset(
    {"ollama-host", "ollama", "llamacpp", "vllm", "sglang", "lmstudio", "none"}
)


class Settings(BaseSettings):
    agent_core_url: str = "http://agent-core:8000"
    admin_secret: str = Field(
        default="nova-dev-secret",
        validation_alias=AliasChoices("NOVA_ADMIN_SECRET", "ADMIN_SECRET", "admin_secret"),
    )
    nova_inference_backend: str = "ollama-host"
    local_inference_url: str = _OLLAMA_HOST_URL
    local_completion_model: str = "llama3.2"
    local_embed_model: str = "nomic-embed-text"
    routing_strategy: str = Field(
        default="local-first",
        validation_alias=AliasChoices("LLM_ROUTING_STRATEGY", "routing_strategy"),
    )
    log_level: str = "INFO"
    port: int = 8001

    @field_validator("local_inference_url")
    @classmethod
    def resolve_inference_url(cls, v: str) -> str:
        if v in ("auto", "host"):
            return _OLLAMA_HOST_URL
        return v

    class Config:
        env_file = ".env"


settings = Settings()
