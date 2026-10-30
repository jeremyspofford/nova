# M7 amendment: checkpoints and factory reset. Evidence

Run 2026-10-30 on `m7-amend/checkpoints-reset` at `6dc74b4a`, which includes main at `58be568d`. Every process is real, and every home is a throwaway test folder.

- `npm test`: 794 tests: 786 pass, 0 fail, 8 skipped (the opt-in real-model runs).
- Browser suite (`scripts/ui-test.sh`, Playwright container): 30 of 30 pass.
- Typecheck, token lint and theme checks: pass.
- Three rounds of independent review (checkpoints once; reset three times, the last one on the integrated branch). Every finding was fixed with a test that failed first. They are listed in the ledger.

## End to end, on one real server process

`tests/acceptance/m7-checkpoints-reset.test.ts`, with the same process and port throughout and the egress tripwire empty:
- ✔ restore with no manual restart: the same process comes back on the same ports with the checkpoint’s data, and records the restore
- ✔ M7 amendment: checkpoint, change, restore, export, factory reset, first run, the export opens — no manual restart, nothing leaves the machine

`tests/core/checkpoints.test.ts`

- ✔ a named checkpoint holds the whole home, identity and vault key included, and nothing that isn’t the home’s; folders 0700, files 0600, a sealed manifest
- ✔ listed newest first with name or reason, kind, date, size in human units and the Nova version; the retention rule is stated
- ✔ retention: the newest 10 automatic checkpoints by sequence, never by date; named ones stay; the new one is complete first
- ✔ a disk too full refuses in plain words, keeps nothing half-made, and never deletes a named checkpoint to make room
- ✔ deleting a named checkpoint is tier 3: confirmed every time, from the hub’s own screen only; automatic ones are kept by the rule
- ✔ at most 20 named checkpoints: the next is refused in plain words, so no device can fill the disk with them
- ✔ a half-taken checkpoint is never left holding data: removed at start and before every forget
- ✔ forgetting reaches every checkpoint: its database and its memory files, hashes rewritten and sealed; one that can’t be cleaned is destroyed and reported
- ✔ nightly backups and the standby’s journal leave checkpoints out
- ✔ Nova takes an automatic checkpoint before a database upgrade, beside the pre-upgrade copy
- ✔ a fresh home and a sandbox copy take no checkpoint at start

`tests/core/checkpoints-restore.test.ts`

- ✔ a restore round trip: the data goes back; revocations, the epoch, problems and forgets stay; devices paired since are dropped; a checkpoint of now first; a ledger task with evidence
- ✔ restoring is the hub’s own screen’s only, confirmed every time; a damaged checkpoint isn’t restored
- ✔ a crash in the middle of a restore: the next start finishes it; Nova never opens a mix
- ✔ files in the home that aren’t Nova’s are never in a checkpoint, and a restore leaves them exactly as they are, made before it or after
- ✔ a staging that stopped before it was sealed is dropped: Nova starts on the home as it was
- ✔ a restore whose restart can’t happen is dropped at once, said plainly: it never fires later
- ✔ a staged restore that is incomplete or changed is never applied: dropped, Nova starts as it was, and says why
- ✔ a disk too full to stage a restore refuses in plain words; a full disk after the swap never stops Nova starting

`tests/core/checkpoints-ship.test.ts`

- ✔ a change takes a checkpoint at ship, before the canary applies it
- ✔ no checkpoint, no ship: on a full disk the change waits with the reason, and ships once one can be taken

`tests/core/checkpoints-standby.test.ts`

- ✔ a restore on the hub: the epoch goes up, and the standby copies the hub afresh

`tests/supervisor/checkpoints.test.ts`

- ✔ before switching to a new release, the supervisor takes a checkpoint of the stopped home
- ✔ a restore under the supervisor: it restarts Nova itself, twice in a row if asked, and that is no crash

`tests/core/reset.test.ts`

- ✔ the wipe takes every Nova entry by name, keeps the person’s own files and lists them; afterwards it is first run, new identity, empty roster
- ✔ backups go from every folder Nova ever backed up to, its own sealed ones only; strays stay; an unreachable folder is said before and after
- ✔ the vault’s key leaves the keychain, through the vault’s own key abstraction
- ✔ a reset stopped half way finishes at the next start; a half-reset Nova never runs
- ✔ only the hub’s own screen may reset or export, and a reset is confirmed every time
- ✔ once devices are told, work stops and Nova restarts in place to finish: under the supervisor, a staged restart
- ✔ a restart that fails: the reset finishes when Nova starts next, said plainly, and nothing new is taken until then
- ✔ a forged reset marker (one Nova didn’t seal) erases nothing: Nova starts as it was, says so, and keeps it aside
- ✔ a marker changed since it was staged, or junk, is never acted on either: a normal start, said, kept aside
- ✔ a reset is refused for a home that is your own home folder (or contains it), and for a folder without Nova’s mark
- ✔ an existing home from before the mark gets it at its next start; one holding another database doesn’t
- ✔ a backup that finishes after staging, and a half-written one, are erased too
- ✔ a file named like an encrypted copy that doesn’t open under the backup key is never erased
- ✔ a folder already holding workspace/ and .git/ that aren’t Nova’s is refused at start, in plain words
- ✔ an Era 2 home (its standing files, memory and workspace, no nova.db yet) is Nova’s own: adopted whole
- ✔ things already there that aren’t named like Nova’s are adopted, left alone through a reset, and said
- ✔ when Relay was on or used, the confirmation and the result say its work stays in Relay
- ✔ a home that was new and empty is erased whole; so is an existing Nova home
- ✔ a finished reset whose marker was left behind is recognised and cleared quietly
- ✔ after a reset, the hub’s own screen is told once to clear what it kept; a paired device never

`tests/core/reset-export.test.ts`

- ✔ the export opens with the recovery key shown once, has the memory files in plain text, and holds no secrets, vault key or identity
- ✔ an export through a link into Nova’s home is refused, and an export gone by the end is said to be gone

`tests/core/reset-mesh.test.ts`

- ✔ the hub tells its devices before the wipe: the standby wipes its copy and reports back, a computer hears it at its heartbeat, a phone on its stream; one that can’t be reached is named

`tests/reset-server.test.js`

- ✔ after a reset Nova comes back seeded fresh: new standing files, no old conversations, setup open
- ✔ after a reset, the first-run page and setup tell the browser to clear what it kept

`tests/core/entries.test.ts`

- ✔ Nova’s own top-level entries, by name; everything else in the home is foreign

## Browser

`tests/ui/m7-checkpoints.test.ts`, `tests/ui/m7-reset.test.ts`, and the posture sweep: pass in the Playwright container.
