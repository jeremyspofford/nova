// Event-driven audit and notifications (FR-104 partial, FR-013; contracts/events.md "Consumer
// rules"). Most audit entries are appended directly by the area that acts (policy, tools, MCP);
// these subscribers cover security-relevant events raised elsewhere (sign-in, provider
// credentials, security settings, compute nodes) and turn failures into notifications. Handlers
// run one at a time in arrival order and never throw into the event bus.
import { SETTINGS, type EventEnvelope, type EventHandler } from '@nova/shared';
import type { Logger } from '@nova/telemetry';
import type { AuditRecord, AuditSink, NotificationInput, Notifier } from '../tools/types.ts';

export interface EventSource {
  subscribe(pattern: string, handler: EventHandler): () => void;
}

export interface Subscription {
  stop(): void;
  /** Resolves when every event received so far has been handled. */
  idle(): Promise<void>;
}

/** Sequential handling: arrival order is kept even though each step awaits. */
function serial(
  bus: EventSource,
  patterns: string[],
  handle: (e: EventEnvelope) => Promise<void>,
  log?: Logger,
): Subscription {
  let chain: Promise<void> = Promise.resolve();
  const offs = patterns.map((p) =>
    bus.subscribe(p, (e) => {
      chain = chain
        .then(() => handle(e))
        .catch((err: unknown) => log?.warn('event handler failed', { event: e.name, err }));
    }),
  );
  return {
    stop: () => offs.forEach((off) => off()),
    idle: () => chain,
  };
}

const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);

/** Security setting keys (docs/14 §1) are audited when they change; others are not. */
export function isSecuritySetting(key: string): boolean {
  return (
    Object.hasOwn(SETTINGS, key) &&
    !!(SETTINGS as Record<string, { security?: boolean }>)[key]?.security
  );
}

/** Map one event to an audit record, or null when it is not security-relevant. */
export function auditRecordFor(e: EventEnvelope): Omit<AuditRecord, 'accountId'> | null {
  const p = e.payload;
  const actor = e.actor;
  if (e.name.startsWith('auth.')) {
    // Setup, sign-in and sign-out: who, never the token.
    return {
      actor,
      kind: 'auth',
      action: e.name.slice('auth.'.length),
      resource: str(p.accountId),
    };
  }
  switch (e.name) {
    case 'provider.account.created':
    case 'provider.account.removed':
      // Only the credential's reference is recorded, never the key.
      return {
        actor,
        kind: 'secret',
        action: e.name.slice('provider.'.length),
        resource: str(p.providerAccountId),
        detail: { provider: str(p.provider), secretRef: str(p.secretRef) },
      };
    case 'settings.changed': {
      const key = str(p.key);
      if (!key || !isSecuritySetting(key)) return null;
      return {
        actor,
        kind: 'settings',
        action: 'setting.changed',
        resource: key,
        detail: { scope: str(p.scope) },
      };
    }
    case 'node.registered':
      return {
        actor,
        kind: 'node',
        action: 'node.registered',
        resource: str(p.nodeId),
        detail: { name: str(p.name) },
      };
    case 'node.status.changed':
      if (p.status !== 'revoked') return null;
      return { actor, kind: 'node', action: 'node.revoked', resource: str(p.nodeId) };
    default:
      return null;
  }
}

export const AUDITED_EVENTS = [
  'auth.*',
  'provider.account.created',
  'provider.account.removed',
  'settings.changed',
  'node.registered',
  'node.status.changed',
];

export interface SecurityAuditOptions {
  bus: EventSource;
  audit: AuditSink;
  /** The account to file system events under when an event carries none. */
  ownerAccount: () => Promise<string | null>;
  log?: Logger;
}

export function auditSecurityEvents(opts: SecurityAuditOptions): Subscription {
  return serial(
    opts.bus,
    AUDITED_EVENTS,
    async (e) => {
      const rec = auditRecordFor(e);
      if (!rec) return;
      const accountId = e.accountId ?? (await opts.ownerAccount());
      if (!accountId) {
        opts.log?.warn('security event not audited: no account yet', { event: e.name });
        return;
      }
      await opts.audit.append({ ...rec, accountId });
    },
    opts.log,
  );
}

export interface EventNotificationOptions {
  bus: EventSource;
  notifier: Notifier;
  ownerAccount: () => Promise<string | null>;
  /** Display names; each may return null when unknown. */
  nodeName?: (nodeId: string) => Promise<string | null>;
  threadTitle?: (threadId: string) => Promise<string | null>;
  mcpServerName?: (serverId: string) => Promise<string | null>;
  log?: Logger;
}

/** Map one event to a notification, or null. */
export async function notificationFor(
  e: EventEnvelope,
  names: Pick<EventNotificationOptions, 'nodeName' | 'threadTitle' | 'mcpServerName'> = {},
): Promise<Omit<NotificationInput, 'accountId'> | null> {
  const p = e.payload;
  switch (e.name) {
    case 'turn.completed': {
      const threadId = str(p.threadId);
      if (p.status !== 'failed' || !threadId) return null;
      const title = await names.threadTitle?.(threadId);
      return {
        kind: 'error',
        title: title ? `A reply failed in “${title}”` : 'A reply failed',
        body: 'The model stopped before finishing. Open the chat to retry.',
        href: `/chat/${encodeURIComponent(threadId)}`,
        dedupeKey: `turn:${str(p.turnId) ?? threadId}`,
      };
    }
    case 'node.status.changed': {
      const nodeId = str(p.nodeId);
      if (p.status !== 'unreachable' || !nodeId) return null;
      const name = (await names.nodeName?.(nodeId)) ?? 'A compute node';
      return {
        kind: 'attention',
        title: `${name} is unreachable`,
        body: 'Models on it are unavailable until it reconnects.',
        href: '/settings/devices',
        dedupeKey: `node:${nodeId}:unreachable`,
      };
    }
    case 'mcp.server.status.changed': {
      const serverId = str(p.serverId);
      if (p.status !== 'error' || !serverId) return null;
      const name = str(p.name) ?? (await names.mcpServerName?.(serverId)) ?? null;
      return {
        kind: 'error',
        title: name ? `MCP server ${name} stopped working` : 'An MCP server stopped working',
        body: str(p.error) ?? 'Its tools are unavailable until it is restarted.',
        href: '/settings/tools',
        dedupeKey: `mcp:${serverId}:error`,
      };
    }
    default:
      return null;
  }
}

export const NOTIFIED_EVENTS = [
  'turn.completed',
  'node.status.changed',
  'mcp.server.status.changed',
];

export function notifyOnEvents(opts: EventNotificationOptions): Subscription {
  return serial(
    opts.bus,
    NOTIFIED_EVENTS,
    async (e) => {
      const n = await notificationFor(e, opts);
      if (!n) return;
      const accountId = e.accountId ?? (await opts.ownerAccount());
      if (!accountId) return;
      await opts.notifier.notify({ ...n, accountId });
    },
    opts.log,
  );
}
