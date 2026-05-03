# Screenpipe Capture & Ingestion (Personal Context Layer — Sub-project 1)

## Problem

Nova's autonomous agents are missing the most relevant context they could have: what the user is actually working on. Today, Nova learns only from explicit chats, intel feeds, knowledge crawls, and task outputs. It never sees the user reading documentation in a browser, debugging a file in VS Code, or reviewing a draft in Notion. As a result, Nova's recall, planning, and journaling all start from a partial picture.

Two products are converging on this gap:

- **[Screenpipe](https://screenpi.pe/)** — open-source (MIT) Rust desktop daemon that captures screen text (OCR + accessibility tree), audio transcriptions, and UI events. Stores in local SQLite. Exposes REST + WebSocket on `localhost:3030`.
- **[Littlebird](https://littlebird.ai/)** — closed-source SaaS that reads only the *active window's structured text* (no screenshots) plus meeting audio, then builds a private memory of your projects. $20/mo. No public API.

The product idea behind both: a personal context layer that turns computer activity into searchable, agent-accessible memory. Littlebird ships the polished consumer UX; screenpipe ships the substrate. Nova should adopt **Littlebird's product philosophy on top of screenpipe's plumbing**.

This document specifies **Sub-project 1 of 4** in the Personal Context Layer roadmap:

| # | Sub-project | Depends on | Status |
|---|---|---|---|
| **1** | **Capture & Ingestion** | — | **This doc** |
| 2 | Active Recall (agent tools + dashboard search) | 1 | Future spec |
| 3 | Meeting Capture (audio + Whisper + meeting notes) | 1 | Future spec |
| 4 | Journal Rollups (scheduled daily/weekly summaries) | 1 | Future spec |

Sub-project 1's job is to make screenpipe's stream of focus-session events show up in Nova's engram graph as proper sources, with privacy filtering, configurable from the dashboard, operationally robust. That's it. No agent tools, no UI for asking Nova about your screen yet, no meeting notes, no summaries — those are sub-projects 2/3/4 and each gets its own spec.

## Design

### 1. Topology

Screenpipe is a desktop daemon. It needs a real screen, a real audio device, and native OS accessibility APIs to function. None of these exist inside a Docker container, so screenpipe is **not** bundled in Nova's Compose stack — the user installs it on their workstation (Mac, Windows, or Linux) using the official screenpipe installer.

Nova adds a new service, `screenpipe-bridge`, that runs in the Compose stack. The bridge subscribes to screenpipe over the network, aggregates raw events into focus sessions, applies privacy filtering, and pushes a payload to the engram ingestion queue. Memory-service's existing decomposer consumes the queue, creates the `sources` row, and decomposes the text into engrams — exactly as it already does for `knowledge_router` and `intel-worker` payloads.

```
┌─────────────────────┐                ┌──────────────────────────────────────────┐
│  Workstation        │                │  Nova (Docker Compose)                   │
│  ┌──────────────┐   │                │                                          │
│  │  screenpipe  │   │  WebSocket     │  ┌────────────────────┐                  │
│  │  daemon      │───┼────────────────┼─▶│ screenpipe-bridge  │                  │
│  │              │   │  (events)      │  │  - WS subscriber   │                  │
│  │  localhost:  │   │                │  │  - session aggreg. │                  │
│  │  3030        │◀──┼────────────────┼──│  - denylist filter │                  │
│  └──────────────┘   │  HTTP poll     │  │  - queue producer  │                  │
│                     │  (fallback)    │  └────────┬───────────┘                  │
└─────────────────────┘                │           │ LPUSH                        │
                                       │           ▼                              │
                                       │  ┌────────────────────┐                  │
                                       │  │ Redis db0          │                  │
                                       │  │ engram:ingestion:  │                  │
                                       │  │ queue              │                  │
                                       │  └────────┬───────────┘                  │
                                       │           │                              │
                                       │           ▼                              │
                                       │  ┌────────────────────┐                  │
                                       │  │ memory-service     │                  │
                                       │  │ engram decomposer  │                  │
                                       │  │ (find_or_create_   │                  │
                                       │  │  source + decompose)│                 │
                                       │  └────────┬───────────┘                  │
                                       │           │                              │
                                       │           ▼                              │
                                       │  ┌─────────────────┐  ┌───────────────┐  │
                                       │  │  Postgres       │  │  engram graph │  │
                                       │  │  sources table  │  │  (engrams,    │  │
                                       │  │                 │  │   edges, ...) │  │
                                       │  └─────────────────┘  └───────────────┘  │
                                       └──────────────────────────────────────────┘
```

The bridge has only one outbound dependency: Redis. It pushes to the engram queue (db0) and reads runtime config (db1). It does **not** call any Nova HTTP API and does **not** write to Postgres directly. This matches the established producer pattern used by `knowledge_router` and `intel-worker`.

### 2. Capture Unit: Window Focus Session

A **focus session** is the atomic unit of capture. One session produces one queued payload, and one queued payload produces one `sources` row (created by the decomposer).

**Boundaries:**
- Begins when screenpipe emits a focus event for a new window (different `app_name` or `window_name` than the previous active window)
- Ends when:
  - Focus changes to a different window (and that focus survives ≥1s — see noise filter below), or
  - 30 minutes have elapsed since the session began (cap)

**Discard rules:**
- Sessions shorter than 30 seconds are discarded (alt-tab noise filter)
- Sessions matching the privacy denylist are discarded entirely (no payload, no source row, no metadata — see Privacy section)

**Session split on cap:** When the 30-minute cap fires, the current session is finalized and a new session for the same window begins immediately. Continuity is preserved via timestamps; agents/users can stitch them back together if needed.

**Why this granularity:** Per-event ingestion floods the engram graph with tiny near-duplicate fragments. Time-window slicing produces Nova-shaped artifacts instead of work-shaped ones (a 50-min meeting becomes 4 sources for no reason). Per-app session loses precision (two hours in VS Code with 8 different files becomes one blob). Per-window-focus matches how humans naturally think about "what they were doing" — and that alignment improves spreading-activation retrieval downstream because retrieval queries naturally segment that way ("when I was working on the auth router…").

### 3. Within-Session Dedup

Screenpipe re-emits the same accessibility text on every event (typically every few seconds while a window is focused). The bridge collapses these to unique lines, preserving order:

```python
# Pseudocode
seen_lines: set[str] = set()
ordered_text: list[str] = []
for event in session_events:
    for line in event.text.splitlines():
        if line and line not in seen_lines:
            seen_lines.add(line)
            ordered_text.append(line)
session_content = "\n".join(ordered_text)
```

This is a deliberately simple dedup. It does **not**:
- Summarize content (memory-service decomposer's job, not the bridge's)
- Fuzzy-match similar lines (a regression in retrieval if "almost the same" gets dropped)
- Apply NLP-style chunking (memory-service handles this)

### 4. Privacy Filtering: Two-Layer Denylist

Filtering happens in two places, each with a specific role.

**Layer 1: Screenpipe config (source-side).** Permanent excludes that should never even reach Nova. Configured in `screenpipe.config.json` at install time, requires screenpipe restart to change. Default list shipped with our setup docs:

```jsonc
{
  "exclude_apps": [
    "1Password", "1Password 7 - Password Manager", "Bitwarden", "KeePassXC",
    "Keeper Password Manager", "LastPass"
  ]
}
```

Users add to this list during installation; they can extend it later with a screenpipe restart.

**Layer 2: Nova bridge denylist (runtime).** Stored in Redis under `nova:config:capture.denylist.*`, edited from the dashboard, takes effect at the next session boundary. Three sub-lists:

| Sub-list | Match | Example |
|---|---|---|
| `apps` | exact match on `app_name` | `Mint`, `Robinhood` |
| `url_patterns` | regex on `browser_url` | `^https://.*\.bank/`, `^https://.*\.health\.gov/` |
| `window_titles` | substring (case-insensitive) on `window_name` | `Password`, `Incognito`, `Private Browsing` |

When any layer-2 rule matches, the session is dropped before any payload is queued.

**Filtered = invisible.** A dropped session leaves no trace: no payload, no source row, no metadata, no "12 minutes in 1Password" telemetry. We accept the loss of journal completeness ("you spent 8 hours total in privacy-excluded apps this week" is a feature we won't have) in exchange for a clean, auditable privacy guarantee. If a use case for anonymized activity tracking emerges later, we add it as a separate, opt-in feature.

**Default starter denylist (Layer 2):**

| Sub-list | Defaults |
|---|---|
| `apps` | empty (user adds) |
| `url_patterns` | empty (user adds — common patterns suggested as one-click chips in the dashboard) |
| `window_titles` | `Password`, `Incognito`, `Private Browsing`, `InPrivate` |

### 5. Source Provenance Schema

Source rows are created by memory-service's engram decomposer when it consumes the bridge's queue payload (it calls `find_or_create_source` internally — same as for every other producer). The bridge does not write to the `sources` table directly; it just provides the right fields in the payload.

The resulting `sources` row will have:

| Column | Value (set by) |
|---|---|
| `id` | UUID v4 (memory-service) |
| `source_kind` | `'screenpipe'` (memory-service, via `_map_source_type_to_kind('screenpipe')` — see Section 6 for the required one-line mapping change) |
| `uri` | `screenpipe://<device_id>/<start_ts_iso>/<window_hash>` (bridge sets `source_uri` in payload) |
| `title` | `'<app> — <window_title> — HH:MM-HH:MM'` truncated to 200 chars (bridge sets `source_title` in payload) |
| `metadata` (JSONB) | `{ "app": ..., "window": ..., "url": ..., "device_id": ..., "captured_at_start": ..., "captured_at_end": ..., "word_count": ..., "screenpipe_event_count": ... }` (bridge sets in payload `metadata`) |
| `trust_score` | `0.80` (bridge sets `source_trust` in payload) |
| `content` / `content_hash` / `content_path` | populated by memory-service per its hybrid storage policy (DB inline if <100KB, filesystem at `data/sources/screenpipe/<id>.txt` otherwise) when it persists the source |
| `tenant_id` | `'00000000-0000-0000-0000-000000000001'` for v1 (bridge sets in payload; multi-tenant deferred) |
| `created_at` | `NOW()` (memory-service) |

**Dedup behavior:** Memory-service's `find_or_create_source` dedups by `source_uri`. Each focus session generates a unique URI (`screenpipe://<device>/<start_ts>/<window_hash>`), so legitimately distinct sessions never collide — even when their content happens to match (e.g., two views of the same static page).

**Trust score rationale (0.80):** Screen content is verbatim observation of what the user saw or wrote — high reliability for "this happened" but mixed signal for "this is true" (a screen can show wrong information being read). Sits between `intel_feed`/`knowledge_crawl` (0.70) and `task_output`/`consolidation` (0.85). Tunable later if retrieval quality suggests otherwise.

**`device_id`:** Single-device for v1 (always `'primary'`, hardcoded). Multi-device support is a future concern; `device_id` lives in the `metadata` JSONB so no schema migration is needed when we extend it.

**`tenant_id`:** Memory-service ingestion logs a `WARNING` when a payload omits `tenant_id` (FC-001 grace period; will be hard-rejected later — see `memory-service/app/engram/ingestion.py`). The bridge populates this with `DEFAULT_TENANT = '00000000-0000-0000-0000-000000000001'` for v1. The constant lives in `screenpipe-bridge/app/tenant.py` so future multi-tenant changes are localized.

### 6. Engram Ingestion Payload

The bridge LPUSHes one payload per finalized focus session onto Redis db0 queue `engram:ingestion:queue`. Field names match the existing producer contract verified in `memory-service/app/engram/ingestion.py:204-235`:

```json
{
  "raw_text": "<session content>",
  "source_type": "screenpipe",
  "session_id": "screenpipe:<device_id>:<start_ts>",
  "occurred_at": "2026-05-02T14:32:00Z",
  "tenant_id": "00000000-0000-0000-0000-000000000001",
  "metadata": {
    "app": "VS Code",
    "window": "clients.py — orchestrator",
    "url": "file:///home/jeremy/workspace/nova/orchestrator/app/clients.py",
    "device_id": "primary",
    "captured_at_start": "2026-05-02T14:32:00Z",
    "captured_at_end": "2026-05-02T14:51:00Z",
    "word_count": 1847
  },
  "source_trust": 0.80,
  "source_uri": "screenpipe://primary/2026-05-02T14:32:00Z/abc123def456",
  "source_title": "VS Code — clients.py — 14:32-14:51"
}
```

Note: `source_id` is **not** included in the payload. The decomposer creates the source row from the `source_*` fields; the bridge has no need to know the resulting UUID for v1 (the Capture page reads sessions via the orchestrator's sources query, not by reference).

**One narrow memory-service change required.** Memory-service's `_map_source_type_to_kind()` (in `memory-service/app/engram/ingestion.py:187-201`) has no entry for `screenpipe` — payloads would default-map to `manual_paste`, producing wrong `source_kind` and trust defaults. Add a single line: `'screenpipe': 'screenpipe'`. This is the only memory-service touch in sub-project 1; no behavior change for any other source type.

`raw_text` from the queue payload becomes `sources.content` automatically: `_process_event` calls `find_or_create_source(content=raw_text)`, which routes to `db_content` for ≤100KB or filesystem storage for larger. This is the same path `knowledge_router` uses today.

### 7. Configuration (UI-First)

Per the project rule: every setting that doesn't require a service restart lives in the dashboard, persisted in Redis `db1` under `nova:config:*`. `.env` carries only bridge-service boilerplate (Redis URL, Redis password, log level, port).

**Persistence.** `nova:config:*` values are persisted to Postgres `platform_config` and synced to Redis on startup. Implementation pattern: add a domain-prefixed sync function (`sync_screenpipe_config_to_redis()` and `sync_capture_config_to_redis()`, or one combined function) following the shape of `sync_llm_config_to_redis()` at `orchestrator/app/config_sync.py:29-52`, and call them from the orchestrator startup hook. Redis is treated as cache; Postgres is source of truth.

**New Settings sections:**

**Settings → Connections → Screenpipe** (new section in existing Connections tab):

| Field | Type | Redis key |
|---|---|---|
| Enabled | toggle | `nova:config:screenpipe.enabled` |
| URL | text | `nova:config:screenpipe.url` |
| API Key | password (write-only after entry) | `nova:config:screenpipe.api_key` |
| Test Connection | button | (calls bridge `/test-connection` endpoint) |
| Status indicator | live | (queries bridge `/health/ready`) |

**Settings → Capture → Privacy** (new tab "Capture" with Privacy as default subsection):

| Field | Type | Redis key |
|---|---|---|
| App denylist | chip list | `nova:config:capture.denylist.apps` (JSON array) |
| URL pattern denylist | regex list | `nova:config:capture.denylist.url_patterns` |
| Window title denylist | substring list | `nova:config:capture.denylist.window_titles` |
| Reset to defaults | button | (restores starter list) |

**Settings → Capture → Advanced** (collapsed by default):

| Field | Type | Redis key | Default |
|---|---|---|---|
| Session max duration | slider (5–120 min) | `nova:config:capture.session_max_minutes` | 30 |
| Session min duration | slider (0–300s) | `nova:config:capture.session_min_seconds` | 30 |
| Backpressure buffer size | number | `nova:config:capture.buffer_size` | 10 |
| Capture paused | toggle (also on Capture page) | `nova:config:capture.paused` | false |

**Bridge config-watch:** Bridge polls `nova:config:screenpipe.*` and `nova:config:capture.*` from Redis db1 every 30 seconds and caches values in-process — this matches the cache pattern used elsewhere in Nova (e.g., `orchestrator/app/auth.py:57-85`). Connection-affecting changes (URL, API key, enabled) are checked at the start of each WS reconnect attempt, so a config edit triggers a reconnect within at most 30s. Filter-affecting changes (denylist) take effect on the next session boundary. Aggregation params take effect on the next session start. Polling avoids requiring Redis keyspace notifications, which Nova's Redis container does not have enabled.

### 8. Capture Page (Top-Level Nav)

A new top-level dashboard nav item: **Capture**. Routes:

- `/capture` — main page (this sub-project)
- `/capture/meetings` — sub-project 3 (placeholder for now)
- `/capture/journals` — sub-project 4 (placeholder for now)

**Layout of `/capture`:**

```
┌──────────────────────────────────────────────────────────────────────┐
│  Capture                                              [Pause] [⚙]    │
│                                                                      │
│  ┌──────────────────────────────┐  ┌────────────────────────────┐    │
│  │  Connection                  │  │  Today                     │    │
│  │  ● Connected to workstation  │  │  Sessions: 47              │    │
│  │  Last event: 12s ago         │  │  Captured time: 6h 12m     │    │
│  │  Sessions today: 47          │  │  Dropped (filtered): 3     │    │
│  │                              │  │  Top app: VS Code (3h 2m)  │    │
│  └──────────────────────────────┘  └────────────────────────────┘    │
│                                                                      │
│  Recent activity                                                     │
│  ┌──────────────────────────────────────────────────────────────┐    │
│  │ 14:32 → 14:51  VS Code        clients.py — orchestrator      │    │
│  │   1,847 words • orchestrator/app/clients.py                  │    │
│  │                                            [view] [exclude]  │    │
│  ├──────────────────────────────────────────────────────────────┤    │
│  │ 14:18 → 14:30  Slack          #nova-dev                      │    │
│  │   423 words                                                  │    │
│  │                                            [view] [exclude]  │    │
│  ├──────────────────────────────────────────────────────────────┤    │
│  │ 13:45 → 14:18  Chrome         Engram retrieval — Anthropic  │    │
│  │   2,103 words • https://docs.anthropic.com/...               │    │
│  │                                            [view] [exclude]  │    │
│  └──────────────────────────────────────────────────────────────┘    │
│                                                          [Load more] │
└──────────────────────────────────────────────────────────────────────┘
```

**Components:**
- **Pause button (top right):** Toggles `nova:config:capture.paused`. While paused, the bridge accepts events but discards them (does not reconnect or re-fetch when unpaused — the gap is intentional). Visible status banner when paused.
- **Connection card:** Shows bridge↔screenpipe link state, last event timestamp, today's session count. Click → drills into Settings → Connections → Screenpipe.
- **Today stats card:** Sessions count, total captured time, dropped count (filtered + over-cap discards), top app by capture time.
- **Recent activity feed:** Paginated list of most-recent N sessions (default 50, virtualized scroll). Each row: time range, app, window, word count, optional URL, action buttons.
  - **`view`:** Opens a modal showing the session's raw text content (the `sources.content` blob). Provides an audit surface: "what did Nova actually capture?"
  - **`exclude`:** Opens a small popover with up to three options preselected from the current session's metadata: **App** (`<app_name>`), **URL pattern** (`<url>` — only shown for browser sessions with a URL), and **Window title pattern** (`<window_name>`). User picks one; the corresponding sub-list in `nova:config:capture.denylist.*` is updated. Confirm dialog reads: "Exclude `<chosen scope>` from all future captures? You can undo this in Settings → Capture → Privacy." Default selection is App (least surprising).

**Page data source.** The Capture page reads sessions and stats from the orchestrator (which queries the `sources` table filtered by `source_kind='screenpipe'`) — not from the bridge directly. The bridge is producer-only and exposes only `/health/live`, `/health/ready`, and `/test-connection`. This matches the established pattern for intel-worker and knowledge-worker, which are also producer-only services. Today's stats (Sessions, Captured time, Dropped, Top app) are aggregated by the orchestrator from the `sources` table; the Prometheus counters in Section 9 are for ops monitoring, not the dashboard surface.

**No search bar on the Capture page.** Search/recall is sub-project 2's surface — adding it here ahead of time would either be a half-implementation or churn the page when sub-project 2 ships.

### 9. Connection & Reliability

**WebSocket subscription (primary):**
- Endpoint: `ws://<screenpipe.url>/ws/events?images=false`
- Auth: `Authorization: Bearer <screenpipe.api_key>` header on connect
- Subscribes to event types: `ocr_result`, `ui_frame` (focus changes are surfaced in these)
- Reconnect on disconnect: exponential backoff `1s, 2s, 4s, 8s, 16s, 30s, 60s` (cap at 60s)
- Logs `WARNING` on each failed reconnect, `INFO` on successful reconnect

**Polling fallback:**
- After 5 successive WebSocket failures, switch to polling
- Endpoint: `GET /search?content_type=ocr&start_time=<last_seen_ts>&end_time=now&limit=1000`
- Poll every 30s
- After successful poll, attempt WebSocket reconnect every 5 min; on first WebSocket success, switch back

**Backpressure:**
- Bounded async queue inside the bridge: configurable size (default 10 sessions)
- When full, drop the **newest** session (not the oldest — preserve completed historical sessions)
- Increment `nova_screenpipe_sessions_dropped_total{reason="buffer_full"}` counter, log `WARNING`

**Failure modes:**

| Failure | Behavior |
|---|---|
| Bridge process crash | Loses in-progress focus session (≤30 min). Acceptable: sessions are bounded; not worth implementing crash-recovery in v1. |
| Screenpipe daemon unreachable | Bridge stays alive, retries indefinitely with backoff. `/health/ready` reports DOWN. |
| Engram queue saturated | Bridge buffers up to N sessions, then drops newest. Counter incremented. |
| Redis unreachable | Bridge cannot push to engram queue or refresh runtime config. Sessions buffer in memory until queue size limit, then drop. `/health/ready` reports DOWN immediately (Redis is on the critical path; there is no graceful "use last-known config" mode because the bridge can't ingest anyway). |
| Postgres unreachable | Not a bridge concern directly. Memory-service decomposer halts consuming the queue, queue depth grows, bridge eventually hits backpressure-drop. Bridge `/health/ready` stays UP (its dependencies are reachable); the symptom surfaces as growing queue depth and a memory-service `/health/ready` failure. |
| Capture paused (intentional) | Bridge keeps WS connection live and continues to receive events, but discards every session before queue push. Each discarded session increments `nova_screenpipe_sessions_dropped_total{reason="paused"}` once at session-finalize time (not per-event). `/health/ready` returns 200 — pause is intentional, not a fault. |

**Health endpoints:**
- `GET /health/live` — bridge process responsive (always 200 OK if running)
- `GET /health/ready` — returns 200 only if: connected to screenpipe (or actively polling) AND can read/write Redis. Returns 503 with reason otherwise. **Paused state still returns 200** with body `{"status": "ready", "paused": true}`.
- `GET /test-connection` — admin-only; sends a test `GET /search` to the configured screenpipe URL with current API key, returns `{ok, message, sample_event_count}` or `{ok: false, error}`. Used by the Settings page Test Connection button.

**Observability counters:**
- `nova_screenpipe_sessions_ingested_total{app}` — successful ingests by app (per finalized session)
- `nova_screenpipe_sessions_dropped_total{reason}` — drops; reasons: `denylist_app`, `denylist_url`, `denylist_window`, `under_min_duration`, `buffer_full`, `paused`
- `nova_screenpipe_websocket_reconnects_total` — reconnect count
- `nova_screenpipe_polling_active` — gauge, 1 if in fallback mode

### 10. Bridge Service Layout

Standard Nova FastAPI service pattern. Use the `service-scaffold` skill.

```
screenpipe-bridge/
├── Dockerfile
├── pyproject.toml
├── app/
│   ├── __init__.py
│   ├── main.py                  # FastAPI app, lifespan, health endpoints, /test-connection
│   ├── config.py                # pydantic_settings — env vars only (Redis URL/password, log level, port)
│   ├── runtime_config.py        # Polls/caches nova:config:* from Redis (30s)
│   ├── tenant.py                # DEFAULT_TENANT constant
│   ├── screenpipe_client.py     # WS subscriber + HTTP poll fallback
│   ├── session_aggregator.py    # Focus session lifecycle, dedup, cap/drop logic
│   ├── denylist.py              # Privacy filter
│   ├── engram_producer.py       # Builds payload + LPUSH to Redis db0 engram:ingestion:queue
│   └── metrics.py               # Counter/gauge definitions
└── tests/
    └── (integration tests live in repo-root tests/, see Testing section)
```

**Service port:** **8140** (next available after voice-service at 8130).

**Redis DB allocation:** **db10** (next available after voice-service at db9). Used for the bridge's own ephemeral state (last-seen timestamps, dropped-session counters). Note: runtime config (`nova:config:*`) lives on `db1` shared with the gateway; engram ingestion queue lives on `db0` shared with memory-service.

**Compose entry:** Add to `docker-compose.yml` with no profile (starts by default). `depends_on: redis` only — no Postgres or memory-service dependency since the bridge does not call them directly. Document the new port and DB allocation in CLAUDE.md.

**No admin secret needed.** The bridge does not call any Nova HTTP API. The only credentials it holds are the screenpipe API key (in Redis runtime config) and the standard Redis password (from `.env`).

### 11. Database Migration

**No migration needed.** Verified during spec review: `source_kind` in `memory-service/app/db/schema.sql` is `TEXT NOT NULL` with no CHECK constraint and no ENUM. Adding `'screenpipe'` as a new value is purely an application-level change — the one-line addition to `_map_source_type_to_kind()` (Section 6) is sufficient.

If a future spec wants to add a CHECK constraint as a defensive measure across all source kinds, that becomes its own design decision and migration — out of scope here.

### 12. Testing

Per project memory: tests use real services, not mocks. For the **upstream** side, we need a fake screenpipe server fixture (since real screenpipe needs a desktop and isn't reasonable to require in CI). For the **downstream** side, we run against real Nova services.

**Fixture: `tests/fixtures/fake_screenpipe.py`**
- Minimal FastAPI/Starlette server that mimics screenpipe's WS event stream and `/search` endpoint
- Configurable event scripts (replay a sequence of OCR events, focus changes, etc.)
- Used as an asyncio fixture in tests

**Test scenarios** (`tests/test_screenpipe_*.py`):

| Test | Verifies |
|---|---|
| `test_screenpipe_bridge_health.py` | Bridge starts, `/health/ready` returns 200 with fake screenpipe up |
| `test_session_aggregation.py` | Synthetic event sequence → expected session output (correct boundaries, content) |
| `test_denylist_filtering_app.py` | Denylisted app → no payload queued, dropped counter incremented with reason `denylist_app` |
| `test_denylist_filtering_url.py` | URL pattern match → dropped, reason `denylist_url` |
| `test_denylist_filtering_window.py` | Window title substring match → dropped, reason `denylist_window` |
| `test_dedup_within_session.py` | Repeated event text → single dedup'd session content |
| `test_session_cap_30min.py` | Long session → split at 30 min boundary, both halves queued |
| `test_short_session_drop.py` | <30s session → discarded, no payload, reason `under_min_duration` |
| `test_websocket_reconnect.py` | Forced disconnect → backoff and reconnect, no duplicate ingestion |
| `test_polling_fallback.py` | WS unavailable → poll mode engages, sessions still queued |
| `test_backpressure_drop.py` | Queue full → newest dropped, counter increments with reason `buffer_full` |
| `test_runtime_config_change.py` | Redis denylist change → applies on next session within 30s without restart |
| `test_engram_ingestion_payload.py` | Session → correct payload schema queued (`raw_text`, `source_type`, `session_id`, `occurred_at`, `tenant_id`, `metadata`, `source_trust`, `source_uri`, `source_title`); decomposer produces `sources` row with `source_kind='screenpipe'` and `trust_score=0.80` |
| `test_pause_resume.py` | Pause toggle → events received, sessions discarded with reason `paused`; `/health/ready` returns 200 with `paused: true`; resume → ingestion continues |
| `test_tenant_id_propagation.py` | Sessions tagged with the configured `tenant_id`; consumer doesn't fall back to default; no FC-001 grace warning emitted |
| `test_source_kind_mapping.py` | Memory-service `_map_source_type_to_kind('screenpipe')` returns `'screenpipe'`; sources created from screenpipe payloads have `source_kind='screenpipe'` |

Tests prefixed `nova-test-` per project convention; cleaned up via fixture teardown.

## Files Affected

| File | Change |
|---|---|
| `screenpipe-bridge/` (entire directory) | New service — scaffolded via `service-scaffold` skill |
| `docker-compose.yml` | Add `screenpipe-bridge` service entry (port 8140), `depends_on: redis` |
| `memory-service/app/engram/ingestion.py` | Add `'screenpipe': 'screenpipe'` entry to `_map_source_type_to_kind()` (one-line change) |
| `orchestrator/app/config_sync.py` | Add `sync_screenpipe_config_to_redis()` and `sync_capture_config_to_redis()` (or one combined function) following the `sync_llm_config_to_redis()` pattern; call from startup hook |
| `orchestrator/app/router.py` (or appropriate router file) | New endpoints to back the Capture page: list sessions filtered by `source_kind='screenpipe'`, today's stats, recent-activity feed |
| `dashboard/src/pages/CapturePage.tsx` | New top-level page |
| `dashboard/src/pages/capture/MeetingsPlaceholder.tsx` | Sub-project 3 placeholder ("Coming in sub-project 3") |
| `dashboard/src/pages/capture/JournalsPlaceholder.tsx` | Sub-project 4 placeholder |
| `dashboard/src/pages/settings/ScreenpipeConnectionSection.tsx` | New settings section |
| `dashboard/src/pages/settings/CapturePrivacySection.tsx` | New settings section |
| `dashboard/src/pages/settings/CaptureAdvancedSection.tsx` | New settings section |
| `dashboard/src/pages/Settings.tsx` | Register the three new sections under Connections / Capture tabs |
| `dashboard/src/components/layout/Nav.tsx` (or equivalent) | Add "Capture" top-level nav item |
| `dashboard/src/api.ts` | New endpoints: bridge connection test, recent sessions, exclude-scope shortcut |
| `dashboard/src/App.tsx` (or router) | Routes: `/capture`, `/capture/meetings`, `/capture/journals` |
| `tests/test_screenpipe_*.py` (16 files) | Integration tests per matrix above |
| `tests/fixtures/fake_screenpipe.py` | Fake screenpipe server fixture |
| `CLAUDE.md` | Add screenpipe-bridge to services list, port 8140, Redis DB allocation db10, runtime config keys, source_kind entry |
| `docs/setup/screenpipe.md` | New: per-OS install + config guide for the user-installed screenpipe daemon |

## Out of Scope

Explicitly **not** in sub-project 1:

- **Audio capture, Whisper transcription, meeting detection** — sub-project 3
- **Agent recall tools** (`search_screen_history`, `recall_session`) — sub-project 2
- **Dashboard search/recall UI** — sub-project 2
- **Daily/weekly/project journal generation** — sub-project 4
- **Multi-workstation support** — single device for v1 (`device_id` in metadata always `'primary'`)
- **Multi-tenant operation** — single default tenant for v1; `tenant_id` constant lives in `screenpipe-bridge/app/tenant.py` for future change
- **Forking screenpipe** — use official builds, document config; revisit if install friction becomes a real problem
- **Crash recovery / backfill from screenpipe `/search`** — losing in-progress sessions on bridge crash is acceptable
- **Content-pattern regex filtering** (credit cards, JWTs, "password:" lines) — high-effort, error-prone, defer until real leakage observed
- **Filtered-app metadata recording** ("you spent X minutes in 1Password") — privacy guarantee is cleaner if filtered = invisible
- **Auto-discovery of screenpipe** (mDNS, etc.) — explicit URL config only
- **CHECK constraint on `source_kind`** — application-level enforcement only for v1
- **Bridge-side direct writes to Postgres or any Nova HTTP API** — bridge is queue-producer-only, matching the established intel-worker / knowledge-worker pattern

## Open Questions for Future Sub-projects

These don't block sub-project 1 but should be considered when designing 2/3/4:

- **Multi-workstation:** When the user has >1 source machine, how is `device_id` assigned and surfaced in the UI? (Likely: dashboard-managed device registry with friendly names.)
- **Recall granularity (SP-2):** Does sub-project 2's recall operate at session level (return whole sessions) or engram level (return decomposed facts)? Probably both.
- **Meeting candidate signal (SP-3):** Does the bridge produce a "meeting candidate" event when audio is active in a known meeting app, or does sub-project 3 detect meetings independently from screenpipe's own meeting detection? (Screenpipe has built-in meeting detection in `screenpipe-engine` — worth integrating with.)
- **Journal scoping (SP-4):** What time windows and groupings produce useful journals? Per-day per-project? Per-week summaries? Calendar-aware?

## Build Notes

- Use the **`service-scaffold` skill** to scaffold `screenpipe-bridge`.
- All tests run via `make test` per project convention.
- The implementation plan will come from the **`writing-plans` skill** after this spec is approved.
