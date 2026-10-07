"""The About page and nova_about (app/about.py): the build, the update check,
the clients, and the topology — each read live, each stating what it could not
read instead of filling the gap with something that sounds right."""

from __future__ import annotations

import json
from datetime import UTC, datetime, timedelta

import httpx
import pytest

from app import about, identity, tools
from app.main import app
from tests import fakes
from tests.conftest import requires_db

COMMIT = "0123456789abcdef0123456789abcdef01234567"
NEWER = ["a" * 40, "b" * 40]


@pytest.fixture(autouse=True)
def _fresh_caches():
    about._updates_cache.clear()
    identity._touched.clear()
    yield
    about._updates_cache.clear()
    identity._touched.clear()
    app.state.github_transport = None


def _stamp(monkeypatch, **over):
    values = {
        about.COMMIT_ENV: COMMIT,
        about.VERSION_ENV: "v2.0.0-alpha-312-g0123456",
        about.COMMIT_DATE_ENV: "2026-10-06T21:14:03+00:00",
        about.INSTALLED_AT_ENV: "2026-10-07T08:00:00Z",
        about.DIRTY_ENV: "0",
        about.REPO_ENV: "jeremyspofford/nova",
        about.REPO_BRANCH_ENV: "main",
    }
    values.update(over)
    for key, value in values.items():
        if value is None:
            monkeypatch.delenv(key, raising=False)
        else:
            monkeypatch.setenv(key, value)


def _github(status: int = 200, body: dict | None = None, calls: list | None = None):
    def handler(request: httpx.Request) -> httpx.Response:
        if calls is not None:
            calls.append(str(request.url))
        return httpx.Response(status, json=body if body is not None else {})

    app.state.github_transport = httpx.MockTransport(handler)


def _compare_body(status: str, ahead: int, behind: int, shas=()) -> dict:
    return {
        "status": status,
        "ahead_by": ahead,
        "behind_by": behind,
        "html_url": "https://github.com/jeremyspofford/nova/compare/x...main",
        "commits": [
            {
                "sha": sha,
                "commit": {
                    "message": f"commit {i}\n\nbody",
                    "author": {"date": f"2026-10-0{i + 1}T00:00:00Z"},
                },
            }
            for i, sha in enumerate(shas)
        ],
    }


# -- the build -------------------------------------------------------------


def test_the_build_is_read_from_the_stamp(monkeypatch):
    _stamp(monkeypatch)
    build = about.build_info()
    assert build["commit"] == COMMIT
    assert build["short"] == COMMIT[:7]
    assert build["version"] == "v2.0.0-alpha-312-g0123456"
    assert build["dirty"] is False
    assert build["installed_at"] == "2026-10-07T08:00:00+00:00"
    assert build["commit_url"] == f"https://github.com/jeremyspofford/nova/commit/{COMMIT}"
    assert build["reason"] is None


def test_no_stamp_says_so_and_borrows_nothing(monkeypatch):
    _stamp(monkeypatch, **{about.COMMIT_ENV: None, about.VERSION_ENV: None})
    build = about.build_info()
    assert build["commit"] is None and build["short"] is None and build["dirty"] is None
    assert build["reason"] == about.NOT_STAMPED


@pytest.mark.parametrize("bad", ["main", "0123456", COMMIT + "0", "g" * 40, "$(id)"])
def test_a_commit_of_the_wrong_shape_is_not_shown(monkeypatch, bad):
    _stamp(monkeypatch, **{about.COMMIT_ENV: bad})
    assert about.build_info()["commit"] is None


# -- is there anything newer ---------------------------------------------


async def test_new_commits_on_the_branch_are_listed_newest_first(monkeypatch):
    _stamp(monkeypatch)
    calls: list = []
    _github(body=_compare_body("ahead", 2, 0, NEWER), calls=calls)
    result = await about.check_updates(app)
    assert result["state"] == "available"
    assert result["behind_by"] == 2
    assert [c["sha"] for c in result["commits"]] == list(reversed(NEWER))
    assert result["latest"]["message"] == "commit 1"
    assert calls == [f"https://api.github.com/repos/jeremyspofford/nova/compare/{COMMIT}...main"]


@pytest.mark.parametrize(
    ("status", "ahead", "behind", "state"),
    [
        ("identical", 0, 0, "up_to_date"),
        ("behind", 0, 3, "local_ahead"),
        ("diverged", 1, 2, "diverged"),
    ],
)
async def test_each_relation_github_states_is_named(monkeypatch, status, ahead, behind, state):
    _stamp(monkeypatch)
    _github(body=_compare_body(status, ahead, behind, NEWER[:ahead]))
    result = await about.check_updates(app)
    assert result["state"] == state
    assert (result["behind_by"], result["ahead_by"]) == (ahead, behind)


async def test_a_list_github_cut_short_names_no_newest_commit(monkeypatch):
    """Unpaginated, GitHub stops at 250, oldest first: what it listed does not
    hold the newest commit, so none is named as the newest."""
    _stamp(monkeypatch)
    _github(body=_compare_body("ahead", 300, 0, NEWER))
    result = await about.check_updates(app)
    assert result["state"] == "available" and result["behind_by"] == 300
    assert result["commits"] == [] and result["latest"] is None
    assert "too many for GitHub to list" in about.render(
        {**_empty_topology(), "build": about.build_info(), "updates": result}
    )


@pytest.mark.parametrize(
    ("status", "words"),
    [(404, "never pushed"), (403, "hourly limit"), (500, "answered 500")],
)
async def test_a_failed_check_is_unknown_with_its_reason(monkeypatch, status, words):
    _stamp(monkeypatch)
    _github(status=status)
    result = await about.check_updates(app)
    assert result["state"] == "unknown"
    assert words in result["reason"]


async def test_an_unreachable_github_is_unknown_never_up_to_date(monkeypatch):
    _stamp(monkeypatch)

    def refuse(request):
        raise httpx.ConnectError("no route to host")

    app.state.github_transport = httpx.MockTransport(refuse)
    result = await about.check_updates(app)
    assert result["state"] == "unknown"
    assert "could not be reached" in result["reason"]


@pytest.mark.parametrize(
    ("over", "words"),
    [
        ({about.COMMIT_ENV: None}, "no build stamp"),
        ({about.REPO_ENV: None}, "NOVA_REPO is unset"),
        ({about.REPO_BRANCH_ENV: None}, "NOVA_REPO_BRANCH is unset"),
    ],
)
async def test_without_a_stamp_or_repository_nothing_is_asked(monkeypatch, over, words):
    _stamp(monkeypatch, **over)
    calls: list = []
    _github(body=_compare_body("identical", 0, 0), calls=calls)
    result = await about.check_updates(app)
    assert result["state"] == "unknown" and words in result["reason"]
    assert calls == []


async def test_the_check_is_cached_and_a_refresh_is_floored(monkeypatch):
    _stamp(monkeypatch)
    calls: list = []
    _github(body=_compare_body("identical", 0, 0), calls=calls)
    await about.check_updates(app)
    await about.check_updates(app)
    await about.check_updates(app, refresh=True)  # younger than the floor
    assert len(calls) == 1
    key = ("jeremyspofford/nova", "main", COMMIT)
    stamp, result = about._updates_cache[key]
    about._updates_cache[key] = (stamp - about.REFRESH_FLOOR_S - 1, result)
    await about.check_updates(app)  # still inside the ten minutes
    assert len(calls) == 1
    await about.check_updates(app, refresh=True)
    assert len(calls) == 2


# -- what a client is ----------------------------------------------------

IPHONE = (
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 "
    "(KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1"
)
MAC_CHROME = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/129.0 Safari/537.36"
)


@pytest.mark.parametrize(
    ("ua", "display", "label"),
    [
        (IPHONE, "standalone", "Installed app (PWA) on iPhone"),
        (IPHONE, "browser", "Safari on iPhone"),
        (MAC_CHROME, "browser", "Chrome on Mac"),
        ("curl/8.0", None, "An unrecognised client"),
    ],
)
def test_a_client_is_described_from_what_it_said(ua, display, label):
    assert about.describe_client(ua, display)["label"] == label


def test_only_the_two_displays_are_stored_and_the_agent_is_cleaned():
    agent, shown = identity.client_description("a\x00b\n" + "x" * 400, "Standalone ")
    assert shown == "standalone"
    assert "\x00" not in agent and "\n" not in agent and len(agent) == identity.USER_AGENT_MAX
    assert identity.client_description(None, "fullscreen") == (None, None)


# -- end to end, against postgres -----------------------------------------


def _empty_topology() -> dict:
    return {
        "hub": {"address": None, "address_reason": "no tailnet", "agent": None},
        "satellites": [],
        "model_machines": {"machines": [], "reason": None},
        "services": [],
        "clients": {"clients": [], "unseen": 0, "window_days": 30},
    }


@requires_db
async def test_the_installed_app_is_recorded_and_shown(
    owner_client, pool, mount_peers, monkeypatch
):
    _stamp(monkeypatch)
    _github(body=_compare_body("ahead", 2, 0, NEWER))
    gateway = fakes.FakeGateway()
    gateway.engines = [fakes.engine_view("hub"), fakes.engine_view("dell")]
    mount_peers(gateway=gateway, memory=fakes.FakeMemory())

    resp = await owner_client.get(
        "/api/v1/about", headers={"user-agent": IPHONE, "x-nova-display": "standalone"}
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()

    assert body["build"]["short"] == COMMIT[:7]
    assert body["updates"]["state"] == "available"
    assert [m["name"] for m in body["model_machines"]["machines"]] == ["hub", "dell"]
    assert {s["name"]: s["state"] for s in body["services"]} == {
        "core": "up",
        "gateway": "up",
        "memory": "up",
    }
    [client] = body["clients"]["clients"]
    assert client["label"] == "Installed app (PWA) on iPhone"
    assert client["person"] == "jeremy"

    row = await pool.fetchrow("SELECT user_agent, display, last_seen_at FROM sessions")
    assert row["display"] == "standalone" and row["user_agent"] == IPHONE
    assert row["last_seen_at"] is not None


@requires_db
async def test_a_request_that_does_not_say_never_erases_what_one_did(owner_client, pool):
    await owner_client.get("/api/v1/auth/state", headers={"x-nova-display": "standalone"})
    identity._touched.clear()
    await owner_client.get("/api/v1/auth/state")
    assert await pool.fetchval("SELECT display FROM sessions") == "standalone"


@requires_db
async def test_an_unreadable_gateway_is_stated_not_emptied(owner_client, mount_peers, monkeypatch):
    _stamp(monkeypatch)
    _github(body=_compare_body("identical", 0, 0))
    gateway = fakes.FakeGateway()
    gateway.engines = None
    gateway.health_status = 503
    mount_peers(gateway=gateway, memory=fakes.FakeMemory())
    body = (await owner_client.get("/api/v1/about")).json()
    assert body["model_machines"]["machines"] is None
    assert body["model_machines"]["reason"]
    gw = next(s for s in body["services"] if s["name"] == "gateway")
    assert gw["state"] == "unhealthy"


@requires_db
async def test_devices_split_into_the_hub_and_the_rest(
    owner_client, pool, mount_peers, monkeypatch
):
    _stamp(monkeypatch)
    _github(body=_compare_body("identical", 0, 0))
    mount_peers(gateway=fakes.FakeGateway(), memory=fakes.FakeMemory())
    for name, transport in (("mini-pc", "host"), ("dell", "tailnet")):
        await pool.execute(
            "INSERT INTO devices (name, platform, hostname, pubkey, last_transport, last_seen) "
            "VALUES ($1, 'linux', $1, $2, $3, now())",
            name,
            ("a" if name == "dell" else "b") * 64,
            transport,
        )
    body = (await owner_client.get("/api/v1/about")).json()
    assert body["hub"]["agent"]["name"] == "mini-pc"
    assert [d["name"] for d in body["satellites"]] == ["dell"]


@requires_db
async def test_nova_about_is_the_same_read_in_words(owner_client, pool, mount_peers, monkeypatch):
    _stamp(monkeypatch)
    _github(body=_compare_body("ahead", 2, 0, NEWER))
    mount_peers(gateway=fakes.FakeGateway(), memory=fakes.FakeMemory())
    await owner_client.get(
        "/api/v1/auth/state", headers={"user-agent": IPHONE, "x-nova-display": "standalone"}
    )
    person = await identity.owner(pool)
    ctx = tools.context_for(app, person)
    text, ok = await tools.dispatch("nova_about", {}, ctx)
    assert ok, text
    assert f"running commit {COMMIT[:7]}" in text
    assert "2 new commit(s) on main" in text
    assert "Installed app (PWA) on iPhone" in text
    assert "OTHER MACHINES RUNNING NOVA'S AGENT\n  none" in text


def test_render_names_what_it_could_not_read():
    now = datetime.now(UTC)
    data = {
        **_empty_topology(),
        "build": {**about.build_info(), "commit": None, "reason": about.NOT_STAMPED},
        "updates": about._unknown("no build stamp", now),
        "model_machines": {"machines": None, "reason": "the gateway is down"},
    }
    text = about.render(data, now + timedelta(seconds=1))
    assert "unknown: " + about.NOT_STAMPED in text
    assert "could not be read: the gateway is down" in text
    assert json.dumps(data)  # the page's shape is plain JSON


@requires_db
async def test_signing_in_again_from_one_browser_is_still_one_client(client, pool):
    from tests.conftest import OWNER

    await client.post("/api/v1/auth/register", json=OWNER)
    for _ in range(2):
        client.cookies.clear()
        resp = await client.post("/api/v1/auth/login", json=OWNER)
        assert resp.status_code == 200, resp.text
        identity._touched.clear()
        await client.get(
            "/api/v1/auth/state", headers={"user-agent": IPHONE, "x-nova-display": "standalone"}
        )
    assert await pool.fetchval("SELECT count(*) FROM sessions WHERE last_seen_at IS NOT NULL") == 2
    seen = await about.clients(pool)
    assert [c["label"] for c in seen["clients"]] == ["Installed app (PWA) on iPhone"]


async def test_a_request_that_says_nothing_is_not_a_change(monkeypatch):
    """The chat stream sends no display header: alternating it with the app's
    own requests must not write on every request."""
    writes: list = []

    class Pool:
        async def execute(self, sql, *args):
            writes.append(args)

    pool = Pool()
    await identity.touch_session(pool, "t", IPHONE, "standalone")
    await identity.touch_session(pool, "t", IPHONE, None)
    await identity.touch_session(pool, "t", IPHONE, "standalone")
    assert len(writes) == 1
    await identity.touch_session(pool, "t", IPHONE, "browser")  # a real change writes at once
    assert len(writes) == 2


@requires_db
async def test_nova_about_records_what_it_read_of_each_agent(
    owner_client, pool, mount_peers, monkeypatch
):
    """She quotes 'dell: not connected' from nova_about; the state guard must
    see that she checked, the way it does after device_list."""
    _stamp(monkeypatch)
    _github(body=_compare_body("identical", 0, 0))
    mount_peers(gateway=fakes.FakeGateway(), memory=fakes.FakeMemory())
    await pool.execute(
        "INSERT INTO devices (name, platform, hostname, pubkey, last_transport) "
        "VALUES ('dell', 'linux', 'dell', $1, 'tailnet')",
        "a" * 64,
    )
    sink: list[dict] = []
    ctx = tools.context_for(app, await identity.owner(pool), facts_sink=sink)
    _text, ok = await tools.dispatch("nova_about", {}, ctx)
    assert ok
    assert {"device": "dell", "connected": False} in sink
