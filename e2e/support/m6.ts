// Shared steps of the M6 journeys (J7, J8): a Hub set up through onboarding, agents created on
// the mock cloud computer through the Computers page and the New agent page, the mock calendar
// MCP server added in Settings > Tools & MCP, and small Hub API reads for what the UI does not
// show. Every helper drives the UI where the UI offers the action.
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, type APIResponse, type Locator, type Page } from '@playwright/test';
import { startHub, type RunningHub } from './hub.ts';

export const CALENDAR_SERVER = resolve('e2e/support/calendar-mcp-server.mjs');
const SLACK_REDIRECT = resolve('e2e/support/slack-api-redirect.ts');

/** One `/tool` line of the Mock's script. */
export const call = (name: string, args: unknown) => `/tool ${name} ${JSON.stringify(args)}`;

/** A Hub through onboarding; with `slackApi`, its Slack Web API calls go to the mock Slack. */
export async function setUpHub(
  page: Page,
  port: number,
  opts: { slackApi?: string; nodeArgs?: string[] } = {},
): Promise<RunningHub> {
  const nodeArgs = [...(opts.nodeArgs ?? [])];
  if (opts.slackApi) nodeArgs.push('--import', SLACK_REDIRECT);
  const hub = await startHub({
    port,
    nodeArgs,
    ...(opts.slackApi ? { env: { NOVA_E2E_SLACK_API: opts.slackApi } } : {}),
  });
  await page.goto(`${hub.url}/#setup=${hub.setupCode}`);
  await page.getByRole('button', { name: 'Finish setup' }).click();
  await page.getByRole('button', { name: 'Skip setup' }).click();
  return hub;
}

/** JSON from a Hub API call, failing with the body when the status is not 2xx. */
export async function json<T = Record<string, unknown>>(res: APIResponse): Promise<T> {
  const body = await res.text();
  expect(res.ok(), `${res.url()} → ${res.status()} ${body}`).toBe(true);
  return JSON.parse(body) as T;
}

/** Poll until `fn` returns a truthy value (Hub state the UI does not show). */
export async function until<T>(
  what: string,
  fn: () => Promise<T | null | undefined | false>,
  timeoutMs = 30_000,
): Promise<T> {
  let last: T | null | undefined | false = null;
  await expect
    .poll(
      async () => {
        last = await fn();
        return !!last;
      },
      { message: what, timeout: timeoutMs },
    )
    .toBe(true);
  return last as T;
}

/** Computers page: new agents get a cloud computer (the mock cloud runner, FR-080). */
export async function useCloudComputers(page: Page, hub: RunningHub): Promise<void> {
  await page.goto(`${hub.url}/computers`);
  await page
    .getByRole('group', { name: "Where a new agent's computer runs" })
    .getByRole('radio', { name: 'Cloud computer' })
    .check();
  await until(
    'the cloud computer setting is saved',
    async () => (await setting(page, hub, 'computers.agentComputer')) === 'cloud',
  );
}

/** A setting's resolved value. */
export async function setting(page: Page, hub: RunningHub, key: string): Promise<unknown> {
  const { settings } = await json<{ settings: { key: string; value: unknown }[] }>(
    await page.request.get(`${hub.url}/api/v1/settings`),
  );
  return settings.find((s) => s.key === key)?.value;
}

export interface NewAgent {
  name: string;
  responsibility?: string;
  details?: string;
  instructions?: string;
  proactive?: boolean;
}

/** New agent page; returns the agent's id once its page is open. */
export async function createAgent(page: Page, hub: RunningHub, a: NewAgent): Promise<string> {
  await page.goto(`${hub.url}/agents`);
  await page.getByRole('button', { name: 'New agent' }).first().click();
  const form = page.getByRole('form', { name: 'New agent' });
  await form.getByLabel('Name', { exact: true }).fill(a.name);
  if (a.instructions) await form.getByLabel('Instructions', { exact: true }).fill(a.instructions);
  if (a.responsibility)
    await form.getByLabel('Responsibility 1', { exact: true }).fill(a.responsibility);
  if (a.details) await form.getByLabel('Details for responsibility 1 (optional)').fill(a.details);
  const proactive = form.getByRole('switch', { name: 'Proactive research' });
  if (a.proactive === false) {
    if ((await proactive.getAttribute('aria-checked')) === 'true') await proactive.click();
    await expect(proactive).toHaveAttribute('aria-checked', 'false');
  }
  await form.getByRole('button', { name: 'Create agent' }).click();
  await expect(page).toHaveURL(/\/agents\/[^/?#]+$/);
  await expect(page.getByRole('heading', { level: 1, name: a.name })).toBeVisible();
  return /\/agents\/([^/?#]+)$/.exec(page.url())![1]!;
}

export interface AgentJson {
  id: string;
  name: string;
  status: string;
  primaryThreadId: string;
  computerId: string | null;
  responsibilities: { id: string; title: string }[];
}

export const getAgent = async (page: Page, hub: RunningHub, id: string) =>
  json<AgentJson>(await page.request.get(`${hub.url}/api/v1/agents/${id}`));

/** The agent's computer, once the Hub made it (asynchronously after creation). */
export async function agentComputer(page: Page, hub: RunningHub, agentId: string) {
  return until(`the computer of agent ${agentId}`, async () => {
    const { items } = await json<{
      items: { id: string; agentId: string | null; kind: string }[];
    }>(await page.request.get(`${hub.url}/api/v1/computers`));
    return items.find((c) => c.agentId === agentId) ?? null;
  });
}

/** Open one of the agent page's sections; returns its panel. */
export async function openAgentTab(page: Page, label: string | RegExp) {
  const tab = page.getByRole('tablist', { name: 'Agent sections' }).getByRole('tab', {
    name: label,
  });
  await tab.click();
  await expect(tab).toHaveAttribute('aria-selected', 'true');
  return page.getByRole('tabpanel', { name: label });
}

/** A toast (the announcer repeats it for screen readers). */
export const toast = (page: Page, text: string | RegExp) =>
  page.getByRole('region', { name: 'Notifications' }).getByText(text);

/** The agent's page (its conversation and sections). */
export const agentRegion = (page: Page, name: string) =>
  page.getByRole('region', { name: `Agent: ${name}` });

/** Send a message in a conversation (the agent's main thread). */
export async function send(scope: Locator, text: string) {
  const box = scope.getByRole('textbox', { name: 'Message', exact: true });
  await box.fill(text);
  await box.press('Enter');
}

export const messages = (scope: Locator) => scope.getByRole('log', { name: 'Messages' });

/** Decide the pending approval card for `tool` in the conversation. */
export async function decide(scope: Locator, tool: string, decision: string) {
  const card = messages(scope)
    .getByRole('group', { name: /Approval needed/ })
    .filter({ hasText: tool });
  await expect(card).toBeVisible();
  await card
    .getByRole('group', { name: 'Decision' })
    .getByRole('button', { name: decision, exact: true })
    .click();
  await expect(card).toHaveCount(0);
}

/**
 * Allow, one by one, the approvals a turn asks for, in order: each card is found by the pending
 * approval of `tool` (several calls of one tool ask one after another) and answered in the UI.
 */
export async function allowInTurn(page: Page, hub: RunningHub, scope: Locator, tools: string[]) {
  for (const tool of tools) {
    const pending = await until(`an approval for ${tool}`, async () => {
      const { items } = await json<{ items: { id: string; tool: string | null }[] }>(
        await page.request.get(`${hub.url}/api/v1/approvals?status=pending`),
      );
      return items.find((a) => a.tool === tool) ?? null;
    });
    const card = scope.locator(`[id="approval-${pending.id}"]`);
    await card
      .getByRole('group', { name: 'Decision' })
      .getByRole('button', { name: 'Allow once', exact: true })
      .click();
    await expect(card).toHaveCount(0);
  }
}

// ---- the mock calendar MCP server -----------------------------------------------------------

export interface Calendar {
  /** Where the server writes its control port. */
  controlFile: string;
  state(): Promise<CalendarState>;
  emit(body: Record<string, unknown>): Promise<CalendarDelivery[]>;
}

export interface CalendarState {
  calls: { tool: string; args: Record<string, unknown> }[];
  events: { id: string; title: string }[];
  subscriptions: { id: string; event: string; url: string }[];
}

export interface CalendarDelivery {
  subscriptionId: string;
  deliveryId: string;
  status: number;
  body: string;
}

export function calendarControl(): Calendar {
  const controlFile = join(mkdtempSync(join(tmpdir(), 'nova-e2e-cal-')), 'control.json');
  const base = () => {
    if (!existsSync(controlFile)) throw new Error('the calendar server has not started');
    const { port } = JSON.parse(readFileSync(controlFile, 'utf8')) as { port: number };
    return `http://127.0.0.1:${port}`;
  };
  return {
    controlFile,
    state: async () => (await (await fetch(`${base()}/state`)).json()) as CalendarState,
    emit: async (body) =>
      (await (
        await fetch(`${base()}/emit`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        })
      ).json()) as CalendarDelivery[],
  };
}

/**
 * Settings > Tools & MCP: add the calendar as a command server (no default approval set) and
 * mark `list_events` "Reads only", the owner's declaration that lets research read it (FR-082).
 */
export async function addCalendarServer(page: Page, hub: RunningHub, cal: Calendar) {
  await page.goto(`${hub.url}/settings/tools`);
  await page.getByRole('button', { name: 'Add server' }).first().click();
  const form = page.getByRole('dialog', { name: 'Add an MCP server' });
  await form.getByLabel('Name', { exact: true }).fill('calendar');
  await form.getByRole('radio', { name: 'Run a command on the Hub' }).check();
  await form.getByLabel('Command', { exact: true }).fill(process.execPath);
  await form.getByLabel('Arguments').fill(`${CALENDAR_SERVER}\n--control\n${cal.controlFile}`);
  await form.getByRole('button', { name: 'Add server' }).click();
  const row = page.getByRole('list', { name: 'MCP servers' }).getByRole('listitem', {
    name: 'calendar',
  });
  await expect(row).toContainText('Connected', { timeout: 20_000 });
  await expect(row).toContainText('3 tools');
  await row.getByRole('button', { name: 'Tools', exact: true }).click();
  const tools = page.getByRole('region', { name: 'Tools from calendar' });
  const listEvents = tools.getByRole('listitem', { name: 'mcp:calendar.list_events' });
  // A controlled checkbox: it shows the Hub's answer once the server is saved.
  await listEvents.getByRole('checkbox', { name: 'Reads only' }).click();
  await expect(listEvents.getByRole('checkbox', { name: 'Reads only' })).toBeChecked();
  for (const other of ['create_event', 'send_invite'])
    await expect(
      tools
        .getByRole('listitem', { name: `mcp:calendar.${other}` })
        .getByRole('checkbox', { name: 'Reads only' }),
    ).not.toBeChecked();
  await until('the calendar server is connected with its control port', () =>
    Promise.resolve(existsSync(cal.controlFile)),
  );
}

/** Audit entries (newest first) of one kind. */
export async function audit(page: Page, hub: RunningHub, kind?: string) {
  const q = kind ? `?kind=${kind}&limit=200` : '?limit=200';
  const { items } = await json<{
    items: {
      actor: string;
      kind: string;
      action: string;
      resource: string | null;
      decision: string | null;
      result: string | null;
    }[];
  }>(await page.request.get(`${hub.url}/api/v1/audit${q}`));
  return items;
}
