// Approvals in Settings, design-first (2026-11-09): compositions for the owner's reaction, before
// any wiring. Styleguide only: the app never loads this file, nothing here is sent anywhere, and
// every control is a specimen (a choice ticks; Save and the passkey say they are a demo).
//
// The owner asked "these can all be changed later in settings right?" and agreed to a Settings
// screen for approval tiers (docs/builder-packet/INPUT-2026-11-09-TIER-RULING.md; NOVA-SPEC §6:
// 0 act silently, 1 act and report, 2 ask first, 3 confirm every time). Drawn from the real model,
// which is mostly fixed in code today:
//  - Home Assistant is the one capability with tier settings: service_tier (1 or 2) and tier3_domains
//    (none by default), GET and PUT /api/v1/connectors/home-assistant/settings. Raising is free;
//    lowering the tier or taking a kind off the list needs {confirm: true}. On Nova's own screen the
//    core's approval hook (src/core/index.ts) wants a passkey for every {confirm: true}, so it does
//    there; from a paired phone or browser the tick alone does, and the route is open to any paired
//    phone or browser, not only those allowed to approve (flagged). Since the follow-up ruling, a
//    call an automation or schedule starts runs at the same tier.
//  - Steps in a conversation: permissions.md (src/permissions.js), one switch per kind, Ask first
//    or Without asking; turning one to Without asking takes no confirmation at all (flagged). A
//    tier-3 step (ui/js/status.js toolTier) confirms every time whatever it says.
//  - The browser's send tier is a constant (SEND_TIER = 1, src/core/browser/plan.ts); checkout and
//    account changes are tier 3; forgetting a site or a saved sign-in is tier 3; Nova never pays.
//  - The vault, coding (write 1, check 2, merge 3), infra (plan 1, apply 3), network (prepare 1,
//    apply 3, then the dead-man's switch), Nova's computer (policy.ts tierFor), providers (turning
//    one on 2, changing what it runs or sends to 3) and releases (3): fixed in code.
//  - The outside-content guard (src/runner.js GUARDED): after a run reads outside content, those
//    steps ask, whatever the tier or the switches. It has no setting, by design.
// Proposed: Approvals as a part of Settings › Privacy and permissions (the category that already
// says "what asks first"), beside Without asking; settings that don't exist yet are drawn in their
// own frame, marked as proposals that need backend work, never as working controls.
// Its CSS is ui/styles/compositions.css (.ap-*, and the .au-* panes it shares); the narrow layout
// is layout.css's .au-panes rule.
import { ICONS, passkeyAction, passkeyConfirm } from './components.js';
import { escapeHtml as esc } from './markdown.js';
import { statusIcon } from './status-icon.js';

// Every frame: [state, what it shows, which pane a phone shows].
export const AP_FRAMES = [
  ['door', 'Where it lives: Settings › Privacy and permissions, with Approvals proposed beside Without asking', 'list'],
  ['overview', 'Approvals: every capability, each step in plain words, and whether you can change it, it is your ruling, or it is fixed', 'detail'],
  ['home-assistant', 'Home Assistant’s real settings: changes run and are reported, or ask first; the kinds that confirm every time', 'detail'],
  ['raise', 'Raising one is free: Home Assistant set to ask first, saved without a confirmation', 'detail'],
  ['lower', 'Lowering one is a loosening: on Nova’s own screen it needs the box and your passkey ({confirm: true})', 'detail'],
  ['lower-device', 'The same loosening from a paired phone: the box alone, and any paired phone may (your ruling)', 'detail'],
  ['guard', 'Always on: after Nova reads an email or a web page, these still ask. No switch, and why', 'detail'],
  ['fixed', 'What can’t change, said plainly: Nova never presses pay, and the rest', 'detail'],
  ['chat-steps', 'Without asking (permissions.md) as it is today, and where it would sit in Approvals', 'detail'],
  ['proposed', 'Proposed, not built: settings that need backend work (the browser, coding, infrastructure, Nova’s computer)', 'detail'],
];
const paneOf = (s) => AP_FRAMES.find(([k]) => k === s)?.[2] ?? 'detail';

// The tiers in the person's words (NOVA-SPEC §6).
const WORDS = { 0: 'Just does it', 1: 'Does it and tells you', 2: 'Asks first', 3: 'Confirms every time' };
// Whether a step can be changed today, and by whom.
const HOW = {
  setting: 'You can change this',
  ruling: 'Your ruling, 9 November',
  fixed: 'Fixed for now',
  design: 'Fixed by design',
};

// What the backend says, word for word (home-assistant.ts PUT /settings; browser/plan.ts).
const SAID = {
  lowerTier: 'Lowering the service tier to 1 means Nova changes your home when you ask, without waiting for your OK, and tells you what it did. Send confirm: true to do that.',
  unmark: 'Taking lock off the list means Nova no longer asks for a confirmation every time. Send confirm: true to do that.',
  pay: 'Paying is tier 3 and always yours: Nova fills the cart, shows the itemised total and stops. It never presses pay.',
};

// Each capability and its steps: [what, tier (or 'never'), how it can change]. From the code named.
const CAPS = [
  { id: 'ha', name: 'Home Assistant', from: 'src/core/connectors/home-assistant.ts', open: 'home-assistant', steps: [
    ['Changes you ask for, and those an automation or a schedule starts', 1, 'setting'],
    ['Kinds you mark, like locks or the garage door (none marked)', 3, 'setting'],
  ] },
  { id: 'chat', name: 'Steps in a conversation', from: 'src/permissions.js', open: 'chat-steps', steps: [
    ['Commands, Gmail drafts and tidying, schedules, settings, memories from a file: each kind has its own switch', 2, 'setting'],
    ['A command that looks irreversible, removing a schedule, changing privacy or what asks first', 3, 'design'],
  ] },
  { id: 'browser', name: 'Nova’s browser', from: 'src/core/browser/', steps: [
    ['Signing in, typing and clicking on a task’s own sites', 1, 'ruling'],
    ['A checkout, or a change to an account', 3, 'ruling'],
    ['Forgetting a site, or a saved sign-in', 3, 'ruling'],
    ['Paying', 'never', 'design'],
  ] },
  { id: 'vault', name: 'The vault', from: 'src/core/vault.ts', steps: [
    ['Deleting a secret, or starting a new vault', 3, 'ruling'],
  ] },
  { id: 'coding', name: 'Coding', from: 'src/core/coding/', steps: [
    ['Writing the change in Nova’s own copy', 1, 'fixed'],
    ['Running your tests on it', 2, 'fixed'],
    ['Merging it', 3, 'fixed'],
  ] },
  { id: 'infra', name: 'Infrastructure', from: 'src/core/infra/', steps: [
    ['Planning, which changes nothing', 1, 'fixed'],
    ['Applying a plan', 3, 'fixed'],
  ] },
  { id: 'network', name: 'Your network', from: 'src/core/network/', steps: [
    ['Preparing a change: a snapshot and what would change', 1, 'fixed'],
    ['Applying it. Nova puts it back by itself unless it hears from one of your devices', 3, 'fixed'],
  ] },
  { id: 'computer', name: 'Nova’s computer', from: 'src/core/computer/policy.ts', steps: [
    ['Reading in a workspace', 0, 'fixed'],
    ['Changing files in a workspace, with a checkpoint first', 1, 'fixed'],
    ['Using a folder of yours', 2, 'fixed'],
    ['Reaching outside, or deleting a workspace', 3, 'fixed'],
  ] },
  { id: 'providers', name: 'Providers', from: 'src/core/providers/registry.ts', steps: [
    ['Turning one on', 2, 'fixed'],
    ['Changing what one runs or where it sends', 3, 'fixed'],
  ] },
  { id: 'releases', name: 'Nova’s own releases', from: 'src/supervisor/', steps: [
    ['Deploying one, or going back', 3, 'fixed'],
  ] },
];

// The steps the outside-content guard holds (src/runner.js GUARDED), in its own words.
const GUARDED = ['run a command', 'write an email', 'change your mail', 'change a schedule', 'change code in a repository', 'plan infrastructure', 'change your network', 'change an account', 'change your home'];

// The kinds of conversation step today (src/tools.js `permission`), as Settings › Without asking lists them.
const PERMS = [
  ['Run commands on this computer', 'A command can change anything your account can', false],
  ['Save Gmail drafts', 'Nova has no way to send email', true],
  ['Tidy Gmail: archive, mark read or unread, labels', 'Nova has no way to delete email', false],
  ['Set up, change and remove schedules', '', false],
  ['Change your settings in a conversation', 'You see the change first', false],
  ['Offer memories from a file in workspace/import', 'They wait for your OK in Memory', true],
];

// Home Assistant's kinds as Nova sees them (the domains of its entities), and which are marked.
const KINDS = [['lock', 'Locks'], ['alarm_control_panel', 'Alarms'], ['cover', 'Covers, like the garage door'], ['script', 'Scripts'], ['light', 'Lights'], ['switch', 'Switches']];

// ---- the words ---------------------------------------------------------------------------------

const icon = (name) => ICONS[name] ?? '';
const slot = (state, size) => `<span class="au-icon" data-ap-icon="${state}" data-ap-size="${size}" aria-hidden="true"></span>`;
const facts = (rows) => `<dl class="uc-facts au-facts">${rows.map(([k, v]) => `<div class="uc-fact"><dt>${k}</dt><dd>${v}</dd></div>`).join('')}</dl>`;
const mono = (t) => `<span class="uc-mono">${esc(t)}</span>`;
const tierWords = (t) => (t === 'never' ? 'Never: it stops at the total' : WORDS[t]);

// ---- the door: Settings, with Approvals proposed inside Privacy and permissions --------------------

const GROUPS = [
  ['You', [['You and Nova', 'Names and how Nova talks to you'], ['Appearance', 'Theme, light and dark, contrast'], ['privacy', '']]],
  ['What Nova works with', [['Connections', 'Accounts and services Nova can reach'], ['Models and providers', 'Local models and outside help'], ['Devices', 'Phones and computers paired with Nova'], ['Capture', 'Sources, consent, and what Nova remembers'], ['Services', 'How Nova runs its services here']]],
  ['About', [['About Nova', 'Its version and build, what’s new, where it stands']]],
  ['Keeping Nova safe', [['Security', 'Passkeys that confirm tier-3 actions here'], ['Backups and changes', 'Backup folders, checkpoints, restores and changes'], ['Configuration', 'Every setting of yours, a few questions, or a file'], ['Start over', 'Export everything, or erase Nova here']]],
];

function categories(id) {
  const row = ([name, note], i) => {
    const mine = name === 'privacy';
    const label = mine ? 'Privacy and permissions' : name;
    const meta = mine ? 'What stays here and what asks first · Approvals: 3 you can change' : note;
    return `<li class="ap-cat"><a class="uc-row au-open${mine ? ' is-on' : ''}" href="#${id}-${mine ? 'privacy' : `cat-${i}`}"${mine ? ' aria-current="true"' : ''}><span class="au-text"><span class="au-name">${esc(label)}</span><span class="au-meta">${esc(meta)}</span></span><span class="uc-ic" aria-hidden="true">${icon('chevron')}</span></a></li>`;
  };
  let n = 0;
  const groups = GROUPS.map(([g, cats], gi) => `<h3 class="uc-group" id="${id}-g${gi}">${g}</h3><ul class="ap-list" aria-labelledby="${id}-g${gi}">${cats.map((c) => row(c, n++)).join('')}</ul>`).join('');
  return `<nav class="au-list" aria-label="Settings categories">${groups}</nav>`;
}

const toSettings = (id) => `<a class="uc-row uc-back" href="#${id}-settings"><span class="uc-ic" aria-hidden="true">${icon('back')}</span><span>Settings</span></a>`;
const toApprovals = (id) => `<a class="uc-row uc-back" href="#${id}-approvals"><span class="uc-ic" aria-hidden="true">${icon('back')}</span><span>Approvals</span></a>`;

// ---- Approvals: every capability, each step, and how it can change --------------------------------

function capability(id, c) {
  const steps = c.steps.map(([what, t, how]) => `<div class="ap-step"><dt>${esc(what)}</dt><dd><span class="ap-tier">${esc(tierWords(t))}</span><span class="ap-how" data-how="${how}">${esc(HOW[how])}</span></dd></div>`).join('');
  const open = c.open ? `<a class="btn quiet ap-open" href="#${id}-${c.open}">${c.open === 'home-assistant' ? 'Home Assistant’s settings' : 'Without asking'}</a>` : '';
  return `<li class="ap-cap" id="${id}-${c.id}"><h5 class="ap-cap-name">${esc(c.name)}</h5><dl class="ap-steps">${steps}</dl>${open}</li>`;
}

function overview(id) {
  return `${toSettings(id)}<p class="ap-kind">Privacy and permissions</p><h3 class="uc-h" id="${id}-name">Approvals</h3>
<p class="uc-lede">What Nova does on its own, what it asks first, and what it confirms with you every time. Raising any of them is free; lowering one confirms first.</p>
${facts([['Just does it', 'Nova does it without telling you: small, in-policy steps.'], ['Does it and tells you', 'Nova does it, then tells you what changed.'], ['Asks first', 'Nova waits for your OK.'], ['Confirms every time', 'Nova waits for an explicit confirmation, every time: your passkey on Nova’s own screen, or a paired phone you allowed to approve.']])}
<div class="au-result" role="group" aria-labelledby="${id}-always-h"><div class="au-result-text"><p class="au-block-head" id="${id}-always-h">Whatever is set here</p><p class="au-note">After Nova reads an email or a web page, the steps it guards still ask first. Nova never presses pay.</p></div><div class="au-actions"><a class="btn" href="#${id}-guard">Why these still ask</a></div></div>
<h4 class="uc-group au-group-head" id="${id}-caps">Each part of Nova</h4><ul class="ap-caps" aria-labelledby="${id}-caps">${CAPS.map((c) => capability(id, c)).join('')}</ul>
<p class="au-note">Only Home Assistant and the conversation switches are settings today. The rest is set in Nova’s code; some are proposed as settings, and those need work in Nova first.</p>
<div class="au-actions"><a class="btn" href="#${id}-proposed">Proposed settings</a><a class="btn quiet" href="#${id}-fixed">What can’t change</a></div>`;
}

// ---- Home Assistant's real settings ---------------------------------------------------------------

const choice = (name, value, words, on, note = '', disabled = false) => `<label class="uc-choice au-choice"><input type="radio" name="${name}" value="${value}"${on ? ' checked' : ''}${disabled ? ' disabled' : ''}><span>${words}${note ? ` <span class="uc-faint">${note}</span>` : ''}</span></label>`;
const box = (name, value, words, on) => `<label class="uc-choice au-choice"><input type="checkbox" name="${name}" value="${value}"${on ? ' checked' : ''}><span>${esc(words)} <span class="uc-faint">${mono(value)}</span></span></label>`;

function haForm(id, { tier = 1, marked = [], preview = '' } = {}) {
  return `${toApprovals(id)}<form class="au-form" data-sg-inert novalidate aria-labelledby="${id}-title"><p class="ap-kind">Approvals</p><h3 class="uc-h" id="${id}-title">Home Assistant</h3>
<fieldset class="au-group"><legend class="uc-group">Changes to your home</legend>${choice(`${id}-tier`, '1', WORDS[1], tier === 1, '· the default, by your ruling')}${choice(`${id}-tier`, '2', WORDS[2], tier === 2)}
<p class="au-note">The same for a change you ask for and one an automation or a schedule starts: you made the rule.</p></fieldset>
<fieldset class="au-checks"><legend class="uc-group">Confirm these every time</legend>${KINDS.map(([v, w]) => box(`${id}-kind`, v, w, marked.includes(v))).join('')}
<p class="au-note">None by default. A kind you mark confirms every time, whoever starts the change. These are the kinds of device Nova sees in your Home Assistant.</p></fieldset>
${preview}
<div class="au-actions"><button type="submit" class="btn primary" data-ap-demo>Save</button><button type="button" class="btn quiet">Cancel</button></div></form>
<p class="au-note">Marking a kind, or choosing Asks first, tightens: it is saved as it is. Unmarking one, or going back to Does it and tells you, loosens, and confirms first.</p>`;
}

const say = (id, head, text) => `<section class="au-preview" aria-labelledby="${id}-say"><h4 class="uc-group au-group-head" id="${id}-say">${head}</h4><p class="au-sentence">${text}</p></section>`;

function raise(id) {
  return haForm(id, { tier: 2, marked: ['lock'], preview: say(id, 'It will be', 'Nova asks you first before it changes anything in your home, and locks confirm every time. This tightens, so it is saved without a confirmation.') });
}

// Lowering: the route's own words, then the confirmation the core asks for.
function lower(id, { device = false } = {}) {
  const confirm = device
    ? `<label class="confirm"><input type="checkbox" name="confirm" required> I understand, and I want Nova to do this.</label>
<div class="au-actions"><button type="submit" class="btn primary" data-ap-confirm disabled>Confirm</button><button type="button" class="btn quiet">Cancel</button></div>`
    : `${passkeyConfirm({ state: 'ready' })}<div class="au-actions">${passkeyAction({ state: 'ready' })}<button type="button" class="btn quiet">Cancel</button></div>`;
  const how = device
    ? 'On a paired phone or browser, the box alone confirms it, with no passkey. Any paired phone or browser may change these settings, not only one you allowed to approve: your ruling, 2026-11-09.'
    : 'On Nova’s own screen, every confirmation like this one takes your passkey, so a program on this computer can’t loosen it by itself.';
  return `${toApprovals(id)}<form class="au-form ap-confirm" data-sg-inert novalidate aria-labelledby="${id}-title"><p class="ap-kind">Loosens: confirms first</p><h3 class="uc-h" id="${id}-title">Let Nova change your home without asking first?</h3>
<p class="au-sentence">Home Assistant goes from Asks first to Does it and tells you.</p>
<div class="ap-said" role="group" aria-labelledby="${id}-said-h"><p class="au-block-head" id="${id}-said-h">What Nova says</p><p class="ap-quote">${esc(SAID.lowerTier)}</p></div>
${facts([['After this', 'A change you ask for, or one an automation starts, is made, then reported with Nova’s read-back.'], ['Still confirms', 'Locks: you marked them.'], ['Still asks', 'A change after Nova read an email or a web page.'], ['How', esc(how)]])}
${confirm}</form>`;
}

// ---- the always-on guard ---------------------------------------------------------------------------

function guard(id) {
  return `${toApprovals(id)}<p class="ap-kind">Always on · no switch</p><h3 class="uc-h" id="${id}-title">After Nova reads an email or a web page, these still ask</h3>
<p class="uc-lede">Words from outside can carry instructions that aren’t yours. So once a run has read something from outside, Nova asks you before it does any of these, whatever is set in Approvals or Without asking.</p>
<ul class="ap-guarded" aria-labelledby="${id}-title">${GUARDED.map((g) => `<li>${esc(g[0].toUpperCase() + g.slice(1))}</li>`).join('')}</ul>
${facts([['Why no switch', 'It protects you from the page, not from Nova: turning it off would let an email decide what Nova does.'], ['When it asks', 'The request names the outside source that led to it, so you can see where the idea came from.'], ['Home Assistant', 'A change it would make after outside content asks first, even at Does it and tells you.'], ['Where', `${mono('src/runner.js')}, the ingest gate’s guarded steps.`]])}`;
}

// ---- what can't change -----------------------------------------------------------------------------

const FIXED = [
  ['Nova never presses pay', SAID.pay],
  ['Outside content still asks', 'After Nova reads an email or a web page, the steps it guards ask you first. There is no switch for it.'],
  ['Some steps confirm every time', 'In a conversation, a command that looks irreversible, removing a schedule, or changing privacy or what asks first confirms every time, even when its kind is set to go ahead without asking.'],
  ['Your passkey on Nova’s own screen', 'Confirming every time on Nova’s own screen takes your passkey. A paired phone you allowed to approve confirms with its own key (your ruling: no change).'],
  ['The vault, checkouts, account changes', 'Confirm every time, by your ruling of 9 November. They could be settings later, if you want them to be.'],
];

function fixed(id) {
  return `${toApprovals(id)}<p class="ap-kind">Approvals</p><h3 class="uc-h" id="${id}-title">What can’t change</h3>
<p class="uc-lede">Some gates are part of how Nova is built, and some are your rulings. Neither is a setting here.</p>
<ul class="ap-fixed" aria-labelledby="${id}-title">${FIXED.map(([h, t]) => `<li><p class="au-block-head">${esc(h)}</p><p class="au-note">${esc(t)}</p></li>`).join('')}</ul>`;
}

// ---- conversation steps: Without asking, as it is ----------------------------------------------------

function chatSteps(id) {
  const rows = PERMS.map(([label, note, yes], i) => `<li class="ap-perm"><div class="au-text"><span class="au-name" id="${id}-p${i}">${esc(label)}</span>${note ? `<span class="au-meta">${esc(note)}.</span>` : ''}</div><button type="button" class="switch" role="switch" aria-checked="${yes}" aria-labelledby="${id}-p${i}" data-ap-switch><span class="switch-word">${yes ? 'Without asking' : 'Ask first'}</span><span class="switch-track" aria-hidden="true"><span class="switch-knob"></span></span></button></li>`).join('');
  return `${toApprovals(id)}<p class="ap-kind">Approvals · today in Privacy and permissions</p><h3 class="uc-h" id="${id}-title">Without asking</h3>
<p class="uc-lede">Steps Nova takes in a conversation, or while it works on its own. Each kind starts at Ask first. These switches are kept in permissions.md in your Nova folder, and can be changed there by hand.</p>
<ul class="ap-list ap-perms" aria-labelledby="${id}-title">${rows}</ul>
${facts([['Still confirms', 'A step that is tier 3 confirms every time, whatever its switch says.'], ['Still asks', 'After outside content, a guarded step asks.'], ['Turning one on', 'Takes effect at once, with no confirmation: your ruling, 2026-11-09. Home Assistant’s loosening still confirms first.']])}
<p class="au-note">Proposed: this list moves into Approvals, under “Steps in a conversation”, and its words become the same four as the rest. permissions.md stays the file it is kept in.</p>`;
}

// ---- proposed: settings that need backend work ---------------------------------------------------------

const PROPOSALS = [
  ['browser', 'Nova’s browser, on a task’s own sites', 1, 'SEND_TIER is a constant in src/core/browser/plan.ts; it would become a setting the plan reads.'],
  ['coding-write', 'Coding: writing the change in Nova’s own copy', 1, 'TIER in src/core/coding/index.ts would read a setting for its write step.'],
  ['coding-check', 'Coding: running your tests', 2, 'The same, for the check step. Merging would stay Confirms every time.'],
  ['infra', 'Infrastructure: planning', 1, 'TIER in src/core/infra/index.ts would read a setting for its plan step. Applying would stay Confirms every time.'],
  ['computer', 'Nova’s computer: changing files, with a checkpoint first', 1, 'tierFor in src/core/computer/policy.ts would read a setting for writes.'],
];

function proposed(id) {
  const one = ([k, name, now, need]) => `<fieldset class="au-group ap-prop" disabled><legend class="uc-group">${esc(name)}</legend>${choice(`${id}-${k}`, '1', WORDS[1], now === 1, now === 1 ? '· today' : '', true)}${choice(`${id}-${k}`, '2', WORDS[2], now === 2, now === 2 ? '· today' : '', true)}<p class="au-note">Needs: ${esc(need)}</p></fieldset>`;
  return `${toApprovals(id)}<p class="ap-kind">Proposed · not built</p><h3 class="uc-h" id="${id}-title">Proposed settings</h3>
<div class="au-result" role="group" aria-labelledby="${id}-not-h"><div class="au-result-text"><p class="au-block-head" id="${id}-not-h">None of these is a setting yet</p><p class="au-note">Each needs work in Nova first. They are drawn switched off, at today’s tier, so you can say which you want. Lowering any of them would confirm first, like Home Assistant.</p></div></div>
<form class="au-form" data-sg-inert novalidate aria-labelledby="${id}-title">${PROPOSALS.map(one).join('')}</form>`;
}

// ---- frames ------------------------------------------------------------------------------------------

function screen(state, panes, live) {
  const id = `ap-${state}`;
  return `<div class="uc-screen ap" data-ap-frame="${state}"><div class="uc-main"><header class="uc-top"><button type="button" class="uc-icon uc-menu" aria-label="Open navigation">${icon('panel')}</button><h2 class="uc-title">Settings</h2>${slot(live, 24)}</header>
<div class="au-panes" data-au-pane="${paneOf(state)}">${categories(id)}<div class="au-detail">${panes(id)}</div></div></div></div>`;
}

const DRAW = {
  door: overview,
  overview,
  'home-assistant': (id) => haForm(id),
  raise,
  lower: (id) => lower(id),
  'lower-device': (id) => lower(id, { device: true }),
  guard,
  fixed,
  'chat-steps': chatSteps,
  proposed,
};

export function apFrame(state) {
  const s = DRAW[state] ? state : 'overview';
  return screen(s, DRAW[s], s === 'lower' || s === 'lower-device' ? 'needs-you' : 'idle');
}
// The styleguide entry: every frame, each with its full-screen address.
export function apEntry(wrap) {
  return AP_FRAMES.map(([s, said]) => wrap(`${esc(said)} · <a class="link" href="?entry=approval-tiers&amp;frame=${s}">Full screen</a>`, apFrame(s))).join('');
}
export const isApFrame = (s) => AP_FRAMES.some(([k]) => k === s);

// Fills the status icon slots and makes the specimens move a little: a confirmation box enables its
// button, a switch flips its words, and the demo buttons say they are a demo.
export function bindApprovals(root) {
  for (const el of root.querySelectorAll('[data-ap-icon]')) {
    el.replaceChildren(statusIcon({ status: el.dataset.apIcon, size: Number(el.dataset.apSize), decorative: true }));
  }
  for (const frame of root.querySelectorAll('[data-ap-frame]')) {
    if (frame.dataset.apBound) continue;
    frame.dataset.apBound = '1';
    frame.addEventListener('change', (e) => {
      if (e.target.name !== 'confirm') return;
      const b = e.target.closest('form')?.querySelector('[data-action="passkey-confirm"], [data-ap-confirm]');
      if (b) b.disabled = !e.target.checked;
    });
    frame.addEventListener('click', (e) => {
      const sw = e.target.closest('[data-ap-switch]');
      if (sw) {
        const on = sw.getAttribute('aria-checked') !== 'true';
        sw.setAttribute('aria-checked', String(on));
        sw.querySelector('.switch-word').textContent = on ? 'Without asking' : 'Ask first';
      }
      const b = e.target.closest('[data-ap-demo], [data-ap-confirm], [data-action^="passkey"]');
      if (b) { e.preventDefault(); b.textContent = 'Demo: nothing was sent'; }
      if (e.target.closest('a[href^="#"]')) e.preventDefault();
    });
  }
}
