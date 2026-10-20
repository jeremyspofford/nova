// Settings → Sync (FR-109, FR-112, FR-129, docs/13 §2): this device's offline copy (on or off as
// the Hub's grant says, its size, what it holds, when it last synced, Sync now and Load again),
// the changes waiting to send, every device that keeps a copy with its status (synced, pending,
// offline, error) and Load again, and History: the merge log with each conflict's two values,
// which won, which devices set them, and Restore. Lists follow the sync events on the app's
// stream and refresh while the page is open.
import { useCallback, useEffect, useId, useState } from 'react';
import { defineMessages, fmt } from '@nova/i18n';
import type { SyncMergeEntryView, SyncReplicaView } from '@nova/shared';
import { Button, EmptyState, Icon, SelectField, Spinner, useToast } from '@nova/ui';
import { devicePath, DEVICES_PATH } from '../devices/format.ts';
import { useHubStream } from '../hub-events.ts';
import { useOffline } from '../offline/context.tsx';
import { changesText } from '../offline/format.ts';
import { Chip, Confirm } from '../offline/parts.tsx';
import { QueuePanel } from '../offline/QueuePanel.tsx';
import { useSyncApi } from '../replica/api.ts';
import { replicaReason } from '../replica/engine.ts';
import { entityName } from '../replica/views.ts';
import { navigate } from '../router.ts';
import { useAnnounce } from '../services.tsx';
import { formatWhen, useInterval } from '../settings/common.ts';
import { embed } from '../settings/embed.tsx';
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

export const SYNC_TEXT = defineMessages('sync.page', {
  title: 'Sync',
  thisDevice: 'This device',
  waiting: 'Changes waiting to send',
  devices: 'Devices with an offline copy',
  history: 'History',
  historyAbout:
    'When two changes to the same thing meet, the newer one wins and the other is kept here, so you can put it back.',
});

export const DEVICE_TEXT = defineMessages('sync.device', {
  notRunning:
    'Offline features are not running in this window, so this device keeps no offline copy here.',
  notAdded:
    'This browser is signed in to the Hub directly, not added as a device, so it keeps no offline copy. To keep one, add it as a device with the Offline copy scope in {link}.',
  devicesLink: 'Devices',
  notGranted:
    'The Hub has not given this device an offline copy. Give it the Offline copy scope on {link}.',
  itsPage: 'its page in Devices',
  checking: 'Checking this device',
  about:
    'This device keeps an encrypted copy of your chats, projects, memory, pages, schedules and settings, so you can read them and make changes while the Hub is unreachable. The Hub decides whether it may; change that on {link}.',
  copy: 'Offline copy',
  retry: 'Retry',
  stored: 'Stored',
  storedSize: '{size}, encrypted on this device',
  holds: 'Holds',
  lastSynced: 'Last synced',
  waiting: 'Waiting to send',
  nothing: 'Nothing',
  hubAway: 'The Hub is unreachable. Syncing starts again when it is back.',
  upToDate: 'This device is up to date.',
  syncNow: 'Sync now',
  loadAgain: 'Load again',
  reloadTitle: "Load this device's offline copy again?",
  reloadBody:
    'Nova deletes the copy on this device and loads it again from the Hub. Changes waiting to send stay and go out afterwards.',
  reloaded: 'Offline copy loaded again.',
});

export const DEVICES_TEXT = defineMessages('sync.devices', {
  couldNotLoad: 'Could not load the devices.',
  couldNotRefresh: 'Could not refresh the devices.',
  retry: 'Retry',
  loading: 'Loading devices',
  emptyTitle: 'No device keeps an offline copy',
  emptyBody:
    'Give a device the Offline copy scope when you add it, or later on its page in Devices.',
  openDevices: 'Open Devices',
  list: 'Devices with an offline copy',
  toPull: '{n, plural, one {# change to pull} other {# changes to pull}}',
  mine: '{name} (this device)',
  meta: '{hasPlatform, select, yes {{platform} · last pulled {pulled} · last sent {pushed}} other {last pulled {pulled} · last sent {pushed}}}',
  revoked: 'Revoked: its copy can no longer sync.',
  notGranted: 'No longer has the Offline copy scope: it removes its copy when it next connects.',
  resetAsked: 'Asked to load its copy again {when}; it does so when it next connects.',
  devicePage: 'Device page',
  loadAgain: 'Load again',
  resetTitle: 'Load the copy on {name} again?',
  resetBody:
    'The device deletes its offline copy and loads it again from the Hub the next time it connects. Changes it has not sent yet stay on it.',
  resetDone: '{name} will load its offline copy again.',
});

export const HISTORY_TEXT = defineMessages('sync.history', {
  filter: { open: 'Can be restored', restored: 'Restored', all: 'Everything' },
  show: 'Show',
  couldNotLoad: 'Could not load the history.',
  couldNotLoadOlder: 'Could not load older entries.',
  retry: 'Retry',
  loading: 'Loading the history',
  nothingRestored: 'Nothing was restored',
  noConflicts: 'No conflicts',
  emptyBody:
    'When two devices change the same thing, the value that loses is kept here so you can restore it.',
  list: 'Merge log',
  /** An entry: what it is about ("Chat"), its name when known, and the field ("Title"). */
  entry: '{named, select, yes {{kind} “{name}” · {field}} other {{kind} · {field}}}',
  restored: 'Restored',
  restorable: 'Can be restored',
  logged: 'Logged {when}.',
  kept: 'Kept',
  replaced: 'Replaced',
  by: 'By {who}, {when}',
  restore: 'Restore the replaced value',
  showOlder: 'Show older',
  restoreTitle: 'Restore the replaced value?',
  restoreBody:
    'It replaces the value there now, which goes to the history in turn. Every device gets the change.',
  restoreConfirm: 'Restore',
  restoredNote: 'Restored. The value it replaced is in the history.',
  restoredToast: 'Restored.',
  couldNotRestore: 'Could not restore it.',
  putsBack: 'Puts back',
  inPlaceOf: 'In place of',
});

export function SyncPage() {
  const ids = {
    device: useId(),
    waiting: useId(),
    devices: useId(),
    history: useId(),
  };
  return (
    <div className="settings-page">
      <h2>{SYNC_TEXT.title}</h2>
      <section className="settings-section" aria-labelledby={ids.device}>
        <h3 id={ids.device}>{SYNC_TEXT.thisDevice}</h3>
        <ThisDevice />
      </section>
      <section className="settings-section" id="waiting" aria-labelledby={ids.waiting}>
        <h3 id={ids.waiting}>{SYNC_TEXT.waiting}</h3>
        <QueuePanel headingId={ids.waiting} />
      </section>
      <section className="settings-section" aria-labelledby={ids.devices}>
        <h3 id={ids.devices}>{SYNC_TEXT.devices}</h3>
        <ReplicaDevices />
      </section>
      <section className="settings-section" aria-labelledby={ids.history}>
        <h3 id={ids.history}>{SYNC_TEXT.history}</h3>
        <p className="muted">{SYNC_TEXT.historyAbout}</p>
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

  if (!runtime) return <p className="muted">{DEVICE_TEXT.notRunning}</p>;

  let about: React.ReactNode;
  if (r.phase === 'removed' || r.phase === 'unsupported' || r.phase === 'paused')
    about = <p>{replicaReason(r)}</p>;
  else if (r.granted === false && !r.deviceId)
    about = (
      <p className="muted">
        {embed(DEVICE_TEXT.notAdded, {
          link: <DeviceLink id={null} text={DEVICE_TEXT.devicesLink} />,
        })}
      </p>
    );
  else if (r.granted === false)
    about = (
      <p className="muted">
        {embed(DEVICE_TEXT.notGranted, {
          link: <DeviceLink id={r.deviceId} text={DEVICE_TEXT.itsPage} />,
        })}
      </p>
    );
  else if (r.granted === null) about = <Spinner label={DEVICE_TEXT.checking} />;
  else
    about = (
      <p className="muted">
        {embed(DEVICE_TEXT.about, {
          link: <DeviceLink id={r.deviceId} text={DEVICE_TEXT.itsPage} />,
        })}
      </p>
    );

  const kept = r.granted === true && r.phase !== 'unsupported';
  return (
    <div className="stack">
      <div className="row">
        <span>{DEVICE_TEXT.copy}</span>
        <Chip spec={phaseSpec(r, offline)} />
      </div>
      {about}
      {r.phase === 'error' ? (
        <div role="alert" className="ws-error">
          <p>{replicaReason(r)}</p>
          <Button onClick={() => void runtime.engine.pull()}>{DEVICE_TEXT.retry}</Button>
        </div>
      ) : null}
      {kept ? (
        <dl className="ws-dl sy-facts">
          <dt>{DEVICE_TEXT.stored}</dt>
          <dd>{DEVICE_TEXT.storedSize({ size: fmt.bytes(r.bytes) })}</dd>
          <dt>{DEVICE_TEXT.holds}</dt>
          <dd>{countsText(r.counts)}</dd>
          <dt>{DEVICE_TEXT.lastSynced}</dt>
          <dd>{formatWhen(r.lastSyncAt)}</dd>
          <dt>{DEVICE_TEXT.waiting}</dt>
          <dd>{pending ? changesText(pending) : DEVICE_TEXT.nothing}</dd>
        </dl>
      ) : null}
      {kept && offline ? <p className="muted">{DEVICE_TEXT.hubAway}</p> : null}
      {kept && !offline ? (
        <div className="row">
          <Button
            disabled={r.syncing || r.phase !== 'ready'}
            onClick={() => {
              void runtime.engine.pull().then(() => announce(DEVICE_TEXT.upToDate));
            }}
          >
            {r.syncing ? <Spinner /> : <Icon name="refresh" />} {DEVICE_TEXT.syncNow}
          </Button>
          <Button onClick={() => setReloading(true)} disabled={r.syncing}>
            {DEVICE_TEXT.loadAgain}
          </Button>
        </div>
      ) : null}
      {reloading ? (
        <Confirm
          title={DEVICE_TEXT.reloadTitle}
          description={DEVICE_TEXT.reloadBody}
          confirmLabel={DEVICE_TEXT.loadAgain}
          onClose={() => setReloading(false)}
          onConfirm={async () => {
            setReloading(false);
            await runtime.engine.reload();
            const after = runtime.getState().replica;
            const why = replicaReason(after);
            if (after.phase === 'ready') toast.show(DEVICE_TEXT.reloaded, { tone: 'success' });
            else if (why) toast.show(why, { tone: 'error' });
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
        <p>{syncErrorMessage(error, DEVICES_TEXT.couldNotLoad)}</p>
        <Button onClick={reload}>{DEVICES_TEXT.retry}</Button>
      </div>
    );
  if (!items) return <Spinner label={DEVICES_TEXT.loading} />;
  if (!items.length)
    return (
      <EmptyState
        level={3}
        icon="server"
        title={DEVICES_TEXT.emptyTitle}
        description={DEVICES_TEXT.emptyBody}
        action={<Button onClick={() => navigate(DEVICES_PATH)}>{DEVICES_TEXT.openDevices}</Button>}
      />
    );
  return (
    <>
      {error ? (
        <div role="alert" className="ws-error">
          <p>{syncErrorMessage(error, DEVICES_TEXT.couldNotRefresh)}</p>
          <Button onClick={reload}>{DEVICES_TEXT.retry}</Button>
        </div>
      ) : null}
      <ul className="ws-list" aria-label={DEVICES_TEXT.list}>
        {items.map((d) => {
          const status = replicaStatusSpec(d.status);
          const detail = d.status === 'pending' ? DEVICES_TEXT.toPull({ n: d.behind }) : null;
          return (
            <li key={d.deviceId} className="ws-list-row" aria-label={d.name}>
              <div className="ws-source-main of-row-main">
                <strong>
                  {d.deviceId === mine ? DEVICES_TEXT.mine({ name: d.name }) : d.name}
                </strong>
                <Chip spec={status} detail={detail} />
                {d.status === 'error' && d.lastError ? (
                  <span className="of-reason">{d.lastError}</span>
                ) : null}
                <span className="muted ws-row-meta">
                  {DEVICES_TEXT.meta({
                    hasPlatform: d.platform ? 'yes' : 'no',
                    platform: d.platform ?? '',
                    pulled: formatWhen(d.lastPullAt),
                    pushed: formatWhen(d.lastPushAt),
                  })}
                </span>
                {d.revoked ? (
                  <span className="of-reason">{DEVICES_TEXT.revoked}</span>
                ) : !d.granted ? (
                  <span className="of-reason">{DEVICES_TEXT.notGranted}</span>
                ) : null}
                {d.resetAt ? (
                  <span className="of-reason">
                    {DEVICES_TEXT.resetAsked({ when: formatWhen(d.resetAt) })}
                  </span>
                ) : null}
              </div>
              <div className="row ws-row-actions">
                <DeviceLink id={d.deviceId} text={DEVICES_TEXT.devicePage} />
                {d.granted && !d.revoked ? (
                  <Button variant="ghost" onClick={() => setResetting(d)}>
                    {DEVICES_TEXT.loadAgain}
                  </Button>
                ) : null}
              </div>
            </li>
          );
        })}
      </ul>
      {resetting ? (
        <Confirm
          title={DEVICES_TEXT.resetTitle({ name: resetting.name })}
          description={DEVICES_TEXT.resetBody}
          confirmLabel={DEVICES_TEXT.loadAgain}
          onClose={() => setResetting(null)}
          onConfirm={async () => {
            const view = await api.resetSyncDevice(resetting.deviceId);
            setItems((list) => list?.map((x) => (x.deviceId === view.deviceId ? view : x)) ?? null);
            toast.show(DEVICES_TEXT.resetDone({ name: resetting.name }), { tone: 'success' });
            setResetting(null);
          }}
        />
      ) : null}
    </>
  );
}

// ---- history (the merge log) ----------------------------------------------------------------------

type Filter = 'open' | 'restored' | 'all';

const FILTERS: readonly Filter[] = ['open', 'restored', 'all'];

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
      toast.show(syncErrorMessage(err, HISTORY_TEXT.couldNotLoadOlder), { tone: 'error' });
    } finally {
      setOlder(false);
    }
  };

  const mine = offline.replica.deviceId;
  const replica = runtime?.engine.replica ?? null;
  const title = (e: SyncMergeEntryView) => {
    const name = entityName(replica, e.kind, e.entityId);
    return HISTORY_TEXT.entry({
      named: name ? 'yes' : 'no',
      name: name ?? '',
      kind: KIND_LABEL[e.kind],
      field: fieldLabel(e.field),
    });
  };

  return (
    <div className="stack">
      <SelectField
        className="sy-filter"
        label={HISTORY_TEXT.show}
        value={filter}
        onChange={(v) => setFilter(v as Filter)}
        options={FILTERS.map((value) => ({ value, label: HISTORY_TEXT.filter[value] }))}
      />
      {error && !data ? (
        <div role="alert" className="ws-error">
          <p>{syncErrorMessage(error, HISTORY_TEXT.couldNotLoad)}</p>
          <Button onClick={reload}>{HISTORY_TEXT.retry}</Button>
        </div>
      ) : null}
      {!data && !error ? <Spinner label={HISTORY_TEXT.loading} /> : null}
      {data && !data.items.length ? (
        <EmptyState
          level={3}
          icon="check"
          title={filter === 'restored' ? HISTORY_TEXT.nothingRestored : HISTORY_TEXT.noConflicts}
          description={HISTORY_TEXT.emptyBody}
        />
      ) : null}
      {data?.items.length ? (
        <ul className="ws-list" aria-label={HISTORY_TEXT.list}>
          {data.items.map((e) => (
            <li key={e.id} className="ws-card sy-entry" aria-label={title(e)}>
              <div className="sy-entry-head">
                <strong>{title(e)}</strong>
                {e.status === 'restored' ? (
                  <Chip
                    spec={{ text: HISTORY_TEXT.restored, tone: 'ready', icon: 'check' }}
                    detail={formatWhen(e.restoredAt)}
                  />
                ) : (
                  <Chip spec={{ text: HISTORY_TEXT.restorable, tone: 'neutral', icon: 'undo' }} />
                )}
              </div>
              <p className="muted ws-row-meta">
                {MERGE_REASON_TEXT[e.reason]}{' '}
                {HISTORY_TEXT.logged({ when: formatWhen(e.createdAt) })}
              </p>
              <div className="sy-sides">
                <div className="sy-side" data-side="winner">
                  <h5>
                    <Icon name="check" /> {HISTORY_TEXT.kept}
                  </h5>
                  <p className="sy-value" dir="auto">
                    {valueText(e.field, e.winner.value)}
                  </p>
                  <span className="muted ws-row-meta">
                    {HISTORY_TEXT.by({ who: sideWho(e.winner, mine), when: sideWhen(e.winner) })}
                  </span>
                </div>
                <div className="sy-side" data-side="lost">
                  <h5>
                    <Icon name="undo" /> {HISTORY_TEXT.replaced}
                  </h5>
                  <p className="sy-value" dir="auto">
                    {valueText(e.field, e.lost.value)}
                  </p>
                  <span className="muted ws-row-meta">
                    {HISTORY_TEXT.by({ who: sideWho(e.lost, mine), when: sideWhen(e.lost) })}
                  </span>
                </div>
              </div>
              {e.status === 'open' ? (
                <div className="row">
                  <Button onClick={() => setRestoring(e)}>{HISTORY_TEXT.restore}</Button>
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
      {data?.more ? (
        <div className="row">
          <Button onClick={() => void showOlder()} disabled={older}>
            {older ? <Spinner /> : null} {HISTORY_TEXT.showOlder}
          </Button>
        </div>
      ) : null}
      {restoring ? (
        <Confirm
          title={HISTORY_TEXT.restoreTitle}
          description={HISTORY_TEXT.restoreBody}
          confirmLabel={HISTORY_TEXT.restoreConfirm}
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
              announce(HISTORY_TEXT.restoredNote);
              toast.show(HISTORY_TEXT.restoredToast, { tone: 'success' });
              setRestoring(null);
              reload();
            } catch (err) {
              throw new Error(syncErrorMessage(err, HISTORY_TEXT.couldNotRestore), { cause: err });
            }
          }}
        >
          <div className="sy-sides">
            <div className="sy-side" data-side="lost">
              <h5>{HISTORY_TEXT.putsBack}</h5>
              <p className="sy-value" dir="auto">
                {valueText(restoring.field, restoring.lost.value)}
              </p>
            </div>
            <div className="sy-side">
              <h5>{HISTORY_TEXT.inPlaceOf}</h5>
              <p className="sy-value" dir="auto">
                {valueText(restoring.field, restoring.winner.value)}
              </p>
            </div>
          </div>
        </Confirm>
      ) : null}
    </div>
  );
}
