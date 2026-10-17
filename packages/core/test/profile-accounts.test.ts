// Several accounts per provider with one active account per kind (FR-115): the first account
// of a kind is active, switching moves it, removing the active one activates the next, and new
// chats and the built-in presets use the active account for the models it shares.
import { afterEach, describe, expect, it } from 'vitest';
import { ROUTING_STEPS } from '@nova/shared';
import { MockProvider, type ModelInfo } from '@nova/providers';
import { Router } from '../src/index.ts';
import { ACCOUNT, makeEnv, type Env } from './helpers.ts';

const SHARED: ModelInfo[] = [
  { id: 'gpt-small-mini', label: 'small', capabilities: { reasoning: false } },
  { id: 'gpt-5-large', label: 'large', capabilities: { reasoning: false } },
];

let env: Env;
afterEach(() => env.close());

/** Accounts by label; `work` also offers a model nobody else has. */
async function setup() {
  env = await makeEnv({
    factory: ({ row }) => {
      if (row.provider !== 'openai') return undefined;
      const workOnly: ModelInfo = {
        id: 'gpt-work-only',
        label: 'w',
        capabilities: { reasoning: false },
      };
      const models = row.label === 'work' ? [...SHARED, workOnly] : SHARED;
      return new MockProvider({ id: row.id, models });
    },
  });
  const create = (label: string) =>
    env.registry.create(ACCOUNT, { provider: 'openai', label, apiKey: 'sk-test-fake-0123456789' });
  const personal = await create('personal');
  const work = await create('work');
  return { personal, work };
}

const active = async () =>
  (await env.registry.list(ACCOUNT)).filter((a) => a.active).map((a) => a.label);

describe('active provider accounts (FR-115)', () => {
  it('makes the first account of each kind active', async () => {
    const { personal, work } = await setup();
    expect(personal.active).toBe(true);
    expect(work.active).toBe(false);
    expect(await active()).toEqual(['Mock (offline)', 'personal']);
    expect((await env.registry.view(ACCOUNT, work.id)).active).toBe(false);
  });

  it('switches the active account and lists it first among its kind', async () => {
    const { work } = await setup();
    const v = await env.registry.setActive(ACCOUNT, work.id);
    expect(v).toMatchObject({ id: work.id, active: true });
    expect(await active()).toEqual(['Mock (offline)', 'work']);
    expect((await env.registry.list(ACCOUNT)).map((a) => a.label)).toEqual([
      'Mock (offline)',
      'work',
      'personal',
    ]);
    // Switching again is idempotent.
    await env.registry.setActive(ACCOUNT, work.id);
    expect(await active()).toEqual(['Mock (offline)', 'work']);
  });

  it('serves shared models from the active account only and keeps the rest listed', async () => {
    const { personal, work } = await setup();
    const refs = async () => (await env.registry.listModels(ACCOUNT)).map((m) => m.ref);
    expect(await refs()).toEqual([
      `${env.mockAccountId}/mock-fast`,
      `${env.mockAccountId}/mock-smart`,
      `${personal.id}/gpt-small-mini`,
      `${personal.id}/gpt-5-large`,
      `${work.id}/gpt-work-only`,
    ]);
    await env.registry.setActive(ACCOUNT, work.id);
    expect(await refs()).toEqual([
      `${env.mockAccountId}/mock-fast`,
      `${env.mockAccountId}/mock-smart`,
      `${work.id}/gpt-small-mini`,
      `${work.id}/gpt-5-large`,
      `${work.id}/gpt-work-only`,
    ]);
    // A thread that names the inactive account's model still resolves it.
    expect((await env.registry.resolve(ACCOUNT, `${personal.id}/gpt-5-large`)).account.id).toBe(
      personal.id,
    );
  });

  it('builds the built-in presets and the new-chat default from active accounts', async () => {
    const { personal, work } = await setup();
    await env.registry.remove(ACCOUNT, env.mockAccountId);
    const router = new Router({
      registry: env.registry,
      settings: () => Promise.resolve({ presets: [], order: [...ROUTING_STEPS], allowCloud: true }),
    });
    const targets = async () => (await router.builtInPresets(ACCOUNT)).flatMap((p) => p.targets);
    expect((await targets()).every((t) => !t.startsWith(`${work.id}/gpt-small`))).toBe(true);
    expect(await router.firstModel(ACCOUNT)).toBe(`${personal.id}/gpt-small-mini`);
    await env.registry.setActive(ACCOUNT, work.id);
    const after = await targets();
    expect(after.some((t) => t.startsWith(`${work.id}/`))).toBe(true);
    expect(after.some((t) => t.startsWith(`${personal.id}/`))).toBe(false);
    expect(await router.firstModel(ACCOUNT)).toBe(`${work.id}/gpt-small-mini`);
  });

  it('activates the next account of the kind when the active one is removed', async () => {
    const { personal, work } = await setup();
    const third = await env.registry.create(ACCOUNT, {
      provider: 'openai',
      label: 'third',
      apiKey: 'sk-test-fake-0123456789',
    });
    await env.registry.setActive(ACCOUNT, work.id);
    await env.registry.remove(ACCOUNT, work.id);
    expect(await active()).toEqual(['Mock (offline)', 'third']);
    // Removing the last one of the creation order wraps to the first.
    await env.registry.remove(ACCOUNT, third.id);
    expect(await active()).toEqual(['Mock (offline)', 'personal']);
    // Removing an inactive account changes nothing; removing the only one leaves the kind empty.
    await env.registry.remove(ACCOUNT, personal.id);
    expect(await active()).toEqual(['Mock (offline)']);
    const rows = env.db.raw
      .prepare("SELECT * FROM provider_active WHERE provider = 'openai'")
      .all();
    expect(rows).toEqual([]);
  });

  it('refuses to activate an unknown or removed account', async () => {
    const { work } = await setup();
    await expect(env.registry.setActive(ACCOUNT, 'missing')).rejects.toMatchObject({
      code: 'not_found',
    });
    await env.registry.remove(ACCOUNT, work.id);
    await expect(env.registry.setActive(ACCOUNT, work.id)).rejects.toMatchObject({
      code: 'not_found',
    });
  });

  it('falls back to the oldest account when the chosen one is gone', async () => {
    const { work } = await setup();
    await env.registry.setActive(ACCOUNT, work.id);
    // Removed outside the registry: the stored choice points at a deleted row.
    env.db.raw
      .prepare('UPDATE provider_account SET deleted_at = ? WHERE id = ?')
      .run(new Date().toISOString(), work.id);
    expect(await active()).toEqual(['Mock (offline)', 'personal']);
  });
});
