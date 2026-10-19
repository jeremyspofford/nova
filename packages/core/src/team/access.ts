// What a member may not do on a Hub that is not theirs (decision 5 of ADR-095, docs/12 §1).
// Members have their own account, so every account-scoped route already shows them only their
// own data. Routes that administer the Hub itself (its settings, trust, network, Relay, devices,
// diagnostics and logs, plugins and hooks installed for everyone, its people) or that reach the
// Hub's own machine (its files, terminals, host folders, Code environments, stdio MCP servers,
// imports, the shared publish folder) stay the owner's. Since M8 (ADR-097 D7) the list is the
// route classification (routes.ts): every route is classified, a member is refused every `owner`
// route, and an API route nobody classified is refused too (fail closed). A member's chats and runs
// work in a folder of their own instead of the Hub's workspace and configured roots.
import { join } from 'node:path';
import { NovaError } from '@nova/shared';
import type { ThreadPolicy, ThreadPolicySource } from '../runtime/types.ts';
import { ROUTE_GROUPS, routeClass, routeEntry } from './routes.ts';

interface Rule {
  methods: readonly string[] | '*';
  /** A Fastify route pattern; `prefix` matches it and everything below it. */
  pattern: string;
  prefix?: boolean;
  why: string;
}

/** Owner-only routes, one rule per method and pattern (the `owner` groups of routes.ts). */
export const OWNER_ONLY_ROUTES: readonly Rule[] = ROUTE_GROUPS.filter(
  (g) => g.class === 'owner',
).flatMap((g) =>
  g.routes.map((r) => {
    const [method = '', pattern = ''] = r.split(' ');
    return { methods: [method], pattern, why: g.why };
  }),
);

/** What a member is refused on a route nobody classified yet. */
export const UNCLASSIFIED_WHY = 'this part of the Hub';

/**
 * Why a member may not call this route, or null. `route` is the matched route pattern (none for
 * a request no route matched). An API route without a classification is refused (fail closed).
 */
export function ownerOnlyReason(method: string, route: string | undefined): string | null {
  if (!route) return null;
  const cls = routeClass(method, route);
  if (cls === null) return UNCLASSIFIED_WHY;
  return cls === 'owner' ? (routeEntry(method, route)?.why ?? UNCLASSIFIED_WHY) : null;
}

/** A request body a member may not send even on a route they may use (a program on the Hub). */
export function memberBodyReason(
  method: string,
  route: string | undefined,
  body: unknown,
): string | null {
  if (!route || !body || typeof body !== 'object') return null;
  const b = body as Record<string, unknown>;
  const m = method.toUpperCase();
  const mcp =
    (m === 'POST' && route === '/api/v1/mcp/servers') ||
    (m === 'PATCH' && route === '/api/v1/mcp/servers/:id');
  // A stdio MCP server is a program on the Hub machine; remote servers are fine.
  if (mcp && (b.transport === 'stdio' || 'command' in b || 'args' in b || 'env' in b))
    return 'programs on the Hub machine';
  return null;
}

/** The refusal a member gets (403 `policy_denied`, reason `owner_only`). */
export function ownerOnlyError(why: string): NovaError {
  return new NovaError('policy_denied', `only the owner of this Hub can change ${why}`, {
    details: { reason: 'owner_only' },
  });
}

/** Where a member's chats and runs keep their files (inside the data folder, never shared). */
export function memberWorkspace(dataDir: string, accountId: string): string {
  return join(dataDir, 'members', accountId, 'workspace');
}

/**
 * The threads of an account that is not the Hub's owner (a member, a removed member, a team
 * agent's identity) work in that account's own folder (decision 5): a source's policy that leaves
 * the roots to the settings (the Hub's workspace and configured roots) gets that folder instead.
 * Thread-less calls ask too (thread id ''), so a tool run from the UI never lands in the Hub's
 * workspace. Without `inner` this is the fallback source, registered last: a member's thread no
 * other source knows (a plain chat) gets a policy with only that folder. The owner's threads and
 * threads a source does not know pass through unchanged, so "the first source wins" still holds.
 */
export function memberScoped(
  isMember: (accountId: string) => boolean,
  root: (accountId: string) => string,
  inner?: ThreadPolicySource,
): ThreadPolicySource {
  const roots = (accountId: string) => [
    { path: root(accountId), access: 'write' as const, label: 'My files' },
  ];
  return {
    forThread: async (accountId, threadId) => {
      if (inner) {
        const p = await inner.forThread(accountId, threadId);
        if (!p || p.roots || !isMember(accountId)) return p;
        return { ...p, roots: roots(accountId) };
      }
      if (!isMember(accountId)) return null;
      const fallback: ThreadPolicy = {
        approvalPolicy: null,
        profileId: null,
        roots: roots(accountId),
        permissionMode: null,
        autoAcceptEdits: false,
      };
      return fallback;
    },
  };
}
