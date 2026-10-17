// Notification routing and quiet hours (FR-060, docs/04 §1.1), a section of Settings →
// Notifications. Per kind: shown as unread in Nova, raised on the user's devices, and sent to
// Slack, Teams or webhook channels; and whether it passes quiet hours (approvals do by default).
// Quiet hours are a daily window in a time zone on chosen days: device and channel copies wait
// until it ends; in-app records are never held back. Each change to a kind is saved at once;
// quiet hours are saved with their own button.
import { useCallback, useEffect, useId, useState } from 'react';
import {
  NOTIFICATION_KINDS,
  quietHoursSchema,
  type ChannelBindingView,
  type NotificationKind,
  type NotificationRuleView,
  type QuietHoursView,
} from '@nova/shared';
import { Button, Icon, SelectField, Spinner, TextField, useToast } from '@nova/ui';
import { errorMessage } from '../api.ts';
import { navigate } from '../router.ts';
import { useSettings } from '../settings.tsx';
import { SwitchField } from '../settings/controls.tsx';
import { CATEGORY_TEXT } from '../settings/NotificationsPage.tsx';
import { browserTimezone, knownTimezones } from '../work/schedule-when.ts';
import { attempt, useChannelsApi } from './api.ts';
import { useChannelEvents, useDebouncedCallback } from './events.ts';
import { KIND_TEXT, errorField, formatStamp, issueErrors } from './format.ts';
import './channels.css';

/** Most channels one kind may go to (the Hub's limit). */
export const MAX_ROUTE_CHANNELS = 10;
const ROUTABLE = new Set(['slack', 'teams', 'webhook']);
const DAYS = [
  { short: 'Sun', long: 'Sunday' },
  { short: 'Mon', long: 'Monday' },
  { short: 'Tue', long: 'Tuesday' },
  { short: 'Wed', long: 'Wednesday' },
  { short: 'Thu', long: 'Thursday' },
  { short: 'Fri', long: 'Friday' },
  { short: 'Sat', long: 'Saturday' },
];

type Rule = Pick<NotificationRuleView, 'inapp' | 'os' | 'channels' | 'bypassQuietHours'>;

export function NotificationRoutingSection() {
  const api = useChannelsApi();
  const toast = useToast();
  const categories = useSettings().get('notifications.categories').value;
  const [rules, setRules] = useState<NotificationRuleView[] | null>(null);
  const [quiet, setQuiet] = useState<QuietHoursView | null>(null);
  const [channels, setChannels] = useState<ChannelBindingView[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [version, setVersion] = useState(0);

  useEffect(() => {
    let alive = true;
    attempt(() => api.listNotificationRules()).then(
      ({ items, quietHours }) => {
        if (!alive) return;
        setRules(items);
        setQuiet(quietHours);
        setError(null);
      },
      (err: unknown) =>
        alive && setError(errorMessage(err, 'Could not load where notifications go.')),
    );
    attempt(() => api.listChannels()).then(
      ({ items }) => alive && setChannels(items.filter((b) => ROUTABLE.has(b.kind))),
      () => undefined,
    );
    return () => {
      alive = false;
    };
  }, [api, version]);

  const reload = useCallback(() => setVersion((v) => v + 1), []);
  const debounced = useDebouncedCallback(reload, 200);
  useChannelEvents(['channel.binding.changed'], () => debounced(), reload);

  const setRule = async (category: NotificationKind, next: Rule) => {
    const before = rules;
    setRules(
      (list) =>
        list?.map((r) => (r.category === category ? { ...r, ...next, isDefault: false } : r)) ??
        null,
    );
    try {
      const saved = await api.setNotificationRule(category, next);
      setRules((list) => list?.map((r) => (r.category === category ? saved : r)) ?? null);
    } catch (err) {
      setRules(before);
      toast.show(`Could not save: ${errorMessage(err)}`, { tone: 'error' });
    }
  };

  const reset = async (category: NotificationKind) => {
    try {
      const saved = await api.resetNotificationRule(category);
      setRules((list) => list?.map((r) => (r.category === category ? saved : r)) ?? null);
      toast.show(`${CATEGORY_TEXT[category].label}: back to the default.`, { tone: 'success' });
    } catch (err) {
      toast.show(`Could not reset: ${errorMessage(err)}`, { tone: 'error' });
    }
  };

  return (
    <>
      <section className="settings-section" aria-labelledby="notif-routing">
        <h3 id="notif-routing">Where notifications go</h3>
        <p className="muted">
          For each kind: whether it shows as unread in Nova, appears on your devices, and is sent to
          a channel. During quiet hours, device and channel copies wait until they end, unless the
          kind is let through.
        </p>
        {error ? (
          <div role="alert" className="ws-error">
            <p>{error}</p>
            <Button onClick={reload}>Retry</Button>
          </div>
        ) : null}
        {rules === null && !error ? <Spinner label="Loading notification routes" /> : null}
        {rules
          ? NOTIFICATION_KINDS.map((k) => {
              const r = rules.find((x) => x.category === k);
              return r ? (
                <RouteFields
                  key={k}
                  rule={r}
                  off={!categories[k]}
                  channels={channels}
                  onChange={(next) => void setRule(k, next)}
                  onReset={() => void reset(k)}
                />
              ) : null;
            })
          : null}
        {rules && !channels.length ? (
          <p className="muted ws-flush">
            To send notifications to Slack, Teams or a webhook, add a channel in{' '}
            <a
              href="/settings/channels"
              onClick={(e) => {
                e.preventDefault();
                navigate('/settings/channels');
              }}
            >
              Channels
            </a>
            .
          </p>
        ) : null}
      </section>
      {quiet ? <QuietHoursEditor quiet={quiet} onSaved={setQuiet} /> : null}
    </>
  );
}

function RouteFields({
  rule,
  off,
  channels,
  onChange,
  onReset,
}: {
  rule: NotificationRuleView;
  /** Turned off in "What to notify you about": nothing is recorded or sent. */
  off: boolean;
  channels: ChannelBindingView[];
  onChange: (next: Rule) => void;
  onReset: () => void;
}) {
  const id = useId();
  const text = CATEGORY_TEXT[rule.category];
  const current: Rule = {
    inapp: rule.inapp,
    os: rule.os,
    channels: rule.channels,
    bypassQuietHours: rule.bypassQuietHours,
  };
  const full = rule.channels.length >= MAX_ROUTE_CHANNELS;
  // A channel the rule names that is gone or not routable stays listed so it can be removed.
  const unknown = rule.channels.filter((c) => !channels.some((b) => b.id === c));
  const check = (label: string, checked: boolean, change: (v: boolean) => void, disabled = off) => (
    <label className="ch-check">
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => change(e.target.checked)}
      />
      <span>{label}</span>
    </label>
  );
  return (
    <fieldset className="ws-fieldset ch-route" aria-describedby={`${id}-desc`}>
      <legend>{text.label}</legend>
      <p id={`${id}-desc`} className="nv-field-hint ws-flush">
        {off
          ? 'Turned off above: not recorded or sent anywhere.'
          : `${text.description}${rule.isDefault ? ' Using the default.' : ''}`}
      </p>
      <div className="ch-checks">
        {check('Unread in Nova', rule.inapp, (v) => onChange({ ...current, inapp: v }))}
        {check('On your devices', rule.os, (v) => onChange({ ...current, os: v }))}
        {check('Also during quiet hours', rule.bypassQuietHours, (v) =>
          onChange({ ...current, bypassQuietHours: v }),
        )}
      </div>
      {channels.length || unknown.length ? (
        <div className="ch-checks" role="group" aria-label={`${text.label}: channels`}>
          <span className="nv-field-hint ch-checks-head" aria-hidden="true">
            Also send to
          </span>
          {channels.map((b) => {
            const on = rule.channels.includes(b.id);
            return (
              <span key={b.id}>
                {check(
                  `${b.label} (${KIND_TEXT[b.kind]})`,
                  on,
                  (v) =>
                    onChange({
                      ...current,
                      channels: v
                        ? [...rule.channels, b.id]
                        : rule.channels.filter((c) => c !== b.id),
                    }),
                  off || (!on && full),
                )}
              </span>
            );
          })}
          {unknown.map((c) => (
            <span key={c}>
              {check('A removed channel', true, () =>
                onChange({ ...current, channels: rule.channels.filter((x) => x !== c) }),
              )}
            </span>
          ))}
        </div>
      ) : null}
      {full ? (
        <p className="nv-field-hint ws-flush">At most {MAX_ROUTE_CHANNELS} channels per kind.</p>
      ) : null}
      {!rule.isDefault ? (
        <div className="row">
          <Button
            variant="ghost"
            onClick={onReset}
            aria-label={`Reset ${text.label} to the default`}
          >
            Reset to default
          </Button>
        </div>
      ) : null}
    </fieldset>
  );
}

function QuietHoursEditor({
  quiet,
  onSaved,
}: {
  quiet: QuietHoursView;
  onSaved: (q: QuietHoursView) => void;
}) {
  const api = useChannelsApi();
  const toast = useToast();
  const id = useId();
  const [draft, setDraft] = useState(() => ({
    enabled: quiet.enabled,
    start: quiet.start,
    end: quiet.end,
    timezone: quiet.timezone,
    days: quiet.days,
  }));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const zones = knownTimezones();
  const set = (patch: Partial<typeof draft>) => setDraft((d) => ({ ...d, ...patch }));
  const dirty =
    draft.enabled !== quiet.enabled ||
    draft.start !== quiet.start ||
    draft.end !== quiet.end ||
    draft.timezone !== quiet.timezone ||
    draft.days.join(',') !== quiet.days.join(',');

  const save = async () => {
    const parsed = quietHoursSchema.safeParse(draft);
    if (!parsed.success) {
      const errs = issueErrors(parsed.error.issues);
      if (errs.days) errs.days = 'Pick at least one day.';
      setErrors(errs);
      return;
    }
    setErrors({});
    setBusy(true);
    try {
      const saved = await api.setQuietHours(parsed.data);
      onSaved(saved);
      toast.show(saved.enabled ? 'Quiet hours saved.' : 'Quiet hours are off.', {
        tone: 'success',
      });
    } catch (err) {
      const field = errorField(err);
      const message = errorMessage(err, 'Could not save quiet hours.');
      if (field) setErrors({ [field]: message });
      else toast.show(`Could not save: ${message}`, { tone: 'error' });
    } finally {
      setBusy(false);
    }
  };

  const zoneOptions = zones
    ? (zones.includes(draft.timezone) ? zones : [draft.timezone, ...zones]).map((z) => ({
        value: z,
        label: z.replace(/_/g, ' '),
      }))
    : null;

  return (
    <section className="settings-section" aria-labelledby={`${id}-h`}>
      <h3 id={`${id}-h`}>Quiet hours</h3>
      <p className="muted">
        A daily window when device and channel notifications wait. Agents also hold proactive
        research and self-set wakes until it ends.
      </p>
      {quiet.active ? (
        <p role="status" className="ws-flush ch-quiet-now">
          <Icon name="clock" /> Quiet hours are on now
          {quiet.until ? `, until ${formatStamp(quiet.until)}` : ''}.
        </p>
      ) : null}
      <form
        className="stack"
        aria-label="Quiet hours"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <SwitchField
          label="Use quiet hours"
          checked={draft.enabled}
          onChange={(v) => set({ enabled: v })}
        />
        <div className="row ch-times">
          <TextField
            label="From"
            type="time"
            value={draft.start}
            required
            error={errors.start}
            onChange={(e) => set({ start: e.target.value })}
          />
          <TextField
            label="Until"
            type="time"
            value={draft.end}
            required
            hint={draft.end <= draft.start ? 'Ends the next day.' : undefined}
            error={errors.end}
            onChange={(e) => set({ end: e.target.value })}
          />
        </div>
        <fieldset
          className="ch-days"
          aria-describedby={errors.days ? `${id}-days-error` : undefined}
        >
          <legend className="nv-field-label">Days it starts on</legend>
          <div className="ch-checks">
            {DAYS.map((d, i) => (
              <label key={d.short} className="ch-check ch-day">
                <input
                  type="checkbox"
                  aria-label={d.long}
                  checked={draft.days.includes(i)}
                  onChange={(e) =>
                    set({
                      days: e.target.checked
                        ? [...draft.days, i].sort((a, b) => a - b)
                        : draft.days.filter((x) => x !== i),
                    })
                  }
                />
                <span aria-hidden="true">{d.short}</span>
              </label>
            ))}
          </div>
          {errors.days ? (
            <span id={`${id}-days-error`} className="nv-field-error" role="alert">
              {errors.days}
            </span>
          ) : null}
        </fieldset>
        {zoneOptions ? (
          <SelectField
            label="Time zone"
            value={draft.timezone}
            options={zoneOptions}
            error={errors.timezone}
            onChange={(v) => set({ timezone: v })}
          />
        ) : (
          <TextField
            label="Time zone"
            value={draft.timezone}
            spellCheck={false}
            hint="An IANA name, like Europe/Paris."
            error={errors.timezone}
            onChange={(e) => set({ timezone: e.target.value })}
          />
        )}
        <div className="row">
          <Button type="submit" variant="primary" disabled={!dirty || busy}>
            {busy ? 'Saving…' : 'Save quiet hours'}
          </Button>
          {draft.timezone !== browserTimezone() ? (
            <Button onClick={() => set({ timezone: browserTimezone() })}>
              Use this device&apos;s time zone
            </Button>
          ) : null}
        </div>
      </form>
    </section>
  );
}
