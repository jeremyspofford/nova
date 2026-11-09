// Home Assistant, design-first (2026-11-09): compositions for the owner's reaction, before any
// wiring. Styleguide only: the app never loads this file, nothing here is sent anywhere, and every
// control is a specimen (a checkbox ticks; Connect, Approve and the passkey say they are a demo).
//
// Drawn from the real model (src/core/connectors/home-assistant.ts and connectors/index.ts; Settings
// › Connections is ui/js/connections.js). Connecting takes an address and a long-lived access token:
// Nova calls GET /api/ there with it, and only if Home Assistant answers does the token go into the
// vault (connector/home-assistant/HA_TOKEN); /api/config gives the home's name. The address decides
// egress: this network, a mesh device or a bare name that resolved here is local, anything else is
// remote, and local-only never contacts a remote one. What Nova sees (tier 0): every entity's id,
// name, state and last change, nothing else (no attributes: no brightness, no units, no areas). What
// it changes: a service call, which is a Work Ledger task. Since the owner's ruling of 2026-11-09
// (docs/builder-packet/INPUT-2026-11-09-TIER-RULING.md) a change the person asks for is tier 1, act
// and report: made, then recorded with what changed; the service tier is a setting (2 asks first),
// and tier 3 (confirm every time; a passkey on Nova's own screen) applies when the domain or any
// entity it names is on the person's list, empty by default. After the call Nova reads the entity
// back itself as the evidence, and when that doesn't show the change it holds the task rather than
// calling again. Chat changes it too (home_call); after a chat read something from outside, it asks
// first, whatever the tier. State changes come over the WebSocket and become trigger records only
// for entities a rule listens to; a dropped socket reconnects with growing pauses and misses what
// changed meanwhile. Disconnecting asks Home Assistant to delete the token
// (auth/delete_refresh_token, by the token's issuer), then deletes it from the vault with the rules
// that listen and the settings.
// Its CSS is ui/styles/compositions.css (.ha-*, and the .au-* panes it shares with the Automations
// compositions); the narrow layout is layout.css's .au-panes rule.
import { ICONS, passkeyAction, passkeyConfirm } from './components.js';
import { escapeHtml as esc } from './markdown.js';
import { statusIcon } from './status-icon.js';

// Every frame: [state, what it shows, which pane a phone shows].
export const HA_FRAMES = [
  ['connect', 'Connecting: the address and the token, and what happens to the token', 'detail'],
  ['connected', 'Connected: what Nova can see without asking, what it changes when you ask, and what you can make confirm every time', 'detail'],
  ['devices', 'What Nova can see: every entity’s state, and one light with the change you can ask for', 'list'],
  ['done', 'Turning off a light you asked for: done and reported (tier 1), with Nova’s read-back', 'detail'],
  ['approve-lock', 'Unlocking a lock, once you marked locks: it confirms every time (tier 3), with your passkey', 'detail'],
  ['check-failed', 'Nova read the light back and it hadn’t changed: the task waits for you, it doesn’t call again', 'detail'],
  ['confirm-list', 'Asking first: the service tier, and marking locks to confirm every time', 'detail'],
  ['disconnect', 'Disconnecting: what Nova deletes there and here', 'detail'],
  ['disconnected-note', 'Disconnected here, but Home Assistant couldn’t be asked to delete the token', 'detail'],
  ['unreachable', 'Can’t connect: nothing answers at that address (the backend’s words)', 'detail'],
  ['bad-token', 'Can’t connect: Home Assistant refused the token (the backend’s words)', 'detail'],
  ['not-ha', 'Can’t connect: something answers, but not Home Assistant (the backend’s words)', 'detail'],
  ['outside', 'Can’t connect: a Home Assistant outside your network while Nova is local-only', 'detail'],
  ['token-revoked', 'Connected once, now refused: the token was revoked in Home Assistant', 'detail'],
  ['reconnecting', 'The live connection dropped: Nova reconnects, and misses changes meanwhile', 'detail'],
  ['paused', 'Connected to one outside your network, then Nova was set to local-only: paused', 'detail'],
];
const paneOf = (s) => HA_FRAMES.find(([k]) => k === s)?.[2] ?? 'detail';
const INSIDE = new Set(['devices', 'done', 'approve-lock', 'check-failed']);

// What the connector says of itself (home-assistant.ts: summary, can, never, setup).
const SUMMARY = 'Your smart home: Nova can see what your devices are doing, hear when they change, and change them when you ask.';
const CAN = ['See the state of your lights, sensors, locks and other devices.', 'Notice when something changes, for the rules you set up.', 'Turn things on and off when you ask, and tell you what changed.'];
const NEVER = ['Change anything unless you, or a rule you set up, asks.', 'Change anything from a chat that has read something from outside, without asking you first.'];
const HINT = 'Make one in Home Assistant: your profile, Security, Long-lived access tokens.';
const ADDRESS = 'http://homeassistant.local:8123';
const HOST = 'homeassistant.local:8123';
const OUTSIDE = 'https://ha.example.net';
// The backend's own words, exactly (api(), connect(), status(), disconnect(), connectors.view).
const SAID = {
  unreachable: `Couldn’t reach Home Assistant at ${HOST}. Check that it is running and the address is right.`,
  'bad-token': 'Home Assistant didn’t accept that token. Make a long-lived access token in your Home Assistant profile and paste all of it.',
  'not-ha': 'That address answers, but not like Home Assistant does.',
  outside: 'Your Home Assistant is outside your network (ha.example.net), and Nova is set to local-only, so Nova doesn’t contact it.',
  revoked: 'Home Assistant no longer accepts Nova’s token. Make a new one and connect again.',
  paused: 'Paused: it’s outside your network and Nova is set to local-only.',
  reconnecting: 'The live connection dropped; Nova is reconnecting.',
  note: 'Couldn’t reach Home Assistant. Delete the token in your Home Assistant profile, under Long-lived access tokens.',
  loosen: 'Taking lock off the list means Nova no longer asks for a confirmation every time. Send confirm: true to do that.',
  done: 'light.turn_off: light.kitchen is off now.',
  checked: 'Nova read light.kitchen from Home Assistant itself after the call: off.',
  held: "May already have happened: The evidence didn't hold up: Nova read light.kitchen from Home Assistant itself: it is on, not off. Check, then retry or cancel.",
};

// Entities, as GET /api/v1/connectors/home-assistant/states returns them: id, domain, name, state,
// last change. Grouped here by domain; Home Assistant's areas aren't in the view.
const ENTITIES = [
  ['Lights', [['light.kitchen', 'Kitchen light', 'on', '18:42'], ['light.living_room', 'Living room lamp', 'off', '07:10']]],
  ['Switches', [['switch.coffee_maker', 'Coffee maker', 'off', '08:05']]],
  ['Covers', [['cover.garage_door', 'Garage door', 'closed', 'yesterday']]],
  ['Locks', [['lock.front_door', 'Front door', 'locked', '22:30']]],
  ['Alarms', [['alarm_control_panel.home', 'Home alarm', 'disarmed', '07:02']]],
  ['Sensors', [['binary_sensor.front_door', 'Front door sensor', 'off', '22:29'], ['sensor.living_room_temperature', 'Living room temperature', '21.5', '18:50']]],
  ['Climate', [['climate.hallway', 'Hallway thermostat', 'heat', 'Nov 7']]],
];
const COUNT = ENTITIES.reduce((n, [, l]) => n + l.length, 0);
const RULE = ['Front door left open', 'binary_sensor.front_door'];

// ---- the words: the model in plain language ------------------------------------------------------

const icon = (name) => ICONS[name] ?? '';
const slot = (state, size) => `<span class="au-icon" data-ha-icon="${state}" data-ha-size="${size}" aria-hidden="true"></span>`;
const facts = (rows) => `<dl class="uc-facts au-facts">${rows.map(([k, v]) => `<div class="uc-fact"><dt>${k}</dt><dd>${v}</dd></div>`).join('')}</dl>`;
const mono = (t) => `<span class="uc-mono">${esc(t)}</span>`;
const said = (id, head, text, note = '') => `<div class="au-result" data-tone="warn" role="group" aria-labelledby="${id}-said-h"><div class="au-result-text"><p class="au-block-head" id="${id}-said-h">${head}</p><p class="ha-quote">${esc(text)}</p>${note ? `<p class="au-note">${note}</p>` : ''}</div></div>`;
const CHAT = 'You can ask here or in chat; each change is a task in Tasks. After a chat has read something from outside (mail, a web page), Nova asks you first, whatever the tier.';

// ---- the door: Settings › Connections ------------------------------------------------------------

const GROUPS = [
  ['You', [['You and Nova', 'Names and how Nova talks to you'], ['Appearance', 'Theme, light and dark, contrast'], ['Privacy and permissions', 'What stays here and what asks first']]],
  ['What Nova works with', [['Connections', ''], ['Models and providers', 'Local models and outside help'], ['Devices', 'Phones and computers paired with Nova'], ['Capture', 'Sources, consent, and what Nova remembers'], ['Services', 'How Nova runs its services here']]],
  ['About', [['About Nova', 'Its version and build, what’s new, where it stands']]],
  ['Keeping Nova safe', [['Security', 'Passkeys that confirm tier-3 actions here'], ['Backups and changes', 'Backup folders, checkpoints, restores and changes'], ['Configuration', 'Every setting of yours, a few questions, or a file'], ['Start over', 'Export everything, or erase Nova here']]],
];

// What the Connections row says under its name, from GET /connectors.
function doorMeta(state) {
  if (state === 'token-revoked') return 'Home Assistant needs you';
  if (state === 'paused') return 'Home Assistant · paused while local-only';
  if (['connected', 'disconnect', 'reconnecting', 'confirm-list'].includes(state)) return 'Home Assistant · connected';
  return 'Nothing connected yet';
}

function categories(id, state) {
  const row = ([name, note], i) => {
    const mine = name === 'Connections';
    const meta = mine ? doorMeta(state) : note;
    return `<li class="ha-cat"><a class="uc-row au-open${mine ? ' is-on' : ''}" href="#${id}-cat-${i}"${mine ? ' aria-current="true"' : ''}><span class="au-text"><span class="au-name">${esc(name)}</span><span class="au-meta${mine && state === 'token-revoked' ? ' ha-live' : ''}">${esc(meta)}</span></span><span class="uc-ic" aria-hidden="true">${icon('chevron')}</span></a></li>`;
  };
  let n = 0;
  const groups = GROUPS.map(([g, cats], gi) => `<h3 class="uc-group" id="${id}-g${gi}">${g}</h3><ul class="ha-list" aria-labelledby="${id}-g${gi}">${cats.map((c) => row(c, n++)).join('')}</ul>`).join('');
  return `<nav class="au-list" aria-label="Settings categories">${groups}</nav>`;
}

const settingsBack = (id) => `<a class="uc-row uc-back" href="#${id}-settings"><span class="uc-ic" aria-hidden="true">${icon('back')}</span><span>Settings</span></a>`;
const canList = () => `<ul class="ha-can">${CAN.map((x) => `<li>${esc(x)}</li>`).join('')}</ul><p class="au-note">Never: ${NEVER.map((x) => esc(x.replace(/\.$/, '').replace(/^./, (c) => c.toLowerCase()))).join(', ')}.</p>`;

// What happens to the token, said before it is pasted.
const TOKEN_FATE = [
  'Nova tries it once on your Home Assistant first. Only if Home Assistant accepts it does Nova keep it.',
  `It is kept in Nova’s vault, as ${mono('connector/home-assistant/HA_TOKEN')}, and isn’t shown again.`,
  'Nova sends it only to this address, and doesn’t follow a redirect somewhere else.',
  'Disconnecting asks Home Assistant to delete it, then deletes it here.',
];

function connectForm(id, { address = ADDRESS, primary = true, revoked = false } = {}) {
  const fate = `<section class="au-preview" aria-labelledby="${id}-fate"><h4 class="uc-group au-group-head" id="${id}-fate">What happens to the token</h4><ul class="ha-can">${TOKEN_FATE.map((x) => `<li>${x}</li>`).join('')}</ul></section>`;
  return `<form class="au-form" data-sg-inert novalidate aria-labelledby="${id}-form-h"><h4 class="uc-group au-group-head" id="${id}-form-h">${revoked ? 'Connect again, with a new token' : 'Connect it'}</h4>
<div class="au-field"><label class="au-label" for="${id}-url">Home Assistant address</label><input class="uc-input ha-mono" id="${id}-url" value="${esc(address)}" placeholder="${ADDRESS}" spellcheck="false" autocapitalize="off" autocomplete="off"><p class="au-note">An address on this network, or a device in your mesh, counts as yours. A bare name like homeassistant counts only if it resolves to this network when you connect.</p></div>
<div class="au-field"><label class="au-label" for="${id}-token">Long-lived access token</label><input class="uc-input ha-mono" id="${id}-token" type="password" autocomplete="off" spellcheck="false" aria-describedby="${id}-token-hint"><p class="au-note" id="${id}-token-hint">${esc(HINT)}</p></div>
${fate}<div class="au-actions"><button type="submit" class="btn${primary ? ' primary' : ''}" data-ha-demo>${revoked ? 'Connect again' : 'Connect Home Assistant'}</button></div></form>`;
}

function head(id, line, tone) {
  return `${settingsBack(id)}<p class="ha-kind">Connections</p><h3 class="uc-h" id="${id}-name">Home Assistant</h3>${line ? `<p class="uc-state ${tone}"><span class="uc-dot" aria-hidden="true"></span><span>${esc(line)}</span></p>` : ''}`;
}

const CONNECTED = `Connected to Home since November 2, 2026.`;

// The connected page: who it is, what Nova sees and changes, what listens, and the way out.
function connectedPane(id, { live = 'Hearing changes as they happen.', tone = 'is-ok', extra = '' } = {}) {
  const tiers = facts([
    ['Sees', `Every device’s state and when it last changed: ${COUNT} entities. Without asking (tier 0): Nova only looks.`],
    ['Changes', 'Made when you ask (tier 1), and reported: lights, switches, locks, covers and everything else. Nova reads each device back from Home Assistant as the evidence.'],
    ['Confirms every time', 'None by default. Mark kinds, like locks or the garage door, to confirm every time (tier 3), with your passkey on Nova’s own screen.'],
    ['After outside content', 'In a chat that has read mail or a web page, Nova asks you first before any change.'],
    ['Listens', `One rule listens to it: “${RULE[0]}”, on ${mono(RULE[1])}.`],
    ['Where', `${mono(HOST)}, on this network, so it works while Nova is local-only.`],
  ]);
  return `${head(id, `${CONNECTED} ${live}`, tone)}${extra}<p class="uc-lede">${esc(SUMMARY)}</p>${tiers}
<div class="au-actions"><a class="btn primary" href="#${id}-devices">See your devices</a><a class="btn quiet" href="#${id}-confirm-list">Asking first</a></div>
<p class="au-note">${CHAT}</p>
<div class="au-danger"><a class="btn quiet" href="#${id}-disconnect">Disconnect</a><p class="au-note">Nova asks Home Assistant to delete its token, then deletes it here with the rule that listens.</p></div>`;
}

function connectPane(id, state) {
  if (state === 'connect') return `${head(id, '', '')}<p class="uc-lede">${esc(SUMMARY)}</p>${canList()}${connectForm(id)}`;
  if (state === 'disconnected-note') {
    return `${head(id, '', '')}${said(id, 'Disconnected here; the token may still work there', SAID.note, 'Nova deleted the token from its vault, the rule that listened and its settings. Home Assistant itself didn’t answer, so delete the token there too.')}${connectForm(id, { primary: false })}`;
  }
  const address = state === 'outside' ? OUTSIDE : state === 'not-ha' ? 'http://192.168.1.40:8080' : ADDRESS;
  const head2 = { unreachable: 'Couldn’t connect', 'bad-token': 'Home Assistant refused the token', 'not-ha': 'That isn’t Home Assistant', outside: 'Outside your network' }[state];
  const after = state === 'outside'
    ? 'Nothing was sent there and nothing was kept. Use an address on this network, or change Privacy and permissions.'
    : 'Nothing was kept: Nova keeps the token only once Home Assistant accepts it.';
  return `${head(id, '', '')}${said(id, head2, SAID[state === 'unreachable' ? 'unreachable' : state], after)}${connectForm(id, { address })}`;
}

function disconnectPane(id) {
  return `${settingsBack(id)}<form class="au-form ha-confirm" data-sg-inert novalidate aria-labelledby="${id}-title"><p class="ha-kind">Disconnect</p><h3 class="uc-h" id="${id}-title">Disconnect Home Assistant?</h3>
<p class="au-sentence">Nova asks Home Assistant to delete its token, then deletes the token from Nova’s vault, the rule listening to it and its settings.</p>
${facts([['There', `Home Assistant deletes the token, if it answers. If it can’t be asked, Nova says so, and you delete it in your profile there.`], ['Here', `${mono('connector/home-assistant/HA_TOKEN')}; the rule “${RULE[0]}”; which kinds confirm every time, and whether changes ask first.`], ['Stays', 'Your devices and Home Assistant itself, as they are. Past tasks stay in Tasks.']])}
<p class="au-note">Connecting again starts fresh: changes made when you ask, and no kind confirming every time until you mark it.</p>
<div class="au-actions"><button type="submit" class="btn primary" data-ha-demo>Disconnect</button><button type="button" class="btn quiet">Keep it</button></div></form>`;
}

// The settings (GET and PUT /settings): service_tier (1 by default, 2 asks first) and tier3_domains
// (empty by default). Here the person marks locks: that tightens a gate, so it needs no confirmation.
function confirmList(id) {
  const box = (d, words, on) => `<label class="uc-choice au-choice"><input type="checkbox" name="${id}-t3" value="${d}"${on ? ' checked' : ''}><span>${words} <span class="uc-faint">· ${esc(d)}</span></span></label>`;
  const tier = (v, words, on) => `<label class="uc-choice au-choice"><input type="radio" name="${id}-tier" value="${v}"${on ? ' checked' : ''}><span>${words}</span></label>`;
  return `${settingsBack(id)}<form class="au-form" data-sg-inert novalidate aria-labelledby="${id}-title"><p class="ha-kind">Home Assistant</p><h3 class="uc-h" id="${id}-title">Asking first</h3>
<p class="au-sentence">By default Nova makes a change when you ask and tells you what changed. You can make every change ask first, and mark kinds that need an explicit confirmation every time.</p>
<fieldset class="au-checks"><legend class="au-label">Changes you ask for</legend>${tier(1, 'Make the change and tell me (tier 1, the default)', true)}${tier(2, 'Ask me first (tier 2)', false)}</fieldset>
<fieldset class="au-checks"><legend class="au-label">Confirm every time (tier 3)</legend>${box('lock', 'Locks', true)}${box('alarm_control_panel', 'Alarms', false)}${box('cover', 'Covers, like the garage door', false)}${box('script', 'Scripts', false)}</fieldset>
<p class="au-note">A change counts as one of these when its kind is, or when any device it names is. Marked kinds confirm with your passkey on Nova’s own screen.</p>
<p class="au-note">Marking a kind, or asking first, tightens a gate: no confirmation needed. Taking a kind off, or going back to tier 1, loosens one, and Nova says so: “${esc(SAID.loosen)}” On Nova’s own screen that needs your passkey, like any confirmation there; from a paired phone or browser the tick alone does it, and any paired device may: your ruling, 2026-11-09.</p>
<div class="au-actions"><button type="submit" class="btn primary" data-ha-demo>Save</button><button type="button" class="btn quiet">Cancel</button></div></form>`;
}

// ---- inside: what Nova can see ---------------------------------------------------------------------

function entityList(id, current = '') {
  const groups = ENTITIES.map(([g, list], gi) => `<h3 class="uc-group" id="${id}-d${gi}">${g}</h3><ul class="ha-list" aria-labelledby="${id}-d${gi}">${list.map(([eid, name, st, at]) => `<li class="ha-ent"><a class="uc-row au-open${eid === current ? ' is-on' : ''}" href="#${id}-${eid.replace('.', '-')}"${eid === current ? ' aria-current="true"' : ''}><span class="au-text"><span class="au-name">${esc(name)}</span><span class="au-meta">${mono(eid)} · ${esc(at)}</span></span><span class="au-state">${esc(st)}</span></a></li>`).join('')}</ul>`).join('');
  return `<div class="au-list"><p class="au-intro">Connected to Home at ${esc(HOST)}. ${COUNT} entities, as Home Assistant says them.</p>${groups}
<p class="au-intro">Nova sees each one’s state alone: no brightness, no units (21.5 is degrees), no rooms.</p></div>`;
}

const back = (id) => `<a class="uc-row uc-back" href="#${id}-list"><span class="uc-ic" aria-hidden="true">${icon('back')}</span><span>Your devices</span></a>`;

function lightPane(id) {
  return `${back(id)}<p class="ha-kind">Light · ${mono('light.kitchen')}</p><h3 class="uc-h" id="${id}-name">Kitchen light</h3>
<p class="au-sentence">On, since 18:42.</p>
${facts([['Nova sees', 'Its state and when it last changed. Not its brightness or colour.'], ['A change', 'Made when you ask (tier 1), and reported. It becomes a task in Tasks: Nova calls Home Assistant, then reads the light back itself, to check it is off.'], ['Listens', 'No rule listens to it.']])}
<div class="au-actions"><button type="button" class="btn primary" data-ha-demo>Turn off</button></div>
<p class="au-note">${CHAT}</p>`;
}

// Act and report (tier 1): what the ledger records once the change is made and checked.
function donePane(id) {
  return `${back(id)}<p class="ha-kind">Done and reported</p><h3 class="uc-h" id="${id}-title">turn off light.kitchen (Home Assistant)</h3>
<p class="au-sentence">${esc(SAID.done)}</p>
${facts([['Asked', 'Not first: you asked for it (tier 1, act and report)'], ['Checked', esc(SAID.checked)], ['If it goes wrong', 'Nova doesn’t call again by itself: it may already have happened, so the task waits for you.'], ['Task', `${mono('7c1e5a90')} in Tasks, done at 18:55`]])}
<div class="au-actions"><a class="btn" href="#${id}-tasks">Open in Tasks</a><button type="button" class="btn quiet" data-ha-demo>Turn it back on</button></div>`;
}

function lockPane(id) {
  return `${back(id)}<form class="au-form ha-confirm" data-sg-inert novalidate aria-labelledby="${id}-title"><p class="ha-kind">Asks every time</p><h3 class="uc-h" id="${id}-title">unlock lock.front_door (Home Assistant)</h3>
<p class="au-sentence">Home Assistant runs lock.unlock on lock.front_door, and lock.front_door shows unlocked.</p>
${facts([['Asks', 'Every time (tier 3): you marked locks to confirm every time. Unmarked, an unlock you ask for just happens, and is reported.'], ['Then', `Nova reads ${mono('lock.front_door')} back from Home Assistant itself, as the evidence.`], ['If it runs again', 'It asks again: a retry is confirmed again too.'], ['Task', `${mono('e42b9d13')} in Tasks`]])}
${passkeyConfirm({ state: 'ready' })}
<div class="au-actions">${passkeyAction({ state: 'ready' })}<button type="button" class="btn quiet">Cancel</button></div></form>`;
}

function heldPane(id) {
  return `${back(id)}<p class="ha-kind">Needs you</p><h3 class="uc-h" id="${id}-title">turn off light.kitchen (Home Assistant)</h3>
${said(id, 'The light didn’t change', SAID.held, 'Nova called Home Assistant once. It doesn’t call again by itself, because a change at home may already have happened.')}
${facts([['Nova read', `${mono('light.kitchen')}: on, at 18:55`], ['Task', `${mono('7c1e5a90')} in Tasks`]])}
<div class="au-actions"><button type="button" class="btn primary" data-ha-demo>Retry</button><button type="button" class="btn">Cancel the task</button><a class="btn quiet" href="#${id}-tasks">Open in Tasks</a></div>`;
}

// ---- frames ----------------------------------------------------------------------------------------

function screen(state, title, panes, live) {
  const id = `ha-${state}`;
  return `<div class="uc-screen ha" data-ha-frame="${state}"><div class="uc-main"><header class="uc-top"><button type="button" class="uc-icon uc-menu" aria-label="Open navigation">${icon('panel')}</button><h2 class="uc-title">${title}</h2>${slot(live, 24)}</header>
<div class="au-panes" data-au-pane="${paneOf(state)}">${panes(id)}</div></div></div>`;
}
const pair = (list, right) => (id) => `${list(id)}<div class="au-detail">${right(id)}</div>`;

function doorPane(id, state) {
  if (state === 'connected') return connectedPane(id);
  if (state === 'reconnecting') return connectedPane(id, { live: SAID.reconnecting, tone: 'is-unknown', extra: '<p class="au-note">Nova waits longer between each try, up to a minute. Changes that happen meanwhile aren’t heard, so a rule listening misses them.</p>' });
  if (state === 'paused') return connectedPane(id, { live: SAID.paused, tone: 'is-unknown', extra: '<p class="au-note">It was connected at an address outside your network. While Nova is local-only it doesn’t contact it: no states, no changes, nothing heard.</p>' });
  if (state === 'token-revoked') {
    return `${head(id, 'Needs you', 'is-pending')}${said(id, 'Home Assistant refuses Nova now', SAID.revoked, `Until then Nova sees and changes nothing there, and the rule “${RULE[0]}” hears nothing. Its rules and settings are kept.`)}${connectForm(id, { revoked: true })}
<div class="au-danger"><a class="btn quiet" href="#${id}-disconnect">Disconnect</a></div>`;
  }
  if (state === 'disconnect') return disconnectPane(id);
  if (state === 'confirm-list') return confirmList(id);
  return connectPane(id, state);
}

const LIVE = { 'approve-lock': 'needs-you', 'check-failed': 'needs-you', 'token-revoked': 'needs-you' };

export function haFrame(state) {
  const live = LIVE[state] ?? 'idle';
  if (INSIDE.has(state)) {
    const right = { devices: lightPane, done: donePane, 'approve-lock': lockPane, 'check-failed': heldPane }[state];
    const current = state === 'approve-lock' ? 'lock.front_door' : 'light.kitchen';
    return screen(state, 'Home Assistant', pair((id) => entityList(id, current), right), live);
  }
  return screen(state, 'Settings', pair((id) => categories(id, state), (id) => doorPane(id, state)), live);
}
// The styleguide entry: every frame, each with its full-screen address.
export function haEntry(wrap) {
  return HA_FRAMES.map(([s, words]) => wrap(`${esc(words)} · <a class="link" href="?entry=home-assistant&amp;frame=${s}">Full screen</a>`, haFrame(s))).join('');
}
export const isHaFrame = (s) => HA_FRAMES.some(([k]) => k === s);

// Fills the status icon slots and makes the specimens move a little: the passkey checkbox enables
// its button, and the demo buttons say they are a demo.
export function bindHomeAssistant(root) {
  for (const el of root.querySelectorAll('[data-ha-icon]')) {
    el.replaceChildren(statusIcon({ status: el.dataset.haIcon, size: Number(el.dataset.haSize), decorative: true }));
  }
  for (const frame of root.querySelectorAll('[data-ha-frame]')) {
    if (frame.dataset.haBound) continue;
    frame.dataset.haBound = '1';
    frame.addEventListener('change', (e) => {
      if (e.target.name !== 'confirm') return;
      const b = e.target.closest('form')?.querySelector('[data-action="passkey-confirm"]');
      if (b) b.disabled = !e.target.checked;
    });
    frame.addEventListener('click', (e) => {
      const b = e.target.closest('[data-ha-demo], [data-action^="passkey"]');
      if (b) { e.preventDefault(); b.textContent = 'Demo: nothing was sent'; }
      if (e.target.closest('a[href^="#"]')) e.preventDefault();
    });
  }
}
