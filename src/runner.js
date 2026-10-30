// The session runner: one agent loop per conversation turn.
//
//   memory search → model call (streamed) → tool call? → approval? → run tool
//   → model call again … until the model replies without a tool call.
//
// Every step is appended to the session's JSONL log as it happens. Live state
// (streaming text, a pending approval) is held in memory and broadcast; if the
// process dies mid-turn, the log still shows exactly how far it got.
import { EventEmitter } from 'node:events';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { runAgent, AgentError } from './agent.js';
import { Ingest, cleanOrigin, escapeProtocol, permits } from './core/index.ts';
import { buildPrompt, buildSystem, helperSection, runSection, schedulesSection, skillsSection } from './context.js';
import { Memory } from './memory.js';
import { Skills } from './skills.js';
import { Schedules } from './schedules.js';
import { Gmail, googleEndpoints } from './connectors/gmail.js';
import { Permissions, permissionFor, permissionsSection } from './permissions.js';
import { commitHome, readStanding } from './home.js';
import { TOOLS, ToolTagFilter, WRITABLE, availableTools, extractMemory, homeTarget, parseToolCall, withinPrivacy } from './tools.js';
import { reduce, titleFrom } from '../ui/js/reduce.js';
import { stricter } from './chat-run.js';

const shortId = () => randomUUID().slice(0, 8);
const sha256 = (s) => createHash('sha256').update(s).digest('hex');
const hostOf = (u) => { try { return new URL(String(u)).hostname; } catch { return String(u ?? '').slice(0, 100); } };

// The ingest gate (Amendment 2026-10-30-C Part 3). While a run has read outside content (its
// taint), these steps never run on their own, whatever permissions.md says: each asks the person,
// and the request names the outside source that led to it.
export const GUARDED = {
  exec: 'run a command',
  gmail_draft: 'write an email',
  gmail_organize: 'change your mail',
  schedule_set: 'change a schedule',
  schedule_remove: 'change a schedule',
};
// The person's own files: never screened when read (their writes are guarded instead).
const STANDING_EXACT = new Set([...WRITABLE, 'MEMORY.md']);
const STANDING = new Set([...STANDING_EXACT].map((n) => n.normalize('NFC').toLowerCase()));
// Addresses in text, and an address as compared: no fragment, the URL parser's own spelling.
const URL_IN_TEXT = /https?:\/\/[^\s<>"'`)\]}]+/gi;
const normUrl = (u) => { try { const x = new URL(String(u ?? '').replace(/[.,;:!?]+$/, '')); x.hash = ''; return x.href; } catch { return null; } };
const OWN_TOP = new Set(['memory', 'schedules', 'permissions.md']);

// A page's links, absolute, at most 500.
function pageLinks(html, base) {
  const out = new Set();
  for (const m of String(html).matchAll(/\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi)) {
    try { const u = new URL((m[1] ?? m[2] ?? m[3] ?? '').replace(/&amp;/g, '&'), base); if (/^https?:$/.test(u.protocol)) { u.hash = ''; out.add(u.href); } } catch { /* not an address */ }
    if (out.size >= 500) break;
  }
  return [...out];
}

export class Runner extends EventEmitter {
  // records: the core's memory, where MEMORY.md's entries live (passed in by the server). vault: the
  // core's, where connection secrets live.
  // ingest: the core's screen (core.ingest); without a core, Nova's own checks alone, which never
  // pass anything as plain data. fetchAllow: for tests alone (a stand-in page on this machine);
  // nothing the model says can set it.
  constructor(config, store, { agent = runAgent, records = null, vault = null, ingest = null, fetchAllow = null } = {}) {
    super();
    this.config = config;
    this.store = store;
    this.agent = agent;
    this.ingest = ingest ?? new Ingest({ db: null });
    this.fetchAllow = fetchAllow;
    this.active = new Map(); // sessionId → live run
    this.memory = new Memory(config.home, config.timezone, { records });
    this.skills = new Skills(config.root, config.home);
    this.schedules = new Schedules(config.root, config.home, config.timezone);
    this.gmail = new Gmail(config.home, { endpoints: googleEndpoints(config.googleBase), imapUrl: config.imapUrl, timezone: config.timezone, vault });
    this.permissions = new Permissions(config.home, () => TOOLS);
    this.helpers = null; // set by the server: where delegate hands work
  }

  record(sessionId, ev) {
    const line = this.store.append(sessionId, ev);
    this.emit('event', sessionId, line);
    return line;
  }

  setLive(sessionId, patch) {
    const run = this.active.get(sessionId);
    if (!run) return;
    Object.assign(run.live, patch);
    this.emit('live', sessionId, { ...run.live });
  }

  liveState(sessionId) {
    const run = this.active.get(sessionId);
    return run ? { ...run.live } : null;
  }

  snapshot(sessionId) {
    return { session: reduce(this.store.read(sessionId), sessionId), live: this.liveState(sessionId) };
  }

  createSession(text) {
    const id = this.store.newId();
    this.record(id, { type: 'session', id, title: titleFrom(text), v: 1 });
    return id;
  }

  // The main conversation: where reports from schedules arrive, and what the
  // front page shows. It exists from the first start.
  ensureMain() {
    if (!this.store.exists('main')) this.record('main', { type: 'session', id: 'main', title: 'Main conversation', kind: 'main', v: 1 });
  }

  // unattended: { id, name, due, late } for a scheduled run. helper:
  // { title, files } for a helper's work. Either way no one is there to
  // approve anything. privacy: the Work Ledger task's mode, for work the
  // chat-run worker does; the run keeps to the stricter of it and the setting.
  // taint: the outside content this run starts from (a helper handed work by a run that had read
  // some), kept with its first message.
  send(sessionId, text, { unattended = null, helper = null, followup = null, privacy = null, taint = null } = {}) {
    if (this.active.has(sessionId)) throw new BusyError();
    const turn = shortId();
    this.record(sessionId, { type: 'user', turn, text, ...(unattended ? { schedule: unattended.id } : {}), ...(followup ? { followup } : {}), ...(taint?.length ? { taint } : {}) });
    this.start(sessionId, turn, 0, { unattended, helper, privacy });
    return turn;
  }

  // What a run (scheduled, or a helper's) hands back: its writing after the
  // last tool it used, or why there's none.
  report(sessionId) {
    const turn = reduce(this.store.read(sessionId)).turns[0];
    if (!turn) return { ok: false, text: '', failure: 'It never started.', stopped: false };
    const lastTool = turn.items.findLastIndex((i) => i.kind === 'tool');
    const text = turn.items.slice(lastTool + 1).filter((i) => i.kind === 'text').map((i) => i.text).join('\n\n').trim();
    const stopped = turn.state === 'stopped';
    const failure = turn.items.find((i) => i.kind === 'error')?.message
      ?? (stopped ? 'Nova was stopped before it finished.' : !text ? 'It finished without writing a report.' : '');
    return { ok: turn.state === 'done' && !!text, text, failure, stopped };
  }

  // Nova's own word on a report that just arrived: a turn with no message
  // from the person, started once the conversation is free.
  async followUp(sessionId, handoff) {
    for (;;) {
      await this.idle(sessionId);
      try { return this.send(sessionId, '', { followup: handoff }); } catch (e) { if (!(e instanceof BusyError)) throw e; }
    }
  }

  // Resolves once the conversation has no reply in progress.
  async idle(sessionId) {
    while (this.active.has(sessionId)) await this.active.get(sessionId).done;
  }

  // A report from scheduled work, added to a conversation between replies.
  async deliver(sessionId, handoff) {
    if (sessionId === 'main') this.ensureMain();
    await this.idle(sessionId);
    const line = this.record(sessionId, handoff);
    if (this.config.commit !== false) await commitHome(this.config.home, `Nova: ${handoff.name} report`);
    return line;
  }

  regenerate(sessionId) {
    if (this.active.has(sessionId)) throw new BusyError();
    const session = reduce(this.store.read(sessionId));
    const last = session.turns.at(-1);
    if (!last || last.kind === 'handoff') throw new Error('Nothing to regenerate');
    const attempt = last.attempt + 1;
    this.record(sessionId, { type: 'attempt', turn: last.id, attempt });
    this.start(sessionId, last.id, attempt);
    return last.id;
  }

  stop(sessionId) {
    const run = this.active.get(sessionId);
    if (!run) return false;
    run.controller.abort();
    return true;
  }

  decide(sessionId, toolId, decision) {
    const run = this.active.get(sessionId);
    if (!run?.pending || run.pending.id !== toolId) return false;
    run.pending.resolve(decision === 'allow' ? 'allow' : 'deny');
    return true;
  }

  start(sessionId, turn, attempt, { unattended = null, helper = null, privacy = null } = {}) {
    const controller = new AbortController();
    // skills: the playbooks this reply follows. taint: the outside content this conversation has
    // read (the ingest gate). alone: no one is there to approve anything.
    const run = { controller, pending: null, skills: new Map(), taint: [], unattended, helper, privacy, alone: !!(unattended || helper), live: { turn, attempt, phase: 'thinking', text: '', approval: null } };
    this.active.set(sessionId, run);
    this.emit('live', sessionId, { ...run.live });
    run.done = this.loop(sessionId, run)
      .catch((e) => {
        this.record(sessionId, { type: 'error', turn, attempt, message: e instanceof AgentError ? e.message : 'Something went wrong inside Nova.', detail: e.detail ?? e.message });
      })
      .finally(() => {
        this.active.delete(sessionId);
        this.emit('live', sessionId, null);
        if (this.config.commit !== false) return commitHome(this.config.home, `Nova: ${sessionId} turn ${turn}`);
      });
  }

  // The chat model the provider registry names (M5a), or null for agent_cmd, which this runner
  // runs itself exactly as Era 2 did. Set by the server: { id, name, egress, receiptEgress, model, call }.
  chat() {
    return this.chatProvider?.() ?? null;
  }

  // Privacy first (LOCAL-FIRST-AND-DEVICE-MESH §2): a model that would send this conversation
  // somewhere the setting (or the run's own, stricter mode) doesn't allow is never called. Nothing
  // has been sent when this throws.
  privacyFor(run) {
    const setting = this.identity?.privacy?.() ?? 'local-only';
    const mode = run.privacy ? stricter(run.privacy, setting) : setting;
    const chat = this.chat();
    if (chat && !permits(mode, chat.egress)) {
      throw new AgentError(
        `Your privacy setting is ${mode}, and the model I chat with (${chat.name}) sends conversations off your devices, so I haven't sent this anywhere. Choose a local model in Settings › Providers, or allow cloud help in your privacy setting.`,
        `provider=${chat.id}; egress=${chat.receiptEgress}; privacy=${mode}`,
      );
    }
    if (!chat && !permits(mode, this.config.agentEgress)) {
      const program = this.config.agentCmd.trim().split(/\s+/).find((w) => !w.includes('=')) ?? 'the model command';
      throw new AgentError(
        `Your privacy setting is ${mode}, and the model I chat with (${program}) runs in the cloud, so I haven't sent this anywhere. Add a local model (agent_cmd with agent_egress set to local), or allow cloud help in your privacy setting.`,
        `agent_egress=${this.config.agentEgress}; privacy=${mode}`,
      );
    }
    return mode;
  }

  receipt(sessionId, run, mode, { system, prompt, recall }) {
    const hash = (s) => createHash('sha256').update(String(s)).digest('hex');
    const program = this.config.agentCmd.trim().split(/\s+/).find((w) => !w.includes('=')) ?? 'model';
    // "/usr/local/bin/Claude" → "claude": the receipt names a provider, not a path.
    const name = program.split('/').pop().toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^[^a-z0-9]+/, '').slice(0, 64) || 'model';
    const chat = this.chat();
    return {
      session_id: sessionId,
      provider: chat?.id ?? name,
      model: chat?.model ?? name,
      purpose: run.helper ? 'helper' : run.unattended ? 'scheduled run' : 'chat',
      privacy_mode: mode,
      egress: chat ? chat.receiptEgress : this.config.agentEgress === 'remote' ? `remote:${name}` : 'local',
      context_items: [
        { kind: 'file', ref: 'system prompt', sha256: hash(system) },
        ...readStanding(this.config.home).filter((f) => !(run.helper && f.name === 'MEMORY.md')).map((f) => ({ kind: 'standing', ref: `~/${f.name}`, sha256: hash(f.text) })),
        ...recall.map((n) => ({ kind: 'memory', ref: n.id ?? n.source, sha256: hash(n.text) })),
        ...[...run.skills.values()].map((s) => ({ kind: 'skill', ref: s.id, sha256: hash(s.body ?? '') })),
        { kind: 'session', ref: sessionId, sha256: hash(prompt) },
      ],
    };
  }

  async loop(sessionId, run) {
    const { turn, attempt } = run.live;
    const tag = { turn, attempt };
    const { signal } = run.controller;
    const before = reduce(this.store.read(sessionId));
    const question = before.turns.find((t) => t.id === turn).text;
    let mode = this.privacyFor(run);
    // Outside content read anywhere in this conversation is still in its context, so the run
    // starts with that taint (and a helper's report brings its run's).
    run.taint = this.taintOf(before);
    // A helper's files: the person's own as they are; any other workspace file is screened.
    if (run.helper?.files?.length) await this.screenFiles(sessionId, tag, run);

    // The log keeps where each note came from, not its words: what is
    // forgotten later stays gone from the conversation view too. A helper's
    // context is scoped to its brief, so it recalls nothing.
    const recall = run.helper ? [] : this.memory.search(question);
    if (recall.length) this.record(sessionId, { type: 'recall', ...tag, notes: recall.map(({ id, source }) => ({ id, source })) });
    for (const s of this.skills.match(question).filter((x) => !this.ingest.held('skill', x.id))) this.follow(sessionId, tag, run, s, 'matched');

    for (let step = 0; step <= this.config.maxSteps; step++) {
      // Again before every model call: the setting can tighten while a run waits for an OK.
      mode = this.privacyFor(run);
      const session = reduce(this.store.read(sessionId));
      // A skill from outside that the screen held back isn't offered until the person turns it on.
      const installed = this.skills.installed().filter((x) => !this.ingest.held('skill', x.id));
      // Helpers and scheduled runs can't hand work to helpers of their own,
      // and a helper doesn't touch schedules.
      const tools = withinPrivacy(availableTools({ gmail: this.gmail.status().connected, skills: installed.length, delegate: !run.alone && !!this.helpers }), mode)
        .filter((n) => !(run.helper && n.startsWith('schedule_')));
      const skills = skillsSection(installed, [...run.skills.values()], (c) => this.skills.connectorDoc(c));
      const schedules = run.helper ? '' : schedulesSection(this.schedules.list(), this.config.timezone);
      const allowed = run.alone ? permissionsSection(this.permissions.list()) : '';
      const scheduled = run.unattended ? runSection(run.unattended, this.config.timezone, allowed) : '';
      const helper = run.helper ? helperSection(run.helper, allowed) : '';
      const filter = new ToolTagFilter();
      this.setLive(sessionId, { phase: 'thinking', text: '' });
      let streamed = '';
      // MEMORY.md may have been edited by hand since Nova last wrote it: take that in first.
      if (this.memory.records) this.memory.sync();
      const system = buildSystem(this.config, new Date(), { tools, skills, schedules, scheduled, helper, ...(this.identity ? { identity: this.identity.persona() } : {}) });
      const prompt = buildPrompt(session, recall, this.config, this.identity?.name() ?? 'Nova');
      // A context receipt for every model call (CONTRACTS §2): what went into it, by reference and
      // hash, and where it went. Written before the call, so it exists even if the call fails.
      // A chat model that writes its own receipts (Nova's local models, M6b) gets the draft instead:
      // it knows where each call really went, local or the cloud fallback.
      const chat = this.chat();
      const draft = this.receipt(sessionId, run, mode, { system, prompt, recall });
      if (!chat?.ownReceipt) this.identity?.receipt?.(draft);
      const { text, aborted } = await (chat ? (o) => chat.call(o) : this.agent)({
        ...(chat?.ownReceipt ? { receipt: draft, privacy: mode } : {}),
        cmd: this.config.agentCmd,
        system,
        prompt,
        signal,
        onText: (chunk) => {
          const visible = filter.push(chunk);
          if (!visible) return;
          streamed += visible;
          this.emit('delta', sessionId, { turn, attempt, text: visible });
          if (run.live.phase !== 'streaming') this.setLive(sessionId, { phase: 'streaming' });
          run.live.text = streamed;
        },
      });

      if (aborted) {
        if (streamed.trim()) this.record(sessionId, { type: 'assistant', ...tag, id: shortId(), text: streamed.trim() });
        this.record(sessionId, { type: 'stopped', ...tag });
        return;
      }

      const { text: said, ops } = extractMemory(text);
      const { visible, call, error } = parseToolCall(said, tools);
      if (visible) this.record(sessionId, { type: 'assistant', ...tag, id: shortId(), text: visible });
      run.live.text = '';
      if (ops.length && !run.helper) this.keep(sessionId, tag, ops, run); // memory is kept in the conversation that asked
      if (!call && !error) { this.record(sessionId, { type: 'done', ...tag }); return; }

      if (step === this.config.maxSteps) {
        this.record(sessionId, { type: 'error', ...tag, message: `Nova stopped after ${this.config.maxSteps} tool steps in one reply, to stay safe.`, detail: 'max_tool_steps reached' });
        return;
      }

      const id = shortId();
      const tool = TOOLS[call?.name];
      let page = null;
      const ctx = {
        home: this.config.home, signal, timeoutMs: this.config.execTimeoutMs, searchUrl: this.config.searchUrl,
        gmail: this.gmail, useSkill: (name) => this.useSkill(sessionId, tag, run, name),
        schedules: this.schedules, sessionId,
        // A helper started from a run that read outside content starts with that taint.
        delegate: (args) => this.helpers.spawn({ ...args, parent: sessionId, turn, taint: run.taint }),
        seen: (p) => { page = p; },
        ...(this.fetchAllow ? { fetchAllow: this.fetchAllow } : {}),
      };
      // A tool that changes something outside Nova shows exactly what will
      // change before the person decides; if that can't be worked out, it fails here.
      let failed = error;
      let preview;
      if (!failed && tool.preview) {
        this.setLive(sessionId, { phase: 'tool' });
        try { preview = await tool.preview(call.args, ctx); } catch (e) { failed = e.message; }
      }
      // The ingest gate: a guarded step in a tainted run, or anything that would carry something
      // of the person's out, asks, and never goes on its own.
      const guard = failed ? null : this.guardFor(call, tool, run, preview, session);
      const needsApproval = !failed && (!!tool?.needsApproval || !!guard);
      this.record(sessionId, { type: 'tool_call', ...tag, id, name: call?.name ?? 'unknown', args: call?.args ?? {}, needs_approval: needsApproval, ...(preview ? { preview } : {}), ...(guard ? { guard } : {}) });
      if (failed) {
        this.record(sessionId, { type: 'tool_result', ...tag, id, ok: false, output: failed });
        continue;
      }

      // A step the person lets Nova take without asking (Settings) goes ahead.
      // Otherwise Nova asks and waits, even with no one watching: a scheduled
      // run or a helper waits for the answer, and Activity shows it waiting.
      if (needsApproval && !guard && this.permissions.allows(permissionFor(call.name, tool))) {
        this.record(sessionId, { type: 'approval', ...tag, id, decision: 'allow', auto: true });
      } else if (needsApproval) {
        this.setLive(sessionId, { phase: 'approval', approval: id });
        const decision = await new Promise((resolve) => {
          run.pending = { id, resolve };
          signal.addEventListener('abort', () => resolve('abort'), { once: true });
        });
        run.pending = null;
        this.setLive(sessionId, { approval: null });
        if (decision === 'abort') { this.record(sessionId, { type: 'stopped', ...tag }); return; }
        this.record(sessionId, { type: 'approval', ...tag, id, decision });
        if (decision === 'deny') continue;
      }

      this.setLive(sessionId, { phase: 'tool' });
      let output;
      let summary;
      let link;
      let hints = null;
      let ok = true;
      const taintedBefore = run.taint.length > 0;
      try {
        output = await tool.run(call.args, ctx);
        if (output && typeof output === 'object') ({ output, summary, link, ingest: hints = null } = output);
      } catch (e) {
        ok = false;
        output = e.code === 'ENOENT' ? `No such file: ${call.args.path ?? ''}` : e.message;
      }
      if (signal.aborted) {
        this.record(sessionId, { type: 'tool_result', ...tag, id, ok: false, output: `${output ?? ''}\n[stopped]`.trim() });
        this.record(sessionId, { type: 'stopped', ...tag });
        return;
      }
      // Outside content is screened before the model sees it; the log keeps what the tool returned
      // (for the person), and the model is given only the screened form.
      let screen = null;
      let taints = true;
      const read = this.outsideRead(call, String(output ?? ''), { page, hints, ok });
      if (read) {
        screen = await this.ingest.screen(read);
        taints = this.taints(call, screen);
        if (taints) run.taint.push(screen.taint);
      }
      if (ok && call.name === 'write_file') this.provenance(call.args, taintedBefore);
      // The links a page carries, so following one later in the run counts as following a link.
      const links = ok && page?.html ? pageLinks(page.html, page.ref) : [];
      if (call.name.startsWith('schedule_') && ok) this.emit('schedules');
      this.record(sessionId, { type: 'tool_result', ...tag, id, ok, output: String(output), ...(summary ? { summary } : {}), ...(link ? { link } : {}), ...(screen ? { screen: screen.taint, screened: screen.extract, ...(taints ? {} : { taints: false }) } : {}), ...(links.length ? { links } : {}) });
    }
  }

  // A skill this reply follows: its playbook goes into the instructions for
  // every model call that's left. The log keeps which skill, not its text.
  follow(sessionId, tag, run, skill, how) {
    if (run.skills.has(skill.id)) return false;
    run.skills.set(skill.id, skill);
    this.record(sessionId, { type: 'skill', ...tag, skill: skill.id, name: skill.name, how });
    return true;
  }

  useSkill(sessionId, tag, run, name) {
    const skill = this.skills.get(name.trim().toLowerCase());
    if (!skill) {
      const have = this.skills.installed().map((s) => s.id).join(', ');
      throw new Error(`There's no installed skill called ${name}.${have ? ` Installed: ${have}.` : ''}`);
    }
    const fresh = this.follow(sessionId, tag, run, skill, 'asked');
    return { output: `${fresh ? 'Loaded' : 'Already following'} ${skill.name}. Its playbook is now in your instructions under Skills; follow it.`, summary: skill.name };
  }

  // Memory is written before the reply is marked done. The log records what
  // changed by id only; the words live in the core's memory and the day notes.
  // In a run that read outside content, memory isn't written: each block becomes a candidate,
  // held with where it came from, out of every prompt until the person keeps it (a forget too).
  keep(sessionId, tag, ops, run = { taint: [] }) {
    const from = `${sessionId}/${tag.turn}`;
    const held = run.taint.length > 0;
    const results = ops.map((o) => {
      try {
        if (held) {
          const id = this.ingest.candidate({ op: o.op, ...(o.kind ? { kind: o.kind } : {}), ...(o.text ? { content: o.text } : {}), ...(o.op === 'forget' ? { target: o.id } : {}), ...(o.replaces ? { replaces: o.replaces } : {}), source: from, taint: run.taint });
          return { op: o.op, ok: true, held: true, id };
        }
        if (o.op === 'remember') return this.memory.remember({ ...o, from });
        if (o.op === 'note') return this.memory.note({ ...o, from });
        const removed = this.memory.forget(o.id, { by: 'nova' });
        if (removed.length) this.emit('forgot', removed);
        return { op: 'forget', ok: removed.length > 0, id: o.id, also: removed.length > 1 ? removed.length - 1 : undefined };
      } catch (e) {
        return { op: o.op, ok: false, error: e.message };
      }
    }).map(({ op, ok, id, kind, replaced, existing, day, also, held: h }) => ({ op, ok, id, kind, replaced, existing, day, also, ...(h ? { held: true } : {}) }));
    this.record(sessionId, { type: 'memory', ...tag, ops: results });
    this.emit('memory');
  }

  // ---- the ingest gate ------------------------------------------------------------------------

  // The outside content a conversation has read: each screened read (failed ones too), each handoff
  // from a run that read some, and what a run started with. Reads from before the gate count too.
  // A command's output taints only when its screen said so (`taints: false` otherwise).
  taintOf(session) {
    const out = [];
    for (const t of session.turns) {
      out.push(...(t.taint ?? []));
      for (const i of t.items) {
        if (i.kind !== 'tool' || !i.result) continue;
        if (i.result.screen) { if (i.result.taints !== false) out.push(i.result.screen); continue; }
        const legacy = TOOLS[i.name]?.mail || TOOLS[i.name]?.online;
        if (legacy && i.result.ok) out.push({ screen: null, kind: TOOLS[i.name]?.mail ? 'email' : 'web', origin: TOOLS[i.name]?.mail ? 'your mail' : hostOf(i.args?.url ?? 'the web'), verdict: 'quarantine', max: null });
      }
    }
    const seen = new Set();
    return out.filter((x) => { const k = x.screen ?? `${x.kind}:${x.origin}`; if (seen.has(k)) return false; seen.add(k); return true; });
  }

  // Addresses this conversation has already seen: links in what it read (pages, results, mail,
  // reports) and in the person's own messages. Opening one of these is following a link; any other
  // address in a tainted run was put together by the model, and asks.
  knownUrls(session) {
    const out = new Set();
    const add = (text) => { for (const u of String(text ?? '').match(URL_IN_TEXT) ?? []) { const n = normUrl(u); if (n) out.add(n); } };
    for (const t of session.turns) {
      if (t.kind === 'handoff') { add(t.text); continue; }
      if (!t.followup) add(t.text);
      for (const i of t.items) {
        if (i.kind !== 'tool' || !i.result) continue;
        add(i.result.output);
        for (const l of i.result.links ?? []) { const n = normUrl(l); if (n) out.add(n); }
      }
    }
    return out;
  }

  // Whether a path names one of the standing files, however it is spelled: ./, ../, ~/, case
  // and Unicode form are folded the way write_file folds them.
  standingPath(path) {
    let rel;
    try { rel = homeTarget(this.config.home, String(path ?? '')).rel; } catch { rel = String(path ?? '').replace(/^~\//, '').replace(/^(\.\/)+/, ''); }
    const f = rel.normalize('NFC').toLowerCase();
    return !f.includes('/') && STANDING.has(f);
  }

  // Why a step must ask because of the gate, or null.
  guardFor(call, tool, run, preview, session = null) {
    if (!call || !tool) return null;
    const tainted = run.taint.length > 0;
    const standing = call.name === 'write_file' && this.standingPath(call.args?.path);
    // Any other step that needs an OK (a tool added later: sending, paying, sharing, pairing)
    // is guarded the same way: in a tainted run it never goes on its own.
    let what = GUARDED[call.name] ?? (standing ? 'change your standing files' : tool.needsApproval ? 'take this step' : null);
    // An address the model put together, in a tainted run, asks, whatever it carries: matching
    // can't keep up with chunking, short encodings or reversal. A link it read is free.
    if (tainted && call.name === 'web_fetch' && !(session && this.knownUrls(session).has(normUrl(call.args?.url)))) what = 'open an address it put together';
    const payload = this.outboundPayload(call, preview);
    const out = payload === null ? null : this.ingest.outbound({ text: payload }, { tainted });
    const matched = out && !out.ok ? out.matched : null;
    if (!(tainted && what) && !matched) return null;
    const sources = [...new Set(run.taint.map((x) => cleanOrigin(x.origin)))].slice(0, 5);
    return { ...(tainted && what ? { what } : {}), ...(matched ? { matched } : {}), sources };
  }

  // What a step would send to a destination outside content could have chosen.
  outboundPayload(call, preview) {
    const a = call.args ?? {};
    if (call.name === 'web_fetch') return String(a.url ?? '');
    if (call.name === 'web_search') return String(a.query ?? '');
    if (call.name === 'gmail_draft') return [preview?.to ?? a.to, preview?.cc ?? a.cc, preview?.subject ?? a.subject, preview?.body ?? a.body].filter(Boolean).join('\n');
    if (call.name === 'exec') return String(a.command ?? '');
    return null;
  }

  // The screen's input for a read of outside content, or null when what was read is the person's own.
  // Only the tools named here read from outside. Every other tool (Nova's own state: skills,
  // schedules, helpers, and read-only views of Nova itself) is trusted: never screened, never taints.
  // A read that failed is screened too: an error can carry the server's own words.
  outsideRead(call, output, { page, hints, ok = true }) {
    const a = call.args ?? {};
    if (call.name === 'web_fetch') return ok
      ? { ...(page?.html ? { html: page.html } : { text: page?.text ?? output }), source: { kind: 'web', origin: page?.origin || hostOf(a.url), ref: page?.ref ?? String(a.url ?? '') } }
      : { text: output, source: { kind: 'web', origin: hostOf(a.url), ref: String(a.url ?? '') } };
    if (call.name === 'web_search') return { text: output, source: { kind: 'search', origin: hostOf(this.config.searchUrl ?? 'web search'), ref: String(a.query ?? '').slice(0, 200) } };
    if (call.name === 'gmail_search') return { text: output, source: { kind: 'email', origin: 'Gmail search', ref: String(a.query ?? '').slice(0, 200) } };
    if (call.name === 'gmail_read') {
      const from = /<([^>]+@[^>]+)>/.exec(hints?.headers?.from ?? '')?.[1] ?? hints?.headers?.from ?? 'Gmail';
      return { text: output, ...(hints?.html ? { html: hints.html } : {}), headers: hints?.headers ?? {}, attachments: hints?.attachments ?? [], source: { kind: 'email', origin: from, ref: String(a.id ?? '') } };
    }
    if (call.name === 'read_file') {
      if (!ok || this.ownFile(String(a.path ?? ''))) return null;
      return { text: output, source: { kind: 'file', origin: this.relPath(String(a.path ?? '')) ?? String(a.path ?? '') } };
    }
    // A command's output, in every run (Amendment 2026-10-30-C Part 3: tool output).
    if (call.name === 'exec') return { text: output, source: { kind: 'tool', origin: 'a command', ref: String(a.command ?? '').slice(0, 200) } };
    return null;
  }

  // Whether a read taints the run. Every outside read does, except a command's output: that taints
  // when the screen found something (a check flagged it, or the model wasn't sure), so ordinary
  // commands the person allowed keep running on their own. Without a model, a paraphrased
  // injection in command output that no check matches is passed on as held-back data, untainted.
  taints(call, screen) {
    if (call.name !== 'exec') return true;
    return screen.verdict === 'block' || screen.flags.some((f) => f.level !== 'note') || (!!screen.model && screen.verdict !== 'pass');
  }

  relPath(path) {
    try { return homeTarget(this.config.home, path).rel; } catch { return null; }
  }

  // A file's name exactly as it is on disk (on a case-insensitive disk, its real case).
  exactRel(t) {
    try { return relative(realpathSync.native(this.config.home), realpathSync.native(t.abs)).split(sep).join('/'); } catch { return t.rel; }
  }

  // Whether a file in the home is the person's own: the standing files (by their exact names),
  // memory, schedules and permissions; a skill's file that is in use and unchanged since Nova
  // checked it; or a workspace file Nova wrote itself in a run that read nothing from outside (by
  // content hash). Everything else is outside or unknown.
  ownFile(path, text = null) {
    let t;
    try { t = homeTarget(this.config.home, path); } catch { return false; }
    const rel = existsSync(t.abs) ? this.exactRel(t) : t.rel;
    const top = rel.split('/')[0];
    if (!rel.includes('/') && STANDING_EXACT.has(rel)) return true;
    if (OWN_TOP.has(top)) return true;
    if (top !== 'workspace' && top !== 'skills') return false;
    if (top === 'skills' && this.skillHeld(rel.split('/')[1])) return false;
    let body = text;
    if (body === null) {
      try {
        if (!existsSync(t.abs) || statSync(t.abs).isDirectory()) return false;
        body = readFileSync(t.abs, 'utf8');
      } catch { return false; }
    }
    if (top === 'skills' && this.catalogCopy(rel, body)) return true;
    return this.ingest.isOwn(rel, sha256(body));
  }

  // A file exactly as Nova ships it in its skill catalog.
  catalogCopy(rel, body) {
    const p = join(this.skills.catalogDir, ...rel.split('/').slice(1));
    try { return existsSync(p) && readFileSync(p, 'utf8') === body; } catch { return false; }
  }

  // Why a skill can't be used now, or null: held back by the screen, or its SKILL.md changed since
  // Nova checked it (or ships with it).
  skillHeld(id) {
    if (!id) return ['not a skill'];
    const held = this.ingest.held('skill', id);
    if (held) return held.reasons;
    const rel = `skills/${id}/SKILL.md`;
    let body;
    try { body = readFileSync(join(this.config.home, rel), 'utf8'); } catch { return null; }
    return this.catalogCopy(rel, body) || this.ingest.isOwn(rel, sha256(body)) ? null : ['It changed since Nova checked it'];
  }

  // The skill's files as they are now are the ones Nova checked (or the person turned on).
  trustSkill(id) {
    const dir = join(this.config.home, 'skills', id);
    const walk = (d) => {
      for (const name of readdirSync(d)) {
        const p = join(d, name);
        if (statSync(p).isDirectory()) walk(p);
        else this.ingest.markOwn(relative(this.config.home, p).split(sep).join('/'), sha256(readFileSync(p, 'utf8')));
      }
    };
    try { walk(dir); } catch { /* nothing kept: its files read as unknown, and are screened */ }
  }

  // A workspace file Nova writes is its own only when the run had read nothing from outside.
  provenance(args, tainted) {
    const rel = this.relPath(String(args?.path ?? ''));
    if (!rel || !rel.startsWith('workspace/')) return;
    try {
      if (tainted || typeof args.content !== 'string') this.ingest.clearOwn(rel);
      else this.ingest.markOwn(rel, sha256(args.content));
    } catch { /* no record kept: the file reads as unknown, and is screened */ }
  }

  // A helper's files: its own pass as they are (escaped); the rest are screened, and the run is
  // tainted by them.
  async screenFiles(sessionId, tag, run) {
    const taint = [];
    run.helper.files = await Promise.all(run.helper.files.map(async (f) => {
      const whole = !/\n\[truncated: the file is \d+ characters\]$/.test(f.text ?? '');
      if (whole && this.ownFile(f.path, f.text ?? '')) return { ...f, text: escapeProtocol(f.text ?? '') };
      const s = await this.ingest.screen({ text: f.text ?? '', source: { kind: 'file', origin: f.path } });
      taint.push(s.taint);
      return { ...f, text: s.extract };
    }));
    if (taint.length) {
      run.taint.push(...taint);
      this.record(sessionId, { type: 'taint', ...tag, taint });
    }
  }

  // A report from a run that read outside content carries its taint, and the conversation it goes
  // to is given only its screened form.
  async screenReport(run, handoff) {
    if (!this.store.exists(run)) return {};
    const taint = this.taintOf(reduce(this.store.read(run)));
    if (!taint.length || !handoff.text) return {};
    const s = await this.ingest.screen({ text: handoff.text, source: { kind: 'handoff', origin: handoff.name ?? 'a report', ref: run } });
    return { taint: [...taint, s.taint], screened: s.extract };
  }
}

export class BusyError extends Error {
  constructor() { super('Nova is still replying in this conversation.'); }
}
