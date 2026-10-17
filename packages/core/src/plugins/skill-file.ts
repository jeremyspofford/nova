// Reading one skill folder (FR-046, ADR-067, docs/08 §4): SKILL.md front-matter validated against
// contracts/schemas/skill-frontmatter.json, `allowed-tools` accepted as an alias, the name
// defaulting to the folder name. Command files (docs/08 §3.1) convert to the same shape.
import { readFileSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { contracts, type Validator } from '@nova/contracts';
import { FrontmatterError, parseFrontmatterMarkdown, type YamlValue } from './frontmatter.ts';

export const SKILL_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;
/** SKILL.md and command files larger than this are refused. */
export const SKILL_FILE_MAX_BYTES = 1024 * 1024;

export interface ParsedSkill {
  name: string;
  description: string;
  whenToUse: string | null;
  allowedTools: string[];
  modelHint: string | null;
  body: string;
  /** The front-matter as written (unknown keys preserved). */
  frontmatter: Record<string, YamlValue>;
  /** Validator notes that do not refuse the skill (a short description). */
  warnings: string[];
  /** SKILL.md modification time. */
  updatedAt: string;
}

export type SkillParse = { ok: true; skill: ParsedSkill } | { ok: false; error: string };

let validate: Validator | null = null;
function frontmatterValidator(): Validator {
  validate ??= contracts().validator('skill-frontmatter.json');
  return validate;
}

/** `allowed_tools` as a list: a YAML list, or a space- or comma-separated string. */
export function toolList(v: YamlValue | undefined): string[] {
  if (Array.isArray(v)) return v.filter((t): t is string => typeof t === 'string' && t !== '');
  if (typeof v === 'string')
    return v
      .split(/[\s,]+/)
      .map((t) => t.trim())
      .filter(Boolean);
  return [];
}

/** `model_hint` as display text: the string, or `key: value` pairs of the object form. */
export function modelHintText(v: YamlValue | undefined): string | null {
  if (typeof v === 'string') return v;
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    const parts = Object.entries(v)
      .filter((e): e is [string, string] => typeof e[1] === 'string')
      .map(([k, x]) => `${k}: ${x}`);
    return parts.length ? parts.join(', ') : null;
  }
  return null;
}

function readText(file: string): string {
  const st = statSync(file);
  if (!st.isFile()) throw new Error(`${basename(file)} is not a file`);
  if (st.size > SKILL_FILE_MAX_BYTES) throw new Error(`${basename(file)} is larger than 1 MB`);
  return readFileSync(file, 'utf8');
}

/** Validate front-matter data and build the skill; `fallbackName` is the folder or file name. */
export function skillFromParts(
  data: Record<string, YamlValue>,
  body: string,
  fallbackName: string,
  updatedAt: string,
): SkillParse {
  const v = frontmatterValidator()(data);
  if (!v.ok) {
    const first = v.errors[0];
    const where = first?.instancePath ? first.instancePath.slice(1) : 'front-matter';
    return { ok: false, error: `${where}: ${first?.message ?? 'invalid'}` };
  }
  const name = typeof data.name === 'string' ? data.name : fallbackName;
  if (!SKILL_NAME.test(name))
    return {
      ok: false,
      error: `name "${name}" must be lowercase letters, digits and dashes (at most 64)`,
    };
  const description = typeof data.description === 'string' ? data.description.trim() : '';
  const warnings: string[] = [];
  if (description.length < 20)
    warnings.push(`${name}: the description is short; say what the skill does and when`);
  return {
    ok: true,
    skill: {
      name,
      description,
      whenToUse: typeof data.when_to_use === 'string' ? data.when_to_use : null,
      allowedTools: toolList(data.allowed_tools ?? data['allowed-tools']),
      modelHint: modelHintText(data.model_hint),
      body,
      frontmatter: data,
      warnings,
      updatedAt,
    },
  };
}

/** Read `<dir>/SKILL.md`. Never throws: a broken skill is reported, not loaded. */
export function readSkillFolder(dir: string): SkillParse {
  const file = join(dir, 'SKILL.md');
  let text: string;
  let mtime: string;
  try {
    text = readText(file);
    mtime = statSync(file).mtime.toISOString();
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'SKILL.md is missing' };
  }
  try {
    const md = parseFrontmatterMarkdown(text);
    if (!md.hasFrontmatter) return { ok: false, error: 'SKILL.md has no front-matter' };
    return skillFromParts(md.data, md.body, basename(dir), mtime);
  } catch (err) {
    return { ok: false, error: err instanceof FrontmatterError ? err.message : String(err) };
  }
}

/** A slug for a heading: lowercase words joined with dashes, at most 64 characters. */
export function slugName(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
    .replace(/-+$/g, '');
}

/**
 * A Markdown command file as a skill (docs/08 §3.1): the body becomes SKILL.md; the name is the
 * front-matter `name`, else the first heading, else the file name; the description is the
 * front-matter one, else the first paragraph, else the heading.
 */
export function readCommandFile(file: string): SkillParse {
  let text: string;
  let mtime: string;
  try {
    text = readText(file);
    mtime = statSync(file).mtime.toISOString();
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'command file is missing' };
  }
  let md;
  try {
    md = parseFrontmatterMarkdown(text);
  } catch (err) {
    return { ok: false, error: err instanceof FrontmatterError ? err.message : String(err) };
  }
  const heading = /^#{1,6}\s+(.+?)\s*#*\s*$/m.exec(md.body)?.[1] ?? null;
  const paragraph =
    md.body
      .split(/\n\s*\n/)
      .map((p) => p.trim())
      .find((p) => p !== '' && !p.startsWith('#') && !p.startsWith('```')) ?? null;
  const fileName = slugName(basename(file).replace(/\.md$/i, ''));
  const fromHeading = heading ? slugName(heading) : '';
  const data: Record<string, YamlValue> = { ...md.data };
  data.name ??= SKILL_NAME.test(fromHeading) ? fromHeading : fileName;
  const fallback =
    paragraph?.replace(/\s+/g, ' ').slice(0, 1024) ??
    heading ??
    `Run the ${typeof data.name === 'string' ? data.name : fileName} command`;
  data.description ??= fallback;
  return skillFromParts(data, md.body, fileName, mtime);
}
