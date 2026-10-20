// Work mode navigation: the Runs and Scheduled tabs, and in-app links that keep the browser's
// own behaviour for modified clicks (open in a new tab).
import { defineMessages } from '@nova/i18n';
import { navigate } from '../router.ts';
import { SCHEDULED_PATH } from './format.ts';

export const WORK_NAV_TEXT = defineMessages('work.nav', {
  sections: 'Work sections',
  runs: 'Runs',
  scheduled: 'Scheduled',
});

/** Runs and Scheduled, the two lists of Work mode. */
export function WorkNav({ current }: { current: 'runs' | 'scheduled' }) {
  const link = (path: string, label: string, here: boolean) => (
    <a
      href={path}
      className="work-tab"
      aria-current={here ? 'page' : undefined}
      onClick={(e) => followLink(e, path)}
    >
      {label}
    </a>
  );
  return (
    <nav className="work-tabs" aria-label={WORK_NAV_TEXT.sections}>
      {link('/work', WORK_NAV_TEXT.runs, current === 'runs')}
      {link(SCHEDULED_PATH, WORK_NAV_TEXT.scheduled, current === 'scheduled')}
    </nav>
  );
}

/** Opens a Work link in the app (modified clicks keep the browser's behaviour). */
export function followLink(e: React.MouseEvent, path: string): void {
  if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
  e.preventDefault();
  navigate(path);
}
