// The broker's IPC endpoint (§3 "IPC"): a Unix-domain socket in a 0700 folder (a named pipe on
// Windows, untested there). It is the only thing the broker listens on: no port, no HTTP server, no
// inspector. Frames are newline-delimited JSON with a size cap and an id per request; unknown
// messages and unknown fields are refused.
//
// Who is calling (Phase 1): the socket's permissions decide who can connect, and a 256-bit token
// per boot says which role (core or the supervisor), given to each by the supervisor over Node's
// IPC channel, never argv or the environment. Node's standard library exposes no peer credentials
// (SO_PEERCRED, getpeereid), so a process running as the same OS account that obtains a token can
// speak as that role: it can make only the uses that role could, inside bindings, scopes, consents
// and rate caps. A connection that says no hello may only redeem a ticket (the launcher).
//
// Every answer to core or the supervisor is checked against the answer schema (no field that can
// carry a value) and scrubbed of every value the broker holds, in every encoding, before it is
// written. A hit means a bug upstream: it is scrubbed, recorded and raised as a problem.
import { timingSafeEqual } from 'node:crypto';
import { chmodSync, mkdirSync, rmSync } from 'node:fs';
import { createServer, type Server, type Socket } from 'node:net';
import { dirname } from 'node:path';
import type { Broker } from './broker.ts';
import { ERRORS, LAUNCHER, MAX_FRAME, checkAnswer, parseFrame, type ProtocolError, type Role } from './protocol.ts';

export interface Tokens { core: string; supervisor: string }
const MAX_CONNECTIONS = 32;

const same = (a: string, b: string) => { const x = Buffer.from(a); const y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); };

export function socketPath(dir: string, platform = process.platform): string {
  return platform === 'win32' ? `\\\\.\\pipe\\nova-broker-${Buffer.from(dir).toString('hex').slice(-32)}` : `${dir}/run/broker.sock`;
}

export function serve(broker: Broker, path: string, tokens: Tokens): Promise<Server> {
  if (!/^[0-9a-f]{64}$/.test(tokens.core) || !/^[0-9a-f]{64}$/.test(tokens.supervisor) || tokens.core === tokens.supervisor) throw new Error('the broker needs two distinct 256-bit tokens');
  if (process.platform !== 'win32') {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    chmodSync(dirname(path), 0o700);
    rmSync(path, { force: true });
  }
  const server = createServer({ allowHalfOpen: false }, (sock) => connection(broker, sock, tokens, server));
  server.maxConnections = MAX_CONNECTIONS;
  return new Promise((ok, fail) => {
    server.once('error', fail);
    server.listen({ path, exclusive: true }, () => {
      if (process.platform !== 'win32') chmodSync(path, 0o600);
      ok(server);
    });
  });
}

function connection(broker: Broker, sock: Socket, tokens: Tokens, _server: Server) {
  let role: Role | null = null;
  let buf = '';
  let chain = Promise.resolve();
  sock.setEncoding('utf8');
  const write = (a: Record<string, unknown>) => { if (!sock.destroyed) sock.write(`${JSON.stringify(a)}\n`); };
  const err = (id: string | number | null, e: ProtocolError) => write({ id, error: e, words: ERRORS[e] });
  // To core and the supervisor: the schema check, then the scrub.
  const answer = (a: Record<string, unknown>) => {
    const bad = checkAnswer(a);
    if (bad) {
      broker.problem = 'The broker refused to send an answer that had a field it doesn’t allow. This is a bug; nothing was sent.';
      broker.audit.write({ verb: 'answer', ref: null, target: null, scope_item: null, outcome: 'refused:schema', tier: null, approval_id: null, task: null, role: role ?? 'core' });
      return write({ id: a.id, error: 'failed', words: ERRORS.failed });
    }
    const before = broker.scrubber.hits;
    const clean = broker.scrubber.any(a);
    if (broker.scrubber.hits !== before) {
      broker.problem = 'An answer carried a value the broker holds; it was scrubbed before it was sent. This is a bug.';
      broker.audit.write({ verb: 'answer', ref: null, target: null, scope_item: null, outcome: 'scrubbed', tier: null, approval_id: null, task: null, role: role ?? 'core' });
    }
    write(clean);
  };
  const handle = async (line: string) => {
    const p = parseFrame(line);
    if ('error' in p) return err(p.id, p.error);
    const f = p.frame;
    if (f.m === 'hello') {
      if (role) return err(f.id, 'not_allowed');
      const t = typeof f.token === 'string' ? f.token : '';
      role = same(t, tokens.core) ? 'core' : same(t, tokens.supervisor) ? 'supervisor' : null;
      if (!role) { broker.audit.write({ verb: 'hello', ref: null, target: null, scope_item: null, outcome: 'refused:token', tier: null, approval_id: null, task: null, role: 'core' }); err(f.id, 'unauthenticated'); return void sock.end(); }
      return answer({ id: f.id, ok: true, role });
    }
    if ((LAUNCHER as readonly string[]).includes(f.m)) {
      // Only on a connection that never said hello: core's own connection can't redeem.
      if (role) return err(f.id, 'not_allowed');
      return write({ id: f.id, ...broker.launcher(f) });
    }
    if (!role) return err(f.id, 'unauthenticated');
    const a = await broker.handle(role, f);
    answer({ id: f.id, ...a });
  };
  sock.on('data', (chunk: string) => {
    buf += chunk;
    if (buf.length > MAX_FRAME && !buf.includes('\n')) { err(null, 'too_large'); sock.destroy(); return; }
    let i: number;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      chain = chain.then(() => handle(line)).catch(() => err(null, 'failed'));
    }
  });
  sock.on('error', () => sock.destroy());
}
