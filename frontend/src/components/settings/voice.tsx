import { useState, useEffect, useRef } from 'react';
import {
  getVoiceHealth, synthesizeSpeech,
} from '../../api';
import { WAKE_CATALOG } from '../../voice/wakeCatalog';

/** Voice picker fed by the kokoro /health voice list, with an inline
 *  preview so you can hear a candidate before saving. Falls back to a
 *  free-text input when the voice service isn't running. */
export function VoiceField({ value, onSelect }: { value: string; onSelect: (v: string) => void }) {
  const [voices, setVoices] = useState<string[]>([]);
  const [status, setStatus] = useState('');
  const [previewing, setPreviewing] = useState(false);
  const ctxRef = useRef<AudioContext | null>(null);

  useEffect(() => {
    getVoiceHealth()
      .then(h => {
        setVoices(h.voices);
        if (h.status !== 'ready') {
          setStatus(h.status === 'unreachable'
            ? 'voice service not running (compose profile "voice")'
            : `voice service ${h.status}…`);
        }
      })
      .catch(() => setStatus('voice service unavailable'));
  }, []);

  async function preview() {
    if (previewing) return;
    setPreviewing(true);
    setStatus('');
    try {
      // the click is a user gesture — safe to create/resume the context here
      if (!ctxRef.current) ctxRef.current = new AudioContext();
      await ctxRef.current.resume();
      const wav = await synthesizeSpeech("Hi, I'm Nova — this is how I sound.", value);
      const buf = await ctxRef.current.decodeAudioData(wav);
      const src = ctxRef.current.createBufferSource();
      src.buffer = buf;
      src.connect(ctxRef.current.destination);
      src.onended = () => setPreviewing(false);
      src.start();
    } catch (e) {
      setStatus(String(e));
      setPreviewing(false);
    }
  }

  return (
    <div className="shrink-0 flex flex-col items-end gap-1">
      <div className="flex items-center gap-2">
        {voices.length > 0 ? (
          <select
            value={value}
            onChange={e => onSelect(e.target.value)}
            className="max-w-[12rem] bg-stone-800 border border-stone-700 rounded px-2 py-1 text-sm text-stone-200"
          >
            {voices.map(v => <option key={v} value={v}>{v}</option>)}
            {value && !voices.includes(value) && (
              <option value={value}>{value} (unknown)</option>
            )}
          </select>
        ) : (
          <input
            className="w-40 bg-stone-800 border border-stone-700 rounded px-2 py-1 text-sm text-stone-200 text-right focus:outline-none focus:ring-1 focus:ring-teal-500"
            defaultValue={value}
            onBlur={e => { const v = e.target.value.trim(); if (v !== value) onSelect(v); }}
          />
        )}
        <button
          onClick={preview}
          disabled={previewing}
          title="Hear this voice"
          className="text-xs px-2 py-1 rounded border border-stone-600 text-stone-300 hover:text-teal-300 hover:border-teal-800 disabled:opacity-50"
        >
          {previewing ? '▶ playing…' : '▶ preview'}
        </button>
      </div>
      {status && <span className="text-[11px] text-amber-400/90 text-right max-w-[16rem]">{status}</span>}
    </div>
  );
}

/** Mic mode with friendly labels and the honest tap-to-talk requirement —
 *  the in-browser speech detector is a one-time download, so say so. */
export function ListenModeField({ value, onSelect }: { value: string; onSelect: (v: string) => void }) {
  const LABELS: Record<string, string> = {
    ptt: 'Hold to talk', tap: 'Tap to talk (auto-stop)', wake: 'Wake word (hands-free)',
  };
  const HINTS: Record<string, string> = {
    tap: 'Downloads a ~15 MB on-device speech detector the first time (cached after); needs a modern browser and mic access. Audio never leaves your device.',
    wake: 'Listens hands-free on-device for the wake phrase you pick below (separate from the assistant’s name — a spoken trigger is a trained model). ~4 MB of models; works only while this tab is open and focused; audio never leaves your device until the phrase fires.',
  };
  return (
    <div className="shrink-0 flex flex-col items-end gap-1">
      <select
        value={value}
        onChange={e => onSelect(e.target.value)}
        className="bg-stone-800 border border-stone-700 rounded px-2 py-1 text-sm text-stone-200"
      >
        {Object.entries(LABELS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
      </select>
      {HINTS[value] && (
        <span className="text-[11px] text-stone-500 text-right max-w-[16rem]">{HINTS[value]}</span>
      )}
    </div>
  );
}

/** Wake phrase — a fixed catalog because each phrase is its own trained model.
 *  Deliberately separate from the assistant's name; a matching custom phrase
 *  needs a trained model (roadmap in docs/plans/voice.md). */
export function WakeWordField({ value, onSelect }: { value: string; onSelect: (v: string) => void }) {
  return (
    <select
      value={value}
      onChange={e => onSelect(e.target.value)}
      className="shrink-0 bg-stone-800 border border-stone-700 rounded px-2 py-1 text-sm text-stone-200"
    >
      {Object.entries(WAKE_CATALOG).map(([k, m]) => <option key={k} value={k}>{m.label}</option>)}
    </select>
  );
}
