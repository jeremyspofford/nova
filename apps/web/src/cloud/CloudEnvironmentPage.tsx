// One cloud environment (FR-071, FR-108; docs/10 §2, §12) at /settings/cloud?env=<id>: what the
// runner reports (status, repositories with their branch and commit, the setup script's result
// and log, disk used against its cap, running commands), Rebuild (clones again and runs the setup
// again; explicit, asks first), Delete (asks first; refused while sessions use it), snapshots,
// the files, its runs, and a Work run started here. Follows the environment and run events, and
// checks again every few seconds while the runner is still setting it up.
import { useId, useState } from 'react';
import type { CloudEnvironmentView } from '@nova/shared';
import { Button, Icon, Spinner, useToast } from '@nova/ui';
import { navigate } from '../router.ts';
import { useAnnounce } from '../services.tsx';
import { formatWhen, plural, useInterval } from '../settings/common.ts';
import { useCloudApi } from './api.ts';
import { CloudFiles } from './CloudFiles.tsx';
import { CloudRunsList } from './CloudRunsList.tsx';
import { CloudSnapshots } from './CloudSnapshots.tsx';
import { CloudWorkDialog } from './CloudWorkDialog.tsx';
import { ENVIRONMENT_EVENTS, eventEnvironmentId, useCloudEvents } from './events.ts';
import {
  CLOUD_SETTINGS_PATH,
  NETWORK_TEXT,
  SETUP_TEXT,
  cloudErrorMessage,
  environmentState,
  formatBytes,
  repoName,
  runnerUsable,
} from './format.ts';
import { BackLink, ConfirmAction, Fact, StateBadge, TextBlock, useLoad } from './parts.tsx';

/** How often a provisioning environment is checked again (besides its events). */
export const PROVISIONING_POLL_MS = 5000;

export function CloudEnvironmentPage({ id }: { id: string }) {
  const api = useCloudApi();
  const toast = useToast();
  const announce = useAnnounce();
  const env = useLoad(() => api.getCloudEnvironment(id), `env:${id}`);
  const runner = useLoad(() => api.getCloudRunner(), 'runner');
  const [rebuilding, setRebuilding] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [working, setWorking] = useState(false);
  useCloudEvents(
    ENVIRONMENT_EVENTS,
    (ev) => {
      if (ev.name === 'cloud.runner.updated') runner.reload();
      const about = eventEnvironmentId(ev);
      if (!about || about === id) env.reload();
    },
    env.reload,
  );
  const e = env.data;
  useInterval(env.reload, PROVISIONING_POLL_MS, e?.runner?.status === 'provisioning');

  if (!e)
    return (
      <div className="stack cl-page">
        <BackLink to={CLOUD_SETTINGS_PATH} label="Cloud runner" />
        {env.error ? (
          <div className="ws-error" role="alert">
            <p>{cloudErrorMessage(env.error, 'Could not load the environment.')}</p>
            <Button onClick={env.reload}>Retry</Button>
          </div>
        ) : (
          <Spinner label="Loading the environment" />
        )}
      </div>
    );

  const r = e.runner;
  const usable = runner.data ? runnerUsable(runner.data) : true;
  const offline = !usable
    ? 'The cloud runner is off or not set up, so this environment cannot be used now.'
    : !r
      ? 'The runner cannot be reached right now.'
      : null;
  // Sections say briefly why they wait; the notice above explains an unusable runner.
  const busy =
    (offline ? 'Not available while the runner cannot be used.' : null) ??
    (r?.status === 'provisioning'
      ? 'The runner is still setting this environment up.'
      : r?.status === 'deleting'
        ? 'The runner is removing this environment.'
        : null);
  const c = e.connection;

  return (
    <div className="stack cl-page">
      <BackLink to={CLOUD_SETTINGS_PATH} label="Cloud runner" />
      <header className="ws-page-header">
        <h2 className="cl-title">{e.label}</h2>
        <StateBadge spec={environmentState(e)} />
      </header>
      {e.detail && e.status !== 'ok' ? <p className="muted ws-flush">{e.detail}</p> : null}
      {offline ? (
        <p className="ws-callout" role="note">
          <Icon name="alert" />
          <span>{offline}</span>
        </p>
      ) : null}
      <div className="cl-actions">
        <Button
          variant="primary"
          disabled={r?.status !== 'ready' || !usable}
          title={r?.status !== 'ready' ? 'The environment is not ready yet.' : undefined}
          onClick={() => setWorking(true)}
        >
          <Icon name="work" /> New Work run here…
        </Button>
        <Button onClick={() => navigate('/code?new=1')}>
          <Icon name="code" /> New Code session…
        </Button>
        <Button disabled={!!busy} title={busy ?? undefined} onClick={() => setRebuilding(true)}>
          <Icon name="refresh" /> Rebuild…
        </Button>
        <Button variant="danger" onClick={() => setDeleting(true)}>
          <Icon name="trash" /> Delete…
        </Button>
      </div>

      <section className="ws-section" aria-label="About this environment">
        <dl className="cl-facts">
          <Fact term="Network">{NETWORK_TEXT[c.network]}</Fact>
          <Fact term="Folder for sessions">
            <code className="ws-code-inline cl-break">{c.folder}</code>
          </Fact>
          <Fact term="Disk">
            {r
              ? `${formatBytes(r.usage.diskBytes)} of ${formatBytes(r.caps.diskBytes)}`
              : `Up to ${c.diskMb.toLocaleString()} MB`}
          </Fact>
          <Fact term="Base image">{c.baseImage ?? 'The runner’s default'}</Fact>
          <Fact term="Caches">{c.caches.length ? c.caches.join(', ') : 'None'}</Fact>
          <Fact term="Used by">
            {e.sessions ? plural(e.sessions, 'active Code session') : 'No active Code sessions'}
          </Fact>
          {r ? (
            <Fact term="Running now">
              {r.runs.active ? plural(r.runs.active, 'run') : 'No runs'},{' '}
              {r.processes.running ? plural(r.processes.running, 'command') : 'no commands'}
            </Fact>
          ) : null}
          {r?.readyAt ? <Fact term="Ready since">{formatWhen(r.readyAt)}</Fact> : null}
        </dl>
      </section>

      <Repositories e={e} />
      <Setup e={e} />
      <CloudSnapshots environmentId={id} disabled={busy} />
      <CloudFiles environmentId={id} start={c.folder} disabled={busy} />
      <CloudRunsList
        query={{ environmentId: id }}
        environments={[e]}
        title="Runs here"
        empty="Runs start when a Code session or Work run uses this environment."
      />

      <CloudWorkDialog
        open={working}
        environments={[e]}
        environmentId={id}
        onClose={() => setWorking(false)}
        onStarted={(v) => {
          setWorking(false);
          navigate(`/work/${encodeURIComponent(v.runId)}`);
        }}
      />
      <ConfirmAction
        open={rebuilding}
        title={`Rebuild ${e.label}?`}
        description="The runner clones the repositories again and runs the setup script again. Changes in the work folder that are not pushed or in a snapshot are lost; caches stay."
        confirmLabel="Rebuild"
        danger
        errorText={(err) => cloudErrorMessage(err, 'Could not rebuild the environment.')}
        onClose={() => setRebuilding(false)}
        onConfirm={async () => {
          const next = await api.rebuildCloudEnvironment(id);
          setRebuilding(false);
          env.setData(() => next);
          announce(`Rebuilding ${e.label}.`);
        }}
      />
      <ConfirmAction
        open={deleting}
        title={`Delete ${e.label}?`}
        description="It is removed from the runner with its files and snapshots. Sessions that used it keep their history."
        confirmLabel="Delete"
        danger
        errorText={(err) => cloudErrorMessage(err, 'Could not delete the environment.')}
        onClose={() => setDeleting(false)}
        onConfirm={async () => {
          await api.deleteCloudEnvironment(id);
          setDeleting(false);
          toast.show(`Deleted ${e.label}.`, { tone: 'success' });
          navigate(CLOUD_SETTINGS_PATH);
        }}
      />
    </div>
  );
}

function Repositories({ e }: { e: CloudEnvironmentView }) {
  const headingId = useId();
  const reported = e.runner?.repos ?? [];
  return (
    <section className="ws-section" aria-labelledby={headingId}>
      <h3 id={headingId}>Repositories</h3>
      {e.connection.repoUrls.length === 0 ? (
        <p className="muted">No repositories. Sessions work in an empty /workspace folder.</p>
      ) : (
        <ul className="ws-list" aria-label="Repositories">
          {e.connection.repoUrls.map((url) => {
            const name = repoName(url);
            const r = reported.find((x) => x.name === name) ?? null;
            return (
              <li key={url} className="ws-list-row" aria-label={name}>
                <span className="cl-row-main">
                  <span className="cl-strong">{name}</span>
                  <code className="ws-code-inline cl-break cl-small">{url}</code>
                  <span className="muted ws-row-meta">
                    {r ? (
                      <>
                        <span>{r.path}</span>
                        <span>{r.ref ? `Branch ${r.ref}` : 'Default branch'}</span>
                        {r.head ? <span>At {r.head.slice(0, 7)}</span> : null}
                      </>
                    ) : (
                      <span>Not cloned yet</span>
                    )}
                  </span>
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

function Setup({ e }: { e: CloudEnvironmentView }) {
  const headingId = useId();
  const s = e.runner?.setup ?? null;
  return (
    <section className="ws-section" aria-labelledby={headingId}>
      <h3 id={headingId}>Setup</h3>
      {e.connection.setupScript ? (
        <details className="ws-advanced">
          <summary>The setup script</summary>
          <TextBlock text={e.connection.setupScript} label="The setup script" />
        </details>
      ) : null}
      {s ? (
        <p
          className="cl-notice"
          data-tone={s.status === 'failed' ? 'danger' : s.status === 'ok' ? 'ok' : undefined}
          role={s.status === 'failed' ? 'alert' : 'status'}
        >
          <Icon
            name={s.status === 'failed' ? 'alert' : s.status === 'running' ? 'refresh' : 'check'}
          />
          <span>
            {SETUP_TEXT[s.status]}
            {s.exitCode !== null && s.status === 'failed' ? ` (exit code ${s.exitCode})` : ''}
            {s.endedAt ? `, ${formatWhen(s.endedAt)}` : ''}.
            {s.status === 'failed' ? ' Fix the script or the repositories, then rebuild.' : ''}
          </span>
        </p>
      ) : (
        <p className="muted">The runner has not reported the setup yet.</p>
      )}
      {s?.log ? <TextBlock text={s.log} label="The end of the setup log" /> : null}
    </section>
  );
}
