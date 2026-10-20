// People who may message agents through channels (FR-088 identity mapping, FR-100): each
// external account maps to a role. In a private channel only owners are answered; in a shared
// one owners and members are, and others only when the channel allows unknown senders. Approvals
// can be answered from a channel only by an owner (and never `confirm_at_action` or
// `handoff_required` ones, which need a Nova client). Names are untrusted and shown as text.
import { useEffect, useId, useState } from 'react';
import { defineMessages } from '@nova/i18n';
import {
  channelIdentityM7Schema,
  type ChannelIdentityViewM7,
  type ChannelKindM7,
  type ChannelRole,
} from '@nova/shared';
import { Button, Dialog, Icon, SelectField, Spinner, TextField, useToast } from '@nova/ui';
import { errorMessage } from '../api.ts';
import { useChannelsApi } from './api.ts';
import { KIND_TEXT, errorField, issueErrors } from './format.ts';

const KINDS: ChannelKindM7[] = ['slack', 'teams', 'telegram', 'email', 'webhook'];

const ROLE_TEXT: Record<ChannelRole, string> = defineMessages('channels.people.role', {
  owner: 'Owner',
  member: 'Member',
});

const ID_HINT: Partial<Record<ChannelKindM7, string>> = defineMessages('channels.people.idHint', {
  slack: 'Their Slack member ID, like U0123ABCD.',
  teams: 'Their Teams user ID.',
  telegram: 'Their Telegram user ID, a number (not their @name).',
  webhook: 'The sender id your service sends in "from".',
  email:
    'Their email address. Mail counts as theirs only when their mail server vouches for it (DMARC), unless the channel trusts the From address.',
});

/** The People section's words (FR-016). Names and ids are the other service's data. */
export const PEOPLE_TEXT = defineMessages('channels.people', {
  title: 'People',
  intro:
    'Who agents answer in channels. In a private channel, only owners. In a shared channel, owners and members, and others only when the channel allows it. Only an owner can answer an approval from a channel.',
  loadFailed: 'Could not load people.',
  retry: 'Retry',
  loading: 'Loading people',
  empty: 'Nobody yet. Add yourself as an owner first.',
  list: 'People',
  removeName: 'Remove {name}',
  remove: 'Remove',
  addForm: 'Add a person',
  where: 'Where',
  theirId: 'Their ID',
  name: 'Name (optional)',
  role: 'Role',
  member: 'Member',
  ownerYou: 'Owner (you)',
  add: 'Add person',
  added: '{role, select, owner {{name} added as owner.} other {{name} added as member.}}',
  addFailed: 'Could not add the person.',
  addFailedWith: 'Could not add: {error}',
  removed: '{name} removed.',
  removeFailed: 'Could not remove: {error}',
  removeTitle: 'Remove {name}?',
  removeThis: 'Remove?',
  removeWhat: 'Agents stop answering them in channels that only answer known people.',
  cancel: 'Cancel',
});

export function PeopleSection() {
  const api = useChannelsApi();
  const toast = useToast();
  const id = useId();
  const [items, setItems] = useState<ChannelIdentityViewM7[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  const [kind, setKind] = useState<ChannelKindM7>('slack');
  const [externalId, setExternalId] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [role, setRole] = useState<ChannelRole>('member');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [removing, setRemoving] = useState<ChannelIdentityViewM7 | null>(null);

  useEffect(() => {
    let alive = true;
    api.listChannelIdentities().then(
      ({ items: list }) => {
        if (!alive) return;
        setItems(list);
        setError(null);
      },
      (err: unknown) => alive && setError(errorMessage(err, PEOPLE_TEXT.loadFailed)),
    );
    return () => {
      alive = false;
    };
  }, [api, version]);

  const add = async () => {
    const parsed = channelIdentityM7Schema.safeParse({
      kind,
      externalId,
      role,
      ...(displayName.trim() ? { displayName } : {}),
    });
    if (!parsed.success) {
      setErrors(issueErrors(parsed.error.issues));
      return;
    }
    setErrors({});
    setBusy(true);
    try {
      const v = await api.addChannelIdentity(parsed.data);
      setItems((list) => {
        const rest = (list ?? []).filter((x) => x.id !== v.id);
        return [...rest, v].sort(
          (a, b) => a.kind.localeCompare(b.kind) || a.externalId.localeCompare(b.externalId),
        );
      });
      setExternalId('');
      setDisplayName('');
      toast.show(PEOPLE_TEXT.added({ name: v.displayName ?? v.externalId, role: v.role }), {
        tone: 'success',
      });
    } catch (err) {
      const field = errorField(err);
      const message = errorMessage(err, PEOPLE_TEXT.addFailed);
      if (field) setErrors({ [field]: message });
      else toast.show(PEOPLE_TEXT.addFailedWith({ error: message }), { tone: 'error' });
    } finally {
      setBusy(false);
    }
  };

  const remove = async (p: ChannelIdentityViewM7) => {
    setRemoving(null);
    try {
      await api.removeChannelIdentity(p.id);
      setItems((list) => list?.filter((x) => x.id !== p.id) ?? null);
      toast.show(PEOPLE_TEXT.removed({ name: p.displayName ?? p.externalId }), {
        tone: 'success',
      });
    } catch (err) {
      toast.show(PEOPLE_TEXT.removeFailed({ error: errorMessage(err) }), { tone: 'error' });
    }
  };

  const S = PEOPLE_TEXT;
  return (
    <section className="settings-section" aria-labelledby={`${id}-h`}>
      <h3 id={`${id}-h`}>{S.title}</h3>
      <p className="muted">{S.intro}</p>
      {error ? (
        <div role="alert" className="ws-error">
          <p>{error}</p>
          <Button onClick={() => setVersion((v) => v + 1)}>{S.retry}</Button>
        </div>
      ) : null}
      {items === null && !error ? <Spinner label={S.loading} /> : null}
      {items?.length === 0 ? <p className="muted">{S.empty}</p> : null}
      {items?.length ? (
        <ul className="ws-list" aria-label={S.list}>
          {items.map((p) => (
            <li key={p.id} className="ws-list-row" aria-label={p.displayName ?? p.externalId}>
              <div className="ws-source-main">
                <strong className="ws-source-name" dir="auto">
                  {p.displayName ?? p.externalId}
                </strong>
                <span className="muted ws-row-meta">
                  <span>{KIND_TEXT[p.kind]}</span>
                  <code className="ws-code-inline">{p.externalId}</code>
                  <span className="ws-badge">
                    {p.role === 'owner' ? <Icon name="shield" /> : null}
                    {ROLE_TEXT[p.role]}
                  </span>
                </span>
              </div>
              <Button
                variant="ghost"
                aria-label={S.removeName({ name: p.displayName ?? p.externalId })}
                onClick={() => setRemoving(p)}
              >
                {S.remove}
              </Button>
            </li>
          ))}
        </ul>
      ) : null}
      <form
        className="ws-fieldset"
        aria-label={S.addForm}
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          void add();
        }}
      >
        <div className="row ch-person-form">
          <SelectField
            label={S.where}
            value={kind}
            onChange={(v) => setKind(v as ChannelKindM7)}
            options={KINDS.map((k) => ({ value: k, label: KIND_TEXT[k] }))}
          />
          <TextField
            label={S.theirId}
            value={externalId}
            spellCheck={false}
            autoComplete="off"
            hint={ID_HINT[kind]}
            error={errors.externalId}
            onChange={(e) => setExternalId(e.target.value)}
          />
          <TextField
            label={S.name}
            value={displayName}
            maxLength={200}
            error={errors.displayName}
            onChange={(e) => setDisplayName(e.target.value)}
          />
          <SelectField
            label={S.role}
            value={role}
            onChange={(v) => setRole(v as ChannelRole)}
            options={[
              { value: 'member', label: S.member },
              { value: 'owner', label: S.ownerYou },
            ]}
          />
        </div>
        <div className="row">
          <Button type="submit" disabled={busy}>
            <Icon name="plus" /> {S.add}
          </Button>
        </div>
      </form>
      <Dialog
        open={removing !== null}
        title={
          removing
            ? S.removeTitle({ name: removing.displayName ?? removing.externalId })
            : S.removeThis
        }
        description={S.removeWhat}
        onClose={() => setRemoving(null)}
        footer={
          <>
            <Button onClick={() => setRemoving(null)}>{S.cancel}</Button>
            <Button variant="danger" onClick={() => removing && void remove(removing)}>
              {S.remove}
            </Button>
          </>
        }
      />
    </section>
  );
}
