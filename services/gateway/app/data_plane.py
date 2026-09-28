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

POST /v1/systemone (decision-role spec §1) is the decision role's route:
typed questions, never a chat completion. It walks the `decisions` chain
through the SAME loop as chat (walk_role) — walls, fallback, X-Nova-Route
— and meters each call under the role (usage.observe_decision). A link
whose endpoint has no /systemone (a 404 or 405 there) is passed over for
the request in its own words and never walled: it is neither an account
refusal nor an outage.
"""

from __future__ import annotations

import asyncio
import json
import logging
import time
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, replace

import httpx
from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import Response

from app import adapters, compute_id, db, engines, providers, routing, usage
from app.adapters import ListingUnavailable, ProviderRefused, ProviderUnreachable, systemone

router = APIRouter(tags=["data-plane"])
logger = logging.getLogger("gateway")

SERVED_BY_HEADER = "X-Nova-Served-By"
SERVED_ON_HEADER = "X-Nova-Served-On"
SERVED_RUNTIME_HEADER = "X-Nova-Served-Runtime"
ROUTE_HEADER = "X-Nova-Route"
# ollama's /api/ps is local and answers in milliseconds; bounded so a wedged
# engine costs the stamp (omitted), never the reply (S40 ruling C2: 2 s).
STAMP_TIMEOUT = httpx.Timeout(2.0)
# The WHOLE stamp — the engine's observation (a cold one reads nvidia-smi and
# /api/tags) and its /api/ps — before the reply's first byte. Past this the
# stamp is omitted, served_on and served_runtime both: never guessed, never
# the last value seen (S40 T3 ruling, fix wave B1).
STAMP_BUDGET_S = 2.0


class PassedOver(HTTPException):
    """A link passed over for the rest of THIS request, in its own words, and
    never walled: walk_role states why in the route and tries the next link.
    A caller that is not walking a chain gets its status and words like any
    refusal."""


class EngineUnreachable(PassedOver):
    """An engine that could not be reached at all (adapters.ProviderUnreachable),
    relayed with the same status and words as any refusal — a caller with no
    role gets its stated 502. The walk tells it apart for one reason: it is
    never a wall (D21)."""


def _served_by(row: dict, model: str) -> str:
    return providers.served_by(row, model)


def _nothing_runnable(exc: routing.NothingRunnable) -> str:
    """The 503's words: the walk's own sentence, then every link's verdict. A
    chain with no links (the empty decisions chain) is the sentence alone —
    never a dangling dash."""
    if not exc.verdicts:
        return str(exc)
    return f"{exc} — " + "; ".join(f"{v['id']}: {v['reason']}" for v in exc.verdicts)


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
        if routing.protocol_of(attribution.role) != routing.CHAT:
            # The endpoint decides the protocol (decision-role spec §1): the
            # decisions chain holds decision models, which have no chat.
            raise HTTPException(
                status_code=400,
                detail=f"the {attribution.role} role answers typed questions at POST "
                "/v1/systemone — a chat completion cannot be served from its chain",
            )
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


async def walk_role(
    request: Request,
    pool,
    role: str,
    requested: str | None,
    attribution,
    serve: Callable[[routing.Decision], Awaitable[Response]],
) -> Response:
    """Walk the role's chain (app/routing.py) and serve from the first link
    that can — the ONE loop both data-plane routes use, so walls and fallback
    work identically for a chat completion and a decision (decision-role
    spec §1). `serve(decision)` makes the call on the chosen link. A link that
    REFUSES before answering is recorded, walled, and the next runnable link
    is tried in this same request — the reply then states the fallback (rail
    20). A link PASSED OVER (PassedOver: an engine that could not be REACHED,
    D21, or an endpoint with no /systemone) is recorded and the next link
    tried the same way, but it is never walled."""
    from app import admin  # the fit context and probe query /admin/suggest uses

    skip: set[str] = set()
    # Each link passed over in this request, to its words — handed to resolve
    # as `unreachable`, whose verdicts carry a link's own words (`skip` says
    # only that it refused). The route and the 503 state the words, never
    # the verdict's label.
    passed: dict[str, str] = {}
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
                unreachable=passed,
            )
        except routing.NothingRunnable as exc:
            raise HTTPException(status_code=503, detail=_nothing_runnable(exc)) from exc
        link = f"{decision.row['name']}:{decision.model}"
        try:
            response = await serve(decision)
        except PassedOver as exc:
            # Never a wall: passed over for the rest of this request only, in
            # its own words. For an engine (D21), serve_completion already
            # made its observation be read again (ruling C11).
            passed[link] = str(exc.detail)
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


async def serve_by_role(
    request: Request, pool, role: str, requested, body, attribution
) -> Response:
    """A chat completion, walked through the role's chain (walk_role)."""

    async def serve(decision: routing.Decision) -> Response:
        return await serve_completion(
            request,
            pool,
            decision.row,
            decision.model,
            body,
            attribution,
            route=decision.as_route(),
        )

    return await walk_role(request, pool, role, requested, attribution, serve)


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
    served = Served()
    if response.status_code == 200:
        try:
            served = await asyncio.wait_for(
                served_stamp(request.app, pool, row, model), STAMP_BUDGET_S
            )
        except TimeoutError:
            logger.info(
                "served-on: omitted for %s — the stamp took longer than %g s",
                served_by,
                STAMP_BUDGET_S,
            )
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


async def serve_systemone(
    request: Request,
    pool,
    row: dict,
    model: str,
    body: dict,
    attribution,
    route: dict | None = None,
) -> Response:
    """One decision on `row`, METERED under the call's own attribution
    (usage.observe_decision), with the provider's key from its own adapter's
    auth rule. A call that got no answer at all is metered as a refusal and
    raised with its status — the walk walls it and tries the next link, as
    for chat. An endpoint with no /systemone (systemone.NotCarried) is metered
    the same way and passed over, never walled."""
    served_by = _served_by(row, model)
    started = time.monotonic()
    try:
        status, content = await systemone.call(
            request.app, row, model, body, adapters.for_row(row).headers(row)
        )
    except ProviderRefused as exc:
        # A decision's row like any other — its role and its turn, in the
        # words it was refused with — never a probe row that carries neither.
        await usage.observe_decision(
            pool,
            status=exc.status,
            content=json.dumps({"error": exc.detail}).encode(),
            row=row,
            model=model,
            served_by=served_by,
            attribution=attribution,
            started=started,
            route=route,
        )
        relay = PassedOver if isinstance(exc, systemone.NotCarried) else HTTPException
        raise relay(
            status_code=exc.status, detail=exc.detail, headers={SERVED_BY_HEADER: served_by}
        ) from exc
    response = await usage.observe_decision(
        pool,
        status=status,
        content=content,
        row=row,
        model=model,
        served_by=served_by,
        attribution=attribution,
        started=started,
        route=route,
    )
    response.headers[SERVED_BY_HEADER] = served_by
    return response


@router.post("/v1/systemone")
async def systemone_decide(request: Request) -> Response:
    """Typed questions for the decision role (decision-role spec §1).

    The body is TypeSafe's `{state, questions}` and, optionally, `model` — a
    `provider:model` pick that is link 1, exactly as chat's requested model,
    so a measurement can name Jev or Kev without editing the owner's chain
    (core sends none, so the decisions chain decides). It is forwarded
    unchanged but for `model`, which becomes the winning link's own id, to
    `{base_url}/systemone` with that provider's key. Only the decisions role
    is served here, whatever the header says: the endpoint decides the
    protocol."""
    try:
        body = await request.json()
    except Exception as exc:
        raise HTTPException(
            status_code=400, detail=f"request body is not valid JSON: {exc}"
        ) from exc
    if not isinstance(body, dict):
        raise HTTPException(status_code=400, detail="request body must be a JSON object")
    questions = body.get("questions")
    if not isinstance(questions, dict) or not questions:
        raise HTTPException(
            status_code=400,
            detail="questions must be a non-empty object — the typed questions a "
            "decision model answers",
        )
    attribution = usage.Attribution.from_headers(request.headers)
    if attribution.role and attribution.role != routing.DECISIONS_ROLE:
        raise HTTPException(
            status_code=400,
            detail=f"POST /v1/systemone serves the {routing.DECISIONS_ROLE} role — "
            f"X-Nova-Role named {attribution.role!r}",
        )
    # Metered under the role even when the caller sent no header.
    attribution = replace(attribution, role=routing.DECISIONS_ROLE)
    requested = body["model"] if isinstance(body.get("model"), str) and body["model"] else None
    pool = await db.get_pool()

    async def serve(decision: routing.Decision) -> Response:
        return await serve_systemone(
            request,
            pool,
            decision.row,
            decision.model,
            body,
            attribution,
            route=decision.as_route(),
        )

    return await walk_role(request, pool, routing.DECISIONS_ROLE, requested, attribution, serve)


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
