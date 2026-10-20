// An agent's connected computer (FR-081; docs/11 §2): which agent uses this device as its
// computer, connecting one (explicit, one device per agent, with the capabilities it may use),
// replacing an agent's other computer only when asked, and disconnecting (its grants on the device
// go with it). `AgentComputerPanel` is the same from the agent's side, for the agent's profile.
import { useId, useState } from 'react';
import {
  DEVICE_CONNECTION_CAPABILITIES,
  type AgentDeviceConnectionView,
  type AgentView,
  type DeviceCapabilityName,
  type DeviceView,
} from '@nova/shared';
import { Button, Dialog, EmptyState, Icon, SelectField, Spinner, useToast } from '@nova/ui';
import { defineMessages } from '@nova/i18n';
import { ApiError } from '../api.ts';
import { rich } from '../i18n/rich.tsx';
import { formatWhen } from '../settings/common.ts';
import { followLink } from '../work/nav.tsx';
import { useDevicesApi } from './api.ts';
import type { PanelProps } from './DevicePage.tsx';
import { eventDeviceId, useDeviceEvents } from './events.ts';
import {
  CAPABILITY_LABEL,
  capabilityReason,
  deviceErrorMessage,
  devicePath,
  errorReason,
  listText,
} from './format.ts';
import { ConfirmDialog, LoadError, PARTS_TEXT, useLoad } from './parts.tsx';

/** The agents tab and an agent's connected computer (FR-016). */
export const CONNECTIONS_TEXT = defineMessages('devices.connections', {
  title: 'Agents using this device',
  connectAgent: 'Connect an agent',
  intro:
    'An agent can use one of your computers at a time, only after you connect it here. It still needs folders shared with it to see your files.',
  keptOut: 'This device is kept out of agent work by its policy.',
  loadFailed: 'Could not load connections.',
  loading: 'Loading connections',
  none: 'No agent uses this device as its computer.',
  connected: 'Connected agents',
  /** An agent whose name could not be loaded. */
  someAgent: 'An agent',
  mayUse: 'May use: {capabilities}',
  connectedWhen: 'Connected {when}',
  disconnect: 'Disconnect',
  disconnectName: 'Disconnect {name}',
  disconnectNamed: 'Disconnect {name}?',
  disconnectBare: 'Disconnect?',
  disconnectThis: 'Disconnect this computer?',
  disconnectAgent:
    'The agent can no longer use this device, and every folder shared with it here is closed.',
  disconnectComputer:
    '{agent} can no longer use it, and every folder shared with it there is closed.',
  disconnected: 'Disconnected.',
  earlier: 'Earlier connections',
  earlierCount: 'Earlier connections ({n})',
  earlierRow: '{name} · disconnected {when}',
  nowUses: '{agent} now uses {device} as its computer.',
  dialog: {
    titleDevice: 'Connect an agent to {device}',
    titleComputer: 'Connect a computer',
    description: 'The agent can use this device for the work you allow below, and nothing else.',
    replaceNamed:
      'This agent already uses {device} as its computer. Replace it? The agent loses access to {device}, and the folders shared with it there are closed.',
    replaceUnnamed:
      'This agent already uses another device as its computer. Replace it? The agent loses access to it, and the folders shared with it there are closed.',
    back: 'Back',
    replace: 'Replace',
    agent: 'Agent',
    chooseAgent: 'Choose an agent',
    agentsFailed: 'Could not load agents.',
    noAgents: 'You have no agents yet. {link} first.',
    createOne: 'Create one',
    loadingAgents: 'Loading agents',
    device: 'Device',
    chooseDevice: 'Choose a device',
    deviceKeptOut: '{name} (kept out of agent work)',
    mayUse: 'It may use',
    chooseOne: 'Choose at least one.',
    cannotServe:
      '{n, plural, one {This device cannot serve {capabilities} yet; uncheck it.} other {This device cannot serve {capabilities} yet; uncheck them.}}',
    connectFailed: 'Could not connect.',
    connect: 'Connect',
  },
  computer: {
    title: 'Your computer',
    change: 'Change computer',
    connect: 'Connect a computer',
    intro: '{agent} can use one of your devices at a time, for the work you allow.',
    loadFailed: 'Could not load the connection.',
    loading: 'Loading the connection',
    noneTitle: 'No computer connected',
    noneHelp: 'Connect a device running novad, or let the agent use its cloud computer.',
    device: 'Device',
    devicesFailed: 'Could not load devices.',
    loadingDevices: 'Loading devices',
  },
});

const S = CONNECTIONS_TEXT;

type ConnCap = (typeof DEVICE_CONNECTION_CAPABILITIES)[number];
const DEFAULT_CAPS: ConnCap[] = ['files', 'staged_writes', 'exec'];

/** The account's agents, for names and pickers; an empty list when they cannot load. */
export function useAgentChoices(): {
  agents: AgentView[] | null;
  error: unknown;
  reload: () => void;
  name: (id: string) => string | null;
} {
  const api = useDevicesApi();
  const list = useLoad(() => api.listDeviceAgentChoices().then((r) => r.items), 'agents');
  return {
    agents: list.data,
    error: list.error,
    reload: list.reload,
    name: (id) => list.data?.find((a) => a.id === id)?.name ?? null,
  };
}

function capsText(caps: readonly string[]): string {
  return listText(caps.map((c) => CAPABILITY_LABEL[c as DeviceCapabilityName] ?? c));
}

export function DeviceAgentsPanel({ device }: PanelProps) {
  const api = useDevicesApi();
  const toast = useToast();
  const agents = useAgentChoices();
  const conns = useLoad(
    () => api.listDeviceConnections({ deviceId: device.id }).then((r) => r.items),
    device.id,
  );
  const [connecting, setConnecting] = useState(false);
  const [ending, setEnding] = useState<AgentDeviceConnectionView | null>(null);
  useDeviceEvents(['device.connection.changed'], (env) => {
    if (eventDeviceId(env) === device.id) conns.reload();
  });
  const name = (id: string) => agents.name(id) ?? S.someAgent;
  const active = conns.data?.filter((c) => c.status === 'active') ?? [];
  const past = conns.data?.filter((c) => c.status !== 'active') ?? [];
  const revoked = device.status === 'revoked';
  const ineligible = !device.routingEligible;

  return (
    <section className="ws-section devices-flat" aria-labelledby="agents-h">
      <div className="ws-section-header">
        <h2 id="agents-h">{S.title}</h2>
        {!revoked ? (
          <Button onClick={() => setConnecting(true)} disabled={ineligible}>
            <Icon name="plus" /> {S.connectAgent}
          </Button>
        ) : null}
      </div>
      <p className="muted ws-flush">{S.intro}</p>
      {ineligible && !revoked ? (
        <p className="devices-unavailable">
          <Icon name="alert" /> {S.keptOut}
        </p>
      ) : null}
      {conns.error ? (
        <LoadError error={conns.error} fallback={S.loadFailed} onRetry={conns.reload} />
      ) : null}
      {conns.loading ? <Spinner label={S.loading} /> : null}
      {conns.data && !active.length ? <p className="muted ws-flush">{S.none}</p> : null}
      {active.length ? (
        <ul className="ws-list" aria-label={S.connected}>
          {active.map((c) => (
            <li key={c.id} className="ws-list-row" aria-label={name(c.agentId)}>
              <div className="devices-row-main">
                <strong dir="auto">{name(c.agentId)}</strong>
                <span className="muted ws-row-meta">
                  <span>{S.mayUse({ capabilities: capsText(c.capabilities) })}</span>
                  <span>{S.connectedWhen({ when: formatWhen(c.createdAt) })}</span>
                </span>
              </div>
              <Button
                onClick={() => setEnding(c)}
                aria-label={S.disconnectName({ name: name(c.agentId) })}
              >
                {S.disconnect}
              </Button>
            </li>
          ))}
        </ul>
      ) : null}
      {past.length ? (
        <details className="ws-advanced">
          <summary>{S.earlierCount({ n: past.length })}</summary>
          <ul className="ws-list" aria-label={S.earlier}>
            {past.map((c) => (
              <li key={c.id} className="ws-list-row">
                <span>
                  {S.earlierRow({ name: name(c.agentId), when: formatWhen(c.revokedAt) })}
                </span>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
      {connecting ? (
        <ConnectDialog
          device={device}
          agents={agents}
          onClose={() => setConnecting(false)}
          onDone={(c) => {
            setConnecting(false);
            conns.reload();
            toast.show(S.nowUses({ agent: name(c.agentId), device: device.name }), {
              tone: 'success',
            });
          }}
        />
      ) : null}
      <ConfirmDialog
        open={ending !== null}
        title={ending ? S.disconnectNamed({ name: name(ending.agentId) }) : S.disconnectBare}
        description={S.disconnectAgent}
        confirmLabel={S.disconnect}
        danger
        onClose={() => setEnding(null)}
        onConfirm={async () => {
          if (!ending) return;
          await api.disconnectDevice(ending.id);
          setEnding(null);
          conns.reload();
          toast.show(S.disconnected, { tone: 'success' });
        }}
      />
    </section>
  );
}

/** Choose the agent (or the device) and the capabilities; replacing another computer asks first. */
function ConnectDialog({
  device,
  agents,
  agentId: fixedAgent,
  devices,
  onClose,
  onDone,
}: {
  device?: DeviceView;
  agents?: ReturnType<typeof useAgentChoices>;
  agentId?: string;
  devices?: DeviceView[];
  onClose: () => void;
  onDone: (c: AgentDeviceConnectionView) => void;
}) {
  const api = useDevicesApi();
  const base = useId();
  const [agentId, setAgentId] = useState(fixedAgent ?? '');
  const [deviceId, setDeviceId] = useState(device?.id ?? '');
  const [caps, setCaps] = useState<ConnCap[]>(() =>
    DEFAULT_CAPS.filter((c) => device?.capabilities.find((x) => x.name === c)?.available !== false),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [replace, setReplace] = useState<{ deviceId: string } | null>(null);
  const target = device ?? devices?.find((d) => d.id === deviceId) ?? null;
  // The Hub refuses a capability the device cannot serve (FR-081, FR-148); offline is fine.
  const why = (c: ConnCap) => {
    const s = target?.capabilities.find((x) => x.name === c);
    return s && !s.available ? capabilityReason(s) : null;
  };
  const refused = caps.filter((c) => why(c));
  const ready = Boolean(agentId && deviceId && caps.length && !refused.length);

  const submit = async (withReplace = false) => {
    if (!ready || busy) return;
    setBusy(true);
    setError(null);
    try {
      onDone(
        await api.connectDevice({
          agentId,
          deviceId,
          capabilities: caps,
          ...(withReplace ? { replace: true } : {}),
        }),
      );
    } catch (err) {
      if (err instanceof ApiError && errorReason(err) === 'agent_connected') {
        const other = err.body.details?.deviceId;
        setReplace({ deviceId: typeof other === 'string' ? other : '' });
      } else setError(deviceErrorMessage(err, S.dialog.connectFailed));
      setBusy(false);
    }
  };

  const D = S.dialog;
  const otherName = replace
    ? (devices?.find((d) => d.id === replace.deviceId)?.name ?? null)
    : null;
  return (
    <Dialog
      open
      title={device ? D.titleDevice({ device: device.name }) : D.titleComputer}
      description={D.description}
      onClose={onClose}
    >
      {replace ? (
        <div className="stack">
          <p role="alert" className="ws-flush">
            {otherName ? D.replaceNamed({ device: otherName }) : D.replaceUnnamed}
          </p>
          <div className="nv-dialog-footer">
            <Button onClick={() => setReplace(null)}>{D.back}</Button>
            <Button variant="danger" disabled={busy} onClick={() => void submit(true)}>
              {D.replace}
            </Button>
          </div>
        </div>
      ) : (
        <form
          className="stack"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          {!fixedAgent ? (
            agents?.agents?.length ? (
              <SelectField
                label={D.agent}
                value={agentId}
                onChange={setAgentId}
                options={[
                  { value: '', label: D.chooseAgent },
                  ...agents.agents.map((a) => ({ value: a.id, label: a.name })),
                ]}
              />
            ) : agents?.error ? (
              <LoadError error={agents.error} fallback={D.agentsFailed} onRetry={agents.reload} />
            ) : agents?.agents ? (
              <p className="ws-flush">
                {rich(D.noAgents, {
                  link: (
                    <a href="/agents" onClick={(e) => followLink(e, '/agents')}>
                      {D.createOne}
                    </a>
                  ),
                })}
              </p>
            ) : (
              <Spinner label={D.loadingAgents} />
            )
          ) : null}
          {!device ? (
            <SelectField
              label={D.device}
              value={deviceId}
              onChange={setDeviceId}
              options={[
                { value: '', label: D.chooseDevice },
                ...(devices ?? [])
                  .filter((d) => d.status !== 'revoked')
                  .map((d) => ({
                    value: d.id,
                    label: d.routingEligible ? d.name : D.deviceKeptOut({ name: d.name }),
                    disabled: !d.routingEligible,
                  })),
              ]}
            />
          ) : null}
          <fieldset className="nv-radios">
            <legend className="nv-field-label">{D.mayUse}</legend>
            {DEVICE_CONNECTION_CAPABILITIES.map((c) => {
              const reason = why(c);
              return (
                <label key={c} className="nv-radio">
                  <input
                    type="checkbox"
                    checked={caps.includes(c)}
                    // An unavailable one can be unchecked but not checked.
                    disabled={Boolean(reason) && !caps.includes(c)}
                    aria-labelledby={`${base}-${c}-label`}
                    aria-describedby={reason ? `${base}-${c}` : undefined}
                    onChange={(e) =>
                      setCaps((cur) =>
                        e.target.checked ? [...cur, c] : cur.filter((x) => x !== c),
                      )
                    }
                  />
                  <span className="nv-radio-text">
                    <span id={`${base}-${c}-label`}>{CAPABILITY_LABEL[c]}</span>
                    {reason ? (
                      <span id={`${base}-${c}`} className="nv-field-hint">
                        {reason}
                      </span>
                    ) : null}
                  </span>
                </label>
              );
            })}
          </fieldset>
          {!caps.length ? (
            <p className="nv-field-error" role="alert">
              {D.chooseOne}
            </p>
          ) : null}
          {refused.length ? (
            <p className="nv-field-error" role="alert">
              {D.cannotServe({ n: refused.length, capabilities: capsText(refused) })}
            </p>
          ) : null}
          {error ? (
            <p role="alert" className="nv-field-error">
              {error}
            </p>
          ) : null}
          <div className="nv-dialog-footer">
            <Button onClick={onClose}>{PARTS_TEXT.cancel}</Button>
            <Button type="submit" variant="primary" disabled={!ready || busy}>
              {busy ? <Spinner /> : null} {D.connect}
            </Button>
          </div>
        </form>
      )}
    </Dialog>
  );
}

/**
 * The agent's connected computer, for the agent's profile (FR-081): which of the user's devices
 * it may use, connect one, or disconnect it.
 */
export function AgentComputerPanel({ agentId, agentName }: { agentId: string; agentName: string }) {
  const api = useDevicesApi();
  const toast = useToast();
  const conns = useLoad(
    () => api.listDeviceConnections({ agentId }).then((r) => r.items),
    `agent:${agentId}`,
  );
  const devices = useLoad(() => api.listNovadDevices().then((r) => r.items), 'devices');
  const [connecting, setConnecting] = useState(false);
  const [ending, setEnding] = useState<AgentDeviceConnectionView | null>(null);
  useDeviceEvents(['device.connection.changed'], (env) => {
    if (env.payload.agentId === agentId) conns.reload();
  });
  const active = conns.data?.find((c) => c.status === 'active') ?? null;
  const C = S.computer;

  return (
    <section className="ws-section devices-flat" aria-labelledby={`computer-${agentId}`}>
      <div className="ws-section-header">
        <h2 id={`computer-${agentId}`}>{C.title}</h2>
        {conns.data ? (
          <Button onClick={() => setConnecting(true)}>{active ? C.change : C.connect}</Button>
        ) : null}
      </div>
      <p className="muted ws-flush">{C.intro({ agent: agentName })}</p>
      {conns.error ? (
        <LoadError error={conns.error} fallback={C.loadFailed} onRetry={conns.reload} />
      ) : null}
      {conns.loading ? <Spinner label={C.loading} /> : null}
      {conns.data && !active ? (
        <EmptyState title={C.noneTitle} description={C.noneHelp} icon="server" level={3} />
      ) : null}
      {active ? (
        <div className="ws-list-row">
          <div className="devices-row-main">
            <a
              href={devicePath(active.deviceId)}
              className="ws-card-link"
              onClick={(e) => followLink(e, devicePath(active.deviceId))}
            >
              {active.deviceName || C.device}
            </a>
            <span className="muted ws-row-meta">
              <span>{S.mayUse({ capabilities: capsText(active.capabilities) })}</span>
              <span>{S.connectedWhen({ when: formatWhen(active.createdAt) })}</span>
            </span>
          </div>
          <Button onClick={() => setEnding(active)}>{S.disconnect}</Button>
        </div>
      ) : null}
      {connecting ? (
        devices.data ? (
          <ConnectDialog
            agentId={agentId}
            devices={devices.data}
            onClose={() => setConnecting(false)}
            onDone={(c) => {
              setConnecting(false);
              conns.reload();
              toast.show(S.nowUses({ agent: agentName, device: c.deviceName }), {
                tone: 'success',
              });
            }}
          />
        ) : (
          <Dialog open title={C.connect} onClose={() => setConnecting(false)}>
            {devices.error ? (
              <LoadError
                error={devices.error}
                fallback={C.devicesFailed}
                onRetry={devices.reload}
              />
            ) : (
              <Spinner label={C.loadingDevices} />
            )}
          </Dialog>
        )
      ) : null}
      <ConfirmDialog
        open={ending !== null}
        title={
          ending?.deviceName ? S.disconnectNamed({ name: ending.deviceName }) : S.disconnectThis
        }
        description={S.disconnectComputer({ agent: agentName })}
        confirmLabel={S.disconnect}
        danger
        onClose={() => setEnding(null)}
        onConfirm={async () => {
          if (!ending) return;
          await api.disconnectDevice(ending.id);
          setEnding(null);
          conns.reload();
          toast.show(S.disconnected, { tone: 'success' });
        }}
      />
    </section>
  );
}
