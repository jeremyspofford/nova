// Choose a mesh and its options, then make a plan (FR-136; docs/22 §2.2, §6). The options are
// checked with the Hub's own schema before they are sent; auth, setup and API keys are write-only
// fields (sent once, kept in the Hub's vault, never shown again). Planning changes nothing.
import { useId, useState } from 'react';
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
import { PROVIDER_INFO, errorFields, netErrorMessage, providerLabel, reasonOf } from './format.ts';

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

const CERT_OPTIONS = [
  { value: 'auto', label: 'Mesh certificates when the mesh has them, else the Hub local CA' },
  { value: 'mesh', label: 'Mesh certificates' },
  { value: 'local-ca', label: 'The Hub local CA' },
  { value: 'none', label: 'No certificate' },
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
    const state = !m
      ? ''
      : !m.installed
        ? ''
        : m.loggedIn
          ? ' Found on this computer, connected.'
          : ' Found on this computer, not connected.';
    return `${PROVIDER_INFO[p]?.help ?? ''}${state}`;
  };

  const plan = async () => {
    if (!provider) return;
    const options = optionsOf(provider, f);
    const local = checkOptions(options);
    if (provider === 'wireguard' && !f.wgAddress.trim())
      local['wireguard.address'] = 'Enter the Hub’s address on the WireGuard network.';
    setErrors(local);
    setFailure(null);
    if (Object.keys(local).length) return;
    setBusy(true);
    try {
      const { run } = await api.planNetworkSetup(provider, options);
      // Secrets go to the Hub once; nothing keeps them here.
      set({ authKey: '', hsApiKey: '' });
      toast.show(`Plan ready: ${run.steps.length} steps.`, { tone: 'success' });
      announce(`${providerLabel(provider)} plan ready.`);
      onPlanned(run);
    } catch (e) {
      const fields: Record<string, string> = {};
      for (const [k, v] of Object.entries(errorFields(e))) fields[k.replace(/^options\./, '')] = v;
      const reason = reasonOf(e);
      const field = reason ? REASON_FIELD[reason] : undefined;
      if (field) fields[field] = netErrorMessage(e);
      setErrors(fields);
      setFailure(field ? null : netErrorMessage(e, 'Could not make a plan.'));
    } finally {
      setBusy(false);
    }
  };

  const p = provider;
  return (
    <section className="ws-section" aria-labelledby={headingId}>
      <h2 id={headingId}>Set up a mesh</h2>
      <RadioGroup
        legend="Mesh"
        name="net-mesh-provider"
        value={provider ?? ''}
        className="net-providers"
        options={MESH_PROVIDERS.map((m) => ({
          value: m,
          label: `${providerLabel(m)}: ${PROVIDER_INFO[m]?.tag ?? ''}`,
          description: describe(m),
        }))}
        onChange={(v) => {
          const next = MESH_PROVIDERS.find((m) => m === v) ?? null;
          setProvider(next);
          setErrors({});
          setFailure(null);
        }}
        hint="On iPhone and iPad, a self-hosted mesh works only with NetBird; otherwise those reach the Hub through the Relay."
      />
      {p ? (
        <form
          className="stack net-form"
          noValidate
          aria-label={`${providerLabel(p)} options`}
          onSubmit={(e) => {
            e.preventDefault();
            void plan();
          }}
        >
          {p === 'headscale' ? (
            <>
              <TextField
                label="Headscale server URL"
                hint="Where your Headscale answers, for example https://headscale.example.com."
                value={f.controlUrl}
                inputMode="url"
                autoComplete="off"
                onChange={(e) => set({ controlUrl: e.target.value })}
                error={err('controlUrl')}
              />
              <TextField
                label="Pre-auth key (optional, write-only)"
                hint="Leave empty and Nova makes a one-use key on the server. A key you enter goes to the Hub's vault and is never shown again."
                type="password"
                autoComplete="off"
                value={f.authKey}
                onChange={(e) => set({ authKey: e.target.value })}
                error={err('authKey')}
              />
              <TextField
                label="Headscale user"
                hint="The user the Hub's node belongs to. Default: nova."
                value={f.hsUser}
                autoComplete="off"
                onChange={(e) => set({ hsUser: e.target.value })}
                error={err('headscale.user')}
              />
              <SwitchField
                label="Write access rules for Nova"
                description="Let Nova devices reach the Hub's tag. Existing rules are kept."
                checked={f.hsAcl}
                onChange={(v) => set({ hsAcl: v })}
              />
            </>
          ) : null}
          {p === 'tailscale' ? (
            <>
              <TextField
                label="Auth key (write-only)"
                hint="Make one in your Tailscale admin console. It goes to the Hub's vault and is never shown again."
                type="password"
                autoComplete="off"
                value={f.authKey}
                onChange={(e) => set({ authKey: e.target.value })}
                error={err('authKey')}
              />
              <TextField
                label="Control server URL (optional)"
                hint="Leave empty for Tailscale's own service."
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
                label="Management URL (optional)"
                hint="Your own NetBird management service, for example https://netbird.example.com. Leave empty for NetBird's hosted service."
                value={f.controlUrl}
                inputMode="url"
                autoComplete="off"
                onChange={(e) => set({ controlUrl: e.target.value })}
                error={err('controlUrl')}
              />
              <TextField
                label="Setup key (write-only)"
                hint="It goes to the Hub's vault and is never shown again."
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
              label="Name on the mesh"
              hint="Default: nova-hub."
              value={f.hostname}
              autoComplete="off"
              spellCheck={false}
              onChange={(e) => set({ hostname: e.target.value })}
              error={err('hostname')}
            />
          ) : null}
          <SelectField
            label="Certificates"
            value={f.certs}
            options={CERT_OPTIONS}
            onChange={(v) => set({ certs: v as Form['certs'] })}
            error={err('certs')}
          />
          <details className="ws-advanced">
            <summary>More options</summary>
            <div className="stack">
              {p === 'headscale' || p === 'tailscale' ? (
                <TextField
                  label="Tags"
                  hint="Separated by commas, for example tag:nova-hub (the default)."
                  value={f.tags}
                  autoComplete="off"
                  spellCheck={false}
                  onChange={(e) => set({ tags: e.target.value })}
                  error={err('tags')}
                />
              ) : null}
              <TextField
                label="Subnet routes"
                hint={`Networks the Hub shares with the mesh, separated by commas.${
                  detection?.subnets.length
                    ? ` This computer's LAN: ${detection.subnets.join(', ')}.`
                    : ''
                }`}
                value={f.advertiseRoutes}
                autoComplete="off"
                spellCheck={false}
                onChange={(e) => set({ advertiseRoutes: e.target.value })}
                error={err('advertiseRoutes')}
              />
              {p !== 'wireguard' ? (
                <>
                  <SwitchField
                    label="Mesh names (MagicDNS)"
                    description="Reach devices on the mesh by name."
                    checked={f.magicDns}
                    onChange={(v) => set({ magicDns: v })}
                  />
                  <SwitchField
                    label="Offer the Hub as an exit node"
                    description="Other devices may send all their internet traffic through the Hub."
                    checked={f.exitNode}
                    onChange={(v) => set({ exitNode: v })}
                  />
                  <SwitchField
                    label="Install the mesh client if it is missing"
                    checked={f.installClient}
                    onChange={(v) => set({ installClient: v })}
                  />
                  <SwitchField
                    label="Replace an existing login"
                    description="When the Hub is already signed in to another control server. The old login is not restored on rollback."
                    checked={f.replaceExisting}
                    onChange={(v) => set({ replaceExisting: v })}
                  />
                </>
              ) : null}
              <SwitchField
                label="Open the Hub's port in the firewall"
                description="Adds allow rules in ufw when it is present. Nothing is denied or removed."
                checked={f.firewall}
                onChange={(v) => set({ firewall: v })}
              />
              <TextField
                label="Relay to enroll with (optional)"
                hint="A wss:// address, as a fallback path."
                value={f.relayUrl}
                inputMode="url"
                autoComplete="off"
                onChange={(e) => set({ relayUrl: e.target.value })}
                error={err('relay')}
              />
              {p === 'headscale' ? (
                <>
                  <TextField
                    label="Remote Headscale address (optional)"
                    hint="host:port of a Headscale on another computer. Leave empty when it runs here."
                    value={f.hsCliAddress}
                    autoComplete="off"
                    onChange={(e) => set({ hsCliAddress: e.target.value })}
                    error={err('headscale.cliAddress')}
                  />
                  <TextField
                    label="Remote Headscale API key (write-only)"
                    hint="Needed with a remote address. It goes to the Hub's vault."
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
          <p className="muted ws-flush net-small">
            Making a plan changes nothing. You apply each step yourself and can roll it back.
          </p>
          <div className="row">
            <Button type="submit" variant="primary" disabled={busy}>
              {busy ? <Spinner /> : null} Make a plan
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
        label="The Hub's address on the WireGuard network"
        hint="With its prefix, for example 10.77.0.1/24."
        value={f.wgAddress}
        autoComplete="off"
        spellCheck={false}
        onChange={(e) => set({ wgAddress: e.target.value })}
        error={err('wireguard.address')}
      />
      <div className="net-fields">
        <TextField
          label="Interface"
          hint="Default: wg-nova."
          value={f.wgInterface}
          autoComplete="off"
          onChange={(e) => set({ wgInterface: e.target.value })}
          error={err('wireguard.interface')}
        />
        <TextField
          label="Listen port"
          hint="UDP, 1024 to 65535."
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
        label="DNS servers (optional)"
        hint="Separated by commas."
        value={f.wgDns}
        autoComplete="off"
        onChange={(e) => set({ wgDns: e.target.value })}
        error={err('wireguard.dns')}
      />
      <fieldset className="net-fieldset">
        <legend className="nv-field-label">Peers</legend>
        <p className="nv-field-hint">
          Each device that joins: its public key and the addresses it may use. Nova makes the
          Hub&apos;s own key and shows its public half after planning.
        </p>
        {f.peers.length === 0 ? <p className="muted ws-flush">No peers yet.</p> : null}
        {f.peers.map((p, i) => (
          <div key={p.key} className="net-peer" role="group" aria-label={`Peer ${i + 1}`}>
            <TextField
              label="Name"
              value={p.name}
              autoComplete="off"
              onChange={(e) => peer(i, { name: e.target.value })}
              error={err(`wireguard.peers.${i}.name`)}
            />
            <TextField
              label="Public key"
              value={p.publicKey}
              autoComplete="off"
              spellCheck={false}
              onChange={(e) => peer(i, { publicKey: e.target.value })}
              error={err(`wireguard.peers.${i}.publicKey`)}
            />
            <TextField
              label="Allowed addresses"
              hint="For example 10.77.0.2/32."
              value={p.allowedIps}
              autoComplete="off"
              onChange={(e) => peer(i, { allowedIps: e.target.value })}
              error={err(`wireguard.peers.${i}.allowedIps`)}
            />
            <TextField
              label="Endpoint (optional)"
              hint="host:port"
              value={p.endpoint}
              autoComplete="off"
              onChange={(e) => peer(i, { endpoint: e.target.value })}
              error={err(`wireguard.peers.${i}.endpoint`)}
            />
            <div>
              <Button
                variant="ghost"
                aria-label={`Remove peer ${i + 1}`}
                onClick={() => set({ peers: f.peers.filter((_, j) => j !== i) })}
              >
                Remove
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
            Add a peer
          </Button>
        </div>
      </fieldset>
    </>
  );
}
