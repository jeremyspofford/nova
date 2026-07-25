/** Wake word ("hey Jarvis" stand-in, "Nova" later) — on-device, in-browser.
 *
 * Phase 4a of docs/plans/voice.md. openWakeWord's pipeline ported to
 * onnxruntime-web and run entirely in the browser: continuous mic audio →
 * melspectrogram → speech embedding → wake classifier. Continuous audio
 * NEVER leaves the device — only after the wake word fires does the app
 * hand off to the VAD/transcribe path. All models self-hosted under /wake/;
 * the ORT runtime wasm is the same one phase 3 self-hosts at /vad/.
 *
 * The pipeline (chunk sizes, the /10+2 mel transform, the ones/silence
 * buffer pre-fill) mirrors openWakeWord exactly — verified numerically
 * against its Python reference to zero per-chunk error. Dynamically
 * imported so ORT + models stay out of the main bundle.
 */

// the lean wasm-only entry (NOT 'onnxruntime-web', which bundles a 26 MB
// WebGPU build) — same subpath vad-web loads, sharing one ORT runtime
import * as ort from 'onnxruntime-web/wasm';
import { WAKE_CATALOG, DEFAULT_WAKE } from './wakeCatalog';
import { recordWakeEvent } from './wakeLog';
import { micBroker } from './micBroker';

ort.env.wasm.wasmPaths = '/vad/';   // reuse the self-hosted ORT wasm from phase 3
ort.env.wasm.numThreads = 1;        // single-thread SIMD — no COOP/COEP needed

const CHUNK = 1280;      // 80 ms @ 16 kHz — one wake step
const RAW_MAX = 1760;    // melspec window: chunk + 480-sample lead-in
const BINS = 32;         // mel features
const MEL_WIN = 76;      // embedding input frames
const EMB_WIN = 16;      // wake model input embeddings
const MEL_MAX = 200;     // rolling mel-frame cap

// Shadow logging (ROADMAP #11b): a "peak" is one attempt at the phrase, not one
// chunk. It opens when the score crosses PEAK_FLOOR, tracks its max, and closes
// once the score has stayed below the floor for PEAK_QUIET_MS. Peaks that never
// reached the threshold are the near-misses worth knowing about.
const PEAK_FLOOR = 0.02;
const PEAK_QUIET_MS = 700;

// Phase 5a: a short rolling window of what the mic just heard, so a wake
// attempt that turns out to be worth learning from has audio to learn from.
// It is a RING that is overwritten continuously and never written to disk on
// its own — a clip only leaves this module when something labels it, and
// only when the operator has turned learning on.
const RING_SECS = 3;
const RING_SR = 16000;

export interface WakeCapture {
  kind: 'fire' | 'near';
  score: number;
  threshold: number;
  audio: Float32Array;      // ~3 s ending at the moment of the peak
}

export interface WakeOptions {
  model?: string;            // wake-phrase key (see wakeCatalog); default hey_jarvis
  threshold?: number;        // 0..1 detection threshold (tune live)
  onWake: () => void;
  /** voice.wake_learning. Off means no ring is even allocated. */
  capture?: boolean;
  onCapture?: (c: WakeCapture) => void;
  /** voice.wake_mic_processing, stamped onto logged scores (phase 5b). */
  mic?: string;
}

export class WakeWord {
  private mel!: ort.InferenceSession;
  private emb!: ort.InferenceSession;
  private wake!: ort.InferenceSession;
  private melIn = ''; private embIn = ''; private wakeIn = '';

  private unsubscribe: (() => void) | null = null;

  private acc: number[] = [];         // incoming samples awaiting a full chunk
  private raw: number[] = [];         // last <=1760 int16-valued samples
  private melBuf: Float32Array[] = [];
  private embBuf: Float32Array[] = [];
  private busy = false;               // serialize async inference
  private cooldownUntil = 0;          // debounce repeat fires
  private threshold: number;
  private onWake: () => void;
  // threshold tuning: localStorage.setItem('nova.wakeDebug','1') logs the
  // rolling 1s max score to the console — watch how close your voice gets
  private debug = localStorage.getItem('nova.wakeDebug') === '1';
  private dbgMax = 0;
  private dbgAt = 0;
  // open peak (one attempt at the phrase) — see PEAK_FLOOR
  private peakMax = 0;
  private peakFired = false;
  private peakQuietAt = 0;

  /** which phrase model is loaded — rides along on every stored clip, so a
   *  training set never mixes "hey nova" with "hey jarvis" attempts */
  phrase = DEFAULT_WAKE;
  /** voice.wake_mic_processing at the time — stamped on every logged score */
  private micMode = 'browser';
  private capture = false;
  private onCapture?: (c: WakeCapture) => void;
  private ring: Float32Array | null = null;
  private ringAt = 0;
  private fireAudio: Float32Array | null = null;

  private constructor(opts: WakeOptions) {
    this.threshold = opts.threshold ?? 0.5;
    this.onWake = opts.onWake;
    this.capture = !!opts.capture;
    this.onCapture = opts.onCapture;
    if (opts.mic) this.micMode = opts.mic;
  }

  /** Retune a RUNNING detector. Without this, `voice.wake_threshold` changes
   *  do nothing until wake is toggled off and on (the instance is reused at
   *  the ChatPanel call site), which silently invalidates any measurement of
   *  a threshold change. */
  setTuning(opts: { threshold?: number; capture?: boolean; mic?: string }): void {
    if (typeof opts.threshold === 'number') this.threshold = opts.threshold;
    if (opts.mic) this.micMode = opts.mic;
    if (typeof opts.capture === 'boolean') {
      this.capture = opts.capture;
      // turning it off drops the buffered audio immediately — "off" should
      // not mean "off from the next session"
      if (!opts.capture) { this.ring = null; this.fireAudio = null; }
    }
  }

  private pushRing(block: Float32Array): void {
    if (!this.capture) return;
    if (!this.ring) { this.ring = new Float32Array(RING_SECS * RING_SR); this.ringAt = 0; }
    const ring = this.ring;
    for (let i = 0; i < block.length; i++) {
      ring[this.ringAt] = block[i];
      this.ringAt = (this.ringAt + 1) % ring.length;
    }
  }

  /** The last RING_SECS of audio, oldest first. */
  private snapshot(): Float32Array | null {
    if (!this.ring) return null;
    const out = new Float32Array(this.ring.length);
    out.set(this.ring.subarray(this.ringAt));
    out.set(this.ring.subarray(0, this.ringAt), this.ring.length - this.ringAt);
    return out;
  }

  static async create(opts: WakeOptions): Promise<WakeWord> {
    const w = new WakeWord(opts);
    w.phrase = opts.model ?? DEFAULT_WAKE;
    const model = WAKE_CATALOG[opts.model ?? DEFAULT_WAKE] ?? WAKE_CATALOG[DEFAULT_WAKE];
    const opt: ort.InferenceSession.SessionOptions = { executionProviders: ['wasm'] };
    w.mel = await ort.InferenceSession.create('/wake/melspectrogram.onnx', opt);
    w.emb = await ort.InferenceSession.create('/wake/embedding_model.onnx', opt);
    w.wake = await ort.InferenceSession.create(`/wake/${model.file}`, opt);
    w.melIn = w.mel.inputNames[0];
    w.embIn = w.emb.inputNames[0];
    w.wakeIn = w.wake.inputNames[0];
    return w;
  }

  /** Begin listening. Throws if the mic is denied. Re-primes buffers so each
   *  listening session (e.g. resuming after a command) starts clean.
   *
   *  No longer opens a device: it takes a reference on the shared one and
   *  subscribes to frames (phase 2). Resuming after a command used to cost a
   *  full getUserMedia + AudioContext; it is now a Set.add. */
  async start(): Promise<void> {
    // Idempotent. Phase 2 deliberately leaves wake RUNNING during a capture
    // (stopping it would release the shared device and pay the open cost
    // again), so the resume paths could reach a detector that never stopped
    // — and a second start() overwrote `unsubscribe`, orphaning the previous
    // frame listener and its broker reference. The device then never closed
    // and every frame was scored twice.
    if (this.unsubscribe) return;
    this.acc = []; this.raw = []; this.cooldownUntil = 0;
    this.peakMax = 0; this.peakFired = false; this.peakQuietAt = 0;
    this.ring = null; this.ringAt = 0; this.fireAudio = null;   // never carry old audio in
    await this.primeBuffers();
    await micBroker.acquire();
    this.unsubscribe = micBroker.subscribe((frame) => this.onAudio(frame));
  }

  async stop(): Promise<void> {
    if (!this.unsubscribe) return;    // never started, or already stopped —
                                      // releasing again would unbalance the broker
    // a fire stops the detector immediately, so the peak is still open here —
    // without this flush, successful wakes would never reach the log
    this.closePeak();
    this.unsubscribe?.();
    this.unsubscribe = null;
    micBroker.release();
    this.acc = []; this.raw = [];
  }

  // ── the openWakeWord pipeline ───────────────────────────────────────────
  private async melspec(int16: number[]): Promise<Float32Array[]> {
    const t = new ort.Tensor('float32', Float32Array.from(int16), [1, int16.length]);
    const o = (await this.mel.run({ [this.melIn]: t }))[this.mel.outputNames[0]];
    const T = o.data.length / BINS;   // frame axis is a middle dim, not dims[0]
    const d = o.data as Float32Array;
    const frames: Float32Array[] = [];
    for (let i = 0; i < T; i++) {
      const f = new Float32Array(BINS);
      for (let b = 0; b < BINS; b++) f[b] = d[i * BINS + b] / 10 + 2;   // owW transform
      frames.push(f);
    }
    return frames;
  }

  private async embed(win: Float32Array[]): Promise<Float32Array> {
    const d = new Float32Array(MEL_WIN * BINS);
    for (let i = 0; i < MEL_WIN; i++) d.set(win[i], i * BINS);
    const o = (await this.emb.run({ [this.embIn]: new ort.Tensor('float32', d, [1, MEL_WIN, BINS, 1]) }))[this.emb.outputNames[0]];
    return (o.data as Float32Array).slice(0);
  }

  private async score(win: Float32Array[]): Promise<number> {
    const d = new Float32Array(EMB_WIN * 96);
    for (let i = 0; i < EMB_WIN; i++) d.set(win[i], i * 96);
    const o = (await this.wake.run({ [this.wakeIn]: new ort.Tensor('float32', d, [1, EMB_WIN, 96]) }))[this.wake.outputNames[0]];
    return (o.data as Float32Array)[0];
  }

  /** Pre-fill buffers exactly like openWakeWord (ones mel-buffer + silence
   *  embeddings) so scores are valid from the first real chunk. */
  private async primeBuffers(): Promise<void> {
    this.melBuf = Array.from({ length: MEL_WIN }, () => new Float32Array(BINS).fill(1));
    const silFrame = (await this.melspec(new Array(RAW_MAX).fill(0)))[0];
    const silEmb = await this.embed(Array.from({ length: MEL_WIN }, () => silFrame));
    this.embBuf = Array.from({ length: EMB_WIN }, () => silEmb);
  }

  /** Collapse a run of elevated scores into ONE logged attempt. Emitting per
   *  chunk would bury the signal: a single "hey nova" spans a dozen chunks. */
  private trackPeak(score: number, fired: boolean): void {
    const now = performance.now();
    if (score >= PEAK_FLOOR) {
      this.peakMax = Math.max(this.peakMax, score);
      this.peakQuietAt = 0;
      if (fired) this.peakFired = true;
      return;
    }
    if (this.peakMax === 0) return;                        // nothing open
    if (!this.peakQuietAt) { this.peakQuietAt = now; return; }
    if (now - this.peakQuietAt < PEAK_QUIET_MS) return;    // still in the gap
    this.closePeak();
  }

  private closePeak(): void {
    if (this.peakMax > 0) {
      const kind = this.peakFired ? 'fire' : 'near';
      recordWakeEvent({
        at: Date.now(),
        score: this.peakMax,
        kind,
        threshold: this.threshold,
        mic: this.micMode,
      });
      if (this.capture && this.onCapture) {
        // For a fire, the audio was snapshotted AT the fire — by the time the
        // peak closes (700 ms of quiet later) the ring has already started
        // filling with the command that followed the phrase.
        const audio = this.fireAudio ?? this.snapshot();
        if (audio) {
          this.onCapture({ kind, score: this.peakMax, threshold: this.threshold, audio });
        }
      }
    }
    this.peakMax = 0;
    this.peakFired = false;
    this.peakQuietAt = 0;
    this.fireAudio = null;
  }

  private onAudio(block: Float32Array): void {
    this.pushRing(block);
    for (let i = 0; i < block.length; i++) this.acc.push(block[i] * 32767);   // int16-valued
    if (!this.busy && this.acc.length >= CHUNK) void this.pump();
  }

  private async pump(): Promise<void> {
    this.busy = true;
    try {
      while (this.acc.length >= CHUNK) {
        const chunk = this.acc.splice(0, CHUNK);
        this.raw.push(...chunk);
        if (this.raw.length > RAW_MAX) this.raw = this.raw.slice(-RAW_MAX);
        for (const f of await this.melspec(this.raw)) this.melBuf.push(f);
        if (this.melBuf.length > MEL_MAX) this.melBuf = this.melBuf.slice(-MEL_MAX);
        if (this.melBuf.length >= MEL_WIN) {
          this.embBuf.push(await this.embed(this.melBuf.slice(-MEL_WIN)));
          if (this.embBuf.length > EMB_WIN) this.embBuf = this.embBuf.slice(-EMB_WIN);
        }
        const s = await this.score(this.embBuf);
        if (this.debug) {
          this.dbgMax = Math.max(this.dbgMax, s);
          if (performance.now() - this.dbgAt > 1000) {
            console.debug(`[wake] max score ${this.dbgMax.toFixed(3)} (threshold ${this.threshold})`);
            this.dbgMax = 0;
            this.dbgAt = performance.now();
          }
        }
        // Crossing the bar and ACTING on it are different things: the 2 s
        // debounce suppresses the second and third chunk of the same phrase.
        // The log records the crossing, because a peak that scored 1.0 and was
        // merely debounced is not a near miss — filing it as one overstates
        // how badly the wake word is doing and, now that clips are kept, would
        // teach a retrained model that its own best detections were failures.
        const crossed = s >= this.threshold;
        const fired = crossed && performance.now() >= this.cooldownUntil;
        // once per peak — the phrase, before the command that follows it
        if (crossed && this.capture && !this.fireAudio) this.fireAudio = this.snapshot();
        this.trackPeak(s, crossed);
        if (fired) {
          this.cooldownUntil = performance.now() + 2000;   // debounce
          this.onWake();
        }
      }
    } finally {
      this.busy = false;
    }
  }
}
