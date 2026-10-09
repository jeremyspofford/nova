"""T2 (epic .epics/worktrees.md): core resolves the machine that holds her
repository and classifies a path against it — derived from what ./install
recorded (NOVA_CHECKOUT, NOVA_REPO_HOST), never a hardcoded path or hostname.

One block per criterion, C1..C5, as written in the tracker's T2 section."""

from __future__ import annotations

import logging
import uuid
from pathlib import Path

import pytest

from app import code_repo, devices, machines, nova_updates
from app.main import app as core_app
from app.tools.base import ToolFailure
from tests.conftest import requires_db

REPO = "/home/owner/work/nova"
WT = f"{REPO}/.worktrees/nova-ab12cd"


# -- C1: repo_dir() is NOVA_CHECKOUT, read live ---------------------------------


def test_c1_repo_dir_reads_nova_checkout_live(monkeypatch):
    assert nova_updates.CHECKOUT_ENV == "NOVA_CHECKOUT"
    monkeypatch.setenv("NOVA_CHECKOUT", "/srv/a/nova/")
    assert code_repo.repo_dir() == "/srv/a/nova"
    monkeypatch.setenv("NOVA_CHECKOUT", "/srv/b/nova")
    assert code_repo.repo_dir() == "/srv/b/nova"
    monkeypatch.delenv("NOVA_CHECKOUT")
    assert code_repo.repo_dir() is None


@pytest.mark.parametrize("bad", ["relative/nova", "/srv/a\n/nova", "/srv/../etc", "   "])
def test_c1_repo_dir_malformed_is_none_and_logged(monkeypatch, caplog, bad):
    monkeypatch.setenv("NOVA_CHECKOUT", bad)
    with caplog.at_level(logging.INFO):
        assert code_repo.repo_dir() is None
    if bad.strip():
        assert any("NOVA_CHECKOUT" in r.getMessage() for r in caplog.records)


def test_c1_no_second_path_key():
    source = Path(code_repo.__file__).read_text()
    assert "NOVA_REPO_DIR" not in source
    assert "/home/" not in source and "mini-pc" not in source


# -- C2: repo_host() is NOVA_REPO_HOST, read live -------------------------------


def test_c2_repo_host_reads_live(monkeypatch):
    monkeypatch.setenv("NOVA_REPO_HOST", " mini-pc ")
    assert code_repo.repo_host() == "mini-pc"
    monkeypatch.setenv("NOVA_REPO_HOST", "DELL-XPS-8950")
    assert code_repo.repo_host() == "DELL-XPS-8950"
    monkeypatch.setenv("NOVA_REPO_HOST", "")
    assert code_repo.repo_host() is None
    monkeypatch.delenv("NOVA_REPO_HOST")
    assert code_repo.repo_host() is None


@pytest.mark.parametrize("bad", ["mini pc", "mini-pc\nother", "host;rm", "a/b"])
def test_c2_repo_host_malformed_is_none_and_logged(monkeypatch, caplog, bad):
    monkeypatch.setenv("NOVA_REPO_HOST", bad)
    with caplog.at_level(logging.INFO):
        assert code_repo.repo_host() is None
    assert any("NOVA_REPO_HOST" in r.getMessage() for r in caplog.records)


# -- C3: repo_machine(app) is the ONE live device with that hostname ------------


async def _pair(pool, name: str, hostname: str) -> uuid.UUID:
    pid = await pool.fetchval(
        "INSERT INTO people (name, role) VALUES ($1, 'adult') RETURNING id",
        f"adult-{uuid.uuid4().hex[:8]}",
    )
    code = await devices.mint_pairing_code(pool, created_by=pid)
    from tests.device_fakes import FakeDevice

    result = await devices.enroll(
        pool,
        code=code["code"],
        pubkey=FakeDevice().pubkey_hex,
        name=name,
        platform="linux",
        hostname=hostname,
    )
    return uuid.UUID(result["device_id"])


@pytest.fixture
def recorded(monkeypatch):
    monkeypatch.setenv("NOVA_CHECKOUT", REPO)
    monkeypatch.setenv("NOVA_REPO_HOST", "mini-pc")


@requires_db
async def test_c3_one_match_is_the_row_and_the_dir(pool, recorded):
    hub = await _pair(pool, "Beelink Mini S", "mini-pc")
    await _pair(pool, "Dell", "DELL-XPS-8950")
    row, where = await code_repo.repo_machine(core_app)
    assert row["id"] == hub
    assert where == REPO


@requires_db
async def test_c3_hostname_match_is_case_insensitive(pool, recorded, monkeypatch):
    monkeypatch.setenv("NOVA_REPO_HOST", "MINI-PC")
    hub = await _pair(pool, "Beelink Mini S", "mini-pc")
    row, _ = await code_repo.repo_machine(core_app)
    assert row["id"] == hub


@requires_db
@pytest.mark.parametrize("unset", ["NOVA_CHECKOUT", "NOVA_REPO_HOST"])
async def test_c3_nothing_recorded_says_run_install(pool, recorded, monkeypatch, unset):
    await _pair(pool, "Beelink Mini S", "mini-pc")
    monkeypatch.delenv(unset)
    with pytest.raises(ToolFailure) as exc:
        await code_repo.repo_machine(core_app)
    said = str(exc.value)
    assert said.startswith("cannot:")
    assert unset in said and "./install" in said


@requires_db
async def test_c3_no_match_names_each_paired_device_and_hostname(pool, recorded):
    await _pair(pool, "Dell", "DELL-XPS-8950")
    await _pair(pool, "MacBook", "macbook-air")
    with pytest.raises(ToolFailure) as exc:
        await code_repo.repo_machine(core_app)
    said = str(exc.value)
    assert said.startswith("cannot:")
    assert "mini-pc" in said
    for part in ("Dell", "DELL-XPS-8950", "MacBook", "macbook-air"):
        assert part in said


@requires_db
async def test_c3_revoked_row_never_counts(pool, recorded):
    gone = await _pair(pool, "old hub", "mini-pc")
    await pool.execute("UPDATE devices SET revoked_at = now() WHERE id = $1", gone)
    with pytest.raises(ToolFailure) as exc:
        await code_repo.repo_machine(core_app)
    assert str(exc.value).startswith("cannot:")


@requires_db
async def test_c3_several_rows_sharing_the_hostname_is_a_cannot_naming_them(
    pool, recorded, monkeypatch
):
    """Real today: two Dell WSL agents report hostname DELL-XPS-8950. A shared
    hostname is never resolved by picking one — it is a stated cannot."""
    monkeypatch.setenv("NOVA_REPO_HOST", "DELL-XPS-8950")
    await _pair(pool, "Dell WSL Ubuntu", "DELL-XPS-8950")
    await _pair(pool, "Dell WSL Debian", "DELL-XPS-8950")
    with pytest.raises(ToolFailure) as exc:
        await code_repo.repo_machine(core_app)
    said = str(exc.value)
    assert said.startswith("cannot:")
    assert "Dell WSL Ubuntu" in said and "Dell WSL Debian" in said
    assert "DELL-XPS-8950" in said


@requires_db
async def test_c3_a_replay_never_resolves_a_real_row(pool, recorded):
    """Replay hermeticity (S42b Task 22): under an eval's FixturePlant a real
    row is never the repo machine, so no command reaches a real agent."""
    await _pair(pool, "Beelink Mini S", "mini-pc")
    token = machines.PLANT.set(machines.FixturePlant({}))
    try:
        with pytest.raises(ToolFailure) as exc:
            await code_repo.repo_machine(core_app)
    finally:
        machines.PLANT.reset(token)
    assert str(exc.value).startswith("cannot:")


# -- C4: checkout_scope(path, repo_dir) ------------------------------------------


@pytest.mark.parametrize(
    "path",
    [WT, WT + "/", WT + "/deploy/README.md", f"{REPO}//.worktrees/./nova-ab12cd/x"],
)
def test_c4_inside_her_worktree_is_worktree(path):
    assert code_repo.checkout_scope(path, REPO) == "worktree"


@pytest.mark.parametrize(
    "path",
    [
        REPO,
        REPO + "/",
        f"{REPO}/deploy/README.md",
        f"{REPO}/.worktrees",
        f"{REPO}/.worktrees/nova-",
        f"{REPO}/.worktrees/other-lane/x",
        f"{REPO}/.worktrees/novaab12cd",
        f"{REPO}/.claude/worktrees/hub-2/x",
        f"{WT}/../../deploy/README.md",
    ],
)
def test_c4_anywhere_else_in_the_checkout_is_outside(path):
    assert code_repo.checkout_scope(path, REPO) == "outside"


@pytest.mark.parametrize(
    "path", ["/home/owner/work/nova-other", "/home/owner/work/novaX/a", "/tmp/x", "", "deploy/x"]
)
def test_c4_not_under_the_checkout_is_none(path):
    assert code_repo.checkout_scope(path, REPO) is None


def test_c4_trailing_slash_on_repo_dir_changes_nothing():
    assert code_repo.checkout_scope(WT, REPO + "/") == "worktree"
    assert code_repo.checkout_scope(REPO + "/x", REPO + "/") == "outside"


# -- C5: argv_scope(argv, repo_dir) ----------------------------------------------


@pytest.mark.parametrize(
    "argv",
    [
        ["sh", "-c", f"cd {REPO} && git checkout -b feat/x"],
        ["git", "-C", REPO, "status"],
        ["git", f"--git-dir={REPO}/.git", "status"],
        ["sh", "-c", f"cat '{REPO}/deploy/README.md'"],
        ["sh", "-c", f"cd {WT} && cp x {REPO}/deploy/x"],
    ],
)
def test_c5_any_outside_occurrence_is_outside(argv):
    assert code_repo.argv_scope(argv, REPO) == "outside"


@pytest.mark.parametrize(
    "argv",
    [
        ["git", "-C", WT, "status"],
        ["sh", "-c", f"cd {WT} && pnpm test; ls {WT}/apps"],
    ],
)
def test_c5_only_worktree_occurrences_is_worktree(argv):
    assert code_repo.argv_scope(argv, REPO) == "worktree"


@pytest.mark.parametrize(
    "argv",
    [
        ["ls", "/home/owner/work/nova-other"],
        ["echo", "/home/owner/work/novabc"],
        ["ls", "/srv/home/owner/work/nova"],
        ["uname", "-a"],
        [],
    ],
)
def test_c5_no_reference_is_none(argv):
    assert code_repo.argv_scope(argv, REPO) is None


def test_c5_a_non_reference_does_not_hide_a_later_reference_in_the_same_element():
    """COVERAGE: the boundary rule skips "/srv<repo>" and "<repo>bc" but keeps
    scanning — a real reference later in the same element still counts."""
    argv = ["sh", "-c", f"ls /srv{REPO} {REPO}bc; cd {REPO} && git checkout -b x"]
    assert code_repo.argv_scope(argv, REPO) == "outside"
