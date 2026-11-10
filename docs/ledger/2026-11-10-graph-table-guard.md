**2026-11-10 · Knowledge · A test refuses any graph table until the owner opens stage 2 of the graph ADR**
- What changed: tests/core/graph-guard.test.ts applies every migration to an empty database and fails if any creates a graph_ table, view or index, unless the knowledge-graph ADR reads Accepted and its new "Stage 2" line says the owner opened it. The ADR gains that line, set to Not opened. This is F-057's acceptance criterion and PR 1 of the ADR.
- What you can now do: rely on CI to stop stored graph tables from arriving before F-058, a measured need and your go-ahead; you open stage 2 by editing one line of the ADR.
- Still unfinished: no graph code exists. Slice 1a is next; slice 1b waits for the fresh-Gemini review.
- Checked: the guard refuses six stand-in spellings of a graph object, a missing ADR and a proposed one, and passes the real migrations; typecheck and the full npm test.
