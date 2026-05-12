# agent-core/app/config.py
from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    database_url: str
    redis_url: str = "redis://localhost:6379"
    credential_master_key: str = ""
    log_level: str = "INFO"
    nova_workspace: str = "/workspace"

    class Config:
        env_file = ".env"


settings = Settings()
