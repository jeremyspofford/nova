# Nova core

The modular-monolith core (ADR-1), in TypeScript that Node runs directly. The design it implements is `docs/builder-packet/`; decisions and deviations are in `docs/LEDGER.md`.

| Module | Does | Contract |
|---|---|---|
| `index.ts` | Composition root and the only public entry. Wires the modules, defines the `/api/v1` routes, health. | — |
| `api.ts` | Route table → request handling and the OpenAPI document; the event stream. | ADR-5 |
| `db.ts` + `migrations/` | SQLite, forward-only checksummed migrations, backup before upgrade. | ADR-4 |
| `log.ts` | JSON-lines log with redaction; problems, which are stored and shown, never only logged. | NOVA-SPEC §8 |
| `envelope.ts` | Brief and Report, validated. | CONTRACTS §1 |
| `ledger.ts` | Work Ledger: tasks, states, events, approval and privacy gates, retries, recovery. | WORK-LEDGER |
| `verify.ts` | Checks evidence before done; Nova reads the target itself. | WORK-LEDGER |
| `workers.ts` | Worker interface and egress rules. | LOCAL-FIRST §2 |
| `workspace.ts` | The workspace folder and its local worker. | — |
| `profile.ts` | Person-specific records; core ships with none. | PROFILES |
| `identity.ts` | Fixed charter + tunable persona, rendered for any model. | NOVA-SPEC §2, §5 |
| `setup.ts` | First-run setup as a conversation. | PROFILES |
| `extensions.ts` | Manifest validation and lifecycle (install, enable, disable, remove). | CONTRACTS §4 |

Rules: modules get what they need passed in; nothing outside `src/core` imports anything but `index.ts` (tested); source stays erasable TypeScript (no enums, namespaces or parameter properties) so Node can run it without a build.

The fresh-user acceptance test (`tests/acceptance/fresh-user.test.ts`) runs the real server with a blank home and an egress tripwire; `NOVA_EVIDENCE=<file> npm test` keeps its transcript.
