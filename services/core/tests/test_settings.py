"""The settings registry: a key exists because a def says so.

Plus the one write in this service that does something besides store a value:
writing the digest's hour (or the household zone) re-times the digest beat,
because `beats.ensure_beats` deliberately never touches an existing row and a
new hour would otherwise sit in the table doing nothing.
"""

from __future__ import annotations

from app import beats, schedule
from tests.conftest import requires_db

pytestmark = requires_db

# Every key the registry defines, pinned so a setting cannot appear or
# vanish unnoticed. It moved from three to four in S2: the tool loop needs
# a round cap the operator can see and change (agents.max_tool_rounds),
# which is also the first "int" setting the registry has ever had. S3-T3
# moved it to five with autonomy.graduation_runs, the promotion threshold of
# the earned-autonomy mechanism (both gone — see below).
# S3 walk-fix round 9 makes it six: agents.responsiveness_check is the opt-in,
# default-OFF, LLM-judged relevance guard — see test_chat_responsiveness.py.
# No approvals (owner ruling 2026-09-03) takes it back to five: the graduation
# setting has no reader — there is no earned autonomy, so nothing graduates.
# Deliberate tripwire update, not a routing-around.
# S9 (scheduling) makes it six again: nova.timezone is the one install-wide
# IANA zone reminders and schedules at an absolute time are computed in — and
# the first def to carry a `validate` hook (the zone must load), pinned below.
# S11 (the proactive engine) makes it NINE: the switch that decides whether she
# looks at all (off, until he turns it on), the hour her one daily message is
# written, and the ceiling on how many findings that message may carry.
# Deliberate tripwire update — the number moved because three defs landed.
KNOWN_KEYS = {
    "onboarding.completed",
    "chat.model",
    "appearance.default_preset",
    "agents.max_tool_rounds",
    "agents.responsiveness_check",
    "nova.timezone",
    "proactive.enabled",
    "proactive.digest_at",
    "proactive.max_notices_per_day",
    # S17 (2026-09-11): how many of a skill's last five WATCHED uses must go
    # badly before it is flagged for review. A knob because 3-of-5 is a guess,
    # and the thing it moves is a raised hand, never a retirement.
    "skills.flag_after_rough_uses",
}


async def _by_key(client) -> dict:
    resp = await client.get("/api/v1/settings")
    assert resp.status_code == 200, resp.text
    return {item["key"]: item for item in resp.json()["settings"]}


async def test_every_def_is_listed_with_its_default_when_unset(owner_client):
    items = await _by_key(owner_client)
    assert set(items) == KNOWN_KEYS
    assert items["onboarding.completed"]["type"] == "bool"
    assert items["onboarding.completed"]["default"] is False
    assert items["onboarding.completed"]["value"] is False
    assert items["chat.model"]["value"] == ""
    assert items["appearance.default_preset"]["value"] == "nova"
    # The responsiveness check is opt-in: it must default OFF and unset.
    assert items["agents.responsiveness_check"]["type"] == "bool"
    assert items["agents.responsiveness_check"]["default"] is False
    assert items["agents.responsiveness_check"]["value"] is False
    assert all(item["description"] for item in items.values())


async def test_a_written_value_round_trips_and_is_persisted(owner_client, pool):
    resp = await owner_client.put(
        "/api/v1/settings", json={"key": "chat.model", "value": "qwen3:8b"}
    )
    assert resp.status_code == 200
    assert resp.json() == {"key": "chat.model", "value": "qwen3:8b"}

    assert await pool.fetchval("SELECT value FROM settings WHERE key = 'chat.model'") == "qwen3:8b"
    assert (await _by_key(owner_client))["chat.model"]["value"] == "qwen3:8b"


async def test_writing_twice_updates_the_one_row(owner_client, pool):
    await owner_client.put("/api/v1/settings", json={"key": "onboarding.completed", "value": True})
    await owner_client.put("/api/v1/settings", json={"key": "onboarding.completed", "value": False})

    rows = await pool.fetch("SELECT value FROM settings WHERE key = 'onboarding.completed'")
    assert len(rows) == 1
    assert rows[0]["value"] is False


async def test_an_unknown_key_is_refused_by_name(owner_client, pool):
    resp = await owner_client.put("/api/v1/settings", json={"key": "chat.modle", "value": "x"})
    assert resp.status_code == 400
    assert "chat.modle" in resp.json()["error"]
    assert await pool.fetchval("SELECT count(*) FROM settings") == 0


async def test_a_bool_setting_refuses_a_string(owner_client):
    resp = await owner_client.put(
        "/api/v1/settings", json={"key": "onboarding.completed", "value": "yes"}
    )
    assert resp.status_code == 400
    assert "bool" in resp.json()["error"]


async def test_a_bool_setting_refuses_a_number(owner_client):
    # JSON 1 is not JSON true, however forgiving python feels about it.
    resp = await owner_client.put(
        "/api/v1/settings", json={"key": "onboarding.completed", "value": 1}
    )
    assert resp.status_code == 400


async def test_a_string_setting_refuses_a_bool(owner_client):
    resp = await owner_client.put("/api/v1/settings", json={"key": "chat.model", "value": True})
    assert resp.status_code == 400
    assert "str" in resp.json()["error"]


async def test_a_string_setting_refuses_null(owner_client):
    resp = await owner_client.put("/api/v1/settings", json={"key": "chat.model", "value": None})
    assert resp.status_code == 400


async def test_an_int_setting_round_trips_as_a_number(owner_client, pool):
    resp = await owner_client.put(
        "/api/v1/settings", json={"key": "agents.max_tool_rounds", "value": 3}
    )
    assert resp.status_code == 200
    assert (await _by_key(owner_client))["agents.max_tool_rounds"]["value"] == 3
    assert (
        await pool.fetchval("SELECT value FROM settings WHERE key = 'agents.max_tool_rounds'") == 3
    )


async def test_an_int_setting_refuses_a_bool(owner_client):
    # python says True == 1; the type check here does not, so a checkbox
    # wired to the wrong key cannot silently become "1 round".
    resp = await owner_client.put(
        "/api/v1/settings", json={"key": "agents.max_tool_rounds", "value": True}
    )
    assert resp.status_code == 400
    assert "int" in resp.json()["error"]


async def test_an_int_setting_refuses_a_string_and_a_float(owner_client):
    for value in ("6", 6.5):
        resp = await owner_client.put(
            "/api/v1/settings", json={"key": "agents.max_tool_rounds", "value": value}
        )
        assert resp.status_code == 400, value


# -- nova.timezone and the validate hook (S9) ---------------------------------------


async def test_nova_timezone_defaults_to_utc_and_a_real_zone_round_trips(owner_client, pool):
    items = await _by_key(owner_client)
    assert items["nova.timezone"]["type"] == "str"
    assert items["nova.timezone"]["default"] == "UTC"
    assert items["nova.timezone"]["value"] == "UTC"
    resp = await owner_client.put(
        "/api/v1/settings", json={"key": "nova.timezone", "value": "America/New_York"}
    )
    assert resp.status_code == 200, resp.text
    assert (
        await pool.fetchval("SELECT value FROM settings WHERE key = 'nova.timezone'")
        == "America/New_York"
    )
    assert (await _by_key(owner_client))["nova.timezone"]["value"] == "America/New_York"


async def test_nova_timezone_refuses_a_zone_that_does_not_load_by_name(owner_client, pool):
    """The validate hook: the type is right (a string) and the value is still
    refused, naming it — a misspelt zone stored here would move every
    absolute-time timer without a word."""
    for bad in ("Mars/Olympus", "america/new_york", "", "EST5EDT/../x"):
        body = {"key": "nova.timezone", "value": bad}
        resp = await owner_client.put("/api/v1/settings", json=body)
        assert resp.status_code == 400, (bad, resp.text)
        assert "nova.timezone" in resp.json()["error"]
        if bad:
            assert bad in resp.json()["error"]
    assert await pool.fetchval("SELECT count(*) FROM settings") == 0


async def test_the_validate_hook_runs_after_the_type_check(owner_client):
    # A non-string never reaches the zone check: the type error is the one stated.
    resp = await owner_client.put("/api/v1/settings", json={"key": "nova.timezone", "value": 5})
    assert resp.status_code == 400
    assert "expects str" in resp.json()["error"]
    assert "IANA" not in resp.json()["error"]


async def test_the_listing_carries_no_validate_callable(owner_client):
    for item in (await _by_key(owner_client)).values():
        assert set(item) == {"key", "type", "default", "description", "value"}


# -- the proactive engine's three settings (S11) -------------------------------


async def _digest_row(pool):
    return await pool.fetchrow(
        "SELECT schedule, timezone, next_fire_at, paused_at FROM timers "
        "WHERE kind = $1 AND payload->>'handler' = $2",
        beats.BEAT_KIND,
        beats.DIGEST,
    )


async def test_the_engine_ships_off_with_an_hour_and_a_ceiling(owner_client):
    """It is OFF by default and he turns it on: the beats exist from the first
    tick, and while this is false a firing does nothing and says so."""
    items = await _by_key(owner_client)

    assert items["proactive.enabled"]["type"] == "bool"
    assert items["proactive.enabled"]["default"] is False
    assert items["proactive.enabled"]["value"] is False
    assert items["proactive.digest_at"]["type"] == "str"
    assert items["proactive.digest_at"]["default"] == "08:00"
    assert items["proactive.max_notices_per_day"]["type"] == "int"
    assert items["proactive.max_notices_per_day"]["default"] == 20
    assert all(
        items[key]["description"]
        for key in ("proactive.enabled", "proactive.digest_at", "proactive.max_notices_per_day")
    )


async def test_turning_the_engine_on_round_trips_and_times_nothing(owner_client, pool):
    resp = await owner_client.put(
        "/api/v1/settings", json={"key": "proactive.enabled", "value": True}
    )

    assert resp.status_code == 200, resp.text
    assert resp.json() == {"key": "proactive.enabled", "value": True}, "the switch times nothing"
    assert await pool.fetchval("SELECT value FROM settings WHERE key = 'proactive.enabled'") is True


async def test_the_digest_hour_is_validated_by_building_the_schedule_it_runs_on(owner_client, pool):
    """No second parser: the value is accepted only if `schedule.validate` can
    build the `day` spec the tick later computes the next firing from. A
    friendlier parser here is how "24:00" gets stored by one and refused by the
    other, and the beat that cannot advance its own spec is paused hours later
    with a reason nobody connects to this write."""
    for bad in ("7:00", "25:00", "07:60", "0800", "8pm", ""):
        resp = await owner_client.put(
            "/api/v1/settings", json={"key": "proactive.digest_at", "value": bad}
        )
        assert resp.status_code == 400, (bad, resp.text)
        problem = resp.json()["error"]
        # The key, what the value is FOR, and schedule.py's own sentence about
        # what is wrong with this one — no second vocabulary.
        assert "proactive.digest_at" in problem, bad
        assert "the local time of day her digest is written" in problem, bad
        assert "HH:MM" in problem or "between 00:00 and 23:59" in problem, bad
        assert repr(bad) in problem, bad
    assert await pool.fetchval("SELECT count(*) FROM settings") == 0

    good = await owner_client.put(
        "/api/v1/settings", json={"key": "proactive.digest_at", "value": "21:30"}
    )
    assert good.status_code == 200, good.text
    assert (await _by_key(owner_client))["proactive.digest_at"]["value"] == "21:30"


async def test_a_ceiling_that_could_carry_nothing_is_refused_in_words(owner_client, pool):
    """A backstop that may not be a muzzle: zero would compose a message about
    nothing while the notices piled up unread, which looks exactly like a quiet
    day."""
    for bad in (0, -3):
        resp = await owner_client.put(
            "/api/v1/settings", json={"key": "proactive.max_notices_per_day", "value": bad}
        )
        assert resp.status_code == 400, (bad, resp.text)
        assert "at least one notice" in resp.json()["error"], bad
    assert await pool.fetchval("SELECT count(*) FROM settings") == 0

    good = await owner_client.put(
        "/api/v1/settings", json={"key": "proactive.max_notices_per_day", "value": 5}
    )
    assert good.status_code == 200, good.text
    assert (await _by_key(owner_client))["proactive.max_notices_per_day"]["value"] == 5


# -- writing the hour moves the beat -------------------------------------------


async def test_writing_the_digest_hour_re_times_the_beat_and_says_where_it_landed(
    owner_client, pool
):
    """ensure_beats never re-times an existing row (a restart must not undo a
    pause), so the move happens at the WRITE. The answer's note is composed
    from the row that was written, not from the value that was sent."""
    assert await beats.ensure_beats(pool) is True
    before = await _digest_row(pool)
    assert before["schedule"] == {"kind": "day", "at": beats.DEFAULT_DIGEST_AT}

    resp = await owner_client.put(
        "/api/v1/settings", json={"key": "proactive.digest_at", "value": "21:30"}
    )

    assert resp.status_code == 200, resp.text
    after = await _digest_row(pool)
    assert after["schedule"] == {"kind": "day", "at": "21:30"}
    assert after["next_fire_at"] != before["next_fire_at"]
    # The words are the schedule module's own, over the row as stored — so the
    # note cannot describe a time the beat is not on.
    assert resp.json()["note"] == "the digest is " + schedule.describe(
        after["schedule"], after["timezone"], after["next_fire_at"]
    )
    assert "21:30" in resp.json()["note"]


async def test_a_refused_hour_never_moves_the_beat(owner_client, pool):
    assert await beats.ensure_beats(pool) is True
    before = await _digest_row(pool)

    resp = await owner_client.put(
        "/api/v1/settings", json={"key": "proactive.digest_at", "value": "9:00"}
    )

    assert resp.status_code == 400
    after = await _digest_row(pool)
    assert (after["schedule"], after["next_fire_at"]) == (
        before["schedule"],
        before["next_fire_at"],
    )


async def test_writing_the_household_zone_re_times_the_digest_too(owner_client, pool):
    """The digest's hour is a LOCAL hour, so moving the household moves the
    digest — otherwise 08:00 would quietly stay 08:00 UTC in New York."""
    assert await beats.ensure_beats(pool) is True
    before = await _digest_row(pool)
    assert before["timezone"] == "UTC"

    resp = await owner_client.put(
        "/api/v1/settings", json={"key": "nova.timezone", "value": "America/New_York"}
    )

    assert resp.status_code == 200, resp.text
    after = await _digest_row(pool)
    assert after["timezone"] == "America/New_York"
    assert after["next_fire_at"] != before["next_fire_at"]
    assert "America/New_York" in resp.json()["note"]


async def test_a_paused_digest_is_re_timed_and_said_to_be_paused(owner_client, pool):
    """The pause is the operator's; a setting write is not a resume. The row
    still moves, so resuming it later lands on the hour he chose."""
    assert await beats.ensure_beats(pool) is True
    await pool.execute(
        "UPDATE timers SET paused_at = now(), paused_reason = 'by hand' "
        "WHERE kind = $1 AND payload->>'handler' = $2",
        beats.BEAT_KIND,
        beats.DIGEST,
    )

    resp = await owner_client.put(
        "/api/v1/settings", json={"key": "proactive.digest_at", "value": "06:45"}
    )

    assert resp.status_code == 200, resp.text
    assert "paused" in resp.json()["note"] and "06:45" in resp.json()["note"]
    after = await _digest_row(pool)
    assert after["schedule"] == {"kind": "day", "at": "06:45"}
    assert after["paused_at"] is not None, "a write is not a resume"


async def test_with_no_digest_row_yet_the_note_says_so_instead_of_claiming_a_move(
    owner_client, pool
):
    """Never report a move you did not make. Before the beats are seeded there
    is nothing to re-time, and the answer says exactly that."""
    assert await _digest_row(pool) is None

    resp = await owner_client.put(
        "/api/v1/settings", json={"key": "proactive.digest_at", "value": "09:15"}
    )

    assert resp.status_code == 200, resp.text
    assert "no digest beat row yet" in resp.json()["note"]
    assert (
        await pool.fetchval("SELECT value FROM settings WHERE key = 'proactive.digest_at'")
        == "09:15"
    )
