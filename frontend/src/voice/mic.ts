/** Push-to-talk mic capture — record a bounded utterance, hand back a blob.
 *
 * Phase 2 of docs/plans/voice.md. Deliberately MediaRecorder, not an
 * AudioWorklet: a PTT utterance is complete before we do anything with it,
 * and whisper transcribes a whole clip in one shot — so the blob is all we
 * need. (Phase 3's continuous VAD is where frame-level worklet capture
 * earns its keep.) whisper's PyAV decodes webm/opus and mp4 directly.
 *
 * The stream is acquired ONCE and kept warm between presses: getUserMedia has
 * real device-init latency (hundreds of ms), and re-acquiring it on every
 * press meant recording started late and the first word or two never made it
 * into the clip — you'd only transcribe the tail. Warm reuse makes rec.start()
 * instant on every subsequent press; the device is released after a spell of
 * inactivity (or on dispose()) so the mic indicator doesn't linger forever.
 */

const IDLE_RELEASE_MS = 120_000;   // free the mic after this long with no capture

function pickMime(): string {
  for (const m of ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4']) {
    if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(m)) return m;
  }
  return '';
}

export class Mic {
  private stream: MediaStream | null = null;
  private rec: MediaRecorder | null = null;
  private chunks: Blob[] = [];
  private idleTimer: number | undefined;

  get recording(): boolean {
    return this.rec?.state === 'recording';
  }

  /** Warm the mic (acquire the stream) without recording — call it as soon as
   *  voice becomes likely (e.g. on pointerdown) so the very first press isn't
   *  the one that pays the getUserMedia latency. Prompts on first use. */
  async warm(): Promise<void> {
    this.cancelIdleRelease();
    if (!this.stream || !this.stream.active) {
      this.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    }
  }

  /** Start recording — reuses the warm stream so capture begins immediately.
   *  Prompts for the mic on first use. Throws on denial. */
  async start(): Promise<void> {
    await this.warm();
    const mimeType = pickMime();
    this.chunks = [];
    this.rec = new MediaRecorder(this.stream!, mimeType ? { mimeType } : undefined);
    this.rec.ondataavailable = e => { if (e.data.size) this.chunks.push(e.data); };
    this.rec.start();
  }

  /** Stop and resolve the recorded utterance; keeps the mic warm for reuse. */
  stop(): Promise<Blob> {
    return new Promise((resolve, reject) => {
      const rec = this.rec;
      if (!rec) { reject(new Error('not recording')); return; }
      rec.onstop = () => {
        const blob = new Blob(this.chunks, { type: rec.mimeType || 'audio/webm' });
        this.rec = null;
        this.scheduleIdleRelease();
        resolve(blob);
      };
      rec.stop();
    });
  }

  /** Abort without producing a blob (e.g. too-short tap). */
  cancel(): void {
    try { this.rec?.stop(); } catch { /* already stopped */ }
    this.rec = null;
    this.scheduleIdleRelease();
  }

  /** Fully release the mic device (clears the OS "in use" indicator). Call on
   *  teardown or when voice is turned off. */
  dispose(): void {
    this.cancelIdleRelease();
    try { this.rec?.stop(); } catch { /* already stopped */ }
    this.rec = null;
    this.stream?.getTracks().forEach(t => t.stop());
    this.stream = null;
  }

  private scheduleIdleRelease(): void {
    this.cancelIdleRelease();
    this.idleTimer = window.setTimeout(() => this.dispose(), IDLE_RELEASE_MS);
  }

  private cancelIdleRelease(): void {
    if (this.idleTimer) { clearTimeout(this.idleTimer); this.idleTimer = undefined; }
  }
}
