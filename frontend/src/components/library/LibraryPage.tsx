import { useNavigate, useParams } from 'react-router-dom';
import { AgentsTab } from './AgentsTab';
import { ModelsTab } from './ModelsTab';
import { AutomationsTab } from './AutomationsTab';
import { RulesTab } from './RulesTab';
import { ToolsTab } from './ToolsTab';
import { SkillsTab } from './SkillsTab';

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
    <div className="absolute inset-0 z-30 flex items-start justify-center pt-16 bg-black/40" onClick={onClose}>
      <div
        className="w-[46rem] max-w-[calc(100vw-1rem)] md:max-w-[calc(100vw-26rem)] max-h-[82vh] flex flex-col rounded-xl bg-stone-900/95 backdrop-blur border border-stone-700 shadow-2xl"
        onClick={e => e.stopPropagation()}
      >
        <header className="px-4 py-3 border-b border-stone-700 flex items-center justify-between">
          <div className="flex gap-1 text-sm">
            {KINDS.map(k => (
              <button
                key={k}
                onClick={() => navigate(`/library/${k}`)}
                className={`px-3 py-1.5 rounded capitalize ${
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
    </div>
  );
}
