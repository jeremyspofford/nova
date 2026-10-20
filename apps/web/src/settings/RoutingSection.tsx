// Routing (FR-127): the order in which a turn picks where it runs, and whether it may fall back to
// a cloud provider. "Allow cloud models" is a security setting, so it can be locked by policy.
import { useRef } from 'react';
import { defineMessages } from '@nova/i18n';
import { ROUTING_STEPS } from '@nova/shared';
import { Button, useToast } from '@nova/ui';
import { errorMessage } from '../api.ts';
import { useSettings } from '../settings.tsx';
import { ManagedNote } from '../managed/ManagedNote.tsx';
import { focusMoved, moveItem } from './common.ts';
import { SwitchField } from './controls.tsx';

type Step = (typeof ROUTING_STEPS)[number];

export const ROUTING_TEXT = defineMessages('settings.routing.steps', {
  same_device: {
    label: 'This device',
    description: 'Prefer a model on the device you are using.',
  },
  capability: {
    label: 'Capable models',
    description: 'Prefer models that support what the turn needs, like images or tools.',
  },
  least_loaded: {
    label: 'Least busy',
    description: 'Prefer the compute node with the fewest jobs running.',
  },
  cost: { label: 'Lowest cost', description: 'Prefer the cheapest model that fits.' },
  cloud: {
    label: 'Cloud providers',
    description: 'Use a hosted provider when nothing local fits.',
  },
});

const S = defineMessages('settings.routing', {
  saveFailed: 'Could not save: {error}',
  allowCloud: 'Allow cloud models',
  allowCloudHint:
    'When off, turns run only on this Hub and your compute nodes, never on a hosted provider.',
  order: 'Where a turn runs, in order of preference',
  position: '{n}. {label}',
  cloudOff: 'Off: cloud models are not allowed.',
  moveUp: 'Move {label} up',
  moveDown: 'Move {label} down',
  up: 'Up',
  down: 'Down',
});

/** The stored order, with any step it leaves out appended so every step can be placed. */
export function fullOrder(order: readonly Step[]): Step[] {
  return [...order, ...ROUTING_STEPS.filter((s) => !order.includes(s))];
}

export function RoutingSection() {
  const settings = useSettings();
  const toast = useToast();
  const order = settings.get('routing.order');
  const cloud = settings.get('routing.allowCloud');
  const listRef = useRef<HTMLOListElement>(null);
  const steps = fullOrder(order.value);

  const fail = (err: unknown) =>
    toast.show(S.saveFailed({ error: errorMessage(err) }), { tone: 'error' });

  const move = (i: number, dir: 'up' | 'down') => {
    const step = steps[i];
    if (!step) return;
    void settings.set('routing.order', moveItem(steps, i, dir === 'up' ? -1 : 1)).catch(fail);
    focusMoved(listRef.current, step, dir);
  };

  return (
    <div className="stack">
      <SwitchField
        label={S.allowCloud}
        description={S.allowCloudHint}
        checked={cloud.value}
        locked={cloud.locked}
        setting="routing.allowCloud"
        onChange={(v) => void settings.set('routing.allowCloud', v).catch(fail)}
      />
      <div className="stack">
        <span className="nv-field-label" id="routing-order-label">
          {S.order}
        </span>
        {order.locked ? <ManagedNote id="routing-order-lock" setting="routing.order" /> : null}
        <ol
          ref={listRef}
          className="ws-list"
          aria-labelledby="routing-order-label"
          aria-describedby={order.locked ? 'routing-order-lock' : undefined}
        >
          {steps.map((s, i) => (
            <li key={s} className="ws-list-row" data-move-key={s}>
              <div className="ws-source-main">
                <strong>{S.position({ n: i + 1, label: ROUTING_TEXT[s].label })}</strong>
                <span className="muted ws-row-meta">
                  {ROUTING_TEXT[s].description}
                  {s === 'cloud' && !cloud.value ? ` ${S.cloudOff}` : ''}
                </span>
              </div>
              <div className="row ws-row-actions">
                <Button
                  variant="ghost"
                  data-move="up"
                  aria-label={S.moveUp({ label: ROUTING_TEXT[s].label })}
                  disabled={order.locked || i === 0}
                  onClick={() => move(i, 'up')}
                >
                  {S.up}
                </Button>
                <Button
                  variant="ghost"
                  data-move="down"
                  aria-label={S.moveDown({ label: ROUTING_TEXT[s].label })}
                  disabled={order.locked || i === steps.length - 1}
                  onClick={() => move(i, 'down')}
                >
                  {S.down}
                </Button>
              </div>
            </li>
          ))}
        </ol>
      </div>
    </div>
  );
}
