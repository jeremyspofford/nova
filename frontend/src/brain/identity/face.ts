/** Everything that makes her read as alive rather than displayed.
 *
 *  This is the file both previous attempts died on, so the constants here
 *  are argued rather than picked:
 *
 *  BLINKS. The shelved 2D lane used a 150ms symmetric blink every 2-6s and
 *  the verdict was that it looked like a twitch. A human blink is 100-400ms,
 *  asymmetric — the lid drops fast and opens slowly — at roughly 15-20 a
 *  minute when idle, dropping while concentrating and rising while speaking.
 *  It is also not a lone event: the brow dips slightly and the lower lid
 *  lifts, and blinks cluster at phrase boundaries and gaze shifts.
 *
 *  GAZE. Continuous eye contact is the single most unsettling thing a face
 *  can do, so she breaks it on a schedule. Eyes lead, the head follows a
 *  fraction — the reverse reads as a doll being turned.
 *
 *  MOUTH. Driven entirely by speaker.mouth(), which is the audio actually
 *  playing. There is no text path and no synthetic syllable generator here;
 *  the last attempt had one and its own post-mortem blamed it.
 */

import * as THREE from 'three';
import { speaker } from '../../voice/speech';
import type { Head, MorphKey } from './head';
import type { Mode } from './mode';

export interface Face {
  update(dt: number, t: number, mode: Mode): void;
  /** Yaw/pitch of the head, so the hair can lag behind it. */
  readonly headTilt: THREE.Vector2;
  /** 0..1 breath phase, so the chest rather than the skull does the rising. */
  readonly breath: number;
  /** 1 present, ~0.78 quietly idle. Never 0 — she stays in the room. */
  readonly presence: number;
  /** Current lid closure 0..1. Exposed so "does she actually blink" is a
   *  measurement rather than a squint at a screenshot. */
  readonly blink: number;
  recentre(): void;
}

type Pose = Partial<Record<MorphKey, number>>;

// ── blink ───────────────────────────────────────────────────────────────
const BLINK_CLOSE = 0.09;    // s — the lid falls fast; this is near the human floor
const BLINK_HOLD = 0.04;     // s — brief, or it reads as a wince
const BLINK_OPEN = 0.19;     // s — opening is roughly twice the closing time
const BLINK_TOTAL = BLINK_CLOSE + BLINK_HOLD + BLINK_OPEN;   // 0.32s
const BLINK_MIN = 4.0;       // s — ~15/min at the top of the range
const BLINK_MAX = 9.0;
const BLINK_DOUBLE_P = 0.12;
const BLINK_DOUBLE_GAP = 0.13;
/** Speaking raises blink rate; concentrating lowers it. Multipliers on the
 *  interval, so smaller is more often. */
const BLINK_RATE: Record<Mode, number> = {
  idle: 1.0, listening: 0.9, thinking: 1.35, working: 1.5, speaking: 0.7,
};
/** Chance of blinking on a detected phrase boundary. Real speakers blink at
 *  clause boundaries far more often than mid-word, and we know exactly where
 *  those are: the scheduled gaps between synthesised sentences. */
const BLINK_AT_PHRASE_P = 0.45;
const PHRASE_SILENCE = 0.15;  // s of closed mouth mid-utterance = a boundary

/** Rest lids sit slightly lowered. A fully open lid reads as a stare. */
const LID_REST = 0.34;

// ── gaze ────────────────────────────────────────────────────────────────
const SACCADE_MIN = 0.8;
const SACCADE_MAX = 3.5;
const SACCADE_SPREAD = THREE.MathUtils.degToRad(6);
const LOOKAWAY_MIN = 8;
const LOOKAWAY_MAX = 15;
const LOOKAWAY_HOLD_MIN = 1.0;
const LOOKAWAY_HOLD_MAX = 2.2;
const LOOKAWAY_ANGLE = THREE.MathUtils.degToRad(17);
/** Eyes move almost instantly (a saccade is 30-80ms); the easing here is
 *  what stops it looking mechanical, not a simulation of eye dynamics. */
const EYE_TAU = 0.055;
/** The head follows the eyes at a fraction, and slowly. */
const HEAD_FOLLOW = 0.32;
const HEAD_TAU = 0.55;

const IDLE_AFTER = 20;       // s of nothing before she settles
const PRESENCE_IDLE = 0.78;

const MOUTH_JAW = 0.52;      // talking, not gaping

export function createFace(head: Head): Face {
  const headTilt = new THREE.Vector2();
  let breath = 0;
  let presence = 1;

  // blink
  let nextBlink = 2 + Math.random() * 3;
  let blinkStart = -1;
  let doubleBlink = false;
  let silenceRun = 0;
  let sinceBlink = 0;

  // gaze
  let nextSaccade = 1;
  let nextLookaway = LOOKAWAY_MIN + Math.random() * (LOOKAWAY_MAX - LOOKAWAY_MIN);
  let lookawayUntil = -1;
  const gazeTarget = new THREE.Vector2();
  const gaze = new THREE.Vector2();
  // Rest attention sits a hair below the lens: dead-level eye contact,
  // held indefinitely, is the single most unsettling thing a face can do.
  const anchor = new THREE.Vector2(0, -0.035);

  // expression blend weights, one per mode — nothing snaps
  const weight: Record<Mode, number> = {
    idle: 1, listening: 0, thinking: 0, working: 0, speaking: 0,
  };

  // fallback mouth envelope, used only if a sentence has no track
  let lastActive = 0;

  // The teeth are a rigid mesh in this scan, so they sit still while the jaw
  // drops and leave a dark slot with a stripe of teeth floating in it. The
  // lower set should travel with the mandible. Moving the NODE, never the
  // geometry — these positions are quantized.
  const teethHome = head.teeth?.position.clone() ?? null;
  const TEETH_DROP = 0.055;

  const baseL = head.eyeL?.quaternion.clone() ?? null;
  const baseR = head.eyeR?.quaternion.clone() ?? null;
  const dq = new THREE.Quaternion();
  const euler = new THREE.Euler();
  const pose: Pose = {};

  let blinkNow = 0;

  return {
    headTilt,
    get breath() { return breath; },
    get presence() { return presence; },
    get blink() { return blinkNow; },
    recentre() {
      gazeTarget.set(0, -0.035); gaze.set(0, -0.035); anchor.set(0, -0.035);
      lookawayUntil = -1;
    },
    update(dt, t, mode) {
      // ── expression blend ──────────────────────────────────────────────
      const k = 1 - Math.exp(-dt / 0.25);
      for (const m of Object.keys(weight) as Mode[]) {
        weight[m] += ((m === mode ? 1 : 0) - weight[m]) * k;
      }

      if (mode !== 'idle') lastActive = t;
      const idleFor = t - lastActive;
      const wantPresence = idleFor > IDLE_AFTER ? PRESENCE_IDLE : 1;
      presence += (wantPresence - presence) * (1 - Math.exp(-dt / 1.6));

      breath = Math.sin(t * 0.72);   // ~13 breaths/min, unhurried

      // ── mouth, from the audio that is actually playing ────────────────
      const mouth = speaker.mouth();

      // ── phrase-boundary blinks ────────────────────────────────────────
      sinceBlink += dt;
      if (speaker.speaking && mouth.open < 0.06) silenceRun += dt;
      else silenceRun = 0;
      if (silenceRun > PHRASE_SILENCE && blinkStart < 0 && sinceBlink > 1.2) {
        silenceRun = 0;
        if (Math.random() < BLINK_AT_PHRASE_P) startBlink(t);
      }

      // ── scheduled blinks ──────────────────────────────────────────────
      if (blinkStart < 0 && t > nextBlink) startBlink(t);
      let blink = 0;
      if (blinkStart >= 0) {
        const phase = t - blinkStart;
        blink = blinkCurve(phase);
        const done = doubleBlink
          ? phase > BLINK_TOTAL + BLINK_DOUBLE_GAP + BLINK_TOTAL
          : phase > BLINK_TOTAL;
        if (doubleBlink && phase > BLINK_TOTAL + BLINK_DOUBLE_GAP) {
          blink = blinkCurve(phase - BLINK_TOTAL - BLINK_DOUBLE_GAP);
        }
        if (done) {
          blinkStart = -1;
          nextBlink = t + (BLINK_MIN + Math.random() * (BLINK_MAX - BLINK_MIN)) * BLINK_RATE[mode];
        }
      }

      // ── gaze ──────────────────────────────────────────────────────────
      if (t > nextLookaway && lookawayUntil < 0) {
        // Looking away is what stops a stare. Down-and-aside reads as
        // thought; up-and-aside reads as recall. Never straight up.
        const side = Math.random() < 0.5 ? -1 : 1;
        anchor.set(side * LOOKAWAY_ANGLE, -LOOKAWAY_ANGLE * (0.3 + Math.random() * 0.5));
        lookawayUntil = t + LOOKAWAY_HOLD_MIN + Math.random() * (LOOKAWAY_HOLD_MAX - LOOKAWAY_HOLD_MIN);
        // a gaze shift almost always carries a blink
        if (blinkStart < 0) startBlink(t);
      }
      if (lookawayUntil > 0 && t > lookawayUntil) {
        anchor.set(0, -0.035);
        lookawayUntil = -1;
        nextLookaway = t + LOOKAWAY_MIN + Math.random() * (LOOKAWAY_MAX - LOOKAWAY_MIN);
      }
      // Thinking drifts off on its own — that is what thinking looks like.
      if (mode === 'thinking' && lookawayUntil < 0) {
        anchor.set(THREE.MathUtils.degToRad(9), THREE.MathUtils.degToRad(7));
      }
      if (t > nextSaccade) {
        gazeTarget.set(
          anchor.x + (Math.random() - 0.5) * SACCADE_SPREAD,
          anchor.y + (Math.random() - 0.5) * SACCADE_SPREAD * 0.6,
        );
        nextSaccade = t + SACCADE_MIN + Math.random() * (SACCADE_MAX - SACCADE_MIN);
      }
      // Her gaze is her own. Following the cursor reads as being watched
      // rather than being with someone, and it is at its worst exactly when
      // the pointer is low and she is looking down at it.
      const ke = 1 - Math.exp(-dt / EYE_TAU);
      gaze.x += (gazeTarget.x - gaze.x) * ke;
      gaze.y += (gazeTarget.y - gaze.y) * ke;

      // head follows the eyes, late and partially
      const kh = 1 - Math.exp(-dt / HEAD_TAU);
      const tiltTargetX = gaze.x * HEAD_FOLLOW + Math.sin(t * 0.23) * 0.012;
      const tiltTargetY = gaze.y * HEAD_FOLLOW * 0.7 + Math.sin(t * 0.31) * 0.008;
      headTilt.x += (tiltTargetX - headTilt.x) * kh;
      headTilt.y += (tiltTargetY - headTilt.y) * kh;
      // listening earns a small head tilt — the universal "go on" signal
      const roll = weight.listening * 0.045;
      head.root.rotation.set(-headTilt.y, headTilt.x, roll);

      // eyeballs, via the asset's own pivot groups
      if (head.eyeL && baseL) {
        euler.set(-gaze.y, gaze.x, 0);
        head.eyeL.quaternion.copy(baseL).multiply(dq.setFromEuler(euler));
      }
      if (head.eyeR && baseR) {
        euler.set(-gaze.y, gaze.x, 0);
        head.eyeR.quaternion.copy(baseR).multiply(dq.setFromEuler(euler));
      }

      // ── build the pose ────────────────────────────────────────────────
      for (const key of Object.keys(pose) as MorphKey[]) pose[key] = 0;

      // resting warmth: a small asymmetric smile reads as a person at ease,
      // a flat mouth reads as a mannequin
      add(pose, 'smileL', 0.10); add(pose, 'smileR', 0.13);
      add(pose, 'cheekSquintL', 0.05); add(pose, 'cheekSquintR', 0.06);
      // a touch of squint at rest: wide-open eyes on a still face is a stare
      add(pose, 'squintL', 0.09); add(pose, 'squintR', 0.09);
      add(pose, 'browInner', 0.05);
      // idle micro-drift on incommensurate periods so rest is never frozen
      add(pose, 'browInner', 0.03 * (0.5 + 0.5 * Math.sin(t * 0.17)));
      add(pose, 'smileR', 0.03 * (0.5 + 0.5 * Math.sin(t * 0.11)));
      add(pose, 'squintL', 0.02 * (0.5 + 0.5 * Math.sin(t * 0.13)));

      add(pose, 'browInner', 0.20 * weight.listening);
      add(pose, 'browOuterL', 0.10 * weight.listening);
      add(pose, 'browOuterR', 0.10 * weight.listening);
      add(pose, 'wideL', 0.06 * weight.listening);
      add(pose, 'wideR', 0.06 * weight.listening);

      add(pose, 'browDownL', 0.10 * weight.thinking);
      add(pose, 'browDownR', 0.08 * weight.thinking);
      add(pose, 'squintL', 0.10 * weight.thinking);
      add(pose, 'squintR', 0.10 * weight.thinking);

      add(pose, 'browDownL', 0.14 * weight.working);
      add(pose, 'browDownR', 0.14 * weight.working);
      add(pose, 'squintL', 0.14 * weight.working);
      add(pose, 'squintR', 0.14 * weight.working);
      add(pose, 'pressL', 0.10 * weight.working);
      add(pose, 'pressR', 0.10 * weight.working);

      // ── visemes ───────────────────────────────────────────────────────
      // Expression owns the brows, cheeks and lids; the mouth aperture is
      // the visemes' alone, and on the one shared channel (smile) expression
      // is a floor the visemes add to. That is the whole conflict, resolved.
      add(pose, 'jawOpen', mouth.open * MOUTH_JAW);
      // The shape channels were scaled so weakly (~0.2 effective) that they
      // were invisible under the jaw, which is why it all read as one
      // repeated movement. They are the difference between vowels.
      // Lip SHAPE only applies to lips that are apart. The shape channels are
      // smoothed with a 60ms constant, so at the end of a word they are still
      // decaying while the closure is already arriving — and funnel (which
      // pushes both lips forward into an "oh") landing on top of a closing
      // mouth is a pout on the lower lip. Gating here rather than in the
      // analysis makes it immediate, with no smoothing lag to outlive.
      const apart = 1 - clamp01(mouth.close);
      add(pose, 'funnel', mouth.round * 0.60 * apart);
      add(pose, 'pucker', mouth.round * 0.24 * apart);
      add(pose, 'stretchL', mouth.wide * 0.58 * apart);
      add(pose, 'stretchR', mouth.wide * 0.58 * apart);
      add(pose, 'smileL', mouth.wide * 0.16);
      add(pose, 'smileR', mouth.wide * 0.16);
      add(pose, 'lowerDownL', mouth.open * 0.20);
      add(pose, 'lowerDownR', mouth.open * 0.20);
      add(pose, 'upperUpL', mouth.open * 0.12);
      add(pose, 'upperUpR', mouth.open * 0.12);
      // Lips meeting between words. Modest, and mouthClose ONLY — press
      // compresses the lips inward on top of it, and the two together are an
      // underbite. Nothing here fires at rest: MOUTH_REST.close is 0.
      add(pose, 'mouthClose', mouth.close * 0.20);
      // brows lift a little with vocal effort — speech is a whole face
      add(pose, 'browInner', mouth.open * 0.10);

      // ── lids ──────────────────────────────────────────────────────────
      // Rest lowers them slightly; a blink still reaches fully closed. A
      // blink is geometry closing over the eye, never a fade — the eyes
      // showing through the lids is the exact defect that shelved the last
      // attempt, and it cannot happen to a morph target.
      blinkNow = blink;
      const lid = LID_REST + (1 - LID_REST) * blink;
      set(pose, 'blinkL', lid);
      set(pose, 'blinkR', lid);
      // the micro-motions a real blink carries
      add(pose, 'browDownL', blink * 0.10);
      add(pose, 'browDownR', blink * 0.10);
      add(pose, 'squintL', blink * 0.12);
      add(pose, 'squintR', blink * 0.12);

      if (head.teeth && teethHome) {
        head.teeth.position.y = teethHome.y - mouth.open * TEETH_DROP;
      }

      // ── commit ────────────────────────────────────────────────────────
      head.clear();
      for (const [key, v] of Object.entries(pose) as [MorphKey, number][]) {
        head.set(key, Math.min(1, Math.max(0, v)));
      }
    },
  };

  function startBlink(t: number) {
    blinkStart = t;
    doubleBlink = Math.random() < BLINK_DOUBLE_P;
    sinceBlink = 0;
  }
}

/** Fast down, brief hold, slower up. The asymmetry is the whole point: a
 *  symmetric blink is what read as a twitch last time. */
function blinkCurve(phase: number): number {
  if (phase < 0) return 0;
  if (phase < BLINK_CLOSE) return Math.pow(phase / BLINK_CLOSE, 0.75);
  if (phase < BLINK_CLOSE + BLINK_HOLD) return 1;
  const o = (phase - BLINK_CLOSE - BLINK_HOLD) / BLINK_OPEN;
  return o >= 1 ? 0 : 1 - smootherstep(o);
}

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

const smootherstep = (x: number) => x * x * x * (x * (x * 6 - 15) + 10);


function add(p: Pose, key: MorphKey, v: number) {
  p[key] = (p[key] ?? 0) + v;
}
function set(p: Pose, key: MorphKey, v: number) {
  p[key] = v;
}
