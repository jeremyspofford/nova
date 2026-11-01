// Amendment 2026-10-30-C Part 1, the pure parts: chat grouping and timestamps, the Settings
// structure and its search, the live contrast check and the recommendation, and the CSS rules
// for bubbles, timestamps and scrolling. The browser tests (tests/ui/ui-fixes.test.ts) drive the
// same things in the real PWA.
process.env.TZ = 'UTC'; // the conversation's times are read in UTC
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { reduce } from '../ui/js/reduce.js';
import { renderBlocks, GROUP_MS, GAP_MS } from '../ui/js/view.js';
import { CATEGORIES, GROUPS, ENTRIES, searchSettings, categoryOf } from '../ui/js/settings-ia.js';
import { liveCheck as clientCheck, parseColor as clientParse, recommend } from '../ui/js/contrast.js';
import { BUILTIN_DIR, LIVE_CHECKS, liveCheck, looks } from '../src/core/index.ts';
import { Design } from '../src/core/design.ts';
import { Db } from '../src/core/db.ts';
import { Profile } from '../src/core/profile.ts';
import { Extensions } from '../src/core/extensions.ts';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ---- chat ---------------------------------------------------------------------------------------

const at = (hm, day = 28) => `2026-10-${day}T${hm}.000Z`;
const LOG = [
  { ts: at('09:00:00'), type: 'session', id: '2026-10-28-garden', title: 'Planning the garden' },
  { ts: at('09:00:00'), type: 'user', turn: 't1', text: 'What should I plant first?' },
  { ts: at('09:00:03'), type: 'tool_call', turn: 't1', attempt: 0, id: 'c1', name: 'read_file', args: { path: 'notes/garden.md' } },
  { ts: at('09:00:05'), type: 'tool_result', turn: 't1', attempt: 0, id: 'c1', ok: true, output: 'beds: two' },
  { ts: at('09:00:09'), type: 'assistant', turn: 't1', attempt: 0, id: 'a1', text: 'Start with the peas.' },
  { ts: at('09:00:10'), type: 'done', turn: 't1', attempt: 0 },
  { ts: at('09:02:00'), type: 'user', turn: 't2', text: '', followup: 'h1' },
  { ts: at('09:02:30'), type: 'assistant', turn: 't2', attempt: 0, id: 'a2', text: 'One more thing: water them in the morning.' },
  { ts: at('09:02:31'), type: 'done', turn: 't2', attempt: 0 },
  { ts: at('09:03:00'), type: 'user', turn: 't3', text: 'And after that?' },
  { ts: at('09:03:20'), type: 'assistant', turn: 't3', attempt: 0, id: 'a3', text: 'Beans.' },
  { ts: at('09:03:21'), type: 'done', turn: 't3', attempt: 0 },
  { ts: at('11:30:00'), type: 'user', turn: 't4', text: 'Thanks!' },
  { ts: at('11:30:05'), type: 'assistant', turn: 't4', attempt: 0, id: 'a4', text: 'Any time.' },
  { ts: at('11:30:06'), type: 'done', turn: 't4', attempt: 0 },
  { ts: at('08:00:00', 29), type: 'user', turn: 't5', text: 'Good morning' },
  { ts: at('08:00:04', 29), type: 'assistant', turn: 't5', attempt: 0, id: 'a5', text: 'Morning.' },
  { ts: at('08:00:05', 29), type: 'done', turn: 't5', attempt: 0 },
];
const html = () => renderBlocks(reduce(LOG), null, new Date(at('12:00:00', 30))).map((b) => b.html).join('\n');

test('chat: no orb or avatar on any message; Nova’s turn is un-bubbled, yours is a bubble with no tail', () => {
  const h = html();
  assert.doesNotMatch(h, /class="orb|msg-avatar/);
  assert.equal((h.match(/class="bubble"/g) ?? []).length, 4, 'one bubble per message of yours');
  assert.equal((h.match(/class="msg-nova msg"/g) ?? []).length, 5);
  const css = readFileSync('ui/styles/views.css', 'utf8');
  assert.doesNotMatch(css, /\.bubble \{[^}]*border-(bottom|top)-(left|right)-radius/, 'no tail corner on your bubble');
  assert.doesNotMatch(css, /\.msg-nova > \.prose[^{]*\{[^}]*(background|border):/, 'Nova’s words sit on the page, not in a box');
  assert.match(css, /\.msg-nova > \.prose[^{]*\{[^}]*max-width: \d+ch/, 'Nova’s prose is capped to a readable measure');
  const comp = readFileSync('ui/styles/components.css', 'utf8');
  assert.doesNotMatch(comp, /bubble-body \{[^}]*border-(bottom|top)-(left|right)-radius/);
});

test('chat: a group is one author within five minutes; its first message shows the time', () => {
  assert.equal(GROUP_MS, 5 * 60_000);
  const h = html();
  // Leads: 9:00 you, 9:00 Nova, 9:03 you, 9:03 Nova, 11:30 you, 11:30 Nova, then the next day’s two.
  const leads = [...h.matchAll(/<time class="when is-lead"[^>]*>\s*<span class="when-short"[^>]*>([^<]+)</g)].map((m) => m[1]);
  assert.deepEqual(leads, ['9:00 AM', '9:00 AM', '9:03 AM', '9:03 AM', '11:30 AM', '11:30 AM', '8:00 AM', '8:00 AM']);
  // Nova’s follow-up at 9:02 joins Nova’s group from 9:00: no time of its own on show.
  const all = [...h.matchAll(/<time class="when( is-lead)?" datetime="([^"]+)"/g)].map((m) => [m[2], !!m[1]]);
  assert.deepEqual(all.find(([d]) => d === at('09:02:30')), [at('09:02:30'), false]);
  assert.equal(all.length, 9, 'every message carries its exact time');
});

test('chat: every message’s exact time is there to reveal; dividers mark days and long gaps', () => {
  const h = html();
  assert.equal((h.match(/class="when-exact"/g) ?? []).length, 9);
  assert.match(h, /<time class="when" datetime="2026-10-28T09:02:30.000Z" tabindex="0"/, 'reachable by keyboard focus');
  assert.match(h, /Wednesday, October 28, 2026, 9:02:30 AM/);
  assert.equal((h.match(/class="dateline"/g) ?? []).length, 2, 'one per day');
  const gaps = [...h.matchAll(/class="gap-divider"[^>]*><time datetime="([^"]+)">([^<]+)</g)].map((m) => m[2]);
  assert.deepEqual(gaps, ['11:30 AM'], 'a gap of an hour or more gets its own divider');
  assert.equal(GAP_MS, 60 * 60_000);
});

test('chat: a work-trail entry says how long it took and when it finished', () => {
  const h = html();
  assert.match(h, /<span class="record-time">took 2 s, finished <time datetime="2026-10-28T09:00:05.000Z">9:00 AM<\/time><\/span>/);
});

// ---- settings -------------------------------------------------------------------------------------

test('settings: one structure, grouped by task, one level deep, every part in exactly one place', () => {
  const parts = CATEGORIES.flatMap((c) => c.parts);
  assert.deepEqual([...parts].sort(), ['capture', 'changes', 'checkpoints', 'connections', 'danger', 'devices', 'look', 'models', 'perms', 'privacy', 'providers', 'services', 'sites', 'you']);
  assert.equal(new Set(parts).size, parts.length);
  for (const c of CATEGORIES) {
    assert.ok(c.label && c.summary && GROUPS.some((g) => g.cats.includes(c.id)), c.id);
    assert.equal(c.children, undefined, `${c.id}: no deeper level`);
  }
  assert.equal(CATEGORIES.at(-1).id, 'danger', 'starting over stays last, set apart');
  for (const e of ENTRIES) assert.ok(CATEGORIES.some((c) => c.id === e.cat), e.label);
  // M10b: Nova Browser's sign-ins, found by the words people use.
  for (const q of ['site sign-ins', 'saved passwords', 'logins', 'cookies', 'browser']) assert.equal(searchSettings(q)[0]?.target, 'browser-sites', q);
});

test('settings search knows people’s words, not just labels, and shows the path', () => {
  const top = (q) => searchSettings(q)[0];
  for (const q of ['theme', 'dark mode', 'colours', 'Colors', 'look']) assert.equal(categoryOf(top(q).cat).label, 'Appearance', q);
  assert.equal(top('theme').path, 'Appearance › Theme');
  assert.equal(top('dark mode').path, 'Appearance › Light and dark');
  for (const q of ['phone', 'pair', 'pairing', 'add a device']) assert.equal(top(q).cat, 'devices', q);
  assert.equal(top('backup').cat, 'backups');
  assert.equal(top('erase').cat, 'danger');
  assert.equal(top('apikey') ?? null, null, 'nothing is better than a wrong answer');
  assert.equal(top('api key').cat, 'models');
  assert.equal(top('thme').path, 'Appearance › Theme', 'one slip of the keyboard is forgiven');
  assert.deepEqual(searchSettings(''), []);
  for (const r of searchSettings('a')) assert.ok(r.target && r.path.includes(' › '));
});

// ---- the live contrast check and the recommendation -----------------------------------------------

const builtins = () => readdirSync(BUILTIN_DIR).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(readFileSync(join(BUILTIN_DIR, f), 'utf8')));

test('the page’s live check reads colours the way the core does, and agrees with it', () => {
  assert.deepEqual(clientParse('#062a30'), [6, 42, 48, 1]);
  assert.deepEqual(clientParse('rgba(202, 237, 234, 0.42)'), [202, 237, 234, 0.42]);
  assert.deepEqual(clientParse('rgb(1 2 3 / 0.5)'), [1, 2, 3, 0.5]);
  const checks = LIVE_CHECKS.map(([fg, bg, min, kind, what]) => ({ fg, bg, min, kind, what }));
  const mist = JSON.parse(readFileSync('tests/core/fixtures/design-system.json', 'utf8'));
  Object.assign(mist.tokens, { 'border/strong': '#d3d7dc', 'bg/raised': '#d9dde3', 'accent/primary': '#234a8c', 'text/secondary': '#5f6872' });
  for (const pkg of [...builtins(), mist]) {
    for (const t of Object.values(looks(pkg))) {
      const core = liveCheck(t);
      const page = clientCheck((name) => t[name], checks);
      assert.equal(page.ok, core.ok, pkg.id);
      assert.deepEqual(page.failures.map((f) => [f.fg, f.bg, f.ratio]), core.results.filter((r) => !r.ok).map((r) => [r.fg, r.bg, r.ratio]), pkg.id);
    }
  }
});

function list() {
  const db = new Db(':memory:');
  db.migrate();
  const design = new Design({ extensions: new Extensions({ db, home: mkdtempSync(join(tmpdir(), 'nova-rec-')), novaVersion: '0.1.0' }), profile: new Profile(db) });
  design.ensureBuiltins();
  return design.list();
}

test('Nova recommends one design, with a reason: its own design at the bar first, else the starter that fits and reads well', () => {
  const l = list();
  // Packages aren't equals (DESIGN-SYSTEM §0, owner direction 2026-11-01): the lead, at the bar.
  assert.deepEqual(l.filter((d) => d.at_bar).map((d) => d.id), ['orb-teal']);
  assert.equal(l.find((d) => d.id === 'orb-teal').lead, true);
  const dark = recommend(l, { mode: 'auto', prefers: 'dark' });
  assert.equal(dark.id, 'orb-teal');
  assert.match(dark.reason, /design bar.*Dark/);
  assert.match(dark.reason, /contrast/);
  // A light device still gets Nova's own design, told plainly it is dark and why.
  const light = recommend(l, { mode: 'auto', prefers: 'light' });
  assert.equal(light.id, 'orb-teal');
  assert.match(light.reason, /It’s dark: no light design has reached the bar yet/);
  assert.equal(recommend(l, { mode: 'light', prefers: 'dark' }).id, 'orb-teal');
  // With no design at the bar, the starter that fits the device.
  const unranked = l.map((d) => ({ ...d, at_bar: false }));
  assert.equal(recommend(unranked, { mode: 'auto', prefers: 'light' }).id, 'companion-light');
  assert.match(recommend(unranked, { mode: 'auto', prefers: 'light' }).reason, /light/);
  assert.equal(recommend(unranked, { mode: 'dark', prefers: 'light' }).id, 'orb-teal', 'an explicit choice beats the system');
  // Without the starters, the best-reading design that fits.
  const others = unranked.filter((d) => !d.starter);
  assert.equal(recommend(others, { mode: 'auto', prefers: 'light' }).looks.default.scheme, 'light');
  assert.ok(recommend(others, { mode: 'auto', prefers: 'light' }).reason.length < 160, 'a short reason');
});

// ---- CSS: timestamps, scrolling -----------------------------------------------------------------

const styles = () => readdirSync('ui/styles').filter((f) => f.endsWith('.css')).map((f) => [f, readFileSync(`ui/styles/${f}`, 'utf8')]);

test('timestamps use a colour that passes 4.5:1 in every package, never the faint one', () => {
  const css = styles().map(([, s]) => s).join('\n');
  for (const sel of ['.when', '.when-exact', '.gap-divider', '.dateline', '.record-time', '.act-time']) {
    const rule = new RegExp(`(^|\\n|, )${sel.replace('.', '\\.')}( |,)[^{]*\\{([^}]*)\\}`).exec(css);
    assert.ok(rule, `${sel} has a rule`);
    assert.match(rule[3], /color: var\(--text-(secondary|primary)\)/, `${sel} uses text/secondary or text/primary`);
  }
  for (const pkg of builtins()) for (const [look, t] of Object.entries(looks(pkg))) {
    for (const bg of ['bg/base', 'bg/raised', 'surface/card']) {
      const r = liveCheck(t).results.find((x) => x.fg === 'text/secondary' && x.bg === bg);
      assert.ok(r.ratio >= 4.5, `${pkg.id} ${look}: text/secondary on ${bg} is ${r.ratio}:1`);
    }
  }
});

test('scrolling: the OS scrollbar, a stable gutter, and no vertical scroller inside a view', () => {
  for (const [f, s] of styles()) {
    assert.doesNotMatch(s, /scrollbar-width|scrollbar-color|::-webkit-scrollbar/, `${f}: no custom scrollbars`);
  }
  const comp = readFileSync('ui/styles/components.css', 'utf8');
  assert.match(comp, /\.scroller \{[^}]*scrollbar-gutter: stable/);
  const views = readFileSync('ui/styles/views.css', 'utf8') + comp;
  // Inner boxes that used to scroll up and down inside the page.
  for (const sel of ['.record-output', '.approval-letter', '.raw pre', '.code-block pre', '.table-wrap']) {
    const rule = new RegExp(`${sel.replace(/[.]/g, '\\.')} \\{([^}]*)\\}`).exec(views);
    assert.ok(rule, sel);
    assert.doesNotMatch(rule[1], /max-height/, `${sel} grows with its content`);
    assert.doesNotMatch(rule[1], /overflow: auto|overflow-y: (auto|scroll)/, `${sel} never scrolls up and down`);
    if (/overflow-x: auto/.test(rule[1])) assert.match(rule[1], /overflow-y: hidden/, `${sel} scrolls sideways only`);
  }
});

// Every module the app loads is in the offline shell, or Nova can't open without a connection.
// (Found by the offline browser test when settings-ia.js and contrast.js were new.)
test('the service worker caches every module the app imports', () => {
  const shell = readFileSync('ui/sw.js', 'utf8');
  const seen = new Set();
  const walk = (file) => {
    if (seen.has(file)) return;
    seen.add(file);
    for (const m of readFileSync(`ui/js/${file}`, 'utf8').matchAll(/(?:^|\n)\s*import\s[^'"]*['"]\.\/([\w-]+\.js)['"]/g)) walk(m[1]);
  };
  walk('app.js');
  for (const f of seen) assert.match(shell, new RegExp(`'/js/${f.replace('.', '\\.')}'`), `${f} is in the shell`);
  assert.ok(seen.has('settings-ia.js') && seen.has('contrast.js'));
});
