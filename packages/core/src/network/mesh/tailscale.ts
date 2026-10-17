// The Tailscale client adapter (docs/22 §2, §6): the Hub's own node, logged in to a Headscale
// server (`--login-server`) or to managed Tailscale. Reads `tailscale status --json` and
// `tailscale debug prefs`; changes go through `tailscale up` and `tailscale set`. The auth key
// never reaches argv: `tailscale up` reads it from `file:/dev/stdin` and Nova writes it to stdin
// (on Windows, from a 0600 file in the data folder that is removed right after).
import { X509Certificate } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { MeshDetectionView, MeshPeerView, NetworkSetupStepKind } from '@nova/shared';
import { headscaleApproveCommand, headscaleNodeRoutes, type HeadscaleCli } from './headscale.ts';
import type { MeshCommand, MeshExec } from './runner.ts';
import {
  EXIT_ROUTES,
  asRecord,
  asString,
  asStrings,
  check,
  emptyDetection,
  parseJson,
  runAll,
  type JsonObject,
  type MeshAdapter,
  type MeshStepHandler,
} from './types.ts';

const T = 15_000;

export interface TailscalePrefs {
  controlUrl: string | null;
  wantRunning: boolean;
  loggedOut: boolean;
  acceptDns: boolean;
  advertiseRoutes: string[];
  tags: string[];
  hostname: string | null;
}

export function parseTailscalePrefs(text: string): TailscalePrefs | null {
  const p = parseJson(text);
  if (!p || typeof p !== 'object') return null;
  const r = asRecord(p);
  return {
    controlUrl: asString(r.ControlURL),
    wantRunning: r.WantRunning === true,
    loggedOut: r.LoggedOut === true,
    acceptDns: r.CorpDNS === true,
    advertiseRoutes: asStrings(r.AdvertiseRoutes),
    tags: asStrings(r.AdvertiseTags),
    hostname: asString(r.Hostname),
  };
}

/** `tailscale status --json` → the detection view (prefs add the control URL and routes). */
export function parseTailscaleStatus(
  text: string,
  prefs: TailscalePrefs | null,
  version: string | null,
): MeshDetectionView {
  const st = asRecord(parseJson(text));
  const self = asRecord(st.Self);
  const state = asString(st.BackendState);
  const loggedIn = state !== null && !['NeedsLogin', 'NoState', 'NeedsMachineAuth'].includes(state);
  const peers: MeshPeerView[] = Object.values(asRecord(st.Peer)).map((v) => {
    const p = asRecord(v);
    return {
      name: asString(p.HostName) ?? '',
      dnsName: stripDot(asString(p.DNSName)),
      ips: asStrings(p.TailscaleIPs),
      online: p.Online === true,
      os: asString(p.OS),
      tags: asStrings(p.Tags),
    };
  });
  const routes = prefs?.advertiseRoutes ?? [];
  return {
    provider: 'tailscale',
    installed: true,
    version: version ?? asString(st.Version),
    loggedIn,
    state,
    controlUrl: prefs?.controlUrl ?? null,
    ips: asStrings(self.TailscaleIPs).length
      ? asStrings(self.TailscaleIPs)
      : asStrings(st.TailscaleIPs),
    dnsName: loggedIn ? stripDot(asString(self.DNSName)) : null,
    tags: asStrings(self.Tags).length ? asStrings(self.Tags) : (prefs?.tags ?? []),
    peers,
    routes: routes.filter((r) => !EXIT_ROUTES.includes(r)),
    exitNode: EXIT_ROUTES.every((r) => routes.includes(r)),
    detail: null,
  };
}

function stripDot(s: string | null): string | null {
  return s ? s.replace(/\.$/, '') : null;
}

const STATUS: MeshCommand = { bin: 'tailscale', args: ['status', '--json'], timeoutMs: T };
const PREFS: MeshCommand = { bin: 'tailscale', args: ['debug', 'prefs'], timeoutMs: T };

async function readPrefs(exec: MeshExec): Promise<TailscalePrefs | null> {
  const r = await exec.run(PREFS);
  return r.code === 0 ? parseTailscalePrefs(r.stdout) : null;
}

async function readStatus(exec: MeshExec): Promise<MeshDetectionView | null> {
  const r = await exec.run(STATUS);
  if (r.code !== 0 && !r.stdout.trim().startsWith('{')) return null;
  return parseTailscaleStatus(r.stdout, await readPrefs(exec), null);
}

/** Parameters of the `mesh.up` step (stored; the key is a vault ref). */
export interface TailscaleUpParams {
  loginServer: string | null;
  hostname: string;
  tags: string[];
  acceptDns: boolean;
  authKeyRef: string;
  reset: boolean;
  /** Read the key from a file instead of stdin (Windows has no /dev/stdin). */
  keyFile: boolean;
}

export function tailscaleUpCommand(p: TailscaleUpParams, keyPath: string | null): MeshCommand {
  const args = ['up'];
  if (p.loginServer) args.push(`--login-server=${p.loginServer}`);
  args.push(`--auth-key=file:${keyPath ?? '/dev/stdin'}`, `--hostname=${p.hostname}`);
  if (p.tags.length) args.push(`--advertise-tags=${p.tags.join(',')}`);
  args.push(`--accept-dns=${String(p.acceptDns)}`);
  if (p.reset) args.push('--reset');
  return {
    bin: 'tailscale',
    args,
    ...(keyPath ? {} : { stdin: { secretRef: p.authKeyRef } }),
    timeoutMs: 120_000,
  };
}

export function tailscaleKeyPath(dataDir: string, runId: string): string {
  return join(dataDir, 'network', 'tmp', `${runId}.authkey`);
}

const upHandler: MeshStepHandler = {
  async snapshot(_step, ctx) {
    const prefs = await readPrefs(ctx.exec);
    const status = await ctx.exec.run(STATUS);
    const st = asRecord(parseJson(status.stdout));
    const state = asString(st.BackendState);
    return {
      loggedIn: state !== null && !['NeedsLogin', 'NoState', 'NeedsMachineAuth'].includes(state),
      wantRunning: prefs?.wantRunning ?? false,
      controlUrl: prefs?.controlUrl ?? null,
    };
  },
  async apply(step, ctx) {
    const p = step.params as unknown as TailscaleUpParams;
    if (!p.keyFile) {
      await ctx.exec.must(tailscaleUpCommand(p, null));
      return;
    }
    const path = tailscaleKeyPath(ctx.dataDir, ctx.runId);
    const key = await ctx.secrets.get(p.authKeyRef);
    if (key === null) throw new Error('the auth key is missing from the vault');
    await mkdir(join(ctx.dataDir, 'network', 'tmp'), { recursive: true, mode: 0o700 });
    try {
      await writeFile(path, key, { mode: 0o600 });
      await ctx.exec.must(tailscaleUpCommand(p, path));
    } finally {
      await rm(path, { force: true });
    }
  },
  async verify(step, ctx) {
    const p = step.params as unknown as TailscaleUpParams;
    const st = await readStatus(ctx.exec);
    const out = [check('tailscale running', st?.state === 'Running', st?.state ?? 'no status')];
    if (p.loginServer) {
      const same = sameUrl(st?.controlUrl ?? null, p.loginServer);
      out.push(check('control server', same, same ? null : (st?.controlUrl ?? 'unknown')));
    }
    return out;
  },
  undoCommands(step, snap) {
    const p = step.params as unknown as TailscaleUpParams;
    const logout: MeshCommand = { bin: 'tailscale', args: ['logout'], timeoutMs: T };
    if (snap.loggedIn !== true) return [logout];
    // Logged in to another control server before: that login cannot be restored (its key is
    // gone), so the undo logs out and the description said so (`replaceExisting`).
    if (p.loginServer && !sameUrl(asString(snap.controlUrl), p.loginServer)) return [logout];
    if (snap.wantRunning !== true) return [{ bin: 'tailscale', args: ['down'], timeoutMs: T }];
    return [];
  },
};

export function sameUrl(a: string | null, b: string | null): boolean {
  if (!a || !b) return a === b;
  return a.replace(/\/+$/, '').toLowerCase() === b.replace(/\/+$/, '').toLowerCase();
}

const dnsHandler: MeshStepHandler = {
  async snapshot(_step, ctx) {
    const prefs = await readPrefs(ctx.exec);
    return { acceptDns: prefs?.acceptDns ?? false };
  },
  async apply(step, ctx) {
    await runAll(ctx, step.commands);
  },
  async verify(_step, ctx) {
    const prefs = await readPrefs(ctx.exec);
    return [check('MagicDNS accepted', prefs?.acceptDns === true)];
  },
  undoCommands(_step, snap) {
    return [
      {
        bin: 'tailscale',
        args: ['set', `--accept-dns=${String(snap.acceptDns === true)}`],
        timeoutMs: T,
      },
    ];
  },
};

/** `mesh.routes` and `mesh.exitnode`: advertise from the client; approve on Headscale. */
export interface TailscaleRoutesParams {
  routes: string[];
  /** Approve them on this Headscale server (null: approve in the provider's console). */
  headscale: (HeadscaleCli & { hostname: string }) | null;
}

function routesHandler(exit: boolean): MeshStepHandler {
  return {
    async snapshot(step, ctx) {
      const p = step.params as unknown as TailscaleRoutesParams;
      const prefs = await readPrefs(ctx.exec);
      const adv = prefs?.advertiseRoutes ?? [];
      const snap: JsonObject = {
        routes: adv.filter((r) => !EXIT_ROUTES.includes(r)),
        exitNode: EXIT_ROUTES.every((r) => adv.includes(r)),
      };
      if (p.headscale) {
        const node = await headscaleNodeRoutes(ctx.exec, p.headscale, p.headscale.hostname);
        snap.nodeId = node?.id ?? null;
        snap.approved = node?.approved ?? [];
      }
      return snap;
    },
    async apply(step, ctx, snap) {
      const p = step.params as unknown as TailscaleRoutesParams;
      await ctx.exec.must(step.commands[0] ?? advertise(exit, p.routes));
      if (p.headscale) {
        // The node registers on `mesh.up`; read its id now if the snapshot ran before that.
        const node = await headscaleNodeRoutes(ctx.exec, p.headscale, p.headscale.hostname);
        if (!node) throw new Error(`the Hub's node ${p.headscale.hostname} is not on Headscale`);
        const approved = [...new Set([...node.approved, ...p.routes])];
        snap.nodeId = node.id;
        snap.approved = node.approved;
        await ctx.exec.must(headscaleApproveCommand(p.headscale, node.id, approved));
      }
    },
    async verify(step, ctx) {
      const p = step.params as unknown as TailscaleRoutesParams;
      const prefs = await readPrefs(ctx.exec);
      const adv = prefs?.advertiseRoutes ?? [];
      const out = [
        check(
          exit ? 'exit node advertised' : 'routes advertised',
          p.routes.every((r) => adv.includes(r)),
        ),
      ];
      if (p.headscale) {
        const node = await headscaleNodeRoutes(ctx.exec, p.headscale, p.headscale.hostname);
        out.push(
          check(
            'routes approved on Headscale',
            !!node && p.routes.every((r) => node.approved.includes(r)),
          ),
        );
      }
      return out;
    },
    undoCommands(step, snap) {
      const p = step.params as unknown as TailscaleRoutesParams;
      const out: MeshCommand[] = [
        exit
          ? {
              bin: 'tailscale',
              args: ['set', `--advertise-exit-node=${String(snap.exitNode === true)}`],
              timeoutMs: T,
            }
          : advertise(false, asStrings(snap.routes)),
      ];
      const nodeId = asString(snap.nodeId);
      if (p.headscale && nodeId)
        out.push(headscaleApproveCommand(p.headscale, nodeId, asStrings(snap.approved)));
      return out;
    },
  };
}

export function advertise(exit: boolean, routes: string[]): MeshCommand {
  return exit
    ? { bin: 'tailscale', args: ['set', '--advertise-exit-node=true'], timeoutMs: T }
    : { bin: 'tailscale', args: ['set', `--advertise-routes=${routes.join(',')}`], timeoutMs: T };
}

const HANDLERS: Partial<Record<NetworkSetupStepKind, MeshStepHandler>> = {
  'mesh.up': upHandler,
  'mesh.dns': dnsHandler,
  'mesh.routes': routesHandler(false),
  'mesh.exitnode': routesHandler(true),
};

export class TailscaleAdapter implements MeshAdapter {
  readonly provider = 'tailscale' as const;

  async detect(exec: MeshExec): Promise<MeshDetectionView> {
    const v = await exec.run({ bin: 'tailscale', args: ['version'], timeoutMs: T });
    if (v.error === 'not_found') return emptyDetection('tailscale', 'tailscale is not installed');
    if (v.code !== 0) return emptyDetection('tailscale', firstLine(v.stderr) ?? 'tailscale failed');
    const version = firstLine(v.stdout);
    const s = await exec.run(STATUS);
    if (!s.stdout.trim().startsWith('{')) {
      return {
        ...emptyDetection('tailscale', firstLine(s.stderr) ?? 'tailscaled is not running'),
        installed: true,
        version,
      };
    }
    return parseTailscaleStatus(s.stdout, await readPrefs(exec), version);
  }

  handler(kind: NetworkSetupStepKind): MeshStepHandler | null {
    return HANDLERS[kind] ?? null;
  }

  /**
   * A certificate for the Hub's mesh name (`tailscale cert`), for the trust area's mesh path.
   * Both PEMs come back on stdout and are never logged or stored here.
   */
  async certificate(
    exec: MeshExec,
    host: string,
  ): Promise<{ certPem: string; keyPem: string; notAfter: string }> {
    if (!/^[a-z0-9.-]{1,253}$/i.test(host)) throw new Error('not a host name');
    const r = await exec.must({
      bin: 'tailscale',
      args: ['cert', '--cert-file=-', '--key-file=-', host],
      secretOutput: true,
      timeoutMs: 120_000,
    });
    const blocks = r.stdout.match(/-----BEGIN [A-Z ]+-----[\s\S]+?-----END [A-Z ]+-----\n?/g) ?? [];
    const keyPem = blocks.find((b) => /PRIVATE KEY/.test(b));
    const certPem = blocks.filter((b) => /CERTIFICATE/.test(b)).join('');
    if (!keyPem || !certPem) throw new Error('tailscale cert printed no certificate and key');
    const notAfter = new Date(new X509Certificate(certPem).validTo).toISOString();
    return { certPem, keyPem, notAfter };
  }
}

export function firstLine(text: string): string | null {
  return (
    text
      .trim()
      .split('\n')
      .map((l) => l.trim())
      .find(Boolean) ?? null
  );
}
