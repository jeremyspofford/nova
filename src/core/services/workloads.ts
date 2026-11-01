// Native workloads on devices, the hub's side (M10h; the orchestration ADR Point 6, Decision 1): the
// `device` driver, one per device (`driver(deviceId)`), each implementing the M10e driver interface,
// so a Service Manager moves a version through the same stages at the same tiers as on the hub; what
// differs is who carries them out. One service (Screenpipe) can so run on several devices, each with
// its own versions, promotions and rollbacks. Here, the hub only decides and records:
//   apply     assigns the version to its device, alongside (tier 1: nothing serves from it);
//   switch    after the promotion at its tier, assigns it live;
//   rollback  assigns the kept version live again (one step: the device still has it);
//   status    what each device last reported in its heartbeat.
// The device's runtime agent reads the assignment in its heartbeat answer and asks its boot agent for
// the five verbs; the boot agent fetches the manifest this driver signs (for that device and its
// platform) and the files it pins. Nothing reaches a device that wasn't assigned to it.
//
// Refused for a device, in words: an image-only service (containers on devices come with the K3s
// driver, M10j; and never on macOS or Windows); a service with secrets (no credential goes to a spoke:
// the vault broker isn't built, owner decision Q5); a program fetched from the web (the hub serves
// only a file: artifact it has checked: Nova downloads no program in this build); a capture service
// other than Screenpipe (the one capture adapter the device agent reads); a placement on more than one
// device (floating copies on several devices come later).
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { CoreError } from '../errors.ts';
import type { Db } from '../db.ts';
import type { Log } from '../log.ts';
import { sha256Hex, workloadManifestMessage, type SignedWorkload, type WorkloadManifest } from '../mesh/wire.ts';
import { isCaptureService, programName, promotionTier, type ServiceDefinition } from './definition.ts';
import type { Outcome, Plan, Say, ServiceDriver, ServiceStatus, VersionStatus, VersionView } from './driver.ts';
import { devicePlatform, resolvePlacement, wantedRoles, type PlacementDevice } from './placement.ts';
import { SCREENPIPE } from './screenpipe.ts';

export interface DeviceWorkloadsOptions {
  db: Db;
  log: Log;
  now: () => Date;
  // The hub's own key signs every manifest; devices pin it (trust.ts bundleKeys).
  sign: (message: Buffer) => string;
  publicKey: () => string;
  epoch: () => number;
  hubId: () => string;
  devices: () => PlacementDevice[];
}

export interface Assignment { service: string; version: string; want: 'alongside' | 'live' | 'stopped'; previous: string | null; alongside: string; capture: boolean; assigned_at: string }
interface Row { device_id: string; service: string; version: string; want: Assignment['want']; previous: string | null; definition: string; previous_definition: string | null; assigned_at: string; updated_at: string }
interface ReportRow { device_id: string; service: string; version: string; status: VersionStatus; health: number | null; since: string; said: string | null; at: string }

const STATUSES: readonly string[] = ['installed', 'alongside', 'ready', 'live', 'kept', 'failed', 'rolled_back'];
// The capture kinds a capture permission gives (what the device offers as sources, off).
const KINDS_OF: Record<string, string> = { 'screen-recording': 'screen', microphone: 'audio' };
const MAX_FILE_BYTES = 256 * 1024 * 1024;

export class DeviceWorkloads {
  #o: DeviceWorkloadsOptions;
  #files = new Map<string, Buffer>();
  #drivers = new Map<string, ServiceDriver>();

  constructor(o: DeviceWorkloadsOptions) {
    this.#o = o;
  }

  // The driver for one device: what a Service Manager for that device uses.
  driver(deviceId: string): ServiceDriver {
    let d = this.#drivers.get(deviceId);
    if (d) return d;
    d = {
      name: 'device',
      available: () => ({ ok: true, said: 'Native workloads run on your paired computers, by their device agents.' }),
      plan: (def) => this.#plan(deviceId, def),
      apply: (def, say) => this.#apply(deviceId, def, say),
      status: (service) => this.status(service, deviceId),
      switch: (service, version, say) => this.#switch(deviceId, service, version, say),
      rollback: (service, o, say) => this.#rollback(deviceId, service, o, say),
    };
    this.#drivers.set(deviceId, d);
    return d;
  }

  // Which device a definition's placement resolves to (one, not the hub), or why none.
  where(def: ServiceDefinition): { device: PlacementDevice | null; refused: string[] } {
    return this.#target(def, null);
  }

  // Where it goes, and every reason it can't, for a device other than the hub.
  #target(def: ServiceDefinition, scope: string | null): { device: PlacementDevice | null; refused: string[] } {
    const devices = this.#o.devices();
    const r = resolvePlacement(def, devices, { hubId: this.#o.hubId(), now: this.#o.now(), current: scope && this.#row(scope, def.service) ? scope : null });
    if (!r.ok) return { device: null, refused: [r.why] };
    if (r.devices.length !== 1) return { device: null, refused: ['It would run on several devices. Copies on several devices come later; place it on one (pinned or preferred).'] };
    const d = devices.find((x) => x.id === r.devices[0]!.id)!;
    if (d.id === this.#o.hubId()) return { device: null, refused: ['It would run on the hub. The hub runs its services under its supervisor (the nova services command), not as a device workload.'] };
    if (scope && d.id !== scope) return { device: null, refused: [`It resolves to ${d.name}, not to the device this was asked of.`] };
    return { device: d, refused: this.#refusals(def, d) };
  }

  #refusals(def: ServiceDefinition, d: PlacementDevice): string[] {
    const out: string[] = [];
    const plat = devicePlatform(d);
    const prog = plat ? def.artifact.program?.[plat] : undefined;
    if (!def.artifact.program) out.push(def.artifact.image ? `It comes only as a container image. Containers run only on Linux, and on devices only with the K3s driver, which isn’t built yet (M10j); ${d.name} runs native programs.` : 'It has no program to run.');
    else if (!plat) out.push(`${d.name} hasn’t said which system it runs, so Nova can’t pick its program.`);
    else if (!prog) out.push(`It has no program for ${d.name}, which is ${plat}.`);
    else if (!prog.url.startsWith('file://')) out.push('Its program is at a web address. In this build the hub serves only a program from a file on this computer that it has checked; Nova downloads no program.');
    if (def.secrets.length) out.push(`It needs secrets (${def.secrets.join(', ')}). No credential goes to another device yet: that needs the vault broker, which isn’t built. Run it on the hub instead.`);
    if (isCaptureService(def) && def.service !== SCREENPIPE) out.push('It captures, and the device agent reads capture only from Screenpipe in this build.');
    if (def.alongside === 'copy') out.push('alongside “copy” runs a new version on a copy of its state, which a device doesn’t do: use full, shadow or none.');
    if (isCaptureService(def) && def.alongside !== 'none') out.push('It captures, so it can’t run next to its live version: alongside must be none until two copies are shown to run side by side on that system.');
    return out;
  }

  #plan(scope: string, def: ServiceDefinition): Plan {
    const t = this.#target(def, scope);
    const where = t.device ? `${t.device.name} (${devicePlatform(t.device) ?? t.device.platform})` : 'nowhere';
    const plat = t.device ? devicePlatform(t.device) : null;
    const prog = plat ? def.artifact.program?.[plat] : undefined;
    const base: Plan = { driver: 'device', service: def.service, version: def.version, tier: promotionTier(def), ok: false, refused: t.refused, where, steps: [] };
    if (!t.device || t.refused.length || !prog) return base;
    return {
      ...base, ok: true,
      command: prog.command,
      steps: [
        { step: 'install', said: `${t.device.name}’s device agent fetches the manifest the hub signs for it, then ${programName(prog.url)}, and checks its SHA-256 (${prog.sha256.slice(0, 12)}…) before it keeps anything.` },
        { step: 'alongside', said: def.alongside === 'none' ? 'It can’t run next to the live version, so it starts only at the switch; the version before it is kept for one step back.' : `It starts ${def.alongside === 'shadow' ? 'as a shadow (its output thrown away)' : 'alongside'} on a port of its own, with no traffic.` },
        { step: 'health', said: `Its health check (${def.health.http}) passes three times in a row on that device.` },
        { step: 'approval', said: `Promoting it is tier ${promotionTier(def)}${isCaptureService(def) ? ': it captures, so it is confirmed every time. Deploying it doesn’t turn capture on.' : '.'}` },
        { step: 'switch', said: 'The device switches to it, checks its health, and goes back to the kept version by itself if it fails.' },
      ],
    };
  }

  async #apply(scope: string, def: ServiceDefinition, say: Say = () => {}): Promise<Outcome> {
    const p = this.#plan(scope, def);
    if (!p.ok) return { ok: false, said: `It can’t go to a device: ${p.refused.join(' ')}` };
    const d = this.#target(def, scope).device!;
    // The program must be there and as pinned before any device is told about it.
    const plat = devicePlatform(d)!;
    try { this.#file(def, plat); } catch (e) { return { ok: false, said: (e as Error).message }; }
    const at = this.#o.now().toISOString();
    const row = this.#row(d.id, def.service);
    this.#o.db.tx(() => {
      if (row) this.#o.db.run(`UPDATE device_workload SET version = ?, want = 'alongside', definition = ?, assigned_at = ?, updated_at = ? WHERE device_id = ? AND service = ?`, def.version, JSON.stringify(def), at, at, d.id, def.service);
      else this.#o.db.run(`INSERT INTO device_workload (device_id, service, version, want, previous, definition, previous_definition, assigned_at, updated_at) VALUES (?, ?, ?, 'alongside', NULL, ?, NULL, ?, ?)`, d.id, def.service, def.version, JSON.stringify(def), at, at);
      // A version already live there stays live; the new one is deployed alongside it.
      if (row && row.want === 'live' && row.version !== def.version) this.#o.db.run('UPDATE device_workload SET previous = ?, previous_definition = ? WHERE device_id = ? AND service = ?', row.version, row.definition, d.id, def.service);
    });
    this.#event(d.id, def.service, def.version, 'assigned', `Sent to ${d.name} to install${def.alongside === 'none' ? '' : ' and start alongside'}.`);
    const said = `Sent ${def.service} ${def.version} to ${d.name}: its device agent installs it, checks it, and reports. Nothing takes traffic until you promote it${isCaptureService(def) ? ', and capture stays off until you turn on one of its sources' : ''}.`;
    say(said);
    return { ok: true, said };
  }

  async #switch(deviceId: string, service: string, version: string, say: Say = () => {}): Promise<Outcome> {
    const row = this.#row(deviceId, service);
    if (!row) return { ok: false, said: `${service} isn’t assigned to ${this.#name(deviceId)}.` };
    const def = JSON.parse(row.definition) as ServiceDefinition;
    if (row.version !== version) return { ok: false, said: `${version} isn’t the version deployed to that device (${row.version} is).` };
    // The version kept for one step back: the one live before this (recorded when this one was sent).
    const prev = row.previous && row.previous !== version ? row.previous : null;
    const prevDef = prev ? row.previous_definition : null;
    const at = this.#o.now().toISOString();
    this.#o.db.run(`UPDATE device_workload SET want = 'live', previous = ?, previous_definition = ?, assigned_at = ?, updated_at = ? WHERE device_id = ? AND service = ?`, prev, prevDef, at, at, row.device_id, service);
    const name = this.#name(row.device_id);
    this.#event(row.device_id, service, version, 'promoted', `Promoted: ${name} switches to it and checks its health${prev ? `; ${prev} is kept for one step back` : ''}.`);
    const said = `Promoted ${service} ${version}: ${name} switches to it and checks its health, and goes back to ${prev ?? 'nothing'} by itself if it fails.${isCaptureService(def) ? ' Capture stays as you set it: promoting doesn’t turn it on.' : ''}`;
    say(said);
    return { ok: true, said };
  }

  async #rollback(deviceId: string, service: string, o: { auto: boolean; reason: string }, say: Say = () => {}): Promise<Outcome> {
    const row = this.#row(deviceId, service);
    if (!row || !row.previous) return { ok: false, said: `${service} has no previous version kept on its device to go back to.` };
    const at = this.#o.now().toISOString();
    const to = row.previous;
    this.#o.db.run(`UPDATE device_workload SET version = ?, definition = ?, want = 'live', previous = ?, previous_definition = ?, assigned_at = ?, updated_at = ? WHERE device_id = ? AND service = ?`,
      to, row.previous_definition ?? row.definition, row.version, row.definition, at, at, row.device_id, service);
    const said = `Going back to ${service} ${to} on ${this.#name(row.device_id)}: ${o.reason} It is kept there, so nothing is downloaded.`;
    this.#event(row.device_id, service, to, o.auto ? 'rolled_back' : 'rollback', said);
    say(said);
    return { ok: true, said };
  }

  // Per device and service; `device` on each says where.
  status(service?: string, deviceId?: string): (ServiceStatus & { device: { id: string; name: string } })[] {
    const where = [service ? 'service = ?' : null, deviceId ? 'device_id = ?' : null].filter(Boolean);
    const rows = this.#o.db.all<Row>(`SELECT * FROM device_workload${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY service, device_id`, ...(service ? [service] : []), ...(deviceId ? [deviceId] : []));
    return rows.map((row) => {
      const reports = this.#o.db.all<ReportRow>('SELECT * FROM device_workload_report WHERE device_id = ? AND service = ? ORDER BY since', row.device_id, row.service);
      const live = reports.find((r) => r.status === 'live') ?? null;
      const versions: VersionView[] = reports.map((r) => ({ version: r.version, status: r.status, since: r.since, said: r.said, ports: null, pid: null }));
      if (!reports.some((r) => r.version === row.version)) versions.push({ version: row.version, status: 'installed', since: row.assigned_at, said: `Sent to ${this.#name(row.device_id)}; it hasn’t reported yet.`, ports: null, pid: null });
      const history = this.#o.db.all<{ at: string; version: string; outcome: string; said: string | null }>('SELECT at, version, outcome, said FROM device_workload_event WHERE device_id = ? AND service = ? ORDER BY seq DESC LIMIT 30', row.device_id, row.service);
      return {
        service: row.service, driver: 'device', device: { id: row.device_id, name: this.#name(row.device_id) },
        live: live?.version ?? null, previous: row.previous, soak_until: null, held: null,
        health: { ok: live ? (live.health === null ? null : live.health === 1) : null, checked_at: live?.at ?? null, said: live?.said ?? null },
        stable: {}, versions, history: history.map((h) => ({ at: h.at, version: h.version, outcome: h.outcome, said: h.said ?? '' })),
      };
    });
  }

  // ---- what the mesh routes ask --------------------------------------------------------------------

  // For this device's heartbeat answer: what it is assigned, and nothing about any other device.
  assignments(deviceId: string): Assignment[] {
    return this.#o.db.all<Row>('SELECT * FROM device_workload WHERE device_id = ? ORDER BY service', deviceId).map((r) => {
      const def = JSON.parse(r.definition) as ServiceDefinition;
      return { service: r.service, version: r.version, want: r.want, previous: r.previous, alongside: def.alongside, capture: isCaptureService(def), assigned_at: r.assigned_at };
    });
  }

  // The signed manifest for one of this device's own versions (the assigned one, or the one kept).
  manifest(deviceId: string, service: string, version: string): SignedWorkload {
    const { def, device } = this.#assigned(deviceId, service, version);
    const plat = devicePlatform(device);
    const prog = plat ? def.artifact.program?.[plat] : undefined;
    if (!plat || !prog) throw new CoreError('not_found', `There is no program of ${service} ${version} for this device’s system.`);
    const name = programName(prog.url)!;
    const manifest: WorkloadManifest = {
      v: 1, service, version, device_id: deviceId, platform: plat, files: { [name]: prog.sha256 }, command: [...prog.command],
      ports: def.ports.map((p) => ({ name: p.name, port: p.port })), health: { ...def.health }, alongside: def.alongside, roles: wantedRoles(def.placement),
      capture: isCaptureService(def) ? { adapter: 'screenpipe', kinds: [...new Set(def.os_permissions.map((p) => KINDS_OF[p]).filter((k): k is string => !!k))] } : null,
      os_permissions: [...def.os_permissions], epoch: this.#o.epoch(), issued_at: this.#o.now().toISOString(),
    };
    return { manifest, signature: this.#o.sign(workloadManifestMessage(manifest)), signer: this.#o.publicKey() };
  }

  // A file the manifest pins, exactly as it was published (never changed or signed again by Nova).
  file(deviceId: string, service: string, version: string, name: string): Buffer {
    const { def, device } = this.#assigned(deviceId, service, version);
    const plat = devicePlatform(device);
    const prog = plat ? def.artifact.program?.[plat] : undefined;
    if (!plat || !prog || programName(prog.url) !== name) throw new CoreError('not_found', `${name} isn’t a file of ${service} ${version} for this device.`);
    return this.#file(def, plat);
  }

  // A heartbeat's `workloads`: what the device says happened. Kept per version; a change is recorded.
  // A version that failed after its switch and went back by itself is said as a problem (tier 1).
  report(deviceId: string, input: unknown): void {
    if (input === undefined) return;
    if (!Array.isArray(input) || input.length > 64) throw new CoreError('validation', 'workloads is a list of up to 64 reports.');
    const at = this.#o.now().toISOString();
    for (const x of input) {
      if (!x || typeof x !== 'object') continue;
      const r = x as Record<string, unknown>;
      if (typeof r.service !== 'string' || !/^[a-z][a-z0-9-]{0,52}$/.test(r.service) || typeof r.version !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(r.version) || !STATUSES.includes(r.status as string)) continue;
      const row = this.#row(deviceId, r.service);
      // Only for what this device was assigned: a device can't make up a service.
      if (!row || (r.version !== row.version && r.version !== row.previous && !this.#o.db.get('SELECT 1 FROM device_workload_report WHERE device_id = ? AND service = ? AND version = ?', deviceId, r.service, r.version))) continue;
      const said = typeof r.said === 'string' ? r.said.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 300) : null;
      const since = typeof r.since === 'string' && !Number.isNaN(Date.parse(r.since)) ? new Date(r.since).toISOString() : at;
      const health = r.health === true ? 1 : r.health === false ? 0 : null;
      const before = this.#o.db.get<ReportRow>('SELECT * FROM device_workload_report WHERE device_id = ? AND service = ? AND version = ?', deviceId, r.service, r.version);
      this.#o.db.run(`INSERT INTO device_workload_report (device_id, service, version, status, health, since, said, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (device_id, service, version) DO UPDATE SET status = excluded.status, health = excluded.health, since = excluded.since, said = excluded.said, at = excluded.at`,
        deviceId, r.service, r.version, String(r.status), health, since, said, at);
      if (before?.status === r.status) continue;
      this.#event(deviceId, r.service, r.version, String(r.status), said ?? '');
      if (r.status === 'rolled_back' && row.version === r.version && row.want === 'live') {
        // The device went back by itself: the assignment follows it, so it isn't asked again.
        this.#o.db.run(`UPDATE device_workload SET version = ?, definition = ?, previous = NULL, previous_definition = NULL, updated_at = ? WHERE device_id = ? AND service = ?`,
          row.previous ?? row.version, row.previous_definition ?? row.definition, at, deviceId, r.service);
        this.#o.log.problem('services', `${r.service} ${r.version} failed its health on ${this.#name(deviceId)} after it was switched to, so the device went back to ${row.previous ?? 'the version before'} by itself. ${said ?? ''}`.trim());
      }
    }
  }

  // The workloads on this device that need one of these roles: what narrowing its roles would stop.
  needing(deviceId: string, removed: readonly string[]): string[] {
    return this.#o.db.all<Row>(`SELECT * FROM device_workload WHERE device_id = ? AND want != 'stopped'`, deviceId)
      .filter((r) => wantedRoles((JSON.parse(r.definition) as ServiceDefinition).placement).some((x) => removed.includes(x))).map((r) => r.service);
  }

  // Its roles were narrowed: what they no longer allow is assigned stopped, and the record says so.
  narrowed(deviceId: string, purposes: readonly string[]): void {
    const at = this.#o.now().toISOString();
    for (const r of this.#o.db.all<Row>(`SELECT * FROM device_workload WHERE device_id = ? AND want != 'stopped'`, deviceId)) {
      const need = wantedRoles((JSON.parse(r.definition) as ServiceDefinition).placement);
      if (need.every((x) => purposes.includes(x))) continue;
      this.#o.db.run(`UPDATE device_workload SET want = 'stopped', assigned_at = ?, updated_at = ? WHERE device_id = ? AND service = ?`, at, at, deviceId, r.service);
      this.#event(deviceId, r.service, r.version, 'stopped', `Stopped: ${this.#name(deviceId)} no longer has the ${need.filter((x) => !purposes.includes(x)).join(', ')} role it needs.`);
    }
  }

  // ---- internals -------------------------------------------------------------------------------------

  #assigned(deviceId: string, service: string, version: string): { def: ServiceDefinition; device: PlacementDevice } {
    const row = this.#row(deviceId, service);
    const device = this.#o.devices().find((d) => d.id === deviceId);
    if (!row || !device || device.trust !== 'trusted') throw new CoreError('not_found', `${service} isn’t assigned to this device.`);
    const def = this.#definitionOf(row, version);
    if (!def) throw new CoreError('not_found', `${service} ${version} isn’t assigned to this device.`);
    return { def: JSON.parse(def) as ServiceDefinition, device };
  }

  #definitionOf(row: Row, version: string): string | null {
    if (row.version === version) return row.definition;
    if (row.previous === version) return row.previous_definition;
    return null;
  }

  // The program's bytes from its file: address, checked against the pinned SHA-256 each time it is
  // read, cached by that hash.
  #file(def: ServiceDefinition, plat: string): Buffer {
    const prog = def.artifact.program?.[plat];
    if (!prog || !prog.url.startsWith('file://')) throw new CoreError('validation', 'Its program isn’t a file on this computer.');
    const cached = this.#files.get(prog.sha256);
    if (cached) return cached;
    let bytes: Buffer;
    try { bytes = readFileSync(fileURLToPath(prog.url)); } catch (e) { throw new CoreError('not_found', `Its program can’t be read at ${prog.url}: ${(e as NodeJS.ErrnoException).code ?? (e as Error).message}.`); }
    if (bytes.length > MAX_FILE_BYTES) throw new CoreError('validation', `Its program is larger than ${MAX_FILE_BYTES / 1024 / 1024} MB.`);
    const sha = sha256Hex(bytes);
    if (sha !== prog.sha256) throw new CoreError('validation', `Its program’s SHA-256 is ${sha.slice(0, 12)}…, not the ${prog.sha256.slice(0, 12)}… its definition pins, so it isn’t sent to any device.`);
    this.#files.set(sha, bytes);
    return bytes;
  }

  #row(deviceId: string, service: string): Row | null {
    return this.#o.db.get<Row>('SELECT * FROM device_workload WHERE device_id = ? AND service = ?', deviceId, service) ?? null;
  }
  #name(id: string): string {
    return this.#o.devices().find((d) => d.id === id)?.name ?? id;
  }
  #event(deviceId: string, service: string, version: string, outcome: string, said: string): void {
    this.#o.db.run('INSERT INTO device_workload_event (device_id, service, version, outcome, said, at) VALUES (?, ?, ?, ?, ?, ?)', deviceId, service, version, outcome, said.slice(0, 400), this.#o.now().toISOString());
  }
}
