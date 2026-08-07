"""Encrypting a bundle so a COMPLETE backup is safe to copy (roadmap #31).

Jeremy restated the goal on 2026-08-02: disaster recovery. "If a computer
crashes, spin Nova up on a different machine and keep configurations,
secrets, conversation and memories." A bundle that cannot bring up a working
system does not satisfy that, so the bundle now carries .env, the secrets
master key and the tailnet key — and encryption is what makes a file like
that safe to put on a NAS, a USB stick, someone else's cloud.

The format (NOVAENC1) is deliberately boring:

    b"NOVAENC1"                                  8-byte magic
    4-byte BE header length
    header JSON: {v, cipher, kdf, n, r, p, salt, nonce_prefix, chunk}
    frames: [4-byte BE ciphertext length][ciphertext] ... until EOF

  * **scrypt** (from hashlib, so the STANDALONE restore script needs no
    third-party package to derive the same key) turns the passphrase into a
    32-byte AES key. A fresh salt per file means a fresh key per file.
  * **AES-256-GCM per chunk**, nonce = 4-byte random prefix + 8-byte BE
    counter. Chunked because a bundle is hundreds of MB and single-shot GCM
    would hold plaintext AND ciphertext in memory at once — measured 190 MB
    bundles today, growing with every attachment.
  * **The header and the chunk's position are authenticated**, not just its
    bytes: AAD = magic + header + counter + a final-chunk flag. So a
    tampered header fails to decrypt, a reordered chunk fails to decrypt,
    and — the one that matters for backups — a TRUNCATED file fails to
    decrypt instead of quietly yielding a shorter archive. A backup you
    only read after a disaster is exactly the file nobody notices was cut
    short by a full disk two months ago.

Wrong passphrase and corrupt file are the same exception on purpose: GCM
cannot tell them apart, and pretending otherwise would invite "the
passphrase must be right, the file must be broken" during a restore at 3am.

This module is pure mechanism — no settings, no resolver, no app imports —
so it is testable byte-for-byte and reimplementable by the standalone
restore script, which carries its own copy of the reading half (plus a
ctypes/OpenSSL fallback) and is pinned to this one by a round-trip test.
"""

import hashlib
import json
import os
import secrets
import struct
from pathlib import Path

MAGIC = b"NOVAENC1"

# scrypt cost. n=2**15/r=8 is ~34 MB of KDF memory — deliberately modest,
# because the default passphrase is GENERATED with 160 bits of entropy and
# carries its own strength; the KDF is there for the operator who types his
# own. Raising n later is free only up to _KDF_MEM_CAP below — the reader
# obeys the header, and the reader's maxmem is the real ceiling.
SCRYPT_N, SCRYPT_R, SCRYPT_P = 1 << 15, 8, 1
# What a READER will accept. A decryptor must allocate 128*r*n bytes before
# the first authentication check can run, so an attacker who can edit the
# header can make an unwary reader allocate gigabytes — or, subtler, name a
# cost hashlib will refuse under our own maxmem, turning "tampered" into a
# bare ValueError. So the accepted region is exactly the PAYABLE region:
# n a power of two, and 128*r*n within the cap, with headroom to maxmem.
MAX_N, MAX_R, MAX_P = 1 << 18, 16, 4
_KDF_MEM_CAP = 128 * 1024 * 1024        # bytes; maxmem below is 2x this

CHUNK = 4 * 1024 * 1024
MAX_CHUNK = 64 * 1024 * 1024
TAG_LEN = 16


class CryptoError(Exception):
    """Wrong passphrase, or the file is corrupt/tampered/truncated. GCM
    cannot distinguish these, so neither does this exception."""


def _key(passphrase: str, salt: bytes, n: int, r: int, p: int) -> bytes:
    if not passphrase:
        raise CryptoError("an empty passphrase is not a passphrase")
    return hashlib.scrypt(passphrase.encode("utf-8"), salt=salt,
                          n=n, r=r, p=p, maxmem=256 * 1024 * 1024, dklen=32)


def _aad(header_bytes: bytes, index: int, final: bool) -> bytes:
    return MAGIC + header_bytes + struct.pack(">Q", index) + (b"\x01" if final else b"\x00")


def _nonce(prefix: bytes, index: int) -> bytes:
    return prefix + struct.pack(">Q", index)


def is_encrypted(path: Path) -> bool:
    try:
        with open(path, "rb") as f:
            return f.read(len(MAGIC)) == MAGIC
    except OSError:
        return False


def read_header(path: Path) -> dict:
    """The KDF/cipher parameters, WITHOUT the key. Refuses parameters a
    reader should not obey — see MAX_N: the header is attacker-writable and
    is only authenticated after the KDF has already been paid for."""
    with open(path, "rb") as f:
        if f.read(len(MAGIC)) != MAGIC:
            raise CryptoError("not a NOVAENC1 file")
        raw = f.read(4)
        if len(raw) != 4:
            raise CryptoError("truncated before the header")
        hlen = struct.unpack(">I", raw)[0]
        if hlen > 4096:
            raise CryptoError("implausible header size — corrupt or tampered")
        hbytes = f.read(hlen)
        if len(hbytes) != hlen:
            raise CryptoError("truncated inside the header")
    try:
        header = json.loads(hbytes.decode("utf-8"))
    except ValueError as e:
        raise CryptoError(f"header is not JSON: {e}") from e
    if header.get("v") != 1 or header.get("cipher") != "aes-256-gcm" \
            or header.get("kdf") != "scrypt":
        raise CryptoError(f"unsupported format: {header}")
    n, r, p = header.get("n", 0), header.get("r", 0), header.get("p", 0)
    if not (isinstance(n, int) and isinstance(r, int) and isinstance(p, int)
            and 0 < n <= MAX_N and 0 < r <= MAX_R and 0 < p <= MAX_P
            and (n & (n - 1)) == 0 and 128 * r * n <= _KDF_MEM_CAP):
        # covers the sly cases as well as the loud ones: n=32760 (one bit
        # off a real header, not a power of two) or n=2**18/r=8 (inside a
        # naive cap, over maxmem) would otherwise escape hashlib as a bare
        # ValueError instead of the verdict "this file is tampered with"
        raise CryptoError(
            f"scrypt cost n={n} r={r} p={p} is outside what this reader "
            f"will pay for — the header may be tampered with")
    if not (isinstance(header.get("chunk"), int)
            and 0 < header["chunk"] <= MAX_CHUNK):
        raise CryptoError("implausible chunk size — corrupt or tampered")
    for field, length in (("salt", 16), ("nonce_prefix", 4)):
        raw = header.get(field)
        try:
            if len(bytes.fromhex(raw)) != length:
                raise ValueError
        except (TypeError, ValueError):
            raise CryptoError(f"header {field} is not {length} bytes of hex "
                              f"— corrupt or tampered")
    header["_bytes"] = hbytes          # what the AAD is computed over
    return header


def encrypt_file(src: Path, dst: Path, passphrase: str, *,
                 chunk: int = CHUNK) -> None:
    """src -> dst in NOVAENC1. dst is written directly; callers that need
    atomicity write to their own .part name, as the snapshot already does."""
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM
    salt, prefix = secrets.token_bytes(16), secrets.token_bytes(4)
    header = {"v": 1, "cipher": "aes-256-gcm", "kdf": "scrypt",
              "n": SCRYPT_N, "r": SCRYPT_R, "p": SCRYPT_P,
              "salt": salt.hex(), "nonce_prefix": prefix.hex(),
              "chunk": chunk}
    hbytes = json.dumps(header, separators=(",", ":"), sort_keys=True).encode()
    aes = AESGCM(_key(passphrase, salt, SCRYPT_N, SCRYPT_R, SCRYPT_P))
    size = src.stat().st_size
    with open(src, "rb") as fin, open(dst, "wb") as fout:
        fout.write(MAGIC)
        fout.write(struct.pack(">I", len(hbytes)))
        fout.write(hbytes)
        index, done = 0, 0
        while True:
            plain = fin.read(chunk)
            done += len(plain)
            # `final` must be decided by POSITION, not by a short read: the
            # last chunk of an exact-multiple file is full-length.
            final = done >= size
            ct = aes.encrypt(_nonce(prefix, index), plain,
                             _aad(hbytes, index, final))
            fout.write(struct.pack(">I", len(ct)))
            fout.write(ct)
            index += 1
            if final:
                break


def decrypt_file(src: Path, dst: Path, passphrase: str) -> None:
    """src (NOVAENC1) -> dst. Any failure — wrong passphrase, flipped bit,
    truncation, a chunk out of order — raises CryptoError and leaves dst
    incomplete; the caller owns cleanup, and every caller here works in a
    tempdir precisely so a half-decrypted file can never be mistaken for a
    bundle."""
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM
    header = read_header(src)
    hbytes = header.pop("_bytes")
    try:
        salt = bytes.fromhex(header["salt"])
        prefix = bytes.fromhex(header["nonce_prefix"])
        aes = AESGCM(_key(passphrase, salt,
                          header["n"], header["r"], header["p"]))
    except CryptoError:
        raise
    except Exception as e:  # noqa: BLE001 — belt and braces over read_header
        # read_header validates all of this, but the docstring's contract —
        # ANY failure on a bad file is CryptoError, never a bare ValueError
        # — is worth enforcing where the values are actually spent.
        raise CryptoError(f"unusable header: {type(e).__name__}: {e}") from e
    with open(src, "rb") as fin, open(dst, "wb") as fout:
        fin.seek(len(MAGIC) + 4 + len(hbytes))
        index = 0
        frame = _read_frame(fin, header["chunk"])
        if frame is None:
            raise CryptoError("no ciphertext at all — the file is truncated")
        while frame is not None:
            nxt = _read_frame(fin, header["chunk"])
            final = nxt is None
            try:
                plain = aes.decrypt(_nonce(prefix, index),
                                    frame, _aad(hbytes, index, final))
            except Exception as e:  # InvalidTag, deliberately widened
                raise CryptoError(
                    "decryption failed — wrong passphrase, or the file is "
                    "corrupt, truncated or tampered with (GCM cannot tell "
                    "these apart)") from e
            fout.write(plain)
            frame, index = nxt, index + 1


def _read_frame(f, chunk: int) -> bytes | None:
    raw = f.read(4)
    if not raw:
        return None
    if len(raw) != 4:
        raise CryptoError("truncated mid-frame")
    clen = struct.unpack(">I", raw)[0]
    if not (TAG_LEN <= clen <= chunk + TAG_LEN):
        raise CryptoError(f"implausible frame of {clen} bytes — corrupt")
    ct = f.read(clen)
    if len(ct) != clen:
        raise CryptoError("truncated inside a frame")
    return ct


def generate_passphrase() -> str:
    """160 bits, grouped for a human writing it on paper: 8 groups of 4
    lowercase base32 characters. The whole point of the passphrase is to be
    RECORDED OFF-MACHINE — if this machine dies, Nova's stored copy dies
    with it — so the format optimises for transcription, not for typing."""
    import base64
    raw = base64.b32encode(secrets.token_bytes(20)).decode().lower()
    return "-".join(raw[i:i + 4] for i in range(0, 32, 4))
