"""S37c T1: the senders store — migration 051's event_senders and events
tables, the sender name rule, adding a sender (its token stored hashed, shown
once), checking a token, and the built-in senders seeded by code."""

from __future__ import annotations

import hmac
import re

import asyncpg
import pytest

from app import events, identity
from app.main import app, lifespan
from tests.conftest import requires_db

# The gateway's role rule (services/gateway/app/usage.py ROLE_RE = PURPOSE_RE):
# a sender's role must pass it, or the gateway refuses its route.
GATEWAY_ROLE_RE = re.compile(r"^[a-z_]{1,32}$")


# -- C2: the name rule (no DB) ---------------------------------------------


@pytest.mark.parametrize("name", ["a", "test", "github_ci", "ci_runner", "a" + "b" * 25])
def test_check_name_accepts_a_lowercase_word(name):
    assert events.check_name(name) == name


@pytest.mark.parametrize(
    "name",
    ["", "github-ci", "Test", "_x", "1x", "x1", "a b", "a" + "b" * 26, "été", "x/y"],
)
def test_check_name_refuses_anything_else_with_a_stated_reason(name):
    with pytest.raises(events.SenderError) as e:
        events.check_name(name)
    assert str(e.value), "a refusal must say why"


def test_every_valid_name_gives_a_role_the_gateway_takes():
    longest = "a" + "b" * 25
    assert events.role_for(longest) == "event_" + longest
    assert GATEWAY_ROLE_RE.match(events.role_for(longest))
    assert events.role_for("github_ci") == "event_github_ci"


def test_the_built_ins_are_monitor_and_github_ci_and_carry_no_token_kind():
    assert events.BUILTINS == {"monitor": "monitor", "github_ci": "poll"}
    for name in events.BUILTINS:
        assert events.check_name(name) == name


# -- C1: the tables ---------------------------------------------------------


@requires_db
async def test_the_sender_table_refuses_bad_rows(pool):
    ok = (
        "INSERT INTO event_senders (name, kind, token_hash, role, added_by) "
        "VALUES ($1, $2, $3, $4, 'owner')"
    )
    await pool.execute(ok, "test", "token", "h", "event_test")
    row = await pool.fetchrow("SELECT * FROM event_senders WHERE name = 'test'")
    assert row["enabled"] is True
    assert row["last_sent_at"] is None
    assert row["token_once"] is None
    assert row["created_at"] is not None
    bad = [
        ("Bad-Name", "token", "h", "event_Bad-Name"),  # name rule
        ("x", "webhook", "h", "event_x"),  # kind
        ("y", "token", None, "event_y"),  # a token sender with no hash
        ("z", "monitor", "h", "event_z"),  # a built-in kind with a hash
        ("w", "token", "h", "chat"),  # role is not event_<name>
    ]
    for args in bad:
        with pytest.raises(asyncpg.CheckViolationError):
            await pool.execute(ok, *args)
    with pytest.raises(asyncpg.CheckViolationError):
        await pool.execute(
            "INSERT INTO event_senders (name, kind, token_once, role, added_by) "
            "VALUES ('m', 'monitor', 'plain', 'event_m', 'owner')"
        )
    with pytest.raises(asyncpg.UniqueViolationError):
        await pool.execute(ok, "test", "token", "h2", "event_test")


@requires_db
async def test_the_events_table_defaults_and_refuses_bad_rows(pool):
    eid = await pool.fetchval(
        "INSERT INTO events (sender, payload) VALUES ('test', '{}') RETURNING id"
    )
    row = await pool.fetchrow("SELECT * FROM events WHERE id = $1", eid)
    assert row["state"] == "queued"
    assert row["urgent"] is False
    assert row["received_at"] is not None
    assert row["turn_id"] is None
    assert row["reason"] is None
    for col in ("content_type", "fingerprint"):
        assert col in row.keys()
    with pytest.raises(asyncpg.CheckViolationError):
        await pool.execute("INSERT INTO events (sender, state) VALUES ('test', 'lost')")
    # A refused row always says why.
    with pytest.raises(asyncpg.CheckViolationError):
        await pool.execute("INSERT INTO events (sender, state) VALUES ('test', 'refused')")
    await pool.execute(
        "INSERT INTO events (sender, state, reason) VALUES ('nobody', 'refused', 'unknown sender')"
    )
    with pytest.raises(asyncpg.ForeignKeyViolationError):
        await pool.execute(
            "INSERT INTO events (sender, turn_id) VALUES ('test', gen_random_uuid())"
        )


# -- C3: adding a sender ----------------------------------------------------


@requires_db
async def test_add_sender_stores_only_the_hash_and_returns_the_token_once(pool):
    sender, token = await events.add_sender(pool, "test", added_by="owner")
    assert sender.name == "test" and sender.kind == "token" and sender.enabled
    assert sender.role == "event_test"
    assert len(token) >= 32
    row = await pool.fetchrow("SELECT * FROM event_senders WHERE name = 'test'")
    assert row["token_hash"] == identity.hash_token(token)
    assert row["token_once"] is None
    assert row["added_by"] == "owner"
    dump = " ".join(str(v) for v in row.values())
    assert token not in dump, "the plaintext token must never be stored"
    _, other = await events.add_sender(pool, "other", added_by="owner")
    assert other != token


@requires_db
async def test_add_sender_refuses_a_bad_name_a_built_in_and_a_duplicate(pool):
    await events.ensure_builtins(pool)
    await events.add_sender(pool, "test", added_by="owner")
    for name in ("github-ci", "monitor", "github_ci", "test"):
        with pytest.raises(events.SenderError) as e:
            await events.add_sender(pool, name, added_by="owner")
        assert str(e.value)
    assert await pool.fetchval("SELECT count(*) FROM event_senders") == 3


@requires_db
async def test_add_sender_refuses_a_built_in_name_before_the_built_ins_are_seeded(pool):
    # No ensure_builtins: the duplicate path cannot catch these, only the
    # built-in rule can, so a token sender never takes a built-in's name.
    for name in events.BUILTINS:
        with pytest.raises(events.SenderError, match="built-in"):
            await events.add_sender(pool, name, added_by="owner")
    assert await pool.fetchval("SELECT count(*) FROM event_senders") == 0


@requires_db
async def test_reveal_once_keeps_the_token_for_one_read_then_nulls_it(pool):
    _, token = await events.add_sender(pool, "ci", added_by="nova", reveal_once=True)
    assert await pool.fetchval("SELECT token_once FROM event_senders WHERE name='ci'") == token
    assert await events.take_token_once(pool, "ci") == token
    assert await events.take_token_once(pool, "ci") is None
    assert await pool.fetchval("SELECT token_once FROM event_senders WHERE name='ci'") is None
    assert await events.take_token_once(pool, "nobody") is None


# -- C4: checking a token ---------------------------------------------------


@requires_db
async def test_verify_takes_only_the_right_token_of_an_enabled_token_sender(pool):
    await events.ensure_builtins(pool)
    _, token = await events.add_sender(pool, "test", added_by="owner")
    _, other_token = await events.add_sender(pool, "other", added_by="owner")

    ok = await events.verify(pool, "test", token)
    assert ok.ok and ok.sender.name == "test" and ok.reason == ""

    results = {
        "wrong": await events.verify(pool, "test", other_token),
        "empty": await events.verify(pool, "test", ""),
        "unknown": await events.verify(pool, "nobody", token),
        "bad_name": await events.verify(pool, "Bad-Name", token),
        "monitor": await events.verify(pool, "monitor", token),
        "github_ci": await events.verify(pool, "github_ci", token),
    }
    for label, r in results.items():
        assert not r.ok, label
        assert r.reason, label
    assert results["wrong"].reason == results["empty"].reason == "wrong token"
    assert results["unknown"].reason == results["bad_name"].reason == "unknown sender"
    assert (
        results["monitor"].reason == results["github_ci"].reason == "built-in sender takes no calls"
    )

    await pool.execute("UPDATE event_senders SET enabled = false WHERE name = 'test'")
    off = await events.verify(pool, "test", token)
    assert not off.ok and off.reason == "sender is off"


@requires_db
async def test_verify_compares_in_constant_time(pool, monkeypatch):
    _, token = await events.add_sender(pool, "test", added_by="owner")
    calls = []
    real = hmac.compare_digest

    def spy(a, b):
        calls.append((a, b))
        return real(a, b)

    monkeypatch.setattr(events.hmac, "compare_digest", spy)
    assert (await events.verify(pool, "test", token)).ok
    assert not (await events.verify(pool, "test", "nope")).ok
    assert len(calls) == 2


# -- C5: the built-ins ------------------------------------------------------


@requires_db
async def test_ensure_builtins_seeds_once_and_keeps_his_off_switch(pool):
    seeded = await events.ensure_builtins(pool)
    assert sorted(seeded) == ["github_ci", "monitor"]
    rows = {r["name"]: r for r in await pool.fetch("SELECT * FROM event_senders ORDER BY name")}
    assert rows["monitor"]["kind"] == "monitor"
    assert rows["github_ci"]["kind"] == "poll"
    for r in rows.values():
        assert r["token_hash"] is None and r["enabled"] is True
        assert r["role"] == "event_" + r["name"]
        assert r["added_by"] == "builtin"
    await pool.execute("UPDATE event_senders SET enabled = false WHERE name = 'monitor'")
    assert await events.ensure_builtins(pool) == []
    assert await pool.fetchval("SELECT enabled FROM event_senders WHERE name='monitor'") is False
    assert await pool.fetchval("SELECT count(*) FROM event_senders") == 2


@requires_db
async def test_startup_seeds_the_built_ins(pool):
    async with lifespan(app):
        names = await pool.fetch("SELECT name FROM event_senders ORDER BY name")
    assert [r["name"] for r in names] == ["github_ci", "monitor"]
