// The network settings form (FR-135; docs/22 §8): which transports the Hub advertises, mDNS and
// its name, the direct public URL and how often endpoints are tested. Saved with one PATCH, all
// or nothing, recorded in the change log so it can be rolled back. The form checks what it can
// as the Hub does, and shows the Hub's own message when it refuses (it never lets every
// transport go off).
import { useId, useState } from 'react';
import { defineMessages } from '@nova/i18n';
import { networkBaseUrlSchema } from '@nova/shared';
import { Button, Spinner, TextField, useToast } from '@nova/ui';
import { useAnnounce } from '../services.tsx';
import { SwitchField } from '../settings/controls.tsx';
import { useNetworkSurfaceApi, type NetworkPanel, type UpdateNetworkBody } from './api.ts';
import { NET_TEXT, errorFields, netErrorMessage, transportHelp } from './format.ts';

const S = defineMessages('netsurface.settings', {
  title: 'Settings',
  badUrl: 'Enter an http:// or https:// address without a user name, query or fragment.',
  badName: 'Use lowercase letters, digits and hyphens (not at the start or end).',
  badSeconds: 'Enter a whole number of seconds from 10 to 3600.',
  saved: 'Network settings saved. You can roll this back under Changes.',
  savedShort: 'Network settings saved.',
  nothingChanged: 'Nothing changed.',
  saveFailed: 'Could not save the network settings.',
  transports: 'Transports to advertise',
  transportsHelp:
    'Clients try them in this order. Turning one off stops advertising it; the Hub keeps listening, so you are never locked out.',
  relayHelp: 'Advertised only while the Relay is connected (see Relay).',
  directHelp: 'Needs the public URL below, and port forwarding or a public host.',
  publicUrl: 'Public URL',
  publicUrlHint: 'For example {url}. Advertised last, and only while it passes its test.',
  mdns: 'Announce on the LAN (mDNS)',
  mdnsHelp:
    "Devices on this network find the Hub by name. Only the Hub's version and fingerprint are announced, never a secret.",
  mdnsName: 'mDNS name',
  mdnsNameHint: "Clients find the Hub at {name}.local. Leave empty to use this computer's name.",
  nameWord: 'name',
  interval: 'Test endpoints every (seconds)',
  intervalHint: 'From 10 to 3600. An endpoint that fails is withdrawn until it passes again.',
  moreLan: 'More LAN addresses',
  loopback: 'Include loopback addresses',
  loopbackHelp: 'Useful only on this computer.',
  linkLocal: 'Include link-local addresses',
  linkLocalHelp: '169.254.x.x addresses, for networks without a router.',
  save: 'Save',
  reset: 'Reset',
});

interface Draft {
  lan: boolean;
  mesh: boolean;
  relay: boolean;
  directPublic: boolean;
  mdns: boolean;
  mdnsName: string;
  includeLoopback: boolean;
  includeLinkLocal: boolean;
  directUrl: string;
  healthCheckSeconds: string;
}

function draftOf(p: NetworkPanel): Draft {
  const on = (t: string) => p.transports.find((x) => x.transport === t)?.enabled ?? false;
  return {
    lan: on('lan'),
    mesh: on('mesh'),
    relay: on('relay'),
    directPublic: on('direct'),
    mdns: p.lan.mdns.enabled,
    mdnsName: p.lan.mdns.name ?? '',
    includeLoopback: p.lan.includeLoopback,
    includeLinkLocal: p.lan.includeLinkLocal,
    directUrl: p.directPublic.url ?? '',
    healthCheckSeconds: String(p.healthCheckSeconds),
  };
}

const DNS_LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

/** What the Hub would refuse, checked here first; keys are the request's field paths. */
export function checkDraft(d: Draft): Record<string, string> {
  const out: Record<string, string> = {};
  if (!d.lan && !d.mesh && !d.relay && !d.directPublic)
    out.transports = NET_TEXT.error.reason.no_transport;
  const url = d.directUrl.trim();
  if (url && !networkBaseUrlSchema.safeParse(url).success) out['directPublic.url'] = S.badUrl;
  else if (d.directPublic && !url) out['directPublic.url'] = NET_TEXT.error.reason.url_required;
  const name = d.mdnsName.trim();
  if (name && !DNS_LABEL.test(name)) out['lan.mdnsName'] = S.badName;
  const secs = Number(d.healthCheckSeconds);
  if (!Number.isInteger(secs) || secs < 10 || secs > 3600) out.healthCheckSeconds = S.badSeconds;
  return out;
}

/** Only what changed, in the shape PATCH /api/v1/network takes. */
export function patchOf(before: Draft, after: Draft): UpdateNetworkBody {
  const body: UpdateNetworkBody = {};
  if (
    before.lan !== after.lan ||
    before.mesh !== after.mesh ||
    before.relay !== after.relay ||
    before.directPublic !== after.directPublic
  )
    body.transports = {
      lan: after.lan,
      mesh: after.mesh,
      relay: after.relay,
      directPublic: after.directPublic,
    };
  const lan: NonNullable<UpdateNetworkBody['lan']> = {};
  if (before.mdns !== after.mdns) lan.mdns = after.mdns;
  if (before.mdnsName.trim() !== after.mdnsName.trim())
    lan.mdnsName = after.mdnsName.trim() || null;
  if (before.includeLoopback !== after.includeLoopback) lan.includeLoopback = after.includeLoopback;
  if (before.includeLinkLocal !== after.includeLinkLocal)
    lan.includeLinkLocal = after.includeLinkLocal;
  if (Object.keys(lan).length) body.lan = lan;
  if (before.directUrl.trim() !== after.directUrl.trim())
    body.directPublic = { url: after.directUrl.trim() || null };
  if (before.healthCheckSeconds.trim() !== after.healthCheckSeconds.trim())
    body.healthCheckSeconds = Number(after.healthCheckSeconds);
  return body;
}

export const SETTINGS_ANCHOR = 'network-settings';

export function NetworkSettingsForm({
  panel,
  onSaved,
}: {
  panel: NetworkPanel;
  onSaved: (next: NetworkPanel) => void;
}) {
  const api = useNetworkSurfaceApi();
  const toast = useToast();
  const announce = useAnnounce();
  const headingId = useId();
  const base = draftOf(panel);
  const [edit, setEdit] = useState<Draft | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const d = edit ?? base;
  const body = patchOf(base, d);
  const dirty = Object.keys(body).length > 0;
  const set = (patch: Partial<Draft>) => {
    setEdit({ ...d, ...patch });
    setFailure(null);
  };

  const save = async () => {
    const found = checkDraft(d);
    setErrors(found);
    if (Object.keys(found).length || !dirty) return;
    setBusy(true);
    setFailure(null);
    try {
      const res = await api.updateNetworkPanel(body);
      setEdit(null);
      onSaved(res);
      toast.show(res.change ? S.saved : S.nothingChanged, { tone: 'success' });
      announce(S.savedShort);
    } catch (err) {
      const fields = errorFields(err);
      setErrors(fields);
      setFailure(netErrorMessage(err, S.saveFailed));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="ws-section" aria-labelledby={headingId}>
      <h2 id={headingId} tabIndex={-1} className="net-anchor" data-anchor={SETTINGS_ANCHOR}>
        {S.title}
      </h2>
      <form
        className="stack net-form"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <fieldset className="net-fieldset">
          <legend className="nv-field-label">{S.transports}</legend>
          <p className="nv-field-hint">{S.transportsHelp}</p>
          <SwitchField
            label={NET_TEXT.transport.lan}
            description={transportHelp('lan')}
            checked={d.lan}
            onChange={(v) => set({ lan: v })}
          />
          <SwitchField
            label={NET_TEXT.transport.mesh}
            description={transportHelp('mesh')}
            checked={d.mesh}
            onChange={(v) => set({ mesh: v })}
          />
          <SwitchField
            label={NET_TEXT.transport.relay}
            description={S.relayHelp}
            checked={d.relay}
            onChange={(v) => set({ relay: v })}
          />
          <SwitchField
            label={NET_TEXT.transport.direct}
            description={S.directHelp}
            checked={d.directPublic}
            onChange={(v) => set({ directPublic: v })}
          />
          {errors.transports ? (
            <p className="nv-field-error" role="alert">
              {errors.transports}
            </p>
          ) : null}
        </fieldset>
        <TextField
          label={S.publicUrl}
          hint={S.publicUrlHint({ url: 'https://nova.example.com:8443' })}
          value={d.directUrl}
          inputMode="url"
          autoComplete="off"
          onChange={(e) => set({ directUrl: e.target.value })}
          error={errors['directPublic.url']}
        />
        <SwitchField
          label={S.mdns}
          description={S.mdnsHelp}
          checked={d.mdns}
          onChange={(v) => set({ mdns: v })}
        />
        <TextField
          label={S.mdnsName}
          hint={S.mdnsNameHint({
            name: d.mdnsName.trim() || panel.lan.mdns.name || S.nameWord,
          })}
          value={d.mdnsName}
          autoComplete="off"
          spellCheck={false}
          disabled={!d.mdns}
          onChange={(e) => set({ mdnsName: e.target.value })}
          error={errors['lan.mdnsName']}
        />
        <TextField
          label={S.interval}
          hint={S.intervalHint}
          className="ws-number"
          type="number"
          min={10}
          max={3600}
          inputMode="numeric"
          value={d.healthCheckSeconds}
          onChange={(e) => set({ healthCheckSeconds: e.target.value })}
          error={errors.healthCheckSeconds}
        />
        <details className="ws-advanced">
          <summary>{S.moreLan}</summary>
          <div className="stack">
            <SwitchField
              label={S.loopback}
              description={S.loopbackHelp}
              checked={d.includeLoopback}
              onChange={(v) => set({ includeLoopback: v })}
            />
            <SwitchField
              label={S.linkLocal}
              description={S.linkLocalHelp}
              checked={d.includeLinkLocal}
              onChange={(v) => set({ includeLinkLocal: v })}
            />
          </div>
        </details>
        {failure ? (
          <p className="nv-field-error" role="alert">
            {failure}
          </p>
        ) : null}
        <div className="row">
          <Button type="submit" variant="primary" disabled={!dirty || busy}>
            {busy ? <Spinner /> : null} {S.save}
          </Button>
          {edit ? (
            <Button
              onClick={() => {
                setEdit(null);
                setErrors({});
                setFailure(null);
              }}
            >
              {S.reset}
            </Button>
          ) : null}
        </div>
      </form>
    </section>
  );
}
