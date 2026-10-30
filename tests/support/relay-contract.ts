// Relay's HTTP contract v1, for checking the stand-in (scripts/stand-ins/fake-relay.js) against it.
// relay-contract-v1.json beside this file is a byte-for-byte copy of contract/v1.json from Relay
// v0.9.0 (jeremyspofford/relay, commit 4add265); the opt-in real test compares it with a Relay
// checkout. `validate` is a port of Relay's own test/contract-schema.mjs (same subset, same reading):
// $ref (#/definitions/…), anyOf, type (string or list; integer included), enum, const, pattern,
// minLength, maxLength, minimum, properties, required, additionalProperties (false or a schema),
// items. It returns a list of problems; empty means valid.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export type Schema = Record<string, unknown>;
export interface Contract { api: number; routes: Record<string, { request?: Schema; responses: Record<string, Schema> }>; commonErrors: Record<string, Schema>; definitions: Record<string, Schema> }

export const CONTRACT_FILE = join(import.meta.dirname, 'relay-contract-v1.json');
export const CONTRACT: Contract = JSON.parse(readFileSync(CONTRACT_FILE, 'utf8'));

const kind = (v: unknown) => (v === null ? 'null' : Array.isArray(v) ? 'array' : Number.isInteger(v) ? 'integer' : typeof v);

export function validate(contract: Contract, schema: Schema, value: unknown, at = '$'): string[] {
  if (typeof schema.$ref === 'string') {
    const def = contract.definitions[schema.$ref.replace('#/definitions/', '')];
    if (!def) throw new Error(`Unknown $ref ${schema.$ref}`);
    return validate(contract, def, value, at);
  }
  if (Array.isArray(schema.anyOf)) {
    const attempts = (schema.anyOf as Schema[]).map((option) => validate(contract, option, value, at));
    return attempts.some((found) => !found.length) ? [] : attempts.flat();
  }
  const problems: string[] = [];
  const types = [schema.type ?? []].flat() as string[];
  const actual = kind(value);
  if (types.length && !types.includes(actual) && !(actual === 'integer' && types.includes('number'))) return [`${at}: expected ${types.join(' or ')}, got ${actual}`];
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) problems.push(`${at}: ${JSON.stringify(value)} is not one of ${schema.enum.join(', ')}`);
  if (Object.hasOwn(schema, 'const') && value !== schema.const) problems.push(`${at}: expected ${JSON.stringify(schema.const)}`);
  if (typeof value === 'string') {
    if (typeof schema.pattern === 'string' && !new RegExp(schema.pattern).test(value)) problems.push(`${at}: does not match ${schema.pattern}`);
    if (value.length < ((schema.minLength as number) ?? 0) || value.length > ((schema.maxLength as number) ?? Infinity)) problems.push(`${at}: length ${value.length} is out of range`);
  }
  if (typeof value === 'number' && value < ((schema.minimum as number) ?? -Infinity)) problems.push(`${at}: below ${schema.minimum}`);
  if (actual === 'array' && schema.items) (value as unknown[]).forEach((item, i) => problems.push(...validate(contract, schema.items as Schema, item, `${at}[${i}]`)));
  if (actual === 'object') {
    const obj = value as Record<string, unknown>;
    for (const key of (schema.required as string[]) ?? []) if (!Object.hasOwn(obj, key)) problems.push(`${at}.${key}: required`);
    const props = schema.properties as Record<string, Schema> | undefined;
    for (const [key, item] of Object.entries(obj)) {
      if (props && Object.hasOwn(props, key)) problems.push(...validate(contract, props[key]!, item, `${at}.${key}`));
      else if (schema.additionalProperties === false) problems.push(`${at}.${key}: not in the contract`);
      else if (typeof schema.additionalProperties === 'object' && schema.additionalProperties) problems.push(...validate(contract, schema.additionalProperties as Schema, item, `${at}.${key}`));
    }
  }
  return problems;
}

// The schema for a route's response with this status: the route's own, else the common errors.
export function responseSchema(route: string, status: number): Schema | null {
  const r = CONTRACT.routes[route];
  if (!r) throw new Error(`No route ${route} in the contract.`);
  return r.responses[String(status)] ?? CONTRACT.commonErrors[String(status)] ?? null;
}

// Problems with one response against the contract (an undeclared status is one).
export function checkResponse(route: string, status: number, body: unknown): string[] {
  const s = responseSchema(route, status);
  if (!s) return [`${route}: ${status} isn't a status the contract declares`];
  return validate(CONTRACT, s, body).map((p) => `${route} ${status}: ${p}`);
}

export function checkRequest(route: string, body: unknown): string[] {
  const s = CONTRACT.routes[route]?.request;
  return s ? validate(CONTRACT, s, body).map((p) => `${route} request: ${p}`) : [];
}
