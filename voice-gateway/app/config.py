from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    agent_core_url: str = "http://agent-core:8000"
    admin_secret: str = "nova-dev-secret"
    stt_provider: str = "openai-whisper"
    tts_provider: str = "openai-tts"
    tts_default_voice: str = "nova"
    log_level: str = "INFO"
    port: int = 8003

    class Config:
        env_file = ".env"


settings = Settings()
