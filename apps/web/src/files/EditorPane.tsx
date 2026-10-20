// Text editor pane (FR-039): a plain textarea with line numbers, its own undo and redo history,
// and Ctrl/Cmd+S to save. Saving passes the Hub's policy gate as `fs.write` from the UI: it can
// wait for an approval (202), and a file that changed since it was opened is refused (409) so
// nothing is overwritten by accident. Unsaved text survives closing the pane for the session.
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import type { FileContentView } from '@nova/shared';
import { defineMessages } from '@nova/i18n';
import { Button, Icon, IconButton, Spinner, spokenKey, spokenKeys } from '@nova/ui';
import { formatBinding } from '../keys.ts';
import { ApiError, errorMessage } from '../api.ts';
import type { FileRef } from '../layout/model.ts';
import { useAnnounce, useServices } from '../services.tsx';
import { openNotifications } from '../workspace-commands.ts';
import { baseName, hasRichPreview, lineCount } from './types.ts';

export const EDITOR_TEXT = defineMessages('files.editor', {
  openFile: 'Open a file from the Files panel to edit it.',
  gone: 'This file no longer exists.',
  openFailed: 'Could not open the file.',
  undone: 'Undone.',
  redone: 'Redone.',
  needsApproval: 'Saving needs approval.',
  saved: 'Saved {name}.',
  conflictAnnounce: 'The file changed on the Hub. Your changes are not saved.',
  notSaved: 'Not saved: {reason}',
  reloaded: 'Reloaded {name}.',
  stillWaiting: 'Still waiting for the approval.',
  retry: 'Retry',
  opening: 'Opening {name}',
  openingDots: 'Opening…',
  notText: '{name} is not a text file, or is too large to edit here.',
  openPreview: 'Open the preview',
  actions: '{name} actions',
  unsaved: '(unsaved)',
  readOnly: 'Read-only',
  undo: 'Undo',
  redo: 'Redo',
  saveTitle: 'Save ({keys})',
  save: 'Save',
  conflict: '{name} changed on the Hub after you opened it. Your changes are not saved yet.',
  reload: 'Reload and discard my changes',
  overwrite: 'Save mine anyway',
  approval:
    'Saving {name} needs approval. Approve it in the notification center, then check again.',
  showNotifications: 'Show notifications',
  checkAgain: 'Check again',
  contents: 'Contents of {name}',
  readOnlyHelp: 'Read-only.',
  help: '{save} saves. {undo} undoes, {redo} redoes.',
  saving: 'Saving…',
  savedStatus: 'Saved.',
});

/** Unsaved edits per file for this session, so closing a pane never loses them. */
interface EditorDraft {
  text: string;
  /** The Hub version the edits started from. */
  base: string;
}
const drafts = new Map<string, EditorDraft>();
const draftKey = (f: FileRef) => `${f.root}::${f.path}`;

/** Forget all unsaved editor text (tests). */
export function clearEditorDrafts(): void {
  drafts.clear();
}

export interface History {
  past: string[];
  future: string[];
  /** When the last entry was pushed, to group fast typing into one step. */
  at: number;
}

export const EMPTY_HISTORY: History = { past: [], future: [], at: 0 };
const GROUP_MS = 600;
const HISTORY_LIMIT = 200;

/** Record `before` as an undo step unless it continues the step being typed. */
export function pushHistory(h: History, before: string, now: number): History {
  if (now - h.at < GROUP_MS && h.past.length) return { ...h, future: [], at: now };
  return { past: [...h.past, before].slice(-HISTORY_LIMIT), future: [], at: now };
}

export function undo(h: History, current: string): { history: History; text: string } | null {
  const text = h.past.at(-1);
  if (text === undefined) return null;
  return { history: { past: h.past.slice(0, -1), future: [current, ...h.future], at: 0 }, text };
}

export function redo(h: History, current: string): { history: History; text: string } | null {
  const [text, ...future] = h.future;
  if (text === undefined) return null;
  return { history: { past: [...h.past, current], future, at: 0 }, text };
}

type SaveState =
  | { kind: 'idle' }
  | { kind: 'saving' }
  | { kind: 'saved' }
  | { kind: 'conflict' }
  | { kind: 'approval'; approvalId: string }
  | { kind: 'error'; message: string };

export interface EditorPaneProps {
  file: FileRef | null;
  mac: boolean;
  onPreview?: (file: FileRef) => void;
}

export function EditorPane({ file, mac, onPreview }: EditorPaneProps) {
  if (!file) return <p className="muted pane-note">{EDITOR_TEXT.openFile}</p>;
  return <Editor key={draftKey(file)} file={file} mac={mac} onPreview={onPreview} />;
}

function Editor({ file, mac, onPreview }: { file: FileRef } & Omit<EditorPaneProps, 'file'>) {
  const { api } = useServices();
  const announce = useAnnounce();
  const id = useId();
  const [content, setContent] = useState<FileContentView | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [text, setText] = useState('');
  /** The text the Hub has, to tell whether there are unsaved changes. */
  const [saved, setSaved] = useState('');
  const [base, setBase] = useState<string | null>(null);
  const [history, setHistory] = useState<History>(EMPTY_HISTORY);
  const [save, setSave] = useState<SaveState>({ kind: 'idle' });
  const [attempt, setAttempt] = useState(0);
  const area = useRef<HTMLTextAreaElement>(null);
  const gutter = useRef<HTMLDivElement>(null);
  const key = draftKey(file);

  const apply = useCallback(
    (view: FileContentView, keepDraft: boolean) => {
      setContent(view);
      setSaved(view.text ?? '');
      const draft = keepDraft ? drafts.get(key) : undefined;
      // A draft keeps the version it started from, so saving it over a newer file is a conflict.
      setText(draft?.text ?? view.text ?? '');
      setBase(draft?.base ?? view.sha256);
      if (!keepDraft) drafts.delete(key);
    },
    [key],
  );

  useEffect(() => {
    let alive = true;
    api.readFile(file.root, file.path).then(
      (view) => {
        if (!alive) return;
        apply(view, true);
        setLoadError(null);
      },
      (err: unknown) => {
        if (alive)
          setLoadError(
            err instanceof ApiError && err.status === 404
              ? EDITOR_TEXT.gone
              : errorMessage(err, EDITOR_TEXT.openFailed),
          );
      },
    );
    return () => {
      alive = false;
    };
  }, [api, apply, file.root, file.path, attempt]);

  const dirty = content !== null && text !== saved;
  useEffect(() => {
    if (!content || base === null) return;
    if (dirty) drafts.set(key, { text, base });
    else drafts.delete(key);
  }, [base, content, dirty, key, text]);

  const readOnly = content?.readOnly ?? false;
  const name = baseName(file.path);

  const change = (next: string) => {
    setHistory((h) => pushHistory(h, text, Date.now()));
    setText(next);
    if (save.kind === 'saved' || save.kind === 'error') setSave({ kind: 'idle' });
  };

  const step = (dir: 'undo' | 'redo') => {
    const r = dir === 'undo' ? undo(history, text) : redo(history, text);
    if (!r) return;
    setHistory(r.history);
    setText(r.text);
    announce(dir === 'undo' ? EDITOR_TEXT.undone : EDITOR_TEXT.redone);
  };

  const doSave = async (baseSha: string | null = base) => {
    if (readOnly || save.kind === 'saving') return;
    setSave({ kind: 'saving' });
    try {
      const res = await api.saveFile({
        root: file.root,
        path: file.path,
        text,
        baseSha256: baseSha,
      });
      if ('approvalId' in res) {
        setSave({ kind: 'approval', approvalId: res.approvalId });
        announce(EDITOR_TEXT.needsApproval);
        return;
      }
      setContent(res);
      setSaved(res.text ?? text);
      setBase(res.sha256);
      drafts.delete(key);
      setSave({ kind: 'saved' });
      announce(EDITOR_TEXT.saved({ name }));
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        setSave({ kind: 'conflict' });
        announce(EDITOR_TEXT.conflictAnnounce);
      } else {
        const message = EDITOR_TEXT.notSaved({ reason: errorMessage(err) });
        setSave({ kind: 'error', message });
        announce(message);
      }
    }
  };

  /** Save over a newer version on purpose, after a conflict. */
  const overwrite = async () => {
    try {
      const latest = await api.readFile(file.root, file.path);
      await doSave(latest.sha256);
    } catch (err) {
      setSave({ kind: 'error', message: EDITOR_TEXT.notSaved({ reason: errorMessage(err) }) });
    }
  };

  const reload = () => {
    drafts.delete(key);
    setSave({ kind: 'idle' });
    setHistory(EMPTY_HISTORY);
    api.readFile(file.root, file.path).then(
      (view) => {
        apply(view, false);
        announce(EDITOR_TEXT.reloaded({ name }));
      },
      (err: unknown) => setSave({ kind: 'error', message: errorMessage(err) }),
    );
  };

  /** After an approval: the save is done when the Hub has our text. */
  const checkApproval = () => {
    api.readFile(file.root, file.path).then(
      (view) => {
        if (view.text === text) {
          setContent(view);
          setSaved(text);
          setBase(view.sha256);
          drafts.delete(key);
          setSave({ kind: 'saved' });
          announce(EDITOR_TEXT.saved({ name }));
        } else {
          announce(EDITOR_TEXT.stillWaiting);
        }
      },
      (err: unknown) => setSave({ kind: 'error', message: errorMessage(err) }),
    );
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    const mod = mac ? e.metaKey : e.ctrlKey;
    if (!mod || e.altKey) return;
    const k = e.key.toLowerCase();
    if (k === 's') {
      e.preventDefault();
      e.stopPropagation();
      void doSave();
    } else if (k === 'z' && !e.shiftKey) {
      e.preventDefault();
      step('undo');
    } else if ((k === 'z' && e.shiftKey) || (k === 'y' && !mac)) {
      e.preventDefault();
      step('redo');
    }
  };

  if (loadError)
    return (
      <div className="pane-note" role="alert">
        <p>{loadError}</p>
        <Button onClick={() => setAttempt((n) => n + 1)}>{EDITOR_TEXT.retry}</Button>
      </div>
    );
  if (!content)
    return (
      <p className="muted pane-note">
        <Spinner label={EDITOR_TEXT.opening({ name })} /> {EDITOR_TEXT.openingDots}
      </p>
    );
  if (content.text === null)
    return (
      <div className="pane-note">
        <p>{EDITOR_TEXT.notText({ name })}</p>
        {onPreview ? (
          <Button onClick={() => onPreview(file)}>{EDITOR_TEXT.openPreview}</Button>
        ) : null}
      </div>
    );

  const lines = lineCount(text);
  // Key caps with the modifiers named in the active locale ("Ctrl+S", "⌘S").
  const caps = (binding: string) =>
    formatBinding(binding, mac)
      .map(spokenKey)
      .join(mac ? '' : '+');
  const spoken = (binding: string) => spokenKeys(formatBinding(binding, mac));
  return (
    <div className="editor" data-dirty={dirty || undefined}>
      <div className="editor-bar" role="toolbar" aria-label={EDITOR_TEXT.actions({ name })}>
        <span className="editor-file" title={file.path} dir="auto">
          {name}
          {dirty ? <span className="editor-dirty"> {EDITOR_TEXT.unsaved}</span> : null}
        </span>
        {readOnly ? <span className="muted">{EDITOR_TEXT.readOnly}</span> : null}
        <span className="editor-spacer" />
        <IconButton
          label={EDITOR_TEXT.undo}
          icon={<Icon name="undo" />}
          variant="ghost"
          disabled={!history.past.length}
          onClick={() => step('undo')}
        />
        <IconButton
          label={EDITOR_TEXT.redo}
          icon={<Icon name="redo" />}
          variant="ghost"
          disabled={!history.future.length}
          onClick={() => step('redo')}
        />
        {onPreview && hasRichPreview(content.mime, file.path) ? (
          <IconButton
            label={EDITOR_TEXT.openPreview}
            icon={<Icon name="eye" />}
            variant="ghost"
            onClick={() => onPreview(file)}
          />
        ) : null}
        {readOnly ? null : (
          <Button
            variant={dirty ? 'primary' : 'default'}
            disabled={save.kind === 'saving' || (!dirty && save.kind !== 'conflict')}
            aria-keyshortcuts={mac ? 'Meta+S' : 'Control+S'}
            title={EDITOR_TEXT.saveTitle({ keys: caps('mod+s') })}
            onClick={() => void doSave()}
          >
            {save.kind === 'saving' ? <Spinner /> : <Icon name="save" />} {EDITOR_TEXT.save}
          </Button>
        )}
      </div>
      {save.kind === 'conflict' ? (
        <div className="editor-alert" role="alert">
          <p>
            <Icon name="alert" /> {EDITOR_TEXT.conflict({ name })}
          </p>
          <Button onClick={reload}>{EDITOR_TEXT.reload}</Button>
          <Button variant="danger" onClick={() => void overwrite()}>
            {EDITOR_TEXT.overwrite}
          </Button>
        </div>
      ) : null}
      {save.kind === 'approval' ? (
        <div className="editor-alert" role="note">
          <p>
            <Icon name="hand" /> {EDITOR_TEXT.approval({ name })}
          </p>
          <Button onClick={openNotifications}>{EDITOR_TEXT.showNotifications}</Button>
          <Button onClick={checkApproval}>{EDITOR_TEXT.checkAgain}</Button>
        </div>
      ) : null}
      {save.kind === 'error' ? (
        <p className="editor-alert" role="alert">
          <Icon name="alert" /> {save.message}
        </p>
      ) : null}
      <div className="editor-body" dir="ltr">
        <div ref={gutter} className="editor-gutter" aria-hidden="true">
          {Array.from({ length: lines }, (_, i) => (
            <div key={i}>{i + 1}</div>
          ))}
        </div>
        <label htmlFor={`${id}-text`} className="nv-vh">
          {EDITOR_TEXT.contents({ name })}
        </label>
        <textarea
          id={`${id}-text`}
          ref={area}
          className="editor-text"
          data-pane-focus
          value={text}
          readOnly={readOnly}
          spellCheck={false}
          wrap="off"
          aria-describedby={`${id}-help`}
          onChange={(e) => change(e.target.value)}
          onKeyDown={onKeyDown}
          onScroll={(e) => {
            if (gutter.current) gutter.current.scrollTop = e.currentTarget.scrollTop;
          }}
        />
        <span id={`${id}-help`} className="nv-vh">
          {readOnly
            ? EDITOR_TEXT.readOnlyHelp
            : EDITOR_TEXT.help({
                save: spoken('mod+s'),
                undo: spoken('mod+z'),
                redo: spoken(mac ? 'mod+shift+z' : 'mod+y'),
              })}
        </span>
      </div>
      <p className="muted editor-status" role="status">
        {save.kind === 'saving'
          ? EDITOR_TEXT.saving
          : save.kind === 'saved'
            ? EDITOR_TEXT.savedStatus
            : ''}
      </p>
    </div>
  );
}
