// One team agent (FR-091; `/team/agents/:id?tab=`): its identity, status and autonomy; a box where
// any person gives it a task (it runs under the agent's identity, prefixed with who asked); and
// its sections: Tasks (yours, or every task for the owner, with the result and Cancel), and for
// the owner Approvals (what the agent waits for, answered here), Credentials (provider accounts
// and website credentials bound to its identity; values are write-only, only `secret://`
// references come back) and Audit (everything its identity did). The owner can remove it.
import { useId, useState, type FormEvent, type ReactNode } from 'react';
import { defineMessages, messageFor } from '@nova/i18n';
import {
  EGRESS_CREDENTIAL_SCHEMES,
  PROVIDER_KINDS,
  checkHostPattern,
  type ApprovalView,
  type AuditEntryView,
  type ProviderKind,
  type RunAutonomy,
  type TeamAgentCredentialView,
  type TeamAgentView,
  type TeamTaskView,
} from '@nova/shared';
import {
  Button,
  EmptyState,
  Icon,
  RadioGroup,
  SelectField,
  Spinner,
  Tabs,
  TextField,
  useToast,
} from '@nova/ui';
import { AGENT_AUTONOMY_TEXT } from '../agents/format.ts';
import { PROVIDER_NAMES } from '../providers/names.ts';
import { navigate, useLocation } from '../router.ts';
import { useAnnounce } from '../services.tsx';
import { formatWhen, useInterval } from '../settings/common.ts';
import { useDebounced } from '../work/events.ts';
import { followLink } from '../work/nav.tsx';
import { useTeamApi, type TeamAgentCredentialBody } from './api.ts';
import { TEAM_AGENT_EVENTS, useTeamEvents } from './events.ts';
import {
  TEAM_TEXT,
  errorFields,
  personName,
  taskChip,
  teamAgentChip,
  teamAgentPath,
  teamErrorMessage,
} from './format.ts';
import { Chip, ConfirmDialog, FormError, LoadError, TextAreaField, useLoad } from './parts.tsx';
import { useTeamRole } from './role.tsx';
import { TEAM_AGENTS_TEXT } from './TeamAgentsList.tsx';
import '../workspace.css';
import './team.css';

const AGENT_TEXT = defineMessages('team.agent', {
  loadFailed: 'Could not load this agent.',
  loading: 'Loading the agent',
  tabs: {
    tasks: 'Tasks',
    yourTasks: 'Your tasks',
    approvals: 'Approvals',
    credentials: 'Credentials',
    audit: 'Audit',
  },
  teamAgent: 'Team agent',
  sections: 'Agent sections',
  removeHeading: 'Remove',
  removeIntro:
    'Removing it stops its work, removes its credentials from the vault and closes its identity. Its audit stays.',
  removeNamed: 'Remove {name}',
  removeTitle: 'Remove {name}?',
  removeWhat:
    'Its running task stops, its credentials leave the vault and its identity closes. People can no longer give it tasks.',
  removed: '{name} was removed.',
});

const TASK_TEXT = defineMessages('team.agent.tasks', {
  writeIt: 'Write what the agent should do.',
  given: 'Task given to {name}.',
  heading: 'Give it a task',
  taskFor: 'Task for {name}',
  runsAs: 'It runs as {name}, not as you; the agent sees that you asked.',
  give: 'Give the task',
  notTaking:
    '{status, select, paused {It is paused, so it does not take tasks now.} stopped {It is stopped, so it does not take tasks now.} other {It does not take tasks now.}}',
  givenStatus:
    '{status, select, queued {Task given. It is queued.} running {Task given. It is running.} done {Task given. It is done.} failed {Task given. It is failed.} cancelled {Task given. It is cancelled.} other {Task given.}}',
  giveFailed: 'Could not give the task.',
  cancelFailed: 'Could not cancel the task.',
  loadFailed: 'Could not load tasks.',
  loading: 'Loading tasks',
  emptyTitle: 'No tasks yet',
  emptyOwner: 'Nobody has given it a task yet.',
  emptyMember: 'Tasks you give it appear here.',
  list: 'Tasks',
  askedBy: 'Asked by {name}',
  askedBySomeone: 'Asked by someone',
  ended: 'Ended {when}',
  result: 'Result',
  cancelLabel: 'Cancel the task: {task}',
  cancel: 'Cancel',
});

const APPROVAL_TEXT = defineMessages('team.agent.approvals', {
  decide: {
    allow_once: 'Allow once',
    allow_session: 'Allow for this session',
    deny_continue: 'Deny and continue',
    deny_stop: 'Deny and stop',
  },
  answered: '{decision}: {action}.',
  risk: { low: 'Low', medium: 'Medium', high: 'High' },
  intro: 'What {name} waits for. You answer for its identity; it does not use your permissions.',
  refresh: 'Refresh',
  loadFailed: 'Could not load approvals.',
  loading: 'Loading approvals',
  empty: 'Nothing waits for you',
  list: 'Approvals',
  needsInput: 'Needs input',
  why: 'Why',
  tool: 'Tool',
  riskTerm: 'Risk',
  asked: 'Asked',
  answerFailed: 'Could not answer.',
});

const CREDENTIAL_TEXT = defineMessages('team.agent.credentials', {
  kind: { provider: 'Model provider', egress: 'Website credential' },
  scheme: {
    bearer: 'Bearer token',
    basic: 'User name and password',
    header: 'A header of your choice',
  },
  intro:
    'Credentials are bound to {name}’s identity: a model provider account it answers with, or a website credential the Hub adds to its requests to those hosts only. Values go to the Hub’s vault; only their references are shown.',
  none: 'No credentials yet: it answers with the offline mock model.',
  list: 'Credentials',
  noSecret: 'No secret',
  added: 'Added {when}',
  removeLabel: 'Remove {label}',
  saved: '{label} saved. Only its reference is kept here.',
  add: 'Add a credential',
  removeTitle: 'Remove {label}?',
  removeThis: 'Remove this credential?',
  removeWhat: "{name} can no longer use it, and its value leaves the Hub's vault.",
  nameNeeded: 'Name the credential.',
  hostNeeded: 'Name at least one host, like {example}.',
  headerNeeded: 'Enter the header name, like {example}.',
  valueNeeded: 'Enter the secret value.',
  form: 'New credential',
  kindLegend: 'Kind',
  providerWhat: 'An account at a model provider it answers with.',
  egressWhat: 'A token or password the Hub adds to its requests to these hosts only.',
  name: 'Name',
  provider: 'Provider',
  address: 'Address (optional)',
  addressHint: 'Only for a self-hosted or OpenAI-compatible server.',
  apiKey: 'API key',
  writeOnly: 'Write-only: it goes to the vault and is never shown again.',
  hosts: 'Hosts',
  hostsHint: 'One per line, like {example} or {wildcard}.',
  howSent: 'How it is sent',
  headerName: 'Header name',
  userName: 'User name',
  secretValue: 'Secret value',
  save: 'Save credential',
  saveFailed: 'Could not save the credential.',
});

const AUDIT_TEXT = defineMessages('team.agent.audit', {
  loadFailed: 'Could not load the audit.',
  loading: 'Loading the audit',
  empty: 'Nothing recorded yet',
  intro: 'Everything its identity did, newest first.',
  when: 'When',
  action: 'Action',
  on: 'On',
  outcome: 'Outcome',
  older: 'Show older',
  moreFailed: 'Could not load more.',
});

export const TEAM_AGENT_TABS = ['tasks', 'approvals', 'credentials', 'audit'] as const;
export type TeamAgentTab = (typeof TEAM_AGENT_TABS)[number];
const OWNER_TABS: readonly TeamAgentTab[] = ['approvals', 'credentials', 'audit'];

function Breadcrumb() {
  const path = teamAgentPath(null);
  return (
    <nav aria-label={TEAM_TEXT.breadcrumb} className="ws-breadcrumb">
      <a href={path} onClick={(e) => followLink(e, path)}>
        <Icon name="back" /> {TEAM_AGENTS_TEXT.heading}
      </a>
    </nav>
  );
}

export function TeamAgentPage({ agentId }: { agentId: string }) {
  const api = useTeamApi();
  const { role } = useTeamRole();
  const owner = role === 'owner';
  const toast = useToast();
  const loc = useLocation();
  const agent = useLoad(() => api.getTeamAgent(agentId), `team-agent-${agentId}`);
  const [taskVersion, setTaskVersion] = useState(0);
  const [removing, setRemoving] = useState(false);
  const query = new URLSearchParams(loc.includes('?') ? loc.slice(loc.indexOf('?') + 1) : '');
  const asked = query.get('tab');
  const allowed = TEAM_AGENT_TABS.filter((t) => owner || !OWNER_TABS.includes(t));
  const tab: TeamAgentTab = (allowed as readonly string[]).includes(asked ?? '')
    ? (asked as TeamAgentTab)
    : 'tasks';
  const reloadAgent = useDebounced(agent.reload, 150);
  useTeamEvents(TEAM_AGENT_EVENTS, (env) => {
    if (env.name === 'agent.updated') reloadAgent();
    else setTaskVersion((n) => n + 1);
  });

  const a = agent.data;
  if (!a)
    return (
      <div className="ws-page team-page">
        <Breadcrumb />
        {agent.error ? (
          <LoadError error={agent.error} fallback={AGENT_TEXT.loadFailed} onRetry={agent.reload} />
        ) : (
          <Spinner label={AGENT_TEXT.loading} />
        )}
      </div>
    );

  const autonomy = AGENT_AUTONOMY_TEXT[a.autonomy as RunAutonomy] as { label: string } | undefined;
  const panels: Record<TeamAgentTab, ReactNode> = {
    tasks: <Tasks agentId={agentId} version={taskVersion} owner={owner} />,
    approvals: <Approvals agent={a} />,
    credentials: <Credentials agent={a} onChanged={agent.reload} />,
    audit: <Audit agentId={agentId} />,
  };
  const labels: Record<TeamAgentTab, string> = {
    tasks: owner ? AGENT_TEXT.tabs.tasks : AGENT_TEXT.tabs.yourTasks,
    approvals: AGENT_TEXT.tabs.approvals,
    credentials: AGENT_TEXT.tabs.credentials,
    audit: AGENT_TEXT.tabs.audit,
  };

  return (
    <div className="ws-page team-page">
      <Breadcrumb />
      <header className="ws-page-header">
        <h1 dir="auto">{a.name}</h1>
        <Chip spec={teamAgentChip(a.status)} />
      </header>
      <p className="ws-row-meta muted ws-flush">
        <span className="ws-badge">{AGENT_TEXT.teamAgent}</span>
        {autonomy ? <span>{autonomy.label}</span> : null}
        <span>{TEAM_TEXT.made({ when: formatWhen(a.createdAt) })}</span>
      </p>
      <p className="muted ws-flush">{TEAM_AGENTS_TEXT.identity}</p>
      <GiveTask agent={a} onGiven={() => setTaskVersion((n) => n + 1)} />
      <Tabs
        label={AGENT_TEXT.sections}
        className="team-tabs"
        value={tab}
        onChange={(id) => navigate(teamAgentPath(agentId, id), { replace: true })}
        items={allowed.map((t) => ({
          id: t,
          label: labels[t],
          panel: t === tab ? panels[t] : null,
        }))}
      />
      {owner ? (
        <section className="ws-section" aria-labelledby="team-agent-remove">
          <h2 id="team-agent-remove">{AGENT_TEXT.removeHeading}</h2>
          <p className="muted ws-flush">{AGENT_TEXT.removeIntro}</p>
          <div className="row">
            <Button variant="danger" onClick={() => setRemoving(true)}>
              <Icon name="trash" /> {AGENT_TEXT.removeNamed({ name: a.name })}
            </Button>
          </div>
        </section>
      ) : null}
      <ConfirmDialog
        open={removing}
        title={AGENT_TEXT.removeTitle({ name: a.name })}
        description={AGENT_TEXT.removeWhat}
        confirmLabel={TEAM_TEXT.remove}
        danger
        onClose={() => setRemoving(false)}
        onConfirm={async () => {
          await api.removeTeamAgent(agentId);
          setRemoving(false);
          toast.show(AGENT_TEXT.removed({ name: a.name }), { tone: 'success' });
          navigate(teamAgentPath(null));
        }}
      />
    </div>
  );
}

// ---- give a task (anyone) -----------------------------------------------------------------------

function GiveTask({ agent, onGiven }: { agent: TeamAgentView; onGiven: () => void }) {
  const api = useTeamApi();
  const announce = useAnnounce();
  const id = useId();
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [given, setGiven] = useState<TeamTaskView | null>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!text.trim()) {
      setError(new Error(TASK_TEXT.writeIt));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const t = await api.giveTeamTask(agent.agentId, text.trim());
      setText('');
      setGiven(t);
      onGiven();
      announce(TASK_TEXT.given({ name: agent.name }));
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="ws-section stack" aria-labelledby={`${id}-h`} onSubmit={(e) => void submit(e)}>
      <h2 id={`${id}-h`}>{TASK_TEXT.heading}</h2>
      <TextAreaField
        label={TASK_TEXT.taskFor({ name: agent.name })}
        hint={TASK_TEXT.runsAs({ name: agent.name })}
        rows={3}
        maxLength={8000}
        value={text}
        onChange={(v) => {
          setText(v);
          setGiven(null);
        }}
      />
      <div className="row">
        <Button type="submit" variant="primary" disabled={busy || agent.status !== 'active'}>
          {busy ? <Spinner /> : <Icon name="send" />} {TASK_TEXT.give}
        </Button>
      </div>
      {agent.status !== 'active' ? (
        <p className="muted ws-flush">{TASK_TEXT.notTaking({ status: agent.status })}</p>
      ) : null}
      {given ? (
        <p className="team-notice ws-flush" data-tone="ok" role="status">
          <Icon name="check" /> {TASK_TEXT.givenStatus({ status: given.status })}
        </p>
      ) : null}
      <FormError error={error} fallback={TASK_TEXT.giveFailed} />
    </form>
  );
}

// ---- tasks -------------------------------------------------------------------------------------

function Tasks({ agentId, version, owner }: { agentId: string; version: number; owner: boolean }) {
  const api = useTeamApi();
  const toast = useToast();
  const list = useLoad(
    () => api.listTeamTasks(agentId).then((r) => r.items),
    `tasks-${agentId}-${version}`,
  );
  const people = useLoad(() => api.listTeamMembers().then((r) => r.items), 'task-people');
  const [cancelling, setCancelling] = useState<string | null>(null);
  const active = (list.data ?? []).some((t) => t.status === 'queued' || t.status === 'running');
  // Tasks others asked for change without an event to the owner: look again while one runs.
  useInterval(list.reload, 5000, active);
  const nameOf = (id: string) =>
    personName(
      people.data?.find((p) => p.accountId === id),
      '',
    );

  const cancel = async (t: TeamTaskView) => {
    setCancelling(t.id);
    try {
      const out = await api.cancelTeamTask(t.id);
      list.setData((prev) => prev?.map((x) => (x.id === out.id ? out : x)) ?? null);
    } catch (err) {
      toast.show(teamErrorMessage(err, TASK_TEXT.cancelFailed), { tone: 'error' });
    } finally {
      setCancelling(null);
    }
  };

  if (list.error && !list.data)
    return <LoadError error={list.error} fallback={TASK_TEXT.loadFailed} onRetry={list.reload} />;
  if (!list.data) return <Spinner label={TASK_TEXT.loading} />;
  if (list.data.length === 0)
    return (
      <EmptyState
        level={3}
        icon="work"
        title={TASK_TEXT.emptyTitle}
        description={owner ? TASK_TEXT.emptyOwner : TASK_TEXT.emptyMember}
      />
    );
  return (
    <ul className="ws-list" aria-label={TASK_TEXT.list}>
      {list.data.map((t) => {
        const asker = nameOf(t.requestedBy);
        return (
          <li key={t.id} className="ws-card team-task">
            <div className="ws-section-header">
              <span className="ws-row-meta muted">
                <span>{asker ? TASK_TEXT.askedBy({ name: asker }) : TASK_TEXT.askedBySomeone}</span>
                <span>{formatWhen(t.createdAt)}</span>
                {t.endedAt ? <span>{TASK_TEXT.ended({ when: formatWhen(t.endedAt) })}</span> : null}
              </span>
              <Chip spec={taskChip(t.status)} />
            </div>
            <p className="team-pre ws-flush" dir="auto">
              {t.text}
            </p>
            {t.result ? (
              <details>
                <summary>{TASK_TEXT.result}</summary>
                <p className="team-pre ws-flush" dir="auto">
                  {t.result}
                </p>
              </details>
            ) : null}
            {t.error ? <p className="nv-field-error ws-flush">{t.error}</p> : null}
            {t.status === 'queued' || t.status === 'running' ? (
              <div className="row">
                <Button
                  variant="ghost"
                  disabled={cancelling !== null}
                  onClick={() => void cancel(t)}
                  aria-label={TASK_TEXT.cancelLabel({ task: t.text.slice(0, 60) })}
                >
                  {cancelling === t.id ? <Spinner /> : <Icon name="stop" />} {TASK_TEXT.cancel}
                </Button>
              </div>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}

// ---- approvals (owner) -------------------------------------------------------------------------

/** The answers offered here, in this order (their words are APPROVAL_TEXT.decide). */
const DECIDE = ['allow_once', 'allow_session', 'deny_continue', 'deny_stop'] as const;

function Approvals({ agent }: { agent: TeamAgentView }) {
  const api = useTeamApi();
  const announce = useAnnounce();
  const list = useLoad(
    () => api.teamAgentApprovals(agent.agentId).then((r) => r.items),
    `approvals-${agent.agentId}`,
  );
  // The agent's identity is not yours, so its approvals are not on your event stream: look again.
  useInterval(list.reload, 10_000);
  const [busy, setBusy] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, unknown>>({});

  const decide = async (a: ApprovalView, kind: (typeof DECIDE)[number]) => {
    setBusy(a.id);
    setErrors((e) => ({ ...e, [a.id]: null }));
    try {
      await api.decideTeamAgentApproval(agent.agentId, a.id, { decision: kind });
      list.setData((prev) => prev?.filter((x) => x.id !== a.id) ?? null);
      announce(APPROVAL_TEXT.answered({ decision: APPROVAL_TEXT.decide[kind], action: a.action }));
    } catch (err) {
      setErrors((e) => ({ ...e, [a.id]: err }));
      list.reload();
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="stack">
      <div className="ws-section-header">
        <p className="muted ws-flush team-grow">{APPROVAL_TEXT.intro({ name: agent.name })}</p>
        <Button variant="ghost" onClick={list.reload}>
          <Icon name="refresh" /> {APPROVAL_TEXT.refresh}
        </Button>
      </div>
      {list.error ? (
        <LoadError error={list.error} fallback={APPROVAL_TEXT.loadFailed} onRetry={list.reload} />
      ) : null}
      {!list.data && !list.error ? <Spinner label={APPROVAL_TEXT.loading} /> : null}
      {list.data && list.data.length === 0 ? (
        <EmptyState level={3} icon="check" title={APPROVAL_TEXT.empty} />
      ) : null}
      {list.data && list.data.length > 0 ? (
        <ul className="ws-list" aria-label={APPROVAL_TEXT.list}>
          {list.data.map((a) => (
            <li key={a.id} className="ws-card team-approval" aria-label={a.action}>
              <div className="ws-section-header">
                <span className="team-strong">{a.action}</span>
                <span className="nv-chip" data-status="needs_input">
                  <Icon name="hand" /> <span>{APPROVAL_TEXT.needsInput}</span>
                </span>
              </div>
              <dl className="ws-dl">
                <dt>{APPROVAL_TEXT.why}</dt>
                <dd>{a.reason}</dd>
                {a.tool ? (
                  <>
                    <dt>{APPROVAL_TEXT.tool}</dt>
                    <dd>
                      <code className="ws-code-inline">{a.tool}</code>
                    </dd>
                  </>
                ) : null}
                {a.risk ? (
                  <>
                    <dt>{APPROVAL_TEXT.riskTerm}</dt>
                    <dd>{messageFor(APPROVAL_TEXT.risk, a.risk) ?? a.risk}</dd>
                  </>
                ) : null}
                <dt>{APPROVAL_TEXT.asked}</dt>
                <dd>{formatWhen(a.createdAt)}</dd>
              </dl>
              {a.argsPreview ? <pre className="team-args">{a.argsPreview}</pre> : null}
              <div className="row team-actions">
                {DECIDE.filter((kind) => a.options.includes(kind)).map((kind) => (
                  <Button
                    key={kind}
                    variant={kind === 'allow_once' ? 'primary' : 'default'}
                    disabled={busy !== null}
                    onClick={() => void decide(a, kind)}
                  >
                    {APPROVAL_TEXT.decide[kind]}
                  </Button>
                ))}
              </div>
              <FormError error={errors[a.id]} fallback={APPROVAL_TEXT.answerFailed} />
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

// ---- credentials (owner) -----------------------------------------------------------------------

function Credentials({ agent, onChanged }: { agent: TeamAgentView; onChanged: () => void }) {
  const api = useTeamApi();
  const toast = useToast();
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<TeamAgentCredentialView | null>(null);
  return (
    <div className="stack">
      <p className="muted ws-flush">{CREDENTIAL_TEXT.intro({ name: agent.name })}</p>
      {agent.credentials.length === 0 ? (
        <p className="ws-flush">{CREDENTIAL_TEXT.none}</p>
      ) : (
        <ul className="ws-list" aria-label={CREDENTIAL_TEXT.list}>
          {agent.credentials.map((c) => (
            <li key={c.id} className="ws-list-row">
              <span className="team-person-main">
                <span className="team-strong" dir="auto">
                  {c.label}
                </span>
                <span className="ws-row-meta muted">
                  <span>{messageFor(CREDENTIAL_TEXT.kind, c.kind) ?? c.kind}</span>
                  {c.secretRef ? (
                    <code className="ws-code-inline team-break">{c.secretRef}</code>
                  ) : (
                    <span>{CREDENTIAL_TEXT.noSecret}</span>
                  )}
                  <span>{CREDENTIAL_TEXT.added({ when: formatWhen(c.createdAt) })}</span>
                </span>
              </span>
              <Button
                variant="ghost"
                aria-label={CREDENTIAL_TEXT.removeLabel({ label: c.label })}
                onClick={() => setRemoving(c)}
              >
                <Icon name="trash" /> {TEAM_TEXT.remove}
              </Button>
            </li>
          ))}
        </ul>
      )}
      {adding ? (
        <CredentialForm
          agent={agent}
          onCancel={() => setAdding(false)}
          onSaved={(c) => {
            setAdding(false);
            onChanged();
            toast.show(CREDENTIAL_TEXT.saved({ label: c.label }), { tone: 'success' });
          }}
        />
      ) : (
        <div className="row">
          <Button onClick={() => setAdding(true)}>
            <Icon name="plus" /> {CREDENTIAL_TEXT.add}
          </Button>
        </div>
      )}
      <ConfirmDialog
        open={removing !== null}
        title={
          removing
            ? CREDENTIAL_TEXT.removeTitle({ label: removing.label })
            : CREDENTIAL_TEXT.removeThis
        }
        description={CREDENTIAL_TEXT.removeWhat({ name: agent.name })}
        confirmLabel={TEAM_TEXT.remove}
        danger
        onClose={() => setRemoving(null)}
        onConfirm={async () => {
          if (!removing) return;
          await api.removeTeamAgentCredential(agent.agentId, removing.id);
          setRemoving(null);
          onChanged();
        }}
      />
    </div>
  );
}

function CredentialForm({
  agent,
  onCancel,
  onSaved,
}: {
  agent: TeamAgentView;
  onCancel: () => void;
  onSaved: (c: TeamAgentCredentialView) => void;
}) {
  const api = useTeamApi();
  const [kind, setKind] = useState<'provider' | 'egress'>('provider');
  const [label, setLabel] = useState('');
  const [provider, setProvider] = useState<ProviderKind>('openai');
  const [baseUrl, setBaseUrl] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [hosts, setHosts] = useState('');
  const [scheme, setScheme] = useState<(typeof EGRESS_CREDENTIAL_SCHEMES)[number]>('bearer');
  const [header, setHeader] = useState('');
  const [username, setUsername] = useState('');
  const [value, setValue] = useState('');
  const [fields, setFields] = useState<Record<string, string>>({});
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const problems: Record<string, string> = {};
    if (!label.trim()) problems.label = CREDENTIAL_TEXT.nameNeeded;
    let body: TeamAgentCredentialBody;
    if (kind === 'provider') {
      body = {
        kind: 'provider',
        provider,
        label: label.trim(),
        ...(baseUrl.trim() ? { baseUrl: baseUrl.trim() } : {}),
        ...(apiKey ? { apiKey } : {}),
      };
    } else {
      const list = hosts
        .split(/[\s,]+/)
        .map((h) => h.trim())
        .filter(Boolean);
      if (!list.length) problems.hosts = CREDENTIAL_TEXT.hostNeeded({ example: 'api.example.com' });
      const bad = list.map((h) => checkHostPattern(h)).find((x) => x);
      if (bad) problems.hosts = `${bad.charAt(0).toUpperCase()}${bad.slice(1)}.`;
      if (scheme === 'header' && !/^[A-Za-z0-9-]{1,100}$/.test(header))
        problems.header = CREDENTIAL_TEXT.headerNeeded({ example: 'X-Api-Key' });
      if (!value) problems.value = CREDENTIAL_TEXT.valueNeeded;
      body = {
        kind: 'egress',
        label: label.trim(),
        hosts: list,
        scheme,
        ...(scheme === 'header' ? { header } : {}),
        ...(scheme === 'basic' && username ? { username } : {}),
        value,
      };
    }
    setFields(problems);
    if (Object.keys(problems).length) return;
    setBusy(true);
    setError(null);
    try {
      onSaved(await api.addTeamAgentCredential(agent.agentId, body));
    } catch (err) {
      setFields(errorFields(err));
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      className="ws-fieldset stack"
      onSubmit={(e) => void submit(e)}
      noValidate
      aria-label={CREDENTIAL_TEXT.form}
    >
      <RadioGroup
        legend={CREDENTIAL_TEXT.kindLegend}
        name="team-credential-kind"
        value={kind}
        onChange={(v) => {
          setKind(v === 'egress' ? 'egress' : 'provider');
          setFields({});
        }}
        options={[
          {
            value: 'provider',
            label: CREDENTIAL_TEXT.kind.provider,
            description: CREDENTIAL_TEXT.providerWhat,
          },
          {
            value: 'egress',
            label: CREDENTIAL_TEXT.kind.egress,
            description: CREDENTIAL_TEXT.egressWhat,
          },
        ]}
      />
      <TextField
        label={CREDENTIAL_TEXT.name}
        value={label}
        maxLength={100}
        onChange={(e) => setLabel(e.target.value)}
        error={fields.label}
      />
      {kind === 'provider' ? (
        <>
          <SelectField
            label={CREDENTIAL_TEXT.provider}
            value={provider}
            onChange={(v) => setProvider(v as ProviderKind)}
            options={PROVIDER_KINDS.filter((k) => k !== 'mock').map((k) => ({
              value: k,
              label: PROVIDER_NAMES[k] ?? k,
            }))}
          />
          <TextField
            label={CREDENTIAL_TEXT.address}
            hint={CREDENTIAL_TEXT.addressHint}
            value={baseUrl}
            inputMode="url"
            spellCheck={false}
            onChange={(e) => setBaseUrl(e.target.value)}
            error={fields.baseUrl}
          />
          <TextField
            label={CREDENTIAL_TEXT.apiKey}
            type="password"
            hint={CREDENTIAL_TEXT.writeOnly}
            value={apiKey}
            autoComplete="new-password"
            onChange={(e) => setApiKey(e.target.value)}
          />
        </>
      ) : (
        <>
          <TextAreaField
            label={CREDENTIAL_TEXT.hosts}
            hint={CREDENTIAL_TEXT.hostsHint({
              example: 'api.example.com',
              wildcard: '*.example.com',
            })}
            rows={2}
            spellCheck={false}
            value={hosts}
            onChange={setHosts}
            error={fields.hosts}
          />
          <SelectField
            label={CREDENTIAL_TEXT.howSent}
            value={scheme}
            onChange={(v) => setScheme(v as (typeof EGRESS_CREDENTIAL_SCHEMES)[number])}
            options={EGRESS_CREDENTIAL_SCHEMES.map((s) => ({
              value: s,
              label: messageFor(CREDENTIAL_TEXT.scheme, s) ?? s,
            }))}
          />
          {scheme === 'header' ? (
            <TextField
              label={CREDENTIAL_TEXT.headerName}
              value={header}
              onChange={(e) => setHeader(e.target.value)}
              error={fields.header}
            />
          ) : null}
          {scheme === 'basic' ? (
            <TextField
              label={CREDENTIAL_TEXT.userName}
              value={username}
              autoComplete="off"
              onChange={(e) => setUsername(e.target.value)}
            />
          ) : null}
          <TextField
            label={CREDENTIAL_TEXT.secretValue}
            type="password"
            hint={CREDENTIAL_TEXT.writeOnly}
            value={value}
            autoComplete="new-password"
            onChange={(e) => setValue(e.target.value)}
            error={fields.value}
          />
        </>
      )}
      <div className="row">
        <Button type="submit" variant="primary" disabled={busy}>
          {busy ? <Spinner /> : null} {CREDENTIAL_TEXT.save}
        </Button>
        <Button onClick={onCancel}>{TEAM_TEXT.cancel}</Button>
      </div>
      <FormError error={error} fallback={CREDENTIAL_TEXT.saveFailed} />
    </form>
  );
}

// ---- audit (owner) -----------------------------------------------------------------------------

function Audit({ agentId }: { agentId: string }) {
  const api = useTeamApi();
  const [items, setItems] = useState<AuditEntryView[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [more, setMore] = useState(false);
  const first = useLoad(
    () =>
      api.teamAgentAudit(agentId, { limit: 50 }).then((page) => {
        setItems(page.items);
        setCursor(page.nextCursor);
        return page;
      }),
    `audit-${agentId}`,
  );
  const [error, setError] = useState<unknown>(null);
  const loadMore = async () => {
    if (!cursor) return;
    setMore(true);
    try {
      const page = await api.teamAgentAudit(agentId, { limit: 50, cursor });
      setItems((prev) => [...prev, ...page.items]);
      setCursor(page.nextCursor);
    } catch (err) {
      setError(err);
    } finally {
      setMore(false);
    }
  };
  if (first.error && !first.data)
    return (
      <LoadError error={first.error} fallback={AUDIT_TEXT.loadFailed} onRetry={first.reload} />
    );
  if (!first.data) return <Spinner label={AUDIT_TEXT.loading} />;
  if (items.length === 0) return <EmptyState level={3} icon="activity" title={AUDIT_TEXT.empty} />;
  return (
    <div className="stack">
      <p className="muted ws-flush">{AUDIT_TEXT.intro}</p>
      <div className="team-table-wrap">
        <table className="ws-table">
          <thead>
            <tr>
              <th scope="col">{AUDIT_TEXT.when}</th>
              <th scope="col">{AUDIT_TEXT.action}</th>
              <th scope="col">{AUDIT_TEXT.on}</th>
              <th scope="col">{AUDIT_TEXT.outcome}</th>
            </tr>
          </thead>
          <tbody>
            {items.map((e) => (
              <tr key={e.id}>
                <td>{formatWhen(e.createdAt)}</td>
                <td>
                  <code className="ws-code-inline">{e.action}</code>
                </td>
                <td className="team-break" dir="ltr">
                  {e.resource ?? '—'}
                </td>
                <td translate="no">{e.decision ?? e.result ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {cursor ? (
        <div className="row">
          <Button onClick={() => void loadMore()} disabled={more}>
            {more ? <Spinner /> : null} {AUDIT_TEXT.older}
          </Button>
        </div>
      ) : null}
      <FormError error={error} fallback={AUDIT_TEXT.moreFailed} />
    </div>
  );
}
