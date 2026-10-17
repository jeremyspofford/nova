// Settings registry and precedence (docs/14 §1): built-in default → user global → user project →
// managed policy. Managed values lock the key. Project values cannot set security-relevant keys.
import { z } from 'zod';
import { presetSchema, ROUTING_STEPS, type Preset } from './api.ts';
import { hostPatternSchema } from './m6/computers.ts';

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
  // ---- M6 code
  'code.autoVerify': def({
    key: 'code.autoVerify',
    schema: z
      .object({
        enabled: z.boolean(),
        /** Build and test commands to run; empty detects them (build script, test suite). */
        commands: z.array(z.string().trim().min(1).max(500)).max(10),
        timeoutSeconds: z.number().int().min(30).max(3600),
        /** Failed checks sent back to the agent as a turn, in a row, before stopping (docs/10 §14). */
        feedbackTurns: z.number().int().min(0).max(3),
      })
      .strict(),
    default: { enabled: true, commands: [], timeoutSeconds: 600, feedbackTurns: 1 },
    // It names commands Nova runs on its own after every edit: a project cannot set it.
    security: true,
    description:
      'Auto-verify: after a turn edits files, run the project checks in the sandbox and report pass or fail (FR-068).',
  }),
  'code.worktreeCleanup': def({
    key: 'code.worktreeCleanup',
    schema: z.enum(['remove_clean', 'keep']),
    default: 'remove_clean',
    description:
      'When a session is archived: remove its worktree if clean, or keep it (dirty ones are always kept, FR-073).',
  }),
  'code.ciPollSeconds': def({
    key: 'code.ciPollSeconds',
    schema: z.number().int().min(15).max(3600),
    default: 60,
    description: 'How often open pull requests are polled for CI status (FR-070).',
  }),
  'code.ciFeedback': def({
    key: 'code.ciFeedback',
    schema: z.boolean(),
    default: true,
    description: 'Send failed CI checks of a session pull request back to its agent (FR-070).',
  }),
  'code.budgets': def({
    key: 'code.budgets',
    schema: z
      .object({
        timeSeconds: z.number().int().min(60).nullable(),
        tokens: z.number().int().min(1_000).nullable(),
        costUsd: z.number().min(0.01).nullable(),
      })
      .strict(),
    default: { timeSeconds: null, tokens: null, costUsd: null },
    description: 'Default bounds of a new Code session (docs/09 §2); none by default.',
  }),
  // ---- M6 channels
  'channels.privateToShared': def({
    key: 'channels.privateToShared',
    schema: z.enum(['ask', 'allow', 'deny']),
    default: 'ask',
    security: true,
    description:
      'A reply in a shared channel that uses content from a private thread or private memory: ask the owner, allow or deny (FR-088, docs/13 §4).',
  }),
  'channels.publicUrl': def({
    key: 'channels.publicUrl',
    schema: z.string().url().max(500).nullable(),
    default: null as string | null,
    security: true,
    description:
      'The address external services reach the Hub at (Slack, Teams, MCP event webhooks); unset uses the Hub address.',
  }),
  'triggers.ratePerHour': def({
    key: 'triggers.ratePerHour',
    schema: z.number().int().min(1).max(10_000),
    default: 30,
    security: true,
    description:
      'Most runs or wakes one event trigger may start per hour; further events are skipped (FR-056).',
  }),
  // ---- M6 screen
  'screen.grantMinutes': def({
    key: 'screen.grantMinutes',
    schema: z.number().int().min(1).max(1_440),
    default: 30,
    security: true,
    description:
      'How long a computer-use app grant lasts; renewable from the indicator (FR-207, docs/12 §4.2).',
  }),
  'screen.killKey': def({
    key: 'screen.killKey',
    schema: z
      .string()
      .min(1)
      .max(60)
      .regex(/^[A-Za-z0-9]+([+ ][A-Za-z0-9]+){0,4}$/, 'a key or a combination like ctrl+alt+k'),
    default: 'Escape',
    description:
      'The kill key that stops computer use at once; it can be remapped but never left unbound (FR-207).',
  }),
  'screen.tierOverrides': def({
    key: 'screen.tierOverrides',
    schema: z.record(z.string().min(1).max(200), z.enum(['none', 'view', 'click', 'full'])),
    default: {},
    security: true,
    description:
      'Lower the computer-use tier of an app by its name; nothing raises an app above its class tier (FR-207).',
  }),
  'screen.screenshotRetentionDays': def({
    key: 'screen.screenshotRetentionDays',
    schema: z.number().int().min(1).max(3_650),
    default: 30,
    description:
      'How long the before/after screenshots of computer-use actions are kept (docs/11 §9).',
  }),
  // ---- M6 computers
  'network.egressMode': def({
    key: 'network.egressMode',
    schema: z.enum(['off', 'allowlist', 'limited']),
    default: 'allowlist',
    security: true,
    description:
      'How sandboxes reach the network through the egress proxy: off, allowed hosts only, or allowed hosts with read-only methods (FR-193).',
  }),
  'network.egressDeny': def({
    key: 'network.egressDeny',
    schema: z.array(hostPatternSchema).max(500),
    default: [] as string[],
    security: true,
    description:
      'Hosts no sandbox may reach; a deny entry always wins over an allow entry (FR-193).',
  }),
  'computers.agentComputer': def({
    key: 'computers.agentComputer',
    schema: z.enum(['local_container', 'cloud']),
    default: 'local_container',
    security: true,
    description:
      "Where a new agent's computer runs: a sandbox on this Hub, or the cloud runner (a mock runner on the Hub in M6) (FR-080).",
  }),
  'computers.limits': def({
    key: 'computers.limits',
    schema: z
      .object({
        cpus: z.number().min(0.25).max(64),
        memoryMb: z.number().int().min(256).max(262_144),
        wallClockSeconds: z.number().int().min(10).max(86_400),
      })
      .strict(),
    default: { cpus: 2, memoryMb: 2048, wallClockSeconds: 300 },
    security: true,
    description:
      'Resource limits of every command on a computer: CPU, memory and wall clock (docs/11 §8).',
  }),
  'computers.microVm': def({
    key: 'computers.microVm',
    schema: z
      .object({ enabled: z.boolean(), runner: z.string().min(1).max(1000).nullable() })
      .strict(),
    default: { enabled: false, runner: null as string | null },
    security: true,
    description:
      'Micro-VM sandboxes (flagged, FR-195): off by default; they need a KVM runner on this host.',
  }),
  // ---- M6 spaces
  'spaces.agentEdits': def({
    key: 'spaces.agentEdits',
    schema: z.enum(['propose', 'direct']),
    default: 'propose',
    description:
      'How agent edits land in a new space: as proposals you accept, or as direct versions (FR-036).',
  }),
  'sites.publishRoot': def({
    key: 'sites.publishRoot',
    schema: z
      .string()
      .min(1)
      .max(1000)
      .refine((p) => p.startsWith('/') || /^[A-Za-z]:[\\/]/.test(p), 'an absolute path')
      .nullable(),
    default: null as string | null,
    security: true,
    description:
      'The folder on the Hub that site folders are published into; null uses <data>/sites (FR-037).',
  }),
  'appearance.pet': def({
    key: 'appearance.pet',
    schema: z.enum(['off', 'sprout', 'spark']),
    default: 'off',
    description: 'An optional animated companion; it never blocks input (FR-012).',
  }),
  'appearance.petPosition': def({
    key: 'appearance.petPosition',
    schema: z.enum(['bottom-right', 'bottom-left']),
    default: 'bottom-right',
    description: 'Where the companion sits (FR-012).',
  }),
  'appearance.petMuted': def({
    key: 'appearance.petMuted',
    schema: z.boolean(),
    default: false,
    description: 'Keep the companion still instead of reacting to what Nova is doing (FR-012).',
  }),
  // ---- M6 agents
  'agents.defaultBudgets': def({
    key: 'agents.defaultBudgets',
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
    default: { timeSeconds: 1_800, tokens: 500_000, costUsd: null },
    description:
      "Budgets of a new agent's turn chains: time, tokens and cost (null: the provider spend cap) (FR-182).",
  }),
  'agents.autonomy': def({
    key: 'agents.autonomy',
    schema: z.enum(['ask_first', 'standard', 'autonomous']),
    default: 'standard',
    description: 'Autonomy of a new agent: ask before every change, the defaults, or auto-review.',
  }),
  'agents.proactive': def({
    key: 'agents.proactive',
    schema: z
      .object({
        enabledByDefault: z.boolean(),
        intervalMinutes: z.number().int().min(15).max(10_080),
      })
      .strict(),
    default: { enabledByDefault: true, intervalMinutes: 60 },
    description:
      'Proactive research: on for new agents, and at most once per interval while an agent is idle (FR-082).',
  }),
  'agents.wakes': def({
    key: 'agents.wakes',
    schema: z
      .object({
        minMinutes: z.number().int().min(5).max(1_440),
        horizonDays: z.number().int().min(1).max(30),
        perDay: z.number().int().min(0).max(24),
      })
      .strict(),
    default: { minMinutes: 5, horizonDays: 30, perDay: 24 },
    security: true,
    description:
      'Self-set wakes (schedule.wake): the soonest, the furthest ahead, and how many per agent per day (FR-206).',
  }),
  // ---- M6 browser
  'browser.persistCookies': def({
    key: 'browser.persistCookies',
    schema: z.boolean(),
    default: false,
    security: true,
    description:
      "Keep the agent browser's cookies (its sign-ins) between browser sessions; off by default (FR-096).",
  }),
  'browser.allowLocalSites': def({
    key: 'browser.allowLocalSites',
    schema: z.boolean(),
    default: false,
    security: true,
    description:
      'Let the agent browser open local and private-network addresses such as dev servers (docs/12 §8).',
  }),
  'browser.devProtocol': def({
    key: 'browser.devProtocol',
    schema: z.boolean(),
    default: true,
    security: true,
    description:
      'Allow developer-protocol mode to be turned on per site; when off, no site can use it (FR-094).',
  }),
  'browser.maxConcurrent': def({
    key: 'browser.maxConcurrent',
    schema: z.number().int().min(1).max(8),
    default: 2,
    description: 'How many agent browsers may be open at once (docs/11 §8).',
  }),
  'browser.screenshotRetentionDays': def({
    key: 'browser.screenshotRetentionDays',
    schema: z.number().int().min(1).max(3_650),
    default: 30,
    description: 'How long the before/after screenshots of browser actions are kept (docs/11 §9).',
  }),
  'browser.executablePath': def({
    key: 'browser.executablePath',
    schema: z
      .string()
      .min(1)
      .max(1000)
      .refine((p) => p.startsWith('/') || /^[A-Za-z]:[\\/]/.test(p), 'an absolute path')
      .nullable(),
    default: null as string | null,
    security: true,
    description:
      'A Chromium executable for the agent browser; null uses the one installed for Playwright (FR-092).',
  }),
  // ---- M6 devices
  'devices.minNovadVersions': def({
    key: 'devices.minNovadVersions',
    schema: z.partialRecord(
      z.enum([
        'files',
        'staged_writes',
        'exec',
        'mcp',
        'power',
        'services',
        'updates',
        'computer_use',
        'browser',
        'capture',
      ]),
      z.string().regex(/^\d+(\.\d+){0,3}$/, 'a version like 0.6.0'),
    ),
    default: {},
    security: true,
    description:
      'Raise the minimum novad version a device needs for a capability; a device below it is refused that capability (FR-148).',
  }),
  'devices.wakesPerHour': def({
    key: 'devices.wakesPerHour',
    schema: z.number().int().min(1).max(60),
    default: 6,
    description: 'How many Wake-on-LAN requests a device may get per hour (FR-144).',
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
    // The proxy's own rules (FR-193): a bare `*` or a wildcard other than the leftmost label
    // would make it refuse every session's policy, so such entries are refused here.
    schema: z.array(hostPatternSchema).max(500),
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
