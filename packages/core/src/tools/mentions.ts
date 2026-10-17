// `@`-mentions (FR-022): candidates for the composer (files and folders under the thread's
// roots, MCP servers and tools) and resolution on send. A file becomes capped, untrusted file
// content in the context; a folder its listing; an MCP server or a tool loads those tools for
// the turn (never deferred, FR-196). Refs are re-resolved inside the roots on every send: a ref
// from a client is never trusted to name an allowed path.
import { readdirSync, readFileSync, statSync, type Dirent } from 'node:fs';
import { join } from 'node:path';
import type { MentionCandidate, MentionKind } from '@nova/shared';
import { hiddenFromTools, resolveInRoots, displayPath, type PathPolicy } from './roots.ts';
import { sourceGroup } from './search.ts';
import { clip } from './text.ts';
import type { ResolvedMention, ToolDefinition, ToolRoot } from './types.ts';

export const MAX_MENTION_CHARS = 100_000;
const MAX_CANDIDATES = 20;
const WALK_LIMIT = 10_000;
const SKIP_DIRS = new Set(['.git', 'node_modules', '.hg', '.svn', '__pycache__']);

/** Composer candidates for `q`: files and folders first, then MCP servers and tools. */
export function mentionCandidates(
  q: string,
  roots: readonly ToolRoot[],
  tools: readonly ToolDefinition[],
  policy: PathPolicy = {},
): MentionCandidate[] {
  const needle = q.trim().toLowerCase();
  const files: { c: MentionCandidate; rank: number }[] = [];
  let visited = 0;
  for (const root of roots) {
    let base: ReturnType<typeof resolveInRoots>;
    try {
      base = resolveInRoots(roots, root.path, 'read', policy);
    } catch {
      continue;
    }
    const queue: { abs: string; rel: string; depth: number }[] = [
      { abs: base.path, rel: '', depth: 0 },
    ];
    for (let qi = 0; qi < queue.length && visited < WALK_LIMIT; qi++) {
      const { abs, rel, depth } = queue[qi]!;
      let entries: Dirent[];
      try {
        entries = readdirSync(abs, { withFileTypes: true });
      } catch {
        continue;
      }
      entries.sort((a, b) => a.name.localeCompare(b.name));
      for (const e of entries) {
        if (++visited > WALK_LIMIT) break;
        const relPath = rel ? `${rel}/${e.name}` : e.name;
        if (hiddenFromTools(relPath.split('/'))) continue;
        const dir = e.isDirectory();
        if (dir && !SKIP_DIRS.has(e.name) && depth < 8)
          queue.push({ abs: join(abs, e.name), rel: relPath, depth: depth + 1 });
        if (!dir && !e.isFile()) continue;
        const rank = rankPath(needle, e.name.toLowerCase(), relPath.toLowerCase(), depth);
        if (rank === null) continue;
        const absPath = join(abs, e.name);
        files.push({
          rank,
          c: {
            kind: dir ? 'folder' : 'file',
            ref: `${dir ? 'folder' : 'file'}:${absPath}`,
            label: e.name,
            detail: roots.length > 1 ? `${root.label}/${relPath}` : relPath,
          },
        });
      }
    }
  }
  files.sort((a, b) => a.rank - b.rank || a.c.detail!.length - b.c.detail!.length);

  const servers = new Map<string, number>();
  for (const t of tools) {
    if (t.descriptor.source !== 'mcp') continue;
    const g = sourceGroup(t.descriptor);
    servers.set(g, (servers.get(g) ?? 0) + 1);
  }
  const serverHits: MentionCandidate[] = [...servers.entries()]
    .filter(([g]) => !needle || g.toLowerCase().includes(needle))
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([g, n]) => ({
      kind: 'mcp_server',
      ref: g,
      label: g.replace(/^mcp:/, ''),
      detail: `MCP server, ${n} tool${n === 1 ? '' : 's'}`,
    }));
  const toolHits: MentionCandidate[] = tools
    .filter((t) => {
      if (!needle) return t.descriptor.source !== 'builtin';
      return (
        t.descriptor.name.toLowerCase().includes(needle) ||
        t.descriptor.title.toLowerCase().includes(needle)
      );
    })
    .sort((a, b) => (a.descriptor.name < b.descriptor.name ? -1 : 1))
    .map((t) => ({
      kind: 'tool',
      ref: `tool:${t.descriptor.name}`,
      label: t.descriptor.name,
      detail: t.descriptor.title,
    }));

  const out: MentionCandidate[] = [];
  const fileShare = serverHits.length + toolHits.length ? 12 : MAX_CANDIDATES;
  out.push(...files.slice(0, fileShare).map((f) => f.c));
  out.push(...serverHits.slice(0, MAX_CANDIDATES - out.length));
  out.push(...toolHits.slice(0, MAX_CANDIDATES - out.length));
  return out.slice(0, MAX_CANDIDATES);
}

function rankPath(needle: string, name: string, rel: string, depth: number): number | null {
  if (!needle) return depth === 0 ? 0 : null;
  if (name.startsWith(needle)) return 0;
  if (name.includes(needle)) return 1;
  if (rel.includes(needle)) return 2;
  return null;
}

/** Resolve the mentions sent with a message into context items (FR-022). */
export function resolveMentions(
  mentions: readonly { kind: MentionKind; ref: string }[],
  roots: readonly ToolRoot[],
  tools: readonly ToolDefinition[],
  policy: PathPolicy = {},
): ResolvedMention[] {
  const out: ResolvedMention[] = [];
  const seen = new Set<string>();
  for (const m of mentions) {
    const key = `${m.kind}:${m.ref}`;
    if (seen.has(key)) continue;
    seen.add(key);
    switch (m.kind) {
      case 'file':
      case 'folder': {
        const raw = m.ref.replace(/^(file|folder):/, '');
        try {
          const p = resolveInRoots(roots, raw, 'read', policy);
          const shown = displayPath(roots, p);
          const st = statSync(p.path);
          if (m.kind === 'file') {
            if (!st.isFile()) throw new Error('not a file');
            out.push({
              kind: 'file',
              ref: m.ref,
              label: shown,
              text: fileText(p.path, shown, st.size),
              tools: [],
            });
          } else {
            if (!st.isDirectory()) throw new Error('not a folder');
            out.push({
              kind: 'folder',
              ref: m.ref,
              label: shown,
              text: folderText(p.path, shown, p.rel),
              tools: [],
            });
          }
        } catch {
          out.push({
            kind: m.kind,
            ref: m.ref,
            label: raw,
            text: `[The mentioned ${m.kind} ${clip(raw, 200)} is not available to Nova.]`,
            tools: [],
          });
        }
        break;
      }
      case 'mcp_server': {
        const group = m.ref.startsWith('mcp:') ? m.ref : `mcp:${m.ref}`;
        const names = tools
          .filter((t) => t.descriptor.source === 'mcp' && sourceGroup(t.descriptor) === group)
          .map((t) => t.descriptor.name);
        out.push({ kind: 'mcp_server', ref: m.ref, label: group, text: null, tools: names });
        break;
      }
      case 'tool': {
        const name = m.ref.replace(/^tool:/, '');
        const known = tools.some((t) => t.descriptor.name === name);
        out.push({ kind: 'tool', ref: m.ref, label: name, text: null, tools: known ? [name] : [] });
        break;
      }
      case 'skill':
        // Skills arrive with M4 (docs/08 §4); the mention is kept but loads nothing yet.
        out.push({ kind: 'skill', ref: m.ref, label: m.ref, text: null, tools: [] });
        break;
    }
  }
  return out;
}

function fileText(abs: string, shown: string, size: number): string {
  const buf = readFileSync(abs).subarray(0, MAX_MENTION_CHARS * 4);
  if (buf.subarray(0, 8192).includes(0)) return `[${shown} is a binary file (${size} bytes).]`;
  let text = buf.toString('utf8');
  let note = '';
  if (text.length > MAX_MENTION_CHARS) {
    text = text.slice(0, MAX_MENTION_CHARS);
    note = ` (truncated to the first ${MAX_MENTION_CHARS} characters; fs.read can read the rest)`;
  }
  return `Mentioned file ${shown}${note}:\n${text}`;
}

function folderText(abs: string, shown: string, rel: string): string {
  let entries: Dirent[];
  try {
    entries = readdirSync(abs, { withFileTypes: true });
  } catch {
    return `[The folder ${shown} could not be listed.]`;
  }
  const lines = entries
    .filter((e) => !hiddenFromTools([...rel.split('/').filter(Boolean), e.name]))
    .sort((a, b) => a.name.localeCompare(b.name))
    .slice(0, 200)
    .map((e) => (e.isDirectory() ? `${e.name}/` : e.name));
  const more = entries.length > 200 ? `\n[... ${entries.length - 200} more]` : '';
  return `Mentioned folder ${shown}:\n${lines.join('\n')}${more}`;
}
