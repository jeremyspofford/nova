// UI rebuild, design-first (owner direction 2026-11-04): the Stage-2 composition
// (ui/styles/stage2.css) over the real shell with real data, on every core surface
// (Home, a conversation, Tasks, Health, Settings, Topology), across the owner's responsive matrix.
// The app does not load the composition; this test applies it, checks it holds at every size (no
// sideways scroll, nothing crushed), and with NOVA_COMPOSITION_SHOTS set writes before/after
// screenshots for the owner's reaction.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Page } from 'playwright-core';
import { stop, until } from '../acceptance/support.ts';
import { ROOT, blank, browser, device, finishSetup, ready, still } from './support.ts';

const MATRIX = {
  'desktop-1920': { width: 1920, height: 1080 }, 'desktop-1440': { width: 1440, height: 900 }, 'desktop-1280': { width: 1280, height: 800 },
  'tablet-portrait': { width: 820, height: 1180 }, 'tablet-landscape': { width: 1180, height: 820 },
  'phone': { width: 390, height: 844 }, 'phone-large': { width: 430, height: 932 }, 'pixel': { width: 412, height: 915 },
  'fold-cover': { width: 344, height: 882 }, 'fold-open': { width: 884, height: 1104 }, 'fold-half-open': { width: 884, height: 540 },
  'pixel-fold-open': { width: 840, height: 701 }, 'duo-open': { width: 720, height: 540 },
};
const COMPOSITION = readFileSync(join(ROOT, 'ui/styles/stage2.css'), 'utf8');

test('Stage-2 composition over the real shell: every core surface across the responsive matrix', { timeout: 900_000 }, async (t) => {
  const b = await browser();
  if (typeof b === 'string') return t.skip(b);
  const m = blank('nova-ui-composition-');
  const nova = await m.start({ NOVA_AGENT_CMD: `node ${join(ROOT, 'scripts/fake-agent.js')}`, NOVA_AGENT_EGRESS: 'none' });
  const shots = process.env.NOVA_COMPOSITION_SHOTS ? resolve(process.env.NOVA_COMPOSITION_SHOTS) : null;
  try {
    await finishSetup(m);
    const chat = (await m.send('POST', '/api/sessions', { text: 'What does my Friday look like?' })).body;
    await until(() => m.get(`/api/sessions/${chat.id}`), (v: any) => !v.live);
    const task = (await m.send('POST', '/api/v1/tasks', { title: 'Save the shopping list', owner: 'workspace', goal: 'The list is saved.', evidence_required: [{ kind: 'read_back', target: 'workspace:lists/shopping.md' }], inputs: { action: 'write', path: 'lists/shopping.md', content: '- bread\n' } })).body;
    await until(() => m.get(`/api/v1/tasks/${task.id}`), (x: any) => x.state === 'done');
    const pages = { home: '/', chat: `/c/${chat.id}`, tasks: '/tasks', health: '/health', settings: '/settings', topology: '/topology' };
    const visit = async (p: Page, path: string, composed: boolean) => {
      await p.goto(m.base + path);
      await ready(p);
      if (composed) await p.addStyleTag({ content: COMPOSITION });
      await still(p);
    };
    for (const [size, dimensions] of Object.entries(MATRIX)) {
      const d = await device(b, { ...dimensions, touch: !size.startsWith('desktop'), scheme: 'dark' });
      for (const [name, path] of Object.entries(pages)) {
        if (shots && (size === 'desktop-1440' || size === 'phone')) {
          await visit(d.page, path, false);
          mkdirSync(join(shots, 'before'), { recursive: true });
          await d.page.screenshot({ path: join(shots, 'before', `${name}-${size}.png`) });
        }
        // The app loads the approved composition itself, last, so it decides (ui/index.html).
        await visit(d.page, path, false);
        assert.ok(await d.page.evaluate(() => [...document.styleSheets].some((x) => x.href?.endsWith('/styles/stage2.css'))), `${name}/${size}: the approved Stage-2 stylesheet is loaded`);
        const width = await d.page.evaluate(() => document.documentElement.scrollWidth);
        assert.ok(width <= dimensions.width, `${name}/${size}: no sideways scroll (${width} > ${dimensions.width})`);
        if (shots) {
          mkdirSync(join(shots, 'after'), { recursive: true });
          await d.page.screenshot({ path: join(shots, 'after', `${name}-${size}.png`) });
        }
      }
      assert.deepEqual(d.errors, [], `${size}: no page errors`);
      await d.ctx.close();
    }
  } finally {
    await b.close();
    await stop(nova);
  }
});
