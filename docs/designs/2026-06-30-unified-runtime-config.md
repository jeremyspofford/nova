# Unified Runtime Config — UI as the Source of Truth

**Status:** Draft for review
**Date:** 2026-06-30
**Author:** Nova / Jeremy
**Motivating incident:** local inference broken for ~a day by a stale
`nova:config:inference.url=http://localhost:11434` that survived in the Redis
dump and outranked `.env`, pointing the gateway container at itself → silent
500 on every agent call. See Appendix A.

---

## 1. Problem

Nova's runtime configuration is spread across **five stores with inconsistent
precedence and multiple writers**. The Settings UI feels like "hope-config that
doesn't work" because a value set in one place is silently overridden by
another, and stale values resurrect across restarts.

The stores today:

| Store | Read by | Written by | Lifecycle |
|---|---|---|---|
| `.env` | every service (pydantic `Settings`) at startup | human / `install` | restart to apply |
| Redis `nova:config:*` (db1, +5/6/8) | gateway, memory, cortex, intel, knowledge, voice, screenpipe | `config_sync.py`, recovery service, gateway migration | bind-mounted dump persists |
| Postgres `platform_config` | orchestrator + `config_sync` | dashboard (admin API) | durable |
| Postgres `platform_secrets` | gateway, chat-bridge, orchestrator | dashboard | durable, encrypted |
| `feature_flags` (PG + Redis pubsub) | all services | dashboard | durable + live invalidate |

### Why it breaks

1. **Precedence is per-namespace and contradictory.** `config_sync.py` has eight
   near-identical `sync_*_to_redis()` functions. Seven overwrite Redis from the
   DB on boot (DB wins). But `sync_inference_config_to_redis()` is **inverted** —
   it only fills missing keys and *preserves existing Redis values* "because the
   recovery service writes backend choices directly to Redis (not DB)." So for
   `inference.*`, **stale Redis wins over both DB and `.env`.** That is the exact
   path that broke (Appendix A).
2. **Three writers, no single owner.** Dashboard → `platform_config` (DB).
   Recovery service → Redis directly. Gateway startup → Redis directly (the
   `llm.ollama_url → inference.url` migration). Nothing reconciles them.
3. **Redis is treated as a source of truth, not a cache.** Its bind-mounted dump
   persists stale values across reboots, so a wrong value set once resurrects
   forever.
4. **No validation.** `inference.url=localhost:11434` is meaningless inside a
   container, but nothing rejects it — the failure surfaces as a runtime 500,
   not a write-time error.
5. **`.env` is overloaded.** It mixes true bootstrap secrets (`POSTGRES_PASSWORD`,
   `CREDENTIAL_MASTER_KEY`) with runtime knobs the UI also edits, so neither is
   authoritative.

## 2. Goals / Non-goals

**Goals**
- One source of truth for runtime config: the **Settings UI**, backed by Postgres.
- A single, documented precedence order — no per-namespace special cases.
- Writes are validated and take effect live (no restart, no resurrection).
- `.env` reduced to bootstrap-only.
- Reuse what already works (the `feature_flags` pattern) rather than invent.

**Non-goals**
- Changing how **secrets** work (`platform_secrets` stays as-is — encrypted, separate).
- A general distributed config service. This is single-instance Nova.
- Keeping `feature_flags` as a separate system. Per review (2026-06-30) it is
  **retired** and folded into this registry — see §3.7.

## 3. Proposed design — generalize the feature-flags pattern

`feature_flags` already is the architecture we want: **Postgres = truth, Redis =
pubsub-invalidated cache, a typed in-code registry, and a resolver with a fixed
precedence.** We extend it to all runtime config.

### 3.1 Single source of truth + cache
- **`platform_config` (Postgres) is the only source of truth** for runtime config.
- **Redis `nova:config:*` becomes a pure derived cache** — rebuilt from Postgres,
  never authoritative. On any write, the orchestrator updates the DB and emits a
  `nova:config:invalidate` pubsub (reuse `feature_flags_pubsub.PubsubSubscriber`);
  caches re-warm from the DB via an HTTP endpoint (reuse
  `warm_cache_from_http`). A stale dump can no longer override truth because the
  cache is rebuilt from the DB on connect.

### 3.2 Typed config registry (`ConfigDef`)
Mirror `FlagDef`. Each runtime key is declared once in code:

```python
INFERENCE_URL = register_config(
    key="inference.url",
    type="str",
    default="",                     # empty => fall back to OLLAMA_BASE_URL bootstrap
    scope="runtime",                # runtime | bootstrap
    consumers=["llm-gateway"],      # which service Redis dbs to fan out to
    validate=validate_reachable_ollama_url,   # write-time guard
    description="Local inference endpoint the gateway uses.",
)
```

The registry replaces the eight copy-pasted `sync_*_to_redis()` functions with
**one** generic fan-out driven by `consumers`.

### 3.3 Fixed resolution order (every service, every key)

1. Redis cache (`nova:config:<key>`) — the warm, pubsub-invalidated copy of the DB.
2. Postgres `platform_config` on cache miss.
3. Registered in-code `default`. For a few infra keys the default defers to a
   bootstrap `.env` value (e.g. `inference.url`'s default reads `OLLAMA_BASE_URL`),
   the floor when the DB has no row.

No namespace gets a different order. The `inference.*` "Redis wins" inversion is
**deleted**. Per decision 4 there is **no per-key env override** — the DB is the
single editable source of truth, and write-time validation (§3.5) keeps a bad
value from ever being saved, so no boot-time escape hatch is needed.

### 3.4 One writer
- The **dashboard is the only writer** of runtime config, via the orchestrator
  admin API (`PATCH /api/v1/config`), which: validates → writes DB → invalidates cache.
- **Recovery service stops writing Redis directly**; it calls the same admin API
  (or a service-authed variant) so the DB stays authoritative.
- The **gateway `llm.ollama_url → inference.url` migration is removed** (its job is
  done; keeping it is a resurrection vector).

### 3.5 Validation + reachability (decision 2: two layers)
Reachability is the **gateway's** truth, not the orchestrator's — different
containers, different network paths — so an orchestrator-side write probe can
give a false pass/fail, and a backend may be legitimately down at save time.
Therefore:

1. **Write-time sanity validation** (`ConfigDef.validate=`) hard-rejects the
   *deterministically* wrong with a clear UI error: for `inference.url`, reject
   `localhost`/`127.0.0.1`/`::1` (the consumer is containerized, so loopback is
   broken by definition), non-http(s) schemes, malformed URLs. This one rule
   would have prevented Appendix A.
2. **Gateway-owned reachability**, surfaced as UI status (not a save gate): the
   gateway probes at startup + on health and exposes `inference: ok | unreachable
   at <url>`; Settings shows it prominently and chat/cortex surface "local
   inference unreachable" instead of a silent 500.

"Saved" means "valid", not "confirmed reachable" — reachability is a live status
the operator can see.

### 3.6 `.env` demoted to bootstrap-only
`.env` keeps only what must exist before the DB is reachable:
`POSTGRES_PASSWORD`, `CREDENTIAL_MASTER_KEY`, `NOVA_ADMIN_SECRET`, ports,
`*_DATA_DIR`, `COMPOSE_PROFILES`, `NOVA_GPU`. Everything the UI edits moves to
`platform_config`. A one-time migration imports current `.env` runtime values,
after which runtime keys in `.env` are ignored (with a startup WARN if set).

### 3.7 Retire `feature_flags` as a separate system
Per review, the feature-flag system is noise for a single-user instance and is
**absorbed into this registry**, not kept as a sibling:
- A flag is just a `bool` `ConfigDef`; `register_flag(...)` collapses into
  `register_config(type="bool", ...)`.
- **Kill switches removed entirely** (2026-06-30): all five `kill.*` flags
  (`kill.engram.ingestion`, `kill.consolidation.cycle`,
  `kill.cortex.thinking_loop`, `kill.intel_worker.poll`,
  `kill.knowledge_worker.crawl`) are deleted — those subsystems now run
  unconditionally. The two `pipeline.*` strict-mode toggles remain as ordinary
  bool config (kept `critical` for the confirm gate until the flag system fully
  retires).
- **Deleted:** the `feature_flags` / `feature_flag_audit` tables (migrations
  083/085), the four-file SDK (`feature_flags*.py`), actor-IP/UA/request-id audit
  metadata, the `PUBLIC_FLAGS` allowlist endpoint, the per-service partition
  fallback files (`data/flag-cache/*.json`), and the dashboard
  `FeatureFlagsSection`.
- **Kept and generalized:** the pubsub-invalidate + cache-warm SDK they
  introduced — it becomes the cache layer in §3.1.

### 3.8 Audit trail (decision 1)
Config changes are recorded as full history, not just `updated_at`. The
`platform_config_audit` table **already exists** (migration 031:
`id, config_key, old_value, new_value, changed_by, changed_at`, indexed by
`(config_key, changed_at)`) — it was just unwired: only the tool-permissions
endpoint wrote to it, and even that skipped `changed_by`.

The plan routes **every** config write through it: `PATCH /api/v1/config/{key}`
captures the old value and inserts an audit row (old → new) in the **same
transaction** as the upsert, so history can't drift from state. `changed_by`
carries the actor (an agent's user id, or NULL for admin-secret/system writes);
a later pass widens actor detail once writes are centralized. Settings can then
show "last changed by X at Y" and a per-key history view.

## 4. Migration plan (phased, non-breaking)

1. **Registry + audit + generic sync.** Introduce `register_config`/`ConfigDef`
   and a single registry-driven fan-out; wire the existing `platform_config_audit`
   table into the config write path (§3.8). Re-express existing keys; keep the
   old `sync_*` functions delegating to the generic fan-out. No read-path change
   yet. *(Audit wiring landed first — 2026-06-30.)*
2. **Fix precedence.** Make Redis a rebuilt-on-connect cache; delete the
   `inference.*` inversion and the gateway migration; route recovery's writes
   through the admin API. (Resolves the incident class.)
3. **Validation.** Add `validate=` hooks; wire reachability checks for inference.
4. **`.env` demotion.** Import runtime keys into `platform_config`; mark `.env`
   runtime keys deprecated; emit WARN when set. *(Incremental slice landed —
   2026-07-01.)* An orchestrator boot pass (`_reconcile_demoted_env` +
   `config_demotion.py`) imports demoted runtime keys into `platform_config`
   when the DB row is missing, then WARNs for every key still set in the `.env`
   **file** (parsed directly — compose injects a default for every `${VAR:-…}`,
   so `os.environ` can't tell an operator value from a fallback) whose value
   disagrees with the effective DB value. First demoted set:
   `LLM_ROUTING_STRATEGY`, `DEFAULT_CHAT_MODEL`, `OLLAMA_CLOUD_FALLBACK_MODEL`
   (all three currently diverge → all three WARN). Services still read `.env` as
   a floor; the full read-path rewrite is deferred to Phase 2.
5. **UI consolidation.** Single Settings surface writing through `PATCH /config`;
   show effective value + source (DB/default/env-override) for each key.
   *(Incremental slice landed — 2026-07-01.)* `GET /config` now returns an
   `env_override` field (var/value/ignored) for demoted keys; the shared
   `ConfigField` gains an amber ".env ignored" `EnvOverrideBadge` and a lazy
   per-key history disclosure (`ConfigHistoryToggle`) backed by a new
   `GET /api/v1/config/{key}/history` endpoint (secret-flagged keys redacted).
   Wired into `LLMRoutingSection`'s custom controls for the three demoted keys.

Each phase is shippable and reversible.

## 5. Decisions (resolved 2026-06-30)

1. **Reuse `platform_config`** (KV + JSONB); types/defaults/validation/criticality
   live in the code `ConfigDef` registry — **plus a full audit trail** via the
   existing `platform_config_audit` table (§3.8).
2. **Layered validation** — write-time sanity hard-reject + gateway-owned
   reachability surfaced as UI status (§3.5).
3. Retire `feature_flags`; flags become config keys (§3.7); all `kill.*` removed.
4. **No `NOVA_CONFIG_*` env override** — the DB is the single editable source;
   write-time validation prevents lock-out, so no break-glass is needed (§3.3).

## Appendix A — Incident: the `inference.url` resurrection

- This Dell's historical config (per `docs/roadmap-archive-2026-03.md`) used
  `local-only` + `localhost:11434` — correct when ollama ran on the host and the
  gateway was not containerized.
- That value lived on as `nova:config:inference.url` in the **bind-mounted Redis
  dump**. Because `sync_inference_config_to_redis()` preserves existing Redis
  values, every boot kept `localhost:11434`.
- Inside the gateway container, `localhost` is the container itself → ollama
  unreachable → `RuntimeError` → HTTP 500 on every agent turn. The agent could
  not act at all.
- Compounding it, `Makefile` force-started a *bundled* ollama container (gated on
  `NOVA_INFERENCE_MODE`, not on whether the bundled service is actually used),
  which collided with the host ollama on `:11434` and broke `./start`.
- **Interim fix applied (2026-06-30):** Makefile gates the bundled-ollama profile
  on `OLLAMA_BASE_URL`; `.env` + Redis set to `http://host.docker.internal:11434`
  and `SAVE`d; stale `llm.ollama_url` removed. Verified across three `./start`
  cycles + agent e2e (3/3). This design exists so the *class* of bug can't recur.
