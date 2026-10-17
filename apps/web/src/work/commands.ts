// Work commands in the palette (FR-003, docs/04 §5): New run, New schedule and Go to Scheduled.
// They carry no default key: Ctrl+Shift+N ("New run/session") depends on the mode and is the
// shell's to bind. The sidebar registers them once, since it is always mounted.
import { useEffect } from 'react';
import type { Command } from '../commands.ts';
import { navigate } from '../router.ts';
import { useServices } from '../services.tsx';
import { SCHEDULED_PATH } from './format.ts';

export function workCommands(go: (path: string) => void = navigate): Command[] {
  return [
    { id: 'work.newRun', title: 'New run', category: 'Work', run: () => go('/work?new=1') },
    {
      id: 'work.newSchedule',
      title: 'New schedule',
      category: 'Work',
      run: () => go(`${SCHEDULED_PATH}?new=1`),
    },
    {
      id: 'work.scheduled',
      title: 'Go to Scheduled',
      category: 'Navigation',
      run: () => go(SCHEDULED_PATH),
    },
  ];
}

export function useWorkCommands(): void {
  const { registry } = useServices();
  useEffect(() => {
    const offs = workCommands().map((c) => registry.register(c));
    return () => offs.forEach((off) => off());
  }, [registry]);
}
