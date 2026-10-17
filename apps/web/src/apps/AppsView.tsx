// MCP Apps (FR-198): global entry points, and one app full screen at /apps/<entry>. Filled in by M4.
import { EmptyState } from '@nova/ui';

export function AppsView({ entryId }: { entryId: string | null }) {
  return (
    <EmptyState
      title={entryId ? 'App' : 'Apps'}
      description="Apps from your plugins and MCP servers appear here."
      level={2}
    />
  );
}

/** The Inspector's Apps tab: the open chat's thread entry points. Filled in by M4. */
export function ThreadApps({ threadId }: { threadId: string | null }) {
  return (
    <p className="muted">
      {threadId ? 'Apps for this chat appear here.' : 'Open a chat to see its apps.'}
    </p>
  );
}
