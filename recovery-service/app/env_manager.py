"""Safe .env file read/write with strict key whitelist."""

import logging
import os
import re

logger = logging.getLogger("nova.recovery.env")

# Only these keys can be read/written via the API.
# SEC-006a: secret-bearing keys (LLM provider keys, OAuth
# client secret, GitHub PAT for self-modification) live in `platform_secrets`
# now and must be managed via orchestrator's /api/v1/admin/secrets, NOT here.
# Keys that remain in this whitelist are infra/compose-time values that have
# to live in `.env` because Docker / sidecar containers consume them.
ENV_WHITELIST = {
    # Infra tunnels — consumed by sidecar containers at compose-up
    "CLOUDFLARE_TUNNEL_TOKEN",
    "TAILSCALE_AUTHKEY",
    # Compose / runtime config
    "COMPOSE_PROFILES",
    "COMPOSE_FILE",
    "CORS_ALLOWED_ORIGINS",
    "REQUIRE_AUTH",
    "TRUSTED_PROXY_HEADER",
    # OAuth client ID is non-secret and used by docker-compose env interpolation
    "GOOGLE_CLIENT_ID",
    "REGISTRATION_MODE",
    # Inference model/storage config (consumed by the bundled compose services)
    "VLLM_MODEL",
    "SGLANG_MODEL",
    "VLLM_GPU_MEMORY_UTILIZATION",
    "OLLAMA_MODELS_DIR",
    "HF_CACHE_DIR",
    "LLAMACPP_MODELS_DIR",
    "LLAMACPP_MODEL",
    # Inference mode (user-facing rollup of routing strategy + bundled service)
    "NOVA_INFERENCE_MODE",
    "OLLAMA_BASE_URL",
    # Self-modification config that's not the secret PAT itself
    "NOVA_GITHUB_REPO",
    "NOVA_GITHUB_USER",
    "NOVA_GITHUB_EMAIL",
    "SELFMOD_ENABLED",
    "SELFMOD_RATE_LIMIT_PER_HOUR",
}

# Keys whose values should be masked in GET responses. The infra tunnel tokens
# stay in .env so they get masked here; provider keys / OAuth secrets /
# GitHub PATs are no longer reachable through this path at all.
SECRET_KEYS = {
    "CLOUDFLARE_TUNNEL_TOKEN",
    "TAILSCALE_AUTHKEY",
}

ENV_FILE = os.getenv("NOVA_ENV_FILE", "/project/.env")


def _mask_value(key: str, value: str) -> str:
    """Mask secret values, showing only first 4 and last 4 chars."""
    if key not in SECRET_KEYS or len(value) <= 12:
        return value if key not in SECRET_KEYS else "****"
    return f"{value[:4]}...{value[-4:]}"


def read_env() -> dict[str, str]:
    """Read whitelisted env vars from .env file. Secrets are masked."""
    result: dict[str, str] = {}
    try:
        with open(ENV_FILE, "r") as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith("#"):
                    continue
                match = re.match(r"^([A-Z_][A-Z0-9_]*)=(.*)", line)
                if match:
                    key, value = match.group(1), match.group(2)
                    # Strip surrounding quotes
                    if len(value) >= 2 and value[0] == value[-1] and value[0] in ('"', "'"):
                        value = value[1:-1]
                    if key in ENV_WHITELIST:
                        result[key] = _mask_value(key, value)
    except FileNotFoundError:
        logger.warning(".env file not found at %s", ENV_FILE)
    return result


def _read_raw_lines() -> list[str]:
    """Read raw .env lines preserving comments and blank lines."""
    try:
        with open(ENV_FILE, "r") as f:
            return f.readlines()
    except FileNotFoundError:
        return []


def patch_env(updates: dict[str, str]) -> dict[str, str]:
    """Update .env keys (whitelist enforced). Returns the updated values (masked)."""
    # Validate all keys are whitelisted
    invalid = set(updates.keys()) - ENV_WHITELIST
    if invalid:
        raise ValueError(f"Keys not allowed: {', '.join(sorted(invalid))}")

    lines = _read_raw_lines()
    updated_keys: set[str] = set()

    new_lines: list[str] = []
    for line in lines:
        stripped = line.strip()
        if stripped and not stripped.startswith("#"):
            match = re.match(r"^([A-Z_][A-Z0-9_]*)=", stripped)
            if match and match.group(1) in updates:
                key = match.group(1)
                new_lines.append(f"{key}={updates[key]}\n")
                updated_keys.add(key)
                continue
        new_lines.append(line if line.endswith("\n") else line + "\n")

    # Append any keys not already in the file
    for key, value in updates.items():
        if key not in updated_keys:
            new_lines.append(f"{key}={value}\n")

    # Write in-place — atomic rename doesn't work on Docker bind-mounts
    # (.env is small, so partial-write risk is negligible)
    with open(ENV_FILE, "w") as f:
        f.writelines(new_lines)

    logger.info("Patched .env keys: %s", sorted(updates.keys()))
    return {k: _mask_value(k, v) for k, v in updates.items()}


def add_compose_profile(name: str) -> str:
    """Add a profile to COMPOSE_PROFILES (comma-separated). Returns new value."""
    lines = _read_raw_lines()
    current = ""
    for line in lines:
        match = re.match(r"^COMPOSE_PROFILES=(.*)", line.strip())
        if match:
            current = match.group(1).strip('"').strip("'")
            break

    profiles = [p.strip() for p in current.split(",") if p.strip()]
    if name not in profiles:
        profiles.append(name)

    new_value = ",".join(profiles)
    patch_env({"COMPOSE_PROFILES": new_value})
    return new_value


def remove_compose_profile(name: str) -> str:
    """Remove a profile from COMPOSE_PROFILES. Returns new value."""
    lines = _read_raw_lines()
    current = ""
    for line in lines:
        match = re.match(r"^COMPOSE_PROFILES=(.*)", line.strip())
        if match:
            current = match.group(1).strip('"').strip("'")
            break

    profiles = [p.strip() for p in current.split(",") if p.strip() and p.strip() != name]
    new_value = ",".join(profiles)
    patch_env({"COMPOSE_PROFILES": new_value})
    return new_value
