// M6.5 Relay API shapes (owned by the relay area; FR-137, docs/22 §3, contracts/hub-api.md §1,
// contracts/rest-api.md §3). The Hub connects out to a content-blind Relay; clients paired through
// it are listed and revoked here.
import { z } from 'zod';

/** The hosted Relay (contracts/rest-api.md); used only when `relay.selfHosted` is off and no URL is set. */
export const RELAY_HOSTED_URL = 'wss://relay.arialabs.ai';

/** Loopback host names: plain http/ws to a Relay on this machine stays on it. */
function isLoopbackHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  return h === 'localhost' || h === '[::1]' || /^127(\.\d{1,3}){3}$/.test(h);
}

/**
 * A Relay base URL: wss:// or https:// (ws:// and http:// only to this machine, so the route
 * token and pairing metadata never cross a network in clear), no credentials, query or
 * fragment; '' for none.
 */
export const relayUrlSchema = z
  .string()
  .trim()
  .max(2048)
  .refine((v) => {
    if (v === '') return true;
    try {
      const u = new URL(v);
      const secure = u.protocol === 'wss:' || u.protocol === 'https:';
      const local = (u.protocol === 'ws:' || u.protocol === 'http:') && isLoopbackHost(u.hostname);
      return (secure || local) && !u.username && !u.password && !u.search && !u.hash;
    } catch {
      return false;
    }
  }, 'a wss:// or https:// URL (ws:// or http:// only to this machine), without credentials, query or fragment');

/** `PATCH /api/v1/relay`. */
export const patchRelaySchema = z
  .object({
    enabled: z.boolean().optional(),
    url: relayUrlSchema.optional(),
    selfHosted: z.boolean().optional(),
  })
  .strict();
export type PatchRelayRequest = z.infer<typeof patchRelaySchema>;

export const RELAY_CONNECTOR_STATES = [
  'disabled',
  'unconfigured',
  'registering',
  'connecting',
  'connected',
  'error',
] as const;
export type RelayConnectorStateView = (typeof RELAY_CONNECTOR_STATES)[number];

export interface RelayStatusView {
  state: RelayConnectorStateView;
  detail: string | null;
  url: string | null;
  /** The Hub's routing id at the Relay (opaque). */
  routeId: string | null;
  since: string;
  latencyMs: number | null;
}

/** `GET /api/v1/relay`. */
export interface RelayConfigView {
  enabled: boolean;
  url: string;
  selfHosted: boolean;
  /** The URL in use: `url`, or the hosted Relay when not self-hosted and no URL is set. */
  effectiveUrl: string;
  status: RelayStatusView;
  clients: { active: number; pending: number };
  /**
   * M7: whether a registration token for a private Relay is in the vault (its value never
   * leaves it; `PUT /api/v1/relay/registration-token`). The Hub always fills it.
   */
  registrationToken?: boolean;
}

export const RELAY_CLIENT_STATUSES = ['pending', 'active', 'denied', 'expired', 'revoked'] as const;
export type RelayClientStatus = (typeof RELAY_CLIENT_STATUSES)[number];

/** One paired client in `GET /api/v1/relay/clients`. */
export interface RelayPairedClientView {
  /** The relay client id. */
  id: string;
  deviceId: string | null;
  requestId: string | null;
  name: string;
  platform: string;
  kind: 'browser' | 'native';
  status: RelayClientStatus;
  routeId: string;
  relayUrl: string;
  createdAt: string;
  lastSeenAt: string | null;
  revokedAt: string | null;
}

/** `POST /api/v1/relay/test`. */
export interface RelayTestView {
  ok: boolean;
  url: string | null;
  reachable: boolean;
  latencyMs: number | null;
  version: string | null;
  state: RelayConnectorStateView;
  detail: string | null;
}

/** The Relay a Hub uses from the `relay.*` settings. */
export function effectiveRelayUrl(s: { url: string; selfHosted: boolean }): string {
  const url = s.url.trim();
  if (url) return url;
  return s.selfHosted ? '' : RELAY_HOSTED_URL;
}
