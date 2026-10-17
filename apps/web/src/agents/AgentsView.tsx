// Agents mode (FR-079..FR-090; docs/04 §1, §2.5): /agents lists the agents, /agents/new creates
// one and /agents/:id is one agent (its conversation and sections, `?tab=` picks a section). The
// shell keeps every mode mounted; Agents renders only while it is shown, so other pages never
// load agents, and coming back reloads them fresh.
import { useRoute } from '../router.ts';
import { AgentList } from './AgentList.tsx';
import { AgentPage } from './AgentPage.tsx';
import { NewAgentPage } from './NewAgentPage.tsx';

export function AgentsView({ id }: { id: string | null }) {
  const route = useRoute();
  if (route.name !== 'mode' || route.mode !== 'agents') return null;
  if (id === 'new') return <NewAgentPage />;
  return id ? <AgentPage key={id} agentId={id} /> : <AgentList />;
}
