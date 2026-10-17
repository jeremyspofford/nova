// The repo symbol index of a Code session (FR-074): a small, dependency-free extractor of
// definitions (functions, classes, methods, types) for TypeScript/JavaScript, Python, Go, Rust,
// Java and C/C++, line by line with patterns, plus references by identifier search. The file
// list comes from Git (tracked and untracked files, `.gitignore` honoured, protected paths left
// out); files over a size cap are skipped and re-extraction is incremental by mtime and size.
// Tree-sitter parsing is out of scope for M5: patterns miss some definitions (multi-line
// signatures, macros) but never run code from the repository.
import { readFile, stat } from 'node:fs/promises';
import { extname, join } from 'node:path';
import type { CodeSymbolView } from '@nova/shared';

export const SYMBOL_LIMITS = {
  maxFileBytes: 512 * 1024,
  maxFiles: 20_000,
  maxResults: 200,
};

type Lang = 'ts' | 'py' | 'go' | 'rs' | 'java' | 'c';

const LANGS: Record<string, Lang> = {
  '.ts': 'ts',
  '.tsx': 'ts',
  '.mts': 'ts',
  '.cts': 'ts',
  '.js': 'ts',
  '.jsx': 'ts',
  '.mjs': 'ts',
  '.cjs': 'ts',
  '.py': 'py',
  '.pyi': 'py',
  '.go': 'go',
  '.rs': 'rs',
  '.java': 'java',
  '.c': 'c',
  '.h': 'c',
  '.cc': 'c',
  '.cpp': 'c',
  '.cxx': 'c',
  '.hpp': 'c',
  '.hh': 'c',
  '.hxx': 'c',
};

export function codeLanguageOf(path: string): Lang | null {
  return LANGS[extname(path).toLowerCase()] ?? null;
}

const KEYWORDS = new Set([
  'if',
  'for',
  'while',
  'switch',
  'catch',
  'return',
  'function',
  'new',
  'else',
  'do',
  'try',
  'throw',
  'typeof',
  'sizeof',
  'await',
  'yield',
  'super',
  'this',
  'case',
  'delete',
  'void',
]);

interface Scope {
  name: string;
  indent: number;
}

function indentOf(line: string): number {
  const m = /^[ \t]*/.exec(line);
  return m ? m[0].replace(/\t/g, '    ').length : 0;
}

/** Definitions in one file's text. */
export function extractSymbols(path: string, text: string): CodeSymbolView[] {
  const lang = codeLanguageOf(path);
  if (!lang) return [];
  const out: CodeSymbolView[] = [];
  const lines = text.split(/\r?\n/);
  const scopes: Scope[] = [];
  const add = (name: string, kind: string, idx: number, container: string | null) => {
    if (!name || KEYWORDS.has(name)) return;
    out.push({ name, kind, path, line: idx + 1, container });
  };
  lines.forEach((line, idx) => {
    if (!line.trim()) return;
    const indent = indentOf(line);
    // A scope ends at the first line indented no deeper than its header: the closing brace
    // of a class or impl block, or the next definition of an indented language.
    while (scopes.length && indent <= scopes.at(-1)!.indent) scopes.pop();
    const container = scopes.at(-1)?.name ?? null;
    let m: RegExpExecArray | null;
    switch (lang) {
      case 'ts': {
        if (
          (m =
            /^\s*(?:export\s+)?(?:default\s+)?(?:declare\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/.exec(
              line,
            ))
        ) {
          add(m[1]!, 'class', idx, container);
          scopes.push({ name: m[1]!, indent });
        } else if (
          (m = /^\s*(?:export\s+)?(?:declare\s+)?interface\s+([A-Za-z_$][\w$]*)/.exec(line))
        ) {
          add(m[1]!, 'interface', idx, container);
        } else if (
          (m = /^\s*(?:export\s+)?(?:declare\s+)?type\s+([A-Za-z_$][\w$]*)\s*(?:<[^=]*>)?\s*=/.exec(
            line,
          ))
        ) {
          add(m[1]!, 'type', idx, container);
        } else if (
          (m = /^\s*(?:export\s+)?(?:declare\s+)?(?:const\s+)?enum\s+([A-Za-z_$][\w$]*)/.exec(line))
        ) {
          add(m[1]!, 'enum', idx, container);
        } else if (
          (m =
            /^\s*(?:export\s+)?(?:default\s+)?(?:declare\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/.exec(
              line,
            ))
        ) {
          add(m[1]!, 'function', idx, container);
        } else if (
          (m =
            /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s+)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*(?::[^=]+)?=>/.exec(
              line,
            ))
        ) {
          add(m[1]!, 'function', idx, container);
        } else if ((m = /^\s*export\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)/.exec(line))) {
          add(m[1]!, 'variable', idx, container);
        } else if (
          container &&
          (m =
            /^\s+(?:(?:public|private|protected|static|async|readonly|override|abstract|get|set)\s+)*(#?[A-Za-z_$][\w$]*)\s*(?:<[^>]*>)?\s*\([^;]*$/.exec(
              line,
            )) &&
          !/^\s*(?:if|for|while|switch|catch|return|await)\b/.test(line)
        ) {
          add(m[1]!, m[1] === 'constructor' ? 'constructor' : 'method', idx, container);
        }
        break;
      }
      case 'py': {
        if ((m = /^\s*class\s+([A-Za-z_]\w*)/.exec(line))) {
          add(m[1]!, 'class', idx, container);
          scopes.push({ name: m[1]!, indent });
        } else if ((m = /^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)/.exec(line))) {
          add(m[1]!, container ? 'method' : 'function', idx, container);
          scopes.push({ name: container ? `${container}.${m[1]!}` : m[1]!, indent });
        }
        break;
      }
      case 'go': {
        if ((m = /^func\s+\(\s*\w*\s*\*?\s*([A-Za-z_]\w*)[^)]*\)\s*([A-Za-z_]\w*)/.exec(line))) {
          add(m[2]!, 'method', idx, m[1]!);
        } else if ((m = /^func\s+([A-Za-z_]\w*)/.exec(line))) {
          add(m[1]!, 'function', idx, null);
        } else if ((m = /^\s*type\s+([A-Za-z_]\w*)\s+(struct|interface)\b/.exec(line))) {
          add(m[1]!, m[2]!, idx, null);
        } else if ((m = /^\s*type\s+([A-Za-z_]\w*)\s+\S/.exec(line))) {
          add(m[1]!, 'type', idx, null);
        }
        break;
      }
      case 'rs': {
        const vis = String.raw`(?:pub(?:\([^)]*\))?\s+)?`;
        if (
          (m = new RegExp(
            String.raw`^\s*impl(?:<[^>]*>)?\s+(?:[\w:<>, ]+\s+for\s+)?(?:\w+::)*([A-Za-z_]\w*)`,
          ).exec(line))
        ) {
          scopes.push({ name: m[1]!, indent });
        } else if (
          (m = new RegExp(
            String.raw`^\s*${vis}(?:const\s+)?(?:async\s+)?(?:unsafe\s+)?(?:extern\s+"[^"]*"\s+)?fn\s+([A-Za-z_]\w*)`,
          ).exec(line))
        ) {
          add(m[1]!, container ? 'method' : 'function', idx, container);
        } else if (
          (m = new RegExp(
            String.raw`^\s*${vis}(struct|enum|trait|type|mod|union)\s+([A-Za-z_]\w*)`,
          ).exec(line))
        ) {
          add(m[2]!, m[1]!, idx, container);
          if (m[1] === 'trait' || m[1] === 'mod') scopes.push({ name: m[2]!, indent });
        } else if ((m = /^\s*macro_rules!\s*([A-Za-z_]\w*)/.exec(line))) {
          add(m[1]!, 'macro', idx, container);
        }
        break;
      }
      case 'java': {
        if (
          (m =
            /^\s*(?:(?:public|private|protected|static|final|abstract|sealed|non-sealed|strictfp)\s+)*(class|interface|enum|record|@interface)\s+([A-Za-z_]\w*)/.exec(
              line,
            ))
        ) {
          add(m[2]!, m[1] === '@interface' ? 'annotation' : m[1]!, idx, container);
          scopes.push({ name: m[2]!, indent });
        } else if (
          container &&
          (m =
            /^\s+(?:(?:public|private|protected|static|final|abstract|synchronized|native|default)\s+)*(?:<[^>]+>\s+)?(?:[\w$<>[\].,?]+\s+)?([A-Za-z_]\w*)\s*\([^;]*$/.exec(
              line,
            )) &&
          !/^\s*(?:if|for|while|switch|catch|return|new|throw|else)\b/.test(line)
        ) {
          add(m[1]!, m[1] === container ? 'constructor' : 'method', idx, container);
        }
        break;
      }
      case 'c': {
        if ((m = /^\s*#\s*define\s+([A-Za-z_]\w*)/.exec(line))) {
          add(m[1]!, 'macro', idx, null);
        } else if (
          (m =
            /^\s*(?:typedef\s+)?(struct|class|enum|union|namespace)\s+([A-Za-z_]\w*)\s*(?:[:{]|$)/.exec(
              line,
            ))
        ) {
          add(m[2]!, m[1]!, idx, container);
          if (m[1] === 'class' || m[1] === 'struct' || m[1] === 'namespace')
            scopes.push({ name: m[2]!, indent });
        } else if (
          (m =
            /^(?:[A-Za-z_][\w:<>,*& ]*[\s*&]+)?((?:[A-Za-z_]\w*::)*~?[A-Za-z_]\w*)\s*\([^;]*\)\s*(?:const\s*)?(?:noexcept\s*)?(?:override\s*)?\{?\s*$/.exec(
              line,
            )) &&
          !/^\s/.test(line) &&
          !/^\s*(?:if|for|while|switch|return|else)\b/.test(line)
        ) {
          const full = m[1]!;
          const sep = full.lastIndexOf('::');
          add(
            sep >= 0 ? full.slice(sep + 2) : full,
            sep >= 0 ? 'method' : 'function',
            idx,
            sep >= 0 ? full.slice(0, sep) : container,
          );
        }
        break;
      }
    }
  });
  return out;
}

interface Entry {
  mtimeMs: number;
  size: number;
  symbols: CodeSymbolView[];
}

/** One session's index, kept in memory and refreshed incrementally. */
export class SymbolIndex {
  readonly #files = new Map<string, Entry>();
  readonly #maxBytes: number;
  readonly #maxFiles: number;

  constructor(opts: { maxFileBytes?: number; maxFiles?: number } = {}) {
    this.#maxBytes = opts.maxFileBytes ?? SYMBOL_LIMITS.maxFileBytes;
    this.#maxFiles = opts.maxFiles ?? SYMBOL_LIMITS.maxFiles;
  }

  get size(): number {
    return this.#files.size;
  }

  /** Re-read files whose size or mtime changed; forget files that are gone. */
  async update(root: string, files: readonly string[]): Promise<void> {
    const wanted = files.filter((f) => codeLanguageOf(f)).slice(0, this.#maxFiles);
    const keep = new Set(wanted);
    for (const p of this.#files.keys()) if (!keep.has(p)) this.#files.delete(p);
    for (const rel of wanted) {
      let st;
      try {
        st = await stat(join(root, rel));
      } catch {
        this.#files.delete(rel);
        continue;
      }
      if (!st.isFile() || st.size > this.#maxBytes) {
        this.#files.delete(rel);
        continue;
      }
      const old = this.#files.get(rel);
      if (old && old.mtimeMs === st.mtimeMs && old.size === st.size) continue;
      let text: string;
      try {
        text = await readFile(join(root, rel), 'utf8');
      } catch {
        continue;
      }
      this.#files.set(rel, {
        mtimeMs: st.mtimeMs,
        size: st.size,
        symbols: extractSymbols(rel, text),
      });
    }
  }

  /** Definitions matching a query: exact names first, then prefixes, then substrings. */
  search(query: string, limit = 50): CodeSymbolView[] {
    const q = query.trim().toLowerCase();
    const max = Math.min(Math.max(limit, 1), SYMBOL_LIMITS.maxResults);
    const hits: { s: CodeSymbolView; rank: number }[] = [];
    for (const e of this.#files.values()) {
      for (const s of e.symbols) {
        const n = s.name.toLowerCase();
        const qualified = s.container ? `${s.container}.${s.name}`.toLowerCase() : n;
        let rank = -1;
        if (!q) rank = 3;
        else if (n === q || qualified === q) rank = 0;
        else if (n.startsWith(q)) rank = 1;
        else if (n.includes(q) || qualified.includes(q)) rank = 2;
        if (rank >= 0) hits.push({ s, rank });
      }
    }
    hits.sort(
      (a, b) =>
        a.rank - b.rank ||
        a.s.name.length - b.s.name.length ||
        a.s.path.localeCompare(b.s.path) ||
        a.s.line - b.s.line,
    );
    return hits.slice(0, max).map((h) => h.s);
  }
}

export interface CodeRef {
  path: string;
  line: number;
  text: string;
}

/** Lines that mention an identifier as a whole word, across the session's source files. */
export async function findCodeRefs(
  root: string,
  files: readonly string[],
  name: string,
  opts: { limit?: number; maxFileBytes?: number } = {},
): Promise<CodeRef[]> {
  if (!/^[A-Za-z_$][\w$]*$/.test(name)) return [];
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), SYMBOL_LIMITS.maxResults);
  const max = opts.maxFileBytes ?? SYMBOL_LIMITS.maxFileBytes;
  const re = new RegExp(`(^|[^\\w$])${name.replace(/\$/g, '\\$')}(?![\\w$])`);
  const out: CodeRef[] = [];
  for (const rel of files) {
    if (!codeLanguageOf(rel)) continue;
    try {
      const st = await stat(join(root, rel));
      if (!st.isFile() || st.size > max) continue;
      const text = await readFile(join(root, rel), 'utf8');
      if (!text.includes(name)) continue;
      const lines = text.split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        if (re.test(lines[i]!)) {
          out.push({ path: rel, line: i + 1, text: lines[i]!.trim().slice(0, 300) });
          if (out.length >= limit) return out;
        }
      }
    } catch {
      continue;
    }
  }
  return out;
}
