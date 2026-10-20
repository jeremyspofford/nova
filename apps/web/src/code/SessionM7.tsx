// What M7 adds to a Code session (docs/10 §9, §12, §15; FR-213, FR-212, FR-073, FR-108, FR-203,
// FR-202): Hand off… and Best of N… in the header; the cloud run's usage under the budget for a
// session on a cloud environment; and the Attempts, Merges and Moves tabs, plus Agents and Scripts
// while their flagged features are on. A tab loads only once it is first shown. SessionView renders
// these pieces; they own their state.
import { useState, type ReactNode } from 'react';
import type {
  CodeSessionExtrasView,
  CodeSessionView,
  EnvironmentView,
  SessionHandoffView,
} from '@nova/shared';
import { defineMessages } from '@nova/i18n';
import { Button, Icon } from '@nova/ui';
import { ThreadCloudRun } from '../cloud/ThreadCloudRun.tsx';
import { DelegationsPane } from '../flagged/DelegationsPane.tsx';
import { ScriptRuns } from '../flagged/ScriptRuns.tsx';
import { useSettings } from '../settings.tsx';
import { AttemptsPane } from './AttemptsPane.tsx';
import { HandoffDialog } from './HandoffDialog.tsx';
import { HandoffHistory } from './HandoffHistory.tsx';
import { isRemoteKind } from './m6-format.ts';
import { MergePane } from './MergePane.tsx';
import '../cloud/cloud.css';
import './code-m7.css';

export const SESSION_M7_TEXT = defineMessages('code.sessionM7', {
  bestOfNRemote: 'Best of N needs the session’s folder on the Hub, where its worktrees are.',
  noRepo: 'This folder is not a Git repository.',
  handOff: 'Hand off…',
  bestOfN: 'Best of N…',
  tab: {
    attempts: 'Attempts',
    merges: 'Merges',
    moves: 'Moves',
    agents: 'Agents',
    scripts: 'Scripts',
  },
});

export type M7Tab = 'attempts' | 'merges' | 'moves' | 'agents' | 'scripts';

export interface SessionM7 {
  /** Header buttons: Hand off…, Best of N…. */
  actions: ReactNode;
  /** Under the budget bar: the cloud run of a session on a cloud environment. */
  banner: ReactNode;
  panes: { id: M7Tab; label: string; panel: ReactNode }[];
  dialogs: ReactNode;
}

const M7_TABS: readonly string[] = ['attempts', 'merges', 'moves', 'agents', 'scripts'];

function isM7Tab(tab: string): tab is M7Tab {
  return M7_TABS.includes(tab);
}

/** Why Best of N cannot start for this session, or null. */
export function attemptsUnavailable(session: CodeSessionView, remote: boolean): string | null {
  if (remote) return SESSION_M7_TEXT.bestOfNRemote;
  if (!session.repo) return SESSION_M7_TEXT.noRepo;
  return null;
}

export function useSessionM7({
  session,
  extras,
  environment,
  tab,
  onTab,
  onMoved,
}: {
  session: CodeSessionView | null;
  extras: CodeSessionExtrasView | null;
  environment: EnvironmentView | null;
  /** The pane on screen: an M7 pane mounts (and loads) once it is first shown. */
  tab: string;
  /** Shows a pane (the session's tab bar). */
  onTab: (tab: M7Tab) => void;
  /** The session's place, files or Git state changed: load them again. */
  onMoved: () => void;
}): SessionM7 {
  const settings = useSettings();
  const [handingOff, setHandingOff] = useState(false);
  const [startRequest, setStartRequest] = useState(0);
  const [shown, setShown] = useState<ReadonlySet<string>>(() => new Set());
  if (isM7Tab(tab) && !shown.has(tab)) setShown(new Set([...shown, tab]));
  const agentsOn = settings.get('externalAgents.enabled').value;
  const scriptsOn = settings.get('scripts.enabled').value;
  if (!session) return { actions: null, banner: null, panes: [], dialogs: null };

  const envKind = extras?.environment?.kind ?? environment?.kind ?? null;
  const envLabel = extras?.environment?.label ?? environment?.label ?? null;
  const remote = isRemoteKind(envKind);
  const noAttempts = attemptsUnavailable(session, remote);

  const actions = (
    <>
      <Button onClick={() => setHandingOff(true)}>
        <Icon name="forward" /> {SESSION_M7_TEXT.handOff}
      </Button>
      <Button
        disabled={!!noAttempts}
        title={noAttempts ?? undefined}
        onClick={() => {
          onTab('attempts');
          setStartRequest((n) => n + 1);
        }}
      >
        <Icon name="split-right" /> {SESSION_M7_TEXT.bestOfN}
      </Button>
    </>
  );

  const banner =
    envKind === 'cloud' ? (
      <ThreadCloudRun
        key={session.threadId}
        threadId={session.threadId}
        environmentLabel={envLabel}
      />
    ) : null;

  const panes: SessionM7['panes'] = [
    {
      id: 'attempts',
      label: SESSION_M7_TEXT.tab.attempts,
      panel: (
        <AttemptsPane
          session={session}
          unavailable={noAttempts}
          startRequest={startRequest}
          onApplied={(merge) => {
            onMoved();
            if (merge.status === 'conflicted') onTab('merges');
          }}
        />
      ),
    },
    {
      id: 'merges',
      label: SESSION_M7_TEXT.tab.merges,
      panel: <MergePane session={session} remote={remote} onChanged={onMoved} />,
    },
    {
      id: 'moves',
      label: SESSION_M7_TEXT.tab.moves,
      panel: (
        <HandoffHistory
          sessionId={session.id}
          threadId={session.threadId}
          onMove={() => setHandingOff(true)}
        />
      ),
    },
  ];
  if (agentsOn)
    panes.push({
      id: 'agents',
      label: SESSION_M7_TEXT.tab.agents,
      panel: <DelegationsPane sessionId={session.id} threadId={session.threadId} />,
    });
  if (scriptsOn)
    panes.push({
      id: 'scripts',
      label: SESSION_M7_TEXT.tab.scripts,
      panel: <ScriptRuns threadId={session.threadId} />,
    });

  // Each pane mounts once first shown, and stays mounted afterwards (like the session's own tabs).
  for (const p of panes) if (!shown.has(p.id)) p.panel = null;

  const dialogs = (
    <HandoffDialog
      open={handingOff}
      session={session}
      hubLocal={!remote}
      onClose={() => setHandingOff(false)}
      onFinished={(v: SessionHandoffView) => {
        if (v.status === 'completed') onMoved();
      }}
    />
  );
  return { actions, banner, panes, dialogs };
}
