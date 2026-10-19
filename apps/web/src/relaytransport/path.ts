// Which way this browser reaches the Hub right now, for the account menu (FR-137 client, docs/22
// §2): LAN, Mesh, Relay or Direct, while checking, or that nothing answered. Text pairs with the
// state; nothing relies on color.
import { useEffect, useSyncExternalStore } from 'react';
import type { MenuItem } from '@nova/ui';
import { TRANSPORT_LABEL } from './endpoints.ts';
import { hubTransport, type HubTransport, type TransportSnapshot } from './transport.ts';

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
  if (s.revoked) return 'Removed from the Relay';
  if (s.path === null) return s.checking ? 'Checking the connection…' : 'Cannot reach the Hub';
  if (s.unreachable && !s.checking) return 'Cannot reach the Hub';
  return s.path.via === 'relay'
    ? 'Connected through the Relay'
    : `Connected over ${TRANSPORT_LABEL[s.path.transport]}`;
}

/** A longer line: the address and latency, and what the Relay means. */
export function pathDetail(s: TransportSnapshot): string {
  if (s.revoked)
    return 'The Hub removed this device from its Relay. Sign in again or add this device again.';
  const p = s.path;
  if (!p) return 'Neither this address nor the Relay answered. Nova keeps trying.';
  const latency = p.latencyMs === null ? '' : ` (${Math.round(p.latencyMs)} ms)`;
  if (p.via === 'relay')
    return `The Hub is not reachable at this address, so Nova goes through the Relay${latency}. The Relay forwards sealed messages it cannot read.`;
  return `This page talks to the Hub at ${p.url}${latency}.`;
}

/** The account menu's item: the path in use; opens Network. */
export function connectionMenuItem(s: TransportSnapshot, onSelect: () => void): MenuItem {
  return { id: 'connection', label: pathText(s), description: pathDetail(s), onSelect };
}
