// The plugin install and update preview (FR-045, FR-197; docs/08 §3.2, docs/14 §5): what the
// plugin may do in plain words, the permission diff on update, the hooks it brings (each with its
// event, command and content hash, trusted here only when ticked) and the MCP servers it adds.
// Nothing is installed until Install; an unverified plugin needs an explicit confirmation, and one
// that would replace an extension signed by a publisher (the preview's `publisherChange`: who
// signed it and that this is not signed) the explicit acceptance that the extension's stored
// secrets and data are deleted, before the first Install. A Hub that says so only by refusing
// (`publisher_change_confirmation_required`) gets the same acceptance, then it is sent again.
import { useEffect, useRef, useState } from 'react';
import { defineMessages } from '@nova/i18n';
import type { PluginPreview, PluginView } from '@nova/shared';
import { Button, Dialog, Icon, Spinner } from '@nova/ui';
import { ApiError, errorMessage } from '../api.ts';
import { PublisherChangeNotice } from '../market/Changes.tsx';
import { useServices } from '../services.tsx';
import { VerifiedBadge } from './badges.tsx';
import {
  HOOK_EVENT_TEXT,
  formatSeconds,
  hookHandlerText,
  permissionDiff,
  permissionLines,
} from './plugin-text.ts';
import { embed } from './embed.tsx';

/** Replacing a signed extension with this plugin (M8 supply review #3). */
export const TAKEOVER_TEXT = defineMessages('settings.pluginInstall.takeover', {
  title: 'This replaces an extension from another publisher',
  body:
    'The installed extension with this id is signed by a publisher; this plugin is not. ' +
    'Installing it deletes the secrets you stored for the extension and its data.',
  accept: 'I accept the new publisher; delete its stored secrets and data',
});

const S = defineMessages('settings.pluginInstall', {
  thisPlugin: 'This plugin',
  expired: 'This preview has expired. Close it and preview the plugin again.',
  installFailed: 'Could not install the plugin.',
  title: '{action, select, update {Update {name}?} other {Install {name}?}}',
  by: 'By {author}.',
  cancel: 'Cancel',
  update: 'Update',
  install: 'Install',
  replaces: 'Replaces version {version}.',
  unverified:
    'This plugin is not signed by a publisher you trust. It stays labelled Unverified. Install ' +
    'it only if you trust where it came from.',
  sideload: 'I trust its source; install it unverified',
  warnings: 'Warnings',
  changes: 'Permission changes',
  added: 'New: {line}',
  removed: 'No longer: {line}',
  unchanged: 'Permissions are unchanged.',
  canDo: 'This plugin can',
  enforced:
    'Nova enforces these limits; the plugin cannot go beyond them, and built-in safety still ' +
    'applies to every tool.',
  skills: 'Skills',
  skill: '{name}: {description}',
  servers: 'MCP servers it adds',
  server: '{name} ({transport}): {target}',
  command: 'command',
  serversOnlyOn: 'They run only while the plugin is turned on.',
  hooks: 'Hooks to trust',
  hooksHint:
    'A hook never runs until you trust it by its hash. Hooks you leave unticked stay off; you ' +
    'can trust them later under Hooks.',
  hook: 'Hook {id}',
  event: 'Event',
  matches: '· matches {matcher}',
  runs: 'Runs',
  sandboxed: '{handler} (sandboxed, timeout {time})',
  hash: 'Hash',
  trustNow: 'Trust {id} now',
  enableAfter:
    '{action, select, update {Turn it on after updating} other {Turn it on after installing}}',
});

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
    name: str(m.name) ?? str(m.id) ?? S.thisPlugin,
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
  // The preview says when this takes over a signed extension, so it is accepted before the first
  // Install; a Hub that says so only by refusing the install sets `refused` (the fallback).
  const change = preview.publisherChange ?? null;
  const [refused, setRefused] = useState(false);
  const takeover = change !== null || refused;
  const [acceptTakeover, setAcceptTakeover] = useState(false);
  const takeoverBox = useRef<HTMLInputElement>(null);
  // Install turns off until it is accepted: after a refusal the focus moves to the acceptance.
  useEffect(() => {
    if (refused) takeoverBox.current?.focus();
  }, [refused]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const update = preview.replaces !== null;
  const lines = permissionLines(preview.permissions);
  const diff = current ? permissionDiff(current.permissions, preview.permissions) : null;
  const blocked = (!preview.verified && !sideload) || (takeover && !acceptTakeover);

  const install = async () => {
    setBusy(true);
    setError(null);
    try {
      const view = await api.installPlugin({
        previewId: preview.previewId,
        enable,
        ...(preview.verified ? {} : { confirmSideload: sideload }),
        ...(takeover ? { acceptPublisherChange: acceptTakeover } : {}),
        trustHooks: preview.hooks
          .filter((h) => trust.has(h.id))
          .map((h) => ({ id: h.id, contentHash: h.contentHash })),
      });
      onInstalled(view);
    } catch (err) {
      if (
        err instanceof ApiError &&
        err.body.details?.reason === 'publisher_change_confirmation_required'
      ) {
        // Not an error to fix elsewhere: the acceptance below, then Install again.
        setRefused(true);
        setBusy(false);
        return;
      }
      setError(
        err instanceof ApiError && (err.status === 404 || err.status === 410)
          ? S.expired
          : errorMessage(err, S.installFailed),
      );
      setBusy(false);
    }
  };

  const title = S.title({
    action: update ? 'update' : 'install',
    name: info.version ? `${info.name} ${info.version}` : info.name,
  });
  return (
    <Dialog
      open
      title={title}
      description={
        info.description || info.author ? (
          <>
            {info.description ? <span dir="auto">{info.description} </span> : null}
            {info.author ? <span className="muted">{S.by({ author: info.author })}</span> : null}
          </>
        ) : undefined
      }
      onClose={onClose}
      className="ws-wide-dialog"
      footer={
        <>
          <Button onClick={onClose}>{S.cancel}</Button>
          <Button variant="primary" disabled={busy || blocked} onClick={() => void install()}>
            {busy ? <Spinner /> : null} {update ? S.update : S.install}
          </Button>
        </>
      }
    >
      <div className="stack">
        <p className="ws-row-meta">
          <VerifiedBadge verified={preview.verified} />
          {info.id ? (
            <code className="ws-code-inline" dir="ltr">
              {info.id}
            </code>
          ) : null}
          {preview.replaces ? (
            <span className="muted">{S.replaces({ version: preview.replaces.version })}</span>
          ) : null}
        </p>
        {!preview.verified ? (
          <div className="ws-callout" role="note">
            <Icon name="alert" />
            <div className="stack">
              <p>{S.unverified}</p>
              <label className="ws-check">
                <input
                  type="checkbox"
                  checked={sideload}
                  onChange={(e) => setSideload(e.target.checked)}
                />
                <span>{S.sideload}</span>
              </label>
            </div>
          </div>
        ) : null}
        {change ? (
          <PublisherChangeNotice
            change={change}
            accepted={acceptTakeover}
            onAccept={setAcceptTakeover}
          />
        ) : takeover ? (
          <div className="ws-callout" role="note" data-tone="blocked">
            <Icon name="alert" />
            <div className="stack">
              <p>
                <strong>{TAKEOVER_TEXT.title}</strong>
              </p>
              <p>{TAKEOVER_TEXT.body}</p>
              <label className="ws-check">
                <input
                  ref={takeoverBox}
                  type="checkbox"
                  checked={acceptTakeover}
                  onChange={(e) => setAcceptTakeover(e.target.checked)}
                />
                <span>{TAKEOVER_TEXT.accept}</span>
              </label>
            </div>
          </div>
        ) : null}
        {preview.warnings.length ? (
          <ul className="ws-plain-list" aria-label={S.warnings}>
            {preview.warnings.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        ) : null}

        {diff ? (
          <section aria-labelledby="plugin-diff">
            <h3 id="plugin-diff" className="ws-subhead">
              {S.changes}
            </h3>
            {diff.added.length || diff.removed.length ? (
              <ul className="ws-plain-list">
                {diff.added.map((l) => (
                  <li key={`+${l}`}>{S.added({ line: l })}</li>
                ))}
                {diff.removed.map((l) => (
                  <li key={`-${l}`}>{S.removed({ line: l })}</li>
                ))}
              </ul>
            ) : (
              <p className="muted">{S.unchanged}</p>
            )}
          </section>
        ) : null}

        <section aria-labelledby="plugin-perms">
          <h3 id="plugin-perms" className="ws-subhead">
            {S.canDo}
          </h3>
          <ul className="ws-plain-list">
            {lines.map((l) => (
              <li key={l}>{l}</li>
            ))}
          </ul>
          <p className="muted">{S.enforced}</p>
        </section>

        {preview.skills.length ? (
          <section aria-labelledby="plugin-skills">
            <h3 id="plugin-skills" className="ws-subhead">
              {S.skills}
            </h3>
            <ul className="ws-plain-list">
              {preview.skills.map((s) => (
                <li key={s.name}>
                  {embed(S.skill, {
                    name: <strong>{s.name}</strong>,
                    description: <span dir="auto">{s.description}</span>,
                  })}
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        {preview.mcpServers.length ? (
          <section aria-labelledby="plugin-servers">
            <h3 id="plugin-servers" className="ws-subhead">
              {S.servers}
            </h3>
            <ul className="ws-plain-list">
              {preview.mcpServers.map((s) => (
                <li key={s.name}>
                  {embed(S.server, {
                    name: <strong>{s.name}</strong>,
                    transport: s.transport === 'stdio' ? S.command : s.transport,
                    target: (
                      <code className="ws-code-inline" dir="ltr">
                        {s.command ?? s.url ?? ''}
                      </code>
                    ),
                  })}
                </li>
              ))}
            </ul>
            <p className="muted">{S.serversOnlyOn}</p>
          </section>
        ) : null}

        {preview.hooks.length ? (
          <section aria-labelledby="plugin-hooks">
            <h3 id="plugin-hooks" className="ws-subhead">
              {S.hooks}
            </h3>
            <p className="muted">{S.hooksHint}</p>
            <ul className="ws-list">
              {preview.hooks.map((h) => (
                <li key={h.id} className="ws-list-row" aria-label={S.hook({ id: h.id })}>
                  <dl className="ws-dl">
                    <dt>{S.event}</dt>
                    <dd>
                      {HOOK_EVENT_TEXT[h.event]}
                      {h.matcher ? (
                        <>
                          {' '}
                          {embed(S.matches, {
                            matcher: (
                              <code className="ws-code-inline" dir="ltr">
                                {h.matcher}
                              </code>
                            ),
                          })}
                        </>
                      ) : null}
                    </dd>
                    <dt>{S.runs}</dt>
                    <dd>
                      {embed(S.sandboxed, {
                        handler: (
                          <code className="ws-code-inline" dir="ltr">
                            {hookHandlerText(h)}
                          </code>
                        ),
                        time: formatSeconds(h.timeoutMs / 1000),
                      })}
                    </dd>
                    <dt>{S.hash}</dt>
                    <dd>
                      <code className="ws-code-inline" dir="ltr">
                        {h.contentHash}
                      </code>
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
                    <span>{S.trustNow({ id: h.id })}</span>
                  </label>
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        <label className="ws-check">
          <input type="checkbox" checked={enable} onChange={(e) => setEnable(e.target.checked)} />
          <span>{S.enableAfter({ action: update ? 'update' : 'install' })}</span>
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
