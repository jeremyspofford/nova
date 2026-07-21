# Data backups — snapshot, restore, factory reset

Implementation plan (authored 2026-07-21 with Opus, at Jeremy's request). Goal:
Nova can snapshot all of her state into a single portable bundle, store it
**locally or in the cloud**, **import** a bundle to restore, and offer a
**factory reset** to a clean slate — all from the UI, no shell required.

## What's Nova's state? (verified in code, 2026-07-21)

Everything that matters lives in four places; a backup captures the first three
and deliberately skips the fourth:

1. **Postgres** (`postgres_data`) — the core: conversations, messages, agents,
   tools, rules, automations, consents, recommendations, curated_models,
   mcp_servers, turn traces, and (once built) secrets. `pg_dump` is the snapshot.
2. **Memory files** (`./data/memory` / `$NOVA_MEMORY_DIR`) — markdown topics &
   journals. Plain files; copy them verbatim.
3. **Control state** — `nova_state` (the model-store path) and the **secrets
   encryption key** (`NOVA_SECRET_KEY` / `./data/secret.key`, per
   `secrets-management.md`). Small but critical: without the key, restored
   encrypted secrets are unrecoverable.
4. **Model weights** (`ollama_models`, `kokoro_models`, `whisper_models`) —
   large and **re-downloadable**. Excluded by default (a backup shouldn't be
   12 GB); opt-in for a fully-offline complete bundle.

There is no backup tooling today (the old `scripts/backup.sh` is gone) — this
builds it from scratch.

## The bundle

A single `nova-backup-<timestamp>.tar.zst` containing:

```
manifest.json      # schema/app version, created_at, contents, checksums
db.sql             # pg_dump of the nova database
memory/            # verbatim copy of the memory markdown tree
state/             # nova_state contents (models_dir, …)
secret.key         # ONLY if "include secrets key" is on (see Decisions)
models/            # ONLY if "include model weights" is on (large)
```

`manifest.json` carries the **app version + migration/schema version** so restore
can refuse or warn on an incompatible bundle rather than corrupting state.
Integrity: per-file checksums + a bundle checksum.

## Storage targets (local or cloud)

Mirrors the model-store philosophy — local default, remote opt-in, no lock-in:

- **Local** — write the bundle to a chosen host path (a folder, an external
  drive, a NAS mount). Zero dependencies.
- **Cloud / remote** — via **rclone**, the universal option: one tool, 50+
  backends (S3, Backblaze B2, Cloudflare R2, MinIO, Google Drive, Dropbox,
  SFTP, WebDAV, …). The operator configures an rclone remote once; Nova pushes
  the bundle there. This keeps Nova batteries-included without hard-coding a
  provider SDK. (A native S3 client is the fallback if we'd rather not bundle
  rclone.)

Retention: keep the last N local bundles (default 7), prune older; cloud
retention is the remote's to manage (or an optional lifecycle hint).

## Where it runs

`pg_dump`/`pg_restore` + `rclone` + `zstd` need to live somewhere with DB
access and volume access. Two options (Decisions §4):
- **A backup sidecar** (`backup-runner`, profile `backup`) — a small service
  holding those binaries, DB creds, and mounts for the memory dir + a
  backup-output volume/host path. Mirrors the `inference-control` pattern:
  the backend calls a fixed verb API (`snapshot` / `list` / `restore` /
  `factory-reset`); nothing about the DB is parameterized by the network.
- **In the backend image** — add the pg client + rclone to the backend and
  orchestrate directly. Fewer services, but grows the backend image and its
  blast radius. *Plan default: the sidecar* — restore is destructive and
  deserves an isolated, fixed-verb executor, same reasoning as inference-control.

## Operations

- **Snapshot** (manual button + optional scheduled automation, e.g. daily):
  dump DB → copy memory/state → (opt) key/models → tar+zstd → store to the
  configured target(s). Streams progress like the model-pull UI.
- **List** — enumerate bundles across local + configured remotes with size,
  timestamp, app/schema version, and whether it includes secrets/models.
- **Import / restore** — pick a bundle (or upload one) → **verify manifest
  compatibility** → **take an automatic pre-restore snapshot** (safety net) →
  restore DB (into a clean database, then run migrations to the bundle's
  version if needed), memory files, state. Destructive: a typed confirm.
- **Factory reset** — wipe to fresh: drop+recreate the DB (re-migrated empty),
  clear memory + state, keep the app itself. A strong, typed confirm ("type
  RESET"). Also takes a pre-reset snapshot so it's not truly irreversible.

## UI (Settings → Backups, reachable by navigation)

- **Create backup** now (with toggles: include secrets key? include model
  weights?), progress, result with size + location.
- **Targets** — local path + "add cloud target" (rclone remote name or config);
  test-connection button.
- **Backups list** — local + remote, newest first, each with restore + delete
  and a badge for what it contains; **restore** and **factory reset** behind
  typed confirms, both showing that a safety snapshot is taken first.
- Schedule — "daily/weekly automatic backup to &lt;target&gt;" as a setting or a
  seeded automation.

## Phases (each ends live-verified; changes left uncommitted, summarized)

1. **Local snapshot + restore.** backup-runner sidecar, `snapshot`/`list`/
   `restore`, bundle format + manifest, Settings → Backups (create, list,
   restore, pre-restore safety snapshot). **Verify:** snapshot; change some data
   (add a topic/automation); restore; the change is gone and prior state is
   back, DB + memory both. Manifest mismatch refuses loudly.
2. **Cloud target (rclone).** Configure a remote (test against MinIO/B2), push
   + pull bundles, retention. **Verify:** back up to the remote, wipe locally,
   restore straight from the remote.
3. **Factory reset + scheduling.** Typed-confirm factory reset (with pre-reset
   snapshot) and a scheduled daily backup. **Verify:** reset returns a clean
   first-run app; the schedule produces a dated bundle.
4. **Polish.** Include-model-weights option, encrypted bundles (passphrase),
   backup size/count on the Storage card, restore-into-newer-schema migration
   path.

## Decisions (defaults chosen; phase 1 can start)

1. **Cloud mechanism** — **rclone** (universal, one config, 50+ backends;
   default) vs a native S3 SDK (S3-compatible only) vs SFTP/WebDAV only.
2. **Secrets key in the bundle** — **excluded by default**; turning it on makes
   the bundle as sensitive as the secrets, so pair it with an **optional
   passphrase-encrypted bundle** (phase 4). Excluded = a restore on a new host
   needs the same `NOVA_SECRET_KEY` to read encrypted secrets (loud warning on
   restore). Default: exclude, warn.
3. **Model weights** — **excluded by default** (re-downloadable); opt-in for a
   complete offline bundle.
4. **Runner** — **backup sidecar** (default, isolated fixed-verb executor) vs
   in-backend. 

## Traps / risks

- **Restore is destructive** — always take a pre-restore/pre-reset snapshot
  first; typed confirms; never a one-click wipe.
- **Schema drift** — a bundle from an older app version restored into a newer
  one must run migrations forward; a *newer* bundle into an *older* app must
  refuse. The manifest's schema version is the gate. Test both directions.
- **The secrets key is the crown jewel** — excluding it protects the backup but
  means "restore ≠ working secrets" without the key; say so at restore time,
  never silently restore un-decryptable secrets.
- **Partial/corrupt bundles** — checksums + atomic writes (temp then rename);
  a failed upload must not leave a half-bundle that "lists" as restorable.
- **Consistency** — `pg_dump` is a consistent snapshot; copy memory files right
  after so the two are close in time (memory is append-mostly, low risk).
- **Secrets in the dump** — `db.sql` contains the (encrypted) secrets table and
  auth token hashes; the bundle is sensitive regardless of the key question —
  document that a backup should be stored somewhere trusted.
- Big bundles: stream to disk, don't buffer in memory; zstd for ratio+speed.
```
