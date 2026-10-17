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
import { ApiError } from '../api.ts';
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
} from './format.ts';
import { ConfirmDialog, LoadError, useLoad } from './parts.tsx';

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
  return caps.map((c) => CAPABILITY_LABEL[c as DeviceCapabilityName] ?? c).join(', ');
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
  const name = (id: string) => agents.name(id) ?? 'An agent';
  const active = conns.data?.filter((c) => c.status === 'active') ?? [];
  const past = conns.data?.filter((c) => c.status !== 'active') ?? [];
  const revoked = device.status === 'revoked';
  const ineligible = !device.routingEligible;

  return (
    <section className="ws-section devices-flat" aria-labelledby="agents-h">
      <div className="ws-section-header">
        <h2 id="agents-h">Agents using this device</h2>
        {!revoked ? (
          <Button onClick={() => setConnecting(true)} disabled={ineligible}>
            <Icon name="plus" /> Connect an agent
          </Button>
        ) : null}
      </div>
      <p className="muted ws-flush">
        An agent can use one of your computers at a time, only after you connect it here. It still
        needs folders shared with it to see your files.
      </p>
      {ineligible && !revoked ? (
        <p className="devices-unavailable">
          <Icon name="alert" /> This device is kept out of agent work by its policy.
        </p>
      ) : null}
      {conns.error ? (
        <LoadError
          error={conns.error}
          fallback="Could not load connections."
          onRetry={conns.reload}
        />
      ) : null}
      {conns.loading ? <Spinner label="Loading connections" /> : null}
      {conns.data && !active.length ? (
        <p className="muted ws-flush">No agent uses this device as its computer.</p>
      ) : null}
      {active.length ? (
        <ul className="ws-list" aria-label="Connected agents">
          {active.map((c) => (
            <li key={c.id} className="ws-list-row" aria-label={name(c.agentId)}>
              <div className="devices-row-main">
                <strong>{name(c.agentId)}</strong>
                <span className="muted ws-row-meta">
                  <span>May use: {capsText(c.capabilities)}</span>
                  <span>Connected {formatWhen(c.createdAt)}</span>
                </span>
              </div>
              <Button onClick={() => setEnding(c)} aria-label={`Disconnect ${name(c.agentId)}`}>
                Disconnect
              </Button>
            </li>
          ))}
        </ul>
      ) : null}
      {past.length ? (
        <details className="ws-advanced">
          <summary>Earlier connections ({past.length})</summary>
          <ul className="ws-list" aria-label="Earlier connections">
            {past.map((c) => (
              <li key={c.id} className="ws-list-row">
                <span>
                  {name(c.agentId)} · disconnected {formatWhen(c.revokedAt)}
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
            toast.show(`${name(c.agentId)} now uses ${device.name} as its computer.`, {
              tone: 'success',
            });
          }}
        />
      ) : null}
      <ConfirmDialog
        open={ending !== null}
        title={ending ? `Disconnect ${name(ending.agentId)}?` : 'Disconnect?'}
        description="The agent can no longer use this device, and every folder shared with it here is closed."
        confirmLabel="Disconnect"
        danger
        onClose={() => setEnding(null)}
        onConfirm={async () => {
          if (!ending) return;
          await api.disconnectDevice(ending.id);
          setEnding(null);
          conns.reload();
          toast.show('Disconnected.', { tone: 'success' });
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
      } else setError(deviceErrorMessage(err, 'Could not connect.'));
      setBusy(false);
    }
  };

  const otherName = replace
    ? (devices?.find((d) => d.id === replace.deviceId)?.name ?? 'another device')
    : '';
  return (
    <Dialog
      open
      title={device ? `Connect an agent to ${device.name}` : 'Connect a computer'}
      description="The agent can use this device for the work you allow below, and nothing else."
      onClose={onClose}
    >
      {replace ? (
        <div className="stack">
          <p role="alert" className="ws-flush">
            This agent already uses {otherName} as its computer. Replace it? The agent loses access
            to {otherName}, and the folders shared with it there are closed.
          </p>
          <div className="nv-dialog-footer">
            <Button onClick={() => setReplace(null)}>Back</Button>
            <Button variant="danger" disabled={busy} onClick={() => void submit(true)}>
              Replace
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
                label="Agent"
                value={agentId}
                onChange={setAgentId}
                options={[
                  { value: '', label: 'Choose an agent' },
                  ...agents.agents.map((a) => ({ value: a.id, label: a.name })),
                ]}
              />
            ) : agents?.error ? (
              <LoadError
                error={agents.error}
                fallback="Could not load agents."
                onRetry={agents.reload}
              />
            ) : agents?.agents ? (
              <p className="ws-flush">
                You have no agents yet.{' '}
                <a href="/agents" onClick={(e) => followLink(e, '/agents')}>
                  Create one
                </a>{' '}
                first.
              </p>
            ) : (
              <Spinner label="Loading agents" />
            )
          ) : null}
          {!device ? (
            <SelectField
              label="Device"
              value={deviceId}
              onChange={setDeviceId}
              options={[
                { value: '', label: 'Choose a device' },
                ...(devices ?? [])
                  .filter((d) => d.status !== 'revoked')
                  .map((d) => ({
                    value: d.id,
                    label: d.routingEligible ? d.name : `${d.name} (kept out of agent work)`,
                    disabled: !d.routingEligible,
                  })),
              ]}
            />
          ) : null}
          <fieldset className="nv-radios">
            <legend className="nv-field-label">It may use</legend>
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
              Choose at least one.
            </p>
          ) : null}
          {refused.length ? (
            <p className="nv-field-error" role="alert">
              This device cannot serve {capsText(refused)} yet; uncheck{' '}
              {refused.length === 1 ? 'it' : 'them'}.
            </p>
          ) : null}
          {error ? (
            <p role="alert" className="nv-field-error">
              {error}
            </p>
          ) : null}
          <div className="nv-dialog-footer">
            <Button onClick={onClose}>Cancel</Button>
            <Button type="submit" variant="primary" disabled={!ready || busy}>
              {busy ? <Spinner /> : null} Connect
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

  return (
    <section className="ws-section devices-flat" aria-labelledby={`computer-${agentId}`}>
      <div className="ws-section-header">
        <h2 id={`computer-${agentId}`}>Your computer</h2>
        {conns.data ? (
          <Button onClick={() => setConnecting(true)}>
            {active ? 'Change computer' : 'Connect a computer'}
          </Button>
        ) : null}
      </div>
      <p className="muted ws-flush">
        {agentName} can use one of your devices at a time, for the work you allow.
      </p>
      {conns.error ? (
        <LoadError
          error={conns.error}
          fallback="Could not load the connection."
          onRetry={conns.reload}
        />
      ) : null}
      {conns.loading ? <Spinner label="Loading the connection" /> : null}
      {conns.data && !active ? (
        <EmptyState
          title="No computer connected"
          description="Connect a device running novad, or let the agent use its cloud computer."
          icon="server"
          level={3}
        />
      ) : null}
      {active ? (
        <div className="ws-list-row">
          <div className="devices-row-main">
            <a
              href={devicePath(active.deviceId)}
              className="ws-card-link"
              onClick={(e) => followLink(e, devicePath(active.deviceId))}
            >
              {active.deviceName || 'Device'}
            </a>
            <span className="muted ws-row-meta">
              <span>May use: {capsText(active.capabilities)}</span>
              <span>Connected {formatWhen(active.createdAt)}</span>
            </span>
          </div>
          <Button onClick={() => setEnding(active)}>Disconnect</Button>
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
              toast.show(`${agentName} now uses ${c.deviceName} as its computer.`, {
                tone: 'success',
              });
            }}
          />
        ) : (
          <Dialog open title="Connect a computer" onClose={() => setConnecting(false)}>
            {devices.error ? (
              <LoadError
                error={devices.error}
                fallback="Could not load devices."
                onRetry={devices.reload}
              />
            ) : (
              <Spinner label="Loading devices" />
            )}
          </Dialog>
        )
      ) : null}
      <ConfirmDialog
        open={ending !== null}
        title={`Disconnect ${ending?.deviceName || 'this computer'}?`}
        description={`${agentName} can no longer use it, and every folder shared with it there is closed.`}
        confirmLabel="Disconnect"
        danger
        onClose={() => setEnding(null)}
        onConfirm={async () => {
          if (!ending) return;
          await api.disconnectDevice(ending.id);
          setEnding(null);
          conns.reload();
          toast.show('Disconnected.', { tone: 'success' });
        }}
      />
    </section>
  );
}
