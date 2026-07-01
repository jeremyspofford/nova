"""Cortex service configuration — reads from environment variables."""
import os


class Settings:
    port: int = 8100

    # Postgres (shared with orchestrator — same database)
    pg_host: str = os.getenv("POSTGRES_HOST", "postgres")
    pg_port: int = int(os.getenv("POSTGRES_PORT", "5432"))
    pg_user: str = os.getenv("POSTGRES_USER", "nova")
    pg_password: str = os.getenv("POSTGRES_PASSWORD", "nova_dev_password")
    pg_database: str = os.getenv("POSTGRES_DB", "nova")

    # Redis DB 5 (dedicated to cortex)
    redis_url: str = os.getenv("REDIS_URL", "redis://redis:6379/5")

    # Inter-service URLs
    orchestrator_url: str = os.getenv("ORCHESTRATOR_URL", "http://orchestrator:8000")
    llm_gateway_url: str = os.getenv("LLM_GATEWAY_URL", "http://llm-gateway:8001")
    memory_service_url: str = os.getenv("MEMORY_SERVICE_URL", "http://memory-service:8002")
    recovery_url: str = os.getenv("RECOVERY_URL", "http://recovery:8888")

    # Auth — cortex uses its own API key to talk to orchestrator
    admin_secret: str = os.getenv("NOVA_ADMIN_SECRET", "nova-admin-secret-change-me")
    # Trusted-network CIDRs for SEC-004 ingress auth. Empty = default list.
    trusted_network_cidrs: str = os.getenv("TRUSTED_NETWORK_CIDRS", "")
    # CORS allowlist — comma-separated origins. Wildcards are not accepted.
    cors_allowed_origins: str = os.getenv(
        "CORS_ALLOWED_ORIGINS",
        "http://localhost:3000,http://localhost:5173",
    )

    # Thinking cycle
    cycle_interval_seconds: int = int(os.getenv("CORTEX_CYCLE_INTERVAL", "300"))
    enabled: bool = os.getenv("CORTEX_ENABLED", "true").lower() == "true"

    # Adaptive intervals
    max_idle_interval: int = int(os.getenv("CORTEX_MAX_IDLE_INTERVAL", "1800"))
    active_interval: int = int(os.getenv("CORTEX_ACTIVE_INTERVAL", "30"))
    moderate_interval: int = int(os.getenv("CORTEX_MODERATE_INTERVAL", "60"))

    # Memory integration
    memory_enabled: bool = os.getenv("CORTEX_MEMORY_ENABLED", "true").lower() == "true"
    reflect_to_engrams: bool = os.getenv("CORTEX_REFLECT_TO_ENGRAMS", "true").lower() == "true"
    idle_consolidation: bool = os.getenv("CORTEX_IDLE_CONSOLIDATION", "true").lower() == "true"
    consolidation_cooldown: int = int(os.getenv("CORTEX_CONSOLIDATION_COOLDOWN", "1800"))

    # Task feedback loop
    task_poll_interval: int = int(os.getenv("CORTEX_TASK_POLL_INTERVAL", "10"))  # seconds between polls
    task_poll_max_wait: int = int(os.getenv("CORTEX_TASK_POLL_MAX_WAIT", "300"))  # max seconds to wait for task

    # Budget
    daily_budget_usd: float = float(os.getenv("CORTEX_DAILY_BUDGET_USD", "5.00"))

    # Well-known IDs from migration 021
    cortex_user_id: str = "a0000000-0000-0000-0000-000000000001"
    cortex_api_key: str = "sk-nova-cortex-internal"
    journal_conversation_id: str = "c0000000-0000-0000-0000-000000000001"

    # Model selection for Cortex's own LLM calls. Defaults to qwen2.5:7b — a
    # reliable local tool-calling model present on the host ollama — so the
    # brain works out of the box (matches the orchestrator default_model).
    # Override via env for a stronger model, e.g. qwen3.5:9b or hermes3:8b.
    # NOTE: the previous "" default sent an empty model to the gateway, which
    # 404'd at ollama's /api/chat and failed every cycle.
    planning_model: str = os.getenv("CORTEX_PLANNING_MODEL", "qwen2.5:7b")
    reflection_model: str = os.getenv("CORTEX_REFLECTION_MODEL", "qwen2.5:7b")

    # Learning from experience
    stuck_threshold_min: int = int(os.getenv("CORTEX_STUCK_THRESHOLD_MIN", "3"))
    lesson_extraction_min_tier: str = os.getenv("CORTEX_LESSON_EXTRACTION_MIN_TIER", "mid")

    # Logging
    log_level: str = os.getenv("LOG_LEVEL", "INFO")

    @property
    def pg_dsn(self) -> str:
        return f"postgresql://{self.pg_user}:{self.pg_password}@{self.pg_host}:{self.pg_port}/{self.pg_database}"


settings = Settings()
