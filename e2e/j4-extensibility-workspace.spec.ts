// J4 — Extensibility & workspace (docs/18 §3, M4 exit criteria in docs/17): the sample plugin
// installed from a local catalog with its sideload confirmation, its slash command loading its
// skill, an undeclared host denied by the plugin's permissions, its hook trusted by hash and
// needing trust again after an edit, its MCP App inline → full screen → picture in picture with an
// approval for the app's own tool call, an unsigned MCP bundle whose secret lands in the vault,
// panes that survive a Hub restart, and usage insights. The offline Mock provider drives tool calls
// with `/tool <name> <json>` lines (packages/providers mock).
//
// Command hooks run in the Hub's container sandbox. The Playwright container has no container
// runtime, so a trusted command hook fails closed there, while CI runners have one. This journey
// therefore checks hook trust in the UI (and never calls the hooked tool once its hook is trusted)
// and leaves "a hook runs only once trusted" and "a hook cannot turn a deny into an allow" to
// packages/core/test/hooks.test.ts ("trusts by hash only, …", "never loosens a deny, …"),
// packages/core/test/gate-hooks.test.ts ("tightens an allow to a deny …; never changes a deny") and
// packages/policy/test/plugins-hooks.test.ts. A terminal pane needs the same sandbox: the pane is
// restored either way, and without a sandbox starting a shell in it shows the unavailable note.
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { zipSync } from 'fflate';
import { expect, test, type Page } from '@playwright/test';
import { expectNoSeriousA11yIssues } from './support/a11y.ts';
import { startHub, type RunningHub } from './support/hub.ts';

const portFor = (parallelIndex: number) => 7561 + parallelIndex;
const CATALOG = resolve('examples/catalog');
const BUNDLE_DIR = resolve('examples/bundles/hello');
const PLUGIN_ID = 'com.example.sample';
const HOOK_ID = `hook:${PLUGIN_ID}.check-fetch`;
/** The bundle's sensitive setting: it must reach the vault and no other file. */
const BUNDLE_KEY = 'hello-key-5f1c9e7a2b6d4083';
let hub: RunningHub;

test.use({ colorScheme: 'light' });
test.describe.configure({ mode: 'serial' });
test.setTimeout(240_000);

test.afterEach(async () => {
  await hub?.stop();
});

const messages = (page: Page) => page.getByLabel('Messages', { exact: true });
const approval = (page: Page) => messages(page).getByRole('group', { name: /Approval needed/ });
/** The composer; it is a combobox while the slash list is open, so it is found by its label. */
const composer = (page: Page) => page.getByLabel('Message', { exact: true });

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

/** What GET /diagnostics says about the sandbox and where secrets are kept. */
async function diagnostics(page: Page, url: string) {
  const res = await page.request.get(`${url}/api/v1/diagnostics`);
  return (await res.json()) as {
    sandbox: { available: boolean };
    secrets: { backend: 'vault' | 'keychain' | 'memory' };
  };
}

/** An MCP server's status, from GET /mcp/servers. */
async function serverStatus(page: Page, url: string, name: string) {
  const res = await page.request.get(`${url}/api/v1/mcp/servers`);
  const { items } = (await res.json()) as { items: { name: string; status: string }[] };
  return items.find((s) => s.name === name)?.status ?? null;
}

async function decide(page: Page, label: string) {
  const card = approval(page);
  await expect(card).toBeVisible();
  await card.getByRole('button', { name: label, exact: true }).click();
}

/** Every file under `dir`, recursively. */
function filesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const st = statSync(full, { throwIfNoEntry: false });
    if (!st) continue;
    if (st.isDirectory()) out.push(...filesUnder(full));
    else if (st.isFile()) out.push(full);
  }
  return out;
}

/** Whether a file holds these bytes; a file removed meanwhile holds nothing. */
function holds(file: string, needle: Buffer): boolean {
  try {
    return readFileSync(file).includes(needle);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw err;
  }
}

/** The sample bundle as an `.mcpb`: a zip with manifest.json at its root (packages/mcp bundle.ts). */
function bundleZip(dir: string): Buffer {
  const entries: Record<string, Uint8Array> = {};
  for (const file of filesUnder(dir))
    entries[relative(dir, file).split(sep).join('/')] = readFileSync(file);
  return Buffer.from(zipSync(entries));
}

test('J4: plugin, skill, permissions, hook trust, MCP App, bundle, panes, usage', async ({
  page,
}, testInfo) => {
  hub = await startHub({ port: portFor(testInfo.parallelIndex) });
  const workspace = join(hub.dataDir, 'workspace');
  mkdirSync(workspace, { recursive: true });
  writeFileSync(join(workspace, 'notes.txt'), 'Quarterly notes: revenue is up.');

  await page.goto(`${hub.url}/#setup=${hub.setupCode}`);
  await page.getByRole('button', { name: 'Finish setup' }).click();
  await page.getByRole('button', { name: 'Skip setup' }).click();

  // 1. Add the local catalog in Settings → Plugins, find the sample plugin and preview it.
  await page.goto(`${hub.url}/settings/plugins`);
  await page.locator('summary', { hasText: 'Your catalogs' }).click();
  await page.getByLabel('Catalog name').fill('Local examples');
  await page.getByLabel('Catalog location').fill(CATALOG);
  await page.getByRole('button', { name: 'Add catalog' }).click();
  await expect(page.getByRole('list', { name: 'Your catalogs' })).toContainText(CATALOG);
  await page.getByRole('searchbox', { name: 'Search plugins' }).fill('sample');
  const entry = page
    .getByRole('list', { name: 'Catalog plugins' })
    .getByRole('listitem')
    .filter({ hasText: 'Local examples' });
  await expect(entry).toContainText('Sample plugin');
  await expect(entry).toContainText('Unverified');
  await expectNoSeriousA11yIssues(page, 'settings/plugins');
  await entry.getByRole('button', { name: 'Install Sample plugin' }).click();

  // The preview: Unverified, the permissions in words, the hook with its event and hash.
  const dialog = page.getByRole('dialog', { name: 'Install Sample plugin 1.0.0?' });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('Unverified');
  await expect(dialog).toContainText('Reach these hosts on the network: api.example.com');
  await expect(dialog).toContainText('Tool plugin:com.example.sample.panel_action can change data');
  const hookRow = dialog.getByRole('listitem', { name: `Hook ${HOOK_ID}` });
  await expect(hookRow).toContainText('Before tool use');
  const installHash = (await hookRow.locator('code', { hasText: /^sha256:/ }).innerText()).trim();
  expect(installHash).toMatch(/^sha256:[0-9a-f]{64}$/);
  // Installing needs the explicit sideload confirmation; the hook stays untrusted.
  const install = dialog.getByRole('button', { name: 'Install', exact: true });
  await expect(install).toBeDisabled();
  await expect(hookRow.getByRole('checkbox', { name: `Trust ${HOOK_ID} now` })).not.toBeChecked();
  await expectNoSeriousA11yIssues(page, 'plugin install dialog');
  await dialog.getByRole('checkbox', { name: 'I trust its source; install it unverified' }).check();
  await install.click();
  await expect(dialog).toBeHidden();
  const installed = page.getByRole('list', { name: 'Installed plugins' }).getByRole('listitem', {
    name: 'Sample plugin',
  });
  await expect(installed).toContainText('Unverified');
  await expect(installed).toContainText('Hooks need trust');

  // Its MCP server connects (Settings → Tools).
  await page.goto(`${hub.url}/settings/tools`);
  const sampleServer = page.getByRole('listitem', { name: 'sample', exact: true });
  await expect(sampleServer).toContainText('Connected', { timeout: 30_000 });

  // Its slash command, chosen from the composer's list, loads the command's skill for the turn:
  // the Mock model echoes what it was sent, which is the request plus the skill's instructions.
  await page.goto(`${hub.url}/chat`);
  await newChat(page);
  await composer(page).pressSequentially('/gre');
  const slash = page.getByRole('listbox', { name: 'Slash commands' });
  await slash.getByRole('option', { name: /\/greet/ }).click();
  await expect(composer(page)).toHaveValue('/greet ');
  await composer(page).pressSequentially('Ada');
  await composer(page).press('Enter');
  await expect(messages(page)).toContainText('You said: Ada');
  await expect(messages(page)).toContainText('The user loaded this skill with /greet.');
  await expect(messages(page)).toContainText('Greet the person the user names');

  // 2. A host the plugin declared is reached without asking (fetch_status is a read tool and the
  //    plugin's read default allows). A host it did not declare is denied at once, with the
  //    reason and no approval to give, and the plugin is turned off with a notification
  //    (docs/08 §3.1, docs/20 "Deny + disable + notify").
  await send(page, '/tool mcp:sample.fetch_status {"url":"https://api.example.com/health"}');
  await expect(messages(page)).toContainText('Would check api.example.com');
  await expect(approval(page)).toHaveCount(0);
  await send(page, '/tool mcp:sample.fetch_status {"url":"https://not-declared.example.net/x"}');
  await expect(messages(page)).toContainText(
    'not-declared.example.net is not a host this plugin declared',
  );
  await expect(approval(page)).toHaveCount(0);
  const chatUrl = page.url();
  const turnedOff = `Plugin ${PLUGIN_ID} was turned off`;
  await page.getByRole('button', { name: /^Notifications/ }).click();
  const notice = page
    .getByRole('list', { name: 'Notifications' })
    .getByRole('listitem', { name: turnedOff });
  await expect(notice).toContainText('not-declared.example.net');
  // The notification leads to Settings → Plugins, where the plugin is off; turn it back on.
  await notice
    .getByRole('button', { name: new RegExp(`^(Unread: )?${turnedOff.replaceAll('.', '\\.')}`) })
    .click();
  await expect(page).toHaveURL(/\/settings\/plugins$/);
  const pluginSwitch = installed.getByRole('switch', { name: 'Turn on Sample plugin' });
  await expect(pluginSwitch).not.toBeChecked();
  await expect(installed.getByText('Off', { exact: true })).toBeVisible();
  await pluginSwitch.click();
  await expect(pluginSwitch).toBeChecked();
  await expect(installed).toContainText('Hooks need trust');

  // 3. The hook needs trust in Settings, with the hash the install screen showed; trust it.
  const hooks = page.getByRole('list', { name: 'Hooks' });
  const hook = hooks.getByRole('listitem', { name: HOOK_ID });
  await expect(hook).toContainText('Needs trust');
  await hook.getByRole('button', { name: `Trust ${HOOK_ID}` }).click();
  const trustDialog = page.getByRole('dialog', { name: 'Trust this hook?' });
  await expect(trustDialog.getByTestId('trust-hash')).toHaveText(installHash);
  await trustDialog.getByRole('button', { name: 'Trust', exact: true }).click();
  await expect(trustDialog).toBeHidden();
  await expect(hook).toContainText('Trusted');
  await expect(hook.getByRole('button', { name: `Untrust ${HOOK_ID}` })).toBeVisible();

  // Edit the installed hook file → after a reload it needs trust again and says it changed.
  const hooksFile = join(hub.dataDir, 'plugins', PLUGIN_ID, '1.0.0', 'hooks', 'hooks.json');
  const edited = JSON.parse(readFileSync(hooksFile, 'utf8')) as {
    hooks: { handler: { timeoutMs: number } }[];
  };
  edited.hooks[0]!.handler.timeoutMs = 5000;
  writeFileSync(hooksFile, JSON.stringify(edited, null, 2));
  await page.reload();
  await expect(hook).toContainText('Needs trust');
  await expect(hook).toContainText('Changed since you trusted it');
  await expect(hook).toContainText('timeout 5 s');
  await expect(installed).toContainText('Hooks need trust');
  await hook.getByRole('button', { name: `Trust ${HOOK_ID}` }).click();
  const newHash = (await trustDialog.getByTestId('trust-hash').innerText()).trim();
  expect(newHash).toMatch(/^sha256:[0-9a-f]{64}$/);
  expect(newHash).not.toBe(installHash);
  await trustDialog.getByRole('button', { name: 'Trust', exact: true }).click();
  await expect(hook).toContainText('Trusted');
  await expect(hook).not.toContainText('Changed since you trusted it');
  await expect(installed).toContainText('Ready');

  // 4. The plugin's MCP App: inline in the chat (Inspector → Apps), full screen, picture in
  //    picture. Its button calls the plugin's panel_action tool; the call carries no instruction
  //    from the user, so the chat shows an approval card; Allow once → the app shows the result.
  //    The plugin's server restarted when the plugin was turned back on.
  await expect
    .poll(() => serverStatus(page, hub.url, 'sample'), { timeout: 30_000 })
    .toBe('connected');
  await page.goto(`${hub.url}/apps`);
  await expect(page.getByRole('list', { name: 'Apps' })).toContainText('Sample panel');
  await expectNoSeriousA11yIssues(page, 'apps view');
  await page.goto(chatUrl);
  await expect(messages(page)).toContainText('You said: Ada');
  const inspector = page.getByRole('complementary', { name: 'Inspector' });
  await inspector.getByRole('tab', { name: 'Apps' }).click();
  await inspector
    .getByRole('list', { name: 'Apps for this chat' })
    .getByRole('button', { name: 'Open Sample panel' })
    .click();
  // The app in the Inspector (its own tool calls are not shown as the model's).
  const app = inspector.locator('section.app-frame');
  await expect(app).toHaveAttribute('data-mode', 'inline');
  await expect(app.getByRole('heading', { name: 'Sample panel' })).toBeVisible();
  await expect(app).toContainText('Sample plugin');
  await expect(app).toContainText('Unverified');
  const panel = app.frameLocator('iframe[title="App: Sample panel"]');
  const run = panel.getByRole('button', { name: 'Run panel action' });
  await expect(run).toBeEnabled();
  await expectNoSeriousA11yIssues(page, 'chat with the app inline');
  // Switching Inspector tabs parks the app out of sight; it keeps running, never stopped.
  await inspector.getByRole('tab', { name: 'Files' }).click();
  await inspector.getByRole('tab', { name: 'Apps' }).click();
  await expect(app.getByText('The app left its page')).toHaveCount(0);
  await expect(run).toBeEnabled();
  const display = app.getByRole('group', { name: 'Sample panel display' });
  await display.getByRole('button', { name: 'Full screen' }).click();
  await expect(app).toHaveAttribute('data-mode', 'fullscreen');
  await expect(page.getByRole('dialog', { name: 'Sample panel' })).toBeVisible();
  await expect(display.getByRole('button', { name: 'Exit full screen' })).toBeFocused();
  await display.getByRole('button', { name: 'Picture in picture' }).click();
  await expect(app).toHaveAttribute('data-mode', 'pip');
  await expect(display.getByRole('button', { name: 'Picture in picture' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await run.click();
  await expect(panel.getByText('Waiting for Nova…')).toBeVisible();
  await expect(approval(page)).toContainText('Panel action');
  await expect(approval(page)).toContainText('Not from your message');
  await decide(page, 'Allow once');
  await expect(panel.getByText('Result: Panel action recorded: Button press 1')).toBeVisible();
  await app.getByRole('button', { name: 'Close Sample panel' }).click();
  await expect(app).toHaveCount(0);

  // 5. An unsigned MCP bundle (Settings → Tools): explicit sideload confirmation, Unverified,
  //    and its sensitive setting stored in the vault, never in a file as written.
  const { secrets } = await diagnostics(page, hub.url);
  const vaultFile = join(hub.dataDir, 'secrets.vault');
  const vaultBefore = existsSync(vaultFile) ? readFileSync(vaultFile) : Buffer.alloc(0);
  await page.goto(`${hub.url}/settings/tools`);
  await page.getByLabel('Bundle file').setInputFiles({
    name: 'hello.mcpb',
    mimeType: 'application/zip',
    buffer: bundleZip(BUNDLE_DIR),
  });
  const bundle = page.getByRole('dialog', { name: 'Install Hello (sample bundle) 1.0.0?' });
  await expect(bundle).toContainText('Unverified');
  await expect(bundle).toContainText('the bundle is not signed');
  await bundle.getByLabel('API key (optional)').fill(BUNDLE_KEY);
  const installBundle = bundle.getByRole('button', { name: 'Install', exact: true });
  await expect(installBundle).toBeDisabled();
  await expectNoSeriousA11yIssues(page, 'bundle install dialog');
  await bundle
    .getByRole('checkbox', { name: 'I trust where this bundle came from; install it unverified' })
    .check();
  await installBundle.click();
  await expect(bundle).toBeHidden();
  const helloServer = page.getByRole('listitem', { name: 'nova-hello', exact: true });
  await expect(helloServer).toContainText('Unverified');
  await expect(helloServer).toContainText('bundle nova-hello 1.0.0');
  await expect(helloServer).toContainText('Connected', { timeout: 30_000 });
  await expect(helloServer.getByText('HELLO_API_KEY')).toBeVisible();
  await expect(page.getByText(BUNDLE_KEY)).toHaveCount(0);

  // The server gets the key at launch from the vault reference.
  await page.goto(chatUrl);
  await send(page, '/tool mcp:nova-hello.settings_check {}');
  await decide(page, 'Allow once');
  await expect(messages(page)).toContainText(`an API key is set (${BUNDLE_KEY.length} characters)`);

  // The raw value is in no file under the Hub's data folder; the server's env holds a reference.
  const needle = Buffer.from(BUNDLE_KEY);
  const leaks = filesUnder(hub.dataDir).filter((f) => holds(f, needle));
  expect(leaks, 'files holding the raw bundle key').toEqual([]);
  // With the default backend the key went into the encrypted vault file (the OS keychain is used
  // only with NOVA_SECRETS=keychain).
  if (secrets.backend === 'vault')
    expect(readFileSync(vaultFile).equals(vaultBefore), 'the vault was written').toBe(false);
  const db = new DatabaseSync(join(hub.dataDir, 'nova.db'), { readOnly: true });
  try {
    const row = db
      .prepare("SELECT env_ref_json AS env FROM mcp_server WHERE name = 'nova-hello'")
      .get() as { env: string } | undefined;
    const env = JSON.parse(row?.env ?? '{}') as Record<string, string>;
    expect(env.HELLO_API_KEY).toMatch(/^secret:\/\/mcp\/.+\/env\/HELLO_API_KEY$/);
  } finally {
    db.close();
  }

  // 6. Arrange panes: the chat, an editor with a file from the Files tab and a terminal (from the
  //    command palette). The layout saves; after a Hub restart and a reload it is restored.
  await inspector.getByRole('tab', { name: 'Files' }).click();
  await inspector.getByRole('treeitem', { name: /notes\.txt/ }).click();
  const chatWorkspace = page.getByRole('region', { name: 'Chat workspace' });
  const editor = chatWorkspace.getByRole('region', { name: 'Editor: notes.txt' });
  await expect(editor).toBeVisible();
  await page.getByRole('button', { name: 'Commands' }).click();
  await page.getByRole('combobox', { name: 'Search commands' }).fill('Add terminal pane');
  await page.getByRole('option', { name: /Add terminal pane/ }).click();
  const terminal = chatWorkspace.getByRole('region', { name: 'Terminal', exact: true });
  await expect(terminal).toBeVisible();
  await expect(chatWorkspace.getByRole('region', { name: 'Chat', exact: true })).toBeVisible();
  await expectNoSeriousA11yIssues(page, 'workspace with panes');
  const paneTitles = () => chatWorkspace.locator('.pane-title').allInnerTexts();
  const arranged = await paneTitles();
  expect([...arranged].sort()).toEqual(['Chat', 'Editor: notes.txt', 'Terminal']);
  const savedKinds = async () => {
    const res = await page.request.get(`${hub.url}/api/v1/settings`);
    const { settings } = (await res.json()) as { settings: { key: string; value: unknown }[] };
    const saved = settings.find((s) => s.key === 'workspace.layout')?.value as
      { chat?: unknown } | undefined;
    return [...JSON.stringify(saved?.chat ?? null).matchAll(/"kind":"(\w+)"/g)]
      .map((m) => m[1])
      .sort();
  };
  await expect.poll(savedKinds).toEqual(['editor', 'main', 'terminal']);

  await hub.stop();
  hub = await startHub({ port: portFor(testInfo.parallelIndex), dataDir: hub.dataDir });
  await page.goto(chatUrl);
  await expect(editor).toBeVisible();
  await expect(editor.getByLabel('Contents of notes.txt')).toHaveValue(
    'Quarterly notes: revenue is up.',
  );
  await expect(terminal).toBeVisible();
  await expect(chatWorkspace.getByRole('region', { name: 'Chat', exact: true })).toBeVisible();
  expect(await paneTitles()).toEqual(arranged);
  // The terminal pane is back. Without a sandbox on the Hub, starting a shell in it says so; with
  // one (CI runners), starting a sandboxed shell is left to the terminal tests.
  const terminalPane = terminal.getByRole('region', { name: 'Terminal pane' });
  await expect(terminalPane).toContainText('No terminal is open.');
  if (!(await diagnostics(page, hub.url)).sandbox.available) {
    await terminalPane.getByRole('button', { name: 'Start a terminal' }).click();
    await expect(terminalPane.getByRole('note')).toContainText('this Hub has none');
  }

  // 7. Usage insights (Settings → Profile & usage) show the session's tokens and estimated cost:
  //    the replies of this journey's chat, as the Hub recorded them on each message.
  const threadId = /\/chat\/([^/?#]+)/.exec(chatUrl)?.[1] ?? '';
  const detail = (await (
    await page.request.get(`${hub.url}/api/v1/threads/${threadId}`)
  ).json()) as {
    messages: { usage: { inputTokens: number; outputTokens: number } | null }[];
  };
  const sum = (k: 'inputTokens' | 'outputTokens') =>
    detail.messages.reduce((n, m) => n + (m.usage?.[k] ?? 0), 0);
  const usage = (await (await page.request.get(`${hub.url}/api/v1/usage`)).json()) as {
    totals: { inputTokens: number; outputTokens: number; costUsd: number; turns: number };
  };
  expect(usage.totals.inputTokens).toBeGreaterThan(0);
  expect(usage.totals.outputTokens).toBeGreaterThan(0);
  expect(usage.totals).toMatchObject({
    inputTokens: sum('inputTokens'),
    outputTokens: sum('outputTokens'),
  });
  await page.goto(`${hub.url}/settings/profile`);
  const totals = page.getByRole('region', { name: 'Usage' }).getByLabel('Totals');
  const stat = (name: string) =>
    totals.locator('div', { has: page.getByText(name, { exact: true }) }).locator('dd');
  await expect(stat('Tokens in')).toHaveText(usage.totals.inputTokens.toLocaleString('en-US'));
  await expect(stat('Tokens out')).toHaveText(usage.totals.outputTokens.toLocaleString('en-US'));
  await expect(stat('Estimated cost')).toHaveText('$0.00');
  await expect(stat('Replies')).toHaveText(String(usage.totals.turns));
  await expect(page.getByRole('table', { name: 'By model' })).toContainText('(mock)');
});
