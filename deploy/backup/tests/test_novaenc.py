"""NOVAENC1: the wire format, and every way it must refuse.

design-verdict.md §7.1 is the authority. The format is BYTE FOR BYTE v3's —
backend/app/backup_crypto.py — so a payload v3 wrote still opens, and that is
pinned here against a fixture v3's own code produced, not against a sentence.

The properties that matter for a BACKUP, in one line each: a truncated file
fails authentication rather than yielding a short archive; a reordered frame
fails; a tampered header naming an absurd scrypt cost raises CryptoError
BEFORE any allocation; and every one of those failures is the same sentence,
because GCM genuinely cannot tell them apart.
"""

import hashlib
import io
import json
import pathlib
import re
import struct
import subprocess
import sys

import pytest
from bundle_fixtures import BACKUP_DIR, FIXTURES, PASSPHRASE

import novabundle as nb

V3_FIXTURE = FIXTURES / "v3-novaenc1.bin"
V3_META = json.loads((FIXTURES / "v3-novaenc1.json").read_text())


def roll(data: bytes, passphrase=PASSPHRASE, chunk=1024):
    return nb.encrypt_bytes(data, passphrase, chunk)


def frames(blob: bytes):
    """[(header bytes, [frame ciphertexts])] — the parts a tamperer edits."""
    fh = io.BytesIO(blob)
    header = nb.parse_header(fh)
    hbytes = header["_bytes"]
    out = []
    while True:
        raw = fh.read(4)
        if not raw:
            break
        length = struct.unpack(">I", raw)[0]
        out.append(fh.read(length))
    return hbytes, out


def rebuild(hbytes: bytes, frame_list) -> bytes:
    body = b"".join(struct.pack(">I", len(f)) + f for f in frame_list)
    return nb.MAGIC + struct.pack(">I", len(hbytes)) + hbytes + body


def retarget(blob: bytes, **changes) -> bytes:
    """The same ciphertext under a header this reader must refuse."""
    hbytes, frame_list = frames(blob)
    header = json.loads(hbytes.decode())
    header.update(changes)
    new = json.dumps(header, separators=(",", ":"), sort_keys=True).encode()
    return rebuild(new, frame_list)


# ── the round trip ──────────────────────────────────────────────────────────


@pytest.mark.parametrize("size", [1, 63, 1023, 1024, 2048, 4096, 5000])
def test_round_trip(size):
    data = bytes(range(256)) * (size // 256 + 1)
    data = data[:size]
    assert nb.decrypt_bytes(roll(data), PASSPHRASE) == data


def test_an_exact_multiple_of_the_chunk_round_trips():
    """Finality is decided at write time by POSITION, never by a short read:
    the last frame of an exact-multiple file is FULL LENGTH. Decided the
    other way, this file decrypts to an archive one frame short — and every
    check downstream passes, because the archive is well-formed."""
    data = b"x" * 4096
    blob = roll(data, chunk=1024)
    _, frame_list = frames(blob)
    assert len(frame_list) == 4, "an exact multiple must not emit a trailing empty frame"
    assert nb.decrypt_bytes(blob, PASSPHRASE) == data


def test_an_empty_file_round_trips():
    assert nb.decrypt_bytes(roll(b""), PASSPHRASE) == b""


def test_a_wrong_passphrase_fails():
    with pytest.raises(nb.CryptoError) as caught:
        nb.decrypt_bytes(roll(b"secret"), "not-the-passphrase")
    assert str(caught.value) == nb.BAD_DECRYPT


# ── the four that matter for a backup ───────────────────────────────────────


@pytest.mark.parametrize("where", [0, 1, 2, -1])
def test_a_flipped_byte_anywhere_fails(where):
    blob = bytearray(roll(b"y" * 3000, chunk=1024))
    offset = len(nb.MAGIC) + 4 + 200 + where if where >= 0 else len(blob) + where
    blob[offset] ^= 0x01
    with pytest.raises(nb.CryptoError):
        nb.decrypt_bytes(bytes(blob), PASSPHRASE)


@pytest.mark.parametrize("cut", [1, 17, 1100])
def test_a_truncated_file_fails_rather_than_yielding_a_short_archive(cut):
    """The one that matters: a backup nobody reads until a disaster is
    exactly the file a full disk cut short two months ago."""
    blob = roll(b"z" * 4096, chunk=1024)
    with pytest.raises(nb.CryptoError):
        nb.decrypt_bytes(blob[:-cut], PASSPHRASE)


def test_dropping_the_last_whole_frame_fails():
    """Not a partial byte: a clean cut on a frame boundary, which is what a
    truncated copy looks like. Only the AAD's final flag catches this."""
    hbytes, frame_list = frames(roll(b"z" * 4096, chunk=1024))
    with pytest.raises(nb.CryptoError):
        nb.decrypt_bytes(rebuild(hbytes, frame_list[:-1]), PASSPHRASE)


def test_two_reordered_frames_fail():
    hbytes, frame_list = frames(roll(b"w" * 4096, chunk=1024))
    frame_list[0], frame_list[1] = frame_list[1], frame_list[0]
    with pytest.raises(nb.CryptoError):
        nb.decrypt_bytes(rebuild(hbytes, frame_list), PASSPHRASE)


def test_a_duplicated_frame_fails():
    hbytes, frame_list = frames(roll(b"w" * 4096, chunk=1024))
    with pytest.raises(nb.CryptoError):
        nb.decrypt_bytes(rebuild(hbytes, frame_list[:1] + frame_list), PASSPHRASE)


# ── the header, which is attacker-writable until the first frame ────────────


@pytest.mark.parametrize(
    "changes",
    [
        {"n": 32760},  # one bit off a real header: NOT a power of two
        {"n": 1 << 19},  # over MAX_N
        {"n": 1 << 18},  # inside a naive cap, over the memory cap
        {"r": 17},  # over MAX_R
        {"p": 5},  # over MAX_P
        {"n": 0},
        {"r": 0},
        {"chunk": 0},
        {"chunk": 65 * 1024 * 1024},
        {"cipher": "AES-256-GCM"},  # the uppercase spelling v3 rejects
        {"kdf": "pbkdf2"},
        {"v": 2},
        {"salt": "00" * 15},
        {"nonce_prefix": "00" * 3},
        {"salt": "zz" * 16},
        {"n": True},  # a bool is not an int here, however much python says so
    ],
)
def test_a_tampered_header_is_a_crypto_error_and_never_a_bare_value_error(changes):
    blob = retarget(roll(b"a" * 100), **changes)
    with pytest.raises(nb.CryptoError) as caught:
        nb.decrypt_bytes(blob, PASSPHRASE)
    assert type(caught.value) is nb.CryptoError
    assert not isinstance(caught.value, (ValueError, MemoryError))


@pytest.mark.parametrize(
    "changes",
    [
        {"n": 1 << 19, "r": 16},  # loudly over every bound
        {"n": 1 << 18, "r": 8},  # INSIDE MAX_N, over the 128 MiB memory cap
        {"n": 32760},  # one bit off a real header: not a power of two
        {"r": 16, "n": 1 << 17},  # 128*r*n == 256 MiB
    ],
)
def test_an_absurd_scrypt_cost_refuses_before_any_allocation(monkeypatch, changes):
    """A decryptor must allocate 128*r*n bytes BEFORE the first
    authentication check can run. Without the reader-side cap, a tampered
    header makes an honest reader allocate gigabytes — or name a cost hashlib
    refuses under our own maxmem, turning "tampered" into a bare ValueError.

    The middle two cases are the ones a naive `n <= MAX_N` misses, which is
    why they are here: measured, removing `(n & (n-1)) == 0` and
    `128*r*n <= KDF_MEM_CAP` left every other case in this file green.
    """
    blob = retarget(roll(b"a" * 100), **changes)
    calls = []
    monkeypatch.setattr(nb.hashlib, "scrypt", lambda *a, **k: calls.append(k) or b"\0" * 32)
    with pytest.raises(nb.CryptoError) as caught:
        nb.decrypt_bytes(blob, PASSPHRASE)
    assert "will pay for" in str(caught.value)
    assert calls == [], "the KDF was paid for before the cost cap was checked"


def test_an_oversized_header_is_refused():
    hbytes, frame_list = frames(roll(b"a" * 100))
    blob = nb.MAGIC + struct.pack(">I", 4097) + b"{" * 4097
    with pytest.raises(nb.CryptoError):
        nb.decrypt_bytes(blob, PASSPHRASE)


def test_a_header_that_is_not_json_is_refused():
    with pytest.raises(nb.CryptoError):
        nb.decrypt_bytes(nb.MAGIC + struct.pack(">I", 4) + b"nope", PASSPHRASE)


def test_a_file_that_is_not_novaenc1_is_refused():
    with pytest.raises(nb.CryptoError):
        nb.decrypt_bytes(b"PK\x03\x04 not a bundle", PASSPHRASE)


def test_no_ciphertext_at_all_is_refused():
    hbytes, _ = frames(roll(b"a" * 10))
    with pytest.raises(nb.CryptoError):
        nb.decrypt_bytes(rebuild(hbytes, []), PASSPHRASE)


# ── the wire format itself ──────────────────────────────────────────────────


def test_the_header_names_the_lowercase_cipher():
    """python-tool minor 1: backend/app/backup_crypto.py:119,154 rejects any
    other spelling as `unsupported format`, so "AES-256-GCM" here would break
    the stated ability to open a v3-written payload. A byte comparison,
    against the bytes, not a parse."""
    hbytes, _ = frames(roll(b"a"))
    assert b'"cipher":"aes-256-gcm"' in hbytes
    assert b"AES-256-GCM" not in hbytes


def test_the_header_is_sorted_compact_json():
    hbytes, _ = frames(roll(b"a"))
    header = json.loads(hbytes.decode())
    assert hbytes == json.dumps(header, separators=(",", ":"), sort_keys=True).encode()


def test_the_salt_is_sixteen_bytes_and_fresh_per_file():
    first, _ = frames(roll(b"a"))
    second, _ = frames(roll(b"a"))
    one, two = json.loads(first.decode()), json.loads(second.decode())
    assert len(bytes.fromhex(one["salt"])) == 16
    assert len(bytes.fromhex(one["nonce_prefix"])) == 4
    assert one["salt"] != two["salt"], "a fresh salt per file means a fresh key per file"


def test_the_kat_blob_and_a_payload_do_not_share_a_key():
    one, _ = frames(nb.encrypt_bytes(nb.KAT_PLAINTEXT, PASSPHRASE))
    two, _ = frames(roll(b"payload"))
    assert json.loads(one.decode())["salt"] != json.loads(two.decode())["salt"]


def test_the_writer_cost_is_the_verdicts_cost():
    assert (nb.SCRYPT_N, nb.SCRYPT_R, nb.SCRYPT_P, nb.DKLEN) == (32768, 8, 1, 32)
    assert nb.CHUNK == 4 * 1024 * 1024


# ── a v3-written payload still opens ────────────────────────────────────────


def test_a_v3_written_fixture_decrypts():
    """Written by backend/app/backup_crypto.py's own encrypt_file, with a
    synthetic passphrase. If the wire format ever drifts, this is the test
    that says so — before an operator finds out holding a v3 bundle."""
    plain = nb.decrypt_bytes(V3_FIXTURE.read_bytes(), V3_META["passphrase"])
    assert hashlib.sha256(plain).hexdigest() == V3_META["plaintext_sha256"]
    assert len(plain) == V3_META["plaintext_bytes"]


def test_the_v3_fixtures_header_is_the_one_this_reader_writes():
    hbytes, _ = frames(V3_FIXTURE.read_bytes())
    header = json.loads(hbytes.decode())
    assert header["cipher"] == "aes-256-gcm"
    assert header["kdf"] == "scrypt"
    assert (header["v"], header["n"], header["r"], header["p"]) == (1, 32768, 8, 1)


def test_this_writer_and_v3s_writer_agree_on_the_header_shape():
    ours, _ = frames(roll(b"a", chunk=V3_META["chunk"]))
    theirs, _ = frames(V3_FIXTURE.read_bytes())
    mine, v3 = json.loads(ours.decode()), json.loads(theirs.decode())
    assert sorted(mine) == sorted(v3)
    for field in ("v", "cipher", "kdf", "n", "r", "p", "chunk"):
        assert mine[field] == v3[field], field


# ── the one sentence ────────────────────────────────────────────────────────

READER_SOURCE = (BACKUP_DIR / "nova_restore.py").read_text()


def test_the_failure_sentence_is_identical_in_both_implementations():
    """Character for character. A wrong passphrase, a truncated file and a
    tampered header are indistinguishable to the caller on purpose — GCM
    cannot tell them apart, and pretending otherwise is what produces "the
    passphrase must be right, so the file must be broken" at 3am."""
    found = re.search(r"BAD_DECRYPT = \(\n((?:\s*\".*\"\n)+)\)", READER_SOURCE)
    assert found, "nova_restore.py no longer defines BAD_DECRYPT as a joined literal"
    reader_sentence = "".join(
        json.loads(line.strip()) for line in found.group(1).strip().splitlines()
    )
    assert reader_sentence == nb.BAD_DECRYPT
    assert nb.BAD_DECRYPT == (
        "decryption failed — wrong passphrase, or the file is corrupt, truncated "
        "or tampered with (GCM cannot tell these apart)"
    )


def test_the_reader_side_cost_caps_are_identical_in_both_implementations():
    for name, value in (
        ("MAX_N", nb.MAX_N),
        ("MAX_R", nb.MAX_R),
        ("MAX_P", nb.MAX_P),
        ("MAX_CHUNK", nb.MAX_CHUNK),
        ("KDF_MEM_CAP", nb.KDF_MEM_CAP),
        ("MAX_HEADER", nb.MAX_HEADER),
        ("TAG_LEN", nb.TAG_LEN),
    ):
        source = subprocess.run(
            [sys.executable, "-c", f"import nova_restore; print(nova_restore.{name})"],
            cwd=str(BACKUP_DIR),
            capture_output=True,
            text=True,
        )
        assert source.returncode == 0, source.stderr
        assert source.stdout.strip() == str(value), name


# ── genpass ─────────────────────────────────────────────────────────────────


def test_genpass_is_eight_groups_of_four_lowercase_base32():
    phrase = nb.generate_passphrase()
    assert re.fullmatch(r"[a-z2-7]{4}(-[a-z2-7]{4}){7}", phrase), phrase


def test_genpass_carries_160_bits():
    """Generated HERE and never by `openssl rand 20` captured with `$( )`:
    bash drops NUL bytes and strips trailing newlines from a command
    substitution, so roughly one passphrase in thirteen would silently carry
    less than 160 bits (§7.2)."""
    import base64

    phrase = nb.generate_passphrase()
    raw = base64.b32decode(phrase.replace("-", "").upper())
    assert len(raw) == 20
    assert len({nb.generate_passphrase() for _ in range(64)}) == 64


def test_genpass_never_touches_argv():
    out = subprocess.run(
        [sys.executable, "novabundle.py", "genpass"],
        cwd=str(BACKUP_DIR),
        capture_output=True,
        text=True,
    )
    assert out.returncode == 0
    assert re.fullmatch(r"[a-z2-7]{4}(-[a-z2-7]{4}){7}\n", out.stdout)


def test_the_passphrase_arrives_on_stdin_and_nowhere_else():
    """`novabundle.py kat` takes no passphrase argument at all — argparse
    would refuse one. This is the mechanical half of §7.5."""
    parser = nb.build_parser()
    with pytest.raises(SystemExit):
        parser.parse_args(["kat", PASSPHRASE])
    assert "--passphrase" not in nb.build_parser().format_help()
    assert nb.read_passphrase(io.StringIO(PASSPHRASE + "\n")) == PASSPHRASE
    assert nb.read_passphrase(io.StringIO(PASSPHRASE + "\r\n")) == PASSPHRASE
    with pytest.raises(nb.CryptoError):
        nb.read_passphrase(io.StringIO(""))


def test_cryptography_is_a_declared_runtime_dependency_of_the_core_image():
    """novabundle.py's WRITING half imports `cryptography`, and it runs
    inside the already-built core image. Unlike PyYAML — which is in that
    image only transitively, through uvicorn[standard] — this one is
    declared, and this is the line of code that notices the day it stops
    being. A `cryptography` in the dev group would not count: the image is
    built with `uv sync --frozen --no-dev`.
    """
    from test_raw_compose import runtime_dependencies

    core = pathlib.Path(__file__).resolve().parents[3] / "services" / "core"
    assert "cryptography" in runtime_dependencies(core / "pyproject.toml")
