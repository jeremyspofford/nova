// The agent's custom rules (FR-084, FR-191; docs/12 §3): Take action without asking, Take action
// when you say so, Ask before taking action, Hand off to you, each scoped to kinds of action,
// effects, tools, hosts or channels, optionally with a command prefix rule. Rules are editable,
// can be turned off, deleted (with a confirmation) and previewed: the preview lists the agent's
// recent actions the rule would have matched. Rules never override built-in safety.
import { useEffect, useId, useState } from 'react';
import { defineMessages } from '@nova/i18n';
import {
  AGENT_ACTION_CLASSES,
  AGENT_RULE_EFFECTS,
  AGENT_RULE_EFFECT_CLASSES,
  type AgentActionClass,
  type AgentRuleEffect,
  type AgentRuleMatch,
  type AgentRulePreviewItem,
  type AgentRuleView,
} from '@nova/shared';
import {
  Button,
  Dialog,
  Icon,
  IconButton,
  RadioGroup,
  SelectField,
  Spinner,
  Switch,
  TextField,
  useToast,
} from '@nova/ui';
import { ApiError, errorMessage } from '../api.ts';
import { EFFECT_CLASS_TEXT, lines, parsePattern, patternText } from '../settings/policy-text.ts';
import { formatDateTime } from '../work/format.ts';
import { useAgentsApi, type AgentRuleBody } from './api.ts';
import {
  ACTION_TEXT,
  AGENTS_TEXT,
  CHANNEL_KIND_TEXT,
  EFFECTS_OF_ACTIONS,
  matchText,
  RULE_EFFECT_ICON,
  RULE_EFFECT_TEXT,
  splitList,
} from './format.ts';
import { rich } from '../i18n/rich.tsx';

export const RULES_TEXT = defineMessages('agents.rules', {
  loadFailed: 'Could not load the rules.',
  turnedOn: 'Rule turned on.',
  turnedOff: 'Rule turned off.',
  changeFailed: 'Could not change the rule: {reason}',
  heading: 'Rules',
  add: 'Add a rule',
  intro:
    'Rules are instructions this agent follows. They cannot give it access it does not have ' +
    'and never override built-in safety: purchases, password changes and other confirmed ' +
    'actions still ask.',
  added: 'Rule added.',
  loading: 'Loading the rules',
  empty:
    'No rules. The agent follows your permissions and its autonomy. Add a rule such as “Ask ' +
    'before messaging customers” or “Hand off payments to me”.',
  saved: 'Rule saved.',
  list: 'Rules',
  off: 'Off',
  priority: 'Priority {n}',
  appliesTo: 'Applies to: {match}',
  commandsStarting: 'Commands starting with {pattern}',
  /** The rule's on/off switch: "Ask before messaging customers: on". */
  switchOf: '{rule}: on',
  preview: 'Preview',
  previewOf: 'Preview {rule}',
  editOf: 'Edit {rule}',
  deleteOf: 'Delete {rule}',
  deleteTitle: 'Delete this rule?',
  deleteBody: "“{rule}” no longer applies. The agent's permissions and autonomy decide instead.",
  deleted: 'Rule deleted.',
  deleteFailed: 'Could not delete it: {reason}',
  previewFailed: 'Could not load the preview.',
  previewHeading: 'Recent actions this rule matches',
  previewLoading: 'Loading the preview',
  previewEmpty: "None of the agent's recent actions match this rule.",
  descriptionRequired: 'Say what the rule does, in a few words.',
  toolsError: 'Use tool names or globs such as email.send or slack.*.',
  hostsError: 'Use host names such as example.com or *.example.com.',
  matchError: 'A rule names hosts or channels, not both.',
  priorityError: 'Enter a whole number from {min} to {max}.',
  matchExamplesError: 'Add at least one command this rule should match.',
  notMatchExamplesError: 'Add at least one command it should not match.',
  saveFailed: 'Could not save the rule.',
  editForm: 'Edit rule: {rule}',
  newForm: 'New rule',
  rule: 'Rule',
  placeholder: 'For example: Ask before messaging customers',
  effect: 'What the agent does',
  appliesLegend: 'Applies to',
  appliesHint:
    'Leave everything empty to cover every action. Each part you fill in narrows the rule.',
  kinds: 'Kinds of action',
  effects: 'Effects',
  tools: 'Tools',
  toolsHint: 'Tool names or globs, separated by commas: email.send, slack.*',
  hosts: 'Hosts',
  hostsHint: 'Web hosts, separated by commas: example.com, *.customer.com',
  channels: 'Channels',
  channelN: 'Channel {n}',
  conversationN: 'Conversation for channel {n} (optional)',
  conversationPlaceholder: '#general, a person, or an id',
  removeChannelN: 'Remove channel {n}',
  addChannel: 'Add a channel',
  command: 'Command prefix rule',
  useCommand: 'Match commands the agent runs by how they start',
  /** Which effects can match commands; the placeholders are those effects' names. */
  commandOnly: 'Only “{act}” and “{ask}” rules can match commands.',
  startsWith: 'Command starts with',
  startsWithHint: 'Words in order; use | for alternatives, for example: git status|diff',
  matchEx: 'Commands it should match',
  notMatchEx: 'Commands it should not match',
  why: 'Why (optional)',
  advanced: 'Advanced',
  priorityLabel: 'Priority',
  priorityHint: '{min} to {max}, default {byDefault}. Used to order rules when several match.',
  enabled: 'Rule is on',
  save: 'Save rule',
  addRule: 'Add rule',
  examplesHint: 'One command per line. Checked every time the rule is saved.',
});

type RuleChannel = NonNullable<AgentRuleMatch['channels']>[number];
type ChannelKind = RuleChannel['kind'];
const CHANNEL_KINDS: ChannelKind[] = ['inapp', 'slack', 'teams', 'email', 'webhook', 'telegram'];

export function AgentRules({ agentId, version }: { agentId: string; version: number }) {
  const api = useAgentsApi();
  const toast = useToast();
  const headingId = useId();
  const [rules, setRules] = useState<AgentRuleView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [manual, setManual] = useState(0);
  const [editing, setEditing] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<AgentRuleView | null>(null);
  const [previewing, setPreviewing] = useState<Set<string>>(new Set());

  useEffect(() => {
    let alive = true;
    api.listAgentRules(agentId).then(
      ({ items }) => {
        if (!alive) return;
        setRules(items);
        setError(null);
      },
      (err: unknown) => alive && setError(errorMessage(err, RULES_TEXT.loadFailed)),
    );
    return () => {
      alive = false;
    };
  }, [api, agentId, version, manual]);

  const replace = (r: AgentRuleView) =>
    setRules((list) => {
      const rest = list ?? [];
      return rest.some((x) => x.id === r.id)
        ? rest.map((x) => (x.id === r.id ? r : x))
        : [...rest, r];
    });
  const sorted = rules ? [...rules].sort((a, b) => a.priority - b.priority) : null;

  const toggle = (r: AgentRuleView) => {
    api.updateAgentRule(agentId, r.id, { enabled: !r.enabled }).then(
      (next) => {
        replace(next);
        toast.show(next.enabled ? RULES_TEXT.turnedOn : RULES_TEXT.turnedOff, {
          tone: 'success',
        });
      },
      (err: unknown) =>
        toast.show(RULES_TEXT.changeFailed({ reason: errorMessage(err) }), { tone: 'error' }),
    );
  };

  return (
    <section className="agent-section" aria-labelledby={headingId}>
      <div className="ws-section-header">
        <h2 id={headingId}>{RULES_TEXT.heading}</h2>
        {editing === 'new' ? null : (
          <Button onClick={() => setEditing('new')}>
            <Icon name="plus" /> {RULES_TEXT.add}
          </Button>
        )}
      </div>
      <p className="muted ws-flush">{RULES_TEXT.intro}</p>
      {editing === 'new' ? (
        <RuleForm
          rule={null}
          onCancel={() => setEditing(null)}
          onSave={async (body) => {
            replace(await api.createAgentRule(agentId, body));
            setEditing(null);
            toast.show(RULES_TEXT.added, { tone: 'success' });
          }}
        />
      ) : null}
      {error ? (
        <div className="ws-error" role="alert">
          <p>{error}</p>
          <Button onClick={() => setManual((n) => n + 1)}>{AGENTS_TEXT.retry}</Button>
        </div>
      ) : sorted === null ? (
        <Spinner label={RULES_TEXT.loading} />
      ) : sorted.length === 0 ? (
        <p className="muted">{RULES_TEXT.empty}</p>
      ) : (
        <ul className="ws-list" aria-label={RULES_TEXT.list}>
          {sorted.map((r) =>
            editing === r.id ? (
              <li key={r.id} className="ws-list-row">
                <RuleForm
                  rule={r}
                  onCancel={() => setEditing(null)}
                  onSave={async (body) => {
                    replace(
                      await api.updateAgentRule(agentId, r.id, {
                        ...body,
                        match: body.match ?? {},
                        command: body.command ?? null,
                      }),
                    );
                    setEditing(null);
                    toast.show(RULES_TEXT.saved, { tone: 'success' });
                  }}
                />
              </li>
            ) : (
              <li
                key={r.id}
                className="ws-list-row agent-rule"
                aria-label={r.description}
                data-enabled={r.enabled}
              >
                <div className="work-row-main">
                  <span className="ws-card-link" dir="auto">
                    {r.description}
                  </span>
                  <span className="ws-row-meta">
                    <span className="ws-badge agent-effect" data-effect={r.effect}>
                      <Icon name={RULE_EFFECT_ICON[r.effect]} /> {RULE_EFFECT_TEXT[r.effect].label}
                    </span>
                    {r.enabled ? null : (
                      <span className="ws-badge">
                        <Icon name="stop" /> {RULES_TEXT.off}
                      </span>
                    )}
                    <span className="muted">{RULES_TEXT.priority({ n: r.priority })}</span>
                  </span>
                  <span className="muted agent-text">
                    {RULES_TEXT.appliesTo({ match: matchText(r.match) })}
                  </span>
                  {r.command ? (
                    <span className="muted agent-text">
                      {rich(RULES_TEXT.commandsStarting, {
                        pattern: <code dir="ltr">{patternText(r.command.pattern)}</code>,
                      })}
                    </span>
                  ) : null}
                </div>
                <div className="ws-row-actions ws-toolbar">
                  <Switch
                    checked={r.enabled}
                    label={RULES_TEXT.switchOf({ rule: r.description })}
                    onChange={() => toggle(r)}
                  />
                  <Button
                    aria-expanded={previewing.has(r.id)}
                    aria-label={RULES_TEXT.previewOf({ rule: r.description })}
                    onClick={() =>
                      setPreviewing((s) => {
                        const next = new Set(s);
                        if (next.has(r.id)) next.delete(r.id);
                        else next.add(r.id);
                        return next;
                      })
                    }
                  >
                    {RULES_TEXT.preview}
                  </Button>
                  <Button
                    aria-label={RULES_TEXT.editOf({ rule: r.description })}
                    onClick={() => setEditing(r.id)}
                  >
                    {AGENTS_TEXT.edit}
                  </Button>
                  <Button
                    variant="danger"
                    aria-label={RULES_TEXT.deleteOf({ rule: r.description })}
                    onClick={() => setDeleting(r)}
                  >
                    {AGENTS_TEXT.delete}
                  </Button>
                </div>
                {previewing.has(r.id) ? <RulePreview agentId={agentId} rule={r} /> : null}
              </li>
            ),
          )}
        </ul>
      )}
      <Dialog
        open={deleting !== null}
        title={RULES_TEXT.deleteTitle}
        description={deleting ? RULES_TEXT.deleteBody({ rule: deleting.description }) : undefined}
        onClose={() => setDeleting(null)}
        footer={
          <>
            <Button onClick={() => setDeleting(null)}>{AGENTS_TEXT.cancel}</Button>
            <Button
              variant="danger"
              onClick={() => {
                const r = deleting;
                setDeleting(null);
                if (!r) return;
                api.deleteAgentRule(agentId, r.id).then(
                  () => {
                    setRules((list) => list?.filter((x) => x.id !== r.id) ?? null);
                    toast.show(RULES_TEXT.deleted, { tone: 'success' });
                  },
                  (err: unknown) =>
                    toast.show(RULES_TEXT.deleteFailed({ reason: errorMessage(err) }), {
                      tone: 'error',
                    }),
                );
              }}
            >
              {AGENTS_TEXT.delete}
            </Button>
          </>
        }
      />
    </section>
  );
}

function RulePreview({ agentId, rule }: { agentId: string; rule: AgentRuleView }) {
  const api = useAgentsApi();
  const headingId = useId();
  const [items, setItems] = useState<AgentRulePreviewItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    api.previewAgentRule(agentId, rule.id).then(
      ({ items: list }) => alive && setItems(list),
      (err: unknown) => alive && setError(errorMessage(err, RULES_TEXT.previewFailed)),
    );
    return () => {
      alive = false;
    };
  }, [api, agentId, rule.id, rule.updatedAt]);
  return (
    <section className="agent-preview" aria-labelledby={headingId}>
      <h3 id={headingId} className="ws-subhead">
        {RULES_TEXT.previewHeading}
      </h3>
      {error ? (
        <p role="alert" className="nv-field-error">
          {error}
        </p>
      ) : items === null ? (
        <Spinner label={RULES_TEXT.previewLoading} />
      ) : items.length === 0 ? (
        <p className="muted ws-flush">{RULES_TEXT.previewEmpty}</p>
      ) : (
        <ul className="ws-plain-list">
          {items.map((it) => (
            <li key={it.callId}>
              {/* The tool, its status and the decision are the runtime's own values. */}
              <code dir="ltr">{it.tool}</code> · {it.status}
              {it.decision ? ` · ${it.decision}` : ''} · {formatDateTime(it.createdAt)}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** Which field a Hub validation error is about, to show it next to that field. */
function ruleErrorField(err: unknown): 'match' | 'effect' | 'command' | null {
  if (!(err instanceof ApiError) || err.body.code !== 'validation') return null;
  const f = err.body.details?.field;
  return f === 'match' || f === 'effect' || f === 'command' ? f : null;
}

function RuleForm({
  rule,
  onSave,
  onCancel,
}: {
  rule: AgentRuleView | null;
  onSave: (body: AgentRuleBody) => Promise<void>;
  onCancel: () => void;
}) {
  const id = `ar${useId()}`;
  const m = rule?.match ?? {};
  const [description, setDescription] = useState(rule?.description ?? '');
  const [effect, setEffect] = useState<AgentRuleEffect>(rule?.effect ?? 'ask');
  const [actions, setActions] = useState<Set<AgentActionClass>>(new Set(m.actions ?? []));
  const [effects, setEffects] = useState<Set<string>>(new Set(m.effects ?? []));
  const [tools, setTools] = useState((m.tools ?? []).join(', '));
  const [hosts, setHosts] = useState((m.hosts ?? []).join(', '));
  const [channels, setChannels] = useState<RuleChannel[]>(m.channels ?? []);
  const [useCommand, setUseCommand] = useState(!!rule?.command);
  const [pattern, setPattern] = useState(rule?.command ? patternText(rule.command.pattern) : '');
  const [matchEx, setMatchEx] = useState((rule?.command?.matchExamples ?? []).join('\n'));
  const [notMatchEx, setNotMatchEx] = useState((rule?.command?.notMatchExamples ?? []).join('\n'));
  const [justification, setJustification] = useState(rule?.command?.justification ?? '');
  const [priority, setPriority] = useState(String(rule?.priority ?? 100));
  const [enabled, setEnabled] = useState(rule?.enabled ?? true);
  const [errors, setErrors] = useState<Partial<Record<string, string>>>({});
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const commandAllowed = effect === 'act' || effect === 'ask';

  const toggleIn = <T,>(set: Set<T>, v: T): Set<T> => {
    const next = new Set(set);
    if (next.has(v)) next.delete(v);
    else next.add(v);
    return next;
  };

  const submit = async () => {
    const next: Record<string, string> = {};
    if (!description.trim()) next.description = RULES_TEXT.descriptionRequired;
    const toolList = splitList(tools);
    const hostList = splitList(hosts);
    const channelList = channels
      .map((c) => ({
        kind: c.kind,
        ...(c.conversation?.trim() ? { conversation: c.conversation.trim() } : {}),
      }))
      .filter(
        (c, i, all) =>
          all.findIndex((x) => x.kind === c.kind && x.conversation === c.conversation) === i,
      );
    if (toolList.some((t) => !/^[A-Za-z0-9_.:*-]{1,200}$/.test(t)))
      next.tools = RULES_TEXT.toolsError;
    if (hostList.some((h) => !/^(\*\.)?[A-Za-z0-9.-]{1,253}$/.test(h)))
      next.hosts = RULES_TEXT.hostsError;
    if (hostList.length && channelList.length) next.match = RULES_TEXT.matchError;
    const prio = Number(priority);
    if (!/^\d+$/.test(priority.trim()) || prio > 1000)
      next.priority = RULES_TEXT.priorityError({ min: 0, max: 1000 });
    let command: AgentRuleBody['command'];
    if (useCommand && commandAllowed) {
      const parsed = parsePattern(pattern);
      const mx = lines(matchEx);
      const nx = lines(notMatchEx);
      if ('error' in parsed) next.pattern = parsed.error;
      if (!mx.length) next.matchExamples = RULES_TEXT.matchExamplesError;
      if (!nx.length) next.notMatchExamples = RULES_TEXT.notMatchExamplesError;
      if (!('error' in parsed) && mx.length && nx.length)
        command = {
          pattern: parsed.pattern,
          matchExamples: mx,
          notMatchExamples: nx,
          ...(justification.trim() ? { justification: justification.trim() } : {}),
        };
    }
    setErrors(next);
    setFailure(null);
    if (Object.keys(next).length || busy) return;
    const match: AgentRuleMatch = {
      ...(actions.size ? { actions: AGENT_ACTION_CLASSES.filter((a) => actions.has(a)) } : {}),
      ...(effects.size ? { effects: AGENT_RULE_EFFECT_CLASSES.filter((e) => effects.has(e)) } : {}),
      ...(toolList.length ? { tools: toolList } : {}),
      ...(hostList.length ? { hosts: hostList } : {}),
      ...(channelList.length ? { channels: channelList } : {}),
    };
    setBusy(true);
    try {
      await onSave({
        description: description.trim(),
        effect,
        match,
        ...(command ? { command } : {}),
        priority: prio,
        enabled,
      });
    } catch (err) {
      const field = ruleErrorField(err);
      const msg = errorMessage(err, RULES_TEXT.saveFailed);
      if (field) setErrors({ [field]: msg });
      else setFailure(msg);
      setBusy(false);
    }
  };

  const err = (k: string) =>
    errors[k] ? (
      <span className="nv-field-error" role="alert">
        {errors[k]}
      </span>
    ) : null;

  return (
    <form
      className="stack agent-inline-form agent-rule-form"
      aria-label={rule ? RULES_TEXT.editForm({ rule: rule.description }) : RULES_TEXT.newForm}
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <TextField
        label={RULES_TEXT.rule}
        value={description}
        maxLength={300}
        autoComplete="off"
        autoFocus
        placeholder={RULES_TEXT.placeholder}
        error={errors.description}
        onChange={(e) => setDescription(e.target.value)}
      />
      <RadioGroup
        legend={RULES_TEXT.effect}
        name={`${id}-effect`}
        value={effect}
        onChange={(v) => setEffect(v as AgentRuleEffect)}
        options={AGENT_RULE_EFFECTS.map((e) => ({
          value: e,
          label: RULE_EFFECT_TEXT[e].label,
          description: RULE_EFFECT_TEXT[e].description,
        }))}
      />
      {err('effect')}
      <fieldset className="ws-fieldset">
        <legend>{RULES_TEXT.appliesLegend}</legend>
        <p className="nv-field-hint ws-flush">{RULES_TEXT.appliesHint}</p>
        <fieldset className="agent-checks">
          <legend className="nv-field-label">{RULES_TEXT.kinds}</legend>
          {AGENT_ACTION_CLASSES.map((a) => (
            <label key={a} className="ws-check">
              <input
                type="checkbox"
                checked={actions.has(a)}
                onChange={() => setActions((s) => toggleIn(s, a))}
              />
              {ACTION_TEXT[a]}
            </label>
          ))}
        </fieldset>
        <fieldset className="agent-checks">
          <legend className="nv-field-label">{RULES_TEXT.effects}</legend>
          {AGENT_RULE_EFFECT_CLASSES.filter(
            // Sending, deleting and running commands are kinds of action above.
            (e) => !EFFECTS_OF_ACTIONS.includes(e) || effects.has(e),
          ).map((e) => (
            <label key={e} className="ws-check">
              <input
                type="checkbox"
                checked={effects.has(e)}
                onChange={() => setEffects((s) => toggleIn(s, e))}
              />
              {EFFECT_CLASS_TEXT[e]}
            </label>
          ))}
        </fieldset>
        <TextField
          label={RULES_TEXT.tools}
          value={tools}
          autoComplete="off"
          spellCheck={false}
          dir="ltr"
          hint={RULES_TEXT.toolsHint}
          error={errors.tools}
          onChange={(e) => setTools(e.target.value)}
        />
        <TextField
          label={RULES_TEXT.hosts}
          value={hosts}
          autoComplete="off"
          spellCheck={false}
          dir="ltr"
          hint={RULES_TEXT.hostsHint}
          error={errors.hosts}
          onChange={(e) => setHosts(e.target.value)}
        />
        <fieldset className="agent-checks">
          <legend className="nv-field-label">{RULES_TEXT.channels}</legend>
          {channels.map((c, i) => (
            <div key={i} className="agent-channel-row">
              <SelectField
                label={RULES_TEXT.channelN({ n: i + 1 })}
                value={c.kind}
                onChange={(v) =>
                  setChannels((list) =>
                    list.map((x, j) => (j === i ? { ...x, kind: v as ChannelKind } : x)),
                  )
                }
                options={CHANNEL_KINDS.map((k) => ({ value: k, label: CHANNEL_KIND_TEXT[k] }))}
              />
              <TextField
                label={RULES_TEXT.conversationN({ n: i + 1 })}
                value={c.conversation ?? ''}
                autoComplete="off"
                placeholder={RULES_TEXT.conversationPlaceholder}
                onChange={(e) =>
                  setChannels((list) =>
                    list.map((x, j) => (j === i ? { ...x, conversation: e.target.value } : x)),
                  )
                }
              />
              <IconButton
                label={RULES_TEXT.removeChannelN({ n: i + 1 })}
                icon={<Icon name="trash" />}
                variant="ghost"
                onClick={() => setChannels((list) => list.filter((_, j) => j !== i))}
              />
            </div>
          ))}
          {channels.length < 20 ? (
            <div>
              <Button onClick={() => setChannels((list) => [...list, { kind: 'slack' }])}>
                <Icon name="plus" /> {RULES_TEXT.addChannel}
              </Button>
            </div>
          ) : null}
        </fieldset>
        {err('match')}
      </fieldset>
      <fieldset className="ws-fieldset">
        <legend>{RULES_TEXT.command}</legend>
        <label className="ws-check">
          <input
            type="checkbox"
            checked={useCommand && commandAllowed}
            disabled={!commandAllowed}
            onChange={(e) => setUseCommand(e.target.checked)}
          />
          {RULES_TEXT.useCommand}
        </label>
        {commandAllowed ? null : (
          <p className="nv-field-hint ws-flush">
            {RULES_TEXT.commandOnly({
              act: RULE_EFFECT_TEXT.act.label,
              ask: RULE_EFFECT_TEXT.ask.label,
            })}
          </p>
        )}
        {useCommand && commandAllowed ? (
          <>
            <TextField
              label={RULES_TEXT.startsWith}
              value={pattern}
              spellCheck={false}
              autoComplete="off"
              dir="ltr"
              hint={RULES_TEXT.startsWithHint}
              error={errors.pattern}
              onChange={(e) => setPattern(e.target.value)}
            />
            <ExampleField
              id={`${id}-mx`}
              label={RULES_TEXT.matchEx}
              value={matchEx}
              onChange={setMatchEx}
              error={errors.matchExamples}
            />
            <ExampleField
              id={`${id}-nx`}
              label={RULES_TEXT.notMatchEx}
              value={notMatchEx}
              onChange={setNotMatchEx}
              error={errors.notMatchExamples}
            />
            <TextField
              label={RULES_TEXT.why}
              value={justification}
              maxLength={500}
              autoComplete="off"
              onChange={(e) => setJustification(e.target.value)}
            />
          </>
        ) : null}
        {err('command')}
      </fieldset>
      <details className="ws-advanced">
        <summary>{RULES_TEXT.advanced}</summary>
        <TextField
          label={RULES_TEXT.priorityLabel}
          className="ws-number"
          inputMode="numeric"
          value={priority}
          hint={RULES_TEXT.priorityHint({ min: 0, max: 1000, byDefault: 100 })}
          error={errors.priority}
          onChange={(e) => setPriority(e.target.value)}
        />
      </details>
      <label className="ws-check">
        <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
        {RULES_TEXT.enabled}
      </label>
      {failure ? (
        <p className="nv-field-error" role="alert">
          {failure}
        </p>
      ) : null}
      <div className="ws-toolbar">
        <Button type="submit" variant="primary" disabled={busy}>
          {busy ? <Spinner /> : null} {rule ? RULES_TEXT.save : RULES_TEXT.addRule}
        </Button>
        <Button onClick={onCancel}>{AGENTS_TEXT.cancel}</Button>
      </div>
    </form>
  );
}

function ExampleField({
  id,
  label,
  value,
  onChange,
  error,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
  error?: string | undefined;
}) {
  return (
    <div className="nv-field">
      <label className="nv-field-label" htmlFor={id}>
        {label}
      </label>
      <textarea
        id={id}
        className="nv-input ws-textarea"
        rows={2}
        spellCheck={false}
        value={value}
        aria-invalid={error ? true : undefined}
        aria-describedby={`${id}-hint${error ? ` ${id}-error` : ''}`}
        onChange={(e) => onChange(e.target.value)}
      />
      <span id={`${id}-hint`} className="nv-field-hint">
        {RULES_TEXT.examplesHint}
      </span>
      {error ? (
        <span id={`${id}-error`} className="nv-field-error" role="alert">
          {error}
        </span>
      ) : null}
    </div>
  );
}
