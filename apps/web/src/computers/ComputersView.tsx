// Computers (FR-080, FR-107, FR-195; docs/11 §1-§2, §8): /computers lists the account's computers
// (each agent's own, and connected devices), shows the Hub's sandbox and holds the settings every
// computer shares; /computers/:id is one computer: where its commands run and why they cannot,
// its agent, its resource limits, its snapshots (take, restore, delete) and its network. The
// browser and screen views of a computer (apps/web/src/browser, src/screen) mount in the slots
// `browserPanel` and `screenPanel`.
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import {
  SETTINGS,
  type ComputerSnapshotView,
  type ComputerView,
  type DiagnosticsSnapshot,
  type EgressScopeView,
} from '@nova/shared';
import {
  Button,
  Dialog,
  EmptyState,
  Icon,
  RadioGroup,
  Spinner,
  TextField,
  useToast,
} from '@nova/ui';
import { defineMessages } from '@nova/i18n';
import { ApiError, errorMessage } from '../api.ts';
import { rich } from '../i18n/rich.tsx';
import { navigate } from '../router.ts';
import { useAnnounce, useServices } from '../services.tsx';
import { useSettings } from '../settings.tsx';
import { ManagedNote } from '../managed/ManagedNote.tsx';
import { formatWhen } from '../settings/common.ts';
import { SwitchField } from '../settings/controls.tsx';
import { useDebounced } from '../work/events.ts';
import { followLink } from '../work/nav.tsx';
import { useComputersApi, type AgentRef } from './api.ts';
import { COMPUTER_EVENTS, eventComputerId, useHubEvents } from './events.ts';
import {
  KIND_TEXT,
  NETWORK_PATH,
  agentPath,
  computerPath,
  computerTitle,
  formatBytes,
  formatDateTime,
  formatMemory,
  formatSeconds,
  hubSandboxText,
  stateText,
  substrateText,
} from './format.ts';
import '../workspace.css';
import './computers.css';

export const VIEW_TEXT = defineMessages('computers.view', {
  breadcrumb: 'Breadcrumb',
  computers: 'Computers',
  loadFailed: 'Could not load the computers.',
  intro:
    'Each agent works on a computer of its own. Its files, installed software and browser sign-ins are kept between runs, and it reaches the network only through Nova’s egress proxy.',
  retry: 'Retry',
  loading: 'Loading computers',
  emptyTitle: 'No computers yet',
  emptyHelp:
    'An agent gets its own computer the first time it needs one. Create an agent to get started.',
  goToAgents: 'Go to Agents',
  snapshots: '{n, plural, one {# snapshot} other {# snapshots}}',
  lastUsed: 'Last used {when}',
  sandbox: {
    checkFailed: 'Could not check the sandbox.',
    title: 'Sandbox on this Hub',
    checking: 'Checking the sandbox',
    runsIn: 'Commands run in: {sandbox}',
    cannotRun: 'Commands cannot run on this Hub.',
    never:
      'Nova never runs agent commands outside a sandbox. Agents can still read and write their files.',
  },
  saveFailed: 'Could not save: {error}',
  settings: {
    title: 'Settings for all computers',
    where: "Where a new agent's computer runs",
    localHelp: 'An isolated sandbox on the Hub. Its files stay on the Hub.',
    cloudHelp:
      'Keeps working while your devices are off. In this version a mock cloud runner on the Hub stands in for it.',
    keep: 'Agents that already have a computer keep it.',
    saved: 'Saved.',
    microVm: 'Micro-VM sandboxes (experimental)',
    microVmHelp:
      'Off by default. Used when this Hub runs its sandboxes as micro-VMs, which needs a hypervisor and a KVM runner on the host; without them commands are unavailable, never run outside a sandbox. Takes effect after the Hub restarts.',
    network: 'Where computers can reach on the network: {link}.',
    networkLink: 'Settings, Network',
  },
  limits: {
    fields: {
      cpus: 'CPU cores',
      memoryMb: 'Memory (MB)',
      wallClockSeconds: 'Time per command (seconds)',
    },
    number: 'Enter a number.',
    between: 'Between {min} and {max}.',
    whole: 'Enter a whole number.',
    saved: 'Limits saved.',
    legend: 'Limits for every command',
    restart:
      'CPU and memory apply after the Hub restarts; the time limit applies to the next command.',
    save: 'Save limits',
    discard: 'Discard changes',
  },
  page: {
    loadFailed: 'Could not load this computer.',
    notFound: 'Computer not found',
    notFoundHelp: 'It may have been removed with its agent.',
    all: 'All computers',
    stopped: 'Computer stopped. It starts again the next time it is needed.',
    stopFailed: 'Could not stop it: {error}',
    loading: 'Loading the computer',
    stop: 'Stop',
    facts: {
      kind: 'Kind',
      runsIn: 'Runs commands in',
      agent: 'Agent',
      device: 'Device',
      baseImage: 'Base image',
      created: 'Created',
      lastUsed: 'Last used',
    },
    openAgent: 'Open the agent',
    manageDevice: 'Manage in Settings, Devices',
  },
  resources: {
    title: 'Resource limits',
    cpu: 'CPU',
    cores: '{n, plural, one {# core} other {# cores}}',
    memory: 'Memory',
    time: 'Time per command',
    help: 'Every command on this computer runs within these limits; one that goes over is stopped. They are the same for all computers: {link}.',
    change: 'change them on the Computers page',
  },
  snapshot: {
    title: 'Snapshots',
    take: 'Take a snapshot',
    deviceNote:
      'Snapshots are not available for a connected device: its files are managed on the device.',
    note: 'A snapshot keeps a copy of this computer’s files. Restoring one puts them back as they were.',
    loading: 'Loading snapshots',
    none: 'No snapshots yet. Take one before a change you may want to undo.',
    untitled: 'Snapshot',
    restoreLabel: 'Restore {name} from {when}',
    restore: 'Restore',
    deleteLabel: 'Delete {name} from {when}',
    delete: 'Delete',
    deleteTitle: 'Delete this snapshot?',
    deleteHelp:
      '“{name}” from {when} is deleted. The computer’s files now are not changed. This cannot be undone.',
    cancel: 'Cancel',
    deleted: 'Snapshot deleted.',
    deleteFailed: 'Could not delete it: {error}',
    deleteConfirm: 'Delete snapshot',
    taken: 'Snapshot “{name}” taken.',
    takeFailed: 'Could not take the snapshot.',
    label: 'Label (optional)',
    labelHint: 'For example, “Before the upgrade”.',
    takeConfirm: 'Take snapshot',
    before: 'Before restoring {name}',
    restored: 'Restored the snapshot from {when}.',
    restoreFailed: 'Could not restore the snapshot.',
    restoreTitle: 'Restore this snapshot?',
    restoreHelp:
      'The computer’s files go back to how they were in “{name}” ({when}). Changes made since then are lost, and browser and screen sessions on this computer stop.',
    keep: 'Take a snapshot of the current files first',
  },
  network: {
    title: 'Network',
    device:
      'Commands on a connected device reach the network through the device’s own egress proxy.',
    proxy: 'This computer reaches the network only through Nova’s egress proxy.',
    noRule: 'There is no rule for {who}, so the rules for every sandbox apply.',
    noRuleAgent: 'There is no rule for its agent, so the rules for every sandbox apply.',
    rule: '{who} has its own rule: {mode, select, off {off} allowlist {allowed hosts only} limited {read-only} other {the same access as every sandbox}}{allow, plural, =0 {} one {, # more allowed host} other {, # more allowed hosts}}{deny, plural, =0 {} one {, # blocked host} other {, # blocked hosts}}.',
    ruleAgent:
      'Its agent has its own rule: {mode, select, off {off} allowlist {allowed hosts only} limited {read-only} other {the same access as every sandbox}}{allow, plural, =0 {} one {, # more allowed host} other {, # more allowed hosts}}{deny, plural, =0 {} one {, # blocked host} other {, # blocked hosts}}.',
    link: 'Network settings and the decision log',
  },
});
const S = VIEW_TEXT;

/** Where the browser and screen views of a computer mount (render props, given the computer). */
export interface ComputerPanels {
  browserPanel?: (computer: ComputerView) => ReactNode;
  screenPanel?: (computer: ComputerView) => ReactNode;
}

export function ComputersView({
  computerId,
  ...panels
}: { computerId: string | null } & ComputerPanels) {
  if (computerId) return <ComputerPage key={computerId} computerId={computerId} {...panels} />;
  return <ComputerList />;
}

function Breadcrumb() {
  return (
    <nav aria-label={S.breadcrumb} className="ws-breadcrumb">
      <a href={computerPath()} onClick={(e) => followLink(e, computerPath())}>
        <Icon name="back" /> {S.computers}
      </a>
    </nav>
  );
}

/** Agents by id, to name each computer's owner; empty until loaded (or if it cannot load). */
function useAgentNames(): Map<string, string> {
  const api = useComputersApi();
  const [names, setNames] = useState<Map<string, string>>(new Map());
  useEffect(() => {
    let alive = true;
    api.listComputerAgents().then(
      ({ items }: { items: AgentRef[] }) => {
        if (alive) setNames(new Map(items.map((a) => [a.id, a.name])));
      },
      () => undefined,
    );
    return () => {
      alive = false;
    };
  }, [api]);
  return names;
}

export function StateBadge({ state }: { state: ComputerView['state'] }) {
  const s = stateText(state);
  return (
    <span className="ws-badge computers-state" data-tone={s.tone ?? undefined}>
      <Icon name={s.icon} /> {s.label}
    </span>
  );
}

/** Why a computer cannot do everything now, in the Hub's words (degraded, error, offline). */
function StatusDetail({ computer: c }: { computer: ComputerView }) {
  if (!c.detail) return null;
  if (c.state === 'degraded' || c.state === 'error')
    return (
      <div className="ws-callout computers-detail" role="note">
        <Icon name="alert" />
        <p dir="auto">{c.detail}</p>
      </div>
    );
  return (
    <p className="muted ws-flush computers-detail" dir="auto">
      {c.detail}
    </p>
  );
}

// ---- the list --------------------------------------------------------------------------------

export function ComputerList() {
  const api = useComputersApi();
  const names = useAgentNames();
  const [items, setItems] = useState<ComputerView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let alive = true;
    api.listComputers().then(
      ({ items: list }) => {
        if (!alive) return;
        setItems(list);
        setError(null);
      },
      (err: unknown) => alive && setError(errorMessage(err, S.loadFailed)),
    );
    return () => {
      alive = false;
    };
  }, [api, attempt]);

  const reload = useDebounced(() => setAttempt((n) => n + 1), 150);
  useHubEvents(COMPUTER_EVENTS, () => reload());

  return (
    <div className="ws-page computers-page">
      <header className="ws-page-header">
        <h1>{S.computers}</h1>
      </header>
      <p className="muted ws-flush">{S.intro}</p>
      <HubSandbox />
      {error ? (
        <div role="alert" className="ws-error">
          <p>{error}</p>
          <Button onClick={() => setAttempt((n) => n + 1)}>{S.retry}</Button>
        </div>
      ) : null}
      {items === null && !error ? <Spinner label={S.loading} /> : null}
      {items?.length === 0 ? (
        <EmptyState
          title={S.emptyTitle}
          description={S.emptyHelp}
          icon="agents"
          level={2}
          action={<Button onClick={() => navigate('/agents')}>{S.goToAgents}</Button>}
        />
      ) : null}
      {items?.length ? (
        <ul className="ws-list" aria-label={S.computers}>
          {items.map((c) => {
            const owner = c.agentId ? (names.get(c.agentId) ?? null) : null;
            return (
              <li key={c.id} className="ws-list-row">
                <div className="computers-row-main">
                  <a
                    href={computerPath(c.id)}
                    className="ws-card-link"
                    onClick={(e) => followLink(e, computerPath(c.id))}
                  >
                    {computerTitle(c, owner)}
                  </a>
                  <span className="muted ws-row-meta">
                    <span>{KIND_TEXT[c.kind].label}</span>
                    <span>{substrateText(c.substrate)}</span>
                    <span>{S.snapshots({ n: c.snapshotCount })}</span>
                    <span>{S.lastUsed({ when: formatWhen(c.lastUsedAt) })}</span>
                  </span>
                  {c.detail &&
                  (c.state === 'degraded' || c.state === 'error' || c.kind === 'local_host') ? (
                    <p className="computers-row-detail" dir="auto">
                      {c.detail}
                    </p>
                  ) : null}
                </div>
                <StateBadge state={c.state} />
              </li>
            );
          })}
        </ul>
      ) : null}
      <ComputerSettings />
    </div>
  );
}

/** The Hub's sandbox (FR-107, FR-195): where commands run, or why they cannot. */
function HubSandbox() {
  const { api } = useServices();
  const [snap, setSnap] = useState<DiagnosticsSnapshot['sandbox'] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let alive = true;
    api.diagnostics().then(
      (d) => {
        if (!alive) return;
        setSnap(d.sandbox);
        setError(null);
      },
      (err: unknown) => alive && setError(errorMessage(err, S.sandbox.checkFailed)),
    );
    return () => {
      alive = false;
    };
  }, [api, attempt]);

  return (
    <section className="computers-sandbox ws-card" aria-labelledby="hub-sandbox">
      <h2 id="hub-sandbox" className="ws-subhead">
        {S.sandbox.title}
      </h2>
      {error ? (
        <div className="computers-inline-error" role="alert">
          <span>{error}</span>
          <Button variant="ghost" onClick={() => setAttempt((n) => n + 1)}>
            {S.retry}
          </Button>
        </div>
      ) : snap === null ? (
        <Spinner label={S.sandbox.checking} />
      ) : snap.available ? (
        <>
          <p className="ws-ok ws-flush">
            <Icon name="check" /> {S.sandbox.runsIn({ sandbox: hubSandboxText(snap.substrate) })}
          </p>
          {snap.detail ? (
            <p className="muted ws-flush" dir="auto">
              {snap.detail}
            </p>
          ) : null}
        </>
      ) : (
        <>
          <p className="ws-warning">
            <Icon name="alert" /> {S.sandbox.cannotRun}
          </p>
          <p className="ws-flush" dir="auto">
            {snap.detail}
          </p>
          <p className="muted ws-flush">{S.sandbox.never}</p>
        </>
      )}
    </section>
  );
}

// ---- settings every computer shares (computers.*) --------------------------------------------

const LIMIT_FIELDS = [
  { key: 'cpus', min: 0.25, max: 64, step: 0.25 },
  { key: 'memoryMb', min: 256, max: 262_144, step: 256 },
  { key: 'wallClockSeconds', min: 10, max: 86_400, step: 1 },
] as const;
type LimitKey = (typeof LIMIT_FIELDS)[number]['key'];
type Limits = Record<LimitKey, number>;

function ComputerSettings() {
  const settings = useSettings();
  const toast = useToast();
  const announce = useAnnounce();
  const place = settings.get('computers.agentComputer');
  const microVm = settings.get('computers.microVm');
  const fail = (err: unknown) =>
    toast.show(S.saveFailed({ error: errorMessage(err) }), { tone: 'error' });

  return (
    <section className="ws-section" aria-labelledby="computers-settings">
      <h2 id="computers-settings">{S.settings.title}</h2>
      <RadioGroup
        legend={S.settings.where}
        name="computers-agent-computer"
        value={place.value}
        locked={place.locked}
        options={[
          {
            value: 'local_container',
            label: KIND_TEXT.local_container.label,
            description: S.settings.localHelp,
          },
          {
            value: 'cloud',
            label: KIND_TEXT.cloud.label,
            description: S.settings.cloudHelp,
          },
        ]}
        hint={S.settings.keep}
        onChange={(v) => {
          const next = v === 'cloud' ? 'cloud' : 'local_container';
          settings.set('computers.agentComputer', next).then(
            () => announce(S.settings.saved),
            (err: unknown) => fail(err),
          );
        }}
      />
      <LimitsForm />
      <SwitchField
        label={S.settings.microVm}
        description={S.settings.microVmHelp}
        checked={microVm.value.enabled}
        locked={microVm.locked}
        onChange={(on) =>
          void settings
            .set('computers.microVm', { ...microVm.value, enabled: on })
            .catch((err: unknown) => fail(err))
        }
      />
      <p className="ws-flush">
        {rich(S.settings.network, {
          link: (
            <a href={NETWORK_PATH} onClick={(e) => followLink(e, NETWORK_PATH)}>
              {S.settings.networkLink}
            </a>
          ),
        })}
      </p>
    </section>
  );
}

function LimitsForm() {
  const settings = useSettings();
  const toast = useToast();
  const limits = settings.get('computers.limits');
  const id = useId();
  const [draft, setDraft] = useState<Record<LimitKey, string> | null>(null);
  const [busy, setBusy] = useState(false);
  const shown = draft ?? {
    cpus: String(limits.value.cpus),
    memoryMb: String(limits.value.memoryMb),
    wallClockSeconds: String(limits.value.wallClockSeconds),
  };
  const errors: Partial<Record<LimitKey, string>> = {};
  for (const f of LIMIT_FIELDS) {
    const raw = shown[f.key].trim();
    const n = Number(raw);
    if (!raw || !Number.isFinite(n)) errors[f.key] = S.limits.number;
    else if (n < f.min || n > f.max) errors[f.key] = S.limits.between({ min: f.min, max: f.max });
    else if (f.key !== 'cpus' && !Number.isInteger(n)) errors[f.key] = S.limits.whole;
  }
  const valid = Object.keys(errors).length === 0;
  const dirty = draft !== null;

  const save = async () => {
    if (!valid || !dirty || busy) return;
    const next: Limits = {
      cpus: Number(shown.cpus),
      memoryMb: Number(shown.memoryMb),
      wallClockSeconds: Number(shown.wallClockSeconds),
    };
    if (!SETTINGS['computers.limits'].schema.safeParse(next).success) return;
    setBusy(true);
    try {
      await settings.set('computers.limits', next);
      setDraft(null);
      toast.show(S.limits.saved, { tone: 'success' });
    } catch (err) {
      toast.show(S.saveFailed({ error: errorMessage(err) }), { tone: 'error' });
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      className="ws-fieldset computers-limits"
      aria-labelledby={`${id}-legend`}
      aria-describedby={limits.locked ? `${id}-lock` : undefined}
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <span id={`${id}-legend`} className="nv-field-label">
        {S.limits.legend}
      </span>
      {limits.locked ? <ManagedNote id={`${id}-lock`} setting="computers.limits" /> : null}
      <div className="ws-preset-grid">
        {LIMIT_FIELDS.map((f) => (
          <TextField
            key={f.key}
            label={S.limits.fields[f.key]}
            type="number"
            inputMode="decimal"
            min={f.min}
            max={f.max}
            step={f.step}
            value={shown[f.key]}
            disabled={limits.locked}
            error={dirty ? errors[f.key] : undefined}
            onChange={(e) => setDraft({ ...shown, [f.key]: e.target.value })}
          />
        ))}
      </div>
      <p className="nv-field-hint ws-flush">{S.limits.restart}</p>
      <div className="ws-toolbar">
        <Button
          type="submit"
          variant="primary"
          disabled={!dirty || !valid || busy || limits.locked}
        >
          {busy ? <Spinner /> : null} {S.limits.save}
        </Button>
        {dirty ? (
          <Button variant="ghost" onClick={() => setDraft(null)}>
            {S.limits.discard}
          </Button>
        ) : null}
      </div>
    </form>
  );
}

// ---- one computer ----------------------------------------------------------------------------

export function ComputerPage({
  computerId,
  browserPanel,
  screenPanel,
}: { computerId: string } & ComputerPanels) {
  const api = useComputersApi();
  const toast = useToast();
  const names = useAgentNames();
  const limits = useSettings().get('computers.limits').value;
  const [computer, setComputer] = useState<ComputerView | null>(null);
  const [snapshots, setSnapshots] = useState<ComputerSnapshotView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [gone, setGone] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [dialog, setDialog] = useState<
    | { kind: 'snapshot' }
    | { kind: 'restore'; snap: ComputerSnapshotView }
    | { kind: 'delete'; snap: ComputerSnapshotView }
    | null
  >(null);
  const [stopping, setStopping] = useState(false);

  useEffect(() => {
    let alive = true;
    Promise.all([api.getComputer(computerId), api.listComputerSnapshots(computerId)]).then(
      ([c, s]) => {
        if (!alive) return;
        setComputer(c);
        setSnapshots(s.items);
        setError(null);
      },
      (err: unknown) => {
        if (!alive) return;
        if (err instanceof ApiError && err.status === 404) setGone(true);
        else setError(errorMessage(err, S.page.loadFailed));
      },
    );
    return () => {
      alive = false;
    };
  }, [api, computerId, attempt]);

  const reload = useDebounced(() => setAttempt((n) => n + 1), 150);
  useHubEvents(COMPUTER_EVENTS, (env) => {
    if (eventComputerId(env) === computerId) reload();
  });

  if (gone)
    return (
      <div className="ws-page computers-page">
        <Breadcrumb />
        <EmptyState
          title={S.page.notFound}
          description={S.page.notFoundHelp}
          level={2}
          action={<Button onClick={() => navigate(computerPath())}>{S.page.all}</Button>}
        />
      </div>
    );

  const c = computer;
  const owner = c?.agentId ? (names.get(c.agentId) ?? null) : null;
  const device = c?.kind === 'local_host';
  const canStop = c ? c.state === 'running' || c.state === 'starting' : false;

  const stop = () => {
    if (!c || stopping) return;
    setStopping(true);
    api
      .stopComputer(c.id)
      .then(
        (v) => {
          setComputer(v);
          toast.show(S.page.stopped);
        },
        (err: unknown) =>
          toast.show(S.page.stopFailed({ error: errorMessage(err) }), { tone: 'error' }),
      )
      .finally(() => setStopping(false));
  };

  return (
    <div className="ws-page computers-page">
      <Breadcrumb />
      {error ? (
        <div role="alert" className="ws-error">
          <p>{error}</p>
          <Button onClick={() => setAttempt((n) => n + 1)}>{S.retry}</Button>
        </div>
      ) : null}
      {!c && !error ? <Spinner label={S.page.loading} /> : null}
      {c ? (
        <>
          <header className="ws-page-header">
            <h1>{computerTitle(c, owner)}</h1>
            <div className="computers-actions">
              <StateBadge state={c.state} />
              {canStop ? (
                <Button disabled={stopping} onClick={stop}>
                  {stopping ? <Spinner /> : <Icon name="stop" />} {S.page.stop}
                </Button>
              ) : null}
            </div>
          </header>
          <StatusDetail computer={c} />
          <dl className="ws-dl computers-facts">
            <dt>{S.page.facts.kind}</dt>
            <dd>
              {KIND_TEXT[c.kind].label}
              <span className="muted"> · {KIND_TEXT[c.kind].description}</span>
            </dd>
            <dt>{S.page.facts.runsIn}</dt>
            <dd>{substrateText(c.substrate)}</dd>
            {c.agentId ? (
              <>
                <dt>{S.page.facts.agent}</dt>
                <dd>
                  <a
                    href={agentPath(c.agentId)}
                    onClick={(e) => followLink(e, agentPath(c.agentId ?? ''))}
                  >
                    {owner ?? S.page.openAgent}
                  </a>
                </dd>
              </>
            ) : null}
            {c.deviceId ? (
              <>
                <dt>{S.page.facts.device}</dt>
                <dd>
                  <a href="/settings/devices" onClick={(e) => followLink(e, '/settings/devices')}>
                    {S.page.manageDevice}
                  </a>
                </dd>
              </>
            ) : null}
            {c.baseImage ? (
              <>
                <dt>{S.page.facts.baseImage}</dt>
                <dd>
                  <code className="ws-code-inline">{c.baseImage}</code>
                </dd>
              </>
            ) : null}
            <dt>{S.page.facts.created}</dt>
            <dd>{formatDateTime(c.createdAt)}</dd>
            <dt>{S.page.facts.lastUsed}</dt>
            <dd>{formatWhen(c.lastUsedAt)}</dd>
          </dl>

          {browserPanel ? <div className="computers-slot">{browserPanel(c)}</div> : null}
          {screenPanel ? <div className="computers-slot">{screenPanel(c)}</div> : null}

          {device ? null : (
            <section className="ws-section" aria-labelledby="computer-limits">
              <h2 id="computer-limits">{S.resources.title}</h2>
              <dl className="ws-stats">
                <div>
                  <dt>{S.resources.cpu}</dt>
                  <dd>{S.resources.cores({ n: limits.cpus })}</dd>
                </div>
                <div>
                  <dt>{S.resources.memory}</dt>
                  <dd>{formatMemory(limits.memoryMb)}</dd>
                </div>
                <div>
                  <dt>{S.resources.time}</dt>
                  <dd>{formatSeconds(limits.wallClockSeconds)}</dd>
                </div>
              </dl>
              <p className="muted ws-flush">
                {rich(S.resources.help, {
                  link: (
                    <a href={computerPath()} onClick={(e) => followLink(e, computerPath())}>
                      {S.resources.change}
                    </a>
                  ),
                })}
              </p>
            </section>
          )}

          <Snapshots
            computer={c}
            snapshots={snapshots}
            onCreate={() => setDialog({ kind: 'snapshot' })}
            onRestore={(snap) => setDialog({ kind: 'restore', snap })}
            onDelete={(snap) => setDialog({ kind: 'delete', snap })}
          />

          <ComputerNetwork computer={c} owner={owner} />

          {dialog?.kind === 'snapshot' ? (
            <SnapshotDialog
              computerId={c.id}
              onClose={() => setDialog(null)}
              onDone={() => {
                setDialog(null);
                reload();
              }}
            />
          ) : null}
          {dialog?.kind === 'restore' ? (
            <RestoreDialog
              computerId={c.id}
              snap={dialog.snap}
              onClose={() => setDialog(null)}
              onDone={(v) => {
                setDialog(null);
                setComputer(v);
                reload();
              }}
            />
          ) : null}
          <Dialog
            open={dialog?.kind === 'delete'}
            title={S.snapshot.deleteTitle}
            description={
              dialog?.kind === 'delete'
                ? S.snapshot.deleteHelp({
                    name: snapshotName(dialog.snap),
                    when: formatDateTime(dialog.snap.createdAt),
                  })
                : undefined
            }
            onClose={() => setDialog(null)}
            footer={
              <>
                <Button onClick={() => setDialog(null)}>{S.snapshot.cancel}</Button>
                <Button
                  variant="danger"
                  onClick={() => {
                    if (dialog?.kind !== 'delete') return;
                    const snap = dialog.snap;
                    setDialog(null);
                    api.deleteComputerSnapshot(c.id, snap.id).then(
                      () => {
                        toast.show(S.snapshot.deleted, { tone: 'success' });
                        reload();
                      },
                      (err: unknown) =>
                        toast.show(S.snapshot.deleteFailed({ error: errorMessage(err) }), {
                          tone: 'error',
                        }),
                    );
                  }}
                >
                  {S.snapshot.deleteConfirm}
                </Button>
              </>
            }
          />
        </>
      ) : null}
    </div>
  );
}

function snapshotName(s: ComputerSnapshotView): string {
  return s.label?.trim() || S.snapshot.untitled;
}

function Snapshots({
  computer: c,
  snapshots,
  onCreate,
  onRestore,
  onDelete,
}: {
  computer: ComputerView;
  snapshots: ComputerSnapshotView[] | null;
  onCreate: () => void;
  onRestore: (s: ComputerSnapshotView) => void;
  onDelete: (s: ComputerSnapshotView) => void;
}) {
  const device = c.kind === 'local_host';
  return (
    <section className="ws-section" aria-labelledby="computer-snapshots">
      <div className="ws-section-header">
        <h2 id="computer-snapshots">{S.snapshot.title}</h2>
        {device ? null : (
          <Button onClick={onCreate}>
            <Icon name="save" /> {S.snapshot.take}
          </Button>
        )}
      </div>
      {device ? (
        <p className="muted ws-flush">{S.snapshot.deviceNote}</p>
      ) : (
        <p className="muted ws-flush">{S.snapshot.note}</p>
      )}
      {snapshots === null ? <Spinner label={S.snapshot.loading} /> : null}
      {snapshots?.length === 0 && !device ? <p className="ws-flush">{S.snapshot.none}</p> : null}
      {snapshots?.length ? (
        <ul className="ws-list" aria-label={S.snapshot.title}>
          {snapshots.map((s) => (
            <li key={s.id} className="ws-list-row">
              <div className="computers-row-main">
                <span className="ws-card-link" dir="auto">
                  {snapshotName(s)}
                </span>
                <span className="muted ws-row-meta">
                  <span>{formatDateTime(s.createdAt)}</span>
                  <span>{formatBytes(s.sizeBytes)}</span>
                </span>
              </div>
              <span className="computers-actions">
                {device ? null : (
                  <Button
                    aria-label={S.snapshot.restoreLabel({
                      name: snapshotName(s),
                      when: formatDateTime(s.createdAt),
                    })}
                    onClick={() => onRestore(s)}
                  >
                    <Icon name="undo" /> {S.snapshot.restore}
                  </Button>
                )}
                <Button
                  variant="ghost"
                  aria-label={S.snapshot.deleteLabel({
                    name: snapshotName(s),
                    when: formatDateTime(s.createdAt),
                  })}
                  onClick={() => onDelete(s)}
                >
                  <Icon name="trash" /> {S.snapshot.delete}
                </Button>
              </span>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

function SnapshotDialog({
  computerId,
  onClose,
  onDone,
}: {
  computerId: string;
  onClose: () => void;
  onDone: () => void;
}) {
  const api = useComputersApi();
  const toast = useToast();
  const ref = useRef<HTMLInputElement>(null);
  const [label, setLabel] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const s = await api.createComputerSnapshot(
        computerId,
        label.trim() ? { label: label.trim() } : {},
      );
      toast.show(S.snapshot.taken({ name: snapshotName(s) }), { tone: 'success' });
      onDone();
    } catch (err) {
      setError(errorMessage(err, S.snapshot.takeFailed));
      setBusy(false);
    }
  };
  return (
    <Dialog open title={S.snapshot.take} onClose={onClose} initialFocusRef={ref}>
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <TextField
          ref={ref}
          label={S.snapshot.label}
          value={label}
          maxLength={200}
          hint={S.snapshot.labelHint}
          onChange={(e) => setLabel(e.target.value)}
        />
        {error ? (
          <p className="nv-field-error" role="alert">
            {error}
          </p>
        ) : null}
        <div className="nv-dialog-footer">
          <Button onClick={onClose}>{S.snapshot.cancel}</Button>
          <Button type="submit" variant="primary" disabled={busy}>
            {busy ? <Spinner /> : null} {S.snapshot.takeConfirm}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

function RestoreDialog({
  computerId,
  snap,
  onClose,
  onDone,
}: {
  computerId: string;
  snap: ComputerSnapshotView;
  onClose: () => void;
  onDone: (c: ComputerView) => void;
}) {
  const api = useComputersApi();
  const toast = useToast();
  const id = useId();
  const [keep, setKeep] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const when = formatDateTime(snap.createdAt);
  const submit = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      if (keep)
        await api.createComputerSnapshot(computerId, {
          label: S.snapshot.before({ name: snapshotName(snap) }).slice(0, 200),
        });
      const v = await api.restoreComputer(computerId, snap.id);
      toast.show(S.snapshot.restored({ when }), { tone: 'success' });
      onDone(v);
    } catch (err) {
      setError(errorMessage(err, S.snapshot.restoreFailed));
      setBusy(false);
    }
  };
  return (
    <Dialog
      open
      title={S.snapshot.restoreTitle}
      description={S.snapshot.restoreHelp({ name: snapshotName(snap), when })}
      onClose={onClose}
    >
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <label className="ws-check" htmlFor={`${id}-keep`}>
          <input
            id={`${id}-keep`}
            type="checkbox"
            checked={keep}
            onChange={(e) => setKeep(e.target.checked)}
          />
          {S.snapshot.keep}
        </label>
        {error ? (
          <p className="nv-field-error" role="alert">
            {error}
          </p>
        ) : null}
        <div className="nv-dialog-footer">
          <Button onClick={onClose}>{S.snapshot.cancel}</Button>
          <Button type="submit" variant="danger" disabled={busy}>
            {busy ? <Spinner /> : null} {S.snapshot.restore}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

/** How this computer reaches the network: the egress proxy, under its agent's rule if any. */
function ComputerNetwork({ computer: c, owner }: { computer: ComputerView; owner: string | null }) {
  const api = useComputersApi();
  const [rule, setRule] = useState<EgressScopeView | null | undefined>(undefined);
  const agentId = c.agentId;
  useEffect(() => {
    if (!agentId) return;
    let alive = true;
    api.getEgress().then(
      (v) => {
        if (alive) setRule(v.scopes.find((s) => s.kind === 'agent' && s.id === agentId) ?? null);
      },
      () => undefined,
    );
    return () => {
      alive = false;
    };
  }, [api, agentId]);

  const N = S.network;
  let summary: string | null = null;
  if (rule === null) summary = owner ? N.noRule({ who: owner }) : N.noRuleAgent;
  else if (rule) {
    const params = {
      mode: rule.mode ?? 'same',
      allow: rule.allow.length,
      deny: rule.deny.length,
    };
    summary = owner ? N.rule({ who: owner, ...params }) : N.ruleAgent(params);
  }

  return (
    <section className="ws-section" aria-labelledby="computer-network">
      <h2 id="computer-network">{N.title}</h2>
      <p className="ws-flush">
        {c.kind === 'local_host' ? N.device : N.proxy}
        {summary ? ` ${summary}` : ''}
      </p>
      <p className="ws-flush">
        <a href={NETWORK_PATH} onClick={(e) => followLink(e, NETWORK_PATH)}>
          {N.link}
        </a>
      </p>
    </section>
  );
}
