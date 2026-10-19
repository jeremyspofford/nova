// Shared steps of the M7.5 journey (J9.5): a Hub on every interface opened at this machine's LAN
// address (as J8.5: the Hub builds no install command for a loopback address) that serves the real
// novad build, and a device that joins through Add Device with that build and then runs
// `novad run` with the fake firmware and bootloader backends novad offers for tests
// (`config.json` `firmware: {backend: "fake", fakePath}`, `boot: {backend: "fake", fakePath}`,
// services/novad/README.md), so the Hub <-> novad protocol, the Hub-signed authorizations and
// novad's watchdogs run for real.
//
// What stands in for the machine:
// - The BIOS is novad's fake firmware file and the bootloader its fake bootloader file; the test
//   reads them to see what novad wrote.
// - A restart: novad restarts through its power module, which runs `systemctl reboot` (it needs
//   the owner's `power.allowActions` in config.json, set here). novad runs with a PATH whose first
//   folder holds a fake `systemctl` that only records its arguments, so no machine ever restarts
//   (on a CI runner a real `systemctl reboot` must never run).
// - "The machine never came back": the test stops novad (the Hub hears nothing from it) until the
//   watchdog deadline novad armed (`firmware/pending.json`, `boot/pending.json`; 2 minutes, the
//   shortest window the Hub offers) has passed, then starts it again. The kernel's boot id cannot
//   change in a container, so novad sees that the machine never restarted and reverts with
//   `reason: not_restarted`, the path its README describes; the restart-and-revert path with a new
//   boot id is covered by the Rust tests (firmware.rs, boot.rs).
import { spawn, type ChildProcess } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, type Page } from '@playwright/test';
import { expectNoSeriousA11yIssues } from './a11y.ts';
import { startHub, type RunningHub } from './hub.ts';
import { freePort, lanAddress, novadBinary, novadDistName, run } from './m65.ts';
import { json, until } from './m6.ts';

export const BMC_REDIRECT = resolve('e2e/support/bmc-redirect.ts');
/** The address the owner gives the fake BMC (TEST-NET-1, not one of this machine's). */
export const BMC_STAND_IN = '192.0.2.80';

export interface M75Hub extends RunningHub {
  /** The Hub at the LAN address, where the owner's browser has it open. */
  lan: string;
}

/**
 * A Hub on every interface with the novad build in NOVA_NOVAD_DIST, and with the BMC address
 * redirect (bmc-redirect.ts), set up through onboarding at its LAN address.
 */
export async function setUpM75Hub(page: Page, port: number): Promise<M75Hub> {
  const root = mkdtempSync(join(tmpdir(), 'nova-e2e-m75-'));
  const dist = join(root, 'dist');
  mkdirSync(dist);
  copyFileSync(novadBinary(), join(dist, novadDistName()));
  const hub = await startHub({
    port,
    nodeArgs: ['--import', BMC_REDIRECT],
    env: {
      NOVA_NOVAD_DIST: dist,
      NOVA_HOST: '0.0.0.0',
      NOVA_E2E_BMC_REDIRECT: `${BMC_STAND_IN}=127.0.0.1`,
    },
  });
  const lan = `http://${lanAddress()}:${port}`;
  await page.goto(`${lan}/#setup=${hub.setupCode}`);
  await page.getByRole('button', { name: 'Finish setup' }).click();
  await page.getByRole('button', { name: 'Skip setup' }).click();
  return { ...hub, lan };
}

/** The fake BIOS: novad's fake firmware file (firmware.rs `FakeFirmware`). */
export function fakeFirmware() {
  return {
    platform: {
      vendor: 'Nova Labs',
      product: 'E2E Desk PC',
      biosVendor: 'Nova',
      biosVersion: '1.0.4',
      biosDate: '2026-09-01',
      uefi: true,
    },
    adminPasswordSet: false,
    requiresReboot: true,
    settings: {
      wol: {
        vendorKey: 'WakeOnLan',
        value: 'Disabled',
        type: 'enum',
        allowed: ['Disabled', 'Enabled'],
      },
      powerOnAfterPowerLoss: {
        vendorKey: 'AcPowerRecovery',
        value: 'Off',
        type: 'enum',
        allowed: ['Off', 'On', 'Last'],
      },
      virtualization: {
        vendorKey: 'VirtualizationTechnology',
        value: 'Enabled',
        type: 'enum',
        allowed: ['Disabled', 'Enabled'],
      },
      secureBoot: {
        vendorKey: 'SecureBoot',
        value: 'Enabled',
        type: 'enum',
        allowed: ['Disabled', 'Enabled'],
      },
    },
    failWrites: [],
  };
}

/** The fake bootloader: novad's fake bootloader file (boot.rs `FakeBoot`). */
export function fakeBootloader() {
  return {
    entries: [
      { id: 'nova-6.8.conf', title: 'Nova Linux 6.8' },
      { id: 'nova-6.12-rc.conf', title: 'Nova Linux 6.12 (test kernel)' },
    ],
    default: 'nova-6.8.conf',
    booted: 'nova-6.8.conf',
    oneshot: null,
  };
}

export interface NovadDevice {
  id: string;
  name: string;
  dataDir: string;
  firmwareFile: string;
  bootFile: string;
  /** Arguments of every `systemctl` call novad made (one line each). */
  systemctlCalls(): string[];
  /** A value of the fake BIOS. */
  firmwareValue(key: string): string;
  bootloader(): ReturnType<typeof fakeBootloader>;
  /** novad's copy of the Hub's toggles (`policy.json`), learned from the heartbeat answer. */
  policy(): { firmwareChanges: boolean; lowLevelBoot: boolean };
  /** `novad run` (again). */
  start(): void;
  /** Stop novad (SIGKILL: the machine went away; its modules die with it). */
  stop(): Promise<void>;
  /** What novad printed (for failures). */
  logs(): string;
}

const sidebarLink = (page: Page, name: string) =>
  page.getByRole('navigation', { name: 'Sidebar' }).getByRole('link', { name, exact: true });

/**
 * Devices → Add a device → Compute node → Create code; `novad install` with that code and the
 * Hub's pin (as the one-line command runs it, without the service); the owner types the
 * confirmation novad shows and approves. Then the fake firmware and bootloader are configured in
 * novad's config.json and `novad run` starts.
 */
export async function addNovadDevice(page: Page, hub: M75Hub, name: string): Promise<NovadDevice> {
  const { lan } = hub;
  const { hubFingerprint } = await json<{ hubFingerprint: string }>(
    await page.request.get(`${lan}/api/v1/hello`),
  );
  await sidebarLink(page, 'Devices').click();
  await expect(page.getByRole('heading', { level: 1, name: 'Devices' })).toBeVisible();
  await page.getByRole('button', { name: 'Add device' }).first().click();
  await expect(page.getByRole('heading', { level: 1, name: 'Add a device' })).toBeVisible();
  await page.getByRole('radio', { name: 'Compute node' }).check();
  await page.getByRole('button', { name: 'Create code' }).click();
  const code = (await page
    .getByRole('region', { name: 'Or type this code on the device' })
    .getByText(/^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/)
    .textContent())!.trim();
  const command = (await page
    .getByRole('region', { name: 'On a computer without a screen' })
    .locator('pre code')
    .textContent())!;
  const pairingId = /--pairing '([^']+)'/.exec(command)?.[1];
  expect(pairingId, command).toBeTruthy();

  const root = mkdtempSync(join(tmpdir(), 'nova-e2e-m75-device-'));
  const dataDir = join(root, 'novad');
  const install = run(
    novadBinary(),
    [
      'install',
      '--hub',
      lan,
      '--code',
      '-',
      '--pairing',
      pairingId!,
      '--pin',
      hubFingerprint,
      '--no-service',
      '--data-dir',
      dataDir,
      '--role',
      'compute',
      '--name',
      name,
      '--listen',
      `127.0.0.1:${await freePort()}`,
    ],
    `${code}\n`,
  );
  let deviceId: string;
  try {
    const shown = await until('novad shows the confirmation', () =>
      Promise.resolve(/Confirm this code on the Hub: (\d{3}) (\d{3})/.exec(install.stdout())),
    );
    const card = page.getByRole('region', { name: `${name} wants to join` });
    await expect(card).toBeVisible({ timeout: 15_000 });
    await card
      .getByRole('textbox', { name: 'Code shown on the device' })
      .fill(`${shown[1]} ${shown[2]}`);
    await card.getByRole('button', { name: 'Approve' }).click();
    await expect(page.getByRole('heading', { level: 1, name: `${name} is added` })).toBeVisible();
    expect(await install.exited, install.stderr() + install.stdout()).toBe(0);
    deviceId = /Registered as device (\S+)/.exec(install.stdout())![1]!;
  } finally {
    install.kill();
  }

  // The machine: the fake BIOS and bootloader, restarts allowed by the device owner, and a
  // `systemctl` that only records what it was asked.
  const firmwareFile = join(root, 'firmware.json');
  const bootFile = join(root, 'bootloader.json');
  writeFileSync(firmwareFile, JSON.stringify(fakeFirmware(), null, 2));
  writeFileSync(bootFile, JSON.stringify(fakeBootloader(), null, 2));
  const bin = join(root, 'bin');
  mkdirSync(bin);
  const calls = join(root, 'systemctl-calls.log');
  writeFileSync(join(bin, 'systemctl'), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${calls}'\nexit 0\n`);
  chmodSync(join(bin, 'systemctl'), 0o755);
  const configPath = join(dataDir, 'config.json');
  const config = existsSync(configPath)
    ? (JSON.parse(readFileSync(configPath, 'utf8')) as Record<string, unknown>)
    : {};
  const power = (config.power ?? {}) as Record<string, unknown>;
  writeFileSync(
    configPath,
    JSON.stringify(
      {
        ...config,
        power: { ...power, allowActions: true },
        firmware: { backend: 'fake', fakePath: firmwareFile },
        boot: { backend: 'fake', fakePath: bootFile },
      },
      null,
      2,
    ),
  );

  let child: ChildProcess | null = null;
  let out = '';
  const start = () => {
    child = spawn(novadBinary(), ['run', '--data-dir', dataDir], {
      env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? '/usr/bin:/bin'}` },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout?.on('data', (d: Buffer) => (out += d.toString()));
    child.stderr?.on('data', (d: Buffer) => (out += d.toString()));
  };
  start();
  const readJson = <T>(path: string, fallback: T): T => {
    try {
      return JSON.parse(readFileSync(path, 'utf8')) as T;
    } catch {
      return fallback;
    }
  };
  return {
    id: deviceId,
    name,
    dataDir,
    firmwareFile,
    bootFile,
    systemctlCalls: () =>
      existsSync(calls) ? readFileSync(calls, 'utf8').split('\n').filter(Boolean) : [],
    firmwareValue: (key) =>
      readJson<{ settings: Record<string, { value: string }> }>(firmwareFile, { settings: {} })
        .settings[key]!.value,
    bootloader: () => readJson(bootFile, fakeBootloader()),
    policy: () => {
      const p = readJson<Record<string, unknown>>(join(dataDir, 'policy.json'), {});
      return {
        firmwareChanges: p.firmwareChanges === true || p.firmware_changes === true,
        lowLevelBoot: p.lowLevelBoot === true || p.low_level_boot === true,
      };
    },
    start,
    stop: () =>
      new Promise<void>((done) => {
        const c = child;
        if (!c || c.exitCode !== null || c.signalCode !== null) return done();
        c.once('exit', () => done());
        c.kill('SIGKILL');
      }),
    logs: () => out,
  };
}

/** novad's watchdog marker (`<dir>/pending.json`): the entry or snapshot and its deadline. */
export function watchdogMarker(
  dev: NovadDevice,
  dir: 'firmware' | 'boot',
): { deadline: string; deadlineMs: number; entryId?: string; snapshotId?: string } {
  return JSON.parse(readFileSync(join(dev.dataDir, dir, 'pending.json'), 'utf8')) as {
    deadline: string;
    deadlineMs: number;
    entryId?: string;
    snapshotId?: string;
  };
}

/** Whether novad holds a watchdog marker. */
export function watchdogPending(dev: NovadDevice, dir: 'firmware' | 'boot'): boolean {
  return existsSync(join(dev.dataDir, dir, 'pending.json'));
}

/** The device's page, at one of its tabs; returns the tab's panel. */
export async function openDeviceTab(page: Page, hub: M75Hub, dev: NovadDevice, tab: string) {
  await page.goto(`${hub.lan}/devices/${encodeURIComponent(dev.id)}`);
  await expect(page.getByRole('heading', { level: 1, name: dev.name })).toBeVisible();
  const t = page.getByRole('tablist', { name: 'Device sections' }).getByRole('tab', {
    name: tab,
    exact: true,
  });
  await t.click();
  await expect(t).toHaveAttribute('aria-selected', 'true');
  return page.getByRole('tabpanel', { name: tab });
}

/** Settings → Devices → "Firmware and boot". */
export async function openFirmwareBootSettings(page: Page, hub: M75Hub) {
  await page.goto(`${hub.lan}/settings/devices`);
  const section = page.getByRole('region', { name: 'Firmware and boot' });
  await expect(section).toBeVisible();
  return section;
}

/** Turn one of the "Firmware and boot" switches on: its consent dialog, then its confirm button. */
export async function consentSwitch(
  page: Page,
  section: ReturnType<Page['getByRole']>,
  label: string,
  dialogTitle: string,
  confirm: string,
  where: string,
) {
  const sw = section.getByRole('switch', { name: label });
  await expect(sw).toHaveAttribute('aria-checked', 'false');
  await sw.click();
  const dialog = page.getByRole('dialog', { name: dialogTitle });
  await expect(dialog).toBeVisible();
  await expectNoSeriousA11yIssues(page, where);
  await dialog.getByRole('button', { name: confirm }).click();
  await expect(dialog).toHaveCount(0);
  await expect(sw).toHaveAttribute('aria-checked', 'true');
}

/** One audit export line (the list does not carry `detail`). */
export interface AuditLine {
  kind: string;
  action: string;
  actor: string;
  resource: string | null;
  decision: string | null;
  result: string | null;
  detail: Record<string, unknown> | null;
}

/** Settings → Diagnostics → Export audit log: every line, oldest first. */
export async function auditExport(page: Page, hub: M75Hub): Promise<AuditLine[]> {
  const res = await page.request.get(`${hub.lan}/api/v1/audit/export`);
  expect(res.ok(), await res.text()).toBe(true);
  return (await res.text())
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as AuditLine);
}
