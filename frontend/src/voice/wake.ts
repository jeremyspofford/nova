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

ort.env.wasm.wasmPaths = '/vad/';   // reuse the self-hosted ORT wasm from phase 3
ort.env.wasm.numThreads = 1;        // single-thread SIMD — no COOP/COEP needed

const SR = 16000;
const CHUNK = 1280;      // 80 ms @ 16 kHz — one wake step
const RAW_MAX = 1760;    // melspec window: chunk + 480-sample lead-in
const BINS = 32;         // mel features
const MEL_WIN = 76;      // embedding input frames
const EMB_WIN = 16;      // wake model input embeddings
const MEL_MAX = 200;     // rolling mel-frame cap

const TAP_WORKLET = `
class WakeTap extends AudioWorkletProcessor {
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch) this.port.postMessage(ch.slice(0));
    return true;
  }
}
registerProcessor('wake-tap', WakeTap);
`;

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

  private ctx: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private node: AudioWorkletNode | null = null;

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

  private constructor(opts: WakeOptions) {
    this.threshold = opts.threshold ?? 0.5;
    this.onWake = opts.onWake;
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
   *  listening session (e.g. resuming after a command) starts clean. */
  async start(): Promise<void> {
    this.acc = []; this.raw = []; this.cooldownUntil = 0;
    await this.primeBuffers();
    this.ctx = new AudioContext({ sampleRate: SR });
    await this.ctx.resume();
    this.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const url = URL.createObjectURL(new Blob([TAP_WORKLET], { type: 'application/javascript' }));
    await this.ctx.audioWorklet.addModule(url);
    URL.revokeObjectURL(url);
    const src = this.ctx.createMediaStreamSource(this.stream);
    this.node = new AudioWorkletNode(this.ctx, 'wake-tap');
    this.node.port.onmessage = (e) => this.onAudio(e.data as Float32Array);
    src.connect(this.node);
    // a muted sink keeps the graph pulling without audible output
    const sink = this.ctx.createGain();
    sink.gain.value = 0;
    this.node.connect(sink).connect(this.ctx.destination);
  }

  async stop(): Promise<void> {
    this.stream?.getTracks().forEach(t => t.stop());
    if (this.node) this.node.port.onmessage = null;
    if (this.ctx) { try { await this.ctx.close(); } catch { /* closed */ } }
    this.stream = null; this.node = null; this.ctx = null;
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
        if (s >= this.threshold && performance.now() >= this.cooldownUntil) {
          this.cooldownUntil = performance.now() + 2000;   // debounce
          this.onWake();
        }
      }
    } finally {
      this.busy = false;
    }
  }
}
