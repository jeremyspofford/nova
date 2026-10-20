// The cloud run of one thread (a Code session or Work run on a cloud environment; FR-108, FR-116):
// its usage against its caps, live, with Raise caps and Cancel. Before the first command there is
// no run yet, and the view says so. A Code session shows it under its budget; a Work run page shows
// it for a run on a cloud environment (`<ThreadCloudRun threadId=… environmentId={run.environmentId
// ?? null} />`: a run on the Hub, `null`, asks the Hub nothing).
import { defineMessages } from '@nova/i18n';
import type { CloudRunView } from '@nova/shared';
import { Button, Spinner } from '@nova/ui';
import { useCloudApi } from './api.ts';
import { CloudRunCard, useThreadCloudRun } from './CloudRunCard.tsx';
import { rich } from '../i18n/rich.tsx';
import { CLOUD_SETTINGS_PATH, CLOUD_TEXT, cloudErrorMessage, cloudRunPath } from './format.ts';
import { InAppLink, useLoad } from './parts.tsx';

/** A thread's cloud run. */
export const THREAD_RUN_TEXT = defineMessages('cloud.threadRun', {
  loading: 'Loading the cloud run',
  loadingText: 'Loading the cloud run…',
  loadFailed: 'Could not load the cloud run.',
  /** {link} is a link named "Settings → Cloud runner". */
  none: 'No cloud run yet. The first command starts one, with the caps set in {link}.',
  open: 'Open the run’s page',
});

export function ThreadCloudRun({
  threadId,
  environmentId,
  environmentLabel,
  quiet = false,
}: {
  threadId: string;
  /**
   * The cloud environment the thread's run uses (`RunView.environmentId`): null for a run on the
   * Hub (nothing shows, nothing is loaded); undefined when the caller does not know.
   */
  environmentId?: string | null;
  environmentLabel?: string | null;
  /** Show nothing until the thread has a cloud run (when the caller does not know). */
  quiet?: boolean;
}) {
  if (environmentId === null) return null;
  return (
    <ThreadRun
      threadId={threadId}
      environmentId={environmentId}
      environmentLabel={environmentLabel ?? null}
      quiet={quiet}
    />
  );
}

function ThreadRun({
  threadId,
  environmentId,
  environmentLabel,
  quiet,
}: {
  threadId: string;
  environmentId: string | undefined;
  environmentLabel: string | null;
  quiet: boolean;
}) {
  const api = useCloudApi();
  // The environment's name, when the caller knows only its id.
  const env = useLoad(
    () =>
      environmentId && !environmentLabel
        ? api.getCloudEnvironment(environmentId).then((e) => e.label)
        : Promise.resolve(environmentLabel),
    `thread-env:${environmentId ?? ''}:${environmentLabel ?? ''}`,
  );
  const run = useThreadCloudRun(threadId);
  const r: CloudRunView | null = run.data;
  const S = THREAD_RUN_TEXT;
  if (quiet && !r) return null;
  if (run.loading)
    return (
      <p className="muted cl-thread-run">
        <Spinner label={S.loading} /> {S.loadingText}
      </p>
    );
  if (!r)
    return run.error ? (
      <div className="ws-error cl-thread-run" role="alert">
        <p>{cloudErrorMessage(run.error, S.loadFailed)}</p>
        <Button onClick={run.reload}>{CLOUD_TEXT.retry}</Button>
      </div>
    ) : (
      <p className="muted cl-thread-run">
        {rich(S.none, {
          link: <InAppLink to={CLOUD_SETTINGS_PATH}>{CLOUD_TEXT.settingsLink}</InAppLink>,
        })}
      </p>
    );
  return (
    <div className="cl-thread-run">
      <CloudRunCard
        run={r}
        environmentLabel={environmentLabel ?? env.data ?? null}
        onChange={(next) => run.setData(() => next)}
      />
      <InAppLink to={cloudRunPath(r.id)} className="cl-small">
        {S.open}
      </InAppLink>
    </div>
  );
}
