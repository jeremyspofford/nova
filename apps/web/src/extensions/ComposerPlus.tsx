// The composer's + menu (docs/04 §2.9 and §3; FR-198, FR-117): the open chat's apps (thread entry
// points from plugins, MCP servers and extensions), each opening in the Inspector's Apps tab, and
// the composer menu items running extensions add. The chat's apps are read when the button is
// reached or the menu opens, so a chat that never uses it never asks for them. With nothing to offer, it points to the
// marketplace.
import { useState } from 'react';
import type { UiEntryPointView } from '@nova/shared';
import { Icon, Menu, useToast, type MenuItem } from '@nova/ui';
import { SHOW_APPS_COMMAND, requestThreadApp } from '../apps/AppsView.tsx';
import { marketTabPath } from '../market/format.ts';
import { navigate } from '../router.ts';
import { useServices } from '../services.tsx';
import { useTeamRole } from '../team/role.tsx';
import { useExtensionMenuItems } from './shell.tsx';

export const PLUS_TEXT = {
  label: 'Apps and more',
  openApp: (title: string) => `Open ${title}`,
  loading: 'Loading apps…',
  noThread: 'Send a first message to open apps for this chat',
  noApps: 'No apps for chats yet',
  findApps: 'Find apps in the Marketplace',
  appOpened: (title: string) => `${title} opens in the Inspector’s Apps tab.`,
  failed: 'Could not load the apps.',
} as const;

export function ComposerPlusMenu({ threadId }: { threadId: string | null }) {
  const { api, registry } = useServices();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [apps, setApps] = useState<UiEntryPointView[] | null | 'error'>(null);
  const extItems = useExtensionMenuItems('composer', threadId ? { threadId } : {});
  const { isMember } = useTeamRole();

  // Read when the button is reached (hover or focus) and again on opening, so the list is ready.
  const load = () => {
    if (!threadId) return;
    api.uiEntryPoints('thread').then(
      ({ items }) => setApps(items),
      () => setApps((a) => (Array.isArray(a) ? a : 'error')),
    );
  };
  const onOpenChange = (next: boolean) => {
    setOpen(next);
    if (next) load();
  };

  const openApp = (entry: UiEntryPointView, tid: string) => {
    requestThreadApp(entry, tid);
    // The shell's command shows the Apps tab; without it the app waits there until it is opened.
    if (!registry.run(SHOW_APPS_COMMAND))
      toast.show(PLUS_TEXT.appOpened(entry.title), { tone: 'info' });
  };

  const appItems: MenuItem[] = !threadId
    ? [{ id: 'apps-none', label: PLUS_TEXT.noThread, disabled: true, onSelect: () => undefined }]
    : apps === null
      ? [
          {
            id: 'apps-loading',
            label: PLUS_TEXT.loading,
            disabled: true,
            onSelect: () => undefined,
          },
        ]
      : apps === 'error'
        ? [{ id: 'apps-error', label: PLUS_TEXT.failed, disabled: true, onSelect: () => undefined }]
        : apps.length === 0
          ? [
              {
                id: 'apps-empty',
                label: PLUS_TEXT.noApps,
                disabled: true,
                onSelect: () => undefined,
              },
            ]
          : apps.map((e) => ({
              id: `app:${e.id}`,
              label: PLUS_TEXT.openApp(e.title),
              onSelect: () => openApp(e, threadId),
            }));
  const items: MenuItem[] = [
    ...appItems,
    ...extItems,
    // The marketplace is the owner's.
    ...(isMember
      ? []
      : [
          {
            id: 'find-apps',
            label: PLUS_TEXT.findApps,
            onSelect: () => navigate(marketTabPath('plugins')),
          },
        ]),
  ];

  return (
    <Menu
      label={PLUS_TEXT.label}
      trigger={<Icon name="plus" />}
      items={items}
      open={open}
      onOpenChange={onOpenChange}
      className="composer-plus"
      triggerProps={{
        onFocus: () => apps === null && load(),
        onMouseEnter: () => apps === null && load(),
      }}
    />
  );
}
