from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    # Redis
    redis_url: str = "redis://redis:6379/0"

    # Orchestrator (used by feature-flags SDK to warm cache + receive
    # pubsub-driven invalidations; not on the memory hot path).
    orchestrator_url: str = "http://orchestrator:8000"

    # Memory backend selection — which storage engine serves /api/v1/memory/*.
    # Runtime override: Redis db1 nova:config:memory.backend (dashboard-set).
    # "okf" (OKF markdown bundle) is the only built-in backend.
    memory_backend: str = "okf"

    # OKF markdown backend — bundle lives in the shared Nova workspace so
    # agent file tools (orchestrator mounts the same host dir) and humans
    # see the exact same files.
    okf_memory_dir: str = "/workspace/memory"
    okf_context_top_k: int = 8
    okf_context_max_chars: int = 16000  # ≈4k tokens
    okf_journal_retention_days: int = 45

    # Ingestion queue (producers: chat, intel, knowledge, cortex)
    ingestion_enabled: bool = True
    ingestion_queue: str = "memory:ingestion:queue"
    ingestion_batch_timeout: float = 1.0  # BLMOVE timeout in seconds

    # Service
    service_host: str = "0.0.0.0"
    service_port: int = 8002
    log_level: str = "INFO"

    # Admin auth (SEC-004) — same pattern as llm-gateway + orchestrator.
    # Redis-backed rotatable secret + trusted-network bypass.
    nova_admin_secret: str = ""
    trusted_network_cidrs: str = ""  # empty = default list from nova_worker_common


settings = Settings()
