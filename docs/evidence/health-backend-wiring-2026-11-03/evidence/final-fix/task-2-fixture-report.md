# Qualification Task 2 — fixture alignment report

**Status:** complete; RELEASE to root for ordinary exact-head CI and branch review.

## Change

At `tests/acceptance/m10g-review2.test.ts:254`, the existing `pair({})` setup now starts before the diagnostics assertions. `knownSecrets` receives `p.a.core` and `p.a.home`, satisfying the required valid mesh identity scan. The secret scan and summary checks now run inside the existing `try/finally`; `stop(p)` remains the cleanup. No production files, imports, fixture families, skips, or weakened assertions were added.

All original assertions remain: agent environment excludes `NOVA_MESH_NAME_TOKEN` and preserves `PATH`; the supplied token is included in known secrets; summary names the saved secret and memory record; `raiseEpoch` rejects beyond the ceiling; promotion returns 409 and records the ceiling reason. The narrow run exercised all assertions and cleanup.

## Qualification evidence

Launcher: `.superpowers/sdd/health-backend-wiring-2026-11-03/evidence/final-fix/launcher.py`. It recorded Node 26.3.1, cached Playwright image `mcr.microsoft.com/playwright:v1.56.1-noble` with `--pull=never --network=none`, readonly workspace/dependency/Node mounts, private temporary HOME, and the no-Kubernetes tripwire. Each raw invocation record includes argv, cwd, timestamps, status, host HEAD, and changed blob map. The documented readonly Git metadata overlay identifies historical `f9ffbb0c...`; the real host HEAD at invocation was `4e7278d1b662a376ea3c6d2fe2e543830e2b55a8`. This evidence does not claim about.build or hosted exact-final-head CI.

- RED command: `python3 .superpowers/sdd/health-backend-wiring-2026-11-03/evidence/final-fix/launcher.py qualification-r1-red sh scripts/test.sh --import ./tests/acceptance/egress-guard.ts --test-concurrency=1 --test-timeout=120000 '--test-name-pattern=minor: the name token never reaches' tests/acceptance/m10g-review2.test.ts`
  - Exit 1, 1 test / 0 pass / 1 fail / 0 skipped; `changed_blobs` empty. Failure was the fixed `SecretScanUnavailable` message from `knownSecrets` before assertions, confirming R1.
  - Raw: [`qualification-r1-red.json`](qualification-r1-red.json), [stdout](qualification-r1-red.stdout), [stderr](qualification-r1-red.stderr).
- GREEN command: same invocation with unique label `qualification-r1-green`.
  - Exit 0, 1 test / 1 pass / 0 fail / 0 skipped; output: `✔ minor: the name token never reaches the agent and is a secret to diagnostics; epochs are never made past the ceiling`; tripwire never fired. `changed_blobs` records `tests/acceptance/m10g-review2.test.ts` as `1a1210ecd8c8b62da31adef6c457bbc24cc37f47`.
  - Raw: [`qualification-r1-green.json`](qualification-r1-green.json), [stdout](qualification-r1-green.stdout), [stderr](qualification-r1-green.stderr).
- Compiler command: `python3 .superpowers/sdd/health-backend-wiring-2026-11-03/evidence/final-fix/launcher.py qualification-r1-typecheck sh scripts/tripwire.sh node node_modules/typescript/bin/tsc -p tsconfig.json`
  - Exit 0; stderr empty; tripwire never fired. Its changed-blob record matches GREEN.
  - Raw: [`qualification-r1-typecheck.json`](qualification-r1-typecheck.json), [stdout](qualification-r1-typecheck.stdout), [stderr](qualification-r1-typecheck.stderr).

## Integrity and limits

- Commit: `1fa3042c1a832a3e0089c1a71e5b85cfe9a1d6fd` (`test: align diagnostics secret scan fixture`); the commit contains only the named acceptance test file.
- Committed test blob and GREEN/typecheck recorded blob: `1a1210ecd8c8b62da31adef6c457bbc24cc37f47`.
- Verified every `src/**` blob against base `4e7278d1b662a376ea3c6d2fe2e543830e2b55a8`: zero mismatches. `git diff --check` passed before commit.
- This is a one-test qualification and compiler check. No broader suite was rerun; production code is unchanged. Existing 28-test evidence remains at its prior recorded scope. Root retains ordinary exact-head CI and release gates.
