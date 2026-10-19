// Settings → Cloud runner (FR-108, FR-071, FR-116; docs/13 §3, docs/10 §12) at /settings/cloud: the
// runner this Hub sends cloud environments' commands to (its address, a write-only token kept in
// the vault, on or off, a test, forget), the caps every run and environment gets, the cloud
// environments (new, open) and the runs with their usage. An environment opens at ?env=<id> and a
// run at ?run=<id>, as full pages with a way back. The agent loop, the models and approvals stay
// on this Hub; the runner only holds the environments and runs their commands.
import { useId, useState } from 'react';
import {
  RUNNER_HOSTED_URL,
  SETTINGS,
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
  NETWORK_TEXT,
  RUNNER_STATE,
  capitalize,
  cloudEnvPath,
  cloudErrorMessage,
  environmentState,
  formatBytes,
  repoName,
  runnerUsable,
} from './format.ts';
import { ConfirmAction, Fact, InAppLink, StateBadge, useLoad } from './parts.tsx';
import '../workspace.css';

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
  return (
    <>
      <h2>Cloud runner</h2>
      <p className="muted">
        Cloud environments keep their repositories, setup and caches on a runner, and their commands
        run there, so Code sessions and Work runs keep going while your devices are off. The agent,
        the models and your approvals stay on this Hub.
      </p>
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
            title="Runs"
            empty="A run starts when a Code session or Work run uses a cloud environment."
          />
        </>
      ) : runner.error ? (
        <div className="ws-error" role="alert">
          <p>{cloudErrorMessage(runner.error, 'Could not load the cloud runner.')}</p>
          <Button onClick={runner.reload}>Retry</Button>
        </div>
      ) : (
        <Spinner label="Loading the cloud runner" />
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

  const test = async () => {
    setTesting(true);
    setFailure(null);
    try {
      const t = await api.testCloudRunner();
      setResult(t);
      announce(t.ok ? 'The runner answers.' : 'The runner test did not pass.');
      onChanged(await api.getCloudRunner());
    } catch (err) {
      setFailure(cloudErrorMessage(err, 'Could not test the runner.'));
    } finally {
      setTesting(false);
    }
  };

  const turnOff = async () => {
    setToggleError(null);
    try {
      onChanged(await api.setCloudRunnerEnabled(false));
      announce('The cloud runner is off.');
    } catch (err) {
      setToggleError(cloudErrorMessage(err, 'Could not turn the runner off.'));
    }
  };

  return (
    <section className="ws-section" aria-labelledby={headingId}>
      <div className="ws-section-header">
        <h3 id={headingId}>Runner</h3>
        {configured ? (
          <Button onClick={() => void test()} disabled={testing}>
            {testing ? <Spinner /> : <Icon name="refresh" />} Test
          </Button>
        ) : null}
      </div>
      <dl className="cl-facts">
        <Fact term="State">
          <StateBadge spec={RUNNER_STATE[r.state]} />
        </Fact>
        <Fact term="Address">
          {r.url ? <code className="ws-code-inline cl-break">{r.url}</code> : 'None'}
        </Fact>
        <Fact term="Token">{r.hasToken ? 'Set' : 'Not set'}</Fact>
        <Fact term="Version">{r.version ?? 'Unknown'}</Fact>
        <Fact term="Sandbox">
          {r.substrate
            ? `${r.substrate.kind ?? 'None'}${r.substrate.ok ? '' : ' (not usable)'}`
            : 'Unknown'}
        </Fact>
        <Fact term="Checked">{formatWhen(r.checkedAt)}</Fact>
      </dl>
      {r.detail && r.state !== 'ok' ? (
        <p className="muted ws-flush">{capitalize(r.detail)}.</p>
      ) : null}
      <SwitchField
        label="Use the cloud runner"
        description={
          configured
            ? 'Cloud environments run their commands on this runner. Turning it on tests it first.'
            : 'Enter the runner’s address and token below first.'
        }
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
              ? `The runner answers${result.latencyMs !== null ? ` in ${result.latencyMs} ms` : ''}: ${result.detail}.`
              : `The runner test did not pass: ${result.detail}.`}
          </span>
        </p>
      ) : null}
      <ConfirmAction
        open={turningOn}
        title="Turn on the cloud runner?"
        description={`The commands and files of cloud environments go to ${r.url}, with the token on every request. Runs there keep going while your devices are off.`}
        confirmLabel="Turn on"
        errorText={(err) => cloudErrorMessage(err, 'Could not turn the runner on.')}
        onClose={() => setTurningOn(false)}
        onConfirm={async () => {
          const next = await api.setCloudRunnerEnabled(true);
          setTurningOn(false);
          onChanged(next);
          announce('The cloud runner is on.');
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
  const out: { url?: string; token?: string } = {};
  const u = url.trim();
  if (!u) out.url = 'Enter the runner’s address, or use the hosted runner.';
  else if (!isRunnerUrl(u))
    out.url =
      'Enter an https:// address (http:// only for a runner on this computer), without a user name or password.';
  const t = token.trim();
  if (!t && !hasToken) out.token = 'Enter the token the runner gave you (nvrun_…).';
  else if (t && !runnerTokenSchema.safeParse(t).success)
    out.token = 'That is not a runner token. It starts with nvrun_ and has 43 more characters.';
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
      toast.show('Runner saved.', { tone: 'success' });
      announce(`Runner saved. ${RUNNER_STATE[next.state].text}.`);
    } catch (err) {
      setError(cloudErrorMessage(err, 'Could not save the runner.'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="ws-section" aria-labelledby={headingId}>
      <h3 id={headingId}>Address and token</h3>
      <form
        className="stack cl-form"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <TextField
          label="Runner address"
          value={value}
          autoComplete="off"
          spellCheck={false}
          inputMode="url"
          placeholder={RUNNER_HOSTED_URL}
          hint="Your own runner (nova-runner), or the hosted one."
          error={shown.url}
          onChange={(e) => {
            setUrl(e.target.value);
            setError(null);
          }}
        />
        <div>
          <Button variant="ghost" onClick={() => setUrl(RUNNER_HOSTED_URL)}>
            Use the hosted runner
          </Button>
        </div>
        <TextField
          label={r.hasToken ? 'Replace the token' : 'Runner token'}
          type="password"
          autoComplete="off"
          spellCheck={false}
          value={token}
          hint={
            r.hasToken
              ? 'A token is set. Leave this empty to keep it. It is kept in the vault and never shown.'
              : 'From `nova-runner token add`. It is kept in the vault and never shown again.'
          }
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
            {busy ? <Spinner /> : null} Save
          </Button>
          {r.url || r.hasToken ? (
            <Button variant="danger" onClick={() => setForgetting(true)}>
              <Icon name="trash" /> Forget this runner…
            </Button>
          ) : null}
        </div>
      </form>
      <ConfirmAction
        open={forgetting}
        title="Forget this runner?"
        description="Its token leaves the vault and cloud environments stop running until a runner is set up again. The environments stay saved, and their files stay on the runner."
        confirmLabel="Forget runner"
        danger
        errorText={(err) => cloudErrorMessage(err, 'Could not forget the runner.')}
        onClose={() => setForgetting(false)}
        onConfirm={async () => {
          await api.forgetCloudRunner();
          setForgetting(false);
          setUrl(null);
          setToken('');
          onSaved(await api.getCloudRunner());
          announce('The runner is forgotten.');
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
  if (!whole(d.cpu) || cpu < 1 || cpu > 10_080)
    return { error: 'Set the CPU time cap in whole minutes, from 1 to 10,080.' };
  if (!whole(d.wall) || wall < 1 || wall > 10_080)
    return { error: 'Set the running time cap in whole minutes, from 1 to 10,080.' };
  if (!whole(d.disk) || disk < 16 || disk > 1_048_576)
    return { error: 'Set the disk cap in whole MB, from 16 to 1,048,576.' };
  if (!whole(d.warn) || warn < 50 || warn > 99)
    return { error: 'Warn at a share from 50 to 99 percent.' };
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
      toast.show('Caps saved. New runs get them.', { tone: 'success' });
    } catch (err) {
      setError(cloudErrorMessage(err, 'Could not save the caps.'));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="ws-section" aria-labelledby={headingId}>
      <h3 id={headingId}>Caps</h3>
      <p className="muted">
        Every run stops at its caps and waits for you to raise them; a warning comes first. Each
        environment may use at most the disk cap.
      </p>
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
            label="CPU time per run (minutes)"
            type="number"
            inputMode="numeric"
            className="ws-number"
            value={d.cpu}
            disabled={entry.locked}
            onChange={(e) => set('cpu', e.target.value)}
          />
          <TextField
            label="Running time per run (minutes)"
            type="number"
            inputMode="numeric"
            className="ws-number"
            value={d.wall}
            disabled={entry.locked}
            onChange={(e) => set('wall', e.target.value)}
          />
          <TextField
            label="Disk per environment (MB)"
            type="number"
            inputMode="numeric"
            className="ws-number"
            value={d.disk}
            disabled={entry.locked}
            onChange={(e) => set('disk', e.target.value)}
          />
          <TextField
            label="Warn at (percent of a cap)"
            type="number"
            inputMode="numeric"
            className="ws-number"
            value={d.warn}
            disabled={entry.locked}
            onChange={(e) => set('warn', e.target.value)}
          />
        </div>
        {entry.locked ? (
          <p className="nv-field-hint">Your organization manages these caps.</p>
        ) : null}
        {error ? (
          <p role="alert" className="nv-field-error">
            {error}
          </p>
        ) : null}
        {entry.locked ? null : (
          <div>
            <Button type="submit" disabled={busy || draft === null}>
              {busy ? <Spinner /> : null} Save caps
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
  return (
    <section className="ws-section" aria-labelledby={headingId}>
      <h3 id={headingId}>Network</h3>
      <SwitchField
        label="Unrestricted network"
        description={SETTINGS['cloud.runner.unrestrictedNetwork'].description}
        checked={entry.value}
        locked={entry.locked}
        onChange={(next) => {
          if (next) setAsking(true);
          else
            void settings
              .set('cloud.runner.unrestrictedNetwork', false)
              .catch((err: unknown) =>
                toast.show(`Could not save: ${cloudErrorMessage(err)}`, { tone: 'error' }),
              );
        }}
      />
      {entry.value ? (
        <p className="cl-notice" data-tone="warn" role="note">
          <Icon name="alert" />
          <span>
            Cloud environments made with network can reach any address from the runner, including
            private ones, and nothing of it is in the Hub’s egress log.
          </span>
        </p>
      ) : null}
      <ConfirmAction
        open={asking}
        title="Allow unrestricted network?"
        description="Cloud environments with network then reach the internet straight from the runner. The Hub’s allowlist, its blocking of private and local addresses, and its egress audit do not apply to that traffic."
        confirmLabel="Allow"
        danger
        errorText={(err) => cloudErrorMessage(err, 'Could not save.')}
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
  const why = usable ? null : 'Set up and turn on the runner first.';
  return (
    <section className="ws-section" aria-labelledby={headingId}>
      <div className="ws-section-header">
        <h3 id={headingId}>Cloud environments</h3>
        <Button
          variant="primary"
          disabled={!usable}
          title={why ?? undefined}
          onClick={() => setCreating(true)}
        >
          <Icon name="plus" /> New cloud environment
        </Button>
      </div>
      {why ? <p className="muted cl-small">{why}</p> : null}
      {error && !items ? (
        <div className="ws-error" role="alert">
          <p>{cloudErrorMessage(error, 'Could not load the cloud environments.')}</p>
          <Button onClick={onRetry}>Retry</Button>
        </div>
      ) : null}
      {loading ? <Spinner label="Loading the cloud environments" /> : null}
      {items?.length === 0 ? (
        <EmptyState
          level={3}
          title="No cloud environments yet"
          description="Add one with your repositories and a setup script. Pick it when you start a Code session or a Work run."
          icon="server"
        />
      ) : null}
      {items?.length ? (
        <ul className="ws-list" aria-label="Cloud environments">
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
                      ? e.connection.repoUrls.map(repoName).join(', ')
                      : 'No repositories'}
                  </span>
                  <span>{NETWORK_TEXT[e.connection.network]}</span>
                  {e.runner ? (
                    <span>
                      {formatBytes(e.runner.usage.diskBytes)} of{' '}
                      {formatBytes(e.runner.caps.diskBytes)}
                    </span>
                  ) : null}
                  {e.runner?.runs.active ? <span>{e.runner.runs.active} running</span> : null}
                </span>
              </span>
              <Button aria-label={`Open ${e.label}`} onClick={() => navigate(cloudEnvPath(e.id))}>
                Open <Icon name="forward" />
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
