// Notification routing and quiet hours (FR-060, docs/04 §1.1), a section of Settings →
// Notifications. Per kind: shown as unread in Nova, raised on the user's devices, and sent to
// Slack, Teams, Telegram, email or webhook channels; and whether it passes quiet hours (approvals
// do by default). Each kind can send a test notification through the whole pipeline, which says
// where it went (M7). Quiet hours are a daily window in a time zone on chosen days: device and
// channel copies wait until it ends; in-app records are never held back. Each change to a kind is
// saved at once; quiet hours are saved with their own button.
import { useCallback, useEffect, useId, useState } from 'react';
import { defineMessages, fmt } from '@nova/i18n';
import {
  NOTIFICATION_KINDS,
  quietHoursSchema,
  type ChannelBindingViewM7,
  type NotificationKind,
  type NotificationRuleView,
  type NotificationTestView,
  type QuietHoursView,
} from '@nova/shared';
import { Button, Icon, SelectField, Spinner, TextField, useToast } from '@nova/ui';
import { errorMessage } from '../api.ts';
import { rich } from '../i18n/rich.tsx';
import { navigate } from '../router.ts';
import { useSettings } from '../settings.tsx';
import { SwitchField } from '../settings/controls.tsx';
import { CATEGORY_TEXT } from '../settings/NotificationsPage.tsx';
import { browserTimezone, knownTimezones } from '../work/schedule-when.ts';
import { attempt, useChannelsApi } from './api.ts';
import { useChannelsM7Api } from './api-m7.ts';
import { useChannelEvents, useDebouncedCallback } from './events.ts';
import { CHANNEL_TEXT, KIND_TEXT, errorField, formatStamp, issueErrors } from './format.ts';
import './channels.css';

/** Most channels one kind may go to (the Hub's limit). */
export const MAX_ROUTE_CHANNELS = 10;
const ROUTABLE = new Set(['slack', 'teams', 'telegram', 'email', 'webhook']);
/** The days of the week (0 is Sunday) in the active locale, short and long. */
function weekDays(): { short: string; long: string }[] {
  // 1 January 2023 was a Sunday.
  return [0, 1, 2, 3, 4, 5, 6].map((i) => {
    const d = new Date(2023, 0, 1 + i);
    return { short: fmt.date(d, { weekday: 'short' }), long: fmt.date(d, { weekday: 'long' }) };
  });
}

/** Notification routing's and quiet hours' words (FR-016). Channel names are data. */
export const ROUTING_TEXT = defineMessages('channels.routing', {
  title: 'Where notifications go',
  intro:
    'For each kind: whether it shows as unread in Nova, appears on your devices, and is sent to a channel. During quiet hours, device and channel copies wait until they end, unless the kind is let through.',
  loadFailed: 'Could not load where notifications go.',
  retry: 'Retry',
  loading: 'Loading notification routes',
  saveFailed: 'Could not save: {error}',
  backToDefault: '{kind}: back to the default.',
  resetFailed: 'Could not reset: {error}',
  addChannel:
    'To send notifications to Slack, Teams, Telegram, email or a webhook, add a channel in {channels}.',
  channels: 'Channels',
  offAbove: 'Turned off above: not recorded or sent anywhere.',
  withDefault: '{description} Using the default.',
  unread: 'Unread in Nova',
  devices: 'On your devices',
  quietToo: 'Also during quiet hours',
  channelsOf: '{kind}: channels',
  alsoSendTo: 'Also send to',
  removedChannel: 'A removed channel',
  atMost: 'At most {n, plural, one {# channel} other {# channels}} per kind.',
  offTitle: 'Turned off above.',
  sendTestLabel:
    '{kind, select, approval {Send a test approvals notification} completion {Send a test finished work notification} error {Send a test errors notification} attention {Send a test needs attention notification} system {Send a test system notification} other {Send a test notification}}',
  sendTest: 'Send a test',
  resetLabel: 'Reset {kind} to the default',
  reset: 'Reset to default',
  testFailed: 'Could not send a test.',
  testSent: 'Test sent.',
  result: {
    unreadYes: 'Unread in Nova: yes.',
    unreadNo: 'Unread in Nova: no.',
    devicesYes: 'On your devices: yes.',
    devicesQuiet: 'On your devices: no, it is quiet hours.',
    devicesNo: 'On your devices: no.',
    waiting: 'To {names}: waiting until quiet hours end at {when}.',
    sent: 'To {names}: sent.',
    none: 'To channels: none.',
    removedChannel: 'a removed channel',
  },
  quiet: {
    title: 'Quiet hours',
    intro:
      'A daily window when device and channel notifications wait. Agents also hold proactive research and self-set wakes until it ends.',
    onNow: 'Quiet hours are on now.',
    onUntil: 'Quiet hours are on now, until {when}.',
    form: 'Quiet hours',
    use: 'Use quiet hours',
    from: 'From',
    until: 'Until',
    nextDay: 'Ends the next day.',
    days: 'Days it starts on',
    pickDay: 'Pick at least one day.',
    timezone: 'Time zone',
    timezoneHint: 'An IANA name, like Europe/Paris.',
    saving: 'Saving…',
    save: 'Save quiet hours',
    thisDevice: "Use this device's time zone",
    saved: 'Quiet hours saved.',
    off: 'Quiet hours are off.',
    saveFailed: 'Could not save quiet hours.',
    saveFailedWith: 'Could not save: {error}',
  },
});

type Rule = Pick<NotificationRuleView, 'inapp' | 'os' | 'channels' | 'bypassQuietHours'>;

export function NotificationRoutingSection() {
  const api = useChannelsApi();
  const toast = useToast();
  const categories = useSettings().get('notifications.categories').value;
  const [rules, setRules] = useState<NotificationRuleView[] | null>(null);
  const [quiet, setQuiet] = useState<QuietHoursView | null>(null);
  const [channels, setChannels] = useState<ChannelBindingViewM7[]>([]);
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
      (err: unknown) => alive && setError(errorMessage(err, ROUTING_TEXT.loadFailed)),
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
      toast.show(ROUTING_TEXT.saveFailed({ error: errorMessage(err) }), { tone: 'error' });
    }
  };

  const reset = async (category: NotificationKind) => {
    try {
      const saved = await api.resetNotificationRule(category);
      setRules((list) => list?.map((r) => (r.category === category ? saved : r)) ?? null);
      toast.show(ROUTING_TEXT.backToDefault({ kind: CATEGORY_TEXT[category].label }), {
        tone: 'success',
      });
    } catch (err) {
      toast.show(ROUTING_TEXT.resetFailed({ error: errorMessage(err) }), { tone: 'error' });
    }
  };

  return (
    <>
      <section className="settings-section" aria-labelledby="notif-routing">
        <h3 id="notif-routing">{ROUTING_TEXT.title}</h3>
        <p className="muted">{ROUTING_TEXT.intro}</p>
        {error ? (
          <div role="alert" className="ws-error">
            <p>{error}</p>
            <Button onClick={reload}>{ROUTING_TEXT.retry}</Button>
          </div>
        ) : null}
        {rules === null && !error ? <Spinner label={ROUTING_TEXT.loading} /> : null}
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
            {rich(ROUTING_TEXT.addChannel, {
              channels: (
                <a
                  href="/settings/channels"
                  onClick={(e) => {
                    e.preventDefault();
                    navigate('/settings/channels');
                  }}
                >
                  {ROUTING_TEXT.channels}
                </a>
              ),
            })}
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
  channels: ChannelBindingViewM7[];
  onChange: (next: Rule) => void;
  onReset: () => void;
}) {
  const id = useId();
  const api = useChannelsM7Api();
  const [testing, setTesting] = useState(false);
  const [tested, setTested] = useState<NotificationTestView | null>(null);
  const [testError, setTestError] = useState<string | null>(null);
  const sendTest = async () => {
    setTesting(true);
    setTestError(null);
    setTested(null);
    try {
      setTested(await attempt(() => api.testNotification(rule.category)));
    } catch (err) {
      setTestError(errorMessage(err, ROUTING_TEXT.testFailed));
    } finally {
      setTesting(false);
    }
  };
  const text = CATEGORY_TEXT[rule.category];
  const S = ROUTING_TEXT;
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
          ? S.offAbove
          : rule.isDefault
            ? S.withDefault({ description: text.description })
            : text.description}
      </p>
      <div className="ch-checks">
        {check(S.unread, rule.inapp, (v) => onChange({ ...current, inapp: v }))}
        {check(S.devices, rule.os, (v) => onChange({ ...current, os: v }))}
        {check(S.quietToo, rule.bypassQuietHours, (v) =>
          onChange({ ...current, bypassQuietHours: v }),
        )}
      </div>
      {channels.length || unknown.length ? (
        <div className="ch-checks" role="group" aria-label={S.channelsOf({ kind: text.label })}>
          <span className="nv-field-hint ch-checks-head" aria-hidden="true">
            {S.alsoSendTo}
          </span>
          {channels.map((b) => {
            const on = rule.channels.includes(b.id);
            return (
              <span key={b.id}>
                {check(
                  CHANNEL_TEXT.named({ name: b.label, kind: KIND_TEXT[b.kind] }),
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
              {check(S.removedChannel, true, () =>
                onChange({ ...current, channels: rule.channels.filter((x) => x !== c) }),
              )}
            </span>
          ))}
        </div>
      ) : null}
      {full ? (
        <p className="nv-field-hint ws-flush">{S.atMost({ n: MAX_ROUTE_CHANNELS })}</p>
      ) : null}
      <div className="row">
        <Button
          variant="ghost"
          disabled={off || testing}
          title={off ? S.offTitle : undefined}
          aria-label={S.sendTestLabel({ kind: rule.category })}
          onClick={() => void sendTest()}
        >
          {testing ? <Spinner /> : <Icon name="bell" />} {S.sendTest}
        </Button>
        {!rule.isDefault ? (
          <Button variant="ghost" onClick={onReset} aria-label={S.resetLabel({ kind: text.label })}>
            {S.reset}
          </Button>
        ) : null}
      </div>
      {tested ? <TestResult result={tested} channels={channels} osOn={rule.os} /> : null}
      {testError ? (
        <p role="alert" className="nv-field-error">
          {testError}
        </p>
      ) : null}
    </fieldset>
  );
}

/** Where a test notification went, as the rule and quiet hours decided it. */
export function testResultText(
  r: NotificationTestView,
  channelName: (id: string) => string,
  /** The rule sends this kind to devices (so a "no" means quiet hours held it). */
  osOn: boolean,
): string {
  const R = ROUTING_TEXT.result;
  const parts: string[] = [];
  parts.push(r.inapp ? R.unreadYes : R.unreadNo);
  parts.push(r.os ? R.devicesYes : osOn && r.deferUntil ? R.devicesQuiet : R.devicesNo);
  if (r.channels.length) {
    const names = fmt.list(r.channels.map(channelName));
    parts.push(
      r.deferUntil ? R.waiting({ names, when: formatStamp(r.deferUntil) }) : R.sent({ names }),
    );
  } else parts.push(R.none);
  return parts.join(' ');
}

function TestResult({
  result,
  channels,
  osOn,
}: {
  result: NotificationTestView;
  channels: ChannelBindingViewM7[];
  osOn: boolean;
}) {
  const name = (cid: string) => {
    const b = channels.find((x) => x.id === cid);
    return b
      ? CHANNEL_TEXT.named({ name: b.label, kind: KIND_TEXT[b.kind] })
      : ROUTING_TEXT.result.removedChannel;
  };
  return (
    <p role="status" className="ch-test-result">
      <Icon name="check" />
      <span>
        {ROUTING_TEXT.testSent} {testResultText(result, name, osOn)}
      </span>
    </p>
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
  const Q = ROUTING_TEXT.quiet;
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
      if (errs.days) errs.days = Q.pickDay;
      setErrors(errs);
      return;
    }
    setErrors({});
    setBusy(true);
    try {
      const saved = await api.setQuietHours(parsed.data);
      onSaved(saved);
      toast.show(saved.enabled ? Q.saved : Q.off, { tone: 'success' });
    } catch (err) {
      const field = errorField(err);
      const message = errorMessage(err, Q.saveFailed);
      if (field) setErrors({ [field]: message });
      else toast.show(Q.saveFailedWith({ error: message }), { tone: 'error' });
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
      <h3 id={`${id}-h`}>{Q.title}</h3>
      <p className="muted">{Q.intro}</p>
      {quiet.active ? (
        <p role="status" className="ws-flush ch-quiet-now">
          <Icon name="clock" />{' '}
          {quiet.until ? Q.onUntil({ when: formatStamp(quiet.until) }) : Q.onNow}
        </p>
      ) : null}
      <form
        className="stack"
        aria-label={Q.form}
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <SwitchField label={Q.use} checked={draft.enabled} onChange={(v) => set({ enabled: v })} />
        <div className="row ch-times">
          <TextField
            label={Q.from}
            type="time"
            value={draft.start}
            required
            error={errors.start}
            onChange={(e) => set({ start: e.target.value })}
          />
          <TextField
            label={Q.until}
            type="time"
            value={draft.end}
            required
            hint={draft.end <= draft.start ? Q.nextDay : undefined}
            error={errors.end}
            onChange={(e) => set({ end: e.target.value })}
          />
        </div>
        <fieldset
          className="ch-days"
          aria-describedby={errors.days ? `${id}-days-error` : undefined}
        >
          <legend className="nv-field-label">{Q.days}</legend>
          <div className="ch-checks">
            {weekDays().map((d, i) => (
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
            label={Q.timezone}
            value={draft.timezone}
            // IANA names are identifiers, never translated.
            translate="no"
            dir="ltr"
            options={zoneOptions}
            error={errors.timezone}
            onChange={(v) => set({ timezone: v })}
          />
        ) : (
          <TextField
            label={Q.timezone}
            value={draft.timezone}
            spellCheck={false}
            hint={Q.timezoneHint}
            error={errors.timezone}
            onChange={(e) => set({ timezone: e.target.value })}
          />
        )}
        <div className="row">
          <Button type="submit" variant="primary" disabled={!dirty || busy}>
            {busy ? Q.saving : Q.save}
          </Button>
          {draft.timezone !== browserTimezone() ? (
            <Button onClick={() => set({ timezone: browserTimezone() })}>{Q.thisDevice}</Button>
          ) : null}
        </div>
      </form>
    </section>
  );
}
