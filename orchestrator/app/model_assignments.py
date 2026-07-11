"""Model-assignment validation — flag configured models that don't exist.

Every model reference in the platform (pod agent pins, runtime defaults, the
cloud fallback) is configured independently of what providers actually serve,
so assignments rot silently: a retired model or a dead provider only surfaces
as a request-time failure deep inside a pipeline run. This endpoint
cross-checks each assignment against the gateway's VALIDATED discovery
(`/models/discover` — real provider calls, key rejection surfaced) so the
dashboard can show the operator exactly which knobs point at nothing.
"""
from __future__ import annotations

import logging

import httpx
from app.auth import AdminDep
from app.config import settings
from app.db import get_pool
from fastapi import APIRouter

log = logging.getLogger(__name__)

router = APIRouter(prefix="/api/v1/models", tags=["models"])

# Provider prefix of a model id → discovery slug. Bare names map heuristically.
_PREFIX_TO_SLUG = {
    "groq": "groq", "gemini": "gemini", "cerebras": "cerebras",
    "openrouter": "openrouter", "github": "github", "nvidia_nim": "nvidia",
    "chatgpt": "chatgpt",
}


def _provider_slug_for(model: str) -> str | None:
    """Best-effort mapping from a model id to its discovery provider slug.
    None means 'local or unknown' — checked against local model sets instead."""
    if "/" in model:
        prefix = model.split("/", 1)[0]
        if prefix in _PREFIX_TO_SLUG:
            return _PREFIX_TO_SLUG[prefix]
        return None  # e.g. LM Studio's "openai/gpt-oss-20b" or Ollama "openbmb/x"
    if model.startswith("claude"):
        return "anthropic"
    if model.startswith(("gpt-", "o1-", "o3-", "o4-")):
        return "openai"
    if model.startswith("gemini"):
        return "gemini"
    return None


def _check_assignment(model: str, catalog: list[dict]) -> tuple[str, str]:
    """Return (status, note) for one model assignment.

    status: ok | auto | provider_unavailable | unknown_model | unverified
    """
    if not model or model == "auto":
        return "auto", "resolved at request time from available providers"
    if model.startswith("tier:"):
        return "auto", "tier hint — the tier resolver picks a live model at request time"

    slug = _provider_slug_for(model)
    by_slug = {p["slug"]: p for p in catalog}

    if slug is not None:
        provider = by_slug.get(slug)
        if provider is None:
            return "unverified", f"no discovery data for provider '{slug}'"
        if not provider.get("available"):
            status = provider.get("key_status", "unknown")
            return (
                "provider_unavailable",
                f"{provider.get('name', slug)}: {status}"
                + (f" — {provider['detail']}" if provider.get("detail") else ""),
            )
        ids = {m["id"] for m in provider.get("models", [])}
        if ids and model not in ids:
            return "unknown_model", f"{provider.get('name', slug)} does not list this model"
        if not ids:
            return "unverified", "provider is up but does not expose a model list"
        return "ok", ""

    # Local-style name: look for it in any local provider's discovered list.
    local_ids: set[str] = set()
    local_up = False
    for p in catalog:
        if p.get("type") == "local" and p.get("available"):
            local_up = True
            local_ids |= {m["id"] for m in p.get("models", [])}
    if model in local_ids:
        return "ok", ""
    if local_up:
        return "unknown_model", "no local backend lists this model (not pulled/loaded?)"
    return "provider_unavailable", "no local inference backend is reachable"


@router.get("/assignments")
async def validate_assignments(_admin: AdminDep) -> dict:
    """Every configured model reference, checked against validated discovery."""
    # 1. The gateway's validated catalog (cached server-side, ≤5 min old).
    try:
        async with httpx.AsyncClient(timeout=30.0) as client:
            resp = await client.get(
                f"{settings.llm_gateway_url}/v1/models/discover",
                headers={"X-Admin-Secret": settings.nova_admin_secret},
            )
            resp.raise_for_status()
            catalog = resp.json()
    except Exception as e:
        return {"error": f"gateway discovery unavailable: {e}", "assignments": []}

    assignments: list[dict] = []

    # 2. Pod-agent model pins.
    pool = get_pool()
    async with pool.acquire() as conn:
        rows = await conn.fetch(
            """SELECT p.name AS pod, a.name AS agent, a.role, a.model
               FROM pod_agents a JOIN pods p ON p.id = a.pod_id
               WHERE a.enabled AND a.model IS NOT NULL AND a.model <> ''
               ORDER BY p.name, a.position""",
        )
        for r in rows:
            status, note = _check_assignment(r["model"], catalog)
            assignments.append({
                "scope": "pod_agent",
                "name": f"{r['pod']} / {r['agent']} ({r['role']})",
                "model": r["model"],
                "status": status,
                "note": note,
            })

        # 3. Runtime config knobs.
        cfg_rows = await conn.fetch(
            """SELECT key, value FROM platform_config
               WHERE key IN ('llm.default_chat_model', 'llm.cloud_fallback_model')""",
        )
    for r in cfg_rows:
        val = r["value"]
        # platform_config values are JSON; unwrap (possibly double-) encoded strings.
        import json as _json
        for _ in range(2):
            if isinstance(val, str):
                try:
                    val = _json.loads(val)
                except (ValueError, TypeError):
                    break
        model = val if isinstance(val, str) else ""
        status, note = _check_assignment(model, catalog)
        assignments.append({
            "scope": "config",
            "name": r["key"],
            "model": model or "(empty)",
            "status": status,
            "note": note,
        })

    problems = sum(1 for a in assignments
                   if a["status"] in ("provider_unavailable", "unknown_model"))
    return {"assignments": assignments, "problem_count": problems}
