// The messages between the extension and novad's native-messaging host (ADR-096 D8). The host
// frames them (4-byte native-endian length + JSON, at most 1 MiB) and relays calls from the Hub
// (`POST /agent/v1/bridge/call`) and events to the Hub (`POST /agent/v1/bridge/events`).
//
//   host -> extension   {type: 'status', connected, reason}   (first; when not connected the host
//                         exits: not_enabled, novad_unreachable, token_required,
//                         origin_not_allowed, bridge_not_configured)
//                       {type: 'call', id, method, params}; `cdp.send` params are
//                         {tabId, method, params, expectHost}
//   extension -> host   {type: 'result', id, result} | {type: 'error', id, error: {code, message}}
//                       {type: 'event', event: {kind, ...}}   (tab.shared, tab.unshared,
//                         tab.closed, host.granted, host.revoked; novad adds `at`, and reports
//                         `connected` and `disconnected` itself)

/** The native host's name (novad writes `ai.nova.bridge.json` on `novad bridge enable`). */
export const NATIVE_HOST = 'ai.nova.bridge';

export const BRIDGE_METHODS = [
  'tabs.list',
  'tabs.open',
  'tab.attach',
  'tab.detach',
  'cdp.send',
  'history.search',
] as const;
export type BridgeMethod = (typeof BRIDGE_METHODS)[number];

/**
 * The DevTools methods a controlled tab accepts: the ones the Hub's tab driver uses, the same
 * list the Hub checks. Nothing that reads cookies, storage, credentials or network bodies.
 */
export const ALLOWED_CDP_METHODS: readonly string[] = [
  'Runtime.evaluate',
  'Input.dispatchMouseEvent',
  'Input.dispatchKeyEvent',
  'Input.insertText',
  'Page.navigate',
  'Page.captureScreenshot',
];

/** Messages are capped by the host; ours stay well below. */
export const MAX_MESSAGE_CHARS = 900_000;

export interface CallMessage {
  type: 'call';
  id: string | number;
  method: string;
  params: Record<string, unknown>;
}

export type BridgeEvent =
  | {
      kind: 'tab.shared';
      tabId: number;
      host: string | null;
      title?: string;
      origin?: 'shared' | 'agent';
    }
  | { kind: 'tab.unshared'; tabId: number }
  | { kind: 'tab.closed'; tabId: number }
  | { kind: 'host.granted'; host: string }
  | { kind: 'host.revoked'; host: string };

/** An error the extension answers a call with (`code` names the refusal). */
export class BridgeRefusal extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** What the host's `status` message says (why it will not serve), or null. */
export function parseHostStatus(
  raw: unknown,
): { connected: boolean; reason: string | null } | null {
  if (!isRecord(raw) || raw.type !== 'status' || typeof raw.connected !== 'boolean') return null;
  const reason = typeof raw.reason === 'string' ? raw.reason.slice(0, 60) : null;
  return { connected: raw.connected, reason: raw.connected ? null : (reason ?? 'refused') };
}

/** A call from the host, or null for anything else (ignored). */
export function parseCall(raw: unknown): CallMessage | null {
  if (!isRecord(raw)) return null;
  if (raw.type !== undefined && raw.type !== 'call') return null;
  const id = raw.id;
  if (typeof id !== 'string' && typeof id !== 'number') return null;
  if (typeof raw.method !== 'string') return null;
  return { type: 'call', id, method: raw.method, params: isRecord(raw.params) ? raw.params : {} };
}

/** The host a web address belongs to, or null (not http or https). */
export function hostOf(url: string | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.hostname.toLowerCase() : null;
  } catch {
    return null;
  }
}

/** The host permission pattern for a web address (`https://example.com/*`), or null. */
export function originPattern(url: string | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return `${u.protocol}//${u.hostname}/*`;
  } catch {
    return null;
  }
}

// Hosts named by permission patterns; `<all_urls>` and a wildcard host are all sites (`*`).
export function hostsOfOrigins(origins: readonly string[] | undefined): string[] {
  const out = new Set<string>();
  for (const o of origins ?? []) {
    if (o === '<all_urls>' || /^\*:\/\/\*\//.test(o) || /^https?:\/\/\*\//.test(o)) {
      out.add('*');
      continue;
    }
    const m = /^(?:\*|https?):\/\/([^/]+)\//.exec(o);
    const host = m?.[1]?.toLowerCase();
    if (host && !host.includes('*')) out.add(host);
  }
  return [...out];
}
