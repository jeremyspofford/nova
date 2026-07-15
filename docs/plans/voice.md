# Voice — talking to and hearing Nova

Implementation plan (authored 2026-07-15 with Fable; execute with any model,
one phase per session). Decisions below marked LOCKED were made by Jeremy on
2026-07-14 — do not relitigate them; flag conflicts instead.

## Decisions (LOCKED)

- **STT**: local `faster-whisper` with `silero-vad` for utterance
  endpointing. The 3090 makes this fast; CPU fallback must still work.
- **TTS**: local Kokoro-class as the batteries-included default; premium
  cloud voices (ElevenLabs/OpenAI) as *keyed opt-in extras* — never required
  (product principle: no API-key collecting).
- **Interaction**: wake word ("Nova …") is the target UX, while the app
  is OPEN. Push-to-talk ships as the built-in fallback for
  mic-denied/failed-wake cases. UPDATED 2026-07-15 (supersedes the
  2026-07-14 "wake runs server-side" call): **the listening engine is
  user-selectable** — on-device (browser, keyless, continuous audio never
  leaves the device; the privacy-first DEFAULT) or on-server (turnkey,
  robust, streams the mic over the tailnet WS while the app is open).
  Nova ships BOTH; Settings presents honest per-option requirements and
  readiness ("what you need for this to work"), the same hybrid shape as
  bundled-vs-external inference. Tap-to-talk (plain VAD endpointing) is
  browser-only by design — a server variant would add a WS stack for zero
  quality gain.
- **Streaming**: sentence-buffered TTS — Nova starts speaking before the
  reply finishes (v0.1.0-alpha had this recipe; mine `git show
  v0.1.0-alpha` for ideas only, never code).
- **Honest platform limit** (document in UI copy, don't fight it): a PWA
  cannot listen in the background or with the screen locked (iOS
  foreground-only mic). Always-on ambient listening = native app or
  dedicated device, later item.

## Architecture

Two new compose services, both optional profiles like `ollama`:

```
frontend/web ──WS /api/v1/voice/stream──▶ backend ──HTTP──▶ whisper  (STT+VAD+wake)
                                              │
     ◀──────── audio chunks (TTS) ────────────┴──────HTTP──▶ kokoro   (TTS)
```

- `whisper` service: FastAPI wrapper around faster-whisper + silero-vad +
  openWakeWord. Endpoints:
  - `POST /transcribe` — complete utterance WAV/PCM → `{text, language, avg_logprob}`
  - `WS /listen` — 16 kHz mono PCM frames in → events out:
    `{"e":"wake"}`, `{"e":"speech_start"}`, `{"e":"speech_end"}`,
    `{"e":"partial","text":...}` (optional, phase 4+), `{"e":"final","text":...}`
  - VAD and wake run on every frame; whisper runs only on VAD-bounded
    utterances (that's the whole point — GPU per utterance, not per frame).
- `kokoro` service: FastAPI wrapper. `POST /tts {text, voice, speed}` →
  audio bytes (WAV or 24 kHz PCM; pick one and encode it in the contract).
  Keep it stateless; sentence-level requests give us streaming for free.
- `backend` orchestrates: it owns the browser-facing WebSocket, forwards
  mic frames to whisper's `/listen`, turns final transcripts into normal
  chat turns (reuse the existing `run_agent` pipeline — a voice turn IS a
  chat turn), and runs the sentence-buffer that feeds kokoro and streams
  audio back.
- GPU wiring goes in `docker-compose.gpu.yml` like ollama's; both services
  must run CPU-only too (small models).

## Browser-facing contract

`WS /api/v1/voice/stream` (backend). Browsers can't set an Authorization
header on WebSockets — authenticate with `?token=<NOVA_AUTH_TOKEN>` query
param, validated the same way as the bearer middleware (share the code
path; see the auth trap in [auth-changes memory]: verify from a clean
browser via :8080, not just :5173).

Client → server: binary frames = 16 kHz mono s16le PCM (AudioWorklet
downsamples from the mic's native rate); JSON text frames for control:
`{"c":"mode","value":"wake"|"ptt"}`, `{"c":"ptt_down"}`, `{"c":"ptt_up"}`,
`{"c":"cancel"}` (barge-in: stop speaking + discard queued TTS).

Server → client: JSON events `{"e":"wake"}`, `{"e":"listening"}`,
`{"e":"transcript","text":...}`, `{"e":"reply_text","t":...}` (mirror of
the SSE `t` deltas so the chat UI stays in sync), `{"e":"speaking_start"}`,
`{"e":"audio_end"}`, `{"e":"error","detail":...}`; binary frames = TTS
audio chunks tagged by a preceding `{"e":"audio","seq":n,"sentence":...}`.

The voice turn writes to the SAME conversation via the existing
`conversations` module — someone watching the chat panel during a voice
exchange sees the normal transcript appear.

## Sentence buffer (backend)

Tap the `run_agent` event stream (it already yields `{"type":"text"}`
deltas — see `backend/app/agents/runner.py`). Accumulate deltas; flush to
kokoro on sentence boundaries (`.`, `?`, `!`, `:`, newline — plus a
max-chars flush ~220 so a long unpunctuated ramble still speaks). Pipeline
concurrency: while sentence N plays, N+1 may synthesize; keep an asyncio
queue with a small bound (2) so barge-in cancels cheaply. Strip
markdown/code fences before synthesis (code blocks are summarized as
"…code omitted…" in speech, full text still lands in chat).

## Frontend

- Mic capture: `getUserMedia` → `AudioWorklet` (do NOT use the deprecated
  ScriptProcessor) → downsample to 16 kHz s16le → WS binary frames.
- UI: a mic control in `ChatPanel.tsx` with three visual states —
  idle / listening (wake armed or PTT held) / Nova speaking. PTT = hold
  spacebar or hold the button (must work on phone touch). Autoplay policy:
  create/resume the `AudioContext` inside the first user gesture on the
  mic control, or Safari will refuse playback.
- Playback: enqueue received PCM chunks into Web Audio
  (AudioBufferSourceNode chain). Expose live output amplitude on a shared
  object — this is the `setActivity`/energy input the entity view
  (`ROADMAP` item, mockups v8–v11) will consume later; design the hook now
  (`window.novaVoice.level` or a tiny event emitter in `src/voice/`), don't
  build the visuals.
- Settings → Voice card: enable voice, mode (wake/PTT), TTS voice picker,
  speed, and the honest-limits copy. Settings keys via `settings_store`:
  `voice.enabled`, `voice.mode`, `voice.tts_engine` (`kokoro` |
  `elevenlabs` | `openai`), `voice.tts_voice`, `voice.tts_speed`,
  `voice.stt_model` (whisper size), `voice.wake_sensitivity`,
  `voice.model_override` (see phase 1b), `voice.listen_mode`
  (`ptt | tap | wake`), `voice.wake_engine` (`device | server`).
- Swappability is a product requirement (Jeremy, 2026-07-15): when better
  voice/LLM models come out, replacing them must be a UI action, never a
  code change — the engine setting, the voice picker, the model override,
  and (added 2026-07-15) the listening choices `voice.listen_mode` +
  `voice.wake_engine` are the swap points; every new engine/backend must
  slot into them rather than adding parallel config. Options with unmet
  prerequisites render their requirements ("what you need"), not a
  silent failure.
- Phone path: everything must work through `web:8080` same-origin — nginx
  needs `proxy_set_header Upgrade/Connection` for the WS route (check
  `frontend/` nginx conf, target `web`). Verify on the actual phone over
  tailscale; mic requires the secure-context the tailnet HTTPS/QR setup
  already provides.

## Phases (each ends live-verified through :5173 AND :8080, changes left uncommitted)

1. **Speak replies (TTS only, no mic).** kokoro service + `POST
   /api/v1/voice/tts` + sentence buffer on the chat stream + playback +
   speaker toggle in ChatPanel. Verify: send a long chat message, audio
   starts before the SSE stream finishes.
   *(DONE 2026-07-15 — live-verified through :5173 and :8080; emojis are
   stripped before synthesis.)*
1b. **Voice settings polish (requested 2026-07-15).**
   *(DONE 2026-07-15 — dropdown of 54 voices + inline preview live;
   `voice.model_override` reuses the existing `model` dropdown type,
   routes on `source:"voice"`, verified empty→main / set→override via
   SSE meta.model.)*
   - Settings → Voice: replace the free-text voice id with a dropdown
     populated from `GET /api/v1/voice/health` (54 kokoro voices), plus a
     **preview button** that synthesizes a short sample ("Hi, I'm Nova —
     this is how I sound.") through the existing `/tts` endpoint and
     plays it inline. Needs a `select-dynamic` treatment in the Settings
     UI: options fetched at render, value stays a plain string setting so
     nothing else changes.
   - `voice.model_override` (string setting, default empty = same model
     as chat): when set, voice-initiated turns use this model instead of
     the main agent's — the swap point for "a faster/more conversational
     LLM while talking". Phase 1 has no voice-initiated turns yet, so
     wire the read into `chat_stream` behind a request flag
     (`ChatRequest.source == "voice"`) that phase 2's transcript turns
     will set; the Settings field ships now so the knob exists.
   - Verify: pick a different voice from the dropdown, hear the preview,
     send a chat message and hear the new voice; set the override and
     confirm (via the SSE `meta.model`) that a `source:"voice"` request
     uses it while typed chat does not.
2. **PTT STT.** whisper service (`/transcribe`) + hold-to-talk → transcript
   → normal chat turn → spoken reply. Full loop, zero wake-word complexity.
   *(DONE 2026-07-15 — built on Opus. DEVIATED from the plan sketch:
   record-then-POST, NOT a WebSocket/worklet. Rationale: a PTT utterance is
   bounded and faster-whisper transcribes a whole clip in one shot, so
   streaming frames buy nothing here; the WS/worklet is deferred to phase 3
   where continuous VAD actually needs frame-level capture. Implementation:
   `whisper` compose service (faster-whisper base/int8 CPU + silero
   vad_filter), backend `POST /api/v1/voice/transcribe` proxy, frontend
   MediaRecorder capture (`src/voice/mic.ts`) + a hold-to-talk mic button;
   the transcript posts as a `source:"voice"` turn and the reply is always
   spoken (voice in → voice out). Live-verified end-to-end via a headless
   fake-audio device, incl. the :8080 phone path. Whisper on GPU is a clean
   additive follow-up — matters more for video ingestion's long audio.)*
3. **Tap-to-talk — browser VAD endpointing (frontend-only).** silero-vad
   runs IN the browser (onnxruntime-web/WASM; the `@ricky0123/vad-web`
   wrapper is the known-good path — but SELF-HOST its model + worklet
   assets with the app, never its CDN defaults: batteries-included and
   no runtime third-party fetches). Tap to arm → speak → auto-endpoint on
   ~700 ms silence (300 ms min speech) → the captured utterance takes the
   SAME blob→/transcribe→`source:"voice"` path phase 2 built. ZERO
   backend changes; no server variant on purpose (silero is silero on
   either side — a server version would only add transport). UI: the mic
   button becomes mode-aware via `voice.listen_mode` (hold=ptt /
   tap=arm), with visible armed/capturing states. Settings hint: modern
   browser (WASM SIMD), ~2 MB one-time model download (PWA-cached), mic
   requires the secure context the tailnet HTTPS already provides.
   *(DONE 2026-07-15 — built on Opus. vad-web 0.0.30 + onnxruntime-web
   1.27; four assets self-hosted under `frontend/public/vad/` (worklet +
   silero_vad_v5.onnx + ort simd wasm/mjs, ~15 MB — the ORT wasm is the
   bulk, not ~2 MB; hint copy updated to say so). `src/voice/vad.ts`
   (dynamic-imported so ORT stays out of the main bundle), `voice.listen_mode`
   enum (ptt|tap, default ptt) + a friendly Settings selector with the
   honest requirement hint. THREE gotchas fixed & worth remembering: (1)
   Vite dev 500s transforming ORT's `.mjs` glue → a `configureServer`
   middleware serves `/vad/*.mjs` raw; (2) nginx must give `/vad/` .js+.mjs
   a JS MIME and .wasm application/wasm or addModule/import reject them
   (a location-level `types{}` REPLACES the global map — list js too); (3)
   calling the VAD's `destroy()` from inside its own `onSpeechEnd` callback
   wedges the async continuation — defer with `setTimeout(0)`. Workbox
   `globIgnores: ['**/vad/**']` keeps the 13.5 MB wasm out of precache.
   Live-verified on :5173 AND :8080 via a headless fake-audio device:
   tap→speech→endpoint→transcript→spoken reply, source:"voice", and
   ZERO third-party hosts contacted.)*
4. **Wake word ("Nova") — dual engine, user's choice.**
   - *4·0 — the "Nova" model (shared prerequisite, both engines)*:
     openWakeWord has no pretrained "Nova". Train it locally with the
     openWakeWord recipe — synthetic positives generated by the bundled
     TTS (54 kokoro voices × speed/pitch jitter), standard negatives; the
     3090 handles training. Artifact is a small ONNX shipped with the
     app/backend (self-hosted). Until it exists, the nearest pretrained
     model ("hey Jarvis") stands in behind the same setting, clearly
     labeled as such in the UI.
   - *4a — on-device engine (privacy-first default)*: openWakeWord's
     pipeline (melspec → embedding → wake head) via onnxruntime-web,
     assets self-hosted (~10 MB, PWA-cached). Listens only while the app
     is open and `listen_mode=wake`; a wake fire arms the phase-3 VAD
     capture → same transcribe path. Continuous audio NEVER leaves the
     device. Hints: model download size, phone battery cost,
     foreground-only (the PWA platform limit).
   - *4b — on-server engine (robust alternative)*: this is where the
     WebSocket finally earns its build: AudioWorklet 16 kHz s16 frames →
     `WS /api/v1/voice/listen` (auth via `?token=` — browsers can't set
     WS headers; nginx on :8080 needs Upgrade/Connection headers) →
     silero + openWakeWord inside the whisper service → events back
     (`wake`, `speech_end`, `transcript`). Hints: voice profile must be
     running; the mic streams to your Nova continuously while the app is
     open (~32 KB/s — trivial on the tailnet at home, ~115 MB/hour on
     cellular).
   - `voice.wake_engine` (`device | server`): Settings shows both with
     honest requirement copy + a readiness dot each (model
     downloaded/trained? voice profile up?); an option whose
     prerequisites are missing shows what's needed instead of failing
     silently.
   - *Barge-in (both engines)*: a wake fire — or any PTT/tap capture —
     during playback cancels the current speech.
   - De-risk: if the 4a browser port fights back, ship 4b first — the
     setting's shape doesn't change and 4a slots in later. This phase is
     the UX polish loop; budget iteration time for wake accuracy.
5. **Keyed cloud TTS (opt-in extra)** behind the same engine interface;
   secrets via the admin secrets pattern, never in requests to the LLM
   (guardian rule).

## Risks / traps

- Latency budget for "feels alive": wake→listening cue <300 ms;
  speech_end→first audio <1.5 s (whisper small/int8 on 3090 ≈ 100–300 ms;
  the LLM's first sentence is the long pole — sentence buffering is what
  saves us).
- Compose: new env vars mean `docker compose up -d backend`, never
  `restart` (CLAUDE.md trap).
- Whisper hallucinates on silence/noise — never send VAD-rejected audio;
  drop final transcripts with low `avg_logprob` and reply with a
  "didn't catch that" event instead of a garbage chat turn.
- iOS Safari: worklet + WS is fine, but the tab suspends on lock/background
  — surface state honestly in the UI (mic indicator dies, don't pretend).
- Model downloads (whisper/kokoro/openWakeWord weights) happen at image
  build or first start — bake into the image or a named volume; startup
  must not silently block for minutes (log + health endpoint, and the
  Models/inference-control page already has patterns for install state).
