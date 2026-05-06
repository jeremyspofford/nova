"""Tests for the snapshot assertion helper."""

from __future__ import annotations

import json

import pytest

from ._snapshot import assert_snapshot


def test_first_run_writes_snapshot(monkeypatch, tmp_path):
    monkeypatch.setenv("UPDATE_SNAPSHOTS", "1")
    snap_path = tmp_path / "test.json"
    assert_snapshot({"k": 1}, path=snap_path)
    assert json.loads(snap_path.read_text()) == {"k": 1}


def test_replay_match_passes(monkeypatch, tmp_path):
    snap_path = tmp_path / "test.json"
    snap_path.write_text(json.dumps({"k": 1}))
    monkeypatch.delenv("UPDATE_SNAPSHOTS", raising=False)
    assert_snapshot({"k": 1}, path=snap_path)  # no error


def test_replay_mismatch_fails(monkeypatch, tmp_path):
    snap_path = tmp_path / "test.json"
    snap_path.write_text(json.dumps({"k": 1}))
    monkeypatch.delenv("UPDATE_SNAPSHOTS", raising=False)
    with pytest.raises(AssertionError) as exc:
        assert_snapshot({"k": 2}, path=snap_path)
    assert "snapshot mismatch" in str(exc.value).lower()


def test_missing_snapshot_in_replay_fails(monkeypatch, tmp_path):
    snap_path = tmp_path / "missing.json"
    monkeypatch.delenv("UPDATE_SNAPSHOTS", raising=False)
    with pytest.raises(FileNotFoundError):
        assert_snapshot({"k": 1}, path=snap_path)


def test_update_overwrites_existing(monkeypatch, tmp_path):
    snap_path = tmp_path / "test.json"
    snap_path.write_text(json.dumps({"k": 1}))
    monkeypatch.setenv("UPDATE_SNAPSHOTS", "1")
    assert_snapshot({"k": 99}, path=snap_path)
    assert json.loads(snap_path.read_text()) == {"k": 99}


def test_pretty_json_diff_in_error(monkeypatch, tmp_path):
    snap_path = tmp_path / "test.json"
    snap_path.write_text(json.dumps({"a": 1, "b": 2}, indent=2))
    monkeypatch.delenv("UPDATE_SNAPSHOTS", raising=False)
    with pytest.raises(AssertionError) as exc:
        assert_snapshot({"a": 1, "b": 99}, path=snap_path)
    err = str(exc.value)
    assert "2" in err and "99" in err
