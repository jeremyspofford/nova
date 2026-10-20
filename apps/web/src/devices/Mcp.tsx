// Local MCP servers (FR-210; docs/23 §4.1): the device's stdio MCP servers that novad exposes to
// Hub sessions under its grants, with their tools. Agents call them through the Hub's policy and
// audit; here they are read-only. Names and descriptions come from the device and are untrusted,
// so they are shown as text. Sharing a server with an agent is under Files.
import type { DeviceView } from '@nova/shared';
import { Spinner } from '@nova/ui';
import { defineMessages } from '@nova/i18n';
import { rich } from '../i18n/rich.tsx';
import { useDevicesApi, type DeviceMcpServer } from './api.ts';
import type { PanelProps } from './DevicePage.tsx';
import { capabilityBlocked, devicePath } from './format.ts';
import { followLink } from '../work/nav.tsx';
import { LoadError, Unavailable, useLoad } from './parts.tsx';

export const MCP_TEXT = defineMessages('devices.mcp', {
  title: 'Local MCP servers',
  intro:
    'Tools that run on this device, sandboxed by novad. Agents call them through this Hub’s permissions and audit, and their output is treated as untrusted. To let an agent use one, share it in {files}.',
  files: 'Files',
  listFailed: 'Could not list the servers.',
  listing: 'Listing the servers',
  none: 'No local MCP servers are shared with you on this device.',
  toolsOf: 'Tools of {name}',
  noTools: 'No tools listed.',
});
const S = MCP_TEXT;

export interface McpServerInfo {
  name: string;
  tools: { name: string; description: string | null }[];
}

/** The device's answer, with anything malformed dropped. */
export function mcpServers(list: readonly DeviceMcpServer[]): McpServerInfo[] {
  return list.flatMap((s) => {
    if (typeof s.name !== 'string' || !s.name) return [];
    const tools = Array.isArray(s.tools) ? s.tools : [];
    return [
      {
        name: s.name,
        tools: tools.flatMap((t: unknown) => {
          if (typeof t !== 'object' || t === null) return [];
          const r = t as Record<string, unknown>;
          return typeof r.name === 'string'
            ? [
                {
                  name: r.name,
                  description: typeof r.description === 'string' ? r.description : null,
                },
              ]
            : [];
        }),
      },
    ];
  });
}

export function McpPanel({ device }: PanelProps) {
  const blocked = capabilityBlocked(device, 'mcp');
  return (
    <section className="ws-section devices-flat" aria-labelledby="mcp-h">
      <h2 id="mcp-h">{S.title}</h2>
      <p className="muted ws-flush">
        {rich(S.intro, {
          files: (
            <a
              href={devicePath(device.id, 'files')}
              onClick={(e) => followLink(e, devicePath(device.id, 'files'))}
            >
              {S.files}
            </a>
          ),
        })}
      </p>
      {blocked ? <Unavailable>{blocked}</Unavailable> : <ServerList device={device} />}
    </section>
  );
}

function ServerList({ device }: { device: DeviceView }) {
  const api = useDevicesApi();
  const list = useLoad(
    () => api.listDeviceMcp(device.id).then((r) => mcpServers(r.servers)),
    device.id,
  );
  return (
    <>
      {list.error ? (
        <LoadError error={list.error} fallback={S.listFailed} onRetry={list.reload} />
      ) : null}
      {list.loading ? <Spinner label={S.listing} /> : null}
      {list.data?.length === 0 ? <p className="muted ws-flush">{S.none}</p> : null}
      {list.data?.length ? (
        <ul className="ws-cards" aria-label={S.title}>
          {list.data.map((s) => (
            <li key={s.name} className="ws-card" aria-label={s.name}>
              <strong dir="auto">{s.name}</strong>
              {s.tools.length ? (
                <ul className="devices-tools" aria-label={S.toolsOf({ name: s.name })}>
                  {s.tools.map((t) => (
                    <li key={t.name}>
                      <code className="ws-code-inline">{t.name}</code>
                      {t.description ? (
                        <span className="muted" dir="auto">
                          {' '}
                          {t.description}
                        </span>
                      ) : null}
                    </li>
                  ))}
                </ul>
              ) : (
                <span className="muted">{S.noTools}</span>
              )}
            </li>
          ))}
        </ul>
      ) : null}
    </>
  );
}
