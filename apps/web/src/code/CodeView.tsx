// Code mode (FR-061..FR-066, FR-069): sessions, the session view with chat, diff, review and
// terminal. Filled in by the Code UI.
import { EmptyState } from '@nova/ui';

export function CodeView({ id }: { id: string | null }) {
  return (
    <EmptyState
      title={id ? 'Code session' : 'Code'}
      description="Code sessions arrive with M5."
      icon="code"
      level={2}
    />
  );
}
