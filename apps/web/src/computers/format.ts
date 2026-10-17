// Words for the computers and network views (docs/04 §7, docs/28): computer kinds, substrates and
// states, network access levels, scopes, credential schemes and why the proxy blocked a request.
import type {
  ComputerKindView,
  ComputerStateView,
  ComputerView,
  EgressCredentialView,
  EgressModeView,
  NetworkDecisionView,
} from '@nova/shared';
import type { IconName } from '@nova/ui';

export const COMPUTERS_PATH = '/computers';
/** Settings → Network (docs/12 §8), where the proxy's block page sends people. */
export const NETWORK_PATH = '/settings/network';

export function computerPath(id?: string | null): string {
  return id ? `${COMPUTERS_PATH}/${encodeURIComponent(id)}` : COMPUTERS_PATH;
}

export function agentPath(id: string): string {
  return `/agents/${encodeURIComponent(id)}`;
}

export const KIND_TEXT: Record<ComputerKindView, { label: string; description: string }> = {
  cloud: {
    label: 'Cloud computer',
    description: 'Keeps working while your devices are off.',
  },
  local_container: {
    label: 'Sandbox on this Hub',
    description: 'An isolated container or sandbox on the Hub.',
  },
  local_host: {
    label: 'Connected device',
    description: 'A device you connected, under its own sandbox.',
  },
};

const SUBSTRATE_TEXT: Record<NonNullable<ComputerView['substrate']>, string> = {
  container: 'Container',
  micro_vm: 'Micro-VM',
  bwrap: 'OS sandbox (bubblewrap)',
  host: 'The device itself',
  cloud_stub: 'Cloud runner (mock on this Hub)',
};

/** Where its commands run, in words; null means no sandbox is available. */
export function substrateText(s: ComputerView['substrate']): string {
  return s ? SUBSTRATE_TEXT[s] : 'No sandbox available';
}

/** The Hub's sandbox kinds as diagnostics names them. */
export function hubSandboxText(s: string | null): string {
  switch (s) {
    case 'container':
      return 'Container';
    case 'os_sandbox':
      return 'OS sandbox';
    case 'micro_vm':
      return 'Micro-VM';
    case 'cloud':
      return 'Cloud runner';
    default:
      return 'None';
  }
}

export const STATE_TEXT: Record<
  ComputerStateView,
  { label: string; icon: IconName; tone: 'ok' | 'warn' | 'danger' | null }
> = {
  starting: { label: 'Starting', icon: 'clock', tone: null },
  running: { label: 'Running', icon: 'check', tone: 'ok' },
  stopped: { label: 'Stopped', icon: 'stop', tone: null },
  degraded: { label: 'Limited', icon: 'alert', tone: 'warn' },
  error: { label: 'Error', icon: 'alert', tone: 'danger' },
};

/** A computer's title: its agent's, a device's, or a plain one. */
export function computerTitle(c: ComputerView, agentName: string | null): string {
  if (agentName) return `${agentName}'s computer`;
  if (c.kind === 'local_host') return 'Connected device';
  return c.agentId ? "An agent's computer" : 'Computer';
}

export function formatBytes(n: number | null): string {
  if (n === null) return 'Size unknown';
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 10 ? Math.round(v) : Math.round(v * 10) / 10} ${units[i] ?? 'TB'}`;
}

export function formatMemory(mb: number): string {
  return mb >= 1024 && mb % 1024 === 0 ? `${mb / 1024} GB` : `${mb} MB`;
}

export function formatSeconds(s: number): string {
  if (s < 60) return `${s} s`;
  if (s % 3600 === 0) return `${s / 3600} h`;
  if (s % 60 === 0) return `${s / 60} min`;
  return `${Math.floor(s / 60)} min ${s % 60} s`;
}

export function formatDateTime(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? iso
    : d.toLocaleString(undefined, {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      });
}

// ---- network --------------------------------------------------------------------------------

export const MODE_TEXT: Record<EgressModeView, { label: string; description: string }> = {
  off: { label: 'Off', description: 'No network for sandboxes.' },
  allowlist: {
    label: 'Allowed hosts only',
    description: 'Only the allowed hosts. A blocked host stays blocked even if it is also allowed.',
  },
  limited: {
    label: 'Read-only',
    description:
      'Allowed hosts, and only GET, HEAD and OPTIONS requests. HTTPS that cannot be inspected is blocked.',
  },
};

/** Scope kinds a rule or a decision names (docs/11 §7); `sandbox` is a command without one. */
export const SCOPE_TEXT: Record<string, string> = {
  agent: 'Agent',
  run: 'Work run',
  session: 'Code session',
  plugin: 'Plugin',
  mcp_server: 'MCP server',
  sandbox: 'Sandbox',
};

export function scopeKindText(kind: string): string {
  return SCOPE_TEXT[kind] ?? 'Scope';
}

/** Why the proxy blocked a request, in plain words (the Hub's X-Nova-Block-Cause). */
export const CAUSE_TEXT: Record<NonNullable<NetworkDecisionView['cause']>, string> = {
  allowlist: 'The host is not on the allowed list.',
  denylist: 'The host is on the blocked list.',
  method: 'Read-only access allows only GET, HEAD and OPTIONS requests.',
  private_address: 'The host is, or resolves to, a private, loopback or link-local address.',
  inspection: 'HTTPS that cannot be inspected is blocked with read-only access.',
  policy: 'Network access is off for this sandbox, or a rule blocks this request.',
};

export function causeText(d: Pick<NetworkDecisionView, 'decision' | 'cause'>): string | null {
  if (d.decision === 'allow') return null;
  return d.cause ? CAUSE_TEXT[d.cause] : CAUSE_TEXT.policy;
}

export function schemeText(c: Pick<EgressCredentialView, 'scheme' | 'header' | 'username'>) {
  if (c.scheme === 'bearer') return 'Bearer token';
  if (c.scheme === 'basic')
    return c.username ? `Basic sign-in as ${c.username}` : 'Basic sign-in (password only)';
  return c.header ? `Header ${c.header}` : 'Custom header';
}

/** Normalize a host entry the way the Hub does: lower case, no trailing dot. */
export function normalizeHost(h: string): string {
  return h.trim().toLowerCase().replace(/\.$/, '');
}
