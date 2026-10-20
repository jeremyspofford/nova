// Command rules in Settings → Permissions (FR-191, docs/12 §3.1): token-prefix rules for commands
// run through an exec tool, each with commands it must and must not match. The Hub checks the
// examples on every save and names the one that fails; that message is shown next to the
// examples. "Test a command" asks the Hub which rule decides a command line, as you type.
import { useEffect, useId, useState } from 'react';
import { defineMessages, fmt } from '@nova/i18n';
import type { CommandRuleView, ProjectView } from '@nova/shared';
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
import { ApiError, errorMessage, type CreateCommandRuleRequest } from '../api.ts';
import { useServices } from '../services.tsx';
import { ManagedNote } from '../managed/ManagedNote.tsx';
import { COMMAND_DECISION_TEXT, lines, parsePattern, patternText } from './policy-text.ts';
import '../workspace.css';

export const COMMAND_RULES_TEXT = defineMessages('settings.commandRules', {
  loadFailed: 'Could not load the command rules.',
  changeFailed: 'Could not change the command rule: {error}',
  deleted: 'Command rule deleted.',
  deleteFailed: 'Could not delete the command rule: {error}',
  title: 'Command rules',
  intro:
    'Decide by the first words of a command whether it runs, asks or is refused. An allow rule ' +
    'only skips the question; the command still runs in the sandbox.',
  add: 'Add command rule',
  retry: 'Retry',
  loading: 'Loading command rules',
  none: 'No command rules yet.',
  project: 'Project: {name}',
  scope:
    '{kind, select, thread {Chat: {ref}} tool {Tool: {ref}} site {Website: {ref}} other {{kind}: {ref}}}',
  matches: 'Matches: {commands}',
  notMatches: 'Does not match: {commands}',
  fromPlugin: 'From a plugin',
  toggle: 'Use command rule: {pattern}',
  edit: 'Edit',
  delete: 'Delete',
  addTitle: 'Add a command rule',
  editTitle: 'Edit command rule',
  added: 'Command rule added.',
  saved: 'Command rule saved.',
  deleteTitle: 'Delete this command rule?',
  deleteBody: "Commands it matched go back to the exec tool's default.",
  cancel: 'Cancel',
  needMatch: 'Add at least one command this rule should match.',
  needNotMatch: 'Add at least one command this rule should not match.',
  tooLong: 'Keep it under {max} characters.',
  priorityRange: 'Enter a whole number from 0 to {max}.',
  chooseProject: 'Choose a project.',
  saveFailed: 'Could not save the command rule.',
  examplesHint: 'One command per line. Checked every time the rule is saved.',
  startsWith: 'Command starts with',
  startsWithHint:
    'The first words of the command. Separate alternatives with |, for example git status|diff|log.',
  then: 'Then',
  why: 'Why',
  whyHint: 'Shown when the rule asks or refuses. For a refusal, name what to use instead.',
  shouldMatch: 'Commands it should match',
  shouldNotMatch: 'Commands it should not match',
  appliesTo: 'Applies to',
  everywhere: 'Everywhere',
  oneProject: 'One project',
  projectLabel: 'Project',
  pickProject: 'Choose a project',
  advanced: 'Advanced',
  priority: 'Priority',
  priorityHint: '0 to 1000, default 100. Used to order rules when several match.',
  saveRule: 'Save command rule',
  testFailed: 'Could not test the command.',
  test: 'Test a command',
  testHint: 'See which command rule decides it. Nothing runs.',
  noRule: 'No command rule matches. {reason}',
  decided: '{decision}: {reason}',
  decidedByRule: '{decision} (rule {rule}): {reason}',
});
const S = COMMAND_RULES_TEXT;
// Examples typed into fields: commands, the same in every language.
const PATTERN_EXAMPLE = 'git status|diff|log';
const MATCH_EXAMPLE = 'git status';
const NOT_MATCH_EXAMPLE = 'git push';
const TEST_EXAMPLE = 'git push origin main';

type Decision = CommandRuleView['decision'];
const DECISIONS: Decision[] = ['allow', 'ask', 'deny'];
export const TEST_DEBOUNCE_MS = 300;

export function CommandRulesSection() {
  const { api } = useServices();
  const toast = useToast();
  const [rules, setRules] = useState<CommandRuleView[] | null>(null);
  const [projects, setProjects] = useState<ProjectView[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  const [editing, setEditing] = useState<CommandRuleView | 'new' | null>(null);
  const [deleting, setDeleting] = useState<CommandRuleView | null>(null);

  useEffect(() => {
    let alive = true;
    api.listCommandRules().then(
      ({ items }) => {
        if (!alive) return;
        setRules(items);
        setError(null);
      },
      (err: unknown) => alive && setError(errorMessage(err, S.loadFailed)),
    );
    api.listProjects().then(
      ({ items }) => alive && setProjects(items),
      () => undefined,
    );
    return () => {
      alive = false;
    };
  }, [api, version]);

  const replace = (r: CommandRuleView) =>
    setRules((list) => {
      const rest = list ?? [];
      return rest.some((x) => x.id === r.id)
        ? rest.map((x) => (x.id === r.id ? r : x))
        : [...rest, r];
    });

  const toggle = async (r: CommandRuleView, enabled: boolean) => {
    try {
      replace(await api.updateCommandRule(r.id, { enabled }));
    } catch (err) {
      toast.show(S.changeFailed({ error: errorMessage(err) }), { tone: 'error' });
    }
  };

  const remove = async (r: CommandRuleView) => {
    setDeleting(null);
    try {
      await api.deleteCommandRule(r.id);
      setRules((list) => list?.filter((x) => x.id !== r.id) ?? null);
      toast.show(S.deleted, { tone: 'success' });
    } catch (err) {
      toast.show(S.deleteFailed({ error: errorMessage(err) }), { tone: 'error' });
    }
  };

  return (
    <section className="settings-section" aria-labelledby="perm-commands">
      <h3 id="perm-commands">{S.title}</h3>
      <p className="muted">{S.intro}</p>
      <div className="row">
        <Button onClick={() => setEditing('new')}>
          <Icon name="plus" /> {S.add}
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
            const text = patternText(r.pattern);
            const managed = r.source === 'managed';
            return (
              <li key={r.id} className="ws-list-row" aria-label={text}>
                <div className="ws-source-main">
                  <span className="ws-row-meta">
                    <code className="ws-code-inline" dir="ltr">
                      {text}
                    </code>
                    <span className="ws-badge">{COMMAND_DECISION_TEXT[r.decision]}</span>
                    {r.scopeKind !== 'global' ? (
                      <span className="muted">
                        {r.scopeKind === 'project'
                          ? S.project({
                              name:
                                projects.find((p) => p.id === r.scopeRef)?.name ??
                                r.scopeRef ??
                                '?',
                            })
                          : S.scope({ kind: r.scopeKind, ref: r.scopeRef ?? '?' })}
                      </span>
                    ) : null}
                  </span>
                  {r.justification ? (
                    <span className="muted" dir="auto">
                      {r.justification}
                    </span>
                  ) : null}
                  <span className="muted ws-row-meta">
                    <span>
                      {S.matches({ commands: fmt.list(r.matchExamples, { type: 'unit' }) })}
                    </span>
                    <span>
                      {S.notMatches({ commands: fmt.list(r.notMatchExamples, { type: 'unit' }) })}
                    </span>
                  </span>
                  {managed ? <ManagedNote id={`cmd-lock-${r.id}`} /> : null}
                  {r.source === 'plugin' ? <span className="muted">{S.fromPlugin}</span> : null}
                </div>
                <div className="row ws-row-actions">
                  <Switch
                    label={S.toggle({ pattern: text })}
                    checked={r.enabled}
                    disabled={managed}
                    aria-describedby={managed ? `cmd-lock-${r.id}` : undefined}
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
      <TestCommand rules={rules ?? []} />
      <Dialog
        open={editing !== null}
        title={editing === 'new' ? S.addTitle : S.editTitle}
        onClose={() => setEditing(null)}
      >
        {editing !== null ? (
          <CommandRuleForm
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
        {deleting ? (
          <p className="ws-quote" dir="ltr">
            {patternText(deleting.pattern)}
          </p>
        ) : null}
      </Dialog>
    </section>
  );
}

type Field = 'pattern' | 'justification' | 'matchExamples' | 'notMatchExamples' | 'priority';

/** Which examples field a Hub validation error is about, when it says so. */
export function exampleField(err: unknown): 'matchExamples' | 'notMatchExamples' | null {
  if (!(err instanceof ApiError) || err.body.code !== 'validation') return null;
  const f = err.body.details?.field;
  if (f === 'matchExamples' || f === 'notMatchExamples') return f;
  const m = err.body.message.toLowerCase();
  if (/notmatchexamples|not-match example/.test(m)) return 'notMatchExamples';
  if (/matchexamples|match example/.test(m)) return 'matchExamples';
  return null;
}

function CommandRuleForm({
  rule,
  projects,
  onSaved,
  onCancel,
}: {
  rule: CommandRuleView | null;
  projects: ProjectView[];
  onSaved: (r: CommandRuleView) => void;
  onCancel: () => void;
}) {
  const { api } = useServices();
  const id = `cr${useId()}`;
  const [pattern, setPattern] = useState(rule ? patternText(rule.pattern) : '');
  const [decision, setDecision] = useState<Decision>(rule?.decision ?? 'allow');
  const [justification, setJustification] = useState(rule?.justification ?? '');
  const [match, setMatch] = useState((rule?.matchExamples ?? []).join('\n'));
  const [notMatch, setNotMatch] = useState((rule?.notMatchExamples ?? []).join('\n'));
  const [scopeKind, setScopeKind] = useState<'global' | 'project'>(
    rule?.scopeKind === 'project' ? 'project' : 'global',
  );
  const [scopeRef, setScopeRef] = useState(rule?.scopeKind === 'project' ? rule.scopeRef : '');
  const [priority, setPriority] = useState(String(rule?.priority ?? 100));
  const [errors, setErrors] = useState<Partial<Record<Field | 'scope', string>>>({});
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Rules from a chat's "Always allow" may have another scope; keep it as it is.
  const keepScope = rule !== null && rule.scopeKind !== 'global' && rule.scopeKind !== 'project';

  const submit = async () => {
    const next: typeof errors = {};
    const parsed = parsePattern(pattern);
    if ('error' in parsed) next.pattern = parsed.error;
    const m = lines(match);
    const n = lines(notMatch);
    if (!m.length) next.matchExamples = S.needMatch;
    if (!n.length) next.notMatchExamples = S.needNotMatch;
    if (justification.length > 500) next.justification = S.tooLong({ max: 500 });
    const prio = Number(priority);
    if (!/^\d+$/.test(priority.trim()) || prio > 1000)
      next.priority = S.priorityRange({ max: 1000 });
    if (scopeKind === 'project' && !scopeRef) next.scope = S.chooseProject;
    setErrors(next);
    setFailure(null);
    if (Object.keys(next).length || 'error' in parsed) return;
    const body: CreateCommandRuleRequest = {
      ...(keepScope ? {} : { scopeKind }),
      ...(!keepScope && scopeKind === 'project' && scopeRef ? { scopeRef } : {}),
      pattern: parsed.pattern,
      decision,
      ...(justification.trim() || rule?.justification
        ? { justification: justification.trim() }
        : {}),
      matchExamples: m,
      notMatchExamples: n,
      priority: prio,
    };
    setBusy(true);
    try {
      onSaved(
        rule ? await api.updateCommandRule(rule.id, body) : await api.createCommandRule(body),
      );
    } catch (err) {
      const field = exampleField(err);
      const msg = errorMessage(err, S.saveFailed);
      if (field) setErrors({ [field]: msg });
      else setFailure(msg);
      setBusy(false);
    }
  };

  const area = (
    field: 'matchExamples' | 'notMatchExamples',
    label: string,
    value: string,
    set: (v: string) => void,
    placeholder: string,
  ) => (
    <div className="nv-field">
      <label className="nv-field-label" htmlFor={`${id}-${field}`}>
        {label}
      </label>
      <textarea
        id={`${id}-${field}`}
        className="nv-input ws-textarea"
        rows={3}
        spellCheck={false}
        placeholder={placeholder}
        value={value}
        aria-invalid={errors[field] ? true : undefined}
        aria-describedby={`${id}-${field}-hint${errors[field] ? ` ${id}-${field}-error` : ''}`}
        onChange={(e) => {
          set(e.target.value);
          setErrors((x) => ({ ...x, [field]: undefined }));
        }}
      />
      <span id={`${id}-${field}-hint`} className="nv-field-hint">
        {S.examplesHint}
      </span>
      {errors[field] ? (
        <span id={`${id}-${field}-error`} className="nv-field-error" role="alert">
          {errors[field]}
        </span>
      ) : null}
    </div>
  );

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
        label={S.startsWith}
        value={pattern}
        spellCheck={false}
        autoComplete="off"
        placeholder={PATTERN_EXAMPLE}
        hint={S.startsWithHint}
        error={errors.pattern}
        onChange={(e) => setPattern(e.target.value)}
      />
      <RadioGroup
        legend={S.then}
        name={`${id}-decision`}
        value={decision}
        onChange={(v) => setDecision(v as Decision)}
        options={DECISIONS.map((d) => ({ value: d, label: COMMAND_DECISION_TEXT[d] }))}
      />
      <TextField
        label={S.why}
        value={justification}
        maxLength={500}
        hint={S.whyHint}
        error={errors.justification}
        onChange={(e) => setJustification(e.target.value)}
      />
      {area('matchExamples', S.shouldMatch, match, setMatch, MATCH_EXAMPLE)}
      {area('notMatchExamples', S.shouldNotMatch, notMatch, setNotMatch, NOT_MATCH_EXAMPLE)}
      {!keepScope ? (
        <SelectField
          label={S.appliesTo}
          value={scopeKind}
          onChange={(v) => {
            setScopeKind(v as 'global' | 'project');
            setScopeRef('');
          }}
          options={[
            { value: 'global', label: S.everywhere },
            { value: 'project', label: S.oneProject },
          ]}
        />
      ) : null}
      {!keepScope && scopeKind === 'project' ? (
        <SelectField
          label={S.projectLabel}
          value={scopeRef ?? ''}
          error={errors.scope}
          onChange={setScopeRef}
          options={[
            { value: '', label: S.pickProject },
            ...projects.map((p) => ({ value: p.id, label: p.name })),
          ]}
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
          {busy ? <Spinner /> : null} {rule ? S.saveRule : S.add}
        </Button>
      </div>
    </form>
  );
}

type TestResult = Awaited<ReturnType<ReturnType<typeof useServices>['api']['testCommandRules']>>;

function TestCommand({ rules }: { rules: CommandRuleView[] }) {
  const { api } = useServices();
  const [command, setCommand] = useState('');
  const [result, setResult] = useState<{ command: string; value: TestResult } | null>(null);
  const [failure, setFailure] = useState<{ command: string; text: string } | null>(null);
  const trimmed = command.trim();

  useEffect(() => {
    if (!trimmed) return;
    let alive = true;
    const t = setTimeout(() => {
      api.testCommandRules(trimmed).then(
        (value) => {
          if (!alive) return;
          setResult({ command: trimmed, value });
          setFailure(null);
        },
        (err: unknown) =>
          alive && setFailure({ command: trimmed, text: errorMessage(err, S.testFailed) }),
      );
    }, TEST_DEBOUNCE_MS);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [api, trimmed]);

  const shown = result && result.command === trimmed ? result.value : null;
  const failed = failure && failure.command === trimmed ? failure.text : null;
  const rule = shown?.ruleId ? rules.find((r) => r.id === shown.ruleId) : undefined;

  return (
    <div className="panel-inset" role="group" aria-label={S.test}>
      <TextField
        label={S.test}
        value={command}
        spellCheck={false}
        autoComplete="off"
        placeholder={TEST_EXAMPLE}
        hint={S.testHint}
        onChange={(e) => setCommand(e.target.value)}
      />
      <p role="status" className="ws-flush">
        {trimmed && shown
          ? shown.decision === null
            ? S.noRule({ reason: shown.reason })
            : rule
              ? S.decidedByRule({
                  decision: COMMAND_DECISION_TEXT[shown.decision],
                  rule: patternText(rule.pattern),
                  reason: shown.reason,
                })
              : S.decided({ decision: COMMAND_DECISION_TEXT[shown.decision], reason: shown.reason })
          : ''}
      </p>
      {trimmed && failed ? (
        <p role="alert" className="nv-field-error ws-flush">
          {failed}
        </p>
      ) : null}
    </div>
  );
}
