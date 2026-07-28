/** Mouth shapes derived from the audio that is actually about to play.
 *
 *  Every previous attempt at a speaking face here was driven by a synthetic
 *  syllable generator — a random walk of 90-220ms bursts — and every one was
 *  rejected for the same reason: "the mouth looks terrible when speaking".
 *  Real speech is not a random walk. It has structure, and the structure is
 *  sitting right there in the AudioBuffer that `speech.ts` decodes a whole
 *  network round trip before it plays.
 *
 *  So the track is computed ONCE, offline, per sentence — not sampled per
 *  frame off an AnalyserNode. Three consequences, all of them the point:
 *    - smoothing happens once over the whole utterance, so the mouth cannot
 *      flicker no matter what the frame rate does;
 *    - the renderer can look slightly AHEAD of the playhead, which is what
 *      real mouths do (a lip closes before you hear the /p/);
 *    - the same numbers are readable from a script, so "is the mouth in sync"
 *      is a question with an answer instead of an opinion.
 *
 *  Measured against live Kokoro output at af_heart before any of this was
 *  written: at a 10ms hop an open vowel reads low/high 19.8 with a
 *  zero-crossing rate of 0.017, and the /s/ of "notes" reads 0.22 and 0.73.
 *  Two one-pole filters separate those by two orders of magnitude, which is
 *  all the discrimination a jaw and a pair of lips need.
 */

/** One frame of mouth pose, 0..1 per channel. Not morph values — the view
 *  maps these onto whatever blendshapes its head asset happens to have. */
export interface MouthFrame {
  /** Jaw aperture. Vowels open it, fricatives barely do. */
  open: number;
  /** Lip rounding — /u/, /o/. Low second formant relative to the first. */
  round: number;
  /** Lip spreading — /i/, /e/. High second formant. */
  wide: number;
  /** Lips at rest and together. Rises into silence, so she closes her mouth
   *  between phrases instead of holding the last shape open. */
  close: number;
}

/** A mouth doing nothing.
 *
 *  `close` is ZERO here, and that matters more than it looks. It is an
 *  articulatory GESTURE — lips actively pressed together for a /m/ — not a
 *  resting state. A relaxed mouth already has its lips together and needs no
 *  blendshape at all to say so. Setting close: 1 here meant she wore
 *  mouthClose every moment she was not speaking, which is to say almost
 *  always, and it read as a permanent pout. */
export const MOUTH_REST: MouthFrame = { open: 0, round: 0, wide: 0, close: 0 };

export interface VisemeTrack {
  hopSec: number;
  /** Number of hops — all four channels share this length. */
  length: number;
  open: Float32Array;
  round: Float32Array;
  wide: Float32Array;
  close: Float32Array;
}

const HOP_SEC = 0.010;      // 10ms: finer than a phoneme, coarser than a pitch period

// Band edges chosen for what they discriminate, not for tidiness.
//
// The first cut of this used one low band for "aperture", which was wrong in
// a way you could see: F1 rises with jaw opening (≈300Hz for "ee", ≈750Hz for
// "ah") but BOTH sit inside a single 0-800Hz band, so every voiced sound came
// out equally loud there and the jaw just followed volume. "ee" and "ah"
// opened her mouth by the same amount and the whole performance read as one
// hinge going up and down. Splitting the low band at 430Hz is what separates
// a close vowel from an open one.
const F_JAW = 430;    // below: close vowels and voicing. above: open vowels.
const F_LOW = 800;    // top of F1
const F_MID = 2500;   // top of F2 — above this is sibilance

// Voiced speech carries far more low-band than high-band energy; a fricative
// inverts that. Measured on real Kokoro output: vowels 3-20, fricatives 0.2-0.9.
const VOICED_RATIO = 1.5;

// Asymmetric because mouths are: they snap open and ease shut. Applied over
// the hop series offline, so the per-frame read is a stable lookup.
//
// Attack is fixed — a mouth opens about as fast whatever the tempo.
const ATTACK_MS = 30;
/** Release, as a fraction of the gap between syllables.
 *
 *  This was a hardcoded 110ms, then a hardcoded 65ms, and both were wrong the
 *  moment voice.tts_speed moved: 110 was too slow to close between syllables
 *  at 1.25, and 65 was too fast at 1.0. The lips have to fall in proportion to
 *  how fast she is actually talking, so it is measured from the envelope per
 *  utterance instead of tuned to whatever the setting happened to be that day.
 *  0.27 lands near 65ms at ordinary conversational tempo, which is where
 *  this looked right by eye, and tracks the setting from there. */
const RELEASE_FRACTION = 0.27;
const RELEASE_MIN_MS = 45;
const RELEASE_MAX_MS = 120;
/** Closure is judged against the loudest moment within this fraction of a
 *  syllable period either side — also tempo-relative, for the same reason. */
const CLOSURE_WINDOW_FRACTION = 0.70;
// The shape channels are slower — rounding is a posture, not an event, and
// chattering between round and wide is exactly the "flicker" that got the
// sprite version rejected.
const SHAPE_MS = 60;

/** Envelope percentile used as the reference level. Kokoro's output level
 *  varies per sentence; normalising by a high percentile (not the peak, which
 *  a single plosive can own) keeps a quiet sentence legible without letting a
 *  loud one gape. */
const NORM_PCT = 0.95;

/** Below this fraction of the reference level, treat it as silence. */
const SILENCE = 0.08;

/** Absolute floor on the reference level, about -46 dBFS.
 *
 *  Normalising by a percentile is only safe if the percentile is a real
 *  signal. Given a silent or near-silent buffer the p95 collapses to the
 *  numerical residue of the filters, and dividing by residue amplifies it to
 *  a fully open mouth — she would sit there gaping at nothing. Caught by
 *  feeding the analyser a DC offset, which is exactly what a vocoder glitch
 *  looks like. Anything this quiet is not speech; it is the rest pose. */
const SILENT_REF = 0.005;

const onePoleCoeff = (fc: number, sampleRate: number) =>
  Math.exp(-2 * Math.PI * fc / sampleRate);

/** The analysis core, over raw samples so it can be run outside a browser —
 *  there is no test runner in this frontend, and a lip-sync claim that can
 *  only be checked by looking at it is the claim that failed twice already. */
export function analyseSamples(data: Float32Array, sampleRate: number): VisemeTrack {
  const hop = Math.max(1, Math.round(sampleRate * HOP_SEC));
  const hops = Math.floor(data.length / hop);
  const track: VisemeTrack = {
    hopSec: HOP_SEC,
    length: hops,
    open: new Float32Array(hops),
    round: new Float32Array(hops),
    wide: new Float32Array(hops),
    close: new Float32Array(hops),
  };
  if (hops === 0) return track;

  const aJaw = onePoleCoeff(F_JAW, sampleRate);
  const aLow = onePoleCoeff(F_LOW, sampleRate);
  const aMid = onePoleCoeff(F_MID, sampleRate);

  // Per-hop features, gathered in one pass over the samples.
  const eRms = new Float32Array(hops);
  const eBase = new Float32Array(hops);   // 0..430   close vowels, voicing
  const eOpen = new Float32Array(hops);   // 430..800 open vowels — the jaw
  const eMid2 = new Float32Array(hops);   // 800..2500 F2 — front vs back
  const eHigh = new Float32Array(hops);   // 2500+    sibilance

  let lp0 = 0, lp1 = 0, lp2 = 0;
  // DC blocker: a neural vocoder can leave a small offset, and an offset is
  // pure low-band energy — it would read as a permanently rounded mouth.
  let dcX = 0, dcY = 0;

  for (let h = 0; h < hops; h++) {
    const start = h * hop;
    let sRms = 0, sLow = 0, sOpen = 0, sMid = 0, sHigh = 0;
    for (let i = start; i < start + hop; i++) {
      const raw = data[i];
      dcY = raw - dcX + 0.995 * dcY;
      dcX = raw;
      const x = dcY;

      lp0 += (1 - aJaw) * (x - lp0);
      lp1 += (1 - aLow) * (x - lp1);
      lp2 += (1 - aMid) * (x - lp2);
      const b0 = lp0;             // 0 .. 430Hz
      const b1 = lp1 - lp0;       // 430 .. 800Hz  — F1 of an OPEN vowel
      const b2 = lp2 - lp1;       // 800 .. 2500Hz — F2, front/back
      const b3 = x - lp2;         // 2500Hz ..     — sibilance

      sRms += x * x;
      sLow += b0 * b0;
      sOpen += b1 * b1;
      sMid += b2 * b2;
      sHigh += b3 * b3;
    }
    eRms[h] = Math.sqrt(sRms / hop);
    eBase[h] = Math.sqrt(sLow / hop);
    eOpen[h] = Math.sqrt(sOpen / hop);
    eMid2[h] = Math.sqrt(sMid / hop);
    eHigh[h] = Math.sqrt(sHigh / hop);
  }

  // Reference level: the NORM_PCT percentile of the envelope.
  const sorted = Float32Array.from(eRms).sort();
  const ref = sorted[Math.min(hops - 1, Math.floor(hops * NORM_PCT))];
  if (!(ref > SILENT_REF)) {
    // Silence in, rest pose out — a failed, empty or near-silent synthesis
    // must not leave the mouth hanging open.
    track.close.fill(1);
    return track;
  }

  // ── tempo ─────────────────────────────────────────────────────────────
  // Count syllable onsets: upward crossings of the envelope with hysteresis,
  // so one syllable is one event however lumpy its top is.
  let onsets = 0, armed = true;
  for (let h = 0; h < hops; h++) {
    const v = eRms[h] / ref;
    if (armed && v > 0.38) { onsets++; armed = false; }
    else if (!armed && v < 0.20) armed = true;
  }
  const seconds = hops * HOP_SEC;
  // 4.2/s is ordinary conversational English; used when a clip is too short
  // to measure anything trustworthy.
  const syllablesPerSec = onsets >= 3 && seconds > 0.4 ? onsets / seconds : 4.2;
  const periodMs = 1000 / syllablesPerSec;
  const releaseMs = Math.min(RELEASE_MAX_MS,
    Math.max(RELEASE_MIN_MS, RELEASE_FRACTION * periodMs));
  const WIN = Math.max(4, Math.round(CLOSURE_WINDOW_FRACTION * periodMs / (HOP_SEC * 1000)));

  // Closure detection, against a LOCAL peak rather than an absolute floor.
  // The consonant stops between words are brief dips, not silence — at 8% of
  // the utterance reference they never registered, so the mouth never shut
  // mid-sentence. Comparing each hop to the loudest moment within ~±130ms
  // finds them, and scales automatically with how hard she happens to be
  // talking at that point in the sentence.
  const closure = new Float32Array(hops);
  for (let h = 0; h < hops; h++) {
    let local = 0;
    for (let k = Math.max(0, h - WIN); k <= Math.min(hops - 1, h + WIN); k++) {
      if (eRms[k] > local) local = eRms[k];
    }
    closure[h] = clamp01(1 - eRms[h] / (local * 0.45 + 1e-9));
  }

  const EPS = 1e-6;

  // How far up the F1 range the energy sits, per hop: small for "ee"/"oo",
  // large for "ah". NORMALISED across the utterance, because the raw ratio
  // only ever spans a narrow slice of 0..1 — using it directly scaled every
  // jaw opening down to a barely-parted mouth. Same reasoning as the p95 on
  // loudness: what matters is open RELATIVE TO how open this voice gets.
  const openRaw = new Float32Array(hops);
  for (let h = 0; h < hops; h++) {
    openRaw[h] = eOpen[h] / (eBase[h] + eOpen[h] + EPS);
  }
  const voicedOpen = Array.from(openRaw).filter((_, h) => eRms[h] > ref * SILENCE).sort();
  const openRef = voicedOpen.length
    ? voicedOpen[Math.floor(voicedOpen.length * 0.90)] : 1;
  const openFloor = voicedOpen.length
    ? voicedOpen[Math.floor(voicedOpen.length * 0.10)] : 0;
  const openSpan = Math.max(0.02, openRef - openFloor);

  for (let h = 0; h < hops; h++) {
    const e = Math.min(1, eRms[h] / ref);
    const low = eBase[h] + eOpen[h];
    const voiced = low / (eHigh[h] + EPS);
    const openness = clamp01((openRaw[h] - openFloor) / openSpan);
    const front = eMid2[h] / (low + EPS);

    // Perceptual, not linear: a 0.8 power curve keeps quiet syllables visible
    // without letting loud ones gape. "Talking, not gaping" is a standing note.
    const loud = Math.pow(e, 0.8);
    const voicedGate = voiced > VOICED_RATIO ? 1 : 0.28;
    const shut = closure[h];

    // The jaw follows the VOWEL, not the volume. A loud "ee" barely opens it;
    // that distinction is the whole difference between speech and a hinge.
    // Centred near 1 rather than below it, so this REDISTRIBUTES the opening
    // between vowels instead of quietly halving all of them.
    const aperture = 0.34 + 1.0 * openness;
    track.open[h] = e < SILENCE ? 0
      : clamp01(loud * aperture * voicedGate * (1 - 0.9 * shut));

    // Shape channels only mean anything while she is voicing.
    const shaped = voiced > VOICED_RATIO ? Math.min(1, loud * 1.3) : 0;
    track.wide[h] = shaped * clamp01((front - 0.32) / 0.40) * (1 - shut);
    // Rounding is a CLOSE back vowel — low F2 and a low jaw together. Keyed on
    // F2 alone, "ah" came out rounded, which looks like a permanent pout.
    track.round[h] = shaped * clamp01((0.32 - front) / 0.26)
      * (1 - 0.7 * openness) * (1 - shut);
    // Lips together: at a real closure, and at true silence.
    track.close[h] = Math.max(shut, clamp01((SILENCE - e) / SILENCE));
  }

  smoothAsym(track.open, ATTACK_MS, releaseMs);
  smoothSym(track.round, SHAPE_MS);
  smoothSym(track.wide, SHAPE_MS);
  smoothSym(track.close, SHAPE_MS);
  return track;
}

/** Browser entry point — channel 0 is enough, Kokoro is mono. */
export function buildTrack(buf: AudioBuffer): VisemeTrack {
  return analyseSamples(buf.getChannelData(0), buf.sampleRate);
}

/** Read the mouth at a moment in the utterance. Outside the track — before it
 *  starts (the scheduled silent gap between sentences) or after it ends — she
 *  is at rest, which is how the breath between phrases reads as a breath. */
export function sampleTrack(track: VisemeTrack, tSec: number): MouthFrame {
  if (track.length === 0) return MOUTH_REST;
  const x = tSec / track.hopSec;
  if (x <= 0 || x >= track.length - 1) return MOUTH_REST;
  const i = Math.floor(x);
  const f = x - i;
  return {
    open: lerp(track.open[i], track.open[i + 1], f),
    round: lerp(track.round[i], track.round[i + 1], f),
    wide: lerp(track.wide[i], track.wide[i + 1], f),
    close: lerp(track.close[i], track.close[i + 1], f),
  };
}

function smoothAsym(ch: Float32Array, attackMs: number, releaseMs: number) {
  const dt = HOP_SEC * 1000;
  const kUp = 1 - Math.exp(-dt / attackMs);
  const kDown = 1 - Math.exp(-dt / releaseMs);
  let y = 0;
  for (let i = 0; i < ch.length; i++) {
    const t = ch[i];
    y += (t - y) * (t > y ? kUp : kDown);
    ch[i] = y;
  }
}

function smoothSym(ch: Float32Array, tauMs: number) {
  const k = 1 - Math.exp(-(HOP_SEC * 1000) / tauMs);
  let y = 0;
  for (let i = 0; i < ch.length; i++) {
    y += (ch[i] - y) * k;
    ch[i] = y;
  }
}

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
