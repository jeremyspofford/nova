/** Sentence-buffered speech — Nova speaks while the reply still streams.
 *
 * Phase 1 of docs/plans/voice.md. ChatPanel feeds SSE text deltas into
 * `speaker`; complete sentences synthesize via /api/v1/voice/tts (at most
 * two fetches in flight) and play strictly in order through Web Audio.
 *
 * Controls: pause()/resume() (suspend the audio clock — step away mid-
 * reply), cancel() (interrupt, drop the rest). `onChange` reports
 * {speaking, paused} so the UI can show the right controls.
 *
 * `speaker.level()` exposes live output amplitude (0..1) — the energy
 * input the entity view will consume later (also on window.novaVoice).
 */

import { synthesizeSpeech } from '../api';

const MAX_BUFFER = 220;          // flush unpunctuated ramble at this length
const MAX_INFLIGHT = 2;          // bounded pipeline: cheap to barge in on
const LIST_GAP = 0.35;           // seconds of breath before a list item

// ── number/symbol normalization: kokoro reads "10,000" digit-by-digit and
//    narrates bare symbols; convert to how a person would say them ──────────
const ONES = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven',
  'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen',
  'sixteen', 'seventeen', 'eighteen', 'nineteen'];
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy',
  'eighty', 'ninety'];
const SCALES = ['', ' thousand', ' million', ' billion', ' trillion'];

function under1000(n: number): string {
  let s = '';
  if (n >= 100) { s += ONES[Math.floor(n / 100)] + ' hundred'; n %= 100; if (n) s += ' '; }
  if (n >= 20) { s += TENS[Math.floor(n / 10)]; n %= 10; if (n) s += '-' + ONES[n]; }
  else if (n > 0) s += ONES[n];
  return s;
}

function intToWords(n: number): string {
  if (n === 0) return 'zero';
  if (n > 999_999_999_999) return String(n);   // beyond our scale — leave it
  const groups: string[] = [];
  let scale = 0;
  while (n > 0 && scale < SCALES.length) {
    const g = n % 1000;
    if (g) groups.unshift(under1000(g) + SCALES[scale]);
    n = Math.floor(n / 1000);
    scale++;
  }
  return groups.join(' ');
}

// a 1–4 word list item (letters/digits, inner hyphen/apostrophe)
const ITEM = "[A-Za-z0-9][A-Za-z0-9'’-]*(?:\\s+[A-Za-z0-9][A-Za-z0-9'’-]*){0,3}";
// a run of 3+ comma-separated items ending a clause, no existing conjunction
const SERIES = new RegExp(`((?:${ITEM}),\\s+(?:${ITEM},\\s+)+)(${ITEM})(?=[.!?;:]|$)`, 'g');

/** "red, green, blue" -> "red, green, and blue" — how a person reads a
 *  series aloud. Only fires on 3+ short items; leaves pairs, existing
 *  and/or, and long clauses alone (see the test matrix in the commit). */
function addSeriesAnd(text: string): string {
  return text.replace(SERIES, (m, head: string, last: string) =>
    /^(and|or|nor)\b/i.test(last) ? m : `${head}and ${last}`);
}

export function normalizeForSpeech(text: string): string {
  return addSeriesAnd(text
    // symbols first: "%"/"&" need the adjacent digit before the number rules
    // rewrite it (e.g. "99.5%" -> percent, then the decimal becomes words)
    .replace(/(\d)\s*%/g, '$1 percent')
    .replace(/\s*&\s*/g, ' and ')
    // comma-grouped integers: 10,000 / 1,234,567 -> words (the main complaint)
    .replace(/\b\d{1,3}(?:,\d{3})+\b/g, m => intToWords(parseInt(m.replace(/,/g, ''), 10)))
    // decimals: 3.5 -> "three point five" (fraction read as digits)
    .replace(/\b(\d+)\.(\d+)\b/g, (_, i: string, f: string) =>
      `${intToWords(parseInt(i, 10))} point ${[...f].map(d => ONES[+d]).join(' ')}`));
}

/** Markdown reads terribly aloud — strip it; code is summarized. Emojis are
 *  dropped (the phonemizer would narrate them); numbers/symbols normalized. */
export function stripForSpeech(md: string): string {
  const stripped = md
    .replace(/[\p{Extended_Pictographic}\u{FE0F}\u{200D}\u{20E3}\u{1F3FB}-\u{1F3FF}\u{1F1E6}-\u{1F1FF}]/gu, '')
    .replace(/```[\s\S]*?```/g, ' Code omitted. ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/(\*{1,3}|_{1,3}|~~)([^*_~]+)\1/g, '$2')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/^\s*\d+[.)]\s+/gm, '')
    .replace(/\s+/g, ' ')
    .trim();
  return normalizeForSpeech(stripped);
}

const isListItem = (raw: string) => /^\s*(?:[-*+]|\d+[.)])\s+/.test(raw);

interface Chunk { text: string; gap: number }

class Speaker {
  enabled = false;
  paused = false;
  onChange?: (s: { speaking: boolean; paused: boolean }) => void;

  private ctx: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private levelBuf: Float32Array<ArrayBuffer> | null = null;

  private textBuffer = '';
  private pending: Chunk[] = [];
  private listItems: string[] = [];   // buffered contiguous bullet/numbered items
  private inflight = 0;

  private seqNext = 0;             // next chunk number to hand to a fetch
  private seqToPlay = 0;           // next chunk number allowed to play
  private decoded = new Map<number, AudioBuffer>();
  private gapBySeq = new Map<number, number>();
  private failed = new Set<number>();
  private current: AudioBufferSourceNode | null = null;
  private generation = 0;          // bump = everything in flight is stale
  private last = { speaking: false, paused: false };

  get speaking(): boolean {
    return !!this.current || this.pending.length > 0 || this.inflight > 0
      || this.decoded.size > 0 || this.listItems.length > 0;
  }

  private emit() {
    const s = { speaking: this.speaking, paused: this.paused };
    if (s.speaking !== this.last.speaking || s.paused !== this.last.paused) {
      this.last = s;
      this.onChange?.(s);
    }
  }

  /** Must be called from a user gesture (autoplay policy). */
  enable() {
    if (!this.ctx) {
      this.ctx = new AudioContext();
      this.analyser = this.ctx.createAnalyser();
      this.analyser.fftSize = 512;
      this.analyser.connect(this.ctx.destination);
      this.levelBuf = new Float32Array(this.analyser.fftSize);
    }
    void this.ctx.resume();
    this.enabled = true;
  }

  disable() {
    this.enabled = false;
    this.cancel();
  }

  /** Halt playback where it is — the audio clock freezes, resume continues. */
  pause() {
    if (this.ctx && !this.paused) {
      void this.ctx.suspend();
      this.paused = true;
      this.emit();
    }
  }

  resume() {
    if (this.ctx && this.paused) {
      void this.ctx.resume();
      this.paused = false;
      this.emit();
    }
  }

  /** Interrupt: stop speaking and drop everything queued or in flight. */
  cancel() {
    this.generation++;
    this.textBuffer = '';
    this.pending = [];
    this.listItems = [];
    this.decoded.clear();
    this.gapBySeq.clear();
    this.failed.clear();
    this.seqNext = 0;
    this.seqToPlay = 0;
    if (this.current) {
      try { this.current.stop(); } catch { /* already ended */ }
      this.current = null;
    }
    // a suspended clock would block the next turn's playback
    if (this.ctx && this.paused) { void this.ctx.resume(); this.paused = false; }
    this.emit();
  }

  /** Feed a streaming text delta; speaks as sentences complete. */
  feed(delta: string) {
    if (!this.enabled) return;
    this.textBuffer += delta;
    this.drain(false);
  }

  /** The stream ended — speak whatever remains. */
  flush() {
    if (!this.enabled) return;
    this.drain(true);
  }

  /** Live output amplitude 0..1 — the entity view's energy input. */
  level(): number {
    if (!this.analyser || !this.levelBuf) return 0;
    this.analyser.getFloatTimeDomainData(this.levelBuf);
    let sum = 0;
    for (let i = 0; i < this.levelBuf.length; i++) sum += this.levelBuf[i] ** 2;
    return Math.min(1, Math.sqrt(sum / this.levelBuf.length) * 4);
  }

  private pushRaw(raw: string) {
    // buffer contiguous list items so we know which one is LAST — a bullet
    // list should read "red … green … and blue", not three loose words
    if (isListItem(raw)) {
      const text = stripForSpeech(raw);
      if (text.length > 1) this.listItems.push(text);
      return;
    }
    this.flushList();               // a non-list line ends any open list
    const text = stripForSpeech(raw);
    if (text.length > 1) this.pending.push({ text, gap: 0 });
  }

  private flushList() {
    const items = this.listItems;
    this.listItems = [];
    if (items.length === 0) return;
    // short items → itemized speech with a pause each; the last gets "and".
    // long/steppy items (sentences) stay as-is — "and <sentence>" reads oddly.
    const allShort = items.every(it => it.split(/\s+/).length <= 4);
    items.forEach((it, i) => {
      const last = i === items.length - 1;
      const text = last && allShort && items.length >= 2 ? `and ${it}` : it;
      this.pending.push({ text, gap: LIST_GAP });
    });
  }

  private drain(force: boolean) {
    // cut complete sentences off the front of the buffer; punctuation only
    // counts when whitespace follows (never split "3.5" mid-stream)
    for (;;) {
      const m = this.textBuffer.match(/[.!?:]["')\]]*\s+|\n+/);
      let cut = -1;
      if (m && m.index !== undefined) cut = m.index + m[0].length;
      else if (this.textBuffer.length > MAX_BUFFER) cut = MAX_BUFFER;
      else break;
      this.pushRaw(this.textBuffer.slice(0, cut));
      this.textBuffer = this.textBuffer.slice(cut);
    }
    if (force && this.textBuffer.trim()) {
      this.pushRaw(this.textBuffer);
      this.textBuffer = '';
    }
    if (force) this.flushList();    // stream ended — emit any trailing list
    this.emit();
    void this.pump();
  }

  private async pump() {
    while (this.inflight < MAX_INFLIGHT && this.pending.length > 0) {
      const chunk = this.pending.shift()!;
      const seq = this.seqNext++;
      const gen = this.generation;
      this.gapBySeq.set(seq, chunk.gap);
      this.inflight++;
      void (async () => {
        try {
          const wav = await synthesizeSpeech(chunk.text);
          if (gen !== this.generation || !this.ctx) return;
          const buf = await this.ctx.decodeAudioData(wav);
          if (gen !== this.generation) return;
          this.decoded.set(seq, buf);
          this.playNext();
        } catch (err) {
          console.warn('[voice] tts failed:', err);
          if (gen === this.generation) {
            this.failed.add(seq);      // playNext skips it — no deadlock
            this.playNext();
          }
        } finally {
          this.inflight--;
          void this.pump();
          this.emit();
        }
      })();
    }
  }

  private playNext() {
    if (this.current || !this.ctx || !this.analyser) return;
    while (this.failed.has(this.seqToPlay)) {
      this.failed.delete(this.seqToPlay);
      this.gapBySeq.delete(this.seqToPlay);
      this.seqToPlay++;
    }
    const buf = this.decoded.get(this.seqToPlay);
    if (!buf) return;
    this.decoded.delete(this.seqToPlay);
    const gap = this.gapBySeq.get(this.seqToPlay) ?? 0;
    this.gapBySeq.delete(this.seqToPlay);
    this.seqToPlay++;
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.connect(this.analyser);
    src.onended = () => {
      this.current = null;
      this.playNext();
      this.emit();
    };
    this.current = src;
    src.start(this.ctx.currentTime + gap);   // gap = silent breath before it
    this.emit();
  }
}

export const speaker = new Speaker();

declare global { interface Window { novaVoice?: { level: () => number } } }
window.novaVoice = { level: () => speaker.level() };
