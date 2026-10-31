// The driver interface (docs/plans/M10-orchestration.md, Point 1): how the Service Manager runs a
// service, whatever runs it. The supervisor driver (src/supervisor/services.ts) is the default; the
// K3s driver (M10j) will implement the same six calls, so a third needs no caller changes. Every
// driver passes the same contract test (tests/support/service-driver-contract.ts).
import type { ServiceDefinition } from './definition.ts';

export type Say = (line: string) => void;
export interface Outcome { ok: boolean; said: string }

export interface PlanStep { step: 'install' | 'prepare' | 'alongside' | 'tests' | 'sandbox' | 'smoke' | 'health' | 'approval' | 'switch' | 'canary' | 'promote'; said: string }

// What a driver would do with a definition, step by step, or why it can't. Pure: nothing is run.
export interface Plan {
  driver: string;
  service: string;
  version: string;
  tier: 2 | 3;
  ok: boolean;
  // Why this driver can't run it, in plain words (empty when it can).
  refused: string[];
  where: string;
  steps: PlanStep[];
  // Exactly what would be started, word for word, as the driver would run it (absent when it can't).
  command?: string[];
}

export type VersionStatus = 'installed' | 'alongside' | 'ready' | 'live' | 'kept' | 'failed' | 'rolled_back' | 'removed';

export interface VersionView {
  version: string;
  status: VersionStatus;
  since: string;
  said: string | null;
  // Where it answers on this machine, by port name, while it runs.
  ports: Record<string, number> | null;
  pid: number | null;
}

export interface ServiceStatus {
  service: string;
  driver: string;
  live: string | null;
  // The version kept to go back to in one step, and until when (null: until the next promotion).
  previous: string | null;
  soak_until: string | null;
  // Held: restarted too often, so the driver stopped trying. The reason, in plain words.
  held: { reason: string; at: string } | null;
  health: { ok: boolean | null; checked_at: string | null; said: string | null };
  // Where the stable ports point, by name.
  stable: Record<string, number>;
  versions: VersionView[];
  history: { at: string; version: string; outcome: string; said: string }[];
}

export interface ServiceDriver {
  readonly name: string;
  // Whether this driver can run anything here, and why not.
  available(): Outcome;
  plan(def: ServiceDefinition): Plan;
  // Installs the version and starts it alongside the live one, with no production traffic (tier 1),
  // then runs its contract tests and health. It never moves traffic. Refused when `plan` refuses.
  apply(def: ServiceDefinition, say?: Say): Promise<Outcome>;
  status(service?: string): ServiceStatus[];
  // Moves traffic to a version `apply` made ready, watches it, and rolls back by itself when its
  // health fails. On success, the previous version is kept for its soak.
  switch(service: string, version: string, say?: Say): Promise<Outcome>;
  // Back to the kept version in one step: nothing is installed or downloaded.
  rollback(service: string, o: { auto: boolean; reason: string }, say?: Say): Promise<Outcome>;
  // Starts the live version again after it was held (it stopped too often), the person having fixed
  // what stopped it. The same, approved version: nothing new runs. A driver may not offer it.
  recover?(service: string, say?: Say): Promise<Outcome>;
}
