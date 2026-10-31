# Nova Amendment 2026-10-31-A — QA Harness: change-aware PR testing + full-application E2E

Status: APPROVED by Jeremy 2026-10-31 — path chosen: Muse builds the Stage 1 standalone prototype first, then hands Claude the proven design as the Stage 2 amendment. Prepared by Muse 2026-10-31 after a rival scan (Canary, Momentic, QA.tech) found no acceptable hosted product: Canary has no public pricing, is diff-scoped only, and would require sending the full codebase and a reachable preview to a two-person startup's cloud — incompatible with Nova's local-first posture. This amendment builds the capability locally instead.

## What this adds

A local QA harness for Nova with two modes, run entirely on Jeremy's machines against local instances. No external service ever receives code or a live build.

### Mode 1 — Change-aware PR testing (the Canary pattern, local)
On each milestone PR (and on demand):
1. Read the diff. Map changed files to affected surface: API routes, UI views, core modules — using the repo's own structure and the contracts in docs/builder-packet/CONTRACTS.md.
2. Select flows: every catalogue flow touching the affected surface, plus the always-run smoke set.
3. Run the selected flows in Playwright against a disposable QA instance (own port, own freshly seeded data home — never the preview's state, never real data).
4. Report on the PR (or as a run report before merge): per-flow pass/fail, screenshot + trace/video on failure, captured console errors and failed network requests, relevant server log tail. A failing core flow blocks merge under the existing gate rules; advisory findings do not.

### Mode 2 — Full-application E2E sweep
On milestone completion and on demand:
1. Enumerate the whole surface from the app itself (router + navigation): every view and API route.
2. Per view: load check (success response, zero console errors), accessibility scan (axe: contrast, labels, focus), screenshot captured for visual-baseline diff against the last accepted baseline.
3. Every catalogue flow end-to-end.
4. API contract smoke: each documented endpoint answers per CONTRACTS.md.
5. Advisory UX pass (non-gating): a vision model reviews the screenshot set against DESIGN-SYSTEM §1 (perception principles) and standard usability heuristics; findings are labelled advisory and require a human decision. Automated UX output never blocks a merge.

## The rule that makes it trustworthy
Assertions come from the SPEC, not from observed behaviour. Flows encode what the builder packet and contracts say the app must do. A flow that merely asserts whatever the code currently does is a defect in the catalogue — that failure mode (tests ratifying bugs) is the known weakness of generated E2E suites and is explicitly out of bounds. Where the spec is silent, the flow asserts only invariants (no errors, no data loss, state survives reload) and flags the gap for a spec decision.

## Components
- **Flow catalogue** (in-repo, versioned, human-readable): id, name, plain-language steps, spec reference, criticality (core/advisory), surface tags for change-mapping. This catalogue is the real asset; the runner is replaceable.
- **Runner**: Playwright (already Nova's UI-gate stack), driving the QA instance; captures console, network, traces, screenshots as first-class evidence.
- **Change mapper**: diff → surface tags → flow selection. Starts simple (path-prefix rules maintained with the catalogue), improves only with evidence of misses.
- **Reporter**: one run report per run — summary counts, failures with evidence links, advisory section separated from gating results. Reports land in the Work Ledger as verification records once Nova-side integration happens (see sequencing).

## Where it runs
Local only: WSL on the XPS against the local build, same trust boundary as the existing gates. Fits all privacy modes by construction (zero egress). QA instances are disposable and seeded; runs never touch the preview data home or any real data.

## Sequencing (proposed)
- **Stage 1 — standalone prototype (Muse, separate workspace, read-only toward nova-build):** crawler + per-view checks + flow catalogue v1 derived from the packet/contracts + first full-sweep report on current main. Purpose: prove the catalogue and report format on the real app before spending builder time.
- **Stage 2 — builder amendment (Claude):** fold the proven runner + catalogue into the repo as a milestone after M10 (or as the verification stage of the M7 self-modification pipeline, builder's call with rationale): PR-triggered Mode 1 wired into gates; Mode 2 on milestone completion. The self-change pipeline MUST consume Mode 1/2 results before any canary deploy — an agent that modifies itself needs exactly this verification, and it is currently the pipeline's weakest link.
- Stage 1 does not block or alter Claude's current milestones. Stage 2 starts only on Jeremy's approval of the Stage 1 report.

## Acceptance criteria (Stage 1 report)
- Every reachable view inventoried with load/console/a11y status and a screenshot.
- Flow catalogue v1 covers at minimum: first-run setup, pairing (emulated device), memory add/correct/forget (incl. backup propagation), trigger create/fire, design-system swap + rollback, backup create/restore, checkpoint/restore (once M7 lands), provider add in each privacy mode with the local-only no-cloud rule verified by egress observation.
- At least one real defect found or a defensible zero-defect statement with coverage numbers.
- Report distinguishes gating failures from advisory findings throughout.

## Non-goals
- No hosted QA service, no code or build leaves the tailnet.
- No generated tests asserted from observed behaviour alone (see the rule above).
- No UX auto-blocking; UX findings are advisory, always.
- Not a replacement for the existing unit/integration suites or milestone gates — this is the missing running-app layer above them.
