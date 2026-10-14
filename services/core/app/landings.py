"""Her landings as rows (S32.3 T1): migration 050's `landings`.

One writer. repo_land `insert`s a `running` row before anything is judged;
the landing run sets what it learns with `update` while the row is running
(stage, SHAs, suites, protected/dirty_outside, the patch, the judge id);
`finish` moves it to exactly one terminal verdict — green, red,
could_not_measure or conflict — and a finished verdict is never rewritten.
A green landing's publish (merged SHA, PR, push result) is stored by
`record_publish` once, after the verdict, so a publish that dies part-way
never loses the verdict it was publishing. `mark_interrupted` runs at core
startup: a landing's task never survives a restart, so a row left `running`
is could_not_measure, stated — never left running, never green
(docs/plans/rebuild/s32/spec.md §5.3).

Only a green row carries a merged SHA: finish refuses it here, and the
table's CHECK refuses it whatever code tried.
"""

from __future__ import annotations

import re
import uuid
from collections.abc import Iterable

TERMINAL_VERDICTS = ("green", "red", "could_not_measure", "conflict")
INTERRUPTED = "core restarted during the landing; land again"

_CHANGE = re.compile(r"^[0-9a-f]{6}$")

# What update() (and finish()) may set. verdict, merged_sha, pr_url,
# push_result and the timestamps each have their own one path.
_UPDATABLE = frozenset(
    {
        "stage",
        "reason",
        "base_sha",
        "commit_sha",
        "author",
        "coder",
        "suites",
        "protected",
        "dirty_outside",
        "conflict_files",
        "patch",
        "patch_truncated",
        "judge_id",
    }
)


def valid_change(change_id: object) -> bool:
    return isinstance(change_id, str) and _CHANGE.fullmatch(change_id) is not None


def _as_uuid(value: object) -> uuid.UUID | None:
    if isinstance(value, uuid.UUID):
        return value
    if not isinstance(value, str):
        return None
    try:
        return uuid.UUID(value)
    except ValueError:
        return None


def _clean(value):
    """Postgres text and jsonb refuse NUL; a patch, a log tail or a reason
    may carry one. Replace it (U+FFFD) rather than lose the rest."""
    if isinstance(value, str):
        return value.replace("\x00", "�")
    if isinstance(value, list):
        return [_clean(v) for v in value]
    if isinstance(value, dict):
        return {_clean(k): _clean(v) for k, v in value.items()}
    return value


def _fields(fields: dict) -> dict:
    unknown = sorted(set(fields) - _UPDATABLE)
    if unknown:
        raise ValueError(f"a landing's {', '.join(unknown)} is not set this way")
    return {k: _clean(v) for k, v in fields.items()}


def _sets(fields: dict, start: int) -> tuple[list[str], list]:
    clauses = [f"{name} = ${start + i}" for i, name in enumerate(fields)]
    return clauses, list(fields.values())


async def insert(
    pool,
    *,
    change_id: str,
    repo: str,
    branch: str,
    turn_id: uuid.UUID | str | None,
    author: str | None = None,
    coder: str | None = None,
    commit_sha: str | None = None,
    stage: str | None = None,
) -> uuid.UUID:
    """Write a `running` landing and return its new id. Raises ValueError
    (nothing written) for a change id that is not 6 lowercase hex, or an
    empty repo or branch."""
    if not valid_change(change_id):
        raise ValueError("change is 6 lowercase hex (the id start_change returned)")
    for name, value in (("repo", repo), ("branch", branch)):
        if not isinstance(value, str) or not value:
            raise ValueError(f"{name} is a non-empty string")
    turn = _as_uuid(turn_id) if turn_id is not None else None
    if turn_id is not None and turn is None:
        raise ValueError("turn_id is a uuid")
    return await pool.fetchval(
        "INSERT INTO landings (change_id, repo, branch, turn_id, author, coder, commit_sha, "
        "stage) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id",
        change_id,
        _clean(repo),
        _clean(branch),
        turn,
        _clean(author),
        _clean(coder),
        commit_sha,
        _clean(stage),
    )


async def update(pool, landing_id: uuid.UUID | str, **fields) -> bool:
    """Set `fields` on a landing while it is still running. True when the
    row moved; False for an unknown or finished landing (a finished
    landing is never edited). Raises ValueError for a field this does not
    own (verdict, merged_sha, ...) or no field at all."""
    values = _fields(fields)
    if not values:
        raise ValueError("nothing to update")
    lid = _as_uuid(landing_id)
    if lid is None:
        return False
    clauses, args = _sets(values, 2)
    status = await pool.execute(
        f"UPDATE landings SET {', '.join(clauses)}, updated_at = now() "
        "WHERE id = $1 AND verdict = 'running'",
        lid,
        *args,
    )
    return status != "UPDATE 0"


async def finish(
    pool,
    landing_id: uuid.UUID | str,
    verdict: str,
    *,
    merged_sha: str | None = None,
    pr_url: str | None = None,
    push_result: str | None = None,
    **fields,
) -> None:
    """Move a running landing to its terminal `verdict`, with `fields`
    (as update) and, for a green one only, its publish. Raises ValueError,
    nothing written, for a verdict that is not terminal, a merged SHA on
    anything but green, an unknown landing, or one already finished — a
    verdict is recorded once."""
    if verdict not in TERMINAL_VERDICTS:
        raise ValueError(f"verdict is one of {', '.join(TERMINAL_VERDICTS)}")
    if merged_sha is not None and verdict != "green":
        raise ValueError(f"a {verdict} landing is never merged; only green carries a merged SHA")
    values = _fields(fields)
    values_all = {
        **values,
        "merged_sha": merged_sha,
        "pr_url": _clean(pr_url),
        "push_result": _clean(push_result),
    }
    lid = _as_uuid(landing_id)
    if lid is None:
        raise ValueError(f"no landing {str(landing_id)[:40]!r}")
    clauses, args = _sets(values_all, 3)
    status = await pool.execute(
        f"UPDATE landings SET verdict = $2, {', '.join(clauses)}, finished_at = now(), "
        "updated_at = now() WHERE id = $1 AND verdict = 'running'",
        lid,
        verdict,
        *args,
    )
    if status != "UPDATE 0":
        return
    current = await pool.fetchval("SELECT verdict FROM landings WHERE id = $1", lid)
    if current is None:
        raise ValueError(f"no landing {lid}")
    raise ValueError(f"landing {lid} is already {current}; a verdict is recorded once")


async def record_publish(
    pool,
    landing_id: uuid.UUID | str,
    *,
    merged_sha: str | None,
    pr_url: str | None = None,
    push_result: str,
) -> bool:
    """Store a green landing's publish: the merged SHA (None when the
    publish did not put it on main), the PR and what the push did. Only on
    a green row not yet published — a publish is recorded once. True when
    the row moved."""
    lid = _as_uuid(landing_id)
    if lid is None:
        return False
    status = await pool.execute(
        "UPDATE landings SET merged_sha = $2, pr_url = $3, push_result = $4, "
        "updated_at = now() WHERE id = $1 AND verdict = 'green' "
        "AND merged_sha IS NULL AND push_result IS NULL",
        lid,
        merged_sha,
        _clean(pr_url),
        _clean(push_result),
    )
    return status != "UPDATE 0"


async def append_reason(pool, landing_id: uuid.UUID | str, text: str) -> bool:
    """Add `text` to a landing's reason, finished or not (the close step's
    notes: a box left behind). True when the row exists."""
    lid = _as_uuid(landing_id)
    if lid is None:
        return False
    status = await pool.execute(
        "UPDATE landings SET reason = CASE WHEN coalesce(reason, '') = '' THEN $2 "
        "ELSE reason || '; ' || $2 END, updated_at = now() WHERE id = $1",
        lid,
        _clean(text),
    )
    return status != "UPDATE 0"


async def get(pool, landing_id: object) -> dict | None:
    """The landing `landing_id`, or None (unknown or not a uuid)."""
    lid = _as_uuid(landing_id)
    if lid is None:
        return None
    row = await pool.fetchrow("SELECT * FROM landings WHERE id = $1", lid)
    return dict(row) if row is not None else None


async def last_per_change(pool, change_ids: Iterable[str]) -> dict[str, dict]:
    """{change id: its newest landing} for the asked changes that have one."""
    ids = [c for c in change_ids if valid_change(c)]
    if not ids:
        return {}
    rows = await pool.fetch(
        "SELECT DISTINCT ON (change_id) * FROM landings WHERE change_id = ANY($1::text[]) "
        "ORDER BY change_id, created_at DESC, id",
        ids,
    )
    return {r["change_id"]: dict(r) for r in rows}


async def mark_interrupted(pool) -> int:
    """At startup: every landing still `running` lost its task with the
    process that ran it — could_not_measure, saying so. Returns how many."""
    status = await pool.execute(
        "UPDATE landings SET verdict = 'could_not_measure', finished_at = now(), "
        "updated_at = now(), reason = CASE WHEN coalesce(reason, '') = '' THEN $1 "
        "ELSE reason || '; ' || $1 END WHERE verdict = 'running'",
        INTERRUPTED,
    )
    return int(status.split()[-1])
