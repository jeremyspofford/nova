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
| `mesh/spokes.ts` | Computers' device agents, hub side (M4b): heartbeats (Online by recency, versions, safe mode as a problem), the inbox (each idempotency key taken in once, in order: tasks or refusals kept with the request, memory as `device:<id>`, server-wins config), reports, the challenge a node signs (`/mesh/hello/proof`), the signed runtime bundle. Its two tables are migration 0007's; `device_inbox` replicates, so exactly-once holds across a failover. | M4 plan §2 |
| `mesh/agent.ts` | What the hub ships to a computer: `join.sh`, `device-agent.tar` (a hand-written ustar of `src/device/**`, `mesh/wire.ts` and a package.json) and the runtime bundle's files. | M4 plan §2 |
| `mesh/limiter.ts` | A sliding-window rate limiter per client address (ported from Era 1). | — |
| `mesh/sync.ts` | The sync log (migration 0006's triggers record every replicated table, one entry per row, the newest), the journal of the home's files, serving the log in batches, applying a batch on a standby with the hub's seq, and dropping what a forgotten memory left in the log. | M4 plan §3, standing order 4 |
| `mesh/replica.ts` | The standby: `mesh/role.json` (read tolerantly, written on promotion), and the puller: a session with the hub, `GET /mesh/sync` sealed to its key, apply, ack; noticing the hub is gone (and, only if turned on, failing over). | M4 plan §3 |
| `mesh/promote.ts` | Which node is hub: the role decided before anything writes, replica mode's refusal, the hub's side of sync and the standby's lag, promotion (epoch + 1, a roster signed by its own key, work started, the ledger recovered, a verified ledger record), and fencing (stepping down for a higher epoch a trusted peer proves). | ADR-11, M4 plan §3 |
| `receipts.ts` | Context receipts: what each model call was told and where it went; the egress log; local-only violations refused as problems. | CONTRACTS §2 |

Outside `/api/v1`, the server answers `GET /design-system.css?device=` with the applied design system as CSS variables; pages fetch it again when the `design-system` event arrives, so a change needs no reload or restart. The generated CSS carries the schema tokens and nothing else; Era 2's temporary aliases are gone (`docs/LEDGER.md`, M3b).

Every request goes through `mesh/access.ts` first (`core.gate` outside `/api/v1`; each route's `access` scope inside it: `public`, `person` (the default), `approver`, `device`, `sync`, `mesh`). With no mesh listener configured, the console is exactly what it was before M4. On a standby (or a hub that stepped down), `core.gate` also refuses every change except `POST /api/v1/mesh/promote` with 409 and the reason, for the core's routes and Era 2's alike.

Every change through the API needs the `X-Nova` header, except `POST /api/v1/hooks/{name}`: webhooks are called by automations and authenticate with their own `x-nova-hook-token` instead. That is the only exemption, and `api.ts` refuses any other route that claims it.

Rules: modules get what they need passed in; nothing outside `src/core` imports anything but `index.ts` (tested), except the device agent in `src/device`, which ships alone and imports only `mesh/wire.ts`; source stays erasable TypeScript (no enums, namespaces or parameter properties) so Node can run it without a build.

The fresh-user acceptance test (`tests/acceptance/fresh-user.test.ts`) runs the real server with a blank home and an egress tripwire; `NOVA_EVIDENCE=<file> npm test` keeps its transcript.
