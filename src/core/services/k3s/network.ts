// Canonical public configuration for the bounded cluster NetworkTarget. The target accepts ONLY
// registered identities and egress; generated identifiers are recomputed, never exempted from
// M10d's secret scanner. No arbitrary manifest, identifier, URL or credential crosses this port.
import { createHash } from 'node:crypto';
import { CoreError } from '../../errors.ts';
import type { Config, NetworkTarget } from '../../network/targets.ts';
import { validServiceExpected, type ServiceExpectedState } from '../expected.ts';
import type { K3sRegistration } from './operations.ts';
import type { K3sChartValues } from './values.ts';
export interface ClusterNetworkDocument {
  schema: 1; cluster: string; namespace: string;
  services: Record<string, { state: [ServiceExpectedState]; versions: { version: string; egress: 'none' | 'internet' }[] }>;
}
// Port identity must remain current across each awaited read. Its provider is resolved again
// immediately before writes; removal never falls back to a legacy credentialed adapter.
export interface ClusterNetworkPort {
  read(signal?: AbortSignal): Promise<{ document: ClusterNetworkDocument; policies: Config[]; text: string; version: string }>;
  // The implementation renders exactly renderClusterNetwork(document, registered), applies the
  // policies atomically under ifVersion, and preserves text for exact M10d snapshot restoration.
  write(document: ClusterNetworkDocument, text: string, ifVersion: string, signal?: AbortSignal): Promise<{ version: string }>;
}
const closed = (v: unknown, keys: string[]): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === keys.length && keys.every(k => Object.hasOwn(v, k));
const token = (kind: string, ...ids: string[]) => `${kind}-${createHash('sha256').update(JSON.stringify([kind, ...ids])).digest('hex').slice(0, 40)}`;
export function renderClusterNetwork(raw: unknown, registration: K3sRegistration): Config[] {
  if (!closed(raw, ['schema', 'cluster', 'namespace', 'services']) || raw.schema !== 1 || raw.cluster !== registration.id || raw.namespace !== registration.namespace || !raw.services || typeof raw.services !== 'object' || Array.isArray(raw.services) || Object.keys(raw.services).length > 64) throw new CoreError('validation', 'Invalid canonical cluster network document.');
  const policies: Config[] = [];
  for (const [service, entry] of Object.entries(raw.services)) {
    if (['__proto__', 'constructor', 'prototype'].includes(service) || !registration.services.some(d => d.service === service)) throw new CoreError('validation', 'Network policy service is not registered.');
    if (!closed(entry, ['state', 'versions']) || !Array.isArray(entry.state) || entry.state.length !== 1 || !validServiceExpected(entry.state[0]) || !Array.isArray(entry.versions) || entry.versions.length === 0 || entry.versions.length > 64) throw new CoreError('validation', 'Invalid canonical cluster service policy.');
    const seen = new Set<string>();
    for (const v of entry.versions) {
      if (!closed(v, ['version', 'egress']) || typeof v.version !== 'string' || seen.has(v.version)) throw new CoreError('validation', 'Invalid canonical cluster policy version.');
      seen.add(v.version);
      const def = registration.services.find(d => d.service === service && d.version === v.version);
      if (!def || !['none', 'internet'].includes(def.egress) || v.egress !== def.egress) throw new CoreError('validation', 'Network policy must match a registered immutable service definition.');
      policies.push({ apiVersion: 'networking.k8s.io/v1', kind: 'NetworkPolicy', metadata: { name: token('network', service, v.version), namespace: registration.namespace }, spec: { podSelector: { matchLabels: { 'nova/service': token('selector', service), 'nova/version': token('version', service, v.version) } }, policyTypes: ['Egress'], egress: v.egress === 'none' ? [] : [{}] } });
    }
    const state = entry.state[0] as unknown as ServiceExpectedState;
    if ([state.live, state.previous].some(version => version !== null && !seen.has(version))) throw new CoreError('validation', 'Network policy must retain live and previous versions.');
  }
  return policies;
}
export function clusterNetworkPatch(r: K3sRegistration, values: K3sChartValues, expected: ServiceExpectedState): Config {
  const document: ClusterNetworkDocument = { schema: 1, cluster: r.id, namespace: r.namespace, services: { [values.service.identity]: { state: [structuredClone(expected)], versions: values.versions.map(v => ({ version: v.identity, egress: v.egress })) } } };
  const rendered = renderClusterNetwork(document, r);
  // Refuse if the renderer ever diverges from the chart values actually prepared for this task.
  values.versions.forEach((v, n) => {
    const p = rendered[n]!;
    if (JSON.stringify(p.metadata) !== JSON.stringify({ name: v.networkPolicyName, namespace: values.namespace }) || JSON.stringify(((p.spec as Config).podSelector as Config).matchLabels) !== JSON.stringify(v.selector)) throw new CoreError('conflict', 'Rendered cluster network artifact differs from the workload.');
  });
  return document as unknown as Config;
}
export function clusterNetworkTarget(registration: () => K3sRegistration, port: () => ClusterNetworkPort): NetworkTarget {
  return {
    async read(signal) {
      const current = port();
      const source = await current.read(signal);
      if (port() !== current) throw new CoreError('conflict', 'Cluster network capability changed during read.');
      const rendered = renderClusterNetwork(source.document, registration());
      if (JSON.stringify(source.policies) !== JSON.stringify(rendered)) throw new CoreError('conflict', 'Actual cluster network policy readback differs from the canonical document.');
      if (!source.version || JSON.stringify(JSON.parse(source.text)) !== JSON.stringify(source.document)) throw new CoreError('conflict', 'Cluster network readback text differs from its document.');
      return { config: source.document as unknown as Config, text: source.text, version: source.version };
    },
    async write(text, ifVersion, signal) {
      const document = JSON.parse(text) as ClusterNetworkDocument;
      renderClusterNetwork(document, registration());
      return port().write(document, text, ifVersion, signal);
    },
  };
}
