// Create an agent (FR-079, FR-082, FR-089, FR-181; docs/04 §2.5): name, avatar, instructions, one
// or more responsibilities with an optional goal, autonomy, budgets, proactive research and memory.
// Autonomy, budgets and proactive research start from Settings → Agents. A full page, so it works
// the same on a phone. After it is created the agent's page opens on its main thread.
import { useId, useState } from 'react';
import { defineMessages } from '@nova/i18n';
import type { RunAutonomy } from '@nova/shared';
import { Button, Icon, IconButton, SelectField, Spinner, TextField, useToast } from '@nova/ui';
import { errorMessage } from '../api.ts';
import { modelGroups } from '../providers/model-groups.ts';
import { navigate } from '../router.ts';
import { useSetting } from '../settings.tsx';
import { SwitchField } from '../settings/controls.tsx';
import { useModels } from '../stores.tsx';
import { followLink } from '../work/nav.tsx';
import { AvatarPicker, type AvatarUpload } from './AgentAvatar.tsx';
import { useAgentsApi, type CreateAgentBody } from './api.ts';
import {
  AutonomyField,
  BudgetFields,
  budgetDraft,
  parseBudgets,
  type BudgetDraft,
} from './fields.tsx';
import { AGENTS_PATH, AGENTS_TEXT, agentPath } from './format.ts';
import '../workspace.css';
import './agents.css';

export const NEW_AGENT_TEXT = defineMessages('agents.newAgent', {
  goalFailed: 'The agent was created, but its goal was not set: {reason}',
  ready: '{name} is ready.',
  createFailed: 'Could not create the agent.',
  heading: 'New agent',
  who: 'Who it is',
  instructionsHint:
    'How it should work, what to watch for, and how to reach you. You can change this later.',
  responsibilities: 'Responsibilities',
  respIntro: "Each responsibility is tracked on its own, with the agent's progress notes.",
  respN: 'Responsibility {n}',
  respPlaceholder: 'For example: Answer support questions in #help',
  respDetailsN: 'Details for responsibility {n} (optional)',
  removeRespN: 'Remove responsibility {n}',
  addResp: 'Add a responsibility',
  goal: 'Goal (optional)',
  goalHint:
    'An outcome it keeps working toward, turn after turn, until it is complete or a budget is ' +
    'reached. Held by the first responsibility.',
  how: 'How it works',
  proactiveHint:
    'While idle, at most once an hour by default, it reads your connected sources with ' +
    'read-only tools and brings you suggestions. It never acts on its own findings.',
  memoryHint:
    'It keeps notes and what it learns in conversation. You can read, edit and forget any of it.',
  create: 'Create agent',
});

const INSTRUCTIONS_MAX = 16_000;
const GOAL_MAX = 4000;

interface RespDraft {
  key: number;
  title: string;
  instructions: string;
}

export function NewAgentPage() {
  const api = useAgentsApi();
  const toast = useToast();
  const id = `na${useId()}`;
  const { models } = useModels();
  const defaultAutonomy = useSetting('agents.autonomy').value;
  const defaultBudgets = useSetting('agents.defaultBudgets').value;
  const proactiveDefault = useSetting('agents.proactive').value.enabledByDefault;

  const [name, setName] = useState('');
  const [avatar, setAvatar] = useState<AvatarUpload | null | undefined>(undefined);
  const [instructions, setInstructions] = useState('');
  const [resps, setResps] = useState<RespDraft[]>([{ key: 1, title: '', instructions: '' }]);
  const [goal, setGoal] = useState('');
  const [autonomy, setAutonomy] = useState<RunAutonomy>(defaultAutonomy);
  const [budgets, setBudgets] = useState<BudgetDraft>(() => budgetDraft(defaultBudgets));
  const [proactive, setProactive] = useState(proactiveDefault);
  const [memory, setMemory] = useState(true);
  const [model, setModel] = useState('');
  const [errors, setErrors] = useState<{
    name?: string;
    budgets?: Partial<Record<keyof BudgetDraft, string>>;
  }>({});
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const setResp = (key: number, patch: Partial<RespDraft>) =>
    setResps((list) => list.map((r) => (r.key === key ? { ...r, ...patch } : r)));

  const submit = async () => {
    const parsed = parseBudgets(budgets);
    const next: typeof errors = {};
    if (!name.trim()) next.name = AGENTS_TEXT.nameRequired;
    if ('errors' in parsed) next.budgets = parsed.errors;
    setErrors(next);
    setFailure(null);
    if (Object.keys(next).length || 'errors' in parsed || busy) return;
    const responsibilities = resps
      .filter((r) => r.title.trim())
      .map((r) => ({
        title: r.title.trim(),
        ...(r.instructions.trim() ? { instructions: r.instructions.trim() } : {}),
      }));
    const body: CreateAgentBody = {
      name: name.trim(),
      ...(instructions.trim() ? { instructions: instructions.trim() } : {}),
      ...(avatar ? { avatar } : {}),
      ...(responsibilities.length ? { responsibilities } : {}),
      autonomy,
      budgets: parsed.budgets,
      proactive,
      memoryEnabled: memory,
      ...(model ? { model } : {}),
    };
    setBusy(true);
    try {
      const agent = await api.createAgent(body);
      if (goal.trim()) {
        try {
          const holder = agent.responsibilities[0];
          await api.setAgentGoal(agent.id, {
            objective: goal.trim(),
            ...(holder ? { responsibilityId: holder.id } : {}),
          });
        } catch (err) {
          toast.show(NEW_AGENT_TEXT.goalFailed({ reason: errorMessage(err) }), {
            tone: 'error',
          });
        }
      }
      toast.show(NEW_AGENT_TEXT.ready({ name: agent.name }), { tone: 'success' });
      navigate(agentPath(agent.id));
    } catch (err) {
      setFailure(errorMessage(err, NEW_AGENT_TEXT.createFailed));
      setBusy(false);
    }
  };

  return (
    <div className="ws-page agents-page">
      <nav aria-label={AGENTS_TEXT.breadcrumb} className="ws-breadcrumb">
        <a href={AGENTS_PATH} onClick={(e) => followLink(e, AGENTS_PATH)}>
          <Icon name="back" /> {AGENTS_TEXT.agents}
        </a>
      </nav>
      <header className="ws-page-header">
        <h1>{NEW_AGENT_TEXT.heading}</h1>
      </header>
      <form
        className="stack agent-form"
        aria-label={NEW_AGENT_TEXT.heading}
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <section className="panel-inset stack" aria-labelledby={`${id}-who`}>
          <h2 id={`${id}-who`}>{NEW_AGENT_TEXT.who}</h2>
          <TextField
            label={AGENTS_TEXT.name}
            value={name}
            maxLength={100}
            autoComplete="off"
            required
            error={errors.name}
            onChange={(e) => {
              setName(e.target.value);
              setErrors((x) => ({ ...x, name: undefined }));
            }}
          />
          <AvatarPicker
            name={name}
            current={null}
            value={avatar}
            onChange={setAvatar}
            disabled={busy}
          />
          <div className="nv-field">
            <label className="nv-field-label" htmlFor={`${id}-instr`}>
              {AGENTS_TEXT.instructions}
            </label>
            <textarea
              id={`${id}-instr`}
              className="nv-input ws-textarea"
              rows={5}
              maxLength={INSTRUCTIONS_MAX}
              dir="auto"
              value={instructions}
              aria-describedby={`${id}-instr-hint`}
              onChange={(e) => setInstructions(e.target.value)}
            />
            <span id={`${id}-instr-hint`} className="nv-field-hint">
              {NEW_AGENT_TEXT.instructionsHint}
            </span>
          </div>
        </section>

        <section className="panel-inset stack" aria-labelledby={`${id}-resp`}>
          <h2 id={`${id}-resp`}>{NEW_AGENT_TEXT.responsibilities}</h2>
          <p className="muted ws-flush">{NEW_AGENT_TEXT.respIntro}</p>
          <ol className="agent-resp-drafts">
            {resps.map((r, i) => (
              <li key={r.key} className="agent-resp-draft">
                <TextField
                  label={NEW_AGENT_TEXT.respN({ n: i + 1 })}
                  value={r.title}
                  maxLength={200}
                  autoComplete="off"
                  placeholder={NEW_AGENT_TEXT.respPlaceholder}
                  onChange={(e) => setResp(r.key, { title: e.target.value })}
                />
                <TextField
                  label={NEW_AGENT_TEXT.respDetailsN({ n: i + 1 })}
                  value={r.instructions}
                  maxLength={4000}
                  autoComplete="off"
                  onChange={(e) => setResp(r.key, { instructions: e.target.value })}
                />
                {resps.length > 1 ? (
                  <IconButton
                    label={NEW_AGENT_TEXT.removeRespN({ n: i + 1 })}
                    icon={<Icon name="trash" />}
                    variant="ghost"
                    onClick={() => setResps((list) => list.filter((x) => x.key !== r.key))}
                  />
                ) : null}
              </li>
            ))}
          </ol>
          {resps.length < 20 ? (
            <div className="ws-toolbar">
              <Button
                onClick={() =>
                  setResps((list) => [
                    ...list,
                    {
                      key: Math.max(0, ...list.map((x) => x.key)) + 1,
                      title: '',
                      instructions: '',
                    },
                  ])
                }
              >
                <Icon name="plus" /> {NEW_AGENT_TEXT.addResp}
              </Button>
            </div>
          ) : null}
          <div className="nv-field">
            <label className="nv-field-label" htmlFor={`${id}-goal`}>
              {NEW_AGENT_TEXT.goal}
            </label>
            <textarea
              id={`${id}-goal`}
              className="nv-input ws-textarea"
              rows={2}
              maxLength={GOAL_MAX}
              dir="auto"
              value={goal}
              aria-describedby={`${id}-goal-hint`}
              onChange={(e) => setGoal(e.target.value)}
            />
            <span id={`${id}-goal-hint`} className="nv-field-hint">
              {NEW_AGENT_TEXT.goalHint}
            </span>
          </div>
        </section>

        <section className="panel-inset stack" aria-labelledby={`${id}-how`}>
          <h2 id={`${id}-how`}>{NEW_AGENT_TEXT.how}</h2>
          <AutonomyField value={autonomy} onChange={setAutonomy} disabled={busy} />
          <BudgetFields
            value={budgets}
            onChange={(b) => {
              setBudgets(b);
              setErrors((x) => ({ ...x, budgets: undefined }));
            }}
            errors={errors.budgets}
            disabled={busy}
          />
          <SwitchField
            label={AGENTS_TEXT.proactive}
            description={NEW_AGENT_TEXT.proactiveHint}
            checked={proactive}
            onChange={setProactive}
            disabled={busy}
          />
          <SwitchField
            label={AGENTS_TEXT.memory}
            description={NEW_AGENT_TEXT.memoryHint}
            checked={memory}
            onChange={setMemory}
            disabled={busy}
          />
          <SelectField
            label={AGENTS_TEXT.model}
            value={model}
            onChange={setModel}
            options={[{ value: '', label: AGENTS_TEXT.defaultModel }]}
            groups={modelGroups(models)}
          />
        </section>

        {failure ? (
          <p className="nv-field-error" role="alert">
            {failure}
          </p>
        ) : null}
        <div className="ws-toolbar">
          <Button type="submit" variant="primary" disabled={busy}>
            {busy ? <Spinner /> : null} {NEW_AGENT_TEXT.create}
          </Button>
          <Button onClick={() => navigate(AGENTS_PATH)} disabled={busy}>
            {AGENTS_TEXT.cancel}
          </Button>
        </div>
      </form>
    </div>
  );
}
