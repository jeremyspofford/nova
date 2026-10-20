// J10 — Extension & governance (docs/18 §3 J10; docs/17 §M8 exit criteria and demo; FR-117,
// FR-106, FR-105, FR-049, FR-016). Each step runs on its own Hub, set up through onboarding, and
// drives the UI wherever the step is a user action; Hub API calls are setup and verification.
//
// 1. A sample extension (packages/sdk/examples/hello, packed unsigned as `nova pack --unsigned`
//    does) installs through Settings → Extensions: the file's preview says Unverified, lists what
//    it may do and needs the sideload confirmation. Its command runs from the command palette (its
//    status item counts the run), its panel opens from its card, and the Mock model calls its tool
//    in a chat. A declared permission works: the write into its own data folder asks first, then
//    lands there. Turned off in Settings, its command leaves the palette and its tools the model;
//    turned on, both are back. An undeclared host asked for by its own code is refused before any
//    request leaves the Hub: the tool result says why, the audit log has
//    `extension.access.denied`, and the extension is turned off with a notification that leads to
//    Settings → Extensions.
// 2. Managed policy: the Hub runs with a test policy file (NOVA_MANAGED_SETTINGS_FILE and
//    --allow-test-policy) that turns Bypass off and limits sandboxes to an allowlist, a ceiling
//    over the owner's own hosts. The lock notes on Code (Bypass), Permissions and Network say
//    "Managed by your organization (test policy file)" and are linked to their controls; the
//    banner names the policy file; Managed policy lists the sources, restrictions, hosts in force
//    and settings. With no hosts of the owner's, the policy's are in force, on Network and in
//    GET /egress, and the owner's list stays editable. The locked change and an own host outside
//    the ceiling are refused by the Hub as `managed`. A stricter file read again with "Check for
//    changes" applies at once: the network is off, and the unverified extension installed before
//    is stopped and cannot be installed again.
// 3. Data: content (a chat with an attachment, a project, a memory, a setting, a plugin with a
//    stored secret) is exported from Settings → Data without a passphrase (the secret left out,
//    listed to re-enter) and with one (sealed, confirmed with the Hub's name); everything is
//    deleted (the Hub's name typed) and the Hub comes back on Settings → Data; the sealed export
//    is imported (its passphrase, a check, a confirmation). Integrity is checked against the
//    export's own manifest: an export made after the import has every table with the same rows
//    and checksum and every file with the same checksum, except the logs (the archive's entries
//    first, then the export, deletion and import entries), the sync state (the Hub adds its
//    message watermark as it starts) and the columns an import turns off (the plugin comes back
//    off, as the page reports). The content shows in the UI, and the restored extension runs
//    again once turned on.
// 4. The M8 demo: a right-to-left language (the shell mirrored), then the Aurora theme and the
//    Release notes plugin from the Marketplace (the built-in sample catalog, Verified, no sideload
//    confirmation), the theme applied in Appearance and the plugin's command used in a chat.
//
// Expected UI text comes from the web app's English catalog (apps/web/src/i18n/catalog.en.json,
// support/m8.ts `en`) where it is the app's own words.
//
// Deterministic: no real network (the undeclared host is refused before any request; the
// marketplace reads the sample catalog from disk), the offline Mock model with
// `/tool <name> <json>` lines, and waits on UI state only.
import { mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { expectNoSeriousA11yIssues } from './support/a11y.ts';
import type { RunningHub } from './support/hub.ts';
import {
  HELLO_ID,
  HELLO_NAME,
  auditLog,
  compareExports,
  download,
  en,
  helloBundle,
  installHello,
  json,
  literal,
  policyFile,
  readExport,
  refusal,
  rowsOf,
  setUpM8Hub,
  settingView,
  writePolicy,
} from './support/m8.ts';

const portFor = (parallelIndex: number) => 7741 + parallelIndex;
let hub: RunningHub | null = null;

test.use({ colorScheme: 'light' });
test.setTimeout(240_000);

test.afterEach(async () => {
  await hub?.stop();
  hub = null;
});

const messages = (page: Page) => page.getByLabel('Messages', { exact: true });
const approval = (page: Page) => messages(page).getByRole('group', { name: /Approval needed/ });
const composer = (page: Page) => page.getByLabel('Message', { exact: true });
const toast = (page: Page, text: string | RegExp) =>
  page.getByRole('region', { name: 'Notifications' }).getByText(text);

async function send(page: Page, text: string) {
  const box = composer(page);
  await box.fill(text);
  await box.press('Enter');
}

async function newChat(page: Page) {
  await page
    .getByRole('button', { name: /New chat/ })
    .first()
    .click();
}

/** Open the command palette and search it. */
async function palette(page: Page, query: string) {
  await page.getByRole('button', { name: 'Commands' }).click();
  await page.getByRole('combobox', { name: 'Search commands' }).fill(query);
  return page.getByRole('listbox');
}

const call = (name: string, args: unknown) => `/tool ${name} ${JSON.stringify(args)}`;

/** Every file called `name` under `dir`, recursively. */
function filesNamed(dir: string, name: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...filesNamed(full, name));
    else if (entry === name) out.push(full);
  }
  return out;
}

test('J10 step 1: a sample extension adds a command, a panel and a tool; its permissions are enforced', async ({
  page,
}, testInfo) => {
  hub = await setUpM8Hub(page, portFor(testInfo.parallelIndex));
  const { url } = hub;

  // Install from a file in Settings → Extensions: the preview says Unverified and lists what it
  // may do; Install needs the sideload confirmation.
  await page.goto(`${url}/settings/extensions`);
  await expect(page.getByRole('heading', { name: en('extensions.title'), level: 2 })).toBeVisible();
  await expectNoSeriousA11yIssues(page, 'settings/extensions');
  await page.getByTestId('novax-input').setInputFiles({
    name: 'hello-1.0.0.novax',
    mimeType: 'application/zip',
    buffer: helloBundle(),
  });
  const preview = page.getByRole('dialog', {
    name: en('extensions.preview.install', { name: HELLO_NAME, version: '1.0.0' }),
  });
  await expect(preview).toBeVisible();
  await expect(preview).toContainText(en('extensions.preview.unverifiedTitle'));
  const can = preview.getByRole('list', { name: en('extensions.preview.can') });
  await expect(can).toContainText('Reach api.example.com over the network');
  await expect(can).toContainText('Read and write its own data folder');
  await expect(can).toContainText('Offer the tool greet to models');
  await expect(can).toContainText('Offer the tool check_status to models');
  const install = preview.getByRole('button', {
    name: en('extensions.preview.installButton'),
    exact: true,
  });
  await expect(install).toBeDisabled();
  await expectNoSeriousA11yIssues(page, 'extension install preview');
  await preview
    .getByRole('checkbox', { name: 'I trust its source; install it unverified' })
    .check();
  await install.click();
  await expect(preview).toBeHidden();
  const card = page.locator(`li[data-extension="${HELLO_ID}"]`);
  await expect(card).toContainText(en('settings.badges.unverified'));
  await expect(card).toContainText(en('extensions.status.running'), { timeout: 20_000 });
  await expect(card).toContainText('1 command, 1 panel, 3 tools');

  // Its command, from the command palette; the status item it updates counts the run.
  const commands = await palette(page, 'say hello');
  await commands.getByRole('option', { name: /Hello: say hello/ }).click();
  // The command's result: its handler answers with a greeting (the secret is not set yet).
  await expect(
    toast(
      page,
      en('extensions.shell.result', { title: 'Hello: say hello', text: 'Hello, world!' }),
    ).first(),
  ).toBeVisible();
  const statusBar = page.getByRole('group', { name: en('extensions.shell.statusBar') });
  await expect(statusBar).toContainText('Hello: 1');

  // Its panel, from Settings → Extensions (Apps): served from its own files.
  await card.getByRole('link', { name: en('extensions.openAppOf', { title: 'Hello' }) }).click();
  await expect(page).toHaveURL(/\/apps\//);
  const panel = page.frameLocator('iframe[title="App: Hello"]');
  await expect(panel.getByRole('heading', { name: 'Hello from an extension' })).toBeVisible();
  await expectNoSeriousA11yIssues(page, 'extension panel');

  // Its tool, called by the model in a chat (read, allowed without asking).
  await page.goto(`${url}/chat`);
  await newChat(page);
  await send(page, call(`ext:${HELLO_ID}/greet`, { name: 'Ada' }));
  await expect(messages(page)).toContainText(`Tool ext:${HELLO_ID}/greet returned: Hello, Ada!`);
  await expect(approval(page)).toHaveCount(0);

  // A declared permission: its own data folder. The write asks first.
  await send(page, call(`ext:${HELLO_ID}/save_note`, { text: 'Remember the tea.' }));
  await expect(approval(page)).toBeVisible();
  await approval(page).getByRole('button', { name: 'Allow once', exact: true }).click();
  await expect(messages(page)).toContainText(`Tool ext:${HELLO_ID}/save_note returned: Saved.`);
  // The note is in the extension's own data folder on the Hub, nowhere else.
  const saved = filesNamed(join(hub.dataDir, 'extensions', 'data'), 'note.txt');
  expect(saved).toHaveLength(1);
  expect(readFileSync(saved[0]!, 'utf8')).toBe('Remember the tea.');
  const chatUrl = page.url();
  await expectNoSeriousA11yIssues(page, 'chat with the extension tools');

  // Turned off in Settings → Extensions, its command leaves the palette and its tool the model.
  await page.goto(`${url}/settings/extensions`);
  const run = card.getByRole('switch', { name: en('extensions.runSwitch', { name: HELLO_NAME }) });
  await expect(run).toBeChecked();
  await run.click();
  await expect(run).not.toBeChecked();
  await expect(card).toContainText(en('extensions.status.disabled'));
  await palette(page, 'say hello');
  await expect(page.getByRole('option', { name: /Hello: say hello/ })).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(statusBar).toHaveCount(0);
  const tools = async () =>
    (await json<{ items: { name: string }[] }>(await page.request.get(`${url}/api/v1/tools`))).items
      .map((t) => t.name)
      .filter((n) => n.startsWith(`ext:${HELLO_ID}/`))
      .sort();
  expect(await tools()).toEqual([]);
  await page.goto(chatUrl);
  await send(page, call(`ext:${HELLO_ID}/greet`, { name: 'Grace' }));
  await expect(messages(page)).toContainText(
    `Tool ext:${HELLO_ID}/greet returned: Error (unknown_tool): There is no tool named ext:${HELLO_ID}/greet.`,
  );
  // Turned on again, both are back.
  await page.goto(`${url}/settings/extensions`);
  await run.click();
  await expect(run).toBeChecked();
  await expect(card).toContainText(en('extensions.status.running'), { timeout: 20_000 });
  expect(await tools()).toEqual([
    `ext:${HELLO_ID}/check_status`,
    `ext:${HELLO_ID}/greet`,
    `ext:${HELLO_ID}/save_note`,
  ]);
  await palette(page, 'say hello');
  await expect(page.getByRole('option', { name: /Hello: say hello/ })).toBeVisible();
  await page.keyboard.press('Escape');

  // An undeclared host, asked for by the extension's own code: refused before any request leaves
  // the Hub, said in the chat's tool result, audited, and the extension is turned off with a
  // notification that leads to Settings → Extensions.
  await page.goto(chatUrl);
  await send(page, call(`ext:${HELLO_ID}/check_status`, { host: 'status.example.net' }));
  await expect(messages(page)).toContainText(
    `${HELLO_ID} asked for the host status.example.net, which it did not declare`,
  );
  await expect
    .poll(async () =>
      (await auditLog(page, url)).filter((a) => a.action === 'extension.access.denied'),
    )
    .toEqual([
      expect.objectContaining({
        actor: `ext:${HELLO_ID}`,
        decision: 'denied',
        detail: { extensionId: HELLO_ID, what: 'the host', target: 'status.example.net' },
      }),
    ]);
  const turnedOff = `Extension ${HELLO_ID} was turned off`;
  await page.getByRole('button', { name: /^Notifications/ }).click();
  const notice = page
    .getByRole('list', { name: 'Notifications' })
    .getByRole('listitem', { name: turnedOff });
  await expect(notice).toContainText('status.example.net');
  await notice
    .getByRole('button', { name: new RegExp(`^(Unread: )?${turnedOff.replaceAll('.', '\\.')}`) })
    .click();
  await expect(page).toHaveURL(/\/settings\/extensions$/);
  await expect(run).not.toBeChecked();
  await expect(card).toContainText(en('extensions.status.disabled'));
  expect(await tools()).toEqual([]);
});

test('J10 step 2: a managed policy locks Bypass and the network; the UI says managed; a stricter file applies on reload', async ({
  page,
}, testInfo) => {
  // The organization's policy: no Bypass, and sandboxes reach only api.example.com.
  const policy = policyFile();
  writePolicy(policy, {
    version: 1,
    serial: 1,
    restrict: {
      permissionModes: { deny: ['bypass'] },
      egress: { mode: 'allowlist', allow: ['api.example.com'] },
    },
  });
  hub = await setUpM8Hub(page, portFor(testInfo.parallelIndex), { policy });
  const { url } = hub;
  const testFile = en('managed.channel.test');
  /** The lock note of a control, naming the policy's source: "… (test policy file)". */
  const managedNote = new RegExp(
    `${literal(en('ui.managed'))}\\s*${literal(en('managed.lockSource.test'))}`,
  );
  const banner = page.getByRole('note').filter({ hasText: en('managed.bannerActive') });
  const bannerSource = en('managed.sourceAt', { source: testFile, location: policy });

  // Settings → Managed policy: in force from the test file, the restrictions in words (the
  // allowlist is a ceiling over the owner's own hosts), the hosts in force, the settings it sets.
  await page.goto(`${url}/settings/managed`);
  await expect(page.getByRole('heading', { name: en('managed.title'), level: 2 })).toBeVisible();
  await expect(page.getByText(en('managed.active'))).toBeVisible();
  const sources = page.getByRole('region', { name: en('managed.sourcesTitle') });
  const testSource = sources.getByRole('listitem').filter({ hasText: testFile });
  await expect(testSource).toContainText(en('managed.status.active'));
  await expect(testSource).toContainText(policy);
  await expect(testSource).toContainText(en('managed.testOverride'));
  const restrictions = page.getByRole('list', {
    name: en('managed.restrictionsFrom', { source: testFile }),
  });
  await expect(restrictions).toContainText(en('managed.restrict.modesDeny', { modes: 'Bypass' }));
  await expect(restrictions).toContainText(en('managed.restrict.egressAllowlist'));
  await expect(restrictions).toContainText(
    en('managed.restrict.egressAllow', { list: 'api.example.com' }),
  );
  // The owner set no hosts of their own, so the policy's are the hosts in force.
  await expect(
    page.getByText(en('managed.egressInForce', { list: 'api.example.com' })),
  ).toBeVisible();
  const set = page.getByRole('table', { name: en('managed.settingsCaption') });
  await expect(set.getByRole('row').filter({ hasText: 'code.allowBypass' })).toContainText(
    en('managed.off'),
  );
  await expect(set.getByRole('row').filter({ hasText: 'network.egressMode' })).toContainText(
    'allowlist',
  );
  await expectNoSeriousA11yIssues(page, 'settings/managed');

  // Settings → Code: Bypass is off and cannot be turned on; its lock note names the source.
  await page.goto(`${url}/settings/code`);
  const bypass = page.getByRole('switch', { name: en('settings.code.allowBypass') });
  await expect(bypass).not.toBeChecked();
  await expect(bypass).toBeDisabled();
  await expect(bypass).toHaveAccessibleDescription(managedNote);
  await expect(banner).toContainText(bannerSource);

  // Settings → Permissions: when to ask is set by the policy (never "Skip tool-default
  // questions", the chats' Bypass), locked, with the lock note naming the source and linked to
  // the group.
  await page.goto(`${url}/settings/permissions`);
  const whenToAsk = page.getByRole('group', { name: en('settings.permissions.whenToAsk') });
  await expect(whenToAsk).toHaveAccessibleDescription(managedNote);
  await expect(
    whenToAsk.getByRole('radio', { name: en('settings.permissions.policy.never_ask.label') }),
  ).not.toBeChecked();
  for (const radio of await whenToAsk.getByRole('radio').all()) await expect(radio).toBeDisabled();
  await expect(banner).toContainText(bannerSource);
  await expectNoSeriousA11yIssues(page, 'settings/permissions, managed');

  // Settings → Network: allowed hosts only, locked with the source. The owner lists no hosts of
  // their own, so the policy's are in force (the proxy's list, GET /egress); the owner's list
  // stays theirs to edit within the policy's ceiling.
  await page.goto(`${url}/settings/network`);
  const access = page.getByRole('group', { name: en('egress.access.legend') });
  await expect(
    access.getByRole('radio', { name: new RegExp(literal(en('computers.modes.allowlist.label'))) }),
  ).toBeChecked();
  for (const radio of await access.getByRole('radio').all()) await expect(radio).toBeDisabled();
  await expect(access).toHaveAccessibleDescription(managedNote);
  const inForce = page.getByRole('note', { name: en('egress.access.inForceLabel') });
  await expect(inForce).toContainText(en('egress.access.inForce', { list: 'api.example.com' }));
  const allowed = page.getByRole('group', { name: en('egress.access.allowed') });
  await expect(allowed).toContainText(en('egress.access.allowedNoneOwn'));
  await expect(
    allowed.getByRole('textbox', { name: en('egress.access.addAllowed') }),
  ).toBeEnabled();
  const egress = await json<{ global: { mode: string; allow: string[] } }>(
    await page.request.get(`${url}/api/v1/egress`),
  );
  expect(egress.global).toMatchObject({ mode: 'allowlist', allow: ['api.example.com'] });
  await expect(banner).toContainText(bannerSource);
  await expectNoSeriousA11yIssues(page, 'settings/network, managed');

  // The locked change, and an own host outside the policy's ceiling, tried through the API, are
  // refused as managed.
  const patch = (key: string, value: unknown) =>
    page.request.patch(`${url}/api/v1/settings`, { data: { key, value } });
  expect(await refusal(await patch('code.allowBypass', true))).toEqual({
    status: 403,
    code: 'policy_denied',
    reason: 'managed',
  });
  expect(
    await refusal(await patch('network.egressAllow', ['api.example.com', 'files.example.org'])),
  ).toEqual({ status: 403, code: 'policy_denied', reason: 'managed' });
  expect(await settingView(page, url, 'code.allowBypass')).toMatchObject({
    value: false,
    locked: true,
    source: 'managed',
  });

  // An unverified extension installed while the policy allows it (setup).
  await installHello(page, url);

  // A stricter policy: no network at all and only verified installs. "Check for changes" reads it
  // again and it applies at once.
  writePolicy(policy, {
    version: 1,
    serial: 2,
    restrict: {
      permissionModes: { deny: ['bypass'] },
      egress: { mode: 'off' },
      unverifiedInstalls: false,
    },
  });
  await page.goto(`${url}/settings/managed`);
  await expect(restrictions).toContainText(en('managed.restrict.egressAllowlist'));
  await page.getByRole('button', { name: en('managed.reload') }).click();
  await expect(page.getByRole('status').filter({ hasText: en('managed.reloaded') })).toBeVisible();
  await expect(restrictions).toContainText(en('managed.restrict.egressOff'));
  await expect(restrictions).toContainText(en('managed.restrict.verifiedOnly'));
  await expect(restrictions).not.toContainText(
    en('managed.restrict.egressAllow', { list: 'api.example.com' }),
  );
  await page.goto(`${url}/settings/network`);
  const off = access.getByRole('radio', {
    name: new RegExp(`^${literal(en('computers.modes.off.label'))}`),
  });
  await expect(off).toBeChecked();
  await expect(off).toBeDisabled();
  // The running unverified extension is stopped; another unverified install cannot be chosen.
  await page.goto(`${url}/settings/extensions`);
  const card = page.locator(`li[data-extension="${HELLO_ID}"]`);
  await expect(card).toContainText(en('extensions.status.stopped'));
  await expect(page.getByText(en('market.policy.unverifiedOff'))).toBeVisible();
  await page.getByTestId('novax-input').setInputFiles({
    name: 'hello-1.0.0.novax',
    mimeType: 'application/zip',
    buffer: helloBundle(),
  });
  const again = page.getByRole('dialog', { name: new RegExp(`${HELLO_NAME}`) });
  await expect(again).toContainText(en('extensions.preview.policyBlock'));
  await expectNoSeriousA11yIssues(page, 'extension preview refused by policy');
  const actions = (await auditLog(page, url)).map((a) => a.action);
  expect(actions).toEqual(
    expect.arrayContaining(['managed.policy.loaded', 'managed.policy.reload']),
  );
});

test('J10 step 3: export without and with a passphrase, delete everything, import; every table comes back', async ({
  page,
}, testInfo) => {
  hub = await setUpM8Hub(page, portFor(testInfo.parallelIndex));
  const { url } = hub;
  const api = (path: string) => `${url}/api/v1${path}`;
  const PASS = 'correct horse battery staple';
  // secret-scan: fake
  const SECRET = 'Howdy-5c1e0d9a7b';

  // Content (setup): a chat with an attachment and the Mock's reply, a project, a memory, a
  // setting, and a plugin (the sample extension, with a secret it declared).
  const project = await json<{ id: string }>(
    await page.request.post(api('/projects'), { data: { name: 'Garden' } }),
  );
  await json(
    await page.request.post(api('/memory/items'), { data: { content: 'Likes jasmine tea' } }),
  );
  await json(
    await page.request.patch(api('/settings'), { data: { key: 'chat.suggestions', value: false } }),
  );
  const thread = await json<{ id: string }>(
    await page.request.post(api('/threads'), { data: { title: 'Plans for the garden' } }),
  );
  await json(
    await page.request.post(api(`/threads/${thread.id}/messages`), {
      data: {
        text: 'Where should the roses go?',
        attachments: [
          {
            name: 'beds.txt',
            mime: 'text/plain',
            data: Buffer.from('North bed: roses. South bed: herbs.').toString('base64'),
          },
        ],
      },
    }),
  );
  await expect
    .poll(async () => {
      const t = await json<{ messages: { role: string; status: string }[] }>(
        await page.request.get(api(`/threads/${thread.id}`)),
      );
      return t.messages.some((m) => m.role === 'assistant' && m.status === 'complete');
    })
    .toBe(true);
  await installHello(page, url);
  await json(
    await page.request.put(api(`/extensions/${HELLO_ID}/secrets/greeting`), {
      data: { value: SECRET },
    }),
  );
  const { hubName } = await json<{ hubName: string }>(await page.request.get(api('/data')));

  // Settings → Data: export without a passphrase. The stored key is left out, listed to re-enter.
  const typeName = new RegExp(literal(en('datactl.sentences.typeName', { name: hubName })), 'i');
  await page.goto(`${url}/settings/data`);
  await expect(page.getByRole('heading', { name: en('datactl.title'), level: 2 })).toBeVisible();
  const exportSection = page.getByRole('region', { name: en('datactl.exportTitle') });
  const exportButton = exportSection.getByRole('button', { name: en('datactl.exportButton') });
  await expect(exportSection).toBeVisible();
  await expectNoSeriousA11yIssues(page, 'settings/data');
  const plainFile = await download(page, () => exportButton.click());
  await expect(exportSection.getByRole('status')).toContainText(en('datactl.exportStarted'));
  expect(readFileSync(plainFile).includes(Buffer.from(SECRET)), 'the secret in clear').toBe(false);
  const plain = await readExport(plainFile);
  expect(plain.manifest.encrypted).toBe(false);
  expect(plain.manifest.toReEnter).toEqual(
    expect.arrayContaining([expect.stringMatching(new RegExp(`/${HELLO_ID}/greeting$`))]),
  );

  // With a passphrase: sealed, the stored keys inside, confirmed with the Hub's name.
  await exportSection.getByLabel(en('datactl.passphrase')).fill(PASS);
  await exportSection.getByLabel(en('datactl.passphraseRepeat')).fill(PASS);
  await exportSection.getByLabel(typeName).fill(hubName);
  const sealedFile = await download(page, () => exportButton.click());
  expect(readFileSync(sealedFile).subarray(0, 8).toString()).toBe('NOVAEXP1');
  expect(readFileSync(sealedFile).includes(Buffer.from(SECRET)), 'the secret in clear').toBe(false);
  const sealed = await readExport(sealedFile, PASS);
  expect(sealed.manifest.encrypted).toBe(true);
  expect(sealed.manifest.secrets?.count).toBeGreaterThan(0);
  expect(sealed.manifest.toReEnter).toEqual([]);

  // Delete everything: the dialog says what goes and needs the Hub's name typed.
  const deleteSection = page.getByRole('region', { name: en('datactl.deleteTitle') });
  await deleteSection.getByRole('button', { name: en('datactl.deleteButton') }).click();
  const confirmDelete = page.getByRole('dialog', { name: en('datactl.deleteConfirmTitle') });
  const deleteButton = confirmDelete.getByRole('button', { name: en('datactl.deleteConfirm') });
  await expect(deleteButton).toBeDisabled();
  await expectNoSeriousA11yIssues(page, 'delete-all dialog');
  await confirmDelete.getByLabel(typeName).fill(hubName);
  await deleteButton.click();
  await expect(page.getByRole('heading', { name: en('datactl.deleteDone') })).toBeVisible();
  // The page reloads once the Hub is back and stays on Settings → Data, ready for an import.
  const importSection = page.getByRole('region', { name: en('datactl.importTitle') });
  await expect(importSection).toBeVisible({ timeout: 30_000 });
  await expect(page).toHaveURL(/\/settings\/data/);
  const empty = await json<{ empty: boolean }>(await page.request.get(api('/data')));
  expect(empty.empty).toBe(true);
  expect((await json<{ items: unknown[] }>(await page.request.get(api('/threads')))).items).toEqual(
    [],
  );

  // Import the sealed export: its passphrase, what it holds, then an explicit confirmation.
  await importSection.getByLabel(en('datactl.importChoose')).setInputFiles(sealedFile);
  await expect(importSection).toContainText(en('datactl.importEncrypted'));
  await importSection.getByLabel(en('datactl.importPassphrase'), { exact: true }).fill(PASS);
  await importSection.getByRole('button', { name: en('datactl.checkButton') }).click();
  await expect(importSection).toContainText(en('datactl.checkTitle'));
  await importSection.getByRole('button', { name: en('datactl.importButton') }).click();
  const confirmImport = page.getByRole('dialog', { name: en('datactl.importConfirmTitle') });
  await expect(confirmImport).toContainText(
    en('datactl.sentences.secretsCome', { n: sealed.manifest.secrets!.count }),
  );
  await expectNoSeriousA11yIssues(page, 'import dialog');
  const [imported] = await Promise.all([
    page.waitForResponse(
      (r) => r.url().endsWith('/api/v1/data/import') && r.request().method() === 'POST',
    ),
    confirmImport.getByRole('button', { name: en('datactl.importConfirm') }).click(),
  ]);
  const result = (await imported.json()) as {
    verified: boolean;
    restoredOff: { plugins: number; hooks: number; sessions: number; mcpServers: number };
  };
  expect(result.verified).toBe(true);
  await expect(page.getByRole('heading', { name: en('datactl.importDone') })).toBeVisible();
  // What an archive cannot vouch for came back off, and the page says so.
  expect(result.restoredOff).toMatchObject({ plugins: 1, mcpServers: 0, hooks: 0 });
  await expect(page.getByText(en('datactl.sentences.restoredOff.plugins', { n: 1 }))).toBeVisible();
  await expect(importSection).toBeVisible({ timeout: 30_000 });

  // Integrity: a new export's tables match the imported export's manifest, table by table.
  const again = await page.request.post(api('/data/export'), {
    data: { passphrase: PASS, confirm: hubName },
  });
  expect(again.ok()).toBe(true);
  const againFile = join(mkdtempSync(join(tmpdir(), 'nova-e2e-export-')), 'after.novaexport');
  writeFileSync(againFile, await again.body());
  const after = await readExport(againFile, PASS);
  expect(compareExports(sealed, after)).toEqual([]);
  // The comparison covers the content: each kind made above is in the archive.
  const rows = rowsOf(sealed);
  for (const table of [
    'thread',
    'message',
    'attachment',
    'project',
    'memory_item',
    'setting',
    'plugin_install',
    'extension_install',
  ])
    expect(rows[table], table).toBeGreaterThan(0);
  expect(after.manifest.secrets?.count).toBe(sealed.manifest.secrets?.count);

  // The content is back in the UI.
  await page.goto(`${url}/chat/${thread.id}`);
  await expect(messages(page)).toContainText('Where should the roses go?');
  await expect(messages(page)).toContainText('beds.txt');
  await page.goto(`${url}/projects/${project.id}`);
  await expect(page.getByRole('heading', { name: 'Garden' })).toBeVisible();
  await page.goto(`${url}/settings/memory`);
  await expect(page.getByText('Likes jasmine tea')).toBeVisible();
  await page.goto(`${url}/settings/extensions`);
  const card = page.locator(`li[data-extension="${HELLO_ID}"]`);
  await expect(card).toContainText(en('extensions.status.disabled'));
  await expect(
    card.getByRole('listitem', { name: en('extensions.secretRow', { name: 'greeting' }) }),
  ).toContainText(en('extensions.secretSet'));
  // Turned on again by the owner, it runs.
  await card
    .getByRole('switch', { name: en('extensions.runSwitch', { name: HELLO_NAME }) })
    .click();
  await expect(card).toContainText(en('extensions.status.running'), { timeout: 20_000 });
});

test('M8 demo: a right-to-left language; the Aurora theme and the Release notes plugin from the Marketplace, applied and used', async ({
  page,
}, testInfo) => {
  hub = await setUpM8Hub(page, portFor(testInfo.parallelIndex));
  const { url } = hub;

  // A right-to-left language (Settings → Appearance → Language, FR-016): the document turns
  // right to left, the shell is mirrored (the sidebar at the inline start, now the right) and
  // shows its Arabic labels (read from the translation catalog), and it still passes the
  // accessibility checks. Languages are listed by their own names, so English is found again.
  // Layout overlap and clipping are e2e/rtl-layout.spec.ts's.
  const arabic = JSON.parse(
    readFileSync('apps/web/src/i18n/locales/ar/shell.sidebar.json', 'utf8'),
  ) as Record<'sidebar' | 'settings', string>;
  await page.goto(`${url}/settings/appearance`);
  await page.getByRole('radio', { name: /العربية/ }).check();
  const html = page.locator('html');
  await expect(html).toHaveAttribute('dir', 'rtl');
  await expect(html).toHaveAttribute('lang', 'ar');
  await expect
    .poll(async () => (await settingView(page, url, 'appearance.locale'))?.value)
    .toBe('ar');
  const sidebar = page.getByRole('navigation', { name: arabic.sidebar });
  await expect(sidebar.getByRole('link', { name: new RegExp(arabic.settings) })).toBeVisible();
  const side = (await sidebar.boundingBox())!;
  const content = (await page.locator('main').boundingBox())!;
  expect(side.x, 'the sidebar is on the right').toBeGreaterThan(content.x);
  await expectNoSeriousA11yIssues(page, 'settings/appearance in Arabic (right to left)');
  await page.getByRole('radio', { name: 'English', exact: true }).check();
  await expect(html).toHaveAttribute('dir', 'ltr');
  await expect(html).toHaveAttribute('lang', 'en');
  await expect(page.getByRole('navigation', { name: 'Sidebar' })).toBeVisible();

  // The Marketplace is in the sidebar; the built-in sample catalog is signed and pinned.
  await page
    .getByRole('navigation', { name: 'Sidebar' })
    .getByRole('link', { name: 'Marketplace' })
    .click();
  await expect(page).toHaveURL(/\/marketplace$/);
  await expect(page.getByRole('heading', { name: 'Marketplace', level: 2 })).toBeVisible();

  // Themes: Aurora, Verified, installs without a sideload confirmation.
  await page.getByRole('tab', { name: en('market.sections.themes') }).click();
  const aurora = page.locator('li[data-item="com.examplelabs.aurora"]');
  await expect(aurora).toContainText(en('settings.badges.verified'));
  await expect(aurora).toContainText(en('market.by', { author: 'Example Labs' }));
  await expectNoSeriousA11yIssues(page, 'marketplace themes');
  await aurora.getByRole('button', { name: en('market.installOf', { name: 'Aurora' }) }).click();
  const installTheme = page.getByRole('dialog', {
    name: en('market.installDialog.install', { name: 'Aurora', version: '1.0.0' }),
  });
  // Verified by the sample catalog's pinned key; no sideload confirmation.
  await expect(installTheme).toContainText(en('settings.badges.verified'));
  await expect(installTheme).not.toContainText(en('market.installDialog.unverifiedTitle'));
  await expectNoSeriousA11yIssues(page, 'marketplace install dialog');
  await installTheme
    .getByRole('button', { name: en('market.installDialog.installButton'), exact: true })
    .click();
  await expect(installTheme).toBeHidden();
  await expect(toast(page, en('market.installedToast', { name: 'Aurora' })).first()).toBeVisible();
  await expect(aurora).toContainText(en('market.installedVersion', { version: '1.0.0' }));

  // Applied from Settings → Appearance → Your themes: the page takes Aurora's colors (its accent
  // and background tokens) over its dark base.
  await page.goto(`${url}/settings/appearance`);
  const yours = page.getByRole('list', { name: en('settings.themes.yours') });
  await yours
    .getByRole('button', { name: en('settings.themes.labelForUse', { name: 'Aurora' }) })
    .click();
  await expect(toast(page, en('settings.themes.using', { name: 'Aurora' })).first()).toBeVisible();
  const token = (name: string) =>
    page.evaluate(
      (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim().toLowerCase(),
      name,
    );
  await expect.poll(() => token('--u-accent')).toBe('#7ee0c3');
  await expect.poll(() => token('--u-bg')).toBe('#0b1020');
  expect((await settingView(page, url, 'appearance.theme'))?.value).toBe('dark');
  await expectNoSeriousA11yIssues(page, 'settings/appearance with Aurora');

  // Plugins: Release notes, Verified, then used: its slash command loads its instructions.
  await page.goto(`${url}/marketplace`);
  const notes = page.locator('li[data-item="com.examplelabs.release-notes"]');
  await expect(notes).toContainText(en('settings.badges.verified'));
  await notes
    .getByRole('button', { name: en('market.installOf', { name: 'Release notes' }) })
    .click();
  const installPlugin = page.getByRole('dialog', {
    name: en('market.installDialog.install', { name: 'Release notes', version: '1.0.0' }),
  });
  await expect(installPlugin).toContainText(en('settings.badges.verified'));
  await expect(installPlugin).not.toContainText(en('market.installDialog.unverifiedTitle'));
  await installPlugin
    .getByRole('button', { name: en('market.installDialog.installButton'), exact: true })
    .click();
  await expect(installPlugin).toBeHidden();
  await expect(notes).toContainText(en('market.installedVersion', { version: '1.0.0' }));
  const installed = await json<{ items: { itemId: string; verified: boolean }[] }>(
    await page.request.get(`${url}/api/v1/market/installed`),
  );
  expect(installed.items.map((i) => [i.itemId, i.verified]).sort()).toEqual([
    ['com.examplelabs.aurora', true],
    ['com.examplelabs.release-notes', true],
  ]);

  await page.goto(`${url}/chat`);
  await newChat(page);
  await composer(page).pressSequentially('/chan');
  await page
    .getByRole('listbox', { name: 'Slash commands' })
    .getByRole('option', { name: /\/changelog-entry/ })
    .click();
  await expect(composer(page)).toHaveValue('/changelog-entry ');
  await composer(page).pressSequentially('2.1.0');
  await composer(page).press('Enter');
  await expect(messages(page)).toContainText('You said: 2.1.0');
  await expect(messages(page)).toContainText('The user loaded this skill with /changelog-entry.');
  await expect(messages(page)).toContainText(
    'Write a changelog entry for the version the user names',
  );
  await expectNoSeriousA11yIssues(page, 'chat in the Aurora theme');
});
