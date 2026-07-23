import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  streamChat, getActiveConversation, getAgents, getMessages, getModels,
  patchAgent, getPendingConsents, decideConsent, Activity, Consent,
  ModelInfo, TraceSummary,
  getRecCards, decideRecCard, RecCard,
} from '../api';
import { Markdown } from '../components/Markdown';
import { TurnInspector } from './TurnInspector';
import { VoiceOverlay } from './VoiceOverlay';
import { agentDisplayName, displayName } from '../names';
import { speaker } from '../voice/speech';
import { Mic } from '../voice/mic';
import { transcribeSpeech, getSettings } from '../api';
import type { TapVad } from '../voice/vad';
import type { WakeWord } from '../voice/wake';
import { wakeLabel, DEFAULT_WAKE } from '../voice/wakeCatalog';
import { useAssistantName } from '../useAssistantName';

/** An attachment as the message list shows it — preview only exists for
 *  images picked this session (history rows come back name-only). */
interface UiAttachment { kind: 'image' | 'text'; name: string; mime: string; preview?: string }
/** A picked-but-not-yet-sent attachment; data = base64 (image) or file text. */
interface PendingAttachment extends UiAttachment { data: string }

type Item =
  | { id: string; kind: 'msg'; role: 'user' | 'assistant'; content: string;
      streaming?: boolean; trace?: TraceSummary; attachments?: UiAttachment[] }
  | { id: string; kind: 'activity'; activity: Activity; fromHistory?: boolean }
  | { id: string; kind: 'error'; content: string }
  | { id: string; kind: 'consent'; consent: Consent; decided?: 'approve' | 'deny' };

type ConsentItem = Extract<Item, { kind: 'consent' }>;
type OnConsent = (item: ConsentItem, chosen: 'approve' | 'deny') => void;

// the duration chip under an assistant message — click opens the Turn Inspector
const chipLabel = (t: TraceSummary): string => {
  const parts = [t.secs !== null ? `${t.secs < 10 ? t.secs.toFixed(1) : Math.round(t.secs)}s` : '—'];
  if (t.tools) parts.push(`${t.tools} tool${t.tools > 1 ? 's' : ''}`);
  if (t.dispatches) parts.push(`${t.dispatches} dispatch${t.dispatches > 1 ? 'es' : ''}`);
  if (t.status !== 'ok') parts.push(t.status);
  return parts.join(' · ');
};

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

// Camera shots are huge; vision models don't need them. Longest edge capped
// at 1568px (the common provider sweet spot), re-encoded as JPEG.
async function downscaleImage(f: File): Promise<{ data: string; mime: string; preview: string }> {
  const url = URL.createObjectURL(f);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = () => reject(new Error('unreadable image'));
      i.src = url;
    });
    const scale = Math.min(1, 1568 / Math.max(img.width, img.height));
    const w = Math.max(1, Math.round(img.width * scale));
    const h = Math.max(1, Math.round(img.height * scale));
    const canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    canvas.getContext('2d')!.drawImage(img, 0, 0, w, h);
    const dataUrl = canvas.toDataURL('image/jpeg', 0.85);
    return { data: dataUrl.split(',')[1], mime: 'image/jpeg', preview: dataUrl };
  } finally {
    URL.revokeObjectURL(url);
  }
}

// presence bridge for the mic: the orb (canvas + voice overlay) draws
// "listening" while a capture is armed or recording
const emitListening = (on: boolean) =>
  window.dispatchEvent(new CustomEvent('nova:chat-activity',
    { detail: { active: on, kind: 'listening' } }));

function renderItem(item: Item, onInspect?: (traceId: string) => void,
                    onConsent?: OnConsent, mobile?: boolean) {
  if (item.kind === 'consent') {
    // an agent (via request_operator_confirmation) is asking the OPERATOR
    // to decide a guarded action — roadmap #29's card
    const c = item.consent;
    const decided = item.decided
      ?? (c.status === 'decided' ? (c.chosen as 'approve' | 'deny') : undefined);
    return (
      <div key={item.id} className="text-sm bg-indigo-950/40 border border-indigo-800 rounded-lg px-3 py-2.5 space-y-2">
        <div className="text-[11px] uppercase tracking-wide text-indigo-300/80">
          {agentDisplayName(c.requested_by)} asks for your decision
        </div>
        <div className="text-stone-100">{c.question}</div>
        <div className="text-xs text-stone-400 font-mono">{c.kind} · {c.subject}</div>
        {/* authoritative facts from the DB — what approving actually
            touches; the agent cannot word its way around this block */}
        {c.rule === null ? (
          <div className="text-xs text-amber-400">This rule no longer exists.</div>
        ) : c.rule && (
          <div className="text-xs bg-stone-900/70 border border-stone-700 rounded px-2 py-1.5 space-y-0.5">
            <div className="text-stone-300">{c.rule.description || 'No description.'}</div>
            <div className="font-mono text-stone-400 break-all">pattern: {c.rule.pattern}</div>
            <div className="text-stone-400">
              {c.rule.action} · {c.rule.target_tools?.join(', ') || 'all tools'} ·
              {c.rule.enabled ? ' enabled' : ' disabled'} · hits: {c.rule.hit_count}
            </div>
          </div>
        )}
        {decided ? (
          <div className={`text-xs font-semibold ${decided === 'approve' ? 'text-teal-400' : 'text-stone-400'}`}>
            {decided === 'approve' ? 'Approved' : 'Denied'}
          </div>
        ) : (
          <div className="flex gap-2">
            <button
              onClick={() => onConsent?.(item, 'approve')}
              className="px-3 py-1 rounded bg-teal-700 hover:bg-teal-600 text-white text-xs font-medium"
            >
              Approve
            </button>
            <button
              onClick={() => onConsent?.(item, 'deny')}
              className="px-3 py-1 rounded bg-stone-700 hover:bg-stone-600 text-stone-200 text-xs font-medium"
            >
              Deny
            </button>
          </div>
        )}
      </div>
    );
  }
  if (item.kind === 'activity') {
    if (item.activity.kind === 'narration') {
      return (
        <div key={item.id} className={`text-xs text-amber-300 bg-amber-950/40 border border-amber-800 rounded px-2.5 py-1.5 ${item.fromHistory ? 'opacity-75' : ''}`}>
          ⚠ {agentDisplayName(item.activity.name)} announced an action but
          called no tool — the described work did <b>not</b> happen.
        </div>
      );
    }
    if (item.activity.kind === 'agent_reply') {
      // the specialist's reply back to Nova — collapsed to one line,
      // expandable to the (near-)full text
      return (
        <details key={item.id} className="text-xs font-mono px-1">
          <summary className="text-amber-400/80 cursor-pointer select-none">
            ← {agentDisplayName(item.activity.name)} replied…
          </summary>
          <div className="mt-1 ml-3 px-2 py-1.5 whitespace-pre-wrap break-words font-sans text-stone-300 bg-stone-800/60 border-l border-stone-700 rounded-r">
            {item.activity.detail}
          </div>
        </details>
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
  // phones follow the mockup register: the user speaks in a quiet pill, the
  // assistant answers as plain text on the dark ground — no bubble
  const bubble = item.role === 'user'
    ? (mobile ? 'bg-stone-800 text-stone-100 whitespace-pre-wrap rounded-2xl'
              : 'bg-teal-700 text-white whitespace-pre-wrap rounded-lg')
    : (mobile ? 'text-stone-100' : 'bg-stone-800 text-stone-100 rounded-lg');
  return (
    <div key={item.id} className={`flex ${item.role === 'user' ? 'justify-end' : 'justify-start'}`}>
      <div className={`${mobile && item.role === 'assistant' ? 'max-w-full' : 'max-w-[85%]'} min-w-0 flex flex-col`}>
        {item.attachments && item.attachments.length > 0 && (
          <div className={`flex flex-wrap gap-1.5 mb-1 ${item.role === 'user' ? 'justify-end' : ''}`}>
            {item.attachments.map((a, i) => a.kind === 'image' && a.preview ? (
              <img key={i} src={a.preview} alt={a.name}
                className="max-h-40 max-w-[12rem] rounded-xl border border-stone-700 object-cover" />
            ) : (
              <span key={i} className="inline-flex items-center gap-1.5 text-[11px] bg-stone-800 border border-stone-700 rounded-full px-2.5 py-1 text-stone-300">
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                  strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  {a.kind === 'image'
                    ? <><rect x="3" y="3" width="18" height="18" rx="2" /><circle cx="8.5" cy="8.5" r="1.5" /><path d="M21 15l-5-5L5 21" /></>
                    : <><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><path d="M14 2v6h6" /></>}
                </svg>
                <span className="truncate max-w-[10rem]">{a.name}</span>
              </span>
            ))}
          </div>
        )}
        <div className={`break-words px-3 py-2 text-sm ${bubble}`}>
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
        {item.role === 'assistant' && item.trace && !item.streaming && (
          <button
            onClick={() => onInspect?.(item.trace!.id)}
            className={`self-start mt-0.5 px-1 text-[10px] font-mono transition-colors ${
              item.trace.status === 'ok'
                ? 'text-stone-500 hover:text-teal-400'
                : 'text-red-400/80 hover:text-red-300'}`}
            title="Inspect this turn — timings, tools, tokens"
          >
            {chipLabel(item.trace)}
          </button>
        )}
      </div>
    </div>
  );
}

/** Past turns' activity trail collapses into a dim expandable trace so it's
 *  reviewable without competing with the conversation; narration warnings
 *  stay visible (dimmed). Live activity renders inline as it happens. */
function renderGrouped(items: Item[], onInspect?: (traceId: string) => void,
                       onConsent?: OnConsent, mobile?: boolean) {
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
          {trace.map(it => renderItem(it))}
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
      blocks.push(renderItem(item, onInspect, onConsent, mobile));
    }
  }
  flush();
  return blocks;
}

const activityLabel = (a: Activity): string => {
  switch (a.kind) {
    case 'dispatch': return `→ dispatching to ${agentDisplayName(a.name)}`;
    case 'tool_start': return `⚙ ${a.agent ? `${agentDisplayName(a.agent)}: ` : ''}${displayName(a.name)}…`;
    case 'tool_result': return `✓ ${displayName(a.name)}`;
    default: return displayName(a.name);
  }
};

interface ChatPanelProps {
  width: number;
  onWidthChange: (w: number) => void;
  mobile?: boolean;
  onShowBrain?: () => void;
  /** Settings overlay open state — the model list is re-fetched whenever this
   *  closes, so a model approved in Settings is immediately pickable here
   *  without a page reload. */
  settingsOpen?: boolean;
}

const MIN_W = 320;
const MAX_W = 760;

export function ChatPanel({ width, onWidthChange, mobile, onShowBrain, settingsOpen }: ChatPanelProps) {
  const [items, setItems] = useState<Item[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  // follow-ups typed while Nova is still replying: queued and auto-sent FIFO
  // when the current turn finishes; "interject" jumps the queue and cuts the
  // reply short. abortRef cancels the in-flight turn for that interruption.
  const [queue, setQueue] = useState<string[]>([]);
  const abortRef = useRef<AbortController | null>(null);
  // proactive recommendation cards Nova/automations raised (keystone)
  const [recs, setRecs] = useState<RecCard[]>([]);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [inspectTraceId, setInspectTraceId] = useState<string | null>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const resizing = useRef(false);
  const navigate = useNavigate();

  // ── attachments: picked files waiting in the composer ──
  const [pending, setPending] = useState<PendingAttachment[]>([]);
  const [attachOpen, setAttachOpen] = useState(false);
  const cameraInputRef = useRef<HTMLInputElement>(null);
  const photoInputRef = useRef<HTMLInputElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  // phone chrome: the nav drawer and the full-screen voice mode
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [voiceOpen, setVoiceOpen] = useState(false);
  const voiceOpenRef = useRef(false);

  async function addFiles(list: FileList | File[] | null) {
    if (!list) return;
    for (const f of Array.from(list)) {
      try {
        if (f.type.startsWith('image/')) {
          const { data, mime, preview } = await downscaleImage(f);
          setPending(p => [...p, { kind: 'image', name: f.name || 'photo.jpg', mime, data, preview }]);
        } else if (f.size <= 512 * 1024) {
          const body = await f.text();
          // real binaries decode to replacement chars — refuse them honestly
          if (/�/.test(body.slice(0, 2000))) throw new Error('not a text file');
          setPending(p => [...p, { kind: 'text', name: f.name, mime: f.type || 'text/plain', data: body }]);
        } else {
          throw new Error('too large (512 KB limit for files)');
        }
      } catch (err) {
        setItems(prev => [...prev, { id: uid(), kind: 'error',
          content: `Couldn't attach ${f.name}: ${errText(err)} — images and text files work.` }]);
      }
    }
  }

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
  useEffect(() => () => mic.current.dispose(), []);   // release the device on unmount
  const tapVad = useRef<TapVad | null>(null);
  const vadSilenceMs = useRef(1100);
  const wakeRef = useRef<WakeWord | null>(null);
  const wakeOn = useRef(false);
  const wakeThreshold = useRef(0.5);
  const wakeWord = useRef(DEFAULT_WAKE);
  const followupS = useRef(8);        // conversation mode: 0 = off
  const inFollowup = useRef(false);   // current VAD arm is a follow-up window
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
      const fw = defs.find(d => d.key === 'voice.followup_window_s')?.value;
      if (typeof fw === 'number') followupS.current = fw;
    }).catch(() => {});
    const onChange = (e: Event) => {
      const { key, value } = (e as CustomEvent).detail as { key: string; value: unknown };
      if (key === 'voice.listen_mode' && isMode(value)) setListenMode(value);
      if (key === 'voice.vad_silence_ms' && typeof value === 'number') vadSilenceMs.current = value;
      if (key === 'voice.wake_threshold' && typeof value === 'number') wakeThreshold.current = value;
      if (key === 'voice.wake_word' && typeof value === 'string' && value) wakeWord.current = value;
      if (key === 'voice.followup_window_s' && typeof value === 'number') followupS.current = value;
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
  // afterSubmit(captured): true = an utterance was captured and submitted,
  // false = timeout/failure — conversation mode branches on it.
  async function startVadCapture(afterSubmit?: (captured: boolean) => void | Promise<void>,
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
            emitListening(false);
            await submitUtterance(wav);
            await afterSubmit?.(true);
          }, 0);
        },
      }, { silenceMs: vadSilenceMs.current });
      setMicState(s => (s === 'arming' ? 'armed' : s));
      emitListening(true);
      if (armTimeoutMs) {
        armTimer = window.setTimeout(async () => {
          if (tapVad.current !== v) return;      // already captured/cancelled
          await v.disarm();
          tapVad.current = null;
          emitListening(false);
          await afterSubmit?.(false);             // back to wake listening
        }, armTimeoutMs);
      }
    } catch (err) {
      tapVad.current = null;
      setMicState('idle');
      emitListening(false);
      setItems(prev => [...prev, { id: uid(), kind: 'error',
        content: `Voice detector unavailable: ${errText(err)}` }]);
      await afterSubmit?.(false);
    }
  }

  // ── tap-to-talk: tap arms the VAD, it auto-ends on silence ──
  async function tapToggle() {
    if (busy || micState === 'transcribing' || micState === 'arming') return;
    if (micState === 'armed' || micState === 'capturing') {   // tap again = cancel
      await tapVad.current?.disarm();
      tapVad.current = null;
      setMicState('idle');
      emitListening(false);
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

  // ── conversation mode: after a captured voice turn, keep the conversation
  // open — wake listening resumes DURING Nova's reply (barge-in stays live),
  // then once she finishes speaking the VAD arms directly for a follow-up
  // window: just talk, no wake phrase. Silence closes it back to wake-only.
  async function voiceTurnDone(captured: boolean) {
    inFollowup.current = false;
    if (!wakeOn.current || !wakeRef.current) { setMicState('idle'); return; }
    if (!captured || followupS.current <= 0) { await resumeWake(); return; }
    await resumeWake();                              // barge-in while she talks
    while (speaker.speaking) {                       // let the reply finish
      await new Promise(r => setTimeout(r, 200));
      if (!wakeOn.current) return;                   // toggled off mid-reply
    }
    // a barge-in mid-reply already started its own capture — don't double-arm
    if (tapVad.current || !wakeOn.current || !wakeRef.current) return;
    await wakeRef.current.stop();
    inFollowup.current = true;
    await startVadCapture(voiceTurnDone, followupS.current * 1000);
  }

  async function onWake() {
    speaker.cancel();                    // barge-in: stop any current reply
    await wakeRef.current?.stop();        // release the wake mic while capturing
    inFollowup.current = false;
    // capture the command, then hand off to conversation mode; if nothing is
    // said within 10 s (false fire), give up and resume wake listening
    await startVadCapture(voiceTurnDone, 10_000);
  }

  async function wakeToggle() {
    if (micState === 'arming' || micState === 'transcribing') return;
    if (wakeOn.current) {                 // turn off
      wakeOn.current = false;
      inFollowup.current = false;
      await tapVad.current?.disarm();     // an open follow-up window holds the mic
      tapVad.current = null;
      await wakeRef.current?.stop();
      wakeRef.current = null;
      setMicState('idle');
      emitListening(false);
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

  // ── voice mode: the full-screen overlay (phone mic button) ──
  // A continuous conversation loop with no wake phrase: capture → transcribe
  // → send (spoken reply) → once she finishes speaking, listen again. Closing
  // the overlay tears the loop down; the mic button inside it mutes/unmutes.
  async function voiceLoopDone(_captured: boolean) {
    if (!voiceOpenRef.current) { emitListening(false); return; }
    while (speaker.speaking) {                     // let the reply finish
      await new Promise(r => setTimeout(r, 200));
      if (!voiceOpenRef.current) return;
    }
    if (!voiceOpenRef.current || tapVad.current) return;   // muted or re-armed
    await startVadCapture(voiceLoopDone);
  }

  async function openVoice() {
    speaker.enable();               // inside the tap gesture — autoplay policy
    if (!speech) { setSpeech(true); localStorage.setItem('nova.speech', '1'); }
    setVoiceOpen(true);
    voiceOpenRef.current = true;
    // take the mic over from any other capture mode
    await tapVad.current?.disarm();
    tapVad.current = null;
    await wakeRef.current?.stop();
    await startVadCapture(voiceLoopDone);
  }

  async function closeVoice() {
    voiceOpenRef.current = false;
    setVoiceOpen(false);
    await tapVad.current?.disarm();
    tapVad.current = null;
    speaker.cancel();
    setMicState('idle');
    emitListening(false);
    if (wakeOn.current) void resumeWake();   // hand the mic back to hands-free
  }

  async function voiceMicToggle() {
    if (micState === 'armed' || micState === 'capturing') {   // mute
      await tapVad.current?.disarm();
      tapVad.current = null;
      setMicState('idle');
      emitListening(false);
    } else if (micState === 'idle') {                          // unmute
      await startVadCapture(voiceLoopDone);
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
      emitListening(true);
    } catch (err) {
      setItems(prev => [...prev, { id: uid(), kind: 'error',
        content: `Microphone unavailable: ${errText(err)}` }]);
    }
  }

  async function pttEnd() {
    emitListening(false);
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

  // Fetch on mount and every time the Settings overlay closes — approving a
  // model in Settings must make it immediately selectable here (the picker
  // used to be frozen at page-load, so newly approved models never appeared).
  useEffect(() => {
    if (settingsOpen) return;
    getModels().then(setModels).catch(() => {});
    getAgents().then(agents => {
      const main = agents.find(a => a.name === 'main');
      if (main) setMainAgent({ id: main.id, model: main.model });
    }).catch(() => {});
  }, [settingsOpen]);

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

  // pending consent cards (roadmap #29) — appended for any consent not
  // already shown; called on load and after every turn
  const loadConsents = async (convId?: string | null) => {
    const id = convId ?? conversationId;
    if (!id) return;
    try {
      const pending = await getPendingConsents(id);
      setItems(prev => {
        const shown = new Set(prev
          .filter((it): it is ConsentItem => it.kind === 'consent')
          .map(it => it.consent.id));
        const fresh = pending
          .filter(c => !shown.has(c.id))
          .map((c): Item => ({ id: `consent-${c.id}`, kind: 'consent', consent: c }));
        return fresh.length ? [...prev, ...fresh] : prev;
      });
    } catch { /* cards are best-effort; the next turn retries */ }
  };

  // proactive recommendation cards — loaded on mount, after each turn (a turn
  // may raise one), and polled so background automations surface without a turn
  // the inbox: everything actionable (snoozed included) + 30d of decided.
  // Fetched when the bell opens, kept in sync with decisions after that.
  const [inbox, setInbox] = useState<RecCard[] | null>(null);
  const [inboxOpen, setInboxOpen] = useState(false);
  const [inboxExpanded, setInboxExpanded] = useState<string | null>(null);

  const loadInbox = async () => {
    try { setInbox(await getRecCards('all')); } catch { /* best-effort */ }
  };
  const toggleInbox = () => {
    setInboxOpen(open => {
      if (!open) void loadInbox();
      return !open;
    });
  };

  // push deep link: a recommendation notification opens /chat?inbox=open —
  // land with the inbox already up, then clean the param off the URL
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get('inbox') !== 'open') return;
    setInboxOpen(true);
    void loadInbox();
    params.delete('inbox');
    const qs = params.toString();
    window.history.replaceState(null, '',
      window.location.pathname + (qs ? `?${qs}` : ''));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const loadRecs = async () => {
    try { setRecs(await getRecCards('new')); } catch { /* best-effort */ }
  };
  useEffect(() => {
    loadRecs();
    const iv = setInterval(loadRecs, 60000);
    return () => clearInterval(iv);
  }, []);
  async function decideRec(rec: RecCard, choice: 'approve' | 'later' | 'dismiss') {
    setRecs(prev => prev.filter(r => r.id !== rec.id));   // optimistic
    try {
      const updated = await decideRecCard(rec.id, choice);
      setInbox(prev => prev && prev.map(r => r.id === rec.id ? updated : r));
    } catch {
      void loadRecs();                                    // reconcile on failure
      if (inboxOpen) void loadInbox();
    }
  }

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
          : { id: m.id, kind: 'msg', role: m.role, content: m.content,
              trace: m.trace ?? undefined,
              attachments: m.attachments?.map(a => ({ kind: a.kind, name: a.name, mime: a.mime })) }));
        void loadConsents(conv.id);
      } catch (err) {
        setItems([{ id: uid(), kind: 'error', content: `Failed to load history: ${err}` }]);
      }
    })();
  }, []);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [items]);

  // #7's ChatPanel half: presence views (the orb) listen for these events
  const emitPresence = (active: boolean, kind?: 'thinking' | 'dispatch' | 'tool') =>
    window.dispatchEvent(new CustomEvent('nova:chat-activity', { detail: { active, kind } }));

  async function send(opts?: { text?: string; source?: string; speak?: boolean }) {
    const message = (opts?.text ?? input).trim();
    // composer sends carry the picked attachments; voice/queued turns don't
    const atts = opts?.text === undefined ? pending : [];
    if ((!message && atts.length === 0) || busy) return;
    if (opts?.text === undefined) { setInput(''); setPending([]); }
    setBusy(true);
    const ac = new AbortController();   // interject aborts this turn
    abortRef.current = ac;
    emitPresence(true, 'thinking');
    let lastPresence = Date.now();
    // voice turns speak the reply even if the mute toggle is off
    const speakThisTurn = opts?.speak ?? speech;

    setItems(prev => [...prev, { id: uid(), kind: 'msg', role: 'user', content: message,
      attachments: atts.length
        ? atts.map(({ kind, name, mime, preview }) => ({ kind, name, mime, preview }))
        : undefined }]);
    const assistantId = uid();
    setItems(prev => [...prev, { id: assistantId, kind: 'msg', role: 'assistant', content: '', streaming: true }]);

    speaker.cancel();               // a new turn silences the previous one
    if (speakThisTurn) speaker.enable();   // gesture-adjacent — covers autoplay

    const appendToAssistant = (text: string) =>
      setItems(prev => prev.map(it =>
        it.id === assistantId && it.kind === 'msg' ? { ...it, content: it.content + text } : it));

    // live turn-ledger summary for the duration chip: trace id arrives in
    // meta, duration/counts are measured client-side (the inspector fetches
    // the authoritative trace on click)
    const turnStart = Date.now();
    let liveTraceId: string | null = null;
    let liveTools = 0;
    let liveDispatches = 0;

    try {
      for await (const event of streamChat(message, conversationId ?? undefined, opts?.source, ac.signal,
                                           atts.map(({ kind, name, mime, data }) => ({ kind, name, mime, data })))) {
        if (event.type === 'meta') {
          liveTraceId = event.traceId ?? null;
        } else if (event.type === 'text') {
          appendToAssistant(event.text);
          if (speakThisTurn) speaker.feed(event.text);
          if (Date.now() - lastPresence > 5000) {   // long streams stay "thinking"
            emitPresence(true, 'thinking');
            lastPresence = Date.now();
          }
        } else if (event.type === 'activity') {
          if (event.activity.kind === 'tool_start') {
            liveTools++;
            emitPresence(true, 'tool');
            lastPresence = Date.now();
          }
          if (event.activity.kind === 'dispatch') {
            liveDispatches++;
            emitPresence(true, 'dispatch');
            lastPresence = Date.now();
          }
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
      // an intentional interject cancels the fetch — keep the partial reply,
      // no error card (the interjected message is already queued to send next)
      if (!ac.signal.aborted) {
        setItems(prev => [...prev, { id: uid(), kind: 'error', content: String(err) }]);
      }
    } finally {
      if (abortRef.current === ac) abortRef.current = null;
      emitPresence(false);
      if (speakThisTurn) speaker.flush();   // speak whatever the last sentence held
      const liveTrace: TraceSummary | undefined = liveTraceId ? {
        id: liveTraceId, status: 'ok',
        secs: Math.round((Date.now() - turnStart) / 100) / 10,
        // tool_start also fires for the dispatch call itself — count it once
        tools: Math.max(0, liveTools - liveDispatches),
        dispatches: liveDispatches,
      } : undefined;
      setItems(prev => prev
        .map(it => it.id === assistantId && it.kind === 'msg'
          ? { ...it, streaming: false, trace: liveTrace ?? it.trace } : it)
        .filter(it => !(it.id === assistantId && it.kind === 'msg' && !it.content)));
      setBusy(false);
      inputRef.current?.focus();
      void loadConsents();   // an agent may have asked for a decision this turn
      void loadRecs();       // …or raised a recommendation
    }
  }

  // Enter / Send: send now when idle, otherwise queue the follow-up so it
  // fires automatically when the current reply finishes.
  function submitComposer() {
    const msg = input.trim();
    if (!msg && pending.length === 0) return;
    if (busy) {
      // text queues; attachments wait in the composer for the next idle send
      if (msg) { setQueue(q => [...q, msg]); setInput(''); }
    } else {
      void send();
    }
    inputRef.current?.focus();
  }

  // interject: cut Nova's current reply short and send this message right now
  // (it jumps to the front of the queue; the drain effect dispatches it once
  // the aborted turn unwinds).
  function interject() {
    const msg = input.trim();
    if (!msg || !busy) return;
    setInput('');
    setQueue(q => [msg, ...q]);
    abortRef.current?.abort();
  }

  // drain the queue whenever Nova goes idle — one turn at a time
  const sendRef = useRef(send);
  useEffect(() => { sendRef.current = send; });
  useEffect(() => {
    if (busy || queue.length === 0) return;
    const next = queue[0];
    setQueue(q => q.slice(1));
    void sendRef.current({ text: next });
  }, [busy, queue]);

  // the operator's click: record the decision, then tell Nova in-channel so
  // the requesting agent acts on it (the tool layer re-validates mechanically)
  async function handleConsent(item: ConsentItem, chosen: 'approve' | 'deny') {
    try {
      await decideConsent(item.consent.id, chosen);
    } catch (err) {
      setItems(prev => [...prev, { id: uid(), kind: 'error', content: String(err) }]);
      void loadConsents();   // it may have expired — refresh the cards
      return;
    }
    setItems(prev => prev.map(it =>
      it.id === item.id && it.kind === 'consent' ? { ...it, decided: chosen } : it));
    const c = item.consent;
    void send({
      text: chosen === 'approve'
        ? `I approve consent ${c.id}: ${c.kind} on "${c.subject}". Proceed now.`
        : `I deny consent ${c.id} (${c.kind} on "${c.subject}"). Keep the rule as it is.`,
      source: 'consent',
    });
  }

  return (
    <aside
      className={`absolute top-0 right-0 bottom-0 flex flex-col ${
        mobile ? 'bg-stone-950'
               : 'bg-stone-900/95 backdrop-blur border-l border-stone-700 shadow-2xl'}`}
      // full-bleed phones: keep the header out from under the status bar
      style={{ width, paddingTop: mobile ? 'env(safe-area-inset-top)' : undefined }}
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
      {/* phones: the mockup register — a floating hamburger, the name, the
          bell; everything else (model, speech) lives in the drawer */}
      {mobile && (
        <header className="px-3 py-2 flex items-center gap-2.5">
          <button
            onClick={() => setDrawerOpen(true)}
            aria-label="Menu"
            title="Menu"
            className="w-9 h-9 shrink-0 rounded-full bg-stone-900/80 border border-stone-800 flex items-center justify-center text-stone-300"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
              strokeWidth="2" strokeLinecap="round" aria-hidden="true">
              <path d="M4 8h16M4 14h10" />
            </svg>
          </button>
          <span className="text-stone-200 font-medium truncate">{assistantName}</span>
          <span className="flex-1" />
          <button
            onClick={toggleInbox}
            className={`relative shrink-0 w-9 h-9 rounded-full border flex items-center justify-center ${
              inboxOpen ? 'border-teal-700 text-teal-400 bg-stone-900/80'
              : 'border-stone-800 bg-stone-900/80 text-stone-400'}`}
            title="Recommendations inbox"
            aria-label="Recommendations inbox"
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor"
              strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
              <path d="M13.73 21a2 2 0 0 1-3.46 0" />
            </svg>
            {recs.length > 0 && (
              <span className="absolute -top-1 -right-1 min-w-[14px] h-[14px] px-0.5 rounded-full bg-amber-500 text-stone-950 text-[9px] font-semibold leading-[14px] text-center">
                {recs.length}
              </span>
            )}
          </button>
        </header>
      )}

      {!mobile && (
      <header className="px-4 py-3 border-b border-stone-700 flex items-center justify-between gap-2">
        <span className="flex items-center gap-2 shrink-0">
          <span className="text-teal-400 font-semibold">{assistantName}</span>
        </span>
        <div className="flex items-center gap-2 min-w-0">
          <button
            onClick={toggleInbox}
            className={`relative shrink-0 leading-none px-1.5 py-1 rounded border ${
              inboxOpen ? 'border-teal-700 text-teal-400'
              : 'border-stone-700 text-stone-400 hover:text-teal-300'}`}
            title="Recommendations inbox"
            aria-label="Recommendations inbox"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
              strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
              <path d="M13.73 21a2 2 0 0 1-3.46 0" />
            </svg>
            {recs.length > 0 && (
              <span className="absolute -top-1.5 -right-1.5 min-w-[14px] h-[14px] px-0.5 rounded-full bg-amber-500 text-stone-950 text-[9px] font-semibold leading-[14px] text-center">
                {recs.length}
              </span>
            )}
          </button>
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
      )}

      {/* phone nav drawer — the surfaces the tab bar used to hold, plus the
          model picker and speech toggle the desktop header shows */}
      {mobile && drawerOpen && (
        <div className="fixed inset-0 z-50" onClick={() => setDrawerOpen(false)}>
          <div className="absolute inset-0 bg-black/60" />
          <nav
            className="absolute left-0 top-0 bottom-0 w-72 max-w-[85vw] bg-stone-950 border-r border-stone-800 flex flex-col"
            style={{ paddingTop: 'calc(0.75rem + env(safe-area-inset-top))' }}
            onClick={e => e.stopPropagation()}
          >
            <div className="px-4 pb-3 flex items-center justify-between">
              <span className="text-teal-400 font-semibold">{assistantName}</span>
              <button
                onClick={() => setDrawerOpen(false)}
                aria-label="Close menu"
                className="text-stone-500 hover:text-stone-200 text-lg leading-none px-1"
              >
                ×
              </button>
            </div>
            <button
              onClick={() => { setDrawerOpen(false); onShowBrain?.(); }}
              className="flex items-center gap-3 px-4 py-2.5 text-sm text-stone-300 hover:bg-stone-900 text-left"
            >
              <span className="w-[18px] h-[18px] shrink-0 rounded-full bg-gradient-to-br from-amber-100 via-amber-300 to-teal-400" />
              {assistantName}'s universe
            </button>
            <button
              onClick={() => { setDrawerOpen(false); navigate('/activity'); }}
              className="flex items-center gap-3 px-4 py-2.5 text-sm text-stone-300 hover:bg-stone-900 text-left"
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M22 12h-4l-3 9L9 3l-3 9H2" />
              </svg>
              Activity
            </button>
            <button
              onClick={() => { setDrawerOpen(false); navigate('/settings'); }}
              className="flex items-center gap-3 px-4 py-2.5 text-sm text-stone-300 hover:bg-stone-900 text-left"
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <circle cx="12" cy="12" r="3" />
                <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1" />
              </svg>
              Settings
            </button>
            <div className="mt-4 mx-4 pt-4 border-t border-stone-800 space-y-3">
              {mainAgent && models.length > 0 && (
                <label className="block text-xs text-stone-500">
                  Model
                  <select
                    value={mainAgent.model}
                    onChange={e => changeModel(e.target.value)}
                    className="mt-1 w-full bg-stone-800 border border-stone-700 rounded px-2 py-1.5 text-xs text-stone-300"
                  >
                    {models.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
                    {!models.some(m => m.id === mainAgent.model) && (
                      <option value={mainAgent.model}>{mainAgent.model}</option>
                    )}
                  </select>
                </label>
              )}
              <div className="flex items-center justify-between text-sm text-stone-300">
                Speak replies
                <button
                  onClick={toggleSpeech}
                  className={`px-2.5 py-1 rounded-full border text-xs ${
                    speech ? 'border-teal-700 text-teal-300' : 'border-stone-700 text-stone-500'}`}
                >
                  {speech ? 'On' : 'Off'}
                </button>
              </div>
            </div>
          </nav>
        </div>
      )}

      {inboxOpen && (() => {
        const agoStr = (iso: string | null) => {
          if (!iso) return '';
          const t = Date.parse(iso.replace(' ', 'T'));
          if (Number.isNaN(t)) return '';
          const s = Math.max(0, (Date.now() - t) / 1000);
          if (s < 3600) return `${Math.max(1, Math.round(s / 60))}m ago`;
          if (s < 129600) return `${Math.round(s / 3600)}h ago`;
          return `${Math.round(s / 86400)}d ago`;
        };
        const open = (r: RecCard) => ['new', 'seen', 'later'].includes(r.status);
        const actionable = (inbox ?? []).filter(open);
        const decided = (inbox ?? []).filter(r => !open(r));
        const row = (r: RecCard) => (
          <div key={r.id} className="px-3 py-2 border-t border-stone-800/70">
            <button
              onClick={() => setInboxExpanded(e => e === r.id ? null : r.id)}
              className="w-full text-left"
            >
              <div className={`text-sm leading-snug ${open(r) ? 'text-stone-100' : 'text-stone-400'}`}>
                {r.title}
              </div>
              <div className="text-[10px] text-stone-500 mt-0.5">
                {r.source} · {open(r)
                  ? (r.status === 'later' ? `snoozed · ${agoStr(r.created_at)}` : agoStr(r.created_at))
                  : `${r.status} · ${agoStr(r.decided_at)}`}
              </div>
            </button>
            {inboxExpanded === r.id && (
              <div className="mt-1.5">
                <div className="text-xs text-stone-400 [&_p]:my-0.5 [&_a]:text-teal-400">
                  <Markdown>{r.body}</Markdown>
                </div>
                {open(r) && (
                  <div className="flex gap-2 mt-1.5">
                    <button onClick={() => decideRec(r, 'approve')}
                      className="text-xs px-2.5 py-1 rounded bg-teal-700 hover:bg-teal-600 text-white">Approve</button>
                    {r.status !== 'later' && (
                      <button onClick={() => decideRec(r, 'later')}
                        className="text-xs px-2.5 py-1 rounded border border-stone-600 text-stone-300 hover:text-stone-100">Later</button>
                    )}
                    <button onClick={() => decideRec(r, 'dismiss')}
                      className="text-xs px-2.5 py-1 rounded border border-stone-700 text-stone-500 hover:text-red-400 hover:border-red-800">Dismiss</button>
                  </div>
                )}
              </div>
            )}
          </div>
        );
        return (
          <div className="absolute right-2 z-40 w-80 max-w-[calc(100%-1rem)] max-h-[65vh] overflow-y-auto nice-scroll rounded-xl border border-stone-700 bg-stone-900/95 backdrop-blur shadow-2xl">
            <div className="px-3 py-2 flex items-center justify-between">
              <span className="text-[10px] uppercase tracking-wide text-stone-500">Recommendations</span>
              <button onClick={() => setInboxOpen(false)} aria-label="Close inbox"
                className="text-stone-500 hover:text-stone-200 leading-none px-1">×</button>
            </div>
            {inbox === null ? (
              <div className="px-3 py-4 pt-0 text-xs text-stone-500">Loading…</div>
            ) : inbox.length === 0 ? (
              <div className="px-3 py-4 pt-0 text-xs text-stone-500">
                Nothing here yet — when {assistantName} or an automation finds
                something worth your decision, it lands here.
              </div>
            ) : (
              <>
                {actionable.map(row)}
                {decided.length > 0 && (
                  <div className="px-3 pt-2 pb-1 border-t border-stone-800 text-[10px] uppercase tracking-wide text-stone-600">
                    Recently decided
                  </div>
                )}
                {decided.map(row)}
              </>
            )}
          </div>
        );
      })()}

      {recs.length > 0 && (
        <div className="border-b border-amber-900/40 bg-amber-950/20 px-3 py-2 flex items-start gap-2">
          <span className="text-amber-400 text-sm mt-0.5" aria-hidden>★</span>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-[10px] uppercase tracking-wide text-amber-500/80">Nova recommends</span>
              <span className="text-[10px] text-stone-500">· from {recs[0].source}</span>
              {recs.length > 1 && (
                <button onClick={toggleInbox}
                  className="text-[10px] text-stone-500 hover:text-teal-300 underline underline-offset-2">
                  +{recs.length - 1} more
                </button>
              )}
            </div>
            <div className="text-sm text-stone-100 mt-0.5">{recs[0].title}</div>
            <div className="text-xs text-stone-400 mt-0.5 [&_p]:my-0.5 [&_a]:text-teal-400">
              <Markdown>{recs[0].body}</Markdown>
            </div>
            <div className="flex gap-2 mt-1.5">
              <button onClick={() => decideRec(recs[0], 'approve')}
                className="text-xs px-2.5 py-1 rounded bg-teal-700 hover:bg-teal-600 text-white">Approve</button>
              <button onClick={() => decideRec(recs[0], 'later')}
                className="text-xs px-2.5 py-1 rounded border border-stone-600 text-stone-300 hover:text-stone-100">Later</button>
              <button onClick={() => decideRec(recs[0], 'dismiss')}
                className="text-xs px-2.5 py-1 rounded border border-stone-700 text-stone-500 hover:text-red-400 hover:border-red-800">Dismiss</button>
            </div>
          </div>
        </div>
      )}

      <div className="flex-1 overflow-y-auto overflow-x-hidden nice-scroll p-4 space-y-2">
        {items.length === 0 && (
          <div className="text-center text-stone-500 mt-10">
            <p className="text-base font-medium text-stone-400">Talk to {assistantName}</p>
            <p className="text-sm mt-1">One continuous conversation — it remembers.</p>
          </div>
        )}

        {renderGrouped(items, setInspectTraceId, handleConsent, mobile)}
        <div ref={endRef} />
      </div>

      {inspectTraceId && (
        <TurnInspector traceId={inspectTraceId} onClose={() => setInspectTraceId(null)} />
      )}

      {queue.length > 0 && (
        <div className="border-t border-stone-800 px-3 pt-2 -mb-1 flex flex-wrap items-center gap-1.5">
          <span className="text-[10px] uppercase tracking-wide text-stone-500">queued</span>
          {queue.map((q, i) => (
            <span key={i} className="inline-flex items-center gap-1 max-w-[15rem] text-[11px] bg-stone-800 border border-stone-700 rounded-full px-2 py-0.5 text-stone-300">
              <span className="truncate">{q}</span>
              <button type="button" onClick={() => setQueue(qq => qq.filter((_, j) => j !== i))}
                className="text-stone-500 hover:text-red-400 leading-none" title="Remove from queue" aria-label="Remove from queue">×</button>
            </span>
          ))}
        </div>
      )}
      {pending.length > 0 && (
        <div className={`px-3 pt-2 flex flex-wrap items-center gap-2 ${mobile ? '' : 'border-t border-stone-800'}`}>
          {pending.map((a, i) => (
            <span key={i} className="relative">
              {a.kind === 'image' && a.preview ? (
                <img src={a.preview} alt={a.name}
                  className="h-14 w-14 object-cover rounded-xl border border-stone-700" />
              ) : (
                <span className="inline-flex items-center max-w-[12rem] text-[11px] bg-stone-800 border border-stone-700 rounded-full pl-2.5 pr-3 py-1.5 text-stone-300">
                  <span className="truncate">{a.name}</span>
                </span>
              )}
              <button
                type="button"
                onClick={() => setPending(p => p.filter((_, j) => j !== i))}
                aria-label={`Remove ${a.name}`}
                className="absolute -top-1.5 -right-1.5 w-5 h-5 rounded-full bg-stone-700 border border-stone-600 text-stone-200 text-xs leading-none flex items-center justify-center"
              >
                ×
              </button>
            </span>
          ))}
        </div>
      )}

      {/* the pickers behind the + button; value reset so re-picking the same
          file fires change again */}
      <input ref={cameraInputRef} type="file" accept="image/*" capture="environment" hidden
        onChange={e => { const fs = e.target.files ? Array.from(e.target.files) : null;
                         e.target.value = ''; void addFiles(fs); }} />
      <input ref={photoInputRef} type="file" accept="image/*" multiple hidden
        onChange={e => { const fs = e.target.files ? Array.from(e.target.files) : null;
                         e.target.value = ''; void addFiles(fs); }} />
      <input ref={fileInputRef} type="file" multiple hidden
        onChange={e => { const fs = e.target.files ? Array.from(e.target.files) : null;
                         e.target.value = ''; void addFiles(fs); }} />

      {mobile ? (
        // the mockup composer: one rounded pill — +, the field, then the mic
        // (voice mode) or, once there's something to send, the send arrow
        <form
          onSubmit={e => { e.preventDefault(); submitComposer(); }}
          className="relative px-3 pt-1.5"
          style={{ paddingBottom: 'calc(0.75rem + env(safe-area-inset-bottom))' }}
        >
          {attachOpen && (
            <div className="absolute bottom-full left-3 mb-1 z-30 min-w-[11rem] rounded-2xl border border-stone-700 bg-stone-900/95 backdrop-blur shadow-2xl overflow-hidden">
              <button type="button"
                onClick={() => { setAttachOpen(false); cameraInputRef.current?.click(); }}
                className="w-full flex items-center gap-3 px-4 py-2.5 text-sm text-stone-200 hover:bg-stone-800 text-left">
                <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                  strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z" />
                  <circle cx="12" cy="13" r="4" />
                </svg>
                Camera
              </button>
              <button type="button"
                onClick={() => { setAttachOpen(false); photoInputRef.current?.click(); }}
                className="w-full flex items-center gap-3 px-4 py-2.5 text-sm text-stone-200 hover:bg-stone-800 text-left">
                <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                  strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <rect x="3" y="3" width="18" height="18" rx="2" />
                  <circle cx="8.5" cy="8.5" r="1.5" />
                  <path d="M21 15l-5-5L5 21" />
                </svg>
                Photos
              </button>
              <button type="button"
                onClick={() => { setAttachOpen(false); fileInputRef.current?.click(); }}
                className="w-full flex items-center gap-3 px-4 py-2.5 text-sm text-stone-200 hover:bg-stone-800 text-left">
                <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                  strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                  <path d="M14 2v6h6" />
                </svg>
                Files
              </button>
            </div>
          )}
          <div className="flex items-end gap-1 bg-stone-900 border border-stone-800 rounded-[26px] p-1.5">
            <button
              type="button"
              onClick={() => setAttachOpen(o => !o)}
              aria-label="Add photos or files"
              title="Add photos or files"
              className={`shrink-0 w-9 h-9 rounded-full flex items-center justify-center ${
                attachOpen ? 'bg-stone-700 text-stone-100' : 'text-stone-300'}`}
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                strokeWidth="2" strokeLinecap="round" aria-hidden="true">
                <path d="M12 5v14M5 12h14" />
              </svg>
            </button>
            <textarea
              ref={inputRef}
              rows={1}
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  submitComposer();
                }
              }}
              placeholder={busy ? 'Queue a follow-up…' : `Ask ${assistantName}`}
              className="flex-1 min-w-0 resize-none overflow-y-auto nice-scroll bg-transparent text-stone-100 placeholder-stone-500 px-1.5 py-2 text-[15px] focus:outline-none"
            />
            {busy && !!input.trim() && (
              <button
                type="button"
                onClick={interject}
                title={`Interrupt ${assistantName} and send this now`}
                className="shrink-0 h-9 px-3 rounded-full bg-amber-700 text-white text-xs"
              >
                Now
              </button>
            )}
            {input.trim() || pending.length > 0 ? (
              <button
                type="submit"
                aria-label={busy ? 'Queue' : 'Send'}
                title={busy ? `${assistantName} is replying — this queues and sends when she finishes` : 'Send'}
                className="shrink-0 w-9 h-9 rounded-full bg-teal-600 text-white flex items-center justify-center"
              >
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                  strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M12 19V5M5 12l7-7 7 7" />
                </svg>
              </button>
            ) : (
              <button
                type="button"
                onClick={() => void openVoice()}
                aria-label={`Talk with ${assistantName}`}
                title={`Talk with ${assistantName}`}
                className="shrink-0 w-9 h-9 rounded-full bg-stone-100 text-stone-900 flex items-center justify-center"
              >
                <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                  strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M12 2a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3" />
                  <path d="M19 10v1a7 7 0 0 1-14 0v-1M12 18v4" />
                </svg>
              </button>
            )}
          </div>
        </form>
      ) : (
      <form
        onSubmit={e => { e.preventDefault(); submitComposer(); }}
        className="border-t border-stone-700 p-3 flex items-end gap-2"
      >
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          aria-label="Attach images or files"
          title="Attach images or files"
          className="px-2.5 py-2 rounded text-sm bg-stone-700 hover:bg-stone-600 text-stone-200"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
            strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
          </svg>
        </button>
        <textarea
          ref={inputRef}
          rows={1}
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              submitComposer();
            }
          }}
          placeholder={busy ? 'Queue a follow-up… (or “Now” to interject)' : 'Message Nova…'}
          title="Enter to send / queue, Shift+Enter for a new line"
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
              : micState === 'armed' ? (inFollowup.current
                ? 'Still listening — just talk, no wake phrase needed'
                : 'Wake word heard — speak now')
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
        {busy && !!input.trim() && (
          <button
            type="button"
            onClick={interject}
            title="Interrupt Nova and send this now"
            className="px-3 py-2 bg-amber-700 hover:bg-amber-600 text-white rounded text-sm transition"
          >
            Now
          </button>
        )}
        <button
          type="submit"
          disabled={!input.trim() && pending.length === 0}
          title={busy ? 'Nova is replying — this queues and sends when she finishes' : 'Send'}
          className="px-4 py-2 bg-teal-600 hover:bg-teal-500 disabled:bg-stone-700 disabled:text-stone-500 text-white rounded text-sm transition"
        >
          {busy ? 'Queue' : 'Send'}
        </button>
      </form>
      )}

      {voiceOpen && (
        <VoiceOverlay
          assistantName={assistantName}
          micState={micState}
          busy={busy}
          onMicToggle={() => void voiceMicToggle()}
          onClose={() => void closeVoice()}
          onSendText={t => void send({ text: t, source: 'voice', speak: true })}
        />
      )}
    </aside>
  );
}
