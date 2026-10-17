// Mesh adapters (FR-136, docs/22 §2, §6): the command runner (argv without a shell, stdin,
// a fixed environment, timeouts, missing programs), secrets only through env or stdin and never
// in previews, records or error text; the CLIs' JSON parsed into detection views; Headscale
// policies merged without narrowing; host detection; package installs; WireGuard keys; and each
// adapter's detection against the fake CLIs.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MemorySecretStore } from '@nova/secrets';
import { CertificateAuthority } from '../src/computers/egress-ca.ts';
import {
  classifyInterface,
  detectInterfaces,
  detectPackageManager,
  defaultNetworkProbe,
  inCgnat,
  ipv4Network,
  lanSubnets,
  parseResolvConf,
} from '../src/network/mesh/detect.ts';
import {
  HeadscaleAdapter,
  LOCAL_HEADSCALE,
  readHeadscalePolicy,
  mergeNovaPolicy,
  parseHeadscaleNodes,
  parseHeadscaleUsers,
  parseHuJson,
  summarizePolicy,
} from '../src/network/mesh/headscale.ts';
import { installCommand, planInstall, removeCommand } from '../src/network/mesh/install.ts';
import {
  NetbirdAdapter,
  netbirdUpCommand,
  parseNetbirdStatus,
} from '../src/network/mesh/netbird.ts';
import {
  MeshCommandError,
  MeshExec,
  ProcessMeshRunner,
  previewCommand,
  resolveProgram,
  systemSearchPath,
} from '../src/network/mesh/runner.ts';
import {
  TailscaleAdapter,
  parseTailscalePrefs,
  parseTailscaleStatus,
  tailscaleUpCommand,
} from '../src/network/mesh/tailscale.ts';
import { detectUfw } from '../src/network/mesh/ufw.ts';
import {
  WireguardAdapter,
  ensureWireguardKey,
  wireguardConfig,
  wireguardPublicKey,
} from '../src/network/mesh/wireguard.ts';
import { FakeMeshWorld, FlakyRunner, argvOf, argvStarts } from './fixtures/mesh/world.ts';

const ECHO = `process.stdout.write(JSON.stringify({argv: process.argv.slice(1), env: process.env, stdin: require('fs').readFileSync(0, 'utf8')}))`;

describe('the command runner', () => {
  const runner = new ProcessMeshRunner({
    bins: {
      echo: [process.execPath, '-e', ECHO, '--'],
      sleep: [process.execPath, '-e', 'setTimeout(() => {}, 10000)'],
      fail: [process.execPath, '-e', 'process.stderr.write("boom\\n"); process.exit(3)'],
    },
  });

  it('passes argv literally (no shell), stdin, and only a fixed environment', async () => {
    process.env.NOVA_TEST_HUB_SECRET = 'do-not-pass';
    try {
      const r = await runner.run({
        argv: ['echo', 'a b', '$(whoami)', '; rm -rf /', '`id`'],
        env: { EXTRA: '1' },
        stdin: 'on stdin',
        timeoutMs: 10_000,
      });
      expect(r.code).toBe(0);
      const got = JSON.parse(r.stdout) as {
        argv: string[];
        env: Record<string, string>;
        stdin: string;
      };
      expect(got.argv.slice(-4)).toEqual(['a b', '$(whoami)', '; rm -rf /', '`id`']);
      expect(got.stdin).toBe('on stdin');
      expect(got.env.EXTRA).toBe('1');
      expect(got.env.NOVA_TEST_HUB_SECRET).toBeUndefined();
      // The system folders only, never the inherited PATH (which holds node_modules/.bin here).
      expect(got.env.PATH).toBe(systemSearchPath().join(':'));
      expect(got.env.PATH).not.toContain('node_modules');
    } finally {
      delete process.env.NOVA_TEST_HUB_SECRET;
    }
  });

  it('reports a missing program, a timeout and a failing exit', async () => {
    const missing = await runner.run({
      argv: ['/nonexistent/nova-cli'],
      env: {},
      stdin: null,
      timeoutMs: 5000,
    });
    expect(missing.error).toBe('not_found');
    const slow = await runner.run({ argv: ['sleep'], env: {}, stdin: null, timeoutMs: 200 });
    expect(slow.timedOut).toBe(true);
    expect(slow.code).not.toBe(0);
    const bad = await runner.run({ argv: ['fail'], env: {}, stdin: null, timeoutMs: 10_000 });
    expect(bad.code).toBe(3);
    expect(bad.stderr).toContain('boom');
    expect((await runner.run({ argv: [], env: {}, stdin: null, timeoutMs: 1 })).error).toBe(
      'empty command',
    );
  });

  it('resolves vault refs into env and stdin only, records argv only, and redacts output', async () => {
    const secrets = new MemorySecretStore();
    await secrets.put('secret://t/key', 'tskey-super-secret-value');
    const exec = new MeshExec(runner, secrets);
    const cmd = {
      bin: 'echo',
      args: ['up'],
      env: { NB_SETUP_KEY: { secretRef: 'secret://t/key' } },
      stdin: { secretRef: 'secret://t/key' },
    };
    expect(previewCommand(cmd)).toEqual([
      'NB_SETUP_KEY=<secret>',
      'echo',
      'up',
      '<secret on stdin>',
    ]);
    const r = await exec.run(cmd);
    // The echo prints the secret back; output is redacted before anyone sees it.
    expect(r.stdout).not.toContain('tskey-super-secret-value');
    expect(r.stdout).toContain('[REDACTED]');
    expect(JSON.stringify(exec.records)).not.toContain('tskey-super-secret-value');
    expect(exec.records[0]?.argv).toEqual(['echo', 'up']);
    await expect(
      exec.run({ bin: 'echo', args: [], stdin: { secretRef: 'secret://t/missing' } }),
    ).rejects.toThrow(/missing from the vault/);
  });

  it('must() fails with the command and a redacted line of its output', async () => {
    const exec = new MeshExec(runner, new MemorySecretStore());
    const err = await exec.must({ bin: 'fail', args: ['x'] }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MeshCommandError);
    expect((err as Error).message).toBe('fail x failed: exit 3: boom');
    const nf = await exec.must({ bin: '/nonexistent/x', args: [] }).catch((e: unknown) => e);
    expect((nf as Error).message).toContain('is not installed');
  });
});

describe('the command runner: process groups and lookup (review findings 8, hardening)', () => {
  const alive = (pid: number) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  const until = async (fn: () => boolean, ms = 3000) => {
    for (const end = Date.now() + ms; Date.now() < end;) {
      if (fn()) return true;
      await new Promise((r) => setTimeout(r, 25));
    }
    return fn();
  };

  it('settles at its timeout and kills what the program started, even if it holds the pipes', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'nova-runner-'));
    try {
      const pidFile = join(dir, 'pid');
      const r = new ProcessMeshRunner({
        bins: { hang: ['/bin/sh', '-c', `sleep 30 & echo $! > ${pidFile}; sleep 60`] },
      });
      const t0 = Date.now();
      const res = await r.run({ argv: ['hang'], env: {}, stdin: null, timeoutMs: 300 });
      expect(Date.now() - t0).toBeLessThan(2000);
      expect(res).toMatchObject({ timedOut: true, error: 'timed out', code: null });
      const pid = Number(readFileSync(pidFile, 'utf8'));
      // The background sleep held stdout; it went with the process group.
      expect(await until(() => !alive(pid))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('settles when the program exits, without waiting for a leftover holding its output', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'nova-runner-'));
    const pidFile = join(dir, 'pid');
    try {
      const r = new ProcessMeshRunner({
        bins: { daemonize: ['/bin/sh', '-c', `sleep 30 & echo $! > ${pidFile}; echo started`] },
      });
      const t0 = Date.now();
      const res = await r.run({ argv: ['daemonize'], env: {}, stdin: null, timeoutMs: 20_000 });
      expect(Date.now() - t0).toBeLessThan(2000);
      expect(res).toMatchObject({ code: 0, timedOut: false, error: null });
      expect(res.stdout).toContain('started');
    } finally {
      const pid = Number(readFileSync(pidFile, 'utf8'));
      if (pid) process.kill(pid, 'SIGKILL');
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('finds programs only in the system folders, never through the inherited PATH', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'nova-path-'));
    const saved = process.env.PATH;
    try {
      writeFileSync(join(dir, 'tailscale'), '#!/bin/sh\necho planted\n', { mode: 0o755 });
      process.env.PATH = `${dir}:${saved ?? ''}`;
      const r = new ProcessMeshRunner();
      expect(
        await r.run({ argv: ['tailscale', 'version'], env: {}, stdin: null, timeoutMs: 5000 }),
      ).toMatchObject({ error: 'not_found' });
      // The same program in a folder the runner searches is found.
      const found = new ProcessMeshRunner({ searchPath: [dir] });
      expect(
        (await found.run({ argv: ['tailscale'], env: {}, stdin: null, timeoutMs: 5000 })).stdout,
      ).toBe('planted\n');
    } finally {
      process.env.PATH = saved;
      rmSync(dir, { recursive: true, force: true });
    }
    expect(resolveProgram('sh', ['/bin'], 'linux')).toBe('/bin/sh');
    expect(resolveProgram('./sh', ['/bin'], 'linux')).toBeNull();
    expect(resolveProgram('bin/sh', ['/'], 'linux')).toBeNull();
    expect(resolveProgram('/bin/sh', [], 'linux')).toBe('/bin/sh');
    expect(systemSearchPath('linux')).toEqual([
      '/usr/local/sbin',
      '/usr/local/bin',
      '/usr/sbin',
      '/usr/bin',
      '/sbin',
      '/bin',
    ]);
    expect(systemSearchPath('darwin')).toContain('/opt/homebrew/bin');
    expect(
      systemSearchPath('win32', {
        SystemRoot: 'C:\\Windows',
        ProgramFiles: 'C:\\Program Files',
        LOCALAPPDATA: 'C:\\Users\\o\\AppData\\Local',
      }),
    ).toEqual([
      'C:\\Windows\\System32',
      'C:\\Program Files\\Tailscale',
      'C:\\Program Files\\NetBird',
      'C:\\Program Files\\WireGuard',
      'C:\\Users\\o\\AppData\\Local\\Microsoft\\WindowsApps',
    ]);
  });
});

describe('reading the Headscale policy (review finding 5)', () => {
  let world: FakeMeshWorld;
  let flaky: FlakyRunner;
  let exec: MeshExec;
  beforeEach(() => {
    world = new FakeMeshWorld();
    flaky = new FlakyRunner(world.runner);
    exec = new MeshExec(flaky, new MemorySecretStore());
  });
  afterEach(() => world.close());

  it('only Headscale\'s explicit answer means "no policy"; every other failure throws', async () => {
    expect(await readHeadscalePolicy(exec, LOCAL_HEADSCALE)).toEqual({ state: 'none' });
    world.update((s) => {
      s.headscale.policy = '{"acls": []}';
    });
    expect(await readHeadscalePolicy(exec, LOCAL_HEADSCALE)).toEqual({
      state: 'policy',
      text: '{"acls": []}\n',
    });
    for (const stderr of [
      'rpc error: code = Unavailable desc = connection refused',
      'policy is in file mode',
      'Error: acl policy not found in cache; retrying',
      '',
    ]) {
      flaky.rules.splice(0, flaky.rules.length, {
        match: argvStarts('headscale', 'policy'),
        stderr,
      });
      await expect(readHeadscalePolicy(exec, LOCAL_HEADSCALE)).rejects.toThrow(/policy get failed/);
    }
    // The real shape of the answer: a gRPC error whose message ends with the sentinel.
    flaky.rules.splice(0, flaky.rules.length, {
      match: argvStarts('headscale', 'policy'),
      stderr:
        'Failed loading ACL Policy: rpc error: code = Unknown desc = loading ACL from database: acl policy not found',
    });
    expect(await readHeadscalePolicy(exec, LOCAL_HEADSCALE)).toEqual({ state: 'none' });
    // A failed read never turns into an empty summary that looks like "no rules".
    flaky.rules.splice(0, flaky.rules.length, { match: argvStarts('headscale', 'policy') });
    expect(await new HeadscaleAdapter().aclSummary(exec)).toMatchObject({
      source: 'none',
      detail: expect.stringContaining('connection refused') as unknown,
    });
  });
});

describe('parsing the CLIs', () => {
  const status = {
    Version: '1.76.1',
    BackendState: 'Running',
    TailscaleIPs: ['100.64.0.5', 'fd7a:115c:a1e0::5'],
    Self: {
      HostName: 'nova-hub',
      DNSName: 'nova-hub.tail0.ts.net.',
      TailscaleIPs: ['100.64.0.5', 'fd7a:115c:a1e0::5'],
      Online: true,
      Tags: ['tag:nova-hub'],
    },
    Peer: {
      'nodekey:a': {
        HostName: 'phone',
        DNSName: 'phone.tail0.ts.net.',
        TailscaleIPs: ['100.64.0.7'],
        Online: false,
        OS: 'iOS',
      },
    },
  };
  const prefs = JSON.stringify({
    ControlURL: 'https://hs.example.com',
    CorpDNS: true,
    WantRunning: true,
    LoggedOut: false,
    AdvertiseRoutes: ['192.168.1.0/24', '0.0.0.0/0', '::/0'],
    AdvertiseTags: ['tag:nova-hub'],
    Hostname: 'nova-hub',
  });

  it('tailscale status and prefs', () => {
    const p = parseTailscalePrefs(prefs);
    expect(p).toMatchObject({ controlUrl: 'https://hs.example.com', acceptDns: true });
    const d = parseTailscaleStatus(JSON.stringify(status), p, '1.76.1');
    expect(d).toMatchObject({
      loggedIn: true,
      state: 'Running',
      dnsName: 'nova-hub.tail0.ts.net',
      ips: ['100.64.0.5', 'fd7a:115c:a1e0::5'],
      tags: ['tag:nova-hub'],
      routes: ['192.168.1.0/24'],
      exitNode: true,
      controlUrl: 'https://hs.example.com',
    });
    expect(d.peers).toEqual([
      {
        name: 'phone',
        dnsName: 'phone.tail0.ts.net',
        ips: ['100.64.0.7'],
        online: false,
        os: 'iOS',
        tags: [],
      },
    ]);
    const out = parseTailscaleStatus(JSON.stringify({ BackendState: 'NeedsLogin' }), null, null);
    expect(out).toMatchObject({ loggedIn: false, dnsName: null, ips: [], exitNode: false });
    expect(parseTailscalePrefs('not json')).toBeNull();
  });

  it('netbird status', () => {
    const d = parseNetbirdStatus(
      JSON.stringify({
        peers: {
          total: 1,
          connected: 1,
          details: [{ fqdn: 'laptop.nb.example', netbirdIp: '100.92.0.2', status: 'Connected' }],
        },
        cliVersion: '0.36.5',
        management: { url: 'https://nb.example:443', connected: true, error: '' },
        netbirdIp: '100.92.0.1/16',
        fqdn: 'nova-hub.nb.example',
      }),
      null,
    );
    expect(d).toMatchObject({
      loggedIn: true,
      ips: ['100.92.0.1'],
      dnsName: 'nova-hub.nb.example',
      controlUrl: 'https://nb.example:443',
      version: '0.36.5',
    });
    expect(d?.peers[0]).toMatchObject({ name: 'laptop', online: true, ips: ['100.92.0.2'] });
    expect(parseNetbirdStatus('Daemon status: NeedsLogin', null)).toBeNull();
  });

  it('headscale users and nodes (string or numeric ids)', () => {
    expect(parseHeadscaleUsers('[{"id":"1","name":"nova"},{"id":2,"name":"x"}]')).toEqual([
      { id: '1', name: 'nova' },
      { id: '2', name: 'x' },
    ]);
    const nodes = parseHeadscaleNodes(
      JSON.stringify([
        {
          id: '3',
          name: 'nova-hub',
          given_name: 'nova-hub',
          ip_addresses: ['100.64.0.1'],
          online: true,
          user: { name: 'nova' },
          forced_tags: ['tag:a'],
          valid_tags: ['tag:a', 'tag:b'],
          approved_routes: ['10.0.0.0/24'],
          available_routes: ['10.0.0.0/24'],
        },
      ]),
    );
    expect(nodes?.[0]).toMatchObject({
      id: '3',
      givenName: 'nova-hub',
      tags: ['tag:a', 'tag:b'],
      approved: ['10.0.0.0/24'],
      user: 'nova',
    });
    expect(parseHeadscaleUsers('oops')).toBeNull();
    expect(parseHeadscaleNodes('{}')).toBeNull();
  });

  it('HuJSON policies and the merge that never narrows', () => {
    const text = `{
      // owners
      "tagOwners": {"tag:x": ["alice@"],},
      /* rules */
      "acls": [{"action": "accept", "src": ["alice@"], "dst": ["tag:x:22"]},],
      "groups": {"group:admins": ["alice@"]},
      "note": "a // not a comment",
    }`;
    const p = parseHuJson(text);
    expect(p?.note).toBe('a // not a comment');
    const merged = mergeNovaPolicy(p, { tags: ['tag:nova-hub'], owner: 'nova@', port: 7419 });
    expect(merged.tagOwners).toEqual({ 'tag:x': ['alice@'], 'tag:nova-hub': ['nova@'] });
    expect(merged.acls).toEqual([
      { action: 'accept', src: ['alice@'], dst: ['tag:x:22'] },
      { action: 'accept', src: ['*'], dst: ['tag:nova-hub:7419'] },
    ]);
    // Idempotent, and the input is untouched.
    expect(mergeNovaPolicy(merged, { tags: ['tag:nova-hub'], owner: 'nova@', port: 7419 })).toEqual(
      merged,
    );
    expect((p?.acls as unknown[]).length).toBe(1);
    // No policy (Headscale allows everything): the allow-all rule stays.
    const fresh = mergeNovaPolicy(null, { tags: ['tag:nova-hub'], owner: 'nova@', port: 7419 });
    expect(fresh.acls).toContainEqual({ action: 'accept', src: ['*'], dst: ['*:*'] });
    expect(summarizePolicy(p, null)).toMatchObject({
      source: 'headscale-policy',
      rules: 1,
      groups: ['group:admins'],
      tagOwners: ['tag:x'],
    });
    expect(summarizePolicy(null, 'not found')).toMatchObject({ source: 'none', rules: 0 });
    expect(parseHuJson('{"a": ')).toBeNull();
    expect(parseHuJson('[1]')).toBeNull();
  });
});

describe('host detection', () => {
  const info = (
    address: string,
    cidr: string,
    family: 'IPv4' | 'IPv6' = 'IPv4',
    internal = false,
  ) => ({
    address,
    cidr,
    family,
    internal,
    netmask: '',
    mac: '00:00:00:00:00:00',
    ...(family === 'IPv6' ? { scopeid: 0 } : {}),
  });

  it('classifies interfaces and finds LAN subnets', () => {
    const ifaces = {
      lo: [info('127.0.0.1', '127.0.0.1/8', 'IPv4', true)],
      eth0: [info('192.168.1.23', '192.168.1.23/24'), info('fe80::1', 'fe80::1/64', 'IPv6')],
      wlan0: [info('169.254.3.3', '169.254.3.3/16'), info('10.1.2.3', '10.1.2.3/20')],
      tailscale0: [info('100.64.0.5', '100.64.0.5/32')],
      wt0: [info('100.92.0.1', '100.92.0.1/16')],
      'wg-nova': [info('10.77.0.1', '10.77.0.1/24')],
      utun4: [info('10.8.0.2', '10.8.0.2/24')],
      docker0: [info('172.17.0.1', '172.17.0.1/16')],
      odd0: [info('100.100.1.1', '100.100.1.1/32')],
    } as Parameters<typeof detectInterfaces>[0];
    const list = detectInterfaces(ifaces);
    const kind = (n: string) => list.find((i) => i.name === n);
    expect(kind('lo')).toMatchObject({ kind: 'loopback' });
    expect(kind('eth0')).toMatchObject({ kind: 'lan', provider: null });
    expect(kind('tailscale0')).toMatchObject({ kind: 'mesh', provider: 'tailscale' });
    expect(kind('wt0')).toMatchObject({ kind: 'mesh', provider: 'netbird' });
    expect(kind('wg-nova')).toMatchObject({ kind: 'mesh', provider: 'wireguard' });
    expect(kind('utun4')).toMatchObject({ kind: 'vpn' });
    expect(kind('docker0')).toMatchObject({ kind: 'other' });
    expect(kind('odd0')).toMatchObject({ kind: 'mesh', provider: null });
    expect(lanSubnets(list)).toEqual(['10.1.0.0/20', '192.168.1.0/24']);
    expect(classifyInterface('x', [])).toEqual({ kind: 'lan', provider: null });
  });

  it('subnets, the shared mesh range, resolv.conf and package managers', () => {
    expect(ipv4Network('192.168.1.23/24')).toBe('192.168.1.0/24');
    expect(ipv4Network('10.0.0.1/0')).toBe('0.0.0.0/0');
    expect(ipv4Network('300.1.1.1/8')).toBeNull();
    expect(ipv4Network('1.1.1.1/40')).toBeNull();
    expect(inCgnat('100.64.0.1')).toBe(true);
    expect(inCgnat('100.127.255.255')).toBe(true);
    expect(inCgnat('100.128.0.1')).toBe(false);
    expect(inCgnat('nope')).toBe(false);
    expect(
      parseResolvConf(
        '# generated\nnameserver 100.100.100.100\nnameserver 1.1.1.1 # isp\nsearch tail0.ts.net lan\ndomain lan\noptions edns0\n',
      ),
    ).toEqual({ nameservers: ['100.100.100.100', '1.1.1.1'], search: ['tail0.ts.net', 'lan'] });
    const probe = (platform: NodeJS.Platform, files: string[]) =>
      defaultNetworkProbe({ platform, exists: (p) => files.includes(p) });
    expect(detectPackageManager(probe('linux', ['/usr/bin/apt-get']))).toBe('apt');
    expect(detectPackageManager(probe('linux', ['/usr/bin/dnf']))).toBe('dnf');
    expect(detectPackageManager(probe('linux', []))).toBeNull();
    expect(detectPackageManager(probe('darwin', ['/opt/homebrew/bin/brew']))).toBe('brew');
    expect(detectPackageManager(probe('darwin', []))).toBeNull();
    expect(detectPackageManager(probe('win32', []))).toBe('winget');
  });
});

describe('client installs', () => {
  it('names the exact command per package manager, and the undo', () => {
    expect([
      installCommand('apt', 'tailscale').bin,
      ...installCommand('apt', 'tailscale').args,
    ]).toEqual(['apt-get', 'install', '-y', '--no-install-recommends', 'tailscale']);
    expect(installCommand('dnf', 'wireguard').args).toEqual(['install', '-y', 'wireguard-tools']);
    expect(installCommand('brew', 'netbird').args).toEqual(['install', 'netbirdio/tap/netbird']);
    expect(installCommand('winget', 'tailscale').args).toContain('Tailscale.Tailscale');
    expect(removeCommand('apt', 'netbird').args).toEqual(['remove', '-y', 'netbird']);
    expect(removeCommand('dnf', 'netbird').args).toEqual(['remove', '-y', 'netbird']);
    expect(removeCommand('brew', 'tailscale').args).toEqual(['uninstall', 'tailscale']);
    expect(removeCommand('winget', 'wireguard').args).toContain('WireGuard.WireGuard');
    const plan = planInstall('tailscale', false, 'apt', true);
    expect(plan).toMatchObject({ mode: 'change', systemChange: true, undoAffects: ['mesh'] });
    expect(plan.description).toContain('apt-get install -y --no-install-recommends tailscale');
    expect(planInstall('tailscale', true, 'apt', true).mode).toBe('skip');
    expect(planInstall('netbird', false, null, true)).toMatchObject({
      mode: 'manual',
      systemChange: false,
    });
    expect(planInstall('netbird', false, 'apt', false).mode).toBe('manual');
  });
});

describe('command shapes keep secrets out of argv', () => {
  it('tailscale up reads the key from stdin (or a file on Windows); netbird from the environment', () => {
    const p = {
      loginServer: 'https://hs.example.com',
      hostname: 'nova-hub',
      tags: ['tag:nova-hub'],
      acceptDns: true,
      authKeyRef: 'secret://k',
      reset: false,
      keyFile: false,
    };
    const up = tailscaleUpCommand(p, null);
    expect(up.args).toEqual([
      'up',
      '--login-server=https://hs.example.com',
      '--auth-key=file:/dev/stdin',
      '--hostname=nova-hub',
      '--advertise-tags=tag:nova-hub',
      '--accept-dns=true',
    ]);
    expect(up.stdin).toEqual({ secretRef: 'secret://k' });
    const win = tailscaleUpCommand({ ...p, loginServer: null, tags: [], reset: true }, 'C:/d/k');
    expect(win.args).toEqual([
      'up',
      '--auth-key=file:C:/d/k',
      '--hostname=nova-hub',
      '--accept-dns=true',
      '--reset',
    ]);
    expect(win.stdin).toBeUndefined();
    const nb = netbirdUpCommand({
      managementUrl: 'https://nb',
      hostname: 'h',
      setupKeyRef: 'secret://s',
    });
    expect(nb.args).toEqual(['up', '--management-url', 'https://nb', '--hostname', 'h']);
    expect(nb.env).toEqual({ NB_SETUP_KEY: { secretRef: 'secret://s' } });
  });
});

describe('WireGuard keys and config', () => {
  it('derives the public key (RFC 7748 vector) and keeps the private key in the vault', async () => {
    const priv = Buffer.from(
      '77076d0a7318a57d3c16c17251b26645df4c2f87ebc0992ab177fba51db92c2a',
      'hex',
    ).toString('base64');
    const pub = Buffer.from(
      '8520f0098930a754748b7ddcb43ef75a0dbf3a0d26381af4eba4a98eaa9b4e6a',
      'hex',
    ).toString('base64');
    expect(wireguardPublicKey(priv)).toBe(pub);
    expect(() => wireguardPublicKey('AAAA')).toThrow(/32 bytes/);
    const secrets = new MemorySecretStore();
    const a = await ensureWireguardKey(secrets, 'wg-nova');
    const b = await ensureWireguardKey(secrets, 'wg-nova');
    expect(a).toEqual(b);
    expect(a.ref).toBe('secret://network/wireguard/wg-nova/private-key');
    expect(wireguardPublicKey((await secrets.get(a.ref))!)).toBe(a.publicKey);
    const conf = wireguardConfig(
      {
        iface: 'wg-nova',
        address: '10.77.0.1/24',
        listenPort: 51820,
        dns: ['10.77.0.1'],
        peers: [
          {
            name: 'phone',
            publicKey: pub,
            allowedIps: ['10.77.0.2/32'],
            endpoint: 'p.example:51820',
          },
        ],
        keyRef: a.ref,
        configPath: '/x',
      },
      'PRIVATE',
    );
    expect(conf).toContain(
      'PrivateKey = PRIVATE\nAddress = 10.77.0.1/24\nListenPort = 51820\nDNS = 10.77.0.1',
    );
    expect(conf).toContain(
      `[Peer]\n# phone\nPublicKey = ${pub}\nAllowedIPs = 10.77.0.2/32\nEndpoint = p.example:51820`,
    );
  });
});

describe('adapters against the fake CLIs', () => {
  let world: FakeMeshWorld;
  let exec: MeshExec;
  beforeEach(() => {
    world = new FakeMeshWorld();
    exec = new MeshExec(world.runner, new MemorySecretStore());
  });
  afterEach(() => world.close());

  it('tailscale: logged out, then running with peers and routes', async () => {
    const ts = new TailscaleAdapter();
    expect(await ts.detect(exec)).toMatchObject({
      installed: true,
      version: '1.76.1',
      loggedIn: false,
      state: 'NeedsLogin',
      ips: [],
    });
    world.update((s) => {
      Object.assign(s.tailscale, {
        backendState: 'Running',
        hostname: 'nova-hub',
        dnsName: 'nova-hub.nova.mesh',
        ips: ['100.64.0.5'],
        controlUrl: 'https://hs.example.com',
        routes: ['10.0.0.0/24'],
      });
    });
    const d = await ts.detect(exec);
    expect(d).toMatchObject({
      loggedIn: true,
      dnsName: 'nova-hub.nova.mesh',
      controlUrl: 'https://hs.example.com',
      routes: ['10.0.0.0/24'],
      exitNode: false,
    });
    expect(d.peers.map((p) => p.name)).toEqual(['laptop']);
    world.update((s) => {
      s.installed.tailscale = false;
    });
    expect(await ts.detect(exec)).toMatchObject({ installed: false, loggedIn: false });
  });

  it('tailscale cert hands back both PEMs without logging them', async () => {
    const ca = CertificateAuthority.create();
    world.update((s) => {
      s.cert = ca;
    });
    const out = await new TailscaleAdapter().certificate(exec, 'nova-hub.tail0.ts.net');
    expect(out.certPem).toContain('BEGIN CERTIFICATE');
    expect(out.keyPem).toContain('PRIVATE KEY');
    expect(new Date(out.notAfter).getTime()).toBeGreaterThan(Date.now());
    expect(world.calls().map(argvOf)).toEqual([
      'tailscale cert --cert-file=- --key-file=- nova-hub.tail0.ts.net',
    ]);
    await expect(new TailscaleAdapter().certificate(exec, 'bad host;')).rejects.toThrow(/host/);
    world.update((s) => {
      delete s.cert;
    });
    await expect(new TailscaleAdapter().certificate(exec, 'h.example')).rejects.toThrow(/failed/);
  });

  it('headscale: users, nodes and the ACL summary; a silent server is reported', async () => {
    world.update((s) => {
      s.headscale.policy = '{"tagOwners": {"tag:a": ["admin@"]}, "acls": []}';
      s.headscale.nodes.push({
        id: '1',
        name: 'laptop',
        given_name: 'laptop',
        ip_addresses: ['100.64.0.9'],
        online: true,
        user: { id: '1', name: 'admin' },
        forced_tags: [],
        valid_tags: [],
        approved_routes: [],
        available_routes: [],
      });
    });
    const hs = new HeadscaleAdapter();
    const d = await hs.detect(exec);
    expect(d).toMatchObject({ installed: true, version: 'v0.26.1', loggedIn: true });
    expect(d.peers[0]).toMatchObject({ name: 'laptop', ips: ['100.64.0.9'] });
    expect(await hs.aclSummary(exec)).toMatchObject({ tagOwners: ['tag:a'], rules: 0 });
    world.update((s) => {
      s.fail['headscale users'] = 'connection refused';
    });
    expect(await hs.detect(exec)).toMatchObject({ installed: true, loggedIn: false });
    world.update((s) => {
      s.headscale.policy = null;
    });
    expect((await hs.aclSummary(exec)).source).toBe('none');
  });

  it('netbird, wireguard and ufw', async () => {
    expect(await new NetbirdAdapter().detect(exec)).toMatchObject({ installed: false });
    world.update((s) => {
      s.installed.netbird = true;
    });
    expect(await new NetbirdAdapter().detect(exec)).toMatchObject({
      installed: true,
      version: '0.36.5',
      loggedIn: false,
    });
    world.update((s) => {
      Object.assign(s.netbird, {
        connected: true,
        managementUrl: 'https://nb',
        hostname: 'nova-hub',
      });
    });
    expect(await new NetbirdAdapter().detect(exec)).toMatchObject({
      loggedIn: true,
      dnsName: 'nova-hub.netbird.cloud',
      ips: ['100.92.0.1'],
    });
    expect(await new WireguardAdapter().detect(exec)).toMatchObject({ installed: false });
    world.update((s) => {
      s.installed.wg = true;
      s.wg.interfaces = ['wg0'];
    });
    expect(await new WireguardAdapter().detect(exec)).toMatchObject({
      installed: true,
      version: 'v1.0.20210914',
      loggedIn: true,
      state: 'interfaces: wg0',
    });
    expect(await detectUfw(exec)).toEqual({ tool: 'ufw', active: true, detail: null });
    world.update((s) => {
      s.installed.ufw = false;
    });
    expect((await detectUfw(exec)).tool).toBeNull();
  });
});
