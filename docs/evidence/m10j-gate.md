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

[Independent task review](../reviews/m10j-driver-independent-review-2026-11-02.md) found one Important defect: a fresh cluster response carrying stale measured health can authorize automatic rollback or deletion of the kept rollback target. A focused injected-port probe demonstrated the latter. Fix1 `ac2ba786505f6c3d4e837e741507449c32ce68e4` requires independently fresh measured health for both effects, while preserving old evidence and its age for display. [Scoped rereview](../reviews/m10j-driver-rereview1-2026-11-02.md) closes I1 with specPass/qualityApproved and no introduced findings. Task2 is accepted within its uncredentialed scope; Task3 has not started.

Fix1 actual-process regressions first observed three failures (stale true removing kept, stale false rolling back, and the 15001ms boundary). Final focused10/10, typecheck and diff checks passed; the internal shared15000ms bound holds state on stale/future/null evidence and preserves independent ages. No public gate-shortening field was added.

Observed separate earlier runs: 47 focused tests before final replica fixes, later changed driver/tools12 and floating rollback/shared-contract/canary3, 71 affected native/manager/supervisor/definition/placement, module boundary1 and final typecheck passed. Together these cover49 distinct focused tests; no single49-test run is claimed. Actual RED evidence caught missing implementation, locking/malformed observations, provenance, failed-preview resurrection and retained two-replica rollback; the reports preserve the test-harness stdout/stderr correction as well. Outer tripwires never fired; a deliberately nested planted-command rejection is asserted negative evidence. No suites were rerun for review.

A live selector or elapsed soak is not a completion receipt for an interrupted canary. Existing WorkLedger reconciliation/Waiting, trusted cluster collection and actual M10d approval/snapshot/dead-man wiring remain Task3. Broker-backed production credentials remain Task4, blocked on the actual foundation and #275 findings B. No phase merge, deployment, preview change or full-gate pass is claimed.
