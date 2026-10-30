// /pair: how a phone or browser joins Nova (M4 plan §1). It reads the code and the hub's
// fingerprint from the address's fragment (never sent to a server), checks it is talking to that
// hub, makes its keys, joins, reveals, and shows the six digits the hub shows too. Once the person
// approves on the hub, it checks the hub signed the roster, starts a session (an HttpOnly cookie)
// and goes Home. A browser that is already paired comes here to sign in again.
//
// This page loads only public files, so it carries its own small helpers.
import * as key from './device-key.js';

const $ = (id) => document.getElementById(id);
const body = $('pair-body');
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const orb = (state) => { $('pair-orb').dataset.state = state; };
const title = (t) => { $('pair-title').textContent = t; };
const group = (d) => `${d.slice(0, 3)} ${d.slice(3)}`;

// Nova out of reach is told apart from everything else: only that is worth asking again.
class Offline extends Error {}

async function api(method, path, data) {
  let res;
  try {
    res = await fetch(`/api/v1${path}`, {
      method, headers: { 'content-type': 'application/json', 'x-nova': '1' }, ...(data === undefined ? {} : { body: JSON.stringify(data) }),
    });
  } catch {
    throw new Offline('Nova didn’t answer.');
  }
  const out = await res.json().catch(() => ({}));
  if (!res.ok) { const e = new Error(out.error || 'Nova didn’t answer as expected.'); e.status = res.status; throw e; }
  return out;
}

// The fragment carries c (the code) and h (the hub's fingerprint). It is dropped from the address
// bar at once, so the code isn't left in history.
const fragment = new URLSearchParams(location.hash.slice(1));
const given = { code: fragment.get('c') ?? '', fingerprint: fragment.get('h') ?? '' };
if (location.hash) history.replaceState(null, '', location.pathname);

const coarse = matchMedia('(pointer: coarse)').matches;
const platform = () => (navigator.userAgentData?.platform || navigator.platform || '').slice(0, 60);
let hello = null;

function stop(heading, text, { retry = false, state = 'attention' } = {}) {
  orb(state);
  title(heading);
  body.innerHTML = `<p class="pair-line">${esc(text)}</p>${retry ? '<div class="pair-actions"><button type="button" class="btn primary" id="again">Start again</button></div>' : ''}`;
  $('again')?.addEventListener('click', () => form());
}

function form(note = '') {
  orb('idle');
  title('Pair with Nova');
  body.innerHTML = `${note ? `<p class="pair-line">${esc(note)}</p>` : ''}
<form class="pair-form" id="join-form">
  <label class="pair-label" for="code">Code from your hub</label>
  <input class="input pair-code" id="code" name="code" value="${esc(given.code)}" autocomplete="one-time-code" autocapitalize="characters" spellcheck="false" maxlength="12" required placeholder="ABCD-EFGH">
  <label class="pair-label" for="name">Call this device</label>
  <input class="input" id="name" name="name" value="${coarse ? 'Phone' : 'Browser'}" maxlength="60" required>
  <p class="pair-note">Only enter a code here if this page is at <strong>${esc(location.origin)}</strong>, the address your hub showed you.${hello ? ` This hub’s fingerprint begins ${esc(hello.fingerprint.slice(0, 9))}.` : ''}</p>
  <div class="pair-actions"><button type="submit" class="btn primary" id="join">Pair this device</button></div>
</form>`;
  $(given.code ? 'name' : 'code').focus();
  $('join-form').addEventListener('submit', (e) => { e.preventDefault(); join($('code').value, $('name').value).catch(fail); });
}

function fail(e) {
  stop('That didn’t work', e.message || 'Something went wrong.', { retry: true, state: 'alert' });
}

async function join(code, name) {
  $('join').disabled = true;
  orb('working');
  // A fresh key for every new pairing: a key that was turned away is never used again.
  const id = await key.create();
  const nonce = key.nonce();
  const kind = coarse ? 'phone' : 'browser';
  const r = await api('POST', '/mesh/join', {
    code, public_key: id.publicKey, x25519_public_key: id.x25519PublicKey,
    x25519_sig: await key.sign(id, `nova-x25519-v1.${id.x25519PublicKey}`),
    claims: { name, platform: platform(), kind, capabilities: [] },
    commitment: await key.commitment(id.publicKey, nonce),
  });
  if (r.hub_fingerprint !== hello.fingerprint || (given.fingerprint && r.hub_fingerprint !== given.fingerprint)) {
    throw new Error('This isn’t the hub that made the code, so this device won’t join it.');
  }
  const time = key.signedTime();
  const { confirmation } = await api('POST', `/mesh/join/${encodeURIComponent(r.request_id)}/reveal`, {
    device_nonce: nonce, time, signature: await key.sign(id, `nova-add-device-reveal-v1.${r.request_id}.${time}`),
  });
  const mine = await key.digits({ hubFingerprint: r.hub_fingerprint, pairingId: r.pairing_id, publicKey: id.publicKey, code, deviceNonce: nonce, hubNonce: r.hub_nonce });
  // The device shows the digits it worked out itself; if the hub's differ, something is in between.
  if (mine !== confirmation) throw new Error('The check digits didn’t match, so this device stopped. Don’t approve anything on the hub; start again with a new code.');
  await key.update({ pending: { requestId: r.request_id, digits: mine } });
  wait(await key.load());
}

// The digits, and a signed check on the request every two seconds until the person decides.
function wait(id) {
  const { requestId, digits } = id.pending;
  orb('attention');
  title('Check the digits');
  body.innerHTML = `<p class="pair-digits" aria-label="${esc(digits.split('').join(' '))}">${esc(group(digits))}</p>
<p class="pair-line">Your hub shows six digits too. If they match, approve this device there. If they don’t, deny it.</p>
<p class="pair-note" id="waiting">Waiting for your OK on the hub.</p>`;
  const poll = async () => {
    try {
      const time = key.signedTime();
      const sig = await key.sign(id, `nova-add-device-status-v1.${requestId}.${time}`);
      const s = await api('GET', `/mesh/join/${encodeURIComponent(requestId)}?time=${time}&signature=${encodeURIComponent(sig)}`);
      if (s.state === 'pending') { setTimeout(poll, 2000); return; }
      await key.update({ pending: null });
      if (s.state === 'approved') return await approved(s);
      if (s.state === 'denied') return stop('Not added', 'The hub turned this device away. Ask for a new code if that was a mistake.', { retry: true });
      return stop('Too late', 'Nobody approved this device in time. Ask your hub for a new code.', { retry: true });
    } catch (e) {
      // Offline for a moment: keep asking. Anything else is said, never waited out in silence.
      if (e instanceof Offline) { setTimeout(poll, 2000); return; }
      await key.update({ pending: null }).catch(() => {});
      fail(e);
    }
  };
  poll();
}

async function approved(s) {
  // Pin the hub: the roster must be signed by the key this page has been talking to.
  const ok = await key.verify(hello.public_key, `nova-roster-v1.${key.canonicalJson(s.roster.roster)}`, s.roster.signature);
  if (!ok || s.roster.roster.hub.public_key !== hello.public_key) throw new Error('The hub’s answer wasn’t signed by the hub, so this device won’t trust it. Don’t use this address.');
  const pinned = [s.roster.roster.hub.public_key, s.roster.roster.standby?.public_key].filter(Boolean);
  const id = await key.update({ deviceId: s.device_id, hub: { fingerprint: hello.fingerprint, origin: location.origin, pinned, epoch: s.roster.roster.epoch } });
  await signIn(id);
}

async function signIn(id) {
  orb('working');
  title('Signing in');
  body.innerHTML = '<p class="pair-line">One moment.</p>';
  await key.startSession(id);
  orb('idle');
  title('Paired');
  body.innerHTML = '<p class="pair-line">This device is paired. Opening Nova.</p>';
  location.replace('/');
}

async function start() {
  const can = await key.support();
  if (!can.ok) return stop('This browser can’t pair', can.reason);
  try {
    hello = await api('GET', '/mesh/hello');
  } catch {
    return stop('Nova isn’t answering', 'This page can’t reach Nova right now. Check the address, then reload.', { state: 'offline' });
  }
  if (given.fingerprint && given.fingerprint !== hello.fingerprint) {
    return stop('Wrong address', 'This isn’t the hub that made the code. Don’t enter the code here; open the address your hub showed you.', { state: 'alert' });
  }
  const id = await key.load();
  // Left showing digits with no key behind them (WebKit once kept nothing): nothing here can sign,
  // so it starts again with a new key rather than waiting forever.
  if (id && !id.ed) {
    await key.forget();
    return form('This device’s pairing didn’t finish, so pair it again with a new code. It will get a new key.');
  }
  if (id?.deviceId && id.hub?.fingerprint === hello.fingerprint) {
    try {
      return await signIn(id);
    } catch (e) {
      if (e.status !== 401) return fail(e);
      await key.forget();
      return form('This device’s pairing ended, so it needs to be paired again. It will get a new key.');
    }
  }
  if (id?.pending) return wait(id);
  form();
}

start().catch(fail);
