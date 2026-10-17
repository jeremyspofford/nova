// Effect classes for a tool call (FR-189, docs/12 §2.2). Built-in tools declare their effects.
// MCP, plugin, page and device tools carry no trusted effect classes, so the engine also infers
// classes from the tool's name and description; inference only ever adds classes (stricter), and
// "if classification fails for an action with an external effect, the stricter tier applies".
import type { ActionEffect, ToolDescriptor, ToolSource } from './types.ts';

/** Sources whose descriptors Nova itself defines; their annotations are trusted. */
export const TRUSTED_SOURCES: ReadonlySet<ToolSource> = new Set(['builtin', 'browser', 'computer']);

/** Effects that make an action consequential (it changes something or reaches someone). */
export const CONSEQUENTIAL: readonly ActionEffect[] = [
  'external_communication',
  'purchase',
  'account_change',
  'credential_change',
  'data_delete',
  'file_write',
  'install',
  'exec',
  'security_bypass',
  'captcha',
  'secret_access',
  'policy_change',
];

const INFERENCE: readonly [ActionEffect, RegExp][] = [
  [
    'purchase',
    /\b(purchas(e|es|ed|ing)|buy(s|ing)?|bought|order(s|ed|ing)?|checkouts?|pay(s|ing|ments?)?|paid)\b/,
  ],
  [
    'external_communication',
    /\b(send(s|ing)?|sent|post(s|ed|ing)?|e ?mail(s|ed|ing)?|messag(e|es|ed|ing)|publish(es|ed|ing)?|tweet(s|ed|ing)?)\b/,
  ],
  [
    'data_delete',
    /\b(delet(e|es|ed|ing)|remov(e|es|ed|ing)|drop(s|ped|ping)?|destroy(s|ed|ing)?)\b/,
  ],
  ['install', /\binstall(s|ed|ing)?\b/],
  ['credential_change', /\b(passwords?|passwd|credentials?|api ?keys?|tokens?|oauth\d*)\b/],
  [
    'account_change',
    /\b(creat(e|es|ed|ing)( \w+){0,2} accounts?|sign(s|ed|ing)? up|signup|invit(e|es|ed|ing)|grant(s|ed|ing)?( \w+){0,2} (permissions?|access))\b/,
  ],
];

/**
 * Common phrases where a keyword is a noun, not an action ("error message", "sort order", "page
 * token"). Removing them keeps honest read tools pre-approvable; a server that wants to hide what
 * a tool does can do so anyway, so this costs no safety.
 */
const BENIGN_PHRASES: readonly string[] = [
  'error message',
  'error messages',
  'commit message',
  'commit messages',
  'status message',
  'log message',
  'log messages',
  'message id',
  'sort order',
  'in order',
  'order by',
  'ascending order',
  'descending order',
  'post request',
  'post requests',
  'post method',
  'page token',
  'next page token',
  'pagination token',
  'continuation token',
  'max tokens',
  'number of tokens',
  'token count',
  'count tokens',
];

/** The tool's own name, without the `mcp:<server>.` / `plugin:<id>.` / `page:<host>.` prefix. */
function localName(name: string): string {
  if (name.startsWith('mcp:')) return name.slice(name.indexOf('.') + 1);
  if (name.startsWith('plugin:') || name.startsWith('page:'))
    return name.slice(name.lastIndexOf('.') + 1);
  return name;
}

/** Lower-case words: camelCase and every non-alphanumeric character split words. */
export function words(text: string): string {
  const spaced = text
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
  let padded = ` ${spaced} `;
  for (const phrase of BENIGN_PHRASES) padded = padded.split(` ${phrase} `).join('  ');
  return padded.replace(/\s+/g, ' ').trim();
}

/** Effect classes inferred from the name and description of an untrusted tool. */
export function inferEffects(tool: ToolDescriptor): ActionEffect[] {
  if (TRUSTED_SOURCES.has(tool.source)) return [];
  const text = `${words(localName(tool.name))} . ${words(tool.title ?? '')} . ${words(
    tool.description ?? '',
  )}`;
  return INFERENCE.filter(([, re]) => re.test(text)).map(([effect]) => effect);
}

/** Declared effects, the action class (FR-045) and inferred effects, without duplicates. */
export function effectiveEffects(tool: ToolDescriptor): ActionEffect[] {
  const out = new Set<ActionEffect>(tool.effects ?? []);
  switch (tool.annotations?.action) {
    case 'send':
      out.add('external_communication');
      break;
    case 'delete':
      out.add('data_delete');
      break;
    case 'execute':
      out.add('exec');
      break;
    case 'read':
    case 'write':
    case undefined:
      break;
  }
  for (const e of inferEffects(tool)) out.add(e);
  return [...out];
}

/**
 * Read-only for policy purposes: only Nova's own tools can be read-only (an MCP `readOnlyHint`
 * is an untrusted hint that may tighten, never loosen, docs/08 §1), and only when nothing but
 * the network is among its effects.
 */
export function isReadOnly(tool: ToolDescriptor, effects: readonly ActionEffect[]): boolean {
  const a = tool.annotations;
  return (
    TRUSTED_SOURCES.has(tool.source) &&
    a?.readOnly === true &&
    a.action !== 'write' &&
    a.action !== 'send' &&
    a.action !== 'delete' &&
    a.action !== 'execute' &&
    effects.every((e) => e === 'network')
  );
}

/** Whether the call writes to its path resource (FR-190). */
export function writesPath(tool: ToolDescriptor, effects: readonly ActionEffect[]): boolean {
  const a = tool.annotations;
  return (
    effects.includes('file_write') ||
    effects.includes('data_delete') ||
    a?.action === 'write' ||
    a?.action === 'delete' ||
    (a?.destructive === true && a.readOnly !== true && !effects.includes('exec'))
  );
}
