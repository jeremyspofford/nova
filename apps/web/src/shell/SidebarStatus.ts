// Live status for the sidebar (FR-215, docs/04 §1.1): `thread.status.changed` on the shared event
// stream keeps every chat's chip current, not only the open chat's, and the command "Go to the
// next item that needs input" (Ctrl+Alt+A, ⌘⌥A) cycles through chats and Work runs that wait on
// the user.
import { useEffect, useLayoutEffect, useRef } from 'react';
import type { DerivedStatus, ThreadView } from '@nova/shared';
import { useToast } from '@nova/ui';
import { threadStatus } from '../chat/status.ts';
import { threadStateOf } from '../chat/useThreadFeed.ts';
import { CATEGORY } from '../commands.ts';
import { chatPath, navigate } from '../router.ts';
import { useServices } from '../services.tsx';
import { useThreads } from '../stores.tsx';
import { useWorkEvents } from '../work/events.ts';
import { runPath } from '../work/format.ts';
import { SIDEBAR_TEXT } from './strings.ts';

export const NEXT_NEEDS_INPUT = 'status.nextNeedsInput';

const DERIVED: readonly DerivedStatus[] = ['needs_input', 'blocked', 'running', 'ready'];

/** The paths that wait on the user, in list order: chats first, then runs. */
export function needsInputTargets(threads: ThreadView[], runIds: string[]): string[] {
  return [
    ...threads.filter((t) => threadStatus(t) === 'needs_input').map((t) => chatPath(t.id)),
    ...runIds.map(runPath),
  ];
}

/** The target after `here` (wrapping), or the first when `here` is not one of them. */
export function nextTarget(targets: string[], here: string): string | null {
  if (!targets.length) return null;
  const i = targets.indexOf(here);
  return targets[(i + 1) % targets.length] ?? null;
}

export function useSidebarStatus(): void {
  const { api, registry } = useServices();
  const store = useThreads();
  const toast = useToast();
  const latest = useRef({ store, toast });
  const unknown = useRef(new Set<string>());
  useLayoutEffect(() => {
    latest.current = { store, toast };
  });

  useWorkEvents((env) => {
    if (env.name !== 'thread.status.changed') return;
    const p = env.payload;
    const ref = p.ref as { kind?: unknown; id?: unknown } | undefined;
    const status = p.status as DerivedStatus;
    if (ref?.kind !== 'thread' || typeof ref.id !== 'string' || !DERIVED.includes(status)) return;
    const id = ref.id;
    const known = latest.current.store.threads.find((t) => t.id === id);
    // A chat this list has not seen yet (made on another device): list again, once per id, so
    // the status of a thread that is not a chat (a Work run's) never lists over and over.
    if (!known) {
      if (!unknown.current.has(id)) {
        unknown.current.add(id);
        latest.current.store.refreshSoon();
      }
      return;
    }
    // The event carries no reason; one stays only while the status it explains does.
    const reason = known.derived?.status === status ? known.derived.reason : null;
    latest.current.store.upsertLocal({
      id,
      derived: { status, reason },
      state: threadStateOf(status) ?? known.state,
    });
  });

  useEffect(() => {
    const go = async () => {
      const { store: s, toast: t } = latest.current;
      let runs: string[] = [];
      try {
        const { items } = await api.listRuns({ status: 'active' });
        runs = items.filter((r) => r.derived.status === 'needs_input').map((r) => r.id);
      } catch {
        // chats still count when runs cannot be listed
      }
      const next = nextTarget(needsInputTargets(s.threads, runs), window.location.pathname);
      if (next) navigate(next);
      else t.show(SIDEBAR_TEXT.nothingNeedsInput, { tone: 'info' });
    };
    return registry.register({
      id: NEXT_NEEDS_INPUT,
      title: SIDEBAR_TEXT.nextNeedsInput,
      category: CATEGORY.navigation,
      binding: 'mod+alt+a',
      run: () => void go(),
    });
  }, [api, registry]);
}
