// Command registry (docs/14 §3, FR-003). Commands are data: id, title, category, optional
// binding and a run function. The palette and keybindings both read from this registry.

export interface Command {
  id: string;
  title: string;
  category: string;
  /** Default binding, e.g. "mod+k". `mod` is Ctrl on Linux/Windows and Cmd on macOS. */
  binding?: string;
  run: () => void;
}

export class CommandRegistry {
  readonly #commands = new Map<string, Command>();
  readonly #listeners = new Set<() => void>();
  /** Cached sorted snapshot; stable between changes (required by useSyncExternalStore). */
  #snapshot: Command[] | null = null;

  register(cmd: Command): () => void {
    if (this.#commands.has(cmd.id)) throw new Error(`command already registered: ${cmd.id}`);
    this.#commands.set(cmd.id, cmd);
    this.#emit();
    return () => {
      this.#commands.delete(cmd.id);
      this.#emit();
    };
  }

  list(): Command[] {
    this.#snapshot ??= [...this.#commands.values()].sort(
      (a, b) => a.category.localeCompare(b.category) || a.title.localeCompare(b.title),
    );
    return this.#snapshot;
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

  #emit(): void {
    this.#snapshot = null;
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

export function isMac(
  platform = typeof navigator === 'undefined' ? '' : navigator.platform,
): boolean {
  return /mac|iphone|ipad/i.test(platform);
}

/** True when a keyboard event matches a binding like "mod+k" or "mod+shift+p". */
export function matchesBinding(
  e: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'shiftKey' | 'altKey'>,
  binding: string,
  mac = isMac(),
): boolean {
  const parts = binding.toLowerCase().split('+');
  const key = parts.at(-1);
  const want = new Set(parts.slice(0, -1));
  const mod = mac ? e.metaKey : e.ctrlKey;
  if (want.has('mod') !== mod) return false;
  if (want.has('shift') !== e.shiftKey) return false;
  if (want.has('alt') !== e.altKey) return false;
  if (!want.has('mod') && (e.ctrlKey || e.metaKey)) return false;
  return e.key.toLowerCase() === key;
}
