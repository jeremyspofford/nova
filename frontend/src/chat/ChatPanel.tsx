import { useEffect, useRef, useState } from 'react';
import {
  streamChat, getActiveConversation, getAgents, getMessages, getModels,
  patchAgent, Activity, ModelInfo,
} from '../api';
import { Markdown } from '../components/Markdown';
import { displayName } from '../names';

type Item =
  | { id: string; kind: 'msg'; role: 'user' | 'assistant'; content: string; streaming?: boolean }
  | { id: string; kind: 'activity'; activity: Activity }
  | { id: string; kind: 'error'; content: string };

let nextId = 0;
const uid = () => `ui-${++nextId}`;

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
}

const MIN_W = 320;
const MAX_W = 760;

export function ChatPanel({ width, onWidthChange }: ChatPanelProps) {
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
        setItems(msgs.map(m => ({
          id: m.id, kind: 'msg' as const, role: m.role, content: m.content,
        })));
      } catch (err) {
        setItems([{ id: uid(), kind: 'error', content: `Failed to load history: ${err}` }]);
      }
    })();
  }, []);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [items]);

  async function send() {
    const message = input.trim();
    if (!message || busy) return;
    setInput('');
    setBusy(true);

    setItems(prev => [...prev, { id: uid(), kind: 'msg', role: 'user', content: message }]);
    const assistantId = uid();
    setItems(prev => [...prev, { id: assistantId, kind: 'msg', role: 'assistant', content: '', streaming: true }]);

    const appendToAssistant = (text: string) =>
      setItems(prev => prev.map(it =>
        it.id === assistantId && it.kind === 'msg' ? { ...it, content: it.content + text } : it));

    try {
      for await (const event of streamChat(message, conversationId ?? undefined)) {
        if (event.type === 'text') {
          appendToAssistant(event.text);
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
      {/* drag handle — widen/narrow the chat */}
      <div
        className="absolute left-0 top-0 bottom-0 w-1.5 cursor-col-resize hover:bg-teal-700/50 transition-colors"
        onPointerDown={() => { resizing.current = true; document.body.style.cursor = 'col-resize'; }}
        onDoubleClick={() => onWidthChange(384)}
        title="Drag to resize (double-click to reset)"
      />
      <header className="px-4 py-3 border-b border-stone-700 flex items-center justify-between gap-2">
        <span className="text-teal-400 font-semibold shrink-0">Nova</span>
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
          <span className="text-xs text-stone-500 shrink-0">{busy ? 'thinking…' : 'ready'}</span>
        </div>
      </header>

      <div className="flex-1 overflow-y-auto overflow-x-hidden nice-scroll p-4 space-y-2">
        {items.length === 0 && (
          <div className="text-center text-stone-500 mt-10">
            <p className="text-base font-medium text-stone-400">Talk to Nova</p>
            <p className="text-sm mt-1">One continuous conversation — it remembers.</p>
          </div>
        )}

        {items.map(item => {
          if (item.kind === 'activity') {
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
        })}
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
