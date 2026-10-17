// M5 code area (see packages/core/src/runtime/types.ts for the seams): filled in by its area.
import type { FastifyInstance } from 'fastify';
import type { HubArea, HubContext } from './hub-context.ts';

export function setupCode(_ctx: HubContext): Promise<HubArea> {
  return Promise.resolve({
    register(_app: FastifyInstance): void {},
    close: () => Promise.resolve(),
  });
}
