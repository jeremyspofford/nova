// The core's API (/api/v1), its event stream, and this device's id. One stream for the whole
// page; anything that wants to hear about tasks, problems, setup or the design system listens here.

import { renew, sessionEnds } from './device-key.js';
import { approvalFor, show } from './passkey.js';

export const V1 = '/api/v1';

// An appearance id: a random id this browser keeps, so it can have its own design system. (A
// paired browser's place in the device registry is its key, in device-key.js.)
let memoId = null;
export function deviceId() {
  const ok = (v) => typeof v === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(v);
  try {
    let id = localStorage.getItem('nova.device');
    if (!ok(id)) { id = crypto.randomUUID(); localStorage.setItem('nova.device', id); }
    return id;
  } catch {
    memoId ??= crypto.randomUUID();
    return memoId;
  }
}

export class Unreachable extends Error {}

// Answers that the service worker served from its cache while Nova was out of reach carry
// x-nova-offline; the page says so rather than presenting them as live, and an answer from the
// cache never counts as Nova being reachable.
export const fromCache = (res) => res.headers.get('x-nova-offline') === '1';

// The page's one way to reach Nova over HTTP; every helper that talks to the server goes through
// here (request below, and app.js's post and getJson). No answer at all (Nova out of reach) is
// Unreachable, saying `message`; any answer, error or not, comes back for the caller to read.
// (/pair carries its own: it may load only public files, src/core/mesh/access.ts PUBLIC_PATHS.)
export const NOVA_HEADERS = Object.freeze({ 'content-type': 'application/json', 'x-nova': '1' });
export async function reach(url, init = {}, message = 'Nova’s server didn’t answer.') {
  try {
    return await fetch(url, init);
  } catch {
    throw new Unreachable(message);
  }
}

// An error answer as an Error: the server's own words when it gave some, its status and details.
export function refused(res, data) {
  const e = new Error((data && data.error) || 'Something went wrong.');
  e.details = data?.details ?? [];
  e.status = res.status;
  return e;
}

// The answer and whether it came from the offline cache, kept together so concurrent requests
// can't mix up whose answer was stale.
// A read the hub hasn't answered in this long is no answer: the page says Nova is out of reach
// instead of waiting forever (M9 review of #234). Changes (POST, PUT, DELETE) wait for their answer.
export const NO_ANSWER_MS = 10_000;
export async function request(method, path, body, retried = false) {
  // Tier 3 on the hub's own screen: approved with a passkey first (passkey.js). Rolling a change
  // back by hand takes confirm: true at tier 2, so it asks once (src/core/index.ts TIER2_CONFIRM).
  const bare = path.split('?')[0];
  const signed = body?.confirm === true && !body.passkey_approval && !/^\/changes\/[^/]+\/rollback$/.test(bare) ? await approvalFor(api, method, bare, body) : null;
  if (signed) body = { ...body, passkey_approval: signed };
  const signal = method === 'GET' && typeof AbortSignal.timeout === 'function' ? AbortSignal.timeout(NO_ANSWER_MS) : undefined;
  const res = await reach(`${V1}${path}`, { method, headers: NOVA_HEADERS, ...(body !== undefined ? { body: JSON.stringify(body) } : {}), ...(signal ? { signal } : {}) });
  // Only a paired device ever hears 401 (the hub's own screen never does): its session ended, so
  // it signs in again once with its key, or goes back to /pair.
  if (res.status === 401 && !retried) {
    if (sessionEnds() && (await renew())) return request(method, path, body, true);
    location.assign('/pair');
  }
  const stale = fromCache(res);
  if (res.status === 503 && stale) throw new Unreachable('Nova’s server didn’t answer.');
  const json = res.headers.get('content-type')?.startsWith('application/json');
  const CUT = Symbol('cut');
  let data = json ? await res.json().catch(() => CUT) : await res.text();
  // An answer cut off part-way (a page left, a dropped connection) is no answer: the page keeps
  // what it had instead of taking null for its tasks or requests.
  if (data === CUT) {
    if (res.ok) throw new Unreachable('Nova’s answer was cut off.');
    data = null;
  }
  if (signed) show(res.ok ? 'confirmed' : res.status === 403 && /passkey/i.test(data?.error ?? '') ? (/expired/.test(data.error) ? 'expired' : 'failed') : 'ready');
  if (!res.ok) throw refused(res, data);
  return { data, stale };
}

export const api = (method, path, body) => request(method, path, body).then((r) => r.data);

// The core's live updates: task, problem, setup, profile, extension, trigger, message,
// design-system. One EventSource, many listeners.
let source = null;
const listeners = new Map();
export function stream() {
  if (source) return source;
  source = new EventSource(`${V1}/events`);
  for (const [event, set] of listeners) for (const fn of set) source.addEventListener(event, fn);
  // A browser gives up on a stream the server refused (a paired device whose session ended or was
  // revoked); it retries by itself only when the network dropped. Sign in again, then reopen.
  const mine = source;
  source.addEventListener('error', () => {
    if (mine.readyState !== EventSource.CLOSED || !sessionEnds()) return;
    source = null;
    renew().then((ok) => (ok ? stream() : location.assign('/pair')));
  });
  return source;
}
export function on(event, fn) {
  const wrapped = (e) => { let data = null; try { data = JSON.parse(e.data); } catch {} fn(data); };
  if (!listeners.has(event)) listeners.set(event, new Set());
  listeners.get(event).add(wrapped);
  source?.addEventListener(event, wrapped);
  return () => { listeners.get(event)?.delete(wrapped); source?.removeEventListener(event, wrapped); };
}
