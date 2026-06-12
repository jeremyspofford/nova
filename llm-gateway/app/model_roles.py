"""Runtime model-role assignments — completion / extraction / embedding.

The trio lived only in .env (LOCAL_COMPLETION_MODEL, EXTRACTION_MODEL,
LOCAL_EMBED_MODEL), which is how a host ends up pinning a model it never
installed and silently breaking memory distillation. Roles set here (Models
page → PUT /models/roles) persist in the runtime dir and override env without
a restart; unset roles fall through to the env values, so existing installs
change nothing until the user touches the UI.
"""
from __future__ import annotations

import json
import logging
from pathlib import Path

from .config import settings

logger = logging.getLogger(__name__)

ROLES = ("completion", "extraction", "embedding")

_memo: tuple[float, dict] | None = None


def _file() -> Path:
    return Path(settings.runtime_dir) / "model_roles.json"


def overrides() -> dict[str, str]:
    """Persisted role overrides ({role: model}); empty dict when unset."""
    global _memo
    path = _file()
    try:
        if path.exists():
            mtime = path.stat().st_mtime
            if _memo is not None and _memo[0] == mtime:
                return _memo[1]
            data = json.loads(path.read_text())
            clean = {r: str(data[r]) for r in ROLES if data.get(r)}
            _memo = (mtime, clean)
            return clean
    except Exception as exc:
        logger.warning("model_roles.json unreadable (%s) — using env values", exc)
    return {}


def save(values: dict[str, str | None]) -> dict[str, str]:
    current = dict(overrides())
    for role, model in values.items():
        if role not in ROLES:
            raise ValueError(f"unknown role {role!r} (valid: {', '.join(ROLES)})")
        if model:
            current[role] = model
        else:
            current.pop(role, None)  # null/empty clears the override -> env value
    path = _file()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(current, indent=2))
    global _memo
    _memo = (path.stat().st_mtime, current)
    return current


def completion_model() -> str:
    return overrides().get("completion") or settings.local_completion_model


def extraction_model() -> str:
    # The env var lives in memory-service's config, not the gateway's; the
    # gateway only stores the override. Empty string = "no override, use the
    # consumer's own env/default".
    return overrides().get("extraction") or ""


def embedding_model() -> str:
    return overrides().get("embedding") or settings.local_embed_model


def effective() -> dict[str, dict]:
    ov = overrides()
    return {
        "completion": {"model": completion_model(),
                       "source": "override" if "completion" in ov else "env"},
        "extraction": {"model": ov.get("extraction") or None,
                       "source": "override" if "extraction" in ov else "env"},
        "embedding": {"model": embedding_model(),
                      "source": "override" if "embedding" in ov else "env"},
    }
