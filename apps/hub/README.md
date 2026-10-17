# @nova/hub

The Hub (FR-124): the always-on service that owns the database, serves the web UI and the API,
and streams events. M0 provides first-run setup (a one-time code printed on the console is
exchanged for an HttpOnly session cookie), token-guarded API routes with Host and Origin checks
(FR-192), settings with precedence (`docs/14` §1), and persisted events over SSE and WebSocket.

```bash
npm run build                     # builds apps/web, which the Hub serves
node apps/hub/src/main.ts         # http://127.0.0.1:7419 (falls back to the next free port)
node apps/hub/src/main.ts code    # print a new one-time setup code
```

Options: `--port`, `--host`, `--data-dir` (or `NOVA_PORT`, `NOVA_HOST`, `NOVA_DATA_DIR`).

M1 adds chat (FR-017, FR-018, FR-021, FR-023): provider accounts with keys in the encrypted vault
(`<dataDir>/secrets.vault`, key file `<dataDir>/vault.key`), models, threads, messages with
attachments, cancel, search, attachments download and a per-thread SSE stream. Routes are listed
in `contracts/hub-api.md` §1; the services live in `@nova/core`. On start the Hub marks replies
that were streaming during a crash as incomplete, and a new owner gets a "Mock (offline)"
provider so chat works with no network.
