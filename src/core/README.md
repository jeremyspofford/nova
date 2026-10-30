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
| `receipts.ts` | Context receipts: what each model call was told and where it went; the egress log; local-only violations refused as problems. | CONTRACTS §2 |

Outside `/api/v1`, the server answers `GET /design-system.css?device=` with the applied design system as CSS variables; pages fetch it again when the `design-system` event arrives, so a change needs no reload or restart. The generated CSS carries the schema tokens and nothing else; Era 2's temporary aliases are gone (`docs/LEDGER.md`, M3b).

Every change through the API needs the `X-Nova` header, except `POST /api/v1/hooks/{name}`: webhooks are called by automations and authenticate with their own `x-nova-hook-token` instead. That is the only exemption, and `api.ts` refuses any other route that claims it.

Rules: modules get what they need passed in; nothing outside `src/core` imports anything but `index.ts` (tested); source stays erasable TypeScript (no enums, namespaces or parameter properties) so Node can run it without a build.

The fresh-user acceptance test (`tests/acceptance/fresh-user.test.ts`) runs the real server with a blank home and an egress tripwire; `NOVA_EVIDENCE=<file> npm test` keeps its transcript.
