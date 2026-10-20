// Settings → Members (decision 5 of ADR-095; FR-217, FR-113): the people of this Hub with their
// roles, and for the owner the one-use invitation links (shown once, with Copy and an expiry),
// the invitations with Withdraw, removing a member (their sessions end at once, so it asks first)
// and the OIDC sign-in providers. A member sees the people, read-only, and why they cannot change
// them. Joins, removals and invitations arrive live through the shared event stream. M8 adds the
// removed members, whose data is kept for a while, exported and deleted (RemovedMembers.tsx).
import { useId, useRef, useState } from 'react';
import { defineMessages, fmt } from '@nova/i18n';
import type { CreatedInvitationView, InvitationView, TeamMemberView } from '@nova/shared';
import {
  Button,
  Dialog,
  EmptyState,
  Icon,
  SelectField,
  Spinner,
  TextField,
  useToast,
} from '@nova/ui';
import { formatWhen } from '../settings/common.ts';
import { useAnnounce } from '../services.tsx';
import { useSettings } from '../settings.tsx';
import { useDebounced } from '../work/events.ts';
import { useTeamApi } from './api.ts';
import { MEMBERS_EVENTS, useTeamEvents } from './events.ts';
import {
  INVITATION_HOURS,
  REMOVED_TEXT,
  ROLE_TEXT,
  TEAM_TEXT,
  invitationChip,
  personName,
  untilText,
} from './format.ts';
import { OidcProvidersSection } from './OidcProviders.tsx';
import { RemovedMembersSection } from './RemovedMembers.tsx';
import { Chip, ConfirmDialog, CopyButton, FormError, LoadError, useLoad } from './parts.tsx';
import { useTeamRole } from './role.tsx';
import '../workspace.css';
import './team.css';

const MEMBERS_TEXT = defineMessages('team.members', {
  title: 'Members',
  intro:
    'People who use this Hub. Each person has their own account: their chats, memory, connectors and settings stay theirs. Only the owner invites and removes people.',
  memberNote:
    'You are a member of this Hub. You can share chats with the people below and give tasks to team agents. Only the owner can invite or remove people.',
  people: 'People',
  loadFailed: 'Could not load the people of this Hub.',
  loading: 'Loading people',
  list: 'People of this Hub',
  joined: 'Joined {when}',
  invitedBy: 'Invited by {name}',
  invitedByOwner: 'Invited by the owner',
  removeLabel: 'Remove {name}',
  alone: 'Nobody else uses this Hub yet. Invite someone below.',
  removeTitle: 'Remove {name} from this Hub?',
  removed: '{name} was removed. {sessions, plural, one {# session} other {# sessions}} ended.',
});

const INVITATIONS_TEXT = defineMessages('team.members.invitations', {
  heading: 'Invitations',
  invite: 'Invite someone',
  intro:
    'An invitation is a link that works once. Whoever opens it joins this Hub as a member with their own account.',
  loadFailed: 'Could not load the invitations.',
  loading: 'Loading invitations',
  emptyTitle: 'No invitations yet',
  emptyDescription: 'Invite someone to give them their own account on this Hub.',
  unnamed: 'Invitation',
  expires: 'Expires {when}',
  usedBy: 'Used by {name} {when}',
  usedBySomeone: 'Used by someone {when}',
  withdrawLabel: 'Withdraw {label}',
  withdrawUnnamed: 'Withdraw invitation',
  withdraw: 'Withdraw',
  withdrawTitle: 'Withdraw this invitation?',
  withdrawWhat:
    'The link stops working. Nobody can join with it, and you can make a new one at any time.',
  withdrawn: 'Invitation withdrawn.',
  made: 'Invitation link made. Copy it now: it is shown only once.',
  sendTitle: 'Send this link',
  done: 'Done',
  worksOnce:
    'This link works once and expires {until} ({at}). It is shown only now, so copy it before you close this.',
  copy: {
    copy: 'Copy invitation link',
    copied: 'Invitation link copied.',
    failed: 'Could not copy. Select the invitation link and copy it yourself.',
  },
  warning:
    'Anyone with this link can join this Hub as a member. Send it only to the person you invite, through a channel you trust.',
  inviteTitle: 'Invite someone',
  inviteWhat: 'They get their own account on this Hub: their own chats, memory and connectors.',
  makeLink: 'Make the link',
  forWhom: 'Who it is for (optional)',
  forWhomHint: 'Only you see this, to tell invitations apart.',
  worksFor: 'The link works for',
  days: '{n, plural, one {# day} other {# days}}',
  createFailed: 'Could not make the invitation.',
});

export function MembersPage() {
  const api = useTeamApi();
  const { isMember, role } = useTeamRole();
  const owner = role === 'owner';
  const people = useLoad(() => api.listTeamMembers().then((r) => r.items), 'team-members');
  const invitations = useLoad(
    () => (owner ? api.listTeamInvitations().then((r) => r.items) : Promise.resolve([])),
    `team-invitations-${owner ? 'owner' : 'other'}`,
  );
  const reloadPeople = useDebounced(people.reload, 150);
  const reloadInvitations = useDebounced(invitations.reload, 150);
  useTeamEvents(
    MEMBERS_EVENTS,
    (env) => {
      if (env.name.startsWith('team.member.')) reloadPeople();
      reloadInvitations();
    },
    () => {
      reloadPeople();
      reloadInvitations();
    },
  );

  return (
    <div className="settings-page team-page">
      <h2>{MEMBERS_TEXT.title}</h2>
      <p className="muted ws-flush">{MEMBERS_TEXT.intro}</p>
      {isMember ? (
        <p className="ws-callout team-owner-only ws-flush" role="note">
          <Icon name="shield" />
          <span>{MEMBERS_TEXT.memberNote}</span>
        </p>
      ) : null}
      <People
        people={people.data}
        error={people.error}
        onRetry={people.reload}
        canRemove={owner}
        onRemoved={(accountId) =>
          people.setData((prev) => prev?.filter((p) => p.accountId !== accountId) ?? null)
        }
      />
      {owner ? (
        <>
          <Invitations
            items={invitations.data}
            error={invitations.error}
            loading={invitations.loading}
            people={people.data ?? []}
            onRetry={invitations.reload}
            onChanged={(inv) =>
              invitations.setData((prev) => {
                const rest = (prev ?? []).filter((x) => x.id !== inv.id);
                return [inv, ...rest].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
              })
            }
          />
          <RemovedMembersSection />
          <OidcProvidersSection />
        </>
      ) : null}
    </div>
  );
}

// ---- people ------------------------------------------------------------------------------------

function People({
  people,
  error,
  onRetry,
  canRemove,
  onRemoved,
}: {
  people: TeamMemberView[] | null;
  error: unknown;
  onRetry: () => void;
  canRemove: boolean;
  onRemoved: (accountId: string) => void;
}) {
  const api = useTeamApi();
  const toast = useToast();
  const announce = useAnnounce();
  const headingId = useId();
  const keepDays = useSettings().get('team.removedMemberPurgeDays').value;
  const [removing, setRemoving] = useState<TeamMemberView | null>(null);
  /** Who invited someone: a person's name, or null for the owner when they are not listed. */
  const nameOf = (id: string) => {
    const name = personName(
      people?.find((p) => p.accountId === id),
      '',
    );
    return name || null;
  };

  return (
    <section className="settings-section" aria-labelledby={headingId}>
      <h3 id={headingId}>{MEMBERS_TEXT.people}</h3>
      {error && !people ? (
        <LoadError error={error} fallback={MEMBERS_TEXT.loadFailed} onRetry={onRetry} />
      ) : null}
      {!people && !error ? <Spinner label={MEMBERS_TEXT.loading} /> : null}
      {people ? (
        <ul className="ws-list" aria-label={MEMBERS_TEXT.list}>
          {people.map((p) => {
            const inviter = p.invitedBy ? nameOf(p.invitedBy) : null;
            return (
              <li key={p.accountId} className="ws-list-row team-person">
                <span className="team-person-main">
                  <span className="team-strong">
                    <span dir="auto">{personName(p)}</span>
                    {p.you ? <span className="muted"> {TEAM_TEXT.youMark}</span> : null}
                  </span>
                  <span className="ws-row-meta muted">
                    <span className="ws-badge">{ROLE_TEXT[p.role]}</span>
                    {p.username ? <span dir="ltr">@{p.username}</span> : null}
                    {p.role === 'member' && p.joinedAt ? (
                      <span>{MEMBERS_TEXT.joined({ when: formatWhen(p.joinedAt) })}</span>
                    ) : null}
                    {p.role === 'member' && p.invitedBy ? (
                      <span>
                        {inviter
                          ? MEMBERS_TEXT.invitedBy({ name: inviter })
                          : MEMBERS_TEXT.invitedByOwner}
                      </span>
                    ) : null}
                  </span>
                </span>
                {canRemove && p.role === 'member' && !p.you ? (
                  <Button
                    variant="ghost"
                    aria-label={MEMBERS_TEXT.removeLabel({ name: personName(p) })}
                    onClick={() => setRemoving(p)}
                  >
                    <Icon name="trash" /> {TEAM_TEXT.remove}
                  </Button>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : null}
      {people && people.length < 2 && canRemove ? (
        <p className="muted ws-flush">{MEMBERS_TEXT.alone}</p>
      ) : null}
      <ConfirmDialog
        open={removing !== null}
        title={MEMBERS_TEXT.removeTitle({ name: personName(removing) })}
        description={REMOVED_TEXT.removeWhat({ days: keepDays })}
        confirmLabel={TEAM_TEXT.remove}
        danger
        onClose={() => setRemoving(null)}
        onConfirm={async () => {
          if (!removing) return;
          const out = await api.removeTeamMember(removing.accountId);
          const name = personName(removing);
          onRemoved(removing.accountId);
          setRemoving(null);
          const text = MEMBERS_TEXT.removed({ name, sessions: out.sessionsEnded });
          toast.show(text, { tone: 'success' });
          announce(text);
        }}
      />
    </section>
  );
}

// ---- invitations -------------------------------------------------------------------------------

function Invitations({
  items,
  error,
  loading,
  people,
  onRetry,
  onChanged,
}: {
  items: InvitationView[] | null;
  error: unknown;
  loading: boolean;
  people: TeamMemberView[];
  onRetry: () => void;
  onChanged: (inv: InvitationView) => void;
}) {
  const api = useTeamApi();
  const toast = useToast();
  const headingId = useId();
  const [inviting, setInviting] = useState(false);
  const [withdrawing, setWithdrawing] = useState<InvitationView | null>(null);
  const nameOf = (id: string) =>
    personName(
      people.find((p) => p.accountId === id),
      '',
    );

  return (
    <section className="settings-section" aria-labelledby={headingId}>
      <div className="ws-section-header">
        <h3 id={headingId}>{INVITATIONS_TEXT.heading}</h3>
        <Button variant="primary" onClick={() => setInviting(true)}>
          <Icon name="plus" /> {INVITATIONS_TEXT.invite}
        </Button>
      </div>
      <p className="muted ws-flush">{INVITATIONS_TEXT.intro}</p>
      {error ? (
        <LoadError error={error} fallback={INVITATIONS_TEXT.loadFailed} onRetry={onRetry} />
      ) : null}
      {loading ? <Spinner label={INVITATIONS_TEXT.loading} /> : null}
      {items && items.length === 0 ? (
        <EmptyState
          level={3}
          icon="at"
          title={INVITATIONS_TEXT.emptyTitle}
          description={INVITATIONS_TEXT.emptyDescription}
        />
      ) : null}
      {items && items.length > 0 ? (
        <ul className="ws-list" aria-label={INVITATIONS_TEXT.heading}>
          {items.map((inv) => {
            const usedBy = inv.redeemedBy ? nameOf(inv.redeemedBy) : '';
            const usedWhen = formatWhen(inv.redeemedAt);
            return (
              <li key={inv.id} className="ws-list-row">
                <span className="team-person-main">
                  <span className="team-strong" dir="auto">
                    {inv.label ?? INVITATIONS_TEXT.unnamed}
                  </span>
                  <span className="ws-row-meta muted">
                    <Chip spec={invitationChip(inv.status)} />
                    <span>{TEAM_TEXT.made({ when: formatWhen(inv.createdAt) })}</span>
                    {inv.status === 'pending' ? (
                      <span>{INVITATIONS_TEXT.expires({ when: untilText(inv.expiresAt) })}</span>
                    ) : null}
                    {inv.status === 'redeemed' && inv.redeemedBy ? (
                      <span>
                        {usedBy
                          ? INVITATIONS_TEXT.usedBy({ name: usedBy, when: usedWhen })
                          : INVITATIONS_TEXT.usedBySomeone({ when: usedWhen })}
                      </span>
                    ) : null}
                  </span>
                </span>
                {inv.status === 'pending' ? (
                  <Button
                    variant="ghost"
                    aria-label={
                      inv.label
                        ? INVITATIONS_TEXT.withdrawLabel({ label: inv.label })
                        : INVITATIONS_TEXT.withdrawUnnamed
                    }
                    onClick={() => setWithdrawing(inv)}
                  >
                    <Icon name="stop" /> {INVITATIONS_TEXT.withdraw}
                  </Button>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : null}
      {inviting ? (
        <InviteDialog
          onClose={() => setInviting(false)}
          onCreated={(created) => onChanged(created.invitation)}
        />
      ) : null}
      <ConfirmDialog
        open={withdrawing !== null}
        title={INVITATIONS_TEXT.withdrawTitle}
        description={INVITATIONS_TEXT.withdrawWhat}
        confirmLabel={INVITATIONS_TEXT.withdraw}
        danger
        onClose={() => setWithdrawing(null)}
        onConfirm={async () => {
          if (!withdrawing) return;
          const out = await api.revokeTeamInvitation(withdrawing.id);
          onChanged(out);
          setWithdrawing(null);
          toast.show(INVITATIONS_TEXT.withdrawn, { tone: 'success' });
        }}
      />
    </section>
  );
}

function InviteDialog({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (created: CreatedInvitationView) => void;
}) {
  const api = useTeamApi();
  const settings = useSettings();
  const announce = useAnnounce();
  const defaultHours = settings.get('team.invitationHours').value;
  const [label, setLabel] = useState('');
  const [hours, setHours] = useState(
    String(INVITATION_HOURS.includes(defaultHours) ? defaultHours : 72),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [created, setCreated] = useState<CreatedInvitationView | null>(null);
  const doneRef = useRef<HTMLButtonElement>(null);

  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const out = await api.createTeamInvitation({
        ...(label.trim() ? { label: label.trim() } : {}),
        ttlHours: Number(hours),
      });
      setCreated(out);
      onCreated(out);
      announce(INVITATIONS_TEXT.made);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  if (created) {
    const expiresAt = created.invitation.expiresAt;
    return (
      <Dialog
        open
        title={INVITATIONS_TEXT.sendTitle}
        onClose={onClose}
        initialFocusRef={doneRef}
        className="ws-wide-dialog"
        footer={
          <Button ref={doneRef} variant="primary" onClick={onClose}>
            {INVITATIONS_TEXT.done}
          </Button>
        }
      >
        <div className="stack">
          <p className="ws-flush">
            {INVITATIONS_TEXT.worksOnce({
              until: untilText(expiresAt),
              at: fmt.dateTime(expiresAt),
            })}
          </p>
          <div className="team-link-box">
            <code className="ws-code-inline team-break" data-testid="invitation-link">
              {created.url}
            </code>
            <CopyButton value={created.url} text={INVITATIONS_TEXT.copy} />
          </div>
          <p className="ws-warning">
            <Icon name="alert" /> {INVITATIONS_TEXT.warning}
          </p>
        </div>
      </Dialog>
    );
  }

  return (
    <Dialog
      open
      title={INVITATIONS_TEXT.inviteTitle}
      description={INVITATIONS_TEXT.inviteWhat}
      onClose={onClose}
      className="ws-wide-dialog"
      footer={
        <>
          <Button onClick={onClose}>{TEAM_TEXT.cancel}</Button>
          <Button variant="primary" type="submit" form="team-invite-form" disabled={busy}>
            {busy ? <Spinner /> : null} {INVITATIONS_TEXT.makeLink}
          </Button>
        </>
      }
    >
      <form id="team-invite-form" className="stack" onSubmit={(e) => void create(e)}>
        <TextField
          label={INVITATIONS_TEXT.forWhom}
          hint={INVITATIONS_TEXT.forWhomHint}
          value={label}
          maxLength={100}
          onChange={(e) => setLabel(e.target.value)}
        />
        <SelectField
          label={INVITATIONS_TEXT.worksFor}
          value={hours}
          onChange={setHours}
          options={INVITATION_HOURS.map((h) => ({
            value: String(h),
            label: INVITATIONS_TEXT.days({ n: h / 24 }),
          }))}
        />
        <FormError error={error} fallback={INVITATIONS_TEXT.createFailed} />
      </form>
    </Dialog>
  );
}
