// Paths, words and pure helpers for the Network surface (docs/04 §9, docs/22; FR-134..FR-139):
// the sections and their addresses, what each transport, status and step kind is called, how a
// Hub refusal reads, the fallback log in sentences, guided fixes for problems (docs/22 §10) and
// how to install the Hub's root certificate on each platform. Statuses the Hub may add later fall
// back to a neutral chip with the raw word, never a crash. The words are messages (FR-016), read
// when a screen renders.
import { defineMessages, fmt, messageFor } from '@nova/i18n';
import type { IconName } from '@nova/ui';
import type {
  NetworkChangeView,
  NetworkSetupRunView,
  NetworkSetupStepView,
  TransportEventView,
} from '@nova/shared';
import { ApiError, errorMessage } from '../api.ts';

const enc = encodeURIComponent;

export const NET_TEXT = defineMessages('netsurface', {
  section: {
    overview: {
      label: 'Overview',
      description: 'Transports, what clients are told, problems and recent changes',
    },
    setup: { label: 'Setup', description: 'Set up a mesh: detect, plan, apply and roll back' },
    trust: {
      label: 'Trust',
      description: 'HTTPS: the Hub’s certificates and the root to install',
    },
    relay: {
      label: 'Relay',
      description: 'Reach the Hub from anywhere, and the clients paired to it',
    },
    wake: {
      label: 'Wake helpers',
      description: 'Devices that wake sleeping computers for the Hub',
    },
  },
  chipDetail: '{text}: {detail}',
  transportStatus: { up: 'Up', down: 'Failing', off: 'Off', none: 'Nothing to advertise' },
  endpointHealth: { ok: 'Advertised', failing: 'Withdrawn', unknown: 'Not tested yet' },
  relayState: {
    disabled: 'Off',
    unconfigured: 'No Relay chosen',
    registering: 'Registering',
    connecting: 'Connecting',
    connected: 'Connected',
    error: 'Error',
  },
  relayClient: {
    pending: 'Waiting for approval',
    active: 'Active',
    denied: 'Denied',
    revoked: 'Revoked',
  },
  stepStatus: {
    pending: 'Not applied',
    applied: 'Applied, checking',
    verified: 'Done',
    failed: 'Failed',
    rolled_back: 'Rolled back',
    rollback_failed: 'Undo failed',
    manual: 'By hand',
    skipped: 'Already in place',
  },
  runStatus: {
    planned: 'Planned',
    in_progress: 'In progress',
    completed: 'Done',
    failed: 'Failed',
    rolled_back: 'Rolled back',
  },
  meshCert: { ok: 'Valid', expiring: 'Expiring soon', expired: 'Expired' },
  wakeStatus: { sent: 'Sent', failed: 'Failed', rate_limited: 'Too many wakes' },
  change: { rollbackFailed: 'Rollback failed', applied: 'Applied', rolledBack: 'Rolled back' },
  transport: { lan: 'LAN', mesh: 'Mesh', relay: 'Relay', direct: 'Direct public', none: 'None' },
  transportHelp: {
    lan: 'Same network, by address or by the Hub’s .local name.',
    mesh: 'A private WireGuard mesh: Headscale, Tailscale, NetBird or plain WireGuard.',
    relay: 'A content-blind Relay that the Hub and its clients both connect out to.',
    direct: 'A public address, through port forwarding or a public host.',
  },
  uptime: '{ok} of {checks, plural, one {# check} other {# checks}} passed in the last 24 hours',
  actor: { you: 'You', agent: 'An agent' },
  changeKind: { settings: 'Network settings', trust: 'Trust', setup: 'Network setup' },
  event: {
    nowPrimary: '{transport} is now primary.',
    nowPrimaryWas: '{transport} is now primary (was {was}).',
    nonePasses: 'No transport passes its check, so clients are told nothing.',
    failedNowPrimary: '{was} failed its check; {transport} is now primary.',
    offNowPrimary: '{was} was turned off; {transport} is now primary.',
    failedNonePasses:
      '{was} failed its check; no transport passes its check, so clients are told nothing.',
    offNonePasses:
      '{was} was turned off; no transport passes its check, so clients are told nothing.',
    advertised: 'Advertised {where} ({transport}).',
    withdrawn: 'Stopped advertising {where} ({transport}).',
    up: '{transport} passes its check again.',
    down: '{transport} failed its check.',
    off: '{transport} was turned off.',
    other: '{transport}: {kind}.',
  },
  problemLine: '{what}: {detail}',
  certificates: 'Certificates',
  fix: {
    lan: 'Clients on this network use the mesh instead, or the Relay. Check that the Hub is still connected to this network, then test again.',
    mesh:
      'Clients use the LAN instead, or the Relay when they are away. Check that the mesh client on the Hub is running and signed in (Setup shows what Nova finds). ' +
      'If it started after a change to access rules, roll that change back.',
    relay:
      'The LAN and the mesh keep working. Phones away from home lose background wake until the Relay reconnects. Test the Relay to see what it answers.',
    direct:
      'Check the port forwarding or the public host, and that the public URL is right. Nova does not advertise it until it passes.',
    certExpired:
      'Native apps warn about an expired certificate. Mesh certificates renew on their own; with the local CA, renew it and install the root again on devices that ask.',
    certExpiring: 'It renews on its own before it expires. If it does not, renew it in Trust.',
    certRestart: 'The new trust mode applies when the Hub next starts.',
    certOther: 'Open Trust to see the certificates and fix it.',
    noEndpoint:
      'Clients cannot find the Hub on any path. If this started after a change, roll it back; otherwise check the Hub’s network connection and test again.',
    noListener: 'The Hub is still starting. If this lasts more than a minute, restart the Hub.',
    other: 'Test again once you have checked it.',
  },
  provider: {
    headscale: {
      tag: 'Self-hosted, recommended',
      help: 'Your own control server. Computers join it with the Tailscale client. The Tailscale apps for iPhone and iPad cannot use your own server, so those reach the Hub through the Relay (or choose NetBird).',
    },
    tailscale: {
      tag: 'Managed, easiest on phones',
      help: 'A hosted control plane: the simplest way for phones and laptops to reach the Hub from anywhere. Needs a Tailscale account and an auth key.',
    },
    netbird: {
      tag: 'Self-hosted, with phone apps',
      help: 'A control plane you can run yourself, with apps for iPhone and Android: the self-hosted choice when phones must join the mesh. Needs a setup key.',
    },
    wireguard: {
      tag: 'Plain tunnels',
      help: 'WireGuard without a control plane: you add each peer and its key yourself. Small and simple, with no names or access rules.',
    },
  },
  stepKind: {
    clientInstall: 'Install the mesh client',
    serverUser: 'Mesh server user',
    serverAcl: 'Access rules',
    serverAuthkey: 'Join key',
    meshUp: 'Join the mesh',
    meshDns: 'Mesh names',
    meshRoutes: 'Subnet routes',
    meshExitnode: 'Exit node',
    trustCert: 'Certificates',
    firewallPorts: 'Firewall',
    relayEnroll: 'Relay',
    reachability: 'Reachability test',
  },
  packageManager: 'the package manager',
  progress: '{done} of {total, plural, one {# step} other {# steps}} done',
  runName: '{provider} setup',
  option: {
    stored: 'Stored in the vault',
    yes: 'Yes',
    no: 'No',
    none: 'None',
    pair: '{key}: {value}',
  },
  trustMode: {
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
  },
  certKind: { hub_tls: 'Hub certificate', device: 'Device', mesh: 'Mesh certificate' },
  install: {
    windows: {
      platform: 'Windows',
      open: 'Open the {file} file and choose Install Certificate.',
      store:
        'Install it for the local machine, in the Trusted Root Certification Authorities store.',
      restart: 'Restart the browser.',
    },
    macos: {
      platform: 'macOS',
      open: 'Open the {file} file to add it to Keychain Access, in the System keychain.',
      trust: 'Open the certificate there and set it to always trust.',
    },
    linux: {
      platform: 'Linux',
      debian: 'Debian and Ubuntu: copy the file to {folder} with a {ext} name, then run {command}.',
      fedora: 'Fedora: copy it to {folder}, then run {command}.',
      firefox:
        'Firefox keeps its own list: import the file as an authority in its certificate settings.',
    },
    ios: {
      platform: 'iPhone and iPad',
      open: 'Open the {file} link in Safari and allow the download.',
      profile: 'Install the downloaded profile in Settings.',
      trust: 'Turn on full trust for it in the certificate trust settings (under About).',
    },
    android: {
      platform: 'Android',
      download: 'Download the {file} file.',
      install:
        'Install it as a CA certificate from the security or encryption settings (names differ by maker).',
    },
  },
  error: {
    generic: 'Something went wrong.',
    wouldLockOut:
      '{message}. Connect another way (for example over the mesh or the Relay) and try again.',
    reason: {
      nothing_to_roll_back: 'There is nothing to roll back.',
      rolled_back: 'That change was already rolled back.',
      no_undo_handler: 'Nothing on this Hub can undo that kind of change.',
      no_transport: 'Keep at least one transport on, or clients cannot reach the Hub.',
      url_required: 'Set the public URL to advertise Direct public.',
      unknown_device: 'One of the chosen devices is not a Wake helper of this account.',
      no_listener: 'The Hub has not reported where it listens yet. Try again in a moment.',
      settings_writer_missing: 'The Hub cannot change network settings yet. Try again in a moment.',
      system_changes_disabled:
        'Host changes are off, so Nova cannot run this. Turn on host changes first.',
      consent_required: 'Confirm this step first.',
      setup_busy: 'Another setup step is running. Wait for it to finish.',
      not_applicable: 'This step is done by hand or is already in place.',
      already_applied: 'This step is already applied.',
      nothing_to_apply: 'Every step of this run is done.',
      not_last_step:
        'Only the last applied step can be rolled back on its own. Roll back the whole run instead.',
      not_applied: 'Only an applied step can be checked.',
      trust_off: 'Choose a trust path first: there is no certificate to renew.',
      no_local_ca:
        'This Hub does not use its local CA, so it has no certificate of its own to renew.',
      no_mesh_cert: 'There is no mesh certificate to renew yet.',
      managed: 'Your organization manages this setting.',
    },
  },
});

const S = NET_TEXT;

/** A nested message group under a runtime key (a Hub value), or undefined. */
function groupFor<T>(group: Readonly<Record<string, T>>, key: string): T | undefined {
  return Object.hasOwn(group, key) ? group[key] : undefined;
}

// ---- sections and paths ------------------------------------------------------------------------

export const NETWORK_SECTIONS = ['overview', 'setup', 'trust', 'relay', 'wake'] as const;
export type NetworkSection = (typeof NETWORK_SECTIONS)[number];

export const NETWORK_PATH = '/network';
/** The sandbox egress rules stay in Settings → Network (FR-193). */
export const EGRESS_SETTINGS_PATH = '/settings/network';
export const ADD_DEVICE_PATH = '/devices/add';

/** A section's name and what it holds, in the active locale. */
export const sectionInfo = (s: NetworkSection): { label: string; description: string } =>
  S.section[s];

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

/** A chip's look without its words (they are messages, read when it renders). */
type Look = Omit<ChipSpec, 'text'>;

function lookup(looks: Readonly<Record<string, Look>>, words: object, value: string): ChipSpec {
  const look = groupFor(looks, value);
  const text = messageFor(words, value);
  return look && text !== undefined
    ? { ...look, text }
    : { text: value.replace(/_/g, ' '), tone: 'neutral', icon: 'alert' };
}

const TRANSPORT_STATUS: Record<string, Look> = {
  up: { tone: 'ready', icon: 'check' },
  down: { tone: 'blocked', icon: 'alert' },
  off: { tone: 'neutral', icon: 'stop' },
  none: { tone: 'needs_input', icon: 'alert' },
};
export const transportStatusChip = (s: string) => lookup(TRANSPORT_STATUS, S.transportStatus, s);

const ENDPOINT_HEALTH: Record<string, Look> = {
  ok: { tone: 'ready', icon: 'check' },
  failing: { tone: 'blocked', icon: 'alert' },
  unknown: { tone: 'neutral', icon: 'clock' },
};
export const endpointHealthChip = (s: string) => lookup(ENDPOINT_HEALTH, S.endpointHealth, s);

const RELAY_STATE: Record<string, Look> = {
  disabled: { tone: 'neutral', icon: 'stop' },
  unconfigured: { tone: 'needs_input', icon: 'alert' },
  registering: { tone: 'running', icon: null },
  connecting: { tone: 'running', icon: null },
  connected: { tone: 'ready', icon: 'check' },
  error: { tone: 'blocked', icon: 'alert' },
};
export const relayStateChip = (s: string) => lookup(RELAY_STATE, S.relayState, s);

const RELAY_CLIENT: Record<string, Look> = {
  pending: { tone: 'running', icon: 'clock' },
  active: { tone: 'ready', icon: 'check' },
  denied: { tone: 'blocked', icon: 'stop' },
  revoked: { tone: 'blocked', icon: 'stop' },
};
export const relayClientChip = (s: string) => lookup(RELAY_CLIENT, S.relayClient, s);

const STEP_STATUS: Record<string, Look> = {
  pending: { tone: 'neutral', icon: 'clock' },
  applied: { tone: 'running', icon: null },
  verified: { tone: 'ready', icon: 'check' },
  failed: { tone: 'blocked', icon: 'alert' },
  rolled_back: { tone: 'needs_input', icon: 'undo' },
  rollback_failed: { tone: 'blocked', icon: 'alert' },
  manual: { tone: 'neutral', icon: 'hand' },
  skipped: { tone: 'ready', icon: 'check' },
};
export const stepStatusChip = (s: string) => lookup(STEP_STATUS, S.stepStatus, s);

const RUN_STATUS: Record<string, Look> = {
  planned: { tone: 'neutral', icon: 'clock' },
  in_progress: { tone: 'running', icon: 'activity' },
  completed: { tone: 'ready', icon: 'check' },
  failed: { tone: 'blocked', icon: 'alert' },
  rolled_back: { tone: 'needs_input', icon: 'undo' },
};
export const runStatusChip = (s: string) => lookup(RUN_STATUS, S.runStatus, s);

const MESH_CERT: Record<string, Look> = {
  ok: { tone: 'ready', icon: 'check' },
  expiring: { tone: 'needs_input', icon: 'clock' },
  expired: { tone: 'blocked', icon: 'alert' },
};
export const meshCertChip = (s: string) => lookup(MESH_CERT, S.meshCert, s);

const WAKE_STATUS: Record<string, Look> = {
  sent: { tone: 'ready', icon: 'check' },
  failed: { tone: 'blocked', icon: 'alert' },
  rate_limited: { tone: 'needs_input', icon: 'clock' },
};
export const wakeStatusChip = (s: string) => lookup(WAKE_STATUS, S.wakeStatus, s);

export function changeChip(c: Pick<NetworkChangeView, 'status' | 'error'>): ChipSpec {
  if (c.status === 'applied' && c.error)
    return { text: S.change.rollbackFailed, tone: 'blocked', icon: 'alert' };
  if (c.status === 'applied') return { text: S.change.applied, tone: 'ready', icon: 'check' };
  if (c.status === 'rolled_back')
    return { text: S.change.rolledBack, tone: 'neutral', icon: 'undo' };
  return lookup({}, {}, c.status);
}

// ---- words -------------------------------------------------------------------------------------

/** A transport's name ("LAN", "Direct public"); a transport the Hub adds later keeps its id. */
export const transportLabel = (t: string | null | undefined): string =>
  t ? (messageFor(S.transport, t) ?? t) : S.transport.none;

/** What a transport is, in a sentence. */
export const transportHelp = (t: string): string => messageFor(S.transportHelp, t) ?? '';

/** "12 ms", or "–" when unknown. */
export function latencyText(ms: number | null | undefined): string {
  return typeof ms === 'number' && Number.isFinite(ms) ? fmt.duration(ms) : '–';
}

/** "23 of 24 checks passed in the last 24 hours", or nothing to say yet. */
export function uptimeText(u: { checks: number; ok: number } | null | undefined): string | null {
  if (!u || u.checks === 0) return null;
  return S.uptime({ ok: u.ok, checks: u.checks });
}

export function actorText(actor: string): string {
  if (actor === 'user') return S.actor.you;
  if (actor === 'system') return 'Nova';
  if (actor.startsWith('agent:')) return S.actor.agent;
  return actor;
}

const CHANGE_KIND: Record<string, keyof typeof S.changeKind> = {
  'network.settings': 'settings',
  'trust.mode': 'trust',
  'network.setup.step': 'setup',
};
export const changeKindLabel = (kind: string): string => {
  const key = groupFor(CHANGE_KIND, kind);
  return key ? S.changeKind[key] : kind;
};

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
      if (down) {
        used.add(down.id);
        const was = transportLabel(down.transport);
        const off = down.kind === 'off';
        out.push({
          id: e.id,
          text: e.transport
            ? off
              ? S.event.offNowPrimary({ was, transport: t })
              : S.event.failedNowPrimary({ was, transport: t })
            : off
              ? S.event.offNonePasses({ was })
              : S.event.failedNonePasses({ was }),
          detail: down.detail,
          createdAt: e.createdAt,
          tone: e.transport ? 'info' : 'bad',
        });
      } else {
        out.push({
          id: e.id,
          text: !e.transport
            ? S.event.nonePasses
            : e.fromTransport
              ? S.event.nowPrimaryWas({ transport: t, was: transportLabel(e.fromTransport) })
              : S.event.nowPrimary({ transport: t }),
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
        line(S.event.advertised({ where, transport: t }), 'good');
        break;
      case 'withdrawn':
        line(S.event.withdrawn({ where, transport: t }), 'bad', e.detail);
        break;
      case 'up':
        line(S.event.up({ transport: t }), 'good');
        break;
      case 'down':
        line(S.event.down({ transport: t }), 'bad', e.detail);
        break;
      case 'off':
        line(S.event.off({ transport: t }), 'info');
        break;
      default:
        line(
          S.event.other({ transport: t, kind: String(e.kind).replace(/_/g, ' ') }),
          'info',
          e.detail,
        );
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

/**
 * A Hub problem line with the fix for it. Unknown problems keep their text and offer a test. The
 * Hub's words stay as it wrote them (D9); the transport that starts the line is named in the
 * active locale.
 */
export function guideFor(problem: string): ProblemGuide {
  const text = capitalize(problem.trim());
  const line = (what: string, prefix: string) =>
    S.problemLine({ what, detail: capitalize(text.slice(prefix.length).trim()) });
  if (/^LAN:/i.test(text))
    return { text: line(S.transport.lan, 'LAN:'), fix: S.fix.lan, actions: ['test'] };
  if (/^Mesh:/i.test(text))
    return {
      text: line(S.transport.mesh, 'Mesh:'),
      fix: S.fix.mesh,
      actions: ['test', 'setup', 'rollback'],
    };
  if (/^Relay:/i.test(text))
    return { text: line(S.transport.relay, 'Relay:'), fix: S.fix.relay, actions: ['relay'] };
  if (/^Direct public:/i.test(text))
    return {
      text: line(S.transport.direct, 'Direct public:'),
      fix: S.fix.direct,
      actions: ['test', 'settings'],
    };
  if (/^Trust:/i.test(text)) {
    const p = capitalize(text.slice('Trust:'.length).trim());
    return {
      text: S.problemLine({ what: S.certificates, detail: p }),
      fix: /expired/i.test(p)
        ? S.fix.certExpired
        : /expires|expiring/i.test(p)
          ? S.fix.certExpiring
          : /restart/i.test(p)
            ? S.fix.certRestart
            : S.fix.certOther,
      actions: ['trust'],
    };
  }
  if (/^No endpoint passes/i.test(text))
    return { text, fix: S.fix.noEndpoint, actions: ['rollback', 'test'] };
  if (/has not reported where it listens/i.test(text))
    return { text, fix: S.fix.noListener, actions: [] };
  return { text, fix: S.fix.other, actions: ['test'] };
}

// ---- Network Setup (FR-136, docs/22 §6) ---------------------------------------------------------

/** The mesh products by name (names, not words to translate). */
const PROVIDER_NAME: Record<string, string> = {
  headscale: 'Headscale',
  tailscale: 'Tailscale',
  netbird: 'NetBird',
  wireguard: 'WireGuard',
};
export const providerLabel = (p: string): string => groupFor(PROVIDER_NAME, p) ?? p;

/** What a mesh product is and when to choose it, or null for one this page does not know. */
export const providerInfo = (p: string): { tag: string; help: string } | null =>
  groupFor(S.provider, p) ?? null;

const STEP_KIND: Record<string, keyof typeof S.stepKind> = {
  'client.install': 'clientInstall',
  'server.user': 'serverUser',
  'server.acl': 'serverAcl',
  'server.authkey': 'serverAuthkey',
  'mesh.up': 'meshUp',
  'mesh.dns': 'meshDns',
  'mesh.routes': 'meshRoutes',
  'mesh.exitnode': 'meshExitnode',
  'trust.cert': 'trustCert',
  'firewall.ports': 'firewallPorts',
  'relay.enroll': 'relayEnroll',
  reachability: 'reachability',
};
export const stepKindLabel = (k: string): string => {
  const key = groupFor(STEP_KIND, k);
  return key ? S.stepKind[key] : k;
};

export const stepProviderLabel = (p: string): string => {
  if (p === 'ufw') return 'ufw';
  if (p === 'os') return S.packageManager;
  if (p === 'hub') return 'Nova';
  return providerLabel(p);
};

/** "LAN and Mesh", or null when nothing. */
export function transportsText(list: readonly string[]): string | null {
  return list.length ? fmt.list(list.map(transportLabel)) : null;
}

/** Data values in a row ("a, b, c"), joined the locale's way. */
export const valuesText = (list: readonly string[]): string =>
  fmt.list(list, { type: 'unit', style: 'short' });

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

/** A setup run's name: "Tailscale setup". */
export const runName = (provider: string): string =>
  S.runName({ provider: providerLabel(provider) });

/** "3 of 7 steps done". */
export function progressText(run: Pick<NetworkSetupRunView, 'steps'>): string {
  const done = run.steps.filter((s) => DONE.has(s.status)).length;
  return S.progress({ done, total: run.steps.length });
}

/**
 * An option value as the run stores it, in words (secrets are only ever "stored"). Option names
 * are the Hub's field names, shown as they are.
 */
export function optionText(value: unknown): string {
  if (value === 'stored') return S.option.stored;
  if (typeof value === 'boolean') return value ? S.option.yes : S.option.no;
  if (Array.isArray(value)) return value.length ? valuesText(value.map(optionText)) : S.option.none;
  if (value && typeof value === 'object')
    return Object.entries(value as Record<string, unknown>)
      .map(([k, v]) => S.option.pair({ key: k, value: optionText(v) }))
      .join('; ');
  if (typeof value === 'string') return value || S.option.none;
  if (typeof value === 'number' || typeof value === 'bigint') return String(value);
  return S.option.none;
}

// ---- trust (FR-134, docs/22 §5) ----------------------------------------------------------------

/** A trust mode's name and what it means, or null for a mode this page does not know. */
export const trustModeInfo = (m: string): { label: string; description: string } | null =>
  groupFor(S.trustMode, m) ?? null;
export const trustModeLabel = (m: string): string => trustModeInfo(m)?.label ?? m;

export const certKindLabel = (k: string): string => messageFor(S.certKind, k) ?? k;

export interface InstallHint {
  id: string;
  platform: string;
  file: 'pem' | 'crt';
  steps: string[];
}

/** How to trust the Hub's root on each platform, in Nova's own words (no vendor text). */
export function installHints(): InstallHint[] {
  const h = S.install;
  return [
    {
      id: 'windows',
      platform: h.windows.platform,
      file: 'crt',
      steps: [h.windows.open({ file: '.crt' }), h.windows.store, h.windows.restart],
    },
    {
      id: 'macos',
      platform: h.macos.platform,
      file: 'pem',
      steps: [h.macos.open({ file: '.pem' }), h.macos.trust],
    },
    {
      id: 'linux',
      platform: h.linux.platform,
      file: 'pem',
      steps: [
        h.linux.debian({
          folder: '/usr/local/share/ca-certificates/',
          ext: '.crt',
          command: 'sudo update-ca-certificates',
        }),
        h.linux.fedora({
          folder: '/etc/pki/ca-trust/source/anchors/',
          command: 'sudo update-ca-trust',
        }),
        h.linux.firefox,
      ],
    },
    {
      id: 'ios',
      platform: h.ios.platform,
      file: 'crt',
      steps: [h.ios.open({ file: '.crt' }), h.ios.profile, h.ios.trust],
    },
    {
      id: 'android',
      platform: h.android.platform,
      file: 'crt',
      steps: [h.android.download({ file: '.crt' }), h.android.install],
    },
  ];
}

// ---- Hub refusals in words --------------------------------------------------------------------

const str = (v: unknown) => (typeof v === 'string' ? v : null);

/**
 * A short, user-facing reason for a failed Network surface call: the area's own words for the
 * reasons it knows; the Hub's message (English, D9) for the rest.
 */
export function netErrorMessage(err: unknown, fallback?: string): string {
  const otherwise = fallback ?? S.error.generic;
  if (!(err instanceof ApiError)) return errorMessage(err, otherwise);
  const d = err.body.details ?? {};
  const reason = str(d.reason) ?? err.body.code;
  switch (reason) {
    case 'would_lock_out':
      return S.error.wouldLockOut({ message: capitalize(err.body.message) });
    case 'earlier_step_pending':
      return `${capitalize(err.body.message.replace(/"([^"]*)"/g, '“$1”'))}.`;
    case 'mesh_in_use':
      return `${capitalize(err.body.message)}.`;
    case 'not_found':
      return capitalize(err.body.message || otherwise);
  }
  const known = messageFor(S.error.reason, reason);
  if (known !== undefined) return known;
  return err.body.message ? `${capitalize(err.body.message).replace(/\.$/, '')}.` : otherwise;
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
