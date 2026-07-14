"""Model recommendations — one engine, two surfaces (Settings UI + the
recommend_models tool).

recommendations(): detected hardware + curated table + per-agent role
profiles → per-agent {current, suggested, reason, alternates}. Hybrid-aware:
cloud rows are candidates only when an OpenRouter key is configured, and a
cloud suggestion always carries a fully-local alternate. Pin guard: every
agent's current model is checked against the live catalog.

probe(): the "test this model" truth — a short completion (TTFT, tok/s) plus
a forced tool call verified MECHANICALLY (the tool_calls frame is parsed and
matched; the model's prose claims count for nothing). For Ollama models the
VRAM footprint is read from /api/ps, feeding hardware detection empirically.
"""

import json
import logging
import time
import uuid as uuid_mod
from datetime import datetime, timezone

import httpx

from app import curated_models, hardware, models_catalog, settings_store
from app.agents import registry as agent_registry
from app.config import settings
from app.llm.router import _resolve

log = logging.getLogger(__name__)

# Seeded agents get explicit profiles; unknown agents fall back to a
# heuristic on their tool grants (tool users need reliability, pure
# conversationalists need speed).
_AGENT_PROFILES = {
    "main": "chat",
    "ingestion": "tools",
    "guardian": "guard",
    "agent-creator": "tools",
    "agent-manager": "tools",
    "tool-creator": "tools",
    "skill-manager": "tools",
    "model-manager": "tools",
}

_PROFILE_ROLE = {"chat": "chat", "tools": "tools", "guard": "guard",
                 "compaction": "compaction"}
_TIER_RANK = {"A": 2, "B": 1, "C": 0}
_SPEED_RANK = {"fast": 2, "medium": 1, "slow": 0}


def _profile_for(agent: dict) -> str:
    name = agent["name"]
    if name in _AGENT_PROFILES:
        return _AGENT_PROFILES[name]
    return "tools" if agent.get("allowed_tools") else "chat"


def _vram_known(hw: dict) -> float | None:
    """Measured total VRAM (nvidia-smi in the ollama container) or, failing
    that, the largest VRAM footprint a probe has observed. Never a guess."""
    return hw.get("vram_total_gb") or hw.get("vram_observed_gb")


def _fits_local(row: dict, hw: dict) -> tuple[bool, str]:
    """(fits, 'gpu'|'unified'|'cpu'|''). VRAM fit only counts when VRAM has
    actually been measured or observed. Unified-memory systems (GPU-active
    probes with no NVIDIA runtime, e.g. Apple Metal) size by system memory —
    there is no separate VRAM pool to require."""
    vram = _vram_known(hw)
    if hw.get("nvidia_runtime") and vram and row["min_vram_gb"] \
            and vram >= row["min_vram_gb"]:
        return True, "gpu"
    ram = hw.get("sizing_ram_gb") or hw.get("ram_gb")
    if ram and row["min_ram_gb"] and ram >= row["min_ram_gb"]:
        return True, "unified" if hw.get("unified_gpu") else "cpu"
    return False, ""


def _candidates(profile: str, rows: list[dict], hw: dict,
                cloud_ok: bool) -> list[dict]:
    """Fitting rows for a profile, best first."""
    role = _PROFILE_ROLE[profile]
    out = []
    for row in rows:
        if role not in row["roles"]:
            continue
        if row["provider"] == "openrouter":
            if not cloud_ok:
                continue
            out.append({**row, "how": "cloud"})
        else:
            fits, how = _fits_local(row, hw)
            if fits:
                out.append({**row, "how": how})

    size = lambda r: r["min_ram_gb"] or 0  # size proxy; cloud rows are 0

    def key(r):
        local = r["provider"] == "ollama"
        if profile == "tools":
            # reliability first, keep it local when the tier ties, then bigger
            return (_TIER_RANK[r["tool_tier"]], local, size(r))
        if profile == "chat":
            # quality first, then latency, then local, then smaller (snappier)
            return (_TIER_RANK[r["tool_tier"]], _SPEED_RANK[r["speed"]],
                    local, -size(r))
        # guard/compaction: adequate tier, then local, then smallest footprint
        return (_TIER_RANK[r["tool_tier"]], local, -size(r))

    for r in out:
        r["_key"] = key(r)
    out.sort(key=lambda r: r["_key"], reverse=True)
    return out


def _pick_for(current: str, cands: list[dict]) -> dict:
    """Best candidate, except an exact scoring tie never unseats the current
    model — a coin-flip switch is churn, not a recommendation."""
    pick = cands[0]
    for c in cands:
        if c["model"] == current and c["_key"] == pick["_key"]:
            return c
    return pick


def _reason(profile: str, pick: dict, hw: dict) -> str:
    sizing = hw.get("sizing_ram_gb") or hw.get("ram_gb")
    override = " (operator override)" if hw.get("memory_override_gb") else ""
    where = {"gpu": f"fits your {_vram_known(hw)} GB VRAM (GPU)",
             "unified": f"fits your {sizing} GB unified memory{override}",
             "cpu": f"fits your {sizing} GB RAM{override} (CPU)",
             "cloud": "cloud (OpenRouter key configured)"}[pick["how"]]
    why = {"tools": "tool-heavy role — reliability first",
           "chat": "conversation — quality with low latency",
           "guard": "guard duty — strict instruction following, small footprint",
           "compaction": "summary passes — smallest adequate model"}[profile]
    return f"{why}; tier-{pick['tool_tier']} {pick['speed']}, {where}"


async def recommendations() -> dict:
    hw = await hardware.detect()
    rows = await curated_models.list_all(enabled_only=True)
    agents = await agent_registry.list_agents(enabled_only=False)
    cloud_ok = settings.has_openrouter()

    catalog = await models_catalog.list_models()
    catalog_ids = {m["id"] for m in catalog}

    per_profile: dict[str, list[dict]] = {}
    for profile in _PROFILE_ROLE:
        per_profile[profile] = _candidates(profile, rows, hw, cloud_ok)

    out = []
    for agent in agents:
        profile = _profile_for(agent)
        current = agent["model"]
        current_valid = (current in catalog_ids) if catalog_ids else None
        cands = per_profile[profile]
        entry = {
            "agent": agent["name"],
            "is_system": agent["is_system"],
            "profile": profile,
            "current_model": current,
            "current_valid": current_valid,
        }
        if not cands:
            out.append({**entry, "status": "no_fit", "suggested_model": None,
                        "reason": "no curated model fits this machine for this role",
                        "alternates": []})
            continue
        pick = _pick_for(current, cands)
        alternates = [c for c in cands if c["model"] != pick["model"]][:2]
        # a cloud pick always carries a fully-local alternate
        others = [c for c in cands if c["model"] != pick["model"]]
        if pick["provider"] == "openrouter" and \
                not any(a["provider"] == "ollama" for a in alternates):
            local = next((c for c in others if c["provider"] == "ollama"), None)
            if local:
                alternates = (alternates + [local])[-2:] if alternates else [local]
        status = "keep" if pick["model"] == current else "switch"
        out.append({
            **entry, "status": status, "suggested_model": pick["model"],
            "reason": _reason(profile, pick, hw),
            "alternates": [{"model": a["model"],
                            "note": f"tier-{a['tool_tier']} {a['speed']}"
                                    + (" · local" if a["provider"] == "ollama"
                                       else " · cloud")}
                           for a in alternates],
        })

    # the compaction model is a setting, not an agent — surface it the same way
    compaction_current = settings_store.get("compaction.model") or "(main agent's model)"
    comp_cands = per_profile["compaction"]
    if comp_cands:
        pick = _pick_for(compaction_current, comp_cands)
        out.append({
            "agent": "compaction (setting)", "is_system": True,
            "profile": "compaction", "current_model": compaction_current,
            "current_valid": None,
            "status": "keep" if pick["model"] == compaction_current else "switch",
            "suggested_model": pick["model"],
            "reason": _reason("compaction", pick, hw),
            "alternates": [{"model": a["model"],
                            "note": f"tier-{a['tool_tier']} {a['speed']}"}
                           for a in comp_cands if a["model"] != pick["model"]][:2],
        })

    return {"hardware": hw, "cloud_available": cloud_ok,
            "curated_count": len(rows), "recommendations": out}


# ── the probe: verified on YOUR hardware, mechanically ───────────────────

async def _ollama_installed(name: str) -> bool:
    base = str(settings_store.get("inference.ollama_url")).rstrip("/")
    async with httpx.AsyncClient(timeout=5.0) as client:
        resp = await client.get(f"{base}/api/tags")
        resp.raise_for_status()
    return any(m["name"] == name for m in resp.json().get("models", []))


async def _ollama_vram(name: str) -> tuple[bool | None, float | None]:
    """(gpu_active, vram_gb) for a loaded model, from Ollama /api/ps."""
    base = str(settings_store.get("inference.ollama_url")).rstrip("/")
    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            resp = await client.get(f"{base}/api/ps")
            resp.raise_for_status()
        for m in resp.json().get("models", []):
            if m.get("name") == name:
                vram = m.get("size_vram") or 0
                return vram > 0, round(vram / 1024 ** 3, 1) if vram else None
    except Exception as e:
        log.warning("ollama /api/ps unavailable: %s", e)
    return None, None


async def probe(model: str) -> dict:
    result: dict = {
        "model": model, "ok": False, "tool_call_ok": None,
        "ttft_ms": None, "tok_s": None, "gpu_active": None, "vram_gb": None,
        "error": None, "ran_at": datetime.now(timezone.utc).isoformat(),
    }
    is_ollama = model.startswith("ollama:")
    name = model.split(":", 1)[1] if ":" in model else model

    try:
        client, model_name = _resolve(model)  # probes the NAMED model, no fallback swap
    except ValueError as e:
        result["error"] = str(e)
        return result

    if is_ollama:
        try:
            if not await _ollama_installed(name):
                result["error"] = (f"'{name}' is not installed — pull it first "
                                   f"(pulls are never automatic)")
                return result
        except Exception as e:
            result["error"] = f"cannot reach Ollama: {e}"
            return result

    # 1) local models: a tiny untimed warmup first, so TTFT measures the
    #    model, not a cold load from disk (which can dwarf it by 100x)
    if is_ollama:
        async for ev in client.stream(
                [{"role": "user", "content": "Reply with only: ok"}], model_name):
            if ev["type"] == "error":
                result["error"] = ev["error"]
                return result

    # 2) timed completion — TTFT and tok/s from EXACT token counts
    #    (stream_options.include_usage; chars/4 only as a fallback)
    t0 = time.monotonic()
    t_first = t_last = None
    chars = 0
    completion_tokens = None
    async for ev in client.stream(
            [{"role": "user", "content": "List the numbers 1 through 40, "
                                         "separated by commas. Nothing else."}],
            model_name, include_usage=True):
        if ev["type"] == "text":
            t_last = time.monotonic()
            t_first = t_first or t_last
            chars += len(ev["text"])
        elif ev["type"] == "usage":
            completion_tokens = ev["usage"].get("completion_tokens")
        elif ev["type"] == "error":
            result["error"] = ev["error"]
            return result
    if t_first is None:
        result["error"] = "model produced no output"
        return result
    result["ttft_ms"] = round((t_first - t0) * 1000)
    if t_last > t_first:
        # tokens after the first one, over the window they streamed in
        n = (completion_tokens - 1) if completion_tokens else chars / 4
        if n > 0:
            result["tok_s"] = round(n / (t_last - t_first), 1)

    # 2) forced tool call, verified mechanically — the model must emit a
    #    wellformed tool_calls frame with our nonce; prose claims don't count
    nonce = f"nova-probe-{uuid_mod.uuid4().hex[:8]}"
    tools = [{"type": "function", "function": {
        "name": "echo_check",
        "description": "Echo the token back to verify tool-calling works.",
        "parameters": {"type": "object",
                       "properties": {"token": {"type": "string"}},
                       "required": ["token"]}}}]
    messages = [
        {"role": "system", "content": "You are a tool-calling test harness. "
                                      "Use the provided tool exactly as instructed."},
        {"role": "user", "content": f"Call the echo_check tool with "
                                    f"token='{nonce}'. Do not answer in text."}]
    result["tool_call_ok"] = False
    async for ev in client.stream(messages, model_name, tools):
        if ev["type"] == "tool_calls":
            for call in ev["tool_calls"]:
                if call["name"] != "echo_check":
                    continue
                try:
                    args = json.loads(call["arguments"] or "{}")
                except json.JSONDecodeError:
                    continue
                if args.get("token") == nonce:
                    result["tool_call_ok"] = True
        elif ev["type"] == "error":
            result["error"] = ev["error"]
            return result

    # 3) empirical GPU truth while the model is still loaded
    if is_ollama:
        result["gpu_active"], result["vram_gb"] = await _ollama_vram(name)

    result["ok"] = bool(result["tool_call_ok"])
    await curated_models.stamp_probe(model, result)
    return result
