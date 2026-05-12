from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    agent_core_url: str = "http://agent-core:8000"
    voice_gateway_url: str = "http://voice-gateway:8003"
    redis_url: str = "redis://redis:6379/3"
    log_level: str = "INFO"

    class Config:
        env_file = ".env"
        extra = "ignore"


settings = Settings()
