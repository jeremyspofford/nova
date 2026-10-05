"""/api/v1/mcp — Settings → Connections (S37a). The MCP client module is
imported as `mcp_client`: `client` is conftest's HTTP client fixture.

Plants are context managers used inside each test (a ContextVar token is
reset in the context that set it).

Every refusal in this service comes back as `{"error": reason}` — the
global `stated_error` handler in app/main.py rewrites every HTTPException's
`detail` that way before it reaches the wire (confirmed against every other
route test in this suite: none reads `.json()["detail"]`). Tests here read
`.json()["error"]`, never `["detail"]`, to match what the route actually
sends.
"""

from __future__ import annotations

import contextlib

import pytest

from app.mcp import client as mcp_client
from app.mcp import fake
from app.mcp import servers as store
from tests.conftest import TEST_DSN, requires_db

pytestmark = requires_db


@pytest.fixture(scope="module", autouse=True)
def _wipe_mcp_tables_once_the_file_is_done():
    """`pool` truncates fresh at the START of every test, so nothing in THIS
    module ever reads another test's leftovers — but nothing truncates again
    once the LAST test in the module finishes, and every route test here
    writes real rows through `owner_client`, never through `pool` directly.
    Left alone, whichever test happens to be collected last decides what
    `mcp_servers`, `governance_events`, `notices` and `notice_mutes` hold for
    whoever reads this scratch database next. Same pattern as
    test_mcp_tools.py's fixture of the same name."""
    yield
    if not TEST_DSN:
        return
    import asyncio

    import asyncpg

    async def _wipe() -> None:
        conn = await asyncpg.connect(TEST_DSN)
        try:
            await conn.execute(
                "TRUNCATE mcp_servers, governance_events, notices, notice_mutes "
                "RESTART IDENTITY CASCADE"
            )
        finally:
            await conn.close()

    asyncio.run(_wipe())


URL = "http://gh.mcp.invalid/mcp"
ORIGIN = "http://gh.mcp.invalid"


@contextlib.contextmanager
def planted(transport=None):
    spec = fake.FakeSpec(title="GitHub", tools=(fake.FakeTool("actions_list"),))
    handle = mcp_client.plant({ORIGIN: transport or fake.transport(fake.FakeServer(spec))})
    try:
        yield
    finally:
        mcp_client.unplant(handle)


async def test_the_routes_need_a_session(client):
    assert (await client.get("/api/v1/mcp/servers")).status_code == 401


async def test_a_server_that_does_not_answer_is_a_422_and_nothing_is_saved(owner_client):
    with planted(fake.Unreachable()):
        response = await owner_client.post(
            "/api/v1/mcp/servers", json={"name": "github", "url": URL}
        )
    assert response.status_code == 422 and "Nothing was saved" in response.json()["error"]
    assert (await owner_client.get("/api/v1/mcp/servers")).json() == {"servers": []}


async def test_adding_testing_and_removing_a_server(owner_client):
    with planted():
        added = await owner_client.post(
            "/api/v1/mcp/servers", json={"name": "github", "url": URL, "token": "t0ken"}
        )
        tested = await owner_client.post("/api/v1/mcp/servers/github/test")
    assert added.status_code == 200
    body = added.json()
    assert body["server"]["origin"] == ORIGIN and body["server"]["added_by"] == "owner"
    assert body["replaced"] is None and body["notice"] is None
    assert body["rejected"] == [] and body["rejected_more"] == 0
    listed = (await owner_client.get("/api/v1/mcp/servers")).json()["servers"]
    assert [s["name"] for s in listed] == ["github"] and listed[0]["tool_count"] == 1
    assert tested.status_code == 200 and tested.json()["server"]["protocol"] == "2026-07-28"
    assert (await owner_client.delete("/api/v1/mcp/servers/github")).json() == {"removed": "github"}
    assert (await owner_client.delete("/api/v1/mcp/servers/github")).status_code == 404
    assert (await owner_client.post("/api/v1/mcp/servers/github/test")).status_code == 404


async def test_removing_or_testing_an_unconnected_name_is_404_with_the_stores_sentence(
    owner_client, pool
):
    """Ruling F13: the store's single `no_such_server` sentence, pinned
    exactly — never a second, hand-written 404 string."""
    sentence = await store.no_such_server(pool, "ghost")
    removed = await owner_client.delete("/api/v1/mcp/servers/ghost")
    tested = await owner_client.post("/api/v1/mcp/servers/ghost/test")
    assert removed.status_code == 404 and removed.json()["error"] == sentence
    assert tested.status_code == 404 and tested.json()["error"] == sentence


async def test_a_database_refusal_on_remove_is_422_not_404(owner_client, pool, monkeypatch):
    """A database refusal is not 'not found' (ruling: a ServerError from
    `disconnect` itself, once the name is known to exist, is a 422 with its
    own reason) — the plan's literal code maps EVERY ServerError from
    `disconnect` to 404, which would misreport this as 'not found'."""
    with planted():
        connected = await owner_client.post(
            "/api/v1/mcp/servers", json={"name": "github", "url": URL}
        )
    assert connected.status_code == 200

    async def _refuses(pool, *, name, by, actor):
        raise store.ServerError("the database refused the row (SQLSTATE 23505)")

    monkeypatch.setattr(store, "disconnect", _refuses)
    response = await owner_client.delete("/api/v1/mcp/servers/github")
    assert response.status_code == 422
    assert "the database refused the row" in response.json()["error"]


async def test_testing_a_server_that_stops_answering_is_422_and_stamps_the_row(owner_client, pool):
    """Carry from Task 5 (ruling T5-E): `record_call` takes the Server
    snapshot the failed call used, never the bare name — passing a name
    raises AttributeError deep inside `record_call`'s own scrub."""
    with planted():
        connected = await owner_client.post(
            "/api/v1/mcp/servers", json={"name": "github", "url": URL}
        )
    assert connected.status_code == 200
    with planted(fake.Unreachable()):
        response = await owner_client.post("/api/v1/mcp/servers/github/test")
    assert response.status_code == 422
    row = await store.get(pool, "github")
    assert row.failing and row.last_error is not None


async def test_the_rejected_list_is_capped_at_20_with_a_count(owner_client):
    """The rejected list is bounded like her tool's (ruling): at most 20
    {"name", "reason"} entries, plus a `rejected_more` count for the rest."""
    bad = tuple(fake.FakeTool(name=f"bad-{i}", input_schema="nope") for i in range(50))
    spec = fake.FakeSpec(title="GitHub", tools=bad)
    with planted(fake.transport(fake.FakeServer(spec))):
        response = await owner_client.post(
            "/api/v1/mcp/servers", json={"name": "github", "url": URL}
        )
    assert response.status_code == 200, response.text
    body = response.json()
    assert len(body["rejected"]) == 20 and body["rejected_more"] == 30
    assert all(set(item) == {"name", "reason"} for item in body["rejected"])
    assert {item["name"] for item in body["rejected"]} == {f"bad-{i}" for i in range(20)}


async def test_routes_never_return_a_token_or_a_header_value(owner_client):
    body = {
        "name": "github",
        "url": f"{ORIGIN}/private_abc123/mcp",
        "token": "t0ken",
        "headers": {"X-Api-Key": "hdr-secret"},
    }
    with planted():
        responses = [
            await owner_client.post("/api/v1/mcp/servers", json=body),
            await owner_client.get("/api/v1/mcp/servers"),
            await owner_client.post("/api/v1/mcp/servers/github/test"),
            await owner_client.delete("/api/v1/mcp/servers/github"),
        ]
    for response in responses:
        assert response.status_code == 200, response.text
        for secret in ("t0ken", "hdr-secret", "private_abc123"):
            assert secret not in response.text


async def test_the_github_preset_is_offered(owner_client):
    [preset] = (await owner_client.get("/api/v1/mcp/presets")).json()["presets"]
    assert preset["url"] == "https://api.githubcopilot.com/mcp/"
    assert preset["headers"] == {"X-MCP-Toolsets": "actions"} and preset["name"] == "github"
