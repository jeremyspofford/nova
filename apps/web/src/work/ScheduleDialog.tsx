// Create or edit a schedule (FR-055, FR-187, ADR-079; docs/09 §6): when it runs (a friendly
// picker for common cases plus cron or RRULE), the timezone (the browser's by default), the
// instructions, a notify condition, where results go, the declared output, what to do about
// missed runs, and the project.
import { useId, useRef, useState } from 'react';
import { defineMessages } from '@nova/i18n';
import type { ProjectView, ScheduleView } from '@nova/shared';
import { Button, Dialog, RadioGroup, SelectField, Spinner, TextField } from '@nova/ui';
import { errorMessage, type Api } from '../api.ts';
import { useServices } from '../services.tsx';
import { OUTPUT_KIND_TEXT, WORK_TEXT } from './format.ts';
import {
  browserTimezone,
  draftFromWhen,
  knownTimezones,
  REPEAT_TEXT,
  REPEATS,
  weekdayNames,
  whenFromDraft,
  type Repeat,
  type WhenDraft,
} from './schedule-when.ts';
import { ScheduleWebhookSecret } from '../channels/WebhookSecret.tsx';

type ScheduleBody = Parameters<Api['createSchedule']>[0];

const INSTRUCTIONS_MAX = 8000;

/** The schedule dialog. */
export const SCHEDULE_DIALOG_TEXT = defineMessages('work.scheduleDialog', {
  lookback: 'Enter whole days from {min} to {max}.',
  webhookInvalid: 'Enter the webhook address, starting with https://.',
  saveFailed: 'Could not save the schedule.',
  editTitle: 'Edit schedule',
  newTitle: 'New schedule',
  description: 'A schedule starts a Work run with these instructions each time it fires.',
  instructions: 'Instructions',
  /** {n} characters typed of at most {max}. */
  instructionsHint:
    'What to check or update each time. {n} / {max, plural, one {# character} other {# characters}}',
  when: 'When',
  repeat: 'Repeat',
  day: 'Day',
  time: 'Time',
  every: 'Every',
  unit: 'Unit',
  minutes: 'Minutes',
  hours: 'Hours',
  dateTime: 'Date and time',
  expr: 'Cron expression or RRULE',
  /** {cron} and {rrule} are examples, shown as typed. */
  exprHint: 'For example {cron} (Mondays at 07:30) or {rrule}.',
  timezone: 'Timezone',
  /** {example} is a timezone name, such as Europe/Paris. */
  timezoneHint: 'An IANA name, for example {example}.',
  notify: 'Notify only when (optional)',
  notifyHint: 'For example: only if a deadline is at risk. Otherwise the run ends with no news.',
  sendTo: 'Send results to',
  inapp: 'In-app notification',
  os: 'System notification on this device',
  webhook: 'Webhook',
  webhookAddress: 'Webhook address',
  noTarget: 'Choose at least one place for the results.',
  outputHint:
    'A run counts as done only when this output is verified; otherwise it ends as Output missing.',
  missed: 'Missed runs',
  missedHint: 'When the Hub was off or asleep at the scheduled time.',
  catchUpOnce: 'Catch up once',
  catchUpOnceHint: 'Run one catch-up run that covers every missed time.',
  skip: 'Skip them',
  skipHint: 'Record the missed times without running.',
  lookbackLabel: 'Catch up on the last (days)',
  lookbackHint: 'Older missed runs are recorded as skipped.',
  save: 'Save schedule',
  create: 'Create schedule',
});

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
  const S = SCHEDULE_DIALOG_TEXT;

  const rule = whenFromDraft(when);
  const days = Number(lookbackDays);
  const lookbackError =
    !/^\d+$/.test(lookbackDays.trim()) || days > 366 ? S.lookback({ min: 0, max: 366 }) : null;
  const webhookError =
    useWebhook && !/^https:\/\/\S+$/.test(webhook.trim()) ? S.webhookInvalid : null;
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
      setError(errorMessage(err, S.saveFailed));
      setBusy(false);
    }
  };

  const setW = (patch: Partial<WhenDraft>) => setWhen((w) => ({ ...w, ...patch }));
  const timed = when.repeat === 'daily' || when.repeat === 'weekdays' || when.repeat === 'weekly';

  return (
    <Dialog
      open
      title={editing ? S.editTitle : S.newTitle}
      description={S.description}
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
          label={WORK_TEXT.titleOptional}
          value={title}
          maxLength={200}
          autoComplete="off"
          onChange={(e) => setTitle(e.target.value)}
        />
        <div className="nv-field">
          <label className="nv-field-label" htmlFor={`${formId}-instr`}>
            {S.instructions}
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
            {S.instructionsHint({ n: instructions.length, max: INSTRUCTIONS_MAX })}
          </span>
        </div>
        <fieldset className="ws-fieldset">
          <legend>{S.when}</legend>
          <SelectField
            label={S.repeat}
            value={when.repeat}
            onChange={(v) => setW({ repeat: v as Repeat })}
            options={REPEATS.map((r) => ({ value: r, label: REPEAT_TEXT[r] }))}
          />
          {when.repeat === 'weekly' ? (
            <SelectField
              label={S.day}
              value={String(when.day)}
              onChange={(v) => setW({ day: Number(v) })}
              options={weekdayNames().map((d, i) => ({ value: String(i), label: d }))}
            />
          ) : null}
          {timed ? (
            <TextField
              label={S.time}
              type="time"
              className="ws-number"
              value={when.time}
              onChange={(e) => setW({ time: e.target.value })}
            />
          ) : null}
          {when.repeat === 'interval' ? (
            <div className="work-budget-fields">
              <TextField
                label={S.every}
                type="number"
                inputMode="numeric"
                className="ws-number"
                min={1}
                step={1}
                value={when.every}
                onChange={(e) => setW({ every: e.target.value })}
              />
              <SelectField
                label={S.unit}
                value={when.unit}
                onChange={(v) => setW({ unit: v === 'minutes' ? 'minutes' : 'hours' })}
                options={[
                  { value: 'minutes', label: S.minutes },
                  { value: 'hours', label: S.hours },
                ]}
              />
            </div>
          ) : null}
          {when.repeat === 'once' ? (
            <TextField
              label={S.dateTime}
              type="datetime-local"
              value={when.at}
              onChange={(e) => setW({ at: e.target.value })}
            />
          ) : null}
          {when.repeat === 'advanced' ? (
            <TextField
              label={S.expr}
              value={when.expr}
              spellCheck={false}
              autoComplete="off"
              dir="ltr"
              hint={S.exprHint({ cron: '30 7 * * 1', rrule: 'FREQ=MONTHLY;BYMONTHDAY=1;BYHOUR=9' })}
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
              label={S.timezone}
              value={timezone}
              onChange={setTimezone}
              options={(zones.includes(timezone) ? zones : [timezone, ...zones]).map((z) => ({
                value: z,
                label: z,
              }))}
            />
          ) : (
            <TextField
              label={S.timezone}
              value={timezone}
              dir="ltr"
              hint={S.timezoneHint({ example: 'Europe/Paris' })}
              onChange={(e) => setTimezone(e.target.value)}
            />
          )}
        </fieldset>
        <TextField
          label={S.notify}
          value={notify}
          maxLength={1000}
          hint={S.notifyHint}
          onChange={(e) => setNotify(e.target.value)}
        />
        <fieldset className="ws-fieldset">
          <legend>{S.sendTo}</legend>
          <label className="work-check">
            <input type="checkbox" checked={inapp} onChange={(e) => setInapp(e.target.checked)} />
            {S.inapp}
          </label>
          <label className="work-check">
            <input type="checkbox" checked={os} onChange={(e) => setOs(e.target.checked)} />
            {S.os}
          </label>
          <label className="work-check">
            <input
              type="checkbox"
              checked={useWebhook}
              onChange={(e) => setUseWebhook(e.target.checked)}
            />
            {S.webhook}
          </label>
          {useWebhook ? (
            <TextField
              label={S.webhookAddress}
              type="url"
              value={webhook}
              maxLength={500}
              dir="ltr"
              // eslint-disable-next-line nova-i18n/no-literal-ui-text -- the start of an address, not text
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
              {S.noTarget}
            </p>
          ) : null}
        </fieldset>
        <SelectField
          label={WORK_TEXT.expectedOutput}
          value={outputKind}
          onChange={(v) => setOutputKind(v as typeof outputKind)}
          hint={S.outputHint}
          options={[
            { value: '', label: OUTPUT_KIND_TEXT.none },
            { value: 'artifact', label: OUTPUT_KIND_TEXT.artifact },
            { value: 'message', label: OUTPUT_KIND_TEXT.message },
            { value: 'file', label: OUTPUT_KIND_TEXT.file },
          ]}
        />
        {outputKind ? (
          <TextField
            label={WORK_TEXT.outputRef}
            value={outputRef}
            maxLength={1000}
            onChange={(e) => setOutputRef(e.target.value)}
          />
        ) : null}
        <RadioGroup
          legend={S.missed}
          name={`${formId}-catchup`}
          value={catchUp}
          onChange={(v) => setCatchUp(v === 'skip' ? 'skip' : 'once')}
          hint={S.missedHint}
          options={[
            { value: 'once', label: S.catchUpOnce, description: S.catchUpOnceHint },
            { value: 'skip', label: S.skip, description: S.skipHint },
          ]}
        />
        <TextField
          label={S.lookbackLabel}
          type="number"
          inputMode="numeric"
          className="ws-number"
          min={0}
          max={366}
          step={1}
          value={lookbackDays}
          error={lookbackError ?? undefined}
          hint={S.lookbackHint}
          onChange={(e) => setLookbackDays(e.target.value)}
        />
        <SelectField
          label={WORK_TEXT.project}
          value={projectId}
          onChange={setProjectId}
          options={[
            { value: '', label: WORK_TEXT.noProject },
            ...projects.map((p) => ({ value: p.id, label: p.name })),
          ]}
        />
        {error ? (
          <p className="nv-field-error" role="alert">
            {error}
          </p>
        ) : null}
        <div className="nv-dialog-footer">
          <Button onClick={onClose}>{WORK_TEXT.cancel}</Button>
          <Button type="submit" variant="primary" disabled={busy || invalid}>
            {busy ? <Spinner /> : null} {editing ? S.save : S.create}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
