// The in-app channel: the agent's own thread, where replies already are. (Email, a stub here in
// M6, is a real adapter since M7: adapters/email.ts.)
import { NovaError, uuidv7 } from '@nova/shared';
import type { ChannelReceipt, InboundMessage } from '../types.ts';
import type { NovaChannelAdapter } from './common.ts';

export class InAppAdapter implements NovaChannelAdapter {
  readonly kind = 'inapp' as const;
  readonly #now: () => Date;

  constructor(opts: { now?: () => Date } = {}) {
    this.#now = opts.now ?? (() => new Date());
  }

  parse(): Promise<InboundMessage | null> {
    // In-app messages come through the chat API with the user's session, never through here.
    return Promise.reject(
      new NovaError('not_found', 'in-app messages are sent from a Nova client'),
    );
  }

  send(): Promise<ChannelReceipt> {
    // The reply is a message of the thread already.
    return Promise.resolve({ id: `inapp:${uuidv7()}`, at: this.#now().toISOString() });
  }
}
