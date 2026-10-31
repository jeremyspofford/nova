// M10b: vision is a fallback only, and marked as such. A button drawn on a canvas has no DOM element
// and no accessibility node, so neither way finds it; a stand-in locator (Nova ships no vision model)
// finds it in the screenshot, the click lands, and the step's record says it was found by picture,
// as a fallback. The locator is never asked when the DOM finds the element. A point the picture
// gives that is a pay control is refused like any click. Runs where Chromium can start.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { Browser } from '../../src/core/browser/worker.ts';
import { Db } from '../../src/core/db.ts';
import { Log } from '../../src/core/log.ts';
import { ENVELOPE_VERSION, type Brief } from '../../src/core/envelope.ts';
import { chromiumPath } from './support.ts';
import { canBrowse } from './m10b-support.ts';

const PAGE = `<!doctype html><html><body style="margin:0">
<canvas id="c" width="400" height="200" style="display:block"></canvas>
<form method="post" action="/pay"><button type="submit" style="position:absolute;left:0;top:300px;width:200px;height:60px">Pay now</button></form>
<script>
const c = document.getElementById('c'); const g = c.getContext('2d');
g.fillStyle = '#1d4ed8'; g.fillRect(100, 50, 200, 100); g.fillStyle = '#fff'; g.font = '20px sans-serif'; g.fillText('Continue', 160, 105);
c.addEventListener('click', (e) => { if (e.offsetX >= 100 && e.offsetX <= 300 && e.offsetY >= 50 && e.offsetY <= 150) { const p = document.createElement('p'); p.id = 'clicked'; p.textContent = 'Clicked'; document.body.append(p); } });
</script></body></html>`;

test('vision is a fallback only: used when neither the DOM nor the accessibility tree finds the element, and marked', { timeout: 120_000 }, async (t) => {
  const why = await canBrowse();
  if (why) return t.skip(why);
  const hits: string[] = [];
  const site = createServer((req, res) => { hits.push(`${req.method} ${req.url}`); res.writeHead(200, { 'content-type': 'text/html' }); res.end(PAGE); });
  await new Promise<void>((r) => site.listen(0, '127.0.0.1', r));
  const host = `127.0.0.1:${(site.address() as AddressInfo).port}`;
  const asked: string[] = [];
  const db = new Db(':memory:');
  db.migrate();
  const home = mkdtempSync(join(tmpdir(), 'nova-m10b-vision-'));
  let point = { x: 200, y: 100 };
  const browser = new Browser({
    home, log: new Log(db, null), env: { NOVA_CHROMIUM: chromiumPath(), NOVA_CHROMIUM_SANDBOX: '0' },
    // The stand-in vision model: it is told what the step is for, and points.
    locate: async (png, what) => { asked.push(what); assert.ok(png.length > 100, 'it gets a screenshot'); return point; },
  });
  const brief = (id: string, steps: unknown[]): Brief => ({
    envelope: ENVELOPE_VERSION, task_id: id, goal: 'Press the drawn button.', context_refs: [], constraints: {}, privacy_mode: 'local-only', approval_tier: 2,
    evidence_required: [{ kind: 'screenshot' }], idempotency_key: id, inputs: { allowed_hosts: [host], profile: 'fresh', steps },
  });
  try {
    // The DOM finds the canvas itself: no vision.
    const dom = await browser.worker.run(brief('task-vision-0', [{ do: 'navigate', url: `http://${host}/` }, { do: 'click', selector: '#c' }]), new AbortController().signal) as { status: string; summary: string };
    assert.equal(dom.status, 'done', dom.summary);
    assert.deepEqual(asked, [], 'the locator isn’t asked when the DOM finds it');
    // Nothing in the DOM or the accessibility tree is the drawn button.
    const r = await browser.worker.run(brief('task-vision-1', [
      { do: 'navigate', url: `http://${host}/` },
      { do: 'click', target: { role: 'button', name: 'Continue' }, intent: 'press the drawn Continue button', timeout_ms: 800 },
      { do: 'wait', selector: '#clicked' },
    ]), new AbortController().signal) as { status: string; summary: string };
    assert.equal(r.status, 'done', r.summary);
    assert.equal(asked.length, 1);
    assert.match(asked[0]!, /Click the button “Continue”/);
    assert.match(r.summary, /One step found its element by picture, as a fallback/);
    const steps = JSON.parse(readFileSync(join(home, 'workers', 'browser', 'task-vision-1', 'steps.json'), 'utf8'));
    assert.deepEqual(steps.map((s: { via?: string; fallback?: boolean }) => [s.via ?? null, s.fallback ?? false]), [[null, false], ['vision', true], [null, false]]);
    // A point on a pay control is refused like any click.
    point = { x: 100, y: 330 };
    const pay = await browser.worker.run(brief('task-vision-2', [
      { do: 'navigate', url: `http://${host}/` },
      { do: 'click', target: { role: 'button', name: 'Go on' }, timeout_ms: 800 },
    ]), new AbortController().signal) as { status: string; summary: string };
    assert.equal(pay.status, 'failed');
    assert.match(pay.summary, /picture pointed at is a pay control/);
    assert.ok(!hits.some((h) => h.startsWith('POST')), 'nothing was posted');
  } finally {
    await browser.close();
    site.closeAllConnections();
    site.close();
  }
});
