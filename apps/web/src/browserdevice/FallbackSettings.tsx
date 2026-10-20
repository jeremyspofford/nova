// Settings → Browser, M7.5 (FR-209, FR-096; docs/11 §4.3, §4.6): whether a blocked site is offered
// to continue on the agent's connected computer (`browser.localFallback`), the sites you let agents
// continue on a computer (consents per agent or chat, computer and site; each revocable, which
// also stops a session running on it), and the extension bridge's two switches
// (`browser.extensionBridge`, `browser.extensionBridgeAllSites`; managed policy can lock them).
// Hosts, shared tabs and the audit of history searches are per computer, on its page under
// Devices; history searches are asked in the user's own browser every time.
import { useEffect, useState } from 'react';
import type { BrowserFallbackConsentView } from '@nova/shared';
import { Button, Icon, Spinner, useToast } from '@nova/ui';
import { defineMessages } from '@nova/i18n';
import { rich } from '../i18n/rich.tsx';
import { chatPath } from '../router.ts';
import { agentPath } from '../agents/format.ts';
import { useAnnounce, useServices } from '../services.tsx';
import { useSettings } from '../settings.tsx';
import { formatWhen } from '../settings/common.ts';
import { SwitchField } from '../settings/controls.tsx';
import { useHubEvents } from '../spaces/events.ts';
import { useDebounced } from '../work/events.ts';
import { followLink } from '../work/nav.tsx';
import { useBrowserDeviceApi, type BrowserDeviceApi } from './api-m75.ts';
import { FALLBACK_EVENTS } from './events.ts';
import { PROFILE_TEXT, browserDeviceError } from './format.ts';
import { ConfirmAction } from './parts.tsx';
import './browserdevice.css';

const DEVICES_PATH = '/devices';

export const FALLBACK_SETTINGS_TEXT = defineMessages('browserDevice.settings', {
  loadFailed: 'Could not load the sites you agreed to.',
  saveFailed: 'Could not save: {error}',
  goneComputer: 'a computer that left',
  oneChat: 'One chat',
  anAgent: 'An agent',
  fallbackTitle: 'Continue on your computer',
  fallbackIntro:
    'When a site blocks an agent’s own browser, an agent with a connected computer can continue that site in the computer’s browser, after you agree for that site. You choose a clean profile there, or your own browser through the Nova extension. What it does there is marked in the computer’s browser actions.',
  offer: 'Offer to continue on the agent’s computer',
  offerHelp:
    'Off: a blocked site stays blocked, nothing is offered, and the sites below are not used.',
  agreed: 'Sites you agreed to',
  retry: 'Retry',
  loading: 'Loading the sites you agreed to',
  none: 'None yet. When an agent asks to continue a blocked site on your computer, your answer is remembered here.',
  sites: 'Sites agents may continue on a computer',
  siteOn: '{site} on {device}',
  forScope: 'For {scope}',
  agreedAt: 'Agreed {when}',
  lastUsed: 'Last used {when}',
  revoke: 'Revoke',
  revokeSite: 'Revoke {site} on {device}',
  showRevoked: 'Show revoked',
  hideRevoked: 'Hide revoked',
  revokedSites: 'Revoked sites',
  revokedAt: 'Revoked {when}',
  nothingRevoked: 'Nothing revoked.',
  revokeTitle: 'Revoke {site} on {device}?',
  revokeHelp:
    'The agent can no longer continue {site} in {device}’s browser without asking you again. A session running on it stops now.',
  revoked: '{site} revoked.',
  revokedToast: '{site} revoked. The agent asks again next time.',
  bridgeTitle: 'Your own browser (extension bridge)',
  bridgeIntro:
    'With the Nova extension in your browser, agents can act in tabs you share, signed in as you, on sites you grant. Cookies, passwords and tokens never leave your browser, and every change still follows the site’s level above. Sites and shared tabs are set for each computer on its page under {link}.',
  devices: 'Devices',
  bridge: 'Let agents use your own browser through the extension',
  bridgeHelp:
    'Off: the bridge refuses every call on every computer, and a blocked site is offered only with a clean profile.',
  allSites: 'Allow the “all sites” grant',
  allSitesHelp:
    'It lets agents act on any site in a tab you share, a much larger risk, and still needs its own confirmation on the computer’s page. Off: only sites granted one by one count, and an existing “all sites” grant stops working.',
  managedOff: 'Managed by your organization: the bridge is off on every computer.',
  history:
    'History searches have no standing access: each search an agent asks for opens a prompt in your browser, and nothing is read without your yes. Each computer’s page lists its recent searches.',
});
const S = FALLBACK_SETTINGS_TEXT;

/** Both M7.5 sections of Settings → Browser; nothing when the client lacks the calls. */
export function BrowserDeviceSettings() {
  const api = useBrowserDeviceApi();
  if (!api) return null;
  return (
    <>
      <FallbackSection api={api} />
      <BridgeSettingsSection />
    </>
  );
}

function useAgentNames(): Map<string, string> {
  const { api } = useServices();
  const [names, setNames] = useState<Map<string, string>>(() => new Map());
  useEffect(() => {
    let alive = true;
    Promise.resolve()
      .then(() => api.listAgents())
      .then(
        ({ items }) => alive && setNames(new Map(items.map((a) => [a.id, a.name]))),
        () => undefined,
      );
    return () => {
      alive = false;
    };
  }, [api]);
  return names;
}

function FallbackSection({ api }: { api: BrowserDeviceApi }) {
  const settings = useSettings();
  const toast = useToast();
  const announce = useAnnounce();
  const agents = useAgentNames();
  const offer = settings.get('browser.localFallback');
  const [all, setAll] = useState(false);
  const [items, setItems] = useState<BrowserFallbackConsentView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [revoking, setRevoking] = useState<BrowserFallbackConsentView | null>(null);

  useEffect(() => {
    let alive = true;
    api.listFallbackConsents({ all }).then(
      ({ items: list }) => {
        if (!alive) return;
        setItems(list);
        setError(null);
      },
      (err: unknown) => alive && setError(browserDeviceError(err, S.loadFailed)),
    );
    return () => {
      alive = false;
    };
  }, [api, all, attempt]);
  const reload = useDebounced(() => setAttempt((n) => n + 1), 200);
  useHubEvents(FALLBACK_EVENTS, () => reload());

  const fail = (err: unknown) =>
    toast.show(S.saveFailed({ error: browserDeviceError(err) }), { tone: 'error' });
  const deviceOf = (c: BrowserFallbackConsentView) => c.deviceName ?? S.goneComputer;
  const scopeOf = (c: BrowserFallbackConsentView) => {
    if (c.scopeKind === 'thread') {
      const path = chatPath(c.scopeRef);
      return (
        <a href={path} onClick={(e) => followLink(e, path)}>
          {S.oneChat}
        </a>
      );
    }
    const path = agentPath(c.scopeRef);
    return (
      <a href={path} onClick={(e) => followLink(e, path)}>
        {agents.get(c.scopeRef) ?? S.anAgent}
      </a>
    );
  };
  const active = (items ?? []).filter((c) => !c.revokedAt);
  const revoked = (items ?? []).filter((c) => c.revokedAt);

  return (
    <section className="settings-section" aria-labelledby="bdv-fallback">
      <h3 id="bdv-fallback">{S.fallbackTitle}</h3>
      <p className="muted">{S.fallbackIntro}</p>
      <SwitchField
        label={S.offer}
        description={S.offerHelp}
        checked={offer.value}
        locked={offer.locked}
        onChange={(v) => void settings.set('browser.localFallback', v).catch(fail)}
      />
      <h4 className="ws-subhead">{S.agreed}</h4>
      {error ? (
        <div className="ws-error" role="alert">
          <p>{error}</p>
          <Button onClick={() => setAttempt((n) => n + 1)}>{S.retry}</Button>
        </div>
      ) : null}
      {items === null && !error ? <Spinner label={S.loading} /> : null}
      {items && active.length === 0 ? <p className="muted">{S.none}</p> : null}
      {active.length ? (
        <ul className="ws-list" aria-label={S.sites}>
          {active.map((c) => (
            <li
              key={c.id}
              className="ws-list-row"
              aria-label={S.siteOn({ site: c.site, device: deviceOf(c) })}
            >
              <div className="ws-source-main">
                <span>
                  {rich(S.siteOn, {
                    site: <code className="ws-code-inline">{c.site}</code>,
                    device: <strong dir="auto">{deviceOf(c)}</strong>,
                  })}
                </span>
                <span className="muted ws-row-meta">
                  <span>{PROFILE_TEXT[c.profile]}</span>
                  <span>{rich(S.forScope, { scope: scopeOf(c) })}</span>
                  <span>{S.agreedAt({ when: formatWhen(c.createdAt) })}</span>
                  <span>{S.lastUsed({ when: formatWhen(c.lastUsedAt) })}</span>
                </span>
              </div>
              <Button
                variant="ghost"
                onClick={() => setRevoking(c)}
                aria-label={S.revokeSite({ site: c.site, device: deviceOf(c) })}
              >
                {S.revoke}
              </Button>
            </li>
          ))}
        </ul>
      ) : null}
      {items ? (
        <div className="row">
          <Button aria-pressed={all} onClick={() => setAll((v) => !v)}>
            {all ? S.hideRevoked : S.showRevoked}
          </Button>
        </div>
      ) : null}
      {all && revoked.length ? (
        <ul className="ws-list" aria-label={S.revokedSites}>
          {revoked.map((c) => (
            <li
              key={c.id}
              className="ws-list-row"
              aria-label={S.siteOn({ site: c.site, device: deviceOf(c) })}
            >
              <div className="ws-source-main">
                <span>
                  {rich(S.siteOn, {
                    site: <code className="ws-code-inline">{c.site}</code>,
                    device: deviceOf(c),
                  })}
                </span>
                <span className="muted ws-row-meta">
                  <span>{PROFILE_TEXT[c.profile]}</span>
                  <span>{S.revokedAt({ when: formatWhen(c.revokedAt) })}</span>
                </span>
              </div>
            </li>
          ))}
        </ul>
      ) : all && items ? (
        <p className="muted">{S.nothingRevoked}</p>
      ) : null}
      {revoking ? (
        <ConfirmAction
          title={S.revokeTitle({ site: revoking.site, device: deviceOf(revoking) })}
          description={S.revokeHelp({ site: revoking.site, device: deviceOf(revoking) })}
          confirmLabel={S.revoke}
          danger
          onClose={() => setRevoking(null)}
          onConfirm={async () => {
            await api.revokeFallbackConsent(revoking.id);
            const site = revoking.site;
            setRevoking(null);
            setItems((list) =>
              all
                ? (list ?? []).map((x) =>
                    x.id === revoking.id ? { ...x, revokedAt: new Date().toISOString() } : x,
                  )
                : (list ?? []).filter((x) => x.id !== revoking.id),
            );
            announce(S.revoked({ site }));
            toast.show(S.revokedToast({ site }), { tone: 'success' });
            setAttempt((n) => n + 1);
          }}
        />
      ) : null}
    </section>
  );
}

function BridgeSettingsSection() {
  const settings = useSettings();
  const toast = useToast();
  const bridge = settings.get('browser.extensionBridge');
  const allSites = settings.get('browser.extensionBridgeAllSites');
  const fail = (err: unknown) =>
    toast.show(S.saveFailed({ error: browserDeviceError(err) }), { tone: 'error' });
  return (
    <section className="settings-section" aria-labelledby="bdv-bridge-settings">
      <h3 id="bdv-bridge-settings">{S.bridgeTitle}</h3>
      <p className="muted">
        {rich(S.bridgeIntro, {
          link: (
            <a href={DEVICES_PATH} onClick={(e) => followLink(e, DEVICES_PATH)}>
              {S.devices}
            </a>
          ),
        })}
      </p>
      <SwitchField
        label={S.bridge}
        description={S.bridgeHelp}
        checked={bridge.value}
        locked={bridge.locked}
        onChange={(v) => void settings.set('browser.extensionBridge', v).catch(fail)}
      />
      <SwitchField
        label={S.allSites}
        description={S.allSitesHelp}
        checked={allSites.value}
        locked={allSites.locked}
        disabled={!bridge.value}
        onChange={(v) => void settings.set('browser.extensionBridgeAllSites', v).catch(fail)}
      />
      {bridge.locked && !bridge.value ? (
        <p className="ws-warning" role="note">
          <Icon name="shield" /> {S.managedOff}
        </p>
      ) : null}
      <p className="muted ws-flush">{S.history}</p>
    </section>
  );
}
