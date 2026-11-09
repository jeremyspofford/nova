// Infrastructure projects and network targets, design-first (2026-11-09): compositions for the
// owner's reaction, before any wiring. Styleguide only: the app never loads this file, nothing here is
// sent anywhere, every project, target and host is made up (*.example), and no secret value is ever
// drawn: a secret field is always empty, and a stored one only says that it is stored.
//
// Drawn from the real model. Infrastructure (src/core/infra/index.ts and routes.ts): GET /infra is
// {tool: {id, name, installed}, projects, runs}; a project is {id, name, folder, tool, egress
// (remote | local), budget_usd_month, prices, secrets: [{name, stored}], resources: [{address, type,
// monthly_usd}], monthly_usd, level, words}. POST /infra/projects takes {name (1–60), folder (a full
// path holding .tf or .tf.json files; not the home folder, a hidden or system folder, or Nova's own),
// budget_usd_month (0 to 1,000,000), prices ({type: usd | {by, prices: {value: usd}}}), secrets?
// (ENV_NAME, at most 20), egress?}. PUT /infra/projects/{id} changes only the budget and the price
// sheet; PUT /infra/projects/{id}/secrets/{NAME} keeps one value in the vault (infra/<id>/<NAME>),
// handed to OpenTofu's process only, and redacted from logs. Network (src/core/network/index.ts,
// targets.ts, routes.ts): GET /network is {window_s, devices (those whose contact counts), targets,
// changes}; a target is {id, name, kind (router | dns | firewall | tailnet), adapter (http-config),
// url, token (stored or not), egress}. POST /network/targets takes {name, kind, url (https, or plain
// http only to this computer; no sign-in in it), adapter?}; PUT /network/targets/{id}/token keeps
// the token in the vault (network/<id>/token), sent only to that address as a bearer token.
//
// What the backend doesn't have, so these frames don't draw it as working: no route removes a
// project or a target, renames one, or changes a target's kind or address; nothing tests a secret or
// a token when it is saved (the first plan, or a change's snapshot, is the first use); and adding,
// editing or saving a secret needs no passkey. Only an apply (and a destroy plan's apply) is tier 3,
// confirmed in Tasks. Its CSS is ui/styles/compositions.css (.if-*, and the .au-* panes it shares
// with the Automations compositions); the narrow layout is layout.css's .au-panes rule.
import { ICONS } from './components.js';
import { escapeHtml as esc } from './markdown.js';
import { statusIcon } from './status-icon.js';

// Every frame: [state, what it shows, which pane a phone shows].
export const IF_FRAMES = [
  ['list', 'Both lists, a project opened: its budget, secrets (stored or not), what Nova provisioned and its price sheet', 'list'],
  ['empty', 'Nothing registered yet, OpenTofu not on this computer and no phone paired', 'list'],
  ['project-add', 'Adding a project: folder, monthly budget, price sheet, where the provider’s calls go, the names of its secrets', 'detail'],
  ['project-invalid', 'Adding a project: three problems, each beside its field, in the core’s own words', 'detail'],
  ['project-secrets', 'The credential step: each secret’s value goes into the vault; one stored, one still to save. No test on save: the first plan is the first use', 'detail'],
  ['project-failed', 'The first plan failed: what OpenTofu said (secrets redacted), nothing changed, and saving a new value', 'detail'],
  ['project-edit', 'Editing a project: only the budget and the price sheet change; destroying is a plan first and a tier-3 apply in Tasks. No remove route (flagged)', 'detail'],
  ['targets', 'A network target opened: its adapter, address, token stored, the dead-man’s switch and its changes', 'detail'],
  ['target-add', 'Adding a target: name, kind, the address of its configuration; http-config is the only adapter', 'detail'],
  ['target-invalid', 'Adding a target: no name, no kind, and plain http to another machine, refused', 'detail'],
  ['target-token', 'The credential step: the token goes into the vault, sent only to that address. No test on save: a change’s snapshot is the first use', 'detail'],
  ['target-failed', 'A change couldn’t start: the target refused the token. Nothing was read or written', 'detail'],
  ['target-edit', 'Editing a target: only its token can be replaced. No rename, readdress or remove route (flagged)', 'detail'],
];
const paneOf = (s) => IF_FRAMES.find(([k]) => k === s)?.[2] ?? 'list';

// ---- the model, made up ----------------------------------------------------------------------------

// GET /infra, as the core returns it (the fields drawn here).
const TOOL = { id: 'opentofu', name: 'OpenTofu', installed: true };
const HOME_LAB = {
  id: 'p3c41a9e2b0', name: 'Home lab', folder: '/home/you/infra/home-lab', egress: 'local', budget_usd_month: 20,
  prices: { example_vm: { by: 'size', prices: { small: 4, medium: 8 } }, example_dns_record: 0 },
  secrets: [{ name: 'LAB_API_TOKEN', stored: true }],
  resources: [{ address: 'example_vm.media', type: 'example_vm', monthly_usd: 8 }, { address: 'example_dns_record.media', type: 'example_dns_record', monthly_usd: 0 }],
  monthly_usd: 8, level: 'ok', words: '$8.00 a month of the $20.00 budget (40 %)', created_at: 'Tuesday 3 November',
};
const STATIC_SITE = {
  id: 'p8e07d5c1f4', name: 'Static site', folder: '/home/you/infra/static-site', egress: 'remote', budget_usd_month: 10,
  prices: { example_bucket: 1, example_cdn: 2 },
  secrets: [{ name: 'CLOUD_TOKEN', stored: true }, { name: 'CLOUD_SECRET', stored: false }],
  resources: [], monthly_usd: 0, level: 'ok', words: '$0.00 a month of the $10.00 budget (0 %)', created_at: 'Today',
};
const PROJECTS = [HOME_LAB, STATIC_SITE];

// GET /network, as the core returns it (the fields drawn here).
const WINDOW_MIN = 5;
const DEVICES = [{ id: 'd-phone', name: 'Your phone', kind: 'phone' }];
const ROUTER = { id: 'n4f2b8a61c0', name: 'Home router', kind: 'router', adapter: 'http-config', url: 'https://router.example/api/config', token: true, created_at: 'Sunday 1 November' };
const NAS = { id: 'n9a03e7d25b', name: 'NAS firewall', kind: 'firewall', adapter: 'http-config', url: 'https://nas.example/api/firewall', token: true, created_at: 'Today' };
const NEW_NAS = { ...NAS, token: false };
const TARGETS = [ROUTER, NAS];
const CHANGES = {
  [ROUTER.id]: [
    { title: 'Guest network name', state: 'review', when: '14:58', reason: 'Ready for you: the diff against the snapshot.' },
    { title: 'Open port 8443 for the hub', state: 'kept', when: 'Saturday', reason: 'Kept: Nova heard from Your phone after the change.' },
  ],
  [NAS.id]: [
    { title: 'Allow the backup host', state: 'failed', when: '15:06', reason: 'nas.example refused the token (401).' },
  ],
};

const KINDS = { router: 'Router', dns: 'DNS', firewall: 'Firewall', tailnet: 'Tailnet policy' };
const STATES = { review: 'Waiting for you', kept: 'Kept', failed: 'Couldn’t start', reverted: 'Put back' };
const EGRESS = { remote: 'To a cloud', local: 'To a provider on your own network' };

// ---- the words ---------------------------------------------------------------------------------------

const usd = (n) => `$${n.toFixed(2)}`;
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
const missing = (p) => p.secrets.filter((s) => !s.stored);
const secretsWords = (p) => (missing(p).length ? `${plural(missing(p).length, 'secret')} not saved yet` : `${plural(p.secrets.length, 'secret')} in the vault`);
const priceWords = (v) => (typeof v === 'number' ? `${usd(v)} a month` : `by ${v.by}: ${Object.entries(v.prices).map(([k, n]) => `${k} ${usd(n)}`).join(', ')} a month`);
const host = (url) => new URL(url).host;

// ---- pieces ----------------------------------------------------------------------------------------

const icon = (name) => ICONS[name] ?? '';
const slot = (state, size) => `<span class="au-icon" data-if-icon="${state}" data-if-size="${size}" aria-hidden="true"></span>`;
const facts = (rows) => `<dl class="uc-facts au-facts">${rows.map(([k, v]) => `<div class="uc-fact"><dt>${k}</dt><dd>${v}</dd></div>`).join('')}</dl>`;
const mono = (v) => `<span class="uc-mono">${esc(v)}</span>`;
const err = (id, key, text) => `<p class="au-error" id="${id}-${key}-err">${esc(text)}</p>`;
const invalid = (id, key) => ` aria-invalid="true" aria-describedby="${id}-${key}-err"`;
const choice = (name, value, words, on) => `<label class="uc-choice au-choice"><input type="radio" name="${name}" value="${value}"${on ? ' checked' : ''}><span>${words}</span></label>`;
const back = (id) => `<a class="uc-row uc-back" href="#${id}-list"><span class="uc-ic" aria-hidden="true">${icon('back')}</span><span>Infrastructure and network</span></a>`;
const kicker = (t) => `<p class="if-kicker">${t}</p>`;

function projectRow(id, p, current) {
  const on = p.id === current;
  const need = missing(p).length ? '<span class="au-state">Needs a secret</span>' : '';
  return `<li class="if-item"><a class="uc-row au-open${on ? ' is-on' : ''}" href="#${id}-${p.id}"${on ? ' aria-current="true"' : ''}><span class="au-text"><span class="au-name">${esc(p.name)}</span><span class="au-meta">${esc(p.words)}</span><span class="au-meta">${esc(secretsWords(p))}</span></span>${need}</a></li>`;
}

function targetRow(id, t, current) {
  const on = t.id === current;
  return `<li class="if-item"><a class="uc-row au-open${on ? ' is-on' : ''}" href="#${id}-${t.id}"${on ? ' aria-current="true"' : ''}><span class="au-text"><span class="au-name">${esc(t.name)}</span><span class="au-meta">${KINDS[t.kind]} · ${esc(host(t.url))}</span><span class="au-meta">${t.token ? 'Token in the vault' : 'Token not saved yet'}</span></span>${t.token ? '' : '<span class="au-state">Needs a token</span>'}</a></li>`;
}

const addRow = (id, key, words, on) => `<a class="uc-row au-new${on ? ' is-on' : ''}" href="#${id}-${key}"${on ? ' aria-current="true"' : ''}><span class="uc-ic" aria-hidden="true">${icon('plus')}</span><span class="uc-label">${words}</span></a>`;

function listPane(id, { projects = PROJECTS, targets = TARGETS, tool = TOOL, devices = DEVICES, current = '', adding = '' } = {}) {
  const toolLine = tool.installed ? '' : '<p class="au-intro">OpenTofu isn’t on this computer, so a project can be added but can’t plan until it is. Nova doesn’t install it.</p>';
  const deviceLine = devices.length
    ? `<p class="au-intro">A change is kept once Nova hears from ${esc(devices.map((d) => d.name).join(' or '))} afterwards.</p>`
    : '<p class="au-intro">No phone or browser is paired, so Nova can’t confirm a network change yet. Pair one in Devices first.</p>';
  return `<div class="au-list"><p class="au-intro">What Nova may plan and change for you. You add them here, not in chat.</p>
<h3 class="uc-group" id="${id}-ph">Infrastructure projects</h3>${toolLine}
${projects.length ? `<ul class="if-items" aria-labelledby="${id}-ph">${projects.map((p) => projectRow(id, p, current)).join('')}</ul>` : '<p class="au-intro au-none">None yet.</p>'}
${addRow(id, 'project-new', 'Add a project', adding === 'project')}
<h3 class="uc-group" id="${id}-th">Network targets</h3>
${targets.length ? `<ul class="if-items" aria-labelledby="${id}-th">${targets.map((t) => targetRow(id, t, current)).join('')}</ul>` : '<p class="au-intro au-none">None yet.</p>'}
${addRow(id, 'target-new', 'Add a target', adding === 'target')}${deviceLine}</div>`;
}

// ---- a project ---------------------------------------------------------------------------------------

function secretList(id, p) {
  return `<ul class="if-items if-secrets" aria-labelledby="${id}-sh">${p.secrets.map((s) => `<li class="if-item if-secret"><span class="au-text">${mono(s.name)}<span class="au-meta">${s.stored ? 'In the vault' : 'Not saved yet'}</span></span><a class="btn" href="#${id}-secret-${s.name}">${s.stored ? 'Save a new value' : 'Save it'}</a></li>`).join('')}</ul>`;
}

function project(id, p, { failed = false } = {}) {
  const plan = failed
    ? `<div class="au-result" data-tone="warn" role="group" aria-labelledby="${id}-f-h"><div class="au-result-text"><p class="au-block-head" id="${id}-f-h">The first plan failed</p>
<p class="au-note">${mono('OpenTofu’s plan failed (exit 1): Error: example: the service refused the credentials (401 Unauthorized).')}</p>
<p class="au-note">A plan changes no infrastructure, so nothing changed. If ${mono('CLOUD_TOKEN')} is wrong, save a new value, then plan again.</p></div>
<div class="au-actions"><a class="btn primary" href="#${id}-secret-CLOUD_TOKEN">Save a new CLOUD_TOKEN</a><a class="btn" href="#${id}-run">Open the run in Tasks</a></div></div>`
    : `<div class="au-actions if-top"><a class="btn primary" href="#${id}-plan">Plan it</a><a class="btn" href="#${id}-edit">Edit the budget and prices</a></div>`;
  const resources = p.resources.length
    ? `<ul class="if-items" aria-labelledby="${id}-rh">${p.resources.map((r) => `<li class="if-item if-line">${mono(r.address)}<span class="au-meta">${usd(r.monthly_usd)} a month</span></li>`).join('')}</ul>`
    : '<p class="au-note">Nothing yet. What an apply creates is listed here with its monthly price.</p>';
  return `${back(id)}${kicker('Infrastructure project')}<h3 class="uc-h" id="${id}-name">${esc(p.name)}</h3>
<p class="au-sentence">${esc(p.words)}.</p>
<p class="au-note">Nova alerts at 80 % of the budget, and a plan that would go over it, or that has a resource type the price sheet doesn’t list, is never offered for apply.</p>
${plan}
${facts([['Folder', mono(p.folder)], ['Tool', 'OpenTofu'], ['Provider’s calls go', EGRESS[p.egress]], ['Added', p.created_at]])}
<h4 class="uc-group au-group-head" id="${id}-sh">Secrets</h4>${secretList(id, p)}
<h4 class="uc-group au-group-head" id="${id}-rh">What Nova provisioned</h4>${resources}
<h4 class="uc-group au-group-head" id="${id}-ps">Price sheet</h4><ul class="if-items" aria-labelledby="${id}-ps">${Object.entries(p.prices).map(([k, v]) => `<li class="if-item if-line">${mono(k)}<span class="au-meta">${esc(priceWords(v))}</span></li>`).join('')}</ul>`;
}

function priceRows(id, rows, { bad = '' } = {}) {
  return rows.map(([type, amount, size], i) => `<div class="au-pair if-price"><div class="au-field"><label class="au-label" for="${id}-type-${i}">Resource type</label><input class="uc-input" id="${id}-type-${i}" value="${esc(type)}" autocomplete="off" spellcheck="false"></div><div class="au-field"><label class="au-label" for="${id}-usd-${i}">${size ? `A month at size ${esc(size)} (USD)` : 'A month (USD)'}</label><input class="uc-input" id="${id}-usd-${i}" type="number" min="0" step="0.01" inputmode="decimal" value="${esc(amount)}"${bad === `usd-${i}` ? invalid(id, `usd-${i}`) : ''}></div></div>`).join('');
}

function projectForm(id, { bad = false } = {}) {
  const v = bad
    ? { name: 'Static site', folder: '/home/you/infra/static', budget: '', secrets: 'cloud_token' }
    : { name: 'Static site', folder: '/home/you/infra/static-site', budget: '10', secrets: 'CLOUD_TOKEN, CLOUD_SECRET' };
  return `${back(id)}<form class="au-form" data-sg-inert novalidate aria-labelledby="${id}-title"><h3 class="uc-h" id="${id}-title">Add a project</h3>
${bad ? '<p class="au-alert" role="alert">Three things to fix before Nova can add this.</p>' : '<p class="au-sentence">A folder of OpenTofu configuration that Nova may plan, and apply when you confirm.</p>'}
<div class="au-field"><label class="au-label" for="${id}-name">Name</label><input class="uc-input" id="${id}-name" value="${esc(v.name)}" maxlength="60"></div>
<div class="au-field"><label class="au-label" for="${id}-folder">Folder</label><input class="uc-input" id="${id}-folder" value="${esc(v.folder)}" autocomplete="off" spellcheck="false"${bad ? invalid(id, 'folder') : ` aria-describedby="${id}-folder-note"`}>
${bad ? err(id, 'folder', `${v.folder} has no OpenTofu configuration (.tf or .tf.json files).`) : `<p class="au-note" id="${id}-folder-note">The full path of the folder that holds its .tf files. Not your home folder, a hidden or system folder, or Nova’s own.</p>`}</div>
<div class="au-field"><label class="au-label" for="${id}-budget">Budget a month (USD)</label><input class="uc-input" id="${id}-budget" type="number" min="0" step="1" inputmode="decimal" value="${v.budget}"${bad ? invalid(id, 'budget') : ` aria-describedby="${id}-budget-note"`}>
${bad ? err(id, 'budget', 'Give the most this project may cost a month, from 0 to 1,000,000 USD.') : `<p class="au-note" id="${id}-budget-note">The most it may cost a month. Nova alerts at 80 %, and doesn’t offer a plan that goes over.</p>`}</div>
<fieldset class="au-group"><legend class="uc-group">Price sheet</legend>
<p class="au-note">What each resource type costs a month. A plan with a type that isn’t listed is never offered for apply. A price can also go by one attribute, such as a size.</p>
${priceRows(id, [['example_bucket', '1'], ['example_cdn', '2']])}
<div class="if-more"><button type="button" class="btn quiet">Add a resource type</button></div></fieldset>
<fieldset class="au-group"><legend class="uc-group">Where the provider’s calls go</legend>
${choice(`${id}-egress`, 'remote', 'To a cloud', true)}${choice(`${id}-egress`, 'local', 'To a provider on your own network', false)}</fieldset>
<div class="au-field"><label class="au-label" for="${id}-secrets">Names of its secrets</label><input class="uc-input" id="${id}-secrets" value="${esc(v.secrets)}" autocomplete="off" spellcheck="false"${bad ? invalid(id, 'secrets') : ` aria-describedby="${id}-secrets-note"`}>
${bad ? err(id, 'secrets', 'A secret’s name is capital letters, digits and underscores, like CLOUD_TOKEN.') : `<p class="au-note" id="${id}-secrets-note">The environment variables the provider reads its credentials from. Only their names here: you save each value next, into the vault.</p>`}</div>
<div class="au-actions"><button type="submit" class="btn primary" data-if-demo>Add project</button><button type="button" class="btn quiet">Cancel</button></div></form>`;
}

// Where a secret or a token goes, from the vault and the code that reads it.
function storage(id, lines) {
  return `<section class="au-preview" aria-labelledby="${id}-where"><h4 class="uc-group au-group-head" id="${id}-where">Where it’s kept</h4><ul class="if-notes">${lines.map((l) => `<li>${l}</li>`).join('')}</ul></section>`;
}
const VAULT_KEY = 'The vault’s key is in this computer’s keychain when it has one, otherwise in a file beside the vault.';

function secretsStep(id) {
  const p = STATIC_SITE;
  return `${back(id)}<form class="au-form" data-sg-inert novalidate aria-labelledby="${id}-title">${kicker('Static site')}<h3 class="uc-h" id="${id}-title">Its secrets</h3>
<p class="au-sentence">Added. Before Nova can plan it, save the value of ${mono('CLOUD_SECRET')}.</p>
<ul class="if-items if-secrets"><li class="if-item if-secret"><span class="au-text">${mono('CLOUD_TOKEN')}<span class="au-meta">In the vault, saved just now</span></span><a class="btn" href="#${id}-secret-CLOUD_TOKEN">Save a new value</a></li></ul>
<div class="au-field"><label class="au-label" for="${id}-value">CLOUD_SECRET</label><input class="uc-input" id="${id}-value" type="password" value="" autocomplete="off" spellcheck="false" aria-describedby="${id}-value-note"><p class="au-note" id="${id}-value-note">Paste it here, not in chat. It isn’t shown again: this page only says whether it is saved.</p></div>
<div class="au-actions"><button type="submit" class="btn primary" data-if-demo>Save to the vault</button></div>
${storage(id, [
    `In Nova’s vault, under this project (${mono(`infra/${p.id}/CLOUD_SECRET`)}). ${VAULT_KEY}`,
    'Nova hands it to OpenTofu’s process only, while it plans or applies this project, and takes it out of logs.',
    'To change it, save a new value. Nova keeps only the latest.',
  ])}
<div class="au-result" role="group" aria-labelledby="${id}-chk"><div class="au-result-text"><p class="au-block-head" id="${id}-chk">Nova doesn’t check a secret when you save it</p><p class="au-note">The first plan is the first time it is used. A plan changes no infrastructure, but OpenTofu runs the project’s providers, and they reach their services.</p></div><div class="au-actions"><a class="btn" href="#${id}-plan">Plan it now</a></div></div></form>`;
}

function projectEdit(id) {
  const p = HOME_LAB;
  return `${back(id)}<form class="au-form" data-sg-inert novalidate aria-labelledby="${id}-title">${kicker('Infrastructure project')}<h3 class="uc-h" id="${id}-title">${esc(p.name)}</h3>
<div class="au-field"><label class="au-label" for="${id}-budget">Budget a month (USD)</label><input class="uc-input" id="${id}-budget" type="number" min="0" step="1" inputmode="decimal" value="15" aria-describedby="${id}-budget-note"><p class="au-note" id="${id}-budget-note">Was $20.00. After it: $8.00 a month of the $15.00 budget (53 %). Nova checks the project against the new budget as soon as it’s saved.</p></div>
<fieldset class="au-group"><legend class="uc-group">Price sheet</legend>
${priceRows(id, [['example_vm', '4', 'small'], ['example_vm', '8', 'medium'], ['example_dns_record', '0']])}
<div class="if-more"><button type="button" class="btn quiet">Add a resource type</button></div></fieldset>
<p class="au-locked">Its name, folder, secret names and where its calls go stay as they were added.</p>
<div class="au-actions"><button type="submit" class="btn primary" data-if-demo>Save changes</button><button type="button" class="btn quiet">Cancel</button></div>
<div class="au-danger"><button type="button" class="btn quiet">Plan destroying everything in it</button>
<p class="au-note">A plan first, which changes nothing. Destroying is then offered in Tasks, in full and priced, at tier 3: you confirm it every time, with your passkey on Nova’s own screen.</p>
<p class="au-note">Nova has no way yet to take a project off this list. (Flagged for the owner: the core has no remove route.)</p></div></form>`;
}

// ---- a target ----------------------------------------------------------------------------------------

function changeList(id, t) {
  const list = CHANGES[t.id] ?? [];
  return list.length
    ? `<ul class="if-items" aria-labelledby="${id}-ch">${list.map((c) => `<li class="if-item"><a class="uc-row au-open" href="#${id}-change-${esc(c.title.toLowerCase().replace(/\W+/g, '-'))}"><span class="au-text"><span class="au-name">${esc(c.title)}</span><span class="au-meta">${esc(c.reason)}</span></span><span class="au-state">${STATES[c.state]} · ${esc(c.when)}</span></a></li>`).join('')}</ul>`
    : '<p class="au-note">None yet. Ask Nova in chat for a change; it shows here, and waits in Tasks for you.</p>';
}

function target(id, t, { failed = false } = {}) {
  const top = failed
    ? `<div class="au-result" data-tone="warn" role="group" aria-labelledby="${id}-f-h"><div class="au-result-text"><p class="au-block-head" id="${id}-f-h">The last change couldn’t start</p>
<p class="au-note">${mono(`${host(t.url)} refused the token (401).`)}</p><p class="au-note">Nothing changed: the snapshot is a read, and it was refused. Save a new token, then ask for the change again.</p></div>
<div class="au-actions"><a class="btn primary" href="#${id}-token">Replace the token</a></div></div>`
    : `<div class="au-actions if-top"><a class="btn" href="#${id}-token">Replace the token</a></div>`;
  return `${back(id)}${kicker('Network target')}<h3 class="uc-h" id="${id}-name">${esc(t.name)}</h3>
<p class="au-sentence">Nova may change its configuration, and applies a change only when you confirm.</p>
${top}
${facts([['Kind', KINDS[t.kind]], ['Address', mono(t.url)], ['How Nova talks to it', 'http-config: reads the configuration as JSON with its version (ETag), and writes it back only if it hasn’t changed since (If-Match)'], ['Token', t.token ? 'In the vault' : 'Not saved yet'], ['Added', t.created_at]])}
<h4 class="uc-group au-group-head" id="${id}-wh">When Nova changes it</h4>
<ol class="if-steps" aria-labelledby="${id}-wh"><li>A snapshot and the diff. Nothing changes.</li><li>The apply, at tier 3, after a checkpoint, when you confirm it in Tasks.</li><li>Nova waits ${WINDOW_MIN} min to hear from ${esc(DEVICES.map((d) => d.name).join(' or '))}. If none reaches it, Nova puts the snapshot back by itself.</li></ol>
<p class="au-note">A change that would set a password or a key is refused: change those on the device itself.</p>
<h4 class="uc-group au-group-head" id="${id}-ch">Changes</h4>${changeList(id, t)}`;
}

function targetForm(id, { bad = false } = {}) {
  const url = bad ? 'http://nas.example/api/firewall' : 'https://nas.example/api/firewall';
  return `${back(id)}<form class="au-form" data-sg-inert novalidate aria-labelledby="${id}-title"><h3 class="uc-h" id="${id}-title">Add a network target</h3>
${bad ? '<p class="au-alert" role="alert">Three things to fix before Nova can add this.</p>' : '<p class="au-sentence">Something whose configuration Nova may change: a router, DNS, a firewall or a tailnet’s policy.</p>'}
<div class="au-field"><label class="au-label" for="${id}-name">Name</label><input class="uc-input" id="${id}-name" value="${bad ? '' : 'NAS firewall'}" maxlength="60"${bad ? invalid(id, 'name') : ''}>${bad ? err(id, 'name', 'A target needs a name, 1 to 60 characters.') : ''}</div>
<fieldset class="au-group"${bad ? invalid(id, 'kind') : ''}><legend class="uc-group">What it is</legend>
${Object.entries(KINDS).map(([k, w]) => choice(`${id}-kind`, k, w, !bad && k === 'firewall')).join('')}${bad ? err(id, 'kind', 'Choose what kind of target it is.') : ''}</fieldset>
<div class="au-field"><label class="au-label" for="${id}-url">Address of its configuration</label><input class="uc-input" id="${id}-url" type="url" value="${url}" autocomplete="off" spellcheck="false"${bad ? invalid(id, 'url') : ` aria-describedby="${id}-url-note"`}>
${bad ? err(id, 'url', 'nas.example is plain http: Nova doesn’t send a target’s token over plain http, except to this computer itself. Use https.') : `<p class="au-note" id="${id}-url-note">The full address, like https://router.example/api/config. https, or plain http only to this computer. No user name or password in it: the token goes into the vault next.</p>`}</div>
<p class="au-locked">How Nova talks to it: http-config, the only adapter so far. The configuration is JSON at that address, and the target gives its version (ETag), so Nova writes only over the version it read.</p>
<div class="au-actions"><button type="submit" class="btn primary" data-if-demo>Add target</button><button type="button" class="btn quiet">Cancel</button></div></form>`;
}

function tokenForm(id, t, { replacing = false } = {}) {
  const h = host(t.url);
  const head = replacing
    ? `${kicker('Network target')}<h3 class="uc-h" id="${id}-title">${esc(t.name)}</h3><p class="au-sentence">Replace its token. The one in the vault now stays until you save this.</p>`
    : `${kicker(esc(t.name))}<h3 class="uc-h" id="${id}-title">Its token</h3><p class="au-sentence">Added. Save its token, and Nova can read its configuration when you ask for a change.</p>`;
  const devices = DEVICES.length
    ? `<p class="au-note">A network change also needs a paired phone or browser: Nova keeps a change once it hears from one afterwards. Paired now: ${esc(DEVICES.map((d) => d.name).join(', '))}.</p>`
    : '<p class="au-note">A network change also needs a paired phone or browser, and none is paired yet.</p>';
  const fixed = replacing
    ? `<p class="au-locked">Its name, kind and address can’t be changed yet.</p>
<div class="au-danger"><p class="au-note">Nova has no way yet to take a target off this list. (Flagged for the owner: the core has no remove, rename or readdress route.)</p></div>`
    : `<div class="au-result" role="group" aria-labelledby="${id}-chk"><div class="au-result-text"><p class="au-block-head" id="${id}-chk">Nova doesn’t check a token when you save it</p><p class="au-note">The first time it is used is the snapshot before a change, which only reads the configuration. A wrong token shows there, and nothing changes.</p>${devices}</div></div>`;
  return `${back(id)}<form class="au-form" data-sg-inert novalidate aria-labelledby="${id}-title">${head}
<div class="au-field"><label class="au-label" for="${id}-value">${replacing ? 'New token' : 'Token'}</label><input class="uc-input" id="${id}-value" type="password" value="" autocomplete="off" spellcheck="false" aria-describedby="${id}-value-note"><p class="au-note" id="${id}-value-note">Paste it here, not in chat. It isn’t shown again: this page only says whether it is saved.</p></div>
<div class="au-actions"><button type="submit" class="btn primary" data-if-demo>${replacing ? 'Save the new token' : 'Save to the vault'}</button>${replacing ? '<button type="button" class="btn quiet">Cancel</button>' : ''}</div>
${storage(id, [
    `In Nova’s vault, under this target (${mono(`network/${t.id}/token`)}). ${VAULT_KEY}`,
    `Nova sends it only to ${esc(h)}, as a bearer token, and doesn’t follow a redirect elsewhere.`,
  ])}
${fixed}</form>`;
}

// ---- empty ---------------------------------------------------------------------------------------------

const emptyDetail = (id) => `<h3 class="uc-h" id="${id}-none">Nothing added yet</h3>
<p class="au-sentence">Add an OpenTofu project for Nova to plan, or a router, DNS, firewall or tailnet policy for it to change. Each apply waits for you to confirm it.</p>
<p class="au-note">OpenTofu isn’t on this computer, so a project can be added but can’t plan until it is. Nova doesn’t install it.</p>
<p class="au-note">A network change needs a paired phone or browser, and none is paired yet.</p>
<div class="au-actions"><a class="btn" href="#${id}-project-new">Add a project</a></div>`;

// ---- frames --------------------------------------------------------------------------------------------

function screen(state, panes) {
  const id = `if-${state}`;
  return `<div class="uc-screen if" data-if-frame="${state}"><div class="uc-main"><header class="uc-top"><button type="button" class="uc-icon uc-menu" aria-label="Open navigation">${icon('panel')}</button><h2 class="uc-title">Infrastructure and network</h2>${slot('idle', 24)}</header>
<div class="au-panes" data-au-pane="${paneOf(state)}">${panes(id)}</div></div></div>`;
}
const pair = (list, right) => (id) => `${list(id)}<div class="au-detail">${right(id)}</div>`;

export function ifFrame(state) {
  const failedSite = { ...STATIC_SITE, secrets: STATIC_SITE.secrets.map((s) => ({ ...s, stored: true })) };
  switch (state) {
    case 'empty': return screen(state, pair((id) => listPane(id, { projects: [], targets: [], tool: { ...TOOL, installed: false }, devices: [] }), emptyDetail));
    case 'project-add': return screen(state, pair((id) => listPane(id, { adding: 'project' }), (id) => projectForm(id)));
    case 'project-invalid': return screen(state, pair((id) => listPane(id, { adding: 'project' }), (id) => projectForm(id, { bad: true })));
    case 'project-secrets': return screen(state, pair((id) => listPane(id, { current: STATIC_SITE.id }), secretsStep));
    case 'project-failed': return screen(state, pair((id) => listPane(id, { projects: [HOME_LAB, failedSite], current: STATIC_SITE.id }), (id) => project(id, failedSite, { failed: true })));
    case 'project-edit': return screen(state, pair((id) => listPane(id, { current: HOME_LAB.id }), projectEdit));
    case 'targets': return screen(state, pair((id) => listPane(id, { current: ROUTER.id }), (id) => target(id, ROUTER)));
    case 'target-add': return screen(state, pair((id) => listPane(id, { adding: 'target' }), (id) => targetForm(id)));
    case 'target-invalid': return screen(state, pair((id) => listPane(id, { adding: 'target' }), (id) => targetForm(id, { bad: true })));
    case 'target-token': return screen(state, pair((id) => listPane(id, { targets: [ROUTER, NEW_NAS], current: NAS.id }), (id) => tokenForm(id, NEW_NAS)));
    case 'target-failed': return screen(state, pair((id) => listPane(id, { current: NAS.id }), (id) => target(id, NAS, { failed: true })));
    case 'target-edit': return screen(state, pair((id) => listPane(id, { current: NAS.id }), (id) => tokenForm(id, NAS, { replacing: true })));
    default: return screen('list', pair((id) => listPane(id, { current: HOME_LAB.id }), (id) => project(id, HOME_LAB)));
  }
}

// The styleguide entry: every frame, each with its full-screen address.
export function ifEntry(wrap) {
  return IF_FRAMES.map(([s, said]) => wrap(`${esc(said)} · <a class="link" href="?entry=infra-forms&amp;frame=${s}">Full screen</a>`, ifFrame(s))).join('');
}
export const isIfFrame = (s) => IF_FRAMES.some(([k]) => k === s);

// Fills the status icon slots, and makes the specimens say they are a demo: nothing is sent, and a
// secret field is cleared the moment its form is "saved".
export function bindInfraForms(root) {
  for (const el of root.querySelectorAll('[data-if-icon]')) {
    el.replaceChildren(statusIcon({ status: el.dataset.ifIcon, size: Number(el.dataset.ifSize), decorative: true }));
  }
  for (const frame of root.querySelectorAll('[data-if-frame]')) {
    if (frame.dataset.ifBound) continue;
    frame.dataset.ifBound = '1';
    frame.addEventListener('click', (e) => {
      const b = e.target.closest('[data-if-demo]');
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
