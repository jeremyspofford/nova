// One cloud run at /settings/cloud?run=<id> (FR-108, FR-116): what it belongs to (a Code session
// or Work run, linked), its environment (linked), its usage against its caps live, near-cap and
// capped states with Raise caps, Cancel (asks first), and Keep a file as an artifact of its thread.
import { useEffect, useState } from 'react';
import type { CodeSessionView } from '@nova/shared';
import { Button, Spinner } from '@nova/ui';
import { useServices } from '../services.tsx';
import { formatWhen } from '../settings/common.ts';
import { useCloudApi } from './api.ts';
import { CloudRunCard, useCloudRun } from './CloudRunCard.tsx';
import { CLOUD_SETTINGS_PATH, RUN_KIND, cloudEnvPath, cloudErrorMessage } from './format.ts';
import { BackLink, Fact, InAppLink, useLoad } from './parts.tsx';

export function CloudRunPage({ id }: { id: string }) {
  const api = useCloudApi();
  const { api: hub } = useServices();
  const run = useCloudRun(id);
  const r = run.data;
  const env = useLoad(
    () => (r ? api.getCloudEnvironment(r.environmentId) : Promise.resolve(null)),
    `run-env:${r?.environmentId ?? ''}`,
  );
  // A Code session's run links to its session, named by the session's title.
  const [session, setSession] = useState<CodeSessionView | null>(null);
  const sessionId = r?.kind === 'code' ? (r.sessionId ?? null) : null;
  useEffect(() => {
    if (!sessionId) return;
    let alive = true;
    hub.getCodeSession(sessionId).then(
      (s) => alive && setSession(s),
      () => undefined,
    );
    return () => {
      alive = false;
    };
  }, [hub, sessionId]);

  if (!r)
    return (
      <div className="stack cl-page">
        <BackLink to={CLOUD_SETTINGS_PATH} label="Cloud runner" />
        {run.error ? (
          <div className="ws-error" role="alert">
            <p>{cloudErrorMessage(run.error, 'Could not load the run.')}</p>
            <Button onClick={run.reload}>Retry</Button>
          </div>
        ) : (
          <Spinner label="Loading the run" />
        )}
      </div>
    );

  const envLabel = env.data?.label ?? null;
  return (
    <div className="stack cl-page">
      <BackLink to={CLOUD_SETTINGS_PATH} label="Cloud runner" />
      <CloudRunCard
        run={r}
        headingLevel={2}
        environmentLabel={envLabel}
        onChange={(next) => run.setData(() => next)}
      />
      <dl className="cl-facts">
        <Fact term="For">
          {r.kind === 'work' && r.workRunId ? (
            <InAppLink to={`/work/${encodeURIComponent(r.workRunId)}`}>The Work run</InAppLink>
          ) : r.kind === 'code' && sessionId ? (
            <InAppLink to={`/code/${encodeURIComponent(sessionId)}`}>
              {session?.title ?? 'The Code session'}
            </InAppLink>
          ) : (
            RUN_KIND[r.kind]
          )}
        </Fact>
        <Fact term="Environment">
          {env.data ? (
            <InAppLink to={cloudEnvPath(r.environmentId)}>{env.data.label}</InAppLink>
          ) : (
            'A removed environment'
          )}
        </Fact>
        <Fact term="Started">{formatWhen(r.createdAt)}</Fact>
        <Fact term="Ended">{r.endedAt ? formatWhen(r.endedAt) : 'Not yet'}</Fact>
      </dl>
    </div>
  );
}
