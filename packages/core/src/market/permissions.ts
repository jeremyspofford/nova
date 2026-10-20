// Permissions in plain words and the diff an update shows (FR-049; docs/14 §5, docs/08 §3.2,
// §7). A plugin's lines come from its manifest's `permissions` and the components that give it
// reach (MCP servers and the programs they run, hooks with their events and commands, sub-agent
// roles, browser extensions, UI entry points); a skill's from its `allowed_tools`; an MCP
// server's from where it connects or what it runs. Every line has a stable key, so two versions
// compare line by line: added, removed, and changed (same key, other detail: a tool's default
// that went from ask to allow, a hook that runs another command).
import type { MarketPermissionDiff, MarketPermissionLine } from '@nova/shared';
import { sha256Hex } from './signing.ts';

type Line = MarketPermissionLine;

function line(kind: Line['kind'], value: string, text: string, detail: string | null = null): Line {
  return { key: `${kind}:${value}`, kind, text, detail };
}

/** How an MCP server's tools are approved by default (its manifest `defaultApproval`). */
const SERVER_WORDS: Record<string, string> = {
  allow: 'run without asking',
  ask: 'ask you first',
  deny: 'are refused',
};

const ACTION_WORDS: Record<string, string> = {
  allow: 'runs without asking',
  ask: 'asks you first',
  deny: 'is refused',
};

/** The parts of a plugin manifest (or a catalog's declared copy) that permission lines read. */
export interface PluginPermissionInput {
  permissions?: {
    network?: string[];
    fs?: string[];
    secrets?: string[];
    tools?: Record<string, { action?: string; default?: string }>;
    actionDefaults?: Record<string, string | undefined>;
    hooks?: { answersAsks?: boolean };
    browserExtensions?: string[];
    ui?: { connectDomains?: string[]; resourceDomains?: string[]; frameDomains?: string[] };
  };
  mcpServers?: Record<
    string,
    {
      transport?: string;
      command?: string;
      url?: string;
      args?: string[];
      defaultApproval?: string;
      policy?: unknown;
      enabledTools?: string[];
      disabledTools?: string[];
    }
  >;
  hooks?: { id: string; event: string; command?: string | null }[];
  roles?: string[];
  browserExtensions?: string[];
  uiEntryPoints?: { kind: string; resource?: string; title?: string | null }[];
}

export function pluginPermissionLines(p: PluginPermissionInput): Line[] {
  const out: Line[] = [];
  const perms = p.permissions ?? {};
  for (const h of perms.network ?? []) out.push(line('network', h, `Reach ${h} on the network`));
  for (const f of perms.fs ?? []) out.push(line('fs', f, `Use files in ${f}`));
  for (const s of perms.secrets ?? []) out.push(line('secret', s, `Read the secret ${s}`));
  for (const [tool, t] of Object.entries(perms.tools ?? {}).sort(([a], [b]) => (a < b ? -1 : 1)))
    out.push(
      line(
        'tool',
        tool,
        `Offer the tool ${tool} (${t.action ?? 'unknown'})`,
        t.default ? `${t.action ?? 'unknown'}, ${t.default}` : (t.action ?? null),
      ),
    );
  for (const [cls, d] of Object.entries(perms.actionDefaults ?? {}).sort(([a], [b]) =>
    a < b ? -1 : 1,
  ))
    if (d)
      out.push(
        line('action_default', cls, `A ${cls} action ${ACTION_WORDS[d] ?? d} by default`, d),
      );
  if (perms.hooks?.answersAsks === true)
    out.push(line('hooks_answer_asks', 'yes', 'Let its hooks answer approval questions for you'));
  for (const b of new Set([...(perms.browserExtensions ?? []), ...(p.browserExtensions ?? [])]))
    out.push(
      line(
        'browser_extension',
        b,
        `Offer the browser extension ${b} (installed only if you agree)`,
      ),
    );
  const ui = perms.ui ?? {};
  for (const d of new Set([
    ...(ui.connectDomains ?? []),
    ...(ui.resourceDomains ?? []),
    ...(ui.frameDomains ?? []),
  ]))
    out.push(line('ui_domain', d, `Let its panels load from ${d}`));
  for (const [key, s] of Object.entries(p.mcpServers ?? {}).sort(([a], [b]) => (a < b ? -1 : 1))) {
    const what =
      s.transport === 'stdio' || s.command
        ? `runs ${[s.command ?? 'a program', ...(s.args ?? [])].join(' ')}`
        : `connects to ${hostOf(s.url) ?? 'a server'}`;
    const approval = s.defaultApproval
      ? `; its tools ${SERVER_WORDS[s.defaultApproval] ?? s.defaultApproval}`
      : '';
    // Everything the gate and the launcher act on is in the detail, so changing what runs or
    // how its tools are approved (ask to allow) shows as a change that must be accepted. Env
    // and header values are left out: the installed copy holds vault references for them.
    out.push(
      line(
        'mcp_server',
        key,
        `Add the MCP server ${key}, which ${what}${approval}`,
        JSON.stringify({
          transport: s.transport ?? null,
          command: s.command ?? null,
          url: s.url ?? null,
          args: s.args ?? [],
          defaultApproval: s.defaultApproval ?? null,
          policy: s.policy ?? null,
          enabledTools: s.enabledTools ?? null,
          disabledTools: s.disabledTools ?? [],
        }),
      ),
    );
  }
  for (const h of p.hooks ?? [])
    out.push(
      line(
        'hook',
        h.id,
        `Run the hook ${h.id} on ${h.event}${h.command ? ` (${h.command})` : ''}`,
        `${h.event} ${h.command ?? ''}`.trim(),
      ),
    );
  for (const r of p.roles ?? []) out.push(line('role', r, `Add the sub-agent role ${r}`));
  for (const e of p.uiEntryPoints ?? [])
    out.push(
      line(
        'ui_entry',
        `${e.kind}:${e.resource ?? e.title ?? ''}`,
        `Add a ${e.kind} panel${e.title ? ` "${e.title}"` : ''}`,
      ),
    );
  return dedupe(out);
}

/** A skill can ask for tools it may use (`allowed_tools`). */
export function skillPermissionLines(allowedTools: readonly string[]): Line[] {
  return allowedTools.map((t) => line('skill_tools', t, `Ask to use the tool ${t}`));
}

/** An MCP registry entry connects somewhere; a bundle runs a program on the Hub. */
export function mcpPermissionLines(
  input: { transport: 'http' | 'sse'; url: string } | { program: string; tools?: string[] },
): Line[] {
  if ('url' in input)
    return [
      line(
        'network',
        hostOf(input.url) ?? input.url,
        `Connect to ${hostOf(input.url) ?? input.url}`,
      ),
    ];
  return [
    line(
      'program',
      input.program,
      `Run a ${input.program} program on the Hub (its tools ask first)`,
    ),
    ...(input.tools ?? []).map((t) => line('tool', t, `Offer the tool ${t}`)),
  ];
}

function hostOf(url: string | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
}

function dedupe(lines: Line[]): Line[] {
  const seen = new Set<string>();
  return lines.filter((l) => (seen.has(l.key) ? false : (seen.add(l.key), true)));
}

/**
 * What changes from `before` to `after`. The hash covers the versions and every line of the
 * diff, so accepting one diff never accepts another.
 */
export function permissionDiff(
  before: { version: string; lines: readonly Line[] },
  after: { version: string; lines: readonly Line[] },
): MarketPermissionDiff {
  const old = new Map(before.lines.map((l) => [l.key, l]));
  const next = new Map(after.lines.map((l) => [l.key, l]));
  const added = after.lines.filter((l) => !old.has(l.key));
  const removed = before.lines.filter((l) => !next.has(l.key));
  const changed = after.lines
    .filter((l) => old.has(l.key) && old.get(l.key)!.detail !== l.detail)
    .map((l) => ({ key: l.key, text: l.text, before: old.get(l.key)!.detail, after: l.detail }));
  const canonical = JSON.stringify({
    from: before.version,
    to: after.version,
    added: added.map((l) => [l.key, l.detail]),
    removed: removed.map((l) => l.key),
    changed: changed.map((c) => [c.key, c.before, c.after]),
  });
  return {
    fromVersion: before.version,
    toVersion: after.version,
    added,
    removed,
    changed,
    hash: `sha256:${sha256Hex(canonical)}`,
  };
}

/** An update needs the owner's acceptance when it adds or changes something (removals do not). */
export function diffNeedsAcceptance(d: MarketPermissionDiff | null): boolean {
  return !!d && (d.added.length > 0 || d.changed.length > 0);
}
