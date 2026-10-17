// Settings registry and precedence (docs/14 §1): built-in default → user global → user project →
// managed policy. Managed values lock the key. Project values cannot set security-relevant keys.
import { z } from 'zod';

export type SettingSource = 'default' | 'global' | 'project' | 'managed';

export interface SettingDefinition<T = unknown> {
  key: string;
  schema: z.ZodType<T>;
  default: T;
  /** Security-relevant keys can only be set globally or by managed policy (docs/14 §1). */
  security?: boolean;
  description: string;
}

function def<T>(d: SettingDefinition<T>): SettingDefinition<T> {
  return d;
}

const hexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'expected a #rrggbb color');
// Font stacks are CSS font-family values; reject anything that could break out of the property.
const fontStack = z
  .string()
  .max(200)
  .regex(/^[\w\s,'"-]+$/, 'letters, digits, spaces, quotes, commas and hyphens only');

export const SETTINGS = {
  'appearance.theme': def({
    key: 'appearance.theme',
    schema: z.enum(['system', 'light', 'dark', 'high-contrast-light', 'high-contrast-dark']),
    default: 'system',
    description: 'Base theme.',
  }),
  'appearance.fontScale': def({
    key: 'appearance.fontScale',
    schema: z.number().min(0.75).max(2),
    default: 1,
    description: 'UI font scale.',
  }),
  'appearance.reducedMotion': def({
    key: 'appearance.reducedMotion',
    schema: z.enum(['system', 'on', 'off']),
    default: 'system',
    description: 'Reduce motion.',
  }),
  'appearance.accent': def({
    key: 'appearance.accent',
    schema: hexColor.nullable(),
    default: null,
    description: 'Accent color override; null uses the theme (FR-010).',
  }),
  'appearance.background': def({
    key: 'appearance.background',
    schema: hexColor.nullable(),
    default: null,
    description: 'Background color override; null uses the theme (FR-010).',
  }),
  'appearance.foreground': def({
    key: 'appearance.foreground',
    schema: hexColor.nullable(),
    default: null,
    description: 'Text color override; null uses the theme (FR-010).',
  }),
  'appearance.uiFont': def({
    key: 'appearance.uiFont',
    schema: fontStack.nullable(),
    default: null,
    description: 'UI font family; null uses the system stack (FR-010).',
  }),
  'appearance.codeFont': def({
    key: 'appearance.codeFont',
    schema: fontStack.nullable(),
    default: null,
    description: 'Code font family; null uses the bundled monospace stack (FR-010).',
  }),
  'keyboard.bindings': def({
    key: 'keyboard.bindings',
    schema: z.record(z.string().regex(/^[a-z][a-zA-Z0-9.]*$/), z.string().max(40)),
    default: {},
    description: 'User remappings: command id → key binding (FR-004). Empty string unbinds.',
  }),
  'onboarding.state': def({
    key: 'onboarding.state',
    schema: z.object({
      step: z.enum(['provider', 'model', 'profile', 'tool', 'sample', 'done']),
      completed: z.boolean(),
      skipped: z.boolean(),
    }),
    default: { step: 'provider', completed: false, skipped: false },
    description: 'First-run onboarding progress, so it can resume (FR-014).',
  }),
  'chat.defaultModel': def({
    key: 'chat.defaultModel',
    schema: z.string().max(300).nullable(),
    default: null as string | null,
    description: 'Model ref (`<providerAccountId>/<modelId>`) used for new chats (FR-023).',
  }),
  'general.enterToSend': def({
    key: 'general.enterToSend',
    schema: z.enum(['enter', 'mod+enter']),
    default: 'enter',
    description: 'Which key sends a message.',
  }),
  'general.followUp': def({
    key: 'general.followUp',
    schema: z.enum(['steer', 'queue']),
    default: 'queue',
    description: 'What a message sent during a run does (FR-019).',
  }),
  'privacy.telemetry': def({
    key: 'privacy.telemetry',
    schema: z.boolean(),
    default: false,
    security: true,
    description: 'Content-free telemetry (off by default, ADR-019).',
  }),
  'network.egressAllow': def({
    key: 'network.egressAllow',
    schema: z.array(
      z
        .string()
        .min(1)
        .refine((h) => h !== '*', 'a bare * is not allowed'),
    ),
    default: [] as string[],
    security: true,
    description: 'Hosts agents may reach without asking (FR-102).',
  }),
} as const;

export type SettingKey = keyof typeof SETTINGS;
export type SettingValue<K extends SettingKey> = (typeof SETTINGS)[K]['default'];

export function isSettingKey(key: string): key is SettingKey {
  return Object.hasOwn(SETTINGS, key);
}

export interface SettingLayers {
  global?: Partial<Record<string, unknown>>;
  project?: Partial<Record<string, unknown>>;
  managed?: Partial<Record<string, unknown>>;
}

export interface ResolvedSetting<T = unknown> {
  key: string;
  value: T;
  source: SettingSource;
  locked: boolean;
}

/**
 * Resolve one key. Invalid stored values are skipped (the next layer down wins) so a corrupt row
 * can never break the app; managed values that fail validation are also skipped, never applied.
 */
export function resolveSetting<K extends SettingKey>(
  key: K,
  layers: SettingLayers,
): ResolvedSetting<SettingValue<K>> {
  const d = SETTINGS[key] as SettingDefinition<SettingValue<K>>;
  const pick = (v: unknown) => (v === undefined ? undefined : d.schema.safeParse(v));
  const managed = pick(layers.managed?.[key]);
  if (managed?.success) return { key, value: managed.data, source: 'managed', locked: true };
  if (!d.security) {
    const project = pick(layers.project?.[key]);
    if (project?.success) return { key, value: project.data, source: 'project', locked: false };
  }
  const global = pick(layers.global?.[key]);
  if (global?.success) return { key, value: global.data, source: 'global', locked: false };
  return { key, value: d.default, source: 'default', locked: false };
}

export function resolveAll(layers: SettingLayers): ResolvedSetting[] {
  return (Object.keys(SETTINGS) as SettingKey[]).map((k) => resolveSetting(k, layers));
}

export type SettingWriteError =
  'unknown_key' | 'invalid_value' | 'managed' | 'security_key_in_project';

/** Validate a user write before it is stored. */
export function checkSettingWrite(
  key: string,
  value: unknown,
  scope: 'global' | 'project',
  layers: SettingLayers,
): { ok: true; value: unknown } | { ok: false; error: SettingWriteError; message: string } {
  if (!isSettingKey(key))
    return { ok: false, error: 'unknown_key', message: `unknown setting ${key}` };
  const d = SETTINGS[key] as SettingDefinition;
  if (resolveSetting(key, layers).locked) {
    return { ok: false, error: 'managed', message: `${key} is managed by your organization` };
  }
  if (scope === 'project' && d.security) {
    return {
      ok: false,
      error: 'security_key_in_project',
      message: `${key} cannot be set per project`,
    };
  }
  const parsed = d.schema.safeParse(value);
  if (!parsed.success) {
    return {
      ok: false,
      error: 'invalid_value',
      message: parsed.error.issues.map((i) => i.message).join('; '),
    };
  }
  return { ok: true, value: parsed.data };
}
