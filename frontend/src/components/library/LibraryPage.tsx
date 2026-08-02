import { useNavigate, useParams } from 'react-router-dom';
import { AgentsTab } from './AgentsTab';
import { ModelsTab } from './ModelsTab';
import { AutomationsTab } from './AutomationsTab';
import { RulesTab } from './RulesTab';
import { ToolsTab } from './ToolsTab';
import { SkillsTab } from './SkillsTab';
import { CodingTab } from './CodingTab';
import { DocumentsTab } from './DocumentsTab';
import { FilesTab } from './FilesTab';
import { OverlayScrim } from '../ui';
import { confirmDiscardFiles } from './files/dirty';

/** The Library: Nova's parts — agents, models, automations, rules, tools,
 *  skills, documents. Entity management pulled out of Settings so Settings
 *  can be settings.
 *
 *  `documents` is a TAB rather than a page because of the project rule that
 *  a surface reachable only by typing a URL does not exist: the answer to
 *  "what have I given her?" has to be one click from the things she is made
 *  of. */

const KINDS = ['agents', 'models', 'automations', 'rules', 'tools', 'skills',
               'documents', 'coding', 'files'] as const;
type Kind = typeof KINDS[number];

export function LibraryPage({ onClose }: { onClose: () => void }) {
  const navigate = useNavigate();
  const { kind } = useParams();
  // Every way OUT of the Files tab passes through here — a tab button, the
  // scrim, the × — and none of them knew the editor had unsaved work.
  const leave = (go: () => void) => { if (confirmDiscardFiles()) go(); };
  const active: Kind =
    (KINDS as readonly string[]).includes(kind ?? '') ? (kind as Kind) : 'agents';

  return (
    <OverlayScrim onClose={() => leave(onClose)}>
      <div
        /* Files is a two-pane explorer: a tree beside an editor does not fit
           the card width the other tabs were sized for. */
        className={`${active === 'files' ? 'w-[64rem]' : 'w-[46rem]'} max-w-full max-h-[82vh] flex flex-col rounded-xl bg-stone-900/95 backdrop-blur border border-stone-700 shadow-2xl`}
        onClick={e => e.stopPropagation()}
      >
        <header className="px-4 py-3 border-b border-stone-700 flex items-center justify-between">
          {/* seven tabs want ~500px; a squeezed card is 360. min-w-0 releases
              the flex item's automatic minimum size so the row shrinks
              instead of bursting out over the chat, and auto (not hidden)
              keeps the tabs it hides reachable. */}
          <div className="flex gap-1 text-sm min-w-0 overflow-x-auto nice-scroll">
            {KINDS.map(k => (
              <button
                key={k}
                onClick={() => leave(() => navigate(`/library/${k}`))}
                className={`px-3 py-1.5 rounded capitalize shrink-0 ${
                  active === k ? 'bg-teal-700/50 text-teal-200' : 'text-stone-400 hover:text-stone-200'}`}
              >
                {k}
              </button>
            ))}
          </div>
          <button onClick={() => leave(onClose)} className="text-stone-500 hover:text-stone-200 text-lg px-1" aria-label="Close">×</button>
        </header>
        <div className="flex-1 overflow-y-auto nice-scroll p-4">
          {active === 'agents' ? <AgentsTab />
            : active === 'models' ? <ModelsTab />
            : active === 'automations' ? <AutomationsTab />
            : active === 'rules' ? <RulesTab />
            : active === 'tools' ? <ToolsTab />
            : active === 'documents' ? <DocumentsTab />
            : active === 'coding' ? <CodingTab />
            : active === 'files' ? <FilesTab />
            : <SkillsTab />}
        </div>
      </div>
    </OverlayScrim>
  );
}
