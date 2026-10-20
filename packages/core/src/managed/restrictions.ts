// The checks every area makes against managed policy (FR-106, ADR-097 D4). The `managed.restrict`
// setting carries one `restrict` block per source in force; each block applies on its own, so the
// most restrictive wins (allow lists intersect, deny lists merge, a disabling switch wins,
// docs/12 §10). Each check returns why something is refused, or null; `managedDenied` turns the
// reason into the one refusal shape: `policy_denied` `{reason: managed}`. A setting value that
// does not parse fails closed: every agent tool is denied until the policy is fixed.
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { hostMatch, isWithinPath } from '@nova/policy';
import {
  NovaError,
  managedRestrictSettingSchema,
  type ManagedRestrict,
  type ManagedRestrictSetting,
  type PermissionMode,
  type ToolDescriptor,
} from '@nova/shared';
import { patternCovered } from '../computers/egress-policy.ts';

/** The approval policies of the gate (docs/12 §2.1). */
export type ManagedApprovalKind = 'ask_always' | 'defaults' | 'review' | 'never_ask';

/** Which mode an approval policy stands for: denying the mode denies the policy. */
const APPROVAL_MODE: Partial<Record<ManagedApprovalKind, PermissionMode>> = {
  review: 'auto',
  never_ask: 'bypass',
};

/** Which mode a run's or agent's autonomy stands for (docs/09 §10). */
const AUTONOMY_MODE: Record<string, PermissionMode | undefined> = { autonomous: 'auto' };

const MODE_LABEL: Record<PermissionMode, string> = {
  manual: 'Manual',
  accept_edits: 'Accept edits',
  plan: 'Plan',
  auto: 'Auto',
  bypass: 'Bypass',
};

const BY_POLICY = "by your organization's policy";

/** MCP server origins the user brought: added in Settings, imported, installed from a bundle. */
const USER_ADDED = new Set(['user', 'import', 'bundle']);

/** The refusal of something managed policy does not allow (audited by the Hub, ADR-097 D4). */
export function managedDenied(reason: string, details: Record<string, unknown> = {}): NovaError {
  return new NovaError('policy_denied', reason, {
    details: { ...details, reason: 'managed' },
    action: 'Ask your administrator',
  });
}

/** Whether `value` matches a glob whose `*` matches any run of characters (ignoring case). */
export function globMatch(pattern: string, value: string): boolean {
  const re = pattern
    .split('*')
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*');
  return new RegExp(`^${re}$`, 'i').test(value);
}

function anyGlob(patterns: readonly string[] | undefined, value: string): boolean {
  return (patterns ?? []).some((p) => globMatch(p, value));
}

function anyHost(patterns: readonly string[] | undefined, host: string): boolean {
  return (patterns ?? []).some((p) => hostMatch(p, host));
}

/** `mcp:<server>.<tool>`: the server segment, or null for another tool. */
export function mcpServerOfTool(name: string): string | null {
  const m = /^mcp:([^.]+)\./.exec(name);
  return m ? m[1]! : null;
}

/** `ext:<id>/<name>` (ADR-097 D3): the extension id, or null for another tool. */
export function extensionOfTool(name: string): string | null {
  const m = /^ext:([^/]+)\//.exec(name);
  return m ? m[1]! : null;
}

/** An MCP server as the checks see it. */
export interface ManagedMcpServer {
  name: string;
  /** `user` (added in Settings), `bundle`, `plugin`. */
  source: string;
  transport: string;
  /** A stdio server on a device runs there, not on the Hub. */
  deviceId?: string | null;
}

export interface ManagedRestrictionsOptions {
  /** `~` in folder patterns (default: the Hub user's home). */
  home?: string;
}

export class ManagedRestrictions {
  readonly layers: readonly ManagedRestrict[];
  /** Why the policy fails closed (every agent tool denied), or null. */
  readonly failClosed: string | null;
  readonly #home: string;
  /** The egress allow list in force, worked out against the owner's own list by the policy. */
  readonly #egressAllow: readonly string[] | null;

  constructor(value: ManagedRestrictSetting, opts: ManagedRestrictionsOptions = {}) {
    this.layers = value.layers;
    this.failClosed = value.failClosed;
    this.#home = opts.home ?? homedir();
    this.#egressAllow = value.egressAllow ?? null;
  }

  /** Something is restricted (or the policy fails closed). */
  get active(): boolean {
    return this.failClosed !== null || this.layers.length > 0;
  }

  // ---- permission modes ----------------------------------------------------------------------

  /** Why a Code session mode is not allowed. Manual is the fallback and is never refused. */
  permissionMode(mode: PermissionMode): string | null {
    if (mode === 'manual') return null;
    for (const l of this.layers) {
      const p = l.permissionModes;
      if (!p) continue;
      if (p.deny?.includes(mode) || (p.allow && !p.allow.includes(mode)))
        return `${MODE_LABEL[mode]} mode is turned off ${BY_POLICY}`;
    }
    return null;
  }

  /** Why an approval policy is not allowed (`never_ask` is Bypass's, `review` is Auto's). */
  approvalPolicy(kind: ManagedApprovalKind): string | null {
    const mode = APPROVAL_MODE[kind];
    return mode ? this.permissionMode(mode) : null;
  }

  /** The approval policy to use: a refused one becomes Manual's `ask_always` (fail closed). */
  clampApproval<K extends string>(kind: K): K | 'ask_always' {
    return this.approvalPolicy(kind as ManagedApprovalKind) ? 'ask_always' : kind;
  }

  /** Why a run's or agent's autonomy is not allowed (`autonomous` runs as Auto does). */
  autonomy(autonomy: string): string | null {
    const mode = AUTONOMY_MODE[autonomy];
    if (!mode) return null;
    return this.permissionMode(mode)
      ? `Autonomous work is turned off ${BY_POLICY} (it runs as Auto mode does)`
      : null;
  }

  // ---- tools, plugins, extensions, MCP servers -------------------------------------------------

  /**
   * Why an agent tool may not run: the tool lists, its MCP server, plugin or extension, the site
   * a browser tool would open, and network tools while egress is off.
   */
  tool(
    t: Pick<ToolDescriptor, 'name' | 'source' | 'pluginId' | 'annotations' | 'effects'>,
    host: string | null = null,
    /** The tool reaches the network on its own: an MCP server over http or sse. */
    opts: { remote?: boolean } = {},
  ): string | null {
    if (this.failClosed)
      return `your organization's managed policy could not be read (${this.failClosed}), so agent tools are off until it is fixed`;
    for (const l of this.layers) {
      if (anyGlob(l.tools?.deny, t.name)) return `${t.name} is not allowed ${BY_POLICY}`;
      if (l.tools?.allow && !anyGlob(l.tools.allow, t.name))
        return `${t.name} is not among the tools allowed ${BY_POLICY}`;
    }
    const server = t.source === 'mcp' ? mcpServerOfTool(t.name) : null;
    if (server) {
      const why = this.#serverName(server);
      if (why) return why;
    }
    if (t.pluginId) {
      const why = this.plugin(t.pluginId);
      if (why) return why;
    }
    const ext = extensionOfTool(t.name);
    if (ext) {
      const why = this.extension(ext);
      if (why) return why;
    }
    if (host && t.name.startsWith('browser.')) {
      const why = this.browserDomain(host);
      if (why) return why;
    }
    const network =
      opts.remote === true ||
      t.annotations?.requiresNetwork === true ||
      t.effects?.includes('network') === true;
    // A host outside the policy's egress allow lists is refused, not asked about.
    if (
      host &&
      network &&
      !this.egressCeilings().every((c) => c.some((p) => hostMatch(p, host.toLowerCase())))
    )
      return `${host} is not among the hosts agents may reach ${BY_POLICY}`;
    if (
      this.egressOff() &&
      (opts.remote === true ||
        t.annotations?.requiresNetwork === true ||
        t.effects?.includes('network'))
    )
      return `network access is turned off ${BY_POLICY}`;
    return null;
  }

  plugin(id: string): string | null {
    return this.#idCheck('plugins', id, 'The plugin');
  }

  extension(id: string): string | null {
    return this.#idCheck('extensions', id, 'The extension');
  }

  #idCheck(part: 'plugins' | 'extensions', id: string, label: string): string | null {
    for (const l of this.layers) {
      const p = l[part];
      if (anyGlob(p?.deny, id) || (p?.allow && !anyGlob(p.allow, id)))
        return `${label} ${id} is not allowed ${BY_POLICY}`;
    }
    return null;
  }

  /**
   * Why an MCP server may not be added, changed, started or used. Servers the user brought (added
   * in Settings, imported from another app, installed from a bundle) count as added by the user;
   * a server over http or sse reaches the network, so egress `off` refuses it.
   */
  mcpServer(s: ManagedMcpServer): string | null {
    const why = this.#serverName(s.name);
    if (why) return why;
    if (this.egressOff() && s.transport !== 'stdio')
      return `MCP servers over the network are turned off ${BY_POLICY} (network access is off)`;
    for (const l of this.layers) {
      const p = l.mcpServers;
      if (!p) continue;
      if (p.userAdded === false && USER_ADDED.has(s.source))
        return `MCP servers you add yourself are turned off ${BY_POLICY}`;
      if (p.localStdio === false && s.transport === 'stdio' && !s.deviceId)
        return `MCP servers that run on the Hub (stdio) are turned off ${BY_POLICY}`;
    }
    return null;
  }

  #serverName(name: string): string | null {
    for (const l of this.layers) {
      const p = l.mcpServers;
      if (anyGlob(p?.deny, name) || (p?.allow && !anyGlob(p.allow, name)))
        return `The MCP server ${name} is not allowed ${BY_POLICY}`;
    }
    return null;
  }

  // ---- sessions and folders --------------------------------------------------------------------

  /** Why Code sessions on the Hub's own files are refused. */
  localSessions(): string | null {
    return this.layers.some((l) => l.sessions?.local === false)
      ? `Code sessions on this machine are turned off ${BY_POLICY}`
      : null;
  }

  /** Why an SSH session to `host` is refused. */
  sshHost(host: string): string | null {
    for (const l of this.layers) {
      const s = l.sessions;
      if (!s) continue;
      if (s.ssh === false) return `SSH sessions are turned off ${BY_POLICY}`;
      if (s.sshHosts && !anyHost(s.sshHosts, host.toLowerCase()))
        return `SSH sessions to ${host} are not allowed ${BY_POLICY}`;
    }
    return null;
  }

  #expand(p: string): string {
    if (p === '~') return this.#home;
    if (p.startsWith('~/')) return join(this.#home, p.slice(2));
    return p;
  }

  /** Why a folder may not be used (a session folder, a project folder, a tool root). */
  folder(path: string): string | null {
    for (const l of this.layers) {
      const f = l.folders;
      if (!f) continue;
      if (f.deny?.some((p) => isWithinPath(this.#expand(p), path)))
        return `The folder ${path} is not allowed ${BY_POLICY}`;
      if (f.allow && !f.allow.some((p) => isWithinPath(this.#expand(p), path)))
        return `The folder ${path} is outside the folders allowed ${BY_POLICY}`;
    }
    return null;
  }

  /** Folder rules exist (tool roots are then filtered by them). */
  get restrictsFolders(): boolean {
    return this.layers.some((l) => l.folders?.allow !== undefined || l.folders?.deny !== undefined);
  }

  /**
   * Roots narrowed to the folders the policy allows (FR-106), whatever gave them: a permission
   * profile's own entries (`/` of `full`, `~`), the tool roots setting, a project's or a session's
   * folder. A root inside an allowed folder stays; a root around allowed folders becomes those
   * folders; any other root goes. Every layer narrows in turn, and the denied folders come back as
   * deny entries (a root inside one goes too). `exempt` roots (Nova's own workspace) stay as they
   * are; `canonical` maps the policy's paths the way the roots were mapped (realpath).
   */
  narrowRoots(
    roots: readonly { path: string; access: 'read' | 'write'; label?: string }[],
    opts: { exempt?: readonly string[]; canonical?: (path: string) => string } = {},
  ): { roots: { path: string; access: 'read' | 'write'; label: string }[]; deny: string[] } {
    const canon = opts.canonical ?? ((p: string) => p);
    const exempt = new Set(opts.exempt ?? []);
    let out = roots.map((r) => ({ path: r.path, access: r.access, label: r.label ?? r.path }));
    for (const l of this.layers) {
      const allow = l.folders?.allow?.map((p) => canon(this.#expand(p)));
      if (!allow) continue;
      const next: typeof out = [];
      for (const r of out) {
        if (exempt.has(r.path) || allow.some((a) => isWithinPath(a, r.path))) {
          next.push(r);
          continue;
        }
        for (const a of allow)
          if (isWithinPath(r.path, a))
            next.push({ path: a, access: r.access, label: basename(a) || a });
      }
      const seen = new Map<string, (typeof out)[number]>();
      for (const r of next) {
        const prev = seen.get(r.path);
        if (!prev || (prev.access === 'read' && r.access === 'write')) seen.set(r.path, r);
      }
      out = [...seen.values()];
    }
    const deny = [
      ...new Set(
        this.layers.flatMap((l) => l.folders?.deny ?? []).map((p) => canon(this.#expand(p))),
      ),
    ];
    out = out.filter((r) => exempt.has(r.path) || !deny.some((d) => isWithinPath(d, r.path)));
    return { roots: out, deny };
  }

  // ---- browser, egress, telemetry, routing, installs, apps -------------------------------------

  /** Why the agent browser may not open `host`. */
  browserDomain(host: string): string | null {
    const h = host.toLowerCase().replace(/\.$/, '');
    for (const l of this.layers) {
      const b = l.browserDomains;
      if (anyHost(b?.deny, h) || (b?.allow && !anyHost(b.allow, h)))
        return `${h} is not a site the browser may open ${BY_POLICY}`;
    }
    return null;
  }

  /** Browser domain patterns every layer refuses, for lists that only take deny patterns. */
  browserDeny(): string[] {
    return [...new Set(this.layers.flatMap((l) => l.browserDomains?.deny ?? []))];
  }

  /** Whether every host a browser allow pattern names passes every layer's allow list. */
  browserAllows(pattern: string): boolean {
    return this.layers.every(
      (l) => !l.browserDomains?.allow || patternCovered(l.browserDomains.allow, pattern),
    );
  }

  /** Egress is off (no network for agents, sandboxes or the browser). */
  egressOff(): boolean {
    return this.layers.some((l) => l.egress?.mode === 'off');
  }

  /** Each source's egress allow list: the ceiling a host must stay within (every one of them). */
  egressCeilings(): string[][] {
    return this.layers.flatMap((l) => (l.egress?.allow ? [l.egress.allow] : []));
  }

  /** Whether every host an allow pattern names stays within every ceiling. */
  egressCovered(pattern: string): boolean {
    return this.egressCeilings().every((c) => patternCovered(c, pattern));
  }

  /**
   * The hosts agents may reach without asking, given the owner's own list (`network.egressAllow`):
   * the list the policy worked out, else `effectiveEgressAllow` over the ceilings.
   */
  egressAllow(own: readonly string[]): string[] {
    if (this.#egressAllow) return [...this.#egressAllow];
    return effectiveEgressAllow(this.egressCeilings(), own);
  }

  /** Why telemetry export (OTLP, FR-223) is refused. */
  telemetryExport(): string | null {
    return this.layers.some((l) => l.telemetryExport === false)
      ? `Telemetry export is turned off ${BY_POLICY}`
      : null;
  }

  /** The provider kinds models may come from (every layer's list intersected), or null: any. */
  providers(): string[] | null {
    let out: string[] | null = null;
    for (const l of this.layers) {
      const p = l.routing?.providers;
      if (!p) continue;
      out = out ? out.filter((k) => p.includes(k as never)) : [...p];
    }
    return out;
  }

  /** Why a provider kind (`node` for a compute node) may not serve models. */
  provider(kind: string): string | null {
    const allowed = this.providers();
    return allowed && !allowed.includes(kind)
      ? `Models from ${kind} providers are not allowed ${BY_POLICY}`
      : null;
  }

  /** Why an install that is not signed by a trusted publisher is refused. */
  unverifiedInstall(what = 'an unverified plugin'): string | null {
    return this.layers.some((l) => l.unverifiedInstalls === false)
      ? `Installing ${what} is not allowed ${BY_POLICY}: only signed ones from trusted publishers install`
      : null;
  }

  /** Why authorizing a third-party app or MCP client is refused. */
  apps(): string | null {
    return this.layers.some((l) => l.apps === false)
      ? `Authorizing apps is turned off ${BY_POLICY}`
      : null;
  }
}

/**
 * The checks for a `managed.restrict` value as a setting reader returns it. A value that does not
 * parse (it never should: the managed layer validates it) fails closed.
 */
export function managedRestrictions(
  value: unknown,
  opts: ManagedRestrictionsOptions = {},
): ManagedRestrictions {
  const parsed = managedRestrictSettingSchema.safeParse(value ?? { layers: [], failClosed: null });
  return new ManagedRestrictions(
    parsed.success
      ? parsed.data
      : { layers: [], failClosed: 'the managed restrictions are unreadable' },
    opts,
  );
}

/**
 * The policy's egress allow lists are a ceiling (ADR-097): with no list of the owner's own (unset
 * or empty: the owner never narrowed anything) the hosts every ceiling covers apply; with one, the
 * owner's hosts that every ceiling covers, so the owner chooses within it. No ceiling: the
 * owner's list as it is.
 */
export function effectiveEgressAllow(
  ceilings: readonly (readonly string[])[],
  own: readonly string[],
): string[] {
  const first = ceilings[0];
  if (!first) return [...own];
  // With two sources, the first one's hosts that the others cover too (both narrow).
  const base = own.length ? own : first;
  return [...new Set(base.filter((p) => ceilings.every((c) => patternCovered(c, p))))];
}

/** No policy: nothing restricted. */
export const NO_RESTRICTIONS = new ManagedRestrictions({ layers: [], failClosed: null });
