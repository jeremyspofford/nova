// Settings → Account (FR-113, docs/13 §7; decision 5): who you are on this Hub (owner or member),
// the sign-in identities linked to your account (link one at an enabled provider, unlink one, and
// what came back from the provider: `?oidc=linked` or `?oidc_error=<reason>`), and your public
// profile card: off by default, on only when you opt in and the owner allows public cards on this
// Hub, with a preview of exactly what anyone can see.
import { useEffect, useId, useState } from 'react';
import { defineMessages } from '@nova/i18n';
import { profileHandleSchema, type OidcIdentityView, type ProfileCardView } from '@nova/shared';
import { Button, EmptyState, Icon, Spinner, TextField, useToast } from '@nova/ui';
import { navigate, useLocation } from '../router.ts';
import { useAnnounce, useServices } from '../services.tsx';
import { rich } from '../i18n/rich.tsx';
import { useSettings } from '../settings.tsx';
import { formatWhen } from '../settings/common.ts';
import { SwitchField } from '../settings/controls.tsx';
import { followLink } from '../work/nav.tsx';
import { useTeamApi } from './api.ts';
import {
  ACCOUNT_SETTINGS_PATH,
  MEMBERS_SETTINGS_PATH,
  ROLE_TEXT,
  TEAM_TEXT,
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

const ACCOUNT_TEXT = defineMessages('team.account', {
  title: 'Account',
  linked: 'Your identity is linked. You can now sign in with it.',
  youHeading: 'You on this Hub',
  ownerRole: 'You own this Hub: you invite people and change its settings.',
  memberRole:
    'You are a member: your chats, memory, connectors and settings are your own, and the owner runs the Hub.',
  loading: 'Loading your account',
  elsewhere: 'Your name and avatar are in {profile}; the people of this Hub are in {members}.',
  profileLink: 'Profile & usage',
  membersLink: 'Members',
});

const IDENTITY_TEXT = defineMessages('team.account.identities', {
  heading: 'Sign-in identities',
  intro:
    'Link an account you already have at a sign-in provider, then sign in to this Hub with it.',
  badAddress: 'The Hub sent an address this page will not open.',
  opening: 'Opening the sign-in provider.',
  loading: 'Loading your identities',
  list: 'Linked identities',
  linkedWhen: 'Linked {when}',
  lastSignIn: 'Last sign-in {when}',
  unlinkLabel: 'Unlink {provider}',
  unlink: 'Unlink',
  none: 'No identity is linked to your account.',
  providersFailed: 'Could not load the sign-in providers.',
  noProviders: 'No sign-in providers on this Hub',
  noProvidersMember: 'The owner of this Hub has not set one up.',
  noProvidersOwner:
    'Add one in Settings → Members to let people sign in with an account they already have.',
  link: 'Link {provider}',
  linkFailed: 'Could not start linking.',
  unlinkTitle: 'Unlink {provider}?',
  unlinkThis: 'Unlink this identity?',
  unlinkMember:
    'You can no longer sign in with it. If it is how you sign in, you will need a new invitation from the owner once this session ends.',
  unlinkOwner: 'You can no longer sign in with it until you link it again.',
  unlinked: '{provider} unlinked.',
});

const CARD_TEXT = defineMessages('team.account.card', {
  heading: 'Public profile card',
  loadFailed: 'Could not load your card.',
  loading: 'Loading your card',
  handleRule: '3 to 40 lowercase letters, digits, - or _, starting with a letter or digit.',
  on: 'Your public card is on.',
  savedPrivate: 'Your card is saved and not public.',
  intro:
    'A read-only card anyone can open without signing in, at a handle you choose. It is off unless you turn it on.',
  yours: 'Your card',
  show: 'Show my public card',
  showHint: 'Anyone who knows your handle can see the card below.',
  handle: 'Handle',
  handleHint: '3 to 40 lowercase letters, digits, - or _.',
  avatar: 'Show my avatar',
  noAvatar: 'You have no avatar; add one in Profile & usage.',
  whatIsPublic: 'What is public',
  anyoneSees: 'What anyone can see',
  anyoneWouldSee: 'What anyone would see if you turn it on',
  yourName: 'Your name',
  /** Stands in for the handle in the preview until one is typed. */
  handlePlaceholder: 'handle',
  nothingElse:
    'Nothing else is public: not your username, email, chats, memory or anything you made.',
  copy: {
    copy: 'Copy card address',
    copied: 'Card address copied.',
    failed: 'Could not copy. Select the card address and copy it yourself.',
  },
  saveFailed: 'Could not save your card.',
});

const HUB_CARDS_TEXT = defineMessages('team.account.hubCards', {
  allowed: 'Public profile cards are allowed.',
  off: 'Public profile cards are off.',
  saveFailed: 'Could not save.',
  label: 'Allow public profile cards on this Hub',
  description:
    'Off: no card is public, whatever each person chose. Each person still decides for their own card.',
  confirmTitle: 'Allow public profile cards?',
  confirmWhat:
    "Anyone who knows a handle can then open that person's card without signing in: their display name and, if they choose, their avatar. Only people who turn on their own card are shown.",
  allow: 'Allow',
});

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
      <h2>{ACCOUNT_TEXT.title}</h2>
      {back.linked ? (
        <p className="team-notice ws-flush" data-tone="ok" role="status">
          <Icon name="check" /> {ACCOUNT_TEXT.linked}
        </p>
      ) : null}
      {back.error ? (
        <p className="team-notice ws-flush" data-tone="bad" role="alert">
          <Icon name="alert" /> {oidcErrorText(back.error)}
        </p>
      ) : null}
      <section className="settings-section" aria-labelledby="team-account-you">
        <h3 id="team-account-you">{ACCOUNT_TEXT.youHeading}</h3>
        {me ? (
          <>
            <p className="ws-row-meta ws-flush">
              <span className="team-strong" dir="auto">
                {personName(me, TEAM_TEXT.you)}
              </span>
              <span className="ws-badge">{ROLE_TEXT[me.role]}</span>
            </p>
            <p className="ws-flush">
              {me.role === 'owner' ? ACCOUNT_TEXT.ownerRole : ACCOUNT_TEXT.memberRole}
            </p>
          </>
        ) : (
          <Spinner label={ACCOUNT_TEXT.loading} />
        )}
        <p className="muted ws-flush">
          {rich(ACCOUNT_TEXT.elsewhere, {
            profile: (
              <a href="/settings/profile" onClick={(e) => followLink(e, '/settings/profile')}>
                {ACCOUNT_TEXT.profileLink}
              </a>
            ),
            members: (
              <a href={MEMBERS_SETTINGS_PATH} onClick={(e) => followLink(e, MEMBERS_SETTINGS_PATH)}>
                {ACCOUNT_TEXT.membersLink}
              </a>
            ),
          })}
        </p>
      </section>
      <Identities
        identities={me?.identities ?? null}
        isMember={role === 'member'}
        onChanged={reload}
      />
      <ProfileCard
        displayName={me ? personName(me, TEAM_TEXT.you) : null}
        hasAvatar={!!me?.hasAvatar}
      />
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
      if (!isSafeExternalUrl(out.url)) throw new Error(IDENTITY_TEXT.badAddress);
      announce(IDENTITY_TEXT.opening);
      browser.leaveTo(out.url);
    } catch (err) {
      setFailure(err);
      setLinking(null);
    }
  };

  return (
    <section className="settings-section" aria-labelledby={headingId}>
      <h3 id={headingId}>{IDENTITY_TEXT.heading}</h3>
      <p className="muted ws-flush">{IDENTITY_TEXT.intro}</p>
      {identities === null ? <Spinner label={IDENTITY_TEXT.loading} /> : null}
      {identities && identities.length > 0 ? (
        <ul className="ws-list" aria-label={IDENTITY_TEXT.list}>
          {identities.map((i) => (
            <li key={i.id} className="ws-list-row">
              <span className="team-person-main">
                <span className="team-strong" dir="auto">
                  {i.providerLabel}
                </span>
                <span className="ws-row-meta muted">
                  <span className="team-break" dir="ltr">
                    {i.email ?? i.subject}
                  </span>
                  <span>{IDENTITY_TEXT.linkedWhen({ when: formatWhen(i.linkedAt) })}</span>
                  <span>{IDENTITY_TEXT.lastSignIn({ when: formatWhen(i.lastSignInAt) })}</span>
                </span>
              </span>
              <Button
                variant="ghost"
                aria-label={IDENTITY_TEXT.unlinkLabel({ provider: i.providerLabel })}
                onClick={() => setUnlinking(i)}
              >
                {IDENTITY_TEXT.unlink}
              </Button>
            </li>
          ))}
        </ul>
      ) : null}
      {identities && identities.length === 0 ? (
        <p className="ws-flush">{IDENTITY_TEXT.none}</p>
      ) : null}
      {providers.error ? (
        <LoadError
          error={providers.error}
          fallback={IDENTITY_TEXT.providersFailed}
          onRetry={providers.reload}
        />
      ) : null}
      {providers.data && providers.data.length === 0 ? (
        <EmptyState
          level={3}
          icon="shield"
          title={IDENTITY_TEXT.noProviders}
          description={isMember ? IDENTITY_TEXT.noProvidersMember : IDENTITY_TEXT.noProvidersOwner}
        />
      ) : null}
      {linkable.length > 0 ? (
        <div className="row team-actions">
          {linkable.map((p) => (
            <Button key={p.id} onClick={() => void link(p.id)} disabled={linking !== null}>
              {linking === p.id ? <Spinner /> : <Icon name="external" />}{' '}
              {IDENTITY_TEXT.link({ provider: p.label })}
            </Button>
          ))}
        </div>
      ) : null}
      <FormError error={failure} fallback={IDENTITY_TEXT.linkFailed} />
      <ConfirmDialog
        open={unlinking !== null}
        title={
          unlinking
            ? IDENTITY_TEXT.unlinkTitle({ provider: unlinking.providerLabel })
            : IDENTITY_TEXT.unlinkThis
        }
        description={isMember ? IDENTITY_TEXT.unlinkMember : IDENTITY_TEXT.unlinkOwner}
        confirmLabel={IDENTITY_TEXT.unlink}
        danger
        onClose={() => setUnlinking(null)}
        onConfirm={async () => {
          if (!unlinking) return;
          await api.unlinkOidcIdentity(unlinking.id);
          const label = unlinking.providerLabel;
          setUnlinking(null);
          onChanged();
          toast.show(IDENTITY_TEXT.unlinked({ provider: label }), { tone: 'success' });
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
        <h3 id={headingId}>{CARD_TEXT.heading}</h3>
        {card.error ? (
          <LoadError error={card.error} fallback={CARD_TEXT.loadFailed} onRetry={card.reload} />
        ) : (
          <Spinner label={CARD_TEXT.loading} />
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
      setFields({ handle: CARD_TEXT.handleRule });
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
      const text = out.enabled ? CARD_TEXT.on : CARD_TEXT.savedPrivate;
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
      <h3 id={headingId}>{CARD_TEXT.heading}</h3>
      <p className="muted ws-flush">{CARD_TEXT.intro}</p>
      {role === 'owner' ? (
        <>
          <HubSwitch />
          <h4 className="team-subhead">{CARD_TEXT.yours}</h4>
        </>
      ) : null}
      <form className="stack" onSubmit={(e) => void save(e)} noValidate>
        <SwitchField
          label={CARD_TEXT.show}
          description={CARD_TEXT.showHint}
          checked={d.enabled}
          onChange={(v) => set({ enabled: v })}
        />
        <TextField
          label={CARD_TEXT.handle}
          hint={CARD_TEXT.handleHint}
          value={d.handle}
          maxLength={40}
          autoCapitalize="none"
          spellCheck={false}
          onChange={(e) => set({ handle: e.target.value.toLowerCase() })}
          error={fields.handle}
        />
        <SwitchField
          label={CARD_TEXT.avatar}
          description={hasAvatar ? undefined : CARD_TEXT.noAvatar}
          checked={d.showAvatar}
          onChange={(v) => set({ showAvatar: v })}
        />
        <div role="group" className="team-preview" aria-label={CARD_TEXT.whatIsPublic}>
          <p className="team-preview-title muted">
            {d.enabled ? CARD_TEXT.anyoneSees : CARD_TEXT.anyoneWouldSee}
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
              <span className="team-strong" dir="auto">
                {displayName ?? CARD_TEXT.yourName}
              </span>
              <span className="muted" dir="ltr">
                @{d.handle || CARD_TEXT.handlePlaceholder}
              </span>
            </span>
          </div>
          <p className="muted ws-flush">{CARD_TEXT.nothingElse}</p>
          {c.enabled && c.handle && !dirty ? (
            <div className="team-link-box">
              <code className="ws-code-inline team-break">{publicCardUrl(c.handle)}</code>
              <CopyButton value={publicCardUrl(c.handle)} text={CARD_TEXT.copy} />
            </div>
          ) : null}
        </div>
        <div className="row">
          <Button type="submit" variant="primary" disabled={busy || !dirty}>
            {busy ? <Spinner /> : null} {TEAM_TEXT.save}
          </Button>
        </div>
        <FormError error={error} fallback={CARD_TEXT.saveFailed} />
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
    toast.show(v ? HUB_CARDS_TEXT.allowed : HUB_CARDS_TEXT.off, { tone: 'success' });
  };
  return (
    <>
      <SwitchField
        label={HUB_CARDS_TEXT.label}
        description={HUB_CARDS_TEXT.description}
        checked={entry.value}
        locked={entry.locked}
        onChange={(v) => {
          if (v) setAsking(true);
          else
            void write(false).catch((err: unknown) =>
              toast.show(teamErrorMessage(err, HUB_CARDS_TEXT.saveFailed), { tone: 'error' }),
            );
        }}
      />
      <ConfirmDialog
        open={asking}
        title={HUB_CARDS_TEXT.confirmTitle}
        description={HUB_CARDS_TEXT.confirmWhat}
        confirmLabel={HUB_CARDS_TEXT.allow}
        onClose={() => setAsking(false)}
        onConfirm={async () => {
          await write(true);
          setAsking(false);
        }}
      />
    </>
  );
}
