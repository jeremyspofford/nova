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
import { isIP } from 'node:net';
import {
  NovaError,
  type BrowserSiteLevel,
  type BrowserSiteView,
  type PutBrowserSiteRequest,
} from '@nova/shared';
import { hostMatch } from '@nova/policy';
import type { NovaDatabase } from '@nova/storage';
import type { SettingReader } from '../approvals/gate.ts';
import type { PolicyStore } from '../approvals/store.ts';
import { isPrivateAddress } from '../tools/web.ts';

/** The tool name page writes are checked under (site rules match it). */
export const BROWSER_ACT_TOOL = 'browser.act';
/** The tool name of the new-site prompt (Allow once / Always allow / Deny). */
export const BROWSER_SITE_TOOL = 'browser.site';

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
  source: 'site' | 'network' | null;
  /** Always ask for a site without an entry (the default for a newly allowed site). */
  level: BrowserSiteLevel;
  devProtocol: boolean;
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

function view(r: SiteRow): BrowserSiteView {
  return {
    pattern: r.pattern,
    access: r.access,
    level: r.level,
    devProtocol: r.dev_protocol === 1,
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

  #rows(accountId: string): SiteRow[] {
    return this.#db.raw
      .prepare('SELECT * FROM browser_site WHERE account_id = ? ORDER BY access, pattern')
      .all(accountId) as unknown as SiteRow[];
  }

  #row(accountId: string, pattern: string): SiteRow | null {
    return (
      (this.#db.raw
        .prepare('SELECT * FROM browser_site WHERE account_id = ? AND pattern = ?')
        .get(accountId, pattern) as unknown as SiteRow | undefined) ?? null
    );
  }

  list(accountId: string): BrowserSiteView[] {
    return this.#rows(accountId).map(view);
  }

  get(accountId: string, pattern: string): BrowserSiteView {
    const r = this.#row(accountId, pattern);
    if (!r) throw new NovaError('not_found', 'no such site');
    return view(r);
  }

  /** Whether the browser may open `host`, and the level its writes run under. */
  async decide(accountId: string, host: string): Promise<SiteDecision> {
    const h = normalizeHost(host);
    const [egressAllow, egressDeny] = await Promise.all([
      this.#setting('network.egressAllow'),
      this.#setting('network.egressDeny'),
    ]);
    const rows = this.#rows(accountId);
    const blocked = rows.find((r) => r.access === 'block' && hostMatch(r.pattern, h));
    if (blocked)
      return {
        access: 'blocked',
        pattern: blocked.pattern,
        source: 'site',
        level: 'always_ask',
        devProtocol: false,
      };
    const denied = egressDeny.find((p) => hostMatch(p, h));
    if (denied)
      return {
        access: 'blocked',
        pattern: denied,
        source: 'network',
        level: 'always_ask',
        devProtocol: false,
      };
    const allowed = rows
      .filter((r) => r.access === 'allow' && sameSite(r.pattern, h))
      .sort((a, b) => specificity(b.pattern) - specificity(a.pattern))[0];
    if (allowed)
      return {
        access: 'allowed',
        pattern: allowed.pattern,
        source: 'site',
        level: allowed.level ?? 'always_ask',
        devProtocol: allowed.dev_protocol === 1,
      };
    const listed = egressAllow.find((p) => hostMatch(p, h));
    if (listed)
      return {
        access: 'allowed',
        pattern: listed,
        source: 'network',
        level: 'always_ask',
        devProtocol: false,
      };
    return {
      access: 'unknown',
      pattern: null,
      source: null,
      level: 'always_ask',
      devProtocol: false,
    };
  }

  /** The patterns the egress proxy lets the browser reach, and the ones it never does. */
  async networkLists(accountId: string): Promise<{
    allow: string[];
    deny: string[];
    mode: 'off' | 'allowlist' | 'limited';
    /** Sites the owner allowed by exact name (local addresses under browser.allowLocalSites). */
    named: string[];
  }> {
    const [egressAllow, egressDeny, egressMode] = await Promise.all([
      this.#setting('network.egressAllow'),
      this.#setting('network.egressDeny'),
      this.#setting('network.egressMode'),
    ]);
    const rows = this.#rows(accountId);
    return {
      // The Hub's network mode bounds the browser like every sandbox (FR-193): off is no
      // network, limited is reads only; allowlist leaves the sites and lists to decide.
      mode: egressMode,
      named: rows
        .filter((r) => r.access === 'allow' && !r.pattern.includes('*'))
        .map((r) => r.pattern),
      allow: [...rows.filter((r) => r.access === 'allow').map((r) => r.pattern), ...egressAllow],
      deny: [...rows.filter((r) => r.access === 'block').map((r) => r.pattern), ...egressDeny],
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
    const input = {
      scopeKind: 'site' as const,
      scopeRef: pattern,
      match: { tool: BROWSER_ACT_TOOL },
      effect: LEVEL_EFFECT[level],
      label: `Browser on ${pattern}: ${LEVEL_LABEL[level]}`,
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

  async #deleteRule(accountId: string, id: string): Promise<void> {
    try {
      await this.#store.deleteRule(accountId, id);
    } catch (err) {
      if (!(err instanceof NovaError) || err.code !== 'not_found') throw err;
    }
  }
}
