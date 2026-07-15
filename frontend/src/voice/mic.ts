/** Push-to-talk mic capture — record a bounded utterance, hand back a blob.
 *
 * Phase 2 of docs/plans/voice.md. Deliberately MediaRecorder, not an
 * AudioWorklet: a PTT utterance is complete before we do anything with it,
 * and whisper transcribes a whole clip in one shot — so the blob is all we
 * need. (Phase 3's continuous VAD is where frame-level worklet capture
 * earns its keep.) whisper's PyAV decodes webm/opus and mp4 directly.
 */

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

  get recording(): boolean {
    return this.rec?.state === 'recording';
  }

  /** Prompt for the mic (first time) and start recording. Throws on denial. */
  async start(): Promise<void> {
    this.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const mimeType = pickMime();
    this.chunks = [];
    this.rec = new MediaRecorder(this.stream, mimeType ? { mimeType } : undefined);
    this.rec.ondataavailable = e => { if (e.data.size) this.chunks.push(e.data); };
    this.rec.start();
  }

  /** Stop and resolve the recorded utterance; releases the mic. */
  stop(): Promise<Blob> {
    return new Promise((resolve, reject) => {
      const rec = this.rec;
      if (!rec) { reject(new Error('not recording')); return; }
      rec.onstop = () => {
        const blob = new Blob(this.chunks, { type: rec.mimeType || 'audio/webm' });
        this.release();
        resolve(blob);
      };
      rec.stop();
    });
  }

  /** Abort without producing a blob (e.g. too-short tap). */
  cancel(): void {
    try { this.rec?.stop(); } catch { /* already stopped */ }
    this.release();
  }

  private release(): void {
    this.stream?.getTracks().forEach(t => t.stop());
    this.stream = null;
    this.rec = null;
  }
}
