# M10i gate evidence — rendered-entry checkpoint only

Binding phase: `docs/plans/M10-orchestration.md` Point 7 and Decision 3. Design-first plan: `docs/plans/M10i.md`. The full M10i gate is **NOT PASSED**; no application map is delivered by this checkpoint.

The first deliverable is a reusable renderer invoked only by `/styleguide?entry=topology` (`#sg-topology`). Machines, services and versions/actions are three layers; desktop has manually drawn SVG connections and semantic machine controls, while phone machines are list rows. The fixtures and demonstration approvals are synthetic and cannot mutate the server.

Source reviewed: `f614beab2baa3e973363ce40f19647b58724a4ba`, following initial source `bd98ea9c`. The first missing-entry test failed before implementation. Review then reproduced lost stale provenance during service drill-in; a browser regression failed before the fix and passed afterward. Stale service detail retains the supplied age/reasons/status and labels historical versions. Reports: `docs/reviews/m10i-styleguide-independent-review.md` and `m10i-styleguide-independent-rereview.md`.

Final focused browser command: `scripts/ui-test.sh tests/ui/m10i-styleguide.test.ts` with Node 26.3.1 selected. Five tests passed, no skips, across 392 state/package/posture/engine combinations: 14 states in all six starter packages at phone/desktop widths in Chromium/WebKit, plus Orb Teal tablet/half-open. No overflow, browser errors or mutation requests. There are 120 actual PNGs (112 full state/posture renders and eight direct component captures), linked in `docs/reviews/m10i-styleguide-review-packet.md`.

Token lint, theme validation, typecheck, coverage/UI-review checks (13/13) and diff checks pass. The static Node tests emit an existing localStorage ExperimentalWarning, also reproduced on unchanged `92735155` (9/9 pass); it is disclosed and not suppressed. Five alternate designs retain their prior below-bar status; no theme values or approvals changed.

The optional broad host run recorded 1,579 pass, three fail, 14 skip. Its scoped control-outline contrast failure was fixed and the existing regression check passes. The other two failures, provider-guard and skills email-summary timing cases, passed once in isolation (17/17). No final full-host-suite green claim is made. Exact-head CI remains mandatory before any merge.

## Outstanding gate

- Owner approval of this rendered entry, required by OPERATING-RULES before app code.
- Real hub/device/native-workload state, merged-health computation with both reasons/ages, and read-only API.
- Settings/Health entry points, actual promotion/rollback approval paths and same-state Mermaid text export/snapshot.
- App browser gate in every starter package, M9 performance budgets, dependency/script guards and final independent phase review.
- Plain-language LEDGER entry reflecting the eventual delivered behavior, exact-head green CI, merge and preview restart.

Until owner approval arrives, app integration does not proceed. Latest merged main remains the normal preview; an isolated synthetic review server may serve this styleguide entry for recognition review.
