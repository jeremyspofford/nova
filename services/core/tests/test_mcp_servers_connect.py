"""Connecting, refreshing and removing MCP servers (S37a): proven before
saved, recorded in the ledger in the same transaction, and noticed in the
owner's Inbox when the change was not his.

Plants are context managers used inside each test (a ContextVar token is
reset in the context that set it)."""

from __future__ import annotations

import contextlib
import json
from datetime import UTC, datetime, timedelta

import httpx
import pytest

from app import notices
from app.checks import mcp as mcp_checks
from app.mcp import client, fake, servers
from tests.conftest import requires_db

pytestmark = requires_db

URL = "http://gh.mcp.invalid/mcp"
ORIGIN = "http://gh.mcp.invalid"
OTHER = "http://other.mcp.invalid"
LIST = fake.FakeTool("actions_list", "List runs", results=({"text": "runs"},))


@contextlib.contextmanager
def planted(spec: fake.FakeSpec, origin: str = ORIGIN):
    server = fake.FakeServer(spec)
    handle = client.plant({origin: fake.transport(server)})
    try:
        yield server
    finally:
        client.unplant(handle)


async def _events(pool, kind: str) -> list:
    return await pool.fetch(
        "SELECT actor, meta FROM governance_events WHERE kind = $1 ORDER BY created_at", kind
    )


async def _owner_github(pool) -> None:
    """The owner connects github at ORIGIN; the caller has planted it."""
    await servers.connect(
        pool, name="github", url=URL, token="t0ken", added_by=servers.BY_OWNER, actor="jeremy"
    )


async def test_a_server_is_saved_only_after_it_answered(pool):
    with planted(fake.FakeSpec(title="GitHub", tools=(LIST,))):
        done = await servers.connect(
            pool,
            name="github",
            url=URL,
            token="t0ken",
            headers={"X-MCP-Toolsets": "actions"},
            added_by=servers.BY_OWNER,
            actor="jeremy",
        )
    assert done.previous is None and done.notice is None and done.rejected == ()
    row = await servers.get(pool, "github")
    assert (row.protocol, row.title) == ("2026-07-28", "GitHub")
    assert [t["name"] for t in row.tools] == ["actions_list"] and row.last_ok_at is not None
    [event] = await _events(pool, "mcp.server_connected")
    assert event["actor"] == "jeremy" and event["meta"]["origin"] == ORIGIN


async def test_the_ledger_and_the_notice_carry_no_credential(pool):
    with planted(fake.FakeSpec(tools=(LIST,))), planted(fake.FakeSpec(tools=(LIST,)), origin=OTHER):
        await servers.connect(
            pool,
            name="github",
            url=URL + "/s3cret-path",
            token="t0ken",
            headers={"X-Api-Key": "hdr-secret"},
            added_by=servers.BY_OWNER,
            actor="jeremy",
        )
        await servers.connect(
            pool, name="github", url=OTHER + "/mcp", added_by=servers.BY_NOVA, actor="jeremy"
        )
    events = [dict(r) for r in await pool.fetch("SELECT kind, actor, meta FROM governance_events")]
    written = json.dumps(events, default=str) + json.dumps(
        [dict(r) for r in await pool.fetch("SELECT title, facts FROM notices")], default=str
    )
    for secret in ("t0ken", "hdr-secret", "s3cret-path"):
        assert secret not in written


async def test_a_server_that_does_not_answer_is_not_saved(pool):
    handle = client.plant({ORIGIN: fake.Unreachable()})
    try:
        with pytest.raises(servers.ServerError) as caught:
            await servers.connect(
                pool, name="github", url=URL, added_by=servers.BY_OWNER, actor="jeremy"
            )
    finally:
        client.unplant(handle)
    assert "Nothing was saved" in caught.value.reason and caught.value.reachable is False
    assert await servers.list_servers(pool) == []
    assert await _events(pool, "mcp.server_connected") == []


@pytest.mark.parametrize(
    ("name", "url", "headers", "why"),
    [
        ("GitHub", URL, {}, "cannot be a server name"),
        ("github", "ftp://x.invalid/mcp", {}, "not an http or https address"),
        ("github", URL, {"Mcp-Method": "x"}, "set by the client itself"),
        ("github", URL, {"X-A": "two\nlines"}, "one line"),
        # URL validation ruling (closes Tasks 2-3's deferred "repr raises on
        # a malformed port" and gives userinfo its own refusal): none of
        # these may reach the client at all.
        ("github", "http://u:p@gh.mcp.invalid/mcp", {}, "username or password"),
        ("github", "http://gh.mcp.invalid:99999/mcp", {}, "bad port"),
        ("github", "http://gh.mcp.invalid:abc/mcp", {}, "bad port"),
    ],
)
async def test_a_bad_request_is_refused_before_any_network(pool, name, url, headers, why):
    with pytest.raises(servers.ServerError) as caught:
        await servers.connect(
            pool, name=name, url=url, headers=headers, added_by=servers.BY_OWNER, actor="jeremy"
        )
    assert why in caught.value.reason


async def test_nova_replacing_the_owners_server_files_a_notice(pool):
    with planted(fake.FakeSpec(tools=(LIST,))), planted(fake.FakeSpec(tools=(LIST,)), origin=OTHER):
        await _owner_github(pool)
        done = await servers.connect(
            pool, name="github", url=OTHER + "/mcp", added_by=servers.BY_NOVA, actor="jeremy"
        )
    assert done.previous.origin == ORIGIN and "Inbox" in done.notice
    [notice] = await pool.fetch("SELECT check_name, title FROM notices")
    assert notice["check_name"] == mcp_checks.CHANGES
    assert ORIGIN in notice["title"] and OTHER in notice["title"]
    [event] = [e for e in await _events(pool, "mcp.server_connected") if e["meta"].get("replaced")]
    assert event["meta"]["replaced"] == {"origin": ORIGIN, "added_by": "owner"}


async def test_the_owner_replacing_his_own_server_files_no_notice(pool):
    with planted(fake.FakeSpec(tools=(LIST,))):
        await _owner_github(pool)
        done = await servers.connect(
            pool, name="github", url=URL, added_by=servers.BY_OWNER, actor="jeremy"
        )
    assert done.notice is None
    assert await pool.fetchval("SELECT count(*) FROM notices") == 0


async def test_nova_removing_the_owners_server_is_noticed_and_an_unknown_name_is_stated(pool):
    with planted(fake.FakeSpec(tools=(LIST,))):
        await _owner_github(pool)
    done = await servers.disconnect(pool, name="github", by=servers.BY_NOVA, actor="jeremy")
    assert "Inbox" in done.notice and await servers.list_servers(pool) == []
    [event] = await _events(pool, "mcp.server_removed")
    assert event["meta"] == {
        "name": "github",
        "origin": ORIGIN,
        "by": "nova",
        "previous_added_by": "owner",
    }
    with pytest.raises(servers.ServerError) as caught:
        await servers.disconnect(pool, name="github", by=servers.BY_NOVA, actor="jeremy")
    assert "none is connected" in caught.value.reason


async def test_a_changed_tool_list_is_recorded_and_noticed(pool):
    with planted(fake.FakeSpec(tools=(LIST,))):
        await _owner_github(pool)
    row = await servers.get(pool, "github")
    with planted(fake.FakeSpec(tools=(LIST, fake.FakeTool("get_job_logs")))):
        updated = await servers.refresh_tools(pool, row, actor="jeremy")
    assert updated.tools_changed_at is not None
    assert [t["name"] for t in updated.tools] == ["actions_list", "get_job_logs"]
    [event] = await _events(pool, "mcp.tools_changed")
    assert event["meta"] == {
        "name": "github",
        "added": ["get_job_logs"],
        "removed": [],
        "changed": [],
    }
    [notice] = await pool.fetch("SELECT title FROM notices")
    assert "1 added" in notice["title"]


async def test_an_unchanged_list_records_nothing(pool):
    with planted(fake.FakeSpec(tools=(LIST,))):
        await _owner_github(pool)
        updated = await servers.refresh_tools(
            pool, await servers.get(pool, "github"), actor="jeremy"
        )
    assert updated.tools_changed_at is None
    assert await _events(pool, "mcp.tools_changed") == []


async def test_the_hourly_check_derives_the_same_notice_and_folds_onto_it(pool):
    with planted(fake.FakeSpec(tools=(LIST,))), planted(fake.FakeSpec(tools=(LIST,)), origin=OTHER):
        await _owner_github(pool)
        await servers.connect(
            pool, name="github", url=OTHER + "/mcp", added_by=servers.BY_NOVA, actor="jeremy"
        )
    [finding] = await mcp_checks.changes(None, pool)
    _row, is_new = await notices.record(
        pool, finding, check_name=mcp_checks.CHANGES, turn_id=None, firing_id=None
    )
    assert is_new is False
    assert await pool.fetchval("SELECT count(*) FROM notices") == 1


async def test_an_overlay_connect_and_disconnect_write_nothing(pool):
    token = servers.OVERLAY.set(servers.Overlay())
    try:
        with planted(fake.FakeSpec(tools=(LIST,))):
            done = await servers.connect(
                pool, name="github", url=URL, added_by=servers.BY_NOVA, actor="jeremy"
            )
        assert [s.name for s in await servers.list_servers(pool)] == [done.server.name]
        await servers.disconnect(pool, name="github", by=servers.BY_NOVA, actor="jeremy")
    finally:
        servers.OVERLAY.reset(token)
    assert await pool.fetchval("SELECT count(*) FROM mcp_servers") == 0
    assert (
        await pool.fetchval("SELECT count(*) FROM governance_events WHERE kind LIKE 'mcp.%'") == 0
    )


# ── controller rulings: additional pins ──────────────────────────────────────


async def test_an_identical_tool_change_recurring_later_folds_onto_the_live_notice(pool):
    """F17: the fingerprint is never scoped to the governance event. Three
    DIFFERENT events here — added, then removed, then added again the exact
    same tool — so the third is the same news as the first and folds onto
    its notice (repeats bumps to 2) rather than minting a third row."""
    with planted(fake.FakeSpec(tools=(LIST,))):
        await _owner_github(pool)
    with planted(fake.FakeSpec(tools=(LIST, fake.FakeTool("get_job_logs")))):
        await servers.refresh_tools(pool, await servers.get(pool, "github"), actor="jeremy")
    with planted(fake.FakeSpec(tools=(LIST,))):
        await servers.refresh_tools(pool, await servers.get(pool, "github"), actor="jeremy")
    with planted(fake.FakeSpec(tools=(LIST, fake.FakeTool("get_job_logs")))):
        await servers.refresh_tools(pool, await servers.get(pool, "github"), actor="jeremy")
    rows = await pool.fetch("SELECT title, repeats FROM notices ORDER BY first_seen_at")
    assert len(rows) == 2, [dict(r) for r in rows]
    added_rows = [r for r in rows if "1 added" in r["title"]]
    assert len(added_rows) == 1 and added_rows[0]["repeats"] == 2
    removed_rows = [r for r in rows if "1 removed" in r["title"]]
    assert len(removed_rows) == 1 and removed_rows[0]["repeats"] == 1


async def test_a_401_body_that_echoes_the_token_is_scrubbed(pool):
    """A server's own refusal text can carry the credential straight back
    (a 401 body echoing the Authorization header); connect() must never let
    that reach the ServerError it raises."""

    class _EchoesCredential(httpx.AsyncBaseTransport):
        async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
            return httpx.Response(
                401,
                json={
                    "error": {
                        "message": f"bad credentials: {request.headers.get('authorization', '')}"
                    }
                },
            )

    handle = client.plant({ORIGIN: _EchoesCredential()})
    try:
        with pytest.raises(servers.ServerError) as caught:
            await servers.connect(
                pool,
                name="github",
                url=URL,
                token="t0ken",
                added_by=servers.BY_OWNER,
                actor="jeremy",
            )
    finally:
        client.unplant(handle)
    assert "t0ken" not in caught.value.reason
    assert await servers.list_servers(pool) == []


async def test_record_call_scrubs_the_servers_own_credential_from_the_reason(pool):
    with planted(fake.FakeSpec(tools=(LIST,))):
        await servers.connect(
            pool,
            name="github",
            url=URL,
            token="t0ken",
            headers={"X-Api-Key": "hdr-secret"},
            added_by=servers.BY_OWNER,
            actor="jeremy",
        )
    await servers.record_call(
        pool, "github", ok=False, reason="refused: token t0ken and key hdr-secret were rejected"
    )
    row = await servers.get(pool, "github")
    assert "t0ken" not in row.last_error and "hdr-secret" not in row.last_error
    assert "refused" in row.last_error


def test_server_equality_is_by_identity_not_by_field_value():
    """eq=False, like Endpoint: the default dataclass eq/hash over a `tools`
    tuple-of-dicts and a `headers` dict is a TypeError trap the moment either
    is hashed."""
    a = servers.Server(
        name="x", url="http://x.mcp.invalid/mcp", token=None, headers={}, added_by="owner"
    )
    b = servers.Server(
        name="x", url="http://x.mcp.invalid/mcp", token=None, headers={}, added_by="owner"
    )
    assert a == a
    assert a != b
    assert hash(a) == hash(a)  # must not raise on the dict/tuple fields


def test_tools_stale_is_based_on_the_ttl_from_when_it_was_fetched():
    now = datetime.now(UTC)
    stale = servers.Server(
        name="x",
        url="http://x.mcp.invalid/mcp",
        token=None,
        headers={},
        added_by="owner",
        tools_fetched_at=now - timedelta(seconds=10),
        tools_ttl_ms=5_000,
    )
    assert stale.tools_stale(now) is True
    fresh = servers.Server(
        name="x",
        url="http://x.mcp.invalid/mcp",
        token=None,
        headers={},
        added_by="owner",
        tools_fetched_at=now - timedelta(seconds=10),
        tools_ttl_ms=60_000,
    )
    assert fresh.tools_stale(now) is False
    never_fetched = servers.Server(
        name="y", url="http://y.mcp.invalid/mcp", token=None, headers={}, added_by="owner"
    )
    assert never_fetched.tools_stale(now) is True
