// Fixture pieces for the golden tasks: registry states built through the core's and runner's own
// objects, in the task's temp home. Neutral placeholders only (example names, .example hosts, no
// real data or secrets).
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { startFakeScreenpipe } from '../../scripts/fake-screenpipe.js';
import type { World } from './driver.ts';

export const SCHEDULE = 'Morning summary';
export const DESIGN = { id: 'obsidian', name: 'Obsidian' };
export const CAPTURE_KEY = 'example-capture-key-4821';
export const MEMORY_CANARY = 'Keeps the spare door code taped under the third drawer of the desk';
export const MEMORY_PART = 'spare door code taped under the third drawer';
export const VAULT_CANARY = 'canary-vault-7c19e04b2d5a';

const at = (minutes: number) => new Date(Date.now() + minutes * 60_000).toISOString();

export function schedule(w: World, name = SCHEDULE) {
  w.runner.schedules.set({ name, cron: '0 7 * * *', prompt: 'Summarize what is on today.' });
  w.facts.schedule = name;
}

export function design(w: World) {
  w.core.design.apply(DESIGN.id, { scope: 'user' });
  w.facts.design = DESIGN.name;
}

// A Screenpipe on this machine, in one of the states on record: wanting its API key (403 until
// it is given, as 0.4 does once its key is on), not running, or a 0.4 that is capturing.
export async function screenpipe(w: World, state: 'needs-key' | 'unreachable' | 'capturing-0.4') {
  const sp = await startFakeScreenpipe();
  w.cleanup.push(() => sp.close());
  if (state === 'needs-key') sp.requireKey(CAPTURE_KEY);
  if (state === 'capturing-0.4') { sp.speaks('0.4'); sp.requireKey(CAPTURE_KEY); }
  const src = w.core.capture.addScreenpipe({ url: sp.base });
  if (state === 'capturing-0.4') w.core.capture.configure(src.id, { api_key: CAPTURE_KEY });
  w.core.capture.enable(src.id, { by: 'person', since: at(-10) });
  if (state === 'capturing-0.4') sp.add({ at: at(-1), type: 'ui', app: 'Editor', window: 'notes.txt', text: 'Example accessibility text from an editor' });
  if (state === 'unreachable') await sp.close();
  await w.core.capture.pull(src.id);
  w.facts.capture = src.id;
  return sp;
}

export function memories(w: World, contents: string[]) {
  for (const content of contents) w.core.memory.remember({ kind: 'fact', content, recorded_by: 'person' });
  w.runner.memory.sync();
}

export function importFile(w: World, name: string, body: unknown) {
  const dir = join(w.home, 'workspace', 'import');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), JSON.stringify(body));
}

// What permissions.md allows without asking.
export function allow(w: World, ids: string[]) {
  writeFileSync(join(w.home, 'permissions.md'), ids.map((id) => `- ${id}: yes`).join('\n') + '\n');
}

export const html = (title: string, body: string) => ({ type: 'text/html; charset=utf-8', body: `<html><head><title>${title}</title></head><body>${body}</body></html>` });
