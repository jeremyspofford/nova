"""Runtime config keys demoted from .env to platform_config.

The Settings UI (backed by platform_config in Postgres) is the source of truth
for runtime config. These entries map a legacy .env variable to the
platform_config key that now owns it. On boot the orchestrator imports the .env
value if the DB has no row yet, then warns whenever .env still sets a key whose
effective (DB) value differs — the .env value is dead weight and edits there are
silently ignored.

See docs/designs/2026-06-30-unified-runtime-config.md §3.6.

To demote another runtime key: add it here, confirm its consuming service reads
the platform_config/Redis value (not just .env), and the boot reconcile + UI
source badge pick it up automatically.
"""
from __future__ import annotations

import logging
import os
from pathlib import Path

log = logging.getLogger(__name__)

# ENV_VAR -> platform_config key. Only include keys whose consuming service
# already reads the platform_config-derived value (via Redis nova:config:* or a
# direct DB read); otherwise editing in Settings would be a no-op, which is the
# exact "hope config that doesn't work" failure this system removes.
DEMOTED_RUNTIME_ENV: dict[str, str] = {
    "LLM_ROUTING_STRATEGY": "llm.routing_strategy",
    "DEFAULT_CHAT_MODEL": "llm.default_chat_model",
    "OLLAMA_CLOUD_FALLBACK_MODEL": "llm.cloud_fallback_model",
}

# platform_config key -> ENV_VAR, for UI source labeling (which DB-owned keys
# still have a stale .env override the operator should remove).
CONFIG_KEY_TO_ENV: dict[str, str] = {v: k for k, v in DEMOTED_RUNTIME_ENV.items()}


# ---------------------------------------------------------------------------
# .env file reader
#
# We parse the .env FILE (not os.environ) because docker compose injects a
# default for every ${VAR:-default}, so os.environ always has the key set and
# can't tell an operator's explicit .env value from a compose fallback. Only a
# value the operator actually wrote to .env should trigger a stale-override
# warning or a UI badge.
# ---------------------------------------------------------------------------

_env_file_cache: dict[str, str] | None = None
_env_file_mtime: float | None = None


def env_file_path() -> Path:
    """Path to the real .env file inside the container (repo mounted at /nova)."""
    return Path(os.environ.get("NOVA_ENV_FILE", "/nova/.env"))


def _parse_env_file(path: Path) -> dict[str, str]:
    """Parse KEY=VALUE lines from a .env file. Last assignment wins; comments
    and blank lines are skipped; surrounding quotes are stripped. Best-effort —
    a malformed line is skipped, never raised."""
    result: dict[str, str] = {}
    try:
        text = path.read_text()
    except OSError:
        return result
    for line in text.splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, val = line.partition("=")
        key = key.strip()
        if key.startswith("export "):
            key = key[len("export "):].strip()
        if not key:
            continue
        val = val.strip()
        if len(val) >= 2 and val[0] == val[-1] and val[0] in ("'", '"'):
            val = val[1:-1]
        result[key] = val
    return result


def explicit_env_value(var: str) -> str | None:
    """Return the value the operator explicitly set for `var` in the .env file,
    or None if the key is absent (or the file is unreadable). Cached and
    refreshed when the file's mtime changes so a hot-reloaded orchestrator
    picks up edits without a manual cache flush."""
    global _env_file_cache, _env_file_mtime
    path = env_file_path()
    try:
        mtime = path.stat().st_mtime
    except OSError:
        return None
    if _env_file_cache is None or mtime != _env_file_mtime:
        _env_file_cache = _parse_env_file(path)
        _env_file_mtime = mtime
    val = _env_file_cache.get(var)
    return val if val else None
