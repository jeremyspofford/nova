# Task 3 fix round 1 — scoped independent re-review

**Requirements compliance: Approved for this scoped correction. Task quality: Approved.** I1, I2 and I3 are addressed; no new blocking fix-introduced defect found.

Base: `c6df6dfc4c2cbd80471260f8ca15996ceca74dd6`. Head: `3c1ee8284c622dbb94f972a2678d9a93c181e74c`. Scope is the three prior findings and regressions introduced by their fixes, not a new broad branch review. Read the regenerated brief/constraints, appended fix report and supplied 1,490-line review package once in bounded chunks. No git commands, source/index/HEAD changes, suites, probes, subagents, preview operations or network actions were run. Only this requested report was written.

## Prior findings

### I1 — Bind mutation execution to the approved state: ADDRESSED

- `src/core/services/expected.ts:7` validates a closed, bounded state with live, previous and assignment intent. `:15` compares those exact semantic values; this is public state, not an authorization substitute. `src/core/services/topology.ts:68` projects it into the action descriptors. `ui/js/topology.js:169` carries the server descriptor's expected state through the fixed request after the existing target comparison.
- `src/core/index.ts:1284` requires the guard on hub actions; `:1317` and `:1328` validate optional device guards while preserving omission compatibility. Existing access, confirmation and readiness checks remain. The fixed typed IPC message carries the same guard, and `src/supervisor/supervisor.ts:378` validates it again; `:391` retains it through the 300 ms acknowledgement delay.
- `src/core/services/manager.ts:146` and `:162` pass the checked guard to the driver. `src/supervisor/services.ts:277` compares it inside the promotion queue before effects; `:410` compares rollback state before selecting current previous or stopping a process. Thus a queued promotion cannot reinterpret either an approved rollback destination or an approved promotion source.
- Console deployment checks the guard and acquires its existing lock synchronously before its first await (`src/supervisor/supervisor.ts:444`). Manual rollback checks guard/lock at `:643`, acquires the lock at `:657`, and only then awaits stopping the server at `:660`. The console hook passes expected state through; automatic rollback compatibility is preserved.
- Native promotion and rollback compare state and write assignment within the synchronous transaction at `src/core/services/workloads.ts:154` and `:175`. Native status now supplies actual assignment intent (`:205`). The focused unchanged-code check of `src/core/db.ts:51`/`:67` confirms nested savepoint support and an outer `BEGIN IMMEDIATE`; the read/compare/write callback contains no await.
- Tests are substantive: `tests/core/topology-expected.test.ts:13` queues both guarded rollback and promotion behind an actual promotion and proves serving stays on version 3 while version 4 remains ready; `:35` checks console serialization and unchanged PID/releases on refusal; `:53` checks native drift and the unchanged SQL row; `:75` checks malformed/extra/oversized guard refusal. `:95` exercises real HTTP → IPC → delayed execution → actual driver queue, gates the queue with a real held health response, proves the approved rollback refuses after an ahead promotion, and observes the refusal in the actual core. This closes the original race rather than adding another UI read.

### I2 — Preserve the worse still-current source when another source expires: ADDRESSED

- `ui/js/topology.js:26` independently makes expired/invalid source evidence unknown and merges failed > degraded > unknown > healthy. `:40` applies it to machine observations; `:51` merges service evidence with the independently aged machine evidence. A fresh machine cannot freshen stale service evidence, and an expired heartbeat no longer masks a fresh failure/degradation.
- `ui/js/topology-view.js:52` and `:55` retain the independently merged live-service status; specimens without service observations retain their historical machine fallback. Action/export disabling remains conservative, and source reasons/ages are retained.
- `tests/ui/m10i-topology.test.ts:459` covers both failed and degraded sources: 115-second heartbeat plus 1-second cluster evidence, eight seconds later, machine/service row/service heading retain the worse current state and displayed ages. It then expires the worse source itself and verifies Waiting. The recorded browser RED failed both branches; final covering browser output passes both.

### I3 — Keep asynchronous completion scoped to its own approval sheet: ADDRESSED

- `ui/js/topology.js:152` requires approval identity, exact connected form, current dialog containment, an open sheet and visible topology. Submission uses that predicate after preflight, after POST success (`:171`) and in rejection handling (`:175`). Route departure and close callbacks also honor ownership; completion releases obsolete ownership without closing/focusing a replacement sheet.
- `ui/js/topology.js:92` no longer clears the receipt on automatic refresh. Explicit map refresh/new review clears it, so a late result survives returning to the route without affecting another approval. POST retry remains disabled.
- `tests/ui/m10i-topology.test.ts:481` holds a real fixed POST or rejects a held topology GET, dismisses the original sheet, navigates through the SPA and opens the actual tier-3 revoke approval. It checks the replacement remains open and its confirmation retains focus, checks POST count, and checks the old receipt survives route return/automatic refresh. Both cases failed in recorded RED and pass in the covering run.

## New fix-introduced findings

- **Critical:** None.
- **Important:** None.
- **Minor:** None requiring a change in this fix wave. Existing warning/evidence caveats remain below.

## Covering evidence inspected

No reported suite was rerun. The command names in the appended report match the test groups and outcomes in these actual logs:

| Command scope | Actual evidence |
| --- | --- |
| `sh scripts/test.sh --test-concurrency=1 tests/core/topology.test.ts tests/core/topology-api.test.ts tests/core/topology-expected.test.ts tests/core/topology-actions.test.ts tests/core/services-manager.test.ts tests/core/workloads-hub.test.ts` | `task-3-fix1-backend-all.log:35`: 33 passed, zero failed/skipped. |
| `sh scripts/test.sh --test-name-pattern=actual.HTTP tests/core/topology-expected.test.ts` | `task-3-fix1-ipc-queue.log:3`: 1 passed, zero failed/skipped, covering the added real IPC queue case. |
| `scripts/ui-test.sh --import=./.superpowers/sdd/M10i/no-shots.mjs tests/ui/m10i-topology.test.ts tests/ui/m10i-styleguide.test.ts` | `task-3-fix1-app-all.log:30`: 28 passed, zero failed/skipped; 23 app cases and five styleguide cases, including both engines/all packages matrix and the four new adversarial cases. |
| Token lint, themes, typecheck and the reported API/driver-contract/UI/static/timer guard group | `task-3-fix1-static.log:3`, `:13`, `:81`: lint/themes/typecheck complete, 62 passed, zero failed/skipped. The actual outside-core import-boundary and legacy driver-contract tests pass. |
| `scripts/ui-test.sh tests/ui/m10i-vitals.test.ts` | `task-3-fix1-vitals.log:4`: phone CPU4x p75 LCP 316 ms / INP 64 ms / CLS 0.000; desktop 148 / 40 / 0.000. Twelve runs per width, seven interactions each; one test passed, zero failed/skipped. |

Recorded RED inspection confirms queue/console behavioral failures (`task-3-fix1-backend-red.log:19`, `:34`, `:52`), the corrected native RED (`task-3-fix1-native-red.log:16`), and all four client regressions (`task-3-fix1-browser-red.log:19`, `:38`, `:57`, `:74`). The initial native harness error is not counted as behavioral RED.

## Out-of-scope observations and retained limits

- Two existing localStorage ExperimentalWarnings remain in `task-3-fix1-static.log:27` and `:70`; alternate themes retain the disclosed off-scale/unapproved caveats at `:6`. This evidence is not warning-free; no new warning category was found in the inspected fix runs.
- The earlier full host run remains 1,611 tests / 1,593 pass / four fail / 14 skip. This scoped approval does not erase the capture/provider/mail outcomes or replace the controller's final branch/CI gate. The timer annotation correction remains covered. No new full M9 or full host run is claimed.
- No new PNGs or visual patterns were added. Existing screenshots remain historical; new elapsed-state behavior is verified by browser DOM/status/age assertions. I2/I3 adversarial cases ran Chromium desktop; the unchanged broad app/styleguide matrix remains separately covered.
- Additional source reads were limited to the console rollback continuation because the diff hunk ended before lock acquisition, and the named native-atomicity risk in the unchanged Db transaction implementation. No broader Task 2 review was performed.

**Verdict: APPROVED for the scoped Task 3 re-review.** All three prior Important findings are addressed with end-to-end guards or targeted browser regressions, and no fix-introduced blocking issue was found. Whole-branch acceptance, CI and integration remain the controller's gates.
