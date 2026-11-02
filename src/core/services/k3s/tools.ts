// Closed cluster adapter boundary. There is deliberately no executable runner here.
import type { Outcome, ServiceStatus } from '../driver.ts';
import type { ServiceExpectedState } from '../expected.ts';
import type { PlacementDevice } from '../placement.ts';
import type { K3sChartValues } from './values.ts';

export interface K3sCluster { id: string; namespace: string; hubId: string; devices: readonly PlacementDevice[] }
export interface ClusterVersion {
  version: string; replicas: number; ready: boolean; ready_at: string | null;
  health: { ok: boolean | null; checked_at: string | null; said: string | null };
  status: 'alongside' | 'ready' | 'live' | 'kept' | 'failed' | 'removed' | 'rolled_back';
  since: string; ports: Record<string, number>; state_refs: string[];
}
export interface ClusterSnapshot extends ServiceExpectedState {
  schema: 1; cluster: string; namespace: string; service: string;
  revision: number; observed_at: string; sequence: number;
  versions: ClusterVersion[]; soak_until: string | null;
  held: { reason: string; at: string } | null;
}
export interface ClusterExpectation { revision: number; state: ServiceExpectedState }
interface Target { cluster: string; namespace: string; service: string }
interface Mutation extends Target { expected: ClusterExpectation }
export type ClusterOperation =
  | (Target & { operation: 'status' })
  | (Mutation & { operation: 'prepare'; values: K3sChartValues })
  | (Mutation & { operation: 'validate'; version: string; passed: boolean })
  | (Mutation & { operation: 'switch'; version: string; soak_until: string | null })
  | (Mutation & { operation: 'rollback'; version: string | null; reason: string })
  | (Mutation & { operation: 'scale'; version: string; replicas: 0 | 1 })
  | (Mutation & { operation: 'remove'; version: string });
export interface ClusterTools {
  available(): Outcome;
  // Implementations must enforce CAS in the same server-side transaction as the mutation,
  // bound output/time, and return only actual observations. Unknown completion is NOT retried.
  execute(operation: ClusterOperation, signal?: AbortSignal): Promise<ClusterSnapshot>;
}
export const unavailableClusterTools: ClusterTools = Object.freeze({
  available: () => ({ ok: false, said: 'K3s is unavailable: the broker-backed cluster launcher capability is missing.' }),
  execute: async () => { throw new Error('The broker-backed cluster launcher capability is missing.'); },
});
export interface K3sStatus extends ServiceStatus {
  cluster: string; revision: number; observed_at: string;
  failure: { at: string; said: string } | null;
  readiness: { version: string; ready: boolean; checked_at: string | null }[];
}
