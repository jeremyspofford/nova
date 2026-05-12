# voice-gateway/app/config.py
from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    log_level: str = "INFO"

    class Config:
        env_file = ".env"


settings = Settings()
