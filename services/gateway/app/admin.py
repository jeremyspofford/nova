"""The admin plane: hardware detection, model suggestions, pulling ollama
models, one-shot probes, and the single active backend's config.

Paths are pinned by SDD ledger Ruling R8 — core calls these exact routes
and forwards nothing but the body, so none of them takes a query
parameter in S1.
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import time
from pathlib import Path

import httpx
from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import Response, StreamingResponse

from app import backends, db
from app import curated as curated_mod
from app import fit as fit_mod
from app import suggest as suggest_mod

router = APIRouter(prefix="/admin", tags=["admin"])
logger = logging.getLogger("gateway")

# Ruling R2: install.sh writes <repo>/data/hardware.json on the host; the
# compose file mounts that directory read-only into this container at /data.
HARDWARE_PATH = Path("/data/hardware.json")
# Matches the v4_models volume mounted into this container in compose.
MODELS_DIR = Path("/models")

# A pull can spend minutes between progress lines — only the connect phase
# is bounded, so a slow download is never mistaken for a hang.
PULL_TIMEOUT = httpx.Timeout(connect=5.0, read=None, write=10.0, pool=5.0)
# The 2026-08-29 walk's own probe of qwen3.8:27b timed out at 30060ms against
# the old flat 30s budget — a cold ~18GB-weights load routinely exceeds that.
# Bounded, not None/unbounded (a probe that can hang forever answers nothing
# either), but long enough for a real cold load to actually finish; connect
# stays short since that phase was never what timed out.
PROBE_TIMEOUT = httpx.Timeout(connect=5.0, read=180.0, write=10.0, pool=5.0)
# /api/ps is a cheap metadata read (no generation happens), unlike a probe.
PS_TIMEOUT = httpx.Timeout(5.0)
# nvidia-smi answers in well under a second on every host this has ever run
# on; bounded generously anyway so a wedged driver cannot hang a probe.
NVIDIA_SMI_TIMEOUT_S = 10.0


def _read_hardware() -> tuple[dict, str | None]:
    """The parsed hardware.json, plus a note when it could not be read.

    Absence is a fact, not an error — install.sh may simply not have run
    yet on this host — so callers get an empty-but-valid shape rather than
    a 500.
    """
    try:
        raw = HARDWARE_PATH.read_text()
    except FileNotFoundError:
        return {"gpus": []}, "hardware.json missing — run install.sh"
    try:
        return json.loads(raw), None
    except json.JSONDecodeError:
        return {"gpus": []}, "hardware.json unreadable — run install.sh"


@router.get("/hardware")
async def hardware() -> dict:
    data, note = _read_hardware()
    if note is not None:
        return {"gpus": data.get("gpus", []), "note": note}
    return data


async def _resident_models(app, base_url: str) -> tuple[list[dict] | None, str | None]:
    """(every model ollama's /api/ps reports resident, reason-if-unreadable).

    Each entry is `{"model": name, "vram_mb": float}` — the per-model TABLE
    app/fit.py's eviction-aware free-VRAM calc needs (ruling S2f-R2), not a
    pre-summed total: summing here would throw away exactly the per-entry
    distinction that calc is built to make (today every entry is swappable,
    but the shape has to carry the possibility of one that is not).
    """
    client = backends.http_client(app, PS_TIMEOUT, base_url=base_url)
    try:
        async with client as c:
            resp = await c.get("/api/ps")
            resp.raise_for_status()
    except httpx.HTTPError as exc:
        return None, f"could not reach ollama's /api/ps — {backends.reason(exc)}"
    resident = []
    for entry in resp.json().get("models", []):
        size_vram = entry.get("size_vram")
        if size_vram is not None:
            resident.append(
                {
                    "model": entry.get("name") or entry.get("model"),
                    "vram_mb": size_vram / (1024 * 1024),
                }
            )
    return resident, None


async def _free_and_total_vram_gb(
    app, hardware: dict, config: dict
) -> tuple[float | None, float | None, str | None]:
    """(free_gb, total_gb, reason-if-free-is-unknown).

    `total_gb` is the host's total (hardware.json, the largest single GPU —
    ollama never shards across cards). `free_gb` answers "how much would be
    available AFTER a switch", not "how much is free right now" — ruling
    S2f-R2, see app/fit.py's module docstring: a local model switch evicts
    whatever ollama currently holds resident, so free-for-a-switch is
    computed by `fit.free_vram_gb_for_switch` from the live resident table,
    never a static floor and never installed-sum. ollama's /api/ps is still
    read here (via `_resident_models`) — not to subtract its numbers, but
    because reachability IS part of the answer: an unreachable /api/ps
    means "resident, and therefore free-after-switch, is unknown", which is
    a different fact from "free is the whole card".
    """
    total_gb = suggest_mod.largest_single_gpu_vram_gb(hardware)
    if total_gb is None:
        return None, None, "no GPU detected on this host"
    if config["kind"] != "ollama":
        return None, total_gb, (
            f"the active backend is {config['kind']}, not local ollama — "
            "free VRAM isn't observable"
        )
    base_url = backends.resolve_base_url(config)
    if not base_url:
        return None, total_gb, "OLLAMA_URL is unset — cannot read what's resident"
    resident, reason = await _resident_models(app, base_url)
    if resident is None:
        return None, total_gb, reason
    return fit_mod.free_vram_gb_for_switch(total_gb, resident), total_gb, None


async def _latest_probes(pool, slugs: list[str]) -> dict[str, dict]:
    """The newest OK probe row per slug — a failed probe (ok=false) never
    counts as a measurement, and an older successful one loses to a newer
    one for the same model."""
    if not slugs:
        return {}
    rows = await pool.fetch(
        "SELECT DISTINCT ON (model) model, vram_mb FROM probes "
        "WHERE model = ANY($1) AND ok = true AND vram_mb IS NOT NULL "
        "ORDER BY model, created_at DESC",
        slugs,
    )
    return {row["model"]: dict(row) for row in rows}


@router.get("/suggest")
async def suggest_route(request: Request) -> dict:
    data, _note = _read_hardware()
    result = suggest_mod.suggest(data, curated_mod.load_curated())

    pool = await db.get_pool()
    config = await backends.read_config(pool)
    free_gb, total_gb, reason = await _free_and_total_vram_gb(request.app, data, config)
    probes_by_model = await _latest_probes(pool, [m["slug"] for m in result["models"]])

    for model in result["models"]:
        needed_gb, source = fit_mod.needed_gb_for(model, probes_by_model.get(model["slug"]))
        model["fit"] = fit_mod.compute_fit(
            needed_gb, free_gb, total_gb, source=source, reason=reason
        )
    return result


def _preflight_line(model: str, curated_entries: list[dict]) -> dict:
    """The pull stream's mandatory first line: a best-effort free-space
    check, or an honest "we don't know" when the model's size is not in
    the curated catalog — never a guess dressed up as a measurement."""
    entry = next((e for e in curated_entries if e.get("slug") == model), None)
    size_gb = entry.get("size_gb") if entry else None
    if size_gb is None:
        return {
            "status": "preflight",
            "note": f"model size for {model!r} is unknown — skipping the free-space check",
        }
    try:
        stat = os.statvfs(MODELS_DIR)
        free_gb = (stat.f_bavail * stat.f_frsize) / (1024**3)
    except OSError as exc:
        return {"status": "preflight", "note": f"could not check free space — {exc}"}
    return {
        "status": "preflight",
        "required_gb": size_gb,
        "free_gb": round(free_gb, 1),
        "ok": free_gb >= size_gb,
    }


@router.post("/pull")
async def pull(request: Request) -> Response:
    body = await request.json()
    model = body.get("model")
    if not model:
        raise HTTPException(status_code=400, detail="model is required")

    pool = await db.get_pool()
    config = await backends.read_config(pool)
    if config["kind"] != "ollama":
        raise HTTPException(
            status_code=400,
            detail=(
                "pull is only supported for the ollama backend "
                f"(current backend: {config['kind']})"
            ),
        )

    ollama_url = backends.resolve_base_url(config)
    if not ollama_url:
        raise HTTPException(status_code=502, detail="OLLAMA_URL is unset — cannot reach ollama")

    client = backends.http_client(request.app, PULL_TIMEOUT, base_url=ollama_url)
    try:
        upstream = await client.send(
            client.build_request("POST", "/api/pull", json={"model": model}), stream=True
        )
    except httpx.HTTPError as exc:
        await client.aclose()
        raise HTTPException(
            status_code=502, detail=f"could not reach ollama — {backends.reason(exc)}"
        ) from exc

    if upstream.status_code != 200:
        content = await upstream.aread()
        await upstream.aclose()
        await client.aclose()
        return Response(
            content=content,
            status_code=upstream.status_code,
            media_type=upstream.headers.get("content-type"),
        )

    preflight = _preflight_line(model, curated_mod.load_curated())

    async def relay():
        yield (json.dumps(preflight) + "\n").encode()
        try:
            async for chunk in upstream.aiter_raw():
                yield chunk
        except httpx.HTTPError as exc:
            failure = backends.reason(exc)
            logger.warning("model pull stream failed: %s", failure)
            yield (json.dumps({"error": f"the pull stream failed — {failure}"}) + "\n").encode()
        finally:
            await upstream.aclose()
            await client.aclose()

    return StreamingResponse(
        relay(), media_type=upstream.headers.get("content-type") or "application/x-ndjson"
    )


async def _nvidia_smi_used_mb() -> tuple[float | None, str | None]:
    """(total VRAM in use right now, in MiB, reason-if-unavailable).

    Ruling S2f-R3 (the 17-vs-22 bug): a model's real footprint is weights +
    KV cache + compute buffers, which only shows up as a whole-card delta —
    ollama's own /api/ps size_vram is weights only (see fit.py's module
    docstring). This is the raw ingredient the probe brackets before/after
    a load; it is not meaningful on its own as a per-model number, only as
    one half of a delta the caller computes.

    Summed across every line nvidia-smi prints: this host has exactly one
    GPU, so summing and "the one GPU's figure" are the same number today. A
    multi-GPU host where the probed model lands on a DIFFERENT card than
    whatever else is running would make this delta noisy — the same
    single-GPU assumption `suggest.largest_single_gpu_vram_gb` already
    makes for `total_gb`, not solved here either.

    None (with a reason) whenever nvidia-smi cannot be run at all — no GPU
    device passthrough on this container yet (see
    deploy/docker-compose.gpu.yml), no NVIDIA driver, or the binary is
    missing — so a probe run before that is wired degrades exactly like a
    remote backend's probe already does (ok=True, vram_mb=None), never a
    crash.
    """
    try:
        proc = await asyncio.create_subprocess_exec(
            "nvidia-smi",
            "--query-gpu=memory.used",
            "--format=csv,noheader,nounits",
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        stdout, stderr = await asyncio.wait_for(
            proc.communicate(), timeout=NVIDIA_SMI_TIMEOUT_S
        )
    except (OSError, TimeoutError) as exc:
        return None, f"nvidia-smi could not be run — {exc}"
    if proc.returncode != 0:
        return None, f"nvidia-smi exited {proc.returncode}: {stderr.decode().strip()[:200]}"
    total_mb = 0.0
    for line in stdout.decode().splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            total_mb += float(line)
        except ValueError:
            continue
    return total_mb, None


async def _footprint_vram_mb(before_mb: float | None) -> int | None:
    """The just-loaded model's real total footprint: an nvidia-smi snapshot
    taken right after the load, minus one taken right before it (`before_mb`
    — None if that first snapshot could not be taken at all).

    A non-positive delta is reported as unreliable (None), never stored:
    a model that just loaded must use SOME positive VRAM, so zero or
    negative means the bracket was contaminated — most likely the model was
    ALREADY resident before the 'before' snapshot (a warm, not cold, probe:
    see fit.py's module docstring), so its footprint was already counted on
    both sides and netted out. Storing that number anyway would poison a
    'verified' badge with a figure that measured nothing.
    """
    if before_mb is None:
        return None
    after_mb, _reason = await _nvidia_smi_used_mb()
    if after_mb is None:
        return None
    delta = after_mb - before_mb
    return int(delta) if delta > 0 else None


@router.post("/probe")
async def probe(request: Request) -> dict:
    body = await request.json()
    model = body.get("model")
    if not model:
        raise HTTPException(status_code=400, detail="model is required")

    pool = await db.get_pool()
    config = await backends.read_config(pool)
    kind = config["kind"]
    target_model = model or config.get("model") or ""
    base_url = backends.resolve_base_url(config)

    ok = True
    error: str | None = None
    latency_ms: int | None = None
    vram_mb: int | None = None
    started = time.monotonic()

    if not base_url:
        ok = False
        error = f"no base URL configured for backend kind={kind}"
    else:
        # The 'before' snapshot has to happen BEFORE the request that loads
        # the model — only meaningful for a local ollama model, since a
        # remote/cloud backend consumes no VRAM on this host at all.
        before_mb: float | None = None
        if kind == "ollama":
            before_mb, _reason = await _nvidia_smi_used_mb()
        client = backends.http_client(
            request.app, PROBE_TIMEOUT, base_url=base_url, headers=backends.auth_headers(config)
        )
        try:
            async with client as c:
                resp = await c.post(
                    "/v1/chat/completions",
                    json={
                        "model": target_model,
                        "messages": [{"role": "user", "content": "hi"}],
                        "max_tokens": 1,
                        "stream": False,
                    },
                )
                resp.raise_for_status()
                latency_ms = int((time.monotonic() - started) * 1000)
                if kind == "ollama":
                    vram_mb = await _footprint_vram_mb(before_mb)
        except httpx.HTTPError as exc:
            ok = False
            error = backends.reason(exc)
            latency_ms = int((time.monotonic() - started) * 1000)

    row = await pool.fetchrow(
        "INSERT INTO probes (model, kind, ok, latency_ms, vram_mb, error) "
        "VALUES ($1, $2, $3, $4, $5, $6) "
        "RETURNING id, model, kind, ok, latency_ms, vram_mb, error, created_at",
        target_model,
        kind,
        ok,
        latency_ms,
        vram_mb,
        error,
    )
    return dict(row)


@router.get("/backend")
async def get_backend() -> dict:
    pool = await db.get_pool()
    row = await backends.read_config(pool)
    return backends.to_public(row)


@router.put("/backend")
async def put_backend(request: Request) -> dict:
    body = await request.json()
    backends.validate_shape(body)
    try:
        await backends.verify_live(request.app, body)
    except backends.VerificationFailed as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc

    pool = await db.get_pool()
    saved = await backends.save_config(pool, body)
    # Never log the payload itself — api_key lives in it.
    logger.info("backend config saved: kind=%s", saved["kind"])
    return backends.to_public(saved)
