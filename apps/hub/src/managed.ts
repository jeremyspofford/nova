// Managed policy area (FR-106; docs/12 §10; ADR-078, ADR-097 D4). The policy service reads the
// OS-protected local file and the signed remote policy it names (packages/core/src/managed); this
// area gives app.ts the managed settings layer (`settingsLayer`, the `managedSettings` dep: locked
// in every view, and carrying the restrictions as `managed.restrict`, which every area's checks
// read through `ctx.setting`), and serves:
//   GET  /api/v1/managed         what applies, each value's source, what was ignored and why
//   POST /api/v1/managed/reload  read the file and fetch the remote policy again
// Both need a session and the Hub's owner. The settings route never writes `managed.*`, a
// Code session mode, an autonomy or an approval policy the policy turns off. Every refusal
// managed policy causes on any route (`policy_denied` `{reason: managed}`) is audited here as
// `managed.denied` (tool calls are audited by the gate); loads and changes are audited too.
// NOVA_MANAGED_SETTINGS_FILE adds a file layered over the protected one (never in its place), only
// when NODE_ENV=test or the Hub runs with --allow-test-policy (`resolveManagedPath`).
import { join } from 'node:path';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  NovaError,
  PERMISSION_MODES,
  isNovaError,
  managedReloadSchema,
  type ManagedPolicyView,
  type PermissionMode,
} from '@nova/shared';
import {
  ManagedPolicy,
  hubOwnerId,
  isHubOwner,
  managedDenied,
  resolveManagedPath,
  type AuditSink,
  type ManagedFetch,
  type ManagedFs,
  type ManagedRestrictions,
} from '@nova/core';
import type { HubArea, HubContext } from './hub-context.ts';

export interface ManagedArea extends HubArea {
  policy: ManagedPolicy;
  /** The managed settings layer for `loadLayers` (app.ts `managedSettings`). */
  settingsLayer(global?: Partial<Record<string, unknown>>): Record<string, unknown>;
  /** Late-bound: the ops area's audit sink. */
  useAudit(audit: AuditSink): void;
}

export interface ManagedDeps {
  /** Tests: a policy service of their own. */
  policy?: ManagedPolicy;
  /** The Hub was started with --allow-test-policy (honour NOVA_MANAGED_SETTINGS_FILE). */
  allowTestPolicy?: boolean;
  env?: NodeJS.ProcessEnv;
  argv?: readonly string[];
  platform?: NodeJS.Platform;
  fs?: ManagedFs;
  fetch?: ManagedFetch;
  /** Tests only: a remote policy over plain http to 127.0.0.1. app.ts never sets it. */
  allowInsecureRemote?: boolean;
  hubUid?: number | null;
  audit?: AuditSink;
}

/** What the area needs from the Hub context: it is set up before every other area. */
export type ManagedContext = Pick<
  HubContext,
  'log' | 'events' | 'dataDir' | 'db' | 'diagnostics' | 'accountOf'
>;

const MODE_KEYS = new Set(['code.permissionMode']);
const AUTONOMY_KEYS = new Set(['runs.autonomy', 'agents.autonomy']);

/**
 * Why the settings route must not store this value under the policy in force, or null. Locked
 * keys are refused by the settings writer itself; these are values of unlocked keys that would
 * choose something the policy turns off.
 */
export function managedSettingRefusal(
  key: string,
  value: unknown,
  checks: ManagedRestrictions,
): string | null {
  if (key.startsWith('managed.')) return `${key} is set only by your organization's managed policy`;
  const isMode = (v: unknown): v is PermissionMode =>
    typeof v === 'string' && (PERMISSION_MODES as readonly string[]).includes(v);
  if (MODE_KEYS.has(key) && isMode(value)) return checks.permissionMode(value);
  if (key === 'code.folderModes' && value && typeof value === 'object')
    for (const m of Object.values(value)) {
      const why = isMode(m) ? checks.permissionMode(m) : null;
      if (why) return why;
    }
  if (AUTONOMY_KEYS.has(key) && typeof value === 'string') return checks.autonomy(value);
  if (key === 'tools.approvalPolicy' && typeof value === 'string')
    return checks.approvalPolicy(value as 'never_ask');
  return null;
}

function summary(view: ManagedPolicyView): Record<string, unknown> {
  return {
    active: view.active,
    failClosed: view.failClosed,
    sources: view.sources.map((s) => ({
      channel: s.channel,
      location: s.location,
      status: s.status,
      problem: s.problem,
      inForce: s.inForce,
      serial: s.serial,
    })),
    settings: view.settings.map((s) => s.key),
    ignored: view.ignored.map((i) => ({ key: i.key, reason: i.reason, channel: i.channel })),
  };
}

export async function setupManaged(
  ctx: ManagedContext,
  deps: ManagedDeps = {},
): Promise<ManagedArea> {
  const log = ctx.log.child('managed');
  let audit: AuditSink | null = deps.audit ?? null;
  const choice = resolveManagedPath({
    ...(deps.platform ? { platform: deps.platform } : {}),
    ...(deps.env ? { env: deps.env } : {}),
    ...(deps.argv ? { argv: deps.argv } : {}),
    ...(deps.allowTestPolicy ? { allowTestPolicy: true } : {}),
  });
  if (choice.overrideRefused) log.warn(choice.overrideRefused);
  const policy =
    deps.policy ??
    new ManagedPolicy({
      path: choice.path,
      testPath: choice.testPath,
      overrideRefused: choice.overrideRefused,
      cacheDir: join(ctx.dataDir, 'managed'),
      events: ctx.events,
      log,
      ...(deps.platform ? { platform: deps.platform } : {}),
      ...(deps.fs ? { fs: deps.fs } : {}),
      ...(deps.fetch ? { fetch: deps.fetch } : {}),
      ...(deps.allowInsecureRemote ? { allowInsecureRemote: true } : {}),
      ...(deps.hubUid !== undefined ? { hubUid: deps.hubUid } : {}),
    });
  const loaded = await policy.load();
  policy.start();
  if (loaded.failClosed) log.error('managed policy fails closed', { why: loaded.failClosed });

  /** Policy records are the owner's (the policy is the Hub's); none before setup. */
  const record = async (
    action: string,
    detail: Record<string, unknown>,
    who: { accountId?: string | null; actor?: string; decision?: string; resource?: string } = {},
  ): Promise<void> => {
    const accountId = who.accountId ?? hubOwnerId(ctx.db);
    if (!audit || !accountId) return;
    await audit
      .append({
        accountId,
        actor: who.actor ?? 'system',
        kind: 'policy',
        action,
        resource: who.resource ?? 'managed_policy',
        ...(who.decision ? { decision: who.decision } : {}),
        detail,
      })
      .catch((err: unknown) => log.warn('managed policy audit failed', { err }));
  };
  // What applied at startup is recorded once the ops area's sink is wired and the Hub has an
  // owner (a fresh Hub gets one at setup; the record waits for the first request after that).
  let startup: ManagedPolicyView | null =
    loaded.active || loaded.sources.some((s) => s.problem) ? loaded : null;
  const flushStartup = () => {
    if (!startup || !audit || !hubOwnerId(ctx.db)) return;
    const view = startup;
    startup = null;
    void record('managed.policy.loaded', summary(view));
  };
  flushStartup();
  const offChange = policy.onChange(() => {
    void record('managed.policy.changed', summary(policy.view()));
  });

  ctx.diagnostics.add('managed', () => Promise.resolve(summary(policy.view())));

  const ownerOf = async (req: FastifyRequest): Promise<string> => {
    const accountId = await ctx.accountOf(req);
    if (!isHubOwner(ctx.db, accountId))
      throw new NovaError(
        'policy_denied',
        "only the Hub's owner can see or reload its managed policy",
        {
          details: { reason: 'owner_only' },
        },
      );
    return accountId;
  };

  function register(app: FastifyInstance): void {
    app.addHook('onResponse', (_req, _reply, done) => {
      flushStartup();
      done();
    });

    // The settings route never stores a value the policy turns off (a locked key is refused by
    // the settings writer itself).
    app.addHook('preHandler', (req) => {
      if (req.method !== 'PATCH' || req.routeOptions.url !== '/api/v1/settings')
        return Promise.resolve();
      const body = req.body as { key?: unknown; value?: unknown } | null | undefined;
      if (!body || typeof body.key !== 'string') return Promise.resolve();
      const why = managedSettingRefusal(body.key, body.value, policy.restrictions());
      return why ? Promise.reject(managedDenied(why, { key: body.key })) : Promise.resolve();
    });

    // Every refusal managed policy causes, on any route, is audited once here.
    app.addHook('onError', async (req, _reply, err) => {
      if (!isNovaError(err) || err.code !== 'policy_denied' || err.details?.reason !== 'managed')
        return;
      await record(
        'managed.denied',
        { message: err.message, details: err.details, method: req.method },
        {
          accountId: req.principal?.accountId ?? null,
          actor: req.principal ? 'user' : 'system',
          decision: 'denied',
          resource: req.routeOptions.url ?? req.url.split('?')[0] ?? '',
        },
      );
    });

    // Everyone the policy applies to may see it (a member route, ADR-097 D7); reload is the owner's.
    app.get('/api/v1/managed', async (req) => {
      await ctx.accountOf(req);
      return policy.view();
    });

    app.post('/api/v1/managed/reload', async (req) => {
      const accountId = await ownerOf(req);
      managedReloadSchema.parse(req.body ?? {});
      const view = await policy.reload();
      await record('managed.policy.reload', summary(view), { accountId, actor: 'user' });
      return view;
    });
  }

  return {
    policy,
    settingsLayer: (global) => policy.settingsLayer(global),
    useAudit(sink) {
      audit = sink;
      flushStartup();
    },
    register,
    close: () => {
      offChange();
      policy.stop();
      return Promise.resolve();
    },
  };
}
