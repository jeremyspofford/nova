// The Network Setup plan (FR-136, docs/22 §6 steps 2-7): from the owner's choices and what
// detection found, the ordered steps for one provider. Each step says exactly what it runs, what
// transports it could cut (for the lock-out guard) and which must pass a reachability test after
// it. Steps a provider cannot carry out from the Hub are `manual` (described, never run).
import { NovaError } from '@nova/shared';
import type {
  MeshDetectionView,
  MeshProvider,
  NetworkDetectionView,
  NetworkSetupOptions,
  NetworkSetupTransport,
} from '@nova/shared';
import { ipv4ToInt } from '../mesh/detect.ts';
import {
  LOCAL_HEADSCALE,
  headscaleApproveCommand,
  headscaleCommand,
  policyPaths,
  type HeadscaleCli,
  type HeadscaleStepParams,
} from '../mesh/headscale.ts';
import { planInstall, title } from '../mesh/install.ts';
import { NETBIRD_DEFAULT_MANAGEMENT, netbirdUpCommand } from '../mesh/netbird.ts';
import { previewCommand } from '../mesh/runner.ts';
import {
  advertise,
  sameUrl,
  tailscaleKeyPath,
  tailscaleUpCommand,
  type TailscaleRoutesParams,
  type TailscaleUpParams,
} from '../mesh/tailscale.ts';
import { emptyDetection, type JsonObject, type MeshStepPlan } from '../mesh/types.ts';
import { ufwAllow, type FirewallRule } from '../mesh/ufw.ts';
import { wireguardConfigPath, type WireguardParams } from '../mesh/wireguard.ts';

export interface SetupPlanContext {
  runId: string;
  dataDir: string;
  hubPort: number;
  platform: NodeJS.Platform;
  detection: NetworkDetectionView;
  /** This run's write-only secrets, already in the vault. */
  secretRefs: { authKey: string | null; headscaleApiKey: string | null };
  /** WireGuard: the Hub's key (vault ref and public key). */
  wireguardKey: { ref: string; publicKey: string } | null;
}

export const DEFAULT_MESH_HOSTNAME = 'nova-hub';
export const DEFAULT_MESH_TAGS = ['tag:nova-hub'];
const TAILSCALE_CONTROL = 'https://controlplane.tailscale.com';

export function preauthKeyRef(runId: string): string {
  return `secret://network/setup/${runId}/preauth-key`;
}

function bad(reason: string, message: string, details: Record<string, unknown> = {}): NovaError {
  return new NovaError('validation', message, { details: { reason, ...details } });
}

function meshOf(d: NetworkDetectionView, p: MeshProvider): MeshDetectionView {
  return d.meshes.find((m) => m.provider === p) ?? emptyDetection(p, 'not detected');
}

function argv(cmd: Parameters<typeof previewCommand>[0]): string {
  return previewCommand(cmd).join(' ');
}

function step(p: Omit<MeshStepPlan, 'params'> & { params?: JsonObject }): MeshStepPlan {
  return { ...p, params: p.params ?? {} };
}

/** The ordered steps for `provider`; throws `validation`/`conflict` for unusable choices. */
export function planNetworkSetup(
  provider: MeshProvider,
  options: NetworkSetupOptions,
  ctx: SetupPlanContext,
): MeshStepPlan[] {
  switch (provider) {
    case 'headscale':
      return planHeadscale(options, ctx);
    case 'tailscale':
      return planTailscale(options, ctx);
    case 'netbird':
      return planNetbird(options, ctx);
    case 'wireguard':
      return planWireguard(options, ctx);
  }
}

// A client already logged in somewhere else is not taken over unless the owner says so: the old
// login cannot be restored by a rollback.
function inUse(m: MeshDetectionView, already: boolean, options: NetworkSetupOptions): void {
  if (m.loggedIn && !already && !options.replaceExisting) {
    throw new NovaError(
      'conflict',
      `${title(m.provider)} on the Hub is already joined to ${m.controlUrl ?? 'another network'}; set replaceExisting to move it`,
      { details: { reason: 'mesh_in_use', controlUrl: m.controlUrl } },
    );
  }
}

function planHeadscale(options: NetworkSetupOptions, ctx: SetupPlanContext): MeshStepPlan[] {
  const controlUrl = options.controlUrl;
  if (!controlUrl)
    throw bad('control_url_required', 'the Headscale server URL (controlUrl) is required');
  const ts = meshOf(ctx.detection, 'tailscale');
  const hs = meshOf(ctx.detection, 'headscale');
  const cli: HeadscaleCli = options.headscale?.cliAddress
    ? { cliAddress: options.headscale.cliAddress, apiKeyRef: ctx.secretRefs.headscaleApiKey }
    : LOCAL_HEADSCALE;
  const server = cli.cliAddress !== null || (hs.installed && hs.loggedIn);
  if (!server && !ctx.secretRefs.authKey) {
    throw bad(
      'headscale_unavailable',
      "Nova cannot reach the Headscale server's CLI: run the Hub where Headscale runs, give its address and an API key, or paste a pre-auth key",
    );
  }
  if (cli.cliAddress && !cli.apiKeyRef)
    throw bad('api_key_required', 'a remote Headscale needs its API key');
  const hostname = options.hostname ?? DEFAULT_MESH_HOSTNAME;
  const tags = options.tags ?? DEFAULT_MESH_TAGS;
  const user = options.headscale?.user ?? 'nova';
  const already = ts.loggedIn && sameUrl(ts.controlUrl, controlUrl);
  inUse(ts, already, options);
  const hsParams: HeadscaleStepParams = { cli, user, tags, port: ctx.hubPort };
  const where = cli.cliAddress
    ? `the Headscale server at ${cli.cliAddress}`
    : 'the local Headscale';
  const out: MeshStepPlan[] = [
    planInstall(
      'tailscale',
      ts.installed,
      ctx.detection.packageManager,
      options.installClient ?? true,
    ),
  ];
  const keyRef = server ? preauthKeyRef(ctx.runId) : (ctx.secretRefs.authKey ?? '');
  if (server) {
    const create = headscaleCommand(cli, ['users', 'create', user]);
    out.push(
      step({
        kind: 'server.user',
        provider: 'headscale',
        mode: 'change',
        title: `Headscale user ${user}`,
        description: `Create the user ${user} on ${where} if it does not exist (${argv(create)}). Rolling back deletes it again if this step created it.`,
        commands: [create],
        params: { ...hsParams },
        affects: [],
        undoAffects: ['mesh'],
        expects: [],
        systemChange: true,
      }),
    );
    if (options.headscale?.acl !== false) {
      const file = policyPaths(ctx.dataDir, ctx.runId).next;
      const set = headscaleCommand(cli, ['policy', 'set', '--file', file]);
      out.push(
        step({
          kind: 'server.acl',
          provider: 'headscale',
          mode: 'change',
          title: 'Tags and access rules',
          description: `Update the ACL policy on ${where}: make ${user}@ the owner of ${tags.join(', ')} and allow every node to reach ${tags.join(', ')} on TCP ${ctx.hubPort}; existing rules are kept (no policy yet means allow-all, which stays). The previous policy is saved for rollback (${argv(headscaleCommand(cli, ['policy', 'set', '--file', '<new policy file>']))}).`,
          commands: [set],
          params: { ...hsParams },
          affects: ['mesh'],
          undoAffects: ['mesh'],
          expects: [],
          systemChange: true,
        }),
      );
    }
    out.push(
      step({
        kind: 'server.authkey',
        provider: 'headscale',
        mode: already ? 'skip' : 'change',
        title: 'One-use pre-auth key',
        description: already
          ? 'The Hub is already on this Headscale server; no key is needed.'
          : `Create a one-use pre-auth key for ${user} on ${where}, tagged ${tags.join(', ')} and valid for one hour; it goes straight into the Hub's vault.`,
        commands: [
          headscaleCommand(cli, [
            'preauthkeys',
            'create',
            '--user',
            `<id of ${user}>`,
            '--expiration',
            '1h',
            '--tags',
            tags.join(','),
            '-o',
            'json',
          ]),
        ],
        params: { ...hsParams, keyRef },
        affects: [],
        undoAffects: [],
        expects: [],
        systemChange: true,
      }),
    );
  }
  out.push(
    ...tailscaleClientSteps(options, ctx, {
      ts,
      already,
      loginServer: controlUrl,
      keyRef,
      hostname,
      tags,
      headscale: server ? { ...cli, hostname } : null,
      networkName: `the Headscale server ${controlUrl}`,
    }),
  );
  const certs = options.certs ?? 'auto';
  if (certs === 'mesh')
    throw bad('mesh_certs_unavailable', 'Headscale cannot issue mesh certificates; use local-ca');
  out.push(
    ...hubSteps(options, ctx, 'headscale', certs === 'none' ? null : 'local-ca', 'tailscale0'),
  );
  return out;
}

interface ClientInput {
  ts: MeshDetectionView;
  already: boolean;
  loginServer: string | null;
  keyRef: string;
  hostname: string;
  tags: string[];
  headscale: (HeadscaleCli & { hostname: string }) | null;
  networkName: string;
}

function tailscaleClientSteps(
  options: NetworkSetupOptions,
  ctx: SetupPlanContext,
  c: ClientInput,
): MeshStepPlan[] {
  const magicDns = options.magicDns ?? true;
  const up: TailscaleUpParams = {
    loginServer: c.loginServer,
    hostname: c.hostname,
    tags: c.tags,
    acceptDns: magicDns,
    authKeyRef: c.keyRef,
    reset: c.ts.loggedIn && !c.already,
    keyFile: ctx.platform === 'win32',
  };
  const upCmd = tailscaleUpCommand(
    up,
    up.keyFile ? tailscaleKeyPath(ctx.dataDir, ctx.runId) : null,
  );
  // What the owner reads and consents to never carries a run-specific path.
  const shownUp = tailscaleUpCommand(up, up.keyFile ? '<key file>' : null);
  const out: MeshStepPlan[] = [
    step({
      kind: 'mesh.up',
      provider: 'tailscale',
      mode: c.already ? 'skip' : 'change',
      title: `Join ${c.networkName}`,
      description: c.already
        ? `The Hub is already joined to ${c.networkName}.`
        : `Join the Hub to ${c.networkName} as ${c.hostname}${c.tags.length ? ` with ${c.tags.join(', ')}` : ''}, ${magicDns ? 'accepting' : 'ignoring'} MagicDNS, using the stored key (${argv(shownUp)}).${c.ts.loggedIn ? ` This replaces its login to ${c.ts.controlUrl ?? 'another network'}, which a rollback cannot restore.` : ' Rolling back logs it out again.'}`,
      commands: [upCmd],
      params: { ...up },
      affects: c.ts.loggedIn ? ['mesh'] : [],
      undoAffects: ['mesh'],
      expects: ['mesh'],
      systemChange: true,
    }),
  ];
  if (magicDns) {
    const set = { bin: 'tailscale', args: ['set', '--accept-dns=true'] };
    const serverNote = c.headscale
      ? ' MagicDNS names come from the Headscale server setting dns.magic_dns, which Nova does not edit.'
      : '';
    out.push(
      step({
        kind: 'mesh.dns',
        provider: 'tailscale',
        mode: c.already ? 'change' : 'skip',
        title: 'MagicDNS',
        description: c.already
          ? `Accept MagicDNS names on the Hub (${argv(set)}).${serverNote}`
          : `MagicDNS is accepted when the Hub joins.${serverNote}`,
        commands: c.already ? [set] : [],
        affects: [],
        undoAffects: [],
        expects: [],
        systemChange: c.already,
      }),
    );
  }
  const routes = options.advertiseRoutes ?? [];
  if (routes.length) {
    const params: TailscaleRoutesParams = { routes, headscale: c.headscale };
    const cmds = [advertise(false, routes)];
    if (c.headscale) cmds.push(headscaleApproveCommand(c.headscale, '<node id>', routes));
    out.push(
      step({
        kind: 'mesh.routes',
        provider: 'tailscale',
        mode: 'change',
        title: 'Subnet routes',
        description: `Advertise ${routes.join(', ')} from the Hub to the mesh${c.headscale ? ' and approve them on the Headscale server' : '; approve them in the network admin console afterwards'} (${cmds.map(argv).join('; ')}). Rolling back restores the previous routes.`,
        commands: cmds,
        params: { ...params },
        affects: [],
        undoAffects: [],
        expects: [],
        systemChange: true,
      }),
    );
  }
  if (options.exitNode) {
    const exit = ['0.0.0.0/0', '::/0'];
    const params: TailscaleRoutesParams = { routes: exit, headscale: c.headscale };
    const cmds = [advertise(true, [])];
    if (c.headscale) cmds.push(headscaleApproveCommand(c.headscale, '<node id>', exit));
    out.push(
      step({
        kind: 'mesh.exitnode',
        provider: 'tailscale',
        mode: 'change',
        title: 'Exit node',
        description: `Offer the Hub as an exit node${c.headscale ? ' and approve it on the Headscale server' : '; approve it in the network admin console afterwards'} (${cmds.map(argv).join('; ')}). Rolling back stops offering it.`,
        commands: cmds,
        params: { ...params },
        affects: [],
        undoAffects: [],
        expects: [],
        systemChange: true,
      }),
    );
  }
  return out;
}

function planTailscale(options: NetworkSetupOptions, ctx: SetupPlanContext): MeshStepPlan[] {
  const ts = meshOf(ctx.detection, 'tailscale');
  const loginServer = options.controlUrl ?? null;
  const already =
    ts.loggedIn && sameUrl(ts.controlUrl ?? TAILSCALE_CONTROL, loginServer ?? TAILSCALE_CONTROL);
  inUse(ts, already, options);
  if (!already && !ctx.secretRefs.authKey)
    throw bad('auth_key_required', 'a Tailscale auth key (authKey) is required to join');
  const hostname = options.hostname ?? DEFAULT_MESH_HOSTNAME;
  const tags = options.tags ?? DEFAULT_MESH_TAGS;
  const certs = options.certs ?? 'auto';
  return [
    planInstall(
      'tailscale',
      ts.installed,
      ctx.detection.packageManager,
      options.installClient ?? true,
    ),
    ...tailscaleClientSteps(options, ctx, {
      ts,
      already,
      loginServer,
      keyRef: ctx.secretRefs.authKey ?? '',
      hostname,
      tags,
      headscale: null,
      networkName: loginServer ? `the tailnet at ${loginServer}` : 'your tailnet',
    }),
    ...hubSteps(
      options,
      ctx,
      'tailscale',
      certs === 'none' ? null : certs === 'local-ca' ? 'local-ca' : 'mesh',
      'tailscale0',
    ),
  ];
}

function manual(
  kind: MeshStepPlan['kind'],
  provider: MeshStepPlan['provider'],
  titleText: string,
  description: string,
): MeshStepPlan {
  return step({
    kind,
    provider,
    mode: 'manual',
    title: titleText,
    description,
    commands: [],
    affects: [],
    undoAffects: [],
    expects: [],
    systemChange: false,
  });
}

function planNetbird(options: NetworkSetupOptions, ctx: SetupPlanContext): MeshStepPlan[] {
  const nb = meshOf(ctx.detection, 'netbird');
  const managementUrl = options.controlUrl ?? NETBIRD_DEFAULT_MANAGEMENT;
  const already = nb.loggedIn && sameUrl(nb.controlUrl, managementUrl);
  inUse(nb, already, options);
  if (!already && !ctx.secretRefs.authKey)
    throw bad('auth_key_required', 'a NetBird setup key (authKey) is required to join');
  const hostname = options.hostname ?? DEFAULT_MESH_HOSTNAME;
  const up = { managementUrl, hostname, setupKeyRef: ctx.secretRefs.authKey ?? '' };
  const cmd = netbirdUpCommand(up);
  const out: MeshStepPlan[] = [
    planInstall(
      'netbird',
      nb.installed,
      ctx.detection.packageManager,
      options.installClient ?? true,
    ),
    step({
      kind: 'mesh.up',
      provider: 'netbird',
      mode: already ? 'skip' : 'change',
      title: `Join NetBird at ${managementUrl}`,
      description: already
        ? `The Hub is already connected to NetBird at ${managementUrl}.`
        : `Connect the Hub to NetBird at ${managementUrl} as ${hostname} with the stored setup key (${argv(cmd)}).${nb.loggedIn ? ` This replaces its connection to ${nb.controlUrl ?? 'another network'}.` : ' Rolling back disconnects it again.'}`,
      commands: [cmd],
      params: { ...up },
      affects: nb.loggedIn ? ['mesh'] : [],
      undoAffects: ['mesh'],
      expects: ['mesh'],
      systemChange: true,
    }),
  ];
  if (options.magicDns ?? true)
    out.push(
      manual(
        'mesh.dns',
        'netbird',
        'DNS names',
        'NetBird DNS names come from the management service (DNS settings in its dashboard); the Hub uses them once connected.',
      ),
    );
  if (options.advertiseRoutes?.length)
    out.push(
      manual(
        'mesh.routes',
        'netbird',
        'Subnet routes',
        `Add a network route for ${options.advertiseRoutes.join(', ')} with ${hostname} as its routing peer in the NetBird management service.`,
      ),
    );
  if (options.exitNode)
    out.push(
      manual(
        'mesh.exitnode',
        'netbird',
        'Exit node',
        `Add a 0.0.0.0/0 route with ${hostname} as its routing peer in the NetBird management service.`,
      ),
    );
  const certs = options.certs ?? 'auto';
  if (certs === 'mesh')
    throw bad('mesh_certs_unavailable', 'NetBird has no mesh certificates; use local-ca');
  out.push(...hubSteps(options, ctx, 'netbird', certs === 'none' ? null : 'local-ca', 'wt0'));
  return out;
}

function planWireguard(options: NetworkSetupOptions, ctx: SetupPlanContext): MeshStepPlan[] {
  const wg = options.wireguard;
  if (!wg) throw bad('wireguard_options_required', 'WireGuard needs an address and its peers');
  if (!ctx.wireguardKey) throw new Error('no WireGuard key');
  const det = meshOf(ctx.detection, 'wireguard');
  const iface = wg.interface ?? 'wg-nova';
  const params: WireguardParams = {
    iface,
    address: wg.address,
    listenPort: wg.listenPort ?? 51820,
    dns: wg.dns ?? [],
    peers: wg.peers,
    keyRef: ctx.wireguardKey.ref,
    configPath: wireguardConfigPath(ctx.dataDir, iface),
  };
  const out: MeshStepPlan[] = [
    planInstall(
      'wireguard',
      det.installed,
      ctx.detection.packageManager,
      options.installClient ?? true,
    ),
  ];
  if (ctx.platform === 'win32') {
    out.push(
      manual(
        'mesh.up',
        'wireguard',
        `Bring up ${iface}`,
        `Import a tunnel for ${wg.address} with the Hub's public key ${ctx.wireguardKey.publicKey} in the WireGuard app.`,
      ),
    );
  } else {
    const upCmd = { bin: 'wg-quick', args: ['up', params.configPath] };
    // wg-quick routes every peer's AllowedIPs into the tunnel: a peer that covers the LAN, the
    // mesh range or the internet (0.0.0.0/0, ::/0) can cut those paths to the Hub.
    const routed = wireguardRoutedTransports(
      wg.peers.flatMap((p) => p.allowedIps),
      ctx.detection.subnets,
    );
    const peers = wg.peers
      .map((p) => `${p.name ?? p.publicKey.slice(0, 8)} → ${p.allowedIps.join(', ')}`)
      .join('; ');
    out.push(
      step({
        kind: 'mesh.up',
        provider: 'wireguard',
        mode: 'change',
        title: `Bring up ${iface}`,
        description: `Write the WireGuard config for ${iface} (address ${wg.address}, UDP ${params.listenPort}${wg.dns?.length ? `, DNS ${wg.dns.join(', ')}` : ''}; peers ${peers || 'none'}; the private key comes from the vault and the file is readable by the Hub only) and bring it up (${argv(upCmd)}).${routed.length ? ` Traffic for those addresses then goes through the tunnel, which can cut the ${routed.join(', ')} path${routed.length === 1 ? '' : 's'} to the Hub.` : ''} Rolling back takes it down and restores the previous config.`,
        commands: [upCmd],
        params: { ...params },
        affects: [
          ...new Set<NetworkSetupTransport>([
            ...(det.loggedIn ? ['mesh' as const] : []),
            ...routed,
          ]),
        ],
        undoAffects: ['mesh'],
        expects: ['mesh'],
        systemChange: true,
      }),
    );
  }
  if (options.advertiseRoutes?.length)
    out.push(
      manual(
        'mesh.routes',
        'wireguard',
        'Subnet routes',
        `With plain WireGuard, add ${options.advertiseRoutes.join(', ')} to the AllowedIPs of the peers that should reach them through the Hub, and enable IP forwarding on the Hub.`,
      ),
    );
  if (options.exitNode)
    out.push(
      manual(
        'mesh.exitnode',
        'wireguard',
        'Exit node',
        'With plain WireGuard, a peer uses the Hub as its exit by setting AllowedIPs = 0.0.0.0/0, ::/0; the Hub needs IP forwarding and NAT.',
      ),
    );
  const certs = options.certs ?? 'auto';
  if (certs === 'mesh')
    throw bad('mesh_certs_unavailable', 'WireGuard has no mesh certificates; use local-ca');
  out.push(
    ...hubSteps(options, ctx, 'wireguard', certs === 'none' ? null : 'local-ca', iface, {
      port: params.listenPort,
      proto: 'udp',
      iface: null,
    }),
  );
  return out;
}

/** Certificates, firewall, Relay and the closing reachability test, for every provider. */
function hubSteps(
  options: NetworkSetupOptions,
  ctx: SetupPlanContext,
  provider: MeshProvider,
  certs: 'mesh' | 'local-ca' | null,
  meshIface: string,
  extraRule?: FirewallRule,
): MeshStepPlan[] {
  const out: MeshStepPlan[] = [];
  if (certs) {
    out.push(
      step({
        kind: 'trust.cert',
        provider: 'hub',
        mode: 'change',
        title: certs === 'mesh' ? 'Mesh certificate' : 'Hub local CA',
        description:
          certs === 'mesh'
            ? "Fetch a TLS certificate for the Hub's mesh name from the mesh (tailscale cert) and hand it to the Hub's trust settings."
            : "Make sure the Hub's local certificate authority exists so devices can trust the Hub over HTTPS on the mesh.",
        commands: [],
        params: { mode: certs, provider },
        affects: [],
        undoAffects: [],
        expects: [],
        systemChange: false,
      }),
    );
  }
  if (options.firewall ?? true) {
    const rules: FirewallRule[] = [{ port: ctx.hubPort, proto: 'tcp', iface: meshIface }];
    if (extraRule) rules.push(extraRule);
    const fw = ctx.detection.firewall;
    const ports = rules
      .map((r) => `${r.proto.toUpperCase()} ${r.port}${r.iface ? ` on ${r.iface}` : ''}`)
      .join(' and ');
    if (fw.tool === 'ufw') {
      const cmds = rules.map(ufwAllow);
      out.push(
        step({
          kind: 'firewall.ports',
          provider: 'ufw',
          mode: 'change',
          title: 'Firewall',
          description: `Allow ${ports} in ufw (${cmds.map(argv).join('; ')}). Nothing is denied or removed; rolling back deletes only the rules this step added.`,
          commands: cmds,
          params: { rules },
          affects: [],
          undoAffects: ['mesh'],
          expects: [],
          systemChange: true,
        }),
      );
    } else {
      out.push(
        manual(
          'firewall.ports',
          'hub',
          'Firewall',
          `No firewall Nova can manage was found. The Hub listens on TCP ${ctx.hubPort}; make sure ${ports} is open if a firewall runs on the Hub.`,
        ),
      );
    }
  }
  if (options.relay) {
    out.push(
      step({
        kind: 'relay.enroll',
        provider: 'hub',
        mode: 'change',
        title: 'Relay',
        description: `Enroll the Hub with the Relay at ${options.relay.url} as a fallback path; rolling back restores the previous Relay settings.`,
        commands: [],
        params: { url: options.relay.url },
        affects: [],
        undoAffects: ['relay'],
        expects: ['relay'],
        systemChange: false,
      }),
    );
  }
  out.push(
    step({
      kind: 'reachability',
      provider: 'hub',
      mode: 'check',
      title: 'Reachability test',
      description: `Test that the Hub answers on its mesh address${options.relay ? ' and through the Relay' : ''}; a path that fails is not advertised.`,
      commands: [],
      params: { transports: options.relay ? ['mesh', 'relay'] : ['mesh'], provider },
      affects: [],
      undoAffects: [],
      expects: options.relay ? ['mesh', 'relay'] : ['mesh'],
      systemChange: false,
    }),
  );
  return out;
}

const PRIVATE4: [string, number][] = [
  ['10.0.0.0', 8],
  ['172.16.0.0', 12],
  ['192.168.0.0', 16],
  ['169.254.0.0', 16],
  ['100.64.0.0', 10],
];

function v4Range(cidr: string): [number, number] | null {
  const [addr, bits] = cidr.split('/');
  const n = addr ? ipv4ToInt(addr) : null;
  const b = Number(bits);
  if (n === null || !Number.isInteger(b) || b < 0 || b > 32) return null;
  const size = 2 ** (32 - b);
  const start = Math.floor(n / size) * size;
  return [start, start + size - 1];
}

/**
 * The transports a set of WireGuard AllowedIPs can take over (wg-quick routes them into the
 * tunnel): the LAN when they overlap one of its subnets, the mesh when they overlap the shared
 * mesh range, and the direct and Relay paths when they reach beyond private addresses (a default
 * route, 0.0.0.0/0 or ::/0, takes all of them).
 */
export function wireguardRoutedTransports(
  allowedIps: readonly string[],
  lanSubnets: readonly string[],
): NetworkSetupTransport[] {
  const out = new Set<NetworkSetupTransport>();
  const lans = lanSubnets.map(v4Range).filter((r): r is [number, number] => r !== null);
  const overlaps = (a: [number, number], b: [number, number]) => a[0] <= b[1] && b[0] <= a[1];
  const inside = (a: [number, number], b: [number, number]) => a[0] >= b[0] && a[1] <= b[1];
  const privates = PRIVATE4.map(([n, b]) => v4Range(`${n}/${b}`)!);
  const mesh = v4Range('100.64.0.0/10')!;
  for (const cidr of allowedIps) {
    if (cidr.includes(':')) {
      const [net = '', bitsText = '128'] = cidr.split('/');
      const bits = Number(bitsText);
      const head = parseInt(net.split(':')[0] || '0', 16);
      if (bits <= 3)
        ['lan', 'mesh', 'direct', 'relay'].forEach((x) => out.add(x as NetworkSetupTransport));
      else if (head >= 0xfc00 && head <= 0xfdff) {
        out.add('lan');
        if (head === 0xfd7a) out.add('mesh');
      } else if (head >= 0xfe80 && head <= 0xfebf) out.add('lan');
      else {
        out.add('direct');
        out.add('relay');
      }
      continue;
    }
    const r = v4Range(cidr);
    if (!r) continue;
    if (lans.some((l) => overlaps(r, l))) out.add('lan');
    if (overlaps(r, mesh)) out.add('mesh');
    if (!privates.some((p) => inside(r, p))) {
      out.add('direct');
      out.add('relay');
    }
  }
  const order: NetworkSetupTransport[] = ['lan', 'mesh', 'relay', 'direct'];
  return order.filter((x) => out.has(x));
}
