# CAPABILITY INVENTORY — target vs. existing

Status key: **Have** (exists and verified) · **Partial** (exists, needs work) · **New** (build) · **Later** (specified, not in early milestones). The builder must verify every "existing" claim against the code before relying on it — this inventory records what was found in review on 2026-10-29, not a guarantee.

## Core loop and platform
| Capability | Target | Existing |
|---|---|---|
| Chat with a swappable agent (`agent_cmd`) | Core, generalized into a provider registry | Partial — Era 2 has the swap point; Era 1 had a fuller hub |
| Multi-agent delegation (brief-in/report-out) | Core task contracts | Partial — Era 2 handoffs mailbox (Claude↔Claude); Relay does this properly for coding workers |
| Work Ledger (durable tasks) | Core | New as a unified system; pieces exist in schedules/handoffs |
| Verification / evidence layer | Core | New (import the evidence model discipline: completed-only, sanitized, no fabrication) |
| Decision journal + calibration | Core | New |
| Trigger engine (reactive/proactive/event/heartbeat) | Core | Partial — Era 2 markdown schedules; no unified engine, no dedup/cooldown layer |
| Long-term memory w/ provenance | Core | Partial — Era 2 file-based home; needs the memory system of NOVA-SPEC §7 |
| Context receipts | Core | New |
| Identity/persona layer (model-independent) | Core | Partial — prompts exist; not yet a governed layer |
| Deliberation + critic pass | Core | New as a mechanism |
| Decision Model Provider (Jev-class System 1) | Pluggable provider | New — hosted API first; local fallback required for local-only mode |
| Decision templates (cached, validated, versioned) | Core mechanism | New |

## Devices, capture, models
| Capability | Target | Existing |
|---|---|---|
| Device pairing (QR / code / command) + hub approval | Core | Partial — Era 1 Ed25519 enrollment (M-series); flows need rebuild to CONTRACTS §5 |
| Device mesh + hub-as-role + failover | Core | Partial — Era 1 hub-and-spoke; failover New |
| Two device agents (boot + runtime, never merged) | Core | New as specified |
| Capture API + Screenpipe ingest | Core API; ingest first | Partial — external Screenpipe in user's stack; Nova-native capture Later |
| Local model management (detect HW, recommend, download, serve) | Core | New (Ollama present in user's lab as an adapter target) |
| Cloud/local provider fallback chains | Core | New as policy-governed mechanism |
| Voice chat | Core channel | New |

## Extensions and integrations
| Capability | Target | Existing |
|---|---|---|
| Extension host (MCP, plugins, connectors, skills) | Core | Partial — Era 2 skills in Claude SKILL.md format; Era 1 extension SDK |
| Extension manifest + lifecycle (install/enable/remove cleanly) | Core | Partial |
| Agent adapters: Claude Code, Codex, ChatGPT/dots, Gemini, Copilot | Adapters | Partial — Claude path exists; others New |
| Automation adapters: n8n / Zapier / Make (webhooks) | Adapters | New |
| Smart-home bridges (Home Assistant, Apple Home via bridges, Scrypted) | Connectors | New in Nova (user runs Scrypted today) |
| Gmail connector | Connector | Partial — Era 2 IMAP |
| Browser/computer use with human takeover | Capability | New; persistence through walls is a requirement, with takeover as the escape hatch |
| Relay integration | Adapter (last) | Relay itself: Have (v0.8, tested, live-verified 2026-10-24) — stabilize standalone first |

## Product surfaces
| Capability | Target | Existing |
|---|---|---|
| PWA client (responsive, posture-aware) | Core | Partial — Era 2 web UI; rebuild to DESIGN-SYSTEM |
| Design-system packages + hot swap | Core | Partial — Era 2 token files + `lint:tokens`/`check:themes` are the seed |
| Themes with identical features per layout | Core rule | Partial — Era 2 themes; Stellar Map is the one sanctioned Nova-theme extra |
| Observability/health UI (errors surfaced in UI) | Core | Partial — Era 2 logs exist; UI surfacing is a known defect to fix |
| Setup/onboarding (conversational, fresh-user test) | Core | Partial |

## Explicitly out of Nova core
- Resume/job-search workflows (later workflow on top of connectors).
- WorkLedger timecard/standup generation (later workflow; evidence service may be built standalone first under the registry process).
- Cortex memory protocol (parked research; consume later only if specified).
