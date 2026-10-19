// Create or edit a schedule (FR-055, FR-187, ADR-079; docs/09 §6): when it runs (a friendly
// picker for common cases plus cron or RRULE), the timezone (the browser's by default), the
// instructions, a notify condition, where results go, the declared output, what to do about
// missed runs, and the project.
import { useId, useRef, useState } from 'react';
import type { ProjectView, ScheduleView } from '@nova/shared';
import { Button, Dialog, RadioGroup, SelectField, Spinner, TextField } from '@nova/ui';
import { errorMessage, type Api } from '../api.ts';
import { useServices } from '../services.tsx';
import {
  browserTimezone,
  draftFromWhen,
  knownTimezones,
  REPEAT_TEXT,
  REPEATS,
  WEEKDAYS,
  whenFromDraft,
  type Repeat,
  type WhenDraft,
} from './schedule-when.ts';
import { ScheduleWebhookSecret } from '../channels/WebhookSecret.tsx';

type ScheduleBody = Parameters<Api['createSchedule']>[0];

const INSTRUCTIONS_MAX = 8000;

/** What a new schedule starts from: blank, or a finished run's objective ("Schedule it"). */
export interface ScheduleSeed {
  title?: string;
  instructions?: string;
  projectId?: string | null;
  output?: ScheduleView['output'];
}

export function ScheduleDialog({
  open,
  editing,
  seed,
  projects,
  onClose,
  onSaved,
}: {
  open: boolean;
  /** The schedule being edited, or null to create one. */
  editing: ScheduleView | null;
  seed?: ScheduleSeed;
  projects: ProjectView[];
  onClose: () => void;
  onSaved: (s: ScheduleView, created: boolean) => void;
}) {
  return open ? (
    <ScheduleForm
      editing={editing}
      seed={seed}
      projects={projects}
      onClose={onClose}
      onSaved={onSaved}
    />
  ) : null;
}

function ScheduleForm({
  editing,
  seed,
  projects,
  onClose,
  onSaved,
}: {
  editing: ScheduleView | null;
  seed?: ScheduleSeed;
  projects: ProjectView[];
  onClose: () => void;
  onSaved: (s: ScheduleView, created: boolean) => void;
}) {
  const { api } = useServices();
  const formId = `sd${useId()}`;
  const titleRef = useRef<HTMLInputElement>(null);
  const [title, setTitle] = useState(editing?.title ?? seed?.title ?? '');
  const [instructions, setInstructions] = useState(
    editing?.instructions ?? seed?.instructions ?? '',
  );
  const [when, setWhen] = useState<WhenDraft>(() =>
    draftFromWhen(editing?.when ?? null, new Date()),
  );
  const [timezone, setTimezone] = useState(editing?.timezone ?? browserTimezone());
  const [notify, setNotify] = useState(editing?.notifyCondition ?? '');
  const targets = editing?.deliveryTargets ?? [{ kind: 'inapp' as const }];
  const [inapp, setInapp] = useState(targets.some((t) => t.kind === 'inapp'));
  const [os, setOs] = useState(targets.some((t) => t.kind === 'os'));
  const [webhook, setWebhook] = useState(targets.find((t) => t.kind === 'webhook')?.ref ?? '');
  const [useWebhook, setUseWebhook] = useState(targets.some((t) => t.kind === 'webhook'));
  const output = editing?.output ?? seed?.output ?? null;
  const [outputKind, setOutputKind] = useState<'' | 'artifact' | 'message' | 'file'>(
    output?.kind ?? '',
  );
  const [outputRef, setOutputRef] = useState(output?.ref ?? '');
  const [catchUp, setCatchUp] = useState<'once' | 'skip'>(editing?.catchUp.policy ?? 'once');
  const [lookbackDays, setLookbackDays] = useState(
    String(Math.round((editing?.catchUp.lookbackSeconds ?? 604_800) / 86_400)),
  );
  const [projectId, setProjectId] = useState(editing?.projectId ?? seed?.projectId ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const zones = knownTimezones();

  const rule = whenFromDraft(when);
  const days = Number(lookbackDays);
  const lookbackError =
    !/^\d+$/.test(lookbackDays.trim()) || days > 366 ? 'Enter whole days from 0 to 366.' : null;
  const webhookError =
    useWebhook && !/^https:\/\/\S+$/.test(webhook.trim())
      ? 'Enter the webhook address, starting with https://.'
      : null;
  const noTarget = !inapp && !os && !useWebhook;
  const invalid =
    !instructions.trim() ||
    !timezone.trim() ||
    'error' in rule ||
    lookbackError !== null ||
    webhookError !== null ||
    noTarget;

  const submit = async () => {
    if (invalid || busy || 'error' in rule) return;
    setBusy(true);
    setError(null);
    const deliveryTargets: ScheduleBody['deliveryTargets'] = [
      ...(inapp ? [{ kind: 'inapp' as const }] : []),
      ...(os ? [{ kind: 'os' as const }] : []),
      ...(useWebhook ? [{ kind: 'webhook' as const, ref: webhook.trim() }] : []),
    ];
    const body: ScheduleBody = {
      when: rule.when,
      timezone: timezone.trim(),
      instructions: instructions.trim(),
      deliveryTargets,
      catchUp: { policy: catchUp, lookbackSeconds: days * 86_400 },
      ...(title.trim() ? { title: title.trim() } : {}),
      // An edit always sends it, so clearing the field clears the condition.
      ...(editing || notify.trim() ? { notifyCondition: notify.trim() } : {}),
      ...(outputKind
        ? { output: { kind: outputKind, ...(outputRef.trim() ? { ref: outputRef.trim() } : {}) } }
        : {}),
      ...(projectId ? { projectId } : {}),
    };
    try {
      const saved = editing
        ? await api.updateSchedule(editing.id, body)
        : await api.createSchedule(body);
      onSaved(saved, !editing);
    } catch (err) {
      setError(errorMessage(err, 'Could not save the schedule.'));
      setBusy(false);
    }
  };

  const setW = (patch: Partial<WhenDraft>) => setWhen((w) => ({ ...w, ...patch }));
  const timed = when.repeat === 'daily' || when.repeat === 'weekdays' || when.repeat === 'weekly';

  return (
    <Dialog
      open
      title={editing ? 'Edit schedule' : 'New schedule'}
      description="A schedule starts a Work run with these instructions each time it fires."
      onClose={onClose}
      initialFocusRef={titleRef}
      className="ws-wide-dialog"
    >
      <form
        id={formId}
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <TextField
          ref={titleRef}
          label="Title (optional)"
          value={title}
          maxLength={200}
          autoComplete="off"
          onChange={(e) => setTitle(e.target.value)}
        />
        <div className="nv-field">
          <label className="nv-field-label" htmlFor={`${formId}-instr`}>
            Instructions
          </label>
          <textarea
            id={`${formId}-instr`}
            className="nv-input ws-textarea"
            rows={4}
            required
            maxLength={INSTRUCTIONS_MAX}
            value={instructions}
            aria-describedby={`${formId}-instr-hint`}
            onChange={(e) => setInstructions(e.target.value)}
          />
          <span id={`${formId}-instr-hint`} className="nv-field-hint">
            What to check or update each time. {instructions.length.toLocaleString('en-US')} /{' '}
            {INSTRUCTIONS_MAX.toLocaleString('en-US')} characters
          </span>
        </div>
        <fieldset className="ws-fieldset">
          <legend>When</legend>
          <SelectField
            label="Repeat"
            value={when.repeat}
            onChange={(v) => setW({ repeat: v as Repeat })}
            options={REPEATS.map((r) => ({ value: r, label: REPEAT_TEXT[r] }))}
          />
          {when.repeat === 'weekly' ? (
            <SelectField
              label="Day"
              value={String(when.day)}
              onChange={(v) => setW({ day: Number(v) })}
              options={WEEKDAYS.map((d, i) => ({ value: String(i), label: d }))}
            />
          ) : null}
          {timed ? (
            <TextField
              label="Time"
              type="time"
              className="ws-number"
              value={when.time}
              onChange={(e) => setW({ time: e.target.value })}
            />
          ) : null}
          {when.repeat === 'interval' ? (
            <div className="work-budget-fields">
              <TextField
                label="Every"
                type="number"
                inputMode="numeric"
                className="ws-number"
                min={1}
                step={1}
                value={when.every}
                onChange={(e) => setW({ every: e.target.value })}
              />
              <SelectField
                label="Unit"
                value={when.unit}
                onChange={(v) => setW({ unit: v === 'minutes' ? 'minutes' : 'hours' })}
                options={[
                  { value: 'minutes', label: 'Minutes' },
                  { value: 'hours', label: 'Hours' },
                ]}
              />
            </div>
          ) : null}
          {when.repeat === 'once' ? (
            <TextField
              label="Date and time"
              type="datetime-local"
              value={when.at}
              onChange={(e) => setW({ at: e.target.value })}
            />
          ) : null}
          {when.repeat === 'advanced' ? (
            <TextField
              label="Cron expression or RRULE"
              value={when.expr}
              spellCheck={false}
              autoComplete="off"
              hint="For example 30 7 * * 1 (Mondays at 07:30) or FREQ=MONTHLY;BYMONTHDAY=1;BYHOUR=9."
              onChange={(e) => setW({ expr: e.target.value })}
            />
          ) : null}
          {'error' in rule && (when.repeat !== 'advanced' || when.expr.trim()) ? (
            <p className="nv-field-error" role="alert">
              {rule.error}
            </p>
          ) : null}
          {zones ? (
            <SelectField
              label="Timezone"
              value={timezone}
              onChange={setTimezone}
              options={(zones.includes(timezone) ? zones : [timezone, ...zones]).map((z) => ({
                value: z,
                label: z,
              }))}
            />
          ) : (
            <TextField
              label="Timezone"
              value={timezone}
              hint="An IANA name, for example Europe/Paris."
              onChange={(e) => setTimezone(e.target.value)}
            />
          )}
        </fieldset>
        <TextField
          label="Notify only when (optional)"
          value={notify}
          maxLength={1000}
          hint="For example: only if a deadline is at risk. Otherwise the run ends with no news."
          onChange={(e) => setNotify(e.target.value)}
        />
        <fieldset className="ws-fieldset">
          <legend>Send results to</legend>
          <label className="work-check">
            <input type="checkbox" checked={inapp} onChange={(e) => setInapp(e.target.checked)} />
            In-app notification
          </label>
          <label className="work-check">
            <input type="checkbox" checked={os} onChange={(e) => setOs(e.target.checked)} />
            System notification on this device
          </label>
          <label className="work-check">
            <input
              type="checkbox"
              checked={useWebhook}
              onChange={(e) => setUseWebhook(e.target.checked)}
            />
            Webhook
          </label>
          {useWebhook ? (
            <TextField
              label="Webhook address"
              type="url"
              value={webhook}
              maxLength={500}
              placeholder="https://"
              error={webhook ? (webhookError ?? undefined) : undefined}
              onChange={(e) => setWebhook(e.target.value)}
            />
          ) : null}
          {/* The signing secret of a saved webhook target, rotated and shown once (FR-055). */}
          {useWebhook && editing?.deliveryTargets?.some((t) => t.kind === 'webhook') ? (
            <ScheduleWebhookSecret scheduleId={editing.id} />
          ) : null}
          {noTarget ? (
            <p className="nv-field-error" role="alert">
              Choose at least one place for the results.
            </p>
          ) : null}
        </fieldset>
        <SelectField
          label="Expected output"
          value={outputKind}
          onChange={(v) => setOutputKind(v as typeof outputKind)}
          hint="A run counts as done only when this output is verified; otherwise it ends as Output missing."
          options={[
            { value: '', label: 'None' },
            { value: 'artifact', label: 'An artifact' },
            { value: 'message', label: 'A delivered message' },
            { value: 'file', label: 'A file' },
          ]}
        />
        {outputKind ? (
          <TextField
            label="Output name or path (optional)"
            value={outputRef}
            maxLength={1000}
            onChange={(e) => setOutputRef(e.target.value)}
          />
        ) : null}
        <RadioGroup
          legend="Missed runs"
          name={`${formId}-catchup`}
          value={catchUp}
          onChange={(v) => setCatchUp(v === 'skip' ? 'skip' : 'once')}
          hint="When the Hub was off or asleep at the scheduled time."
          options={[
            {
              value: 'once',
              label: 'Catch up once',
              description: 'Run one catch-up run that covers every missed time.',
            },
            {
              value: 'skip',
              label: 'Skip them',
              description: 'Record the missed times without running.',
            },
          ]}
        />
        <TextField
          label="Catch up on the last (days)"
          type="number"
          inputMode="numeric"
          className="ws-number"
          min={0}
          max={366}
          step={1}
          value={lookbackDays}
          error={lookbackError ?? undefined}
          hint="Older missed runs are recorded as skipped."
          onChange={(e) => setLookbackDays(e.target.value)}
        />
        <SelectField
          label="Project"
          value={projectId}
          onChange={setProjectId}
          options={[
            { value: '', label: 'No project' },
            ...projects.map((p) => ({ value: p.id, label: p.name })),
          ]}
        />
        {error ? (
          <p className="nv-field-error" role="alert">
            {error}
          </p>
        ) : null}
        <div className="nv-dialog-footer">
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" disabled={busy || invalid}>
            {busy ? <Spinner /> : null} {editing ? 'Save schedule' : 'Create schedule'}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
