# M10i whole-branch independent review

**Ready to merge? No — two Important failure-projection defects need fixes.** The earlier approval-state, client-expiry and replacement-sheet findings remain closed. Final exact-head CI remains a separate, pending gate.

Reviewed base `5e3c8b4ae22bc341e7b83694695c574440f7cb50` through verified HEAD `ff36c17501972ab71b9d311c14843c449d4ebc46`, using the supplied 6,054-line whole-branch package. Read all production/test source segments in bounded chunks without omitted/truncated source sections, the ADR tier table/Point 7/gate, plan constraints/Task 4, evidence and historical reviews. Documentation output that truncated was recovered through narrower relevant reads. No repeated git diff, suite rerun, source/index/HEAD/branch mutation, subagent, preview or real-resource operation. Two focused probes below resolve specific untested failure-projection doubts. Only this report was written; the HTTP probe used existing disposable-home/loopback helpers and closed them.

## Strengths

- **Authority and approved state are bound through execution.** Fixed approver-only routes validate closed fields and expected state (`src/core/index.ts:1277`, `:1316`); the typed IPC carries it into manager preflight and delayed execution (`src/supervisor/supervisor.ts:374`). The actual supervisor queue compares before effects (`src/supervisor/services.ts:277`, `:410`); console comparison and its busy lock precede awaits (`src/supervisor/supervisor.ts:444`, `:643`); native read/compare/write uses the synchronous `BEGIN IMMEDIATE` transaction (`src/core/services/workloads.ts:154`, `:175`; `src/core/db.ts:51`). Existing authentication, origin/header, approver and replica/held-write gates remain. No command, argv or definition bridge was added.
- **Earlier findings stay closed.** The no-live readiness timestamp is tied to the ready version and cannot replace live null-health evidence (`src/core/services/topology.ts:160`). Client expiry independently merges Failed > degraded > unknown > healthy (`ui/js/topology.js:26`). Submission completion checks the same visible, connected approval form before closing/focusing (`ui/js/topology.js:152`). The corresponding RED/GREEN records and actual queued HTTP→IPC and replacement-sheet regressions substantiate these fixes.
- **Privacy and truthful intent are mostly well handled.** Safe service projections omit process output, definitions, argv/env and paths; revoked IDs are excluded; actual local services remain attached to local identity. Assignment is distinct from observed serving. Capture lag retains its report age, with consent explicitly unknown. Ordinary/privileged promotion and manual rollback use existing manager policy, and hub acceptance is not represented as completion.
- **Snapshot and UI integration are coherent.** Generated Mermaid IDs and encoded quoted labels prevent labels becoming directives (`src/core/services/topology.ts:142`); download uses the stored displayed text and refuses overlays (`ui/js/topology.js:119`). Network-only topology, shell caching, no POST retry, stable selection/focus, visible polling and both non-rail entry points are present. No runtime dependency or third-party script was introduced.

## Issues

### Critical

None found.

### Important

**I1 — A current supervisor hold is aged using an unrelated old health check.**

- **Location:** `src/core/services/topology.ts:191`, with failure derivation at `:169`–`:172`.
- **Observed defect:** `supervisorServices` always prefers `s.health.checked_at` over the current supervisor observation. `projectService` then changes the observation's meaning to “held after stopping repeatedly” without changing its provenance. A hold recorded now, alongside a ten-minute-old last health check, becomes stale unknown/Waiting. The focused probe below returned `heldAt=12:00`, `stateObservedAt=12:00`, but observation `at=11:50`, `age_ms=600000`, `health=unknown`, `status=Waiting`.
- **Real trigger:** `SupervisorDriver.#hold` writes `held.at` and saves without updating the previous measured health (`src/supervisor/services.ts:641`). Crash-loop holding, missing-slot recovery and restart failure can take this path; configured health intervals may be up to 3,600 seconds. The map and Mermaid therefore lose a known current stop, even though that failure evidence exists. `state.mode === 'stopped'` likewise changes health to failed while retaining the selected health-check timestamp at topology line 192.
- **Required correction:** preserve measured health and current held/stopped state as distinct evidence. A fresh `state.observed_at` can attest that a held latch is *still present*, even if `held.at` (the occurrence time) is older. Do not globally replace `health.checked_at` with `observed_at`, which would freshen old health/readiness and regress earlier fixes. Keep the hold occurrence time/reason available, use an appropriate current observation timestamp for the stopped-state claim, and independently expire that observation. Add regressions for a newly held service with stale measured health, an old still-held latch freshly observed, and an actually stale supervisor observation; preserve the existing stale-live and old-ready regressions.

**I2 — A freshly reported native workload stop becomes unknown rather than Failed.**

- **Location:** `src/core/services/workloads.ts:220` and `src/core/services/topology.ts:170`.
- **Observed defect:** the new topology adapter consumes `status()` health, which only selects a `status === 'live'` report (`src/core/services/workloads.ts:199`, `:205`–`:206`). When the assigned live version reports `failed`, its version status survives but its observed failure does not: no `live` report means null health and no held flag, so projection returns unknown/Waiting. A real synthetic deploy → ready → promote → failed heartbeat probe below returned HTTP 200 for deploy/promotion, `assigned.want='live'`, `live=null`, one fresh `failed` version, but overall `Waiting` and “No verified service health observation.”
- **Real trigger:** the existing device rollout explicitly stops a failed promoted workload when no previous version is kept and emits `status:'failed', health:false` (`src/device/rollout.ts:209`–`:211`). This is stopped work, not missing data. The service row/header and exported summary hide the reported failure; a user must inspect a lower-level version row to discover it.
- **Required correction:** project a relevant fresh stopped/failed workload report with its own hub receipt timestamp and safe reason, without inventing a serving version. Distinguish this assigned-live/no-serving failure from an unrelated failed candidate beside a healthy live service or stale ready candidate. Add real API and model regressions for the first promoted version failing with no rollback target, its independent expiry, and recovery. Retain the old-ready/unrelated-report and null-health live tests; do not promote any arbitrary historical failed version into current service failure.

### Minor

No new change request. Existing localStorage warnings and unattributed DEP0187 remain disclosed, unsuppressed and queued; they do not establish a new topology production defect. They also do not make the broad-host output pristine.

## Validation and rendered evidence

Inspected actual covering outputs, not just report totals:

| Evidence | Observed result |
| --- | --- |
| `.superpowers/sdd/M10i/task-3-fix1-backend-all.log` | 33 pass, zero fail/skip; model, API, manager/native and real supervisor actions |
| `task-3-fix1-ipc-queue.log` | 1 pass, zero fail/skip; real HTTP→IPC acknowledgement and queued execution refusal |
| `task-3-fix1-app-all.log` | 28 pass, zero fail/skip; 23 app and five styleguide tests, both engines/all six packages matrix and four adversarial fixes |
| `task-3-fix1-static.log` | 62 pass, zero fail/skip; lint/themes/typecheck complete; two disclosed localStorage warnings |
| `task-3-fix1-vitals.log` | 12 runs/width, seven interactions: phone CPU4× LCP316ms/INP64ms/CLS0.000; desktop148/40/0.000 |
| `task-3-vitals.log` | Complete historical M9 main-view table passes; observer extraction preserves its calculations, widths and thresholds |
| `task-1-fix2-green.log`, `/tmp/m10i-task2-i2-green.log` | Historical renderer5/5 and backend correction13/13; corresponding RED logs retain failures |

The inspected broad logs remain **failed**: `/tmp/m10i-task2-full.log` has 1591 pass/3 fail/14 skip; `task-3-npm-test.log` has 1593 pass/4 fail/14 skip. The boundary/timer defects were corrected and covered later. Capture recovery, onboarding fixture-port hypothesis, provider result and email timing failures remain follow-ups; isolation does not resolve their broad-run outcomes. Final exact-head gate, audit and broad UI validation have not been run for this source. Historical draft CI is not current evidence.

Opened 14 actual PNGs: app Chromium machines desktop/phone, services desktop, versions phone, capture approval phone, merged failure, stale service, no-hub, failed refresh, empty and loading; app WebKit versions desktop and capture rollback phone; styleguide Chromium `specimen-attention-service-phone.png`. The eight design checks pass for these reviewed surfaces: leading connected hub instead of equal card grids; left alignment; no new decorative gradients; one primary approval action; distinct title/group/row hierarchy; token spacing; existing icons only; factual empty/loading/error copy. Ages and reasons are readable and historical wording survives drill-in. Phone detail uses the existing scroller. These historical captures do not prove the two newly identified failure cases or post-fix elapsed transitions; those require targeted regression evidence.

## Recommendations

Resolve I1 and I2 in one focused projection/test wave, preserving separate observation provenance and the already-closed approval/expiry/sheet fixes. Have the correction independently re-reviewed, update phase evidence with its source pin and actual outcome, then run the final exact-head required gates. Preserve the disclosed broad failures and warnings even if CI later passes.

## Declined to judge

- Real K3s/cloud-site collection, credentials and deployment behavior: no driver is delivered; only the trusted stand-in seam is in scope, with no public writer.
- Physical devices, Windows/macOS capture/permissions, physical hinges and OS-specific background scheduling: synthetic loopback/browser evidence cannot prove them; the limitations are disclosed.
- Device-agent/runtime self-update promotion as a managed map service: no corresponding ServiceManager service/authority exists in this implementation. The ADR's tier-3 obligation must apply when that integration exists; the currently exercised non-capture privileged services are tier 3, not a proof of a device-agent update workflow.
- Durable completion/acceptance queue, service change-kind/Work Ledger/GitOps integration, secret delivery and vault #275 cutover: explicitly deferred by the binding continuation and evidence. Acceptance semantics were reviewed as such, not as guaranteed delivery through supervisor shutdown.
- Root causes or resolution of the unrelated broad-host scheduling failures and DEP0187: existing evidence does not establish attribution; controller-owned follow-up retains them. Baseline localStorage classification was treated as historical evidence, without accessing protected old worktrees.
- General hardening of unchanged native program permission/egress enforcement and escaped process-group behavior: disclosed pre-existing driver limits, not implemented by these fixed version-selection routes.
- Final exact-head CI/audit, merge readiness as an operational gate, actual merge date and preview restart: explicitly reserved for Task 4 after fixes; no such operation was performed or inferred complete.
- Alternate-theme owner design approval and exhaustive reinspection of every historical PNG: package correctness is covered by recorded tests, but this review visually sampled the 14 named renders and does not grant new design approval to alternate themes.

## Assessment

**Ready to merge? No.** The branch is substantially aligned with the approved map, security and integration requirements, and earlier Important fixes are intact. Two reproducible projections still turn current stopped work into Waiting, violating the shared failure/status contract; fix them before the independent correction review and final CI gate.

## Focused reproductions

These are the exact commands executed from the task checkout, with output excerpts. They are probes, not claimed regression-suite runs.

### I1: pure supervisor projection

```sh
/home/jeremy/.local/share/mise/installs/node/26.3.1/bin/node --input-type=module <<'NODE'
import { supervisorServices, buildTopology } from './src/core/services/topology.ts';
const now='2026-11-01T12:00:00.000Z';
const old='2026-11-01T11:50:00.000Z';
const s={v:1,mode:'running',since:old,server:{port:0,pid:1,started_at:old},safe_mode:null,health:{last_check_at:now,failing:0,said:null},releases:{current:'base',previous:null,slots:[]},history:[],observed_at:now,service_policies:[],services:[{service:'worker',driver:'supervisor',live:'1',previous:null,held:{reason:'Crash loop stopped',at:now},health:{ok:true,checked_at:old,said:null},versions:[{version:'1',status:'live',since:old}],history:[]}]};
const projected=supervisorServices(s,true,'hub',now,'base',true);
const dto=buildTopology({captured_at:now,hub_id:'hub',local_id:'hub',machines:[{id:'hub',name:'Hub',roles:[],observations:[{source:'local',health:'healthy',at:now,reason:'Answering'}],services:projected.services}]});
console.log(JSON.stringify({heldAt:s.services[0].held.at,stateObservedAt:s.observed_at,result:dto.machines[0].services.find(s=>s.service==='worker')},null,2));
NODE
```

Output excerpt (exit 0):

```json
{
  "heldAt": "2026-11-01T12:00:00.000Z",
  "stateObservedAt": "2026-11-01T12:00:00.000Z",
  "result": {
    "health": "unknown",
    "status": "Waiting",
    "observations": [{
      "source": "supervisor", "at": "2026-11-01T11:50:00.000Z",
      "age_ms": 600000, "stale": true, "health": "unknown",
      "reason": "The service is held after stopping repeatedly."
    }]
  }
}
```

### I2: actual synthetic native API projection

```sh
NOVA_VAULT_KEY=file /home/jeremy/.local/share/mise/installs/node/26.3.1/bin/node --input-type=module <<'NODE'
import { hub, call, enroll } from './tests/core/mesh-support.ts';
import { standInUrl, standInSha, STAND_IN_NAME } from './tests/support/workloads.ts';
const h=await hub();
try {
 const d=await enroll(h,{name:'Synthetic failure probe',kind:'computer',platform:'linux x64',purposes:['general-server'],capabilities:['heartbeat']});
 const hb=(workloads=[])=>call(h.mesh,'POST','/api/v1/mesh/devices/me/heartbeat',{version:'0.1.0',capabilities:['heartbeat'],workloads},{authorization:`Bearer ${d.token}`});
 await hb();
 const definition={service:'worker',version:'1',artifact:{program:{'linux-x64':{url:standInUrl(),sha256:standInSha(),command:['node',STAND_IN_NAME]}}},ports:[{name:'api',port:18790}],health:{http:'/health',every_s:5},contract_tests:[],alongside:'none',placement:{mode:'pinned',device:d.dev.deviceId},secrets:[],os_permissions:[],egress:'none'};
 const deploy=await h.c('POST','/services/devices/deploy',{definition,confirm:'worker@1'});
 await hb([{service:'worker',version:'1',status:'ready',health:null,since:new Date(h.clock.t).toISOString()}]);
 const promote=await h.c('POST',`/services/devices/${d.dev.deviceId}/worker/promote`,{version:'1',confirm:'worker@1'});
 await hb([{service:'worker',version:'1',status:'failed',health:false,since:new Date(h.clock.t).toISOString(),said:'Its health failed after it was switched to, and there is no version kept to go back to.'}]);
 const r=await h.c('GET','/services/topology');
 const s=r.body.machines.find(m=>m.id===d.dev.deviceId).services[0];
 console.log(JSON.stringify({deploy:deploy.status,promote:promote.status,assigned:s.assigned,live:s.live,health:s.health,status:s.status,observations:s.observations,versions:s.versions.map(v=>({version:v.version,status:v.status,observed_at:v.observed_at}))},null,2));
} finally {await h.stop();}
NODE
```

Output (exit 0):

```json
{
  "deploy": 200,
  "promote": 200,
  "assigned": {"version":"1","want":"live","at":"2026-10-29T10:00:00.000Z"},
  "live": null,
  "health": "unknown",
  "status": "Waiting",
  "observations": [{
    "source":"workload","at":"2026-10-29T10:00:00.000Z",
    "age_ms":0,"stale":false,"health":"unknown",
    "reason":"No verified service health observation."
  }],
  "versions": [{"version":"1","status":"failed","observed_at":"2026-10-29T10:00:00.000Z"}]
}
```
