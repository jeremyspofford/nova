import { useNavigate, useParams } from 'react-router-dom';
import { AgentsTab } from './AgentsTab';
import { ModelsTab } from './ModelsTab';
import { AutomationsTab } from './AutomationsTab';
import { RulesTab } from './RulesTab';
import { ToolsTab } from './ToolsTab';
import { SkillsTab } from './SkillsTab';
import { OverlayScrim } from '../ui';

/** The Library: Nova's parts — agents, models, automations, rules, tools,
 *  skills. Entity management pulled out of Settings so Settings can be
 *  settings. */

const KINDS = ['agents', 'models', 'automations', 'rules', 'tools', 'skills'] as const;
type Kind = typeof KINDS[number];

export function LibraryPage({ onClose }: { onClose: () => void }) {
  const navigate = useNavigate();
  const { kind } = useParams();
  const active: Kind =
    (KINDS as readonly string[]).includes(kind ?? '') ? (kind as Kind) : 'agents';

  return (
    <OverlayScrim onClose={onClose}>
      <div
        className="w-[46rem] max-w-full max-h-[82vh] flex flex-col rounded-xl bg-stone-900/95 backdrop-blur border border-stone-700 shadow-2xl"
        onClick={e => e.stopPropagation()}
      >
        <header className="px-4 py-3 border-b border-stone-700 flex items-center justify-between">
          {/* six tabs want 427px; a squeezed card is 360. min-w-0 releases
              the flex item's automatic minimum size so the row shrinks
              instead of bursting out over the chat, and auto (not hidden)
              keeps the tabs it hides reachable. */}
          <div className="flex gap-1 text-sm min-w-0 overflow-x-auto nice-scroll">
            {KINDS.map(k => (
              <button
                key={k}
                onClick={() => navigate(`/library/${k}`)}
                className={`px-3 py-1.5 rounded capitalize shrink-0 ${
                  active === k ? 'bg-teal-700/50 text-teal-200' : 'text-stone-400 hover:text-stone-200'}`}
              >
                {k}
              </button>
            ))}
          </div>
          <button onClick={onClose} className="text-stone-500 hover:text-stone-200 text-lg px-1" aria-label="Close">×</button>
        </header>
        <div className="flex-1 overflow-y-auto nice-scroll p-4">
          {active === 'agents' ? <AgentsTab />
            : active === 'models' ? <ModelsTab />
            : active === 'automations' ? <AutomationsTab />
            : active === 'rules' ? <RulesTab />
            : active === 'tools' ? <ToolsTab />
            : <SkillsTab />}
        </div>
      </div>
    </OverlayScrim>
  );
}
