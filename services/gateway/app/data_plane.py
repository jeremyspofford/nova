"""POST /v1/chat/completions and GET /v1/models — the OpenAI-compat data
plane core speaks.

Routing is by PROVIDER PREFIX and nothing else: the request's `model` is
split on its first colon; a prefix naming a registered provider selects it,
anything else is a bare model on the default provider (app/providers.py).
No retries, no fallback, no substitution — a provider that fails answers
with its own status and reason (rail 20), and the X-Nova-Served-By header
always names the provider that actually served, as `provider:model`.

S40: a completion an ENGINE answered says where it ran — X-Nova-Served-On
(the D10 compute id, from ollama's own /api/ps size/size_vram read after
the engine answered, against the hub's devices as its cached observation
states them) and X-Nova-Served-Runtime — and its ledger row keeps
`served_on`. Not known is omitted, never guessed. An engine that could not
be reached at all (adapters.ProviderUnreachable) is relayed like any
refusal, and never walled.
"""

from __future__ import annotations

import asyncio
import json
import logging
import time
from dataclasses import dataclass

import httpx
from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import Response

from app import adapters, compute_id, db, engines, providers, routing, usage
from app.adapters import ListingUnavailable, ProviderRefused, ProviderUnreachable

router = APIRouter(tags=["data-plane"])
logger = logging.getLogger("gateway")

SERVED_BY_HEADER = "X-Nova-Served-By"
SERVED_ON_HEADER = "X-Nova-Served-On"
SERVED_RUNTIME_HEADER = "X-Nova-Served-Runtime"
ROUTE_HEADER = "X-Nova-Route"
# ollama's /api/ps is local and answers in milliseconds; bounded so a wedged
# engine costs the stamp (omitted), never the reply (S40 ruling C2: 2 s).
STAMP_TIMEOUT = httpx.Timeout(2.0)


class EngineUnreachable(HTTPException):
    """An engine that could not be reached at all (adapters.ProviderUnreachable),
    relayed with the same status and words as any refusal — a caller with no
    role gets its stated 502. serve_by_role tells it apart for one reason: it
    is never a wall (D21)."""


def _served_by(row: dict, model: str) -> str:
    return providers.served_by(row, model)


@router.post("/v1/chat/completions")
async def chat_completions(request: Request) -> Response:
    try:
        body = await request.json()
    except Exception as exc:
        raise HTTPException(
            status_code=400, detail=f"request body is not valid JSON: {exc}"
        ) from exc
    if not isinstance(body, dict):
        raise HTTPException(status_code=400, detail="request body must be a JSON object")

    pool = await db.get_pool()
    requested = body.get("model") if isinstance(body.get("model"), str) else None
    attribution = usage.Attribution.from_headers(request.headers)
    if attribution.role:
        return await serve_by_role(request, pool, attribution.role, requested, body, attribution)
    row, model = await providers.resolve(pool, requested)
    # No role: the explicit model, as before — but a capped provider is
    # refused BEFORE the call (rail 9), a 402 in words, never a substitute.
    capped = await usage.over_cap(pool, row, attribution.timezone)
    if capped:
        await usage.record_probe(
            pool,
            row=row,
            model=model,
            status=402,
            body=b"",
            started=time.monotonic(),
            purpose=attribution.purpose,
            error=capped,
        )
        raise HTTPException(
            status_code=402, detail=capped, headers={SERVED_BY_HEADER: _served_by(row, model)}
        )
    return await serve_completion(request, pool, row, model, body, attribution)


async def serve_by_role(
    request: Request, pool, role: str, requested, body, attribution
) -> Response:
    """Walk the role's chain (app/routing.py). A link that REFUSES before
    streaming is recorded, walled, and the next runnable link is tried in
    this same request — the reply then states the fallback (rail 20). An
    engine that could not be REACHED is recorded and passed over the same
    way, but never walled (D21)."""
    from app import admin  # the fit context and probe query /admin/suggest uses

    skip: set[str] = set()
    unreachable: dict[str, str] = {}
    try:
        routing.validate_role(role)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    for _attempt in range(6):
        try:
            decision = await routing.resolve(
                request.app,
                pool,
                role=role,
                requested=requested,
                timezone=attribution.timezone,
                fit_context=admin._fit_context,
                latest_probes=admin._latest_probes,
                skip=skip,
                unreachable=unreachable,
            )
        except routing.NothingRunnable as exc:
            raise HTTPException(
                status_code=503,
                detail=f"{exc} — " + "; ".join(f"{v['id']}: {v['reason']}" for v in exc.verdicts),
            ) from exc
        link = f"{decision.row['name']}:{decision.model}"
        try:
            response = await serve_completion(
                request,
                pool,
                decision.row,
                decision.model,
                body,
                attribution,
                route=decision.as_route(),
            )
        except EngineUnreachable as exc:
            # Never a wall (D21): passed over for the rest of this request
            # only, in its own words. serve_completion already made the
            # engine's observation be read again (ruling C11).
            unreachable[link] = str(exc.detail)
            continue
        except HTTPException as exc:
            if exc.status_code in routing.WALL_STATUSES or exc.status_code >= 500:
                await routing.record_refusal(
                    pool, decision.row, exc.status_code, str(exc.detail), model=decision.model
                )
                skip.add(link)
                continue
            raise
        if response.status_code in routing.WALL_STATUSES or response.status_code >= 500:
            detail = ""
            body_bytes = getattr(response, "body", b"")
            if body_bytes:
                detail = body_bytes.decode(errors="replace")[:200]
            await routing.record_refusal(
                pool, decision.row, response.status_code, detail, model=decision.model
            )
            skip.add(link)
            continue
        if response.status_code == 200 and not decision.row.get("local"):
            await routing.note_success(pool, decision.row["name"], decision.model)
        response.headers[ROUTE_HEADER] = decision.header()
        return response
    raise HTTPException(
        status_code=503, detail=f"every link in the {role!r} chain refused this request"
    )


async def serve_completion(
    request: Request,
    pool,
    row: dict,
    model: str,
    body: dict,
    attribution,
    route: dict | None = None,
) -> Response:
    """One completion on `row`, METERED: the adapter's response passes
    through usage.observe, which reads the provider's usage off the
    stream, prices it, writes the ledger row when the stream ends, and
    appends the synthetic usage chunk core reads its cost from. A
    refusal is recorded too (kind refusal) before it is raised. A reply
    an engine answered is stamped with where it ran before its first
    byte — headers go first."""
    served_by = _served_by(row, model)
    started = time.monotonic()
    try:
        response = await adapters.for_row(row).completions(request, row, model, body)
    except ProviderRefused as exc:
        await usage.record_probe(
            pool,
            row=row,
            model=model,
            status=exc.status,
            body=b"",
            started=started,
            purpose=attribution.purpose,
            error=exc.detail,
        )
        relay = HTTPException
        if isinstance(exc, ProviderUnreachable):
            # What this engine last said is from before it went: forget it
            # (that engine only — ruling C11), so the next observe asks again.
            engines.forget(row["name"])
            relay = EngineUnreachable
        raise relay(
            status_code=exc.status, detail=exc.detail, headers={SERVED_BY_HEADER: served_by}
        ) from exc
    # A refusal ran nowhere: only a 200 is stamped.
    if response.status_code == 200:
        served = await served_stamp(request.app, pool, row, model)
    else:
        served = Served()
    response = await usage.observe(
        pool,
        response,
        row=row,
        model=model,
        served_by=served_by,
        attribution=attribution,
        kind="completion",
        started=started,
        stream=bool(body.get("stream")),
        route=route,
        served_on=served.on,
    )
    response.headers[SERVED_BY_HEADER] = served_by
    for name, value in served.headers().items():
        response.headers[name] = value
    return response


# ── where a reply ran (D10) ────────────────────────────────────────────────


@dataclass(frozen=True)
class Served:
    """Where one completion ran: `on` is the D10 compute id, `runtime` how its
    engine runs (container | native | wsl). Either is None when it is not
    known, and its header is then omitted — never guessed."""

    on: str | None = None
    runtime: str | None = None

    def headers(self) -> dict[str, str]:
        out: dict[str, str] = {}
        if self.on:
            out[SERVED_ON_HEADER] = self.on
        if self.runtime:
            out[SERVED_RUNTIME_HEADER] = self.runtime
        return out


async def served_stamp(app, pool, row: dict, model: str) -> Served:
    """Where THIS completion ran, read after the engine answered — so the
    model is resident, and ollama's /api/ps states its `size` and
    `size_vram` (the vendor-neutral truth about offload, D10).

    Only an engine has a stamp: a cloud row's hardware is not ours to name.
    Only the BUILTIN is stamped with devices — the hub's own, as its cached
    observation states them (engines.observe(..., live=False): the one
    reader, 30 s of process memory, never an nvidia-smi per reply; ruling
    C1). Any other engine's devices are its own agent's to report (S44),
    never this host's guess. /api/ps is read through engines.resident, the
    one /api/ps reader (ruling C2)."""
    if not engines.is_engine(row):
        return Served()
    try:
        engine = await engines.get(pool, row["name"])
    except engines.UnknownEngine:
        return Served()
    if not engine["builtin"]:
        view = await engines.observe(app, pool, engine, live=False)
        return Served(runtime=view.runtime)
    view, (resident, why) = await asyncio.gather(
        engines.observe(app, pool, engine, live=False),
        engines.resident(app, engine, timeout=STAMP_TIMEOUT),
    )
    if resident is None:
        logger.info("served-on: omitted for %s — %s", _served_by(engine, model), why)
        return Served(runtime=view.runtime)
    # An engine nobody observed (it wakes on LAN) states only what it last
    # stored, and a stored device list is never read as this host's: a
    # database restored elsewhere would carry a card this machine lacks.
    facts = view.facts if view.state != "unobserved" else {}
    size, size_vram = _sizes_of(resident, model)
    on = compute_id.served_on(
        size, size_vram, list(facts.get("accelerators") or []), facts.get("cpu")
    )
    return Served(on=on, runtime=view.runtime)


def _bytes(value: object) -> int | None:
    """A byte count ollama stated, or None. 0 is a real reading (size_vram 0:
    the card never held it); a bool is not a number."""
    if isinstance(value, int) and not isinstance(value, bool) and value >= 0:
        return value
    return None


def _sizes_of(resident: list[dict], model: str) -> tuple[int | None, int | None]:
    """(size, size_vram) /api/ps states for `model` (a bare pull is listed as
    `name:latest`), or (None, None) when it does not list the model."""
    wanted = {model, f"{model}:latest"}
    for entry in resident:
        if entry.get("model") in wanted:
            return _bytes(entry.get("size")), _bytes(entry.get("size_vram"))
    return None, None


def _openai_list(listing: adapters.Listing) -> dict:
    """The listing in OpenAI's GET /v1/models shape — the one shape every
    provider answers in through this route. The richer per-model facts a
    provider stated (context length, pricing) ride along untouched."""
    return {
        "object": "list",
        "source": listing.source,
        "fetched_at": listing.fetched_at,
        "data": [{"object": "model", "created": 0, **model} for model in listing.models],
    }


@router.get("/v1/models")
async def list_models(request: Request) -> Response:
    """The DEFAULT provider's live model list. Settings -> Models uses this
    to know which curated slugs are installed; a `provider` query names
    another registered provider instead."""
    pool = await db.get_pool()
    name = request.query_params.get("provider")
    if name:
        try:
            row = await providers.get_row(pool, name)
        except providers.UnknownProvider:
            raise HTTPException(status_code=404, detail=f"no provider named {name!r}") from None
    else:
        row = await providers.default_row(pool)
    try:
        listing = await adapters.for_row(row).list_models(request.app, row)
    except ListingUnavailable as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except ProviderRefused as exc:
        raise HTTPException(status_code=exc.status, detail=exc.detail) from exc
    return Response(
        content=json.dumps(_openai_list(listing)).encode(),
        media_type="application/json",
        headers={SERVED_BY_HEADER: row["name"]},
    )
