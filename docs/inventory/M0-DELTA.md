# M0 inventory delta — evidence

What the M0 audit found when the packet's CAPABILITY-INVENTORY was checked against code on 2026-10-29. The corrected inventory is `docs/builder-packet/CAPABILITY-INVENTORY.md`; this file holds the evidence behind each change.

- **Era 2** = `origin/main` `04512c07`. Paths relative to the repo root.
- **Era 1** = `6e2cf142` (read with `git show 6e2cf142:<path>` or `git archive 6e2cf142`). `core` = `packages/core/src`, `ctest` = `packages/core/test`, `htest` = `apps/hub/test`.

## Baseline

| Check | Result |
|---|---|
| Era 2 suite on the untouched tree, locally (Node 26.3.1) | 127 / 127 pass; `lint:tokens` clean (13 files); `check:themes` 4 / 4 themes pass contract + contrast; `npm audit` 0 vulnerabilities |
| Same, on GitHub Actions (new `ci` workflow, toolchain from `mise.toml`) | Green — run 40961526726 |
| Era 1 CI at `6e2cf142` (GitHub check runs) | lint/typecheck/unit/build, novad (Rust), e2e (Playwright), e2e (desktop shell) — all success |
| CI before M0 | None ran tests. The only workflow was `handoffs.yml` |

## Changes to the inventory, with evidence

| Row | Packet said | Code says | Evidence |
|---|---|---|---|
| Delegation | Era 2 handoffs mailbox (Claude↔Claude) | The mailbox is a repo + GitHub Actions process, not runtime. Runtime delegation is `helpers` | `handoffs/README.md`, `.github/workflows/handoffs.yml`; runtime: `src/helpers.js` (`spawn`, `execute`, `hand`), `delegate` tool in `src/tools.js`, `tests/helpers.test.js`. Era 1: `core/runs/tools.ts` (`task.spawn`), `SubagentView.result: string` |
| Work Ledger | New; pieces in schedules/handoffs | Era 1 had durable runs with restart recovery | Era 1 `core/runs/service.ts` (`RunService.recover()`), `packages/storage/src/schema/runs.ts`, `ctest/runs-lifecycle.test.ts` "restart". Era 2: JSONL only (`src/sessions.js`, `schedules/runs.jsonl`), helper queue in memory |
| Verification | New | Era 1 verified one declared output per run | Era 1 `RunService.#verify` / `#finish`, `ctest/runs-lifecycle.test.ts:159,197` |
| Trigger engine | Partial (Era 2 schedules only) | Era 1 had event triggers, dedupe and a rate cap | Era 1 `core/channels/triggers.ts`, `core/scheduler/*`, `core/agents/service.ts`; `ctest/triggers-service.test.ts`. Era 2 `src/scheduler.js`, `src/schedules.js` |
| Approval tiers | (not listed) | Era 2: `yes`/`ask` per tool + mail taint | `src/permissions.js`, `src/runner.js`, `tests/permissions.test.js` |
| Device pairing | Partial, needs rebuild | Era 1 already matches CONTRACTS §5 | Era 1 `core/pairing/{service,code,binding,limiter}.ts` (`PAIRING_CODE_TTL_MS = 5 min`, single use, Ed25519 device key, hub approval), `ctest/pairing.test.ts`, `e2e/j8-5-add-device.spec.ts`, `services/novad/src/cli.rs` |
| Local models | New | Era 1 detects running servers + VRAM | Era 1 `core/routing/detect.ts`, `services/compute/src/{vram,capability}.ts`, `ctest/detect.test.ts` |
| Fallback chains | New | Era 1 router, fail-closed when cloud disallowed | Era 1 `core/routing/{router,retry,breaker}.ts`, `ctest/router.test.ts:439` |
| Gmail | Partial — Era 2 IMAP | Era 2 has OAuth API **and** IMAP; never sends | `src/connectors/gmail.js` (`SCOPE = gmail.modify`), `src/connectors/gmail-imap.js`, `tests/gmail*.test.js` |
| Browser + takeover | New | Era 1 had it | Era 1 `core/browser/session.ts` (pause/resume, frame stream), `core/screen/*`, `ctest/browser-*.test.ts`, `htest/screen.test.ts` |
| Relay | (Relay repo) | Name collision: Era 1 `relay` is an encrypted transport | Era 1 `packages/relay/src/*` (X25519/Ed25519, XChaCha20-Poly1305), `services/relay/*` |
| PWA | Partial — Era 2 web UI | Era 2 is not a PWA | No manifest or service worker in `ui/`; `.webmanifest` appears only as a MIME type in `src/server.js`. Era 1 had `apps/web/public/{manifest.webmanifest,sw.js}` |
| Design tokens | Partial | Confirmed; named gaps | `ui/js/contract.js` `CONTRACT`, `scripts/lint-tokens.js`, `scripts/check-themes.js`, `ui/js/theme.js` `choose()` |
| Errors in UI | Known defect: errors only in logs | Narrower: chat errors reach the UI; helper failures do not | Reaches UI: `Runner.start` catch → session `error` event → `ui/js/view.js` alert; test "a failing model becomes a readable error". Silent: `src/helpers.js:69` (`console.error`), `:99` and `:108` (`.catch(() => {})`), `git()` in `src/home.js` |
| Onboarding | Partial | Era 2 none; Era 1 a form | Era 2 `seedHome` only. Era 1 `apps/web/src/onboarding/Onboarding.tsx`, `e2e/j1-first-chat.spec.ts` |
| Storage | (not listed) | Era 2 plain files; Era 1 `node:sqlite` + checksummed migrations | Era 1 `packages/storage/src/{database,migrations}.ts`, `packages/storage/test/migrations.test.ts` |
| Secrets | (not listed) | Era 2 plaintext 0600; Era 1 encrypted vault + keychain | Era 2 `writeSecret`, `guard()` in `src/tools.js`. Era 1 `packages/secrets/src/{vault,keychain}.ts` |

Confirmed **New** (zero hits in both eras): decision journal and calibration, decision templates, Decision Model Provider, deliberation/critic pass, context receipts, Capture API / Screenpipe, voice, Home Assistant, n8n, hub failover/standby, boot/runtime agent split (Era 1 `novad` supervisor is the nearest seed).

## User-specific data found

The fresh-user rule (PROFILES-AND-CUSTOMIZATION) bans user data from core code, fixtures and examples.

- **Era 2 runtime code, templates, skills, schedules, tests: clean.** Fixtures use `example.com` identities.
- **Era 2 non-runtime:** `handoffs/` (README, outbox, archive), `.github/workflows/handoffs.yml`, `docs/LEDGER.md`, `docs/build/*`, `docs/phase-*-review.md` name the owner and their personal agent. These are build records and the owner's own Muse↔Claude bridge, not core. **Left untouched** — whether the bridge stays is the owner's call.
- **Era 1 test fixtures** use the owner's first name (~19 files, e.g. `ctest/channels-service.test.ts`, `ctest/network-mdns.test.ts`) and a `…@home.example` address. **Any Era 1 test ported into the tree must have these replaced with neutral placeholders.**

## Hazards noted (no action taken)

- `handoffs.yml` runs a headless Claude with `--dangerously-skip-permissions` on any push to `main` that touches `handoffs/inbox/`, and commits mailbox replies straight to `main` (code changes go to PRs). It is a builder-side process, outside Nova runtime, and it is the owner's. Builder PRs must not touch `handoffs/inbox/`.
- In this fresh clone, local `main` matches `origin/main` (`04512c07`). The stale `main` and the uncommitted Era 1 worktree the packet warns about live in a different checkout, which this build never opened.

## Packet conflicts

None found. Two clarifications, both consistent with the packet:
- ADR-1 requires TypeScript; the current tree is JavaScript. The packet wins: the core moves to TypeScript from M1 (see the decision log in `docs/LEDGER.md`).
- The Stellar Map, referenced as an Era 2 sanctioned extra, exists only in open PR #207, which stays unmerged.
