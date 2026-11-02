// Test-only schema evaluator. No test runner and no production renderer import.
import assert from 'node:assert/strict';
type Schema = { [key: string]: unknown };
// Keywords below are the complete supported constraint vocabulary; these four annotations are
// understood as inert metadata. A new semantic keyword must gain evaluator support before use.
const SCHEMA_KEYWORDS = new Set(['$ref', 'type', 'anyOf', 'enum', 'minimum', 'maximum', 'pattern', 'minLength', 'maxLength', 'minItems', 'maxItems', 'uniqueItems', 'items', 'required', 'properties', 'additionalProperties', 'definitions']);
const SCHEMA_ANNOTATIONS = new Set(['$schema', 'title', 'description', '$comment']);
function schemaVocabulary(schema: Schema): void {
  assert.ok(schema && typeof schema === 'object' && !Array.isArray(schema), 'A supported schema node is an object.');
  for (const key of Object.keys(schema)) {
    if (!SCHEMA_KEYWORDS.has(key) && !SCHEMA_ANNOTATIONS.has(key)) throw new Error(`Unsupported schema keyword: ${key}`);
    if (SCHEMA_ANNOTATIONS.has(key)) assert.equal(typeof schema[key], 'string', `Annotation ${key} is a string.`);
  }
  if (schema.$ref !== undefined) assert.match(String(schema.$ref), /^#\/definitions\/[A-Za-z]+$/);
  // Map keys are property/definition names, not semantic keywords. Visit their schema values.
  for (const key of ['properties', 'definitions']) if (schema[key] !== undefined) {
    const map = schema[key];
    assert.ok(map && typeof map === 'object' && !Array.isArray(map), `${key} is a schema map.`);
    for (const child of Object.values(map)) schemaVocabulary(child as Schema);
  }
  if (schema.anyOf !== undefined) {
    assert.ok(Array.isArray(schema.anyOf) && schema.anyOf.length > 0);
    for (const child of schema.anyOf) schemaVocabulary(child as Schema);
  }
  if (schema.items !== undefined) schemaVocabulary(schema.items as Schema);
  if (schema.additionalProperties !== undefined) assert.equal(typeof schema.additionalProperties, 'boolean', 'Only boolean additionalProperties is implemented.');
}
export function conforms(value: unknown, schema: Schema, root: Schema): boolean {
  schemaVocabulary(root);
  if (schema !== root) schemaVocabulary(schema);
  return evaluateSchema(value, schema, root);
}
function evaluateSchema(value: unknown, schema: Schema, root: Schema): boolean {
  if (typeof schema.$ref === 'string') {
    assert.match(schema.$ref, /^#\/definitions\/[A-Za-z]+$/);
    return evaluateSchema(value, (root.definitions as Record<string, Schema>)[schema.$ref.slice('#/definitions/'.length)]!, root);
  }
  if (Array.isArray(schema.anyOf) && !schema.anyOf.some((s) => evaluateSchema(value, s as Schema, root))) return false;
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) return false;
  const matches = (type: unknown) => type === 'null' ? value === null : type === 'array' ? Array.isArray(value) : type === 'object' ? typeof value === 'object' && value !== null && !Array.isArray(value) : type === 'integer' ? Number.isInteger(value) : typeof value === type;
  if (schema.type && !(Array.isArray(schema.type) ? schema.type : [schema.type]).some(matches)) return false;
  if (typeof value === 'number' && (!Number.isFinite(value) || (typeof schema.minimum === 'number' && value < schema.minimum) || (typeof schema.maximum === 'number' && value > schema.maximum))) return false;
  if (typeof value === 'string' && ((typeof schema.pattern === 'string' && !new RegExp(schema.pattern).test(value)) || (typeof schema.minLength === 'number' && value.length < schema.minLength) || (typeof schema.maxLength === 'number' && value.length > schema.maxLength))) return false;
  if (Array.isArray(value)) {
    if ((typeof schema.minItems === 'number' && value.length < schema.minItems) || (typeof schema.maxItems === 'number' && value.length > schema.maxItems)) return false;
    if (schema.uniqueItems && new Set(value.map((v) => JSON.stringify(v))).size !== value.length) return false;
    if (schema.items && !value.every((v) => evaluateSchema(v, schema.items as Schema, root))) return false;
  }
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>;
    if (Array.isArray(schema.required) && schema.required.some((k) => !Object.hasOwn(obj, k as string))) return false;
    const props = schema.properties as Record<string, Schema> | undefined;
    for (const [k, v] of Object.entries(obj)) {
      if (props && Object.hasOwn(props, k)) { if (!evaluateSchema(v, props[k]!, root)) return false; }
      else if (schema.additionalProperties === false) return false;
    }
  }
  return true;
}
