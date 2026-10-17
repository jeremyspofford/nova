// Plain WireGuard (docs/22 §2.2, for minimalists): the Hub's key pair is made with node:crypto
// (X25519, the curve WireGuard uses) and kept in the vault; the plan shows the public key the
// peers need. `wg-quick` reads the private key from its config file, so while the interface is
// configured that file (0600, in a 0700 folder under the data folder) holds it: wg-quick has no
// other way in. No command line ever carries it.
import { createPrivateKey, createPublicKey, generateKeyPairSync } from 'node:crypto';
import { copyFile, mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { SecretStore } from '@nova/secrets';
import type { MeshDetectionView, NetworkSetupStepKind } from '@nova/shared';
import type { MeshCommand, MeshExec } from './runner.ts';
import { firstLine } from './tailscale.ts';
import {
  check,
  emptyDetection,
  type MeshAdapter,
  type MeshStepHandler,
  type MeshStepContext,
} from './types.ts';

const PKCS8_X25519 = Buffer.from('302e020100300506032b656e04220420', 'hex');

export function wireguardKeyRef(iface: string): string {
  return `secret://network/wireguard/${iface}/private-key`;
}

/** The public key (base64) of a WireGuard private key (base64). */
export function wireguardPublicKey(privateKey: string): string {
  const raw = Buffer.from(privateKey, 'base64');
  if (raw.length !== 32) throw new Error('a WireGuard key is 32 bytes');
  const key = createPrivateKey({
    key: Buffer.concat([PKCS8_X25519, raw]),
    format: 'der',
    type: 'pkcs8',
  });
  const jwk = createPublicKey(key).export({ format: 'jwk' });
  if (!jwk.x) throw new Error('no public key');
  return Buffer.from(jwk.x, 'base64url').toString('base64');
}

/** The Hub's key for `iface`, created in the vault on first use. */
export async function ensureWireguardKey(
  secrets: SecretStore,
  iface: string,
): Promise<{ ref: string; publicKey: string }> {
  const ref = wireguardKeyRef(iface);
  let priv = await secrets.get(ref);
  if (!priv) {
    const jwk = generateKeyPairSync('x25519').privateKey.export({ format: 'jwk' });
    if (!jwk.d) throw new Error('key generation failed');
    priv = Buffer.from(jwk.d, 'base64url').toString('base64');
    await secrets.put(ref, priv);
  }
  return { ref, publicKey: wireguardPublicKey(priv) };
}

export interface WireguardPeer {
  name?: string;
  publicKey: string;
  allowedIps: string[];
  endpoint?: string;
}

export interface WireguardParams {
  iface: string;
  address: string;
  listenPort: number;
  dns: string[];
  peers: WireguardPeer[];
  keyRef: string;
  configPath: string;
}

export function wireguardConfigPath(dataDir: string, iface: string): string {
  return join(dataDir, 'network', 'wireguard', `${iface}.conf`);
}

/** The wg-quick config. The private key is only added when the file is written. */
export function wireguardConfig(p: WireguardParams, privateKey: string): string {
  const lines = ['[Interface]', `PrivateKey = ${privateKey}`, `Address = ${p.address}`];
  lines.push(`ListenPort = ${p.listenPort}`);
  if (p.dns.length) lines.push(`DNS = ${p.dns.join(', ')}`);
  for (const peer of p.peers) {
    lines.push('', '[Peer]');
    if (peer.name) lines.push(`# ${peer.name}`);
    lines.push(`PublicKey = ${peer.publicKey}`, `AllowedIPs = ${peer.allowedIps.join(', ')}`);
    if (peer.endpoint) lines.push(`Endpoint = ${peer.endpoint}`, 'PersistentKeepalive = 25');
  }
  return lines.join('\n') + '\n';
}

const show = (iface: string): MeshCommand => ({
  bin: 'wg',
  args: ['show', iface],
  timeoutMs: 15_000,
});
const quick = (verb: 'up' | 'down', path: string): MeshCommand => ({
  bin: 'wg-quick',
  args: [verb, path],
  timeoutMs: 60_000,
});

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  );
}

async function writeConfig(ctx: MeshStepContext, p: WireguardParams): Promise<void> {
  const key = await ctx.secrets.get(p.keyRef);
  if (key === null) throw new Error('the WireGuard key is missing from the vault');
  await mkdir(dirname(p.configPath), { recursive: true, mode: 0o700 });
  await writeFile(p.configPath, wireguardConfig(p, key), { mode: 0o600 });
}

const upHandler: MeshStepHandler = {
  async snapshot(step, ctx) {
    const p = step.params as unknown as WireguardParams;
    const up = (await ctx.exec.run(show(p.iface))).code === 0;
    const existed = await exists(p.configPath);
    const backup = `${p.configPath}.previous`;
    if (existed) await copyFile(p.configPath, backup);
    return { up, existed, backup: existed ? backup : null };
  },
  async apply(step, ctx, snap) {
    const p = step.params as unknown as WireguardParams;
    if (snap.up === true) await ctx.exec.must(quick('down', p.configPath));
    await writeConfig(ctx, p);
    await ctx.exec.must(quick('up', p.configPath));
  },
  async verify(step, ctx) {
    const p = step.params as unknown as WireguardParams;
    const r = await ctx.exec.run(show(p.iface));
    return [check(`WireGuard interface ${p.iface}`, r.code === 0, firstLine(r.stderr))];
  },
  undoCommands(step, snap) {
    const p = step.params as unknown as WireguardParams;
    const out = [quick('down', p.configPath)];
    if (snap.up === true && snap.existed === true) out.push(quick('up', p.configPath));
    return out;
  },
  async undo(step, ctx, snap) {
    const p = step.params as unknown as WireguardParams;
    await ctx.exec.run(quick('down', p.configPath));
    if (snap.existed === true && typeof snap.backup === 'string') {
      await copyFile(snap.backup, p.configPath);
      await rm(snap.backup, { force: true });
      if (snap.up === true) await ctx.exec.must(quick('up', p.configPath));
    } else {
      await rm(p.configPath, { force: true });
    }
  },
};

export class WireguardAdapter implements MeshAdapter {
  readonly provider = 'wireguard' as const;

  async detect(exec: MeshExec): Promise<MeshDetectionView> {
    const v = await exec.run({ bin: 'wg', args: ['--version'], timeoutMs: 15_000 });
    if (v.error === 'not_found' || v.code !== 0)
      return emptyDetection('wireguard', firstLine(v.stderr) ?? 'wg is not installed');
    const version = /v[\d.]+/.exec(v.stdout)?.[0] ?? firstLine(v.stdout);
    const s = await exec.run({ bin: 'wg', args: ['show', 'interfaces'], timeoutMs: 15_000 });
    const ifaces = s.code === 0 ? s.stdout.trim().split(/\s+/).filter(Boolean) : [];
    return {
      ...emptyDetection(
        'wireguard',
        s.code === 0 ? null : (firstLine(s.stderr) ?? 'interfaces unreadable (needs root)'),
      ),
      installed: true,
      version,
      loggedIn: ifaces.length > 0,
      state: s.code === 0 ? `interfaces: ${ifaces.join(' ') || 'none'}` : null,
    };
  }

  handler(kind: NetworkSetupStepKind): MeshStepHandler | null {
    return kind === 'mesh.up' ? upHandler : null;
  }
}
