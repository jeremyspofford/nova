// J8.5 — Add Device & transports (docs/18 §3; M6.5 exit criteria and demo in docs/17): the Hub
// listens on every interface and the owner opens it at this machine's LAN address (the Hub builds
// no install command for a loopback address, by design). A compute node joins with the real
// novad: the owner makes a code, `novad install` checks the Hub's pinned identity and the signed
// manifest, shows a confirmation the owner types on the Hub (a wrong one is refused), registers
// and reports its capabilities; the code cannot be used twice. A phone opens the QR link, asks to
// join, has no session until the owner approves its digits, is signed in with the install help
// shown, and is signed out when the owner revokes it. A self-hosted Relay on loopback is enabled;
// a client pairs through it, falls back LAN → Mesh → Relay and reaches the Hub through the sealed
// tunnel; turning the LAN transport off moves the primary to the Relay in the transport log (the
// M6.5 demo); revoking the client in Network → Relay drops it. Network Setup plans and applies a
// Headscale mesh on the fake mesh CLIs: the step that brings the mesh up fails its reachability
// test and is rolled back, and no mesh endpoint is ever advertised; one-click rollback reverts a
// network settings change. A sleeping device is woken through a Wake helper on its LAN, and the
// wake is listed and audited. Every page visited passes the axe checks.
//
// How the outside world is played, and what the container cannot do:
// - The one-line install command downloads novad with curl and runs it as root (sudo) to install
//   a service. The journey asserts the command (pairing id, pin, the build's SHA-256, the code on
//   standard input) and runs the same `novad install … --code - --no-service` itself with the
//   binary the Hub serves (services/novad/target/release/novad, or NOVA_NOVAD_BIN; CI builds it).
// - The phone is Chromium with a Pixel 7 profile, in its own browser launched with
//   `--unsafely-treat-insecure-origin-as-secure` for the Hub's LAN origin: the QR link is plain
//   http:// at the LAN address (trust mode `none`, the default), which no browser treats as a
//   secure context, so it has no Web Crypto and the join page cannot make its device key (it
//   says so, and Add a device warns the owner). The flag stands in for the Hub's HTTPS
//   (Network → Trust) so the rest of the phone's path is exercised at the real link.
// - The Relay client is a Node client (@nova/relay pairWithRelay and RelayClient, kind browser);
//   no web page pairs through a Relay yet. Its LAN and Mesh endpoints are addresses that do not
//   answer (TEST-NET-1 and an unused mesh address), so the selection falls back to the Relay.
//   Add a device offers "Through the Relay" as soon as the Relay is turned on (no reload), and
//   the Relay is advertised as soon as it connects (no Test now).
// - Network Setup runs fake CLIs (packages/core/test/fixtures/mesh/fake-mesh.mjs) named in
//   NOVA_NETWORK_TOOLS_FILE; the fake gives the Hub the mesh address 100.64.0.5, which does not
//   answer, so the step that brings the mesh up fails its reachability test.
// - The Wake helper and the sleeping computer are fake novad devices (FakeDevice) enrolled with
//   the one-use command; they report the LAN 192.168.77.0/24 and the helper records the wake
//   instead of sending a magic packet. The sleeping computer stops its heartbeats, and the Hub
//   marks it offline after three missed beats (30 s).
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, devices, expect, test, type Page } from '@playwright/test';
import { FakeDevice } from '../packages/core/src/devices/fake-device.ts';
import type { FakeMeshState } from '../packages/core/test/fixtures/mesh/world.ts';
import {
  RelayClient,
  generateEd25519,
  pairWithRelay,
  toBase64Url,
} from '../packages/relay/src/index.ts';
import {
  selectEndpoint,
  type EndpointCandidate,
  type EndpointProbe,
} from '../packages/shared/src/m65/network.ts';
import { expectNoSeriousA11yIssues } from './support/a11y.ts';
import { json, setting, toast, until } from './support/m6.ts';
import {
  freePort,
  novadBinary,
  run,
  setUpM65Hub,
  startRelayService,
  type M65Hub,
} from './support/m65.ts';

const portFor = (parallelIndex: number) => 7621 + parallelIndex;
let hub: M65Hub;

test.use({ colorScheme: 'light' });
test.describe.configure({ mode: 'serial' });
test.setTimeout(240_000);

test.afterEach(async () => {
  await hub?.stop();
});

const CODE = /^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/;
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const sidebarLink = (page: Page, name: string) =>
  page.getByRole('navigation', { name: 'Sidebar' }).getByRole('link', { name, exact: true });

/** Devices → Add device: the Add a device page. */
async function openAddDevice(page: Page) {
  await sidebarLink(page, 'Devices').click();
  await expect(page.getByRole('heading', { level: 1, name: 'Devices' })).toBeVisible();
  await page.getByRole('button', { name: 'Add device' }).first().click();
  await expect(page.getByRole('heading', { level: 1, name: 'Add a device' })).toBeVisible();
}

/** The join link of the code on screen. */
async function joinLink(page: Page): Promise<string> {
  return (await page
    .getByRole('region', { name: 'Or send the device this link' })
    .locator('code')
    .textContent())!;
}

/** Network (sidebar) → one of its sections; returns the section's panel. */
async function openNetwork(page: Page, section: string) {
  await sidebarLink(page, 'Network').click();
  await expect(page.getByRole('heading', { level: 1, name: 'Network' })).toBeVisible();
  const tab = page.getByRole('tablist', { name: 'Network sections' }).getByRole('tab', {
    name: section,
  });
  await tab.click();
  await expect(tab).toHaveAttribute('aria-selected', 'true');
  return page.getByRole('tabpanel', { name: section });
}

test('J8.5: a compute node joins with novad install; a phone joins by its QR link', async ({
  page,
}, testInfo) => {
  hub = await setUpM65Hub(page, portFor(testInfo.parallelIndex));
  const { lan } = hub;
  const { hubFingerprint } = await json<{ hubFingerprint: string }>(
    await page.request.get(`${lan}/api/v1/hello`),
  );

  // 1. Devices → Add a device → Compute node → Create code: the QR, the code, its countdown and
  //    the one-line command with the pairing id, the pinned Hub key and the build's SHA-256.
  await sidebarLink(page, 'Devices').click();
  await expect(page.getByRole('heading', { level: 1, name: 'Devices' })).toBeVisible();
  await expectNoSeriousA11yIssues(page, 'devices');
  await openAddDevice(page);
  await page.getByRole('radio', { name: 'Compute node' }).check();
  await expectNoSeriousA11yIssues(page, 'add a device');
  await page.getByRole('button', { name: 'Create code' }).click();
  await expect(
    page.getByRole('img', { name: 'QR code that adds a device to this Hub' }),
  ).toBeVisible();
  const code = (await page
    .getByRole('region', { name: 'Or type this code on the device' })
    .getByText(CODE)
    .textContent())!.trim();
  await expect(page.getByRole('timer')).toHaveText(/^[45]:\d\d$/);
  const link = await joinLink(page);
  expect(link).toMatch(new RegExp(`^${esc(lan)}/add-device\\?p=[^#]+#c=${code}$`));
  expect(new URL(link).searchParams.get('fp')).toBe(hubFingerprint);
  const command = (await page
    .getByRole('region', { name: 'On a computer without a screen' })
    .locator('pre code')
    .textContent())!;
  const pairingId = /--pairing '([^']+)'/.exec(command)?.[1];
  expect(pairingId, command).toBeTruthy();
  expect(new URL(link).searchParams.get('p')).toBe(pairingId);
  expect(command).toContain(`--hub '${lan}'`);
  expect(command).toContain(`--pin '${hubFingerprint}'`);
  expect(command).toContain(`--role 'compute'`);
  expect(command).toContain(`h=${hub.build.sha256};`);
  expect(command).toContain(`printf '%s\\n' '${code}' |`);
  await expectNoSeriousA11yIssues(page, 'add a device: the code');

  // 2. novad install, as the one-line command runs it (the code on standard input): it verifies
  //    the Hub and the signed build, then shows the confirmation the owner types on the Hub.
  const bin = novadBinary();
  const installArgs = (dataDir: string) => [
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
  ];
  const novad = run(
    bin,
    [
      ...installArgs(mkdtempSync(join(tmpdir(), 'nova-e2e-novad-'))),
      '--role',
      'compute',
      '--name',
      'build-box',
      '--listen',
      `127.0.0.1:${await freePort()}`,
    ],
    `${code}\n`,
  );
  try {
    const shown = await until('novad shows the confirmation', () =>
      Promise.resolve(/Confirm this code on the Hub: (\d{3}) (\d{3})/.exec(novad.stdout())),
    );
    expect(novad.stdout()).toContain(`Hub identity verified: ${hubFingerprint}`);
    expect(novad.stdout()).toContain(`(SHA-256 ${hub.build.sha256})`);
    const digits = `${shown[1]}${shown[2]}`;
    // The request appears live (or by the page's check every 5 s).
    const card = page.getByRole('region', { name: 'build-box wants to join' });
    await expect(card).toBeVisible({ timeout: 15_000 });
    await expect(card).toContainText('novad · linux · as Compute node');
    await expectNoSeriousA11yIssues(page, 'add a device: the request to join');
    const field = card.getByRole('textbox', { name: 'Code shown on the device' });
    await field.fill(digits === '000000' ? '111111' : '000000');
    await card.getByRole('button', { name: 'Approve' }).click();
    await expect(
      card.getByText(
        'That code does not match the one on the device. Compare the six digits on both screens.',
      ),
    ).toBeVisible();
    await field.fill(`${shown[1]} ${shown[2]}`);
    await card.getByRole('button', { name: 'Approve' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'build-box is added' })).toBeVisible();
    expect(await novad.exited, novad.stderr() + novad.stdout()).toBe(0);
    expect(novad.stdout()).toMatch(/Registered as device \S+/);
  } finally {
    novad.kill();
  }
  await expectNoSeriousA11yIssues(page, 'add a device: added');
  await page.getByRole('button', { name: 'Open build-box' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'build-box' })).toBeVisible();
  const facts = page.locator('.devices-facts').first();
  await expect(page.locator('.devices-title')).toContainText('Online');
  await expect(facts).toContainText('Compute node');
  const capabilities = page.getByRole('tabpanel', { name: 'Capabilities' });
  await expect(
    capabilities.getByRole('list', { name: 'Capabilities' }).getByRole('listitem'),
  ).not.toHaveCount(0);
  await expect(capabilities.getByLabel('Capability document')).toContainText('"compute"');
  await expectNoSeriousA11yIssues(page, 'device page of the compute node');

  //    The code is spent: a second install with it fails before writing anything.
  const againDir = mkdtempSync(join(tmpdir(), 'nova-e2e-novad-again-'));
  const again = run(bin, installArgs(againDir), `${code}\n`);
  expect(await again.exited).not.toBe(0);
  expect(again.stderr()).toContain('the Add Device code expired or was already used');
  expect(readdirSync(againDir)).toEqual([]);

  // 3. A phone opens the QR link of a code for a Client.
  await openAddDevice(page);
  await expect(page.getByRole('radio', { name: 'Client' })).toBeChecked();
  await page.getByRole('button', { name: 'Create code' }).click();
  const phoneLink = await joinLink(page);
  expect(phoneLink).toMatch(/#c=[0-9A-Z]{4}-[0-9A-Z]{4}$/);
  const phoneCode = new URL(phoneLink).hash.slice('#c='.length);
  const phoneBrowser = await chromium.launch({
    // Full Chromium: the headless shell ignores this flag.
    channel: 'chromium',
    args: [`--unsafely-treat-insecure-origin-as-secure=${lan}`],
  });
  try {
    const phoneCtx = await phoneBrowser.newContext({ ...devices['Pixel 7'] });
    const phone = await phoneCtx.newPage();
    await phone.goto(phoneLink);
    await expect(phone.getByRole('heading', { level: 1, name: 'Add this device' })).toBeVisible();
    await expect(phone.getByText(phoneCode)).toBeVisible();
    // The code left the address at once.
    expect(new URL(phone.url()).hash).toBe('');
    await expect(phone.getByRole('textbox', { name: 'Name for this device' })).toHaveValue(
      'Chrome on Android',
    );
    await phone.getByRole('textbox', { name: 'Name for this device' }).fill('Pixel phone');
    await expectNoSeriousA11yIssues(phone, 'join page');
    await phone.getByRole('button', { name: 'Ask to join' }).click();
    await expect(
      phone.getByRole('heading', { level: 1, name: 'Approve on the Hub' }),
    ).toBeVisible();
    const phoneDigits = (await phone.getByText(/^\d{3} \d{3}$/).textContent())!;
    await expect(phone.getByText('Waiting for the owner to approve this device.')).toBeVisible();
    await expectNoSeriousA11yIssues(phone, 'join page: waiting for approval');
    //    Nothing is reachable before the owner approves.
    expect((await phoneCtx.request.get(`${lan}/api/v1/session`)).status()).toBe(401);

    //    The owner types the digits the phone shows and approves.
    const card = page.getByRole('region', { name: 'Pixel phone wants to join' });
    await expect(card).toBeVisible({ timeout: 15_000 });
    await expect(card).toContainText('Web browser · Android · as Client');
    await card.getByRole('textbox', { name: 'Code shown on the device' }).fill(phoneDigits);
    await card.getByRole('button', { name: 'Approve' }).click();
    await expect(
      page.getByRole('heading', { level: 1, name: 'Pixel phone is added' }),
    ).toBeVisible();
    await expect(page.getByText(/It is signed in now\./)).toBeVisible();

    //    The phone is signed in, with the install help; the app is installable (its manifest
    //    and service worker).
    await expect(
      phone.getByRole('heading', { level: 1, name: 'This device is added' }),
    ).toBeVisible({ timeout: 15_000 });
    const install = phone.getByRole('region', { name: 'Install the app' });
    await expect(install).toContainText(/Add to Home screen|Install Nova/);
    await expectNoSeriousA11yIssues(phone, 'join page: added');
    const session = await json<{ kind: string }>(
      await phoneCtx.request.get(`${lan}/api/v1/session`),
    );
    expect(session.kind).toBe('session');
    await phone.getByRole('button', { name: 'Open Nova' }).click();
    await expect(phone).toHaveURL(`${lan}/`);
    await expect(phone.getByRole('textbox', { name: 'Message', exact: true })).toBeVisible();
    const pwa = await phone.evaluate(async () => {
      const reg = await navigator.serviceWorker.ready;
      const href = document.querySelector<HTMLLinkElement>('link[rel="manifest"]')?.href ?? '';
      const manifest = (await (await fetch(href)).json()) as { name?: string; display?: string };
      return { sw: reg.active?.scriptURL ?? null, manifest };
    });
    expect(pwa.sw).toBe(`${lan}/sw.js`);
    expect(pwa.manifest.display).toBe('standalone');
    await expectNoSeriousA11yIssues(phone, 'the app on the phone');

    //    The owner revokes the phone on its page: its session ends.
    await page.getByRole('button', { name: 'Open Pixel phone' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Pixel phone' })).toBeVisible();
    await expect(page.locator('.devices-facts').first()).toContainText('1 live session');
    await expectNoSeriousA11yIssues(page, 'device page of the phone');
    await page.getByRole('button', { name: 'Revoke', exact: true }).click();
    const revoke = page.getByRole('dialog', { name: 'Revoke Pixel phone?' });
    await expect(revoke).toContainText('Its sessions end at once and its key is blocked.');
    await expectNoSeriousA11yIssues(page, 'revoke the phone');
    await revoke.getByRole('button', { name: 'Revoke', exact: true }).click();
    await expect(toast(page, 'Pixel phone revoked.')).toBeVisible();
    await expect(page.locator('.devices-title')).toContainText('Revoked');
    expect((await phoneCtx.request.get(`${lan}/api/v1/session`)).status()).toBe(401);
  } finally {
    await phoneBrowser.close();
  }
});

/** The Add Device status poll, signed with the device key (Add Device v2). */
async function signedStatusHeaders(
  key: Awaited<ReturnType<typeof generateEd25519>>,
  requestId: string,
): Promise<Record<string, string>> {
  const time = Math.floor(Date.now() / 1000);
  const text = `nova-add-device-status-v1.${requestId}.${time}`;
  return {
    'x-nova-device-time': String(time),
    'x-nova-device-signature': toBase64Url(await key.sign(new TextEncoder().encode(text))),
  };
}

const candidate = (transport: EndpointCandidate['transport'], url: string, priority: number) =>
  ({
    transport,
    url,
    priority,
    health: 'ok',
    latencyMs: null,
    checkedAt: null,
    detail: null,
  }) satisfies EndpointCandidate;

test('J8.5: a client through the Relay; LAN → Mesh → Relay; the LAN off, the Relay takes over', async ({
  page,
}, testInfo) => {
  const relay = await startRelayService();
  let client: RelayClient | null = null;
  try {
    hub = await setUpM65Hub(page, portFor(testInfo.parallelIndex));
    const { lan } = hub;

    // 4. Network → Relay: turn it on with the Relay on loopback (asks first), until connected.
    let panel = await openNetwork(page, 'Relay');
    await expectNoSeriousA11yIssues(page, 'network: relay');
    await panel.getByRole('switch', { name: 'Use a Relay' }).click();
    await panel.getByRole('textbox', { name: 'Relay address' }).fill(relay.url);
    await panel.getByRole('button', { name: 'Save', exact: true }).click();
    const connect = page.getByRole('dialog', { name: 'Connect this Hub to the Relay?' });
    await expect(connect).toContainText(relay.url);
    await connect.getByRole('button', { name: 'Connect' }).click();
    await expect(toast(page, 'Relay settings saved.')).toBeVisible();
    await expect(panel.getByText('Connected', { exact: true })).toBeVisible({ timeout: 20_000 });

    //    Add a device → Client → Through the Relay: the join link carries the Relay. The page
    //    follows the Relay setting without a reload of the app.
    await openAddDevice(page);
    await page.getByRole('radio', { name: 'Through the Relay' }).check();
    await page.getByRole('button', { name: 'Create code' }).click();
    await expect(
      page.getByText('Client · Scopes: No extra scopes · through the Relay'),
    ).toBeVisible();
    const link = new URL(await joinLink(page));
    const relayUrl = link.searchParams.get('r');
    const relayPairingId = link.searchParams.get('rp');
    expect(relayUrl).toBe(relay.url);
    expect(relayPairingId).toBeTruthy();
    const code = link.hash.slice('#c='.length);

    //    A client pairs through the Relay with the code; the owner approves its confirmation.
    const key = await generateEd25519();
    const paired = await pairWithRelay({
      relayUrl: relayUrl!,
      relayPairingId: relayPairingId!,
      code,
      device: key,
      name: 'Road laptop',
      platform: 'Linux',
      kind: 'browser',
      pin: link.searchParams.get('fp'),
    });
    expect(paired.addPairingId).toBe(link.searchParams.get('p'));
    client = new RelayClient({ paired: paired.paired, requestTimeoutMs: 20_000 });
    client.start();
    const card = page.getByRole('region', { name: 'Road laptop wants to join' });
    await expect(card).toBeVisible({ timeout: 15_000 });
    await expect(card).toContainText('through the Relay');
    await expectNoSeriousA11yIssues(page, 'add a device: a request through the Relay');
    await card.getByRole('textbox', { name: 'Code shown on the device' }).fill(paired.confirmation);
    await card.getByRole('button', { name: 'Approve' }).click();
    await expect(
      page.getByRole('heading', { level: 1, name: 'Road laptop is added' }),
    ).toBeVisible();
    const { requestId } = await client.waitForPaired();
    //    It polls its status through the tunnel, signed with its device key: its session.
    const status = await client.fetch(`/api/v1/devices/add/status/${requestId}`, {
      headers: await signedStatusHeaders(key, requestId!),
    });
    expect(status.status).toBe(200);
    const { grant } = (await status.json()) as { grant: { type: string; token: string } };
    expect(grant.type).toBe('session');
    const auth = { authorization: `Bearer ${grant.token}` };

    //    Fallback: its LAN and Mesh endpoints do not answer, so the Relay wins.
    const relayClient = client;
    const probe: EndpointProbe = async (c, signal) => {
      const res =
        c.transport === 'relay'
          ? await relayClient.fetch('/api/v1/hello', { signal })
          : await fetch(`${c.url}/api/v1/hello`, { signal });
      return res.ok;
    };
    const selection = await selectEndpoint(
      [
        candidate('lan', 'http://192.0.2.1:9', 10),
        candidate('mesh', 'http://100.64.0.77:9', 20),
        candidate('relay', relayUrl!, 30),
      ],
      probe,
      { timeoutMs: 10_000 },
    );
    console.log('J8.5 endpoint selection:', JSON.stringify(selection.attempts));
    expect(selection.winner?.transport).toBe('relay');
    expect(selection.attempts.map((a) => a.transport)).toEqual(['lan', 'mesh', 'relay']);
    expect(selection.attempts.filter((a) => a.outcome === 'ok').map((a) => a.transport)).toEqual([
      'relay',
    ]);
    const session = await client.fetch('/api/v1/session', { headers: auth });
    expect(session.status).toBe(200);
    expect(await session.json()).toMatchObject({ kind: 'session' });

    //    The demo: turn the LAN transport off in Network; the transport log shows the Relay
    //    taking over, then the LAN coming back as primary when it is turned on again.
    panel = await openNetwork(page, 'Overview');
    const advertised = panel.getByRole('list', { name: 'Advertised endpoints' });
    await expect(advertised).toContainText('LAN');
    // The Relay is advertised from its connection, with no Test now.
    await expect(advertised).toContainText(`Relay${relay.url}`);
    await panel.getByRole('switch', { name: 'LAN', exact: true }).click();
    await panel.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(
      toast(page, 'Network settings saved. You can roll this back under Changes.'),
    ).toBeVisible();
    const events = panel.getByRole('list', { name: 'Transport events' });
    // The newest line: the LAN was turned off (not a failure) and the Relay took over as primary.
    await expect(events.getByRole('listitem').first()).toContainText(
      'LAN was turned off; Relay is now primary.',
      { timeout: 20_000 },
    );
    await expect(panel.getByRole('listitem', { name: 'Relay', exact: true })).toContainText(
      'Primary',
    );
    await expect(advertised).not.toContainText('LAN');
    await expectNoSeriousA11yIssues(page, 'network overview with the LAN off');
    await panel.getByRole('switch', { name: 'LAN', exact: true }).click();
    await panel.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(events.getByRole('listitem').first()).toContainText(/LAN is now primary/, {
      timeout: 20_000,
    });
    console.log('J8.5 transport events:', await events.innerText());

    //    Network → Relay lists the paired client; revoking it (asks first) drops its envelopes.
    panel = await openNetwork(page, 'Relay');
    const row = panel.getByRole('list', { name: 'Paired clients' }).getByRole('listitem', {
      name: 'Road laptop',
    });
    await expect(row).toContainText('Active');
    await expectNoSeriousA11yIssues(page, 'network: relay with a paired client');
    await row.getByRole('button', { name: 'Revoke Road laptop' }).click();
    const revoke = page.getByRole('dialog', { name: 'Revoke Road laptop?' });
    await expect(revoke).toContainText('It loses access at once');
    await revoke.getByRole('button', { name: 'Revoke', exact: true }).click();
    await expect(toast(page, 'Road laptop revoked.')).toBeVisible();
    await until('the Relay drops the revoked client', () =>
      Promise.resolve(relayClient.state === 'revoked'),
    );
    await expect(relayClient.fetch('/api/v1/session', { headers: auth })).rejects.toMatchObject({
      code: 'revoked',
    });
    expect((await page.request.get(`${lan}/api/v1/session`)).status()).toBe(200);
  } finally {
    client?.stop();
    await relay.stop();
  }
});

/** The fake mesh's world: what the fake CLIs did to the Hub. */
const meshState = (h: M65Hub) =>
  JSON.parse(readFileSync(join(h.meshDir, 'state.json'), 'utf8')) as FakeMeshState;

test('J8.5: Network setup with the fake mesh rolls back a failing step; one-click rollback', async ({
  page,
}, testInfo) => {
  hub = await setUpM65Hub(page, portFor(testInfo.parallelIndex));
  const { lan } = hub;

  // 5. Network → Setup: turn host changes on (asks first), plan a Headscale mesh.
  let panel = await openNetwork(page, 'Setup');
  const found = panel.getByRole('region', { name: 'What Nova finds' });
  await expect(found.getByRole('list', { name: 'Meshes found' })).toContainText('Headscale');
  const host = panel.getByRole('switch', { name: "Let Nova change this computer's network" });
  await host.click();
  const allow = page.getByRole('dialog', { name: "Let Nova change this computer's network?" });
  await allow.getByRole('button', { name: 'Turn on' }).click();
  await expect(host).toHaveAttribute('aria-checked', 'true');
  await expectNoSeriousA11yIssues(page, 'network: setup');
  const plan = panel.getByRole('region', { name: 'Set up a mesh' });
  await plan.getByRole('radio', { name: 'Headscale: Self-hosted, recommended' }).check();
  const form = plan.getByRole('form', { name: 'Headscale options' });
  await form.getByLabel('Headscale server URL').fill('https://hs.example.com');
  await form
    .getByLabel('Pre-auth key (optional, write-only)')
    .fill('hskey-auth-e2e-0123456789abcdef');
  await form.getByRole('button', { name: 'Make a plan' }).click();
  await expect(page.getByRole('heading', { name: 'Headscale setup' })).toBeVisible();
  await expect(page).toHaveURL(/\/network\/setup\?run=/);
  expect(await page.content()).not.toContain('hskey-auth-e2e-0123456789abcdef');
  await expectNoSeriousA11yIssues(page, 'network: a setup run');

  //    Apply the steps in order, consenting to each kind of change once, until the step that
  //    brings the mesh up: its reachability test fails and it is rolled back automatically.
  const steps = page.getByRole('list', { name: 'Steps' });
  const meshUp = steps.getByRole('listitem', {
    name: 'Join the Headscale server https://hs.example.com',
  });
  for (let i = 0; i < 10; i++) {
    const apply = steps.getByRole('button', { name: 'Apply', exact: true });
    if ((await apply.count()) === 0) break;
    const step = steps
      .getByRole('listitem')
      .filter({ has: page.getByRole('button', { name: 'Apply', exact: true }) });
    const title = (await step.getByRole('heading', { level: 3 }).textContent())!;
    const asks = (await step.getByText('Nova asks you to allow it before it runs.').count()) > 0;
    await apply.click();
    if (asks) {
      const consent = page.getByRole('dialog', { name: `Allow: ${title}?` });
      await expect(consent.getByLabel('What you allow')).not.toBeEmpty();
      if (i === 0) await expectNoSeriousA11yIssues(page, 'network: consent to a setup step');
      await consent.getByRole('button', { name: 'Allow and apply' }).click();
    }
    await expect(
      steps
        .getByRole('listitem', { name: title })
        .getByText(/^(Done|Rolled back|Failed|Undo failed)$/),
    ).toBeVisible({ timeout: 60_000 });
    if (title === 'Join the Headscale server https://hs.example.com') break;
  }
  await expect(meshUp.getByText('Rolled back', { exact: true })).toBeVisible();
  await expect(meshUp).toContainText(
    'Rolled back automatically: the mesh path failed its reachability test',
  );
  await expect(meshUp.getByRole('list', { name: 'Checks' })).toContainText('mesh reachable');
  await expect(page.locator('.net-notice')).toContainText(
    'did not pass its checks, so Nova rolled it back',
  );
  await expectNoSeriousA11yIssues(page, 'network: a rolled-back setup step');
  //    The steps before it ran on the (fake) host and stay; the rollback logged the Hub out of
  //    the mesh again.
  expect(meshState(hub).headscale.users.map((u) => u.name)).toContain('nova');
  expect(meshState(hub).tailscale.loggedOut).toBe(true);
  expect(meshState(hub).tailscale.ips).toEqual([]);

  //    The failing path was never advertised: no Mesh endpoint is advertised, and the transport
  //    log never advertised one.
  panel = await openNetwork(page, 'Overview');
  await expect(panel.getByRole('list', { name: 'Advertised endpoints' })).toContainText('LAN');
  await expect(panel.getByRole('list', { name: 'Advertised endpoints' })).not.toContainText('Mesh');
  const diag = await json<{ events: { kind: string; transport: string | null }[] }>(
    await page.request.get(`${lan}/api/v1/network/diagnostics`),
  );
  expect(diag.events.filter((e) => e.kind === 'advertised' && e.transport === 'mesh')).toEqual([]);

  //    A successful change (the mDNS name) and one-click rollback: the setting returns.
  const mdns = panel.getByRole('textbox', { name: 'mDNS name' });
  // Unset, the field shows the name in use: this computer's host name.
  await expect(mdns).not.toHaveValue('');
  const hostName = await mdns.inputValue();
  expect(await setting(page, { ...hub, url: lan }, 'network.lan.mdnsName')).toBeNull();
  await mdns.fill('nova-e2e');
  await panel.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(
    toast(page, 'Network settings saved. You can roll this back under Changes.'),
  ).toBeVisible();
  await expect(
    panel.getByRole('list', { name: 'Network changes' }).getByRole('listitem').first(),
  ).toHaveAccessibleName('Changed lan.mdnsName');
  expect(await setting(page, { ...hub, url: lan }, 'network.lan.mdnsName')).toBe('nova-e2e');
  await expectNoSeriousA11yIssues(page, 'network overview with changes');
  await panel.getByRole('button', { name: 'Roll back the last change' }).first().click();
  const rollback = page.getByRole('dialog', { name: 'Roll back the last change?' });
  await expect(rollback).toContainText('Changed lan.mdnsName');
  await rollback.getByRole('button', { name: 'Roll back', exact: true }).click();
  await expect(toast(page, 'Rolled back: Changed lan.mdnsName')).toBeVisible();
  await expect(mdns).toHaveValue(hostName);
  expect(await setting(page, { ...hub, url: lan }, 'network.lan.mdnsName')).toBeNull();
});

const MAC = 'aa:bb:cc:dd:ee:01';
const LAN = '192.168.77.0/24';

/** Add a device with the one-use command (Client unless `role` is given): its token. */
async function enrollToken(page: Page, role?: string): Promise<string> {
  await openAddDevice(page);
  await page.getByRole('link', { name: 'Use a one-use command instead' }).click();
  if (role) {
    await page.getByRole('checkbox', { name: role }).check();
    await page.getByRole('checkbox', { name: 'Client' }).uncheck();
  }
  await page.getByRole('button', { name: 'Create command' }).click();
  const command = await page
    .getByRole('region', { name: 'Enrollment command' })
    .locator('code')
    .textContent();
  const token = /--token (\S+)/.exec(command ?? '')?.[1];
  expect(token, command ?? '').toBeTruthy();
  return token!;
}

test('J8.5: a sleeping computer is woken through a Wake helper on its LAN', async ({
  page,
}, testInfo) => {
  hub = await setUpM65Hub(page, portFor(testInfo.parallelIndex));
  // 6. The computer to wake and a Wake helper on its LAN, both added with the one-use command.
  const desktop = new FakeDevice({ name: 'Desktop', roles: ['client'], wakeMac: MAC, lan: [LAN] });
  const nas = new FakeDevice({ name: 'NAS', roles: ['wake-helper'], lan: [LAN] });
  let beat: ReturnType<typeof setInterval> | null = null;
  try {
    await desktop.enroll(hub.url, await enrollToken(page));
    await expect(page.getByRole('heading', { level: 1, name: 'Desktop is added' })).toBeVisible({
      timeout: 20_000,
    });
    await nas.enroll(hub.url, await enrollToken(page, 'Wake helper'));
    await expect(page.getByRole('heading', { level: 1, name: 'NAS is added' })).toBeVisible({
      timeout: 20_000,
    });
    // Both report their LAN with a heartbeat; the helper stays online, the computer sleeps.
    expect((await desktop.heartbeat()).status).toBe(200);
    expect((await nas.heartbeat()).status).toBe(200);
    beat = setInterval(() => void nas.heartbeat().catch(() => undefined), 5_000);
    await desktop.close();

    await page.getByRole('button', { name: 'Open NAS' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'NAS' })).toBeVisible();
    await expect(page.locator('.devices-facts').first()).toContainText('Wake helper');
    await sidebarLink(page, 'Devices').click();
    await page
      .getByRole('list', { name: 'Devices' })
      .getByRole('link', { name: 'Desktop' })
      .click();
    await expect(page.getByRole('heading', { level: 1, name: 'Desktop' })).toBeVisible();
    //    Three missed heartbeats (30 s) and the Hub marks it offline: Wake appears.
    const wake = page.getByRole('button', { name: 'Wake', exact: true });
    await expect(wake).toBeVisible({ timeout: 60_000 });
    await expect(page.locator('.devices-title')).toContainText('Offline');
    await expectNoSeriousA11yIssues(page, 'device page of a sleeping computer');
    await wake.click();
    await expect(toast(page, 'Wake signal sent to Desktop through NAS.')).toBeVisible();
    expect(nas.wakes).toEqual([{ mac: MAC, broadcast: '192.168.77.255', port: 9 }]);

    //    Network → Wake helpers lists the helper and the wake it sent.
    const panel = await openNetwork(page, 'Wake helpers');
    await expect(
      panel.getByRole('list', { name: 'Available Wake helpers' }).getByRole('listitem', {
        name: 'NAS',
      }),
    ).toContainText(`networks ${LAN}`);
    const recent = panel.getByRole('list', { name: 'Recent wakes' }).getByRole('listitem').first();
    await expect(recent).toContainText('Desktop');
    await expect(recent).toContainText('sent through NAS');
    await expect(recent).toContainText(MAC);
    await expectNoSeriousA11yIssues(page, 'network: wake helpers');

    //    The wake is audited.
    await page.goto(`${hub.lan}/settings/diagnostics`);
    const entries = page.getByRole('list', { name: 'Audit entries' });
    await expect(entries.getByRole('listitem', { name: 'device: device.wake' })).toBeVisible();
  } finally {
    if (beat) clearInterval(beat);
    await nas.close();
    await desktop.close();
  }
});
