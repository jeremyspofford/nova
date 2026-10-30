// The foundry (EXTENSION-MODEL, M7 plan §1): Nova authors its own extensions for a need the
// person states. A provider writes the package (the local model by default, through the model
// manager; or the person's chat model), answering with the JSON files contract (M5), and Nova
// writes those files into a folder of the foundry's own, never the person's files and never core.
// What it makes is an ordinary change: a trigger-rule pack, a decision template, a skill pack or a
// design-system variant, each with its manifest, tests and a health probe. It goes in only through
// the pipeline: proposed by the foundry, so tier 3, confirmed every time; nothing of it is live
// until it has passed every gate.
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { CoreError } from '../errors.ts';
import { ENVELOPE_VERSION, type Brief, type PrivacyMode, type Report } from '../envelope.ts';
import { CONTRACT_SYSTEM, parseContract } from '../providers/prompt.ts';
import { applyFiles } from '../providers/taskspace.ts';
import { permits, stricter } from '../workers.ts';
import { CONFIRMATION_SYSTEM, type Changes } from './pipeline.ts';
import type { ChangeKind } from './gates.ts';
import type { Ledger, LanedWorker, Task } from '../ledger.ts';
import type { Receipts } from '../receipts.ts';
import type { ChatHandle } from '../providers/registry.ts';
import { TOKEN_NAMES } from '../design.ts';

export const FOUNDRY_KINDS = Object.freeze(['trigger-rules', 'template', 'skill-pack', 'design-system'] as const);
export type FoundryKind = (typeof FOUNDRY_KINDS)[number];
export const VIA = Object.freeze(['local-model', 'chat'] as const);
export type Via = (typeof VIA)[number];

const CHANGE_KIND: Record<FoundryKind, ChangeKind> = { 'trigger-rules': 'trigger-rules', template: 'template', 'skill-pack': 'extension', 'design-system': 'design-system' };

// What the provider is asked to write, per kind: always manifest.json, tests.json and probe.json.
const FORMAT: Record<FoundryKind, string> = {
  'trigger-rules': [
    'Write three files.',
    'manifest.json: {"pack": {"id": "lowercase-id", "name": "A short name", "version": "1.0.0"}, "rules": [{"name": "…", "class": "heartbeat", "cron": "M H * * *", "action": {"kind": "message", "text": "what Nova says"}}]}',
    'tests.json: [{"name": "…", "at": "HH:MM", "expect": {"rule": "the rule’s name", "fires": true, "message": true}}, {"name": "…", "at": "HH:MM at another time", "expect": {"rule": "…", "fires": false}}]',
    'probe.json: {"name": "…", "path": "/triggers/rules", "expect": [{"at": "length", "op": "gte", "value": 1}]}',
    'Rules are heartbeat (cron: minute hour day-of-month month day-of-week) or proactive. Messages are short and plain.',
  ].join('\n'),
  template: [
    'Write three files.',
    'manifest.json: {"template_id": "lowercase-id", "version": 1, "situation": "what is decided, in plain words", "inputs": {"name": "string|number|boolean"}, "questions": [{"id": "decision", "type": "choice", "options": ["…", "unknown"]}], "escalation": {"confidence_floor": 0.6}}',
    'tests.json: [{"inputs": {…every input…}}] (dry runs)',
    'probe.json: {"name": "…", "path": "/health", "expect": [{"at": "checks.database.ok", "op": "eq", "value": true}]}',
  ].join('\n'),
  'skill-pack': [
    'Write SKILL.md and three more files.',
    'SKILL.md: front matter with name and description between --- lines, then the procedure in plain steps.',
    'manifest.json: {"id": "lowercase-id", "version": "1.0.0", "kind": "skill-pack", "name": "…", "capabilities": ["skill"], "permissions": [], "secrets": [], "config_schema": {}, "setup_flow": null, "health_check": {}, "nova_compat": ">=0.1.0", "on_remove": {"delete": ["SKILL.md"], "keep": [], "export": []}}',
    'tests.json: [{"name": "…", "file": "SKILL.md", "frontmatter": ["name", "description"]}]',
    'probe.json: {"name": "…", "path": "/extensions", "expect": [{"at": "length", "op": "gte", "value": 1}]}',
  ].join('\n'),
  'design-system': [
    'Write three files.',
    `manifest.json: a design-system package: {"id", "version", "kind": "design-system", "name", "description", "capabilities": [], "permissions": [], "secrets": [], "config_schema": {}, "setup_flow": null, "health_check": {}, "nova_compat": ">=0.1.0", "on_remove": {"delete": [], "keep": [], "export": []}, "tokens": {every token: ${TOKEN_NAMES.slice(0, 6).join(', ')}, …}}`,
    'tests.json: [] (its validation and contrast checks are its tests)',
    'probe.json: {"name": "…", "path": "/design-systems", "expect": [{"at": "length", "op": "gte", "value": 1}]}',
  ].join('\n'),
};

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

export interface FoundryOptions {
  home: string;
  ledger: Ledger;
  changes: Changes;
  receipts: Receipts;
  privacy: () => PrivacyMode;
  // The local model, by role (M6b): the default author.
  infer: (r: { role: 'reasoner'; messages: { role: 'system' | 'user'; content: string }[]; privacy_mode: PrivacyMode; task_id: string; purpose: string; format: 'json'; signal: AbortSignal }) => Promise<{ text?: string; model: string; provider: string; notes: string[] }>;
  // The person's chat model (M5a), when they ask for it instead.
  chat: () => ChatHandle | null;
}

export class Foundry {
  readonly worker: LanedWorker;
  #o: FoundryOptions;

  constructor(o: FoundryOptions) {
    this.#o = o;
    this.worker = {
      id: 'foundry',
      name: 'The foundry',
      about: 'Writes an extension for something you asked for (a rule pack, a template, a skill pack, a look), with its tests and probe, and proposes it as a change.',
      // Where its data goes is decided per brief: the local model stays on the devices; the chat
      // model goes where it is.
      egress: 'remote',
      egressFor: (brief) => (brief.inputs?.via === 'chat' ? (o.chat()?.egress ?? 'remote') : 'local'),
      evidence: ['confirmation'],
      health: () => ({ ok: true }),
      timeoutMs: 15 * 60_000,
      lane: () => ({ key: 'author', max: 1 }),
      run: (brief, signal) => this.#run(brief, signal),
    };
  }

  // The person states a need; a ledger task authors it. It is proposed as a change, and goes no
  // further than the pipeline takes it.
  request(input: { need?: unknown; kind?: unknown; via?: unknown }): Task {
    if (typeof input.need !== 'string' || input.need.trim().length < 4) throw new CoreError('validation', 'need is what you want, in your words.');
    if (!FOUNDRY_KINDS.includes(input.kind as FoundryKind)) throw new CoreError('validation', `kind is one of ${FOUNDRY_KINDS.join(', ')}.`);
    const via = (input.via ?? 'local-model') as Via;
    if (!VIA.includes(via)) throw new CoreError('validation', `via is ${VIA.join(' or ')}.`);
    const need = input.need.trim().slice(0, 2000);
    return this.#o.ledger.create({
      title: `Write a ${String(input.kind).replace('-', ' ')}: ${need.slice(0, 60)}`,
      owner: this.worker.id,
      goal: `A ${input.kind} for “${need}”, with its manifest, tests and a health probe, proposed through the change pipeline.`,
      origin: { kind: 'user' },
      evidence_required: [{ kind: 'confirmation', note: 'proposed' }],
      inputs: { need, kind: input.kind, via },
      privacy_mode: this.#o.privacy(),
      approval_tier: 1,
    });
  }

  folder(taskId: string): string {
    return join(this.#o.home, 'workers', 'foundry', taskId);
  }

  async #run(brief: Brief, signal: AbortSignal): Promise<Report> {
    const started = performance.now();
    const report = (status: Report['status'], summary: string, more: Partial<Report> = {}): Report => ({
      envelope: ENVELOPE_VERSION, task_id: brief.task_id, status, summary, evidence: [], artifacts: [], blockers: status === 'blocked' ? [summary] : [], follow_up_suggestions: [],
      ...more, usage: { ...(more.usage ?? {}), duration_ms: Math.round(performance.now() - started) },
    });
    const { need, kind, via } = (brief.inputs ?? {}) as { need: string; kind: FoundryKind; via: Via };
    const mode = stricter(brief.privacy_mode, this.#o.privacy());
    const system = CONTRACT_SYSTEM;
    const prompt = [
      `Task: Nova is writing an extension for this person. What they asked for: “${need}”.`,
      `Kind: ${kind}.`,
      FORMAT[kind],
      'Neutral wording only: no names of people, places or services the person did not give.',
    ].join('\n\n');
    let text = '';
    let author = '';
    try {
      if (via === 'chat') {
        const h = this.#o.chat();
        if (!h) return report('blocked', 'No chat model is set (Settings › Providers), so the foundry can’t ask one.');
        if (!permits(mode, h.egress)) return report('blocked', `Waiting on local capacity: ${h.name} would send this off your devices, and this is ${mode}.`);
        const r = await h.call({ system, prompt, signal, privacy: mode, receipt: { task_id: brief.task_id, purpose: `foundry: ${kind}` } });
        if (!h.ownReceipt) this.#o.receipts.record({ task_id: brief.task_id, provider: h.id, model: h.model, purpose: `foundry: ${kind}`, privacy_mode: mode, egress: h.receiptEgress, context_items: [] });
        text = r.text;
        author = `provider:${h.id}`;
      } else {
        const r = await this.#o.infer({ role: 'reasoner', messages: [{ role: 'system', content: system }, { role: 'user', content: prompt }], privacy_mode: mode, task_id: brief.task_id, purpose: `foundry: ${kind}`, format: 'json', signal });
        text = r.text ?? '';
        author = `${r.provider}:${r.model}`;
      }
    } catch (e) {
      if (signal.aborted) throw e;
      const m = (e as Error).message;
      return /^Waiting/.test(m) ? report('blocked', m) : report('failed', `The model couldn’t write it: ${m}`);
    }
    // The provider's files, written by Nova into the foundry's own folder (path checks: M5's).
    const dir = this.folder(brief.task_id);
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    let written: string[];
    try { written = applyFiles(dir, parseContract(text).files); } catch (e) { return report('failed', `Nova didn’t take the model’s reply: ${(e as Error).message}`); }
    let artifact: Record<string, unknown>;
    try { artifact = this.#package(kind, dir, written); } catch (e) { return report('failed', `What the model wrote isn’t a package Nova can propose: ${(e as Error).message}`); }
    let change;
    try {
      change = this.#o.changes.propose({ kind: CHANGE_KIND[kind], artifact }, { by: 'foundry', author });
    } catch (e) {
      return report('failed', `The pipeline didn’t take it: ${(e as Error).message}`);
    }
    return report('done', `Wrote “${change.title}” v${change.version} (${written.join(', ')}) and proposed it. It is checked in a sandbox, then waits for your OK.`, {
      evidence: [{ kind: 'confirmation', system: CONFIRMATION_SYSTEM, id: `${change.id}@proposed` }],
      artifacts: written.map((f) => ({ kind: 'file', ref: `foundry:${brief.task_id}/${f}` })),
    });
  }

  // The change from the files: manifest, tests and probe are required, whatever the kind.
  #package(kind: FoundryKind, dir: string, written: string[]): Record<string, unknown> {
    const read = (f: string) => {
      if (!existsSync(join(dir, f))) throw new CoreError('validation', `${f} is missing.`);
      try { return JSON.parse(readFileSync(join(dir, f), 'utf8')) as unknown; } catch { throw new CoreError('validation', `${f} isn’t valid JSON.`); }
    };
    const manifest = read('manifest.json');
    const tests = read('tests.json');
    const probe = read('probe.json');
    if (!isObj(manifest)) throw new CoreError('validation', 'manifest.json must be an object.');
    if (!Array.isArray(tests)) throw new CoreError('validation', 'tests.json must be a list.');
    if (kind === 'trigger-rules') return { pack: manifest.pack, rules: manifest.rules, tests, probe };
    if (kind === 'template') return { template: manifest, dry_runs: tests, probe };
    if (kind === 'design-system') return { manifest, probe };
    const files: Record<string, string> = {};
    for (const f of written) if (!['manifest.json', 'tests.json', 'probe.json'].includes(f)) files[f] = readFileSync(join(dir, f), 'utf8');
    return { manifest, files, tests, probe };
  }
}
