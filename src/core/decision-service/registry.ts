// The template registry (ADR §1): versioned batteries, checked against the authoring rules from
// TypeSafe's guidance and the ADR before they can be used. A version is immutable once registered:
// a change is a new version. Subsystems ask by template id; nothing builds questions at call time.
//
// Refused (errors): a question naming a field the template doesn't declare; a Choice with
// positional option names or without an escape; a Box without a companion Noul; a chunked field
// in a battery that isn't all Nouls; a truth table with a row that has no outcome.
// Flagged (warnings, kept with the template): conditions joined by "or" in one question; the same
// opening sentence on every question (a preamble).
import { checkTable } from './policy.ts';
import type { ServiceTemplate } from './types.ts';

export interface Registered { template: ServiceTemplate; warnings: string[] }

const POSITIONAL = /^(?:[a-z]|option_?\d+|opt\d+|choice_?\d+|first|second|third|left|right|top|bottom|\d+)$/i;
const ESCAPES = ['unknown', 'other', 'none'];
const text = (c: unknown): string => (typeof c === 'string' ? c : JSON.stringify(c ?? ''));
// Field references in backticks: `content`, `order.items[0]` → the first path segment.
export const refs = (s: string): string[] => [...s.matchAll(/`([A-Za-z_][\w]*)[^`]*`/g)].map((m) => m[1]!);
const opening = (s: string) => (s.split(/(?<=[.?!])\s+/)[0] ?? '').trim();

export function validate(t: ServiceTemplate): { errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(t.template_id)) errors.push('template_id must be lowercase letters, digits, dots, dashes or underscores');
  if (!Number.isInteger(t.version) || t.version < 1) errors.push('version must be a whole number from 1');
  if (!t.purpose?.trim()) errors.push('purpose is required, in plain words');
  const ids = Object.keys(t.questions);
  if (!ids.length) errors.push('a template needs at least one question');
  const fields = Object.keys(t.fields);
  const hasImage = Object.values(t.fields).some((f) => f.type === 'image') || Object.values(t.questions).some((q) => q.type === 'box');
  if (hasImage && t.feature !== 'box') errors.push('a template with an image field or a Box question is the "box" feature');
  if (!hasImage && t.feature === 'box') errors.push('the "box" feature is for templates with images');
  for (const [id, q] of Object.entries(t.questions)) {
    const words = [text(q.instructions), ...(q.type === 'noul' ? [text(q.criteria?.true), text(q.criteria?.false)] : q.type === 'choice' ? Object.values(q.criteria).map(text) : q.type === 'score' ? q.criteria.map(text) : [])].join(' ');
    for (const r of refs(words)) if (!fields.includes(r)) errors.push(`${id} refers to \`${r}\`, which isn’t a field of the state`);
    if (q.type === 'choice') {
      const opts = Object.keys(q.criteria);
      if (opts.length < 2) errors.push(`${id} needs at least two options`);
      const bad = opts.filter((o) => POSITIONAL.test(o));
      if (bad.length) errors.push(`${id} has option names that say nothing about the content (${bad.join(', ')}); name options for what they mean`);
      const escaped = opts.some((o) => ESCAPES.includes(o)) || ids.some((other) => { const c = t.questions[other]!; return c.type === 'noul' && c.escapes === id; });
      if (!escaped) errors.push(`${id} needs an escape: an "unknown", "other" or "none" option, or a companion Noul (a Noul with escapes: "${id}") asking whether any option fits`);
    }
    if (q.type === 'score' && (q.criteria.length < 2 || q.criteria.length > 10)) errors.push(`${id} needs 2 to 10 levels`);
    if (q.type === 'box') {
      const c = t.questions[q.companion];
      if (!c || c.type !== 'noul') errors.push(`${id} needs a companion Noul asking whether the target is there at all (a Box always returns a location)`);
    }
    if (/\bor\b/i.test(text(q.instructions))) warnings.push(`${id} joins conditions with "or": one judgment per question works better`);
  }
  if (ids.length > 2) {
    const first = opening(text(t.questions[ids[0]!]!.instructions));
    if (first && ids.every((id) => opening(text(t.questions[id]!.instructions)) === first)) warnings.push(`every question opens with the same sentence ("${first.slice(0, 60)}…"): a preamble adds noise; put shared context in the state`);
  }
  const chunked = Object.entries(t.fields).filter(([, f]) => f.type === 'text' && f.chunk === 'worst');
  if (chunked.length > 1) errors.push('at most one field may be chunked');
  if (chunked.length && Object.values(t.questions).some((q) => q.type !== 'noul')) errors.push('a chunked field needs a battery of Nouls only: the worst score per question is only defined for Nouls');
  for (const p of checkTable(t)) errors.push(`policy: ${p}`);
  return { errors, warnings };
}

export class Registry {
  #by = new Map<string, Map<number, Registered>>();

  // Registers a template version; refuses one that doesn't validate, or a changed copy of a
  // version that exists (a change is a new version).
  add(t: ServiceTemplate): Registered {
    const { errors, warnings } = validate(t);
    if (errors.length) throw new Error(`${t.template_id} v${t.version} can’t be used: ${errors.join('; ')}.`);
    const versions = this.#by.get(t.template_id) ?? new Map<number, Registered>();
    const had = versions.get(t.version);
    if (had) {
      if (had.template !== t) throw new Error(`${t.template_id} v${t.version} is already registered; a change is a new version.`);
      return had;
    }
    const r = { template: Object.freeze(t), warnings };
    versions.set(t.version, r);
    this.#by.set(t.template_id, versions);
    return r;
  }

  // The newest version, or a named one.
  get(id: string, version?: number): Registered | null {
    const v = this.#by.get(id);
    if (!v) return null;
    if (version !== undefined) return v.get(version) ?? null;
    return v.get(Math.max(...v.keys())) ?? null;
  }

  // Every version of a template, newest first.
  versions(id: string): Registered[] {
    const v = this.#by.get(id);
    return v ? [...v.entries()].sort((a, b) => b[0] - a[0]).map(([, r]) => r) : [];
  }

  list(): Registered[] {
    return [...this.#by.values()].flatMap((v) => [...v.values()]);
  }
}
