// The Credential Broker (docs/plans/vault-broker.md §4–§8): seven fixed verbs and three protocol
// messages, each checked on the broker's own authority. Whoever asks (core, with a valid token and
// even a valid approval for something else) gets refused when the target isn't bound exactly, the
// request is outside the binding's scope, or the class, consent or approval doesn't allow it.
// No answer carries a value; every verb writes one audit record, which comes back in the answer
// for core to copy into the Work Ledger.
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { Audit, type Entry } from './audit.ts';
import { entryKey, openEnvelope, type Envelope, type Kdf } from './crypto.ts';
import { send, EgressError, type Resolver } from './http.ts';
import { chooseStore, FILE_NOTICE, type KeyStore } from './keystore.ts';
import { BUILT, canonicalTarget, checkScope, inScope, lookalikes, requestPath, suggestClass } from './origin.ts';
import { Approvals, Rates, digestOf, generate, weak, DEFAULT_POLICY, USES_PER_REF_HOUR, type ApprovalIn } from './policy.ts';
import { REFUSALS, type Binding, type Card, type Frame, type Inject, type Refusal, type Role, type Scope } from './protocol.ts';
import { Scrubber } from './scrub.ts';
import { Store, sameBytes, type Meta, type OutboxHeader } from './store.ts';
import { OWN_KEYS } from './oldvault.ts';

export interface BrokerOptions {
  dir: string;
  deviceStore?: (account: string) => KeyStore;
  kdf?: Kdf;
  now?: () => Date;
  resolve?: Resolver;
  keyMode?: 'auto' | 'file' | 'keychain';
}

type Answer = Record<string, unknown>;
interface Ticket { kind: 'run' | 'migrate' | 'finish'; id?: string; version?: 'current' | 'pending'; target?: string; path?: string; sha256?: string; argv?: string[]; inject?: Inject; expires: number; redeemed: boolean; staged?: Map<string, Buffer>; done?: boolean; migrated?: string[] }

const NAME = /^[a-z0-9][a-z0-9._-]*(\/[A-Za-z0-9._-]+)*$/;
const ALIAS = 'secret://';
const TICKET_MS = 60_000;
const CONSENT_SENSITIVE = 'A sensitive credential always asks first (once per task, or on every use): it can’t have a standing consent.';
const KINDS = new Set(['api_key', 'token', 'login', 'secret', 'oauth', 'signing_key']);
const str = (v: unknown, max = 300): v is string => typeof v === 'string' && v.length > 0 && v.length <= max;
const zero = (b: Buffer | null | undefined) => { if (b) b.fill(0); };

class Refused extends Error {
  readonly code: Refusal;
  readonly extra: Answer;
  constructor(code: Refusal, words?: string, extra: Answer = {}) { super(words ?? REFUSALS[code]); this.code = code; this.extra = extra; }
}
class Failed extends Error {}

export class Broker {
  readonly store: Store;
  readonly audit: Audit;
  readonly boot = randomBytes(12).toString('hex');
  readonly scrubber = new Scrubber();
  #o: BrokerOptions;
  #entry = entryKey();
  #approvals: Approvals;
  #rates: Rates;
  #tickets = new Map<string, Ticket>();
  #grants = new Set<string>();
  #index = new Map<string, Meta & { version: number; pending: boolean }>();
  #health = new Map<string, { weak: boolean; reused: boolean; old: boolean }>();
  #broken: string[] = [];
  #pendingId = randomUUID();
  #failedUnlocks: number[] = [];
  // A problem raised on the broker's own authority (flood control, a scrubbed answer).
  problem: string | null = null;

  constructor(o: BrokerOptions) {
    this.#o = o;
    const now = () => (o.now?.() ?? new Date()).getTime();
    this.#approvals = new Approvals(now);
    this.#rates = new Rates(now);
    const deviceStore = o.deviceStore ?? ((account: string) => chooseStore('nova-broker', account, join(o.dir, account.startsWith('sign-') ? 'sign.key' : 'device.key'), o.keyMode ? { mode: o.keyMode } : {}));
    this.store = new Store({ dir: o.dir, deviceStore, ...(o.kdf ? { kdf: o.kdf } : {}), ...(o.now ? { now: o.now } : {}) });
    this.audit = new Audit(join(o.dir, 'audit.log'), this.store.device().id, o.now);
  }

  #now() { return this.#o.now?.() ?? new Date(); }

  // At start: a hub unlocks itself with its device key, as today (§10 "A hub has to work
  // unattended"), unless the person chose "ask me after a restart". A holder adopts its inbox.
  start(): void {
    try { this.#adoptInbox(); } catch { /* nothing to adopt, or not for this device */ }
    const h = this.store.header;
    if (h && !this.store.unlocked && h.unlock_mode === 'auto' && h.wraps[`device:${this.store.device().id}`]) {
      try { this.store.unlock({ kind: 'device' }); this.#reindex(); } catch { /* stays locked; Health says why */ }
    }
  }

  // ---- the index, the scrubber, health flags (in memory only) ---------------------------------

  #reindex(): void {
    const { items, broken } = this.store.metas();
    this.#index = items;
    this.#broken = broken;
    const values = new Map<string, string>();
    const seen = new Map<string, string[]>();
    this.#health.clear();
    for (const [id, m] of items) {
      const v = this.store.value(id);
      const s = v.toString('utf8');
      values.set(id, s);
      seen.set(s, [...(seen.get(s) ?? []), id]);
      const old = !!m.last_rotated ? Date.parse(m.last_rotated) < this.#now().getTime() - 365 * 86400_000 : Date.parse(m.created_at) < this.#now().getTime() - 365 * 86400_000;
      this.#health.set(id, { weak: m.kind === 'login' && weak(v), reused: false, old });
      zero(v);
      if (m.pending) { const p = this.store.value(id, 'pending'); values.set(`${id}#p`, p.toString('utf8')); zero(p); }
    }
    for (const ids of seen.values()) if (ids.length > 1) for (const id of ids) this.#health.get(id)!.reused = true;
    this.scrubber.set(values.values());
  }

  #resolve(ref: unknown): string {
    if (!str(ref, 260)) throw new Refused('unknown_ref');
    if (ref.startsWith(ALIAS)) { for (const [id, m] of this.#index) if (m.aliases.includes(ref)) return id; throw new Refused('unknown_ref'); }
    if (!this.#index.has(ref)) throw new Refused('unknown_ref');
    return ref;
  }

  #refMeta(id: string) {
    const m = this.#index.get(id)!;
    return {
      ref: id, aliases: m.aliases, name: m.name, kind: m.kind, origin: m.origin, username: m.username, class: m.class, per_use: m.per_use,
      created_at: m.created_at, last_used: m.last_used, last_rotated: m.last_rotated, health: this.#health.get(id) ?? { weak: false, reused: false, old: false },
      backend: 'nova', version: m.version, pending: m.pending, bindings: m.bindings,
    };
  }

  state(): Answer {
    const h = this.store.header;
    const dev = this.store.device();
    return {
      exists: !!h, locked: !this.store.unlocked, vault_id: h?.id ?? this.#pendingId, unlock_mode: h?.unlock_mode ?? null,
      approval_mode: h && Object.keys(h.passkeys).length ? 'passkey' : 'core',
      factors: h ? Object.keys(h.wraps).map((n) => (n.startsWith('device:') ? (n === `device:${dev.id}` ? 'this device' : 'another holder') : n.split(':')[0])) : [],
      entry_key: this.#entry.pub, boot: this.boot, device_id: dev.id, device_key: dev.store,
      holders: h ? Object.entries(h.holders).map(([id, x]) => ({ device: id, name: x.name })) : [],
      kdf: h ? { alg: h.kdf.alg, m: h.kdf.m, t: h.kdf.t, p: h.kdf.p } : null,
      problem: this.problem ?? (this.#broken.length ? `${this.#broken.length} item(s) failed to open (tampered, moved or damaged) and are left as they are.` : dev.store === 'file' && h?.unlock_mode === 'auto' ? FILE_NOTICE : null),
    };
  }

  // ---- dispatch -------------------------------------------------------------------------------

  async handle(role: Role, f: Frame): Promise<Answer> {
    const task = f.task && typeof f.task === 'object' && str((f.task as { id?: unknown }).id, 80) ? { id: (f.task as { id: string }).id, title: String((f.task as { title?: unknown }).title ?? '').slice(0, 200) } : null;
    const caller = str(f.caller, 40) ? f.caller : null;
    const rec: Entry = { verb: f.m, ref: null, target: null, scope_item: null, outcome: 'ok', tier: null, approval_id: null, task: task?.id ?? null, role };
    try {
      const out = await this.#dispatch(role, f, rec, task, caller);
      return { ok: true, ...out, record: this.audit.write(rec) };
    } catch (e) {
      if (e instanceof Refused) {
        rec.outcome = `refused:${e.code}`;
        return { refused: e.code, words: e.message, ...e.extra, record: this.audit.write(rec) };
      }
      rec.outcome = `failed:${e instanceof EgressError ? e.cls : e instanceof Failed ? 'request' : 'internal'}`;
      return { error: 'failed', words: e instanceof Failed || e instanceof EgressError ? e.message : 'The broker couldn’t do that.', record: this.audit.write(rec) };
    }
  }

  async #dispatch(role: Role, f: Frame, rec: Entry, task: { id: string; title: string } | null, caller: string | null): Promise<Answer> {
    if (f.m === 'lock') { this.lock(); return { state: this.state() }; }
    if (f.m === 'list_refs') return this.#list(f.filter);
    if (role !== 'core' && f.m !== 'unlock') throw new Failed('Only core asks the broker for that.');
    if (f.m === 'unlock') { if (role !== 'core') throw new Failed('Only core relays an unlock.'); this.#unlock(f); return { state: this.state() }; }
    if (!this.store.unlocked) throw new Refused('locked');
    const ctx = { rec, task, caller, approval: f.approval as ApprovalIn | undefined };
    switch (f.m) {
      case 'use': return this.#use(f, ctx);
      case 'create': return this.#create(f, ctx);
      case 'update': return this.#update(f, ctx);
      case 'rotate': return this.#rotate(f, ctx);
      case 'bind': return this.#bind(f, ctx);
      case 'share_scope': return this.#share(f, ctx);
      default: throw new Failed('not a verb');
    }
  }

  lock(): void {
    this.store.lock();
    this.scrubber.set([]);
    this.#index.clear();
    this.#tickets.clear();
    this.#grants.clear();
    this.#approvals.clear();
  }

  // ---- approvals ------------------------------------------------------------------------------

  // Either the approval checks out for exactly this action (returns its id), or the answer is a
  // challenge for it (needs_approval), or the approval is refused.
  #approve(ctx: Ctx, action: Record<string, unknown>, card: Omit<Card, 'expires_at' | 'task' | 'caller'>, passkey = false): string {
    const h = this.store.header!;
    const needsPasskey = passkey && Object.keys(h.passkeys).length > 0;
    const full = { ...action, task: ctx.task?.id ?? null };
    if (!ctx.approval) {
      const c = this.#approvals.issue(full, { ...card, task: ctx.task, caller: ctx.caller }, ctx.task?.id ?? null, needsPasskey);
      if (!c) { this.problem = 'Something keeps asking to use your credentials: approval requests are refused for now.'; throw new Refused('rate'); }
      ctx.rec.tier = card.tier;
      throw new Refused('needs_approval', undefined, { challenge: c });
    }
    const r = this.#approvals.check(ctx.approval, full, h.passkeys, (id, n) => this.store.bumpSignCount(id, n));
    ctx.rec.approval_id = typeof ctx.approval.id === 'string' ? ctx.approval.id.slice(0, 40) : null;
    ctx.rec.tier = card.tier;
    if (!r.ok) throw new Refused('approval_invalid', `${REFUSALS.approval_invalid} (${r.why})`);
    return r.id;
  }

  #sealed(e: unknown, digest: string): Buffer {
    try { return openEnvelope(this.#entry.priv, e as Envelope, digest); } catch { throw new Refused('approval_invalid', 'The sealed value doesn’t open for this action (sealed for another one, or damaged).'); }
  }

  // ---- unlock ---------------------------------------------------------------------------------

  #unlock(f: Frame): void {
    const t = this.#now().getTime();
    this.#failedUnlocks = this.#failedUnlocks.filter((x) => x > t - 60_000);
    if (this.#failedUnlocks.length >= 5) throw new Refused('rate', 'Too many unlock attempts; wait a minute.');
    const h = this.store.header;
    const vid = h?.id ?? this.#pendingId;
    const dg = (factor: string) => unlockDigest(vid, factor, this.boot);
    const opened: Buffer[] = [];
    const take = (e: unknown, factor: string) => { const b = this.#sealedUnlock(e, dg(factor)); opened.push(b); return b; };
    try {
      if (f.setup) {
        if (h) throw new Failed('There is a vault here already.');
        const s = f.setup as { passphrase?: unknown; recovery?: unknown; ask_after_restart?: unknown; passkeys?: unknown };
        const passkeys = Array.isArray(s.passkeys) ? s.passkeys.slice(0, 5).map((p: { id?: unknown; public_key?: unknown; rp_id?: unknown; origins?: unknown; prf?: unknown }) => {
          if (!str(p.id, 200) || !/^[A-Za-z0-9_-]+$/.test(p.id) || !str(p.public_key, 400) || !str(p.rp_id, 253) || !Array.isArray(p.origins) || !p.origins.every((o) => str(o, 300))) throw new Failed('not a passkey registration');
          return { id: p.id, public_key: p.public_key, rp_id: p.rp_id, origins: p.origins as string[], prf: p.prf ? take(p.prf, `passkey:${p.id}`) : null };
        }) : [];
        this.store.create({ id: vid, passphrase: take(s.passphrase, 'passphrase'), recovery: s.recovery ? take(s.recovery, 'recovery') : null, passkeys, unlock_mode: s.ask_after_restart === true ? 'ask' : 'auto' });
      } else if (f.device === true) {
        this.#adoptInbox();
        this.store.unlock({ kind: 'device' });
      } else if (f.passphrase) this.store.unlock({ kind: 'passphrase', secret: take(f.passphrase, 'passphrase') });
      else if (f.recovery) this.store.unlock({ kind: 'recovery', secret: take(f.recovery, 'recovery') });
      else if (f.passkey && typeof f.passkey === 'object') {
        const p = f.passkey as { id?: unknown; prf?: unknown };
        if (!str(p.id, 200)) throw new Failed('not a passkey');
        this.store.unlock({ kind: 'passkey', id: p.id, secret: take(p.prf, `passkey:${p.id}`) });
      } else throw new Failed('An unlock brings one factor.');
    } catch (e) {
      if (e instanceof Failed) throw e;
      this.#failedUnlocks.push(t);
      throw e instanceof Refused ? e : new Refused('locked', (e as Error).message);
    } finally { for (const b of opened) zero(b); }
    this.#reindex();
  }

  #sealedUnlock(e: unknown, digest: string): Buffer {
    try { return openEnvelope(this.#entry.priv, e as Envelope, digest); } catch { throw new Refused('locked', 'That factor wasn’t sealed for this broker’s current boot.'); }
  }

  #adoptInbox(): void {
    const dir = join(this.store.dir, 'inbox');
    if (!existsSync(join(dir, 'header.json'))) return;
    const header = JSON.parse(readFileSync(join(dir, 'header.json'), 'utf8')) as OutboxHeader;
    if (this.store.header && this.store.header.id === header.id && this.store.header.gen >= header.gen && this.store.unlocked) return;
    const items: Record<string, string> = {};
    for (const n of readdirSync(join(dir, 'items')).filter((x) => x.endsWith('.json'))) items[n.slice(0, -5)] = readFileSync(join(dir, 'items', n), 'utf8');
    this.store.adopt(header, items);
  }

  // ---- list_refs (tier 0) ---------------------------------------------------------------------

  #list(filter: unknown): Answer {
    if (!this.store.unlocked) return { state: this.state(), refs: [] };
    const fl = (filter && typeof filter === 'object' ? filter : {}) as { prefix?: unknown; kind?: unknown };
    const refs = [...this.#index.keys()].map((id) => this.#refMeta(id))
      .filter((r) => (typeof fl.prefix !== 'string' || r.aliases.some((a) => a.startsWith(`${ALIAS}${fl.prefix}`))) && (typeof fl.kind !== 'string' || r.kind === fl.kind));
    return { state: this.state(), refs };
  }

  // ---- use (tier 1 / 2) -----------------------------------------------------------------------

  async #use(f: Frame, ctx: Ctx): Promise<Answer> {
    const id = this.#resolve(f.ref);
    ctx.rec.ref = id;
    const m = this.#index.get(id)!;
    let t: { kind: string; target: string };
    try { t = canonicalTarget(f.target as object); } catch { throw new Refused('not_bound'); }
    ctx.rec.target = t.target;
    const b = m.bindings.find((x) => x.kind === t.kind && x.target === t.target);
    if (!b) throw new Refused('not_bound');
    if (!BUILT.has(b.kind)) throw new Refused('wrong_target_kind', `Using a credential on a ${b.kind} target isn’t built yet (Phase 1, later PRs).`);
    const req = (f.request ?? {}) as { method?: unknown; path?: unknown; headers?: unknown; body?: unknown; verify?: unknown; argv?: unknown };
    const which = f.version === 'pending' ? 'pending' : 'current';
    if (which === 'pending' && !m.pending) throw new Refused('out_of_scope', 'There is no pending version to use.');
    // What is asked for, in the binding's terms.
    let method = 'RUN';
    let bare = '/';
    let path = '/';
    if (b.kind === 'http') {
      if (b.inject.how === 'verify') { method = 'VERIFY'; } else {
        if (!str(req.method, 10)) throw new Refused('out_of_scope');
        method = req.method.toUpperCase();
        try { ({ path, bare } = requestPath(req.path)); } catch { throw new Refused('out_of_scope', 'That request path isn’t one the broker sends.'); }
      }
      ctx.rec.scope_item = `${method} ${bare}`;
      if (method !== 'VERIFY' && !inScope(b.scope, method, bare)) throw new Refused('out_of_scope');
    } else ctx.rec.scope_item = 'RUN';
    const argv = b.kind === 'process' ? (Array.isArray(req.argv) ? req.argv : []) : null;
    if (argv && (argv.length > 64 || !argv.every((x) => typeof x === 'string' && x.length <= 4096))) throw new Refused('out_of_scope', 'A program’s arguments are up to 64 strings.');
    // Class, consent, approval.
    const key = `${id}|${b.target}`;
    // A tier-2 approval covers this request (method and path, or a program's exact arguments) for
    // this task, nothing wider. The arguments are on the card and in the digest, never the ledger.
    const grant = `${key}|${ctx.task?.id ?? '-'}|${ctx.rec.scope_item}|${which}|${argv ? JSON.stringify(argv) : ''}`;
    const standing = m.class === 'standard' && !m.per_use && !!b.consent && (method === 'RUN' || method === 'VERIFY' || inScope(b.consent.scope, method, bare));
    if (standing) {
      ctx.rec.tier = 1;
      ctx.rec.approval_id = b.consent!.approval_id;
      if (!this.#rates.take(`c|${key}`, b.consent!.rate_per_hour)) throw new Refused('rate');
    } else if (m.per_use || !this.#grants.has(grant)) {
      this.#approve(ctx, { verb: 'use', ref: id, target: b.target, scope_item: ctx.rec.scope_item, class: m.class, version: which, ...(argv ? { argv } : {}) }, {
        verb: 'use', what: `Use your ${m.kind === 'login' ? 'sign-in' : 'credential'} “${m.name}” for ${b.target}`, name: m.name, origin: m.origin, username: m.username, target: b.target,
        scope: b.scope, class: m.class, tier: 2, approving: m.per_use ? 'Allows this one use.' : 'Allows uses like this one for this task.', ...(argv ? { argv: argv as string[] } : {}),
      });
      if (!m.per_use) this.#grants.add(grant);
    } else ctx.rec.tier = 2;
    if (!this.#rates.take(`r|${id}`, USES_PER_REF_HOUR)) throw new Refused('rate');
    this.store.touch(id);
    m.last_used = this.#now().toISOString();
    if (b.kind === 'process') {
      const ticket = `tk_${randomBytes(24).toString('base64url')}`;
      const [path_, sha] = b.target.split('#sha256:') as [string, string];
      this.#tickets.set(ticket, { kind: 'run', id, version: which, target: b.target, path: path_, sha256: sha, argv: argv as string[], inject: b.inject, expires: this.#now().getTime() + TICKET_MS, redeemed: false });
      return { outcome: { ticket, expires_at: new Date(this.#now().getTime() + TICKET_MS).toISOString() } };
    }
    const value = this.store.value(id, which);
    try {
      if (b.inject.how === 'verify') {
        const v = (req.verify ?? {}) as { body?: unknown; signature?: unknown };
        if (typeof v.body !== 'string' || typeof v.signature !== 'string') throw new Refused('out_of_scope', 'A check brings the body and the signature it came with.');
        const mac = hmac(value, Buffer.from(v.body, 'utf8'), b.inject);
        const sig = v.signature.trim();
        return { outcome: { valid: mac.length === sig.length && timingSafeEqual(Buffer.from(mac), Buffer.from(sig)) } };
      }
      const headers = callerHeaders(req.headers, b.inject);
      const body = req.body === undefined || req.body === null ? null : typeof req.body === 'string' ? Buffer.from(req.body, 'utf8') : null;
      if (req.body !== undefined && req.body !== null && !body) throw new Refused('out_of_scope', 'A request body is text.');
      if (body && body.length > 1024 * 1024) throw new Refused('out_of_scope', 'A request body is up to 1 MiB.');
      inject(headers, b.inject, value, m.username, body);
      const res = await send({ origin: b.target, method, path, headers, body, lan: !!b.lan, pin: b.pin ?? null }, this.#o.resolve);
      const one = new Scrubber([value.toString('utf8')]);
      return { outcome: { status: res.status, headers: one.any(res.headers), body: one.text(res.body), truncated: res.truncated } };
    } finally { zero(value); }
  }

  // ---- create (tier 3) ------------------------------------------------------------------------

  #create(f: Frame, ctx: Ctx): Answer {
    const src = f.source as unknown;
    if (src && typeof src === 'object' && 'migrate' in src) return this.#migrate(src as { migrate: unknown; proposals?: unknown }, ctx);
    const mi = (f.meta ?? {}) as Record<string, unknown>;
    if (!str(mi.name, 200) || !NAME.test(mi.name)) throw new Failed('A credential is named like provider/EXAMPLE_KEY (letters, digits, dots, dashes, slashes).');
    if (!str(mi.kind, 20) || !KINDS.has(mi.kind)) throw new Failed('Not a kind of credential the broker keeps.');
    const alias = `${ALIAS}${mi.name}`;
    for (const x of this.#index.values()) if (x.aliases.includes(alias)) throw new Failed('There is a credential with that name already; update it instead.');
    let origin: string | null = null;
    if (mi.origin !== undefined && mi.origin !== null) { try { origin = canonicalTarget({ kind: 'http', origin: mi.origin }).target; } catch { throw new Failed('The site isn’t a canonical https origin.'); } }
    const suggested = suggestClass(origin, mi.kind);
    const cls = mi.class === 'standard' || mi.class === 'sensitive' ? mi.class : suggested;
    const pol = mi.policy as { length?: unknown; alphabet?: unknown } | undefined;
    const policy = pol ? { length: Number(pol.length ?? DEFAULT_POLICY.length), alphabet: String(pol.alphabet ?? DEFAULT_POLICY.alphabet) } : DEFAULT_POLICY;
    if (pol) { try { zero(generate(policy)); } catch (e) { throw new Failed((e as Error).message); } }
    const bindings = Array.isArray(f.bind) ? f.bind.slice(0, 20).map((x) => this.#binding(x)) : [];
    if (cls === 'sensitive' && bindings.some((b) => b.consent)) throw new Refused('class_policy', CONSENT_SENSITIVE);
    const kind = src === 'generate' ? 'generate' : src === 'sealed' || (src && typeof src === 'object' && 'sealed' in src) ? 'sealed' : null;
    if (!kind) throw new Failed('A value comes from generate or sealed entry (or migrate).');
    const meta: Meta = { name: mi.name, aliases: [alias], kind: mi.kind, origin, username: str(mi.username, 300) ? mi.username : null, class: cls, per_use: mi.per_use === true, created_at: this.#now().toISOString(), last_used: null, last_rotated: null, bindings, policy };
    const action = { verb: 'create', name: meta.name, kind: meta.kind, origin, username: meta.username, class: cls, per_use: meta.per_use, bindings: bindings.map(cardBinding), source: kind };
    const flags = bindings.flatMap((b) => this.#flags(b.target, b.kind));
    const approval = this.#approve(ctx, action, { verb: 'create', what: kind === 'generate' ? `Make a new password for ${origin ?? meta.name}` : `Save a credential for ${origin ?? meta.name}`, name: meta.name, origin, username: meta.username, class: cls, flags, tier: 3, approving: `Saves it in Nova Vault${bindings.length ? `, usable only on ${bindings.map((b) => b.target).join(', ')}` : ', unbound (usable nowhere until you bind it)'}. Suggested class: ${suggested}.` }, bindings.length > 0);
    for (const b of meta.bindings) if (b.consent) b.consent.approval_id = approval;
    const value = kind === 'generate' ? generate(policy) : this.#sealed((src as { sealed: unknown }).sealed, this.#digest(action, ctx));
    try {
      if (!value.length || value.length > 64 * 1024) throw new Failed('A value is 1 byte to 64 KiB.');
      const { id } = this.store.add(meta, value);
      ctx.rec.ref = id;
      this.#reindex();
      return this.#refMeta(id);
    } finally { zero(value); }
  }

  // What a sealed value is bound to: the digest of the approved action, as the client saw it.
  #digest(action: Record<string, unknown>, ctx: Ctx) { return digestOf({ ...action, task: ctx.task?.id ?? null }); }

  // ---- update (tier 3) ------------------------------------------------------------------------

  #update(f: Frame, ctx: Ctx): Answer {
    const id = this.#resolve(f.ref);
    ctx.rec.ref = id;
    const m = this.#index.get(id)!;
    const ch = f.change as unknown;
    if (ch === 'remove') {
      this.#approve(ctx, { verb: 'update', ref: id, change: 'remove' }, { verb: 'update', what: `Delete “${m.name}” for good`, name: m.name, origin: m.origin, username: m.username, class: m.class, tier: 3, approving: 'Destroys it, and re-keys the vault so no older copy opens it.' });
      this.store.remove(id);
      this.#reindex();
      return { ref: id, removed: true };
    }
    if (!ch || typeof ch !== 'object') throw new Failed('An update is a new value, metadata, or remove.');
    const c = ch as { value?: unknown; meta?: Record<string, unknown> };
    if (c.meta) {
      const next: Meta = { ...m };
      const mm = c.meta;
      for (const k of Object.keys(mm)) if (!['name', 'username', 'class', 'per_use'].includes(k)) throw new Failed(`${k} isn’t metadata an update changes.`);
      if (mm.name !== undefined) { if (!str(mm.name, 200) || !NAME.test(mm.name)) throw new Failed('not a name'); next.name = mm.name; next.aliases = [...new Set([...m.aliases, `${ALIAS}${mm.name}`])]; }
      if (mm.username !== undefined) next.username = str(mm.username, 300) ? mm.username : null;
      if (mm.class !== undefined) { if (mm.class !== 'standard' && mm.class !== 'sensitive') throw new Failed('not a class'); next.class = mm.class; }
      if (mm.per_use !== undefined) next.per_use = mm.per_use === true;
      this.#approve(ctx, { verb: 'update', ref: id, meta: { name: next.name, username: next.username, class: next.class, per_use: next.per_use } }, { verb: 'update', what: `Change the details of “${m.name}”${next.class !== m.class ? ` (class ${m.class} → ${next.class})` : ''}`, name: next.name, origin: m.origin, username: next.username, class: next.class, tier: 3, approving: 'Saves the new details.' });
      this.store.setMeta(id, stripIndex(next));
      this.#reindex();
      return this.#refMeta(id);
    }
    const kind = c.value === 'generate' ? 'generate' : c.value === 'sealed' || (c.value && typeof c.value === 'object' && 'sealed' in c.value) ? 'sealed' : null;
    if (!kind) throw new Failed('A new value comes from generate or sealed entry.');
    const action = { verb: 'update', ref: id, value: kind };
    this.#approve(ctx, action, { verb: 'update', what: kind === 'generate' ? `Make a new value for “${m.name}”` : `Replace the value of “${m.name}”`, name: m.name, origin: m.origin, username: m.username, class: m.class, tier: 3, approving: 'Replaces the value inside the broker. The site itself isn’t changed by this.' });
    const value = kind === 'generate' ? generate(m.policy) : this.#sealed((c.value as { sealed: unknown }).sealed, this.#digest(action, ctx));
    try {
      const version = this.store.setValue(id, value);
      this.#reindex();
      return { ref: id, version };
    } finally { zero(value); }
  }

  // ---- rotate (tier 3; abandon at once) -------------------------------------------------------

  #rotate(f: Frame, ctx: Ctx): Answer {
    const id = this.#resolve(f.ref);
    ctx.rec.ref = id;
    const m = this.#index.get(id)!;
    if (f.phase === 'abandon') { if (m.pending) this.store.dropPending(id); this.#reindex(); return { ref: id, version: m.version, pending: false }; }
    if (f.phase !== 'begin' && f.phase !== 'commit') throw new Failed('A rotation begins, then commits or is abandoned.');
    if (f.phase === 'commit' && !m.pending) throw new Failed('There is no rotation to commit.');
    this.#approve(ctx, { verb: 'rotate', ref: id, phase: f.phase }, { verb: 'rotate', what: f.phase === 'begin' ? `Make a new password for “${m.name}”, kept aside until the site takes it` : `Keep the new password for “${m.name}”`, name: m.name, origin: m.origin, username: m.username, class: m.class, tier: 3, approving: f.phase === 'begin' ? 'Generates it inside the broker. Typing it into the site’s change form is a separate, visible step.' : 'The new value replaces the old one.' });
    let version: number;
    if (f.phase === 'begin') { const v = generate(m.policy); try { version = this.store.setPending(id, v); } finally { zero(v); } }
    else version = this.store.commitPending(id);
    this.#reindex();
    return { ref: id, version, pending: f.phase === 'begin' };
  }

  // ---- bind (tier 3 to add or widen; removing at once) ----------------------------------------

  #binding(x: unknown): Binding {
    const a = (x ?? {}) as { target?: unknown; scope?: unknown; inject?: unknown; consent?: unknown; lan?: unknown; pin?: unknown; embed_on?: unknown };
    let t: { kind: Binding['kind']; target: string };
    try { t = canonicalTarget(a.target as object); } catch (e) { throw new Failed(`Not a target the broker binds: ${(e as Error).message}.`); }
    if (!BUILT.has(t.kind) && t.kind !== 'web') throw new Refused('wrong_target_kind', `Binding a ${t.kind} target isn’t built yet.`);
    const inj = (a.inject ?? {}) as Inject;
    const hows = t.kind === 'process' ? ['env', 'file'] : t.kind === 'web' ? ['fill'] : ['bearer', 'basic', 'header', 'sign', 'verify'];
    if (t.kind === 'web') (inj as { how: string }).how = 'fill';
    if (!hows.includes(inj.how)) throw new Failed(`A ${t.kind} binding injects by ${hows.join(', ')}.`);
    if ((inj.how === 'header' || inj.how === 'sign') && (!str(inj.header, 60) || !/^[A-Za-z0-9-]+$/.test(inj.header) || /^(host|cookie|content-length|transfer-encoding|connection)$/i.test(inj.header))) throw new Failed('A header binding names an ordinary header.');
    if ((inj.how === 'env' || inj.how === 'file') && (!str(inj.env, 80) || !/^[A-Z_][A-Z0-9_]*$/.test(inj.env))) throw new Failed('A program binding names its environment variable.');
    if (inj.prefix !== undefined && (!str(inj.prefix, 40) || /[\r\n]/.test(inj.prefix))) throw new Failed('not a prefix');
    const scope = t.kind === 'http' ? checkScope(a.scope) : { methods: ['RUN'], paths: ['/'] };
    let consent: Binding['consent'] = null;
    if (a.consent) {
      const c = a.consent as { scope?: unknown; rate_per_hour?: unknown };
      const cs = t.kind === 'http' ? checkScope(c.scope ?? scope) : scope;
      if (t.kind === 'http' && !cs.paths.every((p) => cs.methods.every((mm) => inScope(scope, mm, p)))) throw new Failed('A standing consent can’t be wider than its binding.');
      const rate = Number(c.rate_per_hour ?? 600);
      if (!Number.isInteger(rate) || rate < 1 || rate > USES_PER_REF_HOUR) throw new Failed('not a rate cap');
      consent = { scope: cs, rate_per_hour: rate, granted_at: this.#now().toISOString(), approval_id: '', last_used: null };
    }
    const pin = a.pin === undefined || a.pin === null ? null : String(a.pin).replace(/:/g, '').toLowerCase();
    if (pin !== null && !/^[0-9a-f]{64}$/.test(pin)) throw new Failed('A pin is the certificate’s SHA-256.');
    if (a.lan === true && !pin) throw new Failed('A LAN device is bound only with a pinned certificate.');
    if (t.kind !== 'http' && (pin || a.lan)) throw new Failed('Only an http target pins a certificate.');
    const embed = Array.isArray(a.embed_on) ? a.embed_on.slice(0, 5).map((o) => canonicalTarget({ kind: 'web', origin: o }).target) : [];
    return { target: t.target, kind: t.kind, scope, inject: { how: inj.how, ...(inj.header ? { header: inj.header } : {}), ...(inj.env ? { env: inj.env } : {}), ...(inj.prefix ? { prefix: inj.prefix } : {}), ...(inj.format ? { format: inj.format === 'base64' ? 'base64' : 'hex' } : {}) }, consent, ...(a.lan === true ? { lan: true } : {}), pin, ...(embed.length ? { embed_on: embed } : {}) };
  }

  #flags(target: string, kind: string): string[] {
    if (kind === 'process') return [];
    const bound = [...this.#index.values()].flatMap((m) => m.bindings.filter((b) => b.kind !== 'process').map((b) => b.target));
    const l = lookalikes(target, bound);
    return [...(l.unicode ? [`shown as ${l.unicode}`] : []), ...l.flags];
  }

  #bind(f: Frame, ctx: Ctx): Answer {
    const id = this.#resolve(f.ref);
    ctx.rec.ref = id;
    const m = this.#index.get(id)!;
    if (f.remove) {
      const r = f.remove as { target?: unknown; consent_only?: unknown };
      let t: string;
      try { t = canonicalTarget(r.target as object).target; } catch { throw new Refused('not_bound'); }
      ctx.rec.target = t;
      const next = { ...m, bindings: r.consent_only === true ? m.bindings.map((b) => (b.target === t ? { ...b, consent: null } : b)) : m.bindings.filter((b) => b.target !== t) };
      this.store.setMeta(id, stripIndex(next));
      for (const g of [...this.#grants]) if (g.startsWith(`${id}|${t}|`)) this.#grants.delete(g);
      this.#reindex();
      return { ref: id, bindings: this.#index.get(id)!.bindings };
    }
    const b = this.#binding(f.add);
    ctx.rec.target = b.target;
    if (b.consent && m.class === 'sensitive') throw new Refused('class_policy', CONSENT_SENSITIVE);
    const flags = this.#flags(b.target, b.kind);
    const before = m.bindings.find((x) => x.target === b.target);
    const id_ = this.#approve(ctx, { verb: 'bind', ref: id, binding: cardBinding(b) }, {
      verb: 'bind', what: `${before ? 'Change' : 'Allow'} “${m.name}” ${before ? 'on' : 'to be used on'} ${b.target}`, name: m.name, origin: m.origin, username: m.username, target: b.target, scope: b.scope, class: m.class, flags, tier: 3,
      approving: `${b.consent ? `Standing consent: requests inside ${b.consent.scope.methods.join(', ')} ${b.consent.scope.paths.join(', ')} go ahead without asking, up to ${b.consent.rate_per_hour} an hour. ` : 'Every use asks first. '}Nothing else is covered: no other host, subdomain or port.`,
    }, true);
    if (b.consent) b.consent.approval_id = id_;
    this.store.setMeta(id, stripIndex({ ...m, bindings: [...m.bindings.filter((x) => x.target !== b.target), b] }));
    this.#reindex();
    return { ref: id, bindings: this.#index.get(id)!.bindings };
  }

  // ---- share_scope (tier 3) -------------------------------------------------------------------

  #share(f: Frame, ctx: Ctx): Answer {
    if (f.backend !== undefined) throw new Refused('wrong_target_kind', 'External password managers come in Phase 2; Nova Vault is the only backend now.');
    const d = (f.device ?? {}) as { id?: unknown; public_key?: unknown; name?: unknown; remove?: unknown };
    if (!str(d.id, 40)) throw new Failed('A holder is a device id.');
    ctx.rec.target = `device:${d.id}`;
    if (d.remove === true) {
      if (d.id === this.store.device().id) throw new Failed('This device can’t stop holding its own vault.');
      this.store.removeHolder(d.id);
      return { holders: Object.keys(this.store.header!.holders), text: 'That device no longer holds the vault; the vault was re-keyed.' };
    }
    if (!str(d.public_key, 60) || !str(d.name, 80)) throw new Failed('A holder brings its broker’s public key and a name.');
    const text = `The broker on “${d.name}” will be able to open every item in this vault (${this.#index.size} now, and every one added later). Nova core and its models are given no values.`;
    this.#approve(ctx, { verb: 'share_scope', device: d.id, public_key: d.public_key, name: d.name }, { verb: 'share_scope', what: `Let “${d.name}” hold Nova Vault`, target: `device:${d.id}`, tier: 3, approving: text }, true);
    this.store.enrollHolder(d.id, d.public_key, d.name);
    return { holders: Object.keys(this.store.header!.holders), text, outbox: true };
  }

  // ---- migration from vault.ts (§10, "Moving from today's vault") ------------------------------

  // Three steps, so core never opens the old vault while it holds credentials:
  //  - stage: a ticket for the launcher, which reads the old vault itself and streams it here;
  //  - commit: each staged entry becomes an item, unbound (usable nowhere, so no capability is
  //    granted), with its old name as an alias; every item is read back; a finish ticket lets the
  //    launcher take what moved out of the old vault. Idempotent by name: an item already moved
  //    with the same value counts as moved, one that differs stays in the old vault and is said.
  //  - propose: one tier-3 card listing every moved item with its proposed binding and class,
  //    metadata only; approving it binds them. Items left out stay unbound.
  #migrate(src: { migrate: unknown; proposals?: unknown }, ctx: Ctx): Answer {
    if (src.migrate === 'stage') {
      const ticket = `mg_${randomBytes(24).toString('base64url')}`;
      this.#tickets.set(ticket, { kind: 'migrate', expires: this.#now().getTime() + 10 * 60_000, redeemed: false, staged: new Map(), done: false });
      return { outcome: { ticket, expires_at: new Date(this.#now().getTime() + 10 * 60_000).toISOString() } };
    }
    if (src.migrate === 'propose') return this.#propose(src.proposals, ctx);
    if (src.migrate !== 'commit') throw new Failed('A migration stages, commits, then proposes bindings.');
    const tk = [...this.#tickets.entries()].find(([, t]) => t.kind === 'migrate' && t.done);
    if (!tk) throw new Failed('Nothing is staged: run the migrate launcher first.');
    const [tname, t] = tk;
    this.#tickets.delete(tname);
    const migrated: string[] = [];
    const skipped: string[] = [];
    const moved: string[] = [];
    for (const [name, g] of groupStaged(t.staged!)) {
      const alias = `${ALIAS}${name}`;
      let id = [...this.#index.entries()].find(([, x]) => x.aliases.includes(alias))?.[0] ?? null;
      if (!id) {
        const meta: Meta = { name, aliases: [alias], kind: g.kind, origin: g.origin, username: g.username, class: suggestClass(g.origin, g.kind), per_use: false, created_at: this.#now().toISOString(), last_used: null, last_rotated: null, bindings: [], policy: DEFAULT_POLICY };
        id = this.store.add(meta, g.value).id;
        if (g.pending) this.store.setPending(id, g.pending);
        migrated.push(name);
      }
      // Read-back, from disk: only what opens with the staged value counts as moved.
      const v = this.store.value(id);
      if (sameBytes(v, g.value)) moved.push(...g.names); else skipped.push(name);
      zero(v);
    }
    for (const b of t.staged!.values()) zero(b);
    this.#reindex();
    ctx.rec.scope_item = `moved ${moved.length}`;
    const finish = `mf_${randomBytes(24).toString('base64url')}`;
    this.#tickets.set(finish, { kind: 'finish', expires: this.#now().getTime() + 10 * 60_000, redeemed: false, migrated: moved });
    return { outcome: { migrated, skipped, read_back: skipped.length === 0, ticket: finish } };
  }

  #propose(p: unknown, ctx: Ctx): Answer {
    const proposals = (p && typeof p === 'object' ? p : {}) as Record<string, { origin?: unknown; class?: unknown; bind?: unknown }>;
    const plan = Object.entries(proposals).slice(0, 200).map(([name, x]) => {
      const id = [...this.#index.entries()].find(([, m]) => m.aliases.includes(`${ALIAS}${name}`))?.[0];
      if (!id) throw new Refused('unknown_ref', `“${name}” isn’t a moved item.`);
      const m = this.#index.get(id)!;
      let origin = m.origin;
      if (x.origin !== undefined && x.origin !== null) { try { origin = canonicalTarget({ kind: 'http', origin: x.origin }).target; } catch { throw new Failed(`${name}: the site isn’t a canonical https origin.`); } }
      const cls = x.class === 'standard' || x.class === 'sensitive' ? x.class : suggestClass(origin, m.kind);
      const bindings = Array.isArray(x.bind) ? x.bind.slice(0, 5).map((b) => this.#binding(b)) : [];
      if (cls === 'sensitive' && bindings.some((b) => b.consent)) throw new Refused('class_policy', `${name}: ${CONSENT_SENSITIVE}`);
      return { id, m, origin, cls, bindings };
    });
    const items = plan.map((x) => ({ name: x.m.name, kind: x.m.kind, origin: x.origin, username: x.m.username, class: x.cls, target: x.bindings.map((b) => b.target).join(', ') || 'unbound', flags: x.bindings.flatMap((b) => this.#flags(b.target, b.kind)) }));
    const approval = this.#approve(ctx, { verb: 'create', source: 'migrate', items: plan.map((x) => ({ ref: x.id, origin: x.origin, class: x.cls, bindings: x.bindings.map(cardBinding) })) }, { verb: 'create', what: `Bind ${plan.length} credential(s) moved from the old vault`, tier: 3, items, approving: 'Each is usable only on the target shown. Items left unbound can’t be used until you bind them.' }, true);
    for (const x of plan) {
      for (const b of x.bindings) if (b.consent) b.consent.approval_id = approval;
      this.store.setMeta(x.id, stripIndex({ ...x.m, origin: x.origin, class: x.cls, bindings: [...x.m.bindings.filter((b) => !x.bindings.some((n) => n.target === b.target)), ...x.bindings] }));
    }
    this.#reindex();
    return { refs: plan.map((x) => this.#refMeta(x.id)) };
  }

  // ---- the launcher's messages (broker code on the other end; §3) ------------------------------

  // Redeeming a ticket. A run ticket gives the launcher the value to start the program with, after
  // the program's own SHA-256 (hashed by the launcher) matches the binding. A ticket redeemed twice
  // is refused, and the refusal is an alarm in the audit log.
  launcher(f: Frame): Answer {
    // A redeemed ticket is kept until it expires, so a second redemption is seen as an alarm.
    for (const [k, x] of this.#tickets) if (x.expires < this.#now().getTime() - TICKET_MS) this.#tickets.delete(k);
    const name = typeof f.ticket === 'string' ? f.ticket : '';
    const t = this.#tickets.get(name);
    const rec: Entry = { verb: f.m, ref: t?.id ?? null, target: t?.target ?? null, scope_item: null, outcome: 'ok', tier: null, approval_id: null, task: null, role: 'launcher' };
    const refuse = (code: Refusal, words: string) => { rec.outcome = `refused:${code}`; return { refused: code, words, record: this.audit.write(rec) }; };
    if (!t || t.expires < this.#now().getTime()) return refuse('approval_invalid', 'That ticket isn’t valid (expired, or never issued).');
    if (f.m === 'migrate_item') {
      if (t.kind !== 'migrate' || t.done) return refuse('approval_invalid', 'Not a migration ticket.');
      if (f.done === true) { t.done = true; rec.outcome = `ok:staged ${t.staged!.size}`; this.audit.write(rec); return { ok: true, staged: t.staged!.size }; }
      if (!str(f.name, 200) || !NAME.test(f.name) || typeof f.value !== 'string' || f.value.length > 64 * 1024 || OWN_KEYS.some((r) => r.test(f.name as string))) return refuse('out_of_scope', 'Not an item the migration moves.');
      t.staged!.set(f.name, Buffer.from(f.value, 'utf8'));
      return { ok: true };
    }
    if (t.redeemed) { rec.outcome = 'refused:approval_invalid:alarm'; this.problem = 'A credential ticket was redeemed twice: something may have copied it.'; this.audit.write(rec); return { refused: 'approval_invalid', words: 'That ticket was already used. This is recorded as an alarm.' }; }
    t.redeemed = true;
    if (t.kind === 'finish') { this.audit.write(rec); return { ok: true, migrated: t.migrated }; }
    if (t.kind !== 'run' || f.path !== t.path || f.sha256 !== t.sha256) { rec.outcome = 'refused:not_bound'; this.audit.write(rec); return { refused: 'not_bound', words: 'The program isn’t the one this credential is bound to (its SHA-256 differs).' }; }
    if (!this.store.unlocked) return refuse('locked', REFUSALS.locked);
    const value = this.store.value(t.id!, t.version);
    this.audit.write(rec);
    try { return { ok: true, grant: { path: t.path, argv: t.argv, inject: t.inject, value: value.toString('utf8') } }; } finally { zero(value); }
  }
}

interface Ctx { rec: Entry; task: { id: string; title: string } | null; caller: string | null; approval: ApprovalIn | undefined }

// An unlock factor is sealed to the vault, the factor and this boot (seal.ts, unlockDigest).
const unlockDigest = (vid: string, factor: string, boot: string) => createHash('sha256').update(`nova-broker-unlock|${vid}|${factor}|${boot}`).digest('hex');

const stripIndex = (m: Meta & { version?: number; pending?: boolean }): Meta => { const { version: _v, pending: _p, ...rest } = m; return rest; };
const cardBinding = (b: Binding) => ({ target: b.target, kind: b.kind, scope: b.scope, inject: b.inject.how, consent: b.consent ? { scope: b.consent.scope, rate_per_hour: b.consent.rate_per_hour } : null, lan: !!b.lan, pin: b.pin ?? null, embed_on: b.embed_on ?? [] });

const REFUSED_HEADERS = /^(authorization|proxy-authorization|cookie|host|content-length|transfer-encoding|connection|upgrade|te|trailer|expect|keep-alive|proxy-connection)$/i;
function callerHeaders(h: unknown, inj: Inject): Record<string, string> {
  const out: Record<string, string> = {};
  if (h === undefined || h === null) return out;
  if (typeof h !== 'object' || Array.isArray(h) || Object.keys(h).length > 32) throw new Refused('out_of_scope', 'Request headers are a small map of names to text.');
  for (const [k, v] of Object.entries(h)) {
    if (!/^[A-Za-z0-9-]{1,60}$/.test(k) || typeof v !== 'string' || v.length > 4096 || /[\r\n]/.test(v) || REFUSED_HEADERS.test(k) || (inj.header && k.toLowerCase() === inj.header.toLowerCase())) throw new Refused('out_of_scope', `The header “${k}” isn’t one a caller sets.`);
    out[k.toLowerCase()] = v;
  }
  return out;
}

const hmac = (key: Buffer, body: Buffer, inj: Inject) => `${inj.prefix ?? ''}${createHmac('sha256', key).update(body).digest(inj.format === 'base64' ? 'base64' : 'hex')}`;

function inject(headers: Record<string, string>, inj: Inject, value: Buffer, username: string | null, body: Buffer | null) {
  const v = value.toString('utf8');
  if (/[\r\n]/.test(v) && inj.how !== 'sign') throw new Failed('That value can’t go in a header.');
  if (inj.how === 'bearer') headers.authorization = `Bearer ${v}`;
  else if (inj.how === 'basic') headers.authorization = `Basic ${Buffer.from(`${username ?? ''}:${v}`).toString('base64')}`;
  else if (inj.how === 'header') headers[inj.header!.toLowerCase()] = `${inj.prefix ?? ''}${v}`;
  else if (inj.how === 'sign') headers[inj.header!.toLowerCase()] = hmac(value, body ?? Buffer.alloc(0), inj);
}

// The old vault's names, grouped into items: a sign-in's username, password and pending parts are
// one login item, its username in the metadata (§10: "A web login is one item").
function groupStaged(staged: Map<string, Buffer>) {
  const out = new Map<string, { names: string[]; kind: string; origin: string | null; username: string | null; value: Buffer; pending: Buffer | null }>();
  const logins = new Map<string, { user?: Buffer; pass?: Buffer; pending?: Buffer }>();
  for (const [name, v] of staged) {
    const lm = /^browser\/login\/([^/]+)\/(username|password|pending)$/.exec(name);
    if (lm) { const e = logins.get(lm[1]!) ?? {}; e[lm[2] === 'username' ? 'user' : lm[2] === 'password' ? 'pass' : 'pending'] = v; logins.set(lm[1]!, e); continue; }
    const kind = /^provider\/|^capture\/|^decisions\./.test(name) ? 'api_key' : /^connector\/gmail\//.test(name) ? 'oauth' : /^connector\/|^network\/[^/]+\/token$/.test(name) ? 'token' : 'secret';
    out.set(name, { names: [name], kind, origin: null, username: null, value: v, pending: null });
  }
  for (const [enc, e] of logins) {
    if (!e.pass) continue;
    const host = enc.replace(/_(\d{1,5})$/, ':$1');
    let origin: string | null = null;
    try { origin = canonicalTarget({ kind: 'web', origin: `${/^(localhost|127\.)/.test(host) ? 'http' : 'https'}://${host}` }).target; } catch { origin = null; }
    const base = `browser/login/${enc}`;
    out.set(`${base}/password`, { names: [`${base}/username`, `${base}/password`, `${base}/pending`].filter((n) => staged.has(n)), kind: 'login', origin, username: e.user ? e.user.toString('utf8') : null, value: e.pass, pending: e.pending ?? null });
  }
  return out;
}

