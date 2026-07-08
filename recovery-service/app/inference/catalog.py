"""Live model catalog — top models scraped from ollama.com/library.

The curated ``data/recommended_models.json`` remains the offline fallback and
the source of ``required``/``starter`` flags; this module answers "what does
the Ollama community actually pull" so the recommendation grid reflects
reality instead of anyone's editorial taste. Cached in-process for six hours;
any fetch or parse failure falls back to the curated file at the call site.
"""

from __future__ import annotations

import asyncio
import html
import logging
import re
import time

import httpx

log = logging.getLogger(__name__)

LIBRARY_URL = "https://ollama.com/library?sort=popular"
REGISTRY_MANIFEST = "https://registry.ollama.ai/v2/library/{model}/manifests/latest"
_MANIFEST_ACCEPT = "application/vnd.docker.distribution.manifest.v2+json"
_TTL_SECONDS = 6 * 3600
_cache: dict = {"at": 0.0, "entries": []}


async def _default_size_gb(client: httpx.AsyncClient, model: str) -> float | None:
    """Download size of a model's default tag, from the Ollama registry
    manifest (sum of layer sizes). None on any failure — the card just omits
    the badge rather than lying."""
    try:
        r = await client.get(
            REGISTRY_MANIFEST.format(model=model),
            headers={"Accept": _MANIFEST_ACCEPT},
            timeout=5.0,
        )
        r.raise_for_status()
        layers = r.json().get("layers", [])
        total = sum(l.get("size", 0) for l in layers)
        return round(total / 1e9, 1) if total else None
    except Exception:
        return None


def _category(name: str, caps: set[str]) -> str:
    if "embedding" in caps:
        return "embedding"
    if "vision" in caps:
        return "vision"
    n = name.lower()
    if "coder" in n or "code" in n or "devstral" in n:
        return "code"
    if any(k in n for k in ("r1", "reason", "think", "qwq")):
        return "reasoning"
    return "general"


def parse_library(page: str, limit: int = 36) -> list[dict]:
    """Parse the ollama.com/library HTML into catalog entries (no network).

    Split into its own pure function so a markup drift is caught by a unit
    test against a captured fixture (TD-14) rather than silently degrading the
    live source to the curated fallback. One block per model link; per-block
    regexes tolerate markup drift better than one page-wide pattern.
    """
    entries: list[dict] = []
    for block in re.split(r'href="/library/', page)[1:]:
        m = re.match(r'([a-zA-Z0-9._\-]+)"', block)
        if not m:
            continue
        name = m.group(1)
        seg = block[:2500]

        desc = ""
        dm = re.search(r"<p[^>]*>\s*([^<]{10,300}?)\s*</p>", seg)
        if dm:
            desc = html.unescape(re.sub(r"\s+", " ", dm.group(1)).strip())

        pulls = ""
        pm = (
            re.search(r'x-test-pull-count[^>]*>([^<]+)<', seg)
            or re.search(r">\s*([\d.]+[KMB]?)\s*</span>\s*Pulls", seg)
            or re.search(r"([\d.]+[KMB]?)\s+Pulls", seg)
        )
        if pm:
            pulls = pm.group(1).strip()

        caps = {c.strip().lower() for c in re.findall(r'x-test-capability[^>]*>([^<]+)<', seg)}

        # Available parameter variants, e.g. ["8B", "70B", "405B"].
        param_sizes = [
            s.strip().upper() for s in re.findall(r'x-test-size[^>]*>([^<]+)<', seg) if s.strip()
        ]

        entries.append({
            "id": name,
            "ollama_id": name,
            "name": name,
            "category": _category(name, caps),
            "backends": ["ollama"],
            "description": desc or "Popular on ollama.com",
            "pulls": pulls or None,
            "param_sizes": param_sizes,
            "url": f"https://ollama.com/library/{name}",
        })
        if len(entries) >= limit:
            break
    return entries


async def popular_models(limit: int = 36) -> list[dict]:
    now = time.time()
    if _cache["entries"] and now - _cache["at"] < _TTL_SECONDS:
        return _cache["entries"][:limit]

    async with httpx.AsyncClient(
        timeout=8.0,
        follow_redirects=True,
        headers={"User-Agent": "nova-recovery/1.0 (+https://arialabs.ai)"},
    ) as client:
        r = await client.get(LIBRARY_URL)
        r.raise_for_status()
        page = r.text

    entries = parse_library(page, limit)
    if not entries:
        raise RuntimeError("ollama.com library parse produced no entries")

    # Enrich with real default-tag download sizes (concurrent, best-effort).
    # A slow/blocked registry never sinks the whole catalog — sizes just
    # stay absent and the grid shows pull-count-only cards for those.
    try:
        async with httpx.AsyncClient(follow_redirects=True) as rc:
            sizes = await asyncio.gather(
                *(_default_size_gb(rc, e["ollama_id"]) for e in entries),
                return_exceptions=True,
            )
        for e, sz in zip(entries, sizes):
            if isinstance(sz, (int, float)) and sz:
                e["size_gb"] = sz
    except Exception:
        log.warning("registry size enrichment skipped", exc_info=True)

    _cache["at"] = now
    _cache["entries"] = entries
    n_sized = sum(1 for e in entries if e.get("size_gb"))
    log.info("live ollama catalog refreshed: %d models (%d sized)", len(entries), n_sized)
    return entries
