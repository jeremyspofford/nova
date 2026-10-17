// Preset and local-server routes on a bare Fastify instance with stub dependencies (FR-221,
// docs/07 §12): built-in vs saved presets, validation of malformed targets, reset, detection
// and authentication.
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  NovaError,
  httpStatusFor,
  isNovaError,
  type DetectedServer,
  type Preset,
} from '@nova/shared';
import { checkPresets, registerModelRoutes } from '../src/model-routes.ts';

const BUILT_IN: Preset[] = [
  { id: 'faster', label: 'Faster', strategy: 'single', targets: ['pa1/mock-fast'], rank: 1 },
  { id: 'balanced', label: 'Balanced', strategy: 'single', targets: ['pa1/mock-fast'], rank: 2 },
  {
    id: 'smarter',
    label: 'Smarter',
    strategy: 'single',
    targets: ['pa1/mock-smart'],
    reasoningLevel: 'high',
    rank: 3,
  },
];

let app: FastifyInstance;
let stored: Map<string, Preset[]>;
let detected: DetectedServer[];
let detectCalls: number;

beforeEach(async () => {
  stored = new Map();
  detected = [{ kind: 'ollama', baseUrl: 'http://127.0.0.1:11434/v1', models: ['qwen3:8b'] }];
  detectCalls = 0;
  app = Fastify();
  // The Hub's error mapping (app.ts), reduced to what these routes raise.
  app.setErrorHandler((err, req, reply) => {
    if (isNovaError(err))
      return reply.status(httpStatusFor(err.code)).send({ error: err.toJSON(), requestId: req.id });
    if (err instanceof z.ZodError)
      return reply
        .status(400)
        .send({ error: { code: 'validation', message: 'request failed validation' } });
    return reply.status(500).send({ error: { code: 'server_error' } });
  });
  registerModelRoutes(app, {
    router: { builtInPresets: (accountId) => Promise.resolve(accountId === 'acc' ? BUILT_IN : []) },
    readPresets: (accountId) => Promise.resolve(stored.get(accountId) ?? []),
    writePresets: (accountId, items) => {
      stored.set(accountId, items);
      return Promise.resolve();
    },
    detect: () => {
      detectCalls++;
      return Promise.resolve(detected);
    },
    accountOf: (req) => {
      if (req.headers.authorization !== 'Bearer ok')
        return Promise.reject(new NovaError('token_required', 'sign in'));
      return Promise.resolve('acc');
    },
  });
  await app.ready();
});

afterEach(() => app.close());

const call = (method: 'GET' | 'PUT', url: string, payload?: unknown, auth = true) =>
  app.inject({
    method,
    url,
    headers: auth ? { authorization: 'Bearer ok' } : {},
    ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
  });

describe('presets routes', () => {
  it('returns the generated built-ins until presets are saved', async () => {
    const res = await call('GET', '/api/v1/presets');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ items: BUILT_IN, builtIn: true });
  });

  it('saves a custom list, accepting unknown but well-formed targets, and resets with []', async () => {
    const custom: Preset[] = [
      {
        id: 'local-first',
        label: 'Local first',
        strategy: 'fallback',
        targets: ['pa2/qwen3:8b', 'node:n1/qwen3:8b', 'missing-account/model'],
        reasoningLevel: 'medium',
        speed: 'standard',
        rank: 10,
      },
    ];
    const put = await call('PUT', '/api/v1/presets', { items: custom });
    expect(put.statusCode).toBe(200);
    expect(put.json()).toEqual({ items: custom, builtIn: false });
    expect((await call('GET', '/api/v1/presets')).json()).toEqual({
      items: custom,
      builtIn: false,
    });
    const reset = await call('PUT', '/api/v1/presets', { items: [] });
    expect(reset.json()).toEqual({ items: BUILT_IN, builtIn: true });
    expect(stored.get('acc')).toEqual([]);
  });

  it('rejects malformed targets, nested presets, duplicate ids and bad shapes with 400', async () => {
    const base = { label: 'X', strategy: 'single', rank: 1 };
    const bad = [
      { items: [{ ...base, id: 'a', targets: ['no-slash'] }] },
      { items: [{ ...base, id: 'a', targets: ['preset:faster'] }] },
      { items: [{ ...base, id: 'a', targets: ['node:/x'] }] },
      {
        items: [
          { ...base, id: 'a', targets: ['p/m'] },
          { ...base, id: 'a', targets: ['p/m'] },
        ],
      },
      { items: [{ ...base, id: 'Bad Id', targets: ['p/m'] }] },
      { items: [{ ...base, id: 'a', targets: [] }] },
      { items: [{ ...base, id: 'a', targets: ['p/m'], strategy: 'parallel' }] },
      { items: 'nope' },
      { items: [], extra: true },
    ];
    for (const body of bad) {
      const res = await call('PUT', '/api/v1/presets', body);
      expect(res.statusCode, JSON.stringify(body)).toBe(400);
      expect(res.json().error.code).toBe('validation');
    }
    const res = await call('PUT', '/api/v1/presets', bad[0]);
    expect(res.json().error.details).toEqual({
      reason: 'invalid_target',
      preset: 'a',
      target: 'no-slash',
    });
    expect(stored.size).toBe(0);
  });

  it('checks presets directly', () => {
    expect(() => checkPresets(BUILT_IN)).not.toThrow();
    expect(() => checkPresets([{ ...BUILT_IN[0]!, targets: ['preset:smarter'] }])).toThrow(
      /malformed/,
    );
  });
});

describe('local server detection route', () => {
  it('lists detected servers', async () => {
    const res = await call('GET', '/api/v1/providers/detect');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ items: detected });
    expect(detectCalls).toBe(1);
  });
});

describe('authentication', () => {
  it('requires a session on every route', async () => {
    for (const [method, url, body] of [
      ['GET', '/api/v1/presets', undefined],
      ['PUT', '/api/v1/presets', { items: [] }],
      ['GET', '/api/v1/providers/detect', undefined],
    ] as const) {
      const res = await call(method, url, body, false);
      expect(res.statusCode).toBe(401);
      expect(res.json().error.code).toBe('token_required');
    }
    expect(detectCalls).toBe(0);
    expect(stored.size).toBe(0);
  });
});
