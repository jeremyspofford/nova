# Architecture Decision Records

One file per decision that changes or supersedes an entry in
[`../20-decisions-and-defaults.md`](../20-decisions-and-defaults.md).

## Format

```
docs/adr/NNNN-short-title.md
```

```markdown
---
status: accepted | superseded-by-NNNN
date: YYYY-MM-DD
supersedes: NNNN   # optional
---

## Context
What situation forced a decision.

## Decision
What we chose.

## Consequences
Trade-offs, follow-ups, and what becomes easier or harder.
```

## Rules

- Append a row to the ADR index in `../20-decisions-and-defaults.md` when you add a file.
- Never edit a past decision; write a new one that supersedes it.
- Reference the ADR id in the relevant commit and docs.
