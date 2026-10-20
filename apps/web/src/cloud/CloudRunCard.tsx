// A cloud run (a Code session's or Work run's lease on a cloud environment; FR-108, FR-116): its
// CPU and running time against their caps, live from `cloud.run.usage`, with a warning past the
// warning share and a plain stop at a cap. A capped run waits: Raise caps gives it room again
// (the Hub refuses caps on an ended run). Cancel asks first. A file of the run's folder can be kept
// in its thread as an artifact. Used on the run page, a Code session and a Work run.
import { useCallback, useId, useRef, useState } from 'react';
import { defineMessages } from '@nova/i18n';
import type { CloudRunView } from '@nova/shared';
import { Button, Dialog, Icon, Spinner, TextField, useToast } from '@nova/ui';
import { useAnnounce } from '../services.tsx';
import { useSettings } from '../settings.tsx';
import { useCloudApi } from './api.ts';
import {
  RUN_EVENTS,
  eventCloudRunId,
  eventThread,
  useCloudEvents,
  usageFromEvent,
} from './events.ts';
import {
  CAP_TEXT,
  CLOUD_TEXT,
  RUN_KIND,
  capResource,
  cloudErrorMessage,
  formatSeconds,
  isLiveRun,
  runReasonText,
  runStatusSpec,
  usageLines,
} from './format.ts';
import { ConfirmAction, StateBadge, UsageMeter, useLoad, type Loaded } from './parts.tsx';

/** A cloud run's card and its dialogs. */
export const RUN_CARD_TEXT = defineMessages('cloud.run', {
  title: 'Cloud run',
  /** {environment} is the environment's name. */
  titleOn: 'Cloud run on {environment}',
  capped:
    '{resource, select, cpu {Stopped at its CPU time cap.} wall {Stopped at its running time cap.} disk {Stopped at its disk cap.} other {Stopped at a cap.}} Its work is kept; nothing more runs until you raise the caps.',
  /** {which} is cpu, wall or both. */
  near: '{which, select, cpu {Near its CPU time cap.} wall {Near its running time cap.} other {Near its CPU time and running time caps.}} It stops there; raise the caps to give it more.',
  announceNear:
    '{resource, select, cpu {The cloud run is near its CPU time cap.} wall {The cloud run is near its running time cap.} disk {The cloud run is near its disk cap.} other {The cloud run is near a cap.}}',
  announceCapped:
    '{resource, select, cpu {The cloud run stopped at its CPU time cap.} wall {The cloud run stopped at its running time cap.} disk {The cloud run stopped at its disk cap.} other {The cloud run stopped at a cap.}}',
  commands: '{n, plural, one {# command} other {# commands}}',
  raise: 'Raise caps…',
  keep: 'Keep a file…',
  cancel: 'Cancel run…',
  raised: 'Caps raised.',
  raisedContinue: 'Caps raised. The cloud run can continue.',
  /** {title} is the file's or artifact's name. */
  kept: 'Kept {title} in the thread’s artifacts.',
  cancelTitle: 'Cancel this cloud run?',
  cancelBody:
    'Commands still running on the runner are stopped. The environment and its files stay; a new run starts with the next command.',
  cancelConfirm: 'Cancel run',
  cancelFailed: 'Could not cancel the run.',
  cancelled: 'Cloud run cancelled.',
  raiseTitle: 'Raise the caps of this run',
  /** {cpu} and {wall} are durations, such as "10 min". */
  raiseBody:
    'It has used {cpu} of CPU time and {wall} of running time. It stops again at the new caps.',
  raiseFailed: 'Could not change the caps.',
  raiseSubmit: 'Raise caps',
  keepTitle: 'Keep a file from the runner',
  keepBody: 'A copy goes into the thread’s artifacts, where you can open or download it.',
  file: 'File on the runner',
  pathRequired: 'Enter the file’s full path on the runner.',
  pathOutside: 'Files on the runner are under /workspace.',
  keepFailed: 'Could not keep that file.',
  keepSubmit: 'Keep file',
});

/** One run by id, kept current from the run events. */
export function useCloudRun(id: string): Loaded<CloudRunView> {
  const api = useCloudApi();
  const run = useLoad(() => api.getCloudRun(id), id);
  useLiveRun(run, (env) => eventCloudRunId(env) === id);
  return run;
}

/** The newest run of a thread (a Code session or Work run), kept current; null before the first. */
export function useThreadCloudRun(threadId: string): Loaded<CloudRunView | null> {
  const api = useCloudApi();
  const run = useLoad(
    () => api.listCloudRuns({ threadId }).then((r) => newest(r.items)),
    `thread:${threadId}`,
  );
  const current = run.data?.id ?? null;
  useLiveRun(
    run,
    (env) =>
      (current !== null && eventCloudRunId(env) === current) ||
      (env.name === 'cloud.run.started' && eventThread(env) === threadId),
  );
  return run;
}

function newest(items: CloudRunView[]): CloudRunView | null {
  let best: CloudRunView | null = null;
  for (const r of items) if (!best || r.createdAt > best.createdAt) best = r;
  return best;
}

/** Usage events update the card at once; any other event about the run refetches it. */
function useLiveRun<T extends CloudRunView | null>(
  run: Loaded<T>,
  mine: (env: Parameters<Parameters<typeof useCloudEvents>[1]>[0]) => boolean,
) {
  const announce = useAnnounce();
  const { reload, setData } = run;
  useCloudEvents(
    RUN_EVENTS,
    (env) => {
      if (!mine(env)) return;
      if (env.name === 'cloud.run.usage') {
        const u = usageFromEvent(env);
        if (u)
          setData((prev) => (prev ? { ...prev, usage: u.usage, caps: u.caps ?? prev.caps } : prev));
        return;
      }
      const resource = capResource(
        typeof env.payload.resource === 'string' ? env.payload.resource : null,
      );
      if (env.name === 'cloud.run.cap_warning') announce(RUN_CARD_TEXT.announceNear({ resource }));
      if (env.name === 'cloud.run.capped') announce(RUN_CARD_TEXT.announceCapped({ resource }));
      reload();
    },
    reload,
  );
}

export function CloudRunCard({
  run,
  onChange,
  environmentLabel,
  headingLevel = 3,
}: {
  run: CloudRunView;
  onChange: (run: CloudRunView) => void;
  environmentLabel?: string | null;
  headingLevel?: 2 | 3;
}) {
  const api = useCloudApi();
  const toast = useToast();
  const announce = useAnnounce();
  const settings = useSettings();
  const headingId = useId();
  const warnAt = settings.get('cloud.runner.caps').value.warnAt;
  const [raising, setRaising] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [keeping, setKeeping] = useState(false);
  const lines = usageLines(run, warnAt);
  const live = isLiveRun(run);
  const reason = runReasonText(run);
  const warned = lines.filter((l) => l.warn);
  const H = headingLevel === 2 ? 'h2' : 'h3';
  const S = RUN_CARD_TEXT;
  const nearWhich = warned.length === 1 && warned[0] ? warned[0].resource : ('both' as const);

  return (
    <section
      className="cl-run"
      aria-labelledby={headingId}
      data-state={run.status === 'capped' ? 'capped' : warned.length ? 'warn' : undefined}
    >
      <div className="cl-run-head">
        <H id={headingId} className="cl-run-title">
          {environmentLabel ? S.titleOn({ environment: environmentLabel }) : S.title}
        </H>
        <StateBadge spec={runStatusSpec(run.status)} />
        <span className="muted cl-small">{RUN_KIND[run.kind]}</span>
      </div>
      {run.status === 'capped' ? (
        <p className="cl-notice" data-tone="danger" role="alert">
          <Icon name="stop" />
          <span>{S.capped({ resource: capResource(run.reason) })}</span>
        </p>
      ) : warned.length && live ? (
        <p className="cl-notice" data-tone="warn" role="status">
          <Icon name="alert" />
          <span>{S.near({ which: nearWhich })}</span>
        </p>
      ) : reason ? (
        <p className="muted cl-small">{reason}</p>
      ) : null}
      <div className="cl-meters">
        {lines.map((l) => (
          <UsageMeter key={l.resource} line={l} />
        ))}
        <span className="muted cl-small">{S.commands({ n: run.usage.commands })}</span>
      </div>
      <div className="cl-actions">
        {live ? (
          <Button
            variant={run.status === 'capped' ? 'primary' : 'default'}
            onClick={() => setRaising(true)}
          >
            <Icon name="plus" /> {S.raise}
          </Button>
        ) : null}
        {run.threadId ? (
          <Button onClick={() => setKeeping(true)}>
            <Icon name="artifact" /> {S.keep}
          </Button>
        ) : null}
        {live ? (
          <Button variant="danger" onClick={() => setCancelling(true)}>
            <Icon name="stop" /> {S.cancel}
          </Button>
        ) : null}
      </div>
      <RaiseCapsDialog
        open={raising}
        run={run}
        onClose={() => setRaising(false)}
        onSaved={(next) => {
          setRaising(false);
          onChange(next);
          announce(next.status === 'active' ? S.raisedContinue : S.raised);
        }}
      />
      <KeepFileDialog
        open={keeping}
        run={run}
        onClose={() => setKeeping(false)}
        onKept={(title) => {
          setKeeping(false);
          toast.show(S.kept({ title }), { tone: 'success' });
        }}
      />
      <ConfirmAction
        open={cancelling}
        title={S.cancelTitle}
        description={S.cancelBody}
        confirmLabel={S.cancelConfirm}
        danger
        errorText={(err) => cloudErrorMessage(err, S.cancelFailed)}
        onClose={() => setCancelling(false)}
        onConfirm={async () => {
          const next = await api.cancelCloudRun(run.id);
          setCancelling(false);
          onChange(next);
          announce(S.cancelled);
        }}
      />
    </section>
  );
}

/** Minutes typed into a cap field, or the problem with them; `what` names the resource. */
export function parseCapMinutes(
  text: string,
  usedSeconds: number,
  what: string,
): { seconds: number } | { error: string } {
  const t = text.trim();
  const m = Number(t);
  if (!/^\d+$/.test(t) || m < 1 || m > 7 * 24 * 60)
    return { error: CAP_TEXT.wholeMinutes({ what, min: 1, max: 7 * 24 * 60 }) };
  const seconds = m * 60;
  if (seconds <= usedSeconds)
    return { error: CAP_TEXT.aboveUsed({ used: formatSeconds(usedSeconds), what }) };
  return { seconds };
}

function RaiseCapsDialog({
  open,
  run,
  onClose,
  onSaved,
}: {
  open: boolean;
  run: CloudRunView;
  onClose: () => void;
  onSaved: (run: CloudRunView) => void;
}) {
  if (!open) return null;
  return <RaiseCapsForm run={run} onClose={onClose} onSaved={onSaved} />;
}

function RaiseCapsForm({
  run,
  onClose,
  onSaved,
}: {
  run: CloudRunView;
  onClose: () => void;
  onSaved: (run: CloudRunView) => void;
}) {
  const api = useCloudApi();
  const formId = `caps${useId()}`;
  const first = useRef<HTMLInputElement>(null);
  const [cpu, setCpu] = useState(String(Math.ceil((run.caps.cpuSeconds * 2) / 60)));
  const [wall, setWall] = useState(String(Math.ceil((run.caps.wallSeconds * 2) / 60)));
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cpuR = parseCapMinutes(cpu, run.usage.cpuSeconds, CAP_TEXT.resource.cpu);
  const wallR = parseCapMinutes(wall, run.usage.wallSeconds, CAP_TEXT.resource.wall);
  const S = RUN_CARD_TEXT;

  const submit = async () => {
    setTried(true);
    if ('error' in cpuR || 'error' in wallR || busy) return;
    setBusy(true);
    setError(null);
    try {
      onSaved(
        await api.setCloudRunCaps(run.id, {
          cpuSeconds: cpuR.seconds,
          wallSeconds: wallR.seconds,
        }),
      );
    } catch (err) {
      setError(cloudErrorMessage(err, S.raiseFailed));
      setBusy(false);
    }
  };

  return (
    <Dialog
      open
      title={S.raiseTitle}
      description={S.raiseBody({
        cpu: formatSeconds(run.usage.cpuSeconds),
        wall: formatSeconds(run.usage.wallSeconds),
      })}
      onClose={onClose}
      initialFocusRef={first}
    >
      <form
        id={formId}
        className="stack"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <div className="cl-field-row">
          <TextField
            ref={first}
            label={CLOUD_TEXT.cpuCapMinutes}
            type="number"
            inputMode="numeric"
            className="ws-number"
            min={1}
            value={cpu}
            error={tried && 'error' in cpuR ? cpuR.error : undefined}
            onChange={(e) => setCpu(e.target.value)}
          />
          <TextField
            label={CLOUD_TEXT.wallCapMinutes}
            type="number"
            inputMode="numeric"
            className="ws-number"
            min={1}
            value={wall}
            error={tried && 'error' in wallR ? wallR.error : undefined}
            onChange={(e) => setWall(e.target.value)}
          />
        </div>
        {error ? (
          <p className="nv-field-error" role="alert">
            {error}
          </p>
        ) : null}
        <div className="nv-dialog-footer">
          <Button onClick={onClose}>{CLOUD_TEXT.cancel}</Button>
          <Button type="submit" variant="primary" disabled={busy}>
            {busy ? <Spinner /> : null} {S.raiseSubmit}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

function KeepFileDialog({
  open,
  run,
  onClose,
  onKept,
}: {
  open: boolean;
  run: CloudRunView;
  onClose: () => void;
  onKept: (title: string) => void;
}) {
  if (!open) return null;
  return <KeepFileForm run={run} onClose={onClose} onKept={onKept} />;
}

function KeepFileForm({
  run,
  onClose,
  onKept,
}: {
  run: CloudRunView;
  onClose: () => void;
  onKept: (title: string) => void;
}) {
  const api = useCloudApi();
  const first = useRef<HTMLInputElement>(null);
  const [path, setPath] = useState('');
  const [title, setTitle] = useState('');
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const S = RUN_CARD_TEXT;
  const p = path.trim();
  const pathError = !p ? S.pathRequired : !p.startsWith('/workspace') ? S.pathOutside : null;

  const submit = useCallback(async () => {
    setTried(true);
    if (pathError || busy) return;
    setBusy(true);
    setError(null);
    try {
      const a = await api.collectCloudArtifact(run.id, {
        path: p,
        ...(title.trim() ? { title: title.trim() } : {}),
      });
      onKept(a.title ?? p.split('/').pop() ?? p);
    } catch (err) {
      setError(cloudErrorMessage(err, S.keepFailed));
      setBusy(false);
    }
  }, [api, busy, onKept, p, pathError, run.id, title, S.keepFailed]);

  return (
    <Dialog
      open
      title={S.keepTitle}
      description={S.keepBody}
      onClose={onClose}
      initialFocusRef={first}
    >
      <form
        className="stack"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <TextField
          ref={first}
          label={S.file}
          value={path}
          autoComplete="off"
          spellCheck={false}
          dir="ltr"
          // eslint-disable-next-line nova-i18n/no-literal-ui-text -- an example path, not text
          placeholder="/workspace/app/report.html"
          error={tried && pathError ? pathError : undefined}
          onChange={(e) => setPath(e.target.value)}
        />
        <TextField
          label={CLOUD_TEXT.titleOptional}
          value={title}
          maxLength={200}
          autoComplete="off"
          onChange={(e) => setTitle(e.target.value)}
        />
        {error ? (
          <p className="nv-field-error" role="alert">
            {error}
          </p>
        ) : null}
        <div className="nv-dialog-footer">
          <Button onClick={onClose}>{CLOUD_TEXT.cancel}</Button>
          <Button type="submit" variant="primary" disabled={busy}>
            {busy ? <Spinner /> : null} {S.keepSubmit}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
