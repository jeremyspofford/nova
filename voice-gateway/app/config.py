from pydantic import AliasChoices, Field
from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    agent_core_url: str = "http://agent-core:8000"
    admin_secret: str = Field(
        default="nova-dev-secret",
        validation_alias=AliasChoices("NOVA_ADMIN_SECRET", "ADMIN_SECRET", "admin_secret"),
    )
    stt_provider: str = "openai-whisper"
    tts_provider: str = "openai-tts"
    tts_default_voice: str = "nova"
    log_level: str = "INFO"
    port: int = 8003

    class Config:
        env_file = ".env"


settings = Settings()
