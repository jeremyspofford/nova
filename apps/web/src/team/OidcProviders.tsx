// Settings → Members → Sign-in providers (FR-113, docs/13 §7; owner only): OpenID Connect
// providers people may sign in with once they linked their identity in Settings → Account. Each
// has a label, an issuer (https; http only on this machine), a client id, a client secret that is
// write-only (the Hub keeps it in its vault and only says whether one is set), scopes, and an on
// or off switch. Test asks the Hub to reach the provider without signing anyone in. Nobody can
// sign up through a provider without an invitation.
import { useId, useState } from 'react';
import { createOidcProviderSchema, oidcIssuerSchema, type OidcProviderView } from '@nova/shared';
import { Button, Dialog, EmptyState, Icon, Spinner, TextField, useToast } from '@nova/ui';
import { formatWhen } from '../settings/common.ts';
import { SwitchField } from '../settings/controls.tsx';
import { useAnnounce } from '../services.tsx';
import { useTeamApi, type CreateOidcProviderBody, type UpdateOidcProviderBody } from './api.ts';
import { ACCOUNT_SETTINGS_PATH, errorFields, providerChip, teamErrorMessage } from './format.ts';
import { Chip, ConfirmDialog, CopyButton, FormError, LoadError, useLoad } from './parts.tsx';
import { followLink } from '../work/nav.tsx';

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
        <h3 id={headingId}>Sign-in providers</h3>
        <Button onClick={() => setEditing('new')}>
          <Icon name="plus" /> Add a provider
        </Button>
      </div>
      <p className="muted ws-flush">
        Let people sign in with an account they already have (OpenID Connect). Each person links
        their identity in{' '}
        <a href={ACCOUNT_SETTINGS_PATH} onClick={(e) => followLink(e, ACCOUNT_SETTINGS_PATH)}>
          Settings → Account
        </a>
        . Nobody can join through a provider without an invitation.
      </p>
      <p className="muted ws-flush">Register this address at the provider as the redirect URI:</p>
      <div className="team-link-box">
        <code className="ws-code-inline team-break">{callbackUrl()}</code>
        <CopyButton value={callbackUrl()} what="Redirect URI" />
      </div>
      {list.error ? (
        <LoadError
          error={list.error}
          fallback="Could not load the sign-in providers."
          onRetry={list.reload}
          what="Sign-in providers"
        />
      ) : null}
      {list.loading ? <Spinner label="Loading sign-in providers" /> : null}
      {list.data && list.data.length === 0 ? (
        <EmptyState
          level={3}
          icon="shield"
          title="No sign-in providers"
          description="People sign in with this Hub's own accounts. Add a provider to also allow signing in with it."
        />
      ) : null}
      {list.data && list.data.length > 0 ? (
        <ul className="ws-list" aria-label="Sign-in providers">
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
            toast.show(`${p.label} saved.`, { tone: 'success' });
          }}
        />
      ) : null}
      <ConfirmDialog
        open={deleting !== null}
        title={`Remove ${deleting?.label ?? 'this provider'}?`}
        description="People can no longer sign in with it, the identities linked to it stop working, and its client secret leaves the Hub's vault."
        confirmLabel="Remove"
        danger
        onClose={() => setDeleting(null)}
        onConfirm={async () => {
          if (!deleting) return;
          await api.deleteOidcProvider(deleting.id);
          const gone = deleting.id;
          list.setData((prev) => prev?.filter((x) => x.id !== gone) ?? null);
          setDeleting(null);
          toast.show('Provider removed.', { tone: 'success' });
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
      announce(enabled ? `${p.label} is on.` : `${p.label} is off.`);
    } catch (err) {
      toast.show(teamErrorMessage(err, 'Could not change the provider.'), { tone: 'error' });
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
      const text = `The Hub reached ${p.issuer} and can send people there to sign in.`;
      setResult({ ok: true, text });
      announce(text);
    } catch (err) {
      const text = teamErrorMessage(err, 'The test did not pass.');
      setResult({ ok: false, text });
      announce(text);
    } finally {
      setTesting(false);
    }
  };

  return (
    <li className="ws-card team-provider" aria-label={p.label}>
      <div className="ws-section-header">
        <span className="team-strong">{p.label}</span>
        <Chip spec={providerChip(p)} />
      </div>
      <dl className="ws-dl">
        <dt>Issuer</dt>
        <dd>
          <code className="ws-code-inline team-break">{p.issuer}</code>
        </dd>
        <dt>Client id</dt>
        <dd className="team-break">{p.clientId}</dd>
        <dt>Client secret</dt>
        <dd>{p.hasClientSecret ? 'Set' : 'Not set'}</dd>
        <dt>Scopes</dt>
        <dd>{p.scopes.join(' ')}</dd>
        <dt>Changed</dt>
        <dd>{formatWhen(p.updatedAt)}</dd>
      </dl>
      <SwitchField
        label="Allow signing in with it"
        checked={p.enabled}
        disabled={busy}
        onChange={(v) => void toggle(v)}
      />
      <div className="row team-actions">
        <Button
          onClick={() => void test()}
          disabled={testing || !p.enabled}
          title={p.enabled ? undefined : 'Turn it on to test it'}
        >
          {testing ? <Spinner /> : <Icon name="refresh" />} Test
        </Button>
        <Button variant="ghost" onClick={onEdit}>
          <Icon name="edit" /> Edit
        </Button>
        <Button variant="ghost" onClick={onDelete}>
          <Icon name="trash" /> Remove
        </Button>
      </div>
      {!p.enabled ? <p className="muted ws-flush">Turn it on to test it.</p> : null}
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
    if (!d.label.trim()) out.label = 'Give it a name people recognize, like “Company sign-in”.';
    if (!provider) {
      const iss = oidcIssuerSchema.safeParse(d.issuer);
      if (!iss.success)
        out.issuer =
          'Enter the issuer’s https:// address (http:// only on this machine), without a query.';
    }
    if (!d.clientId.trim()) out.clientId = 'Enter the client id the provider gave you.';
    const scopes = d.scopes.split(/\s+/).filter(Boolean);
    if (!scopes.includes('openid')) out.scopes = 'The scopes must include openid.';
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
          setError(new Error(parsed.error.issues[0]?.message ?? 'Check the fields.'));
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
      title={provider ? `Edit ${provider.label}` : 'Add a sign-in provider'}
      description="The client id and secret come from the app you register at the provider."
      onClose={onClose}
      className="ws-wide-dialog"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" type="submit" form="team-oidc-form" disabled={busy}>
            {busy ? <Spinner /> : null} Save
          </Button>
        </>
      }
    >
      <form id="team-oidc-form" className="stack" onSubmit={(e) => void save(e)} noValidate>
        <TextField
          label="Name"
          hint="What the sign-in button says: “Continue with <name>”."
          value={d.label}
          maxLength={100}
          onChange={(e) => set({ label: e.target.value })}
          error={fields.label}
        />
        {provider ? (
          <p className="ws-flush">
            <span className="muted">Issuer: </span>
            <code className="ws-code-inline team-break">{provider.issuer}</code>
            <span className="muted"> (to use another issuer, add a new provider)</span>
          </p>
        ) : (
          <TextField
            label="Issuer"
            hint="For example https://accounts.example.com"
            value={d.issuer}
            inputMode="url"
            autoComplete="off"
            spellCheck={false}
            onChange={(e) => set({ issuer: e.target.value })}
            error={fields.issuer}
          />
        )}
        <TextField
          label="Client id"
          value={d.clientId}
          autoComplete="off"
          spellCheck={false}
          onChange={(e) => set({ clientId: e.target.value })}
          error={fields.clientId}
        />
        {replacing ? (
          <TextField
            label="Client secret"
            type="password"
            hint={
              provider?.hasClientSecret
                ? 'Replaces the stored secret. Leave empty to keep it.'
                : 'Optional for public clients. It goes to the Hub’s vault and is never shown again.'
            }
            value={d.secret}
            autoComplete="new-password"
            onChange={(e) => set({ secret: e.target.value, removeSecret: false })}
          />
        ) : (
          <div className="ws-secret-row">
            <span>
              <span className="nv-field-label">Client secret</span>{' '}
              <span>{d.removeSecret ? 'Will be removed' : 'Set'}</span>
            </span>
            <Button variant="ghost" onClick={() => setReplacing(true)}>
              Replace
            </Button>
            {d.removeSecret ? (
              <Button variant="ghost" onClick={() => set({ removeSecret: false })}>
                Keep it
              </Button>
            ) : (
              <Button variant="ghost" onClick={() => set({ removeSecret: true })}>
                Remove secret
              </Button>
            )}
          </div>
        )}
        <TextField
          label="Scopes"
          hint="Separated by spaces; openid is required."
          value={d.scopes}
          spellCheck={false}
          onChange={(e) => set({ scopes: e.target.value })}
          error={fields.scopes}
        />
        {!provider ? (
          <SwitchField
            label="Allow signing in with it"
            description="You can turn it on later, after testing."
            checked={d.enabled}
            onChange={(v) => set({ enabled: v })}
          />
        ) : null}
        <FormError error={error} fallback="Could not save the provider." />
      </form>
    </Dialog>
  );
}
