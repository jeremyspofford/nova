"""Money: spend against the caps, providers the gateway has walled, and a day
that cost far more than the week before it.

Every figure comes from the gateway's OWN ledger through spend_api.report —
the same report the Spend page and her spend_report tool read — so a notice
and a page can never disagree, and nothing here re-derives a dollar. None of
it is urgent: money over a cap waits for the digest (Jeremy's list has one
entry and it is the stack).

A ledger that cannot be read is CheckRun(ran=False) with the gateway's own
reason. It is never a finding that says all is well and never a 0 standing in
for an unknown — a 0 reads as a fact ("nothing was spent"), which is the exact
shape of the silent failure this slice exists to prevent.

Which figures go in `facts` (and so into the fingerprint) is a deliberate
split. A cap and a calendar month do not move, so they identify the condition;
this month's running total DOES move, every call, so it lives in the title —
hashing it would raise the same cap breach again every hour, which is the v3
noise failure in a new costume. A finished day's cost, by contrast, is final,
so the spike check carries its real numbers in the facts.
"""

from __future__ import annotations

from datetime import date, datetime, timedelta
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

import httpx

from app import agents, peers, spend_api
from app.checks import CannotCheck, Check, Finding, NotDue

ROUTES_TIMEOUT = httpx.Timeout(connect=5.0, read=15.0, write=5.0, pool=5.0)

# What counts as a spike, stated in the finding's own sentence so the reader
# never has to guess the rule that produced it.
SPIKE_MULTIPLE = 3.0
# The trailing window the mean is taken over, and the least history that makes
# a mean worth computing. Both are counted in days the LEDGER COVERS, never in
# days the report window spans — see daily_spike. Below the minimum the check
# has not run: saying "no spike" from two days of data would be a guess wearing
# an all-clear, and computing a mean over them would be worse.
TRAILING_DAYS = 7
MIN_TRAILING_DAYS = 3


async def _report(app, pool, window: str) -> dict:
    """spend_api.report, with every failure shape turned into "could not
    check". The route's HTTPException carries the gateway's own words in
    `detail`; anything else states its type."""
    try:
        return await spend_api.report(app, pool, window)
    except Exception as exc:  # noqa: BLE001 — a ledger that will not answer is stated, not raised
        detail = getattr(exc, "detail", None) or str(exc) or type(exc).__name__
        raise CannotCheck(f"the {window} ledger could not be read — {detail}") from exc


def _zone(report: dict) -> str:
    return str(report.get("timezone") or "UTC")


def _today(report: dict) -> date:
    """Today in the zone the ledger grouped its days by.

    The report's `until` is UTC 'now' while `by_day` is grouped in the
    household's zone, so the UTC date would name the wrong day for part of
    every evening — and naming the wrong day would let an unfinished day be
    compared as if it were complete.
    """
    try:
        return datetime.now(ZoneInfo(_zone(report))).date()
    except (ZoneInfoNotFoundError, ValueError) as exc:
        raise CannotCheck(
            f"the ledger reported the timezone {_zone(report)!r}, which does not load — "
            f"{type(exc).__name__}"
        ) from exc


def _month_label(report: dict) -> str:
    """The calendar month the `month` window counts, from the report's own
    `since` (local midnight of the month's first day). In the facts because a
    new month is new news: without it, going over the same cap again in
    October would fold onto September's notice and say nothing."""
    since = str(report.get("since") or "")
    try:
        return datetime.fromisoformat(since).strftime("%Y-%m")
    except ValueError as exc:
        raise CannotCheck(
            f"the ledger's report did not say which period it covers (since={since!r})"
        ) from exc


def _number(value) -> float | None:
    return float(value) if isinstance(value, int | float) and not isinstance(value, bool) else None


async def caps(app, pool) -> list[Finding]:
    """The month's spend against every cap the ledger states: the household
    total, and each provider's own. Over the cap the gateway stops choosing
    that link, so this is news about what will run, not only about money."""
    report = await _report(app, pool, "month")
    month = _month_label(report)
    findings: list[Finding] = []
    totals = report.get("totals") or {}
    cap, spent = _number(totals.get("month_cap_usd")), _number(totals.get("month_usd"))
    if cap is not None and spent is not None and spent >= cap:
        findings.append(
            Finding(
                key="spend_over_cap:total",
                title=(
                    f"household model spend {_word(spent, cap)} the monthly cap — "
                    f"{agents.money(spent)} of {agents.money(cap)} in {month}"
                ),
                facts={"scope": "total", "cap_usd": cap, "month": month},
            )
        )
    for row in report.get("by_provider") or []:
        if not isinstance(row, dict):
            continue
        name = str(row.get("provider") or "").strip()
        cap = _number(row.get("cap_usd"))
        spent = _number(row.get("month_usd"))
        if not name or cap is None or spent is None or spent < cap:
            continue
        findings.append(
            Finding(
                key=f"spend_over_cap:{name}",
                title=(
                    f"{name} {_word(spent, cap)} its monthly cap — {agents.money(spent)} of "
                    f"{agents.money(cap)} in {month}; calls to it fall back down the chain"
                ),
                facts={"scope": "provider", "provider": name, "cap_usd": cap, "month": month},
            )
        )
    return findings


def _word(spent: float, cap: float) -> str:
    """ "has reached" at equality, "is over" only past it — the same
    distinction agents.cap_problem persists, so a sentence never records a
    figure the ledger did not show."""
    return "is over" if spent > cap else "has reached"


async def walled_providers(app, pool) -> list[Finding]:
    """Providers the gateway is currently refusing to try.

    A wall is the gateway's own row (it walls a provider that refused, for an
    escalating period), read from /admin/routes — the same body the Routing
    page shows. `strikes` is in the facts because each new refusal genuinely
    is new news; `walled_until` is not, because it moves with every strike and
    would re-raise the same wall for the same reason.
    """
    try:
        async with peers.client(app, peers.GATEWAY, ROUTES_TIMEOUT) as client:
            resp = await client.get("/admin/routes")
    except peers.PeerUnconfigured as exc:
        raise CannotCheck(f"the gateway link is not configured — {exc}") from exc
    except httpx.HTTPError as exc:
        raise CannotCheck(f"the gateway could not be reached — {peers.reason(exc)}") from exc
    if resp.status_code != 200:
        raise CannotCheck(f"the gateway answered HTTP {resp.status_code} for its routing table")
    try:
        body = resp.json()
    except ValueError as exc:
        raise CannotCheck("the gateway's routing table was not JSON") from exc
    walls = body.get("walls") if isinstance(body, dict) else None
    if not isinstance(walls, list):
        raise CannotCheck("the gateway's routing table carries no walls list")
    findings = []
    for wall in walls:
        if not isinstance(wall, dict):
            continue
        name = str(wall.get("provider") or "").strip()
        if not name:
            continue
        why = str(wall.get("reason") or "").strip() or "the gateway stated no reason"
        until = str(wall.get("walled_until") or "")
        findings.append(
            Finding(
                key=f"provider_walled:{name}",
                title=(
                    f"{name} is walled until {until or 'an unstated time'} after "
                    f"{wall.get('strikes') or 1} refusal(s) — {why}"
                ),
                facts={
                    "provider": name,
                    "status": wall.get("status"),
                    "strikes": wall.get("strikes"),
                },
            )
        )
    return findings


def _by_day(report: dict) -> dict[date, float]:
    """The ledger's per-day totals as dates.

    The gateway groups EVERY usage row into this — completions, refusals and
    probes alike — so a day it listed is a day something happened and a day it
    did not list, INSIDE the range it covers, is a day nothing happened: a real
    zero. Outside that range an absent day says nothing at all, which is why
    daily_spike derives its coverage from these keys rather than from the
    report's window.
    """
    out: dict[date, float] = {}
    for row in report.get("by_day") or []:
        if not isinstance(row, dict):
            continue
        usd = _number(row.get("usd"))
        try:
            day = date.fromisoformat(str(row.get("day")))
        except ValueError:
            continue
        if usd is not None:
            out[day] = usd
    return out


async def daily_spike(app, pool) -> list[Finding]:
    """The most recent COMPLETE day, against the mean of the week before it.

    Complete, because today's total is still growing: comparing it would
    raise a spike at 23:00 that is not one, and re-raise it with different
    facts every hour. Only the latest complete day is judged, so an hourly
    beat folds onto one notice and the digest says it once.

    The trailing window is measured against what the LEDGER COVERS, never
    against what the report window spans. The gateway pins a 30d report's
    `since` at today-29 whatever history exists (usage.window_bounds), so
    taking the coverage from `since` measured the report and not the data: the
    minimum-history guard could never fire, and every day before the ledger's
    first row was counted as a real $0. On a two-day-old install that made a
    trailing mean of nearly nothing and turned the first ordinary day into a
    "12x spike" — a fabricated finding, from a check whose whole job is to be
    checkable. Coverage is therefore the earliest day the ledger actually
    listed; days missing inside it really did cost nothing, and days before it
    are unknown rather than zero.
    """
    report = await _report(app, pool, "30d")
    today = _today(report)
    days = _by_day(report)
    complete = [day for day in days if day < today]
    if not complete:
        raise CannotCheck(
            f"the ledger lists no complete day before {today.isoformat()} in the last 30 days"
        )
    target = max(complete)
    covered_from = min(days)
    available = (target - covered_from).days
    if available < MIN_TRAILING_DAYS:
        # NOT DUE, not a gap in coverage (S15). A young install is not a watcher
        # that failed to look — it is a world that does not exist yet, and it
        # resolves itself on a date this reason names. As CannotCheck it made
        # EVERY beat report "not quiet" for the install's first days, the same
        # sentence about twenty times in the owner's log, and a signal that is
        # always on cannot report the outage it exists for (the split `NotDue`
        # was added for). It is still named in every beat, so it can never read
        # as "looked and found nothing".
        ready = covered_from + timedelta(days=MIN_TRAILING_DAYS + 1)
        raise NotDue(
            f"the ledger's earliest day is {covered_from.isoformat()}, so it covers only "
            f"{available} day(s) before {target.isoformat()} — a trailing mean needs at least "
            f"{MIN_TRAILING_DAYS}, so this can first run from {ready.isoformat()}"
        )
    span = min(TRAILING_DAYS, available)
    # Every day in this range is inside coverage (span <= available), so a day
    # the ledger did not list here is a real zero and not one that predates it.
    trailing = [days.get(target - timedelta(days=n), 0.0) for n in range(1, span + 1)]
    mean = sum(trailing) / span
    usd = days.get(target, 0.0)
    if usd <= 0:
        return []
    if mean <= 0:
        # There is no multiple of nothing. A rise from $0.00 to $1.20 is a
        # first purchase, not a spike, and flagging it was the second half of
        # the young-install defect: the old code kept the finding and dropped
        # the number, so the notice said "against a previous 7 days that cost
        # nothing" as if that were evidence of anything.
        raise CannotCheck(
            f"the {span} day(s) before {target.isoformat()} cost nothing, so "
            f"{agents.money(usd)} has no multiple to be compared against"
        )
    multiple = round(usd / mean, 1)
    if multiple < SPIKE_MULTIPLE:
        return []
    return [
        Finding(
            key=f"spend_spike:{target.isoformat()}",
            title=(
                f"{target.isoformat()} cost {agents.money(usd)} — {multiple}x against "
                f"{agents.money(mean)}/day over the previous {span} day(s) "
                f"(flagged at {SPIKE_MULTIPLE:g}x)"
            ),
            facts={
                "day": target.isoformat(),
                "usd": round(usd, 4),
                "trailing_days": span,
                "trailing_mean_usd": round(mean, 4),
                "multiple": multiple,
                "threshold_multiple": SPIKE_MULTIPLE,
            },
        )
    ]


CHECKS: tuple[Check, ...] = (
    Check(
        name="money_caps",
        describe="This month's spend against the household cap and each provider's.",
        urgent=False,
        run=caps,
    ),
    Check(
        name="money_walled_providers",
        describe="Providers the gateway is currently walling after a refusal.",
        urgent=False,
        run=walled_providers,
    ),
    Check(
        name="money_daily_spike",
        describe=(
            f"A complete day costing {SPIKE_MULTIPLE:g}x the mean of the "
            f"{TRAILING_DAYS} days before it."
        ),
        urgent=False,
        run=daily_spike,
    ),
)

NAMES: tuple[str, ...] = tuple(check.name for check in CHECKS)
