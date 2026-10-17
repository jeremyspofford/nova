// M6 screen area: filled in by its area (see packages/core/src/computers/types.ts and
// channels/types.ts for the seams).
import type { FastifyInstance } from 'fastify';
import type { HubArea, HubContext } from './hub-context.ts';

export function setupScreen(_ctx: HubContext): Promise<HubArea> {
  return Promise.resolve({
    register(_app: FastifyInstance): void {},
    close: () => Promise.resolve(),
  });
}
