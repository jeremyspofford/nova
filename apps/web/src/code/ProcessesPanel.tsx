// Processes an environment's helper runs for Code sessions (FR-078, docs/10 §2, §14): the
// helper keeps their output buffered while the app is away, so a session on an SSH host, a WSL
// distro or a device keeps running while you are disconnected. Opening a process reads its
// buffered output from the start of what the helper kept ("reattach"); later reads continue from
// where the last one stopped. Output is untrusted (FR-189) and only ever drawn as text.
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import type { EnvironmentProcessView } from '@nova/shared';
import { defineMessages } from '@nova/i18n';
import { Button, EmptyState, Icon, Spinner } from '@nova/ui';
import { errorMessage } from '../api.ts';
import { formatWhen, useInterval } from '../settings/common.ts';
import { useCodeM6Api } from './api-m6.ts';
import { sessionPath } from './labels.ts';
import { AppLink } from './CodeNav.tsx';
import { Badge, ErrorBanner } from './parts.tsx';

export const PROCESSES_TEXT = defineMessages('code.processes', {
  loadFailed: 'Could not load the processes.',
  refresh: 'Refresh',
  loading: 'Loading the processes',
  emptyTitle: 'No processes',
  emptyBody: 'Commands a session runs here show up with their output, even after you reconnect.',
  readFailed: 'Could not read the output.',
  running: 'Running',
  ended: 'Ended',
  exited: 'Exited with {code}',
  started: 'Started {when}',
  outputSize: '{n, plural, one {# byte of output} other {# bytes of output}}',
  openSession: 'Open its session',
  hideOutput: 'Hide output',
  showOutput: 'Show output',
  readNew: 'Read new output',
  dropped:
    '{n, plural, one {The helper kept only the newest output; # byte before this point was dropped.} other {The helper kept only the newest output; # bytes before this point were dropped.}}',
  reading: 'Reading the output',
  outputOf: 'Output of {command}',
  noOutput: 'No output yet.',
});

/** How often open output of a running process is read again. */
export const OUTPUT_POLL_MS = 2000;
/** Output kept on screen per process (the newest characters). */
const MAX_SHOWN = 200_000;

export function ProcessesPanel({
  environmentId,
  sessionId,
  title,
  visible = true,
}: {
  environmentId: string;
  /** Only this session's processes. */
  sessionId?: string;
  title: string;
  visible?: boolean;
}) {
  const m6 = useCodeM6Api();
  const headingId = useId();
  const [items, setItems] = useState<EnvironmentProcessView[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    () =>
      m6.listEnvironmentProcesses(environmentId).then(
        ({ items: list }) => {
          setItems(sessionId ? list.filter((p) => p.sessionId === sessionId) : list);
          setError(null);
        },
        (err: unknown) => setError(errorMessage(err, PROCESSES_TEXT.loadFailed)),
      ),
    [environmentId, m6, sessionId],
  );
  useEffect(() => {
    if (visible) void load();
  }, [load, visible]);

  return (
    <section className="code-processes" aria-labelledby={headingId}>
      <div className="code-subhead">
        <h3 id={headingId}>{title}</h3>
        <Button onClick={() => void load()}>
          <Icon name="refresh" /> {PROCESSES_TEXT.refresh}
        </Button>
      </div>
      {error ? <ErrorBanner message={error} onRetry={() => void load()} /> : null}
      {items === null && !error ? <Spinner label={PROCESSES_TEXT.loading} /> : null}
      {items?.length === 0 ? (
        <EmptyState
          level={3}
          title={PROCESSES_TEXT.emptyTitle}
          description={PROCESSES_TEXT.emptyBody}
        />
      ) : null}
      {items?.length ? (
        <ul className="code-proc-list" aria-label={title}>
          {items.map((p) => (
            <ProcessRow
              key={p.id}
              environmentId={environmentId}
              proc={p}
              showSession={!sessionId}
              visible={visible}
            />
          ))}
        </ul>
      ) : null}
    </section>
  );
}

function ProcessRow({
  environmentId,
  proc,
  showSession,
  visible,
}: {
  environmentId: string;
  proc: EnvironmentProcessView;
  showSession: boolean;
  visible: boolean;
}) {
  const m6 = useCodeM6Api();
  const outId = useId();
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const [offset, setOffset] = useState<number | null>(null);
  const [dropped, setDropped] = useState(0);
  const [running, setRunning] = useState(proc.running);
  const [exitCode, setExitCode] = useState(proc.exitCode);
  const [error, setError] = useState<string | null>(null);
  const [reading, setReading] = useState(false);
  const busy = useRef(false);

  const read = useCallback(
    async (from: number) => {
      if (busy.current) return;
      busy.current = true;
      setReading(true);
      try {
        const out = await m6.readEnvironmentOutput(environmentId, proc.id, from);
        setText((t) => {
          const next = from === 0 ? out.data : t + out.data;
          return next.length > MAX_SHOWN ? next.slice(-MAX_SHOWN) : next;
        });
        if (from === 0) setDropped(out.dropped);
        setOffset(out.offset);
        setRunning(out.running);
        setExitCode(out.exitCode);
        setError(null);
      } catch (err) {
        setError(errorMessage(err, PROCESSES_TEXT.readFailed));
      } finally {
        busy.current = false;
        setReading(false);
      }
    },
    [environmentId, m6, proc.id],
  );

  useInterval(
    () => {
      if (offset !== null) void read(offset);
    },
    OUTPUT_POLL_MS,
    visible && open && running && offset !== null,
  );

  const state = running
    ? PROCESSES_TEXT.running
    : exitCode === null
      ? PROCESSES_TEXT.ended
      : PROCESSES_TEXT.exited({ code: String(exitCode) });

  return (
    <li className="code-proc" aria-label={proc.cmd}>
      <div className="code-proc-head">
        <code className="code-proc-cmd">{proc.cmd}</code>
        <Badge
          tone={running ? 'warn' : exitCode === 0 ? 'ok' : 'danger'}
          icon={running ? 'refresh' : exitCode === 0 ? 'check' : 'stop'}
        >
          {state}
        </Badge>
      </div>
      <span className="muted code-row-meta">
        <span className="code-path" dir="ltr">
          {proc.cwd}
        </span>
        <span>{PROCESSES_TEXT.started({ when: formatWhen(proc.startedAt) })}</span>
        <span>{PROCESSES_TEXT.outputSize({ n: proc.outputBytes })}</span>
        {showSession && proc.sessionId ? (
          <AppLink to={sessionPath(proc.sessionId)}>{PROCESSES_TEXT.openSession}</AppLink>
        ) : null}
      </span>
      <div className="ws-toolbar">
        <Button
          aria-expanded={open}
          aria-controls={outId}
          onClick={() => {
            const next = !open;
            setOpen(next);
            // Reattach: the first read starts at what the helper still keeps.
            if (next && offset === null) void read(0);
          }}
        >
          <Icon name="terminal" /> {open ? PROCESSES_TEXT.hideOutput : PROCESSES_TEXT.showOutput}
        </Button>
        {open && offset !== null ? (
          <Button disabled={reading} onClick={() => void read(offset)}>
            <Icon name="refresh" /> {PROCESSES_TEXT.readNew}
          </Button>
        ) : null}
      </div>
      <div id={outId} hidden={!open} className="code-proc-out">
        {error ? <ErrorBanner message={error} onRetry={() => void read(offset ?? 0)} /> : null}
        {dropped > 0 ? (
          <p className="ws-warning" role="note">
            <Icon name="alert" /> {PROCESSES_TEXT.dropped({ n: dropped })}
          </p>
        ) : null}
        {offset === null && reading ? <Spinner label={PROCESSES_TEXT.reading} /> : null}
        {offset !== null ? (
          text ? (
            <pre
              role="group"
              className="ws-log"
              aria-label={PROCESSES_TEXT.outputOf({ command: proc.cmd })}
              tabIndex={0}
            >
              {text}
            </pre>
          ) : (
            <p className="muted">{PROCESSES_TEXT.noOutput}</p>
          )
        ) : null}
      </div>
    </li>
  );
}
