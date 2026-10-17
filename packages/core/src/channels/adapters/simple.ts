// The in-app channel (the agent's own thread: replies are already there) and email, which is
// modelled but not configured: reading a mailbox and sending through SMTP arrive with the email
// connector, so email bindings cannot be created yet and the adapter refuses both directions.
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

export const EMAIL_UNAVAILABLE =
  'email channels are not available yet: they need a connected mailbox (IMAP and SMTP)';

export class EmailAdapter implements NovaChannelAdapter {
  readonly kind = 'email' as const;

  availability(): { available: boolean; detail: string | null } {
    return { available: false, detail: EMAIL_UNAVAILABLE };
  }

  parse(): Promise<InboundMessage | null> {
    return Promise.reject(new NovaError('capability_missing', EMAIL_UNAVAILABLE));
  }

  send(): Promise<ChannelReceipt> {
    return Promise.reject(new NovaError('capability_missing', EMAIL_UNAVAILABLE));
  }
}
