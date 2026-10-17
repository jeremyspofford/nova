// Branches (FR-033): the open chat's lineage as a tree (root, branches and side chats with their
// message counts). Enter or a click opens a chat; Space selects up to two for a side-by-side
// compare at /chat/<id>?compare=<id2>.
import { useEffect, useState } from 'react';
import type { ThreadTree } from '@nova/shared';
import { Button, Icon, Spinner, Tree, type TreeNode } from '@nova/ui';
import { errorMessage } from '../api.ts';
import { chatPath, navigate } from '../router.ts';
import { useServices } from '../services.tsx';

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
        if (alive)
          setError({ of: threadId, message: errorMessage(err, 'Could not load branches.') });
      },
    );
    return () => {
      alive = false;
    };
  }, [api, threadId, attempt]);

  if (!threadId) return <p className="muted">Open a chat to see its branches.</p>;

  const failed = error?.of === threadId ? error.message : null;
  if (failed)
    return (
      <div className="branches" role="alert">
        <p>{failed}</p>
        <Button onClick={() => setAttempt((n) => n + 1)}>Retry</Button>
      </div>
    );
  const data = tree?.of === threadId ? tree.data : null;
  if (!data)
    return (
      <p className="muted">
        <Spinner label="Loading branches" /> Loading branches…
      </p>
    );

  const ids = new Set(data.nodes.map((n) => n.threadId));
  const picked = selected.filter((id) => ids.has(id));
  const nodes: TreeNode[] = data.nodes.map((n) => ({
    id: n.threadId,
    parentId: n.parentThreadId,
    label: `${n.side ? 'Side chat: ' : ''}${n.title?.trim() || 'Untitled chat'}`,
    detail: `${n.messageCount} ${n.messageCount === 1 ? 'message' : 'messages'}`,
  }));
  const [a, b] = picked;

  return (
    <div className="branches">
      {data.nodes.length > 1 ? (
        <p className="muted branches-hint">Enter opens a chat. Space selects two to compare.</p>
      ) : (
        <p className="muted branches-hint">
          No branches yet. Use “Branch from here” on a message to start one.
        </p>
      )}
      <Tree
        label="Branches"
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
        <Icon name="compare" /> Compare selected
      </Button>
    </div>
  );
}
