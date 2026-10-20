// One project (FR-034): rename it, edit the instructions every chat in it receives, open or start
// its chats, manage its sources (FR-040) and its folders on the Hub (FR-035), and delete it.
// Deleting keeps the chats; they leave the project.
import { useEffect, useRef, useState } from 'react';
import type { ProjectView, ThreadView } from '@nova/shared';
import { defineMessages } from '@nova/i18n';
import { Button, Dialog, EmptyState, Icon, Spinner, TextField, useToast } from '@nova/ui';
import { ApiError, errorMessage } from '../api.ts';
import { threadTitle } from '../chat/ThreadList.tsx';
import { chatPath, navigate, projectPath } from '../router.ts';
import { useServices } from '../services.tsx';
import { formatWhen } from '../settings/common.ts';
import { useThreads } from '../stores.tsx';
import { projectsChanged } from './events.ts';
import { MEMORY_SCOPE_TEXT } from './NewProjectDialog.tsx';
import { ProjectFolders } from './ProjectFolders.tsx';
import { SourcesPanel } from './SourcesPanel.tsx';
import { ScopedSiteLevels } from '../browser/SiteLevels.tsx';

export const PROJECT_TEXT = defineMessages('projects.detail', {
  loadFailed: 'Could not load the project.',
  chatsFailed: 'Could not load chats.',
  loading: 'Loading project',
  missingTitle: 'This project no longer exists',
  missingBody: 'It may have been deleted on another device.',
  all: 'All projects',
  retry: 'Retry',
  startFailed: 'Could not start a chat: {reason}',
  deleted: 'Project “{name}” deleted. Its chats are kept.',
  deleteFailed: 'Could not delete the project: {reason}',
  breadcrumb: 'Breadcrumb',
  projects: 'Projects',
  memory:
    'Memory: {scope}. {description} This was chosen when the project was created and cannot be changed.',
  chats: 'Chats',
  newChat: 'New chat in project',
  loadingChats: 'Loading chats',
  noChats: 'No chats in this project yet.',
  chatList: 'Chats in this project',
  updated: 'updated {when}',
  deleteHeading: 'Delete project',
  deleteIntro:
    'Removes the project, its instructions and its sources. Its chats are kept and move out of the project.',
  delete: 'Delete project',
  deleteTitle: 'Delete this project?',
  deleteBody:
    '{sources, plural, one {“{name}” and its # source are removed.} other {“{name}” and its # sources are removed.}} {chats, plural, one {Its # chat is kept and leaves the project.} other {Its # chats are kept and leave the project.}}',
  cancel: 'Cancel',
  enterName: 'Enter a name.',
  renamed: 'Project renamed.',
  renameFailed: 'Could not rename the project.',
  rename: 'Rename',
  name: 'Project name',
  save: 'Save',
  instructionsSaved: 'Instructions saved. They apply to every chat in this project.',
  instructionsFailed: 'Could not save the instructions.',
  instructions: 'Instructions',
  instructionsLabel: 'Instructions for every chat in this project',
  instructionsPlaceholder:
    'For example: You are helping plan the spring fundraiser. Keep answers short.',
  instructionsHint: 'Sent with every chat in the project, including chats already in it.',
  saveInstructions: 'Save instructions',
});

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
        else setLoad({ kind: 'error', message: errorMessage(err, PROJECT_TEXT.loadFailed) });
      },
    );
    api.listThreads({ projectId, limit: 200 }).then(
      (page) => {
        if (!alive) return;
        setChats(page.items.filter((t) => t.projectId === projectId && !t.side));
        setChatsError(null);
      },
      (err: unknown) => alive && setChatsError(errorMessage(err, PROJECT_TEXT.chatsFailed)),
    );
    return () => {
      alive = false;
    };
  }, [api, projectId, version]);

  if (load.kind === 'loading') return <Spinner label={PROJECT_TEXT.loading} />;
  if (load.kind === 'missing') {
    return (
      <div className="ws-page">
        <EmptyState
          title={PROJECT_TEXT.missingTitle}
          description={PROJECT_TEXT.missingBody}
          level={2}
          action={<Button onClick={() => navigate(projectPath(null))}>{PROJECT_TEXT.all}</Button>}
        />
      </div>
    );
  }
  if (load.kind === 'error') {
    return (
      <div className="ws-page" role="alert">
        <p>{load.message}</p>
        <Button onClick={() => setVersion((v) => v + 1)}>{PROJECT_TEXT.retry}</Button>
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
      toast.show(PROJECT_TEXT.startFailed({ reason: errorMessage(err) }), { tone: 'error' });
      setStarting(false);
    }
  };

  const remove = async () => {
    setConfirmDelete(false);
    try {
      await api.deleteProject(project.id);
      projectsChanged();
      void threadsStore.refresh();
      toast.show(PROJECT_TEXT.deleted({ name: project.name }), { tone: 'success' });
      navigate(projectPath(null));
    } catch (err) {
      toast.show(PROJECT_TEXT.deleteFailed({ reason: errorMessage(err) }), { tone: 'error' });
    }
  };

  return (
    <div className="ws-page">
      <nav aria-label={PROJECT_TEXT.breadcrumb} className="ws-breadcrumb">
        <a
          href={projectPath(null)}
          onClick={(e) => {
            e.preventDefault();
            navigate(projectPath(null));
          }}
        >
          <Icon name="back" /> {PROJECT_TEXT.projects}
        </a>
      </nav>
      <ProjectName project={project} onSaved={saved} />
      <p className="muted">
        {PROJECT_TEXT.memory({
          scope: MEMORY_SCOPE_TEXT[project.memoryScope].label,
          description: MEMORY_SCOPE_TEXT[project.memoryScope].description,
        })}
      </p>

      <Instructions project={project} onSaved={saved} />

      <section className="ws-section" aria-labelledby="project-chats">
        <div className="ws-section-header">
          <h2 id="project-chats">{PROJECT_TEXT.chats}</h2>
          <Button variant="primary" onClick={() => void newChat()} disabled={starting}>
            {starting ? <Spinner /> : <Icon name="plus" />} {PROJECT_TEXT.newChat}
          </Button>
        </div>
        {chatsError ? (
          <div role="alert" className="ws-error">
            <p>{chatsError}</p>
            <Button onClick={() => setVersion((v) => v + 1)}>{PROJECT_TEXT.retry}</Button>
          </div>
        ) : null}
        {chats === null && !chatsError ? <Spinner label={PROJECT_TEXT.loadingChats} /> : null}
        {chats?.length === 0 ? <p className="muted">{PROJECT_TEXT.noChats}</p> : null}
        {chats?.length ? (
          <ul className="ws-list" aria-label={PROJECT_TEXT.chatList}>
            {chats.map((t) => (
              <li key={t.id} className="ws-list-row">
                <a
                  href={chatPath(t.id)}
                  dir="auto"
                  onClick={(e) => {
                    if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
                    e.preventDefault();
                    navigate(chatPath(t.id));
                  }}
                >
                  {threadTitle(t)}
                </a>
                <span className="muted ws-row-meta">
                  {PROJECT_TEXT.updated({ when: formatWhen(t.updatedAt) })}
                </span>
              </li>
            ))}
          </ul>
        ) : null}
      </section>

      <SourcesPanel projectId={project.id} onChanged={projectsChanged} />

      <ProjectFolders projectId={project.id} onChanged={projectsChanged} />
      {/* This project's own site permission levels for the agent browser (FR-094, M7). */}
      <ScopedSiteLevels scopeKind="project" scopeRef={project.id} scopeName={project.name} />

      <section className="ws-section" aria-labelledby="project-delete">
        <h2 id="project-delete">{PROJECT_TEXT.deleteHeading}</h2>
        <p className="muted">{PROJECT_TEXT.deleteIntro}</p>
        <div className="row">
          <Button variant="danger" onClick={() => setConfirmDelete(true)}>
            <Icon name="trash" /> {PROJECT_TEXT.delete}
          </Button>
        </div>
      </section>

      <Dialog
        open={confirmDelete}
        title={PROJECT_TEXT.deleteTitle}
        description={PROJECT_TEXT.deleteBody({
          name: project.name,
          sources: project.sourceCount,
          chats: chats?.length ?? project.threadCount,
        })}
        onClose={() => setConfirmDelete(false)}
        footer={
          <>
            <Button onClick={() => setConfirmDelete(false)}>{PROJECT_TEXT.cancel}</Button>
            <Button variant="danger" onClick={() => void remove()}>
              {PROJECT_TEXT.delete}
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
      setError(PROJECT_TEXT.enterName);
      return;
    }
    if (next === project.name) {
      stop();
      return;
    }
    try {
      onSaved(await api.updateProject(project.id, { name: next }));
      toast.show(PROJECT_TEXT.renamed, { tone: 'success' });
      stop();
    } catch (err) {
      setError(errorMessage(err, PROJECT_TEXT.renameFailed));
    }
  };

  if (!editing) {
    return (
      <header className="ws-page-header">
        <h1 dir="auto">{project.name}</h1>
        <Button
          ref={renameButton}
          variant="ghost"
          onClick={() => {
            setName(project.name);
            setEditing(true);
          }}
        >
          <Icon name="edit" /> {PROJECT_TEXT.rename}
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
        label={PROJECT_TEXT.name}
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
        {PROJECT_TEXT.save}
      </Button>
      <Button onClick={stop}>{PROJECT_TEXT.cancel}</Button>
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
      toast.show(PROJECT_TEXT.instructionsSaved, {
        tone: 'success',
      });
    } catch (err) {
      setError(errorMessage(err, PROJECT_TEXT.instructionsFailed));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="ws-section" aria-labelledby="project-instructions">
      <h2 id="project-instructions">{PROJECT_TEXT.instructions}</h2>
      <div className="nv-field">
        <label className="nv-field-label" htmlFor="project-instructions-text">
          {PROJECT_TEXT.instructionsLabel}
        </label>
        <textarea
          id="project-instructions-text"
          className="nv-input ws-textarea"
          rows={6}
          maxLength={20_000}
          value={text}
          placeholder={PROJECT_TEXT.instructionsPlaceholder}
          aria-describedby="project-instructions-hint"
          onChange={(e) => setDraft({ base: saved, text: e.target.value })}
        />
        <span id="project-instructions-hint" className="nv-field-hint">
          {PROJECT_TEXT.instructionsHint}
        </span>
      </div>
      {error ? (
        <p className="nv-field-error" role="alert">
          {error}
        </p>
      ) : null}
      <div className="row">
        <Button variant="primary" onClick={() => void save()} disabled={!dirty || busy}>
          {busy ? <Spinner /> : null} {PROJECT_TEXT.saveInstructions}
        </Button>
        <Button onClick={() => setDraft(null)} disabled={!dirty || busy}>
          {PROJECT_TEXT.cancel}
        </Button>
      </div>
    </section>
  );
}
