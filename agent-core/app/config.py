# agent-core/app/config.py
from pydantic import AliasChoices, Field, field_validator
from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    database_url: str
    redis_url: str = "redis://localhost:6379"
    credential_master_key: str = ""
    admin_secret: str = Field(
        default="nova-dev-secret",
        validation_alias=AliasChoices("NOVA_ADMIN_SECRET", "ADMIN_SECRET", "admin_secret"),
    )
    log_level: str = "INFO"
    nova_workspace: str = "/workspace"
    memory_service_url: str = "http://memory-service:8002"
    llm_gateway_url: str = "http://llm-gateway:8001"
    docker_socket_proxy_url: str = "http://docker-socket-proxy:2375"

    @field_validator("credential_master_key")
    @classmethod
    def key_must_not_be_empty_if_set(cls, v: str) -> str:
        if v and len(v) < 32:
            raise ValueError("CREDENTIAL_MASTER_KEY must be at least 32 characters")
        return v

    class Config:
        env_file = ".env"


settings = Settings()
