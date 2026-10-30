// A change's own health probe (M7 plan §1): declarative, read by Nova, never code the change ships.
// A probe reads one of Nova's own GET routes and checks what comes back, so the same probe runs in
// the sandbox (over HTTP) and live (in this process) with the same meaning.
//
//   {name, path: '/triggers/rules', expect: [{at: 'length', op: 'gte', value: 1}]}
//
// `at` is a dot path into the JSON answer (`length` for a list's or text's length, numbers index a
// list); `op` compares what is there with `value`.

export const OPS = Object.freeze(['exists', 'missing', 'eq', 'ne', 'lt', 'lte', 'gt', 'gte', 'includes'] as const);
export type Op = (typeof OPS)[number];
export interface Expect { at?: string; op: Op; value?: unknown }
export interface Probe { name: string; path: string; expect: Expect[] }
export interface ProbeResult { name: string; ok: boolean; why: string }
export type Get = (path: string) => Promise<{ status: number; body: unknown }>;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const PATH = /^\/[A-Za-z0-9/_.~%-]*(\?[A-Za-z0-9=&_.~%:-]*)?$/;
const MAX_EXPECT = 20;

// What is wrong with a probe, in plain words; none means it can run.
export function probeProblems(p: unknown): string[] {
  if (!isObj(p)) return ['A probe is {name, path, expect: [{at?, op, value?}]}.'];
  const out: string[] = [];
  if (typeof p.name !== 'string' || !p.name.trim()) out.push('A probe needs a name, in plain words.');
  if (typeof p.path !== 'string' || !PATH.test(p.path) || p.path.includes('..') || p.path.startsWith('//')) out.push('A probe reads one of Nova’s own routes: path is like /triggers/rules (no host, no “..”).');
  else if (/^\/(events|changes\/sandbox|hooks)/.test(p.path)) out.push(`A probe can’t read ${p.path}.`);
  if (!Array.isArray(p.expect) || !p.expect.length || p.expect.length > MAX_EXPECT) out.push(`expect is a list of 1 to ${MAX_EXPECT} checks.`);
  else p.expect.forEach((e, i) => {
    if (!isObj(e) || !OPS.includes(e.op as Op)) out.push(`expect[${i}].op must be one of ${OPS.join(', ')}.`);
    else if (e.at !== undefined && (typeof e.at !== 'string' || e.at.length > 200)) out.push(`expect[${i}].at is a dot path, like checks.database.ok.`);
    else if (!['exists', 'missing'].includes(e.op as string) && e.value === undefined) out.push(`expect[${i}] compares with value, which is missing.`);
  });
  return out;
}

export function pick(v: unknown, at: string | undefined): unknown {
  if (!at) return v;
  let cur: unknown = v;
  for (const part of at.split('.')) {
    if (part === 'length' && (Array.isArray(cur) || typeof cur === 'string')) { cur = cur.length; continue; }
    if (Array.isArray(cur) && /^\d+$/.test(part)) { cur = cur[Number(part)]; continue; }
    if (isObj(cur) && Object.hasOwn(cur, part)) { cur = cur[part]; continue; }
    return undefined;
  }
  return cur;
}

function holds(got: unknown, e: Expect): boolean {
  const n = (x: unknown) => (typeof x === 'number' ? x : Number.NaN);
  switch (e.op) {
    case 'exists': return got !== undefined && got !== null;
    case 'missing': return got === undefined || got === null;
    case 'eq': return JSON.stringify(got) === JSON.stringify(e.value);
    case 'ne': return JSON.stringify(got) !== JSON.stringify(e.value);
    case 'lt': return n(got) < n(e.value);
    case 'lte': return n(got) <= n(e.value);
    case 'gt': return n(got) > n(e.value);
    case 'gte': return n(got) >= n(e.value);
    case 'includes': return (Array.isArray(got) && got.some((x) => JSON.stringify(x) === JSON.stringify(e.value))) || (typeof got === 'string' && typeof e.value === 'string' && got.includes(e.value));
  }
}

const show = (v: unknown) => { const s = JSON.stringify(v); return s === undefined ? 'nothing' : s.length > 60 ? `${s.slice(0, 57)}…` : s; };

export async function runProbe(p: Probe, get: Get): Promise<ProbeResult> {
  let res: { status: number; body: unknown };
  try {
    res = await get(p.path);
  } catch (e) {
    return { name: p.name, ok: false, why: `${p.name}: Nova couldn’t read ${p.path}: ${(e as Error).message}` };
  }
  if (res.status !== 200) return { name: p.name, ok: false, why: `${p.name}: ${p.path} answered ${res.status}${isObj(res.body) && typeof res.body.error === 'string' ? ` (${res.body.error})` : ''}.` };
  for (const e of p.expect) {
    const got = pick(res.body, e.at);
    if (!holds(got, e)) return { name: p.name, ok: false, why: `${p.name}: ${e.at ?? 'the answer'} is ${show(got)}, expected ${e.op}${e.value === undefined ? '' : ` ${show(e.value)}`}.` };
  }
  return { name: p.name, ok: true, why: `${p.name}: as expected.` };
}

// A GET of the core's own routes from inside this process, as the hub's own screen would ask: the
// live canary reads exactly what a page would, without going over the network.
export interface RouteLike { method: string; path: string; handle: (ctx: never) => unknown }
export function localGet(routes: () => RouteLike[], who: unknown): Get {
  return async (path: string) => {
    const url = new URL(path, 'http://nova.invalid');
    const sub = url.pathname;
    for (const r of routes()) {
      if (r.method !== 'GET') continue;
      const re = new RegExp(`^${r.path.replace(/[.*+?^$()|[\]\\]/g, '\\$&').replace(/\{(\w+)\}/g, '(?<$1>[^/]+)')}$`);
      const m = re.exec(sub);
      if (!m) continue;
      const params = Object.fromEntries(Object.entries(m.groups ?? {}).map(([k, v]) => [k, decodeURIComponent(v)]));
      try {
        const body = await (r.handle as (c: unknown) => unknown)({ params, query: url.searchParams, body: {}, headers: {}, who });
        return { status: 200, body };
      } catch (e) {
        const status = typeof (e as { status?: unknown }).status === 'number' ? (e as { status: number }).status : 500;
        return { status, body: { error: (e as Error).message } };
      }
    }
    return { status: 404, body: { error: 'Not found.' } };
  };
}
