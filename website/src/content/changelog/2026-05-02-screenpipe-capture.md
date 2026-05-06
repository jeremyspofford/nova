---
title: "Personal context capture — screenpipe-bridge service + Capture dashboard"
date: 2026-05-02
---

Nova can now ingest your screen activity (with consent and a privacy denylist) so it has actual context for what you're working on. New `screenpipe-bridge` service plus a dedicated Capture top-level page in the dashboard.

- **`screenpipe-bridge` service** (port 8140). Subscribes to a user-installed [screenpipe](https://screenpi.pe/) daemon over WebSocket, with HTTP polling fallback after 5 WS failures. Aggregates raw events into focus sessions capped at 30 minutes, applies a two-layer privacy denylist (apps + URL patterns + window titles), and pushes payloads into the engram ingestion queue.
- **Capture top-level nav.** New "Capture" route in the dashboard sidebar with three sub-pages: Connection (live status of screenpipe daemon, connection test, today's stats, recent activity feed), Meetings (placeholder for upcoming meeting-summary work), and Journals (placeholder for upcoming work-journal work). Capture is intentionally first-class — the Personal Context Layer is multi-sub-project work; the screen-activity capture is sub-project 1 of 4.
- **Privacy denylist editor.** Manage app names, URL regex patterns, and window-title substrings to exclude from capture. Settings live in Redis (`nova:config:capture.denylist.*`) and apply at the bridge level — denylisted activity never enters the ingestion pipeline.
- **Pause without disconnect.** A single toggle in advanced settings sets `capture.paused=true`; the bridge stays connected to screenpipe, sessions still arrive, but they're discarded with a `paused` counter. Resume by flipping the toggle.
- **Bounded backpressure.** Pipeline drops events past `capture.buffer_size` (default 10) with a `dropped` counter exposed via `/health/ready` so operators can see when the pipeline is saturated.
- **Trust-aware engrams.** Screenpipe-derived engrams land at trust score 0.80 (above intel feeds and knowledge crawls, below chat). Source provenance traces every engram back to a session.

Optional service — only starts if the user installs and points to a screenpipe daemon (`nova:config:screenpipe.url` + `screenpipe.api_key`). Per-OS install + Nova config guide at `docs/capture/`.
