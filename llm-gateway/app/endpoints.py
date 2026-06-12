"""Inference endpoint pool — Part A of the deep-think/endpoint-pool design.

Generalizes the single LOCAL_INFERENCE_URL into N named endpoints persisted in
the runtime dir (endpoints.json). With no file, a single "default" endpoint is
synthesized from the env settings — the degenerate case, byte-for-byte the
pre-pool behavior. The file becomes authoritative once the user saves edits.

Lifecycle: always-on | wake-on-lan (auto-WoL on unreachable) | on-demand
(reserved for burst providers — accepted in config, never routed).
"""
from __future__ import annotations

import json
import logging
import re
from pathlib import Path
from typing import Any

from .config import settings

logger = logging.getLogger(__name__)

VALID_ENGINES = frozenset({"ollama", "ollama-host", "vllm", "llamacpp", "sglang", "lmstudio"})
VALID_LIFECYCLES = frozenset({"always-on", "wake-on-lan", "on-demand"})
_ID_RE = re.compile(r"^[a-z0-9][a-z0-9\-]{0,62}$")

_memo: tuple[float, list[dict]] | None = None  # (file mtime, parsed endpoints)


def _file() -> Path:
    return Path(settings.runtime_dir) / "endpoints.json"


def _default_from_env() -> dict[str, Any]:
    backend = settings.nova_inference_backend
    return {
        "id": "default",
        "name": backend if backend != "none" else "local",
        "engine": backend if backend in VALID_ENGINES else "ollama-host",
        "url": settings.local_inference_url,
        "lifecycle": "always-on",
        "wol_mac_secret": None,
        "enabled": backend != "none",
    }


def validate(endpoints: list[dict]) -> list[dict]:
    """Normalize and validate; raises ValueError with a user-facing message."""
    if not isinstance(endpoints, list):
        raise ValueError("endpoints must be a list")
    seen: set[str] = set()
    out = []
    for raw in endpoints:
        if not isinstance(raw, dict):
            raise ValueError("each endpoint must be an object")
        eid = str(raw.get("id") or "").strip()
        if not _ID_RE.fullmatch(eid):
            raise ValueError(f"invalid endpoint id {eid!r} (lowercase letters/digits/hyphens)")
        if eid in seen:
            raise ValueError(f"duplicate endpoint id {eid!r}")
        seen.add(eid)
        engine = raw.get("engine")
        if engine not in VALID_ENGINES:
            raise ValueError(f"endpoint {eid!r}: engine must be one of {sorted(VALID_ENGINES)}")
        url = str(raw.get("url") or "").strip().rstrip("/")
        if not url.startswith(("http://", "https://")):
            raise ValueError(f"endpoint {eid!r}: url must be http(s)")
        lifecycle = raw.get("lifecycle", "always-on")
        if lifecycle not in VALID_LIFECYCLES:
            raise ValueError(f"endpoint {eid!r}: lifecycle must be one of {sorted(VALID_LIFECYCLES)}")
        out.append({
            "id": eid,
            "name": str(raw.get("name") or eid),
            "engine": engine,
            "url": url,
            "lifecycle": lifecycle,
            "wol_mac_secret": raw.get("wol_mac_secret") or None,
            "enabled": bool(raw.get("enabled", True)),
        })
    if not out:
        raise ValueError("at least one endpoint is required")
    return out


def list_endpoints() -> list[dict]:
    """File contents if present and valid, else the synthesized env default."""
    global _memo
    path = _file()
    try:
        if path.exists():
            mtime = path.stat().st_mtime
            if _memo is not None and _memo[0] == mtime:
                return _memo[1]
            eps = validate(json.loads(path.read_text()))
            _memo = (mtime, eps)
            return eps
    except Exception as exc:
        logger.warning("endpoints.json unreadable (%s) — using env default", exc)
    return [_default_from_env()]


def save(endpoints: list[dict]) -> list[dict]:
    eps = validate(endpoints)
    path = _file()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(eps, indent=2))
    global _memo
    _memo = (path.stat().st_mtime, eps)
    return eps


def get(endpoint_id: str) -> dict | None:
    for ep in list_endpoints():
        if ep["id"] == endpoint_id:
            return ep
    return None


def routable() -> list[dict]:
    """Endpoints eligible for completion routing, in file (priority) order."""
    return [
        ep for ep in list_endpoints()
        if ep["enabled"] and ep["lifecycle"] != "on-demand"
    ]


def by_api_base(api_base: str) -> dict | None:
    """Map a candidate's api_base back to its endpoint (for failure handling)."""
    base = (api_base or "").rstrip("/").removesuffix("/v1")
    for ep in list_endpoints():
        if ep["url"].rstrip("/") == base:
            return ep
    return None
