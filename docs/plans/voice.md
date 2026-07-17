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

**Speech cadence (DONE 2026-07-16):** each synth chunk carries a `gap` — a
silent breath scheduled before it plays (`speech.ts`). Beyond the existing
list-item breath (LIST_GAP 0.35s), a new paragraph opens with PARA_GAP (0.5s)
and a spaced dash (` — `/` – `/` - `) splits the phrase with a brief DASH_GAP
(0.18s). Sentence-to-sentence stays gap-free (flow); intra-word hyphens
(co-operate, twenty-one) don't split. Deliberate per Jeremy — tune the
constants, don't remove them.

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
     *(DONE 2026-07-15 — built on Opus. openWakeWord's 3 ONNX models
     (melspec+embedding+hey_jarvis) self-hosted in `frontend/public/wake/`,
     pipeline ported to `src/voice/wake.ts` (onnxruntime-web/wasm, sharing
     the phase-3 ORT runtime at /vad/). The port was VERIFIED NUMERICALLY
     against openWakeWord's Python reference — zero per-chunk error — and
     the same scores reproduced live in-browser (fires at 0.925 on the
     reference clip, hands off to the VAD cleanly). listen_mode gains
     "wake"; `voice.wake_threshold` setting + honest Settings hint;
     ChatPanel wake toggle → continuous detect → barge-in + VAD capture →
     voice turn → resume. KEY LIMITATION: openWakeWord is trained on real
     human speech, so wake ACCURACY and threshold tuning need a real voice
     — can't be validated with synthetic TTS (both positive and negative
     kokoro clips score ~0.93). Uses "hey Jarvis" as a labeled stand-in.
     Build gotcha: import `onnxruntime-web/wasm`, NOT `onnxruntime-web`
     (the latter bundles a 26 MB WebGPU wasm); wasm excluded from PWA
     precache via globIgnores.)*
   - *4a·1 — assistant rename + wake-phrase decoupling (DONE 2026-07-16)*:
     the assistant's name is now a first-class setting
     (`nova.assistant_name`, default "Nova"), authoritative in every reply —
     `runner._build_system_prompt` rewrites the soul's self-name to match
     (`memory.soul(name)` swaps the frontmatter title throughout the body)
     and appends a "## Your name" backstop, so a renamed assistant never
     sees a conflicting name. Live-verified: rename→"Aria"→ask its name→
     "Aria" through the real chat stream. Frontend threads the name via
     `useAssistantName()` (chat header, speak-toggle title, empty state).
     Brain view also follows the name (DONE 2026-07-16): the graph's `core`
     node is relabelled to `nova.assistant_name` at the data layer in
     `Brain.tsx` (both renderers read it — `graph2d` via `n.label`, `galaxy`
     via the core star's `node.label` instead of a hardcoded string), with a
     `reloadRef` so a live rename re-fetches and relabels immediately rather
     than waiting for the 20s poll. STILL INTENTIONALLY "Nova": the pre-auth
     login gate (`App.tsx`) — no name is available before auth, and it reads
     as product branding, not the assistant persona.
     CRUCIAL: the wake phrase is DELIBERATELY separate from the name. A
     spoken trigger is a trained model, not a string, so `voice.wake_word`
     is a fixed catalog (`src/voice/wakeCatalog.ts`, currently just
     `hey_jarvis`), chosen independently — the Amazon model (rename the
     device; wake word stays one of a trained set). The catalog module is
     kept ORT-free so the UI can name phrases without bundling the runtime.
     Renaming to "Aria" does NOT give you an "Aria" wake word — that needs
     4c.*
   - *4c — custom wake word for a renamed assistant (ROADMAP, "train
     later")*: mint an openWakeWord model for an arbitrary phrase so a
     renamed assistant can be woken by its own name. Pipeline (offline,
     GPU — the 3090): (1) generate synthetic positives of the phrase with
     the bundled Kokoro TTS (54 voices × speed/pitch jitter) + hard
     negatives/background from the openWakeWord recipe; (2) train the wake
     head on the shared melspec+embedding front-end (unchanged, already
     self-hosted); (3) export a small ONNX; (4) drop it in
     `public/wake/<key>.onnx` and register `{key, label, file}` in
     `wakeCatalog.ts` — the picker and detector pick it up with no other
     code change (that seam is the whole point of 4a·1). Delivery options:
     a `backend/scripts/train_wake_word.py` an operator runs for a phrase,
     or eventually an in-app "train a wake word for '<name>'" flow that
     shells out to it. HONEST CONSTRAINTS: synthetic-only training gives a
     usable-but-not-great model (openWakeWord expects real human speech; TTS
     positives/negatives score alike ~0.93 — see 4a), training is minutes-
     to-an-hour on a GPU (not on-device, not per-request), and each phrase
     is ~1 MB. Alternative sketched + rejected: few-shot voice enrollment
     via the existing embedding model (speak it 3×, nearest-neighbour) —
     elegant reuse but lower accuracy and real research; revisit if
     per-phrase training proves too heavy. Picovoice/Porcupine would give
     arbitrary keywords but needs an account key → OUT (batteries-included,
     no API-key collecting).*
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
   - *4d — open-vocabulary "wake by name" (local ASR, ROADMAP — approved
     direction 2026-07-16)*: the way to make "Nova" / "Hey Nova" the trigger
     WITHOUT training an acoustic model (supersedes 4c for the naming case).
     Instead of matching a fixed trained phrase, transcribe continuously and
     spot the NAME anywhere in the transcript, so "Hey Nova …", "Nova, …",
     and "…, Nova?" all fire. Pipeline (extends 4b's server-listen path):
     always-on mic → silero VAD (gate: only run ASR on actual speech, not
     silence — the cost lever) → faster-whisper (already running) →
     name-spot in the transcript → optional tiny local intent check (is this
     a command, or an incidental "I watched NOVA on PBS"?) → hand the
     utterance to the chat turn. The name spotter should prefer vocative
     position (sentence start/end, comma-adjacent) to cut incidental hits.
     WHY THIS over 4c: no per-name training, positional flexibility for
     free, and it directly answers "make the wake word Nova." COST: local
     compute only (VAD-gated ASR on the 3090 — electricity/heat, not
     credits); nothing leaves the machine and zero API credits until an
     utterance actually earns a response. PRIVACY (must be explicit +
     opt-in, NOT default, visible "listening" indicator): unlike 4a/4c which
     only ever "hear" the trigger phrase, continuous ASR transcribes ALL
     nearby speech locally — a real surface change even though it never
     leaves the device. New `voice.listen_mode` value (`name`/`open`)
     alongside ptt/tap/wake. MODEL POLICY (2026-07-16): the voice-reply
     model stays separate from the main agent's and is recommended
     per-hardware from the curated catalog's `voice` role (migration 022:
     qwen3:4b tiny/CPU fallback, qwen3:8b ~8 GB GPU, gemma4:e2b no-GPU
     frontier MoE, gemma4:12b 10 GB+ GPU). When always-listening is ON,
     steer hard to LOCAL (cloud = ambient speech leaves the machine and
     bills per utterance — the Settings hint says so). Follow-up
     suggestion, only when always-listening is enabled with a local model
     resident: offer to point compaction+guard at that same model and drop
     the tiny 3B (one resident model beats two loaded ones); when
     always-listening is off, the small model remains the efficient choice. EXPLICITLY REJECTED — nameless addressee
     detection ("is she being talked to?" with no name): addressee is
     genuinely ambiguous audio-only ("what time do you go to work?" to a
     spouse vs. Nova), and the failure is asymmetric — a false interject is
     creepy and means she's interpreting every conversation. The name is the
     consent signal (why every commercial assistant requires a wake word).
     Capability-awareness ("who's at the door?" → do I have a camera?)
     belongs AFTER the name is said — a responding refinement, not a
     trigger.
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
