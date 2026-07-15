# Video ingestion — watch a video or a source (source-agnostic)

Implementation plan (authored 2026-07-15 with Opus, at Jeremy's request;
generalized beyond YouTube per his 2026-07-15 follow-up). Goal: point Nova
at a video from *any supported source* and she ingests its content into
memory; point her at a source (a creator's channel/page, a playlist) and
she backfills past uploads and watches for new ones. Answers cite the
video with a jump-to timestamp.

**Not YouTube-specific.** Extraction is built on `yt-dlp`, which supports
1000+ sites (YouTube, Vimeo, Twitch VODs, Dailymotion, PeerTube,
SoundCloud, direct-hosted files, many more). YouTube is the *first
supported and best-tested* source, not the only one. A plain direct media
URL (an `.mp4`/`.webm`/`.mp3` link, self-hosted video) is handled too,
straight through ffmpeg→whisper with no extractor needed. The design below
is written around a source-neutral `<extractor>:<id>` identity so nothing
assumes YouTube.

Roadmap item #8. Decisions marked LOCKED are settled here; OPEN items are
flagged for Jeremy at the bottom and have chosen defaults so a build can
start without waiting.

## Use cases (Jeremy, 2026-07-15)

1. "Nova, ingest <video url>" (any yt-dlp-supported site, or a direct
   media URL) → transcript + metadata into memory, retrievable in chat.
2. "Nova, follow <source url>" (a channel/creator/playlist page on any
   supported site) → ingest recent past videos AND keep ingesting new
   uploads automatically, until unfollowed.

## Why this is cheaper than it looks

The hard part — audio → text — is **already being built**: the voice
lane's `whisper` service (docs/plans/voice.md phase 2) is a faster-whisper
STT server. Video ingestion reuses it verbatim for videos that lack
captions — and audio→whisper is the **universal fallback** that makes this
source-agnostic (captions availability varies wildly by site; audio
extraction via yt-dlp/ffmpeg works almost everywhere). So this feature is
mostly: fetch (yt-dlp), prefer captions, else whisper, chunk, store in the
memory system that already exists, and a source-poll automation on infra
that already exists. **Sequencing: build voice phase 2 first**; this
lane's transcription fallback depends on that service.

## Architecture

```
chat tool call / automation
        │  ingest_video(url) | follow_source(url)
        ▼
     backend ───HTTP──▶ media worker (yt-dlp + ffmpeg)
        │                   │  1. metadata (yt-dlp --dump-json — any site)
        │                   │  2. captions if the site offers them
        │                   │  3. else download audio → whisper /transcribe
        │                   ▼          (direct media URL → skip 1–2, ffmpeg→whisper)
        │              {metadata, segments:[{start,end,text}]}
        ▼
   ingest: chunk segments → markdown notes → memory.write(source_type="video")
        │
        └─ subscriptions table + scheduled automation re-enumerates each source
```

- **New compose service `media`** (profile `ingest`, like voice's
  profile): a small FastAPI app bundling `yt-dlp` + `ffmpeg`. Isolating it
  keeps heavy binaries and *all outbound fetching* out of the backend (a
  clean network/security boundary — the backend never shells out to
  yt-dlp). yt-dlp is the source-abstraction layer: the same code path
  handles every supported site, so "add a source" is usually "yt-dlp
  already does it". Endpoints:
  - `GET /health`
  - `POST /metadata {url}` → `{extractor, id, title, uploader_id,
    uploader, uploaded_at, duration_s, description, chapters, is_live}`
    (`extractor`+`id` from yt-dlp are the source-neutral identity)
  - `POST /extract {url, want:"captions|audio"}` →
    `{source:"captions"|"audio", language, segments:[{start,end,text}]}`.
    Captions when the site has them; else (or `want:"audio"`) download
    bestaudio, transcode to 16 kHz mono, call the **whisper service**
    `/transcribe`. A bare direct media URL skips extraction and goes
    straight ffmpeg→whisper. Long audio is windowed so one 3-hour video
    isn't a single request.
  - `POST /source/list {url, limit}` → a creator page / channel /
    playlist enumerated flat (`yt-dlp --flat-playlist`, works uniformly
    across sites), newest first, capped by `limit`. Returns
    `[{extractor, id, url, title}]`.
- **whisper reuse**: `media` calls whisper over the compose network; no
  duplicate model. If the voice profile isn't running, caption-bearing
  videos still ingest; audio-fallback videos return a clear "needs
  whisper" error surfaced to the operator (operator-visible-outcomes rule).
- **Ingestion into memory**: the existing `memory.write(...,
  source_type="video")` path. Each video becomes one or more markdown
  notes (see Chunking). The BM25 index picks them up on write — no new
  store. Deep-linking: the chunk header carries the source's native
  timestamped URL (yt-dlp gives us the canonical `webpage_url`; append the
  site's time param — `&t=` on YouTube, `#t=` on Vimeo, etc.) so a cited
  answer links to the exact moment.

## Data model (new migration — check `backend/app/migrations/` for next free number)

Source-neutral: the primary key is `<extractor>:<id>` (e.g.
`youtube:dQw4...`, `vimeo:12345`, `twitch:98765`), never a bare YouTube id.

```sql
video_ingests (            -- dedupe + provenance, one row per video
  media_key     text primary key,  -- "<extractor>:<id>"
  extractor     text,              -- youtube | vimeo | twitch | generic | ...
  source_id     text null,         -- the followed source this came from (fk-ish)
  title         text,
  url           text,              -- canonical webpage_url
  duration_s    int,
  transcript_source text,          -- captions | whisper
  language      text null,
  segment_count int,
  ingested_at   timestamptz,
  status        text               -- ok | failed | skipped
)
source_subscriptions (     -- a followed creator/channel/playlist, any site
  source_id     text primary key,  -- "<extractor>:<uploader_or_playlist_id>"
  extractor     text,
  source_url    text,
  title         text,
  added_at      timestamptz,
  last_checked_at timestamptz null,
  backfilled    bool default false,
  active        bool default true
)
```

`video_ingests` is the idempotency guard: re-ingesting a known `media_key`
is a no-op unless `force`. The source poll and manual ingest both consult
it, so a video reachable via two followed sources still ingests once.

## Chunking (LOCKED policy)

Whole-transcript notes retrieve badly (a 2-hour talk is one giant blob).
Chunk by **chapter when yt-dlp reports chapters**, else by fixed ~90-second
windows merged to ~1–2k chars, each chunk a note:

```
---
title: <video title> — <chapter or mm:ss–mm:ss>
source: video
media_key: <extractor>:<id>
url: <canonical webpage_url with the site's timestamp param>
channel: <uploader name>
---
<transcript text for this span>
```

Retrieval then returns the relevant span with its own deep link. Store the
raw full transcript too (one `source_type="video_full"` note or a file
under the memory dir) so nothing is lost, but the chunks are what feed
chat context.

## Tools (granted to a "librarian"/research agent, or main)

Enforced in the tool, not the prompt. Source-neutral naming (a "source"
is a channel/creator/playlist on any site):
- `ingest_video(url, force=false)` — one video from any supported site or
  a direct media URL; returns title + chunk count or a readable failure.
- `follow_source(url, backfill=10)` — add subscription, ingest the N most
  recent now, mark for ongoing polling. `backfill=0` = future-only.
- `list_followed_sources()` / `unfollow_source(source_id)`.
- `list_ingested_videos(source_id?)`.
All run under the autonomous safety rails (ledger + wall-clock budget) —
ingestion is bounded work, and a huge source must not run unbounded (see
Traps).

## Source monitoring (reuses the scheduler/automations infra)

A seeded automation `poll-followed-sources` (default hourly): for each
active subscription, list the source's newest videos, diff against
`video_ingests`, ingest the new ones (cap per run so a burst can't blow
the budget). Updates `last_checked_at`. Same automation pattern already
shipped; no new scheduling primitive.

How "list newest" works per source:
- **General path (any site)**: `media` re-enumerates the source URL via
  `yt-dlp --flat-playlist` (newest-first, capped) — works uniformly for
  YouTube channels, Vimeo user pages, Twitch channels, playlists, etc.
- **YouTube fast-path (optional optimization)**: the keyless RSS feed
  `https://www.youtube.com/feeds/videos.xml?channel_id=<id>` (~15 newest)
  is cheaper than a flat-playlist enumeration; use it when the extractor
  is `youtube`, fall back to the general path otherwise. Nice-to-have, not
  required for correctness.
Politeness: stagger sources, respect a per-source min interval, and cap
concurrent enumerations so a big follow-list doesn't hammer any one site.

## UI (reachable by navigation — memory rule)

A **Library** surface (new Settings/overlay tab, or a section on an
existing one): 
- followed sources (title, site, last checked, video count, unfollow),
- an "ingest a video / follow a source" input (URL + backfill count) —
  accepts any supported URL, shows the detected extractor on paste,
- recent ingested videos with status, site badge, and a link out,
- failures visible with their reason (not just a red dot).
Ingestion is long-running: show progress (queued → fetching → transcribing
→ N chunks) the way the model-pull UI streams progress.

## Phases (each ends live-verified; changes left uncommitted, summarized)

1. **Single video, captions-only.** `media` service with `/metadata` +
   `/extract` (captions path), `ingest_video` tool, chunking + memory
   write, dedupe table keyed on `<extractor>:<id>`. Verify: ingest a
   captioned talk from chat, then ask a question only answerable from it
   and get a cited answer with a working timestamp link. Test at least one
   non-YouTube captioned source (e.g. a Vimeo/conference talk) to prove
   the path is genuinely source-agnostic, not YouTube-shaped.
2. **Whisper fallback.** Audio download + transcode + whisper
   `/transcribe` for caption-less videos, and the direct-media-URL path.
   Depends on voice phase 2. Verify: ingest a caption-less video AND a
   bare `.mp4` URL; transcripts appear.
3. **Sources.** Subscriptions table, `follow_source` with backfill,
   `poll-followed-sources` automation (general flat-playlist path; add the
   YouTube RSS fast-path if cheap), Library UI. Verify: follow a small
   source with backfill=3, see 3 videos ingested; lower the poll interval
   and watch a new upload get picked up without double-ingesting.
4. **Polish.** Per-video summarization note (OPEN #2), non-English
   handling, progress streaming in the UI, budget/caps surfaced, YouTube
   RSS fast-path if not already done.

## Traps / risks

- **Source size**: a source can have thousands of videos. `backfill` is
  capped (default 10, hard max e.g. 200 with explicit opt-in); the poll
  ingests only *new* keys and caps per-run. Never enumerate-and-ingest a
  whole source unbounded — it would exhaust storage and the automation
  budget.
- **Per-source variance**: sites differ in caption availability, metadata
  richness, rate limits, and whether a "creator page" is even
  enumerable. Treat yt-dlp's capabilities as the contract; when a source
  can't be enumerated, `follow_source` fails with a clear reason rather
  than pretending. Caption-less sites simply take the whisper path.
- **Per-source auth / cookies (OPEN #3)**: some content needs a login
  (Twitch subscriber VODs, private/members Vimeo, age-restricted). Default
  is keyless / public-only; an optional per-source cookies file is the
  escape hatch if Jeremy wants it. No circumvention of DRM or paywalls.
- **ToS / legal posture (OPEN #3)**: yt-dlp usage is the user's call;
  document that this is personal/fair-use ingestion. Some sites' ToS
  disallow downloading — that's on the operator; surface it, don't police
  it beyond the no-auth-circumvention default.
- **Storage growth**: transcripts are text (cheap) but a heavily-followed
  set adds up; the Storage card should count video notes, and there needs
  to be an unfollow + purge path.
- **Live streams / premieres / Shorts**: skip live/upcoming (no final
  transcript) — `is_live` from metadata; Shorts/short clips are fine. Mark
  `skipped`.
- **Non-English**: whisper transcribes many languages; captions may be
  auto-translated. Store the detected `language`; don't force English.
- **Long videos**: window the audio for whisper (e.g. 10-min segments) so
  a 3-hour video is many bounded jobs, not one 3-hour request.
- **yt-dlp breakage**: sites change and break yt-dlp periodically — pin a
  recent version and make it updatable via the image (yt-dlp ships fixes
  fast); surface extraction failures clearly rather than silently dropping
  videos. A failing extractor for one site must not take down the others.
- **Duplicate across sources / re-uploads**: dedupe is by `<extractor>:
  <id>`, so a video reachable via two followed sources ingests once. (A
  genuine re-upload elsewhere is a different key — acceptable.)
- `docker compose up -d backend` after env changes (CLAUDE.md trap); new
  service means a profile add + `--profile ingest up -d`.

## Open decisions for Jeremy (defaults chosen; build can start on phase 1)

1. **Backfill default N** — plan assumes 10 most-recent on follow, future-
   only available with `backfill=0`. Bigger default?
2. **Per-video summary** — store just the chunked transcript (plan
   default), or also have a model write a short summary note per video
   (better recall, costs tokens per video — matters at source scale)?
3. **Auth / ToS posture** — keyless, no-cookies, public-only (plan
   default), or allow a per-source cookies file for member/private
   content on sites that need it?
4. **Which sources to prioritize** — plan supports anything yt-dlp does,
   with YouTube best-tested first. Any specific non-YouTube sources
   (Vimeo, Twitch, a specific platform) to target/test in phase 1?
5. **Where the Library UI lives** — new overlay tab vs. a section under an
   existing tab (plan leaves it to whoever builds phase 3, following the
   established tab pattern).
