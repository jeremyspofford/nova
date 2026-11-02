// Pure input for the repository-owned nova-service chart. No cluster/process or credential access.
import { createHash } from 'node:crypto';
import { validate, type PlacementMode, type Port, type ServiceDefinition } from '../definition.ts';
import { wantedRoles, type Resolution } from '../placement.ts';

export interface K3sChartContext {
  namespace: string;
  hubId: string;
  live: string | null;
  kept: readonly string[];
  replicas?: Readonly<Record<string, number>>;
  placements?: Readonly<Record<string, Resolution>>;
}
export interface K3sSelector { 'nova/service': string; 'nova/version': string }
export interface K3sNodeExpression { key: string; operator: 'Gt' | 'In'; values: string[] }
export interface K3sVersionValues {
  identity: string;
  name: string;
  previewName: string;
  networkPolicyName: string;
  selector: K3sSelector;
  replicas: number;
  strategy: { type: 'Recreate' | 'RollingUpdate' };
  image: { repository: string; digest: string };
  ports: Port[];
  probe: { httpGet: { path: string; port: string; scheme: 'HTTP' }; periodSeconds: number };
  placement: { mode: PlacementMode; device: string | null; roles: string[]; needs: Record<string, number>; failover: string | null; allowedDevices: string[] };
  nodeSelector: Record<string, string>;
  requiredNodeExpressions: K3sNodeExpression[];
  preferredNodeExpressions: K3sNodeExpression[];
  spread: boolean;
  resources: { requests: { memory?: string }; limits: { memory?: string } };
  state: { claimName: string; volume: string; sizeGi: number; mountPath: '/var/lib/nova/state' } | null;
  secretRefs: { reference: string; name: string }[];
  alongside: 'full' | 'none';
  egress: 'none' | 'internet';
  soakSeconds: number | null;
}
export interface K3sChartValues {
  namespace: string;
  service: { identity: string; name: string; selector: string; ports: Port[] };
  live: string | null;
  stableSelector: K3sSelector;
  versions: K3sVersionValues[];
}

const DNS = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const PORT = /^[a-z]([a-z0-9]|-[a-z0-9])*$/;
const REPOSITORY = /^(?:[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?(?::[0-9]{1,5})?\/)?[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*(?:\/[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*)*(?::[a-z0-9_][a-z0-9_.-]{0,127})?$/;
const LABEL = /^[A-Za-z0-9](?:[A-Za-z0-9_.-]{0,61}[A-Za-z0-9])?$/;
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) && [null, Object.prototype].includes(Object.getPrototypeOf(value));
// Domain-separated, unambiguous identities, with 160 bits retained even at maximum input length.
const token = (kind: string, ...ids: string[]): string => `${kind}-${createHash('sha256').update(JSON.stringify([kind, ...ids])).digest('hex').slice(0, 40)}`;
export const k3sDeviceLabel = (id: string) => LABEL.test(id) && !/^device-[0-9a-f]{40}$/.test(id) ? id : token('device', id);
const only = (value: unknown, keys: string[]): boolean => object(value) && Object.keys(value).every((key) => keys.includes(key));
function closedDefinition(def: ServiceDefinition): boolean {
  // The shared validator intentionally tolerates some future nested fields. This chart must not
  // silently drop semantics that it doesn't know how to render.
  return only(def.placement, ['mode', 'device', 'roles', 'needs', 'failover', 'replicas']) &&
    only(def.health, ['http', 'every_s']) && def.ports.every((p) => only(p, ['name', 'port'])) &&
    (!def.state || only(def.state, ['volume', 'size_gb'])) &&
    Object.values(def.placement.needs ?? {}).every((n) => Number.isFinite(n) && n <= 1_000_000_000);
}

export function buildK3sValues(definitions: readonly ServiceDefinition[], context: K3sChartContext): K3sChartValues {
  if (!only(context, ['namespace', 'hubId', 'live', 'kept', 'replicas', 'placements']) || typeof context.namespace !== 'string' || !DNS.test(context.namespace) || typeof context.hubId !== 'string' || !context.hubId.length || context.hubId.includes('\0') ||
      !(context.live === null || typeof context.live === 'string') || !Array.isArray(context.kept) || !Array.from(context.kept).every((x) => typeof x === 'string') || new Set(context.kept).size !== context.kept.length ||
      (context.replicas !== undefined && !object(context.replicas)) || (context.placements !== undefined && !object(context.placements))) throw new Error('Invalid K3s chart context.');
  if (!Array.isArray(definitions) || !definitions.length) throw new Error('K3s values need at least one definition.');
  const defs: readonly ServiceDefinition[] = definitions;
  for (const def of defs) {
    const result = validate(def);
    // Don't echo rejected input: even a malformed secret value must stay out of an error message.
    if (!result.ok || !closedDefinition(result.def)) throw new Error('Invalid service definition for the K3s chart.');
  }
  const first = defs[0]!;
  const versions = new Set(defs.map((d) => d.version));
  if (versions.size !== defs.length) throw new Error('Duplicate service versions.');
  if (defs.some((d) => d.service !== first.service)) throw new Error('K3s values describe one service.');
  if (context.live !== null && !versions.has(context.live)) throw new Error('The live version is missing.');
  if (context.kept.some((v) => !versions.has(v))) throw new Error('A kept version is missing.');
  if (context.live !== null && context.kept.includes(context.live)) throw new Error('The live version cannot also be kept.');
  for (const [version, count] of Object.entries(context.replicas ?? {})) {
    if (!versions.has(version) || !Number.isInteger(count) || count < 0 || count > 64) throw new Error('Invalid per-version replica override.');
  }
  for (const version of Object.keys(context.placements ?? {})) if (!versions.has(version)) throw new Error('A resolved placement version is missing.');
  if (defs.some((d) => JSON.stringify(d.ports.map((p) => [p.name, p.port])) !== JSON.stringify(first.ports.map((p) => [p.name, p.port])))) throw new Error('Public ports must agree across retained versions.');
  const serviceSelector = token('selector', first.service);
  const rendered: K3sVersionValues[] = defs.map((def) => {
    const { placement: p } = def;
    if (!def.artifact.image) throw new Error('K3s requires a pinned image; native programs remain native.');
    const at = def.artifact.image.lastIndexOf('@');
    const repository = def.artifact.image.slice(0, at);
    if (repository.length > 255 || !REPOSITORY.test(repository)) throw new Error('The image repository cannot be rendered as a container image.');
    if (def.ports.some((port) => !PORT.test(port.name) || port.name.length > 15 || port.port < 1024)) throw new Error('A port cannot be rendered safely as a Kubernetes named port.');
    if (def.os_permissions.length) throw new Error('OS permissions cannot be rendered safely as a pod.');
    if (def.alongside === 'copy' || def.alongside === 'shadow') throw new Error('K3s cannot provide copy or shadow alongside semantics.');
    if (def.egress === 'local') throw new Error('Local egress needs an explicit network policy capability.');
    const hasResolution = context.placements !== undefined && Object.hasOwn(context.placements, def.version);
    const resolution = hasResolution ? context.placements![def.version] : undefined;
    if (hasResolution && resolution === undefined) throw new Error('A successful resolved placement is required.');
    if (resolution !== undefined && (!object(resolution) || resolution.ok !== true || resolution.mode !== p.mode || !Array.isArray(resolution.devices) || !resolution.devices.length || resolution.devices.length > 64 || Array.from(resolution.devices).some((d) => !object(d) || typeof d.id !== 'string' || !d.id.length || d.id.includes('\0')))) throw new Error('A successful resolved placement is required.');
    if (resolution?.ok && new Set(resolution.devices.map((d) => d.id)).size !== resolution.devices.length) throw new Error('A resolved placement must contain unique devices.');
    if (p.mode === 'pinned' && resolution?.ok && (resolution.devices.length !== 1 || resolution.devices[0]!.id !== (p.device === 'hub' ? context.hubId : p.device))) throw new Error('A resolved pinned placement must match its target.');
    if (p.mode === 'preferred' && (!resolution || !resolution.ok || resolution.devices.length !== 1)) throw new Error('Preferred placement needs one successful resolved device and failover authority.');
    if (p.mode !== 'preferred' && p.failover !== undefined) throw new Error('Failover needs the preferred placement driver authority.');
    if (p.device?.includes('\0')) throw new Error('Invalid placement device identity.');
    if (def.state && (p.mode !== 'pinned' || def.alongside !== 'none')) throw new Error('K3s state requires pinned placement and alongside none (one writer).');
    const isKept = context.kept.includes(def.version);
    const candidateNone = def.alongside === 'none' && context.live !== def.version;
    const override = context.replicas && Object.hasOwn(context.replicas, def.version) ? context.replicas[def.version] : undefined;
    if (isKept && override && override > 0) throw new Error('A kept version must have zero replicas.');
    if (candidateNone && override && override > 0) throw new Error('An alongside none candidate must have zero replicas.');
    const replicas = isKept || candidateNone ? 0 : override ?? p.replicas ?? 1;
    if (p.mode !== 'floating' && replicas > 1) throw new Error('Only floating placement can run multiple replicas.');
    const roles = [...new Set(wantedRoles(p))];
    const nodeSelector: Record<string, string> = { 'kubernetes.io/os': 'linux' };
    for (const role of roles) nodeSelector[`nova/role-${role}`] = 'true';
    const device = p.device === 'hub' ? context.hubId : p.device ?? null;
    if (device !== null) nodeSelector['nova/device'] = k3sDeviceLabel(device);
    const needs = { ...p.needs };
    const allowedDevices = resolution?.ok ? resolution.devices.map((d) => d.id) : [];
    const keys: Record<string, string> = { gpu_vram_gb: 'nova/gpu-vram-gb', memory_gb: 'nova/memory-gb', disk_gb: 'nova/disk-gb' };
    const requiredNodeExpressions: K3sNodeExpression[] = Object.entries(needs).filter(([, n]) => n > 0).map(([k, n]) => ({ key: keys[k]!, operator: 'Gt', values: [String(Math.ceil(n) - 1)] }));
    const preferredNodeExpressions: K3sNodeExpression[] = [];
    if (allowedDevices.length) {
      const boundary: K3sNodeExpression = { key: 'nova/device', operator: 'In', values: allowedDevices.map(k3sDeviceLabel) };
      requiredNodeExpressions.push(boundary);
      if (p.mode === 'preferred') preferredNodeExpressions.push({ ...boundary, values: [...boundary.values] });
    }
    const memory = def.resources?.memory_mb;
    return {
      identity: def.version, name: token('deployment', def.service, def.version), previewName: token('preview', def.service, def.version), networkPolicyName: token('network', def.service, def.version),
      selector: { 'nova/service': serviceSelector, 'nova/version': token('version', def.service, def.version) }, replicas,
      strategy: { type: def.alongside === 'none' || def.state ? 'Recreate' : 'RollingUpdate' },
      image: { repository, digest: def.artifact.image.slice(at + 1) },
      ports: def.ports.map((p) => ({ name: p.name, port: p.port })),
      probe: { httpGet: { path: def.health.http, port: def.ports[0]!.name, scheme: 'HTTP' }, periodSeconds: def.health.every_s },
      placement: { mode: p.mode, device, roles, needs, failover: p.failover ?? null, allowedDevices }, nodeSelector, requiredNodeExpressions, preferredNodeExpressions, spread: p.mode === 'floating',
      resources: { requests: memory === undefined ? {} : { memory: `${memory}Mi` }, limits: memory === undefined ? {} : { memory: `${memory}Mi` } },
      state: def.state ? { claimName: token('pvc', def.service, def.state.volume), volume: def.state.volume, sizeGi: def.state.size_gb ?? 1, mountPath: '/var/lib/nova/state' } : null,
      secretRefs: [...new Set(def.secrets)].map((reference) => ({ reference, name: token('secret', def.service, reference) })),
      alongside: def.alongside, egress: def.egress, soakSeconds: def.soak_s ?? null,
    };
  });
  if (rendered.some((v) => v.alongside === 'none' && v.replicas > 0) && rendered.reduce((sum, v) => sum + v.replicas, 0) > 1) throw new Error('An active alongside none version permits at most one desired instance across all versions.');
  // A single local-path claim has one size and one pinned device, including across stopped versions.
  const claims = new Map<string, { signature: string; writers: number }>();
  for (const v of rendered) if (v.state) {
    const signature = JSON.stringify([v.state.sizeGi, v.nodeSelector['nova/device']]);
    const previous = claims.get(v.state.claimName);
    if (previous && previous.signature !== signature) throw new Error('Retained state claims must agree on device and size.');
    const writers = (previous?.writers ?? 0) + v.replicas;
    if (writers > 1) throw new Error('A shared state claim must have at most one desired writer.');
    claims.set(v.state.claimName, { signature, writers });
  }
  return {
    namespace: context.namespace,
    service: { identity: first.service, name: token('service', first.service), selector: serviceSelector, ports: first.ports.map((p) => ({ name: p.name, port: p.port })) },
    live: context.live,
    stableSelector: { 'nova/service': serviceSelector, 'nova/version': context.live === null ? token('unselected', first.service) : token('version', first.service, context.live) },
    versions: rendered,
  };
}
