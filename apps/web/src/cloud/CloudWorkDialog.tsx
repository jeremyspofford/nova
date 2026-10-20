// A Work run on a cloud environment (FR-108, FR-071; docs/13 §3): the run's commands and files are
// on the runner, so it keeps going while your devices are off; the agent, the models and the
// approvals stay on this Hub. Describe the outcome, pick the environment (only ready ones), the
// autonomy, optional caps for this run, and whether to snapshot the environment first so a failed
// run can be undone. Starting opens the run.
import { useId, useState } from 'react';
import { defineMessages } from '@nova/i18n';
import type { CloudEnvironmentView, CloudWorkView, RunAutonomy } from '@nova/shared';
import { Button, Dialog, RadioGroup, SelectField, Spinner, TextField } from '@nova/ui';
import { useSettings } from '../settings.tsx';
import { AUTONOMY_TEXT } from '../work/format.ts';
import { useCloudApi, type StartCloudWorkBody } from './api.ts';
import { TextArea } from './CloudEnvironmentDialog.tsx';
import { parseCapMinutes } from './CloudRunCard.tsx';
import { CAP_TEXT, CLOUD_TEXT, cloudErrorMessage, environmentState } from './format.ts';

const OBJECTIVE_MAX = 8000;

/** A Work run on a cloud environment. {name} is an environment's name. */
export const CLOUD_WORK_TEXT = defineMessages('cloud.work', {
  chooseEnvironment: 'Choose a cloud environment.',
  /** {state} is the environment's state, such as "Setting up". */
  notReady: '{name} is not ready: {state}.',
  describe: 'Describe what the run should get done.',
  /** {max} is a number of characters. */
  tooLong: 'Keep it under {max} characters.',
  startFailed: 'Could not start the run.',
  title: 'New Work run in the cloud',
  description:
    'Its commands run on the cloud runner and keep going while your devices are off. Approvals still come to you.',
  environment: 'Cloud environment',
  choose: 'Choose an environment',
  /** An environment that is not ready, in the list: "App env (Setting up)". */
  optionNotReady: '{name} ({state})',
  objective: 'What should the run get done?',
  autonomy: 'Autonomy',
  caps: 'Caps for this run (optional)',
  capsHint:
    'Without them, the caps from Settings → Cloud runner apply. The run stops at a cap and waits for you to raise it.',
  snapshot: 'Take a snapshot first',
  snapshotHint: 'You can restore it if the run leaves the environment in a bad state.',
  start: 'Start run',
});

export function CloudWorkDialog({
  open,
  environments,
  environmentId,
  onClose,
  onStarted,
}: {
  open: boolean;
  environments: CloudEnvironmentView[];
  /** Preselected environment. */
  environmentId?: string | null;
  onClose: () => void;
  onStarted: (view: CloudWorkView) => void;
}) {
  if (!open) return null;
  return (
    <CloudWorkForm
      environments={environments}
      environmentId={environmentId ?? null}
      onClose={onClose}
      onStarted={onStarted}
    />
  );
}

function CloudWorkForm({
  environments,
  environmentId,
  onClose,
  onStarted,
}: {
  environments: CloudEnvironmentView[];
  environmentId: string | null;
  onClose: () => void;
  onStarted: (view: CloudWorkView) => void;
}) {
  const api = useCloudApi();
  const settings = useSettings();
  const id = `cw${useId()}`;
  const ready = (e: CloudEnvironmentView) => e.runner?.status === 'ready';
  const [envId, setEnvId] = useState(
    environmentId ?? environments.find(ready)?.id ?? environments[0]?.id ?? '',
  );
  const [objective, setObjective] = useState('');
  const [title, setTitle] = useState('');
  const [autonomy, setAutonomy] = useState<RunAutonomy>(settings.get('runs.autonomy').value);
  const [cpu, setCpu] = useState('');
  const [wall, setWall] = useState('');
  const [snapshot, setSnapshot] = useState(true);
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const env = environments.find((e) => e.id === envId) ?? null;

  const S = CLOUD_WORK_TEXT;
  const errors: Record<string, string> = {};
  if (!env) errors.env = S.chooseEnvironment;
  else if (!ready(env))
    errors.env = S.notReady({ name: env.label, state: environmentState(env).text });
  if (!objective.trim()) errors.objective = S.describe;
  else if (objective.length > OBJECTIVE_MAX) errors.objective = S.tooLong({ max: OBJECTIVE_MAX });
  const cpuR = cpu.trim() ? parseCapMinutes(cpu, 0, CAP_TEXT.resource.cpu) : null;
  const wallR = wall.trim() ? parseCapMinutes(wall, 0, CAP_TEXT.resource.wall) : null;
  if (cpuR && 'error' in cpuR) errors.cpu = cpuR.error;
  if (wallR && 'error' in wallR) errors.wall = wallR.error;
  const shown = tried ? errors : {};

  const submit = async () => {
    setTried(true);
    if (Object.keys(errors).length || busy) return;
    setBusy(true);
    setError(null);
    const caps = {
      ...(cpuR && 'seconds' in cpuR ? { cpuSeconds: cpuR.seconds } : {}),
      ...(wallR && 'seconds' in wallR ? { wallSeconds: wallR.seconds } : {}),
    };
    const body: StartCloudWorkBody = {
      environmentId: envId,
      objective: objective.trim(),
      autonomy,
      snapshot,
      ...(title.trim() ? { title: title.trim() } : {}),
      ...(Object.keys(caps).length ? { caps } : {}),
    };
    try {
      onStarted(await api.startCloudWork(body));
    } catch (err) {
      setError(cloudErrorMessage(err, S.startFailed));
      setBusy(false);
    }
  };

  return (
    <Dialog
      open
      title={S.title}
      description={S.description}
      onClose={onClose}
      className="ws-wide-dialog"
    >
      <form
        id={id}
        className="stack cl-form"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <SelectField
          label={S.environment}
          value={envId}
          onChange={setEnvId}
          options={[
            ...(env ? [] : [{ value: '', label: S.choose }]),
            ...environments.map((e) => ({
              value: e.id,
              label: ready(e)
                ? e.label
                : S.optionNotReady({ name: e.label, state: environmentState(e).text }),
              disabled: !ready(e),
            })),
          ]}
          error={shown.env}
        />
        <TextArea
          id={`${id}-objective`}
          label={S.objective}
          value={objective}
          rows={4}
          error={shown.objective}
          onChange={setObjective}
        />
        <TextField
          label={CLOUD_TEXT.titleOptional}
          value={title}
          maxLength={200}
          autoComplete="off"
          onChange={(e) => setTitle(e.target.value)}
        />
        <RadioGroup
          legend={S.autonomy}
          name={`${id}-autonomy`}
          value={autonomy}
          onChange={(v) => setAutonomy(v as RunAutonomy)}
          options={(['ask_first', 'standard', 'autonomous'] as const).map((a) => ({
            value: a,
            label: AUTONOMY_TEXT[a].label,
            description: AUTONOMY_TEXT[a].description,
          }))}
        />
        <details className="ws-advanced">
          <summary>{S.caps}</summary>
          <p className="nv-field-hint">{S.capsHint}</p>
          <div className="cl-field-row">
            <TextField
              label={CLOUD_TEXT.cpuCapMinutes}
              type="number"
              inputMode="numeric"
              className="ws-number"
              min={1}
              value={cpu}
              error={shown.cpu}
              onChange={(e) => setCpu(e.target.value)}
            />
            <TextField
              label={CLOUD_TEXT.wallCapMinutes}
              type="number"
              inputMode="numeric"
              className="ws-number"
              min={1}
              value={wall}
              error={shown.wall}
              onChange={(e) => setWall(e.target.value)}
            />
          </div>
        </details>
        <label className="cl-check">
          <input
            type="checkbox"
            checked={snapshot}
            aria-describedby={`${id}-snap`}
            onChange={(e) => setSnapshot(e.target.checked)}
          />
          {S.snapshot}
        </label>
        <span id={`${id}-snap`} className="nv-field-hint">
          {S.snapshotHint}
        </span>
        {error ? (
          <p className="nv-field-error" role="alert">
            {error}
          </p>
        ) : null}
        <div className="nv-dialog-footer">
          <Button onClick={onClose}>{CLOUD_TEXT.cancel}</Button>
          <Button type="submit" variant="primary" disabled={busy}>
            {busy ? <Spinner /> : null} {S.start}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
