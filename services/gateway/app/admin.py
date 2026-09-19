"""The admin plane: hardware detection, model suggestions, pulling ollama
models, one-shot probes, and the single active backend's config.

Paths are pinned by SDD ledger Ruling R8 — core calls these exact routes
and forwards nothing but the body, so none of them takes a query
parameter in S1.
"""

from __future__ import annotations

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

from app import (
    adapters,
    backends,
    catalog,
    compute_id,
    db,
    devices_vram,
    engines,
    hf_hub,
    machine,
    ollama_registry,
    providers,
    routing,
    usage,
)
from app import curated as curated_mod
from app import fit as fit_mod
from app import pulls as pulls_mod
from app import suggest as suggest_mod
from app.adapters import ollama

router = APIRouter(prefix="/admin", tags=["admin"])
logger = logging.getLogger("gateway")

# Ruling R2: install.sh writes <repo>/data/hardware.json on the host; the
# compose file mounts that directory read-only into this container at /data.
#
# S22 demoted this file to ONE job: suggesting a model tier during install,
# on a machine where nothing is running yet and there is nothing live to
# read. It is a record of what the host looked like when install.sh ran, so
# no SERVING decision may consult it — fit, routing and the health tool all
# read the card through app/devices_vram.py instead.
# tests/test_hardware_json_not_in_serving_path.py is the line of code that
# refuses the day someone wires it back in.
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


@router.get("/machine")
async def machine_route() -> dict:
    """RAM, CPU and disk as they are RIGHT NOW (2026-09-16).

    Deliberately separate from /hardware, which serves install.sh's
    one-time `hardware.json` — the right answer to "what is this box" and
    the wrong answer to every question asked while watching a slow turn.
    Read every call; cached nowhere; each field degrades on its own with a
    stated reason rather than a zero.
    """
    return machine.read()


@router.get("/hardware")
async def hardware() -> dict:
    data, note = _read_hardware()
    if note is not None:
        return {"gpus": data.get("gpus", []), "note": note}
    return data


async def _resident_models(app, row: dict) -> tuple[list[dict] | None, str | None]:
    """(every model THIS ENGINE's /api/ps reports resident, reason-if-unreadable).

    Each entry is `{"model", "vram_mb", "size", "size_vram"}` — a per-model
    TABLE, not a pre-summed total, because two callers need the rows
    themselves: `fit.free_gb_after_switch` adds back what a switch would
    evict, and `_footprint` picks out the ONE model that just answered. It is
    also the only per-model VRAM figure on this host that can be attributed
    to anything: the card's own counter sees every process and, under WSL2,
    can name none of them.

    S40: read from the ENGINE's own address, so sizing or probing `dell:x`
    never reads the hub's /api/ps, and through the one /api/ps reader
    (engines.resident, ruling C2), whose entries keep ollama's own `size` /
    `size_vram` — the two numbers the D10 stamp decides offload from.
    """
    return await engines.resident(app, row)


async def _free_and_total_vram_gb(
    app, row: dict
) -> tuple[float | None, float | None, str | None, devices_vram.Vram]:
    """(free_gb, total_gb, reason-if-free-is-unknown, the card reading) for
    ONE engine — read from the card.

    Both numbers come from ONE live `nvidia-smi` call (app/devices_vram.py)
    at the moment of the question. Not hardware.json: that file is written
    once by install.sh and never refreshed, and a fit decision made from it
    is a decision about a machine as it was at install time. Owner ruling
    2026-09-14, after a video game held 7 GB of this card for six hours
    while the product reported 24 GB free: "Nova should do the work ad-hoc
    to get the resources live, not read stale shit."

    `free_gb` answers "how much would be available AFTER a switch", not
    "how much is unused this instant" — ruling S2f-R2, see app/fit.py: a
    local model switch evicts whatever ollama holds resident, so the card's
    live free memory has the resident table added back to it. ollama's
    /api/ps is read for that, and its reachability IS part of the answer:
    unreachable means free-after-switch is unknown, which is a different
    fact from "free is whatever is unused now".

    Note the asymmetry, and that it is deliberate: `total_gb` survives every
    degrade below, because the card's capacity is known the moment
    nvidia-smi answers and does not depend on ollama at all.

    S40: the question is about an ENGINE, not about whichever provider is
    the default — a cloud default no longer hides the hub's card (before
    S40 this answered "the active backend is remote … free VRAM isn't
    observable" while the bundled engine sat holding 17 GB). The hub reads
    exactly one card, its own: another machine's is on that machine, and
    reading this one for it would describe the hub's GPU as that machine's
    (engines.NOT_THIS_CARD) — a stated unknown until its agent reports it
    (S44). (GET /admin/vram, which answered the same question for "the
    active backend", was deleted in S40; its card lives on GET
    /admin/engines/{name}.)
    """
    if not row.get("builtin"):
        vram = devices_vram.Vram(reason=engines.NOT_THIS_CARD.format(name=row["name"]))
        return None, None, vram.reason, vram
    vram = await devices_vram.read_vram()
    if not vram.known:
        return None, None, vram.reason or "the GPU could not be read", vram
    total_gb = vram.total_mb / 1024
    resident, reason = await _resident_models(app, row)
    if resident is None:
        return None, total_gb, reason, vram
    return fit_mod.free_gb_after_switch(vram.free_mb, resident), total_gb, None, vram


async def _latest_probes(pool, slugs: list[str], *, compute: str | None) -> dict[str, dict]:
    """The newest OK probe row per slug, IN THE CURRENT FRAME, TAKEN ON `compute`.

    A failed probe (ok=false) never counts as a measurement, and an older
    successful one loses to a newer one for the same model.

    `frame = 'model'` is the S22 filter and it is not a formality. Rows
    written before this slice hold a WHOLE-CARD nvidia-smi reading — the
    desktop baseline plus the model — and in the current frame they read
    about 2.6 GB too high. The 27B's old 21.8 GB reading made it `wont_fit`
    on a card where it demonstrably runs, caught on the live stack minutes
    after deploying. The rows stay (they are a ledger, and they were true);
    a fit decision just may not read them. A model with no reading in this
    frame falls back to its download size or the curated estimate until it
    is re-probed, which is the honest answer: nobody has measured it the way
    we now measure.

    `compute = $2` is S40's (D10: fit is keyed by (compute, model)). A reading
    belongs to the card that held it: one from another card, or from before
    migration 009 with no compute at all, is not a measurement of THIS
    engine's card and is never read — the model falls back to its download
    size or the curated estimate until it is re-probed, exactly as 008 did.
    A partly-offloaded probe is stamped `cpu:…+gpu:…` and so never matches a
    card either: its size_vram understates what the model needs. `compute`
    None (a card that cannot be named) reads nothing — omitted, never guessed.
    """
    if not slugs or compute is None:
        return {}
    rows = await pool.fetch(
        "SELECT DISTINCT ON (model) model, vram_mb, created_at FROM probes "
        "WHERE model = ANY($1) AND compute = $2 AND ok = true AND vram_mb IS NOT NULL "
        "AND frame = 'model' "
        "ORDER BY model, created_at DESC",
        slugs,
        compute,
    )
    return {row["model"]: dict(row) for row in rows}


async def _fit_context(app, pool, row: dict | None = None) -> dict:
    """The numbers every fit verdict for ONE engine is computed against —
    read once per request and shared by /admin/suggest, the catalogue and
    the routing standby, so no two surfaces disagree about the same card or
    about how big a model is.

    `row` is the engine; None means the builtin (what /admin/suggest asks
    about). `compute` is the D10 id a model fully resident on this engine is
    stamped with — the key `_latest_probes` reads by — and `sizes` is this
    engine's installed download bytes from its /api/tags. Both come from ONE
    engines.observe (cached as observe caches, ruling C4), so the fit key is
    the same fact GET /admin/engines states. `fit_frame` says which memory
    the verdicts are about (engines.fit_frame): None for a machine whose
    card this hub cannot read. S40 computes verdicts in the `vram` frame
    only; a `ram` frame's verdicts stay `unknown` with the card's own reason
    until a CPU engine exists to walk it (S44/S45).
    """
    if row is None:
        row = await engines.get(pool, engines.BUILTIN)
    view = await engines.observe(app, pool, row, live=False)
    free_gb, total_gb, reason, vram = await _free_and_total_vram_gb(app, row)
    return {
        "engine": row["name"],
        "compute": view.compute,
        "fit_frame": engines.fit_frame(row, vram.as_dict() if row.get("builtin") else None),
        "free_gb": free_gb,
        "total_gb": total_gb,
        "reason": reason,
        "sizes": view.tags or {},
    }


@router.get("/suggest")
async def suggest_route(request: Request) -> dict:
    pool = await db.get_pool()
    ctx = await _fit_context(request.app, pool)
    # The tier prefers the live card and falls back to hardware.json only
    # when nvidia-smi could not be reached at all — which is the install-time
    # case that file exists for. `_fit_context` already read the card once
    # this request; its `total_gb` IS that reading, so the tier and the fit
    # verdicts below cannot disagree about the same GPU.
    data, _note = _read_hardware()
    result = suggest_mod.suggest(data, curated_mod.load_curated(), ctx["total_gb"])

    probes_by_model = await _latest_probes(
        pool, [m["slug"] for m in result["models"]], compute=ctx["compute"]
    )

    for model in result["models"]:
        needed_gb, source = fit_mod.needed_gb_for(
            model, probes_by_model.get(model["slug"]), ctx["sizes"].get(model["slug"])
        )
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
        if sized.get("absent"):
            # The registry stated the tag does not exist. Carried through rather
            # than folded into the note, so the caller refuses on a FACT instead
            # of matching words in a sentence (S15).
            line["absent"] = True
            line["note"] = sized["note"]
            return line
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
        if preflight.get("absent"):
            # The registry has already said this tag does not exist, so opening
            # a stream to ollama can only fail there, in ollama's words, after
            # the download has apparently begun. Refuse before the act (rail 9)
            # and offer the spellings this box actually vouches for — the
            # registry cannot be enumerated, so the curated file is the only
            # honest source, and the sentence says so (S15: the owner asked for
            # `gemma4:26b-a4b`, which is not a tag; `gemma4:26b` is).
            alternatives = pulls_mod.near_misses(model)
            suffix = (
                f" — the curated list has {', '.join(alternatives)}"
                if alternatives
                else " — nothing in the curated list shares that name either"
            )
            raise HTTPException(status_code=404, detail=f"{preflight['note']}{suffix}")

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


async def _footprint(app, row: dict, model: str) -> dict | None:
    """The just-answered model's own /api/ps entry on THIS engine:
    `{"vram_mb": int | None, "size", "size_vram"}` — one reading, so the
    VRAM figure and the D10 stamp (compute_id.served_on, which decides
    offload from exactly `size` and `size_vram`) describe the same instant.
    `vram_mb` is ollama's `size_vram` for the model that just answered, in
    MiB.

    THE FRAME (S22, see app/fit.py): `needed_gb` is what the MODEL costs —
    weights plus its KV cache at the serving context — never the machine's
    whole-card usage. The baseline the desktop always holds lives on the
    FREE side now, because free VRAM is read from the card and the driver
    has already subtracted it there. So the probe records the one number on
    this host that is genuinely attributable to a single model, rather than
    an undirected nvidia-smi reading that conflates every process on the
    machine and, under WSL2, cannot name any of them.

    That attribution is not academic. It is precisely what a raw used-MiB
    reading got wrong on 2026-09-12: a game held 7 GB of this card, and a
    probe taken during it would have recorded 7 GB of somebody else's
    texture memory as the model's footprint and stored it as `verified`.

    Read AFTER the completion answers, so the model is certainly resident.
    Eviction-immune by construction: whatever just served the request is
    what /api/ps names, regardless of what was loaded before it. A model
    that is not in the table (evicted between the answer and this read, or
    an engine that reports no size_vram) is None — unknown, never zero.

    S40: read from THIS engine's /api/ps (the one reader, engines.resident),
    never the default provider's address — probing hub:x while a cloud
    provider is the default is still a question about the hub, and probing
    dell:x never reads the hub's table. A non-positive size_vram is not a
    VRAM measurement (vram_mb None) but IS the fact the stamp reads: the
    model is wholly in system memory.
    """
    resident, _reason = await _resident_models(app, row)
    for entry in resident or []:
        if entry.get("model") == model:
            vram_mb = entry.get("vram_mb")
            # A resident model always occupies SOME VRAM; a non-positive
            # figure means the engine's own accounting is unreliable right
            # now, which is not a measurement.
            return {
                "vram_mb": int(vram_mb) if vram_mb and vram_mb > 0 else None,
                "size": entry.get("size"),
                "size_vram": entry.get("size_vram"),
            }
    return None


@router.post("/probe")
async def probe(request: Request) -> dict:
    body = await request.json()
    model = body.get("model")
    if not model:
        raise HTTPException(status_code=400, detail="model is required")

    pool = await db.get_pool()
    row, target_model = await providers.resolve(pool, model)
    kind = backends.kind_of(row)
    on_engine = engines.is_engine(row)
    # Where the call ran, on the row (D10). The engine's name always. The
    # bundled engine is by definition the container on the compose network
    # (D8/D9), so its runtime and path are known; another machine's arrive
    # with its agent (S44) — absent until then, never guessed. A cloud call
    # ran on no device of this host: all three stay None.
    bundled = on_engine and bool(row.get("builtin"))
    runtime = engines.BUILTIN_RUNTIME if bundled else None
    path = "internal" if bundled else None
    compute: str | None = None

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
        elif on_engine:
            # Only meaningful for an engine — a remote/cloud backend consumes
            # no VRAM on any machine here. Read AFTER the request answers, so
            # the model is certainly resident, from THIS engine's /api/ps —
            # never the default provider's address.
            footprint = await _footprint(request.app, row, target_model)
            if footprint is not None:
                vram_mb = footprint["vram_mb"]
                if bundled:
                    # The hub's devices, read now (the one live reader,
                    # engines.bundled_devices, ruling C1); another machine's
                    # devices are its agent's to state (S44).
                    accelerators, cpu = await engines.bundled_devices()
                    compute = compute_id.served_on(
                        footprint["size"], footprint["size_vram"], accelerators, cpu
                    )
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
        served_on=compute,
    )
    # The row carries where it ran (D10): fit reads a reading only by the
    # compute it was taken on (_latest_probes), and the row is read back
    # (RETURNING), so the answer is what was stored, never what was meant.
    row_out = await pool.fetchrow(
        "INSERT INTO probes (model, kind, ok, latency_ms, vram_mb, error, provider, compute, "
        "runtime, path) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) "
        "RETURNING id, model, kind, ok, latency_ms, vram_mb, error, provider, compute, "
        "runtime, path, created_at",
        target_model,
        kind,
        ok,
        latency_ms,
        vram_mb,
        error,
        row["name"],
        compute,
        runtime,
        path,
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
    builtin = await providers.get_row(pool, providers.BUILTIN)
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
    if name in providers.RESERVED_NAMES:
        raise HTTPException(
            status_code=409,
            detail=f"{name!r} is reserved — {providers.BUILTIN!r} is the bundled engine, "
            f"{providers.LIBRARY!r} names the model library and {providers.LEGACY_BUILTIN!r} "
            "is the name pre-S40 usage rows carry; pick another name",
        )
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


# ── routing (S10-2) ────────────────────────────────────────────────────────


@router.get("/routes")
async def get_routes(request: Request) -> dict:
    """Every role with a chain: the built-ins first (in their own order,
    a row or not), then every other routes row — a derived agent role —
    by name. `builtin` says which is which; `reserved` is unchanged."""
    pool = await db.get_pool()
    chains = await routing.chains(pool)
    walled = await routing.walls(pool)
    derived = sorted(role for role in chains if role not in routing.BUILTIN_ROLES)
    return {
        "roles": [
            {
                "role": role,
                "chain": chains.get(role, []),
                "reserved": role in routing.RESERVED_ROLES,
                "builtin": role in routing.BUILTIN_ROLES,
            }
            for role in (*routing.BUILTIN_ROLES, *derived)
        ],
        "walls": [{**w, "walled_until": w["walled_until"].isoformat()} for w in walled.values()],
    }


@router.put("/routes/{role}")
async def put_route(role: str, request: Request) -> dict:
    """{chain: [provider:model, ...]} — validated against the live provider
    names before anything is stored; a bad link is refused by name."""
    body = await request.json() if await request.body() else {}
    pool = await db.get_pool()
    names = {r["name"] for r in await providers.list_rows(pool)}
    try:
        chain = await routing.set_chain(
            pool, role, body.get("chain") if isinstance(body, dict) else None, names
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    logger.info("route set: %s = %s", role, chain)
    return {"role": role, "chain": chain}


@router.get("/route/explain")
async def route_explain(request: Request) -> dict:
    """The walk a call with `?role=` (and optionally `?model=`, the explicit
    pick) would take right now: every link's live verdict and what would
    serve. Reads only; nothing is called, nothing is charged."""
    role = request.query_params.get("role") or "chat"
    try:
        routing.validate_role(role)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return await routing.explain(
        request.app,
        await db.get_pool(),
        role=role,
        requested=request.query_params.get("model") or None,
        timezone=_timezone_of(request),
        fit_context=_fit_context,
        latest_probes=_latest_probes,
    )


@router.delete("/routes/walls/{provider}")
async def clear_wall(provider: str) -> dict:
    """The owner lifts a wall (an act, logged): the next call will try it."""
    removed = await routing.clear_wall(await db.get_pool(), provider)
    if not removed:
        raise HTTPException(status_code=404, detail=f"{provider!r} is not walled")
    logger.info("wall cleared by the owner: %s", provider)
    return {"provider": provider, "cleared": True}


@router.delete("/routes/{role}")
async def delete_route(role: str) -> dict:
    """Drop a derived role's chain (its agent is gone, or the owner set it
    by mistake). A built-in is never removed — PUT it to [] instead. The
    answer reads the row count: no row is a 404, never "deleted"."""
    if role in routing.BUILTIN_ROLES:
        raise HTTPException(
            status_code=400, detail=f"{role} is a built-in role and cannot be removed"
        )
    removed = await routing.delete_chain(await db.get_pool(), role)
    if not removed:
        raise HTTPException(status_code=404, detail=f"no route for role {role!r}")
    logger.info("route removed: %s", role)
    return {"deleted": role}


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
    builtin = await providers.get_row(pool, providers.BUILTIN)
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
