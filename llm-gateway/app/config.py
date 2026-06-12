from pydantic import AliasChoices, Field, field_validator, model_validator
from pydantic_settings import BaseSettings

_OLLAMA_HOST_URL = "http://host.docker.internal:11434"

_BACKEND_DEFAULT_URLS: dict[str, str] = {
    "ollama-host": _OLLAMA_HOST_URL,
    "ollama": "http://nova-ollama:11434",
    "llamacpp": "http://nova-llamacpp:8080",
    "vllm": "http://nova-vllm:8000",
    "sglang": "http://nova-sglang:30000",
    "lmstudio": "http://host.docker.internal:1234",
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
    local_completion_model: str = Field(
        default="llama3.2",
        validation_alias=AliasChoices("LOCAL_COMPLETION_MODEL", "DEFAULT_OLLAMA_MODEL", "local_completion_model"),
    )
    local_embed_model: str = "nomic-embed-text"
    routing_strategy: str = Field(
        default="local-first",
        validation_alias=AliasChoices("LLM_ROUTING_STRATEGY", "routing_strategy"),
    )
    log_level: str = "INFO"
    port: int = 8001
    # Recommended-models manifest + hardware profile (runtime dir is volume-mounted).
    runtime_dir: str = "/app/runtime"
    manifest_url: str = (
        "https://raw.githubusercontent.com/jeremyspofford/nova/main/"
        "llm-gateway/data/recommended_models.json"
    )
    manifest_refresh_s: int = 86400
    # Wake-on-LAN for a sleeping inference host. MAC lives in the secrets vault
    # ('wol_mac'); these tune delivery. Helper URL points at the host-network
    # wol-helper sidecar (compose profile `wol`).
    wol_broadcast_addr: str = "255.255.255.255"
    wol_port: int = 9
    wol_helper_url: str = ""
    wol_min_interval_s: int = 300
    # Council mode (Mixture-of-Agents): proposer seats, total wall-clock cap,
    # and proposal concurrency (drop to 1 on CPU-only or RAM-tight inference
    # hosts — parallel generations can crash a constrained llama runner).
    council_proposers: int = 3
    council_wall_s: int = 300
    council_parallel: int = 3
    # Quality floor for proposers (manifest agent+reasoning sum). Models below it
    # never propose — weak members poison the chair.
    council_min_score: int = 5

    @field_validator("local_inference_url")
    @classmethod
    def resolve_inference_url(cls, v: str) -> str:
        if v in ("auto", "host"):
            return _OLLAMA_HOST_URL
        return v

    @model_validator(mode="after")
    def auto_resolve_url_from_backend(self) -> "Settings":
        """If local_inference_url is still the Ollama default but backend isn't Ollama, use backend's default URL."""
        if (
            self.local_inference_url == _OLLAMA_HOST_URL
            and self.nova_inference_backend in _BACKEND_DEFAULT_URLS
            and self.nova_inference_backend not in ("ollama-host", "ollama")
        ):
            self.local_inference_url = _BACKEND_DEFAULT_URLS[self.nova_inference_backend]
        return self

    class Config:
        env_file = ".env"


settings = Settings()
