// The placement resolver (docs/plans/M10-orchestration.md, Point 5; docs/plans/M10f.md §2): from a
// definition's placement to the device or devices it runs on, using each device's roles (Point 9),
// its hardware (the heartbeat's `device_hardware`) and its health (heard from within the Online
// window). Pure: it reads what it is given and decides; nothing here deploys anything. Nothing is
// deployed to other devices before native workloads (M10h): a caller that gets a device other than
// the hub says so.
//
//   pinned      that device only. Down, the service is down, and the resolution says so.
//   preferred   the best eligible, healthy device; a placed service stays while its device is
//               healthy or has been unhealthy for less than the failover window, then moves to the
//               failover target (a named device, or `any`: the next best).
//   floating    stateless only (the validator refuses state): one instance on each of up to
//               `replicas` healthy eligible devices, the best first.
import { WORKLOAD_PURPOSES } from '../mesh/purposes.ts';
import { notLinux, type Placement, type ServiceDefinition } from './definition.ts';

export interface PlacementHardware {
  ram_bytes: number;
  gpus: { vram_bytes: number; unified: boolean }[];
  disk: { free_bytes: number } | null;
  platform?: string;
  arch?: string;
}

export interface PlacementDevice {
  id: string;
  name: string;
  kind: string;
  // The mesh role: hub, standby, spoke or client.
  role: string;
  platform: string;
  purposes: readonly string[];
  trust: 'trusted' | 'revoked';
  // Null until the device has reported it (phones and browsers never do).
  hardware: PlacementHardware | null;
  // Heard from within the Online window (the hub always is).
  healthy: boolean;
  // When it was last heard from, to tell how long it has been unhealthy.
  last_seen: string | null;
}

export interface Considered { id: string; name: string; eligible: boolean; healthy: boolean; why: string }

export type Resolution =
  | { ok: true; mode: Placement['mode']; devices: { id: string; name: string }[]; moved: boolean; why: string; considered: Considered[] }
  | { ok: false; mode: Placement['mode'] | null; down: boolean; why: string; considered: Considered[] };

export interface ResolveOptions {
  now?: Date;
  // How long a preferred service's device may be unhealthy before the service moves (default 5 min).
  failoverAfterMs?: number;
  // Where it runs now, if anywhere: a preferred service's device, or a floating service's devices.
  current?: string | readonly string[] | null;
  // The hub's id, so a definition may say `hub` for it.
  hubId?: string | null;
}

export const FAILOVER_AFTER_MS = 5 * 60_000;
// What `needs` may ask for. Anything else is refused by name: Nova can't check it.
export const NEEDS = Object.freeze(['gpu_vram_gb', 'memory_gb', 'disk_gb'] as const);
const GB = 1024 ** 3;

type Def = Pick<ServiceDefinition, 'placement' | 'artifact' | 'resources'> & Partial<Pick<ServiceDefinition, 'service'>>;

// The roles a definition asks for: its own, or general server.
export const wantedRoles = (p: Placement): string[] => (p.roles?.length ? [...p.roles] : ['general-server']);

// GPU memory a device can give a model: a card's own, or for unified memory (Apple), about three
// quarters of the machine's (macOS keeps the rest for itself by default).
function gpuMemory(h: PlacementHardware): number {
  return Math.max(0, ...h.gpus.map((g) => (g.unified ? Math.floor(h.ram_bytes * 0.75) : g.vram_bytes)));
}

// This device's platform key as a definition names it (`linux-x64`), when it can be told.
export function devicePlatform(d: Pick<PlacementDevice, 'platform' | 'hardware'>): string | null {
  const os = (d.hardware?.platform ?? d.platform.split(/\s+/)[0] ?? '').toLowerCase();
  const arch = (d.hardware?.arch ?? d.platform.split(/\s+/)[1] ?? '').toLowerCase();
  const o = /^(linux|darwin|win32)$/.test(os) ? os : null;
  const a = /^(x64|arm64)$/.test(arch) ? arch : null;
  return o && a ? `${o}-${a}` : null;
}

// Why this device can't take the service, or null when it can (health aside).
export function ineligible(def: Def, d: PlacementDevice): string | null {
  if (d.trust !== 'trusted') return `${d.name} was revoked.`;
  if (d.kind === 'phone' || d.kind === 'browser') return `${d.name} is a ${d.kind}: a thin client, which never receives workloads.`;
  const work = d.purposes.filter((p) => (WORKLOAD_PURPOSES as readonly string[]).includes(p));
  if (!work.length) return d.purposes.includes('thin-client') ? `${d.name} is a thin client, which never receives workloads.` : `${d.name} has no workload role yet, so nothing runs there until you give it one in Settings › Devices.`;
  const missing = wantedRoles(def.placement).filter((r) => !d.purposes.includes(r));
  if (missing.length) return `${d.name} isn’t ${missing.map((r) => r.replace('-', ' ')).join(' or ')}.`;
  const needs = def.placement.needs ?? {};
  const unknown = Object.keys(needs).filter((k) => !(NEEDS as readonly string[]).includes(k));
  if (unknown.length) return `Nova can’t check ${unknown.join(', ')} on any device (it checks ${NEEDS.join(', ')}).`;
  const mem = def.resources?.memory_mb;
  if (Object.keys(needs).length || mem !== undefined) {
    const h = d.hardware;
    if (!h) return `${d.name} hasn’t reported its hardware yet, so Nova can’t tell whether it fits.`;
    if (needs.gpu_vram_gb !== undefined && gpuMemory(h) < needs.gpu_vram_gb * GB) return `${d.name} has ${(gpuMemory(h) / GB).toFixed(0)} GB of GPU memory; it needs ${needs.gpu_vram_gb} GB.`;
    if (needs.memory_gb !== undefined && h.ram_bytes < needs.memory_gb * GB) return `${d.name} has ${(h.ram_bytes / GB).toFixed(0)} GB of memory; it needs ${needs.memory_gb} GB.`;
    if (mem !== undefined && h.ram_bytes < mem * 1024 * 1024) return `${d.name} has ${(h.ram_bytes / GB).toFixed(0)} GB of memory; it needs ${mem} MB.`;
    if (needs.disk_gb !== undefined && (h.disk?.free_bytes ?? 0) < needs.disk_gb * GB) return `${d.name} has ${((h.disk?.free_bytes ?? 0) / GB).toFixed(0)} GB free; it needs ${needs.disk_gb} GB.`;
  }
  const art = def.artifact;
  const plat = devicePlatform(d);
  if (art.program) {
    if (plat && !art.program[plat]) {
      if (!art.image) return `${d.name} is ${plat}, and there is no program for it.`;
      if (notLinux(plat)) return `${d.name} is ${plat}: it has no program for it, and containers run only on Linux.`;
    }
  } else if (art.image && notLinux(plat ?? d.platform)) return `${d.name} is ${plat ?? d.platform}: this service comes only as a container image, and containers run only on Linux.`;
  return null;
}

// Best first: most GPU memory when GPU memory is needed, otherwise most memory; then by name.
function rank(def: Def, a: PlacementDevice, b: PlacementDevice): number {
  const gpu = def.placement.needs?.gpu_vram_gb !== undefined;
  const score = (d: PlacementDevice) => (d.hardware ? (gpu ? gpuMemory(d.hardware) : d.hardware.ram_bytes) : 0);
  return score(b) - score(a) || a.name.localeCompare(b.name) || a.id.localeCompare(b.id);
}

export function resolvePlacement(def: Def, devices: readonly PlacementDevice[], o: ResolveOptions = {}): Resolution {
  const now = (o.now ?? new Date()).getTime();
  const window = o.failoverAfterMs ?? FAILOVER_AFTER_MS;
  const p = def.placement;
  const considered: Considered[] = devices.map((d) => {
    const why = ineligible(def, d);
    return { id: d.id, name: d.name, eligible: !why, healthy: d.healthy, why: why ?? (d.healthy ? `${d.name} can take it.` : `${d.name} can take it, but isn’t answering now.`) };
  });
  const byId = new Map(devices.map((d) => [d.id, d]));
  const okOf = (id: string) => considered.find((c) => c.id === id)!;
  const pick = (d: PlacementDevice) => ({ id: d.id, name: d.name });
  const eligible = devices.filter((d) => okOf(d.id).eligible).sort((a, b) => rank(def, a, b));
  const healthy = eligible.filter((d) => d.healthy);
  const noWhere = (): Resolution => ({
    ok: false, mode: p.mode, down: false, considered,
    why: `No device may run it: ${considered.map((c) => c.why).join(' ') || 'there are no devices.'}`,
  });
  const resolveId = (id: string | undefined) => (id === 'hub' && o.hubId ? o.hubId : id);

  if (p.mode === 'pinned') {
    const d = byId.get(resolveId(p.device) ?? '');
    if (!d) return { ok: false, mode: 'pinned', down: false, considered, why: `It is pinned to ${p.device}, and there is no such device.` };
    const c = okOf(d.id);
    if (!c.eligible) return { ok: false, mode: 'pinned', down: false, considered, why: `It is pinned to ${d.name}, which can’t take it: ${c.why}` };
    if (!d.healthy) return { ok: false, mode: 'pinned', down: true, considered, why: `It is pinned to ${d.name}, which isn’t answering, so the service is down until ${d.name} is back.` };
    return { ok: true, mode: 'pinned', devices: [pick(d)], moved: false, considered, why: `Pinned to ${d.name}.` };
  }

  // A device that was answering within the window still counts (one late heartbeat moves nothing).
  const within = (d: PlacementDevice) => d.healthy || now - (d.last_seen ? Date.parse(d.last_seen) : 0) < window;

  if (p.mode === 'preferred') {
    const curId = typeof o.current === 'string' ? o.current : null;
    const cur = curId ? byId.get(curId) : undefined;
    // Why it leaves where it runs, said as it is: gone, no longer allowed, or silent too long.
    let left: string | null = null;
    if (curId) {
      if (!cur) left = `${curId} is no longer one of your devices`;
      else if (!okOf(cur.id).eligible) left = `${cur.name} can no longer take it: ${okOf(cur.id).why.replace(/\.$/, '')}`;
      else if (cur.healthy) return { ok: true, mode: 'preferred', devices: [pick(cur)], moved: false, considered, why: `It stays on ${cur.name}, which is answering.` };
      else {
        const since = cur.last_seen ? Date.parse(cur.last_seen) : 0;
        if (now - since < window) return { ok: true, mode: 'preferred', devices: [pick(cur)], moved: false, considered, why: `It stays on ${cur.name} for now: it hasn’t answered for ${Math.round((now - since) / 1000)} s, less than the ${Math.round(window / 1000)} s Nova waits before moving it.` };
        left = `${cur.name} hasn’t answered for longer than ${Math.round(window / 1000)} s`;
      }
    }
    const target = curId ? failoverTarget(p, healthy.filter((d) => d.id !== curId), byId, okOf, resolveId) : healthy[0] ?? null;
    if (target && 'why' in target) return { ok: false, mode: 'preferred', down: true, considered, why: target.why };
    if (target) {
      const moved = !!curId && target.id !== curId;
      return {
        ok: true, mode: 'preferred', devices: [pick(target)], moved, considered,
        why: moved ? `${left}, so it moves to ${target.name}, its failover.` : `${target.name} is the best device that may run it.`,
      };
    }
    if (!eligible.length) return noWhere();
    return { ok: false, mode: 'preferred', down: true, considered, why: `The devices that may run it (${eligible.map((d) => d.name).join(', ')}) aren’t answering, so it is down until one is back.` };
  }

  // Floating: as many eligible devices as replicas asks for. Where its copies run now, they stay
  // while their device answered within the window; the rest go to the best healthy devices.
  const want = p.replicas ?? 1;
  if (!eligible.length) return noWhere();
  const now_ = new Set(Array.isArray(o.current) ? o.current : typeof o.current === 'string' ? [o.current] : []);
  const kept = eligible.filter((d) => now_.has(d.id) && within(d)).slice(0, want);
  const chosen = [...kept, ...healthy.filter((d) => !kept.includes(d))].slice(0, want);
  if (!chosen.length) return { ok: false, mode: 'floating', down: true, considered, why: `The devices that may run it (${eligible.map((d) => d.name).join(', ')}) aren’t answering.` };
  const moved = [...now_].some((id) => !chosen.some((d) => d.id === id));
  return {
    ok: true, mode: 'floating', devices: chosen.map(pick), moved, considered,
    why: chosen.length < want ? `It asks for ${want} copies; only ${chosen.length} device${chosen.length === 1 ? ' is' : 's are'} eligible and answering: ${chosen.map((d) => d.name).join(', ')}.` : `One copy each on ${chosen.map((d) => d.name).join(', ')}.`,
  };
}

// Where a preferred service goes when its device has been down past the window: a named failover
// (which must be eligible and answering), or `any`, the next best. Absent failover means `any`.
function failoverTarget(
  p: Placement, others: PlacementDevice[], byId: Map<string, PlacementDevice>, okOf: (id: string) => Considered, resolveId: (id: string | undefined) => string | undefined,
): PlacementDevice | { why: string } | null {
  if (!p.failover || p.failover === 'any') return others[0] ?? null;
  const f = byId.get(resolveId(p.failover) ?? '');
  if (!f) return { why: `Its failover is ${p.failover}, and there is no such device, so it is down.` };
  const c = okOf(f.id);
  if (!c.eligible) return { why: `Its failover, ${f.name}, can’t take it: ${c.why}` };
  if (!f.healthy) return { why: `Its failover, ${f.name}, isn’t answering either, so it is down.` };
  return f;
}
