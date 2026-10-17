// Thread status chip (docs/04 §1.1, FR-215): one of four states derived from runtime state, never
// from model text. M1 shows the chip; notifications and sorting by status arrive with FR-215.
import type { ThreadView } from '@nova/shared';
import type { Status } from '@nova/ui';

export function threadStatus(thread: Pick<ThreadView, 'state'>, streamingHere = false): Status {
  if (thread.state === 'waiting_approval' || thread.state === 'waiting_input') return 'needs_input';
  if (thread.state === 'error') return 'blocked';
  if (streamingHere || thread.state === 'streaming') return 'running';
  return 'ready';
}
