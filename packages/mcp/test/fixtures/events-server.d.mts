// Types for the MCP events fixture (events-server.mjs).
import type { McpServer } from '@modelcontextprotocol/server';

export const EVENTS: { name: string; description: string }[];

export interface EventsServerOptions {
  ttlSeconds?: number;
  fetch?: (
    url: string,
    init: { method: string; headers: Record<string, string>; body: string },
  ) => Promise<{ status: number }>;
  now?: () => number;
}

export interface FixtureSubscription {
  event: string;
  url: string;
  secret: string;
  filter: Record<string, unknown> | null;
  expiresAt: string;
  refreshes: number;
}

export function createEventsServer(options?: EventsServerOptions): {
  server: McpServer;
  subscriptions: Map<string, FixtureSubscription>;
};
export function signDelivery(secret: string, id: string, timestamp: string, body: string): string;
