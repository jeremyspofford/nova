// Network → Wake helpers (FR-138; docs/22 §7): Wake-on-LAN packets cross only one network, so an
// always-on device with the Wake helper role sends them for the Hub. Which devices may wake
// others, which ones the Hub uses and in what order (`network.wakeHelpers`, saved through the
// network panel so it can be rolled back), and the recent wakes with the device that sent each.
import { useId, useRef, useState } from 'react';
import { defineMessages } from '@nova/i18n';
import type { WakeHelperView } from '@nova/shared';
import { Button, EmptyState, Icon, Spinner, useToast } from '@nova/ui';
import { focusMoved, formatWhen, moveItem } from '../settings/common.ts';
import { navigate } from '../router.ts';
import { useAnnounce } from '../services.tsx';
import { useDebounced } from '../work/events.ts';
import { useNetworkSurfaceApi, type NetworkPanel, type WakeLogEntry } from './api.ts';
import { WAKE_EVENTS, useNetworkEvents, wakeFromEvent } from './events.ts';
import { ADD_DEVICE_PATH, netErrorMessage, valuesText, wakeStatusChip } from './format.ts';
import { Chip, LoadError, useLoad } from './parts.tsx';

const S = defineMessages('netsurface.wake', {
  loadFailed: 'Could not load the Wake helpers.',
  loading: 'Loading the Wake helpers',
  refreshFailed: 'Could not refresh the Wake helpers.',
  intro:
    'A Wake-on-LAN signal only reaches computers on the same network. A Wake helper is an always-on device on that network (a NAS, a small PC) that sends it for the Hub. ' +
    'Wakes are limited per hour and recorded in the audit log.',
  saved: 'Wake helpers saved. You can roll this back from the Overview.',
  savedShort: 'Wake helpers saved.',
  saveFailed: 'Could not save the Wake helpers.',
  title: 'Wake helpers',
  empty: 'No Wake helpers yet',
  emptyHelp:
    'Add an always-on device on the same network as the computers you want to wake, and give it the Wake helper role. Until then the Hub sends the signal itself when it is on that network.',
  addDevice: 'Add a device',
  order: 'The Hub tries these in order, using the first one on the sleeping computer’s network.',
  noneChosen:
    'None chosen: the Hub uses any online Wake helper on the sleeping computer’s network, then sends the signal itself when it is on that network.',
  inUse: 'Wake helpers in use',
  gone: 'A device that is no longer a Wake helper',
  moveUp: 'Move {name} up',
  moveDown: 'Move {name} down',
  up: 'Up',
  down: 'Down',
  stopUsing: 'Stop using {name}',
  remove: 'Remove',
  others: 'Other Wake helpers',
  withRole: 'Devices with the Wake helper role',
  available: 'Available Wake helpers',
  chooseName: 'Use {name}',
  choose: 'Use',
  save: 'Save',
  reset: 'Reset',
  online: 'Online',
  offline: 'Offline',
  notAvailable: 'Not available',
  networks: 'networks {list}',
  networksUnknown: 'networks not reported yet',
  lastSeen: 'last seen {when}',
  notSeen: 'not seen yet',
  fixGone: 'Remove it, or give the device the Wake helper role again.',
  aDevice: 'A device',
  limited: 'not sent: the hourly limit was reached',
  noSender: 'nothing on its network could send it',
  byHub: 'sent by the Hub',
  through: 'sent through {name}',
  recent: 'Recent wakes',
  row: '{name}, {when}',
  none: 'No wakes yet. Wake a computer from its page in Devices.',
});

interface WakeData {
  panel: NetworkPanel;
  names: Map<string, string>;
}

const MAX_WAKES = 20;

/** The Hub's list (when it gives one) and the wakes seen live, newest first, without repeats. */
export function mergeWakes(
  fromHub: readonly WakeLogEntry[],
  live: readonly WakeLogEntry[],
): WakeLogEntry[] {
  const seen = new Set<string>();
  const out: WakeLogEntry[] = [];
  for (const w of [...live, ...fromHub]) {
    if (seen.has(w.id)) continue;
    seen.add(w.id);
    out.push(w);
  }
  return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, MAX_WAKES);
}

export function WakeSection() {
  const api = useNetworkSurfaceApi();
  const data = useLoad<WakeData>(
    () =>
      Promise.all([api.getNetworkPanel(), api.getNetworkDiagnostics()]).then(([panel, diag]) => ({
        panel,
        names: new Map([
          ...panel.wakeHelpers.available.map((h) => [h.deviceId, h.name] as const),
          ...diag.devices.map((d) => [d.deviceId, d.name] as const),
        ]),
      })),
    'wake',
  );
  const [live, setLive] = useState<WakeLogEntry[]>([]);
  const reload = useDebounced(data.reload, 150);
  useNetworkEvents(
    WAKE_EVENTS,
    (env) => {
      if (env.name === 'device.wake.sent') {
        const w = wakeFromEvent(env);
        if (w) setLive((prev) => [w, ...prev].slice(0, MAX_WAKES));
        return;
      }
      reload();
    },
    reload,
  );
  const d = data.data;
  if (!d)
    return data.error ? (
      <LoadError error={data.error} fallback={S.loadFailed} onRetry={data.reload} />
    ) : (
      <Spinner label={S.loading} />
    );
  const fromHub = d.panel.wakeHelpers.recent;
  return (
    <div className="stack net-section">
      {data.error ? (
        <LoadError error={data.error} fallback={S.refreshFailed} onRetry={data.reload} />
      ) : null}
      <p className="muted ws-flush net-first">{S.intro}</p>
      <Helpers
        key={d.panel.wakeHelpers.configured.join(',')}
        panel={d.panel}
        onSaved={(next) => data.setData((prev) => (prev ? { ...prev, panel: next } : prev))}
      />
      <RecentWakes wakes={mergeWakes(fromHub, live)} names={d.names} />
    </div>
  );
}

function Helpers({ panel, onSaved }: { panel: NetworkPanel; onSaved: (p: NetworkPanel) => void }) {
  const api = useNetworkSurfaceApi();
  const toast = useToast();
  const announce = useAnnounce();
  const headingId = useId();
  const listRef = useRef<HTMLUListElement>(null);
  const { configured, available } = panel.wakeHelpers;
  const [chosen, setChosen] = useState<string[]>(configured);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const byId = new Map(available.map((h) => [h.deviceId, h]));
  const dirty = chosen.join(',') !== configured.join(',');
  const others = available.filter((h) => !chosen.includes(h.deviceId));

  const save = async () => {
    setBusy(true);
    setFailure(null);
    try {
      const next = await api.updateNetworkPanel({ wakeHelpers: chosen });
      onSaved(next);
      toast.show(S.saved, { tone: 'success' });
      announce(S.savedShort);
    } catch (err) {
      setFailure(netErrorMessage(err, S.saveFailed));
    } finally {
      setBusy(false);
    }
  };

  const move = (id: string, i: number, delta: number) => {
    setChosen((c) => moveItem(c, i, delta));
    focusMoved(listRef.current, id, delta < 0 ? 'up' : 'down');
  };

  if (available.length === 0 && configured.length === 0) {
    return (
      <section className="ws-section" aria-labelledby={headingId}>
        <h2 id={headingId}>{S.title}</h2>
        <EmptyState
          title={S.empty}
          level={3}
          icon="server"
          description={S.emptyHelp}
          action={<Button onClick={() => navigate(ADD_DEVICE_PATH)}>{S.addDevice}</Button>}
        />
      </section>
    );
  }

  return (
    <section className="ws-section" aria-labelledby={headingId}>
      <h2 id={headingId}>{S.title}</h2>
      <p className="muted">{chosen.length ? S.order : S.noneChosen}</p>
      {chosen.length ? (
        <ul className="ws-list" aria-label={S.inUse} ref={listRef}>
          {chosen.map((id, i) => {
            const h = byId.get(id);
            const name = h?.name ?? S.gone;
            return (
              <li key={id} className="ws-list-row" data-move-key={id} aria-label={name}>
                <HelperInfo h={h} name={name} />
                <div className="row">
                  <Button
                    variant="ghost"
                    data-move="up"
                    aria-label={S.moveUp({ name })}
                    disabled={i === 0}
                    onClick={() => move(id, i, -1)}
                  >
                    {S.up}
                  </Button>
                  <Button
                    variant="ghost"
                    data-move="down"
                    aria-label={S.moveDown({ name })}
                    disabled={i === chosen.length - 1}
                    onClick={() => move(id, i, 1)}
                  >
                    {S.down}
                  </Button>
                  <Button
                    aria-label={S.stopUsing({ name })}
                    onClick={() => setChosen((c) => c.filter((x) => x !== id))}
                  >
                    {S.remove}
                  </Button>
                </div>
              </li>
            );
          })}
        </ul>
      ) : null}
      {others.length ? (
        <>
          <h3 className="ws-subhead">{chosen.length ? S.others : S.withRole}</h3>
          <ul className="ws-list" aria-label={S.available}>
            {others.map((h) => (
              <li key={h.deviceId} className="ws-list-row" aria-label={h.name}>
                <HelperInfo h={h} name={h.name} />
                <Button
                  aria-label={S.chooseName({ name: h.name })}
                  onClick={() => setChosen((c) => [...c, h.deviceId])}
                >
                  {S.choose}
                </Button>
              </li>
            ))}
          </ul>
        </>
      ) : null}
      {failure ? (
        <p role="alert" className="nv-field-error">
          {failure}
        </p>
      ) : null}
      <div className="row">
        <Button variant="primary" disabled={!dirty || busy} onClick={() => void save()}>
          {busy ? <Spinner /> : null} {S.save}
        </Button>
        {dirty ? <Button onClick={() => setChosen(configured)}>{S.reset}</Button> : null}
      </div>
    </section>
  );
}

function HelperInfo({ h, name }: { h: WakeHelperView | undefined; name: string }) {
  return (
    <div className="net-row-main">
      <div className="net-row-head">
        <span className="net-strong">{name}</span>
        {h ? (
          h.status === 'active' ? (
            <Chip spec={{ text: S.online, tone: 'ready', icon: 'check' }} />
          ) : (
            <Chip
              spec={{
                text: h.status === 'unreachable' ? S.offline : h.status,
                tone: 'needs_input',
                icon: 'alert',
              }}
            />
          )
        ) : (
          <Chip spec={{ text: S.notAvailable, tone: 'blocked', icon: 'stop' }} />
        )}
      </div>
      {h ? (
        <span className="muted ws-row-meta">
          <span>
            {h.subnets.length ? S.networks({ list: valuesText(h.subnets) }) : S.networksUnknown}
          </span>
          {h.addresses.length ? <span>{valuesText(h.addresses)}</span> : null}
          <span>{h.lastSeenAt ? S.lastSeen({ when: formatWhen(h.lastSeenAt) }) : S.notSeen}</span>
        </span>
      ) : (
        <span className="muted net-small">{S.fixGone}</span>
      )}
    </div>
  );
}

function RecentWakes({ wakes, names }: { wakes: WakeLogEntry[]; names: Map<string, string> }) {
  const headingId = useId();
  const name = (id: string, given?: string | null) => given ?? names.get(id) ?? S.aDevice;
  const via = (w: WakeLogEntry) =>
    w.status === 'rate_limited'
      ? S.limited
      : !w.via
        ? S.noSender
        : w.via === 'hub'
          ? S.byHub
          : S.through({ name: name(w.via, w.viaName) });
  return (
    <section className="ws-section" aria-labelledby={headingId}>
      <h2 id={headingId}>{S.recent}</h2>
      {wakes.length ? (
        <ul className="ws-list" aria-label={S.recent} aria-live="polite">
          {wakes.map((w) => (
            <li
              key={w.id}
              className="ws-list-row"
              aria-label={S.row({
                name: name(w.deviceId, w.deviceName),
                when: formatWhen(w.createdAt),
              })}
            >
              <div className="net-row-main">
                <div className="net-row-head">
                  <span className="net-strong">{name(w.deviceId, w.deviceName)}</span>
                  <Chip spec={wakeStatusChip(w.status)} />
                </div>
                <span className="muted ws-row-meta">
                  <span>{via(w)}</span>
                  <span>{formatWhen(w.createdAt)}</span>
                  {w.mac ? <span>{w.mac}</span> : null}
                </span>
                {w.error ? <span className="net-why">{w.error}</span> : null}
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted ws-flush" aria-live="polite">
          <Icon name="clock" /> {S.none}
        </p>
      )}
    </section>
  );
}
