"""The files her browser makes, brought into her workspace (S38): checked by
size and sha256 before the engine's copy goes, never overwriting hers, never
leaving her workspace, never following a link out of the engine's volume."""

from __future__ import annotations

import hashlib
import os
from pathlib import Path

import pytest

from app.browser import files


@pytest.fixture
def dirs(tmp_path: Path) -> tuple[Path, Path]:
    output, workspace = tmp_path / "output", tmp_path / "workspace"
    output.mkdir()
    workspace.mkdir()
    return output, workspace


def _put(output: Path, name: str, data: bytes = b"report body\n") -> Path:
    path = output / name
    path.write_bytes(data)
    return path


def test_a_reported_file_is_copied_checked_and_the_engines_copy_removed(dirs):
    output, workspace = dirs
    data = os.urandom(3 * 1024 * 1024 + 7)
    _put(output, "report.bin", data)
    brought = files.bring_in(
        "/output/report.bin", output_dir=output, workspace_root=workspace, folder="downloads"
    )
    assert brought == files.Brought(path="downloads/report.bin", bytes=len(data))
    copied = workspace / "downloads" / "report.bin"
    assert hashlib.sha256(copied.read_bytes()).digest() == hashlib.sha256(data).digest()
    assert not (output / "report.bin").exists()
    assert not any(p.name.endswith(".part") for p in (workspace / "downloads").iterdir())


def test_an_existing_file_is_never_overwritten(dirs):
    output, workspace = dirs
    (workspace / "downloads").mkdir()
    (workspace / "downloads" / "report.txt").write_text("hers")
    _put(output, "report.txt", b"the page's")
    brought = files.bring_in(
        "/output/report.txt", output_dir=output, workspace_root=workspace, folder="downloads"
    )
    assert brought.path == "downloads/report (2).txt"
    assert (workspace / "downloads" / "report.txt").read_text() == "hers"


@pytest.mark.parametrize(
    "name,expected",
    [
        ("../../.bashrc", "downloads/bashrc"),
        ("C:\\evil\\name.exe", "downloads/name.exe"),
        ("na<m>e?.txt", "downloads/name.txt"),
        ("a\x07b.txt", "downloads/ab.txt"),
        ("...", "downloads/download"),
    ],
)
def test_a_page_chosen_name_stays_one_file_in_the_folder(dirs, name, expected):
    output, workspace = dirs
    _put(output, "x.bin")
    brought = files.bring_in(
        "/output/x.bin", output_dir=output, workspace_root=workspace, folder="downloads", name=name
    )
    assert brought.path == expected
    assert (workspace / expected).is_file()


def test_a_long_name_keeps_its_extension():
    name = files.safe_name("x" * 300 + ".pdf")
    assert len(name) == files.MAX_NAME_CHARS and name.endswith(".pdf")


@pytest.mark.parametrize(
    "engine_path",
    [
        "/etc/passwd",
        "/output/",
        "/output/../etc/passwd",
        "/output/a/../../x",
        "/output/./x",
        "/outputx",
    ],
)
def test_an_engine_path_outside_its_folder_is_refused(dirs, engine_path):
    output, workspace = dirs
    with pytest.raises(files.HandoffError):
        files.bring_in(engine_path, output_dir=output, workspace_root=workspace, folder="downloads")
    assert not (workspace / "downloads").exists()


def test_a_link_in_the_engine_volume_is_refused_and_removed(dirs, tmp_path):
    output, workspace = dirs
    secret = tmp_path / "core-secret.txt"
    secret.write_text("not hers to have")
    (output / "link.txt").symlink_to(secret)
    with pytest.raises(files.HandoffError, match="not a plain file"):
        files.bring_in(
            "/output/link.txt", output_dir=output, workspace_root=workspace, folder="downloads"
        )
    assert not (output / "link.txt").exists(), "the link is removed"
    assert secret.read_text() == "not hers to have", "its target is untouched"
    assert not (workspace / "downloads").exists()


def test_a_folder_outside_the_workspace_is_refused(dirs):
    output, workspace = dirs
    _put(output, "y.bin")
    with pytest.raises(files.HandoffError, match="outside the workspace"):
        files.bring_in(
            "/output/y.bin", output_dir=output, workspace_root=workspace, folder="../elsewhere"
        )


def test_a_file_that_is_not_there_is_said_so(dirs):
    output, workspace = dirs
    with pytest.raises(files.HandoffError, match="it is not there"):
        files.bring_in(
            "/output/gone.bin", output_dir=output, workspace_root=workspace, folder="downloads"
        )


def test_a_file_over_the_cap_is_stated_not_copied_and_removed(dirs, monkeypatch):
    output, workspace = dirs
    monkeypatch.setattr(files, "MAX_BRING_BYTES", 10)
    _put(output, "big.bin", b"x" * 11)
    with pytest.raises(files.HandoffError, match="over the 1 GiB"):
        files.bring_in(
            "/output/big.bin", output_dir=output, workspace_root=workspace, folder="downloads"
        )
    assert not (output / "big.bin").exists()
    assert not (workspace / "downloads").exists()


def test_a_copy_that_does_not_match_keeps_nothing(dirs, monkeypatch):
    output, workspace = dirs
    _put(output, "r.txt", b"abc")
    real = files._sha256
    calls = iter([real, lambda path: "0" * 64])
    monkeypatch.setattr(files, "_sha256", lambda path: next(calls)(path))
    with pytest.raises(files.HandoffError, match="did not match"):
        files.bring_in(
            "/output/r.txt", output_dir=output, workspace_root=workspace, folder="downloads"
        )
    assert (output / "r.txt").exists(), "the engine's copy stays when the copy failed its check"
    assert list((workspace / "downloads").iterdir()) == []


def test_the_output_folder_comes_from_the_environment(monkeypatch):
    monkeypatch.setenv(files.OUTPUT_DIR_ENV, "/somewhere/else")
    assert files.output_dir_from_env() == Path("/somewhere/else")
    monkeypatch.delenv(files.OUTPUT_DIR_ENV)
    assert files.output_dir_from_env() == Path(files.DEFAULT_OUTPUT_DIR)


def test_publish_retries_when_the_name_is_taken_between_check_and_link(dirs, monkeypatch):
    # G10: _free_name only checks existence; between that check and the old
    # os.replace publish, another writer (a second download, her own
    # write_file) could create the chosen name, and os.replace would
    # silently overwrite it. Here the FIRST name _free_name offers gets
    # created by someone else right after it is chosen, simulating that
    # race -- the real free-name scheme (` (n)`) must still be used to find
    # the next one, the racing file must survive untouched, and no `.part`
    # may be left behind.
    output, workspace = dirs
    _put(output, "report.txt", b"the page's")
    real_free_name = files._free_name
    calls = {"n": 0}

    def racy_free_name(folder, name):
        candidate = real_free_name(folder, name)
        calls["n"] += 1
        if calls["n"] == 1:
            candidate.parent.mkdir(parents=True, exist_ok=True)
            candidate.write_text("a racing writer got here first")
        return candidate

    monkeypatch.setattr(files, "_free_name", racy_free_name)
    brought = files.bring_in(
        "/output/report.txt", output_dir=output, workspace_root=workspace, folder="downloads"
    )
    assert brought.path == "downloads/report (2).txt"
    assert calls["n"] >= 2
    assert (workspace / "downloads" / "report.txt").read_text() == "a racing writer got here first"
    assert (workspace / "downloads" / "report (2).txt").read_bytes() == b"the page's"
    assert not any(p.name.endswith(".part") for p in (workspace / "downloads").iterdir())
    assert not (output / "report.txt").exists()
