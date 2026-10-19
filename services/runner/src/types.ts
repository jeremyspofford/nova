// What the runner keeps and answers (contracts/rest-api.md §5 as amended by ADR-095 decision 4).
// Environment records, runs and snapshot indexes live inside each environment's own folder, so
// deleting an environment deletes everything of it; commands and their output are kept in memory
// only (no plaintext task content persisted beyond the environment).

export type NetworkMode = 'off' | 'setup' | 'on';

export interface EnvironmentSpec {
  /** Full URLs (they may carry credentials); views show them redacted. */
  repoUrls: string[];
  setupScript: string | null;
  baseImage: string | null;
  caches: string[];
  /** `setup`: the setup script may reach the network, commands may not. */
  network: NetworkMode;
  diskMb: number;
}

export type EnvironmentStatus = 'provisioning' | 'ready' | 'failed' | 'deleting';

export interface RepoRecord {
  /** The folder under /workspace. */
  name: string;
  url: string;
  ref: string | null;
  head: string | null;
}

export interface SetupRecord {
  status: 'none' | 'running' | 'ok' | 'failed';
  exitCode: number | null;
  /** The redacted tail of its output. */
  log: string;
  startedAt: string | null;
  endedAt: string | null;
}

export interface EnvironmentRecord {
  id: string;
  /** The token (Hub) that created it. */
  owner: string;
  name: string;
  spec: EnvironmentSpec;
  specHash: string;
  status: EnvironmentStatus;
  detail: string | null;
  substrate: string | null;
  repos: RepoRecord[];
  setup: SetupRecord;
  diskBytes: number;
  createdAt: string;
  updatedAt: string;
  readyAt: string | null;
}

export interface EnvironmentView {
  id: string;
  name: string;
  status: EnvironmentStatus;
  detail: string | null;
  substrate: string | null;
  repoUrls: string[];
  setupScript: string | null;
  baseImage: string | null;
  caches: string[];
  network: NetworkMode;
  /** Where things are inside the sandbox. */
  connection: {
    workdir: string;
    repos: { name: string; path: string; ref: string | null; head: string | null }[];
    caches: { name: string; path: string }[];
  };
  setup: SetupRecord;
  usage: { diskBytes: number };
  caps: { diskBytes: number };
  runs: { active: number };
  processes: { running: number };
  createdAt: string;
  updatedAt: string;
  readyAt: string | null;
}

export type RunStatus = 'active' | 'completed' | 'cancelled' | 'capped' | 'failed';

export interface RunCaps {
  cpuSeconds: number;
  wallSeconds: number;
}

export interface RunUsage {
  cpuSeconds: number;
  /** Time during which at least one of the run's commands was running. */
  wallSeconds: number;
  commands: number;
}

export interface ArtifactRecord {
  id: string;
  /** Its path in the sandbox when it was collected. */
  path: string;
  name: string;
  sizeBytes: number;
  sha256: string;
  createdAt: string;
}

export interface RunRecord {
  id: string;
  owner: string;
  environmentId: string;
  label: string | null;
  status: RunStatus;
  /** Why it ended or was capped: `cpu`, `wall`, `cancelled`, `environment_deleted`, ... */
  reason: string | null;
  caps: RunCaps;
  usage: RunUsage;
  /** Resources a warning was sent for at the warning threshold. */
  warned: string[];
  artifacts: ArtifactRecord[];
  createdAt: string;
  updatedAt: string;
  endedAt: string | null;
}

export interface ProcessView {
  id: string;
  runId: string;
  /** Redacted and shortened. */
  cmd: string;
  cwd: string;
  tag: string | null;
  running: boolean;
  exitCode: number | null;
  /** Why the runner stopped it: `cancelled`, `cap_cpu`, `cap_wall`, `cap_disk`, `timeout`, `killed`. */
  stopped: string | null;
  cpuSeconds: number;
  outputBytes: number;
  startedAt: string;
  endedAt: string | null;
}

export interface RunView extends Omit<RunRecord, 'owner' | 'warned'> {
  processes: ProcessView[];
}

export interface SnapshotRecord {
  id: string;
  owner: string;
  environmentId: string;
  label: string | null;
  sizeBytes: number;
  createdAt: string;
  restoredAt: string | null;
}

export type SnapshotView = Omit<SnapshotRecord, 'owner'>;

export type RunEventType =
  | 'process.started'
  | 'output'
  | 'process.exited'
  | 'usage'
  | 'cap.warning'
  | 'cap.reached'
  | 'artifact'
  | 'run.ended';

export interface RunEvent {
  /** Increases per run (SSE `id`, resumable with Last-Event-ID). */
  id: number;
  type: RunEventType;
  ts: string;
  data: Record<string, unknown>;
}

export interface ReadResult {
  data: string;
  offset: number;
  dropped: number;
  running: boolean;
  exitCode: number | null;
}

export type FileEntryKind = 'file' | 'dir' | 'link' | 'other';

export interface FileEntry {
  name: string;
  kind: FileEntryKind;
  size: number;
}
