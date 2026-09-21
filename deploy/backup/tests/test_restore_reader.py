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
import stat
import subprocess
import sys
import tarfile

import pytest
from bundle_fixtures import BACKUP_DIR, PASSPHRASE, make_bundle

import nova_restore as nr
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


# ── the tree that lands is the tree the listing describes ──────────────────
#
# T4 measured both of these against the real reader, restoring into real
# volumes (task-4-report.md, "The two defects in nova_restore.py"):
#
#   1. `--out` placed every member EXCEPT MANIFEST.json, because
#      `_open_payload` read the manifest with `tar.next()` and then re-scanned
#      from the CURRENT offset — so the placement guard `if
#      os.path.isfile(carried)` never fired, and a bare machine got the
#      content without the file that says what it is.
#   2. The extraction landed a 0755 directory as 0700 and a 0444 file as
#      0644, and `verify_extracted` did not notice because it compares the
#      listing to the TAR HEADERS. A verification that passes over a wrong
#      tree is the defect this slice exists against.


def listing_rows(path):
    """(metadata per ./path, link target per ./path) out of a placed listing."""
    meta, _hashes, links, bad = nb.parse_listing(path.read_text())
    assert not bad, bad
    return meta, links


def disk_row(path):
    """`<kind> <mode> <uid> <gid>` for what is ACTUALLY on disk."""
    st = os.lstat(path)
    if stat.S_ISLNK(st.st_mode):
        kind = "l"
    elif stat.S_ISDIR(st.st_mode):
        kind = "d"
    elif stat.S_ISREG(st.st_mode):
        kind = "f"
    else:
        kind = "?"
    return f"{kind} {nb._mode_octal(st.st_mode)} {st.st_uid} {st.st_gid}"


@pytest.mark.parametrize("force", ["0", "1"])
def test_out_places_the_manifest_that_describes_what_it_placed(bundle, force, tmp_path):
    """The closing text tells the operator to run `./install restore`, whose
    every decision reads this file, and README.txt tells him to "open
    MANIFEST.json after extracting". It has to be there."""
    path, manifest = bundle
    out = tmp_path / f"manifest-{force}"
    done = reader(str(path), "--out", str(out), force=force)
    assert done.returncode == 0, done.stderr
    carried = out / "MANIFEST.json"
    assert carried.is_file(), f"--out placed {sorted(p.name for p in out.iterdir())}"
    placed = json.loads(carried.read_text())
    assert placed["member_count"] == manifest["member_count"]
    assert placed["reader_sha256"] == manifest["reader_sha256"]
    assert "MANIFEST.json" in done.stdout, "and it is named in what the run says it placed"


def test_the_tree_that_lands_has_the_modes_the_listing_recorded(bundle, tmp_path):
    """The fixture volume carries a 0664 note, a 0666 note and a 0775
    directory because a real markdown memory volume does. CPython's `data`
    filter lands all three wrong, and `v4_memdata` is uid 1000 while
    `v4_tailscale` is root — a restore that silently re-modes them produces a
    hub whose services cannot read their own data.
    """
    path, _ = bundle
    out = tmp_path / "tree"
    done = reader(str(path), "--out", str(out), force="0")
    assert done.returncode == 0, done.stderr
    tree = out / "volumes" / "nova_v4_memdata"
    meta, links = listing_rows(out / "listings" / "v4_memdata.sha256")
    assert meta, "the placed listing carries no metadata lines"
    wrong = []
    for rel, want in sorted(meta.items()):
        full = tree / rel[2:]
        if not os.path.lexists(full):
            wrong.append(f"{rel}: in the listing, not on disk")
            continue
        got = disk_row(full)
        if got != want:
            wrong.append(f"{rel}: on disk `{got}`, the listing recorded `{want}`")
    assert not wrong, "the extracted tree is not the tree the listing describes:\n" + "\n".join(
        wrong
    )
    for rel, target in sorted(links.items()):
        assert os.readlink(tree / rel[2:]) == target, rel


def test_the_verification_reads_the_tree_on_disk_not_only_the_tar_headers(tmp_path):
    """`verify_extracted` compared the listing to the ARCHIVE'S records, so
    every mode the extractor dropped verified clean. This is the half that
    measures what landed."""
    tree = tmp_path / "v"
    (tree / "sub").mkdir(parents=True)
    (tree / "sub" / "a.md").write_text("a\n")
    os.chmod(tree / "sub" / "a.md", 0o664)
    os.chmod(tree / "sub", 0o775)
    listing = nb.tree_listing(str(tree))
    tar_path = tmp_path / "t.tar"
    with tarfile.open(tar_path, "w") as tar:
        tar.add(str(tree), arcname=".", filter=nb._tar_filter)
    with tarfile.open(tar_path) as tar:
        archived = {m.name: nr.tar_member_record(m) for m in tar.getmembers() if m.name != "."}
    assert nr._verify_tree(str(tree), listing, archived) == []
    os.chmod(tree / "sub" / "a.md", 0o600)
    problems = nr._verify_tree(str(tree), listing, archived)
    assert any("./sub/a.md" in p and "0600" in p for p in problems), problems


def _claim_owner_zero(stage):
    """Rewrite the staged listing's uid/gid columns to root's."""
    listing = stage / "inner" / "listings" / "v4_memdata.sha256"
    out = []
    for line in listing.read_text().splitlines():
        parts = line.split(" ", 4)
        if line[:1] in ("d", "f", "l") and line[1:2] == " " and len(parts) == 5:
            line = f"{parts[0]} {parts[1]} 0 0 {parts[4]}"
        out.append(line)
    listing.write_text("".join(entry + "\n" for entry in out))


def test_an_owner_this_reader_cannot_set_is_stated_never_silently_lost(tmp_path):
    """A bundle whose volume is root-owned, opened by an operator who is not
    root — which is the bare-machine case this reader exists for.

    It cannot chown, so it must SAY so. `verify_extracted` comparing the
    owner columns against the tar headers and printing "verified" over a
    tree owned by somebody else is the silent pass this closes.
    """
    from bundle_fixtures import forge_bundle

    if os.geteuid() == 0:
        pytest.skip("this case is about a reader that cannot chown")
    path, _, _ = forge_bundle(
        tmp_path,
        lambda manifest: None,
        name="root-owned.tar",
        mutate_stage=_claim_owner_zero,
        owner=(0, 0),
    )
    out = tmp_path / "unowned"
    done = reader(str(path), "--out", str(out))
    assert done.returncode == 0, done.stderr
    tree = out / "volumes" / "nova_v4_memdata"
    assert os.lstat(tree).st_uid == os.geteuid(), "the fixture did not land where it claims"
    assert "ownership: NOT restored" in done.stdout
    assert "NOT compared" in done.stdout
    assert str(os.geteuid()) in done.stdout, "the sentence names the uid everything landed as"
    assert "install restore" in done.stdout, "and what does set them"


def _setgid_dir(stage):
    """A setgid directory the LISTING agrees with, so the only thing that can
    refuse it is the extractor's own check."""
    volume = stage / "inner" / "volumes" / "v4_memdata"
    os.chmod(volume / "shared", 0o2775)
    (stage / "inner" / "listings" / "v4_memdata.sha256").write_text(nb.tree_listing(str(volume)))


def test_a_member_carrying_setgid_is_refused_rather_than_quietly_stripped(tmp_path):
    """Applying the archive's recorded modes is restoring DATA; applying a
    setgid bit out of a file someone handed you is letting the bundle choose
    a privileged behaviour. `backup.sh` refuses the same three bits when it
    fills a volume, and the two layers must refuse the same thing."""
    from bundle_fixtures import forge_bundle

    path, _, _ = forge_bundle(
        tmp_path,
        lambda manifest: None,
        name="setgid.tar",
        mutate_stage=_setgid_dir,
    )
    out = tmp_path / "setgid-out"
    done = reader(str(path), "--out", str(out))
    assert done.returncode == 1
    assert "setuid" in done.stderr or "setgid" in done.stderr
    assert "shared" in done.stderr
    assert not out.exists() or not list(out.iterdir())


def _sealed_dir(stage):
    """A read-only directory, which a restore now really lands read-only.

    Not in the shared fixture on purpose: a 0555 directory defeats the plain
    `shutil.rmtree` that other cases use on their own stages, and a fixture
    that makes every unrelated test carry a workaround is worse than one
    case that owns it.
    """
    volume = stage / "inner" / "volumes" / "v4_memdata"
    (volume / "sealed").mkdir()
    (volume / "sealed" / "frozen.md").write_text("read-only\n")
    os.chmod(volume / "sealed" / "frozen.md", 0o444)
    os.chmod(volume / "sealed", 0o555)
    (stage / "inner" / "listings" / "v4_memdata.sha256").write_text(nb.tree_listing(str(volume)))


def test_a_read_only_directory_lands_read_only_and_the_cleanup_still_runs(tmp_path):
    """The cost of restoring the recorded modes: the work directory this run
    removes at the end is inside the tree it just re-moded. A cleanup that
    cannot get back in turns a verify that WORKED into a traceback, and
    `--out`'s failure path — the one that removes a half-decrypted .env —
    runs over the same tree.
    """
    from bundle_fixtures import forge_bundle

    path, _, stage = forge_bundle(
        tmp_path, lambda manifest: None, name="sealed.tar", mutate_stage=_sealed_dir
    )
    sealed = stage / "inner" / "volumes" / "v4_memdata" / "sealed"
    try:
        done = reader(str(path), "--verify-only")
        assert done.returncode == 0, done.stdout + done.stderr
        assert "verified" in done.stdout
        assert "Traceback" not in done.stderr
        out = tmp_path / "sealed-out"
        done = reader(str(path), "--out", str(out))
        assert done.returncode == 0, done.stdout + done.stderr
        landed = out / "volumes" / "nova_v4_memdata" / "sealed"
        assert disk_row(landed) == disk_row(sealed)
        assert disk_row(landed / "frozen.md") == disk_row(sealed / "frozen.md")
    finally:
        os.chmod(sealed, 0o755)
        for leftover in tmp_path.glob("sealed-out/volumes/*/sealed"):
            os.chmod(leftover, 0o755)


def _user_namespace_available():
    """A shell that really is root, for a reader that really can chown."""
    try:
        done = subprocess.run(
            ["unshare", "-Ur", "id", "-u"], capture_output=True, text=True, timeout=20
        )
    except (OSError, subprocess.TimeoutExpired):
        return False
    return done.returncode == 0 and done.stdout.strip() == "0"


def test_as_root_it_sets_the_owner_and_says_it_did(tmp_path):
    """The other half of the ownership decision, and the path production
    actually takes: `./install restore` runs this reader INSIDE a container,
    where it is root. Nothing else in this suite executes the chown branch —
    a typo in it would have been found by an operator restoring his hub.

    A user namespace maps exactly one uid, so the bundle has to be the
    root-owned one; that is also the case the branch exists for.
    """
    from bundle_fixtures import forge_bundle

    if not _user_namespace_available():
        pytest.skip("no user namespace here: `unshare -Ur` did not give a root shell")
    path, _, _ = forge_bundle(
        tmp_path,
        lambda manifest: None,
        name="as-root.tar",
        mutate_stage=_claim_owner_zero,
        owner=(0, 0),
    )
    out = tmp_path / "as-root"
    env = dict(os.environ, NOVA_FORCE_CTYPES_GCM="0")
    env.pop("NOVA_BACKUP_PASSPHRASE", None)
    done = subprocess.run(
        ["unshare", "-Ur", sys.executable, str(READER), str(path), "--out", str(out)],
        input=PASSPHRASE + "\n",
        text=True,
        capture_output=True,
        env=env,
    )
    assert done.returncode == 0, done.stdout + done.stderr
    assert "ownership: restored" in done.stdout
    assert "NOT restored" not in done.stdout
    tree = out / "volumes" / "nova_v4_memdata"
    # Inside the namespace the reader saw uid 0 and set it; outside, that is
    # the user who ran the test. What is measured here is that the branch
    # ran and compared all four columns without refusing.
    assert (tree / "people" / "example" / "a-note.md").is_file()
    assert os.readlink(tree / "people" / "current") == "example"
