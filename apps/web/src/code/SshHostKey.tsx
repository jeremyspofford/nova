// An SSH environment's host key (FR-062; docs/10 §2, M7): the key Nova pinned on first use with
// its SHA256 fingerprint (as `ssh-keygen -lf` prints it), so you can compare it with the host's;
// a different key later is refused and nothing is sent, and the row says what that means and what
// to check before replacing the pinned key. Replacing or forgetting it asks first. When SSH
// environments are off on this Hub, the row says where to turn them on.
import { useEffect, useId, useState } from 'react';
import type { SavedEnvironmentView } from '@nova/shared';
import { defineMessages } from '@nova/i18n';
import { Button, Icon } from '@nova/ui';
import { rich } from '../chat/rich.tsx';
import { ConfirmAction } from '../cloud/parts.tsx';
import { TextArea } from '../cloud/CloudEnvironmentDialog.tsx';
import { useAnnounce } from '../services.tsx';
import { useCodeM6Api } from './api-m6.ts';
import { AppLink } from './CodeNav.tsx';
import { codeM7ErrorMessage } from './m7-format.ts';

export const CODE_SETTINGS_PATH = '/settings/code';

/** The command that prints a host key's fingerprint (code, not translated). */
const KEYGEN_COMMAND = 'ssh-keygen -lf';

export const HOST_KEY_TEXT = defineMessages('code.sshKey', {
  sshOff:
    'SSH environments are off on this Hub, so Nova does not connect to {host}. Turn them on in {settings}.',
  settingsLink: 'Settings → Code',
  mismatchTitle: '{host} answered with a different host key.',
  mismatchBody:
    'Nova refused to connect and sent nothing. This happens when the machine was reinstalled or its keys were changed, and also when something is intercepting the connection. Check the key on the machine itself (for example with {command} on its host key file) before you replace the pinned key.',
  pinned: 'Pinned host key:',
  pinnedType: 'Pinned host key ({type}):',
  hostKey: 'Host key:',
  noFingerprint: 'its fingerprint cannot be shown here.',
  notPinned: 'not pinned yet. Nova pins the key the host shows on the first connection.',
  replace: 'Replace the pinned key…',
  pin: 'Pin a key…',
  forget: 'Forget the pinned key…',
  replaceTitle: 'Replace the host key of {host}?',
  pinTitle: 'Pin a host key for {host}',
  pasteBody:
    'Paste the host’s public key, as in its .pub file or known_hosts. Compare its fingerprint with the one the host shows.',
  replaceKey: 'Replace key',
  pinKey: 'Pin key',
  saveFailed: 'Could not save the host key.',
  notAKey: 'That is not a public key line such as “ssh-ed25519 AAAA…”.',
  pinnedAnnounce: 'The host key of {host} is pinned.',
  publicKey: 'Host public key',
  keyExample: 'ssh-ed25519 AAAAC3Nza…',
  fingerprint: 'Its fingerprint: {fingerprint}',
  forgetTitle: 'Forget the host key of {host}?',
  forgetBody:
    'Nova then trusts whatever key the host shows on the next connection, and pins that. Do this only when you know why the key changed.',
  forgetKey: 'Forget key',
  forgetFailed: 'Could not forget the host key.',
  forgotten: 'The host key of {host} is forgotten.',
});

/** `<type> <base64>` of a public key line (comments dropped), or null when it is not one. */
export function parseHostKey(text: string): { type: string; blob: string } | null {
  const parts = text.trim().split(/\s+/);
  const at = parts.findIndex((p) => /^(ssh-|ecdsa-|sk-)/.test(p));
  const type = at >= 0 ? parts[at] : undefined;
  const blob = at >= 0 ? parts[at + 1] : undefined;
  if (!type || !blob || !/^[A-Za-z0-9+/]+={0,2}$/.test(blob)) return null;
  return { type, blob };
}

/** OpenSSH's `SHA256:` fingerprint of a host key, or null where the browser cannot hash. */
export async function hostKeyFingerprint(key: string): Promise<string | null> {
  const k = parseHostKey(key);
  const subtle = globalThis.crypto?.subtle as SubtleCrypto | undefined;
  if (!k || !subtle) return null;
  try {
    const bin = atob(k.blob);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const digest = new Uint8Array(await subtle.digest('SHA-256', bytes));
    let s = '';
    for (const b of digest) s += String.fromCharCode(b);
    return `SHA256:${btoa(s).replace(/=+$/, '')}`;
  } catch {
    return null;
  }
}

function useFingerprint(key: string | null): string | null {
  const [fp, setFp] = useState<{ key: string; fp: string | null } | null>(null);
  useEffect(() => {
    if (!key) return;
    let alive = true;
    void hostKeyFingerprint(key).then((v) => alive && setFp({ key, fp: v }));
    return () => {
      alive = false;
    };
  }, [key]);
  return fp && fp.key === key ? fp.fp : null;
}

/** Whether the environment's health says the host key did not match. */
export function isHostKeyMismatch(e: Pick<SavedEnvironmentView, 'detail'>): boolean {
  return /does not match the pinned key|host key verification failed|host_key_mismatch/i.test(
    e.detail ?? '',
  );
}

/** Whether the environment's health says SSH environments are off on this Hub. */
export function isSshOff(e: Pick<SavedEnvironmentView, 'detail'>): boolean {
  return /SSH environments are off|ssh_disabled/i.test(e.detail ?? '');
}

/** The host key part of an SSH environment row. */
export function SshHostKey({
  env,
  onChanged,
}: {
  env: SavedEnvironmentView;
  onChanged: (e: SavedEnvironmentView) => void;
}) {
  const m6 = useCodeM6Api();
  const announce = useAnnounce();
  const id = useId();
  const c = env.connection.kind === 'ssh' ? env.connection : null;
  const pinned = c?.hostKey ?? null;
  const fp = useFingerprint(pinned);
  const [replacing, setReplacing] = useState(false);
  const [forgetting, setForgetting] = useState(false);
  const [draft, setDraft] = useState('');
  const draftFp = useFingerprint(parseHostKey(draft) ? draft : null);
  if (!c) return null;
  const mismatch = isHostKeyMismatch(env);
  const key = parseHostKey(pinned ?? '');

  return (
    <div role="group" className="cm7-hostkey" aria-labelledby={id}>
      {isSshOff(env) ? (
        <p className="ws-callout" role="note">
          <Icon name="alert" />
          <span>
            {rich(HOST_KEY_TEXT.sshOff, {
              host: c.host,
              settings: <AppLink to={CODE_SETTINGS_PATH}>{HOST_KEY_TEXT.settingsLink}</AppLink>,
            })}
          </span>
        </p>
      ) : null}
      {mismatch ? (
        <div className="cl-notice" data-tone="danger" role="alert">
          <Icon name="shield" />
          <span>
            <strong>{HOST_KEY_TEXT.mismatchTitle({ host: c.host })}</strong>{' '}
            {rich(HOST_KEY_TEXT.mismatchBody, { command: <code>{KEYGEN_COMMAND}</code> })}
          </span>
        </div>
      ) : null}
      <p className="cm7-hostkey-line">
        <span id={id} className="muted">
          {pinned
            ? key
              ? HOST_KEY_TEXT.pinnedType({ type: key.type })
              : HOST_KEY_TEXT.pinned
            : HOST_KEY_TEXT.hostKey}
        </span>{' '}
        {pinned ? (
          fp ? (
            <code className="cl-break">{fp}</code>
          ) : (
            <span>{HOST_KEY_TEXT.noFingerprint}</span>
          )
        ) : (
          <span>{HOST_KEY_TEXT.notPinned}</span>
        )}
      </p>
      <div className="cl-actions">
        <Button
          variant={mismatch ? 'primary' : 'ghost'}
          onClick={() => {
            setDraft('');
            setReplacing(true);
          }}
        >
          <Icon name="edit" /> {pinned ? HOST_KEY_TEXT.replace : HOST_KEY_TEXT.pin}
        </Button>
        {pinned ? (
          <Button variant="ghost" onClick={() => setForgetting(true)}>
            <Icon name="trash" /> {HOST_KEY_TEXT.forget}
          </Button>
        ) : null}
      </div>
      <ConfirmAction
        open={replacing}
        title={
          pinned
            ? HOST_KEY_TEXT.replaceTitle({ host: c.host })
            : HOST_KEY_TEXT.pinTitle({ host: c.host })
        }
        description={HOST_KEY_TEXT.pasteBody}
        confirmLabel={pinned ? HOST_KEY_TEXT.replaceKey : HOST_KEY_TEXT.pinKey}
        danger={!!pinned}
        errorText={(err) => codeM7ErrorMessage(err, HOST_KEY_TEXT.saveFailed)}
        onClose={() => setReplacing(false)}
        onConfirm={async () => {
          const k = parseHostKey(draft);
          if (!k) throw new Error(HOST_KEY_TEXT.notAKey);
          const next = await m6.updateEnvironment(env.id, {
            connection: { hostKey: `${k.type} ${k.blob}` },
          });
          setReplacing(false);
          onChanged(next);
          announce(HOST_KEY_TEXT.pinnedAnnounce({ host: c.host }));
        }}
      >
        <TextArea
          id={`${id}-key`}
          label={HOST_KEY_TEXT.publicKey}
          value={draft}
          rows={3}
          placeholder={HOST_KEY_TEXT.keyExample}
          hint={draftFp ? HOST_KEY_TEXT.fingerprint({ fingerprint: draftFp }) : undefined}
          onChange={setDraft}
        />
      </ConfirmAction>
      <ConfirmAction
        open={forgetting}
        title={HOST_KEY_TEXT.forgetTitle({ host: c.host })}
        description={HOST_KEY_TEXT.forgetBody}
        confirmLabel={HOST_KEY_TEXT.forgetKey}
        danger
        errorText={(err) => codeM7ErrorMessage(err, HOST_KEY_TEXT.forgetFailed)}
        onClose={() => setForgetting(false)}
        onConfirm={async () => {
          const next = await m6.updateEnvironment(env.id, { connection: { hostKey: null } });
          setForgetting(false);
          onChanged(next);
          announce(HOST_KEY_TEXT.forgotten({ host: c.host }));
        }}
      />
    </div>
  );
}
