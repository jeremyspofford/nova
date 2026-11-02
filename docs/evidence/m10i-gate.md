# M10i gate evidence — system map

Binding scope: [orchestration ADR Point 7 and Decision 3](../plans/M10-orchestration.md), [implementation plan](../plans/M10i.md). The owner approved rendered source `690c8458` on 2026-11-01 [before app integration](../builder-packet/INPUT-2026-11-01-M10I-RENDERED-APPROVAL.md).

**Code-review gate: cleared through `fb940ce1`.** Focused tests and historical draft CI do not substitute for the required current-head gate. [PR #280](https://github.com/jeremyspofford/nova/pull/280) records the actual final CI run, matched merge SHA and post-merge preview receipts; these operations are not pre-recorded as complete in this source commit. The normal preview stays on merged main until merge.

## Delivered path and authority

Settings › Services and Health › Devices link to `/topology`, a non-rail route. The approved renderer gives three layers: machines, services, versions/actions. Desktop connections are hand-drawn SVG; phone machines are semantic rows. Production collects actual enrolled device heartbeats, the local supervisor, native workload reports and factual capture-sync lag. Revoked devices are filtered. Local services stay on the local identity even when another device is hub. Missing hub identity produces rows without invented hub connections.

GET `/api/v1/services/topology` returns a normalized captured-at snapshot and its Mermaid text through existing authenticated read access. Device and service observations retain independent timestamps, reasons and ages. A trusted optional cluster callback supplies tests; production has no cluster driver or invented cluster/site. Failed beats degraded, which beats unknown, which beats healthy. Missing/stale observations are unknown. Workload assignment and observed serving are distinct. An old ready version cannot borrow a new unrelated report’s time or turn unknown live health into Verified. Healthy idle capture is not degraded merely because its last event is old, and workload health does not establish recording consent.

The app ages evidence with monotonic elapsed time from before collection, including request latency. Refresh coalesces every ten seconds only on the visible route, pauses during approval, rejects late generations and preserves selection/focus. A failed refresh retains explicitly historical facts and disables actions/export. The service worker caches the shell/modules, but never treats a cached topology response as current. Tests stop the actual loopback server and poison the worker cache before proving offline refusal and recovery.

Eligible managed-service versions use server policy: ordinary promotion tier 2; console, capture and non-capture secret/OS-privileged promotion tier 3; all manual rollback tier 2. Device mutations retain their existing manager path. New fixed approver-only hub routes use typed IPC and the same ServiceManager. There is no command/argv/definition bridge, dependency or third-party script. Hub changes acknowledge **accepted**, then execute through existing manager history/problems; canaries and console restarts are not mislabeled completed. Lost responses remain unknown, with no automatic POST retry. This adds no durable operation queue. The M10e `service` change-kind/GitOps pipeline remains deferred to M10j/M10k.

## Approved-state binding

The fixed action descriptor carries a closed `expected` object: `{live, previous, assigned}`. `assigned` is null for hub services or exactly `{version, want, at}` for native intent. Versions are bounded and timestamps canonical; unknown/missing fields and malformed values are refused. This is public semantic state, not a credential or permission. The UI sends the descriptor it reviewed, not a replacement from a later read. Fixed hub routes require it; existing device/CLI omission compatibility remains, and any supplied guard is enforced.

The same guard crosses API → typed IPC → manager → actual driver queue. Plain-program checks run inside the per-service queue before effects or choosing rollback's destination. Console comparison and acquisition of its existing busy lock happen synchronously before awaits/effects. Native assignment comparison and write use the same `BEGIN IMMEDIATE` transaction without an intervening await. A deterministic real HTTP→IPC test holds a real synthetic service's readiness response, queues an ahead promotion, observes the acknowledged rollback enter execution, and proves it cannot roll back a different live/previous pair. Native assignment drift and console promotion/rollback have separate regressions. Independent clearance is recorded with the reviews below.

## Actual renders

These are real synthetic-profile browser captures, not mockups. The fixture injects fixed hardware, a loopback fake model service with zero models and no secrets. It does not inspect real devices, credentials or model runtimes.

| Layer/state | Desktop | Phone |
|---|---|---|
| Machines | [Chromium](../screenshots/m10i-app/chromium/machines-desktop.png) | [Chromium](../screenshots/m10i-app/chromium/machines-phone.png) |
| Services | [Chromium](../screenshots/m10i-app/chromium/services-desktop.png) | [Chromium](../screenshots/m10i-app/chromium/services-phone.png) |
| Versions | [WebKit](../screenshots/m10i-app/webkit/versions-desktop.png) | [Chromium](../screenshots/m10i-app/chromium/versions-phone.png) |
| Ordinary approval | [Chromium](../screenshots/m10i-app/chromium/approval-desktop.png) | [Chromium](../screenshots/m10i-app/chromium/approval-phone.png) |
| Capture promotion | [Chromium](../screenshots/m10i-app/chromium/approval-capture-desktop.png) | [Chromium](../screenshots/m10i-app/chromium/approval-capture-phone.png) |
| Capture rollback | [WebKit](../screenshots/m10i-app/webkit/rollback-capture-desktop.png) | [WebKit](../screenshots/m10i-app/webkit/rollback-capture-phone.png) |

The 37 app captures also cover lag, fresh failure with another stale source, stale service, failed refresh, loading, empty and unknown hub. The [historical renderer packet](../reviews/m10i-styleguide-review-packet.md) preserves 120 captures and 392 state/package/posture/engine combinations at reviewed source `690c8458`; they are not relabeled live-system proof. Independent app review inspected 16 actual renders and passed all eight DESIGN-SYSTEM §0.4 criteria. Existing rows, typography and approvals were reused; no new CSS, gradient, font or icon family was introduced.

## Same-snapshot text

`tests/core/topology.test.ts` compares literal output, generated IDs and escaped hostile labels. One fixed expected snapshot is:

```text
flowchart TD
  m0["Home hub | Verified"]
  m1["Local#34; click evil #60;script#62;#35;#59;#38; | Verified"]
  m0 --- m1
```

The browser download is exactly the displayed response’s `mermaid` field, encoded as a text Blob with its temporary URL revoked. It performs no second GET. A client stale/error overlay disables export because that overlay would differ from the original text; a freshly fetched server snapshot containing unknown/stale observations can export its matching text. Labels never become Mermaid directives or HTML/SVG markup.

## Performance evidence

M9’s exact observers and nearest-rank p75 calculation are shared without changing its five views, interactions or thresholds. Default twelve runs per view; topology has seven trusted drill-in/review interactions per run. Limits remain LCP ≤2500ms, INP ≤200ms, CLS ≤0.1. These are Chromium measurements; WebKit correctness is tested separately.

| View | Viewport | Runs | LCP p75 | INP p75 | CLS p75 |
|---|---|---|---|---|---|
| Topology | 390×844, CPU 4× | 12 | 316ms | 64ms | 0.000 |
| Topology | 1440×900 | 12 | 148ms | 40ms | 0.000 |
| Home | 390×844, CPU 4× | 12 | 400ms | 64ms | 0.000 |
| Chat | 390×844, CPU 4× | 12 | 316ms | 80ms | 0.000 |
| Tasks | 390×844, CPU 4× | 12 | 404ms | 64ms | 0.000 |
| Settings | 390×844, CPU 4× | 12 | 508ms | 80ms | 0.000 |
| Memory | 390×844, CPU 4× | 12 | 412ms | 64ms | 0.000 |
| Home | 1280×820 | 12 | 132ms | 40ms | 0.000 |
| Chat | 1280×820 | 12 | 156ms | 40ms | 0.000 |
| Tasks | 1280×820 | 12 | 144ms | 40ms | 0.000 |
| Settings | 1280×820 | 12 | 196ms | 32ms | 0.000 |
| Memory | 1280×820 | 12 | 168ms | 40ms | 0.000 |

Topology values are from the focused default-12-run verification at `3c1ee828`, after the guard/expiry/sheet corrections; main-view values are the complete 120-sample M9 run from the initial app implementation. They are source-pinned measurements, not a claim of a new local benchmark after `fb940ce1`. The final CI runs both topology and the complete M9 gate again on its exact head. The desktop chat orb-glow shift rounds to 0.000, not a claim of literally zero movement. Final exact-head CI is separate evidence.

## Source pins, review and validation

- Renderer: `690c8458`, following stale-provenance and rollback-tier RED→GREEN corrections; independent initial review and two scoped re-reviews are linked in the historical packet.
- Backend: `e9062236` initial implementation, fixes `b61ace15` and `9172d9c5`. Independent review found old ready evidence borrowing a fresh unrelated time, then a fix overwriting unknown live health. Both were reproduced before fixes; final scoped review cleared them. [Implementation](../reviews/m10i-backend-implementation-2026-11-01.md), [initial review](../reviews/m10i-backend-independent-review-2026-11-01.md), [round 1](../reviews/m10i-backend-rereview1-2026-11-01.md), [round 2](../reviews/m10i-backend-rereview2-2026-11-01.md).
- Initial app: `c6df6dfc`; 19/19 correctness, 5/5 historical styleguide (392 combinations), 48/48 static guards, token lint, themes and typecheck passed. Both browser engines cover all six packages, phone/desktop, three layers, tiers, stale reports, exact export, real read-only 403, no POST retry, native assignment vs serving, controlling-worker outage/recovery and focus/visibility/generation behavior.
- [Initial independent app review](../reviews/m10i-app-independent-review-2026-11-01.md) found three Important defects: unbound execution state after the UI check, expiring one source masking another fresh Failed source, and late request completion closing an unrelated sheet. Consolidated fix `3c1ee828` has observed RED→GREEN regressions for all three; [Scoped independent re-review](../reviews/m10i-app-rereview1-2026-11-01.md) cleared all three with no new blocking defect. Design criteria passed; passing render tests did not waive correctness defects.
- [App implementation and fix report](../reviews/m10i-app-implementation-2026-11-01.md): after the fix, backend33/33, real queued HTTP→IPC1/1, browser28/28 (23app +5styleguide), static/boundary/legacy driver contract62/62, lint/themes/typecheck and focused topology vitals1/1 all pass, zero skips. Client expiry retains a fresh Failed/degraded source until that source expires too. Held POST/rejected GET tests retain the real replacement approval and focus after the old sheet is dismissed; late receipts remain visible on return. No broad host run is relabeled green.
- [Whole-branch independent review](../reviews/m10i-whole-branch-review-2026-11-02.md) found two further Important projection defects: a current supervisor hold/stopped mode borrowing an old health timestamp, and a fresh failed first-live native workload with no kept version becoming Waiting. Consolidated correction `fb940ce1` has observed RED→GREEN regressions for both, plus the newly exposed Serving-label claim; [Independent scoped re-review](../reviews/m10i-final-rereview-2026-11-02.md) cleared both and the authorized Serving-label integration, with no new Critical/Important/Minor findings. The reviewer verified prior fixes, actual covering outputs and 14 renders.
- [Final correction report](../reviews/m10i-final-fix-2026-11-02.md): model/API19/19, nearby real IPC/queues/manager/native/driver77/77, focused DOM7/7, boundary1/1 and typecheck pass, with no skips or warnings in those scoped logs. Held/stopped attestation and measured health retain distinct times; relevant native stopped-work failure keeps its own receipt and expires independently. The driver live identity remains unchanged for guards while current Serving copy requires healthy, non-stale merged evidence. Old screenshots remain historical; new failure states are proved by actual API/model/DOM regressions. The report records an intermediate implementation ReferenceError and an unsuccessful shell-pattern invocation without counting them as behavioral RED or GREEN.
- Required final operational proof is recorded on [PR #280](https://github.com/jeremyspofford/nova/pull/280): exact-head `gate` with full unit/UI/M9 checks, `--match-head-commit` merge, then preview HEAD and root/health/mesh-hello checks. This file is the source-pinned test/review evidence, not an advance assertion that those actions happened. [Controller review rulings](../reviews/m10i-review-rulings-2026-11-02.md) record every explicitly excluded behavior and its limit.

All commands use Node 26.3.1. UI commands invoke the existing Docker Playwright image through Bash `scripts/ui-test.sh`; no package, image or model was pulled. Runtime dependency/third-party-script guards, Kubernetes tripwire and audit remain required in final CI.

## Failed runs and limits

The initial backend broad host suite was not green: 1591 pass, 3 fail, 14 skip; its own module-boundary failure was fixed, while M6a recovery and onboarding negative-port fixture failures remained disclosed. The initial app broad host suite was also not green: 1593 pass, 4 fail, 14 skip. Its own M9 timer-naming guard was fixed and the 48/48 focused static set passed. M6a capture recovery, provider-guard background-process result and skills email-summary timing failures remain recorded. Provider/skills passed once in isolation (17/17), which does not turn a failed full run green. Final CI is separate evidence.

Node UI tests emit an existing localStorage ExperimentalWarning. DEP0187 appeared near provider-guard in a broad host run but has no proven attribution; it remains a runtime-warning follow-up, not silently suppressed. Alternate themes retain their existing below-bar/off-scale caveats; this phase does not approve them. Fourteen normal full-suite skips retain real-model, real-capture/Relay and desktop-keychain opt-in reasons; none was enabled against owner services.

The historical draft R13 fixture failed twice, including the one allowed rerun. Forced real reconciliation reproduced the cause; `b4088fcc` holds the injected fault until an authentic signed unhealthy answer is observed, preserving replay and restart assertions. [Independent correction](../reviews/m10g-r13-fixture-fix-2026-11-01.md). Historical exact draft `128e1298` passed CI41336228904 (1582 unit pass/14 skip, UI121/121, axe0, audit0). It is not validation of later app/guard code.

No real K3s, cloud site, OS permission flow, Screenpipe installation, physical folding hinge or native capture parity is proven. Backend tests exercise real managers/program stand-ins in disposable homes; browser mutation fixtures retain real authentication/body validation but do not repeat physical workload execution. No managed-map action exists for the device boot/runtime agent itself; its existing update path is separate, and any future managed promotion must be tier 3. No service secret delivery, GitOps/work-ledger service change kind, durable acceptance queue, raw archive, or vault broker cutover is delivered. #275 remains parked for owner findings B, with its separate integration obligations unchanged.
