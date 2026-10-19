// The policy store (FR-048, FR-084 partial, FR-100, FR-190, FR-191): policy rules, command prefix
// rules, remembered grants, per-tool defaults, permission profiles and approval rows, and the
// policy set the engine evaluates. Managed rows (source 'managed') are read-only here.
import { and, desc, eq, isNull } from 'drizzle-orm';
import {
  NovaError,
  uuidv7,
  type ActionEffectClass,
  type ApprovalView,
  type CommandRuleView,
  type PermissionGrantView,
  type PermissionProfileView,
  type PolicyRuleView,
} from '@nova/shared';
import {
  BUILTIN_PROFILES,
  checkCommandRule,
  checkProfile,
  evaluateCommand,
  flattenProfile,
  loadCommandRules,
  profileHash,
  type CommandRule,
  type DefaultEffect,
  type PermissionProfile,
  type PolicyGrant,
  type PolicyRule,
  type PolicySet,
  type RuleMatch,
  type Scope,
} from '@nova/policy';
import { schema, type NovaDatabase } from '@nova/storage';
import { allPermissionProfiles } from './roots.ts';

const { policyRule, commandRule, permissionGrant, permissionProfile, toolDefault, approval } =
  schema;

export type PolicyRuleRow = typeof policyRule.$inferSelect;
export type CommandRuleRow = typeof commandRule.$inferSelect;
export type GrantRow = typeof permissionGrant.$inferSelect;
export type ApprovalRow = typeof approval.$inferSelect;

/** Effect classes a policy rule may match on (contracts/schemas/policy-rule.json). */
export const RULE_EFFECT_CLASSES = [
  'external_communication',
  'purchase',
  'account_change',
  'credential_change',
  'data_delete',
  'file_write',
  'exec',
  'network',
] as const;

export interface PolicyRuleInput {
  scopeKind: PolicyRuleView['scopeKind'];
  scopeRef?: string | null;
  match: { tool?: string; resource?: string; effects?: ActionEffectClass[] };
  effect: PolicyRuleView['effect'];
  label?: string | null;
  priority?: number;
  enabled?: boolean;
}

export interface CommandRuleInput {
  scopeKind?: CommandRuleView['scopeKind'];
  scopeRef?: string | null;
  pattern: (string | string[])[];
  decision: CommandRuleView['decision'];
  justification?: string | null;
  matchExamples: string[];
  notMatchExamples: string[];
  priority?: number;
  tools?: string[];
  enabled?: boolean;
}

export interface ProfileInput {
  name: string;
  extends?: string | null;
  filesystem: { path: string; access: 'read' | 'write' | 'deny' }[];
  network: {
    mode: 'off' | 'allowlist' | 'limited';
    allow?: string[];
    deny?: string[];
    socks5?: boolean;
    allowLocalBinding?: boolean;
  };
}

/** What a grant row's `action_match` holds. */
export interface GrantMatch {
  tool: string;
  command?: (string | string[])[];
  argsHash?: string;
}

export interface NewGrant {
  approvalId?: string | null;
  ruleId?: string | null;
  commandRuleId?: string | null;
  duration: 'session' | 'always';
  scope: Scope;
  match: GrantMatch;
  host?: string | null;
  label: string;
  expiresAt?: string | null;
}

export interface PolicyStoreOptions {
  db: NovaDatabase;
  now?: () => Date;
}

function parseJson<T>(text: string | null, fallback: T): T {
  if (text === null) return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

/** A resource string from the API as an engine matcher (paths, recipients, hosts). */
export function resourceMatcher(resource: string): NonNullable<RuleMatch['resource']> {
  if (/^(\/|~(\/|$)|[A-Za-z]:[\\/])/.test(resource)) return { kind: 'path', pathPrefix: resource };
  const at = resource.lastIndexOf('@');
  if (at >= 0) {
    const local = resource.slice(0, at);
    return local === '*'
      ? { host: resource.slice(at + 1) }
      : { kind: 'account', pattern: resource };
  }
  return { host: resource };
}

function resourceText(r: RuleMatch['resource']): string | undefined {
  if (!r) return undefined;
  if (r.pathPrefix) return r.pathPrefix;
  if (r.kind === 'account' && r.pattern) return r.pattern;
  if (r.host) return r.host;
  return r.pattern;
}

export class PolicyStore {
  readonly #db: NovaDatabase;
  readonly #now: () => Date;
  /** The last command rule set that passed its examples, per account (docs/12 §3.1). */
  readonly #lastGoodCommands = new Map<string, CommandRule[]>();
  /** Why the stored command rules were last rejected at load, per account (diagnostics). */
  readonly commandRuleErrors = new Map<string, string>();

  constructor(opts: PolicyStoreOptions) {
    this.#db = opts.db;
    this.#now = opts.now ?? (() => new Date());
  }

  get db(): NovaDatabase {
    return this.#db;
  }

  #iso(): string {
    return this.#now().toISOString();
  }

  // ---- policy rules -----------------------------------------------------------------------

  async listRules(accountId: string): Promise<PolicyRuleView[]> {
    const rows = await this.#db.orm
      .select()
      .from(policyRule)
      .where(eq(policyRule.accountId, accountId))
      .orderBy(policyRule.priority, policyRule.createdAt);
    return rows.map(ruleView);
  }

  async #ruleRow(accountId: string, id: string): Promise<PolicyRuleRow> {
    const rows = await this.#db.orm
      .select()
      .from(policyRule)
      .where(and(eq(policyRule.id, id), eq(policyRule.accountId, accountId)))
      .limit(1);
    if (!rows[0]) throw new NovaError('not_found', 'rule not found');
    return rows[0];
  }

  async createRule(
    accountId: string,
    input: PolicyRuleInput,
    source: 'user' | 'managed' | 'plugin' = 'user',
  ): Promise<PolicyRuleView> {
    const now = this.#iso();
    const row: PolicyRuleRow = {
      id: uuidv7(),
      accountId,
      ...checkRuleInput(input),
      source,
      createdAt: now,
      updatedAt: now,
    };
    await this.#db.transaction(() => this.#db.orm.insert(policyRule).values(row));
    return ruleView(row);
  }

  async updateRule(
    accountId: string,
    id: string,
    patch: Partial<PolicyRuleInput>,
  ): Promise<PolicyRuleView> {
    const row = await this.#ruleRow(accountId, id);
    if (row.source === 'managed') throw managedError();
    const current = ruleView(row);
    const merged = checkRuleInput({
      scopeKind: patch.scopeKind ?? current.scopeKind,
      scopeRef: patch.scopeRef !== undefined ? patch.scopeRef : current.scopeRef,
      match: patch.match ?? current.match,
      effect: patch.effect ?? current.effect,
      label: patch.label !== undefined ? patch.label : current.label,
      priority: patch.priority ?? current.priority,
      enabled: patch.enabled ?? current.enabled,
    });
    const next = { ...row, ...merged, updatedAt: this.#iso() };
    await this.#db.transaction(() =>
      this.#db.orm.update(policyRule).set(next).where(eq(policyRule.id, id)),
    );
    return ruleView(next);
  }

  async deleteRule(accountId: string, id: string): Promise<void> {
    const row = await this.#ruleRow(accountId, id);
    if (row.source === 'managed') throw managedError();
    const now = this.#iso();
    await this.#db.transaction(() => {
      this.#db.raw
        .prepare(
          'UPDATE permission_grant SET revoked_at = ? WHERE rule_id = ? AND revoked_at IS NULL',
        )
        .run(now, id);
      this.#db.raw.prepare('DELETE FROM policy_rule WHERE id = ?').run(id);
    });
  }

  // ---- command rules ----------------------------------------------------------------------

  async listCommandRules(accountId: string): Promise<CommandRuleView[]> {
    const rows = await this.#db.orm
      .select()
      .from(commandRule)
      .where(eq(commandRule.accountId, accountId))
      .orderBy(commandRule.priority, commandRule.createdAt);
    return rows.map(commandView);
  }

  async #commandRow(accountId: string, id: string): Promise<CommandRuleRow> {
    const rows = await this.#db.orm
      .select()
      .from(commandRule)
      .where(and(eq(commandRule.id, id), eq(commandRule.accountId, accountId)))
      .limit(1);
    if (!rows[0]) throw new NovaError('not_found', 'command rule not found');
    return rows[0];
  }

  /** Build a validated row; a failing example is a `validation` error naming it. */
  commandRow(
    accountId: string,
    input: CommandRuleInput,
    source: 'user' | 'managed' | 'plugin',
    id: string = uuidv7(),
  ): CommandRuleRow {
    const scopeKind = input.scopeKind ?? 'global';
    const scopeRef = input.scopeRef ?? null;
    if (scopeKind !== 'global' && !scopeRef)
      throw new NovaError('validation', `a ${scopeKind} command rule needs a scopeRef`);
    const rule = {
      pattern: input.pattern,
      decision: input.decision,
      matchExamples: input.matchExamples,
      notMatchExamples: input.notMatchExamples,
    };
    const problem = checkCommandRule(rule);
    if (problem) {
      throw new NovaError('validation', problem.message, {
        details:
          problem.kind === 'example'
            ? {
                field: problem.expected === 'match' ? 'matchExamples' : 'notMatchExamples',
                example: problem.example,
              }
            : {
                field: !problem.message.startsWith('a rule needs')
                  ? 'pattern'
                  : input.matchExamples.length === 0
                    ? 'matchExamples'
                    : 'notMatchExamples',
              },
      });
    }
    const now = this.#iso();
    return {
      id,
      accountId,
      scopeKind,
      scopeRef,
      patternJson: JSON.stringify(input.pattern),
      toolsJson: JSON.stringify(input.tools ?? ['exec.run']),
      decision: input.decision,
      priority: input.priority ?? 100,
      hostExecutablesJson: null,
      justification: input.justification ?? null,
      matchExamplesJson: JSON.stringify(input.matchExamples),
      notMatchExamplesJson: JSON.stringify(input.notMatchExamples),
      source,
      pluginId: null,
      enabled: input.enabled ?? true,
      createdAt: now,
      updatedAt: now,
    };
  }

  async createCommandRule(
    accountId: string,
    input: CommandRuleInput,
    source: 'user' | 'managed' | 'plugin' = 'user',
  ): Promise<CommandRuleView> {
    const row = this.commandRow(accountId, input, source);
    await this.#db.transaction(() => this.#db.orm.insert(commandRule).values(row));
    return commandView(row);
  }

  async updateCommandRule(
    accountId: string,
    id: string,
    patch: Partial<CommandRuleInput>,
  ): Promise<CommandRuleView> {
    const row = await this.#commandRow(accountId, id);
    if (row.source === 'managed') throw managedError();
    const cur = commandView(row);
    const next = this.commandRow(
      accountId,
      {
        scopeKind: patch.scopeKind ?? cur.scopeKind,
        scopeRef: patch.scopeRef !== undefined ? patch.scopeRef : cur.scopeRef,
        pattern: patch.pattern ?? cur.pattern,
        decision: patch.decision ?? cur.decision,
        justification: patch.justification !== undefined ? patch.justification : cur.justification,
        matchExamples: patch.matchExamples ?? cur.matchExamples,
        notMatchExamples: patch.notMatchExamples ?? cur.notMatchExamples,
        priority: patch.priority ?? cur.priority,
        tools: patch.tools ?? parseJson<string[]>(row.toolsJson, ['exec.run']),
        enabled: patch.enabled ?? cur.enabled,
      },
      row.source,
      id,
    );
    const merged = { ...next, createdAt: row.createdAt };
    await this.#db.transaction(() =>
      this.#db.orm.update(commandRule).set(merged).where(eq(commandRule.id, id)),
    );
    return commandView(merged);
  }

  async deleteCommandRule(accountId: string, id: string): Promise<void> {
    const row = await this.#commandRow(accountId, id);
    if (row.source === 'managed') throw managedError();
    const now = this.#iso();
    await this.#db.transaction(() => {
      this.#db.raw
        .prepare(
          'UPDATE permission_grant SET revoked_at = ? WHERE command_rule_id = ? AND revoked_at IS NULL',
        )
        .run(now, id);
      this.#db.raw.prepare('DELETE FROM command_rule WHERE id = ?').run(id);
    });
  }

  /** Match a command against the account's command rules (in `scopes`, or every scope). */
  async testCommand(
    accountId: string,
    command: string,
    scopes?: Scope[],
  ): Promise<{ decision: 'allow' | 'ask' | 'deny' | null; ruleId: string | null; reason: string }> {
    const rules = (await this.#engineCommandRules(accountId)).filter(
      (r) =>
        !scopes ||
        r.scope.kind === 'global' ||
        scopes.some(
          (s) => s.kind === r.scope.kind && (r.scope.ref === undefined || s.ref === r.scope.ref),
        ),
    );
    const order = (r: CommandRule) => (r.source === 'managed' ? 0 : 1);
    const sorted = [...rules].sort(
      (a, b) =>
        order(a) - order(b) ||
        specificity(b.scope.kind) - specificity(a.scope.kind) ||
        (a.priority ?? 100) - (b.priority ?? 100),
    );
    const ev = evaluateCommand(command, sorted);
    return { decision: ev.decision, ruleId: ev.ruleId, reason: ev.reason };
  }

  async #engineCommandRules(accountId: string): Promise<CommandRule[]> {
    const rows = await this.#db.orm
      .select()
      .from(commandRule)
      .where(and(eq(commandRule.accountId, accountId), eq(commandRule.enabled, true)));
    const rules = rows.map(engineCommandRule);
    const loaded = loadCommandRules(rules);
    if (loaded.ok) {
      this.#lastGoodCommands.set(accountId, loaded.rules);
      this.commandRuleErrors.delete(accountId);
      return loaded.rules;
    }
    // One failing example rejects the whole set; the previous version stays in effect.
    this.commandRuleErrors.set(accountId, `rule ${loaded.ruleId}: ${loaded.problem.message}`);
    return this.#lastGoodCommands.get(accountId) ?? [];
  }

  // ---- grants -----------------------------------------------------------------------------

  async createGrant(accountId: string, g: NewGrant): Promise<GrantRow> {
    const row = this.grantRow(accountId, g);
    await this.#db.transaction(() => this.#db.orm.insert(permissionGrant).values(row));
    return row;
  }

  grantRow(accountId: string, g: NewGrant): GrantRow {
    return {
      id: uuidv7(),
      accountId,
      approvalId: g.approvalId ?? null,
      ruleId: g.ruleId ?? null,
      commandRuleId: g.commandRuleId ?? null,
      duration: g.duration,
      scopeKind: g.scope.kind,
      scopeRef: g.scope.ref ?? null,
      actionMatch: JSON.stringify(g.match),
      host: g.host ?? null,
      label: g.label,
      expiresAt: g.expiresAt ?? null,
      revokedAt: null,
      createdAt: this.#iso(),
    };
  }

  /** Active grants: not revoked and not expired (an expired grant asks again, docs/12 §4.2). */
  async #activeGrants(accountId: string): Promise<GrantRow[]> {
    const rows = await this.#db.orm
      .select()
      .from(permissionGrant)
      .where(and(eq(permissionGrant.accountId, accountId), isNull(permissionGrant.revokedAt)))
      .orderBy(desc(permissionGrant.createdAt));
    const now = this.#iso();
    return rows.filter((r) => r.expiresAt === null || r.expiresAt > now);
  }

  async listGrants(accountId: string): Promise<PermissionGrantView[]> {
    return (await this.#activeGrants(accountId)).map(grantView);
  }

  /** Revoke a grant; an "always" grant also removes the rule it wrote. */
  async revokeGrant(accountId: string, id: string): Promise<void> {
    const rows = await this.#db.orm
      .select()
      .from(permissionGrant)
      .where(and(eq(permissionGrant.id, id), eq(permissionGrant.accountId, accountId)))
      .limit(1);
    const row = rows[0];
    if (!row || row.revokedAt !== null) throw new NovaError('not_found', 'grant not found');
    const now = this.#iso();
    await this.#db.transaction(() => {
      const raw = this.#db.raw;
      raw.prepare('UPDATE permission_grant SET revoked_at = ? WHERE id = ?').run(now, id);
      if (row.ruleId) {
        raw
          .prepare(
            'UPDATE permission_grant SET revoked_at = ? WHERE rule_id = ? AND revoked_at IS NULL',
          )
          .run(now, row.ruleId);
        raw.prepare("DELETE FROM policy_rule WHERE id = ? AND source = 'user'").run(row.ruleId);
      }
      if (row.commandRuleId) {
        raw
          .prepare(
            'UPDATE permission_grant SET revoked_at = ? WHERE command_rule_id = ? AND revoked_at IS NULL',
          )
          .run(now, row.commandRuleId);
        raw
          .prepare("DELETE FROM command_rule WHERE id = ? AND source = 'user'")
          .run(row.commandRuleId);
      }
    });
  }

  // ---- tool defaults (FR-048) -------------------------------------------------------------

  async listToolDefaults(accountId: string): Promise<{ tool: string; default: DefaultEffect }[]> {
    const rows = await this.#db.orm
      .select()
      .from(toolDefault)
      .where(eq(toolDefault.accountId, accountId))
      .orderBy(toolDefault.tool);
    return rows.map((r) => ({ tool: r.tool, default: r.effect }));
  }

  async toolDefaults(accountId: string): Promise<Record<string, DefaultEffect>> {
    return Object.fromEntries(
      (await this.listToolDefaults(accountId)).map((d) => [d.tool, d.default]),
    );
  }

  async setToolDefault(
    accountId: string,
    tool: string,
    value: DefaultEffect | null,
  ): Promise<{ tool: string; default: DefaultEffect | null }> {
    await this.#db.transaction(() => {
      const raw = this.#db.raw;
      raw
        .prepare('DELETE FROM tool_default WHERE account_id = ? AND tool = ?')
        .run(accountId, tool);
      if (value !== null) {
        raw
          .prepare(
            'INSERT INTO tool_default (account_id, tool, effect, updated_at) VALUES (?, ?, ?, ?)',
          )
          .run(accountId, tool, value, this.#iso());
      }
    });
    return { tool, default: value };
  }

  // ---- permission profiles (FR-190) ------------------------------------------------------

  async listProfiles(accountId: string): Promise<PermissionProfileView[]> {
    const all = await allPermissionProfiles(this.#db, accountId);
    const lookup = (id: string) => all.find((p) => p.id === id);
    const out: PermissionProfileView[] = [];
    for (const p of all) {
      let flat: PermissionProfile;
      try {
        flat = flattenProfile(p, lookup);
      } catch {
        continue;
      }
      out.push({
        id: p.id,
        name: p.name,
        builtin: p.builtin === true,
        fs: flat.filesystem,
        network: {
          mode: flat.network.mode,
          allow: flat.network.allow ?? [],
          deny: flat.network.deny ?? [],
        },
        requiresSubstrate: flat.requiresSubstrate ?? null,
        hash: profileHash(flat),
      });
    }
    return out;
  }

  async createProfile(accountId: string, input: ProfileInput): Promise<PermissionProfileView> {
    const all = await allPermissionProfiles(this.#db, accountId);
    if (all.some((p) => p.name === input.name))
      throw new NovaError('conflict', `a profile named ${input.name} already exists`);
    const id = uuidv7();
    const profile: PermissionProfile = {
      id,
      name: input.name,
      source: 'user',
      filesystem: input.filesystem,
      network: input.network,
    };
    if (input.extends) profile.extends = input.extends;
    const problem = checkProfile(profile);
    if (problem) throw new NovaError('validation', problem);
    let flat: PermissionProfile;
    try {
      flat = flattenProfile(profile, (pid) =>
        pid === id ? profile : all.find((p) => p.id === pid),
      );
    } catch (err) {
      throw new NovaError('validation', err instanceof Error ? err.message : String(err));
    }
    const now = this.#iso();
    await this.#db.transaction(() =>
      this.#db.orm.insert(permissionProfile).values({
        id,
        accountId,
        name: input.name,
        builtin: false,
        extends: input.extends ?? null,
        fsRulesJson: JSON.stringify(input.filesystem),
        networkJson: JSON.stringify(input.network),
        requiresSubstrate: flat.requiresSubstrate ?? null,
        source: 'user',
        createdAt: now,
        updatedAt: now,
      }),
    );
    return (await this.listProfiles(accountId)).find((p) => p.id === id)!;
  }

  async deleteProfile(accountId: string, id: string): Promise<void> {
    if (BUILTIN_PROFILES.some((p) => p.id === id))
      throw new NovaError('policy_denied', 'built-in profiles cannot be deleted');
    const rows = await this.#db.orm
      .select()
      .from(permissionProfile)
      .where(and(eq(permissionProfile.id, id), eq(permissionProfile.accountId, accountId)))
      .limit(1);
    const row = rows[0];
    if (!row) throw new NovaError('not_found', 'profile not found');
    if (row.source === 'managed') throw managedError();
    const children = await this.#db.orm
      .select({ id: permissionProfile.id })
      .from(permissionProfile)
      .where(eq(permissionProfile.extends, id));
    if (children.length) throw new NovaError('conflict', 'another profile extends this one');
    await this.#db.transaction(() =>
      this.#db.orm.delete(permissionProfile).where(eq(permissionProfile.id, id)),
    );
  }

  // ---- the policy set for one call --------------------------------------------------------

  /**
   * Everything the engine needs from storage: managed and user rules (minus "always" rules whose
   * grant expired), the command rules that passed their examples, the thread's session grants and
   * the user's per-tool defaults. `~` in path rules expands to `home`.
   */
  async policySet(
    accountId: string,
    opts: { threadId?: string | null; home?: string | null } = {},
  ): Promise<PolicySet> {
    const [ruleRows, commands, grants, defaults] = await Promise.all([
      this.#db.orm
        .select()
        .from(policyRule)
        .where(and(eq(policyRule.accountId, accountId), eq(policyRule.enabled, true))),
      this.#engineCommandRules(accountId),
      this.#db.orm
        .select()
        .from(permissionGrant)
        .where(and(eq(permissionGrant.accountId, accountId), isNull(permissionGrant.revokedAt))),
      this.toolDefaults(accountId),
    ]);
    const now = this.#iso();
    const dead = (g: GrantRow) => g.expiresAt !== null && g.expiresAt <= now;
    const deadRules = new Set(grants.filter((g) => dead(g) && g.ruleId).map((g) => g.ruleId!));
    const deadCommands = new Set(
      grants.filter((g) => dead(g) && g.commandRuleId).map((g) => g.commandRuleId!),
    );
    const home = opts.home ?? null;
    const rules = ruleRows.filter((r) => !deadRules.has(r.id)).map((r) => engineRule(r, home));
    const session: PolicyGrant[] = grants
      .filter(
        (g) =>
          !dead(g) &&
          g.duration === 'session' &&
          g.scopeKind === 'session' &&
          opts.threadId !== undefined &&
          opts.threadId !== null &&
          g.scopeRef === opts.threadId,
      )
      .map((g) => {
        const m = parseJson<GrantMatch>(g.actionMatch, { tool: '' });
        const out: PolicyGrant = {
          id: g.id,
          scope: { kind: 'session', ref: g.scopeRef! },
          tool: m.tool,
          label: g.label,
        };
        if (g.host) out.host = g.host;
        if (m.command) out.command = m.command;
        if (m.argsHash) out.argsHash = m.argsHash;
        return out;
      })
      .filter((g) => g.tool !== '');
    return {
      managed: rules.filter((r) => r.source === 'managed'),
      rules: rules.filter((r) => r.source !== 'managed'),
      commandRules: commands.filter((c) => !deadCommands.has(c.id)),
      grants: session,
      toolDefaults: defaults,
    };
  }

  /** A validated user rule row (not stored). */
  ruleRow(
    accountId: string,
    input: PolicyRuleInput,
    source: 'user' | 'managed' | 'plugin' = 'user',
  ): PolicyRuleRow {
    const now = this.#iso();
    return {
      id: uuidv7(),
      accountId,
      ...checkRuleInput(input),
      source,
      createdAt: now,
      updatedAt: now,
    };
  }

  /**
   * Insert rows synchronously, for use inside a transaction that must not yield (an approval
   * decision and the rule and grant it writes commit together).
   */
  insertSync(rows: { rule?: PolicyRuleRow; command?: CommandRuleRow; grant?: GrantRow }): void {
    const raw = this.#db.raw;
    if (rows.rule) {
      const r = rows.rule;
      raw
        .prepare(
          `INSERT INTO policy_rule (id, account_id, scope_kind, scope_ref, action_match, effect, label,
             priority, source, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          r.id,
          r.accountId,
          r.scopeKind,
          r.scopeRef,
          r.actionMatch,
          r.effect,
          r.label,
          r.priority,
          r.source,
          r.enabled ? 1 : 0,
          r.createdAt,
          r.updatedAt,
        );
    }
    if (rows.command) {
      const c = rows.command;
      raw
        .prepare(
          `INSERT INTO command_rule (id, account_id, scope_kind, scope_ref, pattern_json, tools_json,
             decision, priority, host_executables_json, justification, match_examples_json,
             not_match_examples_json, source, plugin_id, enabled, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          c.id,
          c.accountId,
          c.scopeKind,
          c.scopeRef,
          c.patternJson,
          c.toolsJson,
          c.decision,
          c.priority,
          c.hostExecutablesJson,
          c.justification,
          c.matchExamplesJson,
          c.notMatchExamplesJson,
          c.source,
          c.pluginId,
          c.enabled ? 1 : 0,
          c.createdAt,
          c.updatedAt,
        );
    }
    if (rows.grant) {
      const g = rows.grant;
      raw
        .prepare(
          `INSERT INTO permission_grant (id, account_id, approval_id, rule_id, command_rule_id, duration,
             scope_kind, scope_ref, action_match, host, label, expires_at, revoked_at, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          g.id,
          g.accountId,
          g.approvalId,
          g.ruleId,
          g.commandRuleId,
          g.duration,
          g.scopeKind,
          g.scopeRef,
          g.actionMatch,
          g.host,
          g.label,
          g.expiresAt,
          g.revokedAt,
          g.createdAt,
        );
    }
  }

  // ---- approvals --------------------------------------------------------------------------

  async insertApproval(row: ApprovalRow): Promise<void> {
    await this.#db.transaction(() => this.#db.orm.insert(approval).values(row));
  }

  async approvalRow(accountId: string, id: string): Promise<ApprovalRow> {
    const rows = await this.#db.orm
      .select()
      .from(approval)
      .where(and(eq(approval.id, id), eq(approval.accountId, accountId)))
      .limit(1);
    if (!rows[0]) throw new NovaError('not_found', 'approval not found');
    return rows[0];
  }

  async getApproval(accountId: string, id: string): Promise<ApprovalView> {
    const [view] = this.#withOrigin(accountId, [
      approvalView(await this.approvalRow(accountId, id)),
    ]);
    return view!;
  }

  async listApprovals(
    accountId: string,
    q: { status?: 'pending' | 'all'; threadId?: string } = {},
  ): Promise<ApprovalView[]> {
    const where = [eq(approval.accountId, accountId)];
    if ((q.status ?? 'pending') === 'pending') where.push(eq(approval.status, 'pending'));
    if (q.threadId) where.push(eq(approval.threadId, q.threadId));
    const rows = await this.#db.orm
      .select()
      .from(approval)
      .where(and(...where))
      .orderBy(desc(approval.createdAt), desc(approval.id))
      .limit(200);
    return this.#withOrigin(accountId, rows.map(approvalView));
  }

  /**
   * Where each approval comes from (M7): its thread's title and the Work run or Code session
   * that thread belongs to, in one query, so a client never lists threads to say so.
   */
  #withOrigin(accountId: string, views: ApprovalView[]): ApprovalView[] {
    const ids = [...new Set(views.flatMap((v) => (v.threadId ? [v.threadId] : [])))];
    const origin = new Map<
      string,
      { title: string | null; run_id: string | null; session_id: string | null }
    >();
    for (let i = 0; i < ids.length; i += 500) {
      const chunk = ids.slice(i, i + 500);
      const rows = this.#db.raw
        .prepare(
          `SELECT t.id AS id, t.title AS title,
             (SELECT r.id FROM run r WHERE r.thread_id = t.id AND r.account_id = t.account_id)
               AS run_id,
             (SELECT c.id FROM code_session c
              WHERE c.thread_id = t.id AND c.account_id = t.account_id) AS session_id
           FROM thread t
           WHERE t.account_id = ? AND t.deleted_at IS NULL AND t.id IN (${chunk.map(() => '?').join(', ')})`,
        )
        .all(accountId, ...chunk) as unknown as {
        id: string;
        title: string | null;
        run_id: string | null;
        session_id: string | null;
      }[];
      for (const r of rows) origin.set(r.id, r);
    }
    return views.map((v) => {
      const o = v.threadId ? origin.get(v.threadId) : undefined;
      return {
        ...v,
        runId: v.runId ?? o?.run_id ?? null,
        codeSessionId: o?.session_id ?? null,
        threadTitle: o?.title ?? null,
      };
    });
  }

  /** The reason the user gave when they denied an identical call in this thread, if they did. */
  deniedBefore(accountId: string, threadId: string, tool: string, argsHash: string): string | null {
    const row = this.#db.raw
      .prepare(
        `SELECT deny_reason FROM approval
         WHERE account_id = ? AND thread_id = ? AND tool_name = ? AND args_hash = ?
           AND decision = 'deny_continue'
         ORDER BY decided_at DESC LIMIT 1`,
      )
      .get(accountId, threadId, tool, argsHash) as { deny_reason: string | null } | undefined;
    if (!row) return null;
    return row.deny_reason ?? '';
  }

  /**
   * After a crash nobody is waiting for a pending approval: record them as cancelled and put
   * threads left waiting back to idle. Returns how many approvals were cancelled.
   */
  async recoverPending(): Promise<number> {
    return this.#db.transaction(() => {
      const res = this.#db.raw
        .prepare("UPDATE approval SET status = 'cancelled' WHERE status = 'pending'")
        .run();
      this.#db.raw
        .prepare("UPDATE thread SET state = 'idle' WHERE state = 'waiting_approval'")
        .run();
      return Number(res.changes);
    });
  }

  pendingCount(): Promise<number> {
    const row = this.#db.raw
      .prepare("SELECT count(*) AS n FROM approval WHERE status = 'pending'")
      .get() as { n: number };
    return Promise.resolve(row.n);
  }
}

// ---- mapping ------------------------------------------------------------------------------

function managedError(): NovaError {
  return new NovaError('policy_denied', 'managed by your organization');
}

const SPECIFICITY: Record<string, number> = {
  session: 5,
  thread: 5,
  agent: 4,
  project: 3,
  global: 1,
};
function specificity(kind: string): number {
  return SPECIFICITY[kind] ?? 0;
}

function checkRuleInput(
  input: PolicyRuleInput,
): Pick<
  PolicyRuleRow,
  'scopeKind' | 'scopeRef' | 'actionMatch' | 'effect' | 'label' | 'priority' | 'enabled'
> {
  const scopeRef = input.scopeRef ?? null;
  if (input.scopeKind !== 'global' && !scopeRef)
    throw new NovaError('validation', `a ${input.scopeKind} rule needs a scopeRef`);
  const match: RuleMatch = {};
  if (input.match.tool) match.tool = [input.match.tool];
  if (input.match.resource) match.resource = resourceMatcher(input.match.resource);
  if (input.match.effects?.length) {
    const bad = input.match.effects.find(
      (e) => !(RULE_EFFECT_CLASSES as readonly string[]).includes(e),
    );
    if (bad) throw new NovaError('validation', `rules cannot match the effect class ${bad}`);
    match.effect = input.match.effects;
  }
  return {
    scopeKind: input.scopeKind,
    scopeRef: input.scopeKind === 'global' ? null : scopeRef,
    actionMatch: JSON.stringify(match),
    effect: input.effect,
    label: input.label ?? null,
    priority: input.priority ?? 100,
    enabled: input.enabled ?? true,
  };
}

export function ruleView(r: PolicyRuleRow): PolicyRuleView {
  const m = parseJson<RuleMatch>(r.actionMatch, {});
  const match: PolicyRuleView['match'] = {};
  if (m.tool?.length) match.tool = m.tool.join(', ');
  const res = resourceText(m.resource);
  if (res) match.resource = res;
  if (m.effect?.length) match.effects = m.effect;
  return {
    id: r.id,
    scopeKind: r.scopeKind as PolicyRuleView['scopeKind'],
    scopeRef: r.scopeRef,
    match,
    effect: r.effect,
    label: r.label,
    priority: r.priority,
    source: r.source,
    enabled: r.enabled,
    createdAt: r.createdAt,
  };
}

function engineRule(r: PolicyRuleRow, home: string | null): PolicyRule {
  const match = parseJson<RuleMatch>(r.actionMatch, {});
  const prefix = match.resource?.pathPrefix;
  if (prefix && home && (prefix === '~' || prefix.startsWith('~/')))
    match.resource = { ...match.resource, pathPrefix: `${home}${prefix.slice(1)}` };
  const rule: PolicyRule = {
    id: r.id,
    priority: r.priority,
    enabled: r.enabled,
    source: r.source,
    scope: r.scopeRef ? { kind: r.scopeKind, ref: r.scopeRef } : { kind: r.scopeKind },
    match,
    effect: r.effect,
  };
  if (r.label) rule.label = r.label;
  return rule;
}

export function commandView(r: CommandRuleRow): CommandRuleView {
  const examples = (json: string) =>
    parseJson<(string | string[])[]>(json, []).map((e) =>
      typeof e === 'string' ? e : e.join(' '),
    );
  return {
    id: r.id,
    scopeKind: r.scopeKind,
    scopeRef: r.scopeRef,
    pattern: parseJson<(string | string[])[]>(r.patternJson, []),
    decision: r.decision,
    justification: r.justification,
    matchExamples: examples(r.matchExamplesJson),
    notMatchExamples: examples(r.notMatchExamplesJson),
    priority: r.priority,
    source: r.source,
    enabled: r.enabled,
    createdAt: r.createdAt,
  };
}

function engineCommandRule(r: CommandRuleRow): CommandRule {
  const rule: CommandRule = {
    id: r.id,
    scope: r.scopeRef ? { kind: r.scopeKind, ref: r.scopeRef } : { kind: r.scopeKind },
    tools: parseJson<string[]>(r.toolsJson, ['exec.run']),
    pattern: parseJson<(string | string[])[]>(r.patternJson, []),
    decision: r.decision,
    priority: r.priority,
    matchExamples: parseJson<(string | string[])[]>(r.matchExamplesJson, []),
    notMatchExamples: parseJson<(string | string[])[]>(r.notMatchExamplesJson, []),
    source: r.source,
    enabled: r.enabled,
  };
  if (r.justification) rule.justification = r.justification;
  if (r.hostExecutablesJson) rule.hostExecutables = parseJson<string[]>(r.hostExecutablesJson, []);
  if (r.pluginId) rule.pluginId = r.pluginId;
  return rule;
}

export function grantView(g: GrantRow): PermissionGrantView {
  const m = parseJson<GrantMatch>(g.actionMatch, { tool: '' });
  return {
    id: g.id,
    duration: g.duration,
    label: g.label,
    tool: m.tool || null,
    host: g.host,
    commandRuleId: g.commandRuleId,
    scopeKind: g.scopeKind,
    scopeRef: g.scopeRef,
    expiresAt: g.expiresAt,
    createdAt: g.createdAt,
  };
}

export function approvalView(r: ApprovalRow): ApprovalView {
  return {
    id: r.id,
    threadId: r.threadId,
    turnId: r.turnId,
    callId: r.toolCallId,
    action: r.requestedAction,
    tool: r.toolName,
    argsPreview: r.argsPreview,
    reason: r.reason ?? '',
    tier: r.tier ?? 'pre_approvable',
    risk: r.risk,
    userAsked: r.userAsked,
    ruleId: r.ruleId,
    ruleLabel: r.ruleLabel,
    alwaysAllowManaged: r.alwaysAllowManaged,
    options: parseJson<ApprovalView['options']>(r.optionsJson, []),
    alwaysScopes: parseJson<ApprovalView['alwaysScopes']>(r.alwaysScopesJson, []),
    status: r.status,
    decision: r.decision,
    decidedBy: r.decidedBy,
    createdAt: r.createdAt,
    expiresAt: r.expiresAt ?? r.createdAt,
    decidedAt: r.decidedAt,
    // The store adds the thread's run, Code session and title (`#withOrigin`).
    runId: r.runId,
    codeSessionId: null,
    threadTitle: null,
    answerIn: r.answerIn ?? null,
    scope: r.scope ?? null,
  };
}
