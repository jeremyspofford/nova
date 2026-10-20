// One cloud environment (FR-071, FR-108; docs/10 §2, §12) at /settings/cloud?env=<id>: what the
// runner reports (status, repositories with their branch and commit, the setup script's result
// and log, disk used against its cap, running commands), Rebuild (clones again and runs the setup
// again; explicit, asks first), Delete (asks first; refused while sessions use it), snapshots,
// the files, its runs, and a Work run started here. Follows the environment and run events, and
// checks again every few seconds while the runner is still setting it up.
import { useId, useState } from 'react';
import { defineMessages, fmt } from '@nova/i18n';
import type { CloudEnvironmentView } from '@nova/shared';
import { Button, Icon, Spinner, useToast } from '@nova/ui';
import { navigate } from '../router.ts';
import { useAnnounce } from '../services.tsx';
import { formatWhen, useInterval } from '../settings/common.ts';
import { useCloudApi } from './api.ts';
import { CloudFiles } from './CloudFiles.tsx';
import { CloudRunsList } from './CloudRunsList.tsx';
import { CloudSnapshots } from './CloudSnapshots.tsx';
import { CloudWorkDialog } from './CloudWorkDialog.tsx';
import { ENVIRONMENT_EVENTS, eventEnvironmentId, useCloudEvents } from './events.ts';
import {
  CLOUD_SETTINGS_PATH,
  CLOUD_TEXT,
  NETWORK_TEXT,
  SETUP_TEXT,
  cloudErrorMessage,
  environmentState,
  formatBytes,
  repoName,
  runnerUsable,
} from './format.ts';
import { BackLink, ConfirmAction, Fact, StateBadge, TextBlock, useLoad } from './parts.tsx';

/** One cloud environment's page. `{name}` is the environment's name. */
export const ENVIRONMENT_TEXT = defineMessages('cloud.environment', {
  loadFailed: 'Could not load the environment.',
  loading: 'Loading the environment',
  offline: 'The cloud runner is off or not set up, so this environment cannot be used now.',
  unreachable: 'The runner cannot be reached right now.',
  unavailable: 'Not available while the runner cannot be used.',
  provisioning: 'The runner is still setting this environment up.',
  deleting: 'The runner is removing this environment.',
  notReady: 'The environment is not ready yet.',
  newWork: 'New Work run here…',
  newCode: 'New Code session…',
  rebuild: 'Rebuild…',
  about: 'About this environment',
  network: 'Network',
  folder: 'Folder for sessions',
  disk: 'Disk',
  /** {mb} is a number of megabytes. */
  diskUpTo: 'Up to {mb} MB',
  baseImage: 'Base image',
  defaultImage: 'The runner’s default',
  caches: 'Caches',
  usedBy: 'Used by',
  sessions:
    '{n, plural, =0 {No active Code sessions} one {# active Code session} other {# active Code sessions}}',
  runningNow: 'Running now',
  /** What runs in the environment now: "2 runs, 1 command". */
  runningNowValue:
    '{runs, plural, =0 {No runs} one {# run} other {# runs}}, {commands, plural, =0 {no commands} one {# command} other {# commands}}',
  readySince: 'Ready since',
  runsHere: 'Runs here',
  runsHereEmpty: 'Runs start when a Code session or Work run uses this environment.',
  rebuildTitle: 'Rebuild {name}?',
  rebuildBody:
    'The runner clones the repositories again and runs the setup script again. Changes in the work folder that are not pushed or in a snapshot are lost; caches stay.',
  rebuildConfirm: 'Rebuild',
  rebuildFailed: 'Could not rebuild the environment.',
  rebuilding: 'Rebuilding {name}.',
  deleteTitle: 'Delete {name}?',
  deleteBody:
    'It is removed from the runner with its files and snapshots. Sessions that used it keep their history.',
  deleteFailed: 'Could not delete the environment.',
  deleted: 'Deleted {name}.',
  repos: {
    heading: 'Repositories',
    none: 'No repositories. Sessions work in an empty /workspace folder.',
    /** {ref} is a branch name. */
    branch: 'Branch {ref}',
    defaultBranch: 'Default branch',
    /** {commit} is a short commit hash. */
    at: 'At {commit}',
    notCloned: 'Not cloned yet',
  },
  setup: {
    heading: 'Setup',
    script: 'The setup script',
    notReported: 'The runner has not reported the setup yet.',
    log: 'The end of the setup log',
  },
});

/** The setup script's result in a sentence, with when it ended. */
function setupSentence(s: NonNullable<NonNullable<CloudEnvironmentView['runner']>['setup']>) {
  const when = s.endedAt ? formatWhen(s.endedAt) : null;
  if (s.status === 'failed' && s.exitCode !== null)
    return when
      ? SETUP_TEXT.failedCodeAt({ code: s.exitCode, when })
      : SETUP_TEXT.failedCode({ code: s.exitCode });
  if (when && s.status !== 'none') return SETUP_TEXT.statusAt[s.status]({ when });
  return SETUP_TEXT.status[s.status];
}

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

  const S = ENVIRONMENT_TEXT;
  if (!e)
    return (
      <div className="stack cl-page">
        <BackLink to={CLOUD_SETTINGS_PATH} label={CLOUD_TEXT.cloudRunner} />
        {env.error ? (
          <div className="ws-error" role="alert">
            <p>{cloudErrorMessage(env.error, S.loadFailed)}</p>
            <Button onClick={env.reload}>{CLOUD_TEXT.retry}</Button>
          </div>
        ) : (
          <Spinner label={S.loading} />
        )}
      </div>
    );

  const r = e.runner;
  const usable = runner.data ? runnerUsable(runner.data) : true;
  const offline = !usable ? S.offline : !r ? S.unreachable : null;
  // Sections say briefly why they wait; the notice above explains an unusable runner.
  const busy =
    (offline ? S.unavailable : null) ??
    (r?.status === 'provisioning' ? S.provisioning : r?.status === 'deleting' ? S.deleting : null);
  const c = e.connection;

  return (
    <div className="stack cl-page">
      <BackLink to={CLOUD_SETTINGS_PATH} label={CLOUD_TEXT.cloudRunner} />
      <header className="ws-page-header">
        <h2 className="cl-title" dir="auto">
          {e.label}
        </h2>
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
          title={r?.status !== 'ready' ? S.notReady : undefined}
          onClick={() => setWorking(true)}
        >
          <Icon name="work" /> {S.newWork}
        </Button>
        <Button onClick={() => navigate('/code?new=1')}>
          <Icon name="code" /> {S.newCode}
        </Button>
        <Button disabled={!!busy} title={busy ?? undefined} onClick={() => setRebuilding(true)}>
          <Icon name="refresh" /> {S.rebuild}
        </Button>
        <Button variant="danger" onClick={() => setDeleting(true)}>
          <Icon name="trash" /> {CLOUD_TEXT.deleteMore}
        </Button>
      </div>

      <section className="ws-section" aria-label={S.about}>
        <dl className="cl-facts">
          <Fact term={S.network}>{NETWORK_TEXT[c.network]}</Fact>
          <Fact term={S.folder}>
            <code className="ws-code-inline cl-break" dir="ltr">
              {c.folder}
            </code>
          </Fact>
          <Fact term={S.disk}>
            {r
              ? CLOUD_TEXT.usedOf({
                  used: formatBytes(r.usage.diskBytes),
                  cap: formatBytes(r.caps.diskBytes),
                })
              : S.diskUpTo({ mb: c.diskMb })}
          </Fact>
          <Fact term={S.baseImage}>{c.baseImage ?? S.defaultImage}</Fact>
          <Fact term={S.caches}>
            {c.caches.length
              ? fmt.list(c.caches, { type: 'unit', style: 'short' })
              : CLOUD_TEXT.none}
          </Fact>
          <Fact term={S.usedBy}>{S.sessions({ n: e.sessions })}</Fact>
          {r ? (
            <Fact term={S.runningNow}>
              {S.runningNowValue({ runs: r.runs.active, commands: r.processes.running })}
            </Fact>
          ) : null}
          {r?.readyAt ? <Fact term={S.readySince}>{formatWhen(r.readyAt)}</Fact> : null}
        </dl>
      </section>

      <Repositories e={e} />
      <Setup e={e} />
      <CloudSnapshots environmentId={id} disabled={busy} />
      <CloudFiles environmentId={id} start={c.folder} disabled={busy} />
      <CloudRunsList
        query={{ environmentId: id }}
        environments={[e]}
        title={S.runsHere}
        empty={S.runsHereEmpty}
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
        title={S.rebuildTitle({ name: e.label })}
        description={S.rebuildBody}
        confirmLabel={S.rebuildConfirm}
        danger
        errorText={(err) => cloudErrorMessage(err, S.rebuildFailed)}
        onClose={() => setRebuilding(false)}
        onConfirm={async () => {
          const next = await api.rebuildCloudEnvironment(id);
          setRebuilding(false);
          env.setData(() => next);
          announce(S.rebuilding({ name: e.label }));
        }}
      />
      <ConfirmAction
        open={deleting}
        title={S.deleteTitle({ name: e.label })}
        description={S.deleteBody}
        confirmLabel={CLOUD_TEXT.delete}
        danger
        errorText={(err) => cloudErrorMessage(err, S.deleteFailed)}
        onClose={() => setDeleting(false)}
        onConfirm={async () => {
          await api.deleteCloudEnvironment(id);
          setDeleting(false);
          toast.show(S.deleted({ name: e.label }), { tone: 'success' });
          navigate(CLOUD_SETTINGS_PATH);
        }}
      />
    </div>
  );
}

function Repositories({ e }: { e: CloudEnvironmentView }) {
  const headingId = useId();
  const reported = e.runner?.repos ?? [];
  const S = ENVIRONMENT_TEXT.repos;
  return (
    <section className="ws-section" aria-labelledby={headingId}>
      <h3 id={headingId}>{S.heading}</h3>
      {e.connection.repoUrls.length === 0 ? (
        <p className="muted">{S.none}</p>
      ) : (
        <ul className="ws-list" aria-label={S.heading}>
          {e.connection.repoUrls.map((url) => {
            const name = repoName(url);
            const r = reported.find((x) => x.name === name) ?? null;
            return (
              <li key={url} className="ws-list-row" aria-label={name}>
                <span className="cl-row-main">
                  <span className="cl-strong">{name}</span>
                  <code className="ws-code-inline cl-break cl-small" dir="ltr">
                    {url}
                  </code>
                  <span className="muted ws-row-meta">
                    {r ? (
                      <>
                        <span dir="ltr">{r.path}</span>
                        <span>{r.ref ? S.branch({ ref: r.ref }) : S.defaultBranch}</span>
                        {r.head ? <span>{S.at({ commit: r.head.slice(0, 7) })}</span> : null}
                      </>
                    ) : (
                      <span>{S.notCloned}</span>
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
  const S = ENVIRONMENT_TEXT.setup;
  return (
    <section className="ws-section" aria-labelledby={headingId}>
      <h3 id={headingId}>{S.heading}</h3>
      {e.connection.setupScript ? (
        <details className="ws-advanced">
          <summary>{S.script}</summary>
          <TextBlock text={e.connection.setupScript} label={S.script} />
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
            {setupSentence(s)}
            {s.status === 'failed' ? ` ${SETUP_TEXT.fixIt}` : null}
          </span>
        </p>
      ) : (
        <p className="muted">{S.notReported}</p>
      )}
      {s?.log ? <TextBlock text={s.log} label={S.log} /> : null}
    </section>
  );
}
