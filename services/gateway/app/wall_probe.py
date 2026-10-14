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

import asyncio
import json
import logging
from dataclasses import dataclass
from types import SimpleNamespace

import asyncpg

from app import adapters, engines, providers, routing, usage
from app.adapters.base import refusal_words

logger = logging.getLogger(__name__)

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
# How often the gateway's probe loop looks for due walls.
PROBE_TICK_S = 300


@dataclass(frozen=True)
class ProbeResult:
    """What one probe of a wall learned. `served` is True only when the
    provider verifiably served a completion; otherwise `reason` states why
    not (a refusal, an answer that was not a completion, or no call at all).
    `model` is the model probed and `status` the HTTP status it answered,
    both None when no call was made. `detail` is the refusal body's own
    sentence (adapters.base.refusal_words), what a refusal's wall reason
    quotes, as a turn's refusal is quoted."""

    served: bool
    reason: str | None = None
    model: str | None = None
    status: int | None = None
    detail: str | None = None


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
            served=False,
            reason=f"{provider} probe: {error}",
            model=model,
            status=call.status,
            detail=refusal_words(call.content) or error,
        )
    return ProbeResult(served=True, model=model, status=call.status)


def is_probed(wall: dict, row: dict | None) -> bool:
    """Whether the probe loop checks this wall at all, whatever its age: its
    STORED status is in CREDIT_STATUSES and its provider is not an engine.

    The one rule: due_walls picks by it, and GET /admin/routes says it of
    each wall (walls[].probed), so the owner's page never keeps its own copy.
    An engine's wall is never probed: a completion never lifts an engine's
    wall (data_plane's note_success rule — it lapses on its own ladder), and
    a served probe's outcome IS note_success. Which provider is an engine is
    engines.is_engine(row) on its providers row, never a list of names. A
    wall whose provider row is gone (a delete racing the read) is not probed.
    """
    return wall["status"] in CREDIT_STATUSES and row is not None and not engines.is_engine(row)


async def due_walls(pool: asyncpg.Pool) -> list[dict]:
    """The live credit walls due a probe, each shaped as routing.walls()
    hands a wall back (refused_at = the stored refusal time) plus probed_at.

    Due = still standing, probed at all (is_probed: a credit status, not an
    engine), and the later of its latest refusal (updated_at) and its last
    probe (probed_at; NULL when never probed, which greatest() skips) at
    least WALL_PROBE_EVERY_S old.
    """
    rows = await pool.fetch(
        "SELECT provider, model, walled_until, reason, status, strikes, connect_failed, "
        "updated_at AS refused_at, probed_at "
        "FROM provider_walls WHERE walled_until > now() "
        "AND greatest(updated_at, probed_at) <= now() - make_interval(secs => $1) "
        "ORDER BY provider, model",
        float(WALL_PROBE_EVERY_S),
    )
    if not rows:
        return []
    by_name = {row["name"]: row for row in await providers.list_rows(pool)}
    return [dict(r) for r in rows if is_probed(r, by_name.get(r["provider"]))]


async def tick(app, pool: asyncpg.Pool) -> None:
    """Probe every due credit wall once (through probe_wall, so each probe is
    one call and one ledger row) and move the wall by what the probe found,
    through routing's own wall functions — never a second copy of the rules:

    - served: routing.note_success lifts the provider's wall and the probed
      model's (a sibling model's outage wall stands), logged "wall lifted by
      probe".
    - refused with a routing.WALL_STATUSES status (402: still out of credit):
      routing.record_refusal — a strike, a longer wall, and the refusal time
      is the probe's. probed_at is set to that same refusal time, so the
      words say "not retried since", never "last probed" after it.
    - any other failure (no connection, a 5xx, a 200 that is not a
      completion): the wall is left as it stands — no outage wall is added
      for a probe — and only probed_at is stamped, so the words say when it
      was last probed.
    - no call made (no refused model on record): nothing is stamped, so the
      words never claim a probe that did not happen.

    A probe that raises is logged with its traceback and the tick moves on to
    the next wall, so one broken provider never starves the others; that
    wall keeps its old probed_at and is due again next tick.
    """
    for wall in await due_walls(pool):
        provider, model = wall["provider"], wall["model"]
        try:
            result = await probe_wall(app, pool, wall)
        except Exception:
            logger.exception("wall probe of %s raised; the next tick tries again", provider)
            continue
        if result.served:
            await routing.note_success(pool, provider, result.model)
            logger.info("wall lifted by probe: %s served %s", provider, result.model)
            continue
        if result.model is None:
            logger.info("wall probe: %s not probed: %s", provider, result.reason)
            continue
        refused = result.status in routing.WALL_STATUSES
        if refused:
            row = await providers.get_row(pool, provider)
            await routing.record_refusal(
                pool, row, result.status, result.detail or "", model=result.model
            )
        await pool.execute(
            "UPDATE provider_walls SET probed_at = "
            + ("updated_at" if refused else "now()")
            + " WHERE provider = $1 AND model = $2",
            provider,
            model,
        )
        logger.info("wall probe: %s not served: %s", provider, result.reason)


async def loop(app, pool: asyncpg.Pool, *, every: float | None = None, sleep=None) -> None:
    """Tick, then sleep `every` seconds (PROBE_TICK_S by default), until
    cancelled. A tick that raises is logged with its traceback and the loop
    lives on; a cancellation (from the tick or the sleep) ends it and
    propagates — it is never logged-and-continued."""
    every = PROBE_TICK_S if every is None else every
    sleep = asyncio.sleep if sleep is None else sleep
    while True:
        try:
            await tick(app, pool)
        except Exception:
            logger.exception("wall probe tick raised; the loop ticks again in %ss", every)
        await sleep(every)
