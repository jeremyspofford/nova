"""The spend ledger: one row per completion, priced from the provider's own
figure or a stated price, never from a guess.

The gateway sees every completion — chat rounds, judges, redirects,
scheduled turns, evals, key probes, admin probes — and holds the provider
rows and prices, so it owns the meter (master roadmap: the gateway owns
"usage meters + ceilings"). Core attributes each call with headers
(`X-Nova-Purpose`, `X-Nova-Role`, `X-Nova-Turn-Id`, `X-Nova-Person`,
`X-Nova-Timezone`) and shows the result.

Rails, in code:
  * unmetered is unmetered — token columns NULL, `metered` derived false;
    a provider that stated no counts is never written as zero;
  * a local call has no dollars — `local=true`, `cost_usd` NULL, and the
    CHECK constraint refuses otherwise; its `duration_ms` is the GPU-time
    meter, a different unit;
  * every cost names its basis: `provider-reported` (OpenRouter's
    `usage.cost`), `owner-price`, `listing-price` (the provider's own
    listing), `curated-price` (the dated file) — in that precedence;
  * the row is written in the SAME code path that ends the stream (a
    stream the client abandoned is recorded with its status), and a
    write that fails is logged AND counted, so the page can say "N calls
    could not be recorded" instead of quietly under-reporting;
  * a cap is checked against RECORDED spend before the act; calls in
    flight are not yet counted (stated on the page), and nothing
    pre-charges an estimate — an estimate is the SDK-guess v3's paper-money
    incident forbids.
"""

from __future__ import annotations

import json
import logging
import re
import time
from collections.abc import AsyncIterator
from dataclasses import dataclass, field
from datetime import UTC, datetime
from decimal import Decimal
from pathlib import Path
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

import asyncpg
from fastapi.responses import Response, StreamingResponse

logger = logging.getLogger("gateway")

PURPOSE_RE = re.compile(r"^[a-z_]{1,32}$")
ROLE_RE = PURPOSE_RE
UNATTRIBUTED = "unattributed"
HEADER_TURN = "X-Nova-Turn-Id"
HEADER_PERSON = "X-Nova-Person"
HEADER_PURPOSE = "X-Nova-Purpose"
HEADER_ROLE = "X-Nova-Role"
HEADER_TIMEZONE = "X-Nova-Timezone"
TOTAL_CAP = "*"
CURATED_PATH = Path(__file__).with_name("curated_prices.json")
DEFAULT_CACHE_READ = Decimal("0.1")
DEFAULT_CACHE_WRITE = Decimal("1.25")
BASIS_ORDER = ("owner", "listing", "curated")
BASIS_LABEL = {"owner": "owner-price", "listing": "listing-price", "curated": "curated-price"}
WINDOWS = ("today", "7d", "30d", "month")

# Process-local: how many ledger writes failed since start. Shown on the
# Spend page so an under-count is never silent.
WRITE_FAILURES = 0


# ── attribution ────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class Attribution:
    purpose: str = UNATTRIBUTED
    role: str | None = None
    turn_id: str | None = None
    person_id: str | None = None
    timezone: str = "UTC"

    @classmethod
    def from_headers(cls, headers) -> Attribution:
        """What core said about this call. A missing purpose is recorded as
        `unattributed` — the row is still written; the gap is visible."""
        purpose = (headers.get(HEADER_PURPOSE) or "").strip().lower()
        role = (headers.get(HEADER_ROLE) or "").strip().lower()
        return cls(
            purpose=purpose if PURPOSE_RE.match(purpose) else UNATTRIBUTED,
            role=role if ROLE_RE.match(role) else None,
            turn_id=_uuid_or_none(headers.get(HEADER_TURN)),
            person_id=_uuid_or_none(headers.get(HEADER_PERSON)),
            timezone=valid_timezone(headers.get(HEADER_TIMEZONE)),
        )


_UUID_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", re.I)


def _uuid_or_none(value: str | None) -> str | None:
    value = (value or "").strip()
    return value.lower() if _UUID_RE.match(value) else None


def valid_timezone(name: str | None) -> str:
    name = (name or "").strip()
    if not name:
        return "UTC"
    try:
        ZoneInfo(name)
    except (ZoneInfoNotFoundError, ValueError):
        return "UTC"
    return name


# ── the stream parser ──────────────────────────────────────────────────────


@dataclass
class Captured:
    """What the provider's own frames stated. Every field None until seen."""

    prompt_tokens: int | None = None
    completion_tokens: int | None = None
    cache_read_tokens: int | None = None
    cache_write_tokens: int | None = None
    cost: Decimal | None = None  # the provider's OWN reported cost (OpenRouter)
    byok: bool = False  # the cost is the upstream's charge on the owner's own key
    error: str | None = None
    malformed: int = 0
    saw_done: bool = False
    frames: int = 0

    def absorb(self, payload: dict) -> None:
        self.frames += 1
        usage = payload.get("usage")
        if isinstance(usage, dict):
            self._absorb_usage(usage)
        err = payload.get("error")
        if err:
            self.error = (str(err.get("message") or err) if isinstance(err, dict) else str(err))[
                :400
            ]

    def _absorb_usage(self, usage: dict) -> None:
        for key in (
            "prompt_tokens",
            "completion_tokens",
            "cache_read_tokens",
            "cache_write_tokens",
        ):
            value = usage.get(key)
            if isinstance(value, int) and not isinstance(value, bool) and value >= 0:
                setattr(self, key, value)
        details = usage.get("prompt_tokens_details")
        if isinstance(details, dict):
            cached = details.get("cached_tokens")
            if isinstance(cached, int) and not isinstance(cached, bool) and cached >= 0:
                self.cache_read_tokens = cached
            written = details.get("cache_write_tokens")
            if isinstance(written, int) and not isinstance(written, bool) and written > 0:
                self.cache_write_tokens = written
        cost = usage.get("cost")
        # OpenRouter with a BRING-YOUR-OWN-KEY provider (verified live
        # 2026-09-08: is_byok true, cost 0, the real charge under
        # cost_details.upstream_inference_cost, billed by the upstream on the
        # owner's own key) — the upstream figure is the one that costs money.
        if usage.get("is_byok") is True:
            upstream = (usage.get("cost_details") or {}).get("upstream_inference_cost")
            if isinstance(upstream, int | float) and not isinstance(upstream, bool):
                cost = upstream
                self.byok = True
        if isinstance(cost, int | float) and not isinstance(cost, bool) and cost >= 0:
            self.cost = Decimal(str(cost))

    @property
    def metered(self) -> bool:
        return self.prompt_tokens is not None and self.completion_tokens is not None


DONE_FRAME = b"data: [DONE]"


class SseUsageParser:
    """Feeds raw SSE bytes through unchanged, reading `usage` off every
    `data:` frame on the way. The ONE frame it holds back is the upstream
    `data: [DONE]` — it is the last thing a provider sends, and the
    synthetic usage chunk has to precede it. Everything else is yielded
    exactly as received; a frame that does not parse is counted, never
    dropped, never blocking."""

    def __init__(self) -> None:
        self.captured = Captured()
        self._buf = b""
        self._held_done: bytes | None = None

    def feed(self, chunk: bytes) -> bytes:
        """Bytes to relay now for `chunk`."""
        out = b""
        if self._held_done is not None:
            # A DONE we held turned out not to be last (a provider that keeps
            # talking after DONE): release it, in order, and read on.
            out += self._held_done
            self._held_done = None
        self._buf += chunk
        while True:
            idx = self._buf.find(b"\n\n")
            if idx < 0:
                break
            frame, self._buf = self._buf[: idx + 2], self._buf[idx + 2 :]
            if self._is_done(frame):
                self._held_done = frame
                continue
            self._read(frame)
            out += frame
        return out

    def finish(self) -> tuple[bytes, bytes | None]:
        """(bytes still buffered — relayed as they were, the held DONE frame)."""
        rest, self._buf = self._buf, b""
        if rest and self._is_done(rest):
            held = rest if not rest.endswith(b"\n\n") else rest
            return b"", held
        if rest:
            self._read(rest)
        return rest, self._held_done

    def _is_done(self, frame: bytes) -> bool:
        stripped = frame.strip()
        if stripped == DONE_FRAME:
            self.captured.saw_done = True
            return True
        return False

    def _read(self, frame: bytes) -> None:
        for line in frame.split(b"\n"):
            if not line.startswith(b"data:"):
                continue
            payload = line[len(b"data:") :].strip()
            if not payload or payload == b"[DONE]":
                continue
            try:
                parsed = json.loads(payload)
            except ValueError:
                self.captured.malformed += 1
                continue
            if isinstance(parsed, dict):
                self.captured.absorb(parsed)
            else:
                self.captured.malformed += 1


# ── pricing ────────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class Price:
    prompt: Decimal
    completion: Decimal
    cache_read: Decimal
    cache_write: Decimal
    basis: str  # owner | listing | curated
    verified_at: datetime | None = None


async def price_for(pool: asyncpg.Pool, provider: str, model: str) -> Price | None:
    """The best-basis stated price for (provider, model): owner > listing >
    curated. None when nobody stated one."""
    rows = await pool.fetch(
        "SELECT basis, prompt_usd_per_token, completion_usd_per_token, cache_read_multiplier, "
        "cache_write_multiplier, verified_at FROM provider_prices "
        "WHERE provider = $1 AND model = $2",
        provider,
        model,
    )
    by_basis = {r["basis"]: r for r in rows}
    for basis in BASIS_ORDER:
        r = by_basis.get(basis)
        if r is None:
            continue
        return Price(
            prompt=Decimal(r["prompt_usd_per_token"]),
            completion=Decimal(r["completion_usd_per_token"]),
            cache_read=Decimal(r["cache_read_multiplier"])
            if r["cache_read_multiplier"] is not None
            else DEFAULT_CACHE_READ,
            cache_write=Decimal(r["cache_write_multiplier"])
            if r["cache_write_multiplier"] is not None
            else DEFAULT_CACHE_WRITE,
            basis=basis,
            verified_at=r["verified_at"],
        )
    return None


def cost_from_price(price: Price, captured: Captured) -> Decimal | None:
    """The bill for what the provider said it did, at the stated price.
    Needs both token counts — an unmetered call has no bill."""
    if not captured.metered:
        return None
    total = (
        Decimal(captured.prompt_tokens) * price.prompt
        + Decimal(captured.completion_tokens) * price.completion
    )
    if captured.cache_read_tokens:
        total += Decimal(captured.cache_read_tokens) * price.prompt * price.cache_read
    if captured.cache_write_tokens:
        total += Decimal(captured.cache_write_tokens) * price.prompt * price.cache_write
    return total.quantize(Decimal("0.000001"))


async def price_call(
    pool: asyncpg.Pool, row: dict, model: str, captured: Captured
) -> tuple[Decimal | None, str | None]:
    """(cost_usd, cost_basis) — the provider's own figure first, else a
    stated price, else nothing. A local provider never has dollars."""
    if row.get("local"):
        return None, None
    if captured.cost is not None:
        return captured.cost.quantize(Decimal("0.000001")), "provider-reported"
    price = await price_for(pool, row["name"], model)
    if price is None:
        return None, None
    cost = cost_from_price(price, captured)
    if cost is None:
        return None, None
    return cost, BASIS_LABEL[price.basis]


# ── the ledger ─────────────────────────────────────────────────────────────


@dataclass
class Event:
    provider: str
    model: str
    served_by: str
    kind: str
    attribution: Attribution
    duration_ms: int
    local: bool
    status: int
    captured: Captured = field(default_factory=Captured)
    cost_usd: Decimal | None = None
    cost_basis: str | None = None
    error: str | None = None
    route_reason: str | None = None
    route_link: int | None = None


async def record(pool: asyncpg.Pool, event: Event) -> bool:
    """ONE insert. False (logged, counted) when it could not be written —
    the caller says so in the stream so the page can count the gap."""
    global WRITE_FAILURES
    c = event.captured
    try:
        await pool.execute(
            "INSERT INTO usage_events (provider, model, served_by, kind, purpose, role, turn_id, "
            "person_id, prompt_tokens, completion_tokens, cache_read_tokens, cache_write_tokens, "
            "duration_ms, local, cost_usd, cost_basis, status, error, route_reason, route_link) "
            "VALUES ($1, $2, $3, $4, $5, $6, $7::uuid, $8::uuid, $9, $10, $11, $12, $13, $14, "
            "$15, $16, $17, $18, $19, $20)",
            event.provider,
            event.model,
            event.served_by,
            event.kind,
            event.attribution.purpose,
            event.attribution.role,
            event.attribution.turn_id,
            event.attribution.person_id,
            c.prompt_tokens,
            c.completion_tokens,
            c.cache_read_tokens,
            c.cache_write_tokens,
            event.duration_ms,
            event.local,
            None if event.local else event.cost_usd,
            None if event.local else event.cost_basis,
            event.status,
            event.error,
            event.route_reason,
            event.route_link,
        )
    except Exception:
        WRITE_FAILURES += 1
        logger.exception(
            "usage: ledger write failed for %s (%s, %s) — %d failures since start",
            event.served_by,
            event.kind,
            event.attribution.purpose,
            WRITE_FAILURES,
        )
        return False
    return True


def usage_fields(event: Event, recorded: bool) -> dict:
    """What the provider said plus the price and its basis. Stated, never
    invented: an unmetered call has null tokens and null cost here too."""
    c = event.captured
    return {
        "prompt_tokens": c.prompt_tokens,
        "completion_tokens": c.completion_tokens,
        "cache_read_tokens": c.cache_read_tokens,
        "cache_write_tokens": c.cache_write_tokens,
        "cost_usd": float(event.cost_usd) if event.cost_usd is not None else None,
        "cost_basis": event.cost_basis,
        "provider": event.provider,
        "model": event.model,
        "local": event.local,
        "metered": c.metered,
        "recorded": recorded,
        "duration_ms": event.duration_ms,
    }


def usage_chunk(event: Event, recorded: bool, route: dict | None = None) -> bytes:
    """The synthetic final chunk core reads its cost off (core takes `usage`
    from ANY chunk)."""
    usage = usage_fields(event, recorded)
    payload: dict = {
        "id": f"nova-usage-{int(time.time() * 1000)}",
        "object": "chat.completion.chunk",
        "created": int(time.time()),
        "model": event.model,
        "choices": [],
        "usage": usage,
    }
    if route is not None:
        payload["route"] = route
    return f"data: {json.dumps(payload)}\n\n".encode()


async def observe(
    pool: asyncpg.Pool,
    response: Response,
    *,
    row: dict,
    model: str,
    served_by: str,
    attribution: Attribution,
    kind: str,
    started: float,
    stream: bool,
    route: dict | None = None,
) -> Response:
    """Wrap an adapter's response so the call is metered and recorded when
    it ENDS. A streaming body is relayed byte for byte with one synthetic
    usage chunk inserted before the upstream `[DONE]`; a plain body has
    its `usage` read and enriched in place. A non-200 is recorded as a
    refusal (kind `refusal`), tokens NULL."""
    local = bool(row.get("local"))
    provider = row["name"]
    route_reason = route.get("reason") if route else None
    route_link = route.get("link") if route else None

    def base_event(status: int) -> Event:
        return Event(
            provider=provider,
            model=model,
            served_by=served_by,
            kind=kind if status == 200 else "refusal",
            attribution=attribution,
            duration_ms=int((time.monotonic() - started) * 1000),
            local=local,
            status=status,
            route_reason=route_reason,
            route_link=route_link,
        )

    iterator: AsyncIterator[bytes] | None = getattr(response, "body_iterator", None)
    if iterator is None or response.status_code != 200 or not stream:
        # Buffered: a non-stream completion (some adapters relay even those
        # through a streaming body), or a refusal body.
        content = response.body if iterator is None else b"".join([c async for c in iterator])
        event = base_event(response.status_code)
        try:
            parsed = json.loads(content) if content else None
        except ValueError:
            parsed = None
        if isinstance(parsed, dict):
            event.captured.absorb(parsed)
        if event.kind == "refusal":
            event.error = (event.captured.error or content.decode(errors="replace")[:400]) or None
        else:
            event.cost_usd, event.cost_basis = await price_call(pool, row, model, event.captured)
            event.error = event.captured.error
        recorded = await record(pool, event)
        if event.kind == "completion" and isinstance(parsed, dict):
            enriched = dict(parsed)
            enriched["usage"] = usage_fields(event, recorded)
            if route is not None:
                enriched["route"] = route
            content = json.dumps(enriched).encode()
        headers = {k: v for k, v in response.headers.items() if k.lower() != "content-length"}
        if response.status_code != 200:
            # A refusal body is relayed whole, its length ours to declare.
            return Response(
                content=content,
                status_code=response.status_code,
                headers=headers,
                media_type=response.media_type,
            )

        async def one_body():
            yield content

        # A stream even when buffered: the relay path never declares a
        # Content-Length (an upstream's declared length is not ours to
        # forward, and one we computed would be a second framing source).
        return StreamingResponse(
            one_body(),
            status_code=response.status_code,
            headers=headers,
            media_type=response.media_type,
        )

    parser = SseUsageParser()

    async def relay():
        status = 200
        try:
            async for chunk in iterator:
                data = chunk if isinstance(chunk, bytes) else str(chunk).encode()
                out = parser.feed(data)
                if out:
                    yield out
            rest, held = parser.finish()
            if rest:
                yield rest
            event = base_event(status)
            event.captured = parser.captured
            event.error = parser.captured.error
            event.cost_usd, event.cost_basis = await price_call(pool, row, model, parser.captured)
            recorded = await record(pool, event)
            yield usage_chunk(event, recorded, route)
            if held is not None:
                yield held
        except BaseException:
            # The client went away or the relay broke: the call still
            # happened; record what was seen, with the status saying so.
            rest, _held = parser.finish()
            event = base_event(status)
            event.captured = parser.captured
            event.status = 499
            event.error = parser.captured.error or "the stream ended before completion"
            event.cost_usd, event.cost_basis = await price_call(pool, row, model, parser.captured)
            await record(pool, event)
            raise

    return StreamingResponse(
        relay(),
        status_code=200,
        headers={k: v for k, v in response.headers.items() if k.lower() != "content-length"},
        media_type=response.media_type,
    )


async def record_probe(
    pool: asyncpg.Pool,
    *,
    row: dict,
    model: str,
    status: int,
    body: bytes,
    started: float,
    purpose: str,
    error: str | None = None,
) -> None:
    """A buffered probe (a key check, an admin probe) as a ledger row."""
    captured = Captured()
    try:
        parsed = json.loads(body) if body else None
    except ValueError:
        parsed = None
    if isinstance(parsed, dict):
        captured.absorb(parsed)
    event = Event(
        provider=row["name"],
        model=model,
        served_by=f"{row['name']}:{model}",
        kind="probe" if status == 200 else "refusal",
        attribution=Attribution(purpose=purpose),
        duration_ms=int((time.monotonic() - started) * 1000),
        local=bool(row.get("local")),
        status=status,
        captured=captured,
        error=error or captured.error,
    )
    if event.kind == "probe":
        event.cost_usd, event.cost_basis = await price_call(pool, row, model, captured)
    await record(pool, event)


# ── caps ───────────────────────────────────────────────────────────────────


def month_start(now: datetime, timezone: str) -> datetime:
    """The first instant of the current month in the owner's zone."""
    zone = ZoneInfo(valid_timezone(timezone))
    local = now.astimezone(zone)
    return local.replace(day=1, hour=0, minute=0, second=0, microsecond=0)


async def caps(pool: asyncpg.Pool) -> dict[str, Decimal | None]:
    rows = await pool.fetch("SELECT provider, monthly_usd FROM spend_caps")
    limits = {
        r["provider"]: (Decimal(r["monthly_usd"]) if r["monthly_usd"] is not None else None)
        for r in rows
    }
    # The total row is a fact whether or not it was seeded: no row = no cap.
    limits.setdefault(TOTAL_CAP, None)
    return limits


async def set_cap(pool: asyncpg.Pool, provider: str, monthly_usd: Decimal | None) -> None:
    await pool.execute(
        "INSERT INTO spend_caps (provider, monthly_usd) VALUES ($1, $2) "
        "ON CONFLICT (provider) DO UPDATE SET monthly_usd = EXCLUDED.monthly_usd, "
        "updated_at = now()",
        provider,
        monthly_usd,
    )


async def spent(pool: asyncpg.Pool, provider: str | None, since: datetime) -> Decimal:
    """Recorded USD since `since` — every cloud provider when `provider` is
    None. Calls in flight are not yet rows and are not counted."""
    if provider is None:
        value = await pool.fetchval(
            "SELECT COALESCE(SUM(cost_usd), 0) FROM usage_events WHERE at >= $1 AND NOT local",
            since,
        )
    else:
        value = await pool.fetchval(
            "SELECT COALESCE(SUM(cost_usd), 0) FROM usage_events "
            "WHERE at >= $1 AND provider = $2 AND NOT local",
            since,
            provider,
        )
    return Decimal(value or 0)


async def over_cap(pool: asyncpg.Pool, row: dict, timezone: str) -> str | None:
    """The stated reason a call on `row` must not be made now, or None.
    Read live, BEFORE the act; a local provider is never capped in USD."""
    if row.get("local"):
        return None
    limits = await caps(pool)
    since = month_start(datetime.now(UTC), timezone)
    own = limits.get(row["name"])
    if own is not None:
        used = await spent(pool, row["name"], since)
        if used >= own:
            return f"{row['name']} over its monthly cap ${own:.2f} (spent ${used:.2f})"
    total = limits.get(TOTAL_CAP)
    if total is not None:
        used_all = await spent(pool, None, since)
        if used_all >= total:
            return (
                f"all cloud providers over the monthly total cap ${total:.2f} "
                f"(spent ${used_all:.2f})"
            )
    return None


# ── prices: listing, curated, owner ────────────────────────────────────────


async def record_listing_prices(pool: asyncpg.Pool, row: dict, models: list[dict]) -> int:
    """Every priced row of a live listing, as `listing` price rows — written
    on each fetch so a chat call never has to fetch a listing to be priced.
    A `-1` (varies) or `0` (free) is not a price and is not written."""
    from app.adapters.openai_chat import _is_price

    written = 0
    async with pool.acquire() as conn:
        async with conn.transaction():
            for m in models:
                pricing = m.get("pricing") if isinstance(m, dict) else None
                if not isinstance(pricing, dict) or not m.get("id"):
                    continue
                prompt, completion = pricing.get("prompt"), pricing.get("completion")
                if not (_is_price(prompt) and _is_price(completion)):
                    continue
                await conn.execute(
                    "INSERT INTO provider_prices (provider, model, basis, prompt_usd_per_token, "
                    "completion_usd_per_token, verified_at, source) "
                    "VALUES ($1, $2, 'listing', $3, $4, now(), 'the provider listing') "
                    "ON CONFLICT (provider, model, basis) DO UPDATE SET "
                    "prompt_usd_per_token = EXCLUDED.prompt_usd_per_token, "
                    "completion_usd_per_token = EXCLUDED.completion_usd_per_token, "
                    "verified_at = now()",
                    row["name"],
                    str(m["id"]),
                    Decimal(str(prompt)),
                    Decimal(str(completion)),
                )
                written += 1
    return written


class CuratedPricesInvalid(RuntimeError):
    pass


def load_curated_prices(path: Path | None = None) -> dict:
    """The dated file, validated: a date, a source, positive prices."""
    data = json.loads((path or CURATED_PATH).read_text(encoding="utf-8"))
    if not isinstance(data, dict) or not isinstance(data.get("models"), list):
        raise CuratedPricesInvalid("curated_prices.json must be an object with a models list")
    if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", str(data.get("verified_at") or "")):
        raise CuratedPricesInvalid("curated_prices.json needs a YYYY-MM-DD verified_at")
    if not data.get("source") or not data.get("adapter"):
        raise CuratedPricesInvalid("curated_prices.json needs a source and an adapter")
    for entry in data["models"]:
        model = entry.get("model") if isinstance(entry, dict) else None
        if not model:
            raise CuratedPricesInvalid("a curated price names no model")
        for key in ("prompt", "completion", "cache_read", "cache_write"):
            value = entry.get(key)
            if not isinstance(value, int | float) or isinstance(value, bool) or value <= 0:
                raise CuratedPricesInvalid(f"curated price for {model!r}: {key} must be > 0")
    return data


async def seed_curated_prices(pool: asyncpg.Pool, path: Path | None = None) -> int:
    """Curated rows for every provider whose adapter the file names. Idempotent."""
    data = load_curated_prices(path)
    rows = await pool.fetch("SELECT name FROM providers WHERE adapter = $1", data["adapter"])
    verified = datetime.strptime(data["verified_at"], "%Y-%m-%d").replace(tzinfo=UTC)
    written = 0
    async with pool.acquire() as conn:
        async with conn.transaction():
            for r in rows:
                for entry in data["models"]:
                    await conn.execute(
                        "INSERT INTO provider_prices (provider, model, basis, "
                        "prompt_usd_per_token, completion_usd_per_token, "
                        "cache_read_multiplier, cache_write_multiplier, "
                        "verified_at, source) VALUES ($1, $2, 'curated', $3, $4, $5, $6, $7, $8) "
                        "ON CONFLICT (provider, model, basis) DO UPDATE SET "
                        "prompt_usd_per_token = EXCLUDED.prompt_usd_per_token, "
                        "completion_usd_per_token = EXCLUDED.completion_usd_per_token, "
                        "cache_read_multiplier = EXCLUDED.cache_read_multiplier, "
                        "cache_write_multiplier = EXCLUDED.cache_write_multiplier, "
                        "verified_at = EXCLUDED.verified_at, source = EXCLUDED.source",
                        r["name"],
                        entry["model"],
                        Decimal(str(entry["prompt"])),
                        Decimal(str(entry["completion"])),
                        Decimal(str(entry["cache_read"])),
                        Decimal(str(entry["cache_write"])),
                        verified,
                        str(data["source"]),
                    )
                    written += 1
    return written


async def set_owner_price(
    pool: asyncpg.Pool, provider: str, model: str, prompt: Decimal, completion: Decimal
) -> None:
    await pool.execute(
        "INSERT INTO provider_prices (provider, model, basis, prompt_usd_per_token, "
        "completion_usd_per_token, verified_at, source) VALUES ($1, $2, 'owner', $3, $4, now(), "
        "'entered by the owner') ON CONFLICT (provider, model, basis) DO UPDATE SET "
        "prompt_usd_per_token = EXCLUDED.prompt_usd_per_token, "
        "completion_usd_per_token = EXCLUDED.completion_usd_per_token, verified_at = now()",
        provider,
        model,
        prompt,
        completion,
    )


async def delete_owner_price(pool: asyncpg.Pool, provider: str, model: str) -> bool:
    result = await pool.execute(
        "DELETE FROM provider_prices WHERE provider = $1 AND model = $2 AND basis = 'owner'",
        provider,
        model,
    )
    return result.endswith("1")


async def ensure_seed(pool: asyncpg.Pool) -> None:
    """Startup: the '*' cap row exists (the test fixture truncates it) and
    the curated prices are current with the file."""
    await pool.execute(
        "INSERT INTO spend_caps (provider, monthly_usd) VALUES ('*', NULL) ON CONFLICT DO NOTHING"
    )
    try:
        await seed_curated_prices(pool)
    except CuratedPricesInvalid:
        logger.exception("usage: curated_prices.json is invalid — no curated prices seeded")


# ── the report ─────────────────────────────────────────────────────────────


def window_bounds(window: str, now: datetime, timezone: str) -> tuple[datetime, datetime]:
    if window not in WINDOWS:
        raise ValueError(f"window must be one of {', '.join(WINDOWS)}")
    zone = ZoneInfo(valid_timezone(timezone))
    local = now.astimezone(zone)
    today = local.replace(hour=0, minute=0, second=0, microsecond=0)
    if window == "today":
        return today, now
    if window == "7d":
        return today - _days(6), now
    if window == "30d":
        return today - _days(29), now
    return month_start(now, timezone), now


def _days(n: int):
    from datetime import timedelta

    return timedelta(days=n)


def _num(value) -> float | None:
    return float(value) if value is not None else None


async def report(pool: asyncpg.Pool, window: str, timezone: str) -> dict:
    """Rollups over the window: totals, by provider (with caps), model,
    purpose, person, role, day; the unmetered and refused counts named;
    the models with calls but no price. Every dollar figure is a sum of
    rows that each carried a basis; `usd_by_basis` says how much came
    from which."""
    now = datetime.now(UTC)
    since, until = window_bounds(window, now, timezone)
    zone = valid_timezone(timezone)
    args = (since, until)
    where = "at >= $1 AND at < $2"
    totals = await pool.fetchrow(
        f"SELECT COALESCE(SUM(cost_usd), 0) AS usd, "
        f"COALESCE(SUM(duration_ms) FILTER (WHERE local), 0) AS local_ms, "
        f"COUNT(*) FILTER (WHERE kind = 'completion') AS calls, "
        f"COUNT(*) FILTER (WHERE kind = 'completion' AND NOT metered) AS unmetered, "
        f"COUNT(*) FILTER (WHERE kind = 'refusal') AS refusals, "
        f"COUNT(*) FILTER (WHERE kind = 'probe') AS probes "
        f"FROM usage_events WHERE {where}",
        *args,
    )
    by_basis = await pool.fetch(
        f"SELECT cost_basis, SUM(cost_usd) AS usd FROM usage_events "
        f"WHERE {where} AND cost_usd IS NOT NULL GROUP BY cost_basis",
        *args,
    )
    limits = await caps(pool)
    month_since = month_start(now, timezone)
    providers = await pool.fetch(
        f"SELECT provider, bool_or(local) AS local, COALESCE(SUM(cost_usd), 0) AS usd, "
        f"COUNT(*) FILTER (WHERE kind = 'completion') AS calls, "
        f"COUNT(*) FILTER (WHERE kind = 'completion' AND NOT metered) AS unmetered, "
        f"COUNT(*) FILTER (WHERE kind = 'refusal') AS refusals, "
        f"COALESCE(SUM(duration_ms) FILTER (WHERE local), 0) AS local_ms "
        f"FROM usage_events WHERE {where} GROUP BY provider ORDER BY usd DESC, provider",
        *args,
    )
    month_by_provider = {
        r["provider"]: Decimal(r["usd"])
        for r in await pool.fetch(
            "SELECT provider, COALESCE(SUM(cost_usd), 0) AS usd FROM usage_events "
            "WHERE at >= $1 AND NOT local GROUP BY provider",
            month_since,
        )
    }
    month_total = sum(month_by_provider.values(), Decimal(0))

    def provider_entry(r) -> dict:
        cap = limits.get(r["provider"])
        month_used = month_by_provider.get(r["provider"], Decimal(0))
        return {
            "provider": r["provider"],
            "local": r["local"],
            "usd": _num(r["usd"]),
            "calls": r["calls"],
            "unmetered": r["unmetered"],
            "refusals": r["refusals"],
            "gpu_seconds": round(r["local_ms"] / 1000, 1) if r["local"] else None,
            "month_usd": _num(month_used) if not r["local"] else None,
            "cap_usd": _num(cap),
            "remaining_usd": _num(cap - month_used) if cap is not None else None,
        }

    async def grouped(column: str) -> list[dict]:
        rows = await pool.fetch(
            f"SELECT {column} AS key, bool_or(local) AS local, COALESCE(SUM(cost_usd), 0) AS usd, "
            f"COUNT(*) FILTER (WHERE kind = 'completion') AS calls, "
            f"COUNT(*) FILTER (WHERE kind = 'completion' AND NOT metered) AS unmetered, "
            f"COALESCE(SUM(prompt_tokens), 0) AS prompt_tokens, "
            f"COALESCE(SUM(completion_tokens), 0) AS completion_tokens, "
            f"COALESCE(SUM(duration_ms) FILTER (WHERE local), 0) AS local_ms "
            f"FROM usage_events WHERE {where} AND kind = 'completion' "
            f"GROUP BY {column} ORDER BY usd DESC, calls DESC",
            *args,
        )
        return [
            {
                "key": str(r["key"]) if r["key"] is not None else None,
                "local": r["local"],
                "usd": _num(r["usd"]),
                "calls": r["calls"],
                "unmetered": r["unmetered"],
                "prompt_tokens": r["prompt_tokens"],
                "completion_tokens": r["completion_tokens"],
                "gpu_seconds": round(r["local_ms"] / 1000, 1),
            }
            for r in rows
        ]

    by_day = await pool.fetch(
        f"SELECT (at AT TIME ZONE $3)::date AS day, COALESCE(SUM(cost_usd), 0) AS usd, "
        f"COUNT(*) FILTER (WHERE kind = 'completion') AS calls, "
        f"COALESCE(SUM(duration_ms) FILTER (WHERE local), 0) AS local_ms "
        f"FROM usage_events WHERE {where} GROUP BY day ORDER BY day",
        *args,
        zone,
    )
    unpriced = await pool.fetch(
        f"SELECT provider, model, COUNT(*) AS calls FROM usage_events "
        f"WHERE {where} AND kind = 'completion' AND NOT local AND cost_usd IS NULL AND metered "
        f"GROUP BY provider, model ORDER BY calls DESC",
        *args,
    )
    refusals = await pool.fetch(
        f"SELECT at, provider, model, status, error, purpose FROM usage_events "
        f"WHERE {where} AND kind = 'refusal' ORDER BY at DESC LIMIT 20",
        *args,
    )
    return {
        "window": window,
        "since": since.isoformat(),
        "until": until.isoformat(),
        "timezone": zone,
        "totals": {
            "usd": _num(totals["usd"]),
            "usd_by_basis": {r["cost_basis"]: _num(r["usd"]) for r in by_basis},
            "gpu_seconds": round(totals["local_ms"] / 1000, 1),
            "calls": totals["calls"],
            "unmetered": totals["unmetered"],
            "refusals": totals["refusals"],
            "probes": totals["probes"],
            "ledger_write_failures": WRITE_FAILURES,
            "month_usd": _num(month_total),
            "month_cap_usd": _num(limits.get(TOTAL_CAP)),
            "in_flight_note": (
                "caps are checked against recorded spend; calls in flight are not yet counted"
            ),
        },
        "by_provider": [provider_entry(r) for r in providers],
        "by_model": await grouped("served_by"),
        "by_purpose": await grouped("purpose"),
        "by_role": await grouped("role"),
        "by_person": await grouped("person_id"),
        "by_day": [
            {
                "day": r["day"].isoformat(),
                "usd": _num(r["usd"]),
                "calls": r["calls"],
                "gpu_seconds": round(r["local_ms"] / 1000, 1),
            }
            for r in by_day
        ],
        "unpriced": [
            {"provider": r["provider"], "model": r["model"], "calls": r["calls"]} for r in unpriced
        ],
        "recent_refusals": [
            {
                "at": r["at"].isoformat(),
                "provider": r["provider"],
                "model": r["model"],
                "status": r["status"],
                "error": r["error"],
                "purpose": r["purpose"],
            }
            for r in refusals
        ],
        "caps": {k: _num(v) for k, v in limits.items()},
    }


async def events(
    pool: asyncpg.Pool, *, limit: int = 50, before: int | None = None, provider: str | None = None
) -> list[dict]:
    clauses, args = [], []
    if before is not None:
        args.append(before)
        clauses.append(f"id < ${len(args)}")
    if provider:
        args.append(provider)
        clauses.append(f"provider = ${len(args)}")
    args.append(max(1, min(limit, 500)))
    where = ("WHERE " + " AND ".join(clauses)) if clauses else ""
    rows = await pool.fetch(
        f"SELECT id, at, provider, model, served_by, kind, purpose, role, turn_id, person_id, "
        f"prompt_tokens, completion_tokens, cache_read_tokens, cache_write_tokens, duration_ms, "
        f"local, cost_usd, cost_basis, metered, status, error, route_reason, route_link "
        f"FROM usage_events {where} ORDER BY id DESC LIMIT ${len(args)}",
        *args,
    )
    out = []
    for r in rows:
        d = dict(r)
        d["at"] = d["at"].isoformat()
        d["cost_usd"] = _num(d["cost_usd"])
        d["turn_id"] = str(d["turn_id"]) if d["turn_id"] else None
        d["person_id"] = str(d["person_id"]) if d["person_id"] else None
        out.append(d)
    return out


async def prices(pool: asyncpg.Pool) -> list[dict]:
    rows = await pool.fetch(
        "SELECT provider, model, basis, prompt_usd_per_token, completion_usd_per_token, "
        "cache_read_multiplier, cache_write_multiplier, verified_at, source FROM provider_prices "
        "ORDER BY provider, model, basis"
    )
    return [
        {
            **dict(r),
            "prompt_usd_per_token": float(r["prompt_usd_per_token"]),
            "completion_usd_per_token": float(r["completion_usd_per_token"]),
            "cache_read_multiplier": _num(r["cache_read_multiplier"]),
            "cache_write_multiplier": _num(r["cache_write_multiplier"]),
            "verified_at": r["verified_at"].isoformat(),
        }
        for r in rows
    ]
