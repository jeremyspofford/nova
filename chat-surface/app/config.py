# chat-surface/app/config.py
from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    agent_core_url: str = "http://localhost:8000"
    log_level: str = "INFO"

    class Config:
        env_file = ".env"


settings = Settings()
