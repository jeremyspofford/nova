# Owner architecture-track addendum — Graph Engineering

Owner instruction received 2026-11-03. This is a queued requirements record, **not an ADR, implementation plan, or shipped capability**. It joins the Architecture track after A1/A2 in [Priority Insertion #1](owner-priority-queue-2026-11-02.md). Continue the combined queue without stopping at completions; report completed merges one line each.

**ADR FIRST: a docs-only PR, with the second-model review pattern, before any code.** Incorporate the research conclusions as inputs when preparing that ADR; this record does not claim that research has already been supplied or verified.

## Settled decisions

1. No Neo4j, server graph database, or Kuzu.
2. The graph layer lives in Nova's existing SQLite.
3. LadybugDB, if ever introduced, is only a rebuildable, read-only analytics sidecar.

Design within these decisions; do not reopen them.

## G1 — Storage and retrieval

Use `graph_nodes` and `graph_edges` in the existing SQLite store. Nodes and edges reference existing records through `ref_table`, `ref_id`, and `ref_path` pointers to ledger entries, memories, and files; the graph never duplicates content. Edges have world-truth times `valid_at` / `invalid_at`, system-truth times `created_at` / `expired_at`, and a `deleted_at` tombstone. Every edge carries provenance: `source_id` and `confidence`; inferred edges must carry both.

Traversal is bounded application-level BFS in TypeScript with an explicit visited set and fan-out/hop caps. Recursive CTEs are restricted to lookups of at most three hops: they have no global visited set, so unbounded CTE traversal is prohibited. FTS5 plus sqlite-vec remains the default retrieval path. The graph's retrieval role is anchor → one–two hop expansion for precedent, provenance, and temporal queries only.

**Amended 2026-11-10 by the owner's ruling on the accepted ADR** ([knowledge-graph-adr-2026-11-10.md](knowledge-graph-adr-2026-11-10.md), "The G1 amendments, as ruled"). Where the text above differs, the amendment wins:

- The tables are `graph_node` and `graph_edge` (singular names).
- Graph rows carry no `deleted_at` column; a forget deletes the derived rows. G4's tombstone is the existing content-free forget marks (the "forgotten" memory event, the day note's keyed-hash "note-forgotten" event, `capture_tombstone`). Limit: the hub deletes at once, and a machine that is switched off learns of the forget when it next connects.
- Retrieval: "FTS5 plus sqlite-vec remains the default retrieval path" is replaced by "Retrieval today is a shared-word scan. FTS5 is available in the bundled SQLite and is adopted on a measured need. Vectors are not planned while the bundled SQLite refuses extensions."

## G2 — Prospective decision traces

At the time Nova makes a meaningful decision (Jev/Noul call, approval-tier action, or trade-off choice), the runner writes its trace. A Decision records the actual candidates considered, Jev probability where used, and tier. Links are `BASED_ON` → Evidence, `CITES_PRECEDENT` → earlier Decision, `GOVERNED_BY` → Policy, `APPROVED_BY` → Approval, and `PRODUCED` → Outcome. When the result is known, Outcome `EVALUATES` → Decision. Traces live in the Work Ledger's store and are graphed through G1. Never infer these traces retrospectively from logs.

## G3 — Skill compilation

A skill may carry an ignorable `skill.graph.json` beside `SKILL.md`. The open Agent Skills standard defines packaging only: a runtime ignoring the sidecar still has a valid skill. Node types are `input`, `llm_fill`, `tool`, `decision`, `approval_gate`, `transform`, `loop`, and `output`.

Deterministic code owns control flow. The LLM only fills schema-validated inputs at `llm_fill` nodes and never chooses the next node. A decision is a guard using Jev/Noul probability `p` and two recorded thresholds: `p ≥ τ_high` selects branch A; `p ≤ τ_low` selects branch B; values between escalate to the owner. Record `p`, both thresholds, and branch taken in G2 so calibration drift can be measured. `approval_gate` stops for the owner's tier approval exactly as uncompiled actions do.

## G4 — Invalidate, tombstone, purge

Deletion comprises three distinct operations. Invalidate marks a fact no longer true while retaining history. Tombstone marks deletion and propagates to **all spokes before purge**, preventing resurrection. Purge walks the `DERIVED_FROM` closure, including derived facts, edges, summaries, embeddings, and distilled lessons: delete sole-derived artifacts, re-derive multi-source artifacts, and flag ambiguous ones for owner review.

Required canary: create a memory, generate derived artifacts, forget the memory, then prove no derived artifact still surfaces it, including through the vector index.

## G5 — Gated skill distillation

Nightly review may propose graph-skill drafts distilled from multiple run traces. Require a reviewable diff, `DISTILLED_FROM` provenance to those traces, paired evaluation with versus without the skill on held-out cases, and owner approval before installation. Never auto-promote. Automatically demote a distilled skill that regresses its evaluation and report the regression. Published evidence includes a negative result for ungated trace distillation; the gate is part of the design, not a courtesy.

## G6 — Observability and replay

SQLite run traces are the system of record; emit OpenTelemetry `gen_ai.*` spans alongside them. Observe branch hit rates per skill version, path deviation flags, Jev calibration using Brier score over logged probabilities, and outcome by version. Per-node checkpoints allow replay against recorded LLM/tool fixtures, including fail-on-old / pass-on-new regression tests.

## Pilot — only after ADR merge

Compile **one existing workflow only**: email-summary if present in the build, otherwise the morning digest automation. Run it alongside its uncompiled form for **one week of real runs** and report branch traces and any behavioural differences. Do not compile a second skill until the pilot report is in and the owner has seen it. Synthetic checks do not substitute for this real-run observation period.

## Explicitly out of scope

- Whole-corpus entity extraction into the graph.
- Community or cluster summarisation.
- Enforcing approvals through the graph: code enforces; the graph records.
- Graph as sync transport.
- Replacing Markdown skills or the ledger with the graph.
- Any new database server or daemon.

No current queue item is displaced by this architecture addendum. No graph code, credential access, real-run pilot, or additional database is authorized ahead of its stated gates.
