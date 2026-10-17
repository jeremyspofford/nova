// A small JSON Schema validator for tool arguments (docs/09 §2 step 6a). It covers the subset
// tool schemas use (types, properties, required, enums, bounds, items, combinators); keywords it
// does not know are ignored, so an unusual MCP schema never blocks a call by itself. The policy
// engine, not this check, decides whether a call may run.

type Schema = Record<string, unknown>;

const MAX_ERRORS = 10;
const MAX_DEPTH = 32;

/** Problems with `value` against `schema`, as `path: message` strings; empty when valid. */
export function validateArgs(schema: Record<string, unknown>, value: unknown): string[] {
  const errors: string[] = [];
  check(schema, value, '', errors, 0);
  return errors.slice(0, MAX_ERRORS);
}

function check(schema: unknown, value: unknown, path: string, errors: string[], depth: number) {
  if (errors.length >= MAX_ERRORS || depth > MAX_DEPTH) return;
  if (schema === false) {
    errors.push(`${at(path)}: not allowed`);
    return;
  }
  if (!isObject(schema)) return;
  const s = schema;

  if ('const' in s && !equal(s.const, value)) {
    errors.push(`${at(path)}: must be ${JSON.stringify(s.const)}`);
    return;
  }
  if (Array.isArray(s.enum) && !s.enum.some((e) => equal(e, value))) {
    errors.push(`${at(path)}: must be one of ${s.enum.map((e) => JSON.stringify(e)).join(', ')}`);
    return;
  }
  const types = typeList(s.type);
  if (types && !types.some((t) => isType(t, value))) {
    errors.push(`${at(path)}: expected ${types.join(' or ')}, got ${typeName(value)}`);
    return;
  }

  if (typeof value === 'string') {
    if (typeof s.minLength === 'number' && value.length < s.minLength)
      errors.push(`${at(path)}: shorter than ${s.minLength} characters`);
    if (typeof s.maxLength === 'number' && value.length > s.maxLength)
      errors.push(`${at(path)}: longer than ${s.maxLength} characters`);
    if (typeof s.pattern === 'string' && value.length <= 10_000) {
      try {
        if (!new RegExp(s.pattern, 'u').test(value))
          errors.push(`${at(path)}: does not match ${s.pattern}`);
      } catch {
        // an invalid pattern in a server's schema is the server's problem; ignore it
      }
    }
  }
  if (typeof value === 'number') {
    if (typeof s.minimum === 'number' && value < s.minimum)
      errors.push(`${at(path)}: below the minimum ${s.minimum}`);
    if (typeof s.maximum === 'number' && value > s.maximum)
      errors.push(`${at(path)}: above the maximum ${s.maximum}`);
    if (typeof s.exclusiveMinimum === 'number' && value <= s.exclusiveMinimum)
      errors.push(`${at(path)}: must be above ${s.exclusiveMinimum}`);
    if (typeof s.exclusiveMaximum === 'number' && value >= s.exclusiveMaximum)
      errors.push(`${at(path)}: must be below ${s.exclusiveMaximum}`);
  }
  if (Array.isArray(value)) {
    if (typeof s.minItems === 'number' && value.length < s.minItems)
      errors.push(`${at(path)}: fewer than ${s.minItems} items`);
    if (typeof s.maxItems === 'number' && value.length > s.maxItems)
      errors.push(`${at(path)}: more than ${s.maxItems} items`);
    if (isObject(s.items) || typeof s.items === 'boolean') {
      value.forEach((v, i) => check(s.items, v, `${path}[${i}]`, errors, depth + 1));
    }
  }
  if (isObject(value) && !Array.isArray(value)) {
    const props = isObject(s.properties) ? s.properties : {};
    if (Array.isArray(s.required)) {
      for (const k of s.required) {
        if (typeof k === 'string' && !(k in value))
          errors.push(`${at(join(path, k))}: is required`);
      }
    }
    for (const [k, v] of Object.entries(value)) {
      if (k in props) check(props[k], v, join(path, k), errors, depth + 1);
      else if (s.additionalProperties === false) errors.push(`${at(join(path, k))}: not allowed`);
      else if (isObject(s.additionalProperties))
        check(s.additionalProperties, v, join(path, k), errors, depth + 1);
    }
  }

  if (Array.isArray(s.allOf)) for (const sub of s.allOf) check(sub, value, path, errors, depth + 1);
  if (Array.isArray(s.anyOf) && !s.anyOf.some((sub) => passes(sub, value, path, depth)))
    errors.push(`${at(path)}: matches none of the allowed shapes`);
  if (Array.isArray(s.oneOf)) {
    const n = s.oneOf.filter((sub) => passes(sub, value, path, depth)).length;
    if (n !== 1) errors.push(`${at(path)}: must match exactly one allowed shape`);
  }
}

function passes(schema: unknown, value: unknown, path: string, depth: number): boolean {
  const errs: string[] = [];
  check(schema, value, path, errs, depth + 1);
  return errs.length === 0;
}

function typeList(t: unknown): string[] | null {
  if (typeof t === 'string') return [t];
  if (Array.isArray(t)) return t.filter((x): x is string => typeof x === 'string');
  return null;
}

function isType(t: string, v: unknown): boolean {
  switch (t) {
    case 'string':
      return typeof v === 'string';
    case 'number':
      return typeof v === 'number' && Number.isFinite(v);
    case 'integer':
      return typeof v === 'number' && Number.isInteger(v);
    case 'boolean':
      return typeof v === 'boolean';
    case 'null':
      return v === null;
    case 'array':
      return Array.isArray(v);
    case 'object':
      return isObject(v) && !Array.isArray(v);
    default:
      return true;
  }
}

function typeName(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (typeof v === 'number' && Number.isInteger(v)) return 'integer';
  return typeof v;
}

function isObject(v: unknown): v is Schema {
  return typeof v === 'object' && v !== null;
}

function equal(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function join(path: string, key: string): string {
  return path ? `${path}.${key}` : key;
}

function at(path: string): string {
  return path || '(arguments)';
}
