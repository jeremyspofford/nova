"""GET /api/v1/models/catalog — the gateway's catalogue, plus the one fact
only core holds: what Nova MEASURED.

The gateway assembles every row from live sources (ollama, the registry,
Hugging Face, each provider) and never sees eval data. Core forwards that
answer and adds one `measured` suitability entry per eval suite whose
newest complete run, at the suite's current version, names the row's
model. The match is DERIVED against the live rows — a stored id equals the
row's `provider:model`, or (a run recorded before the registry existed)
equals the bundled ollama row's bare model — never a guessed prefix.

A gateway refusal is relayed as-is. A malformed gateway body is a stated
502, never an empty catalogue that reads as "nothing installed".
"""
from __future__ import annotations

import json
import logging

import httpx
from fastapi import APIRouter, HTTPException, Request
from starlette.responses import Response

from app import db, peers
from app.evals import runner
from app.proxies import _forward_headers, _target

router = APIRouter(prefix="/api/v1", tags=["catalog"])
logger = logging.getLogger("core")

CATALOG_TIMEOUT = httpx.Timeout(connect=5.0, read=30.0, write=5.0, pool=5.0)
LOCAL_PROVIDER = "ollama"
MEASURED_SOURCE = "core-evals"


def measured_for(row: dict, measured: dict[str, dict[str, dict]]) -> dict[str, dict]:
    """The measured entries that belong to `row`, keyed by suite."""
    candidates = [row.get("id")]
    if row.get("provider") == LOCAL_PROVIDER:
        candidates.append(row.get("model"))
    found: dict[str, dict] = {}
    for key in candidates:
        for suite, entry in (measured.get(key) or {}).items():
            found.setdefault(suite, entry)
    return found


def decorate(body: dict, measured: dict[str, dict[str, dict]]) -> dict:
    """Add `suitability.<suite>` (basis measured, source core-evals) to
    every row a measurement names. Rows without one are untouched — an
    unmeasured model is absent, never 0."""
    rows = body.get("rows")
    if not isinstance(rows, list):
        return body
    for row in rows:
        if not isinstance(row, dict):
            continue
        entries = measured_for(row, measured)
        if not entries:
            continue
        suitability = row.setdefault("suitability", {})
        if not isinstance(suitability, dict):
            continue
        sources = row.setdefault("sources", [])
        if isinstance(sources, list) and not any(
            isinstance(s, dict) and s.get("key") == MEASURED_SOURCE for s in sources
        ):
            sources.append({"key": MEASURED_SOURCE, "url": "core eval_runs"})
        for suite, entry in entries.items():
            suitability[suite] = {
                "value": entry["pass_rate"],
                "basis": "measured",
                "source": MEASURED_SOURCE,
                "at": entry.get("ended_at"),
                "note": (
                    f"{entry['passed']}/{entry['gradeable']} gradeable cases passed on "
                    f"{suite} v{entry['suite_version']}"
                    if entry["gradeable"]
                    else f"no gradeable case in the last {suite} v{entry['suite_version']} run"
                ),
                "detail": {
                    "suite_version": entry["suite_version"],
                    "run_id": entry["run_id"],
                    "passed": entry["passed"],
                    "gradeable": entry["gradeable"],
                    "ungradeable": entry["ungradeable"],
                    "ended_at": entry.get("ended_at"),
                },
            }
    return body


@router.get("/models/catalog")
async def catalog(request: Request) -> Response:
    try:
        async with peers.client(request.app, peers.GATEWAY, CATALOG_TIMEOUT) as client:
            upstream = await client.get(
                _target(request, "/admin/catalog"), headers=_forward_headers(request)
            )
    except httpx.ReadTimeout as exc:
        raise HTTPException(
            status_code=502,
            detail="the gateway timed out — /admin/catalog did not answer within 30s",
        ) from exc
    except (httpx.HTTPError, peers.PeerUnconfigured) as exc:
        raise HTTPException(
            status_code=502, detail=f"the gateway is unreachable — {peers.reason(exc)}"
        ) from exc
    if upstream.status_code != 200:
        return Response(
            content=upstream.content,
            status_code=upstream.status_code,
            media_type=upstream.headers.get("content-type"),
        )
    try:
        body = upstream.json()
    except ValueError as exc:
        raise HTTPException(
            status_code=502, detail=f"the gateway's catalogue was not JSON — {exc}"
        ) from exc
    if not isinstance(body, dict):
        raise HTTPException(status_code=502, detail="the gateway's catalogue was not an object")
    pool = await db.get_pool()
    measured = await runner.measured_by_model(pool)
    return Response(content=json.dumps(decorate(body, measured)), media_type="application/json")
