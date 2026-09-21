"""restore.sh — the four-backend probe, gated by a known-answer test.

No docker anywhere in this file. Where a backend has to be present or absent,
PATH is built to make it so, and `docker` is a stub that records every
invocation. The cases that matter:

  * the probe accepts the FIRST candidate that passes the KAT, and does not
    keep going once one has;
  * a backend that cannot decrypt at all is skipped, and a backend that CAN
    decrypt and still fails the KAT stops the run — because that is the
    passphrase or the file, and every other backend will fail identically,
    before any payload byte is read;
  * no candidate passing prints what to install and the `docker pull` lines,
    and exits non-zero. It never tries anyway.
"""

import json
import os
import shutil
import subprocess
import sys
import tarfile

import pytest
from bundle_fixtures import BACKUP_DIR, PASSPHRASE, make_bundle

import novabundle as nb

RESTORE_SH = BACKUP_DIR / "restore.sh"

# Everything restore.sh reaches for that is not a shell builtin.
NEEDED = (
    "tar",
    "mktemp",
    "chmod",
    "sed",
    "head",
    "tr",
    "rm",
    "cat",
    "basename",
    "dirname",
    "date",
    "mkdir",
    "stty",
    "sh",
    "env",
    "uname",
)


def bin_dir(tmp_path, *, python3=None, docker=None):
    """A PATH holding exactly what we say it holds."""
    path = tmp_path / "bin"
    path.mkdir(exist_ok=True)
    for name in NEEDED:
        found = shutil.which(name)
        if found and not (path / name).exists():
            (path / name).symlink_to(found)
    if python3:
        (path / "python3").write_text(python3)
        os.chmod(path / "python3", 0o755)
    if docker:
        (path / "docker").write_text(docker)
        os.chmod(path / "docker", 0o755)
    return path


def run_sh(bundle, path, *args, passphrase=PASSPHRASE, extra_env=None):
    env = {
        "PATH": str(path),
        "NOVA_BACKUP_PASSPHRASE": passphrase,
        "TMPDIR": os.environ.get("TMPDIR", "/tmp"),
    }
    env.update(extra_env or {})
    return subprocess.run(
        ["sh", str(RESTORE_SH), str(bundle), *args],
        capture_output=True,
        text=True,
        env=env,
    )


REAL_PYTHON = f"""#!/bin/sh
# records every invocation, then delegates to the real interpreter
printf '%s\\n' "$*" >> "$NOVA_TEST_LOG"
exec {sys.executable} "$@"
"""

PYTHON_NO_BACKEND_ON_FIRST = f"""#!/bin/sh
printf '%s\\n' "$*" >> "$NOVA_TEST_LOG"
if [ "${{NOVA_FORCE_CTYPES_GCM:-0}}" != "1" ] && [ "${{1:-}}" != "-c" ]; then
  echo 'ERROR: pretend this build has no usable AES' >&2
  exit 4
fi
exec {sys.executable} "$@"
"""

DOCKER_RECORDER = """#!/bin/sh
printf '%s\\n' "$*" >> "$NOVA_TEST_DOCKER_LOG"
exit 1
"""


@pytest.fixture
def bundle(tmp_path):
    path, manifest, stage = make_bundle(tmp_path)
    return path


def test_the_probe_accepts_the_first_candidate_that_passes(bundle, tmp_path):
    log = tmp_path / "python.log"
    dlog = tmp_path / "docker.log"
    path = bin_dir(tmp_path, python3=REAL_PYTHON, docker=DOCKER_RECORDER)
    done = run_sh(
        bundle,
        path,
        "--verify-only",
        extra_env={"NOVA_TEST_LOG": str(log), "NOVA_TEST_DOCKER_LOG": str(dlog)},
    )
    assert done.returncode == 0, done.stderr
    assert "known-answer test passed" in done.stderr
    assert "cryptography package" in done.stderr
    assert not dlog.exists(), "docker was reached although a host backend passed"
    kats = [line for line in log.read_text().splitlines() if "--kat" in line]
    assert len(kats) == 1, f"the probe kept going after a candidate passed: {kats}"


def test_a_backend_that_cannot_decrypt_is_skipped_not_fatal(bundle, tmp_path):
    log = tmp_path / "python.log"
    dlog = tmp_path / "docker.log"
    path = bin_dir(tmp_path, python3=PYTHON_NO_BACKEND_ON_FIRST, docker=DOCKER_RECORDER)
    done = run_sh(
        bundle,
        path,
        "--verify-only",
        extra_env={"NOVA_TEST_LOG": str(log), "NOVA_TEST_DOCKER_LOG": str(dlog)},
    )
    assert done.returncode == 0, done.stderr + done.stdout
    assert "no decryptor in that backend; trying the next" in done.stderr
    assert "ctypes" in done.stderr
    assert not dlog.exists()


def test_a_wrong_passphrase_stops_before_any_payload_byte_is_read(bundle, tmp_path):
    log = tmp_path / "python.log"
    dlog = tmp_path / "docker.log"
    path = bin_dir(tmp_path, python3=REAL_PYTHON, docker=DOCKER_RECORDER)
    done = run_sh(
        bundle,
        path,
        "--verify-only",
        passphrase="not-the-passphrase-at-all",
        extra_env={"NOVA_TEST_LOG": str(log), "NOVA_TEST_DOCKER_LOG": str(dlog)},
    )
    assert done.returncode == 1
    assert nb.BAD_DECRYPT in done.stderr
    assert "passphrase or the bundle, not this machine" in done.stderr
    ran = log.read_text().splitlines()
    assert ran, "the reader was never invoked"
    assert all("--kat" in line or line.startswith("-c") for line in ran), (
        f"something other than the KAT probe ran with a wrong passphrase: {ran}"
    )
    assert not any("--verify-only" in line for line in ran)
    assert not dlog.exists(), "it kept probing after a working decryptor said the KAT failed"


def test_no_candidate_prints_what_to_install_and_the_pull_lines(bundle, tmp_path):
    path = bin_dir(tmp_path)  # no python3, no docker
    done = run_sh(bundle, path, "--verify-only")
    assert done.returncode == 1
    assert "no way to decrypt this bundle on this machine" in done.stderr
    assert "pip install cryptography" in done.stderr
    assert "brew install" in done.stderr
    with tarfile.open(bundle, "r:") as tar:
        meta = json.loads(tar.extractfile("meta.json").read().decode())
    for image in meta["needs_images"]:
        assert f"docker pull {image}" in done.stderr
    assert "NOVA_LIBCRYPTO" in done.stderr


def test_it_never_falls_back_to_trying_anyway(bundle, tmp_path):
    dlog = tmp_path / "docker.log"
    path = bin_dir(tmp_path, docker=DOCKER_RECORDER)
    out = tmp_path / "out"
    done = run_sh(bundle, path, str(out), extra_env={"NOVA_TEST_DOCKER_LOG": str(dlog)})
    assert done.returncode == 1
    assert "does not try anyway" in done.stderr
    assert not out.exists() or not list(out.iterdir())
    assert "verified" not in done.stdout


def test_the_passphrase_never_reaches_an_argv_or_an_env_flag(bundle, tmp_path):
    """§7.5, on the restore side. The probe runs docker four ways and the
    passphrase goes on stdin in every one of them."""
    dlog = tmp_path / "docker.log"
    path = bin_dir(tmp_path, docker=DOCKER_RECORDER)
    done = run_sh(bundle, path, "--verify-only", extra_env={"NOVA_TEST_DOCKER_LOG": str(dlog)})
    assert done.returncode == 1
    recorded = dlog.read_text() if dlog.exists() else ""
    assert PASSPHRASE not in recorded
    assert " -e " not in recorded
    assert "--env" not in recorded


def test_it_refuses_a_missing_bundle(tmp_path):
    path = bin_dir(tmp_path, python3=REAL_PYTHON)
    done = run_sh(tmp_path / "nope.tar", path, "--verify-only")
    assert done.returncode == 2
    assert "no such file" in done.stderr


def test_it_refuses_a_tar_that_is_not_a_nova_bundle(tmp_path):
    path = bin_dir(tmp_path, python3=REAL_PYTHON)
    other = tmp_path / "other.tar"
    (tmp_path / "x.txt").write_text("hello\n")
    with tarfile.open(other, "w") as tar:
        tar.add(tmp_path / "x.txt", arcname="x.txt")
    done = run_sh(other, path, "--verify-only")
    assert done.returncode != 0
    assert "cleartext members" in done.stderr


def test_it_states_a_cannot_rather_than_prompting_without_a_terminal(bundle, tmp_path):
    path = bin_dir(tmp_path, python3=REAL_PYTHON)
    done = subprocess.run(
        ["sh", str(RESTORE_SH), str(bundle), "--verify-only"],
        capture_output=True,
        text=True,
        env={"PATH": str(path), "TMPDIR": os.environ.get("TMPDIR", "/tmp")},
    )
    assert done.returncode == 2
    assert "cannot prompt without a terminal" in done.stderr


def test_the_work_directory_is_removed_on_every_path(bundle, tmp_path):
    workdir = tmp_path / "tmp"
    workdir.mkdir()
    path = bin_dir(tmp_path, python3=REAL_PYTHON)
    log = tmp_path / "python.log"
    done = run_sh(
        bundle,
        path,
        "--verify-only",
        extra_env={"TMPDIR": str(workdir), "NOVA_TEST_LOG": str(log)},
    )
    assert done.returncode == 0, done.stderr
    assert list(workdir.iterdir()) == [], "the decrypted work directory outlived the run"


def test_restore_sh_parses_under_plain_sh():
    assert subprocess.run(["sh", "-n", str(RESTORE_SH)]).returncode == 0
