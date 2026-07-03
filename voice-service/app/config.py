from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    # Provider selection
    stt_provider: str = "openai"
    tts_provider: str = "openai"

    # Voice settings
    tts_voice: str = "nova"
    tts_model: str = "tts-1"

    # API keys
    openai_api_key: str = ""

    # Auth
    require_auth: bool = True
    nova_admin_secret: str = ""
    cors_allowed_origins: str = "http://localhost:3001,http://localhost:5173"

    # Limits
    max_audio_duration_seconds: int = 60
    max_tts_chars: int = 4096
    tts_rate_limit_per_minute: int = 120

    # Service
    redis_url: str = "redis://redis:6379/9"
    service_host: str = "0.0.0.0"
    service_port: int = 8130
    log_level: str = "INFO"


settings = Settings()
