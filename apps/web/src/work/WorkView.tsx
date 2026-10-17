// Work mode (FR-051..FR-058, FR-181, FR-182, FR-055, FR-215): /work lists the runs, /work/:id is
// one run (goal, budgets, plan, conversation, sub-agents, result, activity) and /work/scheduled
// lists the schedules. The shell keeps every mode mounted; Work renders only while it is shown,
// so other pages never load runs or schedules, and coming back reloads them fresh.
import { useRoute } from '../router.ts';
import { RunPage } from './RunPage.tsx';
import { ScheduledView } from './ScheduledView.tsx';
import { WorkList } from './WorkList.tsx';

export function WorkView({ id }: { id: string | null }) {
  const route = useRoute();
  if (route.name !== 'mode' || route.mode !== 'work') return null;
  if (id === 'scheduled') return <ScheduledView />;
  return id ? <RunPage key={id} runId={id} /> : <WorkList />;
}
