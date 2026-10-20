// Policy rules in Settings → Permissions (FR-084 partial, docs/12 §3): list, add, edit, delete
// and enable. Rules are instructions the engine follows; they never override built-in safety and
// cannot pre-approve actions that must be confirmed. Managed rules are read-only.
import { useEffect, useId, useState } from 'react';
import { defineMessages, fmt } from '@nova/i18n';
import type { ActionEffectClass, PolicyEffect, PolicyRuleView, ProjectView } from '@nova/shared';
import {
  Button,
  Dialog,
  Icon,
  RadioGroup,
  SelectField,
  Spinner,
  Switch,
  TextField,
  useToast,
} from '@nova/ui';
import { errorMessage, type CreatePolicyRuleRequest } from '../api.ts';
import { useServices } from '../services.tsx';
import { ManagedNote } from '../managed/ManagedNote.tsx';
import { EFFECT_CLASS_PHRASE, EFFECT_CLASS_TEXT, RULE_EFFECT_TEXT } from './policy-text.ts';
import '../workspace.css';

export const POLICY_RULES_TEXT = defineMessages('settings.policyRules', {
  tool: 'tool {tool}',
  resource: 'resource {resource}',
  everyAction: 'every action',
  scope: {
    global: 'Everywhere',
    project: 'Project: {name}',
    thread: 'One chat ({ref})',
    tool: 'Tool: {ref}',
    site: 'Website: {ref}',
  },
  loadFailed: 'Could not load the rules.',
  changeFailed: 'Could not change the rule: {error}',
  deleted: 'Rule deleted.',
  deleteFailed: 'Could not delete the rule: {error}',
  title: 'Rules',
  intro:
    'Tell Nova when to act on its own, when to ask, and when to hand a step to you. Rules ' +
    'never override built-in safety.',
  addRule: 'Add rule',
  retry: 'Retry',
  loading: 'Loading rules',
  none: 'No rules yet.',
  priorityN: 'Priority {n}',
  fromPlugin: 'From a plugin',
  toggle: 'Use rule: {title}',
  edit: 'Edit',
  delete: 'Delete',
  addTitle: 'Add a rule',
  editTitle: 'Edit rule',
  added: 'Rule added.',
  saved: 'Rule saved.',
  deleteTitle: 'Delete this rule?',
  deleteBody: 'Nova goes back to the tool defaults and your other rules for what it matched.',
  cancel: 'Cancel',
  needMatch: 'Name a tool, a resource or a kind of action so the rule matches something.',
  chooseProject: 'Choose a project.',
  needRef: 'Enter what it applies to.',
  priorityRange: 'Enter a whole number from 0 to {max}.',
  saveFailed: 'Could not save the rule.',
  everywhere: 'Everywhere',
  oneProject: 'One project',
  oneSite: 'One website',
  oneChat: 'One chat',
  oneTool: 'One tool',
  name: 'Name',
  nameHint: 'Optional, for example Ask before messaging customers.',
  whatNovaDoes: 'What Nova does',
  whichActions: 'Which actions',
  toolLabel: 'Tool',
  toolHint: 'A tool name, or a pattern such as mcp:github.*. Empty matches any tool.',
  resourceLabel: 'Resource',
  resourceHint: 'A path, host or address pattern. Optional.',
  kinds: 'Kinds of action',
  appliesTo: 'Applies to',
  project: 'Project',
  pickProject: 'Choose a project',
  website: 'Website',
  chat: 'Chat',
  advanced: 'Advanced',
  priority: 'Priority',
  priorityHint: '0 to 1000, default 100. Used to order rules when several match.',
  saveRule: 'Save rule',
});
const S = POLICY_RULES_TEXT;
// Examples typed into fields: patterns, the same in every language.
const TOOL_EXAMPLE = 'fs.write';
const RESOURCE_EXAMPLE = '*.example.com';
const SITE_EXAMPLE = 'shop.example.com';

const EFFECTS: PolicyEffect[] = ['allow', 'ask', 'handoff', 'deny'];

export function ruleSummary(r: Pick<PolicyRuleView, 'match'>): string {
  const parts = [
    r.match.tool ? S.tool({ tool: r.match.tool }) : null,
    r.match.resource ? S.resource({ resource: r.match.resource }) : null,
    r.match.effects?.length
      ? fmt.list(
          r.match.effects.map((e) => EFFECT_CLASS_PHRASE[e]),
          { type: 'unit' },
        )
      : null,
  ].filter(Boolean);
  return parts.length ? parts.join(' · ') : S.everyAction;
}

function scopeText(r: PolicyRuleView, projects: ProjectView[]): string {
  const ref = r.scopeRef ?? '?';
  switch (r.scopeKind) {
    case 'global':
      return S.scope.global;
    case 'project':
      return S.scope.project({ name: projects.find((p) => p.id === r.scopeRef)?.name ?? ref });
    case 'thread':
      return S.scope.thread({ ref });
    case 'tool':
      return S.scope.tool({ ref });
    case 'site':
      return S.scope.site({ ref });
  }
}

export function PolicyRulesSection() {
  const { api } = useServices();
  const toast = useToast();
  const [rules, setRules] = useState<PolicyRuleView[] | null>(null);
  const [projects, setProjects] = useState<ProjectView[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  const [editing, setEditing] = useState<PolicyRuleView | 'new' | null>(null);
  const [deleting, setDeleting] = useState<PolicyRuleView | null>(null);

  useEffect(() => {
    let alive = true;
    api.listPolicyRules().then(
      ({ items }) => {
        if (!alive) return;
        setRules(items);
        setError(null);
      },
      (err: unknown) => alive && setError(errorMessage(err, S.loadFailed)),
    );
    api.listProjects().then(
      ({ items }) => alive && setProjects(items),
      () => undefined, // project names are a nicety; ids still show
    );
    return () => {
      alive = false;
    };
  }, [api, version]);

  const replace = (r: PolicyRuleView) =>
    setRules((list) => {
      const rest = list ?? [];
      return rest.some((x) => x.id === r.id)
        ? rest.map((x) => (x.id === r.id ? r : x))
        : [...rest, r];
    });

  const toggle = async (r: PolicyRuleView, enabled: boolean) => {
    try {
      replace(await api.updatePolicyRule(r.id, { enabled }));
    } catch (err) {
      toast.show(S.changeFailed({ error: errorMessage(err) }), { tone: 'error' });
    }
  };

  const remove = async (r: PolicyRuleView) => {
    setDeleting(null);
    try {
      await api.deletePolicyRule(r.id);
      setRules((list) => list?.filter((x) => x.id !== r.id) ?? null);
      toast.show(S.deleted, { tone: 'success' });
    } catch (err) {
      toast.show(S.deleteFailed({ error: errorMessage(err) }), { tone: 'error' });
    }
  };

  return (
    <section className="settings-section" aria-labelledby="perm-rules">
      <h3 id="perm-rules">{S.title}</h3>
      <p className="muted">{S.intro}</p>
      <div className="row">
        <Button onClick={() => setEditing('new')}>
          <Icon name="plus" /> {S.addRule}
        </Button>
      </div>
      {error ? (
        <div role="alert" className="ws-error">
          <p>{error}</p>
          <Button onClick={() => setVersion((v) => v + 1)}>{S.retry}</Button>
        </div>
      ) : null}
      {rules === null && !error ? <Spinner label={S.loading} /> : null}
      {rules?.length === 0 ? <p className="muted">{S.none}</p> : null}
      {rules?.length ? (
        <ul className="ws-list" aria-label={S.title}>
          {rules.map((r) => {
            const title = r.label ?? ruleSummary(r);
            const managed = r.source === 'managed';
            return (
              <li key={r.id} className="ws-list-row" aria-label={title}>
                <div className="ws-source-main">
                  <strong>{title}</strong>
                  <span className="ws-row-meta">
                    <span className="ws-badge">{RULE_EFFECT_TEXT[r.effect]}</span>
                    <span className="muted">{scopeText(r, projects)}</span>
                    {r.label ? <span className="muted">{ruleSummary(r)}</span> : null}
                    <span className="muted">{S.priorityN({ n: r.priority })}</span>
                  </span>
                  {managed ? <ManagedNote id={`policy-lock-${r.id}`} /> : null}
                  {r.source === 'plugin' ? <span className="muted">{S.fromPlugin}</span> : null}
                </div>
                <div className="row ws-row-actions">
                  <Switch
                    label={S.toggle({ title })}
                    checked={r.enabled}
                    disabled={managed}
                    aria-describedby={managed ? `policy-lock-${r.id}` : undefined}
                    onChange={(v) => void toggle(r, v)}
                  />
                  {r.source === 'user' ? (
                    <>
                      <Button variant="ghost" onClick={() => setEditing(r)}>
                        {S.edit}
                      </Button>
                      <Button variant="ghost" onClick={() => setDeleting(r)}>
                        {S.delete}
                      </Button>
                    </>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ul>
      ) : null}
      <Dialog
        open={editing !== null}
        title={editing === 'new' ? S.addTitle : S.editTitle}
        onClose={() => setEditing(null)}
      >
        {editing !== null ? (
          <RuleForm
            rule={editing === 'new' ? null : editing}
            projects={projects}
            onCancel={() => setEditing(null)}
            onSaved={(r) => {
              const added = editing === 'new';
              setEditing(null);
              replace(r);
              toast.show(added ? S.added : S.saved, { tone: 'success' });
            }}
          />
        ) : null}
      </Dialog>
      <Dialog
        open={deleting !== null}
        title={S.deleteTitle}
        description={S.deleteBody}
        onClose={() => setDeleting(null)}
        footer={
          <>
            <Button onClick={() => setDeleting(null)}>{S.cancel}</Button>
            <Button variant="danger" onClick={() => deleting && void remove(deleting)}>
              {S.delete}
            </Button>
          </>
        }
      >
        {deleting ? <p className="ws-quote">{deleting.label ?? ruleSummary(deleting)}</p> : null}
      </Dialog>
    </section>
  );
}

function RuleForm({
  rule,
  projects,
  onSaved,
  onCancel,
}: {
  rule: PolicyRuleView | null;
  projects: ProjectView[];
  onSaved: (r: PolicyRuleView) => void;
  onCancel: () => void;
}) {
  const { api } = useServices();
  const id = `rf${useId()}`;
  const [label, setLabel] = useState(rule?.label ?? '');
  const [effect, setEffect] = useState<PolicyEffect>(rule?.effect ?? 'ask');
  const [tool, setTool] = useState(rule?.match.tool ?? '');
  const [resource, setResource] = useState(rule?.match.resource ?? '');
  const [effects, setEffects] = useState<ActionEffectClass[]>(rule?.match.effects ?? []);
  const [scopeKind, setScopeKind] = useState<PolicyRuleView['scopeKind']>(
    rule?.scopeKind ?? 'global',
  );
  const [scopeRef, setScopeRef] = useState(rule?.scopeRef ?? '');
  const [priority, setPriority] = useState(String(rule?.priority ?? 100));
  const [errors, setErrors] = useState<{ match?: string; scope?: string; priority?: string }>({});
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    const next: typeof errors = {};
    const match: PolicyRuleView['match'] = {};
    if (tool.trim()) match.tool = tool.trim();
    if (resource.trim()) match.resource = resource.trim();
    if (effects.length) match.effects = effects;
    if (!Object.keys(match).length) next.match = S.needMatch;
    if (scopeKind !== 'global' && !scopeRef.trim())
      next.scope = scopeKind === 'project' ? S.chooseProject : S.needRef;
    const prio = Number(priority);
    if (!/^\d+$/.test(priority.trim()) || prio > 1000)
      next.priority = S.priorityRange({ max: 1000 });
    setErrors(next);
    if (Object.keys(next).length) return;
    const body: CreatePolicyRuleRequest = {
      scopeKind,
      ...(scopeKind !== 'global' ? { scopeRef: scopeRef.trim() } : {}),
      match,
      effect,
      priority: prio,
      ...(label.trim() || rule?.label ? { label: label.trim() } : {}),
    };
    setBusy(true);
    setFailure(null);
    try {
      onSaved(rule ? await api.updatePolicyRule(rule.id, body) : await api.createPolicyRule(body));
    } catch (err) {
      setFailure(errorMessage(err, S.saveFailed));
      setBusy(false);
    }
  };

  const scopeOptions = [
    { value: 'global', label: S.everywhere },
    { value: 'project', label: S.oneProject },
    { value: 'site', label: S.oneSite },
  ];
  if (scopeKind === 'thread') scopeOptions.push({ value: 'thread', label: S.oneChat });
  if (scopeKind === 'tool') scopeOptions.push({ value: 'tool', label: S.oneTool });

  return (
    <form
      className="stack"
      aria-label={rule ? S.editTitle : S.addTitle}
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <TextField
        label={S.name}
        value={label}
        maxLength={200}
        hint={S.nameHint}
        onChange={(e) => setLabel(e.target.value)}
      />
      <RadioGroup
        legend={S.whatNovaDoes}
        name={`${id}-effect`}
        value={effect}
        onChange={(v) => setEffect(v as PolicyEffect)}
        options={EFFECTS.map((e) => ({ value: e, label: RULE_EFFECT_TEXT[e] }))}
      />
      <fieldset className="ws-fieldset" aria-describedby={errors.match ? `${id}-match` : undefined}>
        <legend>{S.whichActions}</legend>
        <TextField
          label={S.toolLabel}
          value={tool}
          spellCheck={false}
          autoComplete="off"
          placeholder={TOOL_EXAMPLE}
          hint={S.toolHint}
          onChange={(e) => setTool(e.target.value)}
        />
        <TextField
          label={S.resourceLabel}
          value={resource}
          spellCheck={false}
          autoComplete="off"
          placeholder={RESOURCE_EXAMPLE}
          hint={S.resourceHint}
          onChange={(e) => setResource(e.target.value)}
        />
        <details className="ws-advanced" open={effects.length > 0 || undefined}>
          <summary>{S.kinds}</summary>
          <div className="ws-checks">
            {(Object.keys(EFFECT_CLASS_TEXT) as ActionEffectClass[]).map((c) => (
              <label key={c} className="ws-check">
                <input
                  type="checkbox"
                  checked={effects.includes(c)}
                  onChange={(e) =>
                    setEffects((list) =>
                      e.target.checked ? [...list, c] : list.filter((x) => x !== c),
                    )
                  }
                />
                <span>{EFFECT_CLASS_TEXT[c]}</span>
              </label>
            ))}
          </div>
        </details>
        {errors.match ? (
          <p id={`${id}-match`} className="nv-field-error" role="alert">
            {errors.match}
          </p>
        ) : null}
      </fieldset>
      <SelectField
        label={S.appliesTo}
        value={scopeKind}
        onChange={(v) => {
          setScopeKind(v as PolicyRuleView['scopeKind']);
          setScopeRef('');
        }}
        options={scopeOptions}
      />
      {scopeKind === 'project' ? (
        <SelectField
          label={S.project}
          value={scopeRef}
          error={errors.scope}
          onChange={setScopeRef}
          options={[
            { value: '', label: S.pickProject },
            ...projects.map((p) => ({ value: p.id, label: p.name })),
          ]}
        />
      ) : null}
      {scopeKind === 'site' || scopeKind === 'thread' || scopeKind === 'tool' ? (
        <TextField
          label={scopeKind === 'site' ? S.website : scopeKind === 'tool' ? S.toolLabel : S.chat}
          value={scopeRef}
          placeholder={scopeKind === 'site' ? SITE_EXAMPLE : ''}
          error={errors.scope}
          onChange={(e) => setScopeRef(e.target.value)}
        />
      ) : null}
      <details className="ws-advanced">
        <summary>{S.advanced}</summary>
        <TextField
          label={S.priority}
          className="ws-number"
          inputMode="numeric"
          value={priority}
          hint={S.priorityHint}
          error={errors.priority}
          onChange={(e) => setPriority(e.target.value)}
        />
      </details>
      {failure ? (
        <p className="nv-field-error" role="alert">
          {failure}
        </p>
      ) : null}
      <div className="nv-dialog-footer">
        <Button onClick={onCancel}>{S.cancel}</Button>
        <Button type="submit" variant="primary" disabled={busy}>
          {busy ? <Spinner /> : null} {rule ? S.saveRule : S.addRule}
        </Button>
      </div>
    </form>
  );
}
