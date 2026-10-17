// Network policy per scope and the credentials the proxy injects (FR-102, FR-193, docs/12 §8,
// ADR-063), and the adapter that opens a proxy session for each sandboxed command.
//
// Effective policy of a command: the global mode (`network.egressMode`) narrowed by the
// permission profile's network block and by every applicable scope's mode (off < limited <
// allowlist); allow entries are the global list plus each scope's grants; deny entries are all
// of them (deny wins). Scopes of a command: the agent whose computer or thread it runs for, the
// Work run and the Code session of its thread. Credentials are account-wide unless bound to a
// scope; their values live in the vault (`secret://egress/<id>`) and are read per request.
import {
  NovaError,
  uuidv7,
  type EgressCredentialView,
  type EgressHook,
  type EgressScopeInput,
  type EgressScopeKind,
  type EgressScopeView,
} from '@nova/shared';
import type { SecretStore } from '@nova/secrets';
import type { NovaDatabase } from '@nova/storage';
import type { SandboxEgress, SandboxEgressContext } from '../tools/sandbox-egress.ts';
import { narrowMode } from './egress-policy.ts';
import type {
  EgressCredential,
  EgressProxyService,
  EgressScope,
  LocalEgressSession,
  ProxyPolicy,
} from './egress-proxy.ts';
import type { EgressMode } from './types.ts';

export interface EgressGlobal {
  mode: EgressMode;
  allow: string[];
  deny: string[];
}

interface ScopeRow {
  scope_kind: EgressScopeKind;
  scope_id: string;
  mode: EgressMode | null;
  allow_json: string;
  deny_json: string;
  hooks_json: string;
  allow_local_binding: number;
  updated_at: string;
}

interface CredentialRow {
  id: string;
  name: string;
  hosts_json: string;
  scheme: 'bearer' | 'basic' | 'header';
  header_name: string | null;
  username: string | null;
  scope_kind: EgressScopeKind | null;
  scope_id: string | null;
  secret_ref: string;
  created_at: string;
  updated_at: string;
}

function parseList<T>(json: string): T[] {
  try {
    const v: unknown = JSON.parse(json);
    return Array.isArray(v) ? (v as T[]) : [];
  } catch {
    return [];
  }
}

function scopeView(r: ScopeRow): EgressScopeView {
  return {
    kind: r.scope_kind,
    id: r.scope_id,
    mode: r.mode,
    allow: parseList<string>(r.allow_json),
    deny: parseList<string>(r.deny_json),
    hooks: parseList<EgressHook>(r.hooks_json),
    allowLocalBinding: r.allow_local_binding === 1,
    updatedAt: r.updated_at,
  };
}

function credentialView(r: CredentialRow): EgressCredentialView {
  return {
    id: r.id,
    name: r.name,
    hosts: parseList<string>(r.hosts_json),
    scheme: r.scheme,
    header: r.header_name,
    username: r.username,
    scope: r.scope_kind && r.scope_id ? { kind: r.scope_kind, id: r.scope_id } : null,
    secretRef: r.secret_ref,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

/** A command's effective policy from the global settings, its scopes and its profile. */
export function effectivePolicy(input: {
  global: EgressGlobal;
  scopes: EgressScopeView[];
  network: 'allowlist' | 'limited';
  profile?: { allow?: string[]; deny?: string[] };
  credentials: string[];
}): ProxyPolicy {
  let mode = narrowMode(input.global.mode, input.network);
  for (const s of input.scopes) if (s.mode) mode = narrowMode(mode, s.mode);
  const allow = new Set([...input.global.allow, ...(input.profile?.allow ?? [])]);
  const deny = new Set([...input.global.deny, ...(input.profile?.deny ?? [])]);
  const hooks: EgressHook[] = [];
  let local = false;
  for (const s of input.scopes) {
    for (const h of s.allow) allow.add(h);
    for (const h of s.deny) deny.add(h);
    hooks.push(...s.hooks);
    local ||= s.allowLocalBinding;
  }
  return {
    mode,
    allow: [...allow].filter((h) => h !== '*'),
    deny: [...deny],
    credentials: input.credentials,
    allowLocalBinding: local,
    hooks,
  };
}

export interface EgressStoreOptions {
  db: NovaDatabase;
  secrets: SecretStore;
  now?: () => Date;
}

export class EgressStore {
  readonly #db: NovaDatabase;
  readonly #secrets: SecretStore;
  readonly #now: () => Date;

  constructor(opts: EgressStoreOptions) {
    this.#db = opts.db;
    this.#secrets = opts.secrets;
    this.#now = opts.now ?? (() => new Date());
  }

  listScopes(accountId: string): EgressScopeView[] {
    const rows = this.#db.raw
      .prepare('SELECT * FROM egress_scope WHERE account_id = ? ORDER BY scope_kind, scope_id')
      .all(accountId) as unknown as ScopeRow[];
    return rows.map(scopeView);
  }

  getScope(accountId: string, kind: string, id: string): EgressScopeView | null {
    const row = this.#db.raw
      .prepare(
        'SELECT * FROM egress_scope WHERE account_id = ? AND scope_kind = ? AND scope_id = ?',
      )
      .get(accountId, kind, id) as ScopeRow | undefined;
    return row ? scopeView(row) : null;
  }

  async putScope(
    accountId: string,
    kind: EgressScopeKind,
    id: string,
    input: EgressScopeInput,
  ): Promise<EgressScopeView> {
    const now = this.#now().toISOString();
    await this.#db.transaction(() => {
      this.#db.raw
        .prepare(
          `INSERT INTO egress_scope (id, account_id, scope_kind, scope_id, mode, allow_json, deny_json,
             hooks_json, allow_local_binding, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (account_id, scope_kind, scope_id) DO UPDATE SET mode = excluded.mode,
             allow_json = excluded.allow_json, deny_json = excluded.deny_json,
             hooks_json = excluded.hooks_json, allow_local_binding = excluded.allow_local_binding,
             updated_at = excluded.updated_at`,
        )
        .run(
          uuidv7(),
          accountId,
          kind,
          id,
          input.mode,
          JSON.stringify(input.allow),
          JSON.stringify(input.deny),
          JSON.stringify(input.hooks),
          input.allowLocalBinding ? 1 : 0,
          now,
          now,
        );
    });
    const v = this.getScope(accountId, kind, id);
    if (!v) throw new NovaError('server_error', 'the network policy was not saved');
    return v;
  }

  async deleteScope(accountId: string, kind: string, id: string): Promise<boolean> {
    return this.#db.transaction(
      () =>
        Number(
          this.#db.raw
            .prepare(
              'DELETE FROM egress_scope WHERE account_id = ? AND scope_kind = ? AND scope_id = ?',
            )
            .run(accountId, kind, id).changes,
        ) > 0,
    );
  }

  listCredentials(accountId: string): EgressCredentialView[] {
    const rows = this.#db.raw
      .prepare('SELECT * FROM egress_credential WHERE account_id = ? ORDER BY created_at')
      .all(accountId) as unknown as CredentialRow[];
    return rows.map(credentialView);
  }

  getCredential(accountId: string, id: string): EgressCredentialView | null {
    const row = this.#db.raw
      .prepare('SELECT * FROM egress_credential WHERE account_id = ? AND id = ?')
      .get(accountId, id) as CredentialRow | undefined;
    return row ? credentialView(row) : null;
  }

  /** Store a credential: the value goes to the vault, the row keeps only its reference. */
  async createCredential(
    accountId: string,
    input: {
      name: string;
      hosts: string[];
      scheme: 'bearer' | 'basic' | 'header';
      header?: string | null;
      username?: string | null;
      scope?: { kind: EgressScopeKind; id: string } | null;
      value: string;
    },
  ): Promise<EgressCredentialView> {
    const id = uuidv7();
    const ref = `secret://egress/${id}`;
    const now = this.#now().toISOString();
    await this.#secrets.put(ref, input.value);
    try {
      await this.#db.transaction(() => {
        this.#db.raw
          .prepare(
            `INSERT INTO egress_credential (id, account_id, name, hosts_json, scheme, header_name,
               username, scope_kind, scope_id, secret_ref, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            id,
            accountId,
            input.name,
            JSON.stringify(input.hosts),
            input.scheme,
            input.scheme === 'header' ? (input.header ?? null) : null,
            input.scheme === 'basic' ? (input.username ?? '') : null,
            input.scope?.kind ?? null,
            input.scope?.id ?? null,
            ref,
            now,
            now,
          );
      });
    } catch (err) {
      await this.#secrets.delete(ref).catch(() => false);
      throw err;
    }
    const v = this.getCredential(accountId, id);
    if (!v) throw new NovaError('server_error', 'the credential was not saved');
    return v;
  }

  async updateCredential(
    accountId: string,
    id: string,
    patch: {
      name?: string;
      hosts?: string[];
      scheme?: 'bearer' | 'basic' | 'header';
      header?: string | null;
      username?: string | null;
      scope?: { kind: EgressScopeKind; id: string } | null;
      value?: string;
    },
  ): Promise<EgressCredentialView> {
    const cur = this.getCredential(accountId, id);
    if (!cur) throw new NovaError('not_found', 'no such credential');
    const scheme = patch.scheme ?? cur.scheme;
    const header = patch.header !== undefined ? patch.header : cur.header;
    if (scheme === 'header' && !header)
      throw new NovaError('validation', 'scheme header needs a header name', {
        details: { field: 'header' },
      });
    if (patch.value !== undefined) await this.#secrets.put(cur.secretRef, patch.value);
    const scope = patch.scope !== undefined ? patch.scope : cur.scope;
    await this.#db.transaction(() => {
      this.#db.raw
        .prepare(
          `UPDATE egress_credential SET name = ?, hosts_json = ?, scheme = ?, header_name = ?,
             username = ?, scope_kind = ?, scope_id = ?, updated_at = ?
           WHERE account_id = ? AND id = ?`,
        )
        .run(
          patch.name ?? cur.name,
          JSON.stringify(patch.hosts ?? cur.hosts),
          scheme,
          scheme === 'header' ? header : null,
          scheme === 'basic'
            ? ((patch.username !== undefined ? patch.username : cur.username) ?? '')
            : null,
          scope?.kind ?? null,
          scope?.id ?? null,
          this.#now().toISOString(),
          accountId,
          id,
        );
    });
    const v = this.getCredential(accountId, id);
    if (!v) throw new NovaError('not_found', 'no such credential');
    return v;
  }

  async deleteCredential(accountId: string, id: string): Promise<boolean> {
    const cur = this.getCredential(accountId, id);
    if (!cur) return false;
    await this.#db.transaction(() => {
      this.#db.raw
        .prepare('DELETE FROM egress_credential WHERE account_id = ? AND id = ?')
        .run(accountId, id);
    });
    await this.#secrets.delete(cur.secretRef).catch(() => false);
    return true;
  }

  /** Ids of the credentials a command with these scopes may receive. */
  credentialIdsFor(accountId: string, scopes: readonly { kind: string; id: string }[]): string[] {
    return this.listCredentials(accountId)
      .filter(
        (c) => !c.scope || scopes.some((s) => s.kind === c.scope?.kind && s.id === c.scope.id),
      )
      .map((c) => c.id);
  }

  /** The proxy's view: metadata now, the value read from the vault per request. */
  credentials(accountId: string, ids: readonly string[]): Promise<EgressCredential[]> {
    const want = new Set(ids);
    return Promise.resolve(
      this.listCredentials(accountId)
        .filter((c) => want.has(c.id))
        .map((c) => ({
          id: c.id,
          hosts: c.hosts,
          scheme: c.scheme,
          header: c.header,
          username: c.username,
          value: () => this.#secrets.get(c.secretRef),
        })),
    );
  }
}

/** The scopes of a thread: its agent, Work run and Code session (plain lookups; tables may be absent). */
export function threadScopes(
  db: NovaDatabase,
  accountId: string,
  threadId: string,
): { kind: 'run' | 'session' | 'agent'; id: string }[] {
  const out: { kind: 'run' | 'session' | 'agent'; id: string }[] = [];
  const get = (sql: string): Record<string, unknown> | undefined => {
    try {
      return db.raw.prepare(sql).get(threadId, accountId);
    } catch {
      return undefined;
    }
  };
  const agent = get('SELECT agent_id FROM agent_thread WHERE thread_id = ? AND account_id = ?');
  if (typeof agent?.agent_id === 'string') out.push({ kind: 'agent', id: agent.agent_id });
  const run = get('SELECT id, agent_id FROM run WHERE thread_id = ? AND account_id = ?');
  if (typeof run?.id === 'string') {
    out.push({ kind: 'run', id: run.id });
    if (typeof run.agent_id === 'string' && !out.some((s) => s.kind === 'agent'))
      out.push({ kind: 'agent', id: run.agent_id });
  }
  const session = get('SELECT id FROM code_session WHERE thread_id = ? AND account_id = ?');
  if (typeof session?.id === 'string') out.push({ kind: 'session', id: session.id });
  return out;
}

export interface ProxyEgressOptions {
  proxy: EgressProxyService;
  store: EgressStore;
  db: NovaDatabase;
  global: () => Promise<EgressGlobal>;
}

/** The substrates' SandboxEgress, whose sessions are the proxy's own. */
export interface ProxySandboxEgress extends SandboxEgress {
  open(ctx: SandboxEgressContext): Promise<LocalEgressSession | null>;
}

/**
 * The SandboxEgress the substrates use: one proxy session per command, under the command's
 * effective policy. A command without an owner gets no network (there is no policy to apply).
 */
export function proxyEgress(o: ProxyEgressOptions): ProxySandboxEgress {
  return {
    async open(ctx: SandboxEgressContext) {
      if (!ctx.accountId)
        throw new NovaError(
          'policy_denied',
          'the command has no owner, so no network policy applies',
        );
      const scopes: { kind: 'run' | 'session' | 'agent' | 'sandbox'; id: string }[] = [];
      if (ctx.scope) scopes.push(ctx.scope);
      if (ctx.threadId)
        for (const s of threadScopes(o.db, ctx.accountId, ctx.threadId))
          if (!scopes.some((x) => x.kind === s.kind && x.id === s.id)) scopes.push(s);
      const rows = scopes
        .map((s) => o.store.getScope(ctx.accountId ?? '', s.kind, s.id))
        .filter((r): r is EgressScopeView => r !== null);
      const policy = effectivePolicy({
        global: await o.global(),
        scopes: rows,
        network: ctx.network,
        credentials: o.store.credentialIdsFor(ctx.accountId, scopes),
      });
      if (policy.mode === 'off') return null;
      // The audit names the most specific owner: the agent, else the run, the session, the thread.
      const primary: EgressScope = scopes.find((s) => s.kind === 'agent') ??
        scopes.find((s) => s.kind === 'run') ??
        scopes.find((s) => s.kind === 'session') ??
        scopes[0] ?? { kind: 'sandbox', id: ctx.threadId ?? uuidv7() };
      return o.proxy.open({ accountId: ctx.accountId, scope: primary, policy });
    },
  };
}
