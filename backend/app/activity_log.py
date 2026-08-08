"""ONE chronological log of what she actually did — and what she was refused.

Jeremy, 2026-08-07, verbatim:

    "I also need a logging way to actually see what she's doing. Activity page
     doesn't help me at all and the observability page doesn't help me on what's
     she's doing either. She cannot be silent on her actions. We lack logging."

WHY THE TWO EXISTING SURFACES DO NOT ANSWER IT
----------------------------------------------
`ActivityPage` (frontend/src/components/IngestionPanel.tsx) is the media
INGEST QUEUE and nothing else. Its own docstring says so — "Nova's background
learning queue". Every row is a URL being turned into a topic. Not one tool
call, refusal, model change, coding session or automation run has ever
appeared on it. It is correctly built and answers a question nobody asked.

The Observability board is an INFRASTRUCTURE dashboard: CPU/RAM/VRAM meters,
container health, a fleet table, and 24h turn/cost rollups. Its one nod at
behaviour is `RecentTurns`, a collapsed list of TRACES — `eval · glm-5.2 ·
12.4s · 3 tools`. That answers "how long did turns take and what did they
cost", never "what did she do". Three things make it unusable as a log:

  * it is turn-shaped, not action-shaped. A turn that refused three writes and
    a turn that answered "hi" render identically apart from a duration.
  * eval outnumbers real work four to one (1984 eval traces against 478 chat
    here), and its own comment admits most of a page is eval.
  * a refusal is invisible. `turn_traces.status` is 'ok' for a turn whose every
    tool call was refused — the refusal lives one level down, in a span's
    `detail.error`, behind a click into the Turn Inspector, which shows ONE
    turn at a time. There has never been a view that puts refusals in a row.

That last one is the whole defect. MEASURED on this install: `pull_model`
refused once and `manage_curated_models` refused twice on 2026-08-07 by the
goal gate, `manage_automations` twice on 2026-08-06, `request_operator_
confirmation` twice for a missing grant — and each time her reply described
the work as attempted or done. Nothing in the product surfaced the refusal.

WHAT THIS IS
------------
A read model. It OWNS NO TABLE and has no write path — every row is derived
from records something else already writes, because a parallel audit log is a
log that drifts from the system it claims to describe, and the drift is
invisible precisely when it matters. The sources:

  turn_spans (kind='tool')  real tool calls: args, result, refusal reason
  capability_events         config/model/agent/skill changes, with the actor
  coding_sessions           delegated coding, including the new `stalled`
  automation_runs           unattended scheduled work
  action_runs               approved recommendations being executed
  consents                  the operator's own destructive-action decisions
  ingest_jobs               background media ingestion

REFUSALS ARE FIRST-CLASS, and since 2026-08-08 the gate is a RECORDED FACT:
the refusing branch itself stamps its gate id (`registry._refuse` →
`_run_tool` writes `detail.refused_by`), and the classifier prefers that
record outright. The text matching below remains only as the fallback for
spans written before the record existed — those rows carry nothing but the
sentence, so reading it is the only honest option left for them.

The fallback is built so that going stale cannot manufacture a false "fine":

  * an errored span is `failed` by default, never `ok`. Recognising a refusal
    only ever REFINES a row that is already visible as a problem, so a reworded
    gate downgrades "refused" to "failed" — both of which sit inside the
    "refusals and failures" filter. It can never hide an action.
  * `tests/test_activity_log.py` drives the REAL gates through
    `registry.execute_tool` and asserts each returned string classifies as
    refused. Reword a refusal without teaching this module and that suite goes
    red — the tripwire, not a comment asking someone to remember.
  * the gate vocabulary here is `registry.gate_refusing`'s own words
    (grant/containment/goal/rule/consent/protection), so there is one name for
    each gate across the codebase rather than a second private taxonomy.

PLAIN LANGUAGE IS DERIVED. A row says "download a model onto this machine",
not `pull_model{...}`. The wording comes from `scopes.consequences()` — the
same sentences the approval card is built from, so the log and the card can
never describe the same verb differently — and falls back to the tool's own
registered description. There is no hand-kept name→phrase map to rot.

THE NUMBERS ARE THE WINDOW'S, NOT THE PAGE'S. `counts` and `matched` come
from their own aggregate queries per source — no LIMIT, no page — and the
outcome of each group is derived by the SAME function that labels the rows.
They were a tally of the page once, and the page is per-source capped, so the
footer said "4 refused, 27 failed" for a week that had 15 and 67, the rail
badge drank from the same field, and the number moved when the page size did.
Everything past `limit` is reachable through `offset`, and `complete` is False
the moment this page is not the whole of what matched. A surface that exists
to remove reassuring untruths may not round its own arithmetic down.

NOR MAY IT CLAIM A WINDOW ITS SOURCES NO LONGER HOLD. Each source's history
is pruned by its own retention (automation runs at `automations.
RUNS_KEPT_DAYS`, tool spans at `trace.retention_days`, consents at
`retention.audit_days`), so a window wider than a source's retention asks
about rows that may already be gone — and this page used to answer it with
`complete: true`. The horizons are read from the modules and settings that
enforce them, never typed here, and every response now carries a per-source
`history_begins` (the oldest SURVIVING row) so "the log starts here" is a
stated fact rather than an inference from absence.

TENSE. The phrases are infinitive because `scopes` writes them that way for
approval cards, and mechanical conjugation ("tear down" -> "tore down") is a
table of irregular verbs nobody will maintain. The outcome chip carries the
tense instead: `DONE · download a model onto this machine`, `REFUSED ·
download a model onto this machine`. Deliberate: a wrong tense on a refusal
would read as something that happened.

FOLLOW-UP (needs files outside this lane): `runner._run_tool` should record
`tsp["refused_by"] = await registry.gate_refusing(...)` — or `execute_tool`
should return the gate id alongside its string. That turns the classification
below into a recorded fact and lets this module delete its text matching.
Until then, the suite is what keeps it true.
"""

from __future__ import annotations

import json
import logging
import re
from typing import Any, Iterable, NamedTuple, Optional

from app import db, redact
from app.tools import scopes

log = logging.getLogger(__name__)

#: Time windows the surface offers. Hours.
WINDOWS: dict[str, int] = {"1h": 1, "6h": 6, "24h": 24, "7d": 168, "30d": 720}
DEFAULT_WINDOW = "24h"

#: Hard ceiling on rows returned in one page, whatever the caller asks for.
#: A busy install has ~4000 tool spans alone; an uncapped page is a browser
#: tab that stops responding, which is a log nobody reads.
MAX_LIMIT = 300
DEFAULT_LIMIT = 120

#: When a filter narrows AFTER the database (refused-vs-failed is a text
#: classification, so SQL cannot express it), over-fetch by this factor and
#: report honestly if even the over-fetch hit its ceiling. Silently returning
#: "3 refusals" from a page that only looked at the newest 120 rows is the
#: reassuring-untruth this file exists to remove.
_NARROW_FETCH_FACTOR = 8

#: How deep `offset` may go. Paging across MERGED sources means every source
#: must be read down to `offset + limit` for the merge order to be right, so
#: depth costs rows fetched. Past this the honest answer is "narrow the
#: window", said as a 422 — not a page that is quietly in the wrong order.
MAX_SPAN = MAX_LIMIT * _NARROW_FETCH_FACTOR

#: Outcomes. `ok` is the only one that means the thing happened as asked.
OK = "ok"
REFUSED = "refused"
FAILED = "failed"
RUNNING = "running"
STALLED = "stalled"
WAITING = "waiting"
SKIPPED = "skipped"

#: What "show me only the problems" means. Named once, used by the API filter
#: and by the UI's default view.
PROBLEM_OUTCOMES = frozenset({REFUSED, FAILED, STALLED})


# ── refusal classification ───────────────────────────────────────────────
#
# One entry per GATE, keyed by the gate id `registry.gate_refusing` already
# uses. `marker` is the stable, load-bearing clause of the sentence that gate
# returns — chosen to be the part that states the mechanism, not the part
# that varies with the tool name or the advice that follows.
#
# `reason` is what the operator reads. Short, and it says what would change
# the answer, because "refused" with no next step is a dead end he has to go
# and research.
_GATES: tuple[tuple[str, str, str], ...] = (
    ("goal", "runs only under a goal the operator has approved",
     "Needs an approved goal — none active covers this verb."),
    ("containment", "this turn is holding text from an outside source",
     "Containment fence — the turn had read outside text (a page, a "
     "transcript), so verbs that change the system were disarmed."),
    ("grant", "is not granted to this agent",
     "Not granted — this agent does not hold that tool."),
    ("grant", "is not loaded this turn",
     "Granted but not loaded — the MCP server's tools are lazy; "
     "find_mcp_tools loads them mid-turn."),
    ("rule", "blocked by rule",
     "Blocked by an operator rule."),
    ("consent", "requires operator consent",
     "Needs your explicit consent — destructive, and consent is burned once."),
    ("protection", "is a system protection",
     "System protection — no agent may change it, with or without consent."),
    ("eval", "never_execute",
     "Held back inside a graded eval run — the call is scored, not executed."),
)


def classify_tool_error(error: str,
                        refused_by: Optional[str] = None) -> tuple[str, Optional[str]]:
    """An errored tool span -> (outcome, plain reason).

    `refused_by` is the gate id the refusing branch itself recorded
    (`detail.refused_by`, written by `_run_tool` since 2026-08-08). When it
    is present it WINS: the span was refused by that gate whatever the
    sentence now says, so a reworded gate can no longer downgrade its own
    refusals to `failed`. The wording is still taken from the matching
    `_GATES` entry when one matches, so the operator-facing reason does not
    change shape between old rows and new.

    Without the record — every span older than it — this DEFAULTS TO
    `failed`, never to `ok`. An unrecognised error is a real problem shown
    with its real text; the only thing lost when this module falls behind a
    reworded gate is the finer refused/failed label, and both sit inside the
    same "problems" filter. That asymmetry is on purpose — see the module
    docstring.
    """
    hay = (error or "").lower()
    if refused_by:
        reason = next((r for g, marker, r in _GATES
                       if g == refused_by and marker in hay),
                      None)
        if reason is None:
            reason = next((r for g, _m, r in _GATES if g == refused_by),
                          f"Refused by the {refused_by} gate.")
        if refused_by == "goal":
            reason += _card_status(hay)
        return REFUSED, reason
    for gate, marker, reason in _GATES:
        if marker in hay:
            if gate == "goal":
                reason += _card_status(hay)
            return REFUSED, reason
    return FAILED, None


#: What the goal gate SAYS it did about the approval card, read back out of
#: its own recorded sentence.
#:
#: This used to be a flat "An approval card was raised for you" bolted onto
#: every goal refusal — a claim about Jeremy's inbox that this module had not
#: checked, and which is false in three real cases: the card already existed
#: and was deliberately not duplicated, the card could not be raised at all,
#: and a graded run raises none by design. `goals.card_for_refusal` had this
#: exact bug once already (registry.py: "for two days it was false ... so she
#: kept telling him something was waiting that was not"). The gate now states
#: which of those happened; this reads that rather than assuming the happy one.
_CARD_CLAUSES: tuple[tuple[str, str], ...] = (
    ("now in front of the operator", " An approval card is waiting for you."),
    ("was already raised", " A card for this was already waiting — undecided."),
    ("could not be raised", " NO approval card exists: raising it failed, so "
                            "nobody has been asked."),
    ("not a real request", " No card raised — this was a graded run."),
)


def _card_status(hay: str) -> str:
    for marker, clause in _CARD_CLAUSES:
        if marker in hay:
            return clause
    return ""


def _tool_outcome(status: Optional[str], error: str,
                  refused_by: Optional[str] = None) -> tuple[str, Optional[str]]:
    """A tool span's (status, recorded error, recorded gate) -> (outcome,
    plain reason).

    ONE derivation, used by the row builder AND by the count query below. They
    were the same three lines written twice until the counts were computed off
    the capped page; two copies of "what does this span mean" is how a footer
    comes to disagree with the rows above it.
    """
    if status == "ok":
        return OK, None
    if status == "cancelled":
        return FAILED, "The turn was cancelled before this finished."
    return classify_tool_error(error, refused_by)


def gate_of(error: str, refused_by: Optional[str] = None) -> Optional[str]:
    """Which gate refused this, in `registry.gate_refusing`'s vocabulary.

    The recorded gate id wins when the span carries one — it was written by
    the refusing branch itself. The text matching is the fallback for spans
    from before the record existed.

    Exposed for the suite: it is what lets a test assert "the goal gate's real
    sentence is recognised AS the goal gate" rather than merely "something
    matched".
    """
    if refused_by:
        return refused_by
    hay = (error or "").lower()
    for gate, marker, _reason in _GATES:
        if marker in hay:
            return gate
    return None


# ── plain language ───────────────────────────────────────────────────────

_TOOL_PHRASES: dict[str, str] = {}
_PHRASES_LOADED = False


async def _tool_phrases() -> dict[str, str]:
    """tool name -> plain-language phrase, DERIVED and cached per process.

    Two sources, in priority order:

      1. `scopes.consequences([verb])` — the operator-facing sentence the
         approval CARD is built from. Highest priority precisely because the
         card and the log describing one verb differently is the confusion
         this is meant to prevent.
      2. the tool's own registered description (builtin, DB-defined or MCP),
         first sentence, lower-cased to sit inside "DONE · ...".

    A tool absent from both keeps its raw name — visibly a name, so the gap is
    legible rather than papered over with a guess.
    """
    global _PHRASES_LOADED
    if _PHRASES_LOADED:
        return _TOOL_PHRASES
    out: dict[str, str] = {}
    try:
        from app.tools import registry as tool_registry
        for spec in tool_registry.BUILTIN_TOOLS.values():
            if isinstance(spec, dict) and spec.get("name"):
                out[spec["name"]] = _first_sentence(spec.get("description") or "")
        async with db.acquire() as conn:
            for r in await conn.fetch(
                    "SELECT name, description FROM tools"):
                out[r["name"]] = _first_sentence(r["description"] or "")
            for r in await conn.fetch(
                    "SELECT s.name AS server, c.name AS tool, c.description "
                    "FROM mcp_tools_cache c JOIN mcp_servers s "
                    "ON s.id = c.server_id"):
                out[f"mcp:{r['server']}/{r['tool']}"] = _first_sentence(
                    r["description"] or "")
    except Exception:                                        # noqa: BLE001
        # A phrase book that cannot be built must not take the log down with
        # it — the row still renders under its raw tool name, which is worse
        # reading and entirely honest.
        log.exception("activity log: tool phrase book could not be built")
    # The card's own words win over a description.
    for verb in scopes.GOAL_SCOPED_TOOLS:
        said = scopes.consequences([verb])
        if said:
            out[verb] = said[0]
    _TOOL_PHRASES.clear()
    _TOOL_PHRASES.update(out)
    _PHRASES_LOADED = True
    return _TOOL_PHRASES


def reset_phrase_cache() -> None:
    """Drop the cached phrase book — for tests, and for a tool registry that
    changed under a long-lived process."""
    global _PHRASES_LOADED
    _PHRASES_LOADED = False
    _TOOL_PHRASES.clear()


def _first_sentence(text: str, limit: int = 120) -> str:
    """The first sentence of a description, without its trailing period."""
    t = " ".join((text or "").split())
    if not t:
        return ""
    cut = re.split(r"(?<=[.;])\s", t, maxsplit=1)[0]
    cut = cut.rstrip(".;")
    # An ellipsis when it was cut, because a hard slice mid-word ("...and
    # EVERYTHIN") reads as a sentence that ended rather than one that was
    # trimmed, and the operator cannot tell which he is looking at.
    return cut if len(cut) <= limit else cut[:limit].rstrip() + "…"


def _humanise(name: str) -> str:
    """`manage_curated_models` -> `manage curated models`. The last resort."""
    return (name or "").replace("mcp:", "").replace("_", " ").replace("/", " · ")


# ── argument rendering ───────────────────────────────────────────────────

#: Argument values longer than this are a payload, not an identifier — the
#: log names the key and says how big it was rather than pasting a diff into
#: a table row.
_ARG_VALUE_CHARS = 70
_ARG_KEYS = 4


def _args_summary(raw: Any) -> str:
    """The arguments that MATTER, from an already-redacted args blob.

    `trace.redact_args` scrubbed this before storage; nothing here re-reads
    secrets. What this does is choose: top-level scalars, in the order the
    model wrote them, capped in count and in length. No per-tool key list —
    one would need an entry the day a tool grows an argument.
    """
    obj = raw
    if isinstance(obj, str):
        try:
            obj = json.loads(obj)
        except (ValueError, TypeError):
            return redact.scrub_text(obj, 160)
    if not isinstance(obj, dict):
        return ""
    parts: list[str] = []
    for key, value in obj.items():
        if len(parts) >= _ARG_KEYS:
            parts.append("…")
            break
        if isinstance(value, (dict, list)):
            parts.append(f"{key}={len(value)} item(s)")
            continue
        text = str(value)
        if len(text) > _ARG_VALUE_CHARS:
            text = text[:_ARG_VALUE_CHARS] + f"… ({len(text)} chars)"
        parts.append(f"{key}={text}")
    return "  ".join(parts)


# ── row shape ────────────────────────────────────────────────────────────

def _row(*, id: str, at, kind: str, actor: Optional[str], title: str,
         outcome: str, detail: str = "", reason: Optional[str] = None,
         reason_full: Optional[str] = None, trace_id: Optional[str] = None,
         graded: bool = False, extra: Optional[dict] = None) -> dict:
    return {
        "id": id,
        "at": at,
        "kind": kind,
        "actor": actor or "system",
        "title": title,
        "outcome": outcome,
        "detail": detail,
        "reason": reason,
        "reason_full": reason_full,
        "trace_id": trace_id,
        "graded": graded,
        **(extra or {}),
    }


def _tag(rows: list[dict], source: str) -> list[dict]:
    """Stamp which SOURCES entry produced each row.

    Used only by the completeness arithmetic in `fetch`, which has to ask "did
    the source that hit its ceiling still have rows newer than the cut?". Doing
    that by guessing from `kind` was wrong for `config` (kind `config`, source
    `config`, id prefix `cap:`) — three names for one thing is how a check
    comes to silently pass.
    """
    for r in rows:
        r["_src"] = source
    return rows


def _short(text: Optional[str], limit: int = 240) -> str:
    """Scrub and truncate free text that is going onto the page.

    Everything here has been through a scrubber once already, EXCEPT the
    columns written by code that never expected to be rendered — and one of
    those, `coding_sessions.error`, currently holds a live OpenRouter key
    management URL on this install. Scrubbed again on the way out, because a
    log Jeremy leaves open on a second monitor is a display surface.
    """
    if not text:
        return ""
    return redact.scrub_text(" ".join(str(text).split()), limit)


# ── the sources ──────────────────────────────────────────────────────────
#
# Each returns rows ALREADY normalised and already limited, newest first.
# `since`, `agent` AND `problems_only` are pushed into SQL in every one of
# them. Filtering after the fetch is not a style preference here — it silently
# breaks the page's honesty:
#
#   with a Python-side filter, `ingest` could return its whole 150-row cap as
#   successes, contribute zero rows to a "problems" page, and be indistinguish-
#   able from a source that genuinely had nothing wrong. Older failures inside
#   the window would simply not exist, and `complete` would say True.
#
# So each source below knows how to say "not ok" in its own vocabulary, and a
# capped source on a problems page really did fill its cap WITH PROBLEMS.


async def _tool_rows(since, limit: int, agent: Optional[str],
                     problems_only: bool, include_graded: bool) -> list[dict]:
    where = ["s.kind = 'tool'", "s.started_at >= $1"]
    params: list[Any] = [since]

    def p(value) -> str:
        params.append(value)
        return f"${len(params)}"

    if agent:
        where.append(f"s.detail->>'agent' = {p(agent)}")
    if problems_only:
        where.append("s.status <> 'ok'")
    if not include_graded:
        where.append("t.source <> 'eval'")
    sql = (
        "SELECT s.id, s.started_at, s.name, s.status, s.detail, s.trace_id, "
        "       t.source, t.automation "
        "  FROM turn_spans s JOIN turn_traces t ON t.id = s.trace_id "
        f" WHERE {' AND '.join(where)} "
        f" ORDER BY s.started_at DESC LIMIT {p(limit)}")
    async with db.acquire() as conn:
        rows = await conn.fetch(sql, *params)

    phrases = await _tool_phrases()
    from app.tools import registry as tool_registry
    out: list[dict] = []
    for r in rows:
        detail = r["detail"]
        if isinstance(detail, str):
            try:
                detail = json.loads(detail)
            except ValueError:
                detail = {}
        detail = detail or {}
        # Spans are recorded under whichever form the model used — MCP calls
        # arrive in the provider-safe WIRE name (`mcp__server__tool`). Canonical
        # here so the phrase book, which is keyed canonically, can find them.
        name = tool_registry.canonical_name(r["name"])
        error = detail.get("error") or ""
        refused_by = detail.get("refused_by") or None
        outcome, reason = _tool_outcome(r["status"], error, refused_by)
        phrase = phrases.get(name) or _humanise(name)
        out.append(_row(
            id=f"tool:{r['id']}",
            at=r["started_at"],
            kind="tool",
            actor=detail.get("agent"),
            title=phrase,
            outcome=outcome,
            detail=_args_summary(detail.get("args")),
            reason=reason or (_short(error, 200) if error else None),
            reason_full=_short(error, 1200) or None,
            trace_id=str(r["trace_id"]),
            graded=(r["source"] == "eval"),
            extra={"tool": name, "source": r["source"],
                   "automation": r["automation"],
                   "gate": (gate_of(error, refused_by)
                            if outcome == REFUSED else None),
                   # A refusal Nova then narrated as done is the exact failure
                   # Jeremy measured. Carrying the tainted flag lets the UI
                   # explain WHY an actor verb was disarmed without a second
                   # query.
                   "tainted_turn": bool(detail.get("tainted_turn")),
                   "repeat_failure": detail.get("repeat_failure")},
        ))
    return out


def _capability_outcome(said: Optional[str]) -> str:
    """capability_events is a record of things that HAPPENED, so its rows are
    `ok` — except where the recorded outcome says otherwise, which
    `recommendation` rows do carry (an executor writing "outcome: failed —
    ..." into the detail). Mirrors the `detail->>'outcome' ILIKE 'failed%'`
    predicate the problems filter pushes into SQL."""
    return FAILED if str(said or "").lower().startswith("failed") else OK


async def _capability_rows(since, limit: int, agent: Optional[str],
                           problems_only: bool = False) -> list[dict]:
    where = ["at >= $1"]
    params: list[Any] = [since]
    if agent:
        params.append(agent)
        where.append(f"actor = ${len(params)}")
    if problems_only:
        # Mirrors the `failed` derivation below, in SQL. A config change that
        # happened is never a problem; a recommendation whose executor wrote a
        # failing outcome into its detail is.
        where.append("detail->>'outcome' ILIKE 'failed%'")
    params.append(limit)
    async with db.acquire() as conn:
        rows = await conn.fetch(
            "SELECT id, at, kind, subject, action, actor, detail "
            f"  FROM capability_events WHERE {' AND '.join(where)} "
            f" ORDER BY at DESC LIMIT ${len(params)}", *params)
    out = []
    for r in rows:
        detail = r["detail"]
        if isinstance(detail, str):
            try:
                detail = json.loads(detail)
            except ValueError:
                detail = {}
        detail = detail or {}
        said = str(detail.get("outcome") or "")
        out.append(_row(
            id=f"cap:{r['id']}",
            at=r["at"],
            kind="config",
            actor=r["actor"],
            # Past tense for free: `action` is already written that way
            # ("created", "revoked", "acted on").
            title=f"{r['action']} the {r['kind']} “{_short(r['subject'], 80)}”",
            outcome=_capability_outcome(said),
            detail=_args_summary({k: v for k, v in detail.items()
                                  if k != "outcome"}),
            reason=_short(said, 220) if said else None,
            reason_full=_short(said, 1200) if said else None,
            extra={"subject": r["subject"], "change_kind": r["kind"],
                   "action": r["action"]},
        ))
    return out


#: coding_sessions.state -> our outcome vocabulary. DERIVED from `coder.TERMINAL`
#: for the terminal half so a new terminal state cannot silently read as "still
#: going" — the exact defect migration 121 was written about.
def _coding_outcome(state: Optional[str]) -> str:
    from app import coder
    s = (state or "").lower()
    if s == "done":
        return OK
    if s == "stalled":
        return STALLED
    if s in coder.TERMINAL:            # failed, killed, and anything added later
        return FAILED
    return RUNNING


#: When a coding session belongs to — its last sign of life. The window
#: filter, the ORDER BY and the counter all read this one string.
_CODING_AT = "COALESCE(progress_at, updated_at, created_at)"


def _coding_problem_states() -> list[str]:
    """Every coding state that is a problem, DERIVED from coder.TERMINAL.

    `stalled` is already in TERMINAL, so this is exactly "terminal and not
    done" — and a terminal state added tomorrow is a problem by default
    rather than invisible, the same fail-closed direction migration 121 chose.
    """
    from app import coder
    return [s for s in sorted(coder.TERMINAL) if s != "done"]


async def _coding_rows(since, limit: int, agent: Optional[str],
                       problems_only: bool = False) -> list[dict]:
    where = [f"{_CODING_AT} >= $1"]
    params: list[Any] = [since]
    if agent:
        params.append(agent)
        where.append(f"requested_by = ${len(params)}")
    if problems_only:
        params.append(_coding_problem_states())
        where.append(f"state = ANY(${len(params)}::text[])")
    params.append(limit)
    async with db.acquire() as conn:
        rows = await conn.fetch(
            "SELECT id, state, task, requested_by, branch, commit_sha, "
            "       diffstat, error, created_at, updated_at, progress_at, "
            "       COALESCE(jsonb_array_length(commands), 0) AS n_commands, "
            "       COALESCE(jsonb_array_length(denials), 0) AS n_denials, "
            "       EXTRACT(EPOCH FROM (now() - created_at)) AS age_s, "
            f"       EXTRACT(EPOCH FROM ({_CODING_AT} - created_at)) AS worked_s, "
            f"       {_CODING_AT} AS at "
            f"  FROM coding_sessions WHERE {' AND '.join(where)} "
            f" ORDER BY at DESC LIMIT ${len(params)}", *params)
    out = []
    for r in rows:
        outcome = _coding_outcome(r["state"])
        # PROGRESS, NOT A STATE WORD (requirement 3). A session that has been
        # up for eight minutes having run nothing is the single most misleading
        # row this log can carry — `running` alone reads as "working". The
        # count of commands is what the broker actually reports moving, and it
        # is what migration 121's fingerprint is built from, so this is the
        # same evidence the stall reconciler judges on.
        live = outcome in (RUNNING, STALLED)
        minutes = int(float(r["age_s"] or 0) // 60)
        progress = (f"{r['n_commands']} command(s) run, "
                    f"{r['n_denials']} denied")
        if live:
            since_progress = int((float(r["age_s"] or 0)
                                  - float(r["worked_s"] or 0)) // 60)
            progress += (f" · up {minutes}m"
                         + (f", nothing new for {since_progress}m"
                            if since_progress >= 1 else ""))
        elif r["diffstat"]:
            progress += f" · {_short(r['diffstat'], 60)}"
        out.append(_row(
            id=f"coding:{r['id']}",
            at=r["at"],
            kind="coding",
            actor=r["requested_by"],
            # The task text is a whole prompt (one on this install is 2.3 KB of
            # repo facts). The first line is the only part that identifies it.
            title=f"write code: {_short(_task_line(r['task']), 110)}",
            outcome=outcome,
            detail=progress,
            reason=_short(r["error"], 220) or (
                f"Running {minutes} minute(s) with no commands recorded yet."
                if live and not r["n_commands"] else None),
            reason_full=_short(r["error"], 1200) or None,
            extra={"session_id": str(r["id"]), "state": r["state"],
                   "branch": r["branch"], "commit": r["commit_sha"],
                   "commands": r["n_commands"], "denials": r["n_denials"]},
        ))
    return out


def _task_line(task: Optional[str]) -> str:
    """The identifying line of a coding task prompt.

    The build loop prepends a "## Facts about this repository" preamble, so
    the first line is boilerplate shared by every session. The line after the
    "## The task" header is the one that differs.
    """
    text = task or ""
    if "## The task" in text:
        text = text.split("## The task", 1)[1]
    for line in text.splitlines():
        line = line.strip().lstrip("#").strip()
        if line:
            return line
    return "(no description)"


#: Who a scheduled run is attributed to, as SQL. ONE definition, used by the
#: agent filter here and by the facet counts, or the name in the dropdown does
#: not match the rows the dropdown returns. Mirrors `_automation_rows`' Python.
_AUTOMATION_ACTOR = ("CASE WHEN a.handler IS NOT NULL THEN 'the scheduler' "
                     "ELSE COALESCE(a.agent_name, 'the scheduler') END")

#: The words automation_runs.status uses for "it worked". Named once: the row
#: builder, the problems predicate and the counter all read this, so a fourth
#: spelling is one edit rather than three places to keep in step.
_AUTOMATION_OK = ("ok", "success", "succeeded")


def _automation_outcome(status: Optional[str]) -> str:
    return OK if str(status).lower() in _AUTOMATION_OK else FAILED


async def _automation_rows(since, limit: int, agent: Optional[str],
                           problems_only: bool = False) -> list[dict]:
    where = ["r.started_at >= $1"]
    params: list[Any] = [since]
    if agent:
        params.append(agent)
        where.append(f"{_AUTOMATION_ACTOR} = ${len(params)}")
    if problems_only:
        ok_list = ", ".join(f"'{s}'" for s in _AUTOMATION_OK)
        where.append(f"lower(r.status) NOT IN ({ok_list})")
    params.append(limit)
    async with db.acquire() as conn:
        rows = await conn.fetch(
            "SELECT r.id, r.status, r.summary, r.started_at, "
            "       r.duration_seconds, a.name, a.agent_name, a.handler "
            "  FROM automation_runs r JOIN automations a "
            "    ON a.id = r.automation_id "
            f" WHERE {' AND '.join(where)} "
            f" ORDER BY r.started_at DESC LIMIT ${len(params)}", *params)
    out = []
    for r in rows:
        out.append(_row(
            id=f"automation:{r['id']}",
            at=r["started_at"],
            kind="automation",
            # A MECHANICAL automation (migration 112's `handler` column) runs
            # in code — "no agent receives this text", as 121's own seed says.
            # Those rows still carry an `agent_name`, so reading that column
            # blind attributed every `coding-session-reconcile` tick to `main`
            # and put 40-odd actions in her column that no model ever took.
            # Derived from `handler` being set, so a handler added tomorrow is
            # attributed correctly without touching this.
            actor="the scheduler" if r["handler"] else (r["agent_name"] or "the scheduler"),
            title=f"run the scheduled job “{r['name']}”",
            outcome=_automation_outcome(r["status"]),
            detail=(f"{float(r['duration_seconds'] or 0):.1f}s"
                    + (" · mechanical" if r["handler"] else "")),
            reason=_short(r["summary"], 260) or None,
            reason_full=_short(r["summary"], 1200) or None,
            extra={"automation": r["name"], "status": r["status"]},
        ))
    return out


#: action_runs.status -> our vocabulary. Shared by the row builder and the
#: counter; an unknown status reads as `running` (still in flight), never ok.
_ACTION_OUTCOMES = {"succeeded": OK, "failed": FAILED,
                    "running": RUNNING, "queued": WAITING}


def _action_actor(lane: Optional[str], goal_title: Optional[str]) -> str:
    """Who an action_runs row acted FOR, read off its lane.

    The table has carried `lane` ('operator' vs 'goal') since the goal lane
    shipped, and this module hardcoded 'operator (approved)' anyway — so her
    MOST autonomous work, runs executed under a standing goal with no click
    behind them, rendered as the operator's own approvals. The goal's title
    is the attribution because the goal IS the authority the run spent.
    `goal_id` is ON DELETE SET NULL, so a deleted goal still reads as a goal
    run rather than inventing an approval nobody made.
    """
    if lane == "goal":
        return (f"under goal: {goal_title}" if goal_title
                else "under a goal (since deleted)")
    return "operator (approved)"


async def _action_rows(since, limit: int, agent: Optional[str],
                       problems_only: bool = False) -> list[dict]:
    # action_runs carries no agent column — the actors here are the operator
    # and standing goals — so an agent filter excludes the source entirely
    # rather than pretending every run belongs to whoever was asked for.
    if agent:
        return []
    where = ["r.created_at >= $1"]
    if problems_only:
        where.append("r.status = 'failed'")
    async with db.acquire() as conn:
        rows = await conn.fetch(
            "SELECT r.id, r.action_type, r.status, r.error, r.attempts, "
            "       r.created_at, r.finished_at, r.lane, c.title, "
            "       g.title AS goal_title "
            "  FROM action_runs r LEFT JOIN recommendations c "
            "    ON c.id = r.recommendation_id "
            "  LEFT JOIN goals g ON g.id = r.goal_id "
            f" WHERE {' AND '.join(where)} "
            " ORDER BY r.created_at DESC LIMIT $2", since, limit)
    out = []
    for r in rows:
        status = str(r["status"])
        outcome = _ACTION_OUTCOMES.get(status, RUNNING)
        goal_lane = r["lane"] == "goal"
        out.append(_row(
            id=f"action:{r['id']}",
            at=r["created_at"],
            kind="action",
            actor=_action_actor(r["lane"], r["goal_title"]),
            title=(f"carry out the plan “{_short(r['title'], 90)}”"
                   if goal_lane else
                   f"carry out the approved plan “{_short(r['title'], 90)}”"),
            outcome=outcome,
            detail=f"{r['action_type']} · attempt {r['attempts']}",
            reason=_short(r["error"], 260) or None,
            reason_full=_short(r["error"], 1200) or None,
            extra={"action_type": r["action_type"], "status": status,
                   "lane": r["lane"]},
        ))
    return out


def _consent_outcome(status: Optional[str], chosen: Optional[str]) -> str:
    if status == "pending":
        return WAITING
    if chosen == "approve":
        return OK
    if chosen == "deny":
        return REFUSED
    return SKIPPED                     # expired without a decision


#: WHEN a consent belongs to. The DECISION where there is one, exactly as
#: migration 123's `consents_recent_idx` indexes it: "a consent raised on
#: Monday and approved on Wednesday lands on Wednesday, which is when the
#: operator did the thing."
#:
#: This is one string because it has to be the ORDER BY, the SELECT and the
#: WHERE. It was the first two only, and the window filtered on `created_at`
#: — so an approval made ten minutes ago on a consent raised yesterday was
#: absent from the 1h page, absent from the 6h page, and then rendered at its
#: decision time in the 24h page as though it had only just appeared. The
#: operator's own decisions are the rows he is most likely to be looking for.
_CONSENT_AT = "COALESCE(decided_at, created_at)"


async def _consent_rows(since, limit: int, agent: Optional[str],
                        problems_only: bool = False) -> list[dict]:
    where = [f"{_CONSENT_AT} >= $1"]
    params: list[Any] = [since]
    if agent:
        params.append(agent)
        where.append(f"requested_by = ${len(params)}")
    if problems_only:
        # A denied consent is a refusal. Pending and expired are neither a
        # problem nor a success — they are waiting, and the `waiting` filter
        # is where they belong.
        where.append("chosen = 'deny'")
    params.append(limit)
    async with db.acquire() as conn:
        rows = await conn.fetch(
            "SELECT id, kind, subject, question, requested_by, status, "
            "       chosen, created_at, decided_at, used_at, "
            f"       {_CONSENT_AT} AS at "
            f"  FROM consents WHERE {' AND '.join(where)} "
            f" ORDER BY at DESC LIMIT ${len(params)}", *params)
    out = []
    for r in rows:
        outcome = _consent_outcome(r["status"], r["chosen"])
        out.append(_row(
            id=f"consent:{r['id']}",
            at=r["at"],
            kind="consent",
            actor=r["requested_by"],
            title=f"ask you to approve {r['kind']} on “{_short(r['subject'], 70)}”",
            outcome=outcome,
            detail=_short(r["question"], 160),
            reason=("Waiting on your decision." if outcome == WAITING else
                    "You denied it." if outcome == REFUSED else
                    "Expired with no decision." if outcome == SKIPPED else None),
            extra={"consent_kind": r["kind"], "chosen": r["chosen"],
                   "used": bool(r["used_at"])},
        ))
    return out


#: ingest_jobs.status -> our vocabulary. Shared with the counter below.
_INGEST_OUTCOMES = {"done": OK, "failed": FAILED, "skipped": SKIPPED,
                    "running": RUNNING, "queued": WAITING}

#: When an ingest job belongs to — finished if it finished, else when it was
#: last touched. Used by the window filter, the ORDER BY and the counter.
_INGEST_AT = "COALESCE(finished_at, started_at, enqueued_at)"


async def _ingest_rows(since, limit: int, agent: Optional[str],
                       problems_only: bool = False) -> list[dict]:
    where = [f"{_INGEST_AT} >= $1"]
    params: list[Any] = [since]
    if agent:
        params.append(agent)
        where.append(f"enqueued_by = ${len(params)}")
    if problems_only:
        where.append("status = 'failed'")
    params.append(limit)
    async with db.acquire() as conn:
        rows = await conn.fetch(
            "SELECT id, url, title, status, error, attempts, enqueued_by, "
            "       result_item_id, "
            f"       {_INGEST_AT} AS at "
            f"  FROM ingest_jobs WHERE {' AND '.join(where)} "
            f" ORDER BY at DESC LIMIT ${len(params)}", *params)
    out = []
    for r in rows:
        outcome = _INGEST_OUTCOMES.get(str(r["status"]), RUNNING)
        out.append(_row(
            id=f"ingest:{r['id']}",
            at=r["at"],
            kind="ingest",
            actor=r["enqueued_by"] or "ingestion",
            title=f"read and store “{_short(r['title'] or r['url'], 90)}”",
            outcome=outcome,
            detail=(f"attempt {r['attempts']}" if r["attempts"] > 1 else ""),
            reason=_short(r["error"], 220) or None,
            reason_full=_short(r["error"], 1200) or None,
            extra={"url": r["url"], "item_id": r["result_item_id"]},
        ))
    return out


#: name -> fetcher. The API's `kinds` filter and the UI's source chips are both
#: DERIVED from these keys, so a source added here appears in the filter with
#: no second edit.
SOURCES = {
    "tool": _tool_rows,
    "config": _capability_rows,
    "coding": _coding_rows,
    "automation": _automation_rows,
    "action": _action_rows,
    "consent": _consent_rows,
    "ingest": _ingest_rows,
}


# ── how far back each source can testify ─────────────────────────────────
#
# Retention prunes several of these tables, so "no rows before T" has two
# readings — "nothing happened" and "the record was deleted" — and a window
# wider than a source's retention used to get the first reading with
# `complete: true` attached. Measured before automations moved to age-based
# retention: coding-session-reconcile runs every 5 minutes, the 50-row cap
# kept ~4.3 hours, and the 7d page claimed completeness over a week it could
# not see.

#: source -> min(<the source's own AT expression>), the oldest SURVIVING row.
#: Keyed identically to SOURCES and pinned so by the suite, the same contract
#: COUNTERS carries: a source that cannot say where its history begins is a
#: silent shortfall in a new disguise.
HISTORY_BEGINS_SQL = {
    "tool": "SELECT min(started_at) FROM turn_spans WHERE kind = 'tool'",
    "config": "SELECT min(at) FROM capability_events",
    "coding": f"SELECT min({_CODING_AT}) FROM coding_sessions",
    "automation": "SELECT min(started_at) FROM automation_runs",
    "action": "SELECT min(created_at) FROM action_runs",
    "consent": f"SELECT min({_CONSENT_AT}) FROM consents",
    "ingest": f"SELECT min({_INGEST_AT}) FROM ingest_jobs",
}


def retention_days() -> dict[str, float]:
    """How many days each source's own retention KEEPS, where one exists.

    READ from the module or setting that enforces the sweep, never typed
    here as a number — a copy of a horizon is a horizon that drifts. Sources
    absent from the result have no known pruning and their history is bounded
    only by the install's age.
    """
    from app import automations, settings_store
    out: dict[str, float] = {
        # automations.record_run's own age-based sweep
        "automation": float(automations.RUNS_KEPT_DAYS),
    }
    trace_days = settings_store.get("trace.retention_days")   # trace.maybe_prune
    if trace_days:
        out["tool"] = float(trace_days)
    audit_days = settings_store.get("retention.audit_days")   # retention._SWEEPS
    if audit_days:
        out["consent"] = float(audit_days)
    return out


def beyond_retention(window_hours: int, wanted: set[str]) -> set[str]:
    """The wanted sources whose retention is shorter than this window.

    Pure so the suite can hold it still. Strictly shorter: a 30-day window
    over a 30-day retention still sees every surviving row, so equality does
    not indict the page.
    """
    horizons = retention_days()
    return {name for name in wanted
            if name in horizons and window_hours > horizons[name] * 24}


async def _history_begins(wanted: set[str]) -> dict[str, Any]:
    """Oldest surviving row per wanted source; None where the table is empty.

    A source missing from HISTORY_BEGINS_SQL reports None too — visibly an
    unanswered question rather than a fabricated timestamp.
    """
    out: dict[str, Any] = {}
    async with db.acquire() as conn:
        for name in sorted(wanted):
            sql = HISTORY_BEGINS_SQL.get(name)
            if sql is None:
                log.error("activity log: source %s has no history query", name)
                out[name] = None
                continue
            out[name] = await conn.fetchval(sql)
    return out


# ── the counts ───────────────────────────────────────────────────────────
#
# WHY THESE EXIST AT ALL. `counts` used to be tallied over the ROWS on the
# page — rows each source had already truncated at its per-source ceiling. So
# the footer and the "problems N" chip reported the newest slice, not the
# window, and reported it while `complete` said True:
#
#     ?window=7d&limit=150            -> counts refused 4, failed 27
#     ?window=7d&outcome=problems     -> counts refused 15, failed 67
#
# Same module, same window, two different answers, and the number moved with
# the page size. That is precisely the reassuring untruth the docstring at the
# top says this file exists to remove, so the counts are now their own
# aggregate query per source: no LIMIT, no page, GROUP BY whatever decides the
# outcome, and the SAME python derivation the row builder uses applied to each
# group. A tally that disagrees with a row is a bug either way, and taking
# both from one function is what stops it being possible.
#
# Each counter mirrors its source's window/agent/graded predicates EXACTLY —
# and deliberately not the outcome filter, because `counts` is the breakdown
# of the whole window, which is what makes "problems 82" true while the page
# is showing everything.


async def _tool_counts(since, agent: Optional[str],
                       include_graded: bool) -> dict[str, int]:
    where = ["s.kind = 'tool'", "s.started_at >= $1"]
    params: list[Any] = [since]
    if agent:
        params.append(agent)
        where.append(f"s.detail->>'agent' = ${len(params)}")
    if not include_graded:
        where.append("t.source <> 'eval'")
    # `ok` spans collapse into ONE group; only the errored ones carry text,
    # and only they need it — refused-vs-failed is read out of the recorded
    # gate id where one exists, and out of that string for older rows.
    sql = ("SELECT s.status, "
           "       CASE WHEN s.status = 'ok' THEN NULL "
           "            ELSE s.detail->>'error' END AS error, "
           "       CASE WHEN s.status = 'ok' THEN NULL "
           "            ELSE s.detail->>'refused_by' END AS refused_by, "
           "       count(*)::int AS n "
           "  FROM turn_spans s JOIN turn_traces t ON t.id = s.trace_id "
           f" WHERE {' AND '.join(where)} GROUP BY 1, 2, 3")
    out: dict[str, int] = {}
    async with db.acquire() as conn:
        for r in await conn.fetch(sql, *params):
            outcome, _ = _tool_outcome(r["status"], r["error"] or "",
                                       r["refused_by"] or None)
            out[outcome] = out.get(outcome, 0) + r["n"]
    return out


async def _capability_counts(since, agent: Optional[str]) -> dict[str, int]:
    where = ["at >= $1"]
    params: list[Any] = [since]
    if agent:
        params.append(agent)
        where.append(f"actor = ${len(params)}")
    out: dict[str, int] = {}
    async with db.acquire() as conn:
        for r in await conn.fetch(
                "SELECT detail->>'outcome' AS said, count(*)::int AS n "
                f"  FROM capability_events WHERE {' AND '.join(where)} "
                " GROUP BY 1", *params):
            outcome = _capability_outcome(r["said"])
            out[outcome] = out.get(outcome, 0) + r["n"]
    return out


async def _coding_counts(since, agent: Optional[str]) -> dict[str, int]:
    where = [f"{_CODING_AT} >= $1"]
    params: list[Any] = [since]
    if agent:
        params.append(agent)
        where.append(f"requested_by = ${len(params)}")
    out: dict[str, int] = {}
    async with db.acquire() as conn:
        for r in await conn.fetch(
                "SELECT state, count(*)::int AS n FROM coding_sessions "
                f" WHERE {' AND '.join(where)} GROUP BY 1", *params):
            outcome = _coding_outcome(r["state"])
            out[outcome] = out.get(outcome, 0) + r["n"]
    return out


async def _automation_counts(since, agent: Optional[str]) -> dict[str, int]:
    where = ["r.started_at >= $1"]
    params: list[Any] = [since]
    if agent:
        params.append(agent)
        where.append(f"{_AUTOMATION_ACTOR} = ${len(params)}")
    out: dict[str, int] = {}
    async with db.acquire() as conn:
        for r in await conn.fetch(
                "SELECT r.status, count(*)::int AS n "
                "  FROM automation_runs r JOIN automations a "
                "    ON a.id = r.automation_id "
                f" WHERE {' AND '.join(where)} GROUP BY 1", *params):
            outcome = _automation_outcome(r["status"])
            out[outcome] = out.get(outcome, 0) + r["n"]
    return out


async def _action_counts(since, agent: Optional[str]) -> dict[str, int]:
    # No agent column, so an agent filter excludes the source entirely —
    # exactly as `_action_rows` does, or the footer would count rows the page
    # is not allowed to show.
    if agent:
        return {}
    out: dict[str, int] = {}
    async with db.acquire() as conn:
        for r in await conn.fetch(
                "SELECT status, count(*)::int AS n FROM action_runs "
                " WHERE created_at >= $1 GROUP BY 1", since):
            outcome = _ACTION_OUTCOMES.get(str(r["status"]), RUNNING)
            out[outcome] = out.get(outcome, 0) + r["n"]
    return out


async def _consent_counts(since, agent: Optional[str]) -> dict[str, int]:
    where = [f"{_CONSENT_AT} >= $1"]
    params: list[Any] = [since]
    if agent:
        params.append(agent)
        where.append(f"requested_by = ${len(params)}")
    out: dict[str, int] = {}
    async with db.acquire() as conn:
        for r in await conn.fetch(
                "SELECT status, chosen, count(*)::int AS n FROM consents "
                f" WHERE {' AND '.join(where)} GROUP BY 1, 2", *params):
            outcome = _consent_outcome(r["status"], r["chosen"])
            out[outcome] = out.get(outcome, 0) + r["n"]
    return out


async def _ingest_counts(since, agent: Optional[str]) -> dict[str, int]:
    where = [f"{_INGEST_AT} >= $1"]
    params: list[Any] = [since]
    if agent:
        params.append(agent)
        where.append(f"enqueued_by = ${len(params)}")
    out: dict[str, int] = {}
    async with db.acquire() as conn:
        for r in await conn.fetch(
                "SELECT status, count(*)::int AS n FROM ingest_jobs "
                f" WHERE {' AND '.join(where)} GROUP BY 1", *params):
            outcome = _INGEST_OUTCOMES.get(str(r["status"]), RUNNING)
            out[outcome] = out.get(outcome, 0) + r["n"]
    return out


#: name -> counter, keyed identically to SOURCES. Pinned by the suite: a
#: source without a counter would contribute rows the footer never counts,
#: which is the same silent shortfall in a new disguise.
COUNTERS = {
    "tool": _tool_counts,
    "config": _capability_counts,
    "coding": _coding_counts,
    "automation": _automation_counts,
    "action": _action_counts,
    "consent": _consent_counts,
    "ingest": _ingest_counts,
}


async def _count_all(*, since, agent: Optional[str], wanted: set[str],
                     include_graded: bool) -> tuple[dict[str, int], set[str]]:
    """Whole-window outcome totals -> (counts, sources that could not answer).

    A counter that raises does NOT contribute zero. Zero is a number the
    operator would read as "nothing happened there"; the name comes back in
    the second element instead, and `fetch` turns that into `counts_complete:
    false` plus a visible row. The one thing this must never do is make a
    shortfall look like calm.
    """
    counts: dict[str, int] = {}
    gaps: set[str] = set()
    for name in sorted(wanted):
        counter = COUNTERS.get(name)
        if counter is None:
            # A source with no counter cannot be counted, and saying so is the
            # whole point — see COUNTERS above.
            gaps.add(name)
            log.error("activity log: source %s has no counter", name)
            continue
        try:
            got = (await counter(since, agent, include_graded)
                   if name == "tool" else await counter(since, agent))
        except Exception:                                    # noqa: BLE001
            log.exception("activity log: counting source %s failed", name)
            gaps.add(name)
            continue
        for outcome, n in got.items():
            counts[outcome] = counts.get(outcome, 0) + n
    return counts, gaps


def sources_wanted(kinds: Optional[Iterable[str]]) -> set[str]:
    """Which sources this request covers, validated. ONE definition, used by
    the row gather and the count pass — asking two different sets of sources
    for the rows and for the totals is a footer that cannot add up."""
    wanted = set(kinds) if kinds else set(SOURCES)
    unknown = wanted - set(SOURCES)
    if unknown:
        raise ValueError(f"unknown activity source(s): {sorted(unknown)}")
    return wanted


class _Gathered(NamedTuple):
    """What one merge pass produced.

    `meta` is kept OUT of `rows` on purpose. Meta rows are notices that a
    source could not be read at all; they have no timestamp, they belong at
    the top of the page, and they must survive any cut. Left in the sorted
    list they did the exact opposite: the sort key `(at is not None, at)` with
    `reverse=True` ranks `(False, None)` BELOW every real row, so the notice
    reading "This part of the log is MISSING, not empty" sorted to the bottom
    and fell off the first full page. Verified: with a source patched to raise,
    `fetch(window='24h', limit=200)` returned 200 rows and zero notices.
    """
    rows: list[dict]                 # real rows, newest first
    meta: list[dict]                 # unreadable-source notices, never cut
    at_cap: set[str]                 # hit their per-source ceiling
    oldest_fetched: dict[str, Any]
    unreadable: set[str]             # raised — NOT the same thing as capped


async def _gather(*, since, per_source: int, agent: Optional[str],
                  kinds: Optional[Iterable[str]], problems_only: bool,
                  include_graded: bool) -> _Gathered:
    """Every source, merged newest-first.

    A source that returned exactly `per_source` rows may have more inside the
    window — that fact is carried out, never dropped, because it is the
    difference between "there were four refusals today" and "there were four
    in the part I looked at".
    """
    wanted = sources_wanted(kinds)

    rows: list[dict] = []
    meta: list[dict] = []
    at_cap: set[str] = set()
    unreadable: set[str] = set()
    #: source -> the timestamp of the OLDEST row it fetched, recorded before
    #: any later narrowing. This is what makes the completeness check exact:
    #: everything a capped source withheld is older than this, so comparing it
    #: to the page's cut answers "did the cap cost us anything on this page?"
    #: without guessing. Reading it off the SURVIVING rows instead was wrong
    #: in both directions — a source that survived nothing looked complete
    #: (hiding data), and one that survived only recent rows looked incomplete
    #: forever (a banner nobody reads).
    oldest_fetched: dict[str, Any] = {}
    for name in sorted(wanted):
        fetch = SOURCES[name]
        try:
            # `include_graded` is meaningful only where a graded eval run can
            # produce rows, which is the tool spans — nothing else carries a
            # trace source.
            if name == "tool":
                got = await fetch(since, per_source, agent, problems_only,
                                  include_graded)
            else:
                got = await fetch(since, per_source, agent, problems_only)
        except Exception:                                    # noqa: BLE001
            # A source that cannot be read must SAY SO, not vanish. A log
            # quietly missing its coding sessions is a log that reports "she
            # did nothing" while she is mid-build — the reassuring-untruth
            # this repo keeps finding.
            #
            # It is also NOT a page cap, and it used to be filed as one:
            # `at_cap.add(name)` here left the operator reading "…ingest hit
            # the page cap, so older entries inside the window are NOT on this
            # page. Narrow the window" about a source that had thrown — a
            # crash described as pagination, with advice that could never fix
            # it. `unreadable` is its own set for that reason.
            log.exception("activity log: source %s failed", name)
            meta.append(_row(
                id=f"error:{name}", at=None, kind="meta", actor="activity-log",
                title=f"could not read the “{name}” source",
                outcome=FAILED,
                reason=("This part of the log is MISSING, not empty — do not "
                        "read the page as complete. The backend log has the "
                        "traceback."),
                extra={"_src": name},
            ))
            unreadable.add(name)
            continue
        if len(got) >= per_source:
            at_cap.add(name)
        if got and got[-1]["at"] is not None:
            oldest_fetched[name] = got[-1]["at"]
        rows.extend(_tag(got, name))

    # Real rows only — every one has an `at`, so the key needs no None dance.
    # The notices are returned alongside and pinned to the top by `fetch`.
    rows.sort(key=lambda r: r["at"], reverse=True)
    if problems_only:
        # Belt and braces over the SQL predicates above: every source now
        # filters in its own vocabulary, and this catches any row whose
        # derived outcome disagrees with the predicate that let it through.
        rows = [r for r in rows if r["outcome"] in PROBLEM_OUTCOMES]
    return _Gathered(rows, meta, at_cap, oldest_fetched, unreadable)


async def fetch(*, window: str = DEFAULT_WINDOW, limit: int = DEFAULT_LIMIT,
                offset: int = 0,
                agent: Optional[str] = None,
                outcome: Optional[str] = None,
                kinds: Optional[Iterable[str]] = None,
                include_graded: bool = False) -> dict:
    """The action log for one window.

    `outcome` is one of: None (everything), 'problems' (refusals, failures and
    stalls), or a single outcome name for a narrower cut.

    WHAT IT SAYS WHEN IT CAPPED. `complete` is False whenever this page is not
    the whole of what matched inside the window — a source hit its ceiling
    with rows still newer than the page's cut, a source could not be read at
    all, the counts could not be totalled, `offset` moved past the newest
    rows, or `matched` is simply larger than what fits. That last one used to
    be missing: 383 rows matched, 150 were returned, `complete` said True, and
    the 233 the operator never saw were not reachable by any parameter. Hence
    `offset` — the banner now names a number the operator can act on.

    `matched` and `counts` are whole-window totals from their own aggregate
    queries, NOT a tally of the page. They do not move when `limit` does.
    """
    if window not in WINDOWS:
        raise ValueError(f"unknown window '{window}'; expected one of "
                         f"{sorted(WINDOWS)}")
    limit = max(1, min(int(limit), MAX_LIMIT))
    offset = max(0, int(offset))
    if offset + limit > MAX_SPAN:
        # Refused, not silently clamped: a clamped offset returns the WRONG
        # page and looks exactly like the right one.
        raise ValueError(
            f"offset {offset} + limit {limit} exceeds {MAX_SPAN}; paging that "
            f"deep cannot be merged in order — narrow the window or filter")
    outcome = (outcome or "").strip().lower() or None
    if outcome in ("all", "any"):
        outcome = None
    known = {"problems", OK, REFUSED, FAILED, RUNNING, STALLED, WAITING, SKIPPED}
    if outcome is not None and outcome not in known:
        raise ValueError(f"unknown outcome '{outcome}'; expected one of "
                         f"{sorted(known)}")

    # Only the non-ok filters can be pushed into SQL as `status <> 'ok'`.
    # `outcome=ok` and `outcome=running` are narrowings the database cannot
    # express either, so they take the over-fetch path too.
    problems_only = outcome in PROBLEM_OUTCOMES or outcome == "problems"
    narrow = outcome is not None and outcome != "problems"

    # SQL can express "not ok"; it cannot express "refused rather than failed",
    # because that lives in the text of a recorded error. So a narrow filter
    # over-fetches and the honesty check below covers the difference.
    #
    # Every source is read down to offset+limit, not limit: merging N sorted
    # lists and then skipping `offset` requires each list to reach that far, or
    # page 2 is a page of whichever source happened to be shortest.
    span = offset + limit
    per_source = min(span * (_NARROW_FETCH_FACTOR if narrow else 1), MAX_SPAN)

    since_sql = f"now() - interval '{WINDOWS[window]} hours'"
    async with db.acquire() as conn:
        since = await conn.fetchval(f"SELECT {since_sql}")

    wanted = sources_wanted(kinds)
    got = await _gather(
        since=since, per_source=per_source, agent=agent, kinds=kinds,
        problems_only=problems_only, include_graded=include_graded)
    rows = got.rows

    if narrow:
        rows = [r for r in rows if r["outcome"] == outcome]

    # THE WHOLE-WINDOW TOTALS. Their own queries, no LIMIT, no page — see the
    # counters above for what tallying the page instead cost us.
    counts, count_gaps = await _count_all(
        since=since, agent=agent, wanted=wanted, include_graded=include_graded)
    if outcome is None:
        matched = sum(counts.values())
    elif outcome == "problems":
        matched = sum(counts.get(o, 0) for o in PROBLEM_OUTCOMES)
    else:
        matched = counts.get(outcome, 0)
    if len(rows) > matched:
        # A tripwire, not a repair. The counter and the row builder read the
        # same derivation, so this can only fire if one of them drifted — and
        # the page must never claim fewer rows exist than it is holding.
        if not count_gaps:
            log.error("activity log: counts said %d but %d rows matched "
                      "(outcome=%s window=%s) — a counter has drifted from "
                      "its row builder", matched, len(rows), outcome, window)
        matched = len(rows)

    window_slice = rows[offset:span]
    # Notices ride ABOVE the page and are never counted against the limit: an
    # unreadable source is the most important thing here, and a page-cap is no
    # reason to hide the fact that part of the log is missing.
    page = got.meta + window_slice

    # HONEST COMPLETENESS. A source that hit its ceiling only cost us something
    # if its OLDEST returned row is newer than the oldest row on this page —
    # everything it withheld is older than that, and therefore outside what is
    # being shown anyway. Anything less rigorous is either a permanent scary
    # banner (useless) or a silent truncation (the thing this file exists to
    # remove).
    cut = window_slice[-1]["at"] if window_slice else None
    # WHERE EACH SOURCE'S SURVIVING HISTORY BEGINS, and whether this window
    # asks past a source's own retention. `outran` forces incomplete: rows
    # inside the window may already have been pruned, and a page that cannot
    # know what it is missing may not call itself whole. `history_begins`
    # rides along either way so the surface can state where the log starts
    # instead of letting absence read as calm.
    history = await _history_begins(wanted)
    outran = beyond_retention(WINDOWS[window], wanted)
    complete = True
    if outran:
        complete = False
    if got.meta or count_gaps:
        complete = False               # a source did not answer at all
    elif offset > 0 or offset + len(window_slice) < matched:
        # Rows inside the window are not on this page. Said plainly, with
        # `matched`/`offset` to act on, instead of a `True` that made 233
        # missing rows look like the end of the list.
        complete = False
    elif got.at_cap:
        if cut is None:
            complete = False           # nothing shown but sources were capped
        else:
            for name in got.at_cap:
                oldest = got.oldest_fetched.get(name)
                # `>=`, not `>`. Everything a capped source withheld is at or
                # older than its oldest FETCHED row. Strictly-older rows fall
                # outside the page anyway — but at EQUALITY the withheld rows
                # share the cut timestamp, and those belong on the page and
                # are not on it. Caught by tests/test_activity_log.py: three
                # tool spans seeded in the same instant, limit=1, and the page
                # called itself complete while holding one of them.
                if oldest is None or oldest >= cut:
                    complete = False
                    break

    return {
        "window": window,
        "since": since,
        "rows": page,
        # The activity rows on this page. Meta notices are additional and are
        # never counted here, because they are not part of `matched` either.
        "returned": len(window_slice),
        "matched": matched,
        "limit": limit,
        "offset": offset,
        "max_span": MAX_SPAN,
        # What was left out, said plainly rather than implied by a short list.
        "complete": complete,
        "capped_sources": sorted(got.at_cap),
        # Sources that THREW. Distinct from capped, because "narrow the
        # window" is useless advice for a source that crashed.
        "unreadable_sources": sorted(got.unreadable | count_gaps),
        # The oldest SURVIVING row per source, and the sources whose own
        # retention is shorter than this window — for those, absence of a row
        # is not evidence it did not happen, and `complete` is already False.
        "history_begins": history,
        "beyond_retention": sorted(outran),
        "counts": counts,
        # False when a counter could not answer: the totals below are then a
        # floor, not a total, and nothing may render them as the whole truth.
        "counts_complete": not count_gaps,
        "include_graded": include_graded,
        "problem_outcomes": sorted(PROBLEM_OUTCOMES),
    }


async def facets(window: str = DEFAULT_WINDOW,
                 include_graded: bool = False) -> dict:
    """The filter options, DERIVED from what is actually in the window.

    Never a hand-written list of agents: an agent created this morning has to
    appear in the filter this morning, and one that has done nothing must not
    sit there implying it did.
    """
    if window not in WINDOWS:
        raise ValueError(f"unknown window '{window}'")
    hours = WINDOWS[window]
    graded_clause = "" if include_graded else " AND t.source <> 'eval'"
    async with db.acquire() as conn:
        actors = await conn.fetch(
            f"""
            SELECT actor, sum(n)::int AS n FROM (
              SELECT s.detail->>'agent' AS actor, count(*) AS n
                FROM turn_spans s JOIN turn_traces t ON t.id = s.trace_id
               WHERE s.kind = 'tool'
                 AND s.started_at >= now() - interval '{hours} hours'
                 {graded_clause}
               GROUP BY 1
              UNION ALL
              SELECT actor, count(*) FROM capability_events
               WHERE at >= now() - interval '{hours} hours' GROUP BY 1
              UNION ALL
              SELECT requested_by, count(*) FROM coding_sessions
               WHERE COALESCE(progress_at, updated_at, created_at)
                     >= now() - interval '{hours} hours' GROUP BY 1
              UNION ALL
              SELECT {_AUTOMATION_ACTOR}, count(*)
                FROM automation_runs r JOIN automations a ON a.id = r.automation_id
               WHERE r.started_at >= now() - interval '{hours} hours' GROUP BY 1
              UNION ALL
              SELECT enqueued_by, count(*) FROM ingest_jobs
               WHERE COALESCE(finished_at, started_at, enqueued_at)
                     >= now() - interval '{hours} hours' GROUP BY 1
            ) x WHERE actor IS NOT NULL GROUP BY actor ORDER BY 2 DESC""")
        graded = await conn.fetchval(
            f"""SELECT count(*) FROM turn_spans s
                  JOIN turn_traces t ON t.id = s.trace_id
                 WHERE s.kind = 'tool' AND t.source = 'eval'
                   AND s.started_at >= now() - interval '{hours} hours'""")
    return {
        "window": window,
        "windows": list(WINDOWS),
        "agents": [{"name": r["actor"], "count": r["n"]} for r in actors],
        "kinds": sorted(SOURCES),
        # Named, not hidden: the log excludes graded eval calls by default
        # because 4 out of 5 tool spans on this install are eval replays, and
        # a page that is 80% simulated calls is a page nobody reads. Saying
        # how many were set aside is the difference between a default and a
        # silence.
        "graded_excluded": int(graded or 0),
    }
