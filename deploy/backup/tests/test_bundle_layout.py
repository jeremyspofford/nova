"""The bundle's shape (design-verdict.md §5.1, §5.2, §7.6).

Two properties carry real weight here. The outer member ORDER is forced, not
alphabetical, so `tar -xOf <bundle> restore.sh` works on a many-GB file
without streaming past the payload. And the carried reader is BYTE-IDENTICAL
to its git copy — no templating, no stamping — so one published digest covers
every bundle for a given commit, which is the only thing standing between the
operator and "run this script, trust me".
"""

import ast
import gzip
import hashlib
import io
import json
import tarfile

import pytest
from bundle_fixtures import BACKUP_DIR, PASSPHRASE, make_bundle

import novabundle as nb


@pytest.fixture(scope="module")
def bundle(tmp_path_factory):
    path, manifest, stage = make_bundle(tmp_path_factory.mktemp("bundle"))
    return path, manifest, stage


# ── the outer tar ───────────────────────────────────────────────────────────


def test_the_outer_members_are_in_the_forced_order(bundle):
    path, _, _ = bundle
    with tarfile.open(path, "r:") as tar:
        assert tar.getnames() == [
            "README.txt",
            "nova_restore.py",
            "restore.sh",
            "kat.sha256",
            "kat.enc",
            "meta.json",
            "payload.enc",
        ]


def test_the_first_five_members_read_without_a_passphrase(bundle):
    path, _, _ = bundle
    with tarfile.open(path, "r:") as tar:
        for name in ("README.txt", "nova_restore.py", "restore.sh", "kat.sha256", "kat.enc"):
            assert tar.extractfile(name).read()


def test_the_cleartext_members_sit_before_the_payload(bundle):
    """The reason the outer tar is UNCOMPRESSED: member 7 is incompressible
    AEAD ciphertext and members 1-6 are under 60 KB together, so the
    bootstrap line reads none of the big one."""
    path, _, _ = bundle
    with tarfile.open(path, "r:") as tar:
        offsets = {m.name: m.offset for m in tar.getmembers()}
    for name in (
        "README.txt",
        "nova_restore.py",
        "restore.sh",
        "kat.sha256",
        "kat.enc",
        "meta.json",
    ):
        assert offsets[name] < offsets["payload.enc"]
    # §5.1 estimated "under 60 KB" before the reader was written. Measured
    # at this commit: 62464 bytes of cleartext prefix, because the reader
    # grew a tag-checking self test, a chained-symlink refusal and its own
    # path validation. The property is that `tar -xOf <bundle> restore.sh`
    # reads a fixed small prefix of a many-GB file, not the exact figure, so
    # the bound is stated with headroom and will notice a reader that
    # doubles.
    assert offsets["payload.enc"] < 128 * 1024, offsets["payload.enc"]


def test_the_bundle_is_mode_0600(bundle):
    path, _, _ = bundle
    assert oct(path.stat().st_mode & 0o777) == "0o600"


def test_the_outer_tar_is_not_compressed(bundle):
    path, _, _ = bundle
    assert path.read_bytes()[:2] != b"\x1f\x8b"


# ── the inner archive ───────────────────────────────────────────────────────


def test_the_manifest_is_the_inner_archives_first_member(bundle):
    """First because gzip cannot seek: listing a bundle otherwise means
    decompressing everything ahead of the member you want, and v3 measured
    3.4 s of pointless decompression on a 167 MB bundle."""
    path, _, _ = bundle
    with tarfile.open(path, "r:") as tar:
        payload = tar.extractfile("payload.enc").read()
    inner = nb.decrypt_bytes(payload, PASSPHRASE)
    with gzip.GzipFile(fileobj=io.BytesIO(inner)) as gz:
        with tarfile.open(fileobj=gz, mode="r|") as tar:
            assert tar.next().name == "MANIFEST.json"


def test_the_inner_members_follow_the_manifests_order(bundle):
    path, manifest, _ = bundle
    with tarfile.open(path, "r:") as tar:
        payload = tar.extractfile("payload.enc").read()
    inner = nb.decrypt_bytes(payload, PASSPHRASE)
    with gzip.GzipFile(fileobj=io.BytesIO(inner)) as gz:
        with tarfile.open(fileobj=gz, mode="r:") as tar:
            names = tar.getnames()
    assert names[0] == "MANIFEST.json"
    wanted = [row["path"].rstrip("/") for row in manifest["members"]]
    seen = [n for n in names if n in wanted]
    assert seen == wanted, "a member out of manifest order"


def test_the_inner_archive_carries_numeric_ownership_only(bundle):
    """§5.2: the restore puts back the NUMBERS (nova_restore's
    apply_recorded_metadata), so a uname that does not exist on the target —
    or does, and belongs to someone else — can never decide who owns a
    restored file."""
    path, _, _ = bundle
    with tarfile.open(path, "r:") as tar:
        payload = tar.extractfile("payload.enc").read()
    inner = nb.decrypt_bytes(payload, PASSPHRASE)
    with gzip.GzipFile(fileobj=io.BytesIO(inner)) as gz:
        with tarfile.open(fileobj=gz, mode="r:") as tar:
            for member in tar.getmembers():
                assert member.uname == "", member.name
                assert member.gname == "", member.name


def test_a_symlink_inside_a_volume_survives_the_round_trip(bundle):
    """§5.5's own example listing has one (`l 0777 … ./people/current`) and
    python-tool minor 5 is explicit that symlinks, empty directories and
    modes are INSIDE the tar. A reader that refused every symlink would make
    a real memory volume unbackupable."""
    path, _, _ = bundle
    with tarfile.open(path, "r:") as tar:
        payload = tar.extractfile("payload.enc").read()
    inner = nb.decrypt_bytes(payload, PASSPHRASE)
    with gzip.GzipFile(fileobj=io.BytesIO(inner)) as gz:
        with tarfile.open(fileobj=gz, mode="r:") as tar:
            links = [m.name for m in tar.getmembers() if m.issym()]
            dirs = [m.name for m in tar.getmembers() if m.isdir()]
    assert "volumes/v4_memdata/people/current" in links
    assert "volumes/v4_memdata/empty-dir" in dirs


# ── the reader that travels inside ──────────────────────────────────────────


@pytest.mark.parametrize("name", ["nova_restore.py", "restore.sh"])
def test_the_carried_script_is_byte_identical_to_the_git_copy(bundle, name):
    path, _, _ = bundle
    with tarfile.open(path, "r:") as tar:
        carried = tar.extractfile(name).read()
    assert carried == (BACKUP_DIR / name).read_bytes()


def test_the_manifest_records_the_digest_of_the_reader_it_shipped(bundle):
    path, manifest, _ = bundle
    with tarfile.open(path, "r:") as tar:
        carried = tar.extractfile("nova_restore.py").read()
    assert manifest["reader_sha256"] == hashlib.sha256(carried).hexdigest()


def test_meta_repeats_the_reader_digest_and_is_marked_advisory(bundle):
    """It looks like a verification and is not one: it travels in the same
    file as the thing it describes. README.txt says so in a sentence, and
    the operator's answer is the digest published out of band."""
    path, manifest, _ = bundle
    with tarfile.open(path, "r:") as tar:
        meta = json.loads(tar.extractfile("meta.json").read().decode())
        readme = tar.extractfile("README.txt").read().decode()
    assert meta["reader_sha256"] == manifest["reader_sha256"]
    assert "out of band" in readme
    assert "RUNNING THE CARRIED SCRIPT IS RUNNING CODE FROM THIS BUNDLE" in readme
    assert manifest["reader_sha256"] in readme


def test_the_readme_has_no_unrendered_placeholders(bundle):
    path, _, _ = bundle
    with tarfile.open(path, "r:") as tar:
        readme = tar.extractfile("README.txt").read().decode()
    assert "@" not in readme.replace("@BUNDLE@", "")
    assert "nova-backup-test.tar" in readme


# ── meta.json decides nothing that survives a failed decrypt ────────────────

READER_AST = ast.parse((BACKUP_DIR / "nova_restore.py").read_text())


def _meta_keys_read(tree):
    """Every literal key the reader takes off a dict named `meta`."""
    keys = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Subscript) and isinstance(node.value, ast.Name):
            if "meta" in node.value.id and isinstance(node.slice, ast.Constant):
                keys.add(node.slice.value)
        if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute):
            target = node.func.value
            if (
                node.func.attr == "get"
                and isinstance(target, ast.Name)
                and "meta" in target.id
                and node.args
                and isinstance(node.args[0], ast.Constant)
            ):
                keys.add(node.args[0].value)
            if (
                node.func.attr == "get"
                and isinstance(target, ast.Name)
                and "meta" in target.id
                and node.args
                and isinstance(node.args[0], ast.Name)
            ):
                keys.add(node.args[0].id)
    return keys


def test_the_reader_consults_exactly_one_field_of_cleartext_meta():
    """§2 rejection 5: restore must choose WHICH passphrase to try before it
    can decrypt anything, and meta.json is the only pre-decryption source of
    a fingerprint. That is the one exception. Everything else it duplicates
    is re-read from the authenticated manifest."""
    assert _meta_keys_read(READER_AST) == {"META_FIELD_READ"}
    source = (BACKUP_DIR / "nova_restore.py").read_text()
    assert 'META_FIELD_READ = "passphrase_fingerprint"' in source


def test_the_reader_imports_nothing_from_this_repo():
    imported = set()
    for node in ast.walk(READER_AST):
        if isinstance(node, ast.Import):
            imported.update(alias.name.split(".")[0] for alias in node.names)
        elif isinstance(node, ast.ImportFrom) and node.module:
            imported.add(node.module.split(".")[0])
    assert "novabundle" not in imported
    assert not (imported - set(__import__("sys").stdlib_module_names) - {"cryptography"})
