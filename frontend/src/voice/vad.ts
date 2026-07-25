/** Tap-to-talk — in-browser silero VAD (phase 3 of docs/plans/voice.md).
 *
 * The whole point: no server. silero-vad runs in the browser via
 * onnxruntime-web (WASM); we detect speech start/end locally and hand the
 * bounded utterance to the SAME blob→/transcribe→source:"voice" path
 * phase 2 built. Continuous audio never leaves the device.
 *
 * Assets are SELF-HOSTED under /vad/ (worklet + silero onnx + ort wasm) —
 * no CDN, no runtime third-party fetch (batteries-included). This module is
 * dynamically imported so the ~15 MB of WASM/model isn't in the main bundle.
 *
 * PHASE 2 (voice conversation): the VAD no longer opens or closes the
 * microphone, and is built ONCE per session rather than per turn. Measured
 * before this change: every cold arm cost ~2000ms of device-open and
 * model-load, sitting between the wake word firing and anything actually
 * listening — which is where the first words of "hey nova, what's the
 * weather" were going, and it costs a child more than an adult because
 * their utterances are shorter.
 *
 * Three of the options below are load-bearing and easy to get wrong:
 *   pauseStream  MUST be a no-op. The library's default STOPS the tracks,
 *                which would kill the shared device for the wake word too.
 *   resumeStream MUST return the stream — it is used as a value, not for a
 *                side effect.
 *   startOnLoad  false, so constructing the model does not start listening.
 */

import { MicVAD, utils } from '@ricky0123/vad-web';
import { micBroker } from './micBroker';

export interface VadCallbacks {
  onSpeechStart: () => void;
  onSpeechEnd: (wav: Blob) => void;
  onMisfire: () => void;   // spoke too briefly — nothing to send
}

export class TapVad {
  private vad: MicVAD | null = null;
  private building: Promise<MicVAD> | null = null;
  private live = false;
  /** The library takes its callbacks at construction and offers no setter, so
   *  the handlers it holds dispatch through this field instead. That is what
   *  lets ONE instance serve turn after turn. */
  private cb: VadCallbacks | null = null;
  private silenceMs = 1100;

  /** Begin listening for one utterance's worth of speech. `silenceMs` = the
   *  trailing silence that ends the turn (voice.vad_silence_ms). Throws if the
   *  mic is denied or assets fail. */
  async arm(cb: VadCallbacks, opts?: { silenceMs?: number }): Promise<void> {
    // watch endpointing live: localStorage.setItem('nova.vadDebug','1')
    const dbg = typeof localStorage !== 'undefined' && localStorage.getItem('nova.vadDebug') === '1';
    const t0 = performance.now();
    this.cb = cb;
    const wanted = opts?.silenceMs ?? 1100;
    await micBroker.acquire();
    await this.ensure(dbg);
    // redemptionMs becomes a frame count inside the library, so changing it
    // means rebuilding — but it is an operator setting that rarely moves, so
    // only rebuild when it actually differs.
    if (wanted !== this.silenceMs) {
      this.silenceMs = wanted;
      await this.rebuild(dbg);
    }
    await this.vad!.start();
    this.live = true;
    if (dbg) console.debug(`[vad] armed in ${Math.round(performance.now() - t0)}ms (silence=${this.silenceMs}ms)`);
  }

  /** Stop listening. Keeps the model warm and holds nothing open itself — the
   *  broker's refcount decides when the device actually closes, so the next
   *  turn arms in milliseconds instead of seconds. */
  async disarm(): Promise<void> {
    if (!this.live) return;
    this.live = false;
    this.cb = null;
    try { await this.vad?.pause(); } catch { /* already paused */ }
    micBroker.release();
  }

  /** Tear the model down for good — teardown, tab-hide, voice off. */
  async dispose(): Promise<void> {
    const v = this.vad;
    this.vad = null; this.building = null; this.cb = null;
    if (this.live) { this.live = false; micBroker.release(); }
    if (v) { try { await v.destroy(); } catch { /* already gone */ } }
  }

  get armed(): boolean {
    return this.live;
  }

  private async ensure(dbg: boolean): Promise<MicVAD> {
    if (this.vad) return this.vad;
    if (!this.building) this.building = this.build(dbg);
    this.vad = await this.building;
    return this.vad;
  }

  private async rebuild(dbg: boolean): Promise<void> {
    const old = this.vad;
    this.vad = null; this.building = null;
    if (old) { try { await old.destroy(); } catch { /* gone */ } }
    await this.ensure(dbg);
  }

  private async build(dbg: boolean): Promise<MicVAD> {
    const t0 = performance.now();
    let speechAt = 0;
    const vad = await MicVAD.new({
      // self-hosted assets — never the library's CDN defaults
      baseAssetPath: '/vad/',
      onnxWASMBasePath: '/vad/',
      model: 'v5',
      // the shared device (phase 2) — see the header for why these matter
      audioContext: await micBroker.getContext(),
      getStream: () => micBroker.getStream(),
      pauseStream: async () => { /* never stop the shared tracks */ },
      resumeStream: async (s: MediaStream) => s,
      startOnLoad: false,
      // Endpointing tuned to NOT cut off command-style speech (you pause while
      // composing a query). Trailing silence to end is the operator setting
      // voice.vad_silence_ms. The low negative threshold is the anti-cutoff
      // lever: brief in-word amplitude dips must not read as "you stopped".
      positiveSpeechThreshold: 0.35,
      negativeSpeechThreshold: 0.2,
      minSpeechMs: 250,
      redemptionMs: this.silenceMs,
      preSpeechPadMs: 400,      // a touch more, so the wake→VAD handoff keeps your first word
      onSpeechStart: () => {
        speechAt = performance.now();
        if (dbg) console.debug('[vad] speech start');
        this.cb?.onSpeechStart();
      },
      onVADMisfire: () => {
        if (dbg) console.debug('[vad] MISFIRE (spoke < minSpeechMs) — back to armed');
        this.cb?.onMisfire();
      },
      onSpeechEnd: (audio: Float32Array) => {
        const secs = audio.length / 16000;
        let sum = 0;
        for (let i = 0; i < audio.length; i++) sum += audio[i] * audio[i];
        const rms = Math.sqrt(sum / (audio.length || 1));
        if (dbg) console.debug(`[vad] speech END: ${secs.toFixed(2)}s captured, rms=${rms.toFixed(4)}, `
          + `${Math.round(performance.now() - speechAt)}ms since start, redemption=${this.silenceMs}ms`);
        // Guard the classic whisper failure: a near-empty / near-silent clip
        // (e.g. the wake→VAD handoff missed the command) makes whisper
        // hallucinate "Thank you." Treat it as a misfire, not a real turn.
        if (secs < 0.4 || rms < 0.006) {
          if (dbg) console.debug('[vad] discarded as too short/quiet — misfire');
          this.cb?.onMisfire();
          return;
        }
        // Float32 @16 kHz → 16-bit PCM WAV (whisper decodes it via PyAV)
        const wav = utils.encodeWAV(audio, 1, 16000, 1, 16);
        this.cb?.onSpeechEnd(new Blob([wav], { type: 'audio/wav' }));
      },
    });
    if (dbg) console.debug(`[vad] model built in ${Math.round(performance.now() - t0)}ms (once per session)`);
    return vad;
  }
}
