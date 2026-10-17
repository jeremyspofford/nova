// Network → Trust (FR-134; docs/22 §5): how browsers and apps trust this Hub over HTTPS. The
// mode (Hub local CA, mesh certificates or none) with what each means, the notice when it applies
// only after a restart, the Hub's identity pin, the CA's fingerprint and its root to download with
// install hints for each platform, the Hub certificate's names and expiry, the mesh certificate,
// renewal, every certificate issued and the problems the Hub reports.
import { useId, useState } from 'react';
import { TRUST_MODES, type TrustCertificateView, type TrustView } from '@nova/shared';
import { Button, Icon, RadioGroup, Spinner, useToast } from '@nova/ui';
import { formatWhen } from '../settings/common.ts';
import { SwitchField } from '../settings/controls.tsx';
import { useAnnounce } from '../services.tsx';
import { useDebounced } from '../work/events.ts';
import { useNetworkSurfaceApi, type TrustPatchBody } from './api.ts';
import { TRUST_EVENTS, useNetworkEvents } from './events.ts';
import {
  CERT_KIND_LABEL,
  INSTALL_HINTS,
  TRUST_MODE_INFO,
  meshCertChip,
  netErrorMessage,
} from './format.ts';
import { Chip, CopyButton, Fact, LoadError, useLoad } from './parts.tsx';

const date = (iso: string) => new Date(iso).toLocaleDateString(undefined, { dateStyle: 'medium' });

export function TrustSection() {
  const api = useNetworkSurfaceApi();
  const trust = useLoad(() => api.getTrust(), 'trust');
  const reload = useDebounced(trust.reload, 150);
  useNetworkEvents(TRUST_EVENTS, reload, reload);
  const t = trust.data;
  if (!t)
    return trust.error ? (
      <LoadError
        error={trust.error}
        fallback="Could not load the certificates."
        onRetry={trust.reload}
      />
    ) : (
      <Spinner label="Loading the certificates" />
    );
  const set = (next: TrustView) => trust.setData(() => next);
  return (
    <div className="stack net-section">
      {trust.error ? (
        <LoadError
          error={trust.error}
          fallback="Could not refresh the certificates."
          onRetry={trust.reload}
        />
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
          ? 'The Hub has not reported how it serves yet.'
          : s.scheme === 'http'
            ? 'The Hub serves plain HTTP now.'
            : s.source === 'explicit'
              ? 'The Hub serves HTTPS with the certificate set when it was started (NOVA_TLS_CERT), which takes precedence over the mode below.'
              : 'The Hub serves HTTPS with the certificates below.'}
      </p>
      {s?.fallbackReason ? (
        <div className="net-notice" data-tone="bad" role="status">
          <Icon name="alert" />
          <p>
            The Hub could not read its certificates when it started, so it serves plain HTTP on this
            computer only: {s.fallbackReason}
          </p>
        </div>
      ) : null}
      {t.restartRequired ? (
        <div className="net-notice" data-tone="warn" role="status">
          <Icon name="alert" />
          <p>
            Restart the Hub to apply the trust mode: switching between HTTP and HTTPS happens when
            it starts.
          </p>
        </div>
      ) : null}
      {t.problems.length ? (
        <ul className="ws-list" aria-label="Certificate problems">
          {t.problems.map((p, i) => (
            <li key={`${i}-${p}`} className="net-problem">
              <p className="net-problem-text">
                <Icon name="alert" /> <span>{p.charAt(0).toUpperCase() + p.slice(1)}</span>
              </p>
              <p className="muted ws-flush">
                {/expired/i.test(p)
                  ? 'Native apps warn about an expired certificate. Renew it below; with the local CA, devices that ask must install the root again.'
                  : /expires|expiring/i.test(p)
                    ? 'It renews on its own before it expires. If it does not, renew it below.'
                    : /outside|constraint|name/i.test(p)
                      ? 'The CA may sign only the names it was made for. Reach the Hub by one of those names, or use mesh certificates for that one.'
                      : 'Renew the certificates below, then check again.'}
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
      toast.show(
        next.restartRequired
          ? 'Saved. Restart the Hub to apply it.'
          : 'Saved. You can roll this back from the Overview.',
        { tone: 'success' },
      );
      announce('Trust settings saved.');
    } catch (err) {
      setFailure(netErrorMessage(err, 'Could not save the trust settings.'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="ws-section" aria-labelledby={headingId}>
      <h2 id={headingId}>Trust mode</h2>
      <p className="muted">
        Browsers need HTTPS for the camera, microphone, notifications and installing the app. A
        device may use more than one path: the local CA at home, mesh certificates away.
      </p>
      {!known ? (
        <p className="ws-warning" role="note">
          <Icon name="alert" /> The Hub uses a mode this page does not know: {t.mode}.
        </p>
      ) : null}
      <RadioGroup
        legend="How clients trust the Hub"
        name="net-trust-mode"
        value={mode}
        options={TRUST_MODES.map((m) => ({
          value: m,
          label: TRUST_MODE_INFO[m]?.label ?? m,
          description: TRUST_MODE_INFO[m]?.description,
        }))}
        onChange={(v) => {
          const m = TRUST_MODES.find((x) => x === v);
          if (m) setDraft((d) => ({ ...d, mode: m }));
        }}
      />
      {mode === 'local-ca' ? (
        <SwitchField
          label="Also serve mesh certificates"
          description="Clients that reach the Hub by its mesh name get the mesh certificate, so they need no root installed."
          checked={meshCerts}
          onChange={(v) => setDraft((d) => ({ ...d, meshCerts: v }))}
        />
      ) : null}
      <SwitchField
        label="Native apps pin this Hub"
        description="Nova's apps check the Hub's key, kept when the device was added, before they trust its certificate."
        checked={pin}
        onChange={(v) => setDraft((d) => ({ ...d, pinNativeShells: v }))}
      />
      {switchesScheme ? (
        <p className="muted ws-flush net-small">
          {patch.mode === 'none'
            ? 'Turning HTTPS off applies when the Hub next starts.'
            : 'HTTPS starts when the Hub next starts. Devices can install the root before that.'}
        </p>
      ) : null}
      {failure ? (
        <p role="alert" className="nv-field-error">
          {failure}
        </p>
      ) : null}
      <div className="row">
        <Button variant="primary" disabled={!dirty || busy} onClick={() => void save()}>
          {busy ? <Spinner /> : null} Save
        </Button>
        {dirty ? <Button onClick={() => setDraft({})}>Reset</Button> : null}
      </div>
    </section>
  );
}

function Identity({ t }: { t: TrustView }) {
  const headingId = useId();
  return (
    <section className="ws-section" aria-labelledby={headingId}>
      <h2 id={headingId}>This Hub&apos;s identity</h2>
      <p className="muted">
        Apps check this fingerprint, from the code or QR used to add them, before trusting the Hub.
      </p>
      {t.hubFingerprint ? (
        <div className="row net-center">
          <code className="ws-code-inline net-break" aria-label="Hub fingerprint">
            {t.hubFingerprint}
          </code>
          <CopyButton value={t.hubFingerprint} what="Fingerprint" />
        </div>
      ) : (
        <p className="ws-warning" role="note">
          <Icon name="alert" /> The Hub cannot load its identity key right now, so apps cannot check
          it. The problems above say why.
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
      <h2 id={headingId}>The Hub&apos;s root certificate</h2>
      {!ca ? (
        <p className="muted ws-flush">
          {t.mode === 'local-ca'
            ? 'The Hub is making its certificate authority. Check back in a moment.'
            : 'Only the Hub local CA mode has a root to install.'}
        </p>
      ) : (
        <>
          <dl className="net-facts">
            <Fact term="Fingerprint (SHA-256)">
              <code className="ws-code-inline net-break">{ca.fingerprint}</code>
            </Fact>
            <Fact term="Name">{ca.subject}</Fact>
            <Fact term="Valid until">{date(ca.notAfter)}</Fact>
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
                  <Icon name="download" /> Download for phones and Windows (.crt)
                </a>
                <a className="nv-btn" href={api.trustCaUrl('pem')} download="nova-hub-ca.pem">
                  <Icon name="download" /> Download for macOS and Linux (.pem)
                </a>
              </div>
              <p className="muted ws-flush net-small">
                Check that the fingerprint your device shows matches the one above before you trust
                it.
              </p>
              <details className="ws-advanced">
                <summary>How to install it</summary>
                <div className="net-hints">
                  {INSTALL_HINTS.map((h) => (
                    <div key={h.platform}>
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
            <p className="muted ws-flush">
              The root is offered for download only while the mode is Hub local CA.
            </p>
          )}
          <details className="ws-advanced">
            <summary>What it may sign</summary>
            <p className="muted ws-flush net-small">
              Names: {ca.nameConstraints.dns.join(', ') || 'none'}. Addresses:{' '}
              {ca.nameConstraints.ip.join(', ') || 'none'}.
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
      const what = target === 'leaf' ? 'Hub certificate' : 'Mesh certificate';
      toast.show(`${what} renewed.`, { tone: 'success' });
      announce(`${what} renewed.`);
    } catch (err) {
      setFailure(netErrorMessage(err, 'Could not renew the certificate.'));
    } finally {
      setBusy(null);
    }
  };
  return (
    <section className="ws-section" aria-labelledby={headingId}>
      <h2 id={headingId}>Certificates the Hub serves</h2>
      {failure ? (
        <p role="alert" className="nv-field-error">
          {failure}
        </p>
      ) : null}
      <div className="ws-diag-grid">
        <div className="ws-card ws-diag-card">
          <h3 className="ws-subhead">Hub certificate</h3>
          {t.leaf ? (
            <>
              <dl className="ws-dl">
                <dt>Valid until</dt>
                <dd>{date(t.leaf.notAfter)}</dd>
                <dt>Renews</dt>
                <dd>{date(t.leaf.renewAt)}, on its own</dd>
                <dt>Names</dt>
                <dd>{t.leaf.sans.join(', ')}</dd>
              </dl>
              <div>
                <Button onClick={() => void renew('leaf')} disabled={busy !== null}>
                  {busy === 'leaf' ? <Spinner /> : <Icon name="refresh" />} Renew now
                </Button>
              </div>
            </>
          ) : (
            <p className="muted ws-flush">
              {t.mode === 'local-ca' ? 'Not issued yet.' : 'Used only with the Hub local CA.'}
            </p>
          )}
        </div>
        <div className="ws-card ws-diag-card">
          <h3 className="ws-subhead">Mesh certificate</h3>
          {t.meshCert ? (
            <>
              <Chip spec={meshCertChip(t.meshCert.status)} />
              <dl className="ws-dl">
                <dt>Name</dt>
                <dd>{t.meshCert.host}</dd>
                <dt>Valid until</dt>
                <dd>{date(t.meshCert.notAfter)}</dd>
              </dl>
              <div>
                <Button onClick={() => void renew('mesh')} disabled={busy !== null}>
                  {busy === 'mesh' ? <Spinner /> : <Icon name="refresh" />} Renew now
                </Button>
              </div>
            </>
          ) : (
            <p className="muted ws-flush">
              None yet. Network Setup gets one when the mesh offers certificates.
            </p>
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
  if (c.revokedAt) return { text: 'Revoked', tone: 'blocked', icon: 'stop' };
  if (c.supersededAt) return { text: 'Replaced', tone: 'neutral', icon: 'clock' };
  if (Date.parse(c.notAfter) < Date.now())
    return { text: 'Expired', tone: 'blocked', icon: 'stop' };
  return { text: 'In use', tone: 'ready', icon: 'check' };
}

function Issued({ items }: { items: TrustCertificateView[] }) {
  const headingId = useId();
  const [all, setAll] = useState(false);
  const shown = all ? items : items.slice(0, 10);
  return (
    <section className="ws-section" aria-labelledby={headingId}>
      <h2 id={headingId}>Certificates issued</h2>
      {items.length ? (
        <>
          <ul className="ws-list" aria-label="Certificates issued">
            {shown.map((c) => (
              <li
                key={c.id}
                className="ws-list-row"
                aria-label={`${CERT_KIND_LABEL[c.kind] ?? c.kind} ${c.subject}`}
              >
                <div className="net-row-main">
                  <div className="net-row-head">
                    <span className="net-strong">{CERT_KIND_LABEL[c.kind] ?? c.kind}</span>
                    <Chip spec={certStatus(c)} />
                  </div>
                  <span className="muted ws-row-meta">
                    <span>{c.subject}</span>
                    {c.role ? <span>{c.role}</span> : null}
                    <span>until {date(c.notAfter)}</span>
                    <span>issued {formatWhen(c.createdAt)}</span>
                  </span>
                  {c.sans.length ? (
                    <span className="muted net-small net-break">{c.sans.join(', ')}</span>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
          {items.length > shown.length ? (
            <div>
              <Button variant="ghost" onClick={() => setAll(true)}>
                Show all {items.length}
              </Button>
            </div>
          ) : null}
        </>
      ) : (
        <p className="muted ws-flush">None yet.</p>
      )}
    </section>
  );
}
