// The node's state file (docs/12 §15): keys, ids and tokens in one JSON file, mode 0600 inside a
// 0700 directory, written atomically. Its contents are never printed or logged.
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { BACKEND_KINDS } from './backend.ts';

export const STATE_FILE = 'node.json';

const listedSchema = z.object({ sha256: z.string(), notAfter: z.string() });

const stateSchema = z.object({
  version: z.literal(1),
  /** Stable random id for the capability document; kept across re-enrollment. */
  deviceId: z.string().min(1),
  name: z.string().min(1),
  hubUrl: z.string(),
  backend: z.object({ url: z.string(), kind: z.enum(BACKEND_KINDS) }),
  listen: z.object({ host: z.string(), port: z.number().int().min(0).max(65535) }),
  /** The job API URL the Hub calls. */
  endpoint: z.string(),
  maxConcurrentJobs: z.number().int().min(1),
  maxQueue: z.number().int().min(0),
  /** Set once enrolled; cleared when the Hub revokes the node. */
  enrollment: z
    .object({
      nodeId: z.string(),
      credential: z.string(),
      jobToken: z.string(),
      privateKeyPem: z.string(),
      publicKey: z.string(),
      heartbeatIntervalMs: z.number().int().min(100),
      protocolVersion: z.number().int(),
      enrolledAt: z.string(),
      /** The device certificate Add Device granted (local-CA mode): mutual TLS (FR-126). */
      certificatePem: z.string().nullable().default(null),
    })
    .nullable(),
  revokedAt: z.string().nullable().default(null),
  /**
   * The pinned Hub fingerprint and what its verified identity statements vouched for (the Hub
   * local CA, its listed certificates): how an https:// Hub is trusted (hub-tls.ts).
   */
  hubTrust: z
    .object({
      pin: z.string().nullable(),
      caPem: z.string().nullable(),
      listed: z.array(listedSchema),
    })
    .nullable()
    .default(null),
});
export type NodeState = z.infer<typeof stateSchema>;
export type Enrollment = NonNullable<NodeState['enrollment']>;

/** `$NOVA_COMPUTE_DATA_DIR`, else `$XDG_DATA_HOME/nova-compute`, else ~/.local/share/nova-compute. */
export function defaultDataDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.NOVA_COMPUTE_DATA_DIR) return env.NOVA_COMPUTE_DATA_DIR;
  const base = env.XDG_DATA_HOME || join(homedir(), '.local', 'share');
  return join(base, 'nova-compute');
}

export function statePath(dataDir: string): string {
  return join(dataDir, STATE_FILE);
}

export function loadState(dataDir: string): NodeState | null {
  const path = statePath(dataDir);
  if (!existsSync(path)) return null;
  return stateSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
}

export function saveState(dataDir: string, state: NodeState): void {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  chmodSync(dataDir, 0o700);
  const path = statePath(dataDir);
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(stateSchema.parse(state), null, 2)}\n`, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
}
