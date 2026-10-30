# M7 gate — evidence

Run 2026-10-30T09:25:54Z on branch `m7/self-modification` at `fc5af3ac`, on this machine (RTX 3090, 31 GB RAM). Every process is real; providers are stand-ins except the opt-in real run, which used the local Ollama (read and infer only).

## 1–4. Nova ships a real change to itself; sabotage is caught; gates can’t be weakened
`tests/acceptance/m7a-changes.test.ts`, `tests/core/changes.test.ts`

- ✔ M7a: the foundry ships a wind-down reminder through every gate, with the tier-3 OK; the record reaches the standby; skipping and weakening are refused
- ✔ M7a: sabotage that passes the sandbox fails live and is rolled back by itself: the previous version, Failed with the probe’s reason, a problem, nothing else changed
- ✔ a good change, end to end: sandbox, tests, health, a release in the home’s history, a canary, promoted, and every stage in the ledger
- ✔ sabotage caught by the tests stops in the sandbox and is never offered: a broken test, an invalid manifest
- ✔ sabotage that passes the sandbox but fails live: rolled back by itself, the previous version restored, Failed with the probe’s reason, a problem opened, nothing else changed
- ✔ the gates can’t be weakened or skipped: a change that tries is refused and kept on the record
- ✔ tier 3 every time for what a provider or the foundry proposes, and for privacy settings; the OK needs confirming and comes after the sandbox evidence
- ✔ rolling back by hand: tier 2, the previous version comes back and is live again
- ✔ every kind goes through: a design system on one device then everyone, a setting, a decision template
- ✔ the foundry: the stand-in local model writes a wind-down reminder pack in its own folder; proposed at tier 3, it ships after the OK and fires on the test clock

### The same, with a real local model (`tests/acceptance/m7a-real-ollama.test.ts`, `NOVA_REAL_OLLAMA=1`, not CI)

- Model Qwen3:8b at http://127.0.0.1:11434, 31 s to write. Foundry task: done — Wrote “Wind down” v1.0.0 (manifest.json, tests.json, probe.json) and proposed it. It is checked in a sandbox, then waits for your OK.
- Change “Wind down” v1.0.0: waiting — Waiting for your OK. It changes Nova itself, so it is confirmed every time.
- After its canary: live.
- ✔ M7a evidence: the foundry on a real local model, through the pipeline (31466.094316ms)

## 5. Code releases through the supervisor
`tests/supervisor/releases.test.ts`

- ✔ a good release deploys only with a tier-3 confirmation, canaries, and stays; the data is untouched
- ✔ a sabotaged release that breaks health after the switch is rolled back automatically, data intact, with a problem and its playbook
- ✔ a release whose own tests fail stops before the switch; nothing changes
- ✔ going back across a database upgrade: refused with the reason when something was written since, restored from the backup when nothing was

## 6. Backups and the restore drill
`tests/core/resilience-drill.test.ts`, `tests/core/resilience-backups.test.ts`

- ✔ a backup holds a consistent snapshot and the home’s files, with hashes; never the vault key or the private keys
- ✔ retention keeps the newest by sequence, even when the clock went back; old ones go only after a new one is complete
- ✔ the encrypted copy: unreadable without the vault key, restored whole, refused when changed
- ✔ forgetting holds in the nightly backups and the encrypted copies: the database and the files are cleaned
- ✔ a backup folder that isn’t there is refused, never created; the task fails into its playbook, which retries once it is back
- ✔ the drill passes on a good backup, as a ledger task with its evidence, and from the encrypted copy
- ✔ a corrupted backup is caught by the drill: a failed task, a problem with its playbook
- ✔ a backup whose database passes its hash but fails SQLite’s own check is caught too

## 7. The chaos pass, with repair playbooks
`tests/chaos/*.test.ts`

- ✔ the clock jumps forward while Nova runs: noticed, said, schedules run once (not once per missed day), and old capture isn’t deleted while it’s in doubt
- ✔ the clock went back while Nova was off: noticed at start, schedules put back on time, future-dated device sign-ins ended
- ✔ the database fills up: the write is refused, nothing saved is lost, the problem is still shown (from memory), and writing works once there is room
- ✔ the disk fills while saving a secret: refused in plain words, the vault still holds what it had, a problem with its playbook
- ✔ the disk fills while writing a backup: it stops cleanly, the earlier backups are untouched, a problem with its playbook; the backup folder missing is refused, never created
- ✔ a dead hub: the standby takes over (failover turned on), and the problem says what happened, with its playbook
- ✔ a crash is restarted with a growing wait, and told as a problem with what the supervisor did
- ✔ a server that stops answering is restarted
- ✔ a crash loop goes to safe mode: held, the reason written down, the page says what to run; recover tries again
- ✔ the standby partitioned from the hub: behind is a problem on both sides, and both close once it copies again
- ✔ a slow link: sync keeps up, slowly, with no false alarm and no failover
- ✔ a device offline: shown as offline, its queue kept, and on reconnect each item taken in exactly once
- ✔ a device agent in safe mode: a problem with its playbook; Nova asks its boot agent once to restart the runtime; it closes when running again
- ✔ DNS failing: a connection that can’t reconnect because its name won’t resolve says so, and closes once the name resolves again
- ✔ the local model dies mid-call: the work waits (local-only), a problem with its playbook, and it heals when the model is back
- ✔ a CLI agent that crashes mid-task: failed in plain words, a problem with its playbook, the worker checked again
- ✔ a CLI agent that hangs is stopped at its time limit, said plainly, with the playbook
- ✔ a provider that answers garbage: nothing is applied, the task fails in plain words, with the playbook

## 8. Re-run after the review fixes

Run 2026-10-30 on `m7/self-modification` at `4001a3de`. That commit merges `m7-fix/changes` and `m7-fix/resilience`, and every fix has a test that failed on the code before it.

- `npm test`: 679 tests, 674 pass, 0 fail, 5 skipped (the opt-in real-model runs). Run twice at this commit, the same both times.
- Browser suite (`scripts/ui-test.sh`, Playwright container): 28 of 28 pass.
- `npm run typecheck`, `lint:tokens` and `check:themes` all pass.
- The real Claude Code run for M5 (owner OK'd, one small run) is recorded in `docs/evidence/m5-claude-code.md`.
- A test bug found and fixed: "a good change, end to end" expected a rule pack's cases in a fixed order. The sandbox runs them in time order from its real clock, so after noon UTC the order flipped. It now checks them by name. Nova's behaviour was right.

The review-fix tests:

`tests/core/changes-guards.test.ts`

- ✔ a forged ship or rollback task is refused at every way in, and a waiting tier-3 change stays waiting
- ✔ the pipeline runs only its own tasks: a brief for a change from any other task is refused, and the approval on record is the ledger’s own
- ✔ a rule pack whose task would run elsewhere is stopped before its tests, and the person’s real backup folder is untouched (the reviewer’s leak)
- ✔ a sandbox copy is inert: backup, capture, provider and model settings are blanked
- ✔ in a sandbox copy a firing rule records its task without starting it
- ✔ rolling back an extension puts its state back exactly: installed, not enabled
- ✔ rolling back an extension leaves a binary file it never touched byte for byte
- ✔ rolling back an extension puts back a large file it overwrote
- ✔ rolling back a brand-new extension leaves nothing behind, whatever it keeps or exports on removal
- ✔ rolling back by hand during a canary happens now, and ends the canary
- ✔ a rule pack’s approval shows each task’s worker, inputs, tier and privacy
- ✔ ship and roll back are for an approver, not any paired phone or browser
- ✔ a design system’s canary device must be the hub or one of the person’s paired devices
- ✔ a canary’s window is measured on a clock that can’t jump: the wall clock leaping ahead doesn’t promote it
- ✔ a promotion that fails rolls the change back instead of leaving it in its canary
- ✔ a change whose canary began but whose apply never finished is applied when its task runs again
- ✔ a change whose artifact no longer matches its release isn’t applied
- ✔ rolling back a design system puts back only what it changed, not another device’s choice

`tests/core/resilience-forgetting.test.ts`

- ✔ a forget while the backup drive is unplugged is owed to it, said plainly, and carried in when it is back
- ✔ an owed forget is carried in before a backup run or a prune touches the folder
- ✔ a forget reaches the backups in a folder that is no longer the setting
- ✔ the drill checks every kept backup for forgotten things, not only the newest

`tests/core/resilience-trust.test.ts`

- ✔ a manifest naming a path outside the backup restores and cleans nothing outside it
- ✔ only backups Nova recorded count: planted folders are ignored, reported, and push nothing out
- ✔ backups are the person’s alone: folders 0700, files 0600, and a folder others can write is refused
- ✔ the encrypted copy opens with the recovery key shown once, without this machine’s vault

`tests/core/resilience-repairs.test.ts`

- ✔ a crash the supervisor handled closes once Nova is up, and Nova never restarts a healthy server for it
- ✔ restarting Nova, choosing the backup folder and seeing the recovery key again are not any paired phone’s
- ✔ freeing scratch deletes only Nova’s own leftovers, never a folder another process is using

`tests/supervisor/guards.test.ts`

- ✔ a repair’s restart: at most once a minute, and it counts toward safe mode like a crash
- ✔ “base” runs the commit pinned when the supervisor started, never the checkout as edited since
- ✔ the supervisor’s folder must be the person’s alone
- ✔ a tag named current or base is never a release, and a switch that fails puts the running release back
- ✔ going back with nowhere to go keeps safe mode; the socket wants what the person typed
- ✔ a refused rollback whose release won’t start again is held in safe mode, not left stopped

`tests/supervisor/rollback-mark.test.ts`

- ✔ work a new release did on starting counts: going back is refused rather than undo it
