# M10i Task 2 implementation report

Status: DONE_WITH_CONCERNS — assigned implementation complete and focused checks pass; full suite had three named failures, one fixed locally and two unresolved in unchanged tests.

## Scope and source pins

- Checkout: `/home/jeremy/.codex/worktrees/nova-m10i-topology/nova-build`, branch `codex/m10i-topology`.
- Baseline: `12f506b26fece73deec7fa656798fe2ca61e9706` (Task 1 complete).
- Read task brief `.superpowers/sdd/M10i/task-2-brief.md`, Global and Additional Global Constraints in `docs/plans/M10i.md`, Point 7 and tier table in `docs/plans/M10-orchestration.md`, app reconnaissance, and SDD implementer template.
- Authoritative policy remains `promotionTier` in `src/core/services/definition.ts`; ServiceManager validation/readiness/previous checks remain authoritative. The console status mapping was moved intact from `Supervisor.#consoleStatus` to shared `consoleStatus` in `src/core/resilience/link.ts` and is reused by the supervisor driver and topology projection.
- Existing workload `status()` supplies observed serving/version state. New safe workload projection uses hub-received `device_workload_report.at` (per version); an old live-health report is not refreshed by a newer candidate report. `assigned` remains separate from observed `live`.
- Existing CaptureSync `lag()` supplies only queued count, last synchronized event timestamp, status timestamp and pause reason. An old event does not become stale service health.
- No UI, server.js, root clone, older checkout, dependency, network/Tailscale/shim, cloud/K3s, real device, owner data/key or preview changes. All runtime tests use temporary homes, local fixture programs and loopback. No worker push/merge.
- The controller’s uncommitted plan refinements are excluded from this worker’s commit.

## Delivered behavior

`buildTopology` is a pure normalized snapshot builder, with `serializeTopology` operating on that same snapshot. Device IDs merge native/heartbeat and optional trusted cluster observations. The actual hub leads; local supervisor services stay with local identity even when another ID is active hub. Only explicit cluster records create cloud nodes. Revoked registry IDs cannot be reintroduced through cluster records.

Freshness is 120000ms, included as `fresh_for_ms`. Invalid/future/missing timestamps or observations at/over that age become unknown. Both source reasons, timestamps and ages survive node/service merges; worse health wins (failed, degraded, unknown, healthy). Malformed/throwing cluster input produces a partial snapshot and safe issue text. Failed denotes structured stopped/held work, not arbitrary error text. Unknown and stale never become Verified. Service observations inherit the machine’s worse health, and stale/unavailable machine or service observations disable mutations.

Native and supervisor projection is allowlisted: no raw definitions, secrets, artifact paths, commands/argv, environments, PIDs, ports, history or process output. Display names, roles and reasons are bounded and controls normalized. Source health reasons for process-backed services are factual generic summaries instead of raw diagnostic output. Mermaid uses generated IDs, quoted labels and decimal entity encoding of unsafe characters; source IDs/directives/HTML cannot become graph syntax. Its graph contains machine name/status and service name/observed live version/status/placement, generated from the returned normalized state.

An intentionally unsupervised process is explicitly labelled; it has no hub action authority. Missing/malformed managed state is unknown/partial. Missing per-version policy yields null tier and unavailable promotion, never a tier-2 default. Only actual local active-hub authority with a service-capable supervisor link can advertise hub mutations. Cluster-only services are read-only until a driver authority exists.

## Exact TypeScript DTO and input seam

The authoritative declarations are exported by `src/core/services/topology.ts`. `CoreOptions.topologyCluster?: () => ClusterObservation | null | Promise<ClusterObservation | null>` is trusted in-process injection only; no public cluster-write route or cluster client exists.

```ts
export type TopologyHealth = 'healthy' | 'degraded' | 'failed' | 'unknown';
export type TopologyStatus = 'Quiet' | 'Working' | 'Waiting' | 'Verified' | 'Needs you' | 'Failed';
export type TopologySource = 'heartbeat' | 'local' | 'cluster' | 'supervisor' | 'workload';
export interface ObservationInput { source: TopologySource; health: TopologyHealth; at: string | null; reason: string }
export interface TopologyObservation extends ObservationInput { age_ms: number | null; stale: boolean }
export interface TopologyAction { available: boolean; tier: 2 | 3 | null; path: string | null; confirm: string | null; reason: string | null }
export interface TopologyVersion { version: string; status: VersionStatus; since: string | null; observed_at: string | null; promote: TopologyAction }
export interface TopologyService {
  id: string; service: string; driver: string; placement: string; live: string | null; previous: string | null;
  assigned: { version: string; want: 'alongside' | 'live' | 'stopped'; at: string } | null;
  health: TopologyHealth; status: TopologyStatus; observations: TopologyObservation[];
  versions: TopologyVersion[]; rollback: TopologyAction;
}
export interface TopologyCaptureLag { queued: number; synced_to: string | null; at: string | null; age_ms: number | null; paused: string | null }
export interface TopologyMachine {
  id: string; name: string; kind: 'machine' | 'cloud'; roles: string[]; hub: boolean;
  health: TopologyHealth; status: TopologyStatus; observations: TopologyObservation[]; services: TopologyService[];
  capture_lag: TopologyCaptureLag | null;
}
/** GET /api/v1/services/topology. All timestamps ISO; ages milliseconds at captured_at.
 * `live` is observed serving, `assigned` is intent. Actions describe fixed POST paths (API-relative),
 * not permission grants: access/confirmation/readiness are rechecked by the mutation authority.
 * Version policy may differ by version; null tier disables promotion. Mermaid is THIS snapshot.
 */
export interface TopologySnapshot { captured_at: string; fresh_for_ms: number; hub_id: string | null; local_id: string; partial: boolean; issues: string[]; machines: TopologyMachine[]; mermaid: string }
export interface ServiceInput {
  service: string; driver: string; placement: string; live: string | null; previous: string | null;
  observation: ObservationInput; observations?: ObservationInput[]; assigned?: TopologyService['assigned'];
  versions: { version: string; status: VersionStatus; since: string; observed_at: string | null; promotion_tier: 2 | 3 | null }[];
  authority: 'hub' | 'device' | null;
}
export interface MachineInput { id: string; name: string; kind?: 'machine' | 'cloud'; roles: string[]; observations: ObservationInput[]; services: ServiceInput[]; capture_lag?: Omit<TopologyCaptureLag, 'age_ms'> }
/** Trusted in-process stand-in/future cluster adapter. No public write route. Names/health still validated. */
export interface ClusterObservation { machines: { id: string; name: string; kind: 'machine' | 'cloud'; roles: string[]; observation: Omit<ObservationInput, 'source'>; services: ServiceInput[] }[] }
export interface TopologyInput { captured_at: string; hub_id: string | null; local_id: string; machines: MachineInput[]; cluster?: ClusterObservation | null; cluster_error?: boolean; issues?: string[]; excluded_ids?: string[] }
export interface ServicePolicy { service: string; version: string; promotion_tier: 2 | 3 }

```

API `path` fields are API-relative; the existing API module prefixes `/api/v1`. `placement` is the actual stable machine ID for native/supervisor services. Promotion policy is per version, not a service-wide/capture-only guess. `since` is a version’s state-transition time and MUST NOT be used as freshness. `observed_at` is the source report/supervisor observation timestamp. UI must age retained snapshots from `captured_at`, `fresh_for_ms` and observation `at`, including after failed refreshes.

## Routes and fixed IPC

- `GET /api/v1/services/topology`: existing authenticated read access; returns `TopologySnapshot` directly, not a wrapper.
- `POST /api/v1/services/hub/{service}/promote`: approver only; exactly `{version: string, confirm: '<service>@<version>'}`. Extra fields, invalid bounded service/version names and incorrect confirmation are HTTP 400.
- `POST /api/v1/services/hub/{service}/rollback`: approver only; exactly `{confirm: 'rollback'}`. Manual rollback is tier 2 for all services.
- Existing `/api/v1/services/devices/{device}/{service}/promote` and `/rollback` remain unchanged mutation authorities; a successful device assignment is not evidence of serving.
- Read without authentication is 401; paired non-approver mutation is 403; unavailable manager/supervisor or refused manager preflight is 409.
- `SupervisorLink.service?` accepts only the typed union `{action:'promote',service,version,confirm}` or `{action:'rollback',service,confirm}`. The IPC envelope is fixed `service-promote` or `service-rollback`, with field allowlists and name validation repeated in the supervisor. No shell, argv, deploy definition, or arbitrary-command bridge was added. Existing deploy/rollback/restart IPC remains available.

Controller-decided timing contract: ALL accepted hub changes return `{ok:true,accepted:true,said:'The service change was accepted. Refresh to observe the outcome; this does not confirm it is serving.'}` after shared ServiceManager preflight. Manager execution is deferred 300ms, then revalidates through normal `promote`/`rollback`. This handles console restart and long ordinary canaries uniformly, without a new operation registry or longer IPC wait. Completion is only observed by refresh. A lost HTTP response is unknown; callers must not automatically retry the POST. Execution refusal/error opens the existing `service-stopped` supervisor playbook with safe text. Actual successful execution/history remains in the existing driver/manager. Acceptance is not durable queueing and does not promise delivery through supervisor shutdown.

## TDD and verification evidence

All commands used Node 26.3.1 by prepending `/home/jeremy/.local/share/mise/installs/node/26.3.1/bin` to PATH. All `scripts/test.sh` options precede filenames. Logs are in `/tmp/m10i-task2-*.log` on this host (outside tracked source).

### RED before implementation

1. `sh scripts/test.sh --test-concurrency=1 tests/core/topology.test.ts tests/core/topology-api.test.ts tests/core/topology-actions.test.ts`
   - `/tmp/m10i-task2-red.log`: 4 failures. Model import fails because `src/core/services/topology.ts` does not exist. Read API tests fail `404 !== 200`. Real supervised API fixture likewise has no topology route.
2. `sh scripts/test.sh tests/core/topology-actions.test.ts`
   - `/tmp/m10i-task2-ipc-red.log`: 1 failure, fixed hub mutation route `404 !== 409` before its implementation.
3. Added service-source merge regression before its fix: `sh scripts/test.sh tests/core/topology.test.ts`.
   - `/tmp/m10i-task2-merge-red.log`: 5 pass/1 fail; duplicate cluster/native service erroneously remained `healthy`, expected `failed`. Fixed by retaining both service observations and applying the same worse-source rule.

### GREEN and iteration findings

- `/tmp/m10i-task2-model-api-final.log`: `sh scripts/test.sh --test-concurrency=1 tests/core/topology.test.ts tests/core/topology-api.test.ts` — 10 pass, 0 fail, tripwire never fired.
- The real supervisor action test covers ordinary tier2, capture tier3, non-capture OS-permission tier3, all manual rollback2; invalid confirmation/extra fields/unregistered/not-ready refusal; async acceptance followed by actual serving/history; removal of a candidate registry entry after acceptance causes execution revalidation refusal and a visible problem; console promotion and rollback return acceptance before restarting the requester.
- Focused affected command:
  `sh scripts/test.sh --test-concurrency=1 tests/core/topology.test.ts tests/core/topology-api.test.ts tests/core/topology-actions.test.ts tests/core/services-manager.test.ts tests/core/workloads-hub.test.ts tests/core/resilience-repairs.test.ts tests/supervisor/services.test.ts tests/supervisor/services-cli.test.ts tests/supervisor/services-contract.test.ts tests/supervisor/services-review.test.ts tests/supervisor/guards.test.ts`
  `/tmp/m10i-task2-focused.log`: 75 tests, 75 pass, 0 fail, 0 skip, 202418ms; tripwire never fired. This preceded the final conservative missing-authority/managed-state guards, which the final model/API check and the full suite cover.
- `npm run typecheck`: exit 0 (`/tmp/m10i-task2-types.log`), after final source changes.
- `git diff --check`: clean after removing one trailing blank line in the extracted helper.
- Honest intermediate findings: first GREEN attempt exposed policy publication before registry registration (`null !== 2`); fixed by saving supervisor policy after CLI deploy registers the version. Initial non-capture fixture used `accessibility`, which existing policy correctly classifies as capture; fixture corrected to `file-access`. First async refusal test timed out because invented playbook IDs are rejected by the existing playbook registry; fixed to reuse `service-stopped`, and the expanded focused run then passed. These are resolved iteration failures, not hidden full-suite failures.

### Full suite

Exactly one `npm test` invocation was run (`/tmp/m10i-task2-full.log`). Totals: **1608 tests, 1591 pass, 3 fail, 14 skip, 0 cancelled, 191588.886ms**. The no-Kubernetes tripwire never fired. All new topology tests passed in that full run. Failures:

1. `M6a: the real server pulls Screenpipe on its own, never stores a private window, rides out an outage, refuses a remote Screenpipe, keeps capture out of git` — `tests/acceptance/m6a-capture.test.ts:69`, actual `unreachable`, expected `on`. This is the previously recorded host recovery assertion; no capture code/test edits made here. Still an observed failure, not declared fixed or conclusively attributed.
2. `module boundary: outside src/core, only src/core/index.ts is imported (src/device: only mesh/wire.ts and models/hardware.ts)` — `tests/core/api.test.ts:278`. My extracted helper initially introduced `src/supervisor/supervisor.ts → ../core/resilience/link.ts`. **Fixed** by exporting `consoleStatus` through the existing `src/core/index.ts` boundary and importing it there in the supervisor. No functional mapper change.
3. `discovery, on loopback stand-ins only: found and named, never connected; the network query bound to 127.0.0.1` — `tests/core/onboard.test.ts:101`. Expected only model-runtime/Home Assistant/computer, but an additional Screenpipe result appeared on the test’s explicit ephemeral loopback port. Controller inspection identified released `freePort()` negative-fixture ports and an earlier successful assertion, consistent with a concurrent stand-in binding a released port between discovery calls. This is a **hypothesis**, not a proven root cause. No real Screenpipe/default-3030 interaction is evidenced; no discovery/test edits made here.

Post-failure targeted command: `sh scripts/test.sh --test-concurrency=1 tests/core/api.test.ts tests/core/topology.test.ts tests/core/topology-api.test.ts tests/core/topology-actions.test.ts` — `/tmp/m10i-task2-boundary-fix.log`, **24 tests, 24 pass, 0 fail, 0 skip, 33437.091ms**, tripwire never fired. Includes the formerly failing boundary check and real console/nonconsole IPC actions on final source. Final `npm run typecheck` exited 0 and `git diff --check` passed.

There was **no second full suite**, per controller direction. The final code has targeted verification after the boundary fix; this report does **not** claim full-suite green. Coordinator’s final phase retains the two unresolved host/fixture failures.

## Files assigned/changed

- `src/core/services/topology.ts` — DTO, source normalization, safe projections, snapshot serializer.
- `src/core/index.ts` — trusted callback option, one-request collection, authenticated read route, fixed approver routes.
- `src/core/services/workloads.ts` — safe policy/report/assignment projection.
- `src/core/services/manager.ts` — shared promotion/rollback preflight and per-version policy projection.
- `src/core/resilience/link.ts` — shared console mapping and narrow typed service IPC.
- `src/supervisor/supervisor.ts` — fixed IPC validation, async manager execution, safe problem reporting and policy state publication.
- `tests/core/topology.test.ts`, `tests/core/topology-api.test.ts`, `tests/core/topology-actions.test.ts` — focused model, authenticated source/API and real supervisor action tests.

## Self-review and limits

- Kept source adapters and pure model in the planned module; no new runtime dependency or registry. Existing `src/core/index.ts` and supervisor are large, so changes stay at their existing service route/IPC/state seams.
- Preserved raw source timing and separated actual live version from assignment; generic service health explanations avoid exposing private process output.
- No real cluster exists until M10j. A failing cluster adapter is partial/unknown, never invented healthy infrastructure; no background cluster retry/cache is introduced.
- This task proves backend behavior only. Task3 owns UI adaptation, source-age recalculation, last-snapshot display, approval revalidation, same-snapshot download, keyboard/accessibility/browser/budget gates. Host Chromium availability does not affect these backend tests.
- The Mermaid graph is the displayed topology summary, not a full JSON archive of every reason/version record. All those records remain available in the same DTO.
- Coordinator owns whole-branch independent review, exact-head final CI, milestone records, merge and preview restart.

## Commit

`e9062236` — `feat(topology): expose observed map and authorized service actions`

Only the nine assigned source/test files are in the commit. Controller-owned `docs/plans/M10i.md` remains uncommitted and untouched by this worker; the task report is the requested local SDD artifact.

## Review fix round 1/5 — I1 stale no-live readiness

Finding: a new failed/installed report for v2 could give an old ready v1 fresh health when no version was live. Reproduced through both `projectService`/`buildTopology` and authenticated native-workload deploy/heartbeat/topology routes before changing implementation.

Minimal fix in `src/core/services/topology.ts`: readiness-derived health selects only report timestamps belonging to versions whose actual status is `ready`. With several ready versions it uses the latest valid receipt time among those ready reports. Missing readiness timestamps remain null/unknown. Unrelated reports retain their own per-version timestamps but cannot refresh readiness health. Existing live-health, held/failure and supervisor state projection paths remain as before. No DTO change and no `workloads.ts`/workload-hub test amendment.

Regression coverage in `tests/core/topology.test.ts` and `tests/core/topology-api.test.ts` includes no live version, hour-old ready evidence, and a fresh unrelated failed report followed by an installed report. Both cases must be unknown/Waiting with the original observation time, age 3600000ms and stale=true. The real API regression also proves that a fresh report of the actual ready version can establish Verified again, independently of old version `since`.

RED command (before implementation fix):

```sh
PATH=/home/jeremy/.local/share/mise/installs/node/26.3.1/bin:$PATH sh scripts/test.sh --test-concurrency=1 tests/core/topology.test.ts tests/core/topology-api.test.ts
```

`/tmp/m10i-task2-i1-red.log`: 12 tests, 10 pass, **2 fail**, 0 skip. Both newly added regressions failed with actual `healthy`, expected `unknown`:
- `fresh unrelated native reports do not refresh an older ready version when none is live`
- `no-live readiness health keeps the receipt time of its evidence, not another version’s fresh report`

GREEN: same exact command after the fix. `/tmp/m10i-task2-i1-green.log`: **12 tests, 12 pass, 0 fail, 0 skip, 1597.290ms**. No-Kubernetes tripwire never fired on RED or GREEN.

Additional checks:
- `PATH=/home/jeremy/.local/share/mise/installs/node/26.3.1/bin:$PATH npm run typecheck` — exit 0 (`/tmp/m10i-task2-i1-types.log`).
- `git diff --check` — clean.
- Reviewed only this focused projection/test diff; no controller plan, UI, external environment or unrelated source edits.
- **No second full suite**, as directed. Earlier full-suite failures remain recorded above; M1 runtime-warning classification remains controller follow-up. This targeted GREEN does not claim full-suite green.

Fix commit: `b61ace15` — `fix(topology): bind readiness health to its version report`. Only the three assigned source/test files were committed.

## Review fix round 2/5 — I2 null-health live observation

Reviewed `.superpowers/sdd/M10i/task-2-rereview1.md`: I1 is addressed; I2 identified that the readiness path introduced in round 1 could replace a stale live report when its health was null. Reproduced before the source fix with a live v1 report at11:00, ready v2 at12:00, captured at12:00, through pure projection and real native API routes.

Minimal production change: the readiness-derived health path in `projectService` now requires `s.live === null`. The same condition controls readiness timestamp substitution. Thus an observed serving version with null health stays unknown with its own report timestamp, whether that timestamp is stale OR fresh. A candidate cannot supply serving-health evidence or enable actions through it. The no-live readiness fix remains intact. No DTO, collection, workload, supervisor, authority or route change.

Coverage:
- New model regression `ready candidates cannot replace stale or fresh null-health observations of a live version` checks both stale and fresh live-report boundaries, preserved age/time, unknown/Waiting, no invented readiness health reason, and unavailable promotion/rollback.
- Expanded the real API regression (now named `native readiness health follows its own reports without replacing a live version’s observation`) to retain I1 no-live checks, then report a null-health live v1 and a fresh ready v2. Both stale and freshly re-reported null live health remain unknown; an explicit healthy report for the live version restores Verified.

Exact RED and GREEN command (Node26.3.1; flags before files):

```sh
PATH=/home/jeremy/.local/share/mise/installs/node/26.3.1/bin:$PATH sh scripts/test.sh --test-concurrency=1 tests/core/topology.test.ts tests/core/topology-api.test.ts
```

RED before production change: `/tmp/m10i-task2-i2-red.log`, **13 tests, 11 pass, 2 fail, 0 skip**, 1464.992ms. Both model and real API regressions failed actual `healthy`, expected `unknown`; I1’s no-live regression still passed.

GREEN after the one-condition fix: `/tmp/m10i-task2-i2-green.log`, **13 tests, 13 pass, 0 fail, 0 skip**, 1642.903ms. No-Kubernetes tripwire never fired in either run.

`PATH=/home/jeremy/.local/share/mise/installs/node/26.3.1/bin:$PATH npm run typecheck` exited0 (`/tmp/m10i-task2-i2-types.log`); `git diff --check` passed. Self-review confirms both health derivation and timestamp substitution are gated, with the old-live-healthy and no-live readiness regressions preserved.

No full-suite repeat, no unrelated source/UI/controller-plan edits. Earlier full-suite failures and warning attribution remain controller-owned follow-up, not claimed green by this fix.

Round2 commit: `9172d9c5` — `fix(topology): preserve unknown live health beside ready candidates`. Only the three assigned source/test files were committed.


## Coordinator review outcome

The independent review at `e9062236` found I1, false fresh readiness from an unrelated version. The first test-first fix `b61ace15` addressed it but introduced I2, a ready candidate overwriting null-health live evidence. The second test-first fix `9172d9c51e60a632c20bf7565cdaa4839aea159d` restricts the readiness health/time path to no-live services. The scoped final review finds I2 addressed with no new Critical/Important breakage. [Initial review](m10i-backend-independent-review-2026-11-01.md), [round1](m10i-backend-rereview1-2026-11-01.md), [round2](m10i-backend-rereview2-2026-11-01.md).

Minor M1 remains explicit validation follow-up. The localStorage ExperimentalWarning also occurs on the earlier unchanged `128e1298` full-host run, so it is a documented baseline diagnostic and is not suppressed. DEP0187 (`fs.existsSync` invalid argument types) appears in the new full run near unchanged provider-guard tests; no captured stack proves attribution. It remains an unattributed runtime warning, not claimed fixed or ignored as pristine output. The M6a recovery and onboarding negative-port fixture failures also remain recorded for the full phase gate. No green full-host-suite claim is made.

The pre-existing M10e `service` change-kind/GitOps deferral remains (docs/evidence/m10e-gate.md:13). These actions reuse today's typed ServiceManager authority and outcomes; they do not implement the deferred service-change pipeline or a durable operation queue. API acceptance is explicitly not completion or observed serving. Application/browser/budget gates remain Task3/4 work.
