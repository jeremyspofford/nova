# AGENTS.md — Operating Rules for the Build Agent

These rules are mandatory. They exist so the build can proceed **continuously and
autonomously** without human intervention while remaining safe, reversible, and verifiable.

## 1. Mission

Build **Nova**, a hub-and-spoke, multi-device AI system that unifies conversational AI,
long-running work agents, always-on agents, a coding agent, and device management, per the spec
in `docs/` and `contracts/`.

Before building, complete the spec reconciliation in `PROMPT.md` Phase 0: review any external
reverse-engineering findings under `docs/external/`, write `docs/external/RECONCILIATION.md`
(keep / modify / add / replace / reject per capability), apply the resulting spec changes, and
record decisions as ADRs. Only then proceed to build.

## 2. Non-negotiables

- **Never stop to ask the human.** Use the documented defaults. Record open decisions as
  ADRs in `docs/adr/NNNN-title.md` and continue.
- **Keep the tree green.** Every commit must build, typecheck, and pass its tests.
- **No proprietary copying.** Implement from the functional spec only. Do not copy source,
  binaries, assets, fonts, icons, text, or trademarks from any third-party app. See
  `docs/19-legal-and-ethics.md`.
- **No secrets in git.** Use `docs/12-permissions-security-privacy.md` keychain abstraction.
- **Local-first.** The app must work fully offline for local features; cloud is optional.

## 3. Required workflow loop

For every task:

1. **Pick** the next task from `LEDGER.md` (top of the current milestone, dependencies met).
2. **Locate the contract:** requirement ID (`FR-*`) in `docs/03-functional-requirements.md`,
   interface in `contracts/`, UX in `docs/04-ux-ia-and-design-system.md`.
3. **Write/adjust tests first** (unit and/or integration).
4. **Implement** the smallest change that satisfies the requirement.
5. **Verify:** `npm run lint && npm run typecheck && npm test` (and the milestone E2E).
6. **Document:** update the relevant `docs/` page and the generated API reference.
7. **Commit** with a Conventional Commit message referencing the requirement ID.
8. **Update `LEDGER.md`**: status, commit SHA, evidence, next task.
9. **Reflect:** if a decision changed, add an ADR; if a risk appeared, log it in
   `LEDGER.md` under *Risks*.

Loop until the milestone exit criteria are met, then start the next milestone.

## 4. Task ledger format (`LEDGER.md`)

```markdown
# Build Ledger
Current milestone: M3 — Tools, MCP, Plugins
Last updated: <ISO timestamp>

## Tasks
| ID | Milestone | Requirement | Status | Commit | Evidence | Notes |
|----|-----------|-------------|--------|--------|----------|-------|
| T-014 | M2 | FR-024 | done | abc1234 | `npm test -- provider` | retry logic added |
| T-015 | M2 | FR-031 | in_progress | — | — | streaming resume |

## Blockers
- (none)

## Risks
- R-003: Playwright Electron flakiness in CI → mitigate with retries.
```

Valid statuses: `todo`, `in_progress`, `blocked`, `done`.

## 5. Commit & branch conventions

- Conventional Commits: `feat(scope): ...`, `fix(scope): ...`, `docs: ...`, `test: ...`,
  `chore: ...`, `refactor(scope): ...`.
- Reference the requirement: `feat(chat): streaming cancellation (FR-018)`.
- Trunk-based: commit directly to `main` unless a risky change warrants a short-lived
  branch. No long-lived branches.
- Never force-push shared history. Never commit generated build output.

## 6. Quality gates (all must pass)

```bash
npm run lint          # ESLint + Prettier check
npm run typecheck     # tsc --noEmit across workspaces
npm test              # unit + integration
npm run test:e2e      # Playwright (milestone-scoped; full suite before release)
npm run build         # production build for the host platform
```

Coverage floors: **70% lines** for `packages/core`, `packages/agent`, and
`services/*`; **50%** overall. Security-sensitive modules (`packages/security`,
`packages/secrets`) require **90%** branch coverage on policy logic.

## 7. Definition of done (per task)

A task is `done` only when all are true:

- Requirement is implemented and traceable to its `FR-*` ID.
- Unit tests cover the happy path and at least one failure/edge case.
- Integration or E2E coverage exists if the task touches IPC, storage, or a provider.
- No new lint/type errors; no `TODO` without a linked ledger task.
- User-facing behavior is reachable through the UI (or documented as headless).
- Relevant docs/contracts updated; ADR added if a decision changed.

## 8. Ambiguity & failure policy

- **Prefer reversible choices.** Feature-flag risky behavior.
- **Timebox spikes** to 2 hours; if unresolved, pick the simplest option and document it.
- **External dependency unavailable?** Mock it behind the interface in `contracts/`,
  ship the real adapter behind a feature flag, and continue.
- **Test flakiness?** Quarantine with a linked ledger task; do not delete the test.
- **Security concern?** Fail closed (deny) and log; never weaken the policy engine to
  make a test pass.

## 9. Performance budgets (enforce in CI)

| Metric | Budget |
| --- | --- |
| Cold start to interactive (Linux, mid hardware) | ≤ 2.5 s |
| Idle memory (main + renderer, no agents) | ≤ 350 MB |
| Message send → first token (local provider mock) | ≤ 400 ms |
| Streaming render smoothness | ≥ 55 FPS at 60 Hz |
| SQLite query p95 for message load | ≤ 25 ms |
| Installer size (Linux AppImage) | ≤ 180 MB |

## 10. Documentation requirements

- Every public package exports typed APIs and has a `README.md`.
- `docs/` is updated in the same commit as the behavior change.
- `contracts/` is the source of truth for inter-process and network interfaces. If code
  and contract disagree, the contract wins; fix the code or amend the contract with an ADR.
- Keep `LEDGER.md` current at all times; it is the first file a successor agent reads.

## 11. Dependency policy

- Prefer well-maintained, permissively licensed (MIT/Apache-2.0/BSD) dependencies.
- Pin exact versions in the lockfile; record rationale for heavy dependencies.
- Any GPL/AGPL dependency must be isolated in an optional, dynamically-loaded extension and
  documented in `docs/19-legal-and-ethics.md`. Default build must remain permissive.
- Run `npm audit` on every milestone; fix high/critical by upgrade or documented waiver.

## 12. Communication

- After each milestone, post a concise summary to `LEDGER.md` (what shipped, evidence,
  risks, next). Do not wait for approval.
- Keep all generated artifacts under `build/` (git-ignored) or `artifacts/` (committed only
  when small and useful, e.g., screenshots referenced by the ledger).
