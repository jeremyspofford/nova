// What a member may not do on a Hub that is not theirs (decision 5 of ADR-095, docs/12 §1).
// Members have their own account, so every account-scoped route already shows them only their
// own data. Routes that administer the Hub itself (its settings, trust, network, Relay, devices,
// diagnostics and logs, plugins and hooks installed for everyone) or that reach the Hub's own
// machine (its files, terminals, host folders, Code environments, stdio MCP servers, imports,
// the shared publish folder) stay the owner's. A member's chats and runs work in a folder of
// their own instead of the Hub's workspace and configured roots. Refusals fail closed.
import { join } from 'node:path';
import { NovaError } from '@nova/shared';
import type { ThreadPolicy, ThreadPolicySource } from '../runtime/types.ts';

interface Rule {
  methods: readonly string[] | '*';
  /** A Fastify route pattern; `prefix` matches it and everything below it. */
  pattern: string;
  prefix?: boolean;
  why: string;
}

const ALL = '*' as const;

/** Owner-only route patterns (matched against the route, never the raw URL). */
export const OWNER_ONLY_ROUTES: readonly Rule[] = [
  { methods: ALL, pattern: '/api/v1/settings', why: "the Hub's settings" },
  { methods: ['PUT'], pattern: '/api/v1/presets', why: "the Hub's model presets" },
  { methods: ALL, pattern: '/api/v1/providers/detect', why: 'probing the Hub machine' },
  { methods: ['GET', 'PATCH'], pattern: '/api/v1/trust', why: "the Hub's trust" },
  { methods: ALL, pattern: '/api/v1/trust/renew', why: "the Hub's certificates" },
  { methods: ALL, pattern: '/api/v1/network', prefix: true, why: "the Hub's network" },
  { methods: ALL, pattern: '/api/v1/relay', prefix: true, why: "the Hub's Relay" },
  { methods: ALL, pattern: '/api/v1/devices', prefix: true, why: "the Hub's devices" },
  { methods: ALL, pattern: '/api/v1/nodes', prefix: true, why: "the Hub's compute nodes" },
  { methods: ALL, pattern: '/api/v1/audit/verify', why: "the Hub's whole audit chain" },
  { methods: ALL, pattern: '/api/v1/diagnostics', prefix: true, why: "the Hub's diagnostics" },
  { methods: ['GET'], pattern: '/api/v1/egress', why: "the Hub's egress policy" },
  { methods: ['POST'], pattern: '/api/v1/app-authorizations', why: "the Hub's MCP server" },
  { methods: ['POST'], pattern: '/api/v1/plugins', why: 'plugins installed for everyone' },
  { methods: ['POST'], pattern: '/api/v1/plugins/preview', why: 'plugins installed for everyone' },
  {
    methods: ['PATCH', 'DELETE'],
    pattern: '/api/v1/plugins/:id',
    why: 'plugins installed for everyone',
  },
  { methods: ALL, pattern: '/api/v1/plugins/catalogs', why: "the Hub's plugin catalogs" },
  { methods: ALL, pattern: '/api/v1/plugins/catalog', why: "the Hub's plugin catalogs" },
  { methods: ['POST'], pattern: '/api/v1/skills', why: 'skills shared by everyone' },
  { methods: ['PATCH', 'DELETE'], pattern: '/api/v1/skills/:id', why: 'skills shared by everyone' },
  { methods: ALL, pattern: '/api/v1/hooks', prefix: true, why: 'hooks shared by everyone' },
  { methods: ALL, pattern: '/api/v1/files', prefix: true, why: "the Hub's files" },
  { methods: ALL, pattern: '/api/v1/terminals', prefix: true, why: 'a shell on the Hub machine' },
  { methods: ALL, pattern: '/api/v1/library', why: "the Hub's workspace" },
  {
    methods: ALL,
    pattern: '/api/v1/projects/:id/folders',
    prefix: true,
    why: 'folders of the Hub machine',
  },
  {
    methods: ALL,
    pattern: '/api/v1/import',
    prefix: true,
    why: 'reading folders of the Hub machine',
  },
  {
    methods: ALL,
    pattern: '/api/v1/code',
    prefix: true,
    why: 'Code environments on the Hub machine',
  },
  {
    methods: ALL,
    pattern: '/api/v1/environments',
    prefix: true,
    why: 'Code environments on the Hub machine',
  },
  // Other M7 areas: the cloud runner, external agent programs and their delegations.
  { methods: ALL, pattern: '/api/v1/cloud', prefix: true, why: "the Hub's cloud runner" },
  { methods: ALL, pattern: '/api/v1/oob', prefix: true, why: "the Hub's out-of-band management" },
  {
    methods: ALL,
    pattern: '/api/v1/agent-adapters',
    prefix: true,
    why: 'programs on the Hub machine',
  },
  { methods: ALL, pattern: '/api/v1/delegations', prefix: true, why: 'Code sessions on the Hub' },
  {
    methods: ALL,
    pattern: '/api/v1/mcp/bundles',
    prefix: true,
    why: 'programs on the Hub machine',
  },
  {
    methods: ['POST'],
    pattern: '/api/v1/sites/:id/publish',
    why: "the Hub's shared publish folder",
  },
  {
    methods: ['POST'],
    pattern: '/api/v1/sites/:id/unpublish',
    why: "the Hub's shared publish folder",
  },
];

/** Public routes that authenticate another way: a signed-in member may still call them. */
const PUBLIC = new Set([
  'POST /api/v1/devices/add/complete',
  'POST /api/v1/devices/add/reveal',
  'GET /api/v1/devices/add/status/:requestId',
]);

function matches(rule: Rule, method: string, route: string): boolean {
  if (rule.methods !== ALL && !rule.methods.includes(method)) return false;
  if (route === rule.pattern) return true;
  return !!rule.prefix && route.startsWith(`${rule.pattern}/`);
}

/** Why a member may not call this route, or null. `route` is the matched route pattern. */
export function ownerOnlyReason(method: string, route: string | undefined): string | null {
  if (!route) return null;
  const m = method.toUpperCase();
  if (PUBLIC.has(`${m} ${route}`)) return null;
  for (const rule of OWNER_ONLY_ROUTES) if (matches(rule, m, route)) return rule.why;
  return null;
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
