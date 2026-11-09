// The passkey step for tier 3 on Nova's own screen (Insertion #3 T2). Any request with
// confirm: true from the hub's own screen is first approved with a passkey: Nova issues a
// challenge for that exact request (method, path, body), the browser signs it, and the request
// carries the signature. A paired device has its own key and never reaches this step (the
// passkey routes are refused to it). No passkey yet: nothing tier-3 runs here (owner, #291).

import { passkeyLine, passkeySetup } from './components.js';
import { b64url } from './device-key.js';
import { escapeHtml as esc } from './markdown.js';
import { waitingLine } from './wait.js';

const unb64 = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
const b64 = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes)));
// Some engines report the interface as an object, not a function: ask whether it exists.
const supported = () => !!globalThis.PublicKeyCredential && typeof navigator.credentials?.get === 'function';
const UNAVAILABLE = 'This browser can’t use a passkey here. Open Nova on this computer’s own address (localhost) in a browser that supports passkeys.';

// Said instead of the request's own answer: the step stopped, and nothing was approved.
export class PasskeyStop extends Error {
  constructor(message, state) { super(message); this.state = state; }
}

// The open sheet's form says how the step is going, in the approved words (components.js). While
// it waits, "Cancel the task" is hidden; "Stop waiting" and "Not now" stay (owner, #291).
// A confirmation drawn in place rather than in the sheet (Settings › Approvals) hears the state too.
export function show(state) {
  document.dispatchEvent(new CustomEvent('nova:passkey', { detail: { state } }));
  const form = document.querySelector('#sheet[open] #sheet-body form');
  if (!form) return;
  form.querySelector('.passkey-line')?.remove();
  form.querySelectorAll('[data-action="passkey-stop"], [data-passkey-add]').forEach((n) => n.remove());
  const actions = form.querySelector('.sheet-actions');
  if (actions) actions.insertAdjacentHTML('beforebegin', passkeyLine(state)); else form.insertAdjacentHTML('beforeend', passkeyLine(state));
  const busy = state === 'waiting';
  const cancel = form.querySelector('[data-action="cancel-task"]');
  if (cancel) cancel.hidden = busy;
  for (const b of form.querySelectorAll('button[type="submit"]')) { b.disabled = busy || state === 'no-passkey' || state === 'unavailable'; b.toggleAttribute('aria-busy', busy); }
  if (busy) actions?.insertAdjacentHTML('beforeend', '<button type="button" class="btn quiet" data-action="passkey-stop">Stop waiting</button>');
  if (state === 'no-passkey') actions?.insertAdjacentHTML('afterbegin', '<a class="btn primary" href="/settings#security" data-passkey-add>Add a passkey</a>');
}

let attempt = null;
if (typeof document !== 'undefined') {
  document.addEventListener('click', (e) => {
    if (e.target.closest('[data-action="passkey-stop"]')) attempt?.abort();
    if (e.target.closest('[data-passkey-add]')) document.getElementById('sheet')?.close();
  });
}

// Signs one challenge with a registered passkey. Stopping, closing the sheet or the browser's own
// cancel all end the attempt with nothing approved.
async function sign(c) {
  attempt?.abort();
  const ctl = (attempt = new AbortController());
  document.getElementById('sheet')?.addEventListener('close', () => ctl.abort(), { once: true });
  show('waiting');
  try {
    const cred = await navigator.credentials.get({ publicKey: { challenge: unb64(c.challenge), rpId: 'localhost', allowCredentials: c.allow.map((id) => ({ type: 'public-key', id: unb64(id) })), userVerification: 'required', timeout: 120_000 }, signal: ctl.signal });
    const r = cred.response;
    return { id: c.id, digest: c.digest, credential_id: cred.id, authenticator_data: b64url(r.authenticatorData), client_data_json: b64url(r.clientDataJSON), signature: b64url(r.signature) };
  } catch (e) {
    const state = Date.parse(c.expires_at) <= Date.now() ? 'expired' : e?.name === 'SecurityError' ? 'unavailable' : 'cancelled';
    show(state);
    throw new PasskeyStop(state === 'unavailable' ? UNAVAILABLE : state === 'expired' ? 'This request ran out of time before it was confirmed, so nothing was approved.' : 'No passkey was used, so nothing was approved.', state);
  } finally {
    if (attempt === ctl) attempt = null;
  }
}

// The approval a tier-3 request carries, or null where no passkey step applies (a paired device).
export async function approvalFor(api, method, path, body) {
  let state;
  try { state = await api('GET', '/security/passkeys'); } catch (e) { if (e.status === 403) return null; throw e; }
  if (!state.count) { show('no-passkey'); throw new PasskeyStop('Actions like this need a passkey on Nova’s own screen. Add one in Settings › Security first.', 'no-passkey'); }
  if (!supported()) { show('unavailable'); throw new PasskeyStop(UNAVAILABLE, 'unavailable'); }
  let c;
  try { c = await api('POST', '/security/approvals', { method, path, body }); } catch (e) { if (e.status === 429) show('rate'); throw e; }
  return sign(c);
}

// Adding a passkey: after the first (taken on trust), one you already have approves it.
async function addPasskey(api) {
  if (!supported() || typeof navigator.credentials.create !== 'function') throw new PasskeyStop(UNAVAILABLE, 'unavailable');
  const o = await api('POST', '/security/passkeys/options', {});
  const approval = o.approval ? await sign(o.approval) : undefined;
  let cred;
  try {
    cred = await navigator.credentials.create({ publicKey: {
      challenge: unb64(o.challenge), rp: o.rp, user: { ...o.user, id: unb64(o.user.id) },
      pubKeyCredParams: [{ type: 'public-key', alg: -7 }], excludeCredentials: o.exclude.map((id) => ({ type: 'public-key', id: unb64(id) })),
      authenticatorSelection: { userVerification: 'required', residentKey: 'preferred' }, attestation: 'none', timeout: 120_000,
    } });
  } catch (e) {
    throw new PasskeyStop('No passkey was added.', e?.name === 'SecurityError' ? 'unavailable' : 'failed');
  }
  const r = cred.response;
  return api('POST', '/security/passkeys', { registration: o.registration, credential_id: cred.id, public_key: b64(r.getPublicKey()), authenticator_data: b64url(r.getAuthenticatorData()), client_data_json: b64url(r.clientDataJSON), ...(approval ? { approval } : {}) });
}

// Settings › Security.
const view = { state: 'start', name: '', data: null, error: '' };
export async function loadSecurity(api) {
  try { view.data = await api('GET', '/security/passkeys'); view.error = ''; } catch (e) { view.data = null; view.error = e.message; }
}
export function renderSecurity() {
  const d = view.data;
  return `<section class="memory-section" id="security" aria-labelledby="set-security"><h2 class="memory-heading" id="set-security">Security</h2>
${d ? passkeySetup({ state: view.state, name: view.name, count: d.count, passkeys: d.passkeys, first: d.first_enrolled_at }) : view.error ? `<p class="memory-lede">${esc(view.error)}</p>` : waitingLine('Checking your passkeys')}</section>`;
}
export async function setupPasskey(api, redraw) {
  view.state = 'waiting';
  redraw();
  try {
    view.data = await addPasskey(api);
    view.name = view.data.passkeys.at(-1)?.name ?? '';
    view.state = 'added';
  } catch (e) {
    view.state = e instanceof PasskeyStop && e.state === 'unavailable' ? 'unavailable' : 'failed';
  }
  redraw();
}
