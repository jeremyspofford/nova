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
