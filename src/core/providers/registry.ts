// The provider registry (M5 plan §1). It generalizes Era 2's agent_cmd: every way Nova can hand
// work to another AI or an automation is a provider extension, and each enabled one is a Work
// Ledger worker, gated by the task's privacy mode, recording a context receipt for every call,
// and checked by Nova itself before anything it did counts.
import { EventEmitter } from 'node:events';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { lstatSync } from 'node:fs';
import { join } from 'node:path';
import { CoreError } from '../errors.ts';
import { ENVELOPE_VERSION, type Brief, type Evidence, type PrivacyMode, type Report, type Tier } from '../envelope.ts';
import { permits, stricter } from '../workers.ts';
import { review, type Extensions, type Installed, type Manifest } from '../extensions.ts';
import { canonicalJson } from '../mesh/wire.ts';
import { sha256, type Workspace } from '../workspace.ts';
import { BUILTINS, BUILTIN_IDS, FIELDS } from './builtins.ts';
import { Checks, TEST_PREFIX, testCommand } from './checks.ts';
import { claudeCode } from './claude-code.ts';
import { codex } from './codex.ts';
import { customCli, programOf } from './custom-cli.ts';
import { CONFIRMATION_SYSTEM, Inbox, STATUSES, checkSignature, n8n, timeoutS as n8nTimeout, SIGNATURE_HEADER, type Callback } from './n8n.ts';
import { openaiCompatible } from './openai.ts';
import { CONTRACT_SYSTEM, agentPrompt, contractPrompt, parseContract, summarize } from './prompt.ts';
import { applyFiles, fileRefs, notCopied, outOfScope, treeHash, unifiedDiff, type Change, type Scope, type TaskSpace, type TestAsk } from './taskspace.ts';
import { CLASSES, EGRESS, IMPLEMENTATIONS, TRANSPORTS, num, secretName, str, type AdapterBlock, type ChatRequest, type Config, type Health, type Impl, type Implementation, type ProviderClass, type Usage, type Where } from './types.ts';
import type { Db } from '../db.ts';
import type { Ledger, LanedWorker, Task, TaskInput } from '../ledger.ts';
import type { Log } from '../log.ts';
import type { Profile } from '../profile.ts';
import type { Receipts } from '../receipts.ts';
import type { Verifier } from '../verify.ts';
import type { FireInput, TriggerRecord } from '../triggers.ts';
import type { IncomingHttpHeaders } from 'node:http';
import type { Route } from '../api.ts';

export type ProviderManifest = Manifest & { adapter: AdapterBlock };

const ABOUT: Record<ProviderClass, string> = {
  'coding-agent': 'A coding agent: works in a folder made for the task, with its own tools.',
  chat: 'A chat model: answers with the files to change, which Nova applies itself.',
  automation: 'An automation: Nova sends it the brief and it reports back, signed.',
};
const CHOICES = ['chat', ...CLASSES] as const;
// How a person writes the companies the built-in agents send to.
const COMPANY: Record<string, string> = { anthropic: 'Anthropic', openai: 'OpenAI' };
type Choice = (typeof CHOICES)[number];
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const LOOPBACK = /^(localhost|127(?:\.\d{1,3}){3}|::1|\[::1\])$/;
// What one task may bring back from a coding agent, at most.
const MAX_CHANGES = 200;
const MAX_CHANGE_BYTES = 50 * 1024 * 1024;
// Said every time Nova asks to run a test on what a provider wrote.
export const RUNS_THEIR_CODE = 'This runs code the provider wrote, as you, with access to your files.';
type Reporter = (status: Report['status'], summary: string, more?: Partial<Report>, usage?: Usage) => Report;

export function checkAdapter(m: Manifest): string[] {
  const a = (m as Partial<ProviderManifest>).adapter as unknown;
  if (!isObj(a)) return ['An agent or automation adapter needs an "adapter" block: {implementation, class, transport, egress, capabilities, config, secrets}.'];
  const out: string[] = [];
  if (!IMPLEMENTATIONS.includes(a.implementation as Implementation)) out.push(`adapter.implementation must be one of ${IMPLEMENTATIONS.join(', ')}: Nova runs no code an extension ships.`);
  if (!CLASSES.includes(a.class as ProviderClass)) out.push(`adapter.class must be one of ${CLASSES.join(', ')}.`);
  if (!TRANSPORTS.includes(a.transport as 'cli')) out.push(`adapter.transport must be one of ${TRANSPORTS.join(', ')}.`);
  if (typeof a.egress !== 'string' || !EGRESS.test(a.egress)) out.push('adapter.egress must be none, local or remote:<host>.');
  if (!Array.isArray(a.capabilities) || !a.capabilities.every((x) => typeof x === 'string')) out.push('adapter.capabilities must be a list of strings.');
  if (!isObj(a.config)) out.push('adapter.config must be an object (its default settings).');
  if (!Array.isArray(a.secrets) || !a.secrets.every((s) => typeof s === 'string' && /^[A-Z][A-Z0-9_]*$/.test(s))) out.push('adapter.secrets must be a list of names, never values.');
  if ((a.class === 'automation') !== (m.kind === 'automation-adapter')) out.push('An automation is an automation-adapter; agents and models are agent-adapters.');
  if (a.implementation === 'custom-cli' && !BUILTIN_IDS.has(m.id)) out.push('There is one model command (agent_cmd); it is set in nova.config.json.');
  return out;
}

export interface ChatHandle {
  id: string;
  name: string;
  egress: 'none' | 'local' | 'remote';
  receiptEgress: string;
  model: string;
  where: string;
  call(req: ChatRequest): Promise<{ text: string; aborted: boolean }>;
}

export interface ProvidersOptions {
  db: Db;
  log: Log;
  home: string;
  workspace: Workspace;
  extensions: Extensions;
  ledger: Ledger;
  verifier: Verifier;
  receipts: Receipts;
  profile: Profile;
  // Era 2's agent_cmd and agent_egress: the custom-cli provider's settings, from nova.config.json.
  custom?: { command: string; egress: 'none' | 'local' | 'remote' } | undefined;
  // A secret by name, from the vault (M5b); null when it isn't there.
  secret?: ((name: string) => string | null) | undefined;
  // Whether a host is one of the person's own devices (the mesh), so a model there counts as local.
  meshHost?: ((host: string) => boolean) | undefined;
  // Records a callback as a trigger record (M2), so every call that reached Nova is in the record.
  fire?: ((input: FireInput) => Promise<TriggerRecord | null>) | undefined;
  now?: () => Date;
}

export class Providers extends EventEmitter {
  readonly state: string;
  readonly checks: Checks;
  readonly inbox: Inbox;
  #o: ProvidersOptions;
  #impls: Record<Implementation, Impl>;
  #workers = new Map<string, LanedWorker>();
  #probes = new Map<string, { key: string; problem: string | null; at: string }>();
  #now: () => Date;

  constructor(o: ProvidersOptions) {
    super();
    this.#o = o;
    this.#now = o.now ?? (() => new Date());
    this.state = join(o.home, 'workers', 'providers');
    this.checks = new Checks(o.workspace, this.state);
    this.inbox = new Inbox(join(this.state, 'n8n'));
    this.#impls = { 'claude-code': claudeCode, codex, 'openai-compatible': openaiCompatible, 'custom-cli': customCli, n8n: n8n(this.inbox) };
    const rules = {
      check: (m: Manifest) => {
        const out = checkAdapter(m);
        if (o.ledger.workers.has(m.id) && !this.#workers.has(m.id)) out.push(`"${m.id}" is already the name of one of Nova’s own workers.`);
        return out;
      },
      protect: (x: Installed) => (BUILTIN_IDS.has(x.id) ? `${x.manifest.name} is built into Nova; turn it off instead.` : null),
    };
    o.extensions.defineKind('agent-adapter', rules);
    o.extensions.defineKind('automation-adapter', rules);
    // Nova checks these kinds of evidence itself (verify.ts holds no checker for them).
    o.verifier.registerTest(TEST_PREFIX, (e, brief) => this.checks.checkTest(e, brief));
    o.verifier.registerKind('file_diff', (e, brief) => this.checks.checkDiff(e, brief));
    o.verifier.registerConfirmation(CONFIRMATION_SYSTEM, (e, brief) => this.#checkConfirmation(e, brief));
    this.ensureBuiltins();
    o.extensions.on('change', (c: { id: string; state: string }) => {
      if (c.state === 'removed') this.#forget(c.id);
      this.#sync();
    });
    // Results are copied back into the workspace only once Nova has verified them.
    o.ledger.on('task', (t: Task) => { if (t.state === 'done' && this.#workers.has(t.owner)) this.#copyBack(t); });
    this.#sync();
  }

  // ---- what is installed ------------------------------------------------------------------

  ensureBuiltins(): void {
    for (const b of BUILTINS) {
      try {
        const have = this.#o.extensions.list().find((x) => x.id === b.id);
        if (!have) this.#o.extensions.install(b, { builtin: true });
        else if (JSON.stringify(have.manifest) !== JSON.stringify(b)) this.#o.extensions.update(b, { builtin: true });
      } catch (e) {
        this.#o.log.problem('providers', `Nova couldn’t set up its built-in provider ${b.name}.`, { detail: (e as Error).message });
      }
    }
  }

  #installed(): (Installed & { manifest: ProviderManifest })[] {
    return this.#o.extensions.list().filter((x) => (x.kind === 'agent-adapter' || x.kind === 'automation-adapter') && isObj((x.manifest as Partial<ProviderManifest>).adapter)) as (Installed & { manifest: ProviderManifest })[];
  }

  #entry(id: string): Installed & { manifest: ProviderManifest } {
    const x = this.#installed().find((p) => p.id === id);
    if (!x) throw new CoreError('not_found', `There is no provider called "${id}".`);
    return x;
  }

  #impl(x: { manifest: ProviderManifest }): Impl {
    return this.#impls[x.manifest.adapter.implementation];
  }

  // The settings in use: the manifest's defaults, then what the person set. The model command's
  // come from nova.config.json, where Era 2 kept them.
  config(id: string): Config {
    const x = this.#entry(id);
    const set = this.#o.profile.get<Config>('providers', `config.${id}`) ?? {};
    const c: Config = { ...x.manifest.adapter.config, ...set };
    if (x.manifest.adapter.implementation === 'custom-cli') Object.assign(c, { command: this.#o.custom?.command ?? '', egress: this.#o.custom?.egress ?? 'remote' });
    return c;
  }

  #secret = (v: unknown): string | null => {
    const name = secretName(v);
    return name ? this.#o.secret?.(name) ?? null : null;
  };

  // Where a provider's calls go. An HTTP provider's address decides: this machine or one of the
  // person's devices is local; anywhere else is remote, named by its host.
  where(id: string): Where {
    const x = this.#entry(id);
    const impl = this.#impl(x);
    const c = this.config(id);
    if (x.manifest.adapter.implementation === 'custom-cli') {
      const e = c.egress as string;
      const name = customCli.model(c);
      return e === 'remote' ? { coarse: 'remote', receipt: `remote:${name}`, words: `Sends what it is given to wherever ${programOf(str(c.command)) || 'the command'} sends it (counted as the cloud).` }
        : e === 'local' ? { coarse: 'local', receipt: 'local', words: 'Stays on your devices.' } : { coarse: 'none', receipt: 'local', words: 'Stays on this computer.' };
    }
    const url = impl.url?.(c);
    if (impl.url) {
      if (!url) return { coarse: 'local', receipt: 'local', words: 'No address set yet.' };
      let host: string;
      try { host = new URL(url).hostname.replace(/^\[|\]$/g, ''); } catch { return { coarse: 'remote', receipt: 'remote:unknown', words: 'An address Nova can’t read; counted as the cloud.' }; }
      if (LOOPBACK.test(host)) return { coarse: 'local', receipt: 'local', words: 'Stays on this computer.' };
      if (this.#o.meshHost?.(host)) return { coarse: 'local', receipt: 'local', words: `Stays on your devices (${host}).` };
      const name = host.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^[^a-z0-9]+/, '').slice(0, 64) || 'unknown';
      return { coarse: 'remote', receipt: `remote:${name}`, words: `Sends the brief to ${host}.` };
    }
    const e = x.manifest.adapter.egress;
    if (e === 'none') return { coarse: 'none', receipt: 'local', words: 'Stays on this computer.' };
    if (e === 'local') return { coarse: 'local', receipt: 'local', words: 'Stays on your devices.' };
    const to = e.slice('remote:'.length);
    const named = COMPANY[to] ?? to;
    return { coarse: 'remote', receipt: e, words: `Sends the brief and the files it reads to ${named}.` };
  }

  // Health in plain words: installed, not installed, not configured, unreachable. Nothing is run to
  // find out; an HTTP provider's reachability is what its last check found.
  health(id: string): Health {
    const x = this.#entry(id);
    const impl = this.#impl(x);
    const c = this.config(id);
    const missing = impl.uninstalled?.(c);
    if (missing) return { state: 'not_installed', words: `Not installed. ${missing}`, checked_at: null };
    const unset = impl.unconfigured(c, this.#secret);
    if (unset) return { state: 'not_configured', words: `Not configured. ${unset}`, checked_at: null };
    if (!impl.probe) return { state: 'ready', words: 'Installed.', checked_at: null };
    const p = this.#probes.get(id);
    if (!p || p.key !== canonicalJson(c)) {
      const held = this.where(id).coarse === 'remote' && !permits(this.#o.profile.privacyDefault(), 'remote');
      return { state: 'unchecked', words: held ? 'Not checked: it is off your devices, and your privacy setting keeps Nova from reaching it.' : 'Not checked yet.', checked_at: null };
    }
    return p.problem ? { state: 'unreachable', words: `Unreachable. ${p.problem}`, checked_at: p.at } : { state: 'ready', words: `Reachable${impl.url?.(c) ? ` at ${new URL(impl.url(c)!).host}` : ''}.`, checked_at: p.at };
  }

  // Asks an HTTP provider's address whether it answers, and keeps the answer.
  async check(id: string): Promise<ReturnType<Providers['view']>> {
    const x = this.#entry(id);
    const impl = this.#impl(x);
    const c = this.config(id);
    // Even a check is a connection: under local-only, nothing reaches a remote address.
    const held = this.where(id).coarse === 'remote' && !permits(this.#o.profile.privacyDefault(), 'remote');
    if (impl.probe && !held && !impl.uninstalled?.(c) && !impl.unconfigured(c, this.#secret)) {
      const problem = await impl.probe(c, this.#secret, AbortSignal.timeout(6000)).catch((e) => (e as Error).message);
      this.#probes.set(id, { key: canonicalJson(c), problem, at: this.#now().toISOString() });
      this.emit('change', { id, action: 'checked' });
    }
    return this.view(id);
  }

  // A check started by a change, not awaited: Nova may be closing by the time it answers.
  #checkLater(id: string): void {
    this.check(id).catch(() => { /* the provider was removed, or Nova closed meanwhile */ });
  }

  view(id: string) {
    const x = this.#entry(id);
    const a = x.manifest.adapter;
    const c = this.config(id);
    const shown = Object.fromEntries(Object.entries(c).filter(([k]) => k !== 'callback_token_hash'));
    return {
      id, name: x.manifest.name, builtin: BUILTIN_IDS.has(id), implementation: a.implementation, class: a.class, transport: a.transport,
      about: ABOUT[a.class], capabilities: a.capabilities, state: x.state, enabled: x.state === 'enabled',
      egress: this.where(id), health: this.health(id), model: this.#impl(x).model(c),
      config: shown, fields: FIELDS[a.implementation], review: review(x.manifest),
      ...(a.implementation === 'n8n' ? { callback: { path: `/api/v1/hooks/${id}-callback`, token_set: !!c.callback_token_hash } } : {}),
    };
  }

  list() {
    return this.#installed().map((x) => this.view(x.id));
  }

  // ---- changing them ----------------------------------------------------------------------

  // Saves settings after checking them. Secrets are only ever names (secret://NAME). An n8n
  // provider gets its callback token here, shown this once; Nova keeps only its hash.
  configure(id: string, patch: unknown): { provider: ReturnType<Providers['view']>; token?: string; note?: string } {
    const x = this.#entry(id);
    if (!isObj(patch)) throw new CoreError('validation', 'config must be an object of settings.');
    if (x.manifest.adapter.implementation === 'custom-cli') throw new CoreError('validation', 'The model command is set in nova.config.json (agent_cmd and agent_egress), where Era 2 kept it.');
    const known = new Set([...Object.keys(x.manifest.adapter.config), 'timeout_s', 'test_timeout_s', ...FIELDS[x.manifest.adapter.implementation].map((f) => f.key)]);
    const unknown = Object.keys(patch).filter((k) => !known.has(k) || k === 'callback_token_hash');
    if (unknown.length) throw new CoreError('validation', `${x.manifest.name} has no setting called ${unknown.join(', ')}.`);
    for (const k of ['timeout_s', 'test_timeout_s']) if (patch[k] !== undefined && !(Number.isInteger(patch[k]) && (patch[k] as number) >= 5 && (patch[k] as number) <= 86_400)) throw new CoreError('validation', `${k} is a number of seconds, 5 to 86400.`);
    const saved = this.#o.profile.get<Config>('providers', `config.${id}`) ?? {};
    const next: Config = { ...saved, ...patch };
    const problems = this.#impl(x).check({ ...x.manifest.adapter.config, ...next });
    if (problems.length) throw new CoreError('validation', `Those settings for ${x.manifest.name} don’t work yet.`, problems);
    let token: string | undefined;
    if (x.manifest.adapter.implementation === 'n8n' && !next.callback_token_hash) {
      token = randomBytes(32).toString('base64url');
      next.callback_token_hash = sha256(token);
    }
    this.#o.profile.set('providers', `config.${id}`, next, 'settings');
    this.#probes.delete(id);
    this.emit('change', { id, action: 'configured' });
    if (this.#workers.has(id)) this.#checkLater(id);
    return { provider: this.view(id), ...(token ? { token, note: `Give this token to the workflow’s callback (header x-nova-hook-token, to /api/v1/hooks/${id}-callback). Nova keeps only a hash of it and won’t show it again.` } : {}) };
  }

  newCallbackToken(id: string): { token: string; note: string } {
    const x = this.#entry(id);
    if (x.manifest.adapter.implementation !== 'n8n') throw new CoreError('validation', `${x.manifest.name} doesn’t call Nova back.`);
    const token = randomBytes(32).toString('base64url');
    const saved = this.#o.profile.get<Config>('providers', `config.${id}`) ?? {};
    this.#o.profile.set('providers', `config.${id}`, { ...saved, callback_token_hash: sha256(token) }, 'settings');
    this.emit('change', { id, action: 'configured' });
    return { token, note: 'The old token stops working now. Nova keeps only a hash of this one and won’t show it again.' };
  }

  // Turning a provider on is tier 2: the extension host asks for an OK on its permissions. One that
  // isn't installed or configured can't be turned on.
  enable(id: string, o: { approved?: boolean } = {}) {
    const x = this.#entry(id);
    const h = this.health(id);
    if (h.state === 'not_installed' || h.state === 'not_configured') throw new CoreError('conflict', `Nova can’t turn on ${x.manifest.name} yet. ${h.words}`);
    this.#o.extensions.enable(id, { approved: o.approved === true });
    if (this.#impl(x).probe) this.#checkLater(id);
    return this.view(id);
  }

  disable(id: string) {
    this.#entry(id);
    this.#o.extensions.disable(id);
    return this.view(id);
  }

  // ---- choices: which provider chats, and which is the default for each class ----------------

  #choice(what: Choice): string | null {
    const v = this.#o.profile.get<string>('providers', what === 'chat' ? 'chat' : `default.${what}`);
    return typeof v === 'string' ? v : null;
  }

  #candidates(what: Choice) {
    const cls: ProviderClass = what === 'chat' ? 'chat' : what;
    return this.#installed().filter((x) => x.manifest.adapter.class === cls && (x.state === 'enabled' || (what === 'chat' && x.manifest.adapter.implementation === 'custom-cli')));
  }

  // One recommendation, not a list (perception principles): the one that is on, healthy and allowed
  // by the privacy setting, keeping data closest to home.
  recommend(what: Choice): { id: string | null; why: string } {
    const mode = this.#o.profile.privacyDefault();
    const rank = { none: 0, local: 1, remote: 2 } as const;
    const options = this.#candidates(what).map((x) => ({ x, where: this.where(x.id), h: this.health(x.id) }))
      .filter((o) => o.h.state === 'ready' || o.h.state === 'unchecked');
    const allowed = options.filter((o) => permits(mode, o.where.coarse));
    const best = allowed.sort((a, b) => rank[a.where.coarse] - rank[b.where.coarse] || Number(b.h.state === 'ready') - Number(a.h.state === 'ready'))[0];
    if (best) return { id: best.x.id, why: best.where.coarse === 'remote' ? `It is on and working, and it ${best.where.words.charAt(0).toLowerCase()}${best.where.words.slice(1)}` : `It is on and working, and keeps everything ${best.where.coarse === 'none' ? 'on this computer' : 'on your devices'}.` };
    if (options.length) return { id: null, why: `What is on sends data off your devices, and your privacy setting is ${mode}. Turn on a local model to use here.` };
    return { id: null, why: what === 'chat' ? 'Turn on a chat model to choose it here.' : `Turn on a ${what.replace('-', ' ')} to use one here.` };
  }

  choices() {
    const one = (what: Choice) => {
      const set = this.#choice(what);
      const current = what === 'chat' ? set ?? 'custom-cli' : set;
      return { current, recommended: this.recommend(what) };
    };
    return { chat: one('chat'), defaults: Object.fromEntries(CLASSES.map((c) => [c, one(c)])) as Record<ProviderClass, ReturnType<typeof one>>, task_tests: this.#testsAllowed() ? 'allow' : 'ask' };
  }

  choose(what: unknown, id: unknown) {
    if (!CHOICES.includes(what as Choice)) throw new CoreError('validation', `Choose for one of ${CHOICES.join(', ')}.`);
    const w = what as Choice;
    if (typeof id !== 'string') throw new CoreError('validation', 'id is the provider to use.');
    const x = this.#entry(id);
    if (!this.#candidates(w).some((c) => c.id === id)) {
      throw new CoreError('conflict', x.manifest.adapter.class !== (w === 'chat' ? 'chat' : w) ? `${x.manifest.name} isn’t a ${w === 'chat' ? 'chat model' : w.replace('-', ' ')}.` : `${x.manifest.name} is off; turn it on first.`);
    }
    this.#o.profile.set('providers', w === 'chat' ? 'chat' : `default.${w}`, id, 'settings');
    this.emit('change', { id, action: 'chosen', for: w });
    return this.choices();
  }

  // Letting Nova run a brief's test command without asking loosens a permission: tier 3.
  setTestPolicy(value: unknown, confirm: boolean) {
    if (value !== 'ask' && value !== 'allow') throw new CoreError('validation', 'task_tests is ask or allow.');
    if (value === 'allow' && !confirm) throw new CoreError('validation', 'Letting Nova run test commands without asking needs an explicit confirmation: send confirm: true.');
    this.#o.profile.set('policy', 'task_tests', value, 'settings');
    return this.choices();
  }

  #testsAllowed(): boolean {
    return this.#o.profile.get<string>('policy', 'task_tests') === 'allow';
  }

  // The chat model for Era 2's conversations, or null when it is the model command (agent_cmd), which
  // Era 2's runner runs itself exactly as before.
  chat(): ChatHandle | null {
    const id = this.#choice('chat');
    if (!id || id === 'custom-cli') return null;
    let x;
    try { x = this.#entry(id); } catch { return null; }
    const impl = this.#impl(x);
    const where = this.where(id);
    const c = this.config(id);
    return {
      id, name: x.manifest.name, egress: where.coarse, receiptEgress: where.receipt, model: impl.model(c), where: where.words,
      call: async (req) => {
        if (x.state !== 'enabled') throw new CoreError('conflict', `The chat model is set to ${x.manifest.name}, which is turned off. Turn it on, or choose another in Settings › Providers.`);
        if (!impl.chat) throw new CoreError('conflict', `${x.manifest.name} can’t chat.`);
        return impl.chat(this.config(id), this.#secret, req);
      },
    };
  }

  // A plain answer when a task names a provider that can't take it.
  explain(owner: string): string | null {
    const x = this.#installed().find((p) => p.id === owner);
    if (!x || x.state === 'enabled') return null;
    return `${x.manifest.name} is turned off. Turn it on in Settings › Providers first.`;
  }

  // ---- the n8n callback, through the token webhook (M2) ----------------------------------------

  // Returns null when the hook isn't a provider's callback, so the trigger engine handles it.
  async hook(name: string, token: string | undefined, body: Record<string, unknown>, headers: IncomingHttpHeaders): Promise<Record<string, unknown> | null> {
    const m = /^(.+)-callback$/.exec(name);
    const x = m ? this.#installed().find((p) => p.id === m[1] && p.manifest.adapter.implementation === 'n8n') : undefined;
    if (!x) return null;
    const c = this.config(x.id);
    const want = Buffer.from(String(c.callback_token_hash ?? ''), 'hex');
    const got = Buffer.from(sha256(token ?? ''), 'hex');
    if (!token || want.length !== got.length || !timingSafeEqual(want, got)) {
      this.#o.log.warn('providers', 'A callback had a missing or wrong token.', { hook: name });
      throw new CoreError('forbidden', 'That webhook token isn’t right.');
    }
    const secret = this.#secret(c.signing_secret);
    if (!secret) throw new CoreError('conflict', `${x.manifest.name} has no signing secret in the vault, so Nova can’t check the callback.`);
    const sig = headers[SIGNATURE_HEADER];
    const bad = checkSignature(secret, Array.isArray(sig) ? sig[0] : sig, canonicalJson(body), Math.floor(this.#now().getTime() / 1000));
    if (bad) {
      this.#o.log.warn('providers', 'A callback’s signature didn’t check out.', { hook: name, why: bad });
      throw new CoreError('forbidden', bad);
    }
    const taskId = body.task_id;
    if (typeof taskId !== 'string') throw new CoreError('validation', 'task_id is required.');
    if (!STATUSES.includes(body.status as 'done')) throw new CoreError('validation', `status must be one of ${STATUSES.join(', ')}.`);
    const conf = body.confirmation;
    if (conf !== undefined && conf !== null && !(isObj(conf) && typeof conf.id === 'string' && conf.id.trim())) throw new CoreError('validation', 'confirmation must be {id}, the id in the system that did the work.');
    if (body.status === 'done' && !isObj(conf)) throw new CoreError('validation', 'A done callback carries a confirmation {id}: Nova doesn’t take done without evidence.');
    const task = this.#o.ledger.get(taskId);
    if (task.owner !== x.id) throw new CoreError('forbidden', `That task wasn’t sent to ${x.manifest.name}.`);
    const have = this.inbox.get(taskId);
    if (have) return { ok: true, task_id: taskId, duplicate: true };
    const t = await this.#o.fire?.({ class: 'event', source: `webhook:${name}`, payload: body, dedup_key: `callback:${taskId}`, name: `${x.manifest.name} reported back` });
    const cb: Callback = {
      task_id: taskId, status: body.status as Callback['status'], summary: typeof body.summary === 'string' ? body.summary : '',
      confirmation: isObj(conf) ? { id: String(conf.id).trim().slice(0, 200) } : null,
      signed_at: Number(/t=(\d+)/.exec(String(Array.isArray(sig) ? sig[0] : sig))?.[1]), received_at: this.#now().toISOString(), provider: x.id, trigger_id: t?.trigger_id ?? null,
    };
    this.inbox.put(cb);
    return { ok: true, task_id: taskId, trigger_id: cb.trigger_id };
  }

  #checkConfirmation(e: Evidence, brief: Brief): { ok: boolean; why: string } {
    if (e.kind !== 'confirmation') return { ok: false, why: 'Not a confirmation.' };
    const cb = this.inbox.get(brief.task_id);
    if (!cb) return { ok: false, why: 'Nova has no signed callback from the workflow for this task.' };
    if (cb.confirmation?.id !== e.id) return { ok: false, why: `The callback Nova checked carries ${cb.confirmation ? `confirmation ${cb.confirmation.id}` : 'no confirmation'}, not ${e.id}.` };
    return { ok: true, why: `Nova checked the workflow’s callback for this task itself: signed with the shared secret, received ${cb.received_at}, confirmation ${e.id}.` };
  }

  // ---- the ledger side ------------------------------------------------------------------------

  // Each enabled provider is a worker; turned off or removed, it is taken out of the ledger.
  #sync(): void {
    const enabled = new Set(this.#installed().filter((x) => x.state === 'enabled').map((x) => x.id));
    for (const id of [...this.#workers.keys()]) {
      if (enabled.has(id)) continue;
      if (this.#o.ledger.workers.get(id) === this.#workers.get(id)) this.#o.ledger.workers.delete(id);
      this.#workers.delete(id);
    }
    for (const id of enabled) {
      if (this.#workers.has(id)) continue;
      if (this.#o.ledger.workers.has(id)) {
        this.#o.log.problem('providers', `The provider ${id} has the same name as one of Nova’s own workers, so it can’t be used.`);
        continue;
      }
      const w = this.#worker(id);
      this.#workers.set(id, w);
      this.#o.ledger.workers.set(id, w);
    }
  }

  #forget(id: string): void {
    this.#o.db.run(`DELETE FROM profile WHERE section = 'providers' AND (key = ? OR value = ?)`, `config.${id}`, JSON.stringify(id));
    this.#probes.delete(id);
  }

  #worker(id: string): LanedWorker {
    const reg = this;
    return {
      id,
      get name() { try { return reg.#entry(id).manifest.name; } catch { return id; } },
      get about() { try { return ABOUT[reg.#entry(id).manifest.adapter.class]; } catch { return ''; } },
      get egress() { try { return reg.where(id).coarse; } catch { return 'remote' as const; } },
      // Where a brief would go is where the provider's settings point now (an HTTP provider's
      // address decides), the same for every brief; the ledger asks this per task.
      egressFor: () => { try { return reg.where(id).coarse; } catch { return 'remote' as const; } },
      get evidence() { try { return reg.#entry(id).manifest.adapter.class === 'automation' ? ['confirmation' as const] : ['test_result' as const, 'file_diff' as const]; } catch { return []; } },
      get timeoutMs() {
        try {
          const x = reg.#entry(id);
          const c = reg.config(id);
          // The provider's own time, plus the time Nova's test run may take after it.
          return x.manifest.adapter.class === 'automation' ? n8nTimeout(c) * 1000 : (num(c.timeout_s, 1800) + num(c.test_timeout_s, 300) + 60) * 1000;
        } catch { return undefined; }
      },
      health: () => {
        const h = reg.health(id);
        return { ok: h.state === 'ready' || h.state === 'unchecked', detail: `${id}: ${h.words}` };
      },
      // Each provider takes one task at a time, and doesn't hold up the rest of the ledger.
      // A declared test command no longer asks when the task is made, before any code exists: Nova
      // asks once the provider has finished, showing what it wrote (#ask).
      lane: () => ({ key: 'run', max: 1 }),
      run: (brief, signal) => reg.#run(id, brief, signal),
    };
  }

  async #run(id: string, brief: Brief, signal: AbortSignal): Promise<Report> {
    const started = performance.now();
    const x = this.#entry(id);
    const a = x.manifest.adapter;
    const impl = this.#impl(x);
    const config = this.config(id);
    const name = x.manifest.name;
    const report: Reporter = (status, summary, more = {}, usage = {}) => ({
      envelope: ENVELOPE_VERSION, task_id: brief.task_id, status, summary, evidence: [], artifacts: [], blockers: status === 'blocked' ? [summary] : [], follow_up_suggestions: [],
      ...more, usage: { ...usage, duration_ms: Math.round(performance.now() - started) },
    });
    // The task's own mode, and never looser than the person's setting right now.
    const mode: PrivacyMode = stricter(brief.privacy_mode, this.#o.profile.privacyDefault());
    const where = this.where(id);
    if (!permits(mode, where.coarse)) return report('blocked', `Waiting on local capacity: ${name} would send this off your devices (${where.words.replace(/\.$/, '')}), and this task is ${mode}.`);
    if (x.state !== 'enabled') return report('blocked', `${name} is turned off.`);
    const test = testCommand(brief);
    if (brief.evidence_required.some((r) => r.kind === 'test_result') && !test) {
      return report('failed', 'The brief asks for a test result but names no test command (inputs.test_command) for Nova to run itself.');
    }
    const log = (line: string) => this.#o.log.info('providers', `${id}: ${line.slice(0, 500)}`, { task: brief.task_id });

    // An automation works elsewhere: the brief goes out, a signed report comes back.
    if (a.class === 'automation') {
      try { this.#receipt(id, brief, mode, where.receipt, impl.model(config), [{ kind: 'file', ref: `brief:${brief.task_id}`, sha256: sha256(canonicalJson(brief)) }]); } catch (e) { return report('failed', (e as Error).message); }
      const out = await impl.work({ provider: id, brief, config, cwd: null, system: '', prompt: '', signal, secret: this.#secret, stateDir: join(this.state, 'tasks', brief.task_id), log });
      return report(out.status, out.summary, { evidence: out.evidence ?? [], ...(out.blockers ? { blockers: out.blockers } : {}) }, out.usage);
    }

    // Coding agents and chat models work in the task's own folder, filled afresh each attempt;
    // except when the person has just OK'd running the test on what the provider wrote. Then the
    // test runs on exactly what they saw, and the provider isn't asked again.
    const space = this.checks.space(brief.task_id);
    const asked = space.ask();
    if (asked?.approved_at && asked.command === test && space.exists()) {
      space.setAsk(null);
      if (treeHash(space.root) !== asked.tree) return report('failed', `The task’s folder changed after you OK’d running \`${test}\`, so Nova didn’t run it. Nothing was copied back.`);
      const changes = space.recorded() ?? space.changes();
      return this.#finish(brief, space, changes, test, `You OK’d running \`${test}\` on what ${name} wrote.`, config, signal, report, (asked.usage ?? {}) as Usage);
    }
    let copied: { path: string; sha256: string }[];
    try { copied = space.prepare(fileRefs(brief)); } catch (e) { return report('blocked', `Nova couldn’t set up the task’s folder: ${(e as Error).message}`); }
    let scope: Scope;
    try { scope = space.scope(brief); } catch (e) { return report('failed', (e as Error).message); }
    const contract = a.class === 'chat';
    let system: string;
    let prompt: string;
    if (contract) {
      const files = copied.filter((f) => !f.path.includes('\0')).map((f) => ({ path: f.path, text: space.read(f.path) ?? '' })).filter((f) => f.text.length <= 200_000 && !f.text.includes('\u0000'));
      system = CONTRACT_SYSTEM;
      prompt = contractPrompt(brief, files, scope.words);
    } else {
      system = 'You are a coding agent doing one task for Nova, a personal assistant. Nova checks your work itself afterwards.';
      prompt = agentPrompt(brief, copied.map((f) => f.path), scope.words);
    }
    // A receipt for the call (CONTRACTS §2): the brief and each file it can see, by hash.
    try {
      this.#receipt(id, brief, mode, where.receipt, impl.model(config), [
        { kind: 'file', ref: `brief:${brief.task_id}`, sha256: sha256(`${system}\n\n${prompt}`) },
        ...copied.map((f) => ({ kind: 'file' as const, ref: `workspace:${f.path}`, sha256: f.sha256 })),
      ]);
    } catch (e) {
      return report('failed', (e as Error).message);
    }
    let out;
    try {
      out = await impl.work({ provider: id, brief, config, cwd: space.root, system, prompt, signal, secret: this.#secret, stateDir: join(this.state, 'tasks', brief.task_id), log });
    } catch (e) {
      if (signal.aborted) throw e;
      return report('failed', `${name} stopped with an error: ${(e as Error).message}`);
    }
    if (out.status !== 'done') return report(out.status, out.summary, out.blockers ? { blockers: out.blockers } : {}, out.usage);

    let summary = out.summary;
    if (contract) {
      try {
        const reply = parseContract(out.reply ?? '');
        const written = applyFiles(space.root, reply.files);
        summary = summarize(reply.notes, written.length ? `Changed ${written.join(', ')}.` : 'Changed nothing.');
      } catch (e) {
        return report('failed', `Nova didn’t apply ${name}’s reply: ${(e as Error).message}`, {}, out.usage);
      }
    }

    // What changed, read from the folder itself. More than Nova takes from one task, or anything the
    // provider wasn't allowed to change, and the work is refused whole: nothing runs, nothing is
    // copied back.
    const changes = space.changes();
    const bytes = changes.reduce((n, c) => n + (c.kind === 'deleted' ? 0 : lstatSync(join(space.root, c.path)).size), 0);
    if (changes.length > MAX_CHANGES || bytes > MAX_CHANGE_BYTES) {
      return report('failed', `${name} changed ${changes.length} file${changes.length === 1 ? '' : 's'} (${Math.ceil(bytes / 1024 / 1024)} MB). Nova takes at most ${MAX_CHANGES} files and ${MAX_CHANGE_BYTES / 1024 / 1024} MB from one task, so it didn’t look further. Nothing ran and nothing was copied back.`, {}, out.usage);
    }
    const bad = outOfScope(changes, scope);
    if (bad) return report('failed', `Nova refused the work: ${bad}. Nothing ran and nothing was copied back.`, {}, out.usage);
    space.recordChanges(changes);

    // The test runs code: what the provider wrote, as the person, with their files in reach. So
    // Nova always asks first when the provider changed anything, whatever the test policy says; the
    // policy only covers a run on files nobody changed.
    if (test && (changes.length || !this.#testsAllowed())) return this.#ask(id, name, brief, space, changes, test, summary, report, out.usage);
    return this.#finish(brief, space, changes, test, summary, config, signal, report, out.usage);
  }

  // Nova's own evidence: each change, from the folder itself, then the brief's test, run by Nova.
  async #finish(brief: Brief, space: TaskSpace, changes: Change[], test: string, summary: string, config: Config, signal: AbortSignal, report: Reporter, usage: Usage): Promise<Report> {
    const evidence: Evidence[] = changes.map((c) => ({ kind: 'file_diff', target: `workspace:${c.path}`, diff: unifiedDiff(c.path, space.readBaseline(c.path), space.read(c.path)) }));
    if (test) {
      let run;
      try {
        run = await this.checks.runTest(space, test, signal, num(config.test_timeout_s, 300), brief);
      } catch (e) {
        if (signal.aborted) throw e;
        return report('failed', `${(e as Error).message} Nothing was copied back.`, {}, usage);
      }
      evidence.push({ kind: 'test_result', name: `${TEST_PREFIX}${run.id}`, passed: run.passed, output: run.output });
      summary = `${summary} Nova ran \`${test}\` itself: ${run.passed ? 'it passed' : 'it failed'}.`;
    }
    // Changes that stay in the task's folder even once verified, said now rather than discovered.
    let scope: Scope | null = null;
    try { scope = space.scope(brief); } catch { /* checked before the provider ran */ }
    const kept = scope ? changes.map((c) => ({ path: c.path, why: notCopied(c.path, scope!) })).filter((k) => k.why) : [];
    if (kept.length) summary = `${summary} Not copied into your workspace: ${kept.map((k) => `${k.path} (${k.why})`).join('; ')}.`;
    return report('done', summary, {
      evidence,
      artifacts: changes.map((c) => ({ kind: 'file', ref: `workspace:${c.path}`, ...(c.sha256 ? { sha256: c.sha256 } : {}) })),
    }, usage);
  }

  // Asks the person before the test runs: what changed (each file, with a short preview), and in
  // plain words what running it means. The task waits, partly done, until they OK it (approveTest)
  // or cancel it.
  #ask(id: string, name: string, brief: Brief, space: TaskSpace, changes: Change[], test: string, summary: string, report: Reporter, usage: Usage): Report {
    const diffs = changes.map((c) => ({ c, diff: unifiedDiff(c.path, space.readBaseline(c.path), space.read(c.path)) }));
    const files = diffs.slice(0, 20).map(({ c, diff }) => {
      const lines = diff.split('\n');
      return {
        path: c.path, kind: c.kind,
        added: lines.filter((l) => l.startsWith('+') && !l.startsWith('+++')).length,
        removed: lines.filter((l) => l.startsWith('-') && !l.startsWith('---')).length,
        preview: lines.slice(2, 14).join('\n').slice(0, 1200),
      };
    });
    space.setAsk({ task_id: brief.task_id, provider: id, command: test, tree: treeHash(space.root), files, more: Math.max(0, changes.length - files.length), asked_at: this.#now().toISOString(), approved_at: null, usage: { ...usage } });
    try { this.#o.ledger.note(brief.task_id, 'test_run_asked', { command: test, files: changes.slice(0, 50).map((c) => c.path) }); } catch { /* the record is a courtesy; the question stands */ }
    const ask = changes.length ? `Nova needs your OK to run \`${test}\`. ${RUNS_THEIR_CODE}` : `${name} changed nothing. Nova needs your OK to run \`${test}\` on your files as they were.`;
    return report('partial', `${summary} ${ask}`, {
      evidence: diffs.map(({ c, diff }) => ({ kind: 'file_diff' as const, target: `workspace:${c.path}`, diff })),
      blockers: [ask],
    }, usage);
  }

  // What the person sees before OK'ing the test run, or null when nothing is waiting for that.
  testAsk(taskId: string): (TestAsk & { words: string; provider_name: string }) | null {
    const t = this.#o.ledger.get(taskId);
    const x = this.#installed().find((p) => p.id === t.owner);
    if (!x || t.state !== 'waiting') return null;
    const a = this.checks.space(taskId).ask();
    if (!a || a.approved_at) return null;
    return { ...a, provider_name: x.manifest.name, words: a.files.length ? RUNS_THEIR_CODE : 'The provider changed nothing; this runs the test on your files as they were.' };
  }

  // The person's OK to run the test on what the provider wrote. The task runs again, and this time
  // only the test runs, on the folder as they saw it.
  approveTest(taskId: string): Task {
    const ask = this.testAsk(taskId);
    if (!ask) throw new CoreError('conflict', 'This task isn’t waiting for your OK to run its test.');
    const { words: _w, provider_name: who, ...kept } = ask;
    const space = this.checks.space(taskId);
    space.setAsk({ ...kept, approved_at: this.#now().toISOString() });
    try {
      this.#o.ledger.note(taskId, 'test_run_approved', { command: ask.command });
      return this.#o.ledger.retry(taskId, `You OK’d running \`${ask.command}\` on what ${who} wrote.`);
    } catch (e) {
      space.setAsk(kept);
      throw e;
    }
  }

  #receipt(id: string, brief: Brief, mode: PrivacyMode, egress: string, model: string, items: { kind: 'file'; ref: string; sha256: string }[]): void {
    this.#o.receipts.record({ task_id: brief.task_id, provider: id, model, purpose: `task: ${brief.goal.slice(0, 80)}`, privacy_mode: mode, egress, context_items: items });
  }

  #copyBack(t: Task): void {
    try {
      const space = this.checks.space(t.id);
      if (!space.recorded() || space.copiedBack()) return;
      let scope: Scope | null = null;
      try { scope = space.scope(t.brief); } catch { /* an unreadable editable list: nothing is copied back below */ }
      const r = space.copyBack((p) => (scope ? notCopied(p, scope) : 'the brief’s list of what may change couldn’t be read'));
      this.#o.ledger.note(t.id, 'copied_back', r);
      if (r.skipped.length) {
        this.#o.log.problem('providers', `Some of what “${t.title}” changed wasn’t copied into your workspace: ${r.skipped.map((s) => `${s.path} (${s.why})`).join('; ')}. The changes are in the task’s evidence.`, { taskId: t.id });
      }
      this.emit('change', { id: t.owner, action: 'copied_back', task_id: t.id });
    } catch (e) {
      this.#o.log.problem('providers', `Nova couldn’t copy the results of “${t.title}” into your workspace.`, { detail: (e as Error).stack ?? String(e), taskId: t.id });
    }
  }

  // After a restart: verified work whose results never made it back is copied back now.
  recover(): string[] {
    const done: string[] = [];
    for (const t of this.#o.ledger.list({ state: 'done', limit: 500 })) {
      if (!this.#installed().some((x) => x.id === t.owner)) continue;
      const space = this.checks.space(t.id);
      if (space.recorded() && !space.copiedBack()) { this.#copyBack(t); done.push(t.id); }
    }
    return done;
  }

  // ---- the API ----------------------------------------------------------------------------------

  routes(): Route[] {
    const id = (p: Record<string, string>) => p.id!;
    return [
      { method: 'GET', path: '/providers', summary: 'Every provider: class, where its data goes, health in plain words, settings; with the chat model and each class’s default, current and recommended.', handle: () => ({ providers: this.list(), ...this.choices() }) },
      { method: 'GET', path: '/providers/{id}', summary: 'One provider.', handle: ({ params }) => this.view(id(params)) },
      { method: 'PUT', path: '/providers/{id}/config', summary: 'Change a provider’s settings. Secrets are names only (secret://NAME). An n8n provider’s callback token is returned here once.', body: '{config}', handle: ({ params, body }) => this.configure(id(params), body.config) },
      { method: 'POST', path: '/providers/{id}/enable', summary: 'Turn a provider on (tier 2: needs {approved: true} for its permissions). It must be installed and configured.', body: '{approved}', handle: ({ params, body }) => this.enable(id(params), { approved: body.approved === true }) },
      { method: 'POST', path: '/providers/{id}/disable', summary: 'Turn a provider off. Its tasks wait until it is on again.', handle: ({ params }) => this.disable(id(params)) },
      { method: 'POST', path: '/providers/{id}/check', summary: 'Check whether an HTTP provider’s address answers, now.', handle: ({ params }) => this.check(id(params)) },
      { method: 'POST', path: '/providers/{id}/callback-token', summary: 'A new callback token for an n8n provider, shown this once; the old one stops working.', handle: ({ params }) => this.newCallbackToken(id(params)) },
      { method: 'PUT', path: '/providers/choice', summary: 'Choose the chat model, or the default provider for a class (coding-agent, chat, automation).', body: '{for: chat | coding-agent | automation, id}', handle: ({ body }) => this.choose(body.for, body.id) },
      { method: 'GET', path: '/providers/tasks/{task}/test-run', summary: 'What a provider changed and the test Nova would run on it, while the task waits for your OK (404 when nothing waits).', handle: ({ params }) => { const a = this.testAsk(params.task!); if (!a) throw new CoreError('not_found', 'This task isn’t waiting for your OK to run its test.'); return a; } },
      { method: 'POST', path: '/providers/tasks/{task}/test-run', summary: 'OK running the brief’s test on what the provider wrote (tier 2). It runs code the provider wrote, as you. To refuse, cancel the task.', handle: ({ params }) => this.approveTest(params.task!) },
      { method: 'PUT', path: '/providers/policy', summary: 'Whether Nova asks before running a brief’s test command on files no provider changed (ask, the default) or not (allow: tier 3, needs {confirm: true}). Code a provider wrote is always asked about.', body: '{task_tests: ask | allow, confirm?}', handle: ({ body }) => this.setTestPolicy(body.task_tests, body.confirm === true) },
    ];
  }
}
