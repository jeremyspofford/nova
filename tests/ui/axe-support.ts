// The accessibility sweep of the first UX review (2026-10-31), shared by the CI advisory
// (tests/ui/axe-advisory.ts) and anything that wants the same numbers: axe-core's default rule set,
// as the review ran it (`axe.run()` with no options, axe-core 4.14.0, pinned in package.json), on
// the review's nine views at its ten postures. The profile is seeded with what the review's had:
// a conversation with tables, a step that links out, memory held at the ingest gate, and an open
// problem. Neutral placeholders only.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import type { Browser } from 'playwright-core';
import { until } from '../acceptance/support.ts';
import { seeded } from './m9-support.ts';

export const POSTURES: Record<string, { width: number; height: number; touch?: boolean }> = {
  'desktop-1920': { width: 1920, height: 1080 },
  'laptop-1366': { width: 1366, height: 768 },
  'ipad-portrait': { width: 820, height: 1180 },
  'ipad-landscape': { width: 1180, height: 820 },
  'iphone': { width: 390, height: 844, touch: true },
  'iphone-large': { width: 430, height: 932, touch: true },
  'android': { width: 360, height: 800, touch: true },
  'duo-cover': { width: 380, height: 900, touch: true },
  'duo-inner': { width: 900, height: 1100, touch: true },
  'duo-halfopen': { width: 1100, height: 900, touch: true },
};
export const VIEWS = ['/', '/chat', '/tasks', '/memory', '/automations', '/activity', '/health', '/settings', '/capture'];

const require = createRequire(import.meta.url);
const AXE = readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8');
export const AXE_VERSION: string = require('axe-core/package.json').version;

const at = (hm: string) => `2026-10-31T${hm}.000Z`;
const TABLE = '| | Monday | Tuesday |\n|---|---|---|\n| Morning | Seeds | Water |\n| Evening | Weed | Rest |';

// The main conversation, as the review's had it: replies with tables, a step that read mail and
// links out to it, and memory that waits at the ingest gate (two at once, as F4 saw).
export function reviewConversation(): string {
  const lines: object[] = [{ ts: at('09:00:00'), type: 'session', id: 'main', title: 'Main conversation', kind: 'main', v: 1 }];
  for (let i = 0; i < 3; i++) {
    const turn = `r${i + 1}`;
    const hh = String(9 + i).padStart(2, '0');
    lines.push({ ts: at(`${hh}:00:00`), type: 'user', turn, text: i === 0 ? 'What came in this morning?' : `And plan ${i + 1}?` });
    lines.push({ ts: at(`${hh}:00:01`), type: 'tool_call', turn, attempt: 0, id: `g${i}`, name: 'gmail_organize', args: {}, needs_approval: true, preview: { verb: 'Mark 3 emails read', messages: [] } });
    lines.push({ ts: at(`${hh}:00:02`), type: 'approval', turn, attempt: 0, id: `g${i}`, decision: 'allow' });
    lines.push({ ts: at(`${hh}:00:05`), type: 'tool_result', turn, attempt: 0, id: `g${i}`, ok: true, output: 'Marked 3 emails read.', summary: 'Marked 3 emails read', link: 'https://mail.google.com/mail/u/0/#inbox' });
    lines.push({ ts: at(`${hh}:00:09`), type: 'assistant', turn, attempt: 0, id: `ra${i + 1}`, text: `Here is the week.\n\n${TABLE}\n\nThat is all for now.` });
    lines.push({ ts: at(`${hh}:00:10`), type: 'memory', turn, attempt: 0, ops: [{ op: 'remember', ok: true, held: true, id: `c${i}a` }, { op: 'remember', ok: true, held: true, id: `c${i}b` }] });
    lines.push({ ts: at(`${hh}:00:11`), type: 'done', turn, attempt: 0 });
  }
  return `${lines.map((e) => JSON.stringify(e)).join('\n')}\n`;
}

// A profile like the review's: the M9 seed, the conversation above, and an open problem whose
// message names a path (a backup folder that went away).
export async function reviewProfile(prefix: string) {
  const { m, nova } = await seeded(prefix);
  writeFileSync(join(m.home, 'sessions', 'main.jsonl'), reviewConversation());
  const api = (p: string) => `/api/v1${p}`;
  const settled = (id: string) => until<any>(() => m.get(api(`/tasks/${id}`)), (x) => ['done', 'failed'].includes(x.state), 2400);
  const target = join(m.dir, 'backups');
  mkdirSync(target);
  if ((await m.send('PUT', api('/backups/settings'), { target })).status !== 200) throw new Error('backup settings');
  rmSync(target, { recursive: true });
  const r = await m.send('POST', api('/backups'));
  if (r.body?.id) await settled(r.body.id);
  return { m, nova };
}

export interface ViewResult { posture: string; view: string; violations: { id: string; impact: string | null; nodes: number; targets: string[] }[]; error?: string }

// One sweep: every view at every posture, axe's default rules, as the review ran them.
export async function sweep(b: Browser, base: string, { postures = Object.keys(POSTURES), views = VIEWS } = {}): Promise<ViewResult[]> {
  const out: ViewResult[] = [];
  for (const name of postures) {
    const p = POSTURES[name]!;
    const ctx = await b.newContext({ viewport: { width: p.width, height: p.height }, ...(p.touch ? { hasTouch: true, isMobile: true } : {}) });
    const page = await ctx.newPage();
    for (const view of views) {
      const r: ViewResult = { posture: name, view, violations: [] };
      try {
        await page.goto(base + view, { waitUntil: 'load' });
        await page.waitForSelector('html[data-ready]', { timeout: 20000 });
        await page.waitForTimeout(900);
        await page.addScriptTag({ content: AXE });
        r.violations = await page.evaluate(async () => {
          const res = await (window as any).axe.run();
          return res.violations.map((v: any) => ({ id: v.id, impact: v.impact, nodes: v.nodes.length, targets: v.nodes.map((n: any) => String(n.target?.[0] ?? '')) }));
        });
      } catch (e) { r.error = (e as Error).message.split('\n')[0]; }
      out.push(r);
    }
    await ctx.close();
  }
  return out;
}

// Totals per rule and per view, and the Markdown the job summary shows.
export function tally(results: ViewResult[]) {
  const byRule: Record<string, number> = {};
  const byView: Record<string, number> = {};
  const cell: Record<string, Record<string, number>> = {};
  for (const r of results) {
    for (const v of r.violations) {
      byRule[v.id] = (byRule[v.id] ?? 0) + v.nodes;
      byView[r.view] = (byView[r.view] ?? 0) + v.nodes;
      (cell[v.id] ??= {})[r.view] = (cell[v.id]![r.view] ?? 0) + v.nodes;
    }
  }
  const total = Object.values(byRule).reduce((s, n) => s + n, 0);
  return { total, byRule, byView, cell };
}

export function markdown(results: ViewResult[]): string {
  const { total, byRule, byView, cell } = tally(results);
  const views = VIEWS.filter((v) => results.some((r) => r.view === v));
  const postures = new Set(results.map((r) => r.posture)).size;
  const lines = [
    '## Accessibility (advisory)',
    '',
    `axe-core ${AXE_VERSION}, default rules, ${views.length} views × ${postures} postures. **${total} node${total === 1 ? '' : 's'}** in violation. Advisory only: this never fails the build.`,
    '',
  ];
  if (total) {
    lines.push(`| rule | ${views.join(' | ')} | total |`, `|---|${views.map(() => '---:').join('|')}|---:|`);
    for (const id of Object.keys(byRule).sort()) lines.push(`| ${id} | ${views.map((v) => cell[id]?.[v] ?? 0).join(' | ')} | ${byRule[id]} |`);
    lines.push(`| **total** | ${views.map((v) => byView[v] ?? 0).join(' | ')} | **${total}** |`, '');
    const seen = new Map<string, Set<string>>();
    for (const r of results) for (const v of r.violations) for (const t of v.targets) (seen.get(v.id) ?? seen.set(v.id, new Set()).get(v.id)!).add(`${r.view} ${t}`);
    lines.push('<details><summary>Where</summary>', '');
    for (const [id, where] of seen) lines.push(`- **${id}**: ${[...where].slice(0, 12).map((w) => `\`${w}\``).join(', ')}`);
    lines.push('', '</details>');
  }
  const errors = results.filter((r) => r.error);
  if (errors.length) lines.push('', `${errors.length} view(s) couldn’t be checked: ${errors.map((r) => `${r.posture} ${r.view} (${r.error})`).join('; ')}`);
  return `${lines.join('\n')}\n`;
}
