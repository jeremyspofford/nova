from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    agent_core_url: str = "http://agent-core:8000"
    admin_secret: str = "nova-dev-secret"
    ollama_base_url: str = "http://host.docker.internal:11434"
    ollama_completion_model: str = "llama3.1"
    ollama_embed_model: str = "nomic-embed-text"
    routing_strategy: str = "local-first"  # local-first | local-only | cloud-first | cloud-only
    log_level: str = "INFO"
    port: int = 8001

    class Config:
        env_file = ".env"


settings = Settings()
