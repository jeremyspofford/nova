// Cloud runs as a list (FR-108, FR-116): each run's kind, environment, status, usage against its
// caps (with "near the cap" and "stopped at a cap" in words) and a link to its page; running and
// capped runs first. Kept current from the run events.
import { useId } from 'react';
import { defineMessages } from '@nova/i18n';
import type { CloudEnvironmentView, CloudRunView } from '@nova/shared';
import { Button, EmptyState, Icon, Spinner } from '@nova/ui';
import { formatWhen } from '../settings/common.ts';
import { useSettings } from '../settings.tsx';
import { useCloudApi, type CloudRunsQuery } from './api.ts';
import { RUN_EVENTS, useCloudEvents, usageFromEvent, eventCloudRunId } from './events.ts';
import {
  CLOUD_TEXT,
  cloudErrorMessage,
  cloudRunPath,
  formatSeconds,
  isLiveRun,
  runStatusSpec,
  usageLines,
} from './format.ts';
import { InAppLink, StateBadge, useLoad } from './parts.tsx';

/** A list of cloud runs. */
export const RUNS_TEXT = defineMessages('cloud.runs', {
  /** A run's name: what it belongs to and its environment's name. */
  name: '{kind, select, code {Code session on {environment}} work {Work run on {environment}} other {The Hub on {environment}}}',
  /** {used} and {cap} are durations, such as "10 min" and "1 h". */
  usage:
    '{resource, select, cpu {CPU time: {used} of {cap}} other {Running time: {used} of {cap}}}',
  capped:
    '{resource, select, cpu {Stopped at its CPU time cap} other {Stopped at its running time cap}}',
  near: '{resource, select, cpu {Near its CPU time cap} other {Near its running time cap}}',
  loadFailed: 'Could not load the runs.',
  loading: 'Loading the runs',
  empty: 'No cloud runs yet',
});

export function sortRuns(items: CloudRunView[]): CloudRunView[] {
  return [...items].sort((a, b) => {
    const live = Number(isLiveRun(b)) - Number(isLiveRun(a));
    return live || (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0);
  });
}

export function CloudRunsList({
  query,
  environments,
  title,
  empty,
}: {
  query: CloudRunsQuery;
  environments: CloudEnvironmentView[];
  title: string;
  empty: string;
}) {
  const api = useCloudApi();
  const headingId = useId();
  const key = JSON.stringify(query);
  const runs = useLoad(() => api.listCloudRuns(query).then((r) => sortRuns(r.items)), key);
  useCloudEvents(
    RUN_EVENTS,
    (env) => {
      if (env.name === 'cloud.run.usage') {
        const u = usageFromEvent(env);
        const id = eventCloudRunId(env);
        if (u && id)
          runs.setData(
            (prev) =>
              prev?.map((r) =>
                r.id === id ? { ...r, usage: u.usage, caps: u.caps ?? r.caps } : r,
              ) ?? null,
          );
        return;
      }
      runs.reload();
    },
    runs.reload,
  );
  const settings = useSettings();
  const warnAt = settings.get('cloud.runner.caps').value.warnAt;
  const label = (id: string) =>
    environments.find((e) => e.id === id)?.label ?? CLOUD_TEXT.removedEnvironment;
  const items = runs.data;
  const S = RUNS_TEXT;
  return (
    <section className="ws-section" aria-labelledby={headingId}>
      <h3 id={headingId}>{title}</h3>
      {runs.error && !items ? (
        <div className="ws-error" role="alert">
          <p>{cloudErrorMessage(runs.error, S.loadFailed)}</p>
          <Button onClick={runs.reload}>{CLOUD_TEXT.retry}</Button>
        </div>
      ) : null}
      {runs.loading ? <Spinner label={S.loading} /> : null}
      {items?.length === 0 ? (
        <EmptyState level={3} title={S.empty} description={empty} icon="server" />
      ) : null}
      {items?.length ? (
        <ul className="ws-list" aria-label={title}>
          {items.map((r) => {
            const lines = usageLines(r, warnAt);
            const flagged = lines.find((l) => l.capped) ?? lines.find((l) => l.warn) ?? null;
            const name = S.name({ kind: r.kind, environment: label(r.environmentId) });
            return (
              <li key={r.id} className="ws-list-row" aria-label={name}>
                <span className="cl-row-main">
                  <span className="cl-row-title">
                    <InAppLink to={cloudRunPath(r.id)} className="cl-strong">
                      {name}
                    </InAppLink>
                    <StateBadge spec={runStatusSpec(r.status)} />
                  </span>
                  <span className="muted ws-row-meta">
                    {lines.map((l) => (
                      <span key={l.resource}>
                        {S.usage({
                          resource: l.resource,
                          used: formatSeconds(l.used),
                          cap: formatSeconds(l.cap),
                        })}
                      </span>
                    ))}
                    <span>{CLOUD_TEXT.started({ when: formatWhen(r.createdAt) })}</span>
                  </span>
                  {flagged ? (
                    <span className="cl-flag" data-state={flagged.capped ? 'capped' : 'warn'}>
                      <Icon name={flagged.capped ? 'stop' : 'alert'} />{' '}
                      {flagged.capped
                        ? S.capped({ resource: flagged.resource })
                        : S.near({ resource: flagged.resource })}
                    </span>
                  ) : null}
                </span>
              </li>
            );
          })}
        </ul>
      ) : null}
    </section>
  );
}
