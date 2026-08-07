#!/usr/bin/env python3
"""Restore a Nova backup bundle on a machine that has NOTHING but this file,
python3, the bundle, and the passphrase.

    python3 nova_restore.py nova-backup-20260807T030000Z.tar
    python3 nova_restore.py <bundle> --out ./restored
    NOVA_BACKUP_PASSPHRASE=... python3 nova_restore.py <bundle>

Why this script exists (the bootstrap trap): the bundle CONTAINS .env, and
the stack cannot start without .env — so on a fresh machine, restore cannot
go through Nova. This script is committed to the repo AND written into every
bundle it makes, so it travels with the thing it restores.

It is deliberately standalone: no imports from Nova, no third-party
packages required. Decryption uses the `cryptography` package when it is
installed and otherwise calls the system OpenSSL library directly via
ctypes — every Linux machine that can run Docker has libcrypto. The one
machine that may not cooperate is macOS (Apple ships a trap libcrypto);
there, `pip install cryptography` first.

What it does, and does not do:
  1. reads the bundle (encrypted v2 `.tar` or legacy plaintext `.tar.gz`)
  2. decrypts the payload with your passphrase
  3. VERIFIES every member against the manifest's checksums — a backup
     restored without verification is a hope with extra steps
  4. extracts everything into --out, laid out for the repo, and prints the
     exact commands that finish the job (clone, copy, start postgres,
     restore the database THROUGH the postgres container so the client and
     server versions can never disagree — a pg_dump 17 header once made
     every bundle on the original install silently unrestorable on PG16)

It never runs docker itself and never touches an existing installation:
the destructive step stays a human decision, printed and explained.

The NOVAENC1 reading half below mirrors backend/app/backup_crypto.py and is
pinned to it by a round-trip test in the repo (test_backup_crypto.py).
"""

import argparse
import getpass
import gzip
import hashlib
import json
import os
import struct
import sys
import tarfile
import time
from pathlib import Path

MAGIC = b"NOVAENC1"
TAG_LEN = 16
MAX_N, MAX_R, MAX_P = 1 << 18, 16, 4
MAX_CHUNK = 64 * 1024 * 1024

OUTER_META = "meta.json"
OUTER_PAYLOAD = "payload.enc"
MANIFEST = "manifest.json"
DB_MEMBER = "db.sql"


class RestoreError(Exception):
    pass


def _safe_extract(tar, dest, member=None):
    """tarfile with the 'data' filter where python knows it (3.12+), and a
    manual path-traversal check where it does not — this script must run on
    whatever python3 a fresh machine has."""
    members = [tar.getmember(member)] if member else tar.getmembers()
    for m in members:
        target = (Path(dest) / m.name).resolve()
        if not str(target).startswith(str(Path(dest).resolve())):
            raise RestoreError(f"bundle member escapes the target dir: {m.name}")
    try:
        if member:
            tar.extract(member, dest, filter="data")
        else:
            tar.extractall(dest, filter="data")
    except TypeError:                          # python < 3.12: no filter kwarg
        if member:
            tar.extract(member, dest)
        else:
            tar.extractall(dest)


# ── AES-256-GCM, two ways ───────────────────────────────────────────────────

def _gcm_backend():
    """Prefer `cryptography`; fall back to OpenSSL via ctypes.

    Returns decrypt(key, nonce, ciphertext_with_tag, aad) -> plaintext,
    raising RestoreError on authentication failure.
    """
    try:
        from cryptography.hazmat.primitives.ciphers.aead import AESGCM

        def _decrypt(key, nonce, ct, aad):
            try:
                return AESGCM(key).decrypt(nonce, ct, aad)
            except Exception:
                raise RestoreError(_BAD_DECRYPT)
        return _decrypt, "cryptography"
    except ImportError:
        return _openssl_gcm(), "system OpenSSL (ctypes)"


_BAD_DECRYPT = ("decryption failed — wrong passphrase, or the bundle is "
                "corrupt, truncated or tampered with (AES-GCM cannot tell "
                "these apart)")


def _openssl_gcm():
    import ctypes
    import ctypes.util

    candidates = []
    if sys.platform == "darwin":
        # NEVER ctypes.util.find_library here: Apple's stub libcrypto
        # aborts the whole process when called. Only real OpenSSL installs.
        candidates = ["/opt/homebrew/opt/openssl@3/lib/libcrypto.dylib",
                      "/usr/local/opt/openssl@3/lib/libcrypto.dylib"]
    else:
        found = ctypes.util.find_library("crypto")
        if found:
            candidates.append(found)
        candidates += ["libcrypto.so.3", "libcrypto.so.1.1", "libcrypto.so"]

    lib = None
    for cand in candidates:
        try:
            probe = ctypes.CDLL(cand)
            probe.EVP_CIPHER_CTX_new           # noqa: B018 — symbol probe
            lib = probe
            break
        except (OSError, AttributeError):
            continue
    if lib is None:
        raise RestoreError(
            "no usable AES implementation: the `cryptography` package is "
            "not installed and no OpenSSL libcrypto could be loaded. "
            "Run `pip install cryptography` and retry.")

    c = ctypes
    lib.EVP_CIPHER_CTX_new.restype = c.c_void_p
    lib.EVP_CIPHER_CTX_free.argtypes = [c.c_void_p]
    lib.EVP_aes_256_gcm.restype = c.c_void_p
    lib.EVP_DecryptInit_ex.restype = c.c_int
    lib.EVP_DecryptInit_ex.argtypes = [c.c_void_p, c.c_void_p, c.c_void_p,
                                       c.c_char_p, c.c_char_p]
    lib.EVP_CIPHER_CTX_ctrl.restype = c.c_int
    lib.EVP_CIPHER_CTX_ctrl.argtypes = [c.c_void_p, c.c_int, c.c_int,
                                        c.c_void_p]
    lib.EVP_DecryptUpdate.restype = c.c_int
    lib.EVP_DecryptUpdate.argtypes = [c.c_void_p, c.c_char_p,
                                      c.POINTER(c.c_int), c.c_char_p, c.c_int]
    lib.EVP_DecryptFinal_ex.restype = c.c_int
    lib.EVP_DecryptFinal_ex.argtypes = [c.c_void_p, c.c_char_p,
                                        c.POINTER(c.c_int)]
    EVP_CTRL_GCM_SET_IVLEN, EVP_CTRL_GCM_SET_TAG = 0x9, 0x11

    def _decrypt(key, nonce, ct_with_tag, aad):
        ct, tag = ct_with_tag[:-TAG_LEN], ct_with_tag[-TAG_LEN:]
        ctx = lib.EVP_CIPHER_CTX_new()
        if not ctx:
            raise RestoreError("OpenSSL: could not allocate a cipher context")
        try:
            outl = c.c_int(0)
            ok = (lib.EVP_DecryptInit_ex(ctx, lib.EVP_aes_256_gcm(),
                                         None, None, None) == 1
                  and lib.EVP_CIPHER_CTX_ctrl(ctx, EVP_CTRL_GCM_SET_IVLEN,
                                              len(nonce), None) == 1
                  and lib.EVP_DecryptInit_ex(ctx, None, None, key, nonce) == 1)
            if not ok:
                raise RestoreError("OpenSSL: cipher initialisation failed")
            if aad and lib.EVP_DecryptUpdate(ctx, None, c.byref(outl),
                                             aad, len(aad)) != 1:
                raise RestoreError("OpenSSL: could not absorb the AAD")
            out = c.create_string_buffer(max(len(ct), 1))
            outl = c.c_int(0)
            if ct and lib.EVP_DecryptUpdate(ctx, out, c.byref(outl),
                                            ct, len(ct)) != 1:
                raise RestoreError("OpenSSL: decrypt update failed")
            plain = out.raw[:outl.value]
            if lib.EVP_CIPHER_CTX_ctrl(ctx, EVP_CTRL_GCM_SET_TAG,
                                       TAG_LEN, c.c_char_p(tag)) != 1:
                raise RestoreError("OpenSSL: could not set the GCM tag")
            fin = c.c_int(0)
            tail = c.create_string_buffer(TAG_LEN)
            if lib.EVP_DecryptFinal_ex(ctx, tail, c.byref(fin)) != 1:
                # the authentication check — this is where a wrong
                # passphrase, a flipped bit or a truncation is caught
                raise RestoreError(_BAD_DECRYPT)
            return plain + tail.raw[:fin.value]
        finally:
            lib.EVP_CIPHER_CTX_free(ctx)

    return _decrypt


# ── the NOVAENC1 container (reader; mirrors backup_crypto.py) ───────────────

def decrypt_payload(src: Path, dst: Path, passphrase: str) -> None:
    decrypt, backend = _gcm_backend()
    print(f"  decrypting with {backend} ...")
    with open(src, "rb") as f:
        if f.read(len(MAGIC)) != MAGIC:
            raise RestoreError(f"{src.name} is not a NOVAENC1 payload")
        raw = f.read(4)
        if len(raw) != 4:
            raise RestoreError("truncated before the header")
        hlen = struct.unpack(">I", raw)[0]
        if hlen > 4096:
            raise RestoreError("implausible header size — corrupt bundle")
        hbytes = f.read(hlen)
        if len(hbytes) != hlen:
            raise RestoreError("truncated inside the header")
        # every header-derived value is attacker-writable until the first
        # chunk authenticates, so each is validated as a REFUSAL — a bare
        # ValueError from hashlib is a traceback where a stranded operator
        # needs the sentence "this bundle is corrupt or tampered with"
        try:
            header = json.loads(hbytes.decode("utf-8"))
            if header.get("v") != 1 or header.get("cipher") != "aes-256-gcm" \
                    or header.get("kdf") != "scrypt":
                raise RestoreError(f"unsupported payload format: {header}")
            n, r, p = header["n"], header["r"], header["p"]
            if not (0 < n <= MAX_N and 0 < r <= MAX_R and 0 < p <= MAX_P
                    and (n & (n - 1)) == 0
                    and 128 * r * n <= 128 * 1024 * 1024
                    and 0 < header["chunk"] <= MAX_CHUNK):
                raise RestoreError("implausible KDF/chunk parameters — the "
                                   "header may be tampered with")
            salt = bytes.fromhex(header["salt"])
            prefix = bytes.fromhex(header["nonce_prefix"])
            if len(salt) != 16 or len(prefix) != 4:
                raise RestoreError("header salt/nonce are the wrong size — "
                                   "corrupt or tampered")
            key = hashlib.scrypt(passphrase.encode("utf-8"), salt=salt,
                                 n=n, r=r, p=p, maxmem=256 * 1024 * 1024,
                                 dklen=32)
        except RestoreError:
            raise
        except Exception as e:
            raise RestoreError(f"unusable payload header — corrupt or "
                               f"tampered ({type(e).__name__}: {e})")

        def read_frame():
            raw = f.read(4)
            if not raw:
                return None
            if len(raw) != 4:
                raise RestoreError("bundle truncated mid-frame")
            clen = struct.unpack(">I", raw)[0]
            if not (TAG_LEN <= clen <= header["chunk"] + TAG_LEN):
                raise RestoreError(f"implausible frame of {clen} bytes")
            ct = f.read(clen)
            if len(ct) != clen:
                raise RestoreError("bundle truncated inside a frame")
            return ct

        with open(dst, "wb") as out:
            index = 0
            frame = read_frame()
            if frame is None:
                raise RestoreError("no ciphertext at all — truncated bundle")
            while frame is not None:
                nxt = read_frame()
                final = nxt is None
                aad = (MAGIC + hbytes + struct.pack(">Q", index)
                       + (b"\x01" if final else b"\x00"))
                nonce = prefix + struct.pack(">Q", index)
                out.write(decrypt(key, nonce, frame, aad))
                frame, index = nxt, index + 1


# ── verification (mirrors backup_snapshot.py's hashing exactly) ─────────────

def _sha256_file(path: Path) -> tuple:
    h, n = hashlib.sha256(), 0
    with open(path, "rb") as f:
        while True:
            b = f.read(1 << 20)
            if not b:
                break
            h.update(b)
            n += len(b)
    return h.hexdigest(), n


def _sha256_tree(root: Path) -> tuple:
    h, total = hashlib.sha256(), 0
    for p in sorted(root.rglob("*")):
        if not p.is_file() or p.is_symlink():
            continue
        h.update(str(p.relative_to(root)).encode())
        digest, n = _sha256_file(p)
        h.update(digest.encode())
        total += n
    return h.hexdigest(), total


def verify_extracted(root: Path, manifest: dict) -> list:
    problems = []
    for m in manifest.get("members", []):
        p = root / m["path"]
        if not p.exists():
            problems.append(f"{m['path']}: named in the manifest, absent "
                            f"from the archive")
            continue
        digest, _ = (_sha256_tree(p) if m["kind"] == "tree"
                     else _sha256_file(p))
        if digest != m["sha256"]:
            problems.append(f"{m['path']}: content does not match its "
                            f"recorded checksum")
    return problems


# ── main flow ───────────────────────────────────────────────────────────────

def get_passphrase(args) -> str:
    """RAW, not stripped. The writer stores whatever was set, whitespace
    included, so the decrypt loop tries the stripped form first (a paper
    transcription usually gains whitespace) and the verbatim form second
    (a stored value may legitimately carry it)."""
    if args.passphrase_file:
        return Path(args.passphrase_file).read_text()
    env = os.environ.get("NOVA_BACKUP_PASSPHRASE", "")
    if env:
        return env
    if not sys.stdin.isatty():
        raise RestoreError(
            "no passphrase: set NOVA_BACKUP_PASSPHRASE, pass "
            "--passphrase-file, or run interactively")
    return getpass.getpass("Backup passphrase: ")


def main() -> int:
    ap = argparse.ArgumentParser(
        description="Restore a Nova backup bundle without a running Nova.")
    ap.add_argument("bundle", help="nova-backup-*.tar (or legacy .tar.gz)")
    ap.add_argument("--out", default=None,
                    help="output directory (default: ./nova-restored-<stamp>)")
    ap.add_argument("--passphrase-file", default=None,
                    help="file holding the passphrase (else "
                         "$NOVA_BACKUP_PASSPHRASE, else an interactive prompt)")
    args = ap.parse_args()

    # everything this writes — .env, the secrets master key, the database
    # dump — is exactly what the bundle was encrypted to protect, so nothing
    # it creates is ever group- or world-readable
    os.umask(0o077)

    bundle = Path(args.bundle)
    if not bundle.exists():
        print(f"ERROR: no such file: {bundle}", file=sys.stderr)
        return 2
    out = Path(args.out or f"nova-restored-{time.strftime('%Y%m%d%H%M%S')}")
    if out.exists() and any(out.iterdir()):
        print(f"ERROR: {out} exists and is not empty — refusing to mix a "
              f"restore into it", file=sys.stderr)
        return 2
    out.mkdir(parents=True, exist_ok=True)
    work = out / ".work"
    work.mkdir()
    try:
        return _restore(args, bundle, out, work)
    except BaseException:
        # a failed restore must not leave half-decrypted credentials on
        # disk under a name that looks done — remove what we created
        # (out was empty or absent at entry, so everything in it is ours)
        try:
            _rmdir_tree(out)
        except OSError:
            print(f"WARNING: could not clean up {out} — it may hold "
                  f"decrypted credentials; remove it by hand",
                  file=sys.stderr)
        raise


def _restore(args, bundle: Path, out: Path, work: Path) -> int:

    # 1. unwrap: encrypted v2 outer tar, or legacy plaintext tar.gz
    with open(bundle, "rb") as f:
        head = f.read(2)
    if head == b"\x1f\x8b":
        print(f"{bundle.name}: legacy UNENCRYPTED bundle")
        inner = bundle
        meta = {}
    else:
        with tarfile.open(bundle, "r:") as tar:
            names = tar.getnames()
            if OUTER_PAYLOAD not in names:
                raise RestoreError(
                    f"{bundle.name} has no {OUTER_PAYLOAD} — not a Nova "
                    f"bundle this script understands (members: {names[:8]})")
            meta = json.loads(tar.extractfile(OUTER_META).read().decode()) \
                if OUTER_META in names else {}
            print(f"{bundle.name}: encrypted bundle, created "
                  f"{meta.get('created_at', '?')}")
            _safe_extract(tar, work, member=OUTER_PAYLOAD)
        raw = get_passphrase(args)
        inner = work / "inner.tar.gz"
        candidates = list(dict.fromkeys([raw.strip(), raw]))
        for i, candidate in enumerate(candidates):
            try:
                decrypt_payload(work / OUTER_PAYLOAD, inner, candidate)
                break
            except RestoreError:
                if i == len(candidates) - 1:
                    raise
        (work / OUTER_PAYLOAD).unlink()          # reclaim ~200 MB early
        print("  decrypted OK (authentication passed)")

    # 2. extract + verify against the manifest
    print("extracting ...")
    with tarfile.open(inner, "r:gz") as tar:
        manifest = json.loads(tar.extractfile(MANIFEST).read().decode())
        _safe_extract(tar, work)
    problems = verify_extracted(work, manifest)
    if problems:
        print("VERIFICATION FAILED — this restore cannot be trusted:",
              file=sys.stderr)
        for p in problems:
            print(f"  {p}", file=sys.stderr)
        return 1
    print(f"  verified: {len(manifest.get('members', []))} members match "
          f"their checksums")

    # 3. lay out for the repo, using the restore_to hints the snapshot wrote
    repo_root = out / "project"
    volumes = out / "volumes"
    db_dump = out / DB_MEMBER
    placed = []
    for m in manifest.get("members", []):
        src = work / m["path"]
        dest_hint = m.get("restore_to", "")
        if m["kind"] == "db":
            src.rename(db_dump)
            continue
        if dest_hint.startswith("volume:"):
            dst = volumes / dest_hint.split(":", 1)[1]
        elif dest_hint:
            dst = repo_root / dest_hint
        else:
            dst = repo_root / "_unmapped" / m["path"]   # old bundle: no hint
        dst.parent.mkdir(parents=True, exist_ok=True)
        src.rename(dst)
        placed.append(str(dst.relative_to(out)))
    (work / MANIFEST).rename(out / MANIFEST)
    for leftover in [work / "inner.tar.gz"]:
        if leftover.exists():
            leftover.unlink()
    _rmdir_tree(work)

    # 4. say exactly what comes next — and what this bundle CANNOT do
    print(f"\nRestored into {out}/:")
    print(f"  {DB_MEMBER}      the database (pg_dump custom format)")
    for p in placed:
        print(f"  {p}")
    if manifest.get("excluded"):
        print("\nThis bundle does NOT contain "
              "(recorded at snapshot time):")
        for e in manifest["excluded"]:
            if e["disposition"] == "exclude_declined":
                print(f"  {e['name']}")
    env_restored = (repo_root / ".env").exists()
    env_note = ("(.env came from the bundle)" if env_restored else
                "THEN supply .env by hand — this bundle does not carry "
                "credentials.")
    print(f"""
Next steps on the new machine (run them yourself, in order):

  1. git clone https://github.com/jeremyspofford/nova ~/workspace/nova
  2. cp -a {out}/project/. ~/workspace/nova/
     {env_note}
  3. Volumes, if present under {out}/volumes/ (nova_state holds the secrets
     master key — without it, stored secrets stay sealed):
       docker volume create nova_state
       docker run --rm -v nova_state:/state -v {out}/volumes/nova_state:/src:ro \\
           alpine sh -c 'cp -a /src/. /state/'
     (same pattern for tailscale_state)
  4. cd ~/workspace/nova && docker compose up -d postgres
  5. Restore the database THROUGH the postgres container — its pg_restore
     always matches its server, which a host client may not:
       docker compose cp {out}/{DB_MEMBER} postgres:/tmp/db.dump
       docker compose exec postgres pg_restore --exit-on-error --no-owner \\
           --no-acl -U nova -d nova /tmp/db.dump
       docker compose exec postgres rm /tmp/db.dump
     (If 'nova' is not empty — a fresh compose boot creates it empty — drop
      and recreate it first: psql -U nova -d postgres -c
      'DROP DATABASE nova' && psql -U nova -d postgres -c
      'CREATE DATABASE nova')
  6. docker compose up -d   (migrations run forward at backend startup)
  7. Open the app and check: conversations present, memory present,
     Settings -> Backups green.
""")
    return 0


def _rmdir_tree(root: Path) -> None:
    for p in sorted(root.rglob("*"), reverse=True):
        p.rmdir() if p.is_dir() else p.unlink()
    root.rmdir()


if __name__ == "__main__":
    try:
        sys.exit(main())
    except RestoreError as e:
        print(f"ERROR: {e}", file=sys.stderr)
        sys.exit(1)
