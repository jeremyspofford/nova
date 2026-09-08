"""The timers store: rows are created validated, paused with a reason, resumed
by the rule, deleted for real; jobs come from JOBS and nowhere else."""
from __future__ import annotations

import asyncio
import uuid
from datetime import UTC, datetime, timedelta

import pytest

from app import devices_ws, schedule, timers
from app.identity import Person
from app.main import app
from app.timers import TimerRefused
from tests.conftest import requires_db

pytestmark = requires_db

NY = "America/New_York"
FUTURE_ONCE = {"kind": "once", "at": "2031-06-01T09:00"}


@pytest.fixture(autouse=True)
def _clean_hub():
    devices_ws.hub._conns.clear()
    devices_ws.hub._pending.clear()
    yield
    devices_ws.hub._conns.clear()
    devices_ws.hub._pending.clear()


async def _person(pool, name: str = "jeremy", role: str = "owner") -> tuple[Person, uuid.UUID]:
    pid = await pool.fetchval(
        "INSERT INTO people (name, role) VALUES ($1, $2) RETURNING id", name, role
    )
    conversation = await pool.fetchval(
        "INSERT INTO conversations (person_id) VALUES ($1) RETURNING id", pid
    )
    return Person(id=pid, name=name, role=role), conversation


async def _reminder(pool, person, conversation, **overrides):
    kwargs = dict(
        person=person,
        kind="reminder",
        title="stretch",
        payload={"message": "stretch", "device": None},
        spec=FUTURE_ONCE,
        tz=NY,
        conversation_id=conversation,
        created_via="chat",
    )
    kwargs.update(overrides)
    return await timers.create(pool, **kwargs)


# -- create ----------------------------------------------------------------------


async def test_create_computes_the_first_fire_in_the_zone_and_stores_the_normalized_spec(pool):
    person, conversation = await _person(pool)
    row = await _reminder(
        pool, person, conversation, spec={"kind": "once", "at": "2031-06-01T09:00:30"}
    )
    assert row["kind"] == "reminder"
    assert row["schedule"] == {"kind": "once", "at": "2031-06-01T09:00"}
    assert row["payload"] == {"message": "stretch", "device": None}
    # 09:00 New York in June is EDT: 13:00 UTC.
    assert row["next_fire_at"] == datetime(2031, 6, 1, 13, 0, tzinfo=UTC)
    assert row["paused_at"] is None and row["consecutive_failures"] == 0
    assert row["person_id"] == person.id and row["conversation_id"] == conversation
    assert timers.timer_spec(row)["schedule_words"] == schedule.describe(
        row["schedule"], NY, row["next_fire_at"]
    )


async def test_timer_spec_states_why_a_schedule_cannot_be_described_instead_of_raising(pool):
    """A stored zone the system no longer knows must not 500 the listing over
    one row: schedule_words carries the reason."""
    person, conversation = await _person(pool)
    row = await _reminder(pool, person, conversation)
    await pool.execute("UPDATE timers SET timezone = 'Mars/Olympus' WHERE id = $1", row["id"])
    spec = timers.timer_spec(await timers.get(pool, row["id"]))
    assert spec["schedule_words"].startswith("cannot describe this schedule: ")
    assert "'Mars/Olympus' is not an IANA timezone" in spec["schedule_words"]
    assert spec["timezone"] == "Mars/Olympus"


async def test_create_refuses_a_once_already_in_the_past_in_words(pool):
    person, conversation = await _person(pool)
    with pytest.raises(TimerRefused, match="already in the past"):
        await _reminder(pool, person, conversation, spec={"kind": "once", "at": "2020-01-01T09:00"})
    assert await pool.fetchval("SELECT count(*) FROM timers") == 0


async def test_create_refuses_kind_job_and_an_unknown_kind(pool):
    person, conversation = await _person(pool)
    with pytest.raises(TimerRefused, match="ensure_jobs|seeded from code"):
        await _reminder(pool, person, conversation, kind="job", payload={"handler": "retention"})
    with pytest.raises(TimerRefused, match="'alarm'"):
        await _reminder(pool, person, conversation, kind="alarm")


@pytest.mark.parametrize(
    "overrides, name",
    [
        ({"payload": {"message": "x", "device": None, "urgency": 1}}, "'urgency'"),
        ({"payload": {"device": None}}, "message"),
        ({"payload": {"message": "   ", "device": None}}, "empty"),
        ({"payload": "stretch"}, "object"),
        ({"spec": {"kind": "day", "at": "7:00"}}, "HH:MM"),
        ({"spec": {"kind": "day", "at": "07:00", "tz": NY}}, "'tz'"),
        ({"tz": "Mars/Olympus"}, "Mars/Olympus"),
        ({"tz": ""}, "IANA"),
        ({"created_via": "api"}, "created_via"),
        ({"title": "  "}, "title"),
        ({"conversation_id": None}, "conversation"),
        ({"kind": "scheduled", "payload": {"instruction": "x", "extra": 1}}, "'extra'"),
        ({"kind": "scheduled", "payload": {"message": "x"}}, "instruction"),
    ],
)
async def test_create_refuses_each_bad_field_by_name(pool, overrides, name):
    person, conversation = await _person(pool)
    with pytest.raises(TimerRefused) as excinfo:
        await _reminder(pool, person, conversation, **overrides)
    assert name in str(excinfo.value), str(excinfo.value)
    assert await pool.fetchval("SELECT count(*) FROM timers") == 0


async def test_a_scheduled_timer_stores_its_instruction_and_repeat(pool):
    person, conversation = await _person(pool)
    row = await timers.create(
        pool,
        person=person,
        kind="scheduled",
        title="calendar",
        payload={"instruction": "tell me what's on my calendar file"},
        spec={"kind": "day", "at": "07:00"},
        tz=NY,
        conversation_id=conversation,
        created_via="chat",
    )
    assert row["kind"] == "scheduled"
    assert row["payload"] == {"instruction": "tell me what's on my calendar file"}
    assert row["next_fire_at"] > datetime.now(UTC)
    local = row["next_fire_at"].astimezone(schedule._zone(NY))
    assert (local.hour, local.minute) == (7, 0)


# -- list / owned ------------------------------------------------------------------


async def test_list_for_is_the_persons_timers_plus_every_job_never_anothers(pool):
    person, conversation = await _person(pool)
    other, other_conversation = await _person(pool, name="kid", role="kid")
    mine = await _reminder(pool, person, conversation)
    theirs = await _reminder(pool, other, other_conversation, title="theirs")
    await timers.ensure_jobs(pool)

    rows = await timers.list_for(pool, person)
    assert {r["id"] for r in rows} == {mine["id"]} | {
        r["id"] for r in await pool.fetch("SELECT id FROM timers WHERE kind = 'job'")
    }
    assert theirs["id"] not in {r["id"] for r in rows}

    # Cursor paging: page size 1, the second page starts after the first row.
    first = await timers.list_for(pool, person, limit=1)
    second = await timers.list_for(pool, person, limit=1, before=first[0]["id"])
    assert len(first) == 1 and len(second) == 1 and first[0]["id"] != second[0]["id"]


async def test_owned_is_404_for_someone_elses_timer_and_finds_jobs_for_anyone(pool):
    person, conversation = await _person(pool)
    other, other_conversation = await _person(pool, name="kid", role="kid")
    theirs = await _reminder(pool, other, other_conversation)
    await timers.ensure_jobs(pool)
    job = await pool.fetchrow("SELECT id FROM timers WHERE kind = 'job'")

    with pytest.raises(TimerRefused) as excinfo:
        await timers.owned(pool, person, theirs["id"])
    assert excinfo.value.status_code == 404
    assert (await timers.owned(pool, person, job["id"]))["id"] == job["id"]
    assert (await timers.owned(pool, other, theirs["id"]))["id"] == theirs["id"]


# -- pause / resume ----------------------------------------------------------------


async def test_pause_needs_a_reason_and_records_it(pool):
    person, conversation = await _person(pool)
    row = await _reminder(pool, person, conversation)
    with pytest.raises(TimerRefused, match="reason"):
        await timers.pause(pool, row["id"], reason="  ")
    paused = await timers.pause(pool, row["id"], reason="going on holiday")
    assert paused["paused_at"] is not None
    assert paused["paused_reason"] == "going on holiday"
    assert paused["next_fire_at"] == row["next_fire_at"]  # the instant is kept
    # Pausing a paused row is refused: the first reason is the record.
    with pytest.raises(TimerRefused, match="already paused: going on holiday") as excinfo:
        await timers.pause(pool, row["id"], reason="again")
    assert excinfo.value.status_code == 409


async def test_resume_keeps_a_future_once_and_clears_the_pause_and_the_count(pool):
    person, conversation = await _person(pool)
    row = await _reminder(pool, person, conversation)
    await timers.pause(pool, row["id"], reason="hold")
    await pool.execute("UPDATE timers SET consecutive_failures = 3 WHERE id = $1", row["id"])
    resumed = await timers.resume(pool, row["id"])
    assert resumed["paused_at"] is None and resumed["paused_reason"] is None
    assert resumed["consecutive_failures"] == 0
    assert resumed["next_fire_at"] == row["next_fire_at"]


async def test_resume_recomputes_a_repeat_from_now(pool):
    """A daily row paused for a week must fire once tomorrow, not seven times
    today: its next fire is recomputed from now, not kept from the past."""
    person, conversation = await _person(pool)
    row = await timers.create(
        pool,
        person=person,
        kind="scheduled",
        title="calendar",
        payload={"instruction": "calendar"},
        spec={"kind": "day", "at": "07:00"},
        tz="UTC",
        conversation_id=conversation,
        created_via="chat",
    )
    await timers.pause(pool, row["id"], reason="hold")
    stale = datetime.now(UTC) - timedelta(days=7)
    await pool.execute("UPDATE timers SET next_fire_at = $2 WHERE id = $1", row["id"], stale)
    resumed = await timers.resume(pool, row["id"])
    assert resumed["next_fire_at"] > datetime.now(UTC)
    assert resumed["next_fire_at"] == schedule.next_after(
        row["schedule"], await pool.fetchval("SELECT now()"), "UTC"
    )


async def test_resume_of_an_unpaused_row_is_refused(pool):
    person, conversation = await _person(pool)
    row = await _reminder(pool, person, conversation)
    with pytest.raises(TimerRefused, match="not paused") as excinfo:
        await timers.resume(pool, row["id"])
    assert excinfo.value.status_code == 409


async def test_pause_resume_delete_of_an_unknown_id_are_404(pool):
    missing = uuid.uuid4()
    for call in (
        timers.pause(pool, missing, reason="x"),
        timers.resume(pool, missing),
        timers.delete(pool, missing),
        timers.fire_now(pool, missing, app=app),
    ):
        with pytest.raises(TimerRefused) as excinfo:
            await call
        assert excinfo.value.status_code == 404


# -- delete --------------------------------------------------------------------------


async def test_delete_removes_the_row_and_its_firings(pool):
    person, conversation = await _person(pool)
    row = await _reminder(pool, person, conversation)
    await pool.execute(
        "INSERT INTO timer_firings (timer_id, scheduled_for, status, ended_at) "
        "VALUES ($1, now(), 'ok', now())",
        row["id"],
    )
    await timers.delete(pool, row["id"])
    assert await timers.get(pool, row["id"]) is None
    assert await pool.fetchval("SELECT count(*) FROM timer_firings") == 0


# -- fire_now --------------------------------------------------------------------------


async def test_fire_now_runs_the_tick_inline_and_returns_that_firing(pool):
    person, conversation = await _person(pool)
    row = await _reminder(pool, person, conversation)  # due in 2031
    firing = await timers.fire_now(pool, row["id"], app=app)
    assert firing["timer_id"] == row["id"]
    assert firing["status"] == "ok"
    assert firing["delivery"]["chat"] == {"ok": True}
    assert firing["turn_id"] is not None
    # It went through the claim, and the reminder landed. "Run now" PREVIEWS a
    # future once: the time he asked for still stands (the claim computes the
    # next fire from now, and 2031 is still ahead) — running early is not
    # cancelling. A once claimed AT its instant is finished (test_scheduler).
    after = await timers.get(pool, row["id"])
    assert after["next_fire_at"] == row["next_fire_at"]
    assert firing["scheduled_for"] < row["next_fire_at"]
    assert await pool.fetchval(
        "SELECT content FROM messages WHERE conversation_id = $1", conversation
    ) == "Reminder: stretch"


async def test_fire_now_on_a_paused_row_is_refused_with_the_pause_reason(pool):
    person, conversation = await _person(pool)
    row = await _reminder(pool, person, conversation)
    await timers.pause(pool, row["id"], reason="holiday")
    with pytest.raises(TimerRefused, match="paused \\(holiday\\)") as excinfo:
        await timers.fire_now(pool, row["id"], app=app)
    assert excinfo.value.status_code == 409
    assert await pool.fetchval("SELECT count(*) FROM timer_firings") == 0


async def test_fire_now_does_not_double_fire_a_row_another_tick_claimed_first(pool):
    """The race the T3 review reproduced: a DUE row, the loop's tick claims it
    (holding it FOR UPDATE) while "Run now" arrives. fire_now's re-due UPDATE
    waits on the lock, then must see the row already moved and hand back the
    loop's firing — never re-due it and run it a second time."""
    person, conversation = await _person(pool)
    row = await _reminder(pool, person, conversation)
    past = datetime.now(UTC) - timedelta(minutes=1)
    await pool.execute("UPDATE timers SET next_fire_at = $2 WHERE id = $1", row["id"], past)
    row = await timers.get(pool, row["id"])
    async with pool.acquire() as conn:
        tr = conn.transaction()
        await tr.start()
        # The loop's claim, mid-transaction: the row is locked …
        await conn.fetchrow("SELECT id FROM timers WHERE id = $1 FOR UPDATE", row["id"])
        task = asyncio.create_task(timers.fire_now(pool, row["id"], app=app))
        await asyncio.sleep(0.3)
        assert not task.done()  # blocked on the row lock, as the real race is
        # … its firing is opened for the instant we saw and the row advanced …
        firing_id = await conn.fetchval(
            "INSERT INTO timer_firings (timer_id, scheduled_for, status) "
            "VALUES ($1, $2, 'running') RETURNING id",
            row["id"],
            row["next_fire_at"],
        )
        await conn.execute(
            "UPDATE timers SET next_fire_at = NULL, updated_at = now() WHERE id = $1", row["id"]
        )
        await tr.commit()
    firing = await task
    assert firing["id"] == firing_id  # the loop's firing, not a second one
    assert await pool.fetchval("SELECT count(*) FROM timer_firings") == 1
    assert (
        await pool.fetchval(
            "SELECT count(*) FROM messages WHERE conversation_id = $1", conversation
        )
        == 0
    )
    assert (await timers.get(pool, row["id"]))["next_fire_at"] is None


# -- firings_for -------------------------------------------------------------------------


async def test_firings_for_is_newest_first_with_a_cursor(pool):
    person, conversation = await _person(pool)
    row = await _reminder(pool, person, conversation)
    ids = []
    for offset in range(3):
        ids.append(
            await pool.fetchval(
                "INSERT INTO timer_firings (timer_id, scheduled_for, started_at, status, "
                "ended_at) VALUES ($1, now(), now() + make_interval(secs => $2), 'ok', now()) "
                "RETURNING id",
                row["id"],
                offset,
            )
        )
    page = await timers.firings_for(pool, row["id"], limit=2)
    assert [f["id"] for f in page] == [ids[2], ids[1]]
    rest = await timers.firings_for(pool, row["id"], limit=2, before=page[-1]["id"])
    assert [f["id"] for f in rest] == [ids[0]]


# -- jobs ------------------------------------------------------------------------------------


async def test_ensure_jobs_seeds_every_handler_once_and_is_idempotent(pool):
    assert await timers.ensure_jobs(pool) == ["retention"]
    assert await timers.ensure_jobs(pool) == []
    rows = await pool.fetch("SELECT * FROM timers WHERE kind = 'job'")
    assert len(rows) == 1
    (job,) = rows
    assert job["payload"] == {"handler": "retention"}
    assert job["person_id"] is None
    assert job["schedule"] == {"kind": "day", "at": "03:30"}
    assert job["timezone"] == "UTC"
    assert job["created_via"] == "system"
    local = job["next_fire_at"].astimezone(UTC)
    assert (local.hour, local.minute) == (3, 30)
    assert job["next_fire_at"] > datetime.now(UTC)


async def test_ensure_jobs_is_derived_from_jobs(pool, monkeypatch):
    """A handler added to JOBS gets its row on the next start — nothing else
    has to be told."""

    async def nightly(pool) -> str:
        return "did nothing"

    monkeypatch.setitem(timers.JOBS, "nightly", nightly)
    monkeypatch.setitem(timers.JOB_SCHEDULES, "nightly", {"kind": "day", "at": "01:00"})
    monkeypatch.setitem(timers.JOB_TITLES, "nightly", "Nightly nothing")
    assert sorted(await timers.ensure_jobs(pool)) == ["nightly", "retention"]
    assert await pool.fetchval("SELECT count(*) FROM timers WHERE kind = 'job'") == 2


async def test_ensure_jobs_refuses_a_handler_without_schedule_and_title_in_words(pool, monkeypatch):
    """A JOBS entry with no JOB_SCHEDULES / JOB_TITLES row is a code defect
    that stops startup with the name in words, not a KeyError."""

    async def orphan(pool) -> str:
        return "unreachable"

    monkeypatch.setitem(timers.JOBS, "orphan", orphan)
    with pytest.raises(RuntimeError) as refused:
        await timers.ensure_jobs(pool)
    assert str(refused.value) == "JOBS['orphan'] has no JOB_SCHEDULES/JOB_TITLES entry"
    orphan_rows = "SELECT count(*) FROM timers WHERE payload->>'handler' = 'orphan'"
    assert await pool.fetchval(orphan_rows) == 0


async def test_a_second_job_row_for_one_handler_is_refused_by_the_database(pool):
    await timers.ensure_jobs(pool)
    import asyncpg

    with pytest.raises(asyncpg.UniqueViolationError):
        await pool.execute(
            "INSERT INTO timers (kind, title, payload, schedule, timezone, created_via) "
            "VALUES ('job', 'dup', '{\"handler\": \"retention\"}', "
            "'{\"kind\":\"day\",\"at\":\"03:30\"}', 'UTC', 'system')"
        )


async def test_the_schema_refuses_a_job_with_a_person_and_a_person_row_without_one(pool):
    import asyncpg

    person, _conversation = await _person(pool)
    with pytest.raises(asyncpg.CheckViolationError):
        await pool.execute(
            "INSERT INTO timers (person_id, kind, title, payload, schedule, timezone, created_via) "
            "VALUES ($1, 'job', 'x', '{\"handler\": \"nope\"}', "
            "'{\"kind\":\"day\",\"at\":\"03:30\"}', 'UTC', 'system')",
            person.id,
        )
    with pytest.raises(asyncpg.CheckViolationError):
        await pool.execute(
            "INSERT INTO timers (kind, title, payload, schedule, timezone, created_via) "
            "VALUES ('reminder', 'x', '{}', '{\"kind\":\"day\",\"at\":\"03:30\"}', 'UTC', 'chat')"
        )
    with pytest.raises(asyncpg.CheckViolationError):
        await pool.execute(
            "INSERT INTO timers (person_id, kind, title, payload, schedule, timezone, created_via, "
            "paused_at) VALUES ($1, 'reminder', 'x', '{}', '{\"kind\":\"day\",\"at\":\"03:30\"}', "
            "'UTC', 'chat', now())",
            person.id,
        )


async def test_retention_deletes_only_firings_older_than_30_days_and_says_how_many(pool):
    person, conversation = await _person(pool)
    row = await _reminder(pool, person, conversation)
    for age_days in (1, 29, 31, 400):
        await pool.execute(
            "INSERT INTO timer_firings (timer_id, scheduled_for, started_at, status, ended_at) "
            "VALUES ($1, now(), now() - make_interval(days => $2), 'ok', now())",
            row["id"],
            age_days,
        )
    assert await timers.retention(pool) == "deleted 2 firings older than 30 days"
    assert await pool.fetchval("SELECT count(*) FROM timer_firings") == 2
    assert await timers.retention(pool) == "deleted 0 firings older than 30 days"
