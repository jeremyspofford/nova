// Which way this browser reaches the Hub right now, for the account menu (FR-137 client, docs/22
// §2): LAN, Mesh, Relay or Direct, while checking, or that nothing answered. Text pairs with the
// state; nothing relies on color.
import { useEffect, useSyncExternalStore } from 'react';
import { defineMessages, fmt } from '@nova/i18n';
import type { MenuItem } from '@nova/ui';
import { hubTransport, type HubTransport, type TransportSnapshot } from './transport.ts';

export const PATH_TEXT = defineMessages('relaytransport', {
  removed: 'Removed from the Relay',
  checking: 'Checking the connection…',
  unreachable: 'Cannot reach the Hub',
  viaRelay: 'Connected through the Relay',
  over: '{transport, select, lan {Connected over LAN} mesh {Connected over Mesh} relay {Connected over Relay} direct {Connected over Direct} other {Connected}}',
  removedDetail:
    'The Hub removed this device from its Relay. Sign in again or add this device again.',
  noAnswer: 'Neither this address nor the Relay answered. Nova keeps trying.',
  relayDetail:
    'The Hub is not reachable at this address, so Nova goes through the Relay. The Relay forwards sealed messages it cannot read.',
  relayDetailLatency:
    'The Hub is not reachable at this address, so Nova goes through the Relay ({latency}). The Relay forwards sealed messages it cannot read.',
  directDetail: 'This page talks to the Hub at {url}.',
  directDetailLatency: 'This page talks to the Hub at {url} ({latency}).',
});

/** The transport's state, live. Asks the Hub once for its advertised endpoints. */
export function useHubPath(t: HubTransport = hubTransport): TransportSnapshot {
  const snap = useSyncExternalStore(t.subscribe, t.getSnapshot, t.getSnapshot);
  useEffect(() => {
    if (t.inUse) t.refreshEndpointsOnce();
  }, [t]);
  return snap;
}

/** "Connected over LAN", "Connected through the Relay", "Checking the connection…". */
export function pathText(s: TransportSnapshot): string {
  if (s.revoked) return PATH_TEXT.removed;
  if (s.path === null) return s.checking ? PATH_TEXT.checking : PATH_TEXT.unreachable;
  if (s.unreachable && !s.checking) return PATH_TEXT.unreachable;
  return s.path.via === 'relay'
    ? PATH_TEXT.viaRelay
    : PATH_TEXT.over({ transport: s.path.transport });
}

/** A longer line: the address and latency, and what the Relay means. */
export function pathDetail(s: TransportSnapshot): string {
  if (s.revoked) return PATH_TEXT.removedDetail;
  const p = s.path;
  if (!p) return PATH_TEXT.noAnswer;
  const latency = p.latencyMs === null ? null : fmt.duration(p.latencyMs);
  if (p.via === 'relay')
    return latency === null ? PATH_TEXT.relayDetail : PATH_TEXT.relayDetailLatency({ latency });
  return latency === null
    ? PATH_TEXT.directDetail({ url: p.url })
    : PATH_TEXT.directDetailLatency({ url: p.url, latency });
}

/** The account menu's item: the path in use; opens Network. */
export function connectionMenuItem(s: TransportSnapshot, onSelect: () => void): MenuItem {
  return { id: 'connection', label: pathText(s), description: pathDetail(s), onSelect };
}
