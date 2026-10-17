# 18 — Acceptance Criteria

## 1. Global Definition of Done (per milestone)

A milestone is **accepted** when all of the following are true:

1. Every `FR-*` in the milestone's coverage list is implemented and has tests.
2. The milestone's **golden journey** passes in E2E on Linux (and on macOS/Windows for
   release-bearing milestones).
3. `npm run lint && npm run typecheck && npm test && npm run test:e2e && npm run build` are
   green in CI.
4. No new P0/P1 defect; no unwaivered high/critical `npm audit` finding.
5. Docs in `docs/` and contracts in `contracts/` are updated; `LEDGER.md` is current.
6. New user-facing surfaces meet the accessibility baseline (axe: no serious/critical).
7. Performance budgets for touched surfaces are met or a waiver is recorded.
8. A short demo script exists under `docs/demos/M<n>.md` and runs from a clean profile.

## 2. Release Definition of Done

The product is release-ready when:

- M0–M9 accepted and M10 tasks complete.
- All 123 `FR-*` implemented or explicitly deferred (P2 deferrals listed with rationale).
- Full test suite green on all three platforms; security suite green.
- Performance budgets met (`AGENTS.md` §9).
- Signed installers for Linux/macOS/Windows with SBOM + checksums.
- Update → rollback verified.
- User-facing docs: quickstart, feature guide, security/privacy guide, troubleshooting.
- `CHANGELOG.md` and `RELEASE_NOTES.md` complete.
- `docs/19` legal review checklist satisfied (original assets, permissive deps, notices).

## 3. Milestone golden journeys (E2E scripts)

These are the concrete, scripted acceptance tests. Each must be automated.

### J1 — First chat (M1)
1. Fresh profile → onboarding → connect mock provider → set name.
2. Send "Hello" → tokens stream → Stop works → partial retained.
3. Restart app → chat is present → search finds "Hello".
4. Toggle theme → colors change.

### J2 — Providers & memory (M2)
1. Connect Anthropic-mock and local-mock.
2. Chat on A; switch model to B mid-thread; context preserved.
3. State a preference; open Memory panel; it appears; edit it; temporary chat excludes it.

### J3 — Tools & approvals (M3)
1. Add test MCP server; it reports healthy.
2. Ask a question that triggers a read tool (auto-allow) and a write tool (ask).
3. Approve the write; deny another; verify Activity entries and audit hash chain.

### J4 — Extensibility & workspace (M4)
1. Install sample plugin from local catalog; run its slash command.
2. Attempt an undeclared network call → blocked with a clear error.
3. Arrange panes (chat+terminal+editor); save layout; restart; layout restored.

### J5 — Work run (M5)
1. New run: "Summarize the attached report and save a Markdown artifact."
2. Plan appears; approve; 3+ tool calls execute; one asks for approval.
3. Result card shows the artifact; Activity trace replays; schedule it daily.

### J6 — Code session (M5)
1. New session in the fixture repo; permission mode Accept edits.
2. Ask to fix a failing test; edits appear as diff.
3. Comment on a line; agent revises; run tests; commit; PR status (mock host) shows.

### J7 — Agent (M6)
1. Create Agent; connect mock Slack and mock calendar.
2. Agent performs read-only proactive research and surfaces a finding.
3. Ask it to message a channel; a custom rule forces approval; deny; then allow-once.
4. Open its computer; take over; return control; verify audit entries.

### J8 — Browser safety (M6)
1. Navigate the Agent to the local test site; read/click/screenshot.
2. Attempt navigation to an unlisted host → blocked.
3. Inject an instruction in page content; verify no unapproved action occurs.

### J9 — Sync & multi-device (M7)
1. Two profiles pair devices.
2. Create a chat on device A; it appears on B.
3. Edit the same note concurrently → merge log records the conflict; restore works.
4. Queue an offline action; reconnect; it flushes in order.

### J10 — Extension & governance (M8)
1. Load a sample extension adding a command + panel + tool; permissions enforced.
2. Apply a managed policy that locks bypass mode and network; UI shows "managed".
3. Export data; delete all; import; verify integrity.

### J11 — Release (M10)
1. Install the packaged build; run first-run.
2. Update to the next build; verify data migrated; trigger a simulated failure → rollback.

## 4. Per-feature acceptance (traceability)

Every `FR-*` must have a row in a test manifest:

```markdown
| FR | Unit | Integration | E2E | Notes |
|----|------|-------------|-----|-------|
| FR-018 | providers/stream.test.ts | — | J1 step 2 | cancellation + partial retention |
| FR-099 | policy/evaluate.test.ts | agent/tool-gate.test.ts | J3 | all four effects + traversal |
```

The manifest lives at `tests/manifest.md` and is enforced by a CI check that fails if an `FR-*`
in `docs/03` has no test row.

## 5. Non-functional acceptance

| Area | Criterion |
| --- | --- |
| Performance | all budgets met on reference hardware; CI regression guard |
| Reliability | crash-free sessions ≥ 99.5% in a 7-day soak test |
| Offline | chat, memory, local tools, and settings work with the network disabled |
| Recovery | kill -9 during a run → restart resumes from last committed step |
| Security | security suite green; no plaintext secrets in artifacts |
| Accessibility | axe clean; keyboard-only journeys pass |
| Privacy | telemetry off by default; no network without user action |
| Data | export/delete round-trip integrity; audit chain verifies |
| Portability | same DB opens on all three OSes; no platform-specific data loss |
| i18n | RTL layout has no overlap/clipping on core screens |

## 6. Sign-off artifacts

For each accepted milestone, produce under `docs/demos/`:
- `M<n>.md` — the demo script and expected results.
- `M<n>-evidence/` — screenshots, trace excerpts, test output summaries (small files only).

And in `LEDGER.md`:
- status table with commit SHAs,
- the golden journey result,
- any deferrals with rationale and a linked follow-up task.
