from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    service_host: str = "0.0.0.0"
    service_port: int = 8150
    log_level: str = "INFO"

    # Persistent per-domain browser profiles (logins survive restarts).
    profiles_dir: str = "/data/browser-profiles"

    # Session lifecycle
    session_idle_timeout_seconds: int = 600  # reap sessions idle this long
    session_max_seconds: int = 3600          # hard cap per session
    max_concurrent_sessions: int = 4
    nav_timeout_ms: int = 30000
    headless: bool = True

    # Admin auth (SEC-004) — same pattern as the other workers.
    nova_admin_secret: str = ""
    trusted_network_cidrs: str = ""

    redis_url: str = "redis://redis:6379/11"
    orchestrator_url: str = "http://orchestrator:8000"


settings = Settings()
