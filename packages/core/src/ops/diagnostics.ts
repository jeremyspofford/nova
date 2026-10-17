// Assembles GET /diagnostics (FR-043, FR-118, FR-149 baseline): the Hub's own state plus the
// probes other areas register (MCP servers, the sandbox), with plain-language warnings for
// things the operator should fix. Probe results are untrusted shapes: anything unexpected is
// ignored rather than passed through.
import type { DiagnosticsSnapshot, McpStatus, SandboxSubstrate } from '@nova/shared';
import type { VolumeEncryption } from './volume.ts';

export interface DiagnosticsInput {
  version: string;
  uptimeSeconds: number;
  dataDir: string;
  blobsEncrypted: boolean;
  volume: VolumeEncryption;
  providers: { id: string; label: string; status: string }[];
  nodes: { id: string; name: string; status: string }[];
  /** `DiagnosticsRegistry.collect()`: probe name → result (or `{ error }`). */
  probes: Record<string, unknown>;
  secrets: { backend: 'keychain' | 'vault' | 'memory'; detail: string; warning: string | null };
  tls: boolean;
  host: string;
}

const MCP_STATUSES: readonly McpStatus[] = [
  'disabled',
  'starting',
  'connected',
  'error',
  'stopped',
];
const SUBSTRATES: readonly SandboxSubstrate[] = ['os_sandbox', 'container', 'micro_vm', 'cloud'];
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);

function mcpServers(probe: unknown): DiagnosticsSnapshot['mcp'] {
  const list = Array.isArray(probe) ? probe : isRec(probe) ? probe.servers : null;
  if (!Array.isArray(list)) return [];
  const out: DiagnosticsSnapshot['mcp'] = [];
  for (const s of list) {
    if (!isRec(s)) continue;
    const id = str(s.id);
    const status = MCP_STATUSES.find((x) => x === s.status);
    if (!id || !status) continue;
    out.push({ id, name: str(s.name) ?? id, status, lastError: str(s.lastError) });
  }
  return out;
}

function sandbox(probe: unknown): DiagnosticsSnapshot['sandbox'] | null {
  if (!isRec(probe) || 'error' in probe) return null;
  const substrate = SUBSTRATES.find((x) => x === probe.substrate) ?? null;
  const available = probe.available === true || probe.ok === true;
  return {
    substrate,
    available,
    detail: str(probe.detail) ?? (available ? 'ready' : 'unavailable'),
  };
}

export function buildDiagnostics(i: DiagnosticsInput): DiagnosticsSnapshot {
  const warnings: string[] = [];
  if (i.secrets.warning) warnings.push(i.secrets.warning);
  if (!i.blobsEncrypted)
    warnings.push(
      'Attachments and artifacts are stored unencrypted: the Hub data key is not loaded.',
    );
  if (i.volume === 'unencrypted')
    warnings.push(
      'The data directory is not on an encrypted volume, so the database and logs are unencrypted on disk. Turn on disk encryption (LUKS, FileVault or BitLocker).',
    );
  if (!i.tls && !LOOPBACK.has(i.host.toLowerCase()))
    warnings.push(
      `The Hub listens on ${i.host} without TLS. Keep it on a private network or set NOVA_TLS_CERT and NOVA_TLS_KEY.`,
    );
  for (const p of i.providers) {
    if (p.status !== 'active') warnings.push(`Provider ${p.label} needs attention (${p.status}).`);
  }
  for (const n of i.nodes) {
    if (n.status === 'unreachable') warnings.push(`Compute node ${n.name} is unreachable.`);
  }
  const mcp = mcpServers(i.probes.mcp);
  for (const s of mcp) {
    if (s.status === 'error') warnings.push(`MCP server ${s.name}: ${s.lastError ?? 'failed'}`);
  }
  const box = sandbox(i.probes.sandbox);
  if (box && !box.available)
    warnings.push(`No sandbox is available (${box.detail}); command tools are turned off.`);
  for (const [name, result] of Object.entries(i.probes)) {
    if (isRec(result) && typeof result.error === 'string')
      warnings.push(`The ${name} check failed: ${result.error}`);
  }
  return {
    hub: {
      version: i.version,
      uptimeSeconds: Math.round(i.uptimeSeconds),
      dataDir: i.dataDir,
      encryptedAtRest: { blobs: i.blobsEncrypted, volume: i.volume },
    },
    providers: i.providers,
    nodes: i.nodes,
    mcp,
    sandbox: box ?? { substrate: null, available: false, detail: 'No sandbox has been set up.' },
    secrets: { backend: i.secrets.backend, detail: i.secrets.detail },
    warnings,
    // Everything else other areas registered (memory consolidation, …), shown as-is.
    probes: Object.fromEntries(
      Object.entries(i.probes).filter(([name]) => name !== 'mcp' && name !== 'sandbox'),
    ),
  };
}
