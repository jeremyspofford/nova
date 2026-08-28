# Slice 1 — The Spine

Parent: the Master Roadmap (approved 2026-08-27). Slice type: additive.
Size: L. This plan is the executable detail for S1 only.

Goal: a fresh machine runs one command, completes an in-browser wizard, and
chats with a local model in the v1 look — and the conversation survives a
full stack restart. (UI source is v0.5.0-alpha — roadmap decision 16, owner
decision 2026-08-27; the design system is byte-identical to v0.1.0-alpha,
v0.5.0 adds two months of page fixes on the same skin.)

## Definition of done (operator-visible, walked in the running app)

1. Clean machine → `./install` → browser wizard (welcome → owner account →
   hardware → engine → model → download → REAL inference round-trip) →
   first streamed reply in the ported UI.
2. `docker compose restart (from deploy/)` everything; ask "what did we talk
   about earlier?" — answered correctly from persisted memory.
3. ComponentGallery renders all 35 ported primitives in dark and light with
   spec teal #19A89E as default; theme presets switch live.
4. The wizard's Ready step shows the model's actual first reply — it cannot
   be reached if inference did not genuinely round-trip.

## Lane layout (new top-level dirs beside the v3 tree; v3 dirs untouched
until parity)

    services/core/       Python/FastAPI — auth, conversations, SSE chat,
                         trace ledger, settings store, migrations
    services/gateway/    Python/FastAPI — OpenAI-compat inference surface
    services/memory/     Python/FastAPI — files + BM25 memory
    apps/web/            Vite + React 18 + TS + Tailwind 3.4
    deploy/              docker-compose.yml (project nova), install.sh,
                         env templates
    docs/plans/rebuild/  slice plans (this file)

Compose project is `nova` (pinned in deploy/docker-compose.yml) on standard
ports: web :3000 (dev HMR :5173), core :8000, gateway :8001, memory :8002,
postgres internal-only, ollama :11434 (profile `inference`). All host binds
127.0.0.1. Owner instruction 2026-08-27: no parallel-session port
gymnastics — this is the primary development target on this box; when the
new stack needs to run, stop the old v3 stack first (its containers only —
v3's volumes and data are left strictly untouched, and the new stack's
volume names are distinct so nothing can collide; never `down -v` against
anything but the rebuild's own volumes).

## Dev-box inference

Dev uses the bundled ollama profile normally — with the v3 stack stopped
there is no VRAM contention — so the wizard's bundled path is dogfooded
from day one. Remote-endpoint and cloud remain wizard options exercised in
e2e. Model: the qwen3.8-27B-class pin — verify the exact released slug when
wiring the curated list (never recite).

## Services

### core (`services/core`)
- Auth: owner account minted by the wizard (argon2 hash, `people` table,
  role=owner); session cookie (httponly, SameSite=Lax) + bearer for API
  clients. `has_users=false` gates the account step (v0.5.0's CreateAccount
  pattern — shown only while no owner exists).
- Conversations: `conversations`, `messages`; `POST /api/v1/chat/stream`
  (SSE: meta / t / error / [DONE] frames). Turn flow: load windowed
  history → call gateway (OpenAI-compat, stream) → persist user+assistant
  rows → fire-and-forget memory ingest of the exchange.
- Trace ledger from turn one: `turns` + `turn_spans` written atomically at
  turn close (llm_call span: model, tokens, duration; memory spans). No UI
  reads it yet (S2's Activity does); recording starts now by design.
- Settings store: typed SETTING_DEFS registry (v3 design, rewritten),
  `GET/PUT /api/v1/settings`; owns theme default, engine/model choice,
  onboarding.completed.
- Migrations: numbered SQL in `services/core/migrations/`, vendored runner
  shared via copy into each service (`001_init.sql` …); CI proves empty→N
  and N-1→N. Same runner file in gateway and memory.
- Person/device registry: `people` only in S1 (devices arrive S5), but the
  table exists now with role enum (owner/adult/kid/guest) so S8 adds rows,
  not columns.

### gateway (`services/gateway`)
- `POST /v1/chat/completions` (streaming passthrough) + `GET /v1/models`.
- Backends: `ollama` (bundled container, profile `inference`), `remote`
  (any OpenAI-compat/ollama URL), `cloud` (provider + key, stored in core
  settings, resolved per call). NO routing logic — mode switch and hybrid
  escalation are S10. One backend active at a time, chosen by the wizard.
- Admin: `GET /admin/hardware` (reads data/hardware.json written by the
  installer), `GET /admin/suggest` (the tier table from the roadmap →
  engine+model suggestions), `POST /admin/pull` (streamed ollama pull with
  disk preflight), `POST /admin/probe` (load the model, run a 1-token
  round trip, stamp measured VRAM/tok/s on the catalog row).
- Curated model list: JSON file in-repo, enriched at runtime when the
  backend can report sizes; entries carry min_vram_gb tiers.
- Every response annotates which backend/model actually served it (header +
  usage block) — recorded into the turn's llm_call span by core.

### memory (`services/memory`)
- Store: markdown + YAML frontmatter under `data/memory/people/<owner-id>/`
  (journals/ + topics/) — the per-person layout exists from day one so S8
  is new rows, not a migration. Atomic writes, rescan on start.
- Index: in-process BM25 with recency boost (rewritten from v3's design).
- API: `POST /ingest` (turn exchange → journal entry, naive topic append),
  `POST /recall` (query + person scope → snippets), `GET /export`,
  `POST /forget` (path-scoped delete). Forget/export ship in S1 (rail 18).
- Core injects recall snippets into the system prompt's volatile half; the
  prompt is split stable/volatile from day one (cache boundary discipline
  starts now even though S1 has no tools).

### Cross-cutting (rails in force this slice)
- Per-link bearer tokens between web-nginx→core, core→gateway, core→memory:
  refuse-all-when-unset (rail 10); helper module + call-site test per
  service.
- `/health/live` flat and self-only on every service (rail 12); compose
  healthchecks call only it; `/status` gives dependency detail as data.
- Structured JSON logs everywhere from the first commit.
- The wizard's Ready step performs a real chat round-trip and shows the
  reply; any failure is a stated error, never "setup complete" (rail 5).
- One migration philosophy across all three services (rail 13).
- Trace-from-turn-one (rail 6 groundwork).
- S1 ships NO effectful tools at all (chat only), so no execution path
  exists that S3's funnel will later have to chase.

## Web app (`apps/web`)

Port per the roadmap's Frontend Port section (source: v0.5.0-alpha, per
decision 16):
1. Copy verbatim from `git show v0.5.0-alpha:dashboard/...`: DESIGN.md,
   tailwind.config.js, src/index.css, src/lib/{color-palettes,
   design-tokens}.ts, src/stores/theme-store.tsx, src/components/ui/* (35),
   src/components/layout/*, sidebarFilter.ts.
2. The ONE palette edit: `teal` in color-palettes.ts becomes the DESIGN.md
   #19A89E scale; stock Tailwind teal preserved as preset `tailwind-teal`.
   Reconcile index.html theme-color/manifest to the accent.
3. Fonts loaded for real: Plus Jakarta Sans (400–800 — add the 800 the v1
   app forgot) + @fontsource-variable/geist-mono.
4. Strip Sidebar/MobileNav of v3-era data hooks (attention counts, identity)
   → S1 nav: Chat, Settings, /dev/components. The filtering mechanism
   (minRole/preset) stays, wired to the new auth store.
5. Pages: Login, Onboarding wizard (adapt v0.5.0-alpha's steps — Welcome/
   CreateAccount/Hardware/Engine/Model/Downloading/Ready; engine step
   offers Bundled Ollama / Remote endpoint / Cloud with live connection
   tests; unavailable options filtered, never shown dead), Chat (ChatPage/
   ChatInput/MessageBubble adapted to the new SSE contract),
   Settings→Appearance (theme presets + custom, font scale) + Account,
   ComponentGallery (/dev/components).
6. Brand: neutral wordmark favicon/PWA icons ("nova" in PJS 800 on teal
   #19A89E); the real brand pass is pre-tag, per roadmap.
7. nginx one-origin build (web serves static + proxies /api to core) — the
   phone path from day one; dev Vite HMR runs on :5173 on the host (held by the v3 frontend container until that stack is stopped).

## Installer (`deploy/install.sh`, <300 lines)

Preflight (docker, compose, disk, ports) → host-side hardware detect
(nvidia-smi/rocm-smi → data/hardware.json; warn with exact fix if GPU
present but container toolkit missing) → generate secrets (.env: pg
password, service bearers, instance secret; idempotent re-run preserves
values) → `docker compose -f deploy/docker-compose.yml up -d --build` → print URL.
Engine/model/keys all happen in the browser wizard, nowhere else.
`./install update` = pull → pre-update pg_dump → up -d → health table
(bounded rollback refuses to cross a migration boundary — stated, with
restore guidance).

## Testing & verification

- Unit: per-service pytest (migrations from empty and from N-1; auth;
  SSE framing; BM25 recall; bearer refuse-all; health flatness). Vitest for
  theme-store palette injection (spec teal wins) and sidebar filtering.
- E2E (playwright container, `--profile e2e`): full wizard walk against
  bundled ollama with a tiny model (~1B-class for CI speed) → chat →
  compose restart → memory question → assert answer references the earlier
  exchange. Visual: gallery screenshot diff, dark + light.
- Manual DoD walk on this box (remote-endpoint path to v3's ollama), and
  the bundled path on a scratch machine/VM before S1 is called done.
- Definition of done is the DoD walk, verified live — not the suites.

## Work order

1. Scaffold: dirs, compose (project nova, ports, healthchecks, profiles),
   .env template, install.sh preflight+detect+secrets, CI skeleton.
2. Design-system port + gallery + fonts + teal fix (visual gate early).
3. core: migrations runner, people/auth, settings; then conversations + SSE
   + traces.
4. gateway: passthrough + admin (hardware/suggest/pull/probe).
5. memory: store + BM25 + ingest/recall/forget/export.
6. web: Login, wizard, Chat, Settings; nginx bake.
7. E2E + DoD walks (both inference paths).

Out of scope (later slices): tools of any kind, Activity page, policy
kernel, voice, daemon, routing, spend, proactive anything.
