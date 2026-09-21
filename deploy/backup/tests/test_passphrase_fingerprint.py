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
import tarfile

from bundle_fixtures import OTHER_PASSPHRASE, PASSPHRASE, make_bundle, run

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
