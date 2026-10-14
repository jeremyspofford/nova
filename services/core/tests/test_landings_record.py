"""Her landings as rows (S32.3 T1): migration 050's `landings` table and
app/landings.py, its one writer — a `running` row written when repo_land
starts, fields set while it runs, a terminal verdict that is never
rewritten, the publish of a green landing recorded on its own, the newest
landing per change for list_changes, and a restart that never leaves a
landing `running` (docs/plans/rebuild/s32/spec.md §5.3)."""

from __future__ import annotations

import uuid
from pathlib import Path

import asyncpg
import pytest

from app import landings
from tests.conftest import _TABLES, requires_db

pytestmark = requires_db

_MIGRATION = Path(__file__).resolve().parents[1] / "migrations/050_landings.sql"
SHA = "a" * 40
SHA2 = "b" * 40
SHA256 = "c" * 64


async def _turn(pool) -> uuid.UUID:
    return await pool.fetchval(
        "INSERT INTO turns (kind, conversation_id, model) VALUES ('chat', NULL, 'm') RETURNING id"
    )


async def _land(pool, **kw) -> uuid.UUID:
    args = {
        "change_id": "ab12cd",
        "repo": "nova",
        "branch": "nova/ab12cd-iso-week",
        "turn_id": None,
        "author": "Nova <nova@hub>",
        "coder": "nova-loop m",
        "commit_sha": None,
        "stage": "queued",
    }
    args.update(kw)
    return await landings.insert(pool, **args)


async def _row(pool, landing_id) -> dict:
    return dict(await pool.fetchrow("SELECT * FROM landings WHERE id = $1", landing_id))


async def _insert_raw(pool, **over):
    cols = {
        "change_id": "ab12cd",
        "repo": "nova",
        "branch": "nova/ab12cd-x",
        "verdict": "running",
    }
    cols.update(over)
    names = ", ".join(cols)
    marks = ", ".join(f"${i}" for i in range(1, len(cols) + 1))
    await pool.execute(f"INSERT INTO landings ({names}) VALUES ({marks})", *cols.values())


# -- C1: the table -----------------------------------------------------------


async def test_c1_the_migration_is_050_after_049():
    names = sorted(p.name for p in _MIGRATION.parent.glob("*.sql"))
    assert _MIGRATION.name in names
    assert names[names.index(_MIGRATION.name) - 1] == "049_tool_results.sql"
    assert sum(1 for n in names if n.startswith("050_")) == 1


async def test_c1_the_table_has_every_column(pool):
    cols = {
        r["column_name"]: r["data_type"]
        for r in await pool.fetch(
            "SELECT column_name, data_type FROM information_schema.columns "
            "WHERE table_name = 'landings'"
        )
    }
    assert cols == {
        "id": "uuid",
        "change_id": "text",
        "repo": "text",
        "branch": "text",
        "base_sha": "text",
        "commit_sha": "text",
        "author": "text",
        "coder": "text",
        "turn_id": "uuid",
        "verdict": "text",
        "stage": "text",
        "reason": "text",
        "suites": "jsonb",
        "protected": "ARRAY",
        "dirty_outside": "ARRAY",
        "conflict_files": "ARRAY",
        "patch": "text",
        "patch_truncated": "boolean",
        "merged_sha": "text",
        "pr_url": "text",
        "push_result": "text",
        "judge_id": "text",
        "created_at": "timestamp with time zone",
        "finished_at": "timestamp with time zone",
        "updated_at": "timestamp with time zone",
    }


async def test_c1_the_migration_runs_a_second_time(pool):
    await pool.execute(_MIGRATION.read_text())


def test_c1_conftest_drops_and_truncates_landings_ahead_of_turns():
    assert "landings" in _TABLES
    assert _TABLES.index("landings") < _TABLES.index("turns")


# -- C2: the database refuses a bad row ---------------------------------------


@pytest.mark.parametrize(
    "over",
    [
        {"change_id": "AB12CD"},
        {"change_id": "ab12c"},
        {"change_id": "../ab1"},
        {"judge_id": "zz12cd"},
        # finished_at set so only the verdict set can refuse it (not the
        # finished-iff-terminal CHECK)
        {"verdict": "passed", "finished_at": "now"},
        {"commit_sha": "abc"},
        {"base_sha": "A" * 40},
        {"merged_sha": SHA, "verdict": "red", "finished_at": "now"},
        {"merged_sha": SHA},
        {"merged_sha": "short", "verdict": "green", "finished_at": "now"},
        {"verdict": "green"},
        {"finished_at": "now"},
        {"suites": {"core": 0}},
    ],
)
async def test_c2_the_database_refuses_a_bad_row(pool, over):
    if over.get("finished_at") == "now":
        over["finished_at"] = await pool.fetchval("SELECT now()")
    with pytest.raises(asyncpg.CheckViolationError):
        await _insert_raw(pool, **over)
    assert await pool.fetchval("SELECT count(*) FROM landings") == 0


async def test_c2_a_good_raw_row_is_accepted(pool):
    now = await pool.fetchval("SELECT now()")
    await _insert_raw(
        pool,
        verdict="green",
        finished_at=now,
        merged_sha=SHA256,
        commit_sha=SHA,
        base_sha=SHA2,
        judge_id="0f0f0f",
        suites=[{"suite": "core", "exit": 0}],
    )
    assert await pool.fetchval("SELECT count(*) FROM landings") == 1


async def test_c2_a_deleted_turn_leaves_the_landing_with_no_turn(pool):
    turn = await _turn(pool)
    lid = await _land(pool, turn_id=turn)
    await pool.execute("DELETE FROM turns WHERE id = $1", turn)
    assert (await _row(pool, lid))["turn_id"] is None


# -- C3: insert ----------------------------------------------------------------


async def test_c3_insert_writes_a_running_row_and_returns_a_fresh_id(pool):
    turn = await _turn(pool)
    lid = await _land(pool, turn_id=turn, commit_sha=SHA)
    assert isinstance(lid, uuid.UUID)
    other = await _land(pool)
    assert other != lid
    row = await _row(pool, lid)
    assert row["verdict"] == "running"
    assert row["change_id"] == "ab12cd"
    assert row["repo"] == "nova"
    assert row["branch"] == "nova/ab12cd-iso-week"
    assert row["turn_id"] == turn
    assert row["author"] == "Nova <nova@hub>"
    assert row["coder"] == "nova-loop m"
    assert row["commit_sha"] == SHA
    assert row["stage"] == "queued"
    assert row["suites"] == []
    assert row["finished_at"] is None and row["merged_sha"] is None
    assert row["created_at"] is not None and row["updated_at"] is not None


@pytest.mark.parametrize("bad", ["AB12CD", "ab12c", "", "../x12", None])
async def test_c3_a_malformed_change_id_raises_and_writes_nothing(pool, bad):
    with pytest.raises(ValueError):
        await _land(pool, change_id=bad)
    assert await pool.fetchval("SELECT count(*) FROM landings") == 0


# -- C4: update ----------------------------------------------------------------


async def test_c4_update_sets_fields_while_running(pool):
    lid = await _land(pool)
    suites = [{"suite": "core", "exit": 0, "passed": 3, "failed": 0, "skipped": None}]
    moved = await landings.update(
        pool,
        lid,
        stage="judging",
        base_sha=SHA2,
        commit_sha=SHA,
        suites=suites,
        protected=["install"],
        dirty_outside=["notes.txt"],
        patch="diff --git a b\n",
        patch_truncated=True,
        judge_id="0a0b0c",
    )
    assert moved is True
    row = await _row(pool, lid)
    assert row["stage"] == "judging"
    assert row["base_sha"] == SHA2 and row["commit_sha"] == SHA
    assert row["suites"] == suites
    assert row["protected"] == ["install"]
    assert row["dirty_outside"] == ["notes.txt"]
    assert row["patch"] == "diff --git a b\n"
    assert row["patch_truncated"] is True
    assert row["judge_id"] == "0a0b0c"
    assert row["verdict"] == "running"


@pytest.mark.parametrize("field", ["verdict", "merged_sha", "finished_at", "id", "nope"])
async def test_c4_update_refuses_a_field_it_does_not_own(pool, field):
    lid = await _land(pool)
    with pytest.raises(ValueError):
        await landings.update(pool, lid, **{field: "x"})
    assert (await _row(pool, lid))["verdict"] == "running"


async def test_c4_update_does_not_move_a_finished_row(pool):
    lid = await _land(pool)
    await landings.finish(pool, lid, "red", reason="core failed")
    assert await landings.update(pool, lid, stage="judging") is False
    assert (await _row(pool, lid))["stage"] == "queued"


async def test_c4_nul_in_text_is_replaced_not_refused(pool):
    lid = await _land(pool)
    assert await landings.update(pool, lid, patch="bin\x00ary", reason="r\x00")
    row = await _row(pool, lid)
    assert row["patch"] == "bin�ary"
    assert row["reason"] == "r�"


# -- C5: finish / record_publish / append_reason --------------------------------


async def test_c5_finish_sets_a_terminal_verdict_and_its_time(pool):
    lid = await _land(pool)
    await landings.finish(
        pool,
        lid,
        "conflict",
        reason="rebase onto main conflicted",
        conflict_files=["services/core/app/tools/time.py"],
        stage="rebase",
    )
    row = await _row(pool, lid)
    assert row["verdict"] == "conflict"
    assert row["finished_at"] is not None
    assert row["reason"] == "rebase onto main conflicted"
    assert row["conflict_files"] == ["services/core/app/tools/time.py"]
    assert row["merged_sha"] is None


@pytest.mark.parametrize("verdict", ["running", "passed", ""])
async def test_c5_finish_refuses_a_verdict_that_is_not_terminal(pool, verdict):
    lid = await _land(pool)
    with pytest.raises(ValueError):
        await landings.finish(pool, lid, verdict)
    assert (await _row(pool, lid))["verdict"] == "running"


async def test_c5_finish_refuses_an_unknown_landing(pool):
    with pytest.raises(ValueError, match="no landing"):
        await landings.finish(pool, uuid.uuid4(), "red")


async def test_c5_finish_never_rewrites_a_finished_verdict(pool):
    lid = await _land(pool)
    await landings.finish(pool, lid, "red", reason="core failed")
    with pytest.raises(ValueError, match="already red"):
        await landings.finish(pool, lid, "green")
    row = await _row(pool, lid)
    assert row["verdict"] == "red" and row["reason"] == "core failed"


@pytest.mark.parametrize("verdict", ["red", "could_not_measure", "conflict"])
async def test_c5_only_a_green_landing_carries_a_merged_sha(pool, verdict):
    lid = await _land(pool)
    with pytest.raises(ValueError):
        await landings.finish(pool, lid, verdict, merged_sha=SHA)
    assert (await _row(pool, lid))["verdict"] == "running"


async def test_c5_a_green_finish_may_carry_the_publish(pool):
    lid = await _land(pool)
    await landings.finish(
        pool, lid, "green", merged_sha=SHA, pr_url="https://x/pull/1", push_result="pushed"
    )
    row = await _row(pool, lid)
    assert (row["verdict"], row["merged_sha"], row["pr_url"], row["push_result"]) == (
        "green",
        SHA,
        "https://x/pull/1",
        "pushed",
    )


async def test_c5_record_publish_writes_only_a_green_unpublished_row(pool):
    green = await _land(pool)
    await landings.finish(pool, green, "green")
    assert await landings.record_publish(
        pool, green, merged_sha=SHA, pr_url="https://x/pull/2", push_result="main fast-forwarded"
    )
    row = await _row(pool, green)
    assert (row["merged_sha"], row["pr_url"], row["push_result"]) == (
        SHA,
        "https://x/pull/2",
        "main fast-forwarded",
    )
    # published once: a second publish does not overwrite it
    assert not await landings.record_publish(pool, green, merged_sha=SHA2, push_result="again")
    assert (await _row(pool, green))["merged_sha"] == SHA

    red = await _land(pool)
    await landings.finish(pool, red, "red")
    assert not await landings.record_publish(pool, red, merged_sha=SHA, push_result="x")
    running = await _land(pool)
    assert not await landings.record_publish(pool, running, merged_sha=SHA, push_result="x")
    assert (await _row(pool, red))["merged_sha"] is None
    assert (await _row(pool, running))["merged_sha"] is None


async def test_c5_a_failed_publish_is_recorded_without_a_merged_sha(pool):
    lid = await _land(pool)
    await landings.finish(pool, lid, "green")
    assert await landings.record_publish(
        pool, lid, merged_sha=None, push_result="push to main refused: main moved"
    )
    row = await _row(pool, lid)
    assert row["merged_sha"] is None
    assert row["push_result"] == "push to main refused: main moved"
    # a failed publish is final: a later publish does not turn it merged
    assert not await landings.record_publish(
        pool, lid, merged_sha=SHA, pr_url="https://x/pull/9", push_result="main fast-forwarded"
    )
    row = await _row(pool, lid)
    assert row["merged_sha"] is None
    assert row["pr_url"] is None
    assert row["push_result"] == "push to main refused: main moved"


async def test_c5_a_publish_carried_by_finish_is_not_recorded_again(pool):
    lid = await _land(pool)
    await landings.finish(pool, lid, "green", merged_sha=SHA)
    assert not await landings.record_publish(pool, lid, merged_sha=SHA2, push_result="again")
    row = await _row(pool, lid)
    assert row["merged_sha"] == SHA
    assert row["push_result"] is None


async def test_c5_append_reason_adds_to_any_row(pool):
    lid = await _land(pool)
    await landings.finish(pool, lid, "red", reason="core failed")
    assert await landings.append_reason(pool, lid, "judge box nova-box-0a0b0c left behind")
    row = await _row(pool, lid)
    assert row["reason"] == "core failed; judge box nova-box-0a0b0c left behind"
    other = await _land(pool)
    assert await landings.append_reason(pool, other, "first")
    assert (await _row(pool, other))["reason"] == "first"
    assert not await landings.append_reason(pool, uuid.uuid4(), "x")


# -- C6: get / last_per_change --------------------------------------------------


async def test_c6_get_returns_the_row_or_none(pool):
    lid = await _land(pool)
    row = await landings.get(pool, lid)
    assert row["id"] == lid and row["verdict"] == "running"
    assert (await landings.get(pool, str(lid)))["id"] == lid
    assert await landings.get(pool, uuid.uuid4()) is None
    assert await landings.get(pool, "not-a-uuid") is None
    assert await landings.get(pool, None) is None


async def test_c6_last_per_change_is_the_newest_landing_of_each_asked_change(pool):
    old = await _land(pool, change_id="aaaaaa")
    await landings.finish(pool, old, "red")
    new = await _land(pool, change_id="aaaaaa")
    await pool.execute(
        "UPDATE landings SET created_at = created_at - interval '1 hour' WHERE id = $1", old
    )
    other = await _land(pool, change_id="bbbbbb")
    await _land(pool, change_id="cccccc")
    got = await landings.last_per_change(pool, ["aaaaaa", "bbbbbb", "dddddd"])
    assert set(got) == {"aaaaaa", "bbbbbb"}
    assert got["aaaaaa"]["id"] == new
    assert got["bbbbbb"]["id"] == other
    assert await landings.last_per_change(pool, []) == {}


# -- C7: mark_interrupted -------------------------------------------------------


async def test_c7_a_restart_never_leaves_a_landing_running(pool):
    a = await _land(pool, change_id="aaaaaa")
    b = await _land(pool, change_id="bbbbbb")
    done = await _land(pool, change_id="cccccc")
    await landings.finish(pool, done, "red", reason="core failed")
    assert await landings.mark_interrupted(pool) == 2
    for lid in (a, b):
        row = await _row(pool, lid)
        assert row["verdict"] == "could_not_measure"
        assert row["finished_at"] is not None
        assert "core restarted during the landing" in row["reason"]
        assert row["merged_sha"] is None
    row = await _row(pool, done)
    assert row["verdict"] == "red" and row["reason"] == "core failed"
    assert await landings.mark_interrupted(pool) == 0
