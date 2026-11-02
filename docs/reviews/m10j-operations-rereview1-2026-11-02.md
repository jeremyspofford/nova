# Task 3 fix round 1 independent rereview

specPass: true
qualityApproved: true
Task quality: Approved for the scoped uncredentialed Task 3 checkpoint.

Scope: I1, I2, M3 and direct breakage introduced by their fixes. BASE `3f919b2de3fadede0b6830bc63d6c2e35de82d8e`, reviewed HEAD `815960362fb40ad3e38ee0200fcbf7f595dea5b9`. Read the complete supplied 56580-byte fix package once in bounded chunks: one follow-up commit, five files, 326 insertions and 15 deletions. The original Task 3 commit was preserved. No whole-task or whole-branch review was repeated.

The controller reports the subsequent maintenance merge at current checkout HEAD `9d136e38369592514209a8db7d6132eb92391b75` changes no src/** or Task 3 test files relative to the reviewed fix pin. This review is pinned to the supplied fix package; maintenance merge verification, combined-tree checks and external CI are separate controller work. No Git commands or branch mutations were performed during rereview.

## Previous findings

1. **I1 addressed — cached observation state no longer caches capability authority.** `src/core/services/k3s/operations.ts:98` resolves the current provider on availability checks and immediately before each execute, then rejects provider replacement or unavailability after awaited I/O (`operations.ts:105`). Null/undefined removal resolves to the unavailable port. The driver retains its cached observations, so failed collection does not refresh their ages. The bounded network read similarly captures and rechecks current port identity (`src/core/services/k3s/network.ts:58`), and writes resolve the current port at dispatch. Stable object identity during an individual I/O is explicitly documented as a trusted composition contract.

   The committed regressions cover warm-driver promotion and collection after provider replacement, provider removal during awaited network authorization, rollback provider removal during status read, rejection of an old network snapshot after port replacement, preservation of evidence ages, and restoration/retry of the same approved task. Final actual results are in `task-3-fix1-covering-final.log:42` and `:49`. These close the earlier reproduced stale-provider execution path without discarding the original observation cache or inventing replay authority.

2. **I2 addressed — actual network writes now validate durable requester/registration authority after awaits.** Core creates a private composition symbol (`src/core/index.ts:575`). The existing Network.start checks this authority for cluster targets (`src/core/network/index.ts:214`), while pure existing patch/secret validation still precedes it. Generic request JSON cannot supply the symbol. No registry, table or second approval queue was added.

   The cluster facade passes the actual requester origin and the closed cluster/namespace/registration/actor binding (`src/core/services/k3s/operations.ts:203`). Subsequent M10d tasks inherit the first existing task's binding and origin (`src/core/network/index.ts:262`). Before writes, `#clusterWrite` validates membership in the existing change/task chain, root prepare identity, change and target identity, binding equality, snapshot/proposal identities and origin/actor consistency (`index.ts:589`). Current registration digest/namespace/target, active hub, requester trust/approver permission and current capability are checked by `src/core/services/k3s/operations.ts:166`. The check occurs after awaited apply readback and again immediately before committing/write (`src/core/network/index.ts:616`, `:637`). Manual snapshot writes also check after their read (`index.ts:697`).

   The previously reproduced hub/requester-revocation cases now have explicit zero-PUT/zero-policy assertions, alongside registration change, generic-input forgery, restart, unchanged positive apply, revoked requester after restart, and malformed/missing durable-binding coverage (`task-3-fix1-covering-final.log:44` through the corresponding individual result lines). The successful tests use actual M10d/Core/ledger behavior and owned target fixtures, not an authorization callback that simply returns true.

   Automatic restoration is a bounded exception to fresh hub/requester permission, not a public bypass. The new guard requires the internal revert reference, `by:'switch'` and reverting state. Existing private switch task creation, sealed snapshot digest and target ownership checks remain the basis for exact restoration. Current registration binding and capability are still required; only the fresh requester/hub grant is skipped (`src/core/services/k3s/operations.ts:172`). The actual regression removes capability after hub/requester revocation, observes no cached/legacy I/O, then restores capability and verifies exact snapshot bytes and actual policy restoration (`task-3-fix1-covering-final.log:56`). Manual restore retains current authority checks (`:57`).

3. **M3 addressed — empty entries no longer evade registered-service validation.** `src/core/services/k3s/network.ts:28` validates each service key before iterating versions, explicitly rejects prototype-sensitive keys, and requires 1–64 registered unique versions for each service entry. Declared live/previous versions must retain corresponding policies. The empty top-level `services:{}` document remains valid for the initial snapshot and exact restoration. The committed parser regression covers unknown/prototype keys with both empty and populated versions, empty registered-service entries, missing live policies and the valid empty snapshot (`task-3-fix1-covering-final.log:48`).

4. **M4 acknowledged, unchanged historical limitation.** The original host browser run had 3 static passes and 21 browser skips; it remains explicitly not browser proof. The separate previously inspected cached-container Chromium/WebKit run had 24 passes, zero skips and exit 0. The fix changes no presentation source or browser contract, so no additional browser run was required. Neither historical result was erased or upgraded by this rereview.

## New findings

Critical: none.

Important: none within the scoped fixes and their direct effects.

Minor: no new finding. M4 remains a documented environment warning, not an unresolved implementation blocker.

## Evidence and review limits

- Inspected the implementer's fix-round append as claims, then compared it with the complete fix diff and raw logs.
- `task-3-fix1-red.log`: six original fix cases failed, exit 1. `task-3-fix1-green-initial.log`: 6/6 passed, exit 0. These are initial progression evidence, not substitutes for the final run.
- `task-3-fix1-recovery-check.log`: retained failure shows the snapshot replacement test reached done instead of failed. The final test now installs the replacement hook before proposing the operation; the final run passes that scenario. The intermediate 14/15 result is not counted as green.
- `task-3-fix1-covering.log`: retained 403-versus-400 failure at existing secret-patch validation. The final source preserves validatePatch-before-authority ordering, and the final covering run passes. The intermediate 63/64 result is not counted as green.
- `task-3-fix1-covering-final.log`: actual 65 tests, 65 passes, zero failures, cancellations or skips, exit 0; no-Kubernetes tripwire never fired. Includes all 16 fix cases plus existing API/ledger/network/chaos coverage. The actual public module-boundary check is recorded at log line 18.
- `task-3-fix1-types-final.log`: typecheck exit 0. Final green logs contain no newly observed warnings. The separately retained historical browser skip warning remains documented.
- `task-3-fix1-final-state.log` records implementation pin `815960362fb40ad3e38ee0200fcbf7f595dea5b9`, clean writer worktree and diff-check exit 0 before the controller's later maintenance merge. No claim is made that this earlier log describes current branch HEAD.
- One named unchanged-source risk check examined existing Network automatic/manual revert creation, sealed snapshot/ownership checks and Core's restricted network configuration type. This confirmed the new restore exception cannot be selected through generic route JSON and does not expose Core's private composition authority. The new guard's automatic-restore branch was assessed with those existing checks, rather than assumed safe from the report.
- No new live probes were run: the concrete original failures and relevant recovery/restart boundaries are directly addressed by the inspected source and final actual regression evidence. No suites were rerun. No external resources, credentials, network services, installs or images were accessed.
- Existing accepted limits remain: trusted in-process registration only; no production broker/launcher/credentials or real-cluster proof; unsupported general scaling/state/secrets; explicit retry only; interrupted canary remains unverified without completion evidence; no post-task monitor authority. Invalid legacy cluster bindings or changed registration fail closed rather than silently acquiring fresh authority. This approval does not complete the full Phase J credential gate or approve a merge.
- This rereview wrote only this ignored report. Source, index, HEAD, branch, screenshots and earlier evidence remain untouched by the reviewer. No reviewer process remains running; review ownership is released.

Assessment: The fixes close both reproduced authority bypasses and the canonical schema hole with current checks at the relevant execution boundaries. The existing M10d restore authority remains separate and tested, and no direct new blocker was found.
