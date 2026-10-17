# Contracts — Source of Truth

`contracts/` defines every boundary in the system. **If code and a contract disagree, the
contract wins** — fix the code or amend the contract with an ADR (`docs/20`).

## Files

| File | Boundary |
| --- | --- |
| [`hub-api.md`](hub-api.md) | Client ↔ Hub (REST, streams, server-to-client requests, `/api/v1/hello` handshake), Hub ↔ Node, Hub ↔ `novad`, shell ↔ local `novad` |
| [`ipc-channels.md`](ipc-channels.md) | Native-shell internal IPC (renderer ↔ shell main), including native-only capture, dictation and shortcut channels |
| [`events.md`](events.md) | Event envelope + event catalog (UI, persistence, Activity, audit) |
| [`rest-api.md`](rest-api.md) | Optional server APIs (relay framing and pairing, sync, catalog, cloud runner) |
| [`schemas/`](schemas/) | JSON Schemas for persisted/transported objects ([index](schemas/README.md)) |

`hub-api.md` is the primary boundary in the hub-and-spoke model. `ipc-channels.md` applies only
inside a native shell (the web UI served by the Hub is not an Electron renderer).

## Conventions

- **Naming**: `domain.action` for IPC and events (e.g., `chat.send`, `run.step.completed`).
- **Validation**: every payload is validated with a Zod schema generated from / kept in sync
  with the JSON Schemas here. Invalid payloads are rejected and logged, never executed.
- **Versioning**: each contract carries a `schemaVersion`. Breaking changes bump it and
  provide a migration or a compatibility shim for one release. Clients negotiate protocol
  versions, server-request kinds and experimental features in `/api/v1/hello`
  (`hub-api.md` §7, ADR-072).
- **Errors**: a uniform error shape:
  ```json
  { "code": "rate_limited", "message": "Provider rate limit reached.",
    "retryable": true, "details": { "retryAfter": 12 }, "traceId": "..." }
  ```
- **IDs**: UUIDv7 strings, sortable by time.
- **Timestamps**: UTC ISO-8601 with milliseconds (`2026-10-16T19:49:00.123Z`).
- **Secrets**: never appear in any contract payload; only opaque `secretRef` strings
  (`secret://...`). Tokens issued to clients are shown once and stored only as hashes.
- **Listeners**: every listener requires a token or certificate; loopback is never
  authorization (FR-192, ADR-075).

## Contract testing

- `packages/shared` contains the authoritative Zod schemas.
- `contracts/schemas/*.json` are generated from those schemas (or validated against them) and
  checked in CI; drift fails the build.
- Every IPC handler and every event producer/consumer has a contract test using the shared
  schemas.
- Server APIs have OpenAPI documents generated from the same schemas; `rest-api.md` summarizes
  endpoints and links to the generated spec.
