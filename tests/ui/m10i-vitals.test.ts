import { test } from 'node:test';
import assert from 'node:assert/strict';
import { browser, device, ready } from './support.ts';
import { topologyFixture } from './m10i-support.ts';
import { observe, compute, p75 } from './vitals-support.ts';

const RUNS = Number(process.env.NOVA_VITALS_RUNS ?? 12);
test('M10i: topology p75 LCP ≤ 2500ms, INP ≤ 200ms, CLS ≤ 0.1 with real drill-in and sheet input', { timeout: 300_000 }, async (t) => {
  const b = await browser(); if (typeof b === 'string') return t.skip(b);
  const f = await topologyFixture();
  const rows = ['| View | Width | Runs | LCP p75 | INP p75 | CLS p75 | Interactions |', '| --- | --- | --- | --- | --- | --- | --- |'];
  try {
    for (const [size, vp] of [['phone', { width: 390, height: 844, touch: true }], ['desktop', { width: 1440, height: 900 }]] as const) {
      const runs: ReturnType<typeof compute>[] = [];
      for (let i = 0; i < RUNS; i++) {
        const d = await device(b, { ...vp, serviceWorkers: 'block' }); const p = d.page;
        if (size === 'phone') await (await d.ctx.newCDPSession(p)).send('Emulation.setCPUThrottlingRate', { rate: 4 });
        await d.ctx.addInitScript(observe); await p.goto(`${f.base}/topology`); await ready(p); await p.locator('[data-topology-machine]').first().waitFor(); await p.waitForTimeout(500);
        const press = async (sel: string) => { if (size === 'phone') await p.locator(sel).tap(); else await p.locator(sel).click(); };
        await press(`[data-topology-machine="${f.hubId}"]`); await press(`[data-topology-service="${f.hubId}/privileged"]`);
        await press('[data-topology-action="promote"]'); await p.locator('.approval-sheet[data-tier="3"]').waitFor();
        await press('[name="confirm"]'); await p.keyboard.press('Escape');
        await press('[data-topology-back]'); await press('[data-topology-back]');
        await p.waitForTimeout(300); const result = await p.evaluate(compute); runs.push(result);
        assert.ok(result.interactions >= 2, `${size}: trusted interactions were observed`); assert.ok(result.lcp > 0, 'LCP was observed'); assert.deepEqual(d.errors, []); await d.ctx.close();
      }
      const result = { lcp: p75(runs.map(r => r.lcp)), inp: p75(runs.map(r => r.inp)), cls: p75(runs.map(r => r.cls)) };
      rows.push(`| topology | ${size} ${vp.width}×${vp.height}${size === 'phone' ? ', CPU 4×' : ''} | ${RUNS} | ${Math.round(result.lcp)} ms | ${Math.round(result.inp)} ms | ${result.cls.toFixed(3)} | ${Math.min(...runs.map(r => r.interactions))}–${Math.max(...runs.map(r => r.interactions))} |`);
      assert.ok(result.lcp <= 2500, `${size}: LCP ${result.lcp}`); assert.ok(result.inp <= 200, `${size}: INP ${result.inp}`); assert.ok(result.cls <= 0.1, `${size}: CLS ${result.cls}`);
    }
    console.log(rows.join('\n'));
  } finally { await b.close(); await f.close(); }
});
