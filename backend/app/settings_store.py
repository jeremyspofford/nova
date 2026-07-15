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
    {"key": "compaction.model", "type": "model", "default": "",
     "model_scope": "any", "allow_empty": True,
     "section": "Context", "label": "Compaction model",
     "description": "Model for summary passes (empty = the main agent's model)."},
    # ── Inference ────────────────────────────────────────────────────────
    {"key": "inference.ollama_url", "type": "string",
     "default": "http://ollama:11434", "section": "Inference",
     "label": "Ollama URL",
     "description": ("Local inference endpoint. Default is the bundled service "
                     "(docker compose --profile inference); for host-run Ollama use "
                     "http://host.docker.internal:11434. Applies to the next request.")},
    {"key": "inference.local_fallback_model", "type": "model",
     "model_scope": "ollama", "allow_empty": False,
     "default": "qwen2.5:3b", "section": "Inference",
     "label": "Local fallback model",
     "description": "Ollama model used when no OpenRouter key is configured."},
    {"key": "inference.keep_chat_model_warm", "type": "boolean", "default": False,
     "section": "Models", "label": "Keep chat model loaded",
     "description": ("Pin main's local model in Ollama memory so chat answers "
                     "without a multi-second reload (re-pins after Ollama "
                     "restarts; unpins when main moves to cloud). Ollama may "
                     "still swap it out under heavy memory pressure.")},
    {"key": "inference.memory_gb_override", "type": "number", "default": 0,
     "min": 0, "max": 2048, "section": "Inference",
     "label": "Memory override for model sizing (GB)",
     "description": ("Total system/unified memory to size local models against, "
                     "for setups where Nova's container can't see it — e.g. "
                     "macOS with host-run Ollama, where the Docker VM hides the "
                     "real unified memory. 0 = use the measured value. Don't use "
                     "this for the bundled Ollama: the VM's memory really is its "
                     "ceiling.")},
    # ── Appearance (brain) ───────────────────────────────────────────────
    {"key": "brain.show_platform", "type": "boolean", "default": True,
     "section": "Appearance", "label": "Platform entities in the brain",
     "description": ("Agents, tools, automations, and rules join the memory "
                     "graph as first-class nodes with their real relationships "
                     "as edges. Off = knowledge-only view.")},
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
    # ── Operator ─────────────────────────────────────────────────────────
    {"key": "ui.public_url", "type": "string", "default": "",
     "section": "Operator", "label": "Public URL (for phone setup)",
     "description": ("The URL other devices use to reach Nova, e.g. "
                     "https://nova.<tailnet>.ts.net — feeds the phone-setup "
                     "QR code in Settings. Leave empty to hide the QR card.")},
    {"key": "ui.edit_mode", "type": "boolean", "default": False,
     "section": "Operator", "label": "Edit mode",
     "description": ("Allow manual create/edit/delete of agents, automations, rules, "
                     "and tools from this UI (enforced at the API layer). Off = view "
                     "plus enable/disable. Nova's own management tools are unaffected.")},
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
    # ── Voice (phase 1: spoken replies; plan: docs/plans/voice.md) ───────
    {"key": "voice.tts_voice", "type": "string", "default": "af_heart",
     "section": "Voice", "label": "Nova's voice",
     "description": ("Kokoro voice id for spoken replies (e.g. af_heart, af_bella, "
                     "am_adam — full list at /api/v1/voice/health).")},
    {"key": "voice.tts_speed", "type": "number", "default": 1.0,
     "min": 0.5, "max": 2.0, "section": "Voice", "label": "Speaking speed",
     "description": "Speech rate multiplier for synthesized replies."},
    {"key": "voice.model_override", "type": "model", "default": "",
     "model_scope": "any", "allow_empty": True,
     "section": "Voice", "label": "Voice reply model",
     "description": ("LLM used when a turn is started by voice (empty = the "
                     "main agent's model). Pick a faster/more conversational "
                     "model for spoken exchanges without changing the agent.")},
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
    # "model" and "string" are both free strings server-side; "model" is a UI
    # hint to render a dropdown fed by /api/v1/models
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
