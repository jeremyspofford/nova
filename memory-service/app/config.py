# memory-service/app/config.py
from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    database_url: str
    redis_url: str = "redis://localhost:6379"
    log_level: str = "INFO"

    class Config:
        env_file = ".env"


settings = Settings()
