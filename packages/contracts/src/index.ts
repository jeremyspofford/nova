// Validators for contracts/schemas (AGENTS.md §10: contracts are the source of truth). The Hub
// uses these to reject invalid payloads at its boundaries; tests use them to keep code and
// contracts in agreement.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { Ajv2020, type ErrorObject } from 'ajv/dist/2020.js';
import formatsPlugin, { type FormatsPlugin } from 'ajv-formats';

// import.meta.dirname, not import.meta.url: jsdom test environments rewrite the URL scheme.
export const SCHEMA_DIR = join(import.meta.dirname, '../../../contracts/schemas/');

// ajv-formats is CommonJS; under NodeNext its default import is the plugin itself at runtime.
const addFormats: FormatsPlugin =
  (formatsPlugin as unknown as { default?: FormatsPlugin }).default ?? (formatsPlugin as unknown as FormatsPlugin);

export function listSchemas(dir = SCHEMA_DIR): string[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort();
}

export function loadSchema(name: string, dir = SCHEMA_DIR): Record<string, unknown> {
  return JSON.parse(readFileSync(join(dir, name), 'utf8')) as Record<string, unknown>;
}

export interface Validation {
  ok: boolean;
  errors: ErrorObject[];
}

export type Validator = (data: unknown) => Validation;

export class Contracts {
  readonly #ajv: Ajv2020;
  readonly names: string[];

  constructor(dir = SCHEMA_DIR) {
    this.#ajv = new Ajv2020({ strict: false, allErrors: true });
    addFormats(this.#ajv);
    this.names = listSchemas(dir);
    for (const name of this.names) this.#ajv.addSchema(loadSchema(name, dir), name);
  }

  /** A validator for `name` (file name, e.g. "event-envelope.json", or a "#/$defs/x" subpath). */
  validator(name: string): Validator {
    const fn = this.#ajv.getSchema(name);
    if (!fn) throw new Error(`unknown schema: ${name}`);
    return (data) => {
      const ok = fn(data) === true;
      return { ok, errors: ok ? [] : [...(fn.errors ?? [])] };
    };
  }

  validate(name: string, data: unknown): Validation {
    return this.validator(name)(data);
  }
}

let shared: Contracts | null = null;
/** Process-wide instance (schemas compile once). */
export function contracts(): Contracts {
  shared ??= new Contracts();
  return shared;
}
