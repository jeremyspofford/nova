"""Her spend tool: what the ledger says, every number with its basis in words.

Reads the same report the Spend page reads (spend_api.report), so a reply
and the page never disagree. Dollars are the gateway's ledger figures —
each recorded with the basis it was priced on; local calls are minutes of
GPU time, not money, and are said so; unmetered calls are counted and
named; caps are read with how much is left.
"""

from __future__ import annotations

from app import db, spend_api
from app.tools.base import Tool, ToolContext, ToolFailure

WINDOWS = spend_api.WINDOWS
BASIS_WORDS = {
    "provider-reported": "reported by the provider itself",
    "listing-price": "priced from the provider's own listing",
    "curated-price": "priced from the dated curated price list",
    "owner-price": "priced at the rate you entered",
}


def _usd(value) -> str:
    if not isinstance(value, int | float):
        return "no dollar figure"
    return f"${value:,.2f}" if value >= 0.01 or value == 0 else f"${value:,.4f}"


def _minutes(seconds) -> str:
    return f"{(seconds or 0) / 60:.1f} GPU-minutes (local time, not money)"


def _money_or_minutes(row: dict) -> str:
    return _minutes(row.get("gpu_seconds")) if row.get("local") else _usd(row.get("usd"))


def describe(report: dict) -> str:
    totals = report.get("totals") or {}
    lines = [
        f"Spend for {report.get('window')} ({report.get('since', '')[:10]} to "
        f"{report.get('until', '')[:10]}, {report.get('timezone')}): "
        f"{_usd(totals.get('usd'))} across {totals.get('calls', 0)} calls; "
        f"{_minutes(totals.get('gpu_seconds'))}."
    ]
    by_basis = totals.get("usd_by_basis") or {}
    if by_basis:
        lines.append(
            "How the dollars were priced: "
            + "; ".join(f"{_usd(v)} {BASIS_WORDS.get(k, k)}" for k, v in by_basis.items())
            + "."
        )
    if totals.get("unmetered"):
        lines.append(
            f"{totals['unmetered']} call(s) were unmetered — the provider stated no token "
            "counts, so they carry no dollars (a floor, not a measurement)."
        )
    if totals.get("refusals"):
        lines.append(f"{totals['refusals']} call(s) were refused by a provider (no cost).")
    if totals.get("ledger_write_failures"):
        lines.append(
            f"{totals['ledger_write_failures']} call(s) since the gateway started could not be "
            "recorded — the totals are a floor."
        )
    month_cap = totals.get("month_cap_usd")
    if month_cap is not None:
        lines.append(
            f"Monthly total cap {_usd(month_cap)}: spent {_usd(totals.get('month_usd'))} "
            "this month."
        )
    providers = report.get("by_provider") or []
    if providers:
        lines.append("By provider:")
        for p in providers:
            if p.get("local"):
                lines.append(
                    f"  - {p['provider']}: {p.get('calls', 0)} calls, "
                    f"{_minutes(p.get('gpu_seconds'))}"
                )
                continue
            cap = p.get("cap_usd")
            remaining = p.get("remaining_usd")
            if cap is None:
                cap_words = "; no cap"
            elif isinstance(remaining, int | float) and remaining <= 0:
                cap_words = f"; cap {_usd(cap)}/month — OVER the cap, calls fall back"
            else:
                cap_words = f"; cap {_usd(cap)}/month, {_usd(remaining)} left"
            unmetered = f", {p['unmetered']} unmetered" if p.get("unmetered") else ""
            lines.append(
                f"  - {p['provider']}: {_usd(p.get('usd'))} over {p.get('calls', 0)} calls"
                f"{unmetered}{cap_words}"
            )
    models = [m for m in report.get("by_model") or [] if m.get("calls")]
    if models:
        lines.append("By model:")
        for m in models[:12]:
            money = _minutes(m.get("gpu_seconds")) if m.get("local") else _usd(m.get("usd"))
            lines.append(
                f"  - {m['key']}: {money}, {m.get('calls', 0)} calls, "
                f"{m.get('prompt_tokens', 0):,} in / {m.get('completion_tokens', 0):,} out"
            )
    purposes = [p for p in report.get("by_purpose") or [] if p.get("calls")]
    if purposes:
        lines.append(
            "By purpose: "
            + "; ".join(
                f"{p['key']} {_money_or_minutes(p)} ({p.get('calls', 0)} calls)" for p in purposes
            )
            + "."
        )
    people = [p for p in report.get("by_person") or [] if p.get("calls")]
    if people:
        lines.append(
            "By person: "
            + "; ".join(
                f"{(p.get('person') or {}).get('name') or 'no person'} "
                f"{_money_or_minutes(p)} ({p.get('calls', 0)} calls)"
                for p in people
            )
            + "."
        )
    unpriced = report.get("unpriced") or []
    if unpriced:
        lines.append(
            "Metered but unpriced (no listed, curated or entered price): "
            + ", ".join(f"{u['provider']}:{u['model']} ({u['calls']} calls)" for u in unpriced)
            + "."
        )
    return "\n".join(lines)


async def spend_report(args: dict, ctx: ToolContext) -> str:
    window = str(args.get("window") or "month")
    if window not in WINDOWS:
        raise ToolFailure(f"window must be one of {', '.join(WINDOWS)}")
    try:
        report = await spend_api.report(ctx.app, await db.get_pool(), window)
    except Exception as exc:  # the route's own HTTPException, or a DB error: stated
        detail = getattr(exc, "detail", None) or str(exc)
        raise ToolFailure(f"the spend report could not be read — {detail}") from exc
    return describe(report)


TOOLS: tuple[Tool, ...] = (
    Tool(
        name="spend_report",
        description=(
            "What Nova's model calls have cost: dollars by provider, model, purpose "
            "(chat, scheduled, judge, eval, probe) and person, with how each dollar was "
            "priced, local GPU minutes as their own unit, unmetered calls counted, and the "
            "monthly caps with what is left. Use it for 'what did we spend', 'how much is "
            "left on openrouter', 'what is costing money'."
        ),
        parameters={
            "type": "object",
            "properties": {
                "window": {
                    "type": "string",
                    "enum": list(WINDOWS),
                    "description": "today | 7d | 30d | month (default month, the cap period).",
                },
            },
            "additionalProperties": False,
        },
        executor=spend_report,
        ephemeral=True,
    ),
)
