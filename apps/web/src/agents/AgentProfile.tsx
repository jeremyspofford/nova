// The agent's profile (FR-079, FR-082, FR-085, FR-182): name, avatar, instructions, autonomy, the
// budgets of each piece of work, proactive research and the model, edited later. Only what changed
// is sent. Memory is turned on and off in its own section, which says what turning it off deletes.
import { useId, useState } from 'react';
import { defineMessages } from '@nova/i18n';
import type { AgentView, RunAutonomy } from '@nova/shared';
import { Button, SelectField, Spinner, TextField, useToast } from '@nova/ui';
import { errorMessage } from '../api.ts';
import { modelGroups } from '../providers/model-groups.ts';
import { SwitchField } from '../settings/controls.tsx';
import { formatWhen } from '../settings/common.ts';
import { useModels } from '../stores.tsx';
import { AvatarPicker, type AvatarUpload } from './AgentAvatar.tsx';
import { useAgentsApi, type UpdateAgentBody } from './api.ts';
import {
  AutonomyField,
  BudgetFields,
  budgetDraft,
  parseBudgets,
  type BudgetDraft,
} from './fields.tsx';
import { AGENTS_TEXT } from './format.ts';

export const PROFILE_TEXT = defineMessages('agents.profile', {
  saved: 'Profile saved.',
  saveFailed: 'Could not save the profile.',
  heading: 'Profile',
  instructionsHint: 'Changes apply from its next turn.',
  proactiveHint:
    'While idle it reads your connected sources with read-only tools and brings you suggestions.',
  proactiveHintLast:
    'While idle it reads your connected sources with read-only tools and brings you suggestions. Last research {when}.',
  save: 'Save profile',
  discard: 'Discard changes',
});

export function AgentProfile({
  agent,
  onAgent,
}: {
  agent: AgentView;
  onAgent: (a: AgentView) => void;
}) {
  const api = useAgentsApi();
  const toast = useToast();
  const id = `ap${useId()}`;
  const { models } = useModels();
  const [name, setName] = useState(agent.name);
  const [avatar, setAvatar] = useState<AvatarUpload | null | undefined>(undefined);
  const [instructions, setInstructions] = useState(agent.instructions);
  const [autonomy, setAutonomy] = useState<RunAutonomy>(agent.autonomy);
  const [budgets, setBudgets] = useState<BudgetDraft>(() => budgetDraft(agent.budgets));
  const [proactive, setProactive] = useState(agent.proactive.enabled);
  const [model, setModel] = useState(agent.model ?? '');
  const [errors, setErrors] = useState<{
    name?: string;
    budgets?: Partial<Record<keyof BudgetDraft, string>>;
  }>({});
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const parsed = parseBudgets(budgets);
  const body: UpdateAgentBody = {};
  if (name.trim() !== agent.name) body.name = name.trim();
  if (avatar !== undefined) body.avatar = avatar;
  if (instructions.trim() !== agent.instructions.trim()) body.instructions = instructions.trim();
  if (autonomy !== agent.autonomy) body.autonomy = autonomy;
  if (
    'budgets' in parsed &&
    (parsed.budgets.timeSeconds !== agent.budgets.timeSeconds ||
      parsed.budgets.tokens !== agent.budgets.tokens ||
      parsed.budgets.costUsd !== agent.budgets.costUsd)
  )
    body.budgets = parsed.budgets;
  if (proactive !== agent.proactive.enabled) body.proactive = proactive;
  if ((model || null) !== agent.model) body.model = model || null;
  const dirty = Object.keys(body).length > 0 || 'errors' in parsed;

  const reset = () => {
    setName(agent.name);
    setAvatar(undefined);
    setInstructions(agent.instructions);
    setAutonomy(agent.autonomy);
    setBudgets(budgetDraft(agent.budgets));
    setProactive(agent.proactive.enabled);
    setModel(agent.model ?? '');
    setErrors({});
    setFailure(null);
  };

  const save = async () => {
    const next: typeof errors = {};
    if (!name.trim()) next.name = AGENTS_TEXT.nameRequired;
    if ('errors' in parsed) next.budgets = parsed.errors;
    setErrors(next);
    setFailure(null);
    if (Object.keys(next).length || busy || Object.keys(body).length === 0) return;
    setBusy(true);
    try {
      const saved = await api.updateAgent(agent.id, body);
      onAgent(saved);
      setAvatar(undefined);
      toast.show(PROFILE_TEXT.saved, { tone: 'success' });
    } catch (err) {
      setFailure(errorMessage(err, PROFILE_TEXT.saveFailed));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      className="stack agent-section"
      aria-labelledby={`${id}-h`}
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <h2 id={`${id}-h`}>{PROFILE_TEXT.heading}</h2>
      <TextField
        label={AGENTS_TEXT.name}
        value={name}
        maxLength={100}
        autoComplete="off"
        error={errors.name}
        onChange={(e) => setName(e.target.value)}
      />
      <AvatarPicker
        name={name || agent.name}
        current={agent}
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
          rows={6}
          maxLength={16_000}
          dir="auto"
          value={instructions}
          aria-describedby={`${id}-instr-hint`}
          onChange={(e) => setInstructions(e.target.value)}
        />
        <span id={`${id}-instr-hint`} className="nv-field-hint">
          {PROFILE_TEXT.instructionsHint}
        </span>
      </div>
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
        description={
          agent.proactive.lastRunAt
            ? PROFILE_TEXT.proactiveHintLast({ when: formatWhen(agent.proactive.lastRunAt) })
            : PROFILE_TEXT.proactiveHint
        }
        checked={proactive}
        onChange={setProactive}
        disabled={busy}
      />
      <SelectField
        label={AGENTS_TEXT.model}
        value={model}
        onChange={setModel}
        options={[
          { value: '', label: AGENTS_TEXT.defaultModel },
          ...(model && !models.some((m) => m.ref === model)
            ? [{ value: model, label: model }]
            : []),
        ]}
        groups={modelGroups(models)}
      />
      {failure ? (
        <p className="nv-field-error" role="alert">
          {failure}
        </p>
      ) : null}
      <div className="ws-toolbar">
        <Button type="submit" variant="primary" disabled={busy || !dirty}>
          {busy ? <Spinner /> : null} {PROFILE_TEXT.save}
        </Button>
        <Button onClick={reset} disabled={busy || !dirty}>
          {PROFILE_TEXT.discard}
        </Button>
      </div>
    </form>
  );
}
