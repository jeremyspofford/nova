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

    This `total_gb` is deliberately never reduced by the ~2.6GB non-model
    baseline (Xwayland/WSL2) this host always carries — see fit.py's
    module docstring, "THE FRAME, STATED ONCE": that baseline already
    lives on the NEEDED side (curated_models.json's whole-card estimates,
    and `_footprint_vram_mb`'s nvidia-smi reading, both include it), so
    subtracting it here too would double-count it.
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

    Ruling S2f-R3 (the 17-vs-22 bug): a model's real footprint is the
    WHOLE-CARD figure nvidia-smi reports — baseline non-model usage
    (Xwayland/WSL2, ~2.6GB on this host) + weights + KV cache + compute
    buffers — not ollama's own /api/ps size_vram, which is weights only
    (see fit.py's module docstring for the full "whole-card frame"
    reasoning). `_footprint_vram_mb` below calls this exactly ONCE, right
    after a load succeeds, and records the reading AS-IS: never a
    before/after delta (a first version of this fix did that and review
    caught it as eviction-contaminated — see `_footprint_vram_mb`'s
    docstring).

    Summed across every line nvidia-smi prints: this host has exactly one
    GPU, so summing and "the one GPU's figure" are the same number today. A
    multi-GPU host where the probed model lands on a DIFFERENT card than
    whatever else is running would make this reading noisy — the same
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


async def _footprint_vram_mb() -> int | None:
    """The just-loaded model's real total footprint, in the WHOLE-CARD
    frame: a single nvidia-smi used-MiB reading taken immediately AFTER
    the completion request that loads the model answers. Recorded AS-IS —
    never a before/after delta.

    A before/after delta was this fix's first (wrong) shape, and review
    caught two compounding bugs in it: (1) eviction-contaminated — Fix B's
    own premise is that loading a different local model EVICTS whatever
    ollama had resident, so probing model B while model A was resident
    would have recorded (baseline+B) - (baseline+A) = B-A, wildly
    understating B whenever A != B (chatting on the 8B, then probing the
    27B, would have stored ~10GB as "verified" and read the 27B
    `comfortable` — the exact bug this whole slice exists to kill,
    reintroduced one layer down); and (2) even probing the SAME model
    twice, a delta EXCLUDES the ~2.6GB non-model baseline (Xwayland/WSL2)
    that the curated whole-card figures INCLUDE, so probed and curated
    needed_gb lived in two different frames that could never agree.

    A single AFTER reading fixes both: it is eviction-IMMUNE (whatever the
    completion just answered from IS what is resident at that instant,
    regardless of what came before — ollama already evicted anything
    else), and it is the same whole-card quantity — baseline included —
    that curated_models.json states and that nvidia-smi shows the
    operator. See fit.py's module docstring for why free_gb/total_gb must
    therefore stay the FULL card, never total-minus-baseline: the baseline
    already lives on the needed side of every comparison this module
    makes.

    A non-positive reading is reported as unreliable (None), never stored:
    a card with anything resident always uses SOME VRAM greater than zero,
    so zero or negative means nvidia-smi itself is unreliable right now,
    not a real measurement.
    """
    after_mb, _reason = await _nvidia_smi_used_mb()
    if after_mb is None or after_mb <= 0:
        return None
    return int(after_mb)


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
                # Only meaningful for a local ollama model — a remote/cloud
                # backend consumes no VRAM on this host at all. Read AFTER
                # the request answers (never before it too — see
                # `_footprint_vram_mb`'s docstring for why a before/after
                # delta was wrong).
                if kind == "ollama":
                    vram_mb = await _footprint_vram_mb()
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
