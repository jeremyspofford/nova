# M10h capture review fixes

Base: `acbda56b7f4ff83f4d5e54218b98e55d58523258`.
Implementation branch: `codex/m10h-capture-review-fixes`.

The independent synthetic review found three privacy failures: pending raw uploads bypassed a change to cloud placement; replicas copied raw bytes without the metadata needed to delete recovery copies; and a failed off-consent deletion was marked seen and never retried.

## Changes

- Raw request offers and uploads now check current home placement and current screen consent. The plan explicitly states whether raw is allowed. The carrier requires both sync and raw permission, refreshes permission before reading an original and again before sending it, and fails closed when permission cannot be refreshed. Cloud raw remains unavailable in every privacy mode until per-device opt-in exists.
- `capture_raw_fetch` metadata now replicates with insert/update/delete triggers, preserving the event-to-file mapping used by recovery cleanup and recall after takeover.
- Off-consent discard IDs are saved before deletion, retained on failure, retried across restart (including an inactive/off carrier), and reported through carrier status. Successful ordinary sync does not clear a pending deletion error.

## Test-first evidence

RED commit: `db32fcfe` (`test(capture): reproduce raw policy and deletion failures`). Its eight focused tests failed for the expected privacy defects; full output is task-owned at `/tmp/nova-m10h-capture-red.log`.

Root review then requested inactive/off restart and independent sync-denial checks. Those three checks failed before their corresponding fixes; output is `/tmp/nova-m10h-capture-additional-red.log`.

Final regression run: **10 passed, 0 failed**. It covers cloud changes in local-only and local-preferred modes, pause/disable during a pending request, real replication and replica checkpoint cleanup, deletion failure followed by inactive/off restart, raw permission changes before read/send, and explicit sync-denial checks.

Existing focused capture, replication and backup checks: **26 passed, 0 failed**. Typecheck and `git diff --check` passed. Full project `npm test` was also launched; its result is recorded separately after completion.

Commands, from the implementation worktree, using Node 26.3.1:

```sh
node --test tests/core/capture-privacy-regressions.test.ts
node --test tests/core/capture-sync.test.ts tests/core/capture-carrier.test.ts tests/core/mesh-sync.test.ts tests/core/backups.test.ts tests/core/resilience-backup.test.ts
npm run typecheck
npm test
git diff --check
```

Regression tests use disposable homes, generated synthetic keys, made-up capture text/raw bytes, and loopback listeners with dynamically allocated ports. They do not access owner data, a real capture service, cloud services or external targets. No source files outside the assigned capture/replication/migration scope were changed.
