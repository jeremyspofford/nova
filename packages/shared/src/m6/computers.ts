// M6 computers API shapes (owned by the computers area; the web reads them): agent computers and
// their snapshots (FR-080), the egress proxy's per-scope network policy and credentials (FR-102,
// FR-193, docs/12 §8, ADR-063) and the network decision log.
import { z } from 'zod';

// ---- host patterns (docs/12 §8) ---------------------------------------------------------------

const LABEL = /^[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?$/;
const IPV4 = /^(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(?:\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;

/**
 * Why a network allowlist or denylist entry is not usable, or null when it is. Entries are host
 * names or IP literals; a wildcard is allowed only as the whole leftmost label (`*.example.com`)
 * and never over a single label; a bare `*` is rejected (FR-193).
 */
export function checkHostPattern(pattern: string): string | null {
  const p = pattern.trim().toLowerCase().replace(/\.$/, '');
  if (p === '*') return 'a bare * is not allowed: name the hosts';
  if (!p) return 'empty host';
  if (p.length > 253) return 'host name is too long';
  if (IPV4.test(p)) return null;
  if (p.includes(':')) {
    const inner = p.startsWith('[') && p.endsWith(']') ? p.slice(1, -1) : p;
    return /^[0-9a-f:.]+$/.test(inner) && inner.includes(':') ? null : `not a host: ${pattern}`;
  }
  const labels = p.split('.');
  const wildcard = labels[0] === '*';
  if (labels.slice(1).some((l) => l.includes('*')) || (!wildcard && p.includes('*')))
    return `a wildcard is allowed only as the leftmost label: ${pattern}`;
  const rest = wildcard ? labels.slice(1) : labels;
  if (wildcard && rest.length < 2)
    return `a wildcard cannot cover a whole top-level domain: ${pattern}`;
  for (const l of rest) if (!LABEL.test(l)) return `not a host: ${pattern}`;
  return null;
}

/** A host pattern, normalized to lower case without a trailing dot. */
export const hostPatternSchema = z
  .string()
  .min(1)
  .max(253)
  .superRefine((v, ctx) => {
    const why = checkHostPattern(v);
    if (why) ctx.addIssue({ code: 'custom', message: why });
  })
  .transform((v) => v.trim().toLowerCase().replace(/\.$/, ''));

// ---- computers (FR-080, docs/11 §1-§2) --------------------------------------------------------

export const COMPUTER_KINDS = ['cloud', 'local_container', 'local_host'] as const;
export type ComputerKindView = (typeof COMPUTER_KINDS)[number];

export const COMPUTER_STATES = ['starting', 'running', 'stopped', 'degraded', 'error'] as const;
export type ComputerStateView = (typeof COMPUTER_STATES)[number];

export interface ComputerView {
  id: string;
  kind: ComputerKindView;
  /** The agent whose own computer this is; null for a connected device. */
  agentId: string | null;
  deviceId: string | null;
  /** Who serves it: `container`, `bwrap`, `micro_vm`, `mock_cloud`, `novad`. */
  provider: string | null;
  state: ComputerStateView;
  /** The substrate commands run in now; null when none is available. */
  substrate: 'container' | 'micro_vm' | 'bwrap' | 'host' | 'cloud_stub' | null;
  /** Why it is degraded or stopped, in words. */
  detail: string | null;
  baseImage: string | null;
  snapshotCount: number;
  createdAt: string;
  updatedAt: string;
  lastUsedAt: string | null;
}

export interface ComputerSnapshotView {
  id: string;
  computerId: string;
  label: string | null;
  sizeBytes: number | null;
  createdAt: string;
}

export const computerSnapshotSchema = z.object({ label: z.string().max(200).optional() }).strict();
export const computerRestoreSchema = z.object({ snapshotId: z.string().min(1).max(100) }).strict();

// ---- egress policy (FR-102, FR-193) -----------------------------------------------------------

export const EGRESS_MODES = ['off', 'allowlist', 'limited'] as const;
export type EgressModeView = (typeof EGRESS_MODES)[number];

/** Scopes a network grant can belong to (docs/11 §7). */
export const EGRESS_SCOPE_KINDS = ['run', 'session', 'agent', 'plugin', 'mcp_server'] as const;
export type EgressScopeKind = (typeof EGRESS_SCOPE_KINDS)[number];

/** A credential-stripping hook (docs/12 §8): it can only tighten. */
export const egressHookSchema = z
  .object({
    id: z.string().min(1).max(100),
    host: hostPatternSchema,
    methods: z
      .array(z.string().regex(/^[A-Za-z]{1,20}$/))
      .max(20)
      .optional(),
    pathPrefix: z.string().startsWith('/').max(2000).optional(),
    action: z.enum(['strip_header', 'strip_cookies', 'block']),
    /** The header `strip_header` removes. */
    header: z
      .string()
      .regex(/^[A-Za-z0-9-]{1,100}$/)
      .optional(),
  })
  .strict()
  .refine((h) => h.action !== 'strip_header' || !!h.header, {
    message: 'strip_header needs a header',
    path: ['header'],
  });
export type EgressHook = z.infer<typeof egressHookSchema>;

/** PUT /api/v1/egress/scopes/:kind/:id. `mode: null` inherits the global mode. */
export const egressScopeSchema = z
  .object({
    mode: z.enum(EGRESS_MODES).nullable().default(null),
    allow: z.array(hostPatternSchema).max(500).default([]),
    deny: z.array(hostPatternSchema).max(500).default([]),
    hooks: z.array(egressHookSchema).max(100).default([]),
    /** Dev-server access to private addresses, still limited to granted hosts and ports. */
    allowLocalBinding: z.boolean().default(false),
  })
  .strict();
export type EgressScopeInput = z.infer<typeof egressScopeSchema>;

export interface EgressScopeView {
  kind: EgressScopeKind;
  id: string;
  mode: EgressModeView | null;
  allow: string[];
  deny: string[];
  hooks: EgressHook[];
  allowLocalBinding: boolean;
  updatedAt: string;
}

/** GET /api/v1/egress: what Settings → Network shows. */
export interface EgressView {
  /** From the `network.egressMode`, `network.egressAllow` and `network.egressDeny` settings. */
  global: { mode: EgressModeView; allow: string[]; deny: string[] };
  scopes: EgressScopeView[];
  /** Whether HTTPS can be inspected (the per-Hub CA exists); `limited` blocks HTTPS without it. */
  inspection: { https: boolean; caCertPem: string | null };
}

// ---- egress credentials (ADR-063) -------------------------------------------------------------

export const EGRESS_CREDENTIAL_SCHEMES = ['bearer', 'basic', 'header'] as const;

const credentialScope = z
  .object({ kind: z.enum(EGRESS_SCOPE_KINDS), id: z.string().min(1).max(100) })
  .strict();

const credentialFields = {
  name: z.string().min(1).max(100),
  hosts: z.array(hostPatternSchema).min(1).max(50),
  scheme: z.enum(EGRESS_CREDENTIAL_SCHEMES),
  /** The header `header` sets (e.g. `X-Api-Key`); not a hop-by-hop or proxy header. */
  header: z
    .string()
    .regex(/^[A-Za-z0-9-]{1,100}$/)
    .refine(
      (h) =>
        !/^(host|connection|proxy-.*|content-length|transfer-encoding|te|upgrade|cookie)$/i.test(h),
      'this header cannot carry a credential',
    )
    .nullable()
    .optional(),
  /** `basic`: the user name sent with the secret as the password. */
  username: z.string().max(200).nullable().optional(),
  /** Only sandboxes of this scope get it; every sandbox of the account when absent. */
  scope: credentialScope.nullable().optional(),
};

/** POST /api/v1/egress/credentials. The value goes to the vault and is never returned. */
export const egressCredentialCreateSchema = z
  .object({ ...credentialFields, value: z.string().min(1).max(16_384) })
  .strict()
  .refine((c) => c.scheme !== 'header' || !!c.header, {
    message: 'scheme header needs a header name',
    path: ['header'],
  });

/** PATCH /api/v1/egress/credentials/:id. A new `value` replaces the stored one. */
export const egressCredentialUpdateSchema = z
  .object({
    name: credentialFields.name.optional(),
    hosts: credentialFields.hosts.optional(),
    scheme: credentialFields.scheme.optional(),
    header: credentialFields.header,
    username: credentialFields.username,
    scope: credentialFields.scope,
    value: z.string().min(1).max(16_384).optional(),
  })
  .strict();

export interface EgressCredentialView {
  id: string;
  name: string;
  hosts: string[];
  scheme: (typeof EGRESS_CREDENTIAL_SCHEMES)[number];
  header: string | null;
  username: string | null;
  scope: { kind: EgressScopeKind; id: string } | null;
  /** The vault reference; the value itself is write-only. */
  secretRef: string;
  createdAt: string;
  updatedAt: string;
}

// ---- network decision log (docs/12 §8 audit) --------------------------------------------------

export const EGRESS_BLOCK_CAUSES = [
  'allowlist',
  'denylist',
  'method',
  'private_address',
  'inspection',
  'policy',
] as const;

export const networkDecisionQuerySchema = z.object({
  decision: z.enum(['allow', 'deny']).optional(),
  host: z.string().max(253).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});

/** One proxy decision, read from the audit log (kind `network`); no bodies or full URLs. */
export interface NetworkDecisionView {
  id: string;
  createdAt: string;
  decision: 'allow' | 'deny';
  cause: (typeof EGRESS_BLOCK_CAUSES)[number] | null;
  method: string | null;
  host: string | null;
  port: number | null;
  scope: { kind: string; id: string } | null;
  addressClass: string | null;
  mode: EgressModeView | null;
  status: number | null;
  inspected: boolean;
  bytesIn: number;
  bytesOut: number;
}
