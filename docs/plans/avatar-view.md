# Avatar — the embodied presence view

**SHELVED 2026-07-19 (Jeremy, after reviewing the kit-preview animation).**
The static kit passed review; the ANIMATION of it did not — "that's pretty
bad" is the verdict to respect. Do not build phase 1+ until a motion
prototype passes Jeremy's eye. His critique, verbatim in substance, with
diagnosis (see also the phase-0 status block):

1. **"Too zoomed in — needs to not be so close."** The preview's
   zoom-face default (now off) was wrong; the theme must use the natural
   full-figure framing. (This REVERSES the earlier phase-1 note that
   suggested framing head+torso — Jeremy's call wins.)
2. **"The eyes are still behind it when it blinks; blinks too fast and
   often."** Three separate defects: (a) the alpha CROSSFADE superimposes
   open eyes under semi-transparent lids mid-blink — a blink must OCCLUDE
   (opaque lid wipe / clip-path reveal), never blend; (b) 150 ms full
   cycle is far too fast — human is ~300-400 ms, asymmetric (fast close,
   brief hold, slower open); (c) every 2-6 s reads twitchy — try 4-10 s
   and drop the double-blink; (d) the lid frame itself still carries
   eye-socket shading that reads as eyes through the lids at distance —
   may need a darker, simpler lid variant.
3. **"The mouth looks terrible when speaking."** Three discrete sprites
   with 70 ms alpha blends read as flicker/ghosting, and the synthetic
   burst envelope is worst-case jittery input. Candidate directions for a
   resume: continuous mouth motion instead of sprite swaps (vertical warp
   of the mouth region scaled by the envelope, sprites only as keyframes
   to blend toward), several in-between openness steps, drive with REAL
   Kokoro audio early (real speech energy is far smoother than the
   synthetic syllables), and honestly re-evaluate whether sprite
   compositing can ever satisfy — the warp approach or the phase-5
   neural gate may be the real answer.

Everything below (pipeline, assets, tooling) remains valid and preserved;
it's the motion layer that failed review.

Implementation plan (authored 2026-07-19 with Fable; execute with any model,
one phase per session). This resumes the paused entity-view lane (ROADMAP
item 2's "aspirational later pass", mockups v1–v11 in
`frontend/public/mockups/`) now that the missing piece exists: Jeremy has a
Midjourney concept render he likes. Decisions marked LOCKED are Jeremy's —
do not relitigate them; flag conflicts instead. Verification lines are the
definition of done: real chat flow through :5173 with voice enabled, and
:8080 where stated.

## The concept

A translucent blue hologram figure — head, shoulders, torso — drawn in
luminous wireframe/circuit filaments on a soft dark-blue bokeh field. Calm,
slightly upturned face; reads as a presence made of light, not a robot.
Reference still (local-only, mockups are gitignored):
`frontend/public/mockups/avatar/concept-v1-wireframe-figure.png`.

When Nova speaks (Kokoro TTS already playing in the browser), the figure's
lips move in sync with her actual voice. When she listens, thinks, works —
the light says so. At rest she stays alive: breathing, blinking, filaments
shimmering.

## Decisions (LOCKED)

- **Local-only pipeline.** No cloud avatar APIs (D-ID, HeyGen, etc.) — not
  even as an opt-in extra for v1. Follows from product principles
  (batteries-included, privacy first, local-model users primary): those
  services ship the character image plus every reply's text to a third
  party and bill per minute of video. Decided 2026-07-19 after reviewing a
  Gemini-suggested D-ID pipeline (see "Why not" below).
- **Stylized presence, not a person** (Jeremy, 2026-07-14, carried from the
  entity-view lane): androgynous, no uncanny valley, no implied identity.
  The wireframe hologram aesthetic satisfies this natively — and it is
  the reason we don't need photoreal neural lip-sync at all.
- **Tone: cool, not menacing** (Jeremy, 2026-07-19: "cool, but not
  terminator the-ai-is-going-to-kill-you"). Design guardrails: cool
  blues/teals/soft violets; no red anywhere; motion always eased, never
  snapping; expression calm; idle = dim and soft, never a bright fixed
  stare. The orb's amber "working" tint is the warmth ceiling.
- **Build alongside, converge later** (universe-view precedent): a NEW
  theme in the THEMES registry next to the Nova orb. The orb stays. Whether
  avatar eventually absorbs the orb (orb as the avatar's dissolved idle
  form?) is Jeremy's call after living with both.
- **Voice drives the face.** The mouth follows the audio actually playing —
  `speaker`'s Web Audio path — never a text-based guess.

## Why not the obvious pipelines

Recorded so implementing sessions don't relitigate:

- **Cloud avatar APIs (D-ID `/talks`, HeyGen)**: privacy + cost, and the
  batch endpoints render a video *file* per reply — seconds of dead air,
  not a live presence. The streaming variants are WebRTC products with
  per-minute billing. All conflict with LOCKED decision 1.
- **Self-hosted neural talking-heads**: SadTalker is an offline renderer
  (minutes per clip — useless for conversation). Wav2Lip is fast but
  blurry-mouthed. MuseTalk is the one credible real-time option (~30fps on
  a decent NVIDIA GPU) but adds model weights, per-frame GPU inference, and
  a video stream into the frontend. Deferred behind a decision gate
  (phase 5) — only worth it if Jeremy wants photoreal after living with
  the hologram.
- **What we do instead**: composite a rigged still in canvas-2D and drive
  the mouth from the live output amplitude/spectrum. Zero new services,
  zero latency by construction, runs on anything, on-principle.

## What already exists (verified in code 2026-07-19)

- **Audio**: `frontend/src/voice/speech.ts` — Kokoro WAV (24 kHz) decodes
  and plays through Web Audio; every source connects through an
  `AnalyserNode` (fftSize 512); `speaker.level()` returns live RMS 0..1 and
  was built as "the entity view's energy input". `speaker.speaking` is a
  live boolean.
- **State machine**: `frontend/src/brain/nova.ts` (the orb) — five modes
  (idle/listening/thinking/working/speaking) with eased weight crossfades,
  `resolveMode()` freshness rules, speaking polled off `speaker`, the rest
  via `setActivity`. The avatar reuses this vocabulary and its MODE_COLOR
  language exactly.
- **Renderer seam**: `frontend/src/brain/theme.ts` — register
  `avatar: { label, create: createAvatar, legend }`; factory
  `(canvas, opts) => RendererHandle`. Brain.tsx never changes for
  registration; the canvas is already remount-keyed per theme
  (`key={prefs.view}:{showPlatform}`), so a fresh 2D context is guaranteed.
- **Activity bridge**: Brain.tsx forwards `nova:chat-activity` events to
  `renderer.setActivity` (line ~199). **Known gap inherited from the orb**:
  ChatPanel does not yet dispatch these events (ROADMAP #7's other half),
  so thinking/working/listening only fire from manual dispatches today.
  Not this plan's job to fix; verify those states the way the orb sessions
  did — dispatch the events from the console.
- **Settings**: `backend/app/settings_store.py` line ~78 — `brain.view`
  enum options must gain `"avatar"`. Checkpoint: confirm the seed actually
  refreshes options for an existing row (if it's insert-only, the Settings
  dropdown won't show the new theme until that's handled).

## The asset kit (phase 0 — needs Jeremy + Midjourney)

Everything derives from ONE base render so all variants stay pixel-aligned.
Use Midjourney **Vary (Region)** on the source render, touching ONLY the
named region each time:

| Asset | Region varied | Direction |
|---|---|---|
| `base` | mouth | lips gently CLOSED (current render is slightly open), calm |
| `mouth-small` | mouth | lips just parted |
| `mouth-open` | mouth | relaxed open "ah" — conversational, never a shout |
| `mouth-round` | mouth | rounded "oh/oo" |
| `eyes-closed` | eyes | lids closed — a blink frame, serene not asleep |

Export each at max resolution, PNG, into
`frontend/public/mockups/avatar/` (gitignored raw sources — save every
iteration, never overwrite).

**Prompting lesson (2026-07-19, hit in practice):** region prompts must be
short and purely visual (`lips slightly parted`, `eyes gently closed,
serene`). Never mention animation, frames, lip-sync, scripts, or
workflows — Midjourney refused a prompt that included this plan's
workflow language ("frame-by-frame", "pixel-diffs", "kit script").
Describe the picture, not the purpose. Always vary from the SAME base
render (never chain edit-on-edit — drift accumulates); each Vary (Region)
returns four candidates — keep the one where nothing outside the brushed
region moved. The editor also works on uploaded images if the original
job is gone.

Then a small kit script (realized as `frontend/scripts/avatar_kit.py` —
python/PIL, same venv as generation — not the originally-sketched
avatar-kit.mjs) that:

1. Pixel-diffs each variant against `base`; reports drift OUTSIDE the
   expected region. **Go/no-go**: <2% stray-pixel drift. Fallbacks, in
   preference order: (a) local inpainting (SD-inpaint via diffusers,
   dockerized, on Jeremy's GPU) — masks are exact so out-of-mask pixels
   are byte-identical and the gate passes by construction; (b) the
   procedural mouth — glow-line lips drawn in the wireframe style, which
   may suit this aesthetic anyway; (c) manual compositing in an editor.
   Note 2026-07-19: Midjourney's chat-fronted interfaces refused even
   clean region prompts once an animation-workflow request was in the
   thread history — use a fresh session or the Editor's region prompt box
   directly, or skip to fallback (a).
2. Crops each variant to its changed bounding box (+ margin), generates a
   feathered alpha mask, and emits webp assets plus a
   `manifest.json` ({ region bboxes, plate dimensions }) into
   `frontend/src/assets/avatar/` (committed, vite-bundled; target total
   well under ~500 KB).

## Architecture

`frontend/src/brain/avatar.ts`, canvas-2D like the orb (no WebGL — avoids
the entire context/dispose trap family; the look is compositing, not
geometry). Per frame:

1. Background: deep blue field + slow nebula pulse (reuse the orb's
   'lighter' vocabulary), faint drifting motes.
2. The plate (base figure), with a slow breathing transform (~1 px-scale
   sinus at the orb's 2.6 s cadence) and overall luminosity following mode
   energy.
3. Mouth crop composited over the mouth bbox through its feathered mask —
   crossfade between visemes over ~60–80 ms, never a hard swap.
4. Blink: base→eyes-closed→base crossfade, ~70 ms each way, scheduled every
   2–6 s (deterministic PRNG, mulberry32 like the orb), occasional double
   blink.
5. Filament shimmer: at load, threshold the plate offscreen to a
   bright-pixel mask; animate a few traveling glints along it (subtle;
   quickens with mode energy).
6. Mode tinting: reuse the orb's MODE_COLOR/MODE_ENERGY blend — tint the
   aura/shimmer/motes, NOT the face (a violet-faced Nova reads wrong;
   the figure stays blue, the atmosphere carries the state).
7. Name label + state word, same rules as the orb (labelMode/labelScale).

**Mouth driving** (the actual lip-sync):

- Poll `speaker.level()` per frame through an attack/release envelope
  (attack ~40 ms, release ~140 ms — fast to open, gentle to close).
- Map envelope → viseme (rest / small / open) via thresholds WITH
  hysteresis; crossfade on change. Tune until the verification line passes:
  reads as talking, no flicker.
- Phase 3 adds round-vs-open discrimination: extend `Speaker` with a
  `bands()` (or spectral-centroid) method off the existing AnalyserNode —
  low centroid + moderate level → `mouth-round`. Amplitude-only first;
  it is more convincing than it sounds.
- Mic/listening does NOT route through the analyser — listening state
  comes from `setActivity`, exactly like the orb.

**RendererHandle contract**: `setData` (name from the core node only),
`resize`, `configure` (rotationSpeed→ambient pace, labelMode, labelScale),
`setActivity` (orb semantics), `destroy` (cancel rAF, remove listeners),
click on the figure → `onNodeClick('soul.md')` (orb/galaxy precedent).

## Phases

### Phase 0 — asset kit + registration tooling

Jeremy produces the Vary (Region) set (table above). Session builds
`avatar-kit.mjs`, runs the alignment go/no-go, emits committed webp assets +
manifest. If misaligned, decide fallback (manual composite vs procedural
mouth) WITH Jeremy before any theme code.

**Verify**: assets + manifest exist under `frontend/src/assets/avatar/`;
diff report shows <2% out-of-region drift for every variant; raw sources
preserved in mockups/avatar/.

**PHASE 0 DONE 2026-07-19** — via fallback (a), and the fallback is now
the canonical pipeline. What happened: Midjourney's Vary (Region) route
produced image-ref re-generations (multi-head collages, character drift —
see mockups/avatar/contact-sheet-2026-07-19.png), so visemes were
generated locally instead: `frontend/scripts/avatar_gen.py` (Dreamshaper-8
inpainting via diffusers on the RTX 3090; the SD2-inpainting repo is
gated on HF now) + `frontend/scripts/avatar_kit.py` (gate + crop + webp).
Base plate = 2x lanczos upscale of the 424px concept still (848x842; the
full-res original doesn't exist — the still is a video frame). Shipped
kit: `frontend/src/assets/avatar/` — plate.webp + 4 alpha-baked crops +
manifest.json, 197 KB total, alignment gate = 0 stray pixels outside
masks for all five frames (byte-identical by construction). Picked seeds
pinned in avatar_kit.PICKS; all 26 candidates + review sheets + the
6-state composite proof (kit-states-strip.png) preserved in
mockups/avatar/. Style note for phase 2/3: mouth brightness ramps with
openness (subtle engraved lips closed → glowing interior open) — treat
as a feature, it reads as voice energy — but see the review outcome:
Jeremy capped it. **Jeremy reviewed 2026-07-19** and vetoed two frames;
both regenerated with steering negatives and swapped in (v2 kit, gate
still 0): mouth-open lost its neon rim (soft dark opening — the "voice
energy brightness ramp" now peaks at subtle, keep it that way) and
eyes-closed got opaque matte lids (no iris ghosting through). Final
prompts live in avatar_gen.py; picks in avatar_kit.PICKS; proof strip
kit-states-strip-v2.png. **Interactive preview** (also the phase-2
tuning sandbox — envelope, hysteresis, crossfade, blink scheduler all
live there): `:5173/mockups/avatar/kit-preview.html` (assets copied to
mockups/avatar/kit/ — re-copy after any avatar_kit.py re-run). Preview
lesson for phase 1, SUPERSEDED by the shelve review: Jeremy wants the
natural full-figure framing, NOT a closer camera — subtle mouth motion
at distance is acceptable; bad motion up close is not.

### Phase 1 — the figure stands

Register the `avatar` theme (+ `brain.view` enum option, + settings seed
checkpoint). Load plate + manifest (async — render a dim placeholder
shimmer until ready). Background, breathing, luminosity, motes, name label,
click→soul. Extract the orb's mode state machine into a small shared module
(`frontend/src/brain/presence.ts`) consumed by both nova.ts and avatar.ts —
flag if the orb refactor gets invasive; copying is the fallback.

**Verify at :5173**: Avatar appears in the picker and Settings enum; figure
renders breathing over the animated field; theme-switch round-trip
(Avatar → Nova → Universe → Graph → Avatar) with no blank canvas or console
errors; click on the figure opens the soul card.

### Phase 2 — she blinks, she speaks

Blink scheduler. Amplitude-driven mouth: envelope, thresholds + hysteresis,
viseme crossfades, speaking-mode glow following `speaker.level()` (the
orb's lvlS recipe).

**Verify at :5173 with the kokoro profile up**: send a real chat message
with voice enabled — the mouth moves WITH her voice and closes when she
finishes; pause/resume freezes/resumes the face; cancel closes the mouth
promptly; blinks look natural at idle; no flicker between visemes.

### Phase 3 — expression and state language

`Speaker.bands()`; round-vs-open visemes. Filament shimmer glints. Mode
tinting (atmosphere, not face) + listening/thinking/working treatments in
the orb's color language. Optional micro head-sway (≤1–2 px parallax of
plate vs background — subtle or not at all).

**Verify at :5173**: all five states distinguishable (dispatch
`nova:chat-activity` from the console for thinking/working/listening, per
the orb precedent); an "oh"-heavy sentence visibly rounds the mouth;
nothing reads as menacing — the tone guardrails hold.

### Phase 4 — presence behavior + phone path

The entity-view dissolve, realized: sample ~3–5k bright plate pixels as
particle targets; ACTIVE → FADING (~5 s after last activity, figure dims)
→ DISSOLVED (~15 s, plate fades out as particles drift into an ambient
wisp — never fully gone); any activity condenses back in ~1 s. Perf
guards: pause rAF when `document.hidden`, cap devicePixelRatio at 2.
Phone path: `docker compose build web && docker compose up -d web`, verify
on :8080 (baked-build trap).

**Verify at :5173 and :8080**: leave it idle — she disperses into a wisp;
send a message — she condenses and answers; the cycle repeats cleanly; no
rAF running in a hidden tab.

### Phase 5 — DEFERRED: neural photoreal option (decision gate)

Only if Jeremy, after living with the hologram, wants the literal
Midjourney render photorealistically talking: MuseTalk as an optional
compose profile (like ollama/kokoro — local, GPU-gated, no keys), fed by
the same Kokoro audio, streamed to the frontend. Do not build, spec, or
scaffold any of this without an explicit go.

## Verifying visually (for implementing sessions)

Screenshot recipe: dockerized chromium against :5173 (node:alpine +
playwright-core + chromium/swiftshader — see auto-memory / universe-view
plan; `--virtual-time-budget` breaks rAF, use real waits). Audio states
can't be screenshotted honestly — verify the mouth against real Kokoro
playback by ear+eye, and drive non-audio states via console-dispatched
`nova:chat-activity` events. A dev-only `window.novaAvatar = { debugLevel }`
override (set a fake 0..1 level) is acceptable for deterministic
screenshots; keep it out of the legend/UI.

## Flagged decisions (defaults chosen, not locked)

- Theme key/label `avatar` / "Avatar" — Jeremy may prefer another name (the
  orb holds "Nova"); trivially renameable at registration.
- Canvas-2D compositing over WebGL (no geometry to justify a context).
- Four visemes (rest/small/open/round) — enough for a stylized face; more
  granularity only via the phase-5 gate.
- Assets committed as webp under `frontend/src/assets/avatar/`; raw
  Midjourney sources stay gitignored in mockups/avatar/.
- `presence.ts` extraction (shared orb/avatar state machine) — copy instead
  if the refactor fights back.
- Idle-dissolve carried from the 2026-07-14 entity-view design (ROADMAP
  item 2) with its ~5 s / ~15 s timings — retune freely with Jeremy's eyes
  on it.
