// UI rebuild compositions (design-first, 2026-11-06): full-screen pictures of the shell and chat,
// Settings, About, the changelog and the pipeline dashboard, and the Nebula orb, for the owner's
// reaction. Styleguide only: nothing here is imported by the app, nothing is sent anywhere, and
// every link and control is a specimen. Diffed against docs/builder-packet/ui-references/, not
// against the Stage-2 look. Its CSS is ui/styles/compositions.css; its container breakpoints are in
// ui/styles/layout.css (the one file breakpoints may live in), scoped to .uc-*.
import { ICONS } from './components.js';
import { ORB_STATES } from './status.js';

// Every frame the compositions draw: [kind, state, what it shows].
export const UC_FRAMES = [
  ['shell-chat', 'empty', 'An empty new chat'],
  ['shell-chat', 'reply', 'Mid-reply: a tool step and a citation'],
  ['shell-chat', 'rail', 'Rail collapsed (desktop) / open as a drawer (phone)'],
  ['shell-chat', 'palette', 'Command palette open'],
  ['settings', 'top', 'Top level'],
  ['settings', 'privacy', 'Privacy, with search active'],
  ['about', 'current', 'Running the latest merged build'],
  ['about', 'pending', 'Redeploy pending'],
  ['about', 'unknown', 'Latest merged build unknown'],
  ['changelog', 'list', 'Newest first, running version pinned'],
  ['pipeline', 'tracks', 'Tracks and milestones (sample data)'],
  ['orb', 'states', 'The seven states, moving and still'],
];

// Sample builds. Running and latest are real merge commits on main (2026-11-06).
const BUILD = { version: '0.1.0-alpha.1', running: 'b66f2c5', built: 'Nov 6, 2026, 21:02 UTC', latest: 'b66f2c5' };
const PENDING = { ...BUILD, running: '8001cd2', built: 'Nov 6, 2026, 18:40 UTC' };

const PR = (n) => `https://github.com/jeremyspofford/nova/pull/${n}`;
const DOC = (p) => `https://github.com/jeremyspofford/nova/blob/main/${p}`;

// The supernova (owner, 2026-11-06): an N for Nova. Two arms trace the N around a black hole that
// everything falls into: the left arm rises from the lower left and curls over the top, the right
// arm comes down the right side and curls under, and between them the band sweeps diagonally
// through the centre. Each arm is a spiral pushed out toward the corners of a rounded square (so
// the N fills the icon), cut into short segments whose colour steps smoothly, wide and deep at the
// rim, thinner and brighter as it falls in, with a lit ridge along its inner edge. Every colour is a
// design token or a mix of two; none is written here.
const ARM_A = ['color-mix(in srgb, var(--orb-c) 55%, var(--accent-secondary))', 'var(--orb-c)', 'var(--orb-c)', 'color-mix(in srgb, var(--orb-c) 65%, var(--orb-hi))'];
const ARM_B = ['var(--accent-secondary)', 'color-mix(in srgb, var(--orb-listening) 40%, var(--accent-secondary))', 'var(--orb-listening)', 'var(--orb-attention)', 'var(--orb-attention)'];
const squircle = (phi) => 1 / (Math.abs(Math.cos(phi)) ** 4 + Math.abs(Math.sin(phi)) ** 4) ** 0.25;
const SWEEP = 4.7;
const SEG = 24;
const pt = (x, y) => `${x.toFixed(2)} ${y.toFixed(2)}`;
function armPaths(stops, start, lit) {
  const tone = (u) => {
    const at = u * (stops.length - 1);
    const i = Math.min(Math.floor(at), stops.length - 2);
    return `color-mix(in srgb, ${stops[i + 1]} ${Math.round((at - i) * 100)}%, ${stops[i]})`;
  };
  const at = (u) => {
    const phi = start + u * SWEEP;
    const r = 44 * Math.exp(-0.3 * u * SWEEP) * (1 + (squircle(phi) - 1) * (1 - u) ** 1.5);
    return { phi, r, w: 4 + 22 * (1 - u) ** 0.9 };
  };
  // The body: opaque segments that overlap a little, so no seam shows where they meet.
  let body = '';
  for (let s = 0; s < SEG; s++) {
    const u0 = s / SEG;
    const u1 = Math.min(1, (s + 1) / SEG + 0.02);
    const line = [];
    for (let k = 0; k <= 4; k++) {
      const { phi, r } = at(u0 + ((u1 - u0) * k) / 4);
      line.push(pt(50 + r * Math.cos(phi), 50 + r * Math.sin(phi)));
    }
    body += `<path d="M${line.join('L')}" stroke-width="${at((u0 + u1) / 2).w.toFixed(1)}" style="stroke: ${tone((u0 + u1) / 2)}"/>`;
  }
  // The lit ridge: one continuous line along the arm's inner edge, so nothing doubles.
  const ridge = [];
  for (let k = 0; k <= 80; k++) {
    const { phi, r, w } = at(0.15 + (0.85 * k) / 80);
    ridge.push(pt(50 + (r - w * 0.28) * Math.cos(phi), 50 + (r - w * 0.28) * Math.sin(phi)));
  }
  return { body, ridge: `<path d="M${ridge.join('L')}" style="stroke: ${lit}"/>` };
}
// Stars: deterministic (the same sky every time), many tiny points of varied brightness, a few larger.
function starField(n, w, h, seed) {
  let x = seed;
  const rnd = () => { x = (x * 16807) % 2147483647; return x / 2147483647; };
  let out = '';
  for (let i = 0; i < n; i++) {
    const big = rnd() < 0.06;
    out += `<circle cx="${(rnd() * w).toFixed(1)}" cy="${(rnd() * h).toFixed(1)}" r="${(big ? 0.3 + rnd() * 0.18 : 0.07 + rnd() * 0.14).toFixed(2)}" fill-opacity="${(0.25 + rnd() * 0.75).toFixed(2)}"/>`;
  }
  return out;
}
const A = armPaths(ARM_A, (3 * Math.PI) / 4, 'color-mix(in srgb, var(--orb-c) 60%, var(--orb-hi))');
const B = armPaths(ARM_B, (7 * Math.PI) / 4, 'color-mix(in srgb, var(--orb-listening) 70%, var(--orb-attention))');
const ARMS = `<g fill="none" stroke-linecap="butt">${A.body}${B.body}</g>`;
// Everything an orb draws: the sky (behind the arms, so it shows in the dark between them), the arms,
// their lit ridges, the accretion edge round the hole (teal inner rim, the coral arc hugging it from
// below), and a second copy of the arms that falls inward while Nova is active (the inflow).
const NOVA = `<svg class="orb-sky" viewBox="0 0 100 100" aria-hidden="true" focusable="false">${starField(320, 100, 100, 7)}</svg>`
  + `<svg class="orb-spiral" viewBox="0 0 100 100" aria-hidden="true" focusable="false">${ARMS}<g class="orb-ridge" fill="none" stroke-linecap="butt">${A.ridge}${B.ridge}</g>`
  + '<g class="orb-accretion" fill="none" stroke-linecap="round"><circle cx="50" cy="50" r="10.6"/><path d="M62.56 53.36A13 13 0 0 1 37.44 53.36"/></g></svg>'
  + `<svg class="orb-inflow" viewBox="0 0 100 100" aria-hidden="true" focusable="false"><g class="orb-fall">${ARMS}</g></svg>`;
// A band of the same sky for identity moments (the empty new chat, About, the icon): low contrast,
// screen-blended so it vanishes on a light theme, never behind text.
export const SKY_BAND = `<svg class="uc-sky" viewBox="0 0 400 100" preserveAspectRatio="xMidYMid slice" aria-hidden="true" focusable="false">${starField(260, 400, 100, 11)}</svg>`;

// The Nebula orb: the orb's own markup and state vocabulary (data-state drives the design's
// motion, light and mark variables), drawn as the supernova from the owner's icon.
export function nebulaOrb({ state = 'idle', size = 'rail', label = null } = {}) {
  const words = label ?? `Nova: ${state.replace('-', ' ')}`;
  return `<span class="orb orb-${size} orb-nebula" data-state="${state}" role="img" aria-label="${words}"><span class="orb-glow"></span><span class="orb-field"></span>${NOVA}<span class="orb-eye"></span></span>`;
}

const icon = (name) => ICONS[name] ?? '';
const kbd = (k) => `<kbd class="uc-kbd">${k}</kbd>`;

// ---- the shell ---------------------------------------------------------------------------------

const NAV = [['chat', 'Chat'], ['home', 'Home'], ['tasks', 'Tasks', 2], ['memory', 'Memory'], ['activity', 'Activity'], ['device', 'Devices'], ['settings', 'Settings']];
const RECENT = ['Friday plan', 'Reply to the landlord', 'Train times for March', 'Check the backup'];
const SPACES = [['Home', 'home'], ['Work', 'tasks'], ['Study desktop', 'device'], ['Cabin', 'brief']];

function stamp(id, build, pending) {
  const said = pending ? `${build.version} ${build.running} redeploy pending: latest merged is ${build.latest}` : `${build.version} ${build.running}`;
  return `<a class="uc-stamp${pending ? ' is-pending' : ''}" href="#${id}-about" aria-label="${said}. About Nova"><span class="uc-ic uc-stamp-ic" aria-hidden="true">${icon('health')}</span>${pending ? '<span class="uc-dot" aria-hidden="true"></span>' : ''}<span>${build.version}</span> <span class="uc-mono">${build.running}</span>${pending ? ' <span>redeploy pending</span>' : ''}</a>`;
}

function rail(id, { active = 'chat', recent = 0, pending = false } = {}) {
  return `<div class="uc-rail">
<div class="uc-rail-head"><button type="button" class="uc-row uc-space-btn" aria-label="Space: Home. Switch space"><span class="uc-space-mark" aria-hidden="true">${nebulaOrb({ size: 'mini', label: '' }).replace('role="img" aria-label=""', 'aria-hidden="true"')}</span><span class="uc-label">Home</span><span class="uc-chev" aria-hidden="true">${icon('chevron')}</span></button>
<button type="button" class="uc-icon" aria-label="Search or jump (Ctrl K)">${icon('search')}</button><button type="button" class="uc-icon" aria-label="New chat">${icon('plus')}</button></div>
<nav class="uc-nav" aria-label="Places">${NAV.map(([ic, name, n]) => `<a class="uc-row${ic === active ? ' is-on' : ''}" href="#${id}-${ic}"${ic === active ? ' aria-current="page"' : ''} aria-label="${name}${n ? ` ${n} waiting` : ''}"><span class="uc-ic" aria-hidden="true">${icon(ic)}</span><span class="uc-label">${name}</span>${n ? ` <span class="uc-count">${n}</span>` : ''}</a>`).join('')}</nav>
<p class="uc-group">Recent</p>
<nav class="uc-nav uc-recent" aria-label="Recent conversations">${RECENT.map((t, i) => `<a class="uc-row${active === 'chat' && i === recent ? ' is-on' : ''}" href="#${id}-r${i}"><span class="uc-ic" aria-hidden="true">${icon('chat')}</span><span class="uc-label">${t}</span></a>`).join('')}</nav>
<div class="uc-rail-foot"><div class="uc-spaces" role="group" aria-label="Spaces">${SPACES.map(([name, ic], i) => `<button type="button" class="uc-icon${i === 0 ? ' is-on' : ''}" aria-label="Space: ${name}"${i === 0 ? ' aria-pressed="true"' : ' aria-pressed="false"'}>${icon(ic)}</button>`).join('')}</div>${stamp(id, pending ? PENDING : BUILD, pending)}</div>
</div>`;
}

function topbar(id, title, orbState = 'idle') {
  return `<header class="uc-top"><button type="button" class="uc-icon uc-menu" aria-label="Open navigation">${icon('panel')}</button><h2 class="uc-title">${title}</h2>${nebulaOrb({ state: orbState, size: 'mini' })}</header>`;
}

function screen(kind, state, body, { rail: railHtml = '', mode = '' } = {}) {
  return `<div class="uc-screen${mode ? ` ${mode}` : ''}" data-uc-frame="${kind}-${state}">${railHtml}<div class="uc-main">${body}</div></div>`;
}

function composer(id, { replying = false, big = false } = {}) {
  return `<form class="uc-composer${big ? ' is-big' : ''}" onsubmit="return false"><label class="sr-only" for="${id}-ask">Message Nova</label><textarea id="${id}-ask" rows="${big ? 2 : 1}" placeholder="${replying ? 'Reply to Nova…' : 'Ask Nova anything…'}"></textarea>
<div class="uc-composer-bar"><button type="button" class="uc-icon" aria-label="Add a file">${icon('plus')}</button><button type="button" class="uc-quiet" aria-label="Privacy: local only. Change">Local only</button><span class="uc-spacer"></span><button type="button" class="uc-icon" aria-label="Talk to Nova">${icon('mic')}</button>${replying ? `<button type="button" class="uc-send is-stop" aria-label="Stop">${icon('stop')}</button>` : `<button type="button" class="uc-send" aria-label="Send">${icon('send')}</button>`}</div></form>`;
}

function emptyChat(id) {
  return `${topbar(id, 'New chat')}<div class="uc-chat uc-chat-empty"><div class="uc-hero">${SKY_BAND}${nebulaOrb({ state: 'idle', size: 'hero', label: 'Nova is here' })}</div><h3 class="uc-greet">Good evening, Alex</h3>${composer(id, { big: true })}
<div class="uc-chips" role="group" aria-label="Suggestions">${['What needs me today?', 'Plan Friday', 'Check the repo'].map((s) => `<button type="button" class="uc-chip">${s}</button>`).join('')}</div></div>`;
}

function replyChat(id) {
  return `${topbar(id, 'Friday plan', 'working')}<div class="uc-chat"><div class="uc-thread">
<p class="uc-you">What does Friday look like? Check my notes and the calendar.</p>
<div class="uc-nova">
<details class="uc-steps" open><summary class="uc-row uc-steps-head"><span class="uc-ic" aria-hidden="true">${icon('check')}</span><span>2 steps</span><span class="uc-faint">1.4 s</span></summary>
<ol class="uc-step-list"><li class="uc-step"><span class="uc-ic" aria-hidden="true">${icon('check')}</span><span>Read your notes</span><span class="uc-mono uc-faint">memory/2026-10-20.md</span></li>
<li class="uc-step"><span class="uc-ic" aria-hidden="true">${icon('check')}</span><span>Searched the calendar</span><span class="uc-faint">3 events on Friday</span></li></ol></details>
<p>Friday has one piece of outside work: the client migration, about two hours.<sup class="uc-cite">1</sup> The car service is booked for 9:00,<sup class="uc-cite">2</sup> so the migration fits best after 11. I’d keep the afternoon<span class="uc-caret" aria-hidden="true"></span></p>
<ol class="uc-sources" aria-label="Sources"><li><a class="uc-source" href="#${id}-s1"><span class="uc-cite">1</span><span class="uc-mono">memory/2026-10-20.md</span><span class="uc-faint">your notes</span></a></li><li><a class="uc-source" href="#${id}-s2"><span class="uc-cite">2</span><span>Car service, Friday 9:00</span><span class="uc-faint">calendar</span></a></li></ol>
</div></div><div class="uc-dock">${composer(id, { replying: true })}</div></div>`;
}

function palette(id) {
  const row = (ic, name, where, keys = '', on = false) => `<li><button type="button" class="uc-row uc-hit${on ? ' is-on' : ''}"${on ? ' aria-current="true"' : ''}><span class="uc-ic" aria-hidden="true">${icon(ic)}</span><span class="uc-label">${name}</span><span class="uc-faint">${where}</span>${keys}</button></li>`;
  return `<div class="uc-scrim"></div><div class="uc-palette" role="dialog" aria-modal="true" aria-label="Command palette"><div class="uc-palette-search"><span class="uc-ic" aria-hidden="true">${icon('search')}</span><label class="sr-only" for="${id}-cmd">Search or type a command</label><input id="${id}-cmd" class="uc-bare" value="mod" placeholder="Search or type a command"></div>
<div class="uc-palette-list"><p class="uc-group">Settings</p><ul aria-label="Settings">${row('settings', 'Models', 'Settings › Models', '', true)}${row('settings', 'Models on Study desktop', 'Settings › Devices')}</ul>
<p class="uc-group">Spaces</p><ul aria-label="Spaces">${row('device', 'Study desktop', 'Switch space', kbd('Ctrl 3'))}</ul>
<p class="uc-group">Actions</p><ul aria-label="Actions">${row('plus', 'New chat', 'Chat', kbd('Ctrl N'))}${row('brief', 'What’s new', 'Changelog')}</ul></div>
<p class="uc-palette-foot">${kbd('↑')}${kbd('↓')} move · ${kbd('Enter')} open · ${kbd('Esc')} close</p></div>`;
}

// ---- settings ------------------------------------------------------------------------------------

const CATEGORIES = [['General', 'settings'], ['Appearance', 'brief'], ['Models', 'device'], ['Privacy', 'check'], ['Devices', 'device'], ['Connections', 'automations'], ['Backups', 'copy'], ['Notifications', 'activity'], ['About', 'more']];

function settingRow(id, key, name, note, control) {
  return `<div class="uc-set"><div class="uc-set-text"><label class="uc-set-name" for="${id}-${key}">${name}</label><p class="uc-set-note">${note}</p></div><div class="uc-set-ctl">${control.replaceAll('$ID', `${id}-${key}`)}</div></div>`;
}
const toggle = (on) => `<span class="uc-toggle"><input type="checkbox" role="switch" id="$ID"${on ? ' checked' : ''}><span class="uc-track" aria-hidden="true"></span></span>`;

function settingsPane(id, { cat = 'General', search = '', counts = null, pane = 'list', detail }) {
  const list = (counts ? CATEGORIES.filter(([c]) => counts[c]) : CATEGORIES).map(([c, ic]) => `<a class="uc-row${c === cat ? ' is-on' : ''}" href="#${id}-cat-${c}"${c === cat ? ' aria-current="page"' : ''}><span class="uc-ic" aria-hidden="true">${icon(ic)}</span><span class="uc-label">${c}</span>${counts ? `<span class="uc-count" aria-label="${counts[c]} matches">${counts[c]}</span>` : ''}</a>`).join('');
  return `<div class="uc-settings" data-uc-pane="${pane}"><div class="uc-cats"><div class="uc-search"><span class="uc-ic" aria-hidden="true">${icon('search')}</span><label class="sr-only" for="${id}-find">Search settings</label><input id="${id}-find" class="uc-bare" placeholder="Search settings" value="${search}">${search ? `<button type="button" class="uc-icon" aria-label="Clear search">${icon('close')}</button>` : kbd('/')}</div>
<nav class="uc-nav" aria-label="Settings categories">${list}</nav>${counts ? '<p class="uc-faint uc-cats-note">Only categories with a match are listed.</p>' : ''}</div>
<div class="uc-detail"><a class="uc-row uc-back" href="#${id}-back"><span class="uc-ic" aria-hidden="true">${icon('back')}</span><span>Settings</span></a>${detail}</div></div>`;
}

function settingsTop(id) {
  const detail = `<h3 class="uc-h" id="${id}-detail-title">General</h3><p class="uc-lede">Who you are to Nova, and when it may interrupt.</p>
${settingRow(id, 'name', 'Your name', 'What Nova calls you.', '<input class="uc-input" id="$ID" value="Alex">')}
${settingRow(id, 'tz', 'Time zone', 'Times and quiet hours follow it.', '<select class="uc-input" id="$ID"><option>America/New_York</option><option>UTC</option></select>')}
${settingRow(id, 'quiet', 'Quiet hours', 'Nova holds anything that can wait.', '<input class="uc-input" id="$ID" value="22:00–07:00">')}
${settingRow(id, 'open', 'Opens on', 'Where Nova starts when you open it.', '<select class="uc-input" id="$ID"><option>Chat</option><option>Home</option></select>')}`;
  return settingsPane(id, { detail, pane: 'list' });
}

function settingsPrivacy(id) {
  const m = (t) => `<mark class="uc-mark">${t}</mark>`;
  const detail = `<h3 class="uc-h" id="${id}-detail-title">Privacy</h3><p class="uc-lede">What may leave this hub, and when Nova asks first. 3 settings match “cloud”.</p>
<fieldset class="uc-set uc-choices"><legend class="uc-set-name">Privacy mode</legend><p class="uc-set-note">Local only keeps every model call on your devices.</p>${[['local-only', 'Local only', true], ['local-first', 'Local first, ' + m('cloud') + ' when it must', false], ['balanced', 'Balanced', false]].map(([v, t, on]) => `<label class="uc-choice"><input type="radio" name="${id}-mode" value="${v}"${on ? ' checked' : ''}><span>${t}</span></label>`).join('')}</fieldset>
${settingRow(id, 'cloud', `${m('Cloud')} models`, 'Off: no conversation is sent to a provider.', toggle(false))}
${settingRow(id, 'ask', `Ask before anything goes to the ${m('cloud')}`, 'Each time, with what would be sent.', toggle(true))}
${settingRow(id, 'passkey', 'Looser privacy needs your passkey', 'So a program on this computer can’t change it alone.', toggle(true))}`;
  return settingsPane(id, { cat: 'Privacy', search: 'cloud', counts: { Privacy: 3, Models: 1, Connections: 1 }, pane: 'detail', detail });
}

function about(id, which) {
  const b = which === 'pending' ? PENDING : BUILD;
  const line = which === 'pending' ? `<p class="uc-state is-pending" role="status"><span class="uc-dot" aria-hidden="true"></span>Running ${b.running}, latest merged ${b.latest} — redeploy pending.</p>`
    : which === 'unknown' ? `<p class="uc-state is-unknown" role="status"><span class="uc-dot" aria-hidden="true"></span>Running ${b.running}. The latest merged build couldn’t be checked: GitHub isn’t reachable from this hub.</p>`
      : `<p class="uc-state is-ok" role="status"><span class="uc-dot" aria-hidden="true"></span>Running the latest merged build, ${b.running}.</p>`;
  const rows = [['Version', b.version], ['Build', `<span class="uc-mono">${b.running}</span>`], ['Built', b.built], ['Latest merged', which === 'unknown' ? 'Unknown' : `<span class="uc-mono">${b.latest}</span>`]];
  const detail = `<h3 class="uc-h" id="${id}-detail-title">About Nova</h3><div class="uc-hero uc-about-hero">${SKY_BAND}${nebulaOrb({ state: which === 'pending' ? 'needs-you' : 'idle', size: 'rail', label: 'Nova' })}</div><p class="uc-version">Nova ${b.version}</p>${line}
<dl class="uc-facts">${rows.map(([k, v]) => `<div class="uc-fact"><dt>${k}</dt><dd>${v}</dd></div>`).join('')}</dl>
<div class="uc-links"><a class="uc-row" href="#${id}-changelog"><span class="uc-label">What’s new in this build</span><span class="uc-ic" aria-hidden="true">${icon('chevron')}</span></a><a class="uc-row" href="#${id}-pipeline"><span class="uc-label">Where Nova stands</span><span class="uc-ic" aria-hidden="true">${icon('chevron')}</span></a></div>`;
  return settingsPane(id, { cat: 'About', pane: 'detail', detail });
}

// ---- changelog -------------------------------------------------------------------------------------

// From docs/ledger/ and LEDGER.md's plain-language entries, re-said for the owner.
const CHANGES = [
  ['Nov 6', [
    ['Models', 'If you raised a Mac’s GPU memory limit, Nova now plans models against your limit instead of guessing.', DOC('docs/ledger/2026-11-06-mac-gpu-limit.md'), 'Ledger entry'],
    ['Settings', 'Appearance keeps your place while it reloads: focus stays on the design card you were on.', PR(350), 'Pull request 350'],
    ['Models', 'A paired computer checking in no longer closes a list you have open or drops a slider you are dragging.', PR(349), 'Pull request 349'],
  ]],
  ['Nov 5', [
    ['Models', 'Each device has its own Models screen: its memory budget, what fits, and Install and assign, asking first.', PR(335), 'Pull request 335'],
    ['Models', 'An install plan Nova refuses changes nothing on the device.', PR(339), 'Pull request 339'],
    ['Browser', 'Nova’s browser checks every page it reads through one screen before Nova acts on it.', PR(333), 'Pull request 333'],
  ]],
  ['Nov 4', [
    ['Look', 'Nova takes the calmer look: quieter cards, one standout per view.', PR(307), 'Pull request 307'],
    ['Privacy', 'A step in chat that can’t be undone needs your passkey, so nothing on this computer can approve it alone.', PR(309), 'Pull request 309'],
    ['Settings', 'You can change settings by asking Nova; it shows the change before applying it.', PR(310), 'Pull request 310'],
  ]],
];

function changelog(id) {
  return `${topbar(id, 'What’s new')}<div class="uc-page"><section class="uc-pin" aria-label="The version you are running"><p class="uc-kicker">You’re running</p><p class="uc-version">Nova ${BUILD.version} <span class="uc-mono">${BUILD.running}</span></p><p class="uc-faint">Built ${BUILD.built}. This is the latest merged build.</p></section>
${CHANGES.map(([day, items]) => `<section class="uc-day" aria-label="${day}"><h3 class="uc-group">${day}</h3><ul class="uc-lines">${items.map(([area, said, href, ev]) => `<li class="uc-line"><span class="uc-area">${area}</span><p>${said}</p><a class="uc-ev" href="${href}" aria-label="${ev}: ${said}">${ev}</a></li>`).join('')}</ul></section>`).join('')}</div>`;
}

// ---- pipeline dashboard ---------------------------------------------------------------------------

// Sample data, drawn from docs/ledger/, LEDGER.md and docs/plans/. The real view is generated from
// those files when it opens; a state without evidence shows as designed at best.
const STATES = { merged: 'Merged', progress: 'In progress', designed: 'Designed', none: 'Not started' };
const TRACKS = [
  ['Foundation', [['Checked baseline to self-maintaining Nova (M0–M7)', 'merged', PR(222), 'Pull requests 209–222'], ['Coding tasks through Relay (M8)', 'merged', PR(220), 'Pull request 220'], ['Feel and polish (M9)', 'merged', PR(234), 'Pull request 234']]],
  ['Nova’s computer', [['Workspaces, browser and coding (M10a–c)', 'merged', PR(240), 'Pull requests 236–240'], ['Infrastructure changes (M10d)', 'merged', PR(241), 'Pull request 241'], ['Machines and services map (M10i)', 'merged', PR(280), 'Pull request 280']]],
  ['Models', [['How Nova decides what fits', 'merged', PR(320), 'Pull request 320'], ['Each device’s Models screen', 'merged', PR(335), 'Pull request 335'], ['A Mac’s real GPU memory limit', 'merged', DOC('docs/ledger/2026-11-06-mac-gpu-limit.md'), 'Ledger entry']]],
  ['UI rebuild', [['The calmer look (Stage 2)', 'merged', PR(307), 'Pull request 307'], ['Shell, chat, Settings, About', 'progress', DOC('docs/plans/ui-rebuild-compositions-2026-11-06.md'), 'Draft compositions'], ['Home and the morning board', 'none', DOC('docs/builder-packet/ui-references/README.md'), 'Reference only']]],
  ['Versioning', [['Version, changelog and About', 'designed', DOC('docs/builder-packet/nova-versioning-changelog-2026-11-03.md'), 'Spec'], ['Deploy on every merge, visible', 'none', DOC('docs/builder-packet/nova-about-deploy-visibility-delta-2026-11-06.md'), 'Spec']]],
];

function pipeline(id) {
  const all = TRACKS.flatMap(([, items]) => items);
  const n = (s) => all.filter((x) => x[1] === s).length;
  return `${topbar(id, 'Where Nova stands')}<div class="uc-page uc-wide"><p class="uc-sample" role="note">Sample data. The real view is generated from docs/ledger/ and the roadmap documents when it opens; nothing here is kept by hand.</p>
<ul class="uc-tally" aria-label="Totals">${Object.entries(STATES).map(([k, w]) => `<li class="uc-tally-item"><span class="uc-pstate" data-p="${k}" aria-hidden="true"></span><span>${w}</span><span class="uc-num">${n(k)}</span></li>`).join('')}</ul>
${TRACKS.map(([track, items]) => `<section class="uc-track" aria-label="${track}"><h3 class="uc-track-head"><span>${track}</span><span class="uc-faint">${items.filter((x) => x[1] === 'merged').length} of ${items.length} merged</span></h3><ul class="uc-lines">${items.map(([name, s, href, ev]) => `<li class="uc-mile"><span class="uc-pstate" data-p="${s}" aria-hidden="true"></span><span class="uc-mile-name">${name}</span><span class="uc-mile-state" data-p="${s}">${STATES[s]}</span><a class="uc-ev" href="${href}" aria-label="Evidence for ${name}: ${ev}">${ev}</a></li>`).join('')}</ul></section>`).join('')}</div>`;
}

// ---- orb -----------------------------------------------------------------------------------------

const ORB_SAID = { idle: 'Slow inflow, soft light', listening: 'Faster inflow, full light', working: 'Fastest inflow, a beat', speaking: 'Inflow, light rippling out', 'needs-you': 'Warms, beckons, dashed ring', stopped: 'Motion stops, colour drains, solid ring', offline: 'Still and dim' };

function orbSheet() {
  const row = (still) => `<ul class="uc-orbs${still ? ' uc-still' : ''}" aria-label="${still ? 'Reduced motion' : 'Moving'}">${ORB_STATES.map((s) => `<li class="uc-orb-cell">${nebulaOrb({ state: s, size: 'rail' })}<span class="uc-orb-name">${s}</span><span class="uc-faint">${still ? (s === 'stopped' ? 'Grey, solid ring' : s === 'needs-you' || s === 'working' ? 'Dashed ring' : ORB_SAID[s].split(',')[1]?.trim() ?? 'Still') : ORB_SAID[s]}</span></li>`).join('')}</ul>`;
  const tokens = ['orb/core', 'orb/glow', 'orb/listening', 'orb/attention', 'accent/primary', 'accent/secondary', 'bg/base', 'surface/card', 'text/primary'];
  return `${topbar('uc-orb', 'Orb and theme', 'speaking')}<div class="uc-page uc-wide" tabindex="0"><div class="uc-orb-hero">${SKY_BAND}${nebulaOrb({ state: 'idle', size: 'hero', label: 'Nova, idle' })}<div class="uc-icons" aria-label="App icon sizes" role="group">${[3, 2, 1].map((k) => `<span class="orb-icon" data-k="${k}" role="img" aria-label="App icon">${nebulaOrb({ state: 'idle', size: 'hero', label: '' }).replace('role="img" aria-label=""', 'aria-hidden="true"')}</span>`).join('')}</div></div>
<h3 class="uc-group">Moving</h3>${row(false)}<h3 class="uc-group">Reduced motion: still, and still distinct</h3>${row(true)}
<h3 class="uc-group">Nebula tokens, filed first</h3><ul class="uc-swatches">${tokens.map((t) => `<li class="uc-swatch"><span class="uc-chip-sw" style="background: var(--${t.replace('/', '-')})"></span><span class="uc-mono">${t}</span></li>`).join('')}</ul></div>`;
}

// ---- frames ----------------------------------------------------------------------------------------

export function ucFrame(kind, state) {
  const id = `uc-${kind}-${state}`;
  if (kind === 'shell-chat') {
    if (state === 'empty') return screen(kind, state, emptyChat(id), { rail: rail(id, { recent: -1 }) });
    if (state === 'reply') return screen(kind, state, replyChat(id), { rail: rail(id) });
    if (state === 'rail') return screen(kind, state, replyChat(id), { rail: rail(id), mode: 'is-collapsed is-drawer' });
    return screen(kind, state, replyChat(id) + palette(id), { rail: rail(id) });
  }
  if (kind === 'settings') return screen(kind, state, topbar(id, 'Settings') + (state === 'top' ? settingsTop(id) : settingsPrivacy(id)), { rail: rail(id, { active: 'settings' }) });
  if (kind === 'about') return screen(kind, state, topbar(id, 'About Nova') + about(id, state), { rail: rail(id, { active: 'settings', pending: state === 'pending' }) });
  if (kind === 'changelog') return screen(kind, state, changelog(id), { rail: rail(id, { active: 'home' }) });
  if (kind === 'pipeline') return screen(kind, state, pipeline(id), { rail: rail(id, { active: 'home' }) });
  return screen(kind, state, orbSheet(), { rail: rail(id, { active: 'home' }) });
}

// One styleguide entry: every frame of a kind, each with its full-screen address.
export function ucEntry(kinds, wrap) {
  // Several frames on one page: each frame's landmarks get its name, so no two are called the same.
  return UC_FRAMES.filter(([k]) => kinds.includes(k)).map(([k, s, said]) => wrap(`${said} · <a class="link" href="?entry=${entryOf(k)}&amp;frame=${k}-${s}">Full screen</a>`, ucFrame(k, s).replace(/(<nav [^>]*aria-label=")([^"]+)"/g, `$1$2 (${said})"`))).join('');
}
export const entryOf = (kind) => (['about', 'changelog', 'pipeline'].includes(kind) ? 'ui-about' : `ui-${kind}`);
