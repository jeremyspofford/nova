// The core's API (/api/v1), its event stream, and this device's id. One stream for the whole
// page; anything that wants to hear about tasks, problems, setup or the design system listens here.

import { renew, sessionEnds } from './device-key.js';

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

// The answer and whether it came from the offline cache, kept together so concurrent requests
// can't mix up whose answer was stale.
export async function request(method, path, body, retried = false) {
  let res;
  try {
    res = await fetch(`${V1}${path}`, { method, headers: { 'content-type': 'application/json', 'x-nova': '1' }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  } catch {
    throw new Unreachable('Nova’s server didn’t answer.');
  }
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
  if (!res.ok) {
    const e = new Error((data && data.error) || 'Something went wrong.');
    e.details = data?.details ?? [];
    e.status = res.status;
    throw e;
  }
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
