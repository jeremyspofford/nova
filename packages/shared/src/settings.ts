// Settings registry and precedence (docs/14 §1): built-in default → user global → user project →
// managed policy. Managed values lock the key. Project values cannot set security-relevant keys.
import { z } from 'zod';
import { presetSchema, ROUTING_STEPS, type Preset } from './api.ts';

export type SettingSource = 'default' | 'global' | 'project' | 'managed';

export interface SettingDefinition<T = unknown> {
  key: string;
  schema: z.ZodType<T>;
  default: T;
  /** Security-relevant keys can only be set globally or by managed policy (docs/14 §1). */
  security?: boolean;
  description: string;
}

// Infer the value type from the schema only (NoInfer on the default), so enum settings keep
// their literal union instead of widening to `string`.
function def<T>(
  d: Omit<SettingDefinition<T>, 'default'> & { default: NoInfer<T> },
): SettingDefinition<T> {
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
    description:
      'Model ref used for new chats: `<providerAccountId>/<modelId>`, `node:<nodeId>/<modelId>` or `preset:<id>` (FR-023).',
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
  'chat.temporaryTtlHours': def({
    key: 'chat.temporaryTtlHours',
    schema: z.number().int().min(1).max(720),
    default: 24,
    description: 'Hours after its last activity that a temporary chat is deleted (FR-027).',
  }),
  'memory.enabled': def({
    key: 'memory.enabled',
    schema: z.boolean(),
    default: true,
    description: 'Extract durable facts from chats into Memory and use them in context (FR-032).',
  }),
  'models.presets': def({
    key: 'models.presets',
    schema: z.array(presetSchema).max(20),
    default: [] as Preset[],
    description:
      'Virtual models on the Faster to Smarter control (FR-221). Empty means the built-in presets.',
  }),
  'routing.order': def({
    key: 'routing.order',
    schema: z
      .array(z.enum(ROUTING_STEPS))
      .min(1)
      .refine((v) => new Set(v).size === v.length, 'each step at most once'),
    default: [...ROUTING_STEPS] as (typeof ROUTING_STEPS)[number][],
    description: 'Order in which a turn picks where it runs (FR-127).',
  }),
  'routing.allowCloud': def({
    key: 'routing.allowCloud',
    schema: z.boolean(),
    default: true,
    security: true,
    description:
      'Whether a turn may fall back to a cloud provider when no local option fits (FR-127).',
  }),
  'memory.referencePastChats': def({
    key: 'memory.referencePastChats',
    schema: z.boolean(),
    default: true,
    description:
      'Use relevant past chats as context, separately from saved memories; turning it off purges derived data within 30 days (FR-205).',
  }),
  'memory.consolidation': def({
    key: 'memory.consolidation',
    schema: z.object({
      enabled: z.boolean(),
      idleMinutes: z
        .number()
        .int()
        .min(5)
        .max(7 * 24 * 60),
    }),
    default: { enabled: true, idleMinutes: 60 },
    description: 'Background memory consolidation of idle chats (FR-204).',
  }),
  'tools.roots': def({
    key: 'tools.roots',
    schema: z
      .array(
        z.object({
          path: z.string().min(1).max(1000),
          access: z.enum(['read', 'write']),
          label: z.string().max(100).optional(),
        }),
      )
      .max(50),
    default: [] as { path: string; access: 'read' | 'write'; label?: string }[],
    security: true,
    description:
      'Folders on the Hub that file and exec tools may use, besides the Hub workspace folder (FR-190).',
  }),
  'tools.permissionProfile': def({
    key: 'tools.permissionProfile',
    schema: z.string().min(1).max(100),
    default: 'workspace',
    security: true,
    description:
      'Permission profile for tools in chats: read-only, workspace or a custom one (FR-190).',
  }),
  'tools.approvalPolicy': def({
    key: 'tools.approvalPolicy',
    schema: z.enum(['ask_always', 'defaults', 'review', 'never_ask']),
    default: 'defaults',
    security: true,
    description: 'When chats ask before a tool runs (docs/12 §2.1).',
  }),
  'tools.deferBudget': def({
    key: 'tools.deferBudget',
    schema: z.object({
      tools: z.number().int().min(1).max(500),
      schemaTokens: z.number().int().min(500).max(100_000),
    }),
    default: { tools: 40, schemaTokens: 8000 },
    description:
      'Above this many tools or schema tokens, MCP and plugin tools are deferred (FR-196).',
  }),
  'policy.allowPersistentGrants': def({
    key: 'policy.allowPersistentGrants',
    schema: z.boolean(),
    default: true,
    security: true,
    description:
      'Whether approvals may offer "Always allow"; managed policy can turn it off (FR-100).',
  }),
  'policy.approvalTimeoutMinutes': def({
    key: 'policy.approvalTimeoutMinutes',
    schema: z
      .number()
      .int()
      .min(1)
      .max(7 * 24 * 60),
    default: 24 * 60,
    security: true,
    description: 'How long an approval waits before it is recorded as timed out (FR-100).',
  }),
  'search.searxngUrl': def({
    key: 'search.searxngUrl',
    schema: z.string().url().max(500).nullable(),
    default: null as string | null,
    security: true,
    description: 'SearXNG instance the web.search tool uses (FR-029); unset means no web search.',
  }),
  'notifications.categories': def({
    key: 'notifications.categories',
    schema: z.object({
      approval: z.boolean(),
      completion: z.boolean(),
      error: z.boolean(),
      attention: z.boolean(),
      system: z.boolean(),
    }),
    default: { approval: true, completion: true, error: true, attention: true, system: true },
    description: 'Which notification categories are shown and sent to the OS (FR-013).',
  }),
  'workspace.layout': def({
    key: 'workspace.layout',
    schema: z.record(z.string().max(20), z.unknown()),
    default: {},
    description:
      'Pane layout per mode (panes, sizes, order, maximized), restored on start (FR-005).',
  }),
  'chat.suggestions': def({
    key: 'chat.suggestions',
    schema: z.boolean(),
    default: true,
    description: 'Show suggested follow-up prompts in an empty composer (FR-028).',
  }),
  'appearance.customThemes': def({
    key: 'appearance.customThemes',
    schema: z.array(z.record(z.string(), z.unknown())).max(50),
    default: [] as Record<string, unknown>[],
    description:
      'Imported themes (contracts/schemas/theme.json), available in Appearance (FR-011).',
  }),
  'plugins.catalogs': def({
    key: 'plugins.catalogs',
    schema: z
      .array(
        z.object({
          id: z.string().regex(/^[a-z0-9-]{1,40}$/),
          name: z.string().min(1).max(100),
          location: z.string().min(1).max(1000),
        }),
      )
      .max(20),
    default: [] as { id: string; name: string; location: string }[],
    security: true,
    description:
      'Plugin catalogs: a folder on the Hub, an https URL or a Git URL (FR-045, FR-049).',
  }),
  'mcpServer.enabled': def({
    key: 'mcpServer.enabled',
    schema: z.boolean(),
    default: false,
    security: true,
    description:
      "Nova's own MCP server for external clients; off until a client is added (FR-044).",
  }),
  // ---- M5: runs, schedules, code sessions, auto-review, context ------------------------------
  'runs.defaultBudgets': def({
    key: 'runs.defaultBudgets',
    schema: z
      .object({
        timeSeconds: z
          .number()
          .int()
          .min(60)
          .max(7 * 86_400),
        tokens: z.number().int().min(1_000).max(100_000_000),
        costUsd: z.number().min(0).max(100_000).nullable(),
      })
      .strict(),
    default: { timeSeconds: 3_600, tokens: 2_000_000, costUsd: null },
    description:
      'Budgets of a new Work run: time, tokens and cost (null: the provider spend cap) (FR-182).',
  }),
  'runs.autonomy': def({
    key: 'runs.autonomy',
    schema: z.enum(['ask_first', 'standard', 'autonomous']),
    default: 'standard',
    description:
      'Autonomy of a new Work run: approve the plan first, show it, or skip it (docs/09 §3).',
  }),
  'runs.subagents': def({
    key: 'runs.subagents',
    schema: z
      .object({
        maxChildren: z.number().int().min(0).max(20),
        maxConcurrent: z.number().int().min(1).max(10),
      })
      .strict(),
    default: { maxChildren: 6, maxConcurrent: 4 },
    security: true,
    description: 'Sub-agents per run and how many run at once; children cannot spawn (FR-053).',
  }),
  'chat.escalation': def({
    key: 'chat.escalation',
    schema: z.enum(['propose', 'auto', 'off']),
    default: 'propose',
    description:
      'When a chat request needs multi-step tool work: propose a Work run, start it, or never (FR-186).',
  }),
  'code.permissionMode': def({
    key: 'code.permissionMode',
    schema: z.enum(['manual', 'accept_edits', 'auto', 'bypass']),
    default: 'manual',
    // A project folder must not loosen how Nova acts in it (docs/14 §1): global or managed only.
    security: true,
    description:
      'Permission mode of a new Code session; the last one used per folder wins (FR-063).',
  }),
  'code.folderModes': def({
    key: 'code.folderModes',
    schema: z.record(z.string().max(1000), z.enum(['manual', 'accept_edits', 'auto', 'bypass'])),
    default: {},
    description: 'The permission mode last used in each folder (Plan is never remembered, FR-063).',
  }),
  'code.allowBypass': def({
    key: 'code.allowBypass',
    schema: z.boolean(),
    default: false,
    security: true,
    description: 'Allow the Bypass permission mode (only on a VM or container substrate, FR-195).',
  }),
  'review.model': def({
    key: 'review.model',
    schema: z.string().max(200).nullable(),
    default: null,
    security: true,
    description:
      'The reviewer model of auto-review (FR-085); Auto mode needs one. It should differ from the acting model.',
  }),
  'context.compactThreshold': def({
    key: 'context.compactThreshold',
    schema: z.number().min(0.3).max(0.95),
    default: 0.8,
    description: 'Compact a turn when its context passes this share of the model limit (FR-183).',
  }),
  'instructions.files': def({
    key: 'instructions.files',
    schema: z
      .object({
        rootMarkers: z.array(z.string().regex(/^[^/\\:]{1,100}$/)).max(10),
        fallbackNames: z.array(z.string().regex(/^[^/\\:]{1,100}$/)).max(10),
        budgetBytes: z.number().int().min(1_024).max(262_144),
      })
      .strict(),
    default: { rootMarkers: ['.git'], fallbackNames: [], budgetBytes: 32_768 },
    security: true,
    description:
      'Instruction-file discovery: root markers, fallback names (plain file names) and the shared budget (FR-185).',
  }),
  'exec.sessions': def({
    key: 'exec.sessions',
    schema: z
      .object({
        yieldMs: z.number().int().min(100).max(60_000),
        outputTokens: z.number().int().min(500).max(50_000),
      })
      .strict(),
    default: { yieldMs: 10_000, outputTokens: 10_000 },
    description:
      'Interactive exec: how long exec.run waits before returning a session, and the output cap (FR-184).',
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
