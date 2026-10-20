// Settings → Notifications (FR-013, docs/14 §1.1): which categories Nova shows and sends to the
// operating system, and permission for OS notifications on this device. The browser keeps that
// permission per device; once blocked, only the browser's site settings can allow it again. M8: a
// member chooses where their notifications go and which devices get them; which kinds Nova shows
// and how pushes read are the Hub's, and say so (src/team/access.tsx).
import { useState } from 'react';
import { defineMessages } from '@nova/i18n';
import { NOTIFICATION_KINDS } from '@nova/shared';
import { Button, useToast } from '@nova/ui';
import { errorMessage } from '../api.ts';
import { NotificationRoutingSection } from '../channels/NotificationRoutingSection.tsx';
import { osPermission, requestOsPermission, type OsPermission } from '../notifications/os.ts';
import { useSettings } from '../settings.tsx';
import { SwitchField } from './controls.tsx';
import '../workspace.css';
import { PushSection } from '../push/PushSection.tsx';
import { ShellNotificationsNote } from '../shellbridge/NotificationsNote.tsx';
import { useShell } from '../shellbridge/bridge.ts';
import { MemberNote, OwnerSets, useMemberAccess } from '../team/access.tsx';
import { MEMBER_MODE_TEXT } from '../team/format.ts';

export const CATEGORY_TEXT = defineMessages('settings.notifications.categories', {
  approval: {
    label: 'Approvals',
    description: 'An action is waiting for your decision.',
  },
  completion: {
    label: 'Finished work',
    description: 'A reply, run or task you started has finished.',
  },
  error: {
    label: 'Errors',
    description: 'Something failed, such as a reply, a tool or a server.',
  },
  attention: {
    label: 'Needs attention',
    description: 'Something needs you, such as a step handed to you or a device that went away.',
  },
  system: {
    label: 'System',
    description: 'Updates and notices about the Hub itself.',
  },
});

export const NOTIFICATIONS_TEXT = defineMessages('settings.notifications', {
  title: 'Notifications',
  whatToNotify: 'What to notify you about',
  whatToNotifyHint:
    'Turned-off categories are not listed in the notification center and are not sent to your ' +
    'devices.',
  saveFailed: 'Could not save: {error}',
  whileOpen: 'While Nova is open',
  whileOpenHint: 'When Nova is in the background, notifications can also appear on this device.',
  allow: 'Allow notifications on this device',
  permission: {
    unsupported: 'This browser cannot show notifications.',
    default: 'Notifications are not allowed on this device yet.',
    granted: 'Notifications are allowed on this device.',
    denied:
      'Notifications are blocked on this device. Allow them in your browser’s site settings, ' +
      'then reload.',
  },
});
const S = NOTIFICATIONS_TEXT;

export function NotificationsPage() {
  const shell = useShell();
  const settings = useSettings();
  const access = useMemberAccess();
  const toast = useToast();
  const cats = settings.get('notifications.categories');
  const [permission, setPermission] = useState<OsPermission>(() => osPermission());
  const [asking, setAsking] = useState(false);

  const ask = async () => {
    setAsking(true);
    const next = await requestOsPermission();
    setAsking(false);
    setPermission(next);
  };

  return (
    <div className="settings-page">
      <h2>{S.title}</h2>
      <MemberNote access={access}>{MEMBER_MODE_TEXT.notifications}</MemberNote>
      {access.hubSettings ? (
        <section className="settings-section" aria-labelledby="notif-categories">
          <h3 id="notif-categories">{S.whatToNotify}</h3>
          <p className="muted">{S.whatToNotifyHint}</p>
          {NOTIFICATION_KINDS.map((k) => (
            <SwitchField
              key={k}
              label={CATEGORY_TEXT[k].label}
              description={CATEGORY_TEXT[k].description}
              checked={cats.value[k]}
              locked={cats.locked}
              onChange={(v) =>
                void settings
                  .set('notifications.categories', { ...cats.value, [k]: v })
                  .catch((err: unknown) =>
                    toast.show(S.saveFailed({ error: errorMessage(err) }), { tone: 'error' }),
                  )
              }
            />
          ))}
        </section>
      ) : (
        <OwnerSets heading={MEMBER_MODE_TEXT.categoriesHeading}>
          {MEMBER_MODE_TEXT.categories}
        </OwnerSets>
      )}
      {/* In the desktop app it shows OS notifications itself (FR-008, M7). */}
      {shell ? <ShellNotificationsNote /> : null}
      <section className="settings-section" aria-labelledby="notif-device" hidden={!!shell}>
        <h3 id="notif-device">{S.whileOpen}</h3>
        <p className="muted">{S.whileOpenHint}</p>
        <p role="status" className="ws-flush">
          {S.permission[permission]}
        </p>
        {permission === 'default' ? (
          <div className="row">
            <Button variant="primary" disabled={asking} onClick={() => void ask()}>
              {S.allow}
            </Button>
          </div>
        ) : null}
      </section>
      {/* Push to this device while Nova is closed (FR-111, M7); the desktop app shows its own. */}
      {shell ? null : (
        <PushSection hubSettingsNote={access.hubSettings ? undefined : MEMBER_MODE_TEXT.pushHub} />
      )}
      <NotificationRoutingSection />
    </div>
  );
}
