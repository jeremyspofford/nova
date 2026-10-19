// The files of a cloud environment (FR-108: watch the work live), read on the runner in its
// sandbox: folders list their entries, a text file shows its (redacted, bounded) content as text,
// a binary file says so. Read-only; changes come from the session's or run's commands.
import { useId, useState } from 'react';
import { Button, Icon, Spinner } from '@nova/ui';
import { useCloudApi } from './api.ts';
import { cloudErrorMessage, formatBytes } from './format.ts';
import { TextBlock, useLoad } from './parts.tsx';

const ROOT = '/workspace';

/** The parent folder of `path`, never above /workspace. */
export function parentPath(path: string): string {
  const p = path.replace(/\/+$/, '');
  if (p === ROOT || !p.startsWith(`${ROOT}/`)) return ROOT;
  return p.slice(0, p.lastIndexOf('/')) || ROOT;
}

export function CloudFiles({
  environmentId,
  start,
  disabled,
}: {
  environmentId: string;
  /** The folder to open first (the environment's folder). */
  start: string;
  disabled: string | null;
}) {
  const api = useCloudApi();
  const headingId = useId();
  const [path, setPath] = useState(start || ROOT);
  const file = useLoad(
    () => (disabled ? Promise.resolve(null) : api.readCloudFile(environmentId, path)),
    `${environmentId}:${path}:${disabled ?? ''}`,
  );
  const f = file.data;
  return (
    <section className="ws-section" aria-labelledby={headingId}>
      <h3 id={headingId}>Files</h3>
      {disabled ? (
        <p className="muted">{disabled}</p>
      ) : (
        <>
          <div className="cl-path">
            <Button
              variant="ghost"
              disabled={path === ROOT}
              onClick={() => setPath(parentPath(path))}
              aria-label="Up one folder"
            >
              <Icon name="back" /> Up
            </Button>
            <code className="ws-code-inline cl-break" aria-live="polite">
              {path}
            </code>
          </div>
          {file.loading ? <Spinner label="Loading the folder" /> : null}
          {file.error ? (
            <div className="ws-error" role="alert">
              <p>{cloudErrorMessage(file.error, 'Could not read that.')}</p>
              <Button onClick={file.reload}>Retry</Button>
              {path !== ROOT ? (
                <Button onClick={() => setPath(ROOT)}>Open /workspace</Button>
              ) : null}
            </div>
          ) : null}
          {f?.kind === 'dir' ? (
            f.entries.length ? (
              <ul className="cl-files" aria-label={`Files in ${path}`}>
                {f.entries.map((e) => {
                  const full = `${path.replace(/\/+$/, '')}/${e.name}`;
                  return (
                    <li key={e.name}>
                      {e.kind === 'dir' || e.kind === 'file' ? (
                        <button type="button" className="cl-file" onClick={() => setPath(full)}>
                          <Icon name={e.kind === 'dir' ? 'folder' : 'file'} />
                          <span className="cl-break">{e.name}</span>
                          {e.kind === 'file' ? (
                            <span className="muted cl-small">{formatBytes(e.size)}</span>
                          ) : null}
                        </button>
                      ) : (
                        <span className="cl-file" data-inert>
                          <Icon name="file" />
                          <span className="cl-break">{e.name}</span>
                          <span className="muted cl-small">
                            {e.kind === 'link' ? 'link' : 'not a file'}
                          </span>
                        </span>
                      )}
                    </li>
                  );
                })}
                {f.truncated ? (
                  <li className="muted cl-small">More entries are not shown.</li>
                ) : null}
              </ul>
            ) : (
              <p className="muted">This folder is empty.</p>
            )
          ) : null}
          {f?.kind === 'file' ? (
            f.text === null ? (
              <p className="muted">
                A binary file of {formatBytes(f.size)}. Keep it as an artifact from a run to
                download it.
              </p>
            ) : (
              <>
                <TextBlock text={f.text} label={`Contents of ${path}`} />
                {f.truncated ? (
                  <p className="muted cl-small">
                    Only the start of this {formatBytes(f.size)} file is shown.
                  </p>
                ) : null}
              </>
            )
          ) : null}
        </>
      )}
    </section>
  );
}
