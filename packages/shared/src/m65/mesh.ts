// M6.5 mesh and Network Setup API shapes (owned by the network-setup area; the web reads them).
// The assistant of docs/22 §6 (FR-136): detection, a plan of steps for one mesh provider, applying
// one step at a time with a one-time consent, verification by reachability tests, and rollback.
// Secrets never appear here: an auth key the owner types is write-only (moved to the vault).
import { z } from 'zod';
import { idSchema } from '../api.ts';

/** Mesh control planes the assistant can set up (docs/22 §2, §2.2). */
export const MESH_PROVIDERS = ['headscale', 'tailscale', 'netbird', 'wireguard'] as const;
export type MeshProvider = (typeof MESH_PROVIDERS)[number];
export const meshProviderSchema = z.enum(MESH_PROVIDERS);

/** Transports a setup step can disturb (docs/22 §2); `local` is a request from the Hub itself. */
export const NETWORK_SETUP_TRANSPORTS = ['lan', 'mesh', 'relay', 'direct'] as const;
export type NetworkSetupTransport = (typeof NETWORK_SETUP_TRANSPORTS)[number];
export type NetworkSetupRequestTransport = NetworkSetupTransport | 'local' | 'unknown';

/**
 * What a step changes. Consent is remembered per kind and provider (docs/22 §6.2):
 * `client.install` installs the mesh client package; `server.*` change the Headscale server;
 * `mesh.*` change the Hub's mesh client; `firewall.ports` opens the Hub's port; `trust.cert`,
 * `relay.enroll` go through the trust and relay areas; `reachability` only tests.
 */
export const NETWORK_SETUP_STEP_KINDS = [
  'client.install',
  'server.user',
  'server.acl',
  'server.authkey',
  'mesh.up',
  'mesh.dns',
  'mesh.routes',
  'mesh.exitnode',
  'trust.cert',
  'firewall.ports',
  'relay.enroll',
  'reachability',
] as const;
export type NetworkSetupStepKind = (typeof NETWORK_SETUP_STEP_KINDS)[number];

/** Who carries a step out: a mesh CLI, the firewall, the OS package manager or the Hub itself. */
export const NETWORK_SETUP_STEP_PROVIDERS = [...MESH_PROVIDERS, 'ufw', 'os', 'hub'] as const;
export type NetworkSetupStepProvider = (typeof NETWORK_SETUP_STEP_PROVIDERS)[number];

/**
 * `pending` → `applied` (commands ran) → `verified`; `failed` when applying failed (what ran is
 * undone); `rolled_back` after an undo (by the owner or automatically when verification failed);
 * `rollback_failed` when an undo did not finish; `manual` is a step Nova can only describe;
 * `skipped` is already in place.
 */
export const NETWORK_SETUP_STEP_STATUSES = [
  'pending',
  'applied',
  'verified',
  'failed',
  'rolled_back',
  'rollback_failed',
  'manual',
  'skipped',
] as const;
export type NetworkSetupStepStatus = (typeof NETWORK_SETUP_STEP_STATUSES)[number];

export const NETWORK_SETUP_RUN_STATUSES = [
  'planned',
  'in_progress',
  'completed',
  'failed',
  'rolled_back',
] as const;
export type NetworkSetupRunStatus = (typeof NETWORK_SETUP_RUN_STATUSES)[number];

// ---- options (the owner's choices for a plan) --------------------------------------------------

const hostLabel = z
  .string()
  .min(1)
  .max(63)
  .regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/, 'lowercase letters, digits and hyphens');
const meshTag = z
  .string()
  .max(60)
  .regex(/^tag:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/, 'a tag like tag:nova-hub');
const cidr = z.union([z.cidrv4(), z.cidrv6()]);
const ip = z.union([z.ipv4(), z.ipv6()]);
const httpsOrHttpUrl = z
  .url({ protocol: /^https?$/ })
  .max(2000)
  .refine((u) => !/[\s'"`$\\]/.test(u), 'no quotes, spaces or backslashes');
/** A write-only secret the owner types (an auth key or setup key); moved to the vault. */
const writeOnlySecret = z
  .string()
  .min(8)
  .max(500)
  .regex(/^[\x21-\x7e]+$/, 'printable characters without spaces');
const wgKey = z.string().regex(/^[A-Za-z0-9+/]{42}[AEIMQUYcgkosw480]=$/, 'a WireGuard key');

export const networkSetupOptionsSchema = z
  .object({
    /** Headscale server URL, NetBird management URL, or a Tailscale-compatible control URL. */
    controlUrl: httpsOrHttpUrl.optional(),
    /** The Hub's name on the mesh (default `nova-hub`). */
    hostname: hostLabel.optional(),
    /**
     * A Tailscale auth key, a Headscale pre-auth key made elsewhere, or a NetBird setup key.
     * Write-only: stored in the vault, never returned.
     */
    authKey: writeOnlySecret.optional(),
    /** Plan installing the mesh client when it is missing (default true). */
    installClient: z.boolean().optional(),
    headscale: z
      .object({
        /** The Headscale user the Hub's node belongs to (default `nova`). */
        user: hostLabel.optional(),
        /** A remote Headscale's gRPC address (host:port); the CLI uses the local socket without it. */
        cliAddress: z
          .string()
          .max(300)
          .regex(/^[A-Za-z0-9.-]+:\d{1,5}$/, 'host:port')
          .optional(),
        /** The remote Headscale API key (write-only, vault). */
        apiKey: writeOnlySecret.optional(),
        /** Write a policy that lets the Hub's tag be reached by Nova devices (default true). */
        acl: z.boolean().optional(),
      })
      .strict()
      .optional(),
    /** Tags for the Hub's node (default `tag:nova-hub`). */
    tags: z.array(meshTag).max(10).optional(),
    /** MagicDNS names on the mesh (default true). */
    magicDns: z.boolean().optional(),
    /** Subnets the Hub advertises to the mesh (subnet routes). */
    advertiseRoutes: z.array(cidr).max(20).optional(),
    /** Offer the Hub as an exit node (default false). */
    exitNode: z.boolean().optional(),
    /** TLS: mesh certificates where the provider has them, else the Hub local CA (default auto). */
    certs: z.enum(['auto', 'mesh', 'local-ca', 'none']).optional(),
    /** Open the Hub's port on the mesh interface when ufw is present (default true). */
    firewall: z.boolean().optional(),
    /** Enroll the Hub with this Relay as a fallback path. */
    relay: z
      .object({
        url: z
          .url({ protocol: /^wss?$/ })
          .max(2000)
          // z.url accepts spaces and newlines in the path; they never belong in a Relay URL.
          .refine((u) => !/[\s'"`$\\]/.test(u), 'no quotes, spaces or backslashes'),
      })
      .strict()
      .optional(),
    wireguard: z
      .object({
        interface: z
          .string()
          .regex(/^[a-z][a-z0-9-]{0,14}$/, 'an interface name like wg-nova')
          .optional(),
        /** The Hub's address on the WireGuard network, e.g. 10.77.0.1/24. */
        address: cidr,
        listenPort: z.number().int().min(1024).max(65535).optional(),
        dns: z.array(ip).max(4).optional(),
        peers: z
          .array(
            z
              .object({
                name: hostLabel.optional(),
                publicKey: wgKey,
                allowedIps: z.array(cidr).min(1).max(20),
                endpoint: z
                  .string()
                  .max(300)
                  .regex(/^[A-Za-z0-9.:[\]-]+:\d{1,5}$/, 'host:port')
                  .optional(),
              })
              .strict(),
          )
          .max(50),
      })
      .strict()
      .optional(),
    /** Replace an existing login to another control server (the old login is not restored). */
    replaceExisting: z.boolean().optional(),
  })
  .strict();
export type NetworkSetupOptions = z.infer<typeof networkSetupOptionsSchema>;

// ---- requests ----------------------------------------------------------------------------------

/** The owner confirms a step by sending back its exact description (one-time consent). */
export const networkSetupConsentSchema = z
  .object({ stepId: idSchema, description: z.string().min(1).max(4000) })
  .strict();

/** `POST /api/v1/network/setup`: one assistant step (contracts/hub-api.md). */
export const networkSetupRequestSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('detect') }).strict(),
  z
    .object({
      action: z.literal('plan'),
      provider: meshProviderSchema,
      options: networkSetupOptionsSchema.optional(),
    })
    .strict(),
  z
    .object({
      action: z.literal('apply'),
      runId: idSchema,
      /** The step to apply; the next pending one when omitted. */
      stepId: idSchema.optional(),
      consent: networkSetupConsentSchema.optional(),
    })
    .strict(),
  z.object({ action: z.literal('verify'), runId: idSchema, stepId: idSchema.optional() }).strict(),
]);
export type NetworkSetupRequest = z.infer<typeof networkSetupRequestSchema>;

/** `POST /api/v1/network/setup/runs/:id/rollback`: the whole run, or its last applied step. */
export const networkSetupRollbackSchema = z.object({ stepId: idSchema.optional() }).strict();

// ---- views -------------------------------------------------------------------------------------

export interface MeshPeerView {
  name: string;
  dnsName: string | null;
  ips: string[];
  online: boolean;
  os: string | null;
  tags: string[];
}

/** One mesh provider as found on the Hub (docs/22 §6.1). */
export interface MeshDetectionView {
  provider: MeshProvider;
  installed: boolean;
  version: string | null;
  /** Logged in to a control plane (or, for WireGuard, the interface is up). */
  loggedIn: boolean;
  /** Provider state, e.g. `Running`, `NeedsLogin`, `Connected`. */
  state: string | null;
  controlUrl: string | null;
  /** This node's mesh addresses and MagicDNS name. */
  ips: string[];
  dnsName: string | null;
  tags: string[];
  peers: MeshPeerView[];
  /** Advertised subnet routes and whether it offers itself as an exit node. */
  routes: string[];
  exitNode: boolean;
  /** Why something is unknown (not installed, needs root, a CLI error). */
  detail: string | null;
}

export interface MeshAclSummary {
  provider: MeshProvider | null;
  /** Where the summary comes from: the Headscale policy, or nothing readable. */
  source: 'headscale-policy' | 'none';
  rules: number;
  groups: string[];
  tagOwners: string[];
  /** This node's tags. */
  tags: string[];
  detail: string | null;
}

export interface NetworkInterfaceView {
  name: string;
  kind: 'loopback' | 'lan' | 'mesh' | 'vpn' | 'other';
  provider: MeshProvider | null;
  addresses: { address: string; family: 'IPv4' | 'IPv6'; cidr: string | null }[];
}

export interface NetworkDetectionView {
  platform: string;
  interfaces: NetworkInterfaceView[];
  /** IPv4 subnets of the LAN interfaces, e.g. `192.168.1.0/24`. */
  subnets: string[];
  dns: { nameservers: string[]; search: string[]; source: string | null };
  meshes: MeshDetectionView[];
  firewall: { tool: 'ufw' | null; active: boolean | null; detail: string | null };
  packageManager: 'apt' | 'dnf' | 'brew' | 'winget' | null;
  /** The Hub's mesh URLs (offered to the endpoint registry as `mesh` candidates). */
  meshUrls: string[];
  detectedAt: string;
}

export interface NetworkSetupCheckView {
  name: string;
  ok: boolean;
  detail: string | null;
}

export interface NetworkSetupStepView {
  id: string;
  runId: string;
  index: number;
  kind: NetworkSetupStepKind;
  provider: NetworkSetupStepProvider;
  title: string;
  /** What the owner confirms, word for word, before the first change of this kind. */
  description: string;
  /** The commands it runs, as argument lists; secrets appear as `<secret>`. */
  commands: string[][];
  /** Undo commands planned from the snapshot (empty before applying). */
  undoCommands: string[][];
  /** Transports applying (or undoing) it could cut. */
  affects: NetworkSetupTransport[];
  undoAffects: NetworkSetupTransport[];
  /** Runs host commands: needs `network.setup.allowSystemChanges`. */
  systemChange: boolean;
  status: NetworkSetupStepStatus;
  consent: { required: boolean; remembered: boolean };
  checks: NetworkSetupCheckView[];
  error: string | null;
  autoRolledBack: boolean;
  appliedAt: string | null;
  verifiedAt: string | null;
  rolledBackAt: string | null;
}

export interface NetworkSetupRunView {
  id: string;
  provider: MeshProvider;
  status: NetworkSetupRunStatus;
  /** The options without secrets (`authKey` is shown as `stored`). */
  options: Record<string, unknown>;
  /** Public material the owner needs, e.g. the Hub's WireGuard public key. */
  outputs: Record<string, string>;
  steps: NetworkSetupStepView[];
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface NetworkSetupVerifyView {
  run: NetworkSetupRunView;
  ok: boolean;
  checks: NetworkSetupCheckView[];
}

export interface NetworkSetupConsentView {
  id: string;
  kind: NetworkSetupStepKind;
  provider: NetworkSetupStepProvider;
  description: string;
  grantedAt: string;
}
