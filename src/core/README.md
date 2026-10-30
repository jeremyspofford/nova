# Nova core

The modular-monolith core (ADR-1), in TypeScript that Node runs directly. The design it implements is `docs/builder-packet/`; decisions and deviations are in `docs/LEDGER.md`.

| Module | Does | Contract |
|---|---|---|
| `index.ts` | Composition root and the only public entry. Wires the modules, defines the `/api/v1` routes, health. | — |
| `api.ts` | Route table → request handling and the OpenAPI document; the event stream. | ADR-5 |
| `db.ts` + `migrations/` | SQLite, forward-only checksummed migrations, backup before upgrade. | ADR-4 |
| `log.ts` | JSON-lines log with redaction; problems, which are stored and shown, never only logged. | NOVA-SPEC §8 |
| `envelope.ts` | Brief and Report, validated. | CONTRACTS §1 |
| `ledger.ts` | Work Ledger: tasks, states, events, approval and privacy gates, retries, recovery, lanes (bounded concurrency per worker lane). | WORK-LEDGER |
| `verify.ts` | Checks evidence before done; Nova reads the target itself. Confirmations count only from systems with a registered checker (`createCore({confirmations})`). | WORK-LEDGER |
| `workers.ts` | Worker interface and egress rules. | LOCAL-FIRST §2 |
| `workspace.ts` | The workspace folder and its local worker. | — |
| `profile.ts` | Person-specific records; core ships with none. | PROFILES |
| `identity.ts` | Fixed charter + tunable persona, rendered for any model. | NOVA-SPEC §2, §5 |
| `setup.ts` | First-run setup as a conversation. | PROFILES |
| `extensions.ts` | Manifest validation and lifecycle (install, enable, disable, update, remove). A kind can add its own install checks and veto removal (`defineKind`). | CONTRACTS §4 |
| `design.ts` | Design systems: the token schema (`TOKENS`, `bg/base` → `--bg-base`), package validation in plain words (completeness, value syntax per family, WCAG contrast in every mode, reduced motion, content rules that only tighten, declared extras), CSS generation for light/dark/auto, and which package is applied, for the person or one device, with rollback. Built-ins come from `design-systems/` on every start; Orb Teal is the default. Every change emits `design-system` on the event stream. | DESIGN-SYSTEM, CONTRACTS §8, ADR-12 |
| `decide.ts` | System 1: decision templates (propose, dry runs, activation as a verified ledger task), decision providers (local rules; the remote Jev stub), `decide()` with escalation and the privacy rule. | CONTRACTS §3, ADR-7 |
| `triggers.ts` | The trigger engine: the rule registry, one record per firing, triage, dedup, cooldowns, batching, quiet hours, the heartbeat, webhooks, and proactive messages that always trace to a trigger. | CONTRACTS §6, NOVA-SPEC §4 |
| `memory.ts` | Long-term memory with provenance: remember, correct (supersedes, keeps history), confirm, forget (real deletion of the chain, backups included), search, plain-file export, `importRecord` (keeps an existing id; used to bring in MEMORY.md). `src/memory.js` renders MEMORY.md from it. | CONTRACTS §7 |
| `backups.ts` | Pre-upgrade backups; a forget is carried into every one of them, and a backup that can't be cleaned is destroyed and reported. | Owner's standing order 4 |
| `mesh/wire.ts` | What the hub and devices say and how they prove it: pairing codes and the commit-then-reveal six digits (ported from Era 1), Ed25519 keys and signatures, the key fingerprint, canonical JSON, sealed boxes (X25519 → HKDF-SHA256 → AES-256-GCM), the signed roster, hybrid logical clocks. Imports only `node:crypto`, so the device agent can carry it alone. | CONTRACTS §5 |
| `mesh/identity.ts` | This node's own Ed25519 and X25519 keys, in `home/mesh/identity.json` (0600), never in the database or logs; callers get sign, seal and open. | M4 plan §1 |
| `mesh/devices.ts` | The device registry (the hub included), trust and revocation, device sessions (12 h, stored hashed), `mesh_state`, the signed roster. | CONTRACTS §5 |
| `mesh/enroll.ts` | Enrollment: single-use five-minute codes (hashed), join, reveal, the six digits, tier-3 approval, signed status polls, rate limits, expiry. | CONTRACTS §5 |
| `mesh/access.ts` | Who is asking, on every request: the console (loopback, addressed to loopback, no proxy, console listener), a paired device by session (cookie or bearer) with its kind's scope, or public. Cuts a revoked device's open streams. | M4 plan §0 |
| `mesh/spokes.ts` | Computers' device agents, hub side (M4b): heartbeats (Online by recency, versions, safe mode as a problem), the inbox (each idempotency key taken in once, in order: tasks or refusals kept with the request, memory as `device:<id>`, server-wins config, capture events through `capture/` with only their id kept here), reports, the challenge a node signs (`/mesh/hello/proof`), the signed runtime bundle. Its two tables are migration 0007's; `device_inbox` replicates, so exactly-once holds across a failover. | M4 plan §2 |
| `mesh/agent.ts` | What the hub ships to a computer: `join.sh`, `device-agent.tar` (a hand-written ustar of `src/device/**`, `mesh/wire.ts` and a package.json) and the runtime bundle's files. | M4 plan §2 |
| `mesh/limiter.ts` | A sliding-window rate limiter per client address (ported from Era 1). | — |
| `mesh/sync.ts` | The sync log (migration 0006's triggers record every replicated table, one entry per row, the newest), the journal of the home's files, serving the log in batches, applying a batch on a standby with the hub's seq, and dropping what a forgotten memory left in the log. | M4 plan §3, standing order 4 |
| `mesh/replica.ts` | The standby: `mesh/role.json` (read tolerantly, written on promotion), and the puller: a session with the hub, `GET /mesh/sync` sealed to its key, apply, ack; noticing the hub is gone (and, only if turned on, failing over). | M4 plan §3 |
| `mesh/promote.ts` | Which node is hub: the role decided before anything writes, replica mode's refusal, the hub's side of sync and the standby's lag, promotion (epoch + 1, a roster signed by its own key, work started, the ledger recovered, a verified ledger record), and fencing (stepping down for a higher epoch a trusted peer proves). | ADR-11, M4 plan §3 |
| `vault.ts` | Secrets by name (`secret://connector/<id>/<NAME>`), AES-256-GCM at rest in `home/vault/`; the key in the OS keychain or a 0600 file (said plainly); values redacted by value (log.ts); replicated to a standby sealed in the sync batch, never the key in a sync log. | M5 plan §2 |
| `connectors/index.ts` | The connector kind: manifest in the extension host while connected, secrets in the vault, events as event trigger records for what a rule listens to, Disconnect and removal revoke at the service and delete secrets, rules and settings. Hub only. | EXTENSION-MODEL, M5 plan §2 |
| `connectors/home-assistant.ts` | Home Assistant: states (tier 0), service calls as ledger tasks at tier 2 or 3 verified by Nova's read-back, state changes over the WebSocket API, egress local or remote by address. | NOVA-SPEC §6, M5 plan §2 |
| `browser/cdp.ts` | A small Chrome DevTools Protocol client over Chromium's debugging pipe (no port, no Playwright). | M5 plan §3 |
| `browser/chromium.ts` | Finding Chromium (`NOVA_CHROMIUM`, `CHROMIUM`, known paths; plainly when none) and starting it with a fresh profile per task. | M5 plan §3 |
| `browser/plan.ts` | A browser task's plan: steps, declared hosts (`allowed`), where its data goes (`planEgress`). | M5 plan §3 |
| `browser/session.ts` | One task's browser: every request held to the declared hosts (CDP Fetch, a refusing proxy behind it), the live screencast, takeover and the person's input. The worker waits at `gate()` while someone holds it. | M5 plan §3 |
| `browser/worker.ts` | The `browser` ledger worker: runs a plan, asks for a person at a `person` step (Needs you), records takeovers and refusals, takes its evidence. | M5 plan §3, WORK-LEDGER |
| `browser/evidence.ts`, `browser/routes.ts` | The `screenshot` and `url` checkers (Nova's own reads, in `workers/browser/<task>/`); `/api/v1/browser/*` (takeover, input and hand-back for approvers only). | M5 plan §3 |
| `capture/capture.ts` | The Capture API (M6a): sources and consent (off by default, per source and device; pause), one `ingest` for every adapter (private contexts dropped, exclusions, classification), `stream(device, kind)` and the views, forgetting (write-ahead log, backups, a tombstone; the standby by sync), retention, promotion with provenance, proposals from a triage decision that only propose, event-rule topics, the hub's pass (pull, sweep, triage). Settings in profile section `capture`. | CONTEXT-AND-CAPTURE, CONTRACTS §7 |
| `capture/rules.ts` | What is never stored (private windows; exclusions by app, site, space, time window) and which space an event belongs to, only by the person's signals; ambiguous stays unclassified. Pure. | CONTEXT-AND-CAPTURE |
| `capture/screenpipe.ts`, `capture/routes.ts` | The Screenpipe-compatible pull adapter (`/health`, `/search` for OCR, audio and UI text; its own cursor; down is a status, not a crash); `/api/v1/capture/*` (and `POST /capture/tick` under `NOVA_TEST_CLOCK`). | M6 plan §1 |
| `receipts.ts` | Context receipts: what each model call was told and where it went; the egress log; local-only violations refused as problems. | CONTRACTS §2 |
| `providers/registry.ts` | The provider registry (M5a): agent- and automation-adapter extensions (built-ins `claude-code`, `codex`, `openai-compatible`, `custom-cli`, `n8n`; a manifest's `adapter` block picks one of these implementations, never code it ships). Each enabled one is a ledger worker: privacy-gated by its egress (an HTTP provider's address decides), a receipt per call, Nova's own checks as evidence, results copied back after verification. Health in plain words, the chat model and per-class defaults (recommended, not listed), the n8n callback on the token webhook. `/api/v1/providers`. | M5 plan §1 |
| `providers/{claude-code,codex,openai,custom-cli,n8n}.ts` | The adapters: each CLI's JSON event stream, the OpenAI-compatible API (fetch + SSE, Era 1 port), Era 2's agent_cmd, n8n's signed webhook both ways. | ADR-8 |
| `providers/{taskspace,checks,prompt,cli}.ts` | The per-task folder (copy-in, baseline, diff, copy-back, the JSON files contract's path checks), Nova's own test run and diff check, what a provider is told, starting a command without a shell. | WORK-LEDGER |

Outside `/api/v1`, the server answers `GET /design-system.css?device=` with the applied design system as CSS variables; pages fetch it again when the `design-system` event arrives, so a change needs no reload or restart. The generated CSS carries the schema tokens and nothing else; Era 2's temporary aliases are gone (`docs/LEDGER.md`, M3b).

Every request goes through `mesh/access.ts` first (`core.gate` outside `/api/v1`; each route's `access` scope inside it: `public`, `person` (the default), `approver`, `device`, `sync`, `mesh`). With no mesh listener configured, the console is exactly what it was before M4. On a standby (or a hub that stepped down), `core.gate` also refuses every change except `POST /api/v1/mesh/promote` with 409 and the reason, for the core's routes and Era 2's alike.

Every change through the API needs the `X-Nova` header, except `POST /api/v1/hooks/{name}`: webhooks are called by automations and authenticate with their own `x-nova-hook-token` instead. That is the only exemption, and `api.ts` refuses any other route that claims it.

Rules: modules get what they need passed in; nothing outside `src/core` imports anything but `index.ts` (tested), except the device agent in `src/device`, which ships alone and imports only `mesh/wire.ts`; source stays erasable TypeScript (no enums, namespaces or parameter properties) so Node can run it without a build.

The fresh-user acceptance test (`tests/acceptance/fresh-user.test.ts`) runs the real server with a blank home and an egress tripwire; `NOVA_EVIDENCE=<file> npm test` keeps its transcript.
