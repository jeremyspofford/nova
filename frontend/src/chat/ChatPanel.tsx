import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Activity,
  Consent,
  ModelInfo,
  RecCard,
  SlashCommand,
  TraceSummary,
  decideConsent,
  decideRecCard,
  getActiveConversation,
  getAgents,
  getMessages,
  getModels,
  getPendingConsents,
  getRecCards,
  listCommands,
  patchAgent,
  runCommand,
  streamChat,
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
import { groupModels } from '../models';

/** An attachment as the message list shows it — preview only exists for
 *  images picked this session (history rows come back name-only). */
interface UiAttachment { kind: 'image' | 'text'; name: string; mime: string; preview?: string }
/** A picked-but-not-yet-sent attachment; data = base64 (image) or file text. */
interface PendingAttachment extends UiAttachment { data: string }

type Item =
  | { id: string; kind: 'msg'; role: 'user' | 'assistant'; content: string;
      streaming?: boolean; trace?: TraceSummary; attachments?: UiAttachment[];
      speaker?: { name: string; role: string } }
  | { id: string; kind: 'activity'; activity: Activity; fromHistory?: boolean }
  /** A dispatched specialist thinking out loud while it works. Live only —
   *  never persisted, so it does not come back on reload. */
  | { id: string; kind: 'subtext'; agent: string; turnId: string; content: string }
  | { id: string; kind: 'error'; content: string }
  // a slash command's own reply — neither the operator nor Nova said it,
  // so it must not look like either
  | { id: string; kind: 'note'; content: string }
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
    if (item.activity.kind === 'capability') {
      // Claimed an ability nothing in the toolset provides. Distinct from
      // the narration banner above: that one is work announced and never
      // done, this one is work that could never have been done. Said in the
      // operator's terms, because "no tool provides that" is the fact they
      // need — the model's wording is not.
      return (
        <div key={item.id} className={`text-xs text-amber-300 bg-amber-950/40 border border-amber-800 rounded px-2.5 py-1.5 ${item.fromHistory ? 'opacity-75' : ''}`}>
          ⚠ {agentDisplayName(item.activity.name)} {item.activity.detail} — treat
          that claim as <b>false</b>.
        </div>
      );
    }
    if (item.activity.kind === 'degraded') {
      // the turn ran, but without something it needed. Said out loud so a
      // confident answer written with no memory is distinguishable from a
      // well-remembered one.
      return (
        <div key={item.id} className={`text-xs text-amber-300 bg-amber-950/30 border border-amber-900 rounded px-2.5 py-1.5 ${item.fromHistory ? 'opacity-75' : ''}`}>
          ⚠ {item.activity.detail}
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
  if (item.kind === 'subtext') {
    // a specialist working out loud: collapsed by default so a long
    // dispatch shows progress without burying the conversation
    return (
      <details key={item.id} className="text-xs font-mono px-1">
        <summary className="text-stone-500 cursor-pointer select-none">
          ⋯ {agentDisplayName(item.agent)} is working…
        </summary>
        <div className="mt-1 ml-3 px-2 py-1.5 whitespace-pre-wrap break-words font-sans text-stone-400 bg-stone-900/60 border-l border-stone-800 rounded-r max-h-64 overflow-y-auto">
          {item.content}
        </div>
      </details>
    );
  }
  if (item.kind === 'error') {
    return (
      <div key={item.id} className="text-xs text-red-400 bg-red-950/40 border border-red-900 rounded px-3 py-2">
        {item.content}
      </div>
    );
  }
  if (item.kind === 'note') {
    return (
      <div key={item.id} className="text-xs text-stone-400 border border-stone-700/70 bg-stone-800/40 rounded px-3 py-2 whitespace-pre-wrap">
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
        {item.role === 'user' && item.speaker && (
          <div className="text-[10px] text-amber-400/90 mb-0.5 text-right">
            {item.speaker.role === 'unknown' ? 'unknown voice' : item.speaker.name}
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
    if (item.kind === 'activity' && item.fromHistory
        && item.activity.kind !== 'narration' && item.activity.kind !== 'capability') {
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
  /** "Discuss" from a note's detail card: attach its content to the composer
   *  as if the operator had picked it as a text file. */
  discussPayload?: { name: string; mime: string; data: string } | null;
  onDiscussHandled?: () => void;
}

const MIN_W = 320;
const MAX_W = 760;

// Barge-in (talking over her): duck the moment a voice is heard, cut the turn
// only once that voice has HELD — vad.ts's onSustained, which reads frame
// probabilities live (see the note there for why a timer cannot do this).
// A hard ceiling so no path can leave the output quietly ducked forever;
// comfortably longer than the 500 ms sustain, so a real interruption always
// resolves before it.
const DUCK_CEILING_MS = 2500;

// Phase 4 backstop: if a captured turn never hands the microphone back
// within this, arm anyway rather than sit deaf. The fast path re-arms as soon
// as the utterance is dispatched; this only catches a transcription that
// never settles, and a backgrounded PWA whose timers Chrome has throttled to
// roughly one a minute.
const REARM_CEILING_MS = 8000;

// How long the duck takes to actually land (setTargetAtTime, tau=0.05), after
// which the sustained-speech clock restarts against the quieter output.
const DUCK_SETTLE_MS = 200;

// Per reply. Stops her volume pumping if leakage keeps tripping the detector.
const MAX_ECHO_DUCKS = 3;

export function ChatPanel({ width, onWidthChange, mobile, onShowBrain, settingsOpen,
                           discussPayload, onDiscussHandled }: ChatPanelProps) {
  const [items, setItems] = useState<Item[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  type QueuedTurn = { text: string; source?: string; speak?: boolean;
                      speakerId?: string;
                      speakerTag?: { name: string; role: string } };
  // follow-ups typed while Nova is still replying: queued and auto-sent FIFO
  // when the current turn finishes; "interject" jumps the queue and cuts the
  // reply short. abortRef cancels the in-flight turn for that interruption.
  // Whole turns, not bare strings: a voice follow-up carries speak/speaker
  // and a consent approval carries its source, and queueing only the text
  // would silently downgrade both (a spoken question answered in silence).
  const [queue, setQueue] = useState<QueuedTurn[]>([]);
  // ── slash commands ──────────────────────────────────────────────────
  // The palette exists so the command set is discoverable rather than
  // folklore: a verb nobody can find is a verb nobody uses. Fetched from
  // the backend, so adding a command server-side makes it appear here with
  // no UI change.
  const [commands, setCommands] = useState<SlashCommand[]>([]);
  const [cmdIdx, setCmdIdx] = useState(0);
  useEffect(() => { listCommands().then(setCommands).catch(() => {}); }, []);
  // Open only while the command NAME is still being typed. Once there is a
  // space the operator is writing an argument, and a menu over their text
  // is in the way.
  const cmdPrefix = /^\/([a-z0-9-]*)$/i.exec(input.trim());
  const cmdMatches = cmdPrefix
    ? commands.filter(c => c.name.startsWith(cmdPrefix[1].toLowerCase()))
    : [];
  const paletteOpen = cmdMatches.length > 0;
  useEffect(() => { setCmdIdx(0); }, [input]);


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

  useEffect(() => {
    if (!discussPayload) return;
    setPending(p => [...p, { kind: 'text', ...discussPayload }]);
    inputRef.current?.focus();
    onDiscussHandled?.();
  }, [discussPayload, onDiscussHandled]);
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
  const tapVad = useRef<TapVad | null>(null);      // armed right now
  const vadInstance = useRef<TapVad | null>(null); // the warm model, across turns
  // wake keeps running while we capture (shared device); ignore its fires
  // for a moment so the word that woke us cannot immediately re-trigger
  const wakeIgnoreUntil = useRef(0);
  const vadSilenceMs = useRef(1100);
  // conversation mode runs a shorter tolerance: barge-in is the safety net
  // that makes aggressive endpointing survivable — if she starts early you
  // just keep talking and she gets out of the way — and 400ms off the front
  // of every turn is the cheapest speed in the whole path.
  const vadSilenceConvMs = useRef(700);
  const wakeRef = useRef<WakeWord | null>(null);
  const wakeOn = useRef(false);
  const wakeThreshold = useRef(0.5);
  const wakeWord = useRef(DEFAULT_WAKE);
  const wakeLearning = useRef(false);          // voice.wake_learning
  const wakeMic = useRef<'browser' | 'raw'>('browser');   // voice.wake_mic_processing
  const lastSpeakerName = useRef('');          // who transcribe matched, for clip labels
  const followupS = useRef(8);        // wake mode: 0 = off
  const inFollowup = useRef(false);   // current VAD arm is a follow-up window
  // ── conversation mode: tap in once, the mic stays hot turn after turn ──
  // On the phone this is the full-screen VoiceOverlay; on desktop it is a
  // state of the chat panel (a hot-mic bar) so the transcript and tool cards
  // stay visible. Both drive the same voiceLoopDone continuation.
  const [conversationOpen, setConversationOpen] = useState(false);
  const conversationRef = useRef(false);
  // ONE generation counter for the whole voice machine. Every async
  // continuation captures it on entry and bails if it moved, which replaces
  // a scatter of ad-hoc guards (`!conversationRef.current`, `tapVad.current
  // !== v`, `!wakeOn.current`) that each knew about one mode and therefore
  // could not see a change to another. Bumped by every mode change: opening
  // or closing conversation, muting, wake on/off, cancelling a tap, and the
  // tab going away. It does not replace `tapVad.current`, which answers a
  // different question — "is something armed right now".
  const epoch = useRef(0);
  const bumpEpoch = () => { epoch.current += 1; };
  const idleS = useRef(120);          // voice.conversation_idle_s; 0 = never
  const assistantName = useAssistantName();

  // mic mode + VAD/wake tuning are shared settings — read + track live changes
  useEffect(() => {
    const isMode = (v: unknown): v is 'ptt' | 'tap' | 'wake' => v === 'ptt' || v === 'tap' || v === 'wake';
    getSettings().then(defs => {
      const m = defs.find(d => d.key === 'voice.listen_mode')?.value;
      if (isMode(m)) setListenMode(m);
      const s = defs.find(d => d.key === 'voice.vad_silence_ms')?.value;
      if (typeof s === 'number') vadSilenceMs.current = s;
      const sc = defs.find(d => d.key === 'voice.vad_silence_conversation_ms')?.value;
      if (typeof sc === 'number') vadSilenceConvMs.current = sc;
      const w = defs.find(d => d.key === 'voice.wake_threshold')?.value;
      if (typeof w === 'number') wakeThreshold.current = w;
      const ph = defs.find(d => d.key === 'voice.wake_word')?.value;
      if (typeof ph === 'string' && ph) wakeWord.current = ph;
      const fw = defs.find(d => d.key === 'voice.followup_window_s')?.value;
      if (typeof fw === 'number') followupS.current = fw;
      const ci = defs.find(d => d.key === 'voice.conversation_idle_s')?.value;
      if (typeof ci === 'number') idleS.current = ci;
      applyWakeLearning(defs.find(d => d.key === 'voice.wake_learning')?.value);
      applyWakeMic(defs.find(d => d.key === 'voice.wake_mic_processing')?.value);
    }).catch(() => {});
    const onChange = (e: Event) => {
      const { key, value } = (e as CustomEvent).detail as { key: string; value: unknown };
      if (key === 'voice.listen_mode' && isMode(value)) setListenMode(value);
      if (key === 'voice.vad_silence_ms' && typeof value === 'number') vadSilenceMs.current = value;
      if (key === 'voice.vad_silence_conversation_ms' && typeof value === 'number') vadSilenceConvMs.current = value;
      if (key === 'voice.wake_threshold' && typeof value === 'number') {
        wakeThreshold.current = value;
        // retune the LIVE detector — the instance is reused below, so without
        // this the new threshold wouldn't apply until wake is toggled off/on
        wakeRef.current?.setTuning({ threshold: value });
      }
      if (key === 'voice.wake_word' && typeof value === 'string' && value) wakeWord.current = value;
      if (key === 'voice.followup_window_s' && typeof value === 'number') followupS.current = value;
      if (key === 'voice.conversation_idle_s' && typeof value === 'number') idleS.current = value;
      if (key === 'voice.wake_learning') applyWakeLearning(value);
      if (key === 'voice.wake_mic_processing') applyWakeMic(value);
    };
    window.addEventListener('nova:setting-changed', onChange);
    return () => window.removeEventListener('nova:setting-changed', onChange);
  }, []);

  // A hot mic must never outlive the panel or the foreground. ChatPanel is
  // conditionally rendered (pages/Brain.tsx), so navigating away used to orphan
  // an armed VAD or a running wake detector with no UI and no way to stop it —
  // survivable when every arm had an 8 s timeout, not survivable for a mode
  // designed to stay open. Tab-hide releases too: a backgrounded PWA holding
  // the mic is a battery drain AND makes the OS recording indicator lie.
  useEffect(() => {
    const release = () => {
      bumpEpoch();
      conversationRef.current = false;
      voiceOpenRef.current = false;
      wakeOn.current = false;
      inFollowup.current = false;
      void tapVad.current?.disarm();
      void vadInstance.current?.dispose();
      tapVad.current = null;
      void wakeRef.current?.stop();
    };
    const onVisibility = () => {
      if (document.visibilityState !== 'hidden') return;
      release();
      setConversationOpen(false);
      setVoiceOpen(false);
      setMicState('idle');
      emitListening(false);
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      release();
    };
  }, []);

  // ── wake-word learning (phase 5a/5b) ───────────────────────────────────
  // Both settings have to reach a RUNNING detector: turning learning off must
  // stop it now and drop what is held, not at the next page load, and the mic
  // mode has to force a device re-open because constraints are fixed at
  // getUserMedia time. Loaded lazily, like the rest of the voice stack.
  const wakeClipsMod = () => import('../voice/wakeClips');

  function applyWakeLearning(value: unknown) {
    if (typeof value !== 'boolean') return;
    wakeLearning.current = value;
    wakeRef.current?.setTuning({ capture: value });
    void wakeClipsMod().then(m =>
      m.setWakeLearning(value, { phrase: wakeWord.current, mic: wakeMic.current }));
  }

  function applyWakeMic(value: unknown) {
    if (value !== 'browser' && value !== 'raw') return;
    wakeMic.current = value;
    wakeRef.current?.setTuning({ mic: value });
    void import('../voice/micBroker').then(m => m.micBroker.setProcessing(value));
    void wakeClipsMod().then(m =>
      m.setWakeLearning(wakeLearning.current, { mic: value }));
  }

  function toggleSpeech() {
    const next = !speech;
    setSpeech(next);
    localStorage.setItem('nova.speech', next ? '1' : '0');
    if (next) speaker.enable();     // inside the click gesture — autoplay policy
    else speaker.disable();
  }

  // a captured utterance (from PTT or tap-VAD) → transcribe → voice turn.
  // The reply is always spoken (voice in implies voice out).
  // one utterance -> text + who was speaking; the speaker echo rides the
  // chat request exactly like `source` does (personalization, never auth —
  // the server only ever narrows on it)
  // `front`: this utterance interrupted her, so it goes to the FRONT of the
  // queue — you cut her off to say it, waiting behind three typed follow-ups
  // would be the wrong answer to the wrong question.
  async function submitUtterance(blob: Blob, opts?: { front?: boolean }) {
    setMicState('transcribing');
    try {
      const { text, speaker: who, speaker_active } = await transcribeSpeech(blob);
      // Only clear the state we set. Phase 4 re-arms the microphone as soon as
      // the utterance is dispatched, and on a slow transcription the stranded-
      // re-arm backstop can land BEFORE this line — an unconditional 'idle'
      // would then paint the bar as not listening while the mic was live.
      setMicState(s => (s === 'transcribing' ? 'idle' : s));
      // a wake clip is far more useful tagged with WHO said it — the whole
      // point is that the model has never heard this particular child
      lastSpeakerName.current = who ? who.name : '';
      if (text.trim()) {
        // DISPATCH, don't await. `send` runs the SSE stream to completion, so
        // awaiting it here meant the caller's continuation — the one that puts
        // the microphone back — did not run until the entire answer had been
        // generated. That, not the playback polls the plan blames, is what
        // kept the mic shut through the reply; deleting the polls alone would
        // have left the whole generation deaf.
        //
        // Through sendRef rather than the captured `send`, which also fixes a
        // live bug: the arm closure holds the `send` from the render that
        // armed it, so its `if (busy)` check reads a stale value and a voice
        // turn landing during a typed one could open a second stream over the
        // same abortRef. send() never throws — it has its own try/finally.
        void sendRef.current({
          text, source: 'voice', speak: true, front: opts?.front,
          speakerId: who ? who.profile_id : (speaker_active ? 'unknown' : undefined),
          speakerTag: who && who.role !== 'operator'
            ? { name: who.name, role: who.role }
            : (!who && speaker_active ? { name: 'unknown voice', role: 'unknown' } : undefined),
        });
      } else setItems(prev => [...prev, { id: uid(), kind: 'error',
        content: "Didn't catch that — try again." }]);
    } catch (err) {
      setMicState(s => (s === 'transcribing' ? 'idle' : s));
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
                                 armTimeoutMs?: number,
                                 opts?: { barged?: boolean; onCaptured?: () => void }) {
    setMicState('arming');          // first use downloads the detector (~15 MB)
    try {
      const { TapVad } = await import('../voice/vad');
      // ONE instance for the whole session (phase 2). Constructing per turn
      // rebuilt the silero model and reopened the microphone every time —
      // ~2000ms of dead mic between the wake word and anything listening.
      // The broker holds the device; this holds the warm model.
      if (!vadInstance.current) vadInstance.current = new TapVad();
      const v = vadInstance.current;
      tapVad.current = v;
      let armTimer: number | undefined;
      let speaking = false;   // inside an utterance — never time out mid-sentence
      const myEpoch = epoch.current;
      // Self-cancelling: it drops itself the first time it notices this
      // capture has been superseded, so the six external teardown paths
      // (mute, close, wake off, tap cancel, tab hide, unmount) do not each
      // have to know about it.
      let stopWatchingSpeech: (() => void) | null = null;
      const endSpeechWatch = () => { stopWatchingSpeech?.(); stopWatchingSpeech = null; };
      const clearArmTimer = () => { if (armTimer) { clearTimeout(armTimer); armTimer = undefined; } };
      // The timer RESCHEDULES itself rather than being cleared once and
      // forgotten: a misfire (you cleared your throat) used to cancel the arm
      // timeout permanently, leaving the mic armed forever with no automatic
      // release. Harmless in an 8 s follow-up window, fatal for a mode that is
      // meant to stay open.
      // A DEADLINE, not a sliding window. The timer reschedules itself rather
      // than being cleared once and forgotten — a misfire used to cancel the
      // arm timeout permanently, leaving the mic armed forever. But
      // rescheduling the FULL window on every misfire traded that for a
      // slower version of the same bug: onMisfire fires for any burst under
      // minSpeechMs, so a room with intermittent noise resets the window
      // indefinitely and the hot mic never auto-closes — precisely the
      // ambient-room case conversation mode is for. So the deadline is fixed
      // when the window opens, and a misfire resumes the REMAINDER of it.
      // Only a real utterance (a turn actually taken) earns a fresh window.
      let armDeadline = 0;
      const scheduleArmTimer = (fresh = false) => {
        if (!armTimeoutMs) return;
        clearArmTimer();
        const now = Date.now();
        if (fresh || !armDeadline) armDeadline = now + armTimeoutMs;
        const remaining = Math.max(0, armDeadline - now);
        armTimer = window.setTimeout(async () => {
          armTimer = undefined;
          // `v` is the session-wide singleton, so `tapVad.current !== v` only
          // answers "is ANYTHING armed" — it cannot tell this capture from the
          // one that replaced it. Before phase 4 no capture existed during a
          // reply, so there was nothing to orphan; now the follow-up window is
          // armed through the whole answer, and switching mode mid-reply used
          // to leave its timer alive to disarm the NEW capture and close a
          // conversation the operator was in the middle of.
          if (myEpoch !== epoch.current) { clearArmTimer(); return; }
          if (tapVad.current !== v) return;             // already captured/cancelled
          if (speaking) { scheduleArmTimer(); return; } // mid-utterance: give it longer
          // Nor while SHE is audibly talking. Phase 4 keeps the mic open
          // through the reply, so the window would otherwise count down during
          // her answer and a long one would close the conversation before you
          // got a word in — the follow-up window is meant to be your time, not
          // hers. `playing`, not `speaking`: a PAUSED reply latches `speaking`
          // true forever (the source node is still assigned, and its onended
          // cannot fire against a frozen clock), which would mean a paused
          // conversation never idles out at all.
          if (speaker.playing) { scheduleArmTimer(true); return; }
          unduck();
          endSpeechWatch();
          await v.disarm();
          tapVad.current = null;
          emitListening(false);
          await afterSubmit?.(false);                   // back to wake listening
        }, remaining);
      };
      // ── talking over her ────────────────────────────────────────────────
      // Two separate moments, deliberately. Her volume drops the INSTANT the
      // detector hears a voice — that is the affordance, and it has to be
      // immediate to read as "she heard me". Cutting the turn short waits for
      // the speech to SUSTAIN, because an open mic also hears her own output:
      // a false cut mid-answer is far worse than a 500 ms late one. If it was
      // echo or a cough, the VAD misfires, we un-duck, nothing was captured,
      // and she never noticed being doubted.
      let barged = opts?.barged ?? false;
      let ducking = false;
      let duckCeiling: number | undefined;
      let settleTimer: number | undefined;
      // Phase 4's central safety property. `heardOver` means this utterance
      // BEGAN while sound was actually coming out of the speaker — so it may
      // be her, arriving back through an open microphone. See the veto in
      // onSpeechEnd.
      let heardOver = false;
      let echoDucks = 0;
      const unduck = () => {
        if (duckCeiling) { clearTimeout(duckCeiling); duckCeiling = undefined; }
        if (settleTimer) { clearTimeout(settleTimer); settleTimer = undefined; }
        if (!ducking) return;
        // Past the flutter cap the duck goes STICKY for the rest of this
        // reply. Leakage trips the detector, we duck, the leakage drops below
        // threshold, the VAD misfires, we un-duck, and it trips again — her
        // volume pumping up and down for the whole answer. Handing the volume
        // back is the half of that cycle worth giving up: staying quiet in a
        // room that keeps tripping the mic is the better of the two failures,
        // and it keeps every later confirm measured against a quiet speaker.
        if (echoDucks > MAX_ECHO_DUCKS) return;
        ducking = false;
        speaker.duck(false);
      };
      // heard something while she is talking: get out of the way immediately
      const duckForSpeech = () => {
        if (!speaker.playing) return;
        // Set FIRST and unconditionally. This is the veto's only input, and
        // it must not depend on whether we happened to duck: gating it behind
        // the duck meant that once the flutter cap was reached nothing could
        // set `ducking`, so nothing could confirm a barge-in, so every later
        // utterance in that reply was vetoed — she talked over you and your
        // words were silently discarded.
        heardOver = true;
        if (barged || ducking) return;
        echoDucks++;
        ducking = true;
        // With browser processing the echo canceller has already removed most
        // of her; the duck is mainly the affordance. In raw mode (phase 5b
        // turns AEC off) the duck is the ONLY thing standing between her
        // output and her own ears, so it goes deeper.
        speaker.duck(true, wakeMic.current === 'raw' ? 0.05 : 0.13);
        // …and restart the sustain clock once the duck has actually landed
        // (setTargetAtTime with tau=0.05 settles in ~150 ms), so the 500 ms
        // that confirms an interruption is measured against a quiet speaker.
        // Otherwise her own voice — more continuously voiced than yours —
        // clears that bar more easily than you do.
        settleTimer = window.setTimeout(() => {
          settleTimer = undefined;
          v.resetSustain();
        }, DUCK_SETTLE_MS);
        // never leave the output ducked if neither outcome ever arrives
        duckCeiling = window.setTimeout(() => { duckCeiling = undefined; unduck(); },
                                        DUCK_CEILING_MS);
      };
      // …and only cut her off once the voice has actually HELD (vad.ts's
      // onSustained, measured from frame probabilities). Deciding this from a
      // timer after onSpeechStart does not work: the misfire that would have
      // vetoed it arrives a full redemption window later, so a 180 ms cough
      // read as sustained speech and cut her off mid-answer.
      const confirmBargeIn = () => {
        // Gated on heardOver — "this utterance began while she was audible" —
        // rather than on the duck, which is a volume decision and must never
        // decide whether you are allowed to interrupt her.
        if (barged || !heardOver) return;
        barged = true;
        speaker.cancel();            // terminal: the turn's flush() can't revive it
        abortRef.current?.abort();   // and stop generating the rest of what she was saying
        unduck();                    // she is silent now — hand the volume back
      };
      await v.arm({
        onSpeechStart: () => {
          speaking = true; clearArmTimer(); setMicState('capturing');
          duckForSpeech();
        },
        onSustained: confirmBargeIn,
        onMisfire: () => {
          speaking = false; heardOver = false; unduck();
          setMicState('armed'); scheduleArmTimer();
        },
        onSpeechEnd: (wav) => {
          speaking = false;
          if (!barged) unduck();
          // ── the spoke-over veto ────────────────────────────────────────
          // This utterance started while she was audibly playing and never
          // earned a confirmed barge-in. It is far more likely her own voice
          // coming back through the microphone than a person, so it is
          // DROPPED — not transcribed, not sent, no fresh idle window, and
          // the mic stays armed for whatever comes next.
          //
          // This is what makes a self-sustaining conversation impossible
          // rather than unlikely: whisper never sees her own words, so she
          // can never answer herself. It holds with echo cancellation on or
          // off, which matters because 'raw' mode turns it off. A real
          // interruption is unaffected — sustaining half a second over a
          // ducked speaker sets `barged` and lifts the veto.
          if (heardOver && !barged) {
            heardOver = false;
            setMicState('armed');
            scheduleArmTimer();
            return;
          }
          heardOver = false;
          clearArmTimer();
          // defer out of the VAD's own callback stack before tearing it down —
          // calling destroy() synchronously from within onSpeechEnd wedges the
          // async continuation and the utterance never gets submitted
          setTimeout(async () => {
            armDeadline = 0;            // a real turn earns a fresh window
            endSpeechWatch();
            await v.disarm();
            tapVad.current = null;
            emitListening(false);
            // Start watching for the reply BEFORE submitting: submitUtterance
            // awaits the whole turn, so anything hung off its completion is
            // already too late to have the mic open during the answer.
            opts?.onCaptured?.();
            await submitUtterance(wav, { front: barged });
            await afterSubmit?.(true);
          }, 0);
        },
      }, { silenceMs: conversationRef.current ? vadSilenceConvMs.current : vadSilenceMs.current });
      setMicState(s => (s === 'arming' ? 'armed' : s));
      emitListening(true);
      // The window is YOUR silence, not hers: restart it the moment she stops
      // speaking, so a long reply does not eat the time you had to answer.
      stopWatchingSpeech = speaker.subscribe(s => {
        if (myEpoch !== epoch.current || tapVad.current !== v) { endSpeechWatch(); return; }
        if (!s.speaking && !speaking) scheduleArmTimer(true);
      });
      scheduleArmTimer();
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
      bumpEpoch();
      await tapVad.current?.disarm();
      tapVad.current = null;
      setMicState('idle');
      emitListening(false);
      return;
    }
    speaker.enable();               // reserve the audio context in the gesture
    if (!speech) { setSpeech(true); localStorage.setItem('nova.speech', '1'); }
    // reaching for the button while wake listening is on is the honest form
    // of "it didn't hear me" — keep whatever nearly fired just before it
    void wakeClipsMod().then(m => m.wakeGaveUp());
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
    // label the wake fire by what actually happened: a turn was taken, or the
    // arm timed out with nobody talking. No-op when no fire is pending (this
    // also runs at the end of follow-up windows).
    void wakeClipsMod().then(m => m.resolveWakeFire(captured, lastSpeakerName.current));
    if (!wakeOn.current || !wakeRef.current) { setMicState('idle'); return; }
    if (!captured || followupS.current <= 0) { await resumeWake(); return; }
    // Phase 4: the follow-up window opens NOW, during her reply, rather than
    // after the audio drains — so you can answer her before she has finished
    // the sentence, which is what a follow-up window was always for. The
    // window itself does not start counting down until she stops talking
    // (see the arm timer), so a long answer no longer eats your time to
    // respond. Wake listening stops because the VAD has the mic instead.
    const mine = epoch.current;
    if (tapVad.current || !wakeOn.current || !wakeRef.current) return;
    await wakeRef.current.stop();
    if (mine !== epoch.current || tapVad.current) return;   // changed while stopping
    inFollowup.current = true;
    await startVadCapture(voiceTurnDone, followupS.current * 1000);
  }

  async function onWake() {
    if (Date.now() < wakeIgnoreUntil.current) return;   // still the last fire
    // Only wake-LISTENING may be woken. Phase 2 leaves the detector running
    // through a capture so the shared device stays open, and phase 4 now
    // keeps a VAD armed through her reply as well — so a command containing
    // the phrase ("tell nova I said hey nova") can re-fire mid-capture and
    // restart the whole arm on top of the one in progress. The 2000 ms
    // debounce in wake.ts is nowhere near enough on its own.
    if (tapVad.current || conversationRef.current) return;
    // Saying the wake word over her IS a barge-in, and it needs both halves:
    // silencing the audio while the turn kept generating meant she went quiet
    // but you still waited out the whole answer before yours was heard.
    const interrupting = speaker.speaking || !!abortRef.current;
    speaker.cancel();                    // barge-in: stop any current reply
    abortRef.current?.abort();           // …and stop producing the rest of it
    // NOT stopping wake here (phase 2): wake and the VAD share one device via
    // micBroker, so stopping would release it and pay the open cost again on
    // the very next turn. Wake fires during capture are ignored by phase.
    wakeIgnoreUntil.current = Date.now() + 1500;
    inFollowup.current = false;
    // capture the command, then hand off to conversation mode; if nothing is
    // said within 10 s (false fire), give up and resume wake listening
    await startVadCapture(voiceTurnDone, 10_000, { barged: interrupting });
  }

  async function wakeToggle() {
    if (micState === 'arming' || micState === 'transcribing') return;
    if (wakeOn.current) {                 // turn off
      bumpEpoch();
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
        model: wakeWord.current, threshold: wakeThreshold.current, onWake,
        capture: wakeLearning.current, mic: wakeMic.current,
        onCapture: c => { void wakeClipsMod().then(m => m.onWakeCapture(c)); } });
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

  // ── conversation mode: tap in once, then just talk ──
  // capture → transcribe → send (spoken reply) → listen again, indefinitely,
  // with no wake phrase between turns. The phone presents it as the
  // full-screen VoiceOverlay; desktop as a hot-mic bar above the composer, so
  // the transcript and tool cards stay visible. Same loop underneath.
  // Leaving tears it down; the mic button mutes/unmutes without leaving.

  /** Arm for the next turn. Silence for `voice.conversation_idle_s` closes the
   *  mode — the only automatic release for a mic that otherwise stays hot. */
  async function armConversation() {
    const idleMs = idleS.current > 0 ? idleS.current * 1000 : undefined;
    await startVadCapture(
      captured => (captured ? voiceLoopDone(true) : closeConversation('idle')),
      idleMs,
      { onCaptured: rearmIfStranded });
  }

  /** Liveness backstop, and nothing more.
   *
   *  The microphone normally comes back the instant the utterance has been
   *  transcribed and dispatched — see the `void sendRef.current` note in
   *  submitUtterance — which is well before she starts speaking, so the whole
   *  reply plays into an open mic. That path covers every ordinary outcome
   *  including the ones that make no sound at all: an empty transcript, a
   *  transcription that threw, a turn where every TTS request failed.
   *
   *  What it does NOT cover is a transcription that simply never settles.
   *  Nothing here waits on a speaker event to decide to arm — deliberately.
   *  Speaker events are edge-triggered and deduped, so a turn that never
   *  speaks never calls back, and hanging the microphone off one is how "it
   *  only activated once" happened in the first place. A wall clock cannot
   *  fail that way. */
  function rearmIfStranded() {
    const mine = epoch.current;
    window.setTimeout(() => {
      if (mine !== epoch.current) return;                      // mode changed under us
      if (!conversationRef.current || tapVad.current) return;   // closed, or already armed
      void armConversation();
    }, REARM_CEILING_MS);
  }

  async function voiceLoopDone(_captured: boolean) {
    // Reached as soon as the utterance is dispatched, not when the answer
    // finishes — so this IS the re-arm, and it happens before she speaks.
    if (!conversationRef.current) { emitListening(false); return; }
    if (tapVad.current) return;               // muted, or the backstop got there first
    await armConversation();
  }

  /** Shared entry for both surfaces. Must run inside the tap gesture. */
  async function openConversation() {
    speaker.enable();               // inside the tap gesture — autoplay policy
    if (!speech) { setSpeech(true); localStorage.setItem('nova.speech', '1'); }
    void wakeClipsMod().then(m => m.wakeGaveUp());   // see tapToggle
    bumpEpoch();
    conversationRef.current = true;
    setConversationOpen(true);
    speaker.earcon('open');          // the mic is live now — say so out loud
    // take the mic over from any other capture mode
    await tapVad.current?.disarm();
    tapVad.current = null;
    await wakeRef.current?.stop();
    await armConversation();
  }

  /** The phone's presentation of the same mode. */
  async function openVoice() {
    setVoiceOpen(true);
    voiceOpenRef.current = true;
    await openConversation();
  }

  async function closeConversation(_reason?: 'idle') {
    bumpEpoch();                     // strand every continuation still in flight
    speaker.earcon('close');         // hands-free: you have to be able to hear it end
    conversationRef.current = false;
    setConversationOpen(false);
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
      bumpEpoch();
      await tapVad.current?.disarm();
      tapVad.current = null;
      setMicState('idle');
      emitListening(false);
    } else if (micState === 'idle') {                          // unmute
      bumpEpoch();
      speaker.cancel();      // never open the mic into her own live playback
      await armConversation();
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
    const previous = mainAgent.model;
    try {
      await patchAgent(mainAgent.id, { model });
      setMainAgent({ ...mainAgent, model });
    } catch (err) {
      // The select is uncontrolled-in-effect: the browser has already moved
      // to the new option. Logging to the console and leaving it there told
      // the operator they had switched models when the write had failed —
      // and every later reply came from the old one. Put it back, and say so.
      console.error('model change failed:', err);
      setMainAgent({ ...mainAgent, model: previous });
      setItems(prev => [...prev, { id: uid(), kind: 'error',
        content: `Couldn't switch to ${model}: ${errText(err)}. Still on ${previous}.` }]);
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
              speaker: m.speaker && m.speaker.role !== 'operator'
                ? { name: m.speaker.name, role: m.speaker.role } : undefined,
              attachments: m.attachments?.map(a => ({ kind: a.kind, name: a.name, mime: a.mime })) }));
        void loadConsents(conv.id);
      } catch (err) {
        setItems([{ id: uid(), kind: 'error', content: `Failed to load history: ${err}` }]);
      }
    })();
  }, []);

  // Autoscroll ONLY when the operator is already at the bottom. It used to
  // fire on every `items` change — i.e. every streamed token — which both
  // restarted a smooth-scroll animation ~40×/s and made it impossible to
  // scroll up and read anything while Nova was replying: you got yanked back
  // down on the next token. rAF instead of 'smooth' so it lands in one frame
  // rather than animating over the top of the next one.
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const pinnedRef = useRef(true);
  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const onScroll = () => {
      pinnedRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, []);
  useEffect(() => {
    if (!pinnedRef.current) return;
    const id = requestAnimationFrame(() => endRef.current?.scrollIntoView());
    return () => cancelAnimationFrame(id);
  }, [items]);

  // #7's ChatPanel half: presence views (the orb) listen for these events
  const emitPresence = (active: boolean, kind?: 'thinking' | 'dispatch' | 'tool') =>
    window.dispatchEvent(new CustomEvent('nova:chat-activity', { detail: { active, kind } }));

  async function send(opts?: { text?: string; source?: string; speak?: boolean;
                               speakerId?: string; front?: boolean;
                               speakerTag?: { name: string; role: string } }) {
    const message = (opts?.text ?? input).trim();
    // composer sends carry the picked attachments; voice/queued turns don't
    const atts = opts?.text === undefined ? pending : [];
    if (!message && atts.length === 0) return;
    if (busy) {
      // Anything arriving mid-turn used to hit `|| busy` and evaporate with
      // no trace. The composer was fine — submitComposer queues — but every
      // caller that passes its own text bypassed that: a voice utterance
      // while Nova was still talking, and a consent approval clicked during
      // the turn that requested it. The operator saw their word or their
      // click accepted and nothing happen. Queue it instead; the drain
      // effect sends it whole the moment the turn ends.
      if (opts?.text) {
        const turn: QueuedTurn = { ...opts, text: opts.text };
        // a barge-in goes first: you cut her off to say it
        setQueue(q => (opts.front ? [turn, ...q] : [...q, turn]));
      }
      return;
    }
    if (opts?.text === undefined) { setInput(''); setPending([]); }
    setBusy(true);
    const ac = new AbortController();   // interject aborts this turn
    abortRef.current = ac;
    emitPresence(true, 'thinking');
    let lastPresence = Date.now();
    // voice turns speak the reply even if the mute toggle is off
    const speakThisTurn = opts?.speak ?? speech;

    setItems(prev => [...prev, { id: uid(), kind: 'msg', role: 'user', content: message,
      speaker: opts?.speakerTag,
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
                                           atts.map(({ kind, name, mime, data }) => ({ kind, name, mime, data })),
                                           opts?.speakerId)) {
        if (event.type === 'meta') {
          liveTraceId = event.traceId ?? null;
        } else if (event.type === 'text') {
          appendToAssistant(event.text);
          if (speakThisTurn) speaker.feed(event.text);
          if (Date.now() - lastPresence > 5000) {   // long streams stay "thinking"
            emitPresence(true, 'thinking');
            lastPresence = Date.now();
          }
        } else if (event.type === 'subText') {
          // never spoken (speaker.feed is only fed by 'text') and never
          // persisted — it exists so a multi-minute dispatch shows life
          const who = event.agent || 'specialist';
          setItems(prev => {
            // one accordion per (turn, agent): keyed by this turn's assistant
            // bubble so a new turn never appends to the last one's
            const idx = prev.findIndex(it => it.kind === 'subtext'
                                             && it.agent === who && it.turnId === assistantId);
            if (idx >= 0) {
              const found = prev[idx] as Extract<Item, { kind: 'subtext' }>;
              const merged: Item = { ...found, content: found.content + event.text };
              return [...prev.slice(0, idx), merged, ...prev.slice(idx + 1)];
            }
            const at = prev.findIndex(it => it.id === assistantId);
            const line: Item = { id: uid(), kind: 'subtext', agent: who,
                                 turnId: assistantId, content: event.text };
            return at < 0 ? [...prev, line]
              : [...prev.slice(0, at), line, ...prev.slice(at)];
          });
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
  async function runSlash(name: string, arg: string) {
    setInput('');
    try {
      const message = await runCommand(name, arg);
      // /clear empties the transcript, because leaving the old turns on
      // screen after clearing the context would show a conversation Nova
      // can no longer see — the worst kind of lie a UI can tell.
      if (name === 'clear') setItems([]);
      setItems(prev => [...prev, { id: uid(), kind: 'note', content: message }]);
    } catch (err) {
      setItems(prev => [...prev, { id: uid(), kind: 'error', content: errText(err) }]);
    }
    inputRef.current?.focus();
  }

  /** Enter/Tab/arrows while the palette is open. Returns true if handled. */
  function paletteKey(e: React.KeyboardEvent): boolean {
    if (!paletteOpen) return false;
    if (e.key === 'ArrowDown') {
      e.preventDefault(); setCmdIdx(i => (i + 1) % cmdMatches.length); return true;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      setCmdIdx(i => (i - 1 + cmdMatches.length) % cmdMatches.length); return true;
    }
    if (e.key === 'Escape') { setInput(''); return true; }
    if (e.key === 'Tab' || e.key === 'Enter') {
      e.preventDefault();
      void runSlash(cmdMatches[cmdIdx].name, '');
      return true;
    }
    return false;
  }

  function submitComposer() {
    const msg = input.trim();
    if (!msg && pending.length === 0) return;
    // A leading slash is a command only when it MATCHES one. "/home/jeremy/
    // workspace/nova is the path" is a sentence, and swallowing it would be
    // worse than having no commands at all.
    const slash = /^\/([a-z0-9-]+)(?:\s+([\s\S]*))?$/i.exec(msg);
    if (slash && commands.some(c => c.name === slash[1].toLowerCase())) {
      void runSlash(slash[1].toLowerCase(), slash[2] || '');
      return;
    }
    if (busy) {
      // text queues; attachments wait in the composer for the next idle send
      if (msg) { setQueue(q => [...q, { text: msg }]); setInput(''); }
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
    setQueue(q => [{ text: msg }, ...q]);
    abortRef.current?.abort();
  }

  // stop with nothing to say: same abort, no follow-up queued
  function stopTurn() {
    if (!busy) return;
    abortRef.current?.abort();
  }

  // drain the queue whenever Nova goes idle — one turn at a time
  const sendRef = useRef(send);
  useEffect(() => { sendRef.current = send; });
  useEffect(() => {
    if (busy || queue.length === 0) return;
    const next = queue[0];
    setQueue(q => q.slice(1));
    void sendRef.current(next);
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

  // What the hot-mic bar says. The mic is open indefinitely in conversation
  // mode, so this must always be readable at a glance and must never claim to
  // be listening when it isn't.
  const conversationLabel =
    micState === 'capturing' ? 'Hearing you…'
    : micState === 'transcribing' ? 'Got it — writing that down…'
    : micState === 'arming' ? 'Getting the mic ready…'
    : micState === 'armed' ? 'Listening — just talk'
    : voiceState.speaking ? `${assistantName} is replying…`
    : busy ? `${assistantName} is thinking…`
    : 'Muted — tap the mic to listen again';

  // shared by both composers' mode mic (wake / tap / hold)
  const micModeTitle =
    listenMode === 'wake'
      ? (micState === 'wake' ? `Listening for “${wakeLabel(wakeWord.current)}” — tap to stop`
        : micState === 'armed' ? (inFollowup.current
          ? 'Still listening — just talk, no wake phrase needed'
          : 'Wake word heard — speak now')
          : micState === 'capturing' ? 'Heard you — capturing…'
            : micState === 'arming' ? 'Loading wake word…'
              : `Tap to listen hands-free for “${wakeLabel(wakeWord.current)}”`)
      : listenMode === 'tap'
        ? (micState === 'armed' ? 'Listening — tap to cancel'
          : micState === 'capturing' ? 'Hearing you…'
            : micState === 'arming' ? 'Loading speech detector…'
              : 'Tap to talk (auto-stops when you pause)')
        : (micState === 'recording' ? 'Recording — release to send' : 'Hold to talk');
  const micModeLabel =
    listenMode === 'wake' ? 'Wake word' : listenMode === 'tap' ? 'Tap to talk' : 'Hold to talk';
  const micModeGlyph =
    micState === 'transcribing' ? '…' : micState === 'arming' ? '⏳'
      : listenMode === 'wake' && micState === 'wake' ? '👂' : '🎤';

  const commandPalette = paletteOpen ? (
    <div className="absolute bottom-full left-0 right-0 mb-1 z-20 rounded-lg border border-stone-700 bg-stone-900/95 backdrop-blur shadow-xl overflow-hidden">
      {cmdMatches.map((c, i) => (
        <button
          key={c.name}
          type="button"
          onMouseEnter={() => setCmdIdx(i)}
          onClick={() => void runSlash(c.name, '')}
          className={`w-full text-left px-3 py-2 ${i === cmdIdx ? 'bg-stone-800' : ''}`}
        >
          <span className="text-sm text-teal-400 font-mono">/{c.name}</span>
          <span className="text-xs text-stone-400"> — {c.summary}</span>
          {i === cmdIdx && c.detail && (
            <span className="block text-[11px] text-stone-500 mt-0.5">{c.detail}</span>
          )}
        </button>
      ))}
    </div>
  ) : null;


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
              {groupModels(models).map(g => (
                <optgroup key={g.slug} label={g.label}>
                  {g.models.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
                </optgroup>
              ))}
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
                    {groupModels(models).map(g => (
                      <optgroup key={g.slug} label={g.label}>
                        {g.models.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
                      </optgroup>
                    ))}
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

      <div ref={scrollerRef}
           className="flex-1 overflow-y-auto overflow-x-hidden nice-scroll p-4 space-y-2">
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
              <span className="truncate">{q.text}</span>
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

      {/* Conversation mode on desktop: a bar, not a takeover — the transcript
          and tool cards stay visible while you talk. (The phone gets the
          full-screen VoiceOverlay instead; rendering both would put a second
          WebGL context beside the live universe canvas.) */}
      {!mobile && conversationOpen && (
        <div className="px-3 pt-2 flex items-center gap-2 border-t border-stone-800">
          <div className="flex-1 min-w-0 flex items-center gap-2.5 rounded-full bg-stone-900 border border-teal-800/70 px-3 py-2">
            <span className={`shrink-0 w-2.5 h-2.5 rounded-full ${
              micState === 'capturing' ? 'bg-red-500 animate-pulse'
                : micState === 'armed' ? 'bg-teal-400 animate-pulse'
                : micState === 'arming' || micState === 'transcribing' ? 'bg-stone-500'
                  : voiceState.speaking || busy ? 'bg-teal-700'
                    : 'bg-stone-600'}`} />
            <span className="truncate text-xs text-stone-300">{conversationLabel}</span>
          </div>
          <button
            type="button"
            onClick={() => void voiceMicToggle()}
            disabled={micState === 'arming' || micState === 'transcribing'}
            title={micState === 'armed' || micState === 'capturing' ? 'Mute the mic' : 'Listen again'}
            aria-label={micState === 'armed' || micState === 'capturing' ? 'Mute the mic' : 'Listen again'}
            className="shrink-0 w-9 h-9 rounded-full border border-stone-700 text-stone-300 hover:border-teal-600 disabled:opacity-40 flex items-center justify-center"
          >
            {micState === 'armed' || micState === 'capturing' ? (
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M12 2a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3" />
                <path d="M19 10v1a7 7 0 0 1-14 0v-1M12 18v4" />
              </svg>
            ) : (
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M9 5a3 3 0 0 1 6 0v6" />
                <path d="M19 10v1a7 7 0 0 1-10.6 6M5 10v1c0 .9.17 1.77.48 2.56M12 18v4" />
                <path d="M3 3l18 18" />
              </svg>
            )}
          </button>
          <button
            type="button"
            onClick={() => void closeConversation()}
            title="Leave conversation mode"
            aria-label="Leave conversation mode"
            className="shrink-0 px-4 h-9 rounded-full bg-stone-100 text-stone-900 text-xs font-medium"
          >
            End
          </button>
        </div>
      )}

      {mobile ? (
        // the mockup composer: one rounded pill — +, the field, then the mic
        // (voice mode) or, once there's something to send, the send arrow
        <form
          onSubmit={e => { e.preventDefault(); submitComposer(); }}
          className="relative px-3 pt-1.5"
          style={{ paddingBottom: 'calc(0.75rem + env(safe-area-inset-bottom))' }}
        >
          {commandPalette}
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
                if (paletteKey(e)) return;
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
            {/* Mode mic — wake / tap / hold, per voice.listen_mode. Until now
                the mobile composer ignored that setting entirely, so the phone
                had NO hands-free path: the only voice control here was the
                Talk button, which requires a tap. */}
            <button
              type="button"
              onClick={listenMode === 'tap' ? tapToggle : listenMode === 'wake' ? wakeToggle : undefined}
              onPointerDown={listenMode === 'ptt' ? pttStart : undefined}
              onPointerUp={listenMode === 'ptt' ? pttEnd : undefined}
              onPointerCancel={listenMode === 'ptt' ? pttEnd : undefined}
              disabled={micState === 'transcribing' || micState === 'arming'}
              title={micModeTitle}
              aria-label={micModeLabel}
              className={`shrink-0 w-9 h-9 rounded-full flex items-center justify-center select-none touch-none text-sm ${
                micState === 'recording' || micState === 'capturing'
                  ? 'bg-red-600 text-white animate-pulse'
                  : micState === 'armed' || micState === 'wake'
                    ? 'bg-teal-700 text-teal-100 animate-pulse'
                    : 'text-stone-300 disabled:opacity-40'}`}
            >
              {micModeGlyph}
            </button>
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
            ) : busy ? (
              // Stopping used to require typing something first — "Now"
              // only appears with text in the box — so a stream that stalled
              // left "thinking…" on screen with no way out but a reload.
              <button
                type="button"
                onClick={stopTurn}
                aria-label={`Stop ${assistantName}`}
                title={`Stop ${assistantName}`}
                className="shrink-0 w-9 h-9 rounded-full bg-stone-700 text-white flex items-center justify-center"
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                  <rect x="6" y="6" width="12" height="12" rx="2" />
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
        className="relative border-t border-stone-700 p-3 flex items-end gap-2"
      >
        {commandPalette}
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
            if (paletteKey(e)) return;
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
          disabled={micState === 'transcribing' || micState === 'arming' || conversationOpen}
          title={conversationOpen ? 'Conversation mode has the mic' : micModeTitle}
          aria-label={micModeLabel}
          className={`px-3 py-2 rounded text-sm transition select-none touch-none ${
            conversationOpen
              ? 'bg-stone-800 text-stone-500'
              : micState === 'recording' || micState === 'capturing'
                ? 'bg-red-600 text-white animate-pulse'
                : micState === 'armed' || micState === 'wake'
                  ? 'bg-teal-700 text-teal-100 animate-pulse'
                  : 'bg-stone-700 hover:bg-stone-600 text-stone-200 disabled:opacity-50'}`}
        >
          {micModeGlyph}
        </button>
        {/* Conversation mode: one click buys a back-and-forth with no wake
            phrase between turns. This loop already existed but was reachable
            only from the phone composer. */}
        {!conversationOpen && (
          <button
            type="button"
            onClick={() => void openConversation()}
            disabled={micState === 'arming' || micState === 'transcribing'}
            title={`Talk with ${assistantName} — the mic stays open until you end it`}
            aria-label={`Talk with ${assistantName}`}
            className="px-3 py-2 rounded text-sm transition bg-stone-700 hover:bg-stone-600 text-stone-200 disabled:opacity-50"
          >
            Talk
          </button>
        )}
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
          onClose={() => void closeConversation()}
          onSendText={t => void send({ text: t, source: 'voice', speak: true })}
        />
      )}
    </aside>
  );
}
