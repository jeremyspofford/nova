import { useCallback, useEffect, useRef, useState } from 'react';
import {
  getActiveConversation, getMessages, guestSession, pickGuestModel,
  setAuthToken, streamChat,
} from '../api';
import { Markdown } from '../components/Markdown';

/** The page a guest link opens (docs/plans/public-access-and-guests.md §3).
 *
 *  A SEPARATE SHELL, deliberately, and the reason is the route allowlist. A
 *  guest token reaches exactly five endpoints; `AppShell` and `ChatPanel`
 *  between them call dozens — traces, voice, settings, models, attachments —
 *  and every one of those would 403. Reusing them would mean either widening
 *  the allowlist to make the UI quiet (the hole the whole lane exists to
 *  avoid) or shipping a console that logs a wall of red. This renders from
 *  the four routes a guest actually has.
 *
 *  Nothing here is a control. The model dropdown lists what the SESSION says
 *  it may run, the countdown reads the session's own `expires_at`, and both
 *  are refused again server-side — a guest editing this page's state, or
 *  calling the API directly, gets exactly the same answers.
 */

interface Msg { role: string; content: string }

function remaining(iso: string | null): string {
  if (!iso) return '';
  // Postgres renders "+00:00" with a space rather than a T; Safari refuses
  // that shape outright and returns NaN, so it is normalised before parsing.
  const ms = new Date(iso.replace(' ', 'T')).getTime() - Date.now();
  if (Number.isNaN(ms)) return '';
  if (ms <= 0) return 'expired';
  const mins = Math.floor(ms / 60000);
  if (mins < 60) return `${mins} min left`;
  const hrs = Math.floor(mins / 60);
  return hrs < 48 ? `${hrs}h ${mins % 60}m left` : `${Math.floor(hrs / 24)} days left`;
}

export function GuestChat() {
  const [session, setSession] = useState<{
    label: string; expires_at: string | null;
    allowed_models: string[]; model: string;
  } | null>(null);
  const [fatal, setFatal] = useState('');
  const [messages, setMessages] = useState<Msg[]>([]);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [live, setLive] = useState('');
  const [left, setLeft] = useState('');
  const endRef = useRef<HTMLDivElement>(null);

  // login-by-link: the token rides in the FRAGMENT, which never crosses the
  // network and never reaches an access log. Same mechanism as the operator's
  // phone-setup QR — and it is stored under the same key, because which
  // identity a token carries is decided by the backend from the token itself,
  // never by which slot the browser kept it in.
  useEffect(() => {
    const m = window.location.hash.match(/token=([^&]+)/);
    if (m) {
      setAuthToken(decodeURIComponent(m[1]).trim());
      history.replaceState(null, '', window.location.pathname);
    }
    guestSession().then(setSession).catch(e => setFatal(String(e.message ?? e)));
  }, []);

  useEffect(() => {
    if (!session) return;
    const tick = () => setLeft(remaining(session.expires_at));
    tick();
    const t = setInterval(tick, 30_000);
    return () => clearInterval(t);
  }, [session]);

  // Their own transcript, from their own conversation. The id comes from
  // /conversations/active, which answers with the GUEST's row for a guest
  // token — asking for it by id from the client would be the same question
  // with a worse answer.
  useEffect(() => {
    if (!session) return;
    (async () => {
      try {
        const conv = await getActiveConversation();
        const page = await getMessages(conv.id);
        setMessages(page.messages
          .filter(m => m.role === 'user' || m.role === 'assistant')
          .map(m => ({ role: m.role, content: m.content ?? '' })));
      } catch { /* an empty transcript is the normal first visit */ }
    })();
  }, [session]);

  useEffect(() => { endRef.current?.scrollIntoView({ behavior: 'smooth' }); },
    [messages, live]);

  const send = useCallback(async () => {
    const text = draft.trim();
    if (!text || busy) return;
    setDraft(''); setBusy(true); setLive('');
    setMessages(m => [...m, { role: 'user', content: text }]);
    let acc = '';
    try {
      for await (const ev of streamChat(text)) {
        if (ev.type === 'text') { acc += ev.text; setLive(acc); }
        else if (ev.type === 'error') { acc += `\n\n_${ev.error}_`; setLive(acc); }
      }
    } catch (e) {
      // The reason is the body, and for a guest the two that matter are
      // "this link expired" and "that model is not available here". Showing
      // the status line instead would leave them with nothing to act on.
      acc += (acc ? '\n\n' : '') + `_${String((e as Error).message ?? e)}_`;
    } finally {
      setMessages(m => [...m, { role: 'assistant', content: acc }]);
      setLive(''); setBusy(false);
    }
  }, [draft, busy]);

  if (fatal) {
    return (
      <div className="w-full h-screen bg-stone-950 flex items-center justify-center p-4">
        <div className="w-full max-w-sm rounded-xl bg-stone-900/95 border border-stone-700
                        shadow-2xl p-6 space-y-2 text-center">
          <h1 className="text-teal-400 font-semibold text-lg">Nova</h1>
          <p className="text-sm text-stone-300">{fatal}</p>
          <p className="text-xs text-stone-500">
            Guest links are time-boxed. Ask for a new one.
          </p>
        </div>
      </div>
    );
  }

  if (!session) return <div className="w-full h-screen bg-stone-950" />;

  return (
    <div className="w-full h-screen bg-stone-950 flex flex-col text-stone-200">
      <header className="shrink-0 border-b border-stone-800 px-4 py-2.5 flex flex-wrap
                         items-center gap-x-3 gap-y-1">
        <span className="text-teal-400 font-semibold">Nova</span>
        <span className="text-xs text-stone-500">guest &middot; {session.label}</span>
        <span className="text-xs text-stone-500 ml-auto">{left}</span>
        <select
          value={session.model}
          onChange={async e => {
            const model = e.target.value;
            const prev = session.model;
            setSession(s => s && { ...s, model });
            try { await pickGuestModel(model); }
            // The server refused, so the UI must go back — a dropdown that
            // keeps showing a model the backend will not run is a lie the
            // guest would only discover through a failed turn.
            catch { setSession(s => s && { ...s, model: prev }); }
          }}
          className="bg-stone-900 border border-stone-700 rounded px-2 py-1 text-xs">
          {session.allowed_models.map(m => <option key={m} value={m}>{m}</option>)}
        </select>
      </header>

      <div className="flex-1 overflow-y-auto nice-scroll px-4 py-4 space-y-4">
        {messages.length === 0 && !live && (
          <p className="text-sm text-stone-500 max-w-prose">
            This is a guest session. You can chat, and Nova can search the web
            and keep notes for you &mdash; those notes are yours alone and are
            deleted when this link is revoked.
          </p>
        )}
        {messages.map((m, i) => (
          <div key={i} className={m.role === 'user' ? 'text-right' : ''}>
            <div className={'inline-block max-w-[46rem] text-left rounded-lg px-3 py-2 '
              + (m.role === 'user'
                ? 'bg-teal-900/40 border border-teal-800/50'
                : 'bg-stone-900/60 border border-stone-800')}>
              <Markdown>{m.content}</Markdown>
            </div>
          </div>
        ))}
        {live && (
          <div>
            <div className="inline-block max-w-[46rem] rounded-lg px-3 py-2
                            bg-stone-900/60 border border-stone-800">
              <Markdown>{live}</Markdown>
            </div>
          </div>
        )}
        <div ref={endRef} />
      </div>

      <form
        onSubmit={e => { e.preventDefault(); void send(); }}
        className="shrink-0 border-t border-stone-800 p-3 flex gap-2">
        <input
          value={draft}
          onChange={e => setDraft(e.target.value)}
          placeholder={busy ? 'Nova is answering…' : 'Message Nova'}
          className="flex-1 bg-stone-900 border border-stone-700 rounded px-3 py-2
                     text-sm outline-none focus:border-teal-700" />
        <button type="submit" disabled={busy || !draft.trim()}
          className="bg-teal-700 hover:bg-teal-600 disabled:opacity-40 text-white
                     rounded px-4 text-sm">
          Send
        </button>
      </form>
    </div>
  );
}
