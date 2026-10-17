// The Terminal pane of a Code session (FR-066, FR-184; docs/10 §6): shells bound to the session
// (its environment and folder) through the app's terminal sessions, and the commands the agent
// left running (`exec.run` sessions) with an "agent" chip, their tool call and a Kill action.
// Terminal output is untrusted data (FR-189) and is only ever drawn as text.
import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import type { CodeSessionView, TerminalView } from '@nova/shared';
import { Button, Icon, IconButton, Spinner, rovingIndex, useToast } from '@nova/ui';
import { ApiError, errorMessage } from '../api.ts';
import { useAnnounce, useServices } from '../services.tsx';
import { formatWhen } from '../settings/common.ts';
import { SANDBOX_UNAVAILABLE } from '../terminal/session.ts';
import { useTerminalHub, useTerminals } from '../terminal/TerminalPanel.tsx';
import { useCoalesced, useThreadBusEvents } from './events.ts';
import { useCodeExtras, type ExecSessionView } from './extras.ts';

export function TerminalPane({
  session,
  visible,
}: {
  session: Pick<CodeSessionView, 'id' | 'threadId'>;
  visible: boolean;
}) {
  return (
    <section className="code-terminal" aria-label="Terminal">
      <SessionTerminals session={session} visible={visible} />
      <ExecSessions threadId={session.threadId} visible={visible} />
    </section>
  );
}

function SessionTerminals({
  session,
  visible,
}: {
  session: Pick<CodeSessionView, 'id' | 'threadId'>;
  visible: boolean;
}) {
  const hub = useTerminalHub();
  const snap = useTerminals();
  const extras = useCodeExtras();
  const toast = useToast();
  const announce = useAnnounce();
  const base = useId();
  const tabs = useRef<HTMLDivElement>(null);
  const { api } = useServices();
  const [listed, setListed] = useState<TerminalView[]>([]);
  const [created, setCreated] = useState<TerminalView[]>([]);
  const [closed, setClosed] = useState<Set<string>>(() => new Set());
  const [picked, setPicked] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [unavailable, setUnavailable] = useState<string | null>(null);

  // The Hub's list is the truth after a reload: the session's shells carry its thread.
  useEffect(() => {
    if (!visible) return;
    let alive = true;
    api.listTerminals().then(
      ({ items }) => alive && setListed(items.filter((t) => t.threadId === session.threadId)),
      () => undefined,
    );
    return () => {
      alive = false;
    };
  }, [api, session.threadId, visible]);

  // This session's shells: those the Hub lists for its thread, and those started here.
  const items = [...listed, ...created.filter((c) => !listed.some((t) => t.id === c.id))].filter(
    (t) => !closed.has(t.id),
  );
  const selected = items.some((t) => t.id === picked) ? picked : (items.at(-1)?.id ?? null);
  const label = (id: string) => `Terminal ${items.findIndex((t) => t.id === id) + 1}`;

  const start = async () => {
    setStarting(true);
    try {
      const view = await extras.createSessionTerminal(session.id);
      setCreated((list) => [...list, view]);
      setPicked(view.id);
      setUnavailable(null);
      announce('Terminal started in the session folder.');
      // Focus once its screen exists.
      setTimeout(() => hub.session(view.id).focus(), 0);
    } catch (err) {
      if (err instanceof ApiError && err.body.code === 'sandbox_unavailable')
        setUnavailable(SANDBOX_UNAVAILABLE);
      else toast.show(`Could not start a terminal: ${errorMessage(err)}`, { tone: 'error' });
    } finally {
      setStarting(false);
    }
  };

  const close = (id: string) => {
    const name = label(id);
    hub.close(id).then(
      () => {
        setClosed((s) => new Set([...s, id]));
        announce(`${name} closed.`);
      },
      (err: unknown) =>
        toast.show(`Could not close ${name}: ${errorMessage(err)}`, { tone: 'error' }),
    );
  };

  const onTabKey = (e: KeyboardEvent) => {
    const i = items.findIndex((t) => t.id === selected);
    const next = rovingIndex(e.key, Math.max(0, i), items.length, 'horizontal');
    if (next === null) return;
    e.preventDefault();
    const t = items[next];
    if (!t) return;
    setPicked(t.id);
    tabs.current?.querySelectorAll<HTMLElement>('[role="tab"]')[next]?.focus();
  };

  return (
    <div className="code-terminals">
      <div className="terminal-bar">
        {items.length ? (
          <div
            ref={tabs}
            role="tablist"
            aria-label="Session terminals"
            className="terminal-tabs"
            onKeyDown={onTabKey}
          >
            {items.map((t) => {
              const on = t.id === selected;
              const exited = snap.sessions[t.id]?.state === 'exited' || t.status === 'exited';
              const name = label(t.id);
              return (
                <span key={t.id} className="terminal-tab" data-selected={on || undefined}>
                  <button
                    type="button"
                    role="tab"
                    id={`${base}-tab-${t.id}`}
                    aria-selected={on}
                    aria-controls={`${base}-panel`}
                    aria-label={exited ? `${name} (exited)` : name}
                    tabIndex={on ? 0 : -1}
                    className="terminal-tab-button"
                    onClick={() => setPicked(t.id)}
                  >
                    <Icon name="terminal" /> {name}
                  </button>
                  <IconButton
                    label={`Close ${name}`}
                    icon={<Icon name="close" />}
                    variant="ghost"
                    onClick={() => close(t.id)}
                  />
                </span>
              );
            })}
          </div>
        ) : (
          <span className="muted terminal-none">Session terminal</span>
        )}
        <span className="terminal-bar-spacer" />
        {selected ? (
          <Button variant="ghost" onClick={() => hub.session(selected).clear()}>
            Clear
          </Button>
        ) : null}
        <IconButton
          label="New terminal in this session"
          icon={<Icon name="plus" />}
          variant="ghost"
          disabled={starting || !!unavailable}
          onClick={() => void start()}
        />
      </div>
      {unavailable ? (
        <p className="terminal-note" role="note">
          <Icon name="alert" /> {unavailable}
        </p>
      ) : null}
      {selected ? (
        <div
          id={`${base}-panel`}
          role="tabpanel"
          aria-labelledby={`${base}-tab-${selected}`}
          className="terminal-body"
        >
          <Screen key={selected} id={selected} visible={visible} name={label(selected)} />
        </div>
      ) : unavailable ? null : (
        <div className="terminal-empty">
          <p className="muted">No terminal is open in this session.</p>
          <Button onClick={() => void start()} disabled={starting}>
            {starting ? <Spinner /> : <Icon name="terminal" />} Start a terminal
          </Button>
        </div>
      )}
    </div>
  );
}

/** Draws one terminal's screen here while visible; another view showing it gives it up. */
function Screen({ id, visible, name }: { id: string; visible: boolean; name: string }) {
  const hub = useTerminalHub();
  const snap = useTerminals();
  const box = useRef<HTMLDivElement>(null);
  const owner = `code:${id}`;
  useEffect(() => {
    const el = box.current;
    if (!visible || !el) return;
    const s = hub.session(id);
    s.attach(el, owner);
    let observer: ResizeObserver | null = null;
    if (typeof ResizeObserver !== 'undefined') {
      observer = new ResizeObserver(() => s.fit());
      observer.observe(el);
    }
    return () => {
      observer?.disconnect();
      s.release(owner);
    };
  }, [hub, id, owner, visible]);
  const state = snap.sessions[id];
  return (
    <div className="terminal-screen-wrap">
      <div
        ref={box}
        className="terminal-screen"
        role="group"
        aria-label={name}
        onClick={() => hub.session(id).focus()}
      />
      <p className="terminal-status muted" role="status">
        {!state || state.state === 'starting' || state.state === 'connecting' ? (
          <>
            <Spinner label="Connecting" /> Connecting…
          </>
        ) : state.state === 'disconnected' ? (
          <>
            {state.error ?? 'Disconnected from the terminal.'}{' '}
            <button type="button" className="link" onClick={() => hub.session(id).connect()}>
              Reconnect
            </button>
          </>
        ) : state.state === 'exited' ? (
          `The shell exited${state.exitCode === null ? '' : ` with code ${state.exitCode}`}.`
        ) : null}
      </p>
    </div>
  );
}

/** Commands the agent left running in this session (FR-184), newest first. */
function ExecSessions({ threadId, visible }: { threadId: string; visible: boolean }) {
  const extras = useCodeExtras();
  const toast = useToast();
  const announce = useAnnounce();
  const headingId = useId();
  const [items, setItems] = useState<ExecSessionView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [killing, setKilling] = useState<string | null>(null);

  const load = useCallback(
    () =>
      extras.listExecSessions(threadId).then(
        ({ items: list }) => {
          setItems([...list].sort((a, b) => b.startedAt.localeCompare(a.startedAt)));
          setError(null);
        },
        (err: unknown) =>
          setError(
            err instanceof ApiError && err.status === 404
              ? 'This Hub does not list agent commands yet.'
              : errorMessage(err, 'Could not load the agent’s commands.'),
          ),
      ),
    [extras, threadId],
  );
  const reload = useCoalesced(load);
  useEffect(() => {
    if (visible) reload();
  }, [reload, visible]);
  // A command the agent starts or finishes changes the list.
  useThreadBusEvents(visible ? threadId : null, (env) => {
    if (
      env.name === 'tool.call.started' ||
      env.name === 'tool.call.completed' ||
      env.name === 'turn.completed' ||
      env.name === 'turn.interrupted'
    )
      reload();
  });

  const kill = async (s: ExecSessionView) => {
    setKilling(s.id);
    try {
      await extras.killExecSession(s.id);
      announce(`Stopped ${s.cmd}.`);
      reload();
    } catch (err) {
      toast.show(`Could not stop the command: ${errorMessage(err)}`, { tone: 'error' });
    } finally {
      setKilling(null);
    }
  };

  return (
    <section className="code-exec" aria-labelledby={headingId}>
      <div className="code-exec-head">
        <h3 id={headingId}>Agent commands</h3>
        <Button variant="ghost" onClick={reload}>
          <Icon name="refresh" /> Refresh
        </Button>
      </div>
      {error ? (
        <p className="muted" role="note">
          {error}
        </p>
      ) : null}
      {items === null && !error ? <Spinner label="Loading agent commands" /> : null}
      {items?.length === 0 ? (
        <p className="muted">The agent has no commands running in this session.</p>
      ) : null}
      {items?.length ? (
        <ul className="code-exec-list" aria-label="Agent commands">
          {items.map((s) => (
            <li key={s.id} className="code-exec-row" aria-label={s.cmd}>
              <span className="code-agent-chip">agent</span>
              {s.callId ? (
                <code className="muted code-call" title="Tool call">
                  {s.callId}
                </code>
              ) : null}
              <code className="code-exec-cmd" title={s.cwd}>
                {s.cmd}
              </code>
              <span className="muted">Running since {formatWhen(s.startedAt)}</span>
              <Button
                variant="danger"
                disabled={killing !== null}
                aria-label={`Kill ${s.cmd}`}
                onClick={() => void kill(s)}
              >
                {killing === s.id ? <Spinner /> : <Icon name="stop" />} Kill
              </Button>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
