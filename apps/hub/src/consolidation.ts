// Memory consolidation and the history-reference toggle (FR-204, FR-205). Filled in by M3.
import type { MemoryService } from '@nova/core';
import type { HubArea, HubContext } from './hub-context.ts';

export function setupConsolidation(_ctx: HubContext & { memory: MemoryService }): Promise<HubArea> {
  return Promise.resolve({ register: () => undefined, close: () => Promise.resolve() });
}
