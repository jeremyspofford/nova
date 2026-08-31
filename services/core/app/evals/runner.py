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
from typing import Any

import asyncpg

from app import chat, settings_store, traces
from app.evals import cases as cases_mod
from app.evals import predicates
from app.identity import Person

logger = logging.getLogger("core")

# The turn's kind. Tags every eval turn so it is attributable to the eval AND
# filtered out of the Activity list (see activity.list_activity). The drill-in
# stays reachable, so T3 can link a run to its trace.
EVAL_TURN_KIND = "eval"

# A dedicated non-owner identity. Its per-person memory partition and its
# conversations are never the owner's — that is the isolation boundary. role
# 'guest' keeps it off the one-owner unique index and out of any owner-scoped
# query. Reused across runs (created once), so evals do not litter `people`.
SCRATCH_PERSON_NAME = "__eval_scratch__"
SCRATCH_PERSON_ROLE = "guest"

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
    """The dedicated eval identity, created once and reused. A `guest` so it can
    never collide with the one-owner index and is never returned by an
    owner-scoped query — the eval's sandbox, isolated from the owner."""
    row = await pool.fetchrow(
        "SELECT id, name, role FROM people WHERE name = $1 AND role = $2",
        SCRATCH_PERSON_NAME,
        SCRATCH_PERSON_ROLE,
    )
    if row is None:
        row = await pool.fetchrow(
            "INSERT INTO people (name, role) VALUES ($1, $2) RETURNING id, name, role",
            SCRATCH_PERSON_NAME,
            SCRATCH_PERSON_ROLE,
        )
    return Person(id=row["id"], name=row["name"], role=row["role"])


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
    conversation_id = await _scratch_conversation(pool, person)
    history = _history_from_setup(case.setup)

    # Mirror chat_stream: the user message is persisted into the SCRATCH
    # conversation, so it reads as a faithful transcript for T3's trace link —
    # scoped to the scratch person, never the owner. Not read back for scoring.
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
        # _run_turn hands us serialized SSE frames and a trailing None sentinel;
        # we only need the error frame for the ungradeable reason, but keep them
        # all — cheap, and honest about what the turn emitted.
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
        # _run_turn is built never to raise (it catches everything and closes the
        # turn); if something still escaped, that is an infra/harness failure, so
        # the run is UNGRADEABLE — never a fabricated fail.
        logger.exception("eval run_case: _run_turn raised for case %s", case.id)
        await chat.drain_background()
        return _base(
            None, True, {"reason": f"the turn raised — {type(exc).__name__}: {exc}"}
        )

    # Let the atomic trace close (and any queued ingest) land before reading the
    # turn's final status — close_turn is a background task in _run_turn.
    await chat.drain_background()
    status = await pool.fetchval("SELECT status FROM turns WHERE id = $1", turn.id)

    if status != "ok":
        # UNGRADEABLE: the turn errored (gateway down, model not installed, empty
        # reply). Recorded as such and excluded from the denominator — never a 0.
        reason = _error_frame(frames) or f"turn closed with status {status!r}"
        return _base(None, True, {"reason": reason, "status": status})

    # The durable reply the guards left (chat.py persists exactly one assistant
    # message per turn): the definitive final answer, scored by reply predicates.
    reply = (
        await pool.fetchval(
            "SELECT content FROM messages WHERE conversation_id = $1 AND role = 'assistant' "
            "ORDER BY created_at DESC, id DESC LIMIT 1",
            conversation_id,
        )
        or ""
    )

    passed, results = predicates.score_contract(case.contract, turn.spans, reply)
    detail = {
        "reply": reply[:_DETAIL_REPLY_CHARS],
        "predicates": [r.as_json() for r in results],
    }
    return _base(passed, False, detail)


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
    real unload between is a later tournament concern, out of T1's scope."""
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


def score_summary(runs: Sequence[EvalRun]) -> dict:
    """The pass rate, with UNGRADEABLE runs excluded from the denominator. Returns
    pass_rate=None when nothing is gradeable — an empty state, never a fake 0."""
    gradeable = [r for r in runs if not r.ungradeable]
    passed = [r for r in gradeable if r.passed]
    return {
        "total": len(runs),
        "gradeable": len(gradeable),
        "ungradeable": len(runs) - len(gradeable),
        "passed": len(passed),
        "pass_rate": (len(passed) / len(gradeable)) if gradeable else None,
    }
