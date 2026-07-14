"""Runtime settings — DB-backed, UI-editable, live-applied.

SETTING_DEFS is the registry: adding an entry gives a feature a typed,
validated, UI-rendered setting with zero further wiring. Precedence:
DB value > def default. Env is deliberately NOT in the chain — behavioral
config belongs to the app, not the deployment.
"""

import json
import logging
from typing import Any

from app import db

log = logging.getLogger(__name__)

SETTING_DEFS: list[dict] = [
    # ── Context ──────────────────────────────────────────────────────────
    {"key": "context.budget_openrouter", "type": "number", "default": 24000,
     "min": 2000, "max": 200000, "section": "Context",
     "label": "Context budget — OpenRouter (tokens)",
     "description": "Total prompt budget when the active model is on OpenRouter."},
    {"key": "context.budget_ollama", "type": "number", "default": 6000,
     "min": 1000, "max": 131072, "section": "Context",
     "label": "Context budget — Ollama (tokens)",
     "description": "Total prompt budget for local models (effective limit is num_ctx)."},
    {"key": "compaction.min_aged", "type": "number", "default": 10,
     "min": 4, "max": 100, "section": "Context",
     "label": "Compaction threshold (messages)",
     "description": "Un-summarized messages that must age out of the window before a summary pass runs."},
    {"key": "compaction.model", "type": "string", "default": "",
     "section": "Context", "label": "Compaction model",
     "description": "Model for summary passes (empty = the main agent's model)."},
    # ── Inference ────────────────────────────────────────────────────────
    {"key": "inference.ollama_url", "type": "string",
     "default": "http://ollama:11434", "section": "Inference",
     "label": "Ollama URL",
     "description": ("Local inference endpoint. Default is the bundled service "
                     "(docker compose --profile inference); for host-run Ollama use "
                     "http://host.docker.internal:11434. Applies to the next request.")},
    {"key": "inference.local_fallback_model", "type": "string",
     "default": "qwen2.5:3b", "section": "Inference",
     "label": "Local fallback model",
     "description": "Ollama model used when no OpenRouter key is configured."},
    # ── Appearance (brain) ───────────────────────────────────────────────
    {"key": "brain.view", "type": "enum", "default": "graph",
     "options": ["graph", "galaxy"], "section": "Appearance",
     "label": "Brain view",
     "description": "How the memory graph is rendered."},
    {"key": "brain.detail_style", "type": "enum", "default": "sidebar",
     "options": ["sidebar", "modal"], "section": "Appearance",
     "label": "Memory detail style",
     "description": "Open memory details as a side panel or a centered modal."},
    {"key": "brain.rotation_speed", "type": "number", "default": 2,
     "min": 0, "max": 6, "section": "Appearance",
     "label": "Galaxy rotation speed",
     "description": "Auto-orbit speed of the galaxy view (0 = still)."},
    {"key": "brain.label_mode", "type": "enum", "default": "auto",
     "options": ["auto", "on", "off"], "section": "Appearance",
     "label": "Galaxy labels",
     "description": "auto: titles up close, category names zoomed out."},
    {"key": "brain.label_scale", "type": "number", "default": 1,
     "min": 0.6, "max": 1.5, "section": "Appearance",
     "label": "Label text size",
     "description": "Scales all graph label text."},
    # ── Automations ──────────────────────────────────────────────────────
    {"key": "automations.enabled", "type": "boolean", "default": True,
     "section": "Automations", "label": "Automations enabled",
     "description": "Master switch for all scheduled automations (applies at the next tick)."},
    {"key": "automations.staleness_max_age_days", "type": "number", "default": 7,
     "min": 1, "max": 365, "section": "Automations",
     "label": "Staleness threshold (days)",
     "description": "Sourced topics older than this are considered stale by list_stale_topics."},
    {"key": "automations.run_timeout_seconds", "type": "number", "default": 300,
     "min": 60, "max": 900, "section": "Automations",
     "label": "Run timeout (seconds)",
     "description": "Hard cap on a single automation run."},
]

_DEFS = {d["key"]: d for d in SETTING_DEFS}
_cache: dict[str, Any] = {}


async def warm():
    """Load DB overrides over defaults. Called at startup (after migrations)."""
    _cache.clear()
    for d in SETTING_DEFS:
        _cache[d["key"]] = d["default"]
    async with db.acquire() as conn:
        rows = await conn.fetch("SELECT key, value FROM settings")
    for r in rows:
        if r["key"] in _DEFS:
            value = r["value"]
            _cache[r["key"]] = json.loads(value) if isinstance(value, str) else value
    log.info("Settings warmed: %d keys (%d overridden)", len(_cache), len(rows))


def get(key: str) -> Any:
    if key not in _DEFS:
        raise KeyError(f"unknown setting: {key}")
    return _cache.get(key, _DEFS[key]["default"])


def _validate(key: str, value: Any) -> Any:
    d = _DEFS.get(key)
    if not d:
        raise ValueError(f"unknown setting: {key}")
    t = d["type"]
    if t == "number":
        if not isinstance(value, (int, float)) or isinstance(value, bool):
            raise ValueError(f"{key}: expected a number")
        if "min" in d and value < d["min"]:
            raise ValueError(f"{key}: below minimum {d['min']}")
        if "max" in d and value > d["max"]:
            raise ValueError(f"{key}: above maximum {d['max']}")
        return value
    if t == "boolean":
        if not isinstance(value, bool):
            raise ValueError(f"{key}: expected true/false")
        return value
    if t == "enum":
        if value not in d.get("options", []):
            raise ValueError(f"{key}: must be one of {d.get('options')}")
        return value
    if not isinstance(value, str):
        raise ValueError(f"{key}: expected a string")
    return value


async def set_value(key: str, value: Any):
    value = _validate(key, value)
    async with db.acquire() as conn:
        await conn.execute(
            """INSERT INTO settings (key, value) VALUES ($1, $2)
               ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = now()""",
            key, json.dumps(value))
    _cache[key] = value
    log.info("Setting changed: %s = %r", key, value)


def all_settings() -> list[dict]:
    """Defs merged with live values — the UI renders directly from this."""
    return [{**d, "value": _cache.get(d["key"], d["default"])} for d in SETTING_DEFS]
