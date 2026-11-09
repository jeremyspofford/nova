// The vault, design-first (2026-11-09): compositions for the owner's reaction, before any wiring.
// Styleguide only: the app never loads this file, nothing here is sent anywhere, every project,
// target, site and source is made up, and no secret value is ever drawn: a secret field is always
// empty, and a stored secret only says that it is stored.
//
// Drawn from the real model (src/core/vault.ts, the /vault routes in src/core/index.ts). The vault
// is one file, home/vault/secrets.json (0600): AES-256-GCM over the map of name → value, its 32-byte
// key in the system keychain when there is one, otherwise in home/vault/key, said plainly
// (FILE_KEY_NOTICE). GET /vault is {ok, secrets, key, where, notice, problem, names}: every name in
// the vault (names: [] when it won't open), never a value. PUT /vault/{NAME} and DELETE /vault/{NAME}
// reach only provider/NAME (a provider's secret://NAME); every other kind is kept and removed by the
// part of Nova that uses it (Connections, Sites, Capture, Infrastructure and network) or is one of
// Nova's own keys. Deleting rewrites the file under a new key, so a copy from before doesn't open
// with the key in use. POST /vault/reset ({confirm: true}, tier 3) starts a new, empty vault and sets
// the old file aside as secrets.json.unopenable-<time>; on Nova's own screen the confirm needs a
// passkey approval of exactly that request, while a paired phone or browser sends confirm alone.
//
// What the backend doesn't have, so these frames don't draw it as working: no route says which
// part of Nova uses a secret (the page would read it from the name, and match a provider's secret
// against the providers' settings); DELETE asks for no confirm and no passkey; a reset doesn't remove
// the old key, so the file set aside could still be opened with it; and GET /vault lists every name
// to any paired phone or browser. Those are flagged, not hidden. Its CSS is ui/styles/compositions.css
// (.vt-*, and the .au-* panes it shares with the Automations compositions); the narrow layout is
// layout.css's .au-panes rule.
import { ICONS, passkeyAction, passkeyConfirm } from './components.js';
import { escapeHtml as esc } from './markdown.js';
import { statusIcon } from './status-icon.js';

// Every frame: [state, what it shows, which pane a phone shows].
export const VT_FRAMES = [
  ['list', 'The vault at rest: every secret by name, grouped by the part of Nova that uses it, never a value; where its key is', 'list'],
  ['empty', 'Nothing saved yet', 'list'],
  ['secret', 'A provider’s secret opened: its name, the provider whose settings name it, replacing its value', 'detail'],
  ['delete-confirm', 'Deleting a provider’s secret: what stops working, said before it happens. The core asks no confirm and no passkey for this (flagged)', 'detail'],
  ['deleted', 'Just deleted: the provider that needs a key again', 'detail'],
  ['elsewhere', 'A connection’s secret opened: it is removed where it is used, not here; where each kind goes', 'detail'],
  ['own-key', 'One of Nova’s own keys (the backup key): made by Nova, not deleted here', 'detail'],
  ['reset-confirm', 'Starting a new, empty vault (tier 3), on Nova’s own screen with a passkey: everything it leaves behind', 'detail'],
  ['reset-no-passkey', 'The same, with no passkey added yet: nothing can be confirmed until one is', 'detail'],
  ['reset-paired', 'The same from a paired phone: the core asks only for the box, no passkey (flagged)', 'detail'],
  ['reset-done', 'A new, empty vault: the old file set aside, and what to set again', 'detail'],
  ['file-key', 'No system keychain here: the key is in a file next to the vault, said plainly', 'list'],
  ['keychain-waiting', 'Can’t open now: the keychain isn’t answering. Nova waits rather than starting over (the backend’s words)', 'detail'],
  ['lost', 'Can’t open: the vault file is damaged. Saving a secret again starts a new one (the backend’s words)', 'detail'],
];
const paneOf = (s) => VT_FRAMES.find(([k]) => k === s)?.[2] ?? 'list';

// ---- the model, made up ----------------------------------------------------------------------------

// GET /vault's names, sorted as vault.list() sorts them. Every kind of name the core keeps.
const NAMES = [
  'browser/login/shop.example/password', 'browser/login/shop.example/username',
  'capture/hash-key', 'capture/screenpipe-1',
  'connector/home-assistant/HA_TOKEN',
  'decisions.jev',
  'infra/p3c41a9e2b0/LAB_API_TOKEN', 'infra/p3c41a9e2b0/run/r7a20c4d1',
  'network/n4f2b8a61c0/change/c19e0b7a2', 'network/n4f2b8a61c0/token',
  'nova/backup-key', 'nova/backup-seal',
  'provider/CLOUD_MODELS_KEY', 'provider/N8N_SIGNING_SECRET',
];
const KEYCHAIN = 'the system keychain (secret-tool)';
const HOME = '/home/you/.nova';
const FILE_KEY_NOTICE = 'Nova keeps your connection secrets encrypted, but on this computer there is no system keychain it can use, so the key is in a file next to them (vault/key in Nova’s home). Anyone who can read Nova’s home folder can open them. Nova moves the key into the keychain by itself once one is available.';
const START_OVER = 'Saving a secret again (reconnecting a connection, or adding a provider’s key) starts a new vault; the old file is kept aside in vault/ as secrets.json.unopenable-<time>, in case its key turns up.';
const PROBLEM = {
  'keychain-waiting': 'Nova can’t find the key to its vault, so connections that need a secret can’t sign in. It may be in the system keychain, which isn’t answering (no desktop session to reach the keychain through). Nova waits for the keychain rather than starting over; to start a new vault anyway, reset the vault (tier 3: POST /api/v1/vault/reset with confirm: true), and the old one is kept aside.',
  lost: `The vault (${HOME}/vault/secrets.json) is damaged and can’t be read: Unsupported state or unable to authenticate data. ${START_OVER}`,
};
const ASIDE = 'secrets.json.unopenable-2026-11-09T14-02-11-482Z';
// The providers whose settings name a secret (GET /providers: config.api_key, config.signing_secret).
const USERS = { CLOUD_MODELS_KEY: ['Cloud models', 'Key'], N8N_SIGNING_SECRET: ['n8n', 'Signing secret'] };

// Which part of Nova uses a name: read from the name itself, the way the core names them.
// [group, label, meta]
function kindOf(n) {
  let m;
  if ((m = n.match(/^provider\/(.+)$/))) return ['models', m[1], `secret://${m[1]} · ${USERS[m[1]]?.[0] ?? 'no provider names it'}`];
  if (n === 'decisions.jev') return ['models', 'Jev key', 'The Decision Service’s key, set in Models'];
  if ((m = n.match(/^connector\/([^/]+)\/(.+)$/))) return ['connections', m[2], m[1] === 'home-assistant' ? 'Home Assistant' : m[1]];
  if ((m = n.match(/^browser\/login\/([^/]+)\/(.+)$/))) return ['sites', `${m[1]}, ${m[2] === 'username' ? 'user name' : m[2]}`, 'A sign-in Nova’s browser uses'];
  if (n === 'capture/hash-key') return ['own', 'Capture’s hashing key', 'Made by Nova'];
  if ((m = n.match(/^capture\/(.+)$/))) return ['capture', 'Screenpipe’s API key', `Source ${m[1]}`];
  if ((m = n.match(/^infra\/([^/]+)\/run\/(.+)$/))) return ['own', 'A run’s sealing key', `Home lab, run ${m[2]}`];
  if ((m = n.match(/^infra\/([^/]+)\/(.+)$/))) return ['infra', m[2], 'Home lab (infrastructure project)'];
  if ((m = n.match(/^network\/([^/]+)\/change\/(.+)$/))) return ['own', 'A change’s sealing key', `Home router, change ${m[2]}`];
  if ((m = n.match(/^network\/([^/]+)\/token$/))) return ['infra', 'Token', 'Home router (network target)'];
  if (n === 'nova/backup-key') return ['own', 'Backup key', 'Makes your encrypted backup copies'];
  if (n === 'nova/backup-seal') return ['own', 'Backup seal', 'Seals what backups say about themselves'];
  return ['own', n, ''];
}
const GROUPS = [
  ['models', 'Models and providers'],
  ['connections', 'Connections'],
  ['sites', 'Sign-ins for Nova’s browser'],
  ['capture', 'Capture'],
  ['infra', 'Infrastructure and network'],
  ['own', 'Nova’s own keys'],
];
// Where each kind is removed, in the core as it is.
const WHERE = [
  ['Models and providers', 'A provider’s key: here, or by saving a new value. The Jev key: replaced in Models.'],
  ['Connections', 'Disconnecting the service in Connections signs Nova out there where it can, then deletes its secrets, the rules listening to it and its settings.'],
  ['Sign-ins for Nova’s browser', 'Forgetting the site in Sites, with its sign-in. It asks every time (tier 3).'],
  ['Capture', 'Removing the source’s API key in Capture.'],
  ['Infrastructure and network', 'Replaced only: no route removes a project’s secret or a target’s token. (Flagged for the owner.)'],
  ['Nova’s own keys', 'Made and removed by Nova. Not deleted here.'],
];

// ---- pieces ----------------------------------------------------------------------------------------

const icon = (name) => ICONS[name] ?? '';
const slot = (state, size) => `<span class="au-icon" data-vt-icon="${state}" data-vt-size="${size}" aria-hidden="true"></span>`;
const facts = (rows) => `<dl class="uc-facts au-facts">${rows.map(([k, v]) => `<div class="uc-fact"><dt>${k}</dt><dd>${v}</dd></div>`).join('')}</dl>`;
const mono = (t) => `<span class="uc-mono">${esc(t)}</span>`;
const kind = (t) => `<p class="vt-kind">${t}</p>`;
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
const notes = (lines) => `<ul class="vt-notes">${lines.map((l) => `<li>${l}</li>`).join('')}</ul>`;
const back = (id) => `<a class="uc-row uc-back" href="#${id}-list"><span class="uc-ic" aria-hidden="true">${icon('back')}</span><span>Vault</span></a>`;

// What GET /vault says in one line (vaultHealth in src/core/index.ts).
function health(o) {
  if (o.problem) return 'Can’t open the vault';
  if (!o.names.length) return 'Empty.';
  return `${plural(o.names.length, 'secret')}, key in ${o.file ? `a key file next to the vault (${HOME}/vault/key)` : KEYCHAIN}.`;
}

function row(id, n, current) {
  const [, label, meta] = kindOf(n);
  const on = n === current;
  return `<li class="vt-item"><a class="uc-row au-open${on ? ' is-on' : ''}" href="#${id}-${esc(n.replace(/[^a-zA-Z0-9]+/g, '-'))}"${on ? ' aria-current="true"' : ''}><span class="au-text"><span class="au-name">${esc(label)}</span><span class="au-meta">${esc(meta)}</span><span class="au-meta">${mono(n)}</span></span></a></li>`;
}

function listPane(id, o) {
  const top = `<a class="uc-row uc-back" href="#${id}-settings"><span class="uc-ic" aria-hidden="true">${icon('back')}</span><span>Settings</span></a>`;
  if (o.problem) {
    return `<div class="au-list">${top}<p class="au-intro">Can’t open the vault, so it can’t list its secrets’ names.</p></div>`;
  }
  if (!o.names.length) return `<div class="au-list">${top}<p class="au-intro">Nothing is saved in the vault yet.</p></div>`;
  const groups = GROUPS.map(([g, words], gi) => {
    const mine = o.names.filter((n) => kindOf(n)[0] === g);
    return mine.length ? `<h3 class="uc-group" id="${id}-g${gi}">${words} · ${mine.length}</h3><ul class="vt-list" aria-labelledby="${id}-g${gi}">${mine.map((n) => row(id, n, o.current)).join('')}</ul>` : '';
  }).join('');
  return `<div class="au-list">${top}<p class="au-intro">${esc(health(o))} Names only: a value is never shown again once it is saved.</p>${groups}</div>`;
}

const LEDE = 'Passwords, keys and tokens Nova uses for you, encrypted on this computer. This page shows their names, never their values.';

function keyFacts(o) {
  const key = o.file
    ? `In a file next to the vault: ${mono(`${HOME}/vault/key`)}`
    : `In ${esc(KEYCHAIN)}`;
  return facts([
    ['Secrets', String(o.names.length)],
    ['Kept in', `${mono(`${HOME}/vault/secrets.json`)}, readable only by the account Nova runs as, encrypted (AES-256-GCM)`],
    ['Its key', key],
  ]);
}

function resetBlock(id) {
  return `<div class="au-danger"><a class="btn quiet" href="#${id}-reset">Start a new, empty vault</a><p class="au-note">Every secret is left behind and set again by hand. Asks every time (tier 3), with your passkey on Nova’s own screen.</p></div>`;
}

function overview(id, o) {
  const notice = o.file
    ? `<div class="au-result" role="group" aria-labelledby="${id}-fk-h"><div class="au-result-text"><p class="au-block-head" id="${id}-fk-h">The key is in a file, not a keychain</p><p class="vt-quote">${esc(FILE_KEY_NOTICE)}</p></div></div>`
    : '';
  return `<h3 class="uc-h" id="${id}-name">Vault</h3><p class="uc-lede">${LEDE}</p>
<p class="uc-state is-ok"><span class="uc-dot" aria-hidden="true"></span><span>${esc(health(o))}</span></p>
${notice}${keyFacts(o)}
<div class="au-actions"><a class="btn" href="#${id}-add">Add a provider’s key</a></div>
<p class="au-note">Other secrets are added where they are used: Connections, Sites, Capture, Infrastructure and network.</p>
${resetBlock(id)}`;
}

function empty(id) {
  return `<h3 class="uc-h" id="${id}-name">Vault</h3><p class="uc-lede">${LEDE}</p>
<p class="uc-state is-ok"><span class="uc-dot" aria-hidden="true"></span><span>Empty.</span></p>
<p class="au-sentence">Nothing saved yet.</p>
<p class="au-note">A secret lands here when you add a provider’s key, connect a service, save a sign-in for a site, or give a project or a target its credentials. Each shows here by name.</p>
<div class="au-actions"><a class="btn" href="#${id}-add">Add a provider’s key</a></div>`;
}

// ---- one secret ----------------------------------------------------------------------------------------

function secret(id) {
  const [who, setting] = USERS.CLOUD_MODELS_KEY;
  return `${back(id)}${kind('A provider’s secret')}<h3 class="uc-h" id="${id}-name">CLOUD_MODELS_KEY</h3>
${facts([
    ['Name in the vault', mono('provider/CLOUD_MODELS_KEY')],
    ['Named in settings as', mono('secret://CLOUD_MODELS_KEY')],
    ['Used by', `${esc(who)}, its ${esc(setting)} setting`],
    ['Value', 'Saved. Never shown again.'],
  ])}
<p class="au-note">(Flagged for the owner: the core doesn’t say which provider names a secret. This page would match it against each provider’s settings.)</p>
<form class="au-form" data-sg-inert novalidate aria-labelledby="${id}-rep"><h4 class="uc-group au-group-head" id="${id}-rep">Replace its value</h4>
<div class="au-field"><label class="au-label" for="${id}-value">New value</label><input class="uc-input" id="${id}-value" type="password" value="" autocomplete="off" spellcheck="false" aria-describedby="${id}-value-note"><p class="au-note" id="${id}-value-note">Paste it here, not in chat. The old value is gone once this is saved; Nova keeps only the latest, and doesn’t check it when you save it.</p></div>
<div class="au-actions"><button type="submit" class="btn primary" data-vt-demo>Save the new value</button></div></form>
<div class="au-danger"><a class="btn quiet" href="#${id}-delete">Delete CLOUD_MODELS_KEY</a><p class="au-note">${esc(who)} stops working until a key is saved again.</p></div>`;
}

function remove(id) {
  const [who] = USERS.CLOUD_MODELS_KEY;
  return `${back(id)}<form class="au-form vt-confirm" data-sg-inert novalidate aria-labelledby="${id}-title">${kind('Delete a secret')}<h3 class="uc-h" id="${id}-title">Delete CLOUD_MODELS_KEY?</h3>
<p class="au-sentence">It can’t be brought back.</p>
<h4 class="uc-group au-group-head" id="${id}-what">What happens</h4>
${notes([
    `${esc(who)} stops working. Its check says ${mono('The key CLOUD_MODELS_KEY isn’t in the vault yet.')} until you save a key again.`,
    `${esc(who)}’s settings still name it (${mono('secret://CLOUD_MODELS_KEY')}). Nothing else changes.`,
    'Nova saves the vault again under a new key, so a copy of the vault from before doesn’t open with the key in use now.',
  ])}
<p class="au-note">Nova doesn’t ask for your passkey for this. (Flagged for the owner: the core deletes a provider’s secret with no confirm and no passkey, from this screen or any paired phone or browser.)</p>
<div class="au-actions"><button type="submit" class="btn primary" data-vt-demo>Delete CLOUD_MODELS_KEY</button><button type="button" class="btn quiet">Cancel</button></div></form>`;
}

function deleted(id) {
  return `${back(id)}${kind('Deleted')}<h3 class="uc-h" id="${id}-name">CLOUD_MODELS_KEY was deleted</h3>
<div class="au-result" role="group" aria-labelledby="${id}-d-h"><div class="au-result-text"><p class="au-block-head" id="${id}-d-h">Cloud models needs a key again</p><p class="au-note">Its settings still name ${mono('secret://CLOUD_MODELS_KEY')}. Save a key under that name, or change its settings to another one.</p></div><div class="au-actions"><a class="btn primary" href="#${id}-add">Save a key as CLOUD_MODELS_KEY</a><a class="btn" href="#${id}-providers">Open Models and providers</a></div></div>`;
}

function elsewhere(id) {
  return `${back(id)}${kind('A connection’s secret')}<h3 class="uc-h" id="${id}-name">HA_TOKEN</h3>
${facts([['Name in the vault', mono('connector/home-assistant/HA_TOKEN')], ['Used by', 'Home Assistant, in Connections'], ['Value', 'Saved. Never shown again.']])}
<div class="au-result" role="group" aria-labelledby="${id}-e-h"><div class="au-result-text"><p class="au-block-head" id="${id}-e-h">Removed where it is used</p><p class="au-note">The vault deletes providers’ keys only. Disconnecting Home Assistant signs Nova out there where it can, then deletes this token, the rules listening to it and its settings.</p></div><div class="au-actions"><a class="btn" href="#${id}-connections">Open Connections</a></div></div>
<h4 class="uc-group au-group-head" id="${id}-where">Where each kind is removed</h4>
${facts(WHERE.map(([k, v]) => [k, esc(v)]))}`;
}

function ownKey(id) {
  return `${back(id)}${kind('Nova’s own key')}<h3 class="uc-h" id="${id}-name">Backup key</h3>
${facts([['Name in the vault', mono('nova/backup-key')], ['Used by', 'Backups: it makes your encrypted copies'], ['Made by', 'Nova'], ['Value', 'Never shown here.']])}
<p class="au-sentence">Your recovery key is this key, written out for you. Show it in Backups and changes (tier 3), and keep it somewhere other than this computer.</p>
<p class="au-locked">Not deleted here: it is Nova’s own.</p>
<div class="au-actions"><a class="btn" href="#${id}-backups">Open Backups and changes</a></div>`;
}

// ---- starting over -----------------------------------------------------------------------------------

// What a reset leaves behind, by the part of Nova that used it: the names above, in plain words.
function leftBehind() {
  return notes([
    'Models and providers: Cloud models and n8n stop until their keys are saved again, and the Jev key too.',
    'Connections: Home Assistant must be connected again.',
    'Sign-ins for Nova’s browser: the one for shop.example is gone; save it again in Sites.',
    'Capture: the Screenpipe’s API key, if it asks for one.',
    'Infrastructure and network: Home lab’s LAB_API_TOKEN and Home router’s token must be saved again. A past run’s sealed copy of its tool state can’t be opened. A network change still waiting to be kept can’t be put back by Nova.',
    'Nova’s own keys: the encrypted backup copies made so far open only with the recovery key, if you were shown it and kept it.',
  ]);
}

function resetHead(id) {
  return `${back(id)}${kind('Asks every time')}<h3 class="uc-h" id="${id}-title">Start a new, empty vault?</h3>
<p class="au-sentence">All ${NAMES.length} secrets are left behind. Nova sets the old file aside in vault/ as ${mono('secrets.json.unopenable-<time>')}, and doesn’t open it again by itself.</p>
<h4 class="uc-group au-group-head" id="${id}-what">What has to be set again</h4>${leftBehind()}
<p class="au-note">The old key isn’t removed: it stays in ${esc(KEYCHAIN)}, so the file set aside could still be opened with it. (Flagged for the owner.)</p>
<p class="au-note">For a vault that can’t be opened, this is the way out. For one that opens, deleting each secret is gentler.</p>`;
}

function resetConfirm(id, { state = 'ready' } = {}) {
  return `<form class="au-form vt-confirm" data-sg-inert novalidate aria-labelledby="${id}-title">${resetHead(id)}
${passkeyConfirm({ state })}
<div class="au-actions">${passkeyAction({ state })}<button type="button" class="btn quiet">Cancel</button></div></form>`;
}

function resetPaired(id) {
  return `<form class="au-form vt-confirm" data-sg-inert novalidate aria-labelledby="${id}-title">${resetHead(id)}
<label class="confirm"><input type="checkbox" name="confirm" required> I understand, and I want Nova to do this.</label>
<p class="au-note">On a paired phone the core asks only for this box: no passkey, and any paired phone or browser can send it. (Flagged for the owner.)</p>
<div class="au-actions"><button type="submit" class="btn primary" data-vt-go disabled>Start a new vault</button><button type="button" class="btn quiet">Cancel</button></div></form>`;
}

function resetDone(id) {
  return `${back(id)}${kind('Started over')}<h3 class="uc-h" id="${id}-name">A new, empty vault</h3>
<p class="au-sentence">The old file is set aside as ${mono(`vault/${ASIDE}`)}.</p>
<h4 class="uc-group au-group-head" id="${id}-what">To set again</h4>${leftBehind()}
<div class="au-actions"><a class="btn" href="#${id}-connections">Open Connections</a><a class="btn" href="#${id}-providers">Open Models and providers</a></div>`;
}

// ---- when it won't open ------------------------------------------------------------------------------

function cantOpen(id, state) {
  const said = `<div class="vt-said" role="group" aria-labelledby="${id}-said-h"><p class="au-block-head" id="${id}-said-h">What Nova found</p><p class="vt-quote">${esc(PROBLEM[state])}</p></div>`;
  const head = `<h3 class="uc-h" id="${id}-name">Vault</h3><p class="uc-lede">${LEDE}</p>`;
  if (state === 'keychain-waiting') {
    return `${head}<p class="uc-state is-pending"><span class="uc-dot" aria-hidden="true"></span><span>Can’t open now: waiting for the keychain</span></p>${said}
<p class="au-note">Nothing is lost while it waits. Connections that need a secret can’t sign in until the keychain answers.</p>
<div class="au-actions"><button type="button" class="btn" data-vt-demo>Check again</button></div>
<div class="au-danger"><a class="btn quiet" href="#${id}-reset">Start a new vault anyway</a><p class="au-note">Asks every time (tier 3), with your passkey. The old file is kept aside, in case the keychain comes back.</p></div>`;
  }
  return `${head}<p class="uc-state is-unknown"><span class="uc-dot" aria-hidden="true"></span><span>Can’t open: the file is damaged</span></p>${said}
<p class="au-note">The next secret you save, by reconnecting a connection or adding a provider’s key, starts a new vault by itself. Its names can’t be listed until then.</p>
<div class="au-actions"><a class="btn primary" href="#${id}-connections">Open Connections</a></div>`;
}

// ---- frames ----------------------------------------------------------------------------------------

function screen(state, panes, live) {
  const id = `vt-${state}`;
  return `<div class="uc-screen vt" data-vt-frame="${state}"><div class="uc-main"><header class="uc-top"><button type="button" class="uc-icon uc-menu" aria-label="Open navigation">${icon('panel')}</button><h2 class="uc-title">Vault</h2>${slot(live, 24)}</header>
<div class="au-panes" data-au-pane="${paneOf(state)}">${panes(id)}</div></div></div>`;
}
const pair = (o, right) => (id) => `${listPane(id, o)}<div class="au-detail">${right(id)}</div>`;

export function vtFrame(state) {
  const all = { names: NAMES, current: '' };
  const at = (n) => ({ ...all, current: n });
  switch (state) {
    case 'empty': return screen(state, pair({ names: [] }, empty), 'idle');
    case 'secret': return screen(state, pair(at('provider/CLOUD_MODELS_KEY'), secret), 'idle');
    case 'delete-confirm': return screen(state, pair(at('provider/CLOUD_MODELS_KEY'), remove), 'needs-you');
    case 'deleted': return screen(state, pair({ names: NAMES.filter((n) => n !== 'provider/CLOUD_MODELS_KEY') }, deleted), 'idle');
    case 'elsewhere': return screen(state, pair(at('connector/home-assistant/HA_TOKEN'), elsewhere), 'idle');
    case 'own-key': return screen(state, pair(at('nova/backup-key'), ownKey), 'idle');
    case 'reset-confirm': return screen(state, pair(all, (id) => resetConfirm(id)), 'needs-you');
    case 'reset-no-passkey': return screen(state, pair(all, (id) => resetConfirm(id, { state: 'no-passkey' })), 'needs-you');
    case 'reset-paired': return screen(state, pair(all, resetPaired), 'needs-you');
    case 'reset-done': return screen(state, pair({ names: [] }, resetDone), 'idle');
    case 'file-key': return screen(state, pair({ ...all, file: true }, (id) => overview(id, { ...all, file: true })), 'idle');
    case 'keychain-waiting': return screen(state, pair({ names: [], problem: true }, (id) => cantOpen(id, state)), 'idle');
    case 'lost': return screen(state, pair({ names: [], problem: true }, (id) => cantOpen(id, state)), 'needs-you');
    default: return screen('list', pair(all, (id) => overview(id, all)), 'idle');
  }
}

// The styleguide entry: every frame, each with its full-screen address.
export function vtEntry(wrap) {
  return VT_FRAMES.map(([s, said]) => wrap(`${esc(said)} · <a class="link" href="?entry=vault&amp;frame=${s}">Full screen</a>`, vtFrame(s))).join('');
}
export const isVtFrame = (s) => VT_FRAMES.some(([k]) => k === s);

// Fills the status icon slots and makes the specimens move a little: a confirm box enables its
// button, the demo buttons say they are a demo, and a secret field is cleared when "saved".
export function bindVault(root) {
  for (const el of root.querySelectorAll('[data-vt-icon]')) {
    el.replaceChildren(statusIcon({ status: el.dataset.vtIcon, size: Number(el.dataset.vtSize), decorative: true }));
  }
  for (const frame of root.querySelectorAll('[data-vt-frame]')) {
    if (frame.dataset.vtBound) continue;
    frame.dataset.vtBound = '1';
    frame.addEventListener('change', (e) => {
      if (e.target.name !== 'confirm') return;
      const b = e.target.closest('form')?.querySelector('[data-action="passkey-confirm"], [data-vt-go]');
      if (b) b.disabled = !e.target.checked;
    });
    frame.addEventListener('click', (e) => {
      const b = e.target.closest('[data-vt-demo], [data-vt-go], [data-action^="passkey"]');
      if (b) {
        e.preventDefault();
        for (const s of b.closest('form')?.querySelectorAll('input[type="password"]') ?? []) s.value = '';
        b.textContent = 'Demo: nothing was sent';
      }
      if (e.target.closest('a[href^="#"]')) e.preventDefault();
    });
    frame.addEventListener('submit', (e) => e.preventDefault());
  }
}
