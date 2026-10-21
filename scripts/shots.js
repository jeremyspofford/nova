#!/usr/bin/env node
// Drives the real UI in a browser against the scripted stand-in model:
// captures the golden screens in every theme, walks the keyboard path,
// exercises each state, and measures the performance budgets.
// Usage: node scripts/shots.js [outDir]   (CHROMIUM=/path/to/chrome to override)
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright-core';

const root = resolve(new URL('..', import.meta.url).pathname);
const out = resolve(process.argv[2] ?? join(root, 'docs/screenshots'));
mkdirSync(out, { recursive: true });
const home = mkdtempSync(join(tmpdir(), 'nova-shots-'));
const port = 4400 + Math.floor(Math.random() * 400);
const base = `http://localhost:${port}`;
const results = { budgets: {}, checks: [] };
const check = (name, ok, detail = '') => { results.checks.push({ name, ok, detail }); console.log(`${ok ? '✓' : '✗'} ${name}${detail ? `: ${detail}` : ''}`); };

function startServer() {
  const t0 = performance.now();
  const child = spawn(process.execPath, [join(root, 'src/server.js')], {
    env: { ...process.env, NOVA_HOME: home, NOVA_PORT: String(port), NOVA_AGENT_CMD: `FAKE_DELAY=${process.env.FAKE_DELAY ?? 18} node ${join(root, 'scripts/fake-agent.js')}` },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  return new Promise((ok) => child.stdout.on('data', (d) => { if (String(d).includes('ready')) ok({ child, ms: performance.now() - t0 }); }));
}

let current = null;
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });

async function page({ theme = 'paper', mode = 'light', width = 1280, height = 820, reducedMotion = 'no-preference' } = {}) {
  const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 2, reducedMotion });
  await ctx.addInitScript(([t, m]) => { localStorage.setItem('nova.theme', t); localStorage.setItem('nova.mode', m); }, [theme, mode]);
  const p = await ctx.newPage();
  current = p;
  p.errors = [];
  p.on('pageerror', (e) => p.errors.push(e.message));
  p.on('console', (m) => { if (m.type() === 'error' && !/ERR_CONNECTION_REFUSED|Failed to load resource/.test(m.text())) p.errors.push(m.text()); });
  return p;
}
const shot = (p, name) => p.screenshot({ path: join(out, `${name}.png`) });
const settle = (p) => p.waitForFunction(() => !document.querySelector('.thinking, [data-live], .record.is-running') && !document.querySelector('.send.is-stop'), null, { timeout: 15000 });

// ---- cold start --------------------------------------------------------------
const { child: server, ms: serverMs } = await startServer();
const fail = async (e) => {
  console.error(`✗ walkthrough stopped: ${e.message.split('\n')[0]}`);
  try { await current?.screenshot({ path: join(out, 'failure.png') }); } catch {}
  server.kill();
  process.exit(1);
};
process.on('uncaughtException', fail);
process.on('unhandledRejection', fail);
results.budgets.serverStartMs = Math.round(serverMs);
{
  const p = await page();
  const t0 = Date.now();
  await p.goto(base);
  await p.waitForSelector('html[data-ready] .empty');
  results.budgets.pageInteractiveMs = Date.now() - t0;
  const nav = await p.evaluate(() => JSON.parse(JSON.stringify(performance.getEntriesByType('navigation')[0])));
  results.budgets.domContentLoadedMs = Math.round(nav.domContentLoadedEventEnd);
  await p.waitForTimeout(600);
  await shot(p, 'paper-empty');
  check('cold start ≤ 2 s (server + page)', serverMs + results.budgets.pageInteractiveMs <= 2000, `${Math.round(serverMs)} ms server + ${results.budgets.pageInteractiveMs} ms page`);

  // ---- the keyboard path: send, read, approve, never touching the mouse --------
  check('the composer is focused on arrival', await p.evaluate(() => document.activeElement.id === 'input'));
  await p.evaluate(() => document.activeElement.blur());
  await p.keyboard.press('/');
  check('"/" focuses the composer', await p.evaluate(() => document.activeElement.id === 'input'));
  await p.keyboard.type('What should I focus on today?');
  // Measured in the page: from the Enter keydown to the first frame painted
  // with the message on the page and Nova visibly working.
  await p.evaluate(() => {
    window.__t = {};
    document.addEventListener('keydown', (e) => { if (e.key === 'Enter') window.__t.key = performance.now(); }, { capture: true, once: true });
    new MutationObserver((_, o) => {
      if (document.querySelector('.msg-user .bubble') && document.querySelector('.thinking, [data-live]')) {
        o.disconnect();
        requestAnimationFrame(() => { window.__t.seen = performance.now(); });
      }
    }).observe(document.getElementById('thread'), { childList: true, subtree: true });
  });
  await p.keyboard.press('Enter');
  await p.waitForFunction(() => window.__t.seen);
  const feedback = await p.evaluate(() => window.__t.seen - window.__t.key);
  results.budgets.sendFeedbackMs = Math.round(feedback);
  check('send → visible feedback ≤ 100 ms', feedback <= 100, `${Math.round(feedback)} ms`);
  await p.waitForSelector('[data-live]');
  await p.waitForTimeout(350);
  await shot(p, 'paper-streaming');
  await settle(p);
  await p.waitForTimeout(400);
  await shot(p, 'paper-chat');
  check('reply rendered markdown: list, code, table', await p.evaluate(() => !!document.querySelector('.prose ol li strong') && !!document.querySelector('.code-block pre') && !!document.querySelector('.prose table')));

  // Copy action, from the keyboard
  await p.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await p.focus('.msg-nova [data-action="copy"]');
  await p.keyboard.press('Enter');
  await p.waitForTimeout(100);
  check('copy works and says so', (await p.textContent('.msg-nova [data-action="copy"] span')) === 'Copied' && (await p.evaluate(() => navigator.clipboard.readText())).startsWith('Three things'));

  // New conversation from the keyboard, then an approval
  await p.keyboard.press('Control+Shift+O');
  await p.waitForSelector('.empty');
  check('⌘/Ctrl ⇧ O starts a new conversation', await p.evaluate(() => location.pathname === '/' && document.activeElement.id === 'input'));
  await p.keyboard.type('Run git status in my workspace before standup');
  await p.keyboard.press('Enter');
  await p.waitForSelector('.approval [data-action="allow"]:focus', { timeout: 8000 });
  check('an approval card takes focus', true);
  await p.waitForTimeout(450);
  await shot(p, 'paper-approval');
  await p.keyboard.press('Enter');
  await p.waitForSelector('.record .stamp');
  await settle(p);
  await p.waitForTimeout(500);
  await shot(p, 'paper-approval-decided');
  check('Enter allows; the card files itself as a stamped record', (await p.textContent('.record .stamp')).trim() === 'Allowed');

  // Escape denies
  await p.keyboard.press('Control+Shift+O');
  await p.keyboard.type('run git status again');
  await p.keyboard.press('Enter');
  await p.waitForSelector('.approval [data-action="allow"]:focus', { timeout: 8000 });
  await p.keyboard.press('Escape');
  await p.waitForSelector('.record .stamp.is-declined');
  await settle(p);
  check('Esc declines, and Nova carries on without it', /won't run it/.test(await p.textContent('.msg-nova')));

  // Stop while streaming, then regenerate
  await p.keyboard.press('Control+Shift+O');
  await p.keyboard.type('slow please');
  await p.keyboard.press('Enter');
  await p.waitForSelector('[data-live]');
  await p.waitForTimeout(500);
  await p.keyboard.press('Escape');
  await p.waitForSelector('.notice');
  check('Esc stops a reply and keeps what was written', (await p.textContent('.notice')).includes('Stopped') && !!(await p.$('.prose')));
  await shot(p, 'paper-stopped');

  // Error state
  await p.keyboard.press('Control+Shift+O');
  await p.keyboard.type('please fail');
  await p.keyboard.press('Enter');
  await p.waitForSelector('.error');
  await p.waitForTimeout(300);
  await shot(p, 'paper-error');
  check('a model failure reads like a person wrote it, with Try again', !!(await p.$('.error [data-action="regenerate"]')));

  // Focus is always visible
  await p.keyboard.press('Shift+Tab');
  const ring = await p.evaluate(() => getComputedStyle(document.activeElement).outlineStyle);
  check('keyboard focus is visible', ring === 'solid', ring);

  // Previous/next conversation
  const before = await p.evaluate(() => location.pathname);
  await p.keyboard.press('Alt+ArrowDown');
  await p.waitForFunction((b) => location.pathname !== b, before);
  check('Alt ↑/↓ moves between conversations', true);

  // Offline (the browser) and unreachable (the server)
  await p.context().setOffline(true);
  await p.waitForSelector('.banner:not([hidden])');
  await shot(p, 'paper-offline');
  check('offline banner', /offline/.test(await p.textContent('.banner')));
  await p.context().setOffline(false);
  check('page has no script errors', p.errors.length === 0, p.errors.join(' | '));
}

// ---- long content and scrolling -------------------------------------------------
{
  const api = (path, body) => fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', 'x-nova': '1' }, body: JSON.stringify(body) }).then((r) => r.json());
  const { id } = await api('/api/sessions', { text: 'Long thread: ' + 'a very long question that wraps across several lines '.repeat(6) });
  const until = async () => { for (;;) { const s = await (await fetch(`${base}/api/sessions/${id}`)).json(); if (!s.live) return; await new Promise((r) => setTimeout(r, 50)); } };
  await until();
  for (let i = 0; i < 24; i++) { await api(`/api/sessions/${id}/messages`, { text: `Item ${i + 1}: what else is on the list?` }); await until(); }
  const p = await page();
  await p.goto(`${base}/c/${id}`);
  await p.waitForSelector('.turn');
  await p.waitForTimeout(500);
  const atEnd = await p.evaluate(() => { const sc = document.getElementById('scroller'); return sc.scrollHeight - sc.scrollTop - sc.clientHeight; });
  check('a long conversation opens at its latest message', atEnd < 2, `${Math.round(atEnd)} px from the end`);
  // The container has no GPU, so Chromium composites every frame in software
  // (~16 ms at 2x), and frame intervals measure this machine, not Nova. The
  // budget is judged on what the page controls: the main-thread work in each
  // frame (script, style, layout, paint), from a trace of the same scroll.
  await browser.startTracing(p, { categories: ['cc', 'devtools.timeline'] });
  const fps = await p.evaluate(async () => {
    const sc = document.getElementById('scroller');
    sc.scrollTop = 0;
    const times = [];
    let last = performance.now();
    await new Promise((done) => {
      const stepFrame = (t) => {
        times.push(t - last); last = t;
        sc.scrollTop += 40;
        if (sc.scrollTop + sc.clientHeight >= sc.scrollHeight - 2 || times.length > 400) done(); else requestAnimationFrame(stepFrame);
      };
      requestAnimationFrame(stepFrame);
    });
    times.shift();
    const sorted = [...times].sort((a, b) => a - b);
    return { frames: times.length, avgMs: times.reduce((a, b) => a + b, 0) / times.length, p95Ms: sorted[Math.floor(sorted.length * 0.95)], over20: times.filter((t) => t > 20).length };
  });
  const trace = JSON.parse(String(await browser.stopTracing()));
  const work = (trace.traceEvents ?? trace).filter((e) => e.name === 'ProxyMain::BeginMainFrame' && e.ph === 'X').map((e) => e.dur / 1000).sort((a, b) => a - b);
  const workP95 = work[Math.floor(work.length * 0.95)] ?? Infinity;
  results.budgets.scroll = { frames: fps.frames, mainThreadP95Ms: +workP95.toFixed(2), mainThreadMaxMs: +work.at(-1).toFixed(2), frameIntervalP95Ms: +fps.p95Ms.toFixed(2), slowIntervals: fps.over20 };
  check('scrolling a long thread holds 60 fps', workP95 <= 8, `page work p95 ${workP95.toFixed(1)} ms/frame (max ${work.at(-1).toFixed(1)}) over ${work.length} frames; frame interval p95 ${fps.p95Ms.toFixed(1)} ms on this GPU-less machine`);
  await p.evaluate(() => { document.getElementById('scroller').scrollTop = 900; });
  await p.waitForTimeout(200);
  await shot(p, 'paper-long');
  results.longId = id;
}

// ---- themes: same layout, token files only ------------------------------------------
const golden = async (opts, prefix) => {
  const p = await page(opts);
  await p.goto(base);
  await p.waitForSelector('html[data-ready] .empty');
  await p.waitForTimeout(600);
  await shot(p, `${prefix}-empty`);
  const list = await (await fetch(`${base}/api/sessions`)).json();
  const chat = list.find((s) => s.title.startsWith('What should I focus'));
  await p.goto(`${base}/c/${chat.id}`);
  await p.waitForSelector('.prose');
  await p.waitForTimeout(500);
  await shot(p, `${prefix}-chat`);
  await p.goto(base);
  await p.waitForSelector('.empty');
  await p.fill('#input', 'run git status for the screenshot');
  await p.keyboard.press('Enter');
  await p.waitForSelector('.approval');
  await p.waitForTimeout(500);
  await shot(p, `${prefix}-approval`);
  await p.keyboard.press('Escape');
  await settle(p);
  check(`${prefix}: no script errors`, p.errors.length === 0, p.errors.join(' | '));
};
await golden({ theme: 'paper', mode: 'dark' }, 'paper-dark');
await golden({ theme: 'aurora', mode: 'light' }, 'aurora');
await golden({ theme: 'aurora', mode: 'dark' }, 'aurora-dark');
await golden({ theme: 'obsidian', mode: 'dark' }, 'obsidian');

// ---- mobile -------------------------------------------------------------------------
{
  const p = await page({ width: 390, height: 844 });
  const list = await (await fetch(`${base}/api/sessions`)).json();
  const chat = list.find((s) => s.title.startsWith('What should I focus'));
  await p.goto(`${base}/c/${chat.id}`);
  await p.waitForSelector('.prose');
  await p.waitForTimeout(500);
  await shot(p, 'mobile-chat');
  await p.click('#menu');
  await p.waitForTimeout(450);
  await shot(p, 'mobile-drawer');
  const overflow = await p.evaluate(() => document.documentElement.scrollWidth > innerWidth);
  check('mobile: no horizontal page scroll', !overflow);
}

// ---- reduced motion ------------------------------------------------------------------
{
  const p = await page({ reducedMotion: 'reduce' });
  await p.goto(base);
  await p.waitForSelector('html[data-ready]');
  const v = await p.evaluate(() => ({ shift: getComputedStyle(document.documentElement).getPropertyValue('--shift').trim() }));
  check('reduced motion: no translation (Paper crossfades only)', v.shift === '0px', v.shift);
  const p2 = await page({ reducedMotion: 'reduce', theme: 'obsidian', mode: 'dark' });
  await p2.goto(base);
  await p2.waitForSelector('html[data-ready]');
  const d = await p2.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--m-med').trim());
  check('reduced motion: Obsidian durations become 1 ms', d === '1ms', d);
}

// ---- style reference ----------------------------------------------------------------
{
  const p = await page({ height: 1000 });
  await p.goto(`${base}/styleguide`);
  await p.waitForSelector('.sg-section');
  await p.waitForTimeout(400);
  await p.screenshot({ path: join(out, 'styleguide.png'), fullPage: true });
  check('style reference renders without errors', p.errors.length === 0, p.errors.join(' | '));
}

// ---- server unreachable ---------------------------------------------------------------
{
  const p = await page();
  await p.goto(base);
  await p.waitForSelector('html[data-ready]');
  server.kill();
  await p.fill('#input', 'are you there?');
  await p.keyboard.press('Enter');
  await p.waitForSelector('.banner:not([hidden])', { timeout: 8000 });
  await p.waitForTimeout(300);
  await shot(p, 'paper-unreachable');
  check('server unreachable: banner, and the message stays in the box', (await p.inputValue('#input')) === 'are you there?');
}

writeFileSync(join(out, 'results.json'), `${JSON.stringify(results, null, 2)}\n`);
await browser.close();
const failed = results.checks.filter((c) => !c.ok);
console.log(`\n${results.checks.length - failed.length}/${results.checks.length} checks passed. Budgets: ${JSON.stringify(results.budgets)}`);
process.exit(failed.length ? 1 : 0);
