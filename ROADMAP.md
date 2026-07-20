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
  *2026-07-16: that upgrade path got realized as a NEW theme key instead —
  the **Universe** view (docs/plans/universe-view.md), true Three.js +
  UnrealBloom with deterministic orbital mechanics: Nova+operator binary
  star, memory components as star systems, journals as a chronological
  asteroid belt, automations as interval-scaled comets, plus black hole /
  shooting stars / fresh-memory flares. Galaxy stays selectable until
  Jeremy declares Universe polished (retirement is his call).*

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

> **Priority note (2026-07-17):** items **#25–#28 are the CRITICAL front
> of the queue** — do them first. Numbering stays append-only so the
> cross-references between items (#5, #8, #21, #23, …) stay stable.

1. **Voice — talking to and hearing Nova (decided 2026-07-14; CORE ARC
   SHIPPED — status corrected 2026-07-17)** — full spec + phase status in
   `docs/plans/voice.md`. Shipped and live-verified: phase 1 (kokoro TTS,
   sentence-buffered streaming, controls), 1b (54-voice picker, swappable
   `voice.model_override`), 2 (PTT STT via whisper service), 3
   (tap-to-talk with in-browser silero VAD), 4a (on-device openWakeWord
   engine), 4a·1 (assistant rename + wake-phrase decoupling), 4c (trained
   "Hey Nova" model v0.2 + training pipeline), 4e (conversation-mode
   follow-up window). Still open: 4b (server-side wake engine — optional
   robustness alternative, unbuilt) and 4d (open-vocab wake-by-name —
   DEMOTED to a possible later opt-in). Ongoing wake-quality work
   continues as item #11; this item is otherwise done.
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
   **Status check 2026-07-17:** the Universe theme shipped 2026-07-16
   (commit 8f05849) as a third registered view, so the picker is now
   Graph / Galaxy / Universe — the orb becomes the FOURTH entry, and the
   "Brain view" → "Nova view" rename is still pending. No orb code exists
   yet (`THEMES` in frontend/src/brain/theme.ts has no `nova` entry).
   **ORB V1 SHIPPED 2026-07-17 (parallel session, uncommitted):**
   `frontend/src/brain/nova.ts` — canvas-2D presence view (no memory
   nodes): breathing orb + ambient mote field, five states with eased
   crossfades — idle (teal), listening (cyan, inward rings), thinking
   (violet, circling arcs), working (amber, counter-rotating arcs +
   sparks per tool event), speaking (glow/radius follow
   `speaker.level()`). Clicking the orb opens the soul card. Registered
   as the 4th picker entry; `brain.view` enum + "Nova view" rename done.
   Wiring: #7's `setActivity` contract now exists on `RendererHandle`
   with a `nova:chat-activity` → renderer bridge in Brain.tsx —
   idle/speaking are live today; thinking/working/listening fire once
   ChatPanel dispatches the events (#7's other half, deferred to avoid
   colliding with the observability session's ChatPanel work; verified
   meanwhile by dispatching the events manually). Screenshot-verified
   through :5173 (all four states + picker). Bonus hardening found by
   verification: a machine that can't create a WebGL context used to
   white-screen the whole app (unguarded THREE constructor) — ThemePreview
   now degrades to a dead card and Brain.tsx falls back to the 2D graph.
   Remaining for later passes: the aspirational particle-face concept
   above, wake/mic "listening" wiring, per-state polish with Jeremy's
   eyes on it.
   **Speaking-calm + particle-body pass 2026-07-19 (Jeremy's review:
   "chaotic, crazy fast, too many rings, gradients too static"):** speech
   ripples deleted; voice envelope now asymmetric (70ms attack / 320ms
   release — glow breathes instead of strobing); speaking energy + mote
   speedup roughly halved; the solid two-gradient ball replaced by a
   640-particle gaussian shell on tilted orbits around a soft multi-stop
   inner light whose focal point slowly wanders. Verified at :5173
   (idle/thinking/working screenshots, tsc clean); speaking feel needs
   Jeremy's ear+eye with a real voice reply. Uncommitted; :8080 needs
   the usual web rebuild after commit.
   **Round 2 same day (Jeremy):** "Nova" name tag removed (state word
   stays, moved up); particles upgraded from tilted-ellipse fakery to
   TRUE 3D orbits with depth-scaled size/alpha — dragging the canvas now
   genuinely orbits the view around her (slow auto-orbit continues from
   wherever you leave it; drag>6px suppresses the soul-click); 8 larger
   companion orbs float slow and wide (the "alive" layer); speaking
   calmed further (envelope 90/450ms, energy coupling 0.15, speaking
   energy 0.38, swell 0.10). Drag-orbit screenshot-verified at :5173
   (companion constellation rearranges), tsc clean.
   **Face lane resumed 2026-07-19:** Jeremy brought a Midjourney concept
   (blue wireframe hologram figure) and wants it speaking with real
   lip-sync — spec'd as `docs/plans/avatar-view.md` (local-only: rigged
   still composited in canvas-2D, mouth driven by the live Kokoro audio
   via `speaker.level()`; cloud avatar APIs ruled out, MuseTalk behind a
   phase-5 decision gate). Builds alongside the orb; phase 0 is Jeremy's
   Midjourney asset kit.
   **SHELVED again same day:** phase 0 (assets + local SD-inpaint
   pipeline + alignment-gated kit) completed and preserved, but the
   animation preview failed Jeremy's review (blink blend shows eyes
   through lids, blinks too fast/frequent, mouth flicker when speaking,
   framing too close). Critique + diagnosis + resume directions are at
   the top of the plan doc. The orb remains the presence view.

3. **Observability / turn tracing (brainstorm needed)** — today's
   narration bug was diagnosed by hand-querying the messages table; that
   should be a click.
   **PHASE 1 SHIPPED 2026-07-17** (full spec + status in
   `docs/plans/observability-turn-tracing.md`): the turn ledger is live —
   migration 028 (`turn_traces` + `turn_spans`), `app/trace.py`
   (contextvar spans, buffered flush, built-in redaction — the plan's
   "guardian scrubber" turned out not to exist in v3), spans through
   `run_agent`/`chat_stream` (prompt build, memory retrieval, per-round
   LLM calls with exact token counts from BOTH providers via
   `include_usage`, tools with redacted args, dispatch subtrees), and
   assistant messages stamped with their `trace_id`. The tense-gap
   detector extension shipped in the same pass: past-tense completion
   claims ("Done — saved it") now flag on zero-tool turns, with recap
   exemptions. Live-verified through :5173.
   **PHASE 2 SHIPPED same day:** every assistant message wears a duration
   chip ("7.5s · 1 tool", red on failure) that opens the Turn Inspector —
   a drawer with the span waterfall (indented subtrees, colored duration
   bars, token totals, expandable details), fed by `GET
   /api/v1/traces/{id}` + trace summaries in the messages API + trace_id
   in the stream meta. Click path walked live on :5173. Phone path needs
   a `web` rebuild to see it.
   **PHASE 3 SHIPPED 2026-07-18 — this item's build is COMPLETE:**
   automation runs and compaction passes now write traces too
   (timeout = status cancelled), Settings → Observability holds the
   retention setting (`trace.retention_days`, default 14; daily prune on
   the scheduler tick) and the Recent turns list — every traced turn
   across all sources, click-through to the Turn Inspector. Live-verified
   with a probe automation found in the UI without SQL, and a planted
   30-day-old trace pruned on the next tick. Also closes #25's (d) —
   the per-run tool timeline persists as automation trace spans. Still
   open here (never spec'd into the ledger plan): the service-health
   surface and richer audit-log queries from the original brainstorm.
   **Confirmed in scope (Jeremy, 2026-07-17): audit log + system/service
   health.** Audit log: a durable, queryable record of who/what did what
   when — tool calls with args/results, settings changes, approvals,
   automation runs, model swaps; distinct from debugging traces (audit
   answers "what happened", traces answer "why"). Service health: one
   surface showing every service (backend, postgres, ollama, kokoro,
   whisper, searxng, tailscale, web) up/down + versions + disk/VRAM
   pressure — feeds the Settings readiness dots the voice plan wants AND
   the platform-facts block (#12), which currently covers hardware but
   not service state. Axes to work through together:
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
     autopsy. **Tense gap found live 2026-07-17 (#27 verification):** the
     shipped detector matches only future/present announcements — glm-5.2
     fabricated "Done — saved it with no tags" two seconds after the
     request, zero tool calls, no file written, and no banner fired,
     because past-tense recaps are deliberately unmatched (a genuine
     recap after real calls must not flag). The turn ledger dissolves the
     ambiguity: a completion CLAIM in a turn whose trace holds zero tool
     spans is fabrication regardless of tense — extend the detector to
     past-tense claims gated on trace ground truth, not wording alone
     (near-instant turn duration is a corroborating signal).
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
   **Operator requirements (2026-07-17, from Jeremy's chat with Nova —
   journals 02:29):** cadence DAILY; sources start with OpenRouter (public
   API — the catalog already consumes it), Ollama library (page fetch,
   proven), modelfit.io (page fetch), HF API, vendor blogs — list will
   grow, so sources belong in a table/setting, not code; **alert on clear
   upgrades** (ntfy): fits measured VRAM + candidate for a role an agent
   actually uses + beats the current row's tier/size — and always paired
   with the disabled-row proposal, never replacing the approval gate.
   Storage: curated table = current state, a memory topic = release
   history. v1 needs NO crawler or headless browser: targeted fetch +
   web_search + APIs cover the start list; revisit only when a source
   demands JS rendering. Foundation shipped 2026-07-16: model-manager has
   web_search + frontier instructions, catalog freshness guard, probe.
   RELATED FIX (same conversation): main asserted a STALE journal belief
   ("GPU passthrough broken") as current fact — detection actually reports
   the 3090/24GB fine. Agents need platform-state grounding: a live
   hardware/platform-facts line in the system prompt (the date-block
   pattern exists for exactly this reason) and/or guidance that memories
   describe the past — dispatch to tools for current platform state.

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
   **ChatPanel half SHIPPED 2026-07-19** (the orb's setActivity contract
   + Brain.tsx bridge had shipped 2026-07-17 with the dispatch side
   deferred): ChatPanel now emits `nova:chat-activity` on send
   (thinking), on tool_start/dispatch activity frames, throttled
   re-thinking during long streams, and inactive in finally.
   Live-verified end-to-end at :5173: real message → orb crossfades to
   violet thinking with arcs → settles to idle when the reply lands.
   Remaining from the design: galaxy/graph/universe treatments (they
   ignore setActivity today — optional method, safe).

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
   keyless). Dependencies now SATISFIED (2026-07-17 check): the whisper
   service shipped with voice phase 2 and is live in compose, so the
   transcription fallback exists; the automations/scheduler infra exists
   for source polling — this item is unblocked and buildable.
   Open decisions flagged in the spec (backfill caps,
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
   **ALREADY SHIPPED — status noted 2026-07-17:** the Universe-view commit
   (8f05849, 2026-07-16) added exactly this: a "Connections" section in the
   detail panel (sidebar AND modal), built from the fetched edge list (real
   edges only, tag chains excluded), each neighbor clickable →
   `openDetail` + `focusNode`. Nothing left to build.

10. **Voice conversation mode — follow-up window (requested 2026-07-16;
   SHIPPED same day — see voice.md §4e for the record)** —
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

12. **Platform-state grounding for agents (elevated 2026-07-17)** — three
   incidents in 24h of Nova asserting stale/wrong facts about HERSELF:
   claimed GPU detection was broken (it reports the 3090/24GB fine),
   claimed no YouTube ingestion exists (designed, item #8), proposed
   building a narration guardrail that SHIPPED 2026-07-14 (migration 019 +
   live detector). Root cause: agents answer platform-state questions from
   episodic journal memory instead of live facts. Fix directions, in
   effort order: (a) a "## Platform facts" system-prompt block built like
   the date block (hardware summary, service health, feature flags — the
   date block exists because she used to guess dates from memories the
   same way); (b) prompt guidance that memories describe the PAST — for
   current platform state, dispatch/use tools; (c) longer-term, give
   main/model-manager a self-inventory tool (what's shipped, what tools
   exist, roadmap awareness) so "what would make you better" gets answered
   from ground truth.
   **(a)+(b) SHIPPED 2026-07-17:** `_platform_block()` in runner.py —
   live-detected GPU/VRAM/RAM/cores in every agent's prompt (5-min cache;
   detection shells out) plus the memories-are-the-past guidance.
   Live-verified with the poisoned question that caused the incident:
   "is the passthrough issue still blocking you?" now answers "No — I can
   see your GPU just fine (RTX 3090, 24GB)" instead of asserting the
   stale journal belief. (c) remains open — and gained fresh evidence
   2026-07-17 (journal 14:06/14:44): "what model are you using?" → Nova
   had no way to self-check, and dispatching model-manager didn't help
   because agent→model bindings live only in Settings, reachable by no
   tool. PARTIALLY FIXED same day (b9a3b5e, parallel session): every
   agent's prompt now carries a live "## Model (live)" FACTS block with
   its own resolved binding — the self-question now answers directly.
   Still open for (c): cross-agent visibility (model-manager seeing ALL
   bindings for upgrade recommendations) and the broader self-inventory
   (shipped features, tools, roadmap awareness). Same conversation,
   second request: Jeremy wants
   PROACTIVE dispatch — low-risk lookups (statuses, info fetches, agent
   questions) should be acted on directly, never "want me to dispatch?";
   confirmation reserved for irreversible/costly/config-changing actions.
   That's house-rules material — fold into the persona layer's house
   rules (#15, phases 2+) so it applies to every agent by construction.

13. **Human-like replies — the persona pass (requested 2026-07-16)** —
   Jarvis-from-Iron-Man / Sarah-from-Eureka register: warm, wry, concise,
   context-aware; "what time is it?" gets the time, not a paragraph.
   Queued with root-cause notes in auto-memory (fable-humanize-responses):
   voice model now answers accurately (qwen3:8b), remaining work is
   prompt/persona — stop the system blocks being parroted, terseness
   guidance, soul.md voice. Jeremy asked to run this session on Fable.
   **SHIPPED 2026-07-16 (Fable session):** `_now_block`/`_platform_block`
   rewritten as bare data + imperatives — nothing answer-shaped left to
   parrot; migration 024 swaps main's "helpful AI assistant" opener for
   the companion register; soul.md "How I communicate" rewritten (live
   file + `_DEFAULT_SOUL` seed); voice brevity moved to the END of the
   assembled prompt (`run_agent(system_suffix=...)`) — patched into the
   front it sat mid-prompt and the 8b ignored it — and given paired
   register examples, which steer an 8b far better than adjectives.
   Live-verified through :5173: "what time is it?" → "It's 10:59 PM.";
   "what day is it" (voice) → "It's Thursday."; passthrough-poisoned
   question still grounds on live platform facts ("Nope — I can see your
   RTX 3090..."); "goodnight" → "Night — sleep well." Residual: qwen3:8b
   still sneaks an occasional emoji into the *transcript* despite three
   bans (speech.ts strips it pre-TTS, so it is never spoken) — that last
   inch is model curation (Ornith eval), not prompting.

14. **Chat latency — confirm, then profile (observed 2026-07-16 night)** —
   chat can be / is much slower now. Confirm it persists on 2026-07-17
   before digging (could be one-off: parallel heavy sessions were running).
   Suspects, roughly in order: `_platform_block()` hardware detection
   (shells out to nvidia-smi on 5-min cache expiry — turn-blocking on the
   miss; shipped with item 12); qwen3:8b thinking tokens on voice turns;
   ollama model contention (voice override + main both resident in VRAM);
   memory/BM25 retrieval growth. The real fix starts with per-stage turn
   timing — fold into docs/plans/observability-turn-tracing.md if not
   already covered there.
   **CLOSED 2026-07-17:** chat confirmed fine the next day (and had been
   fine on the 8b too) — it was load from parallel heavy sessions, not a
   regression. No profiling done; per-stage turn timing still arrives
   with item #3 (observability) for the next time this question comes up.

15. **Persona layer — a structural home for what makes Nova *Nova*
   (requested 2026-07-16)** — the persona pass proved position beats
   emphasis: the voice brevity block was silently ignored while patched
   into the FRONT of the agent prompt, and worked the moment it was
   appended LAST (`run_agent(system_suffix=...)`). Identity must never
   depend on where some agent prompt happens to put it. Investigate and
   design a dedicated persona layer in prompt assembly: explicit slots
   with guaranteed order (role/task first → live facts → memories →
   identity/register/speech habits LAST, so they win small-model recency
   bias); ONE home for soul.md, the register, and brevity/speakability
   rules — today they're scattered across seed prompts, migrations, and a
   per-route suffix; applies to every reply path (typed, voice, dispatched
   agents' final answers). Success test: a new agent or route gets Nova's
   voice by default, with no way to bury it.
   **DESIGNED 2026-07-17** — full spec with locked decisions and 4 phases
   in docs/plans/persona-layer.md (Nova-as-proxy: specialists are their
   own entities, no soul injection for them; slot-based assembly owned by
   the runner; soul kernel/extended split; house rules ≠ persona).
   **PHASE 1 SHIPPED 2026-07-17:** `_build_system_prompt` is slot-based
   (ROLE → FACTS → CONTEXT → LAST WORD); summary and channel suffix moved
   inside the assembler so the last word is actually last. Specialists no
   longer wear the soul or the name backstop — they end with house rules
   ("your reader is Nova": dense, no pleasantries; act-don't-narrate;
   memories are the past). Typed chat gained the end-position register
   voice already had (_TYPED_REGISTER). Live-verified: container prompt
   inspection for both entity kinds (soul/backstop absent for specialist,
   house rules last; register last for Nova, voice suffix replaces it);
   typed "thanks" → "Anytime."; voice "goodnight" register intact;
   dispatch end-to-end with a notably denser specialist reply.
   Phases 2–4 (role sheets, soul kernel/extended + capability docs,
   proxy invariant) remain.

16. **Usage caps by cost, not rounds (requested 2026-07-17)** — evolve the
   per-turn tool-round cap into operator-set budgets: daily / weekly /
   monthly spend caps on Nova's usage, or explicitly no cap. Cloud spend
   is the real quantity (OpenRouter reports per-request cost/usage; local
   models are free — a local cap would be about tokens/time, optional).
   The action ledger from the autonomous-safety-rails work is the natural
   accounting substrate, and per-turn cost capture overlaps with item #3
   (observability turn tracing) — build them together. Behavior at the
   cap must degrade gracefully: warn → prefer local models → pause cloud,
   never a mid-turn hard cut. The round cap (now the live
   `agents.max_tool_rounds` setting) stays as the per-turn sanity bound.
   DEPENDENCY (2026-07-17): "prefer local" presumes per-agent model
   chains, which don't exist yet — today each agent has ONE model and the
   only fallback is the global keyless-bootstrap swap in effective_model()
   (fires only when no OpenRouter key is set; a failed/over-budget cloud
   request has no failover and just errors the turn). Chains are phase 2
   of the models/inference unified plan (role → chains, on the pool from
   #57) — build chains first; the cost cap then becomes a budget-aware
   filter on the chain walk (cloud entries ineligible while over cap).

17. **Model labels should show their provider (requested 2026-07-17)** —
   the picker says "z-ai/glm-5.2" with nothing indicating it runs via
   OpenRouter (internally `openrouter:z-ai/glm-5.2`; models_catalog.py
   strips the provider prefix when building display names). The API
   already returns a `provider` field per model — the UI just never
   renders it. Group picker options by provider (Local / OpenRouter) or
   badge each row; applies to the chat-header picker and every model
   select in Settings (agents, voice override, "set all"). Small.

18. **Executable skill payloads — RESEARCH FIRST (requested 2026-07-17)** —
   Jeremy: shipping executable payloads with skills is critical to Nova
   eventually. Today skills (`data/memory/skills/*.md`) are prompt-steering
   markdown only, agent-authored at runtime by skill-manager. This item is
   a research task, not a build: (a) how critical is it really — what does
   an executable skill provide that Nova's existing runtime tool creation
   (tool-creator + tools registry) and MCP servers don't already cover, and
   where's the boundary between "skill with a script" and "tool"; (b) prior
   art — Anthropic Agent Skills (SKILL.md bundles, progressive disclosure),
   MCP, how comparable agent products gate agent-authored executable
   content; (c) edge cases and issues an implementation would introduce —
   the core one being self-escalation: an agent-writable directory whose
   contents execute is a prompt-injection→code-execution path, so execution
   rights must be an out-of-band grant (nothing an agent can write — file
   location, frontmatter — can be the switch). Design sketch from the
   2026-07-17 discussion, as research input not decisions: two provenances
   (bundled skills in-repo, trusted via PR review, read-only at runtime;
   learned skills in data/memory, born prompt-only), promotion to
   executable via the approvals/inbox surface (PR #56 machinery) with a
   content hash pinned in Postgres — any file change (agent rewrite or
   hand edit) degrades it back to prompt-only until re-approved (soul.md
   hash-sync pattern); execution in a sandboxed runner container (no
   secrets, restricted network, wall-clock kill rail) never the backend
   process. Also flag: `data/memory/` is currently root-owned and
   world-writable — fine for markdown, needs tightening before anything in
   it is even indirectly executable. Deliverable: findings + a go/no-go
   recommendation; if go, write the full spec in
   `docs/plans/executable-skills.md` and plan phases before any code.

19. **MCP client — connect Nova to the tool ecosystem (requested
   2026-07-17)** — v3 has ZERO MCP code (verified by grep); today every
   capability is hand-built, and an MCP client makes Nova a consumer of
   the ecosystem (GitHub, Home Assistant, filesystems, calendars) without
   authoring each one. Full spec: `docs/plans/mcp-client.md`. Shape: MCP
   tools flow through the EXISTING choke points — namespaced
   `mcp:<server>/<tool>` names through `execute_tool`, grants via named
   or `mcp:<server>:*` wildcards (the `db:*` precedent, deliberately no
   global `mcp:*`), guardian rules and the narration detector inherited
   for free. Server registration is operator-only (edit-mode API, no
   agent tool — the #18 self-escalation lesson applied preemptively);
   tool descriptions hash-pinned at approval (poisoning defense, the
   soul.md pattern). Lazy loading (index + meta-tool) ports the
   live-verified `v0.5.0-alpha` design (old-repo PR #54) — designs only,
   never code. HTTP transport first (pip `mcp` SDK, no new service);
   stdio via an `mcp-runner` sidecar in the last phase. Overlaps #18:
   much of "executable skills" may really be "an MCP server exists for
   that" — the #18 research must evaluate them together.

20. **ACP coding delegation — coding via protocol, not a bespoke harness
   (requested 2026-07-17)** — Nova as an Agent Client Protocol CLIENT
   driving existing coding agents (Claude Code via the `claude-code-acp`
   adapter, Gemini CLI) instead of building repo/shell/test tooling from
   scratch. Full spec: `docs/plans/acp-coding-delegation.md` — phase 0 is
   a validation spike (the protocol landscape moves monthly; findings may
   reshape the build). Shape: a secretless `coder` sidecar (session
   broker in the inference-control style) with operator-registered repos
   mounted ONLY there; every session runs in a fresh worktree under
   `.worktrees/nova/<task>` (never main, never pushes — merge is always
   the operator's move); sessions are BACKGROUND jobs
   (`delegate_coding_task` returns immediately, progress streams to the
   activity trail, completion journals branch + diffstat + report);
   v1 permission posture is sandboxed-autonomous (worktree-confined
   edits + allowlisted commands, diff review as the real gate). Keyed
   opt-in extra by nature (runs on the operator's Anthropic/Google
   credentials); the local-model lane (Ornith-35b, per the Later note)
   is end-phase research. SUPERSEDES the harness assumption in the Later
   "Coding agent(s)" item. Build AFTER #3 — delegated code edits without
   an audit trail is flying blind.

21. **Notifications — ntfy wiring (2026-07-17)** — small, and the
   prerequisite for proactive Nova: v3 currently has NO way to reach the
   operator when the app is closed (verified: zero ntfy references in the
   backend). A minimal `notify.py` + `notify_operator` builtin +
   settings (server URL, topic — self-hostable, keyless, fits
   batteries-included), guardian-visible like every tool. Unlocks #5's
   upgrade alerts (which already assume ntfy), #20's session-complete
   pings, automation failure alerts, and #24. Mine the v2 notification
   outbox design for delivery receipts (operator-visible-outcomes
   lesson: "accepted by transport" ≠ "received").

22. **File/attachment ingestion in chat (2026-07-17)** — Nova ingests
   URLs (and soon videos) but you cannot hand her a FILE: no upload path
   exists. Add attach-to-chat (button + drag-drop; the PWA phone path
   makes this a share-sheet target later): upload endpoint (auth-gated,
   size-capped), text extraction per type (PDF/markdown/txt/docx first),
   then the EXISTING ingestion pipeline — distilled, tagged,
   provenance-stamped topic files (`source: upload:<filename>`), same
   in-place refresh semantics. Images route to #23's vision path instead
   of extraction. Design questions: keep originals (a `data/uploads/`
   store) vs. distill-and-discard; per-file size caps.

23. **Vision input (2026-07-17)** — paste or attach a screenshot/image
   into chat and Nova sees it. The gateway already fronts VL-capable
   models (qwen3-vl class locally, most cloud models); work is: image
   content in the message path (multimodal content arrays through the
   OpenAI-compat client), a `vision: bool` column on curated rows so
   routing knows which models can look, and a fallback answer when the
   active model is text-only ("switch to a vision model or let me
   dispatch one"). Feeds #22 (image uploads) and is a PREREQUISITE for
   the Later device-control item (screenshot → reason → act loop).

24. **Daily briefing (2026-07-17)** — pure composition on existing
   infra, cheap Jarvis points: a seeded automation (default-disabled)
   that assembles a morning journal — yesterday's conversation/journal
   recap, topics refreshed by the staleness sweep, new items from video
   subscriptions (#8) once they exist, curation proposals awaiting
   approval (#5) — and pushes the digest via ntfy (#21). Calendar joins
   when the Later calendar item lands. Needs #21 first; everything else
   it consumes already exists.

25. **CRITICAL — Automation run visibility (2026-07-17, from the
   tech-news-digest failures)** — the operator saw "failed ×2" with no
   way to drill in, and Nova sees even less. Today only ONE run survives:
   `record_run` overwrites `last_status`/`last_summary` in place, so a
   future success erases all trace of the failures; the per-run tool
   timeline exists only in docker logs. Fixes, in effort order: (a) the
   `manage_automations` list tool must return `last_summary` +
   `consecutive_failures` — the slim projection in `tools/builtin.py`
   drops both, so asking Nova "why did the digest fail?" dead-ends at
   "failed"; (b) journal FAILED runs — `scheduler.py` journals successes
   and the 5-strike auto-disable but nothing on individual failures, so
   Nova's own memory holds no trace of her automations breaking; (c) an
   `automation_runs` history table (status, summary, started_at,
   duration) + an expandable run-history view in the Automations panel;
   (d) persist the per-run tool timeline (activity events are log-only
   today) — this half belongs to observability #3 and feeds its audit
   log.
   **(a)–(c) SHIPPED 2026-07-17 (93282bb):** `automation_runs` table
   (migration 025, last 50 runs kept per automation), failed runs
   journaled, `manage_automations` list returns summary + failure streak
   plus a new `runs` action, `GET /api/v1/automations/{id}/runs`, and an
   expandable run-history view in the Automations tab. Live-verified
   end-to-end, including a chat probe where main chose the `runs` action
   unprompted to answer "why did the digest fail?". (d) stays with #3.

26. **CRITICAL — tech-news-digest timeout (2026-07-17, diagnosed)** —
   both failures are `timed out after 300s`. Log timeline: every tool
   call returns in <1s; the 90–110s gaps BETWEEN calls are glm-5.2
   generation time. Structural root cause: the digest doc ("running
   digest, earlier entries preserved", 28+ entries and growing) is
   re-read and re-generated whole every run, so runtime grows with the
   doc — it succeeded 2026-07-16 and outgrew the budget the next day. It
   will keep failing (3 more consecutive = auto-disable). Fix:
   restructure to append-only / month-capped digest files so each run
   writes only the delta, and consider a per-automation timeout override
   on top of the global `automations.run_timeout_seconds` for
   legitimately long jobs.
   **SHIPPED 2026-07-17 (f5b05c6):** `write_memory` gained a mechanical
   append mode (item_id + append=true — existing text preserved by code,
   not by the model), the digest instruction was rewritten to
   append-only month-capped topics (migration 026, failure streak
   reset), and automations gained an optional `timeout_seconds` override
   (min 30, NULL = global). Live-verified: the restructured digest run
   succeeded in 63s where the previous two timed out at 300s — earlier
   sections preserved verbatim, delta appended; a 30s-override probe
   timed out at exactly 30s.
   **Newest-first flip (Jeremy, 2026-07-19):** `write_memory` gained a
   `prepend` flag (memory/store.py `append_concept(prepend=)` — same
   delta-only mechanics, delta lands at the TOP), the digest
   automation's DB instruction now says prepend=true with newest day at
   the top, and the existing July digest file was re-sorted
   newest-first (stale "(Latest)/(Historical)" labels dropped). Any
   future running document can choose append or prepend per call.

27. **CRITICAL — memory linking at write time (2026-07-17, from the
   flat-orb question)** — flat gray orbs in Universe are working as
   designed (rogues get no glow + 55% desaturation toward gray,
   `universe.ts`) but they expose a real data problem: tool-driven memory
   writes do NO linking pass. `users-favorite-hiking-spot.md` has zero
   tags and zero wiki-links despite its body literally saying "Bear
   Mountain" — while a glowing bear-mountain system (3 docs sharing the
   `bear-mountain` tag) floats nearby; the AI-news digest and Big Blue
   View topics carry tags nothing else shares. Fix the data, not the
   renderer: (a) immediate: tag/link the three current orphans by hand
   (`data/memory` is hand-editable); (b) the real fix: the
   ingestion/write path gets a linking step — compare a new memory
   against the existing index (titles + tags) and add wiki-links /
   shared tags before writing, plus tag-hygiene guidance in agent
   instructions. Not covered by any existing plan
   (model-curation-proposals is models, not memory) — this is the
   memory-curation lane's first concrete item.
   **SHIPPED 2026-07-17 (0287c6d, parallel session):** write-time
   `_link_pass` in memory.write (shared-tag adoption + verbatim-title
   wiki-links) + migration 027 tag hygiene.

28. **CRITICAL — relationship edges: user-facts + automation provenance
   (2026-07-17)** — two missing edge kinds in the brain graph: (a)
   memories ABOUT the operator should connect to the user node. The
   universe's own copy says "everything here exists in orbit around this
   relationship," yet zero memories link to the user star —
   `memory.graph()` only links memory↔memory, and the user node is
   bolted on at the platform layer with a single bond edge to Nova.
   Design: an `about: user` frontmatter key → `kind: "about"` edge to
   the user node, drawn as an arc, so personal facts (favorite hiking
   spot, Giants fandom) visibly orbit the user star. Composes cleanly:
   `computeSystems` only unions memory↔memory edges, so an about-edge
   never drags a topic out of its tag system. (b) automations → the docs
   they maintain: a provenance edge (`kind: "writes"`) from
   `automation:tech-news-digest` to its digest topic — today the comet
   and its document are strangers. Both halves are small: graph endpoint
   + one renderer arc treatment each.
   **SHIPPED 2026-07-17 (0287c6d, parallel session):** `about: user` and
   `maintained_by: <automation>` frontmatter markers → `about`/`writes`
   edges + renderer arcs; July digest hand-stamped.
   **HARDENED same day (follow-up):** the markers were convention-only —
   `write_memory` had no way to emit `maintained_by`, so the month-capped
   digest (#26) would have been born arc-less each new month, and an
   in-place REFRESH rebuilt frontmatter from scratch, wiping both
   markers. Now mechanical: the scheduler passes the automation name
   through the runner's tool ctx (dispatch-propagated, never
   agent-suppliable), `write_memory` stamps `maintained_by` on topics
   CREATED during an automation run, and `write_concept` merge-preserves
   existing frontmatter keys on pinned updates — first maintainer wins,
   refreshes never steal or strip attribution. Live-verified: scheduler
   run created a stamped topic whose `writes` edge appeared in the
   graph; refresh survival + no-theft covered by mechanical tests.

29. **CRITICAL — operator consent for guarded/destructive actions
   (2026-07-19, from a live refusal)** — Jeremy asked twice in chat to
   remove the `block-facebook-domain` rule; guardian refused both times
   and was RIGHT to: its charter forbids weakening protections on
   second-hand instructions, and a dispatch from Nova is structurally
   second-hand ("the user wants..." is hearsay by construction — trace
   evidence in turns ff49a1f7/9581ce95: guardian listed rules, never
   called delete). The fix is not a softer guardian; it's making
   operator consent a MECHANICAL FACT: guardian requests confirmation →
   an inline option card renders in chat (the Claude-Code
   AskUserQuestion register, per Jeremy's instinct) → the operator's
   authenticated click creates a single-use, TTL'd consent record →
   destructive tool actions require and validate that consent id at the
   TOOL layer, not by LLM judgment. Embedded/fetched-content
   "instructions" still die at the prompt (no card, no consent, no
   path). Spec: `docs/plans/guarded-actions-consent.md`. Interim
   operator path (used 2026-07-19 to clear the blocker): Settings →
   Operator → Edit mode + the rules UI / `DELETE /api/v1/rules/{id}`.

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

- **Calendar integration (from Nova's self-assessment, 2026-07-17)** — "what
  time is my meeting?" should work. Batteries-included order: CalDAV/ICS
  subscription first (keyless — covers Google/Outlook exported calendars,
  Nextcloud, iCloud public links), full Google Calendar OAuth as a keyed
  opt-in extra later (same posture as the mailbox decision).

- **Home Assistant integration (2026-07-17)** — the ambient-presence /
  smart-home half of the Jarvis register: "turn off the lights", "is the
  garage closed". Rides #19 for free — Home Assistant ships its own MCP
  server, so this is "register a preset server + grant it" rather than a
  bespoke integration; local and keyless (fits batteries-included).
  Guardian rules should watch actuation tools from day one (lights are
  reversible; locks and garage doors are consent-gate material).

- **Location capability (from Nova's self-assessment, 2026-07-17)** —
  IP-based geolocation as the keyless v1 (feeds weather defaults +
  "near me" questions); device GPS via the PWA later (permission-gated,
  per-device). Small.

- **Operator profile — structured, guaranteed (from Nova's self-assessment,
  2026-07-17)** — memory CAN hold preferences/family/projects today, but
  nothing guarantees a well-formed operator profile exists or stays
  current. Seed a structured `operator` topic (like soul.md is seeded),
  inject it alongside the soul, and give Nova explicit instructions to
  maintain it. Prerequisite for speaker-ID/per-person context (the family
  item) — per-person profiles generalize from one.

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
- **Coding agent(s)** — SUPERSEDED as the primary path by #20 (ACP
  delegation, 2026-07-17): drive existing coding agents over the Agent
  Client Protocol instead of building a bespoke harness. This item
  remains only as the fully-local fallback lane (a local model on an
  ACP-speaking harness — #20 phase 4 researches it). Original sketch:
  one general coding agent with strong tools (repo access, shell, file
  editing, test runner); specializations (reviewer, architect) as
  personas on the same harness. Needs sandboxed workspaces + branch/PR
  git discipline (now specified in the #20 plan).
  Model note (evaluated 2026-07-16): **Ornith-1.0** (DeepReinforce, MIT,
  256K ctx, RL-trained agentic-coding family — 9b/35b/397b, on Ollama) is
  the first local candidate to probe when this starts. Probed 9b live:
  vanilla tool calls pass, ~110 tok/s @ 6 GB VRAM, but agentic judgment
  went 1/2 across runs (borderline on the narrated-dispatch trap) — so
  NOT adopted for the general tools role; qwen3 passes consistently. The
  35b (21 GB, fits a 3090) is untested and is the one this item should
  evaluate. ornith:9b left pulled on the dev box.

- **Self-improvement pipeline — how Nova changes her own code (discussed
  2026-07-17)** — direction settled, full spec once #20 lands. TWO-TIER
  RULE: the *soft layer* (agents, tools, automations, skills, prompts,
  soul — DB rows + markdown) is already runtime-self-modifiable, guarded
  by guardian rules, edit-mode gating, and toggles; the *hard layer*
  (code, compose, migrations — the machinery every guardrail runs on) is
  NEVER modified in place by the running Nova. No live self-editing: an
  agent that can edit its running code can edit its own guardrails — the
  #18 lesson ("nothing an agent can write may be the switch") applied to
  the deployment itself; promotion is out-of-band by construction. Path:
  #20 ACP coding sessions with Nova's own repo as a registered workspace
  (worktree branch, never main) → **staging stack**: a second compose
  project built from the candidate branch with a COPY of postgres + the
  memory dir, own ports, zero shared state, and outbound side effects
  disabled by env flag (automations off, notifications to a staging
  topic — a staging Nova must not act on the world twice) → automated
  verification against staging (test suite + real e2e chat flows;
  report journaled) → operator review + merge stays the gate
  INDEFINITELY (autonomy grows in generating and validating changes,
  never in promoting them) → promote = pull + build with git-SHA-tagged
  images, DB backup FIRST; rollback = previous image tag + restore.
  Honest notes: for a single-operator stack "blue/green" reduces to
  staging-then-promote with instant image rollback — the hard part is
  state, not traffic switching; migrations auto-run at backend startup,
  so a candidate booted against the live DB could corrupt the real brain
  — staging DB copies and backup-before-promote are non-negotiable, and
  the pre-release "clean breaking changes" policy needs revisiting the
  day Nova authors migrations herself. Dependencies: #20 (the hands),
  #3 (audit what a candidate session did), #21 (review-ready pings).

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
