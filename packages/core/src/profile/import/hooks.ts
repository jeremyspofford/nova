// Hooks from other plugin layouts (FR-200; docs/08 §4.2: "Hooks → hook entries in needs_trust
// state"). The common open layout is a hooks file (`hooks/hooks.json`, or the manifest's `hooks`)
// holding an event map: `{hooks: {<Event>: [{matcher, hooks: [{type: 'command', command,
// timeout}]}]}}`. Each command hook becomes a Nova hook (contracts/schemas/hook-config.json) in the
// generated manifest, so it installs untrusted and runs only after the owner trusts its hash.
// Nova hooks run a fixed argv without a shell: a command that needs one, an event Nova does not
// have, a matcher it cannot translate or a non-command hook is left out, with a note saying why.
import type { PluginHookConfig } from '../../plugins/types.ts';

/** Event names of the open layout and the Nova events they become. */
const EVENTS: Readonly<Record<string, PluginHookConfig['event']>> = {
  PreToolUse: 'tool.pre',
  PostToolUse: 'tool.post',
  UserPromptSubmit: 'prompt.submit',
  SessionStart: 'session.start',
  SessionEnd: 'session.end',
  Stop: 'stop',
  SubagentStart: 'subagent.start',
  SubagentStop: 'subagent.stop',
  PreCompact: 'compact.pre',
  PostCompact: 'compact.post',
  PermissionRequest: 'permission.request',
};

/** Tool names of the open layout and Nova's built-in tools (docs/08 §1.1). */
const TOOLS: Readonly<Record<string, string[]>> = {
  Bash: ['exec.run'],
  Read: ['fs.read'],
  Write: ['fs.write'],
  Edit: ['fs.edit'],
  MultiEdit: ['fs.edit'],
  Glob: ['fs.list'],
  Grep: ['fs.search'],
  LS: ['fs.list'],
  WebFetch: ['web.fetch'],
  WebSearch: ['web.search'],
  Task: ['task.spawn'],
};

/** Matcher subjects of non-tool events (docs/08 §4.1 "Events and effects"). */
const SUBJECTS: Readonly<Record<string, Record<string, string[]>>> = {
  'session.start': { startup: ['new'], resume: ['resume'], compact: ['compacted'] },
  'compact.pre': { manual: ['manual'], auto: ['pre_turn', 'mid_turn', 'post_turn'] },
  'compact.post': { manual: ['manual'], auto: ['pre_turn', 'mid_turn', 'post_turn'] },
};

const ANY = new Set(['', '*', '.*']);
const ROOT_VAR = /\$\{[A-Z][A-Z0-9_]*PLUGIN_ROOT\}|\$[A-Z][A-Z0-9_]*PLUGIN_ROOT\b/g;
const SHELL = /[|&;<>()`$*?[\]{}!~#\n]/;
const MAX_HOOKS = 50;

export interface ConvertedHooks {
  hooks: PluginHookConfig[];
  notes: string[];
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Tool names a matcher of the open layout names, as Nova globs; null when it cannot say. */
function toolGlobs(matcher: string): string[] | null {
  const out: string[] = [];
  for (const raw of matcher.split('|')) {
    const t = raw.trim().replace(/^\^|\$$/g, '');
    if (ANY.has(t)) return [];
    const mcp = /^mcp__([A-Za-z0-9-]+)__(\.\*|[A-Za-z0-9_.-]+)$/.exec(t);
    if (mcp) {
      out.push(`mcp:${mcp[1]!.toLowerCase()}.${mcp[2] === '.*' ? '*' : mcp[2]!}`);
      continue;
    }
    const mcpServer = /^mcp__([A-Za-z0-9-]+)(__)?\.\*$/.exec(t);
    if (mcpServer) {
      out.push(`mcp:${mcpServer[1]!.toLowerCase()}.*`);
      continue;
    }
    const known = TOOLS[t];
    if (!known) return null;
    for (const n of known) if (!out.includes(n)) out.push(n);
  }
  return out;
}

/** A matcher for a non-tool event; null when it cannot be translated. */
function subjectGlobs(event: string, matcher: string): string[] | null {
  const map = SUBJECTS[event];
  const out: string[] = [];
  for (const raw of matcher.split('|')) {
    const t = raw.trim();
    if (ANY.has(t)) return [];
    const subj = map?.[t];
    if (!subj) return null;
    for (const s of subj) if (!out.includes(s)) out.push(s);
  }
  return out;
}

/**
 * A shell-free argv for a command line: plugin-root variables become `${pluginRoot}`, simple
 * quoting is honoured, and anything that needs a shell gives null.
 */
export function commandArgv(command: string): string[] | null {
  const text = command.trim().replace(ROOT_VAR, '\u0000');
  const argv: string[] = [];
  let cur = '';
  let quote: '"' | "'" | null = null;
  let started = false;
  for (const ch of text) {
    if (quote) {
      if (ch === quote) quote = null;
      else if (quote === '"' && (ch === '$' || ch === '`' || ch === '\\')) return null;
      else cur += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      started = true;
    } else if (ch === ' ' || ch === '\t') {
      if (started) argv.push(cur);
      cur = '';
      started = false;
    } else if (ch === '\\' || SHELL.test(ch)) return null;
    else {
      cur += ch;
      started = true;
    }
  }
  if (quote) return null;
  if (started) argv.push(cur);
  // An environment assignment before the command needs a shell too.
  if (!argv.length || /^[A-Za-z_][A-Za-z0-9_]*=/.test(argv[0]!)) return null;
  return argv.map((a) => a.split('\u0000').join('${pluginRoot}'));
}

/** Convert an event-map hooks file of another plugin layout into Nova hooks. */
export function convertForeignHooks(data: unknown): ConvertedHooks {
  const notes: string[] = [];
  const map = isRecord(data) && isRecord(data.hooks) ? data.hooks : isRecord(data) ? data : null;
  const events = map ? Object.entries(map).filter(([k]) => /^[A-Z]/.test(k)) : [];
  if (!events.length)
    return {
      hooks: [],
      notes: ['its hooks use another format Nova cannot read; none were imported'],
    };
  const hooks: PluginHookConfig[] = [];
  const left: string[] = [];
  const counts = new Map<string, number>();
  for (const [name, groups] of events) {
    const event = EVENTS[name];
    if (!event) {
      left.push(`${name} (Nova has no such event)`);
      continue;
    }
    for (const group of Array.isArray(groups) ? groups : []) {
      if (!isRecord(group)) continue;
      const matcher = typeof group.matcher === 'string' ? group.matcher : '';
      const tool = event === 'tool.pre' || event === 'tool.post' || event === 'permission.request';
      const globs = tool ? toolGlobs(matcher) : subjectGlobs(event, matcher);
      if (globs === null) {
        left.push(`${name} for "${matcher.slice(0, 60)}" (no Nova equivalent of the matcher)`);
        continue;
      }
      for (const h of Array.isArray(group.hooks) ? group.hooks : []) {
        if (!isRecord(h)) continue;
        if (h.type !== 'command' || typeof h.command !== 'string') {
          left.push(
            `a ${typeof h.type === 'string' ? h.type : 'non-command'} hook at ${name} (only command hooks are imported)`,
          );
          continue;
        }
        const argv = commandArgv(h.command);
        if (!argv) {
          left.push(
            `"${h.command.slice(0, 60)}" at ${name} (it needs a shell; Nova hooks run a fixed argv)`,
          );
          continue;
        }
        if (hooks.length >= MAX_HOOKS) {
          left.push(`hooks past the first ${MAX_HOOKS}`);
          break;
        }
        const n = (counts.get(event) ?? 0) + 1;
        counts.set(event, n);
        const seconds =
          typeof h.timeout === 'number' && Number.isFinite(h.timeout) ? h.timeout : 30;
        hooks.push({
          id: `${event.replace(/\./g, '-')}-${n}`,
          event,
          ...(globs.length ? { matcher: globs.length === 1 ? globs[0]! : globs } : {}),
          handler: {
            type: 'command',
            command: argv,
            timeoutMs: Math.min(600_000, Math.max(1000, Math.round(seconds * 1000))),
          },
        });
      }
    }
  }
  if (hooks.length)
    notes.push(
      `${hooks.length} hook${hooks.length === 1 ? '' : 's'} converted; they wait for your trust before they run`,
    );
  if (left.length) notes.push(`hooks left out: ${[...new Set(left)].slice(0, 8).join('; ')}`);
  return { hooks, notes };
}
