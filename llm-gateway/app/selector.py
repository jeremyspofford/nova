"""Provider routing: given a strategy, return ordered (litellm_model, extra_kwargs) candidates."""
from .config import settings


def completion_candidates(available_cloud: set[str]) -> list[tuple[str, dict]]:
    local = (
        f"ollama_chat/{settings.ollama_completion_model}",
        {"api_base": settings.ollama_base_url},
    )
    cloud: list[tuple[str, dict]] = []
    if "anthropic" in available_cloud:
        cloud.append(("claude-haiku-4-5-20251001", {}))
    if "openai" in available_cloud:
        cloud.append(("gpt-4o-mini", {}))

    strategy = settings.routing_strategy
    if strategy == "local-only":
        return [local]
    if strategy == "cloud-only":
        return cloud
    if strategy == "local-first":
        return [local] + cloud
    if strategy == "cloud-first":
        return cloud + [local]
    return [local] + cloud


def embed_candidates(available_cloud: set[str]) -> list[tuple[str, dict]]:
    local = (
        f"ollama/{settings.ollama_embed_model}",
        {"api_base": settings.ollama_base_url},
    )
    cloud_openai: tuple[str, dict] | None = (
        ("text-embedding-3-small", {}) if "openai" in available_cloud else None
    )

    strategy = settings.routing_strategy
    if strategy == "local-only":
        return [local]
    if strategy == "cloud-only":
        return [cloud_openai] if cloud_openai else []
    if strategy == "local-first":
        return [c for c in [local, cloud_openai] if c is not None]
    if strategy == "cloud-first":
        return [c for c in [cloud_openai, local] if c is not None]
    return [c for c in [local, cloud_openai] if c is not None]
