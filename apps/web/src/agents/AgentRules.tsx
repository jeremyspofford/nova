// The agent's custom rules (FR-084, FR-191; docs/12 §3): Take action without asking, Take action
// when you say so, Ask before taking action, Hand off to you, each scoped to kinds of action,
// effects, tools, hosts or channels, optionally with a command prefix rule. Rules are editable,
// can be turned off, deleted (with a confirmation) and previewed: the preview lists the agent's
// recent actions the rule would have matched. Rules never override built-in safety.
import { useEffect, useId, useState } from 'react';
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
  CHANNEL_KIND_TEXT,
  EFFECTS_OF_ACTIONS,
  matchText,
  RULE_EFFECT_ICON,
  RULE_EFFECT_TEXT,
  splitList,
} from './format.ts';

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
      (err: unknown) => alive && setError(errorMessage(err, 'Could not load the rules.')),
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
        toast.show(next.enabled ? 'Rule turned on.' : 'Rule turned off.', { tone: 'success' });
      },
      (err: unknown) =>
        toast.show(`Could not change the rule: ${errorMessage(err)}`, { tone: 'error' }),
    );
  };

  return (
    <section className="agent-section" aria-labelledby={headingId}>
      <div className="ws-section-header">
        <h2 id={headingId}>Rules</h2>
        {editing === 'new' ? null : (
          <Button onClick={() => setEditing('new')}>
            <Icon name="plus" /> Add a rule
          </Button>
        )}
      </div>
      <p className="muted ws-flush">
        Rules are instructions this agent follows. They cannot give it access it does not have and
        never override built-in safety: purchases, password changes and other confirmed actions
        still ask.
      </p>
      {editing === 'new' ? (
        <RuleForm
          rule={null}
          onCancel={() => setEditing(null)}
          onSave={async (body) => {
            replace(await api.createAgentRule(agentId, body));
            setEditing(null);
            toast.show('Rule added.', { tone: 'success' });
          }}
        />
      ) : null}
      {error ? (
        <div className="ws-error" role="alert">
          <p>{error}</p>
          <Button onClick={() => setManual((n) => n + 1)}>Retry</Button>
        </div>
      ) : sorted === null ? (
        <Spinner label="Loading the rules" />
      ) : sorted.length === 0 ? (
        <p className="muted">
          No rules. The agent follows your permissions and its autonomy. Add a rule such as “Ask
          before messaging customers” or “Hand off payments to me”.
        </p>
      ) : (
        <ul className="ws-list" aria-label="Rules">
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
                    toast.show('Rule saved.', { tone: 'success' });
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
                  <span className="ws-card-link">{r.description}</span>
                  <span className="ws-row-meta">
                    <span className="ws-badge agent-effect" data-effect={r.effect}>
                      <Icon name={RULE_EFFECT_ICON[r.effect]} /> {RULE_EFFECT_TEXT[r.effect].label}
                    </span>
                    {r.enabled ? null : (
                      <span className="ws-badge">
                        <Icon name="stop" /> Off
                      </span>
                    )}
                    <span className="muted">Priority {r.priority}</span>
                  </span>
                  <span className="muted agent-text">Applies to: {matchText(r.match)}</span>
                  {r.command ? (
                    <span className="muted agent-text">
                      Commands starting with <code>{patternText(r.command.pattern)}</code>
                    </span>
                  ) : null}
                </div>
                <div className="ws-row-actions ws-toolbar">
                  <Switch
                    checked={r.enabled}
                    label={`${r.description}: on`}
                    onChange={() => toggle(r)}
                  />
                  <Button
                    aria-expanded={previewing.has(r.id)}
                    aria-label={`Preview ${r.description}`}
                    onClick={() =>
                      setPreviewing((s) => {
                        const next = new Set(s);
                        if (next.has(r.id)) next.delete(r.id);
                        else next.add(r.id);
                        return next;
                      })
                    }
                  >
                    Preview
                  </Button>
                  <Button aria-label={`Edit ${r.description}`} onClick={() => setEditing(r.id)}>
                    Edit
                  </Button>
                  <Button
                    variant="danger"
                    aria-label={`Delete ${r.description}`}
                    onClick={() => setDeleting(r)}
                  >
                    Delete
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
        title="Delete this rule?"
        description={
          deleting
            ? `“${deleting.description}” no longer applies. The agent's permissions and autonomy decide instead.`
            : undefined
        }
        onClose={() => setDeleting(null)}
        footer={
          <>
            <Button onClick={() => setDeleting(null)}>Cancel</Button>
            <Button
              variant="danger"
              onClick={() => {
                const r = deleting;
                setDeleting(null);
                if (!r) return;
                api.deleteAgentRule(agentId, r.id).then(
                  () => {
                    setRules((list) => list?.filter((x) => x.id !== r.id) ?? null);
                    toast.show('Rule deleted.', { tone: 'success' });
                  },
                  (err: unknown) =>
                    toast.show(`Could not delete it: ${errorMessage(err)}`, { tone: 'error' }),
                );
              }}
            >
              Delete
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
      (err: unknown) => alive && setError(errorMessage(err, 'Could not load the preview.')),
    );
    return () => {
      alive = false;
    };
  }, [api, agentId, rule.id, rule.updatedAt]);
  return (
    <section className="agent-preview" aria-labelledby={headingId}>
      <h3 id={headingId} className="ws-subhead">
        Recent actions this rule matches
      </h3>
      {error ? (
        <p role="alert" className="nv-field-error">
          {error}
        </p>
      ) : items === null ? (
        <Spinner label="Loading the preview" />
      ) : items.length === 0 ? (
        <p className="muted ws-flush">None of the agent&apos;s recent actions match this rule.</p>
      ) : (
        <ul className="ws-plain-list">
          {items.map((it) => (
            <li key={it.callId}>
              <code>{it.tool}</code> · {it.status}
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
    if (!description.trim()) next.description = 'Say what the rule does, in a few words.';
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
      next.tools = 'Use tool names or globs such as email.send or slack.*.';
    if (hostList.some((h) => !/^(\*\.)?[A-Za-z0-9.-]{1,253}$/.test(h)))
      next.hosts = 'Use host names such as example.com or *.example.com.';
    if (hostList.length && channelList.length)
      next.match = 'A rule names hosts or channels, not both.';
    const prio = Number(priority);
    if (!/^\d+$/.test(priority.trim()) || prio > 1000)
      next.priority = 'Enter a whole number from 0 to 1000.';
    let command: AgentRuleBody['command'];
    if (useCommand && commandAllowed) {
      const parsed = parsePattern(pattern);
      const mx = lines(matchEx);
      const nx = lines(notMatchEx);
      if ('error' in parsed) next.pattern = parsed.error;
      if (!mx.length) next.matchExamples = 'Add at least one command this rule should match.';
      if (!nx.length) next.notMatchExamples = 'Add at least one command it should not match.';
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
      const msg = errorMessage(err, 'Could not save the rule.');
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
      aria-label={rule ? `Edit rule: ${rule.description}` : 'New rule'}
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <TextField
        label="Rule"
        value={description}
        maxLength={300}
        autoComplete="off"
        autoFocus
        placeholder="For example: Ask before messaging customers"
        error={errors.description}
        onChange={(e) => setDescription(e.target.value)}
      />
      <RadioGroup
        legend="What the agent does"
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
        <legend>Applies to</legend>
        <p className="nv-field-hint ws-flush">
          Leave everything empty to cover every action. Each part you fill in narrows the rule.
        </p>
        <fieldset className="agent-checks">
          <legend className="nv-field-label">Kinds of action</legend>
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
          <legend className="nv-field-label">Effects</legend>
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
          label="Tools"
          value={tools}
          autoComplete="off"
          spellCheck={false}
          hint="Tool names or globs, separated by commas: email.send, slack.*"
          error={errors.tools}
          onChange={(e) => setTools(e.target.value)}
        />
        <TextField
          label="Hosts"
          value={hosts}
          autoComplete="off"
          spellCheck={false}
          hint="Web hosts, separated by commas: example.com, *.customer.com"
          error={errors.hosts}
          onChange={(e) => setHosts(e.target.value)}
        />
        <fieldset className="agent-checks">
          <legend className="nv-field-label">Channels</legend>
          {channels.map((c, i) => (
            <div key={i} className="agent-channel-row">
              <SelectField
                label={`Channel ${i + 1}`}
                value={c.kind}
                onChange={(v) =>
                  setChannels((list) =>
                    list.map((x, j) => (j === i ? { ...x, kind: v as ChannelKind } : x)),
                  )
                }
                options={CHANNEL_KINDS.map((k) => ({ value: k, label: CHANNEL_KIND_TEXT[k] }))}
              />
              <TextField
                label={`Conversation for channel ${i + 1} (optional)`}
                value={c.conversation ?? ''}
                autoComplete="off"
                placeholder="#general, a person, or an id"
                onChange={(e) =>
                  setChannels((list) =>
                    list.map((x, j) => (j === i ? { ...x, conversation: e.target.value } : x)),
                  )
                }
              />
              <IconButton
                label={`Remove channel ${i + 1}`}
                icon={<Icon name="trash" />}
                variant="ghost"
                onClick={() => setChannels((list) => list.filter((_, j) => j !== i))}
              />
            </div>
          ))}
          {channels.length < 20 ? (
            <div>
              <Button onClick={() => setChannels((list) => [...list, { kind: 'slack' }])}>
                <Icon name="plus" /> Add a channel
              </Button>
            </div>
          ) : null}
        </fieldset>
        {err('match')}
      </fieldset>
      <fieldset className="ws-fieldset">
        <legend>Command prefix rule</legend>
        <label className="ws-check">
          <input
            type="checkbox"
            checked={useCommand && commandAllowed}
            disabled={!commandAllowed}
            onChange={(e) => setUseCommand(e.target.checked)}
          />
          Match commands the agent runs by how they start
        </label>
        {commandAllowed ? null : (
          <p className="nv-field-hint ws-flush">
            Only “Take action without asking” and “Ask before taking action” rules can match
            commands.
          </p>
        )}
        {useCommand && commandAllowed ? (
          <>
            <TextField
              label="Command starts with"
              value={pattern}
              spellCheck={false}
              autoComplete="off"
              hint="Words in order; use | for alternatives, for example: git status|diff"
              error={errors.pattern}
              onChange={(e) => setPattern(e.target.value)}
            />
            <ExampleField
              id={`${id}-mx`}
              label="Commands it should match"
              value={matchEx}
              onChange={setMatchEx}
              error={errors.matchExamples}
            />
            <ExampleField
              id={`${id}-nx`}
              label="Commands it should not match"
              value={notMatchEx}
              onChange={setNotMatchEx}
              error={errors.notMatchExamples}
            />
            <TextField
              label="Why (optional)"
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
      <label className="ws-check">
        <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
        Rule is on
      </label>
      {failure ? (
        <p className="nv-field-error" role="alert">
          {failure}
        </p>
      ) : null}
      <div className="ws-toolbar">
        <Button type="submit" variant="primary" disabled={busy}>
          {busy ? <Spinner /> : null} {rule ? 'Save rule' : 'Add rule'}
        </Button>
        <Button onClick={onCancel}>Cancel</Button>
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
        One command per line. Checked every time the rule is saved.
      </span>
      {error ? (
        <span id={`${id}-error`} className="nv-field-error" role="alert">
          {error}
        </span>
      ) : null}
    </div>
  );
}
