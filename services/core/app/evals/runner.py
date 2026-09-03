"""run_case / run_suite — replay a case through the REAL turn path and score it.

The point of the whole slice sits here: an eval MEASURES a model by driving the
case's message through chat._run_turn — the exact coroutine a live chat turn
runs, with the chosen model as the chat model the gateway serves — and scoring
the TRACE it leaves. Not an ad-hoc shortcut turn (v3 lesson:
never-measure-with-adhoc-turns), not the recorded reply, not a fabricated
number.

Three properties are enforced mechanically, not by intention:

  * SCRATCH ISOLATION (rail 17). The turn runs as a dedicated non-owner scratch
    person in a scratch conversation. Because memory is per-person (chat.py's
    _recall/_ingest send person_id, and the memory service partitions on it),
    the scratch person's id is the partition boundary: an eval NEVER reads or
    writes the OWNER's memory, conversation, or messages. The scratch person's
    own rows are the eval's sandbox, not the owner's live state.

    The boundary holds ACROSS cases too, not only against the owner: every
    call to run_case gets its OWN fresh scratch person (see scratch_person),
    never a shared one reused across a suite. A reused scratch person let one
    case's ingested exchange surface in a LATER case's recall and change that
    case's result — a real, measured contamination (S4 carry: "cross-case
    memory within the scratch person", docs/plans/rebuild/slice-04-carries.md)
    — so per-case identity, not just per-run isolation from the owner, is the
    actual isolation boundary a case can depend on. Each fresh person is torn
    down after its case is scored (_cleanup_scratch_person) so a suite, or many
    suite runs over time, does not litter `people`/`conversations`/`messages`
    unboundedly.

  * NO TEST-AWARENESS LEAKAGE. _run_turn builds the prompt from the normal
    stable/volatile system prompt — this module injects nothing. No "eval mode"
    string reaches the model; the only eval-ness is the turn's kind='eval' tag
    and the scratch person id, neither of which is in the prompt. A test pins the
    system prompt byte-identical to a normal turn's.

  * UNGRADEABLE != 0. If the turn errored (gateway down, model not installed,
    empty reply — the turn closes 'error'), the run is UNGRADEABLE: recorded as
    such and excluded from the denominator, NEVER scored 0 or a fake false (v3
    lesson: tournament-vram-self-starvation / fitness-measures-not-declares).

The turn's trace is recorded normally (turns/turn_spans) but tagged kind='eval',
so it is attributable to the eval run and reachable at /api/v1/activity/<id> for
T3 — while activity.list_activity filters kind='eval' OUT of the operator's
normal Activity feed, so an eval turn never surfaces as a chat turn.

eval_runs is WRITTEN here and read by no decision path (audit/reporting only,
like the governance ledger): the turn path, the policy kernel and the guards
never read it. suite_version is stored on every row so a score is only ever
compared across runs of the same version.
"""
from __future__ import annotations

import json
import logging
import uuid
from collections.abc import Sequence
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any

import asyncpg
import httpx

from app import chat, peers, settings_store, traces
from app.evals import cases as cases_mod
from app.evals import predicates
from app.identity import Person

logger = logging.getLogger("core")

# The turn's kind. Tags every eval turn so it is attributable to the eval AND
# filtered out of the Activity list (see activity.list_activity). The drill-in
# stays reachable, so T3 can link a run to its trace.
EVAL_TURN_KIND = "eval"

# A dedicated non-owner identity, one FRESH instance per case (never reused —
# see scratch_person). Its per-person memory partition and its conversation
# are never the owner's, and never another case's, either — that is the
# isolation boundary. role 'guest' keeps it off the one-owner unique index and
# out of any owner-scoped query. The name carries no meaning beyond
# uniqueness: SCRATCH_PERSON_NAME plus a fresh uuid4 hex, so two cases (or two
# runs) can never collide on it.
SCRATCH_PERSON_NAME = "__eval_scratch__"
SCRATCH_PERSON_ROLE = "guest"

# Best-effort timeout for the memory /forget call _cleanup_scratch_person
# makes — short, because a slow/unreachable memory service must never hang
# case scoring; a failure here is logged and swallowed, never raised.
_FORGET_TIMEOUT = httpx.Timeout(5.0)

# The default tool-round budget if the setting cannot be read — the same
# SETTING_DEFS default, so an eval turn matches a real one.
_DEFAULT_MAX_TOOL_ROUNDS = 6
# How much reply text lands in the persisted eval_runs.detail — evidence for the
# page, not the whole essay.
_DETAIL_REPLY_CHARS = 2000


@dataclass
class EvalRun:
    """One case scored against one model. `passed` is None exactly when
    `ungradeable` — the CHECK constraint on eval_runs enforces that pairing, so a
    fake 0 for an errored turn cannot be stored."""

    case_id: str
    suite: str
    suite_version: int
    model: str
    passed: bool | None
    ungradeable: bool
    detail: dict[str, Any] = field(default_factory=dict)
    turn_id: uuid.UUID | None = None
    id: uuid.UUID | None = None  # set by persist_run

    def as_json(self) -> dict:
        return {
            "id": str(self.id) if self.id else None,
            "case_id": self.case_id,
            "suite": self.suite,
            "suite_version": self.suite_version,
            "model": self.model,
            "passed": self.passed,
            "ungradeable": self.ungradeable,
            "detail": self.detail,
            "turn_id": str(self.turn_id) if self.turn_id else None,
        }


async def scratch_person(pool: asyncpg.Pool) -> Person:
    """A FRESH, single-use eval identity — never reused across cases or runs.
    A `guest` so it can never collide with the one-owner index and is never
    returned by an owner-scoped query — the eval's sandbox, isolated from the
    owner AND, by being unique every call, from every other case's scratch
    identity too (see the module docstring's isolation section). Callers tear
    it down via _cleanup_scratch_person once the case has been scored."""
    name = f"{SCRATCH_PERSON_NAME}{uuid.uuid4().hex}"
    row = await pool.fetchrow(
        "INSERT INTO people (name, role) VALUES ($1, $2) RETURNING id, name, role",
        name,
        SCRATCH_PERSON_ROLE,
    )
    return Person(id=row["id"], name=row["name"], role=row["role"])


async def _forget_journal(app, person_id: str, journal_path: str) -> bool:
    """POST /forget for exactly one path; True iff the memory service confirms
    it was actually deleted (200). A 404 ("no such file") is the ordinary,
    silent case — most turns never ingest (chat._run_turn skips it for
    ephemeral reads and plumbing turns) — so it is reported False but never
    logged; anything else (a real error) is logged. Never raises: a cleanup
    call must not turn into an eval-scoring failure."""
    try:
        async with peers.client(app, peers.MEMORY, _FORGET_TIMEOUT) as client:
            response = await client.post(
                "/forget", json={"person_id": person_id, "path": journal_path}
            )
    except Exception as exc:
        logger.warning(
            "eval scratch cleanup: /forget failed for %s: %s", journal_path, peers.reason(exc)
        )
        return False
    if response.status_code == 200:
        return True
    if response.status_code != 404:
        logger.warning(
            "eval scratch cleanup: /forget for %s returned %s",
            journal_path,
            response.status_code,
        )
    return False


async def _cleanup_scratch_person(
    app,
    pool: asyncpg.Pool,
    person: Person,
    ingest_date_before,
    turn: traces.Turn | None,
) -> list[str]:
    """Tear down one case's single-use scratch identity so a suite — or many
    suite runs over time — never litters `people`/`conversations`/`messages`
    unboundedly. Always best-effort: nothing here raises, because a teardown
    step must not fail the eval run it is cleaning up after. Returns any
    warnings the caller should attach to that run's own result (never masked
    — see the memory-forget paragraph below).

    Deleting the `people` row cascades to that person's conversations and
    messages (migration 002's people->conversations->messages ON DELETE
    CASCADE); turns/turn_spans/eval_runs are untouched by it — turns.
    conversation_id is ON DELETE SET NULL and eval_runs only references
    turn_id — so the trace T3 links to, and the ledger row itself, both
    survive exactly as activity.py already handles a NULL conversation_id.

    Memory: the ingest span chat.py's `_queue_ingest` leaves (kind=
    'memory_ingest') only records whether an ingest was QUEUED
    (meta["queued"]), never the path the memory service actually wrote —
    chat.py's `_ingest` discards /ingest's response body — so the path this
    function forgets is a RECONSTRUCTION (store.append_journal always targets
    people/<id>/journals/<day>.md), not a value read back from the turn.
    Reconstructing it is still exact for the common case because a fresh,
    single-use scratch person can only ever have ingested into ONE file — but
    "today" is evaluated twice, once by the caller before the turn ran and
    once here at cleanup, and BOTH dates are forgotten when they differ, so a
    turn that straddles UTC midnight cannot leave its journal behind through
    a same-day-only guess. The memory service has no bulk
    "delete-everything-for-this-person" endpoint (only /forget, one path at a
    time, and /export) — see services/memory/app/api.py.

    If the span shows an ingest was queued and NEITHER candidate path came
    back 200, that is NOT quietly treated as success (a 404 there could mean
    the reconstructed path is wrong, not that nothing was ever written): it is
    logged at warning and returned as a warning string for the caller to
    attach to the case's own result, never swallowed. The empty people/<id>/
    directory a successful forget can still leave behind on disk is a tiny,
    harmless remainder — there is no endpoint to remove it."""
    warnings: list[str] = []
    ingest_date_after = datetime.now(UTC).date()
    candidate_paths = sorted(
        {
            f"people/{person.id}/journals/{day.isoformat()}.md"
            for day in {ingest_date_before, ingest_date_after}
        }
    )

    forgotten = False
    for journal_path in candidate_paths:
        if await _forget_journal(app, str(person.id), journal_path):
            forgotten = True

    ingested = turn is not None and any(
        span.kind == "memory_ingest" and span.meta.get("queued") is True for span in turn.spans
    )
    if ingested and not forgotten:
        message = (
            f"eval scratch cleanup: the turn queued a memory ingest but /forget found "
            f"no file at any of {candidate_paths} for person {person.id} — the "
            f"reconstructed path may be wrong, or the memory-side write outlived its "
            f"scratch person"
        )
        logger.warning(message)
        warnings.append(message)

    try:
        await pool.execute("DELETE FROM people WHERE id = $1", person.id)
    except Exception:
        logger.exception("eval scratch cleanup: could not delete scratch person %s", person.id)

    return warnings


async def _sweep_orphan_scratch_people(pool: asyncpg.Pool) -> int:
    """Delete every guest person whose name starts with SCRATCH_PERSON_NAME —
    run once at the START of a suite (never at core startup; this module has
    no background process of its own). Closes two leaks _cleanup_scratch_person
    alone cannot: a case whose process was killed mid-run before its `finally`
    could fire (a crash orphan), and the legacy single shared `__eval_scratch__`
    row some deployments still carry from before scratch identities were
    per-case (starts_with('__eval_scratch__', '__eval_scratch__') is true, so
    that exact name matches too). starts_with(), never LIKE, so the name's own
    literal underscores are never read back as SQL wildcards."""
    rows = await pool.fetch(
        "DELETE FROM people WHERE role = $1 AND starts_with(name, $2) RETURNING id",
        SCRATCH_PERSON_ROLE,
        SCRATCH_PERSON_NAME,
    )
    if rows:
        logger.info("evals: swept %d orphaned scratch person row(s)", len(rows))
    return len(rows)


async def _scratch_conversation(pool: asyncpg.Pool, person: Person) -> uuid.UUID:
    """A fresh conversation owned by the scratch person, marked inactive so it is
    never picked up as anyone's active thread. One per run keeps runs from
    reading each other's history."""
    return await pool.fetchval(
        "INSERT INTO conversations (person_id, title, active) VALUES ($1, $2, false) "
        "RETURNING id",
        person.id,
        "eval scratch",
    )


def _history_from_setup(setup: Sequence[cases_mod.PriorTurn]) -> list[dict]:
    """The case's prior turns as history_window would yield them: oldest-first
    user/assistant pairs, which base_messages extends in order."""
    history: list[dict] = []
    for prior in setup:
        history.append({"role": "user", "content": prior.user})
        history.append({"role": "assistant", "content": prior.assistant})
    return history


def _error_frame(frames: Sequence[Any]) -> str | None:
    """The stated reason from an {"error": ...} SSE frame, if the turn emitted
    one. _run_turn's emit receives already-serialized `data: <json>` strings (the
    exact frames the SSE consumer would see), so this parses them back — the
    ungradeable reason is the turn's own words, never a guess."""
    for frame in frames:
        if not isinstance(frame, str) or not frame.startswith("data:"):
            continue
        payload = frame[len("data:") :].strip()
        if payload == "[DONE]":
            continue
        try:
            data = json.loads(payload)
        except json.JSONDecodeError:
            continue
        if isinstance(data, dict) and "error" in data:
            return data["error"]
    return None


async def run_case(app, pool: asyncpg.Pool, case: cases_mod.Case, model: str) -> EvalRun:
    """Replay one case against `model` and score it. See the module docstring for
    the three enforced properties (scratch isolation, no leakage, ungradeable!=0)."""
    person = await scratch_person(pool)
    # "Today" as of BEFORE the turn runs — _cleanup_scratch_person also reads
    # it fresh at cleanup time and forgets both if they differ, so a turn that
    # straddles UTC midnight cannot leave its journal file behind.
    ingest_date_before = datetime.now(UTC).date()
    # Bound now so the finally below can always reference it, even if nothing
    # after this point ever runs (e.g. _scratch_conversation itself raises) —
    # a run whose SETUP failed has no turn, so cleanup skips the ingest check.
    turn: traces.Turn | None = None
    result: EvalRun | None = None

    # Everything from here on runs against this case's OWN fresh scratch
    # person — the finally below tears it down (person + its conversation +
    # its one possible memory journal file) NO MATTER WHERE this exits: the
    # normal score, the ungradeable-status return, the _run_turn-raised
    # return, or an exception in the setup itself (conversation create,
    # message insert, settings read, open_turn) that propagates past this
    # function entirely — a scratch person must never survive whatever else
    # goes wrong scoring its case.
    try:
        conversation_id = await _scratch_conversation(pool, person)
        history = _history_from_setup(case.setup)

        # Mirror chat_stream: the user message is persisted into the SCRATCH
        # conversation, exactly as a real turn's history would be — the row
        # (and this whole scratch conversation) is deleted by cleanup once the
        # case is scored, so this only needs to exist for the turn's duration,
        # never as a durable transcript.
        await pool.execute(
            "INSERT INTO messages (conversation_id, role, content) VALUES ($1, 'user', $2)",
            conversation_id,
            case.message,
        )

        try:
            max_tool_rounds = int(await settings_store.read_value(pool, "agents.max_tool_rounds"))
        except Exception:
            max_tool_rounds = _DEFAULT_MAX_TOOL_ROUNDS

        turn = await traces.open_turn(
            pool, kind=EVAL_TURN_KIND, conversation_id=conversation_id, model=model
        )

        frames: list[Any] = []

        def emit(frame: str | None) -> None:
            # _run_turn hands us serialized SSE frames and a trailing None
            # sentinel; we only need the error frame for the ungradeable
            # reason, but keep them all — cheap, and honest about what the
            # turn emitted.
            frames.append(frame)

        def _base(passed: bool | None, ungradeable: bool, detail: dict) -> EvalRun:
            return EvalRun(
                case_id=case.id,
                suite=case.suite,
                suite_version=case.suite_version,
                model=model,
                passed=passed,
                ungradeable=ungradeable,
                detail=detail,
                turn_id=turn.id,
            )

        try:
            await chat._run_turn(
                app,
                pool,
                turn,
                person,
                conversation_id,
                case.message,
                history,
                model,
                max_tool_rounds,
                emit,
            )
        except Exception as exc:
            # _run_turn is built never to raise (it catches everything and closes
            # the turn); if something still escaped, that is an infra/harness
            # failure, so the run is UNGRADEABLE — never a fabricated fail.
            logger.exception("eval run_case: _run_turn raised for case %s", case.id)
            await chat.drain_background()
            result = _base(
                None, True, {"reason": f"the turn raised — {type(exc).__name__}: {exc}"}
            )
        else:
            # Let the atomic trace close (and any queued ingest) land before
            # reading the turn's final status — close_turn is a background
            # task in _run_turn.
            await chat.drain_background()
            status = await pool.fetchval("SELECT status FROM turns WHERE id = $1", turn.id)

            if status != "ok":
                # UNGRADEABLE: the turn errored (gateway down, model not
                # installed, empty reply). Recorded as such and excluded from
                # the denominator — never a 0.
                reason = _error_frame(frames) or f"turn closed with status {status!r}"
                result = _base(None, True, {"reason": reason, "status": status})
            else:
                # The durable reply the guards left (chat.py persists exactly
                # one assistant message per turn): the definitive final
                # answer, scored by reply predicates.
                reply = (
                    await pool.fetchval(
                        "SELECT content FROM messages WHERE conversation_id = $1 "
                        "AND role = 'assistant' ORDER BY created_at DESC, id DESC LIMIT 1",
                        conversation_id,
                    )
                    or ""
                )

                passed, results = predicates.score_contract(case.contract, turn.spans, reply)
                detail = {
                    "reply": reply[:_DETAIL_REPLY_CHARS],
                    "predicates": [r.as_json() for r in results],
                }
                result = _base(passed, False, detail)
        return result
    finally:
        # drain_background() has already run on every path that reaches it
        # (including the _run_turn-raised one), so any queued ingest has
        # already landed — cleanup here never races it. A setup-phase
        # exception means `turn` is still None; _cleanup_scratch_person
        # handles that (no ingest span to check, nothing to forget beyond the
        # two reconstructed candidate dates).
        cleanup_warnings = await _cleanup_scratch_person(
            app, pool, person, ingest_date_before, turn
        )
        # `result` is the SAME object already handed to the `return` above —
        # mutating its `detail` here still reaches the caller, since `finally`
        # runs after the return value is captured but before control actually
        # leaves the function. Never invented for the exception-propagates
        # case (result is None there — nothing to attach a warning to).
        if cleanup_warnings and result is not None:
            result.detail.setdefault("warnings", []).extend(cleanup_warnings)


async def persist_run(pool: asyncpg.Pool, run: EvalRun) -> uuid.UUID:
    """Write one EvalRun to eval_runs and stamp its id back onto the object.

    The table's CHECK constraint refuses a row where ungradeable disagrees with
    passed-IS-NULL, so a fake 0/false for an errored turn cannot be persisted
    even by a caller that got the pairing wrong."""
    run_id = await pool.fetchval(
        "INSERT INTO eval_runs "
        "(suite, suite_version, model, case_id, passed, ungradeable, detail, turn_id) "
        "VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8) RETURNING id",
        run.suite,
        run.suite_version,
        run.model,
        run.case_id,
        run.passed,
        run.ungradeable,
        run.detail,
        run.turn_id,
    )
    run.id = run_id
    return run_id


async def run_suite(
    app,
    pool: asyncpg.Pool,
    suite: str,
    model: str,
    *,
    cases: Sequence[cases_mod.Case] | None = None,
    persist: bool = True,
) -> list[EvalRun]:
    """Run every case of a suite against `model`, persisting each run.

    The drive point T3 (and tests) call. `cases` overrides the git corpus (tests
    pass an explicit list); otherwise the suite's fixtures are loaded — which
    also pins that a suite never mixes versions (cases.load_suite raises). Cases
    run SEQUENTIALLY against the one chosen model; multi-model sequencing with a
    real unload between is a later tournament concern, out of T1's scope.

    Sweeps orphaned scratch-person rows FIRST (see
    _sweep_orphan_scratch_people) — a suite is the natural place for this,
    never core startup, since it is the one call every real drive point
    (T3, the DoD walk) actually makes."""
    await _sweep_orphan_scratch_people(pool)
    suite_cases = list(cases) if cases is not None else cases_mod.load_suite(suite)
    runs: list[EvalRun] = []
    for case in suite_cases:
        run = await run_case(app, pool, case, model)
        if persist:
            await persist_run(pool, run)
        runs.append(run)
    return runs


# -- audit/reporting reads (NOT a decision path) ---------------------------
#
# These read eval_runs for the page and the DoD walk only. Nothing in the turn
# path, the policy kernel or the guards imports this module — the score measures,
# it never decides (fitness measures, never declares).


async def runs_for(
    pool: asyncpg.Pool, suite: str, suite_version: int, model: str
) -> list[dict]:
    """Every run for exactly this (suite, suite_version, model), newest first.
    Scoped to one version on purpose: a score is only comparable within a
    version, so this never blends two."""
    rows = await pool.fetch(
        "SELECT id, case_id, model, passed, ungradeable, detail, turn_id, created_at "
        "FROM eval_runs WHERE suite = $1 AND suite_version = $2 AND model = $3 "
        "ORDER BY created_at DESC, id DESC",
        suite,
        suite_version,
        model,
    )
    return [dict(row) for row in rows]


def summarize(outcomes: Sequence[tuple[bool | None, bool]]) -> dict:
    """The pass rate over (passed, ungradeable) pairs — the ONE place the rate is
    computed, so the in-memory `score_summary` (fresh EvalRun objects) and the
    runs API (persisted eval_runs rows) can never drift on the null-not-0 rule.

    UNGRADEABLE outcomes are excluded from the denominator; pass_rate is None when
    nothing is gradeable — an empty state, never a fake 0 (the v3 tournament
    lesson: an ungradeable run is not a zero)."""
    total = len(outcomes)
    gradeable = [passed for passed, ungradeable in outcomes if not ungradeable]
    passed_count = sum(1 for passed in gradeable if passed)
    return {
        "total": total,
        "gradeable": len(gradeable),
        "ungradeable": total - len(gradeable),
        "passed": passed_count,
        "pass_rate": (passed_count / len(gradeable)) if gradeable else None,
    }


def score_summary(runs: Sequence[EvalRun]) -> dict:
    """The pass rate for a set of fresh EvalRun objects — `summarize` over their
    (passed, ungradeable) pairs. See `summarize` for the null-not-0 rule."""
    return summarize([(r.passed, r.ungradeable) for r in runs])
