// Credentials the egress proxy adds to requests (FR-193, ADR-063, docs/12 §5, §8): a name, the
// hosts that get it, how it is sent (bearer token, Basic sign-in, or a named header) and which
// sandboxes may use it. The value is write-only: it goes to the Hub's secret store, is never
// returned or shown, and can only be replaced.
import { useId, useRef, useState } from 'react';
import { fmt } from '@nova/i18n';
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
import { embed } from '../settings/embed.tsx';
import { HostListEditor } from './HostListEditor.tsx';
import { RULE_SCOPES, type ScopeTargets } from './scopes.ts';
import { CREDS_TEXT as S, EGRESS_TEXT } from './strings.ts';

type Scheme = EgressCredentialView['scheme'];

const SCHEMES: Scheme[] = ['bearer', 'basic', 'header'];

const RESERVED_HEADER =
  /^(host|connection|proxy-.*|content-length|transfer-encoding|te|upgrade|cookie)$/i;

/** Why a header name cannot carry a credential (the Hub's rule), or null. */
export function headerProblem(h: string): string | null {
  if (!h.trim()) return S.headerMissing;
  if (!/^[A-Za-z0-9-]{1,100}$/.test(h.trim())) return S.headerChars;
  if (RESERVED_HEADER.test(h.trim())) return S.headerReserved;
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
    c.scope ? S.onlyFor({ scope: label(c.scope.kind, c.scope.id) }) : S.forEvery;

  return (
    <section className="settings-section" aria-labelledby={headingId}>
      <h3 id={headingId}>{S.heading}</h3>
      <p className="muted">{S.intro}</p>
      {inspects === false ? (
        <p className="ws-warning" role="note">
          <Icon name="alert" /> {S.httpOnly}
        </p>
      ) : null}
      {error ? (
        <div role="alert" className="ws-error">
          <p>{error}</p>
          <Button onClick={onRetry}>{EGRESS_TEXT.retry}</Button>
        </div>
      ) : null}
      {items === null && !error ? <Spinner label={S.loading} /> : null}
      {items?.length === 0 ? <p className="ws-flush">{S.empty}</p> : null}
      {items?.length ? (
        <ul className="ws-list" aria-label={S.list}>
          {items.map((c) => (
            <li key={c.id} className="ws-list-row">
              <div className="network-row-main">
                <span className="ws-card-link" dir="auto">
                  {c.name}
                </span>
                <span className="muted ws-row-meta">
                  <span>{schemeText(c)}</span>
                  <span>{scopeText(c)}</span>
                  <span className="ws-badge" data-tone="ok">
                    <Icon name="check" /> {S.valueSet}
                  </span>
                  <span>{S.updated({ when: formatWhen(c.updatedAt) })}</span>
                </span>
                <span className="network-hosts">
                  {embed(S.sentToHosts, {
                    hosts: c.hosts.map((h, i) => (
                      <span key={h}>
                        {i ? ', ' : null}
                        <code dir="ltr">{h}</code>
                      </span>
                    )),
                  })}
                </span>
              </div>
              <span className="network-actions">
                <Button
                  aria-label={S.editName({ name: c.name })}
                  onClick={() => setDialog({ kind: 'edit', cred: c })}
                >
                  <Icon name="edit" /> {EGRESS_TEXT.edit}
                </Button>
                <Button
                  aria-label={S.replaceValueOf({ name: c.name })}
                  onClick={() => setDialog({ kind: 'value', cred: c })}
                >
                  {S.replaceValue}
                </Button>
                <Button
                  variant="ghost"
                  aria-label={S.deleteName({ name: c.name })}
                  onClick={() => setDialog({ kind: 'delete', cred: c })}
                >
                  <Icon name="trash" /> {EGRESS_TEXT.delete}
                </Button>
              </span>
            </li>
          ))}
        </ul>
      ) : null}
      <div>
        <Button onClick={() => setDialog({ kind: 'create' })}>
          <Icon name="plus" /> {S.add}
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
            toast.show(created ? S.added({ name: c.name }) : S.saved({ name: c.name }), {
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
            toast.show(S.replaced({ name: dialog.cred.name }), { tone: 'success' });
            onChanged();
          }}
        />
      ) : null}
      <Dialog
        open={dialog?.kind === 'delete'}
        title={S.deleteTitle}
        description={
          dialog?.kind === 'delete'
            ? S.deleteBody({ hosts: fmt.list(dialog.cred.hosts), name: dialog.cred.name })
            : undefined
        }
        onClose={() => setDialog(null)}
        footer={
          <>
            <Button onClick={() => setDialog(null)}>{EGRESS_TEXT.cancel}</Button>
            <Button
              variant="danger"
              onClick={() => {
                if (dialog?.kind !== 'delete') return;
                const c = dialog.cred;
                setDialog(null);
                api.deleteEgressCredential(c.id).then(
                  () => {
                    toast.show(S.deleted({ name: c.name }), { tone: 'success' });
                    onChanged();
                  },
                  (err: unknown) =>
                    toast.show(S.couldNotDelete({ error: errorMessage(err) }), { tone: 'error' }),
                );
              }}
            >
              {S.deleteCredential}
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
    name: name.trim() ? null : S.giveName,
    hosts: hosts.length ? null : S.addHost,
    header: scheme === 'header' ? headerProblem(header) : null,
    value: editing || value ? null : S.enterValue,
  };
  const valid = Object.values(problems).every((p) => p === null);

  // Options: every sandbox, then agents, runs and sessions; keep a current scope of another kind.
  const current = editing?.scope ?? null;
  const groups = RULE_SCOPES.map((k) => ({
    label: k === 'agent' ? S.agents : k === 'run' ? S.runs : S.sessions,
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
      setError(errorMessage(err, S.saveError));
      setBusy(false);
    }
  };

  return (
    <Dialog
      open
      title={editing ? S.editTitle({ name: editing.name }) : S.add}
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
          label={S.name}
          value={name}
          maxLength={100}
          placeholder={S.namePlaceholder}
          error={touched ? (problems.name ?? undefined) : undefined}
          onChange={(e) => setName(e.target.value)}
        />
        <HostListEditor
          label={S.sentTo}
          inputLabel={S.addSentTo}
          removeLabel={(host) => S.removeSentTo({ host })}
          hint={S.sentToHint}
          hosts={hosts}
          onChange={setHosts}
          emptyText={S.noHosts}
        />
        {touched && problems.hosts ? (
          <p className="nv-field-error" role="alert">
            {problems.hosts}
          </p>
        ) : null}
        <RadioGroup
          legend={S.howSent}
          name={`${id}-scheme`}
          value={scheme}
          options={SCHEMES.map((s) => ({
            value: s,
            label: S.scheme[s].label,
            description: S.scheme[s].description,
          }))}
          onChange={(v) => setScheme(v === 'basic' || v === 'header' ? v : 'bearer')}
        />
        {scheme === 'header' ? (
          <TextField
            label={S.headerName}
            value={header}
            maxLength={100}
            spellCheck={false}
            autoComplete="off"
            placeholder={S.headerPlaceholder}
            error={touched ? (problems.header ?? undefined) : undefined}
            onChange={(e) => setHeader(e.target.value)}
          />
        ) : null}
        {scheme === 'basic' ? (
          <TextField
            label={S.userName}
            value={username}
            maxLength={200}
            spellCheck={false}
            autoComplete="off"
            onChange={(e) => setUsername(e.target.value)}
          />
        ) : null}
        <SelectField
          label={S.whoGets}
          value={scope}
          onChange={setScope}
          hint={S.whoGetsHint}
          options={[
            { value: '', label: EGRESS_TEXT.everySandbox },
            ...(current && !known.has(scopeKey(current))
              ? [{ value: scopeKey(current), label: label(current.kind, current.id) }]
              : []),
          ]}
          groups={groups}
        />
        {editing ? (
          <p className="muted ws-flush">{S.valueStays}</p>
        ) : (
          <TextField
            label={S.value}
            type="password"
            autoComplete="new-password"
            value={value}
            maxLength={16_384}
            hint={S.writeOnly}
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
          <Button onClick={onClose}>{EGRESS_TEXT.cancel}</Button>
          <Button type="submit" variant="primary" disabled={busy}>
            {busy ? <Spinner /> : null} {editing ? EGRESS_TEXT.save : S.addCredential}
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
      setError(errorMessage(err, S.replaceError));
      setBusy(false);
    }
  };
  return (
    <Dialog
      open
      title={S.replaceTitle({ name: cred.name })}
      description={S.replaceBody}
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
          label={S.newValue}
          type="password"
          autoComplete="new-password"
          value={value}
          maxLength={16_384}
          hint={S.writeOnly}
          onChange={(e) => setValue(e.target.value)}
        />
        {error ? (
          <p className="nv-field-error" role="alert">
            {error}
          </p>
        ) : null}
        <div className="nv-dialog-footer">
          <Button onClick={onClose}>{EGRESS_TEXT.cancel}</Button>
          <Button type="submit" variant="primary" disabled={busy || !value}>
            {busy ? <Spinner /> : null} {S.replaceValue}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
