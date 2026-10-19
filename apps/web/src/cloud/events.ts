// How the cloud runner views stay current (FR-108, FR-116): the runner, environment, run and
// snapshot events on the app's one shared stream (src/hub-events.ts). Each view follows the events
// it shows while it is mounted and refetches; `cloud.run.usage` is ephemeral and carries the new
// usage, so a run card applies it at once.
import type { EventEnvelope } from '@nova/shared';
import { useHubStream } from '../hub-events.ts';

export const RUNNER_EVENTS = ['cloud.runner.updated', 'settings.changed'] as const;

/** Environments: created, checked, rebuilding, removed; snapshots and runs change their facts. */
export const ENVIRONMENT_EVENTS = [
  'environment.updated',
  'environment.health.changed',
  'cloud.runner.updated',
  'cloud.run.started',
  'cloud.run.ended',
  'cloud.snapshot.created',
  'cloud.snapshot.restored',
  'cloud.snapshot.deleted',
] as const;

export const SNAPSHOT_EVENTS = [
  'cloud.snapshot.created',
  'cloud.snapshot.restored',
  'cloud.snapshot.deleted',
] as const;

/** A run's lease: started, its usage, near a cap, stopped at a cap, ended. */
export const RUN_EVENTS = [
  'cloud.run.started',
  'cloud.run.usage',
  'cloud.run.cap_warning',
  'cloud.run.capped',
  'cloud.run.ended',
] as const;

/** Follows the named events while mounted; `onOpen` refetches after a reconnect. */
export function useCloudEvents(
  names: readonly string[],
  onEvent: (env: EventEnvelope) => void,
  onOpen?: () => void,
): void {
  useHubStream(names, onEvent, onOpen);
}

const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** The cloud run an event is about. */
export function eventCloudRunId(env: EventEnvelope): string | null {
  return str(env.payload.cloudRunId);
}

/** The environment an event is about (`environmentId`, or a snapshot's environment). */
export function eventEnvironmentId(env: EventEnvelope): string | null {
  return str(env.payload.environmentId);
}

/** The thread an event is correlated with. */
export function eventThread(env: EventEnvelope): string | null {
  return env.correlation?.threadId ?? str(env.payload.threadId);
}

/** The usage and caps a `cloud.run.usage` event carries, when it carries them. */
export function usageFromEvent(env: EventEnvelope): {
  usage: { cpuSeconds: number; wallSeconds: number; commands: number };
  caps: { cpuSeconds: number; wallSeconds: number } | null;
} | null {
  const u = env.payload.usage as Record<string, unknown> | undefined;
  const c = env.payload.caps as Record<string, unknown> | undefined;
  const cpu = num(u?.cpuSeconds);
  const wall = num(u?.wallSeconds);
  if (cpu === null || wall === null) return null;
  const capCpu = num(c?.cpuSeconds);
  const capWall = num(c?.wallSeconds);
  return {
    usage: { cpuSeconds: cpu, wallSeconds: wall, commands: num(u?.commands) ?? 0 },
    caps: capCpu !== null && capWall !== null ? { cpuSeconds: capCpu, wallSeconds: capWall } : null,
  };
}
