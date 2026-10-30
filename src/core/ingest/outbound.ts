// The outbound guard (Amendment 2026-10-30-C Part 3, plan §7): before anything leaves for a
// destination outside content could have chosen (a URL's path and query, a search, a mail draft, a
// form fill, a webhook body), the payload is checked for
//   - secrets: the vault's values (a planted canary among them), plain or encoded;
//   - memory: any 24 characters or more matching a memory record or a standing file;
//   - long encoded blobs.
// A match never goes silently: the step stops and the person is asked, with what matched said by
// kind. A run that read nothing from outside, going where the person said, is checked for secrets
// only: the person can still share their own notes when they ask to. Pure.
import { decodeBlobs } from './checks.ts';

export interface Match { kind: 'secret' | 'memory' | 'encoded'; words: string }
export interface OutboundResult { ok: boolean; matched: Match[] }
export const SHINGLE = 24;

const WORDS: Record<Match['kind'], string> = {
  secret: 'looks like a saved password or key',
  memory: 'looks like something from your memory or your own files',
  encoded: 'looks like encoded data, which could hide anything',
};

const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ');

function safeDecode(s: string): string {
  try { return decodeURIComponent(s.replace(/\+/g, ' ')); } catch { return s.replace(/\+/g, ' '); }
}

// The payload, and what it says once decoded.
export function forms(text: string): string[] {
  const out = new Set([text, safeDecode(text)]);
  for (const t of [...out]) for (const b of decodeBlobs(t)) {
    out.add(b.raw);
    try { out.add(Buffer.from(b.raw.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')); } catch { /* not base64 */ }
    if (/^(?:[0-9a-f]{2})+$/i.test(b.raw)) out.add(Buffer.from(b.raw, 'hex').toString('utf8'));
    if (b.decoded) out.add(b.decoded);
  }
  return [...out];
}

function hasSecret(all: string[], secrets: string[]): boolean {
  const lower = all.map((f) => f.toLowerCase());
  for (const s of secrets) {
    if (typeof s !== 'string' || s.length < 6) continue;
    const variants = [s, Buffer.from(s).toString('base64').replace(/=+$/, ''), Buffer.from(s).toString('base64url'), Buffer.from(s).toString('hex'), encodeURIComponent(s)].map((v) => v.toLowerCase());
    if (lower.some((f) => variants.some((v) => f.includes(v)))) return true;
  }
  return false;
}

// Every run of 24 normalized characters in the person's own texts.
export function shingles(texts: string[]): Set<string> {
  const out = new Set<string>();
  for (const t of texts) {
    const n = norm(t).replace(/\s+/g, ' ').trim();
    for (let i = 0; i + SHINGLE <= n.length; i++) out.add(n.slice(i, i + SHINGLE));
  }
  return out;
}

function hasMemory(all: string[], set: Set<string>): boolean {
  if (!set.size) return false;
  for (const f of all) {
    const n = norm(f).replace(/\s+/g, ' ').trim();
    for (let i = 0; i + SHINGLE <= n.length; i++) if (set.has(n.slice(i, i + SHINGLE))) return true;
  }
  return false;
}

export function outbound(text: string, o: { tainted: boolean; secrets: string[]; mine: () => Set<string> }): OutboundResult {
  const all = forms(String(text ?? ''));
  const matched: Match[] = [];
  const add = (kind: Match['kind']) => matched.push({ kind, words: WORDS[kind] });
  if (hasSecret(all, o.secrets)) add('secret');
  else if (o.tainted && hasMemory(all, o.mine())) add('memory');
  if (!matched.length && o.tainted && decodeBlobs(String(text ?? '')).length) add('encoded');
  return { ok: matched.length === 0, matched };
}
