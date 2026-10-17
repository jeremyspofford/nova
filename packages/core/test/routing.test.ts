import { afterEach, describe, expect, it } from 'vitest';
import { DirectRouter, locationLabel } from '../src/index.ts';
import { ACCOUNT, makeEnv, type Env } from './helpers.ts';

let env: Env | undefined;
afterEach(async () => {
  await env?.close();
  env = undefined;
});

describe('DirectRouter', () => {
  it('routes an account model to one Hub target and streams with a route marker first', async () => {
    env = await makeEnv();
    const router = new DirectRouter(env.registry);
    const ref = `${env.mockAccountId}/mock-fast`;
    expect(await router.usable(ACCOUNT, ref)).toBe(true);
    const route = await router.route(ACCOUNT, ref);
    expect(route.targets).toHaveLength(1);
    const target = route.targets[0]!;
    expect(target).toMatchObject({ modelId: 'mock-fast', providerKind: 'mock', local: true });
    expect(locationLabel(target.location)).toBe('hub');

    const types: string[] = [];
    for await (const e of router.stream(
      route,
      {
        messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
        signal: new AbortController().signal,
      },
      { requestId: 'r1' },
    ))
      types.push(e.type);
    expect(types[0]).toBe('route');
    expect(types.at(-1)).toBe('stop');
  });

  it('rejects preset and node refs and refs to removed accounts', async () => {
    env = await makeEnv();
    const router = new DirectRouter(env.registry);
    expect(await router.usable(ACCOUNT, 'preset:fast')).toBe(false);
    expect(await router.usable(ACCOUNT, 'node:n1/llama')).toBe(false);
    expect(await router.usable(ACCOUNT, 'gone/model')).toBe(false);
    await expect(router.route(ACCOUNT, 'preset:fast')).rejects.toMatchObject({
      code: 'validation',
    });
  });

  it('labels node locations', () => {
    expect(locationLabel({ kind: 'node', nodeId: 'n1' })).toBe('node:n1');
  });
});
