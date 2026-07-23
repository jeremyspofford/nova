import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { getSettings, SettingDef } from '../../api';
import { SettingsTab } from './SettingsTab';
import { StorageCard, PhoneSetupCard } from './cards';
import { CardsSkeleton } from '../ui';

/** True settings only — the entity managers live in the Library. A left
 *  section list replaces the old single scroll; sections come from the
 *  backend defs, so new ones appear here without UI changes. */

// these defs render inside their Library managers, not here
const EXCLUDED = ['Automations', 'Models'];
// preferred ordering; sections the list doesn't know append in backend order
const ORDER = ['Operator', 'Appearance', 'Voice', 'Context', 'Inference',
               'Agents', 'MCP', 'Notifications', 'Observability'];
const SYSTEM = 'Storage & phone';  // static cards, not backend defs

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-');

export function SettingsPage({ onClose }: { onClose: () => void }) {
  const [defs, setDefs] = useState<SettingDef[]>([]);
  const [loaded, setLoaded] = useState(false);
  const navigate = useNavigate();
  const { section } = useParams();

  useEffect(() => {
    getSettings().then(setDefs).catch(() => {}).finally(() => setLoaded(true));
  }, []);

  const sections = [...new Set(defs.map(d => d.section))]
    .filter(s => !EXCLUDED.includes(s))
    .sort((a, b) => {
      const ia = ORDER.indexOf(a), ib = ORDER.indexOf(b);
      return (ia === -1 ? ORDER.length : ia) - (ib === -1 ? ORDER.length : ib);
    });
  const nav = [...sections, SYSTEM];
  const active = nav.find(s => slug(s) === section) ?? nav[0];

  return (
    <div className="absolute inset-0 z-30 flex items-start justify-center pt-16 bg-black/40" onClick={onClose}>
      <div
        className="w-[54rem] max-w-[calc(100vw-1rem)] md:max-w-[calc(100vw-26rem)] h-[82vh] flex flex-col rounded-xl bg-stone-900/95 backdrop-blur border border-stone-700 shadow-2xl"
        onClick={e => e.stopPropagation()}
      >
        <header className="px-4 py-3 border-b border-stone-700 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-stone-200 px-1">Settings</h2>
          <button onClick={onClose} className="text-stone-500 hover:text-stone-200 text-lg px-1" aria-label="Close">×</button>
        </header>
        <div className="flex-1 min-h-0 flex">
          <nav className="w-32 md:w-44 shrink-0 border-r border-stone-800 overflow-y-auto nice-scroll py-2">
            {/* phones have no Library rail item — reachable from here */}
            <button
              onClick={() => navigate('/library')}
              className="md:hidden block w-full text-left px-4 py-2 text-sm text-stone-400 hover:text-stone-200 border-b border-stone-800 mb-1"
            >
              Library →
            </button>
            {(loaded ? nav : []).map(s => (
              <button
                key={s}
                onClick={() => navigate(`/settings/${slug(s)}`)}
                className={`block w-full text-left px-4 py-2 text-sm ${
                  s === active ? 'text-teal-300 bg-stone-800/70' : 'text-stone-400 hover:text-stone-200'}`}
              >
                {s}
              </button>
            ))}
          </nav>
          <div className="flex-1 overflow-y-auto nice-scroll p-4">
            {!loaded ? <CardsSkeleton n={3} />
              : active === SYSTEM ? (
                <div className="space-y-5">
                  <StorageCard />
                  <PhoneSetupCard defs={defs} />
                </div>
              ) : active ? <SettingsTab only={[active]} /> : null}
          </div>
        </div>
      </div>
    </div>
  );
}
