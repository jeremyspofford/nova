// Routing (FR-127): the order in which a turn picks where it runs, and whether it may fall back to
// a cloud provider. "Allow cloud models" is a security setting, so it can be locked by policy.
import { useRef } from 'react';
import { ROUTING_STEPS } from '@nova/shared';
import { Button, useToast } from '@nova/ui';
import { errorMessage } from '../api.ts';
import { useSettings } from '../settings.tsx';
import { MANAGED, focusMoved, moveItem } from './common.ts';
import { SwitchField } from './controls.tsx';

type Step = (typeof ROUTING_STEPS)[number];

export const ROUTING_TEXT: Record<Step, { label: string; description: string }> = {
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
};

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
    toast.show(`Could not save: ${errorMessage(err)}`, { tone: 'error' });

  const move = (i: number, dir: 'up' | 'down') => {
    const step = steps[i];
    if (!step) return;
    void settings.set('routing.order', moveItem(steps, i, dir === 'up' ? -1 : 1)).catch(fail);
    focusMoved(listRef.current, step, dir);
  };

  return (
    <div className="stack">
      <SwitchField
        label="Allow cloud models"
        description="When off, turns run only on this Hub and your compute nodes, never on a hosted provider."
        checked={cloud.value}
        locked={cloud.locked}
        onChange={(v) => void settings.set('routing.allowCloud', v).catch(fail)}
      />
      <div className="stack">
        <span className="nv-field-label" id="routing-order-label">
          Where a turn runs, in order of preference
        </span>
        {order.locked ? <span className="nv-field-hint nv-field-lock">{MANAGED}</span> : null}
        <ol ref={listRef} className="ws-list" aria-labelledby="routing-order-label">
          {steps.map((s, i) => (
            <li key={s} className="ws-list-row" data-move-key={s}>
              <div className="ws-source-main">
                <strong>
                  {i + 1}. {ROUTING_TEXT[s].label}
                </strong>
                <span className="muted ws-row-meta">
                  {ROUTING_TEXT[s].description}
                  {s === 'cloud' && !cloud.value ? ' Off: cloud models are not allowed.' : ''}
                </span>
              </div>
              <div className="row ws-row-actions">
                <Button
                  variant="ghost"
                  data-move="up"
                  aria-label={`Move ${ROUTING_TEXT[s].label} up`}
                  disabled={order.locked || i === 0}
                  onClick={() => move(i, 'up')}
                >
                  Up
                </Button>
                <Button
                  variant="ghost"
                  data-move="down"
                  aria-label={`Move ${ROUTING_TEXT[s].label} down`}
                  disabled={order.locked || i === steps.length - 1}
                  onClick={() => move(i, 'down')}
                >
                  Down
                </Button>
              </div>
            </li>
          ))}
        </ol>
      </div>
    </div>
  );
}
