# Speaker identification — Nova knows who's talking (plan, approved 2026-07-23, no code yet)

Jeremy's ask: when he talks, Nova knows it's him; when his kid talks, Nova
knows that and behaves differently — "a different role and another identity
to follow." Planned interactively 2026-07-23; the decisions below marked
LOCKED are his.

**LOCKED (Jeremy, 2026-07-23):**

- **Kid mode is all three at once**: persona tone/content rules AND
  mechanically restricted tools AND separate memory attribution (what the
  kid says must never update Nova's model of Jeremy).
- **Unknown / low-confidence voice → Ask**: the turn proceeds at the most
  restricted tier and Nova asks who's talking.
- **One conversation stream, turns tagged** with the speaker (parent
  oversight comes free; no per-person threads).
- **A real `user_profiles` table** — built for N people, exercised with
  two (operator + kid).
- **Voice ID is personalization, NEVER authentication.** A voiceprint
  match may only ever NARROW privileges below the operator baseline
  (playback-spoofable; kids' voices drift; short utterances misfire).
  "Sounds like the kid → restrict" is safe; "sounds like Jeremy → unlock"
  is forbidden. The auth token + the consents gate remain the security
  boundary. Corollary: since typed chat has no voice signal, typed = the
  operator (whoever holds the authed device), documented behavior.

## What exists (verified in code, 2026-07-23)

- **Whisper service** (`whisper/app.py` + Dockerfile — a BAKED image, deps
  inline in the Dockerfile pip line, NO torch): FastAPI; faster-whisper
  via ctranslate2 under a single asyncio lock; `/transcribe` reads the
  whole utterance as raw bytes (webm/opus, mp4, or wav — PyAV decodes),
  idle-unloads the model. The full audio is in memory right where an
  embedding pass would run. Weights live in the `whisper_models:/models`
  volume (relocatable via docker-compose.models.yml).
- **Audio formats**: tap/wake path (vad.ts) hands the backend 16 kHz mono
  s16 WAV (`utils.encodeWAV(audio, 1, 16000, 1, 16)`); PTT (mic.ts) sends
  webm/opus at device rate. Both decodable in-service; no frontend capture
  changes needed for recognition.
- **Voice turn path**: ChatPanel `submitUtterance` → `transcribeSpeech`
  (`POST /api/v1/voice/transcribe`, router_voice.py proxies to whisper and
  returns `{text, language, language_probability}` unchanged) → `send({
  source: 'voice' })` → `ChatRequest.source` (schemas.py) → router_chat's
  `source == "voice"` branch (sets `_VOICE_BREVITY` as `system_suffix` +
  applies `voice.model_override`). A `speaker` field rides this exact
  path.
- **Persona seam** (#15 phase 1, runner.py `_build_system_prompt`): slots
  ROLE → FACTS → CONTEXT → LAST WORD; FACTS blocks follow the `_now_block`
  idiom (live, non-quotable, `""` on failure never breaks a turn);
  `system_suffix` is the single lands-last register — voice REPLACES the
  typed default (`parts.append(system_suffix or _TYPED_REGISTER)`).
- **Tool gate** (`tools/registry.py`): the runner computes the turn's
  toolset once (`get_agent_tools`) and stamps `ctx["granted"]`;
  `execute_tool` refuses names outside it, then runs `rules.check`. `ctx`
  is built per `run_agent` call — already per-turn — and the only
  existing per-turn clamp is the dispatch-depth `exclude` set. The
  consents gate (consents.py) shows the house pattern: mechanical
  check at the tool layer, no LLM judgment.
- **Memory attribution**: `memory.write(...)` carries `source_type` (and
  `maintained_by` for automations) — no author/person axis yet.
  `messages.metadata JSONB` is the extensible per-message slot (already
  used for attachments + trace ids).
- **No users table** (single implicit operator in `nova.user_name`
  setting); **no enrollment/recording UX** anywhere (Settings → Voice is
  pickers only). ROADMAP #11 (wake word learns) wants the same
  record-N-utterances flow — build the recorder once, both consume it.
- Migration numbering: check the dir at build time — next free was **049**
  as of 2026-07-23; parallel lanes move it.

## Design

### Embedding model: sherpa-onnx, not SpeechBrain

The whisper image has no torch, and SpeechBrain would drag ~2 GB of it
into a baked image. **sherpa-onnx** ships a `SpeakerEmbeddingExtractor`
over onnxruntime (CPU, ~10 ms per utterance, thread-safe enough behind its
own lock) using WeSpeaker/3D-Speaker/NeMo voxceleb-class ONNX models
(~25 MB, plain GitHub-release downloads — no keys, batteries included).
Voxceleb-trained English models discriminate a household fine; adult vs
child is the easy case. Model file lands in the existing `/models` volume
(auto-download on first use, mirroring the whisper-weights pattern).

### Migration 049 — `user_profiles`

```sql
CREATE TABLE IF NOT EXISTS user_profiles (
    id             UUID PRIMARY KEY,
    name           TEXT NOT NULL,
    role           TEXT NOT NULL DEFAULT 'guest'
                   CHECK (role IN ('operator', 'kid', 'guest')),
    persona_notes  TEXT,            -- feeds the runner's speaker block
    voiceprint     JSONB,           -- embedding vector (~192 floats); NULL until enrolled
    enrolled_clips INT NOT NULL DEFAULT 0,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

Cosine matching happens in Python over a handful of rows — no pgvector
dependency. **Biometric stance** (same as #11): voiceprints are local-only,
deleted with the profile, and raw enrollment audio is
**embedded-and-discarded** — no clips stored server-side in v1 (#11 may
later opt into keeping clips, separately and explicitly).

### Whisper service: `POST /embed`

Same raw-audio body contract as `/transcribe`; returns `{embedding:
[...], secs}`. Decode via the bundled PyAV (resample to 16 kHz mono),
extract with sherpa-onnx under its own lock (never the ctranslate2 lock —
embedding must not queue behind a long transcription). Utterances shorter
than ~1.5 s return `{embedding: null}` (too little signal — the caller
treats it as unknown). Dockerfile gains `sherpa-onnx numpy` on the
existing pip line → image rebuild.

### Backend: `voiceprints.py` + transcribe wiring

- `match(embedding) -> {profile, confidence} | None` — cosine against all
  enrolled profiles; a match requires BOTH `top >= voice.speaker_threshold`
  (new setting, default 0.55) AND `top - second >= voice.speaker_margin`
  (default 0.10). Anything else → unknown. Tunable from Settings, no code.
- `router_voice.transcribe` gains the pass: after whisper returns text,
  POST the same bytes to `/embed`, match, and extend the response with
  `speaker: {profile_id, name, role, confidence} | null`. Fails soft:
  embed/match errors → `speaker: null`, transcription unaffected.
- Profiles CRUD (operator-only, like all of the API):
  `GET/POST /api/v1/profiles`, `PATCH/DELETE /api/v1/profiles/{id}`, and
  `POST /api/v1/voice/enroll` (raw audio + `?profile_id=` → embed →
  running-average into `voiceprint`, bump `enrolled_clips`, discard audio).
- `ChatRequest.speaker` (optional profile_id string) — the client echoes
  what transcribe reported, exactly as `source` works today. Honest note:
  the client already holds the operator token, so the echo adds no attack
  surface, and the tier only ever narrows.

### The turn wears the speaker

- **router_chat**: resolve `request.speaker` → profile row. Persist
  `{speaker: {id, name, role}}` into the user message's
  `messages.metadata`. The end-of-turn journal write becomes
  `"«{name}» ({role}): ..."` with `author={name}` in memory metadata —
  kid facts never file under Jeremy. Pass the profile into `run_agent`.
- **runner**: new FACTS block `## Who you're speaking with (live)` (name,
  role, persona_notes, confidence — the `_now_block` idiom). LAST WORD:
  the speaker register COMPOSES onto the channel register (append after
  `system_suffix`, never replace):
  - kid: simpler words, kid-appropriate topics, extra patience; never
    discuss the operator's private/work topics or the restrictions
    themselves.
  - unknown/guest: "you don't recognize this voice — ask who's talking,
    stay friendly and general; an enrolled household member can be added
    from Settings."
- **ChatPanel**: when a voice turn's speaker ≠ operator (or is unknown),
  the user bubble wears a small label (name or "unknown voice"); the
  transcribe → send call passes the speaker through.

### Restricted tier — mechanical, at the tool layer

- `run_agent` gains the speaker; for role in `{kid, guest}` or unknown-
  with-voice, the runner intersects the computed toolset with
  `_RESTRICTED_TOOLS = {"web_search"}` (v1: search only — no memory
  writes, no settings, no notify, no manage_*, and `dispatch_to_agent`
  excluded so the clamp can't be escaped through a sub-agent) BEFORE
  stamping `ctx["granted"]`, and stamps `ctx["speaker_role"]`. Same
  enforcement point as everything else (`execute_tool`'s granted check);
  guardian/rules untouched on top.
- Operator voice and typed chat: exactly today's behavior.

### Enrollment UX (Settings → Voice, "Household voices" card)

List profiles (name, role, enrolled-clips count, delete); add profile;
per profile an enroll flow: record 3–5 short utterances (reuse the
existing `Mic`/`TapVad` capture classes — say anything natural, a few
seconds each), each clip POSTs to `/api/v1/voice/enroll`, progress shown,
done. Re-enrolling later just averages in more clips (voices drift —
especially kids'; re-enroll every few months). Reachable by navigation
(house rule); this same recorder is what #11 will reuse for wake-word
enrollment.

## Phases (one per session; verify lines are the gate)

1. **Ears** — whisper `/embed` (+ Dockerfile dep + rebuild), migration
   (check the free number), `voiceprints.py`, transcribe returns
   `speaker`, profiles CRUD + enroll endpoint, the Household-voices card
   with the recorder, `voice.speaker_threshold`/`voice.speaker_margin`
   settings. **Verify:** enroll Jeremy live at :5173; his voice turns
   come back `speaker=jeremy` with plausible confidence; kokoro TTS
   voices played into the mic act as synthetic strangers → `unknown`;
   sub-1.5 s clips → `unknown`. (Real-kid enrollment is Jeremy's step,
   on the phone or desk mic.)
2. **Identity** — `ChatRequest.speaker`, metadata tag + bubble label,
   runner speaker FACTS block + composed register, journal `author`
   attribution, unknown→ask register. **Verify:** normal operator turn
   unchanged (prompt inspection in-container, like the persona-pass
   verification); a forced-kid turn (tag spoofed via curl — that's the
   personalization-not-auth point) shows the tone shift, tagged bubble,
   and an `author`-attributed journal entry.
3. **Tier** — the granted-set intersection + `ctx["speaker_role"]` +
   dispatch exclusion. **Verify:** kid-tagged turn requesting a memory
   delete / settings change → tool refused at the layer ("not granted"),
   turn continues gracefully; operator turn identical to before; trace
   shows no clamped tool ever executed.
4. **Auto-enrollment (added 2026-07-24 at Jeremy's direction — BUILT):**
   unknown voices enroll themselves through conversation. Unknown-turn
   embeddings wait in a short-lived pending buffer; the turn-scoped
   `remember_speaker` tool (granted ONLY on unknown-voice turns) creates a
   GUEST profile from the name the person offered and folds the pending
   samples in — the name is a label, never authority, and a collision
   with an existing profile creates a distinct entry rather than folding
   a stranger's voice into someone's print. `voice.speaker_autotrain`
   (default on) keeps enrolled prints current by folding decisively
   confident matches (threshold + 0.15) into a capped-window mean, so
   voices can drift (kids grow) without manual re-enrollment. Also at
   Jeremy's direction: `voice.family_tools` allowlist (consume-not-change:
   default web_search; `mcp:*` patterns available), and typed chat stays
   operator-by-authentication, confirmed as intended.
5. **Later (flagged, deliberately not built now):** retrieval-side
   content filtering for kid turns (memory.context currently retrieves
   from the whole store — persona rules carry v1); retroactive re-tagging
   of the turns that preceded a remember_speaker naming; keeping
   enrollment clips (opt-in) to feed #11 wake retraining; per-profile TTS
   voice; brain-graph per-person companion stars; and Jeremy's
   multi-tenancy direction (2026-07-24): per-user authentication and
   per-user memory instances — "each person may get their own memory
   instance of Nova (at minimum)" — a separate design pass when he's
   settled on how to split user concerns.

## Traps

- **Never widen on a match.** Code-review test for every phase: delete the
  voiceprint table entirely and the system must degrade to exactly
  today's single-operator behavior, never to something more permissive.
- The embedding pass must never block or fail a transcription (speaker:
  null on any error) — voice chat keeps working if the model download is
  slow or the service is mid-rebuild.
- Whisper image is baked: `/embed` changes need
  `docker compose build whisper && up -d whisper` (same trap as web).
- Kids' voices drift; short utterances under-signal. The Ask path is the
  designed landing zone for every uncertainty — tune thresholds in
  Settings, don't chase certainty in code.
- Enrollment audio is biometric-adjacent: embed-and-discard in v1, opt-in
  storage only ever as a separate, explicit later decision.
