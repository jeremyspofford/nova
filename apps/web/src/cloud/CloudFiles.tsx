// The files of a cloud environment (FR-108: watch the work live), read on the runner in its
// sandbox: folders list their entries, a text file shows its (redacted, bounded) content as text,
// a binary file says so. Read-only; changes come from the session's or run's commands.
import { useId, useState } from 'react';
import { defineMessages } from '@nova/i18n';
import { Button, Icon, Spinner } from '@nova/ui';
import { useCloudApi } from './api.ts';
import { CLOUD_TEXT, cloudErrorMessage, formatBytes } from './format.ts';
import { TextBlock, useLoad } from './parts.tsx';

/** An environment's files. {path} is a folder or file path on the runner. */
export const FILES_TEXT = defineMessages('cloud.files', {
  heading: 'Files',
  upLabel: 'Up one folder',
  up: 'Up',
  loading: 'Loading the folder',
  readFailed: 'Could not read that.',
  openRoot: 'Open /workspace',
  list: 'Files in {path}',
  link: 'link',
  notAFile: 'not a file',
  more: 'More entries are not shown.',
  empty: 'This folder is empty.',
  /** {size} is a file size, such as "8.8 KB". */
  binary: 'A binary file of {size}. Keep it as an artifact from a run to download it.',
  contents: 'Contents of {path}',
  truncated: 'Only the start of this {size} file is shown.',
});

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
  const S = FILES_TEXT;
  return (
    <section className="ws-section" aria-labelledby={headingId}>
      <h3 id={headingId}>{S.heading}</h3>
      {disabled ? (
        <p className="muted">{disabled}</p>
      ) : (
        <>
          <div className="cl-path">
            <Button
              variant="ghost"
              disabled={path === ROOT}
              onClick={() => setPath(parentPath(path))}
              aria-label={S.upLabel}
            >
              <Icon name="back" /> {S.up}
            </Button>
            <code className="ws-code-inline cl-break" aria-live="polite" dir="ltr">
              {path}
            </code>
          </div>
          {file.loading ? <Spinner label={S.loading} /> : null}
          {file.error ? (
            <div className="ws-error" role="alert">
              <p>{cloudErrorMessage(file.error, S.readFailed)}</p>
              <Button onClick={file.reload}>{CLOUD_TEXT.retry}</Button>
              {path !== ROOT ? <Button onClick={() => setPath(ROOT)}>{S.openRoot}</Button> : null}
            </div>
          ) : null}
          {f?.kind === 'dir' ? (
            f.entries.length ? (
              <ul className="cl-files" aria-label={S.list({ path })}>
                {f.entries.map((e) => {
                  const full = `${path.replace(/\/+$/, '')}/${e.name}`;
                  return (
                    <li key={e.name}>
                      {e.kind === 'dir' || e.kind === 'file' ? (
                        <button type="button" className="cl-file" onClick={() => setPath(full)}>
                          <Icon name={e.kind === 'dir' ? 'folder' : 'file'} />
                          <span className="cl-break" dir="auto">
                            {e.name}
                          </span>
                          {e.kind === 'file' ? (
                            <span className="muted cl-small">{formatBytes(e.size)}</span>
                          ) : null}
                        </button>
                      ) : (
                        <span className="cl-file" data-inert>
                          <Icon name="file" />
                          <span className="cl-break" dir="auto">
                            {e.name}
                          </span>
                          <span className="muted cl-small">
                            {e.kind === 'link' ? S.link : S.notAFile}
                          </span>
                        </span>
                      )}
                    </li>
                  );
                })}
                {f.truncated ? <li className="muted cl-small">{S.more}</li> : null}
              </ul>
            ) : (
              <p className="muted">{S.empty}</p>
            )
          ) : null}
          {f?.kind === 'file' ? (
            f.text === null ? (
              <p className="muted">{S.binary({ size: formatBytes(f.size) })}</p>
            ) : (
              <>
                <TextBlock text={f.text} label={S.contents({ path })} />
                {f.truncated ? (
                  <p className="muted cl-small">{S.truncated({ size: formatBytes(f.size) })}</p>
                ) : null}
              </>
            )
          ) : null}
        </>
      )}
    </section>
  );
}
