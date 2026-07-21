# Secrets management — a place for tokens Nova needs, without leaking them

Implementation plan (authored 2026-07-21 with Opus, at Jeremy's request). Goal:
give Nova a proper home for the credentials her integrations need — a GitHub PAT
for the GitHub MCP server, API keys for keyed tools, etc. — that is encrypted at
rest, referenced by name (never pasted into agent-visible config), resolved only
at the outbound call, and never shown to the model or the trace ledger.

Prompted concretely by the keystone's first recommendation ("Add the GitHub MCP
server"), which Nova correctly flagged: it needs a GitHub token, "worth thinking
about how secrets are managed since we have the no-secret-in-requests guardrail."

## What exists (verified in code, 2026-07-21)

- **MCP auth headers are stored PLAINTEXT** — `mcp_servers.headers JSONB` (migration
  031). A GitHub token dropped in there today sits unencrypted in Postgres, and is
  passed straight to the client: `mcp_client.connect_and_list` does
  `headers = server.get("headers")` → `streamablehttp_client(url, headers=headers)`.
  This is the concrete gap.
- **Provider keys live in env/config** — `config.openrouter_api_key` from `.env`
  ("Env here is infra bootstrap + secrets only"). Fine for one bootstrap key; it
  doesn't scale to per-integration tokens the operator manages at runtime.
- **The "no-secret-in-requests guardrail" = trace redaction** (`trace.py`): span
  args/results are scrubbed by key-name (`token|secret|password|api_key|
  authorization|bearer|credential|private_key`) and value-shape (`Bearer …`,
  `sk-…`, JWTs) before storage. Secrets already stay out of the observability
  ledger — the resolution design below must keep it that way.
- **No secret store, no secrets UI** — the prior intent ("admin secrets UI over
  capability_credentials; no Vaultwarden *mirror*", [[nova-identity-decisions]])
  was never built. This plan builds it, and reconciles the external-manager
  question Jeremy reopened.
- Product fit ([[nova-product-principles]]): batteries-included, privacy-first,
  local-first; keyed/external services are opt-in extras. That shape drives the
  recommendation below: a built-in store by default, external managers optional.

## Design

### The core idea: reference, resolve late, never expose

1. **Store** secrets in an encrypted `secrets` table, keyed by a short name.
2. **Reference** them in config by name — an MCP header becomes
   `{"Authorization": "Bearer {{secret:github_pat}}"}`. The stored config holds the
   *reference*, never the value. The DB stops holding plaintext tokens.
3. **Resolve** `{{secret:NAME}}` only at the moment of the outbound call, in the
   backend, just before it's needed. The agent/LLM sees the reference; the trace
   redaction masks the resolved header; the value exists in memory for the length
   of one request.
4. **Never** hand a resolve capability to an agent. Agents may *list secret names*
   (so they can wire a reference) but the value path is backend-only.

### Data model (new migration — check `backend/app/migrations/` for next free number)

```sql
secrets (
  name        text primary key,     -- 'github_pat', 'exa_api_key' (slug)
  source      text not null default 'builtin',  -- builtin | 1password | bitwarden | vaultwarden
  value_enc   bytea,                -- builtin: authenticated-encrypted value; null for external
  ref         text,                 -- external: e.g. 'op://Private/GitHub/token'; null for builtin
  description text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  last_used_at timestamptz
)
```

### Encryption at rest (builtin source)

- Authenticated symmetric encryption (AES-GCM / Fernet) with a 32-byte master key.
- Master key from **`NOVA_SECRET_KEY`** in `.env` (infra bootstrap secret — the one
  place env is right for secrets). If unset: **dev fallback** generates one and
  persists it to `./data/secret.key` (0600) with a loud startup warning that
  production must set an env key. The DB ciphertext is worthless without the key.
- **Trap made explicit**: lose the key → secrets are unrecoverable (by design).
  The Secrets UI says so; export/rotate is a later nicety.

### Resolution layer

- `secrets.resolve(text_or_dict)` replaces every `{{secret:NAME}}`:
  - **builtin** → decrypt `value_enc`.
  - **external** → fetch via the manager (below).
  - unknown name → hard error surfaced to the operator (never a silent empty
    string that turns into a broken, confusing auth failure).
- Called in `mcp_client` before connect (headers + any URL creds), and wherever
  else an outbound integration needs a secret. Stamps `last_used_at`.
- Resolved values are never logged; they inherit the existing trace redaction
  because the carrying keys already match `_SECRET_KEY` (`authorization`, etc.).

### Admin Secrets UI (Settings → Secrets, reachable by navigation)

- List: name, source, description, "last used", **masked** value (`•••`), with a
  reveal-on-click that requires the operator (never rendered to agents).
- Add/edit/delete. For builtin: paste the value (encrypted on save, never returned
  in full afterward — reveal re-fetches deliberately). For external: pick the
  manager + enter the reference (`op://…`, item id, etc.).
- A "used by" hint (which MCP servers/tools reference this name) so deleting a
  live secret warns first.

### External managers (opt-in — "reference, don't mirror")

The prior decision rejected *mirroring* a vault into Nova; this keeps that. An
external secret's **value never enters Nova's DB** — only the reference does, and
Nova asks the manager at call time:
- **1Password** — the `op` CLI (`op read op://vault/item/field`) with a service
  account token. Best-in-class if the operator already uses it.
- **Bitwarden / Vaultwarden** — the `bw` CLI or the Vaultwarden REST API
  (Bitwarden-compatible, self-hostable — the privacy-first option, and Vaultwarden
  could later be an optional bundled compose profile for a truly batteries-included
  self-hosted vault).
Each is a small resolver behind a common interface; unavailable manager → clear
error, builtin secrets keep working.

## Phases (each ends live-verified; changes left uncommitted, summarized)

1. **Builtin store + resolution + MCP integration + Secrets UI.** Migration,
   `secrets.py` (create/list/get/decide + `resolve`), AES-GCM with `NOVA_SECRET_KEY`,
   `{{secret:NAME}}` resolution in `mcp_client`, Settings → Secrets. **Verify:** store
   a GitHub PAT as `github_pat`; register the GitHub MCP server with
   `Authorization: Bearer {{secret:github_pat}}`; it connects and lists tools; the
   stored config + the turn trace show only the reference / `•••`, never the token.
2. **Agent ergonomics.** A `list_secret_names` builtin (names only) so Nova can
   suggest "store a token named github_pat, then I'll wire it" — and the
   recommendation card for a keyed integration links straight to Settings → Secrets.
   Migrate `openrouter_api_key` to an optional store-backed secret (env stays the
   fallback for bootstrap).
3. **External managers (opt-in).** 1Password + Bitwarden/Vaultwarden resolvers, the
   source picker in the UI, reference validation. **Verify:** a secret sourced from
   1Password resolves at call time with nothing stored in Nova's DB.

## Decisions (defaults chosen; phase 1 can start on the recommendation)

1. **Architecture** — built-in encrypted store as the default (ships, offline,
   private), external managers as opt-in resolvers (recommended). Alternatives:
   built-in only (simplest), or bundle a manager (Vaultwarden profile). Jeremy's
   call — surfaced as a question alongside this plan.
2. **Master key when `NOVA_SECRET_KEY` unset** — dev fallback generates + persists
   to `./data/secret.key` with a loud warning (default), vs fail-closed (no secret
   storage until a key is set). Default: dev-fallback, warn hard.
3. **Which external managers first** — 1Password and Vaultwarden/Bitwarden are the
   plan's targets; confirm priority if going that route.

## Traps / risks

- **Master-key loss = unrecoverable secrets.** State it in the UI; never bury it.
- **Resolve as late as possible, log never.** The value lives for one request; it
  must not land in a stored config, a log line, or an un-redacted trace. Add a test
  that a resolved header is masked in the span.
- **Agents get names, never values.** `list_secret_names` is fine; a `read_secret`
  tool is not — resolution is backend-only, or the whole guardrail is theatre.
- **Unknown reference fails loud**, never silently empty (a blank `Bearer ` is a
  baffling 401 later).
- **External CLI availability / auth** (op/bw session) is the operator's setup;
  surface a clear "manager unreachable" instead of a cryptic failure, and keep
  builtin secrets working regardless.
- **Migration off plaintext**: existing plaintext MCP headers should be detected and
  the operator nudged to move the token into a secret (don't silently keep serving
  plaintext).
```
