// One-click diagnostics (Amendment 2026-10-31-B Part 6): a bundle of versions, health state, recent
// logs and config, for the person to download and do with as they choose. Nova builds it in memory
// for the request that asked, never keeps it on disk and never sends it anywhere.
//
// THE RULE: counts and states, never content; names of secrets at most, never their values. No
// memory text, conversation, captured screen/audio/accessibility text, task title or goal, or the
// person's name or address is ever read into it.
//
// REDACTED BY CONSTRUCTION, three layers (docs/plans/diagnostics.md):
//   1. allow-list: each section is built from named fields of Nova's own views; content-bearing
//      stores (memory, sessions, capture events, briefs) are never read;
//   2. keys (Home Assistant's diagnostics pattern): a key that names a secret has its value replaced
//      by the fixed marker, whatever the value, and so does any secret:// reference;
//   3. values: every value Nova knows as a secret (the vault's, the NOVA_SECRET_* fallbacks, the
//      mesh identity's private keys, the vault's key), in plain, case-folded, base64, base64url,
//      hex and URL-encoded form, is replaced wherever it appears, and so are secret-shaped strings
//      (Bearer …, URL credentials, JWTs, common token prefixes, token=… parameters).
import { readFileSync } from 'node:fs';
import { homedir, platform, arch } from 'node:os';
import { join } from 'node:path';
import { Reply, type Route } from '../api.ts';
import type { Core } from '../index.ts';

export const MARKER = '**REDACTED**';
export const RULE = 'Counts and states, never content; names of secrets at most, never their values.';
export const LOG_LINES = 500;
export const DETAIL_MAX = 2000;

// Keys whose values are secrets (log.ts's pattern, widened): the value goes, whatever it is.
export const SECRET_KEY = /pass(word)?|secret|token|api[_-]?key|authori[sz]ation|cookie|private|credential|session|^auth$|^key$|[_-]key$|^mac$|serial/i;
// Secret-shaped strings, wherever they are.
const SHAPES: [RegExp, string][] = [
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{6,}/gi, `$1 ${MARKER}`],
  [/(\/\/)[^/\s:@]+:[^/\s@]+@/g, `$1${MARKER}@`],
  [/\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}/g, MARKER],
  [/\b(?:sk|pk|rk)-[A-Za-z0-9_-]{12,}|\bgh[pousr]_[A-Za-z0-9]{12,}|\bxox[abprs]-[A-Za-z0-9-]{8,}|\bAKIA[A-Z0-9]{12,}/g, MARKER],
  [/\b((?:access_|refresh_|id_)?token|api[_-]?key|key|secret|password|code|sig|signature)=([^&\s"'<>]+)/gi, `$1=${MARKER}`],
  [/secret:\/\/[A-Za-z0-9_./-]+/g, MARKER],
];

// Every form a secret could take in text.
export function formsOf(value: string): string[] {
  const out = new Set<string>([value, encodeURIComponent(value), encodeURIComponent(value).replace(/%20/g, '+'),
    Buffer.from(value).toString('base64').replace(/=+$/, ''), Buffer.from(value).toString('base64url'), Buffer.from(value).toString('hex')]);
  // A key kept as base64 (the mesh and vault keys): its raw bytes as hex too.
  if (/^[A-Za-z0-9+/_-]{16,}={0,2}$/.test(value)) {
    try { const raw = Buffer.from(value, 'base64'); if (raw.length >= 12) { out.add(raw.toString('hex')); out.add(raw.toString('base64url')); out.add(raw.toString('base64').replace(/=+$/, '')); } } catch { /* not base64 */ }
  }
  return [...out].filter((f) => f.length >= 6);
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export class Scrubber {
  readonly marker = MARKER;
  values = 0;
  keys = 0;
  #res: RegExp[] = [];
  #paths: [string, string][] = [];

  constructor(secrets: string[], paths: [string, string][] = []) {
    const forms = new Set<string>();
    for (const s of secrets) if (typeof s === 'string' && s.length >= 6) for (const f of formsOf(s)) forms.add(f);
    // Longest first, so a form inside another is replaced as part of the longer one.
    const sorted = [...forms].sort((a, b) => b.length - a.length);
    for (let i = 0; i < sorted.length; i += 50) this.#res.push(new RegExp(sorted.slice(i, i + 50).map(escapeRe).join('|'), 'gi'));
    this.#paths = paths.filter(([p]) => p && p.length > 1).sort((a, b) => b[0].length - a[0].length);
  }

  text(s: string): string {
    let out = s;
    for (const re of this.#res) out = out.replace(re, () => { this.values++; return MARKER; });
    for (const [re, to] of SHAPES) out = out.replace(re, (...m) => { this.values++; return to.replace('$1', String(m[1] ?? '')); });
    for (const [p, to] of this.#paths) if (out.includes(p)) out = out.split(p).join(to);
    return out;
  }

  // Keys first (the Home Assistant pattern), then every string value.
  any(v: unknown, depth = 0): unknown {
    if (typeof v === 'string') return this.text(v);
    if (v === null || typeof v !== 'object' || depth > 12) return typeof v === 'object' && v !== null ? MARKER : v;
    if (Array.isArray(v)) return v.map((x) => this.any(x, depth + 1));
    return Object.fromEntries(Object.entries(v).map(([k, x]) => {
      if (SECRET_KEY.test(k) && x !== null && x !== undefined && typeof x !== 'boolean') { this.keys++; return [k, MARKER]; }
      return [this.text(k), this.any(x, depth + 1)];
    }));
  }
}

// Every value Nova knows as a secret, from where it keeps them. What can't be read is said in
// `warnings` (the allow-list and the key layer still hold).
export function knownSecrets(core: Pick<Core, 'vault'>, o: { home: string; env?: NodeJS.ProcessEnv }): { secrets: string[]; warnings: string[] } {
  const secrets: string[] = [];
  const warnings: string[] = [];
  const add = (v: unknown) => {
    if (typeof v !== 'string' || v.length < 6) return;
    secrets.push(v);
    if (v.startsWith('{')) { try { for (const x of Object.values(JSON.parse(v) as Record<string, unknown>)) add(x); } catch { /* not JSON */ } }
  };
  try { for (const name of core.vault.list()) add(core.vault.get(name)); } catch (e) { warnings.push(`The vault’s values couldn’t be read to check against (${(e as Error).message}); keys and shapes were still redacted.`); }
  try { add(core.vault.keyForStandby()); } catch { /* no key yet */ }
  try { add(readFileSync(join(o.home, 'vault', 'key')).toString('base64')); } catch { /* keychain-held, or none */ }
  try {
    const id = JSON.parse(readFileSync(join(o.home, 'mesh', 'identity.json'), 'utf8')) as Record<string, Record<string, unknown>>;
    for (const part of Object.values(id)) if (part && typeof part === 'object') add(part.private);
  } catch { /* no identity yet */ }
  // The stable name's control token (M10g) is a secret too.
  for (const [k, v] of Object.entries(o.env ?? process.env)) if (/^NOVA_SECRET_/.test(k) || k === 'NOVA_MESH_NAME_TOKEN') add(v);
  return { secrets, warnings };
}

const clip = (s: unknown, n: number) => { const t = String(s ?? ''); return t.length > n ? `${t.slice(0, n)}… [${t.length - n} more characters]` : t; };
const safe = (f: () => unknown, fallback: (e: Error) => unknown): unknown => { try { return f(); } catch (e) { return fallback(e as Error); } };
const unread = (e: Error) => ({ unreadable: e.message });
const byState = (xs: { state: string }[]) => { const out: Record<string, number> = {}; for (const x of xs) out[x.state] = (out[x.state] ?? 0) + 1; return out; };

function logTail(file: string | null, n: number) {
  if (!file) return [];
  let text = '';
  try { text = readFileSync(file, 'utf8'); } catch { return []; }
  return text.split('\n').filter(Boolean).slice(-n).map((l) => {
    try {
      const j = JSON.parse(l) as Record<string, unknown>;
      // Time, level, source and message only: a line's data fields can carry content.
      return { at: j.at, level: j.level, source: j.source, msg: clip(j.msg, 1000) };
    } catch { return { msg: '(a line that isn’t JSON)' }; }
  });
}

// The person's settings by section: the `user` section (their name, address, details) is replaced
// whole; capture's lists (exclusions: apps, sites) become how many.
function config(core: Pick<Core, 'profile'>) {
  const all = core.profile.all();
  return Object.fromEntries(Object.entries(all).map(([section, v]) => {
    if (section === 'user') return [section, Object.fromEntries(Object.keys(v).map((k) => [k, MARKER]))];
    if (section === 'capture') return [section, Object.fromEntries(Object.entries(v).map(([k, x]) => [k, Array.isArray(x) ? `${x.length} item${x.length === 1 ? '' : 's'}` : x]))];
    return [section, v];
  }));
}

export interface DiagnosticsOptions {
  home: string;
  version: string;
  commit?: string | null;
  instance?: string;
  now?: () => Date;
  env?: NodeJS.ProcessEnv;
  // Era 2's counts (conversations, schedules, skills), handed in by the server: counts only.
  era2?: () => Record<string, number>;
}

export async function buildDiagnostics(core: Core, o: DiagnosticsOptions) {
  const now = (o.now ?? (() => new Date()))();
  const { secrets, warnings } = knownSecrets(core, o);
  const scrub = new Scrubber(secrets, [[o.home, '<home>'], [homedir(), '~']]);
  const models = await core.models.view().catch((e: Error) => unread(e));
  const raw = {
    about: {
      nova: o.version, build: o.commit ?? null, instance: o.instance ?? null,
      role: safe(() => core.mesh.role.replica() ? 'standby' : 'hub', () => 'unknown'),
      platform: platform(), arch: arch(), node: process.version, created_at: now.toISOString(), home: '<home>',
      timezone_set: !!core.identity().timezone,
    },
    health: safe(() => core.health(), unread),
    config: safe(() => config(core), unread),
    vault: safe(() => {
      const s = core.vault.status();
      const kinds: Record<string, number> = {};
      for (const n of core.vault.list()) { const k = n.split('/')[0]!; kinds[k] = (kinds[k] ?? 0) + 1; }
      return { ok: s.ok, stored: s.secrets, by_kind: kinds, key_store: s.key, problem: s.problem };
    }, unread),
    providers: safe(() => core.providers.list().map((p) => ({ id: p.id, name: p.name, class: p.class, state: p.state, model: p.model, where: p.egress, health: p.health, config: p.config })), unread),
    models,
    capture: safe(() => ({
      status: core.capture.status(),
      sources: core.capture.sources().map((s) => ({ id: s.id, kinds: s.kinds, name: s.name, device: s.device?.name ?? null, enabled: s.enabled, paused: s.paused, status: s.status, detail: s.detail, has_api_key: s.has_api_key })),
    }), unread),
    connectors: safe(() => core.connectors.list().map((c) => ({ id: c.id, name: c.name, connected: c.connected, broken: c.broken, allowed: c.allowed, live: c.live })), unread),
    devices: safe(() => core.mesh.devices.list().map((d) => ({ id: d.id, name: d.name, kind: d.kind, role: d.role, trust: d.trust })), unread),
    // Targets and projects by name and state; a change's or run's title comes from the person's
    // words, so changes and runs are counted by state, never listed.
    network: safe(() => { const n = core.network.list(); return { window_s: n.window_s, devices_counted: n.devices.length, targets: n.targets, changes: byState(n.changes) }; }, unread),
    infra: safe(() => { const i = core.infra.list(); return { tool: i.tool, projects: i.projects.map((p) => ({ id: p.id, name: p.name, folder: p.folder, egress: p.egress, budget_usd_month: p.budget_usd_month, secrets: p.secrets })), runs: byState(i.runs) }; }, unread),
    work: {
      ledger: safe(() => core.ledger.counts(), unread),
      by_worker: safe(() => { const out: Record<string, number> = {}; for (const t of core.ledger.list({ limit: 500 })) out[t.owner] = (out[t.owner] ?? 0) + 1; return out; }, unread),
      memory: safe(() => core.memory.counts(), unread),
      receipts: safe(() => core.receipts.counts(), unread),
      triggers: safe(() => core.triggers.counts(), unread),
      extensions: safe(() => core.extensions.counts(), unread),
      era2: safe(() => o.era2?.() ?? null, unread),
    },
    problems: safe(() => core.log.problems().slice(0, 50).map((p) => ({ at: p.at, source: p.source, message: clip(p.message, 500), detail: p.detail ? clip(p.detail, DETAIL_MAX) : null, open: !p.resolved_at })), unread),
    logs: logTail(core.log.file, LOG_LINES),
  };
  const body = scrub.any(raw) as Record<string, unknown>;
  return {
    format: 'nova-diagnostics', format_version: 1, ...body,
    redaction: { marker: MARKER, rule: RULE, keys_redacted: scrub.keys, values_redacted: scrub.values, secrets_checked: secrets.length, warnings },
  };
}

export const fileName = (at: Date) => `nova-diagnostics-${at.toISOString().slice(0, 16).replace(/[-:T]/g, (c) => (c === 'T' ? '-' : '')).replace(/^(\d{8})-(\d{4})$/, (_m, d, t) => `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6)}-${t}`)}.json`;

// The route, ready for the composition root to wire (docs/plans/diagnostics.md, NOTES): the
// bundle as an attachment, to the person's own browser; never stored, never sent elsewhere.
export function diagnosticsRoutes(build: () => ReturnType<typeof buildDiagnostics>, now: () => Date = () => new Date()): Route[] {
  return [{
    method: 'GET', path: '/diagnostics',
    summary: 'One-click diagnostics: versions, health, recent logs and config, with every secret replaced by **REDACTED** and no personal content (counts and states only). Built for this request, returned as a file to download; Nova keeps no copy and sends it nowhere.',
    handle: async () => new Reply(await build(), { 'content-disposition': `attachment; filename="${fileName(now())}"` }),
  }];
}
