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
import { defineMessages } from '@nova/i18n';
import { ApiError } from '../api.ts';
import { rich } from '../i18n/rich.tsx';
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
import {
  ConfirmDialog,
  LoadError,
  PARTS_TEXT,
  Unavailable,
  useLoad,
  type Loaded,
} from './parts.tsx';
import { StagedWrites } from './StagedWrites.tsx';

/** The Files tab's words (FR-016): requests, browsing, grants and sharing. */
export const FILES_TEXT = defineMessages('devices.files', {
  requests: {
    title: 'Access requests',
    allowed: 'Allowed.',
    denied: 'Denied.',
    already: 'This request was already answered, maybe on the device.',
    failed: 'Could not answer the request.',
    asksFor: '{who} asks for {target}',
    asksRead: '{who} asks to read {target}',
    asksWrite: '{who} asks to read and change {target}',
    asksMcp: '{who} asks to call the tools of {target}',
    reason: 'Reason given by the requester:',
    asked: 'Asked {when}',
    passingAllowed: 'Allowed. Passing it to the device…',
    passingDenied: 'Denied. Passing it to the device…',
    allow: 'Allow',
    allowRead: 'Allow {who} to read {target}',
    allowWrite: 'Allow {who} to read and change {target}',
    allowMcp: 'Allow {who} to call the tools of {target}',
    deny: 'Deny',
    denyWho: 'Deny {who} access to {target}',
    onDevice: 'Answer this on the device ({device}).',
  },
  browse: {
    title: 'Your folders on this device',
    addFolder: 'Add a folder',
    loadFailed: 'Could not load the shared folders.',
    loading: 'Loading shared folders',
    none: 'No folders on this device are shared with you yet. Add one to browse it here.',
    roots: 'Shared folders',
    path: 'Folder path',
    notShared: 'This folder is not shared with you on this device.',
    askAccess: 'Ask for access',
    listFailed: 'Could not list the folder.',
    listing: 'Listing the folder',
    empty: 'This folder is empty.',
    contents: 'Contents of {path}',
    link: 'Link',
    other: 'Other',
    truncated: 'The device listed only part of this folder.',
  },
  preview: {
    label: 'Preview of {path}',
    close: 'Close preview',
    failed: 'Could not read the file.',
    reading: 'Reading the file',
    empty: 'This file is empty.',
    binary: 'This file is not text ({size}), so it is not shown.',
    partial: 'Showing the first {shown} of {size}.',
  },
  ask: {
    title: 'Add a folder',
    description: 'Share a folder on {device} with yourself, to browse it here.',
    sharedWithYou: '{target} is shared with you.',
    requested: 'Requested. Approve it on the device.',
    failed: 'Could not add the folder.',
    submit: 'Add folder',
  },
  folder: 'Folder',
  folderHint: 'The full path on the device.',
  folderExample: '/home/you/Documents',
  access: 'Access',
  readOnly: 'Read only',
  readWrite: 'Read and change (changes are staged for review)',
  grants: {
    title: 'Shared folders and servers',
    share: 'Share',
    intro: 'Who may reach what on this device. Changes always wait as staged writes for review.',
    none: 'Nothing on this device is shared yet.',
    list: 'Grants',
    row: '{who}: {target}',
    allowedOnDevice: 'Allowed on the device {when}',
    allowedHere: 'Allowed here {when}',
    revoke: 'Revoke',
    revokeRow: 'Revoke {who}: {target}',
    revokeTitle: 'Revoke access?',
    revokeBody: '{who} can no longer reach {target} on {device}.',
    revoked: 'Access revoked.',
  },
  share: {
    title: 'Share on {device}',
    with: 'With',
    agent: 'Agent',
    chooseAgent: 'Choose an agent',
    needAgent: 'Choose an agent.',
    id: '{kind, select, session {Code session ID} run {Work run ID} thread {Chat ID} agent {Agent ID} other {ID}}',
    needId: 'Enter the ID.',
    what: 'What',
    aFolder: 'A folder',
    aServer: 'A local MCP server',
    folderExample: '/home/you/projects',
    folderHint: 'The full path on the device. Credential folders are never shared.',
    server: 'Server name',
    serverHint: 'As novad names it on the device.',
    needServer: 'Enter the server name.',
    shared: '{target} is shared with {who}.',
    failed: 'Could not share it.',
    submit: 'Share',
  },
});

const S = FILES_TEXT;

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
  const R = S.requests;

  const decide = async (r: DeviceAccessRequestView, allow: boolean) => {
    if (!r.approvalId) return;
    setBusy(r.id);
    try {
      await api.decideApproval({
        approvalId: r.approvalId,
        decision: allow ? 'allow_once' : 'deny_continue',
      });
      setAnswered((a) => ({ ...a, [r.id]: allow ? 'allowed' : 'denied' }));
      toast.show(allow ? S.requests.allowed : S.requests.denied, { tone: 'success' });
    } catch (err) {
      const already = err instanceof ApiError && err.status === 409;
      toast.show(already ? S.requests.already : deviceErrorMessage(err, S.requests.failed), {
        tone: 'error',
      });
    } finally {
      setBusy(null);
      grants.reload();
    }
  };

  return (
    <section className="ws-section devices-flat" aria-labelledby="requests-h">
      <h2 id="requests-h">{R.title}</h2>
      <ul className="ws-cards" aria-label={R.title}>
        {pending.map((r) => {
          const who = granteeText(r.grantee, agentName);
          const target = r.target;
          const [asks, allowLabel] =
            r.kind === 'mcp'
              ? [R.asksMcp, R.allowMcp]
              : r.access === 'write'
                ? [R.asksWrite, R.allowWrite]
                : [R.asksRead, R.allowRead];
          const done = answered[r.id];
          return (
            <li
              key={r.id}
              className="ws-card devices-request"
              aria-label={R.asksFor({ who, target })}
            >
              <strong>
                <Icon name="hand" />{' '}
                {rich(asks, {
                  who,
                  target: (
                    <code className="ws-code-inline" dir="ltr">
                      {target}
                    </code>
                  ),
                })}
              </strong>
              {r.reason ? (
                <p className="ws-flush">
                  <span className="muted">{R.reason} </span>
                  <span dir="auto">{r.reason}</span>
                </p>
              ) : null}
              <span className="muted ws-row-meta">
                {R.asked({ when: formatWhen(r.createdAt) })}
              </span>
              {done ? (
                <p className="ws-flush" role="status">
                  {done === 'allowed' ? R.passingAllowed : R.passingDenied}
                </p>
              ) : r.approvalId ? (
                <div className="row">
                  <Button
                    variant="primary"
                    disabled={busy === r.id}
                    onClick={() => void decide(r, true)}
                    aria-label={allowLabel({ who, target })}
                  >
                    {R.allow}
                  </Button>
                  <Button
                    disabled={busy === r.id}
                    onClick={() => void decide(r, false)}
                    aria-label={R.denyWho({ who, target })}
                  >
                    {R.deny}
                  </Button>
                </div>
              ) : (
                <p className="muted ws-flush">{R.onDevice({ device: device.name })}</p>
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
  const B = S.browse;

  return (
    <section className="ws-section devices-flat" aria-labelledby="browse-h">
      <div className="ws-section-header">
        <h2 id="browse-h">{B.title}</h2>
        {!blocked ? (
          <Button onClick={() => setAsking('')}>
            <Icon name="folder" /> {B.addFolder}
          </Button>
        ) : null}
      </div>
      {blocked ? <Unavailable>{blocked}</Unavailable> : null}
      {grants.error ? (
        <LoadError error={grants.error} fallback={B.loadFailed} onRetry={grants.reload} />
      ) : null}
      {grants.loading ? <Spinner label={B.loading} /> : null}
      {grants.data && !roots.length ? <p className="muted ws-flush">{B.none}</p> : null}
      {roots.length ? (
        <div className="devices-roots" role="group" aria-label={B.roots}>
          {roots.map((r) => (
            <Button
              key={r.id}
              variant={current === r.target ? 'primary' : 'default'}
              aria-pressed={current === r.target}
              disabled={Boolean(blocked)}
              onClick={() => open(r.target)}
            >
              <Icon name="folder" /> <span dir="ltr">{r.target}</span>
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
  const B = S.browse;

  return (
    <div className="stack devices-folder">
      <nav aria-label={B.path} className="devices-crumbs" dir="ltr">
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
          <p>{B.notShared}</p>
          <Button onClick={() => onAsk(path)}>{B.askAccess}</Button>
        </div>
      ) : listing.error ? (
        <LoadError error={listing.error} fallback={B.listFailed} onRetry={listing.reload} />
      ) : null}
      {listing.loading ? <Spinner label={B.listing} /> : null}
      {entries?.length === 0 ? <p className="muted ws-flush">{B.empty}</p> : null}
      {entries?.length ? (
        <ul className="devices-entries" aria-label={B.contents({ path })}>
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
                    <span className="muted">{e.kind === 'symlink' ? B.link : B.other}</span>
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      ) : null}
      {listing.data?.truncated ? <p className="muted ws-flush">{B.truncated}</p> : null}
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
  const P = S.preview;
  return (
    <div className="devices-preview" aria-label={P.label({ path })} role="region">
      <div className="ws-section-header">
        <h3 className="devices-path" dir="ltr">
          {path}
        </h3>
        <Button variant="ghost" onClick={onClose}>
          {P.close}
        </Button>
      </div>
      {file.error ? (
        <LoadError error={file.error} fallback={P.failed} onRetry={file.reload} />
      ) : null}
      {file.loading ? <Spinner label={P.reading} /> : null}
      {f ? (
        f.size === 0 ? (
          <p className="muted ws-flush">{P.empty}</p>
        ) : text === null ? (
          <p className="muted ws-flush">{P.binary({ size: formatBytes(f.size) })}</p>
        ) : (
          <>
            <pre
              role="group"
              className="devices-file"
              tabIndex={0}
              aria-label={S.browse.contents({ path })}
              dir="auto"
            >
              {text}
            </pre>
            {f.truncated ? (
              <p className="muted ws-flush">
                {P.partial({ shown: formatBytes(PREVIEW_BYTES), size: formatBytes(f.size) })}
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
        toast.show(S.ask.sharedWithYou({ target: g.target }), { tone: 'success' });
        onGranted(g);
      } else {
        toast.show(S.ask.requested, { tone: 'info' });
        onClose();
      }
    } catch (err) {
      setError(deviceErrorMessage(err, S.ask.failed));
      setBusy(false);
    }
  };

  return (
    <Dialog
      open
      title={S.ask.title}
      description={S.ask.description({ device: device.name })}
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
          label={S.folder}
          value={path}
          placeholder={S.folderExample}
          hint={S.folderHint}
          error={touched && problem ? problem : undefined}
          onChange={(e) => setPath(e.target.value)}
        />
        <SelectField
          label={S.access}
          value={access}
          onChange={(v) => setAccess(v === 'write' ? 'write' : 'read')}
          options={[
            { value: 'read', label: S.readOnly },
            { value: 'write', label: S.readWrite },
          ]}
        />
        {error ? (
          <p role="alert" className="nv-field-error" id={`${base}-err`}>
            {error}
          </p>
        ) : null}
        <div className="nv-dialog-footer">
          <Button onClick={onClose}>{PARTS_TEXT.cancel}</Button>
          <Button type="submit" variant="primary" disabled={busy}>
            {busy ? <Spinner /> : null} {S.ask.submit}
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
  const G = S.grants;

  return (
    <section className="ws-section devices-flat" aria-labelledby="grants-h">
      <div className="ws-section-header">
        <h2 id="grants-h">{G.title}</h2>
        {!blocked ? (
          <Button onClick={() => setSharing(true)}>
            <Icon name="plus" /> {G.share}
          </Button>
        ) : null}
      </div>
      <p className="muted ws-flush">{G.intro}</p>
      {grants.data && !items.length ? <p className="muted ws-flush">{G.none}</p> : null}
      {items.length ? (
        <ul className="ws-list" aria-label={G.list}>
          {items.map((g) => {
            const who = granteeText(g.grantee, agents.name);
            const when = formatWhen(g.decidedAt ?? g.createdAt);
            return (
              <li key={g.id} className="ws-list-row" aria-label={G.row({ who, target: g.target })}>
                <div className="devices-row-main">
                  <span className="devices-row-head">
                    <Icon name={g.kind === 'mcp' ? 'server' : 'folder'} />
                    <code className="ws-code-inline" dir="ltr">
                      {g.target}
                    </code>
                  </span>
                  <span className="muted ws-row-meta">
                    <span>{who}</span>
                    <span>{accessText(g)}</span>
                    <span>
                      {g.decidedBy === 'device'
                        ? G.allowedOnDevice({ when })
                        : G.allowedHere({ when })}
                    </span>
                  </span>
                </div>
                <Button
                  disabled={Boolean(blocked)}
                  title={blocked ?? undefined}
                  onClick={() => setRevoking(g)}
                  aria-label={G.revokeRow({ who, target: g.target })}
                >
                  {G.revoke}
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
        title={G.revokeTitle}
        description={
          revoking
            ? G.revokeBody({
                who: granteeText(revoking.grantee, agents.name),
                target: revoking.target,
                device: device.name,
              })
            : undefined
        }
        confirmLabel={G.revoke}
        danger
        onClose={() => setRevoking(null)}
        onConfirm={async () => {
          if (!revoking) return;
          await api.revokeDeviceGrant(device.id, revoking.id);
          setRevoking(null);
          grants.reload();
          toast.show(G.revoked, { tone: 'success' });
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
  const H = S.share;
  const problem =
    what === 'folder' ? pathProblem(path.trim()) : server.trim() ? null : H.needServer;
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
      toast.show(H.shared({ target: g.target, who: granteeText(g.grantee, agents.name) }), {
        tone: 'success',
      });
      onShared();
    } catch (err) {
      setError(deviceErrorMessage(err, H.failed));
      setBusy(false);
    }
  };

  return (
    <Dialog open title={H.title({ device: device.name })} onClose={onClose}>
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <SelectField
          label={H.with}
          value={kind}
          onChange={(v) => {
            setKind(v as DeviceGrantee['kind']);
            setGranteeId('');
          }}
          options={DEVICE_GRANTEE_KINDS.map((k) => ({ value: k, label: GRANTEE_KIND_LABEL[k] }))}
        />
        {kind === 'agent' && agents.agents?.length ? (
          <SelectField
            label={H.agent}
            value={granteeId}
            onChange={setGranteeId}
            error={touched && needsId ? H.needAgent : undefined}
            options={[
              { value: '', label: H.chooseAgent },
              ...agents.agents.map((a) => ({ value: a.id, label: a.name })),
            ]}
          />
        ) : kind !== 'user' ? (
          <TextField
            label={H.id({ kind })}
            value={granteeId}
            error={touched && needsId ? H.needId : undefined}
            onChange={(e) => setGranteeId(e.target.value)}
          />
        ) : null}
        <SelectField
          label={H.what}
          value={what}
          onChange={(v) => setWhat(v === 'mcp' ? 'mcp' : 'folder')}
          options={[
            { value: 'folder', label: H.aFolder },
            { value: 'mcp', label: H.aServer },
          ]}
        />
        {what === 'folder' ? (
          <>
            <TextField
              label={S.folder}
              value={path}
              placeholder={H.folderExample}
              hint={H.folderHint}
              error={touched && problem ? problem : undefined}
              onChange={(e) => setPath(e.target.value)}
            />
            <SelectField
              label={S.access}
              value={access}
              onChange={(v) => setAccess(v === 'write' ? 'write' : 'read')}
              options={[
                { value: 'read', label: S.readOnly },
                { value: 'write', label: S.readWrite },
              ]}
            />
          </>
        ) : (
          <TextField
            label={H.server}
            value={server}
            hint={H.serverHint}
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
          <Button onClick={onClose}>{PARTS_TEXT.cancel}</Button>
          <Button type="submit" variant="primary" disabled={busy}>
            {busy ? <Spinner /> : null} {H.submit}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
