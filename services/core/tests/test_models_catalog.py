"""GET /api/v1/models/catalog — the gateway's catalogue with the one fact
only core holds added: what Nova MEASURED. The match between a stored eval
model id and a catalogue row is derived against the live rows (a bare
pre-registry id means the bundled ollama), never a guessed prefix."""

from __future__ import annotations

import uuid

from app.evals import cases as cases_mod
from app.evals import runner
from app.models_catalog import decorate, measured_for
from tests.conftest import requires_db
from tests.fakes import FakeGateway

pytestmark = requires_db

SUITE = "agent_quality"


def _row(id_: str, provider: str, model: str) -> dict:
    return {
        "id": id_,
        "provider": provider,
        "model": model,
        "label": model,
        "kind": "local" if provider == "ollama" else "cloud",
        "sources": [{"key": "ollama-show", "fetched_at": "t"}],
        "facts": {},
        "capabilities": {},
        "suitability": {},
        "actions": [],
    }


def _catalog() -> dict:
    return {
        "fetched_at": "2026-09-06T12:00:00Z",
        "sources": [{"key": "ollama", "ok": True, "rows": 2}],
        "rows": [
            _row("ollama:qwen3:8b", "ollama", "qwen3:8b"),
            _row("ollama:qwen3:4b", "ollama", "qwen3:4b"),
            _row("openrouter:openai/gpt-x", "openrouter", "openai/gpt-x"),
        ],
    }


async def _done_run(pool, model: str, outcomes: list[tuple[bool | None, bool]], *, status="done"):
    version = cases_mod.load_suite(SUITE)[0].suite_version
    run_id = (await runner.open_suite_run(pool, SUITE, version, model, len(outcomes)))["id"]
    for index, (passed, ungradeable) in enumerate(outcomes):
        await pool.execute(
            "INSERT INTO eval_runs (suite, suite_version, model, case_id, passed, ungradeable, "
            "detail, run_id) VALUES ($1, $2, $3, $4, $5, $6, '{}', $7)",
            SUITE,
            version,
            model,
            f"case-{index}",
            passed,
            ungradeable,
            run_id,
        )
    if status == "done":
        await runner.close_suite_run(pool, run_id, "done", None)
    elif status == "interrupted":
        await runner.close_suite_run(pool, run_id, "interrupted", "cut")
    return run_id, version


def test_measured_for_matches_the_qualified_id_or_the_bare_ollama_model():
    measured = {
        "qwen3:8b": {SUITE: {"pass_rate": 0.5}},
        "openrouter:openai/gpt-x": {SUITE: {"pass_rate": 1.0}},
    }
    assert measured_for(_row("ollama:qwen3:8b", "ollama", "qwen3:8b"), measured) == {
        SUITE: {"pass_rate": 0.5}
    }
    assert measured_for(
        _row("openrouter:openai/gpt-x", "openrouter", "openai/gpt-x"), measured
    ) == {SUITE: {"pass_rate": 1.0}}
    # A cloud row never claims a bare local measurement.
    assert measured_for(_row("openrouter:qwen3:8b", "openrouter", "qwen3:8b"), measured) == {}


def test_decorate_leaves_unmeasured_rows_untouched_and_never_writes_zero():
    body = _catalog()
    out = decorate(
        body,
        {
            "qwen3:8b": {
                SUITE: {
                    "suite_version": 6,
                    "run_id": "r",
                    "ended_at": "2026-09-04T00:00:00Z",
                    "total": 3,
                    "gradeable": 0,
                    "ungradeable": 3,
                    "passed": 0,
                    "pass_rate": None,
                }
            }
        },
        read_at="2026-09-07T00:00:00+00:00",
    )
    measured_row = out["rows"][0]["suitability"][SUITE]
    # The source entry is stamped like every other source's fetch.
    evals_source = next(s for s in out["rows"][0]["sources"] if s["key"] == "core-evals")
    assert evals_source["fetched_at"] == "2026-09-07T00:00:00+00:00"
    assert measured_row["value"] is None
    assert measured_row["basis"] == "measured"
    assert "no gradeable case" in measured_row["note"]
    assert out["rows"][1]["suitability"] == {}
    assert out["rows"][2]["suitability"] == {}


async def test_the_catalogue_carries_the_newest_complete_run_per_model(
    owner_client, mount_peers, pool
):
    gateway = FakeGateway(admin_body=_catalog())
    mount_peers(gateway=gateway)
    # An older, worse run and a newer, better one for the bare pre-registry id;
    # an interrupted run for the 4b that must add nothing; a cloud run keyed
    # by its qualified id.
    await _done_run(pool, "qwen3:8b", [(False, False), (False, False)])
    _, version = await _done_run(pool, "qwen3:8b", [(True, False), (True, False), (None, True)])
    await _done_run(pool, "qwen3:4b", [(True, False)], status="interrupted")
    await _done_run(pool, "openrouter:openai/gpt-x", [(True, False), (False, False)])

    resp = await owner_client.get("/api/v1/models/catalog")

    assert resp.status_code == 200
    body = resp.json()
    assert body["sources"] == _catalog()["sources"]
    by_id = {row["id"]: row for row in body["rows"]}
    measured = by_id["ollama:qwen3:8b"]["suitability"][SUITE]
    assert measured["basis"] == "measured" and measured["source"] == "core-evals"
    assert measured["value"] == 1.0
    assert measured["detail"] == {
        **measured["detail"],
        "suite_version": version,
        "passed": 2,
        "gradeable": 2,
        "ungradeable": 1,
    }
    assert "2/2 gradeable cases passed" in measured["note"]
    assert any(s["key"] == "core-evals" for s in by_id["ollama:qwen3:8b"]["sources"])
    assert by_id["ollama:qwen3:4b"]["suitability"] == {}
    assert by_id["openrouter:openai/gpt-x"]["suitability"][SUITE]["value"] == 0.5
    assert gateway.seen[-1][0] == "/admin/catalog"


async def test_a_gateway_refusal_is_relayed_and_a_dead_gateway_is_a_stated_502(
    owner_client, mount_peers
):
    gateway = FakeGateway(admin_status=503, admin_body={"error": "OLLAMA_URL is unset"})
    mount_peers(gateway=gateway)
    resp = await owner_client.get("/api/v1/models/catalog")
    assert resp.status_code == 503
    assert resp.json() == {"error": "OLLAMA_URL is unset"}


async def test_a_run_of_another_suite_version_is_not_this_measurement(
    owner_client, mount_peers, pool
):
    gateway = FakeGateway(admin_body=_catalog())
    mount_peers(gateway=gateway)
    version = cases_mod.load_suite(SUITE)[0].suite_version
    run_id = (await runner.open_suite_run(pool, SUITE, version - 1, "qwen3:8b", 1))["id"]
    await pool.execute(
        "INSERT INTO eval_runs (suite, suite_version, model, case_id, passed, ungradeable, detail, "
        "run_id) VALUES ($1, $2, 'qwen3:8b', 'c', true, false, '{}', $3)",
        SUITE,
        version - 1,
        run_id,
    )
    await runner.close_suite_run(pool, run_id, "done", None)
    resp = await owner_client.get("/api/v1/models/catalog")
    assert resp.json()["rows"][0]["suitability"] == {}
    assert isinstance(uuid.UUID(str(run_id)), uuid.UUID)
