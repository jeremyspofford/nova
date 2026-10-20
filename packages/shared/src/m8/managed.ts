// M8 managed policy (FR-106; docs/12 §10; ADR-078, ADR-097 D4): what an administrator sets through
// the OS-protected local file or a signed remote policy. `settings` become the managed settings
// layer (locked in every view); `restrict` narrows what Nova may do (permission modes, tools,
// plugins, extensions, MCP servers, sessions, folders, browser domains, egress, telemetry export,
// model routing, unverified installs, app authorization). Managed policy only tightens. Views and
// zod requests for /api/v1/managed.
import { z } from 'zod';
import { PERMISSION_MODES, PROVIDER_KINDS } from '../api.ts';
import { hostPatternSchema } from '../m6/computers.ts';

/**
 * Where a policy came from: the OS-protected local file, the signed remote policy, or (tests only)
 * a file layered over them (NOVA_MANAGED_SETTINGS_FILE).
 */
export const MANAGED_CHANNELS = ['local', 'remote', 'test'] as const;
export type ManagedChannel = (typeof MANAGED_CHANNELS)[number];

/** Provider kinds a policy may allow for model routing; `node` is a compute node (FR-126). */
export const MANAGED_PROVIDER_KINDS = [...PROVIDER_KINDS, 'node'] as const;
export type ManagedProviderKind = (typeof MANAGED_PROVIDER_KINDS)[number];

/**
 * A name pattern: an exact name, or a glob whose `*` matches any run of characters
 * (`screen.*`, `mcp:corp-*`, `com.corp.*`). Matching ignores case.
 */
export const managedNamePatternSchema = z
  .string()
  .min(1)
  .max(300)
  .regex(/^[A-Za-z0-9_.:/@*+-]+$/, 'letters, digits, . _ : / @ + - and * only');

const names = z.array(managedNamePatternSchema).max(500);
const hosts = z.array(hostPatternSchema).max(500);

/** An absolute folder path or one under the Hub user's home (`~/src`); no `..` segments. */
export const managedFolderSchema = z
  .string()
  .min(1)
  .max(1000)
  .refine((p) => !p.includes('\0'), 'no NUL characters')
  .refine(
    (p) => p === '~' || p.startsWith('~/') || p.startsWith('/') || /^[A-Za-z]:[\\/]/.test(p),
    'an absolute path or one starting with ~/',
  )
  .refine((p) => !p.split(/[\\/]/).includes('..'), 'no .. segments');

const allowDeny = <T extends z.ZodType>(item: T) =>
  z.object({ allow: z.array(item).max(500).optional(), deny: z.array(item).max(500).optional() });

/**
 * The `restrict` block (ADR-097 D4). Each part is optional; an absent part restricts nothing.
 * Unknown keys are refused, so a restriction Nova does not understand never silently fails to
 * apply (the whole policy then fails closed, docs/12 §10).
 */
export const managedRestrictSchema = z
  .object({
    /** Code session modes (and their run and chat equivalents). Manual can never be denied. */
    permissionModes: allowDeny(z.enum(PERMISSION_MODES)).strict(),
    /** Tool names (`exec.run`, `screen.*`, `mcp:*`). */
    tools: allowDeny(managedNamePatternSchema).strict(),
    /** Plugin ids. */
    plugins: allowDeny(managedNamePatternSchema).strict(),
    /** Extension ids (FR-117). */
    extensions: allowDeny(managedNamePatternSchema).strict(),
    /** MCP server names; `userAdded: false` refuses servers the user adds, `localStdio: false`
     * refuses stdio servers the Hub would start itself. */
    mcpServers: z
      .object({
        allow: names.optional(),
        deny: names.optional(),
        userAdded: z.boolean().optional(),
        localStdio: z.boolean().optional(),
      })
      .strict(),
    /** Code sessions on the Hub's own files (`local`) and over SSH (`ssh`, `sshHosts`). */
    sessions: z
      .object({
        local: z.boolean().optional(),
        ssh: z.boolean().optional(),
        sshHosts: hosts.optional(),
      })
      .strict(),
    /** Folders sessions, project folders and tool roots may use (the folder and below). */
    folders: allowDeny(managedFolderSchema).strict(),
    /** Sites the agent browser may open. */
    browserDomains: allowDeny(hostPatternSchema).strict(),
    /** The egress ceiling: the mode, the hosts allowed (intersected) and denied (added). */
    egress: z
      .object({
        mode: z.enum(['off', 'limited', 'allowlist']).optional(),
        allow: hosts.optional(),
        deny: hosts.optional(),
      })
      .strict(),
    /** False: telemetry export (OTLP, FR-223) stays off. */
    telemetryExport: z.boolean(),
    /** Model routing: cloud models, and the provider kinds models may come from. */
    routing: z
      .object({
        allowCloud: z.boolean().optional(),
        providers: z.array(z.enum(MANAGED_PROVIDER_KINDS)).max(20).optional(),
      })
      .strict(),
    /** False: plugins, extensions and bundles install only when their signature verifies. */
    unverifiedInstalls: z.boolean(),
    /** False: no third-party app or MCP client may be authorized (FR-222, FR-044). */
    apps: z.boolean(),
  })
  .partial()
  .strict();
export type ManagedRestrict = z.infer<typeof managedRestrictSchema>;

/** Where the signed remote policy is fetched from, and the Ed25519 key it must be signed with. */
export const managedRemoteSchema = z
  .object({
    url: z
      .string()
      .min(1)
      .max(2000)
      .refine((u) => {
        try {
          return new URL(u).protocol === 'https:' || new URL(u).protocol === 'http:';
        } catch {
          return false;
        }
      }, 'an https URL'),
    /** The raw 32-byte Ed25519 public key, base64url (the D2 publisher key format). */
    publicKey: z.string().regex(/^[A-Za-z0-9_-]{43}$/, 'a base64url Ed25519 public key'),
    /** How often the Hub fetches it again, 5 minutes to 1 day (default 60). */
    refreshMinutes: z.number().int().min(5).max(1440).optional(),
    /**
     * The oldest serial the Hub may apply. The last good copy is kept in a folder the Hub can
     * write, so this floor in the root-owned file stops a rollback by swapping that copy.
     */
    minSerial: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
  })
  .strict();
export type ManagedRemote = z.infer<typeof managedRemoteSchema>;

/**
 * A policy document. `remote` is read only from the local file: a remote policy cannot point
 * somewhere else. `serial` (optional) only ever grows: a remote policy with a lower serial than the
 * one in force is refused as a rollback.
 */
export const managedPolicySchema = z
  .object({
    $schema: z.string().max(500).optional(),
    version: z.literal(1),
    serial: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
    settings: z
      .record(z.string().min(1).max(200), z.unknown())
      .refine((r) => Object.keys(r).length <= 500, 'at most 500 settings')
      .optional(),
    restrict: managedRestrictSchema.optional(),
    remote: managedRemoteSchema.optional(),
  })
  .strict();
export type ManagedPolicyDocument = z.infer<typeof managedPolicySchema>;

/**
 * The value of the `managed.restrict` setting the managed layer carries: one `restrict` block per
 * source in force (each applies: the most restrictive wins), and why the policy fails closed when
 * a trusted source could not be read (every agent tool is then denied, docs/12 §10).
 */
export const managedRestrictSettingSchema = z
  .object({
    layers: z.array(managedRestrictSchema).max(8),
    failClosed: z.string().max(1000).nullable(),
    /**
     * The hosts agents may reach under the policy's egress allow lists, worked out against the
     * owner's own list (see `ManagedEgressView`); absent or null when the policy sets no list.
     */
    egressAllow: z.array(z.string().max(253)).max(500).nullable().optional(),
  })
  .strict();
export type ManagedRestrictSetting = z.infer<typeof managedRestrictSettingSchema>;

/**
 * - `absent`: no file, or no remote policy configured.
 * - `active`: read, checked and in force.
 * - `ignored`: the file failed its ownership or mode check (never partially applied).
 * - `invalid`: a trusted source that does not parse or validate: the policy fails closed.
 * - `refused`: a remote policy whose signature or serial did not check out.
 * - `unreachable`: the remote policy could not be fetched.
 * Unless the source is absent, its last good policy stays in force (`inForce`).
 */
export const MANAGED_SOURCE_STATUSES = [
  'absent',
  'active',
  'ignored',
  'invalid',
  'refused',
  'unreachable',
] as const;
export type ManagedSourceStatus = (typeof MANAGED_SOURCE_STATUSES)[number];

export interface ManagedSourceView {
  channel: ManagedChannel;
  /** The file path or the remote URL. */
  location: string;
  status: ManagedSourceStatus;
  /** Why it is ignored, invalid, refused or unreachable. */
  problem: string | null;
  /** A policy from this source is in force: the one just read, or the last good one. */
  inForce: boolean;
  /** Remote: the policy in force is the last good copy kept on disk, not a fresh fetch. */
  cached: boolean;
  /** The serial of the policy in force from this source. */
  serial: number | null;
  /** When this source's policy in force was read (remote: fetched). */
  loadedAt: string | null;
  /** When the source was last checked. */
  checkedAt: string;
  /** The `test` file: NOVA_MANAGED_SETTINGS_FILE, layered over the others (tests only). */
  testOverride?: boolean;
}

/** Why a key of a policy's `settings` does not apply. */
export const MANAGED_IGNORE_REASONS = [
  'unknown_key',
  'invalid_value',
  'loosens',
  'unordered',
  'manual_mode',
] as const;
export type ManagedIgnoreReason = (typeof MANAGED_IGNORE_REASONS)[number];

export interface ManagedIgnoredView {
  channel: ManagedChannel;
  /** The settings key, or `restrict.<part>` for a restriction that cannot apply. */
  key: string;
  reason: ManagedIgnoreReason;
  message: string;
}

/** A setting the policy sets: its policy value and where it comes from. */
export interface ManagedSettingView {
  key: string;
  value: unknown;
  /** The source, or `both` when the two were combined (the more restrictive value). */
  channel: ManagedChannel | 'both';
  /** For a setting implied by a restriction: which (`restrict.egress`). */
  derivedFrom: string | null;
}

/**
 * The policy's egress allow lists are a ceiling (ADR-097): with no list of the owner's own (unset or
 * empty) the policy's hosts apply; with one, the owner's hosts that every policy list covers apply,
 * so the owner chooses within the ceiling. Deny lists always add up.
 */
export interface ManagedEgressView {
  /** Each source's allow list (a host must be within every one). */
  ceilings: string[][];
  /** The owner's own allow list (`network.egressAllow`). */
  own: string[];
  /** What agents may reach without asking: the hosts in force. */
  effective: string[];
  /** Said when the result needs the owner's attention (none of their hosts is allowed). */
  note: string | null;
}

/** GET /api/v1/managed: what applies and where it comes from. */
export interface ManagedPolicyView {
  /** A source is in force. */
  active: boolean;
  /** Why every agent tool is denied (a trusted source failed to parse or validate), or null. */
  failClosed: string | null;
  sources: ManagedSourceView[];
  settings: ManagedSettingView[];
  restrict: { channel: ManagedChannel; restrict: ManagedRestrict }[];
  /** The egress allow list in force, when the policy sets one. */
  egress: ManagedEgressView | null;
  ignored: ManagedIgnoredView[];
  checkedAt: string;
}

/** POST /api/v1/managed/reload: read the local file and fetch the remote policy again. */
export const managedReloadSchema = z.object({}).strict();
