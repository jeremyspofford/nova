"""/api/v1/skills — the Skills page's surface.

The page is where a draft becomes a procedure, so what matters here is that it
can never show more confidence than the record supports: a file with no row is
listed as exactly that, a source turn swept by retention says so instead of
404ing, and the ledger's unwatched uses are a separate number from its clean
ones.
"""

from __future__ import annotations

import uuid

from app import skills
from tests.conftest import requires_db

pytestmark = requires_db


async def _root(monkeypatch, tmp_path):
    root = tmp_path / "ws"
    root.mkdir()
    monkeypatch.setenv("WORKSPACE_ROOT", str(root))
    return root


async def _seed(pool, name="tidy", *, status=skills.ACTIVE, steps=("a", "b")):
    await skills.create(
        pool,
        name=name,
        title=f"title {name}",
        summary=f"asked as: '{name}'",
        created_via="page",
        body="1. do the thing\n",
        step_names=list(steps),
    )
    if status != skills.DRAFT:
        await skills.set_status(pool, name, status)


async def test_the_list_carries_rows_and_files_nobody_has_a_row_for(
    owner_client, pool, monkeypatch, tmp_path
):
    root = await _root(monkeypatch, tmp_path)
    await _seed(pool)
    (root / "skills").mkdir(parents=True, exist_ok=True)
    (root / "skills" / "by-hand.md").write_text("written by the owner", encoding="utf-8")

    resp = await owner_client.get("/api/v1/skills")
    assert resp.status_code == 200, resp.text
    rows = {item["name"]: item for item in resp.json()}

    assert rows["tidy"]["status"] == skills.ACTIVE
    assert rows["tidy"]["file_present"] is True
    # An agent may already name this file, so it is listed — with no status,
    # because a file is not a lifecycle.
    assert rows["by-hand"]["status"] is None
    assert rows["by-hand"]["file_present"] is True


async def test_a_row_whose_file_was_deleted_by_hand_says_so(
    owner_client, pool, monkeypatch, tmp_path
):
    await _root(monkeypatch, tmp_path)
    await _seed(pool)
    skills.body_path("tidy").unlink()

    resp = await owner_client.get("/api/v1/skills/tidy")
    assert resp.json()["file_present"] is False
    assert resp.json()["body"] is None


async def test_the_ledger_counts_unwatched_uses_separately(
    owner_client, pool, monkeypatch, tmp_path
):
    await _root(monkeypatch, tmp_path)
    await _seed(pool)
    skill = await skills.get(pool, "tidy")
    for known, failed in ((True, 0), (True, 2), (False, 9)):
        await pool.execute(
            "INSERT INTO skill_uses (skill_id, failed_calls, outcome_known) VALUES ($1, $2, $3)",
            skill.id,
            failed,
            known,
        )

    uses = (await owner_client.get("/api/v1/skills/tidy")).json()["uses"]
    assert uses == {
        "total": 3,
        "watched": 2,
        "rough": 1,
        "unwatched": 1,
        "last_used": uses["last_used"],
    }


async def test_a_source_turn_that_aged_out_is_reported_not_hidden(
    owner_client, pool, monkeypatch, tmp_path
):
    await _root(monkeypatch, tmp_path)
    gone = uuid.uuid4()
    await skills.create(
        pool,
        name="tidy",
        title="t",
        summary="u",
        created_via="beat",
        body="b",
        source_turn_ids=[gone],
    )

    turns = (await owner_client.get("/api/v1/skills/tidy")).json()["source_turns"]
    assert turns == [{"id": str(gone), "present": False}]


async def test_status_moves_through_the_store_and_flagging_demands_a_reason(
    owner_client, pool, monkeypatch, tmp_path
):
    await _root(monkeypatch, tmp_path)
    await _seed(pool, status=skills.DRAFT)

    resp = await owner_client.patch("/api/v1/skills/tidy", json={"status": skills.ACTIVE})
    assert resp.status_code == 200
    assert resp.json()["status"] == skills.ACTIVE

    refused = await owner_client.patch("/api/v1/skills/tidy", json={"status": skills.FLAGGED})
    assert refused.status_code == 400
    assert "reason" in refused.json()["error"]


async def test_deleting_says_the_file_is_still_there(owner_client, pool, monkeypatch, tmp_path):
    await _root(monkeypatch, tmp_path)
    await _seed(pool)

    resp = await owner_client.delete("/api/v1/skills/tidy")
    assert resp.status_code == 200
    assert "still at" in resp.json()["text"]
    assert skills.body_path("tidy").is_file()
    assert await skills.get(pool, "tidy") is None


async def test_a_draft_from_a_notice_is_composed_from_the_turns_that_walked_it(
    owner_client, pool, monkeypatch, tmp_path
):
    await _root(monkeypatch, tmp_path)
    person = await pool.fetchval("SELECT id FROM people WHERE role = 'owner'")
    sequence = ["workspace_list_files", "workspace_read_file", "workspace_delete"]
    for _ in range(2):
        conversation = await pool.fetchval(
            "INSERT INTO conversations (person_id) VALUES ($1) RETURNING id", person
        )
        turn = await pool.fetchval(
            "INSERT INTO turns (kind, conversation_id, model, person_id) "
            "VALUES ('chat', $1, 'm', $2) RETURNING id",
            conversation,
            person,
        )
        await pool.execute(
            "INSERT INTO messages (conversation_id, turn_id, role, content) "
            "VALUES ($1, $2, 'user', 'clear the superseded notes')",
            conversation,
            turn,
        )
        for i, name in enumerate(sequence):
            await pool.execute(
                "INSERT INTO turn_spans (turn_id, kind, name, started_at, duration_ms) "
                "VALUES ($1, 'tool', $2, now() + make_interval(secs => $3), 5)",
                turn,
                name,
                float(i),
            )
    notice = await pool.fetchval(
        "INSERT INTO notices (check_name, finding_key, fingerprint, title, facts) "
        "VALUES ('skills_repeated_procedure', 'k', 'f', 't', $1) RETURNING id",
        {"steps": sequence},
    )

    resp = await owner_client.post(
        "/api/v1/skills", json={"name": "clear-notes", "from_notice": str(notice)}
    )
    assert resp.status_code == 200, resp.text
    made = resp.json()
    assert made["status"] == skills.DRAFT
    assert made["step_names"] == sequence
    assert "clear the superseded notes" in made["summary"]
    assert len(made["source_turns"]) == 2
    assert all(turn["present"] for turn in made["source_turns"])


async def test_a_notice_that_is_not_a_procedure_is_refused_by_name(
    owner_client, pool, monkeypatch, tmp_path
):
    await _root(monkeypatch, tmp_path)
    notice = await pool.fetchval(
        "INSERT INTO notices (check_name, finding_key, fingerprint, title, facts) "
        "VALUES ('work_paused_timers', 'k', 'f', 't', $1) RETURNING id",
        {"timer_id": "x"},
    )

    resp = await owner_client.post(
        "/api/v1/skills", json={"name": "nope", "from_notice": str(notice)}
    )
    assert resp.status_code == 400
    assert "work_paused_timers" in resp.json()["error"]
