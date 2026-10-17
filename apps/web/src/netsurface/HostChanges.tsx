// Host changes (FR-136, docs/22 §6): the security setting `network.setup.allowSystemChanges`
// that lets the Network Setup assistant run mesh, firewall and package commands on the Hub. Off,
// Nova only detects and plans. Turning it on asks first; managed policy can lock it. Steps that
// need it say so and move focus here instead of offering an Apply that cannot work.
import { useId, useState } from 'react';
import { Button, Icon, useToast } from '@nova/ui';
import { SwitchField } from '../settings/controls.tsx';
import { useSettings } from '../settings.tsx';
import { useAnnounce } from '../services.tsx';
import { netErrorMessage } from './format.ts';
import { ConfirmDialog } from './parts.tsx';

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
    announce(on ? 'Host changes are on.' : 'Host changes are off.');
  };
  return (
    <section className="ws-section" aria-labelledby={headingId}>
      <h2 id={headingId} tabIndex={-1} className="net-anchor" data-anchor={HOST_CHANGES_ANCHOR}>
        Host changes
      </h2>
      <SwitchField
        label="Let Nova change this computer's network"
        description={
          entry.value
            ? 'On: Nova can install the mesh client and run mesh, firewall and package commands on the Hub, one step at a time, each after you confirm it.'
            : 'Off: Nova only looks and plans. Applying or rolling back a step needs this on.'
        }
        checked={entry.value}
        locked={entry.locked}
        onChange={(next) => {
          if (next) {
            setConfirming(true);
            return;
          }
          save(false).catch((err: unknown) =>
            toast.show(netErrorMessage(err, 'Could not turn host changes off.'), { tone: 'error' }),
          );
        }}
      />
      <p className="muted ws-flush net-small">
        A security setting: it applies to the whole Hub and is recorded in the audit log.
      </p>
      <ConfirmDialog
        open={confirming}
        title="Let Nova change this computer's network?"
        description="Nova will run the commands of each step you apply, as the Hub's user: installing the mesh client, joining the mesh, changing mesh settings and opening the Hub's port in the firewall. It asks before the first change of each kind, tests every step and undoes one that fails."
        confirmLabel="Turn on"
        onClose={() => setConfirming(false)}
        onConfirm={async () => {
          await save(true);
          setConfirming(false);
        }}
      />
    </section>
  );
}

/** Why a step that changes the host cannot be applied now, and where to change that. */
export function HostChangesNeeded({ what = 'Applying this step' }: { what?: string }) {
  const locked = useSettings().get('network.setup.allowSystemChanges').locked;
  return (
    <div className="net-unavailable-text">
      <Icon name="alert" />
      {locked ? (
        <p>
          {what} changes this computer, and your organization keeps host changes off. Do it by hand,
          or ask your administrator.
        </p>
      ) : (
        <div>
          <p>{what} changes this computer, so it needs host changes on.</p>
          <Button variant="ghost" onClick={focusHostChanges}>
            Go to host changes
          </Button>
        </div>
      )}
    </div>
  );
}
