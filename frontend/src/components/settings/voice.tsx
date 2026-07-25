import { useState, useEffect, useRef } from 'react';
import {
  getVoiceHealth, synthesizeSpeech,
  UserProfile, listProfiles, createProfile, deleteProfile, enrollVoiceClip,
  WakeClipListing, listWakeClips, wakeClipAudio, deleteWakeClip, deleteAllWakeClips,
} from '../../api';
import { Mic } from '../../voice/mic';
import { WAKE_CATALOG } from '../../voice/wakeCatalog';
import { wakeSummary, wakeByMic, clearWakeLog, subscribeWakeLog } from '../../voice/wakeLog';

/** Household voices — who Nova can recognize when someone speaks
 *  (docs/plans/speaker-id.md). Enrollment records a few short clips; each
 *  is turned into a voiceprint server-side and the audio is DISCARDED.
 *  Recognition personalizes and NARROWS — it never unlocks anything. */
export function HouseholdVoices() {
  const [profiles, setProfiles] = useState<UserProfile[] | null>(null);
  const [name, setName] = useState('');
  const [role, setRole] = useState<'operator' | 'kid' | 'guest'>('kid');
  const [recordingFor, setRecordingFor] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const micRef = useRef<Mic | null>(null);

  const refresh = async () => {
    try { setProfiles(await listProfiles()); } catch { /* backend offline */ }
  };
  useEffect(() => { void refresh(); }, []);

  const add = async () => {
    if (!name.trim()) return;
    setBusy(true); setMsg('');
    try {
      await createProfile(name.trim(), role);
      setName('');
      await refresh();
    } catch (e) { setMsg(String(e)); }
    finally { setBusy(false); }
  };

  const remove = async (p: UserProfile) => {
    // The only destructive action in the app that used to skip the confirm
    // every other one has — and it takes a voiceprint with it, which can only
    // be restored by getting the person to re-enrol in person.
    if (!window.confirm(
      `Delete ${p.name}'s voice profile? Their voiceprint goes with it and `
      + `Nova will stop recognising them until they enrol again.`)) return;
    setMsg('');
    try {
      await deleteProfile(p.id);   // deletes the voiceprint with it
      await refresh();
    } catch (e) { setMsg(String(e)); }
  };

  const toggleRecord = async (p: UserProfile) => {
    setMsg('');
    if (recordingFor === p.id) {
      // stop → embed → discard
      try {
        const blob = await micRef.current!.stop();
        setRecordingFor(null);
        setBusy(true);
        await enrollVoiceClip(p.id, blob);
        setMsg(`Clip added for ${p.name} — 3+ clips make a solid voiceprint.`);
        await refresh();
      } catch (e) { setMsg(String(e)); }
      finally { setBusy(false); }
      return;
    }
    try {
      micRef.current = micRef.current ?? new Mic();
      await micRef.current.warm();
      await micRef.current.start();
      setRecordingFor(p.id);
      setMsg(`Recording ${p.name} — speak naturally for a few seconds, then stop.`);
    } catch (e) {
      setMsg(`Microphone unavailable: ${e}`);
    }
  };

  return (
    <div className="rounded-lg border border-stone-700/70 bg-stone-800/40 px-3 py-2.5 space-y-2">
      <div>
        <div className="text-sm text-stone-200">Household voices</div>
        <div className="text-xs text-stone-500">
          Enroll the people Nova should recognize. Clips become voiceprints
          and the audio is discarded — recognition only ever narrows what a
          voice can do, it never unlocks anything.
        </div>
      </div>
      {profiles === null ? (
        <div className="text-xs text-stone-500">Loading…</div>
      ) : (
        <>
          {profiles.map(p => (
            <div key={p.id} className="flex items-center justify-between gap-2 text-xs border-t border-stone-800 pt-2">
              <span className="min-w-0 text-stone-300 truncate">
                {p.name}
                <span className="text-stone-500"> · {p.role}</span>
                <span className={p.enrolled ? 'text-teal-500' : 'text-stone-600'}>
                  {' '}· {p.enrolled ? `${p.enrolled_clips} clip${p.enrolled_clips === 1 ? '' : 's'}` : 'not enrolled'}
                </span>
              </span>
              <span className="shrink-0 flex items-center gap-2">
                <button
                  onClick={() => toggleRecord(p)}
                  disabled={busy || (recordingFor !== null && recordingFor !== p.id)}
                  className={`px-2 py-1 rounded border disabled:opacity-40 ${
                    recordingFor === p.id
                      ? 'border-red-800 bg-red-950/60 text-red-300 animate-pulse'
                      : 'border-stone-700 text-stone-300 hover:border-teal-600'}`}
                >
                  {recordingFor === p.id ? 'Stop & save clip' : 'Record clip'}
                </button>
                <button onClick={() => remove(p)}
                  className="text-stone-600 hover:text-red-400">remove</button>
              </span>
            </div>
          ))}
          <div className="flex items-center gap-2 border-t border-stone-800 pt-2">
            <input
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder="name"
              className="min-w-0 flex-1 bg-stone-800 border border-stone-700 rounded px-2 py-1 text-xs text-stone-200"
            />
            <select value={role} onChange={e => setRole(e.target.value as typeof role)}
              className="bg-stone-800 border border-stone-700 rounded px-1.5 py-1 text-xs text-stone-300">
              <option value="operator">operator</option>
              <option value="kid">kid</option>
              <option value="guest">guest</option>
            </select>
            <button onClick={add} disabled={busy || !name.trim()}
              className="text-xs px-2.5 py-1 rounded bg-teal-700 hover:bg-teal-600 text-white disabled:opacity-40">
              Add
            </button>
          </div>
        </>
      )}
      {msg && <div className="text-xs text-teal-400">{msg}</div>}
    </div>
  );
}

const LABEL_TEXT: Record<string, string> = {
  positive: 'heard you',
  false_fire: 'fired at nothing',
  near_miss: 'nearly heard you',
};

const ago = (secs: number) => {
  const m = Math.round((Date.now() / 1000 - secs) / 60);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h}h ago` : `${Math.round(h / 24)}d ago`;
};

/** Wake-word learning — the evidence trail and the clips it keeps.
 *
 *  Two halves that only mean something together. The SCORES (kept in this
 *  browser, no audio, always on) say how close each attempt came; the CLIPS
 *  (opt-in, on this machine) are the audio behind the labelled ones. Near
 *  misses are the number to watch: they are the attempts that came close and
 *  were ignored — "I had to say it three times" as a number.
 *
 *  The scores half also closes a real gap: the log had been recording for a
 *  release with nothing anywhere that could read it back or clear it, which
 *  is not something to ask an operator to consent to.
 */
export function WakeLearning() {
  const [listing, setListing] = useState<WakeClipListing | null>(null);
  const [sum, setSum] = useState(() => wakeSummary());
  const [byMic, setByMic] = useState(() => wakeByMic());
  const [playing, setPlaying] = useState<string | null>(null);
  const [msg, setMsg] = useState('');
  const audioRef = useRef<HTMLAudioElement | null>(null);

  const refresh = async () => {
    try { setListing(await listWakeClips()); } catch { /* backend offline */ }
  };
  useEffect(() => { void refresh(); }, []);
  useEffect(() => {
    const resync = () => { setSum(wakeSummary()); setByMic(wakeByMic()); };
    resync();
    return subscribeWakeLog(resync);
  }, []);
  // object URLs are revoked when playback ends or another clip starts
  useEffect(() => () => { audioRef.current?.pause(); }, []);

  const play = async (id: string) => {
    setMsg('');
    try {
      if (audioRef.current) { audioRef.current.pause(); URL.revokeObjectURL(audioRef.current.src); }
      const url = await wakeClipAudio(id);
      const el = new Audio(url);
      audioRef.current = el;
      setPlaying(id);
      el.onended = () => { setPlaying(null); URL.revokeObjectURL(url); };
      await el.play();
    } catch (e) { setPlaying(null); setMsg(String(e)); }
  };

  const remove = async (id: string) => {
    try { await deleteWakeClip(id); await refresh(); }
    catch (e) { setMsg(String(e)); }
  };

  const removeAll = async () => {
    if (!listing?.total) return;
    if (!window.confirm(
      `Delete all ${listing.total} wake clips? The recordings go for good, and `
      + `with them anything a retrained wake word could have learned from them.`)) return;
    try { await deleteAllWakeClips(); await refresh(); }
    catch (e) { setMsg(String(e)); }
  };

  const counts = listing?.counts ?? {};
  return (
    <div className="rounded-lg border border-stone-700/70 bg-stone-800/40 px-3 py-2.5 space-y-2">
      <div>
        <div className="text-sm text-stone-200">Wake word evidence</div>
        <div className="text-xs text-stone-500">
          How the wake word is actually doing, from ordinary use. Near misses
          are attempts that came close and were ignored — the number that
          should fall as it learns your household.
        </div>
      </div>

      <div className="text-xs text-stone-400 border-t border-stone-800 pt-2">
        Last 24 hours: <span className="text-stone-200">{sum.fires}</span> woke her,{' '}
        <span className={sum.nearMisses ? 'text-amber-400' : 'text-stone-200'}>
          {sum.nearMisses}</span> near {sum.nearMisses === 1 ? 'miss' : 'misses'}
        {sum.bestNearMiss > 0 && (
          <> · closest {sum.bestNearMiss.toFixed(2)}</>
        )}
        {sum.total === 0 && <span className="text-stone-600"> — nothing heard yet</span>}
        {sum.total > 0 && (
          <button onClick={() => { clearWakeLog(); }}
            className="ml-2 text-stone-600 hover:text-red-400">clear</button>
        )}
      </div>

      {byMic.length > 1 && (
        <div className="text-xs text-stone-500 border-t border-stone-800 pt-2 space-y-0.5">
          <div className="text-stone-400">By mic processing (two weeks)</div>
          {byMic.map(r => (
            <div key={r.mic}>
              <span className="text-stone-300">{r.mic}</span>: {r.fires} fired,{' '}
              {r.near} near, best score {r.peak.toFixed(2)}
            </div>
          ))}
        </div>
      )}

      <div className="border-t border-stone-800 pt-2 space-y-1.5">
        {!listing ? (
          <div className="text-xs text-stone-500">Loading clips…</div>
        ) : !listing.enabled && listing.total === 0 ? (
          <div className="text-xs text-stone-500">
            Learning is off, so no audio is kept. Turn on “Learn the wake word
            from use” below and Nova will start keeping the few seconds around
            each labelled attempt — here, on this machine, playable and
            deletable.
          </div>
        ) : (
          <>
            <div className="text-xs text-stone-400 flex items-center justify-between gap-2">
              <span>
                {listing.total} clip{listing.total === 1 ? '' : 's'}
                {listing.total > 0 && (
                  <span className="text-stone-500">
                    {' '}· {counts.positive ?? 0} good, {counts.near_miss ?? 0} near,{' '}
                    {counts.false_fire ?? 0} false · {Math.round(listing.bytes / 1024)} KB
                  </span>
                )}
              </span>
              {listing.total > 0 && (
                <button onClick={removeAll} className="shrink-0 text-stone-600 hover:text-red-400">
                  delete all
                </button>
              )}
            </div>
            {listing.total === 0 && (
              <div className="text-xs text-stone-500">
                Nothing captured yet — clips appear as the wake word is used.
              </div>
            )}
            {listing.clips.slice(0, 12).map(c => (
              <div key={c.id} className="flex items-center justify-between gap-2 text-xs">
                <span className="min-w-0 truncate text-stone-300">
                  <span className={c.label === 'positive' ? 'text-teal-500'
                    : c.label === 'near_miss' ? 'text-amber-500' : 'text-stone-500'}>
                    {LABEL_TEXT[c.label] ?? c.label}
                  </span>
                  <span className="text-stone-500">
                    {' '}· {ago(c.at)}
                    {typeof c.score === 'number' && <> · score {c.score.toFixed(2)}</>}
                    {c.speaker && <> · {c.speaker}</>}
                  </span>
                </span>
                <span className="shrink-0 flex items-center gap-2">
                  <button onClick={() => play(c.id)}
                    className={`px-2 py-0.5 rounded border border-stone-700 hover:border-teal-600 ${
                      playing === c.id ? 'text-teal-400' : 'text-stone-300'}`}>
                    {playing === c.id ? 'playing' : 'play'}
                  </button>
                  <button onClick={() => remove(c.id)}
                    className="text-stone-600 hover:text-red-400">delete</button>
                </span>
              </div>
            ))}
          </>
        )}
      </div>
      {msg && <div className="text-xs text-amber-400">{msg}</div>}
    </div>
  );
}

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
