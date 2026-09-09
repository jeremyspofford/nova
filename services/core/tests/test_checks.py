"""app/checks — the registry and the three fact-check families (S11-2).

What these pin, and why each is a pin and not a wish:
  * the FINGERPRINT is over the derived facts and nothing else: a dict built
    in another order is the same news, a changed value is new news, a
    different subject is a different row, and the sentence is never hashed.
    v3 hashed the model's own text and one model re-worded two findings into
    fourteen phone pushes in eight hours;
  * URGENCY is declared by the CHECK. Exactly the stack family declares it —
    asserted two ways, against the family's own NAMES and against where the
    code lives — so a second urgent family reddens this file, which is the
    mechanical form of Jeremy's one-item list. And a check that did not
    declare it cannot return an urgent finding however it builds one;
  * run_all never raises: a check that explodes, hangs or returns rubbish
    becomes ran=False with the reason in words, and the other checks still
    report. A check that did not run is never "all clear", and `quiet()`
    computes that — including the case nobody thinks about, where NO check ran
    and `all(...)` over an empty list would have said the night was perfect;
  * each family's findings against seeded rows and a fake gateway, and — the
    half that matters most — a peer that could not be reached is a finding
    with its reason, while a ledger that could not be READ is ran=False, not
    a quiet zero.
"""

from __future__ import annotations

import asyncio
import uuid
from dataclasses import replace
from datetime import UTC, datetime, timedelta

import httpx
import pytest

from app import checks, settings_store
from app.checks import CannotCheck, Check, CheckRun, Finding, money, stack, work
from app.main import app as core_app
from tests import fakes
from tests.conftest import requires_db
from tests.fakes import FakeGateway, FakeMemory

SCHEDULE = '{"kind":"day","at":"03:30"}'


# ── helpers ────────────────────────────────────────────────────────────────


class _Dead(httpx.AsyncBaseTransport):
    """A peer whose socket refuses — the "the container is down" case, with a
    real httpx error rather than a patched function."""

    async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("connection refused", request=request)


class _RefusingPool:
    """A pool whose query raises, for the database check. Nothing else on it
    is used, so a stub is honest here in a way it would not be elsewhere."""

    async def fetchval(self, *args, **kwargs):
        raise ConnectionError("the server closed the connection unexpectedly")


class _SilentPool:
    async def fetchval(self, *args, **kwargs):
        await asyncio.sleep(5)
        return 1


def _local(model: str, *, installed: bool = True) -> dict:
    return {
        "id": f"ollama:{model}",
        "provider": "ollama",
        "model": model,
        "kind": "local",
        "installed": installed,
    }


def _catalog(*rows: dict, ollama_ok: bool = True, note: str | None = None) -> dict:
    source: dict = {"key": "ollama", "ok": ollama_ok, "rows": len(rows)}
    if note is not None:
        source["note"] = note
    return {"fetched_at": "2026-09-08T00:00:00+00:00", "sources": [source], "rows": list(rows)}


def _spend(**over) -> dict:
    body = {
        "window": "month",
        "since": "2026-09-01T00:00:00+00:00",
        "until": "2026-09-08T12:00:00+00:00",
        "timezone": "UTC",
        "totals": {"usd": 0.0, "calls": 0},
        "by_provider": [],
        "by_role": [],
        "by_day": [],
    }
    body.update(over)
    return body


async def _person(pool) -> uuid.UUID:
    return await pool.fetchval(
        "INSERT INTO people (name, role) VALUES ('jeremy','owner') RETURNING id"
    )


async def _timer(pool, person_id, **over) -> uuid.UUID:
    row = await pool.fetchrow(
        "INSERT INTO timers (person_id, kind, title, payload, schedule, timezone, created_via, "
        "consecutive_failures, paused_at, paused_reason) "
        f"VALUES ($1, $2, $3, '{{}}'::jsonb, '{SCHEDULE}'::jsonb, 'UTC', 'page', $4, $5, $6) "
        "RETURNING id",
        person_id,
        over.get("kind", "scheduled"),
        over.get("title", "nightly backup"),
        over.get("consecutive_failures", 0),
        over.get("paused_at"),
        over.get("paused_reason"),
    )
    return row["id"]


async def _agent(pool, *, name: str = "coder", cap=None) -> uuid.UUID:
    return await pool.fetchval(
        "INSERT INTO agents (name, purpose, instructions, tools, max_tool_rounds, "
        "monthly_cap_usd, created_via) VALUES ($1, 'writes code', 'be brief', $2, 8, $3, 'page') "
        "RETURNING id",
        name,
        ["get_time"],
        cap,
    )


async def _delegate_span(pool, *, meta: dict, hours_ago: float = 1) -> uuid.UUID:
    turn_id = await pool.fetchval("INSERT INTO turns (kind) VALUES ('chat') RETURNING id")
    return await pool.fetchval(
        "INSERT INTO turn_spans (turn_id, kind, name, started_at, meta) "
        "VALUES ($1, 'tool', 'delegate_to_agent', now() - make_interval(mins => $2), $3::jsonb) "
        "RETURNING id",
        turn_id,
        int(hours_ago * 60),
        meta,
    )


@pytest.fixture
def only(monkeypatch):
    """Run the registry functions over just these checks.

    run_all/run_one read the module-level REGISTRY at call time, so swapping
    it is enough — and it keeps a registry test from making a dozen real
    socket probes it never meant to make.
    """

    def _use(*items: Check) -> None:
        monkeypatch.setattr(checks, "REGISTRY", {item.name: item for item in items})

    return _use


def _check(name: str, run, *, urgent: bool = False, deadline_s: float | None = None) -> Check:
    extra = {} if deadline_s is None else {"deadline_s": deadline_s}
    return Check(name=name, describe=f"{name} (a test)", urgent=urgent, run=run, **extra)


# ── the fingerprint ────────────────────────────────────────────────────────


def test_a_reordered_dict_is_the_same_news():
    """Same facts, any order, nested: one fingerprint. The wording is not part
    of it — a check may rephrase its title without waking anyone twice."""
    one = Finding(
        key="peer_down:gateway",
        title="the gateway is down",
        facts={"peer": "gateway", "reason": "ConnectError", "detail": {"port": 8100, "host": "gw"}},
    )
    two = Finding(
        key="peer_down:gateway",
        title="a completely different sentence",
        facts={"detail": {"host": "gw", "port": 8100}, "reason": "ConnectError", "peer": "gateway"},
    )
    assert checks.fingerprint(one) == checks.fingerprint(two)


def test_a_changed_fact_or_subject_is_new_news():
    base = Finding(
        key="agent_over_cap:coder", title="t", facts={"cap_usd": 20.0, "month": "2026-09"}
    )
    assert checks.fingerprint(base) != checks.fingerprint(
        replace(base, facts={"cap_usd": 25.0, "month": "2026-09"})
    )
    # A new month is new news even at the same cap.
    assert checks.fingerprint(base) != checks.fingerprint(
        replace(base, facts={"cap_usd": 20.0, "month": "2026-10"})
    )
    # Two subjects with identical facts are two rows.
    assert checks.fingerprint(base) != checks.fingerprint(
        replace(base, key="agent_over_cap:scribe")
    )
    # sha256 hex, so the notices column always gets the same shape.
    assert len(checks.fingerprint(base)) == 64


# ── the registry: urgency, and one broken check ────────────────────────────


def test_exactly_the_stack_family_declares_urgent():
    """Jeremy's urgent list has ONE entry: the stack being down. Asserted from
    the family's own NAMES and, independently, from where the code lives — so
    an urgent check smuggled in under another module's name fails too."""
    urgent = {name for name, check in checks.REGISTRY.items() if check.urgent}
    assert urgent == set(stack.NAMES) and urgent, sorted(urgent)
    assert {checks.REGISTRY[name].run.__module__ for name in urgent} == {"app.checks.stack"}
    # And the other two families are registered and not urgent, so this is a
    # statement about the whole registry rather than about an empty one.
    assert set(work.NAMES) | set(money.NAMES) <= set(checks.REGISTRY)
    assert not ({*work.NAMES, *money.NAMES} & urgent)
    assert checks.check_names() == sorted(checks.REGISTRY)
    assert checks.urgent_names() == sorted(urgent)


async def test_a_check_cannot_promote_its_own_finding(only):
    """Urgency is the CHECK's, declared in code. A family that did not declare
    it cannot return an urgent finding, and a family that did cannot return a
    quiet one — nothing inside a check's body gets a vote."""

    async def loud(app, pool):
        return [Finding(key="k", title="t", facts={}, urgent=True)]

    async def meek(app, pool):
        return [Finding(key="k", title="t", facts={}, urgent=False)]

    only(_check("quiet_family", loud), _check("stack_like", meek, urgent=True))
    quiet = await checks.run_one(None, None, "quiet_family")
    assert quiet.ran and [f.urgent for f in quiet.findings] == [False]
    loud_run = await checks.run_one(None, None, "stack_like")
    assert loud_run.ran and [f.urgent for f in loud_run.findings] == [True]


async def test_run_all_never_raises_and_reports_the_broken_check_by_name(only):
    """One check exploding must cost only its own result. The reason is the
    exception in words, so the beat can say what it could not see."""

    async def boom(app, pool):
        raise RuntimeError("the socket melted")

    async def stated(app, pool):
        raise CannotCheck("the ledger did not answer")

    async def fine(app, pool):
        return [Finding(key="k:1", title="something", facts={"a": 1})]

    only(_check("a_boom", boom), _check("b_stated", stated), _check("c_fine", fine))
    runs = await checks.run_all(None, None)
    assert [r.check for r in runs] == ["a_boom", "b_stated", "c_fine"]
    assert runs[0] == CheckRun("a_boom", False, "RuntimeError: the socket melted", ())
    # A deliberate CannotCheck reads as written — no exception class in front.
    assert runs[1] == CheckRun("b_stated", False, "the ledger did not answer", ())
    assert runs[2].ran and runs[2].findings[0].key == "k:1"
    # And the beat can compute quiet rather than claim it.
    assert not all(r.ran for r in runs)


async def test_a_hanging_check_is_bounded_and_says_so(only):
    """S11 (2026-09-08): the bound moved from a module constant to the CHECK.
    review_commitments waits on a local model reading a window of his messages
    and the shared 60 s cut it off on its first live beat, so the deadline now
    describes the probe rather than the cheapest probe in the registry — and
    the stated reason names the bound that was ACTUALLY applied."""

    async def forever(app, pool):
        await asyncio.sleep(5)
        return []

    only(_check("sleepy", forever, deadline_s=0.05))
    run = await checks.run_one(None, None, "sleepy")
    assert (run.ran, run.reason) == (False, "the check did not finish within 0.05s")


async def test_a_check_that_declares_no_deadline_gets_the_registry_default(only):
    async def forever(app, pool):
        await asyncio.sleep(5)
        return []

    only(_check("sleepy", forever))
    assert checks.REGISTRY["sleepy"].deadline_s == checks.CHECK_DEADLINE_S


def test_the_only_check_that_raises_its_own_deadline_is_the_one_that_reads_a_model():
    """A deadline generous enough for a model call would hide a socket probe
    that hung, so raising it is deliberate and stays visible here."""
    raised = {n for n, c in checks.REGISTRY.items() if c.deadline_s != checks.CHECK_DEADLINE_S}
    assert raised == {"review_commitments"}


async def test_rubbish_from_a_check_is_a_check_that_did_not_run(only):
    """A finding with no key could never fold onto anything and a blank title
    says nothing to whoever it wakes; both are refused here rather than stored."""

    async def blank(app, pool):
        return [Finding(key="  ", title="t", facts={})]

    async def wrong(app, pool):
        return "two timers are paused"

    only(_check("blank", blank), _check("wrong", wrong))
    blank_run = await checks.run_one(None, None, "blank")
    assert not blank_run.ran and "no key or no title" in blank_run.reason
    wrong_run = await checks.run_one(None, None, "wrong")
    assert not wrong_run.ran and "not a list of findings" in wrong_run.reason


async def test_run_one_names_the_live_registry_for_a_name_it_does_not_have(only):
    only(_check("only_this", lambda app, pool: None))
    run = await checks.run_one(None, None, "nope")
    assert not run.ran and "no check named 'nope'" in run.reason and "only_this" in run.reason


# ── quiet is computed, and never vacuous ───────────────────────────────────


def test_quiet_is_every_check_ran_and_nothing_was_found():
    assert checks.quiet([CheckRun("a", True, None, ()), CheckRun("b", True, None, ())]) == (
        True,
        None,
    )


def test_an_empty_run_is_not_quiet_because_nothing_was_checked():
    """`all(...)` over no checks is True. That is the all-clear-that-checked-
    nothing in its quietest form — a registry that failed to import would
    report a perfect night — so the empty case is stated, not computed."""
    assert checks.quiet([]) == (False, "no check ran — nothing was checked")


def test_a_check_that_could_not_run_makes_the_beat_not_quiet_and_names_it():
    ok, why = checks.quiet(
        [
            CheckRun("stack_gateway", False, "the gateway link is not configured", ()),
            CheckRun("work_paused_timers", True, None, ()),
        ]
    )
    assert ok is False
    assert "1 check(s) could not run" in why
    assert "stack_gateway — the gateway link is not configured" in why


def test_findings_and_an_unrun_check_are_both_said():
    ok, why = checks.quiet(
        [
            CheckRun("money_caps", True, None, (Finding(key="k:1", title="t", facts={}),)),
            CheckRun("money_daily_spike", False, "the 30d ledger could not be read", ()),
            CheckRun(
                "work_paused_timers",
                True,
                None,
                (Finding(key="k:2", title="t", facts={}), Finding(key="k:3", title="t", facts={})),
            ),
        ]
    )
    assert ok is False
    assert "3 finding(s) from money_caps, work_paused_timers" in why
    assert "money_daily_spike — the 30d ledger could not be read" in why


async def test_quiet_reads_a_real_run_all(only):
    """The registry's own output, not hand-built rows: an all-clear registry
    is quiet, and one broken check is enough to end that."""

    async def nothing(app, pool):
        return []

    async def boom(app, pool):
        raise CannotCheck("the ledger did not answer")

    only(_check("a_fine", nothing), _check("b_fine", nothing))
    assert checks.quiet(await checks.run_all(None, None)) == (True, None)
    only(_check("a_fine", nothing), _check("b_broken", boom))
    ok, why = checks.quiet(await checks.run_all(None, None))
    assert ok is False and "b_broken — the ledger did not answer" in why


# ── stack: the only family that may wake you ───────────────────────────────


@requires_db
async def test_the_stack_is_quiet_when_every_peer_answers(pool, mount_peers):
    mount_peers(gateway=FakeGateway(catalog_body=_catalog(_local("qwen3:8b"))), memory=FakeMemory())
    await settings_store.write_setting(
        settings_store.SettingWrite(key="chat.model", value="ollama:qwen3:8b")
    )
    for name in stack.NAMES:
        run = await checks.run_one(core_app, pool, name)
        assert run.ran, (name, run.reason)
        assert run.findings == (), (name, run.findings)


@requires_db
async def test_a_peer_that_cannot_be_reached_is_a_finding_with_the_reason(pool, mount_peers):
    """The socket refused: that IS the news, and it is urgent because the
    stack family declared it — not because anything wrote the word."""
    mount_peers(gateway=FakeGateway(), memory=FakeMemory())
    core_app.state.peer_transports[fakes.GATEWAY_URL] = _Dead()
    run = await checks.run_one(core_app, pool, "stack_gateway")
    assert run.ran and len(run.findings) == 1
    found = run.findings[0]
    assert found.key == "peer_down:gateway" and found.urgent is True
    assert found.facts["peer"] == "gateway" and found.facts["url"] == fakes.GATEWAY_URL
    assert found.facts["probe"] == "/health/live"
    assert "ConnectError" in found.facts["reason"]
    assert "connection refused" in found.title


@requires_db
async def test_a_peer_answering_something_other_than_200_is_down(pool, mount_peers):
    mount_peers(gateway=FakeGateway(), memory=FakeMemory(health_status=503))
    run = await checks.run_one(core_app, pool, "stack_memory")
    assert run.ran and run.findings[0].key == "peer_down:memory"
    assert run.findings[0].facts["reason"] == "answered HTTP 503 on /health/live"


@requires_db
async def test_an_unconfigured_link_is_a_check_that_did_not_run(pool, mount_peers, monkeypatch):
    """Nothing was probed, so nothing was learned: "down" would be as untrue
    as "up"."""
    mount_peers(gateway=FakeGateway(), memory=FakeMemory())
    monkeypatch.delenv("GATEWAY_URL", raising=False)
    run = await checks.run_one(core_app, pool, "stack_gateway")
    assert not run.ran and run.findings == ()
    assert run.reason == "the gateway link is not configured — GATEWAY_URL is unset"


@requires_db
async def test_ollama_is_read_from_the_gateways_own_catalogue(pool, mount_peers):
    body = _catalog(ollama_ok=False, note="ollama refused: connection refused")
    mount_peers(gateway=FakeGateway(catalog_body=body), memory=FakeMemory())
    run = await checks.run_one(core_app, pool, "stack_ollama")
    assert run.ran and run.findings[0].key == "peer_down:ollama"
    assert run.findings[0].facts == {
        "peer": "ollama",
        "reason": "ollama refused: connection refused",
        "basis": "the gateway's own model catalogue source entry",
    }
    assert run.findings[0].urgent is True


@requires_db
async def test_an_unreachable_gateway_makes_ollama_unknown_not_down(pool, mount_peers, monkeypatch):
    mount_peers(gateway=FakeGateway(), memory=FakeMemory())
    monkeypatch.delenv("GATEWAY_URL", raising=False)
    run = await checks.run_one(core_app, pool, "stack_ollama")
    assert not run.ran and "not configured" in run.reason


@requires_db
async def test_a_chat_model_the_catalogue_does_not_list_is_a_finding(pool, mount_peers):
    mount_peers(gateway=FakeGateway(catalog_body=_catalog(_local("qwen3:8b"))), memory=FakeMemory())
    await settings_store.write_setting(
        settings_store.SettingWrite(key="chat.model", value="qwen3:70b")
    )
    run = await checks.run_one(core_app, pool, "stack_chat_model")
    assert run.ran and run.findings[0].key == "chat_model_missing:qwen3:70b"
    assert run.findings[0].facts["model"] == "qwen3:70b"

    # Listed but not installed (a curated pick) is the same subject, said
    # accurately: the row exists and the weights do not.
    mount_peers(
        gateway=FakeGateway(catalog_body=_catalog(_local("qwen3:70b", installed=False))),
        memory=FakeMemory(),
    )
    run = await checks.run_one(core_app, pool, "stack_chat_model")
    assert run.ran and "not installed" in run.findings[0].title


@requires_db
async def test_a_bare_tag_matches_the_catalogue_row_ollama_would_resolve(pool, mount_peers):
    mount_peers(
        gateway=FakeGateway(catalog_body=_catalog(_local("qwen3:latest"))), memory=FakeMemory()
    )
    await settings_store.write_setting(settings_store.SettingWrite(key="chat.model", value="qwen3"))
    run = await checks.run_one(core_app, pool, "stack_chat_model")
    assert run.ran and run.findings == ()


@requires_db
async def test_an_unset_chat_model_is_a_finding_because_scheduled_turns_refuse(pool, mount_peers):
    """Verified from the settings row alone: the gateway here cannot be
    reached at all, and the fact is still stated — a peer being down must not
    hide a fact that is true either way."""
    mount_peers(gateway=FakeGateway(), memory=FakeMemory())
    core_app.state.peer_transports[fakes.GATEWAY_URL] = _Dead()
    run = await checks.run_one(core_app, pool, "stack_chat_model")
    assert run.ran and run.findings[0].key == "chat_model_unset"
    assert run.findings[0].facts == {"setting": "chat.model", "value": "", "reason": "unset"}


@requires_db
async def test_a_missing_model_is_not_claimed_when_ollama_never_answered(pool, mount_peers):
    """The catalogue with no local rows would make ANY local model look
    uninstalled. That is the silent fallback this slice forbids: the check
    did not run, and says which peer's silence stopped it."""
    body = _catalog(ollama_ok=False, note="ollama refused: connection refused")
    mount_peers(gateway=FakeGateway(catalog_body=body), memory=FakeMemory())
    await settings_store.write_setting(
        settings_store.SettingWrite(key="chat.model", value="qwen3:8b")
    )
    run = await checks.run_one(core_app, pool, "stack_chat_model")
    assert not run.ran and run.findings == ()
    assert "ollama did not answer" in run.reason and "qwen3:8b" in run.reason


def _catalog_calls(gateway: FakeGateway) -> int:
    return sum(1 for path, _ in gateway.seen if path == "/admin/catalog")


@requires_db
async def test_the_catalogue_is_assembled_once_per_beat_and_not_across_beats(
    pool, mount_peers, only
):
    """stack_ollama and stack_chat_model read the same catalogue, and the
    gateway builds it by fanning out to ollama and every provider. One beat
    fetches it once; the NEXT beat fetches it again, because a cached probe is
    a probe that was not made this beat."""
    gateway = FakeGateway(catalog_body=_catalog(_local("qwen3:8b")))
    mount_peers(gateway=gateway, memory=FakeMemory())
    await settings_store.write_setting(
        settings_store.SettingWrite(key="chat.model", value="ollama:qwen3:8b")
    )
    only(checks.REGISTRY["stack_chat_model"], checks.REGISTRY["stack_ollama"])
    runs = await checks.run_all(core_app, pool)
    assert [(r.check, r.ran, r.findings) for r in runs] == [
        ("stack_chat_model", True, ()),
        ("stack_ollama", True, ()),
    ]
    assert _catalog_calls(gateway) == 1
    # The next beat looks again.
    await checks.run_all(core_app, pool)
    assert _catalog_calls(gateway) == 2
    # And a check asked for on its own is its own whole run.
    await checks.run_one(core_app, pool, "stack_ollama")
    await checks.run_one(core_app, pool, "stack_ollama")
    assert _catalog_calls(gateway) == 4


@requires_db
async def test_a_shared_catalogue_still_lets_each_subject_tell_its_own_truth(
    pool, mount_peers, only
):
    """The reason these stay two checks sharing a FETCH rather than folding
    into one check with two findings: on the SAME body, ollama being down is
    an urgent FINDING while whether the chat model is installed is a check
    that COULD NOT RUN. One CheckRun could only have said one of them."""
    gateway = FakeGateway(
        catalog_body=_catalog(ollama_ok=False, note="ollama refused: connection refused")
    )
    mount_peers(gateway=gateway, memory=FakeMemory())
    await settings_store.write_setting(
        settings_store.SettingWrite(key="chat.model", value="qwen3:8b")
    )
    only(checks.REGISTRY["stack_chat_model"], checks.REGISTRY["stack_ollama"])
    model_run, ollama_run = await checks.run_all(core_app, pool)
    assert _catalog_calls(gateway) == 1
    assert ollama_run.ran and ollama_run.findings[0].key == "peer_down:ollama"
    assert ollama_run.findings[0].urgent is True
    assert not model_run.ran and "ollama did not answer" in model_run.reason


@requires_db
async def test_the_database_check_answers_from_the_query(pool):
    assert (await checks.run_one(core_app, pool, "stack_database")).findings == ()
    run = await checks.run_one(core_app, _RefusingPool(), "stack_database")
    assert run.ran and run.findings[0].key == "database_down"
    assert "server closed the connection" in run.findings[0].facts["reason"]
    slow = await checks.run_one(core_app, _SilentPool(), "stack_database")
    assert slow.ran and slow.findings[0].facts["reason"] == "no answer within 2s"


# ── work: the timers, the delegations, the agents ──────────────────────────


@requires_db
async def test_a_paused_timer_is_a_finding_carrying_the_rows_own_reason(pool):
    person = await _person(pool)
    paused = await _timer(
        pool,
        person,
        title="nightly backup",
        paused_at=datetime.now(UTC) - timedelta(hours=3),
        paused_reason="paused after 5 consecutive failures: the disk is full",
        consecutive_failures=5,
    )
    await _timer(pool, person, title="a healthy one")
    run = await checks.run_one(core_app, pool, "work_paused_timers")
    assert run.ran and len(run.findings) == 1
    found = run.findings[0]
    assert found.key == f"timer_paused:{paused}" and found.urgent is False
    assert found.facts["reason"] == "paused after 5 consecutive failures: the disk is full"
    assert found.facts["timer_id"] == str(paused) and found.facts["kind"] == "scheduled"
    assert "nightly backup" in found.title
    # The title is NOT in the facts: renaming a timer is not news about its pause.
    assert "title" not in found.facts


@requires_db
async def test_a_timer_one_failure_from_the_ceiling_is_a_finding(pool):
    """Warned BEFORE it pauses itself, and the threshold is derived from the
    ceiling rather than typed beside it."""
    person = await _person(pool)
    failing = await _timer(pool, person, title="feed sync", consecutive_failures=4)
    await _timer(pool, person, title="fine so far", consecutive_failures=3)
    await _timer(
        pool,
        person,
        title="already stopped",
        consecutive_failures=5,
        paused_at=datetime.now(UTC),
        paused_reason="paused after 5 consecutive failures: nope",
    )
    run = await checks.run_one(core_app, pool, "work_failing_timers")
    assert run.ran and [f.key for f in run.findings] == [f"timer_failing:{failing}"]
    assert run.findings[0].facts == {
        "timer_id": str(failing),
        "kind": "scheduled",
        "consecutive_failures": 4,
        "pause_ceiling": 5,
    }
    assert "pauses itself at 5" in run.findings[0].title
    assert work.WARN_AT_FAILURES == 4


@requires_db
async def test_a_delegation_that_closed_error_in_the_last_day_is_a_finding(pool):
    span = await _delegate_span(
        pool,
        meta={
            "ok": False,
            "error": "Error: agent coder did not finish — its turn closed with status error",
            "facts": [{"agent": "coder", "status": "error"}],
            "args_redacted": {"agent": "coder", "task": "fix the build"},
        },
    )
    await _delegate_span(pool, meta={"ok": True, "result_head": "done"})
    await _delegate_span(pool, meta={"ok": False, "error": "Error: stale"}, hours_ago=30)
    run = await checks.run_one(core_app, pool, "work_failed_delegations")
    assert run.ran and [f.key for f in run.findings] == [f"delegation_failed:{span}"]
    found = run.findings[0]
    assert found.facts["agent"] == "coder" and found.facts["span_id"] == str(span)
    # The tool-result prefix is stripped; the trace's words are kept.
    assert found.facts["error"] == (
        "agent coder did not finish — its turn closed with status error"
    )
    assert "the delegation to coder" in found.title


@requires_db
async def test_a_delegation_span_that_names_no_agent_says_so(pool):
    await _delegate_span(pool, meta={"ok": False, "error": "Error: it fell over"})
    run = await checks.run_one(core_app, pool, "work_failed_delegations")
    assert run.findings[0].facts["agent"] == "(the trace does not name the agent)"


@requires_db
async def test_an_agent_over_its_cap_is_a_finding_and_an_unreadable_ledger_is_not(
    pool, mount_peers, monkeypatch
):
    await _agent(pool, name="coder", cap=20)
    await _agent(pool, name="scribe", cap=100)
    body = _spend(by_role=[{"key": "agent_coder", "local": False, "usd": 21.4, "calls": 3}])
    mount_peers(gateway=FakeGateway(spend_body=body))
    run = await checks.run_one(core_app, pool, "work_agents_over_cap")
    assert run.ran and [f.key for f in run.findings] == ["agent_over_cap:coder"]
    found = run.findings[0]
    assert found.urgent is False
    assert found.facts["agent"] == "coder" and found.facts["cap_usd"] == 20.0
    assert found.facts["role"] == "agent_coder"
    # The live figure is in the sentence, never in the facts: hashing a number
    # that moves with every call would re-raise this notice hourly.
    assert "$21.40 of $20.00" in found.title
    assert "spent_usd" not in found.facts and "spent_month_usd" not in found.facts
    assert found.facts["month"] == datetime.now(UTC).strftime("%Y-%m")

    # A ledger that will not answer is NOT an all-clear.
    monkeypatch.delenv("GATEWAY_URL", raising=False)
    unread = await checks.run_one(core_app, pool, "work_agents_over_cap")
    assert not unread.ran and unread.findings == ()
    assert "ledger unreadable" in unread.reason and "gateway" in unread.reason


@requires_db
async def test_a_timezone_that_does_not_load_is_stated_not_labelled_utc(pool, mount_peers):
    """The month and its zone are in the FACTS, so they are hashed. Falling
    back to the word "UTC" put a label nothing had verified inside the
    fingerprint: a wrong month folds October's breach onto September's row, or
    splits one breach into two. So the check does not run, and says why."""
    await _agent(pool, name="coder", cap=20)
    mount_peers(
        gateway=FakeGateway(
            spend_body=_spend(by_role=[{"key": "agent_coder", "local": False, "usd": 21.4}])
        )
    )
    # Written past the setting's own validator, the way a stored zone that
    # stops resolving after a tzdata change would arrive.
    await pool.execute(
        "INSERT INTO settings (key, value) VALUES ('nova.timezone', $1::jsonb) "
        "ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value",
        "Mars/Olympus_Mons",
    )
    run = await checks.run_one(core_app, pool, "work_agents_over_cap")
    assert not run.ran and run.findings == ()
    assert "Mars/Olympus_Mons" in run.reason and "does not load" in run.reason


# ── money ──────────────────────────────────────────────────────────────────


@requires_db
async def test_spend_against_each_cap_comes_from_the_gateways_own_ledger(pool, mount_peers):
    body = _spend(
        totals={"usd": 30.0, "calls": 9, "month_usd": 41.0, "month_cap_usd": 40.0},
        by_provider=[
            {
                "provider": "openrouter",
                "local": False,
                "usd": 30.0,
                "month_usd": 31.0,
                "cap_usd": 25.0,
                "remaining_usd": -6.0,
                "calls": 9,
            },
            {
                "provider": "anthropic",
                "local": False,
                "usd": 1.0,
                "month_usd": 1.0,
                "cap_usd": 50.0,
                "remaining_usd": 49.0,
                "calls": 2,
            },
            {
                "provider": "ollama",
                "local": True,
                "usd": 0.0,
                "month_usd": None,
                "cap_usd": None,
                "remaining_usd": None,
                "calls": 40,
            },
        ],
    )
    mount_peers(gateway=FakeGateway(spend_body=body))
    run = await checks.run_one(core_app, pool, "money_caps")
    assert run.ran
    assert [f.key for f in run.findings] == ["spend_over_cap:total", "spend_over_cap:openrouter"]
    total, provider = run.findings
    assert total.facts == {"scope": "total", "cap_usd": 40.0, "month": "2026-09"}
    assert "$41.00 of $40.00 in 2026-09" in total.title
    assert provider.facts == {
        "scope": "provider",
        "provider": "openrouter",
        "cap_usd": 25.0,
        "month": "2026-09",
    }
    assert "$31.00 of $25.00" in provider.title and provider.urgent is False


@requires_db
async def test_a_ledger_that_cannot_be_read_is_never_an_all_clear(pool, mount_peers, monkeypatch):
    mount_peers(gateway=FakeGateway(spend_body=_spend()))
    monkeypatch.delenv("GATEWAY_URL", raising=False)
    run = await checks.run_one(core_app, pool, "money_caps")
    assert not run.ran and run.findings == ()
    assert run.reason.startswith("the month ledger could not be read —")
    assert "gateway" in run.reason


@requires_db
async def test_a_walled_provider_is_read_from_the_routing_table(pool, mount_peers):
    walls = {
        "roles": [],
        "walls": [
            {
                "provider": "openrouter",
                "walled_until": "2026-09-08T14:00:00+00:00",
                "reason": "openrouter refused (429): rate limited",
                "status": 429,
                "strikes": 2,
            }
        ],
    }
    mount_peers(gateway=FakeGateway(admin_body=walls))
    run = await checks.run_one(core_app, pool, "money_walled_providers")
    assert run.ran and [f.key for f in run.findings] == ["provider_walled:openrouter"]
    found = run.findings[0]
    # walled_until moves with every strike, so it is in the sentence and not
    # in the fingerprint; the strike count IS new news and is in the facts.
    assert found.facts == {"provider": "openrouter", "status": 429, "strikes": 2}
    assert "walled until 2026-09-08T14:00:00+00:00" in found.title
    assert "rate limited" in found.title


@requires_db
async def test_a_routing_table_that_carries_no_walls_list_did_not_check(pool, mount_peers):
    mount_peers(gateway=FakeGateway(admin_body={"roles": []}))
    run = await checks.run_one(core_app, pool, "money_walled_providers")
    assert not run.ran and run.reason == "the gateway's routing table carries no walls list"


def _days(*pairs) -> list[dict]:
    return [{"day": day, "usd": usd, "calls": 1} for day, usd in pairs]


def _window(days: int) -> str:
    return (datetime.now(UTC).date() - timedelta(days=days)).isoformat() + "T00:00:00+00:00"


def _day(n: int) -> str:
    return (datetime.now(UTC).date() - timedelta(days=n)).isoformat()


@requires_db
async def test_a_day_far_above_the_trailing_week_is_a_finding_with_its_figures(pool, mount_peers):
    """A finished day's numbers are final, so they belong in the facts — the
    condition and the evidence are the same thing here.

    `since` is today-29 in every one of these: that is what the gateway
    actually sends for a 30d window whatever history exists
    (usage.window_bounds), so a fixture that made it up would be testing a
    report shape nothing produces.
    """
    body = _spend(
        window="30d",
        since=_window(29),
        by_day=_days(
            *((_day(n), 0.50) for n in range(2, 9)),
            (_day(1), 6.00),
            # Today is still growing and is never judged.
            (_day(0), 99.0),
        ),
    )
    mount_peers(gateway=FakeGateway(spend_body=body))
    run = await checks.run_one(core_app, pool, "money_daily_spike")
    assert run.ran and [f.key for f in run.findings] == [f"spend_spike:{_day(1)}"]
    found = run.findings[0]
    assert found.facts == {
        "day": _day(1),
        "usd": 6.0,
        "trailing_days": 7,
        "trailing_mean_usd": 0.5,
        "multiple": 12.0,
        "threshold_multiple": 3.0,
    }
    assert "12.0x" in found.title and "flagged at 3x" in found.title
    assert found.urgent is False


@requires_db
async def test_an_ordinary_day_says_nothing(pool, mount_peers):
    body = _spend(
        window="30d",
        since=_window(29),
        by_day=_days(*((_day(n), 0.50) for n in range(1, 9)), (_day(0), 99.0)),
    )
    mount_peers(gateway=FakeGateway(spend_body=body))
    run = await checks.run_one(core_app, pool, "money_daily_spike")
    assert run.ran and run.findings == ()


@requires_db
async def test_too_little_history_is_a_check_that_did_not_run(pool, mount_peers):
    """One day of ledger cannot produce a week's mean, and "no spike" from one
    day would be a guess wearing an all-clear.

    The report's window is the REAL one — 30 days wide, as the gateway always
    sends it — and the ledger inside it holds a single day. The old code took
    its history from `since`, so it read this as 28 days of coverage and
    computed a mean over 27 days that never existed.
    """
    body = _spend(window="30d", since=_window(29), by_day=_days((_day(1), 6.00), (_day(0), 2.00)))
    mount_peers(gateway=FakeGateway(spend_body=body))
    run = await checks.run_one(core_app, pool, "money_daily_spike")
    assert not run.ran and run.findings == ()
    assert "trailing mean needs at least 3" in run.reason
    assert f"earliest day is {_day(1)}" in run.reason


@requires_db
async def test_a_young_install_is_not_a_spike_against_days_that_predate_the_ledger(
    pool, mount_peers
):
    """THE defect: the gateway pins a 30d report's `since` at today-29 whatever
    history exists, so measuring coverage from the window counted 27 days that
    predate the ledger as real $0 and turned a two-day-old install's first
    ordinary day into a fabricated 12x spike. Coverage comes from the days the
    ledger actually listed, so this check has not run."""
    body = _spend(
        window="30d",
        since=_window(29),
        by_day=_days((_day(1), 1.20), (_day(0), 0.30)),
    )
    mount_peers(gateway=FakeGateway(spend_body=body))
    run = await checks.run_one(core_app, pool, "money_daily_spike")
    assert run.findings == (), run.findings[0].title if run.findings else None
    assert not run.ran
    assert f"earliest day is {_day(1)}" in run.reason and "covers only 0 day(s)" in run.reason


@requires_db
async def test_a_trailing_window_that_cost_nothing_has_no_multiple(pool, mount_peers):
    """Enough coverage, and every covered day cost $0 (local models bill
    nothing, and the gateway still lists the day). A rise from nothing to
    $1.20 is a first purchase, not a spike: there is no multiple of zero, and
    saying so beats both flagging it and quietly calling it fine."""
    body = _spend(
        window="30d",
        since=_window(29),
        by_day=_days(*((_day(n), 0.0) for n in range(2, 7)), (_day(1), 1.20), (_day(0), 0.10)),
    )
    mount_peers(gateway=FakeGateway(spend_body=body))
    run = await checks.run_one(core_app, pool, "money_daily_spike")
    assert not run.ran and run.findings == ()
    assert "cost nothing" in run.reason and "$1.20 has no multiple" in run.reason


@requires_db
async def test_a_day_the_ledger_skipped_inside_its_coverage_is_a_real_zero(pool, mount_peers):
    """Absence means two different things either side of the ledger's first
    row. Inside coverage the gateway would have listed the day if anything at
    all had happened on it, so a missing day really did cost nothing and is
    counted; before coverage, nothing is known and nothing is counted."""
    body = _spend(
        window="30d",
        since=_window(29),
        by_day=_days(
            # _day(9) is only here to establish coverage; the trailing window
            # is _day(2).._day(8), and _day(5) is missing from inside it.
            *((_day(n), 0.50) for n in (9, 8, 7, 6, 4, 3, 2)),
            (_day(1), 6.00),
            (_day(0), 99.0),
        ),
    )
    mount_peers(gateway=FakeGateway(spend_body=body))
    run = await checks.run_one(core_app, pool, "money_daily_spike")
    assert run.ran and len(run.findings) == 1
    # Six days at $0.50 and one real zero: 3.00 / 7, not 3.00 / 6.
    assert run.findings[0].facts["trailing_days"] == 7
    assert run.findings[0].facts["trailing_mean_usd"] == 0.4286
    assert run.findings[0].facts["multiple"] == 14.0


# -- not due is not a gap (S11, 2026-09-08) --------------------------------
#
# review_commitments looks every six hours, so five hours in six it does not
# run. Calling that "could not run" made INCOMPLETE the normal state, and a
# signal that is always on cannot report the outage it exists for. A not-due
# check leaves no gap — whatever it found last time is still standing as a
# notice — so it does not stop a beat being quiet, and it is still named.
def _run(name: str, *, ran: bool, due: bool = True, reason: str | None = None):
    return checks.CheckRun(check=name, ran=ran, reason=reason, findings=(), due=due)


def test_a_check_that_was_not_due_does_not_make_the_beat_incomplete():
    quiet, why = checks.quiet(
        [
            _run("stack_gateway", ran=True),
            _run("review_commitments", ran=False, due=False, reason="not due for another 4 hours"),
        ]
    )
    assert quiet is True
    assert why is None


def test_a_check_that_could_not_run_still_makes_the_beat_incomplete():
    quiet, why = checks.quiet(
        [
            _run("stack_gateway", ran=True),
            _run("money_caps", ran=False, reason="the ledger did not answer"),
        ]
    )
    assert quiet is False
    assert "money_caps" in why and "the ledger did not answer" in why


def test_a_not_due_check_is_named_when_the_beat_is_not_quiet_for_another_reason():
    quiet, why = checks.quiet(
        [
            _run("money_caps", ran=False, reason="the ledger did not answer"),
            _run("review_commitments", ran=False, due=False, reason="not due for another 4 hours"),
        ]
    )
    assert quiet is False
    # Both are said, and they are said as DIFFERENT things — "not due" must
    # never read as "looked and found nothing", nor as a failure to look.
    assert "could not run" in why
    assert "not due" in why


def test_a_hand_built_run_with_no_due_field_counts_against_quiet():
    """quiet() is duck-typed; an unknown shape is DUE, never excused."""
    import types

    runs = [types.SimpleNamespace(check="mystery", ran=False, reason="who knows", findings=())]
    assert checks.quiet(runs)[0] is False
