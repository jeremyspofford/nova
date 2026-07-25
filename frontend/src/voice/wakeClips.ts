/** Labelled wake clips — the browser half of phase 5a.
 *
 * The wake detector produces audio for every attempt; this module decides
 * which of those attempts are worth keeping, and what they mean. A clip with
 * no label teaches nothing, so nothing is uploaded until the outcome is
 * known:
 *
 *   positive    it fired and a real turn followed
 *   false_fire  it fired and the arm timed out — nobody was talking to her
 *   near_miss   it did NOT fire, scored in the shadow band, and within
 *               NEAR_WINDOW_MS you fired it again or gave up and tapped the
 *               mic. That sequence is the data form of "I had to say it
 *               three times", which is the entire reason this exists.
 *
 * The pending state lives here rather than in ChatPanel because the outcome
 * arrives one or two callbacks later than the audio, and a component that
 * re-renders is the wrong place to hold three seconds of a child's voice.
 * Nothing is retained beyond the decision: an unresolved fire is dropped,
 * and turning learning off clears everything held.
 */

import { uploadWakeClip } from '../api';
import type { WakeCapture } from './wake';

/** A near-miss only counts if you tried again soon after — that pairing is
 *  what makes it evidence rather than noise. */
const NEAR_WINDOW_MS = 10_000;
/** Below this fraction of the threshold a "near miss" is just a room sound. */
const SHADOW_FLOOR = 0.35;
/** Never hold more than a couple of candidates: this is audio. */
const MAX_CANDIDATES = 2;

interface Pending { at: number; cap: WakeCapture }

let enabled = false;
let phrase = '';
let mic = 'browser';
let pendingFire: Pending | null = null;
let candidates: Pending[] = [];

export function setWakeLearning(on: boolean, opts?: { phrase?: string; mic?: string }): void {
  enabled = on;
  if (opts?.phrase) phrase = opts.phrase;
  if (opts?.mic) mic = opts.mic;
  if (!on) { pendingFire = null; candidates = []; }
}

/** float32 mono @16 kHz -> a 16-bit PCM WAV blob (what the trainer reads). */
export function encodeWav(samples: Float32Array, sampleRate = 16000): Blob {
  const buf = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buf);
  const str = (off: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i));
  };
  str(0, 'RIFF');
  view.setUint32(4, 36 + samples.length * 2, true);
  str(8, 'WAVEfmt ');
  view.setUint32(16, 16, true);          // PCM header size
  view.setUint16(20, 1, true);           // format = PCM
  view.setUint16(22, 1, true);           // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);           // block align
  view.setUint16(34, 16, true);          // bits per sample
  str(36, 'data');
  view.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Blob([buf], { type: 'audio/wav' });
}

function send(label: string, p: Pending, speaker?: string): void {
  // fire-and-forget: a failed upload must never surface as a chat error or
  // delay a turn. The clip is evidence, not the conversation.
  void uploadWakeClip(label, encodeWav(p.cap.audio), {
    score: p.cap.score, threshold: p.cap.threshold, phrase, mic,
    speaker: speaker ?? '', secs: p.cap.audio.length / 16000,
  }).catch(() => { /* learning is best-effort by design */ });
}

/** Every closed peak from the detector arrives here. */
export function onWakeCapture(cap: WakeCapture): void {
  if (!enabled) return;
  const p = { at: Date.now(), cap };
  if (cap.kind === 'fire') {
    // promote a recent near-miss: it fired NOW, so the attempt just before it
    // was the same person saying the same phrase and being ignored
    const recent = candidates.filter(c => p.at - c.at <= NEAR_WINDOW_MS);
    if (recent.length) send('near_miss', recent[recent.length - 1]);
    candidates = [];
    pendingFire = p;          // label decided by what the turn does next
    return;
  }
  if (cap.score >= cap.threshold * SHADOW_FLOOR) {
    candidates = [...candidates, p].slice(-MAX_CANDIDATES);
  }
}

/** The wake fire resolved: a turn was captured, or the arm timed out. */
export function resolveWakeFire(captured: boolean, speaker?: string): void {
  const p = pendingFire;
  pendingFire = null;
  if (!enabled || !p) return;
  send(captured ? 'positive' : 'false_fire', p, speaker);
}

/** The operator gave up on the wake word and tapped the mic — the same
 *  "it didn't hear me" signal as trying again, and the more honest one. */
export function wakeGaveUp(): void {
  if (!enabled) return;
  const now = Date.now();
  const recent = candidates.filter(c => now - c.at <= NEAR_WINDOW_MS);
  if (recent.length) send('near_miss', recent[recent.length - 1]);
  candidates = [];
}
