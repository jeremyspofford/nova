# Roadmap

v1 is complete and live-verified (2026-07-13): streamed chat, agent index +
dispatch, runtime agent/tool/skill creation, file-backed memory, brain graph.
See README for what works. This file is the ordered backlog.

## Shipped

- **Knowledge ingestion agent** (2026-07-13) — `fetch_url` builtin
  (GET-only, 20s/200KB caps, per-redirect-hop SSRF guard in
  `backend/app/tools/web_fetch.py`) + seeded `ingestion` agent that distills
  URLs into tagged, provenance-stamped topic files. Live-verified: Wikipedia
  article ingested through an http→https redirect; localhost / link-local /
  RFC1918 / docker-internal targets all refused; later questions answered
  from memory without refetching.

- **Memory freshness** (2026-07-13) — memory is a cache with provenance, not
  a terminal archive. Retrieval headers now show `(learned <date>, source:
  <url>)`; main's policy: memory-first for stable facts, refresh-then-answer
  for volatile/aged knowledge, "as of <date>" attribution otherwise; ingestion
  updates topics **in place** via `write_memory(item_id=...)` (prompt-only
  title matching failed live — the id pin is mechanical). Verified: backdated
  topic + "right now" question → re-fetch + in-place update (timestamp bumped,
  no duplicate); stable-fact question → zero fetches.

- **Source discovery** (2026-07-13) — Nova finds new sources, not just
  re-fetches known ones. Bundled **SearXNG** metasearch service (keyless,
  self-hosted, JSON) is the primary `web_search` provider with keyless DDG
  HTML as automatic fallback (`backend/app/tools/web_search.py`); no keyed
  providers by design (product principles: batteries-included, privacy-first,
  local-model users primary). Ingestion agent now has three modes:
  INGEST / REFRESH (item_id in-place) / RESEARCH (search → fetch up to 3
  candidates → store durable knowledge, report ephemeral). Verified: zoo-hours
  question discovered + fetched parks.ny.gov, answered with current hours;
  cold-subject research created a tagged topic; provider fallback fires when
  searxng is stopped; stable facts stay memory-only.

- **Brain graph = metadata index with pointers** (2026-07-13) — graph nodes
  carry frontmatter only (description, tags, source_url, learned date; bodies
  never ship); clicking a node fetches full content on demand
  (`GET /api/v1/memory/item/{id}`) into a detail panel with a "View source"
  external link. Path-traversal guard added to `store.read_file` (item ids are
  LLM/user-supplied).

- **Per-agent DB-tool granting** (2026-07-13) — `allowed_tools` now governs
  DB-created tools like builtins (named grants or `db:*` wildcard; `main` holds
  `db:*` so created tools stay reachable at the front door). Plus
  execution-layer enforcement: `execute_tool` refuses names not offered to the
  calling agent, so a hallucinated tool name is refused, not executed.

- **Conversation compaction** (2026-07-13) — token-budgeted history window
  (provider-aware: 24k OpenRouter / 6k Ollama defaults, env-overridable;
  chars/4 estimation; 4-message floor) + rolling summary: turns aged out of
  the window are distilled into `conversations.summary` (watermarked by
  `summary_upto`, fire-and-forget post-turn, no-op below 10 aged messages)
  and injected as "Conversation so far". Verified: forced 3k budget compacted
  47 messages into a summary that correctly answered "what did we do at the
  beginning"; idempotent (no re-compaction); raw exchanges stay journaled.

- **Galaxy theme** (2026-07-13) — canvas-2D homage to the v0.1.0-alpha
  Three.js brain (recipe recovered from the tag + era screenshots): breathing
  star nodes with additive glow + white-hot centers, domain cluster colors,
  Fibonacci-sphere cluster layout with light 3D relaxation, slow auto-orbit
  (drag to orbit, wheel to zoom, click for detail), neon depth-faded topic
  labels, starfield + nebula backdrop, golden core anchor. HUD theme picker
  (Graph/Galaxy) persisted in localStorage. Upgrade path: true Three.js +
  UnrealBloom behind the same theme key if fidelity falls short.

- **Automations + Settings platform** (2026-07-13) — behavioral config moved
  to a DB-backed, UI-editable settings store (defs registry in
  `settings_store.py`; env demoted to infra + secrets — the old-Nova config
  fragmentation lesson applied from day one). **Automations** = schedule +
  instruction + executing agent: generic 60s scheduler, live UI kill switch,
  consecutive-failure auto-disable at 5, journaled outcomes; seeded
  `refresh-stale-knowledge` (ingestion agent + `list_stale_topics` tool)
  generalizes the staleness sweep. Nova creates automations from chat via
  `manage_automations`. Gear-button overlay hosts Settings + Automations
  tabs. Verified: autonomous in-place refresh of a backdated topic; chat-
  created `tech-news-digest`; kill switch; failure counting; idempotent
  no-op runs.

- **Guardrail layer + guardian agent** (2026-07-13) — every tool call is
  checked against data-driven rules (regex vs tool name + args; block/warn;
  per-tool + per-agent targeting; hit counts) at the single dispatch point,
  fail-open on engine errors. Seeded: `protect-soul` (agents cannot rewrite
  Nova's identity — closed a real hole where write_memory item_id=soul.md
  passed the path pin) and `no-secret-in-requests` (warn on key material in
  outbound requests). New **guardian** agent stewards rules (main dispatches;
  manage_rules is guardian-only — the conversational agent never holds
  rule-weakening capability); system rules immutable to agents at store/API/
  tool layers, operator can toggle in the Rules tab. Live-verified: soul
  write blocked; guardian-created facebook block enforced on ingestion;
  casual "disable it real quick" got pushback demanding explicit intent.

- **Operator edit mode** (2026-07-14) — `ui.edit_mode` Settings toggle
  (default OFF) gates manual create/edit/delete of agents, automations,
  rules, and tools, **enforced at the API layer** (403s), not just hidden
  buttons; reads, enable/disable, and model changes stay open. New surface:
  agent create/delete endpoints + full agent editor (system prompt, tool
  grants, routing keywords), a Tools tab (DB tools toggleable/creatable
  against the host allowlist, builtins listed read-only), and view-mode
  hints. A 🔒/✏️ badge in the overlay header shows the current mode from
  any tab (the switch itself lives in Settings → Operator), and the
  `automations.*` subsystem settings moved into the Automations tab where
  the automations live. System entities remain undeletable even in edit
  mode. Live-verified end-to-end: 7 gated endpoints 403 when off / work
  when on, agent + tool created and deleted through the UI, and — the key
  invariant — Nova's own `manage_*` tools work with the toggle OFF
  (chat-created automation while locked). Bonus finding: glm-5.2
  fabricated a "created!" success without
  calling the tool on the first attempt — never trust self-report, verify
  against the DB (old-Nova lesson holds).

- **Bundled Ollama + local-path validation** (2026-07-13) — optional
  `inference` compose profile ships Ollama (batteries-included local
  inference; `OLLAMA_BASE_URL` defaults to the bundled service, override for
  host-run). Validated the full loop on `qwen2.5:3b` (CPU): chat (~40s/turn),
  memory recall, tool calling (clean list_agents call, no malformed calls in
  any test), and dispatch + multi-round tools (main -> ingestion -> search ->
  write -> report). Honest finding: the 3B model's *judgment* trails cloud —
  it journaled already-known facts instead of fetching fresh when asked to
  "look up" — but the machinery is fully compatible. Local users should
  prefer 7B+ models and a GPU for interactive latency.

- **Hot-swappable bundled inference from Settings** (2026-07-14) — the
  bundled Ollama container starts/stops from Settings → Inference (status
  dot + toggle, 4s poll; card hides when the sidecar is absent). The docker
  socket (root-equivalent on the host) is held ONLY by a new
  `inference-control` sidecar (`inference-control/server.py`, ~120 lines,
  stdlib): fixed-verb API — GET /status, POST /start, POST /stop of the
  `ollama` compose service, nothing parameterized — on the compose network
  only, no published ports. Start/stop shell out to `docker compose
  --profile inference` against the mounted compose file, so operator edits
  (e.g. a GPU block) are honored; compose project name is now pinned
  (`name: nova-rebuild`). Backend proxies at
  `GET/POST /api/v1/inference/bundled`, adding an `api_ok` probe of the
  bundled URL and invalidating the models cache on toggle. Live-verified
  via Playwright through :5173: stop → container exits, card shows
  stopped; start → running + api_ok; then a real chat turn on
  `ollama:qwen2.5:3b` through the recycled container; sidecar rejects
  non-verb paths (404/501) and is unreachable from the host.

- **Default cloud model → z-ai/glm-5.2 + chat polish** (2026-07-14) — GLM-5.2
  replaces claude-haiku-4.5 as the default OpenRouter model: cheaper
  ($0.93/$2.92 vs $1/$5 per M tokens), 1M context, tools + parallel tool
  calls verified live on OpenRouter. Migration 017 moved existing haiku
  agents; `default_model` env default and the manage_agents example updated.
  Chat polish: bouncing typing dots while waiting for the first token; the
  memory detail modal is wider (42rem) with roomier padding.

- **Model recommendations (2026-07-14)** — hardware-aware, per-agent model
  suggestions (brainstormed + designed + shipped same day). One engine
  (`backend/app/model_recs.py`): detected hardware (RAM/CPU from `/proc`
  in-container; GPU presence via a new fixed `GET /gpu` verb on the
  inference-control sidecar; VRAM never guessed — observed empirically from
  Ollama `/api/ps` during probes, the anti-`hardware.json` design) + a
  DB-seeded curated table (migration 018, 13 rows: min RAM/VRAM, tool tier
  A/B/C, speed class, roles; edit-mode editable, seed rows toggle-only) +
  role profiles (chat/tools/guard/compaction, heuristic for user agents) →
  per-agent {suggested, reason, alternates}. Hybrid-aware: cloud candidates
  only with a key, and a cloud pick always lists a fully-local alternate;
  exact scoring ties keep the current model (no churn). Pin guard flags any
  agent whose model isn't in the live catalog. Surfaces: Settings →
  Inference "Detect & suggest" card (+ curated-table editor) and a
  `recommend_models` tool on model-manager. "Test this model" probe:
  TTFT/tok_s + a forced tool call verified MECHANICALLY from the tool_calls
  frame (nonce match — prose claims count for nothing) + GPU/VRAM readback;
  results stamped onto curated rows; never pulls. Live-verified: chat →
  dispatch → model-manager presented real hardware (31.2 GB / 20 cores /
  CPU-only inference) and the full per-agent table, asking before any pull;
  probes: qwen2.5:3b ✓ 5.7 tok/s CPU, glm-5.2 ✓ 44.9 tok/s; 8/8 edit-mode
  gating checks; pin guard flagged an un-pulled model live; compaction.model
  now runs the feature's own suggestion (qwen2.5:3b). Lesson re-learned: a
  new capability must be advertised in the agent INDEX (description +
  keywords), not just granted — main answered "I can't inspect hardware"
  until the index said otherwise.

- **GPU wiring + measured VRAM (2026-07-14)** — the bundled Ollama ran
  CPU-only even on GPU machines (the compose GPU block was a documented-but-
  never-written manual step), so Nova could detect the nvidia runtime but
  never see the GPU. Now: `docker-compose.gpu.yml` (nvidia device
  reservation) is merged **automatically by the inference-control sidecar**
  whenever the docker NVIDIA runtime is present (`OLLAMA_GPU=auto|on|off`;
  base compose stays CPU-safe for GPU-less machines), plus a fifth fixed
  sidecar verb `GET /vram` — nvidia-smi INSIDE the ollama container reports
  GPU name + total VRAM, zero parameterization. Hardware detection, the
  recommendation fit logic, the Settings card, and recommend_models all use
  the measured values; nothing is ever hand-fed (operator explicitly asked
  for hallucination-proof verification). Probe hardening from the same
  session: exact token counts via `stream_options.include_usage` (chars/4
  undercounted numeric output ~4x) and an untimed warmup for local models so
  TTFT measures the model, not a cold disk load. Live-verified, all values
  measured: RTX 3090 / 24.0 GB VRAM detected; qwen2.5:3b probe went
  6.0 tok/s CPU → 138.5 tok/s GPU (TTFT 154 ms, 3.1 GB VRAM observed,
  cross-checked against `ollama run --verbose` at 150.9 tok/s); tools-role
  suggestion re-sized from the CPU MoE pick to qwen2.5:32b-on-GPU. Platform
  matrix documented in README (Linux/WSL2 NVIDIA auto; Docker Desktop
  `OLLAMA_GPU=on`; macOS = host-run Ollama via the settings URL — containers
  can't reach Apple GPUs; AMD/ROCm not wired yet, clean CPU fallback).

- **Platform-aware memory sizing + unified memory (2026-07-14)** — answers
  "why does Nova see 31.2 GB when I have 64?" honestly and sizes models on
  machines it can't fully see. Detection now names its world from
  /proc/version (`wsl2` / `docker-desktop` / `linux`) and states the memory
  caveat in the UI: on WSL2 the VM defaults to ~50% of host RAM and that
  allocation IS the bundled Ollama's real ceiling (fix in .wslconfig, not in
  Nova); on Docker Desktop the VM hides the host's memory entirely. For the
  genuinely unmeasurable case (macOS unified memory with host-run Ollama) a
  new `inference.memory_gb_override` setting feeds `sizing_ram_gb`, clearly
  labeled "(operator override)" in every reason string. Unified-memory GPUs
  are inferred, not configured: GPU-active probe stamps with no NVIDIA
  runtime ⇒ fit by system memory with "fits your X GB unified memory"
  (Metal has no separate VRAM pool to require). Verified live: platform
  "wsl2" + note detected; override 48 GB made llama3.3:70b a tools
  candidate with the override label, reset restored measured sizing. The
  unified path itself needs a Mac to exercise — logic shipped, untested on
  real Metal (this box has an NVIDIA runtime, so the branch can't trigger).

- **Concurrent-load budget + keep-warm (2026-07-14)** — models compete for
  the same memory, and in Nova concurrency is the COMMON case (a dispatch
  turn runs main's model and the sub-agent's in one request; automations
  fire in the background). New budget math over DISTINCT local models
  (many agents on one model = one Ollama load; cloud = zero): footprints
  from probe measurements where available, curated minimums as labeled
  estimates otherwise, split into VRAM and RAM pools. Surfaces: stacked
  VRAM/RAM bars in Settings → Inference for current assignments
  (GET /api/v1/models/budget) and for the suggested set inside Detect &
  suggest; recommend_models reports the same numbers. The engine runs a
  consolidation pass when the suggested set is over budget: least-critical
  profiles first (compaction < guard < tools < chat), moved onto the best
  candidate already in the set (no new load = no new footprint), reasons
  rewritten to describe the final pick, exact-rank ties keep the current
  model, unresolvable overage stays visible as a warning ("over budget
  doesn't crash — Ollama evicts or spills, felt as multi-second reloads").
  **Keep chat model loaded** setting + warmer loop: pins main's local model
  via native /api/generate keep_alive=-1 (the OpenAI-compat endpoint has no
  keep_alive), re-pins after Ollama restarts (60s tick), unpins on disable
  or model change; pinned model marked 📌 on the bars. Live-verified:
  natural over-budget case (32b estimate + probed 3b > 24 GB) triggered
  consolidation onto the already-suggested cloud model with local
  alternates intact; warmer pin/unpin verified against ollama /api/ps.

- **Auth-gated, curated-filtered model catalog (2026-07-14)** — dropdowns
  stopped showing "every model imaginable". Default catalog = models
  INSTALLED on running local backends + cloud models the operator approved
  (enabled curated rows); `?full=true` (and a "show full catalog" checkbox
  in Agents) = everything served by AUTHENTICATED providers; providers
  without credentials contribute nothing to any view (no OpenRouter key =
  no OpenRouter models — same rule for every future provider). The pin
  guard deliberately checks the FULL catalog: validity means "the provider
  serves it", not "it's on the approved list", so an uncurated-but-real
  assignment is never falsely flagged. list_models (tool) defaults to the
  approved view and reports how many more exist behind full=true.
  Verified: 344 → 4 models in the default view; the curated∩catalog
  intersection immediately caught a real seed bug (claude-sonnet-4-6 vs
  OpenRouter's actual claude-sonnet-4.6 — dots, not dashes; fixed in 018
  and live).

## Next up

1. **Named local-inference endpoints (multi-backend)** — users run LM
   Studio, llama.cpp, vLLM, not just Ollama. All are OpenAI-compatible for
   *serving* (our existing client already speaks it); none but Ollama expose
   a pull API (they manage their own downloads). Design: a registry of named
   endpoints `{name, url, kind}` (Settings-managed), catalog aggregation
   from each endpoint's /v1/models, model routing by endpoint (e.g.
   `local/lmstudio:<model>`), pull offered only where supported. The
   pull_model/list_models tool contracts are already backend-scoped in
   anticipation.

2. **Chat activity in the brain views (designed 2026-07-14, build later)** —
   while Nova is answering, the brain should visibly "think", whatever theme
   is active. Design:
   - *Contract*: extend `RendererHandle` (`frontend/src/brain/theme.ts`) with
     an optional `setActivity?(state: {active: boolean; kind?: 'thinking' |
     'dispatch' | 'tool'})` — the registry's optional-method pattern
     (`configure?`, `recenter?`) already covers "new views opt in"; no base
     class needed, TypeScript's interface is the extension seam.
   - *Wiring*: ChatPanel dispatches `nova:chat-activity` window events on
     stream start / activity frames / done; Brain.tsx forwards to the active
     renderer (same event bridge as `nova:setting-changed`).
   - *Galaxy treatment*: core glow pulse + slightly faster auto-orbit while
     active; a shooting-star particle arcing between random nodes on each
     tool event.
   - *Graph treatment*: soft node pulse / edge shimmer rippling outward from
     the center while active.
   - Chat-side feedback (bouncing dots + streaming cursor) shipped
     2026-07-14; this item is the brain-side half.

3. **Platform entities in the brain graph** — agents, automations, tools,
   and rules join the galaxy/graph as first-class nodes (skills are already
   there via memory). The brain becomes the full map of what Nova *is*:
   knowledge (topics), experience (journals), capabilities (skills, tools,
   agents), habits (automations), boundaries (rules). Design:
   - New `GET /api/v1/brain/graph` merges the memory graph with platform
     entities as typed nodes; distinct cluster colors (agents violet,
     automations blue, tools sage, rules red).
   - Real edges, not decoration: automation → its agent; agent → its
     allowed tools; rule → its target tools; disabled entities dimmed.
   - Clicking opens a per-type detail card (agent config, rule pattern +
     hit count, automation last-run) instead of the markdown panel.
   - HUD filter chips (or a Settings toggle) so the memory-only view stays
     one click away — ~40 extra nodes shouldn't drown the knowledge graph.

4. **PWA — Nova on the phone (until a native app)** — installable web app
   served from the same stack. The manifest/service-worker part is easy;
   the real prerequisites are exposure and layout. Ordered plan:
   1. *Auth first* (pulls the "Later" auth item forward): single admin
      token, required the moment anything binds beyond localhost.
   2. *Same-origin serving*: frontend built + served behind one origin
      with the API (nginx or FastAPI static) so cookies/tokens and the
      service worker scope behave; drop the hardcoded VITE_API_URL.
   3. *Responsive chat-first layout*: on small screens chat is the app
      (full-width, brain reachable via a tab/swipe); the galaxy stays a
      desktop-first surface.
   4. *PWA shell*: vite-plugin-pwa — manifest (name, icons, theme color),
      service worker caching the app shell only (chat is useless offline;
      don't pretend otherwise). iOS notes: needs HTTPS, install is manual
      "Add to Home Screen", web push works from iOS 16.4+ if wanted later.
   5. *Reachability*: recommend Tailscale (batteries-included,
      privacy-first — no public exposure, TLS via `tailscale serve`) with
      Cloudflare Tunnel as the public-facing alternative.

## Later

- **Auth** — required before exposing beyond localhost. Single admin token is
  enough for a first pass. (The PWA item above pulls this forward.)
- **Journal polish** — pre-rewrite journal files lack a `title:` frontmatter
  key, so the brain labels them by path. Cosmetic; fix by backfilling titles.
- **Device control agent** — computer-use loop (screenshot → reason → act)
  with per-platform drivers: ADB for Android, AppleScript/JXA + cliclick for
  macOS, xdotool/ydotool for Linux, pywinauto for Windows, plain SSH for WSL;
  iPhone is hardest (WebDriverAgent needs a dev cert — research). Must route
  through the guardrail/consent layer; highest-risk item on this list.
- **YouTube comprehension** — transcript-first (captions via yt-dlp), local
  Whisper fallback when captions are missing, keyframes + vision model for
  visual-heavy videos; decide summarize-into-memory vs index-full-transcript.
- **Coding agent(s)** — one general coding agent with strong tools (repo
  access, shell, file editing, test runner) first; specializations (reviewer,
  architect) as personas on the same harness, not bespoke agents. Needs
  sandboxed workspaces + branch/PR git discipline.
- **Diagramming agent** — Mermaid as the workhorse, raw SVG for freeform;
  render–verify loop (render, inspect with vision, self-correct) because
  text-only generation fails silently on layout; render inline in chat.

## Reference releases (mine for ideas, never build from)

Two tags preserve the pre-rebuild attempts. Neither worked as a product, so
this rebuild takes recipes and lessons from them (as the Galaxy theme already
did) — never code wholesale.

- **`v0.1.0-alpha`** — the v1 platform (May 2026). Worth mining: consent gate
  + capability audit log, AES-256-GCM secrets store (keys out of .env),
  benchmarks harness with LLM-judge quality cases, voice chat design
  (push-to-talk, sentence-buffered TTS), feature flags with kill switches.
- **`v0.5.0-alpha`** — the final v2 state (July 2026, tip of old main). Worth
  mining: the complete DESIGN.md design system (Plus Jakarta Sans / Geist
  Mono scale, Nova teal palette), model-accuracy guarantees (validated live
  discovery, pin guard — no config may point at a nonexistent model), local
  backend pool, safety rails (wall-clock kill, tool idempotency ledger,
  notification outbox), MCP lazy tool loading, cancel-and-replace chat
  streaming, the arialabs.ai website under `website/`.
- **`archive/v3-vite-scaffold`** — an abandoned June-22 restart (bare Vite
  scaffold, never ran); its NOVA_PLAN.md ideas are folded into "Later" above.
  Nothing else worth keeping.

## Operational notes

- `docker compose restart backend` does **not** re-read `.env` — use
  `docker compose up -d backend` after env changes.
- Migrations auto-run at backend startup from `backend/app/migrations/*.sql`
  (tracked in `schema_migrations`).
- Context budgets: `CONTEXT_BUDGET_OPENROUTER` / `CONTEXT_BUDGET_OLLAMA`
  (tokens); compaction: `COMPACTION_MIN_AGED`, `COMPACTION_MODEL` — all
  passed through compose to the backend.
- Memory files live in `./data/memory/` (gitignored) — human-readable, safe to
  edit by hand; the index rescans on startup and reindexes on write.
