// Nova Vault's store (docs/plans/vault-broker.md §10). In <home>/broker/, 0700; kept out of the
// home's git, the sync journal and checkpoints, and only items/ goes into a backup.
//
//   vault.json       the header: vault id, format, Argon2id parameters and salt, the generation of
//                    the root key, and the root key sealed to each factor's public key (wraps:
//                    passphrase, recovery, passkey:<id>, device:<id>). Holder devices and passkeys
//                    registered for approvals, by public key.
//   items/<id>.json  one per item: a random id, a version, the root key's generation, the item key
//                    sealed under the root key, the metadata sealed under the root key, and the value
//                    sealed under the item key. Associated data names the vault, the item, the
//                    version and the kind, so an item can't be moved, swapped or rolled back
//                    between files without failing.
//   device.json      this device's broker key (public half and id). The private half is in the OS
//                    key store, or device.key (0600) when none answers. Never synced.
//   outbox/          what holder devices receive: the header with device wraps and factor public
//                    keys only (no factor wrap travels), beside items/ (ciphertext).
//
// Deleting an item destroys its blob and rotates the root key, re-wrapping every other item key,
// so an older copy of items/ (a backup, a stale sync entry) opens with no key that still exists.
// A rotation cut short is finished at the next unlock (the header holds both generations).
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { argon2id, b64, calibrate, factorFromSeed, hkdf, newFactor, open, openWrap, seal, sealTo, signText, signerFromSeed, verifyText, type Factor, type Kdf, type Sealed, type Wrap } from './crypto.ts';
import { canonical } from './protocol.ts';
import type { KeyObject } from 'node:crypto';
import type { KeyStore } from './keystore.ts';
import type { Binding } from './protocol.ts';

export interface Meta {
  name: string; aliases: string[]; kind: string; origin: string | null; username: string | null;
  class: 'standard' | 'sensitive'; per_use: boolean; created_at: string; last_used: string | null; last_rotated: string | null;
  bindings: Binding[]; policy: { length: number; alphabet: string };
  // Where the value came from, for health flags that must answer no guess of core's (§8): generated
  // here, migrated by the broker's own launcher, sealed with a passkey approval, or sealed through
  // core's relay (a value core could have chosen). Older items have none: treated as `sealed`.
  provenance?: 'generated' | 'migrated' | 'sealed-passkey' | 'sealed'; migrated_from?: string;
  migrated_revision?: string;
}
interface ItemFile { v: 1; id: string; gen: number; version: number; key: Sealed; meta: Sealed; value: Sealed; pending?: { version: number; key: Sealed; value: Sealed } }
export interface Passkey { public_key: string; rp_id: string; origins: string[]; sign_count: number; registered_at: string }
export interface Holder { name: string; public: string; enrolled_at: string }
export interface Header {
  v: 1; id: string; created_at: string; kdf: Kdf; unlock_mode: 'auto' | 'ask'; gen: number;
  wraps: Record<string, Wrap>; next?: { gen: number; wraps: Record<string, Wrap> };
  holders: Record<string, Holder>; passkeys: Record<string, Passkey>;
  // On a holder: the signing key of the hub it adopted from, pinned at the first adoption.
  hub_signer?: string;
  // Made on this device (`local`) or adopted from a hub. A local vault never adopts another.
  origin?: 'local' | 'adopted';
}
// What travels to holders: device wraps, and every factor's public key (so a holder's broker can
// seal the root key to the same factors itself). No passphrase, recovery or passkey wrap moves.
export interface OutboxHeader { v: 1; id: string; kdf: Kdf; unlock_mode: 'auto' | 'ask'; gen: number; device_wraps: Record<string, Wrap>; factor_pubs: Record<string, string>; holders: Record<string, Holder>; passkeys: Record<string, Passkey>; from: string; signer: string; sig?: string }

const ID = /^[a-z0-9]{20,40}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const wrapInfo = (vid: string, name: string, gen: number) => `nova-broker-wrap|${vid}|${name}|${gen}`;
const keyAad = (vid: string, id: string, version: number) => `item-key|${vid}|${id}|${version}`;
const metaAad = (vid: string, id: string) => `item-meta|${vid}|${id}`;
const valueAad = (vid: string, id: string, version: number, kind: string) => `item-value|${vid}|${id}|${version}|${kind}`;
export const newItemId = () => randomBytes(15).toString('hex').replace(/^/, 'i');

function writeAtomic(path: string, text: string) {
  writeFileSync(`${path}.tmp`, text, { mode: 0o600 });
  renameSync(`${path}.tmp`, path);
  chmodSync(path, 0o600);
}
const zero = (b: Buffer | null | undefined) => { if (b) b.fill(0); };

// The factors a person brings, as seeds for X25519: Argon2id for the passphrase, HKDF for the rest.
export const passphraseFactor = (pass: Buffer, kdf: Kdf) => factorFromSeed(argon2id(pass, kdf));
export const recoveryFactor = (key: Buffer) => factorFromSeed(hkdf(key, 'nova-broker-recovery', 'factor'));
export const passkeyFactor = (prf: Buffer, id: string) => factorFromSeed(hkdf(prf, `nova-broker-passkey|${id}`, 'factor'));

// deviceStore is asked for two accounts: device-<id> (the unlock key) and sign-<id> (the signing key).
export interface StoreOptions { dir: string; deviceStore: (account: string) => KeyStore; kdf?: Kdf; now?: () => Date }

export class Store {
  readonly dir: string;
  #o: StoreOptions;
  #h: Header | null = null;
  #root: Buffer | null = null;
  #device: { id: string; factor: Factor; store: KeyStore } | null = null;
  #signer: { priv: KeyObject; pub: string } | null = null;
  // last_used is kept here and written with the item's next change, or at lock.
  #used = new Map<string, string>();

  constructor(o: StoreOptions) {
    this.#o = o;
    this.dir = o.dir;
    mkdirSync(join(o.dir, 'items'), { recursive: true, mode: 0o700 });
    chmodSync(o.dir, 0o700);
    this.#h = existsSync(this.#hp) ? this.#readHeader() : null;
  }

  get #hp() { return join(this.dir, 'vault.json'); }
  #now() { return (this.#o.now?.() ?? new Date()).toISOString(); }
  get exists() { return !!this.#h; }
  get unlocked() { return !!this.#root; }
  get header(): Header | null { return this.#h; }

  #readHeader(): Header {
    const h = JSON.parse(readFileSync(this.#hp, 'utf8')) as Header;
    if (h?.v !== 1 || !UUID.test(h.id) || !h.wraps || !h.kdf) throw new Error('The vault’s header isn’t one the broker knows.');
    return h;
  }
  #writeHeader() { writeAtomic(this.#hp, `${JSON.stringify(this.#h)}\n`); }

  // ---- this device's broker key ---------------------------------------------------------------

  device(): { id: string; public: string; store: string } {
    if (!this.#device) {
      const p = join(this.dir, 'device.json');
      let d: { id: string; public: string } | null = null;
      try { d = JSON.parse(readFileSync(p, 'utf8')); } catch { /* none yet */ }
      if (d && UUID.test(d.id)) {
        const store = this.#o.deviceStore(`device-${d.id}`);
        const seed = store.read();
        if (!seed) throw new Error(`This device’s broker key isn’t in ${store.name} any more, so the vault can’t open with it. Unlock with your passphrase or recovery key; a new device key is made then.`);
        const factor = factorFromSeed(seed);
        zero(seed);
        if (factor.pub !== d.public) throw new Error('This device’s broker key doesn’t match its record.');
        this.#device = { id: d.id, factor, store };
      } else {
        const id = randomUUID();
        const store = this.#o.deviceStore(`device-${id}`);
        const { seed, factor } = newFactor();
        store.write(seed);
        zero(seed);
        writeAtomic(p, `${JSON.stringify({ id, public: factor.pub })}\n`);
        this.#device = { id, factor, store };
      }
    }
    return { id: this.#device.id, public: this.#device.factor.pub, store: this.#device.store.kind };
  }

  // A new key pair for this device (after a delete, or when its key is gone), re-sealed for itself.
  #renewDevice() {
    const old = this.#device;
    const id = old?.id ?? randomUUID();
    const store = old?.store ?? this.#o.deviceStore(`device-${id}`);
    const { seed, factor } = newFactor();
    store.write(seed);
    zero(seed);
    writeAtomic(join(this.dir, 'device.json'), `${JSON.stringify({ id, public: factor.pub })}\n`);
    this.#device = { id, factor, store };
    return this.#device;
  }

  // This device's signing key (stable across renewals of its unlock key), made on first use.
  #sign(): { priv: KeyObject; pub: string } {
    if (!this.#signer) {
      const id = this.device().id;
      const store = this.#o.deviceStore(`sign-${id}`);
      let seed = store.read();
      if (!seed) { seed = randomBytes(32); store.write(seed); }
      this.#signer = signerFromSeed(seed);
      zero(seed);
    }
    return this.#signer;
  }

  // ---- create, unlock, lock -------------------------------------------------------------------

  create(o: { id?: string; passphrase: Buffer; recovery?: Buffer | null; passkeys?: { id: string; prf?: Buffer | null; public_key: string; rp_id: string; origins: string[] }[]; unlock_mode?: 'auto' | 'ask' }): void {
    if (this.#h) throw new Error('There is a vault here already.');
    if (o.passphrase.length < 8) throw new Error('A passphrase is at least 8 characters.');
    const kdf = this.#o.kdf ?? calibrate();
    const id = o.id && UUID.test(o.id) ? o.id : randomUUID();
    const root = randomBytes(32);
    let dev: { id: string; public: string };
    try { dev = this.device(); } catch { const d = this.#renewDevice(); dev = { id: d.id, public: d.factor.pub }; }
    const h: Header = { v: 1, id, created_at: this.#now(), kdf, unlock_mode: o.unlock_mode ?? 'auto', gen: 1, wraps: {}, holders: {}, passkeys: {}, origin: 'local' };
    const add = (name: string, f: Factor) => { h.wraps[name] = sealTo(f.pub, root, wrapInfo(id, name, 1)); };
    add('passphrase', passphraseFactor(o.passphrase, kdf));
    if (o.recovery) add('recovery', recoveryFactor(o.recovery));
    for (const pk of o.passkeys ?? []) {
      h.passkeys[pk.id] = { public_key: pk.public_key, rp_id: pk.rp_id, origins: pk.origins, sign_count: 0, registered_at: this.#now() };
      if (pk.prf) add(`passkey:${pk.id}`, passkeyFactor(pk.prf, pk.id));
    }
    h.holders[dev.id] = { name: 'this device', public: dev.public, enrolled_at: this.#now() };
    if (h.unlock_mode === 'auto') add(`device:${dev.id}`, this.#device!.factor);
    this.#h = h;
    this.#writeHeader();
    this.#root = root;
  }

  // Opens the root key with one factor. A rotation cut short is finished here.
  unlock(f: { kind: 'passphrase'; secret: Buffer } | { kind: 'recovery'; secret: Buffer } | { kind: 'passkey'; id: string; secret: Buffer } | { kind: 'device' }): void {
    const h = this.#h;
    if (!h) throw new Error('There is no vault yet.');
    let name: string;
    let factor: Factor;
    if (f.kind === 'device') {
      const dev = this.device();
      name = `device:${dev.id}`;
      factor = this.#device!.factor;
    } else if (f.kind === 'passphrase') { name = 'passphrase'; factor = passphraseFactor(f.secret, h.kdf); }
    else if (f.kind === 'recovery') { name = 'recovery'; factor = recoveryFactor(f.secret); }
    else { name = `passkey:${f.id}`; factor = passkeyFactor(f.secret, f.id); }
    const w = h.wraps[name];
    if (!w) throw new Error(f.kind === 'device' ? 'This device can’t open the vault by itself (it is set to ask after a restart, or isn’t a holder).' : 'That factor isn’t one this vault knows.');
    let root: Buffer;
    try { root = openWrap(factor, w, wrapInfo(h.id, name, h.gen)); } catch { throw new Error('That doesn’t open the vault.'); }
    this.#root = root;
    if (h.next) {
      const nw = h.next.wraps[name];
      const next = nw ? openWrap(factor, nw, wrapInfo(h.id, name, h.next.gen)) : null;
      if (next) this.#finishRotation(next);
    }
    // A device key that went missing (unlocked by passphrase or recovery): a new one for itself.
    if (f.kind !== 'device' && h.unlock_mode === 'auto') {
      try { this.device(); } catch { this.#renewDevice(); }
      const dn = `device:${this.#device!.id}`;
      if (!h.wraps[dn] || h.wraps[dn]!.pub !== this.#device!.factor.pub) {
        h.wraps[dn] = sealTo(this.#device!.factor.pub, this.#root, wrapInfo(h.id, dn, h.gen));
        h.holders[this.#device!.id] = { name: 'this device', public: this.#device!.factor.pub, enrolled_at: this.#now() };
        this.#writeHeader();
      }
    }
  }

  lock(): void {
    try { if (this.#root) this.#flushUsed(); } catch { /* best effort */ }
    zero(this.#root);
    this.#root = null;
  }

  #need(): Buffer {
    if (!this.#root) throw new Error('locked');
    return this.#root;
  }

  // ---- items ----------------------------------------------------------------------------------

  #itemPath(id: string) {
    if (!ID.test(id)) throw new Error('not an item id');
    return join(this.dir, 'items', `${id}.json`);
  }
  #readItem(id: string): ItemFile {
    const f = JSON.parse(readFileSync(this.#itemPath(id), 'utf8')) as ItemFile;
    // A file moved to another name is refused before anything is opened.
    if (f?.v !== 1 || f.id !== id) throw new Error(`item ${id} isn’t the file it claims to be`);
    return f;
  }
  ids(): string[] {
    return readdirSync(join(this.dir, 'items')).filter((n) => n.endsWith('.json')).map((n) => n.slice(0, -5)).filter((n) => ID.test(n)).sort();
  }

  // Every item's metadata. One that fails to open (tampered, swapped, damaged) is reported on its
  // own, and the others still open.
  metas(): { items: Map<string, Meta & { version: number; pending: boolean }>; broken: string[] } {
    const root = this.#need();
    const items = new Map<string, Meta & { version: number; pending: boolean }>();
    const broken: string[] = [];
    for (const id of this.ids()) {
      try {
        const f = this.#readItem(id);
        if (f.gen !== this.#h!.gen) throw new Error('stale generation');
        const m = JSON.parse(open(root, f.meta, metaAad(this.#h!.id, id)).toString('utf8')) as Meta;
        // The item key and the value must open too, or the item is broken (and reported alone).
        for (const part of [{ version: f.version, key: f.key, value: f.value }, ...(f.pending ? [f.pending] : [])]) {
          const ik = open(root, part.key, keyAad(this.#h!.id, id, part.version));
          try { zero(open(ik, part.value, valueAad(this.#h!.id, id, part.version, m.kind))); } finally { zero(ik); }
        }
        const used = this.#used.get(id);
        items.set(id, { ...m, last_used: used ?? m.last_used, version: f.version, pending: !!f.pending });
      } catch { broken.push(id); }
    }
    return { items, broken };
  }

  meta(id: string): Meta & { version: number; pending: boolean } {
    const root = this.#need();
    const f = this.#readItem(id);
    const m = JSON.parse(open(root, f.meta, metaAad(this.#h!.id, id)).toString('utf8')) as Meta;
    return { ...m, last_used: this.#used.get(id) ?? m.last_used, version: f.version, pending: !!f.pending };
  }

  // The value, inside the broker only. The caller zeroes the buffer when done.
  value(id: string, which: 'current' | 'pending' = 'current'): Buffer {
    const root = this.#need();
    const f = this.#readItem(id);
    if (f.gen !== this.#h!.gen) throw new Error('stale generation');
    const m = JSON.parse(open(root, f.meta, metaAad(this.#h!.id, id)).toString('utf8')) as Meta;
    const part = which === 'pending' ? f.pending : { version: f.version, key: f.key, value: f.value };
    if (!part) throw new Error('no pending version');
    const ik = open(root, part.key, keyAad(this.#h!.id, id, part.version));
    try { return open(ik, part.value, valueAad(this.#h!.id, id, part.version, m.kind)); } finally { zero(ik); }
  }

  #write(f: ItemFile) { writeAtomic(this.#itemPath(f.id), `${JSON.stringify(f)}\n`); }
  #sealMeta(id: string, m: Meta): Sealed {
    const { version: _v, pending: _p, ...plain } = m as Meta & { version?: number; pending?: boolean };
    return seal(this.#need(), Buffer.from(JSON.stringify(plain), 'utf8'), metaAad(this.#h!.id, id));
  }
  #sealValue(id: string, version: number, kind: string, value: Buffer): { key: Sealed; value: Sealed } {
    const ik = randomBytes(32);
    try {
      return { key: seal(this.#need(), ik, keyAad(this.#h!.id, id, version)), value: seal(ik, value, valueAad(this.#h!.id, id, version, kind)) };
    } finally { zero(ik); }
  }

  add(meta: Meta, value: Buffer): { id: string; version: number } {
    this.#need();
    const id = newItemId();
    this.#write({ v: 1, id, gen: this.#h!.gen, version: 1, meta: this.#sealMeta(id, meta), ...this.#sealValue(id, 1, meta.kind, value) });
    return { id, version: 1 };
  }

  setMeta(id: string, meta: Meta): void {
    const f = this.#readItem(id);
    const cur = this.meta(id);
    if (cur.kind !== meta.kind) throw new Error('an item’s kind doesn’t change');
    this.#used.delete(id);
    this.#write({ ...f, meta: this.#sealMeta(id, meta) });
  }

  setValue(id: string, value: Buffer): number {
    const f = this.#readItem(id);
    const m = this.meta(id);
    const version = Math.max(f.version, f.pending?.version ?? 0) + 1;
    this.#used.delete(id);
    const { pending: _drop, ...rest } = f;
    this.#write({ ...rest, version, meta: this.#sealMeta(id, { ...m, last_rotated: this.#now() }), ...this.#sealValue(id, version, m.kind, value) });
    return version;
  }

  setPending(id: string, value: Buffer): number {
    const f = this.#readItem(id);
    const m = this.meta(id);
    const version = f.version + 1;
    this.#write({ ...f, pending: { version, ...this.#sealValue(id, version, m.kind, value) } });
    return version;
  }

  commitPending(id: string): number {
    const f = this.#readItem(id);
    if (!f.pending) throw new Error('no pending version');
    const m = this.meta(id);
    const { pending, ...rest } = f;
    this.#write({ ...rest, version: pending.version, key: pending.key, value: pending.value, meta: this.#sealMeta(id, { ...m, last_rotated: this.#now() }) });
    return pending.version;
  }

  dropPending(id: string): void {
    const f = this.#readItem(id);
    const { pending: _p, ...rest } = f;
    this.#write(rest);
  }

  touch(id: string): void { this.#used.set(id, this.#now()); }
  #flushUsed() {
    for (const [id, at] of this.#used) {
      try { const m = this.meta(id); this.#write({ ...this.#readItem(id), meta: this.#sealMeta(id, { ...m, last_used: at }) }); } catch { /* gone */ }
    }
    this.#used.clear();
  }

  // Deleting: the blob goes, then the root key is rotated (and this device's own key renewed), so
  // nothing that still exists opens an older copy of the item.
  remove(id: string): void {
    this.#need();
    rmSync(this.#itemPath(id), { force: true });
    this.#used.delete(id);
    this.rotateRoot();
    this.#renewSelf();
  }

  // After the rotation, so a crash between the two costs one passphrase unlock, never an item: a
  // device key that no longer matches is replaced at the next unlock with another factor.
  #renewSelf(): void {
    const h = this.#h!;
    if (h.unlock_mode !== 'auto' || !this.#device || !h.wraps[`device:${this.#device.id}`]) return;
    const dev = this.#renewDevice();
    h.wraps[`device:${dev.id}`] = sealTo(dev.factor.pub, this.#need(), wrapInfo(h.id, `device:${dev.id}`, h.gen));
    h.holders[dev.id] = { ...(h.holders[dev.id] ?? { name: 'this device', enrolled_at: this.#now() }), public: dev.factor.pub };
    this.#writeHeader();
    this.writeOutbox();
  }

  rotateRoot(): void {
    const h = this.#h!;
    const next = randomBytes(32);
    const gen = h.gen + 1;
    h.next = { gen, wraps: Object.fromEntries(Object.entries(h.wraps).map(([n, w]) => [n, sealTo(w.pub, next, wrapInfo(h.id, n, gen))])) };
    this.#writeHeader();
    this.#finishRotation(next);
    this.writeOutbox();
  }

  #finishRotation(next: Buffer): void {
    const h = this.#h!;
    const root = this.#need();
    const gen = h.next!.gen;
    for (const id of this.ids()) {
      let f: ItemFile;
      try { f = this.#readItem(id); } catch { continue; }
      if (f.gen === gen) continue;
      try {
        const rewrap = (s: Sealed, version: number) => { const ik = open(root, s, keyAad(h.id, id, version)); try { return seal(next, ik, keyAad(h.id, id, version)); } finally { zero(ik); } };
        const meta = seal(next, open(root, f.meta, metaAad(h.id, id)), metaAad(h.id, id));
        this.#write({ ...f, gen, meta, key: rewrap(f.key, f.version), ...(f.pending ? { pending: { ...f.pending, key: rewrap(f.pending.key, f.pending.version) } } : {}) });
      } catch { /* a broken item stays broken; it is reported by metas() */ }
    }
    h.gen = gen;
    h.wraps = h.next!.wraps;
    delete h.next;
    this.#writeHeader();
    zero(root);
    this.#root = next;
  }

  // ---- holders and sync (§10 "Sync between devices") ------------------------------------------

  enrollHolder(id: string, pub: string, name: string): void {
    if (!UUID.test(id)) throw new Error('not a device id');
    const h = this.#h!;
    h.holders[id] = { name, public: pub, enrolled_at: this.#now() };
    h.wraps[`device:${id}`] = sealTo(pub, this.#need(), wrapInfo(h.id, `device:${id}`, h.gen));
    this.#writeHeader();
    this.writeOutbox();
  }

  // Removing a holder: its wrap goes and the root key rotates, so blobs written from now on don't
  // open with what it held.
  removeHolder(id: string): void {
    const h = this.#h!;
    delete h.holders[id];
    delete h.wraps[`device:${id}`];
    this.rotateRoot();
    this.writeOutbox();
  }

  writeOutbox(): OutboxHeader | null {
    const h = this.#h;
    if (!h || Object.keys(h.holders).length < 2) return null;
    const out: OutboxHeader = {
      v: 1, id: h.id, kdf: h.kdf, unlock_mode: h.unlock_mode, gen: h.gen,
      device_wraps: Object.fromEntries(Object.entries(h.wraps).filter(([n]) => n.startsWith('device:'))),
      factor_pubs: Object.fromEntries(Object.entries(h.wraps).filter(([n]) => !n.startsWith('device:')).map(([n, w]) => [n, w.pub])),
      holders: h.holders, passkeys: h.passkeys, from: this.device().id, signer: this.#sign().pub,
    };
    out.sig = signText(this.#sign().priv, canonical(out));
    mkdirSync(join(this.dir, 'outbox'), { recursive: true, mode: 0o700 });
    writeAtomic(join(this.dir, 'outbox', 'header.json'), `${JSON.stringify(out)}\n`);
    return out;
  }

  // On a holder: the hub's header and item blobs, opened with this device's own wrap. The holder's
  // broker seals the root key to the same factors itself; nothing but ciphertext arrived.
  adopt(inbox: OutboxHeader, items: Record<string, string>): void {
    const dev = this.device();
    const name = `device:${dev.id}`;
    // A vault made here never adopts another. A holder adopts only a header signed by the hub it
    // was enrolled for (pinned at tier 3, pinHub), only for the vault it holds, and only newer.
    if (this.#h && this.#h.origin !== 'adopted') throw new Error('This device’s vault was made here; it doesn’t take another.');
    const { sig, ...body } = inbox;
    if (typeof inbox.signer !== 'string' || !verifyText(inbox.signer, canonical(body), sig)) throw new Error('The vault that arrived isn’t signed by a hub’s broker, so it isn’t adopted.');
    const pinned = this.#h?.hub_signer ?? this.hubPin();
    if (!pinned) throw new Error('This device isn’t enrolled to hold a hub’s vault (tier 3), so nothing is adopted.');
    if (pinned !== inbox.signer || (this.#h && this.#h.id !== inbox.id)) throw new Error('The vault that arrived isn’t from the hub this device holds a vault for, so it isn’t adopted.');
    if (this.#h && inbox.gen <= this.#h.gen) throw new Error('The vault that arrived isn’t newer than the one held here.');
    const w = inbox.device_wraps?.[name];
    if (!w || !UUID.test(inbox.id)) throw new Error('The hub’s vault has no wrap for this device. Enrol it as a holder on the hub first (tier 3).');
    const root = openWrap(this.#device!.factor, w, wrapInfo(inbox.id, name, inbox.gen));
    // Every blob must open under that root before anything is replaced.
    const files: ItemFile[] = [];
    for (const [id, text] of Object.entries(items)) {
      const f = JSON.parse(text) as ItemFile;
      if (f.id !== id || !ID.test(id) || f.gen !== inbox.gen) throw new Error(`item ${id} from the hub doesn’t match its header`);
      open(root, f.meta, metaAad(inbox.id, id));
      zero(open(root, f.key, keyAad(inbox.id, id, f.version)));
      files.push(f);
    }
    const wraps: Record<string, Wrap> = {};
    for (const [n, pub] of Object.entries(inbox.factor_pubs)) wraps[n] = sealTo(pub, root, wrapInfo(inbox.id, n, inbox.gen));
    if (inbox.unlock_mode === 'auto') wraps[name] = sealTo(this.#device!.factor.pub, root, wrapInfo(inbox.id, name, inbox.gen));
    for (const id of this.ids()) if (!items[id]) rmSync(this.#itemPath(id), { force: true });
    for (const f of files) this.#write(f);
    this.#h = { v: 1, id: inbox.id, created_at: this.#now(), kdf: inbox.kdf, unlock_mode: inbox.unlock_mode, gen: inbox.gen, wraps, holders: inbox.holders, passkeys: inbox.passkeys, hub_signer: inbox.signer, origin: 'adopted' };
    this.#writeHeader();
    zero(this.#root);
    this.#root = root;
  }

  // The hub this device will hold a vault for: its broker's signing key, pinned at enrolment.
  hubPin(): string | null {
    try { const p = JSON.parse(readFileSync(join(this.dir, 'hub.json'), 'utf8')) as { signer?: unknown }; return typeof p.signer === 'string' ? p.signer : null; } catch { return null; }
  }
  pinHub(signer: string, name: string): void {
    if (this.#h) throw new Error('This device already holds a vault.');
    writeAtomic(join(this.dir, 'hub.json'), `${JSON.stringify({ signer, name, pinned_at: this.#now() })}\n`);
  }

  // ---- passkeys (approvals) -------------------------------------------------------------------

  bumpSignCount(id: string, n: number): void {
    const pk = this.#h?.passkeys[id];
    if (!pk) return;
    pk.sign_count = n;
    this.#writeHeader();
  }

  // A factory reset: the broker forgets its keys and wraps (§10 "Deleting").
  forget(): void {
    this.lock();
    try { this.device(); } catch { /* no key to remove */ }
    this.#device?.store.remove();
    if (this.#device) this.#o.deviceStore(`sign-${this.#device.id}`).remove();
    rmSync(this.dir, { recursive: true, force: true });
    this.#h = null;
    this.#device = null;
  }
}

export const sameBytes = (a: Buffer, b: Buffer) => a.length === b.length && timingSafeEqual(a, b);
export { b64 };
