// What each kind of change is, and how the pipeline handles it (M7 plan §1): its shape and contract
// checks, its own tests, how it goes live in a limited scope and then for everyone, what was live
// before it, and how that is put back. The same functions run in the sandbox (on the sandbox's own
// core) and live, so what was tested is what ships. Nothing here runs code a change carries: an
// extension's tests and probe are declarative, read by Nova.
import { GATE_TEMPLATES } from './gates.ts';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { CoreError } from '../errors.ts';
import { PRIVACY_MODES, type PrivacyMode } from '../envelope.ts';
import { review, satisfies, validateManifest, type Manifest } from '../extensions.ts';
import { validatePackage } from '../design.ts';
import { validateTemplate, type DryRunCase, type TemplateDef } from '../decide.ts';
import { redactText } from '../log.ts';
import { parseCron, nextRun, describeCron } from '../../cron.js';
import { probeProblems, type Probe } from './probes.ts';
import type { ChangeKind } from './gates.ts';
import type { Db } from '../db.ts';
import type { Extensions, Installed } from '../extensions.ts';
import type { Design } from '../design.ts';
import type { Profile, Section } from '../profile.ts';
import type { Triggers, RuleInput } from '../triggers.ts';
import type { Templates } from '../decide.ts';
import type { Ledger } from '../ledger.ts';
import type { Egress } from '../workers.ts';

// What a kind needs of the core it runs against (live, or the sandbox's).
export interface Live {
  db: Db;
  extensions: Extensions;
  design: Design;
  profile: Profile;
  triggers: Triggers;
  templates: Templates;
  ledger: Ledger;
  now: () => Date;
  timezone: () => string;
  // Where a worker's data goes, or null when there is no such worker.
  workerEgress: (owner: string) => Egress | null;
  novaVersion: string;
}

export interface Check { name: string; ok: boolean; why: string }
export type Snapshot = Record<string, unknown> & { exists: boolean };

export interface Shape { target: string; title: string; version: string }
export interface SnapshotOptions { aside: string; device?: string | null }

export interface KindOps {
  // The fields that name the change. Throws (400) when it can't even be named.
  shape(a: Record<string, unknown>): Shape;
  // Contract checks: manifest, permissions review, egress, privacy. Pure.
  contract(a: Record<string, unknown>, privacy: PrivacyMode, live: Pick<Live, 'workerEgress' | 'extensions' | 'novaVersion'>): Check[];
  // The least tier this change needs for its content (the pipeline raises it for who proposed it).
  tier(a: Record<string, unknown>, live: Pick<Live, 'extensions'>): 1 | 2 | 3;
  // Plain-words lines of what it asks for, shown with the approval.
  asks(a: Record<string, unknown>): string[];
  // The change's own tests and the relevant Nova checks, run after `apply` on that core.
  test(a: Record<string, unknown>, live: Live): Promise<Check[]>;
  // What is live now for this target. `aside`: a folder of this change's own where files it will
  // overwrite are copied first, byte for byte; `device`: where a design system's canary shows.
  snapshot(a: Record<string, unknown>, live: Live, o: SnapshotOptions): Snapshot;
  // Goes live: in the canary's limited scope, or (in the sandbox) for everyone.
  apply(a: Record<string, unknown>, live: Live, o: { scope: 'canary' | 'full'; device: string | null; by: string }): Promise<void>;
  // From the canary's scope to everyone.
  promote(a: Record<string, unknown>, live: Live, o: { device: string | null }): Promise<void>;
  // Puts back exactly what the snapshot holds, undoing this change and nothing else.
  restore(prev: Snapshot, a: Record<string, unknown>, live: Live, o: SnapshotOptions): Promise<void>;
  // The change's own probe, if it has one.
  probe(a: Record<string, unknown>): Probe | null;
  // Where its problems are filed (log sources): the touched area, for the canary's error probe.
  area(a: Record<string, unknown>): string[];
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0;
const ID = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/;
const SEMVER = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;
const ok = (name: string, why: string): Check => ({ name, ok: true, why });
const bad = (name: string, why: string): Check => ({ name, ok: false, why });
const need = (v: boolean, what: string) => { if (!v) throw new CoreError('validation', what); };
// A secret value the vault holds, anywhere in what a change carries: it would be written to the
// home's history. Names (secret://NAME) are fine.
const carriesSecret = (a: unknown) => { const s = JSON.stringify(a); return redactText(s) !== s; };
const privacyCheck = (a: unknown): Check => (carriesSecret(a) ? bad('privacy', 'It carries a secret’s value. A change holds names only; values stay in the vault.') : ok('privacy', 'It carries no secret values.'));
const ownProbe = (a: Record<string, unknown>): Check[] => (a.probe === undefined ? [] : (() => { const p = probeProblems(a.probe); return [p.length ? bad('probe', `Its health probe isn’t valid: ${p.join(' ')}`) : ok('probe', 'Its health probe is valid.')]; })());

// ---- trigger-rule packs ----------------------------------------------------------------------

interface PackRule { name: string; class: 'heartbeat' | 'proactive'; cron?: string; action: RuleInput['action']; dedup_window_s?: number; cooldown_s?: number }
interface PackTest { name: string; at: string; expect: { rule: string; fires: boolean; message?: boolean } }
const packOf = (a: Record<string, unknown>) => a.pack as { id: string; name: string; version: string };
const rulesOf = (a: Record<string, unknown>) => (Array.isArray(a.rules) ? a.rules : []) as PackRule[];
const packMark = (id: string) => `changes:${id}`;
// Whose work a pack's rule may start. The workspace keeps to Nova's own folder, so its tasks may act
// without asking; every other worker reaches beyond it (the backup folder, a browser, a model or a
// connector), so its task must ask first: an explicit approval_tier of 2 or 3. The pipeline and the
// foundry are never a rule's to start.
const PACK_FREE_OWNERS: readonly string[] = ['workspace'];
const PACK_NEVER_OWNERS: readonly string[] = ['changes', 'foundry'];
const TIER_WORDS = ['acts without asking', 'acts, then tells you', 'asks you first', 'asks you to confirm, every time'];
const RULE_KEYS = ['name', 'class', 'cron', 'action', 'dedup_window_s', 'cooldown_s'] as const;

// A test's time: an ISO instant, or HH:MM meaning the next such time on the person's clock.
function testTime(at: string, live: Pick<Live, 'now' | 'timezone'>): Date | null {
  const hm = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(at);
  if (hm) {
    const next = nextRun(`${Number(hm[2])} ${Number(hm[1])} * * *`, live.now(), live.timezone());
    return next ? new Date(next.getTime() + 30_000) : null;
  }
  const t = new Date(at);
  return Number.isNaN(t.getTime()) ? null : t;
}

const triggerRules: KindOps = {
  shape(a) {
    const p = a.pack;
    need(isObj(p) && isStr(p.id) && ID.test(p.id), 'A rule pack has pack.id: lowercase letters and numbers, separated by dots or dashes.');
    need(isStr((p as Record<string, unknown>).name), 'A rule pack has pack.name, in plain words.');
    need(isStr((p as Record<string, unknown>).version) && SEMVER.test((p as Record<string, string>).version!), 'A rule pack has pack.version, like 1.0.0.');
    const pack = packOf(a);
    return { target: `trigger-rules:${pack.id}`, title: pack.name, version: pack.version };
  },
  contract(a, privacy, live) {
    const out: Check[] = [];
    const rules = a.rules;
    if (!Array.isArray(rules) || !rules.length || rules.length > 20) return [bad('manifest', 'A rule pack has 1 to 20 rules.')];
    const names = new Set<string>();
    const problems: string[] = [];
    rules.forEach((r, i) => {
      if (!isObj(r) || !isStr(r.name)) { problems.push(`rules[${i}] needs a name.`); return; }
      if (names.has(r.name)) problems.push(`Two rules are called “${r.name}”.`);
      names.add(r.name);
      if (r.class !== 'heartbeat' && r.class !== 'proactive') problems.push(`“${r.name}” is a ${String(r.class)} rule; a pack holds heartbeat and proactive rules.`);
      if (r.class === 'heartbeat') { try { parseCron(r.cron); } catch (e) { problems.push(`“${r.name}”: ${(e as Error).message}`); } }
      if (!isObj(r.action) || (r.action.kind !== 'message' && r.action.kind !== 'task')) problems.push(`“${r.name}” needs an action: {kind: "message", text} or {kind: "task", task}.`);
      else if (r.action.kind === 'message' && !isStr(r.action.text)) problems.push(`“${r.name}” sends a message with no text.`);
      for (const k of Object.keys(r)) if (!(RULE_KEYS as readonly string[]).includes(k)) problems.push(`“${r.name}” has ${k}, which a rule doesn’t take.`);
    });
    out.push(problems.length ? bad('manifest', problems.join(' ')) : ok('manifest', `${rules.length} rule${rules.length === 1 ? '' : 's'}, each well formed.`));
    // Egress: a message stays on the person's devices; a task goes where its worker sends it.
    const far = rulesOf(a).filter((r) => isObj(r.action) && r.action.kind === 'task').map((r) => ({ r, e: live.workerEgress(String((r.action as { task: { owner: string } }).task?.owner)) }));
    const unknown = far.filter((x) => x.e === null);
    const remote = far.filter((x) => x.e === 'remote');
    const ownerOf = (r: PackRule) => String((r.action as { task: { owner: string } }).task?.owner);
    const tierOf = (r: PackRule) => (r.action as { task: { approval_tier?: unknown } }).task?.approval_tier;
    const never = far.find((x) => PACK_NEVER_OWNERS.includes(ownerOf(x.r)));
    const unasked = far.find((x) => !PACK_FREE_OWNERS.includes(ownerOf(x.r)) && !(tierOf(x.r) === 2 || tierOf(x.r) === 3));
    if (never) out.push(bad('owners', `“${never.r.name}” would start work for ${ownerOf(never.r)}; a rule pack never starts work for changes or the foundry.`));
    else if (unasked) out.push(bad('owners', `“${unasked.r.name}” starts work for ${ownerOf(unasked.r)}, which reaches beyond Nova’s own workspace, without asking first. Give its task approval_tier 2 or 3.`));
    else if (far.length) out.push(ok('owners', `Its tasks are for ${[...new Set(far.map((x) => ownerOf(x.r)))].join(', ')}; any outside the workspace ask you first.`));
    if (unknown.length) out.push(bad('egress', `“${unknown[0]!.r.name}” names a worker Nova doesn’t have.`));
    else if (remote.length && privacy === 'local-only') out.push(bad('egress', `“${remote[0]!.r.name}” would send work off your devices, and your privacy setting is local-only.`));
    else out.push(ok('egress', remote.length ? 'Some of its work leaves your devices; your privacy setting allows it.' : 'Everything it does stays on your devices.'));
    out.push(ok('permissions', this.asks(a).join(' ')));
    out.push(privacyCheck(a));
    const tests = a.tests;
    if (!Array.isArray(tests) || !tests.length) out.push(bad('tests', 'A rule pack ships tests: when each rule should fire.'));
    else {
      const t = tests.find((x) => !isObj(x) || !isStr(x.name) || !isStr(x.at) || !isObj(x.expect) || !names.has(String(x.expect.rule)) || typeof x.expect.fires !== 'boolean');
      out.push(t ? bad('tests', `A test must be {name, at (an ISO time or HH:MM), expect: {rule (one of the pack’s), fires: true|false}}; ${JSON.stringify(t).slice(0, 120)} isn’t.`) : ok('tests', `${tests.length} test${tests.length === 1 ? '' : 's'} declared.`));
    }
    out.push(...ownProbe(a));
    return out;
  },
  tier(a) {
    const tasks = rulesOf(a).filter((r) => isObj(r.action) && r.action.kind === 'task');
    if (tasks.some((r) => (r.action as { task: { approval_tier?: number } }).task?.approval_tier === 3)) return 3;
    return tasks.length ? 2 : 1;
  },
  asks(a) {
    return rulesOf(a).map((r) => {
      let when = r.class === 'proactive' ? 'when Nova decides to' : '';
      try { if (r.class === 'heartbeat') when = describeCron(String(r.cron)); } catch { /* checked in the contract */ }
      const said = (t: string) => `“${t}”${/[.!?]$/.test(t) ? '' : '.'}`;
      if (isObj(r.action) && r.action.kind === 'message') return `${when}: sends you ${said(String(r.action.text).slice(0, 80))}`;
      // Everything that decides what the task does, so the OK is given on what would actually run.
      const t = (isObj(r.action) && isObj(r.action.task) ? r.action.task : {}) as { title?: unknown; owner?: unknown; approval_tier?: unknown; privacy_mode?: unknown; inputs?: unknown };
      const tier = typeof t.approval_tier === 'number' ? t.approval_tier : 1;
      return `${when}: starts “${String(t.title ?? 'a task')}”, run by ${String(t.owner)}, at tier ${tier} (${TIER_WORDS[tier] ?? 'unknown'}), privacy ${typeof t.privacy_mode === 'string' ? t.privacy_mode : 'as your setting says'}, with inputs ${JSON.stringify(t.inputs ?? {})}.`;
    });
  },
  async test(a, live) {
    const out: Check[] = [];
    const mine = live.triggers.listRules().filter((r) => r.created_by === packMark(packOf(a).id));
    out.push(mine.length === rulesOf(a).length ? ok('registry', `Nova lists all ${mine.length} of its rules.`) : bad('registry', `Nova lists ${mine.length} of its ${rulesOf(a).length} rules.`));
    const cases = ((a.tests ?? []) as PackTest[]).map((t) => ({ t, at: testTime(t.at, live) })).sort((x, y) => (x.at?.getTime() ?? 0) - (y.at?.getTime() ?? 0));
    for (const { t, at } of cases) {
      if (!at) { out.push(bad(t.name, `${t.name}: “${t.at}” isn’t a time.`)); continue; }
      const rule = mine.find((r) => r.name === t.expect.rule);
      if (!rule) { out.push(bad(t.name, `${t.name}: there is no rule “${t.expect.rule}”.`)); continue; }
      // Whatever was due before this moment runs first, so the tick at `at` is only this moment's.
      await live.triggers.tick(new Date(at.getTime() - 60_000));
      const fired = (await live.triggers.tick(at)).filter((x) => x.rule_id === rule.id && (x.triage.decision === 'act' || x.triage.decision === 'queue'));
      const messaged = fired.some((x) => x.message_id);
      const pass = fired.length > 0 === t.expect.fires && (t.expect.message !== true || messaged);
      out.push(pass
        ? ok(t.name, `${t.name}: at ${at.toISOString()} “${rule.name}” ${fired.length ? `fired${messaged ? ' and sent its message' : ''}` : 'stayed quiet'}, as expected.`)
        : bad(t.name, `${t.name}: at ${at.toISOString()} “${rule.name}” ${fired.length ? 'fired' : 'didn’t fire'}; it should${t.expect.fires ? '' : 'n’t'} have${t.expect.message && !messaged ? ', with a message' : ''}.`));
    }
    return out;
  },
  snapshot(a, live) {
    const rules = live.triggers.listRules().filter((r) => r.created_by === packMark(packOf(a).id));
    return { exists: rules.length > 0, rules: rules.map((r) => ({ name: r.name, class: r.class, ...(r.cron ? { cron: r.cron } : {}), action: r.action, dedup_window_s: r.dedup_window_s, cooldown_s: r.cooldown_s, paused: r.paused })) };
  },
  async apply(a, live) {
    reconcile(packOf(a).id, rulesOf(a).map((r) => ({ ...r, paused: false })), live);
  },
  async promote() { /* rules are live from the start of the canary; its first firings are what it watches */ },
  async restore(prev, a, live) {
    reconcile(packOf(a).id, (prev.rules ?? []) as (PackRule & { paused: boolean })[], live);
  },
  probe(a) { return isObj(a.probe) ? a.probe as unknown as Probe : null; },
  area() { return ['triggers']; },
};

// Makes the pack's rules exactly `want`: changed in place by name (their history stays with them),
// added, or removed. Nothing outside the pack is touched.
function reconcile(packId: string, want: (PackRule & { paused?: boolean })[], live: Live): void {
  const have = live.triggers.listRules().filter((r) => r.created_by === packMark(packId));
  for (const r of have) if (!want.some((w) => w.name === r.name)) live.triggers.deleteRule(r.id);
  for (const w of want) {
    const r = have.find((x) => x.name === w.name);
    const input = { name: w.name, class: w.class, ...(w.cron ? { cron: w.cron } : {}), action: w.action, ...(w.dedup_window_s !== undefined ? { dedup_window_s: w.dedup_window_s } : {}), ...(w.cooldown_s !== undefined ? { cooldown_s: w.cooldown_s } : {}) };
    const id = r ? (r.class === w.class ? live.triggers.updateRule(r.id, input).id : (live.triggers.deleteRule(r.id), live.triggers.createRule(input as RuleInput, packMark(packId)).rule.id))
      : live.triggers.createRule(input as RuleInput, packMark(packId)).rule.id;
    const now = live.triggers.rule(id);
    if (w.paused && !now.paused) live.triggers.pause(id);
    if (!w.paused && now.paused) live.triggers.resume(id);
  }
}

// ---- design systems --------------------------------------------------------------------------

const manifestOf = (a: Record<string, unknown>) => (isObj(a.manifest) ? a.manifest : {}) as Record<string, unknown>;

const designSystem: KindOps = {
  shape(a) {
    const m = manifestOf(a);
    need(isStr(m.id) && ID.test(m.id), 'A design system change carries its manifest, with an id.');
    need(m.kind === 'design-system', 'A design system’s manifest has kind design-system.');
    return { target: `design-system:${m.id}`, title: isStr(m.name) ? m.name : m.id as string, version: isStr(m.version) ? m.version : '0.0.0' };
  },
  contract(a) {
    const out: Check[] = [];
    try { validateManifest(manifestOf(a)); out.push(ok('manifest', 'Its manifest is complete.')); } catch (e) { out.push(bad('manifest', `Its manifest isn’t valid: ${((e as CoreError).details ?? []).join('; ') || (e as Error).message}`)); }
    out.push(ok('permissions', 'A design system asks for no permissions.'));
    out.push(ok('egress', 'It sends nothing anywhere: it is colours, type and spacing.'));
    out.push(privacyCheck(a));
    out.push(...ownProbe(a));
    return out;
  },
  tier() { return 1; },
  asks(a) { return [`Changes how Nova looks: ${String(manifestOf(a).name ?? manifestOf(a).id)}, on one device first, then everywhere.`]; },
  async test(a, live) {
    const m = manifestOf(a);
    const v = validatePackage(m);
    const out = [v.ok ? ok('validation', 'Complete, valid values, contrast holds in every mode, reduced motion honoured.') : bad('validation', `It doesn’t pass validation: ${v.problems.slice(0, 6).join(' ')}${v.problems.length > 6 ? ` (and ${v.problems.length - 6} more)` : ''}`)];
    try {
      const listed = live.design.get(String(m.id));
      out.push(listed.valid ? ok('installed', 'Nova lists it as valid and usable.') : bad('installed', `Nova lists it with problems: ${listed.problems.join(' ')}`));
    } catch (e) { out.push(bad('installed', (e as Error).message)); }
    return out;
  },
  snapshot(a, live, o) {
    const id = String(manifestOf(a).id);
    const x = live.extensions.list().find((e) => e.id === id);
    const ap = live.design.appearance();
    const device = o.device ?? null;
    // What the change can alter: the person's choice (on promotion) and the canary device's own.
    return {
      exists: !!x, manifest: x?.manifest ?? null, state: x?.state ?? null, device,
      appearance: { design_system: ap.design_system, previous: ap.previous, ...(device ? { override: ap.device_overrides[device] ?? null, device_previous: device in ap.device_previous ? ap.device_previous[device] ?? null : undefined } : {}) },
    };
  },
  async apply(a, live, o) {
    const m = manifestOf(a);
    const id = String(m.id);
    const x = live.extensions.list().find((e) => e.id === id);
    if (!x) live.design.install(m); else live.extensions.update(m);
    if (live.extensions.get(id).state === 'disabled') live.extensions.enable(id);
    if (o.scope === 'canary' && o.device) live.design.apply(id, { scope: 'device', device_id: o.device });
    else live.design.apply(id, { scope: 'user' });
  },
  async promote(a, live, o) {
    const id = String(manifestOf(a).id);
    live.design.apply(id, { scope: 'user' });
    // The canary device follows the person's choice again, as every other device does.
    if (o.device) {
      const ap = live.design.appearance();
      const overrides = { ...ap.device_overrides };
      if (overrides[o.device] === id) { delete overrides[o.device]; live.profile.set('appearance', 'device_overrides', overrides, 'settings'); }
    }
  },
  async restore(prev, a, live) {
    const id = String(manifestOf(a).id);
    // Only what this change set, and only where it is still this change's: a look the person chose
    // meanwhile, on any device or for everyone, stays.
    const was = (prev.appearance ?? {}) as { design_system?: string | null; previous?: string | null; override?: string | null; device_previous?: string | null };
    const now = live.design.appearance();
    if (now.design_system === id) {
      live.profile.set('appearance', 'design_system', was.design_system ?? null, 'settings');
      live.profile.set('appearance', 'previous', was.previous ?? null, 'settings');
    }
    const device = typeof prev.device === 'string' ? prev.device : null;
    // The canary device's own choice: this change's while it shows it, or gone since promotion
    // (which hands the device back to the person's choice).
    const own = device ? now.device_overrides[device] : undefined;
    if (device && (own === id || own === undefined)) {
      const overrides = { ...now.device_overrides };
      if (was.override) overrides[device] = was.override; else delete overrides[device];
      live.profile.set('appearance', 'device_overrides', overrides, 'settings');
      const previous = { ...now.device_previous };
      if (was.device_previous === undefined) delete previous[device]; else previous[device] = was.device_previous;
      live.profile.set('appearance', 'device_previous', previous, 'settings');
    }
    if (!prev.exists) { if (live.extensions.list().some((e) => e.id === id)) live.extensions.remove(id, { purge: true }); }
    else {
      live.extensions.update(prev.manifest);
      live.extensions.restoreState(id, prev.state as Installed['state']);
    }
    // Open pages fetch the stylesheet again.
    live.design.setMode(live.design.appearance().mode);
  },
  probe(a) { return isObj(a.probe) ? a.probe as unknown as Probe : null; },
  area() { return ['design']; },
};

// ---- extensions (skill packs, plugins, MCP servers: manifests and files, no code run) ------------

const EXTENSION_KINDS = ['skill-pack', 'plugin', 'mcp-server'];
const MAX_FILES = 50;
const MAX_FILE_BYTES = 256 * 1024;
const filesOf = (a: Record<string, unknown>) => (isObj(a.files) ? a.files : {}) as Record<string, string>;
const safeRel = (p: string) => /^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/.test(p) && !p.split('/').some((s) => s === '..' || s === '.');
interface ExtTest { name: string; file: string; contains?: string; json?: boolean; frontmatter?: string[] }

function inData(dir: string, rel: string): string {
  const abs = resolve(dir, rel);
  if (!abs.startsWith(dir + sep)) throw new CoreError('forbidden', `${rel} is outside the extension’s folder.`);
  return abs;
}

const sha256 = (b: Buffer) => createHash('sha256').update(b).digest('hex');

// Before a change writes its files: each path it will write, as it is now — its bytes copied aside
// and its hash kept (null when there is no such file). Only those paths: the rest of the folder is
// never read, so nothing else can come back different.
function keepAside(dir: string, paths: string[], aside: string): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  rmSync(aside, { recursive: true, force: true });
  for (const p of paths) {
    const abs = inData(dir, p);
    if (!existsSync(abs)) { out[p] = null; continue; }
    if (!statSync(abs).isFile()) throw new CoreError('conflict', `${p} is a folder in the extension’s data; a change writes files.`);
    const bytes = readFileSync(abs);
    const copy = join(aside, 'files', p);
    mkdirSync(dirname(copy), { recursive: true });
    writeFileSync(copy, bytes);
    out[p] = sha256(bytes);
  }
  return out;
}

// Puts back each path the change wrote, from the copies set aside: removed where there was none.
// A copy that doesn't hash as recorded isn't written: Nova says so instead of guessing.
function putBack(dir: string, files: Record<string, string | null>, aside: string): void {
  for (const [p, hash] of Object.entries(files)) {
    const abs = inData(dir, p);
    if (hash === null) { rmSync(abs, { force: true }); continue; }
    const bytes = readFileSync(join(aside, 'files', p));
    if (sha256(bytes) !== hash) throw new CoreError('conflict', `The copy of ${p} set aside before the change isn’t what it was.`);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, bytes);
  }
}

const extension: KindOps = {
  shape(a) {
    const m = manifestOf(a);
    need(isStr(m.id) && ID.test(m.id), 'An extension change carries its manifest, with an id.');
    need(EXTENSION_KINDS.includes(String(m.kind)), `Through the pipeline an extension is a ${EXTENSION_KINDS.join(', ')}; providers, connectors and design systems have their own way in.`);
    return { target: `extension:${m.id}`, title: isStr(m.name) ? m.name : m.id as string, version: isStr(m.version) ? m.version : '0.0.0' };
  },
  contract(a, privacy, live) {
    const out: Check[] = [];
    let m: Manifest | null = null;
    try { m = validateManifest(manifestOf(a)); out.push(ok('manifest', 'Its manifest is complete.')); } catch (e) { out.push(bad('manifest', `Its manifest isn’t valid: ${((e as CoreError).details ?? []).join('; ') || (e as Error).message}`)); }
    if (m && !satisfies(live.novaVersion, m.nova_compat)) out.push(bad('compatibility', `It needs Nova ${m.nova_compat}; this is ${live.novaVersion}.`));
    out.push(m ? ok('permissions', review(m).join(' ')) : bad('permissions', 'Without a valid manifest there is nothing to review.'));
    const net = (m?.permissions ?? []).filter((p) => p.kind === 'network');
    const remote = net.filter((p) => !/^(localhost|127\.0\.0\.1|\[?::1\]?)(:\d+)?$/.test(p.target));
    out.push(remote.length && privacy === 'local-only' ? bad('egress', `It would connect to ${remote.map((p) => p.target).join(', ')}, and your privacy setting is local-only.`) : ok('egress', net.length ? `It connects to ${net.map((p) => p.target).join(', ')}.` : 'It connects to nothing.'));
    const files = filesOf(a);
    const paths = Object.keys(files);
    const wrong = paths.filter((p) => !safeRel(p) || typeof files[p] !== 'string' || Buffer.byteLength(files[p]!) > MAX_FILE_BYTES);
    out.push(paths.length > MAX_FILES || wrong.length ? bad('files', paths.length > MAX_FILES ? `It carries ${paths.length} files; at most ${MAX_FILES}.` : `These files can’t be taken in: ${wrong.join(', ')} (plain relative paths, text up to ${MAX_FILE_BYTES / 1024} KB).`) : ok('files', `${paths.length} file${paths.length === 1 ? '' : 's'}, each inside its own folder.`));
    out.push(privacyCheck(a));
    const tests = a.tests;
    if (!Array.isArray(tests) || !tests.length) out.push(bad('tests', 'An extension ships tests.'));
    else {
      const t = tests.find((x) => !isObj(x) || !isStr(x.name) || !isStr(x.file) || (x.contains === undefined && x.json !== true && !Array.isArray(x.frontmatter)));
      out.push(t ? bad('tests', `A test is {name, file, contains | json: true | frontmatter: [keys]}; ${JSON.stringify(t).slice(0, 120)} isn’t.`) : ok('tests', `${tests.length} test${tests.length === 1 ? '' : 's'} declared.`));
    }
    const hp = isObj(manifestOf(a).health_check) ? (manifestOf(a).health_check as Record<string, unknown>).probe : undefined;
    if (hp !== undefined) { const p = probeProblems(hp); out.push(p.length ? bad('probe', `Its health check probe isn’t valid: ${p.join(' ')}`) : ok('probe', 'Its health check probe is valid.')); }
    out.push(...ownProbe(a));
    return out;
  },
  tier(a, live) {
    const m = manifestOf(a);
    const perms = Array.isArray(m.permissions) ? m.permissions as Manifest['permissions'] : [];
    const installed = live.extensions.list().find((x) => x.id === m.id);
    // Asking for more than the installed version had is a permission change: confirmed every time.
    if (installed && perms.some((p) => !installed.manifest.permissions.some((q) => q.kind === p.kind && q.target === p.target))) return 3;
    return perms.length ? 2 : 1;
  },
  asks(a) {
    try { return review(validateManifest(manifestOf(a))); } catch { return ['Its manifest isn’t valid.']; }
  },
  async test(a, live) {
    const id = String(manifestOf(a).id);
    const out: Check[] = [];
    let state = '';
    try { state = live.extensions.get(id).state; } catch { /* reported below */ }
    out.push(state === 'enabled' ? ok('installed', 'Nova lists it, enabled.') : bad('installed', `Nova lists it as ${state || 'missing'}.`));
    const dir = live.extensions.dataDir(id);
    for (const t of (a.tests ?? []) as ExtTest[]) {
      let text: string | null = null;
      try { const abs = inData(dir, t.file); text = existsSync(abs) ? readFileSync(abs, 'utf8') : null; } catch (e) { out.push(bad(t.name, `${t.name}: ${(e as Error).message}`)); continue; }
      if (text === null) { out.push(bad(t.name, `${t.name}: ${t.file} isn’t there.`)); continue; }
      if (typeof t.contains === 'string' && !text.includes(t.contains)) { out.push(bad(t.name, `${t.name}: ${t.file} doesn’t say “${t.contains.slice(0, 60)}”.`)); continue; }
      if (t.json) { try { JSON.parse(text); } catch { out.push(bad(t.name, `${t.name}: ${t.file} isn’t valid JSON.`)); continue; } }
      if (Array.isArray(t.frontmatter)) {
        const fm = /^---\n([\s\S]*?)\n---/.exec(text)?.[1] ?? '';
        const missing = t.frontmatter.filter((k) => !new RegExp(`^${k.replace(/[^a-z0-9_-]/gi, '')}:\\s*\\S`, 'm').test(fm));
        if (missing.length) { out.push(bad(t.name, `${t.name}: ${t.file} has no ${missing.join(', ')} in its front matter.`)); continue; }
      }
      out.push(ok(t.name, `${t.name}: passed.`));
    }
    return out;
  },
  snapshot(a, live, o) {
    const id = String(manifestOf(a).id);
    const x = live.extensions.list().find((e) => e.id === id);
    return { exists: !!x, manifest: x?.manifest ?? null, state: x?.state ?? null, files: x ? keepAside(live.extensions.dataDir(id), Object.keys(filesOf(a)), o.aside) : {} };
  },
  async apply(a, live) {
    const m = manifestOf(a);
    const id = String(m.id);
    if (!live.extensions.list().some((e) => e.id === id)) live.extensions.install(m); else live.extensions.update(m);
    writeFiles(live.extensions.dataDir(id), filesOf(a));
    // Its permissions were shown with the approval this change got.
    live.extensions.enable(id, { approved: true });
  },
  async promote() { /* enabled since the canary began; the canary was its window */ },
  async restore(prev, a, live, o) {
    const id = String(manifestOf(a).id);
    // It wasn't there before: it goes, as if never installed (nothing of it was the person's to keep).
    if (!prev.exists) { if (live.extensions.list().some((e) => e.id === id)) live.extensions.remove(id, { purge: true }); return; }
    live.extensions.update(prev.manifest);
    putBack(live.extensions.dataDir(id), (prev.files ?? {}) as Record<string, string | null>, o.aside);
    live.extensions.restoreState(id, prev.state as Installed['state']);
  },
  probe(a) {
    const hc = manifestOf(a).health_check;
    if (isObj(hc) && isObj(hc.probe)) return hc.probe as unknown as Probe;
    return isObj(a.probe) ? a.probe as unknown as Probe : null;
  },
  area(a) { return ['extensions', String(manifestOf(a).id)]; },
};

function writeFiles(dir: string, files: Record<string, string>): void {
  for (const [p, text] of Object.entries(files)) {
    const abs = inData(dir, p);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, text);
  }
}

// ---- config: one profile setting --------------------------------------------------------------

// Settings with checked routes of their own (providers, capture, models, appearance, mesh) go
// through those; setup is the conversation's.
const CONFIG_SECTIONS: readonly Section[] = ['identity', 'user', 'tuning', 'privacy', 'policy'];
// Security and permissions: confirmed every time.
const CORE_SECTIONS: readonly Section[] = ['privacy', 'policy'];

const config: KindOps = {
  shape(a) {
    need(isStr(a.section) && isStr(a.key), 'A setting change is {section, key, value}.');
    need((CONFIG_SECTIONS as readonly string[]).includes(String(a.section)), `Through the pipeline a setting is in ${CONFIG_SECTIONS.join(', ')}; the others are changed where they are checked (Settings).`);
    need(/^[a-z][a-z0-9_.-]{0,63}$/.test(String(a.key)), 'A setting’s key is lowercase letters, digits, dots, dashes or underscores.');
    need(a.value !== undefined, 'A setting change carries the new value.');
    return { target: `config:${a.section}.${a.key}`, title: `${a.section} › ${a.key}`, version: isStr(a.version) ? a.version : new Date().toISOString().slice(0, 10) };
  },
  contract(a) {
    const out: Check[] = [];
    const problems: string[] = [];
    if (a.section === 'privacy' && a.key === 'default' && !PRIVACY_MODES.includes(a.value as PrivacyMode)) problems.push(`privacy.default is one of ${PRIVACY_MODES.join(', ')}.`);
    if (a.section === 'policy' && a.key === 'quiet_hours' && a.value !== null && !(isObj(a.value) && /^\d\d:\d\d$/.test(String(a.value.start)) && /^\d\d:\d\d$/.test(String(a.value.end)))) problems.push('policy.quiet_hours is {start: "HH:MM", end: "HH:MM"} or null.');
    if (a.section === 'policy' && a.key === 'task_tests') problems.push('policy.task_tests is set through Settings › Providers.');
    if (JSON.stringify(a.value).length > 16_000) problems.push('The value is too large for a setting.');
    out.push(problems.length ? bad('manifest', problems.join(' ')) : ok('manifest', 'The value fits the setting.'));
    out.push(ok('permissions', this.asks(a).join(' ')));
    out.push(ok('egress', 'A setting sends nothing anywhere.'));
    out.push(privacyCheck(a));
    out.push(...ownProbe(a));
    return out;
  },
  tier(a) { return (CORE_SECTIONS as readonly string[]).includes(String(a.section)) ? 3 : 1; },
  asks(a) { return [`Sets ${a.section} › ${a.key} to ${JSON.stringify(a.value).slice(0, 80)}.`]; },
  async test(a, live) {
    const got = live.profile.get(a.section as Section, String(a.key));
    return [JSON.stringify(got) === JSON.stringify(a.value) ? ok('read-back', 'Nova read the setting back as set.') : bad('read-back', `Nova read back ${JSON.stringify(got)}.`)];
  },
  snapshot(a, live) {
    const row = live.db.get<{ value: string }>('SELECT value FROM profile WHERE section = ? AND key = ?', String(a.section), String(a.key));
    return { exists: !!row, value: row ? JSON.parse(row.value) : null };
  },
  async apply(a, live) { live.profile.set(a.section as Section, String(a.key), a.value, 'settings'); },
  async promote() { /* a setting is whole from the start; the canary is its watch window */ },
  async restore(prev, a, live) {
    if (prev.exists) live.profile.set(a.section as Section, String(a.key), prev.value, 'settings');
    else {
      live.db.run('DELETE FROM profile WHERE section = ? AND key = ?', String(a.section), String(a.key));
      live.profile.emit('change', { section: a.section, key: a.key });
    }
  },
  probe(a) { return isObj(a.probe) ? a.probe as unknown as Probe : null; },
  area(a) { return [String(a.section)]; },
};

// ---- decision templates -------------------------------------------------------------------------

const defOf = (a: Record<string, unknown>) => a.template as TemplateDef;

const template: KindOps = {
  shape(a) {
    const t = a.template;
    need(isObj(t) && isStr(t.template_id) && Number.isInteger(t.version), 'A template change is {template: {template_id, version, …}, dry_runs: [...]}.');
    const d = t as unknown as TemplateDef;
    return { target: `template:${d.template_id}`, title: `Decision: ${d.template_id}`, version: String(d.version) };
  },
  contract(a, _privacy, _live) {
    const out: Check[] = [];
    try { validateTemplate(a.template); out.push(ok('manifest', 'It matches the decision template contract.')); } catch (e) { out.push(bad('manifest', `It doesn’t match the template contract: ${((e as CoreError).details ?? []).join('; ') || (e as Error).message}`)); }
    const runs = a.dry_runs;
    out.push(Array.isArray(runs) && runs.length && runs.every((c) => isObj(c) && isObj(c.inputs)) ? ok('tests', `${runs.length} dry run${runs.length === 1 ? '' : 's'} declared.`) : bad('tests', 'A template ships its dry runs: [{inputs, expect?}].'));
    out.push(ok('permissions', this.asks(a).join(' ')));
    out.push(ok('egress', 'A template decides nothing by itself; System 1 asks it, inside the privacy setting.'));
    out.push(privacyCheck(a));
    out.push(...ownProbe(a));
    return out;
  },
  // The ingest gate's screen is a security gate: any change to it is tier 3 (gates.ts refuses one
  // that drops or changes its questions).
  tier(a) { return GATE_TEMPLATES.has(String(defOf(a).template_id)) ? 3 : 1; },
  asks(a) { const d = defOf(a); return [`Lets System 1 decide “${String(d.situation ?? d.template_id).slice(0, 100)}”.`]; },
  async test(a, live) {
    const d = defOf(a);
    const t = live.templates.version(d.template_id, d.version);
    if (!t) return [bad('dry runs', 'The template isn’t there.')];
    // Applying it ran the dry runs and activated it through the ledger, which re-ran them itself.
    const task = t.activation_task_id ? live.ledger.get(t.activation_task_id) : null;
    return [t.state === 'active' && task?.state === 'done'
      ? ok('dry runs', `All ${t.dry_runs.length} dry runs passed, and Nova re-ran them itself to activate it.`)
      : bad('dry runs', `It didn’t activate: ${task?.reason ?? t.state}.`)];
  },
  snapshot(a, live) {
    const cur = live.templates.get(defOf(a).template_id);
    return { exists: !!cur, version: cur?.version ?? null };
  },
  async apply(a, live, o) {
    const d = defOf(a);
    if (!live.templates.version(d.template_id, d.version)) live.templates.propose(d, o.by);
    const t = live.templates.version(d.template_id, d.version)!;
    if (t.state !== 'draft') return;
    live.templates.dryRun(d.template_id, d.version, a.dry_runs as DryRunCase[]);
    const task = live.templates.activate(d.template_id, d.version);
    // Activation is the ledger's own verified task; it is in use once that is done.
    for (let i = 0; i < 400; i++) {
      const s = live.ledger.get(task.id).state;
      if (s === 'done') return;
      if (s === 'failed' || s === 'cancelled') throw new CoreError('conflict', `Activating ${d.template_id} v${d.version} ${s}: ${live.ledger.get(task.id).reason ?? ''}`);
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new CoreError('conflict', `Activating ${d.template_id} v${d.version} took too long.`);
  },
  async promote() { /* in use since the canary began */ },
  async restore(prev, a, live) {
    const d = defOf(a);
    live.templates.reinstate(d.template_id, prev.exists ? prev.version as number : null, d.version, 'Rolled back by the change pipeline.');
  },
  probe(a) { return isObj(a.probe) ? a.probe as unknown as Probe : null; },
  area() { return ['decide', 'templates']; },
};

export const KIND_OPS: Readonly<Record<ChangeKind, KindOps>> = Object.freeze({
  'trigger-rules': triggerRules,
  'design-system': designSystem,
  extension,
  config,
  template,
});
