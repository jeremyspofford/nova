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
import { ApiError } from '../api.ts';
import { useAnnounce, useServices } from '../services.tsx';
import { useSettings } from '../settings.tsx';
import { formatWhen, plural } from '../settings/common.ts';
import { useHubEvents } from '../spaces/events.ts';
import { isOwnerOnly } from '../team/format.ts';
import { OwnerOnlyNotice } from '../team/parts.tsx';
import { useDebounced } from '../work/events.ts';
import { useBrowserDeviceApi, type BrowserDeviceApi } from './api-m75.ts';
import { BRIDGE_EVENTS, eventDevice } from './events.ts';
import {
  BRIDGE_AUDIT_TEXT,
  GRANT_CHIP,
  browserDeviceError,
  grantLabel,
  isDeviceActivity,
  type Tone,
} from './format.ts';
import { Chip, ConfirmAction } from './parts.tsx';
import './browserdevice.css';

const HOST_HINT = 'Enter a host name such as github.com';

/** Why a host typed into the grant form is not usable, or null. */
export function hostProblem(raw: string): string | null {
  return bridgeHostSchema.safeParse(raw).success ? null : HOST_HINT;
}

/** The connection chip: off, connected, or not connected. */
export function bridgeChip(s: Pick<BrowserBridgeStatusView, 'connected' | 'enabled'>): {
  text: string;
  icon: IconName;
  tone: Tone;
} {
  if (!s.enabled) return { text: 'Turned off', icon: 'slash', tone: 'neutral' };
  return s.connected
    ? { text: 'Connected', icon: 'check', tone: 'ready' }
    : { text: 'Not connected', icon: 'slash', tone: 'neutral' };
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
        <h2 id={headingId}>Browser bridge</h2>
        {chip}
      </div>
      {toggle}
    </div>
  );

  if (isOwnerOnly(error))
    return (
      <section className="ws-section devices-flat bdv-bridge" aria-labelledby={headingId}>
        {heading(null)}
        <OwnerOnlyNotice what="Browser bridge" />
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
    ? [
        plural(status.tabs.length, 'shared tab'),
        `${plural(active.length, 'site')} granted`,
        ...(all?.state === 'active' ? ['all sites granted'] : []),
        ...(waiting ? [`${waiting} waiting for you`] : []),
      ].join(', ')
    : null;
  const problem = host.trim() ? hostProblem(host.trim()) : HOST_HINT;

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
    const chip = GRANT_CHIP[g.state];
    return (
      <li key={g.id} className="ws-list-row" aria-label={label}>
        <div className="ws-source-main">
          <span className="bdv-grant-head">
            <code className="ws-code-inline">{label}</code>
            <Chip tone={chip.tone} icon={chip.icon} text={chip.text} />
          </span>
          <span className="muted ws-row-meta">
            {g.state === 'pending' ? (
              <span>Your browser allowed the extension here {formatWhen(g.createdAt)}</span>
            ) : g.state === 'active' ? (
              <span>Confirmed {formatWhen(g.confirmedAt)}</span>
            ) : (
              <span>Revoked {formatWhen(g.revokedAt)}</span>
            )}
            {g.state === 'active' && !g.browserPermission ? (
              <span>Your browser has not allowed it yet: sharing a tab there asks</span>
            ) : null}
          </span>
        </div>
        {g.state === 'pending' ? (
          <div className="row">
            <Button
              variant="primary"
              disabled={!enabled}
              onClick={() => setAsk({ kind: 'confirm', grant: g })}
              aria-label={`Confirm ${label}`}
            >
              Confirm
            </Button>
            <Button
              variant="ghost"
              onClick={() => setAsk({ kind: 'revoke', grant: g })}
              aria-label={`Refuse ${label}`}
            >
              Refuse
            </Button>
          </div>
        ) : g.state === 'active' ? (
          <Button
            variant="ghost"
            onClick={() => setAsk({ kind: 'revoke', grant: g })}
            aria-label={`Revoke ${label}`}
          >
            Revoke
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
          <Icon name={open ? 'down' : 'forward'} /> {open ? 'Hide details' : 'Show details'}
        </Button>,
      )}
      <p className="muted ws-flush">
        Lets agents act in your own browser on {name}, through the Nova extension: only in tabs you
        share, and only on sites you grant here. The agent’s own browser is separate and never gets
        your sign-ins.
        {summary && status?.enabled ? ` Now: ${summary}.` : ''}
      </p>
      {error ? (
        <div role="alert" className="ws-error">
          <p>{browserDeviceError(error, 'Could not load the browser bridge.')}</p>
          <Button onClick={() => setAttempt((n) => n + 1)} aria-label="Retry the browser bridge">
            Retry
          </Button>
        </div>
      ) : null}
      {!data && !error ? <Spinner label="Loading the browser bridge" /> : null}
      {open ? (
        <div id={bodyId} className="bdv-bridge-body">
          {status ? (
            <>
              {!status.enabled ? (
                <p className="devices-unavailable" role="note">
                  <Icon name="slash" />{' '}
                  <span>
                    {managed
                      ? 'Turned off by your organization'
                      : 'Turned off in Settings → Browser'}
                    : nothing can act in your browser, and no site can be granted. The grants below
                    stay and count again when it is turned on.
                  </span>
                </p>
              ) : null}
              {status.connected ? (
                <dl className="devices-facts">
                  <div>
                    <dt>Browser</dt>
                    <dd>{status.browser ?? 'Unknown'}</dd>
                  </div>
                  <div>
                    <dt>Extension</dt>
                    <dd>{status.extensionVersion ? `Nova ${status.extensionVersion}` : 'Nova'}</dd>
                  </div>
                  <div>
                    <dt>User</dt>
                    <dd>{status.user ?? 'Unknown'}</dd>
                  </div>
                  <div>
                    <dt>Connected since</dt>
                    <dd>{formatWhen(status.since)}</dd>
                  </div>
                </dl>
              ) : (
                <p className="muted ws-flush">
                  Not connected{status.since ? ` since ${formatWhen(status.since)}` : ''}. The
                  extension connects when your browser runs it and the bridge is set up on {name}.
                </p>
              )}

              <h3 className="ws-subhead">Shared tabs</h3>
              {status.tabs.length ? (
                <ul className="ws-list" aria-label="Shared tabs">
                  {status.tabs.map((t) => (
                    <li
                      key={t.tabId}
                      className="ws-list-row"
                      aria-label={t.title || 'Untitled tab'}
                    >
                      <div className="ws-source-main">
                        {/* Titles and hosts come from the web: text only. */}
                        <strong className="bdv-tab-title">{t.title || 'Untitled tab'}</strong>
                        <span className="muted ws-row-meta">
                          {t.host ? <code className="ws-code-inline">{t.host}</code> : null}
                          <span>
                            {t.origin === 'shared'
                              ? 'You shared it'
                              : 'Opened by the agent in the Nova tab group'}
                          </span>
                          {t.user && t.user !== status.user ? (
                            <span>In {t.user}’s browser</span>
                          ) : null}
                          <span>Since {formatWhen(t.since)}</span>
                        </span>
                      </div>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="muted ws-flush">
                  No tab is shared. Share one with the Nova button in your browser; the agent sees
                  nothing else.
                </p>
              )}
              <p className="muted ws-flush">
                Every tab the agent controls shows the browser’s own banner and a NOVA badge. To
                stop, choose Stop sharing in the extension, cancel the banner or close the tab.
              </p>

              <h3 className="ws-subhead">Sites</h3>
              <p className="muted ws-flush">
                Agents act only on sites granted here. When your browser allows the extension on a
                site (sharing a tab there asks), the site waits here until you confirm it.
              </p>
              {pending.length ? (
                <ul className="ws-list" aria-label="Sites waiting for you">
                  {pending.map(grantRow)}
                </ul>
              ) : null}
              {active.length ? (
                <ul className="ws-list" aria-label="Granted sites">
                  {active.map(grantRow)}
                </ul>
              ) : (
                <p className="muted ws-flush">No site is granted.</p>
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
                  label="Site to grant"
                  value={host}
                  placeholder="github.com"
                  autoComplete="off"
                  spellCheck={false}
                  maxLength={253}
                  disabled={!enabled}
                  onChange={(e) => {
                    setHost(e.target.value);
                    setFormError(null);
                  }}
                  hint="An exact host name. This Hub’s own addresses are never granted: the bridge never acts on the Hub itself."
                  error={formError ?? (touched && problem ? problem : undefined)}
                />
                <Button type="submit" disabled={!enabled}>
                  <Icon name="plus" /> Grant
                </Button>
              </form>

              <h3 className="ws-subhead bdv-elevated-head">
                All sites{' '}
                <span className="ws-badge" data-tone="warn">
                  <Icon name="alert" /> Elevated risk
                </span>
              </h3>
              <p className="muted ws-flush">
                Off by default. With it, agents can act on any site in a tab you share on {name},
                signed in as you, so a page that tries to trick the agent reaches much more. Prefer
                granting sites one by one.
              </p>
              {all ? (
                <ul className="ws-list" aria-label="All sites grant">
                  {grantRow(all)}
                </ul>
              ) : null}
              {all?.state === 'active' && !status.allSitesAllowed ? (
                <p className="devices-unavailable" role="note">
                  <Icon name="slash" />{' '}
                  <span>
                    Not in use:{' '}
                    {allManaged
                      ? 'turned off by your organization.'
                      : 'the “all sites” grant is turned off in Settings → Browser.'}
                  </span>
                </p>
              ) : null}
              {!all ? (
                status.allSitesAllowed && enabled ? (
                  <div className="row">
                    <Button variant="danger" onClick={() => setAsk({ kind: 'all' })}>
                      Grant all sites…
                    </Button>
                  </div>
                ) : (
                  <p className="devices-unavailable" role="note">
                    <Icon name="slash" />{' '}
                    <span>
                      {!enabled
                        ? 'Not available while the bridge is turned off.'
                        : allManaged
                          ? 'Turned off by your organization.'
                          : 'Turned off in Settings → Browser (Allow the “all sites” grant).'}
                    </span>
                  </p>
                )
              ) : null}

              <div className="row">
                <Button aria-pressed={showRevoked} onClick={() => setShowRevoked((v) => !v)}>
                  {showRevoked ? 'Hide revoked grants' : 'Show revoked grants'}
                </Button>
              </div>
              {showRevoked ? (
                revoked.length ? (
                  <ul className="ws-list" aria-label="Revoked grants">
                    {revoked.map(grantRow)}
                  </ul>
                ) : (
                  <p className="muted ws-flush">No grant was revoked.</p>
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
              <Icon name={setupOpen ? 'down' : 'forward'} /> How to set up the bridge on {name}
            </Button>
            {setupOpen ? <SetupSteps id={setupId} name={name} /> : null}
          </div>
        </div>
      ) : null}

      {ask?.kind === 'grant' ? (
        <ConfirmAction
          title={`Grant ${ask.host} on ${name}?`}
          description={`Agents can then act on ${ask.host} in tabs you share in your browser on ${name}, signed in as you. Each change still follows the site’s level in Settings → Browser, and cookies and passwords never leave the browser.`}
          confirmLabel={`Grant ${ask.host}`}
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
            done(`${ask.host} granted on ${name}.`);
          }}
        />
      ) : null}
      {ask?.kind === 'all' || (ask?.kind === 'confirm' && ask.grant.allSites) ? (
        <ConfirmAction
          title={`Grant all sites on ${name}?`}
          description="This is the elevated grant, off by default. What changes:"
          confirmLabel="Grant all sites"
          danger
          acknowledge={`I understand that agents can then act on any site in tabs I share on ${name}.`}
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
            done(`All sites granted on ${name}.`);
          }}
        >
          <ul className="bdv-changes">
            <li>Agents may act on every site in a tab you share on {name}, signed in as you.</li>
            <li>
              Each change still follows the site’s level and asks where it must; cookies and
              passwords never leave the browser.
            </li>
            <li>It never covers this Hub’s own addresses.</li>
            <li>
              Revoke it here at any time; turning off “Allow the all sites grant” in Settings →
              Browser stops it at once.
            </li>
          </ul>
        </ConfirmAction>
      ) : null}
      {ask?.kind === 'confirm' && !ask.grant.allSites ? (
        <ConfirmAction
          title={`Confirm ${ask.grant.host} on ${name}?`}
          description={`Your browser allowed the extension on ${ask.grant.host}. Confirmed, agents can act on it in tabs you share on ${name}, signed in as you. Each change still follows the site’s level, and cookies and passwords never leave the browser.`}
          confirmLabel={`Confirm ${ask.grant.host}`}
          onClose={() => setAsk(null)}
          onConfirm={async () => {
            await api.confirmBridgeGrant(device.id, ask.grant.id, { confirm: true });
            done(`${ask.grant.host} granted on ${name}.`);
          }}
        />
      ) : null}
      {ask?.kind === 'revoke' ? (
        <ConfirmAction
          title={`${ask.grant.state === 'pending' ? 'Refuse' : 'Revoke'} ${grantLabel(ask.grant)} on ${name}?`}
          description={
            ask.grant.state === 'pending'
              ? `Agents will not act on ${grantLabel(ask.grant)} in your browser on ${name}. Your browser may still list its own permission; remove it there if you like.`
              : `Agents stop acting on ${grantLabel(ask.grant)} in your browser on ${name} at once. Grant it again here to undo.`
          }
          confirmLabel={ask.grant.state === 'pending' ? 'Refuse' : 'Revoke'}
          danger
          onClose={() => setAsk(null)}
          onConfirm={async () => {
            await api.revokeBridgeGrant(device.id, ask.grant.id);
            done(
              `${grantLabel(ask.grant)} ${ask.grant.state === 'pending' ? 'refused' : 'revoked'} on ${name}.`,
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
      (err: unknown) =>
        alive && setError(browserDeviceError(err, 'Could not load the recent activity.')),
    );
    return () => {
      alive = false;
    };
  }, [api, deviceId, refresh, attempt]);
  return (
    <>
      <h3 className="ws-subhead">Recent activity</h3>
      <p className="muted ws-flush">
        History searches have no standing access: each one asks you in your browser first.
      </p>
      {error ? (
        <div role="alert" className="ws-error">
          <p>{error}</p>
          <Button onClick={() => setAttempt((n) => n + 1)} aria-label="Retry the recent activity">
            Retry
          </Button>
        </div>
      ) : null}
      {items === null && !error ? <Spinner label="Loading the recent activity" /> : null}
      {items?.length === 0 ? (
        <p className="muted ws-flush">
          Nothing yet. Connections, history searches and sessions the Hub closed show here.
        </p>
      ) : null}
      {items?.length ? (
        <ul className="ws-plain-list" aria-label="Recent bridge activity">
          {items.map((e) => (
            <li key={e.id}>
              {BRIDGE_AUDIT_TEXT[e.action]},{' '}
              <time dateTime={e.createdAt}>{formatWhen(e.createdAt)}</time>
            </li>
          ))}
        </ul>
      ) : null}
    </>
  );
}

/** How to set up the bridge on a computer (FR-096; apps/extension/README.md). */
export function SetupSteps({ id, name }: { id: string; name: string }) {
  return (
    <ol id={id} className="bdv-steps">
      <li>
        <strong>Install the extension.</strong> For now it is the unpacked build in{' '}
        <code className="ws-code-inline">apps/extension/dist</code> of Nova’s source (
        <code className="ws-code-inline">npm run build -w @nova/extension</code> makes it). In a
        Chromium-based browser on {name}, open the extensions page, turn on Developer mode, choose
        Load unpacked and pick that folder. Note the extension’s id it shows.
      </li>
      <li>
        <strong>Tell novad the extension’s id.</strong> On {name}, in novad’s{' '}
        <code className="ws-code-inline">config.json</code> (in its data folder,{' '}
        <code className="ws-code-inline">/var/lib/nova</code> by default), set{' '}
        <code className="ws-code-inline">{'"bridge": { "extensionId": "<the id>" }'}</code> and make
        sure your user name is in <code className="ws-code-inline">localRuntime.users</code>. Then
        restart novad. Its browser module must be on (Modules tab).
      </li>
      <li>
        <strong>Enable the bridge for yourself.</strong> On {name}, as yourself and not as root, run{' '}
        <code className="ws-code-inline">novad bridge enable</code>. It registers the extension’s
        helper for your own browsers only;{' '}
        <code className="ws-code-inline">novad bridge disable</code> removes it.
      </li>
      <li>
        <strong>Share a tab.</strong> Use the Nova button in your browser. The tab shows here, and
        its site waits under Sites for your confirmation.
      </li>
    </ol>
  );
}
