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
    this.vad = await MicVAD.new({
      // self-hosted assets — never the library's CDN defaults
      baseAssetPath: '/vad/',
      onnxWASMBasePath: '/vad/',
      model: 'v5',
      // endpointing: ~300 ms min speech; trailing silence to end is tunable
      // (default forgiving of mid-sentence pauses)
      minSpeechMs: 300,
      redemptionMs: opts?.silenceMs ?? 1100,
      preSpeechPadMs: 300,
      onSpeechStart: () => cb.onSpeechStart(),
      onVADMisfire: () => cb.onMisfire(),
      onSpeechEnd: (audio: Float32Array) => {
        // Float32 @16 kHz → 16-bit PCM WAV (whisper decodes it via PyAV)
        const wav = utils.encodeWAV(audio, 1, 16000, 1, 16);
        cb.onSpeechEnd(new Blob([wav], { type: 'audio/wav' }));
      },
    });
    await this.vad.start();
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
