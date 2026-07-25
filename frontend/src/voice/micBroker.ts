/** One microphone, shared. Phase 2 of the voice-conversation plan.
 *
 * THE PROBLEM THIS EXISTS FOR, measured 2026-07-24: every cold arm logged
 * `[vad] armed in ~2000ms`. Two seconds of dead microphone between the wake
 * word firing and anything actually listening — which is very likely why
 * "hey nova, what's the weather" loses its first words, and it costs a child
 * more than an adult because their utterances are shorter.
 *
 * The cause was that three consumers each opened the device for themselves:
 * `wake.ts` did its own getUserMedia + AudioContext, `vad.ts` let vad-web do
 * the same, and `mic.ts` held a third for push-to-talk. Handing off between
 * them meant closing one device and opening another, and getUserMedia plus
 * AudioContext resume is hundreds of milliseconds each, every time.
 *
 * So: acquire the device ONCE and never close it during a conversation.
 * Consumers refcount it and subscribe to frames. Wake resuming after a turn
 * becomes a `Set.add` instead of a device open.
 *
 * CONSTRAINTS ARE REPRODUCED EXACTLY (echoCancellation, noiseSuppression,
 * autoGainControl — vad-web's own defaults). vad.ts's thresholds were tuned
 * against an AGC'd stream; changing what the mic does to the signal is a
 * separately-measured experiment, not a side effect of this refactor.
 *
 * The deferred teardown is copied from mic.ts: releasing the device the
 * instant the last consumer lets go would put the open cost straight back in
 * the path of the next turn, and would blink the OS recording indicator
 * between every exchange. Held briefly, then released — because a mic that
 * stays lit forever is its own kind of wrong.
 */

const SR = 16000;

/** How long the device stays open after the last consumer releases it. Long
 *  enough to cover a reply and the next turn; short enough that walking away
 *  from the app does not leave the indicator lit. */
const LINGER_MS = 20_000;

/** vad-web's defaults, spelled out. Changing these changes what the VAD
 *  thresholds mean — see the header. */
const AUDIO_CONSTRAINTS: MediaTrackConstraints = {
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true,
};

/** voice.wake_mic_processing = 'raw' (phase 5b). Chrome's noise suppression
 *  is tuned for adult speech and attacks a high-F0 signal, and none of that
 *  processing exists in the chain the wake model was trained on
 *  (tools/wake-training/featurize.py). It is a plausible one-line fix for the
 *  child problem — and a real change to what the sensitivity setting means,
 *  which is why it is a setting with a warning and not a silent default. */
const RAW_CONSTRAINTS: MediaTrackConstraints = {
  echoCancellation: false,
  noiseSuppression: false,
  autoGainControl: false,
};

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

export type FrameListener = (frame: Float32Array) => void;

class MicBroker {
  private stream: MediaStream | null = null;
  private ctx: AudioContext | null = null;
  private node: AudioWorkletNode | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private sink: GainNode | null = null;
  private refs = 0;
  private linger: number | undefined;
  private listeners = new Set<FrameListener>();
  private endedHandlers = new Set<() => void>();
  /** Serialises concurrent acquires — wake and VAD can both arrive within a
   *  frame of each other, and two getUserMedia calls would defeat the point. */
  private opening: Promise<void> | null = null;
  private processing: 'browser' | 'raw' = 'browser';

  get open(): boolean {
    return !!this.stream?.active;
  }

  /** Choose what the browser does to the signal before we see it. Takes
   *  effect on the next open, and forces one if the device is already up —
   *  constraints are fixed at getUserMedia time, so a setting that only
   *  applied after a page reload would look like it did nothing. */
  setProcessing(mode: 'browser' | 'raw'): void {
    if (mode === this.processing) return;
    this.processing = mode;
    if (this.open) void this.dispose();
  }

  /** Take a reference to the shared device, opening it if needed. Prompts for
   *  the mic on first use; throws if denied. */
  async acquire(): Promise<void> {
    this.refs += 1;
    this.cancelLinger();
    if (this.open && this.ctx?.state === 'running') return;
    if (!this.opening) this.opening = this.doOpen().finally(() => { this.opening = null; });
    try {
      await this.opening;
    } catch (e) {
      this.refs = Math.max(0, this.refs - 1);
      throw e;
    }
  }

  private async doOpen(): Promise<void> {
    if (!this.open) {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: this.processing === 'raw' ? RAW_CONSTRAINTS : AUDIO_CONSTRAINTS });
      // The OS can revoke the device (unplugged, taken by another app). Tell
      // consumers rather than silently going deaf — a conversation mode that
      // looks live but hears nothing is worse than one that stops.
      for (const track of this.stream.getTracks()) {
        track.addEventListener('ended', () => this.handleTrackEnded());
      }
    }
    if (!this.ctx || this.ctx.state === 'closed') {
      this.ctx = new AudioContext({ sampleRate: SR });
      const url = URL.createObjectURL(new Blob([TAP_WORKLET], { type: 'application/javascript' }));
      try {
        await this.ctx.audioWorklet.addModule(url);
      } finally {
        URL.revokeObjectURL(url);
      }
      this.node = new AudioWorkletNode(this.ctx, 'wake-tap');
      this.node.port.onmessage = (e) => {
        const frame = e.data as Float32Array;
        // a listener that throws must not stop the others hearing
        for (const fn of this.listeners) {
          try { fn(frame); } catch { /* one deaf consumer, not all of them */ }
        }
      };
      this.source = this.ctx.createMediaStreamSource(this.stream!);
      this.source.connect(this.node);
      // muted sink: the graph only pulls if it terminates somewhere
      this.sink = this.ctx.createGain();
      this.sink.gain.value = 0;
      this.node.connect(this.sink).connect(this.ctx.destination);
    }
    if (this.ctx.state === 'suspended') await this.ctx.resume();
  }

  /** Give back a reference. The device lingers briefly so the next turn does
   *  not pay the open cost again. */
  release(): void {
    this.refs = Math.max(0, this.refs - 1);
    if (this.refs === 0) this.scheduleLinger();
  }

  /** Frames of mono 16 kHz float audio, as the worklet produces them.
   *  Returns an unsubscribe function. */
  subscribe(fn: FrameListener): () => void {
    this.listeners.add(fn);
    return () => { this.listeners.delete(fn); };
  }

  /** Told when the OS takes the device away. */
  onTrackEnded(fn: () => void): () => void {
    this.endedHandlers.add(fn);
    return () => { this.endedHandlers.delete(fn); };
  }

  /** The live stream, for consumers that need the MediaStream itself
   *  (vad-web wants one from `getStream`). Opens if necessary. */
  async getStream(): Promise<MediaStream> {
    if (!this.open) await this.doOpen();
    return this.stream!;
  }

  /** The shared AudioContext, so vad-web does not build a second one. */
  async getContext(): Promise<AudioContext> {
    if (!this.ctx || this.ctx.state === 'closed') await this.doOpen();
    if (this.ctx!.state === 'suspended') await this.ctx!.resume();
    return this.ctx!;
  }

  /** Release the device NOW, regardless of refcount — for teardown, tab-hide,
   *  and "voice off". Consumers must re-acquire afterwards. */
  async dispose(): Promise<void> {
    this.cancelLinger();
    this.refs = 0;
    this.listeners.clear();
    this.stream?.getTracks().forEach(t => t.stop());
    if (this.node) { this.node.port.onmessage = null; try { this.node.disconnect(); } catch { /* gone */ } }
    try { this.source?.disconnect(); } catch { /* gone */ }
    try { this.sink?.disconnect(); } catch { /* gone */ }
    if (this.ctx && this.ctx.state !== 'closed') {
      try { await this.ctx.close(); } catch { /* already closed */ }
    }
    this.stream = null; this.ctx = null; this.node = null;
    this.source = null; this.sink = null;
  }

  private handleTrackEnded(): void {
    this.stream = null;
    for (const fn of this.endedHandlers) {
      try { fn(); } catch { /* keep telling the rest */ }
    }
  }

  private scheduleLinger(): void {
    this.cancelLinger();
    this.linger = window.setTimeout(() => { void this.dispose(); }, LINGER_MS);
  }

  private cancelLinger(): void {
    if (this.linger) { clearTimeout(this.linger); this.linger = undefined; }
  }
}

/** One device for the whole app. */
export const micBroker = new MicBroker();
