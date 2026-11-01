# M10i gate evidence — rendered-entry checkpoint only

Binding phase: `docs/plans/M10-orchestration.md` Point 7 and Decision 3. Design-first plan: `docs/plans/M10i.md`. The full M10i gate is **NOT PASSED**; no application map is delivered by this checkpoint.

The first deliverable is a reusable renderer invoked only by `/styleguide?entry=topology` (`#sg-topology`). Machines, services and versions/actions are three layers; desktop has manually drawn SVG connections and semantic machine controls, while phone machines are list rows. The fixtures and demonstration approvals are synthetic and cannot mutate the server.

Source reviewed: `690c8458a528391934e91ea4ccd484947ab39c89`, following initial source `bd98ea9c` and stale-state fix `f614beab`. The first missing-entry test failed before implementation. Review then reproduced lost stale provenance during service drill-in; a browser regression failed before the fix and passed afterward. Stale service detail retains the supplied age/reasons/status and labels historical versions. Reports: `docs/reviews/m10i-styleguide-independent-review.md`, `m10i-styleguide-independent-rereview.md`, and final `m10i-styleguide-independent-rereview2.md`. A later ADR compliance check corrected the capture rollback specimen from tier 3 to tier 2, with observed RED→GREEN assertions in both engines. Ordinary promotion is 2, capture promotion is 3, and both manual rollbacks are 2; the final independent check verified all four.

Final focused browser command: `scripts/ui-test.sh tests/ui/m10i-styleguide.test.ts` with Node 26.3.1 selected. Five tests passed, no skips, across 392 state/package/posture/engine combinations: 14 states in all six starter packages at phone/desktop widths in Chromium/WebKit, plus Orb Teal tablet/half-open. No overflow, browser errors or mutation requests. There are 120 actual PNGs (112 full state/posture renders and eight direct component captures), linked in `docs/reviews/m10i-styleguide-review-packet.md`.

Token lint, theme validation, typecheck, coverage/UI-review checks (13/13) and diff checks pass. The static Node tests emit an existing localStorage ExperimentalWarning, also reproduced on unchanged `92735155` (9/9 pass); it is disclosed and not suppressed. Five alternate designs retain their prior below-bar status; no theme values or approvals changed.

The optional broad host run recorded 1,579 pass, three fail, 14 skip. Its scoped control-outline contrast failure was fixed and the existing regression check passes. The other two failures, provider-guard and skills email-summary timing cases, passed once in isolation (17/17). No final full-host-suite green claim is made. Exact-head CI remains mandatory before any merge.

## CI fixture correction

The first corrected draft head `fd76346c` failed the packet-named R13 timing case twice, including the single permitted rerun; UI121/121 and axe0 passed. A deterministic forced-reconciliation regression then reproduced the cause before a minimal test-only fix at `b4088fcc`. Focused1/1, full review2 file7/7, typecheck and independent scoped review pass. [Cause, RED/GREEN and limits](../reviews/m10g-r13-fixture-fix-2026-11-01.md). No further blind rerun was used. Full-suite and fresh exact-head CI validation remain required separately.

## Outstanding gate

- Owner approval of this rendered entry, required by OPERATING-RULES before app code.
- Real hub/device/native-workload state, merged-health computation with both reasons/ages, and read-only API.
- Settings/Health entry points, actual promotion/rollback approval paths and same-state Mermaid text export/snapshot.
- App browser gate in every starter package, M9 performance budgets, dependency/script guards and final independent phase review.
- Plain-language LEDGER entry reflecting the eventual delivered behavior, exact-head green CI, merge and preview restart.

Until owner approval arrives, app integration does not proceed. Latest merged main remains the normal preview; an isolated synthetic review server may serve this styleguide entry for recognition review.
