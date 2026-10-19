// Settings → Account (FR-113, docs/13 §7; decision 5): who you are on this Hub (owner or member),
// the sign-in identities linked to your account (link one at an enabled provider, unlink one, and
// what came back from the provider: `?oidc=linked` or `?oidc_error=<reason>`), and your public
// profile card: off by default, on only when you opt in and the owner allows public cards on this
// Hub, with a preview of exactly what anyone can see.
import { useEffect, useId, useState } from 'react';
import { profileHandleSchema, type OidcIdentityView, type ProfileCardView } from '@nova/shared';
import { Button, EmptyState, Icon, Spinner, TextField, useToast } from '@nova/ui';
import { navigate, useLocation } from '../router.ts';
import { useAnnounce, useServices } from '../services.tsx';
import { useSettings } from '../settings.tsx';
import { formatWhen } from '../settings/common.ts';
import { SwitchField } from '../settings/controls.tsx';
import { followLink } from '../work/nav.tsx';
import { useTeamApi } from './api.ts';
import {
  ACCOUNT_SETTINGS_PATH,
  MEMBERS_SETTINGS_PATH,
  ROLE_TEXT,
  errorFields,
  oidcErrorText,
  oidcReturn,
  personName,
  teamErrorMessage,
} from './format.ts';
import { browser, isSafeExternalUrl } from './leave.ts';
import { ConfirmDialog, CopyButton, FormError, LoadError, useLoad } from './parts.tsx';
import { useTeamRole } from './role.tsx';
import '../workspace.css';
import './team.css';

/** The public page of a card (the app's `/profile/<handle>`). */
export function publicCardUrl(handle: string): string {
  return `${window.location.origin}/profile/${encodeURIComponent(handle)}`;
}

export function AccountPage() {
  const loc = useLocation();
  const { me, role, reload } = useTeamRole();
  // What the provider sent back, read once; the address is cleaned so a reload does not repeat it.
  const [back] = useState(() => oidcReturn(loc.includes('?') ? loc.slice(loc.indexOf('?')) : ''));
  useEffect(() => {
    if (back.error || back.linked) navigate(ACCOUNT_SETTINGS_PATH, { replace: true });
  }, [back]);

  return (
    <div className="settings-page team-page">
      <h2>Account</h2>
      {back.linked ? (
        <p className="team-notice ws-flush" data-tone="ok" role="status">
          <Icon name="check" /> Your identity is linked. You can now sign in with it.
        </p>
      ) : null}
      {back.error ? (
        <p className="team-notice ws-flush" data-tone="bad" role="alert">
          <Icon name="alert" /> {oidcErrorText(back.error)}
        </p>
      ) : null}
      <section className="settings-section" aria-labelledby="team-account-you">
        <h3 id="team-account-you">You on this Hub</h3>
        {me ? (
          <>
            <p className="ws-row-meta ws-flush">
              <span className="team-strong">{personName(me, 'You')}</span>
              <span className="ws-badge">{ROLE_TEXT[me.role]}</span>
            </p>
            <p className="ws-flush">
              {me.role === 'owner'
                ? 'You own this Hub: you invite people and change its settings.'
                : 'You are a member: your chats, memory, connectors and settings are your own, and the owner runs the Hub.'}
            </p>
          </>
        ) : (
          <Spinner label="Loading your account" />
        )}
        <p className="muted ws-flush">
          Your name and avatar are in{' '}
          <a href="/settings/profile" onClick={(e) => followLink(e, '/settings/profile')}>
            Profile & usage
          </a>
          ; the people of this Hub are in{' '}
          <a href={MEMBERS_SETTINGS_PATH} onClick={(e) => followLink(e, MEMBERS_SETTINGS_PATH)}>
            Members
          </a>
          .
        </p>
      </section>
      <Identities
        identities={me?.identities ?? null}
        isMember={role === 'member'}
        onChanged={reload}
      />
      <ProfileCard displayName={me ? personName(me, 'You') : null} hasAvatar={!!me?.hasAvatar} />
    </div>
  );
}

// ---- sign-in identities --------------------------------------------------------------------

function Identities({
  identities,
  isMember,
  onChanged,
}: {
  identities: OidcIdentityView[] | null;
  isMember: boolean;
  onChanged: () => void;
}) {
  const api = useTeamApi();
  const toast = useToast();
  const announce = useAnnounce();
  const headingId = useId();
  const providers = useLoad(
    () => api.listPublicOidcProviders().then((r) => r.items),
    'oidc-public-providers',
  );
  const [linking, setLinking] = useState<string | null>(null);
  const [failure, setFailure] = useState<unknown>(null);
  const [unlinking, setUnlinking] = useState<OidcIdentityView | null>(null);
  const linked = new Set((identities ?? []).map((i) => i.providerId));
  const linkable = (providers.data ?? []).filter((p) => !linked.has(p.id));

  const link = async (providerId: string) => {
    setLinking(providerId);
    setFailure(null);
    try {
      const out = await api.startOidc({ providerId, flow: 'link' });
      if (!isSafeExternalUrl(out.url))
        throw new Error('The Hub sent an address this page will not open.');
      announce('Opening the sign-in provider.');
      browser.leaveTo(out.url);
    } catch (err) {
      setFailure(err);
      setLinking(null);
    }
  };

  return (
    <section className="settings-section" aria-labelledby={headingId}>
      <h3 id={headingId}>Sign-in identities</h3>
      <p className="muted ws-flush">
        Link an account you already have at a sign-in provider, then sign in to this Hub with it.
      </p>
      {identities === null ? <Spinner label="Loading your identities" /> : null}
      {identities && identities.length > 0 ? (
        <ul className="ws-list" aria-label="Linked identities">
          {identities.map((i) => (
            <li key={i.id} className="ws-list-row">
              <span className="team-person-main">
                <span className="team-strong">{i.providerLabel}</span>
                <span className="ws-row-meta muted">
                  <span className="team-break">{i.email ?? i.subject}</span>
                  <span>Linked {formatWhen(i.linkedAt)}</span>
                  <span>Last sign-in {formatWhen(i.lastSignInAt)}</span>
                </span>
              </span>
              <Button
                variant="ghost"
                aria-label={`Unlink ${i.providerLabel}`}
                onClick={() => setUnlinking(i)}
              >
                Unlink
              </Button>
            </li>
          ))}
        </ul>
      ) : null}
      {identities && identities.length === 0 ? (
        <p className="ws-flush">No identity is linked to your account.</p>
      ) : null}
      {providers.error ? (
        <LoadError
          error={providers.error}
          fallback="Could not load the sign-in providers."
          onRetry={providers.reload}
        />
      ) : null}
      {providers.data && providers.data.length === 0 ? (
        <EmptyState
          level={3}
          icon="shield"
          title="No sign-in providers on this Hub"
          description={
            isMember
              ? 'The owner of this Hub has not set one up.'
              : 'Add one in Settings → Members to let people sign in with an account they already have.'
          }
        />
      ) : null}
      {linkable.length > 0 ? (
        <div className="row team-actions">
          {linkable.map((p) => (
            <Button key={p.id} onClick={() => void link(p.id)} disabled={linking !== null}>
              {linking === p.id ? <Spinner /> : <Icon name="external" />} Link {p.label}
            </Button>
          ))}
        </div>
      ) : null}
      <FormError error={failure} fallback="Could not start linking." />
      <ConfirmDialog
        open={unlinking !== null}
        title={`Unlink ${unlinking?.providerLabel ?? 'this identity'}?`}
        description={
          isMember
            ? 'You can no longer sign in with it. If it is how you sign in, you will need a new invitation from the owner once this session ends.'
            : 'You can no longer sign in with it until you link it again.'
        }
        confirmLabel="Unlink"
        danger
        onClose={() => setUnlinking(null)}
        onConfirm={async () => {
          if (!unlinking) return;
          await api.unlinkOidcIdentity(unlinking.id);
          const label = unlinking.providerLabel;
          setUnlinking(null);
          onChanged();
          toast.show(`${label} unlinked.`, { tone: 'success' });
        }}
      />
    </section>
  );
}

// ---- public profile card -----------------------------------------------------------------------

function ProfileCard({
  displayName,
  hasAvatar,
}: {
  displayName: string | null;
  hasAvatar: boolean;
}) {
  const api = useTeamApi();
  const { api: hub } = useServices();
  const { role } = useTeamRole();
  const toast = useToast();
  const announce = useAnnounce();
  const headingId = useId();
  const card = useLoad(() => api.getProfileCard(), 'profile-card');
  const [draft, setDraft] = useState<{
    enabled: boolean;
    handle: string;
    showAvatar: boolean;
  } | null>(null);
  const [fields, setFields] = useState<Record<string, string>>({});
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const c = card.data;

  if (!c)
    return (
      <section className="settings-section" aria-labelledby={headingId}>
        <h3 id={headingId}>Public profile card</h3>
        {card.error ? (
          <LoadError
            error={card.error}
            fallback="Could not load your card."
            onRetry={card.reload}
          />
        ) : (
          <Spinner label="Loading your card" />
        )}
      </section>
    );

  const d = draft ?? { enabled: c.enabled, handle: c.handle ?? '', showAvatar: c.showAvatar };
  const set = (patch: Partial<typeof d>) => {
    setDraft({ ...d, ...patch });
    setFields({});
    setError(null);
  };
  const dirty =
    d.enabled !== c.enabled || d.handle !== (c.handle ?? '') || d.showAvatar !== c.showAvatar;

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    const handle = profileHandleSchema.safeParse(d.handle.trim());
    if (!handle.success) {
      setFields({
        handle: '3 to 40 lowercase letters, digits, - or _, starting with a letter or digit.',
      });
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const out: ProfileCardView = await api.setProfileCard({
        enabled: d.enabled,
        handle: handle.data,
        showAvatar: d.showAvatar,
      });
      card.setData(() => out);
      setDraft(null);
      const text = out.enabled ? 'Your public card is on.' : 'Your card is saved and not public.';
      toast.show(text, { tone: 'success' });
      announce(text);
    } catch (err) {
      setFields(errorFields(err));
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="settings-section" aria-labelledby={headingId}>
      <h3 id={headingId}>Public profile card</h3>
      <p className="muted ws-flush">
        A read-only card anyone can open without signing in, at a handle you choose. It is off
        unless you turn it on.
      </p>
      {role === 'owner' ? (
        <>
          <HubSwitch />
          <h4 className="team-subhead">Your card</h4>
        </>
      ) : null}
      <form className="stack" onSubmit={(e) => void save(e)} noValidate>
        <SwitchField
          label="Show my public card"
          description="Anyone who knows your handle can see the card below."
          checked={d.enabled}
          onChange={(v) => set({ enabled: v })}
        />
        <TextField
          label="Handle"
          hint="3 to 40 lowercase letters, digits, - or _."
          value={d.handle}
          maxLength={40}
          autoCapitalize="none"
          spellCheck={false}
          onChange={(e) => set({ handle: e.target.value.toLowerCase() })}
          error={fields.handle}
        />
        <SwitchField
          label="Show my avatar"
          description={hasAvatar ? undefined : 'You have no avatar; add one in Profile & usage.'}
          checked={d.showAvatar}
          onChange={(v) => set({ showAvatar: v })}
        />
        <div className="team-preview" aria-label="What is public">
          <p className="team-preview-title muted">
            {d.enabled ? 'What anyone can see' : 'What anyone would see if you turn it on'}
          </p>
          <div className="team-card" data-testid="card-preview">
            {d.showAvatar && hasAvatar ? (
              <img className="ws-avatar" src={hub.avatarUrl()} alt="" />
            ) : (
              <span className="ws-avatar ws-avatar-empty" aria-hidden="true">
                <Icon name="at" />
              </span>
            )}
            <span className="team-card-text">
              <span className="team-strong">{displayName ?? 'Your name'}</span>
              <span className="muted">@{d.handle || 'handle'}</span>
            </span>
          </div>
          <p className="muted ws-flush">
            Nothing else is public: not your username, email, chats, memory or anything you made.
          </p>
          {c.enabled && c.handle && !dirty ? (
            <div className="team-link-box">
              <code className="ws-code-inline team-break">{publicCardUrl(c.handle)}</code>
              <CopyButton value={publicCardUrl(c.handle)} what="Card address" />
            </div>
          ) : null}
        </div>
        <div className="row">
          <Button type="submit" variant="primary" disabled={busy || !dirty}>
            {busy ? <Spinner /> : null} Save
          </Button>
        </div>
        <FormError error={error} fallback="Could not save your card." />
      </form>
    </section>
  );
}

/** The owner's Hub-wide switch (`team.publicProfiles`); turning it on asks first. */
function HubSwitch() {
  const settings = useSettings();
  const toast = useToast();
  const entry = settings.get('team.publicProfiles');
  const [asking, setAsking] = useState(false);
  const write = async (v: boolean) => {
    await settings.set('team.publicProfiles', v);
    toast.show(v ? 'Public profile cards are allowed.' : 'Public profile cards are off.', {
      tone: 'success',
    });
  };
  return (
    <>
      <SwitchField
        label="Allow public profile cards on this Hub"
        description="Off: no card is public, whatever each person chose. Each person still decides for their own card."
        checked={entry.value}
        locked={entry.locked}
        onChange={(v) => {
          if (v) setAsking(true);
          else
            void write(false).catch((err: unknown) =>
              toast.show(teamErrorMessage(err, 'Could not save.'), { tone: 'error' }),
            );
        }}
      />
      <ConfirmDialog
        open={asking}
        title="Allow public profile cards?"
        description="Anyone who knows a handle can then open that person's card without signing in: their display name and, if they choose, their avatar. Only people who turn on their own card are shown."
        confirmLabel="Allow"
        onClose={() => setAsking(false)}
        onConfirm={async () => {
          await write(true);
          setAsking(false);
        }}
      />
    </>
  );
}
