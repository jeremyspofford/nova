// The agent's schedules and self-set wakes (FR-059, FR-206, FR-189; docs/09 §6, docs/04 §2.5): the
// schedules the user made for it and the wake-ups it set for itself, each marked with who set it
// and, for a wake, its reason (the agent's words: shown as text). The user can pause, resume,
// reschedule or cancel any of them; the instructions of one the agent set stay the agent's, so
// only its time can change here. A new schedule wakes the agent with the user's instructions.
// Pausing the agent pauses all of them until it resumes.
import { useEffect, useId, useRef, useState } from 'react';
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

/** Who set a schedule of an agent, in words. */
export function scheduleOrigin(s: Pick<ScheduleView, 'origin'>, agentName: string): string {
  if (s.origin === 'agent_self') return `Set by ${agentName}`;
  if (s.origin === 'agent') return `Created by ${agentName}`;
  return 'Set by you';
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
      (err: unknown) => alive && setError(errorMessage(err, 'Could not load the schedules.')),
    );
    return () => {
      alive = false;
    };
  }, [api, agent.id, version, manual]);

  const replace = (s: ScheduleView) =>
    setItems((list) => (list ?? []).map((x) => (x.id === s.id ? s : x)));
  const fail = (what: string) => (err: unknown) =>
    toast.show(`${what}: ${errorMessage(err)}`, { tone: 'error' });
  const paused = agent.status === 'paused';

  return (
    <section className="agent-section" aria-labelledby={headingId}>
      <div className="ws-section-header">
        <h2 id={headingId}>Schedules and wakes</h2>
        <Button onClick={() => setDialog({ editing: null })}>
          <Icon name="plus" /> New schedule
        </Button>
      </div>
      <p className="muted ws-flush">
        Each fire wakes the agent in its main thread. It can also set its own next wake-up; those
        show here and in{' '}
        <a href={SCHEDULED_PATH} onClick={(e) => followLink(e, SCHEDULED_PATH)}>
          Work, Scheduled
        </a>
        .
      </p>
      {paused ? (
        <p className="ws-callout" role="note">
          <Icon name="clock" />
          <span>Paused with the agent. They go on when you resume it.</span>
        </p>
      ) : null}
      {error ? (
        <div className="ws-error" role="alert">
          <p>{error}</p>
          <Button onClick={() => setManual((n) => n + 1)}>Retry</Button>
        </div>
      ) : items === null ? (
        <Spinner label="Loading the schedules" />
      ) : items.length === 0 ? (
        <p className="muted">
          Nothing scheduled. Add a schedule to wake the agent every morning, on weekdays or once.
        </p>
      ) : (
        <ul className="ws-list" aria-label="Agent schedules">
          {items.map((s) => {
            const byAgent = s.origin !== 'user';
            return (
              <li key={s.id} className="ws-list-row agent-schedule" aria-label={s.title}>
                <div className="work-row-main">
                  <span className="ws-card-link" data-untrusted={byAgent || undefined}>
                    {s.title}
                  </span>
                  <span className="muted ws-row-meta">
                    <span>
                      {whenText(s.when)} ({s.timezone})
                    </span>
                    <span className="ws-badge" data-origin={s.origin}>
                      <Icon name={byAgent ? 'agents' : 'clock'} /> {scheduleOrigin(s, agent.name)}
                    </span>
                    {s.enabled ? null : (
                      <span className="ws-badge">
                        <Icon name="stop" /> Paused
                      </span>
                    )}
                  </span>
                  {s.wakeReason ? (
                    <span className="agent-text">
                      <span className="muted">Reason: </span>
                      <span data-untrusted="true">{s.wakeReason}</span>
                    </span>
                  ) : null}
                  <span className="ws-row-meta">
                    <span>Next: {s.enabled ? formatDateTime(s.nextRunAt) : 'Paused'}</span>
                    {s.lastRunAt ? <span>Last: {formatDateTime(s.lastRunAt)}</span> : null}
                  </span>
                </div>
                <div className="ws-row-actions ws-toolbar">
                  <Button
                    aria-label={`${s.enabled ? 'Pause' : 'Resume'} ${s.title}`}
                    disabled={paused}
                    title={paused ? 'Resume the agent first' : undefined}
                    onClick={() => {
                      core
                        .updateSchedule(s.id, { enabled: !s.enabled })
                        .then(replace, fail('Could not change it'));
                    }}
                  >
                    {s.enabled ? 'Pause' : 'Resume'}
                  </Button>
                  <Button
                    aria-label={`Change ${s.title}`}
                    onClick={() => setDialog({ editing: s })}
                  >
                    {byAgent ? 'Change time' : 'Edit'}
                  </Button>
                  <Button
                    variant="danger"
                    aria-label={`Cancel ${s.title}`}
                    onClick={() => setCancelling(s)}
                  >
                    Cancel
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
              toast.show('Schedule saved.', { tone: 'success' });
            } else {
              const s = await api.createAgentSchedule(agent.id, {
                ...body,
                instructions: body.instructions ?? '',
              });
              setItems((list) => [...(list ?? []), s]);
              toast.show(`Scheduled “${s.title}”.`, { tone: 'success' });
            }
            setDialog(null);
          }}
        />
      ) : null}
      <Dialog
        open={cancelling !== null}
        title="Cancel this schedule?"
        description={
          cancelling ? `“${cancelling.title}” will not wake ${agent.name} again.` : undefined
        }
        onClose={() => setCancelling(null)}
        footer={
          <>
            <Button onClick={() => setCancelling(null)}>Keep it</Button>
            <Button
              variant="danger"
              onClick={() => {
                const s = cancelling;
                setCancelling(null);
                if (!s) return;
                core.deleteSchedule(s.id).then(() => {
                  setItems((list) => list?.filter((x) => x.id !== s.id) ?? null);
                  toast.show('Schedule cancelled.', { tone: 'success' });
                }, fail('Could not cancel it'));
              }}
            >
              Cancel schedule
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
      setFailure(errorMessage(err, 'Could not save the schedule.'));
      setBusy(false);
    }
  };

  return (
    <Dialog
      open
      title={editing ? (timeOnly ? 'Change the time' : 'Edit schedule') : 'New schedule'}
      description={
        timeOnly
          ? `${agentName} set this. You can change when it happens or cancel it.`
          : `Each time it fires, ${agentName} wakes with these instructions.`
      }
      onClose={onClose}
      initialFocusRef={first}
      className="ws-wide-dialog"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" form={formId} variant="primary" disabled={invalid || busy}>
            {busy ? <Spinner /> : null} {editing ? 'Save' : 'Schedule'}
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
            <span className="muted">Instructions: </span>
            <span data-untrusted="true">{editing.instructions}</span>
          </p>
        ) : (
          <>
            <TextField
              ref={first}
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
                rows={3}
                maxLength={8000}
                value={instructions}
                onChange={(e) => setInstructions(e.target.value)}
              />
            </div>
          </>
        )}
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
            <div className="agent-budget-fields">
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
              ref={timeOnly ? first : undefined}
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
        {failure ? (
          <p className="nv-field-error" role="alert">
            {failure}
          </p>
        ) : null}
      </form>
    </Dialog>
  );
}
