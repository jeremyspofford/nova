// Settings → Profile & usage (FR-113, FR-114; docs/14 §6): display name, username and avatar
// (PNG, JPEG or WebP up to 2 MB; no cropping), then local usage insights.
import { useEffect, useRef, useState } from 'react';
import type { AccountView } from '@nova/shared';
import { Button, Spinner, TextField, useToast } from '@nova/ui';
import { errorMessage, type UpdateProfileRequest } from '../api.ts';
import { formatBytes, readAsBase64 } from '../chat/attachments.ts';
import { useServices } from '../services.tsx';
import { UsageSection } from './UsageSection.tsx';
import '../workspace.css';

export const USERNAME = /^[a-z0-9][a-z0-9_-]{1,31}$/;
export const AVATAR_MAX_BYTES = 2 * 1024 * 1024;
const AVATAR_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const;
type AvatarMime = (typeof AVATAR_TYPES)[number];

/** Only what changed; null clears a field. An invalid username is an error, never sent. */
export function profileChanges(
  account: Pick<AccountView, 'displayName' | 'username'>,
  form: { displayName: string; username: string },
): { body: UpdateProfileRequest | null } | { error: string } {
  const name = form.displayName.trim();
  const user = form.username.trim();
  if (user && !USERNAME.test(user))
    return {
      error:
        'Use 2 to 32 lowercase letters, digits, hyphens and underscores, starting with a letter or digit.',
    };
  const body: UpdateProfileRequest = {};
  if ((name || null) !== account.displayName) body.displayName = name || null;
  if ((user || null) !== account.username) body.username = user || null;
  return { body: Object.keys(body).length ? body : null };
}

export function ProfilePage({ onDisplayName }: { onDisplayName?: (name: string | null) => void }) {
  return (
    <div className="settings-page">
      <h2>Profile &amp; usage</h2>
      <ProfileSection onDisplayName={onDisplayName} />
      <UsageSection />
    </div>
  );
}

function ProfileSection({ onDisplayName }: { onDisplayName?: (name: string | null) => void }) {
  const { api } = useServices();
  const toast = useToast();
  const [account, setAccount] = useState<AccountView | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const [form, setForm] = useState<{ displayName: string; username: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Bumped after each avatar change so the image is fetched again.
  const [avatarVersion, setAvatarVersion] = useState(0);
  const file = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let alive = true;
    api.getAccount().then(
      (a) => {
        if (!alive) return;
        setAccount(a);
        setLoadError(null);
      },
      (err: unknown) => alive && setLoadError(errorMessage(err, 'Could not load your profile.')),
    );
    return () => {
      alive = false;
    };
  }, [api, retry]);

  if (loadError)
    return (
      <section className="settings-section" aria-labelledby="profile-me">
        <h3 id="profile-me">Profile</h3>
        <div role="alert" className="ws-error">
          <p>{loadError}</p>
          <Button onClick={() => setRetry((r) => r + 1)}>Retry</Button>
        </div>
      </section>
    );
  if (!account) return <Spinner label="Loading your profile" />;

  const shown = form ?? {
    displayName: account.displayName ?? '',
    username: account.username ?? '',
  };
  const changes = profileChanges(account, shown);

  const saved = (a: AccountView, message: string) => {
    setAccount(a);
    onDisplayName?.(a.displayName);
    toast.show(message, { tone: 'success' });
  };

  const save = async () => {
    if ('error' in changes) {
      setError(changes.error);
      return;
    }
    if (!changes.body) return;
    setError(null);
    setFailure(null);
    setBusy(true);
    try {
      saved(await api.updateProfile(changes.body), 'Profile saved.');
      setForm(null);
    } catch (err) {
      setFailure(errorMessage(err, 'Could not save your profile.'));
    } finally {
      setBusy(false);
    }
  };

  const upload = async (f: File) => {
    if (!(AVATAR_TYPES as readonly string[]).includes(f.type)) {
      toast.show('Choose a PNG, JPEG or WebP image.', { tone: 'error' });
      return;
    }
    if (f.size > AVATAR_MAX_BYTES) {
      toast.show(`That image is ${formatBytes(f.size)}; the limit is 2 MB.`, { tone: 'error' });
      return;
    }
    setBusy(true);
    try {
      const data = await readAsBase64(f);
      saved(
        await api.updateProfile({ avatar: { mime: f.type as AvatarMime, data } }),
        'Avatar updated.',
      );
      setAvatarVersion((v) => v + 1);
    } catch (err) {
      toast.show(`Could not update your avatar: ${errorMessage(err)}`, { tone: 'error' });
    } finally {
      setBusy(false);
    }
  };

  const removeAvatar = async () => {
    setBusy(true);
    try {
      saved(await api.updateProfile({ avatar: null }), 'Avatar removed.');
      setAvatarVersion((v) => v + 1);
    } catch (err) {
      toast.show(`Could not remove your avatar: ${errorMessage(err)}`, { tone: 'error' });
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="settings-section" aria-labelledby="profile-me">
      <h3 id="profile-me">Profile</h3>
      <p className="muted">Your account is local to this Hub.</p>
      <div className="ws-avatar-row">
        {account.hasAvatar ? (
          <img
            className="ws-avatar"
            src={`${api.avatarUrl()}?v=${avatarVersion}`}
            alt="Your avatar"
            width={64}
            height={64}
          />
        ) : (
          <span className="ws-avatar ws-avatar-empty" aria-hidden="true">
            {(account.displayName ?? account.username ?? '?').slice(0, 1).toUpperCase()}
          </span>
        )}
        <div className="row">
          <Button onClick={() => file.current?.click()} disabled={busy}>
            {account.hasAvatar ? 'Change avatar' : 'Upload avatar'}
          </Button>
          {account.hasAvatar ? (
            <Button variant="ghost" onClick={() => void removeAvatar()} disabled={busy}>
              Remove avatar
            </Button>
          ) : null}
        </div>
        <input
          ref={file}
          type="file"
          accept={AVATAR_TYPES.join(',')}
          hidden
          aria-label="Avatar image"
          onChange={(e) => {
            const f = e.target.files?.[0];
            e.target.value = '';
            if (f) void upload(f);
          }}
        />
      </div>
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <TextField
          label="Display name"
          value={shown.displayName}
          maxLength={100}
          autoComplete="name"
          onChange={(e) => setForm({ ...shown, displayName: e.target.value })}
        />
        <TextField
          label="Username"
          value={shown.username}
          maxLength={32}
          spellCheck={false}
          autoComplete="username"
          hint="Optional. 2 to 32 lowercase letters, digits, hyphens and underscores."
          error={error ?? undefined}
          onChange={(e) => setForm({ ...shown, username: e.target.value })}
        />
        {failure ? (
          <p role="alert" className="nv-field-error">
            {failure}
          </p>
        ) : null}
        <div className="row">
          <Button
            type="submit"
            variant="primary"
            disabled={busy || ('body' in changes && changes.body === null)}
          >
            {busy ? <Spinner /> : null} Save profile
          </Button>
        </div>
      </form>
    </section>
  );
}
