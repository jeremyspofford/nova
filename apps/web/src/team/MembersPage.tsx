// Settings → Members (decision 5 of ADR-095; FR-217, FR-113): the people of this Hub with their
// roles, and for the owner the one-use invitation links (shown once, with Copy and an expiry),
// the invitations with Withdraw, removing a member (their sessions end at once, so it asks first)
// and the OIDC sign-in providers. A member sees the people, read-only, and why they cannot change
// them. Joins, removals and invitations arrive live through the shared event stream. M8 adds the
// removed members, whose data is kept for a while, exported and deleted (RemovedMembers.tsx).
import { useId, useRef, useState } from 'react';
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
import { formatWhen, plural } from '../settings/common.ts';
import { useAnnounce } from '../services.tsx';
import { useSettings } from '../settings.tsx';
import { useDebounced } from '../work/events.ts';
import { useTeamApi } from './api.ts';
import { MEMBERS_EVENTS, useTeamEvents } from './events.ts';
import {
  INVITATION_HOURS,
  REMOVED_TEXT,
  ROLE_TEXT,
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
      <h2>Members</h2>
      <p className="muted ws-flush">
        People who use this Hub. Each person has their own account: their chats, memory, connectors
        and settings stay theirs. Only the owner invites and removes people.
      </p>
      {isMember ? (
        <p className="ws-callout team-owner-only ws-flush" role="note">
          <Icon name="shield" />
          <span>
            You are a member of this Hub. You can share chats with the people below and give tasks
            to team agents. Only the owner can invite or remove people.
          </span>
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
  const nameOf = (id: string | null) =>
    id
      ? personName(
          people?.find((p) => p.accountId === id),
          'the owner',
        )
      : null;

  return (
    <section className="settings-section" aria-labelledby={headingId}>
      <h3 id={headingId}>People</h3>
      {error && !people ? (
        <LoadError
          error={error}
          fallback="Could not load the people of this Hub."
          onRetry={onRetry}
        />
      ) : null}
      {!people && !error ? <Spinner label="Loading people" /> : null}
      {people ? (
        <ul className="ws-list" aria-label="People of this Hub">
          {people.map((p) => (
            <li key={p.accountId} className="ws-list-row team-person">
              <span className="team-person-main">
                <span className="team-strong">
                  {personName(p)}
                  {p.you ? <span className="muted"> (you)</span> : null}
                </span>
                <span className="ws-row-meta muted">
                  <span className="ws-badge">{ROLE_TEXT[p.role]}</span>
                  {p.username ? <span>@{p.username}</span> : null}
                  {p.role === 'member' && p.joinedAt ? (
                    <span>Joined {formatWhen(p.joinedAt)}</span>
                  ) : null}
                  {p.role === 'member' && p.invitedBy ? (
                    <span>Invited by {nameOf(p.invitedBy)}</span>
                  ) : null}
                </span>
              </span>
              {canRemove && p.role === 'member' && !p.you ? (
                <Button
                  variant="ghost"
                  aria-label={`Remove ${personName(p)}`}
                  onClick={() => setRemoving(p)}
                >
                  <Icon name="trash" /> Remove
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
      {people && people.length < 2 && canRemove ? (
        <p className="muted ws-flush">Nobody else uses this Hub yet. Invite someone below.</p>
      ) : null}
      <ConfirmDialog
        open={removing !== null}
        title={`Remove ${personName(removing)} from this Hub?`}
        description={REMOVED_TEXT.removeWhat(keepDays)}
        confirmLabel="Remove"
        danger
        onClose={() => setRemoving(null)}
        onConfirm={async () => {
          if (!removing) return;
          const out = await api.removeTeamMember(removing.accountId);
          const name = personName(removing);
          onRemoved(removing.accountId);
          setRemoving(null);
          const text = `${name} was removed. ${plural(out.sessionsEnded, 'session')} ended.`;
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
      'someone',
    );

  return (
    <section className="settings-section" aria-labelledby={headingId}>
      <div className="ws-section-header">
        <h3 id={headingId}>Invitations</h3>
        <Button variant="primary" onClick={() => setInviting(true)}>
          <Icon name="plus" /> Invite someone
        </Button>
      </div>
      <p className="muted ws-flush">
        An invitation is a link that works once. Whoever opens it joins this Hub as a member with
        their own account.
      </p>
      {error ? (
        <LoadError error={error} fallback="Could not load the invitations." onRetry={onRetry} />
      ) : null}
      {loading ? <Spinner label="Loading invitations" /> : null}
      {items && items.length === 0 ? (
        <EmptyState
          level={3}
          icon="at"
          title="No invitations yet"
          description="Invite someone to give them their own account on this Hub."
        />
      ) : null}
      {items && items.length > 0 ? (
        <ul className="ws-list" aria-label="Invitations">
          {items.map((inv) => (
            <li key={inv.id} className="ws-list-row">
              <span className="team-person-main">
                <span className="team-strong">{inv.label ?? 'Invitation'}</span>
                <span className="ws-row-meta muted">
                  <Chip spec={invitationChip(inv.status)} />
                  <span>Made {formatWhen(inv.createdAt)}</span>
                  {inv.status === 'pending' ? (
                    <span>Expires {untilText(inv.expiresAt)}</span>
                  ) : null}
                  {inv.status === 'redeemed' && inv.redeemedBy ? (
                    <span>
                      Used by {nameOf(inv.redeemedBy)} {formatWhen(inv.redeemedAt)}
                    </span>
                  ) : null}
                </span>
              </span>
              {inv.status === 'pending' ? (
                <Button
                  variant="ghost"
                  aria-label={`Withdraw ${inv.label ?? 'invitation'}`}
                  onClick={() => setWithdrawing(inv)}
                >
                  <Icon name="stop" /> Withdraw
                </Button>
              ) : null}
            </li>
          ))}
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
        title="Withdraw this invitation?"
        description="The link stops working. Nobody can join with it, and you can make a new one at any time."
        confirmLabel="Withdraw"
        danger
        onClose={() => setWithdrawing(null)}
        onConfirm={async () => {
          if (!withdrawing) return;
          const out = await api.revokeTeamInvitation(withdrawing.id);
          onChanged(out);
          setWithdrawing(null);
          toast.show('Invitation withdrawn.', { tone: 'success' });
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
    String(INVITATION_HOURS.some((h) => h.hours === defaultHours) ? defaultHours : 72),
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
      announce('Invitation link made. Copy it now: it is shown only once.');
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  if (created) {
    const expires = new Date(created.invitation.expiresAt).toLocaleString();
    return (
      <Dialog
        open
        title="Send this link"
        onClose={onClose}
        initialFocusRef={doneRef}
        className="ws-wide-dialog"
        footer={
          <Button ref={doneRef} variant="primary" onClick={onClose}>
            Done
          </Button>
        }
      >
        <div className="stack">
          <p className="ws-flush">
            This link works once and expires {untilText(created.invitation.expiresAt)} ({expires}
            ). It is shown only now, so copy it before you close this.
          </p>
          <div className="team-link-box">
            <code className="ws-code-inline team-break" data-testid="invitation-link">
              {created.url}
            </code>
            <CopyButton value={created.url} what="Invitation link" />
          </div>
          <p className="ws-warning">
            <Icon name="alert" /> Anyone with this link can join this Hub as a member. Send it only
            to the person you invite, through a channel you trust.
          </p>
        </div>
      </Dialog>
    );
  }

  return (
    <Dialog
      open
      title="Invite someone"
      description="They get their own account on this Hub: their own chats, memory and connectors."
      onClose={onClose}
      className="ws-wide-dialog"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" type="submit" form="team-invite-form" disabled={busy}>
            {busy ? <Spinner /> : null} Make the link
          </Button>
        </>
      }
    >
      <form id="team-invite-form" className="stack" onSubmit={(e) => void create(e)}>
        <TextField
          label="Who it is for (optional)"
          hint="Only you see this, to tell invitations apart."
          value={label}
          maxLength={100}
          onChange={(e) => setLabel(e.target.value)}
        />
        <SelectField
          label="The link works for"
          value={hours}
          onChange={setHours}
          options={INVITATION_HOURS.map((h) => ({ value: String(h.hours), label: h.label }))}
        />
        <FormError error={error} fallback="Could not make the invitation." />
      </form>
    </Dialog>
  );
}
