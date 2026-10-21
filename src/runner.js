// The session runner: one agent loop per conversation turn.
//
//   memory search → model call (streamed) → tool call? → approval? → run tool
//   → model call again … until the model replies without a tool call.
//
// Every step is appended to the session's JSONL log as it happens. Live state
// (streaming text, a pending approval) is held in memory and broadcast; if the
// process dies mid-turn, the log still shows exactly how far it got.
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { runAgent, AgentError } from './agent.js';
import { buildPrompt, buildSystem, skillsSection } from './context.js';
import { Memory } from './memory.js';
import { Skills } from './skills.js';
import { Gmail, googleEndpoints } from './connectors/gmail.js';
import { commitHome } from './home.js';
import { TOOLS, ToolTagFilter, availableTools, extractMemory, parseToolCall } from './tools.js';
import { reduce, titleFrom } from '../ui/js/reduce.js';

const shortId = () => randomUUID().slice(0, 8);

export class Runner extends EventEmitter {
  constructor(config, store, { agent = runAgent } = {}) {
    super();
    this.config = config;
    this.store = store;
    this.agent = agent;
    this.active = new Map(); // sessionId → live run
    this.memory = new Memory(config.home, config.timezone);
    this.skills = new Skills(config.root, config.home);
    this.gmail = new Gmail(config.home, { endpoints: googleEndpoints(config.googleBase), imapUrl: config.imapUrl, timezone: config.timezone });
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

  send(sessionId, text) {
    if (this.active.has(sessionId)) throw new BusyError();
    const turn = shortId();
    this.record(sessionId, { type: 'user', turn, text });
    this.start(sessionId, turn, 0);
    return turn;
  }

  regenerate(sessionId) {
    if (this.active.has(sessionId)) throw new BusyError();
    const session = reduce(this.store.read(sessionId));
    const last = session.turns.at(-1);
    if (!last) throw new Error('Nothing to regenerate');
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

  start(sessionId, turn, attempt) {
    const controller = new AbortController();
    // skills: the playbooks this reply follows. tainted: mail has been read in
    // this conversation, so going online asks first.
    const run = { controller, pending: null, skills: new Map(), tainted: false, live: { turn, attempt, phase: 'thinking', text: '', approval: null } };
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

  async loop(sessionId, run) {
    const { turn, attempt } = run.live;
    const tag = { turn, attempt };
    const { signal } = run.controller;
    const before = reduce(this.store.read(sessionId));
    const question = before.turns.find((t) => t.id === turn).text;
    // Once Nova has read mail in a conversation, the mail is in its context,
    // so going online asks first for the rest of that conversation.
    run.tainted = before.turns.some((t) => t.items.some((i) => i.kind === 'tool' && TOOLS[i.name]?.mail && i.result?.ok));

    // The log keeps where each note came from, not its words: what is
    // forgotten later stays gone from the conversation view too.
    const recall = this.memory.search(question);
    if (recall.length) this.record(sessionId, { type: 'recall', ...tag, notes: recall.map(({ id, source }) => ({ id, source })) });
    for (const s of this.skills.match(question)) this.follow(sessionId, tag, run, s, 'matched');

    for (let step = 0; step <= this.config.maxSteps; step++) {
      const session = reduce(this.store.read(sessionId));
      const installed = this.skills.installed();
      const tools = availableTools({ gmail: this.gmail.status().connected, skills: installed.length });
      const skills = skillsSection(installed, [...run.skills.values()], (c) => this.skills.connectorDoc(c));
      const filter = new ToolTagFilter();
      this.setLive(sessionId, { phase: 'thinking', text: '' });
      let streamed = '';
      const { text, aborted } = await this.agent({
        cmd: this.config.agentCmd,
        system: buildSystem(this.config, new Date(), { tools, skills }),
        prompt: buildPrompt(session, recall, this.config),
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
      if (ops.length) this.keep(sessionId, tag, ops);
      if (!call && !error) { this.record(sessionId, { type: 'done', ...tag }); return; }

      if (step === this.config.maxSteps) {
        this.record(sessionId, { type: 'error', ...tag, message: `Nova stopped after ${this.config.maxSteps} tool steps in one reply, to stay safe.`, detail: 'max_tool_steps reached' });
        return;
      }

      const id = shortId();
      const tool = TOOLS[call?.name];
      const ctx = {
        home: this.config.home, signal, timeoutMs: this.config.execTimeoutMs, searchUrl: this.config.searchUrl,
        gmail: this.gmail, useSkill: (name) => this.useSkill(sessionId, tag, run, name),
      };
      // A tool that changes something outside Nova shows exactly what will
      // change before the person decides; if that can't be worked out, it fails here.
      let failed = error;
      let preview;
      if (!failed && tool.preview) {
        this.setLive(sessionId, { phase: 'tool' });
        try { preview = await tool.preview(call.args, ctx); } catch (e) { failed = e.message; }
      }
      const needsApproval = !failed && (!!tool?.needsApproval || (!!tool?.online && run.tainted));
      this.record(sessionId, { type: 'tool_call', ...tag, id, name: call?.name ?? 'unknown', args: call?.args ?? {}, needs_approval: needsApproval, ...(preview ? { preview } : {}) });
      if (failed) {
        this.record(sessionId, { type: 'tool_result', ...tag, id, ok: false, output: failed });
        continue;
      }

      if (needsApproval) {
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
      let ok = true;
      try {
        output = await tool.run(call.args, ctx);
        if (output && typeof output === 'object') ({ output, summary, link } = output);
      } catch (e) {
        ok = false;
        output = e.code === 'ENOENT' ? `No such file: ${call.args.path ?? ''}` : e.message;
      }
      if (signal.aborted) {
        this.record(sessionId, { type: 'tool_result', ...tag, id, ok: false, output: `${output ?? ''}\n[stopped]`.trim() });
        this.record(sessionId, { type: 'stopped', ...tag });
        return;
      }
      if (tool.mail && ok) run.tainted = true;
      this.record(sessionId, { type: 'tool_result', ...tag, id, ok, output: String(output), ...(summary ? { summary } : {}), ...(link ? { link } : {}) });
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
  // changed by id only; the words live in the memory files.
  keep(sessionId, tag, ops) {
    const from = `${sessionId}/${tag.turn}`;
    const results = ops.map((o) => {
      try {
        if (o.op === 'remember') return this.memory.remember({ ...o, from });
        if (o.op === 'note') return this.memory.note({ ...o, from });
        const removed = this.memory.forget(o.id);
        if (removed.length) this.emit('forgot', removed);
        return { op: 'forget', ok: removed.length > 0, id: o.id, also: removed.length > 1 ? removed.length - 1 : undefined };
      } catch (e) {
        return { op: o.op, ok: false, error: e.message };
      }
    }).map(({ op, ok, id, kind, replaced, existing, day, also }) => ({ op, ok, id, kind, replaced, existing, day, also }));
    this.record(sessionId, { type: 'memory', ...tag, ops: results });
    this.emit('memory');
  }
}

export class BusyError extends Error {
  constructor() { super('Nova is still replying in this conversation.'); }
}
