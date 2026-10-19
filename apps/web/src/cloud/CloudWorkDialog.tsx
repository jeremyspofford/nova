// A Work run on a cloud environment (FR-108, FR-071; docs/13 §3): the run's commands and files are
// on the runner, so it keeps going while your devices are off; the agent, the models and the
// approvals stay on this Hub. Describe the outcome, pick the environment (only ready ones), the
// autonomy, optional caps for this run, and whether to snapshot the environment first so a failed
// run can be undone. Starting opens the run.
import { useId, useState } from 'react';
import type { CloudEnvironmentView, CloudWorkView, RunAutonomy } from '@nova/shared';
import { Button, Dialog, RadioGroup, SelectField, Spinner, TextField } from '@nova/ui';
import { useSettings } from '../settings.tsx';
import { AUTONOMY_TEXT } from '../work/format.ts';
import { useCloudApi, type StartCloudWorkBody } from './api.ts';
import { TextArea } from './CloudEnvironmentDialog.tsx';
import { parseCapMinutes } from './CloudRunCard.tsx';
import { cloudErrorMessage, environmentState } from './format.ts';

const OBJECTIVE_MAX = 8000;

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

  const errors: Record<string, string> = {};
  if (!env) errors.env = 'Choose a cloud environment.';
  else if (!ready(env)) errors.env = `${env.label} is not ready: ${environmentState(env).text}.`;
  if (!objective.trim()) errors.objective = 'Describe what the run should get done.';
  else if (objective.length > OBJECTIVE_MAX)
    errors.objective = `Keep it under ${OBJECTIVE_MAX.toLocaleString()} characters.`;
  const cpuR = cpu.trim() ? parseCapMinutes(cpu, 0, 'CPU time') : null;
  const wallR = wall.trim() ? parseCapMinutes(wall, 0, 'running time') : null;
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
      setError(cloudErrorMessage(err, 'Could not start the run.'));
      setBusy(false);
    }
  };

  return (
    <Dialog
      open
      title="New Work run in the cloud"
      description="Its commands run on the cloud runner and keep going while your devices are off. Approvals still come to you."
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
          label="Cloud environment"
          value={envId}
          onChange={setEnvId}
          options={[
            ...(env ? [] : [{ value: '', label: 'Choose an environment' }]),
            ...environments.map((e) => ({
              value: e.id,
              label: ready(e) ? e.label : `${e.label} (${environmentState(e).text.toLowerCase()})`,
              disabled: !ready(e),
            })),
          ]}
          error={shown.env}
        />
        <TextArea
          id={`${id}-objective`}
          label="What should the run get done?"
          value={objective}
          rows={4}
          error={shown.objective}
          onChange={setObjective}
        />
        <TextField
          label="Title (optional)"
          value={title}
          maxLength={200}
          autoComplete="off"
          onChange={(e) => setTitle(e.target.value)}
        />
        <RadioGroup
          legend="Autonomy"
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
          <summary>Caps for this run (optional)</summary>
          <p className="nv-field-hint">
            Without them, the caps from Settings → Cloud runner apply. The run stops at a cap and
            waits for you to raise it.
          </p>
          <div className="cl-field-row">
            <TextField
              label="CPU time cap (minutes)"
              type="number"
              inputMode="numeric"
              className="ws-number"
              min={1}
              value={cpu}
              error={shown.cpu}
              onChange={(e) => setCpu(e.target.value)}
            />
            <TextField
              label="Running time cap (minutes)"
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
          Take a snapshot first
        </label>
        <span id={`${id}-snap`} className="nv-field-hint">
          You can restore it if the run leaves the environment in a bad state.
        </span>
        {error ? (
          <p className="nv-field-error" role="alert">
            {error}
          </p>
        ) : null}
        <div className="nv-dialog-footer">
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" disabled={busy}>
            {busy ? <Spinner /> : null} Start run
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
