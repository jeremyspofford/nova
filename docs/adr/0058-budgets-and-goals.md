---
status: accepted
date: 2026-10-17
supersedes: ADR-016
---

## Context
ADR-016 bounded every run at 60 steps and 60 minutes. Findings from two reference
applications (`docs/external/RECONCILIATION.md`, APP-3 row 6, APP-4 row 6) show long work
bounded instead by budgets the user can see and raise, plus goals with system-owned budget
states. A fixed step count stops legitimate work and says nothing about cost.

## Decision
Runs carry time, token and cost budgets (defaults 60 min, 2,000,000 tokens, the provider spend
cap) and may hold a goal (FR-181, FR-182). Only the system sets the budget-limited and
usage-limited states. Each turn keeps a hard backstop of 200 model steps. Reaching any bound
pauses with a progress summary; nothing continues silently.

## Consequences
Long tasks no longer stop at an arbitrary step. Every turn is still bounded, so the guarantee in
`docs/09` §2 holds. The UI must show budgets live and offer to extend them.
