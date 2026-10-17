// Device files (FR-210; docs/23 §4.1): folder-access requests waiting for an answer, staged writes
// to review, the folders shared with you (browse and preview, read through novad), and every
// grant on the device (who may read or change which folder, or call which local MCP server),
// with Share and Revoke. File contents and request reasons come from the device or a session and
// are shown as text only.
import { useId, useRef, useState } from 'react';
import {
  DEVICE_GRANTEE_KINDS,
  type DeviceAccessRequestView,
  type DeviceDirent,
  type DeviceGrantee,
  type DeviceView,
} from '@nova/shared';
import { Button, Dialog, Icon, SelectField, Spinner, TextField, useToast } from '@nova/ui';
import { ApiError } from '../api.ts';
import { formatWhen } from '../settings/common.ts';
import { useServices } from '../services.tsx';
import { useDevicesApi, type DeviceFileContent } from './api.ts';
import { useAgentChoices } from './Connections.tsx';
import type { PanelProps } from './DevicePage.tsx';
import { GRANT_EVENTS, eventDeviceId, useDeviceEvents } from './events.ts';
import {
  GRANTEE_KIND_LABEL,
  PREVIEW_BYTES,
  accessText,
  capabilityBlocked,
  decodeBase64,
  deviceErrorMessage,
  errorReason,
  formatBytes,
  granteeText,
  joinPath,
  pathCrumbs,
  pathProblem,
  previewText,
} from './format.ts';
import { ConfirmDialog, LoadError, Unavailable, useLoad, type Loaded } from './parts.tsx';
import { StagedWrites } from './StagedWrites.tsx';

type Grants = Loaded<DeviceAccessRequestView[]>;

export function FilesPanel({ device }: PanelProps) {
  const api = useDevicesApi();
  const agents = useAgentChoices();
  const grants = useLoad(() => api.listDeviceGrants(device.id).then((r) => r.items), device.id);
  useDeviceEvents([...GRANT_EVENTS, 'approval.decided'], (env) => {
    if (env.name === 'approval.decided' || eventDeviceId(env) === device.id) grants.reload();
  });
  return (
    <div className="stack">
      <AccessRequests device={device} grants={grants} agentName={agents.name} />
      <StagedWrites device={device} agentName={agents.name} />
      <Browse device={device} grants={grants} />
      <GrantList device={device} grants={grants} agents={agents} />
    </div>
  );
}

// ---- folder-access requests ---------------------------------------------------------------------

function AccessRequests({
  device,
  grants,
  agentName,
}: {
  device: DeviceView;
  grants: Grants;
  agentName: (id: string) => string | null;
}) {
  const { api } = useServices();
  const toast = useToast();
  const [answered, setAnswered] = useState<Record<string, 'allowed' | 'denied'>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const pending = grants.data?.filter((g) => g.status === 'pending') ?? [];
  if (!pending.length) return null;

  const decide = async (r: DeviceAccessRequestView, allow: boolean) => {
    if (!r.approvalId) return;
    setBusy(r.id);
    try {
      await api.decideApproval({
        approvalId: r.approvalId,
        decision: allow ? 'allow_once' : 'deny_continue',
      });
      setAnswered((a) => ({ ...a, [r.id]: allow ? 'allowed' : 'denied' }));
      toast.show(allow ? 'Allowed.' : 'Denied.', { tone: 'success' });
    } catch (err) {
      const already = err instanceof ApiError && err.status === 409;
      toast.show(
        already
          ? 'This request was already answered, maybe on the device.'
          : deviceErrorMessage(err, 'Could not answer the request.'),
        { tone: 'error' },
      );
    } finally {
      setBusy(null);
      grants.reload();
    }
  };

  return (
    <section className="ws-section devices-flat" aria-labelledby="requests-h">
      <h2 id="requests-h">Access requests</h2>
      <ul className="ws-cards" aria-label="Access requests">
        {pending.map((r) => {
          const who = granteeText(r.grantee, agentName);
          const verb =
            r.kind === 'mcp'
              ? 'call the tools of'
              : r.access === 'write'
                ? 'read and change'
                : 'read';
          const done = answered[r.id];
          return (
            <li
              key={r.id}
              className="ws-card devices-request"
              aria-label={`${who} asks for ${r.target}`}
            >
              <strong>
                <Icon name="hand" /> {who} asks to {verb}{' '}
                <code className="ws-code-inline">{r.target}</code>
              </strong>
              {r.reason ? (
                <p className="ws-flush">
                  <span className="muted">Reason given by the requester: </span>
                  {r.reason}
                </p>
              ) : null}
              <span className="muted ws-row-meta">Asked {formatWhen(r.createdAt)}</span>
              {done ? (
                <p className="ws-flush" role="status">
                  {done === 'allowed' ? 'Allowed' : 'Denied'}. Passing it to the device…
                </p>
              ) : r.approvalId ? (
                <div className="row">
                  <Button
                    variant="primary"
                    disabled={busy === r.id}
                    onClick={() => void decide(r, true)}
                    aria-label={`Allow ${who} to ${verb} ${r.target}`}
                  >
                    Allow
                  </Button>
                  <Button
                    disabled={busy === r.id}
                    onClick={() => void decide(r, false)}
                    aria-label={`Deny ${who} access to ${r.target}`}
                  >
                    Deny
                  </Button>
                </div>
              ) : (
                <p className="muted ws-flush">Answer this on the device ({device.name}).</p>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

// ---- browse the folders shared with you ---------------------------------------------------------

function Browse({ device, grants }: { device: DeviceView; grants: Grants }) {
  const blocked = capabilityBlocked(device, 'files');
  const roots = (grants.data ?? []).filter(
    (g) => g.status === 'granted' && g.kind === 'folder' && g.grantee.kind === 'user',
  );
  const [root, setRoot] = useState<string | null>(null);
  const [path, setPath] = useState<string | null>(null);
  const [asking, setAsking] = useState<string | null>(null);
  const current = root && roots.some((r) => r.target === root) ? root : null;

  const open = (r: string) => {
    setRoot(r);
    setPath(r);
  };

  return (
    <section className="ws-section devices-flat" aria-labelledby="browse-h">
      <div className="ws-section-header">
        <h2 id="browse-h">Your folders on this device</h2>
        {!blocked ? (
          <Button onClick={() => setAsking('')}>
            <Icon name="folder" /> Add a folder
          </Button>
        ) : null}
      </div>
      {blocked ? <Unavailable>{blocked}</Unavailable> : null}
      {grants.error ? (
        <LoadError
          error={grants.error}
          fallback="Could not load the shared folders."
          onRetry={grants.reload}
        />
      ) : null}
      {grants.loading ? <Spinner label="Loading shared folders" /> : null}
      {grants.data && !roots.length ? (
        <p className="muted ws-flush">
          No folders on this device are shared with you yet. Add one to browse it here.
        </p>
      ) : null}
      {roots.length ? (
        <div className="devices-roots" role="group" aria-label="Shared folders">
          {roots.map((r) => (
            <Button
              key={r.id}
              variant={current === r.target ? 'primary' : 'default'}
              aria-pressed={current === r.target}
              disabled={Boolean(blocked)}
              onClick={() => open(r.target)}
            >
              <Icon name="folder" /> {r.target}
            </Button>
          ))}
        </div>
      ) : null}
      {current && path && !blocked ? (
        <Folder
          key={path}
          device={device}
          root={current}
          path={path}
          onOpen={setPath}
          onAsk={(p) => setAsking(p)}
        />
      ) : null}
      {asking !== null ? (
        <AskFolderDialog
          device={device}
          initialPath={asking}
          onClose={() => setAsking(null)}
          onGranted={(g) => {
            setAsking(null);
            grants.reload();
            open(g.target);
          }}
        />
      ) : null}
    </section>
  );
}

function Folder({
  device,
  root,
  path,
  onOpen,
  onAsk,
}: {
  device: DeviceView;
  root: string;
  path: string;
  onOpen: (p: string) => void;
  onAsk: (p: string) => void;
}) {
  const api = useDevicesApi();
  const listing = useLoad(() => api.listDeviceFiles(device.id, path), `${device.id}:${path}`);
  const [preview, setPreview] = useState<DeviceDirent | null>(null);
  const crumbs = pathCrumbs(root, path);
  const needsAccess = errorReason(listing.error) === 'folder_access_required';
  const entries = listing.data
    ? [...listing.data.entries].sort(
        (a, b) =>
          Number(b.kind === 'dir') - Number(a.kind === 'dir') || a.name.localeCompare(b.name),
      )
    : null;

  return (
    <div className="stack devices-folder">
      <nav aria-label="Folder path" className="devices-crumbs">
        <ol>
          {crumbs.map((c, i) => (
            <li key={c.path}>
              {i === crumbs.length - 1 ? (
                <span aria-current="location">{c.label}</span>
              ) : (
                <button type="button" className="link" onClick={() => onOpen(c.path)}>
                  {c.label}
                </button>
              )}
            </li>
          ))}
        </ol>
      </nav>
      {needsAccess ? (
        <div role="alert" className="ws-error">
          <p>This folder is not shared with you on this device.</p>
          <Button onClick={() => onAsk(path)}>Ask for access</Button>
        </div>
      ) : listing.error ? (
        <LoadError
          error={listing.error}
          fallback="Could not list the folder."
          onRetry={listing.reload}
        />
      ) : null}
      {listing.loading ? <Spinner label="Listing the folder" /> : null}
      {entries?.length === 0 ? <p className="muted ws-flush">This folder is empty.</p> : null}
      {entries?.length ? (
        <ul className="devices-entries" aria-label={`Contents of ${path}`}>
          {entries.map((e) => {
            const full = joinPath(path, e.name);
            return (
              <li key={e.name} data-kind={e.kind}>
                {e.kind === 'dir' ? (
                  <button type="button" className="devices-entry" onClick={() => onOpen(full)}>
                    <Icon name="folder" /> <span>{e.name}</span>
                  </button>
                ) : e.kind === 'file' ? (
                  <button
                    type="button"
                    className="devices-entry"
                    aria-pressed={preview?.name === e.name}
                    onClick={() => setPreview(e)}
                  >
                    <Icon name="file" /> <span>{e.name}</span>
                    <span className="muted">{formatBytes(e.size)}</span>
                  </button>
                ) : (
                  <span className="devices-entry" data-inert>
                    <Icon name="external" /> <span>{e.name}</span>
                    <span className="muted">{e.kind === 'symlink' ? 'Link' : 'Other'}</span>
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      ) : null}
      {listing.data?.truncated ? (
        <p className="muted ws-flush">The device listed only part of this folder.</p>
      ) : null}
      {preview ? (
        <Preview
          key={preview.name}
          device={device}
          path={joinPath(path, preview.name)}
          onClose={() => setPreview(null)}
        />
      ) : null}
    </div>
  );
}

function Preview({
  device,
  path,
  onClose,
}: {
  device: DeviceView;
  path: string;
  onClose: () => void;
}) {
  const api = useDevicesApi();
  const file = useLoad<DeviceFileContent>(
    () => api.readDeviceFile(device.id, path, PREVIEW_BYTES),
    `${device.id}:${path}`,
  );
  const f = file.data;
  const text = f ? previewText(decodeBase64(f.contentBase64)) : null;
  return (
    <div className="devices-preview" aria-label={`Preview of ${path}`} role="region">
      <div className="ws-section-header">
        <h3 className="devices-path">{path}</h3>
        <Button variant="ghost" onClick={onClose}>
          Close preview
        </Button>
      </div>
      {file.error ? (
        <LoadError error={file.error} fallback="Could not read the file." onRetry={file.reload} />
      ) : null}
      {file.loading ? <Spinner label="Reading the file" /> : null}
      {f ? (
        f.size === 0 ? (
          <p className="muted ws-flush">This file is empty.</p>
        ) : text === null ? (
          <p className="muted ws-flush">
            This file is not text ({formatBytes(f.size)}), so it is not shown.
          </p>
        ) : (
          <>
            <pre className="devices-file" tabIndex={0} aria-label={`Contents of ${path}`}>
              {text}
            </pre>
            {f.truncated ? (
              <p className="muted ws-flush">
                Showing the first {formatBytes(PREVIEW_BYTES)} of {formatBytes(f.size)}.
              </p>
            ) : null}
          </>
        )
      ) : null}
    </div>
  );
}

/** Ask for a folder for yourself: the signed-in user asking is the approval (granted at once). */
function AskFolderDialog({
  device,
  initialPath,
  onClose,
  onGranted,
}: {
  device: DeviceView;
  initialPath: string;
  onClose: () => void;
  onGranted: (g: DeviceAccessRequestView) => void;
}) {
  const api = useDevicesApi();
  const toast = useToast();
  const ref = useRef<HTMLInputElement>(null);
  const base = useId();
  const [path, setPath] = useState(initialPath);
  const [access, setAccess] = useState<'read' | 'write'>('read');
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const problem = pathProblem(path.trim());

  const submit = async () => {
    setTouched(true);
    if (problem || busy) return;
    setBusy(true);
    setError(null);
    try {
      const g = await api.requestDeviceAccess(device.id, { path: path.trim(), access });
      if (g.status === 'granted') {
        toast.show(`${g.target} is shared with you.`, { tone: 'success' });
        onGranted(g);
      } else {
        toast.show('Requested. Approve it on the device.', { tone: 'info' });
        onClose();
      }
    } catch (err) {
      setError(deviceErrorMessage(err, 'Could not add the folder.'));
      setBusy(false);
    }
  };

  return (
    <Dialog
      open
      title="Add a folder"
      description={`Share a folder on ${device.name} with yourself, to browse it here.`}
      onClose={onClose}
      initialFocusRef={ref}
    >
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <TextField
          ref={ref}
          label="Folder"
          value={path}
          placeholder="/home/you/Documents"
          hint="The full path on the device."
          error={touched && problem ? problem : undefined}
          onChange={(e) => setPath(e.target.value)}
        />
        <SelectField
          label="Access"
          value={access}
          onChange={(v) => setAccess(v === 'write' ? 'write' : 'read')}
          options={[
            { value: 'read', label: 'Read only' },
            { value: 'write', label: 'Read and change (changes are staged for review)' },
          ]}
        />
        {error ? (
          <p role="alert" className="nv-field-error" id={`${base}-err`}>
            {error}
          </p>
        ) : null}
        <div className="nv-dialog-footer">
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" disabled={busy}>
            {busy ? <Spinner /> : null} Add folder
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

// ---- every grant on the device ------------------------------------------------------------------

function GrantList({
  device,
  grants,
  agents,
}: {
  device: DeviceView;
  grants: Grants;
  agents: ReturnType<typeof useAgentChoices>;
}) {
  const api = useDevicesApi();
  const toast = useToast();
  const [sharing, setSharing] = useState(false);
  const [revoking, setRevoking] = useState<DeviceAccessRequestView | null>(null);
  const blocked = capabilityBlocked(device, 'files');
  const items = grants.data?.filter((g) => g.status === 'granted') ?? [];

  return (
    <section className="ws-section devices-flat" aria-labelledby="grants-h">
      <div className="ws-section-header">
        <h2 id="grants-h">Shared folders and servers</h2>
        {!blocked ? (
          <Button onClick={() => setSharing(true)}>
            <Icon name="plus" /> Share
          </Button>
        ) : null}
      </div>
      <p className="muted ws-flush">
        Who may reach what on this device. Changes always wait as staged writes for review.
      </p>
      {grants.data && !items.length ? (
        <p className="muted ws-flush">Nothing on this device is shared yet.</p>
      ) : null}
      {items.length ? (
        <ul className="ws-list" aria-label="Grants">
          {items.map((g) => {
            const who = granteeText(g.grantee, agents.name);
            return (
              <li key={g.id} className="ws-list-row" aria-label={`${who}: ${g.target}`}>
                <div className="devices-row-main">
                  <span className="devices-row-head">
                    <Icon name={g.kind === 'mcp' ? 'server' : 'folder'} />
                    <code className="ws-code-inline">{g.target}</code>
                  </span>
                  <span className="muted ws-row-meta">
                    <span>{who}</span>
                    <span>{accessText(g)}</span>
                    <span>
                      {g.decidedBy === 'device' ? 'Allowed on the device' : 'Allowed here'}{' '}
                      {formatWhen(g.decidedAt ?? g.createdAt)}
                    </span>
                  </span>
                </div>
                <Button
                  disabled={Boolean(blocked)}
                  title={blocked ?? undefined}
                  onClick={() => setRevoking(g)}
                  aria-label={`Revoke ${who}: ${g.target}`}
                >
                  Revoke
                </Button>
              </li>
            );
          })}
        </ul>
      ) : null}
      {sharing ? (
        <ShareDialog
          device={device}
          agents={agents}
          onClose={() => setSharing(false)}
          onShared={() => {
            setSharing(false);
            grants.reload();
          }}
        />
      ) : null}
      <ConfirmDialog
        open={revoking !== null}
        title="Revoke access?"
        description={
          revoking
            ? `${granteeText(revoking.grantee, agents.name)} can no longer reach ${revoking.target} on ${device.name}.`
            : undefined
        }
        confirmLabel="Revoke"
        danger
        onClose={() => setRevoking(null)}
        onConfirm={async () => {
          if (!revoking) return;
          await api.revokeDeviceGrant(device.id, revoking.id);
          setRevoking(null);
          grants.reload();
          toast.show('Access revoked.', { tone: 'success' });
        }}
      />
    </section>
  );
}

/** Share a folder or a local MCP server with someone (the signed-in user's own decision). */
function ShareDialog({
  device,
  agents,
  onClose,
  onShared,
}: {
  device: DeviceView;
  agents: ReturnType<typeof useAgentChoices>;
  onClose: () => void;
  onShared: () => void;
}) {
  const api = useDevicesApi();
  const { api: hub } = useServices();
  const toast = useToast();
  const [kind, setKind] = useState<DeviceGrantee['kind']>(agents.agents?.length ? 'agent' : 'user');
  const [granteeId, setGranteeId] = useState('');
  const [what, setWhat] = useState<'folder' | 'mcp'>('folder');
  const [path, setPath] = useState('');
  const [server, setServer] = useState('');
  const [access, setAccess] = useState<'read' | 'write'>('read');
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const problem =
    what === 'folder' ? pathProblem(path.trim()) : server.trim() ? null : 'Enter the server name.';
  const needsId = kind !== 'user' && !granteeId.trim();

  const submit = async () => {
    setTouched(true);
    if (problem || needsId || busy) return;
    setBusy(true);
    setError(null);
    try {
      const id = kind === 'user' ? ((await hub.session()).accountId ?? '') : granteeId.trim();
      const grantee = { kind, id };
      const g = await api.createDeviceGrant(
        device.id,
        what === 'folder'
          ? { kind: 'folder', grantee, path: path.trim(), access }
          : { kind: 'mcp', grantee, server: server.trim() },
      );
      toast.show(`${g.target} is shared with ${granteeText(g.grantee, agents.name)}.`, {
        tone: 'success',
      });
      onShared();
    } catch (err) {
      setError(deviceErrorMessage(err, 'Could not share it.'));
      setBusy(false);
    }
  };

  return (
    <Dialog open title={`Share on ${device.name}`} onClose={onClose}>
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <SelectField
          label="With"
          value={kind}
          onChange={(v) => {
            setKind(v as DeviceGrantee['kind']);
            setGranteeId('');
          }}
          options={DEVICE_GRANTEE_KINDS.map((k) => ({
            value: k,
            label: k === 'user' ? 'You' : GRANTEE_KIND_LABEL[k],
          }))}
        />
        {kind === 'agent' && agents.agents?.length ? (
          <SelectField
            label="Agent"
            value={granteeId}
            onChange={setGranteeId}
            error={touched && needsId ? 'Choose an agent.' : undefined}
            options={[
              { value: '', label: 'Choose an agent' },
              ...agents.agents.map((a) => ({ value: a.id, label: a.name })),
            ]}
          />
        ) : kind !== 'user' ? (
          <TextField
            label={`${GRANTEE_KIND_LABEL[kind]} ID`}
            value={granteeId}
            error={touched && needsId ? 'Enter the ID.' : undefined}
            onChange={(e) => setGranteeId(e.target.value)}
          />
        ) : null}
        <SelectField
          label="What"
          value={what}
          onChange={(v) => setWhat(v === 'mcp' ? 'mcp' : 'folder')}
          options={[
            { value: 'folder', label: 'A folder' },
            { value: 'mcp', label: 'A local MCP server' },
          ]}
        />
        {what === 'folder' ? (
          <>
            <TextField
              label="Folder"
              value={path}
              placeholder="/home/you/projects"
              hint="The full path on the device. Credential folders are never shared."
              error={touched && problem ? problem : undefined}
              onChange={(e) => setPath(e.target.value)}
            />
            <SelectField
              label="Access"
              value={access}
              onChange={(v) => setAccess(v === 'write' ? 'write' : 'read')}
              options={[
                { value: 'read', label: 'Read only' },
                { value: 'write', label: 'Read and change (changes are staged for review)' },
              ]}
            />
          </>
        ) : (
          <TextField
            label="Server name"
            value={server}
            hint="As novad names it on the device."
            error={touched && problem ? problem : undefined}
            onChange={(e) => setServer(e.target.value)}
          />
        )}
        {error ? (
          <p role="alert" className="nv-field-error">
            {error}
          </p>
        ) : null}
        <div className="nv-dialog-footer">
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" disabled={busy}>
            {busy ? <Spinner /> : null} Share
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
