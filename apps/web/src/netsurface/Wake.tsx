// Network → Wake helpers (FR-138; docs/22 §7): Wake-on-LAN packets cross only one network, so an
// always-on device with the Wake helper role sends them for the Hub. Which devices may wake
// others, which ones the Hub uses and in what order (`network.wakeHelpers`, saved through the
// network panel so it can be rolled back), and the recent wakes with the device that sent each.
import { useId, useRef, useState } from 'react';
import type { WakeHelperView } from '@nova/shared';
import { Button, EmptyState, Icon, Spinner, useToast } from '@nova/ui';
import { focusMoved, formatWhen, moveItem } from '../settings/common.ts';
import { navigate } from '../router.ts';
import { useAnnounce } from '../services.tsx';
import { useDebounced } from '../work/events.ts';
import { useNetworkSurfaceApi, type NetworkPanel, type WakeLogEntry } from './api.ts';
import { WAKE_EVENTS, useNetworkEvents, wakeFromEvent } from './events.ts';
import { ADD_DEVICE_PATH, netErrorMessage, wakeStatusChip } from './format.ts';
import { Chip, LoadError, useLoad } from './parts.tsx';

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
      <LoadError
        error={data.error}
        fallback="Could not load the Wake helpers."
        onRetry={data.reload}
      />
    ) : (
      <Spinner label="Loading the Wake helpers" />
    );
  const fromHub = d.panel.wakeHelpers.recent;
  return (
    <div className="stack net-section">
      {data.error ? (
        <LoadError
          error={data.error}
          fallback="Could not refresh the Wake helpers."
          onRetry={data.reload}
        />
      ) : null}
      <p className="muted ws-flush net-first">
        A Wake-on-LAN signal only reaches computers on the same network. A Wake helper is an
        always-on device on that network (a NAS, a small PC) that sends it for the Hub. Wakes are
        limited per hour and recorded in the audit log.
      </p>
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
      toast.show('Wake helpers saved. You can roll this back from the Overview.', {
        tone: 'success',
      });
      announce('Wake helpers saved.');
    } catch (err) {
      setFailure(netErrorMessage(err, 'Could not save the Wake helpers.'));
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
        <h2 id={headingId}>Wake helpers</h2>
        <EmptyState
          title="No Wake helpers yet"
          level={3}
          icon="server"
          description="Add an always-on device on the same network as the computers you want to wake, and give it the Wake helper role. Until then the Hub sends the signal itself when it is on that network."
          action={<Button onClick={() => navigate(ADD_DEVICE_PATH)}>Add a device</Button>}
        />
      </section>
    );
  }

  return (
    <section className="ws-section" aria-labelledby={headingId}>
      <h2 id={headingId}>Wake helpers</h2>
      <p className="muted">
        {chosen.length
          ? 'The Hub tries these in order, using the first one on the sleeping computer’s network.'
          : 'None chosen: the Hub uses any online Wake helper on the sleeping computer’s network, then sends the signal itself when it is on that network.'}
      </p>
      {chosen.length ? (
        <ul className="ws-list" aria-label="Wake helpers in use" ref={listRef}>
          {chosen.map((id, i) => {
            const h = byId.get(id);
            const name = h?.name ?? 'A device that is no longer a Wake helper';
            return (
              <li key={id} className="ws-list-row" data-move-key={id} aria-label={name}>
                <HelperInfo h={h} name={name} />
                <div className="row">
                  <Button
                    variant="ghost"
                    data-move="up"
                    aria-label={`Move ${name} up`}
                    disabled={i === 0}
                    onClick={() => move(id, i, -1)}
                  >
                    Up
                  </Button>
                  <Button
                    variant="ghost"
                    data-move="down"
                    aria-label={`Move ${name} down`}
                    disabled={i === chosen.length - 1}
                    onClick={() => move(id, i, 1)}
                  >
                    Down
                  </Button>
                  <Button
                    aria-label={`Stop using ${name}`}
                    onClick={() => setChosen((c) => c.filter((x) => x !== id))}
                  >
                    Remove
                  </Button>
                </div>
              </li>
            );
          })}
        </ul>
      ) : null}
      {others.length ? (
        <>
          <h3 className="ws-subhead">
            {chosen.length ? 'Other Wake helpers' : 'Devices with the Wake helper role'}
          </h3>
          <ul className="ws-list" aria-label="Available Wake helpers">
            {others.map((h) => (
              <li key={h.deviceId} className="ws-list-row" aria-label={h.name}>
                <HelperInfo h={h} name={h.name} />
                <Button
                  aria-label={`Use ${h.name}`}
                  onClick={() => setChosen((c) => [...c, h.deviceId])}
                >
                  Use
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
          {busy ? <Spinner /> : null} Save
        </Button>
        {dirty ? <Button onClick={() => setChosen(configured)}>Reset</Button> : null}
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
            <Chip spec={{ text: 'Online', tone: 'ready', icon: 'check' }} />
          ) : (
            <Chip
              spec={{
                text: h.status === 'unreachable' ? 'Offline' : h.status,
                tone: 'needs_input',
                icon: 'alert',
              }}
            />
          )
        ) : (
          <Chip spec={{ text: 'Not available', tone: 'blocked', icon: 'stop' }} />
        )}
      </div>
      {h ? (
        <span className="muted ws-row-meta">
          <span>
            {h.subnets.length ? `networks ${h.subnets.join(', ')}` : 'networks not reported yet'}
          </span>
          {h.addresses.length ? <span>{h.addresses.join(', ')}</span> : null}
          <span>{h.lastSeenAt ? `last seen ${formatWhen(h.lastSeenAt)}` : 'not seen yet'}</span>
        </span>
      ) : (
        <span className="muted net-small">
          Remove it, or give the device the Wake helper role again.
        </span>
      )}
    </div>
  );
}

function RecentWakes({ wakes, names }: { wakes: WakeLogEntry[]; names: Map<string, string> }) {
  const headingId = useId();
  const name = (id: string, given?: string | null) => given ?? names.get(id) ?? 'A device';
  const via = (w: WakeLogEntry) =>
    w.status === 'rate_limited'
      ? 'not sent: the hourly limit was reached'
      : !w.via
        ? 'nothing on its network could send it'
        : w.via === 'hub'
          ? 'sent by the Hub'
          : `sent through ${name(w.via, w.viaName)}`;
  return (
    <section className="ws-section" aria-labelledby={headingId}>
      <h2 id={headingId}>Recent wakes</h2>
      {wakes.length ? (
        <ul className="ws-list" aria-label="Recent wakes" aria-live="polite">
          {wakes.map((w) => (
            <li
              key={w.id}
              className="ws-list-row"
              aria-label={`${name(w.deviceId, w.deviceName)}, ${formatWhen(w.createdAt)}`}
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
          <Icon name="clock" /> No wakes yet. Wake a computer from its page in Devices.
        </p>
      )}
    </section>
  );
}
