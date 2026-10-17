# External findings: screenpipe (ambient screen and audio memory)

Input for the Phase 0 reconciliation of `docs/24-ambient-memory.md` (its §9 checklist asks for
exactly this document). These are **findings, not decisions**. This file names the target and
the third-party apps it special-cases because they are the evidence. Requirements derived from
it must be rewritten in vendor-neutral language (`docs/01` §5, the brand-name invariant).

## Provenance

| | |
| --- | --- |
| Target | screenpipe (screenpi.pe), public repository `github.com/mediar-ai/screenpipe` |
| Version | commit `5ce7edfc` (2026-10-16, "Gate captured data on PII completion receipts") |
| Method | Static reading of the public source tree. Six read-only readers (screen capture, text extraction and privacy, PII and resources, audio, storage/search/API, agent surface). **Nothing was built or run.** Key claims were spot-checked against the source by a second reader. |
| Evidence refs | Paths relative to the repository root at that commit, `file:line`. |
| Date | 2026-10-16 |

### License: clean-room only

- The current license is the **Screenpipe Commercial License**: source-available, free for
  personal and non-commercial use, paid for commercial use (`LICENSE.md`).
- It changed from MIT on **2026-06-10** (commit `81e412ff53`). That commit states "Prior MIT
  releases remain MIT". The last MIT commit is its parent, **`892199f742`**. `ee/` has been
  proprietary since 2026-03-05.
- Under `AGENTS.md` §2 ("no proprietary copying") and §11 (permissive dependencies only), **no
  code or assets may be taken from it**. Everything below describes mechanisms in our own words.

### Confidence

- **high**: read directly in code and cross-checked.
- **medium**: the number or behaviour is the target's own claim, from a comment or doc, and
  was not reproduced.
- **low**: the target's own docs disagree, or it comes from a single indirect signal.

The target's docs are marked "Historical" and drift from its code. **Where they disagree, the
code was used.**

## Capability summary

| # | Capability | Evidence records | `docs/24` coverage |
| --- | --- | --- | --- |
| 1 | Event-driven screen capture (UI events, not a fixed rate) | ER-SP-001..004 | §3 says "1 frame / 2 s"; **diverges** |
| 2 | Accessibility-tree text first, OCR only when the tree is thin | ER-SP-005..007 | §3 is OCR-only; **not covered** |
| 3 | Per-OS frame grabbing and OCR engines | ER-SP-008..009 | §3 partially |
| 4 | Three-layer dedup (trigger / store / OCR) | ER-SP-010 | §3 "keyframe dedupe" |
| 5 | Pixel storage: JPEG per capture, later packed into video | ER-SP-011 | §4 "blobs" |
| 6 | Privacy filters: patterns, incognito, password fields, built-in exclusions, DRM, lock | ER-SP-012..015 | §7 partially |
| 7 | PII release gate: reads can only see certified-redacted rows | ER-SP-016..017 | §7 "redaction pass"; **much stronger** |
| 8 | Audio: device capture, chunking, VAD, STT, hallucination and echo defences | ER-SP-018..022 | §3 partially |
| 9 | Speaker identity across sessions | ER-SP-023 | §3 "speaker labels" |
| 10 | Meeting detection by which process holds the mic | ER-SP-024 | **not covered** |
| 11 | Storage: single SQLite file, FTS5 external content, write queue | ER-SP-025..026 | §4 |
| 12 | Search: filters, time-ordered results, **no embeddings** | ER-SP-027..028 | §4 has a vector index; **diverges** |
| 13 | Activity summary computed in SQL | ER-SP-029 | **not covered** |
| 14 | HTTP API and read-only SQL | ER-SP-030 | §5 |
| 15 | MCP tool surface and the broad-to-narrow guide | ER-SP-031..032 | §5 |
| 16 | Scheduled/evented prompts ("pipes") with server-enforced data scopes | ER-SP-033..034 | **not covered** (overlaps `docs/09`) |
| 17 | Retention, compaction, disk guard | ER-SP-035 | §4, §7 |
| 18 | Resource governor and power profiles | ER-SP-036..037 | §8 |
| 19 | Encryption at rest and sync | ER-SP-038 | §2, §7 |
| 20 | Browser extension (control bridge, not capture) | ER-SP-039 | not covered; candidate reject |
| 21 | Evaluation harnesses | ER-SP-040 | not covered (`docs/16`) |

---

## A. Capture mechanics (`docs/24` §9: "frame rate, dedupe, keyframe heuristics")

```yaml
id: ER-SP-001
area: capture / triggers
claim: >
  Screen capture is event-driven, not fixed-rate. A capture fires on app_switch, window_focus,
  click, typing_pause, scroll_stop, key_press, clipboard, visual_change, idle, manual. Input
  events come from CGEventTap (macOS), SetWindowsHookEx (Windows), evdev (Linux; user must be
  in the `input` group). The old fixed-FPS loop still exists but the engine no longer calls it.
evidence:
  - type: source
    ref: crates/screenpipe-engine/src/event_driven_capture.rs:342-371, 522-537
  - type: source
    ref: crates/screenpipe-engine/src/ui_recorder.rs:1250-1298
  - type: source
    ref: crates/screenpipe-a11y/src/lib.rs:20-21
  - type: source
    ref: crates/screenpipe-screen/src/core.rs:156-330 (legacy loop, unused)
confidence: high
limits: Static reading only; real-world capture rate per hour not measured.
```

```yaml
id: ER-SP-002
area: capture / timing defaults
claim: >
  Defaults on AC power are as follows.
  - Minimum gap between captures: 200 ms.
  - Idle heartbeat: 30 s, tightened to 5 s during a meeting.
  - Visual-change probe: every 3 s at threshold 0.05, only when no other trigger fired and the
    keyboard has been idle at least 2x the probe interval.
  - Typing, key and clipboard triggers: 1.5 s floor. Early triggers are merged, not dropped;
    this fixed a capture storm.
  - App switch, focus, scroll stop, idle and manual bypass the debounce.
  - Settle after an app switch: 750 ms, because new pixels arrive after the focus change.
  - The main loop polls every 250 ms instead of awaiting a broadcast receiver; awaiting it
    froze the loop for minutes in production.
evidence:
  - type: source
    ref: crates/screenpipe-engine/src/event_driven_capture.rs:56, 498-520, 591-633, 1726-1737, 1982-2014, 2977-2986
confidence: high
limits: Values are the target's tuning for its hardware mix; re-measure before adopting.
```

```yaml
id: ER-SP-003
area: capture / multi-monitor
claim: >
  - One capture loop runs per monitor. All loops share one broadcast channel with 4,096 slots;
    smaller buffers lagged and broke the link between UI events and frames.
  - Triggers that carry a screen point fire only on the monitor containing it.
  - Focus states:
    - Active: the focused monitor; full capture.
    - Warm: 2 s after losing focus; a visual probe every 5 s.
    - Cold: after 60 s; the OS stream is released.
  - Only the focused monitor gets the accessibility walk and app/window identity. The others
    get OCR with empty metadata.
  - Idle captures are staggered across monitors.
evidence:
  - type: source
    ref: crates/screenpipe-engine/src/event_driven_capture.rs:752-759, 873-909, 1464-1573, 3308-3355
  - type: source
    ref: crates/screenpipe-engine/src/focus_aware_controller.rs:52-62
  - type: source
    ref: crates/screenpipe-capture/src/paired_capture.rs:178-184, 285-311
confidence: high
limits: Linux focus tracking always reports "Unknown", so every Linux monitor stays Active.
```

```yaml
id: ER-SP-004
area: capture / robustness
claim: >
  - Every OS capture call is bounded. A "no frame" result is treated as a failure.
  - A stream whose delivery counter stays flat for 4 s is rebuilt (30 s cooldown).
  - The whole capture times out at 20 s on macOS and 15 s elsewhere.
  - Pausing (lock, power, DRM, schedule) releases the OS stream; held streams kept the
    compositor producing frames nobody read.
  - Wake, unlock and display changes tear streams down off-thread with a 5 s bound; doing it
    inside the OS callback deadlocked.
  - Frames that are more than 95% black are dropped (excluded window or DRM), as are frames
    with a green decode-garbage band.
  - On Windows, a frame is rejected if the foreground window changed during the capture.
  - After 3 or more errors, backoff is n/3 seconds, capped at 30 s.
evidence:
  - type: source
    ref: crates/screenpipe-screen/src/lib.rs:15-26
  - type: source
    ref: crates/screenpipe-engine/src/event_driven_capture.rs:44-51, 1290-1395, 2295-2345, 2841-2926, 3483-3504, 3979-4143
  - type: source
    ref: crates/screenpipe-engine/src/sleep_monitor.rs:5-14, 424-470
confidence: high
limits: none beyond static reading.
```

## B. Text extraction and OCR/STT backends (`docs/24` §9: "OCR/STT backends … per OS")

```yaml
id: ER-SP-005
area: text / accessibility-first
claim: >
  Text comes from the OS accessibility tree first. OCR is the fallback. Each frame is labelled
  `accessibility`, `ocr` or `hybrid`; a hybrid joins tree chrome text and OCR content into one
  searchable `full_text`.
  OCR runs when any of these holds:
  - The app is a terminal whose tree is a raw buffer (wezterm, alacritty, kitty, hyper, warp).
  - The tree is empty.
  - The tree is "thin":
    - total text under 100 characters;
    - under 30% of the characters come from content roles rather than buttons/menus;
    - a canvas app is matched by window title or URL (online docs/sheets/slides editors,
      design and whiteboard tools).
  - A meeting app is active during a detected meeting.
evidence:
  - type: source
    ref: crates/screenpipe-capture/src/paired_capture.rs:344-383, 633-696, 880-952, 1034-1117 (thresholds at :1099, :1108)
  - type: source
    ref: crates/screenpipe-db/src/db/frames.rs:719-737
confidence: high
limits: The target's own spec doc (docs/EVENT_DRIVEN_CAPTURE_SPEC.md) is stale on timeouts and hybrid mode.
```

```yaml
id: ER-SP-006
area: text / tree-walk bounds
claim: >
  - Tree walks are capped at depth 35, 5,000 nodes, a 250 ms walk timeout, a 200 ms
    per-element timeout and 50,000 characters.
  - A per-app adaptive budget uses the average of the last 8 walks:
    - under 50 ms: walk every 200 ms;
    - 50-150 ms: every 2 s, 2,000 nodes;
    - 150-250 ms: every 5 s, 1,000 nodes;
    - over 250 ms: every 60 s, 500 nodes.
    - Three truncations within 8 walks force the slowest tier.
  - When throttled, Windows still saves the pixels and defers extraction.
  - Per OS:
    - Windows uses UI Automation with cached requests on one dedicated thread, because UIA
      objects belong to the thread that created them. At most 2 hung walker threads may pile up.
    - macOS uses AXUIElement with batched attribute reads (about 3x faster).
    - Linux uses AT-SPI2 over D-Bus, which needs toolkit-accessibility turned on.
evidence:
  - type: source
    ref: crates/screenpipe-a11y/src/tree/mod.rs:562-595
  - type: source
    ref: crates/screenpipe-a11y/src/budget.rs:53-184
  - type: source
    ref: crates/screenpipe-capture/src/tree_walker_worker.rs:5-25
  - type: source
    ref: crates/screenpipe-a11y/src/tree/macos.rs:1600-1621; tree/linux.rs:5-16
confidence: high
limits: none beyond static reading.
```

```yaml
id: ER-SP-007
area: text / per-frame metadata
claim: >
  Each frame stores:
  - timestamp, monitor, app name, window title, browser URL, document path (file:// documents
    in non-browser apps), focused flag, capture trigger;
  - text and text source, the serialized tree, a content hash and a simhash;
  - OCR word boxes as JSON (normalized 0-1, top-left origin), and the optional snapshot path.
  Notes:
  - Browser URLs come from the accessibility tree, not an extension. On macOS, descending to
    the web area's URL takes about 2 ms; the AppleScript it replaced took 150-200 ms.
  - On an app-switch trigger, the previous window's title and URL are dropped, so no frame
    pairs metadata that didn't co-exist.
  - An `elements` table holds one row per tree or OCR node (role, text, bounds, confidence,
    on_screen).
evidence:
  - type: source
    ref: crates/screenpipe-db/src/write_queue.rs:1764-1769
  - type: source
    ref: crates/screenpipe-a11y/src/tree/mod.rs:78-170, 395; tree/macos.rs:252-333
  - type: source
    ref: crates/screenpipe-engine/src/event_driven_capture.rs:2689-2731
  - type: source
    ref: crates/screenpipe-db/src/migrations/20260301000000*.sql:2-34
confidence: high
limits: Windows OCR hard-codes confidence "1.0" (crates/screenpipe-screen/src/microsoft.rs:178), so OCR confidence is not comparable across OSes.
```

```yaml
id: ER-SP-008
area: capture / per-OS frame grabbing
claim: >
  Windows:
  - Windows.Graphics.Capture through a D3D11 frame pool, one persistent session per monitor.
  - Pixels are copied on the GPU only when a frame is requested. The earlier library converted
    every compositor frame on the CPU and wasted about 0.5 core.
  - Border and cursor capture are off.
  - Read timeouts are 200 ms, or 500 ms for the first frame.
  - Falls back to per-frame capture after 3 failed session inits.
  - Remote Desktop sessions use one-shot captures.
  macOS:
  - ScreenCaptureKit, one stream per display at about 2 fps. Ignored windows are excluded by
    the OS itself.
  - The CoreGraphics fallback cannot exclude windows, so it is used only when no exclusions
    are set.
  Linux:
  - X11: xcap.
  - wlroots Wayland: `grim` per frame.
  - GNOME/KDE Wayland: xdg-desktop-portal ScreenCast plus PipeWire, with a persisted restore
    token.
evidence:
  - type: source
    ref: crates/screenpipe-screen/src/wgc_capture.rs:5-31, 69-77, 514-530
  - type: source
    ref: crates/screenpipe-screen/src/monitor/windows.rs:98-204, 291-330
  - type: source
    ref: crates/screenpipe-screen/src/monitor/macos.rs:15-35, 111-119, 249-253, 389-461
  - type: source
    ref: crates/screenpipe-screen/src/monitor/linux.rs:53-104; linux_wayland.rs:42-170; linux_portal.rs:49-50, 498-545
confidence: high
limits: No HDR or DPI handling found; monitor geometry is in points.
```

```yaml
id: ER-SP-009
area: ocr / engines
claim: >
  OCR engines are fixed per OS:
  - macOS: Apple Vision on grayscale images, language correction off, 13 languages plus
    zh-Hant, one box per word.
  - Windows: Windows.Media.Ocr, using the requested languages, then the user-profile
    languages, then any installed recognizer. Jobs run one at a time on a dedicated COM thread.
  - Linux: Tesseract, LSTM engine, PSM 1, 600 DPI. Availability is checked once at startup,
    because a missing binary panicked on every frame.
  Cost control:
  - OCR runs only on a crop of the focused window, narrowed to detected text regions plus
    20 px. Region detection is about 10-20 ms.
  - The crop's pixels are hashed; unchanged text reuses the cached result. A hash is recorded
    only after the DB write succeeds, so a failed OCR retries.
  - Terminals and note apps are OCR'd at most once per 30 s per app. The target's comment says
    note-app OCR had cost about 150% CPU.
  - Cloud and custom-HTTP OCR exist only on the legacy, unused path.
evidence:
  - type: source
    ref: crates/screenpipe-capture/src/paired_capture.rs:537-613, 726-786
  - type: source
    ref: crates/screenpipe-capture/src/ocr_gate.rs:5-41
  - type: source
    ref: crates/screenpipe-screen/src/apple.rs:22-49, 123, 179-181; microsoft.rs:195-364; tesseract.rs:117-129, 172-176
  - type: source
    ref: crates/screenpipe-engine/src/event_driven_capture.rs:2760-2817
confidence: high (mechanism); medium (CPU figures)
limits: CPU savings are the target's own comments, not reproduced.
```

```yaml
id: ER-SP-010
area: capture / dedup
claim: >
  Dedup makes three separate decisions.
  1. Whether to capture:
     - Downscale by 4 and hash. If the hash is unchanged, nothing changed.
     - Otherwise compute the Hellinger distance on a grayscale histogram.
     - SSIM was dropped (40-50% cheaper). The hash early exit saves 30-50% in static scenes.
     - A downscale factor of 6 was abandoned because it hid scrolling through dense text.
  2. Whether to store:
     - Skip the frame if the accessibility-text hash equals the previous one.
     - Exempt: app switch, focus, scroll stop, idle and manual triggers.
     - A write is forced every 30 s.
     - The hash resets on an app or window switch.
  3. Whether to OCR: the region-hash gate in ER-SP-009.
evidence:
  - type: source
    ref: crates/screenpipe-screen/src/frame_comparison.rs:13-20, 103-107, 164-292
  - type: source
    ref: crates/screenpipe-engine/src/event_driven_capture.rs:1971-1980, 2928-2971, 3543-3569
confidence: high (mechanism); medium (savings figures)
limits: Savings measured by the target on a 3-monitor bench; not reproduced.
```

```yaml
id: ER-SP-011
area: storage / pixels
claim: >
  - One JPEG is written per capture. Quality and width cap follow a user setting: 60/1280,
    80/1920, 85/3840, or 92/native. Power profiles can only lower quality.
  - Snapshots older than 10 minutes are packed every 5 minutes into fragmented MP4 chunks of
    25-100 frames:
    - hardware HEVC where available, otherwise x264 veryfast, CRF 23, GOP 25;
    - GOP 25 made timeline scrubbing 6x cheaper for 2.6% more bytes;
    - runs only on AC power with the screen unlocked.
  - JPEGs are deleted only after the MP4 exists and the DB commit succeeds.
  - Alternatives: a text-only mode stores no pixels; macOS has an HD mode (constant 10 fps
    H.264).
evidence:
  - type: source
    ref: crates/screenpipe-screen/src/snapshot_writer.rs:53-93
  - type: source
    ref: crates/screenpipe-core/src/video.rs:32-39, 82-105
  - type: source
    ref: crates/screenpipe-engine/src/snapshot_compaction.rs:5-66, 218-258, 700-770, 815-891; compaction_encoder.rs:5-24
confidence: high (mechanism); low (bytes per frame: the spec says ~80 KB, the compactor comment says ~400 KB)
limits: none beyond static reading.
```

## C. Privacy controls (`docs/24` §9: "exclusions, redaction, pause")

```yaml
id: ER-SP-012
area: privacy / ignore and include patterns
claim: >
  Pattern syntax (case-insensitive substring):
  - `X` matches the app name or the window title.
  - `App::title` requires both to match.
  - `::title` matches the title in any app.
  - An include rule scoped to one app whitelists that app without blocking the others.
  Where filters are applied: early (app only), again after the title is read, as a safety net
  when the tree walk finds nothing, and as a final gate after metadata is resolved.
  URL rules:
  - Match on domain boundaries ("chase" does not match "purchase.com").
  - Structured rules are strict hostnames.
  - An allowlist rejects browser frames that have no URL, and blacks out pixels outside the
    focused window.
  - A malformed rule fails closed.
evidence:
  - type: source
    ref: crates/screenpipe-core/src/window_pattern.rs:5-27, 81-165
  - type: source
    ref: crates/screenpipe-a11y/src/url_filter.rs:94-330
  - type: source
    ref: crates/screenpipe-config/src/recording.rs:244-260
  - type: source
    ref: crates/screenpipe-engine/src/event_driven_capture.rs:2741-2758, 3516-3541, 3629-3656, 3729-3749
confidence: high
limits: none beyond static reading.
```

```yaml
id: ER-SP-013
area: privacy / built-in exclusions
claim: >
  - Always skipped: password managers, the OS keychain app, the lock screen and login window,
    and the capture app itself. On Windows also LockApp and the snipping tool.
  - Password fields are never read: UIA IsPassword, AXSecureTextField, AT-SPI PasswordText.
  - Password dots in OCR text are removed by regex.
  - Incognito detection is on by default: localized title strings in 20+ languages, built to
    over-match. macOS also checks AX identifiers and has an opt-in enhanced mode that asks
    browsers through automation.
  - Lock-screen detection pauses capture.
  - Optional DRM pause for streaming apps and domains.
  - Optional work-hours schedule.
  - Pause per monitor through the API.
evidence:
  - type: source
    ref: crates/screenpipe-a11y/src/tree/macos.rs:22-44, 902-912, 1350-1366; tree/windows.rs:42-56, 1018-1039; tree/linux.rs:206-232, 849-866
  - type: source
    ref: crates/screenpipe-a11y/src/incognito/titles.rs:12-170; incognito/macos.rs:5-37
  - type: source
    ref: crates/screenpipe-core/src/pii_removal.rs:166-167
  - type: source
    ref: crates/screenpipe-engine/src/drm_detector.rs:14-345; schedule_monitor.rs:5-8; routes/vision.rs:5-8
confidence: high
limits: See ER-SP-014 for gaps found.
```

```yaml
id: ER-SP-014
area: privacy / gaps found in the target
claim: >
  1. On Linux, a focused excluded app can come back as "not found" rather than "excluded", and
     that path only checks user patterns and incognito. A focused password manager may
     therefore fall through to OCR.
  2. `skip_secure_input` defaults to true but nothing reads it.
  3. The macOS password skip checks the role only, not the subrole.
  4. Pixel-level window exclusion exists on macOS only. Windows and Linux cannot exclude a
     window from the grabbed pixels.
evidence:
  - type: source
    ref: crates/screenpipe-a11y/src/tree/linux.rs:1155-1158, 1273-1275; crates/screenpipe-engine/src/event_driven_capture.rs:2741-2758, 3522-3541
  - type: source
    ref: crates/screenpipe-a11y/src/config.rs:92-93, 232
  - type: source
    ref: crates/screenpipe-screen/src/capture_screenshot_by_window.rs:1090-1094
confidence: medium (the code paths read as described; not exercised)
limits: Inferred from static reading; would need a runtime test to confirm.
```

```yaml
id: ER-SP-015
area: privacy / fail-closed exclusion
claim: >
  On macOS, if the window-exclusion state cannot be refreshed within 60 s, the frame's pixels
  are skipped rather than captured unfiltered.
evidence:
  - type: source
    ref: crates/screenpipe-engine/src/capture_exclusions.rs:5-39; event_driven_capture.rs:3088-3123
confidence: high
limits: macOS only.
```

```yaml
id: ER-SP-016
area: privacy / PII release gate
claim: >
  Every captured row starts uncertified.
  Revocation (SQLite triggers):
  - Triggers on insert, update and delete revoke a row's "receipt" and enqueue redaction work.
  - Changing the redaction policy invalidates every receipt.
  Certification:
  - A worker redacts the row and certifies it in the same IMMEDIATE transaction as the
    sanitized write.
  - A concurrent edit makes certification fail, and the row is retried.
  Reads:
  - The API reads through per-connection TEMP VIEWs that hide uncertified rows from every
    caller. The read pool is query_only.
  - Screenshot paths read as NULL until the image is certified.
  - Raw-SQL, export and streaming routes return 503 while protection is on.
  - A middleware samples a revocation counter before and after each handler and turns a
    mid-request change into 503.
  Failure:
  - Regex alone can never certify; a model is required.
  - If models fail to load, nothing is certified and protected data stays hidden.
  Cost: broad search p95 rose from 0.32 s to 1.7 s at 1M frames. Storing receipts as integer
  generations instead of the full identity string kept the DB at 668 MB instead of 2.95 GB.
  Not covered (the target's own doc says so): native consumers reading the raw DB file, direct
  file access, and other sync services.
evidence:
  - type: source
    ref: crates/screenpipe-db/src/db/privacy_release.rs:44-338, 608-708, 742-860, 914-968
  - type: source
    ref: crates/screenpipe-engine/src/routes/privacy_release.rs:18-63; server.rs:613-617, 1565
  - type: source
    ref: crates/screenpipe-redact/src/lib.rs:217-230; worker/release.rs:133-245
  - type: doc
    ref: docs/pii-release-gate.md:44, 82-83; docs/benchmarks/pii-release-gate/MERGE-READINESS.md:9-35
confidence: high (mechanism); medium (latency and size figures)
limits: Their legacy (non-release) mode fails OPEN; only the release policy fails closed.
```

```yaml
id: ER-SP-017
area: privacy / redaction models
claim: >
  - Regex categories: emails, phones, JWTs, API-key prefixes, PEM blocks, credentialed URLs,
    SSNs, Luhn-checked cards, IPv4, checksum-validated national IDs.
  - Text model: a 6-layer distilled xlm-roberta (about 116 MB) on ONNX Runtime, CPU or
    DirectML.
    - Input is 256-token windows with overlap, so long text is never truncated.
    - One intra-op thread with spinning off; a spinning pool once burned about 4 cores.
  - Fallback text model: `openai/privacy-filter` (Apache-2.0, 1.4B parameters per its model
    card), unloaded after 60 s idle.
  - Image model: RF-DETR-Nano.
    - Detected regions plus forced regions from the accessibility tree (password fields) are
      painted as solid black boxes, never blurred ("blur is reversible").
    - The image file is overwritten in place via tempfile, fsync and rename.
    - Images are processed once they are 60 s old.
  - The default policy redacts secrets only.
evidence:
  - type: source
    ref: crates/screenpipe-redact/src/adapters/regex.rs:5-19; adapters/onnx.rs:5-131, 427-435, 1025-1053; adapters/opf.rs:8-52
  - type: source
    ref: crates/screenpipe-redact/src/adapters/rfdetr.rs:23-147; image/frame_redactor.rs:7-124; image/worker.rs:56-58, 360-375
  - type: source
    ref: crates/screenpipe-redact/src/span.rs:300-358; crates/screenpipe-config/src/recording.rs:1089-1091
  - type: external
    ref: huggingface.co/openai/privacy-filter (license apache-2.0, 1399.5M parameters, checked 2026-10-16)
confidence: high
limits: >
  The target's own text model is its own artifact; check its license before reuse. Other
  Apache-2.0 PII models found on the Hub on 2026-10-16:
  fastino/gliner2-privacy-filter-PII-multi (307M) and gravitee-io/bert-small-pii-detection
  (28.5M, ONNX, English). iiiorg/piiranha is CC-BY-NC-ND (not usable).
```

## D. Audio (`docs/24` §9: "STT backends", "any capabilities not covered")

```yaml
id: ER-SP-018
area: audio / device capture
claim: >
  Every source is converted to mono f32 on a broadcast channel. Per OS:
  - Windows: WASAPI loopback for outputs, also the communications endpoint that call apps use,
    plus per-process loopback for meeting taps (needs Windows build 20348+).
  - macOS: ScreenCaptureKit system audio as one stable virtual device. An opt-in CoreAudio
    process tap (14.4+) uses a tap-only aggregate device; including the speaker broke call
    apps' startup.
  - Linux: PulseAudio `<sink>.monitor`, with an ALSA fallback.
  Lifecycle:
  - A hot-plug monitor ticks every 2 s.
  - A stream is rebuilt after 8 s with no data, or 30 s of all-zero buffers (catches a headset
    hijacked by another app).
  Bluetooth:
  - Bluetooth combo-headset mics are opened only during meetings. Opening one forces the
    headset into the call profile and degrades playback.
  - Whether a device is Bluetooth comes from OS transport data, not the device name.
evidence:
  - type: source
    ref: crates/screenpipe-audio/src/core/stream.rs:158, 181-555, 776-866
  - type: source
    ref: crates/screenpipe-audio/src/core/device.rs:18-24, 152-340, 470-611, 917-998, 1140-1162
  - type: source
    ref: crates/screenpipe-audio/src/core/process_tap/macos.rs:30-125, 797-945; process_tap/windows.rs:5-79; core/pulse.rs:5-8, 360-428
  - type: source
    ref: crates/screenpipe-audio/src/core/run_record_and_transcribe.rs:28-134; core/device_detection.rs:181-212
confidence: high
limits: none beyond static reading.
```

```yaml
id: ER-SP-019
area: audio / chunking and persistence
claim: >
  - Chunks are 30 s; the last 2 s carry into the next chunk.
  - Every chunk is encoded (AAC-LC 64 kbps at 16 kHz) and gets a DB row before any
    transcription, so nothing is lost if speech-to-text fails. A failed insert is retried 3
    times, then an orphan marker is left for a sweep.
  - Default mode is batch: during a meeting, chunks are deferred and transcribed together
    afterwards. The target's reason: Whisper on Metal used 27-29% CPU and fought call apps for
    the GPU.
  - A background sweep looks back 7 days, waits 10 minutes before touching fresh chunks, and
    handles 50 per pass.
  - Bluetooth packet gaps are filled with digital silence, up to 500 ms per gap.
evidence:
  - type: source
    ref: crates/screenpipe-audio/src/core/run_record_and_transcribe.rs:181-217, 429-441, 828-877
  - type: source
    ref: crates/screenpipe-audio/src/utils/ffmpeg.rs:60-85, 177; audio_manager/manager.rs:1570-1824
  - type: source
    ref: crates/screenpipe-audio/src/audio_manager/reconciliation.rs:31-40, 125-159, 236-240; core/source_buffer.rs:5-53
  - type: doc
    ref: docs/BATCH_TRANSCRIPTION_SPEC.md:11-17 (marked outdated)
confidence: high (mechanism); medium (CPU figure)
limits: No audio-specific local retention policy was found.
```

```yaml
id: ER-SP-020
area: audio / VAD
claim: >
  - Engine: Silero VAD v5 (ONNX), falling back to WebRTC VAD if ONNX Runtime init hangs.
  - Frames are 512 samples at 16 kHz.
  - Speech threshold is 0.5, lowered to 0.3 on Windows (quieter capture) and 0.15 for system
    audio. A frame counts as speech when 3 of the last 10 frames exceed the threshold.
  - A chunk is transcribed only when its speech ratio (the larger of the whole-chunk fraction
    and the densest 5 s window) exceeds 0.02. Power profiles raise that to 0.05, 0.10, or 1.0
    (audio effectively off).
evidence:
  - type: source
    ref: crates/screenpipe-audio/src/vad/mod.rs:16-21, 49-76; vad/silero.rs:64-69, 137-199; vad/webrtc.rs:15-34
  - type: source
    ref: crates/screenpipe-audio/src/speaker/prepare_segments.rs:43-125
confidence: high
limits: The 0.02 ratio is described as benchmark-derived; not reproduced.
```

```yaml
id: ER-SP-021
area: audio / STT
claim: >
  Engines:
  - Default: whisper.cpp large-v3-turbo, GPU first then CPU. Greedy decoding, no_speech 0.6,
    entropy 2.4, logprob -2.0.
  - Language detection is restricted to the user's configured set.
  - Vocabulary goes in as an initial prompt of up to 800 characters, plus text replacements
    after transcription.
  - Alternatives: Parakeet TDT 0.6b (vocabulary boosting cut proper-name WER from 21% to 7%)
    and Qwen3-ASR 0.6b.
  - Cloud (Deepgram, or any OpenAI-compatible endpoint) is opt-in and falls back to local.
  - Whisper and Qwen are disabled on CPUs without AVX2 rather than crashing.
  Hallucination defences:
  - Whisper is skipped below RMS 0.015; it invents "Thank you." on silence.
  - Bluetooth gaps are silence-filled.
  - The 2 s overlap is trimmed only when the audio intervals truly overlap.
evidence:
  - type: source
    ref: crates/screenpipe-audio/src/transcription/whisper/model.rs:11-90; whisper/batch.rs:12-116; whisper/detect_language.rs:9-46
  - type: source
    ref: crates/screenpipe-audio/src/transcription/engine.rs:51-94, 371-570, 1108-1116; transcription/stt.rs:56-64, 163-199
  - type: source
    ref: crates/screenpipe-audio/src/transcription/transcription_result.rs:35-54; handle_new_transcript.rs:118-153
confidence: high (mechanism); medium (WER figures)
limits: none beyond static reading.
```

```yaml
id: ER-SP-022
area: audio / echo and cross-device dedup
claim: >
  - The mic runs echo cancellation by default (a port of WebRTC AEC3 plus noise suppression
    and AGC2), using the default output as the far-end reference.
  - A transcript is dropped as a duplicate when another device produced the same normalised
    words within ±45 s with overlapping intervals. If the check itself fails, the transcript
    is kept.
  - A write-up in the repo documents an earlier 205x duplication bug.
evidence:
  - type: source
    ref: crates/screenpipe-audio/src/core/aec.rs:13-260
  - type: source
    ref: crates/screenpipe-db/src/db/audio.rs:7-16, 474-576
  - type: doc
    ref: crates/screenpipe-audio/tests/dedup_benchmark/ANALYSIS.md:1-12
confidence: high
limits: none beyond static reading.
```

```yaml
id: ER-SP-023
area: audio / speaker identity
claim: >
  Segmentation and embedding:
  - pyannote segmentation-3.0 over 10 s windows.
  - CAM++ speaker embeddings (512 dimensions), stored with sqlite-vec.
  Live clustering:
  - Cosine similarity of at least 0.35 to a cluster, otherwise a new cluster; at most 1,024
    clusters.
  Identity across sessions:
  - A match needs cosine distance under 0.55 and a 0.08 margin over the runner-up; otherwise
    it abstains.
  - Speech duration gates: under 1 s, no identification; 1-2 s, match but don't learn; 2 s or
    more, may create or update a speaker.
  Calendar rules:
  - The lone unnamed mic speaker is the user.
  - In a 1:1, the lone output speaker is the other attendee.
  - Each rule needs at least 3 transcriptions.
evidence:
  - type: source
    ref: crates/screenpipe-audio/src/speaker/segment.rs:17-23, 113-381, 463-470; speaker/embedding_manager.rs:9-86; speaker/identify_gate.rs:28-79
  - type: source
    ref: crates/screenpipe-db/src/db/speakers.rs:25-53, 196-370
  - type: source
    ref: crates/screenpipe-engine/src/calendar_speaker_id.rs:5-41
confidence: high
limits: >
  The eval harness exists because a clustering threshold was once changed from 0.55 to 0.70
  without data (crates/screenpipe-audio-eval/evals/README.md:32-39).
```

```yaml
id: ER-SP-024
area: meetings / detection
claim: >
  How a meeting is detected (default on macOS and Windows):
  - Find the processes currently holding the mic, via CoreAudio's per-process "running input"
    flag or WASAPI capture-session enumeration.
  - Match them against app and exe names and meeting URLs.
  - A browser holding the mic counts only when it is on a meeting URL. Messaging apps also
    need call controls visible in the accessibility tree.
  Timing:
  - Polls every 1 s while active, 5 s while idle.
  - Ending grace is 20 s. A new session within 120 s of an end merges into it.
  Linux uses a UI-scan detector instead: 15 s to confirm, 30 s to end (300 s for browsers),
  2 consecutive scans to go from ending back to active.
evidence:
  - type: source
    ref: crates/screenpipe-audio/src/meeting_processes.rs:5-7, 181, 461-476
  - type: source
    ref: crates/screenpipe-engine/src/meeting_watcher/mod.rs:5-12, 102-112; shared/profiles.rs:11-278; audio_process/mod.rs:50-77; audio_process/state.rs:359-363; audio_process/lifecycle.rs:175; shared/state.rs:70-89
confidence: high
limits: >
  The meeting-eval harness replays a real 70-minute trace that originally produced 23 flaps
  (crates/screenpipe-meeting-eval/evals/README.md:168-184).
```

## E. Storage schema, retention and index (`docs/24` §9)

```yaml
id: ER-SP-025
area: storage / engine
claim: >
  - Everything lives in one SQLite file: WAL mode (DELETE on network volumes),
    synchronous=FULL, 5 s busy timeout.
  - A write-coalescing queue batches many writes per transaction. One writer per process,
    under a coordinator lock that latches writes off after corruption or a full disk and
    refuses SQLite older than 3.51.3.
  - 119 migrations.
  - An optional mode moves bulky per-frame data into immutable zstd Parquet files and keeps
    search postings in SQLite.
evidence:
  - type: source
    ref: crates/screenpipe-db/src/db/setup.rs:248-290; write_queue.rs:5-19
  - type: source
    ref: crates/screenpipe-sqlite-coordinator/src/lib.rs:34, 45-56, 201-205
  - type: source
    ref: crates/screenpipe-db/src/storage/mod.rs:55, 97-105
confidence: high
limits: none beyond static reading.
```

```yaml
id: ER-SP-026
area: storage / schema and FTS
claim: >
  Core tables:
  - frames (with one searchable `full_text`), elements, video_chunks, audio_chunks,
    audio_transcriptions;
  - speakers and speaker_embeddings; meetings and meeting_transcript_segments;
  - ui_events (clicks, keys, typed text, app switches, clipboard);
  - tags; memories; parsed app content (semantic_items); a metadata-only activity ledger.
  The separate ocr_text table was folded into frames and dropped (2026-06).
  Full-text search:
  - FTS5 with external content and the unicode61 tokenizer on frames, elements, audio, ui_events
    and memories, kept in sync by triggers using the 'delete' command.
  - External content cut a 951-frame retention delete from 38 s to 0.09 s and saved about
    175 MB on a 14-day database.
evidence:
  - type: source
    ref: crates/screenpipe-db/src/migrations/20260220000000_event_driven_capture.sql:9-58
  - type: source
    ref: crates/screenpipe-db/src/migrations/20260613130000_unify_ocr_text_into_frames.sql:5-91
  - type: source
    ref: crates/screenpipe-db/src/migrations/20260415000000*.sql:14-53; 20260301100000*.sql:34-41; 20250202000000*.sql:73-131; 20260310000000*.sql:2-24; 20260724000000*.sql:8-89; 20260817000000*.sql:9-90
confidence: high (schema); medium (delete timing and size figures)
limits: >
  ui_events stores typed text. That is a keystroke log; treat it as a deliberate scope
  decision, not a default to copy.
```

```yaml
id: ER-SP-027
area: search / query
claim: >
  `GET /search` parameters:
  - q, content_type (all / ocr / audio / input / accessibility / memory / parsed);
  - time range, app, window, URL, focused, on_screen, speaker, device, tags;
  - limit (default 20), offset, max_content_length (cuts the middle out of long text), format
    (json/csv/tsv).
  How it runs:
  - Each user word is quoted separately, giving an implicit AND with no operators.
  - Results are ordered by TIME, not relevance. BM25 only picks the top 5,000 candidates
    before the time sort.
  - `content_type=all` searches each type, merges, sorts by time, then paginates.
  - A separate keyword route returns highlight positions, splits compound words, and groups
    consecutive hits.
evidence:
  - type: source
    ref: crates/screenpipe-engine/src/routes/search.rs:80-238, 400-437, 1815-1924
  - type: source
    ref: crates/screenpipe-db/src/db/search.rs:566-686, 785-890, 1146, 1208 (ORDER BY timestamp at :649, :675, :864, :890)
  - type: source
    ref: crates/screenpipe-db/src/db/elements.rs:50-80; text_normalizer.rs:51-87
confidence: high
limits: none beyond static reading.
```

```yaml
id: ER-SP-028
area: search / no semantic index
claim: >
  - There is no embedding or vector search over captured text. The text-embedding table was
    dropped as "created for an embedding pipeline that was never implemented".
  - The only vectors in the system are speaker voiceprints.
  - The crate named "semantic" is rule-based accessibility-tree parsers for about 60 app
    profiles (conversations, messages, documents, tasks, calendar events, pages). It is
    experimental and off by default.
evidence:
  - type: source
    ref: crates/screenpipe-db/src/migrations/20260311000000*.sql:7-9
  - type: source
    ref: crates/screenpipe-semantic/src/lib.rs:5-9; parsers/catalog.rs:36
  - type: doc
    ref: docs/SEMANTIC_APP_PARSER_SPEC.md:5
confidence: high
limits: >
  Their silence is not evidence that semantic recall is unhelpful; it was never built.
  docs/24 §4's vector index is our addition and should be validated by measurement.
```

```yaml
id: ER-SP-029
area: search / activity summary
claim: >
  `/activity-summary` is the endpoint AI callers are told to start with. It is computed in
  SQL from the gaps between frames; gaps over 300 s don't count as active. It returns minutes
  per app and window, key text, audio segments, speakers, edited files, and recording status.
evidence:
  - type: source
    ref: crates/screenpipe-engine/src/routes/activity_summary.rs:39, 131-242, 719-805
confidence: high
limits: none beyond static reading.
```

```yaml
id: ER-SP-035
area: storage / retention, compaction, disk
claim: >
  Retention:
  - Off by default; 14 days when enabled (new desktop installs enable it).
  - Three modes: media (delete files, keep rows), lean (also strip trees and ui_events),
    all (delete rows too).
  - The job runs every 300 s in 1-hour batches.
  - The DB never shrinks on its own (auto-vacuum is off); an explicit compact route does it.
  Disk guard: capture stops below 5 GiB free and resumes above 10 GiB, checked every 30 s.
  Volume: the target's own docs disagree — about 300 MB per 8-hour day, 5-10 GB per month,
  and about 30 GB per month all appear.
evidence:
  - type: source
    ref: crates/screenpipe-engine/src/retention.rs:56-93, 317-330, 470, 659-675
  - type: source
    ref: crates/screenpipe-events/src/custom_events/disk_pressure.rs:8-15
  - type: doc
    ref: docs/EVENT_DRIVEN_CAPTURE_SPEC.md:100-102; docs/mintlify/docs-mintlify-mig-tmp/architecture.mdx:248; faq.mdx:726
confidence: high (mechanism); low (volume figures)
limits: Measure volume on our own hardware.
```

## F. API and agent surface (`docs/24` §9: "MCP/API surface it exposes, and naming")

```yaml
id: ER-SP-030
area: api / HTTP
claim: >
  - REST API on localhost:3030 with a Bearer key; CORS allows localhost only; OpenAPI is
    served at /openapi.json.
  - Main routes:
    - /search, /search/keyword, /elements;
    - /frames/:id (the JPEG, extracted from MP4 if packed) and /frames/:id/context;
    - /activity-summary;
    - a WebSocket timeline stream;
    - /health, returning last frame and audio timestamps and reasons for being unhealthy;
    - meetings, speakers, tags, memories, retention, data management, pipes.
  - `POST /raw_sql`:
    - SELECT, WITH or EXPLAIN only;
    - a LIMIT is required unless the query is a single aggregate, at most 10,000;
    - runs on the read pool;
    - a SQLite error returns 400 so an agent can fix its query.
evidence:
  - type: source
    ref: crates/screenpipe-engine/src/server.rs:327, 895-1525; auth_key.rs:20-27
  - type: source
    ref: crates/screenpipe-engine/src/routes/content.rs:633-737; routes/frames.rs:1409-1419; routes/health.rs:645-685; routes/streaming.rs:36-46
confidence: high
limits: The free tier sees only a rolling 24 h of history (history_access.rs:10); a commercial gate, not a design point.
```

```yaml
id: ER-SP-031
area: agent / MCP tools
claim: >
  The MCP server is a thin client over the REST API (stdio or HTTP). Its tools are listed
  below.
  Read tools:
  - search-content: q, content_type, time range, app, window, speaker, tags…; at most 20 hits,
    text cut to 1,000 characters.
  - keyword-search, activity-summary, search-elements, frame-context, get-frame-elements.
  - list-meetings, get-meeting.
  - search-speakers, list-unnamed-speakers.
  - health-check, list-audio-devices, list-monitors.
  - synced-devices, search-synced-content.
  - get-feedback.
  Write tools:
  - update-memory, add-tags, update-speaker, merge-speakers.
  - start-meeting, stop-meeting, update-meeting.
  - send-notification, export-video, control-recording.
  - list-pipes, create-pipe, run-pipe, pipe-logs.
  Team tools (enterprise only): team-search, team-devices, team-records, team-frame.
  Resources:
  - a context resource with the current time, timezone and precomputed time anchors;
  - a guide resource (described in ER-SP-032).
evidence:
  - type: source
    ref: packages/screenpipe-mcp/src/index.ts:327-1076, 1081-1260, 1394
confidence: high
limits: none beyond static reading.
```

```yaml
id: ER-SP-032
area: agent / guidance and failures
claim: >
  The guide teaches a broad-to-narrow ladder: activity-summary, then search-content, then
  search-elements, then frame-context. Its rules: always set start_time, never fabricate IDs,
  don't use q on audio.
  A second bundled MCP server for app-launched agents offers query_recordings (SQL through
  raw_sql). That tool's description hard-codes a schema that is now stale: it points the model
  at the ocr_text and ui_monitoring tables, both dropped by migrations. A schema list
  maintained by hand in a prompt drifted from the database.
  Captured content is framed as "untrusted evidence, never instructions" in a skill file, which
  is prompt-level only. The bundled agent asks the user before write and bridge tools.
evidence:
  - type: source
    ref: packages/screenpipe-mcp/src/index.ts:1081-1260
  - type: source
    ref: crates/screenpipe-core/assets/acp/screenpipe-tools.mjs:1-17, 411-439
  - type: source
    ref: crates/screenpipe-db/src/migrations/20260613130000*.sql:91; 20260301200000*.sql:14-16
  - type: source
    ref: crates/screenpipe-core/src/agents/acp/runtime.rs:3590-3621
confidence: high
limits: none beyond static reading.
```

```yaml
id: ER-SP-033
area: agent / pipes
claim: >
  What a pipe is:
  - One markdown file: a YAML header plus a prompt.
  - Scheduled ("every 30m", "every monday at 6pm", or cron, checked every 30 s) or triggered by
    an event (meeting_started, meeting_ended, pipe_completed, connection triggers). At most 4
    event-triggered runs at once.
  - Run by an external coding agent. The prompt is prefixed with the API base URL, a token, and
    a lookback window equal to the schedule interval, capped at 8 h.
  - About 22 bundled pipes, including day-recap, standup-update, time-breakdown, commitments
    and meeting-summary. Many keep a dated memory file of lessons from earlier runs.
  Data scope:
  - Each run gets a scoped token.
  - The server checks it against the pipe's permissions (apps, windows, content types, time):
    deny, then allow, then the default allowlist, else reject.
  - At most 3 concurrent DB queries per pipe, a 30 s timeout per query, and an immediate 503
    beyond that.
evidence:
  - type: source
    ref: crates/screenpipe-core/src/pipes/mod.rs:5-11, 795-806, 2893, 6214-6233, 7638, 8020-8077, 8406-8505
  - type: source
    ref: crates/screenpipe-engine/src/pipe_permissions_middleware.rs:5-15, 127-175
  - type: source
    ref: crates/screenpipe-core/assets/pipes/meeting-summary/pipe.md:2-11; assets/pipes/day-recap/pipe.md:11-20
confidence: high
limits: Free-text pipe triggers are parsed but never evaluated (pipes/mod.rs:248-250).
```

```yaml
id: ER-SP-034
area: agent / verified outputs
claim: >
  - Meeting summaries are verified, not trusted. After a summary run, a finalizer reads the
    run's own transcript to find the saved summary. If there is none, the meeting is marked
    `summary_not_saved` or `nothing_to_summarize`, never "ready".
  - The activity ledger is built from metadata only, with no LLM.
evidence:
  - type: source
    ref: crates/screenpipe-engine/src/meeting_summary/finalizer.rs:5-18; meeting_summary/extract.rs:5-12
  - type: source
    ref: crates/screenpipe-engine/src/activity_ledger.rs:5-10
confidence: high
limits: none beyond static reading.
```

## G. Resources, encryption, sync, and other surfaces

```yaml
id: ER-SP-036
area: resources / governor
claim: >
  - Background work (redaction, sealing) shares a single-permit CPU lane targeting 30% of one
    core. Capture never takes that lane.
  - Rest time after each batch is work × (active − target) / (target − idle), capped at 60 s.
    The permit is held during the rest so another subsystem cannot fill the gap.
  - Work slices start at 4 units with a ceiling of 16 and a 250 ms target. They shrink when a
    slice runs long and double after 3 fast slices.
  - The target's measurement: an indivisible 600 s model call followed by the 60 s maximum
    rest still averages about 91% of a core, so the 30% target is not a hard ceiling.
evidence:
  - type: source
    ref: crates/screenpipe-resource/src/cpu.rs:11-121, 181, 272-325; background_work.rs:4-26
  - type: doc
    ref: docs/benchmarks/pii-release-gate/RESULTS.md; MERGE-READINESS.md:35
confidence: high (mechanism); medium (figures)
limits: No battery or thermal measurements were found.
```

```yaml
id: ER-SP-037
area: resources / power profiles and tiers
claim: >
  Power profiles:
  | Profile | When | Effect |
  | --- | --- | --- |
  | Performance | on AC | full capture |
  | Balanced | battery above 40% | 500 ms gap, 60 s idle, JPEG quality 60 |
  | Saver | battery at or below 40%, or thermal serious | 1 s gap, 120 s idle |
  | AudioPaused | battery at or below 20% | audio and screenshots off; accessibility walk continues |
  | FullPause | battery at or below 10% | all capture stops |
  - OS low-power mode alone only forces at least Saver. Treating it as a stop signal killed
    capture on every unplug.
  Device tiers by RAM and cores set DB cache and channel sizes.
  - mmap is always off, so stray native writes cannot corrupt the DB.
  - 8 GB machines default to battery saver.
  Process priority:
  - On Windows the engine runs BELOW_NORMAL, not background mode, which would starve I/O.
  - The Whisper thread lowers its own priority per call.
evidence:
  - type: source
    ref: crates/screenpipe-engine/src/power/profile.rs:112-254; power/manager.rs:20-41, 153, 218; power/monitor.rs:7, 93-266
  - type: source
    ref: crates/screenpipe-config/src/defaults.rs:19-240, 283-348, 436-452
  - type: source
    ref: crates/screenpipe-engine/src/process_priority.rs:5-32
confidence: high
limits: Linux has no thermal or low-power detection.
```

```yaml
id: ER-SP-038
area: security / encryption at rest and sync
claim: >
  Encryption at rest (the vault):
  - ChaCha20-Poly1305 in 64 KB chunks, key derived with Argon2id (64 MiB, 3 iterations,
    parallelism 4).
  - Covers the DB and its WAL/SHM files, secrets, and all media.
  - CLI-only and disabled in the desktop app. If a file fails to encrypt, the error is only
    logged and the state still becomes Locked.
  Secrets: a separate store with per-value encryption under an OS-keychain key.
  Sync:
  - Uploading screen data has been removed (returns 410). Only pipes, connections and memories
    sync, last-write-wins with tombstones.
  - The app-managed sync password is sha256(account_id + constant), so it can be derived from
    the account id.
evidence:
  - type: source
    ref: crates/screenpipe-vault/src/crypto.rs:5-13, 241-257; manager.rs:17-23, 206-226
  - type: source
    ref: apps/screenpipe-app-tauri/src-tauri/src/main.rs:1912-1920
  - type: source
    ref: crates/screenpipe-secrets/src/keychain.rs:19-20
  - type: source
    ref: crates/screenpipe-core/src/sync/keys.rs:21-35
confidence: high
limits: docs/24 §2.5 (encrypted at rest, device-held keys) is stronger than what the target ships.
```

```yaml
id: ER-SP-039
area: browser extension
claim: >
  The browser extension captures nothing. It is a control bridge:
  - A Manifest V3 worker holds a WebSocket to the local server and runs `eval` and
    `get_cookies` commands through the debugger API.
  - Purpose: act inside logged-in pages — sync chat histories into memories, scrape
    authenticated pages, automate web tasks.
  Page URLs for capture come from the accessibility tree.
evidence:
  - type: source
    ref: packages/browser-extension/src/worker.ts:173-208, 339-440; packages/browser-extension/README.md:46-50
confidence: high
limits: Candidate reject for ambient memory; belongs, if anywhere, to docs/11 browser automation under the policy engine.
```

```yaml
id: ER-SP-040
area: quality / evals
claim: >
  Audio eval:
  - Diarization error rate (10 ms frames) on VoxConverse, VAD false-positive and
    false-negative rates, WER/CER on LibriSpeech, and synthetic fixtures for echo leakage.
  - A replay into a real DB checks that speakers do not collapse into one.
  - Results are posted to the PR; there is no numeric gate.
  Meeting eval:
  - Replays tick traces through the real state machine and scores meeting count, flaps, end
    latency and early ends.
  - CI fails on any scenario not marked as a known failure.
  Semantic-parser evals: token cost, facts kept, and off-screen text removed.
  Coding-agent eval: 162 real bug-fix commits, reporting pass@k; advisory only.
evidence:
  - type: source
    ref: crates/screenpipe-audio-eval/evals/README.md:32-213; src/der.rs:5-28; src/wer.rs:5-19
  - type: source
    ref: crates/screenpipe-meeting-eval/evals/README.md:7-184
  - type: source
    ref: evals/coding-agent/cases.json:1-11; run.mjs:395-477
confidence: high
limits: none beyond static reading.
```

---

## Divergences from `docs/24` (inputs for RECONCILIATION.md, not decisions)

| `docs/24` today | Finding | Evidence |
| --- | --- | --- |
| §3 adaptive sampling, "default 1 frame / 2 s" | Capture is event-driven with a 30 s idle heartbeat; fixed-rate was retired | ER-SP-001, 002 |
| §3 OCR adapters are the text source | The accessibility tree is primary; OCR runs only when the tree is thin | ER-SP-005..007 |
| §4 "vector index over chunked text" | None in the target; full-text search only, results in time order | ER-SP-027, 028 |
| §6 record has `text`, `blobRef`, `redactions` | Also carries text source, trigger, content hash, focused flag, element/word boxes, document path | ER-SP-007 |
| §7 "on-device redaction pass" | A read path that mechanically hides uncertified rows; regex alone cannot certify; images black-boxed | ER-SP-016, 017 |
| §2.5 encrypted at rest, device-held keys | The target's vault is CLI-only and disabled in its app | ER-SP-038 |
| §4 retention default 30 days | Target default: off, or 14 days in media mode | ER-SP-035 |
| §5 tools `ambient.search/timeline/transcript/screenshot/summarize` | Target adds an activity summary computed on the server, element search, meetings, speakers, raw SQL; the guide ranks the tools broad to narrow | ER-SP-029..032 |
| §9 "meeting detection", "accessibility-tree capture", "app-specific extractors" | All present: mic-holder meeting detection, a11y-first text, about 60 rule-based app parsers (off by default) | ER-SP-005, 024, 028 |
| §8 "gaps are recorded and shown" | Target exposes last frame/audio timestamps in health and recording status in the summary; no explicit gap records | ER-SP-029, 030 |

## Owner decisions from a related design session (context, not rea decisions)

On 2026-10-16 the owner designed this capability for the **existing Nova v4 codebase**
(`~/workspace/nova`), not this bundle. Spec: `docs/plans/rebuild/capture-recall.md`, commit
`3e598b61` on branch `claude/reverse-engineer-screenpi-nova-d30618`.

These are recorded so the reconciliation can see the owner's stated preferences. Where they
conflict with this bundle's hard invariants (policy engine, approvals, security model), this
bundle's precedence rules apply.

1. **All four outcomes, recall first.** Order: recall ("where did I see X"), then meetings,
   live context, digests.
2. **The Windows desktop is captured first.**
3. **Screen text lives on the hub.** The device extracts text and sends text plus
   app/window/URL metadata; recall works while the device sleeps.
4. **Pixels are captured on the device first, then uploaded to a configured location.** The
   location can be the hub, the device, another network storage device, off-network, or the
   cloud.
5. **The screen reader is a helper process with no network access**, supervised by the device
   agent, which does signing, queueing and transport.
6. **Model-based PII redaction runs on the device** before text leaves it, in addition to the
   regex scrub.
7. **PII categories are per-category switches.** Default on: secrets, government IDs,
   financial, account numbers. Default off: names, emails, phones, addresses, dates of birth.
8. **Instructions found inside captured text are marked and audited, not gated.**
   - This was decided under v4's "no approvals" ruling.
   - It **conflicts with `docs/24` §5**, which says ambient data "can never directly trigger a
     consequential action". The reconciliation must resolve this explicitly.

Design specifics from that session that may transfer:
- The hub refuses records whose redaction stamp covers fewer categories than configured.
- Coverage (captured spans and gaps) is required to build any read result, so an empty result
  always states what time it covered.
- A reply-level check flags claims about screen activity made in a turn where no capture tool
  ran.
- A tool call whose arguments copy a long verbatim run of captured text is tagged in the trace,
  and a stamped notice is appended to the reply by the backend.
- Images get solid black boxes over redacted-text bounds. An image is dropped when a redacted
  span has no known position.
- Images are encrypted with age to a hub-held key before upload, and the local copy is deleted
  only after a read-back check of size and sha256 at the target.
