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
import { chatPath } from '../router.ts';
import { agentPath } from '../agents/format.ts';
import { useAnnounce, useServices } from '../services.tsx';
import { useSettings } from '../settings.tsx';
import { MANAGED, formatWhen } from '../settings/common.ts';
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
      (err: unknown) =>
        alive && setError(browserDeviceError(err, 'Could not load the sites you agreed to.')),
    );
    return () => {
      alive = false;
    };
  }, [api, all, attempt]);
  const reload = useDebounced(() => setAttempt((n) => n + 1), 200);
  useHubEvents(FALLBACK_EVENTS, () => reload());

  const fail = (err: unknown) =>
    toast.show(`Could not save: ${browserDeviceError(err)}`, { tone: 'error' });
  const deviceOf = (c: BrowserFallbackConsentView) => c.deviceName ?? 'a computer that left';
  const scopeOf = (c: BrowserFallbackConsentView) => {
    if (c.scopeKind === 'thread') {
      const path = chatPath(c.scopeRef);
      return (
        <a href={path} onClick={(e) => followLink(e, path)}>
          One chat
        </a>
      );
    }
    const path = agentPath(c.scopeRef);
    return (
      <a href={path} onClick={(e) => followLink(e, path)}>
        {agents.get(c.scopeRef) ?? 'An agent'}
      </a>
    );
  };
  const active = (items ?? []).filter((c) => !c.revokedAt);
  const revoked = (items ?? []).filter((c) => c.revokedAt);

  return (
    <section className="settings-section" aria-labelledby="bdv-fallback">
      <h3 id="bdv-fallback">Continue on your computer</h3>
      <p className="muted">
        When a site blocks an agent’s own browser, an agent with a connected computer can continue
        that site in the computer’s browser, after you agree for that site. You choose a clean
        profile there, or your own browser through the Nova extension. What it does there is marked
        in the computer’s browser actions.
      </p>
      <SwitchField
        label="Offer to continue on the agent’s computer"
        description="Off: a blocked site stays blocked, nothing is offered, and the sites below are not used."
        checked={offer.value}
        locked={offer.locked}
        onChange={(v) => void settings.set('browser.localFallback', v).catch(fail)}
      />
      <h4 className="ws-subhead">Sites you agreed to</h4>
      {error ? (
        <div className="ws-error" role="alert">
          <p>{error}</p>
          <Button onClick={() => setAttempt((n) => n + 1)}>Retry</Button>
        </div>
      ) : null}
      {items === null && !error ? <Spinner label="Loading the sites you agreed to" /> : null}
      {items && active.length === 0 ? (
        <p className="muted">
          None yet. When an agent asks to continue a blocked site on your computer, your answer is
          remembered here.
        </p>
      ) : null}
      {active.length ? (
        <ul className="ws-list" aria-label="Sites agents may continue on a computer">
          {active.map((c) => (
            <li key={c.id} className="ws-list-row" aria-label={`${c.site} on ${deviceOf(c)}`}>
              <div className="ws-source-main">
                <span>
                  <code className="ws-code-inline">{c.site}</code> on <strong>{deviceOf(c)}</strong>
                </span>
                <span className="muted ws-row-meta">
                  <span>{PROFILE_TEXT[c.profile]}</span>
                  <span>For {scopeOf(c)}</span>
                  <span>Agreed {formatWhen(c.createdAt)}</span>
                  <span>Last used {formatWhen(c.lastUsedAt)}</span>
                </span>
              </div>
              <Button
                variant="ghost"
                onClick={() => setRevoking(c)}
                aria-label={`Revoke ${c.site} on ${deviceOf(c)}`}
              >
                Revoke
              </Button>
            </li>
          ))}
        </ul>
      ) : null}
      {items ? (
        <div className="row">
          <Button aria-pressed={all} onClick={() => setAll((v) => !v)}>
            {all ? 'Hide revoked' : 'Show revoked'}
          </Button>
        </div>
      ) : null}
      {all && revoked.length ? (
        <ul className="ws-list" aria-label="Revoked sites">
          {revoked.map((c) => (
            <li key={c.id} className="ws-list-row" aria-label={`${c.site} on ${deviceOf(c)}`}>
              <div className="ws-source-main">
                <span>
                  <code className="ws-code-inline">{c.site}</code> on {deviceOf(c)}
                </span>
                <span className="muted ws-row-meta">
                  <span>{PROFILE_TEXT[c.profile]}</span>
                  <span>Revoked {formatWhen(c.revokedAt)}</span>
                </span>
              </div>
            </li>
          ))}
        </ul>
      ) : all && items ? (
        <p className="muted">Nothing revoked.</p>
      ) : null}
      {revoking ? (
        <ConfirmAction
          title={`Revoke ${revoking.site} on ${deviceOf(revoking)}?`}
          description={`The agent can no longer continue ${revoking.site} in ${deviceOf(revoking)}’s browser without asking you again. A session running on it stops now.`}
          confirmLabel="Revoke"
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
            announce(`${site} revoked.`);
            toast.show(`${site} revoked. The agent asks again next time.`, { tone: 'success' });
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
    toast.show(`Could not save: ${browserDeviceError(err)}`, { tone: 'error' });
  return (
    <section className="settings-section" aria-labelledby="bdv-bridge-settings">
      <h3 id="bdv-bridge-settings">Your own browser (extension bridge)</h3>
      <p className="muted">
        With the Nova extension in your browser, agents can act in tabs you share, signed in as you,
        on sites you grant. Cookies, passwords and tokens never leave your browser, and every change
        still follows the site’s level above. Sites and shared tabs are set for each computer on its
        page under{' '}
        <a href={DEVICES_PATH} onClick={(e) => followLink(e, DEVICES_PATH)}>
          Devices
        </a>
        .
      </p>
      <SwitchField
        label="Let agents use your own browser through the extension"
        description="Off: the bridge refuses every call on every computer, and a blocked site is offered only with a clean profile."
        checked={bridge.value}
        locked={bridge.locked}
        onChange={(v) => void settings.set('browser.extensionBridge', v).catch(fail)}
      />
      <SwitchField
        label="Allow the “all sites” grant"
        description="It lets agents act on any site in a tab you share, a much larger risk, and still needs its own confirmation on the computer’s page. Off: only sites granted one by one count, and an existing “all sites” grant stops working."
        checked={allSites.value}
        locked={allSites.locked}
        disabled={!bridge.value}
        onChange={(v) => void settings.set('browser.extensionBridgeAllSites', v).catch(fail)}
      />
      {bridge.locked && !bridge.value ? (
        <p className="ws-warning" role="note">
          <Icon name="shield" /> {MANAGED}: the bridge is off on every computer.
        </p>
      ) : null}
      <p className="muted ws-flush">
        History searches have no standing access: each search an agent asks for opens a prompt in
        your browser, and nothing is read without your yes. Each computer’s page lists its recent
        searches.
      </p>
    </section>
  );
}
