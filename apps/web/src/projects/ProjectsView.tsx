// Projects (FR-034, FR-040): /projects lists them with a New project dialog; /projects/:id is one
// project's chats, instructions and sources. /projects?new=1 opens the dialog (the "New project"
// command uses it).
import { useEffect, useState } from 'react';
import type { ProjectView } from '@nova/shared';
import { defineMessages } from '@nova/i18n';
import { Button, EmptyState, Icon, Spinner, useToast } from '@nova/ui';
import { errorMessage } from '../api.ts';
import { navigate, projectPath, useLocation } from '../router.ts';
import { useServices } from '../services.tsx';
import { formatWhen } from '../settings/common.ts';
import { onProjectsChanged } from './events.ts';
import { NewProjectDialog } from './NewProjectDialog.tsx';
import { ProjectDetail } from './ProjectDetail.tsx';
import '../workspace.css';

export const PROJECTS_TEXT = defineMessages('projects', {
  title: 'Projects',
  new: 'New project',
  intro:
    'A project groups chats, sources and instructions. Its instructions apply to every chat in it.',
  loadFailed: 'Could not load projects.',
  retry: 'Retry',
  loading: 'Loading projects',
  emptyTitle: 'No projects yet',
  emptyBody: 'Create a project to keep related chats, files and instructions together.',
  /** A project card's counts and age: "2 chats · 1 source · updated 5 minutes ago". */
  cardMeta:
    '{chats, plural, one {# chat} other {# chats}} · {sources, plural, one {# source} other {# sources}} · updated {when}',
  created: 'Project “{name}” created.',
});

export function ProjectsView({ projectId }: { projectId: string | null }) {
  return projectId ? <ProjectDetail key={projectId} projectId={projectId} /> : <ProjectList />;
}

function ProjectList() {
  const { api } = useServices();
  const toast = useToast();
  const loc = useLocation();
  const [projects, setProjects] = useState<ProjectView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [version, setVersion] = useState(0);

  // `?new=1` opens the dialog once, then the URL goes back to /projects.
  const wantsNew = new URLSearchParams(loc.slice(loc.indexOf('?') + 1)).get('new') === '1';
  if (wantsNew && loc.includes('?') && !creating) setCreating(true);
  useEffect(() => {
    if (wantsNew) navigate(projectPath(null), { replace: true });
  }, [wantsNew]);

  useEffect(() => {
    let alive = true;
    api.listProjects().then(
      ({ items }) => {
        if (!alive) return;
        setProjects([...items].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)));
        setError(null);
      },
      (err: unknown) => alive && setError(errorMessage(err, PROJECTS_TEXT.loadFailed)),
    );
    return () => {
      alive = false;
    };
  }, [api, version]);
  useEffect(() => onProjectsChanged(() => setVersion((v) => v + 1)), []);

  return (
    <div className="ws-page">
      <header className="ws-page-header">
        <h1>{PROJECTS_TEXT.title}</h1>
        <Button variant="primary" onClick={() => setCreating(true)}>
          <Icon name="plus" /> {PROJECTS_TEXT.new}
        </Button>
      </header>
      <p className="muted">{PROJECTS_TEXT.intro}</p>
      {error ? (
        <div role="alert" className="ws-error">
          <p>{error}</p>
          <Button onClick={() => setVersion((v) => v + 1)}>{PROJECTS_TEXT.retry}</Button>
        </div>
      ) : null}
      {projects === null && !error ? <Spinner label={PROJECTS_TEXT.loading} /> : null}
      {projects?.length === 0 ? (
        <EmptyState
          title={PROJECTS_TEXT.emptyTitle}
          description={PROJECTS_TEXT.emptyBody}
          level={2}
          action={<Button onClick={() => setCreating(true)}>{PROJECTS_TEXT.new}</Button>}
        />
      ) : null}
      {projects?.length ? (
        <ul className="ws-cards" aria-label={PROJECTS_TEXT.title}>
          {projects.map((p) => (
            <li key={p.id} className="ws-card">
              <a
                href={projectPath(p.id)}
                className="ws-card-link"
                dir="auto"
                onClick={(e) => {
                  if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
                  e.preventDefault();
                  navigate(projectPath(p.id));
                }}
              >
                {p.name}
              </a>
              <span className="muted ws-card-meta">
                {PROJECTS_TEXT.cardMeta({
                  chats: p.threadCount,
                  sources: p.sourceCount,
                  when: formatWhen(p.updatedAt),
                })}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
      <NewProjectDialog
        open={creating}
        onClose={() => setCreating(false)}
        onCreated={(p) => {
          setCreating(false);
          toast.show(PROJECTS_TEXT.created({ name: p.name }), { tone: 'success' });
          navigate(projectPath(p.id));
        }}
      />
    </div>
  );
}
