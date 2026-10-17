// Contract harness (T-M0-09): every JSON Schema in contracts/schemas compiles, and the shared Zod
// schemas agree with their JSON Schema on the same samples (contracts/README.md "Contract testing").
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { Contracts } from '@nova/contracts';
import { HTTP_STATUS, HUB_ERROR_CODES } from '../src/errors.ts';
import { eventEnvelopeSchema, makeEvent } from '../src/events.ts';

const root = join(import.meta.dirname, '../../../');
const dir = join(root, 'contracts/schemas');
const files = readdirSync(dir).filter((f) => f.endsWith('.json'));

const c = new Contracts(dir);

describe('contracts/schemas', () => {
  it('has schemas', () => expect(files.length).toBeGreaterThan(5));

  it.each(files)('%s parses and compiles', (f) => {
    const schema = JSON.parse(readFileSync(join(dir, f), 'utf8')) as {
      $schema?: string;
      $id?: string;
    };
    expect(schema.$schema).toBe('https://json-schema.org/draft/2020-12/schema');
    expect(schema.$id).toMatch(/^https:\/\/arialabs\.ai\/schemas\//);
    expect(() => c.validator(f)).not.toThrow();
  });
});

describe('event envelope: Zod and JSON Schema agree', () => {
  const validate = c.validator('event-envelope.json');
  const good = makeEvent({
    name: 'run.step.completed',
    payload: { ok: true },
    actor: 'agent:a1',
    correlation: { runId: 'r1' },
  });
  const samples: [string, unknown, boolean][] = [
    ['valid', good, true],
    ['agent actor', { ...good, actor: 'agent:x' }, true],
    ['bad actor', { ...good, actor: 'robot' }, false],
    ['missing payload', { ...good, payload: undefined }, false],
    ['extra field', { ...good, extra: 1 }, false],
    ['bad correlation key', { ...good, correlation: { nope: 'x' } }, false],
    ['schemaVersion 0', { ...good, schemaVersion: 0 }, false],
  ];
  it.each(samples)('%s', (_name, sample, expected) => {
    const clean = JSON.parse(JSON.stringify(sample)) as unknown;
    const r = validate(clean);
    expect(r.ok, JSON.stringify(r.errors)).toBe(expected);
    expect(eventEnvelopeSchema.safeParse(clean).success).toBe(expected);
  });
});

describe('novad capability document matches device-capability.json', () => {
  const bin = ['release', 'debug']
    .map((p) => join(root, 'services/novad/target', p, 'novad'))
    .find((p) => existsSync(p));
  it.skipIf(!bin)('validates `novad capabilities` output', () => {
    const out = execFileSync(bin!, [
      'capabilities',
      '--device-id',
      'dev-1',
      '--role',
      'compute',
    ]).toString();
    const r = c.validate('device-capability.json', JSON.parse(out));
    expect(r.ok, JSON.stringify(r.errors)).toBe(true);
  });
});

describe('error codes: the code and contracts/hub-api.md agree', () => {
  it('lists every code with the same HTTP status', () => {
    const text = readFileSync(join(root, 'contracts/hub-api.md'), 'utf8');
    const contract = Object.fromEntries(
      [...text.matchAll(/^\| `([a-z_]+)` \| (\d{3}) \|/gm)].map((m) => [m[1], Number(m[2])]),
    );
    expect(Object.keys(contract).sort()).toEqual([...HUB_ERROR_CODES].sort());
    expect(HTTP_STATUS).toEqual(contract);
  });
});
