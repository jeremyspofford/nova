// Installing a mesh client with the OS package manager (docs/22 §6 step 2): the plan names the
// exact command (apt, dnf, brew or winget); it runs only with `network.setup.allowSystemChanges`
// and the owner's consent. Undo removes the package only when this step installed it.
import type { MeshStepHandler, MeshStepPlan } from './types.ts';
import { check, runAll } from './types.ts';
import type { PackageManager } from './detect.ts';
import type { MeshCommand } from './runner.ts';

export type InstallableClient = 'tailscale' | 'netbird' | 'wireguard';

const PACKAGES: Record<InstallableClient, Record<PackageManager, string>> = {
  tailscale: {
    apt: 'tailscale',
    dnf: 'tailscale',
    brew: 'tailscale',
    winget: 'Tailscale.Tailscale',
  },
  netbird: {
    apt: 'netbird',
    dnf: 'netbird',
    brew: 'netbirdio/tap/netbird',
    winget: 'Netbird.Netbird',
  },
  wireguard: {
    apt: 'wireguard-tools',
    dnf: 'wireguard-tools',
    brew: 'wireguard-tools',
    winget: 'WireGuard.WireGuard',
  },
};

/** The command that tells whether a client is installed (exit 0). */
export function versionCommand(client: InstallableClient): MeshCommand {
  if (client === 'wireguard') return { bin: 'wg', args: ['--version'], timeoutMs: 10_000 };
  return { bin: client, args: ['version'], timeoutMs: 10_000 };
}

const INSTALL_TIMEOUT_MS = 10 * 60_000;

export function installCommand(pm: PackageManager, client: InstallableClient): MeshCommand {
  const pkg = PACKAGES[client][pm];
  switch (pm) {
    case 'apt':
      return {
        bin: 'apt-get',
        args: ['install', '-y', '--no-install-recommends', pkg],
        env: { DEBIAN_FRONTEND: 'noninteractive' },
        timeoutMs: INSTALL_TIMEOUT_MS,
      };
    case 'dnf':
      return { bin: 'dnf', args: ['install', '-y', pkg], timeoutMs: INSTALL_TIMEOUT_MS };
    case 'brew':
      return { bin: 'brew', args: ['install', pkg], timeoutMs: INSTALL_TIMEOUT_MS };
    case 'winget':
      return {
        bin: 'winget',
        args: [
          'install',
          '--exact',
          '--id',
          pkg,
          '--silent',
          '--accept-package-agreements',
          '--accept-source-agreements',
        ],
        timeoutMs: INSTALL_TIMEOUT_MS,
      };
  }
}

export function removeCommand(pm: PackageManager, client: InstallableClient): MeshCommand {
  const pkg = PACKAGES[client][pm];
  switch (pm) {
    case 'apt':
      return {
        bin: 'apt-get',
        args: ['remove', '-y', pkg],
        env: { DEBIAN_FRONTEND: 'noninteractive' },
        timeoutMs: INSTALL_TIMEOUT_MS,
      };
    case 'dnf':
      return { bin: 'dnf', args: ['remove', '-y', pkg], timeoutMs: INSTALL_TIMEOUT_MS };
    case 'brew':
      return { bin: 'brew', args: ['uninstall', pkg], timeoutMs: INSTALL_TIMEOUT_MS };
    case 'winget':
      return {
        bin: 'winget',
        args: ['uninstall', '--exact', '--id', pkg, '--silent'],
        timeoutMs: INSTALL_TIMEOUT_MS,
      };
  }
}

/** The `client.install` step, or a skip/manual step when it is installed or no manager is known. */
export function planInstall(
  client: InstallableClient,
  installed: boolean,
  pm: PackageManager | null,
  wanted: boolean,
): MeshStepPlan {
  const base = {
    kind: 'client.install' as const,
    provider: client,
    params: { client, packageManager: pm },
    affects: [],
    // Removing the client package takes the mesh down with it.
    undoAffects: ['mesh' as const],
    expects: [],
  };
  const name = client === 'wireguard' ? 'WireGuard tools' : `the ${title(client)} client`;
  if (installed) {
    return {
      ...base,
      mode: 'skip',
      title: `${title(client)} is installed`,
      description: `${name} is already installed on the Hub.`,
      commands: [],
      systemChange: false,
    };
  }
  if (!pm || !wanted) {
    return {
      ...base,
      mode: 'manual',
      title: `Install ${name}`,
      description: pm
        ? `Install ${name} on the Hub, then run detection again.`
        : `No package manager Nova can use was found (apt, dnf, Homebrew or winget). Install ${name} on the Hub, then run detection again.`,
      commands: [],
      systemChange: false,
    };
  }
  const cmd = installCommand(pm, client);
  return {
    ...base,
    mode: 'change',
    title: `Install ${name}`,
    description: `Install ${name} on the Hub with ${pm}: ${[cmd.bin, ...cmd.args].join(' ')}. Rolling back removes it again.`,
    commands: [cmd],
    systemChange: true,
  };
}

export const installHandler: MeshStepHandler = {
  async snapshot(step, ctx) {
    const client = step.params.client as InstallableClient;
    const r = await ctx.exec.run(versionCommand(client));
    return { installed: r.code === 0 };
  },
  async apply(step, ctx) {
    await runAll(ctx, step.commands);
  },
  async verify(step, ctx) {
    const client = step.params.client as InstallableClient;
    const r = await ctx.exec.run(versionCommand(client));
    return [check(`${client} installed`, r.code === 0, r.code === 0 ? null : 'not found')];
  },
  undoCommands(step, snapshot) {
    const pm = step.params.packageManager as PackageManager | null;
    if (snapshot.installed === true || !pm) return [];
    return [removeCommand(pm, step.params.client as InstallableClient)];
  },
};

export function title(p: string): string {
  if (p === 'netbird') return 'NetBird';
  if (p === 'wireguard') return 'WireGuard';
  if (p === 'headscale') return 'Headscale';
  return 'Tailscale';
}
