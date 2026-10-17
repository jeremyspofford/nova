// Credentials the egress proxy adds to requests (FR-193, ADR-063, docs/12 §5, §8): a name, the
// hosts that get it, how it is sent (bearer token, Basic sign-in, or a named header) and which
// sandboxes may use it. The value is write-only: it goes to the Hub's secret store, is never
// returned or shown, and can only be replaced.
import { useId, useRef, useState } from 'react';
import { EGRESS_SCOPE_KINDS, type EgressCredentialView, type EgressScopeKind } from '@nova/shared';
import {
  Button,
  Dialog,
  Icon,
  RadioGroup,
  SelectField,
  Spinner,
  TextField,
  useToast,
} from '@nova/ui';
import { errorMessage } from '../api.ts';
import { useComputersApi } from '../computers/api.ts';
import { schemeText } from '../computers/format.ts';
import { formatWhen } from '../settings/common.ts';
import { HostListEditor } from './HostListEditor.tsx';
import { RULE_SCOPES, type ScopeTargets } from './scopes.ts';

type Scheme = EgressCredentialView['scheme'];

const SCHEMES: { value: Scheme; label: string; description: string }[] = [
  {
    value: 'bearer',
    label: 'Bearer token',
    description: 'Sent as “Authorization: Bearer” and the value.',
  },
  {
    value: 'basic',
    label: 'User name and password',
    description: 'Sent as a Basic sign-in; the value is the password.',
  },
  {
    value: 'header',
    label: 'Custom header',
    description: 'Sent in a header you name, for example X-Api-Key.',
  },
];

const RESERVED_HEADER =
  /^(host|connection|proxy-.*|content-length|transfer-encoding|te|upgrade|cookie)$/i;

/** Why a header name cannot carry a credential (the Hub's rule), or null. */
export function headerProblem(h: string): string | null {
  if (!h.trim()) return 'Name the header, for example X-Api-Key.';
  if (!/^[A-Za-z0-9-]{1,100}$/.test(h.trim())) return 'Letters, digits and hyphens only.';
  if (RESERVED_HEADER.test(h.trim())) return 'This header cannot carry a credential.';
  return null;
}

function scopeKey(s: { kind: string; id: string } | null): string {
  return s ? `${s.kind}:${s.id}` : '';
}

function parseScopeKey(v: string): { kind: EgressScopeKind; id: string } | null {
  const at = v.indexOf(':');
  if (at < 0) return null;
  const kind = v.slice(0, at);
  const id = v.slice(at + 1);
  return (EGRESS_SCOPE_KINDS as readonly string[]).includes(kind) && id
    ? { kind: kind as EgressScopeKind, id }
    : null;
}

export function Credentials({
  items,
  error,
  inspects,
  targets,
  label,
  onRetry,
  onChanged,
}: {
  items: EgressCredentialView[] | null;
  error: string | null;
  inspects: boolean | null;
  targets: ScopeTargets;
  label: (kind: string, id: string) => string;
  onRetry: () => void;
  onChanged: () => void;
}) {
  const api = useComputersApi();
  const toast = useToast();
  const headingId = useId();
  const [dialog, setDialog] = useState<
    | { kind: 'create' }
    | { kind: 'edit'; cred: EgressCredentialView }
    | { kind: 'value'; cred: EgressCredentialView }
    | { kind: 'delete'; cred: EgressCredentialView }
    | null
  >(null);

  const scopeText = (c: EgressCredentialView) =>
    c.scope ? `Only for ${label(c.scope.kind, c.scope.id)}` : 'For every sandbox';

  return (
    <section className="settings-section" aria-labelledby={headingId}>
      <h3 id={headingId}>Credentials the proxy adds</h3>
      <p className="muted">
        Nova adds a credential to requests to its hosts, so the secret never enters a sandbox.
        Values are kept in the Hub&apos;s secret store and are never shown again.
      </p>
      {inspects === false ? (
        <p className="ws-warning" role="note">
          <Icon name="alert" /> HTTPS inspection is off, so credentials are added to plain HTTP
          requests only.
        </p>
      ) : null}
      {error ? (
        <div role="alert" className="ws-error">
          <p>{error}</p>
          <Button onClick={onRetry}>Retry</Button>
        </div>
      ) : null}
      {items === null && !error ? <Spinner label="Loading credentials" /> : null}
      {items?.length === 0 ? <p className="ws-flush">No credentials yet.</p> : null}
      {items?.length ? (
        <ul className="ws-list" aria-label="Credentials">
          {items.map((c) => (
            <li key={c.id} className="ws-list-row">
              <div className="network-row-main">
                <span className="ws-card-link">{c.name}</span>
                <span className="muted ws-row-meta">
                  <span>{schemeText(c)}</span>
                  <span>{scopeText(c)}</span>
                  <span className="ws-badge" data-tone="ok">
                    <Icon name="check" /> Value set
                  </span>
                  <span>Updated {formatWhen(c.updatedAt)}</span>
                </span>
                <span className="network-hosts">
                  Sent to:{' '}
                  {c.hosts.map((h, i) => (
                    <span key={h}>
                      {i ? ', ' : null}
                      <code>{h}</code>
                    </span>
                  ))}
                </span>
              </div>
              <span className="network-actions">
                <Button
                  aria-label={`Edit ${c.name}`}
                  onClick={() => setDialog({ kind: 'edit', cred: c })}
                >
                  <Icon name="edit" /> Edit
                </Button>
                <Button
                  aria-label={`Replace the value of ${c.name}`}
                  onClick={() => setDialog({ kind: 'value', cred: c })}
                >
                  Replace value
                </Button>
                <Button
                  variant="ghost"
                  aria-label={`Delete ${c.name}`}
                  onClick={() => setDialog({ kind: 'delete', cred: c })}
                >
                  <Icon name="trash" /> Delete
                </Button>
              </span>
            </li>
          ))}
        </ul>
      ) : null}
      <div>
        <Button onClick={() => setDialog({ kind: 'create' })}>
          <Icon name="plus" /> Add a credential
        </Button>
      </div>
      {dialog?.kind === 'create' || dialog?.kind === 'edit' ? (
        <CredentialDialog
          editing={dialog.kind === 'edit' ? dialog.cred : null}
          targets={targets}
          label={label}
          onClose={() => setDialog(null)}
          onSaved={(c, created) => {
            setDialog(null);
            toast.show(created ? `Added “${c.name}”.` : `Saved “${c.name}”.`, {
              tone: 'success',
            });
            onChanged();
          }}
        />
      ) : null}
      {dialog?.kind === 'value' ? (
        <ReplaceValueDialog
          cred={dialog.cred}
          onClose={() => setDialog(null)}
          onSaved={() => {
            setDialog(null);
            toast.show(`Replaced the value of “${dialog.cred.name}”.`, { tone: 'success' });
            onChanged();
          }}
        />
      ) : null}
      <Dialog
        open={dialog?.kind === 'delete'}
        title="Delete this credential?"
        description={
          dialog?.kind === 'delete'
            ? `Requests to ${dialog.cred.hosts.join(', ')} no longer get “${dialog.cred.name}”, and its value is removed from the secret store. This cannot be undone.`
            : undefined
        }
        onClose={() => setDialog(null)}
        footer={
          <>
            <Button onClick={() => setDialog(null)}>Cancel</Button>
            <Button
              variant="danger"
              onClick={() => {
                if (dialog?.kind !== 'delete') return;
                const c = dialog.cred;
                setDialog(null);
                api.deleteEgressCredential(c.id).then(
                  () => {
                    toast.show(`Deleted “${c.name}”.`, { tone: 'success' });
                    onChanged();
                  },
                  (err: unknown) =>
                    toast.show(`Could not delete it: ${errorMessage(err)}`, { tone: 'error' }),
                );
              }}
            >
              Delete credential
            </Button>
          </>
        }
      />
    </section>
  );
}

function CredentialDialog({
  editing,
  targets,
  label,
  onClose,
  onSaved,
}: {
  editing: EgressCredentialView | null;
  targets: ScopeTargets;
  label: (kind: string, id: string) => string;
  onClose: () => void;
  onSaved: (c: EgressCredentialView, created: boolean) => void;
}) {
  const api = useComputersApi();
  const id = useId();
  const nameRef = useRef<HTMLInputElement>(null);
  const [name, setName] = useState(editing?.name ?? '');
  const [hosts, setHosts] = useState<string[]>(editing?.hosts ?? []);
  const [scheme, setScheme] = useState<Scheme>(editing?.scheme ?? 'bearer');
  const [header, setHeader] = useState(editing?.header ?? '');
  const [username, setUsername] = useState(editing?.username ?? '');
  const [scope, setScope] = useState(scopeKey(editing?.scope ?? null));
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [touched, setTouched] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const problems = {
    name: name.trim() ? null : 'Give it a name.',
    hosts: hosts.length ? null : 'Add at least one host.',
    header: scheme === 'header' ? headerProblem(header) : null,
    value: editing || value ? null : 'Enter the value.',
  };
  const valid = Object.values(problems).every((p) => p === null);

  // Options: every sandbox, then agents, runs and sessions; keep a current scope of another kind.
  const current = editing?.scope ?? null;
  const groups = RULE_SCOPES.map((k) => ({
    label: k === 'agent' ? 'Agents' : k === 'run' ? 'Work runs' : 'Code sessions',
    options: (targets[k] ?? []).map((o) => ({ value: `${k}:${o.id}`, label: o.name })),
  })).filter((g) => g.options.length);
  const known = new Set(groups.flatMap((g) => g.options.map((o) => o.value)));

  const submit = async () => {
    setTouched(true);
    if (!valid || busy) return;
    setBusy(true);
    setError(null);
    const fields = {
      name: name.trim(),
      hosts,
      scheme,
      header: scheme === 'header' ? header.trim() : null,
      username: scheme === 'basic' && username.trim() ? username.trim() : null,
      scope: parseScopeKey(scope),
    };
    try {
      if (!editing) {
        onSaved(await api.createEgressCredential({ ...fields, value }), true);
        return;
      }
      // Only what changed; the Hub refuses an empty update.
      const patch: Parameters<typeof api.updateEgressCredential>[1] = {};
      if (fields.name !== editing.name) patch.name = fields.name;
      if (fields.hosts.join('\n') !== editing.hosts.join('\n')) patch.hosts = fields.hosts;
      if (fields.scheme !== editing.scheme) patch.scheme = fields.scheme;
      if (fields.header !== editing.header) patch.header = fields.header;
      if (fields.username !== editing.username) patch.username = fields.username;
      if (scopeKey(fields.scope) !== scopeKey(editing.scope)) patch.scope = fields.scope;
      if (!Object.keys(patch).length) {
        onClose();
        return;
      }
      onSaved(await api.updateEgressCredential(editing.id, patch), false);
    } catch (err) {
      setError(errorMessage(err, 'Could not save the credential.'));
      setBusy(false);
    }
  };

  return (
    <Dialog
      open
      title={editing ? `Edit “${editing.name}”` : 'Add a credential'}
      className="ws-wide-dialog"
      onClose={onClose}
      initialFocusRef={nameRef}
    >
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <TextField
          ref={nameRef}
          label="Name"
          value={name}
          maxLength={100}
          placeholder="Weather API"
          error={touched ? (problems.name ?? undefined) : undefined}
          onChange={(e) => setName(e.target.value)}
        />
        <HostListEditor
          label="Sent to"
          inputLabel="Add a host that gets this credential"
          hint="Only requests to these hosts get it. Use *.example.com for subdomains."
          hosts={hosts}
          onChange={setHosts}
          emptyText="No hosts yet."
        />
        {touched && problems.hosts ? (
          <p className="nv-field-error" role="alert">
            {problems.hosts}
          </p>
        ) : null}
        <RadioGroup
          legend="How it is sent"
          name={`${id}-scheme`}
          value={scheme}
          options={SCHEMES}
          onChange={(v) => setScheme(v === 'basic' || v === 'header' ? v : 'bearer')}
        />
        {scheme === 'header' ? (
          <TextField
            label="Header name"
            value={header}
            maxLength={100}
            spellCheck={false}
            autoComplete="off"
            placeholder="X-Api-Key"
            error={touched ? (problems.header ?? undefined) : undefined}
            onChange={(e) => setHeader(e.target.value)}
          />
        ) : null}
        {scheme === 'basic' ? (
          <TextField
            label="User name (optional)"
            value={username}
            maxLength={200}
            spellCheck={false}
            autoComplete="off"
            onChange={(e) => setUsername(e.target.value)}
          />
        ) : null}
        <SelectField
          label="Who gets it"
          value={scope}
          onChange={setScope}
          hint="Limit it to one agent, run or session, or let every sandbox use it."
          options={[
            { value: '', label: 'Every sandbox' },
            ...(current && !known.has(scopeKey(current))
              ? [{ value: scopeKey(current), label: label(current.kind, current.id) }]
              : []),
          ]}
          groups={groups}
        />
        {editing ? (
          <p className="muted ws-flush">
            The value stays as it is. Use Replace value to change it.
          </p>
        ) : (
          <TextField
            label="Value"
            type="password"
            autoComplete="new-password"
            value={value}
            maxLength={16_384}
            hint="Write-only: it is never shown again after you save."
            error={touched ? (problems.value ?? undefined) : undefined}
            onChange={(e) => setValue(e.target.value)}
          />
        )}
        {error ? (
          <p className="nv-field-error" role="alert">
            {error}
          </p>
        ) : null}
        <div className="nv-dialog-footer">
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" disabled={busy}>
            {busy ? <Spinner /> : null} {editing ? 'Save' : 'Add credential'}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

function ReplaceValueDialog({
  cred,
  onClose,
  onSaved,
}: {
  cred: EgressCredentialView;
  onClose: () => void;
  onSaved: () => void;
}) {
  const api = useComputersApi();
  const ref = useRef<HTMLInputElement>(null);
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async () => {
    if (!value || busy) return;
    setBusy(true);
    setError(null);
    try {
      await api.updateEgressCredential(cred.id, { value });
      setValue('');
      onSaved();
    } catch (err) {
      setError(errorMessage(err, 'Could not replace the value.'));
      setBusy(false);
    }
  };
  return (
    <Dialog
      open
      title={`Replace the value of “${cred.name}”`}
      description="The new value replaces the stored one at once. The old value cannot be recovered."
      onClose={onClose}
      initialFocusRef={ref}
    >
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <TextField
          ref={ref}
          label="New value"
          type="password"
          autoComplete="new-password"
          value={value}
          maxLength={16_384}
          hint="Write-only: it is never shown again after you save."
          onChange={(e) => setValue(e.target.value)}
        />
        {error ? (
          <p className="nv-field-error" role="alert">
            {error}
          </p>
        ) : null}
        <div className="nv-dialog-footer">
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" disabled={busy || !value}>
            {busy ? <Spinner /> : null} Replace value
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
