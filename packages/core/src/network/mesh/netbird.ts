// The NetBird client adapter (docs/22 §2.2: self-hosted and mobile-friendly). Reads
// `netbird status --json`; `netbird up --management-url … --hostname …` joins with the setup key
// in the NB_SETUP_KEY environment variable (never argv). Routes, DNS and exit nodes are set in the
// NetBird management service, so the assistant describes them instead of changing them.
import type { MeshDetectionView, MeshPeerView, NetworkSetupStepKind } from '@nova/shared';
import type { MeshCommand, MeshExec } from './runner.ts';
import { firstLine } from './tailscale.ts';
import {
  asRecord,
  asString,
  check,
  emptyDetection,
  parseJson,
  runAll,
  type MeshAdapter,
  type MeshStepHandler,
} from './types.ts';

const T = 15_000;
const STATUS: MeshCommand = { bin: 'netbird', args: ['status', '--json'], timeoutMs: T };

export const NETBIRD_DEFAULT_MANAGEMENT = 'https://api.netbird.io:443';

export function parseNetbirdStatus(text: string, version: string | null): MeshDetectionView | null {
  const v = parseJson(text);
  if (!v || typeof v !== 'object') return null;
  const st = asRecord(v);
  const mgmt = asRecord(st.management);
  const ip = asString(st.netbirdIp)?.split('/')[0] ?? null;
  const details = asRecord(st.peers).details;
  const peers: MeshPeerView[] = (Array.isArray(details) ? details : []).map((d) => {
    const p = asRecord(d);
    const fqdn = asString(p.fqdn);
    const pip = asString(p.netbirdIp)?.split('/')[0];
    return {
      name: fqdn?.split('.')[0] ?? '',
      dnsName: fqdn,
      ips: pip ? [pip] : [],
      online: p.status === 'Connected',
      os: null,
      tags: [],
    };
  });
  const connected = mgmt.connected === true;
  return {
    provider: 'netbird',
    installed: true,
    version: version ?? asString(st.cliVersion),
    loggedIn: connected,
    state: connected ? 'Connected' : (asString(mgmt.error) ?? 'Disconnected'),
    controlUrl: asString(mgmt.url),
    ips: ip ? [ip] : [],
    dnsName: asString(st.fqdn),
    tags: [],
    peers,
    routes: [],
    exitNode: false,
    detail: null,
  };
}

export interface NetbirdUpParams {
  managementUrl: string;
  hostname: string;
  setupKeyRef: string;
}

export function netbirdUpCommand(p: NetbirdUpParams): MeshCommand {
  return {
    bin: 'netbird',
    args: ['up', '--management-url', p.managementUrl, '--hostname', p.hostname],
    env: { NB_SETUP_KEY: { secretRef: p.setupKeyRef } },
    timeoutMs: 120_000,
  };
}

async function status(exec: MeshExec): Promise<MeshDetectionView | null> {
  const r = await exec.run(STATUS);
  return parseNetbirdStatus(r.stdout, null);
}

const upHandler: MeshStepHandler = {
  async snapshot(_step, ctx) {
    const st = await status(ctx.exec);
    return { loggedIn: st?.loggedIn ?? false, managementUrl: st?.controlUrl ?? null };
  },
  async apply(step, ctx) {
    await runAll(ctx, step.commands);
  },
  async verify(_step, ctx) {
    const st = await status(ctx.exec);
    return [
      check('NetBird connected', st?.loggedIn === true, st?.state ?? 'no status'),
      check('NetBird address', (st?.ips.length ?? 0) > 0),
    ];
  },
  undoCommands(_step, snap) {
    return snap.loggedIn === true ? [] : [{ bin: 'netbird', args: ['down'], timeoutMs: T }];
  },
};

export class NetbirdAdapter implements MeshAdapter {
  readonly provider = 'netbird' as const;

  async detect(exec: MeshExec): Promise<MeshDetectionView> {
    const v = await exec.run({ bin: 'netbird', args: ['version'], timeoutMs: T });
    if (v.error === 'not_found' || v.code !== 0)
      return emptyDetection('netbird', firstLine(v.stderr) ?? 'netbird is not installed');
    const version = firstLine(v.stdout);
    const s = await exec.run(STATUS);
    return (
      parseNetbirdStatus(s.stdout, version) ?? {
        ...emptyDetection('netbird', firstLine(s.stderr) ?? 'the NetBird service did not answer'),
        installed: true,
        version,
      }
    );
  }

  handler(kind: NetworkSetupStepKind): MeshStepHandler | null {
    return kind === 'mesh.up' ? upHandler : null;
  }
}
