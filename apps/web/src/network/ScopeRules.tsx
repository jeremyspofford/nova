// Network rules for one agent, Work run or Code session (FR-102, docs/11 §7, docs/12 §8): extra
// allowed and blocked hosts, an access level that can only be stricter than the one for every
// sandbox, dev-server access to private addresses, and request rules (credential-stripping
// hooks) that can only tighten. A rule is saved whole (PUT), so its hooks are always sent back.
import { useId, useState } from 'react';
import {
  EGRESS_MODES,
  type EgressHook,
  type EgressModeView,
  type EgressScopeKind,
  type EgressScopeView,
} from '@nova/shared';
import { Button, Dialog, Icon, SelectField, Spinner, TextField, useToast } from '@nova/ui';
import { errorMessage } from '../api.ts';
import { useComputersApi } from '../computers/api.ts';
import { MODE_TEXT, scopeKindText } from '../computers/format.ts';
import { SwitchField } from '../settings/controls.tsx';
import { HostListEditor, hostProblem } from './HostListEditor.tsx';
import { RULE_SCOPES, type RuleScope, type ScopeTargets } from './scopes.ts';
import { ACCESS_TEXT, EGRESS_TEXT, HOSTS_TEXT, RULES_TEXT as S } from './strings.ts';

/** Strictness of an access level: a scope's mode only ever narrows (off < limited < allowlist). */
const RANK: Record<EgressModeView, number> = { off: 0, limited: 1, allowlist: 2 };

export function effectiveMode(global: EgressModeView, scope: EgressModeView | null) {
  return scope && RANK[scope] < RANK[global] ? scope : global;
}

const HOOK_ACTIONS: EgressHook['action'][] = ['strip_header', 'strip_cookies', 'block'];

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
      <h3 id={headingId}>{S.heading}</h3>
      <p className="muted">{S.intro}</p>
      {scopes.length === 0 ? <p className="ws-flush">{S.empty}</p> : null}
      {scopes.length ? (
        <ul className="ws-list" aria-label={S.list}>
          {scopes.map((s) => {
            const name = label(s.kind, s.id);
            const mode = effectiveMode(globalMode, s.mode);
            return (
              <li key={`${s.kind}:${s.id}`} className="ws-list-row">
                <div className="network-row-main">
                  <span className="ws-card-link" dir="auto">
                    {name}
                  </span>
                  <span className="muted ws-row-meta">
                    <span>
                      {!s.mode
                        ? S.sameAccess
                        : mode !== s.mode
                          ? S.narrowed({
                              mode: MODE_TEXT[s.mode].label,
                              applied: MODE_TEXT[mode].label,
                            })
                          : MODE_TEXT[s.mode].label}
                    </span>
                    <span>{S.moreAllowed({ n: s.allow.length })}</span>
                    <span>{S.blockedHosts({ n: s.deny.length })}</span>
                    {s.hooks.length ? <span>{S.requestRules({ n: s.hooks.length })}</span> : null}
                    {s.allowLocalBinding ? <span>{S.devServers}</span> : null}
                  </span>
                </div>
                <span className="network-actions">
                  <Button aria-label={S.editRule({ name })} onClick={() => setEditing(s)}>
                    <Icon name="edit" /> {EGRESS_TEXT.edit}
                  </Button>
                  <Button
                    variant="ghost"
                    aria-label={S.removeRule({ name })}
                    onClick={() => setRemoving(s)}
                  >
                    <Icon name="trash" /> {EGRESS_TEXT.remove}
                  </Button>
                </span>
              </li>
            );
          })}
        </ul>
      ) : null}
      <div>
        <Button onClick={() => setEditing('new')}>
          <Icon name="plus" /> {S.add}
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
            toast.show(S.saved({ name: label(v.kind, v.id) }), { tone: 'success' });
            onChanged();
          }}
        />
      ) : null}
      <Dialog
        open={removing !== null}
        title={S.removeTitle}
        description={
          removing ? S.removeBody({ name: label(removing.kind, removing.id) }) : undefined
        }
        onClose={() => setRemoving(null)}
        footer={
          <>
            <Button onClick={() => setRemoving(null)}>{EGRESS_TEXT.cancel}</Button>
            <Button
              variant="danger"
              onClick={() => {
                if (!removing) return;
                const r = removing;
                setRemoving(null);
                api.deleteEgressScope(r.kind, r.id).then(
                  () => {
                    toast.show(S.removed({ name: label(r.kind, r.id) }), { tone: 'success' });
                    onChanged();
                  },
                  (err: unknown) =>
                    toast.show(S.couldNotRemove({ error: errorMessage(err) }), { tone: 'error' }),
                );
              }}
            >
              {S.removeButton}
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
  const why = hostProblem(d.host);
  if (why) return { ok: false, error: S.hostProblem({ why }) };
  const methods = d.methods
    .split(/[\s,]+/)
    .filter(Boolean)
    .map((m) => m.toUpperCase());
  if (methods.some((m) => !/^[A-Z]{1,20}$/.test(m))) return { ok: false, error: S.methodsProblem };
  const path = d.pathPrefix.trim();
  if (path && !path.startsWith('/')) return { ok: false, error: S.pathProblem };
  const header = d.header.trim();
  if (d.action === 'strip_header' && !/^[A-Za-z0-9-]{1,100}$/.test(header))
    return { ok: false, error: S.headerProblem };
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
      setError(S.chooseTarget({ kind }));
      return;
    }
    const built: EgressHook[] = [];
    for (const [i, d] of hooks.entries()) {
      const r = hookFromDraft(d);
      if (!r.ok) {
        setError(S.hookError({ n: i + 1, error: r.error }));
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
      setError(errorMessage(err, S.saveError));
      setBusy(false);
    }
  };

  return (
    <Dialog
      open
      title={existing ? S.ruleFor({ name: label(existing.kind, existing.id) }) : S.addTitle}
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
              label={S.appliesTo}
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
                    ? S.allTaken
                    : S.noTargets({ kind })
                  : undefined
              }
              options={[
                {
                  value: '',
                  label: options === null ? S.loading : S.chooseOne({ kind }),
                },
                ...free.map((o) => ({ value: o.id, label: o.name })),
              ]}
            />
          </div>
        )}
        <SelectField
          label={S.access}
          value={mode}
          onChange={(v) =>
            setMode((EGRESS_MODES as readonly string[]).includes(v) ? (v as EgressModeView) : '')
          }
          options={[
            { value: '', label: S.sameAsEvery({ mode: MODE_TEXT[globalMode].label }) },
            ...(['limited', 'off', 'allowlist'] as const).map((m) => ({
              value: m,
              label: MODE_TEXT[m].label,
            })),
          ]}
          hint={
            mode && narrowed !== mode
              ? S.wider({ mode: MODE_TEXT[mode].label, applied: MODE_TEXT[narrowed].label })
              : mode
                ? MODE_TEXT[mode].description
                : undefined
          }
        />
        <HostListEditor
          label={S.moreAllowedHosts}
          inputLabel={S.addAllowed}
          removeLabel={(host) => S.removeAllowed({ host })}
          hosts={allow}
          onChange={setAllow}
          annotate={(h) => (deny.includes(h) ? ACCESS_TEXT.alsoBlocked : null)}
          emptyText={S.allowedEmpty}
        />
        <HostListEditor
          label={S.moreBlockedHosts}
          inputLabel={S.addBlocked}
          removeLabel={(host) => S.removeBlocked({ host })}
          hosts={deny}
          onChange={setDeny}
          emptyText={HOSTS_TEXT.none}
        />
        <SwitchField
          label={S.devServers}
          description={S.devServersDescription}
          checked={local}
          onChange={setLocal}
        />
        <details className="ws-advanced" open={hooks.length > 0 || undefined}>
          <summary>{S.requestRulesCount({ n: hooks.length })}</summary>
          <div className="stack">
            <p className="nv-field-hint ws-flush">{S.requestRulesHint}</p>
            {hooks.map((h, i) => (
              <fieldset key={h.key} className="ws-fieldset">
                <legend>{S.hookN({ n: i + 1 })}</legend>
                <div className="ws-preset-grid">
                  <SelectField
                    label={S.action}
                    value={h.action}
                    onChange={(v) =>
                      setHook(h.key, {
                        action: v === 'strip_cookies' || v === 'block' ? v : 'strip_header',
                      })
                    }
                    options={HOOK_ACTIONS.map((a) => ({ value: a, label: S.hookAction[a] }))}
                  />
                  <TextField
                    label={S.host}
                    value={h.host}
                    spellCheck={false}
                    autoComplete="off"
                    placeholder={S.hostPlaceholder}
                    onChange={(e) => setHook(h.key, { host: e.target.value })}
                  />
                  {h.action === 'strip_header' ? (
                    <TextField
                      label={S.header}
                      value={h.header}
                      spellCheck={false}
                      autoComplete="off"
                      placeholder={S.headerPlaceholder}
                      onChange={(e) => setHook(h.key, { header: e.target.value })}
                    />
                  ) : null}
                  <TextField
                    label={S.methods}
                    value={h.methods}
                    spellCheck={false}
                    autoComplete="off"
                    placeholder={S.methodsPlaceholder}
                    hint={S.methodsHint}
                    onChange={(e) => setHook(h.key, { methods: e.target.value })}
                  />
                  <TextField
                    label={S.path}
                    value={h.pathPrefix}
                    spellCheck={false}
                    autoComplete="off"
                    placeholder={S.pathPlaceholder}
                    onChange={(e) => setHook(h.key, { pathPrefix: e.target.value })}
                  />
                </div>
                <div>
                  <Button
                    variant="ghost"
                    onClick={() => setHooks((list) => list.filter((x) => x.key !== h.key))}
                  >
                    {S.removeHook({ n: i + 1 })}
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
                <Icon name="plus" /> {S.addHook}
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
          <Button onClick={onClose}>{EGRESS_TEXT.cancel}</Button>
          <Button type="submit" variant="primary" disabled={busy}>
            {busy ? <Spinner /> : null} {S.saveRule}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
