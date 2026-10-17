# 24 — Ambient Memory (Screen & Audio Capture)

> **Status:** draft. Nova should gain a Screenpipe-style capability: optional always-on capture
> of what's on screen and what's said, made searchable and usable by agents. This document
> defines the integration shape. **Reconcile against the external Screenpipe findings
> document when it lands** (see §9) before implementation.

## 1. Purpose

Give the user and their agents a private, local, searchable memory of activity:

- **Visual**: screen frames + OCR (text seen on screen), window/app titles, timestamps.
- **Audio**: microphone and system audio + speech transcription, speakers, timestamps.
- **Context**: app/window, URL, file, meeting, calendar event where available.

This enables questions like "what was that error I saw yesterday?", "summarize the meeting and
the doc I was reading", and automations triggered by on-screen or spoken events.

## 2. Principles

1. **Local-first by default.** Capture, OCR, and transcription run on the device; nothing
   leaves it unless the user explicitly enables cloud processing for a source.
2. **Opt-in and obvious.** Off by default; a persistent indicator and a global pause hotkey.
3. **Excludable.** Per-app, per-site, and per-window exclusion lists; a sensitive-content
   blocklist (password managers, banking, health) is on by default.
4. **Ephemeral by choice.** Retention windows per source; delete and "forget last N minutes".
5. **Encrypted at rest.** Captures are encrypted; keys are device-held by default.

## 3. Capture pipeline

```
screen ─▶ frame sampler ─▶ dedupe/keyframe ─▶ OCR ─▶ text + boxes
                                                    │
mic / system audio ─▶ VAD/segment ─▶ STT ─▶ transcript segments
                                                    ▼
                              normalized capture records ─▶ encrypted store ─▶ index
```

- **Screen sampling**: adaptive rate (default 1 frame / 2 s, configurable), keyframe dedupe,
  multi-monitor support, per-monitor metadata.
- **OCR adapters**: platform APIs first (macOS Vision, Windows OCR), then Tesseract /
  PaddleOCR on Linux; language packs configurable.
- **STT adapters**: local Whisper-family models by default (served by a compute node or
  on-device), optional cloud when enabled; voice-activity segmentation and speaker labels
  where available.
- **Metadata**: app id, window title, URL, and (optionally) active calendar event.
- **Normalized record** (see §6) is what everything else consumes, so capture backends are
  swappable.

## 4. Storage & indexing

- Blobs (frames/audio) under `blobs/ambient/…`, encrypted; DB rows hold metadata + text.
- **Full-text index** over OCR text + transcripts (SQLite FTS5).
- **Vector index** over chunked text for semantic recall.
- **Timeline** is the primary browse UI: day view with screen thumbnails and audio waveform,
  filterable by app, source, keyword, and person.
- Retention: per-source (default 30 days), with pinned items kept indefinitely.

## 5. Agent & API integration

Scoped tools (all policy-gated, consent-aware):

| Tool | Purpose |
| --- | --- |
| `ambient.search` | Hybrid search with time/app/person filters |
| `ambient.timeline` | Fetch a window of activity |
| `ambient.transcript` | Transcript for a time range/meeting |
| `ambient.screenshot` | Retrieve a frame at/around a time |
| `ambient.summarize` | Agent-generated summary over a range |

- Ambient data is **untrusted input** (injection defense, `docs/12`) and can never directly
  trigger a consequential action.
- Agents may also expose ambient memory over **MCP** with explicit, scoped consent
  (`docs/22`), so external tools can query it.
- Capture is a **source** in the memory system (`docs/09` §5): retrieval can blend ambient
  memory, documents, and conversations.

## 6. Normalized capture record

```jsonc
{
  "id": "…", "deviceId": "…", "ts": "2026-10-16T19:49:00.123Z", "durationMs": 2000,
  "source": "screen" | "mic" | "system-audio",
  "app": { "id": "com.example.editor", "name": "Editor" },
  "window": { "title": "…", "url": "…" },
  "monitor": 1,
  "text": "OCR or transcript text",
  "segments": [{ "startMs": 0, "endMs": 900, "text": "…", "speaker": "…" }],
  "blobRef": "ambient/…", "encrypted": true,
  "redactions": ["…blocks that were masked…"]
}
```

## 7. Privacy & security requirements

- Off by default; per-source toggles (screen, mic, system audio) are independent.
- Default exclusion list covers password managers, banking, health, and incognito/private
  windows; users can extend it.
- On-device redaction pass for known sensitive patterns before indexing.
- Global **pause** hotkey and a tray/menu indicator showing capture state.
- "Forget last N minutes" and per-item delete; hard-delete on schedule with a recovery window.
- No capture content is sent to any cloud unless the user enables cloud OCR/STT for that
  source; the Hub logs every such send.
- Managed policy can disable capture, restrict sources, and force local-only processing.

## 8. Performance & platform notes

- A resource governor caps CPU/GPU/battery impact; capture can pause on battery below a
  threshold or during full-screen video/games (configurable).
- Linux/Wayland and macOS require screen-recording permission; system-audio loopback needs
  platform-specific setup (documented per OS).
- Capture is best-effort: dropped frames are acceptable; gaps are recorded and shown.

## 9. Reconciliation checklist (when the findings document arrives)

- [ ] Capture mechanics (frame rate, dedupe, keyframe heuristics) and defaults.
- [ ] OCR/STT backends and quality/latency trade-offs per OS.
- [ ] Storage schema, retention, and index strategy.
- [ ] Resource footprint and battery impact.
- [ ] MCP/API surface it exposes, and naming.
- [ ] Privacy controls it offers (exclusions, redaction, pause).
- [ ] Any capabilities not covered above (e.g., UI observer, accessibility-tree capture,
      app-specific extractors, meeting detection).

## 10. Non-goals

- No covert surveillance: capture is always visible to the device owner.
- No cross-user capture; captures are scoped to the account that owns the device.
- No training on capture content.
