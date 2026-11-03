# Qualification Task 2 — independent fixture review

**Spec verdict: PASS. Quality verdict: APPROVE. R1: ADDRESSED. New findings: 0 Critical / 0 Important / 0 Minor.**

Reviewed BASE `4e7278d1b662a376ea3c6d2fe2e543830e2b55a8` through HEAD `1fa3042c1a832a3e0089c1a71e5b85cfe9a1d6fd`. This is solely the adjudicated one-test qualification step; the production fix wave remains closed. Original I1/M1 dispositions remain addressed at their previously reviewed scope.

## Fixture and assertion review

The existing `pair({})` is initialized before the diagnostics assertions. `knownSecrets(p.a.core, { home: p.a.home, env: { NOVA_MESH_NAME_TOKEN: originalCanary } })` uses that fixture's actual Core and disposable home; the actual code preserves the original literal canary. The scan and summary assertions are now inside the existing `try/finally`, with `await stop(p)` unchanged. The existing helper creates private temporary homes and real Core identities, uses loopback services, and removes its homes/environment state on cleanup. No fixture family, additional pair, import, production API, skip or force-exit was introduced.

Every original assertion remains: both agent-environment checks (token excluded, PATH preserved), token inclusion in the diagnostics secret set, both summary checks, `raiseEpoch` rejection, promotion status409, promotion error wording and promotion reason. The subsequent epoch setup, Core closure and promotion sequence are unchanged. The assertions are neither replaced with constants nor weakened. Requiring a valid fixture does not relax the production fail-closed secret scan.

## Evidence and integrity

Read the full brief and Global Constraints, progress ledger including Ruling5, full prior `final-fix-review.md` and full Task2 report. The root report is byte-identical to `evidence/final-fix/task-2-fixture-report.md`; its relative raw links resolve in that original directory. Read the complete immutable 3,566-byte `review-4e7278d1..1fa3042c.diff` once, the affected test and existing fixture helper, launcher, historical identity record/HEAD and runtime stdout/stderr. No regenerated git diff or broader branch review was used.

Read all three qualification invocation JSON records and complete stdout/stderr in `evidence/final-fix/`:

- `qualification-r1-red`: host HEAD4e, empty changed-blob map, exit1; tests1/pass0/fail1/skipped0. The fixed secret-scan refusal occurs at the old stub/home call, before the token and epoch assertions. This is the expected R1 failure, not an infrastructure failure.
- `qualification-r1-green`: same named test and flags, exit0; tests1/pass1/fail0/skipped0, no cancellations/todo. The original assertions and cleanup execute successfully according to that retained run.
- `qualification-r1-typecheck`: `sh scripts/tripwire.sh node node_modules/typescript/bin/tsc -p tsconfig.json`, exit0; stderr empty.

RED/GREEN used `sh scripts/test.sh --import ./tests/acceptance/egress-guard.ts --test-concurrency=1 --test-timeout=120000 '--test-name-pattern=minor: the name token never reaches' tests/acceptance/m10g-review2.test.ts`. Each invocation used the existing launcher, finite environment, cached Playwright image, `--pull=never --network=none`, uid1000, read-only code/dependencies/Node26.3.1 mounts and private temporary HOME. The tripwire never fired. No qualification stderr warning or failure is hidden; the intentional RED failure remains intact. The historical runtime probe reports v26.3.1.

Independent read-only Git object/tree checks confirm HEAD1fa is directly parented by BASE4e and changes exactly `tests/acceptance/m10g-review2.test.ts`. All 239 `src/**` entries match BASE4e, with zero mismatches. GREEN and compiler both recorded test blob `1a1210ecd8c8b62da31adef6c457bbc24cc37f47`; that equals the committed HEAD test blob and current file blob. The observed host invocation HEAD was4e plus that recorded change, not1fa at test time.

The read-only `.git` pointer/identity overlay explicitly remains historical `f9ffbb0c2b241b60ba5161cc55bbdb8c3462b819`. The report truthfully distinguishes it from host HEAD/source provenance and makes no about.build or exact-final-head CI claim. There was no concrete unresolved evidence question requiring another test run; no tests were rerun during this review.

## Limits and release

No new security, correctness, performance or maintenance finding arises within this one-test change. This review does not extend the prior 28-test evidence to a broader or final-head result. Ordinary exact-head all-required CI, evidence publication corrections, PR/push/merge, matching-tree checks, authorized preview and root release gates remain pending. Health UI/approval/crawl and app-not-shipped/API-only limitations remain unchanged.

**RELEASE:** Independent Task2 qualification review complete. R1 addressed; 0 Critical / 0 Important / 0 Minor outstanding in this scope. Return ownership to root; no further source writes or test runs planned.
