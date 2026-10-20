// New task from a phone (FR-077, FR-111; docs/13 §5 "From a phone: start a task"): a minimal sheet
// to start a Work run or a Code session with a project and instructions, then follow it on the
// phone and review it on a computer later. A Work run takes the instructions as its objective
// (`POST /runs`); a Code session needs a project folder (`POST /code/sessions`), and the
// instructions go to it as its first message. Full options (budgets, models, environments) stay in
// the Work and Code views. On narrow screens the sheet fills the bottom of the screen.
import { useEffect, useId, useState, type FormEvent } from 'react';
import type { ProjectFolderView, ProjectView } from '@nova/shared';
import { defineMessages } from '@nova/i18n';
import { Button, Dialog, RadioGroup, SelectField, Spinner, useToast } from '@nova/ui';
import { errorMessage } from '../api.ts';
import { sessionPath } from '../code/labels.ts';
import { navigate } from '../router.ts';
import { useServices } from '../services.tsx';
import { runPath } from '../work/format.ts';
import './dispatch.css';

export type TaskKind = 'work' | 'code';

export interface StartedTask {
  kind: TaskKind;
  id: string;
  path: string;
}

const NO_PROJECT = '';

/** The New task sheet's words (FR-016). Project names, folder paths and Hub errors are data. */
export const NEW_TASK_TEXT = defineMessages('dispatch.newTask', {
  title: 'New task',
  description: 'Start it here and review the result on a computer later.',
  cancel: 'Cancel',
  start: 'Start',
  kind: 'Kind',
  work: {
    label: 'Work run',
    description: 'A multi-step task it works through on its own, within its budgets.',
  },
  code: {
    label: 'Code session',
    description: 'Changes in a project folder, with a diff to review.',
  },
  retry: 'Retry',
  loading: 'Loading projects',
  loadFailed: 'Could not load your projects.',
  project: 'Project',
  noProject: 'No project',
  choose: 'Choose…',
  noFolder:
    'No project has a folder yet. On a computer, open Projects, choose a project and add a ' +
    'folder; then start Code sessions from here.',
  folder: 'Folder',
  folderIs: 'Folder:',
  instructions: 'What should it do?',
  workHint: 'The run’s goal, for example “Summarize this week’s support tickets into a report”.',
  codeHint: 'The first message of the session, for example “Fix the failing date tests”.',
  needText: 'Say what the task should do.',
  needFolder: 'Choose a project with a folder for the Code session.',
  runStarted: 'Run “{title}” started.',
  codeStarted: 'Code session started.',
  notSent:
    'The Code session started, but your instructions were not sent: {error} Send them in the session.',
  failed: 'The task did not start: {error}',
});

export function NewTaskSheet({
  open,
  onClose,
  onStarted,
}: {
  open: boolean;
  onClose: () => void;
  /** After the task started (the sheet has navigated to it). */
  onStarted?: (t: StartedTask) => void;
}) {
  return open ? <NewTaskForm onClose={onClose} onStarted={onStarted} /> : null;
}

function NewTaskForm({
  onClose,
  onStarted,
}: {
  onClose: () => void;
  onStarted?: (t: StartedTask) => void;
}) {
  const { api } = useServices();
  const toast = useToast();
  const id = useId();
  const [kind, setKind] = useState<TaskKind>('work');
  const [projects, setProjects] = useState<ProjectView[] | null>(null);
  const [folders, setFolders] = useState<Map<string, ProjectFolderView[]>>(new Map());
  const [loadError, setLoadError] = useState<string | null>(null);
  const [projectId, setProjectId] = useState(NO_PROJECT);
  const [folderId, setFolderId] = useState('');
  const [text, setText] = useState('');
  const [textError, setTextError] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let alive = true;
    api.listProjects().then(
      async ({ items }) => {
        // Code needs a folder: learn each project's folders (a phone has few projects).
        const pairs = await Promise.all(
          items.map(async (p) => {
            const list = await api
              .listProjectFolders(p.id)
              .then((r) => r.items)
              .catch(() => [] as ProjectFolderView[]);
            return [p.id, list] as const;
          }),
        );
        if (!alive) return;
        setProjects(items);
        setFolders(new Map(pairs));
        setLoadError(null);
      },
      (err: unknown) => alive && setLoadError(errorMessage(err, NEW_TASK_TEXT.loadFailed)),
    );
    return () => {
      alive = false;
    };
  }, [api, attempt]);

  const withFolders = (projects ?? []).filter((p) => (folders.get(p.id)?.length ?? 0) > 0);
  const choices = kind === 'code' ? withFolders : (projects ?? []);
  const project = choices.find((p) => p.id === projectId) ?? null;
  const projectFolders = project ? (folders.get(project.id) ?? []) : [];
  const folder =
    projectFolders.find((f) => f.id === folderId) ??
    projectFolders.find((f) => f.access === 'write') ??
    projectFolders[0] ??
    null;
  const noFolder = kind === 'code' && projects !== null && withFolders.length === 0;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    const instructions = text.trim();
    if (!instructions) {
      setTextError(NEW_TASK_TEXT.needText);
      return;
    }
    if (kind === 'code' && !folder) {
      setFailure(NEW_TASK_TEXT.needFolder);
      return;
    }
    setTextError(null);
    setFailure(null);
    setBusy(true);
    try {
      if (kind === 'work') {
        const run = await api.createRun({
          objective: instructions,
          ...(project ? { projectId: project.id } : {}),
        });
        toast.show(NEW_TASK_TEXT.runStarted({ title: run.title }), { tone: 'success' });
        const path = runPath(run.id);
        navigate(path);
        onStarted?.({ kind, id: run.id, path });
      } else if (folder) {
        const s = await api.createCodeSession({
          folder: folder.path,
          ...(project ? { projectId: project.id } : {}),
        });
        try {
          await api.sendMessage(s.threadId, { text: instructions });
          toast.show(NEW_TASK_TEXT.codeStarted, { tone: 'success' });
        } catch (err) {
          // The session exists; say so and keep the instructions where they can be sent again.
          toast.show(NEW_TASK_TEXT.notSent({ error: errorMessage(err) }), { tone: 'error' });
        }
        const path = sessionPath(s.id);
        navigate(path);
        onStarted?.({ kind, id: s.id, path });
      }
      onClose();
    } catch (err) {
      setFailure(NEW_TASK_TEXT.failed({ error: errorMessage(err) }));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open
      title={NEW_TASK_TEXT.title}
      description={NEW_TASK_TEXT.description}
      onClose={onClose}
      className="dispatch-sheet"
      footer={
        <>
          <Button onClick={onClose}>{NEW_TASK_TEXT.cancel}</Button>
          <Button
            type="submit"
            form={`${id}-form`}
            variant="primary"
            disabled={busy || projects === null || noFolder}
          >
            {busy ? <Spinner /> : null} {NEW_TASK_TEXT.start}
          </Button>
        </>
      }
    >
      <form id={`${id}-form`} className="stack" onSubmit={(e) => void submit(e)} noValidate>
        <RadioGroup
          legend={NEW_TASK_TEXT.kind}
          name={`${id}-kind`}
          value={kind}
          onChange={(v) => {
            setKind(v === 'code' ? 'code' : 'work');
            setFailure(null);
          }}
          options={[
            {
              value: 'work',
              label: NEW_TASK_TEXT.work.label,
              description: NEW_TASK_TEXT.work.description,
            },
            {
              value: 'code',
              label: NEW_TASK_TEXT.code.label,
              description: NEW_TASK_TEXT.code.description,
            },
          ]}
        />
        {loadError ? (
          <div role="alert" className="ws-error">
            <p>{loadError}</p>
            <Button onClick={() => setAttempt((n) => n + 1)}>{NEW_TASK_TEXT.retry}</Button>
          </div>
        ) : null}
        {projects === null && !loadError ? <Spinner label={NEW_TASK_TEXT.loading} /> : null}
        {projects !== null && !noFolder ? (
          <SelectField
            label={NEW_TASK_TEXT.project}
            value={project ? project.id : NO_PROJECT}
            onChange={(v) => {
              setProjectId(v);
              setFolderId('');
            }}
            options={[
              ...(kind === 'work' ? [{ value: NO_PROJECT, label: NEW_TASK_TEXT.noProject }] : []),
              ...(kind === 'code' && !project
                ? [{ value: NO_PROJECT, label: NEW_TASK_TEXT.choose }]
                : []),
              ...choices.map((p) => ({ value: p.id, label: p.name })),
            ]}
          />
        ) : null}
        {noFolder ? (
          <p className="ws-warning" role="status">
            {NEW_TASK_TEXT.noFolder}
          </p>
        ) : null}
        {kind === 'code' && projectFolders.length > 1 ? (
          <SelectField
            label={NEW_TASK_TEXT.folder}
            value={folder?.id ?? ''}
            onChange={setFolderId}
            options={projectFolders.map((f) => ({ value: f.id, label: f.path }))}
          />
        ) : null}
        {kind === 'code' && projectFolders.length === 1 && folder ? (
          <p className="muted ws-flush">
            {NEW_TASK_TEXT.folderIs}{' '}
            <code className="ws-code-inline" dir="ltr">
              {folder.path}
            </code>
          </p>
        ) : null}
        <div className="nv-field">
          <label htmlFor={`${id}-text`} className="nv-field-label">
            {NEW_TASK_TEXT.instructions}
          </label>
          <textarea
            id={`${id}-text`}
            className="nv-input ws-textarea"
            rows={5}
            maxLength={8000}
            value={text}
            aria-invalid={textError ? true : undefined}
            aria-describedby={textError ? `${id}-text-error` : `${id}-text-hint`}
            onChange={(e) => {
              setText(e.target.value);
              setTextError(null);
            }}
          />
          {textError ? (
            <span id={`${id}-text-error`} className="nv-field-error" role="alert">
              {textError}
            </span>
          ) : (
            <span id={`${id}-text-hint`} className="nv-field-hint">
              {kind === 'work' ? NEW_TASK_TEXT.workHint : NEW_TASK_TEXT.codeHint}
            </span>
          )}
        </div>
        {failure ? (
          <p role="alert" className="nv-field-error">
            {failure}
          </p>
        ) : null}
      </form>
    </Dialog>
  );
}
