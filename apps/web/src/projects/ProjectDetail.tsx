// One project (FR-034): rename it, edit the instructions every chat in it receives, open or start
// its chats, manage its sources (FR-040), and delete it. Deleting keeps the chats; they leave the
// project.
import { useEffect, useRef, useState } from 'react';
import type { ProjectView, ThreadView } from '@nova/shared';
import { Button, Dialog, EmptyState, Icon, Spinner, TextField, useToast } from '@nova/ui';
import { ApiError, errorMessage } from '../api.ts';
import { threadTitle } from '../chat/ThreadList.tsx';
import { chatPath, navigate, projectPath } from '../router.ts';
import { useServices } from '../services.tsx';
import { formatWhen, plural } from '../settings/common.ts';
import { useThreads } from '../stores.tsx';
import { projectsChanged } from './events.ts';
import { MEMORY_SCOPE_TEXT } from './NewProjectDialog.tsx';
import { SourcesPanel } from './SourcesPanel.tsx';

type Load =
  | { kind: 'loading' }
  | { kind: 'missing' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; project: ProjectView };

export function ProjectDetail({ projectId }: { projectId: string }) {
  const { api } = useServices();
  const threadsStore = useThreads();
  const toast = useToast();
  const [load, setLoad] = useState<Load>({ kind: 'loading' });
  const [chats, setChats] = useState<ThreadView[] | null>(null);
  const [chatsError, setChatsError] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [starting, setStarting] = useState(false);

  useEffect(() => {
    let alive = true;
    api.getProject(projectId).then(
      (project) => alive && setLoad({ kind: 'ready', project }),
      (err: unknown) => {
        if (!alive) return;
        if (err instanceof ApiError && err.status === 404) setLoad({ kind: 'missing' });
        else setLoad({ kind: 'error', message: errorMessage(err, 'Could not load the project.') });
      },
    );
    api.listThreads({ projectId, limit: 200 }).then(
      (page) => {
        if (!alive) return;
        setChats(page.items.filter((t) => t.projectId === projectId && !t.side));
        setChatsError(null);
      },
      (err: unknown) => alive && setChatsError(errorMessage(err, 'Could not load chats.')),
    );
    return () => {
      alive = false;
    };
  }, [api, projectId, version]);

  if (load.kind === 'loading') return <Spinner label="Loading project" />;
  if (load.kind === 'missing') {
    return (
      <div className="ws-page">
        <EmptyState
          title="This project no longer exists"
          description="It may have been deleted on another device."
          level={2}
          action={<Button onClick={() => navigate(projectPath(null))}>All projects</Button>}
        />
      </div>
    );
  }
  if (load.kind === 'error') {
    return (
      <div className="ws-page" role="alert">
        <p>{load.message}</p>
        <Button onClick={() => setVersion((v) => v + 1)}>Retry</Button>
      </div>
    );
  }

  const project = load.project;
  const saved = (p: ProjectView) => {
    setLoad({ kind: 'ready', project: p });
    projectsChanged();
  };

  const newChat = async () => {
    setStarting(true);
    try {
      const t = await api.createThread({ mode: 'chat', projectId: project.id });
      threadsStore.upsertLocal(t);
      projectsChanged();
      navigate(chatPath(t.id));
    } catch (err) {
      toast.show(`Could not start a chat: ${errorMessage(err)}`, { tone: 'error' });
      setStarting(false);
    }
  };

  const remove = async () => {
    setConfirmDelete(false);
    try {
      await api.deleteProject(project.id);
      projectsChanged();
      void threadsStore.refresh();
      toast.show(`Project “${project.name}” deleted. Its chats are kept.`, { tone: 'success' });
      navigate(projectPath(null));
    } catch (err) {
      toast.show(`Could not delete the project: ${errorMessage(err)}`, { tone: 'error' });
    }
  };

  return (
    <div className="ws-page">
      <nav aria-label="Breadcrumb" className="ws-breadcrumb">
        <a
          href={projectPath(null)}
          onClick={(e) => {
            e.preventDefault();
            navigate(projectPath(null));
          }}
        >
          <Icon name="back" /> Projects
        </a>
      </nav>
      <ProjectName project={project} onSaved={saved} />
      <p className="muted">
        Memory: {MEMORY_SCOPE_TEXT[project.memoryScope].label}.{' '}
        {MEMORY_SCOPE_TEXT[project.memoryScope].description} This was chosen when the project was
        created and cannot be changed.
      </p>

      <Instructions project={project} onSaved={saved} />

      <section className="ws-section" aria-labelledby="project-chats">
        <div className="ws-section-header">
          <h2 id="project-chats">Chats</h2>
          <Button variant="primary" onClick={() => void newChat()} disabled={starting}>
            {starting ? <Spinner /> : <Icon name="plus" />} New chat in project
          </Button>
        </div>
        {chatsError ? (
          <div role="alert" className="ws-error">
            <p>{chatsError}</p>
            <Button onClick={() => setVersion((v) => v + 1)}>Retry</Button>
          </div>
        ) : null}
        {chats === null && !chatsError ? <Spinner label="Loading chats" /> : null}
        {chats?.length === 0 ? <p className="muted">No chats in this project yet.</p> : null}
        {chats?.length ? (
          <ul className="ws-list" aria-label="Chats in this project">
            {chats.map((t) => (
              <li key={t.id} className="ws-list-row">
                <a
                  href={chatPath(t.id)}
                  onClick={(e) => {
                    if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
                    e.preventDefault();
                    navigate(chatPath(t.id));
                  }}
                >
                  {threadTitle(t)}
                </a>
                <span className="muted ws-row-meta">updated {formatWhen(t.updatedAt)}</span>
              </li>
            ))}
          </ul>
        ) : null}
      </section>

      <SourcesPanel projectId={project.id} onChanged={projectsChanged} />

      <section className="ws-section" aria-labelledby="project-delete">
        <h2 id="project-delete">Delete project</h2>
        <p className="muted">
          Removes the project, its instructions and its sources. Its chats are kept and move out of
          the project.
        </p>
        <div className="row">
          <Button variant="danger" onClick={() => setConfirmDelete(true)}>
            <Icon name="trash" /> Delete project
          </Button>
        </div>
      </section>

      <Dialog
        open={confirmDelete}
        title="Delete this project?"
        description={`“${project.name}” and its ${plural(project.sourceCount, 'source')} are removed. Its ${plural(chats?.length ?? project.threadCount, 'chat')} are kept and leave the project.`}
        onClose={() => setConfirmDelete(false)}
        footer={
          <>
            <Button onClick={() => setConfirmDelete(false)}>Cancel</Button>
            <Button variant="danger" onClick={() => void remove()}>
              Delete project
            </Button>
          </>
        }
      />
    </div>
  );
}

function ProjectName({
  project,
  onSaved,
}: {
  project: ProjectView;
  onSaved: (p: ProjectView) => void;
}) {
  const { api } = useServices();
  const toast = useToast();
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(project.name);
  const [error, setError] = useState<string | null>(null);
  const renameButton = useRef<HTMLButtonElement>(null);
  const refocus = useRef(false);
  // The Rename button is re-created when editing ends; focus it once it exists.
  useEffect(() => {
    if (editing || !refocus.current) return;
    refocus.current = false;
    renameButton.current?.focus();
  }, [editing]);

  const stop = () => {
    refocus.current = true;
    setEditing(false);
    setError(null);
  };

  const save = async () => {
    const next = name.trim();
    if (!next) {
      setError('Enter a name.');
      return;
    }
    if (next === project.name) {
      stop();
      return;
    }
    try {
      onSaved(await api.updateProject(project.id, { name: next }));
      toast.show('Project renamed.', { tone: 'success' });
      stop();
    } catch (err) {
      setError(errorMessage(err, 'Could not rename the project.'));
    }
  };

  if (!editing) {
    return (
      <header className="ws-page-header">
        <h1>{project.name}</h1>
        <Button
          ref={renameButton}
          variant="ghost"
          onClick={() => {
            setName(project.name);
            setEditing(true);
          }}
        >
          <Icon name="edit" /> Rename
        </Button>
      </header>
    );
  }
  return (
    <form
      className="row ws-rename"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <TextField
        label="Project name"
        value={name}
        maxLength={200}
        autoFocus
        error={error ?? undefined}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault();
            stop();
          }
        }}
      />
      <Button type="submit" variant="primary">
        Save
      </Button>
      <Button onClick={stop}>Cancel</Button>
    </form>
  );
}

function Instructions({
  project,
  onSaved,
}: {
  project: ProjectView;
  onSaved: (p: ProjectView) => void;
}) {
  const { api } = useServices();
  const toast = useToast();
  const saved = project.instructions ?? '';
  const [draft, setDraft] = useState<{ base: string; text: string } | null>(null);
  // A draft belongs to the saved text it was typed against; a newer saved text discards it.
  const text = draft && draft.base === saved ? draft.text : saved;
  const dirty = text !== saved;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const p = await api.updateProject(project.id, { instructions: text.trim() ? text : null });
      setDraft(null);
      onSaved(p);
      toast.show('Instructions saved. They apply to every chat in this project.', {
        tone: 'success',
      });
    } catch (err) {
      setError(errorMessage(err, 'Could not save the instructions.'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="ws-section" aria-labelledby="project-instructions">
      <h2 id="project-instructions">Instructions</h2>
      <div className="nv-field">
        <label className="nv-field-label" htmlFor="project-instructions-text">
          Instructions for every chat in this project
        </label>
        <textarea
          id="project-instructions-text"
          className="nv-input ws-textarea"
          rows={6}
          maxLength={20_000}
          value={text}
          placeholder="For example: You are helping plan the spring fundraiser. Keep answers short."
          aria-describedby="project-instructions-hint"
          onChange={(e) => setDraft({ base: saved, text: e.target.value })}
        />
        <span id="project-instructions-hint" className="nv-field-hint">
          Sent with every chat in the project, including chats already in it.
        </span>
      </div>
      {error ? (
        <p className="nv-field-error" role="alert">
          {error}
        </p>
      ) : null}
      <div className="row">
        <Button variant="primary" onClick={() => void save()} disabled={!dirty || busy}>
          {busy ? <Spinner /> : null} Save instructions
        </Button>
        <Button onClick={() => setDraft(null)} disabled={!dirty || busy}>
          Cancel
        </Button>
      </div>
    </section>
  );
}
