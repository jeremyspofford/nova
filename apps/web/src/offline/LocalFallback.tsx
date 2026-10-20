// Local fallback in a chat (FR-128, docs/21 §9): while the Hub is unreachable, in the desktop app,
// a model on this computer (through its Nova device agent, `novaShell.localRuntime`) can answer the
// messages that wait for the Hub, with the chat from this device's offline copy as context. The
// answer is kept on this device and queued for the Hub as a message marked as written offline.
// Elsewhere it says why it is not offered: no desktop app, no offline copy, or this chat is not in
// it. Answers are model output: shown as plain text, never as HTML.
import { useEffect, useId, useRef, useState } from 'react';
import { defineMessages } from '@nova/i18n';
import type {
  NovaShellBridge,
  ShellLocalChatMessage,
  ShellLocalRuntimeModelsView,
} from '@nova/shared';
import { Button, Icon, SelectField, Spinner } from '@nova/ui';
import { LOCAL_RUNTIME_SCOPE } from '../replica/api.ts';
import { currentFields, threadTranscript, threadView } from '../replica/views.ts';
import { useAnnounce } from '../services.tsx';
import { useOffline } from './context.tsx';
import { problemText, queueStatus } from './format.ts';
import { Chip, CopyText } from './parts.tsx';
import { answerParent, type QueueItem } from './queue.ts';
import './offline.css';

export const LOCAL_TEXT = defineMessages('offline.local', {
  title: 'Answer on this computer',
  noDesktop:
    'While the Hub is unreachable, a model on this computer can answer only in the Nova desktop app.',
  noCopy:
    "This computer's model cannot answer here: this device keeps no offline copy of your chats to give it.",
  notInCopy:
    "This chat is not in this device's offline copy, so this computer's model cannot answer it.",
  notGranted:
    "This computer's model can answer only on a device the Hub gave Local models. Change that on this device's page in Devices.",
  appSilent: 'The desktop app did not answer.',
  answering: "This computer's model is answering.",
  ready: 'Answer ready. It is kept on this device and goes to the Hub when it is back.',
  modelSilent: "This computer's model did not answer.",
  noAnswer: 'No answer: {message}',
  looking: 'Looking for models on this computer',
  serverSilent: "This computer's model server did not answer.",
  checkAgain: 'Check again',
  noModels: 'No models were found on this computer.',
  model: 'Model on this computer',
  answer: "Answer with this computer's model",
  allAnswered:
    'Every message waiting for the Hub has an answer from this computer. Send another to ask more.',
  sendFirst:
    "Send a message first. It waits for the Hub, and this computer's model can answer it now.",
  modelAnswering: '{model} is answering…',
  answers: 'Answers from this computer',
  byModel:
    "{named, select, yes {This computer's model ({model})} other {This computer's model (local)}}",
  inAnswerTo: 'In answer to “{text}”',
});

/** The desktop shell's bridge, when the app runs inside it. */
export function shellBridge(): NovaShellBridge | null {
  const w = window as unknown as { novaShell?: NovaShellBridge };
  return w.novaShell ?? null;
}

/** How much of the chat goes to the local model: the newest turns, within a character budget. */
const MAX_TURNS = 40;
const MAX_CHARS = 60_000;

function clip(s: string, n = 120): string {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > n ? `${one.slice(0, n - 1)}…` : one;
}

function trim(messages: ShellLocalChatMessage[]): ShellLocalChatMessage[] {
  const system = messages.filter((m) => m.role === 'system');
  const turns = messages.filter((m) => m.role !== 'system').slice(-MAX_TURNS);
  let total = system.reduce((n, m) => n + m.content.length, 0);
  const kept: ShellLocalChatMessage[] = [];
  for (const m of [...turns].reverse()) {
    total += m.content.length;
    if (total > MAX_CHARS && kept.length) break;
    kept.unshift(m);
  }
  return [...system, ...kept];
}

type Models =
  | { state: 'loading' }
  | { state: 'ready'; view: ShellLocalRuntimeModelsView }
  | { state: 'error'; message: string };

export function LocalFallback({ threadId }: { threadId: string | null }) {
  const { runtime, state } = useOffline();
  if (!runtime || state.hub !== 'offline' || !threadId) return null;
  const shell = shellBridge();
  const note = (text: string) => (
    <aside className="of-local" aria-label={LOCAL_TEXT.title}>
      <p className="muted of-local-note">
        <Icon name="server" /> {text}
      </p>
    </aside>
  );
  if (!shell) return note(LOCAL_TEXT.noDesktop);
  const src = runtime.viewSource();
  if (!src) return note(LOCAL_TEXT.noCopy);
  if (!threadView(src, threadId)) return note(LOCAL_TEXT.notInCopy);
  // The Hub takes answers from this computer only from a device it gave Local models (FR-128).
  if (!(state.scopes ?? []).includes(LOCAL_RUNTIME_SCOPE)) return note(LOCAL_TEXT.notGranted);
  return <LocalAnswer threadId={threadId} shell={shell} />;
}

function LocalAnswer({ threadId, shell }: { threadId: string; shell: NovaShellBridge }) {
  const { runtime, state } = useOffline();
  const announce = useAnnounce();
  const headingId = useId();
  const [models, setModels] = useState<Models>({ state: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const [model, setModel] = useState('');
  const [draft, setDraft] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    shell.localRuntime.models().then(
      (view) => {
        if (!alive.current) return;
        setModels({ state: 'ready', view });
        setModel((m) => (m && view.models.includes(m) ? m : (view.models[0] ?? '')));
      },
      (err: unknown) =>
        alive.current &&
        setModels({
          state: 'error',
          message: err instanceof Error && err.message ? err.message : LOCAL_TEXT.appSilent,
        }),
    );
    return () => {
      alive.current = false;
    };
  }, [shell, attempt]);

  const mine = state.queue.filter((i) => i.threadId === threadId && i.status !== 'done');
  const questions = mine.filter((i) => i.kind === 'message');
  const answers = state.queue.filter((i) => i.kind === 'answer' && i.threadId === threadId);
  const answered = new Set(answers.map(answerParent));
  const question = [...questions].reverse().find((q) => !answered.has(q.entityId)) ?? null;

  const ask = async () => {
    const src = runtime?.viewSource();
    if (!runtime || !src || !question || !model) return;
    const thread = threadView(src, threadId);
    const instructions = thread?.projectId
      ? currentFields(src, 'project', thread.projectId)?.instructions
      : null;
    const messages: ShellLocalChatMessage[] = [];
    if (typeof instructions === 'string' && instructions.trim())
      messages.push({ role: 'system', content: instructions });
    for (const m of threadTranscript(src, threadId)) {
      if (m.role !== 'user' && m.role !== 'assistant') continue;
      const text = m.parts
        .map((p) => (p.type === 'text' ? p.text : ''))
        .join('\n\n')
        .trim();
      if (text) messages.push({ role: m.role, content: text });
    }
    // What waits for the Hub, with the answers this computer already gave, up to the question.
    for (const q of questions) {
      messages.push({ role: 'user', content: q.text ?? '' });
      if (q.id === question.id) break;
      const a = answers.find((x) => answerParent(x) === q.entityId);
      if (a?.text) messages.push({ role: 'assistant', content: a.text });
    }
    setError(null);
    setDraft('');
    announce(LOCAL_TEXT.answering);
    try {
      const res = await shell.localRuntime.chat({ model, messages: trim(messages) }, (delta) => {
        if (alive.current) setDraft((d) => (d ?? '') + delta);
      });
      await runtime.addAnswer({ threadId, parentId: question.entityId, text: res.text, model });
      announce(LOCAL_TEXT.ready);
    } catch (err) {
      const message = err instanceof Error && err.message ? err.message : LOCAL_TEXT.modelSilent;
      setError(message);
      announce(LOCAL_TEXT.noAnswer({ message }));
    } finally {
      if (alive.current) setDraft(null);
    }
  };

  const askedBy = (a: QueueItem) =>
    state.queue.find((q) => q.kind === 'message' && q.entityId === answerParent(a))?.text ?? null;
  const busy = draft !== null;
  const view = models.state === 'ready' ? models.view : null;
  return (
    <section className="of-local" aria-labelledby={headingId}>
      <h2 id={headingId} className="of-local-title">
        <Icon name="server" /> {LOCAL_TEXT.title}
      </h2>
      {models.state === 'loading' ? <Spinner label={LOCAL_TEXT.looking} /> : null}
      {models.state === 'error' || (view && !view.ok) ? (
        <div role="alert" className="ws-error">
          <p>
            {models.state === 'error' ? models.message : (view?.message ?? LOCAL_TEXT.serverSilent)}
          </p>
          <Button onClick={() => setAttempt((a) => a + 1)}>{LOCAL_TEXT.checkAgain}</Button>
        </div>
      ) : null}
      {view?.ok && !view.models.length ? <p className="muted">{LOCAL_TEXT.noModels}</p> : null}
      {view?.ok && view.models.length ? (
        <div className="row of-local-controls">
          <SelectField
            label={LOCAL_TEXT.model}
            value={model}
            onChange={setModel}
            options={view.models.map((m) => ({ value: m, label: m }))}
            disabled={busy}
          />
          <Button
            variant="primary"
            disabled={busy || !question || !model}
            onClick={() => void ask()}
          >
            {busy ? <Spinner /> : null} {LOCAL_TEXT.answer}
          </Button>
        </div>
      ) : null}
      {view?.ok && view.models.length && !question && !busy ? (
        <p className="muted">{questions.length ? LOCAL_TEXT.allAnswered : LOCAL_TEXT.sendFirst}</p>
      ) : null}
      {busy ? (
        <div className="of-answer" aria-busy="true">
          <p className="of-answer-head muted">
            <Spinner /> {LOCAL_TEXT.modelAnswering({ model })}
          </p>
          <p className="of-text" dir="auto">
            {draft}
          </p>
        </div>
      ) : null}
      {error ? (
        <p role="alert" className="nv-field-error">
          {error}
        </p>
      ) : null}
      {answers.length ? (
        <ul className="ws-list" aria-label={LOCAL_TEXT.answers}>
          {answers.map((a) => (
            <li key={a.id} className="of-answer">
              <div className="of-answer-head">
                <span className="muted">
                  {LOCAL_TEXT.byModel({ named: a.model ? 'yes' : 'no', model: a.model ?? '' })}
                </span>
                <Chip spec={queueStatus(a.status)} />
                {a.text ? <CopyText text={a.text} kind="answer" /> : null}
              </div>
              {askedBy(a) ? (
                <p className="of-reason muted">
                  {LOCAL_TEXT.inAnswerTo({ text: clip(askedBy(a)!) })}
                </p>
              ) : null}
              {a.status !== 'done' && problemText(a) ? (
                <p className="of-reason">{problemText(a)}</p>
              ) : null}
              <p className="of-text" dir="auto">
                {a.text}
              </p>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
