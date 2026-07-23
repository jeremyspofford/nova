import { useEffect, useRef, useState } from 'react';
import { createNova } from '../brain/nova';
import type { RendererHandle } from '../brain/theme';

/** Full-screen voice mode — the ChatGPT-voice register, but the orb is ours.
 *  Black space, Nova large and centered, a slim control row at the bottom:
 *  a text field (typing mid-voice-mode is allowed), the mic (mute/unmute the
 *  listening loop), and a close button back to the chat.
 *
 *  The orb is the same createNova renderer the canvas uses — it reacts to
 *  the shared `nova:chat-activity` events and the speaker singleton, so
 *  listening / thinking / speaking all read on her without extra wiring. */

interface VoiceOverlayProps {
  assistantName: string;
  micState: 'idle' | 'recording' | 'arming' | 'armed' | 'capturing' | 'transcribing' | 'wake';
  busy: boolean;
  onMicToggle: () => void;
  onClose: () => void;
  onSendText: (text: string) => void;
}

export function VoiceOverlay({ assistantName, micState, busy,
                               onMicToggle, onClose, onSendText }: VoiceOverlayProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [text, setText] = useState('');

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let renderer: RendererHandle;
    try {
      renderer = createNova(canvas);
    } catch (err) {
      console.error('voice orb failed to start:', err);
      return;
    }
    renderer.configure?.({ orbScale: 1.8 });
    const size = () => renderer.resize(window.innerWidth, window.innerHeight);
    size();
    window.addEventListener('resize', size);
    // same live-activity bridge the canvas uses — thinking/tool/listening
    const onActivity = (e: Event) => {
      renderer.setActivity?.((e as CustomEvent).detail as {
        active: boolean; kind?: 'thinking' | 'dispatch' | 'tool' | 'listening';
      });
    };
    window.addEventListener('nova:chat-activity', onActivity);
    return () => {
      window.removeEventListener('resize', size);
      window.removeEventListener('nova:chat-activity', onActivity);
      renderer.destroy();
    };
  }, []);

  const listening = micState === 'armed' || micState === 'wake';
  const hearing = micState === 'capturing' || micState === 'recording';
  const waiting = micState === 'arming' || micState === 'transcribing';

  const micTitle =
    hearing ? 'Hearing you — tap to cancel'
    : listening ? 'Listening — tap to mute'
    : micState === 'transcribing' ? 'Transcribing…'
    : micState === 'arming' ? 'Preparing the mic…'
    : busy ? `${assistantName} is replying — tap to listen again`
    : 'Muted — tap to listen';

  const submitText = () => {
    const t = text.trim();
    if (!t) return;
    setText('');
    onSendText(t);
  };

  return (
    <div className="fixed inset-0 z-50 bg-black flex flex-col">
      {/* the orb owns the whole backdrop; controls float over it */}
      <canvas ref={canvasRef} className="absolute inset-0" />

      <div
        className="relative mt-auto flex items-center gap-2 px-4"
        style={{ paddingBottom: 'calc(1.25rem + env(safe-area-inset-bottom))' }}
      >
        <form
          onSubmit={e => { e.preventDefault(); submitText(); }}
          className="flex-1 min-w-0"
        >
          <input
            value={text}
            onChange={e => setText(e.target.value)}
            placeholder={`Ask ${assistantName}`}
            className="w-full bg-stone-900/85 backdrop-blur border border-stone-800 text-stone-100 placeholder-stone-500 rounded-full px-4 py-3 text-sm focus:outline-none focus:border-stone-600"
          />
        </form>

        <button
          type="button"
          onClick={onMicToggle}
          disabled={waiting}
          title={micTitle}
          aria-label={micTitle}
          className={`shrink-0 w-12 h-12 rounded-full flex items-center justify-center border transition select-none ${
            hearing ? 'bg-red-600/90 border-red-500 text-white animate-pulse'
            : listening ? 'bg-teal-800/80 border-teal-600 text-teal-100'
            : waiting ? 'bg-stone-900/85 border-stone-800 text-stone-500'
            : 'bg-stone-900/85 border-stone-800 text-stone-300'}`}
        >
          {waiting ? (
            <span className="w-4 h-4 rounded-full border-2 border-stone-500 border-t-transparent animate-spin" />
          ) : listening || hearing ? (
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor"
              strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M12 2a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3" />
              <path d="M19 10v1a7 7 0 0 1-14 0v-1M12 18v4" />
            </svg>
          ) : (
            // muted: mic with a slash
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor"
              strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M9 5a3 3 0 0 1 6 0v6" />
              <path d="M19 10v1a7 7 0 0 1-10.6 6M5 10v1c0 .9.17 1.77.48 2.56M12 18v4" />
              <path d="M3 3l18 18" />
            </svg>
          )}
        </button>

        <button
          type="button"
          onClick={onClose}
          title="Leave voice mode"
          aria-label="Leave voice mode"
          className="shrink-0 w-12 h-12 rounded-full bg-stone-100 text-stone-900 flex items-center justify-center"
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor"
            strokeWidth="2.2" strokeLinecap="round" aria-hidden="true">
            <path d="M6 6l12 12M18 6L6 18" />
          </svg>
        </button>
      </div>
    </div>
  );
}
