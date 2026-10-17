// A Code session's `device` environment (FR-062, docs/10 §2): the session reaches the device's
// files and processes only through novad under its own grants (grantee `session:<id>`): scoped
// listing, folder-access requests, staged-then-committed writes, sandboxed commands and the
// device's local MCP servers (FR-210). The code area wires it into its environments.
import { NovaError, type DeviceGrantee } from '@nova/shared';
import { DeviceComputer } from './computer.ts';
import type { DeviceService } from './service.ts';

export interface DeviceEnvironmentHealth {
  status: 'ok' | 'degraded' | 'down';
  checkedAt: string;
  detail: string | null;
}

export interface DeviceEnvironment {
  kind: 'device';
  deviceId: string;
  grantee: DeviceGrantee;
  /** Files (staged writes) and sandboxed commands, as a `local_host` computer. */
  computer: DeviceComputer;
  health(): Promise<DeviceEnvironmentHealth>;
  mcp: {
    list(): Promise<{ servers: unknown[] }>;
    call(server: string, tool: string, args: Record<string, unknown>): Promise<unknown>;
  };
}

export function deviceEnvironment(
  svc: DeviceService,
  input: { accountId: string; deviceId: string; sessionId: string; threadId?: string },
  now: () => Date = () => new Date(),
): DeviceEnvironment {
  const grantee: DeviceGrantee = { kind: 'session', id: input.sessionId };
  const context = { sessionId: input.sessionId, threadId: input.threadId ?? null, actor: 'user' };
  const computer = new DeviceComputer(svc, {
    accountId: input.accountId,
    deviceId: input.deviceId,
    grantee,
    context,
    id: `device:${input.deviceId}:session:${input.sessionId}`,
  });
  return {
    kind: 'device',
    deviceId: input.deviceId,
    grantee,
    computer,
    async health() {
      const checkedAt = now().toISOString();
      try {
        const view = await svc.get(input.accountId, input.deviceId);
        if (view.status !== 'active') {
          return { status: 'down', checkedAt, detail: `the device is ${view.status}` };
        }
        const missing = view.capabilities.filter(
          (c) => ['files', 'staged_writes', 'exec'].includes(c.name) && !c.available,
        );
        if (missing.some((c) => c.name === 'files')) {
          return { status: 'down', checkedAt, detail: 'no file access on the device' };
        }
        if (missing.length) {
          return {
            status: 'degraded',
            checkedAt,
            detail: missing.map((c) => `${c.name}: ${c.reason ?? 'unavailable'}`).join(', '),
          };
        }
        return { status: 'ok', checkedAt, detail: null };
      } catch (err) {
        return {
          status: 'down',
          checkedAt,
          detail: err instanceof Error ? err.message : 'unknown',
        };
      }
    },
    mcp: {
      list: () => svc.mcpList(input.accountId, input.deviceId, grantee),
      call: (server, tool, args) =>
        svc.mcpCall(
          input.accountId,
          input.deviceId,
          grantee,
          { server, tool, arguments: args },
          context,
        ),
    },
  };
}

// ---- the code area's helper connection over the management channel ----------------------------

/** What the code area's environments call on a device (its `EnvHelperConnection`, FR-062). */
export interface DeviceHelperConnection {
  readonly closed: boolean;
  hello(): Promise<{
    version: string;
    platform: string;
    arch: string | null;
    verified: boolean;
    home: string | null;
  }>;
  stat(path: string): Promise<{ kind: 'file' | 'dir' | 'other' } | null>;
  spawn(spec: {
    cmd: string;
    cwd: string;
    env?: Record<string, string>;
    tag?: string;
  }): Promise<{ id: string }>;
  read(
    id: string,
    offset: number,
    waitMs: number,
  ): Promise<{
    data: string;
    offset: number;
    dropped: number;
    running: boolean;
    exitCode: number | null;
  }>;
  write(
    id: string,
    input: { text?: string; closeStdin?: boolean; signal?: 'interrupt' | 'terminate' },
  ): Promise<void>;
  processes(): Promise<
    {
      id: string;
      cmd: string;
      cwd: string;
      tag: string | null;
      running: boolean;
      exitCode: number | null;
      outputBytes: number;
      startedAt: string;
    }[]
  >;
  wslDistros(): Promise<never>;
  wsl(distro: string): Promise<never>;
  close(): Promise<void>;
}

const PLATFORM: Record<string, string> = { linux: 'linux', macos: 'darwin', windows: 'win32' };

/**
 * A Code environment's connection to a device: processes, stats and the hello go through novad
 * under the signed-in user's grants on the device ("the device's grants", docs/10 §2).
 */
export function deviceHelperConnection(
  svc: DeviceService,
  accountId: string,
  deviceId: string,
): DeviceHelperConnection {
  const grantee: DeviceGrantee = { kind: 'user', id: accountId };
  let closed = false;
  const wslMissing = () =>
    Promise.reject(
      new NovaError('capability_missing', 'WSL is available only on Windows devices', {
        details: { reason: 'not_windows' },
      }),
    );
  return {
    get closed() {
      return closed;
    },
    async hello() {
      const v = await svc.get(accountId, deviceId);
      const doc = v.capability ?? {};
      const os = isRecord(doc.os) ? doc.os : {};
      const hw = isRecord(doc.hardware) ? doc.hardware : {};
      const family = typeof os.family === 'string' ? os.family : 'unknown';
      return {
        version: v.novadVersion ?? '0.0.0',
        platform: PLATFORM[family] ?? family,
        arch: typeof hw.arch === 'string' ? hw.arch : null,
        // The device is the one enrolled with this key: its signed capability document verified
        // against the key pinned at enrollment. Signed builds arrive with M6.5 (FR-133).
        verified: v.status === 'active' && !v.updateRequired,
        home: null,
      };
    },
    async stat(path) {
      try {
        const s = await svc.statFile(accountId, deviceId, grantee, path);
        return { kind: s.kind === 'symlink' ? 'other' : s.kind };
      } catch (err) {
        if (err instanceof NovaError && err.code === 'not_found') return null;
        throw err;
      }
    },
    spawn: (spec) =>
      svc.procSpawn(accountId, deviceId, grantee, spec, { sessionId: spec.tag ?? null }),
    read: (id, offset, waitMs) => svc.procRead(accountId, deviceId, grantee, id, offset, waitMs),
    write: (id, input) => svc.procWrite(accountId, deviceId, grantee, id, input),
    async processes() {
      return (await svc.procList(accountId, deviceId, grantee)).flatMap((p) => {
        if (!isRecord(p) || typeof p.id !== 'string') return [];
        return [
          {
            id: p.id,
            cmd: typeof p.cmd === 'string' ? p.cmd : '',
            cwd: typeof p.cwd === 'string' ? p.cwd : '',
            tag: typeof p.tag === 'string' ? p.tag : null,
            running: p.running === true,
            exitCode: typeof p.exitCode === 'number' ? p.exitCode : null,
            outputBytes: typeof p.outputBytes === 'number' ? p.outputBytes : 0,
            startedAt: typeof p.startedAt === 'string' ? p.startedAt : '',
          },
        ];
      });
    },
    wslDistros: wslMissing,
    wsl: wslMissing,
    close() {
      closed = true;
      return Promise.resolve();
    },
  };
}

/** The code area's `EnvDeviceProvider`: null while the device is not reachable. */
export function deviceEnvProvider(svc: DeviceService): {
  connect(
    accountId: string,
    deviceId: string,
    signal: AbortSignal,
  ): Promise<DeviceHelperConnection | null>;
} {
  return {
    async connect(accountId, deviceId, signal) {
      signal.throwIfAborted();
      const v = await svc.get(accountId, deviceId);
      if (v.status !== 'active') return null;
      return deviceHelperConnection(svc, accountId, deviceId);
    },
  };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
