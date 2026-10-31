// The eval driver: runs one golden task on a whole Nova. A fresh temp home; the chat model wired
// through the provider registry's existing interface (configure, enable, choose: the registry is
// only used, never changed); a recording proxy between the provider and the model, so every run
// keeps what the model was actually sent; the task's fixture; its turns through the real runner;
// and the trace and the world after the run, for the graders.
//
// The model behind the provider is a target: a stand-in persona (CI) or a model on the local Ollama
// (opt-in). Only loopback addresses are accepted, and a provider whose egress the registry reports
// as anything but this machine is refused: there is no path here to a cloud model.
import { createServer, request, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createNova } from '../../src/server.js';
import { loadConfig } from '../../src/config.js';
import { startFakeOllama } from '../../scripts/stand-ins/fake-ollama.js';
import { evals } from '../../src/core/index.ts';
import { hubHardware } from '../support/models.ts';
import { grounded, obedient, priors, type ChatBody, type Reply } from './stand-in.ts';

export type Nova = ReturnType<typeof createNova>;
export type Persona = 'grounded' | 'obedient' | 'priors';

// What plays the model. `standIn`: a persona answered by the stand-in Ollama. Otherwise `upstream`
// is an Ollama (or any OpenAI-compatible server) on this machine, serving `model`.
export interface TargetSpec {
  provider: 'openai-compatible';
  model: string;
  upstream?: string;
  standIn?: { persona?: Persona } | null;
}

export interface Turn {
  say: string | ((w: World) => string);
  // What the person says to anything that asks for an OK in this turn (default: no).
  decide?: 'allow' | 'deny';
}

// A stand-in web on this machine, for tasks that read a page: pages by path, and every request it
// got, so a grader can see whether anything reached it.
export interface Web {
  base: string;
  hits: { method: string; url: string }[];
  pages: Map<string, { type: string; body: string }>;
  close(): Promise<void>;
}

export interface World {
  nova: Nova;
  core: Nova['core'];
  runner: Nova['runner'];
  home: string;
  target: TargetSpec;
  // The hub's own Ollama in the fixture (a stand-in, whatever the chat model is), and its models.
  hubOllama: { url: string; models: string[] };
  // Every chat request body the model was sent, through the proxy.
  sent: string[];
  web: Web | null;
  // Planted secrets and facts the fixture recorded for its graders.
  secrets: string[];
  facts: Record<string, unknown>;
  // Stand-ins and anything else the fixture started, closed after the run.
  cleanup: (() => Promise<void> | void)[];
  session: string | null;
}

export interface GoldenTask extends evals.TaskBase<World> {
  // The privacy setting for the run (local-only unless the task needs the web tools, which are
  // offered only where the setting allows the network).
  privacy?: 'local-only' | 'local-preferred' | 'cloud-allowed';
  // Start the stand-in web and let the agent's fetches reach it (127.0.0.1 only; nothing else on
  // this machine or the network becomes reachable).
  web?: boolean;
  fixture?: (w: World) => Promise<void> | void;
  turns: Turn[];
  // Who plays the model in CI. obedient: the attacker's plan for each turn.
  standIn: { persona: 'grounded' } | { persona: 'obedient'; plan: (w: World, turn: number) => string[] };
}

const LOOPBACK = /^(127\.\d+\.\d+\.\d+|localhost|\[::1\])$/;
// The hub's Ollama in every fixture: a stand-in with two placeholder models.
export const HUB_MODELS = [{ name: 'example-chat:8b', parameter_size: '8B' }, { name: 'example-small:3b', parameter_size: '3B' }];

export function assertLocal(url: string) {
  const u = new URL(url);
  if (!/^https?:$/.test(u.protocol) || !LOOPBACK.test(u.hostname)) throw new Error(`Only a model on this machine can be evaluated here, not ${u.host}.`);
}

// A pass-through to the model's server that keeps every chat request body. Streams are piped.
async function recordingProxy(upstream: string): Promise<{ url: string; sent: string[]; close: () => Promise<void> }> {
  const up = new URL(upstream);
  const sent: string[] = [];
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      if (req.method === 'POST' && /chat/.test(req.url ?? '')) sent.push(body.toString('utf8'));
      const out = request({ host: up.hostname, port: up.port || 80, method: req.method, path: `${up.pathname.replace(/\/$/, '')}${req.url}`, headers: { ...req.headers, host: up.host } }, (r) => {
        res.writeHead(r.statusCode ?? 502, r.headers);
        r.pipe(res);
      });
      out.on('error', (e) => { if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { message: e.message } })); });
      out.end(body);
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  return { url: `http://127.0.0.1:${port}`, sent, close: () => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }) };
}

export async function startWeb(): Promise<Web> {
  const hits: Web['hits'] = [];
  const pages: Web['pages'] = new Map();
  const server = createServer((req, res) => {
    hits.push({ method: req.method ?? 'GET', url: req.url ?? '/' });
    const p = pages.get((req.url ?? '/').split('?')[0]!);
    if (p) { res.writeHead(200, { 'content-type': p.type }); res.end(p.body); return; }
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('ok');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  return { base: `http://127.0.0.1:${port}`, hits, pages, close: () => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }) };
}

type Item = { kind: string; name?: string; args?: unknown; text?: string; message?: string; needsApproval?: boolean; approval?: { decision: string; auto?: boolean } | null; result?: { ok: boolean; output: string } | null };

function personaReply(task: GoldenTask, target: TargetSpec, w: () => World, turn: () => number): Reply {
  const persona = target.standIn?.persona ?? task.standIn.persona;
  if (persona === 'priors') return priors;
  if (persona === 'obedient' && task.standIn.persona === 'obedient') {
    const plan = task.standIn.plan;
    return (b: ChatBody) => obedient(plan(w(), turn()))(b);
  }
  return grounded;
}

export interface DriveOptions {
  turnTimeoutMs?: number;
  // For the CLI's progress line.
  log?: (s: string) => void;
}

// Runs a task; returns the trace, the world (graders read it), and close().
export async function drive(task: GoldenTask, target: TargetSpec, o: DriveOptions = {}): Promise<evals.Driven<World>> {
  const cleanup: World['cleanup'] = [];
  const closeAll = async () => { for (const f of cleanup.reverse()) { try { await f(); } catch { /* best effort */ } } };
  try {
    // The hub's own Ollama: a fixture, so the briefing's "Local models" is the same for every target.
    const hub = await startFakeOllama({ models: HUB_MODELS });
    cleanup.push(() => hub.close());
    let turnNo = 0;
    let world: World | null = null;
    // The model: a stand-in persona on its own stand-in Ollama, or the target's upstream.
    let upstream = target.upstream ?? '';
    if (target.standIn) {
      const reply = personaReply(task, target, () => world!, () => turnNo);
      const model = await startFakeOllama({ models: [{ name: target.model }], reply: (b: ChatBody) => reply(b) });
      cleanup.push(() => model.close());
      upstream = model.url;
    }
    assertLocal(upstream);
    const proxy = await recordingProxy(upstream);
    cleanup.push(() => proxy.close());
    const web = task.web ? await startWeb() : null;
    if (web) cleanup.push(() => web.close());

    const home = mkdtempSync(join(tmpdir(), 'nova-eval-'));
    const config = { ...loadConfig({ NOVA_HOME: home, NOVA_AGENT_CMD: 'example-model-command', NOVA_AGENT_EGRESS: 'none', NOVA_TZ: 'UTC', NOVA_INSTANCE: 'preview' }), port: 0, commit: false } as ReturnType<typeof loadConfig>;
    const nova = createNova(config, {
      models: { ollamaUrl: hub.url, hardware: async () => hubHardware(), watchMs: 100 },
      // The stand-in web is on this machine: a task may let the agent reach it, the model never can.
      ...(web ? { fetchAllow: (address: string) => address === '127.0.0.1' } : {}),
    });
    cleanup.push(async () => { nova.scheduler.stop(); await nova.core.close(); });
    const { core, runner } = nova;
    core.profile.set('privacy', 'default', task.privacy ?? (task.web ? 'cloud-allowed' : 'local-only'), 'settings');

    // The chat model, through the registry's existing interface.
    core.providers.configure(target.provider, { base_url: `${proxy.url}/v1`, model: target.model });
    core.providers.enable(target.provider, { approved: true });
    core.providers.choose('chat', target.provider);
    const where = core.providers.where(target.provider) as { coarse: string };
    if (where.coarse === 'remote') throw new Error(`The registry says ${target.provider} sends data off this machine; refused.`);

    world = { nova, core, runner, home, target, hubOllama: { url: hub.url, models: HUB_MODELS.map((m) => m.name) }, sent: proxy.sent, web, secrets: [], facts: {}, cleanup, session: null };
    await task.fixture?.(world);

    const turns: evals.TurnTrace[] = [];
    const timeout = o.turnTimeoutMs ?? (target.standIn ? 30_000 : 600_000);
    for (const [i, t] of task.turns.entries()) {
      turnNo = i;
      const text = typeof t.say === 'function' ? t.say(world) : t.say;
      if (!world.session) world.session = runner.createSession(text);
      const id = world.session;
      runner.send(id, text);
      const until = Date.now() + timeout;
      for (;;) {
        const live = runner.liveState(id) as { phase?: string; approval?: string } | null;
        if (!live) break;
        if (live.phase === 'approval') runner.decide(id, live.approval, t.decide ?? 'deny');
        if (Date.now() > until) { runner.stop?.(id); throw new Error(`turn ${i + 1} took longer than ${Math.round(timeout / 1000)} s`); }
        await new Promise((r) => setTimeout(r, 10));
      }
      await runner.idle(id);
      const session = (runner.snapshot(id) as { session: { turns: { items: Item[] }[] } }).session;
      const items = session.turns.at(-1)?.items ?? [];
      turns.push({
        said: text,
        reply: items.filter((x) => x.kind === 'text').map((x) => String(x.text ?? '')).join('\n').trim(),
        tools: items.filter((x) => x.kind === 'tool').map((x) => ({ name: x.name ?? 'unknown', args: x.args ?? {}, ok: x.result ? x.result.ok : null, output: x.result?.output ?? '', asked: !!x.needsApproval && !x.approval?.auto, decision: x.approval ? `${x.approval.decision}${x.approval.auto ? ' (auto)' : ''}` : null })),
        errors: items.filter((x) => x.kind === 'error').map((x) => String(x.message ?? '')),
      });
      o.log?.(`  turn ${i + 1}: ${turns.at(-1)!.tools.map((s) => s.name).join(', ') || 'no tool'}`);
    }
    return { trace: { turns, sent: proxy.sent }, ctx: world, close: closeAll };
  } catch (e) {
    await closeAll();
    throw e;
  }
}
