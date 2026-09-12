"""Skills: a procedure written down, and the record of whether it helped (S17).

A skill is two things that must not drift apart. The BODY is markdown at
`<WORKSPACE_ROOT>/skills/<name>.md` — where agents already look, and where the
owner can edit it by hand like a memory note. The ROW (migration 025) is the
record around it: status, provenance, the ledger.

What this module refuses to do is the point of it.

THE STEPS COME FROM `turn_spans`. `steps_from_turns` reads the tool spans of
the turns a skill was distilled from, in order, and that list is what the body
says was done. A skill therefore cannot describe a call that never ran — the
same rule as S14's distillation notes and S12's delegation facts line, for the
same reason: a procedure is a claim about what works, and a claim nothing
backs is the failure this codebase keeps finding.

THE SUMMARY IS HIS SENTENCE. It is composed from the USER message rows of the
source turns, quoted and dated. Not her restatement of them: a restatement is
a model's words about a model's words, and the summary is the matching signal
that decides whether a procedure is offered at all. The assistant rows are
deliberately not read — the window is his side only, the same cut review.py
makes and for the same reason.

SO NO MODEL CALL CREATES A SKILL, ON ANY PATH. A draft is composed end to end
by code: title from the tool sequence, summary from his requests, steps from
the spans. Prose is what the OWNER adds when he edits one. Until then a skill
says exactly what the trace says.

A ROW WHOSE FILE IS MISSING REFUSES BY NAME. `load` raises rather than
returning "", because an empty procedure injected into a prompt reads to the
model exactly like a procedure that says nothing is needed.

STATUS IS A LIFECYCLE, NOT A PERMISSION (owner ruling 2026-09-03: nothing here
asks anyone for approval). A draft is not advertised because the owner has not
read it yet; a retired one is not advertised because he withdrew it. `load`
refuses both by status, so a name she remembers from an earlier turn cannot
reach a procedure that was taken away.
"""

from __future__ import annotations

import logging
import re
import uuid
from collections.abc import Iterable, Sequence
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path

import asyncpg

from app.tools.workspace import root_from_env

logger = logging.getLogger("core")

# The file stem, and the same class migration 025 spells in SQL. A name that
# fails this never reaches a path, so a hand-edited row cannot turn `../x`
# into a file read.
NAME_RE = re.compile(r"^[a-z][a-z0-9_-]{0,40}$")

# How much of a body reaches a prompt. Same budget agents.py has always used
# for the same files; the cut is STATED in the text, never silent.
BODY_CHARS = 4000

DRAFT = "draft"
ACTIVE = "active"
FLAGGED = "flagged"
RETIRED = "retired"
STATUSES = (DRAFT, ACTIVE, FLAGGED, RETIRED)

CREATED_VIA = ("beat", "page", "eval")

# The tool that reads a body. Named here as a constant because the roster line
# tells her how to use it: a rename moves that sentence instead of leaving the
# prompt naming a tool that no longer exists.
LOAD_TOOL = "load_skill"

# The tool that RUNS a scripted one (S18). Same reason it is a constant: the
# roster line tells her how to call it, and a rename must move that sentence
# rather than leave the prompt naming a tool that no longer exists.
RUN_TOOL = "run_skill"

_COLUMNS = (
    "id, name, title, summary, status, created_via, source_turn_ids, step_names, "
    "flagged_reason, script, inputs, created_at, updated_at"
)


class SkillUnavailable(Exception):
    """A skill that cannot be read, and why in words the model is shown."""


@dataclass(frozen=True)
class Skill:
    id: uuid.UUID
    name: str
    title: str
    summary: str
    status: str
    created_via: str
    source_turn_ids: tuple[uuid.UUID, ...]
    step_names: tuple[str, ...]
    flagged_reason: str | None
    # S18: the step program and the JSON Schema for what run_skill must be
    # handed. Both None for a prose-only skill, both set for a scripted one —
    # the migration's CHECK is what makes that pair a fact rather than a habit.
    script: dict | None
    inputs: dict | None
    created_at: datetime
    updated_at: datetime

    @staticmethod
    def from_row(record: asyncpg.Record) -> Skill:
        return Skill(
            id=record["id"],
            name=record["name"],
            title=record["title"],
            summary=record["summary"],
            status=record["status"],
            created_via=record["created_via"],
            source_turn_ids=tuple(record["source_turn_ids"] or ()),
            step_names=tuple(record["step_names"] or ()),
            flagged_reason=record["flagged_reason"],
            script=record["script"],
            inputs=record["inputs"],
            created_at=record["created_at"],
            updated_at=record["updated_at"],
        )


# ── the file ───────────────────────────────────────────────────────────────


def skills_dir(root: Path | None = None) -> Path:
    return (root_from_env() if root is None else root) / "skills"


def body_path(name: str, root: Path | None = None) -> Path | None:
    """None for a name that fails the rule — such a name never reaches a path."""
    if not NAME_RE.fullmatch(name):
        return None
    return skills_dir(root) / f"{name}.md"


def body_text(name: str, root: Path | None = None) -> str | None:
    """The file's text, cut at BODY_CHARS with the cut stated; None when the
    file is not there. The caller says so — never dropped silently."""
    path = body_path(name, root)
    if path is None or not path.is_file():
        return None
    try:
        text = path.read_text(encoding="utf-8", errors="replace")
    except OSError as exc:
        logger.warning("skill %s could not be read: %s", name, exc)
        return None
    if len(text) > BODY_CHARS:
        text = (
            text[:BODY_CHARS]
            + f"\n[skill {name}: cut here — the first {BODY_CHARS} of {len(text)} characters]"
        )
    return text


def list_body_files(root: Path | None = None) -> list[dict]:
    """The skill files that exist, derived from the directory each call, so a
    file written by hand (or with workspace_write_file) is visible by that
    fact. Independent of the table on purpose: the Skills page shows a file
    with no row as exactly that, rather than hiding it."""
    directory = skills_dir(root)
    if not directory.is_dir():
        return []
    out = []
    for path in sorted(directory.glob("*.md")):
        if not path.is_file() or not NAME_RE.fullmatch(path.stem):
            continue
        stat = path.stat()
        out.append(
            {
                "name": path.stem,
                "size": stat.st_size,
                "modified": datetime.fromtimestamp(stat.st_mtime, UTC).isoformat(),
            }
        )
    return out


def _write_body(name: str, body: str, root: Path | None) -> Path:
    path = body_path(name, root)
    if path is None:
        raise ValueError(f"{name!r} is not a usable skill name")
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(body, encoding="utf-8")
    return path


# ── the row ────────────────────────────────────────────────────────────────


async def create(
    pool: asyncpg.Pool,
    *,
    name: str,
    title: str,
    summary: str,
    created_via: str,
    body: str,
    source_turn_ids: Sequence[uuid.UUID] = (),
    step_names: Sequence[str] = (),
    script: dict | None = None,
    inputs: dict | None = None,
    root: Path | None = None,
) -> Skill:
    """Write the file, then the row. The file first because a row pointing at
    nothing is the one state `load` has to refuse, and it should not be
    reachable through the normal path."""
    if not NAME_RE.fullmatch(name):
        raise ValueError(f"{name!r} is not a usable skill name (lowercase, digits, - and _)")
    if created_via not in CREATED_VIA:
        raise ValueError(f"created_via must be one of {CREATED_VIA}, not {created_via!r}")
    if not title.strip() or not summary.strip():
        raise ValueError("a skill needs a title and a summary")
    if (script is None) != (inputs is None):
        raise ValueError(
            "a script and its inputs schema go together — a script with no declared inputs "
            "carries empty properties, which is not the same as declaring nothing"
        )
    if script is not None:
        _validate_script(script, inputs)
    _write_body(name, body, root)
    record = await pool.fetchrow(
        "INSERT INTO skills (name, title, summary, created_via, source_turn_ids, step_names, "
        f"script, inputs) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING {_COLUMNS}",
        name,
        title.strip(),
        summary.strip(),
        created_via,
        list(source_turn_ids),
        list(step_names),
        script,
        inputs,
    )
    return Skill.from_row(record)


def _validate_script(script: object, inputs: object) -> None:
    """The script validator, imported where it is used: app/skill_scripts.py
    imports the tool registry, and the registry's tool modules import this
    one."""
    from app import skill_scripts

    try:
        skill_scripts.validate(script, inputs)
    except skill_scripts.ScriptError as exc:
        raise ValueError(str(exc)) from exc


async def set_script(
    pool: asyncpg.Pool, name: str, script: dict | None, inputs: dict | None
) -> Skill:
    """Give a skill a script, or take one away (both None).

    Validated here rather than at the API, so the page, a test and any later
    caller are refused by the same sentence — and refused BEFORE the write, so
    a stored script is always one that could run when it was saved.
    """
    if (script is None) != (inputs is None):
        raise ValueError("a script and its inputs schema go together")
    if script is not None:
        _validate_script(script, inputs)
    record = await pool.fetchrow(
        "UPDATE skills SET script = $2, inputs = $3, updated_at = now() "
        f"WHERE name = $1 RETURNING {_COLUMNS}",
        name,
        script,
        inputs,
    )
    if record is None:
        raise ValueError(f"no skill named {name!r}")
    return Skill.from_row(record)


async def get(pool: asyncpg.Pool, name: str) -> Skill | None:
    record = await pool.fetchrow(f"SELECT {_COLUMNS} FROM skills WHERE name = $1", name)
    return Skill.from_row(record) if record else None


async def list_all(pool: asyncpg.Pool, *, status: str | None = None) -> list[Skill]:
    if status is None:
        records = await pool.fetch(f"SELECT {_COLUMNS} FROM skills ORDER BY name")
        return [Skill.from_row(r) for r in records]
    records = await pool.fetch(
        f"SELECT {_COLUMNS} FROM skills WHERE status = $1 ORDER BY name", status
    )
    return [Skill.from_row(r) for r in records]


async def set_status(
    pool: asyncpg.Pool, name: str, status: str, *, reason: str | None = None
) -> Skill:
    """Move a skill's status. `reason` is written onto the row for `flagged`
    and cleared otherwise: a standing reason beside a status it no longer
    explains is a sentence that lies about the present."""
    if status not in STATUSES:
        raise ValueError(f"status must be one of {STATUSES}, not {status!r}")
    if status == FLAGGED and not (reason or "").strip():
        raise ValueError("flagging a skill needs a reason — it is the whole of the record")
    record = await pool.fetchrow(
        "UPDATE skills SET status = $2, flagged_reason = $3, updated_at = now() "
        f"WHERE name = $1 RETURNING {_COLUMNS}",
        name,
        status,
        (reason or "").strip() or None if status == FLAGGED else None,
    )
    if record is None:
        raise ValueError(f"no skill named {name!r}")
    return Skill.from_row(record)


async def update(
    pool: asyncpg.Pool,
    name: str,
    *,
    title: str | None = None,
    summary: str | None = None,
    body: str | None = None,
    root: Path | None = None,
) -> Skill:
    """The owner's edit. Title, summary and body only: status moves through
    set_status, and provenance and steps are the record of what happened and
    are not editable at all."""
    if body is not None:
        _write_body(name, body, root)
    record = await pool.fetchrow(
        "UPDATE skills SET title = COALESCE($2, title), summary = COALESCE($3, summary), "
        f"updated_at = now() WHERE name = $1 RETURNING {_COLUMNS}",
        name,
        (title or "").strip() or None,
        (summary or "").strip() or None,
    )
    if record is None:
        raise ValueError(f"no skill named {name!r}")
    return Skill.from_row(record)


async def delete(pool: asyncpg.Pool, name: str) -> bool:
    """Remove the ROW. The file is left where it is, on purpose: deleting a
    file is the workspace's verb, it has a trash and a stated window, and this
    module quietly unlinking one would be the one destructive act in it. The
    API says the path in as many words when it answers."""
    result = await pool.execute("DELETE FROM skills WHERE name = $1", name)
    return result.endswith(" 1")


# ── what reaches a turn ────────────────────────────────────────────────────


async def roster_line(pool: asyncpg.Pool) -> str | None:
    """The one line Nova's prompt carries about the procedures she has, read
    from the table each turn; None when none is active — and then the prompt
    is byte-identical to a stack that has never had a skill.

    Bodies are NOT in it. She is told the names and what each was asked for,
    and reads one by calling the tool, which is what makes "she used a skill"
    a span rather than something inferred from the shape of a reply.
    """
    active = await list_all(pool, status=ACTIVE)
    if not active:
        return None
    parts = [f"{skill.name} — {skill.summary}{_scripted_clause(skill)}" for skill in active]
    head = (
        "Procedures you have written down, from times this worked before. Read one with "
        f"{LOAD_TOOL}(name) BEFORE starting, when it matches what is being asked"
    )
    # The scripted sentence appears only when one of them IS scripted. Telling
    # her about a verb with nothing to run is telling her about a capability
    # she cannot use, and it keeps an unscripted stack's prompt byte-identical
    # to what S17 shipped.
    if any(skill.script is not None for skill in active):
        head += (
            f"; a SCRIPTED one you run with {RUN_TOOL}(name, inputs) instead, and the backend "
            "does the steps"
        )
    return f"{head}: " + "; ".join(parts)


def _scripted_clause(skill: Skill) -> str:
    """What the roster says about a scripted skill: that it runs, and what it
    needs. A roster that named a scripted skill without naming its inputs
    would be telling her a call exists and withholding how to make it."""
    if skill.script is None:
        return ""
    declared = ((skill.inputs or {}).get("properties") or {}).items()
    shown = ", ".join(
        f"{key}{'[]' if (spec or {}).get('type') == 'array' else ''}" for key, spec in declared
    )
    return f" [SCRIPTED — {RUN_TOOL} inputs: {shown or 'none'}]"


async def load(pool: asyncpg.Pool, name: str, root: Path | None = None) -> tuple[Skill, str]:
    """The body of an ACTIVE skill, or a refusal that says which of the three
    things is wrong: no such skill, not active, or no file."""
    skill = await get(pool, name)
    if skill is None:
        known = [s.name for s in await list_all(pool, status=ACTIVE)]
        raise SkillUnavailable(
            f"there is no skill named {name!r} — active skills: {', '.join(known) or 'none'}"
        )
    if skill.status != ACTIVE:
        raise SkillUnavailable(
            f"the skill {name!r} is {skill.status}, not active, so it is not a procedure to follow"
        )
    body = body_text(name, root)
    if body is None:
        path = body_path(name, root)
        raise SkillUnavailable(
            f"the skill {name!r} has a row but its file is missing at {path} — "
            "nothing can be read for it"
        )
    return skill, body


async def withdrawn_statuses(pool: asyncpg.Pool, names: Sequence[str]) -> dict[str, str]:
    """Of those names, the ones that HAVE a row and are not active, mapped to
    the status they are in.

    A name with NO row is not withdrawn. An agent naming a skill file is what
    agents have had since S12, and a table added later must not silently take
    a working procedure out of an agent's prompt — the row is the thing that
    can withdraw one, so only a row can.
    """
    if not names:
        return {}
    records = await pool.fetch(
        "SELECT name, status FROM skills WHERE name = ANY($1::text[]) AND status <> $2",
        list(names),
        ACTIVE,
    )
    return {r["name"]: r["status"] for r in records}


# ── the ledger ─────────────────────────────────────────────────────────────

# A skill is flagged when this many of its last FLAG_WINDOW known-outcome uses
# were rough. Both numbers are a guess, which is why the threshold is a setting
# the owner can move (skills.flag_after_rough_uses) and why the transition is
# to FLAGGED — a raised hand — and never to retired.
FLAG_WINDOW = 5


def _rough(failed_calls: int, guard_fires: int) -> bool:
    return failed_calls > 0 or guard_fires > 0


def guard_fired(meta: dict) -> bool:
    """Did this guard span CORRECT something, or merely run?

    Most guard spans exist only because a guard fired — the span is filed
    inside the `if correction is not None` — so their presence is the fire.
    The responsiveness judge is the exception: it files a span whenever the
    check runs at all and says so on the span (`checked`), which is how it
    reports having looked.

    Reading every guard span as a fire made EVERY turn rough. Found on the
    S17 walk: the first real use of a skill, on a turn where nothing at all
    went wrong, was recorded as having gone badly — and five of those would
    have flagged the procedure. A span that says it merely checked is read
    here as what it says it is, and a future guard that wants the same
    treatment self-registers by writing the same marker.
    """
    if not meta.get("checked"):
        return True
    return bool(meta.get("redirected"))


async def record_uses(
    pool: asyncpg.Pool,
    turn_id: uuid.UUID,
    spans: Sequence[object],
    *,
    status: str | None,
) -> list[str]:
    """One row per skill this turn actually READ, with what the turn's own
    spans say happened afterwards. Returns the names recorded.

    A REFUSED load is not a use. She was handed no procedure, so counting it
    would let a skill be flagged for turns in which it was never read — the
    ledger would then be measuring the tool, not the skill.

    `status` is the turn's own: only a turn that ended `ok` has an outcome
    anybody watched. A stopped turn (S15) or one that died on a transport
    failure leaves an incomplete span record, and reading "no failures" off it
    is reading silence as success.
    """
    loaded: list[str] = []
    failed_calls = 0
    guard_fires = 0
    for span in spans:
        kind = getattr(span, "kind", None)
        meta = getattr(span, "meta", None) or {}
        if kind == "guard":
            if guard_fired(meta):
                guard_fires += 1
            continue
        if kind != "tool":
            continue
        ok = bool(meta.get("ok"))
        if getattr(span, "name", None) == LOAD_TOOL:
            if ok:
                # The arguments as the trace recorded them — the same evidence
                # the operator reads on the Activity page. A call that ran ok
                # passed schema validation, so the name is there and is a
                # string; anything else is a shape nothing should produce, and
                # it is logged rather than counted as a use of some other
                # skill.
                name = (meta.get("args_redacted") or {}).get("name")
                if isinstance(name, str) and name:
                    loaded.append(name)
                else:
                    logger.warning(
                        "a successful %s span on turn %s names no skill: %r",
                        LOAD_TOOL,
                        turn_id,
                        meta.get("args_redacted"),
                    )
            continue
        if not ok:
            failed_calls += 1
    if not loaded:
        return []
    known = status == "ok"
    written: list[str] = []
    for name in dict.fromkeys(loaded):
        skill = await get(pool, name)
        if skill is None:
            # Read during the turn and deleted before it closed. Nothing to
            # attach the use to, and inventing a row for a name is worse than
            # losing one count.
            continue
        await pool.execute(
            "INSERT INTO skill_uses (skill_id, turn_id, failed_calls, guard_fires, "
            "outcome_known) VALUES ($1, $2, $3, $4, $5)",
            skill.id,
            turn_id,
            failed_calls,
            guard_fires,
            known,
        )
        written.append(name)
    return written


async def review_flagging(
    pool: asyncpg.Pool, skill_id: uuid.UUID, *, threshold: int = 3
) -> Skill | None:
    """Flag an ACTIVE skill whose recent known-outcome uses went badly, and
    say in words which uses those were. Returns the moved row, or None when
    nothing moved.

    It never says a skill HELPED and it never retires one. What the counts
    support is "the turns this was read in kept going wrong", which is a
    reason for the owner to look, not a verdict about the procedure.
    """
    skill = await pool.fetchrow(f"SELECT {_COLUMNS} FROM skills WHERE id = $1", skill_id)
    if skill is None or skill["status"] != ACTIVE:
        return None
    records = await pool.fetch(
        "SELECT failed_calls, guard_fires FROM skill_uses "
        "WHERE skill_id = $1 AND outcome_known ORDER BY loaded_at DESC, id DESC LIMIT $2",
        skill_id,
        FLAG_WINDOW,
    )
    if len(records) < FLAG_WINDOW:
        # Fewer than a window of watched uses is not evidence about a skill,
        # it is a small sample — see [[one-sample-is-not-a-measurement]].
        return None
    rough = [r for r in records if _rough(r["failed_calls"], r["guard_fires"])]
    if len(rough) < threshold:
        return None
    calls = sum(r["failed_calls"] for r in rough)
    fires = sum(r["guard_fires"] for r in rough)
    reason = (
        f"{len(rough)} of the last {FLAG_WINDOW} watched uses went badly "
        f"({calls} failed tool call(s), {fires} guard correction(s))"
    )
    return await set_status(pool, skill["name"], FLAGGED, reason=reason)


# ── where the words come from ──────────────────────────────────────────────


def shape(names: Sequence[str]) -> list[str]:
    """The procedure inside a call list: consecutive repeats collapsed.

    Clearing four superseded notes is read, read, read, delete, delete,
    delete; the next time it is three notes. The procedure is the same, and a
    step list that counted the files would be a record of one afternoon rather
    than of how the thing is done.
    """
    out: list[str] = []
    for name in names:
        if not out or out[-1] != name:
            out.append(name)
    return out


async def steps_from_turns(pool: asyncpg.Pool, turn_ids: Sequence[uuid.UUID]) -> list[str]:
    """The shape of the MOST RECENT of those turns.

    Tool spans only: a guard firing and a model round are not steps in a
    procedure, and neither is a call that was never made. And the newest turn
    rather than all of them concatenated — a skill drafted from three walks of
    the same procedure describes the procedure once, not three times, and the
    latest walk is the one closest to how it is done now. Every source turn's
    own shape still reaches the body, so a walk that differed is visible to
    whoever reads the draft.
    """
    per_turn = await shapes_from_turns(pool, turn_ids)
    return per_turn[-1][1] if per_turn else []


async def shapes_from_turns(
    pool: asyncpg.Pool, turn_ids: Sequence[uuid.UUID]
) -> list[tuple[uuid.UUID, list[str]]]:
    """Each source turn's own shape, oldest first."""
    if not turn_ids:
        return []
    records = await pool.fetch(
        "SELECT s.turn_id, s.name FROM turn_spans s JOIN turns t ON t.id = s.turn_id "
        "WHERE s.turn_id = ANY($1::uuid[]) AND s.kind = 'tool' AND s.name IS NOT NULL "
        "ORDER BY t.started_at, s.turn_id, s.started_at, s.id",
        list(turn_ids),
    )
    per_turn: list[tuple[uuid.UUID, list[str]]] = []
    for record in records:
        if not per_turn or per_turn[-1][0] != record["turn_id"]:
            per_turn.append((record["turn_id"], []))
        per_turn[-1][1].append(record["name"])
    return [(turn_id, shape(names)) for turn_id, names in per_turn]


async def walks_with_args(
    pool: asyncpg.Pool, turn_ids: Sequence[uuid.UUID]
) -> list[list[tuple[str, dict]]]:
    """Each source turn's tool calls WITH the arguments they carried, oldest
    turn first (S18).

    `shapes_from_turns` answers the same question without the arguments,
    because a step list is about what was done and not with what. A derived
    script needs both, and it reads them from the same place: `args_redacted`
    on the span, which is the record the Activity page shows — so a script
    drafted here can only propose calls the trace says were actually made.

    A span whose arguments were clipped whole (the bounded-record path, a
    payload too large to store) carries a string rather than an object; it is
    skipped, because a step composed from a truncated record would be a guess
    wearing the clothes of evidence.
    """
    if not turn_ids:
        return []
    records = await pool.fetch(
        "SELECT s.turn_id, s.name, s.meta FROM turn_spans s JOIN turns t ON t.id = s.turn_id "
        "WHERE s.turn_id = ANY($1::uuid[]) AND s.kind = 'tool' AND s.name IS NOT NULL "
        "ORDER BY t.started_at, s.turn_id, s.started_at, s.id",
        list(turn_ids),
    )
    walks: list[list[tuple[str, dict]]] = []
    seen: list[uuid.UUID] = []
    for record in records:
        args = (record["meta"] or {}).get("args_redacted")
        if not isinstance(args, dict):
            continue
        if not seen or seen[-1] != record["turn_id"]:
            seen.append(record["turn_id"])
            walks.append([])
        walks[-1].append((record["name"], args))
    return [walk for walk in walks if walk]


async def requests_from_turns(
    pool: asyncpg.Pool, turn_ids: Sequence[uuid.UUID]
) -> list[tuple[datetime, str]]:
    """The request each source turn ANSWERED, with its instant. His side only —
    an assistant row is her account of what he wanted, and a summary built out
    of it would be a paraphrase standing in for the request.

    Found by CONVERSATION AND TIME, not by messages.turn_id, because a user
    row never carries one: migration 018 added that column for the assistant
    row's served-by badge and says in as many words that "user messages have no
    turn". Reading it here returned nothing for every real turn, and the first
    draft composed on the live stack said "asked as: (no request recorded)" —
    the roster's whole matching signal, empty. The unit test had passed because
    its fixture stamped the column the product does not stamp.

    So: the newest user row in that turn's conversation at or before the turn
    opened, which is the row chat_stream inserts immediately before
    traces.open_turn. A turn whose conversation is gone, or that answered
    nothing a person typed (a beat, a scheduled firing), contributes nothing
    rather than borrowing somebody else's sentence.
    """
    if not turn_ids:
        return []
    records = await pool.fetch(
        "SELECT DISTINCT ON (t.id) t.id, t.started_at AS turn_started, "
        "m.created_at, m.content FROM turns t "
        "JOIN messages m ON m.conversation_id = t.conversation_id "
        "AND m.role = 'user' AND m.created_at <= t.started_at "
        "WHERE t.id = ANY($1::uuid[]) "
        "ORDER BY t.id, m.created_at DESC, m.id DESC",
        list(turn_ids),
    )
    ordered = sorted(records, key=lambda r: r["turn_started"])
    return [(r["created_at"], r["content"]) for r in ordered]


def _one_line(text: str, limit: int = 160) -> str:
    flat = " ".join(text.split())
    return flat if len(flat) <= limit else flat[: limit - 1] + "…"


def compose_title(step_names: Sequence[str]) -> str:
    """A title from the sequence itself. Plain and a little ugly, which is
    right: it is a placeholder the owner is expected to improve, and it never
    claims to know what the procedure is FOR."""
    return " → ".join(step_names)


def compose_summary(requests: Iterable[tuple[datetime, str]]) -> str:
    """The roster line's right-hand side: how he asked, in his words, dated."""
    quoted = [f"'{_one_line(text, 90)}' ({at.date().isoformat()})" for at, text in requests]
    return "asked as: " + "; ".join(quoted) if quoted else "asked as: (no request recorded)"


def compose_body(
    *,
    title: str,
    requests: Sequence[tuple[datetime, str]],
    step_names: Sequence[str],
    other_walks: Sequence[Sequence[str]] = (),
) -> str:
    """The draft file. Every line of it is quoted or counted from the record,
    and it says so — the owner reading this should be able to tell at a glance
    which parts nobody wrote."""
    lines = [
        f"# {title}",
        "",
        "Drafted from the trace. Every line below is read from the record: the steps are the "
        "tool calls those turns made, the requests are quoted from the messages. Nothing here "
        "was written by a model. Edit it freely — this file is the procedure.",
        "",
        "## Asked as",
        "",
    ]
    lines += [f"- {at.date().isoformat()}: {_one_line(text, 200)}" for at, text in requests]
    lines += ["", "## Steps that were taken", ""]
    lines += [f"{i}. `{name}`" for i, name in enumerate(step_names, start=1)]
    differing = [walk for walk in other_walks if list(walk) != list(step_names)]
    if differing:
        # An earlier walk that did it differently is not noise to tidy away:
        # it is the evidence that the procedure above is one version of the
        # thing, and the owner is the one who decides which is right.
        lines += ["", "Earlier walks that went differently:", ""]
        lines += [f"- {', '.join(walk)}" for walk in differing]
    lines += ["", "## Notes", "", "(none yet)", ""]
    return "\n".join(lines)


async def draft_from_turns(
    pool: asyncpg.Pool,
    *,
    name: str,
    turn_ids: Sequence[uuid.UUID],
    created_via: str,
    root: Path | None = None,
) -> Skill:
    """Compose a draft out of what those turns did, and store it.

    Refuses a turn set with no tool spans in it. A skill whose step list is
    empty is a procedure that describes nothing, and it would sit in the page
    looking like knowledge.
    """
    walks = await shapes_from_turns(pool, turn_ids)
    if not walks:
        raise ValueError(
            "those turns ran no tool calls, so there is no procedure in them to write down"
        )
    step_names = walks[-1][1]
    requests = await requests_from_turns(pool, turn_ids)
    title = compose_title(step_names)
    return await create(
        pool,
        name=name,
        title=title,
        summary=compose_summary(requests),
        created_via=created_via,
        body=compose_body(
            title=title,
            requests=requests,
            step_names=step_names,
            other_walks=[steps for _, steps in walks[:-1]],
        ),
        source_turn_ids=list(turn_ids),
        step_names=step_names,
        root=root,
    )


# ── the trial ──────────────────────────────────────────────────────────────

# The suite a trial's two runs are filed under. They are NOT corpus cases —
# they are composed from one skill's own source request and thrown away — so
# they carry their own suite name and never move suite_version.
TRIAL_SUITE = "skill_trial"


async def trial(app, pool: asyncpg.Pool, name: str, model: str) -> dict:
    """Run the skill's own first request twice — once with it active, once
    without — and report what the two turns DID.

    This is not a measurement of quality and the page says so. Two runs of one
    request is a sample of one on each side ([[one-sample-is-not-a-measurement]]),
    the model is non-deterministic, and no threshold here promotes anything:
    the owner reads the two columns and decides. What it does buy is the one
    thing a procedure's page cannot otherwise show — whether having the
    procedure changed what the turn did at all.

    Everything reported is read from `turn_spans` afterwards, by turn id. The
    reply is not consulted: a turn that SAYS it followed the procedure and
    called nothing is exactly the case this is here to expose.
    """
    from app.evals import cases as cases_mod
    from app.evals import runner as eval_runner

    skill = await get(pool, name)
    if skill is None:
        raise ValueError(f"no skill named {name!r}")
    requests = await requests_from_turns(pool, skill.source_turn_ids)
    if not requests:
        raise ValueError(
            f"the skill {name!r} has no source request to replay — it was written by hand, so "
            "there is no turn to run again"
        )
    message = requests[0][1]

    def _case(with_skill: bool) -> cases_mod.Case:
        return cases_mod.Case(
            id=f"skill-trial:{name}:{'with' if with_skill else 'without'}",
            suite=TRIAL_SUITE,
            suite_version=0,
            message=message,
            # A contract is required and this one is honest for both sides: a
            # turn that made an unbacked claim went badly whether or not it
            # had a procedure to follow.
            contract=(cases_mod.PredicateSpec(predicate="guard_absent", arg="narration"),),
            # Declared by NAME and with no body: this row already exists, so
            # the runner activates it and puts its status back rather than
            # creating and deleting the owner's own skill.
            skills=(cases_mod.FixtureSkill(name=name),) if with_skill else (),
        )

    sides = {}
    for with_skill in (True, False):
        run = await eval_runner.run_case(app, pool, _case(with_skill), model)
        sides["with" if with_skill else "without"] = {
            **await _turn_facts(pool, run.turn_id),
            "ungradeable": run.ungradeable,
            "no_unbacked_claim": run.passed,
            "turn_id": str(run.turn_id) if run.turn_id else None,
        }
    return {"skill": name, "model": model, "message": message, "sides": sides}


async def _turn_facts(pool: asyncpg.Pool, turn_id: uuid.UUID | None) -> dict:
    """What one trial turn actually did, off its spans."""
    if turn_id is None:
        return {"calls": None, "failed_calls": None, "read_the_skill": None, "seconds": None}
    spans = await pool.fetch(
        "SELECT kind, name, duration_ms, meta FROM turn_spans WHERE turn_id = $1", turn_id
    )
    tools_run = [s for s in spans if s["kind"] == "tool"]
    return {
        "calls": len(tools_run),
        "failed_calls": sum(1 for s in tools_run if not (s["meta"] or {}).get("ok")),
        "read_the_skill": any(
            s["name"] == LOAD_TOOL and (s["meta"] or {}).get("ok") for s in tools_run
        ),
        "guard_fires": sum(
            1 for s in spans if s["kind"] == "guard" and guard_fired(s["meta"] or {})
        ),
        "seconds": round(sum((s["duration_ms"] or 0) for s in spans) / 1000, 2),
    }
