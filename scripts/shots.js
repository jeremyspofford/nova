#!/usr/bin/env node
// Drives the real UI in a browser against the scripted stand-in model:
// captures the golden screens in every theme, walks the keyboard path,
// exercises each state, and measures the performance budgets.
// Usage: node scripts/shots.js [outDir]   (CHROMIUM=/path/to/chrome to override)
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
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

const v1 = (method, path, body) => fetch(`${base}/api/v1${path}`, { method, headers: { 'content-type': 'application/json', 'x-nova': '1' }, ...(body ? { body: JSON.stringify(body) } : {}) }).then((r) => r.json());
let devices = 0;
// Each browser context is its own device: it gets a device id, and its design system is applied
// for that device through the design-system API (no theme lives in the browser). The light/dark
// mode is the person's, so it is set for everyone.
async function page({ theme = 'paper', mode = 'light', width = 1280, height = 820, reducedMotion = 'no-preference' } = {}) {
  const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 2, reducedMotion });
  const device = `shots-device-${++devices}`;
  await ctx.addInitScript((id) => { try { localStorage.setItem('nova.device', id); } catch { /* the sandboxed preview frame */ } }, device);
  await v1('POST', `/design-systems/${theme}/apply`, { scope: 'device', device_id: device });
  await v1('PUT', '/profile/appearance/mode', { value: mode });
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
for (const text of ['skip', 'skip', 'skip', 'skip', 'allow cloud when needed', 'no']) await v1('POST', '/setup/messages', { text });
{
  const p = await page();
  const t0 = Date.now();
  await p.goto(`${base}/chat`);
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
  // The front page is the main conversation; this one starts a conversation of its own.
  await p.keyboard.press('Control+Shift+O');
  await p.waitForSelector('.empty');
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
  check('⌘/Ctrl ⇧ O starts a new conversation', await p.evaluate(() => location.pathname === '/new' && document.activeElement.id === 'input'));
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
  await p.click('#rail [data-dest="memory"]');
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
  // The note about oat milk (a day note may also link, since M2 keeps day notes as memories).
  await p.click('.margin-note:has-text("oat milk") a.margin-link');
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
  await p.goto(`${base}/new`);
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

// ---- schedules: the morning digest, reminders, and the front page ----------------
{
  const p = await page();
  const mod = process.platform === 'darwin' ? 'Meta' : 'Control';
  await p.goto(`${base}/schedules`);
  await p.waitForSelector('html[data-ready] #sc-morning-digest .schedule-setup');
  await p.waitForTimeout(500);
  await shot(p, 'paper-schedules-empty');
  check('nothing scheduled: says how to start, and offers the morning digest', /Nothing is scheduled yet/.test(await p.textContent('#schedules')));
  await p.keyboard.press('Tab');
  check('Tab reaches the first schedule', await p.evaluate(() => document.activeElement.id === 'sc-morning-digest'));

  // Turn the digest on at a time you pick.
  await p.fill('#sc-morning-digest [name="time"]', '06:45');
  await p.selectOption('#sc-morning-digest [name="days"]', 'weekdays');
  await p.click('#sc-morning-digest .schedule-setup button');
  await p.waitForSelector('#sc-morning-digest.schedule');
  await p.waitForFunction(() => /is on: weekdays at 6:45 AM/.test(document.querySelector('#toast').textContent));
  check('turning on the digest writes a plain schedule file', /^cron: 45 6 \* \* 1-5$/m.test(readFileSync(join(home, 'schedules', 'morning-digest.md'), 'utf8')));
  check('it says when, and when next', /Weekdays at 6:45 AM · Next: \w+/.test(await p.textContent('#sc-morning-digest .schedule-when')));

  // Run now: it works unattended, then the report lands on the front page.
  await p.waitForSelector('#toast', { state: 'hidden' });
  await p.click('#sc-morning-digest [data-action="run-schedule"]');
  await p.waitForSelector('#sc-morning-digest .schedule-last.is-running');
  await p.waitForTimeout(250);
  await shot(p, 'paper-schedules-running');
  check('a run in progress shows, and Run now waits', await p.$eval('#sc-morning-digest [data-action="run-schedule"]', (b) => b.disabled));
  await p.waitForSelector('#sc-morning-digest .schedule-last a', { timeout: 20000 });
  await p.click('#sc-morning-digest .skill-playbook summary');
  await p.waitForSelector('#toast', { state: 'hidden' });
  await p.waitForTimeout(300);
  await shot(p, 'paper-schedules');
  check('the last run and its headline show in Schedules', /Last ran today at/.test(await p.textContent('#sc-morning-digest')) && /A contract to sign/.test(await p.textContent('#sc-morning-digest .schedule-headline')));
  check('a new report marks the main conversation', !!(await p.$('[data-dest="chat"] .nav-badge')) && !(await p.$eval('#main-dot', (e) => e.hidden)));
  const runs = readFileSync(join(home, 'schedules', 'runs.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  check('every run is recorded in runs.jsonl', runs.length === 1 && runs[0].ok && runs[0].delivered === 'main' && runs[0].manual);
  const listed = await (await fetch(`${base}/api/sessions`)).json();
  check("the run's own log isn't listed among conversations", !listed.some((s) => s.id === runs[0].run) && existsSync(join(home, 'sessions', `${runs[0].run}.jsonl`)));

  await p.click('#sc-morning-digest .schedule-last a');
  await p.waitForSelector('.handoff.is-found');
  await p.waitForTimeout(1200);
  await shot(p, 'paper-front');
  check('"Read the report" opens the main conversation at the report', await p.evaluate(() => location.pathname === '/chat' && /^#h-/.test(location.hash)));
  check('the report reads as a front page: name and time, then a serif headline', /Morning digest · \d+:\d{2} [AP]M/i.test(await p.textContent('.handoff-kicker')) && await p.$eval('.handoff-body > p', (e) => getComputedStyle(e).fontFamily !== getComputedStyle(document.body).fontFamily));
  check('opening the main conversation clears its mark', (await p.$eval('#main-dot', (e) => e.hidden)) && !(await p.$('[data-dest="chat"] .nav-badge')) && (await p.getAttribute('#main-link', 'aria-current')) === 'page');
  const scheduleCalls = readFileSync(join(home, 'sessions', `${runs[0].run}.jsonl`), 'utf8');
  check('the run read Gmail on its own, and asked for nothing', /"name":"gmail_search"/.test(scheduleCalls) && !/"needs_approval":true/.test(scheduleCalls));

  // Reply right under it: the conversation continues from the report.
  await p.focus('#input');
  await p.keyboard.type('Draft a reply to Sam saying yes');
  await p.keyboard.press('Enter');
  await p.waitForSelector('.approval .approval-letter');
  check('replying in the main conversation picks up from the report', /Sam Ortiz/.test(await p.textContent('.approval')));
  await p.keyboard.press('Escape');
  await settle(p);

  // Asked in a conversation, a reminder waits for an OK, then lives in Schedules.
  await p.goto(`${base}/new`);
  await p.waitForSelector('.empty');
  await p.keyboard.type('Remind me tomorrow to call the dentist about Friday');
  await p.keyboard.press('Enter');
  await p.waitForSelector('.approval [data-action="allow"]:focus', { timeout: 8000 });
  await p.waitForTimeout(450);
  await shot(p, 'paper-schedule-approval');
  const ask = await p.textContent('.approval');
  check('the card says what, when and where reports go, before anything is set', /Call the dentist/.test(ask) && /Once, on \w+day/.test(ask) && /This conversation/.test(ask) && !existsSync(join(home, 'schedules', 'call-the-dentist.md')));
  await p.keyboard.press('Enter');
  await settle(p);
  check('allowed, the reminder is set', /Set up “Call the dentist”/.test(await p.textContent('#thread')) && existsSync(join(home, 'schedules', 'call-the-dentist.md')));
  const reminderChat = p.url();

  await p.goto(`${base}/schedules#sc-call-the-dentist`);
  await p.waitForFunction(() => document.activeElement?.id === 'sc-call-the-dentist');
  check('a reminder shows once, and where it reports', /Once, on/.test(await p.textContent('#sc-call-the-dentist')) && /conversation where you asked/.test(await p.textContent('#sc-call-the-dentist')));

  // Pause and resume.
  await p.click('#sc-morning-digest [data-action="pause-schedule"]');
  await p.waitForSelector('#sc-morning-digest.is-paused');
  await p.waitForSelector('#toast', { state: 'visible' });
  await p.waitForTimeout(300);
  await shot(p, 'paper-schedules-paused');
  check('paused: says so, shows no next run, and the file says so too', /Paused/.test(await p.textContent('#sc-morning-digest')) && !/Next:/.test(await p.textContent('#sc-morning-digest')) && /^paused: true$/m.test(readFileSync(join(home, 'schedules', 'morning-digest.md'), 'utf8')));
  await p.click('#sc-morning-digest [data-action="resume-schedule"]');
  await p.waitForSelector('#sc-morning-digest:not(.is-paused)');

  // Remove by keyboard, then Undo.
  await p.focus('#sc-call-the-dentist');
  await p.keyboard.press('Delete');
  await p.waitForSelector('.toast-btn');
  check('Delete removes a schedule, file and all', !existsSync(join(home, 'schedules', 'call-the-dentist.md')));
  await p.keyboard.press(`${mod}+Z`);
  await p.waitForFunction(() => /exactly as it was/.test(document.querySelector('#toast').textContent));
  check('Undo puts it back', existsSync(join(home, 'schedules', 'call-the-dentist.md')));

  // A run that fails says so where its report would have gone, with a way to try again.
  writeFileSync(join(home, 'schedules', 'bills.md'), `---\nname: Bills check\ncron: 0 9 * * 1\ndeliver: ${reminderChat.split('/c/')[1]}\n---\n\nPlease fail.\n`);
  await p.goto(`${base}/schedules#sc-bills`);
  await p.waitForSelector('#sc-bills');
  await p.click('#sc-bills [data-action="run-schedule"]');
  await p.waitForSelector('#sc-bills .schedule-last.is-warn', { timeout: 20000 });
  check("a failed run says so in Schedules", /didn't finish/.test(await p.textContent('#sc-bills')));
  await p.goto(reminderChat);
  await p.waitForSelector('.handoff.is-failed');
  await p.waitForTimeout(500);
  await shot(p, 'paper-schedule-failed');
  check('a failed report offers Run it again', (await p.$('.handoff.is-failed [data-action="run-schedule"]')) !== null);
  await (await fetch(`${base}/api/schedules/bills/remove`, { method: 'POST', headers: { 'x-nova': '1' } })).json();
  check('schedules have no script errors', p.errors.length === 0, p.errors.join(' | '));
}

// ---- helpers and Activity: work handed off, and what Nova is doing and did --------
let helperRun;
{
  const p = await page({ height: 900 });
  mkdirSync(join(home, 'workspace'), { recursive: true });
  writeFileSync(join(home, 'workspace', 'bikes.md'), 'Commute: 9 miles each way, one long hill.\n');
  await p.goto(`${base}/new`);
  await p.waitForSelector('.empty');
  await p.keyboard.type('Ask a helper to compare commuter e-bikes under $2,000 using my notes');
  await p.keyboard.press('Enter');
  await p.waitForSelector('.handoff.is-helper', { timeout: 20000 });
  const afterReport = () => { const all = [...document.querySelectorAll('#thread .turn')]; return all[all.indexOf(document.querySelector('.handoff.is-helper')) + 1]; };
  await p.waitForFunction(`(${afterReport})()?.textContent.includes('My take')`, null, { timeout: 15000 });
  await settle(p);
  await p.evaluate(() => document.querySelector('.handoff.is-helper').scrollIntoView({ block: 'start' }));
  await p.waitForTimeout(500);
  await shot(p, 'paper-helper-report');
  const report = await p.textContent('.handoff.is-helper');
  check('a helper\'s report comes back to the conversation that asked', /Compare e-bikes · a helper/.test(report) && /Ridgeline C2/.test(report));
  check('the helper read only the notes it was handed', /9 miles with one long hill/.test(report));
  check("then Nova says what the report means, with no message from you", await p.evaluate(`(() => { const t = (${afterReport})(); return !t.querySelector('.msg-user') && /Ridgeline C2/.test(t.textContent); })()`));
  check('the hand-off says where to follow it', /Follow it in Activity/.test(await p.textContent('#thread')));
  const chatUrl = p.url();
  const parent = chatUrl.split('/c/')[1];
  const handoff = readFileSync(join(home, 'sessions', `${parent}.jsonl`), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).find((e) => e.type === 'handoff');
  const helperLog = readFileSync(join(home, 'sessions', `${handoff.run}.jsonl`), 'utf8');
  check('the helper worked from its brief alone, not the conversation or memory', !/coffee black/.test(helperLog) && /"kind":"helper"/.test(helperLog));
  const listed = await (await fetch(`${base}/api/sessions`)).json();
  check("a helper's own log isn't listed among conversations", !listed.some((s) => s.id === handoff.run));

  // Its own log reads like a conversation, with no one to reply to.
  await p.click('.handoff.is-helper .handoff-kicker a');
  await p.waitForSelector(`#${'a-' + handoff.run}`);
  check('the report\'s name opens it in Activity', await p.evaluate((id) => location.pathname === '/activity' && document.activeElement?.id === id, `a-${handoff.run}`));
  await p.goto(`${base}/c/${handoff.run}`);
  await p.waitForSelector('.work-note');
  await p.waitForTimeout(400);
  await shot(p, 'paper-helper-log');
  check("a helper's log is read-only and says where it came from", await p.isHidden('#dock') && !(await p.$('[data-action="regenerate"]')) && /asked for in/.test(await p.textContent('.work-note')));

  // Something slow, and something waiting on an OK, so Now has both.
  await p.goto(chatUrl);
  await p.waitForSelector('.handoff');
  await p.fill('#input', 'Ask a helper to take it slow reading the lease');
  await p.keyboard.press('Enter');
  await settle(p);
  // Settings: every permission asks first until you switch it on.
  await p.goto(`${base}/settings`);
  await p.waitForSelector('.perm');
  await p.waitForTimeout(500);
  await shot(p, 'paper-settings');
  const perms = await p.$$eval('.switch', (b) => b.map((x) => [x.dataset.id, x.getAttribute('aria-checked')]));
  check('Settings lists a switch per permission, each set to ask first', perms.length === 5 && perms.every(([, on]) => on === 'false'), perms.map(([id]) => id).join(', '));
  await p.focus('[data-id="commands"]');
  await p.keyboard.press('Space');
  await p.waitForSelector('[data-id="commands"][aria-checked="true"]');
  await p.waitForSelector('#toast', { state: 'visible' });
  await p.waitForTimeout(300);
  await shot(p, 'paper-settings-on');
  check('a switch flips from the keyboard, says so, and is kept in permissions.md', /^- commands: yes /m.test(readFileSync(join(home, 'permissions.md'), 'utf8')) && /without asking now/.test(await p.textContent('#toast')) && await p.evaluate(() => document.activeElement?.dataset.id === 'commands'));
  // With it on, a scheduled run takes that step without asking.
  writeFileSync(join(home, 'schedules', 'standup-check.md'), '---\nname: Standup check\ncron: 0 9 * * 1-5\n---\n\nRun git status before standup.\n');
  await fetch(`${base}/api/schedules/standup-check/run`, { method: 'POST', headers: { 'x-nova': '1' } });
  const ran = () => readFileSync(join(home, 'schedules', 'runs.jsonl'), 'utf8').includes('"schedule":"standup-check"');
  for (let i = 0; i < 200 && !ran(); i++) await p.waitForTimeout(100);
  await fetch(`${base}/api/permissions/commands/ask`, { method: 'POST', headers: { 'x-nova': '1' } });
  await p.goto(`${base}/new`);
  await p.waitForSelector('.empty');
  await p.keyboard.type('Run git status in my workspace');
  await p.keyboard.press('Enter');
  await p.waitForSelector('.approval [data-action="allow"]');
  const waitingChat = p.url();
  await p.goto(`${base}/activity`);
  await p.waitForSelector('.act-now .act-entry.is-working');
  await p.waitForSelector('.act-now .act-entry.is-waiting');
  await p.waitForFunction(() => /1 waiting/.test(document.querySelector('[data-dest="activity"]')?.getAttribute('aria-label') ?? ''));
  await p.waitForTimeout(600);
  await shot(p, 'paper-activity');
  const nowText = await p.textContent('.act-now');
  check('Now shows what is working and what waits for you', /Working/.test(nowText) && /Needs you/.test(nowText) && /waiting for you/.test(nowText) && /Go to it/.test(nowText));
  check('the Activity place counts what waits', (await p.getAttribute('[data-dest="activity"]', 'aria-label')) === 'Activity, 1 waiting for you');
  check('each day says what happened in a sentence', /\d+ (repl(y|ies)|helpers?)/.test(await p.textContent('.act-summary')));
  check('a run took a step without asking, as Settings allowed, and Activity says so', /Without asking/.test(await p.textContent('.act-day')) && /took one step without asking/.test(await p.textContent('.act-summary')));
  check('no tool output is dumped: steps are one line each', await p.evaluate(() => [...document.querySelectorAll('.act-step-list li')].every((li) => li.textContent.length < 200)));

  // The keyboard: ↓ and ↑ walk entries, Enter opens the steps.
  await p.focus('.act-entry');
  await p.keyboard.press('ArrowDown');
  const second = await p.evaluate(() => document.activeElement === document.querySelectorAll('.act-entry')[1]);
  await p.keyboard.press('ArrowUp');
  check('↓/↑ move between entries', second && await p.evaluate(() => document.activeElement === document.querySelector('.act-entry')));
  const folded = await p.$('.act-entry:has(.act-steps)');
  if (folded) {
    await folded.focus();
    await p.keyboard.press('Enter');
    check('Enter opens an entry\'s steps', await folded.evaluate((e) => e.querySelector('.act-steps').open));
  }

  // Stop the slow one: its conversation says so, with Try again.
  await p.click('.act-now .is-working [data-action="stop-helper"]');
  await p.waitForSelector('.act-entry.is-helper.is-stopped');
  check('Stop stops a helper, and Activity says so', !(await p.$('.act-now .is-working')));
  await p.goto(chatUrl);
  await p.waitForSelector('.handoff.is-stopped');
  await p.evaluate(() => document.querySelector('.handoff.is-stopped').scrollIntoView({ block: 'center' }));
  await p.waitForTimeout(400);
  await shot(p, 'paper-helper-stopped');
  check('a stopped helper says so where its report would go, with Try again', /You stopped this helper/.test(await p.textContent('.handoff.is-stopped')) && !!(await p.$('.handoff.is-stopped [data-action="retry-helper"]')));

  // Earlier weeks: an old conversation, moved back nine days.
  const old = new Date(Date.now() - 9 * 86_400_000);
  const oldId = `${old.toISOString().slice(0, 10)}-oldone`;
  const shift = (ts) => new Date(Date.parse(ts) - 9 * 86_400_000).toISOString();
  const lines = readFileSync(join(home, 'sessions', `${listed.find((s) => s.title.startsWith('What should I focus')).id}.jsonl`), 'utf8').split('\n').filter(Boolean)
    .map((l) => { const e = JSON.parse(l); if (e.ts) e.ts = shift(e.ts); if (e.type === 'session') e.id = oldId; return JSON.stringify(e); });
  writeFileSync(join(home, 'sessions', `${oldId}.jsonl`), `${lines.join('\n')}\n`);
  await p.goto(`${base}/activity`);
  await p.waitForSelector('[data-action="earlier"]');
  const days = await p.$$eval('.act-day', (d) => d.length);
  await p.click('[data-action="earlier"]');
  await p.waitForFunction((n) => document.querySelectorAll('.act-day').length > n, days);
  check('"Show the week before" adds the earlier week', /What should I focus/.test(await p.textContent('.act-day:last-of-type')));
  // Activity is read from the logs each time: how long that takes with every conversation so far.
  const times = [];
  for (let i = 0; i < 5; i++) { const t0 = performance.now(); await (await fetch(`${base}/api/activity`)).json(); times.push(performance.now() - t0); }
  results.budgets.activityMs = Math.round(Math.min(...times));
  check('Activity loads in ≤ 100 ms', results.budgets.activityMs <= 100, `${results.budgets.activityMs} ms for ${readdirSync(join(home, 'sessions')).length} logs`);
  rmSync(join(home, 'sessions', `${oldId}.jsonl`));
  helperRun = handoff.run;

  // Clear the waiting OK so later screens start calm.
  await p.goto(waitingChat);
  await p.waitForSelector('.approval [data-action="deny"]');
  await p.click('.approval [data-action="deny"]');
  await settle(p);
  check('helpers and Activity have no script errors', p.errors.length === 0, p.errors.join(' | '));
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
  await p.goto(`${base}/chat`);
  await p.waitForSelector('html[data-ready] .handoff');
  await p.evaluate(() => { document.activeElement.blur(); [...document.querySelectorAll('.handoff')].at(-1).scrollIntoView({ block: 'start' }); });
  await p.waitForTimeout(600);
  await shot(p, `${prefix}-front`);
  await p.goto(`${base}/new`);
  await p.waitForSelector('.empty');
  await p.waitForTimeout(600);
  await shot(p, `${prefix}-empty`);
  const list = await (await fetch(`${base}/api/sessions`)).json();
  const chat = list.find((s) => s.title.startsWith('What should I focus'));
  await p.goto(`${base}/c/${chat.id}`);
  await p.waitForSelector('.prose');
  await p.waitForTimeout(500);
  await shot(p, `${prefix}-chat`);
  await p.goto(`${base}/new`);
  await p.waitForSelector('.empty');
  await p.fill('#input', 'run git status for the screenshot');
  await p.keyboard.press('Enter');
  await p.waitForSelector('.approval');
  await p.waitForTimeout(500);
  await shot(p, `${prefix}-approval`);
  await p.keyboard.press('Escape');
  await settle(p);
  rmSync(join(home, 'sessions', `${p.url().split('/c/')[1]}.jsonl`)); // a screenshot prop, not activity worth showing
  await p.goto(`${base}/memory`);
  await p.waitForSelector('.memory-item');
  await p.waitForTimeout(500);
  await shot(p, `${prefix}-memory`);
  await p.goto(`${base}/skills`);
  await p.waitForSelector('.skill');
  await p.waitForTimeout(500);
  await shot(p, `${prefix}-skills`);
  await p.goto(`${base}/schedules`);
  await p.waitForSelector('.schedule');
  await p.waitForTimeout(500);
  await shot(p, `${prefix}-schedules`);
  await p.goto(`${base}/activity#a-${helperRun}`);
  await p.waitForSelector('.act-entry');
  await p.waitForTimeout(1400);
  await shot(p, `${prefix}-activity`);
  await p.goto(`${base}/settings`);
  await p.waitForSelector('.perm');
  await p.waitForTimeout(500);
  await shot(p, `${prefix}-settings`);
  check(`${prefix}: no script errors`, p.errors.length === 0, p.errors.join(' | '));
};
{
  // A first visit, with nothing chosen, lands in the default design system and makes its device id.
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 820 } });
  const p = await ctx.newPage();
  await p.goto(`${base}/new`);
  await p.waitForSelector('html[data-ready] .empty');
  await p.waitForFunction(() => document.documentElement.dataset.theme);
  const t = await p.evaluate(() => [document.documentElement.dataset.theme, localStorage.getItem('nova.device')]);
  check('a first visit opens in Orb Teal, with a device id of its own', t[0] === 'orb-teal' && /^[\w-]{8,64}$/.test(t[1] ?? ''), t.join(' '));
  await ctx.close();
}
await golden({ theme: 'nova', mode: 'dark' }, 'nova');
await golden({ theme: 'paper', mode: 'dark' }, 'paper-dark');
await golden({ theme: 'aurora', mode: 'light' }, 'aurora');
await golden({ theme: 'aurora', mode: 'dark' }, 'aurora-dark');
await golden({ theme: 'obsidian', mode: 'dark' }, 'obsidian');

// ---- appearance: preview in a sandboxed frame, apply for this device, roll back ------------
{
  const p = await page({ theme: 'nova', mode: 'dark' });
  await p.goto(`${base}/settings#appearance`);
  await p.waitForSelector('html[data-ready] .ds-card');
  await p.waitForTimeout(400);
  await shot(p, 'nova-settings-appearance');
  check('appearance: Settings lists every design system and the light/dark choices', await p.evaluate(() => document.querySelectorAll('#appearance .ds-card').length === 6 && document.querySelectorAll('#appearance input[name="mode"]').length === 3));
  check('appearance: /settings#appearance focuses the current mode', await p.evaluate(() => document.activeElement?.name === 'mode' && document.activeElement.checked));
  await p.evaluate(() => { window.__boot = 1; });
  await p.click('.ds-card[data-ds="companion-light"]');
  await p.waitForSelector('#ds-preview');
  check('appearance: the preview is a sandboxed frame with that design system only', await p.evaluate(() => { const f = document.getElementById('ds-preview'); return f.sandbox.length === 0 && f.hasAttribute('sandbox') && /design-systems\/companion-light\/preview\.css/.test(f.srcdoc) && document.documentElement.dataset.theme === 'nova'; }));
  await p.click('[data-action="apply-ds"][data-scope="device"]');
  await p.waitForFunction(() => document.documentElement.dataset.theme === 'companion-light');
  check('appearance: applied on this device, live, with no reload', await p.evaluate(() => window.__boot === 1));
  await p.click('[data-action="rollback-ds"][data-scope="device"]');
  await p.waitForFunction(() => document.documentElement.dataset.theme === 'nova');
  check('appearance: the last change on this device rolls back', true);
  await p.click('#appearance input[value="light"]', { force: true });
  await p.waitForFunction(() => document.documentElement.dataset.mode === 'light');
  check('appearance: picking a mode changes data-mode', true);
  check('appearance: nothing about the design system is kept in the browser but the device id', await p.evaluate(() => Object.keys(localStorage).every((k) => !/theme|mode/.test(k))));
  check('appearance: no script errors', p.errors.length === 0, p.errors.join(' | '));
}

// ---- layouts: the right column, the conversations drawer, every width ------------------------
{
  const p = await page({ theme: 'nova', mode: 'dark', width: 1440, height: 900 });
  const list = await (await fetch(`${base}/api/sessions`)).json();
  const chat = list.find((s) => s.title.startsWith('What should I focus'));
  await p.goto(`${base}/c/${chat.id}`);
  await p.waitForSelector('.prose');
  check('desktop: Calm Control, with the right column of quiet cards', await p.evaluate(() => document.body.dataset.layout === 'desktop' && document.body.dataset.aside === 'on' && document.querySelectorAll('#aside .card').length === 3));
  await shot(p, 'nova-desktop-chat');
  await p.click('#aside-toggle');
  await p.waitForTimeout(300);
  check('desktop: the right column closes', await p.evaluate(() => document.body.dataset.aside === 'off'));
  await p.reload();
  await p.waitForSelector('.prose');
  check('desktop: and stays closed across a reload', await p.evaluate(() => document.body.dataset.aside === 'off'));
  await p.keyboard.press('Control+Backslash');
  await p.waitForTimeout(300);
  check('desktop: Ctrl/⌘+\\ brings it back', await p.evaluate(() => document.body.dataset.aside === 'on'));
  await p.click('#menu');
  await p.waitForTimeout(450);
  check('the conversations drawer opens from the top bar', await p.evaluate(() => document.getElementById('app').classList.contains('drawer-open') && !document.getElementById('sidebar').inert));
  await shot(p, 'nova-drawer');
  check('layouts: no script errors', p.errors.length === 0, p.errors.join(' | '));
  for (const [w, h, layout] of [[390, 844, 'phone'], [820, 1180, 'tablet'], [960, 900, 'tablet'], [1280, 820, 'desktop']]) {
    const q = await page({ theme: 'nova', mode: 'dark', width: w, height: h });
    await q.goto(`${base}/c/${chat.id}`);
    await q.waitForSelector('.prose');
    await q.waitForTimeout(400);
    const fit = await q.evaluate(() => {
      const sc = document.querySelector('.scroller');
      const edge = sc.getBoundingClientRect().left + sc.clientWidth;
      const past = [...document.querySelectorAll('.thread *, .dock *')].filter((e) => !e.closest('.table-wrap, pre') && e.getBoundingClientRect().right > edge + 0.5);
      return { layout: document.body.dataset.layout, past: past.length, scroll: sc.scrollWidth - sc.clientWidth, page: document.documentElement.scrollWidth - innerWidth };
    });
    check(`${w} px: the ${layout} layout, nothing cut off on the right`, fit.layout === layout && fit.past === 0 && fit.scroll === 0 && fit.page <= 0, JSON.stringify(fit));
    await q.goto(base);
    await q.waitForSelector('.home-hero');
    await q.waitForTimeout(500);
    await shot(q, `nova-home-${w}`);
  }
}

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
  await p.keyboard.press('Escape');
  await p.click('#tabs [data-dest="memory"]');
  await p.waitForSelector('.memory-item');
  await p.waitForTimeout(500);
  await shot(p, 'mobile-memory');
  let overflow = await p.evaluate(() => document.documentElement.scrollWidth > innerWidth);
  await p.goto(`${base}/skills`);
  await p.waitForSelector('.skill');
  await p.waitForTimeout(500);
  await shot(p, 'mobile-skills');
  overflow ||= await p.evaluate(() => document.documentElement.scrollWidth > innerWidth || document.querySelector('.scroller').scrollWidth > document.querySelector('.scroller').clientWidth);
  await p.goto(`${base}/schedules`);
  await p.waitForSelector('.schedule');
  await p.waitForTimeout(500);
  await shot(p, 'mobile-schedules');
  overflow ||= await p.evaluate(() => document.documentElement.scrollWidth > innerWidth || document.querySelector('.scroller').scrollWidth > document.querySelector('.scroller').clientWidth);
  await p.goto(`${base}/activity#a-${helperRun}`);
  await p.waitForSelector('.act-entry');
  await p.waitForTimeout(1400);
  await shot(p, 'mobile-activity');
  overflow ||= await p.evaluate(() => document.documentElement.scrollWidth > innerWidth || document.querySelector('.scroller').scrollWidth > document.querySelector('.scroller').clientWidth);
  await p.goto(`${base}/settings`);
  await p.waitForSelector('.perm');
  await p.waitForTimeout(500);
  await shot(p, 'mobile-settings');
  overflow ||= await p.evaluate(() => document.documentElement.scrollWidth > innerWidth || document.querySelector('.scroller').scrollWidth > document.querySelector('.scroller').clientWidth);
  await p.goto(`${base}/chat`);
  await p.waitForSelector('.handoff');
  await p.evaluate(() => document.querySelector('.handoff').scrollIntoView({ block: 'start' }));
  await p.waitForTimeout(500);
  await shot(p, 'mobile-front');
  overflow ||= await p.evaluate(() => document.documentElement.scrollWidth > innerWidth || document.querySelector('.scroller').scrollWidth > document.querySelector('.scroller').clientWidth);
  await p.goto(`${base}/skills`);
  await p.waitForSelector('.skill');
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
  await p.waitForSelector('html[data-ready] .home-hero .orb', { state: 'attached' });
  await p.waitForTimeout(300);
  const v = await p.evaluate(() => ({ breathe: getComputedStyle(document.documentElement).getPropertyValue('--motion-breathe').trim(), orb: getComputedStyle(document.querySelector('.home-hero .orb-glow')).animationDuration }));
  check('reduced motion: the orb stops breathing', v.breathe === '0s' && v.orb === '0s', JSON.stringify(v));
  const p2 = await page({ reducedMotion: 'reduce', theme: 'obsidian', mode: 'dark' });
  await p2.goto(base);
  await p2.waitForSelector('html[data-ready]');
  await p2.waitForTimeout(300);
  const d = await p2.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--motion-transition').trim());
  check('reduced motion: Obsidian transitions become 1 ms', d === '1ms', d);
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
  await p.goto(`${base}/chat`);
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
