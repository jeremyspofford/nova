// Projects (FR-034, FR-040): group chats, sources and instructions. Filled in by M2.
import { EmptyState } from '@nova/ui';

export function ProjectsView({ projectId }: { projectId: string | null }) {
  return (
    <EmptyState
      title={projectId ? 'Project' : 'Projects'}
      description="Projects group chats, sources and instructions."
      level={2}
    />
  );
}
