// What proves a browser task done (M5 plan §3), checked by Nova itself:
//  - `screenshot`: the PNG Nova's own browser took at the end, in the task's folder;
//  - `url`: the final page shows what the brief said it must, read by Nova afresh: fetched again
//    inside the declared hosts, or the final DOM read through CDP.
// The worker leaves its reads in the task's folder (home/workers/browser/<task>/), outside every
// workspace a provider can write to; the checkers read them there and compare them with the brief.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import type { Brief, Evidence } from '../envelope.ts';
import type { Checker } from '../verify.ts';
import { allowed } from './plan.ts';

export const SCREENSHOT = 'final.png';
export const FINAL_READ = 'final-read.json';
const TASK_ID = /^[A-Za-z0-9_-]{1,80}$/;

// The task's folder, inside the home: never anything a task id could steer elsewhere.
export function taskDir(home: string, taskId: string): string {
  if (!TASK_ID.test(taskId)) throw new Error(`Not a task id: ${taskId}`);
  return join(home, 'workers', 'browser', taskId);
}
// How the report names a file of the task's folder: relative to the home.
export const refOf = (taskId: string, file: string) => `workers/browser/${taskId}/${file}`;

export interface Read { source: 'fetch' | 'dom'; url: string; status?: number; text: string; error?: string }
export interface FinalRead { task_id: string; url: string; final_url: string; at: string; reads: Read[] }

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" };

// A page's visible words, roughly: no scripts, styles or tags, entities decoded.
export function htmlText(html: string): string {
  return html
    .replace(/<(script|style|noscript|template)\b[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+|#39);/gi, (m, e: string) => {
      const k = e.toLowerCase();
      if (k.startsWith('#x')) return String.fromCodePoint(parseInt(k.slice(2), 16));
      if (k.startsWith('#')) return String.fromCodePoint(Number(k.slice(1)));
      return ENTITIES[k] ?? m;
    });
}

export const squash = (s: string) => s.normalize('NFC').replace(/\s+/g, ' ').trim();

// Nova fetches the page again itself, following redirects only inside the declared hosts.
export async function refetch(url: string, hosts: readonly string[], o: { timeoutMs?: number; maxBytes?: number } = {}): Promise<Read> {
  let at = url;
  try {
    for (let hop = 0; hop < 5; hop++) {
      if (!allowed(at, hosts)) return { source: 'fetch', url, text: '', error: `It led outside the declared hosts (${new URL(at).host}).` };
      const res = await fetch(at, { redirect: 'manual', signal: AbortSignal.timeout(o.timeoutMs ?? 10_000), headers: { accept: 'text/html,text/plain,application/json' } });
      const next = res.headers.get('location');
      if (res.status >= 300 && res.status < 400 && next) {
        await res.body?.cancel();
        at = new URL(next, at).href;
        continue;
      }
      const raw = Buffer.from(await res.arrayBuffer()).subarray(0, o.maxBytes ?? 2_000_000).toString('utf8');
      const type = res.headers.get('content-type') ?? '';
      return { source: 'fetch', url, status: res.status, text: type.includes('html') ? htmlText(raw) : raw };
    }
    return { source: 'fetch', url, text: '', error: 'It redirected too many times.' };
  } catch (e) {
    return { source: 'fetch', url, text: '', error: (e as Error).message };
  }
}

export function pngSize(buf: Buffer): { width: number; height: number } | null {
  const SIG = '89504e470d0a1a0a';
  if (buf.length < 24 || buf.subarray(0, 8).toString('hex') !== SIG || buf.subarray(12, 16).toString('latin1') !== 'IHDR') return null;
  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  return width > 0 && height > 0 ? { width, height } : null;
}

const quote = (xs: string[]) => xs.map((x) => `“${x.length > 60 ? `${x.slice(0, 59)}…` : x}”`).join(', ');

export function checkers(home: string): { screenshot: Checker; url: Checker } {
  const screenshot: Checker = (e: Evidence, brief: Brief) => {
    if (e.kind !== 'screenshot') return { ok: false, why: 'Not a screenshot.' };
    let dir: string;
    try { dir = taskDir(home, brief.task_id); } catch { return { ok: false, why: 'Nova can’t tell which task this screenshot belongs to.' }; }
    const file = resolve(home, e.ref);
    // Only a screenshot Nova's own browser took for this very task counts.
    if (!file.startsWith(dir + sep)) return { ok: false, why: `Nova takes its own screenshots; ${e.ref} isn’t one it took for this task.` };
    if (!existsSync(file)) return { ok: false, why: `Nova looked for its screenshot ${e.ref} and it isn’t there.` };
    const data = readFileSync(file);
    const size = pngSize(data);
    if (!size) return { ok: false, why: `${e.ref} isn’t a PNG picture.` };
    return { ok: true, why: `Nova took this screenshot itself at the end of the task: ${size.width}×${size.height}, ${Math.max(1, Math.round(statSync(file).size / 1024))} kB, sha256 ${createHash('sha256').update(data).digest('hex').slice(0, 12)}….` };
  };

  const url: Checker = (e: Evidence, brief: Brief) => {
    if (e.kind !== 'url') return { ok: false, why: 'Not a link.' };
    const inputs = (brief.inputs ?? {}) as { allowed_hosts?: string[]; verify?: { expect?: string[] } };
    const expect = (inputs.verify?.expect ?? []).filter((x) => typeof x === 'string' && x.trim());
    if (!expect.length) return { ok: false, why: 'The task didn’t say what the final page must show, so a link alone can’t prove it.' };
    if (!Array.isArray(inputs.allowed_hosts) || !allowed(e.url, inputs.allowed_hosts)) return { ok: false, why: `${e.url} is outside the hosts this task declared, so Nova won’t read it.` };
    let record: FinalRead;
    try {
      record = JSON.parse(readFileSync(join(taskDir(home, brief.task_id), FINAL_READ), 'utf8')) as FinalRead;
    } catch {
      return { ok: false, why: `Nova has no read of its own of ${e.url}, so the link alone can’t count as proof.` };
    }
    if (record.task_id !== brief.task_id || record.url !== e.url) return { ok: false, why: `Nova read ${record.url}, not ${e.url}.` };
    const reads = record.reads.filter((r) => r.url === e.url && !r.error);
    if (!reads.length) return { ok: false, why: `Nova couldn’t read ${e.url} itself: ${record.reads.map((r) => r.error).filter(Boolean).join(' ') || 'no answer'}.` };
    const missingIn = (r: Read) => expect.filter((x) => !squash(r.text).includes(squash(x)));
    const best = reads.find((r) => !missingIn(r).length);
    const how = (r: Read) => (r.source === 'fetch' ? `fetched ${e.url} again itself${r.status ? ` (HTTP ${r.status})` : ''}` : `read the final page in its own browser, afresh`);
    if (best) return { ok: true, why: `Nova ${how(best)}, and it shows ${quote(expect)}.` };
    const r = reads[0]!;
    return { ok: false, why: `Nova ${how(r)}, and it doesn’t show ${quote(missingIn(r))}.` };
  };

  return { screenshot, url };
}
