// Settings → Notifications inside the desktop app (FR-013, FR-008): the app shows Nova's
// notifications through the operating system itself, following the routing rules and quiet hours,
// so the page never asks the browser for permission there (the page sees it as denied, and each
// notification shows once). Replaces the browser's "This device" permission section in the app.
import { useId } from 'react';
import { Icon } from '@nova/ui';
import './shellbridge.css';

export function ShellNotificationsNote() {
  const headingId = useId();
  return (
    <section className="settings-section" aria-labelledby={headingId}>
      <h3 id={headingId}>This device</h3>
      <p className="shb-note-line">
        <Icon name="bell" /> The Nova desktop app shows notifications from your operating system.
        They follow the rules below, including quiet hours, and open the item when you click them.
      </p>
      <p className="muted">
        To turn them off on this computer only, use your operating system’s notification settings
        for Nova. Turning a kind off above turns it off everywhere.
      </p>
    </section>
  );
}
