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

- **Settings IA reorg + chat overflow fix (2026-07-14)** — the Inference
  section had become a junk drawer; split by concern instead of location:
  *Settings → Inference* = machine infra only (bundled toggle, Ollama URL,
  fallback model, memory override); new *Models tab* = inventory +
  governance (keep-warm, pull, the curated/approved table, a full-catalog
  browser for authenticated providers); *Agents tab* = assignment + its
  consequences (Detect & suggest and the concurrent-load bars now sit next
  to the model pickers they react to — change a model, watch the bar move).
  Decision from discussion: NO per-agent keep-warm toggles — pinning is
  model-scoped, not agent-scoped (shared models make per-agent toggles
  conflict), and latency value concentrates in main; if finer control is
  ever needed, it'll be per-model pin buttons on the load bar. Chat fix:
  fenced code without a language tag fell into the inline style inside a
  bare <pre> and overflowed the bubble — block chrome + horizontal scroll
  now live on <pre> itself (child selectors neutralize the inline chip),
  bubbles get min-w-0/break-words, the scroll column clips x.

- **Skills tab + act-don't-narrate (2026-07-14)** — investigated "Nova's
  created tool never showed in the Tools menu": the pipeline was fine (a
  created tool = a `tools` row = a Tools-tab card); the DB showed **no
  creation ever happened** — main streamed a complete spec plus "I'll wait
  for the tool-creator to confirm" without calling dispatch_to_agent.
  Countermeasures: migration 019 appends an explicit act-don't-narrate rule
  to main ("saying you're dispatching without calling the tool in the same
  turn is a failure"), and the probe earned its keep diagnosing the rest:
  the experimental main model (qwen3-vl-235b-thinking) PASSES the
  mechanical tool-call probe yet still narrates in rich agentic context —
  capability ≠ judgment, which is precisely what curated tool tiers encode.
  With main back on tier-A glm-5.2 the acid test landed end-to-end:
  dispatch → tool-creator → manage_tools → `github-profile-fetch` row,
  verified in the DB, not the transcript. **Skills tab**: skills join the
  overlay (7th tab) — list with title/description/category, expandable
  markdown view, edit-mode-gated create/edit/delete through the memory
  store (index reindexes on write; files in `data/memory/skills/` stay
  hand-editable). New endpoints GET/POST/PUT/DELETE `/api/v1/skills` with
  the same 403 gating + path-traversal guard as everything else; store
  gains a guarded delete_file and the index drops deleted docs. Verified:
  6/6 gating checks (403 off, CRUD on, traversal 404), skill created,
  updated, deleted through the API.

- **Agentic-judgment probe (2026-07-14)** — "test this model" now measures
  judgment, not just capability. New stage after the forced call: a
  two-round dispatch scenario verified mechanically — the model must CALL
  dispatch_to_agent (not describe one) and its final answer must contain a
  nonce that exists only in the tool result we feed back (consumed, not
  hallucinated). The history is deliberately poisoned with a
  narrated-but-never-performed dispatch — the exact live failure this
  exists to catch — so imitators fail. `ok` now requires both checks; the
  UI warns "⚠ calls tools when forced, but NARRATES in agentic context".
  Honest finding from live runs: glm-5.2, qwen3-vl-235b-thinking, AND
  qwen2.5:3b all pass, including the poisoned variant — vl-thinking's real
  narration required full production context (long compacted history, big
  prompt, ten tools). The probe is a floor/screen, not a guarantee;
  migration 019 + tier discipline remain the operative protection, and
  live narration detection belongs to the observability item below.

- **Narration detector (2026-07-14)** — the observability item's cheapest
  piece, pulled forward. At end of every agent turn the runner knows two
  facts with certainty: the final text and how many tools actually
  executed. If the text ANNOUNCES actions ("I'll dispatch…", "let me
  create…", "is now live", "waiting for X to confirm") while zero tools
  ran, the turn is flagged: an amber banner in chat ("announced an action
  but called no tool — the described work did NOT happen"), a WARNING log
  with agent+model, and a system journal entry so narration rates per
  model accumulate as searchable memory. Questions, conditionals, and
  past-tense recaps are deliberately not matched — asking permission is
  correct behavior. Heuristic by design: a floor that turns silent
  failures loud, not a guarantee. Verified against reality: both of
  today's actual narrated turns (pulled from the messages table) flag; a
  fabricated "is now created and live!" with zero calls flags while the
  same words after real calls don't; questions/recaps/plain answers pass
  8/8; a live chat turn produces no false banner. Works at any dispatch
  depth and for automations (single choke point in run_agent).

- **Real toggles + model uninstall (2026-07-14)** — the "enabled" text
  chips confused even their owner; they're now real switches with
  domain-specific labels and self-explaining tooltips: agents "active"
  (leaves the dispatch index), curated models "approved" (feeds
  suggestions + dropdowns), automations "active" (kill switch), rules
  "enforcing", tools "active". The control itself stays — disable is the
  ONLY off-switch for undeletable system entities, so removal was never an
  option; it just has to explain itself. Plus uninstall for installed
  local models (curated rows + full catalog): proxies Ollama's native
  /api/delete, invalidates the catalog, and REFUSES with a 409 naming the
  users while any agent or setting still points at the model. Verified:
  409 correctly listed "compaction (setting), local fallback (setting)"
  for qwen2.5:3b; full pull → uninstall → gone cycle on qwen2.5:0.5b.

- **Delete capability + always-active system agents + persistent activity
  trail (2026-07-14)** — the 19:24 incident ("✅ skill deleted", zero tool
  calls, file untouched — narration detector caught it live) exposed a
  capability hole: NO agent tool could delete anything, so even a perfect
  dispatch would have dead-ended. New `delete_memory_item` builtin
  (skills/ and topics/ only — journals are the audit trail, identity is
  excluded by path AND the protect-soul rule now watches it), granted to
  skill-manager with confirm-from-status prompt discipline (migration
  020). Acid test: dispatch → search → read → delete, file verifiably
  gone. Operator decisions shipped alongside: **system agents are always
  active** ("always active" badge instead of a toggle; API 403s disable
  attempts — rules and tool grants are the constraint mechanisms), and the
  **activity trail persists across refresh**: tool rows return with
  history and past turns render as dim collapsible "⚙ N agent actions"
  traces, narration warnings staying visible (dimmed) — you can audit any
  old request/response without it shouting. Curated-table hint now says
  "Approved" to match its switch.

- **Platform entities in the brain + configurable memory home
  (2026-07-14)** — the brain is now the full map of what Nova IS.
  `GET /api/v1/brain/graph` merges the memory graph with a golden **Nova
  core**, agents (violet), granted tools (sage), automations (blue), and
  rules (red) — REAL edges only: core→agent, agent→granted-tool (db:*
  resolved), automation→executing-agent, rule→target tools/agents;
  switched-off entities render dimmed. Works in BOTH renderers (galaxy
  clusters them as named constellations; graph colors by type), toggleable
  via Settings → Appearance → "Platform entities in the brain"
  (knowledge-only view one click away). Clicking a platform node opens a
  detail card from its metadata (v1 = description; richer per-type cards —
  rule hit counts, automation last-run — can ride the observability work).
  Verified: 41 nodes / 53 edges, zero dangling references, guard edges
  resolve to the right tools. Also fixed: the Graph theme thumbnail
  rendered dark because the force layout's spread dwarfs the 220×130
  preview — it now fits-to-view after the simulation settles, and preview
  sample data includes platform nodes. **Memory home is configurable**:
  `NOVA_MEMORY_DIR` in .env points the markdown store at a NAS mount or
  Obsidian vault (README documents it); cloud sync stays a designed-later
  item (see Later).

- **PWA — Nova on the phone (2026-07-14)** — the whole ordered plan shipped
  in one pass. **Auth**: single admin token (`NOVA_AUTH_TOKEN`, empty =
  open localhost dev), constant-time-compared middleware on /api/* with
  /health public, a login gate in the UI (token stored per device);
  every host port now binds 127.0.0.1 only. **Same-origin**: API URLs are
  relative everywhere; the vite dev server proxies /api (dev stays :5173 +
  HMR) and a new `web` service (multi-stage build → nginx, 127.0.0.1:8080)
  serves the built PWA + proxies the API with SSE-safe settings — one
  origin, so the service worker and the token behave. **Responsive**:
  under 768px chat IS the app (full width, no drag handle) with a 🧠/💬
  toggle to visit the brain; overlays fit small screens. **Shell**:
  vite-plugin-pwa manifest + autoupdating service worker that caches the
  app shell ONLY (chat is useless offline; don't pretend otherwise);
  icons generated programmatically (pure-python PNG writer — no image
  tooling on the host). **Reachability is deployment, not app code** —
  zero provider integrations, README documents `tailscale serve --bg 8080`
  as the recommendation (private by default, TLS certs for free — iOS
  refuses PWAs without HTTPS) and Cloudflare Tunnel as the public
  alternative. Live-verified: 401 without token / 200 with; manifest, SW,
  icons served; a real SSE chat turn streamed through :8080 with auth.
  NOT yet verified on an actual phone — no device in this loop. Bonus bug:
  a stale tracked `vite.config.js` (old tsc emit) was silently shadowing
  `vite.config.ts` — vite prefers .js; removed + git/dockerignored.

- **Tailscale sidecar + per-platform reachability walkthrough
  (2026-07-14)** — the platform matrix (WSL2 vs Linux vs macOS) collapsed
  two ways. Docs: the README phone section now walks each host-side path
  (Linux/mac near-identical; WSL2 gets both the Windows-client route with
  the localhost-forwarding check and the systemd-in-WSL route). Product:
  an optional `tailscale` compose profile — the official image in
  USERSPACE mode (no NET_ADMIN, no /dev/net/tun; inbound proxy only)
  joins the tailnet as node "nova" and serves the web origin at
  https://nova.<tailnet>.ts.net via a baked serve.json (${TS_CERT_DOMAIN}
  → proxy http://web:80). TS_AUTHKEY consumed once, identity persists in
  the tailscale_state volume; requires MagicDNS + HTTPS certs enabled on
  the tailnet (documented). Verified to the honest limit: compose
  validates, sidecar boots to NeedsLogin with the serve config mounted —
  the last hop needs a real tailnet key, which only the operator holds.
  Also removed the obsolete compose `version:` attribute.

## Next up

1. **Voice — talking to and hearing Nova (decided 2026-07-14; phase 1 +
   1b SHIPPED 2026-07-15)** — full spec + phase status in
   `docs/plans/voice.md`. Phase 1 (spoken replies: kokoro TTS service,
   sentence-buffered streaming, emoji/number normalization, list pauses,
   pause/resume/stop controls) and phase 1b (54-voice picker with preview,
   swappable `voice.model_override` LLM) are live-verified. Phases 2–4
   (STT: push-to-talk → VAD → wake word) are the remaining build.
   Original decisions: **TTS** local-first Kokoro-class as the batteries-included
   default with premium cloud (ElevenLabs/OpenAI) as keyed opt-in; **STT**
   local faster-whisper (the 3090 makes this fast) with silero-VAD for
   utterance endpointing; **interaction: wake word** ("Nova …") as the
   target UX — Jeremy chose it over my push-to-talk recommendation, so:
   wake detection runs server-side (openWakeOrd-class, tiny CPU) on a
   continuous mic stream over the tailnet WebSocket while the app is OPEN;
   push-to-talk ships anyway as the built-in fallback (same capture path,
   needed for mic-denied/failed-wake cases). HONEST PLATFORM LIMIT: a PWA
   cannot listen in the background or with the screen locked (iOS
   foreground-only mic) — always-on ambient listening needs a native app
   or dedicated device (later item). Streaming: sentence-buffered TTS
   (speech starts before the reply finishes — v0.1.0-alpha recipe), audio
   levels drive the entity view. New compose services: whisper (STT+VAD)
   and kokoro (TTS), both local, both optional profiles like ollama.

2. **Nova entity view (mockups first — no repo code until approved)** — a
   third brain view: Nova as a particle/filament presence, per the
   references (2026-07-14): a face that CONDENSES when engaged and
   DISSOLVES to an ambient particle wisp when idle — never "closed", just
   dispersed. State machine: ACTIVE (bright, energy filaments,
   voice/activity-reactive) → FADING (~5s after interaction stops) →
   IDLE/DISSOLVED (~15s, faint drifting cloud). Decided 2026-07-14: the
   face is **stylized androgynous** (a presence, not a person — no uncanny
   valley, no implied identity); asset needs sourcing/sculpting, the
   mockup's scanned head is a stand-in for feel only. Slots into the
   THEMES registry as a third renderer; the planned `setActivity` contract
   (brain-activity item) is the same plumbing it needs, and voice audio
   levels are its energy input. Interactive HTML mockups live in
   references_delete_when_done/mockups/ until Jeremy approves.
   **Refined 2026-07-16 (Jeremy):** rename the picker "Brain view" →
   "Nova view" with three options: Graph (obsidian-like), Galaxy (current),
   and **Nova** — no memory nodes at all, just a glowing orb or line with
   distinct animations per state (listening / speaking / thinking /
   working), in the vein of the Gemini/ChatGPT app orbs and movie AIs
   (Jarvis). This is a SIMPLER v1 than the particle-face concept above —
   ship the orb first (state machine + `setActivity` + `speaker.level()`
   are the inputs; micState/wake give "listening"), keep the face as the
   aspirational later pass. Each state animation is its own design task.

3. **Observability / turn tracing (brainstorm needed)** — today's
   narration bug was diagnosed by hand-querying the messages table; that
   should be a click. Axes to work through together:
   - *What exists*: messages journal tool activity (kind/name/agent +
     2000-char detail), automation run outcomes, rule hit counts, docker
     logs. Enough for autopsies, only via psql.
   - *Trace model*: turn → dispatch → tool-call spans (args, result,
     status, latency, tokens), correlation id through dispatch depth;
     Postgres tables vs OpenTelemetry; retention/pruning policy.
   - *Surfaces*: per-message "inspect" in chat expanding the turn tree; a
     Traces tab; errors surfaced in the UI instead of vanishing into
     docker logs.
   - *Metrics*: per-model latency/tokens/cost per turn — real usage data
     that could feed back into curated tiers and recommendations.
   - *Failure detectors*: a live narration detector (final text announces
     a dispatch, zero tool calls in the turn → flag the turn, journal it)
     — cheap, and catches today's bug class as it happens rather than in
     autopsy.
   - *Redaction*: tool args can carry secrets; interplay with guardian
     rules and the no-secret-in-requests pattern.

4. **Mobile PWA routes/pages (needs design)** — the phone build reuses the
   desktop single-view (chat over brain with a toggle); real phone UX
   wants distinct routes/pages sized for the form factor. To design with
   Jeremy after first real on-device usage: which surfaces earn a page
   (chat, brain, settings/models/agents management?), navigation pattern
   (bottom tabs vs drawer), whether deep links matter
   (nova.ts.net/settings), and what stays desktop-only (the galaxy is
   desktop-first by design). Frontend currently has no router — adding
   one (react-router or hash-based) is part of this item.

5. **Self-updating model curation (proposal flow)** — the curated table
   must not rot, or recommendations rot with it. A scheduled automation has
   model-manager (with web_search/fetch_url) research newly released local
   and cloud models and PROPOSE curated rows: inserted **disabled**, never
   auto-approved, with a journal report of what was found and why it might
   matter. The operator's enable click remains the approval gate for
   dropdowns and recommendations — the conversational lane never holds
   approval power (guardian principle). Also in scope: refreshing stale
   rows (pricing, superseded models) and flagging dead ones (models the
   pin guard says providers no longer serve). Needs a `manage_curated`
   tool granted to model-manager whose writes always land disabled.

6. **Named local-inference endpoints (multi-backend)** — users run LM
   Studio, llama.cpp, vLLM, not just Ollama. All are OpenAI-compatible for
   *serving* (our existing client already speaks it); none but Ollama expose
   a pull API (they manage their own downloads). Design: a registry of named
   endpoints `{name, url, kind}` (Settings-managed), catalog aggregation
   from each endpoint's /v1/models, model routing by endpoint (e.g.
   `local/lmstudio:<model>`), pull offered only where supported. The
   pull_model/list_models tool contracts are already backend-scoped in
   anticipation.

7. **Chat activity in the brain views (designed 2026-07-14, build later)** —
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

8. **Video ingestion — watch a video or a source, source-agnostic
   (requested 2026-07-15, spec'd; generalized beyond YouTube per Jeremy's
   same-day follow-up)** — point Nova at a video from any supported site
   (or a direct media URL) and she ingests the content into memory; point
   her at a source (a creator/channel/playlist page) and she backfills
   past uploads and monitors for new ones. Full spec: `docs/plans/video-
   ingestion.md`. Shape: a small `media` worker service built on **yt-dlp
   (1000+ sites — YouTube, Vimeo, Twitch, …) + ffmpeg** pulls captions
   when a site offers them and falls back to the **same whisper service
   the voice lane builds** for audio→text — that fallback is the universal
   path that makes it source-agnostic (real synergy: build voice phase 2
   first and this gets STT for free). Transcripts land as chunked,
   timestamped markdown notes in memory (retrieval cites the video with
   the site's native deep link); "watch a source" is a subscriptions table
   polled by a scheduled automation that re-enumerates the source (YouTube
   RSS as an optional fast-path). Dedupe is source-neutral
   (`<extractor>:<id>`). Batteries-included (no API keys — yt-dlp is
   keyless). Depends on: whisper service (voice phase 2) for the
   transcription fallback; the automations/scheduler infra (exists) for
   source polling. Open decisions flagged in the spec (backfill caps,
   per-video summarization, auth/ToS posture, which non-YouTube sources to
   target first).

9. **Memory-link traversal in node details (requested 2026-07-16)** — graph
   and galaxy edges exist visually, but clicking an orb shows a detail
   panel with NO list of its connections. Add a "Linked" section to the
   detail panel (sidebar + modal): the node's neighbors from the already-
   fetched edge list, each clickable → `openDetail(neighborId)`, so you can
   traverse memory-to-memory without hunting the canvas. Small, contained:
   Brain.tsx has nodes+edges in hand; the detail panel just never got the
   adjacency list.

10. **Voice conversation mode — follow-up window (requested 2026-07-16)** —
   NotebookLM-style back-and-forth: after waking her once, keep the
   conversation open so replies don't each need "Hey Nova". Spec sketch in
   `docs/plans/voice.md` §4e: after Nova's spoken reply ends (or is
   interrupted), re-arm the VAD for an N-second follow-up window (no wake
   needed); speech within it = next turn, silence closes it back to
   wake-only. Barge-in already exists; this is state-machine work in
   ChatPanel plus settings (window length, on/off) and a visible
   "still listening" indicator.

11. **Wake word learns from use (requested 2026-07-16: "can that get
   better with use?" — yes)** — the training pipeline
   (tools/wake-training) can retrain in minutes; what's missing is REAL
   examples of the operator's voice. Design: (a) **enrollment** (fastest
   win): a Settings flow records N repetitions of the phrase (+ a few
   sentences of the operator's normal speech as negatives), drops them in
   the training corpus with heavy weight, retrains, hot-swaps the ONNX.
   (b) **passive improvement** (opt-in, all local): on each wake fire,
   keep the trigger audio; fires followed by a completed voice turn =
   confirmed positives, fires the user immediately cancels = false-fire
   negatives; a "shadow threshold" (log score peaks above ~0.05 that
   DIDN'T fire) catches the near-misses — Jeremy's exact symptom (had to
   slow-enunciate; natural cadence under-scores). Periodic retrain folds
   them in. Voice audio is biometric-adjacent: explicit opt-in, local
   only, browsable/deletable clips. The nova.wakeDebug console readout
   (shipped) is the manual precursor — read your scores, tune the
   threshold.

12. **Human-like replies — the persona pass (requested 2026-07-16)** —
   Jarvis-from-Iron-Man / Sarah-from-Eureka register: warm, wry, concise,
   context-aware; "what time is it?" gets the time, not a paragraph.
   Queued with root-cause notes in auto-memory (fable-humanize-responses):
   voice model now answers accurately (qwen3:8b), remaining work is
   prompt/persona — stop the system blocks being parroted, terseness
   guidance, soul.md voice. Jeremy asked to run this session on Fable.

## Later

- **Speaker identification + per-person context (family, requested
  2026-07-16)** — Nova detects WHO she's talking with and adjusts tone and
  context (kid vs. spouse vs. operator). Technically feasible on-device:
  speaker-embedding models (ECAPA-class) + a short enrollment per family
  member ("say a few sentences"), match each utterance's embedding at
  wake/capture time. HONEST CAUTIONS that make this a "dig in deeper"
  design, not a weekend build: misidentification is worse than no
  identification (wrong-person context leaking across family members is a
  privacy failure inside the household); kids' voices drift; and
  per-person context implies a real multi-user model (per-person memory
  scopes, what the shared brain knows vs. what stays operator-only) —
  that's a product decision before it's an ML one. Voice fingerprints are
  biometrics: on-device only, explicit enrollment, easy deletion.

- **In-UI secrets store** — the real "configure in the UI, not .env" win:
  OpenRouter (and future provider) keys entered in Settings, encrypted at
  rest, hot-reloaded — no .env edit, no restart. Mine `v0.1.0-alpha`'s
  AES-256-GCM secrets store design (keys out of .env was its explicit
  goal). Auth shipped 2026-07-14 (single admin token), so the gate this
  needed now exists; still interacts with the guardian's
  no-secret-in-requests rule.
- **Remote shared state — one brain, many machines (feasible, designed
  2026-07-14)** — Jeremy's personal/work-computer case: postgres + data
  live centrally, every Nova instance points at them and behaves as the
  same entity. Verdict: feasible with three known engineering points.
  (1) *Postgres remote* is standard: `DATABASE_URL` already env — point it
  at one PG over the tailnet (home server/NAS/managed); per-turn query
  latency over WireGuard is fine; the local postgres service simply goes
  unused on secondary instances. (2) *Memory over a network mount*:
  `NOVA_MEMORY_DIR` at NFS/SMB works today, BUT each instance's BM25
  index is in-process and only rescans at startup — instance B sees A's
  new memories after restart until a file-watcher lands (same watcher the
  sync-pipeline item needs); concurrent same-file writes (two instances
  appending today's journal) need per-file locking or accepted
  last-writer-wins. (3) *Singleton background work*: automations
  scheduler, model warmer, and compaction would DOUBLE-RUN with two
  backends on one DB — they need leader election (postgres advisory lock:
  one line to take, holder runs the loops, others stand by). Local
  inference (ollama) stays per-instance by design — same brain, different
  muscles. Until built, the working answer is one instance + tailnet PWA
  from every device (verified live today).
- **Memory sync pipeline (local-first cloud/NAS/vault)** — `NOVA_MEMORY_DIR`
  already points the store anywhere mountable; this item is about SYNC, not
  location. Direction from the 2026-07-14 discussion: local stays the
  write path and source of truth (agents read/write markdown at local
  latency; the BM25 index never leaves), with a one-way publish step after
  ingestion settles — new/updated topics and skills replicate outward
  (rclone/Syncthing-style, or straight into an Obsidian-synced vault);
  journals may lag or stay local. Inbound edits (vault edited on another
  device) arrive as files and are picked up by the startup rescan — add a
  file-watcher for live pickup. Conflict policy: last-writer-wins per file
  is fine for markdown at this scale; provenance frontmatter already
  timestamps everything. Prerequisite thinking: secrets never live in
  memory files (checked), and the guardian's no-secret rule should watch
  any future push tool.
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
