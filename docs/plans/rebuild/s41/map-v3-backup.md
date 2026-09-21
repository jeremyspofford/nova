# Map: v3's built encrypted backup system, for S41 to mine

Read-only. Covers all nine files named in the S41 task, in full (no skimming):
`backend/app/backup_service.py` (721 lines), `backup_coverage.py` (695),
`backup_snapshot.py` (500), `backup_crypto.py` (245), `backup_passphrase.py`
(239), `backup_inventory.py` (251), `backup_apply.py` (340),
`backup_restore.py` (294), `scripts/nova_restore.py` (512) — 3,797 lines
total. Every claim below carries `path:line` against this worktree.
Grounding checks against v4's actual tree (`deploy/docker-compose.yml`,
`services/core/app/migrations_runner.py`, `services/core/app/settings_store.py`,
`services/core/app/scheduler.py`, and greps across `services/`) are cited the
same way.

This document reads [`rulings.md`](rulings.md) and
[`map-requirements.md`](map-requirements.md) as binding context but does not
repeat their conclusions; it is the source-level map those documents asked
for.

---

## 1. The bundle format, end to end

**Two nested archives.** The *inner* archive is the payload; the *outer*
archive exists only for encrypted bundles and wraps the inner one plus the
means to open it.

**Inner archive** (`backup_snapshot.py:293-311`): a `tar.gz` built in a
tempdir, member order forced so `manifest.json` is written **first**
(`backup_snapshot.py:298-305`) — gzip cannot seek, so listing a bundle means
decompressing everything before the member you want; sorted-alphabetical
order put `manifest.json` after `db.sql` and `files/`, and listing a 167 MB
bundle measured at 3.4s decompressing almost all of it before this was
forced. Members after the manifest: `db.sql` (the `pg_dump -Fc` output,
`backup_snapshot.py:47,236-240`), then `files/<host-path>` for each included
bind (`backup_snapshot.py:258,266-278`), then `volumes/<name>` for each
included named volume (`backup_snapshot.py:256`).

**Outer archive**, only when a passphrase is given (`backup_snapshot.py:54-70`):
a plain uncompressed `tar` (`backup_snapshot.py:357`) — uncompressed and
partly cleartext on purpose, so a machine with nothing but `python3` can
always read the first two members without the passphrase:

| member | cleartext? | purpose |
|---|---|---|
| `README.txt` | yes | one paragraph for whoever finds the file (`backup_snapshot.py:72-91`) |
| `nova_restore.py` | yes | the standalone restore script, copied in from the checkout (`backup_snapshot.py:69,132-133` in `backup_service.py`, written at `backup_snapshot.py:360`) |
| `meta.json` | yes, **unauthenticated** | advisory listing facts so Settings can list bundles without the key (`backup_snapshot.py:63-66,336-354`) |
| `payload.enc` | no | the real bundle (the inner `tar.gz`), AES-GCM (`backup_snapshot.py:68,332-334`) |

`meta.json`'s fields: `outer_version`, `encrypted`, `created_at`,
`bundle_version`, `members` (count), `included`/`excluded` (origins/names),
`bytes_inner`, `passphrase_fingerprint` (`backup_snapshot.py:336-352`).
Anything that *decides* a restore is re-read from the authenticated manifest
inside the payload, never from `meta.json` (`backup_snapshot.py:65-66`).

**`MANIFEST` (`manifest.json`) fields** (`backup_snapshot.py:280-291`):
`bundle_version` (int, currently `1`, `backup_snapshot.py:52`), `created_at`
(a `%Y%m%dT%H%M%SZ` stamp, also the filename's timestamp,
`backup_snapshot.py:198-199,208-212`), `members` (list of `Member.as_dict()`),
`excluded` (list of `{name, disposition, reason}` for everything coverage
decided to leave out — "a restore that cannot say what it is missing invites
the operator to assume it is missing nothing," `backup_snapshot.py:284-289`).

**`Member` fields** (`backup_snapshot.py:98-116`): `path` (inside the
bundle), `origin` (where it came from on this machine), `kind`
(`"tree"|"file"|"db"`), `bytes`, `sha256`, and `restore_to` — a hint like
`"data/memory"`, `".env"`, or `"volume:nova_state"`, written by the *writer*
because only it knows the container/host mapping; the standalone restore
script obeys this hint instead of hardcoding paths
(`backup_snapshot.py:106-110`, consumed at `scripts/nova_restore.py:437-449`).

**Member hashing** (`backup_snapshot.py:118-143`): a plain file is
`sha256` of its bytes (`_sha256_file`, chunked 1 MiB reads,
`backup_snapshot.py:118-127`). A directory (`"tree"` kind) is hashed by
walking `sorted(root.rglob("*"))`, skipping symlinks, and folding each file's
**relative path string** and its own sha256 into one running hash
(`_sha256_tree`, `backup_snapshot.py:130-143`) — sorted because filesystem
order is not stable across machines, and path-into-the-hash so a rename
without a content change is caught.

**Atomicity** (`backup_snapshot.py:200-214,293-297,374`): the final bundle
name is `nova-backup-<stamp>[-N].tar[.gz]`, built under a `.part` sibling and
made visible only by `os.replace(partial, final)` at the very end
(`backup_snapshot.py:374`). For the plaintext path the `.part` **is** the
final archive path with `.part` appended (`partial = final.with_suffix(...)`,
`backup_snapshot.py:214`); for the encrypted path the inner `tar.gz` is built
in the tempdir first (never touching `out_dir`) and only the *outer* tar is
written as `.part` (`backup_snapshot.py:297,357-361`). A collision-avoidance
loop (`backup_snapshot.py:210-213`) guards a documented real incident: two
snapshots landing in the same second — the pre-restore safety snapshot taken
moments before a restore reads a bundle from the same directory — once let
`os.replace` clobber the very bundle being restored
(`backup_snapshot.py:201-207`).

**Compression**: inner archive is `tar.gz` (`gzip`, `backup_snapshot.py:298`).
The outer archive is **uncompressed** `tar` (`backup_snapshot.py:357`) —
correct, since its payload is AES-GCM ciphertext (incompressible) and its
other members are tiny text.

**How the standalone restore script travels inside the bundle**: it is not
duplicated code. `backup_service.py:133` reads it straight from the
bind-mounted checkout (`RESTORE_SCRIPT = Path(CONTAINER_ROOT) / "scripts" /
"nova_restore.py"`) so "the copy in a bundle is the copy in git." `create()`
requires it (`restore_script` param) whenever a passphrase is given and
refuses the whole snapshot if the file is missing
(`backup_snapshot.py:190-195`), then simply `tar.add`s it as `OUTER_SCRIPT`
(`backup_snapshot.py:69,360`). `scripts/nova_restore.py` itself is
deliberately standalone — no imports from Nova, no required third-party
package (`scripts/nova_restore.py:1-19`) — and its crypto-reading half is
pinned to `backup_crypto.py` by a round-trip test named in its own docstring
(`scripts/nova_restore.py:35-36`, "pinned to it by a round-trip test in the
repo (test_backup_crypto.py)" — that test file was not read here; verify it
exists before relying on the pin).

---

## 2. Crypto, exactly

**Container format `NOVAENC1`** (`backup_crypto.py:10-16,49`):
```
b"NOVAENC1"                    8-byte magic
4-byte BE header length
header JSON {v, cipher, kdf, n, r, p, salt, nonce_prefix, chunk}
frames: [4-byte BE ciphertext-length][ciphertext+tag] ... to EOF
```

**Algorithm/mode**: AES-256-GCM, applied **per chunk** rather than once over
the whole file (`backup_crypto.py:20-23,148-179`) — chunked because a bundle
is "hundreds of MB … measured 190 MB bundles today," and single-shot GCM
would hold both plaintext and ciphertext in memory at once
(`backup_crypto.py:20-23`).

**KDF**: `hashlib.scrypt` — chosen specifically so the standalone restore
script needs no third-party package to derive the same key
(`backup_crypto.py:17-19`). Write-time cost: `n=2**15 (32768), r=8, p=1`,
"~34 MB of KDF memory — deliberately modest, because the default passphrase
is GENERATED with 160 bits of entropy" (`backup_crypto.py:51-56`). `dklen=32`
(a 256-bit AES key), `maxmem=256 MiB` for the KDF call itself
(`backup_crypto.py:76-80`). **Salt**: 16 random bytes, **fresh per file**
(`backup_crypto.py:153`) — "a fresh salt per file means a fresh key per
file."

**Reader-side cost cap, separate from the writer's cost** (`backup_crypto.py:57-64,99-135`):
a decryptor must allocate `128*r*n` bytes *before* the first authentication
check can run, so a tampered header naming an absurd cost could make an
honest reader allocate gigabytes, or name a cost that blows `maxmem` and
turns "tampered" into a bare `ValueError`. The accepted region is capped at
`MAX_N=2**18, MAX_R=16, MAX_P=4` and `128*r*n <= _KDF_MEM_CAP (128 MiB)`,
`n` must be a power of two, and header `salt`/`nonce_prefix` must decode to
exactly 16/4 bytes of hex (`backup_crypto.py:122-143`) — every failure mode
here raises `CryptoError`, not `ValueError`, so a tampered file reads as
"tampered," not as a crash.

**Nonce**: 4-byte random prefix (per file, generated with the salt,
`backup_crypto.py:153`) concatenated with an 8-byte big-endian **frame
counter** starting at 0 (`_nonce`, `backup_crypto.py:87-88`) — so the nonce
is unique per (file, chunk) without needing a counter stored anywhere; it is
reconstructed from frame position on read.

**Chunking**: default chunk `CHUNK = 4 MiB` (`backup_crypto.py:66`), reader
accepts up to `MAX_CHUNK = 64 MiB` (`backup_crypto.py:67`). Whether a chunk
is the **final** one is decided by cumulative bytes read vs. total file size
at write time (`final = done >= size`, `backup_crypto.py:171`) — explicitly
*not* by a short read, because "the last chunk of an exact-multiple file is
full-length" (`backup_crypto.py:169-171`). At read time, finality is decided
by *lookahead*: the next frame is read before the current one is decrypted,
and `final = (next frame is None)` (`backup_crypto.py:208-210`,
`scripts/nova_restore.py:267-270`).

**Authentication (AEAD)**: `AAD = MAGIC + header_bytes + 8-byte-BE(index) +
(0x01 if final else 0x00)` (`_aad`, `backup_crypto.py:83-84`), i.e. the
header and the chunk's *position in the sequence* are authenticated, not
just its ciphertext bytes. Consequence stated in the module docstring
(`backup_crypto.py:24-30`): a tampered header fails to decrypt, a reordered
chunk fails to decrypt, and — "the one that matters for backups" — a
**truncated** file fails to decrypt instead of silently yielding a shorter
archive, because the true final chunk's AAD carries `final=1` and a
truncated read either finds no frame (`backup_crypto.py:206-207`) or an
earlier chunk whose AAD says `final=0` mismatching its now-actual position.
`TAG_LEN = 16` (`backup_crypto.py:68`), GCM's standard 128-bit tag, appended
to each frame's ciphertext by `AESGCM.encrypt`.

**Wrong passphrase vs. corrupt file — deliberately the same exception**
(`backup_crypto.py:32-34,214-218`): GCM cannot distinguish "wrong key" from
"tampered/corrupt ciphertext," and the module refuses to *pretend* otherwise
— the docstring calls out the failure mode this avoids: "the passphrase must
be right, the file must be broken" reasoning during a 3am restore. Every
decrypt failure path raises `CryptoError` with the same sentence:
"decryption failed — wrong passphrase, or the file is corrupt, truncated or
tampered with (GCM cannot tell these apart)" (`backup_crypto.py:214-218`,
mirrored verbatim in `scripts/nova_restore.py:108-110` as `_BAD_DECRYPT`).

**How a wrong passphrase is reported up the stack**: `backup_snapshot.open_inner`
raises `CryptoError` if no passphrase was even supplied
(`backup_snapshot.py:463-466`); `backup_service.verify_restore` catches
`CryptoError` specifically and turns it into a `RestoreRefused` naming the
bundle and suggesting the passphrase may have been rotated — checkable via
the bundle's recorded `passphrase_fingerprint` (`backup_service.py:397-414`).
This is the one place a 500/crash was explicitly converted into a stated
verdict (comment at `backup_service.py:404-409` says it used to read
"crashed").

**Passphrase generation** (`backup_crypto.py:238-245`): 160 bits
(`secrets.token_bytes(20)`), base32-encoded lowercase, grouped `xxxx-xxxx-…`
(8 groups of 4) — "optimises for transcription, not for typing," because the
whole point is to be recorded off-machine.

**`scripts/nova_restore.py`'s independent crypto path** (no `cryptography`
required): prefers the `cryptography` package's `AESGCM`
(`scripts/nova_restore.py:95-105`), else calls system OpenSSL's `libcrypto`
directly via `ctypes` (`_openssl_gcm`, `scripts/nova_restore.py:113-198`),
using `EVP_aes_256_gcm`/`EVP_DecryptInit_ex`/`EVP_CIPHER_CTX_ctrl`
(IVLEN/TAG) /`EVP_DecryptUpdate`/`EVP_DecryptFinal_ex` — the `Final_ex`
return value *is* the GCM tag check (`scripts/nova_restore.py:190-193`).
macOS is special-cased to two Homebrew paths and explicitly **never** uses
`ctypes.util.find_library` there, because "Apple's stub libcrypto aborts the
whole process when called" (`scripts/nova_restore.py:118-127`). The
passphrase is tried **stripped, then verbatim**
(`scripts/nova_restore.py:404-411`) — "a paper transcription usually gains
whitespace… a stored value may legitimately carry it"
(`scripts/nova_restore.py:321-325`).

---

## 3. The passphrase resolver

**The seam**: a `Source` dataclass (`name, description, resolve`) and a
`SOURCES: dict[str, Source]` registry (`backup_passphrase.py:112-130`).
`resolve()` reads `settings_store.get("backups.passphrase_source")`
(default `"local"`), looks it up in `SOURCES`, and calls `.resolve()`
(`backup_passphrase.py:133-148`). An unknown configured name, or any
exception from the chosen source, becomes `PassphraseUnavailable` — never a
bare exception (`backup_passphrase.py:138-148`). The docstring is explicit
about *why* this is a registry and not a plain settings read: "Eventually
it'll get it from a secrets manager. Could be the one that is shipped, an
mcp server, application such as 1password, or a cloud secrets manager like
aws secrets manager" — a direct quote from Jeremy, 2026-08-02
(`backup_passphrase.py:1-8`).

**Resolvers implemented today: exactly one, `"local"`**
(`backup_passphrase.py:123-130`, `_local` at `backup_passphrase.py:42-109`).
It get-or-creates the passphrase in Nova's own `secret_store` under
`SECRET_NAME = "backup-passphrase"` (`backup_passphrase.py:31,53-77`).
Reading is a three-way branch: found → return it; `SecretMissing` → `None`
(genuinely absent, safe to create); any other `SecretError` (row exists but
unreadable — master key changed) → **raise** `PassphraseUnavailable` rather
than silently generating a replacement, because that would "generate a
REPLACEMENT over the passphrase that still seals every existing bundle"
(`backup_passphrase.py:55-73`).

**Precedence / concurrency on create**: double-serialised —
an `asyncio.Lock` for this process plus a **Postgres advisory lock**
(`pg_advisory_xact_lock(hashtext('nova:backup-passphrase:create'))`,
`backup_passphrase.py:39,78-91`) held for every other process, because
"a second instance (a worktree backend against the same database is a real
thing here) racing this create would leave one of them encrypting a bundle
with a passphrase the upsert just overwrote." Whoever loses the race
re-reads inside the lock and becomes a reader, never a second writer.

**How it avoids the passphrase reaching argv/env/logs**: the resolver
returns the value in-memory only (an `async def -> str`); nothing here
writes it to argv or a log line. The one `log.warning` on generation names
only the secret's *name*, never its value (`backup_passphrase.py:100-101`).
On the *restore* side, `scripts/nova_restore.py:321-335` (`get_passphrase`)
takes it, in order: `--passphrase-file <path>` → `$NOVA_BACKUP_PASSPHRASE`
env var → interactive `getpass.getpass()` prompt (never a positional CLI
arg, so it never appears in `ps`/shell history via argv) — and it is read
**raw, not stripped**, matching the "try stripped, then verbatim" pattern
described in §2.

**Standing nag, not a control** (`backup_passphrase.py:189-239`,
`maybe_nag`): self-limits to once per 24h of wall time via a module-global
monotonic timestamp (`backup_passphrase.py:186-199` — note: an
in-process global, reset on restart, same class of bug the module elsewhere
warns against for `backup_service.last_attempt`, `backup_service.py:206-212`).
Raises a `recommendations` card whose `dedupe_key` is
`f"backup-passphrase:{fingerprint(phrase)}"` (`backup_passphrase.py:208-209`)
— so an *unchanged* passphrase can never nag twice (the key already exists),
and a **rotated** passphrase gets a genuinely new key and nags again. The
card text spells out the exact risk and what "approving" means
(`backup_passphrase.py:220-231`). `confirmation()` reads the operator's
standing decision back from that same `recommendations` row's `status`
(`approved` → `"confirmed"`, `dismissed` → `"declined"`, else
`"unconfirmed"`) so "there is no second boolean to drift from it"
(`backup_passphrase.py:158-183`).

**Fingerprinting** (`backup_passphrase.py:151-155`): `sha256(passphrase)[:12]`
hex — identifies *which* passphrase without carrying it; used in the nag's
dedupe key, in bundle `meta.json` (`backup_snapshot.py:351`), and to detect
stale-passphrase bundles in the weekly drill (`backup_service.py:692-700`).

---

## 4. Coverage

**Core idea, stated in the module docstring** (`backup_coverage.py:1-53`):
coverage answers one question — "what persistent state does this stack have,
and is every bit of it accounted for?" — and **refuses rather than
guessing**. It is derived from three live signals, unioned, precisely
because a hand-kept list (the module names three that existed in this repo
and were stale in different ways within 12 days,
`backup_coverage.py:9-30`) silently omits things:

1. **Compose config**, all profiles including down services
   (`backup_inventory.from_compose`/`from_compose_file`,
   `backup_inventory.py:57-79,101-148`) — profile-gated services still own
   their volumes.
2. **Live container mounts**, all containers including exited ones
   (`backup_inventory.from_containers`, `backup_inventory.py:151-178`) —
   catches anonymous/image-declared volumes no compose file names.
3. **Git status of binds** (`backup_inventory.git_status_fn`,
   `backup_inventory.py:181-208`) — tracked→code (restorable from repo),
   ignored→operator state (must be in the bundle), neither→unknown.

`docker volume ls --filter label=...` was **measured and explicitly
rejected** as a fourth source: it missed the actual Postgres volume (predates
compose labelling) while including a stale one nothing references
(`backup_coverage.py:48-52`, `backup_inventory.py:20-25`).

**Dispositions** (`backup_coverage.py:65-72`): `INCLUDE`,
`INCLUDE_PG` (a live PGDATA copy is torn, so this tier is dumped, never
file-copied), `EXCLUDE_CODE`, `EXCLUDE_REDOWNLOAD`, `EXCLUDE_EPHEMERAL`,
`EXCLUDE_DECLINED` (deliberately out, with a reason), and
**`UNCLASSIFIED`** — the refusal state, "never a default"
(`backup_coverage.py:71-72`).

**Is it derived, or hand-kept?** Both, by design, at two different layers:

- The **classification mechanism** — which signal wins, what "gitignored
  under the project" means, how anonymous volumes are keyed — is fully
  derived/computed (`classify()`, `backup_coverage.py:419-534`).
- Exactly **two tables are hand-maintained**, and the module is explicit
  about why each one has to be: `VOLUME_POLICY` (`backup_coverage.py:80-122`)
  because "git cannot see inside a volume," and `PATH_POLICY`
  (`backup_coverage.py:172-234`) for host paths that carry a judgement call
  (`.env`, `.worktrees`, `data/backups`, build outputs, etc.) plus
  `ANON_POLICY` (`backup_coverage.py:327-341`, keyed by `(service,
  destination)` because an anonymous volume's *name* is a fresh 64-hex id
  every recreate) and `SEGMENT_POLICY` (`backup_coverage.py:344-366`, a
  small set of names — `node_modules`, `__pycache__`, etc. — that mean the
  same thing wherever they appear). Every entry in every table carries a
  written reason, several of which document a real incident where an
  under-scoped rule silently dropped real state (the `data` segment-policy
  incident that nearly excluded 54 MB of wake-word training corpus,
  `backup_coverage.py:344-354`; the `.tsbuildinfo`/`.d.ts` compiled-twin
  incident that stopped every scheduled backup until `_compiled_twin` asked
  the tree instead of guessing from filenames,
  `backup_coverage.py:254-285`).

**What it does with something it cannot classify**: it **REFUSES** — never
skips. Three refusal codes, all collected into `report()`'s `refusals` list
and all gate `may_snapshot`:

- `R1_UNCLASSIFIED` (`backup_coverage.py:528-534`) — a named volume with no
  `VOLUME_POLICY` entry, an anonymous volume with no `ANON_POLICY` entry, a
  bind whose compose source still has an unexpanded `${VAR}`
  (`backup_coverage.py:494-503`), or a bind outside the project directory
  that git has no opinion on (`backup_coverage.py:521-526`).
- `R2_UNREACHABLE` (`check_reachable`, `backup_coverage.py:537-562`) —
  classified `INCLUDE` but the runner cannot actually read it; "a bundle
  that silently omits a tier is worse than no bundle."
- `R5_UNCOVERED_HOST_STATE` (`check_uncovered_host_state`,
  `backup_coverage.py:583-610`) — gitignored state under the project that
  **no container mounts at all**, so nothing else here can see it; this is
  exactly the class of miss `.env` was (`backup_coverage.py:590-593`).

`report()`'s final answer is `"may_snapshot": not refusals`
(`backup_coverage.py:686-693`) — explicitly not "a partial bundle with a
warning."

**Secrets carve-out**, separate from unclassified/refuse: `.env`,
`nova_state`, `tailscale_state` form `SECRET_TIER`
(`backup_coverage.py:303-320`) and are held out by default
(`EXCLUDE_DECLINED`) unless `backups.include_secrets` is on
(`backup_coverage.py:670-682`) — this is a *policy* toggle, not a
classification refusal; the ruling in `rulings.md:60-67` overrides this
default for v4 (encryption reverses the reason D15 excluded
`network_credentials`).

---

## 5. The verbs

### `snapshot` (write a bundle) — `backup_snapshot.create`, `backup_snapshot.py:160-380`

Orchestrated by `backup_service.snapshot()` (`backup_service.py:136-165`):
checks the backup directory is mounted/writable (`store_available`,
`backup_service.py:39-49`), resolves the passphrase (refusing the whole
snapshot on `PassphraseUnavailable` — "no passphrase, no bundle,"
`backup_service.py:146-152`), takes coverage **fresh** (bypassing the
60s cache — "the refusals must reflect the stack at the moment a bundle is
written," `backup_service.py:99-101,153-157`), and runs `create()` off the
event loop via `asyncio.to_thread` (`backup_service.py:161-165`).

`create()`'s gates, in order:
1. `coverage["may_snapshot"]` must be true, else `SnapshotRefused`
   (`backup_snapshot.py:183-187`).
2. If a passphrase is given, it must be non-empty and `restore_script` must
   exist on disk (`backup_snapshot.py:188-195`).
3. Dump the database **first**, via `pg_dump -Fc --no-owner --no-acl`
   (`dump_database`, `backup_snapshot.py:146-158`) — first specifically so
   "an attachment blob written between the two shows up as a file with no
   row, which is recoverable. The reverse (a row with no blob) is not"
   (`backup_snapshot.py:230-235`). `pg_dump` failure or an empty output file
   both refuse (`backup_snapshot.py:152-157`).
4. Copy every coverage-included entry into the staging tree
   (`backup_snapshot.py:242-278`) — a volume with no path in `volume_paths`
   is a hard `SnapshotRefused`, not a skip (`backup_snapshot.py:248-255`); a
   source that does not exist is likewise a refusal
   (`backup_snapshot.py:262-265`).
5. Write `manifest.json` (§1), tar the inner archive, `verify()` it, and
   discard the `.part` on any verification failure
   (`backup_snapshot.py:280-326`).
6. If encrypting: `backup_crypto.encrypt_file` the inner archive → build the
   outer tar (README, restore script, meta, payload) → run
   `verify_bundle()` as a **full round trip** and discard on failure
   (`backup_snapshot.py:328-372`).
7. `os.replace` into place (§1 atomicity).

`verify()` (`backup_snapshot.py:383-428`) re-extracts the archive to a fresh
tempdir and **re-derives** every member's hash from the extracted bytes —
deliberately not trusting the manifest's own recorded numbers. Its exception
handling is deliberately broad (`except Exception`,
`backup_snapshot.py:420-427`) because a truncated bundle raises `EOFError`
from `gzip`, which is neither `TarError` nor `OSError` — found by testing,
and a narrower catch turned "corrupt" into an uncaught crash.

### `apply` (destructive restore over the live system) — `backup_apply.apply_bundle`, `backup_apply.py:170-278`

Module docstring enumerates four gates up front (`backup_apply.py:1-42`);
code order:

1. **Typed confirmation** — the caller must pass back
   `CONFIRM_PHRASE = "RESTORE AND OVERWRITE MY DATA"` verbatim
   (`backup_apply.py:63,193-197`), deliberately a phrase and not a boolean
   ("a boolean is one careless default away from being true,"
   `backup_apply.py:10-14`).
2. Bundle self-verify (`bs.verify(bundle)`) and a `bundle_version` check
   against the code's own `BUNDLE_VERSION`
   (`backup_apply.py:199-209`).
3. **Pre-restore safety snapshot**, of the live system, taken and *verified*
   before anything is touched (`backup_apply.py:211-223`) — if it fails,
   apply refuses: "refusing to restore because the safety snapshot failed,
   which means there would be no way back." A belt-and-braces check that the
   safety snapshot did not land on the bundle being restored
   (`backup_apply.py:224-231`).
4. **Staging + migration gate**: `pg_restore --exit-on-error` the bundle's
   dump into a fresh throwaway database named `nova_verify_<8 hex>`
   (`_assert_scratch`, `backup_apply.py:236-253`), then run
   `migration_gate()` against that staged database
   (`backup_apply.py:254-257`, defined at `backup_apply.py:152-167`).
   `migration_gate` reads the bundle's `schema_migrations` ledger
   (`_applied_migrations`, `backup_apply.py:65-95` — tolerant of a ledger
   with no `checksum` column at all, falling back to filename-only) and
   compares it against the migration files *this checkout* has
   (`_known_migrations`, `backup_apply.py:98-105`) via `check_migrations`
   (`backup_apply.py:108-149`): a bundle row is "from the future" only when
   **neither its filename nor its body checksum** matches a file on disk —
   filename-alone was the original rule and it once refused an entire,
   perfectly-restorable backup set because a migration had been renumbered
   (`backup_apply.py:115-122`).

Then **"the point of no return"** (`backup_apply.py:259-262`, comment
explicit in the code): `_restore_files` (§ below) then `_swap_database`.
Everything above this line can fail with the system untouched; the
`except Exception` wrapping the whole staged block drops the staging
database on any failure path and re-raises (`backup_apply.py:270-278`).

**Database swap mechanism** (`_swap_database`, `backup_apply.py:281-299`):
never restores directly into the live database. Terminates live backends,
`ALTER DATABASE <target> RENAME TO <target>_pre_restore_<stamp>`, then
`ALTER DATABASE <staging> RENAME TO <target>` — "a rename is close to
instantaneous and the old database survives under a dated name."

**File restore** (`_restore_files`, `backup_apply.py:302-340`): because
targets like `data/memory` are **bind mount points**, an atomic
rename-into-place fails with `EBUSY`. Instead, contents are moved: existing
contents are moved aside into a timestamped `.{name}.pre-restore-<stamp>`
directory (kept, never deleted) and the bundle's contents are moved in.

### The non-destructive restore drill — `backup_restore.verify_restore`, `backup_restore.py:191-294`

The safety argument is the module's whole docstring
(`backup_restore.py:1-30`): the scratch database name is asserted
**three separate times** — before `CREATE` (`backup_restore.py:217`),
before `pg_restore` (`backup_restore.py:234`), before `DROP` in the
`finally` (`backup_restore.py:290`) — via `_assert_scratch`
(`backup_restore.py:58-64`), which checks against `SCRATCH_RE =
r"^nova_verify_[0-9a-f]{8}$"` (`backup_restore.py:51`). After `CREATE`, the
scratch connection is asked `SELECT current_database()` and compared against
the expected name before anything is written
(`backup_restore.py:222-229`) — "a DSN that looks right and resolves
elsewhere is the failure this catches." `pg_restore --exit-on-error` is
called out as **required, not tidiness**: its default is to continue past
errors, which "turns a misdirected restore into an interleaving instead of a
stop" (`backup_restore.py:236-240`, docstring at `backup_restore.py:18-20`).
After restoring into the scratch db, it runs the **same** `migration_gate`
apply would run (`backup_restore.py:253-262`) — the docstring records that
before this was added, `verify_restore` passed on 7 bundles that
`apply_bundle` then refused, because the two functions were asking different
questions (`backup_restore.py:204-208`). Row counts are compared against
`live_dsn` if given: a **missing table** is structural and fails
(`restored_ok`); a **row-count** difference is not, because
`n_live_tup` is a stats-collector estimate (`backup_restore.py:264-279`).
The scratch database is dropped in `finally` unless `keep=True`
(`backup_restore.py:288-294`).

**`nova_verify_<hex>` naming**: `f"nova_verify_{uuid.uuid4().hex[:8]}"` —
exactly 8 lowercase hex characters, generated fresh per call
(`backup_restore.py:216`, mirrored in `backup_apply.py:236-238` for the
safety-restore staging database). `SCRATCH_RE` is the only pattern this
whole module is permitted to `CREATE`/write to/`DROP`
(`backup_restore.py:47-51`).

### The weekly drill wrapper — `backup_service.drill`, `backup_service.py:648-721`

Sweeps orphaned `nova_verify_*` databases first
(`sweep_scratch_databases`, `backup_service.py:568-602` — needed because
`verify_restore`'s `finally` does not survive a process restart mid-verify
under `--reload`). **No bundles at all is a FAILED drill**, not a vacuous
pass (`backup_service.py:662-665`) — "the question the drill answers is
'could I recover from disaster today', and with no bundle the answer is
no." Calls `verify_restore` on the newest bundle
(`backup_service.py:675-676`), fails on `RestoreRefused` or on
`restored_ok=False` naming the migration refusal or missing tables
(`backup_service.py:676-683`). On success, the summary is augmented with two
cross-checks the drill alone could not otherwise surface: whether *older*
bundles are sealed with a different passphrase fingerprint than the current
one (`backup_service.py:690-700`), and whether the passphrase is confirmed
recorded off-machine (`backup_service.py:702-706`) and whether the
off-machine copy is configured/synced (`backup_service.py:707-720`).

### `verify_restore` at the service layer — `backup_service.py:368-421`

Wraps `backup_restore.verify_restore` to also handle the **encrypted**
case: if the target bundle is an outer (encrypted) bundle, it resolves the
passphrase first (refusing with `RestoreRefused` if the source fails,
`backup_service.py:382-389`), decrypts via `bs.open_inner` inside a
`with`-block whose tempdir is removed on exit (`backup_service.py:400-403`,
`backup_snapshot.py:454-476` — "plaintext credentials never outlive the
operation that needed them"), and converts a `CryptoError` specifically into
a stated `RestoreRefused` about a possibly-rotated passphrase
(`backup_service.py:404-414`, discussed in §2/§3). Runs off the event loop
(`asyncio.to_thread`, `backup_service.py:419-421`).

### Standalone restore — `scripts/nova_restore.py:381-497` (`_restore`)

Never runs docker, never touches an existing installation — "the
destructive step stays a human decision, printed and explained"
(`scripts/nova_restore.py:32-33`). Flow: detect legacy plaintext (`gzip`
magic `1f8b`) vs. encrypted outer tar (`scripts/nova_restore.py:384-411`);
for encrypted, get the passphrase (§3), decrypt, and **delete the encrypted
payload as soon as it's consumed** to reclaim ~200 MB early
(`scripts/nova_restore.py:412`); extract the inner archive and
`verify_extracted` against the manifest, **hard-stopping** (return code 1,
no next steps printed) on any mismatch (`scripts/nova_restore.py:415-428`);
lay each member out using its `restore_to` hint into `<out>/project/`,
`<out>/volumes/<name>/`, or `<out>/db.sql` (`scripts/nova_restore.py:430-454`);
print the exact next commands — clone, copy `.env`, `docker volume create` +
`docker run --rm ... cp` for each volume, bring up postgres, restore
**through the postgres container** ("its `pg_restore` always matches its
server, which a host client may not," `scripts/nova_restore.py:483-489`),
`docker compose up -d` (`scripts/nova_restore.py:456-497`). On *any*
exception anywhere in `main()`, everything the run itself created under
`--out` is removed, because a half-decrypted credential file must never be
left looking like a finished restore (`scripts/nova_restore.py:366-378`).
`os.umask(0o077)` is set at the very top of `main()`
(`scripts/nova_restore.py:352`) so nothing it writes — `.env`, the secrets
master key, the DB dump — is ever group/world-readable.

### Every refusal point, by exception type

`SnapshotRefused` (`backup_snapshot.py:94-96`): unaccounted coverage, empty
passphrase, missing restore script, missing volume path, missing source,
`pg_dump` failure/empty output, failed self-verify, failed round-trip
verify. `RestoreRefused` (`backup_restore.py:54-56`): non-`SCRATCH_RE`
database name at any of the three touchpoints, DSN resolving to an
unexpected database, `pg_restore` failure, bundle-does-not-verify, no
`db.sql` member, `psql` failure, `apply_bundle`'s unconfirmed phrase, failed
safety snapshot, safety-snapshot/bundle collision, bad `bundle_version`, and
the migration gate's "newer version of Nova" refusal
(`backup_apply.py:142-148`).

---

## 6. What v3 assumes that v4 does not have

Grounded against `deploy/docker-compose.yml`, `services/core/app/
migrations_runner.py`, `services/core/app/settings_store.py`,
`services/core/app/scheduler.py`, and greps across `services/` in this
worktree.

**1. One database vs. three.** Every v3 module assumes a single Postgres
database named `nova` (`docker-compose.yml:20` `POSTGRES_DB: nova`;
`backup_service.dsn()`, `backup_service.py:52-56`, only ever swaps the
*database name* on one DSN). v4's `postgres` service is one container
serving **three** databases — `nova_core`, `nova_gateway`, `nova_memory`,
one role/password each (`deploy/docker-compose.yml:38,77,101`). Every
verb that touches "the database" — `dump_database`, `apply_bundle`'s
staging/swap, `verify_restore`'s scratch restore, `table_counts` — is
written for one database and would need to run **three times** (or be
rewritten to iterate), and the manifest's single `db.sql` member
(`backup_snapshot.py:47,239-240`) becomes at least three members.

**2. `schema_migrations` has no `checksum` column in v4.** v3's
`_applied_migrations` explicitly *tolerates* a ledger with no `checksum`
column, falling back to filename-only comparison
(`backup_apply.py:80-95`) — but the checksum path is what makes
`check_migrations` rename-tolerant, which is the exact bug it was built to
close (`backup_apply.py:115-122`). v4's tracking table is
`CREATE TABLE IF NOT EXISTS schema_migrations (filename text PRIMARY KEY,
applied_at timestamptz ...)` — **no checksum column at all**
(`services/core/app/migrations_runner.py:19-24`). Porting `migration_gate`
as-is degrades permanently to filename-only matching for v4 unless a
checksum column is added to v4's migration runner (all three services share
one copy of this file by convention: "Identical across services/core,
services/gateway, services/memory — edit this copy, then paste it verbatim
over the other two," `services/core/app/migrations_runner.py:1-6`).

**3. Three independent migration ledgers, not one.** Following from #1/#2:
`services/core`, `services/gateway`, `services/memory` each run their own
`migrations_runner.run_migrations` against their own database with their
own `migrations/` directory (`services/core/migrations`: 35 files,
`services/gateway/migrations`: 9, `services/memory/migrations`: 1, counted
directly). v3's `migration_gate(staged_dsn, migrations_dir, ...)`
(`backup_apply.py:152-167`) assumes one staged database and one
`migrations_dir`; a v4 port needs either three gate calls (one per
service/database pair) or a rewritten multi-database gate.

**4. No `nova_state` volume, no `secret_store` module, in v4 at all.** v3's
`VOLUME_POLICY["nova_state"]` (`backup_coverage.py:86-91`) describes a
volume holding `/state/secret.key` (the secrets master key),
`/state/instance_id`, the model-store path, the ntfy base URL, mounted read
at `backup_service.volume_paths()` (`backup_service.py:80-92`, paths
`/state` and `/vol/tailscale_state`). A grep for `secret_store`/
`secrets_store` under `services/` returns nothing but a test filename
(`services/gateway/tests/test_secrets_not_logged.py`) — there is no secret
store, no `nova_state`-equivalent volume, and no `.env`-sealing master key
in v4 today. This is the entire reason `backup_passphrase._local`
(§3) has nowhere to live yet, and matches the S41 ruling that only the
**resolver seam** lands, not the store (`rulings.md:48-49`).

**5. `VOLUME_POLICY`/`ANON_POLICY` are keyed to v3's literal volume/service
names, none of which exist in v4.** v3's table
(`backup_coverage.py:80-122`) names `postgres_data`, `nova_state`,
`tailscale_state`, `ollama_models`, `whisper_models`, `kokoro_models`,
`ntfy_cache`, `coder_workspaces`. v4's compose declares `v4_pgdata`,
`v4_models`, `v4_memdata`, `v4_workspace`, `v4_ollama`, `v4_tailscale`
(`deploy/docker-compose.yml:337-351`) and has **no** `coder`, `whisper`,
`kokoro`, or `ntfy` service at all (services present:
`postgres, core, gateway, memory, web, searxng, ollama, tailscale`,
enumerated at `deploy/docker-compose.yml:4-329`). The table needs a full
rewrite, not a rename — each entry's *reasoning*, not just its key, changes
(e.g. `v4_models` is gateway's model-catalog cache, not `ollama_models`'s
weights directory).

**6. Different compose profiles.** `backup_inventory.collect`'s default
profile tuple is `("coder", "inference", "media", "notify", "tailscale",
"voice")` (`backup_inventory.py:233-234`). v4's compose only defines
`profiles: ["inference"]` (ollama) and `profiles: ["tailnet"]` (tailscale)
(`deploy/docker-compose.yml:203,231`) — the other four v3 profiles name
services v4 does not have.

**7. No single container mounts "the whole stack" in v4.** v3's
`backend` container is the one thing `backup_service.py` assumes: it
bind-mounts the whole repo (`HOST_ROOT`/`CONTAINER_ROOT`,
`backup_service.py:33-77`) and separately mounts `/state` and
`/vol/tailscale_state` (`backup_service.py:88-92`) so one process can read
everything coverage might include. v4 has **no such container** — `core`
mounts only `v4_workspace` (`deploy/docker-compose.yml:56-60`), `gateway`
mounts `../data:ro` and `v4_models` (`deploy/docker-compose.yml:80-84`),
`memory` mounts only `v4_memdata` (`deploy/docker-compose.yml:102-104`).
A v4 backup runner (whatever process ends up calling the ported
`backup_snapshot.create`) needs its own purpose-built mounts of the repo
plus every named volume read-only — and per §4 of Coverage, an under-mounted
runner is not a silent gap, it is a designed `R2_UNREACHABLE` refusal
(`backup_coverage.py:537-562`).

**8. `settings_store` shape differs and exists in only one v4 service.**
v3's `settings_store.get(key)` is a **synchronous** call
(`backend/app/settings_store.py:768`) used freely inside async functions
(`backup_passphrase.py:136`, `backup_service.py:124-125,345,430,468,509,528`).
v4 has a `settings_store` module only under `services/core/app/
settings_store.py` (328 lines; nothing under `services/gateway` or
`services/memory`), and its reads are **async**, per-key, against
`asyncpg` (`read_value(pool, key)`, `services/core/app/settings_store.py:272`)
gated by a defined `SETTING_DEFS` registry that refuses an unknown key by
name (`services/core/app/settings_store.py:1-6`). Every `backups.*` setting
key v3 reads (`backups.passphrase_source`, `backups.include_secrets`,
`backups.offsite_dir`, `backups.every_hours`, `backups.keep`) would need to
be added to that registry, and every synchronous `.get(...)` call site
rewritten to `await`.

**9. No `recommendations`, `capability_events`, `automations`, or
`backup_attempts` tables/modules in v4.** Greps for
`recommendations`/`capability_events` and for `backup_attempts`/an
`automations` table across `services/*/migrations/*.sql` and
`services/*/app/*.py` all return nothing. This removes the home for three
v3 mechanisms wholesale: the passphrase off-machine **nag**
(`recommendations.create`/`capability_events.record`,
`backup_passphrase.py:103-108,218-232`), the **attempt history** that
`freshness()`'s staleness verdict is built on (`backup_service.py:206-365`
reads/writes `backup_attempts`), and the **weekly drill's own scheduling**
row (`automations` with `handler='restore_drill'`,
`backup_service.py:633-645`). v4 does have a general recurring-task
mechanism — `services/core/app/scheduler.py` (722 lines, a `timers` table
with traced-turn firings, `services/core/app/scheduler.py:1-20`) — which is
a plausible new home for the drill's *scheduling*, but it is a different
shape from v3's `automations` row and was not designed with a
non-chat-turn "mechanical handler" concept the way `backup_service.drill`
assumes (`backup_service.py:648-654`, "The scheduler runs this as a
mechanical handler — no agent in the loop").

**10. The compose file itself moved and its variable/network shape
changed.** v3's `backup_inventory.from_compose_file` reads
`docker-compose.yml` at the project root
(`backup_inventory.py:101-118`, `Path(project_dir) / "docker-compose.yml"`);
v4's is at `deploy/docker-compose.yml`, uses a fixed `name: nova` at the top
of the file plus IPAM/fixed-address blocks for `web`/`tailscale`
(`deploy/docker-compose.yml:1,326-335`) that v3's parser never had to
reason about (it should simply ignore unknown top-level keys, but this is
unverified against v4's actual YAML shape — worth a direct test before
trusting it).

---

## 7. Verdict

**Ports nearly as-is (mechanism is already generic/pure):**

- **`backup_crypto.py`** — the module docstring says it plainly: "pure
  mechanism — no settings, no resolver, no app imports"
  (`backup_crypto.py:36-39`). Nothing here references v3's stack shape.
  Port unchanged.
- **`scripts/nova_restore.py`'s crypto-reading half** (`decrypt_payload`,
  `_gcm_backend`, `_openssl_gcm`, verification helpers,
  `scripts/nova_restore.py:87-316`) — same reason, standalone by design.
  The parts that *do* need v4-specific rewriting are the printed next-steps
  (§1/§5 — they hardcode a single `docker compose exec postgres`/single
  database restore, `scripts/nova_restore.py:471-497`) and the
  `restore_to` → output-layout convention if it changes for three
  databases.
- **`backup_snapshot.py`'s file-level mechanics**: `_sha256_file`/
  `_sha256_tree`, the manifest-first tar ordering, the `.part`-then-rename
  atomicity, `encrypt_file`/`open_inner`/`verify`/`verify_bundle`'s round
  trip. These operate on paths and bytes, not on "the database" or "the
  compose file" — port with only the *orchestration* around them (how many
  `db.sql`-equivalent members, what `dsn()` means) rewritten.
- **`backup_restore.py`'s scratch-database safety pattern**: `SCRATCH_RE`,
  the triple `_assert_scratch`, `current_database()` cross-check,
  `--exit-on-error`. The *pattern* is database-agnostic and should be
  copied verbatim per v4 database, even though it needs to run three times.

**Need real rewriting for v4's shape (mechanism is right, data is v3's):**

- **`backup_coverage.py`'s `VOLUME_POLICY`/`PATH_POLICY`/`ANON_POLICY`
  tables** (§6.5) — the *classification mechanism* (derive from
  compose+containers+git, refuse on unclassified) is exactly what arc 8
  requires and should port unchanged; every *row* in every table is v3's
  and must be re-derived against `deploy/docker-compose.yml`'s real
  services/volumes and v4's real gitignored paths, from scratch, the way
  the module itself was built (measure, don't guess).
- **`backup_inventory.py`'s `from_compose`/`from_compose_file`/
  `from_containers`** — mechanism ports; default profile tuple, project
  name, and (for `from_compose`) the `docker compose ... config` invocation
  need to target `deploy/docker-compose.yml` with `--project-directory` per
  the tailnet-deploy convention this repo already uses elsewhere.
- **`backup_service.py`'s runner wiring** (`HOST_ROOT`/`CONTAINER_ROOT`,
  `volume_paths()`, `dsn()`, the settings-store calls) — needs a new v4
  backup-runner surface (which container runs this, what it mounts) and a
  three-database `dsn`/orchestration layer. This file is the thinnest
  wrapper of the nine and is also the one with the most v3-stack-specific
  assumptions per line — expect to rewrite most of it rather than port it.
- **`backup_apply.py`'s `migration_gate`/`check_migrations`** — the
  name-or-checksum idea is sound and should port, but needs (a) a checksum
  column added to v4's shared `migrations_runner.py`
  (`services/core/app/migrations_runner.py:19-24`) or a documented,
  permanent degrade to filename-only, and (b) to run per service database,
  with `_swap_database`/`_restore_files` likewise invoked three times (or
  rewritten to accept a list of `(admin_dsn, target_db, staging)` triples).

**Should be dropped or deferred, not ported:**

- The `coder_workspaces`, `whisper_models`, `kokoro_models`, `ntfy_cache`
  `VOLUME_POLICY` rows and the `searxng` `ANON_POLICY` rows
  (`backup_coverage.py:96-121,332-341`) — no corresponding services exist in
  v4's compose at all (§6.5/§6.6); there is nothing to port.
- `backup_passphrase.py`'s `maybe_nag`/`confirmation` (the standing
  off-machine-recording card) and the `capability_events.record` call
  inside `_local` (`backup_passphrase.py:100-109,189-239`) — no
  `recommendations` or `capability_events` module exists in v4 (§6.9); build
  the resolver seam and `resolve()`/`fingerprint()` only, and treat the nag
  as separate follow-on work once (or if) an equivalent card mechanism
  exists. This also matches the S41 ruling's scope: only the resolver seam
  lands (`rulings.md:48-49`).
- `backup_service.py`'s `freshness()`/`_verdict()`/`last_attempt()`/
  `record_attempt()` (`backup_service.py:206-365`) and `drill_state()`/
  `_drill_verdict()` (`backup_service.py:605-645`) — both depend on tables
  (`backup_attempts`, `automations`) that do not exist in v4 (§6.9). The
  **mechanical drill verb itself** (`backup_service.drill`'s restore-newest-
  bundle-and-report core, `backup_service.py:648-721` minus its
  `automations`/`backup_attempts` reads) is in the S41 MUST list
  (`map-requirements.md:21`, "build the restore-drill verb; the weekly
  schedule may land later") and should be kept; its scheduling and history
  bookkeeping should not be ported as-is — either build v4 equivalents of
  those two tables, or wire the verb through `services/core/app/
  scheduler.py`'s existing timer mechanism instead of reconstructing v3's
  `automations` shape.
- `backup_service.py`'s off-machine copy (`offsite_state`/`offsite_sync`,
  `backup_service.py:459-565`) — a real feature (phase 2a) but not named in
  any of S41's 29 MUST bullets in `map-requirements.md:17-45`; out of scope
  for this slice.
- `backup_coverage.py`'s `.claude`/`.worktrees` `PATH_POLICY` entries
  (`backup_coverage.py:177-182`) — tooling-specific to this repo's current
  layout; re-derive rather than copy, the same way every other `PATH_POLICY`
  row must be.

**One unresolved reference worth locating before relying on it**: a comment
in `backup_service.py:180` names a `_prune_bundles` function ("invisible to
`bundles()` and to `_prune_bundles`, which only ever deletes things it can
list") that does not appear anywhere in the nine files read for this map —
likely local retention/pruning logic that lives in the scheduler or route
layer outside this file set. Find and read it before assuming local-bundle
retention is fully covered by what is mapped here.
