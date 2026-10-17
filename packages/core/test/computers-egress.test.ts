// J8 steps 2 and 4 through an agent's computer on a real substrate (FR-193, ADR-063): a
// sandboxed request to an unlisted host gets the proxy's 403 with a cause header; a credential
// configured for the mock API host is added by the proxy, while the sandbox's environment, files
// and a request to an echo server show no credential. Uses bubblewrap (with curl) when it works
// here, else Docker or Podman (with a Perl client in the default image); skipped otherwise.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MemorySecretStore } from '@nova/secrets';
import type { NovaDatabase } from '@nova/storage';
import {
  ComputerService,
  EgressProxyService,
  EgressStore,
  classifyAddress,
  proxyEgress,
} from '../src/computers/index.ts';
import {
  BwrapSandbox,
  ContainerSandbox,
  DEFAULT_SANDBOX_IMAGE,
  findOnPath,
  seccompArch,
} from '../src/tools/sandbox.ts';
import type { SandboxClient } from '../src/tools/types.ts';
import { ACCOUNT, AGENT, computersDb } from './computers-env.ts';

const SECRET = 'sk-j8-credential-424242'; // secret-scan: fake

function pick(): { kind: 'bwrap' | 'container'; bin: string } | { kind: null; why: string } {
  const bwrap = findOnPath('bwrap');
  if (bwrap && findOnPath('curl') && process.platform === 'linux' && seccompArch()) {
    try {
      execFileSync(bwrap, ['--unshare-all', '--ro-bind', '/', '/', 'true'], { timeout: 5000 });
      return { kind: 'bwrap', bin: bwrap };
    } catch {
      // Fall through to a container engine.
    }
  }
  const engine = findOnPath('docker') ?? findOnPath('podman');
  if (engine) {
    try {
      execFileSync(engine, ['image', 'inspect', DEFAULT_SANDBOX_IMAGE], {
        stdio: 'ignore',
        timeout: 10_000,
      });
      return { kind: 'container', bin: engine };
    } catch {
      return { kind: null, why: `${DEFAULT_SANDBOX_IMAGE} is not available to ${engine}` };
    }
  }
  return { kind: null, why: 'neither a working bubblewrap with curl nor a container engine' };
}

const SUBSTRATE = pick();

describe('J8: the egress proxy in front of an agent computer', () => {
  it.skipIf(SUBSTRATE.kind !== null)(
    `skipped: ${'why' in SUBSTRATE ? SUBSTRATE.why : ''}`,
    () => undefined,
  );

  let dir: string;
  let db: NovaDatabase;
  let up: Server;
  let port: number;
  const seen: { host: string; headers: IncomingHttpHeaders }[] = [];
  let proxy: EgressProxyService;
  let svc: ComputerService;

  beforeAll(async () => {
    if (SUBSTRATE.kind === null) return;
    dir = mkdtempSync(join(tmpdir(), 'nova-j8-'));
    db = await computersDb();
    up = createServer((req, res) => {
      seen.push({ host: req.headers.host ?? '', headers: req.headers });
      // The echo server reflects every header it got.
      res.end(JSON.stringify(req.headers));
    });
    await new Promise<void>((r) => up.listen(0, '127.0.0.1', () => r()));
    const a = up.address();
    port = typeof a === 'object' && a ? a.port : 0;
    const secrets = new MemorySecretStore();
    const store = new EgressStore({ db, secrets });
    await store.createCredential(ACCOUNT, {
      name: 'Mock API',
      hosts: ['mockapi.test'],
      scheme: 'bearer',
      value: SECRET,
    });
    await store.putScope(ACCOUNT, 'agent', AGENT, {
      mode: null,
      allow: ['mockapi.test', 'echo.test'],
      deny: [],
      hooks: [],
      allowLocalBinding: false,
    });
    proxy = new EgressProxyService({
      socketDir: join(tmpdir(), `nova-j8-s-${process.pid}`),
      resolve: (h) =>
        Promise.resolve(['mockapi.test', 'echo.test'].includes(h) ? ['127.0.0.1'] : []),
      classify: (x) => (x === '127.0.0.1' ? 'public' : classifyAddress(x)),
      credentials: (accountId, ids) => store.credentials(accountId, ids),
    });
    const egress = proxyEgress({
      proxy,
      store,
      db,
      global: () => Promise.resolve({ mode: 'allowlist', allow: [], deny: [] }),
    });
    const sandbox: SandboxClient =
      SUBSTRATE.kind === 'bwrap'
        ? new BwrapSandbox({ bin: SUBSTRATE.bin, egress })
        : new ContainerSandbox({ bin: SUBSTRATE.bin, egress });
    svc = new ComputerService({
      db,
      dataDir: dir,
      sandbox: () => sandbox,
      limits: () => Promise.resolve({ wallClockSeconds: 60 }),
    });
  });
  afterAll(async () => {
    if (SUBSTRATE.kind === null) return;
    await proxy.close();
    await new Promise((r) => up.close(r));
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  /** A GET through the sandbox's proxy route: curl under bubblewrap, Perl in a container. */
  const fetchCmd = (url: string) =>
    SUBSTRATE.kind === 'bwrap'
      ? `curl -s -i -m 10 ${url}`
      : `perl -MIO::Socket::INET -e 'my ($u) = @ARGV; my ($h) = $u =~ m{^http://([^/]+)}; my $s = IO::Socket::INET->new(PeerAddr => "127.0.0.1:3128") or die "no route\\n"; print $s "GET $u HTTP/1.1\\r\\nHost: $h\\r\\nConnection: close\\r\\n\\r\\n"; print while <$s>;' ${url}`;

  it.runIf(SUBSTRATE.kind !== null)(
    'blocks an unlisted host with a cause header and injects the credential only for its host',
    async () => {
      const c = await svc.forAgent(ACCOUNT, AGENT);
      const signal = new AbortController().signal;
      // Step 2: an unlisted host.
      const blocked = await c.exec({ cmd: fetchCmd(`http://unlisted.test:${port}/`) }, signal);
      expect(blocked.stdout).toContain('403');
      expect(blocked.stdout.toLowerCase()).toContain('x-nova-block-cause: allowlist');
      expect(blocked.stdout).toContain('unlisted.test');
      // Step 4: the mock API host gets the credential, added by the proxy ...
      const api = await c.exec({ cmd: fetchCmd(`http://mockapi.test:${port}/v1/items`) }, signal);
      expect(api.stdout).toContain('200');
      const toApi = seen.find((s) => s.host.startsWith('mockapi.test'));
      expect(toApi?.headers.authorization).toBe(`Bearer ${SECRET}`);
      // ... and the sandbox never sees it: not in the reply, the echo, the environment or files.
      expect(api.stdout).not.toContain(SECRET);
      const echo = await c.exec({ cmd: fetchCmd(`http://echo.test:${port}/`) }, signal);
      expect(echo.stdout).toContain('200');
      expect(echo.stdout).not.toContain('authorization');
      const inside = await c.exec(
        {
          cmd: `env; grep -rl "${SECRET.slice(0, 12)}" "$HOME" /run/nova /tmp 2>/dev/null; echo end`,
        },
        signal,
      );
      expect(inside.stdout).not.toContain(SECRET);
      expect(inside.stdout).toContain('end');
    },
    120_000,
  );
});
