// Trust an extension's hook (FR-197, docs/04 §2.10, docs/14 §4.2): an SDK hook runs only once its
// content hash is trusted, and the hash covers the hook and the extension's bundle, so every update
// asks again. Trusting goes through the hooks area (`POST /hooks/:id/trust` with the hash shown); if
// the hook changed while the dialog was open, the Hub refuses the old hash (409), and the dialog
// shows the new one for review: a changed hook is never trusted blindly.
import { useState } from 'react';
import { fmt, messageFor } from '@nova/i18n';
import type { ExtensionHookView, ExtensionView } from '@nova/shared';
import { Button, Dialog, Icon, Spinner } from '@nova/ui';
import { ApiError } from '../api.ts';
import { rich } from '../i18n/rich.tsx';
import { useServices } from '../services.tsx';
import { HOOK_CANNOT_TEXT, HOOK_CAN_TEXT } from '../settings/plugin-text.ts';
import type { ExtensionsApi } from './api-m8.ts';
import {
  HOOK_STATUS_TEXT,
  HOOK_TRUST_TEXT,
  extensionErrorMessage,
  hookEventText,
} from './format.ts';

const canText = (event: string) => messageFor(HOOK_CAN_TEXT, event) ?? null;

export function HookTrustDialog({
  extension,
  hook: initial,
  ext,
  onClose,
  onTrusted,
}: {
  extension: ExtensionView;
  hook: ExtensionHookView;
  ext: ExtensionsApi;
  onClose: () => void;
  onTrusted: (hookId: string) => void;
}) {
  const { api } = useServices();
  const [hook, setHook] = useState(initial);
  const [changed, setChanged] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const trust = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.trustHook(hook.id, hook.contentHash);
      onTrusted(hook.id);
    } catch (err) {
      setBusy(false);
      if (!(err instanceof ApiError && err.status === 409)) {
        setError(extensionErrorMessage(err, HOOK_TRUST_TEXT.failed));
        return;
      }
      // The hook changed under review: show the new definition and hash.
      try {
        const fresh = await ext.getExtension(extension.id);
        const next = fresh.hooks.find((h) => h.id === hook.id);
        if (!next) {
          setError(HOOK_TRUST_TEXT.gone);
          return;
        }
        setHook(next);
        setChanged(true);
      } catch (e) {
        setError(extensionErrorMessage(e, HOOK_TRUST_TEXT.reloadFailed));
      }
    }
  };

  const can = canText(hook.event);
  return (
    <Dialog
      open
      title={HOOK_TRUST_TEXT.title}
      description={HOOK_TRUST_TEXT.description({
        id: hook.id,
        status: HOOK_STATUS_TEXT[hook.status].text,
      })}
      onClose={onClose}
      className="ws-wide-dialog"
      footer={
        <>
          <Button onClick={onClose}>{HOOK_TRUST_TEXT.keep}</Button>
          <Button variant="primary" disabled={busy} onClick={() => void trust()}>
            {busy ? <Spinner /> : null} {HOOK_TRUST_TEXT.trust}
          </Button>
        </>
      }
    >
      <div className="stack">
        {changed ? (
          <p role="alert" className="ws-warning">
            <Icon name="alert" />
            <span>{HOOK_TRUST_TEXT.changed}</span>
          </p>
        ) : null}
        <dl className="ws-dl">
          <dt>{HOOK_TRUST_TEXT.from}</dt>
          <dd>
            {extension.name} <code className="ws-code-inline">{extension.id}</code>
          </dd>
          <dt>{HOOK_TRUST_TEXT.event}</dt>
          <dd>
            {hookEventText(hook.event)}{' '}
            <code className="ws-code-inline" dir="ltr">
              {hook.event}
            </code>
            {hook.matcher ? (
              <>
                {' '}
                {rich(HOOK_TRUST_TEXT.matches, {
                  matcher: (
                    <code className="ws-code-inline" dir="ltr">
                      {hook.matcher}
                    </code>
                  ),
                })}
              </>
            ) : null}
          </dd>
          <dt>{HOOK_TRUST_TEXT.runs}</dt>
          <dd>{HOOK_TRUST_TEXT.runsValue({ timeout: fmt.duration(hook.timeoutMs) })}</dd>
          <dt>{HOOK_TRUST_TEXT.failClosed}</dt>
          <dd>{hook.failClosed ? HOOK_TRUST_TEXT.failClosedYes : HOOK_TRUST_TEXT.failClosedNo}</dd>
          <dt>{HOOK_TRUST_TEXT.hash}</dt>
          <dd>
            <code className="ws-code-inline" data-testid="ext-trust-hash">
              {hook.contentHash}
            </code>
          </dd>
          {can ? (
            <>
              <dt>{HOOK_TRUST_TEXT.can}</dt>
              <dd>{can}</dd>
            </>
          ) : null}
          <dt>{HOOK_TRUST_TEXT.cannot}</dt>
          <dd>{HOOK_CANNOT_TEXT}</dd>
        </dl>
        {error ? (
          <p role="alert" className="nv-field-error">
            {error}
          </p>
        ) : null}
      </div>
    </Dialog>
  );
}
