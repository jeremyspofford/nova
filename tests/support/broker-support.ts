// Shared pieces for the Credential Broker's tests (docs/plans/vault-broker-phase1.md): temp homes
// only, canaries only, no keychain (file key store), no real site.
//  - inProcess: a Broker in this process, called the way the server calls it, with every answer
//    checked against the answer schema.
//  - Person: the person's own client. It seals what the person types (src/broker/seal.ts) to the
//    challenge's digest and approves, in core-relayed mode or with a software passkey.
//  - standIn: an http target that counts connections and records what it was sent.
//  - anyForm: a planted value in any form the gate searches for.
import { fork } from 'node:child_process';
import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Broker } from '../../src/broker/broker.ts';
import { KDF_FLOOR, type Kdf } from '../../src/broker/crypto.ts';
import { checkAnswer } from '../../src/broker/protocol.ts';
import { challengeBytes } from '../../src/broker/policy.ts';
import { sealValue, unlockDigest } from '../../src/broker/seal.ts';
import type { Resolver } from '../../src/broker/http.ts';

export const C = (n: string) => `canary-${n}-7f3a91c2e8b4`;
export const PASS = 'correct-horse-battery-staple';
export const RECOVERY = randomBytes(32).toString('base64');
export const tmp = (p = 'nova-broker-') => mkdtempSync(join(tmpdir(), p));
export const kdf = (): Kdf => ({ alg: 'argon2id', ...KDF_FLOOR, salt: randomBytes(16).toString('base64') });

export type A = Record<string, any>;
export type Call = (m: string, f?: A) => Promise<A>;

export function inProcess(dir = join(tmp(), 'broker'), o: { now?: () => Date; resolve?: Resolver } = {}) {
  const broker = new Broker({ dir, kdf: kdf(), keyMode: 'file', ...o });
  broker.start();
  let n = 0;
  const answers: A[] = [];
  const as = (role: 'core' | 'supervisor'): Call => async (m, f = {}) => {
    const a = { id: ++n, ...(await broker.handle(role, { id: n, m: m as never, ...f })) };
    const bad = checkAnswer(a);
    if (bad) throw new Error(`answer field ${bad} isn’t in the answer schema`);
    answers.push(a);
    return a;
  };
  return { broker, dir, call: as('core'), supervisor: as('supervisor'), answers };
}

// A software authenticator: a P-256 passkey with user verification, for approval tests.
export function softPasskey(rpId = 'localhost', origin = 'https://localhost:4318') {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const id = randomBytes(16).toString('base64url');
  let count = 0;
  return {
    id, rpId, origin,
    registration: { id, public_key: (publicKey.export({ format: 'der', type: 'spki' }) as Buffer).toString('base64'), rp_id: rpId, origins: [origin] },
    assert(challenge: Buffer, o: { uv?: boolean; origin?: string; rpId?: string; count?: number } = {}) {
      const auth = Buffer.alloc(37);
      createHash('sha256').update(o.rpId ?? rpId).digest().copy(auth, 0);
      auth[32] = 0x01 | (o.uv === false ? 0 : 0x04);
      auth.writeUInt32BE(o.count ?? ++count, 33);
      const cdj = Buffer.from(JSON.stringify({ type: 'webauthn.get', challenge: challenge.toString('base64url'), origin: o.origin ?? origin }));
      const sig = sign('sha256', Buffer.concat([auth, createHash('sha256').update(cdj).digest()]), privateKey);
      return { credential_id: id, authenticator_data: auth.toString('base64url'), client_data_json: cdj.toString('base64url'), signature: sig.toString('base64url') };
    },
  };
}

export class Person {
  call: Call;
  passkey: ReturnType<typeof softPasskey> | null = null;
  constructor(call: Call) { this.call = call; }
  async state(): Promise<A> { return (await this.call('list_refs', {})).state; }
  async factor(name: string, value: string) {
    const st = await this.state();
    return sealValue(st.entry_key, await unlockDigest(st.vault_id, name, st.boot), value);
  }
  async setup(o: { passkey?: boolean; recovery?: boolean; ask?: boolean } = {}) {
    if (o.passkey) this.passkey = softPasskey();
    const a = await this.call('unlock', { setup: { passphrase: await this.factor('passphrase', PASS), ...(o.recovery ? { recovery: await this.factor('recovery', RECOVERY) } : {}), ...(o.ask ? { ask_after_restart: true } : {}), ...(this.passkey ? { passkeys: [this.passkey.registration] } : {}) } });
    if (!a.ok) throw new Error(`setup failed: ${JSON.stringify(a)}`);
    return a;
  }
  approval(ch: A, mode: 'core' | 'passkey' = this.passkey ? 'passkey' : 'core') {
    return mode === 'passkey' ? { id: ch.id, digest: ch.digest, mode, ...this.passkey!.assert(challengeBytes(ch.id, ch.digest)) } : { id: ch.id, digest: ch.digest, mode };
  }
  // Calls once, expects needs_approval, approves the card (sealing `value` to it if given), and
  // calls again exactly as before.
  async approve(m: string, f: A, o: { seal?: string; sealAt?: (f: A, env: unknown) => A; mode?: 'core' | 'passkey' } = {}): Promise<A> {
    const first = await this.call(m, f);
    if (first.refused !== 'needs_approval') return first;
    const ch = first.challenge;
    let next: A = { ...f, approval: this.approval(ch, o.mode) };
    if (o.seal !== undefined) {
      const st = await this.state();
      const env = await sealValue(st.entry_key, ch.digest, o.seal);
      next = o.sealAt ? o.sealAt(next, env) : next;
    }
    return this.call(m, next);
  }
}

// A credential bound to an http stand-in, made through the verbs as the person would.
export async function boundCredential(p: Person, origin: string, o: { name?: string; value?: string; consent?: boolean; class?: string; how?: string; header?: string; scope?: A; kind?: string; per_use?: boolean } = {}) {
  const scope = o.scope ?? { methods: ['GET', 'POST'], paths: ['/api'] };
  const bind = [{ target: { kind: 'http', origin }, scope, inject: { how: o.how ?? 'bearer', ...(o.header ? { header: o.header } : {}) }, ...(o.consent === false ? {} : { consent: { scope } }) }];
  const meta = { name: o.name ?? 'provider/EXAMPLE_KEY', kind: o.kind ?? 'api_key', origin, ...(o.class ? { class: o.class } : {}), ...(o.per_use ? { per_use: true } : {}) };
  const a = o.value === undefined
    ? await p.approve('create', { meta, source: 'generate', bind })
    : await p.approve('create', { meta, source: 'sealed', bind }, { seal: o.value, sealAt: (f, env) => ({ ...f, source: { sealed: env } }) });
  if (!a.ok) throw new Error(`create failed: ${JSON.stringify(a)}`);
  return a;
}

export interface StandIn { origin: string; port: number; connections: number; requests: { method: string; url: string; headers: IncomingMessage['headers']; body: string }[]; close(): Promise<void> }
export async function standIn(handle?: (req: IncomingMessage, res: ServerResponse, body: string) => void): Promise<StandIn> {
  const s: StandIn = { origin: '', port: 0, connections: 0, requests: [], close: () => new Promise((ok) => { srv.closeAllConnections(); srv.close(() => ok()); }) };
  const srv = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      s.requests.push({ method: req.method!, url: req.url!, headers: req.headers, body });
      if (handle) handle(req, res, body); else { res.setHeader('content-type', 'text/plain'); res.end(`saw ${req.headers.authorization ?? '-'} ${body}`); }
    });
  });
  srv.on('connection', () => { s.connections++; });
  await new Promise<void>((ok) => srv.listen(0, '127.0.0.1', ok));
  s.port = (srv.address() as { port: number }).port;
  s.origin = `http://127.0.0.1:${s.port}`;
  return s;
}

// Every form the gate searches for (§10 gate item 1): raw, case-folded, base64 (padded or not),
// base64url, hex, URL-encoded and JSON-escaped.
export function formsOf(value: string): string[] {
  const b = Buffer.from(value);
  return [value, encodeURIComponent(value), JSON.stringify(value).slice(1, -1), b.toString('base64'), b.toString('base64').replace(/=+$/, ''), b.toString('base64url'), b.toString('hex')].filter((f) => f.length >= 6);
}
export function anyForm(text: string, value: string): string | null {
  const low = text.toLowerCase();
  return formsOf(value).find((f) => low.includes(f.toLowerCase())) ?? null;
}

// Nova core's stand-in in its own process (tests/support/broker-core-sim.ts), driven from here.
export function coreSim(socket: string, token: string) {
  const child = fork(join(import.meta.dirname, 'broker-core-sim.ts'), [], { env: { PATH: process.env.PATH ?? '', TZ: 'UTC' }, stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
  let seq = 0;
  const waiting = new Map<number, (r: any) => void>();
  child.on('message', (m: { seq: number; r: unknown }) => { waiting.get(m.seq)?.(m.r); waiting.delete(m.seq); });
  const ask = (op: string, f: A = {}) => new Promise<any>((ok) => { const s = ++seq; waiting.set(s, ok); child.send({ seq: s, op, ...f }); });
  const answers: A[] = [];
  const ready = ask('init', { socket, token });
  return {
    child, answers, ready,
    call: (async (m: string, f: A = {}) => { await ready; const a = await ask('call', { m, f }); answers.push(a); return a; }) as Call,
    stage: (home: string) => ask('stage', { home }),
    finish: (home: string, ticket: string) => ask('finish', { home, ticket }),
    run: (ticket: string, program: string) => ask('run', { ticket, program }) as Promise<{ code: number; stdout: string; stderr: string }>,
    heap: (path: string) => ask('heap', { path }) as Promise<string>,
    stop: () => { child.kill(); },
  };
}
