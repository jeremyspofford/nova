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
]);

export const destination = (id) => DESTINATIONS.find((d) => d.id === id) ?? null;

// phone: bottom tabs Home · Chat · Tasks · Memory · More, the rest under More.
// tablet and desktop: a slim rail, the orb (Home) on top, at most six destinations, Settings
// at the foot, and the rest under More.
const PLACES = {
  phone: { home: 'tab', primary: ['home', 'chat', 'tasks', 'memory'], more: ['automations', 'skills', 'activity', 'health', 'settings'], foot: [] },
  rail: { home: 'orb', primary: ['chat', 'tasks', 'memory', 'automations'], more: ['skills', 'activity', 'health'], foot: ['settings'] },
};

export function placement(layout) {
  const p = layout === 'phone' ? PLACES.phone : PLACES.rail;
  return { home: p.home, primary: [...p.primary], more: [...p.more], foot: [...p.foot] };
}

// Every destination a layout can reach, directly or through More.
export function reachable(layout) {
  const p = placement(layout);
  return [...new Set([...(p.home === 'orb' ? ['home'] : []), ...p.primary, ...p.more, ...p.foot])];
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
