// The extension install and update preview (FR-117, FR-197; docs/14 §4.2 and §5, docs/26 §3): who
// signed it (Verified, or Unverified and why), what it can do in plain words, the permission diff
// of an update (changed lines worded part by part, sensitive ones marked), the hooks it brings with
// their hashes (trusted here only when ticked), and whether to turn it on. Nothing is installed
// until Install; an unverified bundle needs the explicit sideload confirmation, an update by
// another publisher (or none) the explicit acceptance of the new publisher (its stored secrets
// and data are cleared), and a policy that forbids unverified installs leaves Install off. A
// refusal stays in the dialog in plain words.
import { useState } from 'react';
import { fmt } from '@nova/i18n';
import type { ExtensionPermissionLine, ExtensionPreviewView, ExtensionView } from '@nova/shared';
import { Button, Dialog, Icon, Spinner } from '@nova/ui';
import { rich } from '../i18n/rich.tsx';
import { ChangedPermission, PublisherChangeNotice } from '../market/Changes.tsx';
import { VerifiedBadge } from '../settings/badges.tsx';
import type { ExtensionsApi } from './api-m8.ts';
import {
  EXT_TEXT,
  PERMISSION_ICON,
  PREVIEW_TEXT,
  SIGNATURE_TEXT,
  extensionErrorMessage,
  hookEventText,
} from './format.ts';

export function PermissionList({
  lines,
  label,
}: {
  lines: readonly ExtensionPermissionLine[];
  label: string;
}) {
  if (lines.length === 0) return <p className="muted">{EXT_TEXT.noPermissions}</p>;
  return (
    <ul className="ext-perms" aria-label={label}>
      {lines.map((l) => (
        <li key={l.key} data-sensitive={l.sensitive || undefined}>
          <Icon name={PERMISSION_ICON[l.kind]} />
          <span>
            {l.text}
            {l.sensitive ? <span className="ext-sensitive"> {EXT_TEXT.sensitive}</span> : null}
          </span>
        </li>
      ))}
    </ul>
  );
}

export function ExtensionPreviewDialog({
  preview,
  ext,
  unverifiedForbidden,
  onClose,
  onInstalled,
}: {
  preview: ExtensionPreviewView;
  ext: ExtensionsApi;
  /** Managed policy allows only verified installs (the Hub refuses the rest anyway). */
  unverifiedForbidden: boolean;
  onClose: () => void;
  onInstalled: (view: ExtensionView, update: boolean) => void;
}) {
  const [trust, setTrust] = useState<Set<string>>(() => new Set());
  const [enable, setEnable] = useState(true);
  const [sideload, setSideload] = useState(false);
  const [newPublisher, setNewPublisher] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const update = preview.replaces !== null;
  const policyBlocks = !preview.verified && unverifiedForbidden;
  const blocked =
    policyBlocks ||
    (!preview.verified && !sideload) ||
    (preview.publisherChange !== null && !newPublisher);
  const hooks = [
    ...preview.hooks.map((h) => ({
      id: h.id,
      event: h.event,
      matcher: h.matcher,
      contentHash: h.contentHash,
      detail: PREVIEW_TEXT.hookRunsValue({
        timeout: fmt.duration(h.timeoutMs),
        failClosed: h.failClosed ? 'yes' : 'no',
      }),
    })),
    ...preview.pluginHooks.map((h) => ({
      id: h.id,
      event: h.event,
      matcher: null,
      contentHash: h.contentHash,
      detail: null,
    })),
  ];
  // The Hub's own "Unverified: …" warning is the callout below.
  const warnings = preview.warnings.filter((w) => !w.startsWith('Unverified:'));

  const install = async () => {
    setBusy(true);
    setError(null);
    try {
      const view = await ext.installExtension({
        previewId: preview.previewId,
        enable,
        ...(preview.verified ? {} : { confirmSideload: sideload }),
        ...(preview.publisherChange ? { acceptPublisherChange: newPublisher } : {}),
        trustHooks: hooks
          .filter((h) => trust.has(h.id))
          .map((h) => ({ id: h.id, contentHash: h.contentHash })),
      });
      onInstalled(view, update);
    } catch (err) {
      setError(extensionErrorMessage(err, PREVIEW_TEXT.failed));
      setBusy(false);
    }
  };

  return (
    <Dialog
      open
      title={
        update
          ? PREVIEW_TEXT.update({ name: preview.name, version: preview.version })
          : PREVIEW_TEXT.install({ name: preview.name, version: preview.version })
      }
      description={preview.description ?? undefined}
      onClose={onClose}
      className="ws-wide-dialog"
      footer={
        <>
          <Button onClick={onClose}>{PREVIEW_TEXT.cancel}</Button>
          <Button variant="primary" disabled={busy || blocked} onClick={() => void install()}>
            {busy ? <Spinner /> : null}{' '}
            {update ? PREVIEW_TEXT.updateButton : PREVIEW_TEXT.installButton}
          </Button>
        </>
      }
    >
      <div className="stack">
        <p className="ws-row-meta">
          <VerifiedBadge verified={preview.verified} />
          <code className="ws-code-inline">{preview.id}</code>
          {preview.replaces ? (
            <span className="muted">
              {PREVIEW_TEXT.replaces({ version: preview.replaces.version })}
            </span>
          ) : null}
        </p>
        <dl className="ws-dl">
          <dt>{EXT_TEXT.publisher}</dt>
          <dd>
            {preview.publisher.trusted && preview.publisher.name
              ? PREVIEW_TEXT.signedBy({
                  signature: SIGNATURE_TEXT[preview.signature],
                  name: preview.publisher.name,
                })
              : SIGNATURE_TEXT[preview.signature]}
          </dd>
          {preview.publisher.fingerprint ? (
            <>
              <dt>{EXT_TEXT.fingerprint}</dt>
              <dd>
                <code className="ws-code-inline">{preview.publisher.fingerprint}</code>
              </dd>
            </>
          ) : null}
        </dl>

        {preview.publisherChange ? (
          <PublisherChangeNotice
            change={preview.publisherChange}
            accepted={newPublisher}
            onAccept={setNewPublisher}
          />
        ) : null}

        {!preview.verified ? (
          <div className="ws-callout" role="note">
            <Icon name="alert" />
            <div className="stack">
              <p>
                <strong>{PREVIEW_TEXT.unverifiedTitle}</strong>{' '}
                {PREVIEW_TEXT.unverifiedBody({
                  // The Hub's reason, in its words; else ours.
                  why: preview.sideloadReason
                    ? capitalize(preview.sideloadReason)
                    : PREVIEW_TEXT.notSigned,
                })}
              </p>
              {policyBlocks ? (
                <p className="nv-field-lock">{PREVIEW_TEXT.policyBlock}</p>
              ) : (
                <label className="ws-check">
                  <input
                    type="checkbox"
                    checked={sideload}
                    onChange={(e) => setSideload(e.target.checked)}
                  />
                  <span>{PREVIEW_TEXT.sideload}</span>
                </label>
              )}
            </div>
          </div>
        ) : null}

        {warnings.length ? (
          <ul className="ws-plain-list" aria-label={PREVIEW_TEXT.warnings}>
            {warnings.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        ) : null}

        {preview.diff ? (
          <section aria-labelledby="ext-diff">
            <h3 id="ext-diff" className="ws-subhead">
              {PREVIEW_TEXT.diff}
            </h3>
            {preview.diff.added.length ||
            preview.diff.removed.length ||
            preview.diff.changed.length ? (
              <ul className="ws-plain-list">
                {preview.diff.added.map((l) => (
                  <li key={`+${l.key}`}>
                    <strong>{PREVIEW_TEXT.diffNew}:</strong> {l.text}
                  </li>
                ))}
                {preview.diff.changed.map((c) => (
                  <ChangedPermission
                    key={`~${c.key}`}
                    change={c}
                    kind={preview.permissions.find((l) => l.key === c.key)?.kind}
                    label={PREVIEW_TEXT.diffChanged}
                  />
                ))}
                {preview.diff.removed.map((l) => (
                  <li key={`-${l.key}`}>
                    {PREVIEW_TEXT.diffGone}: {l.text}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="muted">{PREVIEW_TEXT.diffNone}</p>
            )}
          </section>
        ) : null}

        <section aria-labelledby="ext-perms">
          <h3 id="ext-perms" className="ws-subhead">
            {PREVIEW_TEXT.can}
          </h3>
          <PermissionList lines={preview.permissions} label={PREVIEW_TEXT.can} />
          <p className="muted">{PREVIEW_TEXT.enforced}</p>
        </section>

        {hooks.length ? (
          <section aria-labelledby="ext-hooks">
            <h3 id="ext-hooks" className="ws-subhead">
              {PREVIEW_TEXT.hooks}
            </h3>
            <p className="muted">{PREVIEW_TEXT.hooksHint}</p>
            <ul className="ws-list">
              {hooks.map((h) => (
                <li
                  key={h.id}
                  className="ws-list-row"
                  aria-label={PREVIEW_TEXT.hookRow({ id: h.id })}
                >
                  <dl className="ws-dl">
                    <dt>{PREVIEW_TEXT.hookEvent}</dt>
                    <dd>
                      {hookEventText(h.event)}
                      {h.matcher ? (
                        <>
                          {' '}
                          {rich(PREVIEW_TEXT.matches, {
                            matcher: (
                              <code className="ws-code-inline" dir="ltr">
                                {h.matcher}
                              </code>
                            ),
                          })}
                        </>
                      ) : null}
                    </dd>
                    {h.detail ? (
                      <>
                        <dt>{PREVIEW_TEXT.hookRuns}</dt>
                        <dd>{h.detail}</dd>
                      </>
                    ) : null}
                    <dt>{PREVIEW_TEXT.hookHash}</dt>
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
                    <span>{PREVIEW_TEXT.trustNow({ id: h.id })}</span>
                  </label>
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        <label className="ws-check">
          <input type="checkbox" checked={enable} onChange={(e) => setEnable(e.target.checked)} />
          <span>{PREVIEW_TEXT.turnOn}</span>
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

function capitalize(s: string): string {
  return s ? s[0]!.toUpperCase() + s.slice(1) : s;
}
