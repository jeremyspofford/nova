from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    # Auth
    require_auth: bool = True
    nova_admin_secret: str = ""
    cors_allowed_origins: str = "http://localhost:3001,http://localhost:5173"

    # Service
    redis_url: str = "redis://redis:6379/10"
    redis_password: str = ""
    service_host: str = "0.0.0.0"
    service_port: int = 8140
    log_level: str = "INFO"


settings = Settings()
