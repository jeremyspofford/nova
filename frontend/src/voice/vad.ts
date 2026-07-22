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
 */

import { MicVAD, utils } from '@ricky0123/vad-web';

export interface VadCallbacks {
  onSpeechStart: () => void;
  onSpeechEnd: (wav: Blob) => void;
  onMisfire: () => void;   // spoke too briefly — nothing to send
}

export class TapVad {
  private vad: MicVAD | null = null;

  /** Load the model + mic and begin listening for one utterance's worth of
   *  speech. `silenceMs` = trailing silence that ends the turn (configurable
   *  via voice.vad_silence_ms). Throws if the mic is denied or assets fail. */
  async arm(cb: VadCallbacks, opts?: { silenceMs?: number }): Promise<void> {
    // watch endpointing live: localStorage.setItem('nova.vadDebug','1')
    const dbg = typeof localStorage !== 'undefined' && localStorage.getItem('nova.vadDebug') === '1';
    const t0 = performance.now();
    const silenceMs = opts?.silenceMs ?? 1100;
    let speechAt = 0;
    this.vad = await MicVAD.new({
      // self-hosted assets — never the library's CDN defaults
      baseAssetPath: '/vad/',
      onnxWASMBasePath: '/vad/',
      model: 'v5',
      // Endpointing tuned to NOT cut off command-style speech (you pause while
      // composing a query). Trailing silence to end is the operator setting
      // voice.vad_silence_ms. The low negative threshold is the anti-cutoff
      // lever: brief in-word amplitude dips must not read as "you stopped".
      positiveSpeechThreshold: 0.35,
      negativeSpeechThreshold: 0.2,
      minSpeechMs: 250,
      redemptionMs: silenceMs,
      preSpeechPadMs: 400,      // a touch more, so the wake→VAD handoff keeps your first word
      onSpeechStart: () => {
        speechAt = performance.now();
        if (dbg) console.debug(`[vad] speech start (+${Math.round(speechAt - t0)}ms after arm)`);
        cb.onSpeechStart();
      },
      onVADMisfire: () => {
        if (dbg) console.debug('[vad] MISFIRE (spoke < minSpeechMs) — back to armed');
        cb.onMisfire();
      },
      onSpeechEnd: (audio: Float32Array) => {
        const secs = audio.length / 16000;
        let sum = 0;
        for (let i = 0; i < audio.length; i++) sum += audio[i] * audio[i];
        const rms = Math.sqrt(sum / (audio.length || 1));
        if (dbg) console.debug(`[vad] speech END: ${secs.toFixed(2)}s captured, rms=${rms.toFixed(4)}, `
          + `${Math.round(performance.now() - speechAt)}ms since start, redemption=${silenceMs}ms`);
        // Guard the classic whisper failure: a near-empty / near-silent clip
        // (e.g. the wake→VAD handoff missed the command) makes whisper
        // hallucinate "Thank you." Treat it as a misfire, not a real turn.
        if (secs < 0.4 || rms < 0.006) {
          if (dbg) console.debug('[vad] discarded as too short/quiet — misfire');
          cb.onMisfire();
          return;
        }
        // Float32 @16 kHz → 16-bit PCM WAV (whisper decodes it via PyAV)
        const wav = utils.encodeWAV(audio, 1, 16000, 1, 16);
        cb.onSpeechEnd(new Blob([wav], { type: 'audio/wav' }));
      },
    });
    await this.vad.start();
    if (dbg) console.debug(`[vad] armed in ${Math.round(performance.now() - t0)}ms (silence=${silenceMs}ms)`);
  }

  /** Stop listening and release the mic. */
  async disarm(): Promise<void> {
    const v = this.vad;
    this.vad = null;
    if (v) { try { await v.destroy(); } catch { /* already gone */ } }
  }

  get armed(): boolean {
    return this.vad !== null;
  }
}
