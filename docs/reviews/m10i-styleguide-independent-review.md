# Spec compliance: Issues found

Task 1, base `a6728b3a`, head `bd98ea9c9a553d716c469ac90f616af1c9c5035b`. The rendered styleguide deliverable is substantially implemented within the authorized boundary, but stale provenance disappears at the service layer. This violates the binding requirement that stale observations retain their age rather than appear current.

## Strengths

- The renderer is presentation-only, documents its input, escapes display strings and IDs, and uses the existing components: `ui/js/topology-view.js:1`, `ui/js/topology-view.js:7`, `ui/js/topology-view.js:26`. No application, server, dependency or live-action integration appears in the supplied diff.
- The diagram has a visibly leading hub and manually drawn, accessibility-hidden SVG connections; its ordered machine structure becomes phone rows: `ui/js/topology-view.js:45`, `ui/styles/layout.css:206`. The six direct Chromium component captures confirm all three layers at desktop and phone sizes.
- Detail rows, status placement, muted metadata and title/group/row typography make the hierarchy readable without a card dashboard. Version roles and the approval boundary are understandable: `ui/js/topology-view.js:40`, `ui/js/topology-view.js:43`.
- The tests exercise actual browsers across installed packages, keyboard navigation and focus restoration, approval tiers, escaping, and mutation avoidance: `tests/ui/m10i-styleguide.test.ts:43`, `tests/ui/m10i-styleguide.test.ts:149`. The final browser log contains five passing tests with no skips; the static log contains thirteen passing checks. I inspected the logs rather than rerunning the suite.
- The stale machine and tier-3 approval screenshots show both source reasons and ages, explicit confirmation, and clear illustrative-action copy. Failed refresh says health is unknown and avoids falsely using Failed: `ui/js/topology-view.js:32`.

## Important — P2: Preserve stale provenance when opening a service

**Anchor:** `ui/js/topology-view.js:40`.

Open the Attention/stale specimen and choose Desktop capture. The machine layer shows an 18-minute-old heartbeat and Needs you, but the service branch renders only `service.status`, placement and version facts. It drops the machine age and observation context and displays Quiet plus “Serving on this machine.” The stale fixture supplies no independent fresh service observation that would justify that change. The same path is available after Failed refresh → View last observation.

The focused renderer check using the specimen's stale machine/service shape returned:

```json
{"showsStaleAge":false,"showsNeedsYou":false,"showsQuiet":true,"claimsServing":true}
```

Retain the observation age/provenance in the service layer and qualify historical serving information. Avoid presenting a stale machine's service as freshly observed merely because the user drilled in. This can remain presentation logic; it does not require implementing the deferred health merge. Add a regression that drills from Attention/stale into the service and checks the retained age and truthful status/copy, then update affected screenshots.

## Minor — P3: Static verification output contains an unreported runtime warning

**Anchor:** `.superpowers/sdd/M10i/task-1-static-final.log:18`.

The otherwise passing static run emits `ExperimentalWarning: localStorage is not available because --localstorage-file was not provided.` The implementation report lists passing checks but omits this warning. It does not invalidate the browser results and is not evidence of a topology runtime defect. Record the warning in the evidence/limitations and address the test environment if a clean run is required; do not suppress unrelated diagnostics globally.

## Rendered design assessment

Applied frontend-design judgment within the existing Orb Teal direction. Directly inspected `chromium/specimen-{overview,machine,service}-{desktop,phone}.png`, plus `chromium/attention-phone.png`, `chromium/approval-capture-phone.png`, `chromium/empty-phone.png`, `chromium/loading-phone.png` and `chromium/failed-phone.png`, all under `docs/screenshots/m10i-styleguide/`. The supplied diff was read once in sequential portions; no changed source file was reread.

| DESIGN-SYSTEM §0.4 criterion | Independent assessment |
|---|---|
| 1. Equal card grids | Pass. The connected overview gives the hub visibly greater height and a leading position; phone machines, services and versions use divided lists. |
| 2. Everything centered | Pass. Content and controls consistently align left. |
| 3. Decorative gradients | Pass. No component gradient is added; only the existing catalogue background light remains. |
| 4. More than one standout | Pass. Navigation and review actions stay quiet; the reused approval sheet owns its primary confirmation. |
| 5. Flat type hierarchy | Pass. The title, small group labels and row names form distinct tiers. Approval uses its existing title/facts/action hierarchy. |
| 6. Off-scale spacing | Pass. Added geometry and spacing use existing tokens; the recorded token lint passes. |
| 7. Mixed icon styles | Pass/not applicable. The topology adds connections, not an icon family; no emoji or new icon set. |
| 8. Placeholder empty states | Pass. Empty, loading and failed specimens explain what is missing or unknown and show at most one next step. |

Text and controls are readable in the inspected renders, with no visible clipping. The desktop overview is intentionally sparse while still expressing the topology. Focus visibility/restoration is supported by the browser assertions and final log; the supplied still images do not depict focused controls. The blocker concerns factual state continuity, not a request for a different visual direction.

## Checks and limits

- Focused check run: a Node import of `renderTopology` with the illustrative stale machine selected at its capture service; inspected the four booleans above. No browser suite or broad tests were rerun.
- Outside-diff checks: DESIGN-SYSTEM §0.4 was read to apply the mandated eight design criteria; the supplied RED, final browser and final static logs were read to verify reported gate results and diagnostic cleanliness. The requested screenshots were opened to assess actual rendered hierarchy, density, contrast and copy. No broader codebase crawl or Git commands were performed.
- Cannot verify from the diff: owner rendered approval remains pending. This report is only the first-deliverable review; it does not approve application integration. The backend, export, live actions and performance gates are explicitly deferred in `docs/reviews/m10i-styleguide-review-packet.md:96` and are not missing Task 1 work.
- Security: no actionable injection or live-mutation finding in this task's supplied code. Escaping, synthetic fixtures and scoped local handlers preserve the intended boundary; no external target or dependency is introduced.

**Code/design quality: Needs fixes.** The composition, layout and browser evidence are strong enough for the task, but the service drill-in must retain truthful stale context before owner review. The static warning is a separate minor evidence issue.
