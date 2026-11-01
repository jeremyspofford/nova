# M10i topology: rendered entry for owner review

This is the first styleguide deliverable, pending independent review and the owner's rendered approval. It is not the application map or completion of M10i.

Open `/styleguide?entry=topology` (anchor `#sg-topology`). Each specimen can also open directly with `&state=<state>`; the state picker changes only the local demonstration. The fixtures explicitly describe illustrative machines; no real machines or cluster are connected.

## Review the three layers

These are direct Chromium browser captures of `.topology`, rendered in Orb Teal, not edited images:

| Layer | Desktop, 1440 × 900 viewport | Phone, 390 × 844 viewport |
|---|---|---|
| Machines | [Diagram](../screenshots/m10i-styleguide/chromium/specimen-overview-desktop.png) | [Ordered list](../screenshots/m10i-styleguide/chromium/specimen-overview-phone.png) |
| Machine services | [Services](../screenshots/m10i-styleguide/chromium/specimen-machine-desktop.png) | [Services](../screenshots/m10i-styleguide/chromium/specimen-machine-phone.png) |
| Versions and actions | [Versions](../screenshots/m10i-styleguide/chromium/specimen-service-desktop.png) | [Versions](../screenshots/m10i-styleguide/chromium/specimen-service-phone.png) |
| Stale service detail | [Historical versions](../screenshots/m10i-styleguide/chromium/specimen-attention-service-desktop.png) | [Historical versions](../screenshots/m10i-styleguide/chromium/specimen-attention-service-phone.png) |

The hub leads by position and size; SVG connections explain the relationship. The same semantic ordered list becomes divided rows on a phone. Service/version detail uses rows, not equal cards. Existing status and approval components keep the vocabulary and tier behavior. Loading composes an explicitly static specimen of the existing waiting line: no invented completion, units or changing phases.

## Complete render evidence

The `chromium/` and `webkit/` folders under [m10i-styleguide](../screenshots/m10i-styleguide/) each contain every combination of the 14 states below and these postures:

- `desktop`: 1440 × 900.
- `phone`: 390 × 844, touch enabled.
- `tablet`: 820 × 1180, touch enabled.
- `halfopen`: 1100 × 900, touch enabled. This is a viewport-size specimen, not physical hinge emulation.

Filename rule: `<engine>/<state>-<posture>.png`. These 112 full-page captures preserve catalogue context and may be taller than the viewport. Eight additional Chromium `specimen-<state>-<posture>.png` captures show the component alone. All are actual browser renders, without image generation or editing.

| State | Direct address | Example |
|---|---|---|
| Overview | `/styleguide?entry=topology&state=overview` | [Desktop](../screenshots/m10i-styleguide/chromium/overview-desktop.png) |
| Attention/stale | `/styleguide?entry=topology&state=attention` | [Phone](../screenshots/m10i-styleguide/chromium/attention-phone.png) |
| Stale service detail | `/styleguide?entry=topology&state=attention-service` | [Phone](../screenshots/m10i-styleguide/chromium/attention-service-phone.png) |
| Machine services | `/styleguide?entry=topology&state=machine` | [Tablet](../screenshots/m10i-styleguide/webkit/machine-tablet.png) |
| Service versions/actions | `/styleguide?entry=topology&state=service` | [Desktop](../screenshots/m10i-styleguide/webkit/service-desktop.png) |
| Capture versions/actions | `/styleguide?entry=topology&state=capture` | [Phone](../screenshots/m10i-styleguide/webkit/capture-phone.png) |
| Empty | `/styleguide?entry=topology&state=empty` | [Phone](../screenshots/m10i-styleguide/webkit/empty-phone.png) |
| Loading | `/styleguide?entry=topology&state=loading` | [Phone](../screenshots/m10i-styleguide/webkit/loading-phone.png) |
| Failed refresh | `/styleguide?entry=topology&state=failed` | [Phone](../screenshots/m10i-styleguide/webkit/failed-phone.png) |
| Long names/roles | `/styleguide?entry=topology&state=long-names` | [Desktop](../screenshots/m10i-styleguide/chromium/long-names-desktop.png) |
| Promote ordinary service, tier 2 | `/styleguide?entry=topology&state=approval-service` | [Desktop](../screenshots/m10i-styleguide/webkit/approval-service-desktop.png) |
| Promote capture, tier 3 | `/styleguide?entry=topology&state=approval-capture` | [Phone](../screenshots/m10i-styleguide/chromium/approval-capture-phone.png) |
| Roll back ordinary service, tier 2 | `/styleguide?entry=topology&state=rollback-service` | [Phone](../screenshots/m10i-styleguide/webkit/rollback-service-phone.png) |
| Roll back capture, tier 3 | `/styleguide?entry=topology&state=rollback-capture` | [Desktop](../screenshots/m10i-styleguide/webkit/rollback-capture-desktop.png) |

## Verification

Commands run in the task-owned checkout with Node 26 explicitly selected:

```sh
export PATH=/home/jeremy/.local/share/mise/installs/node/26.3.1/bin:$PATH
scripts/ui-test.sh tests/ui/m10i-styleguide.test.ts
npm run lint:tokens
npm run check:themes
npm run typecheck
node --test tests/styleguide-coverage.test.js
node --test tests/ui-review.test.js
git diff --check
```

Observed RED: the first `scripts/ui-test.sh tests/ui/m10i-styleguide.test.ts` run failed its assertion `missing named topology entry` (`0 !== 1`). No renderer or entry existed yet.

Observed GREEN: the focused browser file passes all five tests, with no skips. It checks all 14 states on phone and desktop in all six installed starter packages in Chromium and WebKit, plus tablet/half-open widths in Orb Teal: 392 state/package/posture/engine combinations. Applied theme CSS is awaited before checking. It verifies no page overflow or clipped tested text, no browser errors, semantic machine buttons and phone list, long service names after drill-in, real keyboard Tab/Enter navigation and visible focus, return-focus restoration, both disagreeing source reasons and their ages, tier-2/tier-3 promotion and rollback sheets, tier-3 confirmation gating, and zero mutation requests during demonstrations.

The renderer's hostile-string check covers names, IDs, roles, versions, placement and reasons, plus deterministic output and unchanged input. A second RED→GREEN test uses a 47-minute age and no prior observation: failed refresh must retain supplied age rather than inventing freshness. The 18-minute example now exists only in the styleguide fixture.

Static checks pass: token lint (47 UI files), all six themes valid, typecheck, existing styleguide coverage (4/4), UI review regression checks (9/9), and whitespace/diff checks. Non-lead packages remain marked below the owner's design bar; this work does not alter their values or approval status.

The optional full `npm test` run completed in 190 seconds: 1,579 passed, 3 failed, 14 skipped (1,596 total). One failure was caused by this change: `tests/ui-review.test.js` rejected `border/subtle` on machine buttons. The controls now use `border/strong`; that existing regression suite passes. Two failures outside this change were a provider stand-in ending without a result (`tests/core/provider-guard.test.ts:170`) and an email-summary timeout (`tests/skills-api.test.js:81`). Both files passed once in isolation (17/17) under the same no-Kubernetes tripwire, with a 60-second outer bound. The full suite is not claimed green.

Intermediate browser runs also exposed two test-harness issues, both corrected: waiting on the active-app stylesheet URL instead of `preview.css`, and asserting keyboard focus styling after mouse-driven traversal instead of entering with Tab. They required no production workaround.

## Fix round 1: observation continuity and diagnostic evidence

The independent review found that service drill-in dropped stale machine context. The new regression opens **Attention/stale → Desktop capture** and **Failed refresh → View last observation → Desktop capture** in each package/posture/engine combination. Both engines first failed on the missing 18-minute age. After the fix the full focused file passes 5/5: the detail retains that age, both source reasons, one Needs you status, explicitly unknown current service health, and version details labelled “Previously reported.” Regular service detail now includes its observation age too. The supplied `stale` presentation flag controls historical wording/status; no age parsing, polling or health-merge algorithm was introduced. The new `attention-service` state and direct captures make this path reviewable.

The static checks pass but are **not diagnostic-free**. Both the initial and fix-round static logs contain:

```text
ExperimentalWarning: localStorage is not available because --localstorage-file was not provided.
```

The coordinator confirmed the identical warning on the untouched baseline at `92735155` with `node --test tests/ui-review.test.js` (9/9 pass). It is a pre-existing Node-only test-runtime warning, not a browser error. It remains recorded and unsuppressed; no unrelated environment or production refactor was made.

Fix-round commands (same Node PATH as above):

```sh
scripts/ui-test.sh tests/ui/m10i-styleguide.test.ts
npm run lint:tokens && npm run check:themes && npm run typecheck
node --test tests/styleguide-coverage.test.js tests/ui-review.test.js
git diff --check
```

Observed RED: 3/5 pass, both browser tests fail on missing supplied service age. Observed GREEN: 5/5 browser tests, 392 combinations plus both stale drill-in routes; 13/13 existing static coverage/UI-review tests, with the warning above. No broad host-suite rerun was made. Affected service/capture/attention images and service crops were regenerated; unchanged-state images were retained from the initial verified capture.

## Slop check, per specimen

Scores apply to the rendered component, not to the whole styleguide catalogue. The evidence links above show each surface. The columns are the eight DESIGN-SYSTEM §0.4 items in order.

| Specimen | 1. Equal card grids | 2. Centering | 3. Gradients | 4. Standouts | 5. Type hierarchy | 6. Spacing | 7. Icons | 8. Empty state |
|---|---|---|---|---|---|---|---|---|
| Overview | Pass: larger leading hub; phone rows | Pass: all text left | Pass: none added | Pass: no primary button | Pass: title/group/name | Pass: token lint | N/A: connections, no icons | N/A: populated |
| Attention/stale | Pass: observation/service rows | Pass: left-aligned | Pass: none added | Pass: one amber machine status | Pass: title/group/row | Pass: token lint | N/A: no icons | N/A: populated |
| Stale service detail | Pass: observation/version rows | Pass: left-aligned | Pass: none added | Pass: one inherited Needs you status | Pass: title/group/version | Pass: token lint | N/A: no icons | N/A: historical facts labelled |
| Machine services | Pass: divided service rows | Pass: left-aligned | Pass: none added | Pass: no primary button | Pass: title/group/name | Pass: token lint | N/A: no icons | N/A: populated |
| Service versions/actions | Pass: version rows | Pass: left-aligned | Pass: none added | Pass: approval remains next layer | Pass: title/group/version | Pass: token lint | N/A: no icons | N/A: populated |
| Capture versions/actions | Pass: version rows | Pass: left-aligned | Pass: none added | Pass: approval remains next layer | Pass: title/group/version | Pass: token lint | N/A: no icons | N/A: populated |
| Empty | N/A: no collection | Pass: empty copy left | Pass: none added | Pass: no primary button | Pass: title/group/empty title | Pass: token lint | N/A: no icons | Pass: explains what will appear |
| Loading | N/A: no collection | Pass: waiting copy left | Pass: none added | Pass: no primary button | Pass: title/group/wait title | Pass: token lint | N/A: existing waiting pulse | Pass: names missing observations; no fake units |
| Failed refresh | N/A: no collection | Pass: error copy left | Pass: none added | Pass: one next step | Pass: title/group/error title | Pass: token lint | N/A: no icons | Pass: states age, unknown health, one next step |
| Long names/roles | Pass: leading hub; phone rows | Pass: wrapped left text | Pass: none added | Pass: no primary button | Pass: title/group/name | Pass: token lint | N/A: connections, no icons | N/A: populated |
| Promote ordinary service | N/A: existing sheet | Pass: facts and action left | Pass: none added | Pass: only Approve is primary | Pass: title/body/facts | Pass: token lint | N/A: no icons | N/A: populated |
| Promote capture | N/A: existing sheet | Pass: facts and action left | Pass: none added | Pass: only Confirm is primary | Pass: title/body/facts | Pass: token lint | N/A: no icons | N/A: populated |
| Roll back ordinary service | N/A: existing sheet | Pass: facts and action left | Pass: none added | Pass: only Approve is primary | Pass: title/body/facts | Pass: token lint | N/A: no icons | N/A: populated |
| Roll back capture | N/A: existing sheet | Pass: facts and action left | Pass: none added | Pass: only Confirm is primary | Pass: title/body/facts | Pass: token lint | N/A: no icons | N/A: populated |

Self-review inspected actual Chromium and WebKit screenshots covering every distinct state, all four viewport sizes, long names, phone approval wrapping, both age reasons, and the eight component captures. The brief's plain neutral language and existing token family are retained. No palette, font family, icon set, runtime dependency or motion pattern was introduced.

## Limits and approval boundary

- This is a presentation fixture, not merged-health computation. The cluster/heartbeat disagreement is illustrative; no K3s backend exists here.
- Full M10i backend collection, read-only API, application routing and Settings/Health entry points, Mermaid export/snapshot, live promotion/rollback paths, and the M9 performance gate are not delivered yet.
- The renderer assumes a hub-first presentation list. Larger/more complex graph layouts and real observation adaptation are future integration work.
- The styleguide approval buttons deliberately finish with “No change was made.” Existing approval markup is reused, but nothing submits to an action endpoint.
- The 1100 × 900 capture tests available width, not a physical hinge. Hinge behavior belongs to later application integration.
- These are author self-checks. Independent review and the owner's rendered approval are still required before any app integration. No push, merge, preview restart or external service change is included.
