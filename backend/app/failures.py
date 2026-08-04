"""Everything that is failing right now, discovered from the schema.

On 2026-08-02 the operator pointed at two red rows on the Activity page and
asked Nova what had happened. She said she could not read them, and she was
right — but the interesting part is that she had already looked.

`diagnose` was the tool for this, and diagnose answered
"8 error(s) recorded in the last 72h". None of the eight were the two rows on
his screen. It reads `turn_spans`, and `ingest_worker.py` declines to open a
trace on purpose — correctly, because "the ingest_jobs row IS this job's
durable, per-item record". Every other signal she could reach agreed that
things were fine: all 18 `ingest_media` spans were 'ok', all four followed
sources were 'ok', the poll automation was 'ok' (the poll DID succeed; it
only enqueues, and the failure happens minutes later in the worker).

So she was not merely blind. She was being reassured, in a confident,
complete-looking sentence, over the exact thing she was being asked about.
That is worse than silence, and it is the property this module exists to make
impossible.

The design follows diagnostics.py's four rules, which were written for the
same complaint one week earlier:

* READ-ONLY. Nothing here writes. `census` stays inside a tool that is
  already a READER under the containment fence, so it needs no new trust.
* DERIVED. The failure stores are discovered by querying `information_schema`
  on every call. There is no list of tables. A queue that lands next month is
  censused the day its migration runs, with no edit here — and if its shape is
  one this module does not understand, `unclassified` catches it and the
  report refuses (see `_DECLINED`, and test_failure_census.py).
* SCRUBBED. Failure text is third-party text: yt-dlp's stderr, an MCP
  server's complaint, a provider's 403 body. It goes through redact.
* HONEST ABOUT ABSENCE. A store that cannot be read lands in `unreadable`
  rather than contributing a silent zero — the live defect this fixes is
  diagnostics._recent_errors returning [] on exception, where an unreadable
  store and a healthy one are the same answer.

WHY THE PREDICATE IS PER-SHAPE. Four shapes exist in this database and the
difference is load-bearing:

  1. status-authoritative — `ingest_jobs.mark_skipped` writes the SKIP REASON
     into `error` (the worker passes reason='already ingested'), so
     "error IS NOT NULL" reports a successful dedupe as a failure. Where a
     status column exists it decides, and the error column only supplies text.
  2. error-only — `attachments` has `text_error` and no status at all.
  3. raise/clear — `monitor_alerts` records disk, VRAM and unreachable-instance
     alerts with `raised_at`/`cleared_at` and neither a status nor an error
     column, so both predicates above miss it entirely. Openness is
     `cleared_at IS NULL`. Note that `conversations` also has a `cleared_at`
     (it marks a cleared context), which is why this shape requires the RAISE
     column too — the pair is what makes it an alert. Deriving the pair rather
     than naming the table is what keeps `conversations` out without an
     exclusion entry.
  4. counter — `push_subscriptions` records a dead endpoint as a `failures`
     tally with no status, no error text and nothing to clear. Missing this
     shape would reproduce the exact outage diagnostics.py was written for.

Getting (1) backwards costs a false alarm on every deduped video; getting it
right but skipping (2), (3) or (4) means she cannot see a full disk or a push
endpoint that has stopped accepting. `eval_runs` proves the same point from
the other side: it has 4 failed rows and every one of them has
`error IS NULL`, so a status-blind predicate reports zero.
"""

from __future__ import annotations

import hashlib
import logging
import re
import time
from typing import Optional

from app import db, redact

log = logging.getLogger(__name__)

# A sample is an illustration, never the count. `failed` is always an
# unbounded COUNT(*) so the number handed to a model is the true number.
_SAMPLES = 3
_ERROR_MAX = 300
# What "lately" means. Failed rows are never swept (ingest_jobs.purge_old
# takes only done/skipped), so without a window every count grows forever.
_RECENT_DAYS = 7

# Columns that make a table a failure store ON THEIR OWN. Deliberately narrow,
# and the narrowness was measured: an earlier draft also qualified on `detail`,
# `message` and `summary`, which are generic enough that `capability_events`
# reported 45 failures and `resource_samples` 6747 — every row, because every
# row has a detail. A qualifying column must MEAN failure, not merely carry
# text. Wider display columns are `_TEXT_COLS`, used only once a table has
# already qualified.
_ERROR_COLS = ("error", "last_error", "status_detail", "text_error")

# Where the failure TEXT is read from once a store qualifies. Free to be
# generous — nothing here decides whether a row is a failure.
_TEXT_COLS = _ERROR_COLS + ("message", "summary", "last_summary", "detail")

# A monotonically counted failure, the shape `push_subscriptions` uses: no
# status, no error text, just a tally that means the endpoint keeps rejecting.
# That is precisely the push-notification outage diagnostics.py was written
# for, so missing this shape would reproduce the original bug.
_COUNTER_COLS = ("failures", "failure_count", "consecutive_failures")

# A status column decides, when there is one. Matches status, state,
# last_status — and not 'estate'.
_STATUS_RE = re.compile(r"(^|_)(status|state)$")

# The failure vocabulary, matched case-insensitively against the status
# value. Grounded in what this database actually stores: ingest_jobs 'failed',
# mcp_servers / source_subscriptions / turn_traces 'error'. The rest are the
# obvious neighbours, present so a new subsystem that says 'crashed' is not
# silently clean.
# 'killed' is deliberately ABSENT. In this codebase it has exactly one writer
# — coder.kill(), which stamps "killed by operator" — and coder.TERMINAL
# treats it as a normal end alongside 'done'. Counting it made every coding
# session the operator deliberately stopped an open failure, forever. If a
# future subsystem uses 'killed' to mean 'crashed', that is the case for
# giving the operator stop its own word rather than for alarming on both.
_FAILED = ("failed", "failing", "error", "errored", "crashed",
           "timeout", "timed_out", "dead", "unreachable", "broken")

# A SCORE PAIR next to a status column means the status is a GRADE, not a
# fault: `eval_runs` writes status='failed' when the model under test scored
# below the pass bar on a run the harness completed perfectly, and reserves
# 'error' for a harness crash. Counting the grade put four false failures in
# front of her. Derived from the schema, so a future scoring table excuses
# itself and `automation_runs` (ok/failed, no score pair) stays counted.
_SCORE_PAIRS = (("tasks_passed", "tasks_total"), ("passed", "total"),
                ("score", "max_score"))

# The raise/clear shape: BOTH are required, for the `conversations` reason
# given in the docstring.
_RAISED_COLS = ("raised_at", "opened_at", "triggered_at")
_CLEARED_COLS = ("cleared_at", "resolved_at", "closed_at")

# Newest-first ordering, best first. Every candidate is a timestamp.
_TIME_COLS = ("updated_at", "finished_at", "raised_at", "last_checked_at",
              "last_polled_at", "last_ok", "started_at", "enqueued_at",
              "created_at")

# Something to call the row in one line, best first.
_LABEL_COLS = ("title", "name", "url", "label", "kind", "model", "slug",
               "filename", "id")

# Small facts that turn "it failed" into "retrying is pointless": whichever of
# these the table has ride along on each sample.
_DETAIL_COLS = ("attempts", "max_attempts", "orphans", "enqueued_by",
                "source_key", "instance_id", "value", "threshold",
                "status", "state", "last_status",
                "failures", "failure_count", "consecutive_failures")

# ── stores that are failure-SHAPED but are not background failures ──────────
#
# This is the one hand-maintained artifact in the module, and it is the case
# where a list is not a costume: a table that is neither censused nor declined
# does not get skipped, it makes the whole report INCOMPLETE (see `census`)
# and reddens test_failure_census.py. Not maintaining it refuses. Every entry
# owes a reason.
_DECLINED = {
    "turn_traces": "the turn ledger diagnose already reads directly, via "
                   "recent_errors — censusing it would double-report every "
                   "in-turn error and drown the background ones",
    "turn_spans": "same ledger, span granularity",
    "consents": "an operator decision record; 'expired' is a normal end of "
                "life, not a failure",
    "goals": "'abandoned' is an operator decision, not a failure",
    "recommendations": "the inbox; 'dismissed' is a decision",
    "conversations": "a cleared context is a normal act, not an alert",
    "media_ingests": "its status vocabulary is vestigial — the only writer "
                     "passes 'ok' literally, and the real per-item outcome "
                     "lives in ingest_jobs",
    "automations": "last_status/last_summary are written on SUCCESS too; the "
                   "per-run truth is automation_runs, which IS censused",
    "attachments": "text_error records ordinary outcomes, not failures — a "
                   "photo with no text in it, a zip, an empty file, OCR "
                   "switched off. It has no status column to overrule it and "
                   "nothing ever clears it, so counting it would make every "
                   "chat photo a permanent open failure",
}


def _decline_reason(table: str, store: "_Store") -> Optional[str]:
    """Why a failure-shaped table is not a failure store — static or derived.

    Derived reasons are preferred: `_DECLINED` is a list someone maintains,
    and the score-pair rule excuses a whole CLASS of scoring tables without
    anyone editing anything.
    """
    if table in _DECLINED:
        return _DECLINED[table]
    if store.status_col and store.score_pair:
        return (f"{store.status_col} is a GRADE, not a fault — the table "
                f"carries {store.score_pair[0]}/{store.score_pair[1]}, so "
                f"'failed' means scored-below-the-bar on a run that "
                f"completed")
    return None


def declined() -> dict:
    """The exclusions and their reasons — surfaced, never silent."""
    return dict(_DECLINED)


def _first(cols: set[str], candidates) -> Optional[str]:
    for c in candidates:
        if c in cols:
            return c
    return None


async def _schema(conn) -> dict[str, set[str]]:
    """{table: {column}} for every public base table. The whole derivation."""
    rows = await conn.fetch(
        """SELECT c.table_name AS t, c.column_name AS c
             FROM information_schema.columns c
             JOIN information_schema.tables tb
               ON tb.table_schema = c.table_schema
              AND tb.table_name = c.table_name
            WHERE c.table_schema = 'public'
              AND tb.table_type = 'BASE TABLE'""")
    out: dict[str, set[str]] = {}
    for r in rows:
        out.setdefault(r["t"], set()).add(r["c"])
    return out


class _Store:
    """One failure store: which columns say what, and the predicate."""

    def __init__(self, table: str, cols: set[str]):
        self.table = table
        self.cols = cols
        self.qualifying_col = _first(cols, _ERROR_COLS)
        self.counter_col = _first(cols, _COUNTER_COLS)
        self.error_col = _first(cols, _TEXT_COLS)
        self.status_col = next(
            (c for c in sorted(cols) if _STATUS_RE.search(c)), None)
        raised = _first(cols, _RAISED_COLS)
        cleared = _first(cols, _CLEARED_COLS)
        self.cleared_col = cleared if (raised and cleared) else None
        self.time_col = _first(cols, _TIME_COLS)
        self.label_col = _first(cols, _LABEL_COLS)
        self.detail_cols = [c for c in _DETAIL_COLS if c in cols]
        self.score_pair = next(
            ((a, b) for a, b in _SCORE_PAIRS if a in cols and b in cols), None)
        # Something the operator switched off is not something that is
        # failing. mcp_servers, source_subscriptions and llm_providers all
        # carry `enabled` and none of them clears its failure state on
        # disable, so without this a broken thing you turned OFF reports
        # forever and there is no way to make it stop.
        self.enabled_col = "enabled" if "enabled" in cols else None

    @property
    def qualifies(self) -> bool:
        return bool(self.cleared_col or self.status_col
                    or self.counter_col or self.qualifying_col)

    @property
    def shape(self) -> str:
        if self.cleared_col:
            return "alert"
        if self.status_col:
            return "status"
        if self.counter_col:
            return "counter"
        return "error"

    def predicate(self) -> tuple[str, list]:
        """SQL fragment + args. Ordered exactly as the docstring argues."""
        if self.cleared_col:
            where, args = f'"{self.cleared_col}" IS NULL', []
        elif self.status_col:
            where, args = (f'lower("{self.status_col}"::text) = ANY($1)',
                           [list(_FAILED)])
        elif self.counter_col:
            where, args = f'"{self.counter_col}" > 0', []
        else:
            where, args = (f'"{self.qualifying_col}" IS NOT NULL '
                           f'AND btrim("{self.qualifying_col}"::text) <> \'\''), []
        if self.enabled_col:
            where += f' AND "{self.enabled_col}" IS NOT FALSE'
        return where, args

    @property
    def present_tense(self) -> bool:
        """True when the predicate describes a condition open RIGHT NOW.

        An open alert and a failure tally are not events with an age — the
        row's timestamp is when the condition STARTED. Windowing them would
        mean a longer outage is a staler one, so a disk that filled up ten
        days ago and is still full would drop out of the prompt line entirely.
        The longer it lasts, the more certainly it would be silenced.
        """
        return bool(self.cleared_col or self.counter_col)


async def _scan_one(conn, store: _Store, samples: int, days: int) -> dict:
    """Count and illustrate one store. Raises — the caller records unreadable.

    Two counts, not one, and the difference is the point. Some of these stores
    hold a CONDITION (mcp_servers has one row per server: failed means broken
    right now); others hold a LOG OF RUNS (automation_runs failed 12 times
    since July, and the automation has succeeded on every run since). Handing
    a model the bare 12 invites "twelve things are broken", which is the same
    species of confident-and-wrong the whole module exists to prevent. So
    `failed` is everything and `recent` is the last `days` — and the note says
    which is which rather than making her infer it.
    """
    where, args = store.predicate()
    failed = await conn.fetchval(
        f'SELECT count(*) FROM "{store.table}" WHERE {where}', *args)
    out = {"failed": int(failed or 0), "shape": store.shape,
           "decided_by": (store.cleared_col or store.status_col
                          or store.counter_col or store.qualifying_col),
           "recent_failed": 0, "recent": []}
    if not out["failed"]:
        return out

    # A store with no timestamp cannot be aged, and a PRESENT-TENSE one must
    # not be — see _Store.present_tense. Either way the full count is the
    # recent count; silently dropping it to zero is how an outage goes quiet.
    if store.time_col and not store.present_tense:
        out["recent_failed"] = int(await conn.fetchval(
            f'SELECT count(*) FROM "{store.table}" WHERE {where} '
            f'AND "{store.time_col}" > now() - ($%d || \' days\')::interval'
            % (len(args) + 1), *args, str(days)) or 0)
    else:
        out["recent_failed"] = out["failed"]

    if not samples:
        return out

    picks = []
    # The handle a remediation verb needs. Without it the census is
    # read-only by accident rather than by design: she could describe a failed
    # job perfectly and have no way to name it to retry_ingest_job.
    if "id" in store.cols:
        picks.append('"id"::text AS row_id')
    if store.label_col:
        picks.append(f'"{store.label_col}"::text AS label')
    if store.error_col:
        picks.append(f'left("{store.error_col}"::text, {_ERROR_MAX}) AS detail')
    if store.time_col:
        picks.append(f'"{store.time_col}"::text AS at')
    picks += [f'"{c}"::text AS "d_{c}"' for c in store.detail_cols]
    order = (f'ORDER BY "{store.time_col}" DESC NULLS LAST'
             if store.time_col else "")
    rows = await conn.fetch(
        f'SELECT {", ".join(picks)} FROM "{store.table}" '
        f'WHERE {where} {order} LIMIT {int(samples)}', *args)

    for r in rows:
        d = dict(r)
        item = {}
        if d.get("row_id"):
            item["id"] = d["row_id"]
        if d.get("label"):
            item["what"] = redact.scrub_text(d["label"])[:160]
        if d.get("detail"):
            item["error"] = redact.scrub_text(d["detail"])
        if d.get("at"):
            item["at"] = d["at"][:19]
        extra = {k[2:]: v for k, v in d.items()
                 if k.startswith("d_") and v not in (None, "")}
        if extra:
            item["detail"] = extra
        out["recent"].append(item)
    # Say that these are a SAMPLE, in the payload rather than in a docstring
    # nobody reads. Measured on the first live turn: given 12 failed
    # automation runs and 3 examples, she reported all twelve as having the
    # one cause the newest example showed. Three of those twelve were a
    # timeout and a DNS failure. The count and the sample size have to arrive
    # as separate, labelled facts or the sample gets read as the population.
    if out["failed"] > len(out["recent"]):
        out["showing"] = (f"{len(out['recent'])} of {out['failed']} — these "
                          f"are the most recent examples, NOT all of them, "
                          f"and the others may have failed for other reasons")
    return out


async def census(*, samples: int = _SAMPLES, days: int = _RECENT_DAYS) -> dict:
    """Every failed row in the database, by store.

    Returns {scanned, sources, total, recent_total, days, unreadable,
    unclassified}. `sources` holds only stores with at least one failure — a
    store with none is proven clean by its presence in `scanned`, and listing
    ten zeroes buries the numbers that matter.
    """
    out: dict = {"scanned": [], "sources": {}, "total": 0, "recent_total": 0,
                 "days": days, "unreadable": [], "unclassified": []}
    try:
        async with db.acquire() as conn:
            schema = await _schema(conn)
            stores = {t: _Store(t, c) for t, c in schema.items()}
            excused = {t: r for t, s in stores.items()
                       if (r := _decline_reason(t, s))}
            out["declined"] = excused
            for table in sorted(stores):
                store = stores[table]
                if table in excused or not store.qualifies:
                    continue
                out["scanned"].append(table)
                try:
                    res = await _scan_one(conn, store, samples, days)
                except Exception as e:  # noqa: BLE001 — never a silent zero
                    log.debug("failure scan failed for %s", table, exc_info=True)
                    out["unreadable"].append(
                        {"store": table, "why": str(e)[:160]})
                    continue
                if res["failed"]:
                    out["sources"][table] = res
                    out["total"] += res["failed"]
                    out["recent_total"] += res.get("recent_failed", 0)
            # Phase 2: what is failure-shaped, censused by nobody, and
            # declined by nobody. Computed from the SAME live schema.
            out["unclassified"] = sorted(
                t for t, c in schema.items()
                if t not in excused
                and t not in out["scanned"]
                and _shaped(t, c))
    except Exception as e:  # noqa: BLE001
        # The whole census failing is itself a fact, and it must not read as
        # health: `unreadable` is what _errors_note branches on first.
        log.debug("census failed", exc_info=True)
        out["unreadable"].append({"store": "*", "why": str(e)[:160]})
    return out


# A DELIBERATELY WIDER net than `_Store.qualifies`: anything whose column
# names hint at failure at all. Its only job is to notice a store the census
# does not understand, so the answer can refuse instead of reading clean.
_SHAPE_RE = re.compile(r"(^|_)(status|state)$|error|fail|alert|"
                       r"^(raised|cleared|resolved)_at$")


def _shaped(table: str, cols: set[str]) -> bool:
    return any(_SHAPE_RE.search(c) for c in cols)


def note(census_: dict, ledger_errors: Optional[int] = None,
         ledger_hours: int = 72) -> str:
    """The sentence diagnose hands the model about failure — computed.

    This is the control. The reassuring branch is LAST, and every earlier
    branch is a fact about live rows, so "nothing is failing" is structurally
    unreachable while anything is failing or anything failed to be read. The
    wording is assembled from the census rather than authored, so there is no
    phrasing left for a model to prefer over the numbers.
    """
    parts = []
    if census_.get("total"):
        days = census_.get("days", _RECENT_DAYS)
        parts.append(
            "Background work in a failed state: "
            + ", ".join(
                f"{t} {v['failed']}"
                + (f" ({v['recent_failed']} in the last {days} days)"
                   if v.get("recent_failed", v["failed"]) != v["failed"] else "")
                for t, v in sorted(census_["sources"].items()))
            + f" — {census_['total']} rows in total, "
              f"{census_['recent_total']} of them in the last {days} days. "
              "These are durable queue, alert and run-history rows, NOT "
              "turn-ledger errors: they persist until retried or cleared, so "
              "an old count can mean a problem already over. Check the "
              "timestamps before telling the operator something is broken "
              "now.")
    if ledger_errors:
        parts.append(f"{ledger_errors} error(s) also recorded in the turn "
                     f"ledger in the last {ledger_hours}h.")

    # Incompleteness PREFIXES the counts, never replaces them. An earlier
    # draft returned early here, which meant one unreadable store deleted
    # every failure number from the only sentence a model reliably quotes —
    # solving "confidently clean" by inventing "confidently blank".
    blind = census_.get("unclassified") or []
    unread = census_.get("unreadable") or []
    if blind or unread:
        bits = []
        if blind:
            bits.append("could not classify " + ", ".join(blind))
        if unread:
            bits.append("could not read "
                        + ", ".join(u["store"] for u in unread))
        return ("INCOMPLETE — this report does not cover everything: "
                + "; ".join(bits)
                + ". Do not tell the operator the system is healthy on the "
                  "strength of it; say which part you could not check."
                + (" What could be read: " + " ".join(parts) if parts else ""))

    if parts:
        return " ".join(parts)

    return (f"No open failures in any of the {len(census_.get('scanned', []))} "
            f"failure stores"
            + (f", and no errors in the turn ledger in the last {ledger_hours}h"
               if ledger_errors is not None else "")
            + ". That means none were RECORDED — a feature can be "
              "misconfigured and fail silently without ever raising, which "
              "is how the push-notification outage went unnoticed.")


# ── the unprompted nudge ────────────────────────────────────────────────────
#
# A reader she never opens is not a control. This is the cheapest way the
# FACT is in front of her without her choosing to look. It is explicitly a
# nudge and not a control: the controls are the census predicate and `note`.

_LINE_CACHE: tuple[float, str] = (0.0, "")
_LINE_TTL_S = 60


async def prompt_line(days: int = 7) -> str:
    """One line of counts for the FACTS block, or "" when nothing is failing.

    Counts only — no third-party error text goes into a system prompt.

    Bounded to a window on purpose: ingest_jobs.purge_old sweeps only
    done/skipped, so a failed row lives forever. Unbounded, the operator's two
    permanently-members-only videos would sit in every system prompt for the
    life of the install, which is how a warning becomes wallpaper.
    """
    global _LINE_CACHE
    now = time.monotonic()
    if _LINE_CACHE[0] and now - _LINE_CACHE[0] < _LINE_TTL_S:
        return _LINE_CACHE[1]

    line = ""
    try:
        c = await census(samples=0, days=days)
        bits = ", ".join(
            f"{t} {v['recent_failed']}"
            for t, v in sorted(c.get("sources", {}).items())
            if v.get("recent_failed"))
        # Incompleteness is reported ALONGSIDE the counts, never instead of
        # them: a run that found failures AND could not read a store is the
        # case where "here are the failures" reads most like a full answer.
        incomplete = bool(c.get("unclassified") or c.get("unreadable"))
        if bits:
            line = (f"Background work failing right now (last {days} days): "
                    f"{bits}. Call diagnose for the detail before answering "
                    f"any question about whether things are working.")
            if incomplete:
                line += (" This list is INCOMPLETE — some failure stores could "
                         "not be classified or read, so it may not be all of "
                         "them.")
        elif incomplete:
            line = ("Your failure census is INCOMPLETE — some stores could "
                    "not be classified or read. Call diagnose before "
                    "claiming anything is healthy.")
    except Exception:  # noqa: BLE001 — a prompt block never breaks a turn
        log.debug("failure prompt line unavailable", exc_info=True)
    _LINE_CACHE = (now, line)
    return line


def fingerprint(census_: dict) -> str:
    """A stable key for "this exact set of failures", for card dedupe."""
    body = ";".join(f"{t}={v['failed']}"
                    for t, v in sorted(census_.get("sources", {}).items()))
    return hashlib.sha256(body.encode()).hexdigest()[:16]


# ── the proactive card (opt-in) ─────────────────────────────────────────────

_WATCH_GATE_S = 6 * 3600
_last_watch = 0.0
DEDUPE_PREFIX = "failure:"


async def maybe_raise() -> int:
    """One inbox card per distinct set of failures. Leader-gated by the caller.

    Off unless `failures.watch_enabled`, because putting cards in front of the
    operator is his call — migration 064 seeded a card-raising automation
    disabled on exactly that reasoning, and the FACTS nudge already gets the
    fact in front of NOVA whether or not this is on.

    ANTI-NAG, mechanically. The dedupe key is a hash of {store: count}, so the
    card can only reappear when the set of failures genuinely changes. And the
    check is EXISTENCE IN ANY STATUS, not `recommendations.create`'s upsert:
    that upsert flips a 'seen' row back to 'new' and re-pushes, which over a
    6-hourly tick is a notification every six hours for two videos that will
    never succeed. Dismissing a card has to mean something.

    Returns the number of cards raised (0 or 1).
    """
    global _last_watch
    from app import db as _db, recommendations, settings_store

    now = time.monotonic()
    if _last_watch and now - _last_watch < _WATCH_GATE_S:
        return 0
    if not settings_store.get("failures.watch_enabled"):
        return 0
    _last_watch = now

    c = await census(samples=1)
    if not c["total"] and not c["unclassified"] and not c["unreadable"]:
        return 0

    key = DEDUPE_PREFIX + fingerprint(c)
    async with _db.acquire() as conn:
        seen = await conn.fetchval(
            "SELECT 1 FROM recommendations WHERE dedupe_key = $1", key)
    if seen:
        return 0

    lines = [f"- {t}: {v['failed']} failed"
             + (f", {v['recent_failed']} in the last {c['days']} days"
                if v.get("recent_failed") != v["failed"] else "")
             for t, v in sorted(c["sources"].items())]
    if c["unclassified"]:
        lines.append("- could not classify: " + ", ".join(c["unclassified"]))
    if c["unreadable"]:
        lines.append("- could not read: "
                     + ", ".join(u["store"] for u in c["unreadable"]))
    body = ("Background work has failed and nothing has been done about it:\n"
            + "\n".join(lines)
            + "\n\nAsk Nova about it — she can read these now, and will tell "
              "you what each error actually says.")
    try:
        await recommendations.create(
            "maintenance", f"{c['total']} background failures need a look",
            body, source="failure-watch", dedupe_key=key, priority=1)
    except ValueError:  # the rate-limit guard in recommendations.create
        log.info("failure card suppressed by the recommendation rate limit")
        return 0
    return 1
