// Shared by the M9 gate (Amendment 2026-10-30-C Part 2): a profile with something in it, the main
// views, the two widths, and in-page measures. Nothing here is user data: neutral placeholders.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Page } from 'playwright-core';
import { until } from '../acceptance/support.ts';
import { blank, finishSetup } from './support.ts';

export const PHONE = { width: 390, height: 844 };
export const DESKTOP = { width: 1280, height: 820 };
export const SIZES = [['phone', PHONE], ['desktop', DESKTOP]] as const;
export const CHAT = '2026-10-28-garden';
// The main views (M9 gate) and where each opens.
export const VIEWS: Record<string, string> = { home: '/', chat: `/c/${CHAT}`, tasks: '/tasks', settings: '/settings', memory: '/memory' };
export const MAIN = Object.keys(VIEWS);

const at = (hm: string, day = 28) => `2026-10-${day}T${hm}.000Z`;
const PROSE = [
  'Start with the peas. They like the cool weather, and they put nitrogen back into the soil for whatever you plant after them, so the bed is better for the beans in summer and the squash after that.',
  'Sow them an inch deep and two inches apart, in a double row with a net between so they have something to climb.',
  'Water them in the morning, not at night: wet leaves overnight invite mildew, and the roots drink best when the day is cool.',
  'Beans next, once the soil is warm to the touch a hand deep. Until then they sit and sulk, and some will rot before they come up.',
];

// A conversation long enough to scroll: twelve exchanges over two days, with a tool step.
export function conversation(): string {
  const lines: object[] = [{ ts: at('09:00:00'), type: 'session', id: CHAT, title: 'Planning the garden', v: 1 }];
  for (let i = 0; i < 12; i++) {
    const day = i < 8 ? 28 : 29;
    const hh = String(9 + (i % 8)).padStart(2, '0');
    const turn = `t${i + 1}`;
    lines.push({ ts: at(`${hh}:00:00`, day), type: 'user', turn, text: i === 0 ? 'What should I plant first?' : `And what about bed ${i + 1}?` });
    if (i === 0) {
      lines.push({ ts: at(`${hh}:00:02`, day), type: 'tool_call', turn, attempt: 0, id: 'c1', name: 'read_file', args: { path: 'notes/garden.md' } });
      lines.push({ ts: at(`${hh}:00:04`, day), type: 'tool_result', turn, attempt: 0, id: 'c1', ok: true, output: 'beds: 4\nsoil: loam' });
    }
    // One reply that went wrong, as Nova records it: an error with its detail.
    if (i === 5) { lines.push({ ts: at(`${hh}:00:09`, day), type: 'error', turn, attempt: 0, message: 'The model stopped answering, so this reply didn’t finish.', detail: 'connection reset' }); continue; }
    lines.push({ ts: at(`${hh}:00:09`, day), type: 'assistant', turn, attempt: 0, id: `a${i + 1}`, text: `${PROSE[i % 4]}\n\n${PROSE[(i + 1) % 4]}` });
    lines.push({ ts: at(`${hh}:00:10`, day), type: 'done', turn, attempt: 0 });
  }
  return `${lines.map((e) => JSON.stringify(e)).join('\n')}\n`;
}

const MEMORIES = [
  ['preference', 'Prefers tea in the afternoon.'],
  ['fact', 'The garden has four raised beds.'],
  ['fact', 'The plants get water on Sundays.'],
  ['preference', 'Likes short answers first, detail on request.'],
  ['fact', 'Works from home on Fridays.'],
  ['commitment', 'Send the seed order before the end of the month.'],
];

// Setup answered, then: a long conversation, memories, and a few verified tasks.
export async function seeded(prefix: string, extra: Record<string, string> = {}) {
  const m = blank(prefix);
  const nova = await m.start(extra);
  await finishSetup(m);
  writeFileSync(join(m.home, 'sessions', `${CHAT}.jsonl`), conversation());
  for (const [kind, content] of MEMORIES) {
    const r = await m.send('POST', '/api/v1/memory', { kind, content });
    if (r.status !== 201) throw new Error(`memory: ${JSON.stringify(r.body)}`);
  }
  const ids: string[] = [];
  for (const [i, name] of ['shopping', 'seeds', 'chores', 'reading'].entries()) {
    const r = await m.send('POST', '/api/v1/tasks', {
      title: `Save the ${name} list`, owner: 'workspace', goal: `The ${name} list is saved.`,
      evidence_required: [{ kind: 'read_back', target: `workspace:lists/${name}.md` }],
      inputs: { action: 'write', path: `lists/${name}.md`, content: `- item ${i + 1}\n` },
    });
    if (r.status !== 201) throw new Error(`task: ${JSON.stringify(r.body)}`);
    ids.push(r.body.id);
  }
  for (const id of ids) await until(() => m.get(`/api/v1/tasks/${id}`), (x: any) => x.state === 'done');
  return { m, nova };
}

// The view a path opens is on screen, drawn from its data (not a skeleton or a wait).
export async function settled(page: Page, view: string) {
  await page.waitForSelector('html[data-ready]');
  await page.waitForFunction((v) => {
    const sel: Record<string, string> = { home: '#home .home-cards .card', chat: '#thread .turn', tasks: '#tasks-view .task-list, #tasks-view .empty-state', settings: '#settings-view .settings-cat', memory: '#memory .memory-item' };
    const el = document.querySelector(sel[v]!);
    return !!el && !document.querySelector('[data-skeleton]');
  }, view, { timeout: 15000 });
}

// The interactive controls on screen: what a person can press, type in or choose.
export const CONTROLS = 'a[href], button, input:not([type="hidden"]), select, textarea, summary, [role="button"], [role="switch"], [role="option"], [role="tab"], [tabindex]:not([tabindex="-1"])';
