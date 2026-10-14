"""S37c T7: GitHub CI is a sender, by polling (spec §2.7, owner §9 Q1).

Every 5 minutes a job reads the latest workflow runs of the repos the owner
lists, through GitHub's API, with the token the GitHub MCP server already
holds — nothing becomes public. The first poll of a repo only records a
baseline (a row, so it survives restarts) and files nothing. After it, a run
completed later that turns green -> red, or ends red on a new commit or a new
branch, files ONE `github_ci` event (keyed by the run, so it never files twice,
across restarts); the scheduler's tick starts her turn on it.

The token is a secret: it goes out as the Authorization header to GitHub and
nowhere else — not a log line, the job's result, a span, a raised reason or a
payload. A poll that cannot run says why. Tests never call github.com: every
request goes through a fake transport."""

from __future__ import annotations

import asyncio
import json
import logging
from datetime import UTC, datetime, timedelta

import httpx
import pytest
from fastapi import HTTPException

from app import chat, events, events_ci, scheduler, settings_store, timers
from app.main import app
from tests.conftest import requires_db
from tests.fakes import FakeGateway, FakeMemory

MODEL = "qwen3:8b"
TOKEN = "github_pat_SENTINEL_9f3c2a7d1e"
NOW = datetime(2026, 10, 14, 12, 0, tzinfo=UTC)


def _run(
    run_id: int,
    conclusion: str,
    sha: str,
    *,
    workflow_id: int = 1,
    name: str = "CI",
    branch: str = "main",
    attempt: int = 1,
    ago: timedelta = timedelta(minutes=10),
) -> dict:
    return {
        "id": run_id,
        "name": name,
        "workflow_id": workflow_id,
        "head_branch": branch,
        "head_sha": sha,
        "run_attempt": attempt,
        "status": "completed",
        "conclusion": conclusion,
        "html_url": f"https://github.com/o/r/actions/runs/{run_id}",
        "display_title": f"commit {sha}",
        "event": "push",
        "updated_at": (NOW - ago).isoformat().replace("+00:00", "Z"),
    }


class Fake:
    """GitHub, faked: per repo a list of runs (newest first), an HTTP status
    with a body and headers, or an exception to raise. Every request kept."""

    def __init__(self, repos: dict | None = None) -> None:
        self.repos: dict = repos or {}
        self.requests: list[httpx.Request] = []

    def handler(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        parts = request.url.path.strip("/").split("/")
        repo = "/".join(parts[1:3])
        answer = self.repos.get(repo)
        if isinstance(answer, Exception):
            raise answer
        if isinstance(answer, tuple):
            status, body, headers = answer
            return httpx.Response(status, json=body, headers=headers)
        if answer is None:
            return httpx.Response(404, json={"message": "Not Found"})
        return httpx.Response(200, json={"total_count": len(answer), "workflow_runs": answer})

    @property
    def transport(self) -> httpx.MockTransport:
        return httpx.MockTransport(self.handler)


@pytest.fixture(autouse=True)
def _never_github(monkeypatch):
    """No test reaches github.com: the module's default transport is replaced
    by one that fails the test, so a test that forgot its fake is loud."""

    def refuse(request: httpx.Request) -> httpx.Response:
        raise AssertionError(f"a test reached the network: {request.url}")

    monkeypatch.setattr(events_ci, "TRANSPORT", httpx.MockTransport(refuse))


async def _github(pool, *, token=TOKEN, headers=None, name="github", url=None) -> None:
    await pool.execute(
        "INSERT INTO mcp_servers (name, url, token, headers, added_by) "
        "VALUES ($1, $2, $3, $4::jsonb, 'owner')",
        name,
        url or "https://api.githubcopilot.com/mcp/",
        token,
        headers or {"X-MCP-Toolsets": "actions"},
    )


async def _repos(pool, value: str) -> None:
    await pool.execute(
        "INSERT INTO settings (key, value) VALUES ($1, $2::jsonb) "
        "ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value",
        events_ci.REPOS_KEY,
        value,
    )


# Long before every run the filing tests build: the baseline the earlier,
# already-done first poll of a listed repo would have left.
BASELINED_AT = NOW - timedelta(days=2)


async def _baseline(pool, *repos: str, at: datetime = BASELINED_AT) -> None:
    """Seed each repo's baseline row, as its first poll would have."""
    for repo in repos:
        await pool.execute(
            "INSERT INTO github_ci_baselines (repo, baselined_at) VALUES ($1, $2)", repo, at
        )


async def _baselines(pool) -> dict:
    rows = await pool.fetch("SELECT repo, baselined_at FROM github_ci_baselines")
    return {r["repo"]: r["baselined_at"] for r in rows}


async def _ready(pool, repos: str = "o/r", *, baseline: bool = True) -> None:
    """The sender, the GitHub row and the listed repos; with `baseline`, each
    repo was already polled once (its baseline row is seeded), so the poll
    under test applies the filing rules."""
    await events.ensure_builtins(pool)
    await _github(pool)
    await _repos(pool, repos)
    if baseline:
        await _baseline(pool, *events_ci.parse_repos(repos))


async def _poll(pool, fake: Fake) -> str:
    return await events_ci.poll(pool, transport=fake.transport, now=NOW)


async def _ci_events(pool) -> list:
    return await pool.fetch(
        "SELECT * FROM events WHERE sender = 'github_ci' ORDER BY received_at, id"
    )


# -- C1: the job, the setting, and nothing to poll -------------------------------------------


def test_the_job_is_registered_every_five_minutes():
    assert timers.JOBS["github_ci"] is events_ci.github_ci
    assert timers.JOB_SCHEDULES["github_ci"] == {"kind": "minutes", "every": 5}
    assert timers.JOB_TITLES["github_ci"]


@requires_db
async def test_startup_seeds_the_job_row(pool):
    await timers.ensure_jobs(pool)
    row = await pool.fetchrow("SELECT * FROM timers WHERE payload->>'handler' = 'github_ci'")
    assert row is not None and row["kind"] == "job"
    assert row["schedule"] == {"kind": "minutes", "every": 5}


def test_the_repos_setting_is_validated():
    definition = settings_store.validated(events_ci.REPOS_KEY, "o/r, other-org/repo.name_2")
    assert definition.default == ""
    assert events_ci.parse_repos("o/r, a-b/c.d_e  x/y\nz/w") == ["o/r", "a-b/c.d_e", "x/y", "z/w"]
    assert events_ci.parse_repos("  ") == []
    assert events_ci.parse_repos("o/r o/r") == ["o/r"]
    for bad in ("nope", "o/r/x", "https://github.com/o/r", "o/r; rm"):
        with pytest.raises(HTTPException) as caught:
            settings_store.validated(events_ci.REPOS_KEY, bad)
        assert caught.value.status_code == 400
        assert "owner/repo" in caught.value.detail
    too_many = " ".join(f"o/r{i}" for i in range(events_ci.MAX_REPOS + 1))
    with pytest.raises(HTTPException) as caught:
        settings_store.validated(events_ci.REPOS_KEY, too_many)
    assert str(events_ci.MAX_REPOS) in caught.value.detail


@requires_db
async def test_with_no_repos_nothing_is_called_and_that_is_stated(pool):
    await events.ensure_builtins(pool)
    await _github(pool)
    fake = Fake()
    result = await _poll(pool, fake)
    assert "nothing polled" in result and events_ci.REPOS_KEY in result
    assert fake.requests == []
    assert await _ci_events(pool) == []


@requires_db
async def test_with_the_sender_off_nothing_is_called_and_that_is_stated(pool):
    await _ready(pool)
    await pool.execute("UPDATE event_senders SET enabled = false WHERE name = 'github_ci'")
    fake = Fake({"o/r": [_run(2, "failure", "b"), _run(1, "success", "a")]})
    result = await _poll(pool, fake)
    assert "nothing polled" in result and "off" in result
    assert fake.requests == []
    assert await _ci_events(pool) == []


# -- C2: what files an event -----------------------------------------------------------------


@requires_db
async def test_green_to_red_files_one_event(pool):
    await _ready(pool)
    fake = Fake({"o/r": [_run(2, "failure", "bbb"), _run(1, "success", "aaa")]})
    result = await _poll(pool, fake)
    (row,) = await _ci_events(pool)
    assert row["state"] == "queued" and row["content_type"] == "application/json"
    assert row["urgent"] is False
    assert row["fingerprint"] == "github_ci:o/r:2"
    payload = json.loads(row["payload"])
    assert payload["repo"] == "o/r" and payload["run_id"] == 2
    assert payload["workflow"] == "CI" and payload["branch"] == "main"
    assert payload["head_sha"] == "bbb" and payload["conclusion"] == "failure"
    assert payload["url"] == "https://github.com/o/r/actions/runs/2"
    assert payload["title"] == "commit bbb" and payload["run_attempt"] == 1
    assert "green" in payload["why"]
    assert payload["previous"] == {"run_id": 1, "conclusion": "success", "head_sha": "aaa"}
    assert "1 event filed" in result and "o/r" in result
    last = await pool.fetchval("SELECT last_sent_at FROM event_senders WHERE name = 'github_ci'")
    assert last is not None


@requires_db
async def test_the_poll_asks_github_for_completed_runs_with_its_headers(pool):
    await _ready(pool)
    fake = Fake({"o/r": [_run(1, "success", "a")]})
    await _poll(pool, fake)
    (request,) = fake.requests
    assert request.url.scheme == "https" and request.url.host == "api.github.com"
    assert request.url.path == "/repos/o/r/actions/runs"
    assert request.url.params["status"] == "completed"
    assert request.url.params["per_page"] == str(events_ci.PER_PAGE)
    assert request.headers["authorization"] == f"Bearer {TOKEN}"
    assert request.headers["accept"] == "application/vnd.github+json"
    assert request.headers["x-github-api-version"]


@requires_db
async def test_red_on_a_new_commit_files(pool):
    await _ready(pool)
    fake = Fake({"o/r": [_run(2, "failure", "bbb"), _run(1, "failure", "aaa")]})
    await _poll(pool, fake)
    (row,) = await _ci_events(pool)
    payload = json.loads(row["payload"])
    assert payload["run_id"] == 2 and "new commit" in payload["why"]


@requires_db
async def test_red_again_on_the_same_commit_files_nothing(pool):
    await _ready(pool)
    fake = Fake({"o/r": [_run(2, "failure", "aaa"), _run(1, "timed_out", "aaa")]})
    result = await _poll(pool, fake)
    assert await _ci_events(pool) == []
    assert "0 events filed" in result


@requires_db
async def test_a_green_latest_run_files_nothing(pool):
    await _ready(pool)
    fake = Fake(
        {"o/r": [_run(3, "success", "c"), _run(2, "failure", "b"), _run(1, "success", "a")]}
    )
    await _poll(pool, fake)
    assert await _ci_events(pool) == []


@requires_db
async def test_a_red_run_with_nothing_before_it_in_the_page_files(pool):
    await _ready(pool)
    await _poll(pool, Fake({"o/r": [_run(7, "startup_failure", "s")]}))
    (row,) = await _ci_events(pool)
    payload = json.loads(row["payload"])
    assert payload["run_id"] == 7 and payload["previous"] is None


@requires_db
async def test_each_workflow_and_branch_is_read_on_its_own(pool):
    await _ready(pool)
    runs = [
        _run(6, "success", "x", workflow_id=1, branch="main"),
        _run(5, "failure", "x", workflow_id=2, name="Lint", branch="main"),
        _run(4, "failure", "y", workflow_id=1, branch="feature"),
        _run(3, "success", "w", workflow_id=2, name="Lint", branch="main"),
        _run(2, "failure", "v", workflow_id=1, branch="main"),
        _run(1, "success", "u", workflow_id=1, branch="feature"),
    ]
    await _poll(pool, Fake({"o/r": runs}))
    filed = sorted(json.loads(r["payload"])["run_id"] for r in await _ci_events(pool))
    assert filed == [4, 5]


@requires_db
async def test_runs_older_than_the_lookback_file_nothing(pool):
    await _ready(pool)
    old = events_ci.LOOKBACK + timedelta(minutes=1)
    fake = Fake({"o/r": [_run(2, "failure", "b", ago=old), _run(1, "success", "a", ago=old)]})
    await _poll(pool, fake)
    assert await _ci_events(pool) == []


@requires_db
async def test_runs_that_are_neither_green_nor_red_never_file_and_are_passed_over(pool):
    await _ready(pool)
    fake = Fake(
        {
            "o/r": [
                _run(4, "cancelled", "d"),
                _run(3, "failure", "c"),
                _run(2, "skipped", "b"),
                _run(1, "success", "a"),
            ]
        }
    )
    await _poll(pool, fake)
    (row,) = await _ci_events(pool)
    payload = json.loads(row["payload"])
    assert payload["run_id"] == 3 and payload["previous"]["run_id"] == 1
    await pool.execute("DELETE FROM events")
    await _poll(pool, Fake({"o/r": [_run(9, "cancelled", "z")]}))
    assert await _ci_events(pool) == []


@requires_db
async def test_every_listed_repo_is_read(pool):
    await _ready(pool, "o/r, p/q")
    fake = Fake(
        {
            "o/r": [_run(2, "failure", "b"), _run(1, "success", "a")],
            "p/q": [_run(12, "failure", "y"), _run(11, "success", "x")],
        }
    )
    result = await _poll(pool, fake)
    assert sorted(r["fingerprint"] for r in await _ci_events(pool)) == [
        "github_ci:o/r:2",
        "github_ci:p/q:12",
    ]
    assert [r.url.path for r in fake.requests] == [
        "/repos/o/r/actions/runs",
        "/repos/p/q/actions/runs",
    ]
    assert "2 events filed" in result


@requires_db
async def test_the_tick_starts_her_turn_on_the_filed_event(pool, mount_peers):
    await pool.execute("INSERT INTO people (name, role) VALUES ('jeremy', 'owner')")
    await pool.execute("INSERT INTO settings (key, value) VALUES ('chat.model', $1::jsonb)", MODEL)
    mount_peers(gateway=FakeGateway(deltas=("the lint step broke",)), memory=FakeMemory())
    await _ready(pool)
    await _poll(pool, Fake({"o/r": [_run(2, "failure", "b"), _run(1, "success", "a")]}))
    assert await events.start_queued(app, pool) == ["github_ci"]
    await chat.drain_background()
    (row,) = await _ci_events(pool)
    assert row["state"] == "done"
    turn = await pool.fetchrow("SELECT * FROM turns WHERE id = $1", row["turn_id"])
    assert turn["kind"] == "event" and turn["role"] == "event_github_ci"


# -- C3: one event per failing run, across restarts ----------------------------------------


@requires_db
async def test_a_second_poll_files_the_same_run_once(pool):
    await _ready(pool)
    fake = Fake({"o/r": [_run(2, "failure", "b"), _run(1, "success", "a")]})
    await _poll(pool, fake)
    second = await _poll(pool, fake)
    assert len(await _ci_events(pool)) == 1
    assert "0 events filed" in second


@requires_db
@pytest.mark.parametrize("state", ["queued", "running", "done", "failed"])
async def test_a_run_already_filed_is_never_filed_again_whatever_its_state(pool, state):
    """The key lives in the events table, so a restarted core (no memory of
    the last poll) still knows the run was filed."""
    await _ready(pool)
    await pool.execute(
        "INSERT INTO events (sender, payload, state, fingerprint) VALUES "
        "('github_ci', '{}', $1, 'github_ci:o/r:2')",
        state,
    )
    await _poll(pool, Fake({"o/r": [_run(2, "failure", "b"), _run(1, "success", "a")]}))
    assert len(await _ci_events(pool)) == 1


@requires_db
async def test_a_rerun_of_the_same_failing_run_is_not_filed_again(pool):
    await _ready(pool)
    await _poll(pool, Fake({"o/r": [_run(2, "failure", "b"), _run(1, "success", "a")]}))
    rerun = Fake({"o/r": [_run(2, "failure", "b", attempt=2), _run(1, "success", "a")]})
    await _poll(pool, rerun)
    assert len(await _ci_events(pool)) == 1


@requires_db
async def test_two_polls_at_once_file_one(pool):
    await _ready(pool)
    fake = Fake({"o/r": [_run(2, "failure", "b"), _run(1, "success", "a")]})
    await asyncio.gather(*(_poll(pool, fake) for _ in range(5)))
    assert len(await _ci_events(pool)) == 1


@requires_db
async def test_filings_of_one_run_at_once_file_one(pool):
    """The key check and the insert run under the run's own lock: without it,
    filings racing on one run each read "not filed yet" and each insert."""
    await events.ensure_builtins(pool)
    runs = [_run(2, "failure", "b"), _run(1, "success", "a")]
    payload = events_ci._findings("o/r", runs, NOW, BASELINED_AT)[0]
    filed = await asyncio.gather(*(events_ci._file(pool, payload) for _ in range(8)))
    assert filed.count(True) == 1
    assert len(await _ci_events(pool)) == 1


# -- C3b: the first poll of a repo is a baseline ------------------------------------------


@requires_db
async def test_the_first_poll_of_a_repo_records_a_baseline_and_files_nothing(pool):
    """The incident (event turn 314390b4, run 38448065811): a run that went red
    before the repo was listed, with nothing before it in the page, filed on
    the first poll. On first sight the state is recorded, never news."""
    await _ready(pool, baseline=False)
    fake = Fake(
        {
            "o/r": [
                _run(9, "failure", "f", branch="fix/guard-followups"),
                _run(2, "failure", "b"),
                _run(1, "success", "a"),
            ]
        }
    )
    result = await _poll(pool, fake)
    assert await _ci_events(pool) == []
    assert await _baselines(pool) == {"o/r": NOW}
    assert "o/r (baseline recorded, 0 events filed)" in result
    assert result.startswith("0 events filed")


@requires_db
async def test_a_second_poll_of_the_same_runs_after_the_baseline_files_nothing(pool):
    await _ready(pool, baseline=False)
    fake = Fake(
        {
            "o/r": [
                _run(9, "failure", "f", branch="feature"),
                _run(2, "failure", "b"),
                _run(1, "success", "a"),
            ]
        }
    )
    await _poll(pool, fake)
    later = await events_ci.poll(pool, transport=fake.transport, now=NOW + timedelta(minutes=5))
    assert await _ci_events(pool) == []
    assert "o/r (0 events filed)" in later
    assert await _baselines(pool) == {"o/r": NOW}


@requires_db
async def test_a_red_run_on_a_new_branch_completed_after_the_baseline_files(pool):
    await _ready(pool, baseline=False)
    before = NOW - timedelta(hours=1)
    first = [_run(1, "success", "a", ago=timedelta(hours=2))]
    await events_ci.poll(pool, transport=Fake({"o/r": first}).transport, now=before)
    assert await _ci_events(pool) == []
    runs = [_run(5, "failure", "n", branch="new-branch"), *first]
    await _poll(pool, Fake({"o/r": runs}))
    (row,) = await _ci_events(pool)
    payload = json.loads(row["payload"])
    assert payload["run_id"] == 5 and payload["branch"] == "new-branch"
    assert payload["previous"] is None


@requires_db
async def test_green_to_red_completed_after_the_baseline_files(pool):
    await _ready(pool, baseline=False)
    before = NOW - timedelta(hours=1)
    first = [_run(1, "success", "a", ago=timedelta(hours=2))]
    await events_ci.poll(pool, transport=Fake({"o/r": first}).transport, now=before)
    await _poll(pool, Fake({"o/r": [_run(2, "failure", "b"), *first]}))
    (row,) = await _ci_events(pool)
    payload = json.loads(row["payload"])
    assert payload["run_id"] == 2 and "green" in payload["why"]


@requires_db
async def test_a_green_to_red_completed_before_the_baseline_never_files(pool):
    """Every rule needs the red run completed after the baseline — not only
    the nothing-before-it one — or a pre-listing green->red files on the
    SECOND poll."""
    await _ready(pool, baseline=False)
    await _baseline(pool, "o/r", at=NOW - timedelta(minutes=5))
    fake = Fake(
        {
            "o/r": [
                _run(2, "failure", "b"),
                _run(1, "success", "a"),
                _run(4, "failure", "y", branch="x"),
                _run(3, "failure", "x", branch="x"),
            ]
        }
    )
    await _poll(pool, fake)
    assert await _ci_events(pool) == []


@requires_db
async def test_the_baseline_is_a_row_read_by_every_poll(pool):
    """No memory: a poll with no history in this process reads the row, and
    with the row gone the next poll baselines again."""
    await _ready(pool)
    fake = Fake({"o/r": [_run(2, "failure", "b"), _run(1, "success", "a")]})
    await _poll(pool, fake)
    assert len(await _ci_events(pool)) == 1
    await pool.execute("DELETE FROM events")
    await pool.execute("DELETE FROM github_ci_baselines")
    result = await _poll(pool, fake)
    assert await _ci_events(pool) == []
    assert "baseline recorded" in result
    assert await _baselines(pool) == {"o/r": NOW}


@requires_db
@pytest.mark.parametrize(
    "answer",
    [
        (401, {"message": "Bad credentials"}, {}),
        (429, {"message": "API rate limit exceeded"}, {"x-ratelimit-remaining": "0"}),
    ],
)
async def test_a_failed_first_poll_records_no_baseline(pool, answer):
    await _ready(pool, baseline=False)
    with pytest.raises(events_ci.PollFailed):
        await _poll(pool, Fake({"o/r": answer}))
    assert await _baselines(pool) == {}
    runs = Fake({"o/r": [_run(2, "failure", "b"), _run(1, "success", "a")]})
    result = await events_ci.poll(pool, transport=runs.transport, now=NOW + timedelta(minutes=5))
    assert "baseline recorded" in result
    assert await _ci_events(pool) == []


@requires_db
async def test_two_first_polls_at_once_record_one_baseline_and_file_nothing(pool):
    await _ready(pool, baseline=False)
    fake = Fake({"o/r": [_run(2, "failure", "b"), _run(1, "success", "a")]})
    results = await asyncio.gather(*(_poll(pool, fake) for _ in range(5)))
    assert sum("baseline recorded" in r for r in results) == 1
    assert await _ci_events(pool) == []
    assert list(await _baselines(pool)) == ["o/r"]


# -- C4: the token -----------------------------------------------------------------------------


@requires_db
async def test_the_token_never_leaves_the_authorization_header(pool, caplog, monkeypatch):
    """Through the real firing: the job span, the firing row, every event
    payload and every log line are free of the token — even when GitHub's
    error body echoes it back."""
    caplog.set_level(logging.DEBUG)
    await _ready(pool, "o/r, p/q")
    fake = Fake(
        {
            "o/r": [_run(2, "failure", "b"), _run(1, "success", "a")],
            "p/q": (500, {"message": f"oops Bearer {TOKEN}"}, {}),
        }
    )
    monkeypatch.setattr(events_ci, "TRANSPORT", fake.transport)
    monkeypatch.setattr(events_ci, "_now", lambda: NOW)
    await timers.ensure_jobs(pool)
    job = await pool.fetchrow("SELECT * FROM timers WHERE payload->>'handler' = 'github_ci'")
    await pool.execute(
        "UPDATE timers SET next_fire_at = $1 WHERE kind = 'job' AND id <> $2",
        job["next_fire_at"] + timedelta(days=2),
        job["id"],
    )
    fired = await scheduler.tick_once(app, pool, now=job["next_fire_at"] + timedelta(seconds=1))
    (firing,) = [await pool.fetchrow("SELECT * FROM timer_firings WHERE id = $1", f) for f in fired]
    assert firing["status"] == "error" and "p/q" in firing["reason"]
    spans = await pool.fetch("SELECT * FROM turn_spans WHERE turn_id = $1", firing["turn_id"])
    assert spans
    everything = [
        json.dumps(dict(firing), default=str),
        *(json.dumps(dict(s), default=str) for s in spans),
        *(r["payload"] or "" for r in await pool.fetch("SELECT payload FROM events")),
        caplog.text,
    ]
    assert all(TOKEN not in text for text in everything)
    assert len(await _ci_events(pool)) == 1
    assert all(r.headers["authorization"] == f"Bearer {TOKEN}" for r in fake.requests)


@requires_db
async def test_a_token_kept_in_the_authorization_header_is_used(pool):
    await events.ensure_builtins(pool)
    await _github(pool, token=None, headers={"Authorization": "token HDR_SECRET_42"})
    await _repos(pool, "o/r")
    fake = Fake({"o/r": [_run(1, "success", "a")]})
    await _poll(pool, fake)
    (request,) = fake.requests
    assert request.headers["authorization"] == "token HDR_SECRET_42"


@requires_db
async def test_only_the_github_mcp_row_is_read(pool):
    await events.ensure_builtins(pool)
    await _github(pool, token="NOT_GITHUB", name="aaa-other", url="https://mcp.example.com/mcp")
    await _github(pool, token=TOKEN, name="gh-ci")
    await _repos(pool, "o/r")
    fake = Fake({"o/r": [_run(1, "success", "a")]})
    await _poll(pool, fake)
    assert [r.headers["authorization"] for r in fake.requests] == [f"Bearer {TOKEN}"]


@requires_db
async def test_the_token_never_goes_anywhere_but_github(pool):
    await _ready(pool)
    fake = Fake({"o/r": [_run(2, "failure", "b"), _run(1, "success", "a")]})
    await _poll(pool, fake)
    assert {r.url.host for r in fake.requests} == {"api.github.com"}


# -- C5: a poll that cannot run says why -------------------------------------------------------


@requires_db
async def test_no_github_row_is_stated_as_a_failure(pool):
    await events.ensure_builtins(pool)
    await _github(pool, token="NOT_GITHUB", name="other", url="https://mcp.example.com/mcp")
    await _repos(pool, "o/r")
    fake = Fake()
    with pytest.raises(events_ci.PollFailed) as caught:
        await _poll(pool, fake)
    assert "no GitHub MCP server" in str(caught.value)
    assert "NOT_GITHUB" not in str(caught.value)
    assert fake.requests == []


@requires_db
async def test_a_github_row_without_a_token_is_stated_as_a_failure(pool):
    await events.ensure_builtins(pool)
    await _github(pool, token=None)
    await _repos(pool, "o/r")
    fake = Fake()
    with pytest.raises(events_ci.PollFailed) as caught:
        await _poll(pool, fake)
    assert "no token" in str(caught.value)
    assert fake.requests == []


@requires_db
async def test_a_revoked_token_is_stated(pool, caplog):
    caplog.set_level(logging.DEBUG)
    await _ready(pool)
    fake = Fake({"o/r": (401, {"message": f"Bad credentials {TOKEN}"}, {})})
    with pytest.raises(events_ci.PollFailed) as caught:
        await _poll(pool, fake)
    assert "GitHub refused the token (401)" in str(caught.value)
    assert TOKEN not in str(caught.value) and TOKEN not in caplog.text


@requires_db
@pytest.mark.parametrize("status", [403, 429])
async def test_a_rate_limit_is_stated_with_when_it_resets(pool, status):
    await _ready(pool)
    reset = int((NOW + timedelta(minutes=17)).timestamp())
    fake = Fake(
        {
            "o/r": (
                status,
                {"message": "API rate limit exceeded"},
                {"x-ratelimit-remaining": "0", "x-ratelimit-reset": str(reset)},
            )
        }
    )
    with pytest.raises(events_ci.PollFailed) as caught:
        await _poll(pool, fake)
    assert "rate-limited" in str(caught.value)
    assert "2026-10-14 12:17" in str(caught.value)


@requires_db
async def test_a_forbidden_repo_that_is_not_a_rate_limit_is_stated_as_forbidden(pool):
    await _ready(pool)
    fake = Fake(
        {"o/r": (403, {"message": "Resource not accessible"}, {"x-ratelimit-remaining": "4000"})}
    )
    with pytest.raises(events_ci.PollFailed) as caught:
        await _poll(pool, fake)
    text = str(caught.value)
    assert "o/r" in text and "403" in text and "rate-limited" not in text


@requires_db
async def test_one_repo_failing_still_files_the_others_then_states_it(pool):
    await _ready(pool, "a/b, o/r")
    fake = Fake({"o/r": [_run(2, "failure", "b"), _run(1, "success", "a")]})
    with pytest.raises(events_ci.PollFailed) as caught:
        await _poll(pool, fake)
    text = str(caught.value)
    assert "a/b" in text and "404" in text
    assert "1 event filed" in text
    (row,) = await _ci_events(pool)
    assert row["fingerprint"] == "github_ci:o/r:2"


@requires_db
async def test_a_transport_error_is_named_for_its_repo(pool):
    await _ready(pool)
    fake = Fake({"o/r": httpx.ConnectError("no route to host")})
    with pytest.raises(events_ci.PollFailed) as caught:
        await _poll(pool, fake)
    assert "o/r" in str(caught.value) and "no route to host" in str(caught.value)


@requires_db
async def test_an_answer_that_is_not_a_run_list_is_stated(pool):
    await _ready(pool)
    fake = Fake({"o/r": (200, {"unexpected": True}, {})})
    with pytest.raises(events_ci.PollFailed) as caught:
        await _poll(pool, fake)
    assert "o/r" in str(caught.value) and "workflow_runs" in str(caught.value)


@requires_db
async def test_a_failed_poll_fails_its_firing_with_the_reason(pool, monkeypatch):
    await _ready(pool)
    fake = Fake({"o/r": (401, {"message": "Bad credentials"}, {})})
    monkeypatch.setattr(events_ci, "TRANSPORT", fake.transport)
    await timers.ensure_jobs(pool)
    job = await pool.fetchrow("SELECT * FROM timers WHERE payload->>'handler' = 'github_ci'")
    await pool.execute(
        "UPDATE timers SET next_fire_at = $1 WHERE kind = 'job' AND id <> $2",
        job["next_fire_at"] + timedelta(days=2),
        job["id"],
    )
    (fired,) = await scheduler.tick_once(app, pool, now=job["next_fire_at"] + timedelta(seconds=1))
    firing = await pool.fetchrow("SELECT * FROM timer_firings WHERE id = $1", fired)
    assert firing["status"] == "error"
    assert "GitHub refused the token (401)" in firing["reason"]
