#!/usr/bin/env python3
"""Open a Nova backup bundle on a machine that has NOTHING but this file,
python3, the bundle and the passphrase.

    python3 nova_restore.py <bundle> --out ./nova-restored
    python3 nova_restore.py <bundle> --verify-only
    python3 nova_restore.py <bundle> --kat            # just prove the passphrase

Why this file exists (the bootstrap trap): the bundle CONTAINS deploy/.env,
and the stack cannot start without it — so on a fresh machine, opening a
backup cannot go through Nova. This script is committed to the repo AND
written byte-identically into every bundle, so it travels with the thing it
opens, and one published digest covers every bundle for a given commit.

It is deliberately standalone: it imports nothing from this repo and needs no
third-party package. AES-256-GCM comes from `cryptography` when that happens
to be installed, and otherwise from the system OpenSSL's libcrypto through
ctypes. scrypt is `hashlib`'s, which is why the KDF cost is what it is.

It never runs docker, never touches an existing installation and never writes
outside --out. The destructive steps stay a human decision, printed.

The NOVAENC1 reading half below mirrors deploy/backup/novabundle.py and is
pinned to it by tests/test_restore_reader.py, which round-trips the writer's
output through this file in a subprocess under BOTH backends.
"""

import argparse
import getpass
import glob
import hashlib
import io
import json
import os
import posixpath
import re
import shutil
import stat
import struct
import sys
import tarfile
import tempfile
import time

MAGIC = b"NOVAENC1"
TAG_LEN = 16
MAX_N, MAX_R, MAX_P = 1 << 18, 16, 4
KDF_MEM_CAP = 128 * 1024 * 1024
SCRYPT_MAXMEM = 256 * 1024 * 1024
MAX_CHUNK = 64 * 1024 * 1024
MAX_HEADER = 4096

OUTER_README = "README.txt"
OUTER_READER = "nova_restore.py"
OUTER_SCRIPT = "restore.sh"
OUTER_KAT_SHA = "kat.sha256"
OUTER_KAT = "kat.enc"
OUTER_META = "meta.json"
OUTER_PAYLOAD = "payload.enc"
INNER_MANIFEST = "MANIFEST.json"

# The ONE field of cleartext meta.json this reader consults, and the one
# named exception to "nothing that survives a failed decrypt is decided by
# meta.json": a restore must choose WHICH passphrase to try before it can
# decrypt anything, and this is the only pre-decryption source of a bundle's
# fingerprint. A wrong choice fails the known-answer test and refuses.
META_FIELD_READ = "passphrase_fingerprint"

# Identical, character for character, to novabundle.py's BAD_DECRYPT, and
# pinned by tests/test_novaenc.py. GCM genuinely cannot tell a wrong
# passphrase from a corrupt file, and pretending otherwise is what produces
# "the passphrase must be right, so the file must be broken" at 3am.
BAD_DECRYPT = (
    "decryption failed — wrong passphrase, or the file is corrupt, truncated "
    "or tampered with (GCM cannot tell these apart)"
)

# One known AES-256-GCM answer, so a backend is ACCEPTED only after it has
# produced the right plaintext once — before any bundle is touched. A library
# that loads and resolves its symbols has proven neither.
_SELFTEST_KEY = bytes.fromhex("000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f")
_SELFTEST_NONCE = bytes.fromhex("000102030405060708090a0b")
_SELFTEST_AAD = b"nova-backend-self-test"
_SELFTEST_PLAIN = b"nova AES-256-GCM backend self-test"
_SELFTEST_CT = bytes.fromhex(
    "296da07ae5a48748a073a2bd9cae3b20a3b4e6579b1e3118181480e97b4474d7"
    "7264508b831360fd0f197270f9fcc77b76c6"
)


class CryptoError(Exception):
    """Wrong passphrase, or the file is corrupt/tampered/truncated, or a
    header this reader will not obey."""


class RestoreError(Exception):
    """The bundle is not what it says it is."""


class NoBackend(RestoreError):
    """This MACHINE cannot decrypt, which is a different fact from "this
    bundle or this passphrase is wrong" — and restore.sh needs to tell them
    apart to know whether to try the next backend or to stop. It does that on
    the exit code, not by matching a sentence."""


# ── AES-256-GCM, two ways ───────────────────────────────────────────────────


def gcm_backend():
    """(decrypt(key, nonce, ct_with_tag, aad) -> plaintext, a name).

    `cryptography` first because it is the one that needs no discovery. Set
    NOVA_FORCE_CTYPES_GCM=1 to skip it — that is how the backup's own round
    trip proves the path a bare machine will take, rather than the path the
    machine that built the bundle happens to have.
    """
    if os.environ.get("NOVA_FORCE_CTYPES_GCM") != "1":
        try:
            from cryptography.hazmat.primitives.ciphers.aead import AESGCM
        except ImportError:
            pass
        else:

            def _decrypt(key, nonce, ct, aad):
                try:
                    return AESGCM(key).decrypt(nonce, ct, aad)
                except Exception:
                    raise CryptoError(BAD_DECRYPT) from None

            _self_test(_decrypt, "cryptography")
            return _decrypt, "cryptography"
    return _openssl_gcm()


def _self_test(decrypt, name):
    """A backend is accepted only after it has produced the right plaintext
    once AND refused a vector whose GCM tag is wrong.

    Both halves matter. The first rules out a broken or mismatched wheel; the
    second rules out a "backend" that decrypts without checking the tag at
    all — a CTR-mode stand-in passes the first and would then pass the KAT
    too, and every truncation and tampering guarantee in this file rests on
    that check.

    A failure here is a fault of this MACHINE, not of the bundle, so it
    raises NoBackend and exits 4: restore.sh reads that and moves to the next
    candidate. Reported as a bundle fault it stopped the probe dead on a
    machine where three other backends worked, and told the operator his
    passphrase or his only copy was wrong when neither was.
    """
    try:
        got = decrypt(_SELFTEST_KEY, _SELFTEST_NONCE, _SELFTEST_CT, _SELFTEST_AAD)
    except Exception as exc:
        raise NoBackend(f"the {name} backend failed its own known answer: {exc}") from exc
    if got != _SELFTEST_PLAIN:
        raise NoBackend(f"the {name} backend decrypted a known vector to the wrong bytes")
    tampered = _SELFTEST_CT[:-1] + bytes([_SELFTEST_CT[-1] ^ 0x01])
    try:
        decrypt(_SELFTEST_KEY, _SELFTEST_NONCE, tampered, _SELFTEST_AAD)
    except Exception:
        return
    raise NoBackend(
        f"the {name} backend accepted a known vector whose GCM tag is wrong, so it is not "
        "checking authenticity at all"
    )


def _libcrypto_candidates():
    """Where a real OpenSSL might be, discovered rather than listed.

    On macOS `ctypes.util.find_library` is NEVER called: Apple ships a stub
    libcrypto that aborts the whole process when it is used, so the naive
    "find any libcrypto" is not merely wrong there but crash-unsafe. The
    answer is to look only where real OpenSSL installs put themselves, and to
    GLOB rather than hardcode two paths — `openssl@3` will not be the last
    name Homebrew uses, and a Cellar path is version-stamped.
    """
    override = os.environ.get("NOVA_LIBCRYPTO")
    if override:
        # EXCLUSIVE, not first. The operator pointed at a library; quietly
        # loading a different one and reporting success would be the kind of
        # fallback that reads as success. If this one does not work, the
        # refusal names it.
        return [override]
    found = []
    if sys.platform == "darwin":
        prefixes = [os.environ.get("HOMEBREW_PREFIX") or "", "/opt/homebrew", "/usr/local"]
        for prefix in prefixes:
            if not prefix:
                continue
            found += sorted(glob.glob(prefix + "/opt/openssl@*/lib/libcrypto.dylib"), reverse=True)
            found += sorted(
                glob.glob(prefix + "/Cellar/openssl@*/*/lib/libcrypto.dylib"), reverse=True
            )
        found += sorted(glob.glob("/opt/local/lib/libcrypto.*.dylib"), reverse=True)
        found.append("/opt/local/lib/libcrypto.dylib")
    else:
        import ctypes.util

        discovered = ctypes.util.find_library("crypto")
        if discovered:
            found.append(discovered)
        found += ["libcrypto.so.3", "libcrypto.so.1.1", "libcrypto.so"]
    seen, ordered = set(), []
    for candidate in found:
        if candidate and candidate not in seen:
            seen.add(candidate)
            ordered.append(candidate)
    return ordered


_INSTALL_ADVICE = (
    "no usable AES-256-GCM on this machine.\n"
    "  Install one of:\n"
    "    python3 -m pip install cryptography          (any OS)\n"
    "    apt-get install -y openssl libssl3           (Debian/Ubuntu)\n"
    "    dnf install -y openssl-libs                  (Fedora/RHEL)\n"
    "    brew install openssl@3                       (macOS)\n"
    "  or point this script at a real libcrypto:  NOVA_LIBCRYPTO=/path/to/libcrypto.so\n"
    "  or open the bundle through docker instead — restore.sh does that for you."
)


def _openssl_gcm():
    import ctypes

    c = ctypes
    lib = None
    tried = []
    for candidate in _libcrypto_candidates():
        tried.append(candidate)
        try:
            probe = c.CDLL(candidate)
            probe.EVP_CIPHER_CTX_new  # noqa: B018 — symbol probe
            lib = probe
            break
        except (OSError, AttributeError):
            continue
    if lib is None:
        raise NoBackend(_INSTALL_ADVICE + "\n  (tried: " + ", ".join(tried or ["nothing"]) + ")")

    lib.EVP_CIPHER_CTX_new.restype = c.c_void_p
    lib.EVP_CIPHER_CTX_free.argtypes = [c.c_void_p]
    lib.EVP_aes_256_gcm.restype = c.c_void_p
    lib.EVP_DecryptInit_ex.restype = c.c_int
    lib.EVP_DecryptInit_ex.argtypes = [c.c_void_p, c.c_void_p, c.c_void_p, c.c_char_p, c.c_char_p]
    lib.EVP_CIPHER_CTX_ctrl.restype = c.c_int
    lib.EVP_CIPHER_CTX_ctrl.argtypes = [c.c_void_p, c.c_int, c.c_int, c.c_void_p]
    lib.EVP_DecryptUpdate.restype = c.c_int
    lib.EVP_DecryptUpdate.argtypes = [
        c.c_void_p,
        c.c_char_p,
        c.POINTER(c.c_int),
        c.c_char_p,
        c.c_int,
    ]
    lib.EVP_DecryptFinal_ex.restype = c.c_int
    lib.EVP_DecryptFinal_ex.argtypes = [c.c_void_p, c.c_char_p, c.POINTER(c.c_int)]
    EVP_CTRL_AEAD_SET_IVLEN, EVP_CTRL_AEAD_SET_TAG = 0x9, 0x11

    def _decrypt(key, nonce, ct_with_tag, aad):
        if len(ct_with_tag) < TAG_LEN:
            raise CryptoError(BAD_DECRYPT)
        ct, tag = ct_with_tag[:-TAG_LEN], ct_with_tag[-TAG_LEN:]
        ctx = lib.EVP_CIPHER_CTX_new()
        if not ctx:
            raise RestoreError("OpenSSL: could not allocate a cipher context")
        try:
            outl = c.c_int(0)
            ok = (
                lib.EVP_DecryptInit_ex(ctx, lib.EVP_aes_256_gcm(), None, None, None) == 1
                and lib.EVP_CIPHER_CTX_ctrl(ctx, EVP_CTRL_AEAD_SET_IVLEN, len(nonce), None) == 1
                and lib.EVP_DecryptInit_ex(ctx, None, None, key, nonce) == 1
            )
            if not ok:
                raise RestoreError("OpenSSL: cipher initialisation failed")
            if aad and lib.EVP_DecryptUpdate(ctx, None, c.byref(outl), aad, len(aad)) != 1:
                raise RestoreError("OpenSSL: could not absorb the AAD")
            out = c.create_string_buffer(max(len(ct), 1))
            outl = c.c_int(0)
            if ct and lib.EVP_DecryptUpdate(ctx, out, c.byref(outl), ct, len(ct)) != 1:
                raise RestoreError("OpenSSL: decrypt update failed")
            plain = out.raw[: outl.value]
            if lib.EVP_CIPHER_CTX_ctrl(ctx, EVP_CTRL_AEAD_SET_TAG, TAG_LEN, c.c_char_p(tag)) != 1:
                raise RestoreError("OpenSSL: could not set the GCM tag")
            fin = c.c_int(0)
            tail = c.create_string_buffer(TAG_LEN)
            # EVP_DecryptFinal_ex's RETURN VALUE is the tag check. A zero
            # return is a refusal, never a warning.
            if lib.EVP_DecryptFinal_ex(ctx, tail, c.byref(fin)) != 1:
                raise CryptoError(BAD_DECRYPT)
            return plain + tail.raw[: fin.value]
        finally:
            lib.EVP_CIPHER_CTX_free(ctx)

    name = f"system OpenSSL via ctypes ({tried[-1]})"
    _self_test(_decrypt, name)
    return _decrypt, name


# ── the NOVAENC1 container (reader half; mirrors novabundle.py) ─────────────


def parse_header(fh):
    if fh.read(len(MAGIC)) != MAGIC:
        raise CryptoError("not a NOVAENC1 file")
    raw = fh.read(4)
    if len(raw) != 4:
        raise CryptoError("truncated before the header")
    hlen = struct.unpack(">I", raw)[0]
    if hlen > MAX_HEADER:
        raise CryptoError("implausible header size — corrupt or tampered")
    hbytes = fh.read(hlen)
    if len(hbytes) != hlen:
        raise CryptoError("truncated inside the header")
    try:
        header = json.loads(hbytes.decode("utf-8"))
    except ValueError as exc:
        raise CryptoError(f"header is not JSON: {exc}") from exc
    if not isinstance(header, dict):
        raise CryptoError("header is not a JSON object — corrupt or tampered")
    if (
        header.get("v") != 1
        or header.get("cipher") != "aes-256-gcm"
        or header.get("kdf") != "scrypt"
    ):
        raise CryptoError(f"unsupported format: {header}")
    n, r, p = header.get("n", 0), header.get("r", 0), header.get("p", 0)
    # Checked BEFORE any allocation: a decryptor must allocate 128*r*n bytes
    # before the first authentication check can run, so without this a
    # tampered header naming an absurd cost makes an honest reader allocate
    # gigabytes — or blow maxmem and turn "tampered" into a bare ValueError.
    if not (
        isinstance(n, int)
        and isinstance(r, int)
        and isinstance(p, int)
        and not isinstance(n, bool)
        and not isinstance(r, bool)
        and not isinstance(p, bool)
        and 0 < n <= MAX_N
        and 0 < r <= MAX_R
        and 0 < p <= MAX_P
        and (n & (n - 1)) == 0
        and 128 * r * n <= KDF_MEM_CAP
    ):
        raise CryptoError(
            f"scrypt cost n={n} r={r} p={p} is outside what this reader will pay for "
            "— the header may be tampered with"
        )
    chunk = header.get("chunk")
    if not (isinstance(chunk, int) and not isinstance(chunk, bool) and 0 < chunk <= MAX_CHUNK):
        raise CryptoError("implausible chunk size — corrupt or tampered")
    for field, length in (("salt", 16), ("nonce_prefix", 4)):
        value = header.get(field)
        try:
            if len(bytes.fromhex(value)) != length:
                raise ValueError
        except (TypeError, ValueError):
            raise CryptoError(
                f"header {field} is not {length} bytes of hex — corrupt or tampered"
            ) from None
    header["_bytes"] = hbytes
    return header


def _derive(passphrase, header):
    return hashlib.scrypt(
        passphrase.encode("utf-8"),
        salt=bytes.fromhex(header["salt"]),
        n=header["n"],
        r=header["r"],
        p=header["p"],
        maxmem=SCRYPT_MAXMEM,
        dklen=32,
    )


def key_fingerprint(passphrase, header):
    """§7.4: sha256(scrypt(passphrase, THIS file's salt))[:12]. Never
    sha256(passphrase)[:12] — that form costs an attacker one unsalted hash
    per guess and annuls the KDF this bundle is protected by."""
    return hashlib.sha256(_derive(passphrase, header)).hexdigest()[:12]


def _read_frame(fh, chunk):
    raw = fh.read(4)
    if not raw:
        return None
    if len(raw) != 4:
        raise CryptoError("truncated mid-frame")
    clen = struct.unpack(">I", raw)[0]
    if not (TAG_LEN <= clen <= chunk + TAG_LEN):
        raise CryptoError(f"implausible frame of {clen} bytes — corrupt")
    ct = fh.read(clen)
    if len(ct) != clen:
        raise CryptoError("truncated inside a frame")
    return ct


def decrypt_stream(fin, fout, passphrase, decrypt):
    header = parse_header(fin)
    hbytes = header.pop("_bytes")
    try:
        key = _derive(passphrase, header)
        prefix = bytes.fromhex(header["nonce_prefix"])
    except CryptoError:
        raise
    except Exception as exc:
        raise CryptoError(f"unusable header: {type(exc).__name__}: {exc}") from exc
    index = 0
    frame = _read_frame(fin, header["chunk"])
    if frame is None:
        raise CryptoError("no ciphertext at all — the file is truncated")
    while frame is not None:
        # Finality at read time is LOOKAHEAD: the next frame header is read
        # before this frame is decrypted, so a truncated file fails
        # authentication instead of yielding a shorter archive.
        nxt = _read_frame(fin, header["chunk"])
        final = nxt is None
        aad = MAGIC + hbytes + struct.pack(">Q", index) + (b"\x01" if final else b"\x00")
        fout.write(decrypt(key, prefix + struct.pack(">Q", index), frame, aad))
        frame, index = nxt, index + 1
    return header


def decrypt_bytes(blob, passphrase, decrypt):
    out = io.BytesIO()
    decrypt_stream(io.BytesIO(blob), out, passphrase, decrypt)
    return out.getvalue()


# ── extraction, refusing by name ────────────────────────────────────────────

_REFUSED_TYPES = {
    tarfile.CHRTYPE: "a character device",
    tarfile.BLKTYPE: "a block device",
    tarfile.FIFOTYPE: "a fifo",
}


def _escapes(name):
    if name.startswith("/") or (len(name) > 1 and name[1] == ":"):
        return "an absolute path"
    if ".." in name.replace("\\", "/").split("/"):
        return "a `..` component"
    return ""


def check_member(member):
    bad = _escapes(member.name)
    if bad:
        return f"{member.name}: {bad}"
    if member.type in _REFUSED_TYPES:
        return f"{member.name}: {_REFUSED_TYPES[member.type]}"
    if member.issym() or member.islnk():
        if member.islnk():
            bad = _escapes(member.linkname)
            if bad:
                return f"{member.name}: a hard link to {bad}"
        if member.linkname.startswith("/"):
            return f"{member.name}: a link with an absolute target"
        resolved = posixpath.normpath(
            posixpath.join(posixpath.dirname(member.name), member.linkname)
        )
        if resolved == ".." or resolved.startswith("../"):
            return f"{member.name}: a link with a target outside the archive"
    return ""


def _ancestors(name):
    parts = posixpath.normpath(name).split("/")
    return ["/".join(parts[:i]) for i in range(1, len(parts))]


def members_refusal(members):
    """Why this SET of members will not be extracted, or "".

    check_member judges each member alone, and a two-hop chain passes it:
    `dir/x -> ".."` normalises to `"."`, `dir/x/up -> ".."` normalises to
    `"dir"`, and `dir/x/up/PWNED` holds no `..` at all — but by the time it
    is written, `dir/x` is a symlink to the root and `dir/x/up` points at the
    root's PARENT. On python 3.12 the extraction filter stops that; this
    script runs on whatever python3 a fresh machine has and restore.sh
    accepts 3.9, so the refusal has to be ours.
    """
    symlinks = set()
    for member in members:
        bad = check_member(member)
        if bad:
            return bad
        name = posixpath.normpath(member.name)
        for ancestor in _ancestors(name):
            # Case-folded as well as exact: on a case-insensitive filesystem
            # — APFS by default, and NTFS — `DIR/x` and `dir/x` are the same
            # path, so an exact-match set lets the second hop of a chain in
            # under a different spelling. Folding costs nothing on a
            # case-sensitive filesystem except refusing an archive that
            # carries two entries differing only in case, which fails closed.
            if ancestor in symlinks or ancestor.lower() in symlinks:
                return (
                    f"{member.name}: its path goes through `{ancestor}`, which this same "
                    "archive declares a symlink — a chain like that escapes the target "
                    "one hop at a time"
                )
        if member.issym():
            symlinks.add(name)
            symlinks.add(name.lower())
    return ""


HIGH_BITS = 0o7000  # setuid, setgid, sticky


def running_as_root():
    """Whether this process can set an owner AT ALL.

    `os.chown` is a no-op for everyone else, so this is the one fact every
    sentence about ownership below is derived from — the statement and the
    behaviour cannot disagree because they read the same function.
    """
    return hasattr(os, "geteuid") and os.geteuid() == 0


def high_bit_refusal(members):
    """Why this set will not be extracted because of its MODES, or "".

    Restoring a recorded mode is restoring data. Restoring a setuid, setgid
    or sticky bit out of a file somebody handed you is letting the bundle
    choose a privileged behaviour on the machine that opens it — and this
    reader runs, by design, on a machine with nothing, sometimes as root.
    `backup.sh` refuses the same three bits when it fills a volume from the
    sealed listing; two layers that disagree about what they will place is
    worse than either rule on its own.
    """
    for member in members:
        if member.mode and member.mode & HIGH_BITS:
            return (
                f"{member.name}: mode {_mode_octal(member.mode)} carries setuid, setgid or "
                "sticky. Nothing is placed from a bundle this reader does not trust."
            )
    return ""


def apply_recorded_metadata(dest, members):
    """Put back what CPython's `data` extraction filter drops.

    WHICH LAYER OWNS WHAT, because a restore that gets this wrong is a hub
    whose services cannot read their own data:

      * MODE is this reader's, always. The filter masks every mode to
        `& 0o755` and re-adds the owner bits, and drops a directory's mode
        entirely — measured on this file's own fixture volume: a 0664 note
        landed 0644, a 0666 note landed 0644, a 0755 directory landed 0700.
      * OWNER is root's. `os.chown` is a no-op for anyone else, so this sets
        uid/gid when the process IS root, and `owner_gap` names what it
        could not set when it is not. `./install restore` applies the sealed
        listing's owner columns itself when it fills each volume; this
        reader states the gap rather than pretending to have closed it.

    The source is the ARCHIVE'S OWN HEADERS — the same records
    `verify_extracted` compares the sealed listing against — so extraction
    is faithful to the archive, and the listing is what says the archive is
    right. Nothing here reads a value the manifest could have chosen.
    """
    root_now = running_as_root()
    # Deepest first: a directory the archive records as 0500 would otherwise
    # stop this loop from reaching what is inside it.
    for member in sorted(members, key=lambda m: m.name, reverse=True):
        target = os.path.join(dest, member.name.rstrip("/"))
        if not os.path.lexists(target):
            continue
        if member.issym():
            # chmod through a symlink re-modes its TARGET, and Linux has no
            # lchmod; a symlink's own mode is not data anything reads. Its
            # OWNER is, and lchown does exist.
            if root_now:
                os.lchown(target, member.uid, member.gid)
            continue
        if member.mode is not None:
            os.chmod(target, member.mode & 0o777)
        if root_now:
            os.chown(target, member.uid, member.gid)


def owner_gap(members):
    """The members whose recorded owner this process did NOT set.

    Empty when it is root (it set every one) and when the archive records
    the user it is already running as (there is nothing to set).
    """
    if running_as_root():
        return []
    euid = os.geteuid() if hasattr(os, "geteuid") else -1
    egid = os.getegid() if hasattr(os, "getegid") else -1
    return [m.name for m in members if m.uid != euid or m.gid != egid]


def safe_extract(tar, dest, members=None):
    """Extract `members` under `dest` and then restore the modes the
    extraction dropped.

    The extraction is CPython's hardened `data` filter where there is one,
    plus this file's own member and member-SET refusals, because restore.sh
    accepts python 3.9. What that filter does not do is preserve what was
    backed up — see apply_recorded_metadata for which layer owns which
    column.
    """
    chosen = list(tar.getmembers() if members is None else members)
    bad = members_refusal(chosen) or high_bit_refusal(chosen)
    if bad:
        raise RestoreError(f"bundle member refused — {bad}")
    if not os.path.isdir(dest):
        os.makedirs(dest)
    try:
        tar.extractall(dest, members=chosen, filter="data")
    except TypeError:  # python < 3.12 has no `filter` keyword
        tar.extractall(dest, members=chosen)
    apply_recorded_metadata(dest, chosen)
    return chosen


def rmtree(path):
    """`shutil.rmtree` over a tree this reader may have made unwritable.

    Extraction now lands the archive's recorded modes, and a 0500 directory
    inside a volume is an ordinary thing — so the cleanup that removes the
    work directory has to be able to get back into what it wrote. Failures
    still raise: a cleanup that swallows its reason is how a half-decrypted
    .env gets left behind looking like nothing happened.
    """
    try:
        os.chmod(path, os.lstat(path).st_mode | 0o700)
    except OSError:
        pass
    for dirpath, dirnames, _files in os.walk(path):
        for name in dirnames:
            full = os.path.join(dirpath, name)
            if not os.path.islink(full):
                try:
                    os.chmod(full, os.lstat(full).st_mode | 0o700)
                except OSError:
                    pass  # rmtree will raise with the real reason
    shutil.rmtree(path)


# ── verification against the manifest ───────────────────────────────────────


def sha256_file(path):
    h, total = hashlib.sha256(), 0
    with open(path, "rb") as fh:
        while True:
            block = fh.read(1 << 20)
            if not block:
                break
            h.update(block)
            total += len(block)
    return h.hexdigest(), total


def _mode_octal(mode):
    """GNU find's `%#m`: octal with a leading 0, and a bare `0` for zero."""
    bits = mode & 0o7777
    return "0" if bits == 0 else f"0{bits:o}"


def tar_member_record(member):
    """(metadata, link target) from the ARCHIVE'S records."""
    return tar_member_metadata(member), member.linkname if member.issym() else ""


def tar_member_metadata(member):
    """`<kind> <mode> <uid> <gid>` in the listing's own spelling, from the
    ARCHIVE'S records.

    Half of the verification. The tar headers carry what `find -printf "%y
    %#m %U %G %p"` saw on the live volume, so comparing them to the sealed
    listing says the ARCHIVE is what was backed up. `disk_metadata` is the
    other half — what actually landed — and a check that only ever read this
    one passed over a tree whose every mode was wrong.
    """
    if member.issym():
        kind = "l"
    elif member.isdir():
        kind = "d"
    elif member.isreg() or member.islnk():
        kind = "f"
    else:
        kind = "?"
    return f"{kind} {_mode_octal(member.mode)} {member.uid} {member.gid}"


def disk_metadata(path):
    """`<kind> <mode> <uid> <gid>` for what is ON DISK, in the listing's own
    spelling. The other half of tar_member_metadata."""
    st = os.lstat(path)
    if stat.S_ISLNK(st.st_mode):
        kind = "l"
    elif stat.S_ISDIR(st.st_mode):
        kind = "d"
    elif stat.S_ISREG(st.st_mode):
        kind = "f"
    else:
        kind = "?"
    return f"{kind} {_mode_octal(st.st_mode)} {st.st_uid} {st.st_gid}"


def _checkable_columns(record):
    """The columns of a metadata line this process is in a position to check.

    Type and mode always — extraction sets both, and this reader puts back
    what the filter dropped. uid and gid ONLY when it is root: unprivileged,
    `os.chown` did nothing, so comparing them would compare the extracting
    user against himself and print "verified" over a tree nobody restored
    the ownership of. What was not compared is stated instead, by
    _ownership_line.
    """
    parts = record.split(" ")
    return parts if running_as_root() else parts[:2]


def _verify_tree(root, listing, archived):
    """Every difference between a carried tree and its recorded listing.

    The metadata lines exist precisely so a missing symlink, a lost empty
    directory or a changed mode is visible — a `find . -type f` listing
    cannot see any of them. This used to skip every one of those lines and
    still print "all matching the manifest sealed inside".
    """
    problems = []
    want_meta = {}
    want_hash = {}
    want_link = {}
    for line in listing.splitlines():
        if not line:
            continue
        if line.startswith("L "):
            path, sep, target = line[2:].rpartition(" -> ")
            if not sep:
                problems.append(f"{line!r}: unreadable listing line")
                continue
            want_link[path] = target
            continue
        if line[:1] in ("d", "f", "l") and line[1:2] == " ":
            parts = line.split(" ", 4)
            if len(parts) != 5:
                problems.append(f"{line!r}: unreadable listing line")
                continue
            want_meta[parts[4]] = " ".join(parts[:4])
            continue
        digest, _, path = line.partition("  ")
        if not path:
            problems.append(f"{line!r}: unreadable listing line")
            continue
        want_hash[path] = digest
    seen = set()
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames.sort()
        for name in sorted(dirnames + filenames):
            full = os.path.join(dirpath, name)
            rel = "./" + os.path.relpath(full, root).replace(os.sep, "/")
            seen.add(rel)
            # WHAT LANDED, against what was recorded. `archived` below says
            # the ARCHIVE is right; this says the tree on disk is the tree
            # the archive describes. Without it, an extraction that re-moded
            # every entry verified clean (measured: 4 wrong directories and
            # a read-only file, and `verified: 7 members` on stdout).
            if rel in want_meta:
                got = disk_metadata(full)
                if _checkable_columns(got) != _checkable_columns(want_meta[rel]):
                    problems.append(
                        f"{rel}: on disk it is `{got}`, the listing recorded `{want_meta[rel]}`"
                    )
                elif os.path.islink(full) and os.readlink(full) != want_link.get(rel, ""):
                    problems.append(
                        f"{rel}: on disk it points at `{os.readlink(full)}`, the listing "
                        f"recorded `{want_link.get(rel, '')}`"
                    )
            if os.path.isfile(full) and not os.path.islink(full):
                got, _ = sha256_file(full)
                if rel not in want_hash:
                    problems.append(f"{rel}: in the archive, absent from the listing")
                elif want_hash[rel] != got:
                    problems.append(f"{rel}: content does not match its recorded checksum")
    for rel in sorted(want_meta):
        record = archived.get(rel)
        if record is None:
            problems.append(f"{rel}: named in the listing, absent from the archive")
            continue
        if record[0] != want_meta[rel]:
            problems.append(
                f"{rel}: type/mode/uid/gid is `{record[0]}`, the listing recorded "
                f"`{want_meta[rel]}`"
            )
        if want_meta[rel].startswith("l "):
            if rel not in want_link:
                problems.append(f"{rel}: is a symlink and the listing records no target for it")
            elif want_link[rel] != record[1]:
                problems.append(
                    f"{rel}: points at `{record[1]}`, the listing recorded `{want_link[rel]}`"
                )
    for rel in sorted(set(archived) - set(want_meta)):
        problems.append(f"{rel}: in the archive, absent from the listing")
    for rel in sorted(set(want_hash) - seen):
        problems.append(f"{rel}: named in the listing, absent from the archive")
    for rel in sorted(set(want_link) - set(want_meta)):
        problems.append(f"{rel}: the listing records a target for an entry it does not name")
    return sorted(set(problems))


VOLUME_NAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,254}$")


def _volume_name(restore_to):
    """The docker volume name in a `volume:<name>` hint, or a refusal.

    `restore_to` comes out of the manifest, which is inside payload.enc — so
    whoever wrote it had the passphrase. That is exactly the case this script
    exists for: a bundle someone hands you, with its passphrase, on a machine
    that has nothing. `volume:../../../ESCAPED/x` used to be joined straight
    onto --out.
    """
    name = restore_to.split(":", 1)[1] if restore_to.startswith("volume:") else ""
    if not VOLUME_NAME_RE.match(name):
        raise RestoreError(
            f"this bundle's manifest says restore_to {restore_to!r}, which does not name a "
            "docker volume. Nothing is placed from a manifest this reader does not trust."
        )
    return name


def _relative(value, what="restore_to"):
    """A relative path this reader will act on, or a refusal.

    Absolute, `~`, a drive letter, a backslash, an empty segment, `.` and
    `..` are all refused. Used for every path the manifest names — the ones
    it WRITES to, and the ones it READS from: a `members[].path` of
    `../../../etc/hostname` with that file's real sha256 would otherwise
    "verify", and the word verified would be printed over a file that was
    never in the bundle.
    """
    bad = (
        not isinstance(value, str)
        or not value
        or value.startswith(("/", "~"))
        or "\\" in value
        or "\x00" in value
        or (len(value) > 1 and value[1] == ":")
        or any(part in ("", ".", "..") for part in value.rstrip("/").split("/"))
    )
    if bad:
        raise RestoreError(
            f"this bundle's manifest says {what} {value!r}, which is not a path this reader "
            "will act on. Nothing is read or placed from a manifest this reader does not trust."
        )
    return value


def _must_stay_inside(out, dst):
    """The belt to the two braces above: the RESOLVED destination is under
    --out, or nothing is written. This file's own docstring promises it never
    writes outside --out, and placement is the one path safe_extract does not
    cover."""
    root = os.path.realpath(out)
    target = os.path.realpath(dst)
    if target != root and not target.startswith(root + os.sep):
        raise RestoreError(
            f"this bundle would place {os.path.basename(dst)} outside {out} — refusing. "
            "Nothing is placed from a manifest this reader does not trust."
        )


def _under(archived, prefix):
    stripped = prefix.rstrip("/") + "/"
    return {
        "./" + name[len(stripped) :]: value
        for name, value in archived.items()
        if name.startswith(stripped)
    }


def verify_extracted(root, manifest, archived):
    """Re-derive every member's sha256 FROM THE EXTRACTED BYTES.

    A backup restored without verification is a hope with extra steps.
    `archived` is the tar's own metadata per member, which is what a tree's
    listing is checked against.
    """
    problems = []
    accounted = {INNER_MANIFEST}
    by_prefix = dict((v["prefix"], v) for v in manifest.get("volumes", []))
    for row in manifest.get("members", []):
        path = _relative(row.get("path"), "a member path")
        target = os.path.join(root, path.rstrip("/"))
        if row["kind"] == "tree":
            volume = by_prefix.get(path)
            if volume is None:
                problems.append(f"{path}: a tree member with no volumes[] row")
                continue
            listing_path = os.path.join(
                root, _relative(volume.get("listing_member"), "a listing member")
            )
            if not os.path.isdir(target) or not os.path.isfile(listing_path):
                problems.append(f"{path}: named in the manifest, absent from the archive")
                continue
            digest, _ = sha256_file(listing_path)
            if digest != row["sha256"]:
                problems.append(f"{path}: its listing does not match the recorded hash")
            with open(listing_path) as fh:
                problems += [
                    f"{path}{p.lstrip('./')}" if p.startswith("./") else f"{path}: {p}"
                    for p in _verify_tree(target, fh.read(), _under(archived, path))
                ]
            for dirpath, _dirs, files in os.walk(target):
                for name in files:
                    full = os.path.join(dirpath, name)
                    accounted.add(os.path.relpath(full, root).replace(os.sep, "/"))
            continue
        if not os.path.isfile(target):
            problems.append(f"{path}: named in the manifest, absent from the archive")
            continue
        accounted.add(path)
        digest, size = sha256_file(target)
        if digest != row["sha256"]:
            problems.append(f"{path}: content does not match its recorded checksum")
        if size != row["bytes"]:
            recorded_bytes = row["bytes"]
            problems.append(f"{path}: {size} bytes, the manifest recorded {recorded_bytes}")
    for dirpath, _dirs, files in os.walk(root):
        for name in files:
            rel = os.path.relpath(os.path.join(dirpath, name), root).replace(os.sep, "/")
            if rel not in accounted:
                problems.append(f"{rel}: in the archive and named by no member of the manifest")
    return sorted(set(problems))


# ── the bundle ──────────────────────────────────────────────────────────────


def _meta_fingerprint(meta):
    """The ONLY field of meta.json this reader consults. See META_FIELD_READ."""
    value = meta.get(META_FIELD_READ)
    return value if isinstance(value, str) else None


def open_outer_tar(bundle):
    """The outer tar, whose every read states a refusal instead of raising a
    tarfile error. `tarfile.open` succeeds on a file truncated after the
    first member header and only fails when the member list is walked, so
    wrapping the open alone would still put a bare ReadError in front of an
    operator who is holding his only copy of his Nova."""
    return _OuterTar(bundle)


class _OuterTar:
    def __init__(self, bundle):
        self.bundle = bundle
        try:
            self.tar = tarfile.open(bundle, "r:")
        except tarfile.TarError as exc:
            raise self._refusal(exc) from exc
        except OSError as exc:
            raise RestoreError(f"{bundle}: {exc}") from exc

    def _refusal(self, exc):
        return RestoreError(
            f"{os.path.basename(self.bundle)} is not a readable tar: "
            f"{type(exc).__name__}: {exc}. It is truncated or damaged — check the copy "
            "that produced it."
        )

    def __enter__(self):
        return self

    def __exit__(self, *exc_info):
        self.tar.close()
        return False

    def __getattr__(self, name):
        attribute = getattr(self.tar, name)
        if not callable(attribute):
            return attribute

        def guarded(*args, **kwargs):
            try:
                return attribute(*args, **kwargs)
            except tarfile.TarError as exc:
                raise self._refusal(exc) from exc
            except (EOFError, OSError) as exc:
                raise self._refusal(exc) from exc

        return guarded


def open_outer(bundle):
    with open_outer_tar(bundle) as tar:
        names = tar.getnames()
        if OUTER_PAYLOAD not in names:
            raise RestoreError(
                f"{os.path.basename(bundle)} has no {OUTER_PAYLOAD} — this is not a Nova "
                f"bundle this script understands (members: {names[:8]})"
            )
        blobs = {}
        for name in (OUTER_KAT, OUTER_KAT_SHA, OUTER_META, OUTER_READER, OUTER_SCRIPT):
            if name in names:
                handle = tar.extractfile(name)
                blobs[name] = b"" if handle is None else handle.read()
    return blobs


def _require_kat(blobs):
    if OUTER_KAT not in blobs or OUTER_KAT_SHA not in blobs:
        raise RestoreError(
            f"this bundle carries no {OUTER_KAT}/{OUTER_KAT_SHA}, so a passphrase cannot "
            f"be proven before the payload is read"
        )


def kat_fingerprint(blobs, passphrase):
    """What this passphrase derives under THIS bundle's KAT salt (§7.4)."""
    _require_kat(blobs)
    header = parse_header(io.BytesIO(blobs[OUTER_KAT]))
    header.pop("_bytes")
    return key_fingerprint(passphrase, header)


def kat_gate(blobs, passphrase, decrypt):
    """Prove the decryptor AND the passphrase against 64 known bytes with
    their own fresh salt — BEFORE a payload byte is read."""
    _require_kat(blobs)
    plain = decrypt_bytes(blobs[OUTER_KAT], passphrase, decrypt)
    if hashlib.sha256(plain).hexdigest() != blobs[OUTER_KAT_SHA].decode().strip():
        raise CryptoError(BAD_DECRYPT)


def _refusal_with_fingerprint(blobs, mine):
    recorded = None
    if OUTER_META in blobs:
        try:
            recorded = _meta_fingerprint(json.loads(blobs[OUTER_META].decode("utf-8")))
        except ValueError:
            recorded = None
    if recorded and mine and recorded != mine:
        # NOT "so it is a different passphrase". Both numbers come from
        # cleartext this reader cannot authenticate — meta.json, and the salt
        # in kat.enc's header — so an edited salt makes the CORRECT
        # passphrase derive a different value here. Claiming which of the two
        # it is would be the 3am failure the sentence above exists to
        # prevent, inverted.
        return (
            f"{BAD_DECRYPT}\n  meta.json records passphrase fingerprint {recorded}; the one "
            f"you supplied derives {mine} under the salt in kat.enc. Both of those are "
            f"cleartext this bundle does not authenticate, so they differing means EITHER a "
            f"different passphrase OR an edited file — it cannot say which."
        )
    if recorded:
        return (
            f"{BAD_DECRYPT}\n  meta.json records passphrase fingerprint {recorded} "
            f"(cleartext, unauthenticated — advisory only)."
        )
    return BAD_DECRYPT


# ── the passphrase ──────────────────────────────────────────────────────────


def passphrase_candidates(args):
    """Each candidate is tried STRIPPED, then VERBATIM: a paper transcription
    usually gains whitespace, and a stored value may legitimately carry it."""
    if args.passphrase_file:
        with open(args.passphrase_file) as fh:
            raw = fh.read()
    elif os.environ.get("NOVA_BACKUP_PASSPHRASE"):
        raw = os.environ["NOVA_BACKUP_PASSPHRASE"]
    elif not sys.stdin.isatty():
        raw = sys.stdin.readline()
        if not raw:
            raise RestoreError(
                "no passphrase: set NOVA_BACKUP_PASSPHRASE, pass --passphrase-file, "
                "pipe it on stdin, or run interactively"
            )
        if raw.endswith("\n"):
            raw = raw[:-1]
    else:
        raw = getpass.getpass("Backup passphrase: ")
    out = []
    for candidate in (raw.strip(), raw):
        if candidate and candidate not in out:
            out.append(candidate)
    if not out:
        raise RestoreError("an empty passphrase is not a passphrase")
    return out


# ── main ────────────────────────────────────────────────────────────────────


def main():
    ap = argparse.ArgumentParser(description="Open a Nova backup bundle without a running Nova.")
    ap.add_argument("bundle", help="nova-backup-<host>-<stamp>.tar")
    ap.add_argument(
        "--out", default=None, help="output directory (default: ./nova-restored-<stamp>)"
    )
    ap.add_argument(
        "--verify-only",
        action="store_true",
        help="decrypt and check every member against the manifest, then write nothing",
    )
    ap.add_argument(
        "--kat",
        action="store_true",
        help="prove this machine's decryptor and this passphrase, and stop",
    )
    ap.add_argument("--passphrase-file", default=None)
    args = ap.parse_args()

    # Everything this writes — .env, the signing key, the dumps — is exactly
    # what the bundle was encrypted to protect, so nothing it creates is ever
    # group- or world-readable. First statement, before anything is opened.
    os.umask(0o077)

    if not os.path.isfile(args.bundle):
        sys.stderr.write(f"ERROR: no such file: {args.bundle}\n")
        return 2

    decrypt, backend = gcm_backend()
    sys.stderr.write(f"backend: {backend}\n")
    blobs = open_outer(args.bundle)

    mine = None
    passphrase = None
    for candidate in passphrase_candidates(args):
        mine = kat_fingerprint(blobs, candidate)
        try:
            kat_gate(blobs, candidate, decrypt)
        except CryptoError:
            continue
        passphrase = candidate
        break
    if passphrase is None:
        sys.stderr.write(f"ERROR: {_refusal_with_fingerprint(blobs, mine)}\n")
        return 1
    print(f"known-answer test passed: this passphrase opens this bundle ({mine})")

    if args.kat:
        return 0

    if args.verify_only:
        work = tempfile.mkdtemp(prefix="nova-verify-")
        try:
            return _verify_only(args.bundle, passphrase, decrypt, work)
        finally:
            rmtree(work)

    out = args.out or "nova-restored-{}".format(time.strftime("%Y%m%d%H%M%S"))
    if os.path.isdir(out) and os.listdir(out):
        sys.stderr.write(
            f"ERROR: {out} exists and is not empty — refusing to mix a restore into it\n"
        )
        return 2
    if not os.path.isdir(out):
        os.makedirs(out)
    try:
        return _restore(args.bundle, passphrase, decrypt, out)
    except BaseException:
        # A failed restore must not leave half-decrypted credentials on disk
        # under a name that looks finished. `out` was empty or absent at
        # entry, so everything in it is ours.
        try:
            rmtree(out)
        except OSError:
            sys.stderr.write(
                f"WARNING: could not clean up {out} — it may hold decrypted credentials; "
                "remove it by hand\n"
            )
        raise


def _open_payload(bundle, passphrase, decrypt, work):
    with open_outer_tar(bundle) as tar:
        safe_extract(tar, work, members=[tar.getmember(OUTER_PAYLOAD)])
    payload = os.path.join(work, OUTER_PAYLOAD)
    inner = os.path.join(work, "inner.tgz")
    with open(payload, "rb") as fin, open(inner, "wb") as fout:
        decrypt_stream(fin, fout, passphrase, decrypt)
    os.unlink(payload)
    root = os.path.join(work, "inner")
    os.makedirs(root)
    try:
        with tarfile.open(inner, "r:gz") as tar:
            # ONE scan, from offset 0, and the manifest read out of the list
            # it produced. `tar.next()` followed by `tar.members = []` and a
            # re-scan resumes from the CURRENT offset, so MANIFEST.json was
            # not among the members safe_extract wrote: --out landed every
            # member except the one that says what they are, and the
            # placement guard that would have said so could never fire
            # (measured by T4 against a real bundle).
            everything = tar.getmembers()
            first = everything[0] if everything else None
            if first is None or first.name != INNER_MANIFEST:
                raise RestoreError(
                    "the inner archive's first member is {}, and a Nova bundle forces {}".format(
                        "nothing" if first is None else repr(first.name), INNER_MANIFEST
                    )
                )
            handle = tar.extractfile(first)
            manifest = json.loads(handle.read().decode("utf-8"))
            members = safe_extract(tar, root, members=everything)
            archived = {m.name: tar_member_record(m) for m in members}
            unowned = owner_gap(members)
    except (RestoreError, CryptoError):
        raise
    except Exception as exc:
        # A truncated gzip raises EOFError, which is neither TarError nor
        # OSError; a narrower catch turns "corrupt" into an uncaught crash.
        raise RestoreError(
            f"the inner archive could not be read: {type(exc).__name__}: {exc}"
        ) from exc
    os.unlink(inner)
    return root, manifest, archived, unowned


def _ownership_line(unowned):
    """What this run did about uid/gid, in one paragraph, always printed.

    Never "verified" over a tree whose ownership nobody restored: if this
    reader could not chown, that is a CANNOT it states, with what does set
    them. It is not a failure — the content is right, and `./install
    restore` applies the sealed listing's owner columns when it fills each
    volume — but an operator who is handed this tree and told nothing would
    hand his services files they cannot read.
    """
    if running_as_root():
        return (
            "ownership: restored from the archive's recorded numeric uid/gid, and compared "
            "against the sealed listing (this reader is running as root)."
        )
    me = f"{os.geteuid()}:{os.getegid()}"
    if not unowned:
        return (
            f"ownership: every entry in this bundle recorded {me}, which is who this reader "
            "is running as, so what landed is what was backed up."
        )
    return (
        f"ownership: NOT restored, and NOT compared. This reader is running as uid "
        f"{os.geteuid()} and cannot chown, so everything here is owned by {me} — "
        f"{len(unowned)} of the entries in this bundle recorded a different owner (for "
        f"example `{unowned[0]}`). Their type, mode and content ARE what was backed up "
        "and were checked. `./install restore` sets each entry's owner from the sealed "
        "listing when it fills the volume; by hand, re-run this reader as root."
    )


COMMIT_RE = re.compile(r"^[0-9a-f]{7,40}$")


def _recorded_commit(manifest):
    """The commit this bundle was written from, or the words that stand in.

    It goes into a line the operator is told to act on — `check out X` —
    and, like every other value here, it comes out of the file being opened.
    Every path-shaped value in this manifest is shape-checked before it is
    used; a value that ends up in a command an operator pastes is the same
    class, and s41/rulings.md settled it for the images.
    """
    value = manifest.get("source", {}).get("repo_sha")
    if isinstance(value, str) and COMMIT_RE.match(value):
        return value
    return "the recorded commit"


def check_manifest_paths(manifest):
    """Every path-shaped value the manifest carries, or a refusal.

    Run by BOTH verifiers, before either prints a word. `--verify-only` used
    to say yes to a bundle `novabundle verify` said no to, because it never
    looked at `restore_to` — two verifiers disagreeing about the same file is
    worse than either of them being wrong, since the operator will believe
    whichever one agrees with him.
    """
    for row in manifest.get("members", []):
        _relative(row.get("path"), "a member path")
        _restore_to(row.get("restore_to"))
    for row in manifest.get("volumes", []):
        _relative(row.get("prefix"), "a volume prefix")
        _relative(row.get("listing_member"), "a listing member")
        _restore_to(row.get("restore_to"))
    for row in manifest.get("files", []):
        _relative(row.get("member"), "a file member")
        _restore_to(row.get("restore_to"))
    for row in manifest.get("databases", []):
        for field in ("dump_member", "counts_member", "migrations_member"):
            _relative(row.get(field), f"a database {field}")


def _restore_to(value):
    """The three legal forms of §5.3, and nothing else."""
    if isinstance(value, str) and value.startswith("volume:"):
        return _volume_name(value)
    if isinstance(value, str) and value.startswith("db:"):
        return value
    return _relative(value)


def _verify_only(bundle, passphrase, decrypt, work):
    root, manifest, archived, unowned = _open_payload(bundle, passphrase, decrypt, work)
    check_manifest_paths(manifest)
    problems = verify_extracted(root, manifest, archived)
    if problems:
        sys.stderr.write("VERIFICATION FAILED — this bundle cannot be trusted:\n")
        for problem in problems:
            sys.stderr.write(f"  {problem}\n")
        return 1
    members = len(manifest.get("members", []))
    volumes = len(manifest.get("volumes", []))
    databases = len(manifest.get("databases", []))
    print(
        f"verified: {members} members, {volumes} volumes, {databases} databases, all "
        f"matching the manifest sealed inside"
    )
    print(_ownership_line(unowned))
    return 0


def _restore(bundle, passphrase, decrypt, out):
    work = os.path.join(out, ".work")
    os.makedirs(work)
    root, manifest, archived, unowned = _open_payload(bundle, passphrase, decrypt, work)
    # BEFORE the word "verified" is printed, not after: the placement checks
    # used to run later, so an escaping bundle got `verified: 7 members match
    # their checksums` on stdout and only then refused.
    check_manifest_paths(manifest)
    problems = verify_extracted(root, manifest, archived)
    if problems:
        sys.stderr.write("VERIFICATION FAILED — this restore cannot be trusted:\n")
        for problem in problems:
            sys.stderr.write(f"  {problem}\n")
        # No next steps at all: a failed verify must never read as a partial
        # success.
        return 1
    members = len(manifest.get("members", []))
    print(f"verified: {members} members match their checksums")
    print(_ownership_line(unowned))

    placed = []
    for row in manifest.get("members", []):
        src = os.path.join(root, row["path"].rstrip("/"))
        if row["kind"] == "tree":
            dst = os.path.join(out, "volumes", _volume_name(row["restore_to"]))
        elif row["kind"] in ("db", "counts", "migrations"):
            dst = os.path.join(out, "db", os.path.basename(row["path"]))
        elif row["kind"] == "listing":
            dst = os.path.join(out, "listings", os.path.basename(row["path"]))
        elif row["kind"] == "env":
            # The carried KEY SET, not a file to drop over deploy/.env —
            # `./install restore` builds a plan from it and prints the key
            # names it replaces. Kept out of project/ so it can never collide
            # with a carried deploy/.env file member.
            dst = os.path.join(out, "env", os.path.basename(row["path"]))
        else:
            dst = os.path.join(out, "project", _relative(row["restore_to"]))
        if row["kind"] != "tree" and os.path.islink(src):
            # Placement moves a member to a path of a DIFFERENT depth, and a
            # relative symlink target is resolved from where the link sits —
            # so a link that was contained inside the archive can point
            # outside once it has been placed. A tree moves whole, at the
            # same depth, so its internal links keep meaning what they meant;
            # a single member does not, and a bundle this tool writes never
            # has one (plan() records regular files).
            raise RestoreError(
                f"this bundle's manifest places {row['path']!r}, which is a symlink. A link "
                "moved to a different depth stops meaning what the archive checked. Nothing "
                "is placed from a manifest this reader does not trust."
            )
        _must_stay_inside(out, dst)
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        os.rename(src, dst)
        placed.append(os.path.relpath(dst, out))
    # The manifest LAST and unconditionally: every decision `./install
    # restore` makes reads this file, and the closing text below sends the
    # operator at that verb. A guard here that skipped it when it was
    # missing is how it went missing from every restore for a whole slice —
    # if it is not there, this run did not do what it is about to print.
    carried = os.path.join(root, INNER_MANIFEST)
    if not os.path.isfile(carried):
        raise RestoreError(
            f"{INNER_MANIFEST} was verified inside this bundle and is not in what was "
            "extracted — refusing to leave an opened bundle without the file that says "
            "what is in it."
        )
    os.rename(carried, os.path.join(out, INNER_MANIFEST))
    placed.append(INNER_MANIFEST)
    rmtree(work)

    print(f"\nOpened into {out}/:")
    for path in sorted(placed):
        print(f"  {path}")
    if manifest.get("excluded"):
        print("\nThis bundle does NOT contain (recorded when it was written):")
        for row in manifest["excluded"]:
            print("  {} {} — {}".format(row["kind"], row["name"], row["reason"]))
    print(
        f"""
Next, on this machine, in order:

  1. git clone https://github.com/jeremyspofford/nova ~/workspace/nova
     and check out {_recorded_commit(manifest)}, the commit this bundle was written from.
  2. ./install restore {os.path.abspath(bundle)}
     — that is the verified path: it creates the volumes with the labels
       compose needs, restores each database THROUGH the postgres container
       (so client and server versions can never disagree), diffs every volume
       listing, and compares every table's count and digest against the
       numbers sealed in this bundle.

What you have here is the decrypted CONTENT. `./install restore` is what
turns it back into a running Nova, and it is the only path that verifies what
it did."""
    )
    return 0


EXIT_NO_BACKEND = 4

if __name__ == "__main__":
    try:
        sys.exit(main())
    except NoBackend as exc:
        sys.stderr.write(f"ERROR: {exc}\n")
        sys.exit(EXIT_NO_BACKEND)
    except (RestoreError, CryptoError) as exc:
        sys.stderr.write(f"ERROR: {exc}\n")
        sys.exit(1)
