from pydantic import AliasChoices, Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    redis_url: str = "redis://redis:6379/2"
    memory_service_url: str = "http://memory-service:8002"
    llm_gateway_url: str = "http://llm-gateway:8001"

    # qwen2.5:7b emits NATIVE Ollama tool_calls reliably (verified e2e). Avoid
    # models whose Ollama template lacks tool support (e.g. some qwen2.5-coder
    # builds emit tool calls as plain text) — they silently never act.
    default_model: str = "qwen2.5:7b"
    default_system_prompt: str = (
        "You are a helpful AI assistant with persistent memory. "
        "You remember previous conversations and can use tools to help users."
    )
    # The canonical agent that is auto-created (or adopted) on every startup.
    # Duplicates with the same name+model are pruned automatically.
    primary_agent_name: str = "Nova"

    # Context window budgets (from Part 3 token allocation research)
    context_system_pct: float = 0.10
    context_tools_pct: float = 0.15
    context_memory_pct: float = 0.40
    context_history_pct: float = 0.20
    context_working_pct: float = 0.15
    context_compaction_threshold: float = 0.80  # Trigger at 80% usage

    # Memory retrieval mode
    memory_retrieval_mode: str = "inject"  # "inject" (legacy 40%), "tools" (agent-driven). Switch via dashboard Settings or .env
    context_priming_pct: float = 0.05     # Domain awareness priming budget (small)

    service_host: str = "0.0.0.0"
    service_port: int = 8000
    log_level: str = "INFO"

    # Phase 2: Postgres connection for api_keys + usage_events tables
    database_url: str = "postgresql+asyncpg://nova:nova_dev_password@postgres:5432/nova"
    # Phase 2: Shared secret for admin key-management endpoints (X-Admin-Secret header)
    nova_admin_secret: str = "nova-admin-secret-change-me"
    # Phase 2: Set False in .env during local dev to skip API key validation entirely
    require_auth: bool = True
    cors_allowed_origins: str = "http://localhost:3001,http://localhost:5173,http://localhost:8080"

    # LLM gateway HTTP client timeout for completions. Generous default
    # because local CPU inference of mid-tier models (qwen2.5:7b) on
    # CPU-only hosts routinely needs 60-120s+ for context-stage prompts;
    # the prior 120s default produced empty timeouts. Override via env
    # (LLM_REQUEST_TIMEOUT_SECONDS) on GPU-fast local setups.
    llm_request_timeout_seconds: float = 600.0

    # Phase 3: Code & Terminal Tools
    workspace_root: str = "/workspace"
    shell_timeout_seconds: int = 30
    # Sandbox tier: workspace | home | isolated (root removed per SEC-001)
    shell_sandbox: str = "workspace"
    nova_root: str = "/nova"
    # HOME on the host — set via HOST_HOME env in docker-compose.yml.
    # Default "/root" is the container's root home; only correct if HOST_HOME is set.
    home_root: str = Field(default="/root", validation_alias=AliasChoices("HOST_HOME", "home_root"))

    # Phase 4: Task Queue + Failure Recovery
    # Running tasks write a heartbeat every N seconds
    task_heartbeat_interval_seconds: int = 30
    # Reaper wakes up every N seconds to scan for stale tasks
    reaper_interval_seconds: int = 60
    # A task is considered stale if no heartbeat for this many seconds
    task_stale_seconds: int = 150
    # Default maximum retries before a task goes to dead letter
    task_default_max_retries: int = 2
    # Tasks stuck in queued state longer than this are re-pushed
    stale_queued_seconds: int = 120
    # Extra buffer before declaring an agent session timed out
    session_timeout_buffer_seconds: int = 30
    # Utility model (used for conversation titles, etc.)
    session_summary_model: str = "claude-haiku-4-5-20251001"
    # Redis heartbeat key TTL — should be < task_stale_seconds
    task_heartbeat_ttl_seconds: int = 120
    # Default pod name used when no routing match is found
    default_pod_name: str = "Quartet"

    # Phase 4b: Memory context pre-warming for active chat sessions
    memory_prewarm_enabled: bool = True
    memory_prewarm_ttl_seconds: int = 60
    # Maximum number of pipeline executions that can run concurrently
    pipeline_max_concurrent: int = 5

    # Trusted networks — comma-separated CIDRs that bypass auth (treated as admin)
    # Default includes RFC1918 private ranges, Tailscale CGNAT, and localhost
    trusted_networks: str = "127.0.0.0/8,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16,100.64.0.0/10,::1/128"
    # Header containing the real client IP when behind a trusted reverse proxy
    # e.g. CF-Connecting-IP (Cloudflare), X-Real-IP (nginx), X-Forwarded-For
    trusted_proxy_header: str = ""

    # Self-knowledge: inject platform architecture/diagnostic guidance into chat prompts
    self_knowledge_enabled: bool = Field(
        default=True,
        validation_alias=AliasChoices("NOVA_SELF_KNOWLEDGE", "SELF_KNOWLEDGE_ENABLED"),
    )

    # Clarification loop
    clarification_max_rounds: int = 2
    clarification_timeout_hours: int = 24

    # User auth
    jwt_secret: str = ""  # Auto-generated if empty (stored in platform_config)
    google_client_id: str = ""
    google_client_secret: str = ""
    registration_mode: str = "invite"  # 'open' | 'invite' | 'admin'

    # Bridge service auth — shared secret for bridge-to-orchestrator trust (X-Service-Secret header)
    bridge_service_secret: str = ""

    # Capability credential vault — master key for AES-256-GCM envelope encryption
    # 64-character hex string (32 bytes).  Generate with:
    #   python -c "import os; print(os.urandom(32).hex())"
    # Shared with knowledge-worker via the same env var.
    credential_master_key: str = ""

    # GitHub API base URL — override in tests to point at fake-github boundary fake
    github_api_base_url: str = "https://api.github.com"

    # Self-modification (GitHub PR gate)
    nova_github_pat: str = ""
    nova_github_repo: str = ""
    nova_github_user: str = ""
    nova_github_email: str = ""
    selfmod_rate_limit_per_hour: int = 5
    selfmod_enabled: bool = False


settings = Settings()
