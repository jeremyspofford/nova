// n8n as an automation provider, both ways (M5 plan §1):
// - Outbound: Nova POSTs the brief to a workflow's webhook, signed with HMAC-SHA256 over the
//   exact bytes it sends: `x-nova-signature: t=<unix seconds>,v1=<hex HMAC of "<t>.<body>">`.
// - The report: the workflow calls Nova back through the token webhook (M2's /api/v1/hooks/<name>,
//   `x-nova-hook-token`), with {task_id, status, summary, confirmation: {id}}, signed the same way
//   over the canonical JSON of that body (keys sorted, no spaces). Nova checks token, signature
//   and freshness, and keeps the callback; the confirmation counts as evidence only once Nova has
//   checked that signed callback itself.
import { createHmac, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CoreError } from '../errors.ts';
import { canonicalJson } from '../mesh/wire.ts';
import { summarize } from './prompt.ts';
import { NO_REDIRECT, num, reachProblem, secretName, str, type Config, type Impl, type WorkInput, type WorkOutcome } from './types.ts';

export const SIGNATURE_HEADER = 'x-nova-signature';
export const FRESH_S = 300;
export const CONFIRMATION_SYSTEM = 'n8n';

export const hmac = (secret: string, t: number, body: string) => createHmac('sha256', secret).update(`${t}.${body}`).digest('hex');
export const signatureHeader = (secret: string, body: string, t = Math.floor(Date.now() / 1000)) => `t=${t},v1=${hmac(secret, t, body)}`;

// Whether a signature header is fresh and matches the body. Returns a reason when it doesn't.
export function checkSignature(secret: string, header: string | undefined, body: string, nowS = Math.floor(Date.now() / 1000)): string | null {
  const m = /^t=(\d{1,12}),v1=([0-9a-f]{64})$/.exec(String(header ?? '').trim());
  if (!m) return `The callback has no ${SIGNATURE_HEADER} header of the form t=<seconds>,v1=<hex>.`;
  const t = Number(m[1]);
  if (Math.abs(nowS - t) > FRESH_S) return 'The callback’s signature is too old (or from the future); replays aren’t taken.';
  const want = Buffer.from(hmac(secret, t, body), 'hex');
  const got = Buffer.from(m[2]!, 'hex');
  if (!timingSafeEqual(want, got)) return 'The callback’s signature doesn’t match; it wasn’t signed with the shared secret.';
  return null;
}

export const STATUSES = ['done', 'partial', 'blocked', 'failed'] as const;
export interface Callback { task_id: string; status: (typeof STATUSES)[number]; summary: string; confirmation: { id: string } | null; signed_at: number; received_at: string; provider: string; trigger_id: string | null }

// Callbacks Nova has checked, one per task, kept as files so a restart doesn't lose one that
// arrived while nothing was waiting. Waiters are woken when theirs arrives.
export class Inbox {
  readonly dir: string;
  #waiting = new Map<string, Set<(c: Callback) => void>>();
  constructor(dir: string) { this.dir = dir; }

  #file(taskId: string) {
    if (!/^[A-Za-z0-9-]{1,64}$/.test(taskId)) throw new CoreError('validation', 'task_id isn’t a task id.');
    return join(this.dir, `${taskId}.json`);
  }

  get(taskId: string): Callback | null {
    const f = this.#file(taskId);
    return existsSync(f) ? (JSON.parse(readFileSync(f, 'utf8')) as Callback) : null;
  }

  put(c: Callback): void {
    mkdirSync(this.dir, { recursive: true });
    const f = this.#file(c.task_id);
    writeFileSync(`${f}.tmp`, JSON.stringify(c));
    renameSync(`${f}.tmp`, f);
    for (const wake of this.#waiting.get(c.task_id) ?? []) wake(c);
  }

  wait(taskId: string, signal: AbortSignal): Promise<Callback> {
    const have = this.get(taskId);
    if (have) return Promise.resolve(have);
    return new Promise((ok, fail) => {
      const set = this.#waiting.get(taskId) ?? new Set();
      this.#waiting.set(taskId, set);
      const done = () => { set.delete(wake); if (!set.size) this.#waiting.delete(taskId); signal.removeEventListener('abort', stop); };
      const wake = (c: Callback) => { done(); ok(c); };
      const stop = () => { done(); fail(signal.reason); };
      set.add(wake);
      if (signal.aborted) stop();
      else signal.addEventListener('abort', stop, { once: true });
    });
  }
}

export const n8n = (inbox: Inbox): Impl => ({
  id: 'n8n',
  check(c: Config) {
    const out: string[] = [];
    if (str(c.webhook_url)) {
      try {
        const u = new URL(str(c.webhook_url));
        if (!['http:', 'https:'].includes(u.protocol)) out.push('webhook_url must be an http(s) address.');
      } catch { out.push('webhook_url is the workflow’s webhook address.'); }
    }
    if (c.signing_secret !== undefined && c.signing_secret !== '' && !secretName(c.signing_secret)) out.push('signing_secret names a secret in the vault, like secret://N8N_SIGNING_SECRET; the secret itself never goes in a setting.');
    return out;
  },
  unconfigured(c, secret) {
    if (!str(c.webhook_url)) return 'It needs the workflow’s webhook address.';
    if (!secretName(c.signing_secret)) return 'It needs a signing secret, named in the vault.';
    if (!secret(c.signing_secret)) return `The signing secret ${secretName(c.signing_secret)} isn’t in the vault yet.`;
    if (!c.callback_token_hash) return 'It needs a callback token; saving its settings makes one.';
    return null;
  },
  url: (c) => str(c.webhook_url) || null,
  model: () => 'n8n workflow',
  async probe(c, _secret, signal) {
    // A webhook only answers a real call; reaching the host is what can be checked without one.
    try {
      await fetch(new URL(str(c.webhook_url)).origin, { method: 'HEAD', ...NO_REDIRECT, signal: AbortSignal.any([signal, AbortSignal.timeout(4000)]) });
      return null;
    } catch (e) {
      return `Nova couldn’t reach ${new URL(str(c.webhook_url)).host}: ${reachProblem(e)}.`;
    }
  },
  async work(i: WorkInput): Promise<WorkOutcome> {
    const usage = { model: 'n8n workflow' };
    const outcome = (cb: Callback): WorkOutcome => ({
      status: cb.status === 'done' ? 'done' : cb.status === 'failed' ? 'failed' : 'blocked',
      summary: summarize(cb.summary, `The workflow reported ${cb.status}.`),
      ...(cb.status === 'blocked' || cb.status === 'partial' ? { blockers: [summarize(cb.summary, `The workflow reported ${cb.status}.`)] } : {}),
      evidence: cb.confirmation ? [{ kind: 'confirmation', system: CONFIRMATION_SYSTEM, id: cb.confirmation.id }] : [],
      usage,
    });
    // It already called back (Nova restarted while waiting): that is the answer; nothing is sent again.
    const already = inbox.get(i.brief.task_id);
    if (already) return outcome(already);
    const secret = i.secret(i.config.signing_secret);
    if (!secret) return { status: 'blocked', summary: 'The n8n signing secret isn’t in the vault.', blockers: ['The n8n signing secret isn’t in the vault.'], usage };
    const body = canonicalJson({
      event: 'nova.brief', task_id: i.brief.task_id, idempotency_key: i.brief.idempotency_key, brief: i.brief,
      callback: { path: `/api/v1/hooks/${i.provider}-callback`, ...(str(i.config.callback_url) ? { url: str(i.config.callback_url) } : {}) },
    });
    const host = new URL(str(i.config.webhook_url)).host;
    let res: Response;
    try {
      res = await fetch(str(i.config.webhook_url), {
        method: 'POST', ...NO_REDIRECT, signal: AbortSignal.any([i.signal, AbortSignal.timeout(30_000)]),
        headers: { 'content-type': 'application/json', [SIGNATURE_HEADER]: signatureHeader(secret, body), 'x-nova-task': i.brief.task_id, 'idempotency-key': i.brief.idempotency_key },
        body,
      });
    } catch (e) {
      if (i.signal.aborted) throw i.signal.reason;
      return { status: 'failed', summary: `Nova couldn’t reach the workflow at ${host}: ${reachProblem(e)}.`, usage };
    }
    if (!res.ok) return { status: 'failed', summary: `The workflow at ${host} turned the brief down (${res.status}).`, usage };
    i.log(`sent to ${host}; waiting for its callback`);
    const cb = await inbox.wait(i.brief.task_id, i.signal);
    return outcome(cb);
  },
});

export const timeoutS = (c: Config) => num(c.timeout_s, 900);
