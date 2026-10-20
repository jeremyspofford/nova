// Snapshots of a cloud environment's work folder (docs/13 §3: snapshots before risky steps,
// restore on failure): take one with an optional label, restore one (it replaces the folder, so it
// asks first and offers to snapshot the current state before), and delete one (asks first). Work
// runs take one before they start. Caches are kept across restores.
import { useId, useState } from 'react';
import { defineMessages } from '@nova/i18n';
import type { CloudSnapshotView } from '@nova/shared';
import { Button, EmptyState, Icon, Spinner, TextField, useToast } from '@nova/ui';
import { useAnnounce } from '../services.tsx';
import { formatWhen } from '../settings/common.ts';
import { useCloudApi } from './api.ts';
import { SNAPSHOT_EVENTS, eventEnvironmentId, useCloudEvents } from './events.ts';
import { CLOUD_TEXT, SNAPSHOT_REASON, cloudErrorMessage, formatBytes } from './format.ts';
import { ConfirmAction, useLoad } from './parts.tsx';

/** An environment's snapshots. {when} is a time, such as "5 minutes ago". */
export const SNAPSHOTS_TEXT = defineMessages('cloud.snapshots', {
  heading: 'Snapshots',
  intro: 'A snapshot keeps the work folder as it is now. Restoring one puts it back; caches stay.',
  taken: 'Snapshot taken.',
  takeFailed: 'Could not take a snapshot.',
  label: 'Label (optional)',
  take: 'Take a snapshot',
  loadFailed: 'Could not load the snapshots.',
  loading: 'Loading the snapshots',
  empty: 'No snapshots yet',
  emptyHint: 'Take one before a risky change. Work runs take one before they start.',
  takenAt: 'Taken {when}',
  restoredAt: 'Restored {when}',
  restore: 'Restore…',
  restoreTitle: 'Restore this snapshot?',
  restoreBody:
    'The work folder goes back to how it was {when}. Changes made since then are replaced.',
  restoreConfirm: 'Restore',
  restoreFailed: 'Could not restore the snapshot.',
  restored: 'Snapshot restored.',
  keepCurrent: 'Snapshot the current state first, so this can be undone',
  deleteTitle: 'Delete this snapshot?',
  deleteBody: 'It cannot be restored afterwards.',
  deleteFailed: 'Could not delete the snapshot.',
  deleted: 'Snapshot deleted.',
});

export function CloudSnapshots({
  environmentId,
  disabled,
}: {
  environmentId: string;
  /** Why snapshots cannot be taken or restored now (the runner is off, the setup runs). */
  disabled: string | null;
}) {
  const api = useCloudApi();
  const toast = useToast();
  const announce = useAnnounce();
  const headingId = useId();
  const list = useLoad(
    () => api.listCloudSnapshots(environmentId).then((r) => r.items),
    `snapshots:${environmentId}`,
  );
  useCloudEvents(
    SNAPSHOT_EVENTS,
    (env) => {
      if (eventEnvironmentId(env) === environmentId) list.reload();
    },
    list.reload,
  );
  const [label, setLabel] = useState('');
  const [taking, setTaking] = useState(false);
  const [takeError, setTakeError] = useState<string | null>(null);
  const [restoring, setRestoring] = useState<CloudSnapshotView | null>(null);
  const [keepCurrent, setKeepCurrent] = useState(true);
  const [deleting, setDeleting] = useState<CloudSnapshotView | null>(null);

  const S = SNAPSHOTS_TEXT;
  const take = async () => {
    setTaking(true);
    setTakeError(null);
    try {
      const s = await api.createCloudSnapshot(environmentId, label.trim() || undefined);
      list.setData((prev) => [s, ...(prev ?? []).filter((x) => x.id !== s.id)]);
      setLabel('');
      announce(S.taken);
    } catch (err) {
      setTakeError(cloudErrorMessage(err, S.takeFailed));
    } finally {
      setTaking(false);
    }
  };

  const items = list.data;
  return (
    <section className="ws-section" aria-labelledby={headingId}>
      <h3 id={headingId}>{S.heading}</h3>
      <p className="muted">{S.intro}</p>
      <form
        className="cl-inline-form"
        onSubmit={(e) => {
          e.preventDefault();
          void take();
        }}
      >
        <TextField
          label={S.label}
          value={label}
          maxLength={200}
          autoComplete="off"
          disabled={!!disabled}
          onChange={(e) => setLabel(e.target.value)}
        />
        <Button type="submit" disabled={taking || !!disabled} title={disabled ?? undefined}>
          {taking ? <Spinner /> : <Icon name="save" />} {S.take}
        </Button>
      </form>
      {disabled ? <p className="muted cl-small">{disabled}</p> : null}
      {takeError ? (
        <p className="nv-field-error" role="alert">
          {takeError}
        </p>
      ) : null}
      {list.error && !items ? (
        <div className="ws-error" role="alert">
          <p>{cloudErrorMessage(list.error, S.loadFailed)}</p>
          <Button onClick={list.reload}>{CLOUD_TEXT.retry}</Button>
        </div>
      ) : null}
      {list.loading ? <Spinner label={S.loading} /> : null}
      {items?.length === 0 ? (
        <EmptyState level={3} title={S.empty} description={S.emptyHint} icon="save" />
      ) : null}
      {items?.length ? (
        <ul className="ws-list" aria-label={S.heading}>
          {items.map((s) => (
            <li
              key={s.id}
              className="ws-list-row"
              aria-label={s.label ?? SNAPSHOT_REASON[s.reason]}
            >
              <span className="cl-row-main">
                <span className="cl-strong" dir="auto">
                  {s.label ?? SNAPSHOT_REASON[s.reason]}
                </span>
                <span className="muted ws-row-meta">
                  <span>{SNAPSHOT_REASON[s.reason]}</span>
                  <span>{formatBytes(s.sizeBytes)}</span>
                  <span>{S.takenAt({ when: formatWhen(s.createdAt) })}</span>
                  {s.restoredAt ? (
                    <span>{S.restoredAt({ when: formatWhen(s.restoredAt) })}</span>
                  ) : null}
                </span>
              </span>
              <span className="ws-row-actions cl-actions">
                <Button
                  disabled={!!disabled}
                  title={disabled ?? undefined}
                  onClick={() => {
                    setKeepCurrent(true);
                    setRestoring(s);
                  }}
                >
                  <Icon name="undo" /> {S.restore}
                </Button>
                <Button variant="danger" onClick={() => setDeleting(s)}>
                  <Icon name="trash" /> {CLOUD_TEXT.deleteMore}
                </Button>
              </span>
            </li>
          ))}
        </ul>
      ) : null}
      <ConfirmAction
        open={restoring !== null}
        title={S.restoreTitle}
        description={S.restoreBody({ when: restoring ? formatWhen(restoring.createdAt) : '' })}
        confirmLabel={S.restoreConfirm}
        danger
        errorText={(err) => cloudErrorMessage(err, S.restoreFailed)}
        onClose={() => setRestoring(null)}
        onConfirm={async () => {
          if (!restoring) return;
          await api.restoreCloudSnapshot(restoring.id, keepCurrent);
          setRestoring(null);
          list.reload();
          toast.show(S.restored, { tone: 'success' });
        }}
      >
        <label className="cl-check">
          <input
            type="checkbox"
            checked={keepCurrent}
            onChange={(e) => setKeepCurrent(e.target.checked)}
          />
          {S.keepCurrent}
        </label>
      </ConfirmAction>
      <ConfirmAction
        open={deleting !== null}
        title={S.deleteTitle}
        description={S.deleteBody}
        confirmLabel={CLOUD_TEXT.delete}
        danger
        errorText={(err) => cloudErrorMessage(err, S.deleteFailed)}
        onClose={() => setDeleting(null)}
        onConfirm={async () => {
          if (!deleting) return;
          const gone = deleting.id;
          await api.deleteCloudSnapshot(gone);
          setDeleting(null);
          list.setData((prev) => prev?.filter((x) => x.id !== gone) ?? null);
          announce(S.deleted);
        }}
      />
    </section>
  );
}
