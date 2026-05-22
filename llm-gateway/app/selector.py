"""Provider routing: given a strategy, return ordered (litellm_model, extra_kwargs) candidates."""
from .config import settings

_routing_strategy_override: str | None = None

VALID_STRATEGIES = frozenset({"local-first", "local-only", "cloud-first", "cloud-only"})


def get_routing_strategy() -> str:
    return _routing_strategy_override or settings.routing_strategy


def set_routing_strategy(strategy: str | None) -> None:
    global _routing_strategy_override
    _routing_strategy_override = strategy


def _local_candidate() -> tuple[str, dict] | None:
    """Return (litellm_model, extra_kwargs) for the active local backend, or None."""
    backend = settings.nova_inference_backend
    url = settings.local_inference_url
    model = settings.local_completion_model

    if backend == "none":
        return None
    if backend in ("ollama-host", "ollama"):
        return (f"ollama_chat/{model}", {"api_base": url})
    if backend in ("llamacpp", "vllm", "sglang", "lmstudio"):
        # All other backends speak the OpenAI-compatible API
        # LiteLLM requires a non-empty api_key for openai/ routes; "none" is a safe sentinel
        return (f"openai/{model}", {"api_base": url, "api_key": "none"})
    return None


def _local_embed_candidate() -> tuple[str, dict] | None:
    backend = settings.nova_inference_backend
    url = settings.local_inference_url
    model = settings.local_embed_model

    if backend == "none":
        return None
    if backend in ("ollama-host", "ollama"):
        return (f"ollama/{model}", {"api_base": url})
    # Other backends: no embedding support (use cloud fallback)
    return None


def completion_candidates(available_cloud: set[str]) -> list[tuple[str, dict]]:
    local = _local_candidate()
    cloud: list[tuple[str, dict]] = []
    if "anthropic" in available_cloud:
        cloud.append(("claude-haiku-4-5-20251001", {}))
    if "openai" in available_cloud:
        cloud.append(("gpt-4o-mini", {}))
    if "gemini" in available_cloud:
        cloud.append(("gemini/gemini-2.5-flash", {}))
    if "groq" in available_cloud:
        cloud.append(("groq/llama3-8b-8192", {}))

    strategy = get_routing_strategy()
    if strategy == "local-only":
        return [local] if local else []
    if strategy == "cloud-only":
        return cloud
    if strategy == "local-first":
        return ([local] if local else []) + cloud
    if strategy == "cloud-first":
        return cloud + ([local] if local else [])
    return ([local] if local else []) + cloud


def embed_candidates(available_cloud: set[str]) -> list[tuple[str, dict]]:
    local = _local_embed_candidate()
    cloud_openai: tuple[str, dict] | None = (
        ("text-embedding-3-small", {}) if "openai" in available_cloud else None
    )

    strategy = get_routing_strategy()
    if strategy == "local-only":
        return [local] if local else []
    if strategy == "cloud-only":
        return [cloud_openai] if cloud_openai else []
    if strategy == "local-first":
        return [c for c in [local, cloud_openai] if c is not None]
    if strategy == "cloud-first":
        return [c for c in [cloud_openai, local] if c is not None]
    return [c for c in [local, cloud_openai] if c is not None]
