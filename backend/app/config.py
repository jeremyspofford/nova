"""Configuration management."""

import logging
from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    """App settings from environment."""

    database_url: str = "postgresql://nova:nova-dev-password@postgres:5432/nova"
    openrouter_api_key: str = ""
    ollama_base_url: str = "http://host.docker.internal:11434"
    okf_memory_dir: str = "./data/memory"
    log_level: str = "INFO"

    class Config:
        env_file = ".env"
        case_sensitive = False

    def get_log_level(self):
        """Get logging level."""
        try:
            return getattr(logging, self.log_level.upper())
        except AttributeError:
            return logging.INFO


settings = Settings()
