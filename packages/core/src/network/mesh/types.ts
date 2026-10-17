// The mesh adapter interface (FR-136, docs/22 §6): each adapter detects its CLI's state, plans
// the steps it carries out, and for each step snapshots what it changes, applies it, verifies it
// and undoes it. Steps are plain data (stored, shown to the owner, consented to); secrets in them
// are vault refs only.
import type { SecretStore } from '@nova/secrets';
import type {
  MeshDetectionView,
  MeshProvider,
  NetworkSetupCheckView,
  NetworkSetupOptions,
  NetworkSetupStepKind,
  NetworkSetupStepProvider,
  NetworkSetupTransport,
} from '@nova/shared';
import type { PackageManager } from './detect.ts';
import type { MeshCommand, MeshExec } from './runner.ts';

export type JsonObject = Record<string, unknown>;

/** What a planner produces for one step (stored as a `network_setup_step` row). */
export interface MeshStepPlan {
  kind: NetworkSetupStepKind;
  provider: NetworkSetupStepProvider;
  /**
   * `change` alters something and needs consent; `manual` is only described (Nova cannot do it
   * with this provider); `skip` is already in place; `check` only tests.
   */
  mode: 'change' | 'manual' | 'skip' | 'check';
  title: string;
  description: string;
  /** The commands applying runs, for the owner to read (secrets as refs). */
  commands: MeshCommand[];
  /** What the handler needs at apply time (no secrets: refs only). */
  params: JsonObject;
  /** Transports applying it could cut (the lock-out guard). */
  affects: NetworkSetupTransport[];
  /** Transports undoing it could cut. */
  undoAffects: NetworkSetupTransport[];
  /** Transports that must pass a reachability test after it, or it is rolled back. */
  expects: NetworkSetupTransport[];
  /** Runs host commands: refused unless `network.setup.allowSystemChanges`. */
  systemChange: boolean;
}

/** A stored step as a handler sees it. */
export interface MeshStep extends MeshStepPlan {
  id: string;
  runId: string;
  index: number;
}

/** What a handler gets while it works on a step. */
export interface MeshStepContext {
  exec: MeshExec;
  secrets: SecretStore;
  dataDir: string;
  runId: string;
  /** Public results the owner needs (e.g. a WireGuard public key), kept on the run. */
  outputs: Record<string, string>;
}

/** Carries out one kind of step for one provider. */
export interface MeshStepHandler {
  /** Record what the step changes, before it changes it (JSON, no secrets). */
  snapshot(step: MeshStep, ctx: MeshStepContext): Promise<JsonObject>;
  apply(step: MeshStep, ctx: MeshStepContext, snapshot: JsonObject): Promise<void>;
  /** Checks that the change took (the reachability test is the service's, after this). */
  verify(step: MeshStep, ctx: MeshStepContext): Promise<NetworkSetupCheckView[]>;
  /** The commands that put the snapshot back (shown before and run by `undo`). */
  undoCommands(step: MeshStep, snapshot: JsonObject): MeshCommand[];
  /** Put the snapshot back: by default, run `undoCommands`. */
  undo?(step: MeshStep, ctx: MeshStepContext, snapshot: JsonObject): Promise<void>;
}

/** Facts a planner works from. */
export interface MeshPlanInput {
  options: NetworkSetupOptions;
  /** This run's secret refs (auth key, Headscale API key), already in the vault. */
  secretRefs: { authKey: string | null; headscaleApiKey: string | null };
  detection: Partial<Record<MeshProvider, MeshDetectionView>>;
  packageManager: PackageManager | null;
  hubPort: number;
  platform: NodeJS.Platform;
}

export interface MeshAdapter {
  readonly provider: MeshProvider;
  /** Never throws: a missing CLI is `installed: false` with the reason in `detail`. */
  detect(exec: MeshExec): Promise<MeshDetectionView>;
  handler(kind: NetworkSetupStepKind): MeshStepHandler | null;
}

export function emptyDetection(provider: MeshProvider, detail: string | null): MeshDetectionView {
  return {
    provider,
    installed: false,
    version: null,
    loggedIn: false,
    state: null,
    controlUrl: null,
    ips: [],
    dnsName: null,
    tags: [],
    peers: [],
    routes: [],
    exitNode: false,
    detail,
  };
}

/** A check result. */
export function check(name: string, ok: boolean, detail: string | null = null) {
  return { name, ok, detail } satisfies NetworkSetupCheckView;
}

/** Parse JSON a CLI printed, or null. */
export function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

export function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

export function asString(v: unknown): string | null {
  return typeof v === 'string' && v !== '' ? v : null;
}

export function asStrings(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

/** Run each command, stopping at the first failure. */
export async function runAll(ctx: MeshStepContext, cmds: readonly MeshCommand[]): Promise<void> {
  for (const c of cmds) await ctx.exec.must(c);
}

/** Exit nodes advertise the default routes. */
export const EXIT_ROUTES = ['0.0.0.0/0', '::/0'];
