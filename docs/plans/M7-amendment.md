# M7 amendment plan: checkpoints and factory reset

The owner's amendment of 2026-10-30, now part of ROADMAP-AND-GATES M7. It is binding and not a new milestone. M7 itself is merged (#219), so this is M7's remaining work, shipped as its own PR.

The packet sources:
- NOVA-SPEC §6: tiers. Destructive actions confirm every time.
- NOVA-SPEC §7: backups with a tested restore.
- LOCAL-FIRST §5.
- DESIGN-SYSTEM §1's perception principles: one standout per view, with destructive actions always standing out; real state only.
- The owner's standing order 4: forgetting holds in backups too, and a checkpoint is a backup.
- OPERATING-RULES: Tier 3 for destructive and security actions.

**Builds on M7b:**
- `src/core/resilience/backup.ts`: a consistent `VACUUM INTO` snapshot, a file walk with hashes, a sealed manifest, forget-cleaning, the encrypted copy and the recovery key.
- `src/core/backups.ts`: the pre-upgrade database copies, and the `also` forget hook.
- `src/supervisor/*`: code releases and the restore across a migration.
- The UI's confirmation pattern: a required "confirm" checkbox, tier 3, and the hub's own screen for the most dangerous actions (as with seeing the recovery key again).

**Rules as before:**
- no runtime dependencies;
- erasable TypeScript in `src/core`, vanilla JS in `ui/`;
- neutral placeholders;
- every behaviour tested, written test-first.
- Tests run only on throwaway homes and never touch the owner's preview home (`~/Nova-preview`) or any other real home.

## 1. Checkpoints (`src/core/resilience/checkpoints.ts`)

**What a checkpoint is.** A restore point of the **whole** data home:
- the database, as a consistent snapshot;
- memory files, config and design state;
- the vault file;
- the vault key if it is a file;
- the node identity (`mesh/identity.json`).

It differs from a nightly backup on purpose. A checkpoint never leaves this machine, so it may hold the identity and the vault key file. It lives in `<home>/checkpoints/<seq>-<slug>/`, with folders 0700 and files 0600, and a sealed manifest in the nightly format: id, seq, name, kind `auto|named`, reason, at, nova_version, schema_version, files with sha256 and bytes, and total bytes.

**Never inside a checkpoint:**
- `checkpoints/` itself;
- `backups/` and `exports/`;
- `logs/`, `kept/`, `workers/` scratch;
- `nova.pid`;
- the home's `.git`.

Nightly backups gain `checkpoints` in `SKIP_TOP` ("checkpoints stay on this machine and are restore points, not backups").

**When Nova takes one automatically (kind `auto`):**
- before the change pipeline applies a change live, at ship and before the canary applies. A failed checkpoint stops the ship: the change waits, with the reason in plain words, and is never shipped without one;
- before a database upgrade, alongside the existing pre-upgrade copy in `db.ts`, on the same open path;
- before the supervisor switches to a new code release. The supervisor calls the same core function on the stopped home;
- before a restore, as "Before restoring to ‹name›", so the restore can itself be undone.

**Named checkpoints:** taken from Settings › Backups › Checkpoints with a name of up to 80 characters. This is tier 1 (act and report).

**Listed:** in Settings, and via `GET /resilience/checkpoints`, newest first, each with:
- name or reason;
- kind;
- date;
- size, in human units;
- the Nova version.

**Retention, stated in the UI and in the ledger:**
- The newest **10** automatic checkpoints are kept, counted by sequence number and never by date. The clock can't make Nova delete the wrong ones.
- Named checkpoints are kept until the person deletes them.
- A new checkpoint is complete before any old one is pruned.
- If the disk is too full to take one, Nova refuses in plain words. An automatic one that was needed stops what needed it (above). Nova never deletes a named checkpoint to make room.

**Delete:** a named checkpoint can be deleted from the list (tier 2).

**Forgetting holds in checkpoints:**
- `Backups.also` registers the checkpoints, so every forget cleans each checkpoint's database copy and its memory files, the same way nightly backups are cleaned.
- A checkpoint that can't be cleaned is destroyed, and that is reported.
- A restore can never bring back something the person had Nova forget.

**Restore (tier 3, confirmed every time, from the hub's own screen only).** The confirmation says plainly:
- the checkpoint's date;
- that everything since then is undone: tasks, memories, settings, changes;
- that a checkpoint of now is taken first.

What restoring keeps from now, and never rolls back:
- **Revocations and the roster's trust decisions:** a device revoked since the checkpoint stays revoked. Devices paired since the checkpoint are dropped, and the confirmation says they'll need pairing again.
- **The mesh epoch:** it becomes the maximum of now and the checkpoint, plus one. A standby is told to copy afresh, so fencing never turns against the restored hub.
- **Forgets:** already carried into the checkpoint, as above.
- **Open problems:** carried over, as releases already carry them.

How the restore runs:
- **Crash-safe:** a restore is staged as a marker, then applied when Nova starts, before the database opens, by swapping folders. A crash in the middle leaves the old home or the new one, never a mix, and the marker finishes the job on the next start.
- **No manual step:** under the supervisor, Nova asks it to restart. Without it (the plain `node src/server.js` the preview uses), Nova restarts in-process: close, apply, open again. The builder picks the mechanism; the person never has to restart anything.
- The result is a ledger task with evidence: the checkpoint id, the manifest hashes it verified before applying, and what was carried over.

**As built (§1, branch `m7-amend/checkpoints`).** The details are in the ledger (2026-10-30, M7 amendment: checkpoints).

- **Where:** `src/core/resilience/checkpoints.ts` (taking, listing, retention, forgets, staging and applying a restore, the service and its routes), `restore.ts` (what a restore carries over from now) and `restart.ts` (restarting in place). A checkpoint has a nightly backup's layout (`nova.db`, `files/<rel>`, `manifest.json`), so `cleanBackup` cleans both. Its seal key is `checkpoints/.seal` (0600), not the vault: the supervisor can checkpoint a stopped home, and a restore can't lose the key.
- **Only Nova's own entries, by name** (`src/core/resilience/entries.ts`: `NOVA_ENTRIES`, `isNovaEntry`, `foreignEntries`; derived from every place the code writes under the home, listed in its header). A checkpoint copies only these (still without checkpoints, backups, exports, logs, kept, workers, nova.pid and `.git`); a restore stages and swaps only these. Anything else in the folder (the preview home's proxy script) is never in a checkpoint, never moved and never undone, whether it was made before the checkpoint or after; the confirmation says “Files in this folder that aren’t Nova’s are left as they are.” Capture has no folder (it lives in the database). The factory reset imports the same list.
- **Routes:** `GET /resilience/checkpoints` (the list, the retention rule, `can_restore`, a restore in progress); `POST /resilience/checkpoints {name}` (tier 1); `POST /resilience/checkpoints/{id}/delete {confirm}` (tier 2, approver, named ones only; a POST because the API reads no body on DELETE); `GET /resilience/checkpoints/{id}/restore` (the confirmation's words); `POST /resilience/checkpoints/{id}/restore {confirm}` (tier 3, the console only).
- **Automatic:** at ship and before a canary that hasn't applied yet (`ChangesOptions.checkpoint`; none, and the change is `waiting` with "Not shipped: Nova couldn’t take a checkpoint first…", the Ship task blocked; "Ship it" tries again); before a database upgrade (`Db.migrate({before})`, beside the pre-upgrade copy; none, and no upgrade); before a release switch (the supervisor, on the stopped home; none, and no switch); before a restore.
- **Restore:** verify every hash, copy the checkpoint into `checkpoints/.restore/new`, take "Before restoring to ‹name›", carry over from now, write `marker.json`, then restart. `finishStaged(home)` runs first thing in `createCore` (and in `createNova`, before seeding): each top-level entry moves aside into `.restore/old` and the staged one moves in, by rename; every step can be repeated, so a crash part-way is finished at the next start. The record stays as `checkpoints/restores/<id>.json`; at start the hub makes it a `checkpoints` ledger task (once), whose confirmation Nova checks against that record, the sealed manifest and the mesh epoch.
- **Kept from now:** revoked devices (their rows), the stricter of then and now for approving, sign-ins that ended, no pairing code from then; `mesh/` (this node's keys and role: keys are never put back); the epoch, max(now, checkpoint) + 1; forgets (the "forgotten" notes and capture tombstones, and anything they name removed again); problems, matched by time, source and message, resolved ones staying resolved; Nova's backup records (`backup_run`, `backup_drill`, the recovery key it showed) and its own vault keys (`nova/*`), so backups made since stay Nova's and forgets still reach them. A standby that sees its own hub at a higher epoch drops what it copied and reads the hub's log from the start (`SyncLog.fresh`).
- **Restart in place: `core.restartInPlace(why): Promise<{how: 'supervisor' | 'in-place', said}>`** (`Restarter`, `resilience/restart.ts`). Call it after staging a marker. Under the supervisor it sends `restart` with `staged: true`; the supervisor restarts the server only if `stagedPending(home)` is true, and that restart counts neither toward safe mode nor toward the one-a-minute limit. Without the supervisor, `src/server.js` attached a release hook at start: about 150 ms after the call returns (the reply goes out first), it stops both listeners, closes the core, and the process re-executes itself (`process.execve`: same pid, terminal, environment and ports, with any port 0 filled in). With neither, it throws, and the staged work is applied at the next start. **For the reset builder:** stage your marker, add its check to `stagedPending` and its apply to `finishStaged` (both in `checkpoints.ts`), then call `restartInPlace`.
- **UI:** Settings › Backups › Checkpoints (`ui/js/checkpoints.js`): the retention rule, taking one (the standout while nothing is being confirmed), the list, restore asking every time with the server's words and a required checkbox (then its button is the one standout), delete asking first. Restore isn't offered off the hub's own screen.
- **Not exercised by tests:** on a platform without `execve` (Windows), a detached replacement is started and the process exits.

## 2. Factory reset (`src/core/resilience/reset.ts`)

**Where:** Settings › Danger zone, last on the Settings page, visually set apart. The reset button is that view's one standout. It is tier 3, from the hub's own screen only, never from a paired phone or browser, and confirmed every time with the same required checkbox pattern.

**Flow:**
1. **Export first.** Offered and recommended, but not forced.
   - It writes the export to a folder the person names. Nova never creates that folder, the same rule as backups.
   - The export uses the encrypted-copy format, keyed by a **fresh recovery key shown once**, plus the plain memory files (`memory.json`, `memory.md`), which come from the existing memory export.
   - It holds the database snapshot and the home's files. It does not hold the vault key, the identity or saved secrets, and the screen says so: "Your saved passwords and keys aren't in the export; you'll add them again."
   - The export folder is the person's: a factory reset never touches it.
2. **Confirm.** The confirmation lists exactly what will be wiped, and what will not be (below), then a required checkbox: "I understand this erases Nova on this machine, and I want to start over."
3. **Wipe:**
   - the data home's **own** entries, by name: the database and its WAL/SHM, memory files, config, vault, mesh (identity, roster, sessions), checkpoints, pre-upgrade backups, the home's git history, logs, scratch, workers, kept, captures and connectors;
   - the vault key in the OS keychain;
   - every nightly backup and encrypted copy in **every folder Nova ever backed up to** (from `backup_run`), Nova's own sealed ones only. Strays and unknown files are never touched.

   Anything else in the home folder, which Nova didn't make, is left in place and listed afterwards. The preview home really does contain a file that isn't Nova's.
4. **The mesh:**
   - Before wiping, the hub tells every reachable paired device it has been reset. Each device ends its session. A **standby** wipes its replica of the hub's data, and reports back.
   - A device that can't be reached can't be told. The confirmation says so beforehand, and the result names it: its copy stays on that device until it is reset or removed there.
   - The hub's identity is gone, so no old device can reconnect to the new Nova.
5. **Then:** Nova comes back in first-run state, with a new identity and an empty roster, and opens first-run setup. No manual restart is needed (the same mechanism as restore).

**Backups (the owner's expectation, met):** existing backups are wiped too, after the export offer. Two cases can't be helped, and both are said plainly before and after:
- A backup folder that isn't reachable at the time, such as an unplugged drive, can't be wiped. The confirmation names it beforehand, and the result says it still holds backups.
- The supervisor's code releases are code, not data. They stay.

**Crash-safe:** a reset is staged as a marker and finished at the next start if interrupted. A half-reset Nova never runs.

**Evidence:** the reset's result, shown on the first-run screen and kept in a small `reset-report.json` in the new home. It lists what was wiped, which folders were wiped, what was left (and why), and which devices were told.

**As built (§2), branch `m7-amend/reset`.** The ledger has the decisions (2026-10-30, factory reset).
- **Where:** `src/core/resilience/reset.ts` (`FactoryReset`, `finishReset`), routes `GET /reset`,
  `POST /reset/export`, `POST /reset` (202), `GET /reset/report`, and the standby's
  `POST /mesh/reset/ack`. Every route but the ack is the hub's own screen only; `POST /reset`
  also needs `confirm: true`. UI: `ui/js/reset.js` (Settings' last part, `#danger-zone`), the result
  on the first-run screen (`ui/js/setup.js`), styles in `ui/styles/reset.css`.
- **The export:** a `nova-export-<time>/` folder inside the folder the person names, holding
  `nova-export.nbk` (archive.ts' format, a fresh key, returned once and kept nowhere), `memory.json`,
  `memory.md` (the memory export, written there) and a README. `vault/` and `mesh/` are left out
  whole, and the manifest says so. It opens with `openEncrypted` and the recovery key alone.
- **Staging:** `factory-reset.json` in the home names exactly what goes: Nova's own entries (by name,
  `NOVA_ENTRIES` in `entries.ts`, shared with checkpoints), the vault ids whose keychain item goes, each of Nova's sealed backups and encrypted
  copies with its seal or header nonce, the strays, and the folders that aren't there. It stays out of
  backups, sandboxes and sync, and acts only on the home it names.
- **Telling devices:** the hub's stream sends `reset` (phones and browsers with one open); a
  computer's heartbeat reply carries `hub_reset`, and its agent stops for good, in its own words; the
  standby's next sync answer carries the notice, and it deletes every replicated row, vacuums, removes
  the vault and its key and the copied files, stages its own marker for the rest, then acks. The hub
  waits up to 45 s for those it can reach, then ends every session. Who was and wasn't told goes into
  the marker, then the report.
- **Finishing:** `finishReset` runs from `finishStaged` (checkpoints.ts), at the top of `createCore`
  and of `createNova` (before the home is seeded), and goes before a staged restore: the vault's key (`Vault.forgetKeys`), the backups (each checked again; one that changed is
  left and said), the home's own entries, Nova's leftover scratch, then `reset-report.json`, then the
  marker. A step that throws stops the start: a half-reset Nova never runs.
- **Restart:** once devices are told, `restartInPlace` (restart.ts): the supervisor's staged restart
  (`stagedPending` includes the reset's marker), or the server re-executing itself. The page then
  opens first-run setup by itself. Until Nova is down it refuses every change. A core with nothing
  that can restart it (a test) finishes at its next start.

## 3. Tests (the definition of done)

- **Checkpoints:**
  - automatic before ship, upgrade and release, and before restore;
  - named;
  - listing with sizes;
  - retention by sequence, with named ones kept;
  - disk full refuses, and stops the ship;
  - forget cleans checkpoints;
  - restore round-trip: data back, identity the same, revocation kept, epoch raised, problems carried, standby told to resync;
  - a crash mid-restore finishes on the next start;
  - restore refused from a paired device, and without confirmation.
- **Factory reset:**
  - export round-trip: opens with the recovery key, with memory plain files present;
  - the wipe removes every Nova entry and keeps foreign files;
  - backups wiped in every recorded folder, with strays untouched;
  - an unreachable backup folder reported;
  - keychain key removed (through the vault's own key abstraction, with a stand-in keychain);
  - the standby wipes its replica;
  - an offline device reported;
  - a crash mid-reset finishes on the next start;
  - refused from a paired device, and without confirmation;
  - afterwards: first-run setup with a new identity and an empty roster.
- **Acceptance**, `tests/acceptance/m7-checkpoints-reset.test.ts`, on a real server process:
  1. take a named checkpoint;
  2. change things;
  3. restore, with no manual restart;
  4. export;
  5. factory reset;
  6. first-run setup;
  7. the export opens.

  The egress tripwire stays empty throughout.
- **Browser:** `tests/ui/m7-checkpoints-reset.test.ts` (in Docker): the checkpoints list, restore's confirmation, the danger zone flow with the export step and the confirmation, one standout per view, and the posture sweep still passing.

## Order

Two builders, in parallel, with file ownership:
- **Checkpoints:** `checkpoints.ts`, the restore mechanism and the Checkpoints UI.
- **Factory reset:** `reset.ts`, the export, the wipe, the mesh messages and the Danger zone UI.

The restart-in-place mechanism belongs to the checkpoints builder. Reset uses it once that branch has it; until then, reset stages its marker the same way. Shared files (`src/core/index.ts` routes, `ui/js/settings*`, the ledger) get small, additive edits. The integrator merges both, then runs the acceptance and browser tests.
