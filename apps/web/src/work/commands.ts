// Work commands in the palette (FR-003, docs/04 §5): New run, New schedule and Go to Scheduled.
// They carry no default key: Ctrl+Shift+N ("New run/session") depends on the mode and is the
// shell's to bind. The sidebar registers them once, since it is always mounted.
import { useEffect } from 'react';
import { defineMessages } from '@nova/i18n';
import { CATEGORY, type Command } from '../commands.ts';
import { navigate } from '../router.ts';
import { useServices } from '../services.tsx';
import { SCHEDULED_PATH } from './format.ts';

export const WORK_COMMAND_TEXT = defineMessages('work.commands', {
  newRun: 'New run',
  newSchedule: 'New schedule',
  scheduled: 'Go to Scheduled',
});

/** The commands, with titles read now (call it where the commands register). */
export function workCommands(go: (path: string) => void = navigate): Command[] {
  const S = WORK_COMMAND_TEXT;
  return [
    { id: 'work.newRun', title: S.newRun, category: CATEGORY.work, run: () => go('/work?new=1') },
    {
      id: 'work.newSchedule',
      title: S.newSchedule,
      category: CATEGORY.work,
      run: () => go(`${SCHEDULED_PATH}?new=1`),
    },
    {
      id: 'work.scheduled',
      title: S.scheduled,
      category: CATEGORY.navigation,
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
