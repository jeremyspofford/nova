# Navigation reachability gate — 2026-11-02

The owner-required ordinary doors now exist in both arrangements: Home's Devices card → **Machines and services**; Settings → Devices → **Machines and services**; and the visible **Capture** category beside Devices under “What Nova works with” → **Open Capture**. Existing card/section/category patterns are reused. The rail's primary placement stays unchanged. Capture's renderer moves intact; search points at its new category.

Source checkpoint: `7c8724965a34428b5267de3070d5e94895772956`, based on `6d0a74a58a3a20df7f3718b2ade2413c1ba84e8a`. [Implementation report](../reviews/navigation-reachability-implementation-2026-11-02.md), [independent source review](../reviews/navigation-reachability-task-review-2026-11-02.md), [source-byte manifests and retained experiments](navigation-reachability-2026-11-02/). Source review passed spec/quality with one minor reload-measurement finding, carried into final review; it is not silently waived. Public exact-head required CI and final whole-branch review remain integration conditions at this record's creation; their final pins/results and preview verification are recorded in the PR.

## Before and after: actual rendered results

| Experiment | Phone | Rail | Required Home / Devices / Capture homes |
|---|---|---|---|
| Original real pre-edit main | 11/11 views, 25 states | 11/11 views, 25 states | all absent; RED in both |
| Final fixture serving exact pinned-main JS | 11/11 views, 26 states | 11/11 views, 26 states | all absent; RED in both |
| Final fixed source | 11/11 views, 26 states | 11/11 views, 26 states | all present and independently clicked/tapped; GREEN |
| Controlled new routed view without a door | 11/12, only `orphaned` missing | 11/12, only `orphaned` missing | all three existing homes still pass; RED |

**Main was not completely unreachable:** the baseline really exposes Topology through Health's mesh check and Settings → Services; Capture through Privacy → Open Capture. Both baseline fixtures had a mesh check. The requested ordinary homes and complete model were missing. The gate fails baseline because those required doors are absent, without excluding legitimate buried links to manufacture a missing-view result.

The expected view set comes from the actual production `app.js` VIEWS registration, independently of DESTINATIONS/reachable() and the older posture helpers. The literal reader fails closed on unsupported registration shape. Real browser body/view observations must cover it. A new real registration/route/root without a door was injected in an isolated browser fixture; it extends expected views and fails the same rendered gate. That experiment did not edit shared production files. It is stronger evidence than the supplementary model assertion alone.

Each arrangement starts with one Home load; traversal and replay use visible real anchors/taps and navigation disclosures. `/new`, a dated `/c/:id`, and a real historical schedule-handoff link for `/schedules` cover finite route families. No direct destination loads, route-function calls, forced clicks, form submissions or service operations are used. The isolated Core has a temporary home/file vault and fake agent; the browser blocks non-GET/other-origin requests and the egress tripwire remains clean. This proves navigation, not every operation or conditional state.

Archived text strips trailing whitespace only; [raw/normalized hashes](navigation-reachability-2026-11-02/text-normalization-sha256.json) preserve that distinction, and original files remain in the owned audit archive. [Pre-edit RED](navigation-reachability-2026-11-02/red.txt), [final-fixture baseline RED](navigation-reachability-2026-11-02/red-final-harness.txt), [GREEN](navigation-reachability-2026-11-02/green.txt), [new-orphan RED](navigation-reachability-2026-11-02/orphan.txt), and [actual paths/control metadata](navigation-capability-surfaces-2026-11-02.json) are retained. The supplemental fixture sources are archived as `.test.ts.txt`; their original ignored-workspace paths and exact invocation are in the implementation report. Baseline module hashes match `git show` at the pin, including unchanged app registration/index bytes. The original pre-edit chronology is separate from that later controlled recheck.

## CI wiring and local validation

`tests/ui/navigation-reachability.test.ts` is discovered by the existing `npm run test:ui` glob, which runs in the required CI UI job and aggregate gate. `tests/navigation-registry.test.js` is discovered by ordinary `npm test`. No optional-only check, runtime dependency, auth bypass, baseline regeneration, threshold or mask change was added.

| Local check | Result and limit |
|---|---|
| Final rendered Home-start gate | 2/2, zero skips; all 11 views, all required homes and 26 states each |
| Focused navigation/components/Settings logic | 52/52, zero skips |
| Affected browser batch | 35/35, zero skips; before final Capture group placement |
| Boundary/API | 12/12 |
| Contrast, targets, fold matrix, bands, safe area | 6/7 in first batch; only initial Settings-position screenshots failed; 364 layout combinations passed |
| Final unchanged fold baselines | 1/1; all original pictures pass after placing Capture beside Devices; WebKit cover 1.75%, inner-820 1.14%, unchanged 2% limit |
| Typecheck, tokens, themes | pass; existing non-lead design bar warnings remain; stage-1 approval is already #279 |
| Isolated ordinary runner, six named suites | 43/43, no force-exit and no overlapping browser batch |
| Ordinary full `npm test` attempt | exited 143 after a failed fresh-user child kept fixtures open; not a pass |
| Bounded full-glob diagnostic | 1607 pass / 5 fail / 14 existing opt-in skips; not a pass or ordinary full-suite proof |

The ordinary buffered log ultimately records 1608 passes, four failures, one cancelled file and 14 opt-in skips after targeted termination. The bounded diagnostic's obsolete Capture search expectation was corrected and covered by the focused 52 passes. Its other four failures (appearance event timing, provider result, ingest follow timing and mail-summary timing), plus fresh-user and Capture, passed the subsequent serial ordinary-runner control. That supports a scheduling/fixture-load limit; it does not prove its exact cause or resolve it globally. [Independent stall diagnosis](../reviews/navigation-test-stall-diagnosis-2026-11-02.md) identifies a real early-failure cleanup gap and plausible released-port reuse; the exact responder is unknown. The existing Track 1 timing queue retains these limits. **Ordinary public full CI on the exact final head is mandatory before merge.** Focused results never replace it.

Initial Capture placement under the top group failed three Settings comparisons (3.19%, 4.17%, 2.06% against 2%). Capture belongs with sources/devices in “What Nova works with”; moving it beside Devices preserves the existing top-group hierarchy and passes the unchanged comparisons. The failed result is retained. The ordinary category remains visible and actually tapped; it is not hidden to satisfy a picture.

## Matched rendered evidence

All app images are neutral fixtures: phone 390×900 and rail 1440×900. Home/section pictures include actual navigation doors; existing fold checks retain broader postures. The styleguide pictures use the same real `deviceMeshCard` and `settingsRow` functions, not independently drawn copies. Existing section/category layouts are reused; no new pattern awaits owner approval.

| Surface | Phone | Rail | Existing styleguide composition |
|---|---|---|---|
| Home Devices card | [after](../screenshots/navigation-reachability-2026-11-02/phone-home-devices.png), [before Home](../screenshots/navigation-reachability-2026-11-02/before-phone-home.png) | [after](../screenshots/navigation-reachability-2026-11-02/rail-home-devices.png), [before Home](../screenshots/navigation-reachability-2026-11-02/before-rail-home.png) | [phone Devices](../screenshots/navigation-reachability-2026-11-02/styleguide-phone-devices.png), [rail Devices](../screenshots/navigation-reachability-2026-11-02/styleguide-rail-devices.png); `/styleguide?entry=devices` |
| Settings list/category | [Capture row](../screenshots/navigation-reachability-2026-11-02/phone-settings-list.png) | [Capture row](../screenshots/navigation-reachability-2026-11-02/rail-settings-list.png) | Existing grouped Settings rows/category pattern |
| Settings Devices | [after](../screenshots/navigation-reachability-2026-11-02/phone-settings-devices.png), [before](../screenshots/navigation-reachability-2026-11-02/before-phone-settings-devices.png) | [after](../screenshots/navigation-reachability-2026-11-02/rail-settings-devices.png), [before](../screenshots/navigation-reachability-2026-11-02/before-rail-settings-devices.png) | [phone SettingsRow](../screenshots/navigation-reachability-2026-11-02/styleguide-phone-settings-row.png), [rail SettingsRow](../screenshots/navigation-reachability-2026-11-02/styleguide-rail-settings-row.png); existing Services plain-link pattern |
| Settings Capture | [source/consent section](../screenshots/navigation-reachability-2026-11-02/phone-settings-capture.png) | [source/consent section](../screenshots/navigation-reachability-2026-11-02/rail-settings-capture.png) | Same existing Capture renderer, fields/buttons/rows; moved intact |

The separate styleguide-only capture passes four specimens with zero browser errors and no mutation/egress; it does not count as a Home navigation crawl. Its first screenshot attempt met an initial-theme rerender and detached; the corrected evidence script waits for the installed CSS/metadata and scheduled render before capturing. It changed no app code or baseline.

## Slop check, per touched surface

| §0.4 item | Home Devices | Settings list / Devices | Settings Capture |
|---|---|---|---|
| 1 Equal cards without hierarchy | **FAIL, inherited:** desktop Home cards still share visual weight; stage-2 queue remains | PASS: categories/settings use grouped rows; no extra cards introduced | PASS: existing one-job section with labelled source/rule rows |
| 2 Everything centered | PASS: card/link left-aligned | PASS: labels, rows and map link left-aligned | PASS: labels/fields left-aligned |
| 3 Decorative gradients | PASS for change: no new gradient; existing page/orb only | PASS for change: no new gradient | PASS for change: no new gradient |
| 4 Multiple standouts | PASS: existing one card action remains a plain link | PASS: no new primary control | PASS: no new primary control; existing form buttons unchanged |
| 5 Flat type hierarchy | PASS: greeting/card/metadata tiers unchanged | PASS: page title/group label/row text distinct in pictures | PASS: title/group/field-label tiers distinct |
| 6 Off-scale spacing | PASS: token lint, no new lengths/CSS | PASS: token lint, no new lengths/CSS | PASS: token lint, no new lengths/CSS |
| 7 Mixed icons | PASS: existing icon set, none added | PASS: existing chevrons/icons | PASS: existing icon set |
| 8 Placeholder empties | PASS for change: truthful only-this-device card unchanged | PASS: truthful local-only mesh prerequisite, no fake pairing | PASS: truthful off/no-source state; no simulated capture |

This repair does not solve the owner's stage-2 hierarchy, small rail-orb depth or background-light priorities. Their visible-difference acceptance remains in the existing queue.

## Capability claims and remaining work

[Full mapping](navigation-capability-surfaces-2026-11-02.md) covers all 51 rows and 70 smaller orphan/scope findings; [independent audit](../reviews/navigation-capability-audit-2026-11-02.md) preserves all 79 original lines. Every row now has an explicit current app-shipping column. Conditional task/device/model/event states, API/tool-only starts, CI mechanisms and unbuilt work are not relabelled fully shipped merely because Chat/Health/Settings is reachable. The PR includes the complete mapping table and register.

No API-only workflow was added as part of this sweep. Fresh-user setup, pairing and the styleguide are separate server/standalone surfaces, not ordinary app VIEWS; their normal-Home limits are explicit. No real phone, service, account, capture source, credentialed cluster or broker path was proved. #275 remains parked for findings B; this does not pass M10j's credential gate. Resume the preserved M10j checkpoint after qualified merge/preview verification.
