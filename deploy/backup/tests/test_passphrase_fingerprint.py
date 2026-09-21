"""The cleartext fingerprint, and the oracle it is not (verdict §7.4).

v3 wrote sha256(passphrase)[:12] into cleartext meta. Two critiques found the
same defect independently: an attacker holding the bundle reads it without a
passphrase and tests candidates at ONE UNSALTED SHA-256 each, then pays
scrypt once for the confirmed hit. Against an operator-chosen passphrase —
which `prompt`, `env` and `cmd` all make first-class — that annuls the entire
work factor.

So the cleartext form is derived from the KEY, under that file's own salt,
and the raw form is kept only inside the ciphertext it identifies.
"""

import hashlib
import json
import os
import subprocess
import tarfile

from bundle_fixtures import BACKUP_DIR, OTHER_PASSPHRASE, PASSPHRASE, make_bundle, run

import novabundle as nb


def kat_salt(bundle):
    import io

    with tarfile.open(bundle, "r:") as tar:
        blob = tar.extractfile("kat.enc").read()
    header = nb.parse_header(io.BytesIO(blob))
    return bytes.fromhex(header["salt"])


def meta_of(bundle):
    with tarfile.open(bundle, "r:") as tar:
        return json.loads(tar.extractfile("meta.json").read().decode())


def test_the_cleartext_fingerprint_is_the_scrypt_key_form(tmp_path):
    bundle, _, _ = make_bundle(tmp_path)
    meta = meta_of(bundle)
    assert meta["fingerprint_kind"] == "scrypt-key"
    assert meta["passphrase_fingerprint"] == nb.key_fingerprint(PASSPHRASE, kat_salt(bundle))


def test_the_cleartext_fingerprint_is_not_the_raw_passphrase_digest(tmp_path):
    bundle, _, _ = make_bundle(tmp_path)
    meta = meta_of(bundle)
    raw = hashlib.sha256(PASSPHRASE.encode()).hexdigest()[:12]
    assert meta["passphrase_fingerprint"] != raw
    assert raw not in json.dumps(meta)


def test_the_raw_digest_appears_only_inside_the_encrypted_manifest(tmp_path):
    """Kept only where it is already behind the thing it identifies."""
    bundle, manifest, _ = make_bundle(tmp_path)
    raw = hashlib.sha256(PASSPHRASE.encode()).hexdigest()[:12]
    assert manifest["encryption"]["passphrase_sha256_12"] == raw
    cleartext = b""
    with tarfile.open(bundle, "r:") as tar:
        for name in ("README.txt", "kat.sha256", "meta.json"):
            cleartext += tar.extractfile(name).read()
    assert raw.encode() not in cleartext


def test_two_bundles_under_one_passphrase_compare_equal_under_their_own_salts(tmp_path):
    """The drill's cross-bundle check: derive under EACH file's salt and
    compare. It costs one scrypt per bundle instead of one total, which is
    what a fixed application salt would have bought — and a fixed salt lets
    one precomputed table serve every Nova bundle everywhere."""
    first, _, _ = make_bundle(tmp_path / "a")
    second, _, _ = make_bundle(tmp_path / "b")
    assert kat_salt(first) != kat_salt(second), "a fresh salt per file"
    assert meta_of(first)["passphrase_fingerprint"] != meta_of(second)["passphrase_fingerprint"]
    assert (
        nb.key_fingerprint(PASSPHRASE, kat_salt(first)) == meta_of(first)["passphrase_fingerprint"]
    )
    assert (
        nb.key_fingerprint(PASSPHRASE, kat_salt(second))
        == meta_of(second)["passphrase_fingerprint"]
    )


def test_a_different_passphrase_derives_a_different_fingerprint(tmp_path):
    bundle, _, _ = make_bundle(tmp_path)
    salt = kat_salt(bundle)
    assert nb.key_fingerprint(PASSPHRASE, salt) != nb.key_fingerprint(OTHER_PASSPHRASE, salt)


def test_the_fingerprint_verb_reads_the_salt_off_a_file(tmp_path, capsys):
    bundle, _, _ = make_bundle(tmp_path)
    with tarfile.open(bundle, "r:") as tar:
        (tmp_path / "kat.enc").write_bytes(tar.extractfile("kat.enc").read())
    capsys.readouterr()
    assert run(["fingerprint", "--file", str(tmp_path / "kat.enc")]) == 0
    assert capsys.readouterr().out.strip() == meta_of(bundle)["passphrase_fingerprint"]


def test_the_fingerprint_verb_takes_the_passphrase_on_stdin_only(tmp_path, capsys):
    salt = "0" * 32
    assert run(["fingerprint", "--salt", salt]) == 0
    printed = capsys.readouterr().out.strip()
    assert printed == nb.key_fingerprint(PASSPHRASE, bytes.fromhex(salt))
    assert len(printed) == 12
    assert PASSPHRASE not in printed


def test_a_salt_that_is_not_sixteen_bytes_refuses(capsys):
    assert run(["fingerprint", "--salt", "00"]) == 1
    assert "16 bytes of hex" in capsys.readouterr().err


def test_the_kat_verb_proves_the_image_and_the_passphrase(capsys):
    assert run(["kat"]) == 0
    printed = json.loads(capsys.readouterr().out)
    assert printed["kat"] == "ok"
    assert printed["fingerprint_kind"] == "scrypt-key"
    assert len(printed["fingerprint"]) == 12
    assert PASSPHRASE not in json.dumps(printed)


# ── deploy/passphrase.sh, driven as the shell (no docker, no live stack) ────
#
# The `file` resolver's multi-line refusal had no test: disabling it left
# backup_test.sh fully green, which makes it a comment rather than a check.
# Driven here rather than in backup_test.sh because that file is being
# edited by another task and staging it would sweep their work into this
# commit.

DEPLOY = BACKUP_DIR.parent
PASSPHRASE_SH = DEPLOY / "passphrase.sh"


def drive(script, world, env=None):
    """Run `script` with deploy/passphrase.sh sourced, against its own
    throwaway deploy directory."""
    body = (
        "set -uo pipefail\n"
        f'. "{PASSPHRASE_SH}"\n'
        f'NP_DIR="{world}"\nNP_ENV_FILE="{world}/.env"\n'
        f"{script}\n"
    )
    return subprocess.run(
        ["bash", "-c", body],
        capture_output=True,
        text=True,
        env=dict(os.environ, **(env or {})),
    )


def world(tmp_path, name="w"):
    path = tmp_path / name
    path.mkdir()
    (path / ".env").write_text("")
    return path


def test_a_multi_line_passphrase_file_is_refused(tmp_path):
    """The passphrase reaches novabundle.py as the FIRST LINE of stdin, so a
    file like this would seal every bundle with something the operator does
    not think he has."""
    place = world(tmp_path)
    store = place / ".backup-passphrase"
    store.write_text(PASSPHRASE + "\nsecond line\n")
    os.chmod(store, 0o600)
    done = drive("resolve_passphrase", place)
    assert done.returncode == 1, done.stdout
    assert "more than one line" in done.stderr
    assert PASSPHRASE not in done.stdout


def test_a_trailing_newline_is_not_more_than_one_line(tmp_path):
    """The other half: `$( )` strips the trailing newline every editor adds,
    and a check written with `$(printf '\\n')` matches EVERYTHING — measured,
    it refused every passphrase file in the suite."""
    place = world(tmp_path, "ok")
    store = place / ".backup-passphrase"
    store.write_text(PASSPHRASE + "\n")
    os.chmod(store, 0o600)
    done = drive("resolve_passphrase", place)
    assert done.returncode == 0, done.stderr
    assert done.stdout == PASSPHRASE


def test_a_file_with_no_trailing_newline_resolves(tmp_path):
    place = world(tmp_path, "bare")
    store = place / ".backup-passphrase"
    store.write_text(PASSPHRASE)
    os.chmod(store, 0o600)
    done = drive("resolve_passphrase", place)
    assert done.returncode == 0, done.stderr
    assert done.stdout == PASSPHRASE


def test_a_stale_create_lock_is_reclaimed_out_loud(tmp_path):
    """A Ctrl-C between the mkdir and the rmdir used to be a permanent dead
    end with no verb that cleared it."""
    place = world(tmp_path, "stale")
    lock = place / ".backup-passphrase.lock"
    lock.mkdir()
    (lock / "pid").write_text("999999\n")  # a pid that is not running
    done = drive(f"create_passphrase printf '%s' '{PASSPHRASE}'", place)
    assert done.returncode == 0, done.stderr
    assert "clearing a stale passphrase lock" in done.stderr
    assert (place / ".backup-passphrase").read_text() == PASSPHRASE
    assert not lock.exists()


def test_a_live_create_lock_is_not_reclaimed(tmp_path):
    """And the other half: a lock whose process IS running refuses."""
    place = world(tmp_path, "live")
    lock = place / ".backup-passphrase.lock"
    lock.mkdir()
    (lock / "pid").write_text(f"{os.getpid()}\n")
    done = drive(f"create_passphrase printf '%s' '{PASSPHRASE}'", place)
    assert done.returncode == 1
    assert "another run is creating the passphrase" in done.stderr
    assert not (place / ".backup-passphrase").exists()


def test_the_create_lock_does_not_touch_the_callers_traps(tmp_path):
    """Measured the hard way: saving and restoring traps around the lock
    re-installed the CALLER's EXIT trap inside a command substitution, where
    it would never have run — and it deleted the caller's temp tree."""
    place = world(tmp_path, "traps")
    canary = tmp_path / "canary"
    canary.mkdir()
    script = (
        f"trap 'rm -rf \"{canary}\"' EXIT\n"
        f"value=\"$(create_passphrase printf '%s' '{PASSPHRASE}' 2>/dev/null)\"\n"
        'printf "%s" "$value"\n'
        f'[ -d "{canary}" ] || exit 9\n'
    )
    done = drive(script, place)
    assert done.returncode == 0, f"exit {done.returncode}: the caller's EXIT trap fired early"
    assert done.stdout == PASSPHRASE
