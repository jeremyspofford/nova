// Choose a mesh and its options, then make a plan (FR-136; docs/22 §2.2, §6). The options are
// checked with the Hub's own schema before they are sent; auth, setup and API keys are write-only
// fields (sent once, kept in the Hub's vault, never shown again). Planning changes nothing.
import { useId, useState } from 'react';
import { defineMessages } from '@nova/i18n';
import {
  MESH_PROVIDERS,
  networkSetupOptionsSchema,
  type MeshProvider,
  type NetworkDetectionView,
  type NetworkSetupRunView,
} from '@nova/shared';
import { Button, RadioGroup, SelectField, Spinner, TextField, useToast } from '@nova/ui';
import { SwitchField } from '../settings/controls.tsx';
import { useAnnounce } from '../services.tsx';
import { useNetworkSurfaceApi, type NetworkSetupOptionsBody } from './api.ts';
import {
  errorFields,
  netErrorMessage,
  providerInfo,
  providerLabel,
  reasonOf,
  valuesText,
} from './format.ts';

const S = defineMessages('netsurface.plan', {
  cert: {
    auto: 'Mesh certificates when the mesh has them, else the Hub local CA',
    mesh: 'Mesh certificates',
    localCa: 'The Hub local CA',
    none: 'No certificate',
  },
  foundConnected: 'Found on this computer, connected.',
  foundNotConnected: 'Found on this computer, not connected.',
  wgAddressRequired: 'Enter the Hub’s address on the WireGuard network.',
  planReady: '{n, plural, one {Plan ready: # step.} other {Plan ready: # steps.}}',
  providerReady: '{provider} plan ready.',
  planFailed: 'Could not make a plan.',
  title: 'Set up a mesh',
  mesh: 'Mesh',
  providerOption: '{provider}: {tag}',
  meshHint:
    'On iPhone and iPad, a self-hosted mesh works only with NetBird; otherwise those reach the Hub through the Relay.',
  options: '{provider} options',
  headscale: {
    url: 'Headscale server URL',
    urlHint: 'Where your Headscale answers, for example {url}.',
    authKey: 'Pre-auth key (optional, write-only)',
    authKeyHint:
      "Leave empty and Nova makes a one-use key on the server. A key you enter goes to the Hub's vault and is never shown again.",
    user: 'Headscale user',
    userHint: "The user the Hub's node belongs to. Default: {user}.",
    acl: 'Write access rules for Nova',
    aclHelp: "Let Nova devices reach the Hub's tag. Existing rules are kept.",
  },
  tailscale: {
    authKey: 'Auth key (write-only)',
    authKeyHint:
      "Make one in your Tailscale admin console. It goes to the Hub's vault and is never shown again.",
    controlUrl: 'Control server URL (optional)',
    controlUrlHint: "Leave empty for Tailscale's own service.",
  },
  netbird: {
    url: 'Management URL (optional)',
    urlHint:
      "Your own NetBird management service, for example {url}. Leave empty for NetBird's hosted service.",
    setupKey: 'Setup key (write-only)',
    setupKeyHint: "It goes to the Hub's vault and is never shown again.",
  },
  hostname: 'Name on the mesh',
  defaultIs: 'Default: {value}.',
  certs: 'Certificates',
  more: 'More options',
  tags: 'Tags',
  tagsHint: 'Separated by commas, for example {tag} (the default).',
  routes: 'Subnet routes',
  routesHint: 'Networks the Hub shares with the mesh, separated by commas.',
  routesHintLan:
    "Networks the Hub shares with the mesh, separated by commas. This computer's LAN: {lan}.",
  magicDns: 'Mesh names (MagicDNS)',
  magicDnsHelp: 'Reach devices on the mesh by name.',
  exitNode: 'Offer the Hub as an exit node',
  exitNodeHelp: 'Other devices may send all their internet traffic through the Hub.',
  installClient: 'Install the mesh client if it is missing',
  replace: 'Replace an existing login',
  replaceHelp:
    'When the Hub is already signed in to another control server. The old login is not restored on rollback.',
  firewall: "Open the Hub's port in the firewall",
  firewallHelp: 'Adds allow rules in ufw when it is present. Nothing is denied or removed.',
  relay: 'Relay to enroll with (optional)',
  relayHint: 'A {scheme} address, as a fallback path.',
  hsRemote: 'Remote Headscale address (optional)',
  hsRemoteHint: 'host:port of a Headscale on another computer. Leave empty when it runs here.',
  hsApiKey: 'Remote Headscale API key (write-only)',
  hsApiKeyHint: "Needed with a remote address. It goes to the Hub's vault.",
  changesNothing:
    'Making a plan changes nothing. You apply each step yourself and can roll it back.',
  makePlan: 'Make a plan',
  wg: {
    address: "The Hub's address on the WireGuard network",
    addressHint: 'With its prefix, for example {example}.',
    iface: 'Interface',
    port: 'Listen port',
    portHint: 'UDP, 1024 to 65535.',
    dns: 'DNS servers (optional)',
    dnsHint: 'Separated by commas.',
    peers: 'Peers',
    peersHelp:
      "Each device that joins: its public key and the addresses it may use. Nova makes the Hub's own key and shows its public half after planning.",
    noPeers: 'No peers yet.',
    peer: 'Peer {n}',
    name: 'Name',
    publicKey: 'Public key',
    allowedIps: 'Allowed addresses',
    allowedIpsHint: 'For example {example}.',
    endpoint: 'Endpoint (optional)',
    endpointHint: 'host:port',
    removePeer: 'Remove peer {n}',
    remove: 'Remove',
    addPeer: 'Add a peer',
  },
});

interface Peer {
  key: number;
  name: string;
  publicKey: string;
  allowedIps: string;
  endpoint: string;
}

interface Form {
  controlUrl: string;
  authKey: string;
  hostname: string;
  tags: string;
  magicDns: boolean;
  advertiseRoutes: string;
  exitNode: boolean;
  certs: 'auto' | 'mesh' | 'local-ca' | 'none';
  firewall: boolean;
  installClient: boolean;
  relayUrl: string;
  replaceExisting: boolean;
  hsUser: string;
  hsCliAddress: string;
  hsApiKey: string;
  hsAcl: boolean;
  wgInterface: string;
  wgAddress: string;
  wgListenPort: string;
  wgDns: string;
  peers: Peer[];
}

const EMPTY: Form = {
  controlUrl: '',
  authKey: '',
  hostname: '',
  tags: '',
  magicDns: true,
  advertiseRoutes: '',
  exitNode: false,
  certs: 'auto',
  firewall: true,
  installClient: true,
  relayUrl: '',
  replaceExisting: false,
  hsUser: '',
  hsCliAddress: '',
  hsApiKey: '',
  hsAcl: true,
  wgInterface: '',
  wgAddress: '',
  wgListenPort: '',
  wgDns: '',
  peers: [],
};

const list = (s: string) =>
  s
    .split(/[\s,]+/)
    .map((x) => x.trim())
    .filter(Boolean);

/** The options body for a provider, with only what the owner filled in. */
export function optionsOf(provider: MeshProvider, f: Form): NetworkSetupOptionsBody {
  const o: NetworkSetupOptionsBody = {};
  const put = <K extends keyof NetworkSetupOptionsBody>(k: K, v: NetworkSetupOptionsBody[K]) => {
    if (v === undefined || v === '' || (Array.isArray(v) && v.length === 0)) return;
    o[k] = v;
  };
  if (provider !== 'wireguard') {
    put('controlUrl', f.controlUrl.trim());
    put('authKey', f.authKey.trim());
    put('hostname', f.hostname.trim());
    put('magicDns', f.magicDns);
    put('exitNode', f.exitNode);
    put('installClient', f.installClient);
    put('replaceExisting', f.replaceExisting || undefined);
  }
  if (provider === 'headscale' || provider === 'tailscale') put('tags', list(f.tags));
  put('advertiseRoutes', list(f.advertiseRoutes));
  put('certs', f.certs);
  put('firewall', f.firewall);
  if (f.relayUrl.trim()) o.relay = { url: f.relayUrl.trim() };
  if (provider === 'headscale') {
    const hs: NonNullable<NetworkSetupOptionsBody['headscale']> = { acl: f.hsAcl };
    if (f.hsUser.trim()) hs.user = f.hsUser.trim();
    if (f.hsCliAddress.trim()) hs.cliAddress = f.hsCliAddress.trim();
    if (f.hsApiKey.trim()) hs.apiKey = f.hsApiKey.trim();
    o.headscale = hs;
  }
  if (provider === 'wireguard') {
    const port = f.wgListenPort.trim();
    o.wireguard = {
      address: f.wgAddress.trim(),
      ...(f.wgInterface.trim() ? { interface: f.wgInterface.trim() } : {}),
      ...(port ? { listenPort: Number(port) } : {}),
      ...(list(f.wgDns).length ? { dns: list(f.wgDns) } : {}),
      peers: f.peers.map((p) => ({
        publicKey: p.publicKey.trim(),
        allowedIps: list(p.allowedIps),
        ...(p.name.trim() ? { name: p.name.trim() } : {}),
        ...(p.endpoint.trim() ? { endpoint: p.endpoint.trim() } : {}),
      })),
    };
  }
  return o;
}

/** The Hub's schema on the options: field path → message (`wireguard.peers.0.publicKey`…). */
export function checkOptions(options: NetworkSetupOptionsBody): Record<string, string> {
  const r = networkSetupOptionsSchema.safeParse(options);
  if (r.success) return {};
  const out: Record<string, string> = {};
  for (const i of r.error.issues) {
    const path = i.path.join('.');
    out[path] ??= i.message.charAt(0).toUpperCase() + i.message.slice(1);
  }
  return out;
}

/** A refusal reason that belongs to one field. */
const REASON_FIELD: Record<string, string> = {
  control_url_required: 'controlUrl',
  auth_key_required: 'authKey',
  api_key_required: 'headscale.apiKey',
  wireguard_options_required: 'wireguard.address',
  mesh_certs_unavailable: 'certs',
};

/** The certificate choices, in the active locale. */
const certOptions = () => [
  { value: 'auto', label: S.cert.auto },
  { value: 'mesh', label: S.cert.mesh },
  { value: 'local-ca', label: S.cert.localCa },
  { value: 'none', label: S.cert.none },
];

export function SetupPlan({
  detection,
  onPlanned,
}: {
  detection: NetworkDetectionView | null;
  onPlanned: (run: NetworkSetupRunView) => void;
}) {
  const api = useNetworkSurfaceApi();
  const toast = useToast();
  const announce = useAnnounce();
  const headingId = useId();
  const [provider, setProvider] = useState<MeshProvider | null>(null);
  const [f, setF] = useState<Form>(EMPTY);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (patch: Partial<Form>) => setF((prev) => ({ ...prev, ...patch }));
  const err = (key: string): string | undefined => {
    for (const [k, v] of Object.entries(errors)) if (k === key || k.startsWith(`${key}.`)) return v;
    return undefined;
  };

  const found = (p: MeshProvider) => detection?.meshes.find((m) => m.provider === p) ?? null;
  const describe = (p: MeshProvider) => {
    const m = found(p);
    const state = !m?.installed ? '' : m.loggedIn ? S.foundConnected : S.foundNotConnected;
    return [providerInfo(p)?.help ?? '', state].filter(Boolean).join(' ');
  };

  const plan = async () => {
    if (!provider) return;
    const options = optionsOf(provider, f);
    const local = checkOptions(options);
    if (provider === 'wireguard' && !f.wgAddress.trim())
      local['wireguard.address'] = S.wgAddressRequired;
    setErrors(local);
    setFailure(null);
    if (Object.keys(local).length) return;
    setBusy(true);
    try {
      const { run } = await api.planNetworkSetup(provider, options);
      // Secrets go to the Hub once; nothing keeps them here.
      set({ authKey: '', hsApiKey: '' });
      toast.show(S.planReady({ n: run.steps.length }), { tone: 'success' });
      announce(S.providerReady({ provider: providerLabel(provider) }));
      onPlanned(run);
    } catch (e) {
      const fields: Record<string, string> = {};
      for (const [k, v] of Object.entries(errorFields(e))) fields[k.replace(/^options\./, '')] = v;
      const reason = reasonOf(e);
      const field = reason ? REASON_FIELD[reason] : undefined;
      if (field) fields[field] = netErrorMessage(e);
      setErrors(fields);
      setFailure(field ? null : netErrorMessage(e, S.planFailed));
    } finally {
      setBusy(false);
    }
  };

  const p = provider;
  return (
    <section className="ws-section" aria-labelledby={headingId}>
      <h2 id={headingId}>{S.title}</h2>
      <RadioGroup
        legend={S.mesh}
        name="net-mesh-provider"
        value={provider ?? ''}
        className="net-providers"
        options={MESH_PROVIDERS.map((m) => ({
          value: m,
          label: S.providerOption({ provider: providerLabel(m), tag: providerInfo(m)?.tag ?? '' }),
          description: describe(m),
        }))}
        onChange={(v) => {
          const next = MESH_PROVIDERS.find((m) => m === v) ?? null;
          setProvider(next);
          setErrors({});
          setFailure(null);
        }}
        hint={S.meshHint}
      />
      {p ? (
        <form
          className="stack net-form"
          noValidate
          aria-label={S.options({ provider: providerLabel(p) })}
          onSubmit={(e) => {
            e.preventDefault();
            void plan();
          }}
        >
          {p === 'headscale' ? (
            <>
              <TextField
                label={S.headscale.url}
                hint={S.headscale.urlHint({ url: 'https://headscale.example.com' })}
                value={f.controlUrl}
                inputMode="url"
                autoComplete="off"
                onChange={(e) => set({ controlUrl: e.target.value })}
                error={err('controlUrl')}
              />
              <TextField
                label={S.headscale.authKey}
                hint={S.headscale.authKeyHint}
                type="password"
                autoComplete="off"
                value={f.authKey}
                onChange={(e) => set({ authKey: e.target.value })}
                error={err('authKey')}
              />
              <TextField
                label={S.headscale.user}
                hint={S.headscale.userHint({ user: 'nova' })}
                value={f.hsUser}
                autoComplete="off"
                onChange={(e) => set({ hsUser: e.target.value })}
                error={err('headscale.user')}
              />
              <SwitchField
                label={S.headscale.acl}
                description={S.headscale.aclHelp}
                checked={f.hsAcl}
                onChange={(v) => set({ hsAcl: v })}
              />
            </>
          ) : null}
          {p === 'tailscale' ? (
            <>
              <TextField
                label={S.tailscale.authKey}
                hint={S.tailscale.authKeyHint}
                type="password"
                autoComplete="off"
                value={f.authKey}
                onChange={(e) => set({ authKey: e.target.value })}
                error={err('authKey')}
              />
              <TextField
                label={S.tailscale.controlUrl}
                hint={S.tailscale.controlUrlHint}
                value={f.controlUrl}
                inputMode="url"
                autoComplete="off"
                onChange={(e) => set({ controlUrl: e.target.value })}
                error={err('controlUrl')}
              />
            </>
          ) : null}
          {p === 'netbird' ? (
            <>
              <TextField
                label={S.netbird.url}
                hint={S.netbird.urlHint({ url: 'https://netbird.example.com' })}
                value={f.controlUrl}
                inputMode="url"
                autoComplete="off"
                onChange={(e) => set({ controlUrl: e.target.value })}
                error={err('controlUrl')}
              />
              <TextField
                label={S.netbird.setupKey}
                hint={S.netbird.setupKeyHint}
                type="password"
                autoComplete="off"
                value={f.authKey}
                onChange={(e) => set({ authKey: e.target.value })}
                error={err('authKey')}
              />
            </>
          ) : null}
          {p === 'wireguard' ? <WireguardFields f={f} set={set} err={err} /> : null}
          {p !== 'wireguard' ? (
            <TextField
              label={S.hostname}
              hint={S.defaultIs({ value: 'nova-hub' })}
              value={f.hostname}
              autoComplete="off"
              spellCheck={false}
              onChange={(e) => set({ hostname: e.target.value })}
              error={err('hostname')}
            />
          ) : null}
          <SelectField
            label={S.certs}
            value={f.certs}
            options={certOptions()}
            onChange={(v) => set({ certs: v as Form['certs'] })}
            error={err('certs')}
          />
          <details className="ws-advanced">
            <summary>{S.more}</summary>
            <div className="stack">
              {p === 'headscale' || p === 'tailscale' ? (
                <TextField
                  label={S.tags}
                  hint={S.tagsHint({ tag: 'tag:nova-hub' })}
                  value={f.tags}
                  autoComplete="off"
                  spellCheck={false}
                  onChange={(e) => set({ tags: e.target.value })}
                  error={err('tags')}
                />
              ) : null}
              <TextField
                label={S.routes}
                hint={
                  detection?.subnets.length
                    ? S.routesHintLan({ lan: valuesText(detection.subnets) })
                    : S.routesHint
                }
                value={f.advertiseRoutes}
                autoComplete="off"
                spellCheck={false}
                onChange={(e) => set({ advertiseRoutes: e.target.value })}
                error={err('advertiseRoutes')}
              />
              {p !== 'wireguard' ? (
                <>
                  <SwitchField
                    label={S.magicDns}
                    description={S.magicDnsHelp}
                    checked={f.magicDns}
                    onChange={(v) => set({ magicDns: v })}
                  />
                  <SwitchField
                    label={S.exitNode}
                    description={S.exitNodeHelp}
                    checked={f.exitNode}
                    onChange={(v) => set({ exitNode: v })}
                  />
                  <SwitchField
                    label={S.installClient}
                    checked={f.installClient}
                    onChange={(v) => set({ installClient: v })}
                  />
                  <SwitchField
                    label={S.replace}
                    description={S.replaceHelp}
                    checked={f.replaceExisting}
                    onChange={(v) => set({ replaceExisting: v })}
                  />
                </>
              ) : null}
              <SwitchField
                label={S.firewall}
                description={S.firewallHelp}
                checked={f.firewall}
                onChange={(v) => set({ firewall: v })}
              />
              <TextField
                label={S.relay}
                hint={S.relayHint({ scheme: 'wss://' })}
                value={f.relayUrl}
                inputMode="url"
                autoComplete="off"
                onChange={(e) => set({ relayUrl: e.target.value })}
                error={err('relay')}
              />
              {p === 'headscale' ? (
                <>
                  <TextField
                    label={S.hsRemote}
                    hint={S.hsRemoteHint}
                    value={f.hsCliAddress}
                    autoComplete="off"
                    onChange={(e) => set({ hsCliAddress: e.target.value })}
                    error={err('headscale.cliAddress')}
                  />
                  <TextField
                    label={S.hsApiKey}
                    hint={S.hsApiKeyHint}
                    type="password"
                    autoComplete="off"
                    value={f.hsApiKey}
                    onChange={(e) => set({ hsApiKey: e.target.value })}
                    error={err('headscale.apiKey')}
                  />
                </>
              ) : null}
            </div>
          </details>
          {failure ? (
            <p role="alert" className="nv-field-error">
              {failure}
            </p>
          ) : null}
          <p className="muted ws-flush net-small">{S.changesNothing}</p>
          <div className="row">
            <Button type="submit" variant="primary" disabled={busy}>
              {busy ? <Spinner /> : null} {S.makePlan}
            </Button>
          </div>
        </form>
      ) : null}
    </section>
  );
}

function WireguardFields({
  f,
  set,
  err,
}: {
  f: Form;
  set: (patch: Partial<Form>) => void;
  err: (key: string) => string | undefined;
}) {
  const peer = (i: number, patch: Partial<Peer>) =>
    set({ peers: f.peers.map((p, j) => (j === i ? { ...p, ...patch } : p)) });
  return (
    <>
      <TextField
        label={S.wg.address}
        hint={S.wg.addressHint({ example: '10.77.0.1/24' })}
        value={f.wgAddress}
        autoComplete="off"
        spellCheck={false}
        onChange={(e) => set({ wgAddress: e.target.value })}
        error={err('wireguard.address')}
      />
      <div className="net-fields">
        <TextField
          label={S.wg.iface}
          hint={S.defaultIs({ value: 'wg-nova' })}
          value={f.wgInterface}
          autoComplete="off"
          onChange={(e) => set({ wgInterface: e.target.value })}
          error={err('wireguard.interface')}
        />
        <TextField
          label={S.wg.port}
          hint={S.wg.portHint}
          className="ws-number"
          type="number"
          min={1024}
          max={65535}
          inputMode="numeric"
          value={f.wgListenPort}
          onChange={(e) => set({ wgListenPort: e.target.value })}
          error={err('wireguard.listenPort')}
        />
      </div>
      <TextField
        label={S.wg.dns}
        hint={S.wg.dnsHint}
        value={f.wgDns}
        autoComplete="off"
        onChange={(e) => set({ wgDns: e.target.value })}
        error={err('wireguard.dns')}
      />
      <fieldset className="net-fieldset">
        <legend className="nv-field-label">{S.wg.peers}</legend>
        <p className="nv-field-hint">{S.wg.peersHelp}</p>
        {f.peers.length === 0 ? <p className="muted ws-flush">{S.wg.noPeers}</p> : null}
        {f.peers.map((p, i) => (
          <div key={p.key} className="net-peer" role="group" aria-label={S.wg.peer({ n: i + 1 })}>
            <TextField
              label={S.wg.name}
              value={p.name}
              autoComplete="off"
              onChange={(e) => peer(i, { name: e.target.value })}
              error={err(`wireguard.peers.${i}.name`)}
            />
            <TextField
              label={S.wg.publicKey}
              value={p.publicKey}
              autoComplete="off"
              spellCheck={false}
              onChange={(e) => peer(i, { publicKey: e.target.value })}
              error={err(`wireguard.peers.${i}.publicKey`)}
            />
            <TextField
              label={S.wg.allowedIps}
              hint={S.wg.allowedIpsHint({ example: '10.77.0.2/32' })}
              value={p.allowedIps}
              autoComplete="off"
              onChange={(e) => peer(i, { allowedIps: e.target.value })}
              error={err(`wireguard.peers.${i}.allowedIps`)}
            />
            <TextField
              label={S.wg.endpoint}
              hint={S.wg.endpointHint}
              value={p.endpoint}
              autoComplete="off"
              onChange={(e) => peer(i, { endpoint: e.target.value })}
              error={err(`wireguard.peers.${i}.endpoint`)}
            />
            <div>
              <Button
                variant="ghost"
                aria-label={S.wg.removePeer({ n: i + 1 })}
                onClick={() => set({ peers: f.peers.filter((_, j) => j !== i) })}
              >
                {S.wg.remove}
              </Button>
            </div>
          </div>
        ))}
        <div>
          <Button
            onClick={() =>
              set({
                peers: [
                  ...f.peers,
                  {
                    key: (f.peers[f.peers.length - 1]?.key ?? 0) + 1,
                    name: '',
                    publicKey: '',
                    allowedIps: '',
                    endpoint: '',
                  },
                ],
              })
            }
          >
            {S.wg.addPeer}
          </Button>
        </div>
      </fieldset>
    </>
  );
}
