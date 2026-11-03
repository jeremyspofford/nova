# M10i Task 3 implementation report

Status: DONE_WITH_CONCERNS. Initial c6df6dfc delivery and its full-host failures are historical below. Fix round1 appended at the end addresses I1/I2/I3, including the formerly unresolved rollback boundary; scoped re-review/final CI remain controller-owned.

## Source pins and boundary

- Workspace: `/home/jeremy/.codex/worktrees/nova-m10i-topology/nova-build`; branch `codex/m10i-topology`; starting commit `13bfaf0ac20c9e0ea81439a726a63f4be1656520`.
- Read task-3-brief first, then constraints, recon, the SDD implementer prompt, `docs/plans/M10-orchestration.md` tier table and Point 7, the actual exported `TopologySnapshot` and reviewed collection/actions. Task 1 renderer approval is `690c8458`; reviewed Task 2 is `9172d9c5`. Backend topology source blob remains `e21738208267e75e850d05671abc8c404c7e7864`.
- No backend model, API or manager mutation. Server edits are the authorized static `/topology` page allowlist and narrow trusted `deps.topologyCluster` → CoreOptions callback passthrough, matching existing dependency injection. There is no fixture environment flag or production fixture URL.
- The final browser fixture explicitly injects fixed synthetic hardware, the existing loopback fake Ollama with zero installed models, and `secrets: () => null`. Settings startup/native placement never needs to inspect a real model runtime, inherited secret fallback or host hardware in this final fixture.
- No subagents/reviewers spawned. No push, merge, preview restart, real device/program/cloud/K3s/network change, owner data/keychain/vault access, prohibited clone/worktree/issue/PR or parked vault work. Synthetic profiles use file keys under their own temporary homes. A mistakenly overlapping earlier browser run was stopped by its exact owned Docker ID; no unrelated process/container was touched.

## Delivered behavior

- `/topology` is a real deep link and non-rail route; Settings is highlighted. Settings Services and Health's Devices check link into it. `index.html` owns the container.
- `topology.js` adapts the reviewed DTO to the same approved presentation rows and SVG/list structure. IDs remain stable through machine → service → versions and Back; focus returns to the originating control, or the service heading when its former action became unavailable. No synthetic machines are supplied by production. An optional live `hubId` omits hub links and the hub class when null or absent; the existing row list is reused, while undefined retains the approved first-node fixture behavior.
- `request('GET', '/services/topology')` preserves and checks the worker's stale flag. Failed refresh retains the actual snapshot with unknown current health, historical version wording and disabled actions/export. Empty, loading, partial and unknown states remain truthful.
- Machine and service observations have independent age and reasons. Ages start with the server's `age_ms` at `captured_at`, plus conservative monotonic time beginning before collection. Request latency and backward wall-clock changes cannot freshen old evidence. Initial server stale sources keep their exact current normalized status, including worse-of-two Failed; client expiration/failure adds an unknown overlay.
- Polling coalesces at 10 seconds only on the visible route, pauses for document visibility and open approval, and rejects late generations. Route return keeps selection. Refresh preserves focus and does not repaint an open form.
- Capture lag displays the actual pending count, blocker, last synchronized event timestamp and independent report age. Missing lag is unknown. Workload state never establishes recording consent, and no capture content is fetched or shown.
- Versions select only real eligible ready candidates, using each version's server descriptor/tier, not a capture-name heuristic. The existing tiered approval sheet is scoped away from ledger task handlers. Review follows the currently displayed eligible candidate after a selected candidate disappears. Open/submitted approvals still pin the prior exact candidate. Before submission the UI refetches and compares the full machine/service/version/live/assignment/action descriptor, tier and availability. Changed policy, disappeared candidate, stale evidence and refused authority cannot silently act.
- Pending submission disables the form controls and uses one POST. The request bypasses the API helper's automatic 401 renewal retry; network loss is unknown until refreshed and never triggers an automatic POST retry. Hub acceptance and native device assignment both explicitly remain unverified serving.
- Download is a safe text Blob containing exactly the displayed snapshot's Mermaid field, with no second GET and a revoked temporary URL. A client stale/error overlay disables export with a refresh explanation; a newly fetched snapshot already containing stale/unknown observations can export its own exact corresponding text.
- SW shell cache is v14, contains both topology modules, recognizes the app page and treats topology GET as network-only. A controlling-worker regression stops the real loopback server, poisons its cache deliberately, proves 503/offline rather than stale 200, reloads the shell offline, then recovers the same server.
- `vitals-support.ts` extracts M9's exact observer/compute/p75 functions. M9 views, widths, interaction counts and thresholds are unchanged; topology is not added to `m9-support.VIEWS`.

## TDD evidence

All commands below run in the task checkout with `PATH=/home/jeremy/.local/share/mise/installs/node/26.3.1/bin:$PATH`. Browser commands use the existing installed Playwright image through the direct Bash script; no dependency/image installation occurred. Node test flags precede filenames. Full logs remain alongside this report.

1. Entry RED: `scripts/ui-test.sh tests/ui/m10i-topology.test.ts` → 1 failed / 0 skipped, `Settings Services links to the map: 0 !== 1`. This exercised real seeded `createNova(config,deps)` and the real static/API paths before app implementation. Log: `task-3-red.log`.
2. Merged-status RED: `scripts/ui-test.sh --test-name-pattern=merged.current.failure tests/ui/m10i-topology.test.ts` → 1 failed / 0 skipped, `current stopped source remains worse than unknown heartbeat: 0 !== 1`. Fixed the app adapter's unconditional downgrade of a newly fetched mixed stale/current Failed snapshot. Log: `task-3-merged-red.log`.
3. Collection-time RED: `scripts/ui-test.sh --test-name-pattern=time.spent.collecting tests/ui/m10i-topology.test.ts` → 1 failed / 0 skipped, `115-second evidence plus 8-second collection is stale: false !== true`. The test holds an actual server response and advances the browser clock without stubbing approval. Fixed the age anchor to include collection time. Log: `task-3-age-red.log`.
4. Wall-clock RED: `scripts/ui-test.sh --test-name-pattern=moving.the.wall.clock tests/ui/m10i-topology.test.ts` → 1 failed / 0 skipped, `monotonic elapsed time expires evidence despite a backward wall-clock adjustment: false !== true`. Fixed the request and elapsed anchors to `performance.now()`. Log: `task-3-clock-red.log`.
5. Focus RED: `scripts/ui-test.sh --test-name-pattern=server.policy.tiers tests/ui/m10i-topology.test.ts` → 1 failed / 0 skipped, `unavailable action returns focus to its service heading: false !== true`. Added fallback focus when a stale target disables/removes the original action. Log: `task-3-focus-red.log`.
6. Pending-form RED: `scripts/ui-test.sh --test-name-pattern=pending.approval.keeps tests/ui/m10i-topology.test.ts` → 1 failed / 0 skipped, `pending confirmation cannot re-enable submit through the shared change handler: false !== true`. Disabled pending form controls so the shared confirm handler cannot re-enable submission by a checkbox toggle. Log: `task-3-pending-red.log`.

GREEN results are completed below. Intermediate harness failures were corrected: supervisor fixture timestamps must precede the server's capture (not be generated milliseconds in its future); empty topology uses revoked registry records rather than breaking foreign keys; read-only app access needs a browser principal rather than a computer principal; an SPA refresh test must return through app links and preserve service selection before inspecting the overview; Playwright offline context alone does not reliably stop a worker's localhost networking, so the controlling-worker test stops its actual server. These are not hidden as passing runs.

## Browser coverage and evidence

- Both Chromium and WebKit, 390×844 phone/touch and 1440×900 desktop, every actual installed package: Aurora, Companion Light, Nova, Obsidian, Orb Teal, Paper. Each is applied through the real design API; tests wait for applied CSS as in `live-swap.test.ts`.
- Real seeded server: Settings/Health entry and deep reload; three layers; semantic keyboard activation; Back/focus; long actual site name and overflow; exact no-GET Mermaid download; per-version ready selection and policy; ordinary promotion2, capture promotion3, non-capture privileged promotion3; ALL manual rollback2; exact fixed request bodies and strict field refusals; stale target/version/policy cancellation; actual authenticated read-only mesh403; native assignment vs observed serving; refusal; lost acknowledgement/no retry; fresh machine + stale service; factual stale capture lag; real worker/offline cache poison/recovery; coalesced polling, generation rejection, hidden/offroute/approval pause; empty/loading/partial; mixed current failure/stale heartbeat; collection delay; backward clock; pending form.
- The visibility test dispatches the Document Visibility event with a controlled `document.hidden` value. It verifies the controller's branch; it is not a claim about OS-specific background scheduling.
- The specific SupervisorLink double rejects generic requests, unknown services, unknown candidate versions, wrong fields and confirmations. It only acknowledges fixed expected synthetic changes. Browser tests retain the actual API access checks, body validation, native manager assignment routes and approval controller. They do not claim another run of real supervisor processes/native workload execution; those are the reviewed Task 2 tests.
- Actual screenshots: 37 files under `docs/screenshots/m10i-app/`: 24 lead-package machine/services/versions/ordinary-approval/capture-promotion/capture-rollback renders across two engines and phone/desktop; six Chromium ordinary/capture/non-capture privileged promote/rollback sheets; capture lag, merged failure, stale service, failed refresh, loading, empty and the no-hub row view. Auxiliary action/fact screenshots use the existing 1280px default desktop; the main matrix is 1440px.
- Opened actual renders including Chromium machine desktop/phone, services desktop, versions phone/desktop, ordinary approval phone, capture promotion phone, non-capture privileged promotion3, capture lag, stale service, failed refresh, loading, empty, plus WebKit versions desktop and capture rollback phone; the final no-hub row render was also inspected. Content wraps and the existing app scroller handles long detail; screenshots are real renders, not generated mockups.
- Task 1 historical scenarios, stale-provenance and manual rollback/capture promotion regressions remain intact: `scripts/ui-test.sh --import=./.superpowers/sdd/M10i/no-shots.mjs tests/ui/m10i-styleguide.test.ts tests/ui/ui-review.test.ts` → 8/8 pass, 0 skip. The verification-only preload deletes `NOVA_UI_SHOTS` so the 392 existing combinations run without rewriting owner-reviewed Task 1 screenshots. Log: `task-3-styleguide.log`. `git status --porcelain=v1 docs/screenshots/m10i-styleguide` is empty.

## Eight rendered design checks

| DESIGN-SYSTEM §0.4 item | Result and actual evidence |
| --- | --- |
| Equal card grids | Pass: approved hub-leading SVG overview remains; phone machines and service/version facts are divided lists. `chromium/machines-desktop.png`, `chromium/machines-phone.png`, `chromium/services-desktop.png`. |
| Everything centered | Pass: titles, source reasons, rows and approval facts align left. `chromium/versions-desktop.png`, `webkit/rollback-capture-phone.png`. |
| Decorative gradients | Pass: no CSS, palette or background is added; existing app Orb Teal light remains unchanged. All app screenshots; no stylesheet diff. |
| More than one standout | Pass: map refresh/export/review controls use existing quiet buttons; only the open approval has a primary confirmation. `chromium/approval-phone.png`, `chromium/approval-capture-phone.png`. |
| Flat type hierarchy | Pass: view/service titles, small group labels, row names and secondary timestamps are distinct. `chromium/versions-phone.png`, `chromium/stale-service-desktop.png`. |
| Off-scale spacing | Pass: existing topology classes, `input` and approval components use existing tokens; no new CSS. Final token lint covers the imported module. |
| Mixed icons | Pass: no new icon family or emoji; only existing shell controls and the approved SVG connections. `chromium/machines-desktop.png`. |
| Placeholder empty states | Pass: actual empty/loading/failed collection renders state what is missing and unknown, without invented progress or decorative artwork. `chromium/empty-desktop.png`, `loading-desktop.png`, `failed-refresh-desktop.png`. |

## Verification and budgets

Final source validation and actual full-suite outcome are recorded below; these are deliberately separate from the earlier focused evidence.

Previously completed evidence:

- Expanded browser + topology vitals: `scripts/ui-test.sh tests/ui/m10i-topology.test.ts tests/ui/m10i-vitals.test.ts` → 15/15 pass, 0 skip (14 correctness plus 1 vitals test), `task-3-final-browser-vitals.log`. This includes the monotonic/focus corrections; the final pending-control correction adds one subsequent correctness regression and does not change the measured open/check/close/drill path.
- Static unit/navigation/UI/styleguide guards: `sh scripts/test.sh tests/ui-logic.test.js tests/ui-fixes.test.js tests/ui-review.test.js tests/styleguide-coverage.test.js` → 39/39 pass, 0 skip. Log: `task-3-static-tests.log`.
- Static warning disclosed: `ExperimentalWarning: localStorage is not available because --localstorage-file was not provided.` in `task-3-static-tests.log`. It is not suppressed globally.
- Theme validator preserves the five alternate themes' existing six off-scale values and unapproved design-bar status; no package values or approval flags changed. Orb Teal remains lead, with rendered review required as the validator reports.
- `scripts/ui-test.sh tests/ui/m10i-vitals.test.ts tests/ui/m9-vitals.test.ts` → 2/2 pass / 0 skip, default 12 runs, all 144 total samples. Log: `task-3-vitals.log`. M9's tiny `desktop, chat` orb-glow layout shift diagnostic rounds to 0.000; the actual computed p75 remains under 0.1.

| View | Width | Runs | LCP p75 | INP p75 | CLS p75 | Trusted interactions/run |
| --- | --- | --- | --- | --- | --- | --- |
| topology (final explicit fixture) | phone 390×844, CPU4× | 12 | 380ms | 64ms | 0.000 | 7 |
| topology (final explicit fixture) | desktop 1440×900 | 12 | 144ms | 40ms | 0.000 | 7 |
| home | phone 390×844, CPU4× | 12 | 400ms | 64ms | 0.000 | 3 |
| chat | phone 390×844, CPU4× | 12 | 316ms | 80ms | 0.000 | 29 |
| tasks | phone 390×844, CPU4× | 12 | 404ms | 64ms | 0.000 | 3 |
| settings | phone 390×844, CPU4× | 12 | 508ms | 80ms | 0.000 | 8 |
| memory | phone 390×844, CPU4× | 12 | 412ms | 64ms | 0.000 | 3 |
| home | desktop 1280×820 | 12 | 132ms | 40ms | 0.000 | 3 |
| chat | desktop 1280×820 | 12 | 156ms | 40ms | 0.000 | 29 |
| tasks | desktop 1280×820 | 12 | 144ms | 40ms | 0.000 | 3 |
| settings | desktop 1280×820 | 12 | 196ms | 32ms | 0.000 | 5–8 |
| memory | desktop 1280×820 | 12 | 168ms | 40ms | 0.000 | 3 |

Limits are unchanged: p75 LCP≤2500ms, INP≤200ms, CLS≤0.1. Calculations are M9's exact shared observers and nearest-rank p75. WebKit correctness is covered; no unsupported WebKit CPU-throttle/performance claim is made.

## Self-review and limits

The substantive self-review corrections are independently aged service evidence, preserving a current worst Failed source despite another stale source, conservative collection time, monotonic aging, fallback focus after a target becomes unavailable, and disabled pending confirmation controls. Actual source strings/IDs and all new observation/action strings are escaped. Export is text only; no new runtime dependency, third-party script, generic execution route or fixture backdoor exists. Existing actual API authorization still refuses the read-only browser before the supervisor double is reached.

The controller owns milestone records, plan/LEDGER updates, independent task review, final whole-branch/UI/CI gate and integration. This report does not claim those are complete. The actual full `npm test` outcome below is separate from focused green evidence.

## Final verification and full-suite disclosure

- Final fixture performance: `scripts/ui-test.sh tests/ui/m10i-vitals.test.ts` → 1/1 pass, 0 skip, 12 runs each, phone380ms LCP/64ms INP/0.000 CLS; desktop144ms/40ms/0.000, seven trusted interactions per run. Log: `task-3-vitals-fixture-final.log`. Subsequent changes only scope retained/unknown-hub rendering and choose the visible candidate; their normal fresh hub/open/check/close/drill measured path is unchanged.
- Final static command: `npm run lint:tokens && npm run check:themes && npm run typecheck && sh scripts/test.sh tests/ui-logic.test.js tests/ui-fixes.test.js tests/ui-review.test.js tests/styleguide-coverage.test.js tests/m9-wait.test.js` → token lint48 files, all six themes valid with the already disclosed design-bar caveats, typecheck exit0 and48/48 selected tests pass,0skip. Log: `task-3-static-verified.log`. The selected Node UI tests emit the disclosed localStorage ExperimentalWarning.
- Required **one bare `npm test`** → exit1 after189893.7ms, **1611 tests:1593 pass,4 fail,14 skip**,0cancelled. Log: `task-3-npm-test.log`. This is NOT a full green suite.

Every full-suite failure, by name:

| Test | Actual failure and disposition |
| --- | --- |
| `M6a: the real server pulls Screenpipe on its own, never stores a private window, rides out an outage, refuses a remote Screenpipe, keeps capture out of git` | `tests/acceptance/m6a-capture.test.ts:64`, recovery assertion `0 !== 1`. Matches the known host recovery failure; not changed or claimed fixed. Controller owns the existing investigation. |
| `a coding agent that changes more than Nova takes from one task is refused in plain words` | `tests/core/provider-guard.test.ts:181` expected the changed201-files refusal, got `Claude Code couldn't do it: Claude Code ended (exit 0) without a result.` No provider source changed. |
| `no artificial delay: every timer in the PWA is named for what it is` | `tests/m9-wait.test.js:103` correctly found the two new unannotated topology timers. Fixed by adding the existing required `wait: poll` and `wait: expiry` purpose notes. Covering `sh scripts/test.sh tests/m9-wait.test.js` then passed9/9; included again in final48/48 static run. This correction is comments only. |
| `the email summary: searches, reads, summarizes; mail is screened, and an address after it that the mail didn’t give asks` | `tests/skills-api.test.js:82` timed out in settle at line45. No mail/provider source changed. |

Diagnostic isolation, without any unrelated source change: `sh scripts/test.sh tests/core/provider-guard.test.ts tests/skills-api.test.js` →17/17 pass,0skip in6015ms, covering both the provider and email failures; `task-3-unrelated-isolation.log`. **Isolation does not supersede the failed full run.** No second full run was used to erase these outcomes.

Every warning category in the full run:

- `[DEP0187] DeprecationWarning: Passing invalid argument types to fs.existsSync is deprecated` (provider guard file execution).
- `ExperimentalWarning: localStorage is not available because --localstorage-file was not provided.` Three occurrences, in existing Node UI tests. No global warning suppression added.
- The unrelated M9 vitals desktop-chat orb-glow diagnostic rounds to0.000 CLS; it is retained in the vitals log and below budget.
- Theme validation retains Aurora/Companion Light/Nova/Obsidian/Paper's six existing off-scale values and unapproved design-bar state; Orb Teal remains the lead. No theme flag/value changed.

The14 normal full-suite skips are the real capture-sensitive eval, real model scorecard, real grounding, real ingest-screen v2, real Claude Code M5, real local model M5, real Ollama M6, real-model foundry M7a, three real Relay gates, real memory gate, real Tev1 injection eval, and real secret-tool (not installed/no desktop session). Their opt-in reasons are preserved in the raw log; none was enabled against owner services/subscriptions.

Additional self-review RED/GREEN evidence:

- `task-3-fixture-fallback-red.log`: the opt-in live retained-context test first failed because new app copy altered the legacy stale-machine specimen. It now uses optional `lastObservation`, leaving the approved fixture fallback unchanged.
- `scripts/ui-test.sh "--test-name-pattern='review.follows|unknown.active.hub'" tests/ui/m10i-topology.test.ts` →2 expected failures before fixes: the displayed fallback candidate's Review opened no sheet, and unknown-hub API data invented one SVG connection. Log: `task-3-choice-hub-red-valid.log`. The earlier unquoted pipe attempt was a shell command error and is not counted as a RED test.
- `scripts/ui-test.sh --test-name-pattern=null.or.absent.live.hub tests/ui/m10i-topology.test.ts` →1 expected failure (`null: no invented hub class`); `task-3-hub-row-red.log`. Fixed by explicitly null/absent live hubs reusing existing machine/service row primitives, while undefined keeps the approved fixture layout/links. No new visual pattern, schema or backend change.
- The no-hub list satisfies all eight design checks: divided left-aligned rows, no added gradient, no standout, existing name/meta hierarchy, token spacing, existing icons only, and factual unknown-hub copy. It has no misleading hub class or invented link; plain server Mermaid and its displayed machines agree.


## Final green commands, source pins and handoff

- `scripts/ui-test.sh tests/ui/m10i-topology.test.ts` → **19/19 pass,0skip**, including the final visible-candidate, opt-in retained-copy, unknown/null/missing-hub row and legacy fallback corrections. Log: `task-3-complete-green.log`. All37 app screenshots were generated from this source and the explicit synthetic fixture; the final no-hub row render was opened and inspected.
- `scripts/ui-test.sh --import=./.superpowers/sdd/M10i/no-shots.mjs tests/ui/m10i-styleguide.test.ts` → **5/5 pass,0skip**, preserving all392 combinations, historical tiers and stale regressions. Log: `task-3-styleguide-complete.log`. The three existing UI-review browser tests also passed in the earlier8/8 run; no relevant review behavior changed.
- `npm run lint:tokens && npm run check:themes && npm run typecheck && sh scripts/test.sh tests/ui-logic.test.js tests/ui-fixes.test.js tests/ui-review.test.js tests/styleguide-coverage.test.js tests/m9-wait.test.js` → **48/48 pass,0skip** plus successful lint/themes/typecheck, on the final source. Log: `task-3-static-verified.log`.
- `git diff --check` passed; the reviewed `docs/screenshots/m10i-styleguide` has no modifications. No runtime dependency, script, CSS, palette, font, icon family or design approval flag was added/changed.
- Final source blobs: `ui/js/topology.js` = `2993b6573304a0feb5846ff1327a6bc9eb81d32f`; `ui/js/topology-view.js` = `6726aeb5a624bc766d892a8820692cdd6d4346a1`; backend `src/core/services/topology.ts` remains `e21738208267e75e850d05671abc8c404c7e7864`.
- Owned file set: `src/server.js`; `ui/index.html`; `ui/js/{app,nav,services,surfaces,topology,topology-view}.js`; `ui/sw.js`; `tests/ui/{m10i-support,m10i-topology.test,m10i-vitals.test,m9-vitals.test,vitals-support}.ts`;37 new screenshots in `docs/screenshots/m10i-app/`. The controller's separate `docs/plans/M10i.md` edits are excluded from this commit. This ignored task report and raw logs remain in the shared task workspace.

## Unresolved cross-task rollback authority boundary

The UI's opened rollback target pins `service.previous` as its displayed target version and `service.live` as its current version, along with stable machine/service IDs, assignment intent and the full server action descriptor. The pre-submit GET recomputes that whole target and compares it with the opened approval, not merely path/tier/confirmation fields; a changed previous or live value therefore cancels before POST.

This is **not an atomic binding**. The reviewed rollback endpoint accepts only `{confirm:'rollback'}`. After the UI GET/revalidation, another change or the server's asynchronous/driver queue can alter which version is previous before generic rollback executes. The UI cannot make that authority boundary atomic by another read or a UI-only workaround. No expected-state field/schema or backend guard was invented in Task3. The controller explicitly assigned independent integration review to assess whether server-side expected previous/live/version guarding is needed before integration. Do not treat this app commit or its passing rollback tier/body tests as proof that the queue race is closed.

Commit: `c6df6dfc` — `feat(ui): wire live topology with guarded version approvals`. Exactly51 assigned files (14 source/test files and37 new app renders) committed; no push/merge. Post-commit `git status --short` contains only the controller-owned `docs/plans/M10i.md` modification. The report's final source blob pins match the committed files. Final `git diff --check` passed.

# Task 3 fix round 1 — independent review I1, I2, I3

Base: `c6df6dfc4c2cbd80471260f8ca15996ceca74dd6`. Status: DONE_WITH_CONCERNS pending scoped independent re-review/final CI; all three Important findings are addressed in this consolidated wave. The earlier full host-suite failure remains disclosed; no new broad full host run was requested or performed. This section supersedes the initial delivery's unresolved rollback-boundary paragraph. Controller explicitly authorized the narrow backend correction in the regenerated task-3-brief; no owner question or subagent was used.

## Open list addressed (review headings verbatim)

1. **Bind mutation execution to the approved state.**
2. **Preserve the worse still-current source when another source expires.**
3. **Keep asynchronous completion scoped to its own approval sheet.**

## I1: closed public state through the actual authority

`ServiceExpectedState` in `src/core/services/expected.ts` is public semantic data, not authorization or a cryptographic grant:

```json
{
  "live": "2.0.0",
  "previous": "1.0.0",
  "assigned": null
}
```

For native assignments, `assigned` is exactly `{ "version": "2", "want": "alongside", "at": "2026-10-29T10:00:00.000Z" }`. Top-level keys are exactly live/previous/assigned. Version strings are1–128 allowed version characters or null; a non-null assignment has exactly version/want/at, non-null version, want in alongside/live/stopped, and a canonical finite ISO timestamp of at most32 characters. Extra fields, missing fields, arrays, oversized versions, malformed timestamps and non-string want values are refused, without invoking coercion of an arbitrary object.

- The normalized topology action descriptors project `expected` from observed live, kept previous and assignment intent. The UI includes that exact server field in both fixed POST bodies after its existing full target/version/tier revalidation. It never regenerates it from a newer state after approval.
- Fixed hub routes require the closed guard. Existing device routes permit omission for legacy clients but validate/enforce any supplied guard; the topology UI always supplies it. Existing approver access, typed confirmation, version readiness, tiers and strict unknown-body-field checks remain. Generic CLI ServiceManager calls keep omission compatibility.
- Typed `HubServiceRequest` and the fixed IPC message carry the guard unchanged. IPC fields are closed: `{nova:'request', id, type:'service-promote'|'service-rollback', service, confirm, expected, version?}`. The receiving supervisor validates it again, checks manager preflight with it, and retains it through the existing300ms acknowledgement delay into execution. Acceptance still does not claim completion/serving.
- ServiceManager checks current state at preflight and passes the guard through its driver interface. For plain programs, `SupervisorDriver.switch` and rollback compare it INSIDE the existing per-service queue before effects or resolving the then-current previous version. A change ahead in that queue cannot reinterpret either the rollback destination or promotion source.
- The console receives the same guard through its ConsoleHooks and checks `consoleStatus` inside its existing synchronous deploy/rollback serialization: guard comparison and acquisition of `#deploying` occur before any await/effect. A busy manual console operation refuses; internal automatic rollback retains its prior behavior. Stale guarded console promotion/rollback leaves releases and process PID unchanged.
- Native status exposes its existing assignment intent to the manager. Native switch/rollback use `Db.tx` (`BEGIN IMMEDIATE`) around the actual report/assignment read, expected-state comparison and assignment update. A supplied guard cannot overwrite drifted live/previous/assignment state after GET. Guard comparison and mutation have no intervening await.
- The helper/types export through `services/index.ts` → `core/index.ts`; supervisor imports use the public core boundary. No new registry, grant/token, general execution bridge, runtime dependency, vault coupling or schema migration was added.

## I2: independent source expiration and severity

The controller now recomputes presentation health from independently aged source observations using the backend's exact order: failed > degraded > unknown > healthy. Expired/missing sources contribute unknown; a still-current failure/degradation remains the worse source. Parent machine evidence and service evidence are merged without freshening a service from a machine heartbeat. No-observation input stays unknown. Fetch failure adds uncertainty without hiding a current worse source.

The renderer uses the service's independently merged status when service observations are provided, including when the machine has another stale source; legacy fixture fallback continues to inherit the supplied machine state. Actions/export remain conservatively unavailable under any relevant stale/error overlay. Ages remain server source age plus monotonic request-start elapsed time. The tests cover a115-second heartbeat and1-second failed/degraded cluster source after8seconds: machine, service row and service header retain Failed/Needs you, with the stale heartbeat age and9-second current source shown. Once that failed/degraded source itself expires, machine and service become Waiting.

## I3: request/sheet ownership and retained result

The controller tracks the exact approval object and form node. Close/focus effects require that identity, a connected form still in the current global dialog, an open dialog and the visible topology route. Ownership is checked after successful preflight, after POST success and in rejected GET/POST handling; route departure only closes the sheet if it still contains the owned form. The old onClose callback cannot clear/focus a different approval. Disconnected/replaced ownership is released without closing/focusing the replacement.

Late operation acknowledgement/refusal is retained in topology notice state for return to the route; automatic successful reads no longer immediately erase it. An explicit map refresh or a new topology review clears the receipt. No POST retry was introduced. The browser regressions use a held real fixed POST and a rejected held real GET, dismiss the original, navigate through the SPA, open the real tier-3 device revoke approval in the same global dialog, focus its confirmation, then release old work. The replacement remains open and focused. The old result remains visible when returning to topology after its automatic refresh. The rejected GET sends no POST.

## TDD RED evidence and corrections

All commands run from the authorized task checkout with Node26.3.1 prepended to PATH. Flags precede filenames. Browser commands use the existing direct Bash `scripts/ui-test.sh`, with no image/dependency/model installation.

- `sh scripts/test.sh --test-concurrency=1 tests/core/topology-expected.test.ts` before implementation: the queued manager/driver test failed `queued operations must refuse changed live/previous`; console promotion and rollback each failed `true !== false` because stale guarded operations changed the release. The initial fourth/native case had a test harness error (`core.now` is not exported), recorded rather than claimed as RED. Log: `task-3-fix1-backend-red.log`.
- After correcting only that test clock to the existing fake hub clock, `sh scripts/test.sh --test-name-pattern=native.supplied tests/core/topology-expected.test.ts` before the fix failed `assignment drift after GET must not be overwritten: 200 !== 409`. Log: `task-3-fix1-native-red.log`.
- `scripts/ui-test.sh "--test-name-pattern='M10i I2|M10i I3'" tests/ui/m10i-topology.test.ts` before client fixes:4fail/0skip. I2 produced Waiting instead of Failed/Needs you; both I3 cases closed the replacement (`open:null` instead of `''`). Log: `task-3-fix1-browser-red.log`.
- Initial focused GREEN after implementation: backend4/4 (`task-3-fix1-backend-green.log`) and I2/I3 browser4/4 (`task-3-fix1-browser-green.log`). A fixture TypeScript literal-widening error was corrected with explicit const literals; the subsequent final typecheck passes. No failing harness/typecheck run is represented as green.

## Covering GREEN commands and actual output

- `sh scripts/test.sh --test-concurrency=1 tests/core/topology.test.ts tests/core/topology-api.test.ts tests/core/topology-expected.test.ts tests/core/topology-actions.test.ts tests/core/services-manager.test.ts tests/core/workloads-hub.test.ts` → **33/33 pass,0skip**,49345ms; `task-3-fix1-backend-all.log`. Covers model/projection, actual API/auth/fields, real IPC tiers/confirmation and console restart acknowledgement, manager rules, native legacy and guarded paths, closed expected schema, actual driver queue and console serialization.
- `sh scripts/test.sh --test-name-pattern=actual.HTTP tests/core/topology-expected.test.ts` → **1/1 pass,0skip**,8611ms; `task-3-fix1-ipc-queue.log`. This additional deterministic test runs the actual server as the supervised child and real fixed HTTP→IPC path. A real synthetic service's held readiness HTTP response occupies its driver queue; an ahead promotion is queued; the reviewed rollback is acknowledged; the test observes the300ms execution callback actually entering the manager before releasing readiness. The ahead promotion completes to3.0.0/previous2.0.0; the old2.0.0/previous1.0.0 rollback refuses under the driver queue, serving remains3.0.0, and refusal appears in the actual core's problems. A subsequent stale guard POST returns409. The queue is gated by the real health response/observed execution, not an arbitrary timing sleep.
- The native test captures live1/previous1/assigned2-alongside, changes actual intent to stopped, sends guarded promote and gets409; direct native rollback with the stale guard also refuses and the entire SQL row remains unchanged. The console tests hold its actual serialization against a concurrent request, then reject stale promotion/rollback after the ahead release, with PID/current/previous unchanged. The plain queue test covers BOTH queued rollback destination and queued promotion source, preserving the untouched ready version4 and generic omission rollback behavior.
- `scripts/ui-test.sh --import=./.superpowers/sdd/M10i/no-shots.mjs tests/ui/m10i-topology.test.ts tests/ui/m10i-styleguide.test.ts` → **28/28 pass,0skip**,73909ms; `task-3-fix1-app-all.log`. Includes all23 app cases (19 historical+4 fixes), both browser engines/all6 active packages/phone+desktop matrix, exact guarded bodies, actual readonly403, strict invalid requests, no retry, worker/cache poison, plus all5 styleguide tests/all392 historical combinations. I2/I3 adversarial regressions run Chromium desktop; this is not a claim they were separately run on every physical platform.
- `npm run lint:tokens && npm run check:themes && npm run typecheck && sh scripts/test.sh --test-concurrency=1 tests/core/api.test.ts tests/supervisor/services-contract.test.ts tests/ui-logic.test.js tests/ui-fixes.test.js tests/ui-review.test.js tests/styleguide-coverage.test.js tests/m9-wait.test.js` → lint48files, themes valid with existing design-bar caveats, typecheck exit0, **62/62 pass,0skip**,9380ms; `task-3-fix1-static.log`. Includes the actual outside-core import boundary guard and the legacy driver contract (apply/ready/switch/rollback).
- `scripts/ui-test.sh tests/ui/m10i-vitals.test.ts` → **1/1 pass,0skip**,43110ms; `task-3-fix1-vitals.log`. Focused measurement is appropriate because independent health merging changes normal render paths. Twelve fresh runs per width, same shared M9 observer/nearest-rankp75; phone390×844 CPU4× LCP316ms/INP64ms/CLS0.000, desktop1440×900 LCP148ms/INP40ms/CLS0.000;7trusted interactions/run. Prior exact-source M9 main-view evidence remains historical and unchanged; no new full M9/host suite is claimed.

## Source pins, visuals, warnings and remaining limits

Final fix source blobs:

| File | Blob |
| --- | --- |
| `src/core/services/expected.ts` | `7d23c50ff810b3676c05d4862806c14b56123a4c` |
| `src/core/services/topology.ts` | `0cf43ed8adf6a4c224de376dec0596237abe92e9` |
| `src/core/services/workloads.ts` | `aa1a93a24262afb057f9ec2fc30f9066490c5649` |
| `src/core/services/manager.ts` | `44a3cb2e3a91ccfa55ebf62ac009152a4e10dade` |
| `src/supervisor/services.ts` | `f5f9a5157fa3622378f56204899e62ffb40f54c4` |
| `src/supervisor/supervisor.ts` | `077ef9a7ea123e0f51a5ad7d9a86c298a57e7f77` |
| `ui/js/topology.js` | `13d23398ff078c1603d9c1c130a04f2c399d2ad9` |
| `ui/js/topology-view.js` | `3d5867fbb1a7ed04a1978808775c7a0ca559f23b` |

No CSS, theme, font, icon, dependency or new visual pattern is introduced. Status/age rendering uses the same already-reviewed rows/typography; all eight slop criteria retain their previous disposition. Browser captures were disabled with the existing verification preload to preserve the historical37 app and392 styleguide scenario evidence, and ALL docs/PNG trees are excluded from this fix commit as the controller requested. No new screenshot is claimed as evidence of the elapsed-source fix; its actual rendered DOM/status/age and interaction assertions are the new evidence.

The final static log contains **two** existing localStorage ExperimentalWarnings and the existing alternate-theme off-scale/unapproved caveats. Browser/backend focused outputs have no additional warnings. Prior full-host result remains1611tests/1593pass/4fail/14skip, with the four named failures and DEP0187/three localStorage warnings preserved above; the timer naming error was corrected in the initial implementation and remains green. No broad repeat has erased that red result. Independent re-review and final phase/CI still belong to the controller; native tests prove atomic hub assignment, not observed remote serving or real OS execution. All homes/processes/health gates are synthetic/loopback and closed by existing scoped helpers. No prohibited data/resources, preview restart, push or merge occurred.

Fix1 commit: `3c1ee8284c622dbb94f972a2678d9a93c181e74c` — `fix(topology): bind approvals to serialized service state`. Exactly17 authorized source/test files committed. Post-commit status contains only the controller-owned seven docs modifications (LEDGER, inventory, roadmap, gate evidence, plan, follow-up queue and historical styleguide packet). No docs/PNG files were staged; no push/merge. Source pins above match the committed blobs. Assigned I1/I2/I3 open list has no known remaining implementation item; independent re-review and final CI are still pending.
