import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeEvent, type NewEvent } from '@nova/shared';
import {
  buildActivity,
  buildDiagnostics,
  detectVolumeEncryption,
  sha256Hex,
  type DiagnosticsInput,
} from '../src/index.ts';

const ev = (e: NewEvent<Record<string, unknown>>) => makeEvent(e);

describe('buildActivity', () => {
  it('turns a thread’s events into an ordered trace and skips the rest', () => {
    const c = { threadId: 't1', turnId: 'u1' };
    const items = buildActivity([
      ev({ name: 'turn.started', correlation: c, payload: { threadId: 't1', turnId: 'u1' } }),
      ev({ name: 'chat.delta', correlation: c, payload: { text: 'x' } }),
      ev({
        name: 'tool.call.started',
        correlation: c,
        payload: { callId: 'c1', tool: 'fs.read', argsPreview: '{"path":"a.md"}' },
      }),
      ev({
        name: 'approval.requested',
        correlation: c,
        payload: {
          approvalId: 'a1',
          action: 'Write notes.md',
          reason: 'writes a file',
          tier: 'pre_approvable',
        },
      }),
      ev({
        name: 'approval.decided',
        correlation: c,
        payload: { approvalId: 'a1', decision: 'allow_once', decidedBy: 'user' },
      }),
      ev({
        name: 'policy.tier',
        correlation: { ...c, callId: 'c1' },
        payload: {
          action: 'Write notes.md',
          tier: 'confirm_at_action',
          authorization: 'user_typed',
        },
      }),
      ev({
        name: 'policy.denied',
        correlation: c,
        payload: { callId: 'c2', tool: 'exec', reason: 'no sandbox' },
      }),
      ev({
        name: 'tool.call.completed',
        correlation: c,
        payload: { callId: 'c1', status: 'ok', durationMs: 12, resultPreview: '2 lines' },
      }),
      ev({
        name: 'tool.call.completed',
        correlation: c,
        payload: { callId: 'c9', status: 'error' },
      }),
      ev({ name: 'chat.followup.queued', correlation: c, payload: {} }),
      ev({ name: 'chat.followup.started', correlation: c, payload: {} }),
      ev({ name: 'chat.followup.cancelled', correlation: c, payload: { error: 'model gone' } }),
      ev({ name: 'compaction.completed', correlation: c, payload: {} }),
      ev({
        name: 'turn.completed',
        correlation: c,
        payload: { status: 'failed', stopReason: 'error' },
      }),
      ev({ name: 'turn.completed', correlation: c, payload: {} }),
      ev({ name: 'turn.interrupted', correlation: c, payload: { stopReason: 'cancelled' } }),
    ]);
    expect(items.map((i) => [i.kind, i.title, i.status, i.detail])).toEqual([
      ['turn', 'Turn started', 'running', null],
      ['tool_call', 'fs.read', 'running', '{"path":"a.md"}'],
      ['approval', 'Approval requested: Write notes.md', 'pending', 'writes a file'],
      ['approval', 'Approval allow once', 'allow_once', 'by user'],
      ['policy', 'Write notes.md: confirm at action', 'confirm_at_action', 'you asked for this'],
      ['policy', 'Denied: exec', 'denied', 'no sandbox'],
      ['tool_call', 'fs.read ok', 'ok', '2 lines · 12 ms'],
      ['tool_call', 'tool error', 'error', null],
      ['notice', 'Follow-up queued', null, null],
      ['notice', 'Queued follow-up started', null, null],
      ['notice', 'Follow-up cancelled', null, 'model gone'],
      ['notice', 'Context compacted', null, null],
      ['turn', 'Turn failed', 'failed', 'error'],
      ['turn', 'Turn completed', 'completed', null],
      ['turn', 'Turn interrupted', 'interrupted', 'cancelled'],
    ]);
    expect(items[1]).toMatchObject({ callId: 'c1', turnId: 'u1' });
    expect(items[4]?.callId).toBe('c1');
    expect(items[5]?.callId).toBe('c2');
  });

  it('copes with sparse payloads', () => {
    const items = buildActivity([
      ev({ name: 'tool.call.started', payload: {} }),
      ev({ name: 'tool.call.completed', payload: { durationMs: 5 } }),
      ev({ name: 'approval.requested', payload: {} }),
      ev({ name: 'approval.decided', payload: {} }),
      ev({ name: 'policy.tier', payload: {} }),
      ev({ name: 'policy.denied', payload: {} }),
    ]);
    expect(items.map((i) => i.title)).toEqual([
      'tool',
      'tool finished',
      'Approval requested: action',
      'Approval decided',
      'Action: ',
      'Denied: tool',
    ]);
    expect(items[1]?.detail).toBe('5 ms');
    expect(items.every((i) => i.callId === null && i.turnId === null)).toBe(true);
  });
});

const base = (over: Partial<DiagnosticsInput> = {}): DiagnosticsInput => ({
  version: '1.2.3',
  uptimeSeconds: 12.4,
  dataDir: '/data',
  blobsEncrypted: true,
  volume: 'encrypted',
  providers: [{ id: 'p1', label: 'Mock', status: 'active' }],
  nodes: [],
  probes: {},
  secrets: { backend: 'vault', detail: 'Encrypted file vault', warning: null },
  tls: false,
  host: '127.0.0.1',
  ...over,
});

describe('buildDiagnostics', () => {
  it('assembles a quiet snapshot for a healthy Hub', () => {
    expect(buildDiagnostics(base())).toEqual({
      hub: {
        version: '1.2.3',
        uptimeSeconds: 12,
        dataDir: '/data',
        encryptedAtRest: { blobs: true, volume: 'encrypted' },
      },
      providers: [{ id: 'p1', label: 'Mock', status: 'active' }],
      nodes: [],
      mcp: [],
      sandbox: { substrate: null, available: false, detail: 'No sandbox has been set up.' },
      secrets: { backend: 'vault', detail: 'Encrypted file vault' },
      warnings: [],
      probes: {},
    });
  });

  it('reads the MCP and sandbox probes defensively and warns about what needs fixing', () => {
    const snap = buildDiagnostics(
      base({
        blobsEncrypted: false,
        volume: 'unencrypted',
        tls: false,
        host: '0.0.0.0',
        secrets: {
          backend: 'memory',
          detail: 'In-memory store',
          warning: 'Secrets are kept in memory only.',
        },
        providers: [{ id: 'p1', label: 'Cloud', status: 'error' }],
        nodes: [
          { id: 'n1', name: 'gpu', status: 'unreachable' },
          { id: 'n2', name: 'cpu', status: 'active' },
        ],
        probes: {
          mcp: [
            { id: 's1', name: 'files', status: 'error', lastError: 'spawn ENOENT' },
            { id: 's2', status: 'connected' },
            { id: 's3', status: 'weird' },
            'junk',
          ],
          sandbox: { substrate: 'container', ok: false, detail: 'docker not found' },
          memory: { error: 'probe timed out' },
        },
      }),
    );
    expect(snap.mcp).toEqual([
      { id: 's1', name: 'files', status: 'error', lastError: 'spawn ENOENT' },
      { id: 's2', name: 's2', status: 'connected', lastError: null },
    ]);
    expect(snap.sandbox).toEqual({
      substrate: 'container',
      available: false,
      detail: 'docker not found',
    });
    expect(snap.warnings).toEqual([
      'Secrets are kept in memory only.',
      'Attachments and artifacts are stored unencrypted: the Hub data key is not loaded.',
      expect.stringMatching(/not on an encrypted volume/),
      expect.stringMatching(/listens on 0.0.0.0 without TLS/),
      'Provider Cloud needs attention (error).',
      'Compute node gpu is unreachable.',
      'MCP server files: spawn ENOENT',
      'No sandbox is available (docker not found); command tools are turned off.',
      'The memory check failed: probe timed out',
    ]);
  });

  it('passes other areas probes through under probes, without mcp and sandbox', () => {
    const d = buildDiagnostics(
      base({ probes: { mcp: [], sandbox: { available: true }, memoryConsolidation: { runs: 2 } } }),
    );
    expect(d.probes).toEqual({ memoryConsolidation: { runs: 2 } });
  });

  it('accepts other probe shapes', () => {
    const a = buildDiagnostics(
      base({
        probes: {
          mcp: { servers: [{ id: 's1', status: 'error' }] },
          sandbox: { substrate: 'nope', available: true },
        },
        tls: true,
        host: '0.0.0.0',
      }),
    );
    expect(a.mcp).toEqual([{ id: 's1', name: 's1', status: 'error', lastError: null }]);
    expect(a.sandbox).toEqual({ substrate: null, available: true, detail: 'ready' });
    expect(a.warnings).toEqual(['MCP server s1: failed']);
    const b = buildDiagnostics(base({ probes: { mcp: { nope: 1 }, sandbox: { error: 'x' } } }));
    expect(b.mcp).toEqual([]);
    expect(b.sandbox.detail).toBe('No sandbox has been set up.');
    expect(buildDiagnostics(base({ probes: { sandbox: {} } })).sandbox.detail).toBe('unavailable');
  });
});

describe('detectVolumeEncryption', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'nova-vol-'));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  function mountinfo(lines: string[]): void {
    mkdirSync(join(root, 'proc/self'), { recursive: true });
    writeFileSync(join(root, 'proc/self/mountinfo'), `${lines.join('\n')}\n`);
  }
  /** A block device directory under /sys/devices with its /sys/dev/block and /sys/class/block links. */
  function blockDev(
    name: string,
    devno: string,
    opts: { uuid?: string; slaves?: string[]; parent?: string } = {},
  ) {
    const dir = opts.parent
      ? join(root, 'sys/devices/virtual/block', opts.parent, name)
      : join(root, 'sys/devices/virtual/block', name);
    mkdirSync(dir, { recursive: true });
    if (opts.parent) writeFileSync(join(dir, 'partition'), '1');
    if (opts.uuid) {
      mkdirSync(join(dir, 'dm'));
      writeFileSync(join(dir, 'dm/uuid'), opts.uuid);
    }
    if (opts.slaves) {
      mkdirSync(join(dir, 'slaves'));
      for (const s of opts.slaves)
        symlinkSync(join(root, 'sys/devices/virtual/block', s), join(dir, 'slaves', s));
    }
    mkdirSync(join(root, 'sys/dev/block'), { recursive: true });
    mkdirSync(join(root, 'sys/class/block'), { recursive: true });
    symlinkSync(dir, join(root, 'sys/dev/block', devno));
    symlinkSync(dir, join(root, 'sys/class/block', name));
  }
  const linux = (path: string) => detectVolumeEncryption(path, { platform: 'linux', root });

  it('finds dm-crypt below LVM, and reports plain disks as unencrypted', async () => {
    blockDev('dm-0', '253:0', { uuid: 'CRYPT-LUKS2-abc' });
    blockDev('dm-1', '253:1', { uuid: 'LVM-xyz', slaves: ['dm-0'] });
    blockDev('nvme0n1', '259:0');
    blockDev('nvme0n1p1', '259:1', { parent: 'nvme0n1' });
    mountinfo([
      '22 1 259:1 / / rw,relatime shared:1 - ext4 /dev/nvme0n1p1 rw',
      '30 22 253:1 / /home rw,relatime shared:2 - ext4 /dev/mapper/vg-home rw',
      '31 22 0:40 / /run rw - tmpfs tmpfs rw',
      'garbage line',
    ]);
    expect(await linux('/home/me/.local/share/Nova')).toBe('encrypted');
    expect(await linux('/var/lib/nova')).toBe('unencrypted');
    expect(await linux('/run/nova')).toBe('unknown');
  });

  it('follows the source of anonymous devices and recognises stacked encrypting filesystems', async () => {
    blockDev('dm-2', '253:2', { uuid: 'CRYPT-PLAIN-1' });
    mkdirSync(join(root, 'dev/mapper'), { recursive: true });
    writeFileSync(join(root, 'dev/dm-2'), '');
    symlinkSync(join(root, 'dev/dm-2'), join(root, 'dev/mapper/luks-root'));
    blockDev('loop0', '7:0');
    mountinfo([
      '22 1 0:31 / / rw - btrfs /dev/mapper/luks-root rw',
      '40 22 0:50 / /home/me/Private rw - ecryptfs /home/me/.Private rw',
      '41 22 7:0 / /snap/x rw - squashfs /dev/loop0 ro',
      '42 22 0:51 / /mnt/my\\040disk rw - ext4 /dev/missing rw',
    ]);
    expect(await linux('/srv/nova')).toBe('encrypted');
    expect(await linux('/home/me/Private/nova')).toBe('encrypted');
    expect(await linux('/snap/x/data')).toBe('unknown');
    expect(await linux('/mnt/my disk/nova')).toBe('unknown');
  });

  it('is unknown without mount information and on other platforms', async () => {
    expect(await linux('/x')).toBe('unknown');
    mountinfo(['22 1 8:1 /sub /mnt rw - ext4 /dev/sda1 rw']);
    expect(await linux('/elsewhere')).toBe('unknown');
    expect(await detectVolumeEncryption('/x', { platform: 'win32' })).toBe('unknown');
  });

  it('asks diskutil on macOS', async () => {
    const run =
      (fv: string | null, code = 0) =>
      (cmd: string) =>
        Promise.resolve(
          cmd === 'df'
            ? {
                code,
                stdout:
                  'Filesystem 512-blocks Used Available Capacity Mounted on\n/dev/disk3s5 1 1 1 1% /System/Volumes/Data\n',
              }
            : {
                code: 0,
                stdout:
                  fv === null ? 'Volume Name: Data\n' : `   FileVault:                 ${fv}\n`,
              },
        );
    const mac = (r: ReturnType<typeof run>) =>
      detectVolumeEncryption('/Users/me', { platform: 'darwin', run: r });
    expect(await mac(run('Yes'))).toBe('encrypted');
    expect(await mac(run('No'))).toBe('unencrypted');
    expect(await mac(run(null))).toBe('unknown');
    expect(await mac(run('Yes', 1))).toBe('unknown');
    const failingInfo = (cmd: string) =>
      Promise.resolve(
        cmd === 'df' ? { code: 0, stdout: 'h\n/dev/x 1 1 1 1% /\n' } : { code: 1, stdout: '' },
      );
    expect(await mac(failingInfo)).toBe('unknown');
    const throwing = () => Promise.reject(new Error('boom'));
    expect(await mac(throwing)).toBe('unknown');
  });

  it('runs on the current platform without throwing', async () => {
    expect(['encrypted', 'unencrypted', 'unknown']).toContain(
      await detectVolumeEncryption(tmpdir()),
    );
  });
});

describe('sha256Hex', () => {
  it('hashes strings and buffers alike', () => {
    expect(sha256Hex('abc')).toBe(sha256Hex(Buffer.from('abc')));
    expect(sha256Hex('abc')).toMatch(/^ba7816bf/);
  });
});
