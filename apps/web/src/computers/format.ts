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
import { defineMessages, fmt } from '@nova/i18n';

/** The computers and network views' shared words (FR-016). */
export const COMPUTERS_TEXT = defineMessages('computers', {
  kinds: {
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
  },
  substrates: {
    container: 'Container',
    micro_vm: 'Micro-VM',
    bwrap: 'OS sandbox (bubblewrap)',
    host: 'The device itself',
    cloud_stub: 'Cloud runner (mock on this Hub)',
  },
  noSandbox: 'No sandbox available',
  hubSandboxes: {
    container: 'Container',
    os_sandbox: 'OS sandbox',
    micro_vm: 'Micro-VM',
    cloud: 'Cloud runner',
    none: 'None',
  },
  states: {
    starting: 'Starting',
    running: 'Running',
    stopped: 'Stopped',
    degraded: 'Limited',
    error: 'Error',
  },
  title: {
    agent: "{agent}'s computer",
    device: 'Connected device',
    anAgent: "An agent's computer",
    plain: 'Computer',
  },
  sizeUnknown: 'Size unknown',
  megabytes: '{n} MB',
  gigabytes: '{n} GB',
  modes: {
    off: { label: 'Off', description: 'No network for sandboxes.' },
    allowlist: {
      label: 'Allowed hosts only',
      description:
        'Only the allowed hosts. A blocked host stays blocked even if it is also allowed.',
    },
    limited: {
      label: 'Read-only',
      description:
        'Allowed hosts, and only GET, HEAD and OPTIONS requests. HTTPS that cannot be inspected is blocked.',
    },
  },
  scopes: {
    agent: 'Agent',
    run: 'Work run',
    session: 'Code session',
    plugin: 'Plugin',
    mcp_server: 'MCP server',
    sandbox: 'Sandbox',
  },
  scope: 'Scope',
  causes: {
    allowlist: 'The host is not on the allowed list.',
    denylist: 'The host is on the blocked list.',
    method: 'Read-only access allows only GET, HEAD and OPTIONS requests.',
    private_address: 'The host is, or resolves to, a private, loopback or link-local address.',
    inspection: 'HTTPS that cannot be inspected is blocked with read-only access.',
    policy: 'Network access is off for this sandbox, or a rule blocks this request.',
  },
  schemes: {
    bearer: 'Bearer token',
    basicAs: 'Basic sign-in as {user}',
    basic: 'Basic sign-in (password only)',
    header: 'Header {header}',
    custom: 'Custom header',
  },
});
const S = COMPUTERS_TEXT;

export const COMPUTERS_PATH = '/computers';
/** Settings → Network (docs/12 §8), where the proxy's block page sends people. */
export const NETWORK_PATH = '/settings/network';

export function computerPath(id?: string | null): string {
  return id ? `${COMPUTERS_PATH}/${encodeURIComponent(id)}` : COMPUTERS_PATH;
}

export function agentPath(id: string): string {
  return `/agents/${encodeURIComponent(id)}`;
}

export const KIND_TEXT: Readonly<
  Record<ComputerKindView, { readonly label: string; readonly description: string }>
> = S.kinds;

/** Where its commands run, in words; null means no sandbox is available. */
export function substrateText(s: ComputerView['substrate']): string {
  return s ? S.substrates[s] : S.noSandbox;
}

/** The Hub's sandbox kinds as diagnostics names them. */
export function hubSandboxText(s: string | null): string {
  switch (s) {
    case 'container':
    case 'os_sandbox':
    case 'micro_vm':
    case 'cloud':
      return S.hubSandboxes[s];
    default:
      return S.hubSandboxes.none;
  }
}

const STATE_LOOK: Record<
  ComputerStateView,
  { icon: IconName; tone: 'ok' | 'warn' | 'danger' | null }
> = {
  starting: { icon: 'clock', tone: null },
  running: { icon: 'check', tone: 'ok' },
  stopped: { icon: 'stop', tone: null },
  degraded: { icon: 'alert', tone: 'warn' },
  error: { icon: 'alert', tone: 'danger' },
};

/** A computer state's words (read in the active locale), icon and tone. */
export function stateText(state: ComputerStateView): {
  label: string;
  icon: IconName;
  tone: 'ok' | 'warn' | 'danger' | null;
} {
  return { ...STATE_LOOK[state], label: S.states[state] };
}

/** A computer's title: its agent's, a device's, or a plain one. */
export function computerTitle(c: ComputerView, agentName: string | null): string {
  if (agentName) return S.title.agent({ agent: agentName });
  if (c.kind === 'local_host') return S.title.device;
  return c.agentId ? S.title.anAgent : S.title.plain;
}

export function formatBytes(n: number | null): string {
  if (n === null) return S.sizeUnknown;
  return fmt.bytes(n);
}

export function formatMemory(mb: number): string {
  return mb >= 1024 && mb % 1024 === 0 ? S.gigabytes({ n: mb / 1024 }) : S.megabytes({ n: mb });
}

/** A duration in whole seconds: "45 s", "2 min 5 s", "1 h". */
export function formatSeconds(s: number): string {
  return fmt.duration(s * 1000);
}

export function formatDateTime(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? iso
    : fmt.dateTime(d, {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      });
}

// ---- network --------------------------------------------------------------------------------

export const MODE_TEXT: Readonly<
  Record<EgressModeView, { readonly label: string; readonly description: string }>
> = S.modes;

/** Scope kinds a rule or a decision names (docs/11 §7); `sandbox` is a command without one. */
export const SCOPE_TEXT: Readonly<Record<string, string | undefined>> = S.scopes;

export function scopeKindText(kind: string): string {
  return SCOPE_TEXT[kind] ?? S.scope;
}

/** Why the proxy blocked a request, in plain words (the Hub's X-Nova-Block-Cause). */
export const CAUSE_TEXT: Readonly<Record<NonNullable<NetworkDecisionView['cause']>, string>> =
  S.causes;

export function causeText(d: Pick<NetworkDecisionView, 'decision' | 'cause'>): string | null {
  if (d.decision === 'allow') return null;
  return d.cause ? CAUSE_TEXT[d.cause] : CAUSE_TEXT.policy;
}

export function schemeText(c: Pick<EgressCredentialView, 'scheme' | 'header' | 'username'>) {
  if (c.scheme === 'bearer') return S.schemes.bearer;
  if (c.scheme === 'basic')
    return c.username ? S.schemes.basicAs({ user: c.username }) : S.schemes.basic;
  return c.header ? S.schemes.header({ header: c.header }) : S.schemes.custom;
}

/** Normalize a host entry the way the Hub does: lower case, no trailing dot. */
export function normalizeHost(h: string): string {
  return h.trim().toLowerCase().replace(/\.$/, '');
}
