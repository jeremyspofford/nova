// MCP event subscriptions, client side (FR-201, docs/09 §7). A server that offers events
// advertises them in its handshake as the experimental capability `nova/events`
// (`{events: [{name, description?}]}`) and answers three requests:
//   nova/events/subscribe   {event, webhook: {url, secret}, filter?, ttlSeconds} → {subscriptionId, expiresAt?}
//   nova/events/refresh     {subscriptionId, ttlSeconds}                     → {expiresAt?}
//   nova/events/unsubscribe {subscriptionId}                                 → {}
// It then POSTs each event to the webhook URL with `x-nova-event-id`, `x-nova-event-timestamp`
// (Unix seconds) and `x-nova-event-signature: sha256=<hex>`, the HMAC-SHA256 of
// `<id>.<timestamp>.<body>` with the secret; bodies are at most 256 KiB. The Hub's receiver
// (@nova/core McpEventService) checks all of it. `McpEventsClient` is structurally the core's
// `McpEventSource`.
import type { Client } from '@modelcontextprotocol/client';

export const MCP_EVENTS_CAPABILITY = 'nova/events';
export const MCP_EVENTS_METHODS = {
  subscribe: 'nova/events/subscribe',
  refresh: 'nova/events/refresh',
  unsubscribe: 'nova/events/unsubscribe',
} as const;

export interface McpEventInfo {
  name: string;
  description: string | null;
}

/** What the client needs of a connection: its handshake capabilities and a raw request. */
export interface McpEventTransport {
  /** The server's capabilities from the handshake; null while it is not connected. */
  capabilities(serverId: string): Record<string, unknown> | null;
  request(
    serverId: string,
    method: string,
    params: Record<string, unknown>,
    opts: { signal: AbortSignal; timeoutMs?: number },
  ): Promise<unknown>;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/** The events a capabilities object advertises; null when there are no capabilities. */
export function advertisedEvents(
  capabilities: Record<string, unknown> | null,
): McpEventInfo[] | null {
  if (!capabilities) return null;
  const experimental = isRecord(capabilities.experimental) ? capabilities.experimental : {};
  const cap = experimental[MCP_EVENTS_CAPABILITY];
  if (!isRecord(cap) || !Array.isArray(cap.events)) return [];
  const out: McpEventInfo[] = [];
  for (const e of cap.events) {
    if (!isRecord(e) || typeof e.name !== 'string' || !e.name || e.name.length > 200) continue;
    const description = typeof e.description === 'string' ? e.description.slice(0, 500) : null;
    out.push({ name: e.name, description });
  }
  return out;
}

function protocolError(message: string): Error {
  return Object.assign(new Error(message), { code: 'mcp.protocol_error' });
}

function isoOrNull(v: unknown): string | null {
  if (typeof v !== 'string' || !Number.isFinite(Date.parse(v))) return null;
  return new Date(v).toISOString();
}

export class McpEventsClient {
  readonly #t: McpEventTransport;
  readonly #timeoutMs: number;

  constructor(transport: McpEventTransport, opts: { timeoutMs?: number } = {}) {
    this.#t = transport;
    this.#timeoutMs = opts.timeoutMs ?? 15_000;
  }

  /** The events a connected server advertises; null when it is not connected. */
  events(serverId: string): McpEventInfo[] | null {
    return advertisedEvents(this.#t.capabilities(serverId));
  }

  async subscribe(
    serverId: string,
    input: {
      event: string;
      webhookUrl: string;
      secret: string;
      filter: Record<string, unknown> | null;
      ttlSeconds: number;
    },
    signal: AbortSignal,
  ): Promise<{ remoteId: string; expiresAt: string | null }> {
    this.#require(serverId, input.event);
    const res = await this.#t.request(
      serverId,
      MCP_EVENTS_METHODS.subscribe,
      {
        event: input.event,
        webhook: { url: input.webhookUrl, secret: input.secret },
        ...(input.filter ? { filter: input.filter } : {}),
        ttlSeconds: input.ttlSeconds,
      },
      { signal, timeoutMs: this.#timeoutMs },
    );
    if (!isRecord(res) || typeof res.subscriptionId !== 'string' || !res.subscriptionId)
      throw protocolError('the server did not return a subscription id');
    return { remoteId: res.subscriptionId.slice(0, 500), expiresAt: isoOrNull(res.expiresAt) };
  }

  async refresh(
    serverId: string,
    remoteId: string,
    ttlSeconds: number,
    signal: AbortSignal,
  ): Promise<{ expiresAt: string | null }> {
    const res = await this.#t.request(
      serverId,
      MCP_EVENTS_METHODS.refresh,
      { subscriptionId: remoteId, ttlSeconds },
      { signal, timeoutMs: this.#timeoutMs },
    );
    return { expiresAt: isRecord(res) ? isoOrNull(res.expiresAt) : null };
  }

  async unsubscribe(serverId: string, remoteId: string, signal: AbortSignal): Promise<void> {
    await this.#t.request(
      serverId,
      MCP_EVENTS_METHODS.unsubscribe,
      { subscriptionId: remoteId },
      { signal, timeoutMs: this.#timeoutMs },
    );
  }

  #require(serverId: string, event: string): void {
    const events = this.events(serverId);
    if (events === null)
      throw Object.assign(new Error('the MCP server is not connected'), {
        code: 'mcp.unavailable',
      });
    if (!events.some((e) => e.name === event))
      throw protocolError(`the server does not advertise the event ${event}`);
  }
}

/** Accepts any result; the client checks the fields it reads (a Standard Schema). */
const anyResult = {
  '~standard': {
    version: 1 as const,
    vendor: 'nova',
    validate: (value: unknown) => ({ value }),
  },
};

/** A transport over SDK clients by server id (tests and callers that hold a `Client`). */
export function sdkClientTransport(
  clientOf: (serverId: string) => Client | null,
): McpEventTransport {
  return {
    capabilities: (serverId) => {
      return clientOf(serverId)?.getServerCapabilities() ?? null;
    },
    request: async (serverId, method, params, opts) => {
      const client = clientOf(serverId);
      if (!client)
        throw Object.assign(new Error('the MCP server is not connected'), {
          code: 'mcp.unavailable',
        });
      return client.request({ method, params }, anyResult, {
        signal: opts.signal,
        ...(opts.timeoutMs ? { timeout: opts.timeoutMs } : {}),
      });
    },
  };
}
