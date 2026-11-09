// Settings › Privacy and permissions › Approvals (#438's routes, drawn to the approved compositions
// in sg-approval-tiers.js, #435). Whatever GET /api/v1/approvals lists is drawn, grouped by its
// area: Nova's own workers, a connector, an extension, or a service Nova builds later. Nothing here
// names a capability, so one registered tomorrow shows with no change to this file.
//
// Each capability: its words, the tier in effect in plain words, and whether it can change. It can
// when more than one of its allowed tiers is at or above its floor; otherwise the floor's own why is
// said. Raising saves at once. Lowering loosens a gate, so it says what changes and confirms first:
// on Nova's own screen with the passkey (core.js runs passkey.js's step for any {confirm: true}),
// on a paired phone or browser with the box alone. "Back to default" sends {tier: null}, and
// confirms first when that lowers the tier. A refusal is said in the server's own words, and what
// was chosen stays chosen (keepEdits, app.js, carries it over a redraw).
//
// What no setting changes (the outside-content guard, Nova never presses pay) is always shown, with
// no switch. The conversation steps (permissions.md) stay in their own part, linked from here.
import { api, on } from './core.js';
import { passkeyAction, passkeyConfirm, status } from './components.js';
import { sessionEnds } from './device-key.js';
import { escapeHtml as esc } from './markdown.js';
import { PasskeyStop } from './passkey.js';
import { makePart, waitingLine } from './wait.js';

// The tiers in the person's words (NOVA-SPEC §6), as the compositions say them.
const TIER_WORDS = { 0: 'Just does it', 1: 'Does it and tells you', 2: 'Asks first', 3: 'Confirms every time' };
const MEANS = {
  0: 'Nova does it without telling you: small, in-policy steps.',
  1: 'Nova does it, then tells you what changed.',
  2: 'Nova waits for your OK.',
  3: 'Nova waits for an explicit confirmation, every time: your passkey on Nova’s own screen, or a paired phone you allowed to approve.',
};
// Said when the server's list has none (it always has them; the screen never goes without).
const ALWAYS = [
  'After Nova reads an email or a web page, the steps it guards still ask first.',
  'Nova never presses pay.',
];

let data = null;
// Per capability (by id): a lowering waiting for its confirmation ({to, confirmed, passkey}), a
// line said under it ({text, alert}), and whether its request is on its way.
const asking = new Map();
const said = new Map();
const busy = new Set();

const part = makePart('approvals', async () => { data = await api('GET', '/approvals'); });
export const loadApprovals = part.load;
const rerender = () => part.rerender();

// A paired phone or browser has a session; Nova's own screen never does (device-key.js).
const paired = () => !!sessionEnds();
const words = (t) => TIER_WORDS[t] ?? `Tier ${t}`;
const cap1 = (s) => (s ? s[0].toUpperCase() + s.slice(1) : '');
const slug = (id) => String(id).replace(/[^A-Za-z0-9_-]/g, '-');
const list = () => (Array.isArray(data?.capabilities) ? data.capabilities : []);
const find = (id) => list().find((c) => c.id === id) ?? null;
// The tiers a control offers: the allowed ones at or above the floor, lowest first.
const offered = (c) => [...new Set((c.tiers ?? []).filter((t) => t >= c.floor))].sort((a, b) => a - b);
const adjustable = (c) => offered(c).length > 1;
// What a choice would put in effect: never below the floor, and the default for null.
const effectiveOf = (c, tier) => Math.max(c.floor, tier ?? c.default);

// By area, in the order the server lists them.
function byArea(caps) {
  const out = new Map();
  for (const c of caps) {
    const a = String(c.area ?? '').trim() || 'Other';
    if (!out.has(a)) out.set(a, []);
    out.get(a).push(c);
  }
  return [...out];
}

// ---- drawing ---------------------------------------------------------------------------------

function tierChoices(c) {
  const name = `tier-${slug(c.id)}`;
  const want = asking.get(c.id);
  const on = want ? effectiveOf(c, want.to) : c.effective;
  return `<fieldset class="appr-tiers"${busy.has(c.id) ? ' disabled' : ''}><legend class="sr-only">${esc(c.name)}</legend><div class="choices">${offered(c).map((t) => `<label class="choice"><input type="radio" name="${name}" value="${t}"${t === on ? ' checked' : ''}><span class="choice-name">${esc(words(t))}${t === c.default ? ' <span class="appr-faint">· the default</span>' : ''}</span></label>`).join('')}</div></fieldset>`;
}

// Lowering: what changes, in words, then the confirmation the server asks for.
function lowering(c) {
  const want = asking.get(c.id);
  if (!want) return '';
  const to = effectiveOf(c, want.to);
  const id = `appr-lower-${slug(c.id)}`;
  const device = paired();
  const pk = { state: want.passkey ?? 'ready', confirmed: !!want.confirmed };
  const confirm = device
    ? `<label class="confirm"><input type="checkbox" name="confirm" required${want.confirmed ? ' checked' : ''}> I understand, and I want Nova to do this.</label>
<div class="sheet-actions"><button type="submit" class="btn primary" data-action="appr-confirm" data-id="appr-confirm:${esc(c.id)}"${want.confirmed && !busy.has(c.id) ? '' : ' disabled'}>Confirm</button><button type="button" class="btn quiet" data-action="appr-cancel" data-id="appr-cancel:${esc(c.id)}">Cancel</button></div>`
    : `${passkeyConfirm(pk)}<div class="sheet-actions">${passkeyAction(pk)}${pk.state === 'waiting' ? '' : `<button type="button" class="btn quiet" data-action="appr-cancel" data-id="appr-cancel:${esc(c.id)}">Cancel</button>`}</div>`;
  const how = device
    ? 'On a paired phone or browser, the box alone confirms it, with no passkey. Any paired phone or browser may change these settings.'
    : 'On Nova’s own screen, every confirmation like this one takes your passkey, so a program on this computer can’t loosen it by itself.';
  const still = (data.fixed?.length ? data.fixed.map((f) => f.words) : ALWAYS).join(' ');
  return `<form class="appr-confirm" data-form="appr-lower:${esc(c.id)}" data-capability="${esc(c.id)}" aria-labelledby="${id}-h" novalidate>
<p class="appr-kind">${status('needs-you')}<span>Loosens: confirms first</span></p>
<h4 class="appr-confirm-h" id="${id}-h">Loosen “${esc(c.name)}”?</h4>
<p class="appr-sentence">It goes from ${esc(words(c.effective))} to ${esc(words(to))}${want.to === null ? ', its default' : ''}.</p>
<dl class="facts appr-facts"><dt>After this</dt><dd>${esc(MEANS[to] ?? '')}</dd>${c.effect_words ? `<dt>What it does</dt><dd>${esc(cap1(c.effect_words))}.</dd>` : ''}<dt>Still</dt><dd>${esc(still)}</dd><dt>How</dt><dd>${esc(how)}</dd></dl>
${confirm}</form>`;
}

function row(c) {
  const fixed = !adjustable(c);
  const how = fixed ? `Fixed: ${c.floor_why}.` : 'You can change this.';
  const yours = c.override !== null && c.override !== undefined;
  const origin = String(c.origin ?? '').startsWith('extension:') ? 'From an extension you added. ' : '';
  const line = said.get(c.id);
  const back = yours && !fixed && !asking.has(c.id)
    ? `<button type="button" class="btn quiet" data-action="appr-default" data-id="appr-default:${esc(c.id)}"${busy.has(c.id) ? ' disabled' : ''}>Back to default (${esc(words(c.default))})</button>` : '';
  return `<li class="settings-row appr-cap" id="appr-${slug(c.id)}" data-capability="${esc(c.id)}" data-adjustable="${fixed ? 'no' : 'yes'}">
<div class="settings-text"><p class="settings-label">${esc(c.name)}</p><p class="settings-note"><strong class="appr-tier">${esc(words(c.effective))}</strong> · ${esc(origin)}${esc(how)}${yours ? ` Your setting; the default is ${esc(words(c.default))}.` : ''}</p></div>
${fixed ? '' : `<form class="settings-control appr-pick" data-form="appr:${esc(c.id)}" data-capability="${esc(c.id)}">${tierChoices(c)}${back}</form>`}
${lowering(c)}
${line ? `<p class="settings-note appr-said" role="${line.alert ? 'alert' : 'status'}">${esc(line.text)}</p>` : ''}
</li>`;
}

export function renderApprovals() {
  const head = '<section class="memory-section" id="approvals" aria-labelledby="set-approvals"><h2 class="memory-heading" id="set-approvals">Approvals</h2>';
  if (!data) return `${head}${part.failed ? `<p class="memory-lede" role="alert">${esc(part.failed)}</p><button type="button" class="btn set-retry" data-action="appr-retry">Try again</button>` : waitingLine('Loading approvals', { key: 'approvals' })}</section>`;
  const fixed = data.fixed?.length ? data.fixed.map((f) => f.words) : ALWAYS;
  const caps = list();
  const n = caps.filter(adjustable).length;
  return `${head}
<p class="memory-lede">What Nova does on its own, what it asks first, and what it confirms with you every time. Raising any of them is free; lowering one confirms first.</p>
<dl class="facts appr-facts">${[0, 1, 2, 3].map((t) => `<dt>${esc(TIER_WORDS[t])}</dt><dd>${esc(MEANS[t])}</dd>`).join('')}</dl>
<div class="appr-always" role="group" aria-labelledby="appr-always-h"><p class="appr-always-h" id="appr-always-h">Whatever is set here · always on, no switch</p><ul class="appr-always-list">${fixed.map((w) => `<li>${esc(w)}</li>`).join('')}</ul></div>
<h3 class="conn-sub">Each part of Nova</h3>
<p class="settings-note">${caps.length ? `${n} of ${caps.length} you can change.` : 'Nothing that acts has registered yet.'}</p>
${byArea(caps).map(([area, cs], i) => `<h4 class="appr-area" id="appr-area-${i}">${esc(area)}</h4><ul class="settings-list appr-caps" aria-labelledby="appr-area-${i}">${cs.map(row).join('')}</ul>`).join('')}
<h3 class="conn-sub">In a conversation</h3>
<ul class="settings-list"><li class="settings-row"><div class="settings-text"><p class="settings-note">Each kind of step has its own switch, Ask first or Without asking, kept in permissions.md.</p></div><div class="settings-control"><a class="btn" href="/settings#perms">Steps in a conversation</a></div></li></ul>
</section>`;
}

// ---- acting ----------------------------------------------------------------------------------

// The row's own form goes back to what is in effect (keepEdits leaves a reset form alone).
const resetPick = (id) => document.querySelector(`#approvals form[data-form="appr:${CSS.escape(id)}"]`)?.reset();

async function save(id, tier, { confirm = false } = {}) {
  const c = find(id);
  if (!c || busy.has(id)) return;
  busy.add(id);
  said.delete(id);
  const want = asking.get(id);
  // While it is on its way the row's choices are held; focus comes back to the row afterwards.
  const where = `#appr-${CSS.escape(slug(id))}`;
  const held = !!document.activeElement?.closest?.(where);
  rerender();
  try {
    const v = await api('PUT', `/approvals/${encodeURIComponent(id)}`, confirm ? { tier, confirm: true } : { tier });
    data = { ...data, capabilities: list().map((x) => (x.id === id ? { ...x, ...v } : x)) };
    asking.delete(id);
    resetPick(id);
    said.set(id, { text: `Saved: ${words(v.effective)}.`, alert: false });
  } catch (e) {
    // The server's own words (or the passkey step's), and the choice stays as it was made.
    if (want) want.passkey = e instanceof PasskeyStop ? e.state : e.status === 403 && /passkey/i.test(e.message) ? (/ran out of time|expired/i.test(e.message) ? 'expired' : 'failed') : 'ready';
    said.set(id, { text: e.message || 'Nova’s server didn’t answer.', alert: true });
  } finally {
    busy.delete(id);
  }
  rerender();
  const a = document.activeElement;
  if (held && (!a || a === document.body || !a.isConnected)) {
    const r = document.querySelector(where);
    (r?.querySelector('form.appr-confirm button:not([disabled]), form.appr-confirm input') ?? r?.querySelector('input:checked'))?.focus({ preventScroll: true });
  }
}

function choose(id, tier) {
  const c = find(id);
  if (!c) return;
  said.delete(id);
  const to = effectiveOf(c, tier);
  // Raising is free; the same tier is nothing to do; lowering confirms first.
  if (to > c.effective) { asking.delete(id); save(id, tier); return; }
  if (to === c.effective) { asking.delete(id); resetPick(id); rerender(); return; }
  asking.set(id, { to: tier, confirmed: false, passkey: 'ready' });
  rerender();
  document.querySelector(`#approvals form[data-form="appr-lower:${CSS.escape(id)}"] input[name="confirm"]`)?.focus({ preventScroll: true });
}

function toDefault(id) {
  const c = find(id);
  if (!c) return;
  if (effectiveOf(c, null) < c.effective) choose(id, null);
  else save(id, null);
}

// Wires the part into Settings: `render` redraws it; `go` opens an address in the app.
export function bindApprovals(root, render, go) {
  part.rerender = render;
  // The passkey step's own states (passkey.js show), for the confirmation on its way: "Waiting for
  // your passkey" and its Stop waiting only once the browser is really asking.
  document.addEventListener('nova:passkey', (e) => {
    let moved = false;
    for (const id of busy) { const want = asking.get(id); if (want && !paired()) { want.passkey = e.detail?.state ?? 'ready'; moved = true; } }
    if (moved) rerender();
  });
  on('profile', () => { if (document.getElementById('approvals')) loadApprovals(); });
  // An extension installed or removed adds or takes away what it registered.
  on('extension', () => { if (document.getElementById('approvals')) loadApprovals(); });
  root.addEventListener('change', (e) => {
    const t = e.target;
    const id = t.closest('#approvals [data-capability]')?.dataset.capability;
    if (!id) return;
    if (t.type === 'radio' && t.closest('.appr-pick')) choose(id, Number(t.value));
    if (t.name === 'confirm' && t.closest('.appr-confirm')) {
      const want = asking.get(id);
      if (want) want.confirmed = t.checked;
      const b = t.closest('form').querySelector('[data-action="passkey-confirm"], [data-action="appr-confirm"]');
      if (b && want?.passkey !== 'rate') b.disabled = !t.checked;
    }
  });
  root.addEventListener('submit', (e) => {
    const form = e.target.closest('#approvals .appr-confirm, #approvals .appr-pick');
    if (!form) return;
    e.preventDefault();
    const id = form.dataset.capability;
    const want = asking.get(id);
    if (!form.classList.contains('appr-confirm') || !want || !form.querySelector('input[name="confirm"]')?.checked) return;
    save(id, want.to, { confirm: true });
  });
  root.addEventListener('click', (e) => {
    const b = e.target.closest('#approvals [data-action]');
    if (!b) return;
    const id = b.closest('[data-capability]')?.dataset.capability;
    const a = b.dataset.action;
    if (a === 'appr-retry') loadApprovals();
    if (a === 'appr-default' && id) toDefault(id);
    if (a === 'appr-cancel' && id) { asking.delete(id); said.delete(id); resetPick(id); rerender(); document.querySelector(`#appr-${CSS.escape(slug(id))} input:checked`)?.focus({ preventScroll: true }); }
    if (a === 'passkey-ask-again' && id && asking.has(id)) save(id, asking.get(id).to, { confirm: true });
    if (a === 'passkey-add') go('/settings#security');
  });
}
