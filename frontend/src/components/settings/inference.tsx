import { useState, useEffect } from 'react';
import {
  BundledInferenceStatus, ModelsDirInfo, getBundledInference, getModelsDir, setBundledInference, setModelsDir,
} from '../../api';

/** Start/stop the bundled Ollama container via the inference-control
 *  sidecar. Hidden entirely when the sidecar isn't running. */
export function BundledInference({ onChanged }: { onChanged: () => void }) {
  const [st, setSt] = useState<BundledInferenceStatus | null>(null);
  const [err, setErr] = useState('');

  useEffect(() => {
    const load = () => getBundledInference().then(setSt).catch(() => setSt(null));
    load();
    const iv = setInterval(load, 4000);
    return () => clearInterval(iv);
  }, []);

  if (!st?.available) return null;

  const busy = !!st.op;
  const [dot, text] =
    st.op === 'start' ? ['bg-amber-400 animate-pulse', 'starting…'] :
    st.op === 'stop' ? ['bg-amber-400 animate-pulse', 'stopping…'] :
    st.op === 'relocate' ? ['bg-amber-400 animate-pulse', 'relocating store…'] :
    st.running && st.api_ok ? ['bg-emerald-400', 'running'] :
    st.running ? ['bg-amber-400', 'running — API warming up'] :
    st.present ? ['bg-stone-500', 'stopped'] :
    ['bg-stone-500', 'not installed'];

  async function toggle() {
    if (!st || busy) return;
    setErr('');
    const action = st.running ? 'stop' : 'start';
    try {
      await setBundledInference(action);
      setSt({ ...st, op: action });
      onChanged();
    } catch (e) {
      setErr(String(e));
    }
  }

  return (
    <div className="rounded-lg border border-stone-700 bg-stone-800/50 p-3">
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0">
          <div className="text-sm text-stone-200 flex items-center gap-2">
            Bundled Ollama
            <span className={`w-2 h-2 rounded-full ${dot}`} />
            <span className="text-xs text-stone-400">{text}</span>
          </div>
          <div className="text-xs text-stone-500">
            The local-inference container. Stop it to free RAM/VRAM — pulled
            models persist across stops.
            {!st.present && ' First start downloads the Ollama image (~1 GB).'}
          </div>
        </div>
        <button
          onClick={toggle}
          disabled={busy}
          className={`shrink-0 text-xs rounded px-3 py-1 text-white disabled:bg-stone-700 ${
            st.running ? 'bg-stone-600 hover:bg-stone-500' : 'bg-teal-700 hover:bg-teal-600'
          }`}
        >
          {busy ? 'working…' : st.running ? 'stop' : 'start'}
        </button>
      </div>
      {(err || st.error) && (
        <div className="mt-1.5 text-xs text-red-400">{err || st.error}</div>
      )}
    </div>
  );
}

/** Relocate the bundled Ollama model store to an external drive / bigger disk
 *  from the UI — no .env or compose edits. Save writes the path; the sidecar
 *  migrates the existing models (non-destructively) and rebinds Ollama. */
export function ModelStorage() {
  const [info, setInfo] = useState<ModelsDirInfo | null>(null);
  const [path, setPath] = useState('');
  const [op, setOp] = useState<string | null>(null);   // 'relocate' while running
  const [err, setErr] = useState('');
  const [done, setDone] = useState(false);

  const refresh = () =>
    getModelsDir().then(i => { setInfo(i); setPath(i.path ?? ''); }).catch(() => {});
  useEffect(() => { refresh(); }, []);

  // while a relocate runs, poll the sidecar op until it clears, then refresh
  useEffect(() => {
    if (!op) return;
    const iv = setInterval(async () => {
      try {
        const st = await getBundledInference();
        if (st.op !== 'relocate') {
          setOp(null);
          if (st.error) setErr(st.error); else setDone(true);
          refresh();
        }
      } catch { /* keep polling */ }
    }, 3000);
    return () => clearInterval(iv);
  }, [op]);

  if (!info) return null;
  const current = info.path ? `${info.path}/ollama` : 'default docker volume';
  const dirty = path.trim() !== (info.path ?? '');

  async function save() {
    setErr(''); setDone(false);
    try {
      await setModelsDir(path.trim());
      setOp('relocate');
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <div className="rounded-lg border border-stone-700 bg-stone-800/50 p-3">
      <div className="text-sm text-stone-200 flex items-center gap-2">
        Model storage
        {op === 'relocate' && <span className="w-2 h-2 rounded-full bg-amber-400 animate-pulse" />}
        {op === 'relocate' && <span className="text-xs text-amber-400">relocating — migrating models…</span>}
      </div>
      <div className="text-xs text-stone-500 mt-0.5">
        Where the bundled model weights live — Ollama LLMs plus the Kokoro/Whisper
        voice models when running. Point it at an external SSD, a NAS mount, or a
        bigger disk to save space or share between machines. Save migrates your
        existing models — the old copy is kept until you remove it — and restarts
        the affected services. No files to edit.
      </div>
      <div className="mt-2 flex gap-2">
        <input
          value={path}
          onChange={e => setPath(e.target.value)}
          placeholder="/mnt/ssd/nova-models   (empty = default volume)"
          disabled={op === 'relocate'}
          className="flex-1 bg-stone-800 border border-stone-700 rounded px-2 py-1 text-xs font-mono text-stone-200 disabled:opacity-50" />
        <button onClick={save} disabled={op === 'relocate' || !dirty}
          className="shrink-0 text-xs rounded px-3 py-1 text-white bg-teal-700 hover:bg-teal-600 disabled:bg-stone-700">
          {op === 'relocate' ? 'working…' : 'Save'}
        </button>
      </div>
      <div className="mt-1 text-[11px] font-mono text-stone-500">current: {current}</div>
      {err && <div className="mt-1 text-xs text-red-400">{err}</div>}
      {done && !op && !err && (
        <div className="mt-1 text-xs text-emerald-400">
          relocated — Ollama now uses the new path.
        </div>
      )}
    </div>
  );
}
