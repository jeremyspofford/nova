// Preview pane (FR-039): Markdown through the reply renderer (no raw HTML), images and SVG as
// images (no script runs in an <img>), PDFs in the browser's viewer, code with the built-in
// highlighter, plain text as text, and other binary files as a download. Raw bytes come from
// /files/raw, which the Hub serves sandboxed and never as a page of this app. File contents are
// untrusted data: nothing here runs them. Apps registered for the file type (MCP Apps, FR-198)
// are offered as "Open with"; the app runs sandboxed in the pane and gets the file in its context.
import { useEffect, useState } from 'react';
import type { FileContentView, UiEntryPointView } from '@nova/shared';
import { Button, CodeBlock, Icon, Spinner } from '@nova/ui';
import { ApiError, errorMessage } from '../api.ts';
import { formatBytes } from '../chat/attachments.ts';
import { Markdown } from '../chat/Markdown.tsx';
import type { FileRef } from '../layout/model.ts';
import { FileApp, useFileApps } from '../apps/AppsView.tsx';
import { useServices } from '../services.tsx';
import { baseName, extensionOf, previewKind } from './types.ts';

export interface PreviewPaneProps {
  file: FileRef | null;
  onEdit?: (file: FileRef) => void;
  /** The chat a file app's tool calls belong to. */
  threadId?: string | null;
}

export function PreviewPane({ file, onEdit, threadId = null }: PreviewPaneProps) {
  if (!file)
    return <p className="muted pane-note">Open a file from the Files panel to preview it.</p>;
  return (
    <Preview key={`${file.root}::${file.path}`} file={file} onEdit={onEdit} threadId={threadId} />
  );
}

function Preview({
  file,
  onEdit,
  threadId,
}: {
  file: FileRef;
  onEdit?: (file: FileRef) => void;
  threadId: string | null;
}) {
  const { api } = useServices();
  const [content, setContent] = useState<FileContentView | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Apps registered for this file type (MCP Apps, FR-198); without them the preview is the same.
  const apps = useFileApps(file.path) ?? [];
  const [app, setApp] = useState<UiEntryPointView | null>(null);
  const [attempt, setAttempt] = useState(0);
  const name = baseName(file.path);
  const ext = extensionOf(file.path);

  useEffect(() => {
    let alive = true;
    api.readFile(file.root, file.path).then(
      (view) => {
        if (!alive) return;
        setContent(view);
        setError(null);
      },
      (err: unknown) => {
        if (alive)
          setError(
            err instanceof ApiError && err.status === 404
              ? 'This file no longer exists.'
              : errorMessage(err, 'Could not open the file.'),
          );
      },
    );
    return () => {
      alive = false;
    };
  }, [api, file.root, file.path, attempt]);

  if (error)
    return (
      <div className="pane-note" role="alert">
        <p>{error}</p>
        <Button onClick={() => setAttempt((n) => n + 1)}>Retry</Button>
      </div>
    );
  if (!content)
    return (
      <p className="muted pane-note">
        <Spinner label={`Opening ${name}`} /> Opening…
      </p>
    );

  const raw = api.rawFileUrl(file.root, file.path);
  const kind = previewKind(content.mime, file.path);
  let body;
  switch (kind) {
    case 'markdown':
      body =
        content.text === null ? (
          <TooLarge />
        ) : (
          <div className="preview-doc">
            <Markdown text={content.text} />
          </div>
        );
      break;
    case 'code':
      body =
        content.text === null ? (
          <TooLarge />
        ) : (
          <CodeBlock code={content.text} language={ext} label={`Code: ${name}`} />
        );
      break;
    case 'text':
      body =
        content.text === null ? (
          <TooLarge />
        ) : (
          <pre className="preview-text" tabIndex={0} aria-label={`Text: ${name}`}>
            {content.text}
          </pre>
        );
      break;
    case 'image':
      body = <img className="preview-image" src={raw} alt={name} />;
      break;
    case 'pdf':
      body = (
        <object className="preview-frame" data={raw} type="application/pdf" aria-label={name}>
          <p>
            This browser cannot show the PDF here.{' '}
            <a href={raw} target="_blank" rel="noopener noreferrer">
              Open the PDF
            </a>
          </p>
        </object>
      );
      break;
    case 'binary':
      body = <p className="muted">No preview for this type of file. Download it to open it.</p>;
      break;
  }

  return (
    <article className="preview" aria-label={`Preview: ${name}`} data-kind={kind}>
      <div className="preview-bar">
        <span className="preview-file" title={file.path}>
          {name}
        </span>
        <span className="muted">
          {content.mime}, {formatBytes(content.size)}
        </span>
        <span className="editor-spacer" />
        {onEdit && content.text !== null ? (
          <Button variant="ghost" onClick={() => onEdit(file)}>
            <Icon name="edit" /> Edit
          </Button>
        ) : null}
        {apps.map((a) => (
          <Button
            key={a.id}
            variant="ghost"
            aria-pressed={app?.id === a.id}
            onClick={() => setApp(app?.id === a.id ? null : a)}
          >
            <Icon name="external" /> Open with {a.title}
          </Button>
        ))}
        <a className="link preview-download" href={raw} download={name}>
          <Icon name="download" /> Download
        </a>
      </div>
      <div className="preview-body">
        {app ? (
          <FileApp
            entry={app}
            root={file.root}
            path={file.path}
            threadId={threadId}
            onClose={() => setApp(null)}
          />
        ) : (
          body
        )}
      </div>
    </article>
  );
}

function TooLarge() {
  return <p className="muted">Too large to preview here. Download it to open it.</p>;
}
