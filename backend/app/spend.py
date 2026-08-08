"""What a self-improvement pass costs, counted, with a ceiling that refuses.

ROADMAP #47 rail 3. `docs/plans/autonomous-improvement.md`:

    Each pass is a coding agent + an image build + a production-sized import
    + three suites. Today only wall-clock (`_LOOP_BUDGET_S`, 90 min) and
    per-goal action counts bound it; nothing counts money or tokens. A
    per-day ledger with a ceiling column, and a pass that would exceed it
    does not start.

Jeremy removed the approval click, and the click was the thing that had been
bounding spend — not deliberately, but effectively: nothing ran unless he
pressed a button, so nothing could run all night. Removing it without putting
a number in its place would make "continuous" mean "until the card declines".

WHAT REFUSES, AND WHERE. `may_start()` is called BEFORE a pass begins, and a
refusal stops the pass from being created at all. It is not advisory and
nothing downstream re-decides it: the caller either got a yes or there is no
run. That is the difference between a budget and a report.

THREE CEILINGS, BECAUSE ONLY ONE OF THEM CAN BE MEASURED TODAY.

    passes   always countable — one per `action_runs` row, from this table
    tokens   countable only when the coding agent reports usage
    usd      countable only when tokens are known AND priced

A PASS IS A RUN, NOT A ROW. `code_change._step_build` retries inside one pass
and writes a `coding_session` entry per ATTEMPT — deliberately, because a
failed attempt cost the same tokens as a successful one. Counting those rows
as passes made a three-attempt pass spend three of the operator's four, so the
number on the consent card ("at most 4 passes a day") was not the number the
code enforced. `passes` is therefore `count(DISTINCT run_id)`, and `attempts`
is reported beside it so the ledger still says how many coding sessions that
actually was. A row with no `run_id` counts as its own pass: an entry that
cannot say which pass it belongs to must not be silently folded into another.

The ACP protocol carries usage frames (`docs/plans/acp-coding-delegation.md`
section 3) and since 2026-08-08 `coder/broker.py` aggregates them into
`snapshot()` — but a sidecar image built before that reports nothing, and a
sandbox check has no meter at all, so entries still land here UNMETERED. That
is recorded as a fact — `metered = false`, tokens NULL — and never as a zero.
A ledger that reports "0 tokens" for a pass it could not measure reads as
cheap, which is the fallback-that-looks-like-success this repo keeps deleting.
The pass ceiling is what actually binds while that is true, and `today()` says
how much of the day is unmeasured so nobody mistakes a small number for a
small bill.

FAILS CLOSED. A ceilings row that cannot be read is a refusal, not a default:
"I could not find out what the limit is" and "the limit is fine" must not
reach the caller as the same answer.
"""

from __future__ import annotations

import json
import logging
from typing import Any, Optional

from app import db

log = logging.getLogger(__name__)

#: The lane a self-improvement pass is charged to. A string rather than an
#: enum because the ledger is meant to grow other spenders (evals, ingestion)
#: without a schema change; the ceiling row is per-lane for the same reason.
LANE_IMPROVE = "improve"

#: What one pass IS, for the ledger's `kind` column. Each is a real cost
#: centre: a coding agent's tokens, an image build plus a prod-sized import
#: plus four suites, and a reviewer model reading the diff.
KIND_BUILD = "coding_session"
KIND_SANDBOX = "sandbox_check"
KIND_REVIEW = "review"

#: A pass that never ran: the model provider refused the credential before any
#: work started (`provider_errors` — an HTTP 402/401/403 or the equivalent).
#:
#: DELIBERATELY NOT `KIND_BUILD`, and that distinction is the whole reason it
#: exists. `today()` counts passes and attempts by `kind = KIND_BUILD`, so
#: recording a billing wall as a build would spend the operator's daily
#: ceiling on work nobody did — which is exactly what happened on 2026-08-07:
#: four passes and twelve coding sessions consumed against an HTTP 402.
#:
#: It is still WRITTEN, rather than passed over in silence. "Nothing was
#: charged" and "nothing happened" are different facts, and the second one is
#: what the operator saw the first time: a pass that failed with no reason in
#: reach. The row costs nothing and says why the day is short a pass.
KIND_REFUSED = "provider_refusal"

#: Seeded by migration 116. Present here only so a test can state what the
#: shipped numbers are without querying; `ceilings()` never falls back to it.
SEEDED = {"max_passes": 4, "max_tokens": 2_000_000, "max_usd": 10.0}


class NoCeiling(RuntimeError):
    """The ceiling could not be read.

    Raised rather than returning a default, because a default IS a decision
    about how much of his money may be spent unattended, and this module is
    not the thing that gets to make it.
    """


async def ceilings(lane: str = LANE_IMPROVE) -> dict:
    """The operator's limits for this lane, read live on every check.

    Deliberately NOT cached. The whole point of a ceiling is that lowering it
    takes effect now — an operator who has just watched a loop misbehave
    should not have to restart the backend to stop it.
    """
    try:
        async with db.acquire() as conn:
            row = await conn.fetchrow(
                "SELECT max_passes, max_tokens, max_usd, updated_at, updated_by"
                "  FROM spend_ceilings WHERE lane = $1", lane)
    except Exception as e:                                   # noqa: BLE001
        raise NoCeiling(f"the spend ceiling could not be read: {e}") from e
    if row is None:
        raise NoCeiling(
            f"no spend ceiling is configured for the {lane!r} lane — nothing "
            f"may start until one exists (migration 116 seeds it)")
    return {"lane": lane,
            "max_passes": int(row["max_passes"]),
            "max_tokens": int(row["max_tokens"]),
            "max_usd": float(row["max_usd"]),
            "updated_at": str(row["updated_at"]) if row["updated_at"] else None,
            "updated_by": row["updated_by"]}


async def set_ceiling(lane: str = LANE_IMPROVE, *, updated_by: str = "operator",
                      **limits) -> dict:
    """Move a ceiling. Only the operator's route should reach this.

    Kept here rather than in a settings key because `settings_store._DEFS` is
    a hand-maintained list this lane does not own; when a key is registered
    there, this becomes its writer rather than its competitor.
    """
    allowed = {"max_passes", "max_tokens", "max_usd"}
    fields = {k: v for k, v in limits.items() if k in allowed and v is not None}
    if not fields:
        raise ValueError(f"nothing to set — pass one of {sorted(allowed)}")
    for k, v in fields.items():
        if float(v) < 0:
            raise ValueError(f"{k} cannot be negative")
    sets = ", ".join(f"{k} = ${i}" for i, k in enumerate(fields, start=3))
    async with db.acquire() as conn:
        row = await conn.fetchrow(
            f"UPDATE spend_ceilings SET {sets}, updated_at = now(), "
            f"updated_by = $2 WHERE lane = $1 RETURNING lane", lane,
            updated_by, *fields.values())
    if row is None:
        raise ValueError(f"no spend ceiling row for the {lane!r} lane")
    log.info("spend ceiling for %s changed by %s: %s", lane, updated_by, fields)
    return await ceilings(lane)


#: One row per attempt, one PASS per `action_runs` row. The `coalesce` gives a
#: row that carries no `run_id` its own bucket rather than merging every such
#: row into one pass — "I don't know which pass this was" must round toward
#: spending more of the budget, not less. The `'row:'` prefix makes a ledger
#: id and a run id incapable of colliding in that bucket key.
#:
#: `$3` is the run being EXCLUDED from the pass count — see `today()`.
_TODAY_SQL = """
    SELECT count(DISTINCT coalesce(run_id::text, 'row:' || id::text))
             FILTER (WHERE kind = $2
                       AND ($3::uuid IS NULL
                            OR run_id IS DISTINCT FROM $3::uuid)) AS passes,
           count(*) FILTER (WHERE kind = $2)                      AS attempts,
           count(*)                                               AS entries,
           count(*) FILTER (WHERE NOT metered)                    AS unmetered,
           coalesce(sum(tokens_in), 0)                            AS tokens_in,
           coalesce(sum(tokens_out), 0)                           AS tokens_out,
           coalesce(sum(usd), 0)                                  AS usd
      FROM spend_ledger
     WHERE lane = $1 AND day = current_date"""


async def today(lane: str = LANE_IMPROVE, *,
                exclude_run: Optional[str] = None) -> dict:
    """What this lane has spent since local midnight.

    `day` is written by the ledger as a DATE in the database's timezone, so
    "today" is one comparison rather than a window computed by whoever asks —
    two callers disagreeing about where the day starts is how a ceiling gets
    spent twice.

    `passes` counts distinct runs; `attempts` counts `coding_session` rows.
    They differ whenever a pass retried, and reporting only the second as
    "passes" is the defect this signature exists to make unrepeatable.

    `exclude_run` leaves ONE run out of the pass count, and out of nothing
    else. The caller is `code_change._step_build`, re-checking the ceiling
    before each retry of a pass that has already been cleared to start: it is
    asking "is there still room for this pass", and counting the pass against
    itself would make the ceiling refuse the very run it just authorised. Its
    tokens and dollars stay in the totals, because they were really spent.
    """
    async with db.acquire() as conn:
        row = await conn.fetchrow(_TODAY_SQL, lane, KIND_BUILD,
                                  str(exclude_run) if exclude_run else None)
    tin, tout = int(row["tokens_in"]), int(row["tokens_out"])
    return {"lane": lane, "passes": int(row["passes"]),
            "attempts": int(row["attempts"]),
            "entries": int(row["entries"]), "unmetered": int(row["unmetered"]),
            "tokens_in": tin, "tokens_out": tout, "tokens": tin + tout,
            "usd": float(row["usd"])}


#: The BASE wait after a terminal wall stops a pass, before another may start.
#: MEASURED TWICE, and the second measurement is why it escalates now.
#: 2026-08-07: the loop ran FOUR passes against one HTTP 402, hours apart.
#: 2026-08-08: with this flat hour in place it ran THIRTEEN, because the
#: heartbeat ticks roughly every ninety minutes — a 3600-second cooldown had
#: always expired by the next tick and therefore gated nothing. Nothing in the
#: ceiling could see any of them: a refused pass costs no tokens and no
#: dollars, so the only budget it spent was the operator's goal actions and
#: his attention.
#:
#: So the wait DOUBLES on each consecutive hit of the SAME wall kind (see
#: `active_wall`), capped below, and it still expires on its own — the fix is
#: somebody topping up an account, and a wall must not become a switch he has
#: to find and reset. The cost of being wrong is one delayed pass; the cost of
#: the flat hour is on record.
REFUSAL_COOLDOWN_S = 3600
#: Where the doubling stops. Six hours: long enough that an overnight wall is
#: hit a handful of times rather than every tick, short enough that a topped-
#: up account resumes the same day with nobody touching anything.
WALL_BACKOFF_CAP_S = 6 * 3600

#: Wall KINDS — what stopped a pass before any work ran. Written into the
#: ledger row's detail (`{"wall": ...}`) so consecutive hits of the SAME
#: problem can be told from a new problem; a row that predates the key is a
#: provider refusal, because that was the only wall the ledger recorded.
WALL_PROVIDER = "provider"
WALL_DIRTY_REPO = "dirty_repo"
WALL_CEILING = "ceiling"


def wall_backoff_s(streak: int) -> float:
    """How long the Nth consecutive hit of one wall pauses the lane.

    Pure, so the doubling is pinned by tests without a ledger: 1h, 2h, 4h,
    then the cap. `streak` is 1-based — the first hit waits the base hour.
    """
    return float(min(REFUSAL_COOLDOWN_S * (2 ** max(0, int(streak) - 1)),
                     WALL_BACKOFF_CAP_S))


def _wall_of(detail) -> str:
    if isinstance(detail, str):
        try:
            detail = json.loads(detail)
        except ValueError:
            detail = {}
    if not isinstance(detail, dict):
        detail = {}
    return str(detail.get("wall") or WALL_PROVIDER)


def _leading_wall(rows) -> Optional[tuple[str, int, dict]]:
    """The wall the ledger's newest entries are stuck on: (kind, streak, newest).

    `rows` are newest-first, refusals and builds mixed. A BUILD at the head
    means the most recent thing that happened got past preflight — that is
    the reset, mechanically: only a coding session that actually started
    writes one, so no flag needs clearing and none exists. The streak counts
    only LEADING refusals of the SAME kind, because a different wall is a
    different problem and starts its own doubling from one.
    """
    rows = list(rows or ())
    if not rows or rows[0]["kind"] != KIND_REFUSED:
        return None
    wall = _wall_of(rows[0]["detail"])
    streak = 0
    for r in rows:
        if r["kind"] != KIND_REFUSED or _wall_of(r["detail"]) != wall:
            break
        streak += 1
    return wall, streak, dict(rows[0])


async def active_wall(lane: str = LANE_IMPROVE, *,
                      exclude_run: Optional[str] = None) -> Optional[dict]:
    """The wall this lane must not walk back into yet, or None.

    `exclude_run` leaves the CURRENT pass out, for the same reason `today()`
    does: a pass that has just recorded a refusal and is deciding whether to
    make one licensed retry must not be refused by its own row.
    """
    try:
        async with db.acquire() as conn:
            rows = await conn.fetch(
                """SELECT kind, detail, created_at,
                          EXTRACT(EPOCH FROM (now() - created_at)) AS age_s
                     FROM spend_ledger
                    WHERE lane = $1 AND kind IN ($2, $3)
                      AND ($4::uuid IS NULL OR run_id IS DISTINCT FROM $4::uuid)
                    ORDER BY created_at DESC LIMIT 50""",
                lane, KIND_REFUSED, KIND_BUILD,
                str(exclude_run) if exclude_run else None)
    except Exception:                                        # noqa: BLE001
        # A backoff that cannot be read must not block work: the ceiling
        # above it is the control, and this is a courtesy on top of it.
        log.exception("could not read the wall backoff")
        return None
    got = _leading_wall(rows)
    if got is None:
        return None
    wall, streak, newest = got
    age_s = float(newest["age_s"] or 0)
    cooldown_s = wall_backoff_s(streak)
    if age_s >= cooldown_s:
        return None
    detail = newest["detail"]
    if isinstance(detail, str):
        try:
            detail = json.loads(detail)
        except ValueError:
            detail = {}
    mins = max(1, int((cooldown_s - age_s) / 60))
    doubling = ("" if streak < 2 else
                f" This wall has now been hit {streak} times in a row, so the "
                f"wait doubled (it caps at {int(WALL_BACKOFF_CAP_S / 3600)}h "
                f"and resets the moment a pass gets past preflight).")
    note = str((detail or {}).get("operator_note") or "").strip()
    if wall == WALL_PROVIDER:
        head = ("the model provider refused the last pass and retrying cannot "
                "fix that")
    else:
        head = f"the last pass stopped at the same wall ({wall})"
    return {"wall": wall, "streak": streak, "age_s": age_s,
            "cooldown_s": cooldown_s, "at": str(newest["created_at"]),
            "detail": detail or {},
            "note": (f"{head}, so nothing starts for another {mins} "
                     f"minute(s).{doubling} {note}").strip()}


async def may_start(lane: str = LANE_IMPROVE, *,
                    exclude_run: Optional[str] = None) -> tuple[bool, str]:
    """May another pass begin right now? `(verdict, reason)`.

    THE CONTROL. Everything else in this module is bookkeeping around it.

    The reason is written for the operator reading a run summary, so it
    always states the number that stopped it and the number he set — "over
    budget" sends him to the database to find out which budget. It names the
    attempt count too whenever it differs from the pass count, because those
    attempts are the coding sessions that were actually paid for and a line
    reading "pass 2 of 4" over six sessions is the reassuring half-truth.

    `exclude_run` is passed straight to `today()`: a pass re-checking the
    ceiling between its own retries must not be counted against itself.

    NOT ATOMIC WITH THE SPEND, deliberately and safely. The caller's next act
    is `goals.spend_standing`, which is a single atomic UPDATE against the
    goal's own action count, and the improvement lane refuses to enqueue a
    second run while one is in flight. So the race this cannot lose is
    "two passes started at once"; what it could lose is "the fourth and fifth
    pass of the day both saw three", which costs one pass and is bounded by
    the goal's own budget. Making it atomic would mean writing a ledger row
    for a pass that has not been created yet, and a phantom charge is worse
    than an occasional off-by-one.
    """
    try:
        cap = await ceilings(lane)
    except NoCeiling as e:
        return False, str(e)

    # A WALL IS NOT A BUDGET, and the ceiling cannot see it. A pass refused
    # for credentials or billing costs nothing measurable, so thirteen of them
    # in a row look free to every number below and were, in fact, free — of
    # everything except the operator's goal actions and his ability to find
    # out why nothing worked.
    wall = await active_wall(lane, exclude_run=exclude_run)
    if wall:
        return False, wall["note"]

    spent = await today(lane, exclude_run=exclude_run)

    #: Said in every message, refusal or not: the pass count is what the
    #: ceiling is written in, and the attempt count is what was actually run.
    #: They are equal until something retried.
    tries = spent["attempts"]
    ran = (f" ({tries} coding attempts across them)"
           if tries != spent["passes"] else "")

    if spent["passes"] >= cap["max_passes"]:
        return False, (
            f"the daily ceiling is spent: {spent['passes']} pass(es) already "
            f"started today{ran} and the limit is {cap['max_passes']}. Nothing "
            f"starts until tomorrow, or until you raise the ceiling.")
    if cap["max_tokens"] and spent["tokens"] >= cap["max_tokens"]:
        return False, (
            f"the daily token ceiling is spent: {spent['tokens']:,} measured "
            f"today against a limit of {cap['max_tokens']:,}.")
    if cap["max_usd"] and spent["usd"] >= cap["max_usd"]:
        return False, (
            f"the daily cost ceiling is spent: ${spent['usd']:.2f} measured "
            f"today against a limit of ${cap['max_usd']:.2f}.")

    note = ""
    if spent["unmetered"]:
        # SAID OUT LOUD. The remaining budget above is a token/dollar figure
        # computed over the entries that could be measured; the rest cost
        # something and are not in it. Reporting the headroom without this
        # would be the reassuring half-truth.
        note = (f" ({spent['unmetered']} of today's {spent['entries']} ledger "
                f"entries carry no usage figures — their cost is real but "
                f"unmeasured, so the totals above understate the day)")
    return True, (f"pass {spent['passes'] + 1} of {cap['max_passes']} today"
                  f"{ran}; {spent['tokens']:,} tokens and ${spent['usd']:.2f} "
                  f"measured so far{note}")


async def record(lane: str, kind: str, *, usage: Optional[dict] = None,
                 usd: Optional[float] = None, model: str = "",
                 session_id: Optional[str] = None,
                 run_id: Optional[str] = None,
                 goal_id: Optional[str] = None,
                 detail: Optional[dict] = None) -> dict:
    """Write one cost entry. Never raises — a ledger failure must not kill a run.

    `metered` is derived from whether usage figures actually arrived, not
    from whether the caller meant to supply them. An entry with `metered =
    false` carries NULL token counts rather than zeros, so `sum()` cannot
    quietly average an unknown down to nothing. A dollar figure alone counts
    as measured: the live ACP adapter streams a cumulative USD cost without
    token counts, and calling that row unmetered would label a real bill
    "no usage figures".
    """
    u = usage or {}
    tin = _int_or_none(u.get("tokens_in"))
    tout = _int_or_none(u.get("tokens_out"))
    metered = tin is not None or tout is not None or usd is not None
    try:
        async with db.acquire() as conn:
            row = await conn.fetchrow(
                """INSERT INTO spend_ledger
                       (lane, kind, model, session_id, run_id, goal_id,
                        tokens_in, tokens_out, usd, metered, detail)
                   VALUES ($1,$2,$3,$4::uuid,$5::uuid,$6::uuid,$7,$8,$9,$10,
                           $11::jsonb)
                RETURNING id, day, metered""",
                lane, kind, (model or "")[:120],
                str(session_id) if session_id else None,
                str(run_id) if run_id else None,
                str(goal_id) if goal_id else None,
                tin, tout, usd, metered,
                json.dumps(detail or {}))
        return {"id": str(row["id"]), "day": str(row["day"]),
                "metered": bool(row["metered"])}
    except Exception:                                        # noqa: BLE001
        log.exception("could not write a %s/%s spend entry", lane, kind)
        return {"id": None, "metered": False, "error": "not recorded"}


async def entries(lane: str = LANE_IMPROVE, limit: int = 50) -> list[dict]:
    """The ledger, newest first — what the operator reads when he asks why."""
    async with db.acquire() as conn:
        rows = await conn.fetch(
            "SELECT id, day, lane, kind, model, tokens_in, tokens_out, usd, "
            "       metered, session_id, run_id, goal_id, created_at "
            "  FROM spend_ledger WHERE lane = $1 "
            " ORDER BY created_at DESC LIMIT $2", lane, max(1, min(limit, 500)))
    out = []
    for r in rows:
        d = dict(r)
        for k in ("id", "session_id", "run_id", "goal_id"):
            d[k] = str(d[k]) if d[k] else None
        d["day"] = str(d["day"])
        d["created_at"] = str(d["created_at"])
        d["usd"] = float(d["usd"]) if d["usd"] is not None else None
        out.append(d)
    return out


# ── reading a usage block off whatever the sidecar sent ──────────────────────

#: The ACP `usage` block's field names, as observed in
#: `docs/plans/acp-coding-delegation.md` section 3, plus the snake_case and
#: OpenAI spellings — three adapters exist and they do not agree, and a
#: meter that only understands one of them silently reports nothing.
_IN_KEYS = ("inputTokens", "input_tokens", "prompt_tokens", "promptTokens")
_OUT_KEYS = ("outputTokens", "output_tokens", "completion_tokens",
             "completionTokens")
_CACHE_KEYS = ("cachedReadTokens", "cached_read_tokens", "cached_tokens",
               "cachedTokens")


def usage_from_updates(updates: Any) -> Optional[dict]:
    """The most recent usage figures in an ACP update stream, or None.

    None IS the answer when no frame carried usage, and the caller records
    the entry as unmetered. Returning `{"tokens_in": 0}` instead would be the
    same lie in a different shape.

    ACP usage frames are cumulative for the session, so the LAST one wins
    rather than the sum — adding them would multiply a session's cost by the
    number of times it reported.

    NOTE the honesty flag: `coder/broker.py` returns only the last twelve
    updates (`snapshot()["tail"]`), so a session whose final frame fell out
    of that window is measured from an earlier one. `partial` says so, and
    the caller puts it in the ledger's detail rather than presenting a lower
    bound as a total.
    """
    if not isinstance(updates, (list, tuple)):
        return None
    found = None
    for u in updates:
        if not isinstance(u, dict):
            continue
        block = u.get("usage") if isinstance(u.get("usage"), dict) else None
        if block is None and _any_key(u, _IN_KEYS + _OUT_KEYS):
            block = u
        if block is None:
            continue
        tin = _first(block, _IN_KEYS)
        tout = _first(block, _OUT_KEYS)
        if tin is None and tout is None:
            continue
        found = {"tokens_in": tin, "tokens_out": tout,
                 "cached_tokens": _first(block, _CACHE_KEYS)}
    return found


def _any_key(d: dict, keys) -> bool:
    return any(k in d for k in keys)


def _first(d: dict, keys) -> Optional[int]:
    for k in keys:
        if k in d:
            return _int_or_none(d[k])
    return None


def _int_or_none(v) -> Optional[int]:
    if v is None or isinstance(v, bool):
        return None
    try:
        return int(v)
    except (TypeError, ValueError):
        return None
