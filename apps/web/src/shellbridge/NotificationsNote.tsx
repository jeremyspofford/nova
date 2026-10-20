// Settings → Notifications inside the desktop app (FR-013, FR-008): the app shows Nova's
// notifications through the operating system itself, following the routing rules and quiet hours,
// so the page never asks the browser for permission there (the page sees it as denied, and each
// notification shows once). Replaces the browser's "This device" permission section in the app.
import { useId } from 'react';
import { defineMessages } from '@nova/i18n';
import { Icon } from '@nova/ui';
import './shellbridge.css';

export const SHELL_NOTIFICATIONS_TEXT = defineMessages('shellbridge.notifications', {
  heading: 'This device',
  shown:
    'The Nova desktop app shows notifications from your operating system. They follow the ' +
    'rules below, including quiet hours, and open the item when you click them.',
  turnOff:
    'To turn them off on this computer only, use your operating system’s notification ' +
    'settings for Nova. Turning a kind off above turns it off everywhere.',
});

export function ShellNotificationsNote() {
  const headingId = useId();
  const S = SHELL_NOTIFICATIONS_TEXT;
  return (
    <section className="settings-section" aria-labelledby={headingId}>
      <h3 id={headingId}>{S.heading}</h3>
      <p className="shb-note-line">
        <Icon name="bell" /> {S.shown}
      </p>
      <p className="muted">{S.turnOff}</p>
    </section>
  );
}
