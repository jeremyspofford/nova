// Settings → Members → Removed members (ADR-097, decision 5; owner only): how long a removed
// member's data is kept (`team.removedMemberPurgeDays`, 0 keeps it until the owner deletes it;
// managed policy can lock it), and each removed member with where their data stands (kept, to be
// deleted on a date, deleted, or a failed delete that is retried), an export of their data while
// it exists, and Delete now, which says exactly what goes and asks for an explicit confirmation.
// Live through the team's events.
import { useId, useRef, useState } from 'react';
import type { RemovedMemberView } from '@nova/shared';
import { Button, Dialog, Icon, Spinner, TextField, useToast } from '@nova/ui';
import { useSettings } from '../settings.tsx';
import { ManagedNote } from '../managed/ManagedNote.tsx';
import { formatWhen } from '../settings/common.ts';
import { useDebounced } from '../work/events.ts';
import { useTeamM8Api, type TeamM8Api } from './api-m8.ts';
import { useTeamEvents } from './events.ts';
import { REMOVED_TEXT, removedErrorMessage, untilText } from './format.ts';
import { Chip, LoadError, useLoad } from './parts.tsx';
import type { ChipSpec } from '../netsurface/format.ts';

/** Removals and purges change this list. */
export const REMOVED_EVENTS = ['team.member.removed', 'team.member.purged'] as const;

export function removedName(m: Pick<RemovedMemberView, 'displayName'>): string {
  return m.displayName?.trim() || REMOVED_TEXT.purgedName;
}

export function removedChip(m: RemovedMemberView): ChipSpec {
  switch (m.status) {
    case 'kept':
      return { text: REMOVED_TEXT.status.kept, tone: 'neutral', icon: 'clock' };
    case 'scheduled':
      return {
        text: REMOVED_TEXT.status.scheduled(m.purgeAfter ? untilText(m.purgeAfter) : 'soon'),
        tone: 'running',
        icon: 'clock',
      };
    case 'purged':
      return {
        text: REMOVED_TEXT.status.purged(formatWhen(m.purgedAt)),
        tone: 'ready',
        icon: 'check',
      };
    case 'failed':
      return { text: REMOVED_TEXT.status.failed, tone: 'blocked', icon: 'alert' };
    default:
      return { text: String(m.status), tone: 'neutral', icon: 'alert' };
  }
}

/** Rows and files a purge deleted. */
export function purgeTotals(m: RemovedMemberView): { rows: number; files: number } | null {
  if (!m.counts) return null;
  const rows = Object.values(m.counts.rows).reduce((a, b) => a + b, 0);
  return { rows, files: m.counts.blobs };
}

/** Shown only to a client that has the M8 team calls (an older Hub client has none). */
export function RemovedMembersSection() {
  const api: Partial<TeamM8Api> = useTeamM8Api();
  return typeof api.listRemovedMembers === 'function' ? <RemovedMembersBody /> : null;
}

function RemovedMembersBody() {
  const api = useTeamM8Api();
  const headingId = useId();
  const removed = useLoad(() => api.listRemovedMembers().then((r) => r.items), 'team-removed');
  const reload = useDebounced(removed.reload, 150);
  useTeamEvents(REMOVED_EVENTS, () => reload(), reload);
  const [purging, setPurging] = useState<RemovedMemberView | null>(null);

  const replace = (m: RemovedMemberView) =>
    removed.setData((prev) => prev?.map((x) => (x.accountId === m.accountId ? m : x)) ?? null);

  return (
    <section className="settings-section" aria-labelledby={headingId}>
      <h3 id={headingId}>{REMOVED_TEXT.heading}</h3>
      <p className="muted ws-flush">{REMOVED_TEXT.intro}</p>
      <KeepDays />
      {removed.error && !removed.data ? (
        <LoadError
          error={removed.error}
          fallback={REMOVED_TEXT.loadFailed}
          onRetry={removed.reload}
          what={REMOVED_TEXT.heading}
        />
      ) : null}
      {removed.loading ? <Spinner label={REMOVED_TEXT.loading} /> : null}
      {removed.data && removed.data.length === 0 ? (
        <p className="muted ws-flush">{REMOVED_TEXT.none}</p>
      ) : null}
      {removed.data && removed.data.length > 0 ? (
        <ul className="ws-list" aria-label={REMOVED_TEXT.listLabel}>
          {removed.data.map((m) => (
            <RemovedRow key={m.accountId} member={m} onPurge={() => setPurging(m)} />
          ))}
        </ul>
      ) : null}
      {purging ? (
        <PurgeDialog
          member={purging}
          onClose={() => setPurging(null)}
          onDone={(m) => {
            replace(m);
            setPurging(null);
          }}
        />
      ) : null}
    </section>
  );
}

function RemovedRow({ member: m, onPurge }: { member: RemovedMemberView; onPurge: () => void }) {
  const api = useTeamM8Api();
  const name = removedName(m);
  const totals = purgeTotals(m);
  return (
    <li className="ws-list-row team-person" aria-label={name}>
      <span className="team-person-main">
        <span className="team-strong">{name}</span>
        <span className="ws-row-meta muted">
          <Chip spec={removedChip(m)} />
          <span>{REMOVED_TEXT.removedWhen(formatWhen(m.removedAt))}</span>
          {m.status === 'purged' && m.cause ? (
            <span>{m.cause === 'request' ? REMOVED_TEXT.byRequest : REMOVED_TEXT.afterGrace}</span>
          ) : null}
        </span>
        {m.status === 'failed' && m.error ? (
          <span className="ws-warning">
            <Icon name="alert" /> {REMOVED_TEXT.failedWhy(m.error)}
          </span>
        ) : null}
        {m.status === 'purged' && totals ? (
          <span className="muted">{REMOVED_TEXT.counts(totals.rows, totals.files)}</span>
        ) : null}
        {m.status === 'purged' && m.cleanupPending ? (
          <span className="muted">{REMOVED_TEXT.cleanupPending}</span>
        ) : null}
        {m.status !== 'purged' && !m.exportable ? (
          <span className="muted">{REMOVED_TEXT.exportUnavailable}</span>
        ) : null}
      </span>
      {m.status !== 'purged' ? (
        <span className="row ws-row-actions">
          {m.exportable ? (
            <a
              className="nv-btn"
              data-variant="ghost"
              href={api.removedMemberExportUrl(m.accountId)}
              download
              aria-label={REMOVED_TEXT.exportLabel(name)}
            >
              <Icon name="download" /> {REMOVED_TEXT.export}
            </a>
          ) : null}
          <Button variant="ghost" aria-label={REMOVED_TEXT.purgeLabel(name)} onClick={onPurge}>
            <Icon name="trash" /> {REMOVED_TEXT.purge}
          </Button>
        </span>
      ) : null}
    </li>
  );
}

function PurgeDialog({
  member,
  onClose,
  onDone,
}: {
  member: RemovedMemberView;
  onClose: () => void;
  onDone: (m: RemovedMemberView) => void;
}) {
  const api = useTeamM8Api();
  const toast = useToast();
  const boxId = useId();
  const cancelRef = useRef<HTMLButtonElement>(null);
  const [sure, setSure] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const name = removedName(member);
  const purge = async () => {
    setBusy(true);
    setError(null);
    try {
      const out = await api.purgeRemovedMember(member.accountId);
      onDone(out);
      const ok = out.status === 'purged';
      const text = ok ? REMOVED_TEXT.purged(name) : REMOVED_TEXT.purgeFailed(name);
      toast.show(text, { tone: ok ? 'success' : 'error' });
    } catch (err) {
      setError(removedErrorMessage(err, 'Could not delete the data.'));
      setBusy(false);
    }
  };
  return (
    <Dialog
      open
      title={REMOVED_TEXT.purgeTitle(name)}
      description={REMOVED_TEXT.purgeWhat}
      onClose={onClose}
      initialFocusRef={cancelRef}
      className="ws-wide-dialog"
      footer={
        <>
          <Button ref={cancelRef} onClick={onClose}>
            {REMOVED_TEXT.cancel}
          </Button>
          <Button variant="danger" disabled={!sure || busy} onClick={() => void purge()}>
            {busy ? <Spinner /> : null} {REMOVED_TEXT.purgeButton}
          </Button>
        </>
      }
    >
      <div className="stack">
        {member.exportable ? <p className="ws-flush">{REMOVED_TEXT.purgeExportFirst}</p> : null}
        <label className="ws-check" htmlFor={boxId}>
          <input
            id={boxId}
            type="checkbox"
            checked={sure}
            onChange={(e) => setSure(e.target.checked)}
          />
          <span>{REMOVED_TEXT.purgeConfirm(name)}</span>
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

/** `team.removedMemberPurgeDays`: 0 to 3650, saved explicitly. */
function KeepDays() {
  const settings = useSettings();
  const toast = useToast();
  const entry = settings.get('team.removedMemberPurgeDays');
  const [value, setValue] = useState(String(entry.value));
  const [base, setBase] = useState(entry.value);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (base !== entry.value) {
    setBase(entry.value);
    setValue(String(entry.value));
  }
  const n = Number(value.trim());
  const valid = /^\d+$/.test(value.trim()) && n >= 0 && n <= 3650;
  const save = async () => {
    if (!valid) {
      setError(REMOVED_TEXT.keepInvalid);
      return;
    }
    setError(null);
    setBusy(true);
    try {
      await settings.set('team.removedMemberPurgeDays', n);
      toast.show(REMOVED_TEXT.keepSaved(n), { tone: 'success' });
    } catch (err) {
      setError(removedErrorMessage(err, 'Could not save it.'));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form
      className="row team-keep-days"
      noValidate
      aria-label={REMOVED_TEXT.keepFormLabel}
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <TextField
        label={REMOVED_TEXT.keepLabel}
        type="number"
        min={0}
        max={3650}
        className="ws-number"
        value={value}
        disabled={entry.locked}
        hint={REMOVED_TEXT.keepHint}
        error={error ?? undefined}
        onChange={(e) => setValue(e.target.value)}
      />
      <Button type="submit" disabled={entry.locked || busy || value.trim() === String(entry.value)}>
        {REMOVED_TEXT.save}
      </Button>
      {entry.locked ? <ManagedNote setting="team.removedMemberPurgeDays" as="p" /> : null}
    </form>
  );
}
