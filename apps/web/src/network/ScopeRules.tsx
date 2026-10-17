// Network rules for one agent, Work run or Code session (FR-102, docs/11 §7, docs/12 §8): extra
// allowed and blocked hosts, an access level that can only be stricter than the one for every
// sandbox, dev-server access to private addresses, and request rules (credential-stripping
// hooks) that can only tighten. A rule is saved whole (PUT), so its hooks are always sent back.
import { useId, useState } from 'react';
import {
  EGRESS_MODES,
  checkHostPattern,
  type EgressHook,
  type EgressModeView,
  type EgressScopeKind,
  type EgressScopeView,
} from '@nova/shared';
import { Button, Dialog, Icon, SelectField, Spinner, TextField, useToast } from '@nova/ui';
import { errorMessage } from '../api.ts';
import { useComputersApi } from '../computers/api.ts';
import { MODE_TEXT, scopeKindText } from '../computers/format.ts';
import { plural } from '../settings/common.ts';
import { SwitchField } from '../settings/controls.tsx';
import { HostListEditor } from './HostListEditor.tsx';
import { RULE_SCOPES, type RuleScope, type ScopeTargets } from './scopes.ts';

/** Strictness of an access level: a scope's mode only ever narrows (off < limited < allowlist). */
const RANK: Record<EgressModeView, number> = { off: 0, limited: 1, allowlist: 2 };

export function effectiveMode(global: EgressModeView, scope: EgressModeView | null) {
  return scope && RANK[scope] < RANK[global] ? scope : global;
}

const HOOK_ACTIONS: Record<EgressHook['action'], string> = {
  strip_header: 'Remove a header',
  strip_cookies: 'Remove cookies',
  block: 'Block the request',
};

export function ScopeRules({
  scopes,
  globalMode,
  targets,
  label,
  onChanged,
}: {
  scopes: EgressScopeView[];
  globalMode: EgressModeView;
  targets: ScopeTargets;
  label: (kind: string, id: string) => string;
  /** The rule list changed (reload the egress view). */
  onChanged: () => void;
}) {
  const api = useComputersApi();
  const toast = useToast();
  const headingId = useId();
  const [editing, setEditing] = useState<EgressScopeView | 'new' | null>(null);
  const [removing, setRemoving] = useState<EgressScopeView | null>(null);

  return (
    <section className="settings-section" aria-labelledby={headingId}>
      <h3 id={headingId}>Rules for one agent, run or session</h3>
      <p className="muted">
        A rule allows more hosts, or blocks more, for one agent, Work run or Code session. Its
        access can only be stricter than the access above, never wider.
      </p>
      {scopes.length === 0 ? <p className="ws-flush">No rules yet.</p> : null}
      {scopes.length ? (
        <ul className="ws-list" aria-label="Network rules">
          {scopes.map((s) => {
            const name = label(s.kind, s.id);
            const mode = effectiveMode(globalMode, s.mode);
            return (
              <li key={`${s.kind}:${s.id}`} className="ws-list-row">
                <div className="network-row-main">
                  <span className="ws-card-link">{name}</span>
                  <span className="muted ws-row-meta">
                    <span>
                      {s.mode ? MODE_TEXT[s.mode].label : 'Same access as above'}
                      {s.mode && mode !== s.mode ? ` (${MODE_TEXT[mode].label} applies)` : ''}
                    </span>
                    <span>{plural(s.allow.length, 'more allowed host')}</span>
                    <span>{plural(s.deny.length, 'blocked host')}</span>
                    {s.hooks.length ? <span>{plural(s.hooks.length, 'request rule')}</span> : null}
                    {s.allowLocalBinding ? <span>Dev servers on private addresses</span> : null}
                  </span>
                </div>
                <span className="network-actions">
                  <Button aria-label={`Edit the rule for ${name}`} onClick={() => setEditing(s)}>
                    <Icon name="edit" /> Edit
                  </Button>
                  <Button
                    variant="ghost"
                    aria-label={`Remove the rule for ${name}`}
                    onClick={() => setRemoving(s)}
                  >
                    <Icon name="trash" /> Remove
                  </Button>
                </span>
              </li>
            );
          })}
        </ul>
      ) : null}
      <div>
        <Button onClick={() => setEditing('new')}>
          <Icon name="plus" /> Add a rule
        </Button>
      </div>
      {editing ? (
        <ScopeDialog
          existing={editing === 'new' ? null : editing}
          taken={new Set(scopes.map((s) => `${s.kind}:${s.id}`))}
          globalMode={globalMode}
          targets={targets}
          label={label}
          onClose={() => setEditing(null)}
          onSaved={(v) => {
            setEditing(null);
            toast.show(`Saved the rule for ${label(v.kind, v.id)}.`, { tone: 'success' });
            onChanged();
          }}
        />
      ) : null}
      <Dialog
        open={removing !== null}
        title="Remove this rule?"
        description={
          removing
            ? `${label(removing.kind, removing.id)} goes back to the access for every sandbox. Hosts allowed only by this rule are no longer reachable from it.`
            : undefined
        }
        onClose={() => setRemoving(null)}
        footer={
          <>
            <Button onClick={() => setRemoving(null)}>Cancel</Button>
            <Button
              variant="danger"
              onClick={() => {
                if (!removing) return;
                const r = removing;
                setRemoving(null);
                api.deleteEgressScope(r.kind, r.id).then(
                  () => {
                    toast.show(`Removed the rule for ${label(r.kind, r.id)}.`, { tone: 'success' });
                    onChanged();
                  },
                  (err: unknown) =>
                    toast.show(`Could not remove it: ${errorMessage(err)}`, { tone: 'error' }),
                );
              }}
            >
              Remove rule
            </Button>
          </>
        }
      />
    </section>
  );
}

export interface HookDraft {
  key: string;
  id: string;
  action: EgressHook['action'];
  host: string;
  header: string;
  methods: string;
  pathPrefix: string;
}

let hookSeq = 0;
const hookId = () => `hook-${Date.now().toString(36)}-${(++hookSeq).toString(36)}`;

function toDraft(h: EgressHook): HookDraft {
  return {
    key: hookId(),
    id: h.id,
    action: h.action,
    host: h.host,
    header: h.header ?? '',
    methods: (h.methods ?? []).join(', '),
    pathPrefix: h.pathPrefix ?? '',
  };
}

/** The hook as the Hub takes it, or why not. */
export function hookFromDraft(
  d: HookDraft,
): { ok: true; hook: EgressHook } | { ok: false; error: string } {
  const why = checkHostPattern(d.host);
  if (why) return { ok: false, error: `Host: ${why}.` };
  const methods = d.methods
    .split(/[\s,]+/)
    .filter(Boolean)
    .map((m) => m.toUpperCase());
  if (methods.some((m) => !/^[A-Z]{1,20}$/.test(m)))
    return { ok: false, error: 'Methods: letters only, for example POST, PUT.' };
  const path = d.pathPrefix.trim();
  if (path && !path.startsWith('/')) return { ok: false, error: 'Path must start with /.' };
  const header = d.header.trim();
  if (d.action === 'strip_header' && !/^[A-Za-z0-9-]{1,100}$/.test(header))
    return { ok: false, error: 'Name the header to remove, for example Authorization.' };
  return {
    ok: true,
    hook: {
      id: d.id,
      host: d.host.trim().toLowerCase().replace(/\.$/, ''),
      action: d.action,
      ...(methods.length ? { methods } : {}),
      ...(path ? { pathPrefix: path } : {}),
      ...(d.action === 'strip_header' ? { header } : {}),
    },
  };
}

function ScopeDialog({
  existing,
  taken,
  globalMode,
  targets,
  label,
  onClose,
  onSaved,
}: {
  existing: EgressScopeView | null;
  taken: Set<string>;
  globalMode: EgressModeView;
  targets: ScopeTargets;
  label: (kind: string, id: string) => string;
  onClose: () => void;
  onSaved: (v: EgressScopeView) => void;
}) {
  const api = useComputersApi();
  const formId = useId();
  const [kind, setKind] = useState<RuleScope>('agent');
  const [targetId, setTargetId] = useState('');
  const [mode, setMode] = useState<EgressModeView | ''>(existing?.mode ?? '');
  const [allow, setAllow] = useState<string[]>(existing?.allow ?? []);
  const [deny, setDeny] = useState<string[]>(existing?.deny ?? []);
  const [local, setLocal] = useState(existing?.allowLocalBinding ?? false);
  const [hooks, setHooks] = useState<HookDraft[]>(() => (existing?.hooks ?? []).map(toDraft));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const options = targets[kind];
  const free = (options ?? []).filter((o) => !taken.has(`${kind}:${o.id}`));
  const chosen = existing ? existing.id : targetId;
  const narrowed = mode ? effectiveMode(globalMode, mode) : globalMode;

  const setHook = (key: string, patch: Partial<HookDraft>) =>
    setHooks((list) => list.map((h) => (h.key === key ? { ...h, ...patch } : h)));

  const submit = async () => {
    if (busy) return;
    if (!chosen) {
      setError(`Choose the ${scopeKindText(kind).toLowerCase()} this rule is for.`);
      return;
    }
    const built: EgressHook[] = [];
    for (const [i, d] of hooks.entries()) {
      const r = hookFromDraft(d);
      if (!r.ok) {
        setError(`Request rule ${i + 1}: ${r.error}`);
        return;
      }
      built.push(r.hook);
    }
    setBusy(true);
    setError(null);
    try {
      const k: EgressScopeKind = existing ? existing.kind : kind;
      onSaved(
        await api.putEgressScope(k, chosen, {
          mode: mode || null,
          allow,
          deny,
          hooks: built,
          allowLocalBinding: local,
        }),
      );
    } catch (err) {
      setError(errorMessage(err, 'Could not save the rule.'));
      setBusy(false);
    }
  };

  return (
    <Dialog
      open
      title={existing ? `Rule for ${label(existing.kind, existing.id)}` : 'Add a network rule'}
      className="ws-wide-dialog"
      onClose={onClose}
    >
      <form
        id={formId}
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        {existing ? null : (
          <div className="ws-preset-grid">
            <SelectField
              label="Applies to"
              value={kind}
              onChange={(v) => {
                setKind(
                  (RULE_SCOPES as readonly string[]).includes(v) ? (v as RuleScope) : 'agent',
                );
                setTargetId('');
              }}
              options={RULE_SCOPES.map((k) => ({ value: k, label: scopeKindText(k) }))}
            />
            <SelectField
              label={scopeKindText(kind)}
              value={targetId}
              disabled={options === null || free.length === 0}
              onChange={setTargetId}
              hint={
                options !== null && free.length === 0
                  ? options.length
                    ? 'Each of them already has a rule; edit it instead.'
                    : `There is no ${scopeKindText(kind).toLowerCase()} yet.`
                  : undefined
              }
              options={[
                {
                  value: '',
                  label:
                    options === null ? 'Loading…' : `Choose a ${scopeKindText(kind).toLowerCase()}`,
                },
                ...free.map((o) => ({ value: o.id, label: o.name })),
              ]}
            />
          </div>
        )}
        <SelectField
          label="Access"
          value={mode}
          onChange={(v) =>
            setMode((EGRESS_MODES as readonly string[]).includes(v) ? (v as EgressModeView) : '')
          }
          options={[
            { value: '', label: `Same as for every sandbox (${MODE_TEXT[globalMode].label})` },
            ...(['limited', 'off', 'allowlist'] as const).map((m) => ({
              value: m,
              label: MODE_TEXT[m].label,
            })),
          ]}
          hint={
            mode && narrowed !== mode
              ? `${MODE_TEXT[mode].label} is wider than the access for every sandbox, so ${MODE_TEXT[narrowed].label} still applies.`
              : mode
                ? MODE_TEXT[mode].description
                : undefined
          }
        />
        <HostListEditor
          label="More allowed hosts"
          inputLabel="Add an allowed host for this rule"
          hosts={allow}
          onChange={setAllow}
          annotate={(h) => (deny.includes(h) ? 'Also blocked: blocking wins' : null)}
          emptyText="None: only the hosts allowed for every sandbox."
        />
        <HostListEditor
          label="More blocked hosts"
          inputLabel="Add a blocked host for this rule"
          hosts={deny}
          onChange={setDeny}
          emptyText="None."
        />
        <SwitchField
          label="Dev servers on private addresses"
          description="Lets commands reach private and loopback addresses, only for the hosts and ports a dev-server grant covers."
          checked={local}
          onChange={setLocal}
        />
        <details className="ws-advanced" open={hooks.length > 0 || undefined}>
          <summary>Request rules ({hooks.length})</summary>
          <div className="stack">
            <p className="nv-field-hint ws-flush">
              Remove a header or cookies from matching HTTPS requests, or block them. Request rules
              can only make access stricter.
            </p>
            {hooks.map((h, i) => (
              <fieldset key={h.key} className="ws-fieldset">
                <legend>Request rule {i + 1}</legend>
                <div className="ws-preset-grid">
                  <SelectField
                    label="Action"
                    value={h.action}
                    onChange={(v) =>
                      setHook(h.key, {
                        action: v === 'strip_cookies' || v === 'block' ? v : 'strip_header',
                      })
                    }
                    options={Object.entries(HOOK_ACTIONS).map(([value, text]) => ({
                      value,
                      label: text,
                    }))}
                  />
                  <TextField
                    label="Host"
                    value={h.host}
                    spellCheck={false}
                    autoComplete="off"
                    placeholder="api.github.com"
                    onChange={(e) => setHook(h.key, { host: e.target.value })}
                  />
                  {h.action === 'strip_header' ? (
                    <TextField
                      label="Header"
                      value={h.header}
                      spellCheck={false}
                      autoComplete="off"
                      placeholder="Authorization"
                      onChange={(e) => setHook(h.key, { header: e.target.value })}
                    />
                  ) : null}
                  <TextField
                    label="Methods (optional)"
                    value={h.methods}
                    spellCheck={false}
                    autoComplete="off"
                    placeholder="POST, PUT"
                    hint="Empty: every method."
                    onChange={(e) => setHook(h.key, { methods: e.target.value })}
                  />
                  <TextField
                    label="Path starts with (optional)"
                    value={h.pathPrefix}
                    spellCheck={false}
                    autoComplete="off"
                    placeholder="/repos/"
                    onChange={(e) => setHook(h.key, { pathPrefix: e.target.value })}
                  />
                </div>
                <div>
                  <Button
                    variant="ghost"
                    onClick={() => setHooks((list) => list.filter((x) => x.key !== h.key))}
                  >
                    Remove request rule {i + 1}
                  </Button>
                </div>
              </fieldset>
            ))}
            <div>
              <Button
                onClick={() =>
                  setHooks((list) => [
                    ...list,
                    {
                      key: hookId(),
                      id: hookId(),
                      action: 'strip_header',
                      host: '',
                      header: 'Authorization',
                      methods: '',
                      pathPrefix: '',
                    },
                  ])
                }
              >
                <Icon name="plus" /> Add a request rule
              </Button>
            </div>
          </div>
        </details>
        {error ? (
          <p className="nv-field-error" role="alert">
            {error}
          </p>
        ) : null}
        <div className="nv-dialog-footer">
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" disabled={busy}>
            {busy ? <Spinner /> : null} Save rule
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
