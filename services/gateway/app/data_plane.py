"""POST /v1/chat/completions and GET /v1/models — the OpenAI-compat data
plane core speaks.

Routing is by PROVIDER PREFIX and nothing else: the request's `model` is
split on its first colon; a prefix naming a registered provider selects it,
anything else is a bare model on the default provider (app/providers.py).
No retries, no fallback, no substitution — a provider that fails answers
with its own status and reason (rail 20), and the X-Nova-Served-By header
always names the provider that actually served, as `provider:model`.
"""

from __future__ import annotations

import json
import logging
import time

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import Response

from app import adapters, db, providers, usage
from app.adapters import ListingUnavailable, ProviderRefused

router = APIRouter(tags=["data-plane"])
logger = logging.getLogger("gateway")

SERVED_BY_HEADER = "X-Nova-Served-By"


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
    row, model = await providers.resolve(pool, requested)
    attribution = usage.Attribution.from_headers(request.headers)
    return await serve_completion(request, pool, row, model, body, attribution)


async def serve_completion(
    request: Request, pool, row: dict, model: str, body: dict, attribution
) -> Response:
    """One completion on `row`, METERED: the adapter's response passes
    through usage.observe, which reads the provider's usage off the
    stream, prices it, writes the ledger row when the stream ends, and
    appends the synthetic usage chunk core reads its cost from. A
    refusal is recorded too (kind refusal) before it is raised."""
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
        raise HTTPException(
            status_code=exc.status, detail=exc.detail, headers={SERVED_BY_HEADER: served_by}
        ) from exc
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
    )
    response.headers[SERVED_BY_HEADER] = served_by
    return response


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
