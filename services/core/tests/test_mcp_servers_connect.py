"""Connecting, refreshing and removing MCP servers (S37a): proven before
saved, recorded in the ledger in the same transaction, and noticed in the
owner's Inbox when the change was not his.

Plants are context managers used inside each test (a ContextVar token is
reset in the context that set it)."""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import os
from datetime import UTC, datetime, timedelta

import asyncpg
import httpx
import pytest

from app import governance, notices
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
        ("github", "http://u:p@gh.mcp.invalid/mcp", {}, "cannot carry a username or password"),
        ("github", "http://gh.mcp.invalid:99999/mcp", {}, "not a number from 1 to 65535"),
        ("github", "http://gh.mcp.invalid:abc/mcp", {}, "not a number from 1 to 65535"),
        ("github", "http://gh.mcp.invalid:0/mcp", {}, "not a number from 1 to 65535"),
        # Ruling T5-D (fix round 1): userinfo is refused FIRST, before the
        # scheme is even read, so a URL that is BOTH the wrong scheme and
        # carries userinfo is never echoed via the scheme refusal's netloc
        # (the review's exact reproduction: this used to read "...address:
        # ftp://user:hunter2@gh.mcp.invalid").
        (
            "github",
            "ftp://user:hunter2@gh.mcp.invalid/mcp",
            {},
            "cannot carry a username or password",
        ),
        # Review Minor 4: urlsplit itself raises ValueError for these two
        # (an unbalanced `[`, a bracketed value that is not an IP literal);
        # an embedded control character is stripped by urlsplit silently,
        # so the raw string is checked first; an empty host (netloc truthy,
        # hostname None) reached httpx as a malformed request. All four
        # used to raise RAW, uncaught exceptions at e79c3224.
        ("github", "http://[::1/mcp", {}, "not a usable http or https address"),
        ("github", "http://[not-an-ip]/mcp", {}, "not a usable http or https address"),
        ("github", "http://:80/mcp", {}, "not a usable http or https address"),
        ("github", "http://gh.mcp.invalid/m\ncp", {}, "not a usable http or https address"),
    ],
)
async def test_a_bad_request_is_refused_before_any_network(pool, name, url, headers, why):
    with pytest.raises(servers.ServerError) as caught:
        await servers.connect(
            pool, name=name, url=url, headers=headers, added_by=servers.BY_OWNER, actor="jeremy"
        )
    assert why in caught.value.reason
    # T5-D: no refusal above echoes anything of the address but its scheme.
    for leaked in ("u:p@", "hunter2", "99999", "s3cret", "::1", "not-an-ip"):
        assert leaked not in caught.value.reason


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


async def test_a_connect_that_rejects_tools_records_them_capped_in_the_ledger(pool):
    """Fix round 1, item 2 (ruling T10-A): the add form's own state is not a
    durable record — the governance ledger is. `mcp.server_connected`'s meta
    gains `rejected` (at most REJECTED_LISTED_UP_TO, the same cap the route
    shows) and `rejected_more` for the rest, the same shape and the same cap
    test_mcp_api.py's `test_the_rejected_list_is_capped_at_20_with_a_count`
    pins at the HTTP layer."""
    bad = tuple(fake.FakeTool(name=f"bad-{i}", input_schema="nope") for i in range(25))
    with planted(fake.FakeSpec(title="GitHub", tools=(LIST, *bad))):
        done = await servers.connect(
            pool, name="github", url=URL, added_by=servers.BY_OWNER, actor="jeremy"
        )
    assert len(done.rejected) == 25
    [event] = await _events(pool, "mcp.server_connected")
    assert len(event["meta"]["rejected"]) == 20
    assert event["meta"]["rejected_more"] == 5
    assert all(set(item) == {"name", "reason"} for item in event["meta"]["rejected"])
    assert {item["name"] for item in event["meta"]["rejected"]} == {f"bad-{i}" for i in range(20)}


async def test_a_connect_with_nothing_rejected_carries_no_rejected_key(pool):
    """The keys are added ONLY when something was rejected — an ordinary
    connect's meta is byte-identical to before this fix."""
    with planted(fake.FakeSpec(tools=(LIST,))):
        done = await servers.connect(
            pool, name="github", url=URL, added_by=servers.BY_OWNER, actor="jeremy"
        )
    assert done.rejected == ()
    [event] = await _events(pool, "mcp.server_connected")
    assert "rejected" not in event["meta"] and "rejected_more" not in event["meta"]


async def test_a_connect_with_rejections_files_the_same_notice_facts_as_one_without(pool):
    """Ruling T10-A: `finding_for` selects its facts field by field (verified
    against app/checks/mcp.py), so the new meta keys must change no notice's
    facts or title shape. Same scenario as
    test_nova_replacing_the_owners_server_files_a_notice, with the second
    connect's server also offering a tool it rejects."""
    bad = (fake.FakeTool(name="bad-0", input_schema="nope"),)
    with (
        planted(fake.FakeSpec(tools=(LIST,))),
        planted(fake.FakeSpec(tools=(LIST, *bad)), origin=OTHER),
    ):
        await _owner_github(pool)
        done = await servers.connect(
            pool, name="github", url=OTHER + "/mcp", added_by=servers.BY_NOVA, actor="jeremy"
        )
    assert done.previous.origin == ORIGIN and "Inbox" in done.notice
    [notice] = await pool.fetch("SELECT check_name, title, facts FROM notices")
    assert notice["check_name"] == mcp_checks.CHANGES
    assert ORIGIN in notice["title"] and OTHER in notice["title"]
    # The facts are EXACTLY the same shape as the no-rejection scenario —
    # {server, from, to} and nothing else; "rejected" never reaches it.
    assert notice["facts"] == {"server": "github", "from": ORIGIN, "to": OTHER}
    [event] = [e for e in await _events(pool, "mcp.server_connected") if e["meta"].get("replaced")]
    assert event["meta"]["rejected"] == [
        {"name": "bad-0", "reason": event["meta"]["rejected"][0]["reason"]}
    ]


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
    # M7: pin F17's exact facts shape — spec §8's {server, added, removed,
    # changed} and NOTHING else (no event id, no kind) — read from the
    # notices TABLE itself, not re-derived from the Finding in memory.
    [notice] = await pool.fetch("SELECT title, facts FROM notices")
    assert "1 added" in notice["title"]
    assert notice["facts"] == {
        "server": "github",
        "added": ["get_job_logs"],
        "removed": [],
        "changed": [],
    }


async def test_an_unchanged_list_records_nothing(pool):
    with planted(fake.FakeSpec(tools=(LIST,))):
        await _owner_github(pool)
        updated = await servers.refresh_tools(
            pool, await servers.get(pool, "github"), actor="jeremy"
        )
    assert updated.tools_changed_at is None
    assert await _events(pool, "mcp.tools_changed") == []


async def test_a_refresh_that_fails_with_a_credential_echo_is_scrubbed(pool):
    """M7: the brief's own cases exercise connect; refresh_tools must scrub
    the same way when the server's own failure text echoes a credential —
    its ClientError is defence-in-depth re-scrubbed (ruling T5-A) and its
    __cause__/__context__ carry nothing either (ruling M3's reasoning
    applied the same way here)."""
    with planted(fake.FakeSpec(tools=(LIST,))):
        done = await servers.connect(
            pool,
            name="github",
            url=URL,
            token="t0ken-credential-99",
            headers={"X-Api-Key": "hdr-secret-value"},
            added_by=servers.BY_OWNER,
            actor="jeremy",
        )

    class _EchoesCredential(httpx.AsyncBaseTransport):
        async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
            return httpx.Response(
                401,
                text=f"refused: {request.headers.get('authorization', '')} "
                f"{request.headers.get('x-api-key', '')}",
                headers={"content-type": "text/plain"},
            )

    handle = client.plant({ORIGIN: _EchoesCredential()})
    try:
        with pytest.raises(client.ClientError) as caught:
            await servers.refresh_tools(pool, done.server, actor="jeremy")
    finally:
        client.unplant(handle)
    for secret in ("t0ken-credential-99", "hdr-secret-value"):
        assert secret not in caught.value.reason
    assert caught.value.__cause__ is None and caught.value.__context__ is None
    # Nothing is recorded for a read that failed before anything was read.
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
                # 8+ chars (ruling T5-B): a credential this short is not one
                # any server issues, and is never a scrub candidate.
                token="t0ken-credential-99",
                added_by=servers.BY_OWNER,
                actor="jeremy",
            )
    finally:
        client.unplant(handle)
    assert "t0ken-credential-99" not in caught.value.reason
    assert caught.value.__cause__ is None and caught.value.__context__ is None
    assert await servers.list_servers(pool) == []


async def test_a_401_body_that_echoes_a_header_value_is_scrubbed_on_connect(pool):
    """M7: the brief's own case only exercised the token; a header value
    (the GitHub preset shape, X-MCP-Toolsets, or any extra header) must be
    scrubbed on the connect path exactly the same way."""

    class _EchoesHeader(httpx.AsyncBaseTransport):
        async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
            got = request.headers.get("x-api-key", "")
            return httpx.Response(401, text=f"refused — bad X-Api-Key: {got}")

    handle = client.plant({ORIGIN: _EchoesHeader()})
    try:
        with pytest.raises(servers.ServerError) as caught:
            await servers.connect(
                pool,
                name="github",
                url=URL,
                headers={"X-Api-Key": "hdr-secret-value"},
                added_by=servers.BY_OWNER,
                actor="jeremy",
            )
    finally:
        client.unplant(handle)
    assert "hdr-secret-value" not in caught.value.reason
    assert caught.value.__cause__ is None and caught.value.__context__ is None


async def test_record_call_scrubs_with_the_calls_own_credentials(pool):
    with planted(fake.FakeSpec(tools=(LIST,))):
        done = await servers.connect(
            pool,
            name="github",
            url=URL,
            # 8+ chars (ruling T5-B): below that, a value is never a
            # candidate — "hdr-secret" alone is exactly 10, kept as-is.
            token="t0ken-credential-99",
            headers={"X-Api-Key": "hdr-secret"},
            added_by=servers.BY_OWNER,
            actor="jeremy",
        )
    await servers.record_call(
        pool,
        done.server,
        ok=False,
        reason="refused: token t0ken-credential-99 and key hdr-secret were rejected",
    )
    row = await servers.get(pool, "github")
    assert "t0ken-credential-99" not in row.last_error
    assert "hdr-secret" not in row.last_error
    assert "refused" in row.last_error


async def test_record_call_never_stamps_a_server_that_has_been_repointed(pool):
    """Ruling T5-E: record_call's UPDATE matches the row's endpoint too, so a
    call made against the OLD endpoint never stamps last_ok/last_error onto
    whatever the row holds NOW."""
    with planted(fake.FakeSpec(tools=(LIST,))):
        done = await servers.connect(
            pool, name="github", url=URL, added_by=servers.BY_OWNER, actor="jeremy"
        )
    stale = done.server
    with planted(fake.FakeSpec(tools=(LIST,)), origin=OTHER):
        await servers.connect(
            pool, name="github", url=OTHER + "/mcp", added_by=servers.BY_NOVA, actor="jeremy"
        )
    await servers.record_call(pool, stale, ok=False, reason="a stale call's own failure")
    row = await servers.get(pool, "github")
    assert row.origin == OTHER and row.last_error is None and row.failing is False


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


# ── fix round 1: Important 2a, scheme/host case ──────────────────────────────


@pytest.mark.parametrize("typed", ["Http://gh.mcp.invalid/mcp", "HTTP://GH.MCP.INVALID/mcp"])
async def test_an_uppercase_scheme_or_host_is_normalized_not_refused(pool, typed):
    """Important 2a: migration 038's `url ~ '^https?://…'` CHECK is
    case-sensitive. `urlsplit` already lower-cases `.scheme`/`.hostname`, so
    `_validated` passed an untouched `Http://`/`HTTP://HOST` straight through
    to the probe and then to the INSERT, where it used to raise a raw
    CheckViolationError whose DETAIL echoed the whole row, credentials
    included (closed generally by ruling T5-C; closed AT THE SOURCE here, so
    the ordinary case never reaches that path at all)."""
    with planted(fake.FakeSpec(tools=(LIST,))):
        done = await servers.connect(
            pool, name="github", url=typed, added_by=servers.BY_OWNER, actor="jeremy"
        )
    assert done.server.url == "http://gh.mcp.invalid/mcp"
    row = await servers.get(pool, "github")
    assert row.url == "http://gh.mcp.invalid/mcp"


async def test_a_path_keeps_its_case_only_the_scheme_and_host_are_lowered(pool):
    with planted(fake.FakeSpec(tools=(LIST,))):
        done = await servers.connect(
            pool,
            name="github",
            url="HTTP://GH.MCP.INVALID/MixedCasePath",
            added_by=servers.BY_OWNER,
            actor="jeremy",
        )
    assert done.server.url == "http://gh.mcp.invalid/MixedCasePath"


# ── fix round 1: ruling T5-C, a PostgresError never carries a credential ────


async def test_a_forced_check_violation_never_leaks_a_credential(pool, caplog):
    """Ruling T5-C: any asyncpg.PostgresError raised inside a store
    transaction becomes a ServerError naming only the SQLSTATE and the
    constraint — never str(exc), never the row DETAIL a CHECK violation
    carries, in the raised text, its __cause__/__context__ chain, or the
    log. `added_by` is validated by the DB (`IN ('owner','nova')`) but not
    by `_validated`, so a bogus value is a realistic way to force this
    through the public API without bypassing any URL validation."""
    with caplog.at_level(logging.ERROR, logger="core"):
        with planted(fake.FakeSpec(tools=(LIST,))):
            with pytest.raises(servers.ServerError) as caught:
                await servers.connect(
                    pool,
                    name="github",
                    url=URL,
                    token="t0ken-credential-99",
                    headers={"X-Api-Key": "hdr-secret-value"},
                    added_by="not-owner-or-nova",
                    actor="jeremy",
                )
    assert caught.value.__cause__ is None and caught.value.__context__ is None
    assert "mcp_servers_added_by_check" in caught.value.reason
    written = caught.value.reason + "\n".join(r.getMessage() for r in caplog.records)
    for secret in ("t0ken-credential-99", "hdr-secret-value"):
        assert secret not in written
    assert await servers.list_servers(pool) == []
    assert await _events(pool, "mcp.server_connected") == []


# ── fix round 1: ruling M6, a header NAME anchored at both ends ─────────────


async def test_a_header_name_with_a_trailing_newline_is_refused(pool):
    """M6: client._TCHAR's `$` matches before a trailing newline, so a bare
    `.match()` let "X-Api\\n" through; every use is `.fullmatch()` now."""
    with pytest.raises(servers.ServerError) as caught:
        await servers.connect(
            pool,
            name="github",
            url=URL,
            headers={"X-Api\n": "v"},
            added_by=servers.BY_OWNER,
            actor="jeremy",
        )
    assert "a header name is not a valid HTTP token" in caught.value.reason


async def test_a_bad_header_name_is_refused_by_its_length_never_echoed(pool):
    """Final review I1: a header NAME can hold the credential itself (a
    whole `Authorization: Bearer …` line pasted as a key). The refusal
    reaches her tool result and the span's error, so it names only the
    length, never the name."""
    name = "Authorization: Bearer ghp_LEAKLEAKLEAK123"
    with pytest.raises(servers.ServerError) as caught:
        await servers.connect(
            pool,
            name="github",
            url=URL,
            headers={name: ""},
            added_by=servers.BY_OWNER,
            actor="jeremy",
        )
    assert "ghp_LEAKLEAKLEAK123" not in caught.value.reason
    assert "Bearer" not in caught.value.reason
    assert f"({len(name)} characters)" in caught.value.reason
    assert "header 1 of 1" in caught.value.reason


# ── final review fix round 2 (ruling F-H1): no name a caller chose is echoed ─

_LEAK = "ghp_LEAKLEAKLEAK123"


async def test_a_token_given_as_the_server_name_is_refused_by_its_length(pool):
    """N2: the refusal states the length, never the name."""
    with pytest.raises(servers.ServerError) as caught:
        await servers.connect(pool, name=_LEAK, url=URL, added_by=servers.BY_OWNER, actor="jeremy")
    assert _LEAK not in caught.value.reason
    assert f"({len(_LEAK)} characters)" in caught.value.reason
    assert "cannot be a server name" in caught.value.reason


@pytest.mark.parametrize(
    ("headers", "why"),
    [
        ({"X-A": "ok", _LEAK: "two\nlines"}, "the value of header 2 of 2 must be one line"),
        ({_LEAK: 5}, "the value of header 1 of 1 must be one line"),
        ({"X-A": "ok", "Mcp-Method": "x"}, "header 2 of 2 is set by the client itself"),
    ],
)
async def test_a_header_refusal_names_the_header_by_position(pool, headers, why):
    """N4: a valid header token can itself be the credential, so no header
    refusal names a header — only its position."""
    with pytest.raises(servers.ServerError) as caught:
        await servers.connect(
            pool, name="github", url=URL, headers=headers, added_by=servers.BY_OWNER, actor="jeremy"
        )
    assert why in caught.value.reason
    assert _LEAK not in caught.value.reason and "Mcp-Method" not in caught.value.reason


# ── fix round 1: ruling T5-E, deterministic races (events, never sleeps) ───


class _PauseFirst(httpx.AsyncBaseTransport):
    """Wraps `inner`; the FIRST request through this instance sets `entered`
    and then waits on `release` before being handled — every later request
    passes straight through. Lets a test pause one call's network round trip
    at an exact point and resume it on command, with no sleep anywhere."""

    def __init__(
        self, inner: httpx.AsyncBaseTransport, entered: asyncio.Event, release: asyncio.Event
    ) -> None:
        self._inner, self._entered, self._release = inner, entered, release
        self._used = False

    async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
        if not self._used:
            self._used = True
            self._entered.set()
            await self._release.wait()
        return await self._inner.handle_async_request(request)


def _gate_on(kind: str):
    """Pause the first `governance.record_event` call of `kind` — i.e.
    inside the store's own transaction, after its row write — until the
    test releases it. Returns (entered, release, original); the caller MUST
    restore `governance.record_event = original` in a `finally`."""
    entered, release = asyncio.Event(), asyncio.Event()
    original = governance.record_event
    used = False

    async def gated(conn, *, kind: str, **kw):
        nonlocal used
        if kind == gate_kind and not used:
            used = True
            entered.set()
            await release.wait()
        return await original(conn, kind=kind, **kw)

    gate_kind = kind
    governance.record_event = gated
    return entered, release, original


async def test_a_refresh_racing_a_repoint_refuses_rather_than_overwriting(pool):
    """Ruling T5-E, the review's reproduced Important 3: a refresh snapshot
    of github@A, paused mid-network-call, must not win against a re-point to
    B that completes while it is paused — it must see the row changed and
    write nothing, never silently store A's tools on B's row."""
    with planted(fake.FakeSpec(tools=(LIST,))):
        await _owner_github(pool)
    snap = await servers.get(pool, "github")
    entered, release = asyncio.Event(), asyncio.Event()
    paused = client.plant(
        {
            ORIGIN: _PauseFirst(
                fake.transport(fake.FakeServer(fake.FakeSpec(tools=(LIST,)))), entered, release
            )
        }
    )
    try:
        refreshing = asyncio.create_task(servers.refresh_tools(pool, snap, actor="jeremy"))
        await entered.wait()
        with planted(fake.FakeSpec(tools=(fake.FakeTool("b_tool"),)), origin=OTHER):
            await servers.connect(
                pool, name="github", url=OTHER + "/mcp", added_by=servers.BY_NOVA, actor="jeremy"
            )
        release.set()
        with pytest.raises(servers.ServerError) as caught:
            await refreshing
    finally:
        client.unplant(paused)
    assert "changed while its tools were being read" in caught.value.reason
    row = await servers.get(pool, "github")
    assert row.origin == OTHER and [t["name"] for t in row.tools] == ["b_tool"]
    assert await _events(pool, "mcp.tools_changed") == []


async def test_two_concurrent_refreshes_from_one_snapshot_record_one_change(pool):
    """Ruling T5-E: `change` is computed against the row LOCKED inside this
    call's own transaction, never the caller's snapshot — so of two
    refreshes racing from the same snapshot, the one that commits second
    sees its own result already reflected and records nothing."""
    with planted(fake.FakeSpec(tools=(LIST,))):
        await _owner_github(pool)
    snap = await servers.get(pool, "github")
    entered, release = asyncio.Event(), asyncio.Event()
    changed_spec = fake.FakeSpec(tools=(LIST, fake.FakeTool("new_tool")))
    paused = client.plant(
        {ORIGIN: _PauseFirst(fake.transport(fake.FakeServer(changed_spec)), entered, release)}
    )
    try:
        first = asyncio.create_task(servers.refresh_tools(pool, snap, actor="jeremy"))
        await entered.wait()
        # The second refresh's own request is the SECOND through the same
        # plant, so `_PauseFirst` lets it straight through — it runs to
        # completion, tools/hash/event and all, while the first is paused.
        second = await servers.refresh_tools(pool, snap, actor="jeremy")
        release.set()
        first_result = await first
    finally:
        client.unplant(paused)
    assert second.tools_changed_at is not None
    assert [t["name"] for t in second.tools] == ["actions_list", "new_tool"]
    # The first, resuming after, sees the row already at the new hash — its
    # own UPDATE runs but records no SECOND change.
    assert first_result.tools_hash == second.tools_hash
    changed = await _events(pool, "mcp.tools_changed")
    assert len(changed) == 1 and changed[0]["meta"]["added"] == ["new_tool"]


async def test_two_connects_of_a_brand_new_name_do_not_race_past_each_other(pool):
    """Ruling M5: a name with no existing row has nothing for `FOR UPDATE`
    to lock, so without the advisory lock keyed on the name, nova's connect
    of a brand-new name could race the owner's own first connect of it and
    see no previous row — recording no `replaced` and filing no notice."""
    entered, release, original = _gate_on(governance.MCP_SERVER_CONNECTED)
    try:
        with (
            planted(fake.FakeSpec(tools=(LIST,))),
            planted(fake.FakeSpec(tools=(LIST,)), origin=OTHER),
        ):
            first = asyncio.create_task(
                servers.connect(
                    pool, name="github", url=URL, added_by=servers.BY_OWNER, actor="jeremy"
                )
            )
            await entered.wait()
            second = asyncio.create_task(
                servers.connect(
                    pool,
                    name="github",
                    url=OTHER + "/mcp",
                    added_by=servers.BY_NOVA,
                    actor="jeremy",
                )
            )
            await asyncio.sleep(0.2)
            assert not second.done(), "the second connect must wait on the advisory lock"
            release.set()
            _first_done, second_done = await asyncio.gather(first, second)
    finally:
        governance.record_event = original
    assert second_done.previous is not None and second_done.previous.origin == ORIGIN
    assert second_done.notice is not None and "Inbox" in second_done.notice
    [event] = [e for e in await _events(pool, "mcp.server_connected") if e["meta"].get("replaced")]
    assert event["meta"]["replaced"] == {"origin": ORIGIN, "added_by": "owner"}


# ── fix round 1: M7, disconnect never holds two pool connections ───────────


async def test_disconnect_of_an_unknown_name_never_holds_two_pool_connections():
    """M7: the not-found sentence used to be built on a SECOND pool
    connection while disconnect's own transaction still held the first.
    `asyncpg.Pool.acquire` is read-only (cannot be monkeypatched to count
    calls), so this proves it a different way: a pool with room for exactly
    ONE connection. If disconnect ever nested a second `acquire` while the
    first was still open, that would DEADLOCK outright — so a clean, fast
    return here is the proof itself, not an inference from reading the
    code."""
    dsn = os.environ["TEST_DATABASE_URL"]
    tiny = await asyncpg.create_pool(dsn, min_size=1, max_size=1)
    try:
        await tiny.execute(
            "TRUNCATE mcp_servers, governance_events, notices, notice_mutes "
            "RESTART IDENTITY CASCADE"
        )
        with pytest.raises(servers.ServerError) as caught:
            await asyncio.wait_for(
                servers.disconnect(tiny, name="github", by=servers.BY_NOVA, actor="jeremy"),
                timeout=5,
            )
    finally:
        await tiny.close()
    assert "none is connected" in caught.value.reason


# ── fix round 1: notice honesty (new / folded-live / folded-muted) ─────────


async def test_notice_honesty_is_new_folded_live_and_folded_muted(pool):
    with planted(fake.FakeSpec(tools=(LIST,))):
        await _owner_github(pool)
    with planted(fake.FakeSpec(tools=(LIST,)), origin=OTHER):
        first = await servers.connect(
            pool, name="github", url=OTHER + "/mcp", added_by=servers.BY_NOVA, actor="jeremy"
        )
    assert first.notice == "A notice about this is in the owner's Inbox."
    [notice_row] = await pool.fetch("SELECT id, check_name, finding_key FROM notices")

    # Fold onto a LIVE notice: owner re-adds at ORIGIN, nova re-points again.
    with planted(fake.FakeSpec(tools=(LIST,))):
        await servers.connect(
            pool, name="github", url=URL, added_by=servers.BY_OWNER, actor="jeremy"
        )
    with planted(fake.FakeSpec(tools=(LIST,)), origin=OTHER):
        folded_live = await servers.connect(
            pool, name="github", url=OTHER + "/mcp", added_by=servers.BY_NOVA, actor="jeremy"
        )
    assert folded_live.notice == "This was added to a notice already in the owner's Inbox."

    # Mute the condition, then fold again: owner re-adds, nova re-points.
    await notices.set_muted(pool, notice_row["id"], True)
    with planted(fake.FakeSpec(tools=(LIST,))):
        await servers.connect(
            pool, name="github", url=URL, added_by=servers.BY_OWNER, actor="jeremy"
        )
    with planted(fake.FakeSpec(tools=(LIST,)), origin=OTHER):
        folded_muted = await servers.connect(
            pool, name="github", url=OTHER + "/mcp", added_by=servers.BY_NOVA, actor="jeremy"
        )
    assert folded_muted.notice == (
        "The owner has muted notices like this; the change is in the governance ledger."
    )
    assert await pool.fetchval("SELECT count(*) FROM notices") == 1


# ── fix round 2: ruling A, notice honesty decides from the CONDITION's mute ──


async def test_a_notice_born_muted_says_so_even_though_it_is_new(pool):
    """Re-review Important A, reproduction 1: F17 keys a finding on (kind,
    server), never on the event, so muting "Nova re-pointed github A->B"
    silences every LATER re-point too — including one with different
    facts (A->C), which `record` inserts as a brand NEW row (a different
    fingerprint) that is itself born muted. `is_new` alone said "a notice
    about this is in the owner's Inbox", which was false: the Inbox page
    is empty for both."""
    with planted(fake.FakeSpec(tools=(LIST,))), planted(fake.FakeSpec(tools=(LIST,)), origin=OTHER):
        await _owner_github(pool)
        first = await servers.connect(
            pool, name="github", url=OTHER + "/mcp", added_by=servers.BY_NOVA, actor="jeremy"
        )
    assert first.notice == "A notice about this is in the owner's Inbox."
    [row] = await pool.fetch("SELECT id FROM notices")
    await notices.set_muted(pool, row["id"], True)
    third = "http://third.mcp.invalid"
    with planted(fake.FakeSpec(tools=(LIST,))), planted(fake.FakeSpec(tools=(LIST,)), origin=third):
        await servers.connect(
            pool, name="github", url=URL, added_by=servers.BY_OWNER, actor="jeremy"
        )
        second = await servers.connect(
            pool, name="github", url=third + "/mcp", added_by=servers.BY_NOVA, actor="jeremy"
        )
    assert second.notice == (
        "The owner has muted notices like this; the change is in the governance ledger."
    )
    assert await pool.fetchval("SELECT count(*) FROM notices") == 2
    assert [n.title for n in await notices.recent(pool)] == []


async def test_a_fold_onto_the_unmuted_twin_of_a_muted_condition_says_muted(pool):
    """Re-review Important A, reproduction 2: TWO live rows share one
    finding_key (A->B, A->C — different facts, different fingerprints).
    The owner mutes the A->B row; `set_muted` stamps ONLY that row's
    `state`, never its unmuted twin's. A fold onto the A->C row (the SAME
    A->C transition happening again) leaves that row's own `state` at
    'raised' — but the Inbox page is empty for both, because the mute is
    on the shared CONDITION, not the row."""
    with planted(fake.FakeSpec(tools=(LIST,))), planted(fake.FakeSpec(tools=(LIST,)), origin=OTHER):
        await _owner_github(pool)
        await servers.connect(
            pool, name="github", url=OTHER + "/mcp", added_by=servers.BY_NOVA, actor="jeremy"
        )
    third = "http://third.mcp.invalid"
    with planted(fake.FakeSpec(tools=(LIST,))), planted(fake.FakeSpec(tools=(LIST,)), origin=third):
        await servers.connect(
            pool, name="github", url=URL, added_by=servers.BY_OWNER, actor="jeremy"
        )
        await servers.connect(
            pool, name="github", url=third + "/mcp", added_by=servers.BY_NOVA, actor="jeremy"
        )
    rows = {r["title"]: r["id"] for r in await pool.fetch("SELECT id, title FROM notices")}
    b_notice_id = next(v for t, v in rows.items() if OTHER in t)
    await notices.set_muted(pool, b_notice_id, True)
    assert [n.title for n in await notices.recent(pool)] == []
    with planted(fake.FakeSpec(tools=(LIST,))), planted(fake.FakeSpec(tools=(LIST,)), origin=third):
        await servers.connect(
            pool, name="github", url=URL, added_by=servers.BY_OWNER, actor="jeremy"
        )
        again = await servers.connect(
            pool, name="github", url=third + "/mcp", added_by=servers.BY_NOVA, actor="jeremy"
        )
    assert again.notice == (
        "The owner has muted notices like this; the change is in the governance ledger."
    )
    c_row = await pool.fetchrow(
        "SELECT state, repeats FROM notices WHERE title LIKE $1", f"%{third}%"
    )
    assert c_row["state"] == "raised" and c_row["repeats"] == 2
    assert [n.title for n in await notices.recent(pool)] == []


# ── fix round 2: ruling D, no echo of even the scheme ────────────────────────


async def test_a_credential_shaped_scheme_is_refused_without_being_echoed(pool):
    """Re-review Important D: a scheme-less paste puts a credential where
    the scheme goes — a GitHub PAT, a GitLab `glpat-…`, a Slack `xoxb-…`
    all look exactly like this. The refusal names only that it is not an
    http/https address, nothing of what was actually typed."""
    credential = "Ghp0123456789abcdefABCDEF"
    with pytest.raises(servers.ServerError) as caught:
        await servers.connect(
            pool,
            name="github",
            url=f"{credential}:x@gh.mcp.invalid/mcp",
            added_by=servers.BY_OWNER,
            actor="jeremy",
        )
    assert caught.value.reason == "that is not an http or https address"
    assert credential.lower() not in caught.value.reason.lower()


# ── fix round 2: ruling E, an IDNA-invalid host is a stated refusal ─────────


@pytest.mark.parametrize(
    "url",
    [
        "http://xn--.invalid/mcp",  # idna.IDNAError: malformed A-label, on .host access
        "http://☃‍.invalid/mcp",  # httpx.InvalidURL: invalid IDNA hostname
    ],
)
async def test_an_idna_invalid_host_is_refused_before_the_probe(pool, url):
    """Re-review Important E: syntactically fine to `urlsplit`, but httpx
    and idna re-validate and re-encode the host LAZILY — on `.host` access
    or deep in the real connection path, never at `httpx.URL(url)`
    construction — so these reached a raw, uncaught exception from inside
    `client.probe` at 4c88ff32. Nothing is planted at this origin: if this
    reached the probe, it would raise a transport-level error, not the
    stated ServerError asserted here."""
    with pytest.raises(servers.ServerError) as caught:
        await servers.connect(
            pool, name="github", url=url, added_by=servers.BY_OWNER, actor="jeremy"
        )
    assert caught.value.reason == "that is not a usable http or https address"
    assert caught.value.__cause__ is None and caught.value.__context__ is None


# ── fix round 2: ruling F, the sixth refusal clears its own chain too ───────


async def test_an_nfkc_invalid_netloc_leaks_no_password_via_cause_or_context(pool):
    """Re-review Important F: `urlsplit` itself raises ValueError for a
    netloc invalid under NFKC normalization, and that ValueError's OWN
    message quotes the whole netloc — password included. `from None`
    alone clears `__cause__`; this one still raised INSIDE its own
    `except`, so `__context__` was the password-bearing ValueError
    regardless."""
    password = "pa＃ss"
    with pytest.raises(servers.ServerError) as caught:
        await servers.connect(
            pool,
            name="github",
            url=f"http://user:{password}@gh.mcp.invalid/mcp",
            added_by=servers.BY_OWNER,
            actor="jeremy",
        )
    assert caught.value.reason == "that is not a usable http or https address"
    assert caught.value.__cause__ is None and caught.value.__context__ is None


async def test_no_such_server_never_echoes_a_name_that_is_not_a_name(pool):
    """Hub ruling after fix round 2: the one 'not connected' sentence (F13)
    reaches her, the trace and a route, so a token given as the name is
    stated by its length."""
    reason = await servers.no_such_server(pool, _LEAK)
    assert _LEAK not in reason
    assert f"({len(_LEAK)} characters, which is not a server name)" in reason
    assert "named 'nope'" in await servers.no_such_server(pool, "nope")
