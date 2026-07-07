# 05 — Technical Debt, Dead Code & Errata

> **Audit date:** 2026-07-05. Every item below carries its evidence. Actions
> assume pre-release status (breaking changes free, no deprecation shims).

---

## 0. Previous audit errata (2026-07-03 `architecture/` docs — now replaced)

The prior audit contained findings that failed code verification. Recorded so
they don't get re-planned:

| Prior claim | Reality |
|---|---|
| "Cortex maturation pipeline built but NOT wired; goals sit in triaging forever" (its #1 finding, P0, 2-3d) | **False.** `cycle.py:610-645` dispatches scoping/speccing/building/verifying; `drives/maintain.py:34` runs triage; `drives/serve.py` selects goals by phase. Shipped in the 2026-07-02 branch work. |
| "Service `.venv` directories committed to the repo" | **False.** `git ls-files | grep .venv` → 0 files. |
| "Cortex — zero integration tests" | **False.** 15+ cortex/maturation/decomposition test files in `tests/`. |
| "Voice: OpenAI, Deepgram, ElevenLabs" | Deepgram/ElevenLabs removed (`9f031ba`). OpenAI only. |
| Refactor plan Phase 1 = "wire maturation executor" | Already done; the real cortex gaps are learning-from-failures and the human-checkpoint tool. |

**Root cause:** the prior audit trusted `TODOS.md` (itself stale) over the code.
TODOS.md still lists the maturation executor as deferred and references
`claude_subscription_provider.py`, which no longer exists.

---

## 1. Dead code & dead data (verified)

### D1. `workspace/` — 21 tracked agent-junk files 🪦
`git ls-files workspace/` → `hello.py`, `primes.py`, `add.py`, `bulk_delete.py`,
`metadata_echo.py`, `validation_helpers.py`, 7 matching `test_*.py`, plus 8
agent-written reports (`SELF_IMPROVEMENT_ACTIVATION_REPORT.md`,
`WORKSPACE_ANALYSIS.md`, …). These are artifacts Nova generated into an old
default workspace that pointed at the repo. The runtime default is now
`~/.nova/workspace`.
**Action:** `git rm -r workspace/` + add `workspace/` to `.gitignore`. Zero risk.

### D2. Nine orphan Postgres tables 🪦
`engrams` (5 rows), `engram_edges`, `engram_archive`, `working_memory_slots`,
`embedding_cache`, `consolidation_log`, `retrieval_log`, `sources`,
`neural_router_models` — created by the removed SQLAlchemy memory backend; no
migration creates them; no code reads them (repo-wide grep). Bonus anomaly:
migration 091 dropped `neural_router_models` and `schema_migrations` records
091 as applied, **yet the table exists live** → something recreated it after
(old image or backup restore). Migration 088's comment even references
`memory-service/app/db/schema.sql`, a file that no longer exists.
**Action:** new migration `093_drop_legacy_memory_tables.sql` dropping all
nine; delete `embedding_cache` from `recovery-service/app/factory_reset.py:130`.

### D3. Stale "no bundled inference" comments in docker-compose.yml 🪦
`docker-compose.yml:65-71` ("Local inference is NOT bundled…") and `:104-106`
("No bundled ollama service exists…") contradict lines 742-820, which define
the four bundled inference services. Leftover from the reverted BYO-external
phase (`093873b` removed bundling → `df576c9` re-added it).
**Action:** rewrite both comments.

### D4. Dead `COMPOSE_PROFILES` values in `.env` 🪦
`COMPOSE_PROFILES=bridges,editor-neovim,search,voice` — `bridges` and `search`
match no profile in the compose file (removed services). Meanwhile
browser-worker is running without its `browser` profile listed (started
out-of-band; will NOT come back on `docker compose up`).
**Action:** correct `.env` (and ensure `./install`/docs never emit `bridges`/
`search`); decide whether `browser` belongs in the persistent profile list.

### D5. Voice env vars for removed providers 🪦
`docker-compose.yml:671-672` passes `DEEPGRAM_API_KEY`/`ELEVENLABS_API_KEY`
into voice-service; zero code references (providers deleted in `9f031ba`).
`.env.example` is already clean.
**Action:** remove the two env lines.

### D6. `docs/` graveyard 🟡
- `docs/engram-network/` — slides for the **removed** memory system.
- `docs/plans/2026-03-07-chat-bridge-{design,impl}.md` — service deleted
  (`17bbd53`); 17 other 2026-03-xx plan/impl docs describe shipped work.
- `docs/roadmap.md` "What's Shipped" still lists **chat-bridge** as an optional
  profile and predates the OKF memory rewrite; `docs/roadmap-v2.md` and
  `docs/roadmap-archive-2026-03.md` coexist with it (three roadmaps).
- `docs/specs/`, `docs/superpowers/`, `docs/audits/`, `docs/work/` mix live
  and completed/abandoned material with no status markers.
**Action:** single pass — move everything historical under `docs/archive/`,
keep one living `docs/roadmap.md` rewritten to current reality. (CLAUDE.md's
website mapping also references `docs/roadmap.md` — keep the path.)

### D7. Stale TODOS.md entries 🟡
- "Maturation Pipeline Executor" (twice) — **shipped**; delete both.
- "Cortex Integration Tests — none exist" — exists; rewrite to "extend".
- "Re-test Claude 4.6 Subscription OAuth… update `_MODEL_MAP` in
  `claude_subscription_provider.py`" — file deleted; delete or rewrite entry.
- "Friction-to-Engram Pipeline" — targets the removed engram system; rewrite
  against the OKF ingestion queue if still wanted.
- "Full User Entity Management UI" — depends on `user_entities`/
  `retrieval_pool` tables that never existed in this schema; rewrite or drop.

### D8. Stale CLAUDE.md claims 🟡
- "memory-service uses SQLAlchemy async" — it has no DB at all now.
- "Full integration suite (35 tests…)" — ~90 test files / 16k lines.
- Redis DB table says `db4=unused (was chat-bridge)` — correct, but consider
  reclaiming db4 on the next allocation instead of extending past db11.
**Action:** two-line fixes next time CLAUDE.md is touched.

### D9. Legacy "engram" naming in live schema/API 🟡
`knowledge_crawl_log.engrams_created/engrams_updated` columns and the matching
fields in `orchestrator/app/knowledge_router.py:102-103` — functional but
misleading (they count memory items now).
**Action:** rename in the D2 cleanup migration (`memories_created/updated`)
+ 4-line code change, or accept and document.

### D10. `PROMPT.md` at repo root 🟡
A "you are continuing development of Nova" bootstrap prompt for AI sessions;
predates CLAUDE.md (which now serves that role, better).
**Action:** delete or fold anything unique into CLAUDE.md.

### D11. `benchmarks/` memory harness 🟡
Built to A/B memory *providers*; only one backend exists now and the harness
hits the gateway for LLM-judging. Not dead, but its reason-to-exist
(comparison) is gone. `make benchmark-quality` still wires to it.
**Action:** keep if the retrieval-tuning loop (F1 gap) will use it as its
metric; otherwise park under `docs/archive/`.

### D12. Migration numbering gap `084` — ~~finding withdrawn~~ ✅ already handled
The gap is intentional, documented in `orchestrator/app/migrations/.gaps`
(084 was reserved for sec-006b, never claimed), and enforced by the
"Migration Number Gap Check" CI job. No action. (Kept here so the next audit
doesn't re-flag it.)

---

## 2. Broken things found (not dead — defective)

### B1. `make backup` fails ❗
`scripts/backup.sh` is not executable → `make: ./scripts/backup.sh: Permission
denied` (reproduced). The documented emergency CLI is dead on arrival; the
recovery API path works (verified — produced a real backup during this audit).
**Fix:** `chmod +x scripts/*.sh` + a CI lint that shell entrypoints are +x.

### B2. Integration suite cannot run offline of `uv` cache / first run is slow
`make test` shells to `uv run --with <13 packages>`; `tests/requirements.txt`
duplicates the list. Two sources of truth for test deps.
**Fix:** point make at `uv run --with-requirements tests/requirements.txt`
(or a tests pyproject) so the lists can't drift.

### B3. Test-suite ground truth — see §5 (run during this audit).

### B4. Default CORS origins reference a dead port 🟡
Compose defaults allow `http://localhost:3001` (nothing serves 3001; dashboard
is 3000/5173). Harmless-but-confusing; also means **prod dashboard origin 3000
is absent** from the default allowlist (it works because nginx same-origin
proxying avoids CORS entirely — but any future direct-from-browser call to
:8000 from the :3000 origin would fail mysteriously).
**Fix:** change defaults to `3000,5173,8080`.

---

## 3. Security concerns (ranked)

### S1. Host `$HOME` mounted **read-write** into the orchestrator by default ❗
`docker-compose.yml:291` — `${HOME}:${HOME}:${NOVA_HOME_MOUNT:-rw}`. The
"home" sandbox tier is admin-opt-in at the app layer, but the mount itself is
rw regardless, so any container escape / tool-permission bug / prompt-injected
file tool has the entire home directory writable. `NOVA_HOME_MOUNT=ro` exists
but is not the default, and SEC-001 removed the equivalent root-tier mount for
exactly this reason.
**Recommendation:** default the mount to `ro` (or bind only when the tier is
enabled); make `rw` the explicit opt-in. Cheap, high-value.

### S2. `.env` mounted `:rw` into orchestrator + recovery (known, FU-010)
Mitigated by the recovery env-editor whitelist refusing secret-bearing keys;
still lets a compromised orchestrator rewrite infra config.
**Plan already on file:** move infra keys to `platform_config`, drop to `:ro`.

### S3. Compose CLI on the raw Docker socket (known, SEC-006b design)
Recovery's SDK path is proxied/allowlisted, but `compose_client.py` retains
full daemon access by design. Documented trade-off; revisit only if recovery's
attack surface grows (it also serves HTTP on 8888 to the LAN).

### S4. Trusted-network auth bypass (history + residual risk)
The 2026-07-01 incident (integration tests triggered a factory reset through
`TRUSTED_NETWORK_CIDRS`) was fixed by requiring explicit admin credentials on
destructive recovery endpoints — but the bypass still exists for other
mutating surfaces. Any new destructive endpoint must remember to opt out.
**Recommendation:** invert the model — maintain an explicit allowlist of
endpoints the bypass may reach, not a denylist of exceptions.

### S5. Default admin secret fallback
Compose falls back to `nova-admin-secret-change-me` in 5+ services when
`NOVA_ADMIN_SECRET` is unset. `./install` generates a strong one, but `docker
compose up` without install boots with the known default (FC-002 startup check
exists — verify it hard-fails rather than warns).

---

## 4. Maintainability debt

| Item | Evidence | Suggested move |
|---|---|---|
| `pipeline/executor.py` 2,014 loc | single stage-driver file: checkpointing + retries + notifications + summaries + cost | extract notification + summary + cost modules (behavior-preserving) |
| `router.py` 1,668 loc / 45 endpoints | chat + agents + keys + usage + sandbox + OpenAI proxy in one file | split by resource (chat, agents, keys/usage, openai_compat) |
| `agents/runner.py` 1,343 loc | prompt build + tool loop + memory + sources + ingestion | extract prompt-builder and tool-loop |
| Write-only tables | `audit_log`, `conversation_outcomes` inserted, never SELECTed | either build the reader (audit UI / outcome analytics) or stop writing |
| `pipeline_training_logs` | populated, no consumer pipeline | same decision |
| Dashboard has zero tests | only `tsc -b` gate; 38k loc of TS | add typegen from Pydantic (removes the biggest error class) before adding test infra |
| Per-service unit tests uneven | orchestrator 18, everything else 0-3 files | rely on the integration suite (it's real coverage) + fill gaps only where logic is pure (index/BM25, denylists, state machine) |
| Docs missing for newer services | no `website` docs for cortex, intel, knowledge, browser | write after consolidation decision (06), not before |

---

## 5. Test-suite ground truth (run 2026-07-05 during this audit)

Full suite run against the live stack in two chunks with `--timeout=180`
(pytest-timeout, signal method): **494 passed · 58 failed · 48 skipped ·
~44 min total.** A DB backup was taken first
(`nova-backup-2026-07-06_00-26-28.tar.gz`); no destructive incident.

### Suite-infrastructure findings (before the failures)

- **The suite can hang forever.** The first (vanilla `make test`) run stalled
  25+ min inside `test_decomposition_simple_path.py::test_simple_goal_
  materializes_flat_tasks` — a no-deadline poll. No timeout plugin is
  configured in `pytest.ini` or the Makefile.
  **Fix:** add `pytest-timeout` + `timeout = 180 / timeout_method = signal`
  to `pytest.ini` (`thread` method kills the whole session on first timeout —
  don't use it here).
- `tests/.pytest_cache/v/cache/lastfailed` predated this audit by 2 days and
  referenced deleted test files — don't trust it for state.
- Test deps are listed twice (Makefile `--with` list vs `tests/requirements.txt`) — see B2.

### The 58 failures collapse into five root causes

**A. Factory-reset seed loss — ~11 failures, ONE product bug ❗**
`test_skills_rules` (4), `test_trusted_networks` (2), `test_intel` feeds +
system goals (3), `test_capability_master_key_bootstrap` (2).
Verified mechanism: factory reset truncates tables but preserves
`schema_migrations`, so **seed migrations never re-run** — live DB has
`intel_feeds` = 0 rows although migration 040 seeds 14+; the `no-rm-rf` seed
rule and `capability.credential_master_key` / `trusted_networks` config rows
are gone the same way. (The migration-090 memory-curation goal survives only
because 090 was applied *after* the last reset.)
**Fix (small):** factory reset also clears `schema_migrations` — every
migration is already idempotent by convention, so a full re-run on next boot
is safe. Alternative: move seeds out of migrations into startup seeding
(`main.py` already seeds tenant/admin/tool-permissions this way).

**B. Invalid Groq key cascading through the gateway — ~15 failures, one env
issue + one robustness bug ❗**
All pipeline-executing tests (`test_pipeline*` 5, `test_maturation_*` 6,
`test_decomposition_*`/`test_depth_limit`/`test_journal_completeness` ~6,
incl. 4 of the 180s timeouts) fail the same way: task dies at the context
stage with `500 from http://llm-gateway:8001/complete`; gateway log shows
`GroqException — Invalid API Key`. Downstream assertions ("expected 1 child,
got 0", "spec was never populated", "stuck at building") are all this.
1. *Environmental:* this host's Groq platform secret is dead — rotate or
   remove it.
2. *Robustness bug:* under `local-first` routing with a healthy local backend,
   one provider's invalid credential must not 500 the request — the fallback
   chain should skip credential-rejected providers (and surface a 4xx
   "provider key invalid" toward the caller/dashboard instead of a raw 500).

**C. Stale tests asserting removed surfaces — ~12 failures, delete/rewrite
the tests**
- `test_inference_backends` (7): asserts BYO-external-era recovery endpoints
  (model switch/search, GPU stats, hardware auth) — 404/405 now that bundled
  inference returned with a different API.
- `test_tool_permissions::TestSandboxTierRename` (3): 405s — route/method
  changed in the sandbox-tier rename.
- `test_drive_scheduling` (2): `ModuleNotFoundError: app.drives` — imports
  cortex internals not on the tests' pythonpath (works in-container only).

**D. Auth-posture drift — ~8 failures, decide the truth ❗(security-adjacent)**
Endpoints answered **200 to unauthenticated requests** where tests expect
401/403: friction CRUD, quality summary + benchmark results, tool-permissions
admin, recovery troubleshoot, RBAC user listing, guest-models set. Either the
trusted-network bypass (host → container CIDR) is intentionally in play — then
the tests must authenticate-or-skip — or these endpoints lost their auth
guard. Each needs an explicit verdict; history (the 2026-07-01 factory-reset
incident) says don't leave this ambiguous. Down from ~48 mismatches on
2026-07-01 to ~8 — most were fixed; these are the remainder.

**E. Environment-coupled assertions — ~3 failures, relax or gate the tests**
- `test_cortex_status_endpoint_has_checkpoint`: expects an initialized
  checkpoint; a fresh brain-off instance legitimately reports
  `{'status':'uninitialized'}`.
- `test_voice.py::test_synthesize_returns_mp3`: 500 — upstream OpenAI TTS call
  failed on this host (key/quota), not a code path assertion.
- `test_orchestrator::test_delete_active_task_rejected`: task reached a
  terminal state early (B's cascade) so "active" precondition didn't hold.

### Bottom line
Two small fixes (A: reseed-on-reset, B2: provider-skip on invalid creds +
key rotation) would repair ~26 of 58 failures; ~12 more are tests to delete or
rewrite for removed surfaces; ~8 are auth-posture decisions; the rest are
test-hardening. **No failure indicates a broken core feature** — chat, memory,
capability platform, flags, recovery, CRUD surfaces all passed.

---

## 6. Performance watch items (no action needed yet)

- OKF BM25 `index.refresh()` runs on **every write** and rescans file mtimes;
  fine at current scale (5 files), unmeasured at 10k-file scale. The
  self-healing design is right; add a size-triggered benchmark before topics/
  reaches thousands of files.
- Orchestrator startup runs 89 migrations' worth of `IF NOT EXISTS` checks
  every boot — currently instant; fine.
- LLM HTTP timeouts default high (600s-class) for CPU inference; document
  recommended values per backend rather than tuning code.
