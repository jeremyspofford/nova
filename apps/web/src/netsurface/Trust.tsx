// Network → Trust (FR-134; docs/22 §5): how browsers and apps trust this Hub over HTTPS. The
// mode (Hub local CA, mesh certificates or none) with what each means, the notice when it applies
// only after a restart, the Hub's identity pin, the CA's fingerprint and its root to download with
// install hints for each platform, the Hub certificate's names and expiry, the mesh certificate,
// renewal, every certificate issued and the problems the Hub reports.
import { useId, useState } from 'react';
import { defineMessages, fmt } from '@nova/i18n';
import { TRUST_MODES, type TrustCertificateView, type TrustView } from '@nova/shared';
import { Button, Icon, RadioGroup, Spinner, useToast } from '@nova/ui';
import { formatWhen } from '../settings/common.ts';
import { embed } from '../settings/embed.tsx';
import { SwitchField } from '../settings/controls.tsx';
import { useAnnounce } from '../services.tsx';
import { useDebounced } from '../work/events.ts';
import { useNetworkSurfaceApi, type TrustPatchBody } from './api.ts';
import { TRUST_EVENTS, useNetworkEvents } from './events.ts';
import {
  certKindLabel,
  installHints,
  meshCertChip,
  netErrorMessage,
  trustModeInfo,
  valuesText,
} from './format.ts';
import { Chip, CopyButton, Fact, LoadError, useLoad } from './parts.tsx';

const S = defineMessages('netsurface.trust', {
  loadFailed: 'Could not load the certificates.',
  loading: 'Loading the certificates',
  refreshFailed: 'Could not refresh the certificates.',
  serving: {
    unknown: 'The Hub has not reported how it serves yet.',
    http: 'The Hub serves plain HTTP now.',
    explicit:
      'The Hub serves HTTPS with the certificate set when it was started ({variable}), which takes precedence over the mode below.',
    https: 'The Hub serves HTTPS with the certificates below.',
    fallback:
      'The Hub could not read its certificates when it started, so it serves plain HTTP on this computer only: {reason}',
    restart:
      'Restart the Hub to apply the trust mode: switching between HTTP and HTTPS happens when it starts.',
    problems: 'Certificate problems',
    fixExpired:
      'Native apps warn about an expired certificate. Renew it below; with the local CA, devices that ask must install the root again.',
    fixExpiring: 'It renews on its own before it expires. If it does not, renew it below.',
    fixNames:
      'The CA may sign only the names it was made for. Reach the Hub by one of those names, or use mesh certificates for that one.',
    fixOther: 'Renew the certificates below, then check again.',
  },
  mode: {
    title: 'Trust mode',
    help: 'Browsers need HTTPS for the camera, microphone, notifications and installing the app. A device may use more than one path: the local CA at home, mesh certificates away.',
    unknown: 'The Hub uses a mode this page does not know: {mode}.',
    legend: 'How clients trust the Hub',
    meshCerts: 'Also serve mesh certificates',
    meshCertsHelp:
      'Clients that reach the Hub by its mesh name get the mesh certificate, so they need no root installed.',
    pin: 'Native apps pin this Hub',
    pinHelp:
      "Nova's apps check the Hub's key, kept when the device was added, before they trust its certificate.",
    httpsOff: 'Turning HTTPS off applies when the Hub next starts.',
    httpsOn: 'HTTPS starts when the Hub next starts. Devices can install the root before that.',
    savedRestart: 'Saved. Restart the Hub to apply it.',
    saved: 'Saved. You can roll this back from the Overview.',
    savedShort: 'Trust settings saved.',
    saveFailed: 'Could not save the trust settings.',
    save: 'Save',
    reset: 'Reset',
  },
  identity: {
    title: "This Hub's identity",
    help: 'Apps check this fingerprint, from the code or QR used to add them, before trusting the Hub.',
    fingerprint: 'Hub fingerprint',
    copy: 'Copy fingerprint',
    copied: 'Fingerprint copied.',
    copyFailed: 'Could not copy. Select the fingerprint and copy it yourself.',
    noKey:
      'The Hub cannot load its identity key right now, so apps cannot check it. The problems above say why.',
  },
  root: {
    title: "The Hub's root certificate",
    making: 'The Hub is making its certificate authority. Check back in a moment.',
    onlyLocalCa: 'Only the Hub local CA mode has a root to install.',
    fingerprint: 'Fingerprint (SHA-256)',
    name: 'Name',
    validUntil: 'Valid until',
    downloadCrt: 'Download for phones and Windows ({ext})',
    downloadPem: 'Download for macOS and Linux ({ext})',
    checkFingerprint:
      'Check that the fingerprint your device shows matches the one above before you trust it.',
    howTo: 'How to install it',
    onlyWhileLocalCa: 'The root is offered for download only while the mode is Hub local CA.',
    maySign: 'What it may sign',
    constraints: 'Names: {names}. Addresses: {addresses}.',
    none: 'none',
  },
  certs: {
    title: 'Certificates the Hub serves',
    renewed: '{what, select, leaf {Hub certificate renewed.} other {Mesh certificate renewed.}}',
    renewFailed: 'Could not renew the certificate.',
    hub: 'Hub certificate',
    validUntil: 'Valid until',
    renews: 'Renews',
    renewsOn: '{date}, on its own',
    names: 'Names',
    renewNow: 'Renew now',
    notIssued: 'Not issued yet.',
    onlyLocalCa: 'Used only with the Hub local CA.',
    mesh: 'Mesh certificate',
    name: 'Name',
    noneYet: 'None yet. Network Setup gets one when the mesh offers certificates.',
  },
  status: { revoked: 'Revoked', replaced: 'Replaced', expired: 'Expired', inUse: 'In use' },
  issued: {
    title: 'Certificates issued',
    row: '{kind} {subject}',
    until: 'until {date}',
    issued: 'issued {when}',
    showAll: 'Show all {n}',
    none: 'None yet.',
  },
});

const date = (iso: string) => fmt.date(iso);

/** The Hub's setting for a certificate of its own (code, not words). */
const TLS_VARIABLE = 'NOVA_TLS_CERT';

export function TrustSection() {
  const api = useNetworkSurfaceApi();
  const trust = useLoad(() => api.getTrust(), 'trust');
  const reload = useDebounced(trust.reload, 150);
  useNetworkEvents(TRUST_EVENTS, reload, reload);
  const t = trust.data;
  if (!t)
    return trust.error ? (
      <LoadError error={trust.error} fallback={S.loadFailed} onRetry={trust.reload} />
    ) : (
      <Spinner label={S.loading} />
    );
  const set = (next: TrustView) => trust.setData(() => next);
  return (
    <div className="stack net-section">
      {trust.error ? (
        <LoadError error={trust.error} fallback={S.refreshFailed} onRetry={trust.reload} />
      ) : null}
      <Serving t={t} />
      <Mode t={t} onSaved={set} />
      <Identity t={t} />
      <Root t={t} />
      <Certificates t={t} onRenewed={set} />
      <Issued items={t.issued} />
    </div>
  );
}

function Serving({ t }: { t: TrustView }) {
  const s = t.serving;
  return (
    <div className="stack net-tight net-first">
      <p className="ws-flush">
        {!s
          ? S.serving.unknown
          : s.scheme === 'http'
            ? S.serving.http
            : s.source === 'explicit'
              ? embed(S.serving.explicit, {
                  variable: <code className="ws-code-inline">{TLS_VARIABLE}</code>,
                })
              : S.serving.https}
      </p>
      {s?.fallbackReason ? (
        <div className="net-notice" data-tone="bad" role="status">
          <Icon name="alert" />
          <p>{S.serving.fallback({ reason: s.fallbackReason })}</p>
        </div>
      ) : null}
      {t.restartRequired ? (
        <div className="net-notice" data-tone="warn" role="status">
          <Icon name="alert" />
          <p>{S.serving.restart}</p>
        </div>
      ) : null}
      {t.problems.length ? (
        <ul className="ws-list" aria-label={S.serving.problems}>
          {t.problems.map((p, i) => (
            <li key={`${i}-${p}`} className="net-problem">
              <p className="net-problem-text">
                <Icon name="alert" /> <span>{p.charAt(0).toUpperCase() + p.slice(1)}</span>
              </p>
              <p className="muted ws-flush">
                {/expired/i.test(p)
                  ? S.serving.fixExpired
                  : /expires|expiring/i.test(p)
                    ? S.serving.fixExpiring
                    : /outside|constraint|name/i.test(p)
                      ? S.serving.fixNames
                      : S.serving.fixOther}
              </p>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function Mode({ t, onSaved }: { t: TrustView; onSaved: (t: TrustView) => void }) {
  const api = useNetworkSurfaceApi();
  const toast = useToast();
  const announce = useAnnounce();
  const headingId = useId();
  const [draft, setDraft] = useState<TrustPatchBody>({});
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const mode = draft.mode ?? t.mode;
  const meshCerts = draft.meshCerts ?? t.meshCerts;
  const pin = draft.pinNativeShells ?? t.pinNativeShells;
  const patch: TrustPatchBody = {
    ...(mode !== t.mode ? { mode } : {}),
    ...(meshCerts !== t.meshCerts ? { meshCerts } : {}),
    ...(pin !== t.pinNativeShells ? { pinNativeShells: pin } : {}),
  };
  const dirty = Object.keys(patch).length > 0;
  const known = (TRUST_MODES as readonly string[]).includes(t.mode);
  const switchesScheme =
    patch.mode !== undefined && (patch.mode === 'none') !== (t.mode === 'none');

  const save = async () => {
    setBusy(true);
    setFailure(null);
    try {
      const next = await api.updateTrust(patch);
      setDraft({});
      onSaved(next);
      toast.show(next.restartRequired ? S.mode.savedRestart : S.mode.saved, { tone: 'success' });
      announce(S.mode.savedShort);
    } catch (err) {
      setFailure(netErrorMessage(err, S.mode.saveFailed));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="ws-section" aria-labelledby={headingId}>
      <h2 id={headingId}>{S.mode.title}</h2>
      <p className="muted">{S.mode.help}</p>
      {!known ? (
        <p className="ws-warning" role="note">
          <Icon name="alert" /> {S.mode.unknown({ mode: t.mode })}
        </p>
      ) : null}
      <RadioGroup
        legend={S.mode.legend}
        name="net-trust-mode"
        value={mode}
        options={TRUST_MODES.map((m) => ({
          value: m,
          label: trustModeInfo(m)?.label ?? m,
          description: trustModeInfo(m)?.description,
        }))}
        onChange={(v) => {
          const m = TRUST_MODES.find((x) => x === v);
          if (m) setDraft((d) => ({ ...d, mode: m }));
        }}
      />
      {mode === 'local-ca' ? (
        <SwitchField
          label={S.mode.meshCerts}
          description={S.mode.meshCertsHelp}
          checked={meshCerts}
          onChange={(v) => setDraft((d) => ({ ...d, meshCerts: v }))}
        />
      ) : null}
      <SwitchField
        label={S.mode.pin}
        description={S.mode.pinHelp}
        checked={pin}
        onChange={(v) => setDraft((d) => ({ ...d, pinNativeShells: v }))}
      />
      {switchesScheme ? (
        <p className="muted ws-flush net-small">
          {patch.mode === 'none' ? S.mode.httpsOff : S.mode.httpsOn}
        </p>
      ) : null}
      {failure ? (
        <p role="alert" className="nv-field-error">
          {failure}
        </p>
      ) : null}
      <div className="row">
        <Button variant="primary" disabled={!dirty || busy} onClick={() => void save()}>
          {busy ? <Spinner /> : null} {S.mode.save}
        </Button>
        {dirty ? <Button onClick={() => setDraft({})}>{S.mode.reset}</Button> : null}
      </div>
    </section>
  );
}

function Identity({ t }: { t: TrustView }) {
  const headingId = useId();
  return (
    <section className="ws-section" aria-labelledby={headingId}>
      <h2 id={headingId}>{S.identity.title}</h2>
      <p className="muted">{S.identity.help}</p>
      {t.hubFingerprint ? (
        <div className="row net-center">
          <code
            role="group"
            className="ws-code-inline net-break"
            aria-label={S.identity.fingerprint}
          >
            {t.hubFingerprint}
          </code>
          <CopyButton
            value={t.hubFingerprint}
            text={{
              copy: S.identity.copy,
              copied: S.identity.copied,
              failed: S.identity.copyFailed,
            }}
          />
        </div>
      ) : (
        <p className="ws-warning" role="note">
          <Icon name="alert" /> {S.identity.noKey}
        </p>
      )}
    </section>
  );
}

function Root({ t }: { t: TrustView }) {
  const api = useNetworkSurfaceApi();
  const headingId = useId();
  const ca = t.ca;
  return (
    <section className="ws-section" aria-labelledby={headingId}>
      <h2 id={headingId}>{S.root.title}</h2>
      {!ca ? (
        <p className="muted ws-flush">
          {t.mode === 'local-ca' ? S.root.making : S.root.onlyLocalCa}
        </p>
      ) : (
        <>
          <dl className="net-facts">
            <Fact term={S.root.fingerprint}>
              <code className="ws-code-inline net-break">{ca.fingerprint}</code>
            </Fact>
            <Fact term={S.root.name}>{ca.subject}</Fact>
            <Fact term={S.root.validUntil}>{date(ca.notAfter)}</Fact>
          </dl>
          {t.mode === 'local-ca' ? (
            <>
              <div className="row">
                <a
                  className="nv-btn"
                  data-variant="primary"
                  href={api.trustCaUrl('crt')}
                  download="nova-hub-ca.crt"
                >
                  <Icon name="download" /> {S.root.downloadCrt({ ext: '.crt' })}
                </a>
                <a className="nv-btn" href={api.trustCaUrl('pem')} download="nova-hub-ca.pem">
                  <Icon name="download" /> {S.root.downloadPem({ ext: '.pem' })}
                </a>
              </div>
              <p className="muted ws-flush net-small">{S.root.checkFingerprint}</p>
              <details className="ws-advanced">
                <summary>{S.root.howTo}</summary>
                <div className="net-hints">
                  {installHints().map((h) => (
                    <div key={h.id}>
                      <h3 className="ws-subhead">{h.platform}</h3>
                      <ol className="ws-plain-list">
                        {h.steps.map((s) => (
                          <li key={s}>{s}</li>
                        ))}
                      </ol>
                    </div>
                  ))}
                </div>
              </details>
            </>
          ) : (
            <p className="muted ws-flush">{S.root.onlyWhileLocalCa}</p>
          )}
          <details className="ws-advanced">
            <summary>{S.root.maySign}</summary>
            <p className="muted ws-flush net-small">
              {S.root.constraints({
                names: ca.nameConstraints.dns.length
                  ? valuesText(ca.nameConstraints.dns)
                  : S.root.none,
                addresses: ca.nameConstraints.ip.length
                  ? valuesText(ca.nameConstraints.ip)
                  : S.root.none,
              })}
            </p>
          </details>
        </>
      )}
    </section>
  );
}

function Certificates({ t, onRenewed }: { t: TrustView; onRenewed: (t: TrustView) => void }) {
  const api = useNetworkSurfaceApi();
  const toast = useToast();
  const announce = useAnnounce();
  const headingId = useId();
  const [busy, setBusy] = useState<'leaf' | 'mesh' | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const renew = async (target: 'leaf' | 'mesh') => {
    setBusy(target);
    setFailure(null);
    try {
      onRenewed(await api.renewTrust(target));
      toast.show(S.certs.renewed({ what: target }), { tone: 'success' });
      announce(S.certs.renewed({ what: target }));
    } catch (err) {
      setFailure(netErrorMessage(err, S.certs.renewFailed));
    } finally {
      setBusy(null);
    }
  };
  return (
    <section className="ws-section" aria-labelledby={headingId}>
      <h2 id={headingId}>{S.certs.title}</h2>
      {failure ? (
        <p role="alert" className="nv-field-error">
          {failure}
        </p>
      ) : null}
      <div className="ws-diag-grid">
        <div className="ws-card ws-diag-card">
          <h3 className="ws-subhead">{S.certs.hub}</h3>
          {t.leaf ? (
            <>
              <dl className="ws-dl">
                <dt>{S.certs.validUntil}</dt>
                <dd>{date(t.leaf.notAfter)}</dd>
                <dt>{S.certs.renews}</dt>
                <dd>{S.certs.renewsOn({ date: date(t.leaf.renewAt) })}</dd>
                <dt>{S.certs.names}</dt>
                <dd>{valuesText(t.leaf.sans)}</dd>
              </dl>
              <div>
                <Button onClick={() => void renew('leaf')} disabled={busy !== null}>
                  {busy === 'leaf' ? <Spinner /> : <Icon name="refresh" />} {S.certs.renewNow}
                </Button>
              </div>
            </>
          ) : (
            <p className="muted ws-flush">
              {t.mode === 'local-ca' ? S.certs.notIssued : S.certs.onlyLocalCa}
            </p>
          )}
        </div>
        <div className="ws-card ws-diag-card">
          <h3 className="ws-subhead">{S.certs.mesh}</h3>
          {t.meshCert ? (
            <>
              <Chip spec={meshCertChip(t.meshCert.status)} />
              <dl className="ws-dl">
                <dt>{S.certs.name}</dt>
                <dd>{t.meshCert.host}</dd>
                <dt>{S.certs.validUntil}</dt>
                <dd>{date(t.meshCert.notAfter)}</dd>
              </dl>
              <div>
                <Button onClick={() => void renew('mesh')} disabled={busy !== null}>
                  {busy === 'mesh' ? <Spinner /> : <Icon name="refresh" />} {S.certs.renewNow}
                </Button>
              </div>
            </>
          ) : (
            <p className="muted ws-flush">{S.certs.noneYet}</p>
          )}
        </div>
      </div>
    </section>
  );
}

function certStatus(c: TrustCertificateView): {
  text: string;
  tone: 'ready' | 'blocked' | 'neutral';
  icon: 'check' | 'stop' | 'clock';
} {
  if (c.revokedAt) return { text: S.status.revoked, tone: 'blocked', icon: 'stop' };
  if (c.supersededAt) return { text: S.status.replaced, tone: 'neutral', icon: 'clock' };
  if (Date.parse(c.notAfter) < Date.now())
    return { text: S.status.expired, tone: 'blocked', icon: 'stop' };
  return { text: S.status.inUse, tone: 'ready', icon: 'check' };
}

function Issued({ items }: { items: TrustCertificateView[] }) {
  const headingId = useId();
  const [all, setAll] = useState(false);
  const shown = all ? items : items.slice(0, 10);
  return (
    <section className="ws-section" aria-labelledby={headingId}>
      <h2 id={headingId}>{S.issued.title}</h2>
      {items.length ? (
        <>
          <ul className="ws-list" aria-label={S.issued.title}>
            {shown.map((c) => (
              <li
                key={c.id}
                className="ws-list-row"
                aria-label={S.issued.row({ kind: certKindLabel(c.kind), subject: c.subject })}
              >
                <div className="net-row-main">
                  <div className="net-row-head">
                    <span className="net-strong">{certKindLabel(c.kind)}</span>
                    <Chip spec={certStatus(c)} />
                  </div>
                  <span className="muted ws-row-meta">
                    <span>{c.subject}</span>
                    {c.role ? <span>{c.role}</span> : null}
                    <span>{S.issued.until({ date: date(c.notAfter) })}</span>
                    <span>{S.issued.issued({ when: formatWhen(c.createdAt) })}</span>
                  </span>
                  {c.sans.length ? (
                    <span className="muted net-small net-break">{valuesText(c.sans)}</span>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
          {items.length > shown.length ? (
            <div>
              <Button variant="ghost" onClick={() => setAll(true)}>
                {S.issued.showAll({ n: items.length })}
              </Button>
            </div>
          ) : null}
        </>
      ) : (
        <p className="muted ws-flush">{S.issued.none}</p>
      )}
    </section>
  );
}
