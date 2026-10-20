// Host changes (FR-136, docs/22 §6): the security setting `network.setup.allowSystemChanges`
// that lets the Network Setup assistant run mesh, firewall and package commands on the Hub. Off,
// Nova only detects and plans. Turning it on asks first; managed policy can lock it. Steps that
// need it say so and move focus here instead of offering an Apply that cannot work.
import { useId, useState } from 'react';
import { defineMessages } from '@nova/i18n';
import { Button, Icon, useToast } from '@nova/ui';
import { SwitchField } from '../settings/controls.tsx';
import { useSettings } from '../settings.tsx';
import { useAnnounce } from '../services.tsx';
import { netErrorMessage } from './format.ts';
import { ConfirmDialog } from './parts.tsx';

const S = defineMessages('netsurface.hostChanges', {
  title: 'Host changes',
  isOn: 'Host changes are on.',
  isOff: 'Host changes are off.',
  label: "Let Nova change this computer's network",
  descriptionOn:
    'On: Nova can install the mesh client and run mesh, firewall and package commands on the Hub, one step at a time, each after you confirm it.',
  descriptionOff: 'Off: Nova only looks and plans. Applying or rolling back a step needs this on.',
  offFailed: 'Could not turn host changes off.',
  note: 'A security setting: it applies to the whole Hub and is recorded in the audit log.',
  confirmTitle: "Let Nova change this computer's network?",
  confirmText:
    "Nova will run the commands of each step you apply, as the Hub's user: installing the mesh client, joining the mesh, changing mesh settings and opening the Hub's port in the firewall. " +
    'It asks before the first change of each kind, tests every step and undoes one that fails.',
  turnOn: 'Turn on',
  locked:
    '{what, select, rollBack {Rolling back} rollBackStep {Rolling it back} other {Applying this step}} changes this computer, and your organization keeps host changes off. Do it by hand, or ask your administrator.',
  needed:
    '{what, select, rollBack {Rolling back} rollBackStep {Rolling it back} other {Applying this step}} changes this computer, so it needs host changes on.',
  goTo: 'Go to host changes',
});

export const HOST_CHANGES_ANCHOR = 'host-changes';

/** Move focus to the host changes switch (the page's own control for the setting). */
export function focusHostChanges(): void {
  const el = document.querySelector<HTMLElement>(`[data-anchor="${HOST_CHANGES_ANCHOR}"]`);
  el?.scrollIntoView?.({ block: 'start' });
  el?.focus();
}

export function HostChanges() {
  const settings = useSettings();
  const toast = useToast();
  const announce = useAnnounce();
  const headingId = useId();
  const entry = settings.get('network.setup.allowSystemChanges');
  const [confirming, setConfirming] = useState(false);
  const save = async (on: boolean) => {
    await settings.set('network.setup.allowSystemChanges', on);
    announce(on ? S.isOn : S.isOff);
  };
  return (
    <section className="ws-section" aria-labelledby={headingId}>
      <h2 id={headingId} tabIndex={-1} className="net-anchor" data-anchor={HOST_CHANGES_ANCHOR}>
        {S.title}
      </h2>
      <SwitchField
        label={S.label}
        description={entry.value ? S.descriptionOn : S.descriptionOff}
        checked={entry.value}
        locked={entry.locked}
        onChange={(next) => {
          if (next) {
            setConfirming(true);
            return;
          }
          save(false).catch((err: unknown) =>
            toast.show(netErrorMessage(err, S.offFailed), { tone: 'error' }),
          );
        }}
      />
      <p className="muted ws-flush net-small">{S.note}</p>
      <ConfirmDialog
        open={confirming}
        title={S.confirmTitle}
        description={S.confirmText}
        confirmLabel={S.turnOn}
        onClose={() => setConfirming(false)}
        onConfirm={async () => {
          await save(true);
          setConfirming(false);
        }}
      />
    </section>
  );
}

/**
 * Why a step that changes the host cannot be applied (or rolled back) now, and where to change
 * that.
 */
export function HostChangesNeeded({
  action = 'apply',
}: {
  action?: 'apply' | 'rollBack' | 'rollBackStep';
}) {
  const locked = useSettings().get('network.setup.allowSystemChanges').locked;
  return (
    <div className="net-unavailable-text">
      <Icon name="alert" />
      {locked ? (
        <p>{S.locked({ what: action })}</p>
      ) : (
        <div>
          <p>{S.needed({ what: action })}</p>
          <Button variant="ghost" onClick={focusHostChanges}>
            {S.goTo}
          </Button>
        </div>
      )}
    </div>
  );
}
