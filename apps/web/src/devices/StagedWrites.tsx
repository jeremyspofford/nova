// Staged writes (FR-210; docs/23 §4.1): a session or agent's change to a file on the device waits
// here with its diff until the user commits it (an atomic replace on the device) or discards it.
// If the file changed on the device since staging, the commit fails as a conflict and nothing is
// written; that is said plainly. Abandoned writes expire on the device after 24 hours.
import { useState } from 'react';
import type { StagedWriteView } from '@nova/shared';
import { Button, Icon, Spinner, useToast } from '@nova/ui';
import { formatWhen, plural } from '../settings/common.ts';
import { useAnnounce } from '../services.tsx';
import { useDevicesApi } from './api.ts';
import type { PanelProps } from './DevicePage.tsx';
import { STAGED_EVENTS, eventDeviceId, useDeviceEvents } from './events.ts';
import {
  STAGED_STATUS,
  capabilityBlocked,
  changeCount,
  deviceErrorMessage,
  formatBytes,
  granteeText,
  parseUnifiedDiff,
} from './format.ts';
import { Chip, ConfirmDialog, LoadError, Unavailable, useLoad } from './parts.tsx';

/** Longer diffs are cut here, with a note. */
export const MAX_DIFF_ROWS = 4000;

const OUTCOME: Partial<Record<StagedWriteView['status'], string>> = {
  conflict:
    'The file changed on the device after this write was staged, so nothing was written. Ask for the change again against the current file.',
  expired: 'This write expired on the device before it was committed. Nothing was written.',
  failed: 'The device could not write the file. Nothing was changed.',
  discarded: 'Discarded. Nothing was written.',
};

export function StagedWrites({
  device,
  agentName,
}: Pick<PanelProps, 'device'> & { agentName: (id: string) => string | null }) {
  const api = useDevicesApi();
  const [filter, setFilter] = useState<'staged' | 'all'>('staged');
  const [open, setOpen] = useState<string | null>(null);
  const list = useLoad(
    () =>
      api
        .listStagedWrites(device.id, filter === 'staged' ? { status: 'staged' } : {})
        .then((r) => r.items),
    `${device.id}:${filter}`,
  );
  useDeviceEvents(STAGED_EVENTS, (env) => {
    if (eventDeviceId(env) === device.id) list.reload();
  });
  const current = open ? (list.data?.find((w) => w.id === open) ?? null) : null;

  if (open) {
    return (
      <StagedDetail
        key={open}
        device={device}
        stagedId={open}
        initial={current}
        agentName={agentName}
        onBack={() => setOpen(null)}
        onChanged={(w) =>
          list.setData(
            (l) =>
              l?.flatMap((x) =>
                x.id !== w.id ? [x] : filter === 'staged' && w.status !== 'staged' ? [] : [w],
              ) ?? l,
          )
        }
      />
    );
  }

  const items = list.data;
  return (
    <section className="ws-section devices-flat" aria-labelledby="staged-h">
      <div className="ws-section-header">
        <h2 id="staged-h">Staged writes</h2>
        <div className="devices-segmented" role="group" aria-label="Show">
          <button
            type="button"
            className="nv-btn"
            data-variant="ghost"
            aria-pressed={filter === 'staged'}
            onClick={() => setFilter('staged')}
          >
            Waiting
          </button>
          <button
            type="button"
            className="nv-btn"
            data-variant="ghost"
            aria-pressed={filter === 'all'}
            onClick={() => setFilter('all')}
          >
            All
          </button>
        </div>
      </div>
      <p className="muted ws-flush">
        Changes agents and sessions want to make to files on this device. Nothing is written until
        you commit it.
      </p>
      {list.error ? (
        <LoadError
          error={list.error}
          fallback="Could not load staged writes."
          onRetry={list.reload}
        />
      ) : null}
      {list.loading ? <Spinner label="Loading staged writes" /> : null}
      {items?.length === 0 ? (
        <p className="muted ws-flush">
          {filter === 'staged' ? 'Nothing is waiting for review.' : 'No staged writes yet.'}
        </p>
      ) : null}
      {items?.length ? (
        <ul className="ws-list" aria-label="Staged writes">
          {items.map((w) => {
            const s = STAGED_STATUS[w.status];
            return (
              <li key={w.id} className="ws-list-row devices-staged">
                <div className="devices-row-main">
                  <div className="devices-row-head">
                    <button
                      type="button"
                      className="link devices-path"
                      onClick={() => setOpen(w.id)}
                      aria-label={`Review ${w.path}`}
                    >
                      {w.path}
                    </button>
                    <Chip tone={s.tone} icon={s.icon} text={s.text} />
                  </div>
                  <span className="muted ws-row-meta">
                    <span>{w.binary ? 'Binary file' : changeCount(w)}</span>
                    <span>{granteeText(w.grantee, agentName)}</span>
                    <span>{formatWhen(w.createdAt)}</span>
                  </span>
                </div>
              </li>
            );
          })}
        </ul>
      ) : null}
    </section>
  );
}

function StagedDetail({
  device,
  stagedId,
  initial,
  agentName,
  onBack,
  onChanged,
}: {
  device: PanelProps['device'];
  stagedId: string;
  initial: StagedWriteView | null;
  agentName: (id: string) => string | null;
  onBack: () => void;
  onChanged: (w: StagedWriteView) => void;
}) {
  const api = useDevicesApi();
  const toast = useToast();
  const announce = useAnnounce();
  const write = useLoad(() => api.getStagedWrite(device.id, stagedId), stagedId);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [discarding, setDiscarding] = useState(false);
  useDeviceEvents(STAGED_EVENTS, (env) => {
    if (env.payload.stagedId === stagedId) write.reload();
  });
  const w = write.data ?? initial;
  const blocked = capabilityBlocked(device, 'staged_writes');

  const update = (next: StagedWriteView) => {
    write.setData(() => next);
    onChanged(next);
  };

  const commit = async () => {
    if (!w) return;
    setBusy(true);
    setError(null);
    try {
      const next = await api.commitStagedWrite(device.id, w.id);
      update(next);
      announce(`Written to ${next.path}.`);
      toast.show(`Written to ${next.path}.`, { tone: 'success' });
    } catch (err) {
      // A conflict or expiry is recorded on the write; show it as the write now stands.
      const fresh = await api.getStagedWrite(device.id, w.id).catch(() => null);
      if (fresh && fresh.status !== 'staged') {
        update(fresh);
        announce(STAGED_STATUS[fresh.status].text);
      } else setError(deviceErrorMessage(err, 'Could not commit the write.'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="ws-section devices-flat" aria-labelledby="staged-detail-h">
      <div>
        <Button variant="ghost" onClick={onBack}>
          <Icon name="back" /> Staged writes
        </Button>
      </div>
      {!w ? (
        write.error ? (
          <LoadError
            error={write.error}
            fallback="Could not load the write."
            onRetry={write.reload}
          />
        ) : (
          <Spinner label="Loading the write" />
        )
      ) : (
        <>
          <div className="devices-row-head">
            <h2 id="staged-detail-h" className="devices-path">
              {w.path}
            </h2>
            <Chip
              tone={STAGED_STATUS[w.status].tone}
              icon={STAGED_STATUS[w.status].icon}
              text={STAGED_STATUS[w.status].text}
            />
          </div>
          <span className="muted ws-row-meta">
            <span>From {granteeText(w.grantee, agentName)}</span>
            <span>{formatBytes(w.size)}</span>
            <span>{w.baseSha256 ? 'Changes an existing file' : 'A new file'}</span>
            <span>Staged {formatWhen(w.createdAt)}</span>
            {w.committedAt ? <span>Written {formatWhen(w.committedAt)}</span> : null}
          </span>
          {OUTCOME[w.status] ? (
            <p
              className="devices-note"
              data-tone={w.status === 'conflict' || w.status === 'failed' ? 'bad' : undefined}
              role="status"
            >
              <Icon name={w.status === 'conflict' || w.status === 'failed' ? 'alert' : 'stop'} />{' '}
              {OUTCOME[w.status]}
              {w.error && w.status !== 'discarded' ? ` (${w.error})` : ''}
            </p>
          ) : null}
          <DiffBlock write={w} />
          {w.status === 'staged' ? (
            <>
              {blocked ? <Unavailable>{blocked}</Unavailable> : null}
              {error ? (
                <p role="alert" className="nv-field-error">
                  {error}
                </p>
              ) : null}
              <div className="row">
                <Button
                  variant="primary"
                  disabled={busy || Boolean(blocked)}
                  onClick={() => void commit()}
                >
                  {busy ? <Spinner /> : null} Commit
                </Button>
                <Button disabled={busy} onClick={() => setDiscarding(true)}>
                  Discard
                </Button>
              </div>
            </>
          ) : null}
          <ConfirmDialog
            open={discarding}
            title="Discard this write?"
            description={`Nothing is written to ${w.path}. The agent or session that staged it is told it was discarded.`}
            confirmLabel="Discard"
            danger
            onClose={() => setDiscarding(false)}
            onConfirm={async () => {
              const next = await api.discardStagedWrite(device.id, w.id);
              setDiscarding(false);
              update(next);
              toast.show('Discarded.', { tone: 'success' });
            }}
          />
        </>
      )}
    </section>
  );
}

function DiffBlock({ write }: { write: StagedWriteView }) {
  if (write.binary)
    return (
      <p className="ws-flush">
        Binary content, not shown: <span className="muted">{write.diff}</span>
      </p>
    );
  const rows = parseUnifiedDiff(write.diff);
  const shown = rows.slice(0, MAX_DIFF_ROWS);
  return (
    <div className="stack devices-diff-wrap">
      <p className="muted ws-flush">
        {plural(write.additions, 'line')} added, {plural(write.deletions, 'line')} removed.
      </p>
      {rows.length ? (
        <pre className="devices-diff" aria-label={`Changes to ${write.path}`} tabIndex={0}>
          {shown.map((r, i) => (
            <span key={i} className="devices-diff-line" data-kind={r.kind}>
              {r.kind === 'add' || r.kind === 'del' ? (
                <>
                  <span aria-hidden="true">{r.kind === 'add' ? '+ ' : '- '}</span>
                  <span className="nv-vh">{r.kind === 'add' ? 'Added: ' : 'Removed: '}</span>
                </>
              ) : r.kind === 'same' ? (
                <span aria-hidden="true">{'  '}</span>
              ) : null}
              {r.text}
            </span>
          ))}
        </pre>
      ) : (
        <p className="muted ws-flush">No changes to the text.</p>
      )}
      {rows.length > shown.length ? (
        <p className="muted ws-flush">
          Showing the first {shown.length.toLocaleString('en-US')} of{' '}
          {rows.length.toLocaleString('en-US')} lines.
        </p>
      ) : null}
    </div>
  );
}
