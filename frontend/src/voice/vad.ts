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
  /** Fired once per utterance, the moment speech has been continuously
   *  present for SUSTAIN_MS. Needed because the start/end/misfire callbacks
   *  CANNOT answer "are they still talking?": the library only reports the
   *  end of an utterance after redemptionMs (1100 ms) of silence, so half a
   *  second after onSpeechStart every 180 ms blip still looks like ongoing
   *  speech. Measured: a cough confirmed as a barge-in and cut her off. This
   *  reads the per-frame speech probability instead, which is live. */
  onSustained?: () => void;
}

// silero v5 runs 512-sample frames at 16 kHz
const FRAME_MS = 32;
const SUSTAIN_MS = 500;    // how long a voice must hold to count as "talking to her"
const SUSTAIN_GRACE = 3;   // frames below threshold tolerated between words (~96 ms)

export class TapVad {
  private vad: MicVAD | null = null;
  private building: Promise<MicVAD> | null = null;
  private live = false;
  /** The library takes its callbacks at construction and offers no setter, so
   *  the handlers it holds dispatch through this field instead. That is what
   *  lets ONE instance serve turn after turn. */
  private cb: VadCallbacks | null = null;
  private silenceMs = 1100;
  /** The AudioContext the model was BUILT against. vad-web resolves
   *  `audioContext` once, at construction, and holds that object — unlike
   *  `getStream`, which it re-invokes — so a cached model outlives its context
   *  and start() then throws InvalidStateError on a closed one. Worse, the
   *  library sets initializationState='initializing' BEFORE it touches the
   *  context, and its `case "initializing"` arm just warns and returns: every
   *  later start() resolves, `live` goes true, the bar says "listening", and
   *  nothing is heard for the rest of the page session. Keeping the reference
   *  is what lets ensure() notice and rebuild. */
  private builtCtx: AudioContext | null = null;

  /** Begin listening for one utterance's worth of speech. `silenceMs` = the
   *  trailing silence that ends the turn (voice.vad_silence_ms). Throws if the
   *  mic is denied or assets fail. */
  async arm(cb: VadCallbacks, opts?: { silenceMs?: number }): Promise<void> {
    // watch endpointing live: localStorage.setItem('nova.vadDebug','1')
    const dbg = typeof localStorage !== 'undefined' && localStorage.getItem('nova.vadDebug') === '1';
    const t0 = performance.now();
    this.cb = cb;
    const wanted = opts?.silenceMs ?? 1100;
    // Re-entrancy. `disarm()` is single-shot (`if (!this.live) return`) but
    // `arm()` was not, so arming an already-live instance took a SECOND broker
    // reference that nothing would ever give back — the device then stayed open
    // for the rest of the session. Harmless until something could arm twice;
    // the stranded-re-arm backstop can, by design, so the guard lands with it.
    if (this.live) {
      if (wanted !== this.silenceMs) {
        this.silenceMs = wanted;
        this.vad!.setOptions({ redemptionMs: wanted });
      }
      if (dbg) console.debug(`[vad] arm() on a live detector — retuned only (silence=${wanted}ms)`);
      return;
    }
    await micBroker.acquire();
    await this.ensure(dbg);
    // Retune in place. This used to DESTROY and rebuild the model, on the
    // belief that redemptionMs is baked into a frame count at construction.
    // It is baked into a frame count, but MicVAD.setOptions recomputes it
    // live (vad-web's FrameProcessor.setOptions), so the rebuild was ~1.4 s
    // of dead microphone for nothing. That mattered little when the value
    // only changed if the operator edited a setting; it matters a lot now
    // that conversation mode carries its own, shorter value and would
    // otherwise pay the rebuild on entering and again on leaving.
    if (wanted !== this.silenceMs) {
      this.silenceMs = wanted;
      this.vad!.setOptions({ redemptionMs: wanted });
      if (dbg) console.debug(`[vad] retuned redemption to ${wanted}ms in place (no rebuild)`);
    }
    await this.vad!.start();
    this.live = true;
    if (dbg) console.debug(`[vad] armed in ${Math.round(performance.now() - t0)}ms (silence=${this.silenceMs}ms)`);
  }

  /** Build the model WITHOUT listening, so the wake word never has to wait for
   *  it. `startOnLoad: false` means MicVAD.new only loads silero and builds the
   *  FrameProcessor; the audio graph is created in start().
   *
   *  This closes the one gap phase 2 left open. Phase 2 made the model live
   *  across turns, so every turn AFTER the first arms in milliseconds — but the
   *  instance is lazy at the call site and is disposed on tab-hide, so the
   *  FIRST wake fire of every page session still paid the full build with the
   *  detector deaf throughout. No amount of preSpeechPadMs can recover audio
   *  the frame processor never saw.
   *
   *  Be aware it DOES open the shared device (build() awaits the broker's
   *  context and stream), so only call it when the microphone is already
   *  legitimately open — i.e. when wake listening is on. */
  async prewarm(): Promise<void> {
    const dbg = typeof localStorage !== 'undefined' && localStorage.getItem('nova.vadDebug') === '1';
    await micBroker.acquire();
    try {
      await this.ensure(dbg);
    } finally {
      // Hold no reference of our own: the model outlives this call, the device
      // reference must not. arm() takes its own.
      micBroker.release();
    }
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
    this.vad = null; this.building = null; this.cb = null; this.builtCtx = null;
    if (this.live) { this.live = false; micBroker.release(); }
    if (v) { try { await v.destroy(); } catch { /* already gone */ } }
  }

  get armed(): boolean {
    return this.live;
  }

  /** Restart the sustained-speech measurement from now.
   *
   *  Called once the output has been ducked, so the 500 ms that confirms an
   *  interruption is measured against a quiet speaker rather than a loud one.
   *  Without it the confirm is backwards for exactly the signal it must
   *  reject: synthesized speech is more continuously voiced than a person, so
   *  her own voice leaking into an open microphone clears a "500 ms of voiced
   *  frames" bar MORE reliably than the human trying to interrupt her. */
  resetSustain(): void {
    this.resetSustainFn?.();
  }

  private resetSustainFn: (() => void) | null = null;

  private async ensure(dbg: boolean): Promise<MicVAD> {
    // Reuse only a model whose context is STILL THE LIVE ONE. The broker closes
    // its context 20 s after the last reference goes (wake off, mute, mode
    // change) and allocates a fresh one on the next open, so "we already built
    // it" is not the same question as "it still works". Checked here rather
    // than at the call sites because both arm() and prewarm() need it and only
    // this function knows whether a build is being skipped.
    const ctx = await micBroker.getContext();
    if (this.vad && (this.builtCtx !== ctx || this.builtCtx?.state === 'closed')) {
      if (dbg) console.debug('[vad] context was replaced under the cached model — rebuilding');
      await this.dispose();
    }
    if (this.vad) return this.vad;
    if (!this.building) this.building = this.build(dbg);
    this.vad = await this.building;
    return this.vad;
  }

  private async build(dbg: boolean): Promise<MicVAD> {
    const t0 = performance.now();
    let speechAt = 0;
    // sustained-speech tracking (see onSustained)
    let voiced = 0;      // consecutive-ish voiced frames
    let quiet = 0;       // voiceless frames since the last voiced one
    let sustained = false;
    const resetSustain = () => { if (dbg) console.debug(`[vad] resetSustain (had ${voiced} voiced)`); voiced = 0; quiet = 0; sustained = false; };
    this.resetSustainFn = resetSustain;
    // Remember what we bind to, so ensure() can tell a warm model from a
    // stale one. Resolved into a local first: the value handed to the library
    // and the value we remember must be the same object, or the staleness
    // check is testing the wrong thing.
    const ctx = await micBroker.getContext();
    this.builtCtx = ctx;
    const vad = await MicVAD.new({
      // self-hosted assets — never the library's CDN defaults
      baseAssetPath: '/vad/',
      onnxWASMBasePath: '/vad/',
      model: 'v5',
      // the shared device (phase 2) — see the header for why these matter
      audioContext: ctx,
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
      onFrameProcessed: (probs) => {
        if (probs.isSpeech >= 0.35) {          // == positiveSpeechThreshold
          voiced++; quiet = 0;
          if (!sustained && voiced * FRAME_MS >= SUSTAIN_MS) {
            sustained = true;
            if (dbg) console.debug(`[vad] SUSTAINED (${voiced} voiced frames)`);
            this.cb?.onSustained?.();
          }
        } else if (++quiet > SUSTAIN_GRACE) {
          // a gap between words is not the end of speech; a real pause is
          voiced = 0; sustained = false;
        }
      },
      onSpeechStart: () => {
        speechAt = performance.now();
        if (dbg) console.debug('[vad] speech start');
        this.cb?.onSpeechStart();
      },
      onVADMisfire: () => {
        if (dbg) console.debug('[vad] MISFIRE (spoke < minSpeechMs) — back to armed');
        resetSustain();
        this.cb?.onMisfire();
      },
      onSpeechEnd: (audio: Float32Array) => {
        resetSustain();
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
