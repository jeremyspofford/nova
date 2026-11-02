# Task 3 independent review

## Spec compliance

**Issues found.** The requested app surface, renderer reuse, policy tiers, stale provenance, exact snapshot download, worker routing and browser coverage are implemented. The task does not yet satisfy the approved-target and worse-source contracts: the mutation authority is not bound to the state approved in the sheet, and client expiration can hide a still-current failure. Task quality: **Needs fixes**.

Base: `13bfaf0ac20c9e0ea81439a726a63f4be1656520`. Head: `c6df6dfc`. Reviewed the supplied 1,568-line diff in chunks, including recovery of truncated tool output. No git commands, source edits, suite reruns or subagents. This requested review artifact is the only file written.

## Strengths and verified requirements

- `ui/js/topology.js:14`, `:29`, `:77`: independent machine/service ages use a monotonic request-start anchor; collection latency and backward wall-clock changes cannot freshen evidence. The adapter preserves factual lag, missing-lag uncertainty and consent separation. `tests/ui/m10i-topology.test.ts:143` and `:349` cover stale service/lag and delayed collection.
- `ui/js/topology.js:87`, `:102`, `:110`, `:181`: generation checks and request coalescing handle late responses, route visibility and approval pause. Stable IDs and focus restoration support drill-in/back. `ui/js/topology.js:117` downloads the stored Mermaid string without another GET and revokes its Blob URL; `:65` and `:118` reject overlay exports.
- `ui/js/topology.js:128`, `:140`, `:157`: ready-version selection follows the server descriptor; tier 3 confirmation applies to capture and non-capture privileged services, while manual rollback remains tier 2. POST disables the API helper's renewal retry. `tests/ui/m10i-topology.test.ts:98` covers exact hub bodies, all three service classes, double submission, revalidation and refusals; `:244` covers real device assignment and authenticated read-only refusal; `:273` covers per-version tier and lost acknowledgement. Acknowledgement copy explicitly does not promise serving.
- `ui/js/topology-view.js:57`: null/unknown live hub uses existing rows while omitted legacy hub preserves the approved fixture fallback. `ui/sw.js:6`, `:27`, `:29` add shell modules/page and network-only topology; `tests/ui/m10i-topology.test.ts:170` poisons the real controlling worker cache and stops the actual synthetic server. The test exercises the live API access boundary rather than bypassing it.
- `ui/js/app.js:279`, `ui/js/nav.js:48`, `ui/js/services.js:28`, `ui/js/surfaces.js:339`, `src/server.js:313`, `ui/index.html:63`: non-rail topology route, Settings highlighting, both entry points and static deep link are present. The diff introduces no CSS, palette, runtime dependency, external script or historical styleguide screenshot change.

## Important — fix before this task passes

1. **Bind mutation execution to the approved state.** `ui/js/topology.js:157` sends only `confirm: 'rollback'` for a sheet that explicitly names previous/live versions at `:140`; promotion similarly drops the approved live/assignment state. The UI GET comparison at `:153` is useful but not atomic. Unchanged `src/core/index.ts:1281` rejects extra expected-state fields, `src/supervisor/supervisor.ts:385` waits 300 ms, and `src/core/services/manager.ts:148` checks only that some previous version exists. `src/supervisor/services.ts:405` queues the operation; `:413` reads **the then-current** previous version inside that queue (`:913`). A promotion already queued can turn an approved rollback from 1.0 to 0.9 into an executed rollback from 2.0 to 1.0. The console callback also resolves current previous at `src/supervisor/supervisor.ts:129`. Device rollback independently reads current assignment/previous at `src/core/services/workloads.ts:171`; its request can arrive after a different assignment. Promotion pins the destination but not the promised source: supervisor `switch` takes current live at `src/supervisor/services.ts:281`, and native switch only compares destination at `src/core/services/workloads.ts:157`. Add an expected-state/revision binding to the fixed API/IPC/manager interfaces and enforce it immediately before mutation under the driver's serialization (or atomic device assignment update). Refuse changed previous/live/assignment, including queued changes. Add deterministic stale-after-GET and queued-before-execution regressions. This is a **cross-task integration defect**, not a request for a UI-only workaround; controller must authorize the narrow Task 2 contract correction.

2. **Preserve the worse still-current source when another source expires.** `ui/js/topology.js:32` sets `machineOverlay` if *any* initially current source expires; `:35` then unconditionally changes the machine to Waiting, and `:44` propagates that downgrade to services. With a 115-second healthy heartbeat and a 1-second cluster report that the node stopped, eight elapsed seconds yield Waiting even though the failed cluster observation is only nine seconds old. This violates the worse-of-two constraint. The existing browser regression covers an already-stale heartbeat at fetch time, not this client transition. Recompute the merged presentation health from independently aged observations, making expired sources unknown while retaining current Failed/degraded evidence; retain conservative action/export disabling. Add a browser regression for this transition and for expiration of the failed source itself. One focused read-only VM probe of the actual diff module reproduced `status: "waiting"`, heartbeat `2 minutes old / stale`, cluster `Node stopped / 9 seconds old`. The DTO exposes source health (`src/core/services/topology.ts:8`); its existing weight order at `:46` is failed > degraded > unknown > healthy.

3. **Keep asynchronous completion scoped to its own approval sheet.** `ui/js/topology.js:159` and `:163` call the global `closeSheet()` after awaiting a POST, or after a rejected revalidation GET, without rechecking `approval === before`. The ownership check at `:150` only covers successful GET completion. The shared shell permits Escape, its outer X button and backdrop dismissal; disabling form controls does not prevent these (`ui/js/shell.js:230`, `:247`). A user can dismiss a pending topology sheet, navigate and open another approval; the late topology completion then closes that unrelated sheet. Guard close/focus effects by approval identity (and visible route), while retaining the topology result for later display. Cover a held POST and a rejected held GET after dismissal/replacement. This finding is established by the asynchronous control flow and shared-shell implementation; no additional suite was run.

## Minor — evidence hygiene

- `.superpowers/sdd/M10i/task-3-static-verified.log:15` and `:56` contain localStorage ExperimentalWarnings. The full run also contains DEP0187 at `.superpowers/sdd/M10i/task-3-npm-test.log:833`; the M9 log retains the 0.000-rounded orb-glow shift diagnostic at `.superpowers/sdd/M10i/task-3-vitals.log:7`. Theme output retains alternate-package off-scale/unapproved caveats (`task-3-static-verified.log:6`). These are disclosed and not introduced CSS regressions, but output is not pristine. Controller should retain their disposition, not label all evidence warning-free.

## Critical

None found.

## Rendered design review

Inspected 16 actual PNGs under `docs/screenshots/m10i-app`: Chromium machines desktop/phone, services desktop, versions phone, ordinary approval phone, capture approval phone, privileged tier-3 promotion desktop, capture lag, stale service, merged failure, failed refresh, no-hub, empty and loading; WebKit versions desktop and capture rollback phone.

All eight slop criteria pass for this scoped implementation:

- Equal card grids: `chromium/machines-desktop.png` uses hub-leading connections; `machines-phone.png`, `services-desktop.png` and `no-hub-desktop.png` use divided rows.
- Everything centered: those renders and `webkit/rollback-capture-phone.png` keep titles, facts and action text left aligned.
- Decorative gradients: no new gradient/CSS is introduced; the visible Orb Teal shell treatment is existing. This is not a claim that the entire shell contains no gradient.
- Multiple standouts: existing quiet map controls yield to the approval's primary control; the tier-3 checkbox and disabled Confirm are clear in `chromium/approval-capture-phone.png` and `promote-privileged-tier3-desktop.png`.
- Flat type hierarchy: titles, group labels, names, reasons and timestamp metadata remain distinct in `versions-phone.png`, `stale-service-desktop.png` and WebKit versions.
- Off-scale spacing: existing row/sheet spacing remains consistent in the inspected renders; token lint covers 48 files (`task-3-static-verified.log:3`).
- Mixed icons: no new icon family or emoji; existing shell controls and approved SVG connections only.
- Placeholder empty states: empty/loading/error screenshots explain missing observations and the retained state without invented progress. Capture lag visibly shows 17 pending events, paused reason and an 18-minute stale report; no-hub visibly has no graph edges. Phone detail is scrollable; screenshots show its viewport, not the entire long detail.

The screenshots verify the current initial mixed-failure render; they do not refute the elapsed-source defect above.

## Validation and scope limits

- Actual logs inspected: final browser `task-3-complete-green.log:21` = 19 pass, zero fail/skip; final styleguide `task-3-styleguide-complete.log:7` = 5 pass, zero fail/skip; final static `task-3-static-verified.log:67` = 48 pass, zero fail/skip plus lint/themes/typecheck.
- Actual topology fixture vitals: `task-3-vitals-fixture-final.log:4` phone CPU4x 380 ms LCP / 64 ms INP / 0.000 CLS; desktop 144 / 40 / 0.000; 12 runs each, seven observed interactions. M9 gate also passes in `task-3-vitals.log:21`; its desktop sizes are preserved, not silently represented as 1440x900.
- Full suite remains **failed**: `task-3-npm-test.log:1630` reports 1,611 tests, 1,593 pass, four fail, 14 skip. Failure sections at `:1641`, `:1659`, `:1676`, `:1702` identify capture recovery, provider guard, timer annotation and email timeout. The timer comments are corrected in this diff and covered by final static success. `task-3-unrelated-isolation.log:19` shows 17 isolated passes for provider/mail; that does **not** erase the full failure. Controller owns full-branch/CI disposition and the existing capture investigation.
- Named outside-diff checks: (a) approved-target race: fixed core routes, manager checks, supervisor IPC delay, serialized driver execution, console callback and native assignment mutation; (b) asynchronous sheet ownership/no retry: shared shell close lifecycle and API request helper; (c) mixed-source expiry: DTO observation health and the normalizer's severity order. No broad Task 2 re-review was performed.
- Cross-task items not independently proved here: all backend authorization/definition/policy tests, real supervisor/native process execution, complete branch acceptance, final CI and Task 4 integration. Browser fixture supervisor acceptance is a deliberate double (`tests/ui/m10i-support.ts:35`); its passing body tests do not establish atomic execution binding.

**Task quality: Needs fixes.** The presentation and browser evidence are substantial, but approved-version execution, source-severity aging and asynchronous sheet ownership need correction before this task gate passes.
