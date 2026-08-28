"""MemoryStore: atomic writes, path-boundary enforcement, journals/topics,
export. Every test gets its own tmp-dir root."""
from __future__ import annotations

import io
import tarfile
from datetime import date

import pytest

from app.store import MemoryStore, PathEscape


def _store(tmp_path) -> MemoryStore:
    return MemoryStore(tmp_path / "root")


# -- atomic writes -----------------------------------------------------


def test_no_tmp_artifacts_visible_after_a_completed_write(tmp_path):
    store = _store(tmp_path)
    path, _ = store.append_journal("alice", "hello world")
    siblings = list(path.parent.iterdir())
    assert siblings == [path]
    assert not any(p.name.endswith(".tmp") for p in siblings)


def test_simulated_failure_between_tmp_write_and_rename_leaves_original_intact(
    tmp_path, monkeypatch
):
    store = _store(tmp_path)
    path, _ = store.append_journal("alice", "first entry")
    original = path.read_text(encoding="utf-8")

    def _boom(*args, **kwargs):
        raise OSError("simulated crash between tmp-write and rename")

    monkeypatch.setattr("app.store.os.replace", _boom)
    with pytest.raises(OSError):
        store.append_journal("alice", "second entry that must not land")

    assert path.read_text(encoding="utf-8") == original
    # the failed attempt must not leave a visible .tmp file behind either
    assert not any(p.name.endswith(".tmp") for p in path.parent.iterdir())


# -- journals ------------------------------------------------------------


def test_ingest_creates_journal_with_valid_frontmatter(tmp_path):
    store = _store(tmp_path)
    path, created_new = store.append_journal("alice", "User: hi\n\nAssistant: hello")
    assert created_new is True
    text = path.read_text(encoding="utf-8")
    assert text.startswith("---\n")
    stored = store.read(path)
    assert stored.meta["owner"] == "alice"
    assert stored.meta["kind"] == "journal"
    assert isinstance(stored.meta["created"], date)
    assert stored.meta["tags"] == []
    assert "id" in stored.meta
    assert "hi" in stored.body


def test_second_ingest_same_day_appends_one_file_two_entries(tmp_path):
    store = _store(tmp_path)
    path1, created1 = store.append_journal("alice", "first exchange text")
    path2, created2 = store.append_journal("alice", "second exchange text")
    assert path1 == path2
    assert created1 is True
    assert created2 is False
    text = path1.read_text(encoding="utf-8")
    assert "first exchange text" in text
    assert "second exchange text" in text
    # one file per day, not two
    journals_dir = path1.parent
    assert len(list(journals_dir.iterdir())) == 1


# -- path boundaries -----------------------------------------------------


def test_person_root_rejects_traversal_in_person_id(tmp_path):
    store = _store(tmp_path)
    with pytest.raises(PathEscape):
        store.person_root("../escape")


def test_person_root_rejects_slash_in_person_id(tmp_path):
    store = _store(tmp_path)
    with pytest.raises(PathEscape):
        store.person_root("alice/../../bob")


def test_resolve_in_person_rejects_relative_traversal(tmp_path):
    store = _store(tmp_path)
    store.append_journal("alice", "seed")
    with pytest.raises(PathEscape):
        store.resolve_in_person("alice", "people/alice/../bob/topics/x.md")


def test_resolve_in_person_rejects_absolute_escape(tmp_path):
    store = _store(tmp_path)
    store.append_journal("alice", "seed")
    with pytest.raises(PathEscape):
        store.resolve_in_person("alice", "/etc/passwd")


def test_resolve_in_person_rejects_symlink_pointing_outside(tmp_path):
    store = _store(tmp_path)
    store.append_journal("alice", "seed")
    outside = tmp_path / "outside.md"
    outside.write_text("secret", encoding="utf-8")
    person_root = store.person_root("alice")
    (person_root / "topics").mkdir(parents=True, exist_ok=True)
    link = person_root / "topics" / "escape.md"
    link.symlink_to(outside)
    with pytest.raises(PathEscape):
        store.resolve_in_person("alice", "people/alice/topics/escape.md")


def test_resolve_in_person_accepts_legit_path(tmp_path):
    store = _store(tmp_path)
    path, _ = store.append_journal("alice", "seed")
    rel = store.rel_path(path)
    resolved = store.resolve_in_person("alice", rel)
    assert resolved == path.resolve()


def test_resolve_in_person_rejects_other_persons_file(tmp_path):
    store = _store(tmp_path)
    path, _ = store.append_journal("bob", "bob's secret")
    rel = store.rel_path(path)
    with pytest.raises(PathEscape):
        store.resolve_in_person("alice", rel)


def test_iter_all_skips_symlinks_even_if_pointing_inside(tmp_path):
    store = _store(tmp_path)
    real_path, _ = store.append_journal("alice", "seed")
    outside = tmp_path / "outside.md"
    outside.write_text("---\nid: x\nowner: alice\nkind: topic\ntitle: t\ncreated: 2020-01-01\n"
                        "tags: []\n---\nleaked content\n", encoding="utf-8")
    person_root = store.person_root("alice")
    (person_root / "topics").mkdir(parents=True, exist_ok=True)
    (person_root / "topics" / "escape.md").symlink_to(outside)

    seen = {f.rel_path for f in store.iter_all()}
    assert store.rel_path(real_path) in seen
    assert "people/alice/topics/escape.md" not in seen


# -- topics ----------------------------------------------------------------


def test_write_topic_creates_valid_frontmatter(tmp_path):
    store = _store(tmp_path)
    path = store.write_topic("alice", "coffee", "Coffee preferences", "Alice likes pour-over.")
    stored = store.read(path)
    assert stored.meta["kind"] == "topic"
    assert stored.meta["title"] == "Coffee preferences"
    assert "pour-over" in stored.body


# -- export -----------------------------------------------------------------


def test_export_tar_gz_round_trips(tmp_path):
    store = _store(tmp_path)
    store.append_journal("alice", "alice's entry")
    store.write_topic("alice", "coffee", "Coffee", "pour-over notes")
    data = store.export_tar_gz("alice")
    with tarfile.open(fileobj=io.BytesIO(data), mode="r:gz") as tar:
        names = sorted(tar.getnames())
        assert any(n.startswith("journals/") for n in names)
        assert any(n.startswith("topics/") for n in names)
        member = tar.extractfile("topics/coffee.md")
        assert member is not None
        assert "pour-over notes" in member.read().decode("utf-8")


def test_export_empty_person_is_a_valid_empty_archive(tmp_path):
    store = _store(tmp_path)
    data = store.export_tar_gz("nobody")
    with tarfile.open(fileobj=io.BytesIO(data), mode="r:gz") as tar:
        assert tar.getnames() == []
