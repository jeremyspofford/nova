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

export interface WakeOptions {
  model?: string;            // wake-phrase key (see wakeCatalog); default hey_jarvis
  threshold?: number;        // 0..1 detection threshold (tune live)
  onWake: () => void;
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

  private constructor(opts: WakeOptions) {
    this.threshold = opts.threshold ?? 0.5;
    this.onWake = opts.onWake;
  }

  /** Retune a RUNNING detector. Without this, `voice.wake_threshold` changes
   *  do nothing until wake is toggled off and on (the instance is reused at
   *  the ChatPanel call site), which silently invalidates any measurement of
   *  a threshold change. */
  setTuning(opts: { threshold?: number }): void {
    if (typeof opts.threshold === 'number') this.threshold = opts.threshold;
  }

  static async create(opts: WakeOptions): Promise<WakeWord> {
    const w = new WakeWord(opts);
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
    this.acc = []; this.raw = []; this.cooldownUntil = 0;
    this.peakMax = 0; this.peakFired = false; this.peakQuietAt = 0;
    await this.primeBuffers();
    await micBroker.acquire();
    this.unsubscribe = micBroker.subscribe((frame) => this.onAudio(frame));
  }

  async stop(): Promise<void> {
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
      recordWakeEvent({
        at: Date.now(),
        score: this.peakMax,
        kind: this.peakFired ? 'fire' : 'near',
        threshold: this.threshold,
      });
    }
    this.peakMax = 0;
    this.peakFired = false;
    this.peakQuietAt = 0;
  }

  private onAudio(block: Float32Array): void {
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
        const fired = s >= this.threshold && performance.now() >= this.cooldownUntil;
        this.trackPeak(s, fired);
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
