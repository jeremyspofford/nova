// Settings → Cloud runner (FR-108, FR-071, FR-116; docs/13 §3, docs/10 §12) at /settings/cloud: the
// runner this Hub sends cloud environments' commands to (its address, a write-only token kept in
// the vault, on or off, a test, forget), the caps every run and environment gets, the cloud
// environments (new, open) and the runs with their usage. An environment opens at ?env=<id> and a
// run at ?run=<id>, as full pages with a way back. The agent loop, the models and approvals stay
// on this Hub; the runner only holds the environments and runs their commands.
import { useId, useState } from 'react';
import { defineMessages, fmt } from '@nova/i18n';
import {
  RUNNER_HOSTED_URL,
  isRunnerUrl,
  runnerTokenSchema,
  type CloudEnvironmentView,
  type CloudRunnerTestView,
  type CloudRunnerView,
} from '@nova/shared';
import { Button, EmptyState, Icon, Spinner, TextField, useToast } from '@nova/ui';
import { navigate, useLocation } from '../router.ts';
import { useAnnounce } from '../services.tsx';
import { formatWhen } from '../settings/common.ts';
import { SwitchField } from '../settings/controls.tsx';
import { useSettings } from '../settings.tsx';
import { useCloudApi } from './api.ts';
import { CloudEnvironmentDialog } from './CloudEnvironmentDialog.tsx';
import { CloudEnvironmentPage } from './CloudEnvironmentPage.tsx';
import { CloudRunPage } from './CloudRunPage.tsx';
import { CloudRunsList } from './CloudRunsList.tsx';
import { ENVIRONMENT_EVENTS, RUNNER_EVENTS, useCloudEvents } from './events.ts';
import {
  CAP_TEXT,
  CLOUD_TEXT,
  NETWORK_TEXT,
  capitalize,
  cloudEnvPath,
  cloudErrorMessage,
  environmentState,
  formatBytes,
  repoName,
  runnerStateSpec,
  runnerUsable,
} from './format.ts';
import { ConfirmAction, Fact, InAppLink, StateBadge, useLoad } from './parts.tsx';
import '../workspace.css';

/** Settings → Cloud runner. */
export const CLOUD_SETTINGS_TEXT = defineMessages('cloud.settings', {
  intro:
    'Cloud environments keep their repositories, setup and caches on a runner, and their commands run there, so Code sessions and Work runs keep going while your devices are off. The agent, the models and your approvals stay on this Hub.',
  runs: 'Runs',
  runsEmpty: 'A run starts when a Code session or Work run uses a cloud environment.',
  loadFailed: 'Could not load the cloud runner.',
  loading: 'Loading the cloud runner',
  runner: {
    heading: 'Runner',
    test: 'Test',
    answers: 'The runner answers.',
    testNotPassed: 'The runner test did not pass.',
    testFailed: 'Could not test the runner.',
    isOff: 'The cloud runner is off.',
    isOn: 'The cloud runner is on.',
    turnOffFailed: 'Could not turn the runner off.',
    turnOnFailed: 'Could not turn the runner on.',
    state: 'State',
    address: 'Address',
    token: 'Token',
    tokenSet: 'Set',
    tokenNotSet: 'Not set',
    version: 'Version',
    sandbox: 'Sandbox',
    /** {kind} is the sandbox's kind as the runner names it. */
    sandboxUnusable: '{kind} (not usable)',
    checked: 'Checked',
    use: 'Use the cloud runner',
    useHint: 'Cloud environments run their commands on this runner. Turning it on tests it first.',
    useFirst: 'Enter the runner’s address and token below first.',
    /** {detail} is the runner's own words (English); {ms} its answer time in milliseconds. */
    answeredIn: 'The runner answers in {ms} ms: {detail}.',
    answered: 'The runner answers: {detail}.',
    notPassed: 'The runner test did not pass: {detail}.',
    turnOnTitle: 'Turn on the cloud runner?',
    /** {url} is the runner's address. */
    turnOnBody:
      'The commands and files of cloud environments go to {url}, with the token on every request. Runs there keep going while your devices are off.',
    turnOn: 'Turn on',
  },
  form: {
    heading: 'Address and token',
    urlRequired: 'Enter the runner’s address, or use the hosted runner.',
    urlInvalid:
      'Enter an https:// address (http:// only for a runner on this computer), without a user name or password.',
    tokenRequired: 'Enter the token the runner gave you (nvrun_…).',
    tokenInvalid: 'That is not a runner token. It starts with nvrun_ and has 43 more characters.',
    saved: 'Runner saved.',
    /** Said to screen readers: "Runner saved. Ready." */
    savedState: 'Runner saved. {state}.',
    saveFailed: 'Could not save the runner.',
    address: 'Runner address',
    addressHint: 'Your own runner (nova-runner), or the hosted one.',
    useHosted: 'Use the hosted runner',
    token: 'Runner token',
    replaceToken: 'Replace the token',
    tokenKeep:
      'A token is set. Leave this empty to keep it. It is kept in the vault and never shown.',
    tokenHint: 'From `nova-runner token add`. It is kept in the vault and never shown again.',
    save: 'Save',
    forget: 'Forget this runner…',
    forgetTitle: 'Forget this runner?',
    forgetBody:
      'Its token leaves the vault and cloud environments stop running until a runner is set up again. The environments stay saved, and their files stay on the runner.',
    forgetConfirm: 'Forget runner',
    forgetFailed: 'Could not forget the runner.',
    forgotten: 'The runner is forgotten.',
  },
  caps: {
    heading: 'Caps',
    intro:
      'Every run stops at its caps and waits for you to raise them; a warning comes first. Each environment may use at most the disk cap.',
    disk: 'Set the disk cap in whole MB, from {min} to {max}.',
    warn: 'Warn at a share from {min} to {max} percent.',
    saved: 'Caps saved. New runs get them.',
    saveFailed: 'Could not save the caps.',
    cpuPerRun: 'CPU time per run (minutes)',
    wallPerRun: 'Running time per run (minutes)',
    diskPerEnv: 'Disk per environment (MB)',
    warnAt: 'Warn at (percent of a cap)',
    managed: 'Your organization manages these caps.',
    save: 'Save caps',
  },
  network: {
    heading: 'Network',
    label: 'Unrestricted network',
    description:
      "Let cloud environments reach the network directly from the runner, without the Hub's egress proxy: no allowlist, no blocking of private or local addresses, no egress audit. Off, cloud commands never get network and cloud environments can only be made with network off.",
    /** A toast: "Could not save: <why>". */
    saveFailedBecause: 'Could not save: {reason}',
    saveFailed: 'Could not save.',
    warning:
      'Cloud environments made with network can reach any address from the runner, including private ones, and nothing of it is in the Hub’s egress log.',
    askTitle: 'Allow unrestricted network?',
    askBody:
      'Cloud environments with network then reach the internet straight from the runner. The Hub’s allowlist, its blocking of private and local addresses, and its egress audit do not apply to that traffic.',
    allow: 'Allow',
  },
  environments: {
    heading: 'Cloud environments',
    runnerFirst: 'Set up and turn on the runner first.',
    create: 'New cloud environment',
    loadFailed: 'Could not load the cloud environments.',
    loading: 'Loading the cloud environments',
    empty: 'No cloud environments yet',
    emptyHint:
      'Add one with your repositories and a setup script. Pick it when you start a Code session or a Work run.',
    noRepos: 'No repositories',
    running: '{n, plural, one {# running} other {# running}}',
    /** {name} is the environment's name. */
    openOne: 'Open {name}',
    open: 'Open',
  },
});

/** The `?env=` or `?run=` sub-page the location names. */
export function cloudSubPage(location: string): { env: string | null; run: string | null } {
  const q = location.indexOf('?');
  const params = new URLSearchParams(q < 0 ? '' : location.slice(q));
  return { env: params.get('env'), run: params.get('run') };
}

export function CloudSettings() {
  const location = useLocation();
  const sub = cloudSubPage(location);
  return (
    <div className="settings-page cl-settings">
      {sub.env ? (
        <CloudEnvironmentPage key={sub.env} id={sub.env} />
      ) : sub.run ? (
        <CloudRunPage key={sub.run} id={sub.run} />
      ) : (
        <CloudOverview />
      )}
    </div>
  );
}

function CloudOverview() {
  const api = useCloudApi();
  const runner = useLoad(() => api.getCloudRunner(), 'runner');
  const envs = useLoad(() => api.listCloudEnvironments().then((r) => r.items), 'cloud-envs');
  useCloudEvents(RUNNER_EVENTS, runner.reload, runner.reload);
  useCloudEvents(ENVIRONMENT_EVENTS, envs.reload, envs.reload);
  const r = runner.data;
  const S = CLOUD_SETTINGS_TEXT;
  return (
    <>
      <h2>{CLOUD_TEXT.cloudRunner}</h2>
      <p className="muted">{S.intro}</p>
      {r ? (
        <>
          <RunnerStatus r={r} onChanged={(next) => runner.setData(() => next)} />
          <RunnerForm r={r} onSaved={(next) => runner.setData(() => next)} />
          <CapsSection />
          <NetworkSection />
          <Environments
            runner={r}
            items={envs.data}
            error={envs.error}
            loading={envs.loading}
            onRetry={envs.reload}
          />
          <CloudRunsList
            query={{}}
            environments={envs.data ?? []}
            title={S.runs}
            empty={S.runsEmpty}
          />
        </>
      ) : runner.error ? (
        <div className="ws-error" role="alert">
          <p>{cloudErrorMessage(runner.error, S.loadFailed)}</p>
          <Button onClick={runner.reload}>{CLOUD_TEXT.retry}</Button>
        </div>
      ) : (
        <Spinner label={S.loading} />
      )}
    </>
  );
}

// ---- the runner's state ----------------------------------------------------------------------

function RunnerStatus({
  r,
  onChanged,
}: {
  r: CloudRunnerView;
  onChanged: (r: CloudRunnerView) => void;
}) {
  const api = useCloudApi();
  const announce = useAnnounce();
  const headingId = useId();
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<CloudRunnerTestView | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [turningOn, setTurningOn] = useState(false);
  const [toggleError, setToggleError] = useState<string | null>(null);
  const configured = !!r.url && r.hasToken;
  const S = CLOUD_SETTINGS_TEXT.runner;

  const test = async () => {
    setTesting(true);
    setFailure(null);
    try {
      const t = await api.testCloudRunner();
      setResult(t);
      announce(t.ok ? S.answers : S.testNotPassed);
      onChanged(await api.getCloudRunner());
    } catch (err) {
      setFailure(cloudErrorMessage(err, S.testFailed));
    } finally {
      setTesting(false);
    }
  };

  const turnOff = async () => {
    setToggleError(null);
    try {
      onChanged(await api.setCloudRunnerEnabled(false));
      announce(S.isOff);
    } catch (err) {
      setToggleError(cloudErrorMessage(err, S.turnOffFailed));
    }
  };

  return (
    <section className="ws-section" aria-labelledby={headingId}>
      <div className="ws-section-header">
        <h3 id={headingId}>{S.heading}</h3>
        {configured ? (
          <Button onClick={() => void test()} disabled={testing}>
            {testing ? <Spinner /> : <Icon name="refresh" />} {S.test}
          </Button>
        ) : null}
      </div>
      <dl className="cl-facts">
        <Fact term={S.state}>
          <StateBadge spec={runnerStateSpec(r.state)} />
        </Fact>
        <Fact term={S.address}>
          {r.url ? (
            <code className="ws-code-inline cl-break" dir="ltr">
              {r.url}
            </code>
          ) : (
            CLOUD_TEXT.none
          )}
        </Fact>
        <Fact term={S.token}>{r.hasToken ? S.tokenSet : S.tokenNotSet}</Fact>
        <Fact term={S.version}>{r.version ?? CLOUD_TEXT.unknown}</Fact>
        <Fact term={S.sandbox}>
          {r.substrate
            ? r.substrate.ok
              ? (r.substrate.kind ?? CLOUD_TEXT.none)
              : S.sandboxUnusable({ kind: r.substrate.kind ?? CLOUD_TEXT.none })
            : CLOUD_TEXT.unknown}
        </Fact>
        <Fact term={S.checked}>{formatWhen(r.checkedAt)}</Fact>
      </dl>
      {r.detail && r.state !== 'ok' ? (
        <p className="muted ws-flush">{capitalize(r.detail)}.</p>
      ) : null}
      <SwitchField
        label={S.use}
        description={configured ? S.useHint : S.useFirst}
        checked={r.enabled}
        disabled={!configured}
        onChange={(next) => {
          if (next) {
            setToggleError(null);
            setTurningOn(true);
          } else void turnOff();
        }}
      />
      {toggleError ? (
        <p role="alert" className="nv-field-error">
          {toggleError}
        </p>
      ) : null}
      {failure ? (
        <p role="alert" className="nv-field-error">
          {failure}
        </p>
      ) : null}
      {result ? (
        <p className="cl-notice" data-tone={result.ok ? 'ok' : 'danger'} role="status">
          <Icon name={result.ok ? 'check' : 'alert'} />
          <span>
            {result.ok
              ? result.latencyMs !== null
                ? S.answeredIn({ ms: result.latencyMs, detail: result.detail })
                : S.answered({ detail: result.detail })
              : S.notPassed({ detail: result.detail })}
          </span>
        </p>
      ) : null}
      <ConfirmAction
        open={turningOn}
        title={S.turnOnTitle}
        description={S.turnOnBody({ url: r.url })}
        confirmLabel={S.turnOn}
        errorText={(err) => cloudErrorMessage(err, S.turnOnFailed)}
        onClose={() => setTurningOn(false)}
        onConfirm={async () => {
          const next = await api.setCloudRunnerEnabled(true);
          setTurningOn(false);
          onChanged(next);
          announce(S.isOn);
        }}
      />
    </section>
  );
}

// ---- address and token -------------------------------------------------------------------------

/** The form's problems, as the Hub would answer them. */
export function checkRunnerForm(
  url: string,
  token: string,
  hasToken: boolean,
): { url?: string; token?: string } {
  const S = CLOUD_SETTINGS_TEXT.form;
  const out: { url?: string; token?: string } = {};
  const u = url.trim();
  if (!u) out.url = S.urlRequired;
  else if (!isRunnerUrl(u)) out.url = S.urlInvalid;
  const t = token.trim();
  if (!t && !hasToken) out.token = S.tokenRequired;
  else if (t && !runnerTokenSchema.safeParse(t).success) out.token = S.tokenInvalid;
  return out;
}

function RunnerForm({ r, onSaved }: { r: CloudRunnerView; onSaved: (r: CloudRunnerView) => void }) {
  const api = useCloudApi();
  const toast = useToast();
  const announce = useAnnounce();
  const headingId = useId();
  const [url, setUrl] = useState<string | null>(null);
  const [token, setToken] = useState('');
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [forgetting, setForgetting] = useState(false);
  const value = url ?? r.url;
  const problems = checkRunnerForm(value, token, r.hasToken);
  const shown = tried ? problems : {};
  const dirty = value.trim() !== r.url || token.trim() !== '';
  const S = CLOUD_SETTINGS_TEXT.form;

  const save = async () => {
    setTried(true);
    if (Object.keys(problems).length || busy) return;
    setBusy(true);
    setError(null);
    try {
      const next = await api.configureCloudRunner({
        url: value.trim(),
        ...(token.trim() ? { token: token.trim() } : {}),
      });
      onSaved(next);
      setUrl(null);
      setToken('');
      setTried(false);
      toast.show(S.saved, { tone: 'success' });
      announce(S.savedState({ state: runnerStateSpec(next.state).text }));
    } catch (err) {
      setError(cloudErrorMessage(err, S.saveFailed));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="ws-section" aria-labelledby={headingId}>
      <h3 id={headingId}>{S.heading}</h3>
      <form
        className="stack cl-form"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <TextField
          label={S.address}
          value={value}
          autoComplete="off"
          spellCheck={false}
          inputMode="url"
          dir="ltr"
          placeholder={RUNNER_HOSTED_URL}
          hint={S.addressHint}
          error={shown.url}
          onChange={(e) => {
            setUrl(e.target.value);
            setError(null);
          }}
        />
        <div>
          <Button variant="ghost" onClick={() => setUrl(RUNNER_HOSTED_URL)}>
            {S.useHosted}
          </Button>
        </div>
        <TextField
          label={r.hasToken ? S.replaceToken : S.token}
          type="password"
          autoComplete="off"
          spellCheck={false}
          value={token}
          hint={r.hasToken ? S.tokenKeep : S.tokenHint}
          error={shown.token}
          onChange={(e) => {
            setToken(e.target.value);
            setError(null);
          }}
        />
        {error ? (
          <p role="alert" className="nv-field-error">
            {error}
          </p>
        ) : null}
        <div className="cl-actions">
          <Button type="submit" variant="primary" disabled={busy || !dirty}>
            {busy ? <Spinner /> : null} {S.save}
          </Button>
          {r.url || r.hasToken ? (
            <Button variant="danger" onClick={() => setForgetting(true)}>
              <Icon name="trash" /> {S.forget}
            </Button>
          ) : null}
        </div>
      </form>
      <ConfirmAction
        open={forgetting}
        title={S.forgetTitle}
        description={S.forgetBody}
        confirmLabel={S.forgetConfirm}
        danger
        errorText={(err) => cloudErrorMessage(err, S.forgetFailed)}
        onClose={() => setForgetting(false)}
        onConfirm={async () => {
          await api.forgetCloudRunner();
          setForgetting(false);
          setUrl(null);
          setToken('');
          onSaved(await api.getCloudRunner());
          announce(S.forgotten);
        }}
      />
    </section>
  );
}

// ---- caps (FR-116) -----------------------------------------------------------------------------

interface CapsDraft {
  cpu: string;
  wall: string;
  disk: string;
  warn: string;
}

/** The caps setting from the form, or the first problem with it. */
export function parseCaps(
  d: CapsDraft,
):
  | { caps: { cpuSeconds: number; wallSeconds: number; diskMb: number; warnAt: number } }
  | { error: string } {
  const whole = (s: string) => /^\d+$/.test(s.trim());
  const cpu = Number(d.cpu);
  const wall = Number(d.wall);
  const disk = Number(d.disk);
  const warn = Number(d.warn);
  const S = CLOUD_SETTINGS_TEXT.caps;
  if (!whole(d.cpu) || cpu < 1 || cpu > 10_080)
    return { error: CAP_TEXT.wholeMinutes({ what: CAP_TEXT.resource.cpu, min: 1, max: 10_080 }) };
  if (!whole(d.wall) || wall < 1 || wall > 10_080)
    return { error: CAP_TEXT.wholeMinutes({ what: CAP_TEXT.resource.wall, min: 1, max: 10_080 }) };
  if (!whole(d.disk) || disk < 16 || disk > 1_048_576)
    return { error: S.disk({ min: 16, max: 1_048_576 }) };
  if (!whole(d.warn) || warn < 50 || warn > 99) return { error: S.warn({ min: 50, max: 99 }) };
  return {
    caps: { cpuSeconds: cpu * 60, wallSeconds: wall * 60, diskMb: disk, warnAt: warn / 100 },
  };
}

function CapsSection() {
  const settings = useSettings();
  const toast = useToast();
  const headingId = useId();
  const entry = settings.get('cloud.runner.caps');
  const v = entry.value;
  const initial: CapsDraft = {
    cpu: String(Math.round(v.cpuSeconds / 60)),
    wall: String(Math.round(v.wallSeconds / 60)),
    disk: String(v.diskMb),
    warn: String(Math.round(v.warnAt * 100)),
  };
  const [draft, setDraft] = useState<CapsDraft | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const d = draft ?? initial;
  const S = CLOUD_SETTINGS_TEXT.caps;
  const set = (k: keyof CapsDraft, s: string) => {
    setDraft({ ...d, [k]: s });
    setError(null);
  };
  const save = async () => {
    const parsed = parseCaps(d);
    if ('error' in parsed) {
      setError(parsed.error);
      return;
    }
    setBusy(true);
    try {
      await settings.set('cloud.runner.caps', parsed.caps);
      setDraft(null);
      toast.show(S.saved, { tone: 'success' });
    } catch (err) {
      setError(cloudErrorMessage(err, S.saveFailed));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="ws-section" aria-labelledby={headingId}>
      <h3 id={headingId}>{S.heading}</h3>
      <p className="muted">{S.intro}</p>
      <form
        className="stack"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <div className="cl-field-row">
          <TextField
            label={S.cpuPerRun}
            type="number"
            inputMode="numeric"
            className="ws-number"
            value={d.cpu}
            disabled={entry.locked}
            onChange={(e) => set('cpu', e.target.value)}
          />
          <TextField
            label={S.wallPerRun}
            type="number"
            inputMode="numeric"
            className="ws-number"
            value={d.wall}
            disabled={entry.locked}
            onChange={(e) => set('wall', e.target.value)}
          />
          <TextField
            label={S.diskPerEnv}
            type="number"
            inputMode="numeric"
            className="ws-number"
            value={d.disk}
            disabled={entry.locked}
            onChange={(e) => set('disk', e.target.value)}
          />
          <TextField
            label={S.warnAt}
            type="number"
            inputMode="numeric"
            className="ws-number"
            value={d.warn}
            disabled={entry.locked}
            onChange={(e) => set('warn', e.target.value)}
          />
        </div>
        {entry.locked ? <p className="nv-field-hint">{S.managed}</p> : null}
        {error ? (
          <p role="alert" className="nv-field-error">
            {error}
          </p>
        ) : null}
        {entry.locked ? null : (
          <div>
            <Button type="submit" disabled={busy || draft === null}>
              {busy ? <Spinner /> : null} {S.save}
            </Button>
          </div>
        )}
      </form>
    </section>
  );
}

// ---- network (docs/12 §8) ----------------------------------------------------------------------

/**
 * Whether cloud environments may reach the network straight from the runner. Their traffic does
 * not pass the Hub's egress proxy, so it is off by default, a security setting, and asks first.
 */
function NetworkSection() {
  const settings = useSettings();
  const toast = useToast();
  const headingId = useId();
  const entry = settings.get('cloud.runner.unrestrictedNetwork');
  const [asking, setAsking] = useState(false);
  const S = CLOUD_SETTINGS_TEXT.network;
  return (
    <section className="ws-section" aria-labelledby={headingId}>
      <h3 id={headingId}>{S.heading}</h3>
      <SwitchField
        label={S.label}
        description={S.description}
        checked={entry.value}
        locked={entry.locked}
        onChange={(next) => {
          if (next) setAsking(true);
          else
            void settings.set('cloud.runner.unrestrictedNetwork', false).catch((err: unknown) =>
              toast.show(S.saveFailedBecause({ reason: cloudErrorMessage(err) }), {
                tone: 'error',
              }),
            );
        }}
      />
      {entry.value ? (
        <p className="cl-notice" data-tone="warn" role="note">
          <Icon name="alert" />
          <span>{S.warning}</span>
        </p>
      ) : null}
      <ConfirmAction
        open={asking}
        title={S.askTitle}
        description={S.askBody}
        confirmLabel={S.allow}
        danger
        errorText={(err) => cloudErrorMessage(err, S.saveFailed)}
        onClose={() => setAsking(false)}
        onConfirm={async () => {
          await settings.set('cloud.runner.unrestrictedNetwork', true);
          setAsking(false);
        }}
      />
    </section>
  );
}

// ---- environments ------------------------------------------------------------------------------

function Environments({
  runner,
  items,
  error,
  loading,
  onRetry,
}: {
  runner: CloudRunnerView;
  items: CloudEnvironmentView[] | null;
  error: unknown;
  loading: boolean;
  onRetry: () => void;
}) {
  const headingId = useId();
  const [creating, setCreating] = useState(false);
  const usable = runnerUsable(runner);
  const S = CLOUD_SETTINGS_TEXT.environments;
  const why = usable ? null : S.runnerFirst;
  return (
    <section className="ws-section" aria-labelledby={headingId}>
      <div className="ws-section-header">
        <h3 id={headingId}>{S.heading}</h3>
        <Button
          variant="primary"
          disabled={!usable}
          title={why ?? undefined}
          onClick={() => setCreating(true)}
        >
          <Icon name="plus" /> {S.create}
        </Button>
      </div>
      {why ? <p className="muted cl-small">{why}</p> : null}
      {error && !items ? (
        <div className="ws-error" role="alert">
          <p>{cloudErrorMessage(error, S.loadFailed)}</p>
          <Button onClick={onRetry}>{CLOUD_TEXT.retry}</Button>
        </div>
      ) : null}
      {loading ? <Spinner label={S.loading} /> : null}
      {items?.length === 0 ? (
        <EmptyState level={3} title={S.empty} description={S.emptyHint} icon="server" />
      ) : null}
      {items?.length ? (
        <ul className="ws-list" aria-label={S.heading}>
          {items.map((e) => (
            <li key={e.id} className="ws-list-row" aria-label={e.label}>
              <span className="cl-row-main">
                <span className="cl-row-title">
                  <InAppLink to={cloudEnvPath(e.id)} className="cl-strong">
                    {e.label}
                  </InAppLink>
                  <StateBadge spec={environmentState(e)} />
                </span>
                <span className="muted ws-row-meta">
                  <span>
                    {e.connection.repoUrls.length
                      ? fmt.list(e.connection.repoUrls.map(repoName), {
                          type: 'unit',
                          style: 'short',
                        })
                      : S.noRepos}
                  </span>
                  <span>{NETWORK_TEXT[e.connection.network]}</span>
                  {e.runner ? (
                    <span>
                      {CLOUD_TEXT.usedOf({
                        used: formatBytes(e.runner.usage.diskBytes),
                        cap: formatBytes(e.runner.caps.diskBytes),
                      })}
                    </span>
                  ) : null}
                  {e.runner?.runs.active ? (
                    <span>{S.running({ n: e.runner.runs.active })}</span>
                  ) : null}
                </span>
              </span>
              <Button
                aria-label={S.openOne({ name: e.label })}
                onClick={() => navigate(cloudEnvPath(e.id))}
              >
                {S.open} <Icon name="forward" />
              </Button>
            </li>
          ))}
        </ul>
      ) : null}
      <CloudEnvironmentDialog
        open={creating}
        runner={runner}
        onClose={() => setCreating(false)}
        onCreated={(env) => {
          setCreating(false);
          navigate(cloudEnvPath(env.id));
        }}
      />
    </section>
  );
}
