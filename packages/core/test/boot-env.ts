// Shared setup for the boot tests (FR-143, ADR-096 D5): the devices env with one enrolled device,
// the boot and PXE services on its simulated clock, a Hub identity key that signs D2
// authorizations, and the D5 fake novad answering the boot routes in process. Approval cards are
// answered by writing the decision the policy area would and passing it on.
import { generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  BootService,
  FakeBootDevice,
  PxeService,
  bootAuthorizer,
  callDevice,
  type BootDeviceLink,
  type FakeDevice,
  type FakeBootDeviceOptions,
  type NotificationInput,
} from '../src/index.ts';
import { ACCOUNT, devicesEnv, type DevicesEnv } from './devices-env.ts';

export { ACCOUNT };

export interface BootEnv {
  env: DevicesEnv;
  device: FakeDevice;
  deviceId: string;
  fake: FakeBootDevice;
  boot: BootService;
  pxe: PxeService;
  notes: NotificationInput[];
  settings: { allowLowLevel: boolean; watchdogSeconds: number };
  /** The Hub identity's raw public key (base64url) the fake pinned. */
  hubPublicKey: string;
  hubPrivateKey: KeyObject;
  /** Shift the fake device's clock against the Hub's (ms). */
  skew: { ms: number };
  imagesDir: string;
  /** Answer an approval card as the policy area does, then pass the decision on. */
  decide(approvalId: string, decision?: string): Promise<void>;
  /** novad's next heartbeat: the device's watchdog events reach the boot service. */
  heartbeat(): Promise<void>;
  advance(ms: number): void;
  close(): Promise<void>;
}

export async function bootEnv(
  opts: { fake?: Partial<FakeBootDeviceOptions>; signer?: boolean } = {},
): Promise<BootEnv> {
  const env = await devicesEnv();
  const device = await env.enroll({ name: 'lab-box' });
  const deviceId = device.deviceId!;
  const keys = generateKeyPairSync('ed25519');
  const hubPublicKey = (keys.publicKey.export({ format: 'jwk' }) as { x: string }).x;
  const skew = { ms: 0 };
  const fake = new FakeBootDevice({
    hubPublicKey,
    deviceId,
    managementToken: device.managementToken,
    lowLevelBoot: true,
    now: () => new Date(env.clock.now + skew.ms),
    ...opts.fake,
  });
  const transport = fake.transport();
  const link: BootDeviceLink = {
    async device(accountId, id) {
      const d = await env.svc.device(accountId, id);
      return {
        id: d.row.id,
        name: d.row.name,
        status: d.row.status,
        lastSeenAt: d.row.lastSeenAt,
      };
    },
    call: (_accountId, _id, path, body) =>
      callDevice(transport, 'http://device.test', device.managementToken, path, body, 1_000),
  };
  const notes: NotificationInput[] = [];
  const settings = { allowLowLevel: true, watchdogSeconds: 600 };
  const now = () => new Date(env.clock.now);
  const boot = new BootService({
    db: env.db,
    events: env.events,
    devices: link,
    settings: {
      allowLowLevel: () => Promise.resolve(settings.allowLowLevel),
      watchdogSeconds: () => Promise.resolve(settings.watchdogSeconds),
    },
    audit: { append: (r) => (env.audit.push(r), Promise.resolve()) },
    notifier: { notify: (n) => (notes.push(n), Promise.resolve()) },
    now,
  });
  if (opts.signer !== false)
    boot.useAuthorizer(
      bootAuthorizer(
        () => ({ sign: (bytes) => sign(null, Buffer.from(bytes), keys.privateKey) }),
        now,
      ),
    );
  const imagesDir = join(env.dir, 'boot-images');
  mkdirSync(imagesDir);
  const pxe = new PxeService({
    db: env.db,
    events: env.events,
    devices: link,
    imagesDir,
    audit: { append: (r) => (env.audit.push(r), Promise.resolve()) },
    now,
  });
  return {
    env,
    device,
    deviceId,
    fake,
    boot,
    pxe,
    notes,
    settings,
    hubPublicKey,
    hubPrivateKey: keys.privateKey,
    skew,
    imagesDir,
    async decide(approvalId, decision = 'allow_once') {
      env.db.raw
        .prepare(
          `UPDATE approval SET status = 'decided', decision = ?, decided_by = 'user', decided_at = ?
           WHERE id = ? AND status = 'pending'`,
        )
        .run(decision, now().toISOString(), approvalId);
      await boot.onApprovalDecided(ACCOUNT, approvalId, decision);
    },
    async heartbeat() {
      const r = await device.heartbeat();
      if (r.status !== 200) throw new Error(`heartbeat ${r.status}`);
      await boot.heartbeatEvents(ACCOUNT, deviceId, fake.takeEvents());
    },
    advance(ms) {
      env.clock.now += ms;
    },
    close: () => {
      boot.stop();
      return env.close();
    },
  };
}
