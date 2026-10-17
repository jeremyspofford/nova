// Paths, words and pure helpers for the Network surface (docs/04 §9, docs/22; FR-134..FR-139):
// the sections and their addresses, what each transport, status and step kind is called, how a
// Hub refusal reads, the fallback log in sentences, guided fixes for problems (docs/22 §10) and
// how to install the Hub's root certificate on each platform. Statuses the Hub may add later fall
// back to a neutral chip with the raw word, never a crash.
import type { IconName } from '@nova/ui';
import type {
  NetworkChangeView,
  NetworkSetupRunView,
  NetworkSetupStepView,
  TransportEventView,
} from '@nova/shared';
import { ApiError, errorMessage } from '../api.ts';
import { plural } from '../settings/common.ts';

const enc = encodeURIComponent;

// ---- sections and paths ------------------------------------------------------------------------

export const NETWORK_SECTIONS = ['overview', 'setup', 'trust', 'relay', 'wake'] as const;
export type NetworkSection = (typeof NETWORK_SECTIONS)[number];

export const NETWORK_PATH = '/network';
/** The sandbox egress rules stay in Settings → Network (FR-193). */
export const EGRESS_SETTINGS_PATH = '/settings/network';
export const ADD_DEVICE_PATH = '/devices/add';

export const SECTION_INFO: Record<NetworkSection, { label: string; description: string }> = {
  overview: {
    label: 'Overview',
    description: 'Transports, what clients are told, problems and recent changes',
  },
  setup: { label: 'Setup', description: 'Set up a mesh: detect, plan, apply and roll back' },
  trust: { label: 'Trust', description: 'HTTPS: the Hub’s certificates and the root to install' },
  relay: {
    label: 'Relay',
    description: 'Reach the Hub from anywhere, and the clients paired to it',
  },
  wake: { label: 'Wake helpers', description: 'Devices that wake sleeping computers for the Hub' },
};

export function networkPath(section?: NetworkSection | null): string {
  return section ? `${NETWORK_PATH}/${section}` : NETWORK_PATH;
}

/** A setup run's page (`/network/setup?run=<id>`), or the assistant itself. */
export function setupRunPath(runId: string | null): string {
  return runId ? `${networkPath('setup')}?run=${enc(runId)}` : networkPath('setup');
}

/** The section a path segment names, or null (the first section on desktop, the menu on phones). */
export function sectionFrom(value: string | null | undefined): NetworkSection | null {
  return (NETWORK_SECTIONS as readonly string[]).includes(value ?? '')
    ? (value as NetworkSection)
    : null;
}

/** The run a `?run=` query names. */
export function runFrom(search: string): string | null {
  const v = new URLSearchParams(search).get('run');
  return v ? v : null;
}

// ---- chips -------------------------------------------------------------------------------------

export type ChipTone = 'ready' | 'running' | 'needs_input' | 'blocked' | 'neutral';

/** A chip's look: `icon: null` shows a spinner (something is in progress). */
export interface ChipSpec {
  text: string;
  tone: ChipTone;
  icon: IconName | null;
}

function lookup<K extends string>(table: Record<K, ChipSpec>, value: string): ChipSpec {
  return (
    (table as Record<string, ChipSpec | undefined>)[value] ?? {
      text: value.replace(/_/g, ' '),
      tone: 'neutral',
      icon: 'alert',
    }
  );
}

const TRANSPORT_STATUS: Record<string, ChipSpec> = {
  up: { text: 'Up', tone: 'ready', icon: 'check' },
  down: { text: 'Failing', tone: 'blocked', icon: 'alert' },
  off: { text: 'Off', tone: 'neutral', icon: 'stop' },
  none: { text: 'Nothing to advertise', tone: 'needs_input', icon: 'alert' },
};
export const transportStatusChip = (s: string) => lookup(TRANSPORT_STATUS, s);

const ENDPOINT_HEALTH: Record<string, ChipSpec> = {
  ok: { text: 'Advertised', tone: 'ready', icon: 'check' },
  failing: { text: 'Withdrawn', tone: 'blocked', icon: 'alert' },
  unknown: { text: 'Not tested yet', tone: 'neutral', icon: 'clock' },
};
export const endpointHealthChip = (s: string) => lookup(ENDPOINT_HEALTH, s);

const RELAY_STATE: Record<string, ChipSpec> = {
  disabled: { text: 'Off', tone: 'neutral', icon: 'stop' },
  unconfigured: { text: 'No Relay chosen', tone: 'needs_input', icon: 'alert' },
  registering: { text: 'Registering', tone: 'running', icon: null },
  connecting: { text: 'Connecting', tone: 'running', icon: null },
  connected: { text: 'Connected', tone: 'ready', icon: 'check' },
  error: { text: 'Error', tone: 'blocked', icon: 'alert' },
};
export const relayStateChip = (s: string) => lookup(RELAY_STATE, s);

const RELAY_CLIENT: Record<string, ChipSpec> = {
  pending: { text: 'Waiting for approval', tone: 'running', icon: 'clock' },
  active: { text: 'Active', tone: 'ready', icon: 'check' },
  denied: { text: 'Denied', tone: 'blocked', icon: 'stop' },
  revoked: { text: 'Revoked', tone: 'blocked', icon: 'stop' },
};
export const relayClientChip = (s: string) => lookup(RELAY_CLIENT, s);

const STEP_STATUS: Record<string, ChipSpec> = {
  pending: { text: 'Not applied', tone: 'neutral', icon: 'clock' },
  applied: { text: 'Applied, checking', tone: 'running', icon: null },
  verified: { text: 'Done', tone: 'ready', icon: 'check' },
  failed: { text: 'Failed', tone: 'blocked', icon: 'alert' },
  rolled_back: { text: 'Rolled back', tone: 'needs_input', icon: 'undo' },
  rollback_failed: { text: 'Undo failed', tone: 'blocked', icon: 'alert' },
  manual: { text: 'By hand', tone: 'neutral', icon: 'hand' },
  skipped: { text: 'Already in place', tone: 'ready', icon: 'check' },
};
export const stepStatusChip = (s: string) => lookup(STEP_STATUS, s);

const RUN_STATUS: Record<string, ChipSpec> = {
  planned: { text: 'Planned', tone: 'neutral', icon: 'clock' },
  in_progress: { text: 'In progress', tone: 'running', icon: 'activity' },
  completed: { text: 'Done', tone: 'ready', icon: 'check' },
  failed: { text: 'Failed', tone: 'blocked', icon: 'alert' },
  rolled_back: { text: 'Rolled back', tone: 'needs_input', icon: 'undo' },
};
export const runStatusChip = (s: string) => lookup(RUN_STATUS, s);

const MESH_CERT: Record<string, ChipSpec> = {
  ok: { text: 'Valid', tone: 'ready', icon: 'check' },
  expiring: { text: 'Expiring soon', tone: 'needs_input', icon: 'clock' },
  expired: { text: 'Expired', tone: 'blocked', icon: 'alert' },
};
export const meshCertChip = (s: string) => lookup(MESH_CERT, s);

const WAKE_STATUS: Record<string, ChipSpec> = {
  sent: { text: 'Sent', tone: 'ready', icon: 'check' },
  failed: { text: 'Failed', tone: 'blocked', icon: 'alert' },
  rate_limited: { text: 'Too many wakes', tone: 'needs_input', icon: 'clock' },
};
export const wakeStatusChip = (s: string) => lookup(WAKE_STATUS, s);

export function changeChip(c: Pick<NetworkChangeView, 'status' | 'error'>): ChipSpec {
  if (c.status === 'applied' && c.error)
    return { text: 'Rollback failed', tone: 'blocked', icon: 'alert' };
  if (c.status === 'applied') return { text: 'Applied', tone: 'ready', icon: 'check' };
  if (c.status === 'rolled_back') return { text: 'Rolled back', tone: 'neutral', icon: 'undo' };
  return lookup({}, c.status);
}

// ---- words -------------------------------------------------------------------------------------

export const TRANSPORT_LABEL: Record<string, string> = {
  lan: 'LAN',
  mesh: 'Mesh',
  relay: 'Relay',
  direct: 'Direct public',
};

export const transportLabel = (t: string | null | undefined): string =>
  t ? (TRANSPORT_LABEL[t] ?? t) : 'None';

export const TRANSPORT_HELP: Record<string, string> = {
  lan: 'Same network, by address or by the Hub’s .local name.',
  mesh: 'A private WireGuard mesh: Headscale, Tailscale, NetBird or plain WireGuard.',
  relay: 'A content-blind Relay that the Hub and its clients both connect out to.',
  direct: 'A public address, through port forwarding or a public host.',
};

/** "12 ms", or "–" when unknown. */
export function latencyText(ms: number | null | undefined): string {
  return typeof ms === 'number' && Number.isFinite(ms) ? `${Math.round(ms)} ms` : '–';
}

/** "23 of 24 checks passed today", or nothing to say yet. */
export function uptimeText(u: { checks: number; ok: number } | null | undefined): string | null {
  if (!u || u.checks === 0) return null;
  return `${u.ok} of ${plural(u.checks, 'check')} passed in the last 24 hours`;
}

export function actorText(actor: string): string {
  if (actor === 'user') return 'You';
  if (actor === 'system') return 'Nova';
  if (actor.startsWith('agent:')) return 'An agent';
  return actor;
}

const CHANGE_KIND: Record<string, string> = {
  'network.settings': 'Network settings',
  'trust.mode': 'Trust',
  'network.setup.step': 'Network setup',
};
export const changeKindLabel = (kind: string): string => CHANGE_KIND[kind] ?? kind;

/** The change one-click rollback reverts: the newest one still applied. */
export function lastApplied(changes: readonly NetworkChangeView[]): NetworkChangeView | null {
  return changes.find((c) => c.status === 'applied') ?? null;
}

// ---- the fallback log --------------------------------------------------------------------------

export interface EventLine {
  id: string;
  text: string;
  detail: string | null;
  createdAt: string;
  tone: 'good' | 'bad' | 'info';
}

/**
 * The transport events in sentences, newest first. A transport that failed its check and the new
 * primary it caused (one check, same time) read as one line: "LAN failed its check; Mesh is now
 * primary."
 */
export function eventLines(events: readonly TransportEventView[]): EventLine[] {
  const out: EventLine[] = [];
  const used = new Set<string>();
  for (const e of events) {
    if (used.has(e.id)) continue;
    const t = transportLabel(e.transport);
    if (e.kind === 'primary') {
      const down = events.find(
        (d) =>
          !used.has(d.id) &&
          (d.kind === 'down' || d.kind === 'off') &&
          d.createdAt === e.createdAt &&
          d.transport !== null &&
          d.transport === e.fromTransport,
      );
      const next = e.transport
        ? `${t} is now primary`
        : 'no transport passes its check, so clients are told nothing';
      if (down) {
        used.add(down.id);
        out.push({
          id: e.id,
          text:
            down.kind === 'off'
              ? `${transportLabel(down.transport)} was turned off; ${next}.`
              : `${transportLabel(down.transport)} failed its check; ${next}.`,
          detail: down.detail,
          createdAt: e.createdAt,
          tone: e.transport ? 'info' : 'bad',
        });
      } else {
        out.push({
          id: e.id,
          text: e.transport
            ? `${t} is now primary${e.fromTransport ? ` (was ${transportLabel(e.fromTransport)})` : ''}.`
            : `No transport passes its check, so clients are told nothing.`,
          detail: e.transport ? null : e.detail,
          createdAt: e.createdAt,
          tone: e.transport ? 'info' : 'bad',
        });
      }
      continue;
    }
    const where = e.url ?? t;
    const line = (text: string, tone: EventLine['tone'], detail: string | null = null) =>
      out.push({ id: e.id, text, detail, createdAt: e.createdAt, tone });
    switch (e.kind) {
      case 'advertised':
        line(`Advertised ${where} (${t}).`, 'good');
        break;
      case 'withdrawn':
        line(`Stopped advertising ${where} (${t}).`, 'bad', e.detail);
        break;
      case 'up':
        line(`${t} passes its check again.`, 'good');
        break;
      case 'down':
        line(`${t} failed its check.`, 'bad', e.detail);
        break;
      case 'off':
        line(`${t} was turned off.`, 'info');
        break;
      default:
        line(`${t}: ${String(e.kind).replace(/_/g, ' ')}.`, 'info', e.detail);
    }
  }
  return out;
}

// ---- problems and their guided fixes (docs/22 §10) -----------------------------------------------

export type FixAction = 'test' | 'rollback' | 'setup' | 'trust' | 'relay' | 'settings';

export interface ProblemGuide {
  /** What is wrong, as the Hub said it. */
  text: string;
  /** What it means for clients and what to do, in plain words. */
  fix: string;
  actions: FixAction[];
}

/** Capital first letter, except where the text starts with an address (`https://…`). */
const capitalize = (s: string) =>
  !s || /^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : s[0]!.toUpperCase() + s.slice(1);

/** A Hub problem line with the fix for it. Unknown problems keep their text and offer a test. */
export function guideFor(problem: string): ProblemGuide {
  const text = capitalize(problem.trim());
  const rest = (prefix: string) => capitalize(text.slice(prefix.length).trim());
  if (/^LAN:/i.test(text))
    return {
      text: `LAN: ${rest('LAN:')}`,
      fix: 'Clients on this network use the mesh instead, or the Relay. Check that the Hub is still connected to this network, then test again.',
      actions: ['test'],
    };
  if (/^Mesh:/i.test(text))
    return {
      text: `Mesh: ${rest('Mesh:')}`,
      fix: 'Clients use the LAN instead, or the Relay when they are away. Check that the mesh client on the Hub is running and signed in (Setup shows what Nova finds). If it started after a change to access rules, roll that change back.',
      actions: ['test', 'setup', 'rollback'],
    };
  if (/^Relay:/i.test(text))
    return {
      text: `Relay: ${rest('Relay:')}`,
      fix: 'The LAN and the mesh keep working. Phones away from home lose background wake until the Relay reconnects. Test the Relay to see what it answers.',
      actions: ['relay'],
    };
  if (/^Direct public:/i.test(text))
    return {
      text: `Direct public: ${rest('Direct public:')}`,
      fix: 'Check the port forwarding or the public host, and that the public URL is right. Nova does not advertise it until it passes.',
      actions: ['test', 'settings'],
    };
  if (/^Trust:/i.test(text)) {
    const p = rest('Trust:');
    return {
      text: `Certificates: ${p}`,
      fix: /expired/i.test(p)
        ? 'Native apps warn about an expired certificate. Mesh certificates renew on their own; with the local CA, renew it and install the root again on devices that ask.'
        : /expires|expiring/i.test(p)
          ? 'It renews on its own before it expires. If it does not, renew it in Trust.'
          : /restart/i.test(p)
            ? 'The new trust mode applies when the Hub next starts.'
            : 'Open Trust to see the certificates and fix it.',
      actions: ['trust'],
    };
  }
  if (/^No endpoint passes/i.test(text))
    return {
      text,
      fix: 'Clients cannot find the Hub on any path. If this started after a change, roll it back; otherwise check the Hub’s network connection and test again.',
      actions: ['rollback', 'test'],
    };
  if (/has not reported where it listens/i.test(text))
    return {
      text,
      fix: 'The Hub is still starting. If this lasts more than a minute, restart the Hub.',
      actions: [],
    };
  return { text, fix: 'Test again once you have checked it.', actions: ['test'] };
}

// ---- Network Setup (FR-136, docs/22 §6) ---------------------------------------------------------

export const PROVIDER_INFO: Record<string, { label: string; tag: string; help: string }> = {
  headscale: {
    label: 'Headscale',
    tag: 'Self-hosted, recommended',
    help: 'Your own control server. Computers join it with the Tailscale client. The Tailscale apps for iPhone and iPad cannot use your own server, so those reach the Hub through the Relay (or choose NetBird).',
  },
  tailscale: {
    label: 'Tailscale',
    tag: 'Managed, easiest on phones',
    help: 'A hosted control plane: the simplest way for phones and laptops to reach the Hub from anywhere. Needs a Tailscale account and an auth key.',
  },
  netbird: {
    label: 'NetBird',
    tag: 'Self-hosted, with phone apps',
    help: 'A control plane you can run yourself, with apps for iPhone and Android: the self-hosted choice when phones must join the mesh. Needs a setup key.',
  },
  wireguard: {
    label: 'WireGuard',
    tag: 'Plain tunnels',
    help: 'WireGuard without a control plane: you add each peer and its key yourself. Small and simple, with no names or access rules.',
  },
};
export const providerLabel = (p: string): string => PROVIDER_INFO[p]?.label ?? p;

export const STEP_KIND_LABEL: Record<string, string> = {
  'client.install': 'Install the mesh client',
  'server.user': 'Mesh server user',
  'server.acl': 'Access rules',
  'server.authkey': 'Join key',
  'mesh.up': 'Join the mesh',
  'mesh.dns': 'Mesh names',
  'mesh.routes': 'Subnet routes',
  'mesh.exitnode': 'Exit node',
  'trust.cert': 'Certificates',
  'firewall.ports': 'Firewall',
  'relay.enroll': 'Relay',
  reachability: 'Reachability test',
};
export const stepKindLabel = (k: string): string => STEP_KIND_LABEL[k] ?? k;

const STEP_PROVIDER: Record<string, string> = {
  ufw: 'ufw',
  os: 'the package manager',
  hub: 'Nova',
};
export const stepProviderLabel = (p: string): string => STEP_PROVIDER[p] ?? providerLabel(p);

/** "LAN and Mesh", or null when nothing. */
export function transportsText(list: readonly string[]): string | null {
  if (!list.length) return null;
  const names = list.map(transportLabel);
  return names.length === 1
    ? names[0]!
    : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]!}`;
}

/** A command as one line, each argument quoted when it needs to be. */
export function commandText(argv: readonly string[]): string {
  return argv
    .map((a) => (/^[\w@%+=:,./<>-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`))
    .join(' ');
}

const APPLYABLE = new Set(['pending', 'failed', 'rolled_back']);
const DONE = new Set(['verified', 'manual', 'skipped']);

/**
 * The step the run waits on: the first one (in order) that is not done. It can be applied when it
 * is pending, failed or rolled back; an applied or rollback-failed step must be verified or
 * rolled back first.
 */
export function nextStep(run: Pick<NetworkSetupRunView, 'steps'>): NetworkSetupStepView | null {
  const ordered = [...run.steps].sort((a, b) => a.index - b.index);
  return ordered.find((s) => !DONE.has(s.status)) ?? null;
}

export function canApply(step: NetworkSetupStepView): boolean {
  return APPLYABLE.has(step.status);
}

/** A test only (the closing reachability step): no consent, nothing to roll back. */
export function isCheckStep(step: Pick<NetworkSetupStepView, 'kind' | 'consent'>): boolean {
  return step.kind === 'reachability' || !step.consent.required;
}

/** Steps a rollback would undo, newest first (what the Hub undoes). */
export function undoableSteps(run: Pick<NetworkSetupRunView, 'steps'>): NetworkSetupStepView[] {
  return run.steps
    .filter((s) => ['applied', 'verified', 'rollback_failed'].includes(s.status))
    .filter((s) => !isCheckStep(s))
    .sort((a, b) => b.index - a.index);
}

/** "3 of 7 steps done". */
export function progressText(run: Pick<NetworkSetupRunView, 'steps'>): string {
  const done = run.steps.filter((s) => DONE.has(s.status)).length;
  return `${done} of ${plural(run.steps.length, 'step')} done`;
}

/** An option value as the run stores it, in words (secrets are only ever "stored"). */
export function optionText(value: unknown): string {
  if (value === 'stored') return 'Stored in the vault';
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (Array.isArray(value)) return value.length ? value.map(optionText).join(', ') : 'None';
  if (value && typeof value === 'object')
    return Object.entries(value as Record<string, unknown>)
      .map(([k, v]) => `${k}: ${optionText(v)}`)
      .join('; ');
  if (typeof value === 'string') return value || 'None';
  if (typeof value === 'number' || typeof value === 'bigint') return String(value);
  return 'None';
}

// ---- trust (FR-134, docs/22 §5) ----------------------------------------------------------------

export const TRUST_MODE_INFO: Record<string, { label: string; description: string }> = {
  none: {
    label: 'None (plain HTTP)',
    description:
      'No certificate. Browsers allow the camera, microphone, notifications and installing the app only on this computer.',
  },
  'local-ca': {
    label: 'Hub local CA',
    description:
      'The Hub makes its own certificate authority. Install its root on each device once. Fully private; best on the LAN.',
  },
  mesh: {
    label: 'Mesh certificates',
    description:
      'Real certificates from your mesh (for example a ts.net name). Nothing to install; best for phones and remote use.',
  },
};
export const trustModeLabel = (m: string): string => TRUST_MODE_INFO[m]?.label ?? m;

export const CERT_KIND_LABEL: Record<string, string> = {
  hub_tls: 'Hub certificate',
  device: 'Device',
  mesh: 'Mesh certificate',
};

/** How to trust the Hub's root on each platform, in Nova's own words (no vendor text). */
export const INSTALL_HINTS: { platform: string; file: 'pem' | 'crt'; steps: string[] }[] = [
  {
    platform: 'Windows',
    file: 'crt',
    steps: [
      'Open the .crt file and choose Install Certificate.',
      'Install it for the local machine, in the Trusted Root Certification Authorities store.',
      'Restart the browser.',
    ],
  },
  {
    platform: 'macOS',
    file: 'pem',
    steps: [
      'Open the .pem file to add it to Keychain Access, in the System keychain.',
      'Open the certificate there and set it to always trust.',
    ],
  },
  {
    platform: 'Linux',
    file: 'pem',
    steps: [
      'Debian and Ubuntu: copy the file to /usr/local/share/ca-certificates/ with a .crt name, then run sudo update-ca-certificates.',
      'Fedora: copy it to /etc/pki/ca-trust/source/anchors/, then run sudo update-ca-trust.',
      'Firefox keeps its own list: import the file as an authority in its certificate settings.',
    ],
  },
  {
    platform: 'iPhone and iPad',
    file: 'crt',
    steps: [
      'Open the .crt link in Safari and allow the download.',
      'Install the downloaded profile in Settings.',
      'Turn on full trust for it in the certificate trust settings (under About).',
    ],
  },
  {
    platform: 'Android',
    file: 'crt',
    steps: [
      'Download the .crt file.',
      'Install it as a CA certificate from the security or encryption settings (names differ by maker).',
    ],
  },
];

// ---- Hub refusals in words --------------------------------------------------------------------

const str = (v: unknown) => (typeof v === 'string' ? v : null);

/** A short, user-facing reason for a failed Network surface call. */
export function netErrorMessage(err: unknown, fallback = 'Something went wrong.'): string {
  if (!(err instanceof ApiError)) return errorMessage(err, fallback);
  const d = err.body.details ?? {};
  switch (str(d.reason) ?? err.body.code) {
    case 'nothing_to_roll_back':
      return 'There is nothing to roll back.';
    case 'rolled_back':
      return 'That change was already rolled back.';
    case 'no_undo_handler':
      return 'Nothing on this Hub can undo that kind of change.';
    case 'no_transport':
      return 'Keep at least one transport on, or clients cannot reach the Hub.';
    case 'url_required':
      return 'Set the public URL to advertise Direct public.';
    case 'unknown_device':
      return 'One of the chosen devices is not a Wake helper of this account.';
    case 'no_listener':
      return 'The Hub has not reported where it listens yet. Try again in a moment.';
    case 'settings_writer_missing':
      return 'The Hub cannot change network settings yet. Try again in a moment.';
    case 'system_changes_disabled':
      return 'Host changes are off, so Nova cannot run this. Turn on host changes first.';
    case 'consent_required':
      return 'Confirm this step first.';
    case 'would_lock_out':
      return `${capitalize(err.body.message)}. Connect another way (for example over the mesh or the Relay) and try again.`;
    case 'setup_busy':
      return 'Another setup step is running. Wait for it to finish.';
    case 'earlier_step_pending':
      return `${capitalize(err.body.message.replace(/"([^"]*)"/g, '“$1”'))}.`;
    case 'not_applicable':
      return 'This step is done by hand or is already in place.';
    case 'already_applied':
      return 'This step is already applied.';
    case 'nothing_to_apply':
      return 'Every step of this run is done.';
    case 'not_last_step':
      return 'Only the last applied step can be rolled back on its own. Roll back the whole run instead.';
    case 'not_applied':
      return 'Only an applied step can be checked.';
    case 'mesh_in_use':
      return `${capitalize(err.body.message)}.`;
    case 'trust_off':
      return 'Choose a trust path first: there is no certificate to renew.';
    case 'no_local_ca':
      return 'This Hub does not use its local CA, so it has no certificate of its own to renew.';
    case 'no_mesh_cert':
      return 'There is no mesh certificate to renew yet.';
    case 'managed':
      return 'Your organization manages this setting.';
    case 'not_found':
      return capitalize(err.body.message || fallback);
    default:
      return err.body.message ? `${capitalize(err.body.message).replace(/\.$/, '')}.` : fallback;
  }
}

/** The field a validation refusal names (`directPublic.url`, `options.authKey`…), if any. */
export function errorFields(err: unknown): Record<string, string> {
  if (!(err instanceof ApiError) || err.body.code !== 'validation') return {};
  const d = err.body.details ?? {};
  const out: Record<string, string> = {};
  const field = str(d.field);
  if (field) out[field] = netErrorMessage(err);
  if (Array.isArray(d.issues)) {
    for (const i of d.issues as unknown[]) {
      if (!i || typeof i !== 'object') continue;
      const p = str((i as { path?: unknown }).path);
      const m = str((i as { message?: unknown }).message);
      if (p !== null && m) out[p] ??= capitalize(m);
    }
  }
  return out;
}

/** The exact description a 403 `consent_required` asks the owner to confirm, and for which step. */
export function consentAsked(err: unknown): { stepId: string; description: string } | null {
  if (!(err instanceof ApiError)) return null;
  const d = err.body.details ?? {};
  if (d.reason !== 'consent_required') return null;
  const stepId = str(d.stepId);
  const description = str(d.description);
  return stepId && description ? { stepId, description } : null;
}

export function reasonOf(err: unknown): string | null {
  return err instanceof ApiError ? (str(err.body.details?.reason) ?? err.body.code) : null;
}
