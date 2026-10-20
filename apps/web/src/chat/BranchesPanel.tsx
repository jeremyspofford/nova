// Branches (FR-033): the open chat's lineage as a tree (root, branches and side chats with their
// message counts). Enter or a click opens a chat; Space selects up to two for a side-by-side
// compare at /chat/<id>?compare=<id2>.
import { useEffect, useState } from 'react';
import type { ThreadTree } from '@nova/shared';
import { defineMessages } from '@nova/i18n';
import { Button, Icon, Spinner, Tree, type TreeNode } from '@nova/ui';
import { errorMessage } from '../api.ts';
import { chatPath, navigate } from '../router.ts';
import { useServices } from '../services.tsx';

export const BRANCHES_TEXT = defineMessages('chat.branches', {
  title: 'Branches',
  loadFailed: 'Could not load branches.',
  openChat: 'Open a chat to see its branches.',
  retry: 'Retry',
  loading: 'Loading branches',
  loadingDots: 'Loading branches…',
  sideChat: 'Side chat: {title}',
  untitled: 'Untitled chat',
  messages: '{n, plural, one {# message} other {# messages}}',
  hint: 'Enter opens a chat. Space selects two to compare.',
  none: 'No branches yet. Use “Branch from here” on a message to start one.',
  compare: 'Compare selected',
});

export function comparePath(a: string, b: string): string {
  return `${chatPath(a)}?compare=${encodeURIComponent(b)}`;
}

export function BranchesPanel({ threadId }: { threadId: string | null }) {
  const { api } = useServices();
  const [tree, setTree] = useState<{ of: string; data: ThreadTree } | null>(null);
  const [error, setError] = useState<{ of: string; message: string } | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!threadId) return;
    let alive = true;
    api.threadTree(threadId).then(
      (data) => {
        if (!alive) return;
        setTree({ of: threadId, data });
        setError(null);
      },
      (err: unknown) => {
        if (alive) setError({ of: threadId, message: errorMessage(err, BRANCHES_TEXT.loadFailed) });
      },
    );
    return () => {
      alive = false;
    };
  }, [api, threadId, attempt]);

  if (!threadId) return <p className="muted">{BRANCHES_TEXT.openChat}</p>;

  const failed = error?.of === threadId ? error.message : null;
  if (failed)
    return (
      <div className="branches" role="alert">
        <p>{failed}</p>
        <Button onClick={() => setAttempt((n) => n + 1)}>{BRANCHES_TEXT.retry}</Button>
      </div>
    );
  const data = tree?.of === threadId ? tree.data : null;
  if (!data)
    return (
      <p className="muted">
        <Spinner label={BRANCHES_TEXT.loading} /> {BRANCHES_TEXT.loadingDots}
      </p>
    );

  const ids = new Set(data.nodes.map((n) => n.threadId));
  const picked = selected.filter((id) => ids.has(id));
  const nodes: TreeNode[] = data.nodes.map((n) => {
    const title = n.title?.trim() || BRANCHES_TEXT.untitled;
    return {
      id: n.threadId,
      parentId: n.parentThreadId,
      label: n.side ? BRANCHES_TEXT.sideChat({ title }) : title,
      detail: BRANCHES_TEXT.messages({ n: n.messageCount }),
    };
  });
  const [a, b] = picked;

  return (
    <div className="branches">
      {data.nodes.length > 1 ? (
        <p className="muted branches-hint">{BRANCHES_TEXT.hint}</p>
      ) : (
        <p className="muted branches-hint">{BRANCHES_TEXT.none}</p>
      )}
      <Tree
        label={BRANCHES_TEXT.title}
        nodes={nodes}
        currentId={threadId}
        selected={picked}
        onToggleSelect={(id) =>
          setSelected(
            picked.includes(id) ? picked.filter((x) => x !== id) : [...picked.slice(-1), id],
          )
        }
        onActivate={(id) => navigate(chatPath(id))}
      />
      <Button
        disabled={!a || !b}
        onClick={() => {
          if (a && b) navigate(comparePath(a, b));
        }}
      >
        <Icon name="compare" /> {BRANCHES_TEXT.compare}
      </Button>
    </div>
  );
}
