// A question from the assistant (FR-188, docs/09 §9): a `ask_user` call renders as a question
// card with its choices and, unless the question allows only the choices, a text box. Answering
// resolves the server request that carries the question (found by the call id): the first valid
// answer wins on any device, so a late answer here says it was already answered. An answered
// question shows the answer. The question is the model's text and is shown as plain text.
import { useEffect, useId, useState } from 'react';
import type { ServerRequestView, ToolCallStatus } from '@nova/shared';
import { defineMessages } from '@nova/i18n';
import { Button, Icon, Spinner } from '@nova/ui';
import { ApiError, errorMessage } from '../api.ts';
import { useAnnounce, useServices } from '../services.tsx';
import { eventCorrelation, useDebounced, useWorkEvents } from '../work/events.ts';
import { isTerminal, type DisplayCall } from './thread-state.ts';
import { previewArgs } from './tool-apps.tsx';
import '../work/work.css';

export const ASK_TEXT = defineMessages('chat.ask', {
  fallbackQuestion: 'The assistant has a question.',
  sent: 'Answer sent.',
  alreadyAnswered: 'This question was already answered on another device.',
  expiredBeforeAnswer: 'This question expired before your answer arrived.',
  sendFailed: 'Could not send the answer.',
  /** Read by screen readers before the question. */
  fromAssistant: 'Question from the assistant:',
  loading: 'Loading the question',
  choices: 'Choices',
  yourAnswer: 'Your answer',
  orType: 'Or type an answer',
  type: 'Type your answer',
  send: 'Send answer',
  answered: 'Answered:',
  expired: 'This question expired without an answer.',
  noAnswer: 'No answer was recorded.',
  waiting: 'Waiting for the question…',
});

/** The tool that asks the user a question (docs/08 §1). */
export const ASK_TOOLS: readonly string[] = ['ask_user'];

const FAILED: readonly ToolCallStatus[] = ['error', 'denied', 'timeout', 'cancelled'];

export function isAskCall(call: DisplayCall): boolean {
  return ASK_TOOLS.includes(call.tool) && !FAILED.includes(call.status);
}

/** The answer in a request's result: `{choice}` or `{text}` (server-request.json). */
export function answerText(result: unknown): string | null {
  if (typeof result === 'string') return result;
  if (!result || typeof result !== 'object') return null;
  const r = result as { choice?: unknown; text?: unknown };
  if (typeof r.choice === 'string') return r.choice;
  if (typeof r.text === 'string') return r.text;
  return null;
}

const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && !!x) : [];

export function UserAskCard({ call }: { call: DisplayCall }) {
  const { api } = useServices();
  const announce = useAnnounce();
  const id = useId();
  const args = previewArgs(call.argsPreview);
  /** undefined while looking; null when no request for this call is known. */
  const [req, setReq] = useState<ServerRequestView | null | undefined>(undefined);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [version, setVersion] = useState(0);

  useEffect(() => {
    let alive = true;
    api.listRequests('all').then(
      ({ items }) => {
        if (!alive) return;
        const mine = items
          .filter((r) => r.kind === 'user_input' && r.correlation.callId === call.callId)
          .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
        setReq(mine[0] ?? null);
      },
      () => alive && setReq(null),
    );
    return () => {
      alive = false;
    };
  }, [api, call.callId, version]);

  const reload = useDebounced(() => setVersion((v) => v + 1), 80);
  useWorkEvents((env) => {
    if (!env.name.startsWith('request.')) return;
    const p = env.payload;
    if (eventCorrelation(env).callId === call.callId || (req && p.requestId === req.id)) reload();
  }, reload);

  const payload = req?.payload ?? {};
  const question =
    (typeof payload.question === 'string' && payload.question) ||
    (typeof args.question === 'string' && args.question) ||
    ASK_TEXT.fallbackQuestion;
  const choices = strings(payload.choices).length
    ? strings(payload.choices)
    : strings(args.choices);
  const freeText = choices.length === 0 || payload.allowFreeText !== false;
  const multiline = payload.multiline === true || args.multiline === true;

  const answered = req?.status === 'resolved' ? answerText(req.resolution?.result) : null;
  // Without a request record, a finished call's result is the answer it got.
  const fromCall = !req && isTerminal(call.status) ? call.resultPreview : null;
  const state =
    req === undefined
      ? 'loading'
      : req?.status === 'pending'
        ? 'pending'
        : req?.status === 'expired'
          ? 'expired'
          : answered !== null || fromCall
            ? 'answered'
            : 'waiting';

  const send = async (result: { choice: string } | { text: string }) => {
    if (!req || busy) return;
    setBusy(true);
    setError(null);
    try {
      const view = await api.respondRequest(req.id, result);
      setReq(view);
      setText('');
      announce(ASK_TEXT.sent);
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        setError(ASK_TEXT.alreadyAnswered);
        setVersion((v) => v + 1);
      } else if (err instanceof ApiError && err.status === 410) {
        setError(ASK_TEXT.expiredBeforeAnswer);
        setVersion((v) => v + 1);
      } else {
        setError(errorMessage(err, ASK_TEXT.sendFailed));
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="ask-card"
      role="group"
      aria-labelledby={`${id}-q`}
      data-state={state}
      data-call-id={call.callId}
    >
      <p id={`${id}-q`} className="ask-card-question">
        <Icon name="hand" />
        <span className="nv-vh">{ASK_TEXT.fromAssistant}</span> <span dir="auto">{question}</span>
      </p>
      {state === 'loading' ? <Spinner label={ASK_TEXT.loading} /> : null}
      {state === 'pending' ? (
        <>
          {choices.length ? (
            <div className="ask-card-choices" role="group" aria-label={ASK_TEXT.choices}>
              {choices.map((c) => (
                <Button key={c} disabled={busy} onClick={() => void send({ choice: c })}>
                  {c}
                </Button>
              ))}
            </div>
          ) : null}
          {freeText ? (
            <form
              className="ask-card-choices"
              onSubmit={(e) => {
                e.preventDefault();
                if (text.trim()) void send({ text: text.trim() });
              }}
            >
              <label className="nv-vh" htmlFor={`${id}-a`}>
                {ASK_TEXT.yourAnswer}
              </label>
              {multiline ? (
                <textarea
                  id={`${id}-a`}
                  className="nv-input ws-textarea"
                  rows={3}
                  maxLength={8000}
                  value={text}
                  placeholder={choices.length ? ASK_TEXT.orType : ASK_TEXT.type}
                  onChange={(e) => setText(e.target.value)}
                />
              ) : (
                <input
                  id={`${id}-a`}
                  className="nv-input"
                  maxLength={8000}
                  value={text}
                  placeholder={choices.length ? ASK_TEXT.orType : ASK_TEXT.type}
                  onChange={(e) => setText(e.target.value)}
                />
              )}
              <Button type="submit" variant="primary" disabled={busy || !text.trim()}>
                {busy ? <Spinner /> : null} {ASK_TEXT.send}
              </Button>
            </form>
          ) : null}
        </>
      ) : null}
      {state === 'answered' ? (
        <p className="ask-card-answer">
          <Icon name="check" />
          <span>
            {ASK_TEXT.answered} <strong dir="auto">{answered ?? fromCall}</strong>
          </span>
        </p>
      ) : null}
      {state === 'expired' ? (
        <p className="muted">
          <Icon name="clock" /> {ASK_TEXT.expired}
        </p>
      ) : null}
      {state === 'waiting' ? (
        <p className="muted">{isTerminal(call.status) ? ASK_TEXT.noAnswer : ASK_TEXT.waiting}</p>
      ) : null}
      {error ? (
        <p role="alert" className="nv-field-error">
          {error}
        </p>
      ) : null}
    </div>
  );
}
