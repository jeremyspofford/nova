// State hygiene (ADR §4): each battery gets its own state, built from its declared fields only.
// Undeclared fields are refused, a field over its cap fails the decision (it is never truncated;
// only a field declared chunk: 'worst' may be split, by the seat), and images are checked against
// TypeSafe's limits in code (PNG or JPEG, 280 to 1568 pixels a side, at most 16 MiB). The state's
// hash and field names are logged; the state itself never is.
import { createHash, randomUUID } from 'node:crypto';
import { CoreError } from '../errors.ts';
import type { BuiltState, FieldValue, ImageValue, ServiceTemplate } from './types.ts';

export const IMAGE_MIN = 280;
export const IMAGE_MAX = 1568;
export const IMAGE_MAX_BYTES = 16 * 1024 * 1024;

const isImage = (v: unknown): v is ImageValue => typeof v === 'object' && v !== null && (v as ImageValue).image instanceof Uint8Array;

// PNG or JPEG, and its size in pixels, read from the file itself; null when it is neither.
export function imageInfo(b: Uint8Array): { format: 'png' | 'jpg'; width: number; height: number } | null {
  if (b.length > 24 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) {
    const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
    return { format: 'png', width: dv.getUint32(16), height: dv.getUint32(20) };
  }
  if (b.length > 4 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) {
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) { i++; continue; }
      const marker = b[i + 1]!;
      const len = (b[i + 2]! << 8) | b[i + 3]!;
      // SOF0–SOF15, except DHT (C4), JPG (C8) and DAC (CC).
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { format: 'jpg', height: (b[i + 5]! << 8) | b[i + 6]!, width: (b[i + 7]! << 8) | b[i + 8]! };
      }
      i += 2 + len;
    }
    return null;
  }
  return null;
}

export function imageProblem(b: Uint8Array): string | null {
  if (b.length > IMAGE_MAX_BYTES) return `it is ${b.length} bytes; images can be at most 16 MiB`;
  const info = imageInfo(b);
  if (!info) return 'it isn’t a PNG or JPEG image';
  if (info.width < IMAGE_MIN || info.height < IMAGE_MIN || info.width > IMAGE_MAX || info.height > IMAGE_MAX) return `it is ${info.width}×${info.height}; each side must be ${IMAGE_MIN} to ${IMAGE_MAX} pixels`;
  return null;
}

// The state for one battery, from exactly its declared fields.
export function buildState(t: ServiceTemplate, given: Record<string, unknown>): BuiltState {
  const problems: string[] = [];
  const values: Record<string, FieldValue> = {};
  for (const k of Object.keys(given)) if (!(k in t.fields)) problems.push(`${k} isn’t a field of ${t.template_id}; a battery gets only the fields it declares`);
  for (const [k, spec] of Object.entries(t.fields)) {
    const v = given[k];
    if (v === undefined || v === null) { if (spec.required !== false) problems.push(`${k} is required`); continue; }
    if (spec.type === 'text') {
      if (typeof v !== 'string') { problems.push(`${k} must be text`); continue; }
      if (!spec.chunk && v.length > spec.max_chars) { problems.push(`${k} is ${v.length} characters; at most ${spec.max_chars} (never truncated)`); continue; }
      if (spec.chunk && v.length > spec.max_chars) { problems.push(`${k} is ${v.length} characters; even split into pieces, at most ${spec.max_chars}`); continue; }
      values[k] = v;
    } else if (spec.type === 'number') {
      if (typeof v !== 'number' || !Number.isFinite(v)) problems.push(`${k} must be a finite number`); else values[k] = v;
    } else if (spec.type === 'boolean') {
      if (typeof v !== 'boolean') problems.push(`${k} must be true or false`); else values[k] = v;
    } else {
      if (!isImage(v)) { problems.push(`${k} must be an image`); continue; }
      const bad = imageProblem(v.image);
      if (bad) { problems.push(`${k}: ${bad}`); continue; }
      values[k] = v;
    }
  }
  if (problems.length) throw new CoreError('validation', `This state doesn’t fit the template ${t.template_id}: ${problems.join('; ')}.`, problems);
  // Images become references in the state, sent as assets beside it.
  const images: BuiltState['images'] = {};
  const plain: Record<string, FieldValue> = {};
  for (const [k, v] of Object.entries(values)) {
    if (isImage(v)) {
      const ref = `img-${randomUUID()}`;
      images[ref] = { format: imageInfo(v.image)!.format, data: v.image };
      plain[k] = ref;
    } else plain[k] = v;
  }
  const state = t.state ? t.state(plain) : { ...plain };
  const chunked = Object.entries(t.fields).find(([, s]) => s.type === 'text' && s.chunk === 'worst');
  const hash = createHash('sha256');
  hash.update(JSON.stringify(Object.entries(values).map(([k, v]) => [k, isImage(v) ? createHash('sha256').update(v.image).digest('hex') : v])));
  return {
    state, images,
    chunk: chunked ? { field: chunked[0], ...(t.split ? { split: t.split } : {}) } : null,
    sha256: hash.digest('hex'),
    fields: Object.keys(values),
    values,
  };
}
