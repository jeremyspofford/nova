import { useEffect, useRef, useState } from 'react';
import {
  streamChat, getActiveConversation, getAgents, getMessages, getModels,
  patchAgent, Activity, ModelInfo,
} from '../api';
import { Markdown } from '../components/Markdown';
import { displayName } from '../names';
import { speaker } from '../voice/speech';
import { Mic } from '../voice/mic';
import { transcribeSpeech, getSettings } from '../api';
import type { TapVad } from '../voice/vad';
import type { WakeWord } from '../voice/wake';
import { wakeLabel, DEFAULT_WAKE } from '../voice/wakeCatalog';
import { useAssistantName } from '../useAssistantName';

type Item =
  | { id: string; kind: 'msg'; role: 'user' | 'assistant'; content: string; streaming?: boolean }
  | { id: string; kind: 'activity'; activity: Activity; fromHistory?: boolean }
  | { id: string; kind: 'error'; content: string };

// getUserMedia / AudioWorklet failures are DOMExceptions — the useful bit is
// .name (NotAllowedError = mic blocked, NotSupportedError = insecure context /
// unsupported). Surface it so the chat error is diagnosable, not just "Not supported".
function errText(err: unknown): string {
  if (err instanceof Error) {
    return err.name && err.name !== 'Error' ? `${err.name}: ${err.message}` : err.message;
  }
  return String(err);
}

let nextId = 0;
const uid = () => `ui-${++nextId}`;

function renderItem(item: Item) {
  if (item.kind === 'activity') {
    if (item.activity.kind === 'narration') {
      return (
        <div key={item.id} className={`text-xs text-amber-300 bg-amber-950/40 border border-amber-800 rounded px-2.5 py-1.5 ${item.fromHistory ? 'opacity-75' : ''}`}>
          ⚠ {displayName(item.activity.name)} announced an action but
          called no tool — the described work did <b>not</b> happen.
        </div>
      );
    }
    return (
      <div key={item.id} className="text-xs text-amber-400/80 font-mono px-1">
        {activityLabel(item.activity)}
      </div>
    );
  }
  if (item.kind === 'error') {
    return (
      <div key={item.id} className="text-xs text-red-400 bg-red-950/40 border border-red-900 rounded px-3 py-2">
        {item.content}
      </div>
    );
  }
  return (
    <div key={item.id} className={`flex ${item.role === 'user' ? 'justify-end' : 'justify-start'}`}>
      <div className={`max-w-[85%] min-w-0 break-words px-3 py-2 rounded-lg text-sm ${
        item.role === 'user'
          ? 'bg-teal-700 text-white whitespace-pre-wrap'
          : 'bg-stone-800 text-stone-100'
      }`}>
        {item.streaming && !item.content ? (
          // waiting for the first token — bouncing "typing" dots
          <span className="flex items-center gap-1 py-1" aria-label="Nova is thinking">
            {[0, 150, 300].map(delay => (
              <span
                key={delay}
                className="w-1.5 h-1.5 rounded-full bg-teal-400 animate-bounce"
                style={{ animationDelay: `${delay}ms` }}
              />
            ))}
          </span>
        ) : (
          <>
            {item.role === 'assistant' ? <Markdown>{item.content}</Markdown> : item.content}
            {item.streaming && <span className="inline-block w-2 h-4 ml-0.5 bg-teal-400 animate-pulse align-text-bottom" />}
          </>
        )}
      </div>
    </div>
  );
}

/** Past turns' activity trail collapses into a dim expandable trace so it's
 *  reviewable without competing with the conversation; narration warnings
 *  stay visible (dimmed). Live activity renders inline as it happens. */
function renderGrouped(items: Item[]) {
  const blocks: React.ReactNode[] = [];
  let trace: Extract<Item, { kind: 'activity' }>[] = [];
  const flush = () => {
    if (!trace.length) return;
    blocks.push(
      <details key={`trace-${trace[0].id}`} className="opacity-70 hover:opacity-100 transition-opacity">
        <summary className="text-[11px] text-stone-600 cursor-pointer select-none px-1">
          ⚙ {trace.length} agent action{trace.length > 1 ? 's' : ''}
        </summary>
        <div className="space-y-1 mt-1 pl-2 border-l border-stone-800">
          {trace.map(renderItem)}
        </div>
      </details>,
    );
    trace = [];
  };
  for (const item of items) {
    if (item.kind === 'activity' && item.fromHistory && item.activity.kind !== 'narration') {
      trace.push(item);
    } else {
      flush();
      blocks.push(renderItem(item));
    }
  }
  flush();
  return blocks;
}

const activityLabel = (a: Activity): string => {
  switch (a.kind) {
    case 'dispatch': return `→ dispatching to ${displayName(a.name)}`;
    case 'tool_start': return `⚙ ${a.agent ? `${displayName(a.agent)}: ` : ''}${displayName(a.name)}…`;
    case 'tool_result': return `✓ ${displayName(a.name)}`;
    default: return displayName(a.name);
  }
};

interface ChatPanelProps {
  width: number;
  onWidthChange: (w: number) => void;
  mobile?: boolean;
  onShowBrain?: () => void;
}

const MIN_W = 320;
const MAX_W = 760;

export function ChatPanel({ width, onWidthChange, mobile, onShowBrain }: ChatPanelProps) {
  const [items, setItems] = useState<Item[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const resizing = useRef(false);

  // grow the input vertically with its content, capped at ~8 lines
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  }, [input]);

  // model picker — changes main's model live (applies on the next turn)
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [mainAgent, setMainAgent] = useState<{ id: string; model: string } | null>(null);
  const [speech, setSpeech] = useState(() => localStorage.getItem('nova.speech') === '1');
  const [voiceState, setVoiceState] = useState({ speaking: false, paused: false });
  const [micState, setMicState] = useState<
    'idle' | 'recording' | 'arming' | 'armed' | 'capturing' | 'transcribing' | 'wake'>('idle');
  const [listenMode, setListenMode] = useState<'ptt' | 'tap' | 'wake'>('ptt');
  const mic = useRef(new Mic());
  const tapVad = useRef<TapVad | null>(null);
  const vadSilenceMs = useRef(1100);
  const wakeRef = useRef<WakeWord | null>(null);
  const wakeOn = useRef(false);
  const wakeThreshold = useRef(0.5);
  const wakeWord = useRef(DEFAULT_WAKE);
  const assistantName = useAssistantName();

  // mic mode + VAD/wake tuning are shared settings — read + track live changes
  useEffect(() => {
    const isMode = (v: unknown): v is 'ptt' | 'tap' | 'wake' => v === 'ptt' || v === 'tap' || v === 'wake';
    getSettings().then(defs => {
      const m = defs.find(d => d.key === 'voice.listen_mode')?.value;
      if (isMode(m)) setListenMode(m);
      const s = defs.find(d => d.key === 'voice.vad_silence_ms')?.value;
      if (typeof s === 'number') vadSilenceMs.current = s;
      const w = defs.find(d => d.key === 'voice.wake_threshold')?.value;
      if (typeof w === 'number') wakeThreshold.current = w;
      const ph = defs.find(d => d.key === 'voice.wake_word')?.value;
      if (typeof ph === 'string' && ph) wakeWord.current = ph;
    }).catch(() => {});
    const onChange = (e: Event) => {
      const { key, value } = (e as CustomEvent).detail as { key: string; value: unknown };
      if (key === 'voice.listen_mode' && isMode(value)) setListenMode(value);
      if (key === 'voice.vad_silence_ms' && typeof value === 'number') vadSilenceMs.current = value;
      if (key === 'voice.wake_threshold' && typeof value === 'number') wakeThreshold.current = value;
      if (key === 'voice.wake_word' && typeof value === 'string' && value) wakeWord.current = value;
    };
    window.addEventListener('nova:setting-changed', onChange);
    return () => window.removeEventListener('nova:setting-changed', onChange);
  }, []);

  function toggleSpeech() {
    const next = !speech;
    setSpeech(next);
    localStorage.setItem('nova.speech', next ? '1' : '0');
    if (next) speaker.enable();     // inside the click gesture — autoplay policy
    else speaker.disable();
  }

  // a captured utterance (from PTT or tap-VAD) → transcribe → voice turn.
  // The reply is always spoken (voice in implies voice out).
  async function submitUtterance(blob: Blob) {
    setMicState('transcribing');
    try {
      const text = await transcribeSpeech(blob);
      setMicState('idle');
      if (text.trim()) await send({ text, source: 'voice', speak: true });
      else setItems(prev => [...prev, { id: uid(), kind: 'error',
        content: "Didn't catch that — try again." }]);
    } catch (err) {
      setMicState('idle');
      setItems(prev => [...prev, { id: uid(), kind: 'error',
        content: `Transcription failed: ${errText(err)}` }]);
    }
  }

  // arm the in-browser VAD to capture ONE utterance, then submit it. Shared
  // by tap-to-talk (button) and the wake word (after the trigger fires).
  // armTimeoutMs: if NOTHING is spoken within it, give up and run afterSubmit
  // anyway — without this, a false wake-fire strands the VAD armed forever
  // and wake listening never resumes ("it only activated once").
  async function startVadCapture(afterSubmit?: () => void | Promise<void>,
                                 armTimeoutMs?: number) {
    setMicState('arming');          // first use downloads the detector (~15 MB)
    try {
      const { TapVad } = await import('../voice/vad');
      const v = new TapVad();
      tapVad.current = v;
      let armTimer: number | undefined;
      const clearArmTimer = () => { if (armTimer) { clearTimeout(armTimer); armTimer = undefined; } };
      await v.arm({
        onSpeechStart: () => { clearArmTimer(); setMicState('capturing'); },
        onMisfire: () => setMicState('armed'),
        onSpeechEnd: (wav) => {
          clearArmTimer();
          // defer out of the VAD's own callback stack before tearing it down —
          // calling destroy() synchronously from within onSpeechEnd wedges the
          // async continuation and the utterance never gets submitted
          setTimeout(async () => {
            await v.disarm();
            tapVad.current = null;
            await submitUtterance(wav);
            await afterSubmit?.();
          }, 0);
        },
      }, { silenceMs: vadSilenceMs.current });
      setMicState(s => (s === 'arming' ? 'armed' : s));
      if (armTimeoutMs) {
        armTimer = window.setTimeout(async () => {
          if (tapVad.current !== v) return;      // already captured/cancelled
          await v.disarm();
          tapVad.current = null;
          await afterSubmit?.();                  // back to wake listening
        }, armTimeoutMs);
      }
    } catch (err) {
      tapVad.current = null;
      setMicState('idle');
      setItems(prev => [...prev, { id: uid(), kind: 'error',
        content: `Voice detector unavailable: ${errText(err)}` }]);
      await afterSubmit?.();
    }
  }

  // ── tap-to-talk: tap arms the VAD, it auto-ends on silence ──
  async function tapToggle() {
    if (busy || micState === 'transcribing' || micState === 'arming') return;
    if (micState === 'armed' || micState === 'capturing') {   // tap again = cancel
      await tapVad.current?.disarm();
      tapVad.current = null;
      setMicState('idle');
      return;
    }
    speaker.enable();               // reserve the audio context in the gesture
    if (!speech) { setSpeech(true); localStorage.setItem('nova.speech', '1'); }
    await startVadCapture();
  }

  // ── wake word: listen hands-free; the trigger arms a VAD capture ──
  async function resumeWake() {
    if (!wakeOn.current || !wakeRef.current) { setMicState('idle'); return; }
    try { await wakeRef.current.start(); setMicState('wake'); }
    catch (err) {
      // say so — dying silently here is "wake worked once, then never again"
      wakeOn.current = false;
      setMicState('idle');
      setItems(prev => [...prev, { id: uid(), kind: 'error',
        content: `Wake listening could not resume: ${errText(err)} — click the mic to restart it.` }]);
    }
  }

  async function onWake() {
    speaker.cancel();                    // barge-in: stop any current reply
    await wakeRef.current?.stop();        // release the wake mic while capturing
    // capture the command, then re-listen; if nothing is said within 10 s
    // (false fire), give up on the capture and resume wake listening
    await startVadCapture(resumeWake, 10_000);
  }

  async function wakeToggle() {
    if (micState === 'arming' || micState === 'transcribing') return;
    if (wakeOn.current) {                 // turn off
      wakeOn.current = false;
      await wakeRef.current?.stop();
      wakeRef.current = null;
      setMicState('idle');
      return;
    }
    speaker.enable();
    if (!speech) { setSpeech(true); localStorage.setItem('nova.speech', '1'); }
    setMicState('arming');
    try {
      const { WakeWord } = await import('../voice/wake');
      const w = wakeRef.current ?? await WakeWord.create({
        model: wakeWord.current, threshold: wakeThreshold.current, onWake });
      wakeRef.current = w;
      wakeOn.current = true;
      await w.start();
      setMicState('wake');
    } catch (err) {
      wakeOn.current = false; wakeRef.current = null;
      setMicState('idle');
      setItems(prev => [...prev, { id: uid(), kind: 'error',
        content: `Wake word unavailable: ${errText(err)}` }]);
    }
  }

  // push-to-talk: hold the mic, speak, release → transcribe → voice turn.
  async function pttStart(e: React.PointerEvent) {
    if (busy || micState !== 'idle') return;
    // release fires on this element even if the pointer drifts off it
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* non-fatal */ }
    speaker.enable();               // reserve the audio context in the gesture
    if (!speech) { setSpeech(true); localStorage.setItem('nova.speech', '1'); }
    try {
      await mic.current.start();
      setMicState('recording');
    } catch (err) {
      setItems(prev => [...prev, { id: uid(), kind: 'error',
        content: `Microphone unavailable: ${errText(err)}` }]);
    }
  }

  async function pttEnd() {
    if (micState !== 'recording') { mic.current.cancel(); return; }
    try {
      const blob = await mic.current.stop();
      await submitUtterance(blob);
    } catch (err) {
      setMicState('idle');
      setItems(prev => [...prev, { id: uid(), kind: 'error',
        content: `Recording failed: ${errText(err)}` }]);
    }
  }

  useEffect(() => {
    speaker.onChange = setVoiceState;
    return () => { speaker.onChange = undefined; };
  }, []);

  useEffect(() => {
    getModels().then(setModels).catch(() => {});
    getAgents().then(agents => {
      const main = agents.find(a => a.name === 'main');
      if (main) setMainAgent({ id: main.id, model: main.model });
    }).catch(() => {});
  }, []);

  async function changeModel(model: string) {
    if (!mainAgent) return;
    try {
      await patchAgent(mainAgent.id, { model });
      setMainAgent({ ...mainAgent, model });
    } catch (err) {
      console.error('model change failed:', err);
    }
  }

  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      if (!resizing.current) return;
      const w = Math.min(MAX_W, Math.max(MIN_W, window.innerWidth - e.clientX));
      onWidthChange(w);
    };
    const onUp = () => { resizing.current = false; document.body.style.cursor = ''; };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
  }, [onWidthChange]);

  useEffect(() => {
    (async () => {
      try {
        const conv = await getActiveConversation();
        setConversationId(conv.id);
        const msgs = await getMessages(conv.id);
        setItems(msgs.map((m): Item => m.role === 'tool'
          ? {
              id: m.id, kind: 'activity', fromHistory: true,
              activity: {
                kind: m.tool_calls?.kind ?? 'tool_result',
                name: m.tool_calls?.name ?? '',
                agent: m.tool_calls?.agent,
                detail: m.content,
              },
            }
          : { id: m.id, kind: 'msg', role: m.role, content: m.content }));
      } catch (err) {
        setItems([{ id: uid(), kind: 'error', content: `Failed to load history: ${err}` }]);
      }
    })();
  }, []);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [items]);

  async function send(opts?: { text?: string; source?: string; speak?: boolean }) {
    const message = (opts?.text ?? input).trim();
    if (!message || busy) return;
    if (opts?.text === undefined) setInput('');   // voice passes its own text
    setBusy(true);
    // voice turns speak the reply even if the mute toggle is off
    const speakThisTurn = opts?.speak ?? speech;

    setItems(prev => [...prev, { id: uid(), kind: 'msg', role: 'user', content: message }]);
    const assistantId = uid();
    setItems(prev => [...prev, { id: assistantId, kind: 'msg', role: 'assistant', content: '', streaming: true }]);

    speaker.cancel();               // a new turn silences the previous one
    if (speakThisTurn) speaker.enable();   // gesture-adjacent — covers autoplay

    const appendToAssistant = (text: string) =>
      setItems(prev => prev.map(it =>
        it.id === assistantId && it.kind === 'msg' ? { ...it, content: it.content + text } : it));

    try {
      for await (const event of streamChat(message, conversationId ?? undefined, opts?.source)) {
        if (event.type === 'text') {
          appendToAssistant(event.text);
          if (speakThisTurn) speaker.feed(event.text);
        } else if (event.type === 'activity') {
          // insert activity line just before the streaming assistant bubble
          setItems(prev => {
            const idx = prev.findIndex(it => it.id === assistantId);
            const line: Item = { id: uid(), kind: 'activity', activity: event.activity };
            return idx < 0 ? [...prev, line]
              : [...prev.slice(0, idx), line, ...prev.slice(idx)];
          });
        } else if (event.type === 'error') {
          setItems(prev => [...prev, { id: uid(), kind: 'error', content: event.error }]);
        } else if (event.type === 'done') {
          break;
        }
      }
    } catch (err) {
      setItems(prev => [...prev, { id: uid(), kind: 'error', content: String(err) }]);
    } finally {
      if (speakThisTurn) speaker.flush();   // speak whatever the last sentence held
      setItems(prev => prev
        .map(it => it.id === assistantId && it.kind === 'msg' ? { ...it, streaming: false } : it)
        .filter(it => !(it.id === assistantId && it.kind === 'msg' && !it.content)));
      setBusy(false);
      inputRef.current?.focus();
    }
  }

  return (
    <aside
      className="absolute top-0 right-0 bottom-0 bg-stone-900/95 backdrop-blur border-l border-stone-700 flex flex-col shadow-2xl"
      style={{ width }}
    >
      {/* drag handle — widen/narrow the chat (desktop only) */}
      {!mobile && (
        <div
          className="absolute left-0 top-0 bottom-0 w-1.5 cursor-col-resize hover:bg-teal-700/50 transition-colors"
          onPointerDown={() => { resizing.current = true; document.body.style.cursor = 'col-resize'; }}
          onDoubleClick={() => onWidthChange(384)}
          title="Drag to resize (double-click to reset)"
        />
      )}
      <header className="px-4 py-3 border-b border-stone-700 flex items-center justify-between gap-2">
        <span className="flex items-center gap-2 shrink-0">
          <span className="text-teal-400 font-semibold">{assistantName}</span>
          {mobile && onShowBrain && (
            <button
              onClick={onShowBrain}
              className="text-base leading-none px-1.5 py-0.5 rounded border border-stone-700 text-stone-400"
              title="Show the brain"
              aria-label="Show the brain"
            >
              🧠
            </button>
          )}
        </span>
        <div className="flex items-center gap-2 min-w-0">
          {mainAgent && models.length > 0 && (
            <select
              value={mainAgent.model}
              onChange={e => changeModel(e.target.value)}
              className="min-w-0 max-w-[11rem] truncate bg-stone-800 border border-stone-700 rounded px-1.5 py-0.5 text-[11px] text-stone-400 hover:text-stone-200"
              title="Model for the main agent (applies next message)"
            >
              {models.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
              {!models.some(m => m.id === mainAgent.model) && (
                <option value={mainAgent.model}>{mainAgent.model}</option>
              )}
            </select>
          )}
          {speech && voiceState.speaking && (
            <>
              <button
                onClick={() => (voiceState.paused ? speaker.resume() : speaker.pause())}
                className="text-base leading-none px-1.5 py-0.5 rounded border border-teal-700 text-teal-400"
                title={voiceState.paused ? 'Resume speaking' : 'Pause speaking'}
                aria-label={voiceState.paused ? 'Resume speaking' : 'Pause speaking'}
              >
                {voiceState.paused ? '▶️' : '⏸️'}
              </button>
              <button
                onClick={() => speaker.cancel()}
                className="text-base leading-none px-1.5 py-0.5 rounded border border-stone-700 text-stone-400 hover:text-red-400"
                title="Stop speaking (skip the rest)"
                aria-label="Stop speaking"
              >
                ⏹️
              </button>
            </>
          )}
          <button
            onClick={toggleSpeech}
            className={`text-base leading-none px-1.5 py-0.5 rounded border ${
              speech ? 'border-teal-700 text-teal-400' : 'border-stone-700 text-stone-500'}`}
            title={speech ? `${assistantName} speaks replies aloud — click to mute`
                          : 'Speak replies aloud (needs the voice compose profile)'}
            aria-label={speech ? 'Mute spoken replies' : 'Speak replies aloud'}
          >
            {speech ? '🔊' : '🔇'}
          </button>
          <span className="text-xs text-stone-500 shrink-0">{busy ? 'thinking…' : 'ready'}</span>
        </div>
      </header>

      <div className="flex-1 overflow-y-auto overflow-x-hidden nice-scroll p-4 space-y-2">
        {items.length === 0 && (
          <div className="text-center text-stone-500 mt-10">
            <p className="text-base font-medium text-stone-400">Talk to {assistantName}</p>
            <p className="text-sm mt-1">One continuous conversation — it remembers.</p>
          </div>
        )}

        {renderGrouped(items)}
        <div ref={endRef} />
      </div>

      <form
        onSubmit={e => { e.preventDefault(); send(); }}
        className="border-t border-stone-700 p-3 flex items-end gap-2"
      >
        <textarea
          ref={inputRef}
          rows={1}
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
          disabled={busy}
          placeholder="Message Nova…"
          title="Enter to send, Shift+Enter for a new line"
          className="flex-1 resize-none overflow-y-auto nice-scroll bg-stone-800 text-white placeholder-stone-500 rounded px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-teal-500 disabled:opacity-50"
        />
        <button
          type="button"
          onClick={listenMode === 'tap' ? tapToggle : listenMode === 'wake' ? wakeToggle : undefined}
          onPointerDown={listenMode === 'ptt' ? pttStart : undefined}
          onPointerUp={listenMode === 'ptt' ? pttEnd : undefined}
          onPointerCancel={listenMode === 'ptt' ? pttEnd : undefined}
          disabled={micState === 'transcribing' || micState === 'arming'}
          title={listenMode === 'wake'
            ? (micState === 'wake' ? `Listening for “${wakeLabel(wakeWord.current)}” — click to stop`
              : micState === 'armed' ? 'Wake word heard — speak now'
              : micState === 'capturing' ? 'Heard you — capturing…'
              : micState === 'arming' ? 'Loading wake word…'
              : `Click to listen hands-free for “${wakeLabel(wakeWord.current)}”`)
            : listenMode === 'tap'
            ? (micState === 'armed' ? 'Listening — tap to cancel'
              : micState === 'capturing' ? 'Hearing you…'
              : micState === 'arming' ? 'Loading speech detector…'
              : 'Tap to talk (auto-stops when you pause)')
            : (micState === 'recording' ? 'Recording — release to send' : 'Hold to talk')}
          aria-label={listenMode === 'wake' ? 'Wake word' : listenMode === 'tap' ? 'Tap to talk' : 'Hold to talk'}
          className={`px-3 py-2 rounded text-sm transition select-none touch-none ${
            micState === 'recording' || micState === 'capturing'
              ? 'bg-red-600 text-white animate-pulse'
              : micState === 'armed' || micState === 'wake'
                ? 'bg-teal-700 text-teal-100 animate-pulse'
                : 'bg-stone-700 hover:bg-stone-600 text-stone-200 disabled:opacity-50'}`}
        >
          {micState === 'transcribing' ? '…' : micState === 'arming' ? '⏳'
            : listenMode === 'wake' && micState === 'wake' ? '👂' : '🎤'}
        </button>
        <button
          type="submit"
          disabled={busy || !input.trim()}
          className="px-4 py-2 bg-teal-600 hover:bg-teal-500 disabled:bg-stone-700 disabled:text-stone-500 text-white rounded text-sm transition"
        >
          Send
        </button>
      </form>
    </aside>
  );
}
