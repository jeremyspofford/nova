// Settings → Network (FR-102, FR-193; docs/11 §7, docs/12 §8): how sandboxes, containers and
// agent computers reach the network through the egress proxy. The access level and the allowed
// and blocked hosts for every sandbox (security settings: global only, managed policy can lock
// them), HTTPS inspection and its certificate, rules for one agent, run or session, the
// credentials the proxy adds, and the decision log. How devices reach the Hub (transports, trust,
// the Relay, Wake helpers) is the top-level Network surface (/network, M6.5), linked from here.
import { useCallback, useEffect, useId, useState } from 'react';
import type { EgressCredentialView, EgressModeView, EgressView } from '@nova/shared';
import { Button, Icon, RadioGroup, Spinner, useToast } from '@nova/ui';
import { errorMessage } from '../api.ts';
import { useComputersApi } from '../computers/api.ts';
import { useHubEvents } from '../computers/events.ts';
import { MODE_TEXT } from '../computers/format.ts';
import { useAnnounce } from '../services.tsx';
import { useSettings } from '../settings.tsx';
import { useDebounced } from '../work/events.ts';
import { followLink } from '../work/nav.tsx';
import { Credentials } from './Credentials.tsx';
import { DecisionLog } from './DecisionLog.tsx';
import { HostListEditor } from './HostListEditor.tsx';
import { ScopeRules } from './ScopeRules.tsx';
import { useScopeTargets } from './scopes.ts';
import '../workspace.css';
import '../computers/computers.css';

const MODE_ORDER: EgressModeView[] = ['allowlist', 'limited', 'off'];

export function NetworkPage() {
  const api = useComputersApi();
  const { targets, label } = useScopeTargets();
  const [egress, setEgress] = useState<EgressView | null>(null);
  const [egressError, setEgressError] = useState<string | null>(null);
  const [creds, setCreds] = useState<EgressCredentialView[] | null>(null);
  const [credsError, setCredsError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [credAttempt, setCredAttempt] = useState(0);

  useEffect(() => {
    let alive = true;
    api.getEgress().then(
      (v) => {
        if (!alive) return;
        setEgress(v);
        setEgressError(null);
      },
      (err: unknown) =>
        alive && setEgressError(errorMessage(err, 'Could not load the network rules.')),
    );
    return () => {
      alive = false;
    };
  }, [api, attempt]);

  useEffect(() => {
    let alive = true;
    api.listEgressCredentials().then(
      ({ items }) => {
        if (!alive) return;
        setCreds(items);
        setCredsError(null);
      },
      (err: unknown) =>
        alive && setCredsError(errorMessage(err, 'Could not load the credentials.')),
    );
    return () => {
      alive = false;
    };
  }, [api, credAttempt]);

  const reloadEgress = useCallback(() => setAttempt((n) => n + 1), []);
  const reload = useDebounced(reloadEgress, 150);
  useHubEvents(['egress.policy.changed'], () => reload());

  return (
    <div className="settings-page network-page">
      <h2>Network</h2>
      <p className="muted">
        Sandboxes, containers and agent computers reach the network only through Nova&apos;s egress
        proxy. These rules decide where they can go; every request is logged below.
      </p>
      <p className="muted">
        How your devices reach this Hub (transports, certificates, the Relay and Wake helpers) is on
        the{' '}
        <a href="/network" onClick={(e) => followLink(e, '/network')}>
          Network page
        </a>
        .
      </p>
      <GlobalAccess inspects={egress?.inspection.https ?? null} />
      {egressError ? (
        <div role="alert" className="ws-error">
          <p>{egressError}</p>
          <Button onClick={reloadEgress}>Retry</Button>
        </div>
      ) : null}
      <Inspection egress={egress} />
      {egress ? (
        <ScopeRules
          scopes={egress.scopes}
          globalMode={egress.global.mode}
          targets={targets}
          label={label}
          onChanged={reloadEgress}
        />
      ) : egressError ? null : (
        <Spinner label="Loading the network rules" />
      )}
      <Credentials
        items={creds}
        error={credsError}
        inspects={egress?.inspection.https ?? null}
        targets={targets}
        label={label}
        onRetry={() => setCredAttempt((n) => n + 1)}
        onChanged={() => setCredAttempt((n) => n + 1)}
      />
      <DecisionLog scopes={egress?.scopes ?? []} label={label} onPolicyChanged={reloadEgress} />
    </div>
  );
}

/** The access level and host lists for every sandbox (the `network.*` settings). */
function GlobalAccess({ inspects }: { inspects: boolean | null }) {
  const settings = useSettings();
  const toast = useToast();
  const announce = useAnnounce();
  const headingId = useId();
  const mode = settings.get('network.egressMode');
  const allow = settings.get('network.egressAllow');
  const deny = settings.get('network.egressDeny');

  return (
    <section className="settings-section" aria-labelledby={headingId}>
      <h3 id={headingId}>Access for every sandbox</h3>
      <RadioGroup
        legend="Network access"
        name="network-egress-mode"
        value={mode.value}
        locked={mode.locked}
        options={MODE_ORDER.map((m) => ({
          value: m,
          label: MODE_TEXT[m].label,
          description: MODE_TEXT[m].description,
        }))}
        onChange={(v) => {
          const next = MODE_ORDER.find((m) => m === v);
          if (!next) return;
          settings.set('network.egressMode', next).then(
            () => announce(`Network access: ${MODE_TEXT[next].label}.`),
            (err: unknown) => toast.show(`Could not save: ${errorMessage(err)}`, { tone: 'error' }),
          );
        }}
      />
      {mode.value === 'limited' && inspects === false ? (
        <p className="ws-warning" role="note">
          <Icon name="alert" /> HTTPS inspection is not set up on this Hub, so read-only access
          blocks every HTTPS request.
        </p>
      ) : null}
      {mode.value === 'off' ? (
        <p className="muted ws-flush">The host lists below apply when network access is on.</p>
      ) : null}
      <HostListEditor
        label="Allowed hosts"
        inputLabel="Add an allowed host"
        hint="A host name or IP address. Use *.example.com for its subdomains; a bare * is not allowed."
        hosts={allow.value}
        locked={allow.locked}
        annotate={(h) => (deny.value.includes(h) ? 'Also blocked: blocking wins' : null)}
        emptyText="None yet: sandboxes cannot reach any host."
        onChange={(next) => settings.set('network.egressAllow', next)}
      />
      <HostListEditor
        label="Blocked hosts"
        inputLabel="Add a blocked host"
        hint="Always blocked, even when the host is also allowed here or in a rule."
        hosts={deny.value}
        locked={deny.locked}
        onChange={(next) => settings.set('network.egressDeny', next)}
      />
    </section>
  );
}

/** Whether the proxy can inspect HTTPS (the per-Hub certificate), and the certificate itself. */
function Inspection({ egress }: { egress: EgressView | null }) {
  const api = useComputersApi();
  const headingId = useId();
  const ins = egress?.inspection;
  return (
    <section className="settings-section" aria-labelledby={headingId}>
      <h3 id={headingId}>HTTPS inspection</h3>
      {!ins ? null : ins.https ? (
        <>
          <p className="ws-ok ws-flush">
            <Icon name="check" /> On. The proxy can check HTTPS requests and add credentials to
            them.
          </p>
          <p className="muted ws-flush">
            Commands in sandboxes already trust this Hub&apos;s inspection certificate. Download it
            to check it, or to trust it in another tool you route through the proxy.
          </p>
          {ins.caCertPem ? (
            <div>
              <a
                className="nv-btn"
                data-variant="ghost"
                href={api.egressCaUrl()}
                download="nova-egress-ca.pem"
              >
                <Icon name="download" /> Download the certificate
              </a>
            </div>
          ) : null}
        </>
      ) : (
        <p className="ws-warning">
          <Icon name="alert" /> Off. This Hub has no inspection certificate, so read-only access
          blocks HTTPS and credentials are added to plain HTTP requests only.
        </p>
      )}
    </section>
  );
}
