// Providers and models, design-first (2026-11-09): compositions for the owner's reaction, before any
// wiring. Styleguide only: the app never loads this file, nothing here is sent anywhere, and every
// control is a specimen (a box ticks; Check, Wake, Save and the token buttons say they are a demo).
//
// Drawn from the real model. Providers (src/core/providers/registry.ts, GET /api/v1/providers): six
// built-ins (Claude Code, Codex, a local model through Ollama or any OpenAI-compatible address, the
// model command from nova.config.json, n8n, Relay), each off until turned on (tier 2). Health is
// ready, not installed, not configured, unreachable or unchecked, in the backend's own words; only a
// provider with an address (or one set to a role) can be checked, and a check under local-only never
// reaches an address off the devices. A command-line provider is "Installed." when its program is
// found: nothing runs to find out. n8n's callback token is minted once when its settings are first
// saved (or on POST /providers/{id}/callback-token) and shown that once; Nova keeps only its hash.
// What may leave the devices is the privacy setting (local-only stops anything remote), each
// provider's on or off, a confirmation before an enabled provider's address or program changes, the
// cloud budget, and whether a brief's test command asks first (PUT /providers/policy).
// Models (src/core/models/index.ts, GET /api/v1/models): four roles (sorting, thinking and writing,
// finding by meaning, transcription), each on a device's Ollama; a sleeping computer is woken with
// Wake-on-LAN, and small jobs may go to a hub model meanwhile. There is no warm-up: a model loads on
// its first call and Ollama keeps it loaded 5 minutes. One cloud model, set with a confirmation,
// helps local-first work when the local one can't. Prices are the person's table (PUT /models/prices,
// which replaces the whole table and isn't returned by GET), the cloud model's own, or what a provider
// reports itself (Claude Code reports a cost); usage with tokens and no price makes a budgeted cloud wait.
// Proposed home: Settings › What Nova works with › Models and providers (settings-ia.js), the
// category that already holds both parts; no new place. Its CSS is ui/styles/compositions.css (.pv-*,
// and the .au-* panes it shares with the Automations compositions).
import { ICONS } from './components.js';
import { escapeHtml as esc } from './markdown.js';
import { statusIcon } from './status-icon.js';

// Every frame: [state, what it shows, which pane a phone shows].
export const PV_FRAMES = [
  ['overview', 'Settings › Models and providers at rest: which provider chats and codes, every provider with its health, what may leave your devices, the roles, the cloud model and its spend', 'detail'],
  ['provider', 'The providers, each with its health; the local model opened, not checked yet', 'list'],
  ['check-ok', 'Check now: the address answers (the backend’s words, with when)', 'detail'],
  ['check-unreachable', 'Check now: nothing answers at the address (the backend’s words)', 'detail'],
  ['check-no-model', 'Check now: the server answers but hasn’t the model (the backend says “Unreachable” here)', 'detail'],
  ['check-key', 'Check now: an address off your devices turns down the key; the key is a name in the vault, never shown', 'detail'],
  ['check-held', 'Not checked: your Nova is local-only and the address is off your devices, so Nova doesn’t reach it', 'detail'],
  ['not-installed', 'A command-line provider whose program isn’t on this computer: it can’t be turned on, and there is nothing to check', 'detail'],
  ['callback-once', 'n8n’s callback token, shown this once when its settings are first saved', 'detail'],
  ['callback-after', 'Afterwards: set, never shown again, no hint; Make a new token', 'detail'],
  ['callback-rotate', 'Making a new callback token: the old one stops working now', 'detail'],
  ['policy', 'What may leave your devices: the privacy setting, each provider’s destination, the confirmations and the budget', 'detail'],
  ['policy-allow', 'Letting Nova run a brief’s test commands without asking (tier 3): the confirmation', 'detail'],
  ['roles', 'Models per role: what runs where, on which device, and when the cloud model helps', 'detail'],
  ['wake', 'A role on a sleeping computer: wakeable, how long waking took, Wake it now; and the warm-up Nova doesn’t have', 'detail'],
  ['wake-failed', 'A wake that didn’t come up: the backend’s words, Try again or the cloud model this once', 'detail'],
  ['cloud', 'Cloud and local: the one cloud model, when it helps under each privacy setting, the budget and this month’s spend', 'detail'],
  ['cloud-set', 'Setting the cloud model: a new address needs your confirmation; the key is a vault name', 'detail'],
  ['prices', 'Prices and where each comes from: reported by the provider, the cloud model’s own, your table, or none', 'detail'],
];
const paneOf = (s) => PV_FRAMES.find(([k]) => k === s)?.[2] ?? 'list';
const IN_SETTINGS = new Set(['overview', 'policy', 'policy-allow', 'roles', 'wake', 'wake-failed', 'cloud', 'cloud-set', 'prices']);

// ---- the model: what GET /providers and GET /models say (only what's drawn) -----------------------

const HUB = 'Home server';
const SPOKE = 'Dell desktop';
const OLLAMA = '127.0.0.1:11434';
const N8N_HOST = 'n8n.example.net';
// A demo token, the shape the backend mints (32 random bytes, base64url: 43 characters). Not real.
const DEMO_TOKEN = 'Hd3kQ9vL2xW7nB4tR8mZ1cY6pF0sJ5gA-uE2oK7iN3w';

// Each provider as GET /providers lists it: its class, where it sends (Where.words), its health.
const PROVIDERS = {
  'claude-code': { name: 'Claude Code', kind: 'Coding agent', on: true, where: 'Sends the brief and the files it reads to Anthropic.', remote: true, health: 'Installed.', state: 'ready', cli: true },
  codex: { name: 'Codex', kind: 'Coding agent', on: false, where: 'Sends the brief and the files it reads to OpenAI.', remote: true, health: 'Not installed. Nova can’t find `codex` on this computer.', state: 'not_installed', cli: true },
  local: { name: 'Local model (Ollama or compatible)', kind: 'Chat model', on: true, where: 'Stays on this computer.', remote: false, health: 'Not checked yet.', state: 'unchecked' },
  'custom-cli': { name: 'Your model command', kind: 'Chat model', on: false, where: 'Sends what it is given to wherever llm sends it (counted as the cloud).', remote: true, health: 'Installed.', state: 'ready', cli: true },
  n8n: { name: 'n8n', kind: 'Automation', on: false, where: `Sends the brief to ${N8N_HOST}.`, remote: true, health: 'Not configured. It needs a callback token; saving its settings makes one.', state: 'not_configured' },
  relay: { name: 'Relay', kind: 'Coding agent', on: false, where: 'Stays on this computer.', remote: false, health: 'Not checked yet.', state: 'unchecked' },
};
const ORDER = ['claude-code', 'codex', 'local', 'custom-cli', 'n8n', 'relay'];

// What a check found, by frame: the provider's settings then, and the health words that came back.
const CHECKS = {
  provider: { base: `http://${OLLAMA}/v1`, model: 'qwen3:14b', key: '', health: 'Not checked yet.', at: null, tone: 'unknown' },
  'check-ok': { base: `http://${OLLAMA}/v1`, model: 'qwen3:14b', key: '', health: `Reachable at ${OLLAMA}.`, at: '14:02', tone: 'ok' },
  'check-unreachable': { base: `http://${OLLAMA}/v1`, model: 'qwen3:14b', key: '', health: `Unreachable. Nova couldn’t reach ${OLLAMA}: connect ECONNREFUSED ${OLLAMA}.`, at: '14:02', tone: 'unknown' },
  'check-no-model': { base: `http://${OLLAMA}/v1`, model: 'qwen3:14b', key: '', health: `Unreachable. ${OLLAMA} answers, but has no model called qwen3:14b (it has qwen3:4b, nomic-embed-text).`, at: '14:02', tone: 'unknown' },
  'check-key': { base: 'https://api.example.com/v1', model: 'example-large', key: 'secret://EXAMPLE_KEY', health: 'Unreachable. api.example.com turned down the key (Invalid API key).', at: '14:02', tone: 'unknown', remote: true },
  'check-held': { base: 'https://api.example.com/v1', model: 'example-large', key: 'secret://EXAMPLE_KEY', health: 'Not checked: it is off your devices, and your privacy setting keeps Nova from reaching it.', at: null, tone: 'unknown', remote: true, held: true },
};

// The roles as GET /models gives them (ROLE_WORDS, and each one's placement and state).
const ROLES = [
  { role: 'triage-text', name: 'Sorting', does: 'quick, small decisions: what an event is, whether it needs you', state: 'Ready', where: `qwen3:4b on ${HUB}.` },
  { role: 'reasoner', name: 'Thinking and writing', does: 'chat, briefs and delegated work', state: 'Asleep', where: `qwen3:14b on ${SPOKE} (asleep, wakeable; waking took 38 s); small jobs: qwen3:4b on the hub.` },
  { role: 'embedder', name: 'Finding by meaning', does: 'search over your notes and memory', state: 'Ready', where: `nomic-embed-text on ${HUB}.` },
  { role: 'transcriber', name: 'Transcription', does: 'turning speech into text', state: 'No runtime', where: 'There is no transcription runtime on your devices (Nova looks for whisper.cpp or faster-whisper), so transcription stays off. Nothing is sent elsewhere to transcribe instead.' },
];
const CLOUD = { name: 'Cloud model', host: 'api.example.com', base: 'https://api.example.com/v1', model: 'example-large', key: 'secret://CLOUD_KEY', spent: '$3.42', budget: '$20.00', period: 'month', task: '$1.00' };
const PRIVACY = {
  'local-only': 'Local only: every task stays on your devices, and no cloud model is used.',
  'local-preferred': 'Local first: your devices answer first; the cloud model helps only when they can’t.',
  'cloud-allowed': 'Cloud allowed: Nova may choose the cloud model as well as your devices.',
};

// ---- the words: small pieces --------------------------------------------------------------------

const icon = (name) => ICONS[name] ?? '';
const slot = (state, size) => `<span class="au-icon" data-pv-icon="${state}" data-pv-size="${size}" aria-hidden="true"></span>`;
const facts = (rows) => `<dl class="uc-facts au-facts">${rows.map(([k, v]) => `<div class="uc-fact"><dt>${k}</dt><dd>${v}</dd></div>`).join('')}</dl>`;
const mono = (t) => `<span class="uc-mono">${esc(t)}</span>`;
// A backtick in the backend's words is code: drawn in mono, never as a literal backtick.
const said = (t) => esc(t).replace(/`([^`]+)`/g, '<span class="uc-mono">$1</span>');
const health = (tone, words) => `<p class="uc-state is-${tone}"><span class="uc-dot" aria-hidden="true"></span><span>${said(words)}</span></p>`;
const gap = (id, head, body) => `<div class="pv-gap" role="group" aria-labelledby="${id}"><p class="au-block-head" id="${id}">${head}</p>${body}</div>`;

// ---- Settings: the category this lives in ---------------------------------------------------------

// Settings' categories (settings-ia.js), with Models and providers current.
const GROUPS = [
  ['You', [['You and Nova', 'Names and how Nova talks to you'], ['Appearance', 'Theme, light and dark, contrast'], ['Privacy and permissions', 'What stays here and what asks first']]],
  ['What Nova works with', [['Connections', 'Accounts and services Nova can reach'], ['models', ''], ['Devices', 'Phones and computers paired with Nova'], ['Capture', 'Sources, consent, and what Nova remembers'], ['Services', 'How Nova runs its services here']]],
  ['About', [['About Nova', 'Its version and build, what’s new, where it stands']]],
  ['Keeping Nova safe', [['Security', 'Passkeys that confirm tier-3 actions here'], ['Backups and changes', 'Backup folders, checkpoints, restores and changes'], ['Configuration', 'Every setting of yours, a few questions, or a file'], ['Start over', 'Export everything, or erase Nova here']]],
];

function categories(id) {
  let n = 0;
  const row = ([name, note]) => {
    const mine = name === 'models';
    const href = mine ? `#${id}-models` : `#${id}-cat-${n++}`;
    const label = mine ? 'Models and providers' : name;
    const meta = mine ? '2 providers on · 3 of 4 roles set' : note;
    return `<li><a class="uc-row au-open${mine ? ' is-on' : ''}" href="${href}"${mine ? ' aria-current="true"' : ''}><span class="au-text"><span class="au-name">${esc(label)}</span><span class="au-meta">${esc(meta)}</span></span><span class="uc-ic" aria-hidden="true">${icon('chevron')}</span></a></li>`;
  };
  const groups = GROUPS.map(([g, cats], gi) => `<h3 class="uc-group" id="${id}-g${gi}">${g}</h3><ul class="pv-list" aria-labelledby="${id}-g${gi}">${cats.map(row).join('')}</ul>`).join('');
  return `<nav class="au-list" aria-label="Settings categories">${groups}</nav>`;
}

const toSettings = (id) => `<a class="uc-row uc-back" href="#${id}-settings"><span class="uc-ic" aria-hidden="true">${icon('back')}</span><span>Settings</span></a>`;
// A section of the one page, in a frame of its own: the page's name above it.
const crumb = (id, section) => `${toSettings(id)}<p class="pv-kind">Models and providers</p><h3 class="uc-h" id="${id}-name">${section}</h3>`;

// One provider as a row: its name, class and where it sends, then on or off and its health.
function providerRow(id, key, { current = '', live = {} } = {}) {
  const p = { ...PROVIDERS[key], ...live[key] };
  const h = p.health;
  return `<li><a class="uc-row au-open${current === key ? ' is-on' : ''}" href="#${id}-p-${key}"${current === key ? ' aria-current="true"' : ''}><span class="au-text"><span class="au-name">${esc(p.name)}</span><span class="au-meta">${esc(p.kind)}. ${said(p.where)}</span><span class="au-meta pv-health">${said(h)}</span></span><span class="au-state">${p.on ? 'On' : 'Off'}</span></a></li>`;
}

function overview(id) {
  const providers = ORDER.map((k) => providerRow(id, k)).join('');
  const roles = ROLES.map((r) => `<li class="pv-line"><span class="au-text"><span class="au-name">${esc(r.name)}</span><span class="au-meta">${esc(r.where)}</span></span><span class="au-state">${esc(r.state)}</span></li>`).join('');
  return `${toSettings(id)}<h3 class="uc-h" id="${id}-name">Models and providers</h3><p class="uc-lede">Models on your own devices, and other AIs and automations Nova can hand work to. Each provider is off until you turn it on.</p>
<h4 class="uc-group au-group-head" id="${id}-use">In use</h4>${facts([['Chat', `${esc(PROVIDERS.local.name)}, at ${OLLAMA}. Stays on this computer.`], ['Coding tasks', `${esc(PROVIDERS['claude-code'].name)}. ${said(PROVIDERS['claude-code'].where)}`]])}
<h4 class="uc-group au-group-head" id="${id}-prov">Providers · 2 of 6 on</h4><ul class="pv-list" aria-labelledby="${id}-prov">${providers}</ul>
<p class="au-note">Only a provider with an address, or one set to a role, can be checked. A command-line one is “Installed.” when Nova finds its program; Nova doesn’t run it to find out.</p>
<h4 class="uc-group au-group-head" id="${id}-leave">What may leave your devices</h4><p class="au-sentence">${esc(PRIVACY['local-preferred'])}</p>
<p class="au-note">Claude Code is on and sends to Anthropic. Over the cloud budget, work for it waits and says why.</p><div class="au-actions"><a class="btn quiet" href="#${id}-policy">What may leave, in full</a></div>
<h4 class="uc-group au-group-head" id="${id}-roles">What runs where</h4><ul class="pv-list pv-lines" aria-labelledby="${id}-roles">${roles}</ul>
<h4 class="uc-group au-group-head" id="${id}-cloud">Cloud</h4><p class="au-note">${esc(CLOUD.name)} (${esc(CLOUD.model)}) helps only when your local models can’t. This ${CLOUD.period}: ${CLOUD.spent} of ${CLOUD.budget}.</p>
<div class="au-actions"><a class="btn quiet" href="#${id}-cloudm">Cloud model and budget</a><a class="btn quiet" href="#${id}-prices">Prices</a></div>`;
}

// ---- inside the providers: the list beside the one open --------------------------------------------

function providerList(id, current, live = {}) {
  return `<div class="au-list"><p class="au-intro">Each is off until you turn it on. Nova checks what they do before it counts.</p><h3 class="uc-group" id="${id}-plist">Providers · 2 of 6 on</h3><ul class="pv-list" aria-labelledby="${id}-plist">${ORDER.map((k) => providerRow(id, k, { current, live })).join('')}</ul></div>`;
}

const toProviders = (id) => `<a class="uc-row uc-back" href="#${id}-list"><span class="uc-ic" aria-hidden="true">${icon('back')}</span><span>Providers</span></a>`;

// The local model (openai-compatible): its settings, where it sends, and Check now.
function localDetail(id, state) {
  const c = CHECKS[state];
  const name = PROVIDERS.local.name;
  const where = c.remote ? `Sends the brief to ${CLOUD.host}.` : PROVIDERS.local.where;
  const at = c.at ? `<p class="au-note">Checked at ${c.at}. While it is on, Nova checks again by itself after its settings change.</p>` : '';
  const result = state === 'provider' ? '' : `<div class="pv-said" role="group" aria-labelledby="${id}-chk-h"><p class="au-block-head" id="${id}-chk-h">What the check found</p>${health(c.tone, c.health)}${at}</div>`;
  const held = c.held
    ? `<p class="au-note">${esc(PRIVACY['local-only'])} A check is a connection too, so Nova sends nothing to ${CLOUD.host}, not even to ask.</p><div class="au-actions"><a class="btn" href="#${id}-privacy">Privacy settings</a></div>`
    : `<div class="au-actions"><button type="button" class="btn${state === 'provider' ? ' primary' : ''}" data-pv-demo>Check now</button></div><p class="au-note">Asks ${esc(c.remote ? CLOUD.host : OLLAMA)} for the models it has, and nothing else, for at most 4 seconds. It doesn’t follow a redirect.</p>`;
  const rows = [
    ['Where it sends', esc(where)],
    ['Server address', mono(c.base)],
    ['Model', mono(c.model)],
    ['Key', c.key ? `${mono(c.key)}, a name in the vault. Its value isn’t shown here or anywhere.` : 'None: Ollama on this computer needs none.'],
  ];
  return `${toProviders(id)}<p class="pv-kind">Chat model · ${c.remote ? 'off your devices' : 'on'}</p><h3 class="uc-h" id="${id}-name">${esc(name)}</h3>
${state === 'provider' ? health(c.tone, c.health) : ''}${result}${held}
<h4 class="uc-group au-group-head" id="${id}-set">Its settings</h4>${facts(rows)}
<p class="au-note">Changing its address while it is on needs your confirmation: that changes where your data goes${c.key ? ', and its key goes along' : ''}.</p>
<div class="au-actions"><a class="btn quiet" href="#${id}-edit">Change its settings</a><button type="button" class="btn quiet" data-pv-demo>Turn off</button></div>`;
}

function codexDetail(id) {
  const p = PROVIDERS.codex;
  return `${toProviders(id)}<p class="pv-kind">Coding agent · off</p><h3 class="uc-h" id="${id}-name">${esc(p.name)}</h3>
${health('unknown', p.health)}
<p class="au-note">Nova can’t turn it on until it is. Nova doesn’t install it. There is nothing to check: it has no address, and Nova doesn’t run it to see.</p>
${facts([['Where it sends', said(p.where)], ['Program', `${mono('codex')}, or its full path`], ['Model', 'Codex’s default'], ['Sandbox', mono('workspace-write')]])}
<div class="au-actions"><a class="btn quiet" href="#${id}-edit">Change its settings</a><button type="button" class="btn quiet" disabled>Turn on</button></div>`;
}

// n8n: the callback token, by stage. The token comes back once, in the reply that made it.
function n8nDetail(id, stage) {
  const path = `${mono('POST /api/v1/hooks/n8n-callback')}`;
  const head = `${toProviders(id)}<p class="pv-kind">Automation · off</p><h3 class="uc-h" id="${id}-name">n8n</h3>`;
  const settings = facts([['Where it sends', said(PROVIDERS.n8n.where)], ['Workflow webhook', mono(`https://${N8N_HOST}/webhook/nova`)], ['Signing secret', `${mono('secret://N8N_SIGNING_SECRET')}, a name in the vault; the workflow signs with the same secret.`]]);
  if (stage === 'once') {
    return `${head}<section class="au-token" aria-labelledby="${id}-tok-h"><h4 class="au-block-head" id="${id}-tok-h">Copy the callback token now</h4>
<p class="au-note">Give this token to the workflow’s callback (header x-nova-hook-token, to /api/v1/hooks/n8n-callback). Nova keeps only a hash of it and won’t show it again.</p>
<label class="au-label" for="${id}-tok">Callback token <span class="uc-faint">(demo, not a real token)</span></label>
<div class="au-token-row"><input class="uc-input uc-mono au-token-value" id="${id}-tok" readonly value="${DEMO_TOKEN}" spellcheck="false" autocomplete="off"><button type="button" class="btn primary" data-pv-demo>Copy</button></div>
<p class="au-note">A callback needs this token and a signature made with the signing secret; Nova refuses one without both.</p>
<button type="button" class="btn">I’ve saved it</button></section>
<h4 class="uc-group au-group-head" id="${id}-set">Its settings, saved</h4>${settings}`;
  }
  const row = `<div class="uc-set"><div class="uc-set-text"><p class="uc-set-name">Callback token</p><p class="uc-set-note">Set. Nova keeps only a hash of it, so it can’t show it, or any part of it, again.</p></div><div class="uc-set-ctl"><button type="button" class="btn"${stage === 'rotate' ? ' aria-expanded="true"' : ''}>Make a new token</button></div></div>`;
  const confirm = stage === 'rotate' ? `<div class="au-confirm" role="group" aria-labelledby="${id}-rot-h"><h4 class="au-block-head" id="${id}-rot-h">Make a new callback token?</h4>
<p class="au-note">The old token stops working now: a callback sent with it is refused until you give the workflow the new one. Nova shows the new one once.</p>
<div class="au-actions"><button type="button" class="btn primary" data-pv-demo>Make a new token</button><button type="button" class="btn quiet">Cancel</button></div></div>` : '';
  return `${head}${health('ok', 'Reachable at n8n.example.net.')}<p class="au-note">Reaching the host is what Nova can check without a real call: a webhook answers only to one.</p>
${row}${confirm}<div class="uc-set"><div class="uc-set-text"><p class="uc-set-name">Where the workflow calls back</p><p class="uc-set-note">${path}</p></div></div>
<h4 class="uc-group au-group-head" id="${id}-set">Its settings</h4>${settings}
<div class="au-actions"><a class="btn quiet" href="#${id}-edit">Change its settings</a><button type="button" class="btn quiet" data-pv-demo>Turn on</button></div>`;
}

// ---- the category's sections ---------------------------------------------------------------------

function policy(id, { confirming = false } = {}) {
  const dest = ORDER.filter((k) => k !== 'custom-cli').map((k) => {
    const p = PROVIDERS[k];
    return `<li class="pv-line"><span class="au-text"><span class="au-name">${esc(p.name)}</span><span class="au-meta">${said(p.where)}</span></span><span class="au-state">${p.on ? (p.remote ? 'On · off your devices' : 'On') : 'Off'}</span></li>`;
  }).join('');
  const tests = confirming
    ? `<form class="au-confirm" data-sg-inert novalidate aria-labelledby="${id}-t-h"><h4 class="au-block-head" id="${id}-t-h">Run a brief’s test command without asking?</h4>
<p class="au-note">Only on files no provider changed. Code a provider wrote is asked about every time, whatever this says.</p>
<label class="uc-choice au-choice"><input type="checkbox" name="confirm"><span>I confirm: Nova may run these test commands without asking me.</span></label>
<div class="au-actions"><button type="submit" class="btn primary" data-pv-demo disabled>Allow</button><button type="button" class="btn quiet">Cancel</button></div></form>`
    : `<div class="uc-set"><div class="uc-set-text"><p class="uc-set-name">Test commands a brief declares</p><p class="uc-set-note">Nova asks before running them. Code a provider wrote is always asked about.</p></div><div class="uc-set-ctl"><button type="button" class="btn">Run them without asking</button></div></div>`;
  return `${crumb(id, 'What may leave your devices')}
<p class="au-sentence">${esc(PRIVACY['local-preferred'])}</p><div class="au-actions"><a class="btn quiet" href="#${id}-privacy">Change it in Privacy and permissions</a></div>
<p class="au-note">Local only stops every provider that sends off your devices, and a check of one; local first and cloud allowed let a provider you turned on send where it says. A task can be stricter than this, never looser.</p>
<h4 class="uc-group au-group-head" id="${id}-dest">Where each provider sends</h4><ul class="pv-list pv-lines" aria-labelledby="${id}-dest">${dest}</ul>
<p class="au-note">An address counts as your devices only when it is this computer or one of your paired devices. Anywhere else, your own network included, counts as the cloud.</p>
<h4 class="uc-group au-group-head" id="${id}-asks">What asks first</h4>
${facts([['Turning a provider on', 'Asks first (tier 2), showing what it may do and where it sends.'], ['Changing where an enabled one sends', 'Its program, address, webhook or callback address: needs your confirmation.'], ['Giving one more room', 'Its permission mode, sandbox or allowed tools: needs your confirmation.'], ['Over the cloud budget', 'Work for a provider off your devices waits, and says why.']])}
${tests}`;
}

function roles(id) {
  const rows = ROLES.map((r) => `<li class="pv-role"><div class="pv-role-head"><p class="au-name">${esc(r.name)}</p><span class="au-state">${esc(r.state)}</span></div><p class="au-meta">For ${esc(r.does)}.</p><p class="au-note">${esc(r.where)}</p></li>`).join('');
  return `${crumb(id, 'What runs where')}<p class="au-sentence">${esc(PRIVACY['local-preferred'])}</p>
<ul class="pv-list" aria-label="Roles">${rows}</ul>
<p class="au-note">A model whose name ends in -cloud runs in Ollama’s cloud, so Nova won’t give it a role.</p>
<div class="au-actions"><a class="btn quiet" href="#${id}-dm">Models on ${SPOKE}</a><a class="btn quiet" href="#${id}-dmh">Models on ${HUB}</a></div>`;
}

// The warm-up that isn't there: drawn as a gap, never as a control.
const NO_WARMUP = (id) => gap(`${id}-warm-h`, 'No warm-up yet', `<p class="au-note">Nova loads a model on its first call, and Ollama keeps it loaded for 5 minutes after each one. There is no way yet to load it ahead of time, or keep it loaded longer; the first reply after a quiet spell waits for the load.</p>`);

function wake(id, { failed = false } = {}) {
  const r = ROLES[1];
  const state = failed
    ? `<div class="pv-said" role="group" aria-labelledby="${id}-w-h"><p class="au-block-head" id="${id}-w-h">${SPOKE} · Couldn’t wake</p><p class="pv-quote">${HUB} sent the wake signal at 14:02 and waited 59 s, half again what waking took last time (38 s). ${SPOKE} didn’t answer.</p><p class="pv-quote">Work for it waits on your devices until ${SPOKE} checks in. Nova won’t keep waking it.</p>
<div class="au-actions"><button type="button" class="btn" data-pv-demo>Try waking it again</button><button type="button" class="btn quiet" data-pv-demo>Use the cloud model this once</button></div></div>
<p class="au-note">The cloud model this once sends only the work waiting on ${SPOKE}, and each of those tasks records it. The next failed wake asks again.</p>`
    : `<div class="pv-said" role="group" aria-labelledby="${id}-w-h"><p class="au-block-head" id="${id}-w-h">${SPOKE} · Asleep, wakeable</p><p class="pv-quote">Nova wakes it when work needs it: ${HUB} sends the wake signal on their shared network. Waking took 38 s last time.</p>
<div class="au-actions"><button type="button" class="btn" data-pv-demo>Wake it now</button></div></div>
<p class="au-note">Wake it now is a task in Tasks. Nova wakes one computer at most 4 times an hour, and sends at most 12 wakes an hour across all your devices.</p>`;
  return `${crumb(id, r.name)}<p class="au-meta">For ${esc(r.does)}.</p>${facts([['Model', `${mono('qwen3:14b')} on ${SPOKE}`], ['Small jobs while it sleeps', `${mono('qwen3:4b')} on ${HUB}, rather than waking it`], ['When it’s idle', 'Sleeps after 30 minutes'], ['When work needs it', 'Nova wakes it']])}
${state}${NO_WARMUP(id)}<div class="au-actions"><a class="btn quiet" href="#${id}-dm">Sleep and wake on ${SPOKE}</a></div>`;
}

function cloud(id) {
  const modes = Object.entries(PRIVACY).map(([k, v]) => `<li class="pv-line${k === 'local-preferred' ? ' is-now' : ''}"><span class="au-text"><span class="au-name">${k === 'local-preferred' ? 'Yours now · ' : ''}${esc(v.split(':')[0])}</span><span class="au-meta">${esc(v.slice(v.indexOf(':') + 2))}</span></span></li>`).join('');
  return `${crumb(id, 'Cloud and local')}<p class="au-sentence">${esc(CLOUD.name)} (${esc(CLOUD.model)}) helps only when your local models can’t. This ${CLOUD.period}: ${CLOUD.spent} of ${CLOUD.budget}.</p>
<h4 class="uc-group au-group-head" id="${id}-modes">When it helps</h4><ul class="pv-list pv-lines" aria-labelledby="${id}-modes">${modes}</ul>
<p class="au-note">When it answers, the reply says so on a line of its own, and its receipt says where it went.</p>
<h4 class="uc-group au-group-head" id="${id}-cm">The cloud model</h4>${facts([['Address', `${mono(CLOUD.base)}, OpenAI-compatible`], ['Model', mono(CLOUD.model)], ['Key', `${mono(CLOUD.key)}, a name in the vault. Its value isn’t shown.`], ['Longest reply', '4096 tokens, which bounds what one call costs'], ['Price', 'Set with it, so Nova can count what it spends']])}
<div class="au-actions"><a class="btn quiet" href="#${id}-cloudset">Change the cloud model</a><button type="button" class="btn quiet" data-pv-demo>Remove it</button></div>
<h4 class="uc-group au-group-head" id="${id}-budget">Budget</h4>
<form class="au-form" data-sg-inert novalidate aria-labelledby="${id}-budget"><div class="au-pair"><div class="au-field"><label class="au-label" for="${id}-pt">Per task (US$)</label><input class="uc-input" id="${id}-pt" inputmode="decimal" value="1.00"></div><div class="au-field"><label class="au-label" for="${id}-pp">Per month (US$)</label><input class="uc-input" id="${id}-pp" inputmode="decimal" value="20.00"></div></div>
<p class="au-note">Over budget, work that needs the cloud waits and says why; local models stay the default.</p><div class="au-actions"><button type="submit" class="btn" data-pv-demo>Save budget</button></div></form>`;
}

function cloudSet(id) {
  return `${crumb(id, 'Change the cloud model')}<form class="au-form" data-sg-inert novalidate aria-labelledby="${id}-name">
<div class="au-field"><label class="au-label" for="${id}-cn">Name</label><input class="uc-input" id="${id}-cn" value="Cloud model"></div>
<div class="au-field"><label class="au-label" for="${id}-cb">Address</label><input class="uc-input uc-mono" id="${id}-cb" value="https://api.other.example/v1" spellcheck="false" autocapitalize="off"><p class="au-note">Its OpenAI-compatible address.</p></div>
<div class="au-field"><label class="au-label" for="${id}-cmod">Model</label><input class="uc-input uc-mono" id="${id}-cmod" value="other-medium" spellcheck="false" autocapitalize="off"></div>
<div class="au-field"><label class="au-label" for="${id}-ck">Key</label><input class="uc-input uc-mono" id="${id}-ck" value="secret://OTHER_KEY" spellcheck="false" autocapitalize="off"><p class="au-note">A name in the vault, like secret://CLOUD_KEY: the value goes into the vault, not here.</p></div>
<div class="au-pair"><div class="au-field"><label class="au-label" for="${id}-pin">US$ per million tokens in</label><input class="uc-input" id="${id}-pin" inputmode="decimal" value="0.40"></div><div class="au-field"><label class="au-label" for="${id}-pout">US$ per million tokens out</label><input class="uc-input" id="${id}-pout" inputmode="decimal" value="1.60"></div></div>
<div class="au-confirm" role="group" aria-labelledby="${id}-c-h"><h4 class="au-block-head" id="${id}-c-h">A new address</h4><p class="au-note">Setting a cloud model lets local-preferred and cloud-allowed work go to api.other.example.</p>
<label class="uc-choice au-choice"><input type="checkbox" name="confirm"><span>I confirm: work may go to api.other.example.</span></label></div>
<div class="au-actions"><button type="submit" class="btn primary" data-pv-demo disabled>Save</button><button type="button" class="btn quiet">Cancel</button></div></form>`;
}

function prices(id) {
  const rows = [
    ['Claude Code', 'Reported by Claude Code with each run', 'It says what a run cost; Nova counts that.'],
    [`${CLOUD.name} (${CLOUD.model})`, 'Set with the cloud model', '$0.40 in, $1.60 out, per million tokens.'],
    ['codex', 'None', 'Codex reports tokens, not a cost, and there is no price for it.'],
  ].map(([who, from, note]) => `<li class="pv-line"><span class="au-text"><span class="au-name">${esc(who)}</span><span class="au-meta">${esc(note)}</span></span><span class="au-state">${esc(from)}</span></li>`).join('');
  return `${crumb(id, 'Prices')}<p class="au-sentence">What a model costs, so a budget can be kept.</p>
<ul class="pv-list pv-lines" aria-label="Where each price comes from">${rows}</ul>
<div class="pv-said" role="group" aria-labelledby="${id}-w-h"><p class="au-block-head" id="${id}-w-h">The cloud waits</p><p class="pv-quote">Nova can’t tell what codex cost (it reported tokens but no price), so with a budget set the cloud waits. Nova needs a price for it (PUT /api/v1/models/prices).</p></div>
<h4 class="uc-group au-group-head" id="${id}-add">Your prices</h4>
<form class="au-form" data-sg-inert novalidate aria-labelledby="${id}-add"><div class="au-field"><label class="au-label" for="${id}-pm">Model</label><input class="uc-input uc-mono" id="${id}-pm" value="codex" spellcheck="false" autocapitalize="off"></div>
<div class="au-pair"><div class="au-field"><label class="au-label" for="${id}-pi">US$ per million tokens in</label><input class="uc-input" id="${id}-pi" inputmode="decimal" value=""></div><div class="au-field"><label class="au-label" for="${id}-po">US$ per million tokens out</label><input class="uc-input" id="${id}-po" inputmode="decimal" value=""></div></div>
<div class="au-actions"><button type="submit" class="btn primary" data-pv-demo>Save price</button></div></form>
${gap(`${id}-np-h`, 'Nova can’t list your prices yet', '<p class="au-note">Nova keeps the prices you give it, but doesn’t show them back, and saving replaces the whole list. Until it can, this page can’t show or edit one price beside the others. Nova has no price list of its own: every price is yours, the cloud model’s, or a provider’s own report.</p>')}`;
}

// ---- frames ----------------------------------------------------------------------------------------

function screen(state, title, panes, live) {
  const id = `pv-${state}`;
  return `<div class="uc-screen pv" data-pv-frame="${state}"><div class="uc-main"><header class="uc-top"><button type="button" class="uc-icon uc-menu" aria-label="Open navigation">${icon('panel')}</button><h2 class="uc-title">${title}</h2>${slot(live, 24)}</header>
<div class="au-panes" data-au-pane="${paneOf(state)}">${panes(id)}</div></div></div>`;
}
const pair = (list, right) => (id) => `${list(id)}<div class="au-detail">${right(id)}</div>`;
const LIVE = { 'policy-allow': 'needs-you', 'cloud-set': 'needs-you', 'callback-rotate': 'needs-you' };
const SECTIONS = {
  overview, policy, 'policy-allow': (id) => policy(id, { confirming: true }), roles, wake, 'wake-failed': (id) => wake(id, { failed: true }), cloud, 'cloud-set': cloudSet, prices,
};

export function pvFrame(state) {
  const live = LIVE[state] ?? 'idle';
  if (IN_SETTINGS.has(state)) return screen(state, 'Settings', pair(categories, SECTIONS[state]), live);
  const inside = (current, right, liveHealth = {}) => screen(state, 'Providers', pair((id) => providerList(id, current, liveHealth), right), live);
  if (state === 'not-installed') return inside('codex', codexDetail);
  if (state === 'callback-once') return inside('n8n', (id) => n8nDetail(id, 'once'), { n8n: { health: 'Not checked yet.' } });
  if (state === 'callback-after') return inside('n8n', (id) => n8nDetail(id, 'after'), { n8n: { health: 'Reachable at n8n.example.net.' } });
  if (state === 'callback-rotate') return inside('n8n', (id) => n8nDetail(id, 'rotate'), { n8n: { health: 'Reachable at n8n.example.net.' } });
  if (CHECKS[state]) {
    const c = CHECKS[state];
    return inside('local', (id) => localDetail(id, state), { local: { health: c.health, ...(c.remote ? { where: `Sends the brief to ${CLOUD.host}.` } : {}) } });
  }
  return pvFrame('overview');
}
// The styleguide entry: every frame, each with its full-screen address.
export function pvEntry(wrap) {
  return PV_FRAMES.map(([s, words]) => wrap(`${esc(words)} · <a class="link" href="?entry=providers&amp;frame=${s}">Full screen</a>`, pvFrame(s))).join('');
}
export const isPvFrame = (s) => PV_FRAMES.some(([k]) => k === s);

// Fills the status icon slots and makes the specimens move a little: a confirmation box enables its
// button, and the demo buttons say they are a demo.
export function bindProviders(root) {
  for (const el of root.querySelectorAll('[data-pv-icon]')) {
    el.replaceChildren(statusIcon({ status: el.dataset.pvIcon, size: Number(el.dataset.pvSize), decorative: true }));
  }
  for (const frame of root.querySelectorAll('[data-pv-frame]')) {
    if (frame.dataset.pvBound) continue;
    frame.dataset.pvBound = '1';
    frame.addEventListener('change', (e) => {
      if (e.target.name !== 'confirm') return;
      const b = e.target.closest('form')?.querySelector('button[type="submit"]');
      if (b) b.disabled = !e.target.checked;
    });
    frame.addEventListener('click', (e) => {
      const b = e.target.closest('[data-pv-demo]');
      if (b) { e.preventDefault(); b.textContent = 'Demo: nothing was sent'; }
      if (e.target.closest('a[href^="#"]')) e.preventDefault();
    });
  }
}
