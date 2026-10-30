// The core's API (/api/v1), its event stream, and this device's id. One stream for the whole
// page; anything that wants to hear about tasks, problems, setup or the design system listens here.

export const V1 = '/api/v1';

// A device id is a random id this browser keeps (there is no device registry until M4). It picks
// the device's own design system when it has one.
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
export async function request(method, path, body) {
  let res;
  try {
    res = await fetch(`${V1}${path}`, { method, headers: { 'content-type': 'application/json', 'x-nova': '1' }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  } catch {
    throw new Unreachable('Nova’s server didn’t answer.');
  }
  const stale = fromCache(res);
  if (res.status === 503 && stale) throw new Unreachable('Nova’s server didn’t answer.');
  const json = res.headers.get('content-type')?.startsWith('application/json');
  const data = json ? await res.json().catch(() => null) : await res.text();
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
  return source;
}
export function on(event, fn) {
  const wrapped = (e) => { let data = null; try { data = JSON.parse(e.data); } catch {} fn(data); };
  if (!listeners.has(event)) listeners.set(event, new Set());
  listeners.get(event).add(wrapped);
  source?.addEventListener(event, wrapped);
  return () => { listeners.get(event)?.delete(wrapped); source?.removeEventListener(event, wrapped); };
}
