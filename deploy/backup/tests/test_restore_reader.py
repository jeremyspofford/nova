"""The pin between two implementations of one format.

`novabundle.py` writes; `nova_restore.py` reads. They are separate files on
purpose — the reader travels inside every bundle and imports nothing — which
means nothing but a test stops them drifting apart, and the day they drift is
the day a bundle stops opening on the machine that needs it.

Every case here runs the reader in a SUBPROCESS, over both backends, with an
assertion that the forcing actually took. Backend 2 (ctypes libcrypto) is the
path a bare machine takes; asserting only backend 1 would prove the path this
machine happens to have.
"""

import json
import os
import subprocess
import sys
import tarfile

import pytest
from bundle_fixtures import BACKUP_DIR, PASSPHRASE, make_bundle

import novabundle as nb

READER = BACKUP_DIR / "nova_restore.py"
BACKENDS = {"0": "cryptography", "1": "system OpenSSL via ctypes"}


def reader(*args, passphrase=PASSPHRASE, force="0", **kwargs):
    env = dict(os.environ, NOVA_FORCE_CTYPES_GCM=force)
    env.pop("NOVA_BACKUP_PASSPHRASE", None)
    return subprocess.run(
        [sys.executable, str(READER), *args],
        input=None if passphrase is None else passphrase + "\n",
        text=True,
        capture_output=True,
        env=env,
        **kwargs,
    )


@pytest.fixture(scope="module")
def bundle(tmp_path_factory):
    path, manifest, stage = make_bundle(tmp_path_factory.mktemp("reader"))
    return path, manifest


@pytest.mark.parametrize("force", ["0", "1"])
def test_the_writers_bundle_opens_in_the_reader(bundle, force, tmp_path):
    path, manifest = bundle
    out = tmp_path / f"out-{force}"
    done = reader(str(path), "--out", str(out), force=force)
    assert done.returncode == 0, done.stderr
    assert BACKENDS[force] in done.stderr, (
        f"NOVA_FORCE_CTYPES_GCM={force} did not select the backend it claims to: {done.stderr!r}"
    )
    assert "verified" in done.stdout
    assert (out / "db" / "nova_core.dump").read_text().startswith("PGDMP")
    assert (out / "volumes" / "nova_v4_memdata" / "people" / "example" / "a-note.md").exists()
    assert (out / "project" / "deploy" / ".env").exists()
    assert (out / "env" / "carried.env").exists()


@pytest.mark.parametrize("force", ["0", "1"])
def test_verify_only_writes_nothing(bundle, force, tmp_path):
    path, manifest = bundle
    before = sorted(os.listdir(tmp_path))
    done = reader(str(path), "--verify-only", force=force, cwd=str(tmp_path))
    assert done.returncode == 0, done.stderr
    assert f"{manifest['member_count']} members" in done.stdout
    assert sorted(os.listdir(tmp_path)) == before


@pytest.mark.parametrize("force", ["0", "1"])
def test_both_backends_produce_the_same_failure_sentence(bundle, force):
    path, _ = bundle
    done = reader(str(path), "--kat", passphrase="not-the-passphrase", force=force)
    assert done.returncode == 1
    assert nb.BAD_DECRYPT in done.stderr
    assert BACKENDS[force] in done.stderr


@pytest.mark.parametrize("force", ["0", "1"])
def test_a_wrong_passphrase_is_told_apart_from_a_damaged_file(bundle, force):
    """§9.2 step 4: refuse with the one sentence PLUS the bundle's recorded
    fingerprint, so a rotation is stated when it is known and never guessed."""
    path, _ = bundle
    done = reader(str(path), "--kat", passphrase="not-the-passphrase", force=force)
    with tarfile.open(path, "r:") as tar:
        meta = json.loads(tar.extractfile("meta.json").read().decode())
    assert meta["passphrase_fingerprint"] in done.stderr
    assert "DIFFERENT passphrase" in done.stderr


@pytest.mark.parametrize("force", ["0", "1"])
def test_the_kat_passes_before_a_payload_byte_is_read(bundle, force, tmp_path):
    """The KAT is 64 known bytes with their own salt, so this proves the
    decryptor and the passphrase against something that is not the payload."""
    path, _ = bundle
    done = reader(str(path), "--kat", force=force)
    assert done.returncode == 0
    assert "known-answer test passed" in done.stdout
    assert "verified" not in done.stdout


def test_the_reader_refuses_a_tampered_payload_header(bundle, tmp_path):
    path, _ = bundle
    rebuilt = tmp_path / "tampered.tar"
    import io

    with tarfile.open(path, "r:") as src, tarfile.open(rebuilt, "w") as dst:
        for member in src.getmembers():
            data = src.extractfile(member).read()
            if member.name == "payload.enc":
                header_length = int.from_bytes(data[8:12], "big")
                header = json.loads(data[12 : 12 + header_length].decode())
                header["n"] = 1 << 19
                fresh = json.dumps(header, separators=(",", ":"), sort_keys=True).encode()
                data = data[:8] + len(fresh).to_bytes(4, "big") + fresh + data[12 + header_length :]
                member.size = len(data)
            dst.addfile(member, io.BytesIO(data))
    done = reader(str(rebuilt), "--verify-only")
    assert done.returncode == 1
    assert "will pay for" in done.stderr
    assert "Traceback" not in done.stderr


def test_the_reader_leaves_nothing_behind_when_it_fails(bundle, tmp_path):
    """A half-decrypted .env must never be left looking like a finished
    restore: on ANY exception everything the run created under --out goes."""
    path, _ = bundle
    truncated = tmp_path / "cut.tar"
    data = path.read_bytes()
    with tarfile.open(path, "r:") as tar:
        # Cut INSIDE the payload, not off the tar's trailing padding: the
        # outer tar is mostly zero blocks and a naive `data[:-2000]` leaves a
        # perfectly readable file.
        cut = tar.getmember("payload.enc").offset_data + 64
    truncated.write_bytes(data[:cut])
    out = tmp_path / "half"
    done = reader(str(truncated), "--out", str(out))
    assert done.returncode == 1
    assert not out.exists() or not list(out.iterdir())


def test_the_reader_refuses_a_non_empty_output_directory(bundle, tmp_path):
    path, _ = bundle
    out = tmp_path / "busy"
    out.mkdir()
    (out / "something").write_text("mine\n")
    done = reader(str(path), "--out", str(out))
    assert done.returncode == 2
    assert "not empty" in done.stderr
    assert (out / "something").read_text() == "mine\n"


def test_the_reader_needs_no_third_party_package(bundle, tmp_path):
    """The whole reason the KDF is stdlib scrypt: a machine with only docker
    runs this file under a bare python:3.12-slim, which has no packages at
    all. Forced-ctypes mode is that path, and `import cryptography` failing
    must not even be reachable."""
    path, _ = bundle
    done = reader(str(path), "--kat", force="1")
    assert done.returncode == 0
    assert "cryptography" not in done.stderr


def test_the_umask_is_set_before_anything_is_opened(bundle, tmp_path):
    """os.umask(0o077) is main()'s first statement, so the directory this run
    creates is 0700 and nothing under it is reachable by another user.

    The MEMBERS keep their recorded modes on purpose — restore diffs a volume
    tree against a listing that records mode, uid and gid for every entry, so
    re-moding them here would make the restore refuse a correct bundle. The
    0700 above them is what protects the .env and the dumps inside.
    """
    path, _ = bundle
    out = tmp_path / "modes"
    done = reader(str(path), "--out", str(out))
    assert done.returncode == 0, done.stderr
    assert oct(os.stat(out).st_mode & 0o777) == "0o700"
    for name in ("db", "volumes", "project", "env"):
        created = out / name
        if created.exists():
            assert os.stat(created).st_mode & 0o077 == 0, name
