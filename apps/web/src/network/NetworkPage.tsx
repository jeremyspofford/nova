// Settings → Network (FR-102, FR-193; docs/11 §7, docs/12 §8): how sandboxes, containers and
// agent computers reach the network through the egress proxy. The access level and the allowed
// and blocked hosts for every sandbox (security settings: global only, managed policy can lock
// them), HTTPS inspection and its certificate, rules for one agent, run or session, the
// credentials the proxy adds, and the decision log. How devices reach the Hub (transports, trust,
// the Relay, Wake helpers) is the top-level Network surface (/network, M6.5), linked from here.
import { useCallback, useEffect, useId, useState } from 'react';
import type { EgressCredentialView, EgressModeView, EgressView } from '@nova/shared';
import { fmt } from '@nova/i18n';
import { Button, Icon, RadioGroup, Spinner, useToast } from '@nova/ui';
import { errorMessage } from '../api.ts';
import { useComputersApi } from '../computers/api.ts';
import { useHubEvents } from '../computers/events.ts';
import { MODE_TEXT } from '../computers/format.ts';
import { useAnnounce } from '../services.tsx';
import { useSettings } from '../settings.tsx';
import { embed } from '../settings/embed.tsx';
import { useDebounced } from '../work/events.ts';
import { followLink } from '../work/nav.tsx';
import { Credentials } from './Credentials.tsx';
import { DecisionLog } from './DecisionLog.tsx';
import { HostListEditor } from './HostListEditor.tsx';
import { ScopeRules } from './ScopeRules.tsx';
import { useScopeTargets } from './scopes.ts';
import { ACCESS_TEXT, EGRESS_TEXT as S, INSPECTION_TEXT } from './strings.ts';
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
      (err: unknown) => alive && setEgressError(errorMessage(err, S.loadError)),
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
      (err: unknown) => alive && setCredsError(errorMessage(err, S.credsLoadError)),
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
      <h2>{S.title}</h2>
      <p className="muted">{S.intro}</p>
      <p className="muted">
        {embed(S.devicesNote, {
          link: (
            <a href="/network" onClick={(e) => followLink(e, '/network')}>
              {S.networkPage}
            </a>
          ),
        })}
      </p>
      <GlobalAccess
        inspects={egress?.inspection.https ?? null}
        inForce={egress?.global.allow ?? null}
      />
      {egressError ? (
        <div role="alert" className="ws-error">
          <p>{egressError}</p>
          <Button onClick={reloadEgress}>{S.retry}</Button>
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
        <Spinner label={S.loadingRules} />
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

/**
 * The access level and host lists for every sandbox (the `network.*` settings). `inForce` is the
 * allow list the proxy uses (`GET /egress`): with a managed ceiling over the owner's own list it
 * differs from it, and the page says which hosts are reachable now (ADR-097).
 */
function GlobalAccess({
  inspects,
  inForce,
}: {
  inspects: boolean | null;
  inForce: readonly string[] | null;
}) {
  const settings = useSettings();
  const toast = useToast();
  const announce = useAnnounce();
  const headingId = useId();
  const mode = settings.get('network.egressMode');
  const allow = settings.get('network.egressAllow');
  const deny = settings.get('network.egressDeny');
  const ceiling =
    inForce !== null &&
    (inForce.length !== allow.value.length || inForce.some((h) => !allow.value.includes(h)));

  return (
    <section className="settings-section" aria-labelledby={headingId}>
      <h3 id={headingId}>{ACCESS_TEXT.heading}</h3>
      <RadioGroup
        legend={ACCESS_TEXT.legend}
        name="network-egress-mode"
        value={mode.value}
        locked={mode.locked}
        setting="network.egressMode"
        options={MODE_ORDER.map((m) => ({
          value: m,
          label: MODE_TEXT[m].label,
          description: MODE_TEXT[m].description,
        }))}
        onChange={(v) => {
          const next = MODE_ORDER.find((m) => m === v);
          if (!next) return;
          settings.set('network.egressMode', next).then(
            () => announce(ACCESS_TEXT.announced({ mode: MODE_TEXT[next].label })),
            (err: unknown) =>
              toast.show(S.couldNotSave({ error: errorMessage(err) }), { tone: 'error' }),
          );
        }}
      />
      {mode.value === 'limited' && inspects === false ? (
        <p className="ws-warning" role="note">
          <Icon name="alert" /> {ACCESS_TEXT.readOnlyBlocksHttps}
        </p>
      ) : null}
      {mode.value === 'off' ? <p className="muted ws-flush">{ACCESS_TEXT.offNote}</p> : null}
      <HostListEditor
        label={ACCESS_TEXT.allowed}
        inputLabel={ACCESS_TEXT.addAllowed}
        removeLabel={(host) => ACCESS_TEXT.removeAllowed({ host })}
        hint={ACCESS_TEXT.allowedHint}
        hosts={allow.value}
        locked={allow.locked}
        setting="network.egressAllow"
        annotate={(h) => (deny.value.includes(h) ? ACCESS_TEXT.alsoBlocked : null)}
        emptyText={
          ceiling && inForce.length ? ACCESS_TEXT.allowedNoneOwn : ACCESS_TEXT.allowedEmpty
        }
        onChange={(next) => settings.set('network.egressAllow', next)}
      />
      {ceiling ? (
        <div className="muted ws-flush" role="note" aria-label={ACCESS_TEXT.inForceLabel}>
          <p>
            {inForce.length
              ? ACCESS_TEXT.inForce({ list: fmt.list(inForce, { type: 'unit', style: 'short' }) })
              : ACCESS_TEXT.inForceNone}
          </p>
          <p>{ACCESS_TEXT.inForceWhy}</p>
        </div>
      ) : null}
      <HostListEditor
        label={ACCESS_TEXT.blocked}
        inputLabel={ACCESS_TEXT.addBlocked}
        removeLabel={(host) => ACCESS_TEXT.removeBlocked({ host })}
        hint={ACCESS_TEXT.blockedHint}
        hosts={deny.value}
        locked={deny.locked}
        setting="network.egressDeny"
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
      <h3 id={headingId}>{INSPECTION_TEXT.heading}</h3>
      {!ins ? null : ins.https ? (
        <>
          <p className="ws-ok ws-flush">
            <Icon name="check" /> {INSPECTION_TEXT.on}
          </p>
          <p className="muted ws-flush">{INSPECTION_TEXT.trusted}</p>
          {ins.caCertPem ? (
            <div>
              <a
                className="nv-btn"
                data-variant="ghost"
                href={api.egressCaUrl()}
                download="nova-egress-ca.pem"
              >
                <Icon name="download" /> {INSPECTION_TEXT.download}
              </a>
            </div>
          ) : null}
        </>
      ) : (
        <p className="ws-warning">
          <Icon name="alert" /> {INSPECTION_TEXT.off}
        </p>
      )}
    </section>
  );
}
