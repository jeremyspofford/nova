// Policy rules in Settings → Permissions (FR-084 partial, docs/12 §3): list, add, edit, delete
// and enable. Rules are instructions the engine follows; they never override built-in safety and
// cannot pre-approve actions that must be confirmed. Managed rules are read-only.
import { useEffect, useId, useState } from 'react';
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
import { MANAGED } from './common.ts';
import { EFFECT_CLASS_TEXT, RULE_EFFECT_TEXT } from './policy-text.ts';
import '../workspace.css';

const EFFECTS: PolicyEffect[] = ['allow', 'ask', 'handoff', 'deny'];

export function ruleSummary(r: Pick<PolicyRuleView, 'match'>): string {
  const parts = [
    r.match.tool ? `tool ${r.match.tool}` : null,
    r.match.resource ? `resource ${r.match.resource}` : null,
    r.match.effects?.length
      ? r.match.effects.map((e) => EFFECT_CLASS_TEXT[e].toLowerCase()).join(', ')
      : null,
  ].filter(Boolean);
  return parts.length ? parts.join(' · ') : 'every action';
}

function scopeText(r: PolicyRuleView, projects: ProjectView[]): string {
  switch (r.scopeKind) {
    case 'global':
      return 'Everywhere';
    case 'project':
      return `Project: ${projects.find((p) => p.id === r.scopeRef)?.name ?? r.scopeRef ?? '?'}`;
    case 'thread':
      return `One chat (${r.scopeRef ?? '?'})`;
    case 'tool':
      return `Tool: ${r.scopeRef ?? '?'}`;
    case 'site':
      return `Website: ${r.scopeRef ?? '?'}`;
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
      (err: unknown) => alive && setError(errorMessage(err, 'Could not load the rules.')),
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
      toast.show(`Could not change the rule: ${errorMessage(err)}`, { tone: 'error' });
    }
  };

  const remove = async (r: PolicyRuleView) => {
    setDeleting(null);
    try {
      await api.deletePolicyRule(r.id);
      setRules((list) => list?.filter((x) => x.id !== r.id) ?? null);
      toast.show('Rule deleted.', { tone: 'success' });
    } catch (err) {
      toast.show(`Could not delete the rule: ${errorMessage(err)}`, { tone: 'error' });
    }
  };

  return (
    <section className="settings-section" aria-labelledby="perm-rules">
      <h3 id="perm-rules">Rules</h3>
      <p className="muted">
        Tell Nova when to act on its own, when to ask, and when to hand a step to you. Rules never
        override built-in safety.
      </p>
      <div className="row">
        <Button onClick={() => setEditing('new')}>
          <Icon name="plus" /> Add rule
        </Button>
      </div>
      {error ? (
        <div role="alert" className="ws-error">
          <p>{error}</p>
          <Button onClick={() => setVersion((v) => v + 1)}>Retry</Button>
        </div>
      ) : null}
      {rules === null && !error ? <Spinner label="Loading rules" /> : null}
      {rules?.length === 0 ? <p className="muted">No rules yet.</p> : null}
      {rules?.length ? (
        <ul className="ws-list" aria-label="Rules">
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
                    <span className="muted">Priority {r.priority}</span>
                  </span>
                  {managed ? <span className="nv-field-hint nv-field-lock">{MANAGED}</span> : null}
                  {r.source === 'plugin' ? <span className="muted">From a plugin</span> : null}
                </div>
                <div className="row ws-row-actions">
                  <Switch
                    label={`Use rule: ${title}`}
                    checked={r.enabled}
                    disabled={managed}
                    onChange={(v) => void toggle(r, v)}
                  />
                  {r.source === 'user' ? (
                    <>
                      <Button variant="ghost" onClick={() => setEditing(r)}>
                        Edit
                      </Button>
                      <Button variant="ghost" onClick={() => setDeleting(r)}>
                        Delete
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
        title={editing === 'new' ? 'Add a rule' : 'Edit rule'}
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
              toast.show(added ? 'Rule added.' : 'Rule saved.', { tone: 'success' });
            }}
          />
        ) : null}
      </Dialog>
      <Dialog
        open={deleting !== null}
        title="Delete this rule?"
        description="Nova goes back to the tool defaults and your other rules for what it matched."
        onClose={() => setDeleting(null)}
        footer={
          <>
            <Button onClick={() => setDeleting(null)}>Cancel</Button>
            <Button variant="danger" onClick={() => deleting && void remove(deleting)}>
              Delete
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
    if (!Object.keys(match).length)
      next.match = 'Name a tool, a resource or a kind of action so the rule matches something.';
    if (scopeKind !== 'global' && !scopeRef.trim())
      next.scope = scopeKind === 'project' ? 'Choose a project.' : 'Enter what it applies to.';
    const prio = Number(priority);
    if (!/^\d+$/.test(priority.trim()) || prio > 1000)
      next.priority = 'Enter a whole number from 0 to 1000.';
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
      setFailure(errorMessage(err, 'Could not save the rule.'));
      setBusy(false);
    }
  };

  const scopeOptions = [
    { value: 'global', label: 'Everywhere' },
    { value: 'project', label: 'One project' },
    { value: 'site', label: 'One website' },
  ];
  if (scopeKind === 'thread') scopeOptions.push({ value: 'thread', label: 'One chat' });
  if (scopeKind === 'tool') scopeOptions.push({ value: 'tool', label: 'One tool' });

  return (
    <form
      className="stack"
      aria-label={rule ? 'Edit rule' : 'Add a rule'}
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <TextField
        label="Name"
        value={label}
        maxLength={200}
        hint="Optional, for example Ask before messaging customers."
        onChange={(e) => setLabel(e.target.value)}
      />
      <RadioGroup
        legend="What Nova does"
        name={`${id}-effect`}
        value={effect}
        onChange={(v) => setEffect(v as PolicyEffect)}
        options={EFFECTS.map((e) => ({ value: e, label: RULE_EFFECT_TEXT[e] }))}
      />
      <fieldset className="ws-fieldset" aria-describedby={errors.match ? `${id}-match` : undefined}>
        <legend>Which actions</legend>
        <TextField
          label="Tool"
          value={tool}
          spellCheck={false}
          autoComplete="off"
          placeholder="fs.write"
          hint="A tool name, or a pattern such as mcp:github.*. Empty matches any tool."
          onChange={(e) => setTool(e.target.value)}
        />
        <TextField
          label="Resource"
          value={resource}
          spellCheck={false}
          autoComplete="off"
          placeholder="*.example.com"
          hint="A path, host or address pattern. Optional."
          onChange={(e) => setResource(e.target.value)}
        />
        <details className="ws-advanced" open={effects.length > 0 || undefined}>
          <summary>Kinds of action</summary>
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
        label="Applies to"
        value={scopeKind}
        onChange={(v) => {
          setScopeKind(v as PolicyRuleView['scopeKind']);
          setScopeRef('');
        }}
        options={scopeOptions}
      />
      {scopeKind === 'project' ? (
        <SelectField
          label="Project"
          value={scopeRef}
          error={errors.scope}
          onChange={setScopeRef}
          options={[
            { value: '', label: 'Choose a project' },
            ...projects.map((p) => ({ value: p.id, label: p.name })),
          ]}
        />
      ) : null}
      {scopeKind === 'site' || scopeKind === 'thread' || scopeKind === 'tool' ? (
        <TextField
          label={scopeKind === 'site' ? 'Website' : scopeKind === 'tool' ? 'Tool' : 'Chat'}
          value={scopeRef}
          placeholder={scopeKind === 'site' ? 'shop.example.com' : ''}
          error={errors.scope}
          onChange={(e) => setScopeRef(e.target.value)}
        />
      ) : null}
      <details className="ws-advanced">
        <summary>Advanced</summary>
        <TextField
          label="Priority"
          className="ws-number"
          inputMode="numeric"
          value={priority}
          hint="0 to 1000, default 100. Used to order rules when several match."
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
        <Button onClick={onCancel}>Cancel</Button>
        <Button type="submit" variant="primary" disabled={busy}>
          {busy ? <Spinner /> : null} {rule ? 'Save rule' : 'Add rule'}
        </Button>
      </div>
    </form>
  );
}
