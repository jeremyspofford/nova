# M10j whole-branch independent adversarial review

Date: 2026-11-02. Reviewer: fresh independent `m10j_checkpoint_final_review`; engineering code-review skill applied. No implementation author/review verdict was treated as authority.

## Verdict

**Needs fixes for the uncredentialed draft checkpoint: 0 Critical, 2 Important, 1 Minor.** `specPass: false`, `qualityApproved: false` for this reviewed checkpoint. One consolidated test-first fix wave and a scoped rereview are appropriate. There is no credentialed exploit demonstrated here; the Important findings are real correctness failures in the implemented simulation/observation path.

**Full M10j gate: NOT PASSED, independently of these findings.** Actual P1a/P1b/P1c and the credentialed broker/launcher proof are absent; #275 remains parked pending findings B. This review does not authorize phase merge, real cluster execution, preview deployment, M10k, setup/joins, or GitOps. After fixing the findings, only an explicitly uncredentialed draft checkpoint could be accepted, subject to exact corrected-head ordinary CI and its remaining publication requirements.

## Identity, scope and evidence

- Exact worktree: `/home/jeremy/.codex/worktrees/nova-m10i-topology/nova-build`.
- Base: merged main `048eea0ee043f43d01bc9a36bed601ce9805373b`.
- Reviewed HEAD: `5cf2597db585b669e58474a890fe5fa2a3a1c4fd`, branch `codex/m10j-k3s`; unchanged throughout review. Tracked worktree/index clean at final check.
- Whole branch: 61 changed files, including chart/schema, all new K3s implementation, test-only tool simulation, Core/network/manager/topology integration, tests, and checkpoint records. Read production implementation first, then affected underlying authority/projection code and tests. Repeated report/log claims were checked mechanically or selectively rather than repeatedly dumped.
- Binding scope: M10 orchestration Points 1–5/7–8 and M10j/order; M10j design and task plan; owner's explicit instruction to continue unblocked chart/simulated-driver/tests while credentialed paths remain fail-closed and #275 is parked.
- Source manifest: all 30 pinned files match their SHA-256 values. All 8 public archived logs match `public_sha256`. Seven literal `Ruling:` entries are present in the running ledger and all seven appear in the public gate with costs. `git diff --check BASE HEAD` passes. These checks establish artifact identity, not behavioral correctness.
- Existing full run remains RED: 1718 total, 1703 pass, 1 source-guard failure, 14 opt-in skips. Scoped repaired guard/159 affected tests, combined typecheck and 30 browser tests are scoped evidence, not a replacement full run. The review did not rerun those packages. Final ordinary CI is a separate controller requirement; no new full-CI success is asserted.
- New probes used actual Core/API/WorkLedger, the existing committed fake child programs, disposable homes and loopback targets only. No real tool, credential, owner data, cloud, image pull, external network or preview was used. Every run used `scripts/test.sh`; the outer runtime tripwire was armed and never fired.

## Strengths

- Default composition is fail-closed: no production executable runner, no ambient discovery, no fallback from a persisted cluster target to legacy token execution, and the ordinary ServiceManager explicitly excludes the cluster driver from automatic selection.
- Fixed operations, expected-state checks inside serialization, server revision CAS and task-bound last-mutation evidence are materially stronger than a preflight-only authorization scheme. Unknown completion does not silently replay a selector change or pretend an interrupted canary completed.
- Existing WorkLedger internal worker symbols and M10d snapshot/apply/readback/dead-man authority are reused. The new network document is closed, registration-bound and rendered against actual policy readback; it does not add arbitrary manifest or command authority.
- Chart output uses domain-separated 160-bit identifiers, JSON escaping, namespace binding, pinned image digests, fixed resource kinds, Linux confinement, no mounted service-account token, and restricted pod security. Unsupported storage/alongside/secret execution refuses explicitly.
- Tests exercise actual disposable processes and real Core APIs, including provider replacement, requester/hub/registration revocation, lost acknowledgements, restart reconciliation and read-only collection. The three findings below expose gaps in outcomes those tests currently omit; they do not negate the useful existing coverage.

## Important findings

### I1 — Historical and candidate readiness corrupt current serving health

**Location:** `src/core/services/k3s/operations.ts:273–276`; aggregation consumer `src/core/services/topology.ts:59–66`. Tight review anchor: `operations.ts:273`.

`collect()` turns every observed version's readiness into a service-level workload observation. `buildTopology()` takes the worst health across those observations, including stale ones converted to unknown. This combines version history with current serving health.

Reproduction through the actual Core API:

1. Deploy and approve version 1, then approve its normal promotion and complete the 120-second canary.
2. GET `/services/topology`. The live workload measurement is healthy with age 0, but the readiness receipt is now exactly 120000 ms old and stale. The aggregate service is `health: "unknown", status: "Waiting"` immediately after successful promotion.
3. Deploy version 2 whose contract path fails. Version 1 remains live and the loopback stable endpoint still serves `"1"`; its measured health is fresh and healthy. The new failed-preview readiness observation makes the aggregate service `health: "failed", status: "Failed"`.

Observed output is retained in `task-5-review-adversarial.log`. Its first test fails the fresh-live-health assertion; the same test logs both the immediate Waiting result and the later false Failed result before asserting. The existing native projection explicitly recognizes that a failed candidate is not a failed serving workload (`projectService`, topology.ts around line 180), so this is also a regression in cross-driver semantics, not a proposed new UI policy.

**Impact:** normal successful K3s promotions cannot remain truthfully Verified, and an isolated preview failure falsely reports a production failure. Readiness from kept/removed versions has the same aggregation problem. This violates the checkpoint's independent health/readiness provenance and no-invented-outage contract.

**Fix:** preserve per-version readiness and its actual age as version evidence, but do not treat obsolete or non-serving readiness as an independent failure/availability signal for a presently measured live workload. If readiness is used as a fallback when nothing is live, bind that fallback to the relevant candidate/current assignment. Do not freshen old receipt timestamps, erase real current workload/node failures, or suppress control-plane uncertainty to make the status green.

**Required focused regression:** actual API assertions for healthy live immediately after the full canary, healthy live with a failed preview, retained/removed versions, and genuine fresh live or node failure remaining worse than healthy heartbeat. Assert aggregate `health/status`, not only the presence of a healthy observation.

### I2 — Retired-version accumulation crosses the response bound after committing a new preview

**Locations:** `scripts/stand-ins/k3s-simulation.js:95` and `:116–130`; `src/core/services/k3s/driver.ts:102`. Tight review anchor: simulation line 118, with the driver count guard as the related site.

The simulator changes retired versions to `status: "removed"` but never removes them from `row.versions`. Every prepare appends another row. The driver refuses all snapshots containing more than 64 versions. There is no pre-effect admission check or bounded retirement representation linking these two behaviors.

Focused actual-child reproduction:

1. Start and normally promote a real simulated `seed` version.
2. Arrange the boundary fixture as that live row plus 63 valid, stopped, removed historical rows (64 rows total); this represents retirement history rather than 64 running workloads.
3. Apply a valid new `next` version through the real driver/Helm/kubectl stand-ins.
4. The server commits a new running alongside row, producing 65 rows. The driver rejects the mutation response as unknown completion. A subsequent read-only observe also fails solely because the snapshot still has 65 rows. Stable `seed` still serves, but management can no longer observe it.

`task-5-review-retention-live.log` records `rows:65`, `serving:"seed"`, the committed `next` row with one replica, and both apply/observe returning false. The test fails the observation-success assertion. The earlier combined probe used 64 removed rows and produced the same defect; the stronger follow-up keeps an actually promoted live workload. This was a targeted fixture refinement, not a rerun of a passing package.

**Impact:** after enough ordinary releases, retired history permanently strands the simulated service behind the observation bound, while a new preview has already started. Refresh, rollback and further version operations all rely on a snapshot the implementation now always rejects. Retaining history indefinitely also grows the protocol/state until the child output bound is reached. This is an implemented protocol/lifecycle defect, not missing future credential proof.

**Fix:** define bounded retained-resource versus historical/tombstone representation and enforce its admission limit before a mutation can commit. Preserve live/previous/current candidates and task-reconciliation evidence; do not simply raise/remove the observation bound or silently drop active resources. Maintain immutable-version and replay protections when retiring old rows. The fake transaction must itself refuse an irreducible over-limit request before effects, and the driver should surface a specific safe capacity refusal rather than commit then lose observation.

**Required focused regression:** exercise the 64-row boundary with retired history and an actual live service; demonstrate that either safe retirement permits the operation with subsequent observation/rollback intact, or a specific pre-effect refusal leaves state unchanged. Include the irreducible active-resource boundary so compaction cannot delete meaningful resources to satisfy a limit.

## Minor finding

### M1 — Native Windows artifact eligibility leaks into K3s planning

**Location:** `src/core/services/k3s/driver.ts:93–96` (call to the generic placement resolver); existing resolver's native-program branch is `src/core/services/placement.ts:119` onward.

The K3s driver passes the entire dual-form artifact to `resolvePlacement`. That resolver deliberately considers a Windows device eligible when the definition provides a matching `win32-x64` native program. K3s subsequently renders only the image, so the native artifact must not supply container eligibility.

A valid pinned Windows definition containing both the pinned image and a `win32-x64` program yields `plan.ok === true` and an empty refusal list. The pure planning probe is in `task-5-review-platform.log` and fails its expected-refusal assertion; tool-call count is zero. The chart's unconditional Linux selector and independent fake placement validation still prevent a Windows pod from actually running, so this is **not** a program or OS execution escape.

**Impact:** a known-ineligible container target is advertised as executable; later apply reaches tool/schema work and fails with a generic uncertain-operation explanation instead of a plain pre-tool Linux refusal. Preferred/floating selection can also rank a native-capable non-Linux device ahead of an eligible Linux device.

**Fix:** resolve K3s container placement using the image's Linux-only eligibility while preserving the generic/native resolver's existing behavior for other drivers. Add the dual-image/native Windows/macOS case and a mixed-node preference case; keep the existing native-plan assertion.

## Considered and declined as separate findings

These are the actual scope/risk decisions considered in this review; none is an implied pass for a future implementation.

| Behavior / concern | Decision and reason |
|---|---|
| Missing broker P1a/P1b/P1c and positive credential runner | Hard dependency gate, not a new defect in this explicitly uncredentialed checkpoint. Full phase remains unaccepted. No fake-broker positive proof credited. |
| Real Helm rendering, Kubernetes API validation, scheduling/network enforcement, storage provisioning and real cluster runtime | Unproven, explicitly disclosed; not required to be fabricated in the authorized stand-in-only checkpoint. Fake Helm independently checks values/schema but does not execute Go templates. |
| Tier3 public setup, enabling driver, cluster metadata/credential registration, joins and cloud activation | Absent and not implied by trusted in-process registrations. Must remain a future gated capability. |
| M10k backend switching, services.git/Flux ownership, service change-kind and GitOps | Explicit accepted deferral. Fake Flux is only an observed stand-in command, not GitOps implementation. |
| Stateful/copy/shadow/singleton/secret execution | Driver refuses before effects. Pure chart PVC/secret references do not supply runtime writer/credential proof. Full support remains absent rather than silently accepted. |
| General replicas API and post-task Core monitoring authority | Explicit unsupported/refused checkpoint limits. Direct injected driver canary/soak behavior exists; Core observation deliberately does not inherit post-task mutation authority. No claim of complete production soak automation is accepted. |
| Direct injected driver and capability hooks bypassing the public ledger | Trusted composition/test port, not an API accepting arbitrary authority. Public operations are symbol-protected ledger tasks. No default runner or public arbitrary argv bridge exists. |
| Default HOME/PATH/KUBECONFIG/simulator-state activation | Actual default/refusal implementation has no environment discovery or runner. Existing actual-Core matrix positively arms private markers and checks no calls/legacy value reads. No new default escape found. |
| Source guard repair | Literal name centralization in the existing adapter does not hide executable behavior; exact approved path exceptions remain narrow. Whole-branch source guard changes preserve the planted positive assertion and runtime tripwire. |
| Queued current/expected binding and cross-driver serialization | Expected state is compared in the queue; each mutation includes server revision/state CAS. Global cluster/namespace/service queue can over-serialize identical fixture identities but does not create extra authority. |
| Drift after network authorization | Prepared placement is recomputed under the mutation lane; actual observed resource device IDs gate version effects; server CAS handles resource drift. Existing tests exercise those awaited gaps. |
| Provider removal/replacement after warm-driver creation | The facade resolves provider authority per call and checks object identity after awaited I/O. Cached observations retain old ages rather than accepting revoked results. No separate bypass reproduced. |
| Requester/hub/registration changes across network waits | Durable root-task binding, current checks after read and immediately before write, and current cluster target resolution cover the inspected paths. No unchecked awaited network write gap found. |
| Hypothetical scheduling gap after a synchronous authority callback | Not raised as a speculative exploit. The trusted adapter must enforce its own server transaction/capability contract; no concrete independent external revocation bypass was reproduced. |
| Forged task inputs / public network origin | Internal worker symbols and the network composition key prevent public creation; durable root task, target, snapshot hashes and actor/origin agreement are checked for cluster writes. No new operation registry or public restore privilege flag exists. |
| Cancellation and interrupted canary | Abort is propagated; committed/uncertain work is not blindly repeated. An interrupted promotion remains unverified even after time passes. This trades liveness for truthfulness and is intentional. |
| Restart reconciliation of deploy/rollback | Requires recorded completion or the matching task's terminal mutation evidence. A selector alone does not prove full canary success. No replayable completion bypass found. |
| Commit point before server CAS rejection | May conservatively require reconciliation after a refused write, but does not invent success or retry a possibly landed effect. Not a separate correctness/security finding. |
| Dead-man restore after actor/hub revocation | Intentional separately authorized exact-snapshot recovery; still requires the same registration/binding and a current capability. Ordinary/manual restore still checks current authority. |
| Registration change preventing dead-man restoration | Conservative refusal when the exact target authority changes; no authority fallback. Availability cost is disclosed; do not relax to an unbound target. |
| Managed target losing registration/capability and legacy token fallback | Persisted `k3s-public` marker plus adapter resolution refuses before a legacy adapter can read a value. Existing network sealing keys are M10d internals, not a kubeconfig fallback. |
| Secret scanner bypass for generated identifiers | None added. Canonical input carries registered public identities and recomputes generated names; the existing generic scanner/mask is unchanged. Secret-looking unsupported public identities may refuse. |
| Empty/unknown/prototype canonical service entries and retained live/previous policies | Explicitly rejected; canonical renderer requires registered nonempty versions and inclusion of live/previous. Empty whole-service map is allowed for an initial exact snapshot. |
| Read-only collection arming rollback/removal | Collector calls `observe`, not `refresh`; there is no timer arm in that path. Genuine API test proves no mutation/monitor. This remains correct despite I1's health projection bug. |
| Fresh response with stale/future measured health | Automatic direct-driver rollback/removal independently require health age 0–15000 ms. Failed/out-of-order reads retain old evidence. Future snapshot tolerance does not permit future health to authorize automatic effects. |
| Canary/readiness using stale cluster health alongside live HTTP probes | Actual confined HTTP probes are independently performed; response acceptance never alone substitutes for probe success. No health-freshness bypass demonstrated in these explicitly tested paths. |
| Control-plane loss vs heartbeat/node failure | Ages and reasons remain independent; worst fresh actual node failure survives healthy heartbeat. Control-plane loss becomes unknown rather than fabricated workload failure. I1 concerns distinct version-readiness aggregation. |
| Registration changed during a read-only collection | At worst the in-flight result can reflect its captured registration; it grants no mutation authority. Current device trust is filtered and subsequent collection re-resolves registration. Not raised as a separate security finding. |
| Configured cloud sites and untrusted node names | Only explicit sites and registered current trusted device identities create nodes. Labels alone cannot invent a device/cloud site. |
| Fixed probe origin, redirects and hostile paths | Trusted loopback origin is validated; probe paths are confined; redirects do not count as success; byte/time limits and cancellation exist. No source-output URL or ambient proxy authority. |
| Missing/malformed snapshot fields or null version entries | Rejected/throws into safe observation failure without refreshing cached evidence. A null-entry access ordering could be tidier but produces no incorrect accepted state or new authority. |
| Snapshot `since`/display metadata not as tightly bounded as mutation facts | Does not authorize effects; final projection normalizes timestamps/text. No concrete harmful behavior established, so no speculative finding. |
| Chart names, YAML directives, namespace and immutable selectors | Hashed domain-separated tokens, escaped JSON scalars and namespace equality prevent name/template injection. Resource identifiers and Pod template inputs stay independent of stable live selection. |
| Schema incompleteness relative to cross-field renderer invariants | Schema closes field shape; pure builder plus independent fake checks own relational semantics. No public raw-values execution entry exists. Not a reason to claim real Helm/API conformance. |
| Schema evaluator silently accepting new semantic keywords | Existing repair now rejects unsupported vocabulary recursively, including properties/definitions. No new omission identified in the schema currently used. |
| State writer overlap / RWO mistaken as singleton proof | Pure values cap aggregate desired writers, use Recreate and fixed PVC references. Runtime driver refuses state/none without actual observed-stop proof. No unsafe runnable state mode remains. |
| Windows/native artifact becoming a pod | Actual chart and fake Linux restrictions remain. M1 addresses incorrect planning only; no command from the program artifact is emitted by the chart/runner. |
| Kept multi-replica rollback and soak cleanup | Retained replica observations restore the observed count; direct-driver health freshness gates cleanup and failures restore or hold safely. I2 separately addresses unbounded retired history. |
| Long-lived replay/definition persistence | Definitions are validated and hash-keyed, exclusive-create immutable files; no durable approval/queue state is duplicated there. Future tombstone pruning for I2 must preserve those invariants. |
| Cross-service cloud/node observations and shared control-plane failure | Taking the latest actual node observation while retaining independent control-plane uncertainty is conservative. No inferred heartbeat rescheduling occurs. |
| Native/manager import cycle from the name constant | Source closure has no manager return edge and no import-time process or filesystem operation. Existing manager-first initialization check is relevant scoped evidence. |
| Added runtime dependency, manual cloud infrastructure or resource installation | None found. No runtime package dependency changed. |
| Navigation merge and current app-shipping claim | Merged main navigation is the base; K3s remains branch implementation, current app-shipping C23 unchanged, and LEDGER explicitly says unmerged checkpoint. No shipped/merged K3s claim accepted. |
| Prior failed evidence and exact-head CI | Historical failure is retained, scoped successes accurately bounded. Final ordinary CI must run on the corrected head; current/old-head success would not close these fresh findings. |

## Seven controller rulings

All seven rulings are visible and reasonable within the narrowed checkpoint, with no silent rejection found:

1. Existing owner ADR plus explicit continuation authorizes uncredentialed implementation without another plan-confirmation pause; new rendered patterns and #275 B remain gated.
2. Reuse the already isolated owned worktree; directory name mismatch does not change branch identity or permission scope.
3. Domain-separated 160-bit derived resource names satisfy accepted identities at the cost of readability; original labels remain escaped metadata.
4. Require merged broker foundation for credentialed work; safe refusal is not positive credential proof.
5. Refuse unsupported state/alongside modes; this sacrifices capability rather than writer/readiness safety.
6. Preserve the accepted M10k change-kind/GitOps deferral; this checkpoint has no full Changes/Flux claim.
7. Match existing canary/probe defaults and use injected clocks; deterministic timing proves code behavior, not physical cluster behavior.

The unsupported general-scaling and post-task-monitoring limits are also public, although not separate literal `Ruling:` entries. They constrain checkpoint acceptance and remain full-phase capability gaps. None justifies I1's false health projection or I2's committed overflow; both are defects in functionality already claimed implemented. M1 should be fixed with the same focused wave because it is small and directly violates the intended pre-tool Linux refusal.

## Probe artifacts and commands

Owned ignored files only:

- `.superpowers/sdd/M10j/task-5-review-adversarial.test.ts`: actual Core/API fixture extracted from the existing K3s-owned test setup, with absolute imports; three focused adversarial cases. No source/test-tree mutation.
- `task-5-review-adversarial.log`: initial two-case run, 0 pass / 2 fail, exit 1, tripwire never fired. Logs both I1 outcomes before the first assertion and I2's initial all-retired boundary fixture.
- `task-5-review-retention-live.log`: strengthened live-workload I2 boundary case only, 0 pass / 1 fail, exit 1, tripwire never fired.
- `task-5-review-platform.log`: M1 pure plan case only, 0 pass / 1 fail, exit 1, tripwire never fired.

Commands from the exact worktree used Node 26.3.1 on PATH:

```sh
PATH=/home/jeremy/.local/share/mise/installs/node/26.3.1/bin:$PATH sh scripts/test.sh .superpowers/sdd/M10j/task-5-review-adversarial.test.ts
PATH=/home/jeremy/.local/share/mise/installs/node/26.3.1/bin:$PATH sh scripts/test.sh --test-name-pattern='retired history' .superpowers/sdd/M10j/task-5-review-adversarial.test.ts
PATH=/home/jeremy/.local/share/mise/installs/node/26.3.1/bin:$PATH sh scripts/test.sh --test-name-pattern='Windows node' .superpowers/sdd/M10j/task-5-review-adversarial.test.ts
```

The first log predates the stronger live-history fixture and addition of the platform case; it is not mislabeled as the current three-case file's output. All probe processes finished. Source, branch, index and HEAD were not modified. No helpers/subagents were used.
