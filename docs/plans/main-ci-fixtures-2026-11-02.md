# Main CI fixture repair, 2026-11-02

Repair the two failures in main push run 41396575075 at f831cf3a9eb45908028b878794c8975aec04ac35 without weakening the security or UI gates. M10i's PR run was green; this subsequent main run is failed evidence, not an authorized blind rerun.

## Constraints

- Work only in the task-owned `codex/main-ci-fixtures` checkout. M10j's source writer continues in its separate checkout; this repair has no dependency on its uncommitted implementation.
- No changes to parked vault broker PR #275, owner data, actual credentials, cloud, Kubernetes, preview shim/proxy, or other owner worktrees. Findings B remain outstanding.
- Preserve every vault-history secrecy assertion, console/page-error collection, CORS/auth boundary, and layout assertion. No ignored access-control errors, arbitrary timeout increases, skipped cases, or baseline regeneration.
- Use existing Node 26 and existing Playwright Docker image only. Use owned temporary profiles and loopback servers for diagnosis. Save actual command output; distinguish reproduced evidence from hypotheses.
- Independent review, same-PR LEDGER entry, exact-head green CI, merge with matching head, and restart/verify the authorized preview before reporting completion.

## Task 1: diagnose and repair both fixture synchronization failures

Read the failed CI logs and the relevant source before changing it. The legacy vault-history test calls `commitHome` without awaiting its returned queued promise, sleeps for 50ms, then assumes `ensureGit` drains that queue. Verify the actual contract and replace the guessed completion with the returned promise; preserve all history assertions.

The fold-posture matrix reported WebKit iphone-large console errors for `/api/v1/resilience` and `/api/v1/problems` with access-control messages. Determine whether this is real CORS/auth failure, aborted navigation, or another lifecycle defect. Capture a deterministic real-browser reproduction before fixing it. Repair the actual synchronization boundary; retain genuine error detection. Prefer a narrow test-owned change when production is correct. Do not assume that the message is harmless or add an error filter.

Write focused regressions and capture RED then GREEN, typecheck, meaningful covering UI checks, and diff check. Report exact root causes, commands, logs, commit, limits, and any remaining findings.

## Task 2: review and integrate

Package the complete diff from f831cf3a9eb45908028b878794c8975aec04ac35. Obtain independent review of the fixes and security/assertion preservation, address findings test first, then record the evidence and LEDGER in this PR. Run the required full gates on the final head; merge only green and verify the preview after restart. Merge main into M10j afterward, never rebase its evidence branch.
