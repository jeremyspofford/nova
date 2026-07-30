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

1. **Builtin store + resolution + MCP integration + Secrets UI. — BUILT
   2026-07-30.** Migration 072, `app/secret_store.py`, resolution in
   `mcp_client` at both call sites, five operator endpoints, and Settings →
   Secrets. Verified: the row holds ciphertext with no recognisable prefix,
   `list_all`/`names` carry no value, a stored MCP header keeps only
   `Bearer {{secret:name}}`, a missing reference RAISES before any request
   goes out, and a resolved token is masked in the ledger both by key name
   and by value shape. `tests/test_secrets.py` pins all of it.

   **Two corrections to this plan, both found by building it:**

   * **The master key must NOT go to `./data/secret.key`.** `/app/data` is the
     container's OVERLAY filesystem — only `data/memory`, `data/wake-training`
     and `data/runtime` are binds. A key written there vanishes on the next
     `docker compose up -d backend` and takes every stored secret with it,
     which is this plan's own "unrecoverable" trap sprung by a routine restart
     rather than by operator error. It now goes to `/state/secret.key`, a
     named volume already holding the per-host instance id.
   * **The generated key is PER HOST**, so a second instance sharing this
     Postgres cannot decrypt these rows. The warning says so, and the UI
     repeats it — a fleet needs `NOVA_SECRET_KEY` set identically everywhere.

   The module is `secret_store.py`, not `secrets.py`: Python has a stdlib
   `secrets`, and shadowing it inside `app/` is a footgun for every later
   import in the package. It matches `settings_store` either way.

   Original scope text follows.

   **(as originally written)** Migration,
   `secrets.py` (create/list/get/decide + `resolve`), AES-GCM with `NOVA_SECRET_KEY`,
   `{{secret:NAME}}` resolution in `mcp_client`, Settings → Secrets. **Verify:** store
   a GitHub PAT as `github_pat`; register the GitHub MCP server with
   `Authorization: Bearer {{secret:github_pat}}`; it connects and lists tools; the
   stored config + the turn trace show only the reference / `•••`, never the token.
   First consumers queued behind this phase (2026-07-24): `{{secret:ha_token}}`
   (`home-assistant.md` C1) and `{{secret:github_pat}}` (`coding-team-pipeline.md`
   T4) — neither token may be stored anywhere in Nova before this lands.
2. **Agent ergonomics + plaintext migration. — BUILT 2026-07-30.**
   `list_secret_names` (names only, granted to main and tool-creator, migration
   073) and the provider-key diversion.

   The migration turned out to be **prevention rather than cleanup**: there
   were zero plaintext keys in `llm_providers` when this shipped — the single
   row was empty and falling back to env. So the work is the NEXT key the
   operator saves. `providers._stash_key` runs on the single write path, so a
   bare key is diverted into the store and the column receives
   `{{secret:provider_<slug>_key}}` — there is no way to save a provider that
   leaves a bare key behind, not through the UI, not through the API, and not
   via a future caller that forgets.

   `resolve_key` and `is_configured` are sync and sit on the router's hot path,
   so they cannot await a decrypt: references are resolved ONCE in `warm()`
   into a memory-only map that is deliberately not folded back into the cached
   row, since `_public` and the API both read from that. A provider whose
   secret has gone reads as UNCONFIGURED with a log line naming the secret —
   not as silently keyless, which would send the operator hunting in the wrong
   place. `key_hint` also stopped showing `ey}}` (the tail of the reference)
   and reports `secret_name` instead.

   Env stays the bootstrap fallback for `OPENROUTER_API_KEY`, unchanged.

   Original scope text follows.

   **(as originally written)** **Agent ergonomics.** A `list_secret_names` builtin (names only) so Nova can
   suggest "store a token named github_pat, then I'll wire it" — and the
   recommendation card for a keyed integration links straight to Settings → Secrets.
   Migrate `openrouter_api_key` to an optional store-backed secret (env stays the
   fallback for bootstrap), and migrate every plaintext `llm_providers.api_key`
   row into the store the same way — the providers table keeps only a secret
   reference and the mig-042 plaintext column is emptied once migrated.
3. **External managers (opt-in). — SEAM BUILT 2026-07-30, CLI managers
   gated.** Migration 074, `secret_store.SOURCES` (one resolver per source
   behind a common signature), `put_external`, source picker in the UI, and a
   reference that is FOLLOWED before saving so a typo fails while the operator
   is still looking at it rather than at 3am from someone else's 401.

   **Two sources are live because they need no new binary and could therefore
   be verified here:** `file` (a path — Docker secrets, Kubernetes secret
   mounts) and `env` (a variable, for bootstrap and CI). Both prove the
   property that matters: `value_enc` is NULL for an external row, so the
   value never enters Nova's database and is asked of the holder at call time.

   **1Password and Bitwarden/Vaultwarden are registered but GATED**, and the
   honest reason is twofold. Neither `op` nor `bw` is in the backend image, so
   they need either those binaries added or a small sidecar to hold them —
   an infrastructure decision. And I have no 1Password service account and no
   Vaultwarden instance to verify against; shipping an unverifiable resolver
   and calling the phase done would be exactly the "reported PASS while doing
   nothing" failure this codebase keeps closing. Selecting one in the UI says
   precisely which command is missing. Adding either is a resolver function
   and nothing else — that is what the seam is for.

   **Rotation nudge — BUILT.** `secrets.rotate_after_days` (default 90, 0 to
   disable), checked daily on the leader's tick. One card per stale secret,
   ONCE: `recommendations.create` refreshes an undecided card with the same
   dedupe key and re-pings the operator's devices, so calling it daily would
   nag about an unchanged secret every day — the sweep skips a dedupe key that
   already exists in any status. Replacing the value changes the date in the
   key, which is a genuinely new card. It never rotates anything: only the
   operator holds the new value.

   Original scope text follows.

   **(as originally written)** **External managers (opt-in).** 1Password + Bitwarden/Vaultwarden resolvers, the
   source picker in the UI, reference validation. **Verify:** a secret sourced from
   1Password resolves at call time with nothing stored in Nova's DB. Tail:
   age-based rotation nudges — a small automation raises a recommendation when a
   secret's `updated_at` passes a threshold (default 90 days, a setting).

## Decisions (defaults chosen; phase 1 can start on the recommendation)

1. **Architecture** — LOCKED (Jeremy, 2026-07-24): built-in encrypted store
   ships first; external managers (1Password, Bitwarden/Vaultwarden) stay
   later opt-in reference-resolvers exactly as phase 3 describes.
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
