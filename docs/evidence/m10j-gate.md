# M10j gate evidence — uncredentialed work in progress

**Full phase gate: NOT PASSED.** The owner authorized continuing the chart, simulated driver and tests while credentialed paths stay fail-closed and #275 stays parked for findings B. M10j does not yet enable a live backend or prove a real cluster/tool/storage/network/credential path. Binding scope: [orchestration ADR](../plans/M10-orchestration.md); [implementation plan](../plans/M10j.md).

## Task1 pure chart checkpoint

Reviewed source `683f54d762866a6d7700484c1d45a271a85cc8e7`, following initial `f31ccb0a`. Public `buildK3sValues` constructs closed JSON from validated definitions and explicit retained/live/placement context. One repository chart describes version Deployments and previews, explicit stable selection, probes/roles/resources, safe names, retained claims and credential references only. Program argv/payloads and credential values are absent. The exact types, literal values/native-plan snapshots and schema fingerprints are in the [implementation report](../reviews/m10j-chart-implementation-2026-11-02.md).

[Independent review](../reviews/m10j-chart-independent-review-2026-11-02.md) found two Important defects: adjacent-hyphen named ports accepted despite Kubernetes restrictions, and stateless alongside-none using default surging rollout. It also suggested strict schema-evaluator vocabulary. All three were addressed test-first; [scoped re-review](../reviews/m10j-chart-rereview1-2026-11-02.md) passes with no new Critical/Important/Minor findings. Current required strategy is explicit Recreate for none/state, RollingUpdate for stateless full; active none rejects aggregate desired instances above one without clamping.

Fresh saved evidence: new regressions RED7fail/1pass before logic changes; GREEN43/43 chart/definition/placement, actual module-boundary1/1 and typecheck; no skips, diff checks clean, tripwire armed/never fired. Initial 35-test/boundary/typecheck stdout was not saved and remains worker-reported historical evidence. Current logs do not recreate that history. No full host-suite or actual Helm process was run for Task1.

## Controller rulings on review exclusions

| Excluded behavior | Required disposition and cost |
|---|---|
| Fake-Helm schema/lint process | Task2 must actually execute its committed fake and reject malformed inputs. Current shape/schema tests do not pass that gate. |
| Real Helm/API/scheduling/probe/resource/PVC/network behavior | UNPROVEN under the hard no-real-tool/resource limits. Fakes will prove Nova-side logic only; no physical capability is implied. |
| Runtime singleton/writer stop, storage copy and readiness | Task2 must observe all old instances stopped for state/none or refuse execution. Recreate/RWO/counts are desired configuration, not a runtime lock. Copy/shadow remain explicit refusals until a safe capability is tested. |
| Resolver trust/roles/hardware/Linux/failover and observation order | Driver/core must check actual current eligibility and source times in Tasks2–3. The pure renderer accepts a resolved context, not an authorization grant. |
| Serialized expected state, replay/cancel/restart/unknown completion | Actual driver/WorkLedger tests remain mandatory. No second durable queue or blind retry. |
| Broker/launcher/ambient configuration/plugins/wrong cluster | Task4 remains gated on merged P1a/P1b/P1c and owner findings B for #275. Production capability stays absent/fail-closed; no legacy vault-value fallback. |
| Applying NetworkPolicy/network artifacts | Reuse M10d tier3/snapshot/dead-man authority before any effect. Rendering alone authorizes nothing; absent capability refuses. |
| Backend switching/GitOps/cold site/service kind/UI/preview/milestone | Preserve M10k’s scope and existing deferrals; no phase completion or merge assertion. New rendered patterns retain their owner gate. |

No new owner policy decision was invented. The narrow chart refusals and declared future gates are visible; default Nova retains its no-Kubernetes behavior. The previous normal preview remains merged M10i main until another qualified merge.

## Task2 simulated driver checkpoint — reviewed

Initial source `e72d920e193dff7e12376de7eea75e30ead4d828` plus retained-replica follow-up `aa78db6721462132f4348093f2923e98f6cd55b9` implement the injected six-call driver and actual child-process stand-ins. The production runner remains absent. The only supported execution is uncredentialed stateless alongside-full simulation; state, other alongside modes and secret references refuse. No installed cluster, real CLI, storage, broker or network authority is proved. Exact public port, immutable definition registry, argv, bounds and limitations are in the [implementation report](../reviews/m10j-driver-implementation-2026-11-02.md).

[Independent task review](../reviews/m10j-driver-independent-review-2026-11-02.md) found one Important defect: a fresh cluster response carrying stale measured health can authorize automatic rollback or deletion of the kept rollback target. A focused injected-port probe demonstrated the latter. Fix1 `ac2ba786505f6c3d4e837e741507449c32ce68e4` requires independently fresh measured health for both effects, while preserving old evidence and its age for display. [Scoped rereview](../reviews/m10j-driver-rereview1-2026-11-02.md) closes I1 with specPass/qualityApproved and no introduced findings. Task2 is accepted within its uncredentialed scope; Task3 is now reviewed as an uncredentialed checkpoint, detailed below.

Fix1 actual-process regressions first observed three failures (stale true removing kept, stale false rolling back, and the 15001ms boundary). Final focused10/10, typecheck and diff checks passed; the internal shared15000ms bound holds state on stale/future/null evidence and preserves independent ages. No public gate-shortening field was added.

Observed separate earlier runs: 47 focused tests before final replica fixes, later changed driver/tools12 and floating rollback/shared-contract/canary3, 71 affected native/manager/supervisor/definition/placement, module boundary1 and final typecheck passed. Together these cover49 distinct focused tests; no single49-test run is claimed. Actual RED evidence caught missing implementation, locking/malformed observations, provenance, failed-preview resurrection and retained two-replica rollback; the reports preserve the test-harness stdout/stderr correction as well. Outer tripwires never fired; a deliberately nested planted-command rejection is asserted negative evidence. No suites were rerun for review.

A live selector or elapsed soak is not a completion receipt for an interrupted canary. Existing WorkLedger reconciliation/Waiting, trusted cluster collection and actual M10d approval/snapshot/dead-man wiring remain Task3. Broker-backed production credentials remain Task4, blocked on the actual foundation and #275 findings B. No phase merge, deployment, preview change or full-gate pass is claimed.

## Task3 ledger, network and read-only collection checkpoint — reviewed

Source3f919b2d plus fix815960362fb40ad3e38ee0200fcbf7f595dea5b9 connects explicit trusted configuration to symbol-protected WorkLedger proposals. Default Nova still has no cluster launcher or automatic K3s selection. Absent capability refuses before legacy value reads/effects. Actual Waiting/notStarted, unchanged approved explicit retry, server CAS, role/placement checks, cancellation/restart and unknown-completion reconciliation use existing ledger authority. Interrupted canaries remain Waiting without completion proof.

Only existing M10d owns policy snapshot/diff/tier3/apply/readback/dead-man/revert. A closed canonical document references registered immutable versions/egress; its bounded port must return independently stored actual policies. Workload preparation excludes network resources. The generic secret scanner/mask is unchanged; unsupported secret-looking public identities refuse. Persisted managed targets cannot fall back to legacy HTTP/token handling. Pure collection never arms monitors or mutates resources, and preserves independent heartbeat, node, control-plane, measured-health and readiness ages.

[Independent review](../reviews/m10j-operations-independent-review-2026-11-02.md) reproduced two Important bypasses: a cached old provider still executing after replacement with unavailable capability, and network writes after hub/requester revocation during awaited reads. It also found unknown empty canonical service entries. [Scoped rereview](../reviews/m10j-operations-rereview1-2026-11-02.md) closes all three with specPass/qualityApproved and no new blocker. Fresh provider checks retain historical observations; private composition authority and existing durable M10d task inputs bind requester/registration through writes. Automatic switch restoration retains its separately authorized exact snapshot path and still requires current capability; no public flag or second approval registry is added.

Actual separate runs: initial195 affected tests, later35 network/readback, final pre-review54 API/topology/boundary and cached-container24 browser tests all passed. Fix1 first observed six failures; final affected65/65, zero skips, typecheck and boundary passed. Retained intermediate14/15 fixture-ordering and63/64 secret-validation-order failures were corrected, not reclassified as passes. The original host3static/21browser-skip run remains explicitly NOT browser validation; actual container24/24 is the proof. No broad host suite was repeated. Exact commands/contracts/limits are in the [implementation report](../reviews/m10j-operations-implementation-2026-11-02.md).

Main#281 was merged into this evidence branch as9d136e38369592514209a8db7d6132eb92391b75 after writer release, preserving all source pins. Only its12 maintenance test/docs files differ from reviewed81596036; no Task3 source or test changed. Combined-tree typecheck passed. Main was merged, never rebased.

Trusted configuration is not public tier3 setup/joins/credential authority. General scaling, state/singleton/copy/shadow/secret capability, post-task monitoring authority and real cluster transport remain unavailable. No new UI actions, backend switch, GitOps or full Phase J pass is claimed. Task4 actual broker integration still awaits merged P1a/P1b/P1c and owner findings B for#275. Existing safe refusal coverage remains live; actual credential tickets, executable containment, isolation and cleanup are not fabricated.


## Task4 safe refusal step — reviewed; credential gate still blocked

Source `542dc064e0e3f39535a9c5f19a8fffb598b95812` changes only the existing actual-Core refusal tests. Four cases (missing capability, explicit unavailable adapter, wrong requested API cluster and hostile ambient configuration) each send valid network/deploy/promote/rollback requests: 16 API requests. They prove refusal before all adapter execution, legacy vault value reads, owned tool/plugin spawning, target HTTP effects, ledger/network work or simulator changes. A private marker positive control proves the spawn detector works and is reset before Core exists; environment cleanup runs in finally. Synthetic canaries do not appear in exercised refused outputs/logs/ledger/child transcript.

[Implementation report](../reviews/m10j-refusals-implementation-2026-11-02.md) and [independent review](../reviews/m10j-refusals-independent-review-2026-11-02.md): Step1 spec PASS, quality APPROVED, zero C/I/M. Initial four cases were already GREEN (existing safe behavior, no manufactured RED or production fix). Final covering actual Core/API/revocation/boundary tests 11/11, zero skips; typecheck/diff pass; tripwire never fired. No broad suite or browser rerun was needed for this test-only step.

Wrong API cluster is registration refusal, not a broker endpoint/grant/isolation test. Actual credential ticket replay/program binding, bound-tool-only handoff, kubectl/Helm/Flux kubeconfig/plugin/file/proxy containment, per-cluster secret separation, 0700/0600 lifetime and cleanup on exit/error/abort/cancel, tier3 setup and live broker probes remain UNPROVEN. The hostile simulator file deliberately contains a synthetic input canary; this does not prove positive-path secrecy across every file or repository. No real cluster tool, secret, owner service or target was used.

**Full Task4/phase gate remains NOT PASSED.** P1a/P1b/P1c are unmerged and #275 stays parked for findings B. Step1 approval does not authorize a credentialed runner, phase merge, preview deployment or M10k. The owner's navigation escalation is being handled in separate PR #282; this reviewed M10j checkpoint is preserved while that independent work finishes.


## Task5 full-unit checkpoint and source guard repair — reviewed

The first ordinary full-glob run at `ef60b76b4de0d329bf17a79a92d1bd6c4ecc0645` used scripts/test.sh with file concurrency2 and no Node force-exit or overlapping local browser batch. It ended **1718 tests:1703 pass,1 fail,14 existing real-model/keychain opt-in skips,0 cancelled**, exit1 after822.77s. The no-Kubernetes runtime tripwire never fired. This is a retained RED, not a full-suite pass.

The sole failure was the existing source guard at tests/supervisor/services-review.test.ts:538: four legitimate `k3s` data identity literals (registry folder, public observation, manager exclusion comparisons) looked like executable vocabulary outside the approved adapter. Fix `1673210f59f567d9c5310a0d15553e2f92467a2d` centralizes the exact `K3S_DRIVER_NAME` in the existing concrete driver. Directory/API/selection semantics are identical. The scanner, exact path exceptions, planted arbitrary-command positive control and runtime tripwire are unchanged; no string encoding/concatenation, skip or source-guard waiver was used.

[Implementation](../reviews/m10j-source-guard-fix-2026-11-02.md) and [independent scoped review](../reviews/m10j-source-guard-review-2026-11-02.md): spec/quality PASS, zero C/I/M. The unchanged guard passes1/1; thirteen affected actual driver/operations/chart/manager/placement/topology/supervisor suites pass159/159 with zero skips/cancellations/warnings and tripwire never fired. Two added assertions check the persisted cluster registry path and public topology driver field rather than importing the constant. Typecheck, diff and a tripwire-armed manager-first module initialization check pass. The driver's nine-module import closure has no manager/operations/index return edge or module-import tool/filesystem effect. Optional reviewer type introspection was unavailable through the installed TypeScript7 root API; source inference and the existing project typecheck were used, without changing dependencies.

The full1718 run was not repeated to erase its failure. Final combined-tree/full ordinary CI and fresh whole-branch adversarial acceptance remain required for a checkpoint; actual P1a/P1b/P1c and #275 findings B remain required for the **full phase gate, still NOT PASSED**. No real Kubernetes tool, credentialed path, owner service/data, image pull, preview change or phase merge is proved here.


## Combined main checkpoint after navigation repair

Main #282 merged as `048eea0ee043f43d01bc9a36bed601ce9805373b` after exact reviewed-head ordinary CI and authorized preview verification. It was merged into this branch (never rebased) as `87000830c6c5d018757a4c6a58a1e29db2fdc959`, preserving every source/eval/review pin. That merge changes only navigation UI, tests and records relative to the already-reviewed source-guard repair; no K3s source changed. The combined project typecheck passes. Cached Playwright actual navigation/guard and topology suites pass **30/30, zero skips**, 104.61s, tripwire never fired, with no screenshot flag or replacement of approved captures. This proves compatibility with the complete Home-start navigation gate, not broker credentials or a passed full phase.

Current inventory marks this work as backend implementation on the branch, with current app-shipping C23 unchanged: K3s is not app-shipped. The plain-language LEDGER entry is in an explicitly unmerged checkpoint section. Final independent whole-branch adversarial review, exact-head ordinary full CI and checkpoint publication remain controller work. A green draft checkpoint cannot authorize a full phase merge while Task4's actual dependency/proof is missing.

## Controller rulings carried into checkpoint review

| Ruling | Reason / cost if wrong |
|---|---|
| The owner's ADR, explicit uncredentialed scope and standing autonomous order authorize implementation without a second plan-confirmation round. | No extra owner policy is invented; internal engineering choices may need independently reviewed rework. New rendered patterns and #275 B keep their explicit gates. |
| Reuse our own already-isolated suitable worktree. | No owner/root/old worktree is modified; the filesystem name still says M10i while the branch and plan identify M10j. |
| Encode resource/selector identities with 160 bits derived from SHA-256. | Accepted service names exceed Kubernetes name/label limits. Generated names are less readable; original identity stays in escaped metadata. Collision/closure tests remain required. |
| Require actual P1a/P1b/P1c before credentialed M10j; continue only explicitly authorized uncredentialed work while absent. | No legacy value bridge or parallel broker. The full phase cannot merge until the real foundation and required proof exist. |
| Refuse unsupported copy/singleton/shadow/state semantics without actual capability/proof. | Do not share writers or relax readiness to make a simulation pass; some otherwise valid definitions remain unavailable and limits stay explicit. |
| Keep service-change-kind/GitOps in M10k under the accepted M10e deferral. | Current work uses existing manager/ledger authority and recorded artifacts; it does not claim the full Changes/GitOps pipeline. |
| Use existing service canary/probe defaults, with injected clocks only for deterministic stand-in proof. | No weaker public K3s gate is invented; physical cluster timing/behavior remains unproven and Task4/full-phase gates stay open. |

These are all seven `Ruling:` entries from the running plan ledger, including their practical costs; none is silently discarded or used as an owner credential decision.

Archived [selected actual checkpoint outputs and provenance](m10j-checkpoint-2026-11-02/) include the full-run failure excerpt, unchanged guard and159affected passes, safe Step1 proof and combined30browser/typecheck. Raw hashes distinguish disclosed trailing-whitespace normalization; all original failed logs remain in the owned plan audit. The pre-final-review source manifest pins the concrete uncredentialed code against merged main048e.
