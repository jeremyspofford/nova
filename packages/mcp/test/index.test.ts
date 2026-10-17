import { expect, it } from 'vitest';
import { MCP_CLIENT_NAME } from '../src/index.ts';

it('names the client', () => {
  expect(MCP_CLIENT_NAME).toBe('nova');
});
