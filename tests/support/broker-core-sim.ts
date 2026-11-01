// A stand-in for Nova core, in a process of its own, holding only the broker client (src/core/
// broker/client.ts). The test process plays the person (it seals and approves) and the targets;
// this process relays, as core does, and at the end writes a heap snapshot the test searches for
// every canary (gate item 2: "core's heap").
import { writeHeapSnapshot } from 'node:v8';
import { BrokerClient } from '../../src/core/broker/client.ts';

let client: BrokerClient | null = null;
// Everything that reached this process is kept until the snapshot, so a value that passed through
// core and would otherwise be collected is still found (the search can't miss it by timing).
const kept: unknown[] = [];
(globalThis as { novaKept?: unknown[] }).novaKept = kept;
const send = (seq: number, r: unknown) => { kept.push(r); process.send!({ seq, r }); };

process.on('message', async (msg: { seq: number; op: string; [k: string]: any }) => {
  kept.push(msg);
  try {
    if (msg.op === 'init') { client = new BrokerClient({ socket: msg.socket, token: msg.token }); return send(msg.seq, true); }
    const c = client!;
    if (msg.op === 'call') return send(msg.seq, await c.call(msg.m, msg.f ?? {}));
    if (msg.op === 'stage') return send(msg.seq, await c.migrateStage(msg.home));
    if (msg.op === 'finish') return send(msg.seq, await c.migrateFinish(msg.home, msg.ticket));
    if (msg.op === 'run') {
      const child = c.launch(msg.ticket, msg.program, { env: { PATH: process.env.PATH ?? '' } });
      let stdout = '';
      let stderr = '';
      child.stdout!.setEncoding('utf8').on('data', (x: string) => { stdout += x; });
      child.stderr!.setEncoding('utf8').on('data', (x: string) => { stderr += x; });
      child.on('close', (code) => send(msg.seq, { code, stdout, stderr }));
      return;
    }
    if (msg.op === 'heap') { c.close(); return send(msg.seq, writeHeapSnapshot(msg.path)); }
  } catch (e) { send(msg.seq, { error: 'sim', words: (e as Error).message }); }
});
