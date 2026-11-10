// Where you can go in Nova, and where each layout puts it. Every layout reaches the same
// destinations; they differ only in arrangement (DESIGN-SYSTEM §5). Pure, so it is unit-tested.

export const DESTINATIONS = Object.freeze([
  { id: 'home', label: 'Home', path: '/' },
  { id: 'chat', label: 'Chat', path: '/chat' },
  { id: 'tasks', label: 'Tasks', path: '/tasks' },
  { id: 'memory', label: 'Memory', path: '/memory' },
  { id: 'automations', label: 'Automations', path: '/automations' },
  { id: 'skills', label: 'Skills', path: '/skills' },
  { id: 'activity', label: 'Activity', path: '/activity' },
  { id: 'health', label: 'Health', path: '/health' },
  { id: 'settings', label: 'Settings', path: '/settings' },
  { id: 'capture', label: 'Capture', path: '/capture', parent: 'settings' },
  { id: 'topology', label: 'Machines and services', path: '/topology', parent: 'settings' },
  // Settings › About Nova, and the two pages it leads to (also reached from the version stamp).
  { id: 'about', label: 'About Nova', path: '/about', parent: 'settings' },
  { id: 'changelog', label: 'What’s new', path: '/changelog', parent: 'settings' },
  { id: 'pipeline', label: 'Where Nova stands', path: '/pipeline', parent: 'settings' },
  // Settings › Privacy leads to it: what each model call and service call was told, and where it went.
  { id: 'receipts', label: 'Receipts', path: '/receipts', parent: 'settings' },
]);

export const destination = (id) => DESTINATIONS.find((d) => d.id === id) ?? null;

// phone and a foldable's cover screen: the rail's content as a drawer from the title bar (owner
// decision 2026-11-08): Home and every other place as rows, Settings at the foot.
// tablet and desktop: the rail, the orb (Home) on top, every other place in the list (it scrolls
// when the window is short), Settings at the foot. No overflow menu (owner ruling 2026-11-08).
const PLACES = {
  phone: { home: 'row', primary: ['home', 'chat', 'tasks', 'memory', 'automations', 'skills', 'activity', 'health'], foot: ['settings'] },
  rail: { home: 'orb', primary: ['chat', 'tasks', 'memory', 'automations', 'skills', 'activity', 'health'], foot: ['settings'] },
};

export function placement(layout) {
  const p = layout === 'phone' ? PLACES.phone : PLACES.rail;
  return { home: p.home, primary: [...p.primary], foot: [...p.foot], secondary: DESTINATIONS.filter(d => d.parent === 'settings').map(d => d.id) };
}

// Modelled homes, including Settings children. The rendered UI gate independently checks
// actual doors against app.js VIEWS; this model alone cannot prove reachability.
export function reachable(layout) {
  const p = placement(layout);
  return [...new Set([...(p.home === 'orb' ? ['home'] : []), ...p.primary, ...p.foot, ...p.secondary])];
}

// The path → what to show. Era 2 paths keep working: /schedules is Automations.
export function routeOf(pathname) {
  const path = pathname.replace(/\/+$/, '') || '/';
  if (path === '/') return { dest: 'home' };
  if (path === '/chat') return { dest: 'chat', conversation: 'main' };
  if (path === '/new') return { dest: 'chat', conversation: null };
  const c = /^\/c\/([\w-]+)$/.exec(path);
  if (c) return { dest: 'chat', conversation: c[1] };
  if (path === '/schedules') return { dest: 'automations' };
  const d = DESTINATIONS.find((x) => x.path === path);
  return d ? { dest: d.id } : { dest: 'home', unknown: true };
}
