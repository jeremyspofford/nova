// Slack, Teams and (since M7) email as schedule delivery targets (FR-055, FR-187): the scheduler's
// `useChannel(kind, channel)` takes these. A target's `ref` is a channel binding id; the receipt
// is the message id the service returned, so a delivery counts only when the message was posted.
import type { DeliveryChannel } from '../scheduler/delivery.ts';
import type { ChannelKind, ChannelReceipt } from './types.ts';

export interface DeliverySender {
  sendTo(
    accountId: string,
    bindingId: string,
    text: string,
    opts?: { kinds?: readonly ChannelKind[] },
  ): Promise<ChannelReceipt>;
}

const MAX_TEXT = 3500;

export function channelDelivery(
  sender: DeliverySender,
  kind: 'slack' | 'teams' | 'email',
): DeliveryChannel {
  return {
    async deliver(req, target) {
      if (!target.ref)
        return { receipt: null, error: `a ${kind} delivery needs a channel binding as its ref` };
      const text = `${req.title}\n\n${req.message}`;
      try {
        const r = await sender.sendTo(
          req.accountId,
          target.ref,
          text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT - 1)}…` : text,
          { kinds: [kind] },
        );
        return { receipt: `${kind}:${r.id}` };
      } catch (err) {
        return {
          receipt: null,
          error: `the ${kind} message was not sent: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    },
  };
}
