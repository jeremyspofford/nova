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

CREATED_VIA = ("beat", "page")

# The tool that reads a body. Named here as a constant because the roster line
# tells her how to use it: a rename moves that sentence instead of leaving the
# prompt naming a tool that no longer exists.
LOAD_TOOL = "load_skill"

_COLUMNS = (
    "id, name, title, summary, status, created_via, source_turn_ids, step_names, "
    "flagged_reason, created_at, updated_at"
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
    _write_body(name, body, root)
    record = await pool.fetchrow(
        "INSERT INTO skills (name, title, summary, created_via, source_turn_ids, step_names) "
        f"VALUES ($1, $2, $3, $4, $5, $6) RETURNING {_COLUMNS}",
        name,
        title.strip(),
        summary.strip(),
        created_via,
        list(source_turn_ids),
        list(step_names),
    )
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
    parts = [f"{skill.name} — {skill.summary}" for skill in active]
    return (
        "Procedures you have written down, from times this worked before. Read one with "
        f"{LOAD_TOOL}(name) BEFORE starting, when it matches what is being asked: "
        + "; ".join(parts)
    )


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


# ── where the words come from ──────────────────────────────────────────────


async def steps_from_turns(pool: asyncpg.Pool, turn_ids: Sequence[uuid.UUID]) -> list[str]:
    """The tool calls those turns actually made, in the order the ledger has
    them. Tool spans only: a guard firing and a model round are not steps in a
    procedure, and neither is a call that was never made."""
    if not turn_ids:
        return []
    records = await pool.fetch(
        "SELECT name FROM turn_spans WHERE turn_id = ANY($1::uuid[]) AND kind = 'tool' "
        "AND name IS NOT NULL ORDER BY started_at, id",
        list(turn_ids),
    )
    return [r["name"] for r in records]


async def requests_from_turns(
    pool: asyncpg.Pool, turn_ids: Sequence[uuid.UUID]
) -> list[tuple[datetime, str]]:
    """The USER message of each source turn, with its instant. His side only —
    an assistant row is her account of what he wanted, and a summary built out
    of it would be a paraphrase standing in for the request."""
    if not turn_ids:
        return []
    records = await pool.fetch(
        "SELECT m.created_at, m.content FROM messages m "
        "WHERE m.turn_id = ANY($1::uuid[]) AND m.role = 'user' ORDER BY m.created_at, m.id",
        list(turn_ids),
    )
    return [(r["created_at"], r["content"]) for r in records]


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
    *, title: str, requests: Sequence[tuple[datetime, str]], step_names: Sequence[str]
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
    step_names = await steps_from_turns(pool, turn_ids)
    if not step_names:
        raise ValueError(
            "those turns ran no tool calls, so there is no procedure in them to write down"
        )
    requests = await requests_from_turns(pool, turn_ids)
    title = compose_title(step_names)
    return await create(
        pool,
        name=name,
        title=title,
        summary=compose_summary(requests),
        created_via=created_via,
        body=compose_body(title=title, requests=requests, step_names=step_names),
        source_turn_ids=list(turn_ids),
        step_names=step_names,
        root=root,
    )
