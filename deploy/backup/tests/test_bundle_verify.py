"""What `verify` must catch, and what `safe_extract` must refuse.

The adversarial tars below are BUILT here, member by member, rather than
argued about: a path that escapes, a `..`, a symlink out of the tree, a hard
link out of the tree, a device node and a fifo. "It uses the data filter" is
a belief; a tar that tries it is a measurement.
"""

import io
import os
import tarfile

import pytest
from bundle_fixtures import BACKUP_DIR, PASSPHRASE, make_bundle, make_stage, plan, run

import novabundle as nb

# ── safe_extract, against a tar built to escape ─────────────────────────────


def tar_with(tmp_path, build):
    path = tmp_path / "evil.tar"
    with tarfile.open(path, "w") as tar:
        build(tar)
    return tarfile.open(path, "r:")


def _regular(name, data=b"x"):
    info = tarfile.TarInfo(name)
    info.size = len(data)
    return info, io.BytesIO(data)


def test_safe_extract_refuses_an_absolute_member(tmp_path):
    def build(tar):
        tar.addfile(*_regular("/etc/cron.d/nova"))

    with tar_with(tmp_path, build) as tar, pytest.raises(nb.BundleError) as caught:
        nb.safe_extract(tar, str(tmp_path / "out"))
    assert "absolute path" in str(caught.value)


def test_safe_extract_refuses_a_dotdot_member(tmp_path):
    def build(tar):
        tar.addfile(*_regular("../../.ssh/authorized_keys"))

    with tar_with(tmp_path, build) as tar, pytest.raises(nb.BundleError) as caught:
        nb.safe_extract(tar, str(tmp_path / "out"))
    assert "`..`" in str(caught.value)


def test_safe_extract_refuses_a_symlink_out_of_the_tree(tmp_path):
    def build(tar):
        info = tarfile.TarInfo("escape")
        info.type = tarfile.SYMTYPE
        info.linkname = "../../../../etc"
        tar.addfile(info)

    with tar_with(tmp_path, build) as tar, pytest.raises(nb.BundleError) as caught:
        nb.safe_extract(tar, str(tmp_path / "out"))
    assert "outside the archive" in str(caught.value)


def test_safe_extract_refuses_an_absolute_symlink(tmp_path):
    def build(tar):
        info = tarfile.TarInfo("escape")
        info.type = tarfile.SYMTYPE
        info.linkname = "/etc/shadow"
        tar.addfile(info)

    with tar_with(tmp_path, build) as tar, pytest.raises(nb.BundleError) as caught:
        nb.safe_extract(tar, str(tmp_path / "out"))
    assert "absolute target" in str(caught.value)


def test_safe_extract_refuses_a_symlink_then_a_write_through_it(tmp_path):
    """The two-member attack: member 1 is a symlink out, member 2 writes
    through it. The refusal has to land on member 1, before anything is
    written at all — which is why every member is checked BEFORE extraction
    begins rather than as it goes."""

    def build(tar):
        info = tarfile.TarInfo("evil")
        info.type = tarfile.SYMTYPE
        info.linkname = "../../tmp"
        tar.addfile(info)
        tar.addfile(*_regular("evil/pwned"))

    dest = tmp_path / "out"
    with tar_with(tmp_path, build) as tar, pytest.raises(nb.BundleError):
        nb.safe_extract(tar, str(dest))
    assert not dest.exists() or not list(dest.iterdir())


def test_safe_extract_refuses_a_hard_link_out_of_the_tree(tmp_path):
    def build(tar):
        info = tarfile.TarInfo("link")
        info.type = tarfile.LNKTYPE
        info.linkname = "../outside"
        tar.addfile(info)

    with tar_with(tmp_path, build) as tar, pytest.raises(nb.BundleError) as caught:
        nb.safe_extract(tar, str(tmp_path / "out"))
    assert "hard link" in str(caught.value)


@pytest.mark.parametrize(
    "kind,word",
    [
        (tarfile.CHRTYPE, "character device"),
        (tarfile.BLKTYPE, "block device"),
        (tarfile.FIFOTYPE, "fifo"),
    ],
)
def test_safe_extract_refuses_a_device_node(tmp_path, kind, word):
    def build(tar):
        info = tarfile.TarInfo("dev/null")
        info.type = kind
        info.devmajor, info.devminor = 1, 3
        tar.addfile(info)

    with tar_with(tmp_path, build) as tar, pytest.raises(nb.BundleError) as caught:
        nb.safe_extract(tar, str(tmp_path / "out"))
    assert word in str(caught.value)


def test_safe_extract_keeps_a_symlink_that_stays_inside(tmp_path):
    """A volume tree legitimately holds one (§5.5). The refusal is about
    ESCAPE, not about the entry type — a blanket refusal would make a real
    memory volume unbackupable."""

    def build(tar):
        tar.addfile(*_regular("people/example"))
        info = tarfile.TarInfo("people/current")
        info.type = tarfile.SYMTYPE
        info.linkname = "example"
        tar.addfile(info)

    dest = tmp_path / "out"
    with tar_with(tmp_path, build) as tar:
        nb.safe_extract(tar, str(dest))
    assert os.path.islink(dest / "people" / "current")


# ── what verify must catch ──────────────────────────────────────────────────


def corrupt_at(path, offset, count=1):
    data = bytearray(path.read_bytes())
    for i in range(count):
        data[offset + i] ^= 0xFF
    path.write_bytes(bytes(data))


def test_a_member_corrupted_after_the_manifest_was_written_fails(tmp_path):
    """The whole point of re-deriving rather than re-reading: the numbers the
    manifest recorded moments ago prove the writer can hash, and nothing
    else."""
    stage = make_stage(tmp_path)
    plan(stage)
    dump = stage / "inner" / "db" / "nova_core.dump"
    dump.write_text("PGDMP" + "y" * 512)
    out = tmp_path / "b.tar.part"
    assert run(["pack", "--stage", str(stage), "--out", str(out)]) == 0
    assert run(["verify", "--bundle", str(out)]) == 1


def test_a_member_removed_after_the_manifest_was_written_fails(tmp_path):
    stage = make_stage(tmp_path)
    plan(stage)
    (stage / "inner" / "db" / "nova_core.counts.tsv").unlink()
    out = tmp_path / "b.tar.part"
    assert run(["pack", "--stage", str(stage), "--out", str(out)]) == 1


def test_a_file_in_the_archive_no_member_names_fails(tmp_path):
    """The other direction, and the one a member-by-member loop misses: an
    extra file rides along and every recorded hash still matches."""
    stage = make_stage(tmp_path)
    plan(stage)
    (stage / "inner" / "files" / "deploy" / "extra.key").write_text("smuggled\n")
    out = tmp_path / "b.tar.part"
    assert run(["pack", "--stage", str(stage), "--out", str(out)]) == 0
    assert run(["verify", "--bundle", str(out)]) == 0, "a member not IN the tar is not the case"
    # now really put it in the tar, without a manifest row
    stage2 = make_stage(tmp_path / "second")
    plan(stage2)
    extra = stage2 / "inner" / "volumes" / "v4_memdata" / "smuggled.txt"
    extra.write_text("x")
    out2 = tmp_path / "c.tar.part"
    assert run(["pack", "--stage", str(stage2), "--out", str(out2)]) == 0
    assert run(["verify", "--bundle", str(out2)]) == 1


def test_a_corrupted_payload_fails_via_gcm(tmp_path):
    bundle, manifest, stage = make_bundle(tmp_path)
    with tarfile.open(bundle, "r:") as tar:
        offset = tar.getmember("payload.enc").offset_data
    corrupt_at(bundle, offset + 400)
    assert run(["verify", "--bundle", str(bundle)]) == 1


def test_a_truncated_bundle_raises_crypto_error_and_not_eof_error(tmp_path):
    bundle, _, _ = make_bundle(tmp_path)
    data = bundle.read_bytes()
    bundle.write_bytes(data[: len(data) // 2])
    with pytest.raises((nb.CryptoError, nb.BundleError)) as caught:
        work = tmp_path / "w"
        work.mkdir()
        nb.verify_bundle(str(bundle), PASSPHRASE, str(work))
    assert not isinstance(caught.value, EOFError)


def test_a_bundle_whose_outer_order_was_rewritten_fails(tmp_path):
    bundle, _, _ = make_bundle(tmp_path)
    rebuilt = tmp_path / "rebuilt.tar"
    with tarfile.open(bundle, "r:") as src, tarfile.open(rebuilt, "w") as dst:
        members = sorted(src.getmembers(), key=lambda m: m.name)
        for member in members:
            dst.addfile(member, src.extractfile(member))
    with pytest.raises(nb.BundleError):
        work = tmp_path / "w2"
        work.mkdir()
        nb.verify_bundle(str(rebuilt), PASSPHRASE, str(work))


def test_a_swapped_reader_is_caught_against_the_git_copy(tmp_path):
    bundle, manifest, stage = make_bundle(tmp_path)
    rebuilt = tmp_path / "swapped.tar"
    with tarfile.open(bundle, "r:") as src, tarfile.open(rebuilt, "w") as dst:
        for member in src.getmembers():
            if member.name == "nova_restore.py":
                payload = b"#!/usr/bin/env python3\nimport os\nos.system('curl evil')\n"
                member.size = len(payload)
                dst.addfile(member, io.BytesIO(payload))
            else:
                dst.addfile(member, src.extractfile(member))
    work = tmp_path / "w3"
    work.mkdir()
    result = nb.verify_bundle(str(rebuilt), PASSPHRASE, str(work), reader_dir=str(BACKUP_DIR))
    assert any("reader_sha256" in p or "byte-identical" in p for p in result["problems"])


def test_meta_disagreeing_with_the_manifest_is_a_refusal(tmp_path):
    bundle, manifest, _ = make_bundle(tmp_path)
    import json

    rebuilt = tmp_path / "lying.tar"
    with tarfile.open(bundle, "r:") as src, tarfile.open(rebuilt, "w") as dst:
        for member in src.getmembers():
            if member.name == "meta.json":
                meta = json.loads(src.extractfile(member).read().decode())
                meta["member_count"] = 999
                meta["source_host"] = "somewhere-else"
                payload = (json.dumps(meta, indent=2) + "\n").encode()
                member.size = len(payload)
                dst.addfile(member, io.BytesIO(payload))
            else:
                dst.addfile(member, src.extractfile(member))
    work = tmp_path / "w4"
    work.mkdir()
    result = nb.verify_bundle(str(rebuilt), PASSPHRASE, str(work))
    assert result["problems"]


def test_verify_refuses_a_wrong_passphrase(tmp_path):
    bundle, _, _ = make_bundle(tmp_path)
    assert run(["verify", "--bundle", str(bundle)], "wrong-wrong-wrong-wrong") == 1


def test_a_healthy_bundle_verifies(tmp_path):
    bundle, _, _ = make_bundle(tmp_path)
    assert run(["verify", "--bundle", str(bundle)]) == 0


def test_verify_names_a_member_the_manifest_does_not(tmp_path):
    """An inner archive built by hand, carrying a file no `members[]` row
    names. `pack` cannot produce one — it adds only what the manifest names —
    so a member-by-member loop alone would never see it, and a bundle handed
    to this machine by someone else could.
    """
    import gzip
    import io
    import tarfile as tf

    stage = make_stage(tmp_path)
    manifest = plan(stage)
    root = tmp_path / "rogue"
    root.mkdir()
    inner = tmp_path / "inner.tgz"
    with open(inner, "wb") as raw, gzip.GzipFile(fileobj=raw, mode="wb", mtime=0) as gz:
        with tf.open(fileobj=gz, mode="w") as tar:
            tar.add(str(stage / "MANIFEST.json"), arcname="MANIFEST.json")
            for row in manifest["members"]:
                path = row["path"]
                tar.add(str(stage / "inner" / path.rstrip("/")), arcname=path.rstrip("/"))
            rogue = b"PGDMP-not-in-the-manifest"
            info = tf.TarInfo("db/rogue.dump")
            info.size = len(rogue)
            tar.addfile(info, io.BytesIO(rogue))
    opened, archived = nb.open_inner(str(inner), str(root))
    problems = nb.verify_inner(str(root), opened, archived)
    assert any("db/rogue.dump" in p and "named by no member" in p for p in problems), problems


def test_pack_never_overwrites_an_existing_bundle(tmp_path):
    """Two snapshots in the same second let os.replace clobber the very
    bundle being restored (backend/app/backup_snapshot.py:201-213). O_EXCL
    is what makes that impossible rather than unlikely."""
    stage = make_stage(tmp_path)
    plan(stage)
    out = tmp_path / "taken.tar.part"
    out.write_text("someone else's\n")
    assert run(["pack", "--stage", str(stage), "--out", str(out)]) == 1
    assert out.read_text() == "someone else's\n"


# ── what a volume listing exists to catch ───────────────────────────────────
#
# §5.5: the type/mode/uid/gid lines are there because "a `find . -type f`
# listing alone cannot detect a missing symlink, a lost empty directory or a
# changed mode, all of which are inside the tar". Each of the four is mutated
# in the STAGE after `plan` wrote the listing, so the tar and the listing
# genuinely disagree — the shape a corrupted stage produces.


def _bundle_with(tmp_path, mutate, name="mutated.tar.part"):
    stage = make_stage(tmp_path)
    plan(stage)
    mutate(stage / "inner" / "volumes" / "v4_memdata")
    out = tmp_path / name
    assert run(["pack", "--stage", str(stage), "--out", str(out)]) == 0
    return out


def _problems(bundle, tmp_path):
    work = tmp_path / "w"
    work.mkdir(exist_ok=True)
    return nb.verify_bundle(str(bundle), PASSPHRASE, str(work))["problems"]


def test_a_changed_mode_in_a_volume_is_caught(tmp_path):
    bundle = _bundle_with(
        tmp_path, lambda v: os.chmod(v / "people" / "example" / "a-note.md", 0o600)
    )
    assert any("type/mode/uid/gid" in p for p in _problems(bundle, tmp_path))


def test_a_missing_symlink_in_a_volume_is_caught(tmp_path):
    bundle = _bundle_with(tmp_path, lambda v: (v / "people" / "current").unlink())
    assert any(
        "people/current" in p and "absent from the archive" in p
        for p in _problems(bundle, tmp_path)
    )


def test_a_lost_empty_directory_in_a_volume_is_caught(tmp_path):
    bundle = _bundle_with(tmp_path, lambda v: (v / "empty-dir").rmdir())
    assert any("empty-dir" in p for p in _problems(bundle, tmp_path))


def test_an_unlisted_extra_file_in_a_volume_is_caught(tmp_path):
    bundle = _bundle_with(tmp_path, lambda v: (v / "smuggled.md").write_text("x\n"))
    assert any(
        "smuggled.md" in p and "absent from the listing" in p for p in _problems(bundle, tmp_path)
    )


def test_a_volume_whose_owner_is_not_the_extracting_user_still_verifies(tmp_path):
    """The `--move` case, and the one that cannot be produced without root:
    `v4_memdata` is uid 1000 and `v4_tailscale` is root, so no single
    extracting uid can satisfy a comparison against the FILESYSTEM. Comparing
    the TAR's own records is what makes both verifiable at once.

    Built by hand because this suite does not run as root: the tar members
    carry uid/gid 0 and the listing says so.
    """
    import gzip
    import tarfile as tf

    stage = make_stage(tmp_path)
    manifest = plan(stage)
    volume = stage / "inner" / "volumes" / "v4_memdata"
    listing_lines = []
    for line in nb.tree_listing(str(volume)).splitlines():
        if line[:1] in ("d", "f", "l") and line[1:2] == " ":
            parts = line.split(" ", 4)
            listing_lines.append(f"{parts[0]} {parts[1]} 0 0 {parts[4]}")
        else:
            listing_lines.append(line)
    listing = "".join(line + "\n" for line in listing_lines)
    (stage / "inner" / "listings" / "v4_memdata.sha256").write_text(listing)
    manifest = plan(stage)  # re-plan so the listing hash matches

    inner = tmp_path / "inner.tgz"
    with open(inner, "wb") as raw, gzip.GzipFile(fileobj=raw, mode="wb", mtime=0) as gz:
        with tf.open(fileobj=gz, mode="w") as tar:

            def as_root(info):
                info.uid = info.gid = 0
                info.uname = info.gname = ""
                return info

            tar.add(str(stage / "MANIFEST.json"), arcname="MANIFEST.json", filter=as_root)
            for row in manifest["members"]:
                path = row["path"]
                tar.add(
                    str(stage / "inner" / path.rstrip("/")),
                    arcname=path.rstrip("/"),
                    filter=as_root,
                )
    root = tmp_path / "root-owned"
    root.mkdir()
    opened, archived = nb.open_inner(str(inner), str(root))
    assert nb.verify_inner(str(root), opened, archived) == []


# ── the chained-symlink escape, and the interpreter that does not help ──────


def _chain(tar):
    info = tarfile.TarInfo("dir")
    info.type = tarfile.DIRTYPE
    info.mode = 0o755
    tar.addfile(info)
    link = tarfile.TarInfo("dir/x")
    link.type = tarfile.SYMTYPE
    link.linkname = ".."
    tar.addfile(link)
    up = tarfile.TarInfo("dir/x/up")
    up.type = tarfile.SYMTYPE
    up.linkname = ".."
    tar.addfile(up)
    tar.addfile(*_regular("dir/x/up/PWNED", b"escaped"))


def test_every_member_of_a_symlink_chain_passes_the_per_member_check(tmp_path):
    """The measurement the refusal is built on: judged alone, all four are
    contained — `..` from `dir/x` normalises to `.`, `..` from `dir/x/up`
    normalises to `dir`, and the last member holds no `..` at all."""
    with tar_with(tmp_path, _chain) as tar:
        assert [nb.check_member(m) for m in tar.getmembers()] == ["", "", "", ""]


def test_safe_extract_refuses_a_chained_symlink_escape(tmp_path):
    with tar_with(tmp_path, _chain) as tar, pytest.raises(nb.BundleError) as caught:
        nb.safe_extract(tar, str(tmp_path / "out"))
    assert "goes through" in str(caught.value)


def test_the_chain_is_refused_by_us_and_not_by_the_extraction_filter(tmp_path):
    """restore.sh accepts python3 >= 3.9, and the `except TypeError` branch
    extracts UNFILTERED — so on Debian 11's 3.9 the escape would land. The
    refusal is measured where the interpreter cannot help: `members_refusal`
    runs before any extraction call at all."""
    with tar_with(tmp_path, _chain) as tar:
        assert "goes through" in nb.members_refusal(tar.getmembers())
    marker = tmp_path / "PWNED"
    assert not marker.exists()


def test_the_reader_refuses_the_same_chain(tmp_path):
    import importlib.util

    spec = importlib.util.spec_from_file_location(
        "nova_restore_probe", BACKUP_DIR / "nova_restore.py"
    )
    reader = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(reader)
    with tar_with(tmp_path, _chain) as tar:
        assert "goes through" in reader.members_refusal(tar.getmembers())
        with pytest.raises(reader.RestoreError):
            reader.safe_extract(tar, str(tmp_path / "out2"))


# ── the KAT is what makes a wrong passphrase cost nothing ───────────────────


def test_verify_runs_the_kat_before_it_writes_a_payload_byte(tmp_path, monkeypatch):
    """On a many-GB bundle read off a removable drive, a wrong passphrase
    must cost one scrypt, not a full copy. Measured by spying on the gate:
    at the moment it runs, nothing is in the work directory."""
    bundle, _, _ = make_bundle(tmp_path)
    work = tmp_path / "work"
    work.mkdir()
    seen = []
    real = nb.kat_gate

    def spy(*args, **kwargs):
        seen.append(sorted(os.listdir(work)))
        return real(*args, **kwargs)

    monkeypatch.setattr(nb, "kat_gate", spy)
    nb.verify_bundle(str(bundle), PASSPHRASE, str(work))
    assert seen == [[]], f"the work directory already held {seen}"


def test_a_wrong_passphrase_leaves_no_payload_behind(tmp_path):
    bundle, _, _ = make_bundle(tmp_path)
    work = tmp_path / "work2"
    work.mkdir()
    with pytest.raises(nb.CryptoError):
        nb.verify_bundle(str(bundle), "wrong-wrong-wrong-wrong", str(work))
    assert list(work.iterdir()) == []
