// Settings → Sync (FR-109, FR-112, FR-129, docs/13 §2): this device's offline copy (on or off as
// the Hub's grant says, its size, what it holds, when it last synced, Sync now and Load again),
// the changes waiting to send, every device that keeps a copy with its status (synced, pending,
// offline, error) and Load again, and History: the merge log with each conflict's two values,
// which won, which devices set them, and Restore. Lists follow the sync events on the app's
// stream and refresh while the page is open.
import { useCallback, useEffect, useId, useState } from 'react';
import type { SyncMergeEntryView, SyncReplicaView } from '@nova/shared';
import { Button, EmptyState, Icon, SelectField, Spinner, useToast } from '@nova/ui';
import { devicePath, DEVICES_PATH } from '../devices/format.ts';
import { useHubStream } from '../hub-events.ts';
import { useOffline } from '../offline/context.tsx';
import { bytesText, changesText } from '../offline/format.ts';
import { Chip, Confirm } from '../offline/parts.tsx';
import { QueuePanel } from '../offline/QueuePanel.tsx';
import { useSyncApi } from '../replica/api.ts';
import { entityName } from '../replica/views.ts';
import { navigate } from '../router.ts';
import { useAnnounce } from '../services.tsx';
import { formatWhen, useInterval } from '../settings/common.ts';
import {
  countsText,
  fieldLabel,
  KIND_LABEL,
  MERGE_REASON_TEXT,
  phaseSpec,
  replicaStatusSpec,
  sideWhen,
  sideWho,
  syncErrorMessage,
  valueText,
} from './format.ts';
import '../workspace.css';
import '../offline/offline.css';

export const SYNC_DEVICES_POLL_MS = 30_000;
const MERGE_PAGE = 50;

export function SyncPage() {
  const ids = {
    device: useId(),
    waiting: useId(),
    devices: useId(),
    history: useId(),
  };
  return (
    <div className="settings-page">
      <h2>Sync</h2>
      <section className="settings-section" aria-labelledby={ids.device}>
        <h3 id={ids.device}>This device</h3>
        <ThisDevice />
      </section>
      <section className="settings-section" id="waiting" aria-labelledby={ids.waiting}>
        <h3 id={ids.waiting}>Changes waiting to send</h3>
        <QueuePanel headingId={ids.waiting} />
      </section>
      <section className="settings-section" aria-labelledby={ids.devices}>
        <h3 id={ids.devices}>Devices with an offline copy</h3>
        <ReplicaDevices />
      </section>
      <section className="settings-section" aria-labelledby={ids.history}>
        <h3 id={ids.history}>History</h3>
        <p className="muted">
          When two changes to the same thing meet, the newer one wins and the other is kept here, so
          you can put it back.
        </p>
        <MergeLog />
      </section>
    </div>
  );
}

function DeviceLink({ id, text }: { id: string | null; text: string }) {
  const href = devicePath(id);
  return (
    <a
      href={href}
      onClick={(e) => {
        e.preventDefault();
        navigate(href);
      }}
    >
      {text}
    </a>
  );
}

// ---- this device -------------------------------------------------------------------------------------

function ThisDevice() {
  const { runtime, state } = useOffline();
  const toast = useToast();
  const announce = useAnnounce();
  const [reloading, setReloading] = useState(false);
  const r = state.replica;
  const offline = state.hub === 'offline';
  const pending = state.queue.filter((i) => i.status !== 'done').length;

  if (!runtime)
    return (
      <p className="muted">
        Offline features are not running in this window, so this device keeps no offline copy here.
      </p>
    );

  let about: React.ReactNode;
  if (r.phase === 'removed' || r.phase === 'unsupported' || r.phase === 'paused')
    about = <p>{r.reason}</p>;
  else if (r.granted === false && !r.deviceId)
    about = (
      <p className="muted">
        This browser is signed in to the Hub directly, not added as a device, so it keeps no offline
        copy. To keep one, add it as a device with the Offline copy scope in{' '}
        <DeviceLink id={null} text="Devices" />.
      </p>
    );
  else if (r.granted === false)
    about = (
      <p className="muted">
        The Hub has not given this device an offline copy. Give it the Offline copy scope on{' '}
        <DeviceLink id={r.deviceId} text="its page in Devices" />.
      </p>
    );
  else if (r.granted === null) about = <Spinner label="Checking this device" />;
  else
    about = (
      <p className="muted">
        This device keeps an encrypted copy of your chats, projects, memory, pages, schedules and
        settings, so you can read them and make changes while the Hub is unreachable. The Hub
        decides whether it may; change that on{' '}
        <DeviceLink id={r.deviceId} text="its page in Devices" />.
      </p>
    );

  const kept = r.granted === true && r.phase !== 'unsupported';
  return (
    <div className="stack">
      <div className="row">
        <span>Offline copy</span>
        <Chip spec={phaseSpec(r, offline)} />
      </div>
      {about}
      {r.phase === 'error' && r.reason ? (
        <div role="alert" className="ws-error">
          <p>{r.reason}</p>
          <Button onClick={() => void runtime.engine.pull()}>Retry</Button>
        </div>
      ) : null}
      {kept ? (
        <dl className="ws-dl sy-facts">
          <dt>Stored</dt>
          <dd>{bytesText(r.bytes)}, encrypted on this device</dd>
          <dt>Holds</dt>
          <dd>{countsText(r.counts)}</dd>
          <dt>Last synced</dt>
          <dd>{formatWhen(r.lastSyncAt)}</dd>
          <dt>Waiting to send</dt>
          <dd>{pending ? changesText(pending) : 'Nothing'}</dd>
        </dl>
      ) : null}
      {kept && offline ? (
        <p className="muted">The Hub is unreachable. Syncing starts again when it is back.</p>
      ) : null}
      {kept && !offline ? (
        <div className="row">
          <Button
            disabled={r.syncing || r.phase !== 'ready'}
            onClick={() => {
              void runtime.engine.pull().then(() => announce('This device is up to date.'));
            }}
          >
            {r.syncing ? <Spinner /> : <Icon name="refresh" />} Sync now
          </Button>
          <Button onClick={() => setReloading(true)} disabled={r.syncing}>
            Load again
          </Button>
        </div>
      ) : null}
      {reloading ? (
        <Confirm
          title="Load this device's offline copy again?"
          description="Nova deletes the copy on this device and loads it again from the Hub. Changes waiting to send stay and go out afterwards."
          confirmLabel="Load again"
          onClose={() => setReloading(false)}
          onConfirm={async () => {
            setReloading(false);
            await runtime.engine.reload();
            const after = runtime.getState().replica;
            if (after.phase === 'ready')
              toast.show('Offline copy loaded again.', { tone: 'success' });
            else if (after.reason) toast.show(after.reason, { tone: 'error' });
          }}
        />
      ) : null}
    </div>
  );
}

// ---- devices with a copy ------------------------------------------------------------------------------

function ReplicaDevices() {
  const api = useSyncApi();
  const { state: offline } = useOffline();
  const toast = useToast();
  const [items, setItems] = useState<SyncReplicaView[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [version, setVersion] = useState(0);
  const [resetting, setResetting] = useState<SyncReplicaView | null>(null);
  const reload = useCallback(() => setVersion((v) => v + 1), []);

  useEffect(() => {
    let alive = true;
    api.listSyncDevices().then(
      ({ items: list }) => {
        if (!alive) return;
        setItems(list);
        setError(null);
      },
      (err: unknown) => alive && setError(err),
    );
    return () => {
      alive = false;
    };
  }, [api, version]);
  useHubStream(
    [
      'sync.replica.reset',
      'sync.replica.revoked',
      'device.status.changed',
      'device.scopes.changed',
    ],
    reload,
    reload,
  );
  useInterval(reload, SYNC_DEVICES_POLL_MS);

  const mine = offline.replica.deviceId;
  if (error && !items)
    return (
      <div role="alert" className="ws-error">
        <p>{syncErrorMessage(error, 'Could not load the devices.')}</p>
        <Button onClick={reload}>Retry</Button>
      </div>
    );
  if (!items) return <Spinner label="Loading devices" />;
  if (!items.length)
    return (
      <EmptyState
        level={3}
        icon="server"
        title="No device keeps an offline copy"
        description="Give a device the Offline copy scope when you add it, or later on its page in Devices."
        action={<Button onClick={() => navigate(DEVICES_PATH)}>Open Devices</Button>}
      />
    );
  return (
    <>
      {error ? (
        <div role="alert" className="ws-error">
          <p>{syncErrorMessage(error, 'Could not refresh the devices.')}</p>
          <Button onClick={reload}>Retry</Button>
        </div>
      ) : null}
      <ul className="ws-list" aria-label="Devices with an offline copy">
        {items.map((d) => {
          const status = replicaStatusSpec(d.status);
          const detail = d.status === 'pending' ? `${changesText(d.behind)} to pull` : null;
          return (
            <li key={d.deviceId} className="ws-list-row" aria-label={d.name}>
              <div className="ws-source-main of-row-main">
                <strong>
                  {d.name}
                  {d.deviceId === mine ? ' (this device)' : ''}
                </strong>
                <Chip spec={status} detail={detail} />
                {d.status === 'error' && d.lastError ? (
                  <span className="of-reason">{d.lastError}</span>
                ) : null}
                <span className="muted ws-row-meta">
                  {d.platform ? `${d.platform} · ` : ''}last pulled {formatWhen(d.lastPullAt)} ·
                  last sent {formatWhen(d.lastPushAt)}
                </span>
                {d.revoked ? (
                  <span className="of-reason">Revoked: its copy can no longer sync.</span>
                ) : !d.granted ? (
                  <span className="of-reason">
                    No longer has the Offline copy scope: it removes its copy when it next connects.
                  </span>
                ) : null}
                {d.resetAt ? (
                  <span className="of-reason">
                    Asked to load its copy again {formatWhen(d.resetAt)}; it does so when it next
                    connects.
                  </span>
                ) : null}
              </div>
              <div className="row ws-row-actions">
                <DeviceLink id={d.deviceId} text="Device page" />
                {d.granted && !d.revoked ? (
                  <Button variant="ghost" onClick={() => setResetting(d)}>
                    Load again
                  </Button>
                ) : null}
              </div>
            </li>
          );
        })}
      </ul>
      {resetting ? (
        <Confirm
          title={`Load the copy on ${resetting.name} again?`}
          description="The device deletes its offline copy and loads it again from the Hub the next time it connects. Changes it has not sent yet stay on it."
          confirmLabel="Load again"
          onClose={() => setResetting(null)}
          onConfirm={async () => {
            const view = await api.resetSyncDevice(resetting.deviceId);
            setItems((list) => list?.map((x) => (x.deviceId === view.deviceId ? view : x)) ?? null);
            toast.show(`${resetting.name} will load its offline copy again.`, { tone: 'success' });
            setResetting(null);
          }}
        />
      ) : null}
    </>
  );
}

// ---- history (the merge log) ----------------------------------------------------------------------

type Filter = 'open' | 'restored' | 'all';

const FILTERS: { value: Filter; label: string }[] = [
  { value: 'open', label: 'Can be restored' },
  { value: 'restored', label: 'Restored' },
  { value: 'all', label: 'Everything' },
];

function MergeLog() {
  const api = useSyncApi();
  const { runtime, state: offline } = useOffline();
  const announce = useAnnounce();
  const toast = useToast();
  const [filter, setFilter] = useState<Filter>('open');
  const [data, setData] = useState<{ items: SyncMergeEntryView[]; more: boolean } | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [version, setVersion] = useState(0);
  const [older, setOlder] = useState(false);
  const [restoring, setRestoring] = useState<SyncMergeEntryView | null>(null);
  const reload = useCallback(() => setVersion((v) => v + 1), []);

  useEffect(() => {
    let alive = true;
    api.listMergeLog({ status: filter, limit: MERGE_PAGE }).then(
      ({ items }) => {
        if (!alive) return;
        setData({ items, more: items.length === MERGE_PAGE });
        setError(null);
      },
      (err: unknown) => alive && setError(err),
    );
    return () => {
      alive = false;
    };
  }, [api, filter, version]);
  useHubStream(['sync.conflict'], reload, reload);

  const showOlder = async () => {
    const last = data?.items.at(-1);
    if (!last) return;
    setOlder(true);
    try {
      const { items } = await api.listMergeLog({
        status: filter,
        limit: MERGE_PAGE,
        before: last.id,
      });
      setData((d) => ({
        items: [...(d?.items ?? []), ...items],
        more: items.length === MERGE_PAGE,
      }));
    } catch (err) {
      toast.show(syncErrorMessage(err, 'Could not load older entries.'), { tone: 'error' });
    } finally {
      setOlder(false);
    }
  };

  const mine = offline.replica.deviceId;
  const replica = runtime?.engine.replica ?? null;
  const title = (e: SyncMergeEntryView) => {
    const name = entityName(replica, e.kind, e.entityId);
    return `${KIND_LABEL[e.kind]}${name ? ` “${name}”` : ''} · ${fieldLabel(e.field)}`;
  };

  return (
    <div className="stack">
      <SelectField
        className="sy-filter"
        label="Show"
        value={filter}
        onChange={(v) => setFilter(v as Filter)}
        options={FILTERS}
      />
      {error && !data ? (
        <div role="alert" className="ws-error">
          <p>{syncErrorMessage(error, 'Could not load the history.')}</p>
          <Button onClick={reload}>Retry</Button>
        </div>
      ) : null}
      {!data && !error ? <Spinner label="Loading the history" /> : null}
      {data && !data.items.length ? (
        <EmptyState
          level={3}
          icon="check"
          title={filter === 'restored' ? 'Nothing was restored' : 'No conflicts'}
          description="When two devices change the same thing, the value that loses is kept here so you can restore it."
        />
      ) : null}
      {data?.items.length ? (
        <ul className="ws-list" aria-label="Merge log">
          {data.items.map((e) => (
            <li key={e.id} className="ws-card sy-entry" aria-label={title(e)}>
              <div className="sy-entry-head">
                <strong>{title(e)}</strong>
                {e.status === 'restored' ? (
                  <Chip
                    spec={{ text: 'Restored', tone: 'ready', icon: 'check' }}
                    detail={formatWhen(e.restoredAt)}
                  />
                ) : (
                  <Chip spec={{ text: 'Can be restored', tone: 'neutral', icon: 'undo' }} />
                )}
              </div>
              <p className="muted ws-row-meta">
                {MERGE_REASON_TEXT[e.reason]} Logged {formatWhen(e.createdAt)}.
              </p>
              <div className="sy-sides">
                <div className="sy-side" data-side="winner">
                  <h5>
                    <Icon name="check" /> Kept
                  </h5>
                  <p className="sy-value">{valueText(e.field, e.winner.value)}</p>
                  <span className="muted ws-row-meta">
                    By {sideWho(e.winner, mine)}, {sideWhen(e.winner)}
                  </span>
                </div>
                <div className="sy-side" data-side="lost">
                  <h5>
                    <Icon name="undo" /> Replaced
                  </h5>
                  <p className="sy-value">{valueText(e.field, e.lost.value)}</p>
                  <span className="muted ws-row-meta">
                    By {sideWho(e.lost, mine)}, {sideWhen(e.lost)}
                  </span>
                </div>
              </div>
              {e.status === 'open' ? (
                <div className="row">
                  <Button onClick={() => setRestoring(e)}>Restore the replaced value</Button>
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
      {data?.more ? (
        <div className="row">
          <Button onClick={() => void showOlder()} disabled={older}>
            {older ? <Spinner /> : null} Show older
          </Button>
        </div>
      ) : null}
      {restoring ? (
        <Confirm
          title="Restore the replaced value?"
          description="It replaces the value there now, which goes to the history in turn. Every device gets the change."
          confirmLabel="Restore"
          onClose={() => setRestoring(null)}
          onConfirm={async () => {
            try {
              const view = await api.restoreMergeEntry(restoring.id);
              setData((d) =>
                d
                  ? {
                      ...d,
                      items:
                        filter === 'open'
                          ? d.items.filter((x) => x.id !== view.id)
                          : d.items.map((x) => (x.id === view.id ? view : x)),
                    }
                  : d,
              );
              announce('Restored. The value it replaced is in the history.');
              toast.show('Restored.', { tone: 'success' });
              setRestoring(null);
              reload();
            } catch (err) {
              throw new Error(syncErrorMessage(err, 'Could not restore it.'), { cause: err });
            }
          }}
        >
          <div className="sy-sides">
            <div className="sy-side" data-side="lost">
              <h5>Puts back</h5>
              <p className="sy-value">{valueText(restoring.field, restoring.lost.value)}</p>
            </div>
            <div className="sy-side">
              <h5>In place of</h5>
              <p className="sy-value">{valueText(restoring.field, restoring.winner.value)}</p>
            </div>
          </div>
        </Confirm>
      ) : null}
    </div>
  );
}
