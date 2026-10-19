// One team agent (FR-091; `/team/agents/:id?tab=`): its identity, status and autonomy; a box where
// any person gives it a task (it runs under the agent's identity, prefixed with who asked); and
// its sections: Tasks (yours, or every task for the owner, with the result and Cancel), and for
// the owner Approvals (what the agent waits for, answered here), Credentials (provider accounts
// and website credentials bound to its identity; values are write-only, only `secret://`
// references come back) and Audit (everything its identity did). The owner can remove it.
import { useId, useState, type FormEvent, type ReactNode } from 'react';
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
  errorFields,
  personName,
  taskChip,
  teamAgentChip,
  teamAgentPath,
  teamErrorMessage,
} from './format.ts';
import { Chip, ConfirmDialog, FormError, LoadError, TextAreaField, useLoad } from './parts.tsx';
import { useTeamRole } from './role.tsx';
import { TEAM_AGENT_IDENTITY_TEXT } from './TeamAgentsList.tsx';
import '../workspace.css';
import './team.css';

export const TEAM_AGENT_TABS = ['tasks', 'approvals', 'credentials', 'audit'] as const;
export type TeamAgentTab = (typeof TEAM_AGENT_TABS)[number];
const OWNER_TABS: readonly TeamAgentTab[] = ['approvals', 'credentials', 'audit'];

function Breadcrumb() {
  const path = teamAgentPath(null);
  return (
    <nav aria-label="Breadcrumb" className="ws-breadcrumb">
      <a href={path} onClick={(e) => followLink(e, path)}>
        <Icon name="back" /> Team agents
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
          <LoadError
            error={agent.error}
            fallback="Could not load this agent."
            onRetry={agent.reload}
          />
        ) : (
          <Spinner label="Loading the agent" />
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
    tasks: owner ? 'Tasks' : 'Your tasks',
    approvals: 'Approvals',
    credentials: 'Credentials',
    audit: 'Audit',
  };

  return (
    <div className="ws-page team-page">
      <Breadcrumb />
      <header className="ws-page-header">
        <h1>{a.name}</h1>
        <Chip spec={teamAgentChip(a.status)} />
      </header>
      <p className="ws-row-meta muted ws-flush">
        <span className="ws-badge">Team agent</span>
        {autonomy ? <span>{autonomy.label}</span> : null}
        <span>Made {formatWhen(a.createdAt)}</span>
      </p>
      <p className="muted ws-flush">{TEAM_AGENT_IDENTITY_TEXT}</p>
      <GiveTask agent={a} onGiven={() => setTaskVersion((n) => n + 1)} />
      <Tabs
        label="Agent sections"
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
          <h2 id="team-agent-remove">Remove</h2>
          <p className="muted ws-flush">
            Removing it stops its work, removes its credentials from the vault and closes its
            identity. Its audit stays.
          </p>
          <div className="row">
            <Button variant="danger" onClick={() => setRemoving(true)}>
              <Icon name="trash" /> Remove {a.name}
            </Button>
          </div>
        </section>
      ) : null}
      <ConfirmDialog
        open={removing}
        title={`Remove ${a.name}?`}
        description="Its running task stops, its credentials leave the vault and its identity closes. People can no longer give it tasks."
        confirmLabel="Remove"
        danger
        onClose={() => setRemoving(false)}
        onConfirm={async () => {
          await api.removeTeamAgent(agentId);
          setRemoving(false);
          toast.show(`${a.name} was removed.`, { tone: 'success' });
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
      setError(new Error('Write what the agent should do.'));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const t = await api.giveTeamTask(agent.agentId, text.trim());
      setText('');
      setGiven(t);
      onGiven();
      announce(`Task given to ${agent.name}.`);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="ws-section stack" aria-labelledby={`${id}-h`} onSubmit={(e) => void submit(e)}>
      <h2 id={`${id}-h`}>Give it a task</h2>
      <TextAreaField
        label={`Task for ${agent.name}`}
        hint={`It runs as ${agent.name}, not as you; the agent sees that you asked.`}
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
          {busy ? <Spinner /> : <Icon name="send" />} Give the task
        </Button>
      </div>
      {agent.status !== 'active' ? (
        <p className="muted ws-flush">It is {agent.status}, so it does not take tasks now.</p>
      ) : null}
      {given ? (
        <p className="team-notice ws-flush" data-tone="ok" role="status">
          <Icon name="check" /> Task given. It is {taskChip(given.status).text.toLowerCase()}.
        </p>
      ) : null}
      <FormError error={error} fallback="Could not give the task." />
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
      'someone',
    );

  const cancel = async (t: TeamTaskView) => {
    setCancelling(t.id);
    try {
      const out = await api.cancelTeamTask(t.id);
      list.setData((prev) => prev?.map((x) => (x.id === out.id ? out : x)) ?? null);
    } catch (err) {
      toast.show(teamErrorMessage(err, 'Could not cancel the task.'), { tone: 'error' });
    } finally {
      setCancelling(null);
    }
  };

  if (list.error && !list.data)
    return <LoadError error={list.error} fallback="Could not load tasks." onRetry={list.reload} />;
  if (!list.data) return <Spinner label="Loading tasks" />;
  if (list.data.length === 0)
    return (
      <EmptyState
        level={3}
        icon="work"
        title="No tasks yet"
        description={owner ? 'Nobody has given it a task yet.' : 'Tasks you give it appear here.'}
      />
    );
  return (
    <ul className="ws-list" aria-label="Tasks">
      {list.data.map((t) => (
        <li key={t.id} className="ws-card team-task">
          <div className="ws-section-header">
            <span className="ws-row-meta muted">
              <span>Asked by {nameOf(t.requestedBy)}</span>
              <span>{formatWhen(t.createdAt)}</span>
              {t.endedAt ? <span>Ended {formatWhen(t.endedAt)}</span> : null}
            </span>
            <Chip spec={taskChip(t.status)} />
          </div>
          <p className="team-pre ws-flush">{t.text}</p>
          {t.result ? (
            <details>
              <summary>Result</summary>
              <p className="team-pre ws-flush">{t.result}</p>
            </details>
          ) : null}
          {t.error ? <p className="nv-field-error ws-flush">{t.error}</p> : null}
          {t.status === 'queued' || t.status === 'running' ? (
            <div className="row">
              <Button
                variant="ghost"
                disabled={cancelling !== null}
                onClick={() => void cancel(t)}
                aria-label={`Cancel the task: ${t.text.slice(0, 60)}`}
              >
                {cancelling === t.id ? <Spinner /> : <Icon name="stop" />} Cancel
              </Button>
            </div>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

// ---- approvals (owner) -------------------------------------------------------------------------

const DECIDE: {
  kind: 'allow_once' | 'allow_session' | 'deny_continue' | 'deny_stop';
  label: string;
}[] = [
  { kind: 'allow_once', label: 'Allow once' },
  { kind: 'allow_session', label: 'Allow for this session' },
  { kind: 'deny_continue', label: 'Deny and continue' },
  { kind: 'deny_stop', label: 'Deny and stop' },
];

const RISK: Record<string, string> = { low: 'Low', medium: 'Medium', high: 'High' };

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

  const decide = async (a: ApprovalView, kind: (typeof DECIDE)[number]['kind']) => {
    setBusy(a.id);
    setErrors((e) => ({ ...e, [a.id]: null }));
    try {
      await api.decideTeamAgentApproval(agent.agentId, a.id, { decision: kind });
      list.setData((prev) => prev?.filter((x) => x.id !== a.id) ?? null);
      announce(`${DECIDE.find((d) => d.kind === kind)?.label ?? 'Answered'}: ${a.action}.`);
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
        <p className="muted ws-flush team-grow">
          What {agent.name} waits for. You answer for its identity; it does not use your
          permissions.
        </p>
        <Button variant="ghost" onClick={list.reload}>
          <Icon name="refresh" /> Refresh
        </Button>
      </div>
      {list.error ? (
        <LoadError error={list.error} fallback="Could not load approvals." onRetry={list.reload} />
      ) : null}
      {!list.data && !list.error ? <Spinner label="Loading approvals" /> : null}
      {list.data && list.data.length === 0 ? (
        <EmptyState level={3} icon="check" title="Nothing waits for you" />
      ) : null}
      {list.data && list.data.length > 0 ? (
        <ul className="ws-list" aria-label="Approvals">
          {list.data.map((a) => (
            <li key={a.id} className="ws-card team-approval" aria-label={a.action}>
              <div className="ws-section-header">
                <span className="team-strong">{a.action}</span>
                <span className="nv-chip" data-status="needs_input">
                  <Icon name="hand" /> <span>Needs input</span>
                </span>
              </div>
              <dl className="ws-dl">
                <dt>Why</dt>
                <dd>{a.reason}</dd>
                {a.tool ? (
                  <>
                    <dt>Tool</dt>
                    <dd>
                      <code className="ws-code-inline">{a.tool}</code>
                    </dd>
                  </>
                ) : null}
                {a.risk ? (
                  <>
                    <dt>Risk</dt>
                    <dd>{RISK[a.risk] ?? a.risk}</dd>
                  </>
                ) : null}
                <dt>Asked</dt>
                <dd>{formatWhen(a.createdAt)}</dd>
              </dl>
              {a.argsPreview ? <pre className="team-args">{a.argsPreview}</pre> : null}
              <div className="row team-actions">
                {DECIDE.filter((d) => a.options.includes(d.kind)).map((d) => (
                  <Button
                    key={d.kind}
                    variant={d.kind === 'allow_once' ? 'primary' : 'default'}
                    disabled={busy !== null}
                    onClick={() => void decide(a, d.kind)}
                  >
                    {d.label}
                  </Button>
                ))}
              </div>
              <FormError error={errors[a.id]} fallback="Could not answer." />
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

// ---- credentials (owner) -----------------------------------------------------------------------

const KIND_TEXT: Record<TeamAgentCredentialView['kind'], string> = {
  provider: 'Model provider',
  egress: 'Website credential',
};

const SCHEME_TEXT: Record<(typeof EGRESS_CREDENTIAL_SCHEMES)[number], string> = {
  bearer: 'Bearer token',
  basic: 'User name and password',
  header: 'A header of your choice',
};

function Credentials({ agent, onChanged }: { agent: TeamAgentView; onChanged: () => void }) {
  const api = useTeamApi();
  const toast = useToast();
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<TeamAgentCredentialView | null>(null);
  return (
    <div className="stack">
      <p className="muted ws-flush">
        Credentials are bound to {agent.name}’s identity: a model provider account it answers with,
        or a website credential the Hub adds to its requests to those hosts only. Values go to the
        Hub’s vault; only their references are shown.
      </p>
      {agent.credentials.length === 0 ? (
        <p className="ws-flush">No credentials yet: it answers with the offline mock model.</p>
      ) : (
        <ul className="ws-list" aria-label="Credentials">
          {agent.credentials.map((c) => (
            <li key={c.id} className="ws-list-row">
              <span className="team-person-main">
                <span className="team-strong">{c.label}</span>
                <span className="ws-row-meta muted">
                  <span>{KIND_TEXT[c.kind]}</span>
                  {c.secretRef ? (
                    <code className="ws-code-inline team-break">{c.secretRef}</code>
                  ) : (
                    <span>No secret</span>
                  )}
                  <span>Added {formatWhen(c.createdAt)}</span>
                </span>
              </span>
              <Button
                variant="ghost"
                aria-label={`Remove ${c.label}`}
                onClick={() => setRemoving(c)}
              >
                <Icon name="trash" /> Remove
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
            toast.show(`${c.label} saved. Only its reference is kept here.`, { tone: 'success' });
          }}
        />
      ) : (
        <div className="row">
          <Button onClick={() => setAdding(true)}>
            <Icon name="plus" /> Add a credential
          </Button>
        </div>
      )}
      <ConfirmDialog
        open={removing !== null}
        title={`Remove ${removing?.label ?? 'this credential'}?`}
        description={`${agent.name} can no longer use it, and its value leaves the Hub's vault.`}
        confirmLabel="Remove"
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
    if (!label.trim()) problems.label = 'Name the credential.';
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
      if (!list.length) problems.hosts = 'Name at least one host, like api.example.com.';
      const bad = list.map((h) => checkHostPattern(h)).find((x) => x);
      if (bad) problems.hosts = `${bad.charAt(0).toUpperCase()}${bad.slice(1)}.`;
      if (scheme === 'header' && !/^[A-Za-z0-9-]{1,100}$/.test(header))
        problems.header = 'Enter the header name, like X-Api-Key.';
      if (!value) problems.value = 'Enter the secret value.';
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
      aria-label="New credential"
    >
      <RadioGroup
        legend="Kind"
        name="team-credential-kind"
        value={kind}
        onChange={(v) => {
          setKind(v === 'egress' ? 'egress' : 'provider');
          setFields({});
        }}
        options={[
          {
            value: 'provider',
            label: KIND_TEXT.provider,
            description: 'An account at a model provider it answers with.',
          },
          {
            value: 'egress',
            label: KIND_TEXT.egress,
            description: 'A token or password the Hub adds to its requests to these hosts only.',
          },
        ]}
      />
      <TextField
        label="Name"
        value={label}
        maxLength={100}
        onChange={(e) => setLabel(e.target.value)}
        error={fields.label}
      />
      {kind === 'provider' ? (
        <>
          <SelectField
            label="Provider"
            value={provider}
            onChange={(v) => setProvider(v as ProviderKind)}
            options={PROVIDER_KINDS.filter((k) => k !== 'mock').map((k) => ({
              value: k,
              label: PROVIDER_NAMES[k] ?? k,
            }))}
          />
          <TextField
            label="Address (optional)"
            hint="Only for a self-hosted or OpenAI-compatible server."
            value={baseUrl}
            inputMode="url"
            spellCheck={false}
            onChange={(e) => setBaseUrl(e.target.value)}
            error={fields.baseUrl}
          />
          <TextField
            label="API key"
            type="password"
            hint="Write-only: it goes to the vault and is never shown again."
            value={apiKey}
            autoComplete="new-password"
            onChange={(e) => setApiKey(e.target.value)}
          />
        </>
      ) : (
        <>
          <TextAreaField
            label="Hosts"
            hint="One per line, like api.example.com or *.example.com."
            rows={2}
            spellCheck={false}
            value={hosts}
            onChange={setHosts}
            error={fields.hosts}
          />
          <SelectField
            label="How it is sent"
            value={scheme}
            onChange={(v) => setScheme(v as (typeof EGRESS_CREDENTIAL_SCHEMES)[number])}
            options={EGRESS_CREDENTIAL_SCHEMES.map((s) => ({ value: s, label: SCHEME_TEXT[s] }))}
          />
          {scheme === 'header' ? (
            <TextField
              label="Header name"
              value={header}
              onChange={(e) => setHeader(e.target.value)}
              error={fields.header}
            />
          ) : null}
          {scheme === 'basic' ? (
            <TextField
              label="User name"
              value={username}
              autoComplete="off"
              onChange={(e) => setUsername(e.target.value)}
            />
          ) : null}
          <TextField
            label="Secret value"
            type="password"
            hint="Write-only: it goes to the vault and is never shown again."
            value={value}
            autoComplete="new-password"
            onChange={(e) => setValue(e.target.value)}
            error={fields.value}
          />
        </>
      )}
      <div className="row">
        <Button type="submit" variant="primary" disabled={busy}>
          {busy ? <Spinner /> : null} Save credential
        </Button>
        <Button onClick={onCancel}>Cancel</Button>
      </div>
      <FormError error={error} fallback="Could not save the credential." />
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
      <LoadError error={first.error} fallback="Could not load the audit." onRetry={first.reload} />
    );
  if (!first.data) return <Spinner label="Loading the audit" />;
  if (items.length === 0)
    return <EmptyState level={3} icon="activity" title="Nothing recorded yet" />;
  return (
    <div className="stack">
      <p className="muted ws-flush">Everything its identity did, newest first.</p>
      <div className="team-table-wrap">
        <table className="ws-table">
          <thead>
            <tr>
              <th scope="col">When</th>
              <th scope="col">Action</th>
              <th scope="col">On</th>
              <th scope="col">Outcome</th>
            </tr>
          </thead>
          <tbody>
            {items.map((e) => (
              <tr key={e.id}>
                <td>{formatWhen(e.createdAt)}</td>
                <td>
                  <code className="ws-code-inline">{e.action}</code>
                </td>
                <td className="team-break">{e.resource ?? '—'}</td>
                <td>{e.decision ?? e.result ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {cursor ? (
        <div className="row">
          <Button onClick={() => void loadMore()} disabled={more}>
            {more ? <Spinner /> : null} Show older
          </Button>
        </div>
      ) : null}
      <FormError error={error} fallback="Could not load more." />
    </div>
  );
}
