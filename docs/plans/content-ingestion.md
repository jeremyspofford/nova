# Content & source ingestion — one pipeline, any source (was video-ingestion.md)

Reconciled 2026-07-21 with Fable, at Jeremy's request. Originally scoped as
video-only, then generalized 2026-07-15 to "any source"; this pass
generalizes it one step further — video/audio ingestion is not a separate
feature bolted next to web ingestion, it is the **same** ingestion pipeline
(same agent, same memory format conventions, same dedupe philosophy) gaining
a second extraction mechanism. Roadmap item #8. Also referenced from the
"Self-improving Nova" discussion-backlog entry — this plan is the INPUT half
of that arc; `recommendation-surface.md` is the OUTPUT half.

Decisions marked **LOCKED** are settled here. Items marked **OPEN** are
genuinely Jeremy's call — flagged, not silently decided — with the default
that lets phase 1 proceed without waiting.

## What already exists (build ON this, not over it)

Do not re-read this as background — it is the foundation phase 1 is built on
top of, unmodified:

- **Ingestion agent** (`agents` row `ingestion`, seeded migration 006,
  evolved through 007/008/009/013/018/021/027/032) already reads external
  content and distills it into durable memory topics. It operates in three
  modes today — **INGEST** (fetch a URL, distill, write), **REFRESH**
  (re-fetch a known topic in place via `item_id`, never re-search-and-guess),
  **RESEARCH** (`web_search` → fetch up to ~3 candidates → store what has
  durable value, report the rest as ephemeral). Current live model:
  `openrouter:z-ai/glm-5.2`. Tools granted: `web_search`, `fetch_url`,
  `write_memory`, `search_memory`, `read_memory_item`, `list_stale_topics`,
  `get_weather`, `raise_recommendation`.
- **`fetch_url`** (`backend/app/tools/web_fetch.py`) — GET-only, SSRF-guarded
  (per-redirect-hop hostname resolution, private/loopback/link-local/reserved
  ranges refused), 20s/200KB/15,000-char caps, HTML→text extraction.
- **`web_search`** (`backend/app/tools/web_search.py`) — bundled SearXNG
  first, keyless DuckDuckGo HTML fallback. No keyed providers, by product
  principle.
- **Memory freshness policy** — retrieval surfaces `(learned <date>, source:
  <url>)`; main knows when to trigger a REFRESH vs. answer from cache
  vs. attribute a stale answer.
- **`refresh-stale-knowledge`** automation (migration 013) — the seeded
  polling pattern this plan's future source-following automation extends:
  `list_stale_topics` (mechanical scan) → ingestion agent acts on what it
  finds. Scheduler infra (`backend/app/scheduler.py`, 60s tick, per-automation
  timeout override, failure journaling, 5-strike auto-disable) is generic and
  needs nothing new for a "poll a source" automation later.
- **Guardrails + autonomous safety rails** — every tool call passes through
  `execute_tool`'s single dispatch point (guardian rules, redaction); the
  action ledger / wall-clock kill rail bound autonomous runs. Media ingestion
  inherits all of this for free — it is a tool call like any other.
- **whisper service** (`whisper/app.py`, `voice` compose profile) — the
  transcription fallback this plan reuses verbatim. Contract, confirmed by
  reading the running code (the original spec assumed more than this):
  `POST /transcribe` takes a raw audio body (webm/opus/mp4/wav, PyAV-decoded)
  and returns **one shot**: `{"text": ..., "language": ..., "language_probability":
  ...}` — no per-segment timestamps. This matters for the chunking design
  below (see "Chunking policy — corrected").

New in this pass, phase 1, described in full below: the `media` worker
service, `media_ingests` dedupe ledger, `ingest_media` tool, and the
dedicated `ingestion` model-recs role.

## Why one pipeline, not a video silo

Jeremy's framing: Nova should learn from videos **and** blogs, articles,
arbitrary pages, and *sources* (a creator/channel/blog/feed) as one
capability, not a video-specific side feature. Concretely, "one pipeline"
means:

- **One agent.** `ingestion` gains a fourth mode (INGEST-MEDIA) alongside
  INGEST/REFRESH/RESEARCH. No `video-ingestion` or `media` agent was created.
- **One model, one recs role.** The dedicated `ingestion` role in
  `model_recs.py` covers whatever `ingestion` the agent does, web or media —
  it's a property of the AGENT's job (large-context, faithful, cheap,
  tool-capable, batch), not of one content kind.
- **One memory format family.** Both paths write `type=topic` items with
  `source_url` provenance, participate in the same write-time linking pass
  (`_link_pass` in `memory.py` — shared tags, wiki-links), the same tag
  -hygiene guidance, the same brain-graph rendering, the same freshness
  policy at retrieval time.
- **Different extraction mechanism, by necessity, not by design choice.**
  HTML pages and AV content genuinely need different tools (`fetch_url` vs.
  yt-dlp+ffmpeg+whisper) — there is no way to collapse that into one code
  path. What stays unified is everything *around* extraction: which agent
  does it, which model reasons over it, how it's deduped and cited, how it
  shows up in memory and the brain graph.
- **Source-neutral dedupe, two families, not one key format.** The original
  spec's `<extractor>:<id>` key works cleanly for AV content because yt-dlp
  hands you exactly that. Web pages don't have an equivalent extractor/id
  pair — their existing dedupe (`search_memory` + title match + `item_id`
  pin refresh) is a **URL identity**, already field-proven, and not broken.
  **LOCKED**: phase 1 does not retrofit a mechanical `media_ingests`-style
  ledger onto web pages — that pipeline stays exactly as it is (regression
  -checked, not touched). A true structural unification (one ledger table,
  keys `media:<extractor>:<id>` | `web:<normalized-url>`) is flagged as a
  later opportunity, not required for source-agnostic behavior today. See
  OPEN #5.

## Architecture

```
chat tool call / automation
        │  ingest_media(url, force=false)
        ▼
     backend ──HTTP──▶ media worker (yt-dlp + ffmpeg)
        │                  │ 1. yt-dlp metadata (any site; is_live → skipped)
        │                  │ 2. captions if the site offers vtt, else:
        │                  │ 3. download audio → window (ffmpeg) → whisper
        │                  │    /transcribe per window (coarse timestamps)
        │                  ▼
        │             {media_key, title, url, transcript_source, language,
        │              chapters, segments:[{start,end,text,deep_link}]}
        ▼
   ingest_media tool (mechanical):
        │  1. dedupe check (media_ingests ledger) — already_ingested short
        │     -circuits before any writing happens
        │  2. write the FULL transcript as one memory topic, guaranteed,
        │     in code — nothing is lost regardless of step 3
        │  3. record the ledger row
        │  4. hand segments + deep links back to the agent
        ▼
   ingestion agent (LLM, dedicated 'ingestion' role/model):
        writes CHUNKED, TIMESTAMPED notes (chapter- or ~1-2k-char-span
        grouped), one write_memory call per chunk, using the tool-provided
        deep_link per segment (never hand-built)
```

Compare to the existing web path: `fetch_url` → agent DISTILLS → one
`write_memory` call. Media ingestion's extra mechanical steps (dedupe ledger,
guaranteed full-transcript write) exist because a transcript is much larger
than a fetched page (capped at 15,000 chars) and the model's chunking is a
best-effort quality pass, not a completeness guarantee — the full transcript
must survive even if the model's chunking is lazy or truncated by a tool
-round budget. Web pages don't need this belt-and-suspenders treatment; they
fit in one distillation pass already.

## Chunking policy — corrected from the original spec

The original `video-ingestion.md` assumed whisper would return per-segment
timestamps (`segments:[{start,end,text}]`) the way caption tracks do. Reading
the actual shipped `whisper/app.py` (voice phase 2) shows it does not — one
`POST /transcribe` returns one text blob for the whole audio clip, no
internal segmentation. **LOCKED, corrected design**:

- **Captions path**: real per-cue timestamps from the site's VTT track —
  fine-grained, same as originally planned.
- **Whisper-fallback path**: the *media worker* windows the audio into fixed
  spans (`MEDIA_WHISPER_WINDOW_S`, default 300s/5min) via one `ffmpeg -f
  segment` pass before calling whisper once per window. Timestamps are
  therefore **per-window**, not per-sentence — coarser than captions, but
  still genuinely timestamped and deep-linkable. This is a real fidelity
  gap versus the original plan's "~90-second windows merged to 1-2k chars"
  chapter-or-span design; closing it would mean either running whisper with
  word-level timestamp output (a whisper-service change, out of scope here)
  or a smaller window (more HTTP round-trips, slower ingestion). Phase 1
  ships the 5-minute default as the pragmatic middle ground and makes it
  operator-configurable (`MEDIA_WHISPER_WINDOW_S` env on the `media`
  service). See OPEN #4.
- **Note-writing chunking** (which spans become separate memory topics) is
  the ingestion agent's job either way, guided by chapters when yt-dlp
  reports them, else the tool-provided segments' own boundaries — this part
  is unchanged from the original design, just now explicit about the
  granularity it's working from.
- **Format** (per chunk, unchanged from the original spec):
  ```
  ---
  title: <video title> — <chapter or mm:ss–mm:ss>
  type: topic
  source_url: <native deep link at that chunk's start>
  tags: [media, ...]
  ---
  <transcript text for this span, wording preserved>
  ```
- **Full transcript**: guaranteed via one mechanical `write_memory` call
  inside the `ingest_media` tool itself (`source_type: media_transcript`,
  title `"<title> — full transcript"`), before the agent does anything —
  the original plan's "store the raw full transcript too so nothing is
  lost" locked-in as code, not agent discipline.

## Agent + model architecture (Jeremy's intent #2 — LOCKED)

**One agent, one dedicated role, no fork.** `ingestion` gains `ingest_media`
as a fourth tool alongside its web tools; no new agent was created.

**New `ingestion` role in `model_recs.py`**, distinct from `tools`:
- `_AGENT_PROFILES["ingestion"] = "ingestion"` (was borrowing `"tools"`).
- `_PROFILE_ROLE["ingestion"] = "ingestion"`.
- Scoring reuses the `tools` tuple shape — `(tier_rank, local, size)`,
  reliability first, local preferred when tied, bigger preferred over
  smaller on a further tie — because ingestion is genuinely the same
  "reliability matters, latency doesn't" shape as `tools`, just justified
  differently: **latency truly doesn't matter** (batch/background, unlike
  interactive `tools` calls), and bigger is never a downside because more
  context headroom only helps with long transcripts/articles.
- `curated_models._ROLES` gained `"ingestion"` (was `chat|tools|guard|
  compaction|voice`).
- Tagged rows (migration 034), spanning the hardware range the way the
  `voice` role already does (migration 022's tiering precedent):
  - `openrouter:z-ai/glm-5.2` — cloud default. **Already the ingestion
    agent's live model** (migration 017), so this reuses what's already
    there — no new key, 1M context (verified in its existing curated notes),
    tier A.
  - `ollama:gemma4:e2b` — CPU-only floor, 12GB RAM, tier B, **128K context
    (already documented in its curated notes)** — the safest verified-large
    -context local pick for machines without a capable GPU.
  - `ollama:qwen3:14b` / `ollama:qwen3:32b` — GPU-tiered local flagships,
    tier A (current-gen, successors to the retired qwen2.5:14b/32b rows).
    **Honesty note**: their curated `notes` don't state a verified context
    window (unlike gemma4:e2b/glm-5.2, whose notes do) — Qwen3 dense models
    are documented upstream around 32K native / 128K with extended-context
    settings, but that hasn't been probed on this box. Tagged anyway because
    tool-tier-A reliability is the stronger differentiator for "faithful
    extraction" than an unverified context ceiling; flagged here rather than
    asserted as fact.
- **Result**: on a GPU-equipped box, the recs engine's *default suggestion*
  for `ingestion` may come back as a local model (qwen3:32b, if it fits) with
  glm-5.2 offered as the cloud alternate — the reverse of "cloud primary,
  local alternate." This is intentional, not a bug: it's the same local
  -first behavior the `tools` role already has, and it satisfies the actual
  requirement even more strongly (a cloud pick always carries a local
  alternate; here a local pick carries a cloud one). The agent's actual
  assigned model is **unchanged by this plan** — still glm-5.2, exactly per
  "cloud default reuses glm-5.2, already the default, no new key" — Detect &
  suggest merely makes the alternative visible and lets Jeremy choose.
- **No new schema column for context length.** `curated_models` has no
  `context_tokens` field, and adding one would require editing
  `SettingsOverlay.tsx` (the curated-model editor renders its fields), which
  this session was told not to touch. Context capability is curated into
  *which rows carry the `ingestion` role* and documented in `notes` instead
  — the same convention migration 022/023 already established (see
  gemma4:e2b/gemma4:12b's notes). Flagged as OPEN #6 for a future session
  with SettingsOverlay in scope.

## Data model

```sql
-- migration 033 (built)
media_ingests (
  media_key          text primary key,   -- "<extractor>:<id>"
  extractor          text not null,
  title              text,
  url                text not null,      -- canonical webpage_url
  duration_s         integer,
  transcript_source  text,               -- captions | whisper
  language           text,
  segment_count      integer,
  full_transcript_item_id text,          -- memory item id of the guaranteed
                                          -- full-transcript note
  status             text not null default 'ok',  -- ok | failed | skipped
  ingested_at        timestamptz not null default now(),
  updated_at         timestamptz not null default now()
)
```

`source_subscriptions` (the followed-source table from the original spec) is
**not built in phase 1** — it belongs to phase 2 (Sources) below. Adding it
now would be speculative schema; migration 033 intentionally omits a
`source_id` column on `media_ingests` for the same reason — ALTER TABLE later
is cheap, a dangling unused FK-ish column now is not better.

## The `media` worker service (built, phase 1)

New optional compose service `media` (`docker compose --profile media up
-d`), no published port — reachable only from the backend over the compose
network, matching the `inference-control`/`mcp-runner` sidecar security
posture the operator already trusts. FastAPI app, yt-dlp + ffmpeg installed
via pip/apt (same shape as the `whisper` Dockerfile).

- `GET /health` → `{"status": "ready", "yt_dlp_version": ...}`
- `POST /extract {url}` →
  - `{"status": "skipped", "reason": ...}` for live/upcoming streams
    (`is_live`/`is_upcoming` from yt-dlp metadata — no final transcript
    exists yet)
  - `{media_key, extractor, id, title, url, uploader, duration_s,
    transcript_source: "captions"|"whisper", language, chapters,
    segments: [{start, end, text, deep_link}]}` on success — `deep_link` is
    built server-side per extractor (`&t=` on YouTube, `#t=` on Vimeo,
    HTML5 media-fragment `#t=` as the generic-site best effort, plain URL
    for anything unrecognized) so the model never hand-constructs a
    timestamp URL and gets it wrong.
  - 4xx/5xx with a plain-text `detail` on failure (duration over the
    `MEDIA_MAX_DURATION_S` cap, extraction failure, no transcribable
    content, whisper unreachable with a clear "start the voice profile"
    message) — the same "surface it clearly, don't silently drop" posture
    `fetch_url` already has.
- Caption path: prefers manual subtitles over auto-captions, English first
  else the first available language, **vtt format only** (every
  yt-dlp-backed site checked offers it; parsing every subtitle format
  wasn't worth the complexity for phase 1 — OPEN if a real source needs a
  format outside vtt). Hand-rolled VTT cue parser (no new dependency,
  matching the hand-rolled HTML parser precedent in `web_fetch.py`),
  collapsing consecutive duplicate cues (rolling auto-captions repeat the
  previous line as a visual effect).
- Whisper-fallback path: yt-dlp downloads bestaudio, one `ffmpeg -f segment`
  pass resamples to 16kHz mono AND slices into fixed windows, each window
  POSTed to the whisper service in order. Works identically for a direct
  media URL (yt-dlp's generic extractor handles plain `.mp4`/`.mp3` links
  the same way).
- `MEDIA_MAX_DURATION_S` (default 14400 = 4h) refuses oversized items before
  downloading anything — mirrors the original spec's backfill-cap reasoning,
  applied per-item.

Backend side: `app/media_client.py` (httpx client, 30-minute timeout — long
enough for a whisper-fallback pass on a real video, still bounded) and
`app/media_ingests.py` (the dedupe ledger CRUD). The `ingest_media` builtin
tool (`app/tools/builtin.py`) wires them together — see "Architecture"
above for the exact call sequence.

## UI

**Not built in phase 1** (matches the original spec's phase-3 placement).
Today: ingestion is chat-driven only ("Nova, ingest this video") and
inspectable via `search_memory`/the existing brain graph (media topics show
up like any other topic, tagged `media`). A **Library** surface (followed
sources, ingested-media list with status/site badge, an ingest input showing
the detected extractor on paste) remains phase-3 scope, unchanged from the
original spec — see OPEN #7 for where it should live in the tab structure.

## Phases

1. **Media ingestion, single item — BUILT this session.** `media` worker
   (captions + whisper-fallback in one phase, not split — whisper phase 2
   already shipped, so there's no reason to sequence around it the way the
   original spec had to), `media_ingests` dedupe ledger, `ingest_media` tool,
   INGEST-MEDIA mode on the ingestion agent, dedicated `ingestion` model
   -recs role. Verify: ingest a real short video (captioned, ideally
   non-YouTube to prove source-agnosticism per the original spec's
   verification bar) through chat, confirm a chunked+cited answer; regression
   -check the web path is untouched.
2. **Sources — not built, unchanged scope from the original spec.**
   `source_subscriptions` table (ALTER/CREATE, not pre-built now),
   `follow_source(url, backfill)` / `list_followed_sources` /
   `unfollow_source` tools, a `poll-followed-sources` automation on the
   existing scheduler infra (general path: `yt-dlp --flat-playlist`
   re-enumeration; YouTube RSS fast-path optional), Library UI. All the
   original spec's "Traps" reasoning (source-size caps, per-source
   variance, auth/cookies posture, dedupe across sources) still applies
   unchanged — nothing here needed reconciling, only re-affirming it still
   fits on the phase-1 foundation.
3. **Polish — unchanged scope.** Progress streaming in the UI (queued →
   fetching → transcribing → N chunks, the model-pull UI's existing
   pattern), non-English handling refinement, YouTube RSS fast-path if not
   already done in phase 2, and OPEN #2 (per-item summary) if Jeremy wants
   it added.

## Open decisions for Jeremy

Numbering continues from the original spec where the question is unchanged;
renumbered/new ones follow.

1. **Backfill default N** (unchanged from original spec) — phase 2 will
   default to 10 most-recent on follow, future-only via `backfill=0`.
   Bigger default?
2. **Per-item summary note** (unchanged from original spec) — phase 1 stores
   the guaranteed full transcript + agent-written chunks, no separate
   "summary" note. Add one later (better recall, costs tokens per item — the
   dedicated ingestion model makes this cheaper than it would've been on a
   general-purpose model, but still a real cost at source scale)?
3. **Auth / ToS posture** (unchanged from original spec) — keyless,
   no-cookies, public-only is the phase-1 default (and the only thing
   built). Allow a per-source cookies file for member/private content later?
4. **Whisper-fallback window size** (new) — phase 1 ships
   `MEDIA_WHISPER_WINDOW_S=300` (5 min) as the default, a coarser
   -but-fewer-round-trips middle ground versus the original spec's
   ~90-second target. Worth tightening (more HTTP calls, finer citation
   granularity on caption-less content) once real usage shows whether 5
   -minute citation resolution is actually annoying in practice?
5. **Web-ingestion dedupe unification** (new) — phase 1 deliberately leaves
   web-page dedupe on its existing `search_memory`+`item_id` pattern rather
   than folding it into a `media_ingests`-shaped mechanical ledger. Worth
   unifying into one `content_ingests` table (`web:<url>` / `media:
   <extractor>:<id>` keys) later for a single audit surface, or is "two
   dedupe mechanisms, one per content family" fine long-term?
6. **`context_tokens` on curated_models** (new) — phase 1 curates "which
   models get the `ingestion` role" as a proxy for context capability
   instead of adding a real column, specifically to avoid touching
   `SettingsOverlay.tsx` (out of scope this session per Jeremy's
   instruction). Worth adding a real filterable column + editor field in a
   session that has that file in scope?
7. **Library UI placement** (unchanged from original spec) — new overlay tab
   vs. a section under an existing one, left to whoever builds phase 2/3.
8. **Non-vtt caption formats** (new, small) — phase 1's caption path only
   parses vtt. If a real source's only offered format is something else
   (ttml, srv3, json3), it silently falls through to the whisper path
   today (correct behavior, just coarser timestamps than the site's own
   captions would give). Worth adding more parsers if this turns out to be
   common?

## Traps / risks (unchanged from the original spec, still apply)

Source size caps, per-source variance (some sites can't be enumerated),
auth/cookies posture, storage growth, live-stream/premiere/Shorts handling,
non-English handling, long-video windowing, yt-dlp breakage (sites evolve
their anti-bot posture; pin a recent version, expect periodic bumps),
duplicate-across-sources dedupe, and the `docker compose up -d backend`
env-reload trap all carry over from the original spec unchanged — see the
git history of this file (`video-ingestion.md` prior to this rewrite) for
the full original text if needed.
