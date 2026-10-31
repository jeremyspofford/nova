// The Capture API (CONTEXT-AND-CAPTURE, M6 plan §1): one internal API whatever the source.
// Adapters (Screenpipe pulled over its REST API, a paired computer's device agent through the M4
// inbox) hand raw items to `ingest`, which keeps only what the person consented to and didn't
// exclude, classifies it by the signals they set, and stores it on the hub with provenance. Readers
// use `stream(device, kind)` and the views, and never learn which source an event came from.
//
// Consent: every source is off until the person turns it on, per source and per device; it can be
// paused; private and incognito contexts are dropped before anything is stored. Nothing captured
// before consent, or while paused, is taken in.
//
// Capture is evidence, not memory: promotion is deliberate (the person, or their OK on a proposal
// a triage decision made) and leaves provenance back to the events. Forgetting is real deletion,
// carried into backups, the write-ahead log and (by sync) the standby; retention sweeps old capture
// the same way. Words are kept only in capture_event (migration 0009).
import { EventEmitter } from 'node:events';
import { createHash, randomUUID } from 'node:crypto';
import { CoreError } from '../errors.ts';
import { permits } from '../workers.ts';
import { addressEgress } from '../connectors/index.ts';
import type { Db } from '../db.ts';
import type { Log } from '../log.ts';
import type { Profile } from '../profile.ts';
import type { PrivacyMode } from '../envelope.ts';
import type { Memory, MemoryRecord, Kind as MemoryKind } from '../memory.ts';
import type { Backups } from '../backups.ts';
import type { Decisions, TemplateDef, Templates } from '../decide.ts';
import {
  KINDS, SPACE, checkExclusions, checkSignals, checkSwitch, classify, describeExclusion, excludedBy, instant, isPrivate,
  type Exclusion, type Facts, type Kind, type Signal, type Switch,
} from './rules.ts';
import { DEFAULT_LOOKBACK_MS, DEFAULT_URL, KeyRefused, Screenpipe, Unreachable, type Cursor, type RawEvent } from './screenpipe.ts';

export { KINDS, type Kind } from './rules.ts';
export type { RawEvent } from './screenpipe.ts';

export const DEFAULT_RETENTION_DAYS = 14;
const MAX_TEXT = 20_000;
const MAX_FIELD = 300;
const MAX_URL = 2000;
const DAY_MS = 86_400_000;
const PROPOSE_PER_TICK = 10;

// What each platform can capture, said plainly (CONTEXT-AND-CAPTURE, per-platform posture).
export const POSTURE = [
  {
    platform: 'desktop', label: 'Computers (Windows, macOS, Linux)',
    can: 'Deep capture is possible: screen text, audio, meetings and app activity, each under a permission the operating system asks you for. Nova takes it in today from Screenpipe running on the computer, or from a paired computer’s device agent. Reading the active window directly needs a native component that isn’t built yet. Private and incognito windows are recognised by their window title, in the major browsers’ common languages: a best effort, so also list them in Screenpipe’s own ignored-windows setting, which stops Screenpipe recording them at all.',
  },
  {
    platform: 'android', label: 'Android',
    can: 'Broad capture is possible once you grant accessibility and notification access, permissions Nova would ask for plainly, one at a time. Nova has no Android capture yet.',
  },
  {
    platform: 'ios', label: 'iPhone and iPad',
    can: 'No passive capture of other apps: iOS doesn’t allow it. Only what the platform offers: recordings and screenshots you take, the Share Sheet, Shortcuts automations, notifications sent to Nova, and what the hub itself sees.',
  },
] as const;

// The triage decision that may propose a promotion; it never makes one (PROMOTE answers yes/no as
// one probability, Noul; an unsure answer escalates and nothing is proposed).
export const PROMOTE: TemplateDef = {
  template_id: 'capture-promote',
  version: 1,
  situation: 'Something was captured. Would the person likely want it kept as a lasting memory? This only proposes; the person decides.',
  inputs: { kind: 'string', app: 'string', space: 'string', text: 'string' },
  questions: [{ id: 'remember', type: 'noul' }],
  escalation: { confidence_floor: 0.7 },
};

// Event trigger topics a rule can listen for (connector "capture"): a kind, any event, the
// unclassified ones, or one space.
const TOPIC = new RegExp(`^(any|unclassified|${KINDS.join('|')}|space:[a-z0-9][a-z0-9_-]{0,63})$`);

export interface CaptureEvent {
  id: string;
  kind: Kind;
  at: string;
  ended_at: string | null;
  received_at: string;
  device: { id: string; name: string | null };
  app: string | null;
  window_title: string | null;
  url: string | null;
  text: string | null;
  space: string | null;
  space_by: string | null;
  consent: { state: 'granted'; at: string };
  provenance: { adapter: string; source_id: string; external_id: string | null; via: string; device_id: string; received_at: string };
  promoted: string[];
  proposal: { id: string; p: number | null; provider: string } | null;
}

export interface SourceView {
  id: string;
  name: string;
  adapter: 'screenpipe' | 'device';
  device: { id: string; name: string | null };
  kinds: Kind[];
  url: string | null;
  enabled: boolean;
  paused: boolean;
  active: boolean;
  consent: { at: string; by: string } | null;
  status: string;
  detail: string | null;
  checked_at: string | null;
  counts: Record<string, number>;
  egress: 'local' | 'remote' | null;
  // How far back each pull asks again, for items Screenpipe reports late (Screenpipe only).
  lookback_minutes: number | null;
  // Whether an API key is saved for it (Screenpipe only). The key itself is never shown back.
  has_api_key: boolean | null;
}

export interface Settings { retention_days: number; exclusions: Exclusion[]; signals: Signal[]; switch: Switch | null; spaces: string[] }

interface SourceRow { id: string; device_id: string; adapter: 'screenpipe' | 'device'; name: string; kinds: string; config: string; enabled: number; paused: number; consent_at: string | null; consent_by: string | null; cursor: string | null; status: string; status_detail: string | null; status_at: string | null; counts: string; created_at: string; updated_at: string }
interface EventRow { id: string; source_id: string; device_id: string; adapter: string; kind: Kind; at: string; ended_at: string | null; received_at: string; app: string | null; window_title: string | null; url: string | null; text: string | null; space: string | null; space_by: string | null; external_id: string | null; via: string; consent_at: string; triaged: number }

export type Ingested = { kept: string[]; dropped: Record<string, number>; why: Record<string, string> };

export interface CaptureOptions {
  db: Db;
  log: Log;
  profile: Profile;
  memory: Memory;
  backups: Backups;
  decisions: Decisions;
  templates: Templates;
  now: () => Date;
  // This node's device id, and a device's name, for views and attribution.
  self: () => string;
  deviceName: (id: string) => string | null;
  timezone: () => string;
  privacy: () => PrivacyMode;
  meshHosts: () => string[];
  // Whether a paired computer may capture (M10f: its capture-source role); the refusal in words, or
  // null. Absent: every device may (tests of capture alone).
  mayCapture?: (deviceId: string) => string | null;
  // An event trigger for a topic, only when a rule listens (triggers.connectorEvent).
  fire: (topic: string, payload: Record<string, unknown>, dedupKey: string) => Promise<unknown>;
  // The decision provider that should answer capture's proposals now (the local sorting model, once
  // one is assigned), or null. When it should but another answered (it was down), the event isn't
  // counted as looked at, so a later pass asks again once it is back.
  proposer?: () => string | null;
  // The ingest gate (Amendment 2026-10-30-C Part 3): captured text is outside content, screened
  // before the triage decision reads it. A block proposes nothing; otherwise the decision reads the
  // screened form.
  screen?: (r: { text: string; kind: Kind; origin: string }) => Promise<{ verdict: string; extract: string }>;
  // Where a Screenpipe's API key is kept: the vault, never the source's config.
  secrets?: { get(name: string): string | null; put(name: string, value: string): unknown; delete(name: string): unknown; has(name: string): boolean };
  fetch?: typeof fetch;
  pollMs?: number;
  // How far back a Screenpipe pull asks again by default, for items reported late (5 minutes).
  lookbackMs?: number;
  // Why retention must not delete anything now (the clock jumped, M7b), or null.
  retentionHold?: () => string | null;
}

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
// The vault name a source's API key is kept under.
const keyName = (sourceId: string) => `capture/${sourceId.replace(/[^A-Za-z0-9._-]/g, '-')}`;
const clip = (v: unknown, n: number): string | null => (typeof v === 'string' && v.trim() ? v.trim().slice(0, n) : null);
const parse = <T>(s: string | null, fallback: T): T => { if (!s) return fallback; try { return JSON.parse(s) as T; } catch { return fallback; } };

export class Capture extends EventEmitter {
  #o: CaptureOptions;
  #db: Db;
  #timer: ReturnType<typeof setInterval> | null = null;
  #pulling = new Map<string, Promise<unknown>>();
  #outage = new Map<string, number>();
  // Test clocks only (NOVA_TEST_CLOCK): the time capture takes as now, moved by tick({now}).
  #clock: Date | null = null;

  constructor(o: CaptureOptions) {
    super();
    this.setMaxListeners(100);
    this.#o = o;
    this.#db = o.db;
    o.templates.builtIn(PROMOTE);
  }

  #now(): Date {
    return this.#clock ?? this.#o.now();
  }

  // ---- settings (profile section "capture") -----------------------------------------------------

  settings(): Settings {
    const p = this.#o.profile.section('capture');
    const days = typeof p.retention_days === 'number' && p.retention_days >= 1 ? p.retention_days : DEFAULT_RETENTION_DAYS;
    const safe = <T>(f: () => T, d: T): T => { try { return f(); } catch { return d; } };
    const signals = safe(() => checkSignals(p.signals ?? []), []);
    const spaces = new Set<string>(Array.isArray(p.spaces) ? (p.spaces as unknown[]).filter((s): s is string => typeof s === 'string' && SPACE.test(s)) : ['personal']);
    for (const s of signals) spaces.add(s.space);
    const sw = safe(() => checkSwitch(p.switch ?? null), null);
    if (sw) spaces.add(sw.space);
    return { retention_days: days, exclusions: safe(() => checkExclusions(p.exclusions ?? []), []), signals, switch: sw, spaces: [...spaces] };
  }

  // Each setting is checked before it is kept; a bad one changes nothing.
  setSettings(body: Record<string, unknown>): Settings {
    const writes: [string, unknown][] = [];
    if (body.retention_days !== undefined) {
      if (!Number.isInteger(body.retention_days) || (body.retention_days as number) < 1 || (body.retention_days as number) > 3650) throw new CoreError('validation', 'retention_days is how many days capture is kept: a whole number from 1 to 3650.');
      writes.push(['retention_days', body.retention_days]);
    }
    if (body.exclusions !== undefined) writes.push(['exclusions', checkExclusions(body.exclusions)]);
    if (body.signals !== undefined) writes.push(['signals', checkSignals(body.signals)]);
    if (body.switch !== undefined) {
      const sw = body.switch === null ? null : checkSwitch({ since: this.#now().toISOString(), ...(body.switch as object) });
      writes.push(['switch', sw]);
    }
    if (body.spaces !== undefined) {
      if (!Array.isArray(body.spaces) || body.spaces.length > 50 || !body.spaces.every((s) => typeof s === 'string' && SPACE.test(s))) throw new CoreError('validation', 'spaces is a list of names in lowercase letters, digits, - or _.');
      writes.push(['spaces', [...new Set(body.spaces as string[])]]);
    }
    if (!writes.length) throw new CoreError('validation', 'Send one or more of retention_days, exclusions, signals, switch, spaces.');
    this.#db.tx(() => { for (const [k, v] of writes) this.#o.profile.set('capture', k, v, 'settings'); });
    this.#changed('settings');
    return this.settings();
  }

  // ---- sources and consent -------------------------------------------------------------------------

  sources(): SourceView[] {
    return this.#db.all<SourceRow>('SELECT * FROM capture_source ORDER BY created_at, id').map((r) => this.#sourceView(r));
  }

  source(id: string): SourceView {
    return this.#sourceView(this.#source(id));
  }

  // A Screenpipe on this machine (or another of the person's devices) to pull from. Off until enabled.
  addScreenpipe(body: Record<string, unknown>): SourceView {
    const url = this.#url(body.url ?? DEFAULT_URL);
    const self = this.#o.self();
    const id = `screenpipe:${self}`;
    const key = body.api_key === undefined ? {} : { api_key: body.api_key };
    if (this.#db.get('SELECT 1 FROM capture_source WHERE id = ?', id)) return this.configure(id, { url, ...key });
    if (body.api_key !== undefined) this.#checkKey(body.api_key);
    const at = this.#now().toISOString();
    const name = clip(body.name, 80) ?? 'Screenpipe';
    this.#db.run(
      `INSERT INTO capture_source (id, device_id, adapter, name, kinds, config, created_at, updated_at) VALUES (?, ?, 'screenpipe', ?, ?, ?, ?, ?)`,
      id, self, name, JSON.stringify(['screen', 'audio']), JSON.stringify({ url }), at, at,
    );
    if (body.api_key !== undefined) this.#saveKey(id, body.api_key);
    this.#changed('sources');
    return this.source(id);
  }

  // A Screenpipe's address, how far back each pull asks again (lookback_minutes, 1 to 240), and its
  // API key (api_key: kept in the vault; null or "" removes it).
  configure(id: string, body: Record<string, unknown>): SourceView {
    const s = this.#source(id);
    if (s.adapter !== 'screenpipe') throw new CoreError('validation', 'Only a Screenpipe source has an address to set.');
    if (body.api_key !== undefined) this.#checkKey(body.api_key);
    const change: Record<string, unknown> = {};
    if (body.url !== undefined || (body.lookback_minutes === undefined && body.api_key === undefined)) {
      change.url = this.#url(body.url);
      if (s.enabled) this.#refuseRemote(change.url as string);
    }
    if (body.lookback_minutes !== undefined) {
      const m = body.lookback_minutes;
      if (!Number.isInteger(m) || (m as number) < 1 || (m as number) > 240) throw new CoreError('validation', 'lookback_minutes is how far back each pull asks again, for items Screenpipe reports late: a whole number from 1 to 240.');
      change.lookback_minutes = m;
    }
    this.#db.run('UPDATE capture_source SET config = ?, updated_at = ? WHERE id = ?', JSON.stringify({ ...parse<object>(s.config, {}), ...change }), this.#now().toISOString(), id);
    if (body.api_key !== undefined) this.#saveKey(id, body.api_key);
    this.#changed('sources');
    // A changed address or key is tried at once, so the person sees whether it works.
    if (s.enabled && !s.paused && this.#timer && (change.url !== undefined || body.api_key !== undefined)) void this.pull(id);
    return this.source(id);
  }

  // An API key as Screenpipe issues one: printable, no spaces, at most 1024 characters. null or ""
  // means remove it.
  #checkKey(v: unknown): void {
    if (v === null || v === '') return;
    if (typeof v !== 'string' || v.length > 1024 || !/^[\x21-\x7e]+$/.test(v)) {
      throw new CoreError('validation', 'api_key is the key from Screenpipe’s Settings > Privacy: letters, numbers and symbols, no spaces, at most 1024 characters. Send null to remove it.');
    }
    if (!this.#o.secrets) throw new CoreError('conflict', 'Nova has nowhere safe to keep the key here, so it wasn’t saved.');
  }

  #saveKey(id: string, v: unknown): void {
    const name = keyName(id);
    if (v === null || v === '') { if (this.#o.secrets?.has(name)) this.#o.secrets.delete(name); return; }
    this.#o.secrets!.put(name, v as string);
  }

  // Consent: the person turns a source on. Capture starts now, or from `since` when they ask for
  // what Screenpipe already kept earlier (a deliberate choice, never the default).
  enable(id: string, body: { by: string; since?: unknown }): SourceView {
    const s = this.#source(id);
    const not = s.adapter === 'device' ? this.#o.mayCapture?.(s.device_id) : null;
    if (not) throw new CoreError('conflict', not);
    if (s.adapter === 'screenpipe') this.#refuseRemote(parse<{ url?: string }>(s.config, {}).url ?? DEFAULT_URL);
    const at = this.#now().toISOString();
    let since = at;
    if (body.since !== undefined && body.since !== null) {
      if (typeof body.since !== 'string' || Number.isNaN(Date.parse(body.since))) throw new CoreError('validation', 'since must be a time, like 2026-01-31T09:00:00Z.');
      since = new Date(body.since).toISOString();
      if (since > at) since = at;
    }
    this.#db.run(`UPDATE capture_source SET enabled = 1, paused = 0, consent_at = ?, consent_by = ?, cursor = ?, status = 'on', status_detail = NULL, status_at = ?, updated_at = ? WHERE id = ?`,
      at, body.by, JSON.stringify({ since, read: {} }), at, at, id);
    this.#changed('sources');
    if (s.adapter === 'screenpipe' && this.#timer) void this.pull(id);
    return this.source(id);
  }

  // Consent withdrawn. What was captured stays until retention or a forget removes it.
  disable(id: string): SourceView {
    this.#source(id);
    this.#db.run(`UPDATE capture_source SET enabled = 0, paused = 0, cursor = NULL, status = 'off', status_detail = NULL, updated_at = ? WHERE id = ?`, this.#now().toISOString(), id);
    this.#settle(id);
    this.#changed('sources');
    return this.source(id);
  }

  // Paused: nothing is taken in, and on resume nothing from the paused stretch is either.
  pause(id: string): SourceView {
    const s = this.#source(id);
    if (!s.enabled) throw new CoreError('conflict', `${s.name} is off; there is nothing to pause.`);
    this.#db.run(`UPDATE capture_source SET paused = 1, status = 'paused', updated_at = ? WHERE id = ?`, this.#now().toISOString(), id);
    this.#changed('sources');
    return this.source(id);
  }

  resume(id: string): SourceView {
    const s = this.#source(id);
    if (!s.enabled) throw new CoreError('conflict', `${s.name} is off; turn it on instead.`);
    const at = this.#now().toISOString();
    const cursor = parse<{ since?: string; read?: Cursor }>(s.cursor, {});
    // Every adapter's reading jumps to now: what was recorded while paused is never pulled.
    const read = Object.fromEntries(Object.keys(cursor.read ?? {}).map((k) => [k, { after: at, seen: [] }]));
    this.#db.run(`UPDATE capture_source SET paused = 0, status = 'on', cursor = ?, updated_at = ? WHERE id = ?`, JSON.stringify({ since: at, read }), at, id);
    this.#changed('sources');
    return this.source(id);
  }

  // Pause or resume everything at once (the indicator's control).
  pauseAll(paused: boolean): SourceView[] {
    for (const s of this.sources().filter((x) => x.enabled && x.paused !== paused)) {
      if (paused) this.pause(s.id); else this.resume(s.id);
    }
    return this.sources();
  }

  // A paired computer says, in its heartbeat, what it can capture ("capture.app-activity"): each
  // becomes a source here, off until the person turns it on.
  offer(device: { id: string; name: string; capabilities: string[] }): string[] {
    const made: string[] = [];
    if (this.#o.mayCapture?.(device.id)) return made;
    for (const cap of device.capabilities ?? []) {
      const kind = cap.startsWith('capture.') ? cap.slice('capture.'.length) : null;
      if (!kind || !(KINDS as readonly string[]).includes(kind)) continue;
      if (this.#ensureDeviceSource(device.id, kind as Kind)) made.push(kind);
    }
    if (made.length) this.#changed('sources');
    return made;
  }

  // Whether anything is capturing right now: what the indicator shows on every page.
  status(): { active: boolean; capturing: { id: string; name: string; device: string | null }[]; paused: number; today: number; unclassified: number; proposals: number; problem: string | null } {
    const sources = this.sources();
    const on = sources.filter((s) => s.active);
    const dayStart = new Date(this.#now().getTime() - DAY_MS).toISOString();
    const n = (sql: string, ...a: string[]) => this.#db.get<{ n: number }>(sql, ...a)!.n;
    // A source Nova isn't pulling (down, refused, or on a device that isn't the hub now) needs the
    // person, whatever it is doing on its own machine.
    const broken = on.find((s) => s.status === 'unreachable' || s.status === 'refused' || s.status === 'elsewhere');
    return {
      active: on.length > 0,
      capturing: on.map((s) => ({ id: s.id, name: s.name, device: s.device.name })),
      paused: sources.filter((s) => s.enabled && s.paused).length,
      today: n('SELECT COUNT(*) AS n FROM capture_event WHERE at >= ?', dayStart),
      unclassified: n('SELECT COUNT(*) AS n FROM capture_event WHERE space IS NULL'),
      proposals: n(`SELECT COUNT(*) AS n FROM capture_proposal WHERE state = 'proposed'`),
      problem: broken ? broken.detail : null,
    };
  }

  health(): { ok: boolean; detail: string; active: number } {
    const on = this.sources().filter((s) => s.active);
    const bad = on.filter((s) => s.status === 'unreachable' || s.status === 'refused');
    return { ok: bad.length === 0, detail: bad.map((s) => s.detail).join(' ') || (on.length ? `Capturing from ${on.length} source${on.length === 1 ? '' : 's'}.` : 'Off: no source is turned on.'), active: on.length };
  }

  // ---- taking events in --------------------------------------------------------------------------

  // The one way in for every adapter. Returns what was kept and how many were dropped, and why
  // (never what they said).
  ingest(sourceId: string, raws: RawEvent[], via: 'pull' | 'inbox' | 'api'): Ingested {
    const out: Ingested = { kept: [], dropped: {}, why: {} };
    const fired: CaptureEvent[] = [];
    const drop = (reason: string, why?: string) => { out.dropped[reason] = (out.dropped[reason] ?? 0) + 1; if (why) out.why[reason] = why; };
    this.#db.tx(() => {
      const s = this.#source(sourceId);
      const cursor = parse<{ since?: string }>(s.cursor, {});
      const settings = this.settings();
      const tz = this.#o.timezone();
      const received = this.#now().toISOString();
      const kinds = parse<Kind[]>(s.kinds, []);
      for (const raw of raws) {
        if (!s.enabled) { drop('off', `${s.name} is off.`); continue; }
        if (s.paused) { drop('paused', `${s.name} is paused.`); continue; }
        // Private and incognito contexts: dropped first, on what the source sent (a long title's
        // marker is at its end, past where a stored title is cut), before anything is stored.
        if (isPrivate(raw as { private?: unknown }, raw)) { drop('private', 'Private and incognito windows are never kept.'); continue; }
        // A time with no zone would be read in the server's: refused, as unreadable.
        const at = instant(raw.at);
        if (!at || !kinds.includes(raw.kind)) { drop('unreadable', 'It didn’t say when it happened (a time with its zone), or what kind of capture it is.'); continue; }
        if (cursor.since && at < cursor.since) { drop('before_consent', 'It was captured before you turned this on, or while it was paused.'); continue; }
        const ended = instant(raw.ended_at);
        const f: Facts = {
          kind: raw.kind, at, ended_at: ended && ended > at ? ended : null, device_id: s.device_id, source_id: s.id,
          app: clip(raw.app, MAX_FIELD), window_title: clip(raw.window_title, MAX_FIELD), url: clip(raw.url, MAX_URL),
          text: typeof raw.text === 'string' ? raw.text : null,
        };
        const external = clip(raw.external_id, 200);
        if (external && this.#db.get('SELECT 1 FROM capture_tombstone WHERE source_id = ? AND key = ?', s.id, sha(`${s.id}\0${external}`))) { drop('forgotten', 'You had Nova forget it.'); continue; }
        if (external && this.#db.get('SELECT 1 FROM capture_event WHERE source_id = ? AND external_id = ?', s.id, external)) { drop('duplicate'); continue; }
        const c = classify(f, settings.signals, settings.switch, tz);
        const ex = excludedBy({ ...f, space: c?.space ?? null }, settings.exclusions, tz);
        if (ex) { drop('excluded', `Excluded: ${describeExclusion(ex)}.`); continue; }
        const id = randomUUID();
        this.#db.run(
          `INSERT INTO capture_event (id, source_id, device_id, adapter, kind, at, ended_at, received_at, app, window_title, url, text, space, space_by, external_id, via, consent_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          id, s.id, s.device_id, s.adapter, raw.kind, at, f.ended_at ?? null,
          received, f.app, f.window_title, f.url, clip(raw.text, MAX_TEXT), c?.space ?? null, c?.by ?? null, external, via, s.consent_at!,
        );
        out.kept.push(id);
        fired.push(this.event(id));
      }
      this.#count(s.id, out);
    });
    if (out.kept.length) {
      for (const e of fired) this.emit('event', e);
      this.#changed('events', { kept: out.kept.length });
      setImmediate(() => { for (const e of fired) this.#fire(e); });
    }
    return out;
  }

  // A capture_event from a device agent's inbox (mesh/spokes.ts), inside the inbox's transaction,
  // so it is taken in exactly once by its key. The item's body is never kept in the inbox.
  fromDevice(device: { id: string; name: string }, key: string, body: Record<string, unknown>): { ref?: string; reason?: string; refused?: boolean } {
    const not = this.#o.mayCapture?.(device.id);
    if (not) return { refused: true, reason: not };
    const kind = body.kind;
    if (typeof kind !== 'string' || !(KINDS as readonly string[]).includes(kind)) return { refused: true, reason: `kind must be one of ${KINDS.join(', ')}.` };
    const id = this.#ensureDeviceSource(device.id, kind as Kind) ?? `device:${device.id}:${kind}`;
    const r = this.ingest(id, [{
      external_id: clip(body.external_id, 200) ?? `inbox:${key}`, kind: kind as Kind, at: body.at as string,
      ended_at: typeof body.ended_at === 'string' ? body.ended_at : null,
      app: body.app as string, window_title: body.window_title as string, url: body.url as string, text: body.text as string,
      ...(body.private === true || body.incognito === true ? { private: true } : {}),
    }], 'inbox');
    if (r.kept.length) return { ref: r.kept[0]! };
    const reason = Object.keys(r.dropped)[0] ?? 'unreadable';
    return { reason: `Not kept: ${r.why[reason] ?? reason}` };
  }

  // ---- reading -------------------------------------------------------------------------------------

  // capture.stream(device, kind): the normalized events for one device and kind (null: any), as
  // they arrive, plus what is already stored. Readers never see which source produced them.
  stream(device: string | null, kind: Kind | null) {
    if (kind !== null && !KINDS.includes(kind)) throw new CoreError('validation', `kind is one of ${KINDS.join(', ')}.`);
    const match = (e: CaptureEvent) => (!device || e.device.id === device) && (!kind || e.kind === kind);
    const self = this;
    return {
      recent: (limit = 50) => this.events({ ...(device ? { device } : {}), ...(kind ? { kind } : {}), limit }),
      subscribe: (fn: (e: CaptureEvent) => void) => {
        const f = (e: CaptureEvent) => { if (match(e)) fn(e); };
        this.on('event', f);
        return () => { this.off('event', f); };
      },
      // Listening starts when the iterator is made, not at its first next(), so nothing that
      // arrives in between is missed. return() (a for-await loop's break) stops it.
      [Symbol.asyncIterator](): AsyncIterator<CaptureEvent> {
        const queue: CaptureEvent[] = [];
        let wake: ((r: IteratorResult<CaptureEvent>) => void) | null = null;
        let done = false;
        const f = (e: CaptureEvent) => {
          if (!match(e)) return;
          if (wake) { const w = wake; wake = null; w({ value: e, done: false }); } else queue.push(e);
        };
        self.on('event', f);
        const end = (): IteratorResult<CaptureEvent> => { done = true; self.off('event', f); wake?.({ value: undefined, done: true }); wake = null; return { value: undefined, done: true }; };
        return {
          next: () => {
            if (queue.length) return Promise.resolve({ value: queue.shift()!, done: false });
            if (done) return Promise.resolve({ value: undefined, done: true });
            return new Promise((r) => { wake = r; });
          },
          return: () => Promise.resolve(end()),
        };
      },
    };
  }

  events(f: { device?: string; kind?: Kind; space?: string; unclassified?: boolean; before?: string; limit?: number } = {}): CaptureEvent[] {
    const limit = f.limit ?? 50;
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw new CoreError('validation', 'limit is a whole number from 1 to 500.');
    const where: string[] = [];
    const args: string[] = [];
    if (f.device) { where.push('device_id = ?'); args.push(f.device); }
    if (f.kind) { where.push('kind = ?'); args.push(f.kind); }
    if (f.space) { where.push('space = ?'); args.push(f.space); }
    if (f.unclassified) where.push('space IS NULL');
    if (f.before) { where.push('at < ?'); args.push(f.before); }
    return this.#db.all<EventRow>(`SELECT * FROM capture_event ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY at DESC, rowid DESC LIMIT ${limit}`, ...args).map((r) => this.#eventView(r));
  }

  event(id: string): CaptureEvent {
    return this.#eventView(this.#event(id));
  }

  // The person says which space an unclassified (or misfiled) event belongs to. `remember: 'app'`
  // also keeps it as a signal, so that app's activity goes there from now on.
  resolve(id: string, body: { space?: unknown; remember?: unknown }): CaptureEvent {
    const e = this.#event(id);
    if (typeof body.space !== 'string' || !SPACE.test(body.space)) throw new CoreError('validation', 'space is a space’s name in lowercase letters, digits, - or _.');
    const space = body.space;
    this.#db.tx(() => {
      this.#db.run(`UPDATE capture_event SET space = ?, space_by = 'person' WHERE id = ?`, space, id);
      if (body.remember === 'app') {
        if (!e.app) throw new CoreError('validation', 'This event names no app to remember.');
        const s = this.settings();
        const signals = s.signals.filter((x) => !(x.kind === 'app' && x.app.toLowerCase() === e.app!.toLowerCase()));
        this.#o.profile.set('capture', 'signals', [...signals, { kind: 'app', app: e.app, space }], 'settings');
      }
      const spaces = this.settings().spaces;
      if (!spaces.includes(space)) this.#o.profile.set('capture', 'spaces', [...spaces, space], 'settings');
    });
    this.#changed('events');
    return this.event(id);
  }

  // ---- forgetting and retention ---------------------------------------------------------------------

  // Real deletion. A memory promoted from these events holds the same words, so it is forgotten
  // too, unless the person keeps it (keep_memory). Backups, the write-ahead log and the standby
  // follow (the sync log carries a content-free delete).
  forget(ids: string[], by: string, o: { keep_memory?: boolean } = {}): { forgotten: string[]; memories: string[] } {
    if (!Array.isArray(ids) || !ids.length || !ids.every((x) => typeof x === 'string')) throw new CoreError('validation', 'Say which events to forget: ids.');
    const rows = ids.map((id) => this.#db.get<EventRow>('SELECT * FROM capture_event WHERE id = ?', id)).filter((r): r is EventRow => !!r);
    if (!rows.length) throw new CoreError('not_found', 'There are no such captured events.');
    const memories = o.keep_memory ? [] : [...new Set(this.#db.all<{ memory_id: string }>(
      `SELECT memory_id FROM capture_promotion WHERE event_id IN (${rows.map(() => '?').join(', ')})`, ...rows.map((r) => r.id)).map((m) => m.memory_id))];
    this.#remove(rows, { tombstone: true });
    const forgotten: string[] = [];
    for (const m of memories) {
      try { forgotten.push(...this.#o.memory.forget(m, by).forgotten); } catch (e) { if (!(e instanceof CoreError && e.code === 'not_found')) throw e; }
    }
    this.#changed('events');
    return { forgotten: rows.map((r) => r.id), memories: forgotten };
  }

  // Retention (a profile policy): capture older than retention_days is deleted the way a forget
  // deletes it. Promoted memories stay; their provenance keeps when and where, not what.
  // While the clock is in doubt (it jumped), nothing is deleted for being old: it may not be.
  sweep(at: Date = this.#now()): { swept: number; cutoff: string; held?: string } {
    const cutoff = new Date(at.getTime() - this.settings().retention_days * DAY_MS).toISOString();
    const held = this.#o.retentionHold?.() ?? null;
    if (held) return { swept: 0, cutoff, held };
    const rows = this.#db.all<EventRow>('SELECT * FROM capture_event WHERE at < ? LIMIT 5000', cutoff);
    if (rows.length) {
      this.#remove(rows, { tombstone: false });
      this.#changed('events');
    }
    return { swept: rows.length, cutoff };
  }

  // A memory was forgotten (any way: the Memory view, the API, a capture forget). The events it
  // was promoted from carry its words, so they go too; the link goes with them.
  memoryForgotten(records: MemoryRecord[]): void {
    const ids = records.map((r) => r.id);
    if (!ids.length) return;
    const q = ids.map(() => '?').join(', ');
    const links = this.#db.all<{ event_id: string }>(`SELECT event_id FROM capture_promotion WHERE memory_id IN (${q})`, ...ids);
    if (!links.length) return;
    const rows = [...new Set(links.map((l) => l.event_id))].map((id) => this.#db.get<EventRow>('SELECT * FROM capture_event WHERE id = ?', id)).filter((r): r is EventRow => !!r);
    this.#db.run(`DELETE FROM capture_promotion WHERE memory_id IN (${q})`, ...ids);
    this.#db.run(`UPDATE capture_proposal SET memory_id = NULL WHERE memory_id IN (${q})`, ...ids);
    if (rows.length) this.#remove(rows, { tombstone: true });
    this.#changed('events');
  }

  // On a standby: sync deleted these rows because the hub forgot or swept them. The rest of a
  // forget happens here too: the write-ahead log (sync already folded it) and the backups.
  forgottenElsewhere(rows: Record<string, unknown>[]): void {
    const ids = rows.map((r) => String(r.id));
    if (ids.length) this.#o.backups.forget('capture_event', ids);
  }

  #remove(rows: EventRow[], o: { tombstone: boolean }): void {
    const ids = rows.map((r) => r.id);
    const at = this.#now().toISOString();
    this.#db.tx(() => {
      for (const r of rows) {
        this.#db.run('DELETE FROM capture_event WHERE id = ?', r.id);
        this.#db.run('DELETE FROM capture_proposal WHERE event_id = ?', r.id);
        if (o.tombstone && r.external_id) this.#db.run('INSERT OR IGNORE INTO capture_tombstone (source_id, key, at) VALUES (?, ?, ?)', r.source_id, sha(`${r.source_id}\0${r.external_id}`), at);
      }
    });
    // The freed pages were overwritten (secure_delete, set by memory.ts on this connection); the
    // write-ahead log's copies are folded in now, and every backup is cleaned of the rows.
    if (this.#db.path !== ':memory:') this.#db.raw.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    this.#o.backups.forget('capture_event', ids);
  }

  // ---- promotion -------------------------------------------------------------------------------------

  // Deliberate: the person makes a memory from captured events. Its provenance (CONTRACTS §7) is
  // source capture:<ids>, observed when the first was captured, recorded by whoever asked (the
  // hub's own screen, "console", or a paired device, "device:<id>").
  promote(body: { event_ids?: unknown; content?: unknown; kind?: unknown; scope?: unknown }, by: string, proposalId: string | null = null): { memory: MemoryRecord; events: string[] } {
    const ids = Array.isArray(body.event_ids) ? body.event_ids : [];
    if (!ids.length || ids.length > 20 || !ids.every((x) => typeof x === 'string')) throw new CoreError('validation', 'event_ids lists the captured events this memory comes from (1 to 20).');
    const rows = (ids as string[]).map((id) => this.#event(id)).sort((a, b) => a.at.localeCompare(b.at));
    const content = typeof body.content === 'string' && body.content.trim() ? body.content.trim() : rows.map((r) => r.text ?? '').filter(Boolean).join('\n').trim();
    if (!content) throw new CoreError('validation', 'These events have no words to remember; say what to remember as content.');
    const scope = typeof body.scope === 'string' ? body.scope : rows.find((r) => r.space)?.space ?? 'personal';
    const kind = (typeof body.kind === 'string' ? body.kind : 'fact') as MemoryKind;
    const at = this.#now().toISOString();
    return this.#db.tx(() => {
      let memory = this.#o.memory.remember({ kind, content, recorded_by: by, source: `capture:${rows.map((r) => r.id).join(',')}`.slice(0, 2000), observed_at: rows[0]!.at, scope });
      // Whoever promoted it chose it deliberately: it is confirmed, whatever kind of caller they are.
      if (memory.user_state !== 'confirmed') memory = this.#o.memory.confirm(memory.id, by);
      for (const r of rows) {
        this.#db.run('INSERT INTO capture_promotion (id, memory_id, event_id, proposal_id, by, at, event_at, event_kind, source_id, device_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
          randomUUID(), memory.id, r.id, proposalId, by, at, r.at, r.kind, r.source_id, r.device_id);
      }
      this.#changed('events');
      return { memory, events: rows.map((r) => r.id) };
    });
  }

  promotions(memoryId: string): { event_id: string; at: string; by: string; event_at: string | null; event_kind: string | null; source_id: string | null; device_id: string | null; proposal_id: string | null; present: boolean }[] {
    return this.#db.all<{ event_id: string; at: string; by: string; event_at: string | null; event_kind: string | null; source_id: string | null; device_id: string | null; proposal_id: string | null }>(
      'SELECT event_id, at, by, event_at, event_kind, source_id, device_id, proposal_id FROM capture_promotion WHERE memory_id = ? ORDER BY event_at', memoryId,
    ).map((r) => ({ ...r, present: !!this.#db.get('SELECT 1 FROM capture_event WHERE id = ?', r.event_id) }));
  }

  // A triage decision with an escape looks at events not yet looked at and may propose keeping
  // one. An unsure answer proposes nothing. When no provider could answer at all, the event isn't
  // marked looked at: the pass stops there, and the next one asks again, so once a provider exists
  // everything waiting is triaged, oldest first.
  async propose(limit = PROPOSE_PER_TICK): Promise<{ looked: number; proposed: string[]; waiting: boolean }> {
    const rows = this.#db.all<EventRow>(`SELECT * FROM capture_event WHERE triaged = 0 AND text IS NOT NULL ORDER BY at LIMIT ${Math.max(1, Math.min(100, limit))}`);
    const proposed: string[] = [];
    let looked = 0;
    let waiting = false;
    for (const r of rows) {
      let d = null;
      try {
        let text = (r.text ?? '').slice(0, 4000);
        if (this.#o.screen) {
          const s = await this.#o.screen({ text, kind: r.kind, origin: r.app || r.url || r.adapter });
          if (s.verdict === 'block') {
            // Nothing to propose from content that tried to give instructions; it is looked at.
            looked++;
            this.#db.run('UPDATE capture_event SET triaged = 1 WHERE id = ?', r.id);
            continue;
          }
          text = s.extract.slice(0, 4000);
        }
        d = await this.#o.decisions.decide(PROMOTE.template_id, { kind: r.kind, app: r.app ?? '', space: r.space ?? '', text });
        // No answer at all: no template, no provider allowed, or only the rules, which have no rule
        // for this (they answer "unknown" with no confidence). A model's unsure answer is an answer.
        if (!d || d.provider === 'none' || (d.provider === 'rules' && d.confidence === 0)) { waiting = true; break; }
      } catch (e) {
        this.#o.log.warn('capture', 'A captured event couldn’t be triaged.', { error: (e as Error).message });
      }
      // The provider that should answer didn't (its model is down): stop here and ask again on a
      // later pass, rather than count this and the rest as looked at.
      const expected = this.#o.proposer?.() ?? null;
      if (expected && d?.provider !== expected) { waiting = true; break; }
      looked++;
      if (!this.#db.get('SELECT 1 FROM capture_event WHERE id = ?', r.id)) continue;
      this.#db.tx(() => {
        this.#db.run('UPDATE capture_event SET triaged = 1 WHERE id = ?', r.id);
        const p = d?.answers.remember;
        if (d && !d.escalate && typeof p === 'number' && p > 0.5) {
          const id = randomUUID();
          this.#db.run(`INSERT INTO capture_proposal (id, event_id, template_id, version, provider, p, state, at) VALUES (?, ?, ?, ?, ?, ?, 'proposed', ?)`, id, r.id, d.template_id, d.version, d.provider, p, this.#now().toISOString());
          proposed.push(id);
        }
      });
    }
    if (proposed.length) this.#changed('proposals');
    return { looked, proposed, waiting };
  }

  proposals(): { id: string; event: CaptureEvent; p: number | null; provider: string; at: string }[] {
    return this.#db.all<{ id: string; event_id: string; p: number | null; provider: string; at: string }>(`SELECT id, event_id, p, provider, at FROM capture_proposal WHERE state = 'proposed' ORDER BY p DESC, at`)
      .map((r) => ({ id: r.id, event: this.event(r.event_id), p: r.p, provider: r.provider, at: r.at }));
  }

  // The person's OK on a proposal: only now does it become a memory.
  accept(id: string, body: { content?: unknown; scope?: unknown }, by: string): { memory: MemoryRecord; events: string[] } {
    const p = this.#proposal(id);
    return this.#db.tx(() => {
      const out = this.promote({ event_ids: [p.event_id], content: body.content, scope: body.scope }, by, id);
      this.#db.run(`UPDATE capture_proposal SET state = 'accepted', decided_at = ?, memory_id = ? WHERE id = ?`, this.#now().toISOString(), out.memory.id, id);
      return out;
    });
  }

  dismiss(id: string): { ok: true } {
    this.#proposal(id);
    this.#db.run(`UPDATE capture_proposal SET state = 'dismissed', decided_at = ? WHERE id = ?`, this.#now().toISOString(), id);
    this.#changed('proposals');
    return { ok: true };
  }

  // ---- adapters' pulls, retention, proposals: the hub's own work ------------------------------------

  // Pulls one Screenpipe source now. Down is a status and one problem (resolved when it is back),
  // never a crash; the cursor stays, so nothing Screenpipe kept is missed.
  pull(id: string): Promise<{ kept: number; dropped: Record<string, number> } | { error: string }> {
    const running = this.#pulling.get(id);
    if (running) return running as Promise<{ kept: number; dropped: Record<string, number> }>;
    const p = this.#pull(id).finally(() => this.#pulling.delete(id));
    this.#pulling.set(id, p);
    return p;
  }

  async #pull(id: string): Promise<{ kept: number; dropped: Record<string, number> } | { error: string }> {
    const s = this.#source(id);
    if (s.adapter !== 'screenpipe' || !s.enabled || s.paused) return { kept: 0, dropped: {} };
    const url = parse<{ url?: string }>(s.config, {}).url ?? DEFAULT_URL;
    // A Screenpipe on this machine is this machine's: after a failover, the new hub doesn't pull
    // its own loopback in the old hub's name.
    if (s.device_id !== this.#o.self() && addressEgress(url) === 'local' && /^(localhost|127\.|\[?::1\]?)/.test(new URL(url).hostname)) {
      return this.#status(id, 'elsewhere', `${s.name} runs on ${this.#o.deviceName(s.device_id) ?? 'another device'}, which isn’t the hub now, so it isn’t pulled until that device is hub again.`);
    }
    if (!permits(this.#o.privacy(), this.#egress(url))) {
      return this.#status(id, 'refused', `${s.name} at ${url} is outside your devices, and your privacy setting is local-only, so Nova doesn’t pull from it.`);
    }
    const cursor = parse<{ since?: string; read?: Cursor }>(s.cursor, {});
    const since = cursor.since ?? s.consent_at ?? this.#now().toISOString();
    let got;
    try {
      const apiKey = this.#o.secrets?.get(keyName(id)) ?? null;
      got = await new Screenpipe({ url, apiKey, lookbackMs: this.#lookback(s) * 60_000, ...(this.#o.fetch ? { fetch: this.#o.fetch } : {}) }).pull(cursor.read ?? {}, since);
    } catch (e) {
      if (e instanceof KeyRefused) {
        if (!this.#outage.has(id)) this.#outage.set(id, this.#o.log.problem('capture', `${e.message} Nothing new is captured from it until it lets Nova in; nothing Screenpipe keeps meanwhile is lost.`).id);
        return this.#status(id, 'needs_key', e.message);
      }
      const why = e instanceof Unreachable ? e.message : `Screenpipe at ${url} sent something Nova couldn’t read.`;
      if (!(e instanceof Unreachable)) this.#o.log.warn('capture', why, { error: (e as Error)?.message });
      if (!this.#outage.has(id)) {
        this.#outage.set(id, this.#o.log.problem('capture', `${why} Nothing new is captured from it until it answers; Nova keeps trying, and nothing Screenpipe keeps meanwhile is lost.`).id);
      }
      return this.#status(id, 'unreachable', why);
    }
    // The source may have been turned off or paused while the pull was out.
    const now = this.#source(id);
    if (!now.enabled || now.paused || now.cursor !== s.cursor) return { kept: 0, dropped: {} };
    const r = this.#db.tx(() => {
      const r = this.ingest(id, got.events, 'pull');
      this.#db.run('UPDATE capture_source SET cursor = ? WHERE id = ?', JSON.stringify({ since, read: got.cursor }), id);
      return r;
    });
    this.#settle(id);
    this.#status(id, 'on', null);
    return { kept: r.kept.length, dropped: r.dropped };
  }

  // One heartbeat of capture: pull every source that pulls, sweep, and triage new events. `at` is
  // for test clocks only (the core offers it only under NOVA_TEST_CLOCK): capture then takes that
  // time as now from here on.
  async tick(at?: Date): Promise<{ pulled: Record<string, unknown>; swept: number; proposed: number }> {
    if (at) this.#clock = at;
    const pulled: Record<string, unknown> = {};
    for (const s of this.sources().filter((x) => x.adapter === 'screenpipe' && x.active)) pulled[s.id] = await this.pull(s.id);
    const { swept } = this.sweep();
    const { proposed } = await this.propose();
    return { pulled, swept, proposed: proposed.length };
  }

  start(): void {
    if (this.#timer) return;
    const run = () => { this.tick().catch((e) => this.#o.log.problem('capture', 'Capture’s regular pass failed.', { detail: (e as Error)?.stack ?? String(e) })); };
    this.#timer = setInterval(run, this.#o.pollMs ?? 10_000);
    this.#timer.unref();
    run();
  }

  async stop(): Promise<void> {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
    await Promise.allSettled([...this.#pulling.values()]);
  }

  // A device's capture sources that are on: what taking its capture-source role away stops.
  sourcesOn(deviceId: string): string[] {
    return this.#db.all<{ name: string }>(`SELECT name FROM capture_source WHERE device_id = ? AND adapter = 'device' AND enabled = 1 ORDER BY name`, deviceId).map((r) => r.name);
  }

  // A device was revoked, or is no longer a capture source: what it captured stays (until retention
  // or a forget), but nothing more is taken from it. Its sources go off, so turning one on again is
  // a fresh consent.
  deviceRemoved(deviceId: string, why = 'Turned off: its device was removed from your devices.'): string[] {
    const at = this.#now().toISOString();
    const ids = this.#db.all<{ id: string }>('SELECT id FROM capture_source WHERE device_id = ? AND enabled = 1', deviceId).map((r) => r.id);
    for (const id of ids) {
      this.#db.run(`UPDATE capture_source SET enabled = 0, paused = 0, cursor = NULL, status = 'off', status_detail = ?, status_at = ?, updated_at = ? WHERE id = ?`,
        why, at, at, id);
      this.#settle(id);
    }
    if (ids.length) this.#changed('sources');
    return ids;
  }

  // Sync brought rows from the hub (on a standby): capture may have changed with them, and pages
  // showing it reload.
  synced(): void {
    this.#changed('sync');
  }

  // ---- event triggers --------------------------------------------------------------------------------

  // Whether a rule may listen for this topic (connector "capture").
  topicCheck(topic: string): string | null {
    return TOPIC.test(topic) ? null : `Capture sends any, unclassified, space:<name>, or a kind (${KINDS.join(', ')}).`;
  }

  #fire(e: CaptureEvent): void {
    const payload = { event_id: e.id, kind: e.kind, at: e.at, device_id: e.device.id, space: e.space };
    for (const topic of ['any', e.kind, e.space ? `space:${e.space}` : 'unclassified']) {
      this.#o.fire(topic, payload, `${e.id}:${topic}`).catch((err) => this.#o.log.warn('capture', 'A capture event trigger failed.', { error: (err as Error)?.message }));
    }
  }

  // ---- internals ---------------------------------------------------------------------------------------

  #ensureDeviceSource(deviceId: string, kind: Kind): string | null {
    const id = `device:${deviceId}:${kind}`;
    if (this.#db.get('SELECT 1 FROM capture_source WHERE id = ?', id)) return id;
    const at = this.#now().toISOString();
    const label: Record<Kind, string> = { screen: 'Screen', audio: 'Audio', meeting: 'Meetings', browser: 'Browser', 'app-activity': 'App activity', sensor: 'Sensors' };
    this.#db.run(`INSERT INTO capture_source (id, device_id, adapter, name, kinds, created_at, updated_at) VALUES (?, ?, 'device', ?, ?, ?, ?)`, id, deviceId, label[kind], JSON.stringify([kind]), at, at);
    this.#changed('sources');
    return id;
  }

  #count(id: string, r: Ingested): void {
    const s = this.#db.get<{ counts: string }>('SELECT counts FROM capture_source WHERE id = ?', id);
    const c = parse<Record<string, number>>(s?.counts ?? null, {});
    if (r.kept.length) c.kept = (c.kept ?? 0) + r.kept.length;
    for (const [k, n] of Object.entries(r.dropped)) c[k] = (c[k] ?? 0) + n;
    if (r.kept.length || Object.keys(r.dropped).length) this.#db.run('UPDATE capture_source SET counts = ? WHERE id = ?', JSON.stringify(c), id);
  }

  #status(id: string, status: string, detail: string | null): { error: string } {
    const s = this.#db.get<{ status: string; status_detail: string | null }>('SELECT status, status_detail FROM capture_source WHERE id = ?', id);
    const at = this.#now().toISOString();
    if (s && (s.status !== status || s.status_detail !== detail)) {
      this.#db.run('UPDATE capture_source SET status = ?, status_detail = ?, status_at = ? WHERE id = ?', status, detail, at, id);
      this.#changed('sources');
    } else this.#db.run('UPDATE capture_source SET status_at = ? WHERE id = ?', at, id);
    return { error: detail ?? '' };
  }

  // Back after an outage: its problem is resolved.
  #settle(id: string): void {
    const p = this.#outage.get(id);
    if (p === undefined) return;
    this.#outage.delete(id);
    try { this.#o.log.resolve(p); } catch { /* already resolved by the person */ }
  }

  #lookback(r: SourceRow): number {
    const m = parse<{ lookback_minutes?: unknown }>(r.config, {}).lookback_minutes;
    return typeof m === 'number' && m >= 1 ? m : (this.#o.lookbackMs ?? DEFAULT_LOOKBACK_MS) / 60_000;
  }

  #egress(url: string): 'local' | 'remote' {
    return addressEgress(url, this.#o.meshHosts()) === 'local' ? 'local' : 'remote';
  }

  #refuseRemote(url: string): void {
    if (!permits(this.#o.privacy(), this.#egress(url))) throw new CoreError('forbidden', `${url} is outside your devices. Your privacy setting is local-only, so Nova won’t pull capture from outside your devices.`);
  }

  #url(v: unknown): string {
    const s = typeof v === 'string' ? v.trim() : '';
    let u: URL;
    try { u = new URL(s); } catch { throw new CoreError('validation', 'url is Screenpipe’s address, like http://localhost:3030.'); }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new CoreError('validation', 'url is an http or https address.');
    if (u.username || u.password) throw new CoreError('validation', 'Put no user name or password in the address.');
    return u.origin;
  }

  #source(id: string): SourceRow {
    const r = this.#db.get<SourceRow>('SELECT * FROM capture_source WHERE id = ?', id);
    if (!r) throw new CoreError('not_found', `There is no capture source "${id}".`);
    return r;
  }

  #event(id: string): EventRow {
    const r = this.#db.get<EventRow>('SELECT * FROM capture_event WHERE id = ?', id);
    if (!r) throw new CoreError('not_found', 'There is no such captured event (it may have been forgotten, or swept by retention).');
    return r;
  }

  #proposal(id: string): { id: string; event_id: string } {
    const r = this.#db.get<{ id: string; event_id: string }>(`SELECT id, event_id FROM capture_proposal WHERE id = ? AND state = 'proposed'`, id);
    if (!r) throw new CoreError('not_found', 'There is no such open proposal.');
    return r;
  }

  #sourceView(r: SourceRow): SourceView {
    const url = r.adapter === 'screenpipe' ? parse<{ url?: string }>(r.config, {}).url ?? DEFAULT_URL : null;
    return {
      id: r.id, name: r.name, adapter: r.adapter, device: { id: r.device_id, name: this.#o.deviceName(r.device_id) }, kinds: parse<Kind[]>(r.kinds, []), url,
      enabled: r.enabled === 1, paused: r.paused === 1, active: r.enabled === 1 && r.paused === 0,
      consent: r.consent_at ? { at: r.consent_at, by: r.consent_by ?? 'person' } : null,
      status: r.status, detail: r.status_detail, checked_at: r.status_at, counts: parse<Record<string, number>>(r.counts, {}),
      egress: url ? this.#egress(url) : null,
      lookback_minutes: r.adapter === 'screenpipe' ? this.#lookback(r) : null,
      has_api_key: r.adapter === 'screenpipe' ? (this.#o.secrets?.has(keyName(r.id)) ?? false) : null,
    };
  }

  #eventView(r: EventRow): CaptureEvent {
    const promoted = this.#db.all<{ memory_id: string }>('SELECT DISTINCT memory_id FROM capture_promotion WHERE event_id = ?', r.id).map((x) => x.memory_id);
    const prop = this.#db.get<{ id: string; p: number | null; provider: string }>(`SELECT id, p, provider FROM capture_proposal WHERE event_id = ? AND state = 'proposed'`, r.id);
    return {
      id: r.id, kind: r.kind, at: r.at, ended_at: r.ended_at, received_at: r.received_at,
      device: { id: r.device_id, name: this.#o.deviceName(r.device_id) },
      app: r.app, window_title: r.window_title, url: r.url, text: r.text, space: r.space, space_by: r.space_by,
      consent: { state: 'granted', at: r.consent_at },
      provenance: { adapter: r.adapter, source_id: r.source_id, external_id: r.external_id, via: r.via, device_id: r.device_id, received_at: r.received_at },
      promoted, proposal: prop ?? null,
    };
  }

  #changed(what: string, extra: Record<string, unknown> = {}): void {
    this.emit('change', { what, ...extra });
  }
}
