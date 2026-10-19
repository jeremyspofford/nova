// Team → Team agents (FR-091): agents with an identity of their own, not a person's account. Every
// person of the Hub sees them and can give them a task; the owner provisions them (name,
// responsibilities, instructions, autonomy, model) and binds their credentials on the agent's
// page. Below the list, the recent tasks: your own, or every task for the owner.
import { useId, useState, type FormEvent } from 'react';
import {
  RUN_AUTONOMY,
  type RunAutonomy,
  type TeamAgentView,
  type TeamTaskView,
} from '@nova/shared';
import { Button, EmptyState, Icon, RadioGroup, Spinner, TextField, useToast } from '@nova/ui';
import { AGENT_AUTONOMY_TEXT } from '../agents/format.ts';
import { navigate } from '../router.ts';
import { formatWhen } from '../settings/common.ts';
import { useDebounced } from '../work/events.ts';
import { followLink } from '../work/nav.tsx';
import { useTeamApi } from './api.ts';
import { TEAM_AGENT_EVENTS, useTeamEvents } from './events.ts';
import {
  NEW_TEAM_AGENT_ID,
  errorFields,
  taskChip,
  teamAgentChip,
  teamAgentPath,
} from './format.ts';
import { Chip, FormError, LoadError, OwnerOnlyNotice, TextAreaField, useLoad } from './parts.tsx';
import { useTeamRole } from './role.tsx';

export const TEAM_AGENT_IDENTITY_TEXT =
  'A team agent works under an identity of its own: it never signs in, and it uses no person’s account, memory or connectors. Anyone on this Hub can give it a task, and its audit names the agent.';

export function TeamAgentsList() {
  const api = useTeamApi();
  const { role } = useTeamRole();
  const owner = role === 'owner';
  const headingId = useId();
  const agents = useLoad(() => api.listTeamAgents().then((r) => r.items), 'team-agents');
  const tasks = useLoad(() => api.listTeamTasks().then((r) => r.items), 'team-tasks');
  const reload = useDebounced(() => {
    agents.reload();
    tasks.reload();
  }, 150);
  useTeamEvents(TEAM_AGENT_EVENTS, reload, reload);
  const newPath = teamAgentPath(NEW_TEAM_AGENT_ID);
  const nameOf = (id: string) => agents.data?.find((a) => a.agentId === id)?.name ?? 'A team agent';

  return (
    <section className="stack team-section" aria-labelledby={headingId}>
      <div className="ws-section-header">
        <h2 id={headingId} className="nv-vh">
          Team agents
        </h2>
        <p className="muted ws-flush team-grow">{TEAM_AGENT_IDENTITY_TEXT}</p>
        {owner ? (
          <a
            className="nv-btn"
            data-variant="primary"
            href={newPath}
            onClick={(e) => followLink(e, newPath)}
          >
            <Icon name="plus" /> Provision an agent
          </a>
        ) : null}
      </div>
      {agents.error ? (
        <LoadError
          error={agents.error}
          fallback="Could not load the team agents."
          onRetry={agents.reload}
        />
      ) : null}
      {agents.loading ? <Spinner label="Loading team agents" /> : null}
      {agents.data && agents.data.length === 0 ? (
        <EmptyState
          level={3}
          icon="agents"
          title="No team agents yet"
          description={
            owner
              ? 'Provision one for work the whole Hub shares, like answering support mail or keeping a shared calendar.'
              : 'The owner of this Hub has not set one up.'
          }
        />
      ) : null}
      {agents.data && agents.data.length > 0 ? (
        <ul className="ws-list" aria-label="Team agents">
          {agents.data.map((a) => (
            <AgentRow key={a.agentId} a={a} owner={owner} />
          ))}
        </ul>
      ) : null}
      <RecentTasks
        tasks={tasks.data}
        error={tasks.error}
        onRetry={tasks.reload}
        nameOf={nameOf}
        owner={owner}
      />
    </section>
  );
}

function AgentRow({ a, owner }: { a: TeamAgentView; owner: boolean }) {
  const path = teamAgentPath(a.agentId);
  const autonomy = AGENT_AUTONOMY_TEXT[a.autonomy as RunAutonomy] as { label: string } | undefined;
  return (
    <li className="ws-card">
      <div className="ws-section-header">
        <a className="ws-card-link" href={path} onClick={(e) => followLink(e, path)}>
          {a.name}
        </a>
        <Chip spec={teamAgentChip(a.status)} />
      </div>
      <span className="ws-card-meta muted">
        {autonomy ? `${autonomy.label} · ` : ''}Made {formatWhen(a.createdAt)}
        {owner
          ? ` · ${a.credentials.length === 1 ? '1 credential' : `${a.credentials.length} credentials`}`
          : ''}
      </span>
    </li>
  );
}

function RecentTasks({
  tasks,
  error,
  onRetry,
  nameOf,
  owner,
}: {
  tasks: TeamTaskView[] | null;
  error: unknown;
  onRetry: () => void;
  nameOf: (agentId: string) => string;
  owner: boolean;
}) {
  const headingId = useId();
  return (
    <section className="ws-section" aria-labelledby={headingId}>
      <h2 id={headingId}>{owner ? 'Recent tasks' : 'Your recent tasks'}</h2>
      {error ? (
        <LoadError error={error} fallback="Could not load tasks." onRetry={onRetry} />
      ) : null}
      {tasks && tasks.length === 0 ? (
        <p className="muted ws-flush">No tasks yet. Open an agent to give it one.</p>
      ) : null}
      {tasks && tasks.length > 0 ? (
        <ul className="ws-list" aria-label="Recent tasks">
          {tasks.slice(0, 10).map((t) => {
            const path = teamAgentPath(t.agentId, 'tasks');
            return (
              <li key={t.id} className="ws-list-row">
                <span className="team-person-main">
                  <a href={path} onClick={(e) => followLink(e, path)} className="team-clamp">
                    {t.text}
                  </a>
                  <span className="ws-row-meta muted">
                    <span>{nameOf(t.agentId)}</span>
                    <span>{formatWhen(t.createdAt)}</span>
                  </span>
                </span>
                <Chip spec={taskChip(t.status)} />
              </li>
            );
          })}
        </ul>
      ) : null}
    </section>
  );
}

// ---- provisioning (owner) ----------------------------------------------------------------------

interface Duty {
  key: number;
  title: string;
  instructions: string;
}

export function NewTeamAgent() {
  const api = useTeamApi();
  const { role } = useTeamRole();
  const toast = useToast();
  const [name, setName] = useState('');
  const [instructions, setInstructions] = useState('');
  const [autonomy, setAutonomy] = useState<RunAutonomy>('standard');
  const [model, setModel] = useState('');
  const [duties, setDuties] = useState<Duty[]>([{ key: 1, title: '', instructions: '' }]);
  const [fields, setFields] = useState<Record<string, string>>({});
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const back = teamAgentPath(null);

  if (role === 'member')
    return (
      <div className="ws-page team-page">
        <OwnerOnlyNotice what="Provisioning team agents" />
      </div>
    );

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim()) {
      setFields({ name: 'Give the agent a name.' });
      return;
    }
    const responsibilities = duties
      .filter((d) => d.title.trim())
      .map((d) => ({
        title: d.title.trim(),
        ...(d.instructions.trim() ? { instructions: d.instructions.trim() } : {}),
      }));
    setBusy(true);
    setError(null);
    try {
      const a = await api.provisionTeamAgent({
        name: name.trim(),
        autonomy,
        ...(instructions.trim() ? { instructions: instructions.trim() } : {}),
        ...(responsibilities.length ? { responsibilities } : {}),
        ...(model.trim() ? { model: model.trim() } : {}),
      });
      toast.show(`${a.name} is ready. Give it credentials so it can work.`, { tone: 'success' });
      navigate(teamAgentPath(a.agentId, 'credentials'));
    } catch (err) {
      setFields(errorFields(err));
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  const setDuty = (key: number, patch: Partial<Duty>) =>
    setDuties((prev) => prev.map((d) => (d.key === key ? { ...d, ...patch } : d)));

  return (
    <div className="ws-page team-page">
      <nav aria-label="Breadcrumb" className="ws-breadcrumb">
        <a href={back} onClick={(e) => followLink(e, back)}>
          <Icon name="back" /> Team agents
        </a>
      </nav>
      <header className="ws-page-header">
        <h1>Provision a team agent</h1>
      </header>
      <p className="muted ws-flush">{TEAM_AGENT_IDENTITY_TEXT}</p>
      <form className="stack" onSubmit={(e) => void submit(e)} noValidate>
        <TextField
          label="Name"
          value={name}
          maxLength={100}
          onChange={(e) => {
            setName(e.target.value);
            setFields({});
          }}
          error={fields.name}
        />
        <fieldset className="ws-fieldset">
          <legend>Responsibilities</legend>
          <p className="muted ws-flush">
            What it looks after. Each one can carry its own instructions.
          </p>
          {duties.map((d, i) => (
            <div key={d.key} className="stack team-duty">
              <TextField
                label={`Responsibility ${i + 1}`}
                value={d.title}
                maxLength={200}
                onChange={(e) => setDuty(d.key, { title: e.target.value })}
              />
              <TextAreaField
                label={`Instructions for responsibility ${i + 1} (optional)`}
                rows={2}
                maxLength={4000}
                value={d.instructions}
                onChange={(v) => setDuty(d.key, { instructions: v })}
              />
              {duties.length > 1 ? (
                <div className="row">
                  <Button
                    variant="ghost"
                    aria-label={`Remove responsibility ${i + 1}`}
                    onClick={() => setDuties((prev) => prev.filter((x) => x.key !== d.key))}
                  >
                    <Icon name="trash" /> Remove
                  </Button>
                </div>
              ) : null}
            </div>
          ))}
          {duties.length < 20 ? (
            <div className="row">
              <Button
                onClick={() =>
                  setDuties((prev) => [
                    ...prev,
                    {
                      key: Math.max(0, ...prev.map((x) => x.key)) + 1,
                      title: '',
                      instructions: '',
                    },
                  ])
                }
              >
                <Icon name="plus" /> Add a responsibility
              </Button>
            </div>
          ) : null}
        </fieldset>
        <TextAreaField
          label="Instructions (optional)"
          hint="How it should work and talk, for every task."
          rows={4}
          maxLength={16000}
          value={instructions}
          onChange={setInstructions}
        />
        <RadioGroup
          legend="Autonomy"
          name="team-agent-autonomy"
          value={autonomy}
          onChange={(v) => setAutonomy(v as RunAutonomy)}
          options={RUN_AUTONOMY.map((a) => ({
            value: a,
            label: AGENT_AUTONOMY_TEXT[a].label,
            description: AGENT_AUTONOMY_TEXT[a].description,
          }))}
        />
        <TextField
          label="Model (optional)"
          hint="A model of a provider credential you give it, like gpt-5. Until then it answers with the offline mock."
          value={model}
          maxLength={300}
          spellCheck={false}
          onChange={(e) => setModel(e.target.value)}
          error={fields.model}
        />
        <div className="row">
          <Button type="submit" variant="primary" disabled={busy}>
            {busy ? <Spinner /> : null} Provision
          </Button>
          <a className="nv-btn" href={back} onClick={(e) => followLink(e, back)}>
            Cancel
          </a>
        </div>
        <FormError error={error} fallback="Could not provision the agent." />
      </form>
    </div>
  );
}
