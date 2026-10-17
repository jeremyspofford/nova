// Settings → Devices (FR-126, docs/04 §9, docs/14 §7): compute nodes that run models for this Hub.
// "Add compute node" creates a one-use enrollment token (creating it is the approval, ADR-089) and
// shows the command to run on the node; Revoke stops a node's credential at once. The list
// refreshes every 5 s while the page is open.
import { useEffect, useRef, useState } from 'react';
import type { NodeEnrollToken, NodeView } from '@nova/shared';
import { Button, Dialog, Icon, Spinner, useToast, type IconName } from '@nova/ui';
import { errorMessage } from '../api.ts';
import { useServices } from '../services.tsx';
import { useModels } from '../stores.tsx';
import { formatWhen, plural, useInterval } from './common.ts';
import '../workspace.css';

export const NODE_POLL_MS = 5000;
/** The backend a fresh node talks to; Ollama's default address on that machine. */
export const DEFAULT_NODE_BACKEND = 'http://127.0.0.1:11434';

/** The exact command to run on the node being added. */
export function enrollCommand(hubOrigin: string, token: string): string {
  return `nova-compute enroll --hub ${hubOrigin} --token ${token} --backend ${DEFAULT_NODE_BACKEND}`;
}

const NODE_STATUS: Record<
  NodeView['status'],
  { text: string; icon: IconName | null; tone: string }
> = {
  active: { text: 'Active', icon: 'check', tone: 'ready' },
  pending: { text: 'Waiting for first contact', icon: null, tone: 'running' },
  unreachable: { text: 'Unreachable', icon: 'alert', tone: 'needs_input' },
  revoked: { text: 'Revoked', icon: 'stop', tone: 'blocked' },
};

function NodeStatusChip({ status }: { status: NodeView['status'] }) {
  const s = NODE_STATUS[status];
  return (
    <span className="nv-chip" data-status={s.tone}>
      {s.icon ? <Icon name={s.icon} /> : <Spinner />}
      <span>{s.text}</span>
    </span>
  );
}

function formatVram(bytes: number | null): string | null {
  if (!bytes) return null;
  return `${(bytes / 1024 ** 3).toFixed(bytes >= 10 * 1024 ** 3 ? 0 : 1)} GB VRAM`;
}

export function DevicesPage() {
  const { api } = useServices();
  const models = useModels();
  const toast = useToast();
  const [nodes, setNodes] = useState<NodeView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  const [adding, setAdding] = useState(false);
  const [revoking, setRevoking] = useState<NodeView | null>(null);

  useEffect(() => {
    let alive = true;
    api.listNodes().then(
      ({ items }) => {
        if (!alive) return;
        setNodes(items);
        setError(null);
      },
      (err: unknown) => alive && setError(errorMessage(err, 'Could not load compute nodes.')),
    );
    return () => {
      alive = false;
    };
  }, [api, version]);
  useInterval(() => setVersion((v) => v + 1), NODE_POLL_MS);

  const revoke = async (n: NodeView) => {
    setRevoking(null);
    try {
      await api.revokeNode(n.id);
      setNodes(
        (list) => list?.map((x) => (x.id === n.id ? { ...x, status: 'revoked' } : x)) ?? null,
      );
      toast.show(`${n.name} revoked. Its models are no longer offered.`, { tone: 'success' });
      void models.refresh();
    } catch (err) {
      toast.show(`Could not revoke ${n.name}: ${errorMessage(err)}`, { tone: 'error' });
    }
  };

  return (
    <div className="settings-page">
      <h2>Devices</h2>
      <section className="settings-section" aria-labelledby="devices-nodes">
        <h3 id="devices-nodes">Compute nodes</h3>
        <p className="muted">
          Computers that run models for this Hub. A node only runs work this Hub sends it, and it
          never connects to your other devices.
        </p>
        <div className="row">
          <Button variant="primary" onClick={() => setAdding(true)}>
            <Icon name="plus" /> Add compute node
          </Button>
        </div>
        {error ? (
          <div role="alert" className="ws-error">
            <p>{error}</p>
            <Button onClick={() => setVersion((v) => v + 1)}>Retry</Button>
          </div>
        ) : null}
        {nodes === null && !error ? <Spinner label="Loading compute nodes" /> : null}
        {nodes?.length === 0 ? <p className="muted">No compute nodes yet.</p> : null}
        {nodes?.length ? (
          <ul className="ws-list" aria-label="Compute nodes">
            {nodes.map((n) => {
              const caps = [
                n.capabilities.gpus ? plural(n.capabilities.gpus, 'GPU') : 'No GPU',
                formatVram(n.capabilities.vramBytes),
                `up to ${plural(n.capabilities.maxConcurrentJobs, 'job')} at once`,
              ].filter(Boolean);
              return (
                <li key={n.id} className="ws-list-row ws-node" aria-label={n.name}>
                  <div className="ws-source-main">
                    <strong>{n.name}</strong>
                    <NodeStatusChip status={n.status} />
                    <code className="ws-code-inline">{n.endpoint}</code>
                    <span className="muted ws-row-meta">{caps.join(' · ')}</span>
                    <span className="muted ws-row-meta">
                      {n.models.length
                        ? `${plural(n.models.length, 'model')}: ${n.models.join(', ')}`
                        : 'No models reported'}
                    </span>
                    <span className="muted ws-row-meta">
                      {n.load
                        ? `${n.load.running} running, ${n.load.queued} queued`
                        : 'Load not reported'}{' '}
                      · last seen {formatWhen(n.lastSeenAt)}
                    </span>
                  </div>
                  {n.status !== 'revoked' ? (
                    <Button variant="ghost" onClick={() => setRevoking(n)}>
                      Revoke
                    </Button>
                  ) : null}
                </li>
              );
            })}
          </ul>
        ) : null}
      </section>
      <AddNodeDialog
        open={adding}
        onClose={() => {
          setAdding(false);
          setVersion((v) => v + 1);
        }}
      />
      <Dialog
        open={revoking !== null}
        title={revoking ? `Revoke ${revoking.name}?` : 'Revoke this node?'}
        description="Its credential stops working at once and its models leave the model list. To use it again, enroll it with a new token."
        onClose={() => setRevoking(null)}
        footer={
          <>
            <Button onClick={() => setRevoking(null)}>Cancel</Button>
            <Button variant="danger" onClick={() => revoking && void revoke(revoking)}>
              Revoke
            </Button>
          </>
        }
      />
    </div>
  );
}

function AddNodeDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  return open ? <AddNode onClose={onClose} /> : null;
}

/** "14:59", or "0:00" once expired. */
export function formatCountdown(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function AddNode({ onClose }: { onClose: () => void }) {
  const { api } = useServices();
  const toast = useToast();
  const [token, setToken] = useState<NodeEnrollToken | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [attempt, setAttempt] = useState(0);
  const commandRef = useRef<HTMLElement>(null);

  useEffect(() => {
    let alive = true;
    api.createNodeEnrollToken().then(
      (t) => {
        if (!alive) return;
        setToken(t);
        setError(null);
        setNow(Date.now());
      },
      (err: unknown) => alive && setError(errorMessage(err, 'Could not create a token.')),
    );
    return () => {
      alive = false;
    };
  }, [api, attempt]);

  const left = token ? Date.parse(token.expiresAt) - now : 0;
  const expired = token !== null && left <= 0;
  useInterval(() => setNow(Date.now()), 1000, token !== null && !expired);
  const command = token ? enrollCommand(window.location.origin, token.token) : '';

  const copy = async () => {
    try {
      if (!navigator.clipboard) throw new Error('no clipboard');
      await navigator.clipboard.writeText(command);
      toast.show('Command copied.', { tone: 'success' });
    } catch {
      // Select the text so the user can copy it by hand.
      const el = commandRef.current;
      const sel = window.getSelection();
      if (el && sel) {
        const range = document.createRange();
        range.selectNodeContents(el);
        sel.removeAllRanges();
        sel.addRange(range);
      }
      toast.show('Could not copy. The command is selected; copy it with your keyboard.', {
        tone: 'error',
      });
    }
  };

  return (
    <Dialog
      open
      title="Add a compute node"
      description="Run this command on the computer you want to add. The token works once."
      onClose={onClose}
      footer={
        <Button variant="primary" onClick={onClose}>
          Done
        </Button>
      }
    >
      {error ? (
        <div role="alert" className="ws-error">
          <p>{error}</p>
          <Button onClick={() => setAttempt((a) => a + 1)}>Try again</Button>
        </div>
      ) : null}
      {!token && !error ? <Spinner label="Creating a token" /> : null}
      {token ? (
        <div className="stack">
          <pre className="ws-command">
            <code ref={commandRef}>{command}</code>
          </pre>
          <div className="row">
            <Button onClick={() => void copy()} disabled={expired}>
              Copy command
            </Button>
            {expired ? (
              <Button variant="primary" onClick={() => setAttempt((a) => a + 1)}>
                Create a new token
              </Button>
            ) : null}
          </div>
          {expired ? (
            <p role="alert" className="nv-field-error">
              This token has expired. Create a new one to add the node.
            </p>
          ) : (
            <p className="muted">
              Expires in <span role="timer">{formatCountdown(left)}</span>. Change --backend if the
              node&apos;s model server is not Ollama on its default address.
            </p>
          )}
          <p className="muted">
            The node appears in the list once it registers. Close this when you are done.
          </p>
        </div>
      ) : null}
    </Dialog>
  );
}
