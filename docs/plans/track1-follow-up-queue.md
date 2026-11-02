# Track 1 follow-up queue

The milestone chain remains M10i → M10j → M10k. This queue records integration work without silently inserting it ahead of that chain. The broader handoff queue remains in `docs/builder-packet/HANDOFF-FROM-BUILDER-2026-11-01.md` §3; each item still needs its own scope and verification.

## Memory-gate wiring — queued after #277, not live

Source: `docs/plans/ds2-memory-gate.md` NOTES 1–3 and the owner's 2026-11-01 standing queue order. The merged template and fixed evaluation do not change memory writes.

- Make runner `keep()` asynchronous and await its call site. Ask the gate only for untainted remember operations, with the person's exact turn, Nova's answer as context, the candidate and nearest existing memories. Keep tainted operations held for the person.
- Inject the decision-service call from `src/server.js`, preserving private routing: local-first and local-only never send the person's conversation to a cloud seat.
- Add `memory_candidate.reason`, show the contradiction reason in the existing candidate flow, and preserve session/turn provenance in decisions and writes.
- Prove save, skip, merge, flag, deterministic duplicate, missing/untrusted/unanswered fallback and tainted-run behavior. Include a cross-conversation memory regression and a privacy/egress assertion. Do not tune the fixed questions, cases, bounds, results or model digest to pass wiring tests.

Acceptance: behavior is covered through the real runner/server path; exact-head CI passes; the same PR updates LEDGER and inventory to distinguish a live consumer from the template. Until then, retain the current “not switched on” claim.

Evaluation limits remain: 0/49 observed false saves has an interval reaching 7.3%; three contradictions were skipped; one author wrote questions and cases; only the recorded tev1:4b digest passed. No model pull or rerun is authorized by this queue entry.

## Broad-host test timing and runtime warnings — retained from M10i

M10i's implementation reports retain failed broad host runs, separately from focused passes and final CI (`docs/evidence/m10i-gate.md`). Investigate M6a capture outage/recovery, onboarding's released negative-fixture port, provider-guard background-process results, and skills email-summary timing under their original full-suite schedule. Isolated passes and the altered-order diagnostic are not resolutions. Fix a demonstrated scheduling/fixture cause with a regression; do not increase waits or rerun until green without diagnosis. The R13 fault-lifetime race was separately fixed at `b4088fcc` and independently reviewed.

The Node-only localStorage ExperimentalWarning is confirmed on the baseline. DEP0187 appeared near provider-guard but remains unattributed without a trace. Attribute and fix these in the test runtime without global warning suppression or unrelated production changes. Preserve real-model/keychain opt-in skips and the no-owner-service test boundary.

Navigation-gate validation on 2026-11-02 retained another ordinary-run failure/stall and bounded full-run failures, including the mode/profile event check. A read-only diagnosis identifies fresh-user's early-failure HTTP/UDP cleanup gap and a plausible absent-port reservation race; the exact responder is unknown. Six affected files pass 43/43 with the ordinary serial runner and no overlapping browsers. This is a control, not a full-schedule resolution. Preserve the [diagnosis](../reviews/navigation-test-stall-diagnosis-2026-11-02.md) and [failure excerpts](../evidence/navigation-reachability-2026-11-02/local-full-failure-excerpts.txt). A future fix should reserve negative-service ports with owned refusing listeners and prove cleanup on early failure, without contacting owner services or loosening timeouts/assertions.

## Discoverability gaps — inventory reconciliation, not new shipped workflows

The owner's navigation escalation has a [full 51-capability mapping and 70-item orphan/scope register](../evidence/navigation-capability-surfaces-2026-11-02.md). This queue reference does not authorize every API to become a new UI immediately or displace the orchestration chain. The inventory now explicitly distinguishes surfaced controls, conditional existing-record screens, tool/API/CLI-only starts, CI/developer mechanisms and unbuilt work. Future feature work must give its own workflows discoverable doors and extend the rendered proof; do not clear an entire row because its broad category is reachable. Security-sensitive setup/recovery and credentialed paths keep their existing gates.

## Device-agent map authority — not integrated

M10i exposes eligible ServiceManager version actions, not a new boot/runtime-agent update authority. The whole-branch reviewer explicitly excluded that unregistered integration. Before exposing such an action, connect its existing signed update/promotion path through a reviewed fixed authority and enforce the ADR's tier3 rule, current-target binding and observed-versus-assigned outcomes. Do not add a parallel execution bridge or imply that the non-capture privileged-service tests prove a device-agent update workflow. This follow-up does not lift real-device, signing-account or owner-data limits.
