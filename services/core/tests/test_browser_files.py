"""The files her browser makes, brought into her workspace (S38): checked by
size and sha256 before the engine's copy goes, never overwriting hers, never
leaving her workspace, never following a link out of the engine's volume —
and never trusting a second look at a path the engine's volume can change
between checks."""

from __future__ import annotations

import errno
import hashlib
import os
import time
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


@pytest.mark.parametrize("name", [" . . ", ". ..", ". . .", ". .. "])
def test_safe_name_never_returns_a_bare_dot_name(name):
    # M2: a single strip().lstrip(".") pass left " . . " as the bare name
    # "." -- as dangerous (it names the containing directory) as anything
    # a page could choose directly. Stripped to a fixed point, every one of
    # these has nothing meaningful left, so all of them fall back.
    assert files.safe_name(name) == "download"


def test_a_long_name_keeps_its_extension():
    # G29: the cap is in UTF-8 BYTES, not characters -- a name entirely of
    # multi-byte characters over-ran the real limit while under the old
    # character cap.
    name = files.safe_name("x" * 300 + ".pdf")
    assert len(name.encode()) <= files.MAX_NAME_BYTES and name.endswith(".pdf")


def test_a_long_cjk_name_is_brought_in_end_to_end(dirs):
    # G29: 94 CJK characters is 274 UTF-8 bytes -- past MAX_NAME_CHARS's old
    # 120-character cap's own byte count (up to 480), this raised a raw
    # "[Errno 36] File name too long" instead of being cut to fit.
    output, workspace = dirs
    _put(output, "x.pdf", b"%PDF")
    cjk = "報告書" * 30 + ".pdf"
    brought = files.bring_in(
        "/output/x.pdf", output_dir=output, workspace_root=workspace, folder="downloads", name=cjk
    )
    landed = workspace / brought.path
    assert landed.is_file() and landed.read_bytes() == b"%PDF"
    assert len(landed.name.encode()) <= files.MAX_NAME_BYTES
    assert landed.name.endswith(".pdf")
    assert not (output / "x.pdf").exists()


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


def test_a_nested_engine_path_is_refused_without_following_the_link(dirs, tmp_path):
    # G25: the engine reports flat paths only (every capture is
    # /output/<name>, never a subfolder). lstat and O_NOFOLLOW guard only
    # the LAST path component, so with output/d a symlink to a directory
    # outside the engine's volume, /output/d/secret.env was opened, copied
    # into her workspace, and then DELETED from where it actually was.
    output, workspace = dirs
    outside = tmp_path / "core-private"
    outside.mkdir()
    secret = outside / "secret.env"
    secret.write_text("TOKEN=not-hers\n")
    (output / "d").symlink_to(outside)
    with pytest.raises(files.HandoffError):
        files.bring_in(
            "/output/d/secret.env", output_dir=output, workspace_root=workspace, folder="downloads"
        )
    assert secret.read_text() == "TOKEN=not-hers\n", "the outside file is untouched"
    assert not (workspace / "downloads").exists(), "nothing was brought in"


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


def test_a_directory_is_never_unlinked_and_is_said_left(dirs):
    # G27: unconditionally unlinking whatever is not a plain file raises
    # IsADirectoryError for a directory the engine reports by name, and the
    # old message claimed "it was removed" regardless -- the directory, and
    # whatever the engine put in it, stayed exactly where it was.
    output, workspace = dirs
    (output / "adir").mkdir()
    (output / "adir" / "inner.txt").write_text("x")
    with pytest.raises(files.HandoffError, match="left where it was"):
        files.bring_in(
            "/output/adir", output_dir=output, workspace_root=workspace, folder="downloads"
        )
    assert (output / "adir" / "inner.txt").read_text() == "x"


def test_a_removal_failure_on_refusal_is_stated_not_claimed(dirs, monkeypatch):
    # G27: suppress(OSError) around the unlink was followed by an
    # unconditional "the engine's copy was removed" -- an over-cap file
    # whose unlink failed (here, EROFS) said so anyway.
    output, workspace = dirs
    monkeypatch.setattr(files, "MAX_BRING_BYTES", 10)
    _put(output, "big.bin", b"x" * 11)
    real_unlink = os.unlink
    target = output / "big.bin"

    def erofs_unlink(path, *a, **kw):
        if Path(path) == target:
            raise OSError(errno.EROFS, "Read-only file system")
        return real_unlink(path, *a, **kw)

    monkeypatch.setattr(os, "unlink", erofs_unlink)
    with pytest.raises(files.HandoffError, match="could not be removed"):
        files.bring_in(
            "/output/big.bin", output_dir=output, workspace_root=workspace, folder="downloads"
        )
    assert target.exists()


def test_a_folder_outside_the_workspace_is_refused(dirs):
    output, workspace = dirs
    _put(output, "y.bin")
    with pytest.raises(files.HandoffError, match="outside the workspace"):
        files.bring_in(
            "/output/y.bin", output_dir=output, workspace_root=workspace, folder="../elsewhere"
        )


def test_a_symlinked_workspace_root_is_not_outside_itself(dirs, tmp_path):
    # M3: _resolve_within compares the REALPATH to workspace_root as given.
    # workspace_root is a dedicated docker volume mount, but a caller can
    # still reach it through a symlinked alias -- resolved first, as the
    # workspace tools resolve ctx.workspace_root, the alias is the same
    # root, not outside it.
    output, workspace = dirs
    _put(output, "r.txt", b"abc")
    alias = tmp_path / "ws-alias"
    alias.symlink_to(workspace)
    brought = files.bring_in(
        "/output/r.txt", output_dir=output, workspace_root=alias, folder="downloads"
    )
    assert brought.path == "downloads/r.txt"
    assert (workspace / "downloads" / "r.txt").read_bytes() == b"abc"


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
    # The destination's own re-read (after fsync) is compared against the
    # digest taken from the SAME source descriptor while copying -- forcing
    # that re-read to lie is what a disk-level corruption of the .part
    # would look like from here.
    output, workspace = dirs
    _put(output, "r.txt", b"abc")
    monkeypatch.setattr(files, "_sha256", lambda path: "0" * 64)
    with pytest.raises(files.HandoffError, match="did not match"):
        files.bring_in(
            "/output/r.txt", output_dir=output, workspace_root=workspace, folder="downloads"
        )
    assert (output / "r.txt").exists(), "the engine's copy stays when the copy failed its check"
    assert list((workspace / "downloads").iterdir()) == []


def test_a_file_swapped_for_another_between_lstat_and_open_is_refused(dirs, monkeypatch):
    # G26: the old open(source, "rb", opener=_no_follow) trusted the EARLIER
    # lstat for everything but the symlink bit. Swap the regular file for a
    # DIFFERENT regular file (new inode) in the gap, and the wrong file's
    # bytes would have been copied, checked against themselves, and kept.
    # Same byte count on both sides of the swap, so this isolates the
    # identity (dev+inode) check from the separate size/hash check below —
    # os.replace, not unlink-then-create, so the new inode is guaranteed
    # different rather than possibly reused by the filesystem.
    output, workspace = dirs
    src = output / "swap.bin"
    src.write_bytes(b"original bytes")  # 14 bytes
    real_lstat = os.lstat

    def swap_lstat(path, *a, **kw):
        result = real_lstat(path, *a, **kw)
        if Path(path) == src:
            replacement = src.with_name("replacement.bin")
            replacement.write_bytes(b"swapped bytes!")  # 14 bytes, different inode
            os.replace(replacement, src)
        return result

    monkeypatch.setattr(os, "lstat", swap_lstat)
    with pytest.raises(files.HandoffError, match="changed underneath"):
        files.bring_in(
            "/output/swap.bin", output_dir=output, workspace_root=workspace, folder="downloads"
        )
    assert not (workspace / "downloads").exists()


def test_a_fifo_swapped_in_after_lstat_is_refused_without_blocking(dirs):
    # G26: swapped to a FIFO with no writer, the old blocking open() would
    # hang forever (Task 5 runs this in asyncio.to_thread, so the hang ties
    # up a thread and her turn). O_NONBLOCK on the open, then fstat -- never
    # a read -- is what refuses it immediately instead.
    output, workspace = dirs
    src = output / "swap.bin"
    src.write_bytes(b"abc")
    real_lstat = os.lstat

    def fifo_swap_lstat(path, *a, **kw):
        result = real_lstat(path, *a, **kw)
        if Path(path) == src:
            src.unlink()
            os.mkfifo(src)
        return result

    os.lstat = fifo_swap_lstat
    try:
        start = time.perf_counter()
        with pytest.raises(files.HandoffError):
            files.bring_in(
                "/output/swap.bin", output_dir=output, workspace_root=workspace, folder="downloads"
            )
        elapsed = time.perf_counter() - start
    finally:
        os.lstat = real_lstat
    assert elapsed < 2.0, f"blocked for {elapsed:.2f}s"
    assert not (workspace / "downloads").exists()


def test_a_file_that_grows_during_the_copy_is_refused_with_nothing_kept(dirs, monkeypatch):
    # G26: the old copy loop read until EOF, unbounded by the size already
    # checked against MAX_BRING_BYTES -- a file that grew after the lstat
    # had 8M+ bytes written to its .part before the size check ever ran.
    # Bounding the read at info.st_size, then requiring EOF right after,
    # catches the growth without ever reading past the checked size.
    output, workspace = dirs
    src = output / "grow.bin"
    src.write_bytes(b"x" * 5)
    monkeypatch.setattr(files, "MAX_BRING_BYTES", 10)
    real_lstat = os.lstat

    def growing_lstat(path, *a, **kw):
        result = real_lstat(path, *a, **kw)
        if Path(path) == src:
            with open(src, "ab") as handle:
                handle.write(b"y" * (1024 * 1024))
        return result

    monkeypatch.setattr(os, "lstat", growing_lstat)
    with pytest.raises(files.HandoffError, match="did not match"):
        files.bring_in(
            "/output/grow.bin", output_dir=output, workspace_root=workspace, folder="downloads"
        )
    # The growth is only detected mid-copy (the source is genuinely the
    # same checked file, just grown in place), so folder/ itself may exist
    # by then -- what matters is that no file, partial or otherwise, is in
    # it.
    downloads = workspace / "downloads"
    assert not downloads.exists() or list(downloads.iterdir()) == []


def test_a_failed_final_removal_is_stated_but_not_a_failure(dirs, monkeypatch):
    # M4: today a failed final removal raised raw, so the file is in her
    # workspace but she is told the bring-in failed -- a retry would
    # duplicate it. left_in_engine carries the reason instead, and the
    # successful copy is still reported as what it is: done.
    output, workspace = dirs
    _put(output, "r.txt", b"abc")
    real_unlink = os.unlink
    target = output / "r.txt"

    def erofs_unlink(path, *a, **kw):
        if Path(path) == target:
            raise OSError(errno.EROFS, "Read-only file system")
        return real_unlink(path, *a, **kw)

    monkeypatch.setattr(os, "unlink", erofs_unlink)
    brought = files.bring_in(
        "/output/r.txt", output_dir=output, workspace_root=workspace, folder="downloads"
    )
    assert brought.path == "downloads/r.txt"
    assert brought.bytes == 3
    assert brought.left_in_engine and "Read-only" in brought.left_in_engine
    assert target.exists()
    assert (workspace / "downloads" / "r.txt").read_bytes() == b"abc"


def test_a_vanished_source_at_the_final_removal_is_not_a_failure(dirs):
    # The flip side of M4: the engine's own cleanup, or a second bring_in,
    # can remove the source before this one gets to it. Already gone is
    # success, not a reason to raise.
    output, workspace = dirs
    _put(output, "r.txt", b"abc")
    real_publish = files._publish

    def publish_then_source_vanishes(tmp_name, destination_dir, wanted):
        destination = real_publish(tmp_name, destination_dir, wanted)
        os.unlink(output / "r.txt")
        return destination

    files._publish = publish_then_source_vanishes
    try:
        brought = files.bring_in(
            "/output/r.txt", output_dir=output, workspace_root=workspace, folder="downloads"
        )
    finally:
        files._publish = real_publish
    assert brought.path == "downloads/r.txt"
    assert brought.left_in_engine is None


def test_an_os_error_during_publish_is_a_stated_handoff_error(dirs, monkeypatch):
    # G28: bring_in's docstring promises HandoffError alone; os.link can
    # fail for a reason other than a taken name (no hard-link support, a
    # permission problem), and that raw OSError used to escape straight
    # through -- Task 5 catches only HandoffError, so this turned the whole
    # browser action into an unhandled failure.
    output, workspace = dirs
    _put(output, "r.txt", b"abc")

    def eperm_link(src, dst, **kw):
        raise PermissionError(errno.EPERM, "Operation not permitted")

    monkeypatch.setattr(os, "link", eperm_link)
    with pytest.raises(files.HandoffError, match="could not publish"):
        files.bring_in(
            "/output/r.txt", output_dir=output, workspace_root=workspace, folder="downloads"
        )
    assert not any(p.name.endswith(".part") for p in (workspace / "downloads").iterdir())
    assert (output / "r.txt").exists()


def test_an_os_error_while_writing_is_a_stated_handoff_error(dirs, monkeypatch):
    # G28: the same escape, at the write step (ENOSPC).
    output, workspace = dirs
    _put(output, "r.txt", b"abc")

    def enospc_write(fd, data):
        raise OSError(errno.ENOSPC, "No space left on device")

    monkeypatch.setattr(os, "write", enospc_write)
    with pytest.raises(files.HandoffError, match="could not write"):
        files.bring_in(
            "/output/r.txt", output_dir=output, workspace_root=workspace, folder="downloads"
        )
    assert not any(p.name.endswith(".part") for p in (workspace / "downloads").iterdir())
    assert (output / "r.txt").exists()


def test_the_output_folder_comes_from_the_environment(monkeypatch):
    monkeypatch.setenv(files.OUTPUT_DIR_ENV, "/somewhere/else")
    assert files.output_dir_from_env() == Path("/somewhere/else")
    monkeypatch.delenv(files.OUTPUT_DIR_ENV)
    assert files.output_dir_from_env() == Path(files.DEFAULT_OUTPUT_DIR)


def test_a_dangling_link_at_the_chosen_name_is_skipped(dirs):
    # M1: Path.exists() is False for a dangling symlink, but os.link finds
    # the name taken -- picking names by checking exists() first offered
    # the SAME dangling name on every retry, 999 times, then gave up.
    output, workspace = dirs
    (workspace / "downloads").mkdir()
    (workspace / "downloads" / "report.txt").symlink_to(workspace / "does-not-exist")
    _put(output, "report.txt", b"the page's")
    brought = files.bring_in(
        "/output/report.txt", output_dir=output, workspace_root=workspace, folder="downloads"
    )
    assert brought.path == "downloads/report (2).txt"
    assert (workspace / "downloads" / "report.txt").is_symlink()
    assert not (workspace / "downloads" / "report.txt").exists()  # still dangling, untouched
    assert (workspace / "downloads" / "report (2).txt").read_bytes() == b"the page's"


def test_publish_tries_the_next_name_when_the_first_is_taken_mid_publish(dirs, monkeypatch):
    # G10, re-proved through the new publish shape: a free name can be
    # taken by another writer (a second download, her own write_file)
    # between the moment a candidate is chosen and the moment it is
    # linked. os.link raises FileExistsError on that race rather than
    # os.replace's silent overwrite, so the next candidate is tried.
    output, workspace = dirs
    _put(output, "report.txt", b"the page's")
    real_link = os.link
    calls = {"n": 0}

    def racy_link(src, dst, **kw):
        calls["n"] += 1
        if calls["n"] == 1:
            Path(dst).parent.mkdir(parents=True, exist_ok=True)
            Path(dst).write_text("a racing writer got here first")
        return real_link(src, dst, **kw)

    monkeypatch.setattr(os, "link", racy_link)
    brought = files.bring_in(
        "/output/report.txt", output_dir=output, workspace_root=workspace, folder="downloads"
    )
    assert brought.path == "downloads/report (2).txt"
    assert calls["n"] >= 2
    assert (workspace / "downloads" / "report.txt").read_text() == "a racing writer got here first"
    assert (workspace / "downloads" / "report (2).txt").read_bytes() == b"the page's"
    assert not any(p.name.endswith(".part") for p in (workspace / "downloads").iterdir())
    assert not (output / "report.txt").exists()


# ── fix round 2: G30 structural OSError wrap, linear safe_name, whole writes ──


def test_a_failing_workspace_root_resolve_is_a_stated_handoff_error(dirs, monkeypatch):
    # G30/A: workspace_root.resolve() (M3) sat outside every try/except --
    # a PermissionError from it escaped bring_in raw.
    output, workspace = dirs
    _put(output, "r.txt", b"abc")
    real_resolve = Path.resolve

    def failing_resolve(self, *a, **kw):
        if self == workspace:
            raise PermissionError(13, "Permission denied")
        return real_resolve(self, *a, **kw)

    monkeypatch.setattr(Path, "resolve", failing_resolve)
    with pytest.raises(files.HandoffError, match="could not read the workspace folder"):
        files.bring_in(
            "/output/r.txt", output_dir=output, workspace_root=workspace, folder="downloads"
        )
    assert (output / "r.txt").exists()
    assert not (workspace / "downloads").exists()


def test_a_failing_lstat_is_a_stated_handoff_error(dirs, monkeypatch):
    # G30/A: os.lstat(source) caught only FileNotFoundError -- a
    # PermissionError or ELOOP escaped raw (a pre-existing gap, same
    # class, fixed alongside the new one).
    output, workspace = dirs
    src = output / "r.txt"
    src.write_bytes(b"abc")
    real_lstat = os.lstat

    def failing_lstat(path, *a, **kw):
        if Path(path) == src:
            raise PermissionError(13, "Permission denied")
        return real_lstat(path, *a, **kw)

    monkeypatch.setattr(os, "lstat", failing_lstat)
    with pytest.raises(files.HandoffError, match="could not check"):
        files.bring_in(
            "/output/r.txt", output_dir=output, workspace_root=workspace, folder="downloads"
        )
    assert src.exists()
    assert not (workspace / "downloads").exists()


def test_safe_name_is_linear_on_a_hostile_name():
    # M2's fixed-point strip().lstrip(".") loop re-walked the whole,
    # uncapped name every round: 1.5 s at 256 KB, quadratic beyond.
    # Measured on this machine (best of 3, 2026-10-05): the alternating
    # ". " shape took 0.039 s at 4,000,000 chars, and the dots-then-
    # "a.txt" shape took 0.026 s -- budget set past 10x the slower one.
    hostile = [(". " * 2_000_000, "download"), ("." * 4_000_000 + "a.txt", "a.txt")]
    for name, expected in hostile:
        start = time.perf_counter()
        result = files.safe_name(name)
        elapsed = time.perf_counter() - start
        assert elapsed < 0.4, f"{elapsed:.3f}s for {len(name)} chars"
        assert result == expected


def test_a_short_write_is_retried_until_the_whole_chunk_lands(dirs, monkeypatch):
    # C: write(2) may write fewer bytes than asked without that being an
    # error -- the raw-fd loop never checked os.write's return value, so a
    # short write silently dropped bytes, later caught only as a
    # mismatched hash/size rather than handled. Realistic: never writes 0
    # for a non-empty request, which real write(2) essentially never does
    # either (see the dedicated zero-return test below).
    output, workspace = dirs
    data = os.urandom(2 * 1024 * 1024 + 7)
    _put(output, "big.bin", data)
    real_write = os.write

    def half_write(fd, buf):
        n = max(1, len(buf) // 2)
        return real_write(fd, bytes(buf)[:n])

    monkeypatch.setattr(os, "write", half_write)
    brought = files.bring_in(
        "/output/big.bin", output_dir=output, workspace_root=workspace, folder="downloads"
    )
    landed = workspace / brought.path
    assert landed.read_bytes() == data
    assert not (output / "big.bin").exists()


def test_a_zero_byte_write_is_a_stated_error_not_a_spin(dirs, monkeypatch):
    # C: os.write returning 0 for a non-empty request is the one write(2)
    # outcome that is never progress -- retrying it would be a spin, so
    # it is refused immediately instead.
    output, workspace = dirs
    _put(output, "r.txt", b"abc")

    def zero_write(fd, buf):
        return 0

    monkeypatch.setattr(os, "write", zero_write)
    with pytest.raises(files.HandoffError, match="a write of 0 bytes"):
        files.bring_in(
            "/output/r.txt", output_dir=output, workspace_root=workspace, folder="downloads"
        )
    assert not any(p.name.endswith(".part") for p in (workspace / "downloads").iterdir())
    assert (output / "r.txt").exists()


def test_the_re_reviewers_exact_halving_write_degenerates_to_a_stated_zero(dirs, monkeypatch):
    # Documents a finding, not just a test: the re-reviewer's own probe
    # (scratchpad/t3rr1/probe_shortwrite.py) halves unconditionally
    # (buf[:len(buf)//2], no floor at 1). ANY positive integer, repeatedly
    # floor-halved, reaches exactly 1, and half of 1 is 0 -- so this
    # EXACT mechanism always ends in a 0-byte write for ANY chunk size,
    # regardless of the file's total size. The probe's own code already
    # treats a HandoffError as "fails safe" (a distinct branch from a RAW
    # exception) rather than requiring success, which is what this is: a
    # stated refusal, not a crash, and the engine's copy is kept either
    # way.
    output, workspace = dirs
    data = b"x" * (2 * 1024 * 1024 + 3)  # the probe's own shape
    _put(output, "big.bin", data)
    real_write = os.write

    def halving_write(fd, buf):
        return real_write(fd, bytes(buf)[: len(buf) // 2])

    monkeypatch.setattr(os, "write", halving_write)
    with pytest.raises(files.HandoffError, match="a write of 0 bytes"):
        files.bring_in(
            "/output/big.bin", output_dir=output, workspace_root=workspace, folder="downloads"
        )
    assert (output / "big.bin").exists()
    downloads = workspace / "downloads"
    assert not downloads.exists() or list(downloads.iterdir()) == []
