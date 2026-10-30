// The person's capture rules alone (src/core/capture/rules.ts): private contexts, each exclusion
// kind, weekly time windows in the person's time zone, and classification by their signals only,
// with ambiguous activity left unclassified. Plus Screenpipe items read into raw events.
// Neutral placeholders only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkExclusions, checkSignals, checkSwitch, classify, excludedBy, inWindow, isPrivate, type Facts } from '../../src/core/capture/rules.ts';
import { normalize } from '../../src/core/capture/screenpipe.ts';

const f = (o: Partial<Facts> = {}): Facts => ({ kind: 'screen', at: '2026-11-02T10:30:00.000Z', device_id: 'dev-a', source_id: 'src-a', app: 'Editor', window_title: 'notes.txt', url: null, ...o });

test('private and incognito contexts are recognised, by the source’s mark or the window’s title', () => {
  assert.equal(isPrivate({}, f()), false);
  assert.equal(isPrivate({ private: true }, f()), true);
  assert.equal(isPrivate({ incognito: true }, f()), true);
  for (const t of ['New Incognito Tab - Browser', 'InPrivate - Browser', 'Private Browsing — Browser', 'Example (Private)', 'A Private Window']) {
    assert.equal(isPrivate({}, f({ window_title: t })), true, t);
  }
  assert.equal(isPrivate({}, f({ window_title: 'Privacy policy — Example' })), false, 'a page about privacy is not a private window');
});

test('time windows: weekdays, past midnight, in the person’s time zone', () => {
  const lunch = { days: [1, 2, 3, 4, 5], start: '12:00', end: '13:00' };
  assert.equal(inWindow('2026-11-02T12:30:00Z', lunch, 'UTC'), true, 'Monday 12:30');
  assert.equal(inWindow('2026-11-02T13:00:00Z', lunch, 'UTC'), false, 'the end is not inside');
  assert.equal(inWindow('2026-11-01T12:30:00Z', lunch, 'UTC'), false, 'Sunday');
  // 12:30 in UTC is 07:30 in New York: outside; 17:30 UTC is 12:30 there: inside.
  assert.equal(inWindow('2026-11-02T12:30:00Z', lunch, 'America/New_York'), false);
  assert.equal(inWindow('2026-11-02T17:30:00Z', lunch, 'America/New_York'), true);
  const night = { days: [5], start: '22:00', end: '06:00' };
  assert.equal(inWindow('2026-11-06T23:00:00Z', night, 'UTC'), true, 'Friday 23:00');
  assert.equal(inWindow('2026-11-07T05:00:00Z', night, 'UTC'), true, 'Saturday 05:00 belongs to Friday night');
  assert.equal(inWindow('2026-11-08T05:00:00Z', night, 'UTC'), false, 'Sunday 05:00 does not');
});

test('each exclusion kind keeps an event out: app, site (address or title), space, time window; scoped to a source when it says', () => {
  const rules = checkExclusions([
    { kind: 'app', app: 'password keeper' },
    { kind: 'site', site: 'https://www.bank.example/login' },
    { kind: 'space', space: 'health' },
    { kind: 'time', window: { start: '18:00', end: '19:00' } },
    { kind: 'app', app: 'Chat', source: 'src-b' },
  ]);
  assert.deepEqual(rules[1], { kind: 'site', site: 'bank.example' }, 'a site is kept as its host');
  assert.equal(excludedBy(f(), rules, 'UTC'), null);
  assert.equal(excludedBy(f({ app: 'Password Keeper' }), rules, 'UTC')?.kind, 'app');
  assert.equal(excludedBy(f({ url: 'https://accounts.bank.example/x' }), rules, 'UTC')?.kind, 'site');
  assert.equal(excludedBy(f({ window_title: 'Statement — bank.example' }), rules, 'UTC')?.kind, 'site', 'a title naming the site');
  assert.equal(excludedBy(f({ space: 'health' }), rules, 'UTC')?.kind, 'space');
  assert.equal(excludedBy(f({ at: '2026-11-02T18:15:00Z' }), rules, 'UTC')?.kind, 'time');
  assert.equal(excludedBy(f({ app: 'Chat' }), rules, 'UTC'), null, 'only for the source it names');
  assert.equal(excludedBy(f({ app: 'Chat', source_id: 'src-b' }), rules, 'UTC')?.kind, 'app');
  assert.throws(() => checkExclusions([{ kind: 'folder', path: '/x' }]), /kind is one of/);
  assert.throws(() => checkExclusions([{ kind: 'time', window: { start: '9am', end: '10:00' } }]), /start and an end/);
  assert.throws(() => checkExclusions([{ kind: 'site', site: 'not a site' }]), /names a site/);
});

test('classification: only the person’s signals; disagreement or none stays unclassified; the switch wins while on', () => {
  const signals = checkSignals([
    { kind: 'app', app: 'Editor', space: 'work' },
    { kind: 'app', app: 'Game', space: 'personal' },
    { kind: 'device', device: 'dev-b', space: 'personal' },
    { kind: 'calendar', window: { days: [1, 2, 3, 4, 5], start: '09:00', end: '17:00' }, space: 'work' },
  ]);
  assert.deepEqual(classify(f(), signals, null, 'UTC'), { space: 'work', by: 'signal:app+calendar' }, 'two signals that agree');
  assert.deepEqual(classify(f({ app: 'Notes', at: '2026-11-02T20:00:00Z' }), signals, null, 'UTC'), null, 'no signal: unclassified, never a guess');
  assert.deepEqual(classify(f({ app: 'Game' }), signals, null, 'UTC'), null, 'a personal app in working hours: ambiguous, unclassified');
  assert.deepEqual(classify(f({ app: 'Game', at: '2026-11-02T20:00:00Z' }), signals, null, 'UTC'), { space: 'personal', by: 'signal:app' });
  assert.deepEqual(classify(f({ device_id: 'dev-b', app: null, at: '2026-11-01T10:00:00Z' }), signals, null, 'UTC'), { space: 'personal', by: 'signal:device' });
  const sw = checkSwitch({ space: 'study', since: '2026-11-02T10:00:00Z', until: '2026-11-02T11:00:00Z' })!;
  assert.deepEqual(classify(f({ app: 'Game' }), signals, sw, 'UTC'), { space: 'study', by: 'switch' }, 'the explicit switch wins');
  assert.deepEqual(classify(f({ at: '2026-11-02T11:30:00Z' }), signals, sw, 'UTC'), { space: 'work', by: 'signal:app+calendar' }, 'and ends when it says');
  assert.throws(() => checkSignals([{ kind: 'folder', path: '/home/x/work', space: 'work' }]), /Folder paths are never used/);
  assert.throws(() => checkSignals([{ kind: 'app', app: 'Editor', space: 'Not A Space' }]), /space/);
});

test('Screenpipe items read into raw events: OCR, audio, UI; unreadable ones skipped', () => {
  assert.deepEqual(normalize('ocr', { type: 'OCR', content: { frame_id: 7, text: 'Draft agenda', timestamp: '2026-11-02T09:00:00Z', app_name: 'Editor', window_name: 'agenda.md', browser_url: 'https://docs.example/a' } }), {
    external_id: 'ocr:7', kind: 'screen', at: '2026-11-02T09:00:00.000Z', app: 'Editor', window_title: 'agenda.md', url: 'https://docs.example/a', text: 'Draft agenda',
  });
  assert.deepEqual(normalize('audio', { type: 'Audio', content: { chunk_id: 3, transcription: 'hello there', timestamp: '2026-11-02T09:01:00Z', device_name: 'Microphone' } }), {
    external_id: 'audio:3', kind: 'audio', at: '2026-11-02T09:01:00.000Z', app: null, window_title: 'Microphone', url: null, text: 'hello there',
  });
  assert.equal(normalize('ui', { type: 'UI', content: { id: 5, text: 'x', timestamp: '2026-11-02T09:02:00Z', app_name: 'A', window_name: 'B' } })?.external_id, 'ui:5');
  assert.equal(normalize('ocr', { type: 'OCR', content: { frame_id: 8, text: 'x', timestamp: 'yesterday' } }), null);
  assert.equal(normalize('ocr', { nope: 1 }), null);
  assert.equal(normalize('ocr', { type: 'OCR', content: { frame_id: 9, text: 'x', timestamp: '2026-11-02T09:00:00Z', private: true } })?.private, true);
});

// ---- review fixes (M6 capture review) --------------------------------------------------------------

test('private windows in the major browsers’ languages, by title, address or a marker past where a title is cut', () => {
  const titles = [
    'Nouvel onglet — Navigation privée de Mozilla Firefox', // FR Firefox
    'Neuer Tab — Mozilla Firefox (Privater Modus)', // DE Firefox
    'Neuer Tab - Google Chrome (Inkognito)', // DE Chrome
    'Nueva pestaña - Google Chrome (Incógnito)', // ES Chrome
    'Nueva pestaña — Navegación privada de Mozilla Firefox', // ES Firefox
    'Nuova scheda — Navigazione anonima di Mozilla Firefox', // IT Firefox
    'Nova guia anônima - Google Chrome', // PT-BR Chrome
    'Nova janela — Navegação privada do Mozilla Firefox', // PT Firefox
    'Nieuw tabblad — Mozilla Firefox Privénavigatie', // NL Firefox
    'Nieuw tabblad - Microsoft Edge InPrivate', // NL Edge
    'Nouvel onglet - Brave (Fenêtre privée)', // FR Brave
    'Start Page - Vivaldi (Private)', // Vivaldi
    'Private Browsing', // Safari's own window
  ];
  for (const t of titles) assert.equal(isPrivate({}, { app: 'Browser', window_title: t, url: null }), true, t);
  assert.equal(isPrivate({}, { app: 'Firefox', window_title: 'x', url: 'about:privatebrowsing' }), true, 'the address');
  const long = `${'Long page title '.repeat(19)} — Mozilla Firefox Private Browsing`;
  assert.ok(long.length > 300);
  assert.equal(isPrivate({}, { app: 'Firefox', window_title: long, url: null }), true, 'past 300 characters');
  for (const t of ['Privacy policy — Example', 'Private equity weekly - Reader', 'Navigation — Example']) {
    assert.equal(isPrivate({}, { app: 'Browser', window_title: t, url: null }), false, t);
  }
});

test('exclusions cover what the person meant: a site in a browser’s text, a fully qualified host, app editions, a stretch of time', async () => {
  const { overlapsWindow } = await import('../../src/core/capture/rules.ts');
  const rules = checkExclusions([{ kind: 'site', site: 'bank.example.' }, { kind: 'app', app: 'Signal' }, { kind: 'time', window: { start: '12:00', end: '13:00' } }]);
  assert.deepEqual(rules[0], { kind: 'site', site: 'bank.example' }, 'a trailing dot is the same host');
  const site = (o: Partial<Facts>) => excludedBy(f({ app: 'Browser', window_title: 'Account summary', ...o }), rules.slice(0, 1), 'UTC')?.kind ?? null;
  assert.equal(site({ text: 'bank.example/accounts balance' }), 'site', 'the host in a browser’s screen text');
  assert.equal(site({ app: 'Google Chrome', text: 'https://online.bank.example/login' }), 'site', 'a subdomain, in Chrome');
  assert.equal(site({ text: 'notbank.example is another place' }), null, 'not part of a longer name');
  assert.equal(site({ app: 'Editor', text: 'notes about bank.example' }), null, 'only a browser’s text');
  assert.equal(site({ url: 'https://bank.example./acct' }), 'site', 'a fully qualified address');
  assert.equal(site({ window_title: 'Statement — www.bank.example.' }), 'site');
  const app = (name: string) => excludedBy(f({ app: name }), rules.slice(1, 2), 'UTC')?.kind ?? null;
  for (const name of ['Signal', 'signal', 'Signal.exe', 'Signal.app', '  Signal   Beta ', 'Signal Beta']) assert.equal(app(name), 'app', name);
  assert.equal(app('Signalling Tool'), null, 'a word prefix, not any prefix');
  // A stretch that starts before a window and runs into it.
  assert.equal(overlapsWindow('2026-11-02T11:50:00Z', '2026-11-02T12:05:00Z', { start: '12:00', end: '13:00' }, 'UTC'), true);
  assert.equal(overlapsWindow('2026-11-02T11:00:00Z', '2026-11-02T11:59:00Z', { start: '12:00', end: '13:00' }, 'UTC'), false);
  assert.equal(excludedBy(f({ kind: 'audio', app: null, at: '2026-11-02T11:50:00Z', ended_at: '2026-11-02T12:10:00Z' }), rules.slice(2), 'UTC')?.kind, 'time', 'audio, over its whole stretch');
});

test('an instant says its own time zone, or it isn’t one', async () => {
  const { instant } = await import('../../src/core/capture/rules.ts');
  assert.equal(instant('2026-10-29T10:00:00Z'), '2026-10-29T10:00:00.000Z');
  assert.equal(instant('2026-10-29T12:00:00+02:00'), '2026-10-29T10:00:00.000Z');
  assert.equal(instant('2026-10-29T10:00:00.123456Z'), '2026-10-29T10:00:00.123Z', 'Screenpipe’s microseconds');
  for (const v of ['2026-10-29 10:00:00', '2026-10-29T10:00:00', 'Oct 29 2026 10:00', '2026-10-29', 1761732000000]) assert.equal(instant(v), null, String(v));
});
