// The plugin install and update preview (FR-045, FR-197; docs/08 §3.2, docs/14 §5): what the
// plugin may do in plain words, the permission diff on update, the hooks it brings (each with its
// event, command and content hash, trusted here only when ticked) and the MCP servers it adds.
// Nothing is installed until Install; an unverified plugin needs an explicit confirmation.
import { useState } from 'react';
import type { PluginPreview, PluginView } from '@nova/shared';
import { Button, Dialog, Icon, Spinner } from '@nova/ui';
import { ApiError, errorMessage } from '../api.ts';
import { useServices } from '../services.tsx';
import { VerifiedBadge } from './badges.tsx';
import {
  HOOK_EVENT_TEXT,
  formatSeconds,
  hookHandlerText,
  permissionDiff,
  permissionLines,
} from './plugin-text.ts';

/** Display fields from an untyped manifest; anything missing or of the wrong type is left out. */
export function manifestInfo(m: Record<string, unknown>): {
  id: string | null;
  name: string;
  version: string | null;
  description: string | null;
  author: string | null;
} {
  const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v : null);
  const author = m.author && typeof m.author === 'object' ? (m.author as { name?: unknown }) : null;
  return {
    id: str(m.id),
    name: str(m.name) ?? str(m.id) ?? 'This plugin',
    version: str(m.version),
    description: str(m.description),
    author: str(author?.name),
  };
}

export function PluginPreviewDialog({
  preview,
  current,
  onClose,
  onInstalled,
}: {
  preview: PluginPreview;
  /** The installed plugin this one replaces, for the permission diff. */
  current: PluginView | null;
  onClose: () => void;
  onInstalled: (p: PluginView) => void;
}) {
  const { api } = useServices();
  const info = manifestInfo(preview.manifest);
  const [trust, setTrust] = useState<Set<string>>(() => new Set());
  const [enable, setEnable] = useState(true);
  const [sideload, setSideload] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const update = preview.replaces !== null;
  const lines = permissionLines(preview.permissions);
  const diff = current ? permissionDiff(current.permissions, preview.permissions) : null;
  const blocked = !preview.verified && !sideload;

  const install = async () => {
    setBusy(true);
    setError(null);
    try {
      const view = await api.installPlugin({
        previewId: preview.previewId,
        enable,
        ...(preview.verified ? {} : { confirmSideload: sideload }),
        trustHooks: preview.hooks
          .filter((h) => trust.has(h.id))
          .map((h) => ({ id: h.id, contentHash: h.contentHash })),
      });
      onInstalled(view);
    } catch (err) {
      setError(
        err instanceof ApiError && (err.status === 404 || err.status === 410)
          ? 'This preview has expired. Close it and preview the plugin again.'
          : errorMessage(err, 'Could not install the plugin.'),
      );
      setBusy(false);
    }
  };

  const title = `${update ? 'Update' : 'Install'} ${info.name}${info.version ? ` ${info.version}` : ''}?`;
  return (
    <Dialog
      open
      title={title}
      description={
        info.description || info.author ? (
          <>
            {info.description ? <span>{info.description} </span> : null}
            {info.author ? <span className="muted">By {info.author}.</span> : null}
          </>
        ) : undefined
      }
      onClose={onClose}
      className="ws-wide-dialog"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={busy || blocked} onClick={() => void install()}>
            {busy ? <Spinner /> : null} {update ? 'Update' : 'Install'}
          </Button>
        </>
      }
    >
      <div className="stack">
        <p className="ws-row-meta">
          <VerifiedBadge verified={preview.verified} />
          {info.id ? <code className="ws-code-inline">{info.id}</code> : null}
          {preview.replaces ? (
            <span className="muted">Replaces version {preview.replaces.version}.</span>
          ) : null}
        </p>
        {!preview.verified ? (
          <div className="ws-callout" role="note">
            <Icon name="alert" />
            <div className="stack">
              <p>
                This plugin is not signed by a publisher you trust. It stays labelled Unverified.
                Install it only if you trust where it came from.
              </p>
              <label className="ws-check">
                <input
                  type="checkbox"
                  checked={sideload}
                  onChange={(e) => setSideload(e.target.checked)}
                />
                <span>I trust its source; install it unverified</span>
              </label>
            </div>
          </div>
        ) : null}
        {preview.warnings.length ? (
          <ul className="ws-plain-list" aria-label="Warnings">
            {preview.warnings.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        ) : null}

        {diff ? (
          <section aria-labelledby="plugin-diff">
            <h3 id="plugin-diff" className="ws-subhead">
              Permission changes
            </h3>
            {diff.added.length || diff.removed.length ? (
              <ul className="ws-plain-list">
                {diff.added.map((l) => (
                  <li key={`+${l}`}>New: {l}</li>
                ))}
                {diff.removed.map((l) => (
                  <li key={`-${l}`}>No longer: {l}</li>
                ))}
              </ul>
            ) : (
              <p className="muted">Permissions are unchanged.</p>
            )}
          </section>
        ) : null}

        <section aria-labelledby="plugin-perms">
          <h3 id="plugin-perms" className="ws-subhead">
            This plugin can
          </h3>
          <ul className="ws-plain-list">
            {lines.map((l) => (
              <li key={l}>{l}</li>
            ))}
          </ul>
          <p className="muted">
            Nova enforces these limits; the plugin cannot go beyond them, and built-in safety still
            applies to every tool.
          </p>
        </section>

        {preview.skills.length ? (
          <section aria-labelledby="plugin-skills">
            <h3 id="plugin-skills" className="ws-subhead">
              Skills
            </h3>
            <ul className="ws-plain-list">
              {preview.skills.map((s) => (
                <li key={s.name}>
                  <strong>{s.name}</strong>: {s.description}
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        {preview.mcpServers.length ? (
          <section aria-labelledby="plugin-servers">
            <h3 id="plugin-servers" className="ws-subhead">
              MCP servers it adds
            </h3>
            <ul className="ws-plain-list">
              {preview.mcpServers.map((s) => (
                <li key={s.name}>
                  <strong>{s.name}</strong> ({s.transport === 'stdio' ? 'command' : s.transport}
                  ): <code className="ws-code-inline">{s.command ?? s.url ?? ''}</code>
                </li>
              ))}
            </ul>
            <p className="muted">They run only while the plugin is turned on.</p>
          </section>
        ) : null}

        {preview.hooks.length ? (
          <section aria-labelledby="plugin-hooks">
            <h3 id="plugin-hooks" className="ws-subhead">
              Hooks to trust
            </h3>
            <p className="muted">
              A hook never runs until you trust it by its hash. Hooks you leave unticked stay off;
              you can trust them later under Hooks.
            </p>
            <ul className="ws-list">
              {preview.hooks.map((h) => (
                <li key={h.id} className="ws-list-row" aria-label={`Hook ${h.id}`}>
                  <dl className="ws-dl">
                    <dt>Event</dt>
                    <dd>
                      {HOOK_EVENT_TEXT[h.event]}
                      {h.matcher ? (
                        <>
                          {' '}
                          · matches <code className="ws-code-inline">{h.matcher}</code>
                        </>
                      ) : null}
                    </dd>
                    <dt>Runs</dt>
                    <dd>
                      <code className="ws-code-inline">{hookHandlerText(h)}</code> (sandboxed,
                      timeout {formatSeconds(h.timeoutMs / 1000)})
                    </dd>
                    <dt>Hash</dt>
                    <dd>
                      <code className="ws-code-inline">{h.contentHash}</code>
                    </dd>
                  </dl>
                  <label className="ws-check">
                    <input
                      type="checkbox"
                      checked={trust.has(h.id)}
                      onChange={(e) =>
                        setTrust((s) => {
                          const next = new Set(s);
                          if (e.target.checked) next.add(h.id);
                          else next.delete(h.id);
                          return next;
                        })
                      }
                    />
                    <span>Trust {h.id} now</span>
                  </label>
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        <label className="ws-check">
          <input type="checkbox" checked={enable} onChange={(e) => setEnable(e.target.checked)} />
          <span>Turn it on after {update ? 'updating' : 'installing'}</span>
        </label>
        {error ? (
          <p role="alert" className="nv-field-error">
            {error}
          </p>
        ) : null}
      </div>
    </Dialog>
  );
}
