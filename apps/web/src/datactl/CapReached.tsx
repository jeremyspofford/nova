// The cap-reached state of a chat reply (FR-116): a call a spend cap stopped fails with an error
// part whose `details` say `{reason: 'spend_cap', provider}` (older parts: `over_budget` and the
// Hub's sentence naming the provider); the error then links to that provider's cap on Settings →
// Profile & usage, where it can be raised.
import { Icon } from '@nova/ui';
import { InAppLink } from '../managed/link.tsx';
import { SPEND_STRINGS as S, capPath, capReachedProvider } from './format.ts';

export function CapReachedAction({
  code,
  message,
  details,
}: {
  code: string;
  message: string;
  details?: { reason: string; provider?: string } | null;
}) {
  const provider = capReachedProvider(code, message, details);
  if (provider === undefined) return null;
  return (
    <InAppLink to={capPath(provider)} className="nv-btn dc-raise">
      <Icon name="settings" /> {S.raiseCap}
    </InAppLink>
  );
}
