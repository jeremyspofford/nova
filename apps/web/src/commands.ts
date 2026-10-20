// Command and shortcut registry (FR-003, FR-004, docs/14 §3). Commands are data: id, title,
// category, default bindings, an optional when-clause and a run function. The palette, the global
// key handler and Settings → Keyboard all read from this one registry. User remappings come from
// the `keyboard.bindings` setting: command id → binding, where "" unbinds. Titles and categories
// are read from messages when a command registers; the shell re-registers its commands when the
// language changes (it remounts), and lists sort in the active locale.
import { defineMessages, getLocale } from '@nova/i18n';
import {
  browserAlternate,
  detectPlatform,
  eventToBinding,
  evaluateWhen,
  isBrowserReserved,
  normalizeBinding,
  type KeyLike,
  type Platform,
  type WhenContext,
} from './keys.ts';

/** The shared command categories; areas pick from these rather than naming their own. */
export const CATEGORY = defineMessages('commands.category', {
  apps: 'Apps',
  chat: 'Chat',
  files: 'Files',
  general: 'General',
  layout: 'Layout',
  modes: 'Modes',
  navigation: 'Navigation',
  projects: 'Projects',
  settings: 'Settings',
  terminal: 'Terminal',
  view: 'View',
  work: 'Work',
});

export interface Command {
  id: string;
  title: string;
  category: string;
  /** Default binding(s), e.g. "mod+k". `mod` is Ctrl on Linux/Windows and Cmd on macOS. */
  binding?: string | readonly string[];
  /** When-clause scoping the binding, e.g. "streaming && !dialogOpen". */
  when?: string;
  run: () => void;
}

export interface Conflict {
  binding: string;
  ids: string[];
}

export class CommandRegistry {
  readonly platform: Platform;
  readonly #commands = new Map<string, Command>();
  readonly #listeners = new Set<() => void>();
  #user: Record<string, string> = {};
  /** Cached sorted snapshot; stable between changes (required by useSyncExternalStore). */
  #snapshot: Command[] | null = null;
  #version = 0;

  constructor(platform: Platform = detectPlatform()) {
    this.platform = platform;
  }

  register(cmd: Command): () => void {
    if (this.#commands.has(cmd.id)) throw new Error(`command already registered: ${cmd.id}`);
    this.#commands.set(cmd.id, cmd);
    this.#emit();
    return () => {
      if (this.#commands.get(cmd.id) !== cmd) return;
      this.#commands.delete(cmd.id);
      this.#emit();
    };
  }

  get(id: string): Command | undefined {
    return this.#commands.get(id);
  }

  list(): Command[] {
    const locale = getLocale();
    this.#snapshot ??= [...this.#commands.values()].sort(
      (a, b) =>
        a.category.localeCompare(b.category, locale) || a.title.localeCompare(b.title, locale),
    );
    return this.#snapshot;
  }

  /** Changes whenever commands or bindings change (for memoization). */
  version(): number {
    return this.#version;
  }

  run(id: string): boolean {
    const c = this.#commands.get(id);
    if (!c) return false;
    c.run();
    return true;
  }

  subscribe(fn: () => void): () => void {
    this.#listeners.add(fn);
    return () => this.#listeners.delete(fn);
  }

  // ---- bindings ------------------------------------------------------------------------------

  setUserBindings(map: Record<string, string>): void {
    const same =
      Object.keys(map).length === Object.keys(this.#user).length &&
      Object.entries(map).every(([k, v]) => this.#user[k] === v);
    if (same) return;
    this.#user = { ...map };
    this.#emit();
  }

  userBindings(): Record<string, string> {
    return { ...this.#user };
  }

  /** Default bindings as written by the command, normalized for this platform. */
  defaultBindings(id: string): string[] {
    const c = this.#commands.get(id);
    if (!c?.binding) return [];
    const list = typeof c.binding === 'string' ? [c.binding] : c.binding;
    return list
      .map((b) => normalizeBinding(b, this.platform.mac))
      .filter((b): b is string => b !== null);
  }

  isCustomized(id: string): boolean {
    return Object.hasOwn(this.#user, id);
  }

  /**
   * Effective bindings, the displayed one first. A user binding replaces the defaults ("" means
   * unbound). In a browser tab a reserved default is shown as its Alt variant and both are
   * matched, because some browsers do pass the original through.
   */
  bindingsFor(id: string): string[] {
    if (this.isCustomized(id)) {
      const b = normalizeBinding(this.#user[id] ?? '', this.platform.mac);
      return b ? [b] : [];
    }
    const out: string[] = [];
    for (const b of this.defaultBindings(id)) {
      if (this.platform.browserTab && isBrowserReserved(b))
        out.push(browserAlternate(b, this.platform.mac));
      out.push(b);
    }
    return [...new Set(out)];
  }

  primaryBinding(id: string): string | undefined {
    return this.bindingsFor(id)[0];
  }

  /** Commands bound to `binding` (normalized), optionally only those active in `ctx`. */
  commandsFor(binding: string, ctx?: WhenContext): Command[] {
    const want = normalizeBinding(binding, this.platform.mac);
    if (!want) return [];
    return this.list().filter(
      (c) =>
        this.bindingsFor(c.id).includes(want) && (ctx === undefined || evaluateWhen(c.when, ctx)),
    );
  }

  /** The command a key press runs in `ctx`: scoped (when-clause) commands win over global ones. */
  match(e: KeyLike, ctx: WhenContext): Command | undefined {
    const combo = eventToBinding(e, this.platform.mac);
    if (!combo) return undefined;
    const hits = this.commandsFor(combo, ctx);
    return hits.find((c) => c.when) ?? hits[0];
  }

  /**
   * Bindings shared by commands whose scopes can overlap. Two commands conflict when they share a
   * binding and either has no when-clause or both have the same one.
   */
  conflicts(): Conflict[] {
    const byBinding = new Map<string, Command[]>();
    for (const c of this.list()) {
      for (const b of this.bindingsFor(c.id)) {
        const list = byBinding.get(b) ?? [];
        list.push(c);
        byBinding.set(b, list);
      }
    }
    const out: Conflict[] = [];
    for (const [binding, cmds] of byBinding) {
      const ids = new Set<string>();
      for (let i = 0; i < cmds.length; i++) {
        for (let j = i + 1; j < cmds.length; j++) {
          const a = cmds[i]!;
          const b = cmds[j]!;
          if (!a.when || !b.when || a.when === b.when) {
            ids.add(a.id);
            ids.add(b.id);
          }
        }
      }
      if (ids.size > 1) out.push({ binding, ids: [...ids] });
    }
    return out;
  }

  /** Other commands that `binding` would clash with if assigned to `id`. */
  conflictsWith(id: string, binding: string): Command[] {
    const self = this.#commands.get(id);
    return this.commandsFor(binding).filter(
      (c) => c.id !== id && (!c.when || !self?.when || c.when === self.when),
    );
  }

  #emit(): void {
    this.#snapshot = null;
    this.#version++;
    for (const fn of this.#listeners) fn();
  }
}

/**
 * Fuzzy match: every query character appears in order. Score rewards contiguous runs and word
 * starts. Returns null when there is no match.
 */
export function fuzzyScore(query: string, text: string): number | null {
  const q = query.toLowerCase().trim();
  if (!q) return 0;
  const t = text.toLowerCase();
  let score = 0;
  let ti = 0;
  let prev = -2;
  for (const ch of q) {
    if (ch === ' ') continue;
    const at = t.indexOf(ch, ti);
    if (at < 0) return null;
    score += at === prev + 1 ? 3 : 1;
    if (at === 0 || t[at - 1] === ' ' || t[at - 1] === '.') score += 2;
    prev = at;
    ti = at + 1;
  }
  return score;
}

export function filterCommands(commands: Command[], query: string): Command[] {
  return commands
    .map((c) => ({ c, s: fuzzyScore(query, `${c.category} ${c.title}`) }))
    .filter((x): x is { c: Command; s: number } => x.s !== null)
    .sort((a, b) => b.s - a.s)
    .map((x) => x.c);
}
