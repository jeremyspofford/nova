# memory-service/app/config.py
from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    database_url: str
    redis_url: str = "redis://redis:6379"
    llm_gateway_url: str = "http://llm-gateway:8001"
    log_level: str = "INFO"
    port: int = 8002

    class Config:
        env_file = ".env"


settings = Settings()
