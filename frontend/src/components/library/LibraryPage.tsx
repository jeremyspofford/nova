import { ComponentType } from 'react';
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
import { NavList, NavRow, Surface } from '../ui';
import { useIsMobile } from '../../shell/useIsMobile';
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

/** What each section holds, said once. The phone index shows it under the
 *  row — nine bare nouns is a quiz — and the desktop tab strip stays bare. */
const BLURB: Record<Kind, string> = {
  agents: 'Who does the work, and on which model',
  models: 'The pool she can draw on, local and cloud',
  automations: 'What runs on a schedule',
  rules: 'Standing instructions she has to follow',
  tools: 'What she can actually do',
  skills: 'Procedures she has been taught',
  documents: 'What you have given her to read',
  coding: 'The coding workspace and its grants',
  files: 'Her memory on disk, editable by hand',
};

const TAB: Record<Kind, ComponentType> = {
  agents: AgentsTab,
  models: ModelsTab,
  automations: AutomationsTab,
  rules: RulesTab,
  tools: ToolsTab,
  skills: SkillsTab,
  documents: DocumentsTab,
  coding: CodingTab,
  files: FilesTab,
};

const label = (k: Kind) => k.charAt(0).toUpperCase() + k.slice(1);

export function LibraryPage({ onClose }: { onClose: () => void }) {
  const navigate = useNavigate();
  const { kind } = useParams();
  const mobile = useIsMobile();
  // Every way OUT of the Files tab passes through here — a tab button, the
  // scrim, the ×, the back chevron — and none of them knew the editor had
  // unsaved work.
  const leave = (go: () => void) => { if (confirmDiscardFiles()) go(); };
  const known = (KINDS as readonly string[]).includes(kind ?? '');

  // The phone drills: an index of sections, then one section filling the
  // screen. A bare /library on the desktop still opens the first section,
  // because a card with a tab strip shows every destination at once anyway.
  if (mobile && !known) {
    return (
      <Surface
        title="Library"
        onBack={() => leave(onClose)}
        bodyClass="overflow-y-auto nice-scroll overscroll-contain"
      >
        <NavList>
          {KINDS.map(k => (
            <NavRow key={k} label={label(k)} note={BLURB[k]}
              onClick={() => navigate(`/library/${k}`)} />
          ))}
        </NavList>
      </Surface>
    );
  }

  const active: Kind = (known ? kind : 'agents') as Kind;
  const Tab = TAB[active];

  return (
    <Surface
      title={label(active)}
      /* Files is a two-pane explorer: a tree beside an editor does not fit
         the card width the other tabs were sized for. */
      width={active === 'files' ? 'w-[64rem]' : 'w-[46rem]'}
      onBack={() => leave(mobile ? () => navigate('/library') : onClose)}
      bodyClass={`overflow-y-auto nice-scroll overscroll-contain ${mobile ? 'p-3' : 'p-4'}`}
      header={
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
      }
    >
      <Tab />
    </Surface>
  );
}
