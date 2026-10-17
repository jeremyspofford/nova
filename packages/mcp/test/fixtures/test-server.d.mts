// Types for the test server fixture (test-server.mjs).
import type { McpServer } from '@modelcontextprotocol/server';

export interface TestServerOptions {
  extraTools?: number;
  testHooks?: boolean;
  /** Add an MCP Apps tool with a `ui://` resource and `client_caps`. */
  apps?: boolean;
  protocolVersions?: string[];
  log?: (line: string) => void;
}

export function createTestServer(options?: TestServerOptions): McpServer;
export function extraToolDescription(i: number): string;
