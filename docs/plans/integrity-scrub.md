# Plan: the integrity scrub and disk-health signals (Amendment 2026-10-31-B Part 6, second and third bullets)

Track 1, Health backend only. Branch `claude/integrity-scrub`. The diagnostics bundle (#259,
`docs/plans/diagnostics.md`) is the first bullet and is already built; this plan is its sibling
and inherits its rules. **No Health screen is built here**: a Health entry needs the owner's
approval of a rendered entry first, and lands in its own PR.

Spec sources: ROADMAP-AND-GATES (Amendment B Part 6), `docs/plans/diagnostics.md` (decision entry,
"Not built here"), LEDGER 2026-11-03 (#285/#286: "integrity scrub remain[s] queued"), and the
endpoint exposure audit of 2026-11-08 (no new page; an API at the existing diagnostics access).

## What the scrub is

One read-only pass over Nova's own data home, built per request, answering one question: **is the
data Nova keeps intact, and does the disk it lives on have room and no reported errors?** It
returns one JSON document and keeps nothing.

- **The builder:** `src/core/integrity/index.ts` (`runScrub(o)`), beside `src/core/diagnostics/`.
  The database check runs in `src/core/integrity/worker.ts`, a worker thread, so it can be
  stopped at the time bound.
- **The route:** `GET /api/v1/integrity`, mounted by Core next to `/diagnostics`, at the same
  access level (`person`, the default: the console or a paired device the person uses; never a
  mesh peer without a person's session). `?full=1` asks for SQLite's full `integrity_check`
  instead of `quick_check`; nothing else is read from the request.

## Inherited from diagnostics (not negotiable)

- **Redacted by construction, metadata only.** Every string in the result is a fixed sentence
  or a fixed word from this module, with numbers put in. No path (inside or outside the home), no
  file name, no checkpoint name or id (a named checkpoint carries the person's words), no
  device name, no table or index name, no SQLite message text. Where a finding needs a place, it
  is one of Nova's own top-level entry names (`resilience/entries.ts`, a fixed list) or a page
  count.
- **Built per request, nothing kept on disk.** The result is the response; it is not cached,
  logged with content, stored as a problem, or sent anywhere.
- **Nothing is written.** The database is opened read-only. When Nova isn't holding it (no
  `nova.db-wal`), it is opened `immutable`, so SQLite creates no side files either. When Nova is
  running, SQLite's shared-memory index (`nova.db-shm`) is the one file a reader touches: reading
  a WAL database requires it, and it holds no data. No file is created, renamed or removed.

## The checks

| Check | What it reads | Problem when | Bound |
|---|---|---|---|
| `database` | `nova.db`, read-only, `PRAGMA quick_check(100)` (or `integrity_check(100)` with `?full=1`) in a worker | any line other than `ok`, or SQLite says the file is corrupt / not a database | the time bound: the worker is terminated at the deadline and the check is `unfinished` |
| `checkpoint` | the newest **sealed** checkpoint (`scanCheckpoints`), its database and files hashed against its own sealed manifest | any hash differs or a listed file is missing: that restore point is damaged and Nova won't restore it | the I/O budget and the time bound; past either, `partial` with how many were checked |
| `disk` | `statfs` on the home: free bytes, total bytes, free inodes | see thresholds below | one syscall |
| `fs_errors` | Linux ext4 only: `/sys/fs/ext4/<dev>/errors_count`, found through `/proc/self/mountinfo` for the home's mount; world-readable, no root | the count is above zero | two small reads |
| `smart` | nothing | never | — |

Why the checkpoint check compares a checkpoint with **its own** manifest, not the live home with
the newest manifest: Nova's live entries change every minute (the database, memory, logs), so a
live-vs-checkpoint comparison would flag ordinary use as damage. Bit-rot or tampering in a restore
point is the integrity question that matters, and it is the one a restore would otherwise discover
too late. Unsealed folders in `checkpoints/` (strays) are counted, not checked.

**SMART and other filesystems are not built.** SMART attributes need root (`smartctl`, the
`SG_IO` ioctl) or a vendor tool, and Nova never runs as root; btrfs device-error counters need a
privileged ioctl; macOS and Windows expose neither to an unprivileged process. They are reported
as `unavailable` with that reason in plain words, never as healthy. On a non-ext4 Linux home,
`fs_errors` is `unavailable` too.

### Disk thresholds

- **Stops (red, `stops: 1`):** free space is under what a pre-upgrade checkpoint needs (the
  database and its WAL, ×1.1, plus 1 MB: `takeCheckpoint`'s own rule), or under 512 MiB; or fewer
  than 1% of inodes (or 1,000) are free. At that point an upgrade stops and checkpoints refuse.
- **Needs the person (amber, `stops: 0`):** under 2 GiB or under 5% of the volume free; or under
  5% of inodes free.

## The bounds

- **Time:** 10 seconds for the whole scrub. The database check runs in a worker thread and is
  terminated at the deadline; checkpoint hashing reads in 1 MiB chunks and stops at the deadline.
  A check stopped by the bound is `unfinished` (database) or `partial` (checkpoint), **never `ok`**.
- **I/O budget:** 256 MiB hashed per scrub for the checkpoint check (files are taken whole, in
  manifest order, until the next would pass the budget). The database check reads the database
  at most once and is bounded by time, not bytes, because SQLite can't stop part-way by bytes.
- **One at a time, and not often:** a second request while one runs is refused (409), and so is
  one within 60 seconds of the last finishing. The person gets the reason in plain words.
- **Never during a write-heavy operation.** Refused (409) before anything is read when:
  - a promotion or handover is in flight (`promotions.record()` in a non-final state);
  - a checkpoint restore is staged (`stagedPending`);
  - a factory reset is staged (`factory-reset.json`);
  - a checkpoint is being written by another process (a `.partial-*` folder in `checkpoints/`:
    the supervisor checkpoints a stopped home).

  The guard is checked again between checks; if a write starts mid-scrub, the remaining checks are
  skipped as `stopped`. Nova's own checkpoints and backups run synchronously in the server's one
  thread, so they can't interleave with the main-thread part of the scrub; the worker reads with a
  separate read-only connection, which WAL allows alongside a writer.

## What "problem" means (for Health later)

The existing model, `Problem` in `src/core/log.ts`: a `source`, a plain-words `message`, a
`detail`, and `stops` (1 = red, Nova can't proceed; 0 = amber, needs the person). The scrub
returns its findings as `problems: { source: 'integrity', message, detail: null, stops }[]`, the
same fields, and **does not store them**: `log.problem()` writes to the database, which this
pass must not do. Whether Health later raises a scrub finding as a stored problem (so it reaches
the orb and the standby) is the owner's call, with the Health entry.

| Finding | stops |
|---|---|
| database corrupt or not a database | 1 |
| database check unfinished in the time bound | 0 (it says so; not a fault) |
| newest checkpoint damaged | 0 |
| disk at the "stops" threshold | 1 |
| disk at the "needs the person" threshold | 0 |
| filesystem errors reported by ext4 | 0 |

`ok` is true only when no check is `problem`; an `unfinished`, `partial` or `unavailable` check
leaves `ok` true but is listed in `incomplete`, so Health never shows a stopped check as healthy.

## The gate

- `tests/core/integrity.test.ts`, all on temp homes:
  1. a corrupt database (pages overwritten) is detected as `stops: 1`, and a header-corrupt one too;
  2. a full disk (an injected `statfs`) is detected, red and amber, inodes included;
  3. the output is redacted: no home path, no path at all, no file or checkpoint name, no planted
     content from the database, files or a named checkpoint;
  4. the time bound holds: a worker that never answers is terminated, the scrub returns within
     the bound plus a margin, and the check is `unfinished`, not `ok`;
  5. nothing is written: every file under the home is byte-identical before and after (and no
     file is created), for a closed home and for a running Core;
  6. a damaged checkpoint is detected, and the I/O budget yields `partial`;
  7. the busy guard refuses during a staged restore; one-at-a-time and the cool-down refuse;
  8. the route is mounted by `createCore` at person access.
- `npm run typecheck`, `npm test`, and the diagnostics tests stay green.

## Not built here

- The Health screen entry (owner's rendered-entry approval first).
- Raising findings as stored problems, a schedule for the scrub, or a scrub on the standby's
  copy: each writes or runs without a request, and each is the owner's call.
- SMART, btrfs/ZFS error counters, macOS/Windows filesystem errors (need root or aren't exposed).
