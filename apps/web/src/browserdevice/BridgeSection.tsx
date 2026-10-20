// A device's "Browser bridge" (FR-096, docs/11 §4.3, docs/12 §15): whether the Nova extension in
// the user's own browser on this computer is connected through novad (browser, extension version,
// OS user), the tabs the agent may act in (shared by the user, or opened by the agent in the Nova
// tab group), and the per-host grants: a host the browser allowed waits for the owner's
// confirmation, a host can be granted here, and "all sites" is a separate, elevated grant with
// its own confirmation (off by default, and turned off entirely by `browser.extensionBridgeAllSites`).
// Every grant and refusal asks first and names the computer and the site; nothing is one click.
// No grant covers the Hub's own addresses: such a host is refused (`hub_host`) on the form. The
// device's recent bridge activity (connections, a replaced connection, history searches, browser
// sessions the Hub closed) comes from the audit log.
// Managed policy can switch the bridge off (`browser.extensionBridge`). With setup steps:
// install the extension (the unpacked build for now), tell novad its id, `novad bridge enable`.
// The Hub's owner only: a member gets the owner-only notice.
import { useEffect, useId, useState, type ReactNode } from 'react';
import {
  bridgeHostSchema,
  type AuditEntryView,
  type BrowserBridgeGrantView,
  type BrowserBridgeStatusView,
  type DeviceView,
} from '@nova/shared';
import { Button, Icon, Spinner, TextField, useToast, type IconName } from '@nova/ui';
import { defineMessages } from '@nova/i18n';
import { ApiError } from '../api.ts';
import { listText } from '../devices/format.ts';
import { rich } from '../i18n/rich.tsx';
import { useAnnounce, useServices } from '../services.tsx';
import { useSettings } from '../settings.tsx';
import { formatWhen } from '../settings/common.ts';
import { useHubEvents } from '../spaces/events.ts';
import { isOwnerOnly } from '../team/format.ts';
import { OwnerOnlyNotice } from '../team/parts.tsx';
import { useDebounced } from '../work/events.ts';
import { useBrowserDeviceApi, type BrowserDeviceApi } from './api-m75.ts';
import { BRIDGE_EVENTS, eventDevice } from './events.ts';
import {
  bridgeAuditText,
  browserDeviceError,
  grantChip,
  grantLabel,
  isDeviceActivity,
  type Tone,
} from './format.ts';
import { Chip, ConfirmAction } from './parts.tsx';
import './browserdevice.css';

export const BRIDGE_TEXT = defineMessages('browserDevice.bridge', {
  hostHint: 'Enter a host name such as github.com',
  chip: { off: 'Turned off', connected: 'Connected', notConnected: 'Not connected' },
  title: 'Browser bridge',
  summary: {
    tabs: '{n, plural, one {# shared tab} other {# shared tabs}}',
    sites: '{n, plural, one {# site granted} other {# sites granted}}',
    allSites: 'all sites granted',
    waiting: '{n, plural, other {# waiting for you}}',
  },
  waitingSince: 'Your browser allowed the extension here {when}',
  confirmedAt: 'Confirmed {when}',
  revokedAt: 'Revoked {when}',
  notAllowedYet: 'Your browser has not allowed it yet: sharing a tab there asks',
  confirm: 'Confirm',
  confirmLabel: 'Confirm {label}',
  refuse: 'Refuse',
  refuseLabel: 'Refuse {label}',
  revoke: 'Revoke',
  revokeLabel: 'Revoke {label}',
  showDetails: 'Show details',
  hideDetails: 'Hide details',
  intro:
    'Lets agents act in your own browser on {name}, through the Nova extension: only in tabs you share, and only on sites you grant here. The agent’s own browser is separate and never gets your sign-ins.',
  now: 'Now: {summary}.',
  loadFailed: 'Could not load the browser bridge.',
  retry: 'Retry',
  retryBridge: 'Retry the browser bridge',
  loading: 'Loading the browser bridge',
  offManaged:
    'Turned off by your organization: nothing can act in your browser, and no site can be granted. The grants below stay and count again when it is turned on.',
  offSettings:
    'Turned off in Settings → Browser: nothing can act in your browser, and no site can be granted. The grants below stay and count again when it is turned on.',
  facts: {
    browser: 'Browser',
    extension: 'Extension',
    user: 'User',
    since: 'Connected since',
  },
  unknown: 'Unknown',
  extensionVersion: 'Nova {version}',
  notConnected:
    'Not connected. The extension connects when your browser runs it and the bridge is set up on {name}.',
  notConnectedSince:
    'Not connected since {when}. The extension connects when your browser runs it and the bridge is set up on {name}.',
  tabs: 'Shared tabs',
  untitled: 'Untitled tab',
  youShared: 'You shared it',
  agentOpened: 'Opened by the agent in the Nova tab group',
  inBrowserOf: 'In {user}’s browser',
  since: 'Since {when}',
  noTabs:
    'No tab is shared. Share one with the Nova button in your browser; the agent sees nothing else.',
  banner:
    'Every tab the agent controls shows the browser’s own banner and a NOVA badge. To stop, choose Stop sharing in the extension, cancel the banner or close the tab.',
  sites: 'Sites',
  sitesIntro:
    'Agents act only on sites granted here. When your browser allows the extension on a site (sharing a tab there asks), the site waits here until you confirm it.',
  sitesWaiting: 'Sites waiting for you',
  sitesGranted: 'Granted sites',
  noSites: 'No site is granted.',
  siteField: 'Site to grant',
  siteExample: 'github.com',
  siteHint:
    'An exact host name. This Hub’s own addresses are never granted: the bridge never acts on the Hub itself.',
  grant: 'Grant',
  allSites: 'All sites',
  elevated: 'Elevated risk',
  allSitesIntro:
    'Off by default. With it, agents can act on any site in a tab you share on {name}, signed in as you, so a page that tries to trick the agent reaches much more. Prefer granting sites one by one.',
  allSitesGrant: 'All sites grant',
  allNotInUseManaged: 'Not in use: turned off by your organization.',
  allNotInUseSettings: 'Not in use: the “all sites” grant is turned off in Settings → Browser.',
  grantAll: 'Grant all sites…',
  allUnavailableOff: 'Not available while the bridge is turned off.',
  allUnavailableManaged: 'Turned off by your organization.',
  allUnavailableSettings: 'Turned off in Settings → Browser (Allow the “all sites” grant).',
  showRevoked: 'Show revoked grants',
  hideRevoked: 'Hide revoked grants',
  revokedGrants: 'Revoked grants',
  noneRevoked: 'No grant was revoked.',
  setupOn: 'How to set up the bridge on {name}',
  grantDialog: {
    title: 'Grant {host} on {name}?',
    description:
      'Agents can then act on {host} in tabs you share in your browser on {name}, signed in as you. Each change still follows the site’s level in Settings → Browser, and cookies and passwords never leave the browser.',
    confirm: 'Grant {host}',
    done: '{host} granted on {name}.',
  },
  allDialog: {
    title: 'Grant all sites on {name}?',
    description: 'This is the elevated grant, off by default. What changes:',
    confirm: 'Grant all sites',
    acknowledge: 'I understand that agents can then act on any site in tabs I share on {name}.',
    done: 'All sites granted on {name}.',
    every: 'Agents may act on every site in a tab you share on {name}, signed in as you.',
    level:
      'Each change still follows the site’s level and asks where it must; cookies and passwords never leave the browser.',
    hub: 'It never covers this Hub’s own addresses.',
    revoke:
      'Revoke it here at any time; turning off “Allow the all sites grant” in Settings → Browser stops it at once.',
  },
  confirmDialog: {
    title: 'Confirm {host} on {name}?',
    description:
      'Your browser allowed the extension on {host}. Confirmed, agents can act on it in tabs you share on {name}, signed in as you. Each change still follows the site’s level, and cookies and passwords never leave the browser.',
    confirm: 'Confirm {host}',
  },
  refuseDialog: {
    title: 'Refuse {site} on {name}?',
    description:
      'Agents will not act on {site} in your browser on {name}. Your browser may still list its own permission; remove it there if you like.',
    done: '{site} refused on {name}.',
  },
  revokeDialog: {
    title: 'Revoke {site} on {name}?',
    description:
      'Agents stop acting on {site} in your browser on {name} at once. Grant it again here to undo.',
    done: '{site} revoked on {name}.',
  },
  activity: {
    loadFailed: 'Could not load the recent activity.',
    title: 'Recent activity',
    intro: 'History searches have no standing access: each one asks you in your browser first.',
    retry: 'Retry the recent activity',
    loading: 'Loading the recent activity',
    none: 'Nothing yet. Connections, history searches and sessions the Hub closed show here.',
    list: 'Recent bridge activity',
    row: '{what}, {when}',
  },
  setup: {
    installTitle: 'Install the extension.',
    install:
      'For now it is the unpacked build in {dist} of Nova’s source ({build} makes it). In a Chromium-based browser on {name}, open the extensions page, turn on Developer mode, choose Load unpacked and pick that folder. Note the extension’s id it shows.',
    idTitle: 'Tell novad the extension’s id.',
    id: 'On {name}, in novad’s {config} (in its data folder, {dataDir} by default), set {setting} and make sure your user name is in {users}. Then restart novad. Its browser module must be on (Modules tab).',
    enableTitle: 'Enable the bridge for yourself.',
    enable:
      'On {name}, as yourself and not as root, run {enable}. It registers the extension’s helper for your own browsers only; {disable} removes it.',
    shareTitle: 'Share a tab.',
    share:
      'Use the Nova button in your browser. The tab shows here, and its site waits under Sites for your confirmation.',
  },
});
const S = BRIDGE_TEXT;

/** Why a host typed into the grant form is not usable, or null. */
export function hostProblem(raw: string): string | null {
  return bridgeHostSchema.safeParse(raw).success ? null : S.hostHint;
}

/** The connection chip: off, connected, or not connected. */
export function bridgeChip(s: Pick<BrowserBridgeStatusView, 'connected' | 'enabled'>): {
  text: string;
  icon: IconName;
  tone: Tone;
} {
  if (!s.enabled) return { text: S.chip.off, icon: 'slash', tone: 'neutral' };
  return s.connected
    ? { text: S.chip.connected, icon: 'check', tone: 'ready' }
    : { text: S.chip.notConnected, icon: 'slash', tone: 'neutral' };
}

export function BrowserBridgeSection({ device }: { device: DeviceView }) {
  const api = useBrowserDeviceApi();
  if (!api || device.status === 'revoked') return null;
  return <BridgeBody api={api} device={device} />;
}

type Ask =
  | { kind: 'grant'; host: string }
  | { kind: 'all' }
  | { kind: 'confirm'; grant: BrowserBridgeGrantView }
  | { kind: 'revoke'; grant: BrowserBridgeGrantView };

interface Loaded {
  status: BrowserBridgeStatusView;
  grants: BrowserBridgeGrantView[];
}

function BridgeBody({ api, device }: { api: BrowserDeviceApi; device: DeviceView }) {
  const headingId = useId();
  const bodyId = useId();
  const setupId = useId();
  const toast = useToast();
  const announce = useAnnounce();
  const settings = useSettings();
  const managed = settings.get('browser.extensionBridge').locked;
  const allManaged = settings.get('browser.extensionBridgeAllSites').locked;
  const [data, setData] = useState<Loaded | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [attempt, setAttempt] = useState(0);
  const [showRevoked, setShowRevoked] = useState(false);
  const [host, setHost] = useState('');
  const [touched, setTouched] = useState(false);
  // A refusal of the typed host (one of the Hub's own addresses), shown on the field.
  const [formError, setFormError] = useState<string | null>(null);
  const [ask, setAsk] = useState<Ask | null>(null);
  const [setup, setSetup] = useState<boolean | null>(null);
  const [expanded, setExpanded] = useState<boolean | null>(null);
  const name = device.name;

  useEffect(() => {
    let alive = true;
    Promise.all([
      api.getBridgeStatus(device.id),
      api.listBridgeGrants(device.id, showRevoked),
    ]).then(
      ([status, { items }]) => {
        if (!alive) return;
        setData({ status, grants: items });
        setError(null);
      },
      (err: unknown) => alive && setError(err),
    );
    return () => {
      alive = false;
    };
  }, [api, device.id, showRevoked, attempt]);
  const reload = useDebounced(() => setAttempt((n) => n + 1), 150);
  useHubEvents(BRIDGE_EVENTS, (env) => {
    if (eventDevice(env) === device.id) reload();
  });

  const heading = (chip: ReactNode, toggle: ReactNode = null) => (
    <div className="ws-section-header">
      <div className="bdv-bridge-head">
        <h2 id={headingId}>{S.title}</h2>
        {chip}
      </div>
      {toggle}
    </div>
  );

  if (isOwnerOnly(error))
    return (
      <section className="ws-section devices-flat bdv-bridge" aria-labelledby={headingId}>
        {heading(null)}
        <OwnerOnlyNotice what={S.title} />
      </section>
    );

  const status = data?.status ?? null;
  const grants = data?.grants ?? [];
  const live = grants.filter((g) => g.state !== 'revoked');
  const hosts = live.filter((g) => !g.allSites);
  const pending = hosts.filter((g) => g.state === 'pending');
  const active = hosts.filter((g) => g.state === 'active');
  const all = live.find((g) => g.allSites) ?? null;
  const revoked = grants.filter((g) => g.state === 'revoked');
  const enabled = status?.enabled ?? true;
  const setupOpen = setup ?? (status !== null && !status.connected);
  const waiting = live.filter((g) => g.state === 'pending').length;
  // Collapsed to its summary unless a site waits for the owner (or the owner opened it).
  const open = expanded ?? waiting > 0;
  const summary = status
    ? listText([
        S.summary.tabs({ n: status.tabs.length }),
        S.summary.sites({ n: active.length }),
        ...(all?.state === 'active' ? [S.summary.allSites] : []),
        ...(waiting ? [S.summary.waiting({ n: waiting })] : []),
      ])
    : null;
  const problem = host.trim() ? hostProblem(host.trim()) : S.hostHint;

  const done = (text: string) => {
    setAsk(null);
    // The owner is working here: the section stays open after the change.
    setExpanded((v) => v ?? true);
    announce(text);
    toast.show(text, { tone: 'success' });
    setAttempt((n) => n + 1);
  };

  const grantRow = (g: BrowserBridgeGrantView) => {
    const label = grantLabel(g);
    const chip = grantChip(g.state);
    return (
      <li key={g.id} className="ws-list-row" aria-label={label}>
        <div className="ws-source-main">
          <span className="bdv-grant-head">
            <code className="ws-code-inline">{label}</code>
            <Chip tone={chip.tone} icon={chip.icon} text={chip.text} />
          </span>
          <span className="muted ws-row-meta">
            {g.state === 'pending' ? (
              <span>{S.waitingSince({ when: formatWhen(g.createdAt) })}</span>
            ) : g.state === 'active' ? (
              <span>{S.confirmedAt({ when: formatWhen(g.confirmedAt) })}</span>
            ) : (
              <span>{S.revokedAt({ when: formatWhen(g.revokedAt) })}</span>
            )}
            {g.state === 'active' && !g.browserPermission ? <span>{S.notAllowedYet}</span> : null}
          </span>
        </div>
        {g.state === 'pending' ? (
          <div className="row">
            <Button
              variant="primary"
              disabled={!enabled}
              onClick={() => setAsk({ kind: 'confirm', grant: g })}
              aria-label={S.confirmLabel({ label })}
            >
              {S.confirm}
            </Button>
            <Button
              variant="ghost"
              onClick={() => setAsk({ kind: 'revoke', grant: g })}
              aria-label={S.refuseLabel({ label })}
            >
              {S.refuse}
            </Button>
          </div>
        ) : g.state === 'active' ? (
          <Button
            variant="ghost"
            onClick={() => setAsk({ kind: 'revoke', grant: g })}
            aria-label={S.revokeLabel({ label })}
          >
            {S.revoke}
          </Button>
        ) : null}
      </li>
    );
  };

  const chip = status ? bridgeChip(status) : null;

  return (
    <section className="ws-section devices-flat bdv-bridge" aria-labelledby={headingId}>
      {heading(
        chip ? <Chip tone={chip.tone} icon={chip.icon} text={chip.text} /> : null,
        <Button
          variant="ghost"
          aria-expanded={open}
          aria-controls={bodyId}
          onClick={() => setExpanded(!open)}
        >
          <Icon name={open ? 'down' : 'forward'} /> {open ? S.hideDetails : S.showDetails}
        </Button>,
      )}
      <p className="muted ws-flush">
        {S.intro({ name })}
        {summary && status?.enabled ? ` ${S.now({ summary })}` : ''}
      </p>
      {error ? (
        <div role="alert" className="ws-error">
          <p>{browserDeviceError(error, S.loadFailed)}</p>
          <Button onClick={() => setAttempt((n) => n + 1)} aria-label={S.retryBridge}>
            {S.retry}
          </Button>
        </div>
      ) : null}
      {!data && !error ? <Spinner label={S.loading} /> : null}
      {open ? (
        <div id={bodyId} className="bdv-bridge-body">
          {status ? (
            <>
              {!status.enabled ? (
                <p className="devices-unavailable" role="note">
                  <Icon name="slash" /> <span>{managed ? S.offManaged : S.offSettings}</span>
                </p>
              ) : null}
              {status.connected ? (
                <dl className="devices-facts">
                  <div>
                    <dt>{S.facts.browser}</dt>
                    <dd>{status.browser ?? S.unknown}</dd>
                  </div>
                  <div>
                    <dt>{S.facts.extension}</dt>
                    <dd>
                      {status.extensionVersion
                        ? S.extensionVersion({ version: status.extensionVersion })
                        : 'Nova'}
                    </dd>
                  </div>
                  <div>
                    <dt>{S.facts.user}</dt>
                    <dd>{status.user ?? S.unknown}</dd>
                  </div>
                  <div>
                    <dt>{S.facts.since}</dt>
                    <dd>{formatWhen(status.since)}</dd>
                  </div>
                </dl>
              ) : (
                <p className="muted ws-flush">
                  {status.since
                    ? S.notConnectedSince({ when: formatWhen(status.since), name })
                    : S.notConnected({ name })}
                </p>
              )}

              <h3 className="ws-subhead">{S.tabs}</h3>
              {status.tabs.length ? (
                <ul className="ws-list" aria-label={S.tabs}>
                  {status.tabs.map((t) => (
                    <li key={t.tabId} className="ws-list-row" aria-label={t.title || S.untitled}>
                      <div className="ws-source-main">
                        {/* Titles and hosts come from the web: text only. */}
                        <strong className="bdv-tab-title" dir="auto">
                          {t.title || S.untitled}
                        </strong>
                        <span className="muted ws-row-meta">
                          {t.host ? <code className="ws-code-inline">{t.host}</code> : null}
                          <span>{t.origin === 'shared' ? S.youShared : S.agentOpened}</span>
                          {t.user && t.user !== status.user ? (
                            <span>{S.inBrowserOf({ user: t.user })}</span>
                          ) : null}
                          <span>{S.since({ when: formatWhen(t.since) })}</span>
                        </span>
                      </div>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="muted ws-flush">{S.noTabs}</p>
              )}
              <p className="muted ws-flush">{S.banner}</p>

              <h3 className="ws-subhead">{S.sites}</h3>
              <p className="muted ws-flush">{S.sitesIntro}</p>
              {pending.length ? (
                <ul className="ws-list" aria-label={S.sitesWaiting}>
                  {pending.map(grantRow)}
                </ul>
              ) : null}
              {active.length ? (
                <ul className="ws-list" aria-label={S.sitesGranted}>
                  {active.map(grantRow)}
                </ul>
              ) : (
                <p className="muted ws-flush">{S.noSites}</p>
              )}
              <form
                className="ws-toolbar bdv-grant-form"
                onSubmit={(e) => {
                  e.preventDefault();
                  setTouched(true);
                  if (!problem) setAsk({ kind: 'grant', host: host.trim().toLowerCase() });
                }}
              >
                <TextField
                  label={S.siteField}
                  value={host}
                  placeholder={S.siteExample}
                  autoComplete="off"
                  spellCheck={false}
                  maxLength={253}
                  disabled={!enabled}
                  onChange={(e) => {
                    setHost(e.target.value);
                    setFormError(null);
                  }}
                  hint={S.siteHint}
                  error={formError ?? (touched && problem ? problem : undefined)}
                />
                <Button type="submit" disabled={!enabled}>
                  <Icon name="plus" /> {S.grant}
                </Button>
              </form>

              <h3 className="ws-subhead bdv-elevated-head">
                {S.allSites}{' '}
                <span className="ws-badge" data-tone="warn">
                  <Icon name="alert" /> {S.elevated}
                </span>
              </h3>
              <p className="muted ws-flush">{S.allSitesIntro({ name })}</p>
              {all ? (
                <ul className="ws-list" aria-label={S.allSitesGrant}>
                  {grantRow(all)}
                </ul>
              ) : null}
              {all?.state === 'active' && !status.allSitesAllowed ? (
                <p className="devices-unavailable" role="note">
                  <Icon name="slash" />{' '}
                  <span>{allManaged ? S.allNotInUseManaged : S.allNotInUseSettings}</span>
                </p>
              ) : null}
              {!all ? (
                status.allSitesAllowed && enabled ? (
                  <div className="row">
                    <Button variant="danger" onClick={() => setAsk({ kind: 'all' })}>
                      {S.grantAll}
                    </Button>
                  </div>
                ) : (
                  <p className="devices-unavailable" role="note">
                    <Icon name="slash" />{' '}
                    <span>
                      {!enabled
                        ? S.allUnavailableOff
                        : allManaged
                          ? S.allUnavailableManaged
                          : S.allUnavailableSettings}
                    </span>
                  </p>
                )
              ) : null}

              <div className="row">
                <Button aria-pressed={showRevoked} onClick={() => setShowRevoked((v) => !v)}>
                  {showRevoked ? S.hideRevoked : S.showRevoked}
                </Button>
              </div>
              {showRevoked ? (
                revoked.length ? (
                  <ul className="ws-list" aria-label={S.revokedGrants}>
                    {revoked.map(grantRow)}
                  </ul>
                ) : (
                  <p className="muted ws-flush">{S.noneRevoked}</p>
                )
              ) : null}
              <BridgeActivity deviceId={device.id} refresh={attempt} />
            </>
          ) : null}

          <div className="bdv-setup">
            <Button
              variant="ghost"
              aria-expanded={setupOpen}
              aria-controls={setupId}
              onClick={() => setSetup(!setupOpen)}
            >
              <Icon name={setupOpen ? 'down' : 'forward'} /> {S.setupOn({ name })}
            </Button>
            {setupOpen ? <SetupSteps id={setupId} name={name} /> : null}
          </div>
        </div>
      ) : null}

      {ask?.kind === 'grant' ? (
        <ConfirmAction
          title={S.grantDialog.title({ host: ask.host, name })}
          description={S.grantDialog.description({ host: ask.host, name })}
          confirmLabel={S.grantDialog.confirm({ host: ask.host })}
          onClose={() => setAsk(null)}
          onConfirm={async () => {
            try {
              await api.createBridgeGrant(device.id, {
                kind: 'host',
                host: ask.host,
                confirm: true,
              });
            } catch (err) {
              // One of the Hub's own addresses: said on the field, which keeps what was typed.
              if (err instanceof ApiError && err.body.details?.reason === 'hub_host') {
                setAsk(null);
                setFormError(browserDeviceError(err));
                return;
              }
              throw err;
            }
            setHost('');
            setTouched(false);
            done(S.grantDialog.done({ host: ask.host, name }));
          }}
        />
      ) : null}
      {ask?.kind === 'all' || (ask?.kind === 'confirm' && ask.grant.allSites) ? (
        <ConfirmAction
          title={S.allDialog.title({ name })}
          description={S.allDialog.description}
          confirmLabel={S.allDialog.confirm}
          danger
          acknowledge={S.allDialog.acknowledge({ name })}
          onClose={() => setAsk(null)}
          onConfirm={async () => {
            if (ask.kind === 'confirm')
              await api.confirmBridgeGrant(device.id, ask.grant.id, {
                confirm: true,
                acknowledgeElevatedRisk: true,
              });
            else
              await api.createBridgeGrant(device.id, {
                kind: 'all_sites',
                confirm: true,
                acknowledgeElevatedRisk: true,
              });
            done(S.allDialog.done({ name }));
          }}
        >
          <ul className="bdv-changes">
            <li>{S.allDialog.every({ name })}</li>
            <li>{S.allDialog.level}</li>
            <li>{S.allDialog.hub}</li>
            <li>{S.allDialog.revoke}</li>
          </ul>
        </ConfirmAction>
      ) : null}
      {ask?.kind === 'confirm' && !ask.grant.allSites ? (
        <ConfirmAction
          title={S.confirmDialog.title({ host: ask.grant.host, name })}
          description={S.confirmDialog.description({ host: ask.grant.host, name })}
          confirmLabel={S.confirmDialog.confirm({ host: ask.grant.host })}
          onClose={() => setAsk(null)}
          onConfirm={async () => {
            await api.confirmBridgeGrant(device.id, ask.grant.id, { confirm: true });
            done(S.grantDialog.done({ host: ask.grant.host, name }));
          }}
        />
      ) : null}
      {ask?.kind === 'revoke' ? (
        <ConfirmAction
          title={(ask.grant.state === 'pending' ? S.refuseDialog : S.revokeDialog).title({
            site: grantLabel(ask.grant),
            name,
          })}
          description={(ask.grant.state === 'pending'
            ? S.refuseDialog
            : S.revokeDialog
          ).description({ site: grantLabel(ask.grant), name })}
          confirmLabel={ask.grant.state === 'pending' ? S.refuse : S.revoke}
          danger
          onClose={() => setAsk(null)}
          onConfirm={async () => {
            await api.revokeBridgeGrant(device.id, ask.grant.id);
            done(
              (ask.grant.state === 'pending' ? S.refuseDialog : S.revokeDialog).done({
                site: grantLabel(ask.grant),
                name,
              }),
            );
          }}
        />
      ) : null}
    </section>
  );
}

/** How many recent browser audit entries are read for a device's activity. */
const AUDIT_READ = 200;
const ACTIVITY_SHOWN = 10;

/**
 * The device's recent bridge activity from the audit log: connections, a replaced connection,
 * history searches (each asked in the user's browser first) and device browser sessions the Hub
 * closed because it no longer ran them.
 */
function BridgeActivity({ deviceId, refresh }: { deviceId: string; refresh: number }) {
  const { api } = useServices();
  const [items, setItems] = useState<AuditEntryView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let alive = true;
    api.listAudit({ kind: 'browser', limit: AUDIT_READ }).then(
      (page) => {
        if (!alive) return;
        setItems(page.items.filter((e) => isDeviceActivity(e, deviceId)).slice(0, ACTIVITY_SHOWN));
        setError(null);
      },
      (err: unknown) => alive && setError(browserDeviceError(err, S.activity.loadFailed)),
    );
    return () => {
      alive = false;
    };
  }, [api, deviceId, refresh, attempt]);
  return (
    <>
      <h3 className="ws-subhead">{S.activity.title}</h3>
      <p className="muted ws-flush">{S.activity.intro}</p>
      {error ? (
        <div role="alert" className="ws-error">
          <p>{error}</p>
          <Button onClick={() => setAttempt((n) => n + 1)} aria-label={S.activity.retry}>
            {S.retry}
          </Button>
        </div>
      ) : null}
      {items === null && !error ? <Spinner label={S.activity.loading} /> : null}
      {items?.length === 0 ? <p className="muted ws-flush">{S.activity.none}</p> : null}
      {items?.length ? (
        <ul className="ws-plain-list" aria-label={S.activity.list}>
          {items.map((e) => (
            <li key={e.id}>
              {rich(S.activity.row, {
                what: bridgeAuditText(e.action) ?? e.action,
                when: <time dateTime={e.createdAt}>{formatWhen(e.createdAt)}</time>,
              })}
            </li>
          ))}
        </ul>
      ) : null}
    </>
  );
}

/** How to set up the bridge on a computer (FR-096; apps/extension/README.md). */
export function SetupSteps({ id, name }: { id: string; name: string }) {
  const code = (text: string) => <code className="ws-code-inline">{text}</code>;
  return (
    <ol id={id} className="bdv-steps">
      <li>
        <strong>{S.setup.installTitle}</strong>{' '}
        {rich(S.setup.install, {
          dist: code('apps/extension/dist'),
          build: code('npm run build -w @nova/extension'),
          name,
        })}
      </li>
      <li>
        <strong>{S.setup.idTitle}</strong>{' '}
        {rich(S.setup.id, {
          name,
          config: code('config.json'),
          dataDir: code('/var/lib/nova'),
          setting: code('"bridge": { "extensionId": "<the id>" }'),
          users: code('localRuntime.users'),
        })}
      </li>
      <li>
        <strong>{S.setup.enableTitle}</strong>{' '}
        {rich(S.setup.enable, {
          name,
          enable: code('novad bridge enable'),
          disable: code('novad bridge disable'),
        })}
      </li>
      <li>
        <strong>{S.setup.shareTitle}</strong> {S.setup.share}
      </li>
    </ol>
  );
}
