// Network → Setup (FR-136; docs/22 §6; docs/04 §9 flow 2 "Network setup"): the assistant. It
// detects what this computer has (interfaces, meshes and VPNs, DNS, firewall), lets the owner
// choose a mesh and its options, makes a plan (which changes nothing), then applies one step at a
// time with a one-time consent, verifies each with a reachability test and rolls back. Host
// changes are a security setting (`network.setup.allowSystemChanges`), switched here: off, Nova
// only detects and plans, and no step offers an Apply it cannot do.
import { useId, useState } from 'react';
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
  runStatusChip,
  setupRunPath,
  stepKindLabel,
  stepProviderLabel,
} from './format.ts';
import { HostChanges } from './HostChanges.tsx';
import { Chip, ConfirmDialog, Fact, LoadError, useLoad } from './parts.tsx';
import { SetupPlan } from './SetupPlan.tsx';
import { SetupRun } from './SetupRun.tsx';

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
      <p className="muted ws-flush net-first">
        Nova can set up a mesh so your devices reach the Hub from anywhere. It looks first, then
        plans the steps; nothing changes until you apply a step, and every step can be rolled back.
        Nova never needs a mesh: the LAN and the Relay always work.
      </p>
      <HostChanges />
      <Detection detection={detection.data} error={detection.error} onRetry={detection.reload} />
      <SetupPlan detection={detection.data} onPlanned={(run) => navigate(setupRunPath(run.id))} />
      <Runs />
      <Consents />
    </div>
  );
}

// ---- detection (docs/22 §6 step 1) --------------------------------------------------------------

const KIND_LABEL: Record<string, string> = {
  loopback: 'Loopback',
  lan: 'LAN',
  mesh: 'Mesh',
  vpn: 'VPN',
  other: 'Other',
};

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
        <h2 id={headingId}>What Nova finds</h2>
        <Button onClick={onRetry} disabled={!d && !error}>
          <Icon name="refresh" /> Look again
        </Button>
      </div>
      {error ? (
        <LoadError
          error={error}
          fallback="Could not look at this computer's network."
          onRetry={onRetry}
        />
      ) : null}
      {!d ? (
        error ? null : (
          <Spinner label="Looking at this computer's network" />
        )
      ) : (
        <>
          <dl className="net-facts">
            <Fact term="Platform">{d.platform}</Fact>
            <Fact term="LAN">{d.subnets.length ? d.subnets.join(', ') : 'No LAN address'}</Fact>
            <Fact term="DNS servers">
              {d.dns.nameservers.length ? d.dns.nameservers.join(', ') : 'None found'}
            </Fact>
            {d.dns.search.length ? <Fact term="DNS search">{d.dns.search.join(', ')}</Fact> : null}
            <Fact term="Firewall">
              {d.firewall.tool
                ? `${d.firewall.tool}, ${d.firewall.active === null ? 'state unknown' : d.firewall.active ? 'active' : 'inactive'}`
                : 'No firewall Nova can manage'}
            </Fact>
            <Fact term="Package manager">{d.packageManager ?? 'None found'}</Fact>
            <Fact term="Checked">{formatWhen(d.detectedAt)}</Fact>
          </dl>
          <h3 className="ws-subhead">Meshes and VPNs</h3>
          <ul className="ws-list" aria-label="Meshes found">
            {d.meshes.map((m) => (
              <li key={m.provider} className="ws-list-row" aria-label={providerLabel(m.provider)}>
                <div className="net-row-main">
                  <div className="net-row-head">
                    <span className="net-strong">{providerLabel(m.provider)}</span>
                    {!m.installed ? (
                      <Chip spec={{ text: 'Not installed', tone: 'neutral', icon: 'stop' }} />
                    ) : m.loggedIn ? (
                      <Chip spec={{ text: 'Connected', tone: 'ready', icon: 'check' }} />
                    ) : (
                      <Chip
                        spec={{
                          text: 'Installed, not connected',
                          tone: 'needs_input',
                          icon: 'alert',
                        }}
                      />
                    )}
                  </div>
                  {m.installed ? (
                    <span className="muted ws-row-meta">
                      {m.version ? <span>version {m.version}</span> : null}
                      {m.state ? <span>{m.state}</span> : null}
                      {m.controlUrl ? <span>{m.controlUrl}</span> : null}
                      {m.ips.length ? <span>{m.ips.join(', ')}</span> : null}
                      {m.dnsName ? <span>{m.dnsName}</span> : null}
                      {m.tags.length ? <span>tags {m.tags.join(', ')}</span> : null}
                      {m.peers.length ? (
                        <span>
                          {m.peers.filter((p) => p.online).length} of {m.peers.length} peers online
                        </span>
                      ) : null}
                      {m.routes.length ? <span>routes {m.routes.join(', ')}</span> : null}
                      {m.exitNode ? <span>exit node</span> : null}
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
            <summary>Network interfaces ({d.interfaces.length})</summary>
            <ul className="ws-list" aria-label="Network interfaces">
              {d.interfaces.map((i) => (
                <li key={i.name} className="ws-list-row" aria-label={i.name}>
                  <div className="net-row-main">
                    <div className="net-row-head">
                      <code className="ws-code-inline">{i.name}</code>
                      <span className="muted">
                        {KIND_LABEL[i.kind] ?? i.kind}
                        {i.provider ? `, ${providerLabel(i.provider)}` : ''}
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

// ---- run history --------------------------------------------------------------------------------

function Runs() {
  const api = useNetworkSurfaceApi();
  const headingId = useId();
  const runs = useLoad(() => api.listNetworkSetupRuns().then((r) => r.items), 'runs');
  const reload = useDebounced(runs.reload, 150);
  useNetworkEvents(SETUP_EVENTS, reload, reload);
  return (
    <section className="ws-section" aria-labelledby={headingId}>
      <h2 id={headingId}>Setup runs</h2>
      {runs.error ? (
        <LoadError
          error={runs.error}
          fallback="Could not load the setup runs."
          onRetry={runs.reload}
        />
      ) : null}
      {runs.loading ? <Spinner label="Loading setup runs" /> : null}
      {runs.data?.length === 0 ? (
        <p className="muted ws-flush">No runs yet. Make a plan above to start one.</p>
      ) : null}
      {runs.data?.length ? (
        <ul className="ws-list" aria-label="Setup runs">
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
  const name = `${providerLabel(run.provider)} setup`;
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
          <span>planned {formatWhen(run.createdAt)}</span>
          {run.updatedAt !== run.createdAt ? (
            <span>updated {formatWhen(run.updatedAt)}</span>
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
      <h2 id={headingId}>What you allowed</h2>
      <p className="muted">
        Nova asks before the first change of each kind with each tool, then remembers your answer.
        Revoke one and it asks again.
      </p>
      {list.error ? (
        <LoadError
          error={list.error}
          fallback="Could not load what you allowed."
          onRetry={list.reload}
        />
      ) : null}
      {list.loading ? <Spinner label="Loading what you allowed" /> : null}
      {list.data?.length === 0 ? <p className="muted ws-flush">Nothing yet.</p> : null}
      {list.data?.length ? (
        <ul className="ws-list" aria-label="Allowed changes">
          {list.data.map((c) => {
            const name = `${stepKindLabel(c.kind)} with ${stepProviderLabel(c.provider)}`;
            return (
              <li key={c.id} className="ws-list-row" aria-label={name}>
                <div className="net-row-main">
                  <span className="net-strong">{name}</span>
                  <span className="muted ws-row-meta">
                    <span>allowed {formatWhen(c.grantedAt)}</span>
                  </span>
                  <details className="ws-advanced">
                    <summary>What you allowed</summary>
                    <p className="net-step-desc">{c.description}</p>
                  </details>
                </div>
                <Button onClick={() => setRevoking(c)} aria-label={`Revoke ${name}`}>
                  Revoke
                </Button>
              </li>
            );
          })}
        </ul>
      ) : null}
      <ConfirmDialog
        open={revoking !== null}
        title="Revoke this permission?"
        description={
          revoking
            ? `Nova asks again before the next ${stepKindLabel(revoking.kind).toLowerCase()} change with ${stepProviderLabel(revoking.provider)}. Nothing already applied changes.`
            : undefined
        }
        confirmLabel="Revoke"
        danger
        onClose={() => setRevoking(null)}
        onConfirm={async () => {
          if (!revoking) return;
          await api.revokeNetworkSetupConsent(revoking.id);
          setRevoking(null);
          list.setData((prev) => prev?.filter((x) => x.id !== revoking.id) ?? null);
          toast.show('Permission revoked.', { tone: 'success' });
          announce('Permission revoked.');
        }}
      />
    </section>
  );
}
