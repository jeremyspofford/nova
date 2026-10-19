// An SSH environment's host key (FR-062; docs/10 §2, M7): the key Nova pinned on first use with
// its SHA256 fingerprint (as `ssh-keygen -lf` prints it), so you can compare it with the host's;
// a different key later is refused and nothing is sent, and the row says what that means and what
// to check before replacing the pinned key. Replacing or forgetting it asks first. When SSH
// environments are off on this Hub, the row says where to turn them on.
import { useEffect, useId, useState } from 'react';
import type { SavedEnvironmentView } from '@nova/shared';
import { Button, Icon } from '@nova/ui';
import { ConfirmAction } from '../cloud/parts.tsx';
import { TextArea } from '../cloud/CloudEnvironmentDialog.tsx';
import { useAnnounce } from '../services.tsx';
import { useCodeM6Api } from './api-m6.ts';
import { AppLink } from './CodeNav.tsx';
import { codeM7ErrorMessage } from './m7-format.ts';

export const CODE_SETTINGS_PATH = '/settings/code';

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
    <div className="cm7-hostkey" aria-labelledby={id}>
      {isSshOff(env) ? (
        <p className="ws-callout" role="note">
          <Icon name="alert" />
          <span>
            SSH environments are off on this Hub, so Nova does not connect to {c.host}. Turn them on
            in <AppLink to={CODE_SETTINGS_PATH}>Settings → Code</AppLink>.
          </span>
        </p>
      ) : null}
      {mismatch ? (
        <div className="cl-notice" data-tone="danger" role="alert">
          <Icon name="shield" />
          <span>
            <strong>{c.host} answered with a different host key.</strong> Nova refused to connect
            and sent nothing. This happens when the machine was reinstalled or its keys were
            changed, and also when something is intercepting the connection. Check the key on the
            machine itself (for example with <code>ssh-keygen -lf</code> on its host key file)
            before you replace the pinned key.
          </span>
        </div>
      ) : null}
      <p className="cm7-hostkey-line">
        <span id={id} className="muted">
          {pinned ? 'Pinned host key' : 'Host key'}
          {pinned && key ? ` (${key.type})` : ''}:
        </span>{' '}
        {pinned ? (
          fp ? (
            <code className="cl-break">{fp}</code>
          ) : (
            <span>its fingerprint cannot be shown here.</span>
          )
        ) : (
          <span>not pinned yet. Nova pins the key the host shows on the first connection.</span>
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
          <Icon name="edit" /> {pinned ? 'Replace the pinned key…' : 'Pin a key…'}
        </Button>
        {pinned ? (
          <Button variant="ghost" onClick={() => setForgetting(true)}>
            <Icon name="trash" /> Forget the pinned key…
          </Button>
        ) : null}
      </div>
      <ConfirmAction
        open={replacing}
        title={pinned ? `Replace the host key of ${c.host}?` : `Pin a host key for ${c.host}`}
        description="Paste the host’s public key, as in its .pub file or known_hosts. Compare its fingerprint with the one the host shows."
        confirmLabel={pinned ? 'Replace key' : 'Pin key'}
        danger={!!pinned}
        errorText={(err) => codeM7ErrorMessage(err, 'Could not save the host key.')}
        onClose={() => setReplacing(false)}
        onConfirm={async () => {
          const k = parseHostKey(draft);
          if (!k) throw new Error('That is not a public key line such as “ssh-ed25519 AAAA…”.');
          const next = await m6.updateEnvironment(env.id, {
            connection: { hostKey: `${k.type} ${k.blob}` },
          });
          setReplacing(false);
          onChanged(next);
          announce(`The host key of ${c.host} is pinned.`);
        }}
      >
        <TextArea
          id={`${id}-key`}
          label="Host public key"
          value={draft}
          rows={3}
          placeholder="ssh-ed25519 AAAAC3Nza…"
          hint={draftFp ? `Its fingerprint: ${draftFp}` : undefined}
          onChange={setDraft}
        />
      </ConfirmAction>
      <ConfirmAction
        open={forgetting}
        title={`Forget the host key of ${c.host}?`}
        description="Nova then trusts whatever key the host shows on the next connection, and pins that. Do this only when you know why the key changed."
        confirmLabel="Forget key"
        danger
        errorText={(err) => codeM7ErrorMessage(err, 'Could not forget the host key.')}
        onClose={() => setForgetting(false)}
        onConfirm={async () => {
          const next = await m6.updateEnvironment(env.id, { connection: { hostKey: null } });
          setForgetting(false);
          onChanged(next);
          announce(`The host key of ${c.host} is forgotten.`);
        }}
      />
    </div>
  );
}
