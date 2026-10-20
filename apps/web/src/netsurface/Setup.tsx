// Network → Setup (FR-136; docs/22 §6; docs/04 §9 flow 2 "Network setup"): the assistant. It
// detects what this computer has (interfaces, meshes and VPNs, DNS, firewall), lets the owner
// choose a mesh and its options, makes a plan (which changes nothing), then applies one step at a
// time with a one-time consent, verifies each with a reachability test and rolls back. Host
// changes are a security setting (`network.setup.allowSystemChanges`), switched here: off, Nova
// only detects and plans, and no step offers an Apply it cannot do.
import { useId, useState } from 'react';
import { defineMessages, messageFor } from '@nova/i18n';
import type {
  NetworkDetectionView,
  NetworkSetupConsentView,
  NetworkSetupRunView,
} from '@nova/shared';
import { Button, Icon, Spinner, useToast } from '@nova/ui';
import { formatWhen } from '../settings/common.ts';
import { navigate, useLocation } from '../router.ts';
import { useAnnounce } from '../services.tsx';
import { followLink } from '../work/nav.tsx';
import { useDebounced } from '../work/events.ts';
import { useNetworkSurfaceApi } from './api.ts';
import { SETUP_EVENTS, useNetworkEvents } from './events.ts';
import {
  progressText,
  providerLabel,
  runFrom,
  runName,
  runStatusChip,
  setupRunPath,
  stepKindLabel,
  stepProviderLabel,
  valuesText,
} from './format.ts';
import { HostChanges } from './HostChanges.tsx';
import { Chip, ConfirmDialog, Fact, LoadError, useLoad } from './parts.tsx';
import { SetupPlan } from './SetupPlan.tsx';
import { SetupRun } from './SetupRun.tsx';

const S = defineMessages('netsurface.setup', {
  intro:
    'Nova can set up a mesh so your devices reach the Hub from anywhere. It looks first, then plans the steps; nothing changes until you apply a step, and every step can be rolled back. ' +
    'Nova never needs a mesh: the LAN and the Relay always work.',
  kind: { loopback: 'Loopback', lan: 'LAN', mesh: 'Mesh', vpn: 'VPN', other: 'Other' },
  detection: {
    title: 'What Nova finds',
    lookAgain: 'Look again',
    failed: "Could not look at this computer's network.",
    looking: "Looking at this computer's network",
    platform: 'Platform',
    lan: 'LAN',
    noLan: 'No LAN address',
    dns: 'DNS servers',
    noneFound: 'None found',
    dnsSearch: 'DNS search',
    firewall: 'Firewall',
    firewallState:
      '{tool}, {state, select, active {active} inactive {inactive} other {state unknown}}',
    noFirewall: 'No firewall Nova can manage',
    packageManager: 'Package manager',
    checked: 'Checked',
    meshes: 'Meshes and VPNs',
    meshesList: 'Meshes found',
    notInstalled: 'Not installed',
    connected: 'Connected',
    notConnected: 'Installed, not connected',
    version: 'version {version}',
    tags: 'tags {tags}',
    peers: '{online} of {total, plural, one {# peer} other {# peers}} online',
    routes: 'routes {routes}',
    exitNode: 'exit node',
    interfaces: 'Network interfaces ({n})',
    interfacesList: 'Network interfaces',
    kindProvider: '{kind}, {provider}',
  },
  runs: {
    title: 'Setup runs',
    failed: 'Could not load the setup runs.',
    loading: 'Loading setup runs',
    none: 'No runs yet. Make a plan above to start one.',
    planned: 'planned {when}',
    updated: 'updated {when}',
  },
  consents: {
    title: 'What you allowed',
    help: 'Nova asks before the first change of each kind with each tool, then remembers your answer. Revoke one and it asks again.',
    failed: 'Could not load what you allowed.',
    loading: 'Loading what you allowed',
    none: 'Nothing yet.',
    list: 'Allowed changes',
    name: '{kind} with {provider}',
    allowed: 'allowed {when}',
    revoke: 'Revoke',
    revokeName: 'Revoke {name}',
    revokeTitle: 'Revoke this permission?',
    revokeText:
      'Nova asks again before it next makes this kind of change ({kind}) with {provider}. Nothing already applied changes.',
    revoked: 'Permission revoked.',
  },
});

export function SetupSection() {
  const loc = useLocation();
  const runId = runFrom(loc.includes('?') ? loc.slice(loc.indexOf('?')) : '');
  return runId ? <SetupRun key={runId} runId={runId} /> : <SetupHome />;
}

function SetupHome() {
  const api = useNetworkSurfaceApi();
  const detection = useLoad(() => api.detectNetwork().then((r) => r.detection), 'detect');
  return (
    <div className="stack net-section">
      <p className="muted ws-flush net-first">{S.intro}</p>
      <HostChanges />
      <Detection detection={detection.data} error={detection.error} onRetry={detection.reload} />
      <SetupPlan detection={detection.data} onPlanned={(run) => navigate(setupRunPath(run.id))} />
      <Runs />
      <Consents />
    </div>
  );
}

// ---- detection (docs/22 §6 step 1) --------------------------------------------------------------

function Detection({
  detection,
  error,
  onRetry,
}: {
  detection: NetworkDetectionView | null;
  error: unknown;
  onRetry: () => void;
}) {
  const headingId = useId();
  const d = detection;
  return (
    <section className="ws-section" aria-labelledby={headingId}>
      <div className="ws-section-header">
        <h2 id={headingId}>{S.detection.title}</h2>
        <Button onClick={onRetry} disabled={!d && !error}>
          <Icon name="refresh" /> {S.detection.lookAgain}
        </Button>
      </div>
      {error ? <LoadError error={error} fallback={S.detection.failed} onRetry={onRetry} /> : null}
      {!d ? (
        error ? null : (
          <Spinner label={S.detection.looking} />
        )
      ) : (
        <>
          <dl className="net-facts">
            <Fact term={S.detection.platform}>{d.platform}</Fact>
            <Fact term={S.detection.lan}>
              {d.subnets.length ? valuesText(d.subnets) : S.detection.noLan}
            </Fact>
            <Fact term={S.detection.dns}>
              {d.dns.nameservers.length ? valuesText(d.dns.nameservers) : S.detection.noneFound}
            </Fact>
            {d.dns.search.length ? (
              <Fact term={S.detection.dnsSearch}>{valuesText(d.dns.search)}</Fact>
            ) : null}
            <Fact term={S.detection.firewall}>
              {d.firewall.tool
                ? S.detection.firewallState({
                    tool: d.firewall.tool,
                    state:
                      d.firewall.active === null
                        ? 'unknown'
                        : d.firewall.active
                          ? 'active'
                          : 'inactive',
                  })
                : S.detection.noFirewall}
            </Fact>
            <Fact term={S.detection.packageManager}>
              {d.packageManager ?? S.detection.noneFound}
            </Fact>
            <Fact term={S.detection.checked}>{formatWhen(d.detectedAt)}</Fact>
          </dl>
          <h3 className="ws-subhead">{S.detection.meshes}</h3>
          <ul className="ws-list" aria-label={S.detection.meshesList}>
            {d.meshes.map((m) => (
              <li key={m.provider} className="ws-list-row" aria-label={providerLabel(m.provider)}>
                <div className="net-row-main">
                  <div className="net-row-head">
                    <span className="net-strong">{providerLabel(m.provider)}</span>
                    {!m.installed ? (
                      <Chip
                        spec={{ text: S.detection.notInstalled, tone: 'neutral', icon: 'stop' }}
                      />
                    ) : m.loggedIn ? (
                      <Chip spec={{ text: S.detection.connected, tone: 'ready', icon: 'check' }} />
                    ) : (
                      <Chip
                        spec={{
                          text: S.detection.notConnected,
                          tone: 'needs_input',
                          icon: 'alert',
                        }}
                      />
                    )}
                  </div>
                  {m.installed ? (
                    <span className="muted ws-row-meta">
                      {m.version ? (
                        <span>{S.detection.version({ version: m.version })}</span>
                      ) : null}
                      {m.state ? <span>{m.state}</span> : null}
                      {m.controlUrl ? <span>{m.controlUrl}</span> : null}
                      {m.ips.length ? <span>{valuesText(m.ips)}</span> : null}
                      {m.dnsName ? <span>{m.dnsName}</span> : null}
                      {m.tags.length ? (
                        <span>{S.detection.tags({ tags: valuesText(m.tags) })}</span>
                      ) : null}
                      {m.peers.length ? (
                        <span>
                          {S.detection.peers({
                            online: m.peers.filter((p) => p.online).length,
                            total: m.peers.length,
                          })}
                        </span>
                      ) : null}
                      {m.routes.length ? (
                        <span>{S.detection.routes({ routes: valuesText(m.routes) })}</span>
                      ) : null}
                      {m.exitNode ? <span>{S.detection.exitNode}</span> : null}
                    </span>
                  ) : null}
                  {m.installed && m.detail ? (
                    <span className="muted net-small">{m.detail}</span>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
          <details className="ws-advanced">
            <summary>{S.detection.interfaces({ n: d.interfaces.length })}</summary>
            <ul className="ws-list" aria-label={S.detection.interfacesList}>
              {d.interfaces.map((i) => (
                <li key={i.name} className="ws-list-row" aria-label={i.name}>
                  <div className="net-row-main">
                    <div className="net-row-head">
                      <code className="ws-code-inline">{i.name}</code>
                      <span className="muted">
                        {i.provider
                          ? S.detection.kindProvider({
                              kind: interfaceKind(i.kind),
                              provider: providerLabel(i.provider),
                            })
                          : interfaceKind(i.kind)}
                      </span>
                    </div>
                    <span className="muted ws-row-meta">
                      {i.addresses.map((a) => (
                        <span key={a.address}>{a.cidr ?? a.address}</span>
                      ))}
                    </span>
                  </div>
                </li>
              ))}
            </ul>
          </details>
        </>
      )}
    </section>
  );
}

/** An interface's kind in words; a kind the Hub adds later keeps its id. */
const interfaceKind = (k: string): string => messageFor(S.kind, k) ?? k;

// ---- run history --------------------------------------------------------------------------------

function Runs() {
  const api = useNetworkSurfaceApi();
  const headingId = useId();
  const runs = useLoad(() => api.listNetworkSetupRuns().then((r) => r.items), 'runs');
  const reload = useDebounced(runs.reload, 150);
  useNetworkEvents(SETUP_EVENTS, reload, reload);
  return (
    <section className="ws-section" aria-labelledby={headingId}>
      <h2 id={headingId}>{S.runs.title}</h2>
      {runs.error ? (
        <LoadError error={runs.error} fallback={S.runs.failed} onRetry={runs.reload} />
      ) : null}
      {runs.loading ? <Spinner label={S.runs.loading} /> : null}
      {runs.data?.length === 0 ? <p className="muted ws-flush">{S.runs.none}</p> : null}
      {runs.data?.length ? (
        <ul className="ws-list" aria-label={S.runs.title}>
          {runs.data.map((r) => (
            <RunRow key={r.id} run={r} />
          ))}
        </ul>
      ) : null}
    </section>
  );
}

function RunRow({ run }: { run: NetworkSetupRunView }) {
  const path = setupRunPath(run.id);
  const name = runName(run.provider);
  return (
    <li className="ws-list-row" aria-label={name}>
      <div className="net-row-main">
        <div className="net-row-head">
          <a href={path} className="ws-card-link" onClick={(e) => followLink(e, path)}>
            {name}
          </a>
          <Chip spec={runStatusChip(run.status)} />
        </div>
        <span className="muted ws-row-meta">
          <span>{progressText(run)}</span>
          <span>{S.runs.planned({ when: formatWhen(run.createdAt) })}</span>
          {run.updatedAt !== run.createdAt ? (
            <span>{S.runs.updated({ when: formatWhen(run.updatedAt) })}</span>
          ) : null}
        </span>
      </div>
    </li>
  );
}

// ---- remembered consents --------------------------------------------------------------------------

function Consents() {
  const api = useNetworkSurfaceApi();
  const toast = useToast();
  const announce = useAnnounce();
  const headingId = useId();
  const list = useLoad(() => api.listNetworkSetupConsents().then((r) => r.items), 'consents');
  const reload = useDebounced(list.reload, 150);
  useNetworkEvents(SETUP_EVENTS, reload, reload);
  const [revoking, setRevoking] = useState<NetworkSetupConsentView | null>(null);
  return (
    <section className="ws-section" aria-labelledby={headingId}>
      <h2 id={headingId}>{S.consents.title}</h2>
      <p className="muted">{S.consents.help}</p>
      {list.error ? (
        <LoadError error={list.error} fallback={S.consents.failed} onRetry={list.reload} />
      ) : null}
      {list.loading ? <Spinner label={S.consents.loading} /> : null}
      {list.data?.length === 0 ? <p className="muted ws-flush">{S.consents.none}</p> : null}
      {list.data?.length ? (
        <ul className="ws-list" aria-label={S.consents.list}>
          {list.data.map((c) => {
            const name = S.consents.name({
              kind: stepKindLabel(c.kind),
              provider: stepProviderLabel(c.provider),
            });
            return (
              <li key={c.id} className="ws-list-row" aria-label={name}>
                <div className="net-row-main">
                  <span className="net-strong">{name}</span>
                  <span className="muted ws-row-meta">
                    <span>{S.consents.allowed({ when: formatWhen(c.grantedAt) })}</span>
                  </span>
                  <details className="ws-advanced">
                    <summary>{S.consents.title}</summary>
                    <p className="net-step-desc" dir="auto">
                      {c.description}
                    </p>
                  </details>
                </div>
                <Button onClick={() => setRevoking(c)} aria-label={S.consents.revokeName({ name })}>
                  {S.consents.revoke}
                </Button>
              </li>
            );
          })}
        </ul>
      ) : null}
      <ConfirmDialog
        open={revoking !== null}
        title={S.consents.revokeTitle}
        description={
          revoking
            ? S.consents.revokeText({
                kind: stepKindLabel(revoking.kind),
                provider: stepProviderLabel(revoking.provider),
              })
            : undefined
        }
        confirmLabel={S.consents.revoke}
        danger
        onClose={() => setRevoking(null)}
        onConfirm={async () => {
          if (!revoking) return;
          await api.revokeNetworkSetupConsent(revoking.id);
          setRevoking(null);
          list.setData((prev) => prev?.filter((x) => x.id !== revoking.id) ?? null);
          toast.show(S.consents.revoked, { tone: 'success' });
          announce(S.consents.revoked);
        }}
      />
    </section>
  );
}
