#!/usr/bin/env node
// Drives the real UI in a browser against the scripted stand-in model:
// captures the golden screens in every theme, walks the keyboard path,
// exercises each state, and measures the performance budgets.
// Usage: node scripts/shots.js [outDir]   (CHROMIUM=/path/to/chrome to override)
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright-core';
import { sampleMail, startFakeGoogle, startFakeImap } from './fake-google.js';
import { makeZip } from './make-zip.js';

const root = resolve(new URL('..', import.meta.url).pathname);
const out = resolve(process.argv[2] ?? join(root, 'docs/screenshots'));
mkdirSync(out, { recursive: true });
const home = mkdtempSync(join(tmpdir(), 'nova-shots-'));
const port = 4400 + Math.floor(Math.random() * 400);
const base = `http://localhost:${port}`;
const results = { budgets: {}, checks: [] };
const check = (name, ok, detail = '') => { results.checks.push({ name, ok, detail }); console.log(`${ok ? '✓' : '✗'} ${name}${detail ? `: ${detail}` : ''}`); };

const mailbox = sampleMail();
const google = await startFakeGoogle({ mail: mailbox });
const imap = await startFakeImap({ mail: mailbox, labels: google.state.labels });

function startServer() {
  const t0 = performance.now();
  const child = spawn(process.execPath, [join(root, 'src/server.js')], {
    env: { ...process.env, NOVA_HOME: home, NOVA_PORT: String(port), NOVA_GOOGLE_BASE: google.base, NOVA_SEARCH_URL: `${google.base}/search`, NOVA_IMAP_URL: imap.url, NOVA_AGENT_CMD: `FAKE_DELAY=${process.env.FAKE_DELAY ?? 18} node ${join(root, 'scripts/fake-agent.js')}` },
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

// ---- memory you can see and steer ----------------------------------------------------
{
  const disk = () => readFileSync(join(home, 'MEMORY.md'), 'utf8');
  const notes = () => (existsSync(join(home, 'memory')) ? readdirSync(join(home, 'memory')).filter((f) => /^\d{4}/.test(f)).map((f) => readFileSync(join(home, 'memory', f), 'utf8')).join('') : '');
  const p = await page();
  await p.goto(`${base}/memory`);
  await p.waitForSelector('html[data-ready] .memory-empty');
  await p.waitForTimeout(500);
  await shot(p, 'paper-memory-empty');
  check('empty memory says what will appear there', /Nothing kept yet/.test(await p.textContent('#memory')));

  // Remember, by keyboard from a new conversation.
  await p.keyboard.press(process.platform === 'darwin' ? 'Meta+Shift+O' : 'Control+Shift+O');
  await p.waitForSelector('.empty');
  await p.keyboard.type('I take my coffee black, no sugar');
  await p.keyboard.press('Enter');
  await p.waitForSelector('.margin-note a.margin-link');
  await settle(p);
  const log = readFileSync(join(home, 'sessions', `${p.url().split('/c/')[1]}.jsonl`), 'utf8').trim().split('\n').map((l) => JSON.parse(l).type);
  check('memory is written before the reply completes', /Takes coffee black/.test(disk()) && log.indexOf('memory') >= 0 && log.indexOf('memory') < log.lastIndexOf('done'), log.join(' → '));
  check('the conversation shows what was kept, in the margin', /kept in memory: Takes coffee black/.test(await p.textContent('.margins')));

  for (const t of ['remember that my daughter June starts kindergarten in September', 'actually I take my coffee with oat milk']) {
    await p.keyboard.type(t);
    await p.keyboard.press('Enter');
    await p.waitForFunction((n) => document.querySelectorAll('.turn').length === n && !document.querySelector('.thinking, [data-live]'), t.startsWith('remember') ? 2 : 3);
    await settle(p);
  }
  const prefs = disk().split('## Preferences')[1].split('##')[0];
  check('a correction replaces the superseded entry', /oat milk/.test(prefs) && !/black/.test(prefs) && prefs.match(/^- /gm).length === 1);
  await p.waitForTimeout(300);
  await shot(p, 'paper-memory-chat');

  // The Memory view: where each entry came from; edit and forget by keyboard.
  await p.click('#memory-link');
  await p.waitForSelector('.memory-item');
  await p.waitForTimeout(500);
  await shot(p, 'paper-memory');
  check('each memory says where it came from', (await p.$$('.memory-item .memory-from')).length >= 2);
  await p.keyboard.press('Tab');
  check('Tab goes straight to the first memory', await p.evaluate(() => document.activeElement.classList.contains('memory-item')));
  await p.keyboard.press('Enter');
  await p.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A');
  await p.keyboard.type('Daughter June starts kindergarten at Maple Street in September.');
  await shot(p, 'paper-memory-edit');
  await p.keyboard.press('Enter');
  await p.waitForFunction(() => /Saved/.test(document.querySelector('#toast').textContent));
  check('editing is one gesture, and lands in the file', /Maple Street.*by=you/.test(disk()));
  await p.waitForTimeout(3400);
  await p.keyboard.press('Delete');
  await p.waitForSelector('.toast-btn');
  await p.waitForTimeout(300);
  await shot(p, 'paper-memory-forgot');
  check('forgetting removes it from memory and the day notes', !/June/.test(disk()) && !/June/.test(notes()), await p.textContent('#toast'));
  await p.keyboard.press(process.platform === 'darwin' ? 'Meta+Z' : 'Control+Z');
  await p.waitForFunction(() => /Back in memory/.test(document.querySelector('#toast').textContent));
  check('Undo brings it back', /Maple Street/.test(disk()) && /June/.test(notes()));
  await p.focus('.memory-item');
  await p.keyboard.press('Delete');
  await p.waitForSelector('.toast-btn');

  // A forgotten memory is gone from conversations too; links land on the entry.
  await p.goBack();
  await p.waitForSelector('.margins');
  await p.waitForTimeout(300);
  const margins = await p.textContent('#thread');
  check('a forgotten memory disappears from the conversation view', !/June/.test(margins.split('kindergarten in September')[1] ?? margins) && /since forgotten/.test(margins));
  await p.click('a.margin-link');
  await p.waitForSelector('.memory-item.is-found');
  check('a margin note links to the memory itself', await p.evaluate(() => document.activeElement.classList.contains('memory-item') && /oat milk/.test(document.activeElement.textContent)));
  check('memory view has no script errors', p.errors.length === 0, p.errors.join(' | '));
}

// ---- skills: install, connect, use, remove ----------------------------------------------
{
  const mod = process.platform === 'darwin' ? 'Meta' : 'Control';
  const p = await page();
  await p.goto(`${base}/skills`);
  await p.waitForSelector('html[data-ready] .skill.is-available');
  await p.waitForTimeout(500);
  await shot(p, 'paper-skills-empty');
  check('no skills yet: says what installing does', /No skills yet/.test(await p.textContent('#skills')));

  // Install by keyboard: Tab to the first skill, Tab to Install, Enter.
  await p.keyboard.press('Tab');
  await p.keyboard.press('Tab');
  check('Tab reaches the first skill\'s Install button', await p.evaluate(() => document.activeElement.dataset.action === 'install-skill'));
  await p.keyboard.press('Enter');
  await p.waitForSelector('#s-email-summary:not(.is-available)');
  check('installing puts the playbook in the Nova folder', existsSync(join(home, 'skills', 'email-summary', 'SKILL.md')));

  // Before Gmail is connected, the skill says so and Nova points to it.
  check('an installed skill says its connection is missing', /isn't connected yet/.test(await p.textContent('#s-email-summary')));
  await p.goto(base);
  await p.waitForSelector('.empty');
  await p.fill('#input', "What's in my email?");
  await p.keyboard.press('Enter');
  await p.waitForSelector('.prose a[href="/skills#gmail"]');
  await settle(p);
  check('asked about email before connecting, Nova links to Connect Gmail', true);
  await p.click('.prose a[href="/skills#gmail"]');
  await p.waitForSelector('.connection #gmail-email');
  await p.waitForTimeout(500);
  await shot(p, 'paper-skills-gmail-setup');
  check('the link lands on the Gmail card, ready to type', await p.evaluate(() => document.activeElement.id === 'gmail-email'));

  // The Advanced way, for work accounts: your own Google client.
  await p.click('.connection-advanced summary');
  await p.waitForTimeout(300);
  await p.evaluate(() => document.querySelector('.connection-advanced').scrollIntoView({ block: 'start' }));
  await p.waitForTimeout(200);
  await shot(p, 'paper-skills-gmail-advanced');
  check('Advanced keeps the own-client way, with its steps', /Desktop app/.test(await p.textContent('.connection-advanced')));
  await p.click('.connection-advanced summary');

  // Connect with an app password. The Google password first, as people will.
  await p.focus('#gmail-email');
  await p.keyboard.type('you@example.com');
  await p.keyboard.press('Tab');
  await p.keyboard.type('my-google-password');
  await p.keyboard.press('Enter');
  await p.waitForFunction(() => /That's your Google password/.test(document.querySelector('#toast').textContent));
  check("the Google password instead of an app password: says what's needed", true);
  await p.fill('#gmail-password', 'abcd efgh ijkl mnop');
  await p.keyboard.press('Enter');
  await p.waitForSelector('.connection[data-state="connected"]');
  await p.waitForFunction(() => /Gmail is connected as/.test(document.querySelector('#toast').textContent));
  check('an app password connects Gmail, with a confirmation', true);
  const mode = (f) => (statSync(join(home, 'connectors', 'gmail', f)).mode & 0o777).toString(8);
  check('the app password is readable only by you', mode('password.json') === '600', mode('password.json'));
  await p.waitForTimeout(3400);
  await p.click('#s-email-summary .skill-playbook summary');
  await p.waitForTimeout(300);
  await shot(p, 'paper-skills');

  // Use: "Try" starts a conversation with the skill's example.
  await p.click('#s-email-summary [data-action="try-skill"]');
  check('Try fills the composer with the skill\'s example', (await p.inputValue('#input')) === 'What in my inbox needs me today?');
  await p.keyboard.press('Enter');
  await p.waitForSelector('.turn .prose');
  await settle(p);
  await p.waitForTimeout(300);
  await shot(p, 'paper-skill-email');
  const thread = await p.textContent('#thread');
  check('the reply follows the skill, shown in the margin', /following Email summary/.test(thread));
  check('it searches Gmail, then reads only what matters', /Searched your Gmail: 5 messages/.test(thread) && (thread.match(/Read “/g) ?? []).length === 1);

  // Mail is in the conversation now: going online waits for you.
  await p.keyboard.type('open that link');
  await p.keyboard.press('Enter');
  await p.waitForSelector('.approval');
  await p.waitForTimeout(400);
  await shot(p, 'paper-skill-approval');
  check('after reading mail, opening a web page asks first', /read your email in this conversation/.test(await p.textContent('.approval')));
  await p.keyboard.press('Escape');
  await settle(p);
  const emailChat = p.url();

  // A draft: the card shows the whole reply; nothing is sent.
  await p.keyboard.type('Draft a reply to Sam saying yes');
  await p.keyboard.press('Enter');
  await p.waitForSelector('.approval .approval-letter');
  await p.waitForTimeout(400);
  await shot(p, 'paper-skill-draft');
  const card = await p.textContent('.approval');
  check('a draft waits for you, showing who, what and that it won\'t be sent', /Sam Ortiz/.test(card) && /Re: Saturday hike\?/.test(card) && /won't be sent/.test(card));
  await p.keyboard.press('Enter');
  await settle(p);
  await p.waitForTimeout(300);
  await shot(p, 'paper-skill-drafted');
  check('the draft is in Gmail, with a way to open it', imap.state.drafts.length === 1 && (await p.$('.record-link[href*="#drafts"]')) !== null);

  // Tidying: the card lists the emails; Not now leaves them be.
  await p.keyboard.type('Archive the water bill and the newsletter');
  await p.keyboard.press('Enter');
  await p.waitForSelector('.approval .approval-list');
  await p.waitForTimeout(400);
  await shot(p, 'paper-skill-organize');
  check('a change lists the emails it touches', /Your bill is ready/.test(await p.textContent('.approval-list')) && /archive 2 emails and mark them read/.test(await p.textContent('.approval')));
  await p.keyboard.press('Enter');
  await settle(p);
  check('allowed, the change happens in Gmail', !mailbox[3].labelIds.includes('INBOX') && /Archived 2 emails and marked them read/.test(await p.textContent('#thread')));

  // A second skill: shopping research.
  await p.goto(`${base}/skills`);
  await p.waitForSelector('#s-shopping');
  await p.click('#s-shopping [data-action="install-skill"]');
  await p.waitForSelector('#s-shopping:not(.is-available)');
  await p.click('#s-shopping [data-action="try-skill"]');
  await p.keyboard.press('Enter');
  await p.waitForSelector('.turn .prose table');
  await settle(p);
  await p.waitForSelector('#toast', { state: 'hidden' });
  await shot(p, 'paper-skill-shopping');
  const shop = await p.textContent('#thread');
  check('shopping searches the web and recommends one, with links', /following Shopping research/.test(shop) && /Searched the web for/.test(shop) && (await p.$$('.prose a[href^="https://"]')).length >= 2);
  const shopChat = p.url();

  // Remove by keyboard: nothing of it left; Undo brings it back exactly.
  await p.goto(`${base}/skills#s-shopping`);
  await p.waitForFunction(() => document.activeElement?.id === 's-shopping');
  await p.keyboard.press('Delete');
  await p.waitForSelector('.toast-btn');
  await p.waitForTimeout(300);
  await shot(p, 'paper-skills-removed');
  const leftovers = () => {
    const hits = [];
    const walk = (d) => { for (const f of readdirSync(d, { withFileTypes: true })) { if (['.git', 'sessions'].includes(f.name)) continue; const q = join(d, f.name); if (f.isDirectory()) walk(q); else if (/Shopping research/.test(readFileSync(q, 'utf8'))) hits.push(q); } };
    walk(home);
    return hits;
  };
  check('removing a skill leaves no file behind', !existsSync(join(home, 'skills', 'shopping')) && leftovers().length === 0, leftovers().join(', '));
  await p.keyboard.press(`${mod}+Z`);
  await p.waitForFunction(() => /exactly as it was/.test(document.querySelector('#toast').textContent));
  check('Undo puts the skill back', existsSync(join(home, 'skills', 'shopping', 'SKILL.md')));
  await p.focus('#s-shopping');
  await p.keyboard.press('Delete');
  await p.waitForSelector('.toast-btn');
  await p.waitForTimeout(8500); // past Undo
  execFileSync('git', ['-C', home, 'add', '-A']);
  let history = '';
  try { history = execFileSync('git', ['-C', home, 'log', '--all', '-p'], { encoding: 'utf8' }); } catch {}
  check("no playbook or sign-in is in the Nova folder's history", !/Nova researches; the person buys|refresh_token|rt-fake|client_secret|abcdefghijklmnop|abcd efgh/.test(history));
  await p.goto(shopChat);
  await p.waitForSelector('.margins');
  check('old conversations still say which skill they followed', /followed Shopping research, since removed/.test(await p.textContent('#thread')));
  await p.goto(emailChat);
  await p.waitForSelector('.margins');
  await p.click('.margin-link[href="/skills#s-email-summary"]');
  await p.waitForSelector('#s-email-summary.is-found');
  check('a skill margin note links to the skill', await p.evaluate(() => document.activeElement.id === 's-email-summary'));

  // Your own skill: a .zip made for Claude, added as it is.
  await p.goto(`${base}/skills#add`);
  await p.waitForSelector('.dropzone');
  await p.evaluate(() => document.querySelector('#add').scrollIntoView({ block: 'start' }));
  await p.waitForTimeout(300);
  await shot(p, 'paper-skills-add');
  check('#add lands on Choose a folder', await p.evaluate(() => document.activeElement.dataset.action === 'add-folder'));
  const zipPath = join(home, '..', `meeting-notes-${port}.zip`);
  writeFileSync(zipPath, makeZip({
    'meeting-notes/SKILL.md': '---\nname: meeting-notes\ndescription: >\n  Turns rough meeting notes into decisions and action items with owners.\n  Use when the person pastes notes from a meeting.\nlicense: MIT\n---\n\n# Meeting notes\n\n1. Read the notes through once.\n2. List the **decisions**, one line each.\n3. List **action items** with an owner and a date; ask if either is missing.\n4. Use the layout in `template.md`.\n',
    'meeting-notes/template.md': '## Decisions\n\n## Action items\n',
    '__MACOSX/meeting-notes/._SKILL.md': 'junk',
  }));
  await p.setInputFiles('#add-zip-input', zipPath);
  await p.waitForSelector('#s-meeting-notes');
  await p.waitForFunction(() => /Added Meeting notes/.test(document.querySelector('#toast').textContent));
  check("a skill in Claude's format, from a .zip, installs as it is", existsSync(join(home, 'skills', 'meeting-notes', 'template.md')) && !existsSync(join(home, 'skills', 'meeting-notes', '__MACOSX')));
  await p.click('#s-meeting-notes .skill-playbook summary');
  await p.waitForTimeout(400);
  await shot(p, 'paper-skills-added');
  check('your own skill says so', /Added by you, with 1 more file/.test(await p.textContent('#s-meeting-notes')));
  check('skills have no script errors', p.errors.length === 0, p.errors.join(' | '));
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
  await p.goto(`${base}/memory`);
  await p.waitForSelector('.memory-item');
  await p.waitForTimeout(500);
  await shot(p, `${prefix}-memory`);
  await p.goto(`${base}/skills`);
  await p.waitForSelector('.skill');
  await p.waitForTimeout(500);
  await shot(p, `${prefix}-skills`);
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
  await p.click('#memory-link');
  await p.waitForSelector('.memory-item');
  await p.waitForTimeout(500);
  await shot(p, 'mobile-memory');
  let overflow = await p.evaluate(() => document.documentElement.scrollWidth > innerWidth);
  await p.goto(`${base}/skills`);
  await p.waitForSelector('.skill');
  await p.waitForTimeout(500);
  await shot(p, 'mobile-skills');
  overflow ||= await p.evaluate(() => document.documentElement.scrollWidth > innerWidth || document.querySelector('.scroller').scrollWidth > document.querySelector('.scroller').clientWidth);
  check('mobile: no horizontal page scroll', !overflow);

  // Disconnecting deletes the app password, and says how to remove it at Google too.
  await p.click('[data-action="disconnect-gmail"]');
  await p.waitForSelector('.connection[data-state="setup"]');
  check('disconnecting deletes the app password', !existsSync(join(home, 'connectors', 'gmail', 'password.json')) && /app password is gone/.test(await p.textContent('#toast')));
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
await google.close();
await imap.close();
const failed = results.checks.filter((c) => !c.ok);
console.log(`\n${results.checks.length - failed.length}/${results.checks.length} checks passed. Budgets: ${JSON.stringify(results.budgets)}`);
process.exit(failed.length ? 1 : 0);
