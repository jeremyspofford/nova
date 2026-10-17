# Kickoff Prompt — Handoff to Claude

> Copy everything below the line into the session that is taking over. It is self-contained.

---

You are taking over **Nova**, a hub-and-spoke, multi-device AI system. You are the lead
architect and autonomous build agent for this project. The repository at
`/home/jeremy/workspace/rea` is the **single source of truth** and the place where Nova will be
built **from scratch**.

Your immediate job is not to build yet. Your first job is to **review, reconcile, and finish the
specification** in this repository against findings from a previous session, then build.

## 1. Start here — read before doing anything

Read in this order, and do not skip anything:

1. `README.md`
2. `AGENTS.md` — your operating rules; follow them exactly
3. `docs/00-product-brief.md` through `docs/29-task-breakdown.md`
4. `contracts/README.md`, `contracts/hub-api.md`, and every file in `contracts/`

**Architecture in one paragraph:** Nova is a hub-and-spoke, multi-device system (`docs/21`).
An always-on **Hub** owns canonical state, runs the agent runtime/scheduler/policy, and serves
the web UI; **Clients** (browser/PWA and native shells) are thin; **Compute Nodes** supply
inference; the **`novad`** device agent runs on devices for local execution and management; a
content-blind **Relay** provides off-LAN reach. The default domain is **`arialabs.ai`**
(`catalog.arialabs.ai`, `wss://relay.arialabs.ai`, `sync.arialabs.ai`), all configurable.

## 2. Phase 0 — Review and reconcile the spec (do this first)

A previous session reverse-engineered several applications and produced findings describing
capabilities Nova should absorb. Those findings are expected under **`docs/external/`** (look
for a file such as `docs/external/*-findings.md`).

For **every capability** in those findings, classify it against what is already specified in
this repository:

| Decision | Meaning |
| --- | --- |
| **Keep as-is** | Already well-specified here; the external finding adds nothing material. |
| **Modify / merge** | Partially covered; merge the useful detail into the existing doc and FRs. |
| **Add** | Not covered here; add new requirements and docs. |
| **Replace** | The external finding is a better design; replace the corresponding section and supersede it with an ADR. |
| **Reject** | Not appropriate for Nova; record why. |

Then do all of the following:

1. Write **`docs/external/RECONCILIATION.md`** — a table with columns:
   *external finding → current coverage (doc + FR id) → decision → rationale → resulting change*.
   Include a short summary of what was kept, modified, added, replaced, or rejected.
2. Apply the changes across `docs/`, `contracts/`, and `docs/29-task-breakdown.md`.
   Keep requirement IDs, milestone mapping, and traceability consistent — the `FR-*` set must
   stay in sync across `docs/03-functional-requirements.md`,
   `docs/17-roadmap-and-milestones.md`, and `tests/manifest.md`.
3. Record every non-obvious decision as a new ADR in `docs/20-decisions-and-defaults.md`
   (append; never rewrite past decisions). Add files under `docs/adr/` when useful.
4. Preserve the project's invariants:
   - **No third-party product or brand names** anywhere in the spec (provider/vendor names such
     as Anthropic, OpenAI, Google are allowed — they are API targets).
   - **Plain, standard naming** (Project, File, Agent, …). No metaphor layer.
   - **Hub-and-spoke architecture**, the **policy engine**, the **self-improvement guardrails**,
     and the security model are hard invariants.
5. **Conflict precedence** when the two sources disagree:
   (a) Nova's hard invariants win — hub-and-spoke, policy/permissions, security, guardrails;
   (b) otherwise adopt the better-specified version and log the decision as an ADR.

### If the external findings are missing

Search the repository for any reverse-engineering output (for example under `docs/external/` or
`artifacts/`). If none exists, create `docs/external/RECONCILIATION.md` with a clearly marked
**"pending findings"** section, do **not** invent findings, note the gap in `LEDGER.md`, and
continue finishing the rest of the specification. Do not block on this.

## 3. Phase 1 — Finish the specification

- Fill any remaining gaps; every capability must have `FR-*` requirements, contracts where it
  crosses a boundary, and acceptance criteria.
- Update `docs/29-task-breakdown.md` and the milestone index in `docs/17`.
- Validate before moving on: all `FR-*` consistent across `docs/03`, `docs/17`, and
  `tests/manifest.md`; all JSON schemas parse; no broken internal links; no brand names.
- Update `README.md` and `LEDGER.md` to reflect the finished state.

## 4. Phase 2 — Build Nova from scratch

Only after Phases 0 and 1:

1. Execute the roadmap in `docs/17-roadmap-and-milestones.md` one milestone at a time
   (M0–M10, then capability tracks N1–N4), using the task list in `docs/29-task-breakdown.md`.
   Do not start the next milestone until the current milestone's exit criteria and the
   `docs/18-acceptance-criteria.md` checks pass.
2. Maintain **`LEDGER.md`** as the single source of truth for progress
   (`todo → in_progress → done`) with evidence (commit SHA, test output, screenshots). Update it
   before and after every task.
3. Work in small, Conventional Commits. Run the quality gate before every commit
   (`npm run lint && npm run typecheck && npm test`).
4. Write tests as you go (unit + integration + one Playwright E2E per milestone). A feature is
   not done without tests and docs.
5. Never leave the tree broken. Every commit must build, typecheck, and pass its tests.
6. When the roadmap is complete, run the release checklist in `docs/18` and write
   `RELEASE_NOTES.md`.

## 5. Standing rules

- Follow **`AGENTS.md`** for the workflow loop, quality gates, commit conventions, performance
  budgets, dependency policy, and the "never stop to ask" policy. The only permitted pause is
  the single check in Phase 0 if the external findings are missing.
- Keep the domain configurable with the `arialabs.ai` defaults; never hard-code it in logic.
- Keep the spec and `LEDGER.md` current at all times; they are the first thing your successor
  will read.

**Begin now with Phase 0:** locate and review the external findings, write
`docs/external/RECONCILIATION.md`, apply the resulting spec changes, and only then proceed to
Phase 1 and Phase 2.
