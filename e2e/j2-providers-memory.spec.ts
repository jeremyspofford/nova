// J2 — Providers & memory (docs/18 §3, M2 exit criteria in docs/17): two providers in one
// thread with context kept, the Faster ↔ Smarter presets and their Advanced editor, and memory
// that is extracted, editable and kept out of temporary chats.
import { expect, test, type Page } from '@playwright/test';
import { expectNoSeriousA11yIssues } from './support/a11y.ts';
import { startFakeAnthropic, startFakeOllama, type FakeServer } from './support/fake-providers.ts';
import { startHub, type RunningHub } from './support/hub.ts';

const portFor = (parallelIndex: number) => 7531 + parallelIndex;
let hub: RunningHub;
let anthropic: FakeServer;
let ollama: FakeServer;

test.use({ colorScheme: 'light' });
test.describe.configure({ mode: 'serial' });

test.afterEach(async () => {
  await hub?.stop();
  await anthropic?.stop();
  await ollama?.stop();
});

async function addProvider(
  page: Page,
  kind: 'Anthropic' | 'Ollama',
  fields: { name: string; baseUrl: string; apiKey?: string },
) {
  await page.getByRole('button', { name: 'Add a provider' }).click();
  await page.getByRole('radio', { name: kind }).check();
  await page.getByLabel('Name', { exact: true }).fill(fields.name);
  if (fields.apiKey) await page.getByLabel('API key').fill(fields.apiKey);
  const advanced = page.locator('summary', { hasText: 'Advanced' });
  if (await advanced.isVisible()) await advanced.click();
  await page.getByLabel('Base URL').fill(fields.baseUrl);
  await page.getByRole('button', { name: 'Save and test' }).click();
  await expect(page.getByText(`${fields.name} connected`)).toBeVisible();
}

async function newChat(page: Page) {
  await page
    .getByRole('button', { name: /New chat/ })
    .first()
    .click();
}

async function send(page: Page, text: string) {
  const composer = page.getByRole('textbox', { name: 'Message', exact: true });
  await composer.fill(text);
  await composer.press('Enter');
}

/** The newest assistant reply's text, once it has finished streaming. */
async function lastReply(page: Page, contains: string | RegExp) {
  const messages = page.getByLabel('Messages', { exact: true });
  await expect(messages).toContainText(contains);
  return messages;
}

const threadIdFrom = (url: string) => /\/chat\/([^/?#]+)/.exec(url)?.[1] ?? '';

test('J2: two providers, presets, memory', async ({ page }, testInfo) => {
  anthropic = await startFakeAnthropic('claude-test-1');
  ollama = await startFakeOllama('local-test:1b');
  hub = await startHub({ port: portFor(testInfo.parallelIndex) });
  expect(hub.setupCode).toBeTruthy();

  await page.goto(`${hub.url}/#setup=${hub.setupCode}`);
  await page.getByRole('button', { name: 'Finish setup' }).click();
  await page.getByRole('button', { name: 'Skip setup' }).click();

  // 1. Connect an Anthropic account and a local Ollama server (both are local fakes).
  await page.goto(`${hub.url}/settings/accounts`);
  await addProvider(page, 'Anthropic', {
    name: 'Claude test',
    apiKey: 'sk-ant-test-0123456789',
    baseUrl: anthropic.url,
  });
  await addProvider(page, 'Ollama', { name: 'Local test', baseUrl: ollama.url });
  // The key is write-only: the account lists that a key is stored, never the key.
  await expect(page.getByText('key stored')).toBeVisible();
  await expect(page.getByText('sk-ant-test-0123456789')).toHaveCount(0);

  // 2. Chat on Anthropic, switch to the local model mid-thread: the context carries over.
  await page.goto(`${hub.url}/chat`);
  await newChat(page);
  const model = page.getByRole('combobox', { name: 'Model' });
  await model.selectOption({ label: 'Test Claude' });
  await send(page, 'My first question is about tides.');
  await lastReply(page, '[claude-test-1] Seen 1 user messages.');
  await model.selectOption({ label: 'local-test:1b' });
  await send(page, 'And what about the moon?');
  await lastReply(
    page,
    '[local-test:1b] Seen 2 user messages. First: "My first question is about tides."',
  );
  await expectNoSeriousA11yIssues(page, 'chat with two providers');

  // 3. Move the preset control to Smarter: the thread records the preset, the reply the model
  //    that answered. Advanced opens the editor, which shows and saves the preset's choices.
  const presets = page.getByRole('group', { name: 'Model preset' });
  await presets.getByRole('radio', { name: 'Smarter' }).check();
  await send(page, 'Which model answers now?');
  await lastReply(page, 'Seen 3 user messages.');
  const threadId = threadIdFrom(page.url());
  const detail = (await (
    await page.request.get(`${hub.url}/api/v1/threads/${threadId}`)
  ).json()) as {
    thread: { model: string };
    messages: { role: string; model: string | null }[];
  };
  expect(detail.thread.model).toBe('preset:smarter');
  const answered = detail.messages.filter((m) => m.role === 'assistant').at(-1)!.model;
  expect(answered).toBeTruthy();
  expect(answered).not.toMatch(/^preset:/);

  await page.getByRole('link', { name: 'Advanced…' }).click();
  await expect(page).toHaveURL(/\/settings\/models$/);
  await expect(page.getByText('Built-in', { exact: true })).toBeVisible();
  const smarter = page.getByRole('group', { name: 'Smarter' });
  await smarter.getByLabel('Reasoning level').selectOption({ label: 'High' });
  await page.getByRole('button', { name: 'Save presets' }).click();
  await expect(page.getByText('Built-in', { exact: true })).toHaveCount(0);
  const saved = (await (await page.request.get(`${hub.url}/api/v1/presets`)).json()) as {
    builtIn: boolean;
    items: { id: string; reasoningLevel?: string }[];
  };
  expect(saved.builtIn).toBe(false);
  expect(saved.items.find((p) => p.id === 'smarter')?.reasoningLevel).toBe('high');
  await expectNoSeriousA11yIssues(page, 'settings/models');

  // 4. State a preference → it appears in Memory → correct it → a temporary chat does not see
  //    it, a normal chat does.
  await page.goto(`${hub.url}/chat`);
  await newChat(page);
  await model.selectOption({ label: 'local-test:1b' });
  await send(page, 'I prefer window seats.');
  await lastReply(page, 'Seen 1 user messages.');

  // Extraction runs once the turn is saved; wait on the API, then open the page once (reloading
  // in a loop would abort the page's own requests).
  await expect
    .poll(
      async () => {
        const res = await page.request.get(`${hub.url}/api/v1/memory/items`);
        const body = (await res.json()) as { items: { content: string }[] };
        return body.items.map((m) => m.content);
      },
      { timeout: 15_000 },
    )
    .toContain('The user prefers window seats.');
  await page.goto(`${hub.url}/settings/memory`);
  await expect(page.getByText('The user prefers window seats.')).toBeVisible();
  await page
    .getByRole('listitem', { name: /The user prefers window seats/ })
    .getByRole('button', { name: 'Correct' })
    .click();
  const edit = page.getByRole('form', { name: 'Correct this memory' });
  await edit.getByLabel('Memory').fill('The user prefers aisle seats.');
  await edit.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('The user prefers aisle seats.')).toBeVisible();
  await expect(page.getByText('The user prefers window seats.')).toHaveCount(0);
  await expectNoSeriousA11yIssues(page, 'settings/memory');

  await page.goto(`${hub.url}/chat`);
  await page
    .getByRole('navigation', { name: 'Sidebar' })
    .getByRole('button', { name: 'New temporary chat' })
    .click();
  await expect(page.getByRole('heading', { name: 'New temporary chat' })).toBeVisible();
  await model.selectOption({ label: 'local-test:1b' });
  await send(page, 'Do you know anything about me?');
  await lastReply(page, 'Memory: none.');

  await newChat(page);
  await model.selectOption({ label: 'local-test:1b' });
  await send(page, 'Where should I sit?');
  await lastReply(page, 'Memory: yes.');
  // What the model was given says aisle, not window: the correction is what is used. (Later
  // requests may be the background memory extractor, so pick the chat request.)
  const chatRequest = ollama.requests
    .map((r) => JSON.stringify(r))
    .filter((r) => r.includes('Where should I sit?') && /know about the user/i.test(r))
    .at(-1);
  expect(chatRequest).toContain('aisle seats');
  expect(chatRequest).not.toContain('window seats');

  // 5. Follow-ups, versions and branches (FR-019, FR-020, FR-025): a message sent while a reply
  //    streams is queued and runs next; editing adds a version and keeps the old one; branching
  //    starts a new chat that carries the path; search finds the edited text.
  await newChat(page);
  await model.selectOption({ label: 'local-test:1b' });
  await send(page, '[slow] Tell me a long story.');
  await expect(page.getByRole('button', { name: 'Queue' })).toBeVisible();
  await send(page, 'Then a short one.');
  await expect(page.getByRole('region', { name: 'Queued messages' })).toContainText('Queued: 1');
  await lastReply(page, 'Seen 2 user messages. First: "[slow] Tell me a long story."');
  await expect(page.getByRole('region', { name: 'Queued messages' })).toHaveCount(0);

  const messages = page.getByLabel('Messages', { exact: true });
  const first = messages.getByRole('article', { name: 'You' }).first();
  await first.hover();
  await first.getByRole('button', { name: 'Edit' }).click();
  const editor = page.getByRole('form', { name: 'Edit message' });
  await editor.getByLabel('Edited message').fill('Tell me a poem instead.');
  await editor.getByRole('button', { name: 'Save' }).click();
  await lastReply(page, 'Seen 1 user messages. First: "Tell me a poem instead."');
  const versions = messages.getByRole('group', { name: 'Versions' });
  await expect(versions).toContainText('Version 2 of 2');
  await versions.getByRole('button', { name: 'Previous version' }).click();
  await expect(messages).toContainText('[slow] Tell me a long story.');
  await expect(versions).toContainText('Version 1 of 2');
  await versions.getByRole('button', { name: 'Next version' }).click();
  await expect(messages).toContainText('Tell me a poem instead.');

  const sourceUrl = page.url();
  const reply = messages.getByRole('article').last();
  await reply.hover();
  await reply.getByRole('button', { name: 'Branch from here' }).click();
  await expect.poll(() => page.url()).not.toBe(sourceUrl);
  await expect(messages).toContainText('Tell me a poem instead.');
  await send(page, 'Continue in the branch.');
  await lastReply(page, 'Seen 2 user messages. First: "Tell me a poem instead."');

  await page
    .getByRole('button', { name: /Search/ })
    .first()
    .click();
  await page.getByPlaceholder('Search chats').fill('poem');
  await expect(page.getByLabel('Search results')).toContainText('poem');
  await expectNoSeriousA11yIssues(page, 'chat with versions');
});
