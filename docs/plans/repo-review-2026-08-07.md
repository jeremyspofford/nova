# Repo review, user testing, and the test gate — 2026-08-07

What was done, in order: a full-repo review (eight parallel subsystem
reviewers, every high/medium claim adversarially re-verified against the
code — 79 raw findings, 0 of the verified ones refuted), a hands-on user
test of the served app at desktop and phone viewports (real chat turns,
every surface, screenshots, console/network capture), a fix pass over the
confirmed contained defects, and a test/coverage/hook infrastructure so the
next regression fails a gate instead of waiting to be noticed. Full finding
details with verifier notes: the session's `review_findings.json`
(scratchpad); this file keeps the actionable list.

## Fixed in this pass (all uncommitted, per house rule)

Backend:

- **Reply seam** — `runner.py` joined each tool-round's text with no
  separator ("Doing it now.Card is in your chat", verified in the live DB).
  Rounds now join with a paragraph break, streamed AND persisted
  identically.
- **Dead memory-claim guard** — `_build_system_prompt` wrote
  `memory_suppressed`/`memory_shown` into `signals` but the tool ctx never
  carried them, so the guard at runner.py:2604 could not fire. Now wired.
- **Frontmatter injection** — a model-supplied description containing
  `\nsource_type: operator` forged the provenance tier on read-back
  (last-key-wins). `render_frontmatter` can no longer emit multi-line
  values.
- **Backup passphrase self-destruction** — a master-key change made
  `backup_passphrase._local()` silently generate a NEW passphrase over the
  old row, quietly orphaning every existing bundle. Absent vs undecryptable
  are now distinct; undecryptable fails loudly.
- **Manual backups invisible** — "Back up now" never wrote
  `backup_attempts`, so the prompt's FACTS line kept telling the model the
  last backup failed. Manual runs now record attempts like scheduled ones.
- **`check_roles` colon test** — a bare local tag (`qwen3:8b`) was treated
  as provider-qualified and looked up in the cloud catalog; now qualified
  the way `model_chain`/`llm/router` document.
- **Secret leaks** — the resolved MCP URL (secret included) was logged and
  persisted into `mcp_servers.status_detail` on connect failure;
  `diagnose` handed the model the raw ntfy topic. Both scrubbed via
  `redact`.
- **http_call tools** — `{{secret:...}}` in DB-defined tools was sent as a
  literal placeholder despite the prompt promising substitution; body
  substitution was textual over serialized JSON (JSON-injectable). Secrets
  now resolve at call time; substitution is JSON-aware.
- **Permanent migration-prefix ERROR** — the 088 collision (both files
  applied 2026-08-04, unfixable by design) logged an ERROR on every one of
  ~76 daily backend starts, training everyone to scroll past migration
  errors. `db.py` now accepts that one collision by name (mirroring the
  test's `ACCEPTED_COLLISIONS`); any new collision is still loud.

Frontend (rebuild `web` to bake):

- **BackupsCard** — a failed load showed a skeleton forever (error went to
  a state nothing rendered); a migration-gate refusal rendered as
  "DID NOT RESTORE — missing " with no reason. Both fixed.
- **Desktop stop button** — a stalled stream left `busy=true` with no exit
  (mobile got the stop affordance, desktop never did). Wired.

Infra:

- `NOVA_HOST_ROOT` / `NOVA_PROJECT_DIR_HOST` no longer trust `${PWD}` —
  pinned in `.env`, documented in `.env.example` (compose run from any
  other cwd resolved every relative bind mount wrong).
- `NOVA_UID`/`NOVA_GID` documented in `.env.example` (git-landing's
  root-object lockout returns on any non-uid-1000 machine without them).

## Needs a decision (found, verified, not fixed)

Ordered by how much they matter:

1. **Sidecar auth** — `git-landing` (the only read-write mount of the repo)
   and `inference-control` (docker socket = host root) accept
   unauthenticated requests from ANY container on the compose network.
   Chained: a compromise of any sidecar is repo-write + host-root. The
   mcp-runner already has the pattern (shared bearer token, fails closed).
   Recommend: same token pattern on both; one env var each, checked in
   server.py. ~an afternoon including tests.
2. **Media SSRF redirect hole** — the guard validates the model-chosen URL
   once; yt-dlp inside the media container then follows redirects
   unguarded, so a public URL 302ing to `http://backend:8000/...` reaches
   the internal network. Real fix needs a design: an egress proxy for the
   media container, or per-hop validation inside `media/app.py`.
3. **Blocking NAS I/O on the turn path** — `failures.py offsite_state()` /
   `backups()` stat a network mount synchronously on the event loop; also
   why `GET /api/v1/backups` took 7.3s in testing (the Backups card sits on
   a skeleton that long). Offload to threads; cache the offsite stat.
4. **Eval slot lifecycle** — two check-then-set races and a
   release-only-inside-`_execute` path that can wedge evals for the process
   lifetime (eval_runs.py:207,297).
5. **Ingest worker not leader-gated** — a second backend instance (the
   worktree pattern is real here) requeues jobs a live worker still runs.
6. **Turn-lock leak** — a chat SSE generator that is never started leaks
   the per-conversation lock forever (router_chat.py:929).
7. **/clear during in-flight compaction** resurrects the cleared summary
   (compaction.py:189).
8. **Backup-lane loose ends** (in-flight lane, same review): `_drill_verdict`
   is silent when the drill ran once and stopped — the exact "five quiet
   Sundays" it exists to catch; the unsalted `sha256[:12]` passphrase
   fingerprint in every bundle bypasses scrypt for weak operator-chosen
   passphrases; `scripts/nova_restore.py` leaves decrypted credentials in
   `out/.work` when verification fails.
9. **`.env.example` ships a default Postgres password** — voids the
   "no DB credentials" containment argument for the hardened sidecars.
10. **Dispatch groups** — only the first dispatch in a consecutive run
    passes the inlined rules check (runner.py:2966); a repeated fabricated
    uuid ships uncorrected on retry (runner.py:3378).
11. **Model-store relocation silently flips whisper to CUDA/float16/large-v3**
    (inference-control/server.py:173).

Plus 42 low-severity notes in `review_findings.json` — none urgent, several
worth a sweep (dead code, misleading copy, missed derived-not-hardcoded
spots).

## User-testing notes (desktop + mobile, served build)

Everything navigates; both chat turns streamed; zero real console errors;
zero failed API calls. Cosmetic/wart list, not fixed:

- A finished 0-tool turn keeps its "Nova is working…" expander (mobile
  screenshot); should resolve or vanish.
- The observability alert headline freezes its raise-time age ("has not
  reported for 3 minutes" sitting next to "raised 3d ago"). The ghost
  instance itself retires at `monitor.retire_after_days` (7d) as designed.
- A goal card renders its description's raw markdown (`## Why now`) in the
  preview.
- The Library tab strip's overflow is DESIGNED (scrollable, per the code
  comment) but at 1440×900 the clipped "Fi" reads as broken; a fade or
  chevron would say "more here".
- glm-5.2 echoed a terse prompt back verbatim once (trace-verified: one
  LLM call, no tools). Model behaviour, logged for the eval lane.

## The test gate (new)

- **Backend**: `tests/run_all.py` grew `NOVA_COVERAGE=1` — every suite runs
  under `coverage -p`, combined, reported, and held to
  `backend/tests/coverage_floor.json`. Baseline measured **54%** across
  77 green suites (69s without coverage). New suite:
  `test_compose_contract.py` pins localhost-only ports, restart policies,
  and the grandfathered single-file-mount list.
- **Frontend**: vitest + jsdom + testing-library (host node via mise);
  first 19 unit tests (names/models/time formatters, ErrorBoundary);
  coverage floor in `frontend/coverage_floor.json` (baseline ~0.5% — the
  ratchet's job is to only go up).
- **E2E**: two new suites encode the manual QA walk —
  `test_navigation_desktop.py` (rail surfaces by click, all ten library
  tabs, backups card loads real data, inbox opens, console-error sweep) and
  `test_navigation_mobile.py` (chat-first landing, composer inside the
  viewport, drawer → every page → back returns to chat, universe/hands-free
  cards). 8 tests, ~35s, green. Chat-writing tests remain opt-in
  (`NOVA_E2E_CHAT=1`) so test turns stay out of the journal.
- **Hooks**: `.githooks/` (enabled via `core.hooksPath`, documented in
  README). pre-commit = typecheck + frontend units (~25s). pre-push =
  backend suite + both coverage floors + e2e (~4-6 min). Skips exist and
  are LOUD (`NOVA_SKIP_HOOKS=1`, `NOVA_PUSH_FAST=1`).

The reviewers also returned ~100 prioritized test gaps (per-area lists in
`review_findings.json` under `test_gaps`). The highest-value unwritten
suites: `consents.validate_and_use` (single-use burn under concurrency —
the load-bearing mechanical seam, zero tests), `leader.py` (zero tests),
`main.py` auth middleware driven through real ASGI requests, git-landing's
branch/dirty-tree refusals, and the ingest queue's orphan/dedupe/tombstone
semantics.
