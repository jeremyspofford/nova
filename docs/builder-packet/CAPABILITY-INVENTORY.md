# CAPABILITY INVENTORY — target vs. existing

Status key: **Have** (exists and verified) · **Partial** (exists, needs work) · **New** (build) · **Later** (specified, not in early milestones).

**Verified at M0 (2026-10-29) against the code, not the docs.** Era 2 = `origin/main` HEAD `04512c07` (plain JS, Node built-ins only, 127 tests). Era 1 = last Era 1 commit `6e2cf142` (TypeScript monorepo + Rust `novad`, ~465k lines TS + 24k Rust, all four CI jobs green on GitHub at that commit; deleted from the tree by `7ea842b5` "clean slate"). Evidence paths for every row are in `docs/inventory/M0-DELTA.md`. Rows marked **▲ corrected** changed at M0.

"Reuse" names the component a milestone should start from. Reuse is per component: Era 1 code is ported in only with its tests and only where it fits the contracts here; its dependency footprint (React, Electron, Fastify, drizzle, QuickJS) does not come with it.

## Core loop and platform
| Capability | Target | Existing (verified) | Reuse |
|---|---|---|---|
| Chat with a swappable agent (`agent_cmd`) | Core, generalized into a provider registry | Partial — Era 2 `agent_cmd` swap point works (Claude CLI + fake agent tested; one command for all roles, config edit + restart). Era 1 had a full provider registry (Anthropic, OpenAI-compatible, Ollama, llama.cpp, mock) with conformance tests | Era 2 swap point now; Era 1 registry shape at M5 |
| Multi-agent delegation (brief-in/report-out) | Core task contracts | Partial — **▲ corrected:** the Era 2 `handoffs/` mailbox is a builder-side GitHub Actions process, not runtime. Runtime delegation is Era 2 `helpers` (in-memory queue, lost on restart; report is a handoff event) and Era 1 `task.spawn` (result is a plain string). Neither has a structured brief/report or `evidence[]` | New envelope at M1 |
| Work Ledger (durable tasks) | Core | Partial — **▲ corrected:** Era 1 had durable runs with states and restart recovery (scoped to runs/goals, not a general ledger). Era 2 has none; only JSONL logs and a derived activity view | New at M1; Era 1 state model as reference |
| Verification / evidence layer | Core | Partial — **▲ corrected:** Era 1 verified one declared output per run (artifact exists, sha256, delivery receipt) as free-text evidence strings. Era 2 none | New at M1 |
| Decision journal + calibration | Core | New — confirmed absent in both eras | — |
| Trigger engine (reactive/proactive/event/heartbeat) | Core | Partial — Era 2: cron-only markdown schedules, enqueue-once dedup, no cooldown, no events. **▲ corrected:** Era 1 had webhook/connector/MCP event triggers with per-key dedupe and an hourly rate cap, plus proactive checks; no per-trigger cooldown | M2; Era 1 dedupe design as reference |
| Long-term memory w/ provenance | Core | Partial — Era 2: markdown entries with id/source/time, correction via `replaces`, forget + undo; no export endpoint, no confidence. Era 1: SQLite `memory_item` with source, confidence, supersedes, status; export only via whole-account archive | M2 |
| Context receipts | Core | New — both eras record only model/usage or skill names; neither stores what context was sent | — |
| Identity/persona layer (model-independent) | Core | Partial — Era 2 standing files (`SOUL.md`, `IDENTITY.md`, `USER.md`…) re-read every turn; name "Nova" also hard-coded in prompt and UI strings. Era 1 hard-coded default prompt + per-agent instructions | Era 2 standing files at M1 |
| Deliberation + critic pass | Core | New — Era 1 has an adjacent fail-closed action reviewer only | — |
| Decision Model Provider (Jev-class System 1) | Pluggable provider | New — confirmed absent | — |
| Decision templates (cached, validated, versioned) | Core mechanism | New — confirmed absent | — |
| Approval tiers (NOVA-SPEC §6) | Core mechanism | Partial — **▲ added:** Era 2 has two tiers (`yes`/`ask`) per tool in a hand-editable file, plus a taint rule after mail is read. Era 1 had policy, persistent grants and approvals. Neither has the four-tier model | M1 (tiers on tasks), full policy later |

## Devices, capture, models
| Capability | Target | Existing (verified) | Reuse |
|---|---|---|---|
| Device pairing (QR / code / command) + hub approval | Core | **▲ corrected to Have (Era 1, needs porting)** — Era 1 pairing matches CONTRACTS §5 closely: device-generated Ed25519 key, single-use 8-char code with 5-min TTL stored hashed, rate limits, commit-then-reveal confirmation, hub-side approval, QR, `novad install --code`. 56 unit tests + e2e. Not in the current tree | Port at M4 |
| Device mesh + hub-as-role + failover | Core | Partial — Era 1 hub-and-spoke, mesh VPN adapters, encrypted sync (HLC, LWW, hub canonical). Failover/standby: New (zero hits) | M4 |
| Two device agents (boot + runtime, never merged) | Core | New as specified — Era 1 `novad` (Rust) has a supervisor + signed modules + signed updates, which is the nearest seed; no boot/runtime split | M4, `novad` as reference |
| Capture API + Screenpipe ingest | Core API; ingest first | New in Nova — zero hits in both eras (Screenpipe exists only in the user's own stack) | M6 |
| Local model management (detect HW, recommend, download, serve) | Core | Partial — **▲ corrected:** Era 1 detects running Ollama/llama.cpp servers and GPU VRAM; no recommendation, download or serving lifecycle. Era 2 none | M6 |
| Cloud/local provider fallback chains | Core | Partial — **▲ corrected:** Era 1 router falls back before first output and fails closed when cloud is disallowed (one global boolean, not per-task privacy modes) | M6, Era 1 router as reference |
| Voice chat | Core channel | New — confirmed absent | — |

## Extensions and integrations
| Capability | Target | Existing (verified) | Reuse |
|---|---|---|---|
| Extension host (MCP, plugins, connectors, skills) | Core | Partial — Era 2: skills only (Claude `SKILL.md` format, install/add/remove/undo, clean removal); connectors hard-wired. Era 1: MCP client (stdio/HTTP/OAuth), skills, sandboxed extension SDK (QuickJS/WASM) with declared permissions | M1 skeleton; Era 2 skills; Era 1 MCP later |
| Extension manifest + lifecycle (install/enable/remove cleanly) | Core | Partial — Era 1 manifest has permissions, signed bundles, permission-diff on update, uninstall with data removal, but no `on_remove` declaration and two separate manifest formats. Era 2 skills have no manifest | New manifest per CONTRACTS §4 at M1 |
| Agent adapters: Claude Code, Codex, ChatGPT/dots, Gemini, Copilot | Adapters | Partial — Claude path exists (Era 2 `agent_cmd`). Era 1 had a generic ACP stdio adapter host (off by default); no named adapters | M5 |
| Automation adapters: n8n / Zapier / Make (webhooks) | Adapters | Partial — Era 1 has an HMAC-signed generic webhook channel; no n8n integration | M5 |
| Smart-home bridges (Home Assistant, Apple Home via bridges, Scrypted) | Connectors | New — confirmed absent | M5 |
| Gmail connector | Connector | Partial — **▲ corrected:** Era 2 has both Gmail API (OAuth PKCE) and IMAP app-password paths; reads, drafts and organizes, never sends or deletes (enforced in code; the `gmail.modify` scope itself would allow sending). One account | M5 |
| Browser/computer use with human takeover | Capability | **▲ corrected to Have (Era 1, needs porting)** — Era 1 Playwright browser with egress proxy, injection guards, takeover pause/resume and frame stream; screen control with kill key. Not in the current tree | Port at M5 |
| Relay integration | Adapter (last) | Relay itself: Have (v0.8, tested, live-verified 2026-10-24) — stabilize standalone first. **▲ naming hazard:** Era 1's `packages/relay` / `services/relay` is an encrypted transport relay (LOCAL-FIRST §5's optional cloud relay), not the Relay worker service | M8 |

## Product surfaces
| Capability | Target | Existing (verified) | Reuse |
|---|---|---|---|
| PWA client (responsive, posture-aware) | Core | Partial — **▲ corrected:** Era 2 web UI is responsive (breakpoints, mobile drawer, reduced motion) but is **not a PWA** (no manifest, no service worker). Era 1 had manifest + service worker (React app). No posture awareness in either | M3 |
| Design-system packages + hot swap | Core | Partial — Era 2: four token themes, runtime swap with no reload (`data-theme`), `lint:tokens` and `check:themes` (contract + WCAG contrast) in CI. Token names differ from DESIGN-SYSTEM §2; missing `bg/overlay`, `surface/card-hover`, `border/strong`, `accent/secondary`, `status/working`, `status/waiting`, all `orb/*`, `space/8`, most `layout/*`. Not packaged as extensions | M3 |
| Themes with identical features per layout | Core rule | Partial — Era 2 themes change values only. Stellar Map lives in open PR #207, not on `main` | M3 |
| Observability/health UI (errors surfaced in UI) | Core | Partial — **▲ corrected:** the known defect is narrower than stated. Era 2 chat/agent errors and failed scheduled runs *do* reach the UI (alert with details + retry). Still log-only or silent: helper report failures (`src/helpers.js:69`), helper follow-ups (`:99`, `:108`), home git commit failures. `/api/health` only proves the process is up. Era 1 had diagnostics, structured logs and a health page | M1 (health + structured errors), M3 (UI) |
| Setup/onboarding (conversational, fresh-user test) | Core | Partial — **▲ corrected:** Era 2 has no first-run flow (seeds empty files). Era 1 had a resumable form wizard, not a conversation | New conversational setup at M1 |
| Storage (ADR-4: SQLite + plain files) | Core | Partial — **▲ added:** Era 2 is plain files only (markdown + JSONL in a home git repo). Era 1 used Node's built-in `node:sqlite` with forward-only checksummed migrations and a pre-upgrade backup | M1, Era 1 migration design as reference |
| Secrets (vault, referenced by name) | Core | Partial — **▲ added:** Era 2 stores connector secrets as 0600 plaintext files, blocked from file tools but readable via approved `exec`. Era 1 had an encrypted file vault + OS keychain with `secret://` references and redaction | Port Era 1 vault when the first secret-bearing extension lands |

## Explicitly out of Nova core
- Resume/job-search workflows (later workflow on top of connectors).
- WorkLedger timecard/standup generation (later workflow; evidence service may be built standalone first under the registry process).
- Cortex memory protocol (parked research; consume later only if specified).
