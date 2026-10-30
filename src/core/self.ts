// Nova's view of itself (grounding). The chat agent is told what this Nova really is, from the
// core's own registries in process, never from a model's priors: a compact briefing at the start of
// every turn, and the read-only answers its status tools give mid-conversation. Plus the one way in
// for what the person already knows elsewhere: a file in ~/workspace/import/, and a Nova memory
// export there loaded as memories they review.
//
// What goes into either is a summary: names, states and the actual error words. Never a secret
// (vault values, keys, tokens: names and "set" only), never a memory's or a capture's contents.
// Everything leaving here passes redactText as well, so a value the vault knows can't slip through
// an error message. The briefing reaches whatever model the conversation uses, cloud ones included.
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { hostname, platform } from 'node:os';
import { join, relative, resolve, sep } from 'node:path';
import { CoreError } from './errors.ts';
import { redactText, type Log } from './log.ts';
import { identityOf } from './identity.ts';
import { Ollama } from './models/ollama.ts';
import { ROLES, ROLE_WORDS } from './models/recommend.ts';
import { KINDS as MEMORY_KINDS, type Kind as MemoryKind, type Memory } from './memory.ts';
import { SECTIONS, type Profile, type Section } from './profile.ts';
import type { Providers } from './providers/registry.ts';
import type { Models } from './models/index.ts';
import type { Connectors } from './connectors/index.ts';
import type { Capture } from './capture/capture.ts';
import type { Device, Devices } from './mesh/devices.ts';
import type { Triggers } from './triggers.ts';
import type { Design } from './design.ts';
import type { Egress } from './workers.ts';

// Where the person puts what they want Nova to learn from: notes, another assistant's export, a
// Nova memory export (POST /api/v1/memory/export writes memory.json).
export const IMPORT_DIR = 'workspace/import';
// Any setting whose name says it is a secret is shown as set or not, never its value.
const SECRET_KEY = /pass(word)?|secret|token|api[_-]?key|authorization|cookie|hash|private/i;
const RUNTIME_TTL_MS = 30_000;
const CHECK_WAIT_MS = 2_000;
const LIST_MAX = 6;

// Era 2's parts the core doesn't hold, handed in by the server (src/server.js): the schedules in
// ~/schedules/ and the approvals in ~/permissions.md.
export interface Era2State {
  schedules?: () => { id: string; name: string; when?: string; paused?: boolean; error?: string; next?: string | null; last?: { ts?: string; ok?: boolean; error?: string; missed?: boolean } | null }[];
  permissions?: () => { id: string; label: string; yes: boolean }[];
}

export interface SelfOptions {
  home: string;
  version: string;
  // preview, production or development: what this instance is for (NOVA_INSTANCE).
  instance: () => string;
  // The code's commit, when it runs from a git checkout (a release slot is one too).
  codeRoot: string;
  profile: Profile;
  memory: Memory;
  providers: Providers;
  models: Models;
  connectors: Connectors;
  capture: Capture;
  devices: Devices;
  triggers: Triggers;
  design: Design;
  log: Log;
  hubId: () => string;
  role: () => string;
  online: (d: Device) => boolean;
  setupDone: () => boolean;
  // The model command (agent_cmd), when it is the chat model: its program and where it sends.
  chat?: { program: string; egress: Egress };
  now?: () => Date;
}

type Runtime = { url: string; ok: boolean; version: string | null; models: string[]; problem: string | null };

const plain = (s: unknown) => String(s ?? '').replace(/\s+/g, ' ').trim();
const bare = (s: unknown) => plain(s).replace(/[.\s]+$/, '');
const quote = (s: unknown) => `“${bare(s)}”`;
const list = (xs: string[], max = LIST_MAX) => (xs.length > max ? `${xs.slice(0, max).join(', ')} and ${xs.length - max} more` : xs.join(', '));
const hostOf = (url: string) => { try { return new URL(url).host; } catch { return url; } };
const ago = (iso: string | null | undefined, now: Date) => {
  if (!iso) return '';
  const s = Math.round((now.getTime() - Date.parse(iso)) / 1000);
  if (!Number.isFinite(s)) return '';
  return s < 90 ? 'just now' : s < 5400 ? `${Math.round(s / 60)} min ago` : s < 129_600 ? `${Math.round(s / 3600)} h ago` : `${Math.round(s / 86_400)} days ago`;
};
const addressOf = (c: Record<string, unknown>) => (typeof c.base_url === 'string' && c.base_url ? ` at ${hostOf(c.base_url)}` : typeof c.webhook_url === 'string' && c.webhook_url ? ` at ${hostOf(c.webhook_url)}` : '');
const STATUS_WORDS: Record<string, string> = { on: 'working', needs_key: 'needs a key', unreachable: 'can’t be reached', refused: 'held back by your privacy setting', elsewhere: 'on a device that isn’t the hub now', off: 'off', pending: 'not pulled yet' };

export class Self {
  #o: SelfOptions;
  #era2: Era2State = {};
  #cached: { at: number; value: Runtime } | null = null;
  #build: string | null | undefined;

  constructor(o: SelfOptions) {
    this.#o = o;
  }

  // Era 2's schedules and approvals (server.js), so the briefing can say them too.
  attach(era2: Era2State): this {
    this.#era2 = { ...this.#era2, ...era2 };
    return this;
  }

  #now(): Date { return this.#o.now?.() ?? new Date(); }

  // ---- the briefing ----------------------------------------------------------------------------

  // Compact, factual, refreshed for every turn: a summary per part and where to look further.
  async briefing(): Promise<string> {
    const lines = [
      `- Instance: ${this.#instanceLine()}`,
      `- Person: ${this.#personLine()}`,
      `- Chat model (you): ${this.#chatLine()}`,
      `- Model providers: ${this.#providersLine()}`,
      `- Local models: ${await this.#runtimeLine()}`,
      `- Connections: ${this.#connectorsLine()}`,
      `- Capture: ${this.#captureLine()}`,
      `- Devices: ${this.#devicesLine()}`,
      `- Schedules and automations: ${this.#schedulesLine()}`,
      `- Approvals: ${this.#approvalsLine()}`,
      `- Appearance: ${this.#appearanceLine()}`,
      `- Open problems: ${this.#problemsLine()}`,
    ];
    const fresh = this.#freshLines();
    const text = `# This Nova, right now

Read from Nova's own registry at the start of this turn. This is the truth about this instance, not your general knowledge of AI assistants: answer questions about Nova with its specifics (the actual names, states and errors below). For detail, or anything that may have changed, check with the nova_ tools before you answer.

${lines.join('\n')}
${fresh.length ? `\n${fresh.join('\n')}\n` : ''}
Not listed means not in this setup yet. Ways to add: ${this.#openAiWay()}; a connection in Settings › Connections; a capture source in Settings › Capture; a device in Settings › Devices; a skill in the Skills view; new extensions and design systems through Nova's change pipeline (Settings › Changes); the look in Settings › Appearance; what Nova may do without asking in Settings › Without asking. These are the person's to change: from chat you change only what your tools do (schedules, memory, files in your workspace). Never ask for a key, token or password in chat or in a file; the person enters it in that Settings section, which keeps it in the vault.`;
    return redactText(text);
  }

  // Where an OpenAI-compatible service (OpenRouter, say) goes, as this instance has it: the one
  // "Local model (Ollama or compatible)" provider, which repointing would take from what it serves
  // now, or the cloud model in Settings › Models.
  #openAiWay(): string {
    const p = this.#providerViews().find((x) => x.id === 'openai-compatible');
    const used = p && (p.enabled || this.#chatId() === p.id);
    const now = p && typeof p.config.base_url === 'string' && p.config.base_url ? hostOf(p.config.base_url) : null;
    return `an OpenAI-compatible service (OpenRouter included) goes in Settings › Providers as the "${p?.name ?? 'Local model (Ollama or compatible)'}" provider, with its address, model and key${used && now ? ` (there is one such provider, and it points at ${now} now, so repointing it replaces that)` : ''}, then chosen as the chat model; or as the cloud model in Settings › Models, which local-preferred work falls back to`;
  }

  #instanceLine(): string {
    const o = this.#o;
    const hub = o.devices.find(o.hubId());
    const build = this.build();
    return `${o.instance()}, data home ${o.home}, on ${hub ? `“${hub.name}”` : hostname()} (${platform()}), ${o.role() === 'hub' ? 'the hub' : 'a standby copy of the hub'}. Nova ${o.version}${build ? ` (build ${build})` : ''}. Privacy setting: ${o.profile.privacyDefault()}.`;
  }

  #personLine(): string {
    const i = identityOf(this.#o.profile);
    const m = this.#o.memory.counts();
    const who = i.user_name ? `${i.user_name}${i.address_as && i.address_as !== i.user_name ? ` (call them ${i.address_as})` : ''}` : 'name not given yet';
    return `${who}; timezone ${i.timezone ?? 'not set'}; your name here: ${i.name}; tone: ${i.directness}, ${i.warmth}, ${i.proactivity}. Setup ${this.#o.setupDone() ? 'finished' : 'not finished'}. Memory: ${m.active} ${m.active === 1 ? 'memory' : 'memories'}${m.unreviewed ? `, ${m.unreviewed} waiting for their review` : ''}.`;
  }

  #chatLine(): string {
    const h = this.#o.providers.chat();
    if (h) return `${h.name}${h.model ? `, model ${h.model}` : ''}. ${h.where}`;
    const c = this.#o.chat;
    return c ? `the model command (${c.program}), ${c.egress === 'remote' ? 'which runs off this machine' : 'which runs on your devices'}.` : 'the model command (agent_cmd).';
  }

  #providerViews() {
    try { return this.#o.providers.list(); } catch { return []; }
  }

  #providersLine(): string {
    const all = this.#providerViews();
    const chat = this.#chatId();
    const on = all.filter((p) => p.enabled || p.id === chat);
    const off = all.filter((p) => !on.includes(p));
    const one = (p: (typeof all)[number]) => `${p.name} (${p.class}${p.id === chat ? ', your chat model' : ''}${p.model && p.model !== p.id ? `, model ${p.model}` : ''}${addressOf(p.config)}): ${bare(p.health.words)}`;
    return `in use: ${on.length ? on.map(one).join('; ') : 'none'}. Off: ${off.length ? off.map((p) => p.name).join(', ') : 'none'}.`;
  }

  // The chat model's provider: the one the person chose, or the model command (custom-cli), which
  // chats whether or not it is turned on as a worker.
  #chatId(): string | null {
    try { return this.#o.providers.choices().chat.current; } catch { return null; }
  }

  async #runtime(): Promise<Runtime> {
    const at = Date.now();
    if (this.#cached && at - this.#cached.at < RUNTIME_TTL_MS) return this.#cached.value;
    const url = this.#o.models.hubUrl();
    let value: Runtime;
    try {
      const o = new Ollama(url);
      const version = await o.version(AbortSignal.timeout(1500));
      const models = (await o.tags()).map((m) => m.name);
      value = { url, ok: true, version, models, problem: null };
    } catch (e) {
      value = { url, ok: false, version: null, models: [], problem: plain((e as Error).message) };
    }
    this.#cached = { at, value };
    return value;
  }

  async #runtimeLine(): Promise<string> {
    const r = await this.#runtime();
    const where = `Ollama at ${hostOf(r.url)}`;
    const head = r.ok ? `${where} answers (version ${r.version}), ${r.models.length} ${r.models.length === 1 ? 'model' : 'models'}${r.models.length ? `: ${list(r.models)}` : ''}.` : `${where} doesn’t answer: ${quote(r.problem)}.`;
    const roles = ROLES.map((role) => { const p = this.#o.models.placement(role); return p ? `${ROLE_WORDS[role].name.toLowerCase()} → ${p.model}${p.device === 'hub' ? '' : ` on ${this.#o.devices.find(p.device)?.name ?? 'a paired computer'}`}` : null; }).filter(Boolean) as string[];
    const cloud = this.#o.models.cloud();
    return `${head} Roles: ${roles.length ? roles.join(', ') : 'none assigned'}. Cloud model: ${cloud ? `${cloud.name} (${cloud.model} at ${hostOf(cloud.base_url)}${cloud.api_key ? ', key saved' : ''})` : 'none'}.`;
  }

  #connectorsLine(): string {
    let views;
    try { views = this.#o.connectors.list(); } catch { return 'couldn’t be read.'; }
    if (!views.length) return 'none installed.';
    return views.map((c) => `${c.name}: ${c.broken ? 'was connected, but the service no longer lets Nova in' : c.connected ? `connected${c.live && c.live !== 'off' ? `, ${c.live}` : ''}` : 'not connected'}${c.allowed ? '' : ` (${plain(c.blocked).replace(/[.\s]+$/, '') || 'not allowed by your privacy setting'})`}`).join('; ') + '.';
  }

  #captureLine(): string {
    const sources = this.#o.capture.sources();
    if (!sources.length) return 'no sources set up; Nova sees nothing on your devices.';
    return sources.map((s) => {
      const state = !s.enabled ? 'off' : s.paused ? 'paused' : STATUS_WORDS[s.status] ?? s.status;
      return `${s.name} on ${s.device.name ?? 'a device'}: ${state}${s.enabled && s.detail ? `: ${quote(s.detail)}` : ''}`;
    }).join('; ') + '.';
  }

  #devicesLine(): string {
    const all = this.#o.devices.list().filter((d) => d.trust === 'trusted');
    const others = all.filter((d) => d.role !== 'hub');
    if (!others.length) return 'only this hub; no other devices paired.';
    return `${others.length} paired besides the hub: ${list(others.map((d) => `${d.name} (${d.kind}, ${this.#o.online(d) ? 'online' : 'offline'})`))}.`;
  }

  #schedulesLine(): string {
    const now = this.#now();
    const s = this.#era2.schedules?.() ?? [];
    const rules = this.#o.triggers.listRules();
    const sched = s.length ? s.map((x) => `${x.name} (${x.error ? `can’t run: ${quote(x.error)}` : `${x.when}${x.paused ? ', paused' : ''}`}${x.last ? `, last run ${x.last.missed ? 'missed' : x.last.ok === false ? `failed ${ago(x.last.ts, now)}: ${quote(x.last.error)}` : `ok ${ago(x.last.ts, now)}`}` : ''})`).join('; ') : 'No schedules';
    const r = rules.length ? `${rules.length} automation ${rules.length === 1 ? 'rule' : 'rules'}: ${list(rules.map((x) => `${x.name} (${x.class}${x.schedule ? `, ${x.schedule}` : ''}${x.paused ? ', paused' : ''})`))}` : 'no automation rules';
    return `${sched}; ${r}.`;
  }

  #approvalsLine(): string {
    const p = this.#era2.permissions?.() ?? [];
    const lower = (t: string) => t.replace(/^\w/, (c) => c.toLowerCase());
    const yes = p.filter((x) => x.yes).map((x) => lower(x.label));
    const ask = p.filter((x) => !x.yes).map((x) => lower(x.label));
    return `${ask.length ? `asks first to ${ask.join('; ')}` : 'asks first for nothing listed'}. ${yes.length ? `Goes ahead without asking to ${yes.join('; ')}.` : 'Nothing is allowed without asking.'} Anything that can’t be undone always asks.`;
  }

  #appearanceLine(): string {
    const a = this.#o.design.active();
    const names = this.#o.design.list().map((d) => d.name);
    return `${a.name}${a.scope === 'default' ? ' (the default)' : ''}, mode ${a.mode}; installed: ${list(names, 12)}. You can’t change it from chat; the person does in Settings › Appearance.`;
  }

  #problemsLine(): string {
    const open = this.#o.log.problems({ open: true });
    if (!open.length) return 'none.';
    // The first sentence of each: the rest is in the Health view, and the tools quote it whole.
    const first = (m: string) => plain(m).match(/^.*?[.!?](?=\s|$)/)?.[0] ?? plain(m);
    return `${open.length}; latest: ${open.slice(0, 2).map((p) => `${p.source}: ${quote(first(p.message))}`).join('; ')}.`;
  }

  // A fresh Nova says so, names its home, and offers the way in for what the person already knows.
  #freshLines(): string[] {
    const imports = this.imports();
    const out: string[] = [];
    if (this.#o.memory.counts().active === 0) {
      out.push(`- First run: this Nova is fresh. Its memory is empty, so beyond the profile above you know nothing about the person yet. When you greet them or they ask what you know about them, say so plainly, say it runs from ${this.#o.home}, and offer the import path up front: they can paste notes here, or put a file (notes, an export from another assistant, or a Nova memory export) in ~/${IMPORT_DIR}/, and you read it and suggest memories they review in Memory.`);
    }
    for (const p of imports.packs) out.push(`- Found in ~/${IMPORT_DIR}/: a Nova memory export, ${p.path} (${p.count} ${p.count === 1 ? 'memory' : 'memories'}${p.exported_at ? `, exported ${p.exported_at.slice(0, 10)}` : ''}). Offer to load it with memory_import; the person approves, and the memories arrive in Memory for their review.`);
    if (imports.files.length) out.push(`- Also in ~/${IMPORT_DIR}/: ${list(imports.files.map((f) => f.path))}. Read one with read_file to distill it into memories.`);
    return out;
  }

  build(): string | null {
    if (this.#build !== undefined) return this.#build;
    try {
      this.#build = execFileSync('git', ['-C', this.#o.codeRoot, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null;
    } catch {
      this.#build = null;
    }
    return this.#build;
  }

  // ---- the status tools ------------------------------------------------------------------------

  // nova_instance: who and what this Nova is, its models (checked now), connections and problems.
  async instance(): Promise<string> {
    // An enabled provider never checked is checked now, briefly: what "reachable" means is what
    // Nova found, not what it assumes.
    const unchecked = this.#providerViews().filter((p) => p.enabled && p.health.state === 'unchecked');
    if (unchecked.length) {
      await Promise.race([Promise.allSettled(unchecked.map((p) => this.#o.providers.check(p.id))), new Promise((r) => setTimeout(r, CHECK_WAIT_MS).unref())]);
    }
    this.#cached = null;
    const chat = this.#chatId();
    const providers = this.#providerViews().map((p) => `- ${p.name} [${p.id}]: ${p.enabled ? 'on' : p.id === chat ? 'in use' : 'off'}${p.id === chat ? ', your chat model' : ''}; ${p.class}${addressOf(p.config)}${p.model ? `; model ${p.model}` : ''}; ${plain(p.egress.words)} Health: ${plain(p.health.words)}${p.health.checked_at ? ` (checked ${ago(p.health.checked_at, this.#now())})` : ''}`);
    const out = [
      `Instance: ${this.#instanceLine()}`,
      `Person: ${this.#personLine()}`,
      `Chat model: ${this.#chatLine()}`,
      'Model providers:',
      ...providers,
      `Local models: ${await this.#runtimeLine()}`,
      `Connections: ${this.#connectorsLine()}`,
      `Open problems: ${this.#problemsLine()}`,
    ];
    return redactText(out.join('\n'));
  }

  // nova_capture: each source's status in its own words, and capture's recent errors quoted.
  capture(): string {
    const now = this.#now();
    const sources = this.#o.capture.sources();
    const st = this.#o.capture.status();
    const lines = sources.length ? sources.map((s) => {
      const state = !s.enabled ? 'off' : s.paused ? 'paused' : STATUS_WORDS[s.status] ?? s.status;
      return `- ${s.name} [${s.id}] (${s.adapter}${s.url ? ` at ${s.url}` : ''}, on ${s.device.name ?? 'a device'}; captures ${s.kinds.join(', ') || 'nothing yet'}): ${state}${s.status && s.enabled ? ` (status ${s.status})` : ''}${s.detail ? `. Detail: ${quote(s.detail)}` : ''}${s.checked_at ? `; checked ${ago(s.checked_at, now)}` : ''}${s.adapter === 'screenpipe' ? `; API key ${s.has_api_key ? 'saved' : 'not saved'}` : ''}`;
    }) : ['- No capture sources are set up. Nova sees nothing on any device until the person adds one in Settings › Capture.'];
    const errors = this.#o.log.problems().filter((p) => p.source === 'capture').slice(0, 5)
      .map((p) => `- ${p.at} (${p.resolved_at ? 'resolved' : 'open'}): ${quote(p.message)}`);
    return redactText([
      `Capture: ${st.active ? `capturing from ${st.capturing.length}` : 'nothing is capturing now'}; ${st.paused} paused; ${st.today} events in the last day.`,
      'Sources:', ...lines,
      `Recent capture errors: ${errors.length ? '' : 'none.'}`, ...errors,
    ].join('\n'));
  }

  // nova_devices: the hub and every paired device, trusted or revoked.
  devices(): string {
    const now = this.#now();
    const lines = this.#o.devices.list().map((d) => `- ${d.name} [${d.id}]: ${d.role === 'hub' ? 'the hub (this machine)' : d.kind}; ${d.platform || 'platform unknown'}; ${d.trust === 'revoked' ? `removed${d.revoked_reason ? ` (${plain(d.revoked_reason)})` : ''}` : this.#o.online(d) ? 'online' : `offline${d.last_seen ? `, last seen ${ago(d.last_seen, now)}` : ''}`}${d.trust === 'trusted' && d.role !== 'hub' ? `; ${d.can_approve ? 'can' : 'can’t'} approve` : ''}`);
    return redactText([`Devices (${this.#o.role() === 'hub' ? 'this is the hub' : 'this is a standby copy'}):`, ...lines].join('\n'));
  }

  // nova_schedules: Era 2's schedules with their last run, and the core's automation rules.
  schedules(): string {
    const now = this.#now();
    const s = (this.#era2.schedules?.() ?? []).map((x) => `- ${x.name} [${x.id}]: ${x.error ? `can’t run: ${quote(x.error)}` : `${x.when}${x.paused ? ' (paused)' : ''}${x.next ? `; next ${x.next}` : ''}`}; last run: ${!x.last ? 'never' : x.last.missed ? `missed (${ago(x.last.ts, now)})` : x.last.ok === false ? `failed ${ago(x.last.ts, now)}: ${quote(x.last.error)}` : `ok ${ago(x.last.ts, now)}`}`);
    const rules = this.#o.triggers.listRules().map((r) => {
      const last = this.#o.triggers.list({ rule: r.id, limit: 1 })[0];
      return `- ${r.name} [${r.id}] (${r.class}${r.schedule ? `, ${r.schedule}` : ''}${r.paused ? ', paused' : ''}): last fired ${last ? `${ago(last.at, now)}, ${last.triage.decision}: ${quote(last.triage.reason)}` : 'never'}`;
    });
    return redactText([
      'Schedules (work Nova does on its own at set times; set with schedule_set):', ...(s.length ? s : ['- none']),
      'Automation rules (Automations view):', ...(rules.length ? rules : ['- none']),
    ].join('\n'));
  }

  // nova_settings: one part of the settings, secrets shown only as set or not.
  settings(part?: unknown): string {
    const want = typeof part === 'string' ? part.trim().toLowerCase() : '';
    const extra: Record<string, () => string> = {
      appearance: () => {
        const a = this.#o.design.active();
        return [`Active: ${a.name} [${a.id}] (${a.scope === 'default' ? 'the default' : a.scope === 'device' ? 'this device only' : 'the person’s choice'}), mode ${a.mode}.`, 'Installed design systems:', ...this.#o.design.list().map((d) => `- ${d.name} [${d.id}]${d.active ? ' (active)' : ''}`), 'Changing it is the person’s, in Settings › Appearance; there is no chat tool for it.'].join('\n');
      },
      permissions: () => {
        const p = this.#era2.permissions?.() ?? [];
        return ['What Nova may do without asking (Settings › Without asking, ~/permissions.md):', ...(p.length ? p.map((x) => `- ${x.label} [${x.id}]: ${x.yes ? 'yes, without asking' : 'asks first'}`) : ['- nothing listed']), `Running a brief’s test command: ${this.#o.profile.get<string>('policy', 'task_tests') === 'allow' ? 'without asking' : 'asks first'}. Anything that can’t be undone always asks.`].join('\n');
      },
      privacy: () => `Privacy setting: ${this.#o.profile.privacyDefault()} (local-only: nothing leaves your devices; local-preferred: local first, the cloud when needed; cloud-allowed).`,
    };
    const parts = [...new Set([...Object.keys(extra), ...SECTIONS.filter((s) => s !== 'setup')])];
    if (!want) return `Settings parts: ${parts.join(', ')}. Ask for one by name.`;
    if (extra[want]) return redactText(extra[want]!());
    if (!SECTIONS.includes(want as Section) || want === 'setup') throw new CoreError('validation', `There’s no settings part called ${want}. Parts: ${parts.join(', ')}.`);
    const rows = Object.entries(this.#o.profile.section(want as Section)).map(([k, v]) => `- ${k}: ${shown(k, v)}`);
    return redactText([`Settings › ${want}:`, ...(rows.length ? rows : ['- nothing set; defaults apply'])].join('\n'));
  }

  // ---- imports ---------------------------------------------------------------------------------

  // What sits in ~/workspace/import/: Nova memory exports (packs) and other files to read.
  imports(): { packs: { path: string; count: number; exported_at: string | null }[]; files: { path: string; bytes: number }[] } {
    const root = join(this.#o.home, IMPORT_DIR);
    const packs: { path: string; count: number; exported_at: string | null }[] = [];
    const files: { path: string; bytes: number }[] = [];
    if (!existsSync(root)) return { packs, files };
    const walk = (dir: string, depth: number) => {
      let names: string[] = [];
      try { names = readdirSync(dir).sort(); } catch { return; }
      for (const name of names) {
        if (name.startsWith('.') || name === 'README.md') continue;
        const abs = join(dir, name);
        let st;
        try { st = lstatSync(abs); } catch { continue; }
        if (st.isSymbolicLink()) continue;
        if (st.isDirectory()) { if (depth < 2) walk(abs, depth + 1); continue; }
        const rel = relative(join(this.#o.home, 'workspace'), abs).split(sep).join('/');
        const pack = name.endsWith('.json') ? readPack(abs) : null;
        if (pack) packs.push({ path: `workspace/${rel}`, count: pack.records.length, exported_at: pack.exported_at });
        else files.push({ path: `workspace/${rel}`, bytes: st.size });
      }
    };
    walk(root, 0);
    return { packs: packs.slice(0, 5), files: files.slice(0, 20) };
  }

  // A Nova memory export in ~/workspace/import/, checked: what loading it would add.
  planImport(path: unknown): { path: string; total: number; fresh: number; already: number; kinds: Record<string, number>; exported_at: string | null } {
    const { abs, rel } = this.#importPath(path);
    const pack = readPack(abs);
    if (!pack) throw new CoreError('validation', `${rel} isn’t a Nova memory export (a memory.json with its records). Read it with read_file and suggest memories instead.`);
    const have = new Set(this.#o.memory.active().map((r) => plain(r.content).toLowerCase()));
    const kinds: Record<string, number> = {};
    let fresh = 0;
    for (const r of pack.records) {
      if (have.has(plain(r.content).toLowerCase())) continue;
      fresh++;
      kinds[r.kind] = (kinds[r.kind] ?? 0) + 1;
    }
    return { path: rel, total: pack.records.length, fresh, already: pack.records.length - fresh, kinds, exported_at: pack.exported_at };
  }

  // Loads it: each memory not already kept arrives unreviewed (recorded by "import"), for the
  // person to confirm, correct or forget in Memory.
  importPack(path: unknown): { path: string; imported: number; skipped: number } {
    if (this.#o.role() !== 'hub') throw new CoreError('conflict', 'This Nova is a standby copy; load memories on the hub.');
    const { abs, rel } = this.#importPath(path);
    const pack = readPack(abs);
    if (!pack) throw new CoreError('validation', `${rel} isn’t a Nova memory export.`);
    const have = new Set(this.#o.memory.active().map((r) => plain(r.content).toLowerCase()));
    let imported = 0;
    for (const r of pack.records) {
      const key = plain(r.content).toLowerCase();
      if (have.has(key)) continue;
      this.#o.memory.remember({
        kind: r.kind, content: plain(r.content), recorded_by: 'import', source: `import:${rel}`,
        ...(r.observed_at ? { observed_at: r.observed_at } : {}),
        ...(typeof r.confidence === 'number' ? { confidence: r.confidence } : {}),
      });
      have.add(key);
      imported++;
    }
    return { path: rel, imported, skipped: pack.records.length - imported };
  }

  // Only a file inside ~/workspace/import/, reached without links.
  #importPath(path: unknown): { abs: string; rel: string } {
    const p = typeof path === 'string' ? path.trim().replace(/^~\//, '') : '';
    if (!p) throw new CoreError('validation', `path is the file in ~/${IMPORT_DIR}/, like ${IMPORT_DIR}/memory.json.`);
    const root = join(this.#o.home, IMPORT_DIR);
    const abs = resolve(this.#o.home, p);
    if (!abs.startsWith(root + sep) || !existsSync(abs)) throw new CoreError('validation', `Only a file in ~/${IMPORT_DIR}/ can be loaded, and ${p} isn’t one.`);
    const real = realpathSync(abs);
    if (real !== abs || !statSync(real).isFile()) throw new CoreError('validation', `${p} isn’t a plain file in ~/${IMPORT_DIR}/.`);
    return { abs, rel: relative(this.#o.home, abs).split(sep).join('/') };
  }
}

// A setting's value, as the tools show it: a secret only as set or not.
function shown(key: string, v: unknown): string {
  if (SECRET_KEY.test(key)) return v ? '(set)' : '(not set)';
  const text = JSON.stringify(v, (k, x) => (k && SECRET_KEY.test(k) ? (x ? '(set)' : '(not set)') : x)) ?? 'null';
  return text.length > 400 ? `${text.slice(0, 400)}…` : text;
}

// A Nova memory export: { exported_at, records: [{ kind, content, … }] }, as memory.export writes.
function readPack(abs: string): { exported_at: string | null; records: { kind: MemoryKind; content: string; observed_at?: string; confidence?: number | null }[] } | null {
  try {
    if (statSync(abs).size > 20 * 1024 * 1024) return null;
    const j = JSON.parse(readFileSync(abs, 'utf8')) as { exported_at?: unknown; records?: unknown };
    if (!j || !Array.isArray(j.records)) return null;
    const records = j.records.filter((r): r is Record<string, unknown> => !!r && typeof r === 'object' && typeof (r as Record<string, unknown>).content === 'string' && !!plain((r as Record<string, unknown>).content))
      .map((r) => ({
        kind: (MEMORY_KINDS as readonly string[]).includes(String(r.kind)) ? r.kind as MemoryKind : 'fact' as MemoryKind,
        content: plain(r.content).slice(0, 2000),
        ...(typeof r.observed_at === 'string' && !Number.isNaN(Date.parse(r.observed_at)) ? { observed_at: new Date(r.observed_at).toISOString() } : {}),
        ...(typeof r.confidence === 'number' && r.confidence >= 0 && r.confidence <= 1 ? { confidence: r.confidence } : {}),
      }));
    if (!records.length && j.records.length) return null;
    return { exported_at: typeof j.exported_at === 'string' ? j.exported_at : null, records };
  } catch {
    return null;
  }
}
