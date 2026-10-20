// Settings → Members → Sign-in providers (FR-113, docs/13 §7; owner only): OpenID Connect
// providers people may sign in with once they linked their identity in Settings → Account. Each
// has a label, an issuer (https; http only on this machine), a client id, a client secret that is
// write-only (the Hub keeps it in its vault and only says whether one is set), scopes, and an on
// or off switch. Test asks the Hub to reach the provider without signing anyone in. Nobody can
// sign up through a provider without an invitation.
import { useId, useState } from 'react';
import { defineMessages } from '@nova/i18n';
import { createOidcProviderSchema, oidcIssuerSchema, type OidcProviderView } from '@nova/shared';
import { Button, Dialog, EmptyState, Icon, Spinner, TextField, useToast } from '@nova/ui';
import { rich } from '../i18n/rich.tsx';
import { formatWhen } from '../settings/common.ts';
import { SwitchField } from '../settings/controls.tsx';
import { useAnnounce } from '../services.tsx';
import { useTeamApi, type CreateOidcProviderBody, type UpdateOidcProviderBody } from './api.ts';
import {
  ACCOUNT_SETTINGS_PATH,
  TEAM_TEXT,
  errorFields,
  providerChip,
  teamErrorMessage,
} from './format.ts';
import { Chip, ConfirmDialog, CopyButton, FormError, LoadError, useLoad } from './parts.tsx';
import { followLink } from '../work/nav.tsx';

const OIDC_TEXT = defineMessages('team.oidc', {
  heading: 'Sign-in providers',
  add: 'Add a provider',
  intro:
    'Let people sign in with an account they already have (OpenID Connect). Each person links their identity in {link}. Nobody can join through a provider without an invitation.',
  register: 'Register this address at the provider as the redirect URI:',
  copy: {
    copy: 'Copy redirect URI',
    copied: 'Redirect URI copied.',
    failed: 'Could not copy. Select the redirect URI and copy it yourself.',
  },
  loadFailed: 'Could not load the sign-in providers.',
  loading: 'Loading sign-in providers',
  emptyTitle: 'No sign-in providers',
  emptyDescription:
    "People sign in with this Hub's own accounts. Add a provider to also allow signing in with it.",
  saved: '{label} saved.',
  removeTitle: 'Remove {label}?',
  removeThis: 'Remove this provider?',
  removeWhat:
    "People can no longer sign in with it, the identities linked to it stop working, and its client secret leaves the Hub's vault.",
  removed: 'Provider removed.',
  isOn: '{label} is on.',
  isOff: '{label} is off.',
  changeFailed: 'Could not change the provider.',
  reached: 'The Hub reached {issuer} and can send people there to sign in.',
  testFailed: 'The test did not pass.',
  issuer: 'Issuer',
  clientId: 'Client id',
  clientSecret: 'Client secret',
  secretSet: 'Set',
  secretNotSet: 'Not set',
  scopes: 'Scopes',
  changed: 'Changed',
  allow: 'Allow signing in with it',
  test: 'Test',
  turnOnToTest: 'Turn it on to test it',
  turnOnToTestNote: 'Turn it on to test it.',
  edit: 'Edit',
});

const PROVIDER_FORM_TEXT = defineMessages('team.oidc.form', {
  nameNeeded: 'Give it a name people recognize, like “Company sign-in”.',
  issuerInvalid:
    'Enter the issuer’s https:// address (http:// only on this machine), without a query.',
  clientIdNeeded: 'Enter the client id the provider gave you.',
  openidNeeded: 'The scopes must include openid.',
  checkFields: 'Check the fields.',
  editTitle: 'Edit {label}',
  addTitle: 'Add a sign-in provider',
  description: 'The client id and secret come from the app you register at the provider.',
  name: 'Name',
  nameHint: 'What the sign-in button says: “Continue with <name>”.',
  issuerIs: 'Issuer:',
  issuerFixed: '(to use another issuer, add a new provider)',
  issuerHint: 'For example {example}',
  secretReplaceHint: 'Replaces the stored secret. Leave empty to keep it.',
  secretNewHint:
    'Optional for public clients. It goes to the Hub’s vault and is never shown again.',
  willBeRemoved: 'Will be removed',
  replace: 'Replace',
  keep: 'Keep it',
  removeSecret: 'Remove secret',
  scopesHint: 'Separated by spaces; openid is required.',
  enableLater: 'You can turn it on later, after testing.',
  saveFailed: 'Could not save the provider.',
});

const DEFAULT_SCOPES = 'openid profile email';

/** The address to register at the provider (its redirect URI). */
export function callbackUrl(path = '/api/v1/auth/oidc/callback'): string {
  return `${window.location.origin}${path}`;
}

export function OidcProvidersSection() {
  const api = useTeamApi();
  const headingId = useId();
  const list = useLoad(() => api.listOidcProviders().then((r) => r.items), 'oidc-providers');
  const [editing, setEditing] = useState<OidcProviderView | 'new' | null>(null);
  const [deleting, setDeleting] = useState<OidcProviderView | null>(null);
  const toast = useToast();
  const replace = (p: OidcProviderView) =>
    list.setData((prev) => {
      const rest = (prev ?? []).filter((x) => x.id !== p.id);
      return [...rest, p].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    });

  return (
    <section className="settings-section" aria-labelledby={headingId}>
      <div className="ws-section-header">
        <h3 id={headingId}>{OIDC_TEXT.heading}</h3>
        <Button onClick={() => setEditing('new')}>
          <Icon name="plus" /> {OIDC_TEXT.add}
        </Button>
      </div>
      <p className="muted ws-flush">
        {rich(OIDC_TEXT.intro, {
          link: (
            <a href={ACCOUNT_SETTINGS_PATH} onClick={(e) => followLink(e, ACCOUNT_SETTINGS_PATH)}>
              {TEAM_TEXT.accountLink}
            </a>
          ),
        })}
      </p>
      <p className="muted ws-flush">{OIDC_TEXT.register}</p>
      <div className="team-link-box">
        <code className="ws-code-inline team-break">{callbackUrl()}</code>
        <CopyButton value={callbackUrl()} text={OIDC_TEXT.copy} />
      </div>
      {list.error ? (
        <LoadError
          error={list.error}
          fallback={OIDC_TEXT.loadFailed}
          onRetry={list.reload}
          what={OIDC_TEXT.heading}
        />
      ) : null}
      {list.loading ? <Spinner label={OIDC_TEXT.loading} /> : null}
      {list.data && list.data.length === 0 ? (
        <EmptyState
          level={3}
          icon="shield"
          title={OIDC_TEXT.emptyTitle}
          description={OIDC_TEXT.emptyDescription}
        />
      ) : null}
      {list.data && list.data.length > 0 ? (
        <ul className="ws-list" aria-label={OIDC_TEXT.heading}>
          {list.data.map((p) => (
            <ProviderRow
              key={p.id}
              p={p}
              onChanged={replace}
              onEdit={() => setEditing(p)}
              onDelete={() => setDeleting(p)}
            />
          ))}
        </ul>
      ) : null}
      {editing ? (
        <ProviderDialog
          provider={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={(p) => {
            replace(p);
            setEditing(null);
            toast.show(OIDC_TEXT.saved({ label: p.label }), { tone: 'success' });
          }}
        />
      ) : null}
      <ConfirmDialog
        open={deleting !== null}
        title={deleting ? OIDC_TEXT.removeTitle({ label: deleting.label }) : OIDC_TEXT.removeThis}
        description={OIDC_TEXT.removeWhat}
        confirmLabel={TEAM_TEXT.remove}
        danger
        onClose={() => setDeleting(null)}
        onConfirm={async () => {
          if (!deleting) return;
          await api.deleteOidcProvider(deleting.id);
          const gone = deleting.id;
          list.setData((prev) => prev?.filter((x) => x.id !== gone) ?? null);
          setDeleting(null);
          toast.show(OIDC_TEXT.removed, { tone: 'success' });
        }}
      />
    </section>
  );
}

function ProviderRow({
  p,
  onChanged,
  onEdit,
  onDelete,
}: {
  p: OidcProviderView;
  onChanged: (p: OidcProviderView) => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const api = useTeamApi();
  const announce = useAnnounce();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);

  const toggle = async (enabled: boolean) => {
    setBusy(true);
    try {
      onChanged(await api.updateOidcProvider(p.id, { enabled }));
      announce(enabled ? OIDC_TEXT.isOn({ label: p.label }) : OIDC_TEXT.isOff({ label: p.label }));
    } catch (err) {
      toast.show(teamErrorMessage(err, OIDC_TEXT.changeFailed), { tone: 'error' });
    } finally {
      setBusy(false);
    }
  };

  // The Hub reads the provider's discovery document to build the sign-in address; nobody is
  // sent there and nobody is signed in.
  const test = async () => {
    setTesting(true);
    setResult(null);
    try {
      await api.startOidc({ providerId: p.id, flow: 'sign_in' });
      const text = OIDC_TEXT.reached({ issuer: p.issuer });
      setResult({ ok: true, text });
      announce(text);
    } catch (err) {
      const text = teamErrorMessage(err, OIDC_TEXT.testFailed);
      setResult({ ok: false, text });
      announce(text);
    } finally {
      setTesting(false);
    }
  };

  return (
    <li className="ws-card team-provider" aria-label={p.label}>
      <div className="ws-section-header">
        <span className="team-strong" dir="auto">
          {p.label}
        </span>
        <Chip spec={providerChip(p)} />
      </div>
      <dl className="ws-dl">
        <dt>{OIDC_TEXT.issuer}</dt>
        <dd>
          <code className="ws-code-inline team-break">{p.issuer}</code>
        </dd>
        <dt>{OIDC_TEXT.clientId}</dt>
        <dd className="team-break" dir="ltr">
          {p.clientId}
        </dd>
        <dt>{OIDC_TEXT.clientSecret}</dt>
        <dd>{p.hasClientSecret ? OIDC_TEXT.secretSet : OIDC_TEXT.secretNotSet}</dd>
        <dt>{OIDC_TEXT.scopes}</dt>
        <dd dir="ltr" translate="no">
          {p.scopes.join(' ')}
        </dd>
        <dt>{OIDC_TEXT.changed}</dt>
        <dd>{formatWhen(p.updatedAt)}</dd>
      </dl>
      <SwitchField
        label={OIDC_TEXT.allow}
        checked={p.enabled}
        disabled={busy}
        onChange={(v) => void toggle(v)}
      />
      <div className="row team-actions">
        <Button
          onClick={() => void test()}
          disabled={testing || !p.enabled}
          title={p.enabled ? undefined : OIDC_TEXT.turnOnToTest}
        >
          {testing ? <Spinner /> : <Icon name="refresh" />} {OIDC_TEXT.test}
        </Button>
        <Button variant="ghost" onClick={onEdit}>
          <Icon name="edit" /> {OIDC_TEXT.edit}
        </Button>
        <Button variant="ghost" onClick={onDelete}>
          <Icon name="trash" /> {TEAM_TEXT.remove}
        </Button>
      </div>
      {!p.enabled ? <p className="muted ws-flush">{OIDC_TEXT.turnOnToTestNote}</p> : null}
      {result ? (
        <p
          className="team-notice ws-flush"
          data-tone={result.ok ? 'ok' : 'bad'}
          role={result.ok ? 'status' : 'alert'}
        >
          <Icon name={result.ok ? 'check' : 'alert'} /> {result.text}
        </p>
      ) : null}
    </li>
  );
}

interface Draft {
  label: string;
  issuer: string;
  clientId: string;
  scopes: string;
  /** A new secret to store; empty keeps what is there. */
  secret: string;
  removeSecret: boolean;
  enabled: boolean;
}

function ProviderDialog({
  provider,
  onClose,
  onSaved,
}: {
  provider: OidcProviderView | null;
  onClose: () => void;
  onSaved: (p: OidcProviderView) => void;
}) {
  const api = useTeamApi();
  const [d, setD] = useState<Draft>(() => ({
    label: provider?.label ?? '',
    issuer: provider?.issuer ?? '',
    clientId: provider?.clientId ?? '',
    scopes: provider ? provider.scopes.join(' ') : DEFAULT_SCOPES,
    secret: '',
    removeSecret: false,
    enabled: provider?.enabled ?? true,
  }));
  const [replacing, setReplacing] = useState(!provider?.hasClientSecret);
  const [fields, setFields] = useState<Record<string, string>>({});
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const set = (patch: Partial<Draft>) => {
    setD((prev) => ({ ...prev, ...patch }));
    setFields({});
    setError(null);
  };

  const check = (): Record<string, string> => {
    const out: Record<string, string> = {};
    if (!d.label.trim()) out.label = PROVIDER_FORM_TEXT.nameNeeded;
    if (!provider) {
      const iss = oidcIssuerSchema.safeParse(d.issuer);
      if (!iss.success) out.issuer = PROVIDER_FORM_TEXT.issuerInvalid;
    }
    if (!d.clientId.trim()) out.clientId = PROVIDER_FORM_TEXT.clientIdNeeded;
    const scopes = d.scopes.split(/\s+/).filter(Boolean);
    if (!scopes.includes('openid')) out.scopes = PROVIDER_FORM_TEXT.openidNeeded;
    return out;
  };

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    const problems = check();
    setFields(problems);
    if (Object.keys(problems).length) return;
    const scopes = d.scopes.split(/\s+/).filter(Boolean);
    setBusy(true);
    setError(null);
    try {
      if (!provider) {
        const body: CreateOidcProviderBody = {
          label: d.label.trim(),
          issuer: d.issuer.trim(),
          clientId: d.clientId.trim(),
          scopes,
          enabled: d.enabled,
          ...(d.secret ? { clientSecret: d.secret } : {}),
        };
        const parsed = createOidcProviderSchema.safeParse(body);
        if (!parsed.success) {
          setError(new Error(parsed.error.issues[0]?.message ?? PROVIDER_FORM_TEXT.checkFields));
          return;
        }
        onSaved(await api.createOidcProvider(body));
      } else {
        const body: UpdateOidcProviderBody = {
          ...(d.label.trim() !== provider.label ? { label: d.label.trim() } : {}),
          ...(d.clientId.trim() !== provider.clientId ? { clientId: d.clientId.trim() } : {}),
          ...(scopes.join(' ') !== provider.scopes.join(' ') ? { scopes } : {}),
          ...(d.removeSecret ? { clientSecret: null } : d.secret ? { clientSecret: d.secret } : {}),
        };
        if (Object.keys(body).length === 0) {
          onClose();
          return;
        }
        onSaved(await api.updateOidcProvider(provider.id, body));
      }
    } catch (err) {
      setFields(errorFields(err));
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open
      title={
        provider
          ? PROVIDER_FORM_TEXT.editTitle({ label: provider.label })
          : PROVIDER_FORM_TEXT.addTitle
      }
      description={PROVIDER_FORM_TEXT.description}
      onClose={onClose}
      className="ws-wide-dialog"
      footer={
        <>
          <Button onClick={onClose}>{TEAM_TEXT.cancel}</Button>
          <Button variant="primary" type="submit" form="team-oidc-form" disabled={busy}>
            {busy ? <Spinner /> : null} {TEAM_TEXT.save}
          </Button>
        </>
      }
    >
      <form id="team-oidc-form" className="stack" onSubmit={(e) => void save(e)} noValidate>
        <TextField
          label={PROVIDER_FORM_TEXT.name}
          hint={PROVIDER_FORM_TEXT.nameHint}
          value={d.label}
          maxLength={100}
          onChange={(e) => set({ label: e.target.value })}
          error={fields.label}
        />
        {provider ? (
          <p className="ws-flush">
            <span className="muted">{PROVIDER_FORM_TEXT.issuerIs}</span>{' '}
            <code className="ws-code-inline team-break">{provider.issuer}</code>{' '}
            <span className="muted">{PROVIDER_FORM_TEXT.issuerFixed}</span>
          </p>
        ) : (
          <TextField
            label={OIDC_TEXT.issuer}
            hint={PROVIDER_FORM_TEXT.issuerHint({ example: 'https://accounts.example.com' })}
            value={d.issuer}
            inputMode="url"
            autoComplete="off"
            spellCheck={false}
            onChange={(e) => set({ issuer: e.target.value })}
            error={fields.issuer}
          />
        )}
        <TextField
          label={OIDC_TEXT.clientId}
          value={d.clientId}
          autoComplete="off"
          spellCheck={false}
          onChange={(e) => set({ clientId: e.target.value })}
          error={fields.clientId}
        />
        {replacing ? (
          <TextField
            label={OIDC_TEXT.clientSecret}
            type="password"
            hint={
              provider?.hasClientSecret
                ? PROVIDER_FORM_TEXT.secretReplaceHint
                : PROVIDER_FORM_TEXT.secretNewHint
            }
            value={d.secret}
            autoComplete="new-password"
            onChange={(e) => set({ secret: e.target.value, removeSecret: false })}
          />
        ) : (
          <div className="ws-secret-row">
            <span>
              <span className="nv-field-label">{OIDC_TEXT.clientSecret}</span>{' '}
              <span>{d.removeSecret ? PROVIDER_FORM_TEXT.willBeRemoved : OIDC_TEXT.secretSet}</span>
            </span>
            <Button variant="ghost" onClick={() => setReplacing(true)}>
              {PROVIDER_FORM_TEXT.replace}
            </Button>
            {d.removeSecret ? (
              <Button variant="ghost" onClick={() => set({ removeSecret: false })}>
                {PROVIDER_FORM_TEXT.keep}
              </Button>
            ) : (
              <Button variant="ghost" onClick={() => set({ removeSecret: true })}>
                {PROVIDER_FORM_TEXT.removeSecret}
              </Button>
            )}
          </div>
        )}
        <TextField
          label={OIDC_TEXT.scopes}
          hint={PROVIDER_FORM_TEXT.scopesHint}
          value={d.scopes}
          spellCheck={false}
          onChange={(e) => set({ scopes: e.target.value })}
          error={fields.scopes}
        />
        {!provider ? (
          <SwitchField
            label={OIDC_TEXT.allow}
            description={PROVIDER_FORM_TEXT.enableLater}
            checked={d.enabled}
            onChange={(v) => set({ enabled: v })}
          />
        ) : null}
        <FormError error={error} fallback={PROVIDER_FORM_TEXT.saveFailed} />
      </form>
    </Dialog>
  );
}
