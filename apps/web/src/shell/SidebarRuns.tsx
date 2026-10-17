// Active Work runs under Work in the sidebar (FR-215, docs/04 §1): each row carries the run's
// status chip, Needs input first, and follows run events on the shared stream, so a run moving
// from Running to Needs input and back shows here without opening it. Finished runs live in the
// Work list.
import { useEffect, useState } from 'react';
import type { RunView } from '@nova/shared';
import { Icon, StatusChip, VisuallyHidden } from '@nova/ui';
import { useServices } from '../services.tsx';
import { useDebounced, useWorkEvents } from '../work/events.ts';
import { runPath, sortByStatus } from '../work/format.ts';
import { followLink } from '../work/nav.tsx';

/** At most this many runs show; the Work list has the rest. */
export const SIDEBAR_RUNS = 8;

export function SidebarRuns({
  selectedId,
  onOpen,
}: {
  selectedId: string | null;
  onOpen?: () => void;
}) {
  const { api } = useServices();
  const [runs, setRuns] = useState<RunView[]>([]);
  const [version, setVersion] = useState(0);

  useEffect(() => {
    let alive = true;
    api.listRuns({ status: 'active' }).then(
      ({ items }) => alive && setRuns(items),
      () => undefined, // the Work list reports load failures; the sidebar stays quiet
    );
    return () => {
      alive = false;
    };
  }, [api, version]);

  const reload = useDebounced(() => setVersion((v) => v + 1), 250);
  useWorkEvents((env) => {
    // Usage ticks change no status; everything else about runs may.
    if (env.name === 'run.budget.usage') return;
    if (env.name.startsWith('run.') || env.name === 'thread.status.changed') reload();
  }, reload);

  if (runs.length === 0) return null;
  const shown = sortByStatus(runs).slice(0, SIDEBAR_RUNS);
  return (
    <ul className="threads" aria-label="Active runs">
      {shown.map((r) => {
        const selected = r.id === selectedId;
        const paused = r.status === 'paused';
        return (
          <li key={r.id} className="thread-row" data-selected={selected || undefined}>
            <a
              href={runPath(r.id)}
              className="thread-link"
              aria-current={selected ? 'page' : undefined}
              onClick={(e) => {
                followLink(e, runPath(r.id));
                if (e.defaultPrevented) onOpen?.();
              }}
            >
              {paused ? (
                <span className="thread-mark" title="Paused">
                  <Icon name="clock" />
                </span>
              ) : null}
              <span className="thread-title">{r.title}</span>
              {paused ? <VisuallyHidden>, paused</VisuallyHidden> : null}
              {r.derived.status !== 'ready' ? (
                <StatusChip
                  status={r.derived.status}
                  reason={r.derived.reason ?? undefined}
                  compact
                />
              ) : null}
            </a>
          </li>
        );
      })}
    </ul>
  );
}
