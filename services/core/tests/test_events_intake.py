"""S37c T2: the intake — POST /api/v1/events/{sender} (spec §2.2, §9 Q3).

A program holding a sender's token posts an event; core keeps it whole as a
queued row and answers 202 with its id. Every other caller — a wrong token,
an unknown sender, one that is off, a built-in, CORE_TOKEN, a session
cookie — gets one identical 401 and leaves a refused row with its reason.
The route is public in core (no session), so nginx carving nothing out for it
is what keeps it on localhost and the tailnet."""

from __future__ import annotations

import logging
import re
import uuid
from pathlib import Path

import pytest

from app import events, identity
from tests.conftest import SERVICE_TOKEN, requires_db

INTAKE = "/api/v1/events/{}"


def _scope(path: str, method: str = "POST") -> dict:
    return {"type": "http", "method": method, "path": path, "root_path": ""}


# -- C1: the public matcher (no DB) ------------------------------------------


@pytest.mark.parametrize("name", ["test", "github_ci", "a", "a" + "b" * 25])
def test_a_post_to_the_intake_is_public(name):
    assert identity.is_public(_scope(f"/api/v1/events/{name}"))


@pytest.mark.parametrize("method", ["GET", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"])
def test_only_a_post_to_the_intake_is_public(method):
    assert not identity.is_public(_scope("/api/v1/events/test", method))


@pytest.mark.parametrize(
    "path",
    [
        "/api/v1/events",
        "/api/v1/events/",
        "/api/v1/events/test/",
        "/api/v1/events/test/x",
        "/api/v1/events/Test",
        "/api/v1/events/github-ci",
        "/api/v1/events/_x",
        "/api/v1/events/" + "a" + "b" * 26,
        "/api/v1/events/test?x",
        "/api/v1/events/test\n",
        "/api/v1/events/test#x",
        "/api/v1/events/../auth/state/x",
        "/api/v1/event-senders",
        "/api/v1/event-senders/test",
        "/api/v1/events/test/../../conversations",
    ],
)
def test_nothing_else_under_events_is_public(path):
    assert not identity.is_public(_scope(path))


def test_the_public_pattern_takes_exactly_the_sender_name_rule():
    """identity cannot import events (events imports identity), so the name
    rule is written twice; this pins the two together."""
    prefix = "/api/v1/events/"
    assert identity.EVENT_INTAKE_RE.pattern == prefix + events.NAME_RE.pattern.strip("^$")


def test_a_scope_without_a_method_is_never_the_intake():
    assert not identity.is_public({"type": "http", "path": "/api/v1/events/test", "root_path": ""})


def test_the_exact_public_paths_are_unchanged():
    """The intake is a separate matcher; PUBLIC_PATHS stays the exact eleven
    (tests/test_agent_dist.py pins the set)."""
    assert not any("events" in p for p in identity.PUBLIC_PATHS)
    assert len(identity.PUBLIC_PATHS) == 11


# -- C5: nginx carves nothing out (no DB) ---------------------------------------

_TEMPLATE = Path(__file__).resolve().parents[3] / "apps/web/nginx.conf.template"


def _locations(text: str) -> list[tuple[str, str, str]]:
    """(modifier, pattern, body) for every location block in the template."""
    found = []
    for m in re.finditer(r"^\s*location\s+(=|~\*|~|\^~)?\s*(\S+)\s*\{", text, re.M):
        depth, i = 1, m.end()
        while depth:
            depth += {"{": 1, "}": -1}.get(text[i], 0)
            i += 1
        found.append((m.group(1) or "", m.group(2), text[m.end() : i]))
    return found


def _matches(modifier: str, pattern: str, path: str) -> bool:
    if modifier == "=":
        return path == pattern
    if modifier in ("~", "~*"):
        return re.search(pattern, path, re.I if modifier == "~*" else 0) is not None
    return path.startswith(pattern)


def test_nginx_has_locations_to_read():
    assert _TEMPLATE.exists(), f"{_TEMPLATE} moved — this pin is now vacuous"
    locs = _locations(_TEMPLATE.read_text())
    assert len(locs) > 5
    # The reader itself finds a carve-out when there is one.
    assert any(
        _matches(mod, pat, "/api/v1/devices/enroll") and "gate_check.conf" not in body
        for mod, pat, body in locs
    )


@pytest.mark.parametrize("name", ["test", "github_ci", "monitor"])
def test_nginx_gates_every_location_the_intake_could_land_in(name):
    """Tailnet + localhost only (spec §9 Q3): with the public gate on, a
    tunnel caller without the cookie is refused at nginx because every
    location that could serve the intake includes the gate check."""
    path = f"/api/v1/events/{name}"
    locs = [(m, p, b) for m, p, b in _locations(_TEMPLATE.read_text()) if _matches(m, p, path)]
    assert locs, f"no nginx location serves {path}"
    for mod, pat, body in locs:
        assert "gate_check.conf" in body, f"location {mod} {pat} lets {path} past the gate"


def test_nginx_names_no_location_for_the_intake():
    for mod, pat, _ in _locations(_TEMPLATE.read_text()):
        assert "events" not in pat, f"location {mod} {pat} is a carve-out for the intake"


# -- the DB half ------------------------------------------------------------------


async def _add(pool, name="test"):
    _, token = await events.add_sender(pool, name, added_by="owner")
    return token


async def _rows(pool):
    return await pool.fetch("SELECT * FROM events ORDER BY received_at")


# -- C2: accepted -----------------------------------------------------------------


@requires_db
async def test_the_right_token_queues_the_event_whole_and_answers_202(pool, client):
    token = await _add(pool)
    body = '{"alert": "disk 91%", "host": "hub"}'
    resp = await client.post(
        INTAKE.format("test"),
        content=body,
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
    )
    assert resp.status_code == 202, resp.text
    event_id = uuid.UUID(resp.json()["id"])
    rows = await _rows(pool)
    assert len(rows) == 1
    row = rows[0]
    assert row["id"] == event_id
    assert row["sender"] == "test"
    assert row["state"] == "queued"
    assert row["payload"] == body
    assert row["content_type"] == "application/json"
    assert row["reason"] is None
    assert row["turn_id"] is None
    sent = await pool.fetchval("SELECT last_sent_at FROM event_senders WHERE name = 'test'")
    assert sent is not None


@requires_db
async def test_each_sender_reaches_only_its_own_intake(pool, client):
    token_a = await _add(pool, "alpha")
    await _add(pool, "beta")
    resp = await client.post(
        INTAKE.format("beta"), content="x", headers={"Authorization": f"Bearer {token_a}"}
    )
    assert resp.status_code == 401
    row = (await _rows(pool))[0]
    assert (row["sender"], row["state"], row["reason"]) == ("beta", "refused", events.WRONG_TOKEN)


@requires_db
async def test_exactly_the_cap_is_accepted(pool, client):
    token = await _add(pool)
    body = "a" * events.MAX_PAYLOAD_BYTES
    resp = await client.post(
        INTAKE.format("test"), content=body, headers={"Authorization": f"Bearer {token}"}
    )
    assert resp.status_code == 202, resp.text
    assert (await _rows(pool))[0]["payload"] == body


# -- C3: refused --------------------------------------------------------------------


async def _refusal(pool, client, caplog, name, headers, *, cookie=None):
    with caplog.at_level(logging.DEBUG):
        resp = await client.post(
            INTAKE.format(name), content="the payload", headers=headers, cookies=cookie
        )
    assert resp.status_code == 401, resp.text
    rows = await _rows(pool)
    assert [r["state"] for r in rows] == ["refused"], "a refused call keeps exactly one row"
    assert rows[0]["sender"] == name
    assert rows[0]["payload"] is None, "an unauthenticated body is never kept"
    said = " ".join(r.getMessage() for r in caplog.records)
    assert name in said, "the refusal is logged with the sender name"
    return resp, rows[0]["reason"], said


@requires_db
async def test_a_wrong_token_is_refused_and_recorded(pool, client, caplog):
    token = await _add(pool)
    wrong = token[:-2] + ("AA" if not token.endswith("AA") else "BB")
    _, reason, said = await _refusal(
        pool, client, caplog, "test", {"Authorization": f"Bearer {wrong}"}
    )
    assert reason == events.WRONG_TOKEN
    assert wrong not in said and token not in said


@requires_db
async def test_no_bearer_is_refused_and_recorded(pool, client, caplog):
    await _add(pool)
    _, reason, _ = await _refusal(pool, client, caplog, "test", {})
    assert reason == events.WRONG_TOKEN


@requires_db
async def test_an_unknown_sender_is_refused_and_recorded(pool, client, caplog):
    token = await _add(pool)
    _, reason, said = await _refusal(
        pool, client, caplog, "nobody", {"Authorization": f"Bearer {token}"}
    )
    assert reason == events.UNKNOWN_SENDER
    assert token not in said


@requires_db
async def test_a_sender_that_is_off_is_refused_and_recorded(pool, client, caplog):
    token = await _add(pool)
    await pool.execute("UPDATE event_senders SET enabled = false WHERE name = 'test'")
    _, reason, said = await _refusal(
        pool, client, caplog, "test", {"Authorization": f"Bearer {token}"}
    )
    assert reason == events.SENDER_OFF
    assert token not in said
    assert await pool.fetchval("SELECT last_sent_at FROM event_senders WHERE name='test'") is None


@requires_db
@pytest.mark.parametrize("builtin", sorted(events.BUILTINS))
async def test_a_built_in_sender_takes_no_calls(pool, client, caplog, builtin):
    await events.ensure_builtins(pool)
    token = await _add(pool)
    for presented in (token, SERVICE_TOKEN, ""):
        await pool.execute("DELETE FROM events")
        caplog.clear()
        _, reason, _ = await _refusal(
            pool, client, caplog, builtin, {"Authorization": f"Bearer {presented}"}
        )
        assert reason == events.BUILTIN_SENDER


@requires_db
async def test_core_token_is_not_a_sender_token(pool, client, caplog):
    """CORE_TOKEN can act as the owner on every other route; here it is just a
    wrong token (spec §4: a sender's key is smaller than CORE_TOKEN)."""
    await _add(pool)
    _, reason, said = await _refusal(
        pool, client, caplog, "test", {"Authorization": f"Bearer {SERVICE_TOKEN}"}
    )
    assert reason == events.WRONG_TOKEN
    assert SERVICE_TOKEN not in said


@requires_db
async def test_a_session_cookie_is_not_a_sender_token(pool, owner_client, caplog):
    """The owner's own session reaches every route as him — not this one: the
    intake reads only the sender's bearer."""
    await _add(pool)
    assert owner_client.cookies.get(identity.COOKIE_NAME)
    _, reason, _ = await _refusal(pool, owner_client, caplog, "test", {})
    assert reason == events.WRONG_TOKEN


@requires_db
async def test_every_refusal_answers_the_same(pool, client):
    """The reason lives on the row and the log; the caller learns nothing
    about which sender names exist or which are off."""
    token = await _add(pool)
    off_token = await _add(pool, "offline")
    await pool.execute("UPDATE event_senders SET enabled = false WHERE name = 'offline'")
    await events.ensure_builtins(pool)
    answers = set()
    for name, presented in [
        ("test", "wrong"),
        ("nobody", token),
        ("offline", off_token),
        ("monitor", token),
        ("test", SERVICE_TOKEN),
    ]:
        resp = await client.post(
            INTAKE.format(name), content="x", headers={"Authorization": f"Bearer {presented}"}
        )
        assert resp.status_code == 401
        answers.add(resp.text)
    assert len(answers) == 1, answers
    reasons = {r["reason"] for r in await _rows(pool)}
    assert reasons == {
        events.WRONG_TOKEN,
        events.UNKNOWN_SENDER,
        events.SENDER_OFF,
        events.BUILTIN_SENDER,
    }


# -- C4: the body cap and its shape ------------------------------------------------------


@requires_db
async def test_a_body_over_the_cap_is_refused_and_recorded(pool, client):
    token = await _add(pool)
    resp = await client.post(
        INTAKE.format("test"),
        content="a" * (events.MAX_PAYLOAD_BYTES + 1),
        headers={"Authorization": f"Bearer {token}"},
    )
    assert resp.status_code == 413, resp.text
    row = (await _rows(pool))[0]
    assert (row["state"], row["reason"], row["payload"]) == ("refused", events.TOO_BIG, None)


@requires_db
async def test_the_cap_holds_without_a_content_length(pool, client):
    """A streamed body carries no Content-Length; the read itself is capped and
    stops early rather than reading the whole thing."""
    token = await _add(pool)
    pulled = 0

    async def chunks():
        nonlocal pulled
        for _ in range(64):
            pulled += 1
            yield b"a" * 65536

    resp = await client.post(
        INTAKE.format("test"), content=chunks(), headers={"Authorization": f"Bearer {token}"}
    )
    assert resp.status_code == 413, resp.text
    assert (await _rows(pool))[0]["reason"] == events.TOO_BIG
    assert pulled < 64, "the whole oversized body was read"


@requires_db
async def test_a_lying_content_length_does_not_get_past_the_cap(pool, client):
    token = await _add(pool)

    async def chunks():
        for _ in range(8):
            yield b"a" * 65536

    resp = await client.post(
        INTAKE.format("test"),
        content=chunks(),
        headers={"Authorization": f"Bearer {token}", "Content-Length": "10"},
    )
    assert resp.status_code in (413, 400), resp.text
    assert not [r for r in await _rows(pool) if r["state"] == "queued"]


@requires_db
@pytest.mark.parametrize("body", [b"\xff\xfe not utf-8", b"nul \x00 inside"])
async def test_a_body_that_is_not_text_is_refused_and_recorded(pool, client, body):
    token = await _add(pool)
    resp = await client.post(
        INTAKE.format("test"), content=body, headers={"Authorization": f"Bearer {token}"}
    )
    assert resp.status_code == 400, resp.text
    row = (await _rows(pool))[0]
    assert (row["state"], row["reason"], row["payload"]) == ("refused", events.NOT_TEXT, None)


@requires_db
async def test_the_token_is_checked_before_the_body_is_read(pool, client):
    """An oversized body with a wrong token is a 401, not a 413: nothing is
    read for a caller that has not shown its key."""
    await _add(pool)
    resp = await client.post(
        INTAKE.format("test"),
        content="a" * (events.MAX_PAYLOAD_BYTES + 1),
        headers={"Authorization": "Bearer wrong"},
    )
    assert resp.status_code == 401
    assert (await _rows(pool))[0]["reason"] == events.WRONG_TOKEN
