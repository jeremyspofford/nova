"""The credit-wall probe: a provider walled for credits is re-checked by the
gateway itself with one cheap call, recorded on the ledger.

The probe is the admin probe's own call (adapters.probe_call: one non-stream
1-token "hi" through the chat adapter) on the model the provider last
refused, recorded via usage.record_probe with purpose "wall_probe" — so spend
and the trace show it. It says served only when the provider verifiably
served a completion: status 200 AND a JSON body with a non-empty `choices`
and no `error`, never "the status was ok".
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from types import SimpleNamespace

import asyncpg

from app import adapters, providers, usage

PURPOSE = "wall_probe"
NO_MODEL = "cannot probe: no refused model on record"

# The stored wall statuses that mean "out of credit": a wall is a credit wall
# because of the status its refusal STORED on the row, never because of which
# provider it is. 401/403 (the key) and 429 (a rate) do not lift by waiting
# for a top-up, and a 5xx wall is an outage with its own short ladder.
CREDIT_STATUSES = frozenset({402})
# A credit wall is due a probe this long after the later of its latest
# refusal and its last probe.
WALL_PROBE_EVERY_S = 3600


@dataclass(frozen=True)
class ProbeResult:
    """What one probe of a wall learned. `served` is True only when the
    provider verifiably served a completion; otherwise `reason` states why
    not (a refusal, an answer that was not a completion, or no call at all).
    `model` is the model probed and `status` the HTTP status it answered,
    both None when no call was made."""

    served: bool
    reason: str | None = None
    model: str | None = None
    status: int | None = None


async def refused_model(pool: asyncpg.Pool, provider: str) -> str | None:
    """The model of `provider`'s LATEST refusal on the ledger, None when it
    has none — the model the wall was set on, read from what happened."""
    return await pool.fetchval(
        "SELECT model FROM usage_events WHERE provider = $1 AND kind = 'refusal' "
        "ORDER BY at DESC, id DESC LIMIT 1",
        provider,
    )


def not_a_completion(content: bytes) -> str | None:
    """Why a 200 body is not a completion, None when it is one: JSON with a
    non-empty `choices` and no `error`."""
    try:
        parsed = json.loads(content)
    except ValueError:
        return "answered 200 with a body that is not JSON"
    if not isinstance(parsed, dict):
        return "answered 200 with JSON that is not an object"
    if parsed.get("error"):
        return f"answered 200 with an error: {json.dumps(parsed['error'])[:400]}"
    if not parsed.get("choices"):
        return "answered 200 with no choices"
    return None


async def probe_wall(app, pool: asyncpg.Pool, wall: dict) -> ProbeResult:
    """ONE non-stream 1-token completion on the walled provider's latest
    refused model, recorded via usage.record_probe(purpose="wall_probe").

    No refusal on record -> no call and no ledger row, and it says so. The
    adapters read only `request.app`, so the loop (which has no request)
    hands them an object carrying the app — never a fabricated HTTP request.
    """
    provider = wall["provider"]
    model = await refused_model(pool, provider)
    if model is None:
        return ProbeResult(served=False, reason=NO_MODEL)
    row = await providers.get_row(pool, provider)
    call = await adapters.probe_call(SimpleNamespace(app=app), row, model)
    error = call.error
    if error is None:
        error = not_a_completion(call.content)
    await usage.record_probe(
        pool,
        row=row,
        model=model,
        status=call.ledger_status,
        body=call.content,
        started=call.started,
        purpose=PURPOSE,
        error=error,
    )
    if error is not None:
        return ProbeResult(
            served=False, reason=f"{provider} probe: {error}", model=model, status=call.status
        )
    return ProbeResult(served=True, model=model, status=call.status)


async def due_walls(pool: asyncpg.Pool) -> list[dict]:
    """The live credit walls due a probe, each shaped as routing.walls()
    hands a wall back (refused_at = the stored refusal time) plus probed_at.

    Due = still standing, STORED status in CREDIT_STATUSES, and the later of
    its latest refusal (updated_at) and its last probe (probed_at; NULL when
    never probed, which greatest() skips) at least WALL_PROBE_EVERY_S old.
    """
    rows = await pool.fetch(
        "SELECT provider, model, walled_until, reason, status, strikes, connect_failed, "
        "updated_at AS refused_at, probed_at "
        "FROM provider_walls WHERE walled_until > now() AND status = ANY($1::int[]) "
        "AND greatest(updated_at, probed_at) <= now() - make_interval(secs => $2) "
        "ORDER BY provider, model",
        sorted(CREDIT_STATUSES),
        float(WALL_PROBE_EVERY_S),
    )
    return [dict(r) for r in rows]
