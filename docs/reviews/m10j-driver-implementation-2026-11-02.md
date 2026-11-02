# M10j Task 2 implementation report — 2026-11-02

Controller gate note: independent Task2 review found one Important stale-health automatic-effects defect; Task2 is NOT accepted yet. This is the initial implementation report, retained without rewriting its historical evidence. See [independent review](m10j-driver-independent-review-2026-11-02.md).

Status: implementation and final checks complete; Task2 implementation ownership released. Final head aa78db6721462132f4348093f2923e98f6cd55b9. Baseline e72d920e193dff7e12376de7eea75e30ead4d828 remains immutable for its already-dispatched independent review; one narrow follow-up delta is recorded below. Production capability remains unavailable; this is the authorized uncredentialed simulation checkpoint only. No source push, merge, preview, credential, host Kubernetes, image, installation, external-network, cloud or owner-data action occurred.

## Source contract

Public exports are through `src/core/index.ts` -> `src/core/services/index.ts`:

- `K3sDriver implements ServiceDriver`, name `k3s`: `available`, `plan`, `apply`, `status`, `switch`, `rollback`; additionally asynchronous `refresh(service)` and `close()`.
- `K3sDriverOptions`: required `cluster: K3sCluster`, `directory: string`; optional `tools: ClusterTools`, `clock: K3sClock`, `probeOrigin: string`, `authorizeNetwork(request, signal): Promise<ServiceOutcome>`, `problem({source:'k3s',subject,said})`, `say(line)`.
- `K3sCluster`: `{id, namespace, hubId, devices: readonly PlacementDevice[]}`. Devices are public placement metadata, not credentials or joins. Chart values use the existing placement resolver and Task1 builder, never a new placement policy.
- `K3sClock`: `now(): number`, `sleep(ms:number, signal:AbortSignal):Promise<void>`, `schedule(callback:()=>void,ms:number):()=>void` (returns cancellation). There are no task/API canary-shortening options. Readiness requires three successful probes separated by 5000 ms; switch observes the full 120000 ms canary at 5000 ms intervals. The fixture advances an injected clock while every observation still invokes actual child programs and every HTTP probe reaches the loopback server.
- Network hook request: `{cluster:K3sCluster, definition:ServiceDefinition, values:K3sChartValues, expected:ServiceExpectedState}`, plus the abort signal. Required before preparing any chart, including egress-none charts containing NetworkPolicy. No hook means plan/apply refuse before a tool call; a hook refusal cannot mutate cluster resources. Task3 must connect existing M10d approval/snapshot/dead-man authority; this callback is not a token, grant or approval registry. The only positive callback here is explicitly test-only.
- `ClusterTools`: `available(): ServiceOutcome`, `execute(operation:ClusterOperation,signal?:AbortSignal):Promise<ClusterSnapshot>`. No executable, shell, argv, arbitrary manifest, URL, credential or kubeconfig argument exists in the production port. The default `unavailableClusterTools` does no discovery or I/O and explains missing broker-backed launcher capability.
- `ClusterOperation` always contains `{cluster,namespace,service}`. Fixed variants: `status`; `prepare` + `values`; `validate` + `version,passed`; `switch` + `version,soak_until`; `rollback` + `version:string|null,reason`; `scale` + `version,replicas:0|1`; `remove` + `version`. Every non-status variant additionally requires `expected:{revision:number,state:ServiceExpectedState}`. The fake permits scaling only stopped kept resources to zero; no rescheduling/start authority is implemented by this variant.
- `ClusterSnapshot` schema 1: `{schema:1,cluster,namespace,service,revision,sequence,observed_at,live,previous,assigned,versions,soak_until,held}`. `live/previous/assigned` use existing `ServiceExpectedState`. Revision is the server-side resource mutation version; sequence increases for every successful observation independently. The adapter must atomically compare BOTH revision and expected semantic state before mutation. Do not implement this as a preflight-only check in Task3.
- Each `ClusterVersion`: `{version,replicas,ready,ready_at,health:{ok:boolean|null,checked_at:string|null,said:string|null},status,since,ports,state_refs}`. Supported states: alongside, ready, live, kept, failed, removed, rolled_back. Fake state-volume references are empty because all stateful workloads are refused. No desired replica or manifest is treated as readiness proof.
- `K3sStatus extends ServiceStatus`: `{cluster,revision,observed_at,failure:{at,said}|null,readiness:[{version,ready,checked_at}]}`. Service health is the observed selected version's health. Stable/preview port maps are the cluster service's observed port declarations, not externally advertised host forwarding URLs; pid is null. Cached `status()` performs no I/O. Failed reads change failure provenance only, not cluster observation, measured-health or readiness timestamps. `refresh()` rejects malformed, stale (>15000 ms), future, regressed revision/sequence, and regressed health/readiness timestamps; it never freshens an old measurement. Periodic observation remains armed after control-plane failure, to observe restoration.

Canonical source declarations are `src/core/services/k3s/tools.ts`, `driver.ts` and `registry.ts`; these are the exact Task3 integration contract, rather than the prose abbreviations above.

## Persistence, concurrency and interrupted work

`K3sRegistry` stores immutable schema-1 `{definition:ServiceDefinition}` records at `directory/SHA256(JSON.stringify([service,version])).json`; files use mode 0600, directory 0700, exclusive creation. `get()` revalidates identity and schema and returns a copy; changed definitions for the same version refuse. This registry is not a WorkLedger, approval store, credential store, durable desired-state queue or command journal.

There is one in-process queue per `[cluster.id,namespace,service]` shared across driver instances. The fake server additionally uses a filesystem transaction lock and compares expected revision/live/previous/assigned inside the mutation, covering concurrent owners outside that queue. A contender never removes another owner's lock. Rollback binds its target before waiting and compares it inside execution; a changed previous target cannot consume the old approval.

Possibly completed operations are not retried: after a lost prepare reply, a subsequent apply reads actual cluster state and refuses replay. Close aborts owned probes/canary waits and cancels owned timers; it does not delete cluster resources or infer a rollback/commit. **A live selector is not a promotion-completion receipt.** An interrupted canary remains unverified/unknown for Task3's WorkLedger reconciliation/Waiting handling. This port does not persist a canary-completion receipt, and elapsed time or healthy refresh must not be used by Task3 to mark that operation complete. A restarted driver can re-read immutable definitions and actual cluster state; it does not silently resume or replay an interrupted mutation. The existing ledger remains the authority for durable operation lifecycle.

Apply starts previews without changing stable traffic. Failed contracts are never ready. Switch uses fresh control-plane state and three-probe prepared readiness; it watches the full canary and restores only the previously bound kept version, with no prepare/download. With no previous version, automatic failure clears the selector, stops the failed instance and reports held. After successful canary, periodic refresh watches health and soak expiry: unknown health keeps the previous version; measured healthy expiry removes it; observed unhealthy live state rolls back. No new apply/switch/rollback/scale/remove succeeds during control-plane loss even when synthetic pods and node metadata remain healthy.

A concrete self-review fix preserves actual per-version replica counts when building subsequent values, so failed/stopped retained previews cannot be resurrected by a new prepare. The fake independently rejects any prepare that changes retained counts.

## Actual fake programs and confinement

Committed executable entrypoints: `scripts/stand-ins/fake-kubectl.js`, `fake-helm.js`, `fake-flux.js`; shared test-only server `k3s-simulation.js`. `tests/support/k3s.ts` is the ONLY runner. It creates a disposable HOME, state file and PATH containing only symlinks to those committed fakes and the current Node executable. Spawn uses an argv array, never a shell. Child environment contains only PATH, HOME, NOVA_SIM_STATE and NOVA_SIM_NOW; kubeconfig, proxy, plugins, tokens and ambient HOME authority are not inherited. Missing fake executables fail, with no host PATH fallback or production environment switch.

The complete argv grammar is:

`["nova-simulation", operation, "--namespace", namespace, "--service", service]`

JSON operation data is bounded stdin. Helm accepts prepare validation only; Flux accepts status/watch recording only; kubectl accepts the closed union. Each process independently validates its exact argv shape, closed operation keys, cluster identity, namespace, service identity and operation-specific shape. This is an intentionally fake protocol, not a purported usable real CLI command sequence.

Child input/output cap: 262144 bytes; deadline: 3000 ms; oversized output or deadline kills the fixture child. Errors are generic, without echoing rejected payload/credential values. State is written under the fixture-owned transaction lock by atomic rename. Nodes, observed pod counts/readiness/health, selectors, held/removed state, resource revisions and control-plane reachability are independent fixture state. Flux records watched services only: this does not implement M10k services.git/GitOps ownership.

The synthetic service is a fixture-owned `127.0.0.1` server with stable and version-preview routes, independently reading actual fake cluster state. The driver accepts only an injected explicit HTTP 127.0.0.1 origin with a port, no auth/path/query/hash. It never accepts tool-reported URLs. Probe paths reject network-path forms, backslashes, traversal and encoded slash/backslash/dot forms. HTTP uses no proxy/plugin authority, no redirects, 2000 ms deadlines and 65536-byte response caps. Redirects fail checks rather than escaping the origin. No external URL is contacted, even in rejection tests.

The schema evaluator was extracted from Task1 tests into `scripts/stand-ins/k3s-schema.ts` without a test-runner import. It remains independent of the production renderer, rejects unsupported semantic keywords and remote refs, and validates schema plus independently constrained command/resource shapes. Deliberately invalid image digests, namespace/name, OS selector, extra manifests and retained-replica mutations fail actual child processes.

## Consumed Task1 contract and minimal shared changes

Task1 baseline: 683f54d7. Schema SHA256: `729fae00f61f823f5b5a7191668d97843609804aefb4205f8eb8e6424565e67a`. The required `strategy.type` is consumed (RollingUpdate for supported stateless full); no schema/chart template changes. Existing deterministic device-label implementation was exported as `k3sDeviceLabel`, with its implementation unchanged; fixture node labels reuse it. Public exports were added in services/index.ts. Task1 chart tests import the extracted generic evaluator.

The static literal-command guard excludes only the exact driver and fake modules that must name the protocol/backend; no directory-wide exclusion or tripwire weakening. A planted literal matches the static guard and a positive nested tripwire test records/rejects a planted command. Default driver tests run with an ambient fake executable PATH and hostile disposable kubeconfig and still make zero calls/read no config.

## Refusals and checkpoint limits

- No production runner or cluster registration/onboarding surface. Broker credentials/default launcher absent; #275 remains parked. No secret-ref workloads, credential reads or fallback to legacy vault values.
- All stateful, alongside-none/copy/shadow workloads refuse in plan/apply. There is no safe singleton readiness/storage capability here, so no zero-replica “ready”, shared writer, RWO safety assumption or real-storage claim. Native-only artifacts refuse; image values never launch native programs.
- Linux, role, hardware and resolved placement must be supported by both existing resolver and independent fake node matching. Unsupported network/OS semantics refuse. Real device/cluster reachability and real Helm/Kubernetes semantics remain outside this checkpoint.
- No new durable authorization/queue/retry authority. Task3 must wire existing manager/WorkLedger/M10d paths, expected-state approvals, and conservative reconciliation, especially interrupted canaries. The simulation is not evidence of credentialed deployment or a phase gate.

## Observed verification (raw files retained, not reconstructed)

All commands used Node 26.3.1 via `/home/jeremy/.local/share/mise/installs/node/26.3.1/bin`; flags precede test paths. Logs include actual stdout/stderr summaries and exit status. No broad host suite was rerun.

- `task-2-red.log`: six observed missing-driver behavioral failures, including unchanged `tests/support/service-driver-contract.ts` (exit 1).
- `task-2-green-initial.log`: shared contract/default refusal/placement/control loss/canary, 6 pass (exit 0).
- `task-2-red-boundaries.log`: missing lock ownership and malformed-null output behavior, 2 failures (exit 1); `task-2-green-expanded.log`: 43 pass (exit 0).
- `task-2-red-provenance.log`: health timestamp and continued periodic observation failures, 2 fail (exit 1); `task-2-green-provenance.log`: 4 pass (exit 0).
- `task-2-green-focused.log` and `task-2-tripwire-diagnostic.log` retain an initial positive-tripwire assertion failure: the invoked shell returned its FIRED diagnostic on stderr, not stdout. Assertion corrected to inspect both streams; no product defect or tripwire weakening.
- `task-2-final-focused.log`: `sh scripts/test.sh --test-concurrency=4 tests/core/k3s-driver.test.ts tests/core/k3s-tools.test.ts tests/core/k3s-review.test.ts tests/core/k3s-chart.test.ts`: 47 pass, exit 0, outer tripwire never fired.
- `task-2-red-replicas.log`: actual fake accepted retained-version replica resurrection (1 failing behavioral test, exit 1). Fixed builder inputs and independent fake invariant.
- `task-2-green-replicas.log`: final changed driver + tools scope, `sh scripts/test.sh tests/core/k3s-tools.test.ts tests/core/k3s-driver.test.ts`: 12 pass, exit 0, tripwire never fired. This is the final implementation regression run after the 47-test run above; the added test makes 48 focused tests in total, not a falsely claimed single 48-test invocation.
- `task-2-affected.log`: `sh scripts/test.sh --test-concurrency=1 tests/core/services-definition.test.ts tests/core/services-placement.test.ts tests/core/services-manager.test.ts tests/core/workloads-device.test.ts tests/core/workloads-hub.test.ts tests/core/workloads-rollout.test.ts tests/supervisor/services-contract.test.ts tests/supervisor/services-review.test.ts`: 71 pass, exit 0, tripwire never fired.
- `task-2-boundary.log`: module boundary test in tests/core/api.test.ts, 1 pass, exit 0, tripwire never fired.
- `task-2-final-typecheck.log`: `npm run typecheck`, exit 0 after final implementation fix. Earlier typecheck logs also pass.
- `task-2-fake-processes.log`: raw actual child argv/stdout/stderr/exit-status JSON covering Helm validation, Flux watched-state/status, kubectl observations/prepare/validate and a rejected invalid namespace (child exit 1), enclosing trace exit 0. Disposable HOME is removed by harness teardown.

Task2 source commit excludes this ignored report/log workspace and all controller plan/ledger/evidence records. The controller performs independent review before Task3.

## Final follow-up delta and release

Baseline source commit: `e72d920e193dff7e12376de7eea75e30ead4d828`. Final source commit: `aa78db6721462132f4348093f2923e98f6cd55b9`. Both source commits exclude this report and logs. Working tree is clean. No implementation actions remain; ownership is released to the controller.

A final self-check caught a concrete simulation bug: rollback restarted a retained floating version with one replica rather than its previously observed two. `task-2-red-floating.log` records the actual-process 1 != 2 failure (exit 1). The follow-up touches only `scripts/stand-ins/k3s-simulation.js` and `tests/core/k3s-review.test.ts`: the fixture stores the observed running count when stopping the previous version and restores that bounded count on rollback; an absent/invalid retained count refuses. This private fixture state is measured resource history, not desired-operation/approval storage, and changes no public port signature or registry schema.

`task-2-green-floating.log`: targeted actual-process shared apply/switch/rollback contract, canary/first-live failure, and two-node/two-replica floating rollback, 3 passed, exit 0, tripwire never fired. `task-2-floating-typecheck.log`: final `npm run typecheck`, exit 0. Diff check clean. `task-2-floating-commit.log` records the follow-up commit. The earlier 47-test focused run + final targeted replica checks cover 49 distinct focused tests; no single 49-test invocation is claimed.

Review delta is precisely `e72d920e..aa78db67`. Main contract/source pins for Task3 are final head above; interrupted-canary, broker/network integration and storage limitations remain exactly as documented.
