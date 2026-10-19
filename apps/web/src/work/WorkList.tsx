// The Work list (FR-051, FR-215; docs/04 §1, §2.3): every run with its status chip, title,
// project, last update and budget use. Needs input sorts first, then Blocked, Running and Ready.
// It follows run events on the shared stream. `/work?new=1` opens the New run dialog.
import { useEffect, useState } from 'react';
import type { ProjectView, RunView } from '@nova/shared';
import { Button, EmptyState, Icon, RadioGroup, Spinner, StatusChip, useToast } from '@nova/ui';
import { errorMessage } from '../api.ts';
import { navigate, useLocation } from '../router.ts';
import { useServices } from '../services.tsx';
import { formatWhen } from '../settings/common.ts';
import { useDebounced, useWorkEvents } from './events.ts';
import { runPath, runStatusLine, sortByStatus, usageLine } from './format.ts';
import { followLink, WorkNav } from './nav.tsx';
import { NewRunDialog } from './NewRunDialog.tsx';
import '../workspace.css';
import './work.css';
import { NewCloudWorkButton } from '../cloud/NewCloudWork.tsx';

export function WorkList() {
  const { api } = useServices();
  const toast = useToast();
  const loc = useLocation();
  const [filter, setFilter] = useState<'all' | 'active'>('all');
  const [runs, setRuns] = useState<RunView[] | null>(null);
  const [projects, setProjects] = useState<ProjectView[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  const [creating, setCreating] = useState(false);

  // `?new=1` opens the dialog once, then the URL goes back to /work.
  const wantsNew = new URLSearchParams(loc.slice(loc.indexOf('?') + 1)).get('new') === '1';
  if (wantsNew && loc.includes('?') && !creating) setCreating(true);
  useEffect(() => {
    if (wantsNew) navigate('/work', { replace: true });
  }, [wantsNew]);

  useEffect(() => {
    let alive = true;
    api.listRuns({ status: filter }).then(
      ({ items }) => {
        if (!alive) return;
        setRuns(items);
        setError(null);
      },
      (err: unknown) => alive && setError(errorMessage(err, 'Could not load runs.')),
    );
    return () => {
      alive = false;
    };
  }, [api, filter, version]);

  useEffect(() => {
    let alive = true;
    api.listProjects().then(
      ({ items }) => alive && setProjects(items),
      () => undefined, // project names are a nicety; the list works without them
    );
    return () => {
      alive = false;
    };
  }, [api]);

  const reload = useDebounced(() => setVersion((v) => v + 1), 150);
  useWorkEvents((env) => {
    if (env.name.startsWith('run.') || env.name === 'thread.status.changed') reload();
  }, reload);

  const projectName = (id: string | null) =>
    id ? (projects.find((p) => p.id === id)?.name ?? null) : null;
  const shown = runs ? sortByStatus(runs) : null;

  return (
    <div className="ws-page work-page">
      <header className="ws-page-header">
        <h1>Work</h1>
        <Button variant="primary" onClick={() => setCreating(true)}>
          <Icon name="plus" /> New run
        </Button>
        <NewCloudWorkButton />
      </header>
      <WorkNav current="runs" />
      <p className="muted ws-flush">
        A run works through a multi-step task on its own, within the budgets you set, and asks you
        when it needs a decision.
      </p>
      <RadioGroup
        legend="Show"
        name="work-filter"
        className="work-filter"
        value={filter}
        onChange={(v) => setFilter(v === 'active' ? 'active' : 'all')}
        options={[
          { value: 'all', label: 'All runs' },
          { value: 'active', label: 'Active runs' },
        ]}
      />
      {error ? (
        <div role="alert" className="ws-error">
          <p>{error}</p>
          <Button onClick={() => setVersion((v) => v + 1)}>Retry</Button>
        </div>
      ) : null}
      {shown === null && !error ? <Spinner label="Loading runs" /> : null}
      {shown?.length === 0 ? (
        filter === 'active' ? (
          <EmptyState
            title="No active runs"
            description="Runs that are planning, working, waiting or paused show here."
            level={2}
            action={<Button onClick={() => setFilter('all')}>Show all runs</Button>}
          />
        ) : (
          <EmptyState
            title="No runs yet"
            description="Start a run to hand off a multi-step task, such as summarizing a report and saving it as a document."
            icon="work"
            level={2}
            action={<Button onClick={() => setCreating(true)}>Start a run</Button>}
          />
        )
      ) : null}
      {shown?.length ? (
        <ul className="ws-list" aria-label="Runs">
          {shown.map((r) => {
            const project = projectName(r.projectId);
            return (
              <li key={r.id} className="ws-list-row work-row">
                <div className="work-row-main">
                  <a
                    href={runPath(r.id)}
                    className="ws-card-link"
                    onClick={(e) => followLink(e, runPath(r.id))}
                  >
                    {r.title}
                  </a>
                  <span className="muted ws-row-meta">
                    {r.status === 'running' && r.derived.status === 'running' ? null : (
                      <span>{runStatusLine(r)}</span>
                    )}
                    {project ? (
                      <span>
                        <Icon name="folder" /> {project}
                      </span>
                    ) : null}
                    <span>Updated {formatWhen(r.updatedAt)}</span>
                    <span>{usageLine(r.used, r.budgets)}</span>
                  </span>
                </div>
                <StatusChip status={r.derived.status} reason={r.derived.reason ?? undefined} />
              </li>
            );
          })}
        </ul>
      ) : null}
      <NewRunDialog
        open={creating}
        projects={projects}
        onClose={() => setCreating(false)}
        onCreated={(r) => {
          setCreating(false);
          toast.show(`Run “${r.title}” created.`, { tone: 'success' });
          navigate(runPath(r.id));
        }}
      />
    </div>
  );
}
