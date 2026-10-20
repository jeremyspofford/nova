// The agent's schedules and self-set wakes (FR-059, FR-206, FR-189; docs/09 §6, docs/04 §2.5): the
// schedules the user made for it and the wake-ups it set for itself, each marked with who set it
// and, for a wake, its reason (the agent's words: shown as text). The user can pause, resume,
// reschedule or cancel any of them; the instructions of one the agent set stay the agent's, so
// only its time can change here. A new schedule wakes the agent with the user's instructions.
// Pausing the agent pauses all of them until it resumes.
import { useEffect, useId, useRef, useState } from 'react';
import { defineMessages } from '@nova/i18n';
import type { AgentView, ScheduleView } from '@nova/shared';
import { Button, Dialog, Icon, SelectField, Spinner, TextField, useToast } from '@nova/ui';
import { errorMessage } from '../api.ts';
import { useServices } from '../services.tsx';
import { formatDateTime, SCHEDULED_PATH } from '../work/format.ts';
import { followLink } from '../work/nav.tsx';
import {
  browserTimezone,
  draftFromWhen,
  knownTimezones,
  REPEAT_TEXT,
  REPEATS,
  WEEKDAYS,
  whenFromDraft,
  whenText,
  type Repeat,
  type WhenDraft,
} from '../work/schedule-when.ts';
import { useAgentsApi } from './api.ts';
import { AGENTS_TEXT } from './format.ts';
import { rich } from '../i18n/rich.tsx';

export const SCHEDULES_TEXT = defineMessages('agents.schedules', {
  setBy: 'Set by {name}',
  createdBy: 'Created by {name}',
  setByYou: 'Set by you',
  loadFailed: 'Could not load the schedules.',
  heading: 'Schedules and wakes',
  new: 'New schedule',
  intro:
    'Each fire wakes the agent in its main thread. It can also set its own next wake-up; those show here and in {link}.',
  scheduledLink: 'Work, Scheduled',
  pausedNote: 'Paused with the agent. They go on when you resume it.',
  loading: 'Loading the schedules',
  empty: 'Nothing scheduled. Add a schedule to wake the agent every morning, on weekdays or once.',
  list: 'Agent schedules',
  /** When it fires and in which timezone: "Every day at 09:00 (Europe/Paris)". */
  when: '{when} ({timezone})',
  paused: 'Paused',
  reason: 'Reason:',
  next: 'Next: {when}',
  nextPaused: 'Next: Paused',
  last: 'Last: {when}',
  pause: 'Pause',
  resume: 'Resume',
  pauseOf: 'Pause {title}',
  resumeOf: 'Resume {title}',
  changeFailed: 'Could not change it: {reason}',
  changeOf: 'Change {title}',
  changeTime: 'Change time',
  cancelOf: 'Cancel {title}',
  saved: 'Schedule saved.',
  scheduled: 'Scheduled “{title}”.',
  cancelTitle: 'Cancel this schedule?',
  cancelBody: '“{title}” will not wake {name} again.',
  keep: 'Keep it',
  cancelled: 'Schedule cancelled.',
  cancelFailed: 'Could not cancel it: {reason}',
  cancelSchedule: 'Cancel schedule',
  saveFailed: 'Could not save the schedule.',
  changeTitle: 'Change the time',
  editTitle: 'Edit schedule',
  newTitle: 'New schedule',
  timeOnlyBody: '{name} set this. You can change when it happens or cancel it.',
  newBody: 'Each time it fires, {name} wakes with these instructions.',
  schedule: 'Schedule',
  instructionsLabel: 'Instructions:',
  titleOptional: 'Title (optional)',
  whenLegend: 'When',
  repeat: 'Repeat',
  day: 'Day',
  time: 'Time',
  every: 'Every',
  unit: 'Unit',
  minutes: 'Minutes',
  hours: 'Hours',
  dateTime: 'Date and time',
  expr: 'Cron expression or RRULE',
  exprHint: 'For example 30 7 * * 1 (Mondays at 07:30) or FREQ=MONTHLY;BYMONTHDAY=1;BYHOUR=9.',
  timezone: 'Timezone',
  timezoneHint: 'An IANA name, for example Europe/Paris.',
});

/** Who set a schedule of an agent, in words. */
export function scheduleOrigin(s: Pick<ScheduleView, 'origin'>, agentName: string): string {
  if (s.origin === 'agent_self') return SCHEDULES_TEXT.setBy({ name: agentName });
  if (s.origin === 'agent') return SCHEDULES_TEXT.createdBy({ name: agentName });
  return SCHEDULES_TEXT.setByYou;
}

export function AgentSchedules({ agent, version }: { agent: AgentView; version: number }) {
  const { api: core } = useServices();
  const api = useAgentsApi();
  const toast = useToast();
  const headingId = useId();
  const [items, setItems] = useState<ScheduleView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [manual, setManual] = useState(0);
  const [dialog, setDialog] = useState<{ editing: ScheduleView | null } | null>(null);
  const [cancelling, setCancelling] = useState<ScheduleView | null>(null);

  useEffect(() => {
    let alive = true;
    api.listAgentSchedules(agent.id).then(
      ({ items: list }) => {
        if (!alive) return;
        setItems(list);
        setError(null);
      },
      (err: unknown) => alive && setError(errorMessage(err, SCHEDULES_TEXT.loadFailed)),
    );
    return () => {
      alive = false;
    };
  }, [api, agent.id, version, manual]);

  const replace = (s: ScheduleView) =>
    setItems((list) => (list ?? []).map((x) => (x.id === s.id ? s : x)));
  const fail = (failed: (p: { reason: string }) => string) => (err: unknown) =>
    toast.show(failed({ reason: errorMessage(err) }), { tone: 'error' });
  const paused = agent.status === 'paused';

  return (
    <section className="agent-section" aria-labelledby={headingId}>
      <div className="ws-section-header">
        <h2 id={headingId}>{SCHEDULES_TEXT.heading}</h2>
        <Button onClick={() => setDialog({ editing: null })}>
          <Icon name="plus" /> {SCHEDULES_TEXT.new}
        </Button>
      </div>
      <p className="muted ws-flush">
        {rich(SCHEDULES_TEXT.intro, {
          link: (
            <a href={SCHEDULED_PATH} onClick={(e) => followLink(e, SCHEDULED_PATH)}>
              {SCHEDULES_TEXT.scheduledLink}
            </a>
          ),
        })}
      </p>
      {paused ? (
        <p className="ws-callout" role="note">
          <Icon name="clock" />
          <span>{SCHEDULES_TEXT.pausedNote}</span>
        </p>
      ) : null}
      {error ? (
        <div className="ws-error" role="alert">
          <p>{error}</p>
          <Button onClick={() => setManual((n) => n + 1)}>{AGENTS_TEXT.retry}</Button>
        </div>
      ) : items === null ? (
        <Spinner label={SCHEDULES_TEXT.loading} />
      ) : items.length === 0 ? (
        <p className="muted">{SCHEDULES_TEXT.empty}</p>
      ) : (
        <ul className="ws-list" aria-label={SCHEDULES_TEXT.list}>
          {items.map((s) => {
            const byAgent = s.origin !== 'user';
            return (
              <li key={s.id} className="ws-list-row agent-schedule" aria-label={s.title}>
                <div className="work-row-main">
                  <span className="ws-card-link" data-untrusted={byAgent || undefined} dir="auto">
                    {s.title}
                  </span>
                  <span className="muted ws-row-meta">
                    <span>
                      {SCHEDULES_TEXT.when({ when: whenText(s.when), timezone: s.timezone })}
                    </span>
                    <span className="ws-badge" data-origin={s.origin}>
                      <Icon name={byAgent ? 'agents' : 'clock'} /> {scheduleOrigin(s, agent.name)}
                    </span>
                    {s.enabled ? null : (
                      <span className="ws-badge">
                        <Icon name="stop" /> {SCHEDULES_TEXT.paused}
                      </span>
                    )}
                  </span>
                  {s.wakeReason ? (
                    <span className="agent-text">
                      <span className="muted">{SCHEDULES_TEXT.reason}</span>{' '}
                      <span data-untrusted="true" dir="auto">
                        {s.wakeReason}
                      </span>
                    </span>
                  ) : null}
                  <span className="ws-row-meta">
                    <span>
                      {s.enabled
                        ? SCHEDULES_TEXT.next({ when: formatDateTime(s.nextRunAt) })
                        : SCHEDULES_TEXT.nextPaused}
                    </span>
                    {s.lastRunAt ? (
                      <span>{SCHEDULES_TEXT.last({ when: formatDateTime(s.lastRunAt) })}</span>
                    ) : null}
                  </span>
                </div>
                <div className="ws-row-actions ws-toolbar">
                  <Button
                    aria-label={(s.enabled ? SCHEDULES_TEXT.pauseOf : SCHEDULES_TEXT.resumeOf)({
                      title: s.title,
                    })}
                    disabled={paused}
                    title={paused ? AGENTS_TEXT.resumeFirst : undefined}
                    onClick={() => {
                      core
                        .updateSchedule(s.id, { enabled: !s.enabled })
                        .then(replace, fail(SCHEDULES_TEXT.changeFailed));
                    }}
                  >
                    {s.enabled ? SCHEDULES_TEXT.pause : SCHEDULES_TEXT.resume}
                  </Button>
                  <Button
                    aria-label={SCHEDULES_TEXT.changeOf({ title: s.title })}
                    onClick={() => setDialog({ editing: s })}
                  >
                    {byAgent ? SCHEDULES_TEXT.changeTime : AGENTS_TEXT.edit}
                  </Button>
                  <Button
                    variant="danger"
                    aria-label={SCHEDULES_TEXT.cancelOf({ title: s.title })}
                    onClick={() => setCancelling(s)}
                  >
                    {AGENTS_TEXT.cancel}
                  </Button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {dialog ? (
        <AgentScheduleDialog
          agentName={agent.name}
          editing={dialog.editing}
          onClose={() => setDialog(null)}
          onSave={async (body) => {
            const editing = dialog.editing;
            if (editing) {
              replace(await core.updateSchedule(editing.id, body));
              toast.show(SCHEDULES_TEXT.saved, { tone: 'success' });
            } else {
              const s = await api.createAgentSchedule(agent.id, {
                ...body,
                instructions: body.instructions ?? '',
              });
              setItems((list) => [...(list ?? []), s]);
              toast.show(SCHEDULES_TEXT.scheduled({ title: s.title }), { tone: 'success' });
            }
            setDialog(null);
          }}
        />
      ) : null}
      <Dialog
        open={cancelling !== null}
        title={SCHEDULES_TEXT.cancelTitle}
        description={
          cancelling
            ? SCHEDULES_TEXT.cancelBody({ title: cancelling.title, name: agent.name })
            : undefined
        }
        onClose={() => setCancelling(null)}
        footer={
          <>
            <Button onClick={() => setCancelling(null)}>{SCHEDULES_TEXT.keep}</Button>
            <Button
              variant="danger"
              onClick={() => {
                const s = cancelling;
                setCancelling(null);
                if (!s) return;
                core.deleteSchedule(s.id).then(() => {
                  setItems((list) => list?.filter((x) => x.id !== s.id) ?? null);
                  toast.show(SCHEDULES_TEXT.cancelled, { tone: 'success' });
                }, fail(SCHEDULES_TEXT.cancelFailed));
              }}
            >
              {SCHEDULES_TEXT.cancelSchedule}
            </Button>
          </>
        }
      />
    </section>
  );
}

interface ScheduleBody {
  when: ScheduleView['when'];
  timezone: string;
  title?: string;
  instructions?: string;
}

function AgentScheduleDialog({
  agentName,
  editing,
  onClose,
  onSave,
}: {
  agentName: string;
  editing: ScheduleView | null;
  onClose: () => void;
  onSave: (body: ScheduleBody) => Promise<void>;
}) {
  const formId = `as${useId()}`;
  const first = useRef<HTMLInputElement>(null);
  // What the agent set stays its own: only the time changes (FR-189).
  const timeOnly = editing !== null && editing.origin !== 'user';
  const [title, setTitle] = useState(editing?.title ?? '');
  const [instructions, setInstructions] = useState(editing?.instructions ?? '');
  const [when, setWhen] = useState<WhenDraft>(() =>
    draftFromWhen(editing?.when ?? null, new Date()),
  );
  const [timezone, setTimezone] = useState(editing?.timezone ?? browserTimezone());
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const zones = knownTimezones();
  const rule = whenFromDraft(when);
  const invalid = 'error' in rule || !timezone.trim() || (!timeOnly && !instructions.trim());
  const setW = (patch: Partial<WhenDraft>) => setWhen((w) => ({ ...w, ...patch }));
  const timed = when.repeat === 'daily' || when.repeat === 'weekdays' || when.repeat === 'weekly';

  const submit = async () => {
    if (invalid || busy || 'error' in rule) return;
    setBusy(true);
    setFailure(null);
    try {
      await onSave({
        when: rule.when,
        timezone: timezone.trim(),
        ...(timeOnly
          ? {}
          : {
              instructions: instructions.trim(),
              ...(title.trim() ? { title: title.trim() } : {}),
            }),
      });
    } catch (err) {
      setFailure(errorMessage(err, SCHEDULES_TEXT.saveFailed));
      setBusy(false);
    }
  };

  return (
    <Dialog
      open
      title={
        editing
          ? timeOnly
            ? SCHEDULES_TEXT.changeTitle
            : SCHEDULES_TEXT.editTitle
          : SCHEDULES_TEXT.newTitle
      }
      description={
        timeOnly
          ? SCHEDULES_TEXT.timeOnlyBody({ name: agentName })
          : SCHEDULES_TEXT.newBody({ name: agentName })
      }
      onClose={onClose}
      initialFocusRef={first}
      className="ws-wide-dialog"
      footer={
        <>
          <Button onClick={onClose}>{AGENTS_TEXT.cancel}</Button>
          <Button type="submit" form={formId} variant="primary" disabled={invalid || busy}>
            {busy ? <Spinner /> : null} {editing ? AGENTS_TEXT.save : SCHEDULES_TEXT.schedule}
          </Button>
        </>
      }
    >
      <form
        id={formId}
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        {timeOnly && editing ? (
          <p className="ws-flush agent-text">
            <span className="muted">{SCHEDULES_TEXT.instructionsLabel}</span>{' '}
            <span data-untrusted="true" dir="auto">
              {editing.instructions}
            </span>
          </p>
        ) : (
          <>
            <TextField
              ref={first}
              label={SCHEDULES_TEXT.titleOptional}
              value={title}
              maxLength={200}
              autoComplete="off"
              onChange={(e) => setTitle(e.target.value)}
            />
            <div className="nv-field">
              <label className="nv-field-label" htmlFor={`${formId}-instr`}>
                {AGENTS_TEXT.instructions}
              </label>
              <textarea
                id={`${formId}-instr`}
                className="nv-input ws-textarea"
                rows={3}
                maxLength={8000}
                dir="auto"
                value={instructions}
                onChange={(e) => setInstructions(e.target.value)}
              />
            </div>
          </>
        )}
        <fieldset className="ws-fieldset">
          <legend>{SCHEDULES_TEXT.whenLegend}</legend>
          <SelectField
            label={SCHEDULES_TEXT.repeat}
            value={when.repeat}
            onChange={(v) => setW({ repeat: v as Repeat })}
            options={REPEATS.map((r) => ({ value: r, label: REPEAT_TEXT[r] }))}
          />
          {when.repeat === 'weekly' ? (
            <SelectField
              label={SCHEDULES_TEXT.day}
              value={String(when.day)}
              onChange={(v) => setW({ day: Number(v) })}
              options={WEEKDAYS.map((d, i) => ({ value: String(i), label: d }))}
            />
          ) : null}
          {timed ? (
            <TextField
              label={SCHEDULES_TEXT.time}
              type="time"
              className="ws-number"
              value={when.time}
              onChange={(e) => setW({ time: e.target.value })}
            />
          ) : null}
          {when.repeat === 'interval' ? (
            <div className="agent-budget-fields">
              <TextField
                label={SCHEDULES_TEXT.every}
                type="number"
                inputMode="numeric"
                className="ws-number"
                min={1}
                step={1}
                value={when.every}
                onChange={(e) => setW({ every: e.target.value })}
              />
              <SelectField
                label={SCHEDULES_TEXT.unit}
                value={when.unit}
                onChange={(v) => setW({ unit: v === 'minutes' ? 'minutes' : 'hours' })}
                options={[
                  { value: 'minutes', label: SCHEDULES_TEXT.minutes },
                  { value: 'hours', label: SCHEDULES_TEXT.hours },
                ]}
              />
            </div>
          ) : null}
          {when.repeat === 'once' ? (
            <TextField
              ref={timeOnly ? first : undefined}
              label={SCHEDULES_TEXT.dateTime}
              type="datetime-local"
              value={when.at}
              onChange={(e) => setW({ at: e.target.value })}
            />
          ) : null}
          {when.repeat === 'advanced' ? (
            <TextField
              label={SCHEDULES_TEXT.expr}
              value={when.expr}
              spellCheck={false}
              autoComplete="off"
              dir="ltr"
              hint={SCHEDULES_TEXT.exprHint}
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
              label={SCHEDULES_TEXT.timezone}
              value={timezone}
              // IANA names are identifiers, never translated.
              translate="no"
              dir="ltr"
              onChange={setTimezone}
              options={(zones.includes(timezone) ? zones : [timezone, ...zones]).map((z) => ({
                value: z,
                label: z,
              }))}
            />
          ) : (
            <TextField
              label={SCHEDULES_TEXT.timezone}
              value={timezone}
              dir="ltr"
              hint={SCHEDULES_TEXT.timezoneHint}
              onChange={(e) => setTimezone(e.target.value)}
            />
          )}
        </fieldset>
        {failure ? (
          <p className="nv-field-error" role="alert">
            {failure}
          </p>
        ) : null}
      </form>
    </Dialog>
  );
}
