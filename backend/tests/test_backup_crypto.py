"""An encrypted bundle must open with the passphrase and NOTHING else, and
must refuse to half-open for anything less (roadmap #31, disaster recovery).

    docker compose exec backend python tests/test_backup_crypto.py

Offline: no database, no settings — the format is pure mechanism and is
tested as one. Three parties must agree byte-for-byte, and all three are
here: backup_crypto (the writer), the standalone scripts/nova_restore.py
(the reader a disaster actually uses, exercised as a SUBPROCESS the way a
stranded operator would run it), and the ctypes/OpenSSL fallback inside
that script (the reader a machine without `cryptography` uses).

The failure this defends against is specific to backups: nobody reads an
encrypted bundle until the original is gone, so a truncation, a bit flip,
or a passphrase typo must be a loud refusal YEARS later, not a quietly
shorter archive.
"""

import importlib.util
import json
import os
import secrets
import stat
import struct
import subprocess
import sys
import tarfile
import tempfile
from pathlib import Path

sys.path.insert(0, "/app/backend")

from app import backup_crypto as bc                          # noqa: E402
from app import backup_restore as br                         # noqa: E402
from app import backup_snapshot as bs                        # noqa: E402

FAILURES: list[str] = []


def check(label, cond, detail=""):
    print(f"  {'PASS' if cond else 'FAIL'}  {label}"
          + (f"   [{detail}]" if detail else ""))
    if not cond:
        FAILURES.append(label)


def find_script() -> Path:
    for root in (Path(os.environ.get("NOVA_PROJECT_DIR", "/app/project")),
                 Path(__file__).resolve().parents[2]):
        cand = root / "scripts" / "nova_restore.py"
        if cand.is_file():
            return cand
    raise SystemExit("scripts/nova_restore.py not found from this checkout")


SCRIPT = find_script()


def load_script_module():
    spec = importlib.util.spec_from_file_location("nova_restore", SCRIPT)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def fake_pg_dump(tmp: Path) -> str:
    p = tmp / "pg_dump"
    p.write_text("#!/bin/sh\nfor a in \"$@\"; do\n"
                 "  case $prev in -f) out=$a;; esac\n  prev=$a\ndone\n"
                 "printf 'PGDMP-fake-dump-contents' > \"$out\"\n")
    p.chmod(p.stat().st_mode | stat.S_IEXEC)
    return str(p)


def main() -> int:                                           # noqa: PLR0915
    tmp = Path(tempfile.mkdtemp(prefix="nova-crypto-test-"))
    phrase = bc.generate_passphrase()

    print("1. the format round-trips, in chunks, at every awkward size")
    for label, size in [("empty", 0), ("one byte", 1),
                        ("one chunk exactly", 1024),
                        ("several chunks", 3 * 1024 + 17)]:
        src = tmp / "plain.bin"
        src.write_bytes(secrets.token_bytes(size))
        enc, dec = tmp / "enc.bin", tmp / "dec.bin"
        bc.encrypt_file(src, enc, phrase, chunk=1024)
        bc.decrypt_file(enc, dec, phrase)
        check(f"{label} ({size} B) survives the round trip",
              dec.read_bytes() == src.read_bytes())

    src = tmp / "plain.bin"
    src.write_bytes(secrets.token_bytes(10 * 1024))
    enc = tmp / "enc.bin"
    bc.encrypt_file(src, enc, phrase, chunk=1024)

    print("\n2. everything less than the passphrase is a refusal")
    def refuses(label, path, passphrase=phrase):
        try:
            bc.decrypt_file(path, tmp / "never.bin", passphrase)
            check(label, False, "decrypted without complaint")
        except bc.CryptoError:
            check(label, True)

    refuses("a wrong passphrase", enc, passphrase="not-the-passphrase")
    blob = enc.read_bytes()

    cut = tmp / "cut.bin"
    cut.write_bytes(blob[:len(blob) // 2])
    refuses("a file cut mid-frame", cut)

    # surgically drop the FINAL frame: this is the truncation that a naive
    # per-chunk format accepts silently, and the final-flag AAD refuses
    frames, off = [], len(bc.MAGIC) + 4 + struct.unpack(
        ">I", blob[len(bc.MAGIC):len(bc.MAGIC) + 4])[0]
    head, pos = blob[:off], off
    while pos < len(blob):
        clen = struct.unpack(">I", blob[pos:pos + 4])[0]
        frames.append(blob[pos:pos + 4 + clen])
        pos += 4 + clen
    neat = tmp / "neat-truncation.bin"
    neat.write_bytes(head + b"".join(frames[:-1]))
    refuses("a WHOLE trailing chunk removed (frame-aligned truncation)", neat)

    swapped = tmp / "swapped.bin"
    swapped.write_bytes(head + b"".join(
        [frames[1], frames[0]] + frames[2:]))
    refuses("two chunks swapped in place", swapped)

    flip = bytearray(blob)
    flip[off + 10] ^= 0x01
    flipped = tmp / "flipped.bin"
    flipped.write_bytes(bytes(flip))
    refuses("a single flipped ciphertext bit", flipped)

    hdr = json.loads(blob[len(bc.MAGIC) + 4:off].decode())
    hdr["n"] = hdr["n"] // 2            # weaken the KDF: header tamper
    hb = json.dumps(hdr, separators=(",", ":"), sort_keys=True).encode()
    tampered = tmp / "tampered-header.bin"
    tampered.write_bytes(bc.MAGIC + struct.pack(">I", len(hb)) + hb
                         + blob[off:])
    refuses("a tampered header (KDF weakened)", tampered)

    hdr["n"] = 1 << 30                  # absurd cost: must refuse BEFORE paying
    hb = json.dumps(hdr, separators=(",", ":"), sort_keys=True).encode()
    absurd = tmp / "absurd-header.bin"
    absurd.write_bytes(bc.MAGIC + struct.pack(">I", len(hb)) + hb + blob[off:])
    try:
        bc.read_header(absurd)
        check("absurd KDF cost is refused before any memory is spent", False)
    except bc.CryptoError:
        check("absurd KDF cost is refused before any memory is spent", True)

    # every header fault must be the SAME verdict — CryptoError — never a
    # bare ValueError/KeyError leaking hashlib's opinion of a tampered file
    def hdr_variant(label, **changes):
        h2 = json.loads(blob[len(bc.MAGIC) + 4:off].decode())
        h2.update(changes)
        for k, v in list(changes.items()):
            if v is None:
                del h2[k]
        b2 = json.dumps(h2, separators=(",", ":"), sort_keys=True).encode()
        p2 = tmp / "variant.bin"
        p2.write_bytes(bc.MAGIC + struct.pack(">I", len(b2)) + b2 + blob[off:])
        try:
            bc.decrypt_file(p2, tmp / "never2.bin", phrase)
            check(label, False, "accepted a faulted header")
        except bc.CryptoError:
            check(label, True)
        except Exception as e:  # noqa: BLE001 — the defect this pins
            check(label, False, f"leaked {type(e).__name__}: {e}")

    hdr_variant("n that is not a power of two (one-bit flip)", n=32760)
    hdr_variant("a cost hashlib could never pay under our maxmem",
                n=1 << 18, r=8)
    hdr_variant("a non-hex salt", salt="zz" * 16)
    hdr_variant("a missing salt", salt=None)
    hdr_variant("a wrong-length nonce_prefix", nonce_prefix="aabb")

    print("\n3. the passphrase generator is fit for a piece of paper")
    p1, p2 = bc.generate_passphrase(), bc.generate_passphrase()
    check("format: 8 dash-joined groups of 4",
          len(p1) == 39 and all(len(g) == 4 for g in p1.split("-")))
    check("two calls never agree", p1 != p2)

    print("\n4. an encrypted bundle end to end: create, list, verify, open")
    root = tmp / "state"
    (root / "memory").mkdir(parents=True)
    (root / "memory" / "topic.md").write_text("the topic body")
    (root / ".env").write_text("NOVA_AUTH_TOKEN=sekrit\n")
    coverage = {"may_snapshot": True, "refusals": [], "entries": [
        {"kind": "bind", "name": str(root / "memory"), "included": True,
         "disposition": "include", "reason": "state"},
        {"kind": "bind", "name": str(root / ".env"), "included": True,
         "disposition": "include", "reason": "creds"},
        {"kind": "volume", "name": "ollama_models", "included": False,
         "disposition": "exclude_redownloadable", "reason": "big"},
    ]}
    out_dir = tmp / "bundles"
    man = bs.create(coverage, out_dir=out_dir, dsn="postgresql://x@y/nova",
                    pg_dump=fake_pg_dump(tmp), passphrase=phrase,
                    restore_script=SCRIPT, root_prefix=str(root))
    bundle = Path(man["path"])
    check("the bundle is an OUTER tar, not a gzip",
          bundle.suffix == ".tar" and bs.is_outer_bundle(bundle))
    with tarfile.open(bundle, "r:") as tar:
        names = set(tar.getnames())
    check("it carries its own restore script and README",
          {bs.OUTER_SCRIPT, bs.OUTER_README, bs.OUTER_META,
           bs.OUTER_PAYLOAD} <= names)

    rows = br.list_bundles(out_dir)
    check("it lists WITHOUT the passphrase, marked encrypted",
          rows and rows[0]["encrypted"] and rows[0]["members"] == 3,
          json.dumps(rows and {k: rows[0][k] for k in
                               ("encrypted", "members", "created_at")}))
    import hashlib as _hl
    check("the listing says WHICH passphrase seals the file — rotation "
          "must not orphan bundles invisibly",
          rows and rows[0]["passphrase_fingerprint"]
          == _hl.sha256(phrase.encode()).hexdigest()[:12],
          str(rows and rows[0].get("passphrase_fingerprint")))

    check("verify_bundle round-trips with the passphrase",
          bs.verify_bundle(bundle, phrase) == [])
    bad = bs.verify_bundle(bundle, "wrong-passphrase")
    check("verify_bundle with a wrong passphrase is a refusal, not a crash",
          bool(bad), "; ".join(bad)[:80])

    with bs.open_inner(bundle, phrase) as inner:
        with tarfile.open(inner, "r:gz") as tar:
            inner_manifest = json.loads(
                tar.extractfile(bs.MANIFEST).read().decode())
    hints = {m["path"]: m.get("restore_to") for m in inner_manifest["members"]}
    check("members carry restore_to hints relative to the project root",
          hints.get("db.sql") == "database"
          and any(v == "memory" for v in hints.values())
          and any(v == ".env" for v in hints.values()),
          json.dumps(hints))

    print("\n5. a refused encryption is NO bundle")
    try:
        bs.create(coverage, out_dir=out_dir, dsn="postgresql://x@y/nova",
                  pg_dump=fake_pg_dump(tmp), passphrase=phrase,
                  restore_script=tmp / "no-such-script.py")
        check("a missing restore script refuses the snapshot", False)
    except bs.SnapshotRefused:
        check("a missing restore script refuses the snapshot", True)
    leftovers = [p.name for p in out_dir.iterdir()
                 if p.name.endswith(".part")]
    check("no .part left behind by the refusal", not leftovers)

    print("\n6. the standalone script, run the way a stranded operator would")
    outdir = tmp / "restored"
    env = dict(os.environ, NOVA_BACKUP_PASSPHRASE=phrase)
    r = subprocess.run([sys.executable, str(SCRIPT), str(bundle),
                        "--out", str(outdir)],
                       capture_output=True, text=True, env=env, timeout=120)
    check("exit 0", r.returncode == 0, r.stderr[-200:])
    check("the database dump landed",
          (outdir / "db.sql").read_bytes() == b"PGDMP-fake-dump-contents"
          if (outdir / "db.sql").exists() else False)
    check("the memory tree landed where restore_to said",
          (outdir / "project" / "memory" / "topic.md").is_file()
          and (outdir / "project" / "memory" / "topic.md").read_text()
          == "the topic body")
    check(".env landed beside it",
          (outdir / "project" / ".env").is_file())
    check("it verified before it celebrated", "verified:" in r.stdout)
    check("it printed the docker-side pg_restore instructions",
          "pg_restore" in r.stdout and "docker compose" in r.stdout)

    r2 = subprocess.run([sys.executable, str(SCRIPT), str(bundle),
                         "--out", str(tmp / "restored2")],
                        capture_output=True, text=True,
                        env=dict(os.environ,
                                 NOVA_BACKUP_PASSPHRASE="wrong-one"),
                        timeout=120)
    check("a wrong passphrase exits non-zero and says so",
          r2.returncode != 0 and "passphrase" in (r2.stderr + r2.stdout),
          r2.stderr[-160:])

    r3 = subprocess.run([sys.executable, str(SCRIPT), str(bundle),
                         "--out", str(outdir)],
                        capture_output=True, text=True, env=env, timeout=120)
    check("a non-empty --out is refused before anything is written",
          r3.returncode != 0 and "not empty" in (r3.stderr + r3.stdout))

    fail_out = tmp / "restored-fail"
    r4 = subprocess.run([sys.executable, str(SCRIPT), str(bundle),
                         "--out", str(fail_out)],
                        capture_output=True, text=True,
                        env=dict(os.environ,
                                 NOVA_BACKUP_PASSPHRASE="wrong-one"),
                        timeout=120)
    check("a FAILED restore removes what it decrypted — no credentials "
          "left under a plausible directory name",
          r4.returncode != 0 and not fail_out.exists())

    # a paper transcription gains whitespace; a stored value may carry it.
    # The reader tries stripped first, verbatim second — so BOTH open.
    r5 = subprocess.run([sys.executable, str(SCRIPT), str(bundle),
                         "--out", str(tmp / "restored-ws")],
                        capture_output=True, text=True,
                        env=dict(os.environ,
                                 NOVA_BACKUP_PASSPHRASE=f"  {phrase}\n"),
                        timeout=120)
    check("a passphrase with pasted whitespace still opens the bundle",
          r5.returncode == 0, r5.stderr[-160:])

    # ...and the reverse: a STORED passphrase that itself carries
    # whitespace (the writer uses values verbatim) must also open, via the
    # verbatim candidate after the stripped one fails
    wsphrase = "phrase with a trailing space \n"
    man_ws = bs.create(coverage, out_dir=out_dir,
                       dsn="postgresql://x@y/nova",
                       pg_dump=fake_pg_dump(tmp), passphrase=wsphrase,
                       restore_script=SCRIPT, root_prefix=str(root))
    r6 = subprocess.run([sys.executable, str(SCRIPT), man_ws["path"],
                         "--out", str(tmp / "restored-ws2")],
                        capture_output=True, text=True,
                        env=dict(os.environ,
                                 NOVA_BACKUP_PASSPHRASE=wsphrase),
                        timeout=120)
    check("a STORED passphrase carrying whitespace opens its own bundle",
          r6.returncode == 0, r6.stderr[-160:])

    print("\n7. the ctypes/OpenSSL fallback agrees with `cryptography`")
    nr = load_script_module()
    check("the two implementations share a magic",
          nr.MAGIC == bc.MAGIC and nr.TAG_LEN == bc.TAG_LEN)
    try:
        ossl = nr._openssl_gcm()
        from cryptography.hazmat.primitives.ciphers.aead import AESGCM
        key, nonce, aad = (secrets.token_bytes(32), secrets.token_bytes(12),
                           b"the-aad")
        msg = secrets.token_bytes(5000)
        ct = AESGCM(key).encrypt(nonce, msg, aad)
        check("OpenSSL decrypts what cryptography encrypted",
              ossl(key, nonce, ct, aad) == msg)
        try:
            ossl(key, nonce, ct, b"other-aad")
            check("OpenSSL refuses a wrong AAD", False)
        except nr.RestoreError:
            check("OpenSSL refuses a wrong AAD", True)
        # and the WHOLE payload path, with cryptography masked off
        nr._gcm_backend = lambda: (ossl, "forced ctypes")
        with tarfile.open(bundle, "r:") as tar:
            payload = tmp / "payload.enc"
            payload.write_bytes(tar.extractfile(bs.OUTER_PAYLOAD).read())
        via_ossl = tmp / "via-ossl.tar.gz"
        nr.decrypt_payload(payload, via_ossl, phrase)
        check("the full payload decrypts via ctypes to a verifying archive",
              bs.verify(via_ossl) == [])
    except nr.RestoreError as e:
        check("a usable libcrypto exists on this machine", False, str(e))

    print()
    if FAILURES:
        print(f"{len(FAILURES)} FAILED: {FAILURES}")
        return 1
    print("all checks passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
