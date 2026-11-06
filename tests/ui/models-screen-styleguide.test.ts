// The per-device Models screen, design-first (owner direction 2026-11-04; ADR
// docs/plans/model-fit-adr-2026-11-04.md, step 3): the styleguide composition only, across the
// owner's responsive matrix (desktop, iPad, phones, foldables folded, open and half-open), in
// Chromium and WebKit. The verdicts and numbers on the page are the real fit engine's, and this test
// checks them against fit.ts itself. Demo only: the specimen installs nothing and makes no requests.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Browser, Page } from 'playwright-core';
import { browser, webkitBrowser, device, still, ROOT } from './support.ts';
import { createNova } from '../../src/server.js';
import { loadConfig } from '../../src/config.js';
import { ensureMark } from '../../src/core/resilience/home-mark.ts';
import { GiB, PRIOR_OVERHEAD_BYTES, fit } from '../../src/core/models/fit.ts';

const STATES = ['3090-one-model', '3090-two-models', '8gb-nothing-at-16k', 'mac-16gb-unified', 'unknown-shape', 'no-gpu', 'asleep', 'install-confirm'];
// The owner's matrix: desktop bands, iPad-class, phones, and the foldables' postures.
const MATRIX = {
  'desktop-1920': { width: 1920, height: 1080 }, 'desktop-1440': { width: 1440, height: 900 }, 'desktop-1280': { width: 1280, height: 800 },
  'tablet-portrait': { width: 820, height: 1180 }, 'tablet-landscape': { width: 1180, height: 820 },
  'phone': { width: 390, height: 844 }, 'phone-large': { width: 430, height: 932 }, 'pixel': { width: 412, height: 915 },
  'fold-cover': { width: 344, height: 882 }, 'fold-open': { width: 884, height: 1104 }, 'fold-half-open': { width: 884, height: 540 },
  'pixel-fold-open': { width: 840, height: 701 }, 'duo-open': { width: 720, height: 540 },
};
const gb = (b: number) => `${(b / GiB).toFixed(1)} GB`;

// ADR golden case 2 through fit.ts itself: 8B at Q4_K_M with 16k context on an 8 GB card.
const golden8gb = fit({
  device: { memory: 'gpu', budget_bytes: 8 * GiB, other_use_bytes: 0, other_use_known: true, overhead_bytes: PRIOR_OVERHEAD_BYTES, overhead_source: 'prior' },
  models: [{ name: 'qwen3:8b', params: 8_200_000_000, weights_bytes: null, quant: 'Q4_K_M', context: 16384, arch: { layers: 36, kv_heads: 8, head_dim: 128 }, arch_source: 'catalog', kv_type: 'f16' }],
});

async function fixture(run: (base: string) => Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), 'nova-models-styleguide-'));
  chmodSync(dir, 0o700);
  let nova: ReturnType<typeof createNova> | undefined;
  try {
    const home = join(dir, 'nova');
    const user = join(dir, 'user');
    mkdirSync(user, { mode: 0o700 });
    ensureMark(home, { userHome: user });
    nova = createNova(loadConfig({ HOME: user, NOVA_HOME: home, NOVA_HOST: '127.0.0.1', NOVA_PORT: '0', NOVA_VAULT_KEY: 'file', NOVA_AGENT_CMD: '/bin/false', NOVA_AGENT_EGRESS: 'none' }));
    const server = nova.server;
    await new Promise<void>((done, fail) => { server.once('error', fail); server.listen(0, '127.0.0.1', done); });
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    if (nova) {
      nova.scheduler.stop();
      nova.server.closeAllConnections();
      if (nova.server.listening) await new Promise<void>((done) => nova!.server.close(() => done()));
      await nova.core.close();
    }
    rmSync(dir, { recursive: true, force: true });
  }
}

async function padded(page: Page, selector: string, path: string) {
  const r = await page.evaluate((sel) => { const b = document.querySelector(sel)!.getBoundingClientRect(); return { x: b.left + scrollX, y: b.top + scrollY, w: b.width, h: b.height, vw: document.documentElement.clientWidth }; }, selector);
  const x = Math.max(0, r.x - 16), y = Math.max(0, r.y - 16);
  await page.screenshot({ path, animations: 'disabled', caret: 'hide', fullPage: true, clip: { x, y, width: Math.min(r.vw - x, r.w + 32), height: r.h + 32 } });
}
async function geometry(page: Page, label: string) {
  const width = page.viewportSize()!.width;
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth) <= width, `${label}: no horizontal scroll`);
  // Each check queries the live page and measures in the same task (page.evaluate). A locator's
  // evaluate or evaluateAll first finds its elements, then runs the function in a second step; a
  // redraw in between (the styleguide's whole page when the appearance arrives, a device's screen when
  // its models refresh) hands the function nodes no longer in the page: no size and no labels.
  const root = '#sg-models-screen';
  assert.deepEqual(await page.evaluate((sel) => [...document.querySelector(sel)!.querySelectorAll<HTMLElement>('button, label, p, h3, h4, h5, .fit-verdict, .fit-what, .fit-gb, .dm-out, .settings-label')].filter((el) => el.clientWidth && el.scrollWidth > el.clientWidth + 1).map((el) => el.textContent), root), [], `${label}: clipped text`);
  assert.deepEqual(await page.evaluate((sel) => { const r = document.querySelector(sel)!; const box = r.querySelector('[data-device-models]')!.getBoundingClientRect(); return [...r.querySelectorAll<HTMLElement>('[data-device-models] *')].filter((el) => { const b = el.getBoundingClientRect(); return b.width && (b.right > box.right + 1 || b.left < box.left - 1); }).map((el) => el.className || el.tagName); }, root), [], `${label}: nothing spills out of the panel`);
  assert.deepEqual(await page.evaluate((sel) => [...document.querySelectorAll<HTMLElement>(`${sel} button, ${sel} select, ${sel} input`)].filter((e) => !(e as HTMLInputElement).disabled && e.getBoundingClientRect().height < 44).map((e) => e.outerHTML.slice(0, 80)), root), [], `${label}: 44px targets`);
  assert.deepEqual(await page.evaluate((sel) => [...document.querySelectorAll<HTMLInputElement>(`${sel} select, ${sel} input`)].filter((e) => !e.labels?.length).map((e) => e.outerHTML.slice(0, 80)), root), [], `${label}: every control is labelled`);
  const ids = await page.evaluate(() => [...document.querySelectorAll('[id]')].map((e) => e.id));
  assert.equal(new Set(ids).size, ids.length, `${label}: duplicate ids`);
}

// What each state must say: its verdicts, and the rule it demonstrates.
async function stateChecks(page: Page, s: string, label: string) {
  const root = page.locator('#sg-models-screen [data-device-models]');
  const text = await root.innerText();
  const verdicts = async (sel: string) => root.locator(`${sel} .fit-verdict`).evaluateAll((els) => els.map((e) => e.getAttribute('data-verdict')));
  // The bar has a text equivalent: its label is the total, and every segment is a legend row in words and numbers.
  const bar = root.locator('.fit-bar[role="img"]');
  assert.equal(await bar.count(), 1, `${label}: one budget bar`);
  const total = await page.locator(`#${await bar.getAttribute('aria-labelledby')}`).innerText();
  assert.match(total, /\d+\.\d GB/, `${label}: the bar is labelled with its numbers`);
  const segs = await root.locator('.fit-seg').count();
  const rows = await root.locator('.fit-legend-row:not(.is-over)').evaluateAll((els) => els.map((e) => (e as HTMLElement).innerText));
  assert.equal(rows.length, segs, `${label}: one legend row per bar segment`);
  for (const r of rows) assert.match(r, /[A-Za-z].*\d+\.\d GB/s, `${label}: a legend row says what and how much: ${r}`);
  assert.match(text, /Runtime overhead\s*(measured from \d+ loads? on this device|Nova’s estimate)/, `${label}: the overhead says learned or estimated`);
  assert.match(text, /Safety reserve/);
  if (s === '3090-one-model') {
    assert.deepEqual(await verdicts('.dm-total-row'), ['fits']);
    assert.match(text, /Fits comfortably at Q8_0 with 16k context\./);
    assert.match(text, /Fits comfortably up to \d+k context at Q8_0\./, `${label}: fits up to N context`);
    assert.match(text, /measured from 3 loads/);
    assert.match(text, /one GPU’s own memory/);
  }
  if (s === '3090-two-models') {
    assert.deepEqual(await verdicts('.dm-model'), ['tight', 'fits'], `${label}: each model on its own`);
    assert.equal(await root.locator('[data-together="tight"]').count(), 1, `${label}: both stay loaded together, tight`);
    assert.match(text, /Both stay loaded together, but it’s tight/);
  }
  if (s === '8gb-nothing-at-16k') {
    assert.deepEqual(await verdicts('.dm-model'), ['wont-fit']);
    assert.match(total, new RegExp(`${gb(golden8gb.need_bytes)} needed, ${gb(-golden8gb.headroom_bytes)} more than the 8.0 GB budget`), `${label}: the numbers are fit.ts's (ADR case 2)`);
    assert.match(text, /Won’t fit at Q4_K_M with 16k context\. At Q4_K_M it fits up to 6k\./);
    assert.match(await root.locator('[data-task="coding"]').innerText(), /Nothing here fits at 16k context\. qwen3:8b at Q4_K_M fits up to 6k\. Under local only, the work waits/);
    assert.equal(await root.locator('[data-action="models-install"]').isDisabled(), true, `${label}: a plan that won't fit can't be installed`);
    assert.equal(await root.locator('.fit-limit').count(), 1, `${label}: the budget's end is marked`);
  }
  if (s === 'mac-16gb-unified') {
    assert.match(text, /Budget: 10\.7 GB, the share of this Mac’s 16\.0 GB unified memory/);
    assert.match(text, /can’t see what else is using this memory/);
    assert.match(text, /Local first\./);
    // Local first: local picks come first, the cloud option after them, without a verdict.
    const order = await root.evaluate((r) => { const all = [...r.querySelectorAll('.dm-pick, [data-cloud]')]; return all.map((e) => (e.matches('[data-cloud]') ? 'cloud' : 'local')); });
    assert.equal(order.at(-1), 'cloud', `${label}: cloud is listed after every local pick`);
    assert.equal(await root.locator('[data-cloud] .fit-verdict').count(), 0, 'a cloud option has no fit verdict');
    assert.match(await root.locator('[data-cloud]').innerText(), /Runs off your devices/);
  } else {
    // Local only: no cloud option is drawn or named at all.
    assert.equal(await root.locator('[data-cloud]').count(), 0, `${label}: no cloud list under local only`);
    assert.doesNotMatch(text, /cloud model|off your devices/i, `${label}: no cloud option is mentioned`);
    assert.match(text, /Local only\./);
  }
  if (s === 'unknown-shape') {
    assert.match(text, /Estimate: Nova doesn’t know this model’s shape\./, `${label}: labelled as an estimate`);
    assert.ok(await root.locator('.dm-model .dm-estimate').count() >= 1);
    assert.match(text, /KV cache for 8k tokens, estimated/);
  }
  if (s === 'no-gpu') {
    assert.match(text, /No GPU found\./);
    assert.match(text, /It runs on the CPU, slow\./);
    assert.match(await root.locator('[data-task="screening"]').innerText(), /qwen3/, `${label}: the hub screens`);
  }
  if (s === 'asleep') {
    assert.equal(await root.locator('[data-asleep]').count(), 1, `${label}: an asleep device says so`);
    assert.match(await root.locator('[data-asleep]').innerText(), /Asleep\s+Last seen 3 h ago\. What shows here is what it last reported/, `${label}: stamped with its age`);
  }
  if (s === 'install-confirm') {
    assert.equal(await root.locator('[data-models-confirm]').count(), 1, `${label}: Install and assign asks first`);
    assert.equal(await root.locator('[data-action="models-install"]').count(), 0, `${label}: the ask takes the button's place`);
    assert.match(await root.locator('[data-models-confirm]').innerText(), /about 14\.6 GB, downloads to Study desktop, then serves thinking and writing/);
    assert.equal(await root.locator('.btn.primary').count(), 1, `${label}: one standout`);
  }
}

// The controls recompute with the engine: the 8 GB card's model fits once its context comes down,
// and a pick can be planned beside it. Nothing is installed.
async function interact(page: Page, label: string) {
  const root = page.locator('#sg-models-screen');
  await root.locator('#models-state').selectOption('8gb-nothing-at-16k');
  await root.locator('[data-models-specimen="8gb-nothing-at-16k"]').waitFor();
  const range = root.locator('[data-models-context="0"]');
  await range.fill('1');
  await root.locator('[data-models-specimen] .dm-model .fit-verdict[data-verdict="fits"]').waitFor();
  assert.match(await root.locator('.dm-model .dm-words').innerText(), /Fits comfortably at Q4_K_M with 4k context\./, `${label}: the context control recomputes`);
  assert.match(await root.locator('[data-models-demo-notice]').innerText(), /Recomputed by the fit engine/);
  assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('data-models-context')), '0', `${label}: focus stays on the control`);
  await root.locator('[data-models-quant="0"]').selectOption('Q8_0');
  await root.locator('.dm-model .fit-verdict[data-verdict="wont-fit"]').waitFor();
  await root.locator('[data-models-quant="0"]').selectOption('Q4_K_M');
  await root.locator('[data-task="embeddings"] [data-action="models-plan"]').click();
  assert.equal(await root.locator('.dm-model').count(), 2, `${label}: a pick joins the plan`);
  assert.equal(await root.locator('.dm-together').count(), 1, `${label}: two models say whether they stay loaded together`);
  await root.locator('[data-action="models-install"]').click();
  assert.match(await root.locator('[data-models-demo-notice]').innerText(), /Demo only\. Nothing was installed or assigned\./);
  await root.locator('[data-action="models-remove"][data-index="1"]').click();
  assert.equal(await root.locator('.dm-together').count(), 0);
  await root.locator('[data-action="models-remove"][data-index="0"]').click();
  assert.match(await root.innerText(), /Nothing is planned here yet/);
  assert.equal(await root.locator('.fit-bar').count(), 0, 'no plan, no bar');
  await geometry(page, `${label}/interacted`);
}

for (const [engine, launch] of [['chromium', browser], ['webkit', webkitBrowser]] as const) {
  test(`Models screen ${engine}: every state across the responsive matrix; the engine's numbers; demo-only and accessible`, { timeout: 900_000 }, async () => {
    let b: Browser | undefined;
    try {
      const launched = await launch();
      assert.notEqual(typeof launched, 'string', 'a browser is required');
      b = launched as Browser;
      await fixture(async (base) => {
        for (const [size, dimensions] of Object.entries(MATRIX)) {
          const d = await device(b!, { ...dimensions, touch: !size.startsWith('desktop'), scheme: 'dark', serviceWorkers: 'block' });
          const p = d.page;
          const changes: string[] = [];
          p.on('request', (r) => { if (!['GET', 'HEAD'].includes(r.method())) changes.push(`${r.method()} ${r.url()}`); });
          await p.goto(`${base}/styleguide?entry=models-screen`);
          await p.waitForLoadState('load');
          await p.locator('[data-models-specimen]').waitFor();
          assert.equal(await p.getByRole('heading', { name: 'Models on a device (proposed)', exact: true }).count(), 1);
          // Once the page has loaded, the specimen asks for nothing at all.
          const after: string[] = [];
          p.on('request', (r) => after.push(`${r.method()} ${r.url()}`));
          for (const s of STATES) {
            await p.locator('#models-state').selectOption(s);
            await p.locator(`[data-models-specimen="${s}"]`).waitFor();
            const label = `${engine}/${size}/${s}`;
            await stateChecks(p, s, label);
            await geometry(p, label);
            if (process.env.NOVA_MODELS_STYLEGUIDE_SHOTS) {
              const folder = resolve(process.env.NOVA_MODELS_STYLEGUIDE_SHOTS, engine);
              mkdirSync(folder, { recursive: true });
              await p.mouse.move(0, 0);
              await padded(p, '#sg-models-screen [data-models-content]', join(folder, `${s}-${size}.png`));
            }
            if (size === 'phone' || size === 'desktop-1440' || size === 'fold-cover') {
              await still(p);
              if (!await p.evaluate(() => 'axe' in window)) await p.addScriptTag({ content: readFileSync(join(ROOT, 'node_modules/axe-core/axe.min.js'), 'utf8') });
              const axe = await p.evaluate(async () => (window as any).axe.run(document.querySelector('#sg-models-screen')));
              assert.deepEqual(axe.violations.map((v: { id: string; nodes: { target: string[] }[] }) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`), [], `${label}: axe`);
            }
          }
          if (size === 'phone' || size === 'desktop-1440') await interact(p, `${engine}/${size}`);
          assert.deepEqual(after, [], 'the specimen makes no requests');
          assert.deepEqual(changes, [], 'the specimen changes nothing');
          assert.deepEqual(d.errors, []);
          await d.ctx.close();
        }
      });
    } finally { await b?.close(); }
  });
}
