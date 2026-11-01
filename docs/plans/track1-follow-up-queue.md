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
