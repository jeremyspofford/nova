import os
import tempfile
from pathlib import Path
import pytest

from audit_tool_use.env import resolve_repo_root, load_admin_secret


def test_resolve_repo_root_finds_dir_with_env_and_compose(tmp_path):
    repo = tmp_path / "fake-repo"
    repo.mkdir()
    (repo / ".env").write_text("NOVA_ADMIN_SECRET=xyz\n")
    (repo / "docker-compose.yml").write_text("version: '3'\n")
    nested = repo / "a" / "b" / "c"
    nested.mkdir(parents=True)
    (nested / "marker.txt").write_text("here")
    found = resolve_repo_root(start_from=nested / "marker.txt")
    assert found == repo


def test_resolve_repo_root_raises_when_no_repo_above(tmp_path):
    with pytest.raises(RuntimeError, match="repo root"):
        resolve_repo_root(start_from=tmp_path / "nothing.txt")


def test_load_admin_secret_uses_env_override(monkeypatch, tmp_path):
    (tmp_path / ".env").write_text("NOVA_ADMIN_SECRET=from-file\n")
    (tmp_path / "docker-compose.yml").write_text("")
    monkeypatch.setenv("NOVA_ADMIN_SECRET", "from-env")
    assert load_admin_secret(repo_root=tmp_path) == "from-env"


def test_load_admin_secret_falls_back_to_env_file(monkeypatch, tmp_path):
    (tmp_path / ".env").write_text("NOVA_ADMIN_SECRET=from-file\n")
    (tmp_path / "docker-compose.yml").write_text("")
    monkeypatch.delenv("NOVA_ADMIN_SECRET", raising=False)
    assert load_admin_secret(repo_root=tmp_path) == "from-file"


def test_load_admin_secret_raises_loudly_when_missing(tmp_path, monkeypatch):
    (tmp_path / "docker-compose.yml").write_text("")
    monkeypatch.delenv("NOVA_ADMIN_SECRET", raising=False)
    with pytest.raises(RuntimeError, match="NOVA_ADMIN_SECRET"):
        load_admin_secret(repo_root=tmp_path)
