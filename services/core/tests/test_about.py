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
        "model_machines": {"machines": [], "reason": None, "remotes": [], "remotes_reason": None},
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
        "model_machines": {
            "machines": None,
            "reason": "the gateway is down",
            "remotes": [],
            "remotes_reason": None,
        },
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


# -- T3: the remote model machines (the same selection machine_status uses) --
#
# The gateway's providers (/admin/providers) and live walls (/admin/routes) are
# served by the fake gateway's admin echo ({"providers": ..., "walls": ...}),
# so About reads them through the real GatewayPlant.model_providers; the hub's
# engines come from /admin/engines. Each part is made to fail on its own.

from app import machines, model_machines, network  # noqa: E402

DELL_URL = "http://100.122.40.93:11435/v1"
DELL_NAME = "DELL-XPS-8950"
DELL_FACTS = {
    "hostname": DELL_NAME,
    "net": {
        "ifaces": [
            {"name": "Tailscale", "mac": "", "ipv4_cidr": ["100.122.40.93/32"], "up": True},
        ]
    },
}
REMOTE_KEYS = {
    "name",
    "host",
    "state",
    "reason",
    "walled_for_s",
    "answering",
    "models",
    "device",
    "device_said",
}


def _row(name, base_url, listing="unknown", note=None, *, builtin=False) -> dict:
    return {
        "name": name,
        "adapter": "ollama" if builtin else "openai-chat",
        "base_url": base_url,
        "builtin": builtin,
        "listing": listing,
        "listing_note": note,
    }


def _dell_row(listing="available", note="16 models listed") -> dict:
    return _row("dell", DELL_URL, listing, note)


def _gateway_rows(dell: dict | None = None) -> list[dict]:
    return [
        _row("hub", "http://ollama:11434", "available", "3 models listed", builtin=True),
        dell or _dell_row(),
        _row("openrouter", "https://openrouter.ai/api/v1", "available", "300 models listed"),
    ]


def _remote_gateway(*, engines=True, providers_fail=False, dell=None, walls=()):
    gateway = fakes.FakeGateway()
    gateway.engines = [fakes.engine_view("hub")] if engines else None
    gateway.admin_body = {"providers": _gateway_rows(dell), "walls": list(walls)}
    if providers_fail:
        gateway.admin_status = 500
        gateway.admin_body = {"error": "providers boom"}
    return gateway


@pytest.fixture
def no_peers(monkeypatch, tmp_path):
    """No tailnet status file: tailnet_peers is () with its stated reason."""
    monkeypatch.setenv(network.STATUS_FILE_ENV, str(tmp_path / "tailscale.json"))


async def _pair_dell(pool, facts=DELL_FACTS) -> None:
    await pool.execute(
        "INSERT INTO devices (name, platform, hostname, pubkey, facts, facts_at, last_transport) "
        "VALUES ($1, 'windows', $1, $2, $3, now(), 'tailnet')",
        DELL_NAME,
        "d" * 64,
        facts,
    )


def _dell_entry(mm: dict) -> dict:
    remotes = mm.get("remotes")
    assert isinstance(remotes, list), mm
    found = [r for r in remotes if r.get("name") == "dell"]
    assert len(found) == 1, mm
    return found[0]


@requires_db
@pytest.mark.parametrize(
    "dell",
    [
        _dell_row(),
        _dell_row("unknown", "the last listing was refused (502): ConnectTimeout"),
        _dell_row("unknown", None),
    ],
    ids=["answering", "failing", "unknown"],
)
async def test_T3_C1_topology_lists_each_remote_model_machine_with_the_gateways_verdict(
    pool, mount_peers, no_peers, dell
):
    mount_peers(gateway=_remote_gateway(dell=dell), memory=fakes.FakeMemory())
    top = await about.topology(app)
    mm = top["model_machines"]
    assert {"machines", "reason", "remotes", "remotes_reason"} <= set(mm), mm
    assert mm["remotes_reason"] is None
    assert [r["name"] for r in mm["remotes"]] == ["dell"]  # not hub (builtin), not the cloud
    entry = _dell_entry(mm)
    assert set(entry) == REMOTE_KEYS
    assert "base_url" not in entry
    assert entry["host"] == "100.122.40.93"
    state = model_machines.state_of(dell, [], datetime.now(UTC))
    assert {k: entry[k] for k in ("state", "reason", "walled_for_s", "answering")} == state
    # answering is True only when state_of says "answering"; unknown is None (never unverified)
    assert (entry["answering"] is True) == (state["state"] == "answering")
    assert entry["models"] == model_machines.listed_models(dell)
    if state["state"] == "answering":
        assert entry["models"] == 16


@requires_db
async def test_T3_C1_a_live_wall_is_the_remotes_state_with_its_time_left(
    pool, mount_peers, no_peers
):
    until = datetime.now(UTC) + timedelta(minutes=28, seconds=30)
    wall = {
        "provider": "dell",
        "model": "qwen3:8b",
        "walled_until": until.isoformat(),
        "reason": "dell:qwen3:8b refused (502)",
    }
    mount_peers(gateway=_remote_gateway(walls=[wall]), memory=fakes.FakeMemory())
    entry = _dell_entry((await about.topology(app))["model_machines"])
    assert entry["state"] == "walled"
    assert entry["answering"] is False
    assert entry["reason"] == "dell:qwen3:8b refused (502)"
    assert 28 * 60 <= entry["walled_for_s"] <= 28 * 60 + 30


@requires_db
async def test_T3_C1_no_remote_machine_is_an_empty_list_never_null(pool, mount_peers, no_peers):
    gateway = _remote_gateway()
    gateway.admin_body = {"providers": [_gateway_rows()[0], _gateway_rows()[2]], "walls": []}
    mount_peers(gateway=gateway, memory=fakes.FakeMemory())
    mm = (await about.topology(app))["model_machines"]
    assert mm.get("remotes") == [] and "remotes" in mm
    assert mm["remotes_reason"] is None


@requires_db
async def test_T3_C2_a_paired_row_whose_facts_carry_the_host_is_the_remotes_device(
    pool, mount_peers, no_peers
):
    await _pair_dell(pool)
    mount_peers(gateway=_remote_gateway(), memory=fakes.FakeMemory())
    entry = _dell_entry((await about.topology(app))["model_machines"])
    assert entry["device"] == DELL_NAME
    assert entry["device_said"] == f"runs on paired device {DELL_NAME} (its agent's addresses)"


@requires_db
async def test_T3_C2_no_matching_row_names_no_device_in_device_ofs_words(
    pool, mount_peers, no_peers
):
    await _pair_dell(pool, facts={"hostname": DELL_NAME})  # reported no addresses
    mount_peers(gateway=_remote_gateway(), memory=fakes.FakeMemory())
    entry = _dell_entry((await about.topology(app))["model_machines"])
    expected = model_machines.device_of(DELL_URL, [], network.tailnet_peers())
    assert entry["device"] is None
    assert entry["device_said"] == expected["said"]
    assert entry["device_said"].startswith("no paired device is known by 100.122.40.93")


@requires_db
async def test_T3_C2_C6_placement_goes_through_place_with_agents_built_from_the_rows(
    pool, mount_peers, no_peers, monkeypatch
):
    """place() gets identity-only agents from topology's own device rows,
    agents_error None, and the tailnet peers; remotes_of does the selection."""
    await _pair_dell(pool)
    mount_peers(gateway=_remote_gateway(), memory=fakes.FakeMemory())
    placed: list = []
    selected: list = []
    real_place, real_remotes_of = model_machines.place, model_machines.remotes_of

    def place_spy(base_url, agents, agents_error, peers):
        placed.append((base_url, agents, agents_error, peers))
        return real_place(base_url, agents, agents_error, peers)

    def remotes_spy(providers, walls, now):
        selected.append((providers, walls, now))
        return real_remotes_of(providers, walls, now)

    monkeypatch.setattr(model_machines, "place", place_spy)
    monkeypatch.setattr(model_machines, "remotes_of", remotes_spy)
    await about.topology(app)
    assert len(selected) == 1
    assert [p["name"] for p in selected[0][0]] == ["hub", "dell", "openrouter"]
    assert len(placed) == 1
    base_url, agents, agents_error, peers = placed[0]
    assert base_url == DELL_URL
    assert agents_error is None
    assert agents == [
        {
            "name": DELL_NAME,
            "hostname": DELL_NAME,
            "platform": "windows",
            "addresses": ("100.122.40.93",),
        }
    ]
    assert isinstance(peers, network.Peers)


@requires_db
async def test_T3_C3_a_failed_providers_read_states_its_reason_and_keeps_the_engines(
    pool, mount_peers, no_peers
):
    mount_peers(gateway=_remote_gateway(providers_fail=True), memory=fakes.FakeMemory())
    mm = (await about.topology(app))["model_machines"]
    assert "remotes" in mm and mm["remotes"] is None, mm
    try:
        await machines.plant().model_providers(app)
    except machines.PlantUnavailable as exc:
        expected = str(exc)
    else:  # pragma: no cover - the fake must refuse
        raise AssertionError("the fake gateway did not refuse /admin/providers")
    assert mm["remotes_reason"] == expected
    assert [m["name"] for m in mm["machines"]] == ["hub"]
    assert mm["reason"] is None


@requires_db
async def test_T3_C3_a_failed_engines_read_keeps_the_remotes(pool, mount_peers, no_peers):
    mount_peers(gateway=_remote_gateway(engines=False), memory=fakes.FakeMemory())
    mm = (await about.topology(app))["model_machines"]
    assert mm["machines"] is None and mm["reason"]
    assert [r["name"] for r in (mm.get("remotes") or [])] == ["dell"], mm
    assert mm["remotes_reason"] is None


@requires_db
async def test_T3_C4_each_remote_leaves_the_machine_status_fact_on_the_sink(
    pool, mount_peers, no_peers
):
    await _pair_dell(pool)
    mount_peers(gateway=_remote_gateway(), memory=fakes.FakeMemory())
    sink: list[dict] = []
    top = await about.topology(app, sink)
    remote_facts = [f for f in sink if "machine" in f]
    assert len(remote_facts) == 1, sink
    [fact] = remote_facts
    entry = _dell_entry(top["model_machines"])
    remote = {"name": "dell", "state": model_machines.state_of(_dell_row(), [], datetime.now(UTC))}
    assert fact == model_machines.fact_of(remote, DELL_NAME, fact["at"])
    assert fact["answering"] is entry["answering"] is True
    assert datetime.fromisoformat(fact["at"]).tzinfo is not None
    assert {"device": DELL_NAME, "connected": False} in sink  # the existing agent fact stays


@requires_db
async def test_T3_C4_an_empty_sink_with_no_paired_device_still_gets_the_remote_fact(
    pool, mount_peers, no_peers
):
    """No device rows -> nothing else lands on the sink first; an empty list
    is still a turn's sink (only None is the page), so the fact is recorded."""
    mount_peers(gateway=_remote_gateway(), memory=fakes.FakeMemory())
    sink: list[dict] = []
    await about.topology(app, sink)
    remote_facts = [f for f in sink if "machine" in f]
    assert len(remote_facts) == 1, sink
    assert remote_facts[0]["machine"] == "dell"
    assert remote_facts[0]["device"] is None


@requires_db
async def test_T3_C4_unread_remotes_leave_no_remote_fact(pool, mount_peers, no_peers):
    mount_peers(gateway=_remote_gateway(providers_fail=True), memory=fakes.FakeMemory())
    sink: list[dict] = []
    top = await about.topology(app, sink)
    assert "remotes_reason" in top["model_machines"] and top["model_machines"]["remotes_reason"]
    assert [f for f in sink if "machine" in f] == []


@requires_db
async def test_T3_C4_the_page_passes_no_sink_and_records_nothing(pool, mount_peers, no_peers):
    mount_peers(gateway=_remote_gateway(), memory=fakes.FakeMemory())
    top = await about.topology(app, None)
    assert _dell_entry(top["model_machines"])["name"] == "dell"


@requires_db
async def test_T3_C5_the_about_api_returns_the_remotes(
    owner_client, mount_peers, no_peers, monkeypatch
):
    _stamp(monkeypatch)
    _github(body=_compare_body("identical", 0, 0))
    mount_peers(gateway=_remote_gateway(), memory=fakes.FakeMemory())
    resp = await owner_client.get("/api/v1/about")
    assert resp.status_code == 200, resp.text
    mm = resp.json()["model_machines"]
    assert mm.get("remotes_reason", "missing") is None, mm
    entry = _dell_entry(mm)
    assert set(entry) == REMOTE_KEYS
    assert entry["state"] == "answering" and entry["answering"] is True
    assert entry["models"] == 16 and entry["host"] == "100.122.40.93"
    assert [m["name"] for m in mm["machines"]] == ["hub"]


# -- T4: about.render prints the remote model machines under MODEL MACHINES --

_SAID = "runs on DELL-XPS-8950 (its agent's addresses)"


def _remote(
    name="dell",
    state="answering",
    reason="16 models listed",
    *,
    walled_for_s=None,
    models=16,
    host="100.122.40.93",
    device=DELL_NAME,
    said=_SAID,
) -> dict:
    return {
        "name": name,
        "host": host,
        "state": state,
        "reason": reason,
        "walled_for_s": walled_for_s,
        "answering": {"answering": True, "unknown": None}.get(state, False),
        "models": models,
        "device": device,
        "device_said": said,
    }


def _engine(name="hub") -> dict:
    return {
        "name": name,
        "state": "running",
        "serving": True,
        "runtime": "ollama",
        "compute": "gpu",
        "models": 3,
        "reason": None,
    }


def _rendered(machines, remotes, *, reason=None, remotes_reason=None) -> list[str]:
    """The MODEL MACHINES section's lines (header excluded, up to CLIENTS)."""
    now = datetime.now(UTC)
    data = {
        **_empty_topology(),
        "build": {**about.build_info(), "commit": None, "reason": about.NOT_STAMPED},
        "updates": about._unknown("no build stamp", now),
        "model_machines": {
            "machines": machines,
            "reason": reason,
            "remotes": remotes,
            "remotes_reason": remotes_reason,
        },
    }
    lines = about.render(data, now + timedelta(seconds=1)).split("\n")
    start = lines.index("MODEL MACHINES (the gateway's last reading)") + 1
    end = next(i for i, line in enumerate(lines) if line.startswith("CLIENTS"))
    return lines[start:end]


def test_T4_C1_each_remote_prints_one_line_after_the_engines():
    got = _rendered(
        [_engine()],
        [
            _remote(),
            _remote(
                "dell-kev",
                "failing",
                "ConnectTimeout",
                models=None,
                said="no paired device matches",
            ),
        ],
    )
    # T8 C7 deliberate update: state; device. Reason: ... (was state — reason — device).
    assert got[0].startswith("  hub: ")
    assert got[1:] == [
        "  dell (remote, 100.122.40.93): answering, 16 models listed; " + _SAID,
        "  dell-kev (remote, 100.122.40.93): failing; no paired device matches. "
        "Reason: ConnectTimeout",
    ]


@pytest.mark.parametrize("models", [1, 0, None])
def test_T4_C1_the_count_prints_only_when_the_listing_gave_one(models):
    """T8 C7 deliberate update (A3): the count is said once, from the
    listing note in the reason; no separate ", N model(s)" tail whatever
    `models` holds."""
    [line] = _rendered([], [_remote(models=models)])
    assert line == f"  dell (remote, 100.122.40.93): answering, 16 models listed; {_SAID}"
    assert "model(s)" not in line


def test_T4_C1_a_remote_with_no_host_says_remote_never_none():
    [line] = _rendered([], [_remote(host=None)])
    assert line.startswith("  dell (remote): answering")
    assert "None" not in line


@pytest.mark.parametrize(
    ("remote", "words"),
    [
        (_remote("dell", "failing", "ConnectTimeout"), f"failing; {_SAID}. Reason: ConnectTimeout"),
        (
            _remote("dell", "walled", "429", walled_for_s=28 * 60 + 59),
            f"walled for another 28 min; {_SAID}. Reason: 429",
        ),
        (
            _remote("dell", "walled", "429", walled_for_s=30),
            f"walled for less than a minute more; {_SAID}. Reason: 429",
        ),
        (
            _remote("dell", "walled", "429", walled_for_s=None),
            f"walled by the gateway; {_SAID}. Reason: 429",
        ),
        (
            _remote("dell", "unknown", "the gateway has no verdict yet"),
            f"state unknown; {_SAID}. Reason: the gateway has no verdict yet",
        ),
    ],
    ids=["failing", "walled", "walled-under-a-minute", "walled-no-time", "unknown"],
)
def test_T4_C2_the_state_words_are_model_machines_and_never_answering_unverified(remote, words):
    """T8 C7 deliberate update: no ", 16 model(s)" tail; state; device. Reason: ..."""
    [line] = _rendered([], [remote])
    assert line == f"  dell (remote, 100.122.40.93): {words}"
    assert "answering" not in line
    assert "model(s)" not in line


def test_T4_C3_unread_remotes_are_one_stated_line_and_the_engines_still_print():
    got = _rendered([_engine()], None, remotes_reason="GatewayError: providers boom")
    assert got[0].startswith("  hub: ")
    assert got[1:] == ["  remote model machines could not be read: GatewayError: providers boom"]


def test_T4_C3_unread_engines_still_print_every_remote():
    got = _rendered(
        None,
        [_remote(), _remote("dell-kev", "failing", "x", models=None)],
        reason="the gateway is down",
    )
    assert got[0] == "  could not be read: the gateway is down"
    assert [line.split(" (")[0] for line in got[1:]] == ["  dell", "  dell-kev"]


def test_T4_C3_both_unread_state_both_reasons():
    got = _rendered(None, None, reason="engines boom", remotes_reason="providers boom")
    assert got == [
        "  could not be read: engines boom",
        "  remote model machines could not be read: providers boom",
    ]


def test_T4_C4_none_only_when_both_lists_are_read_and_empty():
    assert _rendered([], []) == ["  none"]


def test_T4_C4_no_engines_with_a_remote_is_never_none():
    got = _rendered([], [_remote()])
    assert "  none" not in got
    assert len(got) == 1 and got[0].startswith("  dell (remote, ")


def test_T4_C3_C4_no_engines_with_unread_remotes_is_never_none():
    """An unread remote list is stated, never folded into "none"."""
    assert _rendered([], None, remotes_reason="providers boom") == [
        "  remote model machines could not be read: providers boom"
    ]


def test_T4_C2_render_words_each_remote_through_model_machines_state_words(monkeypatch):
    """T8 C7 deliberate update: the one copy is model_machines.remote_words(entry,
    device_said) — the whole text after "<name> (remote, <host>): ", so render
    adds no count and no device words of its own."""
    seen: list[tuple[str, str]] = []

    def remote_words(entry, device_said):
        seen.append((entry["name"], device_said))
        return f"WORDS<{entry['name']}>"

    monkeypatch.setattr(model_machines, "remote_words", remote_words, raising=False)
    got = _rendered(
        [], [_remote(), _remote("dell-kev", "failing", "x", models=None, said="kev words")]
    )
    assert seen == [("dell", _SAID), ("dell-kev", "kev words")]
    assert got == [
        "  dell (remote, 100.122.40.93): WORDS<dell>",
        "  dell-kev (remote, 100.122.40.93): WORDS<dell-kev>",
    ]


def test_T4_C4_no_remotes_adds_no_line():
    """Guard: holds before T4 (remotes [] prints nothing)."""
    got = _rendered([_engine()], [])
    assert len(got) == 1 and got[0].startswith("  hub: ")


def test_T4_C4_unread_engines_and_no_remotes_is_never_none():
    """Guard: an unread part is stated, never 'none'."""
    assert _rendered(None, [], reason="down") == ["  could not be read: down"]


@requires_db
async def test_T4_C6_nova_about_carries_the_remote_lines_and_only_t3s_facts(
    owner_client, pool, mount_peers, no_peers, monkeypatch
):
    _stamp(monkeypatch)
    _github(body=_compare_body("identical", 0, 0))
    await _pair_dell(pool)
    mount_peers(gateway=_remote_gateway(), memory=fakes.FakeMemory())
    sink: list[dict] = []
    ctx = tools.context_for(app, await identity.owner(pool), facts_sink=sink)
    text, ok = await tools.dispatch("nova_about", {}, ctx)
    assert ok, text
    lines = text.split("\n")
    found = [x for x in lines if x.startswith("  dell (remote")]
    assert len(found) == 1, text
    [line] = found
    # T8 C7 deliberate update: count once, device clause after "; ".
    assert line == (
        "  dell (remote, 100.122.40.93): answering, 16 models listed; "
        f"runs on paired device {DELL_NAME} (its agent's addresses)"
    )
    assert lines.index(line) > lines.index("MODEL MACHINES (the gateway's last reading)")
    assert lines.index(line) < next(i for i, x in enumerate(lines) if x.startswith("CLIENTS"))
    remote_facts = [f for f in sink if "machine" in f]
    assert [(f["machine"], f["device"], f["answering"]) for f in remote_facts] == [
        ("dell", DELL_NAME, True)
    ]


# -- T8: the remote line reads as state; device. Reason: ... (live-shaped) --

_T8_SAID = f"runs on paired device {DELL_NAME} (its agent's addresses)"
_T8_KEV_NOTE = (
    "the last listing was refused (502): could not reach http://100.122.40.93:8009/v1 "
    "— ConnectTimeout"
)


@pytest.mark.parametrize(
    ("remote", "line"),
    [
        (
            _remote(said=_T8_SAID),
            f"  dell (remote, 100.122.40.93): answering, 16 models listed; {_T8_SAID}",
        ),
        (
            _remote("dell-kev", "failing", _T8_KEV_NOTE, models=None, said=_T8_SAID),
            f"  dell-kev (remote, 100.122.40.93): failing; {_T8_SAID}. Reason: {_T8_KEV_NOTE}",
        ),
        (
            _remote(
                "dell", "walled", "429 from upstream", walled_for_s=28 * 60 + 59, said=_T8_SAID
            ),
            f"  dell (remote, 100.122.40.93): walled for another 28 min; {_T8_SAID}. "
            "Reason: 429 from upstream",
        ),
        (
            _remote(
                "dell", "walled", "walled by the gateway", walled_for_s=28 * 60 + 59, said=_T8_SAID
            ),
            f"  dell (remote, 100.122.40.93): walled for another 28 min; {_T8_SAID}",
        ),
        (
            _remote("dell", "walled", "walled by the gateway", walled_for_s=None, said=_T8_SAID),
            f"  dell (remote, 100.122.40.93): walled by the gateway; {_T8_SAID}",
        ),
    ],
    ids=["C2-answering", "C3-failing", "C4-walled-reason", "C5-walled-no-reason", "C5-no-time"],
)
def test_T8_C2_C5_about_render_lines_exact(remote, line):
    [got] = _rendered([], [remote])
    assert got == line
    assert got.count("walled") <= 1
    assert got.count("16 model") <= 1
    assert "model(s)" not in got


def test_T8_C3_the_reasons_own_em_dash_is_the_only_one_and_comes_after_the_device():
    [got] = _rendered([], [_remote("dell-kev", "failing", _T8_KEV_NOTE, said=_T8_SAID)])
    assert got.count("—") == 1
    assert got.index(_T8_SAID) < got.index("Reason: ") < got.index("—")


def test_T8_C1_render_and_machine_status_share_one_wording(monkeypatch):
    """The text after the prefix is model_machines.remote_words(entry, device_said)."""
    entry = _remote("dell-kev", "failing", _T8_KEV_NOTE, said=_T8_SAID)
    fn = getattr(model_machines, "remote_words", None)
    assert callable(fn), "model_machines.remote_words is missing"
    [got] = _rendered([], [entry])
    assert got == "  dell-kev (remote, 100.122.40.93): " + fn(entry, _T8_SAID)
