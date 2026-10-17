// M5 requests area (see packages/core/src/runtime/types.ts for the seams): filled in by its area.
import type { FastifyInstance } from 'fastify';
import type { HubArea, HubContext } from './hub-context.ts';

export function setupRequests(_ctx: HubContext): Promise<HubArea> {
  return Promise.resolve({
    register(_app: FastifyInstance): void {},
    close: () => Promise.resolve(),
  });
}
