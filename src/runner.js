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
import { buildPrompt, buildSystem } from './context.js';
import { searchMemory } from './memory.js';
import { commitHome } from './home.js';
import { TOOLS, ToolTagFilter, parseToolCall } from './tools.js';
import { reduce, titleFrom } from '../ui/js/reduce.js';

const shortId = () => randomUUID().slice(0, 8);

export class Runner extends EventEmitter {
  constructor(config, store, { agent = runAgent } = {}) {
    super();
    this.config = config;
    this.store = store;
    this.agent = agent;
    this.active = new Map(); // sessionId → live run
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
    const run = { controller, pending: null, live: { turn, attempt, phase: 'thinking', text: '', approval: null } };
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
    const question = reduce(this.store.read(sessionId)).turns.find((t) => t.id === turn).text;

    const recall = searchMemory(this.config.home, question);
    if (recall.length) this.record(sessionId, { type: 'recall', ...tag, notes: recall });

    for (let step = 0; step <= this.config.maxSteps; step++) {
      const session = reduce(this.store.read(sessionId));
      const filter = new ToolTagFilter();
      this.setLive(sessionId, { phase: 'thinking', text: '' });
      let streamed = '';
      const { text, aborted } = await this.agent({
        cmd: this.config.agentCmd,
        system: buildSystem(this.config),
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

      const { visible, call, error } = parseToolCall(text);
      if (visible) this.record(sessionId, { type: 'assistant', ...tag, id: shortId(), text: visible });
      run.live.text = '';
      if (!call && !error) { this.record(sessionId, { type: 'done', ...tag }); return; }

      if (step === this.config.maxSteps) {
        this.record(sessionId, { type: 'error', ...tag, message: `Nova stopped after ${this.config.maxSteps} tool steps in one reply, to stay safe.`, detail: 'max_tool_steps reached' });
        return;
      }

      const id = shortId();
      const tool = TOOLS[call?.name];
      const needsApproval = !!tool?.needsApproval && !error;
      this.record(sessionId, { type: 'tool_call', ...tag, id, name: call?.name ?? 'unknown', args: call?.args ?? {}, needs_approval: needsApproval });
      if (error) {
        this.record(sessionId, { type: 'tool_result', ...tag, id, ok: false, output: error });
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
      let ok = true;
      try {
        output = await tool.run(call.args, { home: this.config.home, signal, timeoutMs: this.config.execTimeoutMs });
      } catch (e) {
        ok = false;
        output = e.code === 'ENOENT' ? `No such file: ${call.args.path ?? ''}` : e.message;
      }
      if (signal.aborted) {
        this.record(sessionId, { type: 'tool_result', ...tag, id, ok: false, output: `${output ?? ''}\n[stopped]`.trim() });
        this.record(sessionId, { type: 'stopped', ...tag });
        return;
      }
      this.record(sessionId, { type: 'tool_result', ...tag, id, ok, output: String(output) });
    }
  }
}

export class BusyError extends Error {
  constructor() { super('Nova is still replying in this conversation.'); }
}
