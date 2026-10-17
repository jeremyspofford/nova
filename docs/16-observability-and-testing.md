# 16 — Observability & Testing

## 1. Logging & tracing

- **Structured JSON logs** with levels (`trace|debug|info|warn|error`), module, and correlation
  ids (thread/run/session/agent, request id).
- Default level `info`; developer mode enables `debug`; `trace` is opt-in per module.
- **Redaction is applied at the logging boundary** (never trust call sites): provider keys,
  tokens, cookies, `Authorization` headers, connection strings, and user-defined patterns.
- Logs rotate at 10 MB × 5 files; retention default 14 days; viewer in Diagnostics with search
  and copy; export bundles are redacted and previewable.
- **Tracing**: spans for IPC, provider calls, tool calls, sandbox ops, and DB transactions;
  a local trace viewer shows waterfall + events. Traces never leave the device unless the user
  exports a bundle. Use OpenTelemetry-style span shape but a local-only exporter by default.

## 2. Metrics (opt-in)

If telemetry is enabled (`docs/12` §9): counters and histograms only (no content) for:
startup time, crashes, provider error rates/latency buckets, tool success/failure, run
durations, feature adoption flags. A local dashboard mirrors what would be sent.

## 3. Test pyramid

```
        ▲  E2E (Playwright, per-OS)            ~5%  — real app, real providers mocked
       ─┼─  Integration (Vitest + MSW)         ~25% — core + services + DB + MCP
      ──┼── Unit (Vitest)                      ~70% — pure logic, policy, adapters, UI logic
```

### 3.1 Unit

- Pure logic: policy engine, context assembly, token counting, cost math, cron parsing,
  conflict resolution, redaction, path canonicalization.
- Provider adapters against recorded fixtures.
- React component behavior via Testing Library (states, a11y roles, keyboard).

### 3.2 Integration

- DB repositories with an in-memory/temp SQLite (real migrations).
- Agent runtime with a mock model and mock tools (allow/ask/deny paths).
- MCP client against a test server (stdio + http), including failure/restart.
- Sandbox broker with a stub executor on Linux; real bwrap in a dedicated CI job.
- Sync engine with two simulated devices: conflict, offline, tamper.

### 3.3 E2E (Playwright + Electron)

Golden journeys, one per milestone, at minimum:

1. Onboard → connect a mock provider → send a message → stream → artifact.
2. Create project → add source → ask a question → citation.
3. Install plugin/MCP → run a tool → approve → see audit entry.
4. Code session → edit → diff review → comment → run tests → commit.
5. Work run → plan → sub-agent → approval → result; schedule a recurrence.
6. Agent → connect channel → proactive finding → custom rule → activity review.
7. Sync two profiles → edit on one → observe on the other.
8. Update flow → backup → migrate → rollback.

E2E runs against a **deterministic mock provider** by default; a nightly job runs a small set
against live providers behind secrets.

## 4. Provider & tool mocking

- `packages/providers` ships a `MockProvider` that replays fixture transcripts with timing
  control (instant/streamed/slow), tool calls, and error injection.
- `packages/mcp` ships a `TestMcpServer` exposing predictable tools/resources/prompts.
- Network is disabled in tests except explicit localhost; MSW intercepts any HTTP.

## 5. Security testing (FR-123)

A dedicated suite (see `docs/12` §12) runs on every PR touching policy, sandbox, secrets, or
network. It asserts **fail-closed** behavior and that every denial is audited. Fuzzing is
applied to the policy input parser and the redaction scrubber.

## 6. Performance testing

| Test | Budget | Enforcement |
| --- | --- | --- |
| Cold start | ≤ 2.5 s | CI benchmark vs baseline; fail on >20% regression |
| Idle memory | ≤ 350 MB | CI benchmark |
| Streaming FPS | ≥ 55 FPS | Playwright trace + rAF sampling |
| Message load p95 | ≤ 25 ms | DB benchmark with 100k messages |
| Installer size | ≤ 180 MB (Linux AppImage) | release check |
| Bundle size | main renderer ≤ 2.5 MB gzip | build check |

Benchmarks run on a fixed runner with warmed caches; results are stored as artifacts and
tracked over time.

## 7. Accessibility testing

- **axe-core** on every primary screen in E2E; zero serious/critical violations.
- Keyboard-only journey test (no mouse) for core flows.
- Screen-reader smoke test (VoiceOver on macOS, Narrator on Windows) in the release checklist.
- Contrast checks across all built-in themes.

## 8. Test data & fixtures

- A seeded `fixtures/` directory: sample project (small monorepo), sample docs, sample images,
  a buggy app for Code E2E, and provider transcripts.
- Fixtures are deterministic and committed (small); large binaries are fetched by hash.
- Golden files for rendered Markdown, diffs, context assembly, and plans.

## 9. CI matrix

| Job | Trigger | Platforms | Contents |
| --- | --- | --- | --- |
| `lint-typecheck` | every push | linux | ESLint, Prettier, tsc |
| `unit` | every push | linux | Vitest with coverage gates |
| `integration` | every push | linux | Vitest + real SQLite + mock MCP |
| `sandbox` | every push | linux | Real bwrap tests (privileged runner) |
| `e2e` | every push | linux | Playwright Electron (mocked providers) |
| `platform-build` | PR to main / nightly | mac, win, linux | Build + package + smoke |
| `security` | every push | linux | Injection/policy/secret/sandbox tests |
| `perf` | nightly | linux | Benchmarks + budget checks |
| `live-smoke` | nightly (opt-in) | linux | Live provider round trips |
| `release` | tag | all | Sign, notarize, publish, SBOM |

Failures block merges; flaky tests are quarantined with a linked ledger task and a 14-day SLA
to fix or delete.

## 10. Definition of test-complete

A milestone is test-complete when:

- Every new `FR-*` has at least one unit and one integration/E2E test.
- The milestone's golden journey passes in CI on Linux, and on macOS/Windows before release.
- No P0/P1 bug is open; no unwaivered security or accessibility failure.
- Performance budgets for touched surfaces are met.
- Coverage floors (`AGENTS.md` §6) are upheld.
