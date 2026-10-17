// The advanced presets panel (FR-221, docs/04 §3.1, docs/07 §8.1): every preset on the Faster to
// Smarter scale with its strategy, ordered models, reasoning level and speed. Edits stay local
// until "Save presets"; "Reset to built-in" goes back to the generated set.
import { useEffect, useRef, useState } from 'react';
import { REASONING_LEVELS, presetSchema, type ModelView, type Preset } from '@nova/shared';
import { Button, Dialog, Icon, SelectField, Spinner, TextField, useToast } from '@nova/ui';
import { errorMessage } from '../api.ts';
import { modelGroups } from '../providers/model-groups.ts';
import { useServices } from '../services.tsx';
import { useSettings } from '../settings.tsx';
import { useModels } from '../stores.tsx';
import { MANAGED, focusMoved, moveItem } from './common.ts';

export const MAX_PRESETS = 20;
export const MAX_TARGETS = 8;

const STRATEGIES: { value: Preset['strategy']; label: string; hint: string }[] = [
  { value: 'single', label: 'One model', hint: 'Always uses the first model.' },
  {
    value: 'fallback',
    label: 'Fallback',
    hint: 'Tries the models in order when one fails or is busy.',
  },
  { value: 'cheapest', label: 'Cheapest', hint: 'Picks the lowest-cost model that fits.' },
  { value: 'best', label: 'Most capable', hint: 'Picks the most capable model that fits.' },
];

const REASONING_TEXT: Record<(typeof REASONING_LEVELS)[number], string> = {
  off: 'Off',
  minimal: 'Minimal',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra high',
  max: 'Maximum',
};

/** A preset id (`^[a-z0-9][a-z0-9-]{0,40}$`) from a label, unique among `taken`. */
export function presetId(label: string, taken: ReadonlySet<string>): string {
  const base =
    label
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 30) || 'preset';
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) if (!taken.has(`${base}-${n}`)) return `${base}-${n}`;
}

/** Problems that would make the Hub reject the list, in words for the form. */
export function presetProblems(items: readonly Preset[]): string[] {
  const out: string[] = [];
  if (items.length > MAX_PRESETS) out.push(`Keep at most ${MAX_PRESETS} presets.`);
  items.forEach((p, i) => {
    const name = p.label.trim() || `Preset ${i + 1}`;
    if (!p.label.trim()) out.push(`Preset ${i + 1} needs a name.`);
    if (p.targets.length === 0) out.push(`${name} needs at least one model.`);
    if (!presetSchema.safeParse(p).success && p.label.trim() && p.targets.length)
      out.push(`${name} has a setting the Hub does not accept.`);
  });
  return out;
}

const byRank = (list: readonly Preset[]) => [...list].sort((a, b) => a.rank - b.rank);

export function PresetsEditor() {
  const { api } = useServices();
  const settings = useSettings();
  const models = useModels();
  const toast = useToast();
  const locked = settings.get('models.presets').locked;
  const [loaded, setLoaded] = useState<{ items: Preset[]; builtIn: boolean } | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [draft, setDraft] = useState<Preset[] | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [confirmReset, setConfirmReset] = useState(false);
  const [version, setVersion] = useState(0);
  const listRef = useRef<HTMLOListElement>(null);

  useEffect(() => {
    let alive = true;
    api.listPresets().then(
      (r) => {
        if (!alive) return;
        setLoaded({ items: byRank(r.items), builtIn: r.builtIn });
        setLoadError(null);
      },
      (err: unknown) => alive && setLoadError(errorMessage(err, 'Could not load presets.')),
    );
    return () => {
      alive = false;
    };
  }, [api, version]);

  const choices = models.models.filter((m) => m.kind === 'model');
  const items = draft ?? loaded?.items ?? [];
  const dirty = draft !== null;
  const problems = presetProblems(items);
  const edit = (next: Preset[]) => {
    setDraft(next);
    setSaveError(null);
  };
  const patch = (i: number, p: Partial<Preset>) =>
    edit(items.map((x, j) => (j === i ? { ...x, ...p } : x)));

  const apply = (r: { items: Preset[]; builtIn: boolean }, message: string) => {
    setLoaded({ items: byRank(r.items), builtIn: r.builtIn });
    setDraft(null);
    void models.refresh();
    toast.show(message, { tone: 'success' });
  };

  const save = async () => {
    if (problems.length) return;
    setSaving(true);
    setSaveError(null);
    try {
      const ranked = items.map((p, i) => ({ ...p, label: p.label.trim(), rank: i + 1 }));
      apply(await api.savePresets(ranked), 'Presets saved.');
    } catch (err) {
      setSaveError(errorMessage(err, 'Could not save the presets.'));
    } finally {
      setSaving(false);
    }
  };

  const reset = async () => {
    setConfirmReset(false);
    setSaving(true);
    setSaveError(null);
    try {
      apply(await api.savePresets([]), 'Presets reset to the built-in set.');
    } catch (err) {
      setSaveError(errorMessage(err, 'Could not reset the presets.'));
    } finally {
      setSaving(false);
    }
  };

  const add = () => {
    const taken = new Set(items.map((p) => p.id));
    const first = choices[0]?.ref;
    edit([
      ...items,
      {
        id: presetId('custom', taken),
        label: 'Custom',
        strategy: 'single',
        targets: first ? [first] : [],
        rank: items.length + 1,
      },
    ]);
  };

  const move = (i: number, dir: 'up' | 'down') => {
    const p = items[i];
    if (!p) return;
    edit(moveItem(items, i, dir === 'up' ? -1 : 1));
    focusMoved(listRef.current, `preset:${p.id}`, dir);
  };

  if (loadError) {
    return (
      <div role="alert" className="ws-error">
        <p>{loadError}</p>
        <Button onClick={() => setVersion((v) => v + 1)}>Retry</Button>
      </div>
    );
  }
  if (!loaded) return <Spinner label="Loading presets" />;

  const availability = new Map(
    models.models.filter((m) => m.kind === 'preset').map((m) => [m.ref, m]),
  );

  return (
    <div className="stack">
      <p className="muted">
        The Faster to Smarter control in the message box picks one of these. Each preset is a
        virtual model: one or more models with a reasoning level and speed. Presets never start
        other agents on their own.{' '}
        {!dirty && loaded.builtIn ? <span className="ws-badge">Built-in</span> : null}
      </p>
      {locked ? <p className="nv-field-hint nv-field-lock">{MANAGED}</p> : null}
      <ol ref={listRef} className="ws-presets" aria-label="Presets, from faster to smarter">
        {items.map((p, i) => (
          <PresetCard
            key={p.id}
            preset={p}
            index={i}
            count={items.length}
            choices={choices}
            disabled={locked || saving}
            unavailable={availability.get(`preset:${p.id}`)?.disabledReason ?? null}
            onChange={(next) => patch(i, next)}
            onMove={(dir) => move(i, dir)}
            onRemove={() => edit(items.filter((_, j) => j !== i))}
          />
        ))}
      </ol>
      {problems.length && dirty ? (
        <ul className="ws-rejections" aria-label="Fix before saving">
          {problems.map((x) => (
            <li key={x}>{x}</li>
          ))}
        </ul>
      ) : null}
      {saveError ? (
        <p className="nv-field-error" role="alert">
          {saveError}
        </p>
      ) : null}
      <div className="row">
        <Button
          variant="primary"
          onClick={() => void save()}
          disabled={!dirty || saving || locked || problems.length > 0}
        >
          {saving ? <Spinner /> : null} Save presets
        </Button>
        <Button
          onClick={add}
          disabled={locked || saving || items.length >= MAX_PRESETS || choices.length === 0}
        >
          <Icon name="plus" /> Add preset
        </Button>
        <Button onClick={() => setDraft(null)} disabled={!dirty || saving}>
          Discard changes
        </Button>
        <Button
          variant="ghost"
          onClick={() => setConfirmReset(true)}
          disabled={locked || saving || (loaded.builtIn && !dirty)}
        >
          Reset to built-in
        </Button>
      </div>
      <Dialog
        open={confirmReset}
        title="Reset presets to the built-in set?"
        description="Your custom presets and changes are replaced by Faster, Balanced and Smarter, generated from the models you have connected."
        onClose={() => setConfirmReset(false)}
        footer={
          <>
            <Button onClick={() => setConfirmReset(false)}>Cancel</Button>
            <Button variant="danger" onClick={() => void reset()}>
              Reset
            </Button>
          </>
        }
      />
    </div>
  );
}

function PresetCard({
  preset: p,
  index,
  count,
  choices,
  disabled,
  unavailable,
  onChange,
  onMove,
  onRemove,
}: {
  preset: Preset;
  index: number;
  count: number;
  choices: ModelView[];
  disabled: boolean;
  unavailable: string | null;
  onChange: (p: Partial<Preset>) => void;
  onMove: (dir: 'up' | 'down') => void;
  onRemove: () => void;
}) {
  const targetsRef = useRef<HTMLOListElement>(null);
  const name = p.label.trim() || `Preset ${index + 1}`;
  const strategy = STRATEGIES.find((s) => s.value === p.strategy);
  const known = new Set(choices.map((m) => m.ref));
  const unused = choices.filter((m) => !p.targets.includes(m.ref));

  const moveTarget = (i: number, dir: 'up' | 'down') => {
    const ref = p.targets[i];
    if (ref === undefined) return;
    onChange({ targets: moveItem(p.targets, i, dir === 'up' ? -1 : 1) });
    focusMoved(targetsRef.current, `target:${p.id}:${ref}`, dir);
  };

  return (
    <li className="ws-preset" data-move-key={`preset:${p.id}`}>
      <fieldset className="ws-fieldset" disabled={disabled}>
        <legend>{name}</legend>
        {unavailable ? (
          <p className="ws-warning">
            <Icon name="alert" /> Unavailable: {unavailable}
          </p>
        ) : null}
        <div className="ws-preset-grid">
          <TextField
            label="Name"
            value={p.label}
            maxLength={60}
            onChange={(e) => onChange({ label: e.target.value })}
          />
          <SelectField
            label="Strategy"
            value={p.strategy}
            onChange={(v) => onChange({ strategy: v as Preset['strategy'] })}
            options={STRATEGIES.map((s) => ({ value: s.value, label: s.label }))}
            hint={strategy?.hint}
          />
          <SelectField
            label="Reasoning level"
            value={p.reasoningLevel ?? ''}
            onChange={(v) =>
              onChange({ reasoningLevel: v ? (v as Preset['reasoningLevel']) : undefined })
            }
            options={[
              { value: '', label: 'Model default' },
              ...REASONING_LEVELS.map((r) => ({ value: r, label: REASONING_TEXT[r] })),
            ]}
          />
          <SelectField
            label="Speed"
            value={p.speed ?? ''}
            onChange={(v) => onChange({ speed: v ? (v as Preset['speed']) : undefined })}
            options={[
              { value: '', label: 'Default' },
              { value: 'standard', label: 'Standard' },
              { value: 'fast', label: 'Fast' },
            ]}
          />
        </div>
        <div className="ws-targets">
          <span className="nv-field-label">Models, in order</span>
          <ol ref={targetsRef} className="ws-list">
            {p.targets.map((ref, i) => (
              <li key={ref} className="ws-target" data-move-key={`target:${p.id}:${ref}`}>
                <SelectField
                  label={`Model ${i + 1}`}
                  value={ref}
                  onChange={(v) =>
                    onChange({ targets: p.targets.map((x, j) => (j === i ? v : x)) })
                  }
                  options={known.has(ref) ? [] : [{ value: ref, label: `${ref} (not available)` }]}
                  groups={modelGroups(choices).map((g) => ({
                    ...g,
                    options: g.options.map((o) => ({
                      ...o,
                      disabled: o.value !== ref && p.targets.includes(o.value),
                    })),
                  }))}
                />
                <div className="row ws-row-actions">
                  <Button
                    variant="ghost"
                    data-move="up"
                    aria-label={`Move model ${i + 1} up`}
                    disabled={i === 0}
                    onClick={() => moveTarget(i, 'up')}
                  >
                    Up
                  </Button>
                  <Button
                    variant="ghost"
                    data-move="down"
                    aria-label={`Move model ${i + 1} down`}
                    disabled={i === p.targets.length - 1}
                    onClick={() => moveTarget(i, 'down')}
                  >
                    Down
                  </Button>
                  <Button
                    variant="ghost"
                    aria-label={`Remove model ${i + 1}`}
                    disabled={p.targets.length === 1}
                    onClick={() => onChange({ targets: p.targets.filter((_, j) => j !== i) })}
                  >
                    Remove
                  </Button>
                </div>
              </li>
            ))}
          </ol>
          {p.targets.length === 0 ? (
            <p className="nv-field-error">Add at least one model.</p>
          ) : null}
          <div className="row">
            <Button
              onClick={() => {
                const next = unused[0];
                if (next) onChange({ targets: [...p.targets, next.ref] });
              }}
              disabled={unused.length === 0 || p.targets.length >= MAX_TARGETS}
            >
              <Icon name="plus" /> Add model
            </Button>
            {p.strategy === 'single' && p.targets.length > 1 ? (
              <span className="muted">Only the first model is used with “One model”.</span>
            ) : null}
          </div>
        </div>
        <div className="row ws-row-actions">
          <Button data-move="up" disabled={index === 0} onClick={() => onMove('up')}>
            Move preset up
          </Button>
          <Button data-move="down" disabled={index === count - 1} onClick={() => onMove('down')}>
            Move preset down
          </Button>
          <Button variant="ghost" disabled={count === 1} onClick={onRemove}>
            <Icon name="trash" /> Remove preset
          </Button>
        </div>
      </fieldset>
    </li>
  );
}
