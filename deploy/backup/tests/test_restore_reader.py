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
def test_a_wrong_passphrase_reports_both_fingerprints_and_claims_neither(bundle, force):
    """§9.2 step 4: refuse with the one sentence PLUS the bundle's recorded
    fingerprint, so a rotation is STATED when it is known.

    And never more than that. Both numbers come from cleartext this reader
    cannot authenticate — meta.json, and the salt in kat.enc's header — so an
    edited salt makes the CORRECT passphrase derive a different value here.
    Asserting "a DIFFERENT passphrase, not a damaged file" on those bytes is
    the 3am failure the pinned sentence exists to prevent, inverted.
    """
    path, _ = bundle
    done = reader(str(path), "--kat", passphrase="not-the-passphrase", force=force)
    with tarfile.open(path, "r:") as tar:
        meta = json.loads(tar.extractfile("meta.json").read().decode())
    assert meta["passphrase_fingerprint"] in done.stderr
    assert "EITHER a different passphrase OR an edited file" in done.stderr
    assert "cannot say which" in done.stderr
    assert "not a damaged file" not in done.stderr


@pytest.mark.parametrize("force", ["0", "1"])
def test_an_edited_kat_salt_does_not_become_a_claim_about_the_passphrase(bundle, force, tmp_path):
    """Measured by the reviewer: rewriting kat.enc's salt made the reader
    tell an operator holding the CORRECT passphrase that his was a different
    one. Both fingerprints are advisory; the file is what changed."""
    path, _ = bundle
    rebuilt = tmp_path / f"salted-{force}.tar"
    import io as _io

    with tarfile.open(path, "r:") as src, tarfile.open(rebuilt, "w") as dst:
        for member in src.getmembers():
            data = src.extractfile(member).read()
            if member.name == "kat.enc":
                header_length = int.from_bytes(data[8:12], "big")
                header = json.loads(data[12 : 12 + header_length].decode())
                header["salt"] = "ff" * 16
                fresh = json.dumps(header, separators=(",", ":"), sort_keys=True).encode()
                data = data[:8] + len(fresh).to_bytes(4, "big") + fresh + data[12 + header_length :]
                member.size = len(data)
            dst.addfile(member, _io.BytesIO(data))
    done = reader(str(rebuilt), "--kat", force=force)
    assert done.returncode == 1
    assert nb.BAD_DECRYPT in done.stderr
    assert "not a damaged file" not in done.stderr
    assert "cannot say which" in done.stderr


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


# ── a broken backend is a fault of the MACHINE, not of the bundle ───────────
#
# A `cryptography` that imports and cannot decrypt is an ordinary thing: a
# mismatched wheel, a half-finished upgrade, a musl/glibc mix. Reported as a
# bundle fault it stopped restore.sh's probe dead on a machine where three
# other backends worked, and told the operator holding his only copy that his
# passphrase or his file was wrong.

LYING_AESGCM = """
class AESGCM:
    def __init__(self, key):
        pass

    def decrypt(self, nonce, data, aad):
        return b"garbage that is not the plaintext"
"""

UNAUTHENTICATED_AESGCM = '''
_PLAIN = b"nova AES-256-GCM backend self-test"


class AESGCM:
    """Decrypts, and never looks at the tag — a CTR-mode stand-in."""

    def __init__(self, key):
        pass

    def decrypt(self, nonce, data, aad):
        return _PLAIN
'''


def fake_cryptography(root, body):
    """A `cryptography` package that imports, on PYTHONPATH."""
    pkg = root / "fake"
    leaf = pkg / "cryptography" / "hazmat" / "primitives" / "ciphers"
    leaf.mkdir(parents=True)
    for part in (
        pkg / "cryptography",
        pkg / "cryptography" / "hazmat",
        pkg / "cryptography" / "hazmat" / "primitives",
        leaf,
    ):
        (part / "__init__.py").write_text("")
    (leaf / "aead.py").write_text(body)
    return pkg


@pytest.mark.parametrize(
    "body,why", [(LYING_AESGCM, "wrong bytes"), (UNAUTHENTICATED_AESGCM, "tag")]
)
def test_a_broken_backend_exits_4_so_the_probe_can_move_on(bundle, tmp_path, body, why):
    path, _ = bundle
    pkg = fake_cryptography(tmp_path / why.replace(" ", "-"), body)
    env = dict(os.environ, PYTHONPATH=str(pkg))
    env.pop("NOVA_FORCE_CTYPES_GCM", None)
    done = subprocess.run(
        [sys.executable, str(READER), str(path), "--kat"],
        input=PASSPHRASE + "\n",
        text=True,
        capture_output=True,
        env=env,
    )
    assert done.returncode == 4, (
        f"exit {done.returncode}: a machine fault reported with the bundle's exit code "
        f"stops the probe instead of moving to the next backend\n{done.stderr}"
    )
    assert "backend" in done.stderr
    assert nb.BAD_DECRYPT not in done.stderr, "a broken backend is not a failed KAT"


def test_a_backend_that_ignores_the_gcm_tag_is_refused(bundle, tmp_path):
    """Every truncation and tampering guarantee in this file rests on the tag
    check, so "it decrypted the known vector" is not enough to accept one."""
    path, _ = bundle
    pkg = fake_cryptography(tmp_path / "ctr", UNAUTHENTICATED_AESGCM)
    env = dict(os.environ, PYTHONPATH=str(pkg))
    env.pop("NOVA_FORCE_CTYPES_GCM", None)
    done = subprocess.run(
        [sys.executable, str(READER), str(path), "--kat"],
        input=PASSPHRASE + "\n",
        text=True,
        capture_output=True,
        env=env,
    )
    assert done.returncode == 4
    assert "tag is wrong" in done.stderr


def test_the_real_backends_pass_their_own_self_test(bundle):
    """The other half: the check must not be so strict that a working
    backend fails it."""
    path, _ = bundle
    for force in ("0", "1"):
        done = reader(str(path), "--kat", force=force)
        assert done.returncode == 0, done.stderr
