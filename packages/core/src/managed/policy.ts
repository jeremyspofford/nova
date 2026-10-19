// The managed policy service (FR-106, docs/12 §10, ADR-097 D4). It reads the OS-protected local
// file and the signed remote policy the file names, keeps the last good policy of each, and gives
// the Hub two things: the managed settings layer (`settingsLayer`, locked in every view) and the
// restrictions (`restrictions()`, also carried in that layer as `managed.restrict`).
//
// Rules: sources, highest first, are the remote policy and the local file; both apply, and where
// both set something the more restrictive value wins (a non-security setting takes the remote
// value). A security setting takes the tighter of the policy's value and the user's; a policy value
// looser than the key's default is ignored and reported. Restrictions imply settings (Bypass off,
// the egress ceiling, telemetry export, cloud models, SSH, apps). A trusted source that does not
// parse or validate fails closed: agent tools are denied until it is fixed, and the source's last
// good policy stays in force; an ignored file or a refused remote policy also keeps the last good
// one. Every change after the first load is announced: `managed.policy.changed`, and
// `settings.changed` (scope `managed`) for each setting whose policy value changed.
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import {
  SETTINGS,
  isSettingKey,
  type ManagedChannel,
  type ManagedIgnoredView,
  type ManagedPolicyDocument,
  type ManagedPolicyView,
  type ManagedRemote,
  type ManagedRestrict,
  type ManagedRestrictSetting,
  type ManagedSettingView,
  type ManagedSourceStatus,
  type ManagedSourceView,
  type SettingDefinition,
} from '@nova/shared';
import { Logger } from '@nova/telemetry';
import type { EventSink } from '../events.ts';
import { ManagedRestrictions } from './restrictions.ts';
import { meet, ruleFor, securityValueProblem, tightenSetting } from './rules.ts';
import {
  checkProtectedFile,
  fetchManagedEnvelope,
  managedEnvelopeSchema,
  nodeManagedFs,
  parseManagedPolicy,
  verifyManagedEnvelope,
  type ManagedFetch,
  type ManagedFs,
} from './source.ts';

/** The settings key whose value is the restrictions (never set by a user). */
export const MANAGED_RESTRICT_KEY = 'managed.restrict';
/** The non-setting key of the layer that carries managed hooks (docs/08 §4). */
export const MANAGED_HOOKS_KEY = 'hooks';
const TRUSTED_PUBLISHERS_KEY = 'plugins.trustedPublishers';
const CACHE_FILE = 'remote-policy.json';
const DEFAULT_REFRESH_MINUTES = 60;

export interface ManagedPolicyOptions {
  /** The OS-protected local policy file (`resolveManagedPath`); always read. */
  path: string;
  /**
   * Tests only (`resolveManagedPath`): a policy file layered over the protected one, owned by the
   * Hub's user. Like every source it can only add restrictions; it never replaces the protected
   * file, so a Hub started with the test flag still obeys its administrator.
   */
  testPath?: string | null;
  /** Reported with the local source when an override was refused. */
  overrideRefused?: string | null;
  /** Where the last good remote policy is kept (0700). */
  cacheDir: string;
  platform?: NodeJS.Platform;
  fs?: ManagedFs;
  /** The user the Hub runs as (default: this process's). */
  hubUid?: number | null;
  fetch?: ManagedFetch;
  fetchTimeoutMs?: number;
  /** Tests: a remote policy over plain http to 127.0.0.1. */
  allowInsecureRemote?: boolean;
  /** `~` in folder rules. */
  home?: string;
  events?: EventSink;
  log?: Logger;
  now?: () => Date;
}

interface SourceState {
  status: ManagedSourceStatus;
  problem: string | null;
  /** The policy in force from this source (the last good one). */
  doc: ManagedPolicyDocument | null;
  cached: boolean;
  loadedAt: string | null;
  checkedAt: string;
  /** Why this trusted source fails closed (it did not parse or validate). */
  failClosed: string | null;
}

interface Entry {
  value: unknown;
  channel: ManagedChannel | 'both';
  derivedFrom: string | null;
}

interface Compiled {
  settings: Map<string, Entry>;
  layers: { channel: ManagedChannel; restrict: ManagedRestrict }[];
  hooks: unknown;
  ignored: ManagedIgnoredView[];
}

const cacheSchema = z
  .object({ url: z.string(), publicKey: z.string(), fetchedAt: z.string(), envelope: z.unknown() })
  .strict();

function isSecurityKey(key: string): boolean {
  return isSettingKey(key) && (SETTINGS[key] as SettingDefinition).security === true;
}

/**
 * The settings, restrictions and managed hooks of the sources in force, remote first. Values
 * that cannot apply are left out and reported.
 */
export function compileManaged(
  sources: { channel: ManagedChannel; doc: ManagedPolicyDocument }[],
): Compiled {
  const settings = new Map<string, Entry>();
  const ignored: ManagedIgnoredView[] = [];
  let hooks: unknown;
  const add = (channel: ManagedChannel, key: string, value: unknown, from: string | null) => {
    const cur = settings.get(key);
    if (!cur) {
      settings.set(key, { value, channel, derivedFrom: from });
      return;
    }
    const rule = isSecurityKey(key) ? ruleFor(key) : null;
    // Two security values: the more restrictive one. Anything else: the higher source's.
    if (rule) cur.value = meet(rule, cur.value, value);
    if (cur.channel !== channel) cur.channel = 'both';
    if (!from) cur.derivedFrom = null;
  };
  for (const { channel, doc } of sources) {
    for (const [key, raw] of Object.entries(doc.settings ?? {})) {
      if (key === MANAGED_HOOKS_KEY) {
        hooks ??= raw;
        continue;
      }
      if (!isSettingKey(key) || key === MANAGED_RESTRICT_KEY) {
        ignored.push({
          channel,
          key,
          reason: 'unknown_key',
          message:
            key === MANAGED_RESTRICT_KEY
              ? `${key} is set through the policy's restrict block`
              : `${key} is not a Nova setting`,
        });
        continue;
      }
      const parsed = (SETTINGS[key] as SettingDefinition).schema.safeParse(raw);
      if (!parsed.success) {
        ignored.push({
          channel,
          key,
          reason: 'invalid_value',
          message: `${key}: ${parsed.error.issues.map((i) => i.message).join('; ')}`,
        });
        continue;
      }
      if (isSecurityKey(key)) {
        const problem = securityValueProblem(key, parsed.data);
        if (problem) {
          ignored.push({ channel, key, ...problem });
          continue;
        }
      }
      add(channel, key, parsed.data, null);
    }
    const r = doc.restrict;
    if (!r) continue;
    for (const [key, value, from] of impliedSettings(r)) add(channel, key, value, from);
    const modes = r.permissionModes;
    if (
      modes &&
      (modes.deny?.includes('manual') || (modes.allow && !modes.allow.includes('manual')))
    )
      ignored.push({
        channel,
        key: 'restrict.permissionModes',
        reason: 'manual_mode',
        message: 'Manual mode cannot be turned off: every refused mode falls back to it',
      });
  }
  const layers = sources.flatMap(({ channel, doc }) =>
    doc.restrict ? [{ channel, restrict: doc.restrict }] : [],
  );
  return { settings, layers, hooks, ignored };
}

/** The settings a `restrict` block implies, with the part they come from. */
function impliedSettings(r: ManagedRestrict): [string, unknown, string][] {
  const out: [string, unknown, string][] = [];
  const checks = new ManagedRestrictions({ layers: [r], failClosed: null });
  if (r.permissionModes && checks.permissionMode('bypass')) {
    out.push(['code.allowBypass', false, 'restrict.permissionModes']);
    // Chats never run without asking (Bypass's policy), nor under review when Auto is off too.
    out.push([
      'tools.approvalPolicy',
      checks.permissionMode('auto') ? 'defaults' : 'review',
      'restrict.permissionModes',
    ]);
  }
  // Any egress restriction also takes away the cloud runner's unrestricted network, which would
  // bypass the proxy and every list (FR-108).
  if (r.egress) out.push(['cloud.runner.unrestrictedNetwork', false, 'restrict.egress']);
  if (r.egress?.mode) out.push(['network.egressMode', r.egress.mode, 'restrict.egress']);
  if (r.egress?.allow) out.push(['network.egressAllow', r.egress.allow, 'restrict.egress']);
  if (r.egress?.deny) out.push(['network.egressDeny', r.egress.deny, 'restrict.egress']);
  if (r.telemetryExport === false && isSettingKey('telemetry.otlp.enabled'))
    out.push(['telemetry.otlp.enabled', false, 'restrict.telemetryExport']);
  if (r.routing?.allowCloud === false) out.push(['routing.allowCloud', false, 'restrict.routing']);
  if (r.sessions?.ssh === false) out.push(['code.ssh.enabled', false, 'restrict.sessions']);
  if (r.unverifiedInstalls === false && isSettingKey('market.allowSideload'))
    out.push(['market.allowSideload', false, 'restrict.unverifiedInstalls']);
  if (r.apps === false) {
    if (isSettingKey('apps.enabled')) out.push(['apps.enabled', false, 'restrict.apps']);
    out.push(['mcpServer.enabled', false, 'restrict.apps']);
  }
  return out;
}

export class ManagedPolicy {
  readonly #o: ManagedPolicyOptions;
  readonly #fs: ManagedFs;
  readonly #log: Logger;
  readonly #now: () => Date;
  readonly #hubUid: number | null;
  #local: SourceState;
  #test: SourceState | null = null;
  #remote: SourceState | null = null;
  #remoteConfig: ManagedRemote | null = null;
  #compiled: Compiled = compileManaged([]);
  #restrictions: ManagedRestrictions;
  #fingerprint = '';
  #loaded = false;
  #chain: Promise<unknown> = Promise.resolve();
  #timer: ReturnType<typeof setInterval> | null = null;
  #timerMinutes = 0;
  #started = false;
  readonly #listeners = new Set<() => void>();

  constructor(opts: ManagedPolicyOptions) {
    this.#o = opts;
    this.#fs = opts.fs ?? nodeManagedFs;
    this.#log = opts.log ?? new Logger({ module: 'core.managed', sinks: [] });
    this.#now = opts.now ?? (() => new Date());
    this.#hubUid = opts.hubUid === undefined ? (process.getuid?.() ?? null) : opts.hubUid;
    this.#local = this.#emptySource();
    this.#restrictions = this.#makeRestrictions();
  }

  #emptySource(): SourceState {
    return {
      status: 'absent',
      problem: null,
      doc: null,
      cached: false,
      loadedAt: null,
      checkedAt: this.#now().toISOString(),
      failClosed: null,
    };
  }

  #makeRestrictions(): ManagedRestrictions {
    return new ManagedRestrictions(this.restrictSetting(), {
      home: this.#o.home ?? homedir(),
    });
  }

  // ---- reading ---------------------------------------------------------------------------------

  /** Read the local file and fetch the remote policy (the Hub's startup and the reload route). */
  reload(): Promise<ManagedPolicyView> {
    const run = this.#chain.then(async () => {
      this.#local = await this.#readFile(this.#o.path, this.#local, 0);
      if (this.#local.status === 'absent' && this.#o.overrideRefused)
        this.#local = { ...this.#local, problem: this.#o.overrideRefused };
      this.#test = this.#o.testPath
        ? await this.#readFile(
            this.#o.testPath,
            this.#test ?? this.#emptySource(),
            this.#hubUid ?? 0,
          )
        : null;
      await this.#readRemote();
      this.#apply();
      return this.view();
    });
    this.#chain = run.catch(() => undefined);
    return run;
  }

  /** The first read; the same as `reload`. */
  load(): Promise<ManagedPolicyView> {
    return this.reload();
  }

  /** Fetch the remote policy again (the refresh timer). */
  refreshRemote(): Promise<ManagedPolicyView> {
    const run = this.#chain.then(async () => {
      await this.#readRemote();
      this.#apply();
      return this.view();
    });
    this.#chain = run.catch(() => undefined);
    return run;
  }

  /**
   * Read one policy file: the protected one (owned by root, `ownerUid` 0) or the test one (owned by
   * the Hub's user). An ignored or invalid file keeps the last good policy of that file.
   */
  async #readFile(path: string, prev: SourceState, ownerUid: number): Promise<SourceState> {
    const now = this.#now().toISOString();
    const check = await checkProtectedFile(path, {
      fs: this.#fs,
      ...(this.#o.platform ? { platform: this.#o.platform } : {}),
      ownerUid,
      hubUid: this.#hubUid,
    });
    // The administrator removed the file: nothing of it stays.
    if (check.status === 'absent') return this.#emptySource();
    if (check.status === 'ignored') {
      this.#log.warn('managed policy file ignored', { path, problem: check.problem });
      return {
        ...prev,
        status: 'ignored',
        problem: check.problem,
        checkedAt: now,
        failClosed: null,
      };
    }
    let bytes: Buffer;
    try {
      bytes = await this.#fs.readFile(check.realPath);
    } catch (err) {
      const problem = `the file cannot be read (${(err as NodeJS.ErrnoException).code ?? 'error'})`;
      return { ...prev, status: 'invalid', problem, checkedAt: now, failClosed: problem };
    }
    const parsed = parseManagedPolicy(bytes);
    if (!parsed.ok) {
      this.#log.error('managed policy file is invalid; agent tools are denied', {
        path,
        problem: parsed.problem,
      });
      return {
        ...prev,
        status: 'invalid',
        problem: parsed.problem,
        checkedAt: now,
        failClosed: `the policy file ${path} is invalid: ${parsed.problem}`,
      };
    }
    return {
      status: 'active',
      problem: check.note,
      doc: parsed.doc,
      cached: false,
      loadedAt: now,
      checkedAt: now,
      failClosed: null,
    };
  }

  async #readRemote(): Promise<void> {
    // The protected file names the remote policy; under the test flag the test file may.
    const remote = this.#local.doc?.remote ?? this.#test?.doc?.remote ?? null;
    const now = this.#now().toISOString();
    const changed =
      !remote ||
      !this.#remoteConfig ||
      remote.url !== this.#remoteConfig.url ||
      remote.publicKey !== this.#remoteConfig.publicKey ||
      remote.minSerial !== this.#remoteConfig.minSerial;
    this.#remoteConfig = remote;
    if (!remote) {
      this.#remote = null;
      return;
    }
    // A new URL or key: what was in force under the old one is dropped; the cache is checked
    // against the new pin before it counts.
    if (changed || !this.#remote) {
      this.#remote = { ...this.#emptySource(), checkedAt: now };
      const cached = await this.#readCache(remote);
      if (cached)
        this.#remote = {
          ...this.#remote,
          doc: cached.doc,
          cached: true,
          loadedAt: cached.fetchedAt,
        };
    }
    const prev = this.#remote;
    const fetched = await fetchManagedEnvelope(remote, {
      ...(this.#o.fetch ? { fetch: this.#o.fetch } : {}),
      ...(this.#o.fetchTimeoutMs ? { timeoutMs: this.#o.fetchTimeoutMs } : {}),
      allowInsecure: this.#o.allowInsecureRemote === true,
    });
    const keep = (
      status: ManagedSourceStatus,
      problem: string,
      failClosed: string | null = null,
    ) => {
      this.#log.warn('remote managed policy not applied', { url: remote.url, status, problem });
      this.#remote = { ...prev, status, problem, checkedAt: now, failClosed };
    };
    if (!fetched.ok) {
      keep('unreachable', fetched.problem);
      return;
    }
    const verified = verifyManagedEnvelope(fetched.body, remote.publicKey);
    if (!verified.ok) {
      keep('refused', verified.problem);
      return;
    }
    const parsed = parseManagedPolicy(verified.bytes);
    const problem = !parsed.ok
      ? parsed.problem
      : parsed.doc.remote
        ? 'a remote policy cannot name another remote policy'
        : null;
    if (!parsed.ok || problem) {
      keep('invalid', problem!, `the remote policy is invalid: ${problem!}`);
      return;
    }
    // Never older than the policy in force, nor than the floor the protected file sets.
    const floor = Math.max(prev.doc?.serial ?? 0, remote.minSerial ?? 0);
    if ((parsed.doc.serial ?? 0) < floor) {
      keep(
        'refused',
        `its serial ${parsed.doc.serial ?? 0} is older than ${floor}, the oldest it may be`,
      );
      return;
    }
    this.#remote = {
      status: 'active',
      problem: null,
      doc: parsed.doc,
      cached: false,
      loadedAt: now,
      checkedAt: now,
      failClosed: null,
    };
    await this.#writeCache(remote, fetched.body, now);
  }

  async #readCache(
    remote: ManagedRemote,
  ): Promise<{ doc: ManagedPolicyDocument; fetchedAt: string } | null> {
    let raw: unknown;
    try {
      raw = JSON.parse(await readFile(join(this.#o.cacheDir, CACHE_FILE), 'utf8'));
    } catch {
      return null;
    }
    const c = cacheSchema.safeParse(raw);
    if (!c.success || c.data.url !== remote.url || c.data.publicKey !== remote.publicKey)
      return null;
    // The copy on disk is checked again: a changed file never counts.
    const verified = verifyManagedEnvelope(c.data.envelope, remote.publicKey);
    if (!verified.ok) {
      this.#log.warn('cached remote managed policy does not verify; ignored');
      return null;
    }
    const parsed = parseManagedPolicy(verified.bytes);
    if (!parsed.ok || parsed.doc.remote) return null;
    // The cache sits in a folder the Hub can write: an older copy than the protected file's
    // floor (a rollback by swapping the cache) never counts.
    if ((parsed.doc.serial ?? 0) < (remote.minSerial ?? 0)) {
      this.#log.warn('cached remote managed policy is older than minSerial; ignored');
      return null;
    }
    return { doc: parsed.doc, fetchedAt: c.data.fetchedAt };
  }

  async #writeCache(remote: ManagedRemote, envelope: unknown, at: string): Promise<void> {
    try {
      await mkdir(this.#o.cacheDir, { recursive: true, mode: 0o700 });
      const file = join(this.#o.cacheDir, CACHE_FILE);
      const tmp = `${file}.tmp`;
      const body = {
        url: remote.url,
        publicKey: remote.publicKey,
        fetchedAt: at,
        envelope: managedEnvelopeSchema.parse(envelope),
      };
      await writeFile(tmp, JSON.stringify(body), { mode: 0o600 });
      await rename(tmp, file);
    } catch (err) {
      this.#log.warn('the remote managed policy could not be cached', { err });
    }
  }

  /** Compile what is in force; announce a change (never the first load). */
  #apply(): void {
    const sources: { channel: ManagedChannel; doc: ManagedPolicyDocument }[] = [];
    if (this.#remote?.doc) sources.push({ channel: 'remote', doc: this.#remote.doc });
    if (this.#local.doc) sources.push({ channel: 'local', doc: this.#local.doc });
    if (this.#test?.doc) sources.push({ channel: 'test', doc: this.#test.doc });
    const before = this.#compiled;
    const beforeRestrict = this.restrictSetting();
    this.#compiled = compileManaged(sources);
    this.#restrictions = this.#makeRestrictions();
    const fingerprint = JSON.stringify({
      s: [...this.#compiled.settings.entries()].map(([k, e]) => [k, e.value]),
      r: this.restrictSetting(),
      h: this.#compiled.hooks ?? null,
    });
    const first = !this.#loaded;
    this.#loaded = true;
    this.#retime();
    if (fingerprint === this.#fingerprint) return;
    this.#fingerprint = fingerprint;
    if (first) return;
    for (const fn of this.#listeners) {
      try {
        fn();
      } catch (err) {
        this.#log.warn('managed policy listener failed', { err });
      }
    }
    void this.#announce(before, beforeRestrict).catch((err: unknown) =>
      this.#log.warn('managed policy change not announced', { err }),
    );
  }

  async #announce(before: Compiled, beforeRestrict: ManagedRestrictSetting): Promise<void> {
    const events = this.#o.events;
    if (!events) return;
    await events.emit({
      name: 'managed.policy.changed',
      actor: 'system',
      payload: {
        active: this.#active(),
        failClosed: this.failClosed !== null,
        sources: this.#sourceViews().map((s) => ({ channel: s.channel, status: s.status })),
      },
    });
    const keys = new Set([...before.settings.keys(), ...this.#compiled.settings.keys()]);
    for (const key of keys) {
      const a = before.settings.get(key)?.value ?? null;
      const b = this.#compiled.settings.get(key)?.value ?? null;
      if (JSON.stringify(a) === JSON.stringify(b)) continue;
      await events.emit({
        name: 'settings.changed',
        actor: 'system',
        payload: { key, scope: 'managed', before: a, after: b },
      });
    }
    const after = this.restrictSetting();
    if (JSON.stringify(after) !== JSON.stringify(beforeRestrict))
      await events.emit({
        name: 'settings.changed',
        actor: 'system',
        payload: { key: MANAGED_RESTRICT_KEY, scope: 'managed', before: beforeRestrict, after },
      });
  }

  // ---- what applies -----------------------------------------------------------------------------

  /** Why the policy fails closed (a trusted source did not parse or validate), or null. */
  get failClosed(): string | null {
    const why = [
      this.#local.failClosed,
      this.#test?.failClosed ?? null,
      this.#remote?.failClosed ?? null,
      // A pinned remote policy that never verified (no cached copy, no good fetch) may hold
      // restrictions nobody has seen yet: fail closed until it does.
      this.#remoteConfig && this.#remote && !this.#remote.doc && !this.#remote.failClosed
        ? `the remote policy at ${this.#remoteConfig.url} has not been verified yet`
        : null,
    ].filter((x): x is string => !!x);
    return why.length ? why.join('; ') : null;
  }

  #active(): boolean {
    return Boolean(this.#local.doc || this.#test?.doc || this.#remote?.doc || this.failClosed);
  }

  /** The `managed.restrict` value: every restrict block in force, and the fail-closed reason. */
  restrictSetting(): ManagedRestrictSetting {
    return {
      layers: this.#compiled.layers.map((l) => l.restrict),
      failClosed: this.failClosed,
    };
  }

  /** The checks every area makes (typed getters over the restrictions in force). */
  restrictions(): ManagedRestrictions {
    return this.#restrictions;
  }

  /**
   * The managed settings layer (docs/14 §1): every setting the policy sets, a security one as the
   * tighter of the policy's value and the user's global one; tool roots filtered by the folder
   * rules; the restrictions (`managed.restrict`, always present, so no user ever sets it); and
   * the managed hooks (`hooks`).
   */
  settingsLayer(global?: Partial<Record<string, unknown>>): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [key, e] of this.#compiled.settings)
      out[key] = isSecurityKey(key) ? tightenSetting(key, e.value, global?.[key]) : e.value;
    const checks = this.#restrictions;
    if (checks.restrictsFolders) {
      const def = SETTINGS['tools.roots'];
      const base = out['tools.roots'] ?? global?.['tools.roots'];
      const parsed = def.schema.safeParse(base);
      const roots = parsed.success ? parsed.data : def.default;
      out['tools.roots'] = roots.filter((r) => checks.folder(r.path) === null);
    }
    // With unverified installs refused, only built-in publishers and the ones the policy pins are
    // trusted: a key the user added never makes their own package "verified".
    if (checks.unverifiedInstall()) {
      const pinned = this.#compiled.settings.get(TRUSTED_PUBLISHERS_KEY)?.value;
      out[TRUSTED_PUBLISHERS_KEY] = Array.isArray(pinned) ? pinned : [];
    }
    out[MANAGED_RESTRICT_KEY] = this.restrictSetting();
    if (this.#compiled.hooks !== undefined) out[MANAGED_HOOKS_KEY] = this.#compiled.hooks;
    return out;
  }

  /** Called after every change of what applies (not the first load). */
  onChange(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #sourceViews(): ManagedSourceView[] {
    const fileView = (
      channel: 'local' | 'test',
      location: string,
      st: SourceState,
    ): ManagedSourceView => ({
      channel,
      location,
      status: st.status,
      problem: st.problem,
      inForce: st.doc !== null,
      cached: false,
      serial: st.doc?.serial ?? null,
      loadedAt: st.loadedAt,
      checkedAt: st.checkedAt,
      ...(channel === 'test' ? { testOverride: true } : {}),
    });
    const out: ManagedSourceView[] = [];
    if (this.#remote && this.#remoteConfig)
      out.push({
        channel: 'remote',
        location: this.#remoteConfig.url,
        status: this.#remote.status,
        problem: this.#remote.problem,
        inForce: this.#remote.doc !== null,
        cached: this.#remote.doc !== null && this.#remote.cached,
        serial: this.#remote.doc?.serial ?? null,
        loadedAt: this.#remote.loadedAt,
        checkedAt: this.#remote.checkedAt,
      });
    out.push(fileView('local', this.#o.path, this.#local));
    if (this.#test && this.#o.testPath) out.push(fileView('test', this.#o.testPath, this.#test));
    return out;
  }

  /** GET /api/v1/managed. */
  view(): ManagedPolicyView {
    const settings: ManagedSettingView[] = [...this.#compiled.settings].map(([key, e]) => ({
      key,
      value: e.value,
      channel: e.channel,
      derivedFrom: e.derivedFrom,
    }));
    return {
      active: this.#active(),
      failClosed: this.failClosed,
      sources: this.#sourceViews(),
      settings,
      restrict: this.#compiled.layers.map((l) => ({ channel: l.channel, restrict: l.restrict })),
      ignored: [...this.#compiled.ignored],
      checkedAt: this.#local.checkedAt,
    };
  }

  // ---- the refresh timer -------------------------------------------------------------------------

  /** Fetch the remote policy again every `refreshMinutes` (default 60). */
  start(): void {
    this.#started = true;
    this.#retime();
  }

  stop(): void {
    this.#started = false;
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
    this.#timerMinutes = 0;
  }

  #retime(): void {
    if (!this.#started) return;
    const minutes = this.#remoteConfig
      ? (this.#remoteConfig.refreshMinutes ?? DEFAULT_REFRESH_MINUTES)
      : 0;
    if (minutes === this.#timerMinutes) return;
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
    this.#timerMinutes = minutes;
    if (!minutes) return;
    this.#timer = setInterval(() => {
      this.refreshRemote().catch((err: unknown) =>
        this.#log.warn('remote managed policy refresh failed', { err }),
      );
    }, minutes * 60_000);
    this.#timer.unref();
  }
}
