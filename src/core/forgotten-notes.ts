// Forgetting a day note (memory/YYYY-MM-DD.md), and the words of anything forgotten, in copies of
// the home's files: the nightly backups, their encrypted copies, checkpoints and a staged restore.
//
// A day note has no memory record, so what the home keeps of its forget is a content-free note in
// memory_event: kind "note-forgotten", memory_id "note:<its id>:<a hash of its words>". The words
// themselves are never kept, so a restore (and the drill) find a forgotten note in an older copy by
// its id or by that hash. An undo writes "note-restored" for the same key, and the latest one wins.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { sha256 } from './workspace.ts';

export const NOTE_FORGOTTEN = 'note-forgotten';
export const NOTE_RESTORED = 'note-restored';

const NOTE_ID = /^[A-Za-z0-9_-]{1,64}$/;
const KEY = /^note:([A-Za-z0-9_-]{1,64}):([0-9a-f]{64})$/;
const BULLET = /^[-*]\s+(.*)$/;
const MORE = /^\s{2,}\S/;
const META = /\s*<!--\s*((?:[\w-]+=\S*\s*)+)-->\s*$/;
const TIME = /^(\d{1,2}:\d{2})\s+·\s+/;
const DAY_FILE = /^\d{4}-\d{2}-\d{2}\.md$/;

// Whitespace collapsed, the way a memory's words are compared everywhere.
export const collapse = (s: string): string => String(s ?? '').replace(/\s+/g, ' ').trim();
// A note's words as memory.js keeps them: one line, no comment markers.
const oneLine = (s: string): string => String(s ?? '').replace(/\s+/g, ' ').replace(/<!--|-->/g, '').trim();
// What memory.js calls an entry written by hand, without an id of its own.
const handId = (text: string): string => `h${createHash('sha1').update(text).digest('hex').slice(0, 8)}`;

export const noteHash = (text: string): string => sha256(`nova-note\0${oneLine(text)}`);
export const validNoteId = (id: unknown): id is string => typeof id === 'string' && NOTE_ID.test(id);
export const noteKey = (id: string, text: string): string => `note:${id}:${noteHash(text)}`;

export function parseNoteKey(key: string): { id: string; hash: string } | null {
  const m = KEY.exec(String(key));
  return m ? { id: m[1]!, hash: m[2]! } : null;
}

export interface ForgottenNotes { ids: Set<string>; hashes: Set<string>; count: number }

// The notes forgotten and not put back since, from memory_event rows in the order they were written.
export function forgottenNotes(rows: { kind: string; memory_id: string }[]): ForgottenNotes {
  const last = new Map<string, string>();
  for (const r of rows) if ((r.kind === NOTE_FORGOTTEN || r.kind === NOTE_RESTORED) && parseNoteKey(r.memory_id)) last.set(r.memory_id, r.kind);
  const ids = new Set<string>();
  const hashes = new Set<string>();
  let count = 0;
  for (const [key, kind] of last) {
    if (kind !== NOTE_FORGOTTEN) continue;
    const k = parseNoteKey(key)!;
    ids.add(k.id);
    hashes.add(k.hash);
    count++;
  }
  return { ids, hashes, count };
}

export const noteEventsSql = `SELECT kind, memory_id FROM memory_event WHERE kind IN ('${NOTE_FORGOTTEN}', '${NOTE_RESTORED}') ORDER BY id`;

interface Entry { start: number; end: number; id: string; hash: string }

// The list entries of a memory file (MEMORY.md, a day note), as memory.js reads them: a bullet and
// the indented lines after it, its id from its comment (or made from its words), its words hashed.
export function entriesOf(text: string): Entry[] {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const out: Entry[] = [];
  for (let i = 0; i < lines.length; i++) {
    const b = BULLET.exec(lines[i]!);
    if (!b) continue;
    let end = i + 1;
    while (end < lines.length && MORE.test(lines[end]!)) end++;
    let body = [b[1]!, ...lines.slice(i + 1, end).map((l) => l.trim())].join(' ');
    let id: string | null = null;
    const m = META.exec(body);
    if (m) {
      id = /(?:^|\s)id=(\S+)/.exec(m[1]!)?.[1] ?? null;
      body = body.slice(0, m.index);
    }
    const t = TIME.exec(body);
    if (t) body = body.slice(t[0].length);
    body = body.trim();
    if (body) out.push({ start: i, end, id: id || handId(body), hash: noteHash(body) });
    i = end - 1;
  }
  return out;
}

const matches = (e: Entry, notes: ForgottenNotes) => notes.ids.has(e.id) || notes.hashes.has(e.hash);

// The forgotten notes' entries taken out of a memory file's text; null when it holds none.
export function dropNotes(text: string, notes: ForgottenNotes): { text: string; dropped: number } | null {
  if (!notes.count) return null;
  const hit = entriesOf(text).filter((e) => matches(e, notes));
  if (!hit.length) return null;
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  for (const e of [...hit].reverse()) lines.splice(e.start, e.end - e.start);
  return { text: lines.join('\n'), dropped: hit.length };
}

// How many of the forgotten notes' entries a text holds.
export const notesIn = (text: string, notes: ForgottenNotes): number => (notes.count ? entriesOf(text).filter((e) => matches(e, notes)).length : 0);

// The memory files of a home (or of a copy laid out like one): MEMORY.md and the day notes, as paths
// relative to it.
export function memoryFiles(dir: string): string[] {
  const out: string[] = [];
  if (existsSync(join(dir, 'MEMORY.md'))) out.push('MEMORY.md');
  try { for (const f of readdirSync(join(dir, 'memory')).sort()) if (DAY_FILE.test(f)) out.push(`memory/${f}`); } catch { /* none */ }
  return out;
}

// The hashes of every entry a home shows now: a note written again since its forget is the person's
// again, and isn't counted as a forgotten one coming back.
export function liveNoteHashes(home: string): Set<string> {
  const out = new Set<string>();
  for (const rel of memoryFiles(home)) {
    try { for (const e of entriesOf(readFileSync(join(home, rel), 'utf8'))) out.add(e.hash); } catch { /* unreadable: nothing */ }
  }
  return out;
}

// ---- forgotten words in files ----------------------------------------------------------------------

// The words worth looking for: trimmed, at least three characters, each once.
export const needles = (words: string[]): string[] => [...new Set(words.map((w) => String(w ?? '').trim()).filter((w) => w.length >= 3))];

// A file's text without the lines that carry any of the words, matched as written or with its
// whitespace collapsed (a line wrapped or spaced differently by hand). A list entry spread over
// indented lines goes whole. Null when the file carries none of them; throws for a file that does
// and isn't text, so the caller destroys the copy rather than keep it.
export function scrubWords(raw: Buffer, words: string[], name = 'A file'): string | null {
  const ws = needles(words);
  if (!ws.length) return null;
  const flat = ws.map(collapse);
  const exact = ws.some((w) => raw.includes(Buffer.from(w)));
  const binary = raw.includes(0);
  if (!exact && (binary || !flat.some((w) => collapse(raw.toString('utf8')).includes(w)))) return null;
  if (binary) throw new Error(`${name} holds forgotten words and isn’t text, so it can’t be cleaned.`);
  const carries = (s: string) => ws.some((w) => s.includes(w)) || flat.some((w) => collapse(s).includes(w));
  const lines = raw.toString('utf8').split('\n');
  const kept: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    let end = i + 1;
    if (/^\s*[-*]\s/.test(lines[i]!)) while (end < lines.length && MORE.test(lines[end]!)) end++;
    const block = lines.slice(i, end);
    if (!carries(block.join('\n'))) kept.push(...block);
    i = end - 1;
  }
  // What's left of a record spread over lines goes too.
  let text = kept.join('\n');
  for (const w of ws) text = text.split(w).join('');
  return text;
}
