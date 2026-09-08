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
from datetime import UTC, datetime
from decimal import Decimal
from pathlib import Path

import httpx
from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import JSONResponse, Response, StreamingResponse

from app import adapters, backends, catalog, db, hf_hub, ollama_registry, providers, usage
from app import curated as curated_mod
from app import fit as fit_mod
from app import pulls as pulls_mod
from app import suggest as suggest_mod
from app.adapters import ollama

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
        return (
            None,
            total_gb,
            (
                f"the active backend is {config['kind']}, not local ollama — "
                "free VRAM isn't observable"
            ),
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
        "SELECT DISTINCT ON (model) model, vram_mb, created_at FROM probes "
        "WHERE model = ANY($1) AND ok = true AND vram_mb IS NOT NULL AND kind = 'ollama' "
        "ORDER BY model, created_at DESC",
        slugs,
    )
    return {row["model"]: dict(row) for row in rows}


async def _fit_context(app, pool) -> dict:
    """The numbers every fit verdict is computed against — read ONCE per
    request and shared by /admin/suggest and the catalogue, so the two can
    never disagree about the same card."""
    data, _note = _read_hardware()
    config = await backends.read_config(pool)
    free_gb, total_gb, reason = await _free_and_total_vram_gb(app, data, config)
    return {"free_gb": free_gb, "total_gb": total_gb, "reason": reason}


@router.get("/suggest")
async def suggest_route(request: Request) -> dict:
    data, _note = _read_hardware()
    result = suggest_mod.suggest(data, curated_mod.load_curated())

    pool = await db.get_pool()
    ctx = await _fit_context(request.app, pool)
    probes_by_model = await _latest_probes(pool, [m["slug"] for m in result["models"]])

    for model in result["models"]:
        needed_gb, source = fit_mod.needed_gb_for(model, probes_by_model.get(model["slug"]))
        model["fit"] = fit_mod.compute_fit(
            needed_gb, ctx["free_gb"], ctx["total_gb"], source=source, reason=ctx["reason"]
        )
    return result


# Pulls in flight, model string -> when it started (ISO). A second POST for
# the same model while one streams is a 409 naming that time: ollama would
# run two downloads against the same blobs and the second stream's progress
# would be a story about the first. Process-local — this gateway is the one
# thing that pulls into the bundled ollama — and cleared in the relay's
# finally, so an aborted stream releases it too.
_PULLS_IN_FLIGHT: dict[str, str] = {}


async def _preflight_line(app, model: str) -> dict:
    """The pull stream's mandatory first line: the download's size, DERIVED
    live from the source ollama will pull from (`size_source` says which:
    the registry manifest for a library tag, the Hugging Face sibling for
    an hf.co ref — see app/pulls.py) against the models volume's free
    space, or an honest note saying why it could not be sized. Never a
    guess dressed up as a measurement, and never a stale curated number.
    `required_gb` and `free_gb` are both GiB (the same unit, so `ok` is a
    real comparison); `size_bytes` is the exact figure; `resolved` is what
    the source stated of quant / family / params_b."""
    sized = await pulls_mod.pull_size(app, model)
    line: dict = {"status": "preflight"}
    if sized["resolved"]:
        line["resolved"] = sized["resolved"]
    if sized["size_bytes"] is None:
        line["note"] = f"{sized['note']}; skipping the free-space check"
        return line
    size_bytes = sized["size_bytes"]
    # A sized pull can still carry the source's own note (the registry's
    # config blob unreadable, say); it is kept, never overwritten below.
    notes = [sized["note"]] if sized.get("note") else []
    try:
        stat = os.statvfs(MODELS_DIR)
        free_bytes = stat.f_bavail * stat.f_frsize
    except OSError as exc:
        notes.append(f"could not check free space — {exc}")
        line["note"] = "; ".join(notes)
        line["size_bytes"] = size_bytes
        line["size_source"] = sized["size_source"]
        return line
    if notes:
        line["note"] = "; ".join(notes)
    line.update(
        {
            "required_gb": round(size_bytes / (1024**3), 2),
            "free_gb": round(free_bytes / (1024**3), 1),
            "ok": free_bytes >= size_bytes,
            "size_bytes": size_bytes,
            "size_source": sized["size_source"],
        }
    )
    return line


@router.post("/pull")
async def pull(request: Request) -> Response:
    body = await request.json()
    model = body.get("model") if isinstance(body, dict) else None
    if not model:
        raise HTTPException(status_code=400, detail="model is required")
    try:
        model = pulls_mod.validate_model(model)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    key = pulls_mod.canonical_ref(model)
    started_at = _PULLS_IN_FLIGHT.get(key)
    if started_at is not None:
        raise HTTPException(
            status_code=409,
            detail=f"a pull of {model!r} has been in flight since {started_at} — "
            "wait for it to finish",
        )
    _PULLS_IN_FLIGHT[key] = datetime.now(UTC).isoformat()
    # Until the relay takes over, this frame owns the release.
    released = False
    try:
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

        # Sized BEFORE the stream opens, so the first line is the size and
        # the download never starts in the dark; bounded inside pull_size.
        preflight = await _preflight_line(request.app, model)

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
                _PULLS_IN_FLIGHT.pop(key, None)

        released = True
        return StreamingResponse(
            relay(), media_type=upstream.headers.get("content-type") or "application/x-ndjson"
        )
    finally:
        if not released:
            _PULLS_IN_FLIGHT.pop(key, None)


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
        stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=NVIDIA_SMI_TIMEOUT_S)
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
    row, target_model = await providers.resolve(pool, model)
    kind = backends.kind_of(row)

    ok = True
    error: str | None = None
    latency_ms: int | None = None
    vram_mb: int | None = None
    started = time.monotonic()

    # The probe rides the SAME adapter a chat turn would — an Anthropic
    # default is probed through the Messages API, an ollama default through
    # its /v1 — so "the probe passed" means the chat path works, not that
    # some other URL answered.
    probe_body = {
        "model": target_model,
        "messages": [{"role": "user", "content": "hi"}],
        "max_tokens": 1,
        "stream": False,
    }
    probe_content = b""
    probe_status: int | None = None
    try:
        response = await adapters.for_row(row).completions(request, row, target_model, probe_body)
        status = response.status_code
        content = b""
        iterator = getattr(response, "body_iterator", None)
        if iterator is not None:
            async for chunk in iterator:
                content += chunk if isinstance(chunk, bytes) else str(chunk).encode()
        else:
            content = response.body
        probe_content, probe_status = content, status
        latency_ms = int((time.monotonic() - started) * 1000)
        if status != 200:
            ok = False
            error = f"HTTP {status}: {content.decode(errors='replace')[:400]}"
        elif content.lstrip().startswith(b"data:") and b'"error"' in content:
            # A stream that carried an OpenAI-shaped error chunk answered,
            # but not with a completion.
            ok = False
            error = content.decode(errors="replace")[:400]
        elif kind == "ollama":
            # Only meaningful for a local ollama model — a remote/cloud
            # backend consumes no VRAM on this host at all. Read AFTER the
            # request answers (never a before/after delta — see
            # `_footprint_vram_mb`'s docstring for why that was wrong).
            vram_mb = await _footprint_vram_mb()
    except adapters.ProviderRefused as exc:
        ok = False
        error = exc.detail
        latency_ms = int((time.monotonic() - started) * 1000)
    except httpx.HTTPError as exc:
        ok = False
        error = backends.reason(exc)
        latency_ms = int((time.monotonic() - started) * 1000)

    # The probe is a call the provider served (or refused): a ledger row too.
    await usage.record_probe(
        pool,
        row=row,
        model=target_model,
        status=probe_status if probe_status is not None else 502,
        body=probe_content,
        started=started,
        purpose="probe",
        error=error,
    )
    row_out = await pool.fetchrow(
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
    return dict(row_out)


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
        verdict = await backends.verify_live(request.app, body)
    except backends.VerificationFailed as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc

    pool = await db.get_pool()
    saved = await backends.save_config(pool, body, verdict=verdict)
    # Never log the payload itself — api_key lives in it.
    logger.info("backend config saved: kind=%s", saved["kind"])
    return backends.to_public(saved)


# ── the provider registry (S10-pre) ──────────────────────────────────────


def _provider_404(name: str) -> HTTPException:
    return HTTPException(status_code=404, detail=f"no provider named {name!r}")


async def _record_prices_after_save(pool, saved: dict, shape: dict) -> None:
    """The listing verify already fetched, priced and kept (S10): a chat
    call is priced from stored rows and never fetches a listing itself.
    No second call to the provider — the save's own listing is enough."""
    models = shape.get("_listing_models")
    if not models:
        return
    try:
        await usage.record_listing_prices(pool, saved, models)
    except Exception:  # noqa: BLE001 — stated on the page, never a save failure
        logger.exception("could not record listing prices for %s", saved.get("name"))


async def _verify_or_502(app, name: str, shape: dict) -> dict:
    """Run the adapter's verify-before-save; a refusal is a 502 with the
    provider's own reason and NOTHING is written."""
    row = dict(shape, name=name)
    try:
        result = await adapters.for_row(row).verify(app, row)
    except adapters.ProviderRefused as exc:
        raise HTTPException(
            status_code=502,
            detail=f"could not verify provider {name!r} — {exc.detail}",
        ) from exc
    return dict(
        shape,
        listing=result.listing,
        listing_note=result.note,
        key_proven=result.key_proven,
        verify_note=result.note,
        _listing_models=result.models,
        # verified_at is stamped ONLY here and in the wizard path — the two
        # places a verify actually ran. A save with no verdict has none.
        verified=True,
    )


async def _refuse_name_that_shadows_a_local_tag(app, pool, name: str) -> None:
    """A model id is split on its FIRST colon against the provider names, so
    a provider called `mistral` would turn the local tag `mistral:7b` into
    "model 7b on Mistral's cloud". Checked against what the bundled ollama
    LISTS right now — derived, never a maintained list — and a listing that
    cannot be read is a stated refusal, not a skipped check."""
    builtin = await providers.get_row(pool, "ollama")
    try:
        listing = await adapters.for_row(builtin).list_models(app, builtin)
    except adapters.ProviderRefused as exc:
        raise HTTPException(
            status_code=502,
            detail=f"cannot check {name!r} against the local model tags — {exc.detail}",
        ) from exc
    shadowed = sorted(
        m["id"] for m in listing.models if m["id"].partition(":")[0] == name and ":" in m["id"]
    )
    if shadowed:
        raise HTTPException(
            status_code=409,
            detail=f"{name!r} would shadow the local model tag(s) {', '.join(shadowed)} — "
            f"a bare id like {shadowed[0]!r} would stop meaning the local model; pick another name",
        )


@router.get("/providers")
async def list_providers() -> dict:
    pool = await db.get_pool()
    rows = await providers.list_rows(pool)
    return {"providers": [providers.to_public(row) for row in rows]}


@router.get("/providers/presets")
async def provider_presets() -> dict:
    return {"presets": providers.load_presets()}


@router.post("/providers")
async def create_provider(request: Request) -> dict:
    body = await request.json()
    if not isinstance(body, dict):
        raise HTTPException(status_code=400, detail="request body must be a JSON object")
    name = providers.validate_name(body.get("name"))
    if name == "ollama":
        raise HTTPException(status_code=409, detail="'ollama' is the builtin provider")
    pool = await db.get_pool()
    try:
        await providers.get_row(pool, name)
    except providers.UnknownProvider:
        pass
    else:
        raise HTTPException(status_code=409, detail=f"a provider named {name!r} already exists")
    await _refuse_name_that_shadows_a_local_tag(request.app, pool, name)
    shape = providers.validate_shape(body)
    shape = await _verify_or_502(request.app, name, shape)
    saved = await providers.insert_row(pool, name, shape)
    await _record_prices_after_save(pool, saved, shape)
    if saved.get("adapter") == "anthropic-messages":
        # Its listing states no prices: the dated curated list is what
        # prices its calls until the owner enters one.
        try:
            await usage.seed_curated_prices(pool)
        except usage.CuratedPricesInvalid:
            logger.exception("curated_prices.json is invalid — %s stays unpriced", name)
    # Never log the payload itself — api_key lives in it.
    logger.info("provider saved: name=%s adapter=%s", saved["name"], saved["adapter"])
    return providers.to_public(saved)


@router.get("/providers/{name}")
async def get_provider(name: str) -> dict:
    pool = await db.get_pool()
    try:
        return providers.to_public(await providers.get_row(pool, name))
    except providers.UnknownProvider:
        raise _provider_404(name) from None


@router.put("/providers/{name}")
async def update_provider(name: str, request: Request) -> dict:
    body = await request.json()
    pool = await db.get_pool()
    try:
        existing = await providers.get_row(pool, name)
    except providers.UnknownProvider:
        raise _provider_404(name) from None
    if existing["builtin"]:
        raise HTTPException(
            status_code=400,
            detail="the bundled ollama provider is configured by the install, not edited",
        )
    shape = providers.validate_shape(body, existing=existing)
    shape = await _verify_or_502(request.app, name, shape)
    saved = await providers.update_row(pool, name, shape)
    await _record_prices_after_save(pool, saved, shape)
    logger.info("provider updated: name=%s adapter=%s", saved["name"], saved["adapter"])
    return providers.to_public(saved)


@router.delete("/providers/{name}")
async def delete_provider(name: str) -> dict:
    pool = await db.get_pool()
    try:
        await providers.delete_row(pool, name)
    except providers.UnknownProvider:
        raise _provider_404(name) from None
    logger.info("provider deleted: name=%s", name)
    return {"deleted": name}


@router.put("/providers/{name}/default")
async def make_default(name: str) -> dict:
    pool = await db.get_pool()
    try:
        row = await providers.set_default(pool, name)
    except providers.UnknownProvider:
        raise _provider_404(name) from None
    logger.info("default provider: %s", name)
    return providers.to_public(row)


@router.get("/providers/{name}/models")
async def provider_models(name: str, request: Request) -> dict:
    """The provider's LIVE model list, labelled with its source and fetch
    time. What it learns about the listing is recorded on the row."""
    pool = await db.get_pool()
    try:
        row = await providers.get_row(pool, name)
    except providers.UnknownProvider:
        raise _provider_404(name) from None
    try:
        listing = await _listing_for(request.app, pool, row)
    except adapters.ListingUnavailable as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except adapters.ProviderRefused as exc:
        raise HTTPException(status_code=exc.status, detail=exc.detail) from exc
    return listing.as_dict()


async def _listing_for(app, pool, row: dict) -> adapters.Listing:
    """A provider's live listing, and what it learned recorded on the row —
    the ONE path both /admin/providers/{name}/models and the catalogue use,
    so the row's listing state is the same fact whichever asked. Raises the
    adapter's own ListingUnavailable / ProviderRefused."""
    name = row["name"]
    try:
        listing = await adapters.for_row(row).list_models(app, row)
    except adapters.ListingUnavailable as exc:
        await providers.record_listing(pool, name, "unavailable", str(exc))
        raise
    except adapters.ProviderRefused as exc:
        # The row's listing claim is no longer known to hold — say so on it.
        await providers.record_listing(
            pool, name, "unknown", f"the last listing was refused ({exc.status}): {exc.detail}"
        )
        raise
    await providers.record_listing(pool, name, "available", f"{len(listing.models)} models listed")
    # The listing's prices, kept: a chat call never fetches a listing to be priced.
    try:
        await usage.record_listing_prices(pool, row, listing.models)
    except Exception:
        logger.exception("could not record listing prices for %s", name)
    return listing


# ── the model catalogue (S10a) ────────────────────────────────────────────


# ── spend (S10) ────────────────────────────────────────────────────────────


def _timezone_of(request: Request) -> str:
    return usage.valid_timezone(request.headers.get(usage.HEADER_TIMEZONE))


@router.get("/spend")
async def spend_report(request: Request) -> dict:
    """The ledger rolled up over a window (today | 7d | 30d | month) in the
    owner's zone (`X-Nova-Timezone`; UTC when absent, and the answer says
    which). Every dollar carries the basis it was recorded with."""
    window = request.query_params.get("window") or "month"
    try:
        return await usage.report(await db.get_pool(), window, _timezone_of(request))
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.get("/spend/events")
async def spend_events(request: Request) -> dict:
    params = request.query_params
    try:
        limit = int(params.get("limit") or 50)
        before = int(params["before"]) if params.get("before") else None
    except ValueError:
        raise HTTPException(status_code=400, detail="limit and before must be integers") from None
    rows = await usage.events(
        await db.get_pool(), limit=limit, before=before, provider=params.get("provider") or None
    )
    return {"events": rows, "ledger_write_failures": usage.WRITE_FAILURES}


@router.get("/spend/caps")
async def spend_caps(request: Request) -> dict:
    pool = await db.get_pool()
    limits = await usage.caps(pool)
    since = usage.month_start(datetime.now(UTC), _timezone_of(request))
    out = []
    for provider_name, cap in sorted(limits.items()):
        used = await usage.spent(
            pool, None if provider_name == usage.TOTAL_CAP else provider_name, since
        )
        out.append(
            {
                "provider": provider_name,
                "monthly_usd": float(cap) if cap is not None else None,
                "spent_usd": float(used),
                "remaining_usd": float(cap - used) if cap is not None else None,
            }
        )
    return {"caps": out, "month_since": since.isoformat(), "timezone": _timezone_of(request)}


@router.put("/spend/caps")
async def put_spend_cap(request: Request) -> dict:
    """{provider, monthly_usd | null}. '*' is the total across every cloud
    provider; a local provider cannot be capped in USD (it has none)."""
    body = await request.json() if await request.body() else {}
    provider_name = body.get("provider") if isinstance(body, dict) else None
    if not provider_name:
        raise HTTPException(status_code=400, detail="provider is required ('*' for the total)")
    pool = await db.get_pool()
    if provider_name != usage.TOTAL_CAP:
        try:
            row = await providers.get_row(pool, provider_name)
        except providers.UnknownProvider:
            raise HTTPException(
                status_code=404, detail=f"no provider named {provider_name!r}"
            ) from None
        if row.get("local"):
            raise HTTPException(
                status_code=400,
                detail=f"{provider_name!r} is local — GPU time is not capped in USD",
            )
    raw = body.get("monthly_usd")
    if raw is None:
        cap = None
    else:
        try:
            cap = Decimal(str(raw))
        except (ArithmeticError, ValueError):
            raise HTTPException(
                status_code=400, detail="monthly_usd must be a number or null"
            ) from None
        if cap < 0:
            raise HTTPException(status_code=400, detail="monthly_usd must not be negative")
    await usage.set_cap(pool, provider_name, cap)
    logger.info("spend cap set: %s = %s", provider_name, cap)
    return {"provider": provider_name, "monthly_usd": float(cap) if cap is not None else None}


@router.get("/spend/prices")
async def spend_prices() -> dict:
    return {"prices": await usage.prices(await db.get_pool())}


@router.put("/spend/prices")
async def put_owner_price(request: Request) -> dict:
    """{provider, model, prompt_usd_per_token, completion_usd_per_token} —
    the owner's own price for a model whose listing states none. Wins over
    listing and curated rows; said so wherever it is used."""
    body = await request.json() if await request.body() else {}
    if not isinstance(body, dict) or not body.get("provider") or not body.get("model"):
        raise HTTPException(status_code=400, detail="provider and model are required")
    pool = await db.get_pool()
    try:
        await providers.get_row(pool, body["provider"])
    except providers.UnknownProvider:
        raise HTTPException(
            status_code=404, detail=f"no provider named {body['provider']!r}"
        ) from None
    try:
        prompt = Decimal(str(body.get("prompt_usd_per_token")))
        completion = Decimal(str(body.get("completion_usd_per_token")))
    except (ArithmeticError, ValueError, TypeError):
        raise HTTPException(
            status_code=400, detail="prices must be numbers (USD per token)"
        ) from None
    if prompt < 0 or completion < 0:
        raise HTTPException(status_code=400, detail="prices must not be negative")
    await usage.set_owner_price(pool, body["provider"], body["model"], prompt, completion)
    return {"provider": body["provider"], "model": body["model"], "basis": "owner"}


@router.delete("/spend/prices")
async def delete_owner_price(request: Request) -> dict:
    provider_name = request.query_params.get("provider") or ""
    model = request.query_params.get("model") or ""
    if not provider_name or not model:
        raise HTTPException(status_code=400, detail="provider and model are required")
    removed = await usage.delete_owner_price(await db.get_pool(), provider_name, model)
    if not removed:
        raise HTTPException(status_code=404, detail="no owner price for that model")
    return {"provider": provider_name, "model": model, "removed": True}


@router.get("/catalog")
async def catalog_route(request: Request) -> dict:
    """Every model Nova can run or reach, in one row shape, every fact
    labelled with its source and fetch time (app/catalog.py)."""
    pool = await db.get_pool()
    return await catalog.build(
        request.app,
        pool,
        fit_context=_fit_context,
        listing_for=_listing_for,
        latest_probes=_latest_probes,
    )


def _rate_limited(exc: hf_hub.RateLimited) -> JSONResponse:
    """A 429 whose BODY carries retry_after_s: core forwards bodies, not
    headers, so the page would otherwise see the words without the time."""
    return JSONResponse(
        status_code=429,
        content={"error": exc.detail, "retry_after_s": exc.retry_after_s},
        headers={"Retry-After": str(exc.retry_after_s)},
    )


@router.get("/catalog/hf")
async def catalog_hf(request: Request) -> dict:
    """A page of Hugging Face GGUF repos as catalogue rows. A rate limit is
    a 429 in the Hub's words with retry_after_s; a bad parameter is a 400."""
    params = request.query_params
    try:
        limit = int(params.get("limit") or 30)
    except ValueError:
        raise HTTPException(status_code=400, detail="limit must be an integer") from None
    try:
        page = await hf_hub.search(
            request.app,
            query=params.get("q") or "",
            sort=params.get("sort") or "downloads",
            cursor=params.get("cursor") or None,
            limit=limit,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except hf_hub.RateLimited as exc:
        return _rate_limited(exc)
    except adapters.ProviderRefused as exc:
        raise HTTPException(status_code=exc.status, detail=exc.detail) from exc
    installed = await catalog.installed_names(request.app, await db.get_pool())
    return {
        "rows": catalog.hf_page_rows(page, installed),
        "next_cursor": page.next_cursor,
        "fetched_at": page.fetched_at,
        "cached": page.cached,
        "budget": page.budget,
    }


@router.get("/catalog/hf/{org}/{repo}")
async def catalog_hf_repo(org: str, repo: str, request: Request) -> dict:
    """One Hub repo as a catalogue row with its `pull.quants` — the GGUF
    files the repo actually lists, sized, the default marked."""
    try:
        org, repo = hf_hub.validate_repo_ref(org, repo)
        detail = await hf_hub.repo_detail(request.app, org, repo)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except hf_hub.RateLimited as exc:
        return _rate_limited(exc)
    except adapters.ProviderRefused as exc:
        raise HTTPException(status_code=exc.status, detail=exc.detail) from exc
    installed = await catalog.installed_names(request.app, await db.get_pool())
    return catalog.hf_repo_row(detail, installed)


@router.delete("/models")
async def remove_model(request: Request) -> dict:
    """Remove an installed model from the bundled ollama (`?model=`). The
    answer is VERIFIED: after ollama's 200, /api/tags is re-read and the
    name must be gone — a 200 that still lists the model is a stated 502,
    never "removed". Never touches a cloud model (nothing to remove) and
    refuses a name that is not installed with ollama's own 404."""
    model = request.query_params.get("model") or ""
    try:
        model = pulls_mod.validate_model(model)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    pool = await db.get_pool()
    builtin = await providers.get_row(pool, "ollama")
    base_url = providers.base_url_of(builtin)
    try:
        before = await ollama.ADAPTER.list_models(request.app, builtin)
        name = catalog.installed_name(before.models, model)
        if name is None:
            raise HTTPException(status_code=404, detail=f"{model!r} is not installed")
        await ollama.delete(request.app, base_url, name)
        after = await ollama.ADAPTER.list_models(request.app, builtin)
    except adapters.ProviderRefused as exc:
        raise HTTPException(status_code=exc.status, detail=exc.detail) from exc
    if catalog.installed_name(after.models, name) is not None:
        raise HTTPException(
            status_code=502,
            detail=f"ollama answered 200 to the delete but /api/tags still lists {name!r}",
        )
    logger.info("model removed: %s", name)
    return {"removed": name, "verified": True, "installed_now": len(after.models)}


@router.post("/catalog/drift")
async def catalog_drift(request: Request) -> dict:
    """Has the source moved since this model was pulled? Installed weights
    digest vs the source's current one (app/catalog.py: check_drift).
    Never pulls. `moved` is null with a note when a side could not be read."""
    body = await request.json() if await request.body() else {}
    model = body.get("model") if isinstance(body, dict) else None
    if not model:
        raise HTTPException(status_code=400, detail="model is required")
    try:
        return await catalog.check_drift(request.app, await db.get_pool(), model)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except catalog.NotInstalled as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except adapters.ProviderRefused as exc:
        raise HTTPException(status_code=exc.status, detail=exc.detail) from exc


@router.get("/catalog/resolve")
async def catalog_resolve(request: Request) -> dict:
    """What a typed ref (`qwen3:4b`, `user/name:tag`, `hf.co/org/repo[:q]`)
    would pull, resolved live before any bytes move."""
    model = request.query_params.get("model") or ""
    try:
        return await catalog.resolve_ref(request.app, model)
    except (ValueError, ollama_registry.NotARegistryRef) as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except hf_hub.RateLimited as exc:
        return _rate_limited(exc)
    except adapters.ProviderRefused as exc:
        raise HTTPException(status_code=exc.status, detail=exc.detail) from exc
