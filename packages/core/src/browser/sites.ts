// Site permissions of the agent browser (FR-094, docs/11 §4, §4.4): the allow list with a
// permission level per site, the block list, and developer-protocol mode. Block entries (and the
// sandbox network deny list) always win. A level is enforced by the policy engine through one
// site-scoped user rule on `browser.act`, the tool name every page write is checked under:
//   Always ask           -> `ask` (a rule's ask is never persistable: every write asks)
//   Auto approve w/ rev. -> `allow`, and the browser runs the auto-reviewer before acting
//   Always allow         -> `allow`
// Confirmation tiers from the page-action classifier apply on top at every level: no rule can
// pre-approve them (FR-189). The rule names the site through its scope, not a resource, so it
// never counts as "a rule that names the recipient" of a message.
//
// Levels per scope (M7, docs/11 §4.4): an allowed site may also have a level for one project or
// one agent; the narrower scope wins (agent, then project, then the account), the order the
// policy engine gives those scopes. Each is a row of `browser_site` keyed `<pattern>|<kind>:<ref>`
// (the table needs no new column) with its own site-scoped rule. That rule matches the tool name
// `browser.act:<kind>:<ref>`, and the browser checks a write under that name when the scoped
// level applies, so the account's level rule does not decide there. Every other rule on
// `browser.act` still does: managed rules and denies decide first (see BrowserService).
import { isIP } from 'node:net';
import {
  NovaError,
  type BrowserSiteLevel,
  type BrowserSiteScopeKind,
  type BrowserSiteScopedLevelView,
  type BrowserSiteView,
  type PutBrowserSiteRequest,
} from '@nova/shared';
import { hostMatch } from '@nova/policy';
import type { NovaDatabase } from '@nova/storage';
import type { SettingReader } from '../approvals/gate.ts';
import type { PolicyStore } from '../approvals/store.ts';
import { patternCovered } from '../computers/egress-policy.ts';
import { managedRestrictions } from '../managed/restrictions.ts';
import { isHubOwner } from '../team/owner.ts';
import { isPrivateAddress } from '../tools/web.ts';

/** The tool name page writes are checked under (site rules match it). */
export const BROWSER_ACT_TOOL = 'browser.act';
/** The tool name of the new-site prompt (Allow once / Always allow / Deny). */
export const BROWSER_SITE_TOOL = 'browser.site';

/** The tool name a project's or agent's level rule matches (and the write is checked under). */
export function scopedActTool(kind: BrowserSiteScopeKind, ref: string): string {
  return `${BROWSER_ACT_TOOL}:${kind}:${ref}`;
}

/** Ids a scoped level may name: also safe inside a rule's tool glob. */
const SCOPE_REF = /^[A-Za-z0-9_-]{1,100}$/;
const SCOPE_SEP = '|';

/** The row key of a scoped level. */
function scopedKey(pattern: string, kind: BrowserSiteScopeKind, ref: string): string {
  return `${pattern}${SCOPE_SEP}${kind}:${ref}`;
}

function parseScoped(
  key: string,
): { pattern: string; kind: BrowserSiteScopeKind; ref: string } | null {
  const m = /^([^|]+)\|(project|agent):([A-Za-z0-9_-]{1,100})$/.exec(key);
  return m ? { pattern: m[1]!, kind: m[2] as BrowserSiteScopeKind, ref: m[3]! } : null;
}

/** The scopes of a call: its project and the agent whose thread it is. */
export interface SiteScope {
  projectId: string | null;
  agentId: string | null;
}

const LEVEL_EFFECT: Record<BrowserSiteLevel, 'ask' | 'allow'> = {
  always_ask: 'ask',
  auto_review: 'allow',
  always_allow: 'allow',
};

const LEVEL_LABEL: Record<BrowserSiteLevel, string> = {
  always_ask: 'Always ask',
  auto_review: 'Auto approve with review',
  always_allow: 'Always allow',
};

export interface SiteDecision {
  access: 'allowed' | 'blocked' | 'unknown';
  /** The entry that decided, or the network setting. */
  pattern: string | null;
  /** `managed`: your organization's policy (FR-106). */
  source: 'site' | 'network' | 'managed' | null;
  /** Always ask for a site without an entry (the default for a newly allowed site). */
  level: BrowserSiteLevel;
  devProtocol: boolean;
  /** Where the level comes from: the account, or a narrower project or agent level. */
  scope: { kind: 'account' } | { kind: BrowserSiteScopeKind; ref: string };
  /** The tool name page writes are checked under (`browser.act`, or the scoped name). */
  actTool: string;
  /** The account-wide level rule of the entry, when it has one. */
  accountRuleId: string | null;
}

const ACCOUNT_SCOPE = { kind: 'account' } as const;

function decision(
  d: Pick<SiteDecision, 'access' | 'pattern' | 'source' | 'level' | 'devProtocol'> &
    Partial<SiteDecision>,
): SiteDecision {
  return { scope: ACCOUNT_SCOPE, actTool: BROWSER_ACT_TOOL, accountRuleId: null, ...d };
}

interface SiteRow {
  account_id: string;
  pattern: string;
  access: 'allow' | 'block';
  level: BrowserSiteLevel | null;
  dev_protocol: number;
  rule_id: string | null;
  created_at: string;
  updated_at: string;
}

function view(r: SiteRow, scoped: BrowserSiteScopedLevelView[] = []): BrowserSiteView {
  return {
    pattern: r.pattern,
    access: r.access,
    level: r.level,
    devProtocol: r.dev_protocol === 1,
    scopedLevels: r.access === 'allow' ? scoped : [],
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function scopedView(r: SiteRow): BrowserSiteScopedLevelView | null {
  const k = parseScoped(r.pattern);
  if (!k || !r.level) return null;
  return {
    pattern: k.pattern,
    scopeKind: k.kind,
    scopeRef: k.ref,
    level: r.level,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

/** A host name as the browser compares it: lower case, no trailing dot, no IPv6 brackets. */
export function normalizeHost(host: string): string {
  return host
    .trim()
    .toLowerCase()
    .replace(/\.$/, '')
    .replace(/^\[|\]$/g, '');
}

/** Loopback, private-network and local-only names (docs/12 §8). */
export function isLocalHost(host: string): boolean {
  const h = normalizeHost(host);
  if (isIP(h)) return isPrivateAddress(h);
  return (
    h === 'localhost' ||
    h.endsWith('.localhost') ||
    h.endsWith('.local') ||
    h.endsWith('.internal') ||
    !h.includes('.')
  );
}

/** `example.com` and `www.example.com` are the same site for navigation. */
export function sameSite(pattern: string, host: string): boolean {
  if (hostMatch(pattern, host)) return true;
  if (pattern.startsWith('*.')) return false;
  return host === `www.${pattern}` || pattern === `www.${host}`;
}

/** Loopback names and addresses: where the Hub publishes dev servers. */
export function isLoopbackHost(host: string): boolean {
  const h = normalizeHost(host);
  if (h === 'localhost' || h.endsWith('.localhost')) return true;
  if (isIP(h) === 4) return h.split('.')[0] === '127';
  return h === '::1' || h === '0:0:0:0:0:0:0:1';
}

/** What a running browser may reach, refreshed by the service before each action. */
export interface SitePermissions {
  allow: readonly string[];
  deny: readonly string[];
  allowLocal: boolean;
  /** Dev servers granted to this browser (FR-097): `host:port`, loopback only. */
  devServers?: readonly string[];
}

/** The `host:port` origin key of a URL (default ports filled in), or null. */
export function originKey(url: string): string | null {
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    const port = u.port ? Number(u.port) : u.protocol === 'https:' ? 443 : 80;
    return `${normalizeHost(u.hostname)}:${port}`;
  } catch {
    return null;
  }
}

/**
 * A granted dev server (FR-097, docs/12 §4.2): exactly its host and port, never a blocked host.
 * Local addresses then load without `browser.allowLocalSites`; every other host and port of
 * that address still follows the rules below.
 */
export function devServerAllowed(perm: SitePermissions, url: string): boolean {
  if (!perm.devServers?.length) return false;
  const key = originKey(url);
  if (!key || !perm.devServers.includes(key)) return false;
  const host = normalizeHost(new URL(url).hostname);
  return !perm.deny.some((p) => hostMatch(p, host));
}

/**
 * A main-frame navigation: never to a blocked site, never to a local address without
 * `browser.allowLocalSites`, and otherwise only to an allowed site or the host allowed once.
 */
export function navigationAllowed(
  perm: SitePermissions,
  visitHost: string | null,
  rawHost: string,
): boolean {
  const host = normalizeHost(rawHost);
  if (perm.deny.some((p) => hostMatch(p, host))) return false;
  if (isLocalHost(host) && !perm.allowLocal) return false;
  if (visitHost && sameSite(visitHost, host)) return true;
  return perm.allow.some((p) => sameSite(p, host));
}

/** A subresource: like a navigation, and subdomains of an allowed host load too. */
export function requestAllowed(
  perm: SitePermissions,
  visitHost: string | null,
  rawHost: string,
): boolean {
  const host = normalizeHost(rawHost);
  if (navigationAllowed(perm, visitHost, host)) return true;
  if (perm.deny.some((p) => hostMatch(p, host))) return false;
  if (isLocalHost(host) && !perm.allowLocal) return false;
  const parents = [...perm.allow, ...(visitHost ? [visitHost] : [])].filter(
    (p) => !p.startsWith('*.'),
  );
  return parents.some((p) => hostMatch(`*.${p}`, host));
}

/** The more specific of two patterns that both match: exact beats wildcard, longer beats shorter. */
function specificity(pattern: string): number {
  return (pattern.startsWith('*.') ? 0 : 10_000) + pattern.length;
}

export interface BrowserSitesOptions {
  db: NovaDatabase;
  store: PolicyStore;
  setting: SettingReader;
  now?: () => Date;
}

export class BrowserSites {
  readonly #db: NovaDatabase;
  readonly #store: PolicyStore;
  readonly #setting: SettingReader;
  readonly #now: () => Date;

  constructor(opts: BrowserSitesOptions) {
    this.#db = opts.db;
    this.#store = opts.store;
    this.#setting = opts.setting;
    this.#now = opts.now ?? (() => new Date());
  }

  /** The account's sites (scoped level rows are apart: their key has a `|`). */
  #rows(accountId: string): SiteRow[] {
    return this.#db.raw
      .prepare(
        "SELECT * FROM browser_site WHERE account_id = ? AND instr(pattern, '|') = 0 ORDER BY access, pattern",
      )
      .all(accountId) as unknown as SiteRow[];
  }

  #row(accountId: string, pattern: string): SiteRow | null {
    if (pattern.includes(SCOPE_SEP)) return null;
    return (
      (this.#db.raw
        .prepare('SELECT * FROM browser_site WHERE account_id = ? AND pattern = ?')
        .get(accountId, pattern) as unknown as SiteRow | undefined) ?? null
    );
  }

  /** Scoped level rows, by site pattern. */
  #scopedRows(accountId: string): Map<string, SiteRow[]> {
    const rows = this.#db.raw
      .prepare(
        "SELECT * FROM browser_site WHERE account_id = ? AND instr(pattern, '|') > 0 ORDER BY pattern",
      )
      .all(accountId) as unknown as SiteRow[];
    const out = new Map<string, SiteRow[]>();
    for (const r of rows) {
      const k = parseScoped(r.pattern);
      if (!k) continue;
      const list = out.get(k.pattern) ?? [];
      list.push(r);
      out.set(k.pattern, list);
    }
    return out;
  }

  #scopedViews(rows: SiteRow[] | undefined): BrowserSiteScopedLevelView[] {
    return (rows ?? []).map(scopedView).filter((v): v is BrowserSiteScopedLevelView => !!v);
  }

  list(accountId: string): BrowserSiteView[] {
    const scoped = this.#scopedRows(accountId);
    return this.#rows(accountId).map((r) => view(r, this.#scopedViews(scoped.get(r.pattern))));
  }

  get(accountId: string, pattern: string): BrowserSiteView {
    const r = this.#row(accountId, pattern);
    if (!r) throw new NovaError('not_found', 'no such site');
    return view(r, this.#scopedViews(this.#scopedRows(accountId).get(r.pattern)));
  }

  /**
   * Whether the browser may open `host`, and the level its writes run under: the narrowest of
   * the agent's, the project's and the account's level for the site's entry.
   */
  async decide(accountId: string, host: string, scope?: SiteScope): Promise<SiteDecision> {
    const h = normalizeHost(host);
    const [ownAllow, egressDeny, restrict] = await Promise.all([
      this.#setting('network.egressAllow'),
      this.#setting('network.egressDeny'),
      this.#setting('managed.restrict'),
    ]);
    // Managed policy's browser domains decide first: no entry can open a site it refuses. Its
    // egress allow list is a ceiling over the owner's (ADR-097).
    const managed = managedRestrictions(restrict);
    const egressAllow = managed.egressAllow(ownAllow);
    if (managed.browserDomain(h))
      return decision({
        access: 'blocked',
        pattern: null,
        source: 'managed',
        level: 'always_ask',
        devProtocol: false,
      });
    const rows = this.#rows(accountId);
    const blocked = rows.find((r) => r.access === 'block' && hostMatch(r.pattern, h));
    if (blocked)
      return decision({
        access: 'blocked',
        pattern: blocked.pattern,
        source: 'site',
        level: 'always_ask',
        devProtocol: false,
      });
    const denied = egressDeny.find((p) => hostMatch(p, h));
    if (denied)
      return decision({
        access: 'blocked',
        pattern: denied,
        source: 'network',
        level: 'always_ask',
        devProtocol: false,
      });
    const allowed = rows
      .filter((r) => r.access === 'allow' && sameSite(r.pattern, h))
      .sort((a, b) => specificity(b.pattern) - specificity(a.pattern))[0];
    if (allowed) {
      const base = decision({
        access: 'allowed',
        pattern: allowed.pattern,
        source: 'site',
        level: allowed.level ?? 'always_ask',
        devProtocol: allowed.dev_protocol === 1,
        accountRuleId: allowed.rule_id,
      });
      const narrower = this.#narrowest(accountId, allowed.pattern, scope);
      return narrower ? { ...base, ...narrower } : base;
    }
    const listed = egressAllow.find((p) => hostMatch(p, h));
    if (listed)
      return decision({
        access: 'allowed',
        pattern: listed,
        source: 'network',
        level: 'always_ask',
        devProtocol: false,
      });
    return decision({
      access: 'unknown',
      pattern: null,
      source: null,
      level: 'always_ask',
      devProtocol: false,
    });
  }

  /** The agent's level for the site, else the project's (docs/11 §4.4: the narrower wins). */
  #narrowest(
    accountId: string,
    pattern: string,
    scope: SiteScope | undefined,
  ): Pick<SiteDecision, 'level' | 'scope' | 'actTool'> | null {
    if (!scope) return null;
    const candidates: [BrowserSiteScopeKind, string | null][] = [
      ['agent', scope.agentId],
      ['project', scope.projectId],
    ];
    for (const [kind, ref] of candidates) {
      if (!ref || !SCOPE_REF.test(ref)) continue;
      const r = this.#db.raw
        .prepare('SELECT level FROM browser_site WHERE account_id = ? AND pattern = ?')
        .get(accountId, scopedKey(pattern, kind, ref)) as
        { level: BrowserSiteLevel | null } | undefined;
      if (r?.level)
        return { level: r.level, scope: { kind, ref }, actTool: scopedActTool(kind, ref) };
    }
    return null;
  }

  /** The patterns the egress proxy lets the browser reach, and the ones it never does. */
  async networkLists(accountId: string): Promise<{
    allow: string[];
    deny: string[];
    mode: 'off' | 'allowlist' | 'limited';
    /** Sites the owner allowed by exact name (local addresses under browser.allowLocalSites). */
    named: string[];
  }> {
    const [ownAllow, egressDeny, egressMode, restrict] = await Promise.all([
      this.#setting('network.egressAllow'),
      this.#setting('network.egressDeny'),
      this.#setting('network.egressMode'),
      this.#setting('managed.restrict'),
    ]);
    // Managed policy (FR-106): its denied domains join the deny list, and an allowed site counts
    // only where every allow list of the policy covers it; its egress allow list is a ceiling.
    const managed = managedRestrictions(restrict);
    const egressAllow = managed.egressAllow(ownAllow);
    // Someone who is not the Hub owner may narrow the global allow list, never widen it: their
    // allowed sites count only where the Hub already allows them (decision 5).
    const narrowOnly = !isHubOwner(this.#db, accountId);
    const rows = this.#rows(accountId).filter(
      (r) =>
        r.access !== 'allow' ||
        ((!narrowOnly || patternCovered(egressAllow, r.pattern)) &&
          managed.browserAllows(r.pattern)),
    );
    return {
      // The Hub's network mode bounds the browser like every sandbox (FR-193): off is no
      // network, limited is reads only; allowlist leaves the sites and lists to decide.
      mode: egressMode,
      named: rows
        .filter((r) => r.access === 'allow' && !r.pattern.includes('*'))
        .map((r) => r.pattern),
      allow: [
        ...rows.filter((r) => r.access === 'allow').map((r) => r.pattern),
        ...egressAllow.filter((p) => managed.browserAllows(p)),
      ],
      deny: [
        ...rows.filter((r) => r.access === 'block').map((r) => r.pattern),
        ...egressDeny,
        ...managed.browserDeny(),
      ],
    };
  }

  /**
   * Add or change a site (Settings, or "Always allow" on the new-site prompt). A new allowed site
   * starts at Always ask. Turning developer-protocol mode on needs `browser.devProtocol`.
   */
  async put(accountId: string, input: PutBrowserSiteRequest): Promise<BrowserSiteView> {
    const pattern = normalizeHost(input.pattern);
    if (pattern === '*' || pattern === '')
      throw new NovaError('validation', 'a site must name a host; a bare * is not allowed');
    const access = input.access ?? 'allow';
    const prev = this.#row(accountId, pattern);
    const level: BrowserSiteLevel | null =
      access === 'block' ? null : (input.level ?? prev?.level ?? 'always_ask');
    let devProtocol = access === 'block' ? false : (input.devProtocol ?? prev?.dev_protocol === 1);
    if (input.access === 'block' && input.devProtocol)
      throw new NovaError('validation', 'a blocked site cannot use developer-protocol mode');
    if (input.devProtocol === true && !(await this.#setting('browser.devProtocol')))
      throw new NovaError('policy_denied', 'developer-protocol mode is turned off by policy', {
        details: { setting: 'browser.devProtocol' },
      });
    if (access === 'block') devProtocol = false;
    // A blocked site has no levels, in any scope.
    if (access === 'block') await this.#removeScopedOf(accountId, pattern);
    const ruleId = await this.#syncRule(accountId, pattern, level, prev?.rule_id ?? null);
    const now = this.#now().toISOString();
    await this.#db.transaction(() => {
      this.#db.raw
        .prepare(
          `INSERT INTO browser_site (account_id, pattern, access, level, dev_protocol, rule_id, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (account_id, pattern) DO UPDATE SET access = excluded.access,
             level = excluded.level, dev_protocol = excluded.dev_protocol,
             rule_id = excluded.rule_id, updated_at = excluded.updated_at`,
        )
        .run(accountId, pattern, access, level, devProtocol ? 1 : 0, ruleId, now, now);
    });
    return this.get(accountId, pattern);
  }

  async patch(
    accountId: string,
    pattern: string,
    patch: { level?: BrowserSiteLevel; devProtocol?: boolean },
  ): Promise<BrowserSiteView> {
    const p = normalizeHost(pattern);
    const prev = this.#row(accountId, p);
    if (!prev) throw new NovaError('not_found', 'no such site');
    if (prev.access === 'block' && (patch.level || patch.devProtocol))
      throw new NovaError('validation', 'a blocked site has no level or developer-protocol mode');
    const input: PutBrowserSiteRequest = { pattern: p, access: prev.access };
    if (patch.level) input.level = patch.level;
    if (patch.devProtocol !== undefined) input.devProtocol = patch.devProtocol;
    return this.put(accountId, input);
  }

  /**
   * Remove a site: its row, its level rule, and the "Always allow" rules the new-site prompt
   * wrote for it (so the next visit asks again).
   */
  async remove(accountId: string, pattern: string): Promise<void> {
    const p = normalizeHost(pattern);
    const prev = this.#row(accountId, p);
    if (!prev) throw new NovaError('not_found', 'no such site');
    await this.#removeScopedOf(accountId, p);
    if (prev.rule_id) await this.#deleteRule(accountId, prev.rule_id);
    for (const rule of await this.#store.listRules(accountId)) {
      if (rule.source !== 'user') continue;
      const names = (rule.match.tool ?? '').split(', ');
      if (names.includes(BROWSER_SITE_TOOL) && rule.match.resource?.toLowerCase() === p)
        await this.#deleteRule(accountId, rule.id);
    }
    await this.#db.transaction(() => {
      this.#db.raw
        .prepare('DELETE FROM browser_site WHERE account_id = ? AND pattern = ?')
        .run(accountId, p);
    });
  }

  domains(accountId: string): { allow: string[]; deny: string[] } {
    const rows = this.#rows(accountId);
    return {
      allow: rows.filter((r) => r.access === 'allow').map((r) => r.pattern),
      deny: rows.filter((r) => r.access === 'block').map((r) => r.pattern),
    };
  }

  /**
   * Replace a list. Allowed sites that stay keep their level; a pattern on both lists is
   * blocked (deny wins).
   */
  async setDomains(
    accountId: string,
    lists: { allow?: string[]; deny?: string[] },
  ): Promise<{ allow: string[]; deny: string[] }> {
    const current = this.#rows(accountId);
    const deny = lists.deny ? new Set(lists.deny.map(normalizeHost)) : null;
    const allow = lists.allow ? new Set(lists.allow.map(normalizeHost)) : null;
    if (deny) {
      for (const r of current.filter((x) => x.access === 'block' && !deny.has(x.pattern)))
        await this.remove(accountId, r.pattern);
      for (const p of deny) await this.put(accountId, { pattern: p, access: 'block' });
    }
    if (allow) {
      const blocked = new Set(
        this.#rows(accountId)
          .filter((r) => r.access === 'block')
          .map((r) => r.pattern),
      );
      for (const r of current.filter((x) => x.access === 'allow' && !allow.has(x.pattern)))
        if (this.#row(accountId, r.pattern)?.access === 'allow')
          await this.remove(accountId, r.pattern);
      for (const p of allow) {
        if (blocked.has(p)) continue;
        const prev = this.#row(accountId, p);
        if (prev?.access !== 'allow') await this.put(accountId, { pattern: p, access: 'allow' });
      }
    }
    return this.domains(accountId);
  }

  // ---- levels per project or agent (M7, docs/11 §4.4) ---------------------------------------

  /** Scoped levels, filtered by site, scope kind and scope id. */
  scopedLevels(
    accountId: string,
    q: { pattern?: string; scopeKind?: BrowserSiteScopeKind; scopeRef?: string } = {},
  ): BrowserSiteScopedLevelView[] {
    const pattern = q.pattern ? normalizeHost(q.pattern) : null;
    const out: BrowserSiteScopedLevelView[] = [];
    for (const [p, rows] of this.#scopedRows(accountId)) {
      if (pattern && p !== pattern) continue;
      for (const v of this.#scopedViews(rows)) {
        if (q.scopeKind && v.scopeKind !== q.scopeKind) continue;
        if (q.scopeRef && v.scopeRef !== q.scopeRef) continue;
        out.push(v);
      }
    }
    return out;
  }

  /** The name of a project or agent of the account; `not_found` when there is none. */
  #scopeName(accountId: string, kind: BrowserSiteScopeKind, ref: string): string {
    const r =
      kind === 'project'
        ? (this.#db.raw
            .prepare(
              'SELECT name FROM project WHERE id = ? AND account_id = ? AND deleted_at IS NULL',
            )
            .get(ref, accountId) as { name: string } | undefined)
        : (this.#db.raw
            .prepare('SELECT name FROM agent WHERE id = ? AND account_id = ?')
            .get(ref, accountId) as { name: string } | undefined);
    if (!r) throw new NovaError('not_found', `no such ${kind}`);
    return r.name;
  }

  /**
   * Set a site's level for one project or one agent. The site must be on the allow list (its
   * entry, not a network allow pattern); blocking or removing it removes its scoped levels.
   */
  async putScoped(
    accountId: string,
    input: {
      pattern: string;
      scopeKind: BrowserSiteScopeKind;
      scopeRef: string;
      level: BrowserSiteLevel;
    },
  ): Promise<BrowserSiteScopedLevelView> {
    const pattern = normalizeHost(input.pattern);
    const { scopeKind: kind, scopeRef: ref, level } = input;
    if (!SCOPE_REF.test(ref)) throw new NovaError('validation', `not a ${kind} id`);
    const site = this.#row(accountId, pattern);
    if (!site) throw new NovaError('not_found', 'no such site');
    if (site.access !== 'allow')
      throw new NovaError('validation', 'a blocked site has no levels; allow it first');
    const name = this.#scopeName(accountId, kind, ref);
    const key = scopedKey(pattern, kind, ref);
    const prev = this.#db.raw
      .prepare('SELECT * FROM browser_site WHERE account_id = ? AND pattern = ?')
      .get(accountId, key) as unknown as SiteRow | undefined;
    const ruleId = await this.#writeRule(
      accountId,
      pattern,
      {
        tool: scopedActTool(kind, ref),
        effect: LEVEL_EFFECT[level],
        label: `Browser on ${pattern} in ${kind} "${name.slice(0, 60)}": ${LEVEL_LABEL[level]}`,
      },
      prev?.rule_id ?? null,
    );
    const now = this.#now().toISOString();
    await this.#db.transaction(() => {
      this.#db.raw
        .prepare(
          `INSERT INTO browser_site (account_id, pattern, access, level, dev_protocol, rule_id, created_at, updated_at)
           VALUES (?, ?, 'allow', ?, 0, ?, ?, ?)
           ON CONFLICT (account_id, pattern) DO UPDATE SET level = excluded.level,
             rule_id = excluded.rule_id, updated_at = excluded.updated_at`,
        )
        .run(accountId, key, level, ruleId, now, now);
    });
    const row = this.#db.raw
      .prepare('SELECT * FROM browser_site WHERE account_id = ? AND pattern = ?')
      .get(accountId, key) as unknown as SiteRow;
    return scopedView(row)!;
  }

  /** Remove one scoped level (the site's account-wide level applies there again). */
  async removeScoped(
    accountId: string,
    input: { pattern: string; scopeKind: BrowserSiteScopeKind; scopeRef: string },
  ): Promise<void> {
    const key = scopedKey(normalizeHost(input.pattern), input.scopeKind, input.scopeRef);
    const prev = this.#db.raw
      .prepare('SELECT rule_id FROM browser_site WHERE account_id = ? AND pattern = ?')
      .get(accountId, key) as { rule_id: string | null } | undefined;
    if (!prev) throw new NovaError('not_found', 'no level for that site in that scope');
    await this.#dropScoped(accountId, key, prev.rule_id);
  }

  /** Remove every level of a project or an agent (it was deleted). Returns how many. */
  async removeScope(accountId: string, kind: BrowserSiteScopeKind, ref: string): Promise<number> {
    let n = 0;
    for (const rows of this.#scopedRows(accountId).values())
      for (const r of rows) {
        const k = parseScoped(r.pattern);
        if (k?.kind !== kind || k.ref !== ref) continue;
        await this.#dropScoped(accountId, r.pattern, r.rule_id);
        n++;
      }
    return n;
  }

  async #removeScopedOf(accountId: string, pattern: string): Promise<void> {
    for (const r of this.#scopedRows(accountId).get(pattern) ?? [])
      await this.#dropScoped(accountId, r.pattern, r.rule_id);
  }

  async #dropScoped(accountId: string, key: string, ruleId: string | null): Promise<void> {
    if (ruleId) await this.#deleteRule(accountId, ruleId);
    await this.#db.transaction(() => {
      this.#db.raw
        .prepare('DELETE FROM browser_site WHERE account_id = ? AND pattern = ?')
        .run(accountId, key);
    });
  }

  /** Create or update a site-scoped rule; returns its id. */
  async #writeRule(
    accountId: string,
    pattern: string,
    r: { tool: string; effect: 'ask' | 'allow'; label: string },
    ruleId: string | null,
  ): Promise<string> {
    const input = {
      scopeKind: 'site' as const,
      scopeRef: pattern,
      match: { tool: r.tool },
      effect: r.effect,
      label: r.label,
    };
    if (ruleId) {
      try {
        return (await this.#store.updateRule(accountId, ruleId, input)).id;
      } catch (err) {
        // The user deleted the rule in Settings: write it again.
        if (!(err instanceof NovaError) || err.code !== 'not_found') throw err;
      }
    }
    return (await this.#store.createRule(accountId, input)).id;
  }

  /** Create, update or remove the site rule for a level; returns its id. */
  async #syncRule(
    accountId: string,
    pattern: string,
    level: BrowserSiteLevel | null,
    ruleId: string | null,
  ): Promise<string | null> {
    if (level === null) {
      if (ruleId) await this.#deleteRule(accountId, ruleId);
      return null;
    }
    return this.#writeRule(
      accountId,
      pattern,
      {
        tool: BROWSER_ACT_TOOL,
        effect: LEVEL_EFFECT[level],
        label: `Browser on ${pattern}: ${LEVEL_LABEL[level]}`,
      },
      ruleId,
    );
  }

  async #deleteRule(accountId: string, id: string): Promise<void> {
    try {
      await this.#store.deleteRule(accountId, id);
    } catch (err) {
      if (!(err instanceof NovaError) || err.code !== 'not_found') throw err;
    }
  }
}
