// Work mode (FR-051..FR-058, FR-181, FR-182, FR-055): the runs list, a run (plan, progress,
// budgets, goal, result, activity) and Scheduled. Filled in by the Work UI.
import { EmptyState } from '@nova/ui';

export function WorkView({ id }: { id: string | null }) {
  return (
    <EmptyState
      title={id ? 'Run' : 'Work'}
      description="Work runs arrive with M5."
      icon="work"
      level={2}
    />
  );
}
